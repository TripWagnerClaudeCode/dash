"""web_search tool — Tavily when TAVILY_API_KEY is set, else DuckDuckGo (keyless).

Importable even if neither provider library is installed; the tool then returns
a helpful setup message.
"""
from __future__ import annotations

import os

from app import tool_threaded

# Tavily (optional, needs TAVILY_API_KEY)
try:
    from tavily import TavilyClient

    _TAVILY_AVAILABLE = True
except ImportError:  # pragma: no cover
    TavilyClient = None
    _TAVILY_AVAILABLE = False

# DuckDuckGo — the package was renamed from duckduckgo_search to ddgs.
try:
    from ddgs import DDGS

    _DDG_AVAILABLE = True
except ImportError:  # pragma: no cover
    try:
        from duckduckgo_search import DDGS  # older name

        _DDG_AVAILABLE = True
    except ImportError:
        DDGS = None
        _DDG_AVAILABLE = False


_PROVIDER = os.getenv("WEB_SEARCH_PROVIDER", "auto").lower()
MAX_RESULTS = 5


def _format(results: list[dict]) -> str:
    if not results:
        return "No results found."
    lines = []
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r.get('title', '(untitled)')}\n   {r.get('url', '')}\n   {r.get('snippet', '')}")
    return "\n".join(lines)


def _tavily_search(query: str, k: int) -> list[dict]:
    client = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])
    resp = client.search(query=query, max_results=k)
    return [
        {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("content", "")}
        for r in resp.get("results", [])
    ]


def _ddg_search(query: str, k: int) -> list[dict]:
    with DDGS() as ddgs:
        hits = list(ddgs.text(query, max_results=k))
    return [
        {"title": h.get("title", ""), "url": h.get("href", h.get("url", "")), "snippet": h.get("body", "")}
        for h in hits
    ]


@tool_threaded()
def web_search(query: str, max_results: int = MAX_RESULTS) -> str:
    """Search the web for current information.

    Returns the top results with title, URL, and a snippet. Use for facts, news,
    docs, or anything that may have changed recently or that you are unsure about.

    Args:
        query: The search query.
        max_results: How many results to return (default 5).
    """
    k = int(max_results or MAX_RESULTS)
    have_tavily = _TAVILY_AVAILABLE and os.getenv("TAVILY_API_KEY")

    # Decide provider order based on config + availability.
    if _PROVIDER == "tavily":
        order = ["tavily"]
    elif _PROVIDER == "duckduckgo":
        order = ["ddg"]
    else:  # auto: prefer Tavily if usable, fall back to DDG
        order = (["tavily"] if have_tavily else []) + ["ddg"]

    last_error = None
    for provider in order:
        try:
            if provider == "tavily" and have_tavily:
                return _format(_tavily_search(query, k))
            if provider == "ddg" and _DDG_AVAILABLE:
                return _format(_ddg_search(query, k))
        except Exception as exc:  # noqa: BLE001 - try the next provider
            last_error = exc

    if not have_tavily and not _DDG_AVAILABLE:
        return (
            "Web search is unavailable: install a provider with "
            "`pip install ddgs` (no API key) or set TAVILY_API_KEY and "
            "`pip install tavily-python`."
        )
    return f"Web search failed: {last_error}"
