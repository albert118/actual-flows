import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReconcile, reconcileWindow } from '../src/report.js';

// Stage 1 reconcile tests with fully injected fake paperless/actual clients —
// no real network, no @actual-app/api involvement. The fake Paperless client
// applies the same client-side date filter as the real listSignalDocsInRange
// so AC4 (window exclusion) is exercised end-to-end.

const CONFIG = {
  paperless: {
    baseUrl: 'http://paperless:8000',
    token: 'tok',
    apiVersion: 10,
    fields: {
      imported: 'actual_transaction_id',
      status: 'actual_status',
      amount: 'actual_amount',
      date: 'actual_date',
      payee: 'actual_payee',
      currency: 'actual_currency',
    },
  },
  actual: {
    serverUrl: 'http://actual-server:5006',
    password: 'pw',
    budgetSyncId: 'sync-1',
    dataDir: '/data',
    defaultAccountName: 'Cash',
  },
  signals: { tags: ['invoice'], documentTypes: [], correspondents: [] },
  locale: { currency: 'AUD', timezone: 'Australia/Sydney', dateFormats: ['d/m/y'] },
};

const FIELD_IDS = new Map([
  ['actual_transaction_id', 1],
  ['actual_status', 2],
  ['actual_amount', 3],
  ['actual_date', 4],
  ['actual_payee', 5],
  ['actual_currency', 6],
]);

/**
 * Fake Paperless client. listSignalDocsInRange applies the same date-part
 * filter as the real client (added ?? created, sliced to YYYY-MM-DD, inclusive
 * range) so window exclusion is observable through runReconcile. Records every
 * call for bounds assertions.
 */
function makePaperless({ docs = [], tagIdsByName = { invoice: 10 } } = {}) {
  const rangeCalls = [];
  const paperless = {
    listCustomFields: async () => new Map(FIELD_IDS),
    listDocumentTypes: async () => new Map(),
    listCorrespondents: async () => new Map(),
    tagIdByName: async (name) => tagIdsByName[name] ?? null,
    getDocument: async () => { throw new Error('getDocument must not be called by reconcile'); },
    updateDoc: async () => { throw new Error('updateDoc must not be called by reconcile (read-only)'); },
    listSignalDocsInRange: async ({ start, end } = {}) => {
      rangeCalls.push({ start, end });
      return docs
        .filter((doc) => String(doc.added ?? doc.created ?? '').slice(0, 10) >= start)
        .filter((doc) => String(doc.added ?? doc.created ?? '').slice(0, 10) <= end)
        .map((doc) => ({ id: doc.id, title: doc.title, importedValue: doc.importedValue }));
    },
  };
  paperless.rangeCalls = rangeCalls;
  return paperless;
}

/** Fake Actual api handle: resolveAccount + getTransactions, zero writes. */
function makeActual({ txns = [], txnsByAccount = null, accounts = null } = {}) {
  const txnCalls = [];
  const imports = [];
  const accountList = accounts ?? [{ id: 'acct-cash', name: CONFIG.actual.defaultAccountName }];
  const idsByName = new Map(accountList.map((a) => [a.name, a.id]));
  const resolveCalls = [];
  const handle = {
    getIDByName: async (type, name) => {
      resolveCalls.push(name);
      return idsByName.get(name) ?? null;
    },
    getAccounts: async () => accountList,
    getTransactions: async (accountId, start, end) => {
      txnCalls.push({ accountId, start, end });
      if (txnsByAccount) return txnsByAccount[accountId] ?? [];
      return txns;
    },
    importTransactions: async () => {
      imports.push(1);
      return { errors: [], added: [], updated: [] };
    },
    shutdown: async () => {},
  };
  handle.txnCalls = txnCalls;
  handle.imports = imports;
  handle.resolveCalls = resolveCalls;
  return handle;
}

const doc = (id, overrides = {}) => ({
  id,
  title: `Doc ${id}`,
  created: '2026-01-15T00:00:00Z',
  importedValue: null,
  ...overrides,
});

const txn = (id, importedId) => ({ id, imported_id: importedId, amount: -5000 });

// --- AC1 -------------------------------------------------------------------

