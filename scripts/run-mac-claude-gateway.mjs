import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { startTcpForwarder } from '../src/tcp-forwarder.mjs';
import { createClaudeVmGateway } from '../src/claude-vm-gateway.mjs';

let forwarder, server, closing;
async function close() {
  return closing ??= (async () => {
    if (server) await new Promise(done => { server.close(done); server.closeAllConnections(); });
    await forwarder?.close();
  })();
}
try {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || !isAbsolute(path) || extra.length) throw new Error();
  const data = await readFile(path);
  if (data.length > 65_536) throw new Error();
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  if (config.version !== 1 || config.listener?.address !== '127.0.0.1' ||
      !Number.isInteger(config.listener.port) || config.listener.port < 1024 || config.listener.port > 65535 ||
      ![config.gatewayKeyFile, config.relayKeyFile].every(p => typeof p === 'string' && isAbsolute(p)) ||
      config.tcpForward?.listener?.address !== '127.0.0.1' || config.tcpForward.listener.port === config.listener.port ||
      config.tcpForward?.target?.ip !== '192.168.160.2' || config.tcpForward.target.port !== 3435) throw new Error();
  const key = async path => {
    const value = (await readFile(path, 'utf8')).trim();
    if (!/^[\x21-\x7e]{40,4096}$/.test(value)) throw new Error();
    return value;
  };
  const gatewayKey = await key(config.gatewayKeyFile), relayKey = await key(config.relayKeyFile);
  if (gatewayKey === relayKey) throw new Error();
  forwarder = await startTcpForwarder(config.tcpForward, { connectTimeoutMs: 5000, localAddress: '192.168.160.1' });
  server = createClaudeVmGateway({ gatewayKey, relayKey, upstreamPort: config.tcpForward.listener.port,
    allowedHosts: [`127.0.0.1:${config.listener.port}`, `localhost:${config.listener.port}`] });
  await new Promise((yes, no) => { server.once('error', no); server.listen(config.listener.port, config.listener.address, yes); });
  server.on('error', () => { process.exitCode = 1; void close(); });
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  process.stdout.write(JSON.stringify({ event: 'ready', listener: server.address(), realInference: false }) + '\n');
} catch {
  await close().catch(() => {});
  process.stderr.write('The local Bifrost VM gateway could not start. Check its private configuration and listening ports.\n');
  process.exitCode = 1;
}
