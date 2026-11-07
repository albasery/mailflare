#!/usr/bin/env node
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const [action, name, jobId] = process.argv.slice(2);
const names = ['inbound', 'outbound', 'agent'];
if (!['status', 'retry'].includes(action) || (name && !names.includes(name)) || (action === 'retry' && (!name || !jobId))) {
	console.error('Usage: node scripts/queue-admin.mjs status [inbound|outbound|agent]\n       node scripts/queue-admin.mjs retry <queue> <failed-job-id>');
	process.exit(1);
}
const dataDir = resolve(process.env.DATA_DIR || './data');
for (const queue of name ? [name] : names) {
	const path = join(dataDir, 'queues', `${queue}.sqlite`);
	if (!existsSync(path)) {
		console.log(JSON.stringify({ queue, initialized: false }));
		if (action === 'retry') process.exitCode = 1;
		continue;
	}
	const db = new Database(path, { readonly: action === 'status', fileMustExist: true });
	try {
		if (action === 'retry') {
			const result = db.prepare("UPDATE jobs SET state='pending', attempts=0, available_at=? WHERE id=? AND state='failed'").run(Date.now(), jobId);
			console.log(JSON.stringify({ queue, replayScheduled: result.changes === 1 }));
			if (result.changes !== 1) process.exitCode = 1;
		} else {
			const counts = db.prepare('SELECT state, COUNT(*) AS count FROM jobs GROUP BY state').all();
			const failed = db.prepare("SELECT id, attempts, available_at FROM jobs WHERE state='failed' ORDER BY available_at LIMIT 100").all();
			// Deliberately exclude message bodies and import/provider credentials.
			console.log(JSON.stringify({ queue, counts, failed }));
		}
	} finally { db.close(); }
}
