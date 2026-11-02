import assert from 'node:assert/strict';
import test from 'node:test';
import { win32 } from 'node:path';
import { readWindowsServiceOwner } from '../src/windows-service-owner.mjs';

function fixture() {
  const projectDir = 'D:\\Tools\\Bifröst project', stateDir = 'C:\\Users\\Test User\\.bridge';
  const processId = 2345, parentProcessId = 2344, calls = [];
  const config = { Product: 'AgentBridge.Service', Version: 1, OwnerId: 'A'.repeat(64),
    ProjectDirectory: projectDir, StateDirectory: stateDir, CodexHome: 'C:\\Users\\Test User\\.codex',
    PowerShellBinary: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', TaskName: 'Fixture-Bifrost' };
  const identity = { Product: 'AgentBridge.Service.Process', OwnerId: config.OwnerId, RestartProtocol: 1,
    NodePid: processId, RunnerPid: parentProcessId, EntryScript: win32.join(projectDir, 'src', 'main.mjs') };
  const status = { Product: 'AgentBridge.Service', TaskName: config.TaskName, Installed: true,
    TaskRunning: true, NodeRunning: true, RunnerRunning: true, Ready: true, IndependentOfCodex: true, NodePid: processId };
  const fixture = { calls, config, identity, status, stdout: null, error: null };
  fixture.options = { projectDir, stateDir, config, identity, processId, parentProcessId,
    execFileImpl(binary, args, options, callback) {
      calls.push({ binary, args, options });
      queueMicrotask(() => callback(fixture.error, fixture.stdout ?? JSON.stringify(status), 'private stderr canary'));
    } };
  return fixture;
}

test('live Windows owner uses only the existing read-only controller with bounded hidden execution', async () => {
  const f = fixture();
  assert.deepEqual(await readWindowsServiceOwner(f.options), {
    OwnerId: f.config.OwnerId, NodePid: f.options.processId, RunnerPid: f.options.parentProcessId,
  });
  assert.deepEqual(f.calls, [{ binary: f.config.PowerShellBinary,
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', win32.join(f.options.projectDir, 'scripts', 'AgentBridgeService.ps1'), '-Action', 'Status',
      '-ProjectDirectory', f.options.projectDir, '-StateDirectory', f.options.stateDir,
      '-CodexHome', f.config.CodexHome, '-TaskName', f.config.TaskName, '-AsJson'],
    options: { windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024, encoding: 'utf8' } }]);
});

test('a matching process record cannot authorize a missing supervisor or stopped task', async () => {
  for (const field of ['Installed', 'TaskRunning', 'NodeRunning', 'RunnerRunning', 'Ready', 'IndependentOfCodex']) {
    for (const value of [false, undefined, 'true', 1]) {
      const f = fixture(); f.status[field] = value;
      assert.equal(await readWindowsServiceOwner(f.options), null, `${field}=${String(value)}`);
    }
  }
});

test('foreign processes and task identities in live results cannot authorize a restart', async () => {
  for (const patch of [{ Product: 'OtherProduct' }, { TaskName: 'OtherTask' }, { NodePid: 9999 }, { NodePid: '2345' }]) {
    const f = fixture(); Object.assign(f.status, patch);
    assert.equal(await readWindowsServiceOwner(f.options), null);
  }
});

test('stale or malformed local identity is rejected before invoking PowerShell', async () => {
  for (const patch of [{ Product: 'OtherProduct' }, { OwnerId: 'B'.repeat(64) }, { RestartProtocol: 0 },
    { NodePid: 9999 }, { RunnerPid: 9998 }, { EntryScript: 'D:\\Other\\src\\main.mjs' }]) {
    const f = fixture(); Object.assign(f.identity, patch);
    assert.equal(await readWindowsServiceOwner(f.options), null);
    assert.equal(f.calls.length, 0);
  }
});

test('invalid configuration cannot select a different project, shell, or command', async () => {
  for (const patch of [{ Product: 'OtherProduct' }, { Version: 2 }, { OwnerId: 'invalid' },
    { ProjectDirectory: 'D:\\Other' }, { StateDirectory: 'C:\\Other' }, { CodexHome: 'relative-home' },
    { PowerShellBinary: 'powershell.exe' }, { PowerShellBinary: 'C:\\Windows\\System32\\cmd.exe' },
    { PowerShellBinary: '\\\\server\\share\\powershell.exe' }, { TaskName: 'Fixture; Restart' }]) {
    const f = fixture(); Object.assign(f.config, patch);
    assert.equal(await readWindowsServiceOwner(f.options), null);
    assert.equal(f.calls.length, 0);
  }
});

test('relative, rooted-without-drive, network, control-character and alternate-stream paths are rejected', async () => {
  for (const value of ['relative', '\\rooted', '\\\\server\\share', 'D:\\', 'D:\\Tools:alternate', 'D:\\Tools\nunsafe']) {
    for (const field of ['projectDir', 'stateDir']) {
      const f = fixture();
      assert.equal(await readWindowsServiceOwner({ ...f.options, [field]: value }), null);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('invalid process IDs cannot reach the Windows controller', async () => {
  for (const value of [0, -1, NaN, 1.5, '2345', 0x80000000]) {
    for (const field of ['processId', 'parentProcessId']) {
      const f = fixture();
      assert.equal(await readWindowsServiceOwner({ ...f.options, [field]: value }), null);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('the system PowerShell path is absolute when a recorded shell path is unavailable', async () => {
  const f = fixture(); delete f.config.PowerShellBinary;
  assert.ok(await readWindowsServiceOwner({ ...f.options, systemRoot: 'D:\\Windows' }));
  assert.equal(f.calls[0].binary, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('unavailable, timed-out and malformed controller results fail closed', async () => {
  for (const error of [Object.assign(new Error('timeout'), { killed: true, code: 'ETIMEDOUT' }),
    Object.assign(new Error('missing executable'), { code: 'ENOENT' }), new Error('access denied')]) {
    const f = fixture(); f.error = error;
    assert.equal(await readWindowsServiceOwner(f.options), null);
  }
  for (const stdout of ['not JSON', '{}', 'null', JSON.stringify({ Product: 'AgentBridge.Service' }), ' '.repeat(32 * 1024 + 1)]) {
    const f = fixture(); f.stdout = stdout;
    assert.equal(await readWindowsServiceOwner(f.options), null);
  }
});

test('live supervisor status is checked again on every call without a cached success', async () => {
  const f = fixture();
  assert.ok(await readWindowsServiceOwner(f.options));
  f.status.RunnerRunning = false;
  assert.equal(await readWindowsServiceOwner(f.options), null);
  assert.equal(f.calls.length, 2);
});
