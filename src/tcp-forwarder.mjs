import net, { isIP } from 'node:net';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const port = value => Number.isInteger(value) && value >= 1 && value <= 65535;
const CONFIG_ERROR = 'TCP forwarder configuration is invalid.';

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonicalIp(ip) {
  if (isIP(ip) !== 6) return ip;
  const address = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!mapped) return address;
  const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function validateTcpForwarderConfig(config) {
  try {
    if (!exactKeys(config, ['version', 'listener', 'target']) || config.version !== 1 ||
        !exactKeys(config.listener, ['address', 'port']) ||
        !['127.0.0.1', '::1'].includes(config.listener.address) || !port(config.listener.port) ||
        !exactKeys(config.target, ['ip', 'port']) || typeof config.target.ip !== 'string' ||
        !isIP(config.target.ip) || config.target.ip.includes('%') || !port(config.target.port)) throw new Error();
    const target = canonicalIp(config.target.ip);
    if (['0.0.0.0', '::', '255.255.255.255'].includes(target) ||
        /^ff/i.test(target) && isIP(target) === 6 ||
        isIP(target) === 4 && Number(target.split('.')[0]) >= 224 ||
        target === config.listener.address && config.target.port === config.listener.port) throw new Error();
    return { version: 1, listener: { ...config.listener }, target: { ip: target, port: config.target.port } };
  } catch { throw new TypeError(CONFIG_ERROR); }
}

/** Forward bytes between one loopback listener and one explicit numeric-IP destination. */
export async function startTcpForwarder(configuration, { signal, connectTimeoutMs = 10_000 } = {}) {
  const config = validateTcpForwarderConfig(configuration);
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 120_000 ||
      signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError(CONFIG_ERROR);
  signal?.throwIfAborted();

  const pairs = new Set();
  let running = false, starting = true, closing = false, closeOperation, accepted = 0, failed = 0, lastError = null;
  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, client => {
    if (closing || signal?.aborted) { client.destroy(); return; }
    accepted++;
    const upstream = net.createConnection({ host: config.target.ip, port: config.target.port,
      family: isIP(config.target.ip), allowHalfOpen: true });
    let resolveClosed;
    const pair = { client, upstream, timer: null, stopped: false, clientClosed: false, upstreamClosed: false,
      closed: new Promise(resolve => { resolveClosed = resolve; }) };
    pairs.add(pair);
    function stop(failure = false) {
      if (pair.stopped) return;
      pair.stopped = true;
      if (failure && !closing) { failed++; lastError = 'TCP upstream connection failed.'; }
      clearTimeout(pair.timer);
      client.destroy(); upstream.destroy();
    }
    function onClosed(side, socket, hadError) {
      pair[side] = true;
      // A normal half-close may leave buffered bytes on the other leg. Let pipe drain those bytes.
      if (!pair.stopped && (hadError || !socket.readableEnded || !socket.writableFinished)) stop(true);
      if (pair.clientClosed && pair.upstreamClosed) {
        clearTimeout(pair.timer);
        pairs.delete(pair); resolveClosed();
      }
    }
    pair.stop = stop;
    pair.timer = setTimeout(() => stop(true), connectTimeoutMs);
    pair.timer.unref();
    client.on('error', () => stop(true));
    upstream.on('error', () => stop(true));
    client.once('close', hadError => onClosed('clientClosed', client, hadError));
    upstream.once('close', hadError => onClosed('upstreamClosed', upstream, hadError));
    upstream.once('connect', () => {
      clearTimeout(pair.timer);
      if (pair.stopped || closing || signal?.aborted) { stop(); return; }
      client.pipe(upstream); upstream.pipe(client);
      client.resume();
    });
  });

  function close() {
    if (closeOperation) return closeOperation;
    closing = true; running = false;
    signal?.removeEventListener('abort', onAbort);
    const closingPairs = [...pairs];
    closeOperation = Promise.all([
      new Promise(resolve => server.close(() => resolve())),
      ...closingPairs.map(pair => pair.closed),
    ]).then(() => {});
    for (const pair of closingPairs) pair.stop();
    return closeOperation;
  }
  const onAbort = () => { if (!starting) void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const onError = () => { cleanup(); reject(new Error('TCP loopback listener could not start.')); };
      const onListening = () => { cleanup(); resolve(); };
      const cleanup = () => { server.off('error', onError); server.off('listening', onListening); };
      server.once('error', onError); server.once('listening', onListening);
      server.listen({ host: config.listener.address, port: config.listener.port, ipv6Only: true });
    });
    starting = false;
    if (closing || signal?.aborted) {
      await close();
      signal?.throwIfAborted();
      throw new Error('TCP loopback listener stopped before startup completed.');
    }
    running = true;
    server.on('error', () => { lastError = 'TCP loopback listener failed.'; void close(); });
  } catch (error) {
    starting = false;
    await close();
    throw error;
  }
  return {
    address: () => server.address(),
    status: () => ({ running, accepted, failed, active: pairs.size, lastError }),
    close,
  };
}
