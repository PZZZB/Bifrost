import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLocalApps, discoverLocalApps } from '../src/clients/local-apps.mjs';

const inventory = [
  { id: 'codex', installed: true, appId: 'OpenAI.Codex_2p2nqsd0c76g0!App' },
  { id: 'codebuddy', installed: true, executable: 'D:\\CodeBuddy CN\\CodeBuddy CN.exe' },
  { id: 'workbuddy', installed: true, executable: 'D:\\WorkBuddy\\WorkBuddy.exe' },
  { id: 'cursor', installed: true, executable: 'D:\\cursor\\Cursor.exe' },
];
function launcher(calls, failure) { return (binary, args, options) => {
  calls.push({ binary, args, options }); const child = new EventEmitter(); child.unref = () => { child.unreferenced = true; };
  queueMicrotask(() => child.emit(failure ? 'error' : 'spawn', failure)); return child;
}; }

test('desktop inventory is read only and missing host Claude does not imply a VM launch target', async () => {
  const calls = [], apps = createLocalApps({ platform: 'win32', discoverImpl: async () => inventory, spawnImpl: launcher(calls) });
  const data = await apps.snapshot(); assert.equal(data.length, 5); assert.equal(calls.length, 0);
  assert.equal(data.find(row => row.id === 'claude').launchSupported, false);
  assert.equal(data.find(row => row.id === 'codex').launchSupported, true);
  assert.doesNotMatch(JSON.stringify(data), /executable|target|apiKey/);
  await assert.rejects(apps.launch('claude'), e => e.code === 'client_launch_unavailable'); assert.equal(calls.length, 0);
});

test('explicit executable launches use argument arrays without a shell or forced process shutdown', async () => {
  const calls = [], apps = createLocalApps({ platform: 'win32', discoverImpl: async () => inventory, spawnImpl: launcher(calls) });
  const result = await apps.launch('codebuddy'); assert.equal(result.launched, true); assert.equal(result.configurationChanged, false);
  assert.equal(calls[0].binary, 'D:\\CodeBuddy CN\\CodeBuddy CN.exe'); assert.deepEqual(calls[0].args, []);
  assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
});

test('Codex launch uses the pinned official AppX activation ID rather than launching a CLI binary', async () => {
  const calls = [], apps = createLocalApps({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    discoverImpl: async () => inventory, spawnImpl: launcher(calls) });
  await apps.launch('codex'); assert.equal(calls[0].binary, 'C:\\Windows\\explorer.exe');
  assert.equal(calls[0].args[0].split(String.fromCharCode(92)).length, 2);
  assert.equal(calls[0].args[0].replaceAll(String.fromCharCode(92), '/'), 'shell:AppsFolder/OpenAI.Codex_2p2nqsd0c76g0!App');
});

test('unrecognized IDs, mismatched executables, unexpected AppX IDs and unsupported platforms cannot launch', async () => {
  const calls = [], apps = createLocalApps({ platform: 'win32', discoverImpl: async () => [
    { id: 'codebuddy', installed: true, executable: 'C:\\Windows\\System32\\cmd.exe' },
    { id: 'codex', installed: true, appId: 'OtherApp!App' },
  ], spawnImpl: launcher(calls) });
  for (const id of ['codebuddy', 'codex']) await assert.rejects(apps.launch(id), e => e.code === 'client_launch_unavailable');
  await assert.rejects(apps.launch('powershell'), e => e.code === 'client_not_found');
  const linux = createLocalApps({ platform: 'linux', discoverImpl: async () => inventory, spawnImpl: launcher(calls) });
  await assert.rejects(linux.launch('codex'), e => e.code === 'client_launch_unavailable'); assert.equal(calls.length, 0);
});

test('discovery reads official package and uninstall metadata, accepts only matching executable files', async () => {
  const commands = [];
  const rows = await discoverLocalApps({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    execFileImpl(binary, args, options, callback) {
      commands.push({ binary, args, options }); callback(null, JSON.stringify({ codexInstalled: true, records: [
        { DisplayName: 'WorkBuddy 5.8.2', DisplayIcon: 'D:\\WorkBuddy\\WorkBuddy.exe,0' },
        { DisplayName: 'CodeBuddy CN (User)', InstallLocation: 'D:\\CodeBuddy CN\\' },
      ] }));
    }, lstatImpl: async path => ({ isFile: () => path === 'D:\\WorkBuddy\\WorkBuddy.exe' || path === 'D:\\CodeBuddy CN\\CodeBuddy CN.exe', isSymbolicLink: () => false }),
  });
  assert.equal(rows.find(row => row.id === 'workbuddy').installed, true); assert.equal(rows.find(row => row.id === 'cursor').installed, false);
  assert.equal(rows.find(row => row.id === 'codex').appId, 'OpenAI.Codex_2p2nqsd0c76g0!App');
  assert.equal(commands[0].options.windowsHide, true); assert.equal(commands[0].options.timeout, 10000);
  const script = Buffer.from(commands[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Get-AppxPackage/); assert.doesNotMatch(script, /Start-Process|Stop-Process|Get-Content|ReadAllText/);
});

test('launch failures return a fixed error without leaking injected native error details', async () => {
  const apps = createLocalApps({ platform: 'win32', discoverImpl: async () => inventory,
    spawnImpl: launcher([], new Error('PRIVATE-FIXTURE-DETAIL')) });
  await assert.rejects(apps.launch('workbuddy'), e => e.code === 'client_launch_failed' && !e.message.includes('PRIVATE'));
});

test('status reads share a short inventory cache while explicit launch always rechecks the actual installation', async () => {
  let reads = 0, clock = 0, current = inventory; const calls = [];
  const apps = createLocalApps({ platform: 'win32', now: () => clock, cacheMs: 30000,
    discoverImpl: async () => { reads++; return current; }, spawnImpl: launcher(calls) });
  await Promise.all([apps.snapshot(), apps.snapshot()]); await apps.snapshot(); assert.equal(reads, 1);
  current = [];
  await assert.rejects(apps.launch('workbuddy'), error => error.code === 'client_launch_unavailable');
  assert.equal(reads, 2); assert.equal(calls.length, 0);
  clock = 30001; await apps.snapshot(); assert.equal(reads, 3);
});
