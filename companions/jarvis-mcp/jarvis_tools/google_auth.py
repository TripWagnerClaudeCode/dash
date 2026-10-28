"""Shared Google OAuth2 helper for the Gmail and Calendar tools.

One token covers both APIs because we request all needed scopes up front. The
flow is lazy: nothing happens until a tool needs a service, at which point we
load/refresh a cached token or run the browser consent flow once.

Credentials and token default to ``~/.jarvis/`` — the same paths JARVISv2 uses —
so an existing JARVIS authorization is reused with no re-setup. Override via
GOOGLE_CREDENTIALS_PATH / GOOGLE_TOKEN_PATH.

If the Google client libraries aren't installed, or the credentials file is
missing, callers get a GoogleSetupError whose message is ready to show.
"""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

# All scopes both tools might need — requesting together means a single token.
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file",
]

try:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    _GOOGLE_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    _GOOGLE_AVAILABLE = False


class GoogleSetupError(RuntimeError):
    """Raised when Google auth can't proceed; message is a short user-facing note."""


_INSTALL_HINT = (
    "Google (email/calendar) isn't set up. To enable:\n"
    "  1. pip install google-api-python-client google-auth-oauthlib google-auth-httplib2\n"
    "  2. Create an OAuth 2.0 Client ID (type: Desktop app) in Google Cloud Console,\n"
    "     enabling the Gmail API and Google Calendar API for the project.\n"
    "  3. Download the client-secrets JSON to ~/.jarvis/credentials.json\n"
    "     (or the path in GOOGLE_CREDENTIALS_PATH).\n"
    "  4. The first email/calendar call opens a browser to authorize; the token is\n"
    "     cached at ~/.jarvis/google_token.json (or GOOGLE_TOKEN_PATH) and reused.\n"
    "If you already authorized email/calendar in JARVISv2, that token is reused automatically."
)

# On a machine with no browser (the hub, running headless under systemd) the
# consent flow can't work: run_local_server would wait forever for a redirect.
def _headless_hint(token_path: str) -> str:
    return (
        "Google isn't authorized on this machine, and it has no browser for the sign-in.\n"
        "Re-authorize on the Mac (see the jarvis Google re-auth note), then copy the Mac's\n"
        f"~/.jarvis/google_token.json to {token_path} here. It's picked up on the next call; no restart needed."
    )


# How long the browser consent flow waits for the user before giving up.
CONSENT_TIMEOUT = 300

# httplib2 (used by googleapiclient) is NOT thread-safe, and FastMCP runs sync
# tools in a thread pool. So we cache the *credentials* once (lock-guarded) but
# build a *separate service per thread* via thread-local storage. Each thread's
# service remembers which credentials it was built with, and is rebuilt when the
# shared credentials are replaced (token file changed, or they went invalid), so
# a re-auth takes effect without restarting the server.
_creds_lock = threading.Lock()
_creds = None  # shared credentials object
_creds_mtime = None  # token file mtime when _creds was loaded or saved
_consent_running = False  # a thread is waiting on the browser consent flow
_local = threading.local()


def _paths() -> tuple[str, str]:
    _default_dir = Path.home() / ".jarvis"
    creds_path = os.getenv("GOOGLE_CREDENTIALS_PATH") or str(_default_dir / "credentials.json")
    token_path = os.getenv("GOOGLE_TOKEN_PATH") or str(_default_dir / "google_token.json")
    return creds_path, token_path


def _token_mtime(token_path: str):
    try:
        return os.stat(token_path).st_mtime_ns
    except OSError:
        return None


def _is_headless() -> bool:
    """True when there's no way to show the consent page: JARVIS_HEADLESS=1, or Linux with no display."""
    flag = os.getenv("JARVIS_HEADLESS", "").strip().lower()
    if flag in ("1", "true", "yes"):
        return True
    if flag in ("0", "false", "no"):
        return False
    return sys.platform.startswith("linux") and not (os.getenv("DISPLAY") or os.getenv("WAYLAND_DISPLAY"))


def _save(creds, token_path: str) -> None:
    Path(token_path).parent.mkdir(parents=True, exist_ok=True)
    Path(token_path).write_text(creds.to_json(), encoding="utf-8")


def _load_saved():
    """The saved token, refreshed if it has expired. None if there's no usable token. Never waits on a user."""
    _, token_path = _paths()
    creds = None
    if Path(token_path).exists():
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        _save(creds, token_path)
        return creds
    return None


def _consent():
    """Run the browser consent flow and save the token. Waits on the user, so never call it holding _creds_lock.

    Fails fast (GoogleSetupError) when the client secrets are missing or the machine is headless.
    """
    creds_path, token_path = _paths()
    if not Path(creds_path).exists():
        raise GoogleSetupError(_INSTALL_HINT)
    if _is_headless():
        raise GoogleSetupError(_headless_hint(token_path))
    flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
    try:
        creds = flow.run_local_server(port=0, timeout_seconds=CONSENT_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 - a timeout surfaces as an odd error from the library
        raise GoogleSetupError(f"Google sign-in didn't finish in the browser ({exc}). Try again.") from exc
    if creds is None:
        raise GoogleSetupError("Google sign-in didn't finish in the browser. Try again.")
    _save(creds, token_path)
    return creds


def _load_credentials():
    """Load or refresh the saved token, or authorize once in the browser.

    The re-auth procedure calls this directly to open the consent page.
    """
    return _load_saved() or _consent()


def _get_credentials():
    """Load/refresh credentials once, shared across threads (lock-guarded).

    Reloads when the shared credentials are invalid or the token file changed on
    disk (a re-auth, or a token copied over from the Mac). The consent flow runs
    outside the lock; other threads that need it meanwhile fail fast.
    """
    global _creds, _creds_mtime, _consent_running
    _, token_path = _paths()
    with _creds_lock:
        mtime = _token_mtime(token_path)
        if _creds is not None and getattr(_creds, "valid", False) and mtime == _creds_mtime:
            return _creds
        creds = _load_saved()
        if creds is not None:
            _creds, _creds_mtime = creds, _token_mtime(token_path)
            return _creds
        if _consent_running:
            raise GoogleSetupError("Google sign-in is waiting in the browser. Finish it there, then try again.")
        _consent_running = True
    try:
        creds = _consent()
    finally:
        with _creds_lock:
            _consent_running = False
    with _creds_lock:
        _creds, _creds_mtime = creds, _token_mtime(token_path)
        return _creds


def get_service(api_name: str, api_version: str):
    """Return an authorised Google API client (one per thread).

    Raises GoogleSetupError (with setup instructions) if Google isn't configured.
    This call may block and open a browser on first use.
    """
    if not _GOOGLE_AVAILABLE:
        raise GoogleSetupError(_INSTALL_HINT)

    cache = getattr(_local, "services", None)
    if cache is None:
        cache = _local.services = {}
    key = f"{api_name}:{api_version}"
    creds = _get_credentials()
    built = cache.get(key)
    if built is None or built[0] is not creds:
        # First use in this thread, or the shared credentials were replaced since this service was built.
        cache[key] = (creds, build(api_name, api_version, credentials=creds, cache_discovery=False))
    return cache[key][1]
