"""Lecture recording + live local transcription + Google Docs note-filing.

Records the mic continuously in rolling chunks, transcribes each chunk
locally via faster-whisper (audio never leaves the machine), and exposes the
growing transcript through a byte-offset checkpoint so a caller invoked
periodically (Claude, via a /loop during class) can pull only the new text,
turn it into structured notes, and append those notes to the class's running
Google Doc. Only one lecture can be recorded at a time.

Course -> Doc/folder mapping lives in the same courses.json the
brightspace-todo skill maintains (BrightspaceToDo/courses.json), extended
with "googleDocId" / "driveFolderId" fields per course.
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import signal
import threading
from datetime import datetime
from pathlib import Path

from app import tool_threaded
from jarvis_tools.google_auth import GoogleSetupError, get_service

log = logging.getLogger("jarvis-mcp.lecture_notes")

BASE_DIR = Path.home() / "LectureNotes"
COURSES_PATH = Path.home() / "BrightspaceToDo" / "courses.json"
HEADERS_PATH = BASE_DIR / "headers_written.json"

SAMPLERATE = 16000
BLOCK_SECONDS = 0.5      # audio callback granularity
CHUNK_SECONDS = 20       # how much audio to batch before transcribing
WHISPER_MODEL_NAME = "base.en"

_model = None
_model_lock = threading.Lock()


def _get_model():
    """Lazily load the local Whisper model once, shared across sessions."""
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel

            _model = WhisperModel(WHISPER_MODEL_NAME, device="cpu", compute_type="int8")
        return _model


def _load_courses() -> list[dict]:
    if not COURSES_PATH.exists():
        return []
    return json.loads(COURSES_PATH.read_text()).get("courses", [])


def _save_courses(courses: list[dict]) -> None:
    data = json.loads(COURSES_PATH.read_text())
    data["courses"] = courses
    COURSES_PATH.write_text(json.dumps(data, indent=2) + "\n")


def _resolve_course(course_code: str) -> dict:
    """Match a course code exactly, or fall back to a name substring match."""
    courses = _load_courses()
    needle = course_code.strip().lower()
    for c in courses:
        if c["code"].lower() == needle:
            return c
    for c in courses:
        if needle in c["name"].lower():
            return c
    available = ", ".join(c["code"] for c in courses) or "(none tracked yet)"
    raise ValueError(f"Unknown course {course_code!r}. Known courses: {available}")


class _Session:
    def __init__(self, course: dict):
        self.course = course
        self.started_at = datetime.now()
        self.session_dir = BASE_DIR / "sessions" / f"{course['code']}-{self.started_at:%Y%m%d-%H%M%S}"
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.transcript_path = self.session_dir / "transcript.txt"
        self.transcript_path.touch()
        self.read_offset = 0
        self.transcript_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.error: str | None = None


_session: _Session | None = None
_session_lock = threading.Lock()


def _flush_chunk(session: _Session, blocks: list, chunk_index: int) -> None:
    import numpy as np
    import soundfile as sf

    audio = np.concatenate(blocks, axis=0)
    chunk_path = session.session_dir / f"chunk_{chunk_index:04d}.wav"
    sf.write(str(chunk_path), audio, SAMPLERATE)

    try:
        model = _get_model()
        segments, _info = model.transcribe(str(chunk_path), vad_filter=True)
        text = " ".join(seg.text.strip() for seg in segments).strip()
    finally:
        chunk_path.unlink(missing_ok=True)

    if not text:
        return
    with session.transcript_lock:
        with session.transcript_path.open("a", encoding="utf-8") as f:
            f.write(text + " ")


def _record_loop(session: _Session) -> None:
    import sounddevice as sd

    q: "queue.Queue" = queue.Queue()

    def callback(indata, frames, time_info, status):
        q.put(indata.copy())

    buffer: list = []
    buffered_seconds = 0.0
    chunk_index = 0

    try:
        with sd.InputStream(
            samplerate=SAMPLERATE,
            channels=1,
            dtype="int16",
            blocksize=int(SAMPLERATE * BLOCK_SECONDS),
            callback=callback,
        ):
            while not session.stop_event.is_set():
                try:
                    block = q.get(timeout=1.0)
                except queue.Empty:
                    continue
                buffer.append(block)
                buffered_seconds += BLOCK_SECONDS
                if buffered_seconds >= CHUNK_SECONDS:
                    _flush_chunk(session, buffer, chunk_index)
                    chunk_index += 1
                    buffer = []
                    buffered_seconds = 0.0
            while not q.empty():
                buffer.append(q.get_nowait())
        if buffer:
            _flush_chunk(session, buffer, chunk_index)
    except Exception as exc:  # noqa: BLE001
        # The mic stream itself died (e.g. the machine slept and CoreAudio
        # dropped the device). Don't leave a phantom "recording" session
        # around forever -- log the failure into the transcript so it's
        # visible in the record, then clear the session so lecture_status()
        # reflects reality and a new lecture_start() isn't blocked.
        session.error = str(exc)
        log.warning("Lecture recording for %s stopped unexpectedly: %s", session.course["code"], exc)
        with session.transcript_lock:
            with session.transcript_path.open("a", encoding="utf-8") as f:
                f.write(f"\n[recording stopped unexpectedly: {exc}] ")
        global _session
        with _session_lock:
            if _session is session:
                _session = None


@tool_threaded()
def lecture_start(course_code: str) -> str:
    """Start recording + live-transcribing a lecture for the given class.

    Resolves course_code against your tracked course list (the same file the
    Brightspace sync uses) to find the class's Google Doc. Only one lecture
    can be recorded at a time. Call lecture_get_new_transcript() periodically
    while it runs, and lecture_stop() when class ends. If the course has no
    Doc set up yet, call lecture_bootstrap_course() first.

    Args:
        course_code: Course code (e.g. "ABC1234A") or a distinctive part of
            the course name.
    """
    global _session
    with _session_lock:
        if _session is not None:
            return (
                f"A lecture is already being recorded for {_session.course['code']} "
                f"(started {_session.started_at:%H:%M}). Call lecture_stop() first."
            )
        try:
            course = _resolve_course(course_code)
        except ValueError as exc:
            return str(exc)
        if not course.get("googleDocId"):
            return (
                f"{course['code']} doesn't have a lecture-notes Doc yet. "
                "Call lecture_bootstrap_course() for it first."
            )
        session = _Session(course)
        session.thread = threading.Thread(target=_record_loop, args=(session,), daemon=True)
        session.thread.start()
        _session = session
    return f"Recording started for {course['code']}: {course['name']}."


@tool_threaded()
def lecture_status() -> str:
    """Report whether a lecture recording is active and how much transcript is unread."""
    with _session_lock:
        session = _session
    if session is None:
        return "No lecture is currently being recorded."
    with session.transcript_lock:
        size = session.transcript_path.stat().st_size
    pending = size - session.read_offset
    note = f" (error: {session.error})" if session.error else ""
    return (
        f"Recording {session.course['code']} since {session.started_at:%H:%M}{note}. "
        f"{pending} unread transcript characters buffered."
    )


@tool_threaded()
def lecture_get_new_transcript() -> str:
    """Return lecture transcript text captured since the last call, and advance the checkpoint.

    Call this periodically while a lecture is recording (e.g. every few
    minutes) to pull newly transcribed text, turn it into structured notes,
    and append those notes to the class's Doc via docs_append_notes(). Never
    returns the same text twice.
    """
    with _session_lock:
        session = _session
    if session is None:
        return "No lecture is currently being recorded."
    with session.transcript_lock:
        with session.transcript_path.open("rb") as f:
            f.seek(session.read_offset)
            data = f.read()
        session.read_offset += len(data)
    text = data.decode("utf-8", errors="ignore").strip()
    return text or "(no new speech transcribed since last check)"


def _stop_recording(timeout: float = 30) -> tuple[str, str] | None:
    """Core stop logic shared by lecture_stop() and the shutdown handler below.

    Returns (course_code, final_unprocessed_text), or None if nothing was recording.
    """
    global _session
    with _session_lock:
        session = _session
        if session is None:
            return None
        session.stop_event.set()
    if session.thread is not None:
        session.thread.join(timeout=timeout)
    with session.transcript_lock:
        with session.transcript_path.open("rb") as f:
            f.seek(session.read_offset)
            data = f.read()
        session.read_offset += len(data)
    text = data.decode("utf-8", errors="ignore").strip()
    with _session_lock:
        if _session is session:
            _session = None
    return session.course["code"], text


@tool_threaded()
def lecture_stop() -> str:
    """Stop the active lecture recording and return any final unprocessed transcript.

    Call docs_append_notes() afterward if the returned text needs one last
    notes pass — this tool only stops capture and hands back what's left.
    """
    result = _stop_recording(timeout=30)
    if result is None:
        return "No lecture is currently being recorded."
    course_code, text = result
    suffix = f" Final unprocessed transcript:\n{text}" if text else ""
    return f"Stopped recording for {course_code}.{suffix}"


def _emergency_stop(reason: str) -> None:
    """Best-effort stop of any active recording when the process is shutting down
    (system shutdown/restart, the terminal/session closing, Ctrl-C, etc).

    Uses a short join timeout so it doesn't hold up process exit. The
    transcript file is already durable -- each finished chunk is flushed to
    disk as soon as it's transcribed -- so this mainly stops the mic stream
    cleanly and flushes whatever's left in the current buffer instead of
    leaving a phantom "recording" session behind.
    """
    result = _stop_recording(timeout=5)
    if result:
        course_code, _text = result
        log.warning("Stopped active lecture recording for %s: %s", course_code, reason)


def _handle_shutdown_signal(signum, _frame) -> None:
    _emergency_stop(f"received signal {signum}")
    # Restore default handling and re-raise so the process still exits promptly.
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


atexit.register(lambda: _emergency_stop("process exiting"))
for _sig in (signal.SIGTERM, signal.SIGINT):
    try:
        signal.signal(_sig, _handle_shutdown_signal)
    except (ValueError, OSError):
        pass  # not running on the main thread, or unsupported on this platform -- best effort only


def _ensure_folder(drive, name: str, parent_id: str | None) -> str:
    """Find or create a Drive folder by name (only sees folders this app created — drive.file scope)."""
    query = f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    if parent_id:
        query += f" and '{parent_id}' in parents"
    resp = drive.files().list(q=query, fields="files(id, name)").execute()
    files = resp.get("files", [])
    if files:
        return files[0]["id"]
    body = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent_id:
        body["parents"] = [parent_id]
    created = drive.files().create(body=body, fields="id").execute()
    return created["id"]


@tool_threaded()
def lecture_bootstrap_course(course_code: str) -> str:
    """Create a Drive folder + Google Doc for a class's running lecture notes.

    Creates a "Lecture Notes" parent folder (once) and a subfolder named
    after the course, then a Doc titled "{code} Lecture Notes" inside it.
    Records the ids in your tracked course list. Safe to call again for a
    course that already has a Doc — it's a no-op that returns the link.

    Args:
        course_code: Course code matching your tracked course list.
    """
    try:
        course = _resolve_course(course_code)
    except ValueError as exc:
        return str(exc)
    if course.get("googleDocId"):
        return f"{course['code']} already has a lecture-notes Doc: https://docs.google.com/document/d/{course['googleDocId']}/edit"

    try:
        drive = get_service("drive", "v3")
        docs = get_service("docs", "v1")

        parent_id = _ensure_folder(drive, "Lecture Notes", parent_id=None)
        course_folder_id = _ensure_folder(drive, course["code"], parent_id=parent_id)

        doc = docs.documents().create(body={"title": f"{course['code']} Lecture Notes"}).execute()
        doc_id = doc["documentId"]
        drive.files().update(
            fileId=doc_id,
            addParents=course_folder_id,
            fields="id, parents",
        ).execute()
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to bootstrap {course['code']}: {exc}"

    courses = _load_courses()
    for c in courses:
        if c["code"] == course["code"]:
            c["googleDocId"] = doc_id
            c["driveFolderId"] = course_folder_id
    _save_courses(courses)

    return f"Created lecture-notes Doc for {course['code']}: https://docs.google.com/document/d/{doc_id}/edit"


@tool_threaded()
def docs_append_notes(course_code: str, text: str) -> str:
    """Append notes text to the given class's running lecture-notes Google Doc.

    Inserts a dated section header ("=== Lecture: YYYY-MM-DD ===") before the
    first append of each calendar day, so notes from different lectures stay
    visually separated within the one running doc.

    Args:
        course_code: Course code matching your tracked course list.
        text: The notes text to append — already written/structured; this
            tool inserts it as-is, it does not summarize.
    """
    try:
        course = _resolve_course(course_code)
    except ValueError as exc:
        return str(exc)
    doc_id = course.get("googleDocId")
    if not doc_id:
        return f"{course['code']} doesn't have a lecture-notes Doc yet. Call lecture_bootstrap_course() first."

    today = datetime.now().strftime("%Y-%m-%d")
    day_key = f"{course['code']}:{today}"
    HEADERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    headers = json.loads(HEADERS_PATH.read_text()) if HEADERS_PATH.exists() else {}

    insert_text = ""
    if not headers.get(day_key):
        insert_text += f"\n\n=== Lecture: {today} ===\n\n"
        headers[day_key] = True
        HEADERS_PATH.write_text(json.dumps(headers, indent=2))
    insert_text += text.rstrip() + "\n"

    try:
        service = get_service("docs", "v1")
        service.documents().batchUpdate(
            documentId=doc_id,
            body={
                "requests": [
                    {"insertText": {"endOfSegmentLocation": {"segmentId": ""}, "text": insert_text}}
                ]
            },
        ).execute()
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to append notes: {exc}"
    return f"Appended {len(text)} chars of notes to {course['code']}'s lecture doc."


def _extract_text_range(doc: dict, start_index: int, end_index: int) -> str:
    """Reconstruct the plain text between two document indices from the Docs structural content."""
    out = []
    for el in doc["body"]["content"]:
        paragraph = el.get("paragraph")
        if not paragraph:
            continue
        for run in paragraph.get("elements", []):
            text_run = run.get("textRun")
            if not text_run:
                continue
            run_start, run_end = run["startIndex"], run["endIndex"]
            if run_end <= start_index or run_start >= end_index:
                continue
            content = text_run["content"]
            clip_start = max(0, start_index - run_start)
            clip_end = min(len(content), end_index - run_start)
            out.append(content[clip_start:clip_end])
    return "".join(out)


def _find_section_range(doc: dict, date_str: str) -> tuple[int, int] | None:
    """Return (start_index, end_index) for the "=== Lecture: DATE ===" section.

    A section runs from its header paragraph up to (not including) the next
    lecture header, or to the end of the document if it's the last one.
    """
    body = doc["body"]["content"]
    headers = []  # (startIndex, header text) for every lecture-date header, in order
    for el in body:
        paragraph = el.get("paragraph")
        if not paragraph:
            continue
        text = "".join(r.get("textRun", {}).get("content", "") for r in paragraph.get("elements", []))
        if text.strip().startswith("=== Lecture:"):
            headers.append((el["startIndex"], text.strip()))

    target = next((i for i, (_, text) in enumerate(headers) if f"Lecture: {date_str}" in text), None)
    if target is None:
        return None
    start_index = headers[target][0]
    end_index = headers[target + 1][0] if target + 1 < len(headers) else body[-1]["endIndex"] - 1
    return start_index, end_index


@tool_threaded()
def docs_read_section(course_code: str, date: str = "") -> str:
    """Read back raw notes text for one lecture date (or the whole doc) from a class's Google Doc.

    Use this before cleaning up/reorganizing notes: read the raw section,
    rewrite it into better-structured notes, then call docs_replace_section()
    with the result.

    Args:
        course_code: Course code matching your tracked course list.
        date: Lecture date as YYYY-MM-DD, matching an existing "=== Lecture: DATE ==="
            header. Omit to get the full document text instead.
    """
    try:
        course = _resolve_course(course_code)
    except ValueError as exc:
        return str(exc)
    doc_id = course.get("googleDocId")
    if not doc_id:
        return f"{course['code']} doesn't have a lecture-notes Doc yet."

    try:
        docs = get_service("docs", "v1")
        doc = docs.documents().get(documentId=doc_id).execute()
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to read doc: {exc}"

    if not date:
        body = doc["body"]["content"]
        end_index = body[-1]["endIndex"] - 1 if body else 1
        return _extract_text_range(doc, 0, end_index) or "(doc is empty)"

    section = _find_section_range(doc, date)
    if section is None:
        return f"No lecture section found for {date} in {course['code']}'s doc."
    return _extract_text_range(doc, *section)


@tool_threaded()
def docs_replace_section(course_code: str, date: str, new_text: str) -> str:
    """Replace one lecture date's section in a class's Doc with cleaned-up text.

    Finds the section bounded by "=== Lecture: DATE ===" and the next such
    header (or end of doc), deletes it, and inserts new_text in its place.
    Include your own "=== Lecture: DATE ===" header line at the top of
    new_text if you want the section to keep one.

    Args:
        course_code: Course code matching your tracked course list.
        date: Lecture date as YYYY-MM-DD, matching an existing section header.
        new_text: The replacement text for that section.
    """
    try:
        course = _resolve_course(course_code)
    except ValueError as exc:
        return str(exc)
    doc_id = course.get("googleDocId")
    if not doc_id:
        return f"{course['code']} doesn't have a lecture-notes Doc yet."

    try:
        docs = get_service("docs", "v1")
        doc = docs.documents().get(documentId=doc_id).execute()
        section = _find_section_range(doc, date)
        if section is None:
            return f"No lecture section found for {date} in {course['code']}'s doc."
        start_index, end_index = section
        requests = [
            {"deleteContentRange": {"range": {"startIndex": start_index, "endIndex": end_index}}},
            {"insertText": {"location": {"index": start_index}, "text": new_text.rstrip() + "\n"}},
        ]
        docs.documents().batchUpdate(documentId=doc_id, body={"requests": requests}).execute()
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to replace section: {exc}"
    return f"Replaced {course['code']}'s {date} section with cleaned-up notes ({len(new_text)} chars)."
