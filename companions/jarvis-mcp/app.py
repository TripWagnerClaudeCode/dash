"""Shared FastMCP application instance for the jarvis-mcp server.

Every tool module imports ``mcp`` from here and registers via ``@mcp.tool()``.
This module imports nothing from the tool modules, so there is no circular
import. It also loads the server's own ``.env`` so secrets/config travel with
the install rather than depending on the Claude Code working directory.
"""
from __future__ import annotations

import functools
from pathlib import Path

import anyio
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

# Server install directory. All file output (e.g. screenshots) resolves relative
# to this, never the Claude Code working directory.
BASE_DIR = Path(__file__).resolve().parent

# Load secrets/config from this server's own .env (if present).
load_dotenv(BASE_DIR / ".env")

mcp = FastMCP("jarvis")


def tool_threaded(**tool_kwargs):
    """Register a blocking, synchronous function as an MCP tool that runs in a
    worker thread instead of on the event loop.

    FastMCP runs plain sync tool functions directly on the asyncio event loop, so
    a slow or blocking call — a network request, disk I/O, or worst of all the
    Google OAuth consent flow, which waits on a browser — would stall the entire
    server until it returns. Wrapping the function in an async shim that offloads
    to anyio's worker-thread pool keeps the loop responsive. The shim is @wraps'd,
    so FastMCP still infers the tool schema from the real function signature.
    """

    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            return await anyio.to_thread.run_sync(functools.partial(fn, *args, **kwargs))

        mcp.tool(**tool_kwargs)(wrapper)
        return fn

    return decorator
