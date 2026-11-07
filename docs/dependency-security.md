# Dependency security maintenance

The self-hosted pilot uses patched Next.js, DOMPurify, MCP server, Zod and
Nodemailer releases. The lockfile is part of the deployment: use `npm ci`
and build a new image instead of installing packages inside a running image.
Docker and CI pin npm 11.9.0, the version that generated and validated the
lockfile. npm 10 resolves conditional overrides differently and rejects this
lockfile; use the pinned version for a clean install.

Several upstream packages pin vulnerable transitive releases. `package.json`
overrides keep Joi and Undici on patched releases within their existing major
versions, and patch source-map-js, fast-uri, fflate and Sharp. The Nodemailer
override uses the root dependency for SMTP Server and Mailauth as well.
Mailauth imports Nodemailer's address parser; SMTP Server imports its shared
helpers. `tests/mail-dependency-compat.test.mjs` exercises an actual loopback
SMTP delivery with a DKIM signature, SPF/DMARC validation using fixture DNS,
and rejection of a modified signature body. No message leaves the test host.

Before updating these overrides, run:

```sh
npm install --global npm@11.9.0 --no-audit --no-fund
npm ci
npm audit --omit=dev
node --test tests/*.test.mjs
npm run build:node
npm run build
```

Do not use `npm audit fix --force`: its proposed Mailauth/Vinext replacements
can cross major versions or downgrade prereleases. Review remaining advisories
and the dependency tree explicitly. A clean audit is a check against the
registry's current advisory data, not a guarantee of application security.

The initial findings included
[GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw)
and [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7).
