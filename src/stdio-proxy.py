#!/usr/bin/env python3
"""Transparent stdio relay for runtimes whose nested Node pipes are unreliable.

Local patch: threads instead of selectors, since select() on Windows accepts sockets only.
"""

import os
import subprocess
import sys
import threading


def write_all(fd: int, data: bytes) -> None:
    while data:
        written = os.write(fd, data)
        data = data[written:]


def pump_input(child: subprocess.Popen) -> None:
    assert child.stdin is not None
    fd_in = sys.stdin.fileno()
    try:
        while data := os.read(fd_in, 65_536):
            write_all(child.stdin.fileno(), data)
    except OSError:
        pass
    finally:
        try:
            child.stdin.close()
        except OSError:
            pass


def main() -> int:
    if len(sys.argv) < 2:
        print("stdio-proxy.py requires a command", file=sys.stderr)
        return 2

    child = subprocess.Popen(
        sys.argv[1:],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
        close_fds=True,
    )
    assert child.stdout is not None
    threading.Thread(target=pump_input, args=(child,), daemon=True).start()

    fd_out = sys.stdout.fileno()
    while data := os.read(child.stdout.fileno(), 65_536):
        write_all(fd_out, data)

    return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
