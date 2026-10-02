import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from '../src/parse.js';
import {
  AU_INVOICE_DOC,
  AU_GST_INVOICE_DOC,
  USD_INVOICE_DOC,
  AMBIGUOUS_BARE_USD_CONTENT,
  REFUND_CREDIT_NOTE_DOC,
  NO_AMOUNT_DOC,
  EXPLICIT_AUD_DOC,
  ISO_DATE_DOC,
  EURO_DOC,
  DMY_DATE_DOC,
  MONTH_DATE_DOC,
} from './fixtures/index.js';

// Default context mirrors config.example.json.
const baseCtx = {
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  dateFormats: ['d/m/y', 'd m y'],
  fields: { amount: 'actual_amount', date: 'actual_date', payee: 'actual_payee' },
  incomeSignals: { documentTypes: [], tags: [] },
};

const simpleDoc = (overrides = {}) => ({
  id: 900,
  title: 'Acme Pty Ltd - Invoice',
  content: 'Total: $50.00',
  created: '2026-09-30',
  document_type: 'invoice',
  tags: [],
  correspondent: null,
  custom_fields: [],
  ...overrides,
});

// --- AC9: AU invoice total ------------------------------------------------

test('AC9: parses AU invoice total as expense in minor units', () => {
  const r = parseDoc(AU_INVOICE_DOC, baseCtx);
  assert.equal(r.ok, true);
  assert.equal(r.amount, -5000);
  assert.equal(r.currency, 'AUD');
  assert.equal(r.foreign, false);
  assert.equal(r.sign, 'expense');
  assert.equal(r.confidence, 'high');
});

test('AC9b: labelled bare dollar total is read as AUD', () => {
  const r = parseDoc(simpleDoc({ content: 'Total: $50.00' }), baseCtx);
  assert.equal(r.amount, -5000);
  assert.equal(r.currency, 'AUD');
  assert.equal(r.foreign, false);
  assert.equal(r.confidence, 'high');
});

test('AC9c: totals with thousands separators convert exactly', () => {
  const r = parseDoc(simpleDoc({ content: 'Balance: $1,234.56' }), baseCtx);
  assert.equal(r.amount, -123456);
});

test('AC9d: DE-style 1.234,56 amount converts as thousands plus cents', () => {
  const r = parseDoc(simpleDoc({ content: 'Total: 1.234,56' }), baseCtx);
  assert.equal(r.amount, -123456);
});

test('AC9e: GST-laden AU invoice picks the labelled total', () => {
  const r = parseDoc(AU_GST_INVOICE_DOC, baseCtx);
  assert.equal(r.ok, true);
  assert.equal(r.amount, -123456);
  assert.equal(r.currency, 'AUD');
  assert.equal(r.date, '2026-10-15');
  assert.equal(r.confidence, 'high');
});

// --- AC10: manual overrides ------------------------------------------------

test('AC10: manual amount/date/payee overrides are used verbatim', () => {
  const doc = simpleDoc({
    title: 'Something Else',
    content: 'Total: $999.00\n25/10/2026',
    correspondent: 'Different Payee',
    custom_fields: [
      { name: 'actual_amount', value: '75.00' },
      { name: 'actual_date', value: '2026-08-01' },
      { name: 'actual_payee', value: 'Manual Payee Pty Ltd' },
    ],
  });
  const r = parseDoc(doc, baseCtx);
  assert.equal(r.ok, true);
  assert.equal(r.amount, -7500);
  assert.equal(r.date, '2026-08-01');
  assert.equal(r.payee, 'Manual Payee Pty Ltd');
  assert.equal(r.sign, 'expense');
});

test('AC10b: custom fields keyed by {field: <name>} are honoured', () => {
  const doc = simpleDoc({
    content: 'Total: $50.00',
    custom_fields: [{ field: 'actual_amount', value: '120.50' }],
  });
  const r = parseDoc(doc, baseCtx);
  assert.equal(r.amount, -12050);
  assert.equal(r.date, '2026-09-30'); // only amount overridden
});

test('AC10c: custom fields keyed by numeric field id resolve via fieldIds', () => {
  const doc = simpleDoc({
    content: '',
    custom_fields: [{ field: 42, value: '33.33' }],
  });
  const ctx = { ...baseCtx, fieldIds: { actual_amount: 42 } };
  const r = parseDoc(doc, ctx);
  assert.equal(r.amount, -3333);
});

