import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-bridge-signature-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/lib/email/intake-signature.ts")], outfile: join(dir, "sig.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const sig = await import(pathToFileURL(join(dir, "sig.mjs")).href);

test("Python IMAP bridge signs raw MIME accepted by the real Node inbound verifier", async () => {
  const raw = "Return-Path: <sender@example.test>\r\nSubject: =?UTF-8?B?2YXZhNit2KjYpw==?=\r\n\r\nBody\r\n";
  const code = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('bridge','scripts/imap-bridge.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.signed_headers({'recipient':'hello@example.test','inbound_secret':'test-key'},sys.stdin.buffer.read(),1900000000)))`;
  const headers = JSON.parse(execFileSync("python3", ["-c", code], { cwd: root, input: raw, encoding: "utf8" }));
  const bytes = new TextEncoder().encode(raw).buffer;
  const verify = (body, to = headers["x-mailflare-to"]) => sig.verifyInboundSignatureV2("test-key", headers["x-mailflare-signature"], body, headers["x-mailflare-from"], to, headers["x-mailflare-headers"], headers["x-mailflare-timestamp"], 1_900_000_000);
  assert.equal(await verify(bytes), true);
  assert.equal(await verify(new TextEncoder().encode(raw + "tamper").buffer), false);
  assert.equal(await verify(bytes, "other@example.test"), false);
});
