# Actual Budget ↔ Paperless-ngx Bridge (`ab2pb`)

A standalone Node.js bridge that watches [Paperless-ngx](https://docs.paperless-ngx.com/) for newly
ingested financial documents, parses amount/date/payee/currency from their OCR content
(AUD/AU locale, with manual-override and foreign-currency handling), imports each as a
deduplicated transaction into [Actual Budget](https://actualbudget.org/), and writes back a
link so you can jump from an Actual transaction to its source document and back. It runs as a
plain Node process or a Docker container on your existing stack — no cloud services involved.

## Architecture

```
┌──────────────┐  poll/unimported   ┌──────────────────────┐  importTransactions  ┌──────────────┐
│ Paperless-ngx│ ─────────────────► │  bridge (node ESM)   │ ───────────────────► │ Actual Budget │
│  REST API    │ ◄───────────────── │  parse → validate    │ ◄─────────────────── │ @actual-app  │
└──────────────┘  PATCH fields/tags └──────────────────────┘  actual_transaction_id└──────────────┘
```

Data flow per pass:

1. **Poll unimported** — query Paperless for documents where `actual_transaction_id` does not
   exist yet (`custom_field_query exists=false`, ordered by `added`), filtered to docs that
   match any configured signal tag, document type, or correspondent.
2. **Parse** — extract amount (currency-aware, minor units), date, payee, and currency from the
   OCR content or manual custom-field overrides. Unparseable or foreign-currency docs go to
   `needs-review`, never to Actual.
3. **Import** — create one transaction per document in the configured Actual account with
   `imported_id = paperless:<id>` (dedup key).
4. **Write back** — PATCH the Paperless document with `actual_transaction_id`, parsed fields
   (amount/date/payee/currency), and status `imported`.

## Status

**v1 implemented** (all core stages green, `npm test`): config validation, Paperless + Actual
clients, AU/foreign-currency parser, import orchestration with idempotency, CLI, Docker wiring,
documentation.

**v2 in progress:**

- [x] **Reconcile report** — `--reconcile [year]` (read-only) classifies the reconcile window
      (current + previous AU financial year, or the single FY ending in `year`) into signal
      docs without a transaction, dangling `paperless:<id>` transactions, and non-paperless
      transactions (see [CLI reference](#cli-reference)).
- [x] **Per-signal account mapping** — map individual signal tags/document types/correspondents
      to distinct Actual accounts instead of one `defaultAccountName`.
- [x] **Income-by-document-type** — an optional, distinct `incomeSignals` config section
      (document types + tags) whose documents parse as income (positive amounts), separate from
      the watch `signals` list.
- [x] **Duplicate-guard** — an optional (`duplicateGuard.enabled`, default off) pre-import check
      that flags documents which already have a matching Actual transaction as
      `possible-duplicate` instead of importing a second copy.

## Prerequisites

- **Node.js >= 20** for local development (uses only Node built-ins plus `@actual-app/api`).
- **Docker + Docker Compose** for the containerised bridge.
- **Paperless-ngx and Actual Budget running on the same Docker network**, so the bridge can
  reach both by service name.

## 1. Paperless-ngx setup

1. **Create an API token**: open Paperless → **My Profile → API Token** → copy the token.
2. **Create the custom fields** (Settings → Custom Fields). Names must match
   `config.paperless.fields` in your config:

   | Field name            | Data type | Purpose                                        |
   | --------------------- | --------- | ---------------------------------------------- |
   | `actual_amount`       | Monetary  | Parsed amount, written back as a formatted string |
   | `actual_date`         | Date      | Parsed transaction date                        |
   | `actual_payee`        | Text      | Parsed payee / correspondent                   |
   | `actual_currency`     | Text      | Currency code (`AUD`, or the foreign code)     |
   | `actual_transaction_id` | URL or Text | Actual transaction id written back on import |
   | `actual_status`       | Select    | Options: `pending`, `imported`, `error`, `needs-review`, `possible-duplicate` |

   `actual_status` is the pipeline state the bridge updates: docs that fail parsing are marked
   `needs-review`, docs whose import errors get `error`, successful imports get `imported`,
   and (when the duplicate-guard is enabled) docs matching an existing transaction get
   `possible-duplicate` (start everything at `pending`).
3. **Create the tags**:
   - `needs-review` — the bridge looks this up (and creates it if missing) to tag documents
     that need a human decision.
   - `possible-duplicate` — the bridge looks this up (and creates it if missing) when the
     [duplicate-guard](#duplicate-guard) flags a document instead of importing it.
   - `imported` — optional; convenient for filtering imported documents in the Paperless UI.
4. **Ensure your signal tags/document types/correspondents exist.** By default the bridge only
   watches documents carrying one of the tags `invoice`, `receipt`, or `bill` (see
   `signals` in `config.example.json`). If you configure different signal names, create them
   first — document types and correspondents are resolved read-only and skipped with a warning
   if missing; signal tags are auto-created during `--import`.

## 2. Actual Budget setup

1. **Server URL** — e.g. `http://actual-server:5006` (service name on the shared network).
2. **Password** — the Actual server password (the bridge needs it to download the budget).
3. **Budget Sync ID** — open Actual → **Settings → Advanced → Show advanced settings → Sync ID**.
4. **Default account name** — the name of the account transactions should land in (e.g.
   `Cash`), matching `config.actual.defaultAccountName`. Signal entries with a mapped
   `account` (see [Configuration](#3-configuration)) override this per document.

## 3. Configuration

```sh
cp config.example.json config.json
cp .env.example .env
```

Edit `config.json` (base URL, field names, signal names, account name, locale defaults) and
fill the three secrets in `.env` — they always win over anything in the config file:

```sh
PAPERLESS_TOKEN=<your paperless api token>
ACTUAL_PASSWORD=<your actual password>
ACTUAL_SYNC_ID=<your budget sync id>
```

The config file may keep the `"${PAPERLESS_TOKEN}"`-style placeholders; the bridge only
requires the values to be resolvable, either inline or via the environment. You can also point
the bridge at a different config file with `AB2PB_CONFIG=./config.json`.

### Mapping signals to Actual accounts

Each entry in `signals.tags`, `signals.documentTypes`, and `signals.correspondents` is either a
plain signal name (imports into `actual.defaultAccountName`) or an object with an optional
`account`:

```json
"signals": {
  "tags": [
    "invoice",
    { "name": "bill", "account": "Amex" },
    { "name": "receipt" }
  ],
  "documentTypes": [{ "name": "statement", "account": "Bank" }],
  "correspondents": []
}
```

A document matching a signal entry with an `account` imports into that Actual account; matches
against plain names, or object entries without an `account`, use the default account. When a
document matches several signals, the **first matching entry wins**: tags are checked first,
then document types, then correspondents, and within each kind config order decides. The mapped
account only affects where the transaction lands — candidate filtering still treats every entry
as one OR-filter over signal names, regardless of account. If a mapped account does not exist
in Actual, that document is marked `error` and the rest of the batch continues.

### Income signals (positive amounts)

Documents parse as **expenses** (negative amounts) by default. The optional top-level
`incomeSignals` section marks document types and tags whose documents should parse as
**income** (positive) — e.g. dividends, credit notes, rebates:

```json
"incomeSignals": {
  "documentTypes": ["credit note"],
  "tags": ["dividend"]
}
```

`incomeSignals` is its own section, deliberately **distinct from `signals`**: the watch
`signals` only decide which documents are import candidates, and a watch-signal match alone
never flips a document to income. Income comes only from an entry here (resolved to its
Paperless id) or a `refund` / `credit note` / `cashback` keyword in the OCR content. Both keys
are optional and default to `[]`; entries are plain Paperless document-type/tag **names**,
created in Paperless beforehand — names that don't resolve are skipped with a warning, never
fatal. Omitting the whole section means no income signals at all.

### Duplicate-guard

The optional top-level `duplicateGuard` section protects against re-importing documents whose
`actual_transaction_id` provenance was lost (e.g. documents already imported before the bridge
existed). It is **off by default** and must be enabled explicitly:

```json
"duplicateGuard": {
  "enabled": true,
  "windowDays": 7
}
```

When `enabled` is `true`, a document that parses cleanly is checked against the Actual
transactions already in its account *before* importing. The bridge fetches the account's
transactions in a window of `windowDays` days before and after the parsed date (default `7`,
so a 15-day span) and looks for an existing transaction with the **same amount** (to the cent),
the **same date**, and a **similar payee** — a case-insensitive substring match in either
direction (e.g. `ACME` matches `Acme Pty Ltd`). If one is found, the document is **not
imported**: it is tagged `possible-duplicate`, the status custom field is set to
`possible-duplicate`, and the parsed amount/date/payee/currency are written back for review. A
transaction whose `imported_id` is `paperless:<thisDocId>` is the bridge's own import for the
same document and is never treated as a duplicate.

`possible-duplicate` is a **terminal** state: on later passes the bridge skips a document whose
status is already `possible-duplicate` (like it skips a document that already has an
`actual_transaction_id`), so a flagged document is not re-examined on every poll. A failure
while checking one document marks just that document `error` and the rest of the batch
continues. Leave `duplicateGuard` out of the config (or set `enabled: false`) to keep the
v1 behaviour: every cleanly parsed document is imported.

## 4. Docker Compose wiring

`docker-compose.yml` is included. The bridge must join the same Docker network as your
Paperless-ngx and Actual Server containers — open the compose file, uncomment the `networks`
blocks, and set the real network name (find it with `docker network ls`):

```yaml
services:
  ab2pb-bridge:
    build: .
    env_file: .env
    volumes:
      # The bridge reads ./config.json (AB2PB_CONFIG default) from /app — mount
      # your config read-only. Create it first (cp config.example.json config.json).
      - ./config.json:/app/config.json:ro
      - ./data:/data
    restart: unless-stopped
    # networks:
    #   - ab2pb-net

# networks:
#   ab2pb-net:
#     external: true
#     name: <your-shared-stack-network>  # replace with the real network name
```

- `./config.json:/app/config.json:ro` — mounts your config (created in [Configuration](#3-configuration))
  read-only at the container path the bridge loads by default (`AB2PB_CONFIG` defaults to
  `./config.json`, i.e. `/app/config.json`). Create it before `docker compose up`: a missing
  host file becomes an empty directory and the bridge exits with a parse error. The mounted
  config may keep the `${PAPERLESS_TOKEN}`-style placeholders, since the secrets arrive via
  `env_file`.
- `env_file: .env` feeds the secrets into the container (`PAPERLESS_TOKEN`,
  `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`), which always win over config-file values.
- `./data:/data` is where Actual's downloaded budget data is stored (`actual.dataDir`).
- Bring it up with `docker compose up -d --build`; the container runs `--poll` continuously
  and restarts unless stopped. If the bridge can already reach both services over the default
  compose network, you can leave the network block commented out.

## 5. CLI reference

Run the bridge locally with `node src/cli.js <flags>` (or `ab2pb` once installed via
`npm link`), or in Docker as `docker compose run --rm ab2pb-bridge <flags>`:

| Flag           | Behaviour                                                                 | Exit code |
| -------------- | ------------------------------------------------------------------------- | --------- |
| `--check`      | Verify Paperless custom fields exist and resolve the Actual account.      | `0` ok, `1` on failure |
| `--dry-run`    | List and parse candidates, print the planned imports. **Zero writes** — no PATCH, no tag creation, no Actual connection. | `0` ok, `1` on failure |
| `--import`     | Run a single import pass (parse → write back → import → mark imported).   | `0` ok, `1` on failure |
| `--once`       | Single poll-style import pass, then exit (same as `--import`).            | `0` ok, `1` on failure |
| `--poll [s]`   | Watch Paperless continuously; per-pass failures are logged, not fatal. Interval in seconds (default `60`). | runs until interrupted (`SIGINT`); `1` if the process fails to start |
| `--reconcile [year]` | Read-only reconcile report: signal docs without a transaction, dangling `paperless:<id>` transactions, and non-paperless transactions for the window (current + previous AU FY, or the single FY ending `year`). | `0` ok, `1` on failure |
| *(no flag / unknown flag)* | Print usage.                                                        | `0` |

Exit code `1` is also used when the config is missing/invalid (the error names the exact
missing field), when Paperless/Actual are unreachable, or when a whole pass fails.

## How it works

- **Idempotency** — every transaction is imported with `imported_id = paperless:<id>` and the
  Paperless doc is patched with `actual_transaction_id` afterwards. Candidate listing filters
  on `actual_transaction_id exists=false` (plus a defensive client-side check), so re-running
  `--import` never creates duplicates and already-imported docs are skipped.
- **Parse precedence** — manual custom-field overrides (`actual_amount`/`actual_date`/
  `actual_payee`) are authoritative; otherwise the amount is parsed from OCR with a
  currency-aware regex preferring labelled totals, dates use the AU locale
  (`d/m/y`, `d m y`) with a fallback to the document's created date, and the payee comes from
  the correspondent or title.
- **Foreign currency & needs-review** — bare `$` is ambiguous and non-AUD codes (e.g.
  `USD $10.00`) are flagged foreign; foreign, unparseable, or low-confidence documents are
  **never imported** — they are tagged `needs-review` with status set so a human can decide.
- **Duplicate-guard (opt-in)** — when `duplicateGuard.enabled` is true, a cleanly parsed
  document is compared against existing Actual transactions (same account, ±`windowDays` around
  the parsed date) for a matching amount + date + similar payee. A match is tagged
  `possible-duplicate` (status `possible-duplicate`) and never imported; the status is terminal
  so the document is skipped on subsequent passes.
- **Sign handling** — expenses are negative (minor units, so `$50.00` → `-5000`); documents
  matching `incomeSignals` (document types/tags) or containing refund/credit-note/cashback
  keywords parse positive (income).
- **Write-backs** — on success the doc gets `actual_transaction_id` (from Actual's returned
  id), status `imported`, and the parsed amount/date/payee/currency; failed docs get status
  `error`, and one bad document never aborts the rest of the batch.

## Development

```sh
npm install      # install @actual-app/api
npm test         # node --test — full suite (no network required)
```

Before running against your real stack, **start with `--dry-run`** — it parses and previews
every candidate without writing anything:

```sh
node src/cli.js --dry-run
node src/cli.js --check     # verify fields/account wiring
node src/cli.js --import    # one real pass
```

## Privacy

Everything runs locally on your own machines and Docker network: the bridge talks only to
your Paperless-ngx and Actual Budget instances over your LAN/VPN, with no cloud services or
telemetry involved.