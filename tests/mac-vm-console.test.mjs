import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/mac-vm-console.py', import.meta.url));
// A real shell at the opposite end of a PTY exercises framing and exit status,
// rather than asserting how the Python helper constructs its input string.
const fixture = String.raw`
import fcntl,json,os,pty,signal,subprocess,sys,termios,tty
master,slave=pty.openpty()
tty.setraw(slave)
initial=termios.tcgetattr(slave)
initial[0]|=termios.IXON
termios.tcsetattr(slave,termios.TCSANOW,initial)
bridge="""
import os,select,subprocess,sys
fd=int(sys.argv[1]);data=bytearray()
while True:
    ready,_,_=select.select([fd],[],[],0.1 if data else 5)
    if not ready:break
    data.extend(os.read(fd,65536))
result=subprocess.run(['/bin/bash','--noprofile','--norc'],input=data,capture_output=True)
pending=result.stdout
while pending:
    pending=pending[os.write(fd,pending):]
"""
guest=None
try:
    device=os.ttyname(slave)
    if sys.argv[3]=='busy':
        fcntl.flock(slave,fcntl.LOCK_EX|fcntl.LOCK_NB)
    else:
        guest=subprocess.Popen([sys.executable,'-c',bridge,str(master)],
            pass_fds=(master,),start_new_session=True)
    before=termios.tcgetattr(slave)
    result=subprocess.run([sys.executable,sys.argv[1],device,'--command',sys.argv[2],
        '--timeout','0.25' if sys.argv[3]=='timeout' else '5'],capture_output=True,text=True,timeout=8)
    print(json.dumps({'code':result.returncode,'stdout':result.stdout,'stderr':result.stderr,
        'ttyRestored':termios.tcgetattr(slave)==before}))
finally:
    if guest:
        if guest.poll() is None:
            try:os.killpg(guest.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        guest.wait(timeout=3)
    os.close(master)
    os.close(slave)
`;
const unix = { skip: process.platform === 'win32' };
async function run(command, mode = 'normal') {
  const { stdout } = await exec('python3', ['-c', fixture, script, command, mode], { timeout: 12_000 });
  return JSON.parse(stdout);
}

test('local VM console completes a heredoc with a trailing newline and restores TTY state', unix, async () => {
  const result = await run("cat <<'VM_CHECK'\nheredoc-proof\nVM_CHECK\n");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /heredoc-proof/);
  assert.equal(result.ttyRestored, true);
  assert.doesNotMatch(result.stdout, /VM_RESULT_[a-f0-9]+=/);
});

test('local VM console returns the command failure status after multiline input and a final comment', unix, async () => {
  const result = await run("printf 'status-proof\\n'\n(exit 7)\n# final comment");
  assert.equal(result.code, 7, result.stderr);
  assert.match(result.stdout, /status-proof/);
  assert.equal(result.ttyRestored, true);
});

test('a health probe owning the console lock prevents command injection into its stream', unix, async () => {
  const result = await run("printf 'must-not-run'", 'busy');
  assert.equal(result.code, 75);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /busy/);
  assert.equal(result.ttyRestored, true);
});

test('a command timeout is a failure and still restores the local TTY', unix, async () => {
  const result = await run('sleep 2', 'timeout');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /deadline/);
  assert.equal(result.ttyRestored, true);
});
