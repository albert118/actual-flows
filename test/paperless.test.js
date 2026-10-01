import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaperlessClient } from '../src/paperless.js';

// --- fetch stubs -----------------------------------------------------------

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', init });
    return handler(new URL(String(url)), init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// --- fixtures --------------------------------------------------------------

const IMPORTED_FIELD_ID = 7;
const FIELD_NAME_TO_ID = { actual_transaction_id: IMPORTED_FIELD_ID };

// Simulates Paperless server-side behaviour: only docs that do NOT carry the
// imported custom field survive custom_field_query exists=false, paginated by
// page_size with an absolute `next` URL.
function makeDocumentsApi(docs, pageSize) {
  return (url, init) => {
    const params = url.searchParams;
    const [fieldName, , exists] = JSON.parse(params.get('custom_field_query'));
    assert.equal(exists, false, 'server query asks for non-existing field');
    const fieldId = FIELD_NAME_TO_ID[fieldName];
    const pageSizeActual = Number(params.get('page_size'));

    const isImported = (doc) =>
      Array.isArray(doc.custom_fields) &&
      doc.custom_fields.some(
        (entry) =>
          entry &&
          entry.field === fieldId &&
          entry.value != null &&
          entry.value !== '',
      );

    const filtered = docs.filter((doc) => !isImported(doc));
    const page = Number(params.get('page') ?? '1');
    const start = (page - 1) * pageSizeActual;
    const results = filtered.slice(start, start + pageSizeActual);
    const total = filtered.length;
    const next =
      start + results.length < total
        ? `${url.origin}/api/documents/?page=${page + 1}&page_size=${pageSizeActual}&custom_field_query=${params.get('custom_field_query')}&ordering=added`
        : null;
    return Promise.resolve(jsonResponse({ count: total, next, previous: null, results }));
  };
}

function baseDoc(overrides) {
  return {
    id: 1,
    title: 'doc',
    content: 'ocr content',
    tags: [],
    document_type: null,
    correspondent: null,
    created: '2026-01-01T00:00:00Z',
    custom_fields: [],
    ...overrides,
  };
}

const SIGNALS = { tagIds: [10], documentTypeIds: [], correspondentIds: [] };
const CUSTOM_FIELD_IDS = new Map([['actual_transaction_id', IMPORTED_FIELD_ID]]);

// --- AC5 -------------------------------------------------------------------

test('AC5: listCandidateDocs filters unimported docs, paginated', async () => {
  const docs = [
    baseDoc({ id: 1, title: 'first candidate', tags: [10] }),
    baseDoc({
      id: 2,
      title: 'already imported',
      tags: [10],
      custom_fields: [{ field: IMPORTED_FIELD_ID, value: 'txn-9' }],
    }),
    baseDoc({ id: 3, title: 'no matching signal' }),
    baseDoc({ id: 4, title: 'second page candidate', tags: [10] }),
  ];
  const fetchImpl = makeFetch(makeDocumentsApi(docs));
  const client = createPaperlessClient({
    baseUrl: 'http://paperless:8000',
    token: 'sekrit',
    apiVersion: 10,
    fetchImpl,
  });

  const candidates = await client.listCandidateDocs({
    importedFieldName: 'actual_transaction_id',
    pageSize: 2,
    signals: SIGNALS,
    customFieldIds: CUSTOM_FIELD_IDS,
  });

  assert.deepEqual(
    candidates.map((d) => d.id),
    [1, 4],
    'only unimported, signal-matching docs across pages',
  );

  const firstCall = new URL(fetchImpl.calls[0].url);
  assert.equal(firstCall.pathname, '/api/documents/');
  assert.equal(firstCall.searchParams.get('custom_field_query'), '["actual_transaction_id","exists",false]');
  assert.equal(firstCall.searchParams.get('page_size'), '2');
  assert.equal(firstCall.searchParams.get('ordering'), 'added');
  // Two pages were fetched: first URL + the absolute `next` URL.
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls[1].url.includes('page=2'));
});

test('AC5b: defends client-side against docs that already carry the imported field', async () => {
  // Server-side filter is "broken" here: it returns a doc with the imported
  // field already set; the client must still drop it using customFieldIds.
  const sneaky = baseDoc({
    id: 9,
    title: 'sneaky imported',
    tags: [10],
    custom_fields: [{ field: IMPORTED_FIELD_ID, value: 'txn-1' }],
  });
  const fetchImpl = makeFetch(() =>
    Promise.resolve(jsonResponse({ count: 1, next: null, previous: null, results: [sneaky] })),
  );
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  const candidates = await client.listCandidateDocs({
    importedFieldName: 'actual_transaction_id',
    signals: SIGNALS,
    customFieldIds: CUSTOM_FIELD_IDS,
  });

  assert.deepEqual(candidates, []);
});

