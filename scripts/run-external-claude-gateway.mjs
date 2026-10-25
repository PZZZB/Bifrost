import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createExternalClaudeGateway, validateExternalClients, validateExternalAuthorities } from '../src/external-claude-gateway.mjs';

let server;
async function privateFile(path, limit = 65_536) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error();
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > limit || process.platform !== 'win32' && (metadata.mode & 0o077)) throw new Error();
  return readFile(path, 'utf8');
}
try {
  const [path, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error();
  const config = JSON.parse(await privateFile(path));
  if (config.version !== 1 || config.listener?.address !== '127.0.0.1' || config.listener.port !== 43158 ||
      config.upstreamPort !== 43157 || config.publicHostname !== undefined &&
      (typeof config.publicHostname !== 'string' || !/^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net$/.test(config.publicHostname))) throw new Error();
  const gatewayKey = (await privateFile(config.gatewayKeyFile)).trim();
  const sessionKey = (await privateFile(config.sessionKeyFile)).trim();
  const getClients = async () => {
    const data = JSON.parse(await privateFile(config.clientsFile));
    if (data.version !== 1) throw new Error();
    return validateExternalClients(data.clients);
  };
  await getClients();
  const allowedHosts = ['127.0.0.1:43158', 'localhost:43158',
    ...validateExternalAuthorities(config.additionalPublicAuthorities)];
  if (config.publicHostname) allowedHosts.push(config.publicHostname, `${config.publicHostname}:443`);
  server = createExternalClaudeGateway({ gatewayKey, sessionKey, getClients, allowedHosts });
  await new Promise((yes, no) => { server.once('error', no); server.listen(43158, '127.0.0.1', yes); });
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  process.stdout.write(JSON.stringify({ event: 'ready', listener: server.address() }) + '\n');
} catch {
  server?.close(); server?.closeAllConnections();
  process.stderr.write('External Bifrost gateway could not start. Check its private configuration and loopback port.\n');
  process.exitCode = 1;
}