test('AC1: reconcile lists signal docs with no transaction', async () => {
  const paperless = makePaperless({ docs: [doc(1, { importedValue: null })] });
  const actual = makeActual({ txns: [] });

  const result = await runReconcile({ config: CONFIG, paperless, actual });

  assert.deepEqual(result.lists.docsWithoutTxn, [{ id: 1, title: 'Doc 1' }]);
  assert.deepEqual(result.lists.dangling, []);
  assert.deepEqual(result.lists.nonPaperless, []);
  assert.equal(result.implemented, true);
});

test('AC1b: a doc with a set imported value is NOT in list A', async () => {
  const paperless = makePaperless({
    docs: [doc(1, { importedValue: null }), doc(2, { importedValue: 'txn-abc' })],
  });
  const actual = makeActual({ txns: [] });

  const result = await runReconcile({ config: CONFIG, paperless, actual });

  assert.deepEqual(result.lists.docsWithoutTxn, [{ id: 1, title: 'Doc 1' }]);
});

// --- AC2 -------------------------------------------------------------------

test('AC2: reconcile lists dangling paperless:<id> transactions', async () => {
  const paperless = makePaperless({ docs: [doc(5, { importedValue: 'txn-5' })] });
  const actual = makeActual({ txns: [txn('t1', 'paperless:999')] });

  const result = await runReconcile({ config: CONFIG, paperless, actual });

  assert.deepEqual(result.lists.dangling, [
    { txnId: 't1', importedId: 'paperless:999', docId: 999 },
  ]);
  assert.deepEqual(result.lists.docsWithoutTxn, []);
  assert.deepEqual(result.lists.nonPaperless, []);
});

test('AC2b: a satisfied paperless:<id> transaction appears in NO list', async () => {
  const paperless = makePaperless({
    docs: [doc(5, { importedValue: 'txn-5' })],
  });
  const actual = makeActual({ txns: [txn('t1', 'paperless:5')] });

  const result = await runReconcile({ config: CONFIG, paperless, actual });

  assert.deepEqual(result.lists.docsWithoutTxn, []);
  assert.deepEqual(result.lists.dangling, []);
  assert.deepEqual(result.lists.nonPaperless, []);
});

// --- AC3 -------------------------------------------------------------------

test('AC3: reconcile lists non-paperless transactions', async () => {
  const paperless = makePaperless({ docs: [] });
  const actual = makeActual({ txns: [txn('t1', 'statement:cba:1')] });

  const result = await runReconcile({ config: CONFIG, paperless, actual });

  assert.deepEqual(result.lists.nonPaperless, [
    { txnId: 't1', importedId: 'statement:cba:1' },
  ]);
  assert.deepEqual(result.lists.docsWithoutTxn, []);
  assert.deepEqual(result.lists.dangling, []);
});

// --- AC4 -------------------------------------------------------------------

test('AC4: reconcile excludes docs dated before the window', async () => {
  // Default window (today Oct 2026 in Sydney) is [2025-07-01, 2027-06-30].
  const paperless = makePaperless({
    docs: [
      doc(1, { created: '2025-08-15T00:00:00Z', importedValue: null }),
      doc(2, { created: '2024-11-10T00:00:00Z', importedValue: null }), // pre-last-FY
    ],
  });
  const actual = makeActual({ txns: [] });

  const result = await runReconcile({ config: CONFIG, paperless, actual });

  assert.deepEqual(result.lists.docsWithoutTxn, [{ id: 1, title: 'Doc 1' }]);
  assert.ok(
    !result.lists.docsWithoutTxn.some((d) => d.id === 2),
    'pre-window doc is excluded',
  );
});

test('reconcile fetches Actual transactions for the exact window bounds', async () => {
  const paperless = makePaperless({ docs: [] });
  const actual = makeActual({ txns: [] });

  await runReconcile({ config: CONFIG, paperless, actual, year: 2025 });

  const call = actual.txnCalls[0];
  assert.equal(call.accountId, 'acct-cash');
  assert.equal(call.start, '2024-07-01');
  assert.equal(call.end, '2025-06-30');
});

// --- multi-account reconcile -------------------------------------------------

