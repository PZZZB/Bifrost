import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Verify this exact process belongs to its own KeepAlive LaunchAgent. */
export async function readLaunchdOwner({ label, projectDir, stateDir, processId = process.pid, parentProcessId = process.ppid,
  uid = process.getuid?.(), home = homedir(), binary = process.execPath, exec = promisify(execFile), inspect = stat }) {
  if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,119}$/.test(label) || parentProcessId !== 1 || !Number.isSafeInteger(uid)) return null;
  try {
    const path = join(home, 'Library', 'LaunchAgents', label + '.plist'), file = await inspect(path);
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o022) !== 0) return null;
    const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { timeout: 3000, maxBuffer: 65536 });
    const config = JSON.parse(stdout), environment = config.EnvironmentVariables;
    if (config.Label !== label || config.KeepAlive !== true || config.WorkingDirectory !== projectDir
      || !Array.isArray(config.ProgramArguments) || config.ProgramArguments.length !== 2 || config.ProgramArguments[0] !== binary
      || config.ProgramArguments[1] !== join(projectDir, 'src', 'main.mjs') || environment?.BRIDGE_STATE_DIR !== stateDir
      || environment.BRIDGE_LAUNCHD_LABEL !== label) return null;
    const result = await exec('/bin/launchctl', ['print', `gui/${uid}/${label}`], { timeout: 3000, maxBuffer: 65536 });
    const matches = [...result.stdout.matchAll(/^\s*pid = (\d+)\s*$/gm)];
    if (matches.length !== 1 || Number(matches[0][1]) !== processId) return null;
    return { OwnerId: createHash('sha256').update(JSON.stringify([label, uid, processId, projectDir, stateDir])).digest('hex').toUpperCase() };
  } catch { return null; }
}
