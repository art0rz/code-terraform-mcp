#!/usr/bin/env python3
"""Transparent stdio relay for runtimes whose nested Node pipes are unreliable."""

import os
import selectors
import subprocess
import sys


def write_all(fd: int, data: bytes) -> None:
    while data:
        written = os.write(fd, data)
        data = data[written:]


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
    assert child.stdin is not None
    assert child.stdout is not None

    selector = selectors.DefaultSelector()
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "input")
    selector.register(child.stdout.fileno(), selectors.EVENT_READ, "output")

    output_open = True
    while output_open:
        for key, _ in selector.select():
            data = os.read(key.fd, 65_536)
            if key.data == "input":
                if data:
                    write_all(child.stdin.fileno(), data)
                else:
                    selector.unregister(key.fd)
                    child.stdin.close()
            elif data:
                write_all(sys.stdout.fileno(), data)
            else:
                selector.unregister(key.fd)
                output_open = False

    return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
