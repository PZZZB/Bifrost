import { BridgeError } from './storage.mjs';

/** Used only behind the existing loopback administrator session and CSRF gate. */
export class ClientAdmin {
  constructor({ access, billing = null, getModels, getEndpoint, getServerStatus = () => ({ enabled: true, ready: true }) }) {
    Object.assign(this, { access, billing, getModels, getEndpoint, getServerStatus });
  }
  async snapshot() {
    const data = this.access.snapshot();
    const billing = this.billing?.snapshot();
    return { registration: data.registrationPolicy, accounts: data.accounts.map(account => ({ ...account,
      billing: this.billing?.account(account.id) ?? null })), invites: data.invites,
      billing: billing ? { available: true, currency: billing.currency, prices: billing.prices, recent: billing.recent,
        unresolved: billing.unresolved, unresolvedNextBefore: billing.unresolvedNextBefore } : { available: false },
      models: this.getModels(), endpoint: this.getEndpoint(), server: this.getServerStatus() };
  }
  ledger() {
    if (!this.billing) throw new BridgeError('计费账本尚未就绪，请重启加载或检查账本文件。', 503, 'client_billing_unavailable');
    return this.billing;
  }
  user(id) {
    if (!this.access.publicAccount(id)) throw new BridgeError('接入用户不存在。', 404, 'client_account_not_found');
    return id;
  }
  history(id, options) { return this.ledger().history(this.user(id), options); }
  outstanding(options = {}) {
    if (options.accountId) this.user(options.accountId);
    return this.ledger().outstanding(options);
  }
  async mutate(path, body) {
    const prefix = '/api/client-admin';
    if (path === `${prefix}/billing/prices`) {
      if (!this.getModels().some(model => model.id === body?.model)) throw new BridgeError('请选择当前目录中的模型。', 400, 'client_billing_model_invalid');
      return { price: await this.ledger().setPrice(body) };
    }
    let money = /^\/api\/client-admin\/accounts\/([0-9a-f-]{36})\/(billing|balance)$/.exec(path);
    if (money) return { billing: await this.ledger()[money[2] === 'billing' ? 'configureAccount' : 'adjustBalance'](this.user(money[1]), body) };
    money = /^\/api\/client-admin\/billing\/requests\/([0-9a-f-]{36})\/resolve$/.exec(path);
    if (money) return { record: await this.ledger().resolve(money[1], body) };
    if (path === `${prefix}/registration`) return { registration: await this.access.configureRegistration(body) };
    if (path === `${prefix}/accounts`) return { account: await this.access.createAccount(body) };
    if (path === `${prefix}/invites`) return this.access.createInvite(body);
    let match = /^\/api\/client-admin\/accounts\/([0-9a-f-]{36})$/.exec(path);
    if (match) return { account: await this.access.updateAccount(match[1], body) };
    match = /^\/api\/client-admin\/accounts\/([0-9a-f-]{36})\/keys$/.exec(path);
    if (match) return this.access.createKey(match[1], body);
    match = /^\/api\/client-admin\/accounts\/([0-9a-f-]{36})\/keys\/([0-9a-f-]{36})(\/revoke)?$/.exec(path);
    if (match) {
      if (!match[3]) return { key: await this.access.updateKey(match[1], match[2], body) };
      empty(body); await this.access.revokeKey(match[1], match[2]); return { revoked: true };
    }
    match = /^\/api\/client-admin\/invites\/([0-9a-f-]{36})\/revoke$/.exec(path);
    if (match) { empty(body); await this.access.revokeInvite(match[1]); return { revoked: true }; }
    throw new BridgeError('接入用户管理接口不存在。', 404, 'client_admin_not_found');
  }
}
function empty(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BridgeError('此操作只接受空对象。');
}
