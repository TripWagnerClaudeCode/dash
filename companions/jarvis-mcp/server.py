"""jarvis-mcp entrypoint.

Importing each tool module registers its tools on the shared ``mcp`` instance
(the register-on-import pattern JARVIS uses). Imports are defensive: a missing
optional dependency disables just that tool group, not the whole server. Runs
over stdio so Claude Code can launch it as a subprocess.

CRITICAL: nothing here may write to stdout — stdout carries the MCP protocol.
All diagnostics go to stderr via logging.
"""
from __future__ import annotations

import logging
import sys

# Logs to stderr only; stdout is reserved for the MCP protocol.
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
log = logging.getLogger("jarvis-mcp")

from app import mcp  # noqa: E402  (configure logging before importing tools)

_MODULES = [
    "web_search",
    "files",
    "weather",
    "email_tools",
    "calendar_tools",
    "browser",
    "lecture_notes",
]

for _mod in _MODULES:
    try:
        __import__(f"jarvis_tools.{_mod}")
    except Exception as exc:  # noqa: BLE001 - one bad module shouldn't sink the server
        log.warning("Tool module %r disabled: %s", _mod, exc)


if __name__ == "__main__":
    mcp.run()
