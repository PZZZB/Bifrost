import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const absent = error => ['ENODATA', 'ENOTFOUND'].includes(error?.code);
const domain = value => value.length <= 253 && value.includes('.') && !/^\d+$/.test(value.split('.').at(-1)) &&
  value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));

// Account identifiers support ordinary ASCII dot-atom addresses. Comparison is
// case insensitive by product policy; dots and +suffixes are never removed.
export function webEmail(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail(400, 'invalid_email');
  const email = value.trim().toLowerCase(), parts = email.split('@');
  if (email.length > 254 || parts.length !== 2 || parts[0].length > 64 || !domain(parts[1]) ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0])) fail(400, 'invalid_email');
  return email;
}

// DNS only: never connects to an MX host, probes a mailbox, or sends mail.
// Even success says nothing about a particular mailbox or its ownership.
export function createEmailDomainChecker({ createResolver = () => new Resolver({ timeout: 1500, tries: 1 }), timeoutMs = 4500 } = {}) {
  if (typeof createResolver !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new TypeError('Invalid email DNS settings.');
  return async email => {
    const name = webEmail(email).split('@')[1], resolver = createResolver();
    let timer;
    const lookup = async () => {
      let records;
      try { records = await resolver.resolveMx(name); }
      catch (error) { if (!absent(error)) fail(503, 'email_domain_unavailable'); if (error.code === 'ENOTFOUND') fail(400, 'invalid_email_domain'); records = []; }
      if (records.some(record => record.exchange === '' || record.exchange === '.')) fail(400, 'invalid_email_domain');
      if (records.length) {
        if (!records.every(record => Number.isInteger(record.priority) && record.priority >= 0 && record.priority <= 65535 &&
            typeof record.exchange === 'string' && domain(record.exchange.toLowerCase().replace(/\.$/, '')))) fail(503, 'email_domain_unavailable');
        return 'mx';
      }
      // RFC 5321 implicit MX: lack of an MX record alone is not a rejection.
      const results = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)]);
      if (results.some((result, index) => result.status === 'fulfilled' && result.value.some(address => isIP(address) === (index ? 6 : 4)))) return 'address';
      if (results.some(result => result.status === 'rejected' && !absent(result.reason))) fail(503, 'email_domain_unavailable');
      fail(400, 'invalid_email_domain');
    };
    try {
      return await Promise.race([lookup(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('email_domain_unavailable'), { status: 503, code: 'email_domain_unavailable' })), timeoutMs);
      })]);
    } finally { clearTimeout(timer); resolver.cancel(); }
  };
}

export const checkEmailDomain = createEmailDomainChecker();
