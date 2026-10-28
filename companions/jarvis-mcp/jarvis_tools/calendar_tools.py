"""Google Calendar tools: calendar_get, calendar_create, calendar_delete.

Shares the OAuth2 token with the Gmail tools via jarvis_tools.google_auth. Both
register unconditionally and return setup instructions when Google isn't set up.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from app import tool_threaded
from jarvis_tools.google_auth import GoogleSetupError, get_service


def _local_tz_name() -> str:
    """Best-effort IANA timezone name for this machine, e.g. 'America/New_York'.

    Falls back to 'UTC' if it can't be determined (Google's API requires an
    explicit `timeZone` field whenever a dateTime has no UTC offset of its own).
    """
    try:
        target = os.readlink("/etc/localtime")
        return target.split("zoneinfo/", 1)[1]
    except (OSError, IndexError):
        return "UTC"


def _parse_dt(value: str) -> tuple[str, bool]:
    """Normalise a user-supplied datetime into RFC3339 for the API.

    Accepts ISO 8601 (with or without timezone). Returns (value, is_naive) —
    naive values need an explicit `timeZone` field alongside them, since the
    Calendar API rejects a dateTime with neither an offset nor a timeZone.
    Raises ValueError if unparseable.
    """
    value = (value or "").strip()
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value, parsed.tzinfo is None


def fetch_events_range(time_min_iso: str, time_max_iso: str) -> list[dict]:
    """Return events between two RFC3339 timestamps as structured dicts. Retries once."""
    last_exc = None
    for _attempt in range(2):
        try:
            service = get_service("calendar", "v3")
            events = (
                service.events()
                .list(
                    calendarId="primary",
                    timeMin=time_min_iso,
                    timeMax=time_max_iso,
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=250,
                )
                .execute()
            )
            out = []
            for ev in events.get("items", []):
                out.append(
                    {
                        "id": ev.get("id", ""),
                        "title": ev.get("summary", "(no title)"),
                        "start": ev.get("start", {}).get("dateTime") or ev.get("start", {}).get("date", ""),
                        "end": ev.get("end", {}).get("dateTime") or ev.get("end", {}).get("date", ""),
                        "where": ev.get("location") or ev.get("description") or "",
                    }
                )
            return out
        except GoogleSetupError:
            raise
        except Exception as exc:  # noqa: BLE001 - retry once on transient network errors
            last_exc = exc
    raise last_exc


def fetch_events(days: int = 7) -> list[dict]:
    """Return upcoming events (now → now+days) as structured dicts."""
    now = datetime.now(timezone.utc)
    return fetch_events_range(now.isoformat(), (now + timedelta(days=max(1, int(days or 7)))).isoformat())


@tool_threaded()
def calendar_get(days: int = 7) -> str:
    """Get the user's upcoming Google Calendar events within the next N days.

    Returns title, start, end, and location/description.

    Args:
        days: Look-ahead window in days (default 7).
    """
    try:
        items = fetch_events(int(days or 7))
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to fetch calendar events: {exc}"

    if not items:
        return f"No events in the next {days} day(s)."
    lines = []
    for i, ev in enumerate(items, 1):
        line = f"{i}. {ev['title']} (id: {ev['id']})\n   {ev['start']} → {ev['end']}"
        if ev["where"]:
            line += f"\n   {ev['where']}"
        lines.append(line)
    return "\n".join(lines)


@tool_threaded()
def calendar_create(title: str, start: str, end: str, description: str = "") -> str:
    """Create an event on the user's primary Google Calendar.

    Start and end must be ISO 8601 datetimes (e.g. 2026-06-10T14:00:00). Confirm
    details with the user if anything is ambiguous before creating.

    Args:
        title: Event title.
        start: Start datetime, ISO 8601.
        end: End datetime, ISO 8601.
        description: Optional event description.
    """
    try:
        start_n, start_naive = _parse_dt(start)
        end_n, end_naive = _parse_dt(end)
    except ValueError:
        return "Invalid datetime. Use ISO 8601, e.g. 2026-06-10T14:00:00."
    start_body: dict[str, str] = {"dateTime": start_n}
    end_body: dict[str, str] = {"dateTime": end_n}
    if start_naive or end_naive:
        tz = _local_tz_name()
        start_body["timeZone"] = tz
        end_body["timeZone"] = tz
    try:
        service = get_service("calendar", "v3")
        body = {
            "summary": title,
            "description": description or "",
            "start": start_body,
            "end": end_body,
        }
        created = service.events().insert(calendarId="primary", body=body).execute()
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to create event: {exc}"
    return (
        f"Created event '{title}' ({start_n} → {end_n}). "
        f"Link: {created.get('htmlLink', 'n/a')} (id: {created.get('id', 'n/a')})"
    )


@tool_threaded()
def calendar_delete(event_id: str) -> str:
    """Delete an event from the user's primary Google Calendar.

    Use calendar_get first to find the event's id. Confirm with the user before
    deleting unless they've clearly identified the specific event.

    Args:
        event_id: The Google Calendar event id, as shown in calendar_get's output.
    """
    try:
        service = get_service("calendar", "v3")
        service.events().delete(calendarId="primary", eventId=event_id).execute()
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        if "404" in message or "410" in message:
            return f"Event '{event_id}' was already deleted or does not exist."
        return f"Failed to delete event: {exc}"
    return f"Deleted event '{event_id}'."
