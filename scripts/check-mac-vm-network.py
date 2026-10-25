#!/usr/bin/env python3
"""Read-only HTTPS exit check over the existing local ordinary-user console."""
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import termios
import time
import tty
import uuid

fd = None
try:
    vm_id, expected_ip = sys.argv[1:3]
    if not re.fullmatch(r'[0-9A-F-]{36}', vm_id):
        raise ValueError()
    ipaddress.ip_address(expected_ip)
    if len(sys.argv) == 4:
        cache_path = Path(sys.argv[3])
        cache = json.loads(cache_path.read_text())
        if time.time() - cache_path.stat().st_mtime > 45 or cache.get('ok') is not True or cache.get('vmId') != vm_id or cache.get('state') != 'started':
            raise ValueError()
        address = cache['tty']
    else:
        address = subprocess.check_output(['/usr/bin/osascript', '-e',
            'tell application "UTM" to get address of serial port 2 of virtual machine id "' + vm_id + '"'],
            timeout=4, stderr=subprocess.DEVNULL, text=True).strip()
    if not re.fullmatch(r'/dev/tty[\w.-]+', address):
        raise ValueError()
    fd = os.open(address, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    tty.setraw(fd)
    marker = 'BIFROST_HEALTH_' + uuid.uuid4().hex
    command = "stty -echo; env -i PATH=/usr/bin:/bin /usr/bin/curl --silent --max-time 7 --noproxy '*' 'https://api.ipify.org?format=json'; printf '\\n" + marker + "=%s\\n' \"$?\"\n"
    pending = command.encode()
    data = bytearray()
    deadline = time.monotonic() + 10
    next_write = 0
    while time.monotonic() < deadline:
        readable, writable, _ = select.select([fd], [fd] if pending and time.monotonic() >= next_write else [], [], 0.04)
        if writable:
            count = os.write(fd, pending[:128]); pending = pending[count:]; next_write = time.monotonic() + 0.025
        if readable:
            data.extend(os.read(fd, 16384))
            if len(data) > 16384:
                raise ValueError()
            match = re.search(rb'\r?\n' + marker.encode() + rb'=(\d+)\r?\n', data)
            if match:
                if match[1] != b'0':
                    raise ValueError()
                matches = re.findall(rb'\{"ip":"([0-9a-fA-F:.]+)"\}', data[:match.start()])
                if not matches or matches[-1].decode() != expected_ip:
                    raise ValueError()
                print(json.dumps({'ok': True, 'guestHttps': True, 'expectedVpsExit': True, 'modelRequests': 0}))
                sys.exit(0)
    raise TimeoutError()
except Exception:
    print(json.dumps({'ok': False, 'error': 'guest_network_probe_failed'}))
    sys.exit(1)
finally:
    if fd is not None:
        os.close(fd)
