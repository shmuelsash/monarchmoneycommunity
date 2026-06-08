# Monarch Money — Gmail Receipt → Inbox Uploader (TrueNAS)

Scans a Gmail mailbox over IMAP for grocery receipt emails and uploads each PDF
attachment to the **Monarch Money general receipt inbox**, where Monarch's AI
categorizes and matches it automatically (it is *not* attached to a specific
transaction). Uses `upload_receipt_to_inbox` from the monarchmoneycommunity
library (PR #44).

Running this on your own server (TrueNAS) uses your home IP, which avoids the
Cloudflare block that prevents programmatic login from datacenter IPs (e.g.
Google Apps Script).

## What's in this folder

| File | Purpose |
|------|---------|
| `monarch_receipt_uploader.py` | The uploader script |
| `requirements.txt` | Installs the library from the PR branch |
| `install.sh` | Creates a venv and installs dependencies |
| `run.sh` | Loads `.env` and runs the script via the venv |
| `.env.example` | Template for your credentials/config |

## Prerequisites

1. **Gmail App Password** — enable 2-Step Verification on your Google account,
   then create an App Password (Google Account → Security → App passwords). Use
   that 16-character password, **not** your normal Gmail password.
2. **Monarch MFA setup key** (if you use 2FA) — the base32 "setup key" shown when
   you enable an authenticator app (e.g. `JBSWY3DPEHPK3PXP`). Needed only on the
   first run.

## Install (on TrueNAS)

Copy this folder to the server (e.g. `/root/truenas-receipt-uploader`), then:

```bash
cd /root/truenas-receipt-uploader
chmod +x install.sh run.sh
./install.sh
cp .env.example .env
nano .env          # fill in your values
chmod 600 .env     # keep secrets private
```

## First run (interactive — clears MFA, saves session)

```bash
./run.sh
```

This logs in, completes MFA, and writes a session file (default
`/root/.monarch/mm_session.pickle`) so later runs don't need MFA.

## Schedule it

TrueNAS SCALE → **System Settings → Advanced → Cron Jobs**, or a crontab entry.
Example — every day at 6am:

```
0 6 * * *  /root/truenas-receipt-uploader/run.sh >> /var/log/monarch_receipts.log 2>&1
```

## Behavior

- Searches the configured senders since `RECEIPT_SINCE`, reading messages without
  marking them read.
- Uploads every PDF attachment to the Monarch inbox.
- If all PDFs in an email upload successfully → the email is moved to Gmail Trash
  (set `TRASH_ON_SUCCESS=false` to disable).
- If an email has no PDF, or any upload fails → it's marked unread so it stays
  visible and gets retried next run.

## Notes

- **PR #44 isn't merged yet**, so `requirements.txt` pins the library to that
  branch. Once it merges upstream, change that line to `monarchmoneycommunity`.
- Programmatic Monarch logins can occasionally hit a CAPTCHA. The saved session
  keeps login frequency low. If login starts failing, delete the session file and
  run interactively once to refresh it.
- Keep `.env` private; it contains your Gmail app password and Monarch password.
