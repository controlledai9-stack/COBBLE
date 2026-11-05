"""Bounded shell-free local process execution; callers own external-effect cleanup."""
from __future__ import annotations

from dataclasses import dataclass
import os
import subprocess
import threading

from app.modules.response.repository import Unavailable


@dataclass(frozen=True)
class ProcessResult:
    code: int
    stdout: bytes
    stderr: bytes


def run_bounded(arguments: list[str], *, cwd, env: dict[str, str], data: bytes | None = None,
                timeout: float = 15, max_output: int = 2097152) -> ProcessResult:
    if not arguments or not all(isinstance(a, str) and "\0" not in a for a in arguments):
        raise ValueError("process arguments must be a validated string array")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(arguments, cwd=cwd, env=env, shell=False,
        stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    output, errors = bytearray(), bytearray()
    overflow, lock = threading.Event(), threading.Lock()

    def drain(stream, destination):
        try:
            while block := stream.read(65536):
                with lock:
                    if len(output) + len(errors) + len(block) > max_output:
                        overflow.set()
                        process.kill()
                        break
                    destination.extend(block)
        finally:
            stream.close()

    def feed():
        try:
            process.stdin.write(data)
        except (BrokenPipeError, OSError):
            pass
        finally:
            process.stdin.close()

    readers = [threading.Thread(target=drain, args=(process.stdout, output), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, errors), daemon=True)]
    writer = threading.Thread(target=feed, daemon=True) if data is not None else None
    for thread in readers:
        thread.start()
    if writer:
        writer.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.wait()
        raise Unavailable("trusted process exceeded its execution deadline") from exc
    finally:
        for thread in readers:
            thread.join(timeout=2)
        if writer:
            writer.join(timeout=2)
    if overflow.is_set() or any(thread.is_alive() for thread in readers):
        raise Unavailable("trusted process exceeded its output or drain budget")
    return ProcessResult(process.returncode, bytes(output), bytes(errors))