test('AC10d: pre-extracted ctx.manual values are authoritative', () => {
  const doc = simpleDoc({
    content: 'Total: $999.00',
    custom_fields: [{ name: 'actual_amount', value: '5.00' }],
  });
  const ctx = {
    ...baseCtx,
    manualAmount: '8.50',
    manualDate: '2026-07-07',
    manualPayee: 'Pre-extracted Co',
  };
  const r = parseDoc(doc, ctx);
  assert.equal(r.amount, -850);
  assert.equal(r.date, '2026-07-07');
  assert.equal(r.payee, 'Pre-extracted Co');
});

test('AC10e: explicit negative manual amount stays an expense', () => {
  const doc = simpleDoc({
    content: '',
    custom_fields: [{ name: 'actual_amount', value: '-120.00' }],
  });
  const r = parseDoc(doc, baseCtx);
  assert.equal(r.amount, -12000);
  assert.equal(r.sign, 'expense');
});

test('AC10f: manual amount is signed by income signals when unmarked', () => {
  const doc = simpleDoc({
    content: '',
    document_type: 'credit_note',
    custom_fields: [{ name: 'actual_amount', value: '75.00' }],
  });
  const ctx = { ...baseCtx, incomeSignals: { documentTypes: ['credit_note'], tags: [] } };
  const r = parseDoc(doc, ctx);
  assert.equal(r.amount, 7500);
  assert.equal(r.sign, 'income');
});

test('AC10g: non-ISO manual dates are normalised to ISO', () => {
  const doc = simpleDoc({ content: '', custom_fields: [{ name: 'actual_date', value: '25/10/2026' }] });
  const r = parseDoc(doc, baseCtx);
  assert.equal(r.date, '2026-10-25');
});

// --- AC11: foreign currency ------------------------------------------------

test('AC11: USD invoice is flagged foreign with currency recorded', () => {
  const r = parseDoc(USD_INVOICE_DOC, baseCtx);
  assert.equal(r.ok, false);
  assert.equal(r.foreign, true);
  assert.equal(r.currency, 'USD');
  assert.equal(r.amount, null);
  assert.equal(r.reason, 'foreign-currency');
});

test('AC11b: ambiguous bare $ is not assumed AUD', () => {
  const r = parseDoc(simpleDoc({ content: AMBIGUOUS_BARE_USD_CONTENT, title: 'Corner Cafe' }), baseCtx);
  assert.equal(r.ok, false);
  assert.equal(r.foreign, true);
  assert.equal(r.amount, null);
  assert.equal(r.currency, null);
  assert.equal(r.reason, 'foreign-currency');
});

test('AC11c: euro-symbol amount is flagged foreign', () => {
  const r = parseDoc(EURO_DOC, baseCtx);
  assert.equal(r.ok, false);
  assert.equal(r.foreign, true);
  assert.equal(r.currency, 'EUR');
  assert.equal(r.amount, null);
});

// --- AC12: AU and ISO dates -------------------------------------------------

test('AC12: parses AU dd/mm/yyyy date to ISO', () => {
  const r = parseDoc(DMY_DATE_DOC, baseCtx);
  assert.equal(r.date, '2026-10-25');
});

test('AC12b: parses ISO yyyy-mm-dd date', () => {
  const r = parseDoc(ISO_DATE_DOC, baseCtx);
  assert.equal(r.date, '2026-10-25');
});

test('AC12c: parses dd Month yyyy date', () => {
  const r = parseDoc(MONTH_DATE_DOC, baseCtx);
  assert.equal(r.date, '2026-10-25');
});

test('AC12d: parses space-separated d m yyyy date', () => {
  const r = parseDoc(simpleDoc({ content: 'Issue date: 25 10 2026\nTotal: $5.00' }), baseCtx);
  assert.equal(r.date, '2026-10-25');
});

test('AC12e: invalid dates are rejected and fall back to created', () => {
  const r = parseDoc(simpleDoc({ content: 'Total: $50.00\nDate: 32/13/2026' }), baseCtx);
  assert.equal(r.date, '2026-09-30');
});