// --- listSignalDocsInRange (reconcile) --------------------------------------

// Generic paginated documents handler WITHOUT the custom_field_query filter:
// listSignalDocsInRange lists every signal doc, filtered client-side.
function makeRangeDocsApi(docs, pageSize) {
  return (url) => {
    const params = url.searchParams;
    const page = Number(params.get('page') ?? '1');
    const pageSizeActual = Number(params.get('page_size'));
    const start = (page - 1) * pageSizeActual;
    const results = docs.slice(start, start + pageSizeActual);
    const next =
      start + results.length < docs.length
        ? `${url.origin}/api/documents/?page=${page + 1}&page_size=${pageSizeActual}&ordering=added`
        : null;
    return Promise.resolve(
      jsonResponse({ count: docs.length, next, previous: null, results }),
    );
  };
}

test('listSignalDocsInRange returns signal docs in range with importedValue', async () => {
  const docs = [
    baseDoc({ id: 1, title: 'in window, imported', tags: [10], created: '2025-08-01T00:00:00Z', custom_fields: [{ field: IMPORTED_FIELD_ID, value: 'txn-1' }] }),
    baseDoc({ id: 2, title: 'in window, unimported', tags: [10], created: '2025-12-01T00:00:00Z' }),
    baseDoc({ id: 3, title: 'before start', tags: [10], created: '2025-06-30T23:59:59Z' }),
    baseDoc({ id: 4, title: 'after end', tags: [10], created: '2027-07-01T00:00:00Z' }),
    baseDoc({ id: 5, title: 'no signal', created: '2025-09-01T00:00:00Z' }),
  ];
  const fetchImpl = makeFetch(makeRangeDocsApi(docs));
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  const found = await client.listSignalDocsInRange({
    importedFieldName: 'actual_transaction_id',
    signals: SIGNALS,
    customFieldIds: CUSTOM_FIELD_IDS,
    start: '2025-07-01',
    end: '2027-06-30',
  });

  assert.deepEqual(found, [
    { id: 1, title: 'in window, imported', importedValue: 'txn-1' },
    { id: 2, title: 'in window, unimported', importedValue: null },
  ]);
  // In-range but non-signal docs are excluded too, and no custom_field_query
  // filter is applied (unlike listCandidateDocs).
  const firstUrl = new URL(fetchImpl.calls[0].url);
  assert.equal(firstUrl.searchParams.get('custom_field_query'), null);
  assert.equal(firstUrl.searchParams.get('ordering'), 'added');
});

test('listSignalDocsInRange is paginated and prefers `added` over `created`', async () => {
  const docs = [
    baseDoc({ id: 1, tags: [10], created: '2025-07-01T00:00:00Z' }),
    baseDoc({ id: 2, tags: [10], created: '2025-06-01T00:00:00Z', added: '2025-08-01T00:00:00Z' }),
    baseDoc({ id: 3, tags: [10], created: '2025-09-01T00:00:00Z' }),
  ];
  const fetchImpl = makeFetch(makeRangeDocsApi(docs));
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  const found = await client.listSignalDocsInRange({
    importedFieldName: 'actual_transaction_id',
    signals: SIGNALS,
    customFieldIds: CUSTOM_FIELD_IDS,
    start: '2025-07-01',
    end: '2025-12-31',
    pageSize: 2,
  });

  // Doc 2 created in June but added in August is kept (added wins); doc 3 is
  // returned via the second page.
  assert.deepEqual(found.map((d) => d.id), [1, 2, 3]);
  assert.equal(fetchImpl.calls.length, 2, 'paginated across two pages');
});

test('listSignalDocsInRange returns null importedValue when the field is unset', async () => {
  const docWithEmpty = baseDoc({
    id: 1,
    tags: [10],
    created: '2025-08-01T00:00:00Z',
    custom_fields: [{ field: IMPORTED_FIELD_ID, value: '' }],
  });
  const fetchImpl = makeFetch(makeRangeDocsApi([docWithEmpty]));
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  const found = await client.listSignalDocsInRange({
    importedFieldName: 'actual_transaction_id',
    signals: SIGNALS,
    customFieldIds: CUSTOM_FIELD_IDS,
    start: '2025-07-01',
    end: '2025-12-31',
  });

  assert.deepEqual(found, [{ id: 1, title: 'doc', importedValue: null }]);
});

// --- listCustomFields, tags, getDocument -----------------------------------

