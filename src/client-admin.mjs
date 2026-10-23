import { BridgeError } from './storage.mjs';

/** Used only behind the existing loopback administrator session and CSRF gate. */
export class ClientAdmin {
  constructor({ access, getModels, getEndpoint, getServerStatus = () => ({ enabled: true, ready: true }) }) {
    Object.assign(this, { access, getModels, getEndpoint, getServerStatus });
  }
  async snapshot() {
    const data = this.access.snapshot();
    return { registration: data.registrationPolicy, accounts: data.accounts, invites: data.invites,
      models: this.getModels(), endpoint: this.getEndpoint(), server: this.getServerStatus() };
  }
  async mutate(path, body) {
    const prefix = '/api/client-admin';
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
