#!/usr/bin/env python3
"""Local serial transport for a private VM login session. Never print codes."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shlex
import subprocess
import sys
import termios
import time
import tty
import uuid

SCRIPTS = Path(__file__).resolve().parent
HEALTH = Path.home() / "Library/Application Support/ClaudeVPS/Bifrost/Maintenance/health.json"
GUEST = "/home/claude/.local/share/bifrost/auth-login"


def device():
    config = json.loads(HEALTH.read_text())
    cache = Path(config["vmStatusFile"])
    state = json.loads(cache.read_text())
    if (time.time() - cache.stat().st_mtime > 45 or state.get("ok") is not True
            or state.get("state") != "started" or state.get("vmId") != config["vmId"]
            or not re.fullmatch(r"/dev/tty[\w.-]+", state.get("tty", ""))):
        raise ValueError()
    return state["tty"]


def run_python(code):
    command = "python3 <<'BIFROST_PRIVATE_LOGIN'\n" + code + "\nBIFROST_PRIVATE_LOGIN\n"
    for attempt in range(12):
        r = subprocess.run([sys.executable, str(SCRIPTS / "mac-vm-console.py"), device(),
                            "--command", command, "--timeout", "12"], capture_output=True, text=True, timeout=16)
        if r.returncode == 75:
            time.sleep(0.2)
            continue
        if r.returncode:
            raise RuntimeError()
        rows = [json.loads(x) for x in r.stdout.splitlines() if x.startswith('{')]
        if len(rows) != 1:
            raise ValueError()
        return rows[0]
    raise RuntimeError()


def status(include_url=False):
    return run_python("import pathlib,json\np=pathlib.Path(" + repr(GUEST + "/session.json") + ")\n"
                      "d=json.loads(p.read_text()) if p.exists() else {'phase':'absent'}\n"
                      + ("" if include_url else "d.pop('authorizationUrl',None)\n") + "print(json.dumps(d))")


def start():
    source = (SCRIPTS / "claude-vm-login-session.py").read_bytes()
    encoded = base64.b64encode(source).decode()
    code = ["import base64,pathlib,subprocess,os,json,time,hashlib", "d=pathlib.Path(" + repr(GUEST) + ")",
            "d.mkdir(parents=True,mode=0o700,exist_ok=True)", "os.chmod(d,0o700)", "p=d/'session.json'",
            "previous=json.loads(p.read_text()) if p.exists() else {}", "active=False", "try:",
            " pid=previous.get('pid'); active=bool(pid and (str(d/'driver.py').encode() in pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes()))",
            "except (OSError,TypeError): pass", "if not active:", " data=("]
    code += ["  " + repr(encoded[i:i + 512]) for i in range(0, len(encoded), 512)]
    code += [" )", " raw=base64.b64decode(data)", " assert hashlib.sha256(raw).hexdigest()==" + repr(hashlib.sha256(source).hexdigest()),
             " f=d/'driver.py'; f.write_bytes(raw); f.chmod(0o700)",
             " subprocess.Popen(['/usr/bin/python3',str(f)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)",
             " time.sleep(0.2)", "state=json.loads(p.read_text()) if p.exists() else {'phase':'starting'}",
             "state.pop('authorizationUrl',None)", "print(json.dumps(state))"]
    return run_python("\n".join(code))


def send_message(message):
    frame = json.dumps(message, ensure_ascii=True).encode() + b"\n"
    if len(frame) > 3000:
        raise ValueError()
    marker = "LOGIN_FRAME_" + uuid.uuid4().hex
    receiver = ("import os,sys,json; print('\\n" + marker + "_READY',flush=True); "
                "data=sys.stdin.buffer.readline(4096); json.loads(data); "
                "fd=os.open(" + repr(GUEST + "/input.fifo") + ",os.O_WRONLY|os.O_NONBLOCK); "
                "os.write(fd,data); os.close(fd); print('\\n" + marker + "_DONE',flush=True)")
    # The credential frame is fed to Python's stdin after READY. It is never
    # placed in shell input, process arguments, a file, terminal echo or logs.
    static = ("stty -echo\npython3 -c " + shlex.quote(receiver) + "\n").encode()
    fd = None
    original = None
    try:
        for attempt in range(12):
            fd = os.open(device(), os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                os.close(fd)
                fd = None
                time.sleep(0.2)
        if fd is None:
            raise RuntimeError()
        original = termios.tcgetattr(fd)
        tty.setraw(fd)
        outgoing, received, submitted = static, bytearray(), False
        deadline = time.monotonic() + 10
        next_write = 0
        while time.monotonic() < deadline:
            readable, writable, _ = select.select([fd], [fd] if outgoing and time.monotonic() >= next_write else [], [], 0.02)
            if writable:
                n = os.write(fd, outgoing[:128])
                outgoing = outgoing[n:]
                next_write = time.monotonic() + 0.025
            if readable:
                received.extend(os.read(fd, 16384))
                if len(received) > 16384:
                    raise ValueError()
                if re.search(rb"\r?\n" + marker.encode() + rb"_READY\r?\n", received) and not submitted and not outgoing:
                    outgoing, submitted = frame, True
                if re.search(rb"\r?\n" + marker.encode() + rb"_DONE\r?\n", received):
                    return {"sent": True}
        raise TimeoutError()
    finally:
        if fd is not None:
            if original is not None:
                termios.tcsetattr(fd, termios.TCSANOW, original)
            os.close(fd)


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ""
    if action == "start":
        result = start()
    elif action == "status":
        result = status()
    elif action == "get-url":
        # Private IPC output for the browser controller, not an operator log.
        state = status(include_url=True)
        result = {"phase": state.get("phase"), "url": state.get("authorizationUrl")}
    elif action == "send":
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError()
        result = send_message(json.loads(raw))
    else:
        raise ValueError()
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "vm_login_transport_failed"}))
        raise SystemExit(1)
