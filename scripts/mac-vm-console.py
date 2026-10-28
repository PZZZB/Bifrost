#!/usr/bin/env python3
"""Run a command on an existing local VM console; no SSH or network listener."""
import argparse
import fcntl
import os
import re
import select
import stat
import sys
import termios
import time
import tty
import uuid


def command_input(command, marker):
    # A semicolon following a heredoc terminator on a new line is a syntax
    # error. Keep command completion on separate lines, including trailing
    # comments, and capture the guest command's status before printing.
    return ("stty -echo\n" + command + "\n__bifrost_console_rc=$?\n"
            "printf '\\n" + marker + "=%s\\n' \"$__bifrost_console_rc\"\n").encode()


def run(args):
    fd = None
    saved = None
    try:
        if not os.path.isabs(args.device):
            raise ValueError("Expected an absolute local console path.")
        fd = os.open(args.device, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
        if not stat.S_ISCHR(os.fstat(fd).st_mode) or not os.isatty(fd):
            raise ValueError("Expected a local TTY device.")
        # Health probes use the same advisory lock. A busy console must not
        # receive part of another command or lose another reader's output.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        saved = termios.tcgetattr(fd)
        tty.setraw(fd)
        marker = "VM_RESULT_" + uuid.uuid4().hex
        pending = command_input(args.command, marker) if args.command else b""
        deadline = time.monotonic() + (args.timeout if args.command else args.watch)
        data = bytearray()
        next_write = 0
        pattern = re.compile(rb"\r?\n" + marker.encode() + rb"=(\d+)\r?\n")
        while time.monotonic() < deadline:
            readable, writable, _ = select.select(
                [fd], [fd] if pending and time.monotonic() >= next_write else [], [],
                min(0.05, max(0.001, deadline - time.monotonic())))
            if writable:
                try:
                    count = os.write(fd, pending[:128])
                    pending = pending[count:]
                    next_write = time.monotonic() + 0.025
                except BlockingIOError:
                    pass
            if readable:
                try:
                    chunk = os.read(fd, 65536)
                except BlockingIOError:
                    continue
                if not chunk:
                    break
                if args.command:
                    data.extend(chunk)
                    if len(data) > 1_048_576:
                        raise ValueError("Local console output exceeded its limit.")
                    match = pattern.search(data)
                    if match:
                        sys.stdout.buffer.write(data[:match.start()])
                        return int(match.group(1))
                else:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
        if args.command:
            # Preserve received diagnostics, but never claim a timed-out or
            # disconnected command completed successfully.
            sys.stdout.buffer.write(data)
            print("Local console command did not finish before the deadline.", file=sys.stderr)
            return 1
        return 0
    except BlockingIOError:
        print("Local console is busy; retry after the other check finishes.", file=sys.stderr)
        return 75
    except (OSError, ValueError, termios.error):
        print("Local console command failed; check the device and console state.", file=sys.stderr)
        return 1
    finally:
        if fd is not None:
            if saved is not None:
                try:
                    termios.tcsetattr(fd, termios.TCSANOW, saved)
                except (OSError, termios.error):
                    pass
            os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("device")
    parser.add_argument("--command")
    parser.add_argument("--watch", type=float, default=5)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    if not 0 < args.watch <= 60 or not 0 < args.timeout <= 3600:
        parser.error("Expected positive bounded watch and timeout durations.")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
