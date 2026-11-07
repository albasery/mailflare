# First stability edition

This fork starts from upstream Mailflare 0.5.4, commit `d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310`. It adds operational safeguards for a small, privately operated installation. It is a pilot candidate, not a declaration that every upstream feature or security boundary has been audited.

## Changes

- The admin layout supplies the mail-search context required by navigation.
- Node/Docker queues persist accepted jobs in SQLite before returning success. Pending and in-flight jobs recover after restart. Failed jobs remain available for operator review after the initial attempt plus three retries.
- Raw inbound messages referenced by pending or failed Node queue jobs are excluded from orphan cleanup.
- Saved AWS credentials, SES receiving state, Resend API/webhook keys, compatible AI provider keys, and spam intelligence keys use versioned AES-256-GCM envelopes. A fresh nonce and field-specific authenticated data protect each value.
- Node now passes the documented Resend, AWS and spam intelligence environment variables through to the application.
- The upstream-update workflow merges into a new review branch and creates a draft pull request. It never resets the deployment branch. Conflicting updates stop with the base branch preserved.
- CI checks TypeScript and regression tests on Node 22 and 24, the Node build on 22, and the Cloudflare build on 24.

No application database schema migration was added; the queue databases belong to the Node runtime. Existing license checks and feature entitlements are preserved.

## Configure credential encryption before setup

Generate a 32-byte random key privately, for example using `openssl rand -hex 32`. Store the 64 hexadecimal characters as `SETTINGS_ENCRYPTION_KEY` in the deployment's secret store, not in GitHub source or in the application database.

- Docker: add it to the private `.env.docker` used by Compose and restrict that file's access.
- Cloudflare: set it as a Worker secret, for example with `npx wrangler secret put SETTINGS_ENCRYPTION_KEY` for the intended Worker/environment.
- Keep a separately protected backup of this key. Restoring encrypted settings requires the matching key. Replacing the key directly does not rotate existing ciphertext; a migration procedure is required.

New nonempty secret writes require a valid key. Missing keys are rejected before the affected administrative setup calls provision remote resources. Environment-supplied credentials remain environment secrets.

Older plaintext settings remain readable for compatibility. Re-save provider settings to encrypt their current values; existing SES/Resend receiving state may require controlled reconfiguration. This release does **not** automatically rewrite legacy rows or old backups. Plan that migration before moving an existing installation. Loss of the matching key makes encrypted values unreadable; supply replacement provider credentials or restore the original key.

This protects the listed settings at rest. It is not end-to-end email encryption or full database encryption. Mail content, runtime queue payloads, and other application data are not encrypted by this change. Import jobs can include temporary credentials, so treat the queue volume and its backups as sensitive.

## Operate Node queues

Mount `DATA_DIR` on persistent storage, including when the main database uses PostgreSQL, MySQL or libSQL. Run **one Node process per DATA_DIR**. These queues do not coordinate multiple replicas.

Queue files live at `DATA_DIR/queues/{inbound,outbound,agent}.sqlite`. New queue directories use mode 0700 and databases use 0600. The process must have write access; monitor free space and failed-job counts.

Inspect without printing message bodies or credentials:

```sh
DATA_DIR=/data node scripts/queue-admin.mjs status
DATA_DIR=/data node scripts/queue-admin.mjs status inbound
```

The Docker image includes this script. For example, run it using `docker compose exec mailflare node scripts/queue-admin.mjs status` when the service is named `mailflare`.

After identifying and fixing a failure, retry one failed job by its identifier:

```sh
DATA_DIR=/data node scripts/queue-admin.mjs retry inbound JOB_ID
```

Only the selected job in `failed` state is reset. Already-pending/running jobs are not replayed by this command. Status returns up to 100 failed identifiers per queue and aggregate state counts.

Delivery is **at least once**: if a provider accepts a send just before the process crashes or the acknowledgement cannot be committed, retrying can send a duplicate. Check provider/message status before manually replaying outbound mail. This change does not implement provider-level idempotency or guarantee delivery to a recipient's inbox. Failed jobs and their raw messages require operator attention and are not automatically purged.

## Backup and restore

Application database exports do not include the new runtime queue files. For a simple consistent local backup:

1. Stop the Node service and verify it has exited.
2. Snapshot the complete persistent `DATA_DIR`, including the main SQLite database, local blobs, and the `queues` directory with any SQLite sidecar files. Back up external databases/object storage separately if configured.
3. Preserve deployment secrets, especially `SETTINGS_ENCRYPTION_KEY`, separately with restricted access.
4. Restore into an isolated instance with outbound sending disabled; inspect queue status before allowing processing against live services.

Do not copy only an active `.sqlite` file while omitting its WAL. Test restoration before using this installation for important correspondence. Rolling back to unmodified upstream code cannot read the new ciphertext or process these queue files; retain this fork or perform a planned migration before rollback.

## Upstream update process

Run **Prepare Upstream Update** from GitHub Actions, or request it through the admin update card. Check the run result: it may find no new changes, open a draft PR, or stop on conflicts. The admin response acknowledges dispatch, not successful merge or deployment.

Review customizations and schema changes, run tests/builds, and then merge the review branch intentionally. Configure deployment to track only the approved branch. The source defaults to `hieunc229/mailflare`; the optional `UPDATE_SOURCE_REPOSITORY` repository variable can change it.

The workflow needs permission to push its review branch and create a PR. GitHub may require enabling “Allow GitHub Actions to create and approve pull requests.” When upstream changes workflow files or when downstream checks must be triggered by the push, use a separately managed `MAILFLARE_UPDATE_TOKEN` with the required repository/workflow permissions. The app's `GITHUB_UPDATE_TOKEN` only dispatches the workflow; it is a different credential. If permissions are insufficient, the update fails instead of replacing the deployment branch.

The original README's one-click deployment button and published upstream container images deploy upstream code. To deploy this edition, explicitly build this fork's approved commit or connect the deployment to this repository and branch.

## Validation and pilot scope

See [validation results](fork-validation.md) for executed checks and their limits. Before production, use a separate test domain/subdomain, configure SPF/DKIM/DMARC for the selected provider, and verify external inbound/outbound messages, attachments, Arabic/RTL display, bounces, rate limits and backup restoration. Real provider delivery and DNS changes require the intended deployment credentials and domain; this development work did not modify production mail routing.

Follow-up priorities: measured load testing, queue monitoring in the admin UI, provider-aware duplicate prevention, automatic encrypted migration/key rotation, attachment scanning, and a deeper authorization/security review. IMAP/SMTP client compatibility and paid upstream capabilities should be evaluated against the intended use rather than assumed from the webmail interface.
