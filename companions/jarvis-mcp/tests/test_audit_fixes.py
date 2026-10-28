"""Checks for the 2026-10-27 audit fixes: the file tools' secret deny-list, and
Google auth's headless fail-fast, consent outside the lock, and service rebuild
after a re-auth. Everything runs against a temporary HOME; nothing real is read.

Run from companions/jarvis-mcp:  .venv/bin/python -m pytest tests -q
"""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jarvis_tools import files, google_auth  # noqa: E402


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for var in ("DASH_DATA", "GOOGLE_CREDENTIALS_PATH", "GOOGLE_TOKEN_PATH", "JARVIS_HEADLESS", "DISPLAY", "WAYLAND_DISPLAY"):
        monkeypatch.delenv(var, raising=False)
    return home


def _make(path: Path, text: str = "secret") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# --- file_read / file_write deny-list -------------------------------------------------


@pytest.mark.parametrize(
    "relative",
    [
        ".jarvis/notes.txt",
        ".claude/CLAUDE.md",
        ".ssh/notes.txt",
        ".local/share/dash/secrets/robinhood.txt",
        ".local/share/dash/ntfy/auth.txt",
        ".config/dash-ntfy/creds.txt",
        "Library/Keychains/dump.txt",
    ],
)
def test_read_refuses_denied_dirs(home, relative):
    target = _make(home / relative)
    assert files.file_read(str(target)).startswith("Refused")
    assert files.file_read("~/" + relative).startswith("Refused")


def test_read_refuses_symlink_into_denied_dir(home, tmp_path):
    secret = _make(home / ".ssh" / "notes.txt")
    link = tmp_path / "innocent.txt"
    link.symlink_to(secret)
    assert files.file_read(str(link)).startswith("Refused")

    # A symlinked directory too.
    linked_dir = tmp_path / "docs"
    linked_dir.symlink_to(home / ".claude", target_is_directory=True)
    _make(home / ".claude" / "settings.md")
    assert files.file_read(str(linked_dir / "settings.md")).startswith("Refused")


def test_read_refuses_dotdot_into_denied_dir(home):
    _make(home / ".jarvis" / "notes.txt")
    (home / "Documents").mkdir()
    assert files.file_read(str(home / "Documents" / ".." / ".jarvis" / "notes.txt")).startswith("Refused")


@pytest.mark.parametrize("name", [".env", ".env.local", "server.pem", "private.key", "client_secret_123.apps.json"])
def test_read_refuses_secret_names(home, tmp_path, name):
    secret = _make(tmp_path / "project" / name)
    assert files.file_read(str(secret)).startswith("Refused")
    # A .txt symlink pointing at one is refused as well (it would otherwise be read as text).
    link = tmp_path / f"link-{name.strip('.')}.txt"
    link.symlink_to(secret)
    assert files.file_read(str(link)).startswith("Refused")


def test_read_refuses_dash_data_and_google_overrides(home, tmp_path, monkeypatch):
    data = tmp_path / "dashdata"
    monkeypatch.setenv("DASH_DATA", str(data))
    token = _make(tmp_path / "elsewhere" / "token.txt")
    monkeypatch.setenv("GOOGLE_TOKEN_PATH", str(token))
    assert files.file_read(str(_make(data / "secrets" / "x.txt"))).startswith("Refused")
    assert files.file_read(str(token)).startswith("Refused")


@pytest.mark.skipif(sys.platform != "darwin", reason="case-insensitive volumes are the macOS default")
def test_read_refuses_other_case_on_mac(home):
    _make(home / ".ssh" / "notes.txt")
    assert files.file_read(str(home / ".SSH" / "notes.txt")).startswith("Refused")


def test_read_allows_ordinary_files(home):
    ok = _make(home / "Documents" / "notes.txt", "hello")
    assert files.file_read(str(ok)) == "hello"
    # A name that merely contains "key" or "env" is fine.
    assert files.file_read(str(_make(home / "Documents" / "keynotes.md", "k"))) == "k"


def test_write_refuses_denied_paths(home, tmp_path):
    target = home / ".claude" / "CLAUDE.md"
    assert files.file_write(str(target), "pwned").startswith("Refused")
    assert not target.exists()

    (home / ".ssh").mkdir()
    link = tmp_path / "out.txt"
    link.symlink_to(home / ".ssh" / "authorized_keys.txt")
    assert files.file_write(str(link), "pwned").startswith("Refused")
    assert not (home / ".ssh" / "authorized_keys.txt").exists()

    assert files.file_write(str(home / "Documents" / "fine.txt"), "ok").startswith("Wrote")


# --- Google auth ------------------------------------------------------------------------


