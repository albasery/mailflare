# Keep an existing mail provider

`scripts/imap-bridge.py` copies an existing IMAP INBOX into a self-hosted
Mailflare mailbox. Use the provider's SMTP relay for outgoing mail. MX, SPF,
DKIM and DMARC remain with the provider; no forwarding rule is required.

This is one-way inbox delivery, **not** bidirectional mailbox synchronization.
It copies existing and newly arriving INBOX messages. Source read/unread flags,
folders and deletions are never changed. Changes made in Mailflare are not sent
back, and Mailflare's Sent folder is not copied to the provider. Archive, Spam
and other source folders are not imported by this bridge. A provider account
and any applicable subscription must remain active.

## Setup

Requires Python 3.10+ and a configured Mailflare mailbox on the primary domain.
Set a random `INBOUND_WEBHOOK_SECRET` and `INBOUND_REQUIRE_SIGNED_HEADERS=1` in
Mailflare's runtime. Keep the inbound endpoint private when the bridge and
Mailflare run on the same host. Configure SMTP_URL separately for outgoing mail.

Store the following configuration outside the repository, readable only by
the bridge service account. Never put actual credentials in git or shell history.

```json
{
  "imap_host": "imap.example.com",
  "imap_port": 993,
  "imap_username": "hello@example.com",
  "imap_password": "ENTER_PRIVATELY",
  "recipient": "hello@example.com",
  "mailflare_url": "http://127.0.0.1:13080",
  "inbound_secret": "SAME_AS_MAILFLARE_RUNTIME",
  "state_path": "/var/lib/mailflare-bridge/state.sqlite",
  "poll_seconds": 30
}
```

Run a first poll with `python3 scripts/imap-bridge.py /path/to/config.json --once`.
The systemd unit in `deploy/imap-bridge` is an example for `/opt/mailflare` and
`/etc/mailflare/imap-bridge.json`. Create a dedicated `mailflare-bridge` system
account before installing it. Do not start it before the destination mailbox
exists. Disable Mailflare forwarding and auto-reply rules during initial import
to avoid unexpected external sends from historical messages.

IMAP uses certificate-verified implicit TLS and EXAMINE/BODY.PEEK. HTTP delivery
uses Mailflare's timestamped v2 HMAC signature and never follows redirects.
Only an acknowledged `store` response advances the durable per-UID state.
Retries survive restarts; Mailflare's raw-content deduplication handles an
ambiguous acknowledgement. UIDVALIDITY changes cause a fresh scan instead of
skipping reused UIDs. Keep only one bridge process for a configuration/state DB.

Messages over the API's 25 MiB limit, API rejections and transport failures stay
at the provider and remain marked for retry. They do not prevent later messages
from being copied. Inspect `journalctl -u mailflare-imap-bridge` and the SQLite
`deliveries` table for pending retries; investigate repeated failures rather
than marking them delivered manually. Logs contain UID/count/error class only,
not raw messages, response bodies, subjects or credentials. Back up the bridge
state and configuration with the Mailflare data, keeping credentials private.
