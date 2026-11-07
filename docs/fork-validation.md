# Validation record — 7 November 2026

Base: upstream `d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310` (0.5.4).
Local runtime: Linux, Node 24.22.1. Tests use disposable data and synthetic credentials.

| Check | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Completed; lockfile retained |
| `npm run db:bundle` | Completed for supported dialect bundles |
| `node --test tests/*.test.mjs` | 583 tests: 581 passed, 0 failed, 2 skipped |
| `npx tsc --noEmit` | Passed |
| `npm run build:node` | Passed (Next app and Node server bundle) |
| `npm run build` | Passed (Cloudflare/vinext build) |
| `git diff --check` | Passed |
| Node startup on isolated local SQLite | 86 existing migrations applied; server started |
| `GET /api/setup/status` | 200; fresh-instance status |
| `GET /login` on fresh instance | 307 to `/setup`, expected before first account |
| Unauthenticated `GET /api/admin/aws` | 401; no credential data returned |

The two skipped checks are the upstream generic SQLite schema/backup replay cases in `tests/database-dialects.test.mjs`; they are not failures introduced by this change. The separate fresh-instance Node smoke run applied the actual SQLite migrations.

## New regression coverage

- Real admin layout rendering with the search context required by navigation.
- Queue acceptance persisted across restart, successful acknowledgement removal, and retained delay deadlines.
- A child process killed with SIGKILL while consuming a job; committed work is recovered by a new process.
- Retry exhaustion, retained failed jobs, explicit replay, rejection after shutdown, and recovery after an injected SQLite acknowledgement failure.
- Raw-mail cleanup preserves messages referenced by queued/failed work and still removes unrelated orphans.
- Operator status/retry commands avoid payload disclosure, target only a failed identifier, and reject invalid queue paths.
- AES-GCM round trips, randomized nonces, wrong keys, altered ciphertext, swapped field identity, missing keys, and legacy plaintext compatibility.
- Real settings storage integration verifies encrypted AWS/spam values, decrypted Resend/AI reads, and exclusion of AI credentials from public configuration.
- Local Git integration verifies that upstream merges preserve fork customizations and that conflicts abort without changing the base branch.

## Baseline corrections

The first unmodified test run reported 9 failures. One required generating the ignored migration bundle. Two account-alias tests used the old synchronous API-key fixture and omitted the now-required SHA-256 lookup column; they now await key generation and store its hash. Six DNS tests emitted type 0 for all mock answers; they now emit the actual DNS record type used by the production parser. No authorization or DNS validation was weakened to satisfy these tests.

Type checking exposed two existing omissions: the landing-page initial user lacked calendar/drive access flags, and an inbound-MX record type omitted its optional provider status. Both were corrected.

## Limits

These results are local development evidence. CI is configured for Node 22 and 24; a local Node 24 build is not a claim that hosted CI or a Docker image build has run. No real domain, mail provider credentials, production data, or outbound messages were used. Docker engine, real external SMTP/Resend/SES delivery, live Cloudflare bindings, backup restore under production load, browser end-to-end journeys, spam accuracy and attachment malware detection were not validated here.

Queue delivery remains at least once, with possible duplicate sends after an ambiguous provider acknowledgement. Encryption covers the documented settings only; older plaintext rows/backups and mail/queue data require separate handling. Review [operation and recovery notes](fork-stability.md) before a pilot.
