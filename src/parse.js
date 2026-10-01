// Parser engine: localised (AUD/AU) extraction of amount/date/payee/currency
// from Paperless OCR content, with manual custom-field overrides taking
// precedence, foreign-currency detection, expense/income sign and confidence.
//
// parseDoc(doc, ctx) -> {ok, amount, date, payee, currency, sign,
//                        confidence, foreign, reason}
//
// Field semantics:
//   amount     integer minor units (50.00 -> 5000); NEGATIVE for expenses,
//              POSITIVE for income; null when nothing parseable.
//   date       ISO date string YYYY-MM-DD (manual override, content date, or
//              doc.created fallback); null when nothing found.
//   payee      correspondent name, first non-empty title line, or manual value.
//   currency   ISO code of the detected currency ('AUD' for local, the foreign
//              code for foreign docs, null when genuinely ambiguous).
//   sign       'expense' | 'income' | 'unknown' (unknown when ok=false).
//   confidence 'high' | 'medium' | 'low'.
//   foreign    true when the document is not a local-currency document.
//   reason     'no-amount' | 'foreign-currency' | null (mutually with ok).
//
// Precedence:
//   1. Manual overrides (amount/date/payee) are authoritative and used
//      verbatim; those fields are not OCR-parsed when overridden.
//   2. Amount is extracted by currency-aware label preference (labels:
//      total, amount due, balance, gst incl, to pay, pay this amount), then a
//      currency-attached number anywhere.
//   3. Currency detection: explicit codes or symbols win; a bare `$` is only
//      read as local currency when the amount carries a money label or AU
//      context evidence (GST/ABN/...), otherwise it is ambiguous -> foreign.
//   4. Dates: ISO yyyy-mm-dd, AU dd/mm/yyyy (and dd.mm/dd-mm, d m yyyy),
//      dd Month yyyy -> YYYY-MM-DD; fallback to doc.created's date part.
//   5. Sign defaults to expense; incomeSignals (document type/tags) or
//      refund/credit-note/cashback keywords flip it to income.

const CURRENCY_CODES = [
  'AUD',
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'NZD',
  'CAD',
  'CHF',
];

// Currency tokens recognised next to an amount. Order matters for alternation:
// multi-character tokens appear before single-character symbols.
const CURRENCY_SRC = String.raw`AUD|CAD|CHF|NZD|USD|US\$|EUR|GBP|JPY|AU\$|\$AU|€|£|¥|\$`;

const CURRENCY_RE = new RegExp(CURRENCY_SRC, 'i');
const CODE_RE = new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`, 'gi');

// Money number: 1,234.56 / 1234.56 / 1.234,56 / 1,234 / 1234 / 1234,56.
const NUMBER = String.raw`(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
const NUMBER_RE = new RegExp(NUMBER, 'g');

// Label preference order (longest/most specific first within ties of intent).
const AMOUNT_LABELS = [
  'total',
  'amount due',
  'gst incl',
  'balance',
  'to pay',
  'pay this amount',
];

// Content evidence that a bare `$` is Australian dollars in this AU-locale
// bridge (GST is the classic AU invoice marker).
const AU_CONTEXT_RE = /\b(gst|abn|australi[ae]|tax invoice|incl\s*\.?\s*gst)\b/i;

const INCOME_KEYWORDS_RE = /\b(refund|credit\s?[- ]?note|cashback)\b/i;

const MONTH_BY_NAME = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_NAME_RE =
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{2,4})\b/gi;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const labelPattern = (label) =>
  label.split(/\s+/).map(escapeRe).join('\\s+');

/**
 * Parses a decimal money string into its numeric value (dollars), being
 * flexible about thousands separators and decimal commas:
 *   1,234.56 -> 1234.56    1.234,56 -> 1234.56 (best effort, DE-style)
 *   1234.56  -> 1234.56    1.234    -> 1234    (thousands, best effort)
 *   1234     -> 1234       1234,56  -> 1234.56 (decimal comma)
 * Returns null when the string is not a money-shaped number.
 */
