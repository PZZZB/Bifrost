import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrivateAccountFile } from './private-account-files.mjs';
import { loopbackHttpFetch } from './client-gateway-forwarder.mjs';

const exec = promisify(execFile);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function get(url, { headers = {}, loopback = false } = {}) {
  const response = await (loopback ? loopbackHttpFetch : fetch)(url, { method: 'GET', headers: new Headers(headers), signal: AbortSignal.timeout(7000), redirect: 'manual' });
  const bytes = []; let count = 0;
  if (response.body) for await (const part of response.body) { count += part.length; if (count > 131072) throw new Error(); bytes.push(part); }
  if (response.status !== 200) throw new Error();
  return Buffer.concat(bytes).toString('utf8');
}

export function classifyMacHealth(components, modelCount) {
  const failed = Object.entries(components).filter(([, value]) => value.ok !== true).map(([name]) => name);
  return { state: failed.length ? 'degraded' : modelCount > 0 ? 'healthy' : 'ready_without_model',
    infrastructureReady: failed.length === 0, modelReady: modelCount > 0, failed };
}

export async function collectMacHealth(config, { now = Date.now } = {}) {
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) throw new Error('Invalid health origin.');
  const key = (await readPrivateAccountFile(config.gatewayKeyFile)).trim();
  let modelCount = 0;
  const probes = {
    administrator: () => get('http://127.0.0.1:43155/health'),
    accountWebsite: () => get('http://127.0.0.1:43158/account/web/v1/session', { loopback: true, headers: { host: origin.host } }),
    publicWebsite: async () => { if (!(await get(config.publicOrigin + '/account/')).includes('auth-form')) throw new Error(); },
    modelRelay: async () => {
      const data = JSON.parse(await get('http://127.0.0.1:43157/v1/models', { headers: { authorization: `Bearer ${key}` } }));
      if (!Array.isArray(data.data)) throw new Error(); modelCount = data.data.length;
    },
    networkGuard: async () => {
      const stamp = await stat(config.guardReadyFile);
      if (now() - stamp.mtimeMs > 20000 || stamp.uid !== 0) throw new Error();
      const result = await exec('/usr/sbin/sysctl', ['-n', 'net.inet.ip.forwarding', 'net.inet6.ip6.forwarding'], { timeout: 3000 });
      if (result.stdout.trim() !== '0\n0') throw new Error();
    },
    dedicatedVpsExit: async () => {
      if (config.vmStatusFile) {
        const runtime = await json(config.vmStatusFile).catch(() => null);
        if (!runtime?.ok) throw Object.assign(new Error(), { code: 'vm_control_unavailable' });
      }
      const result = await exec('/usr/bin/python3', [config.guestNetworkScript, config.vmId, config.expectedExitIp,
        ...(config.vmStatusFile ? [config.vmStatusFile] : [])], { timeout: 18000, maxBuffer: 16384 });
      if (JSON.parse(result.stdout).ok !== true) throw new Error();
    },
    encryptedBackup: async () => {
      const status = await json(config.backupStatusFile);
      if (status.ok !== true || now() - Date.parse(status.createdAt) > 26 * 60 * 60 * 1000) throw new Error();
    },
  };
  const rows = await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
    const start = now();
    try { await probe(); return [name, { ok: true, durationMs: now() - start }]; }
    catch (error) { return [name, { ok: false, durationMs: now() - start,
      error: error.code === 'vm_control_unavailable' ? 'vm_control_unavailable' : 'probe_failed' }]; }
  }));
  const components = Object.fromEntries(rows);
  return { version: 1, checkedAt: new Date(now()).toISOString(), ...classifyMacHealth(components, modelCount), modelCount,
    components, realInference: false, externalBackupConfigured: false };
}
