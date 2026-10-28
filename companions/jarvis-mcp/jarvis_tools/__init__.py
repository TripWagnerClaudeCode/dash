"""jarvis-mcp tool implementations.

Each module imports the shared ``mcp`` instance from ``app`` and registers its
tools with ``@mcp.tool()``. ``server.py`` imports these modules to register
them. Optional dependencies are imported defensively so a missing package
disables only its own tool(s).
"""