function parseMoneyNumber(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  const s = String(raw).trim();
  if (!/^[+\-]?[\d.,]+$/.test(s)) return null;
  const sign = s.startsWith('-') ? -1 : 1;
  const digits = s.replace(/^[+\-]/, '');

  const hasComma = digits.includes(',');
  const hasDot = digits.includes('.');
  let decimalSep = null;

  if (hasComma && hasDot) {
    // The LAST separator is the decimal one (1,234.56 / 1.234,56).
    decimalSep = digits.lastIndexOf(',') > digits.lastIndexOf('.') ? ',' : '.';
  } else if (hasComma) {
    const parts = digits.split(',');
    if (parts.length === 2 && /^\d{1,2}$/.test(parts[1]) && /^\d+$/.test(parts[0])) {
      decimalSep = ','; // 1234,56
    }
  } else if (hasDot) {
    const parts = digits.split('.');
    if (parts.length === 2) {
      const last = parts[1];
      if (/^\d{2}$/.test(last)) {
        decimalSep = '.'; // 1234.56
      } else if (/^\d{3}$/.test(last) && /^\d{1,3}$/.test(parts[0])) {
        decimalSep = null; // 1.234 is a thousands group, no decimals
      } else {
        decimalSep = '.'; // 1234.567 or 1234.5 -> treat as decimal
      }
    }
    // More dots (1.234.567) -> thousands grouping only.
  }

  if (decimalSep === null) {
    const n = Number(digits.replace(/[.,]/g, ''));
    return Number.isFinite(n) ? sign * n : null;
  }

  const [intRaw, decRaw = ''] = digits.split(decimalSep);
  const intPart = Number(intRaw.replace(/[.,]/g, ''));
  const decPart = Number(decRaw.slice(0, 2).padEnd(2, '0'));
  if (!Number.isFinite(intPart) || !Number.isFinite(decPart)) return null;
  return sign * (intPart + decPart / 100);
}

function normalizeCtx(ctx = {}) {
  const fields = ctx.fields ?? {};
  const signals = ctx.incomeSignals ?? {};
  return {
    currency: typeof ctx.currency === 'string' && ctx.currency ? ctx.currency : 'AUD',
    timezone:
      typeof ctx.timezone === 'string' && ctx.timezone ? ctx.timezone : 'Australia/Sydney',
    dateFormats: Array.isArray(ctx.dateFormats)
      ? ctx.dateFormats
      : ['d/m/y', 'd m y'],
    fields: {
      amount: fields.amount ?? 'amount',
      date: fields.date ?? 'date',
      payee: fields.payee ?? 'payee',
    },
    fieldIds: ctx.fieldIds && typeof ctx.fieldIds === 'object' ? ctx.fieldIds : {},
    manualAmount: ctx.manualAmount,
    manualDate: ctx.manualDate,
    manualPayee: ctx.manualPayee,
    incomeSignals: {
      documentTypes: Array.isArray(signals.documentTypes) ? signals.documentTypes : [],
      tags: Array.isArray(signals.tags) ? signals.tags : [],
      documentTypeIds: Array.isArray(signals.documentTypeIds) ? signals.documentTypeIds : [],
      tagIds: Array.isArray(signals.tagIds) ? signals.tagIds : [],
    },
  };
}

function firstDefined(...values) {
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return undefined;
}

/**
 * Normalises custom_fields into a name -> value map, tolerating:
 *   [{ field: <name>, value }], [{ field: <id>, value }] (via ctx.fieldIds),
 *   [{ name, value }], or a plain { name: value } object.
 */
