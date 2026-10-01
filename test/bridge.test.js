import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, NEEDS_REVIEW_TAG, POSSIBLE_DUPLICATE_TAG } from '../src/bridge.js';

// Stage 4 orchestration tests with fully injected fake paperless/actual/parse
// clients — no real network, no @actual-app/api involvement.

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

// field name -> id, mirroring a Paperless custom_fields listing.
const FIELD_IDS = {
  actual_transaction_id: 1,
  actual_status: 2,
  actual_amount: 3,
  actual_date: 4,
  actual_payee: 5,
  actual_currency: 6,
};

const doc = (id, overrides = {}) => ({
  id,
  title: `Doc ${id}`,
  content: 'Total: $50.00',
  created: '2026-09-30T00:00:00Z',
  document_type: null,
  correspondent: 'Acme',
  tags: [],
  custom_fields: [],
  ...overrides,
});

const GOOD_PARSE = {
  ok: true,
  amount: -5000,
  date: '2026-10-01',
  payee: 'Acme',
  currency: 'AUD',
  sign: 'expense',
  confidence: 'high',
  foreign: false,
  reason: null,
};

const NEEDS_REVIEW_PARSE = {
  ok: false,
  amount: null,
  date: null,
  payee: null,
  currency: 'AUD',
  sign: 'unknown',
  confidence: 'low',
  foreign: false,
  reason: 'no-amount',
};

/**
 * Fake Paperless client. Records every PATCH (writes) and every candidate
 * listing (candidateCalls), and counts tag creations (ensureCalls) so tests
 * can assert dry-run and needs-review behaviour precisely.
 */
function makePaperless({ candidates = [], tagNames = {}, docTypes = {}, correspondents = {} } = {}) {
  let nextTagId = 1000;
  const writes = [];
  const candidateCalls = [];
  let ensureCalls = 0;

  const paperless = {
    listCustomFields: async () => new Map(Object.entries(FIELD_IDS)),
    listDocumentTypes: async () => new Map(Object.entries(docTypes)),
    listCorrespondents: async () => new Map(Object.entries(correspondents)),
    tagIdByName: async (name) => tagNames[name] ?? null,
    ensureTag: async (name) => {
      ensureCalls += 1;
      if (!(name in tagNames)) tagNames[name] = nextTagId++;
      return tagNames[name];
    },
    listCandidateDocs: async (opts) => {
      candidateCalls.push(opts);
      return candidates;
    },
    updateDoc: async (id, changes) => {
      writes.push({ id, changes });
      return { id };
    },
  };
  paperless.writes = writes;
  paperless.candidateCalls = candidateCalls;
  paperless.ensureCalls = () => ensureCalls;
  paperless.tagNames = tagNames;
  return paperless;
}

/**
 * Fake Actual api handle (the shape connect() returns). `accounts` lists the
 * account names that exist; ids are derived as `acct-<lowercased name>` so
 * `Cash` resolves to `acct-cash` as before. `getIDByName` returns null for
 * names outside the list, so resolveAccount falls back to getAccounts() and
 * throws when the account genuinely does not exist. `transactions` is what
 * getTransactions returns; it can be replaced later via setTransactions().
 */
function makeActual({
  added = [],
  updated = [],
  errors = [],
  shutdown = async () => {},
  accounts = [CONFIG.actual.defaultAccountName],
  transactions = [],
} = {}) {
  const imports = [];
  const txnCalls = [];
  let txnList = transactions;
  const byName = new Map(accounts.map((name) => [name, `acct-${name.toLowerCase()}`]));
  const handle = {
    getIDByName: async (type, name) => byName.get(name) ?? null,
    getAccounts: async () =>
      [...byName].map(([name, id]) => ({ id, name })),
    importTransactions: async (accountId, txns, opts) => {
      imports.push({ accountId, txns, opts });
      return { errors, added, updated };
    },
    getTransactions: async (accountId, start, end) => {
      txnCalls.push({ accountId, start, end });
      return txnList;
    },
    shutdown,
  };
  handle.imports = imports;
  handle.txnCalls = txnCalls;
  handle.setTransactions = (next) => {
    txnList = next;
  };
  return handle;
}

const parseThat = (map) => (d) => {
  const stub = map[d.id];
  if (!stub) throw new Error(`no parse stub for doc ${d.id}`);
  return stub(d);
};

// --- AC16 -------------------------------------------------------------------

