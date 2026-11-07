import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {loadFixture,sqliteProxy} from './helpers/fixtures.mjs';
const fixture=await loadFixture({name:'settings-storage',entryPoint:'tests/fixtures/settings-storage.ts',mocks:{
 '@/db':'export const getDb=()=>globalThis.__secretSettingsDb;',
 'cloudflare:workers':'export const env={};',
}});
const lib=await fixture.import();
const env={SETTINGS_ENCRYPTION_KEY:'ef'.repeat(32)};
const {db,sqlite}=sqliteProxy({schema:`CREATE TABLE app_settings (
 app_name TEXT DEFAULT 'Mailflare', outbound_attachment_max_mb INTEGER DEFAULT 25, drive_storage_limit_bytes INTEGER,
 ses_receiving TEXT, resend_webhook_id TEXT, resend_webhook_secret TEXT, icon_key TEXT, agent_enabled INTEGER DEFAULT 1,
 id TEXT PRIMARY KEY, aws_config TEXT, spamhaus_dqs_key TEXT, abusech_auth_key TEXT, spam_domain_age_check INTEGER DEFAULT 1, spam_brands TEXT,
 agent_provider TEXT, agent_preset TEXT, agent_base_url TEXT, agent_api_key TEXT, agent_model TEXT, agent_model_rates TEXT,
 resend_api_key TEXT, updated_at INTEGER
);`});
globalThis.__secretSettingsDb=db;
after(()=>{sqlite.close();delete globalThis.__secretSettingsDb;fixture.dispose();});
test('AWS saved settings are encrypted and still resolve usable credentials',async()=>{
 const config={accessKeyId:'TESTACCESSKEY',secretAccessKey:'aws-secret',region:'us-east-1'};
 await lib.saveAwsConfig(env,config,'test-account');
 const stored=sqlite.prepare('SELECT aws_config FROM app_settings').get().aws_config;
 assert.match(stored,/^mfenc:v1:/);assert.equal(stored.includes('aws-secret'),false);
 assert.deepEqual(await lib.getAwsConfig(env),config);
 assert.equal((await lib.getAwsConfigStatus(env)).accessKeyHint,'SKEY');
});
test('spam lookup keys survive encryption and allow independent key deletion',async()=>{
 await lib.saveSpamIntelligenceSettings(env,{spamhausDqsKey:'spam-key',abusechAuthKey:'abuse-key'});
 const row=sqlite.prepare('SELECT spamhaus_dqs_key,abusech_auth_key FROM app_settings').get();
 assert.match(row.spamhaus_dqs_key,/^mfenc:v1:/);assert.match(row.abusech_auth_key,/^mfenc:v1:/);
 const config=await lib.getSpamIntelligenceConfig(env);
 assert.equal(config.spamhausDqsKey,'spam-key');assert.equal(config.abuseChAuthKey,'abuse-key');
 await lib.saveSpamIntelligenceSettings(env,{spamhausDqsKey:null});
 assert.equal((await lib.getSpamIntelligenceConfig(env)).spamhausDqsKey,undefined);
});
test('Resend and AI readers decrypt saved values without exposing keys in public config',async()=>{
 const resend=await lib.encryptSetting(env,'resendApiKey','resend-secret');
 const agent=await lib.encryptSetting(env,'agentApiKey','agent-secret');
 sqlite.prepare("UPDATE app_settings SET resend_api_key=?,agent_api_key=?,agent_provider='compatible',agent_preset='custom',agent_base_url='https://ai.example.test/v1',agent_model='test-model'").run(resend,agent);
 assert.equal(await lib.getResendApiKey(env),'resend-secret');
 assert.equal((await lib.getAgentProviderConfig(env)).apiKey,'agent-secret');
 const visible=await lib.getAgentProviderPublicConfig(env);
 assert.equal(visible.hasApiKey,true);assert.equal('apiKey' in visible,false);
 await assert.rejects(lib.getResendApiKey({}),/SETTINGS_ENCRYPTION_KEY/);
});