test('listCustomFields maps custom field names to ids', async () => {
  const fetchImpl = makeFetch(() =>
    Promise.resolve(
      jsonResponse([
        { id: 7, name: 'actual_transaction_id' },
        { id: 8, name: 'actual_status' },
      ]),
    ),
  );
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  const byName = await client.listCustomFields();

  assert.equal(byName.get('actual_transaction_id'), 7);
  assert.equal(byName.get('actual_status'), 8);
  assert.equal(byName.size, 2);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://paperless:8000/api/custom_fields/');
  assert.equal(call.init.headers.Authorization, 'Token t');
  assert.equal(call.init.headers.Accept, 'application/json; version=10');
});

test('listCustomFields accepts a paginated {results} object response', async () => {
  // Some Paperless versions return a paginated envelope instead of a bare
  // array; the helper must read rows from `results` in that case.
  const fetchImpl = makeFetch(() =>
    Promise.resolve(
      jsonResponse({
        count: 2,
        next: null,
        previous: null,
        results: [
          { id: 7, name: 'actual_transaction_id' },
          { id: 8, name: 'actual_status' },
        ],
      }),
    ),
  );
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  const byName = await client.listCustomFields();

  assert.equal(byName.get('actual_transaction_id'), 7);
  assert.equal(byName.get('actual_status'), 8);
  assert.equal(byName.size, 2);
});

test('tagIdByName resolves a tag id, or null when missing', async () => {
  const fetchImpl = makeFetch(() =>
    Promise.resolve(jsonResponse([{ id: 5, name: 'invoice' }, { id: 6, name: 'bill' }])),
  );
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  assert.equal(await client.tagIdByName('invoice'), 5);
  assert.equal(await client.tagIdByName('nope'), null);
});

test('ensureTag returns the existing tag id without POSTing', async () => {
  let posts = 0;
  const fetchImpl = makeFetch((url, init) => {
    if (init.method === 'POST') posts += 1;
    return Promise.resolve(jsonResponse([{ id: 5, name: 'invoice' }]));
  });
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  assert.equal(await client.ensureTag('invoice'), 5);
  assert.equal(posts, 0);
});

test('ensureTag POSTs a new tag when the name is missing', async () => {
  const fetchImpl = makeFetch((url, init) => {
    if (init.method === 'POST') {
      return Promise.resolve(jsonResponse({ id: 42, name: 'needed' }, 201));
    }
    return Promise.resolve(jsonResponse([])); // no existing tags
  });
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  assert.equal(await client.ensureTag('needed'), 42);

  const post = fetchImpl.calls.find((c) => c.method === 'POST');
  assert.ok(post, 'a POST was made');
  assert.equal(new URL(post.url).pathname, '/api/tags/');
  assert.deepEqual(JSON.parse(post.init.body), { name: 'needed' });
});

test('getDocument returns the full document', async () => {
  const doc = baseDoc({ id: 42, title: 'full', content: 'lots of ocr' });
  const fetchImpl = makeFetch(() => Promise.resolve(jsonResponse(doc)));
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  const fetched = await client.getDocument(42);

  assert.equal(fetched.id, 42);
  assert.equal(fetchImpl.calls[0].url, 'http://paperless:8000/api/documents/42/');
});

// --- AC6 -------------------------------------------------------------------

test('AC6: updateDoc PATCHes custom fields and tags in one body', async () => {
  const fetchImpl = makeFetch(() =>
    Promise.resolve(
      jsonResponse({
        id: 7,
        title: 'updated',
        custom_fields: [{ field: 12, value: 'txn-123' }],
        tags: [4, 9],
      }),
    ),
  );
  const client = createPaperlessClient({
    baseUrl: 'http://paperless:8000/',
    token: 'sekrit',
    apiVersion: 10,
    fetchImpl,
  });

  const updated = await client.updateDoc(7, {
    custom_fields: [{ field: 12, value: 'txn-123' }],
    tags: [4, 9],
  });

  assert.equal(updated.id, 7);
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url, 'http://paperless:8000/api/documents/7/');
  assert.equal(call.init.headers.Authorization, 'Token sekrit');
  assert.equal(call.init.headers.Accept, 'application/json; version=10');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body), {
    custom_fields: [{ field: 12, value: 'txn-123' }],
    tags: [4, 9],
  });
});

test('updateDoc omits absent keys from the PATCH body', async () => {
  const fetchImpl = makeFetch(() => Promise.resolve(jsonResponse({ id: 7, tags: [4] })));
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  await client.updateDoc(7, { tags: [4] });

  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { tags: [4] });
});

test('paperless client surfaces API errors with status', async () => {
  const fetchImpl = makeFetch(() => Promise.resolve(jsonResponse({ error: 'nope' }, 404)));
  const client = createPaperlessClient({ baseUrl: 'http://paperless:8000', token: 't', fetchImpl });

  await assert.rejects(() => client.getDocument(999), /HTTP 404/);
});