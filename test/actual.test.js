import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, resolveAccount, importTxns, getTransactions } from '../src/actual.js';

// The @actual-app/api module is injected into connect() instead of being
// mocked at the module level, so `npm test` stays a plain `node --test`.

function fakeApiModule(overrides = {}) {
  return {
    init: async () => ({ send: async () => {} }),
    downloadBudget: async () => {},
    shutdown: async () => {},
    importTransactions: async () => ({ errors: [], added: [], updated: [] }),
    getTransactions: async () => [],
    getIDByName: async () => null,
    getAccounts: async () => [],
    ...overrides,
  };
}

const CONFIG = {
  serverURL: 'http://actual-server:5006',
  password: 'pw',
  budgetSyncId: 'sync-1',
  dataDir: '/data',
};

// --- connect ---------------------------------------------------------------

test('connect inits the engine and downloads the budget', async () => {
  const initCalls = [];
  const downloadCalls = [];
  const shutdownCalls = [];

  const apiModule = fakeApiModule({
    init: async (config) => {
      initCalls.push(config);
      return { send: async () => {} };
    },
    downloadBudget: async (syncId, opts) => {
      downloadCalls.push({ syncId, opts });
    },
    shutdown: async () => {
      shutdownCalls.push(1);
    },
  });

  const api = await connect(CONFIG, { apiModule });

  assert.deepEqual(initCalls, [
    { serverURL: 'http://actual-server:5006', password: 'pw', dataDir: '/data' },
  ]);
  assert.deepEqual(downloadCalls, [{ syncId: 'sync-1', opts: { password: 'pw' } }]);

  await api.shutdown();
  assert.equal(shutdownCalls.length, 1);
});

// --- resolveAccount ---------------------------------------------------------

test('resolveAccount uses getIDByName when it returns an id', async () => {
  const api = fakeApiModule({
    getIDByName: async (type, name) => {
      assert.equal(type, 'accounts');
      assert.equal(name, 'Cash');
      return 'acct-cash';
    },
    getAccounts: async () => {
      throw new Error('getAccounts should not be called');
    },
  });

  assert.equal(await resolveAccount(api, 'Cash'), 'acct-cash');
});

test('resolveAccount falls back to getAccounts when getIDByName misses', async () => {
  const api = fakeApiModule({
    getIDByName: async () => null,
    getAccounts: async () => [
      { id: 'a1', name: 'Savings' },
      { id: 'a2', name: 'Cash' },
    ],
  });

  assert.equal(await resolveAccount(api, 'Cash'), 'a2');
});

test('resolveAccount throws when the account does not exist', async () => {
  const api = fakeApiModule({ getIDByName: async () => null, getAccounts: async () => [] });

  await assert.rejects(() => resolveAccount(api, 'Missing'), /Actual account not found: Missing/);
});

// --- AC7 -------------------------------------------------------------------

test('AC7: importTxns forwards a reconciled import', async () => {
  const txns = [{ amount: -5000, payee: 'ACME' }];
  const importCalls = [];

  const apiModule = fakeApiModule({
    importTransactions: async (accountId, transactions, opts) => {
      importCalls.push({ accountId, transactions, opts });
      return { errors: [], added: ['txn-1'], updated: [] };
    },
  });
  const api = await connect(CONFIG, { apiModule });

  const result = await importTxns(api, 'acct-1', txns);

  assert.deepEqual(result, { errors: [], added: ['txn-1'], updated: [] });
  assert.deepEqual(importCalls, [
    { accountId: 'acct-1', transactions: txns, opts: { reimportDeleted: false } },
  ]);
});

// --- AC8 -------------------------------------------------------------------

test('AC8: importTxns with dryRun avoids Actual side effects', async () => {
  let importInvoked = false;
  const apiModule = fakeApiModule({
    importTransactions: async () => {
      importInvoked = true;
      return { errors: [], added: ['txn-1'], updated: [] };
    },
  });
  const api = await connect(CONFIG, { apiModule });

  const result = await importTxns(api, 'acct-1', [{ amount: -5000 }], { dryRun: true });

  assert.equal(importInvoked, false, 'importTransactions must not be called');
  assert.deepEqual(result, { added: [], updated: [], errors: [] });
});

// --- getTransactions --------------------------------------------------------

test('getTransactions forwards account and date range', async () => {
  const from = '2026-09-01';
  const to = '2026-09-30';
  const txns = [{ id: 't1', amount: -1000 }];
  let call;

  const api = fakeApiModule({
    getTransactions: async (accountId, start, end) => {
      call = { accountId, start, end };
      return txns;
    },
  });

  const result = await getTransactions(api, 'acct-1', from, to);

  assert.equal(result, txns);
  assert.deepEqual(call, { accountId: 'acct-1', start: from, end: to });
});