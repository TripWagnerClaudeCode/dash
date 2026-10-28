"""file_read / file_write tools.

Reads txt, md, pdf (pypdf), docx (python-docx), and csv. Writes txt, md, csv.
Unlike the JARVIS original, there is no ChromaDB memory chunking here — Claude
Code is the agent and holds context itself. Very large files are truncated with
a clear note instead of being stored.

Both tools refuse secrets: the Google token and client secrets, Claude Code's
config, SSH keys, Dash's secrets and ntfy credentials, the macOS keychains, and
any .env / *.pem / *.key / client_secret*.json file. Paths are resolved
(symlinks and "..") before the check, so a link into a protected place is
refused too.
"""
from __future__ import annotations

import csv
import io
import os
import sys
from pathlib import Path

from app import tool_threaded

# Optional readers — degrade per-format if a dependency is missing.
try:
    from pypdf import PdfReader

    _PDF_AVAILABLE = True
except ImportError:  # pragma: no cover
    PdfReader = None
    _PDF_AVAILABLE = False

try:
    import docx  # python-docx

    _DOCX_AVAILABLE = True
except ImportError:  # pragma: no cover
    docx = None
    _DOCX_AVAILABLE = False


# Above this many characters, file_read returns a truncated preview with a note.
MAX_CHARS = 100_000

# Directories (relative to home) that file_read/file_write never touch.
_DENIED_DIRS = (
    ".jarvis",
    ".claude",
    ".ssh",
    ".local/share/dash/secrets",
    ".local/share/dash/ntfy",
    ".config/dash-ntfy",
    "Library/Keychains",
)


def _denied_paths() -> list[str]:
    """Protected locations, each both as written and fully resolved. Computed per call so HOME changes apply."""
    home = Path.home()
    paths = [home / d for d in _DENIED_DIRS]
    data = os.getenv("DASH_DATA")  # the hub's data dir, when it isn't the default
    if data:
        paths += [Path(data).expanduser() / "secrets", Path(data).expanduser() / "ntfy"]
    for var in ("GOOGLE_CREDENTIALS_PATH", "GOOGLE_TOKEN_PATH"):
        if os.getenv(var):
            paths.append(Path(os.environ[var]).expanduser())
    return sorted({form for path in paths for form in (os.path.abspath(path), os.path.realpath(path))})


def _is_secret_name(name: str) -> bool:
    name = name.lower()
    return (
        name == ".env"
        or name.startswith(".env.")
        or name.endswith((".pem", ".key"))
        or (name.startswith("client_secret") and name.endswith(".json"))
    )


def _refusal(path: Path) -> str | None:
    """A refusal message if `path`, as written or once symlinks and ".." are resolved, is a secret; else None."""
    # macOS volumes are case-insensitive by default, so ~/.SSH is ~/.ssh there.
    fold = str.lower if sys.platform == "darwin" else (lambda text: text)
    denied = [fold(d) for d in _denied_paths()]
    for candidate in {os.path.abspath(path), os.path.realpath(path)}:
        folded = fold(candidate)
        if _is_secret_name(os.path.basename(folded)) or any(
            folded == d or folded.startswith(d.rstrip(os.sep) + os.sep) for d in denied
        ):
            return f"Refused: {path} is a protected file (keys, tokens or credentials). jarvis can't read or write it."
    return None


def _read_txt(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _read_pdf(path: Path) -> str:
    if not _PDF_AVAILABLE:
        raise RuntimeError("PDF support needs `pip install pypdf`.")
    reader = PdfReader(str(path))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def _read_docx(path: Path) -> str:
    if not _DOCX_AVAILABLE:
        raise RuntimeError("DOCX support needs `pip install python-docx`.")
    document = docx.Document(str(path))
    return "\n".join(p.text for p in document.paragraphs)


def _read_csv(path: Path) -> str:
    with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        rows = list(csv.reader(fh))
    return "\n".join(", ".join(row) for row in rows)


_READERS = {".txt": _read_txt, ".md": _read_txt, ".pdf": _read_pdf, ".docx": _read_docx, ".csv": _read_csv}


@tool_threaded()
def file_read(path: str) -> str:
    """Read a local file and return its text.

    Supports .txt, .md, .pdf, .docx, and .csv. Files larger than ~100k
    characters are truncated to a preview with a note.

    Args:
        path: Path to the file to read.
    """
    p = Path(path).expanduser()
    refusal = _refusal(p)
    if refusal:
        return refusal
    if not p.exists():
        return f"File not found: {p}"
    reader = _READERS.get(p.suffix.lower())
    if reader is None:
        return f"Unsupported file type {p.suffix!r}. Supported: {', '.join(sorted(_READERS))}."
    try:
        text = reader(p)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to read {p}: {exc}"

    if len(text) > MAX_CHARS:
        return (
            f"[{p.name} is large ({len(text)} chars); showing the first {MAX_CHARS}.]\n\n"
            + text[:MAX_CHARS]
        )
    return text


@tool_threaded()
def file_write(path: str, content: str, overwrite: bool = False) -> str:
    """Write text to a local file.

    Supports .txt, .md, and .csv. Creates parent directories. Returns an error if
    the file already exists unless overwrite=true.

    Args:
        path: Destination path.
        content: Text content to write.
        overwrite: Set true to overwrite an existing file (default false).
    """
    p = Path(path).expanduser()
    refusal = _refusal(p)
    if refusal:
        return refusal
    suffix = p.suffix.lower()
    if suffix not in (".txt", ".csv", ".md"):
        return f"Unsupported write type {suffix!r}. Supported: .txt, .md, .csv."
    if p.exists() and not overwrite:
        return f"File already exists at {p}. Pass overwrite=true to replace it."
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        if suffix == ".csv":
            # Validate it parses as CSV, then write verbatim.
            list(csv.reader(io.StringIO(content)))
        p.write_text(content, encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        return f"Failed to write {p}: {exc}"
    return f"Wrote {len(content)} chars to {p}."