function normalizeCustomFields(customFields, fieldIds) {
  const map = new Map();
  if (customFields == null) return map;
  const set = (key, value) => {
    if (value == null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    const k = String(key).toLowerCase();
    if (map.has(k)) return; // first entry wins
    map.set(k, value);
  };
  if (Array.isArray(customFields)) {
    for (const entry of customFields) {
      if (entry == null || typeof entry !== 'object') continue;
      const name = entry.name ?? (typeof entry.field === 'string' ? entry.field : null);
      if (name != null) {
        set(name, entry.value);
      } else if (typeof entry.field === 'number' && entry.value != null) {
        for (const [fieldName, id] of Object.entries(fieldIds)) {
          if (id === entry.field) set(fieldName, entry.value);
        }
      }
    }
  } else if (typeof customFields === 'object') {
    for (const [key, value] of Object.entries(customFields)) set(key, value);
  }
  return map;
}

function extractManualValues(doc, ctx) {
  const cf = normalizeCustomFields(doc.custom_fields, ctx.fieldIds);
  const fromCustomField = (role) => {
    const name = ctx.fields[role];
    if (name == null) return undefined;
    return cf.get(String(name).toLowerCase());
  };
  // Explicitly provided ctx.manual* values win over re-extraction.
  return {
    amount: firstDefined(ctx.manualAmount, fromCustomField('amount')),
    date: firstDefined(ctx.manualDate, fromCustomField('date')),
    payee: firstDefined(ctx.manualPayee, fromCustomField('payee')),
  };
}

/** Parses a manual amount override to minor units + explicit sign, or null. */
function parseManualAmount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return {
      minor: Math.round(Math.abs(value) * 100),
      explicitSign: value < 0 ? 'expense' : null,
    };
  }
  const s = String(value).trim();
  if (s === '') return null;
  const explicitSign = /^-/.test(s) ? 'expense' : /^\+/.test(s) ? 'income' : null;
  const n = parseMoneyNumber(s);
  if (n == null) return null;
  return { minor: Math.round(Math.abs(n) * 100), explicitSign };
}

function formatIso(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null; // e.g. 31/02/2026 rolls over and is rejected
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function yearFromParts(y) {
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
}

/** Normalises a single date string to YYYY-MM-DD; raw string when unparseable. */
function normalizeDate(s) {
  if (s == null) return null;
  const text = String(s).trim();
  if (text === '') return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) {
    const iso = formatIso(+m[1], +m[2], +m[3]);
    if (iso) return iso;
  }
  m = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})$/.exec(text);
  if (m) {
    const iso = formatIso(yearFromParts(m[3]), +m[2], +m[1]);
    if (iso) return iso;
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{2,4})$/i.exec(text);
  if (m) {
    const mon = MONTH_BY_NAME[m[2].slice(0, 3).toLowerCase()];
    if (mon) {
      const iso = formatIso(yearFromParts(m[3]), mon, +m[1]);
      if (iso) return iso;
    }
  }
  return text; // verbatim fallback
}

/** Scans OCR content for the earliest valid date -> YYYY-MM-DD, else null. */
function parseContentDate(content) {
  let best = null;
  const consider = (iso, index) => {
    if (iso && (best == null || index < best.index)) best = { iso, index };
  };

  for (const m of content.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    consider(formatIso(+m[1], +m[2], +m[3]), m.index);
  }
  for (const m of content.matchAll(/\b(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})\b/g)) {
    consider(formatIso(yearFromParts(m[3]), +m[2], +m[1]), m.index);
  }
  for (const m of content.matchAll(/\b(\d{1,2})\s+(\d{1,2})\s+(\d{4})\b/g)) {
    consider(formatIso(+m[3], +m[2], +m[1]), m.index);
  }
  for (const m of content.matchAll(MONTH_NAME_RE)) {
    const mon = MONTH_BY_NAME[m[2].slice(0, 3).toLowerCase()];
    if (!mon) continue;
    consider(formatIso(yearFromParts(m[3]), mon, +m[1]), m.index);
  }
  return best ? best.iso : null;
}

function isoFromCreated(created) {
  if (created == null) return null;
  if (created instanceof Date) {
    return Number.isNaN(created.getTime()) ? null : created.toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(created).trim());
  if (!m) return null;
  return formatIso(+m[1], +m[2], +m[3]);
}

function resolvePayee(doc, manualPayee) {
  if (manualPayee != null) {
    const s = String(manualPayee).trim();
    if (s) return s;
  }
  if (typeof doc.correspondent === 'string' && doc.correspondent.trim()) {
    return doc.correspondent.trim();
  }
  if (typeof doc.title === 'string') {
    for (const line of doc.title.split(/\r?\n/)) {
      const t = line.trim();
      if (t) return t;
    }
  }
  return null;
}

