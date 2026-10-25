import { readBody } from '../gateway.mjs';
import { PAYMENT_NOTIFY_PREFIX } from './runtime.mjs';

export const paymentNotificationChannel = path => path === PAYMENT_NOTIFY_PREFIX + 'alipay' ? 'alipay'
  : path === PAYMENT_NOTIFY_PREFIX + 'wechat' ? 'wechat' : null;

/** Callback authentication uses the payment signature, never website cookies,
 * a redirect, an API key, or caller-provided account IDs. */
export function createPaymentNotifications(service) {
  let active = 0, count = 0, windowEnd = 0;
  return async function handle(req, res) {
    const channel = paymentNotificationChannel(req.url);
    let reserved = false;
    try {
      if (!channel || req.method !== 'POST' || !service || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new Error();
      if (Date.now() >= windowEnd) { windowEnd = Date.now() + 60_000; count = 0; }
      if (active >= 4 || ++count > 120) throw new Error();
      active++; reserved = true;
      const bytes = await readBody(req, 65_536);
      await service.notify(channel, bytes, req.headers);
      res.writeHead(channel === 'wechat' ? 204 : 200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(channel === 'wechat' ? undefined : 'success');
    } catch {
      if (!res.destroyed) {
        res.writeHead(503, { 'content-type': channel === 'wechat' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', connection: 'close' });
        res.end(channel === 'wechat' ? JSON.stringify({ code: 'FAIL', message: 'Payment confirmation unavailable.' }) : 'failure');
      }
    } finally { if (reserved) active--; }
  };
}