test('AC16: import skips already-imported docs', async () => {
  const already = doc(7, { custom_fields: [{ field: 1, value: 'txn-9' }] });
  const paperless = makePaperless({ candidates: [already] });
  const actual = makeActual({ added: ['txn-1'] });
  // A parse that would import if reached — the skip must happen first.
  const bridge = createBridge({ config: CONFIG, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.import();

  assert.equal(paperless.writes.length, 0, 'no PATCH for an already-imported doc');
  assert.equal(actual.imports.length, 0, 'no transaction imported for an already-imported doc');
  assert.deepEqual(res.results, [{ docId: 7, status: 'skipped' }]);
});

// --- AC17 -------------------------------------------------------------------

test('AC17: import writes transaction id back with status imported', async () => {
  const candidate = doc(7);
  const paperless = makePaperless({ candidates: [candidate] });
  const actual = makeActual({ added: ['txn-abc'], updated: [] });
  const bridge = createBridge({ config: CONFIG, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.import();

  assert.equal(res.results[0].status, 'imported');
  assert.equal(res.results[0].txnId, 'txn-abc');

  const finalPatch = paperless.writes.at(-1);
  assert.equal(finalPatch.id, 7);
  const cf = finalPatch.changes.custom_fields;
  assert.ok(
    cf.some((e) => e.field === 1 && e.value === 'txn-abc'),
    'PATCH carries actual_transaction_id from Actual returned id',
  );
  assert.ok(
    cf.some((e) => e.field === 2 && e.value === 'imported'),
    "PATCH carries status 'imported'",
  );

  // Parsed fields are written back to Paperless in the earlier PATCH.
  const parsedPatch = paperless.writes[0];
  const parsedCf = parsedPatch.changes.custom_fields;
  assert.ok(parsedCf.some((e) => e.field === 3 && e.value === '-50.00'), 'amount written back');
  assert.ok(parsedCf.some((e) => e.field === 4 && e.value === '2026-10-01'), 'date written back');
  assert.ok(parsedCf.some((e) => e.field === 5 && e.value === 'Acme'), 'payee written back');
  assert.ok(parsedCf.some((e) => e.field === 6 && e.value === 'AUD'), 'currency written back');
});

// --- AC18 -------------------------------------------------------------------

test('AC18: import uses paperless-prefixed imported_id', async () => {
  const candidate = doc(42);
  const paperless = makePaperless({ candidates: [candidate] });
  const actual = makeActual({ added: ['txn-42'] });
  const bridge = createBridge({ config: CONFIG, paperless, actual, parse: () => GOOD_PARSE });

  await bridge.import();

  assert.equal(actual.imports.length, 1);
  assert.equal(actual.imports[0].accountId, 'acct-cash');
  assert.equal(actual.imports[0].txns.length, 1);
  assert.equal(actual.imports[0].txns[0].imported_id, 'paperless:42');
});

// --- AC19 -------------------------------------------------------------------

test('AC19: needs-review docs are not imported, are tagged and get status set', async () => {
  const candidate = doc(9);
  const paperless = makePaperless({ candidates: [candidate] });
  const actual = makeActual({ added: ['txn-should-not-happen'] });
  const bridge = createBridge({ config: CONFIG, paperless, actual, parse: () => NEEDS_REVIEW_PARSE });

  const res = await bridge.import();

  assert.equal(actual.imports.length, 0, 'no transaction created for a needs-review doc');
  assert.equal(res.results[0].status, 'needs-review');
  assert.equal(res.results[0].reason, 'no-amount');

  const patch = paperless.writes.at(-1);
  const cf = patch.changes.custom_fields;
  assert.ok(cf.some((e) => e.field === 2 && e.value === 'needs-review'), "status set to 'needs-review'");
  // needs-review tag was ensured and attached.
  const reviewTagId = paperless.tagNames[NEEDS_REVIEW_TAG];
  assert.ok(reviewTagId != null, 'needs-review tag was created');
  assert.ok(patch.changes.tags.includes(reviewTagId), 'doc is tagged needs-review');
});

test('AC19b: foreign docs are routed to needs-review and not imported', async () => {
  const candidate = doc(10);
  const paperless = makePaperless({ candidates: [candidate] });
  const actual = makeActual({});
  const foreign = {
    ...GOOD_PARSE,
    ok: false,
    amount: null,
    currency: 'USD',
    foreign: true,
    reason: 'foreign-currency',
    confidence: 'medium',
  };
  const bridge = createBridge({ config: CONFIG, paperless, actual, parse: () => foreign });

  const res = await bridge.import();

  assert.equal(actual.imports.length, 0);
  assert.equal(res.results[0].status, 'needs-review');
  assert.equal(res.results[0].reason, 'foreign-currency');
  const patch = paperless.writes.at(-1);
  const cf = patch.changes.custom_fields;
  assert.ok(cf.some((e) => e.field === 2 && e.value === 'needs-review'));
});

test('AC19c: low-confidence parses are routed to needs-review', async () => {
  const candidate = doc(11);
  const paperless = makePaperless({ candidates: [candidate] });
  const actual = makeActual({});
  const low = { ...GOOD_PARSE, ok: true, confidence: 'low' };
  const bridge = createBridge({ config: CONFIG, paperless, actual, parse: () => low });

  const res = await bridge.import();

  assert.equal(actual.imports.length, 0);
  assert.equal(res.results[0].status, 'needs-review');
});

// --- AC20 -------------------------------------------------------------------

test('AC20: a failed doc does not abort the batch', async () => {
  const bad = doc(1);
  const good = doc(2);
  const paperless = makePaperless({ candidates: [bad, good] });
  const actual = makeActual({ added: ['txn-2'] });
  const bridge = createBridge({
    config: CONFIG,
    paperless,
    actual,
    parse: parseThat({ 1: () => { throw new Error('boom'); }, 2: () => GOOD_PARSE }),
  });

  let res;
  await assert.doesNotReject(async () => {
    res = await bridge.import();
  });

  // The good doc was still imported.
  const goodPatch = paperless.writes.filter((w) => w.id === 2).at(-1);
  assert.ok(
    goodPatch.changes.custom_fields.some((e) => e.field === 1 && e.value === 'txn-2'),
    'successful doc is imported',
  );
  assert.equal(actual.imports.length, 1);

  // The failing doc got status 'error' and the batch completed.
  const badPatch = paperless.writes.find((w) => w.id === 1);
  assert.ok(
    badPatch.changes.custom_fields.some((e) => e.field === 2 && e.value === 'error'),
    "failing doc gets status 'error'",
  );
  const statuses = res.results.map((r) => r.status);
  assert.deepEqual(statuses, ['error', 'imported']);
});

// --- dry-run makes zero writes ----------------------------------------------

test('dry run makes zero writes to Paperless and Actual', async () => {
  const candidate = doc(42);
  const paperless = makePaperless({ candidates: [candidate], tagNames: { invoice: 10 } });
  const actual = makeActual({ added: ['txn-x'] });
  let parseCalls = 0;
  const bridge = createBridge({
    config: CONFIG,
    paperless,
    actual,
    parse: () => { parseCalls += 1; return GOOD_PARSE; },
  });

  const res = await bridge.dryRun();

  assert.equal(paperless.writes.length, 0, 'no PATCH writes in dry run');
  assert.equal(paperless.ensureCalls(), 0, 'no tag creation in dry run (read-only tagIdByName)');
  assert.equal(actual.imports.length, 0, "Actual is never touched in dry run");
  assert.ok(parseCalls >= 1, 'candidates are parsed');
  assert.equal(res.planned.length, 1);
  assert.equal(res.planned[0].parsed.amount, -5000);
  assert.equal(res.planned[0].parsed.confidence, 'high');
});

test('dry run resolves signal names via read-only lookups', async () => {
  const candidate = doc(42);
  const paperless = makePaperless({
    candidates: [candidate],
    tagNames: { invoice: 10 },
    docTypes: { statement: 20 },
    correspondents: { 'ACME Ltd': 30 },
  });
  const bridge = createBridge({
    config: {
      ...CONFIG,
      signals: { tags: ['invoice'], documentTypes: ['statement'], correspondents: ['ACME Ltd'] },
    },
    paperless,
    actual: makeActual({}),
    parse: () => GOOD_PARSE,
  });

  await bridge.dryRun();

  assert.equal(paperless.candidateCalls.length, 1);
  // listCandidateDocs receives name→id-resolved signal id lists.
  assert.deepEqual(paperless.candidateCalls[0].signals, {
    tagIds: [10],
    documentTypeIds: [20],
    correspondentIds: [30],
  });
  assert.equal(paperless.candidateCalls[0].importedFieldName, 'actual_transaction_id');
  assert.equal(paperless.writes.length, 0);
});

test('import resolves signal tag names with ensureTag (creating when missing)', async () => {
  const candidate = doc(42);
  const paperless = makePaperless({ candidates: [candidate] }); // no 'invoice' tag exists
  const bridge = createBridge({ config: CONFIG, paperless, actual: makeActual({ added: ['t'] }), parse: () => GOOD_PARSE });

  await bridge.import();

  assert.equal(paperless.ensureCalls(), 1, 'import creates the configured signal tag');
  assert.equal(paperless.candidateCalls[0].signals.tagIds.length, 1);
});

// --- check ------------------------------------------------------------------

test('check verifies custom fields and resolves the Actual account', async () => {
  const paperless = makePaperless({});
  const actual = makeActual({});
  const bridge = createBridge({ config: CONFIG, paperless, actual });

  const result = await bridge.check();

  assert.equal(result.customFieldsOk, true);
  assert.equal(result.accountId, 'acct-cash');
});

test('check fails clearly when a configured custom field is missing', async () => {
  const paperless = makePaperless({});
  const orig = paperless.listCustomFields.bind(paperless);
  paperless.listCustomFields = async () => {
    const map = await orig();
    assert.equal(map.delete('actual_currency'), true);
    return map;
  };
  const bridge = createBridge({ config: CONFIG, paperless, actual: makeActual({}) });

  await assert.rejects(() => bridge.check(), /actual_currency/);
});

// --- once / shutdown ---------------------------------------------------------

test('once runs a single import pass; shutdown delegates to the Actual handle', async () => {
  const candidate = doc(5);
  const paperless = makePaperless({ candidates: [candidate] });
  let shutdownCalls = 0;
  const actual = makeActual({ added: ['txn-5'], shutdown: async () => { shutdownCalls += 1; } });
  const bridge = createBridge({ config: CONFIG, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.once();
  assert.equal(res.results[0].status, 'imported');
  assert.equal(actual.imports.length, 1, 'exactly one pass');

  await bridge.shutdown();
  assert.equal(shutdownCalls, 1);
});

test('poll stops cleanly when the abort signal fires (CLI SIGINT/SIGTERM path)', { timeout: 5000 }, async () => {
  let passes = 0;
  const paperless = makePaperless({});
  paperless.listCandidateDocs = async () => {
    passes += 1;
    return [];
  };
  const bridge = createBridge({ config: CONFIG, paperless, actual: makeActual({}), parse: () => GOOD_PARSE });

  const stop = new AbortController();
  const pollPromise = bridge.poll({ intervalMs: 25, signal: stop.signal });

  // Let a pass + sleep cycle start, then abort as SIGINT/SIGTERM would.
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop.abort();

  await pollPromise; // must resolve, not hang
  assert.ok(passes >= 1, 'at least one pass ran before the stop');

  await bridge.shutdown();
});

// --- Stage 2: per-signal account mapping ------------------------------------

test('AC6: signalled account wins for a matching doc', async () => {
  const candidate = doc(1, { tags: [10] });
  const paperless = makePaperless({ candidates: [candidate], tagNames: { bill: 10 } });
  const actual = makeActual({ added: ['txn-1'], accounts: ['Cash', 'Amex'] });
  const bridge = createBridge({
    config: {
      ...CONFIG,
      signals: { tags: [{ name: 'bill', account: 'Amex' }], documentTypes: [], correspondents: [] },
    },
    paperless,
    actual,
    parse: () => GOOD_PARSE,
  });

  const res = await bridge.import();

  assert.equal(res.results[0].status, 'imported');
  assert.equal(actual.imports.length, 1);
  assert.equal(actual.imports[0].accountId, 'acct-amex');
});

test('AC7: plain-string signals keep the default account', async () => {
  const candidate = doc(1, { tags: [10] });
  const paperless = makePaperless({ candidates: [candidate], tagNames: { invoice: 10 } });
  const actual = makeActual({ added: ['txn-1'], accounts: ['Cash', 'Amex'] });
  const bridge = createBridge({
    config: { ...CONFIG, signals: { tags: ['invoice'], documentTypes: [], correspondents: [] } },
    paperless,
    actual,
    parse: () => GOOD_PARSE,
  });

  const res = await bridge.import();

  assert.equal(res.results[0].status, 'imported');
  assert.equal(actual.imports[0].accountId, 'acct-cash');
});

test('AC8: matched entry without an account field lands in the default account', async () => {
  const candidate = doc(1, { tags: [10] });
  const paperless = makePaperless({ candidates: [candidate], tagNames: { bill: 10 } });
  const actual = makeActual({ added: ['txn-1'], accounts: ['Cash', 'Amex'] });
  const bridge = createBridge({
    config: {
      ...CONFIG,
      signals: { tags: [{ name: 'bill' }], documentTypes: [], correspondents: [] },
    },
    paperless,
    actual,
    parse: () => GOOD_PARSE,
  });

  const res = await bridge.import();

  assert.equal(res.results[0].status, 'imported');
  assert.equal(actual.imports[0].accountId, 'acct-cash');
});

test('AC9: unresolvable mapped account fails that doc only, batch continues', async () => {
  const bad = doc(1, { tags: [10] });
  const good = doc(2, { tags: [11] });
  const paperless = makePaperless({ candidates: [bad, good], tagNames: { bill: 10, receipt: 11 } });
  // 'Nope' is NOT in the account list, so resolveAccount throws.
  const actual = makeActual({ added: ['txn-2'], accounts: ['Cash'] });
  const bridge = createBridge({
    config: {
      ...CONFIG,
      signals: {
        tags: [{ name: 'bill', account: 'Nope' }, { name: 'receipt' }],
        documentTypes: [],
        correspondents: [],
      },
    },
    paperless,
    actual,
    parse: () => GOOD_PARSE,
  });

  let res;
  await assert.doesNotReject(async () => {
    res = await bridge.import();
  });

  const statuses = res.results.map((r) => r.status);
  assert.deepEqual(statuses, ['error', 'imported']);
  const badPatched = paperless.writes.some(
    (w) => w.id === 1 && w.changes.custom_fields.some((e) => e.field === 2 && e.value === 'error'),
  );
  assert.ok(badPatched, "failing doc gets status 'error'");
  // The good doc still imported into the default account.
  assert.equal(actual.imports.length, 1);
  assert.equal(actual.imports[0].accountId, 'acct-cash');
  assert.equal(actual.imports[0].txns[0].imported_id, 'paperless:2');
});

test('Stage2: document-type mapped account is used for a matching doc', async () => {
  const candidate = doc(1, { document_type: 20 });
  const paperless = makePaperless({ candidates: [candidate], docTypes: { statement: 20 } });
  const actual = makeActual({ added: ['txn-1'], accounts: ['Cash', 'Bank'] });
  const bridge = createBridge({
    config: {
      ...CONFIG,
      signals: { tags: [], documentTypes: [{ name: 'statement', account: 'Bank' }], correspondents: [] },
    },
    paperless,
    actual,
    parse: () => GOOD_PARSE,
  });

  const res = await bridge.import();

  assert.equal(res.results[0].status, 'imported');
  assert.equal(actual.imports[0].accountId, 'acct-bank');
});

test('Stage2: precedence — a tag match beats a document-type match', async () => {
  // The doc matches BOTH a mapped tag and a mapped document type; the tag
  // entry wins (tags are checked first per the documented order).
  const candidate = doc(1, { tags: [10], document_type: 20 });
  const paperless = makePaperless({
    candidates: [candidate],
    tagNames: { bill: 10 },
    docTypes: { statement: 20 },
  });
  const actual = makeActual({ added: ['txn-1'], accounts: ['Cash', 'Amex', 'Bank'] });
  const bridge = createBridge({
    config: {
      ...CONFIG,
      signals: {
        tags: [{ name: 'bill', account: 'Amex' }],
        documentTypes: [{ name: 'statement', account: 'Bank' }],
        correspondents: [],
      },
    },
    paperless,
    actual,
    parse: () => GOOD_PARSE,
  });

  await bridge.import();

  assert.equal(actual.imports[0].accountId, 'acct-amex');
});

test('Stage2: precedence — within a kind, first match in config order wins', async () => {
  // The doc carries both tags; 'receipt' appears FIRST in config and has no
  // account, so the import uses the default account despite 'bill'→Amex.
  const candidate = doc(1, { tags: [10, 11] });
  const paperless = makePaperless({ candidates: [candidate], tagNames: { bill: 10, receipt: 11 } });
  const actual = makeActual({ added: ['txn-1'], accounts: ['Cash', 'Amex'] });
  const bridge = createBridge({
    config: {
      ...CONFIG,
      signals: { tags: [{ name: 'receipt' }, { name: 'bill', account: 'Amex' }], documentTypes: [], correspondents: [] },
    },
    paperless,
    actual,
    parse: () => GOOD_PARSE,
  });

  await bridge.import();

  assert.equal(actual.imports[0].accountId, 'acct-cash');
});

test('Stage2: resolveSignalIds extracts names from object entries for candidate listing', async () => {
  const candidate = doc(42);
  const paperless = makePaperless({
    candidates: [candidate],
    tagNames: { invoice: 10 },
    docTypes: { statement: 20 },
    correspondents: { 'ACME Ltd': 30 },
  });
  const bridge = createBridge({
    config: {
      ...CONFIG,
      signals: {
        tags: [{ name: 'invoice' }],
        documentTypes: [{ name: 'statement', account: 'Bank' }],
        correspondents: ['ACME Ltd'],
      },
    },
    paperless,
    actual: makeActual({}),
    parse: () => GOOD_PARSE,
  });

  await bridge.dryRun();

  assert.equal(paperless.candidateCalls.length, 1);
  // The OR-filter receives flat id lists — the mapped account does not
  // influence candidate matching.
  assert.deepEqual(paperless.candidateCalls[0].signals, {
    tagIds: [10],
    documentTypeIds: [20],
    correspondentIds: [30],
  });
  assert.equal(paperless.writes.length, 0);
});

// --- Stage 3: income-by-document-type ----------------------------------------

/** Parses with the real parseDoc's ctx (captured), returning the ctx. */
function bridgeParseCtxVia({ config, paperless, actual }) {
  let seenCtx = null;
  const bridge = createBridge({
    config,
    paperless,
    actual,
    parse: (d, ctx) => {
      seenCtx = ctx;
      return GOOD_PARSE;
    },
  });
  return {
    bridge,
    ctx: () => seenCtx,
  };
}

test('Stage3: buildParseCtx passes resolved income ids from its own config section', async () => {
  const candidate = doc(42, { document_type: 20, tags: [50] });
  const paperless = makePaperless({
    candidates: [candidate],
    tagNames: { invoice: 10, dividend: 50 },
    docTypes: { statement: 20 },
  });
  const harness = bridgeParseCtxVia({
    config: { ...CONFIG, incomeSignals: { documentTypes: ['statement'], tags: ['dividend'] } },
    paperless,
    actual: makeActual({}),
  });

  await harness.bridge.dryRun();

  const ctx = harness.ctx();
  assert.ok(ctx != null, 'parse received a context');
  // Names from the incomeSignals section are preserved...
  assert.deepEqual(ctx.incomeSignals.documentTypes, ['statement']);
  assert.deepEqual(ctx.incomeSignals.tags, ['dividend']);
  // ...and names resolve to numeric Paperless ids for real-doc matching.
  assert.deepEqual(ctx.incomeSignals.documentTypeIds, [20]);
  assert.deepEqual(ctx.incomeSignals.tagIds, [50]);
});

test('Stage3: unresolved income names are logged + skipped, never fatal', async () => {
  const candidate = doc(42);
  const paperless = makePaperless({
    candidates: [candidate],
    tagNames: { invoice: 10 }, // watch signal resolves; income names do not exist
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  let seenCtx = null;
  try {
    const bridge = createBridge({
      config: {
        ...CONFIG,
        incomeSignals: { documentTypes: ['ghost-type'], tags: ['ghost-tag'] },
      },
      paperless,
      actual: makeActual({}),
      parse: (d, ctx) => {
        seenCtx = ctx;
        return GOOD_PARSE;
      },
    });
    await bridge.dryRun();
  } finally {
    console.warn = origWarn;
  }

  assert.ok(seenCtx != null);
  assert.deepEqual(seenCtx.incomeSignals.documentTypeIds, []);
  assert.deepEqual(seenCtx.incomeSignals.tagIds, []);
  assert.equal(warns.length, 2, 'one warning per unresolved income name');
  assert.ok(warns.some((w) => w.includes('income tag "ghost-tag"')), 'warns about the tag');
  assert.ok(warns.some((w) => w.includes('income document type "ghost-type"')), 'warns about the type');
});

test('Stage3: watch signals never leak into incomeSignals (AC13 guard)', async () => {
  // CONFIG has watch signals tags ['invoice'] resolving to id 10, but NO
  // incomeSignals section — the parse ctx must carry no income signal names
  // or ids, so the watch-signal match cannot flip the doc to income.
  const candidate = doc(42, { tags: [10] });
  const paperless = makePaperless({
    candidates: [candidate],
    tagNames: { invoice: 10 },
  });
  const harness = bridgeParseCtxVia({
    config: { ...CONFIG },
    paperless,
    actual: makeActual({}),
  });

  await harness.bridge.dryRun();

  const ctx = harness.ctx();
  assert.ok(ctx != null, 'parse received a context');
  assert.deepEqual(ctx.incomeSignals.documentTypeIds, []);
  assert.deepEqual(ctx.incomeSignals.tagIds, []);
  assert.deepEqual(ctx.incomeSignals.documentTypes, []);
  assert.deepEqual(ctx.incomeSignals.tags, []);
});

test('Stage3: import passes resolved income ids too; income lookups stay read-only', async () => {
  const candidate = doc(7, { tags: [50] });
  const paperless = makePaperless({
    candidates: [candidate],
    tagNames: { invoice: 10, dividend: 50 },
  });
  let seenCtx = null;
  const bridge = createBridge({
    config: { ...CONFIG, incomeSignals: { documentTypes: [], tags: ['dividend'] } },
    paperless,
    actual: makeActual({ added: ['txn-7'] }),
    parse: (d, ctx) => {
      seenCtx = ctx;
      return GOOD_PARSE;
    },
  });

  const res = await bridge.import();

  assert.equal(res.results[0].status, 'imported');
  assert.deepEqual(seenCtx.incomeSignals.tagIds, [50]);
  assert.deepEqual(seenCtx.incomeSignals.documentTypeIds, []);
  // Only the watch signal tag is ensured; the income tag resolved read-only.
  assert.equal(paperless.ensureCalls(), 1, 'income tag is resolved via tagIdByName, never ensured');
});

// --- Tier A item 4: duplicate-guard -----------------------------------------

const GUARD_ON = { ...CONFIG, duplicateGuard: { enabled: true } };

test('AC21: duplicate-guard is off by default — no Actual lookup, import proceeds', async () => {
  const candidate = doc(7);
  const paperless = makePaperless({ candidates: [candidate] });
  // A txn that WOULD match, to prove the guard is what keeps it from being used.
  const actual = makeActual({
    added: ['txn-7'],
    transactions: [
      { id: 't-existing', amount: -5000, date: '2026-10-01', payee_name: 'Acme Pty Ltd' },
    ],
  });
  const bridge = createBridge({ config: CONFIG, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.import();

  assert.equal(actual.txnCalls.length, 0, 'no getTransactions when the guard is off');
  assert.equal(actual.imports.length, 1, 'document is imported as before');
  assert.equal(res.results[0].status, 'imported');
});

test('AC21b: enabled guard tags a matching existing txn as possible-duplicate', async () => {
  const candidate = doc(7);
  const paperless = makePaperless({ candidates: [candidate] });
  const actual = makeActual({
    added: ['should-not-be-used'],
    transactions: [
      // Same amount + date, payee is a superstring of the parsed payee.
      { id: 't-existing', amount: -5000, date: '2026-10-01', payee_name: 'Acme Pty Ltd' },
    ],
  });
  const bridge = createBridge({ config: GUARD_ON, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.import();

  assert.equal(actual.imports.length, 0, 'no transaction imported for a likely duplicate');
  assert.equal(res.results[0].status, 'possible-duplicate');
  assert.equal(res.results[0].matchedTxnId, 't-existing');

  const patch = paperless.writes.at(-1);
  const cf = patch.changes.custom_fields;
  assert.ok(
    cf.some((e) => e.field === 2 && e.value === 'possible-duplicate'),
    "status set to 'possible-duplicate'",
  );
  assert.ok(cf.some((e) => e.field === 3 && e.value === '-50.00'), 'amount written back');
  assert.ok(cf.some((e) => e.field === 4 && e.value === '2026-10-01'), 'date written back');
  assert.ok(cf.some((e) => e.field === 5 && e.value === 'Acme'), 'payee written back');

  const dupTagId = paperless.tagNames[POSSIBLE_DUPLICATE_TAG];
  assert.ok(dupTagId != null, 'possible-duplicate tag was created');
  assert.ok(patch.changes.tags.includes(dupTagId), 'doc is tagged possible-duplicate');

  // Checked the default account over the default 7-day window.
  assert.deepEqual(actual.txnCalls[0], {
    accountId: 'acct-cash',
    start: '2026-09-24',
    end: '2026-10-08',
  });
});

test('AC21c: enabled guard imports when nothing matches (amount/date/payee)', async () => {
  const candidate = doc(7);
  const paperless = makePaperless({ candidates: [candidate] });
  const actual = makeActual({
    added: ['txn-7'],
    transactions: [
      { id: 't-amount', amount: -1234, date: '2026-10-01', payee_name: 'Acme Pty Ltd' },
      { id: 't-date', amount: -5000, date: '2026-10-03', payee_name: 'Acme Pty Ltd' },
      { id: 't-payee', amount: -5000, date: '2026-10-01', payee_name: 'Completely Different' },
    ],
  });
  const bridge = createBridge({ config: GUARD_ON, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.import();

  assert.equal(actual.txnCalls.length, 1, 'the guard checked Actual once');
  assert.equal(actual.imports.length, 1, 'no match means a normal import');
  assert.equal(res.results[0].status, 'imported');
});

test("AC21d: the bridge's own paperless:<docId> txn is not a duplicate", async () => {
  const candidate = doc(7); // no imported field → not skipped as already-imported
  const paperless = makePaperless({ candidates: [candidate] });
  const actual = makeActual({
    added: ['txn-7'],
    transactions: [
      { id: 't-own', amount: -5000, date: '2026-10-01', payee_name: 'Acme', imported_id: 'paperless:7' },
    ],
  });
  const bridge = createBridge({ config: GUARD_ON, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.import();

  assert.equal(res.results[0].status, 'imported', 'own txn does not block the import');
  assert.equal(actual.imports.length, 1);
  assert.equal(actual.imports[0].txns[0].imported_id, 'paperless:7');
});

test('AC21e: a txn outside the window does not flag the doc', async () => {
  const candidate = doc(7);
  const paperless = makePaperless({ candidates: [candidate] });
  // Same amount + matching payee, but dated well outside the window — even if
  // returned by Actual it must not match (the guard checks date equality).
  const actual = makeActual({
    added: ['txn-7'],
    transactions: [{ id: 't-old', amount: -5000, date: '2026-09-20', payee_name: 'Acme' }],
  });
  const bridge = createBridge({
    config: { ...CONFIG, duplicateGuard: { enabled: true, windowDays: 3 } },
    paperless,
    actual,
    parse: () => GOOD_PARSE,
  });

  const res = await bridge.import();

  assert.deepEqual(actual.txnCalls[0], {
    accountId: 'acct-cash',
    start: '2026-09-28',
    end: '2026-10-04',
  });
  assert.equal(res.results[0].status, 'imported', 'out-of-window txn does not flag the doc');
  assert.equal(actual.imports.length, 1);
});

test('AC21f: a getTransactions failure fails that doc only, batch continues', async () => {
  const bad = doc(1);
  const good = doc(2);
  const paperless = makePaperless({ candidates: [bad, good] });
  const actual = makeActual({ added: ['txn-2'] });
  let calls = 0;
  actual.getTransactions = async () => {
    calls += 1;
    if (calls === 1) throw new Error('actual offline');
    return [];
  };
  const bridge = createBridge({ config: GUARD_ON, paperless, actual, parse: () => GOOD_PARSE });

  let res;
  await assert.doesNotReject(async () => {
    res = await bridge.import();
  });

  assert.deepEqual(
    res.results.map((r) => r.status),
    ['error', 'imported'],
  );
  const badPatch = paperless.writes.find((w) => w.id === 1);
  assert.ok(
    badPatch.changes.custom_fields.some((e) => e.field === 2 && e.value === 'error'),
    "failing doc gets status 'error'",
  );
  assert.equal(actual.imports.length, 1);
  assert.equal(actual.imports[0].txns[0].imported_id, 'paperless:2');
});

test('AC21g: a doc already flagged possible-duplicate is terminal (skipped)', async () => {
  const flagged = doc(7, { custom_fields: [{ field: 2, value: 'possible-duplicate' }] });
  const paperless = makePaperless({ candidates: [flagged] });
  const actual = makeActual({
    added: ['txn-7'],
    transactions: [{ id: 't', amount: -5000, date: '2026-10-01', payee_name: 'Acme' }],
  });
  const bridge = createBridge({ config: GUARD_ON, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.import();

  assert.deepEqual(res.results, [{ docId: 7, status: 'skipped' }]);
  assert.equal(actual.txnCalls.length, 0, 'terminal doc is not re-examined');
  assert.equal(paperless.writes.length, 0, 'no re-PATCH for a terminal doc');
  assert.equal(actual.imports.length, 0, 'terminal doc is never imported');
});

test('AC21h: the possible-duplicate tag is ensured once per session', async () => {
  const d1 = doc(1);
  const d2 = doc(2);
  const paperless = makePaperless({ candidates: [d1, d2] });
  const actual = makeActual({
    transactions: [{ id: 't', amount: -5000, date: '2026-10-01', payee_name: 'Acme' }],
  });
  const bridge = createBridge({ config: GUARD_ON, paperless, actual, parse: () => GOOD_PARSE });

  const res = await bridge.import();

  assert.deepEqual(
    res.results.map((r) => r.status),
    ['possible-duplicate', 'possible-duplicate'],
  );
  assert.equal(actual.imports.length, 0);
  // ensureTag calls: the watch signal tag + the possible-duplicate tag once.
  assert.equal(paperless.ensureCalls(), 2, 'possible-duplicate tag ensured once across docs');
  assert.ok(paperless.tagNames[POSSIBLE_DUPLICATE_TAG] != null);
});