import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

const MAX_OUTPUT = 32 * 1024;

function localPath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.trim() !== value
    || /[\x00-\x1f\x7f"<>|?*]/.test(value) || value.slice(2).includes(':')) return null;
  const absolute = win32.normalize(value).replace(/[\\/]+$/, '');
  return absolute.length > 2 ? absolute : null;
}

const samePath = (left, right) => left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;

/** Check the live Windows supervisor through the existing read-only controller. */
export async function readWindowsServiceOwner({ projectDir, stateDir, config, identity,
  processId = process.pid, parentProcessId = process.ppid, execFileImpl = execFile,
  systemRoot = process.env.SystemRoot || process.env.WINDIR } = {}) {
  const project = localPath(projectDir), state = localPath(stateDir);
  const home = localPath(config?.CodexHome);
  const powershell = localPath(config?.PowerShellBinary
    || (typeof systemRoot === 'string' ? win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null));
  if (!project || !state || !home || !powershell || !validPid(processId) || !validPid(parentProcessId)
    || !/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(powershell)
    || config?.Product !== 'AgentBridge.Service' || config.Version !== 1
    || !/^[A-F0-9]{64}$/.test(config.OwnerId ?? '')
    || !samePath(localPath(config.ProjectDirectory), project) || !samePath(localPath(config.StateDirectory), state)
    || typeof config.TaskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(config.TaskName)
    || identity?.Product !== 'AgentBridge.Service.Process' || identity.OwnerId !== config.OwnerId
    || identity.RestartProtocol !== 1 || identity.NodePid !== processId || identity.RunnerPid !== parentProcessId
    || !samePath(localPath(identity.EntryScript), win32.join(project, 'src', 'main.mjs'))) return null;
  const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', win32.join(project, 'scripts', 'AgentBridgeService.ps1'), '-Action', 'Status',
    '-ProjectDirectory', project, '-StateDirectory', state, '-CodexHome', home, '-TaskName', config.TaskName, '-AsJson'];
  try {
    const output = await new Promise((resolve, reject) => {
      execFileImpl(powershell, args, { windowsHide: true, timeout: 10_000, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_OUTPUT) return null;
    const status = JSON.parse(output.trim());
    if (status?.Product !== 'AgentBridge.Service' || status.TaskName !== config.TaskName || status.NodePid !== processId
      || !['Installed', 'TaskRunning', 'NodeRunning', 'RunnerRunning', 'Ready', 'IndependentOfCodex']
        .every(key => status[key] === true)) return null;
    return { OwnerId: config.OwnerId, NodePid: processId, RunnerPid: parentProcessId };
  } catch { return null; }
}