// --- AC13: created-date fallback --------------------------------------------

test('AC13: falls back to doc created date when content has none', () => {
  const r = parseDoc(simpleDoc({ content: 'Total: $50.00', created: '2026-09-30T10:00:00+10:00' }), baseCtx);
  assert.equal(r.date, '2026-09-30');
});

test('AC13b: falls back to plain created date string', () => {
  const r = parseDoc(simpleDoc({ content: 'Total: $50.00', created: '2026-09-30' }), baseCtx);
  assert.equal(r.date, '2026-09-30');
});

// --- AC14: refunds are income -----------------------------------------------

test('AC14: refund/credit-note document type parses as income', () => {
  const doc = { ...REFUND_CREDIT_NOTE_DOC, document_type: 'credit_note' };
  const ctx = { ...baseCtx, incomeSignals: { documentTypes: ['credit_note'], tags: [] } };
  const r = parseDoc(doc, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.amount, 3000);
  assert.equal(r.sign, 'income');
  assert.equal(r.currency, 'AUD');
});

test('AC14b: refund keywords in content mark income without signals', () => {
  const r = parseDoc(REFUND_CREDIT_NOTE_DOC, baseCtx);
  assert.equal(r.amount, 3000);
  assert.equal(r.sign, 'income');
});

test('AC14c: income signal by matching tag', () => {
  const doc = simpleDoc({
    content: 'Total: $40.00',
    tags: ['credit_note'],
    document_type: null,
  });
  const ctx = { ...baseCtx, incomeSignals: { documentTypes: [], tags: ['credit_note'] } };
  const r = parseDoc(doc, ctx);
  assert.equal(r.amount, 4000);
  assert.equal(r.sign, 'income');
});

// --- AC15: no amount is needs-review ----------------------------------------

