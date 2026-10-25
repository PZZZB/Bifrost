import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectMacHealth } from '../src/mac-service-health.mjs';
import { atomicPrivateFile } from '../src/encrypted-backup.mjs';
const exec = promisify(execFile);
const read = path => readFile(path, 'utf8').then(JSON.parse);
try {
  const config = await read(process.argv[2]), status = await collectMacHealth(config);
  const previous = await read(config.statusFile).catch(() => null);
  await atomicPrivateFile(config.statusFile, JSON.stringify(status, null, 2) + '\n');
  const bootId = (await exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 3000 })).stdout.trim();
  const baseline = await read(config.bootBaselineFile);
  if (baseline.bootId !== bootId) {
    const prior = await read(config.rebootAcceptanceFile).catch(() => null);
    if (prior?.bootId !== bootId || prior?.passed !== true) await atomicPrivateFile(config.rebootAcceptanceFile, JSON.stringify({
      version: 1, checkedAt: status.checkedAt, bootId, previousBootId: baseline.bootId,
      passed: status.infrastructureReady, state: status.infrastructureReady ? 'passed_after_new_boot' : 'waiting_for_services',
      components: status.components, modelReady: status.modelReady, realInference: false,
    }, null, 2) + '\n');
  }
  if (previous && JSON.stringify(previous.failed) !== JSON.stringify(status.failed)) {
    const events = await read(config.eventsFile).catch(() => []);
    events.push({ checkedAt: status.checkedAt, state: status.state, failed: status.failed });
    await atomicPrivateFile(config.eventsFile, JSON.stringify(events.slice(-100), null, 2) + '\n');
    if (config.notifications === true) {
      const text = status.failed.length ? '服务检查发现异常，请查看本机状态报告。' : '网页、隧道和隔离模型链路的基础服务已恢复。';
      await exec('/usr/bin/osascript', ['-e', `display notification "${text}" with title "Bifrost 服务状态"`], { timeout: 5000 }).catch(() => {});
    }
  }
  console.log(JSON.stringify({ checkedAt: status.checkedAt, state: status.state, failed: status.failed }));
} catch { console.error('Bifrost health check failed; inspect the private configuration.'); process.exitCode = 1; }
