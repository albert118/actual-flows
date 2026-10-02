// Thin wrapper around @actual-app/api for the bridge: connection lifecycle,
// account resolution, and transaction import. `connect` accepts an optional
// injected API module so tests can stub @actual-app/api without relying on
// experimental module-mock flags (keeps `npm test` = plain `node --test`).

import * as actualApi from '@actual-app/api';

/**
 * Initialises the Actual engine and downloads the budget, returning an
 * api-like handle that bundles the module's data functions plus `shutdown()`.
 *
 * @param {object} cfg
 * @param {string} cfg.serverURL    Actual server URL
 * @param {string} cfg.password     Actual server password
 * @param {string} cfg.budgetSyncId budget sync id (downloads this budget)
 * @param {string} [cfg.dataDir]    directory where budget data is stored
 * @param {object} [deps]
 * @param {object} [deps.apiModule] @actual-app/api namespace (injectable for tests)
 */
export async function connect(
  { serverURL, password, budgetSyncId, dataDir } = {},
  { apiModule = actualApi } = {},
) {
  // v26 init accepts serverURL/password and uses them for server-backed
  // sessions; dataDir defaults to the working directory when omitted.
  const engine = await apiModule.init({ serverURL, password, dataDir });

  const api = {
    ...engine,
    downloadBudget: (syncId, opts) => apiModule.downloadBudget(syncId, opts),
    importTransactions: (accountId, txns, opts) =>
      apiModule.importTransactions(accountId, txns, opts),
    getTransactions: (accountId, start, end) =>
      apiModule.getTransactions(accountId, start, end),
    getIDByName: (type, name) => apiModule.getIDByName(type, name),
    getAccounts: () => apiModule.getAccounts(),
    shutdown: () => apiModule.shutdown(),
  };

  await api.downloadBudget(budgetSyncId, { password });
  return api;
}

/**
 * Resolves an account id by name, preferring getIDByName with a list-based
 * fallback for robustness.
 *
 * @returns {Promise<string>} account id
 */
export async function resolveAccount(api, name) {
  try {
    const id = await api.getIDByName('accounts', name);
    if (id) return id;
  } catch {
    // fall through to list-based lookup
  }
  const accounts = await api.getAccounts();
  const match = accounts.find((account) => account.name === name);
  if (!match) {
    throw new Error(`Actual account not found: ${name}`);
  }
  return match.id;
}

/**
 * Imports transactions into an Actual account.
 *
 * With {dryRun: true} returns a preview result without touching Actual.
 * Otherwise forwards to importTransactions with {reimportDeleted: false} and
 * returns its {errors, added, updated} result.
 *
 * @param {object} api       handle from connect()
 * @param {string} accountId
 * @param {Array<object>} txns
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{errors: Array<object>, added: Array<unknown>, updated: Array<unknown>}>}
 */
export async function importTxns(api, accountId, txns, { dryRun = false } = {}) {
  if (dryRun) {
    return { added: [], updated: [], errors: [] };
  }
  return api.importTransactions(accountId, txns, { reimportDeleted: false });
}

/**
 * Lists transactions for an account in a date range.
 * @returns {Promise<Array<object>>}
 */
export async function getTransactions(api, accountId, start, end) {
  return api.getTransactions(accountId, start, end);
}