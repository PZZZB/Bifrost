import { webEmail, checkEmailDomain as defaultCheck } from './email-address.mjs';
import { WEB_PRIVACY_VERSION, webUsername } from './web-account-store.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const password = value => {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || Buffer.byteLength(value) > 256 || value.includes('\0')) fail(400, 'invalid_password');
  return value;
};
function translate(error) {
  const codes = { client_invite_invalid: 'registration_rejected', client_username_exists: 'registration_rejected',
    client_registration_closed: 'registration_full', client_account_limit: 'registration_full', client_login_failed: 'login_rejected' };
  if (codes[error.code]) fail(error.status, codes[error.code]);
  throw error;
}

/** Compatibility view, never a second database or credential owner. */
export class UnifiedWebAccounts {
  constructor({ access, billing, maxAccounts = 50, maxConcurrent = 1, requestsPerMinute = 20,
    clock = Date.now, checkEmailDomain = defaultCheck }) {
    Object.assign(this, { access, billing, maxAccounts, maxConcurrent, requestsPerMinute, clock, checkEmailDomain });
  }
  publicAccount(account) {
    return { id: account.id, username: account.username, email: account.username.includes('@') ? account.username : null,
      emailVerified: false, ...(account.registration ? { emailDomainCheck: { ...account.registration.emailDomainCheck,
        checkedAt: Date.parse(account.registration.emailDomainCheck.checkedAt) } } : {}),
      status: account.enabled ? 'active' : 'disabled', createdAt: Date.parse(account.createdAt),
      apiKeyConfigured: account.keys.some(key => key.status === 'active'),
      limits: { maxConcurrent: this.maxConcurrent, requestsPerMinute: this.requestsPerMinute } };
  }
  async register({ email, password: value, inviteCode, privacyAccepted }) {
    const username = webEmail(email); password(value);
    if (privacyAccepted !== true) fail(400, 'privacy_required');
    const method = await this.checkEmailDomain(username);
    if (!['mx', 'address'].includes(method)) fail(503, 'email_domain_unavailable');
    const checkedAt = new Date(this.clock()).toISOString();
    try {
      const result = await this.access.register({ username, password: value, inviteToken: inviteCode }, {
        registration: { privacyVersion: WEB_PRIVACY_VERSION, acceptedAt: checkedAt, emailVerified: false, emailDomainCheck: { method, checkedAt } } });
      return { account: this.publicAccount(result.account), apiKey: result.secret, sessionToken: result.sessionToken, expiresAt: Date.parse(result.expiresAt) };
    } catch (error) { translate(error); }
  }
  async login({ username, password: value }) {
    username = webUsername(username); password(value);
    try {
      const result = await this.access.login({ username, password: value });
      return { account: this.publicAccount(result.account), sessionToken: result.sessionToken, expiresAt: Date.parse(result.expiresAt) };
    } catch (error) { translate(error); }
  }
  async me(token) {
    const principal = this.access.authenticateSession(token);
    if (!principal) fail(401, 'session_expired');
    return { account: this.publicAccount(this.access.publicAccount(principal.accountId)),
      ...(this.billing ? { billing: this.billing.account(principal.accountId) } : {}) };
  }
  async change(token, operation) {
    if (!this.access.authenticateSession(token)) fail(401, 'session_expired');
    if (operation === 'logout') { await this.access.logout(token); return { ok: true }; }
    const result = await this.access.changeSession(token, operation);
    return { ...(result.ok ? { ok: true } : {}), ...(result.account ? { account: this.publicAccount(result.account) } : {}),
      ...(result.secret ? { apiKey: result.secret } : {}) };
  }
}
