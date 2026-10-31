#!/usr/bin/env python3
"""Ordinary-user CLI login session. No network listener or credential logging."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time
from urllib.parse import parse_qs, urlsplit
import urllib.request
import urllib.error

AUTH_HOSTS = {"claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"}


def authorization_url(text):
    for value in re.findall(r"https://[^\s\x00-\x1f\x7f]+(?=[\s\x00-\x1f\x7f])", text):
        u = urlsplit(value)
        q = parse_qs(u.query, keep_blank_values=True)
        if (u.hostname in AUTH_HOSTS and "oauth" in u.path and not u.username and not u.password
                and not u.port and not u.fragment
                and all(len(q.get(k, [])) == 1 and q[k][0] for k in ["state", "code_challenge", "redirect_uri"])):
            return value
    return None


def validate_message(message, auth_url):
    if not isinstance(message, dict):
        raise ValueError()
    if message.get("action") == "cancel":
        return "cancel", None
    q = parse_qs(urlsplit(auth_url).query, keep_blank_values=True)
    state = q.get("state", [None])[0]
    if not state or message.get("state") != state:
        raise ValueError()
    if message.get("action") == "code":
        value = message.get("value")
        if not isinstance(value, str) or not 1 <= len(value) <= 4096 or re.search(r"[\x00-\x20\x7f]", value):
            raise ValueError()
        return "code", value
    if message.get("action") == "callback":
        value = message.get("value")
        if not isinstance(value, str) or len(value) > 8192:
            raise ValueError()
        actual, expected = urlsplit(value), urlsplit(q.get("redirect_uri", [""])[0])
        result = parse_qs(actual.query, keep_blank_values=True)
        if (expected.scheme != "http" or expected.hostname not in {"127.0.0.1", "localhost", "::1"}
                or actual.scheme != expected.scheme or actual.netloc != expected.netloc
                or actual.path != expected.path or actual.fragment or actual.username
                or result.get("state") != [state] or len(result.get("code", [])) != 1 or not result["code"][0]):
            raise ValueError()
        return "callback", value
    raise ValueError()


def main():
    config = json.loads(Path("/etc/bifrost/relay.json").read_text())["cli"]
    directory = Path(config["stateDir"]).parent / "auth-login"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    lock = (directory / "session.lock").open("a")
    os.chmod(directory / "session.lock", 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    state_file = directory / "session.json"

    def publish(phase, url=None, **extra):
        data = {"version": 1, "pid": os.getpid(), "phase": phase, "updatedAt": time.time()}
        data.update(extra)
        if url:
            data["authorizationUrl"] = url
        tmp = state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data) + "\n")
        tmp.chmod(0o600)
        tmp.replace(state_file)

    env = {"HOME": config["profileDir"], "USER": "claude", "LOGNAME": "claude",
           "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "en_US.UTF-8",
           "TERM": "xterm-256color", "TZ": "America/Los_Angeles",
           "CLAUDE_CONFIG_DIR": config["configDir"], "DISABLE_AUTOUPDATER": "1"}

    def authenticated():
        try:
            r = subprocess.run([config["binary"], "auth", "status", "--json"], env=env,
                               capture_output=True, text=True, timeout=15)
            d = json.loads(r.stdout)
            return d.get("loggedIn") is True and d.get("authMethod") == "claude.ai" and d.get("configDirectory") == config["configDir"]
        except Exception:
            return False

    publish("starting")
    if authenticated():
        publish("already_authenticated")
        return
    fifo = directory / "input.fifo"
    fifo.unlink(missing_ok=True)
    os.mkfifo(fifo, 0o600)
    incoming = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(config["profileDir"])
        os.execve(config["binary"], [config["binary"], "auth", "login", "--claudeai"], env)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 2000, 0, 0))
    publish("starting")
    deadline, output, input_buffer, url, submitted = time.monotonic() + 1800, "", b"", None, False
    last_diagnostic = 0
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master, incoming], [], [], 0.2)
            if master in ready:
                try:
                    chunk = os.read(master, 16384)
                except OSError:
                    break
                if not chunk:
                    break
                output = (output + chunk.decode("utf-8", "replace"))[-65536:]
                if not url:
                    clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)
                    url = authorization_url(clean)
                    if url:
                        publish("awaiting_owner_authorization", url)
                    elif time.monotonic() - last_diagnostic > 0.5:
                        safe = re.sub(r"https?://[^\s\x00-\x1f]+", "[link]", clean)
                        safe = re.sub(r"[\w.+-]+@[\w.-]+", "[email]", safe)
                        safe = re.sub(r"[A-Za-z0-9_+/=-]{24,}", "[opaque]", safe)
                        publish("starting", diagnosticText=safe[-1200:])
                        last_diagnostic = time.monotonic()
            if incoming in ready:
                input_buffer += os.read(incoming, 16384)
                if len(input_buffer) > 16384:
                    raise ValueError()
                if b"\n" in input_buffer:
                    line, input_buffer = input_buffer.split(b"\n", 1)
                    message = json.loads(line)
                    action, value = validate_message(message, url or "")
                    if action == "cancel":
                        publish("cancelled")
                        return
                    if submitted:
                        continue
                    if action == "code":
                        os.write(master, (value + "\n").encode())
                    else:
                        # The CLI owns this exact guest-loopback callback. Do
                        # not follow redirects to another endpoint.
                        class NoRedirect(urllib.request.HTTPRedirectHandler):
                            def redirect_request(self, *args, **kwargs):
                                return None
                        try:
                            urllib.request.build_opener(NoRedirect).open(value, timeout=5).close()
                        except urllib.error.HTTPError as e:
                            if not 300 <= e.code < 400:
                                raise
                    submitted = True
                    publish("finishing")
            done, result = os.waitpid(pid, os.WNOHANG)
            if done:
                pid = None
                break
        publish("authenticated" if authenticated() else "not_authenticated")
    except Exception:
        publish("failed")
    finally:
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        os.close(master)
        os.close(incoming)
        fifo.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
