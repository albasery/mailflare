import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
const dir=mkdtempSync('/tmp/mailflare-queue-admin-');
mkdirSync(join(dir,'queues'));
const db=new Database(join(dir,'queues','inbound.sqlite'));
db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY,body TEXT,attempts INTEGER,available_at INTEGER,state TEXT)");
db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('failed-1','{"password":"SECRET-NOT-FOR-LOGS"}',4,0,'failed');
db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run('pending-1','{}',1,0,'pending');
const run=(...args)=>spawnSync(process.execPath,['scripts/queue-admin.mjs',...args],{env:{...process.env,DATA_DIR:dir},encoding:'utf8'});
after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
test('status shows failed-job identifiers and counts without payloads',()=>{
 const result=run('status','inbound');assert.equal(result.status,0);
 const status=JSON.parse(result.stdout);assert.equal(status.failed[0].id,'failed-1');
 assert.equal(result.stdout.includes('SECRET-NOT-FOR-LOGS'),false);assert.equal(result.stdout.includes('password'),false);
});
test('operator can replay only the selected failed job',()=>{
 assert.equal(run('retry','inbound','pending-1').status,1);
 assert.equal(run('retry','inbound','failed-1').status,0);
 const row=db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get('failed-1');
 assert.deepEqual(row,{state:'pending',attempts:0});
 assert.equal(run('retry','inbound','failed-1').status,1);
});
test('queue names cannot escape the data directory',()=>{
 assert.equal(run('status','../../outside').status,1);
});
