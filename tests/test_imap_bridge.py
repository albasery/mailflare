import importlib.util
import json
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bridge", ROOT / "scripts/imap-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
RAW = b"Return-Path: <sender@example.test>\r\nSubject: sample\r\n\r\nmessage"


class FakeImap:
    validity = b"10"
    messages = {1: RAW, 2: RAW + b"2"}
    calls = []

    def __init__(self, host, port, ssl_context, timeout):
        assert ssl_context.verify_mode == ssl.CERT_REQUIRED
        assert ssl_context.check_hostname

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def login(self, username, password):
        return "OK", []

    def select(self, folder, readonly):
        assert folder == "INBOX" and readonly is True
        return "OK", []

    def response(self, name):
        return name, [self.validity]

    def uid(self, command, *args):
        self.calls.append((command, args))
        if command == "SEARCH":
            return "OK", [b" ".join(str(uid).encode() for uid in self.messages)]
        assert command == "FETCH"
        uid = int(args[0])
        raw = self.messages[uid]
        if args[1] == "(RFC822.SIZE)":
            return "OK", [f"1 (UID {uid} RFC822.SIZE {len(raw)})".encode()]
        assert args[1] == "(BODY.PEEK[])"
        return "OK", [(b"BODY[]", raw)]


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "state.sqlite")
        self.config = {"imap_host": "imap.example.test", "imap_port": 993,
                       "imap_username": "user@example.test", "imap_password": "secret",
                       "recipient": "user@example.test", "inbound_secret": "test-key",
                       "mailflare_url": "http://127.0.0.1:13080", "state_path": self.path}
        FakeImap.validity = b"10"
        FakeImap.messages = {1: RAW, 2: RAW + b"2"}
        FakeImap.calls = []
        bridge.STOP.clear()

    def test_restart_does_not_reimport_acknowledged_messages(self):
        delivered = []
        db = bridge.open_state(self.path)
        self.assertEqual(bridge.poll(self.config, db, FakeImap, lambda c, r: delivered.append(r)), (2, 0))
        db.close()
        db = bridge.open_state(self.path)
        self.addCleanup(db.close)
        self.assertEqual(bridge.poll(self.config, db, FakeImap, lambda c, r: delivered.append(r)), (0, 0))
        self.assertEqual(len(delivered), 2)
        self.assertTrue(all(command in ("SEARCH", "FETCH") for command, _ in FakeImap.calls))

    def test_failed_ack_is_retried_without_blocking_later_mail(self):
        db = bridge.open_state(self.path)
        self.addCleanup(db.close)
        def fail_one(c, raw):
            if raw == RAW:
                raise TimeoutError("sensitive server response must never be logged")
        with self.assertLogs(bridge.LOG, level="WARNING") as logs:
            self.assertEqual(bridge.poll(self.config, db, FakeImap, fail_one), (1, 1))
        self.assertNotIn("sensitive", str(logs.output))
        replay = []
        self.assertEqual(bridge.poll(self.config, db, FakeImap, lambda c, r: replay.append(r)), (1, 0))
        self.assertEqual(replay, [RAW])

    def test_uidvalidity_change_does_not_skip_reused_uids(self):
        db = bridge.open_state(self.path)
        self.addCleanup(db.close)
        bridge.poll(self.config, db, FakeImap, lambda *_: None)
        FakeImap.validity = b"11"
        self.assertEqual(bridge.poll(self.config, db, FakeImap, lambda *_: None), (2, 0))

    def test_oversized_message_is_retained_for_retry(self):
        db = bridge.open_state(self.path)
        self.addCleanup(db.close)
        with patch.object(bridge, "MAX_BYTES", 1), self.assertLogs(bridge.LOG):
            self.assertEqual(bridge.poll(self.config, db, FakeImap, lambda *_: self.fail()), (0, 2))
        self.assertFalse(any(args[-1] == "(BODY.PEEK[])" for command, args in FakeImap.calls if command == "FETCH"))

    def test_reject_forward_redirect_and_bad_status_are_not_acknowledgements(self):
        for result in [(200, {"action": "reject"}), (200, {"action": "forward"}),
                       (200, {"action": "store", "forwardTo": "other@example.test"}),
                       (302, {}), (409, {}), (500, {})]:
            with patch.object(bridge, "request", return_value=result):
                with self.assertRaises(RuntimeError):
                    bridge.deliver(self.config, RAW)
        with patch.object(bridge, "request", return_value=(200, {"action": "store"})):
            bridge.deliver(self.config, RAW)

    def test_public_plaintext_and_credentials_in_urls_rejected(self):
        path = Path(self.tmp.name) / "config.json"
        for url in ("http://public.example.test", "https://user:pass@example.test", "https://example.test?secret=1"):
            path.write_text(json.dumps({**self.config, "mailflare_url": url}))
            with self.assertRaises(ValueError):
                bridge.load_config(path)

    def test_unconfigured_or_wrong_domain_cannot_receive(self):
        for body in ({"hasAdminAccount": False}, {"hasAdminAccount": True, "primaryDomain": {"hostname": "other.test"}}):
            with patch.object(bridge, "request", return_value=(200, body)):
                with self.assertRaises(RuntimeError):
                    bridge.ready(self.config)

    def test_configured_primary_domain_is_ready(self):
        with patch.object(bridge, "request", return_value=(200, {"hasAdminAccount": True, "primaryDomain": {"hostname": "example.test"}})):
            bridge.ready(self.config)


if __name__ == "__main__":
    unittest.main()
