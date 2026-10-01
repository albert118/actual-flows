// Stage 4 orchestration: candidates → parse → write-back fields → import into
// Actual (dedup via `paperless:<id>`) → write `actual_transaction_id` +
// status/tags.
//
// createBridge({config, paperless, actual, parse}) accepts injected
// dependencies for testability. `paperless` and `actual` default to real
// clients (paperless built from config; actual connected lazily on first use);
// `parse` defaults to the real parseDoc.

import { createPaperlessClient } from './paperless.js';
import { connect, resolveAccount, importTxns } from './actual.js';
import { parseDoc } from './parse.js';

export const NEEDS_REVIEW_TAG = 'needs-review';
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

// The six field names config.paperless.fields is expected to carry. check()
// verifies all of them exist in Paperless; import() hard-requires the
// imported/status linkage fields and treats amount/date/payee/currency as
// optional (written back only when present).
const CHECKED_FIELD_ROLES = ['imported', 'status', 'amount', 'date', 'payee', 'currency'];
const IMPORT_REQUIRED_FIELD_ROLES = ['imported', 'status'];

export function createBridge({ config, paperless, actual, parse = parseDoc } = {}) {
  if (config == null || typeof config !== 'object') {
    throw new Error('createBridge requires a resolved config object');
  }

  const fields = config.paperless?.fields ?? {};
  const signals = config.signals ?? {};

  let paperlessClient = paperless ?? null;
  let actualHandle = actual ?? null;
  let actualPromise = null;
  let accountIdPromise = null;
  let customFieldsPromise = null;
  let needsReviewTagIdPromise = null;
  let ensureNeedsReviewTagCount = 0;

  function getPaperless() {
    if (paperlessClient) return paperlessClient;
    paperlessClient = createPaperlessClient({
      baseUrl: config.paperless?.baseUrl,
      token: config.paperless?.token,
      apiVersion: config.paperless?.apiVersion,
    });
    return paperlessClient;
  }

  /** Actual handle: injected, or a lazily-connected real client (cached). */
  function getActual() {
    if (actualHandle) return Promise.resolve(actualHandle);
    if (!actualPromise) {
      actualPromise = connect({
        serverURL: config.actual?.serverUrl,
        password: config.actual?.password,
        budgetSyncId: config.actual?.budgetSyncId,
        dataDir: config.actual?.dataDir,
      }).then((api) => {
        actualHandle = api;
        return api;
      });
    }
    return actualPromise;
  }

  /** name → id map of every Paperless custom field (cached per process). */
  function getCustomFieldIds() {
    if (!customFieldsPromise) customFieldsPromise = getPaperless().listCustomFields();
    return customFieldsPromise;
  }

  /** Resolved Actual account id for config.actual.defaultAccountName (cached). */
  function getAccountId() {
    if (!accountIdPromise) {
      accountIdPromise = getActual().then((api) =>
        resolveAccount(api, config.actual?.defaultAccountName),
      );
    }
    return accountIdPromise;
  }

  function getNeedsReviewTagId() {
    if (!needsReviewTagIdPromise) {
      needsReviewTagIdPromise = getPaperless().tagIdByName(NEEDS_REVIEW_TAG);
    }
    return needsReviewTagIdPromise;
  }

  function fieldId(map, role) {
    const name = fields[role];
    return name != null ? map.get(name) : undefined;
  }

  /** Throws when any of the named field roles is missing from Paperless. */
  function requireFieldIds(map, roles, context) {
    const missing = roles.filter((role) => {
      const name = fields[role];
      return name == null || !map.has(name);
    });
    if (missing.length > 0) {
      throw new Error(
        `${context}: Paperless custom fields missing: ${missing
          .map((role) => `${role}="${fields[role] ?? '<unset>'}"`)
          .join(', ')}`,
      );
    }
  }

  /**
   * Resolves configured signal names to Paperless ids.
   *
   * Tags: name → id via tagIdByName (read-only) or ensureTag (creates missing
   * tags) — `create` is only true for import, never dry-run, so dry-run cannot
   * write. Document types/correspondents resolve via read-only list lookups.
   * Unresolvable signal names are logged and skipped (never fatal).
   */
  async function resolveSignalIds({ create = false } = {}) {
    const pl = getPaperless();
    const listedTags = Array.isArray(signals.tags) ? signals.tags : [];
    const listedDocumentTypes = Array.isArray(signals.documentTypes) ? signals.documentTypes : [];
    const listedCorrespondents = Array.isArray(signals.correspondents) ? signals.correspondents : [];

    const tagIds = [];
    for (const name of listedTags) {
      const id = create ? await pl.ensureTag(name) : await pl.tagIdByName(name);
      if (id != null) tagIds.push(id);
      else console.warn(`ab2pb: signal tag "${name}" does not exist in Paperless; skipping`);
    }

    const documentTypeIds = [];
    const docTypes = await pl.listDocumentTypes();
    for (const name of listedDocumentTypes) {
      const id = docTypes.get(name);
      if (id != null) documentTypeIds.push(id);
      else console.warn(`ab2pb: signal document type "${name}" does not exist; skipping`);
    }

    const correspondentIds = [];
    const correspondents = await pl.listCorrespondents();
    for (const name of listedCorrespondents) {
      const id = correspondents.get(name);
      if (id != null) correspondentIds.push(id);
      else console.warn(`ab2pb: signal correspondent "${name}" does not exist; skipping`);
    }

    return { tagIds, documentTypeIds, correspondentIds };
  }

  /**
   * Builds the parseDoc context from config.
   *
   * incomeSignals carry only the configured signal NAMES (never the resolved
   * ids): real Paperless documents carry numeric tag/document_type ids, so the
   * names are inert in production and income is decided by refund/credit-note
   * keywords — passing resolved ids here would make every watch-signal match
   * (e.g. tag "invoice") flip an expense to income, which is wrong. String-keyed
   * test documents keep the name-based matching from the parse tests.
   */
  function buildParseCtx(customFieldIds) {
    const fieldIds = {};
    for (const role of ['amount', 'date', 'payee']) {
      const name = fields[role];
      if (name != null && customFieldIds.has(name)) fieldIds[name] = customFieldIds.get(name);
    }
    return {
      currency: config.locale?.currency ?? 'AUD',
      timezone: config.locale?.timezone ?? 'Australia/Sydney',
      dateFormats: Array.isArray(config.locale?.dateFormats)
        ? config.locale.dateFormats
        : ['d/m/y'],
      fields: { amount: fields.amount, date: fields.date, payee: fields.payee },
      fieldIds,
      incomeSignals: {
        documentTypes: Array.isArray(signals.documentTypes) ? signals.documentTypes : [],
        tags: Array.isArray(signals.tags) ? signals.tags : [],
      },
    };
  }

  /** True when doc.custom_fields carries a non-empty value for the field id. */
  function hasCustomFieldValue(doc, id) {
    if (id == null || !Array.isArray(doc.custom_fields)) return false;
    return doc.custom_fields.some(
      (entry) =>
        entry &&
        entry.field === id &&
        entry.value != null &&
        entry.value !== '',
    );
  }

  /** Where available, the parsed amount/date/payee/currency as field entries. */
  function parsedFieldEntries(parsed, customFieldIds) {
    const entries = [];
    const add = (role, value) => {
      if (value == null || value === '') return;
      const id = fieldId(customFieldIds, role);
      if (id == null) return;
      entries.push({ field: id, value });
    };
    if (parsed.amount != null) add('amount', (parsed.amount / 100).toFixed(2));
    add('date', parsed.date);
    add('payee', parsed.payee);
    add('currency', parsed.currency);
    return entries;
  }

  /** Pointer to the document in the Paperless web UI, when it can be derived. */
  function paperlessDocUrl(docId) {
    const base = String(config.paperless?.baseUrl ?? '').replace(/\/+$/, '');
    return base ? `${base}/documents/${docId}/` : null;
  }

  function notesFor(doc) {
    const url = paperlessDocUrl(doc.id);
    const title = typeof doc.title === 'string' && doc.title.trim() ? doc.title : 'untitled';
    return url
      ? `Paperless doc ${doc.id} (${title}) - ${url}`
      : `Paperless doc ${doc.id} (${title})`;
  }

  /** Writes parsed fields back to the Paperless doc (no tags/status). */
  async function writeBackParsed(doc, parsed, customFieldIds) {
    const entries = parsedFieldEntries(parsed, customFieldIds);
    if (entries.length === 0) return;
    await getPaperless().updateDoc(doc.id, { custom_fields: entries });
  }

  /** Ensures the needs-review tag exists (creating it once) and returns its id. */
  async function ensureNeedsReviewTagId() {
    let tagId = await getNeedsReviewTagId();
    // Cached miss may be stale; a single paranoia re-check avoids racing the
    // cache across poll passes after the tag was created mid-session.
    if (tagId == null && ensureNeedsReviewTagCount === 0) {
      tagId = await getPaperless().ensureTag(NEEDS_REVIEW_TAG);
      ensureNeedsReviewTagCount += 1;
      needsReviewTagIdPromise = Promise.resolve(tagId);
    }
    return tagId ?? null;
  }

  /** Tags a doc needs-review and sets its status field (never imports). */
  async function markNeedsReview(doc, parsed, customFieldIds) {
    const entries = parsedFieldEntries(parsed, customFieldIds);
    const statusId = fieldId(customFieldIds, 'status');
    if (statusId != null) entries.push({ field: statusId, value: 'needs-review' });

    const changes = { custom_fields: entries };
    const tagId = await ensureNeedsReviewTagId();
    const tags = Array.isArray(doc.tags) ? doc.tags.filter((t) => t != null) : [];
    if (tagId != null && !tags.includes(tagId)) tags.push(tagId);
    changes.tags = tags;

    await getPaperless().updateDoc(doc.id, changes);
  }

  /** Records actual_transaction_id + status 'imported'; drops needs-review tag. */
  async function markImported(doc, txnId, customFieldIds) {
    const entries = [];
    const importedId = fieldId(customFieldIds, 'imported');
    if (importedId != null) entries.push({ field: importedId, value: String(txnId) });
    const statusId = fieldId(customFieldIds, 'status');
    if (statusId != null) entries.push({ field: statusId, value: 'imported' });

    const changes = { custom_fields: entries };

    // Remove the needs-review tag when the doc carries it.
    const needsReviewTagId = await getNeedsReviewTagId();
    if (needsReviewTagId != null && Array.isArray(doc.tags) && doc.tags.includes(needsReviewTagId)) {
      changes.tags = doc.tags.filter((t) => t !== needsReviewTagId);
    }

    await getPaperless().updateDoc(doc.id, changes);
  }

  /** Sets the status field to 'error' after a per-doc failure (best effort). */
  async function markError(doc, customFieldIds) {
    const statusId = fieldId(customFieldIds, 'status');
    if (statusId == null) return;
    await getPaperless().updateDoc(doc.id, {
      custom_fields: [{ field: statusId, value: 'error' }],
    });
  }

  /**
   * Imports a single candidate document:
   *   1. skip when actual_transaction_id is already set (idempotency).
   *   2-3. parse; anything not cleanly parseable → needs-review, never imported.
   *   4. else write parsed fields, import with imported_id `paperless:<id>`,
   *      write back the Actual transaction id + status 'imported'.
   */
  async function processDoc(doc, { customFieldIds, parseCtx }) {
    const importedFieldId = fieldId(customFieldIds, 'imported');

    if (importedFieldId != null && hasCustomFieldValue(doc, importedFieldId)) {
      return { docId: doc.id, status: 'skipped' };
    }

    const parsed = parse(doc, parseCtx);

    const needsReview = !parsed.ok || parsed.foreign === true || parsed.confidence === 'low';
    if (needsReview) {
      await markNeedsReview(doc, parsed, customFieldIds);
      return { docId: doc.id, status: 'needs-review', reason: parsed.reason ?? null };
    }

    await writeBackParsed(doc, parsed, customFieldIds);

    const txn = {
      date: parsed.date,
      amount: parsed.amount,
      payee_name: parsed.payee,
      notes: notesFor(doc),
      imported_id: `paperless:${doc.id}`,
    };
    const api = await getActual();
    const accountId = await getAccountId();
    const result = await importTxns(api, accountId, [txn], { dryRun: false });
    const txnId = result?.added?.[0] ?? result?.updated?.[0];
    if (txnId == null) {
      throw new Error(
        `Actual returned no transaction id for paperless doc ${doc.id} (errors: ${JSON.stringify(result?.errors ?? null)})`,
      );
    }

    await markImported(doc, txnId, customFieldIds);
    return { docId: doc.id, status: 'imported', txnId };
  }

  function summarize(results) {
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    console.log(
      `import pass: ${results.length} candidate(s) - ${Object.entries(counts)
        .map(([status, n]) => `${status}: ${n}`)
        .join(', ')}`,
    );
  }

  // --- public API -----------------------------------------------------------

  /** Verifies Paperless custom fields exist and the Actual account resolves. */
  async function check() {
    const customFieldIds = await getCustomFieldIds();
    requireFieldIds(customFieldIds, CHECKED_FIELD_ROLES, 'check');

    for (const role of CHECKED_FIELD_ROLES) {
      console.log(`  field ${role}: ${fields[role]} -> id ${customFieldIds.get(fields[role])}`);
    }
    console.log(`Paperless: ${CHECKED_FIELD_ROLES.length}/${CHECKED_FIELD_ROLES.length} custom fields verified`);

    const accountId = await getAccountId();
    console.log(`Actual: account "${config.actual?.defaultAccountName}" -> ${accountId}`);

    return { customFieldsOk: true, accountId };
  }

  /**
   * Lists candidates and prints planned transactions + confidence/status.
   * Makes ZERO writes: signal tags resolve via read-only tagIdByName, nothing
   * is PATCHed, no tag is created, Actual is never connected.
   */
  async function dryRun() {
    const pl = getPaperless();
    const customFieldIds = await getCustomFieldIds();
    const signalIds = await resolveSignalIds({ create: false });
    const candidates = await pl.listCandidateDocs({
      importedFieldName: fields.imported,
      signals: signalIds,
      customFieldIds,
    });
    const parseCtx = buildParseCtx(customFieldIds);

    const planned = [];
    for (const doc of candidates) {
      let parsed;
      try {
        parsed = parse(doc, parseCtx);
      } catch (err) {
        parsed = { ok: false, reason: 'parse-error', amount: null, date: null, payee: null, currency: null, confidence: 'low', foreign: false };
      }
      planned.push({ docId: doc.id, title: doc.title, parsed });
      if (!parsed.ok || parsed.foreign === true || parsed.confidence === 'low') {
        console.log(
          `  needs-review doc ${doc.id} "${doc.title ?? ''}": ${parsed.reason ?? 'low confidence'} (confidence ${parsed.confidence})`,
        );
      } else {
        console.log(
          `  import doc ${doc.id} "${doc.title ?? ''}": amount ${parsed.amount} date ${parsed.date} payee ${parsed.payee} ${parsed.currency} (confidence ${parsed.confidence})`,
        );
      }
    }
    console.log(`dry run: ${planned.length} candidate(s) planned, nothing written`);
    return { candidates: candidates.length, planned };
  }

  /** Runs a single import pass over all candidates. */
  async function importPass() {
    const pl = getPaperless();
    const customFieldIds = await getCustomFieldIds();
    requireFieldIds(customFieldIds, IMPORT_REQUIRED_FIELD_ROLES, 'import');

    const signalIds = await resolveSignalIds({ create: true });
    const candidates = await pl.listCandidateDocs({
      importedFieldName: fields.imported,
      signals: signalIds,
      customFieldIds,
    });
    const parseCtx = buildParseCtx(customFieldIds);

    const results = [];
    for (const doc of candidates) {
      try {
        results.push(await processDoc(doc, { customFieldIds, parseCtx }));
      } catch (err) {
        console.error(`ab2pb: paperless doc ${doc.id}: ${err.message ?? err}`);
        try {
          await markError(doc, customFieldIds);
        } catch (statusErr) {
          console.error(`ab2pb: failed to record error status for doc ${doc.id}: ${statusErr.message ?? statusErr}`);
        }
        results.push({ docId: doc.id, status: 'error', error: String(err?.message ?? err) });
      }
    }

    summarize(results);
    return { candidates: candidates.length, results };
  }

  /** Single pass, then stop. */
  async function once() {
    return importPass();
  }

  /**
   * Import loop. Call shutdown() to stop; per-pass failures are logged.
   * When a `signal` (AbortSignal) is provided, aborting it stops the loop
   * after the current pass and returns cleanly (the CLI uses this for
   * SIGINT/SIGTERM so shutdown() always runs).
   */
  async function poll({ intervalMs = DEFAULT_POLL_INTERVAL_MS, signal } = {}) {
    if (signal?.aborted) return;
    let wake = null;
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        try {
          await importPass();
        } catch (err) {
          console.error(`ab2pb: poll pass failed: ${err.message ?? err}`);
        }
        if (signal?.aborted) return;
        await new Promise((resolve) => {
          let timer;
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(() => {
            wake = null;
            resolve();
          }, intervalMs);
        });
        if (signal?.aborted) return;
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Closes the Actual connection when one was established. */
  async function shutdown() {
    if (actualHandle) {
      if (typeof actualHandle.shutdown === 'function') await actualHandle.shutdown();
    } else if (actualPromise) {
      const api = await actualPromise;
      if (api && typeof api.shutdown === 'function') await api.shutdown();
    }
  }

  return { check, dryRun, import: importPass, once, poll, shutdown };
}