"""Small trusted adapters shared with the simulator; no candidate imports."""
from __future__ import annotations

from contextvars import ContextVar
from functools import wraps
import inspect

ACTIVE_RUNTIME: ContextVar[object | None] = ContextVar("response_runtime", default=None)
ADMITTED_RUNTIME: ContextVar[object | None] = ContextVar("response_admission", default=None)


def response_tool(function):
    """Wrap only the registered simulator tool bodies, preserving their signature."""
    signature = inspect.signature(function)

    @wraps(function)
    def invoke(self, agent, *args, **kwargs):
        runtime = getattr(self.runner, "response", None)
        if runtime is None:
            return function(self, agent, *args, **kwargs)
        bound = signature.bind(self, agent, *args, **kwargs)
        bound.apply_defaults()
        arguments = {k: v for k, v in bound.arguments.items() if k not in {"self", "agent", "malicious"}}
        return runtime.execute_tool(self, function.__name__, agent, arguments,
                                    lambda: function(self, agent, *args, **kwargs))
    return invoke
