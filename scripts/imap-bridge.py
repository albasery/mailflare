#!/usr/bin/env python3
"""Read-only, one-way IMAP inbox delivery to Mailflare's signed inbound API.

Uses only Python's standard library. Configuration contains credentials and must
be kept outside git. Never changes source flags, folders or messages.
"""
import argparse
import email.parser
import email.policy
import email.utils
import hashlib
import hmac
import http.client
import imaplib
import json
import logging
import os
from pathlib import Path
import re
import signal
import sqlite3
import ssl
import threading
import time
import urllib.parse

LOG = logging.getLogger("mailflare-imap-bridge")
MAX_BYTES = 25 * 1024 * 1024
STOP = threading.Event()


def load_config(path):
    config = json.loads(Path(path).read_text())
    for key in ("imap_host", "imap_username", "imap_password", "recipient", "mailflare_url", "inbound_secret", "state_path"):
        if not isinstance(config.get(key), str) or not config[key]:
            raise ValueError("Missing configuration field: " + key)
    target = urllib.parse.urlsplit(config["mailflare_url"])
    if target.username or target.password or target.query or target.fragment or target.path not in ("", "/"):
        raise ValueError("mailflare_url must be an origin without credentials")
    if target.scheme != "https" and not (target.scheme == "http" and target.hostname in ("127.0.0.1", "::1", "localhost")):
        raise ValueError("Use HTTPS or an HTTP loopback target")
    if not re.fullmatch(r"[^\s<>@]+@[^\s<>@]+", config["recipient"], flags=re.ASCII) or not config["recipient"].isascii():
        raise ValueError("Invalid recipient")
    config.setdefault("imap_port", 993)
    config.setdefault("folder", "INBOX")
    config.setdefault("poll_seconds", 30)
    if int(config["poll_seconds"]) < 10:
        raise ValueError("poll_seconds must be at least 10")
    if config["folder"] != "INBOX":
        raise ValueError("This bridge only mirrors INBOX")
    return config


