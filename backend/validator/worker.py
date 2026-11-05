"""Untrusted candidate invocation only; all test assertions stay in the controller.

This process and everything it reports are untrusted after module import. It has
no approvals, trusted expected outputs, controller credentials or host access.
Python's isolated mode prevents candidate sitecustomize/pytest plugins loading
before this entry point. Docker, not this script, is the isolation boundary.
"""
import importlib
import json
import sys


def main():
    request = json.loads(sys.stdin.buffer.read(65537))
    # A fresh container is used for each case. Only JSON arguments are admitted.
    sys.path.insert(0, "/candidate")
    module = importlib.import_module(request["module"])
    function = getattr(module, request["function"])
    result = function(*request["args"], **request["kwargs"])
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
