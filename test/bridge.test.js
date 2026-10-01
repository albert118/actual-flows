import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, NEEDS_REVIEW_TAG } from '../src/bridge.js';

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

/** Fake Actual api handle (the shape connect() returns). */
function makeActual({ added = [], updated = [], errors = [], shutdown = async () => {} } = {}) {
  const imports = [];
  const handle = {
    getIDByName: async (type, name) => (name === CONFIG.actual.defaultAccountName ? 'acct-cash' : null),
    getAccounts: async () => [{ id: 'acct-cash', name: CONFIG.actual.defaultAccountName }],
    importTransactions: async (accountId, txns, opts) => {
      imports.push({ accountId, txns, opts });
      return { errors, added, updated };
    },
    shutdown,
  };
  handle.imports = imports;
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