test('AC15: no parseable amount yields needs-review', () => {
  const r = parseDoc(NO_AMOUNT_DOC, baseCtx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-amount');
  assert.equal(r.amount, null);
  assert.equal(r.confidence, 'low');
});

test('AC15b: content with only a bare number yields needs-review', () => {
  const r = parseDoc(simpleDoc({ content: 'Please remit 1234 by the 15th. Regards, Acme' }), baseCtx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-amount');
  assert.equal(r.amount, null);
});

// --- representative coverage -------------------------------------------------

test('explicit AUD code parses as local currency with medium confidence', () => {
  const r = parseDoc(EXPLICIT_AUD_DOC, baseCtx);
  assert.equal(r.ok, true);
  assert.equal(r.amount, -12345);
  assert.equal(r.currency, 'AUD');
  assert.equal(r.foreign, false);
  assert.equal(r.confidence, 'medium');
});

test('payee falls back to correspondent name', () => {
  const r = parseDoc(AU_INVOICE_DOC, baseCtx);
  assert.equal(r.payee, 'Acme Plumbing Pty Ltd');
});

test('payee falls back to first non-empty title line', () => {
  const doc = simpleDoc({ title: 'Smith Bros Pty Ltd\nInvoice', correspondent: null });
  const r = parseDoc(doc, baseCtx);
  assert.equal(r.payee, 'Smith Bros Pty Ltd');
});

test('payee is null when no source exists', () => {
  const r = parseDoc(simpleDoc({ title: '', correspondent: null }), baseCtx);
  assert.equal(r.payee, null);
});

test('manual amount on foreign-looking content keeps ok but flags foreign', () => {
  const doc = simpleDoc({
    content: 'USD $10.00',
    custom_fields: [{ name: 'actual_amount', value: '25.00' }],
  });
  const r = parseDoc(doc, baseCtx);
  assert.equal(r.amount, -2500); // manual value is authoritative...
  assert.equal(r.ok, true);
  assert.equal(r.foreign, true); // ...but the document is still foreign
  assert.equal(r.currency, 'USD');
});

test('defensive: missing doc and missing fields do not throw', () => {
  const r = parseDoc(null, baseCtx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-amount');
  const r2 = parseDoc({ id: 1 }, baseCtx);
  assert.equal(r2.ok, false);
  assert.equal(r2.amount, null);
  assert.equal(r2.date, null);
  assert.equal(r2.payee, null);
  assert.equal(r2.currency, 'AUD');
});

// --- Stage 3: income-by-document-type (AC11-AC14) ----------------------------

test('AC11: document_type numeric id in incomeSignals.documentTypeIds lands income', () => {
  // Real Paperless docs carry numeric document_type ids; the resolved id list
  // must match them (numeric-id path, not the string-name path).
  const doc = simpleDoc({ document_type: 20, tags: [] });
  const ctx = {
    ...baseCtx,
    incomeSignals: { documentTypes: [], tags: [], documentTypeIds: [20], tagIds: [] },
  };
  const r = parseDoc(doc, ctx);
  assert.equal(r.sign, 'income');
  assert.equal(r.amount, 5000);
  assert.equal(r.ok, true);
});

test('AC12: tag numeric id in incomeSignals.tagIds lands income', () => {
  const doc = simpleDoc({ document_type: null, tags: [50] });
  const ctx = {
    ...baseCtx,
    incomeSignals: { documentTypes: [], tags: [], documentTypeIds: [], tagIds: [50] },
  };
  const r = parseDoc(doc, ctx);
  assert.equal(r.sign, 'income');
  assert.equal(r.amount, 5000);
});

test('AC12b: income by numeric tag id also wins with a manual amount present', () => {
  const doc = simpleDoc({
    content: '',
    document_type: null,
    tags: [50],
    custom_fields: [{ name: 'actual_amount', value: '75.00' }],
  });
  const ctx = {
    ...baseCtx,
    incomeSignals: { documentTypes: [], tags: [], documentTypeIds: [], tagIds: [50] },
  };
  const r = parseDoc(doc, ctx);
  assert.equal(r.sign, 'income');
  assert.equal(r.amount, 7500);
});

test('AC13: watch-signal-only doc with no income signal stays expense (v1 bug guard)', () => {
  // The doc matches a watch signal (tag 'invoice' / document_type 'invoice')
  // but no income signal — it must NOT flip to income. The id lists here even
  // contain unrelated ids to prove only exact matches count.
  const doc = simpleDoc({ document_type: 'invoice', tags: ['invoice'] });
  const ctx = {
    ...baseCtx,
    incomeSignals: { documentTypes: [], tags: [], documentTypeIds: [88], tagIds: [99] },
  };
  const r = parseDoc(doc, ctx);
  assert.equal(r.sign, 'expense');
  assert.equal(r.amount, -5000);
});

test('AC13b: numeric watch-style tag id with no income signal stays expense', () => {
  const doc = simpleDoc({ document_type: 7, tags: [10] });
  const r = parseDoc(doc, baseCtx); // incomeSignals empty -> expense
  assert.equal(r.sign, 'expense');
  assert.equal(r.amount, -5000);
});

test('AC14: refund keyword in content flips income without any income signal', () => {
  const doc = simpleDoc({
    content: 'Refund approved for overpayment\nTotal: $30.00',
    document_type: null,
    tags: [],
  });
  const ctx = {
    ...baseCtx,
    incomeSignals: { documentTypes: [], tags: [], documentTypeIds: [], tagIds: [] },
  };
  const r = parseDoc(doc, ctx);
  assert.equal(r.sign, 'income');
  assert.equal(r.amount, 3000);
});

test('Stage3: numeric doc id does not match a string name in incomeSignals', () => {
  // A real doc with numeric document_type 5 must not stringify-match the
  // configured name 'invoice', nor the unrelated id 7.
  const doc = simpleDoc({ document_type: 5, tags: [] });
  const ctx = {
    ...baseCtx,
    incomeSignals: { documentTypes: ['invoice'], tags: [], documentTypeIds: [7], tagIds: [] },
  };
  const r = parseDoc(doc, ctx);
  assert.equal(r.sign, 'expense');
});

test('Stage3: numeric tag id does not match a string name in incomeSignals', () => {
  const doc = simpleDoc({ document_type: null, tags: [10] });
  const ctx = {
    ...baseCtx,
    incomeSignals: { documentTypes: [], tags: ['invoice'], documentTypeIds: [], tagIds: [11] },
  };
  const r = parseDoc(doc, ctx);
  assert.equal(r.sign, 'expense');
});