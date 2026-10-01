// OCR content samples and document fixtures for the parser engine tests.

export const AU_INVOICE_CONTENT = `Acme Plumbing Pty Ltd
ABN 12 345 678 901
Invoice #INV-2026-001
25/10/2026
GST inclusive
Total: $50.00
Please pay within 14 days`;

export const AU_INVOICE_DOC = Object.freeze({
  id: 1,
  title: 'Acme Plumbing Pty Ltd - Invoice',
  content: AU_INVOICE_CONTENT,
  created: '2026-09-30T10:00:00+10:00',
  document_type: 'invoice',
  tags: ['invoice'],
  correspondent: 'Acme Plumbing Pty Ltd',
  custom_fields: [],
});

export const AU_GST_INVOICE_CONTENT = `Hannah's Handy Services
ABN 98 765 432 100
Tax Invoice #TX-2026-088
Issue date: 15 October 2026
Labour ..................... $ 1,100.00
Parts  ..................... $ 134.56
Total (GST incl): $1,234.56`;

export const AU_GST_INVOICE_DOC = Object.freeze({
  id: 2,
  title: "Hannah's Handy Services - Tax Invoice",
  content: AU_GST_INVOICE_CONTENT,
  created: '2026-09-29T10:00:00+10:00',
  document_type: 'invoice',
  tags: ['invoice'],
  correspondent: "Hannah's Handy Services",
  custom_fields: [],
});

export const USD_INVOICE_CONTENT = `Global Supply Inc.
Invoice #GS-4401
Due 30 days from issue
Amount Due: USD $10.00
www.globalsupply.example`;

export const USD_INVOICE_DOC = Object.freeze({
  id: 11,
  title: 'Global Supply Inc. - Invoice',
  content: USD_INVOICE_CONTENT,
  created: '2026-09-28T09:00:00+10:00',
  document_type: 'invoice',
  tags: ['invoice'],
  correspondent: 'Global Supply Inc.',
  custom_fields: [],
});

export const AMBIGUOUS_BARE_USD_CONTENT = `Corner Cafe
Please find payment enclosed
$20.00
Thank you`;

export const REFUND_CREDIT_NOTE_CONTENT = `Acme Plumbing Pty Ltd
ABN 12 345 678 901
Credit Note #CN-042
15/09/2026
Refund for overpayment on invoice #INV-040
Total: $30.00`;

export const REFUND_CREDIT_NOTE_DOC = Object.freeze({
  id: 18,
  title: 'Acme Plumbing Pty Ltd - Credit Note',
  content: REFUND_CREDIT_NOTE_CONTENT,
  created: '2026-09-20T09:00:00+10:00',
  document_type: 'credit_note',
  tags: ['credit_note'],
  correspondent: 'Acme Plumbing Pty Ltd',
  custom_fields: [],
});

export const NO_AMOUNT_CONTENT = `Dear Sir/Madam,
Please find your statement enclosed.
Kind regards,
The Accounts Team`;

export const NO_AMOUNT_DOC = Object.freeze({
  id: 14,
  title: 'Accounts Team - Statement',
  content: NO_AMOUNT_CONTENT,
  created: '2026-09-26T09:00:00+10:00',
  document_type: 'correspondence',
  tags: ['statement'],
  correspondent: 'Accounts Team',
  custom_fields: [],
});

export const EXPLICIT_AUD_CONTENT = `Invoice #AUD-001
Amount: AUD 123.45`;

export const EXPLICIT_AUD_DOC = Object.freeze({
  id: 13,
  title: 'Invoice AUD-001',
  content: EXPLICIT_AUD_CONTENT,
  created: '2026-09-27T09:00:00+10:00',
  document_type: 'invoice',
  tags: [],
  correspondent: null,
  custom_fields: [],
});

export const ISO_DATE_CONTENT = `Digital Receipt #R-2026-1337
2026-10-25
Total: $15.90`;

export const ISO_DATE_DOC = Object.freeze({
  id: 15,
  title: 'Digital Receipt R-2026-1337',
  content: ISO_DATE_CONTENT,
  created: '2026-09-25T09:00:00+10:00',
  document_type: 'receipt',
  tags: ['receipt'],
  correspondent: 'ShopCo',
  custom_fields: [],
});

export const EURO_CONTENT = `Maison Verte
Facture #F-44
Total: 50,00 €`;

export const EURO_DOC = Object.freeze({
  id: 12,
  title: 'Maison Verte - Facture F-44',
  content: EURO_CONTENT,
  created: '2026-09-24T09:00:00+10:00',
  document_type: 'invoice',
  tags: [],
  correspondent: 'Maison Verte',
  custom_fields: [],
});

export const DMY_DATE_CONTENT = `Statement
Issue date: 25/10/2026
Total: $80.00`;

export const DMY_DATE_DOC = Object.freeze({
  id: 16,
  title: 'Statement',
  content: DMY_DATE_CONTENT,
  created: '2026-09-23T09:00:00+10:00',
  document_type: 'statement',
  tags: [],
  correspondent: null,
  custom_fields: [],
});

export const MONTH_DATE_CONTENT = `Plan renewal notice
Date: 25 October 2026
Total: $120.00`;

export const MONTH_DATE_DOC = Object.freeze({
  id: 17,
  title: 'Plan renewal notice',
  content: MONTH_DATE_CONTENT,
  created: '2026-09-22T09:00:00+10:00',
  document_type: 'invoice',
  tags: [],
  correspondent: 'ISP Co',
  custom_fields: [],
});