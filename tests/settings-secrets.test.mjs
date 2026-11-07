import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";
const fixture = await loadFixture({ name: "settings-secrets", entryPoint: "src/lib/security/settings-secrets.ts", mocks: {} });
const { encryptSetting, decryptSetting } = await fixture.import();
after(() => fixture.dispose());
const env = { SETTINGS_ENCRYPTION_KEY: "ab".repeat(32) };

test("credentials round-trip without plaintext in stored value, with fresh nonces", async () => {
	const value = "secret-مفتاح-provider";
	const one = await encryptSetting(env, "resendApiKey", value);
	const two = await encryptSetting(env, "resendApiKey", value);
	assert.notEqual(one, two);
	assert.equal(one.includes(value), false);
	assert.equal(await decryptSetting(env, "resendApiKey", one), value);
});

test("missing keys cannot write secrets; legacy reads and empty removals still work", async () => {
	await assert.rejects(encryptSetting({}, "agentApiKey", "secret"), /SETTINGS_ENCRYPTION_KEY/);
	assert.equal(await decryptSetting({}, "agentApiKey", "legacy"), "legacy");
	assert.equal(await encryptSetting({}, "agentApiKey", null), null);
	assert.equal(await decryptSetting({}, "agentApiKey", null), null);
});

test("wrong key, swapped field, malformed envelope and changed ciphertext fail closed", async () => {
	const encrypted = await encryptSetting(env, "awsConfig", '{"secretAccessKey":"secret"}');
	await assert.rejects(decryptSetting({ SETTINGS_ENCRYPTION_KEY: "cd".repeat(32) }, "awsConfig", encrypted), /Unable to decrypt/);
	await assert.rejects(decryptSetting(env, "agentApiKey", encrypted), /Unable to decrypt/);
	await assert.rejects(decryptSetting({}, "awsConfig", encrypted), /SETTINGS_ENCRYPTION_KEY/);
	await assert.rejects(decryptSetting(env, "awsConfig", "mfenc:v1:bad:bad"), /Unable to decrypt/);
	const parts = encrypted.split(":");
	parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
	await assert.rejects(decryptSetting(env, "awsConfig", parts.join(":")), /Unable to decrypt/);
});