class _FakeCreds:
    def __init__(self, label: str):
        self.label = label
        self.valid = True
        self.expired = False
        self.refresh_token = None

    def to_json(self) -> str:
        return '{"label": "%s"}' % self.label


@pytest.fixture
def auth(home, tmp_path, monkeypatch):
    """Fresh google_auth state, with client secrets and token paths in tmp."""
    secrets = _make(tmp_path / "gauth" / "credentials.json", "{}")
    token = tmp_path / "gauth" / "token.json"
    monkeypatch.setenv("GOOGLE_CREDENTIALS_PATH", str(secrets))
    monkeypatch.setenv("GOOGLE_TOKEN_PATH", str(token))
    monkeypatch.setattr(google_auth, "_creds", None)
    monkeypatch.setattr(google_auth, "_creds_mtime", None)
    monkeypatch.setattr(google_auth, "_consent_running", False)
    monkeypatch.setattr(google_auth, "_local", threading.local())
    return token


def _flow_must_not_run(*_args, **_kwargs):
    raise AssertionError("the consent flow must not start on a headless machine")


def test_headless_linux_without_token_fails_fast(auth, monkeypatch):
    monkeypatch.setattr(google_auth.sys, "platform", "linux")
    monkeypatch.setattr(google_auth.InstalledAppFlow, "from_client_secrets_file", _flow_must_not_run)
    with pytest.raises(google_auth.GoogleSetupError) as caught:
        google_auth.get_service("gmail", "v1")
    message = str(caught.value)
    assert "Mac" in message and str(auth) in message
    assert not google_auth._creds_lock.locked()
    assert google_auth._consent_running is False


def test_headless_env_flag_fails_fast(auth, monkeypatch):
    monkeypatch.setattr(google_auth.sys, "platform", "darwin")
    monkeypatch.setenv("JARVIS_HEADLESS", "1")
    monkeypatch.setattr(google_auth.InstalledAppFlow, "from_client_secrets_file", _flow_must_not_run)
    with pytest.raises(google_auth.GoogleSetupError):
        google_auth._load_credentials()


def test_linux_with_display_is_not_headless(monkeypatch):
    monkeypatch.delenv("JARVIS_HEADLESS", raising=False)
    monkeypatch.setattr(google_auth.sys, "platform", "linux")
    monkeypatch.setenv("DISPLAY", ":0")
    assert google_auth._is_headless() is False
    monkeypatch.delenv("DISPLAY")
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    assert google_auth._is_headless() is True


def test_consent_runs_outside_the_lock_and_rebuilds_after_reauth(auth, monkeypatch):
    monkeypatch.setattr(google_auth.sys, "platform", "darwin")

    class _Flow:
        def run_local_server(self, **_kwargs):
            # Another thread must be able to take the lock while we wait on the user.
            assert not google_auth._creds_lock.locked()
            return _FakeCreds("first")

    monkeypatch.setattr(google_auth.InstalledAppFlow, "from_client_secrets_file", lambda *_a, **_k: _Flow())
    built = []
    monkeypatch.setattr(google_auth, "build", lambda *_a, credentials, **_k: built.append(credentials) or object())

    # Token written by the consent flow is read back as the same credentials until it changes.
    loaded = {"creds": None}

    class _Credentials:
        @staticmethod
        def from_authorized_user_file(_path, _scopes):
            return loaded["creds"]

    monkeypatch.setattr(google_auth, "Credentials", _Credentials)

    first = google_auth.get_service("gmail", "v1")
    assert auth.exists()
    assert google_auth.get_service("gmail", "v1") is first
    assert [c.label for c in built] == ["first"]

    # A re-auth elsewhere replaces the token file: the next call rebuilds with the new credentials.
    loaded["creds"] = _FakeCreds("second")
    auth.write_text('{"label": "second"}', encoding="utf-8")
    stat = auth.stat()
    os.utime(auth, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    second = google_auth.get_service("gmail", "v1")
    assert second is not first
    assert [c.label for c in built] == ["first", "second"]

    # Credentials that went invalid are reloaded too, and the service rebuilt.
    loaded["creds"] = _FakeCreds("third")
    google_auth._creds.valid = False
    assert google_auth.get_service("gmail", "v1") is not second
    assert [c.label for c in built] == ["first", "second", "third"]


def test_second_thread_fails_fast_while_consent_waits(auth, monkeypatch):
    monkeypatch.setattr(google_auth, "_consent_running", True)
    monkeypatch.setattr(google_auth.InstalledAppFlow, "from_client_secrets_file", _flow_must_not_run)
    with pytest.raises(google_auth.GoogleSetupError, match="waiting in the browser"):
        google_auth._get_credentials()
