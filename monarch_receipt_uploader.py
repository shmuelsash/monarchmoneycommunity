#!/usr/bin/env python3
"""
Monarch Money — Gmail Receipt -> Inbox Uploader (TrueNAS / Python)
=================================================================
Scans a Gmail mailbox (over IMAP) for grocery receipt emails and uploads each
PDF attachment to the Monarch Money *general receipt inbox*, where Monarch's AI
categorizes and matches it automatically (NOT attached to a specific transaction).

Uses `upload_receipt_to_inbox` from the monarchmoneycommunity library (PR #44).

WHY PYTHON ON YOUR OWN SERVER
  Monarch's login endpoint is behind Cloudflare, which blocks programmatic logins
  from datacenter IPs (Google Apps Script, etc.). Running from your home IP avoids
  that, so normal email/password + MFA login works.

----------------------------------------------------------------------
INSTALL (on TrueNAS, inside a venv)
  python3 -m venv ~/monarch-venv
  ~/monarch-venv/bin/pip install --upgrade pip
  ~/monarch-venv/bin/pip install \
    "git+https://github.com/shmuelsash/monarchmoneycommunity.git@feat/upload-receipt-to-inbox"

GMAIL APP PASSWORD
  Enable 2-Step Verification on your Google account, then create an App Password
  (Google Account -> Security -> App passwords). Use that 16-char password below,
  NOT your normal Gmail password.

CONFIG
  Set the environment variables below (recommended), or edit the defaults inline.
  Required: GMAIL_USER, GMAIL_APP_PASSWORD, MONARCH_EMAIL, MONARCH_PASSWORD.
  MONARCH_MFA_SECRET is the base32 authenticator setup key (needed only on the
  first run; after that the saved session file is reused).

RUN
  ~/monarch-venv/bin/python monarch_receipt_uploader.py

SCHEDULE (TrueNAS SCALE -> System Settings -> Advanced -> Cron Jobs, or crontab)
  Example, every day at 6am:
    0 6 * * *  /root/monarch-venv/bin/python /root/monarch_receipt_uploader.py >> /var/log/monarch_receipts.log 2>&1
----------------------------------------------------------------------
"""

import asyncio
import email
import imaplib
import logging
import os
import sys
from email.header import decode_header
from email.message import Message
from typing import List, Tuple

from monarchmoney import (
    LoginFailedException,
    MonarchMoney,
    RequestFailedException,
    RequireMFAException,
)

# ===================== CONFIG =====================
CONFIG = {
    # --- Gmail (IMAP) ---
    "gmail_user": os.environ.get("GMAIL_USER", "you@gmail.com"),
    "gmail_app_password": os.environ.get("GMAIL_APP_PASSWORD", "xxxxxxxxxxxxxxxx"),
    "imap_host": os.environ.get("IMAP_HOST", "imap.gmail.com"),
    "imap_port": int(os.environ.get("IMAP_PORT", "993")),
    "mailbox": os.environ.get("GMAIL_MAILBOX", "INBOX"),

    # Senders to scan and the earliest date (IMAP format: DD-Mon-YYYY).
    "senders": os.environ.get(
        "RECEIPT_SENDERS",
        "receipts@aisleonekosher.com,info@evergreenkosher.com,receipts@hivediscount.com",
    ).split(","),
    "since_date": os.environ.get("RECEIPT_SINCE", "01-May-2025"),

    # --- Monarch Money ---
    "monarch_email": os.environ.get("MONARCH_EMAIL", "you@example.com"),
    "monarch_password": os.environ.get("MONARCH_PASSWORD", "your-monarch-password"),
    "monarch_mfa_secret": os.environ.get("MONARCH_MFA_SECRET", ""),  # base32 setup key
    "session_file": os.environ.get(
        "MONARCH_SESSION_FILE",
        os.path.expanduser("~/.monarch/mm_session.pickle"),
    ),

    # --- Behavior ---
    # Trash the email once all of its PDFs upload successfully (matches the old
    # "delete after download" behavior). If False, emails are left untouched.
    "trash_on_success": os.environ.get("TRASH_ON_SUCCESS", "true").lower() == "true",
}
# ==================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("monarch-receipts")


# ----------------------- Gmail / IMAP -----------------------

