import { initializeWebAccounts, WebAccountStore } from '../src/web-account-store.mjs';

try {
  const [operation, directory, username, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error();
  if (operation === 'init' && !username) {
    await initializeWebAccounts(directory); process.stdout.write('Private web account store initialized.\n');
  } else {
    const store = new WebAccountStore({ directory });
    let result;
    if (operation === 'invite' && !username) result = await store.invite();
    else if (operation === 'list' && !username) result = (await store.read()).accounts.map(item => store.publicAccount(item));
    else if (username && ['disable', 'enable', 'revoke-key', 'reset-password'].includes(operation)) result = await store.administer(username, operation);
    else throw new Error();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch {
  process.stderr.write('Web account operation failed. Usage: init/invite/list DIRECTORY | disable/enable/revoke-key/reset-password DIRECTORY EMAIL_OR_LEGACY_USERNAME. Check private permissions. Stop the external gateway and all account commands before removing a stale accounts.lock directory.\n');
  process.exitCode = 1;
}
