import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Start-Bridge.ps1')],
  { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('error', () => { console.error('Bifrost launcher could not start.'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else {
  await import('../src/main.mjs');
}
