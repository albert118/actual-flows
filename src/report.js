// Stage 1 reconcile report: two-way document<->ledger classification.
//
// For the reconcile window (current + previous AU financial year by default, or
// the single FY ending in the given `year`), runReconcile fetches every signal
// document with its `actual_transaction_id` custom-field value and every Actual
// transaction across the default account plus every account a signal entry maps
// to ({name, account}), then classifies them into three lists:
//
//   A. docs with no transaction   — signal doc whose imported field is unset
//   B. dangling paperless:<id>    — transaction imported as paperless:<id> but no
//                                   matching Paperless doc id exists in the window
//   C. non-paperless transactions — everything else (bank/statement-sourced lines)
//
// A `paperless:<id>` transaction whose doc id DOES exist in the archive is
// reconciled (satisfied) and is not flagged. Reconcile is strictly read-only:
// it never writes to Paperless or Actual.

import { resolveAccount, getTransactions } from './actual.js';
import { signalEntryAccount, SIGNAL_LIST_KEYS } from './config.js';
import { resolveSignalIdsReadOnly } from './signalIds.js';

/** Number of FYs covered by the default window (current + previous). */
export const DEFAULT_FY_COUNT = 2;

/** Padded year used for FY boundaries, e.g. fyEnd 2026 -> start '2025-07-01'. */
function fyDate(year, monthDay) {
  return `${year}-${monthDay}`;
}

/**
 * Computes the reconcile window.
 *
 * With `year` given, returns the single AU FY ending 30 June of that year:
 * [1 Jul (year-1), 30 Jun year]. Otherwise returns the default window: the
 * current + previous AU FYs (2 FYs), starting at the start of the previous FY
 * (anything before that is unreconcilable and excluded). AU FY = 1 July – 30
 * June, with "today" resolved in the Australia/Sydney timezone.
 *
 * @param {number} [year] explicit FY ending year
 * @param {Date} [today]  injectable clock (tests)
 * @returns {{start: string, end: string, years: number, explicit: boolean}}
 */
export function reconcileWindow({ year, today = new Date() } = {}) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value);

  // FY containing today: ends 30 June of y+1 when today is July or later,
  // otherwise 30 June of y.
  const currentFyEnd = m >= 7 ? y + 1 : y;

  if (year != null) {
    return {
      start: fyDate(year - 1, '07-01'),
      end: fyDate(year, '06-30'),
      years: 1,
      explicit: true,
    };
  }

  return {
    start: fyDate(currentFyEnd - DEFAULT_FY_COUNT, '07-01'),
    end: fyDate(currentFyEnd, '06-30'),
    years: DEFAULT_FY_COUNT,
    explicit: false,
  };
}

/**
 * The set of Actual account names reconcile must cover: the default account
 * plus every `account` referenced by a signal entry of the form `{name,
 * account}` (any of the three `signals.*` lists). As a future-proofing
 * measure, `incomeSignals.*` entries are iterated through the same
 * signal-form helper — today those are plain names only, so they contribute
 * nothing, but if they ever grow an `account` field those accounts are
 * covered automatically without changing this code.
 */
function reconcileAccountNames(config) {
  const names = new Set();
  if (config.actual?.defaultAccountName) names.add(config.actual.defaultAccountName);

  const signalLists = config.signals ?? {};
  for (const key of SIGNAL_LIST_KEYS) {
    const list = signalLists[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const account = signalEntryAccount(entry);
      if (account != null && account !== '') names.add(account);
    }
  }

  const income = config.incomeSignals ?? {};
  for (const key of ['documentTypes', 'tags']) {
    const list = income[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const account = signalEntryAccount(entry);
      if (account != null && account !== '') names.add(account);
    }
  }

  return names;
}

/** Prints one labelled list with a per-item one-line entry. */
function printList(label, items, format) {
  console.log(`${label} (${items.length}):`);
  if (items.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const item of items) console.log(`  - ${format(item)}`);
}

/**
 * Reconcile report entry point (read-only).
 *
 * @param {object} [args]
 * @param {object} [args.config]    resolved bridge config
 * @param {object} [args.paperless] Paperless client (listCustomFields, tagIdByName,
 *                                  listDocumentTypes, listCorrespondents,
 *                                  listSignalDocsInRange)
 * @param {object} [args.actual]    Actual api handle (resolveAccount, getTransactions)
 * @param {number} [args.year]      optional FY ending year; defaults to current +
 *                                  previous FY window
 * @returns {Promise<object>}
 */
export async function runReconcile({ config, paperless, actual, year } = {}) {
  const window = reconcileWindow({ year });
  const fields = config?.paperless?.fields ?? {};
  const signals = config?.signals ?? {};
  const importedFieldName = fields.imported;

  const customFieldIds = await paperless.listCustomFields();
  const resolvedSignals = await resolveSignalIdsReadOnly({ paperless, signals });

  const docs = importedFieldName
    ? await paperless.listSignalDocsInRange({
        importedFieldName,
        signals: resolvedSignals.signals,
        customFieldIds,
        start: window.start,
        end: window.end,
      })
    : [];

  // Reconcile must see transactions in every account transactions may live
  // in: the default account plus every account a signal entry maps to via
  // {name, account}. Each account is resolved once (deduped by resolved id)
  // and its window transactions merged into one classification list.
  const accountIds = new Set();
  for (const accountName of reconcileAccountNames(config)) {
    accountIds.add(await resolveAccount(actual, accountName));
  }
  const txns = [];
  for (const accountId of accountIds) {
    txns.push(...(await getTransactions(actual, accountId, window.start, window.end)));
  }

  const docIds = new Set(docs.map((d) => d.id));

  // A: signal docs with no transaction (imported field unset).
  const docsWithoutTxn = docs
    .filter((d) => d.importedValue == null || d.importedValue === '')
    .map((d) => ({ id: d.id, title: d.title }));

  // B (dangling) + satisfied paperless:<id> transactions, C (non-paperless).
  const dangling = [];
  const nonPaperless = [];
  for (const txn of txns) {
    const importedId = typeof txn.imported_id === 'string' ? txn.imported_id : '';
    if (importedId.startsWith('paperless:')) {
      const docId = Number(importedId.slice('paperless:'.length));
      // Satisfied when a matching doc id exists in the archive window.
      if (!Number.isInteger(docId) || !docIds.has(docId)) {
        dangling.push({ txnId: txn.id ?? null, importedId, docId: Number.isInteger(docId) ? docId : null });
      }
    } else {
      nonPaperless.push({ txnId: txn.id ?? null, importedId });
    }
  }

  console.log(
    `reconcile window: ${window.start} to ${window.end} (${window.explicit ? `FY ending ${year}` : 'current + previous FY'})`,
  );
  printList('docs without a transaction', docsWithoutTxn, (d) => `doc ${d.id} "${d.title ?? ''}"`);
  printList(
    'dangling paperless:<id> transactions',
    dangling,
    (t) => `txn ${t.txnId ?? '?'}: ${t.importedId} (no matching doc)`,
  );
  printList('non-paperless transactions', nonPaperless, (t) => `txn ${t.txnId ?? '?'}: ${t.importedId}`);

  return {
    window,
    lists: { docsWithoutTxn, dangling, nonPaperless },
    implemented: true,
  };
}