import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import mailauth from "mailauth";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";

// mailauth and smtp-server use Nodemailer's internal helpers. Exercise their
// real wire format together when the security override is updated.
test("patched mail dependencies deliver and authenticate a DKIM-signed message", async () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
	const received = [];
	const server = new SMTPServer({
		authOptional: true,
		disabledCommands: ["AUTH", "STARTTLS"],
		onData(stream, _session, callback) {
			const chunks = [];
			stream.on("data", (chunk) => chunks.push(chunk));
			stream.on("end", () => { received.push(Buffer.concat(chunks)); callback(); });
		},
	});
	await new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const transport = nodemailer.createTransport({
		host: "127.0.0.1",
		port: server.server.address().port,
		secure: false,
		ignoreTLS: true, // Test-only loopback receiver; no external delivery.
		dkim: { domainName: "pilot.test", keySelector: "test", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) },
	});
	try {
		await transport.sendMail({ from: '"Mailflare, Pilot" <sender@pilot.test>', to: "inbox@pilot.test", subject: "Dependency compatibility", text: "original-body" });
		assert.equal(received.length, 1);
		const options = {
			ip: "192.0.2.10", helo: "mail.pilot.test", sender: "sender@pilot.test", mta: "receiver.pilot.test",
			disableArc: true, disableBimi: true,
			async resolver(name, type) {
				if (type === "TXT" && name === "test._domainkey.pilot.test") return [[`v=DKIM1; k=rsa; p=${key}`]];
				if (type === "TXT" && name === "pilot.test") return [["v=spf1 ip4:192.0.2.10 -all"]];
				if (type === "TXT" && name === "_dmarc.pilot.test") return [["v=DMARC1; p=reject"]];
				throw Object.assign(new Error("Test DNS record absent"), { code: "ENODATA" });
			},
		};
		const valid = await mailauth.authenticate(received[0], options);
		assert.equal(valid.spf.status.result, "pass");
		assert.ok(valid.dkim.results.some((entry) => entry.status.result === "pass"));
		assert.equal(valid.dmarc.status.result, "pass");
		const tampered = Buffer.from(received[0].toString().replace("original-body", "tampered-body"));
		const invalid = await mailauth.authenticate(tampered, options);
		assert.ok(invalid.dkim.results.every((entry) => entry.status.result !== "pass"));
		assert.ok(invalid.dkim.results.some((entry) => entry.status.comment === "body hash did not verify"));
	} finally {
		transport.close();
		await new Promise((resolve) => server.close(resolve));
	}
});
