import { join } from 'node:path';
import { readPrivateAccountFile } from '../private-account-files.mjs';
import { AlipayPayments } from './alipay.mjs';
import { WechatPayments } from './wechat.mjs';
import { PaymentTopups } from './topups.mjs';

export const PAYMENT_NOTIFY_PREFIX = '/account/web/v1/payments/notify/';

/** Optional, private server configuration. No desktop/company credentials here.
 * With no config, normal accounts and metering run without a payment service. */
export async function loadPaymentRuntime({ configPath, stateDir, access, billing, publicOrigin }) {
  if (!configPath) return null;
  const config = JSON.parse(await readPrivateAccountFile(configPath, 32_768));
  if (config.version !== 1 || typeof config.enabled !== 'boolean') throw new TypeError('Invalid payment configuration.');
  if (!config.enabled) return null;
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) throw new TypeError('Payment HTTPS origin required.');
  if (!config.channels || Object.keys(config.channels).some(key => !['alipay', 'wechat'].includes(key))) throw new TypeError('Invalid payment channels.');
  const providers = [];
  const pem = path => readPrivateAccountFile(path, 16_384);
  const alipay = config.channels.alipay;
  if (alipay?.enabled === true) providers.push(new AlipayPayments({ appId: alipay.appId, sellerId: alipay.sellerId,
    privateKey: await pem(alipay.privateKeyFile), alipayPublicKey: await pem(alipay.alipayPublicKeyFile),
    notifyUrl: publicOrigin + PAYMENT_NOTIFY_PREFIX + 'alipay' }));
  const wechat = config.channels.wechat;
  if (wechat?.enabled === true) {
    const publicKeys = {};
    for (const [id, path] of Object.entries(wechat.publicKeyFiles ?? {})) publicKeys[id] = await pem(path);
    providers.push(new WechatPayments({ appId: wechat.appId, mchId: wechat.mchId, subMchId: wechat.subMchId ?? null, serialNo: wechat.serialNo,
      privateKey: await pem(wechat.privateKeyFile), apiV3Key: (await readPrivateAccountFile(wechat.apiV3KeyFile, 256)).trim(),
      publicKeys, notifyUrl: publicOrigin + PAYMENT_NOTIFY_PREFIX + 'wechat' }));
  }
  if (!providers.length || !Array.isArray(config.products) || !config.products.length) throw new TypeError('Payment provider and product required.');
  const service = await PaymentTopups.open({ path: join(stateDir, 'payment-orders.json'), billing, access, providers, products: config.products });
  let running = null, stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = service.reconcile().catch(() => {}).finally(() => { running = null; });
  };
  const timer = setInterval(tick, 15_000); timer.unref(); tick();
  return { service, async close() { stopped = true; clearInterval(timer); await running; await service.close(); } };
}
