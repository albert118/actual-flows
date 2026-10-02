#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createPaperlessClient } from './paperless.js';
import { connect } from './actual.js';
import { runReconcile } from './report.js';
import { createBridge, DEFAULT_POLL_INTERVAL_MS } from './bridge.js';

const USAGE = `ab2pb - Actual <-> Paperless bridge

Usage:
  ab2pb --check     Verify Paperless custom fields + Actual account, then exit
  ab2pb --dry-run   Parse and stage imports without writing anything
  ab2pb --import    Run a single import pass
  ab2pb --once      Poll once and exit
  ab2pb --poll [s]  Watch Paperless continuously (interval in seconds, default 60)
  ab2pb --reconcile [year]
                    Read-only reconcile report: signal docs without a
                    transaction, dangling paperless:<id> transactions, and
                    non-paperless transactions. Default window is the current
                    + previous AU financial year; pass a year (e.g. 2025) for
                    the single FY ending 30 June of that year.

Environment:
  AB2PB_CONFIG      Path to config JSON (default ./config.json)
  PAPERLESS_TOKEN   Paperless-ngx API token (overrides config file)
  ACTUAL_PASSWORD   Actual Budget server password (overrides config file)
  ACTUAL_SYNC_ID    Actual Budget budget sync id (overrides config file)
`;

const KNOWN_FLAGS = new Set(['--check', '--dry-run', '--import', '--once', '--poll', '--reconcile']);

// --dry-run must make ZERO writes, so it does not connect to Actual either
// (connecting downloads the budget to disk and resolves the account).
const CONNECT_FLAGS = new Set(['--import', '--once', '--poll', '--reconcile']);

function fail(message) {
  console.error(`ab2pb: ${message}`);
  process.exitCode = 1;
}

async function run() {
  const [flag, extra] = process.argv.slice(2);

  if (!flag) {
    console.log(USAGE);
    return;
  }
  if (!KNOWN_FLAGS.has(flag)) {
    console.log(USAGE);
    return;
  }

  // --reconcile needs config + network (read-only), so it routes through the
  // normal config/connect path below and runs after the bridge is built.

  let config;
  let actual = null;
  try {
    config = loadConfig();
    if (CONNECT_FLAGS.has(flag)) {
      actual = await connect({
        serverURL: config.actual.serverUrl,
        password: config.actual.password,
        budgetSyncId: config.actual.budgetSyncId,
        dataDir: config.actual.dataDir,
      });
    }
  } catch (err) {
    fail(err.message);
    return;
  }

  const paperless = createPaperlessClient({
    baseUrl: config.paperless.baseUrl,
    token: config.paperless.token,
    apiVersion: config.paperless.apiVersion,
  });

  const bridge = createBridge({
    config,
    paperless,
    // actual is injected for --import/--once/--poll/--reconcile. --dry-run
    // leaves it unset and never connects (zero-write). --check also leaves it
    // unset, but bridge.check() connects lazily to resolve the Actual account.
    actual,
  });

  try {
    if (flag === '--check') {
      await bridge.check();
      console.log('check ok');
    } else if (flag === '--dry-run') {
      await bridge.dryRun();
    } else if (flag === '--import') {
      await bridge.import();
    } else if (flag === '--once') {
      await bridge.once();
    } else if (flag === '--reconcile') {
      let year;
      if (extra !== undefined && extra !== '') {
        const parsed = Number(extra);
        if (!Number.isInteger(parsed)) {
          throw new Error(`invalid year for --reconcile: "${extra}" (expected YYYY)`);
        }
        year = parsed;
      }
      await runReconcile({ config, paperless, actual, year });
    } else {
      const seconds = Number.parseInt(extra, 10);
      const intervalMs = Number.isInteger(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_POLL_INTERVAL_MS;

      // --poll runs forever; SIGINT/SIGTERM must stop the loop so the outer
      // `finally` below can run bridge.shutdown() (Actual's cleanup) and the
      // process exits 0 instead of being killed mid-connection.
      const stop = new AbortController();
      const onSignal = () => stop.abort();
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      try {
        await bridge.poll({ intervalMs, signal: stop.signal });
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    }
  } catch (err) {
    fail(err.message ?? String(err));
  } finally {
    await bridge.shutdown().catch(() => {});
  }
}

run();