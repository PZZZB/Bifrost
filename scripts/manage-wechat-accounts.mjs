import { initializeWeChatAccounts } from '../src/wechat-account-store.mjs';
import { loadWeChatAccountStore } from '../src/wechat-accounts.mjs';

try {
  const [operation, directory, appId, id, ...extra] = process.argv.slice(2);
  if (extra.length || !directory) throw new Error();
  if (operation === 'init') {
    if (appId || id) throw new Error();
    await initializeWeChatAccounts(directory);
    process.stdout.write('Private WeChat account store initialized.\n');
  } else {
    if (!appId || !['invite', 'list', 'disable', 'enable', 'revoke-key'].includes(operation)) throw new Error();
    const store = await loadWeChatAccountStore(directory, { appId });
    let result;
    if (operation === 'list' && !id) result = (await store.read()).accounts.map(account => store.publicAccount(account));
    else if (operation === 'invite' && !id) result = await store.invite();
    else if (id && ['disable', 'enable', 'revoke-key'].includes(operation)) result = await store.administer(id, operation);
    else throw new Error();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch {
  process.stderr.write('Account operation failed. Usage: init DIRECTORY | invite/list DIRECTORY APP_ID | disable/enable/revoke-key DIRECTORY APP_ID ACCOUNT_ID. Check private permissions; if accounts.lock remains after a crash, stop the gateway before removing that lock directory.\n');
  process.exitCode = 1;
}
