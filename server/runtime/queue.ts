import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type QueueConsumer = (body: unknown) => Promise<void>;
type Job = { id: string; body: string; attempts: number };
type QueueOptions = { path: string; maxRetries?: number; retryDelayMs?: number; pollIntervalMs?: number };

/**
 * Durable, at-least-once queue for the single-process Node deployment. A send
 * returns only after SQLite commits it. Failed jobs stay on disk for recovery;
 * payloads (which may contain import credentials) are never printed to logs.
 * Run only one server process per DATA_DIR. This is not a distributed queue.
 */
export class InProcessQueue {
	private readonly db: Database.Database;
	private consumer: QueueConsumer | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running: Promise<void> | null = null;
	private stopped = false;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;
	private readonly pollIntervalMs: number;

	constructor(readonly name: string, options: QueueOptions) {
		mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
		this.db = new Database(options.path);
		chmodSync(options.path, 0o600);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = FULL");
		this.db.pragma("secure_delete = ON");
		this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
			available_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
		);
		CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, available_at);
		UPDATE jobs SET state = 'pending' WHERE state = 'running';`);
		this.maxRetries = options.maxRetries ?? 3;
		this.retryDelayMs = options.retryDelayMs ?? 10_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 1000;
	}

	setConsumer(consumer: QueueConsumer) {
		this.consumer = consumer;
		this.schedule(0);
	}

	async send(body: unknown, options?: { delaySeconds?: number }) {
		if (this.stopped) throw new Error(`Queue ${this.name} is stopped`);
		const delay = options?.delaySeconds ?? 0;
		if (!Number.isFinite(delay) || delay < 0) throw new Error("Invalid queue delay");
		const serialized = JSON.stringify(body);
		if (serialized === undefined) throw new Error("Queue body must be JSON serializable");
		this.db.prepare("INSERT INTO jobs (id, body, available_at) VALUES (?, ?, ?)")
			.run(randomUUID(), serialized, Date.now() + delay * 1000);
		this.schedule(0);
	}

	async sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>) {
		for (const message of messages) await this.send(message.body, { delaySeconds: message.delaySeconds });
	}

	async metrics() {
		const row = this.db.prepare("SELECT COUNT(*) AS backlogCount, COALESCE(SUM(state = 'failed'), 0) AS failedCount FROM jobs").get();
		return row as { backlogCount: number; failedCount: number };
	}

	/** Include failed jobs so raw-mail retention cannot destroy recoverable mail. */
	referencedRawKeys(): Set<string> {
		const keys = new Set<string>();
		for (const row of this.db.prepare("SELECT body FROM jobs").iterate() as Iterable<{ body: string }>) {
			const body = JSON.parse(row.body);
			if (typeof body?.rawR2Key === "string") keys.add(body.rawR2Key);
		}
		return keys;
	}

	/** Operator-triggered replay only; never delete exhausted jobs automatically. */
	retryFailed(): number {
		if (this.stopped) throw new Error(`Queue ${this.name} is stopped`);
		const result = this.db.prepare("UPDATE jobs SET state = 'pending', attempts = 0, available_at = ? WHERE state = 'failed'").run(Date.now());
		this.schedule(0);
		return result.changes;
	}

	private schedule(delay: number) {
		if (this.stopped || !this.consumer || this.running) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.running = this.deliver().catch(() => {
				// Do not leak payloads, credentials, or provider responses into logs.
				console.error(`Queue ${this.name}: storage/dispatch failure; inspect queue health`);
			}).finally(() => {
				this.running = null;
				this.schedule(this.pollIntervalMs);
			});
		}, delay);
		this.timer.unref();
	}

	private async deliver() {
		// Only one delivery runs at a time. Recover an interrupted acknowledgement
		// after a transient SQLite error without waiting for a process restart.
		this.db.prepare("UPDATE jobs SET state = 'pending' WHERE state = 'running'").run();
		const job = this.db.prepare("SELECT id, body, attempts FROM jobs WHERE state = 'pending' AND available_at <= ? ORDER BY available_at, rowid LIMIT 1").get(Date.now()) as Job | undefined;
		if (!job || !this.consumer) return;
		if (job.attempts > this.maxRetries) {
			this.db.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(job.id);
			console.error(`Queue ${this.name}: job ${job.id} exhausted retries; retained on disk`);
			return;
		}
		this.db.prepare("UPDATE jobs SET state = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
		try {
			await this.consumer(JSON.parse(job.body));
		} catch {
			const state = job.attempts < this.maxRetries ? "pending" : "failed";
			this.db.prepare("UPDATE jobs SET state = ?, available_at = ? WHERE id = ?").run(state, Date.now() + this.retryDelayMs, job.id);
			console.error(`Queue ${this.name}: job ${job.id} failed; ${state === "failed" ? "retained for manual replay" : "retry scheduled"}`);
			return;
		}
		this.db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
	}

	async stop() {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		await this.running;
		this.db.close();
	}
}

export function openQueue<T>(name: string, path: string): Queue<T> & InProcessQueue {
	return new InProcessQueue(name, { path }) as unknown as Queue<T> & InProcessQueue;
}
