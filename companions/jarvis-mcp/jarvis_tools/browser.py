"""Browser automation via Playwright (async, headless Chromium).

Tools: browser_navigate, browser_interact, browser_screenshot.

A single browser + page is launched lazily and kept alive across tool calls so
navigate → fill → click → screenshot operate on the same page. Importable
without Playwright; tools then return install instructions. After
`pip install playwright` you must also run `playwright install chromium` once.

Screenshots are saved under the server install dir (BASE_DIR/data/screenshots)
and returned to Claude as MCP image content.
"""
from __future__ import annotations

from app import BASE_DIR, mcp

try:
    from mcp.server.fastmcp import Image

    _IMAGE_AVAILABLE = True
except ImportError:  # pragma: no cover
    Image = None
    _IMAGE_AVAILABLE = False

try:
    from playwright.async_api import async_playwright

    _PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    async_playwright = None
    _PLAYWRIGHT_AVAILABLE = False

_INSTALL_HINT = (
    "Browser automation isn't set up. Run:\n"
    "  pip install playwright\n"
    "  playwright install chromium"
)

_SCREENSHOT_DIR = BASE_DIR / "data" / "screenshots"


class _BrowserSession:
    """Lazily-launched, reusable headless Chromium session."""

    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self._page = None

    async def page(self):
        """Return the live page, launching the browser on first use."""
        if self._page is not None:
            return self._page
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(headless=True)
        self._page = await self._browser.new_page()
        return self._page

    async def close(self) -> None:
        try:
            if self._browser:
                await self._browser.close()
            if self._pw:
                await self._pw.stop()
        finally:
            self._pw = self._browser = self._page = None


_session = _BrowserSession()


@mcp.tool()
async def browser_navigate(url: str) -> str:
    """Open a URL in a headless browser and return the page title and visible text.

    The page stays open so you can then interact with it or screenshot it.

    Args:
        url: The URL to open.
    """
    if not _PLAYWRIGHT_AVAILABLE:
        return _INSTALL_HINT
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        page = await _session.page()
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        title = await page.title()
        text = await page.inner_text("body")
    except Exception as exc:  # noqa: BLE001
        hint = f"\n({_INSTALL_HINT})" if "Executable doesn't exist" in str(exc) else ""
        return f"Navigation failed: {exc}{hint}"
    if len(text) > 4000:
        text = text[:4000] + "\n…[truncated]"
    return f"Title: {title}\nURL: {page.url}\n\n{text}"


@mcp.tool()
async def browser_interact(action: str, selector: str, value: str = "") -> str:
    """Interact with the currently open page.

    action='click' clicks the element matching a CSS selector; action='fill'
    types a value into an input. Navigate to a page first.

    Args:
        action: What to do — 'click' or 'fill'.
        selector: CSS selector for the target element.
        value: Text to type (required for fill).
    """
    if not _PLAYWRIGHT_AVAILABLE:
        return _INSTALL_HINT
    if _session._page is None:
        return "No page is open. Use browser_navigate first."
    page = await _session.page()
    try:
        if action == "click":
            await page.click(selector, timeout=10000)
            return f"Clicked {selector!r}. Now at {page.url}"
        if action == "fill":
            await page.fill(selector, value, timeout=10000)
            return f"Filled {selector!r} with {value!r}."
        return f"Unknown action {action!r}. Use 'click' or 'fill'."
    except Exception as exc:  # noqa: BLE001
        return f"Interaction failed: {exc}"


@mcp.tool()
async def browser_screenshot():
    """Capture a PNG screenshot of the current page.

    Saves it under the server's data/screenshots folder and returns the image to
    Claude. Navigate to a page first.
    """
    if not _PLAYWRIGHT_AVAILABLE:
        return _INSTALL_HINT
    if _session._page is None:
        return "No page is open. Use browser_navigate first."
    page = await _session.page()
    try:
        png = await page.screenshot(full_page=True)
    except Exception as exc:  # noqa: BLE001
        return f"Screenshot failed: {exc}"
    _SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch if ch.isalnum() else "_" for ch in page.url)[:60] or "page"
    path = _SCREENSHOT_DIR / f"{safe}.png"
    path.write_bytes(png)
    if _IMAGE_AVAILABLE:
        return Image(data=png, format="png")
    return f"Saved screenshot to {path} ({len(png)} bytes)."
