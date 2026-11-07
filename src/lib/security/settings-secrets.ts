/** Versioned authenticated encryption for secret-bearing app_settings values. */
const PREFIX = "mfenc:v1:";
const encoder = new TextEncoder();

export function requireSettingsEncryptionKey(env: Pick<CloudflareEnv, "SETTINGS_ENCRYPTION_KEY">): string {
	const key = env.SETTINGS_ENCRYPTION_KEY?.trim();
	if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) {
		throw new Error("Configure SETTINGS_ENCRYPTION_KEY as 64 hexadecimal characters before saving service credentials");
	}
	return key;
}

async function keyFor(env: Pick<CloudflareEnv, "SETTINGS_ENCRYPTION_KEY">) {
	const hex = requireSettingsEncryptionKey(env);
	const bytes = Uint8Array.from(hex.match(/../g)!, (part) => parseInt(part, 16));
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}
function decode(value: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export async function encryptSetting(env: Pick<CloudflareEnv, "SETTINGS_ENCRYPTION_KEY">, field: string, value: string | null): Promise<string | null> {
	if (!value) return value;
	const key = await keyFor(env);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(field) }, key, encoder.encode(value));
	return `${PREFIX}${encode(iv)}:${encode(new Uint8Array(ciphertext))}`;
}

export async function decryptSetting(env: Pick<CloudflareEnv, "SETTINGS_ENCRYPTION_KEY">, field: string, value: string | null | undefined): Promise<string | null> {
	if (!value) return null;
	// Existing installations remain readable. Re-save old values to encrypt them.
	if (!value.startsWith("mfenc:")) return value;
	if (!value.startsWith(PREFIX)) throw new Error("Unsupported settings encryption version");
	const key = await keyFor(env);
	try {
		const parts = value.slice(PREFIX.length).split(":");
		if (parts.length !== 2) throw new Error("Invalid envelope");
		const iv = decode(parts[0]);
		if (iv.byteLength !== 12) throw new Error("Invalid nonce");
		const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(field) }, key, decode(parts[1]));
		return new TextDecoder().decode(plaintext);
	} catch {
		throw new Error("Unable to decrypt service settings; restore the matching SETTINGS_ENCRYPTION_KEY");
	}
}
