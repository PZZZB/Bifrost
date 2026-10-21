import net from 'node:net';
import { isAbsolute } from 'node:path';
import { keyMatches } from './gateway.mjs';

const INVALID_REQUEST = `${JSON.stringify({ error: 'Invalid control request.' })}\n`;
const STOPPING = `${JSON.stringify({ stopping: true })}\n`;
const CONFIG_ERROR = 'Relay control configuration is invalid.';
const START_ERROR = 'Relay control could not start.';
const MAX_BYTES = 8192;
const REQUEST_TIMEOUT_MS = 2000;

function localAddress(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (process.platform === 'win32') {
    return value.startsWith('\\\\.\\pipe\\') && /^[A-Za-z0-9_.-]{1,200}$/.test(value.slice(9));
  }
  return isAbsolute(value) && !value.startsWith('//');
}

/** A local pipe/socket only. Closing never waits for onStop, which may itself call close. */
export async function startRelayControl({ key, address = process.platform === 'win32'
  ? `\\\\.\\pipe\\CodexAccountBridge-ClaudeRelay-${process.pid}` : undefined, onStop } = {}) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{40,4096}$/.test(key) ||
      !localAddress(address) || typeof onStop !== 'function') throw new TypeError(CONFIG_ERROR);

  const sockets = new Set();
  let closing, stopping = false;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    let chunks = [], size = 0, replied = false;
    const timer = setTimeout(() => {
      if (replied) socket.destroy(); else reply(INVALID_REQUEST);
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });

    function reply(value, shutdown = false) {
      if (replied || socket.destroyed) return;
      replied = true; chunks = [];
      // Finish the ACK write before closing this socket or any application listener.
      socket.end(value, error => {
        const written = !error && socket.writableFinished;
        socket.destroy();
        if (shutdown && written) stopApplication();
      });
    }

    socket.on('data', chunk => {
      if (replied) return;
      size += chunk.length;
      if (size > MAX_BYTES) { reply(INVALID_REQUEST); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      const bytes = Buffer.concat(chunks, size), newline = bytes.indexOf(10);
      if (newline !== bytes.length - 1) { reply(INVALID_REQUEST); return; }
      try {
        const command = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline)));
        if (command === null || typeof command !== 'object' || Array.isArray(command) ||
            Object.keys(command).length !== 2 || command.command !== 'shutdown' ||
            !keyMatches(command.key, key)) { reply(INVALID_REQUEST); return; }
        reply(STOPPING, true);
      } catch { reply(INVALID_REQUEST); }
    });
    socket.once('end', () => { if (!replied) reply(INVALID_REQUEST); });
  });

  function close() {
    if (!closing) {
      closing = new Promise(done => {
        server.close(() => done());
        for (const socket of sockets) socket.destroy();
      });
    }
    return closing;
  }

  function stopApplication() {
    if (stopping) return;
    stopping = true;
    // Do not await onStop from close(): the entry's onStop closes this control too.
    void close().then(onStop, onStop).catch(() => {});
  }

  try {
    await new Promise((yes, no) => {
      const failed = () => { server.off('listening', listening); no(new Error(START_ERROR)); };
      const listening = () => { server.off('error', failed); yes(); };
      server.once('error', failed); server.once('listening', listening);
      server.listen(address);
    });
  } catch {
    for (const socket of sockets) socket.destroy();
    try { server.close(); } catch { /* preserve the fixed startup error */ }
    throw new Error(START_ERROR);
  }
  server.on('error', stopApplication);
  return { address: () => address, close };
}
