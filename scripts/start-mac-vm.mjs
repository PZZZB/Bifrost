import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrivateAccountFile } from '../src/private-account-files.mjs';
const exec = promisify(execFile);
try {
  const config = JSON.parse(await readPrivateAccountFile(process.argv[2], 8192));
  if (!/^[0-9A-F-]{36}$/.test(config.vmId)) throw new Error();
  const binary = '/Applications/UTM.app/Contents/MacOS/utmctl';
  const status = (await exec(binary, ['status', config.vmId], { timeout: 10000 })).stdout.trim();
  if (status !== 'started') await exec(binary, ['start', '--hide', config.vmId], { timeout: 45000 });
  const after = (await exec(binary, ['status', config.vmId], { timeout: 10000 })).stdout.trim();
  if (after !== 'started') throw new Error();
  console.log(JSON.stringify({ ok: true, vmState: after, modelLoginChanged: false }));
} catch { console.error('Bifrost virtual machine could not start. Unlock and log into macOS, then inspect UTM.'); process.exitCode = 1; }
