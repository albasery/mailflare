"""Run after npm run build:node. All messages and servers are local fixtures."""
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="mailflare-bridge-e2e-") as directory:
    state = Path(directory)
    base = "http://127.0.0.1:13181"
    env = {"PATH": os.environ["PATH"], "NODE_ENV": "production", "MAILFLARE_RUNTIME": "node",
           "DATA_DIR": str(state / "app"), "PORT": "13181", "SMTP_INBOUND_PORT": "0",
           "APP_URL": base, "INBOUND_WEBHOOK_SECRET": "fixture-hmac-secret",
           "INBOUND_REQUIRE_SIGNED_HEADERS": "1", "SETTINGS_ENCRYPTION_KEY": "a" * 64}
    with open(state / "server.log", "w") as log:
        process = subprocess.Popen(["node", "dist/server.mjs"], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for attempt in range(120):
                try:
                    with urllib.request.urlopen(base + "/api/setup/status", timeout=2) as response:
                        assert response.status == 200
                    break
                except Exception:
                    if process.poll() is not None:
                        raise RuntimeError("Fixture server exited")
                    time.sleep(.25)
            payload = {"domain": "example.test", "username": "hello", "password": "Fixture-password-not-real-2026",
                       "resetEmail": "recovery@example.test", "enableSending": True}
            request = urllib.request.Request(base + "/api/auth/register", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=20) as response:
                assert json.load(response)["ok"]
            fixtures = runpy.run_path(str(root / "tests/test_imap_bridge.py"))
            bridge, fake = fixtures["bridge"], fixtures["FakeImap"]
            config = {"imap_host": "imap.example.test", "imap_port": 993, "imap_username": "hello@example.test",
                      "imap_password": "fixture-only", "recipient": "hello@example.test", "mailflare_url": base,
                      "inbound_secret": "fixture-hmac-secret"}
            bridge.ready(config)
            db = bridge.open_state(str(state / "bridge.sqlite"))
            assert bridge.poll(config, db, fake) == (2, 0)
            appdb = sqlite3.connect(state / "app/mailflare.sqlite")
            for attempt in range(80):
                if appdb.execute("SELECT count(*) FROM messages").fetchone()[0] == 2:
                    break
                time.sleep(.25)
            assert appdb.execute("SELECT count(*) FROM messages").fetchone()[0] == 2
            # Lose the bridge checkpoint and replay identical MIME through the real API.
            time.sleep(1.1)
            db2 = bridge.open_state(str(state / "new-bridge.sqlite"))
            assert bridge.poll(config, db2, fake) == (2, 0)
            time.sleep(1)
            assert appdb.execute("SELECT count(*) FROM messages").fetchone()[0] == 2
            db.close()
            db2.close()
            appdb.close()
            print("PASS: registration, signed inbox delivery, persistent mail storage and duplicate suppression after replay")
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
