"""Gmail tools: email_read, email_send, email_delete.

Uses the shared OAuth2 flow in jarvis_tools.google_auth (same token as calendar).
Both register unconditionally; if Google isn't installed/configured they return
clear setup instructions when called rather than crashing.

Note: JARVIS's email_summarize is intentionally not ported — in Claude Code,
Claude reads the inbox via email_read and summarizes it itself.
"""
from __future__ import annotations

import base64
from email.mime.text import MIMEText

from app import tool_threaded
from jarvis_tools.google_auth import GoogleSetupError, get_service


def _header(headers: list[dict], name: str) -> str:
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _fetch_inbox(n: int) -> list[dict[str, str]]:
    """Return the n most recent inbox messages as dicts. May raise GoogleSetupError."""
    service = get_service("gmail", "v1")
    listing = (
        service.users()
        .messages()
        .list(userId="me", labelIds=["INBOX"], maxResults=max(1, n))
        .execute()
    )
    out: list[dict[str, str]] = []
    for ref in listing.get("messages", []):
        msg = (
            service.users()
            .messages()
            .get(
                userId="me",
                id=ref["id"],
                format="metadata",
                metadataHeaders=["From", "Subject", "Date"],
            )
            .execute()
        )
        headers = msg.get("payload", {}).get("headers", [])
        out.append(
            {
                "id": ref["id"],
                "from": _header(headers, "From"),
                "subject": _header(headers, "Subject") or "(no subject)",
                "date": _header(headers, "Date"),
                "snippet": msg.get("snippet", ""),
            }
        )
    return out


@tool_threaded()
def email_read(n: int = 10) -> str:
    """Read the most recent emails from the user's Gmail inbox.

    Returns sender, subject, date, id, and a snippet for each. The id can be
    passed to email_delete to trash a specific message.

    Args:
        n: How many recent emails to fetch (default 10).
    """
    try:
        emails = _fetch_inbox(int(n or 10))
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to read inbox: {exc}"
    if not emails:
        return "Inbox is empty (or no messages matched)."
    lines = []
    for i, e in enumerate(emails, 1):
        lines.append(
            f"{i}. From: {e['from']} (id: {e['id']})\n   Subject: {e['subject']}\n   {e['date']}\n   {e['snippet']}"
        )
    return "\n".join(lines)


@tool_threaded()
def email_send(to: str, subject: str, body: str) -> str:
    """Send an email from the user's Gmail account.

    Confirm the recipient, subject, and body with the user before sending if
    there's any ambiguity.

    Args:
        to: Recipient email address.
        subject: Email subject line.
        body: Plain-text email body.
    """
    try:
        service = get_service("gmail", "v1")
        mime = MIMEText(body)
        mime["to"] = to
        mime["subject"] = subject
        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
        sent = service.users().messages().send(userId="me", body={"raw": raw}).execute()
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return f"Failed to send email: {exc}"
    return f"Email sent to {to} (id {sent.get('id', '?')})."


@tool_threaded()
def email_delete(message_id: str) -> str:
    """Move an email to Gmail's Trash (recoverable there for 30 days, not permanent).

    Use email_read first to find the message's id. Confirm with the user before
    deleting unless they've clearly identified the specific email.

    Args:
        message_id: The Gmail message id to trash.
    """
    try:
        service = get_service("gmail", "v1")
        service.users().messages().trash(userId="me", id=message_id).execute()
    except GoogleSetupError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        if "404" in message:
            return f"Message '{message_id}' was not found (already deleted?)."
        return f"Failed to delete email: {exc}"
    return f"Moved message '{message_id}' to Trash."