test('AC2c: reconcile fetches mapped-account accounts too (dangling txn in Amex)', async () => {
  // A signal entry {name:'bill', account:'Amex'} means transactions may live
  // in Amex as well as the default Cash account; reconcile must fetch both.
  const config = {
    ...CONFIG,
    signals: { tags: [{ name: 'bill', account: 'Amex' }], documentTypes: [], correspondents: [] },
  };
  const paperless = makePaperless({ docs: [] });
  const actual = makeActual({
    accounts: [
      { id: 'acct-cash', name: CONFIG.actual.defaultAccountName },
      { id: 'acct-amex', name: 'Amex' },
    ],
    txnsByAccount: { 'acct-amex': [txn('t1', 'paperless:999')] },
  });

  const result = await runReconcile({ config, paperless, actual });

  // The Amex account was fetched, so its dangling paperless:<id> shows in B.
  assert.deepEqual(result.lists.dangling, [
    { txnId: 't1', importedId: 'paperless:999', docId: 999 },
  ]);
  assert.deepEqual(result.lists.docsWithoutTxn, []);
  assert.deepEqual(result.lists.nonPaperless, []);
  assert.deepEqual(
    actual.txnCalls.map((c) => c.accountId).sort(),
    ['acct-amex', 'acct-cash'],
    'both the default and the mapped account are fetched',
  );
});

test('reconcile resolves each associated account once (dedupe by name/id)', async () => {
  // Three signal entries map to the same Amex account; it must be resolved
  // and fetched once, alongside the default Cash account.
  const config = {
    ...CONFIG,
    signals: {
      tags: [
        { name: 'bill', account: 'Amex' },
        { name: 'receipt', account: 'Amex' },
      ],
      documentTypes: [{ name: 'statement', account: 'Amex' }],
      correspondents: [],
    },
  };
  const paperless = makePaperless({ docs: [] });
  const actual = makeActual({
    accounts: [
      { id: 'acct-cash', name: CONFIG.actual.defaultAccountName },
      { id: 'acct-amex', name: 'Amex' },
    ],
  });

  await runReconcile({ config, paperless, actual });

  assert.deepEqual([...actual.resolveCalls].sort(), ['Amex', 'Cash']);
  assert.deepEqual(
    actual.txnCalls.map((c) => c.accountId).sort(),
    ['acct-amex', 'acct-cash'],
    'each account is fetched exactly once',
  );
});

// --- window computation ----------------------------------------------------

test('reconcileWindow: explicit year returns the single FY ending that year', () => {
  assert.deepEqual(reconcileWindow({ year: 2025, today: new Date('2026-10-01T00:00:00Z') }), {
    start: '2024-07-01',
    end: '2025-06-30',
    years: 1,
    explicit: true,
  });
});

test('reconcileWindow: default is current + previous FY (Oct 2026 -> FY ending 2027)', () => {
  assert.deepEqual(reconcileWindow({ today: new Date('2026-10-01T00:00:00Z') }), {
    start: '2025-07-01',
    end: '2027-06-30',
    years: 2,
    explicit: false,
  });
});

test('reconcileWindow: June sits in the FY ending that calendar year', () => {
  assert.deepEqual(reconcileWindow({ today: new Date('2026-06-15T00:00:00Z') }), {
    start: '2024-07-01',
    end: '2026-06-30',
    years: 2,
    explicit: false,
  });
});

test('reconcileWindow: July flips into the next FY', () => {
  assert.deepEqual(reconcileWindow({ today: new Date('2026-07-01T00:00:00Z') }), {
    start: '2025-07-01',
    end: '2027-06-30',
    years: 2,
    explicit: false,
  });
});

// --- read-only --------------------------------------------------------------

test('reconcile makes zero writes to Paperless and Actual', async () => {
  const paperless = makePaperless({
    docs: [doc(1, { importedValue: null }), doc(3, { importedValue: 'txn-3' })],
  });
  const actual = makeActual({ txns: [txn('t1', 'paperless:999'), txn('t2', 'bank:1')] });

  await runReconcile({ config: CONFIG, paperless, actual });

  assert.equal(actual.imports.length, 0, 'no importTransactions call');
  assert.ok(paperless.updateDoc, 'fake guards updateDoc (throws if called)');
});