def _decode(value: str) -> str:
    """Decode a possibly RFC2047-encoded header value to a plain string."""
    if not value:
        return ""
    parts = decode_header(value)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            out.append(text.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def extract_pdf_attachments(msg: Message) -> List[Tuple[str, bytes]]:
    """Return [(filename, bytes), ...] for every PDF attachment in the message."""
    pdfs = []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        filename = _decode(part.get_filename() or "")
        ctype = (part.get_content_type() or "").lower()
        is_pdf = ctype == "application/pdf" or filename.lower().endswith(".pdf")
        if not is_pdf:
            continue
        payload = part.get_payload(decode=True)
        if payload:
            pdfs.append((filename or "receipt.pdf", payload))
    return pdfs


def search_uids(imap: imaplib.IMAP4_SSL, senders: List[str], since: str) -> List[bytes]:
    """Search the mailbox for messages from any sender since the given date."""
    uids = set()
    for sender in senders:
        sender = sender.strip()
        if not sender:
            continue
        typ, data = imap.uid("SEARCH", None, "FROM", sender, "SINCE", since)
        if typ == "OK" and data and data[0]:
            uids.update(data[0].split())
    return sorted(uids, key=lambda u: int(u))


def fetch_message(imap: imaplib.IMAP4_SSL, uid: bytes) -> Message:
    """Fetch a message WITHOUT marking it as read (BODY.PEEK)."""
    typ, data = imap.uid("FETCH", uid, "(BODY.PEEK[])")
    if typ != "OK" or not data or not data[0]:
        raise RuntimeError(f"Failed to fetch message uid={uid!r}")
    raw = data[0][1]
    return email.message_from_bytes(raw)


def move_to_trash(imap: imaplib.IMAP4_SSL, uid: bytes) -> None:
    """Move a message to Gmail Trash via the X-GM-LABELS extension."""
    imap.uid("STORE", uid, "+X-GM-LABELS", "(\\Trash)")


def mark_unread(imap: imaplib.IMAP4_SSL, uid: bytes) -> None:
    """Ensure a message is marked unread so it stays visible for review."""
    imap.uid("STORE", uid, "-FLAGS", "(\\Seen)")


# ----------------------- Monarch -----------------------

async def monarch_login() -> MonarchMoney:
    """Login to Monarch, reusing a saved session when available."""
    os.makedirs(os.path.dirname(CONFIG["session_file"]), exist_ok=True)
    mm = MonarchMoney(session_file=CONFIG["session_file"])
    try:
        await mm.login(
            email=CONFIG["monarch_email"],
            password=CONFIG["monarch_password"],
            mfa_secret_key=CONFIG["monarch_mfa_secret"] or None,
            use_saved_session=True,
            save_session=True,
        )
    except (LoginFailedException, RequireMFAException, RequestFailedException) as e:
        # Saved session may be stale; wipe it and try a fresh login once.
        log.warning("Login with saved session failed (%s); retrying fresh login.", e)
        try:
            mm.delete_session(CONFIG["session_file"])
        except Exception:
            pass
        mm = MonarchMoney(session_file=CONFIG["session_file"])
        await mm.login(
            email=CONFIG["monarch_email"],
            password=CONFIG["monarch_password"],
            mfa_secret_key=CONFIG["monarch_mfa_secret"] or None,
            use_saved_session=False,
            save_session=True,
        )
    return mm


# ----------------------- Main -----------------------

async def main() -> int:
    log.info("Connecting to Gmail IMAP %s ...", CONFIG["imap_host"])
    imap = imaplib.IMAP4_SSL(CONFIG["imap_host"], CONFIG["imap_port"])
    imap.login(CONFIG["gmail_user"], CONFIG["gmail_app_password"])
    imap.select(CONFIG["mailbox"])

    try:
        uids = search_uids(imap, CONFIG["senders"], CONFIG["since_date"])
        log.info("Found %d matching email(s).", len(uids))
        if not uids:
            return 0

        log.info("Logging into Monarch Money ...")
        mm = await monarch_login()

        uploaded = failed = 0
        for uid in uids:
            try:
                msg = fetch_message(imap, uid)
            except Exception as e:
                log.error("Skipping uid=%s: %s", uid.decode(), e)
                continue

            subject = _decode(msg.get("Subject", ""))
            pdfs = extract_pdf_attachments(msg)

            if not pdfs:
                log.info("No PDF in '%s' — marking unread.", subject)
                mark_unread(imap, uid)
                continue

            all_ok = True
            for filename, content in pdfs:
                try:
                    await mm.upload_receipt_to_inbox(
                        file_content=content,
                        filename=filename,
                    )
                    uploaded += 1
                    log.info("Uploaded '%s' (from '%s').", filename, subject)
                except Exception as e:
                    all_ok = False
                    failed += 1
                    log.error("FAILED '%s' (from '%s'): %s", filename, subject, e)

            if all_ok and CONFIG["trash_on_success"]:
                move_to_trash(imap, uid)
            else:
                mark_unread(imap, uid)

        log.info("Done. Uploaded: %d, Failed: %d", uploaded, failed)
        return 0 if failed == 0 else 1
    finally:
        try:
            imap.close()
        except Exception:
            pass
        imap.logout()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
