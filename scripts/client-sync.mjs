import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { configureClientSync, loadClientSyncConfig } from '../src/runtime/client-sync-config.mjs';
import { startClientCatalogSync } from '../src/runtime/client-sync.mjs';
import { readPrivateAccountFile, writePrivateAccountRecord } from '../src/private-account-files.mjs';

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, 'state-dir': { type: 'string' }, target: { type: 'string' }, 'key-stdin': { type: 'boolean' }, id: { type: 'string' } } });
  const stateDir = resolve(values['state-dir'] || process.env.BRIDGE_STATE_DIR || join(homedir(), '.codex-account-bridge'));
  const id = values.id || 'codebuddy', command = positionals[0];
  if (command === 'enable') {
    if (!values.url || !values['key-stdin']) throw new Error();
    const parts = []; let size = 0;
    for await (const part of process.stdin) { size += part.length; if (size > 8192) throw new Error(); parts.push(part); }
    await configureClientSync({ stateDir, id, client: 'codebuddy', baseUrl: values.url,
      targetFile: resolve(values.target || join(homedir(), '.codebuddy/models.json')), apiKey: Buffer.concat(parts).toString('utf8').trim() });
    console.log('CodeBuddy 自动同步已启用；正在运行的新版 Bifrost 会自动加载，无需重启。');
  } else if (command === 'disable') {
    const config = await loadClientSyncConfig(stateDir);
    await writePrivateAccountRecord(join(stateDir, 'client-sync.json'), { ...config, profiles: config.profiles.map(p => p.id === id ? { ...p, enabled: false } : p) });
    console.log('自动同步已停用，保留现有 CodeBuddy 配置。');
  } else if (command === 'once') {
    const runtime = await startClientCatalogSync({ stateDir });
    try { await runtime.refresh({ force: true }); console.log(JSON.stringify(runtime.status())); } finally { await runtime.close(); }
  } else if (command === 'status') {
    console.log(await readPrivateAccountFile(join(stateDir, 'client-sync-status.json'), 32768));
  } else throw new Error();
} catch { console.error('客户端同步未完成。用法：enable --url HTTPS/v1 --key-stdin | disable | once | status；可指定 --state-dir 和 --target。凭据不要放入参数。'); process.exitCode = 1; }