function isIncomeDocument(doc, content, ctx) {
  const { documentTypes, tags, documentTypeIds, tagIds } = ctx.incomeSignals;
  const docType = doc.document_type;
  const docTags = Array.isArray(doc.tags) ? doc.tags : [];

  // String-name path: matches name-keyed fixtures/ctx (doc.document_type /
  // doc.tags carry the literal names) by string coercion.
  const nameHits = (list) =>
    list.some((v) => {
      const s = String(v);
      if (docType != null && String(docType) === s) return true;
      return docTags.some((t) => String(t) === s);
    });

  // Numeric-id path (Stage 3): real Paperless documents carry numeric
  // tag/document_type ids; match those against the resolved id lists strictly
  // so a name like 'invoice' never string-coerces into a numeric id match.
  const idHits = (list) =>
    list.some((id) => {
      if (docType != null && docType === id) return true;
      return docTags.some((t) => t === id);
    });

  if (nameHits(documentTypes) || nameHits(tags)) return true;
  if (idHits(documentTypeIds) || idHits(tagIds)) return true;
  return INCOME_KEYWORDS_RE.test(content);
}

/**
 * Finds the best amount in OCR content:
 *   1. label-preference scan (Total:, Amount Due, Balance, GST incl, To Pay,
 *      Pay this amount) - the money token nearest the label wins,
 *   2. first currency-attached number anywhere.
 * Returns {number, tokenCur, labelFound} or null when nothing matches.
 */
function findAmount(content) {
  for (const label of AMOUNT_LABELS) {
    const hit = matchLabeled(content, label);
    if (hit) return hit;
  }
  return matchUnlabeled(content);
}

function matchLabeled(content, label) {
  const occRe = new RegExp(`\\b${labelPattern(label)}\\b`, 'gi');
  for (const occ of content.matchAll(occRe)) {
    const after = content.slice(occ.index + occ[0].length, occ.index + occ[0].length + 80);
    const cur = CURRENCY_RE.exec(after);
    const numbers = [...after.matchAll(NUMBER_RE)].map((m) => ({
      idx: m.index,
      len: m[0].length,
      num: m[0],
    }));

    if (cur) {
      const curEnd = cur.index + cur[0].length;
      const afterCur = numbers.find((n) => n.idx >= curEnd);
      if (afterCur && afterCur.idx - curEnd <= 20) {
        return { number: afterCur.num, tokenCur: cur[0], labelFound: true };
      }
      const beforeCur = [...numbers]
        .reverse()
        .find((n) => n.idx + n.len <= cur.index);
      if (beforeCur && cur.index - (beforeCur.idx + beforeCur.len) <= 20) {
        return { number: beforeCur.num, tokenCur: cur[0], labelFound: true };
      }
      continue; // no amount near this label occurrence
    }

    const firstNumber = numbers.find((n) => n.idx <= 25) ?? numbers[0];
    if (firstNumber != null && firstNumber.idx <= 25) {
      return { number: firstNumber.num, tokenCur: null, labelFound: true };
    }
  }
  return null;
}

function matchUnlabeled(content) {
  const re = new RegExp(`(?:(${CURRENCY_SRC})\\s*)?(${NUMBER})(?:\\s*(${CURRENCY_SRC}))?`, 'gi');
  for (const m of content.matchAll(re)) {
    const cur = m[1] ?? m[3];
    if (cur) return { number: m[2], tokenCur: cur, labelFound: false };
  }
  return null;
}

/**
 * Classifies the document currency.
 * Explicit currency codes win; AUD markers (AU$ / $AU) imply AUD; otherwise a
 * bare `$` amount is local only when it carries a money label or AU context
 * evidence - unlabelled bare `$` is ambiguous and therefore foreign.
 */
