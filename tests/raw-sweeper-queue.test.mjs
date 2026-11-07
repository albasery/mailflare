import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";
const fixture = await loadFixture({name:'raw-sweeper-queue',entryPoint:'src/lib/email/raw-sweeper.ts',mocks:{
	'@/db': 'export const getDb=()=>({select:()=>({from:()=>({where:async()=>[{key:"inbound/saved"}]})})});',
	'@/db/schema': 'export const messages={rawR2Key:"key"};',
	'drizzle-orm': 'export const inArray=()=>null;',
}});
const {sweepOrphanedRawMail} = await fixture.import();
after(()=>fixture.dispose());
test('old pending and failed raw messages are retained while real orphans are deleted',async()=>{
	let removed;
	const env={BUCKET:{list:async()=>({objects:['saved','pending','failed','orphan'].map(id=>({key:'inbound/'+id,uploaded:new Date(0)})),truncated:false}),delete:async keys=>{removed=keys;}}};
	assert.equal(await sweepOrphanedRawMail(env,new Date(),new Set(['inbound/pending','inbound/failed'])),1);
	assert.deepEqual(removed,['inbound/orphan']);
});
