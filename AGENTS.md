# AGENTS.md

Operating notes for coding agents working in `actual-flows`. Personal tool; conventions from other repositories do not apply here.

## What this is

A Node.js (ESM) service that watches Paperless-ngx for ingested financial documents, parses amount, date, payee and currency, and imports each as a transaction into Actual Budget. It also reports on mismatches between documents and the ledger (`--reconcile`). See `README.md` for configuration and the CLI.

Unlike a read-only exporter, this tool writes: it patches Paperless documents (custom fields, status, tags) and imports transactions into Actual.

## Rules that must not be broken

- **`--dry-run` makes zero writes.** No PATCH, no tag creation, no Actual connection. `--reconcile` is read-only too. Tests assert this.
- **Imports are idempotent.** The key is `imported_id = paperless:<id>`, and the Paperless document is patched with `actual_transaction_id`. Re-running `--import` must never create a duplicate.
- **Unparseable, foreign-currency and low-confidence documents are never imported.** They are tagged `needs-review`.
- **No secrets in git.** `PAPERLESS_TOKEN`, `ACTUAL_PASSWORD` and `ACTUAL_SYNC_ID` come from the environment. `config.json`, `.env` and `data/` are ignored and stay out of the image.
- **No real documents in fixtures.** Test data is synthetic.
- **Tests never touch the network.** Use injected fetch functions and fakes.
- **New or changed config keys** go in `config.example.json`, `.env.example` and the README together.

## Toolchain

- `.node-version` is the single source for the Node version. The Dockerfile base images and CI must agree with it; CI fails if the Dockerfile differs.
- `better-sqlite3` (via `@actual-app/api`) ships no prebuilt binaries and compiles at install time. The Dockerfile installs the toolchain in a build stage only; do not add it to the final image.
- The image runs as the unprivileged `node` user. `CI` runs `npm test`; `Docker` builds the image and smoke-tests it (help output, non-root, the native module loads).
- Pull requests are squash-merged into `main`. Dependency bumps arrive from Dependabot; check the `Docker` job before merging one, since the native module is the part most likely to break.

## Working style

- Small commits with a clear scope. Do not reformat unrelated files.
- Add or update tests with every behaviour change, including failure paths.
- A new dependency needs a reason in the PR.
