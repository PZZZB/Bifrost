import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { startTcpForwarder } from '../src/tcp-forwarder.mjs';

let forwarder;
try {
  const [configPath, ...extra] = process.argv.slice(2);
  if (typeof configPath !== 'string' || !isAbsolute(configPath) || /[\x00-\x1f\x7f]/.test(configPath) || extra.length) {
    throw new Error();
  }
  const handle = await open(configPath, 'r');
  let config;
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > 16_384) throw new Error();
    const bytes = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16_384) throw new Error();
    config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
  } finally { await handle.close(); }
  forwarder = await startTcpForwarder(config);
  const stop = () => { void forwarder.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.stdout.write(`${JSON.stringify({ event: 'ready', pid: process.pid, listener: forwarder.address() })}\n`);
} catch {
  await forwarder?.close();
  process.stderr.write('TCP forwarder could not start. Check the explicit configuration and loopback port.\n');
  process.exitCode = 1;
}
