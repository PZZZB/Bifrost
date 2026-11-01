import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readPrivateAccountFile } from '../src/private-account-files.mjs';
import { loadMagpieDelegation } from '../src/magpie-delegation.mjs';
import { configureServerRemote } from '../src/runtime/server-remotes-config.mjs';
import { BifrostRemote } from '../src/providers/bifrost-remote.mjs';

async function run() {
  const { values } = parseArgs({ options: { url: { type: 'string' }, source: { type: 'string' },
    'key-stdin': { type: 'boolean' }, 'state-dir': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('向已有 Server 网关添加远端来源：node scripts/server-remote.mjs --url HTTPS/v1 --key-stdin\n用户 Key 仅从标准输入读取；保存在 Windows 当前用户 DPAPI 中。现有 Codex 地址和公司登录保持原样。'); return;
  }
  if (process.platform !== 'win32') throw new Error('此配置工具仅用于 Windows 当前用户 DPAPI，不能降级保存明文 Key。');
  if (!values.url || !values['key-stdin']) throw new Error('需要 --url HTTPS/v1 和 --key-stdin。');
  const stateDir = resolve(values['state-dir'] || process.env.BRIDGE_STATE_DIR || join(homedir(), '.codex-account-bridge'));
  const state = JSON.parse(await readPrivateAccountFile(join(stateDir, 'bridge.json')));
  if (typeof state.gatewayKey !== 'string' || state.gatewayKey.length < 40) throw new Error('找不到已有网关，请先通过原有 Start-Bridge.ps1 启动。');
  if (await loadMagpieDelegation(join(stateDir, 'magpie-delegation.json'))) throw new Error('当前网关已委托其他服务；不能把来源写入未使用的 Server。');
  const chunks = []; let size = 0;
  for await (const bytes of process.stdin) {
    size += bytes.length; if (size > 512) throw new Error('用户 Key 格式无效。'); chunks.push(bytes);
  }
  const apiKey = Buffer.concat(chunks).toString('utf8').trim();
  const id = values.source ?? 'bifrost';
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('来源编号无效。');
  const provider = new BifrostRemote({ id, baseUrl: values.url, apiKey, stateSecret: state.gatewayKey });
  let modelCount;
  try { await provider.refreshCatalog(); modelCount = provider.catalogSnapshot().length; }
  finally { await provider.close(); }
  if (!modelCount) throw new Error('未取得可用远端模型，请核对 API 地址、用户 Key 和模型权限；原配置未变。');
  const result = await configureServerRemote({ stateDir, id, baseUrl: values.url, apiKey });
  console.log(`已保存 ${result.sourceId} 来源（${modelCount} 个模型）。请用原 Start-Bridge.ps1 -Restart 重启，Codex 沿用原有本地地址。`);
}
run().catch(() => { console.error('远端来源配置未完成。请确认当前 Windows 用户、已有 Server 网关、HTTPS /v1 地址和用户 Key；检查是否另一个配置进程正在运行。Key 不会输出或明文保存。'); process.exitCode = 1; });
