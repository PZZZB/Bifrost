import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { redact } from '../src/storage.mjs';
import { resolveBModel } from '../src/models.mjs';

// Uses the current Codex's native auth and tools, with transient provider overrides.
// The B bearer remains inside the gateway, never in this client process.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = `http://127.0.0.1:${process.env.BRIDGE_PORT || 43155}`;
const useInstalledConfig = process.argv.includes('--installed');
const modelIndex = process.argv.indexOf('--model');
const selectedModel = modelIndex === -1 ? 'B-gpt-6.1-sol' : process.argv[modelIndex + 1];
if (!selectedModel || selectedModel.startsWith('--')) throw new Error('--model requires a model name.');
const account = resolveBModel(selectedModel) ? 'B' : 'A';
try {
  const page = await fetch(`${origin}/`);
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  const headers = { cookie };
  const status = await (await fetch(`${origin}/api/status`, { headers })).json();
  if (!status.backend?.pinnedAccount || status.verification?.status !== 'passed') {
    throw new Error('请先在管理页登录并确认 B，完成“验证推理”。');
  }
  if (useInstalledConfig && (!status.integration?.installed || status.integration?.needsUpgrade)) throw new Error('请先更新本机 Codex 接入配置，再验证已保存配置。');
  const providerId = status.integration?.providerId;
  if (!/^[A-Za-z0-9_-]+$/.test(providerId ?? '')) throw new Error('无法确定当前 Codex Provider。');
  const integration = await (await fetch(`${origin}/api/integration`, { headers })).json();
  const work = join(root, '.state', `client-proof-${Date.now()}-${randomBytes(3).toString('hex')}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const expected = `${account}-bridge-local-tools-${randomBytes(12).toString('hex')}`;
  await writeFile(join(work, 'bridge-proof.txt'), `${expected}\n`, { mode: 0o600 });
  const providerOverrides = useInstalledConfig ? [] : [
    '-c', `model_providers.${providerId}.base_url=${JSON.stringify(integration.baseUrl)}`,
    '-c', `model_providers.${providerId}.supports_websockets=false`,
    '-c', `model_providers.${providerId}.model_catalog_url=${JSON.stringify(`${integration.baseUrl}/models`)}`,
    '-c', `model_providers.${providerId}.env_http_headers={"X-Account-Bridge-Key"="CODEX_BRIDGE_GATEWAY_KEY"}`];
  const args = ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '-C', work, '--model', selectedModel,
    ...providerOverrides,
    '-c', 'model_reasoning_effort="low"',
    'Read bridge-proof.txt using a shell tool, then reply with exactly its contents. Do not read or modify any other file.'];
  const child = spawn(process.env.CODEX_BINARY || 'codex', args, {
    cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_BRIDGE_GATEWAY_KEY: integration.gatewayKey },
  });
  const timer = setTimeout(() => child.kill(), 180_000);
  const texts = []; let tools = 0, completed = false, lastError = null, threadId = null;
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'thread.started') threadId = event.thread_id;
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'error') lastError = redact(event.message);
    if (event.type === 'item.completed') {
      const item = event.item ?? {};
      if (['agent_message', 'agentMessage'].includes(item.type) && typeof item.text === 'string') texts.push(item.text);
      if (['command_execution', 'commandExecution', 'mcp_tool_call', 'mcpToolCall', 'dynamic_tool_call'].includes(item.type)) tools++;
    }
  });
  child.stderr.resume();
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject); child.once('exit', resolveExit);
  }).finally(() => clearTimeout(timer));
  const reply = texts.at(-1)?.trim();
  const after = await (await fetch(`${origin}/api/status`, { headers })).json();
  const gatewayRequests = after.gateway.accounts[account].requests - status.gateway.accounts[account].requests;
  const gatewayCompleted = after.gateway.accounts[account].completed - status.gateway.accounts[account].completed;
  const otherAccount = account === 'A' ? 'B' : 'A';
  const otherAccountRequests = after.gateway.accounts[otherAccount].requests - status.gateway.accounts[otherAccount].requests;
  const { traffic } = threadId ? await (await fetch(`${origin}/api/traffic?threadId=${encodeURIComponent(threadId)}`, { headers })).json() : {};
  const threadRequests = traffic?.accounts?.[account]?.requests ?? 0;
  const threadCompleted = traffic?.accounts?.[account]?.completed ?? 0;
  const otherThreadRequests = traffic?.accounts?.[otherAccount]?.requests ?? 0;
  const sameAccount = after.backend?.pinnedAccount?.email === status.backend.pinnedAccount.email &&
    after.verification?.accountId === status.verification.accountId && after.verification?.status === 'passed';
  const result = { passed: code === 0 && completed && tools > 0 && reply === expected &&
      threadRequests > 0 && threadCompleted > 0 && otherThreadRequests === 0 && sameAccount,
    configuration: useInstalledConfig ? 'installed' : 'transient', model: selectedModel, routingAccount: account,
    gatewayRequests, gatewayCompleted, otherAccountRequests,
    threadId, threadRequests, threadCompleted, otherThreadRequests,
    completed, localToolCalls: tools, reply: reply ?? null,
    checkedAt: new Date().toISOString() };
  await writeFile(join(work, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...result, evidencePath: join(work, 'result.json') }, null, 2));
  if (!result.passed) throw new Error(lastError ?? '当前 Codex 客户端的完整工具往返验证未通过。');
} catch (error) {
  console.error(redact(error.message)); process.exitCode = 1;
}