function detectCurrency(content, token, home) {
  const codes = [...content.matchAll(CODE_RE)].map((m) => m[1].toUpperCase());
  const nonHome = codes.find((c) => c !== home);
  if (nonHome) return { foreign: true, currency: nonHome };
  if (codes.length > 0) return { foreign: false, currency: home };

  if (/AU\$|\$AU/i.test(content)) return { foreign: home !== 'AUD', currency: 'AUD' };

  const tokenCur = token?.tokenCur ?? null;
  switch (tokenCur) {
    case '€':
      return { foreign: true, currency: 'EUR' };
    case '£':
      return { foreign: true, currency: 'GBP' };
    case '¥':
      return { foreign: true, currency: 'JPY' };
    case 'US$':
      return { foreign: true, currency: 'USD' };
    case 'AU$':
    case '$AU':
      return { foreign: false, currency: 'AUD' };
    case '$': {
      if (token?.labelFound || AU_CONTEXT_RE.test(content)) {
        return { foreign: false, currency: home };
      }
      return { foreign: true, currency: null }; // ambiguous -> needs-review
    }
    default:
      return { foreign: false, currency: home };
  }
}

/**
 * Parses a document into a normalized transaction shape.
 *
 * @param {object}  doc  {id, title, content, created, document_type, tags,
 *                       correspondent, custom_fields}
 * @param {object}  ctx  {currency, timezone, dateFormats, fields,
 *                       incomeSignals: {documentTypes, tags,
 *                       documentTypeIds, tagIds}, fieldIds,
 *                       manualAmount, manualDate, manualPayee}
 * @returns {{ok: boolean, amount: number|null, date: string|null,
 *            payee: string|null, currency: string|null, sign: string,
 *            confidence: string, foreign: boolean, reason: string|null}}
 */
export function parseDoc(doc, ctx = {}) {
  const c = normalizeCtx(ctx);
  const d = doc == null || typeof doc !== 'object' ? {} : doc;
  const content = d.content == null ? '' : String(d.content);

  const manual = extractManualValues(d, c);

  const result = {
    ok: true,
    amount: null,
    date: null,
    payee: null,
    currency: c.currency,
    sign: 'unknown',
    confidence: 'low',
    foreign: false,
    reason: null,
  };

  result.payee = resolvePayee(d, manual.payee);

  if (manual.date != null) result.date = normalizeDate(String(manual.date).trim());
  if (result.date == null) result.date = parseContentDate(content);
  if (result.date == null) result.date = isoFromCreated(d.created);

  const income = isIncomeDocument(d, content, c);

  if (manual.amount != null) {
    const parsed = parseManualAmount(manual.amount);
    if (parsed == null) {
      result.ok = false;
      result.reason = 'no-amount';
      result.confidence = 'low';
    } else {
      // A human-set amount is authoritative; it may still be foreign.
      const sign = parsed.explicitSign ?? (income ? 'income' : 'expense');
      result.amount = sign === 'income' ? Math.abs(parsed.minor) : -Math.abs(parsed.minor);
      result.sign = sign;
      result.confidence = 'high';
      const det = detectCurrency(content, null, c.currency);
      result.currency = det.currency === undefined ? c.currency : det.currency;
      result.foreign = det.foreign;
    }
    return result;
  }

  const found = findAmount(content);
  if (found == null) {
    result.ok = false;
    result.reason = 'no-amount';
    result.confidence = 'low';
    return result;
  }

  const det = detectCurrency(content, found, c.currency);
  result.currency = det.currency === undefined ? c.currency : det.currency;
  result.foreign = det.foreign;

  if (det.foreign) {
    // No AUD amount may be assumed for a foreign document.
    result.ok = false;
    result.reason = 'foreign-currency';
    result.amount = null;
    result.sign = 'unknown';
    result.confidence = 'medium';
    return result;
  }

  const minor = Math.round(parseMoneyNumber(found.number) * 100);
  if (!Number.isFinite(minor)) {
    result.ok = false;
    result.reason = 'no-amount';
    result.confidence = 'low';
    return result;
  }

  const sign = income ? 'income' : 'expense';
  result.amount = sign === 'income' ? Math.abs(minor) : -Math.abs(minor);
  result.sign = sign;
  result.confidence = found.labelFound ? 'high' : 'medium';
  return result;
}