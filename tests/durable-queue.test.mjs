import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import { build } from "esbuild";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(process.cwd(), "node_modules", "queue-test-"));
const modulePath = join(dir, "queue.mjs");
await build({ entryPoints: ["server/runtime/queue.ts"], outfile: modulePath, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
const { InProcessQueue } = await import(pathToFileURL(modulePath).href);
after(() => rmSync(dir, { recursive: true, force: true }));
const open = (name, options = {}) => new InProcessQueue(name, { path: join(dir, `${name}.sqlite`), pollIntervalMs: 5, retryDelayMs: 5, ...options });
async function until(condition) {
	for (let n = 0; n < 200; n++) { if (await condition()) return; await delay(10); }
	assert.fail("queue condition timed out");
}

test("accepted jobs survive restart and successful jobs do not replay", async () => {
	let queue = open("restart");
	await queue.send({ rawR2Key: "inbound/mail", from: "sender@example.test" });
	await queue.stop();
	queue = open("restart");
	const received = [];
	queue.setConsumer(async body => { received.push(body); });
	await until(async () => (await queue.metrics()).backlogCount === 0);
	assert.equal(received[0].rawR2Key, "inbound/mail");
	await queue.stop();
	queue = open("restart");
	assert.equal((await queue.metrics()).backlogCount, 0);
	await queue.stop();
});

test("delayed delivery retains its deadline after restart", async () => {
	let queue = open("delay");
	await queue.send({ id: "later" }, { delaySeconds: 0.3 });
	await queue.stop();
	queue = open("delay");
	let count = 0;
	queue.setConsumer(async () => { count++; });
	await delay(50);
	assert.equal(count, 0);
	await until(() => count === 1);
	await queue.stop();
});

test("exhausted jobs survive restart, protect raw MIME and can be replayed", async () => {
	let queue = open("failure", { maxRetries: 1 });
	let attempts = 0;
	await queue.send({ rawR2Key: "inbound/failed", password: "never-log-this" });
	queue.setConsumer(async () => { attempts++; throw new Error("never-log-this"); });
	await until(async () => (await queue.metrics()).failedCount === 1);
	assert.equal(attempts, 2);
	assert.equal(queue.referencedRawKeys().has("inbound/failed"), true);
	await queue.stop();
	queue = open("failure");
	assert.equal((await queue.metrics()).failedCount, 1);
	queue.setConsumer(async () => {});
	assert.equal(queue.retryFailed(), 1);
	await until(async () => (await queue.metrics()).backlogCount === 0);
	await queue.stop();
});

test("SIGKILL during processing recovers the committed job on next startup", async () => {
	const path = join(dir, "crash.sqlite");
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { InProcessQueue } from ${JSON.stringify(pathToFileURL(modulePath).href)};
		const queue = new InProcessQueue('crash', {path:${JSON.stringify(path)}});
		await queue.send({rawR2Key:'inbound/crash'});
		queue.setConsumer(async () => { console.log('processing'); await new Promise(()=>{}); });
		setInterval(()=>{},1000);
	`], { stdio: ["ignore", "pipe", "pipe"] });
	try {
		const started = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("child exited early"); }), delay(5000).then(() => { throw new Error("child start timed out"); })]);
		assert.match(String(started[0]), /processing/);
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const queue = new InProcessQueue("crash", { path, pollIntervalMs: 5 });
		let recovered;
		queue.setConsumer(async body => { recovered = body; });
		await until(() => !!recovered);
		assert.equal(recovered.rawR2Key, "inbound/crash");
		await queue.stop();
	} finally { if (child.exitCode === null) child.kill("SIGKILL"); }
});

test("stopped queues reject acceptance instead of silently dropping mail", async () => {
	const queue = open("stop");
	await queue.stop();
	await assert.rejects(queue.send({ id: 1 }), /stopped/);
});


test("a transient acknowledgement failure retries without a process restart", async () => {
	const queue = open("ack-failure");
	const db = new Database(join(dir, "ack-failure.sqlite"));
	db.exec("CREATE TRIGGER block_ack BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'test storage error'); END");
	let deliveries = 0;
	await queue.send({ id: "retry-ack" });
	queue.setConsumer(async () => { deliveries++; });
	await until(() => deliveries > 0);
	db.exec("DROP TRIGGER block_ack");
	await until(async () => (await queue.metrics()).backlogCount === 0);
	assert.ok(deliveries >= 2);
	await queue.stop();
	db.close();
});