def request(config, path, body=None, headers=None):
    """No redirects or proxy environment: credentials never follow a redirect."""
    target = urllib.parse.urlsplit(config["mailflare_url"])
    if target.scheme == "https":
        conn = http.client.HTTPSConnection(target.hostname, target.port, timeout=60, context=ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(target.hostname, target.port, timeout=60)
    try:
        conn.request("POST" if body is not None else "GET", path, body=body, headers=headers or {})
        response = conn.getresponse()
        data = response.read(65537)
        if len(data) > 65536:
            raise ValueError("Unexpected large API response")
        return response.status, json.loads(data)
    finally:
        conn.close()


def ready(config):
    status, body = request(config, "/api/setup/status")
    domain = body.get("primaryDomain") or {}
    if status != 200 or not body.get("hasAdminAccount") or domain.get("hostname") != config["recipient"].split("@", 1)[1]:
        raise RuntimeError("Configure the matching Mailflare administrator and domain first")


def signed_headers(config, raw, timestamp=None):
    message = email.parser.BytesHeaderParser(policy=email.policy.default).parsebytes(raw)
    sender = email.utils.parseaddr(str(message.get("Return-Path") or message.get("From") or ""))[1]
    if not re.fullmatch(r"[^\s<>@]+@[^\s<>@]+", sender, flags=re.ASCII) or not sender.isascii():
        sender = "postmaster@" + config["recipient"].split("@", 1)[1]
    # Subject is the only advisory header needed for routing. Never assert that
    # untrusted Authentication-Results or forwarding markers have been verified.
    metadata = json.dumps({"subject": str(message.get("Subject", ""))[:1000]}, ensure_ascii=True, separators=(",", ":"))
    stamp = str(int(time.time()) if timestamp is None else timestamp)
    prefix = f"v2\n{stamp}\n{sender}\n{config['recipient']}\n{metadata}\n".encode()
    signature = hmac.new(config["inbound_secret"].encode(), prefix + raw, hashlib.sha256).hexdigest()
    return {"Content-Type": "message/rfc822", "x-mailflare-from": sender,
            "x-mailflare-to": config["recipient"], "x-mailflare-headers": metadata,
            "x-mailflare-timestamp": stamp, "x-mailflare-signature": signature}


def deliver(config, raw):
    status, result = request(config, "/api/inbound", raw, signed_headers(config, raw))
    if status != 200 or result.get("action") != "store" or result.get("forwardTo") or result.get("forwardedTo"):
        # A 200 rejection/forward is not a successful mailbox delivery. Do not
        # expose server response bodies, sender names or message subjects in logs.
        raise RuntimeError("Inbound delivery not acknowledged: HTTP " + str(status))


def open_state(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("CREATE TABLE IF NOT EXISTS deliveries (source TEXT, validity TEXT, uid INTEGER, status TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, PRIMARY KEY(source,validity,uid))")
    db.execute("CREATE TABLE IF NOT EXISTS health (id INTEGER PRIMARY KEY CHECK(id=1), polled INTEGER NOT NULL)")
    db.commit()
    return db


def remember(db, source, validity, uid, status):
    db.execute("INSERT INTO deliveries VALUES (?,?,?,?,?,?) ON CONFLICT(source,validity,uid) DO UPDATE SET status=excluded.status,failures=deliveries.failures+excluded.failures,updated=excluded.updated", (source, validity, uid, status, int(status != "delivered"), int(time.time())))
    db.commit()


def poll(config, db, client_factory=imaplib.IMAP4_SSL, delivery=deliver):
    source = hashlib.sha256(json.dumps([config["imap_host"], config["imap_username"], "INBOX", config["recipient"]]).encode()).hexdigest()
    with client_factory(config["imap_host"], int(config["imap_port"]), ssl_context=ssl.create_default_context(), timeout=30) as client:
        client.login(config["imap_username"], config["imap_password"])
        status, _ = client.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("Cannot examine source INBOX")
        _, value = client.response("UIDVALIDITY")
        validity = value[0].decode() if value and value[0] else ""
        if not validity.isdecimal():
            raise RuntimeError("Source did not provide UIDVALIDITY")
        status, data = client.uid("SEARCH", None, "ALL")
        if status != "OK":
            raise RuntimeError("Cannot enumerate source INBOX")
        uids = [int(uid) for uid in (data[0] or b"").split()]
        completed = {row[0] for row in db.execute("SELECT uid FROM deliveries WHERE source=? AND validity=? AND status='delivered'", (source, validity))}
        delivered = failed = 0
        for uid in uids:
            if STOP.is_set():
                break
            if uid in completed:
                continue
            try:
                status, info = client.uid("FETCH", str(uid), "(RFC822.SIZE)")
                metadata = b" ".join(part for part in info if isinstance(part, bytes))
                size = re.search(rb"RFC822\.SIZE (\d+)", metadata)
                if status != "OK" or size is None:
                    raise RuntimeError("Cannot inspect source size")
                if int(size.group(1)) > MAX_BYTES:
                    raise ValueError("Message exceeds inbound size limit")
                status, parts = client.uid("FETCH", str(uid), "(BODY.PEEK[])")
                raw_parts = [part[1] for part in parts if isinstance(part, tuple) and isinstance(part[1], bytes)]
                if status != "OK" or len(raw_parts) != 1:
                    raise RuntimeError("Source message was not returned")
                raw = raw_parts[0]
                if not raw or len(raw) > MAX_BYTES:
                    raise ValueError("Invalid message size")
                delivery(config, raw)
                remember(db, source, validity, uid, "delivered")
                delivered += 1
            except Exception as error:
                remember(db, source, validity, uid, "retry")
                failed += 1
                LOG.warning("Message UID %s retained at source; retry pending (%s)", uid, type(error).__name__)
        db.execute("INSERT INTO health VALUES(1,?) ON CONFLICT(id) DO UPDATE SET polled=excluded.polled", (int(time.time()),))
        db.commit()
        LOG.info("Inbox poll: %s delivered, %s pending retry", delivered, failed)
        return delivered, failed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = load_config(args.config)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: STOP.set())
    with open_state(config["state_path"]) as db:
        while not STOP.is_set():
            try:
                ready(config)
                _, failed = poll(config, db)
                if args.once:
                    return int(failed > 0)
            except Exception as error:
                LOG.error("Inbox poll failed (%s); source mailbox unchanged", type(error).__name__)
                if args.once:
                    return 1
            STOP.wait(int(config["poll_seconds"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
