// Paperless-ngx REST client. Thin wrapper over the Paperless API using Node
// fetch, with token auth and API-versioned Accept header. Kept synchronous-
// free and dependency-free so Stage 4 orchestration can call it directly.

const DEFAULT_API_VERSION = 10;

function stripTrailingSlashes(url) {
  return url.replace(/\/+$/, '');
}

function resolveUrl(url, baseUrl) {
  return new URL(url, baseUrl + '/').toString();
}

/**
 * Shared signal OR-filter: a document matches when its `tags` intersect
 * `tagIds`, or its `document_type` is in `documentTypeIds`, or its
 * `correspondent` is in `correspondentIds`.
 */
function matchesSignal(doc, { tagIds = [], documentTypeIds = [], correspondentIds = [] } = {}) {
  const tags = Array.isArray(doc.tags) ? doc.tags : [];
  return (
    tags.some((tagId) => tagIds.includes(tagId)) ||
    documentTypeIds.includes(doc.document_type) ||
    correspondentIds.includes(doc.correspondent)
  );
}

/** Normalises the signal id lists, defaulting missing keys to empty arrays. */
function normaliseSignals(signals = {}) {
  const { tagIds = [], documentTypeIds = [], correspondentIds = [] } = signals;
  return { tagIds, documentTypeIds, correspondentIds };
}

/**
 * Creates a Paperless-ngx API client.
 *
 * @param {object} config
 * @param {string} config.baseUrl  Paperless base URL, e.g. http://paperless:8000
 * @param {string} config.token    Paperless API token
 * @param {number} [config.apiVersion] API version for the Accept header (default 10)
 * @param {typeof fetch} [config.fetchImpl] fetch implementation to use (injectable for tests)
 */
export function createPaperlessClient({
  baseUrl,
  token,
  apiVersion = DEFAULT_API_VERSION,
  fetchImpl = fetch,
}) {
  const api = {
    baseUrl: stripTrailingSlashes(baseUrl),
    token,
    apiVersion,
  };

  function headers(withBody) {
    return {
      Authorization: `Token ${token}`,
      Accept: `application/json; version=${apiVersion}`,
      ...(withBody ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async function request(urlOrPath, { method = 'GET', body } = {}) {
    const url = String(urlOrPath).startsWith('http')
      ? urlOrPath
      : `${api.baseUrl}${urlOrPath}`;
    const res = await fetchImpl(url, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const suffix = detail ? ` — ${detail}` : '';
      throw new Error(
        `Paperless API ${method} ${url} failed: HTTP ${res.status}${suffix}`,
      );
    }
    return res.json();
  }

  /**
   * Lists custom fields and maps them name → id.
   * @returns {Promise<Map<string, number>>}
   */
  async function listCustomFields() {
    const data = await request('/api/custom_fields/');
    const rows = Array.isArray(data) ? data : (data?.results ?? []);
    const byName = new Map();
    for (const field of rows) byName.set(field.name, field.id);
    return byName;
  }

  /**
   * Lists document types and maps them name → id (used to resolve signal
   * document-type names to ids; read-only).
   * @returns {Promise<Map<string, number>>}
   */
  async function listDocumentTypes() {
    const data = await request('/api/document_types/');
    const rows = Array.isArray(data) ? data : (data?.results ?? []);
    const byName = new Map();
    for (const type of rows) byName.set(type.name, type.id);
    return byName;
  }

  /**
   * Lists correspondents and maps them name → id (used to resolve signal
   * correspondent names to ids; read-only).
   * @returns {Promise<Map<string, number>>}
   */
  async function listCorrespondents() {
    const data = await request('/api/correspondents/');
    const rows = Array.isArray(data) ? data : (data?.results ?? []);
    const byName = new Map();
    for (const correspondent of rows) byName.set(correspondent.name, correspondent.id);
    return byName;
  }

  /**
   * Lists unimported documents (custom_field_query exists=false) across all
   * pages, then applies the client-side signal OR-filter.
   *
   * A document is a candidate when it matches any configured signal: its
   * `tags` intersects `signals.tagIds`, or `document_type` matches
   * `signals.documentTypeIds`, or `correspondent` matches
   * `signals.correspondentIds`.
   *
   * @param {object} opts
   * @param {string} opts.importedFieldName custom field whose presence marks a doc as imported
   * @param {number} [opts.pageSize=100]    documents per page
   * @param {{tagIds?: number[], documentTypeIds?: number[], correspondentIds?: number[]}} [opts.signals]
   * @param {Map<string, number>} [opts.customFieldIds] name→id map (used for the defensive client-side imported check)
   * @returns {Promise<Array<object>>} candidate documents
   */
  async function listCandidateDocs({
    importedFieldName,
    pageSize = 100,
    signals = {},
    customFieldIds,
  } = {}) {
    const { tagIds, documentTypeIds, correspondentIds } = normaliseSignals(signals);

    const customFieldQuery = JSON.stringify([importedFieldName, 'exists', false]);
    const importedFieldId = customFieldIds?.get(importedFieldName);

    const firstParams = new URLSearchParams({
      custom_field_query: customFieldQuery,
      page_size: String(pageSize),
      ordering: 'added',
    });

    const docs = [];
    let nextUrl = `/api/documents/?${firstParams}`;
    while (nextUrl) {
      const page = await request(nextUrl);
      docs.push(...(page.results ?? []));
      nextUrl = page.next ? resolveUrl(page.next, api.baseUrl) : null;
    }

    return docs.filter((doc) => {
      // Defensive: drop anything that already carries the imported field id.
      const cfs = Array.isArray(doc.custom_fields) ? doc.custom_fields : [];
      if (importedFieldId != null) {
        const alreadyImported = cfs.some(
          (entry) =>
            entry &&
            entry.field === importedFieldId &&
            entry.value != null &&
            entry.value !== '',
        );
        if (alreadyImported) return false;
      }

      return matchesSignal(doc, { tagIds, documentTypeIds, correspondentIds });
    });
  }

  /**
   * Lists signal documents whose added/created date falls within [start, end]
   * (inclusive, compared as YYYY-MM-DD date parts), across all pages, applying
   * the same signal OR-filter as listCandidateDocs but WITHOUT the
   * "imported field exists=false" filter: reconcile needs every signal doc in
   * the window (imported or not) so it can read the imported-field value.
   *
   * Returns one entry per doc: `{id, title, importedValue}` where
   * `importedValue` is the value of the imported custom field (`null` when
   * unset).
   *
   * @param {object} opts
   * @param {string} opts.importedFieldName custom field holding the Actual transaction id
   * @param {{tagIds?: number[], documentTypeIds?: number[], correspondentIds?: number[]}} [opts.signals]
   * @param {Map<string, number>} [opts.customFieldIds] name→id map
   * @param {string} opts.start inclusive lower bound, YYYY-MM-DD
   * @param {string} opts.end   inclusive upper bound, YYYY-MM-DD
   * @param {number} [opts.pageSize=100]
   * @returns {Promise<Array<{id: number, title: string|null, importedValue: string|null}>>}
   */
  async function listSignalDocsInRange({
    importedFieldName,
    signals = {},
    customFieldIds,
    start,
    end,
    pageSize = 100,
  } = {}) {
    const { tagIds, documentTypeIds, correspondentIds } = normaliseSignals(signals);
    const importedFieldId = customFieldIds?.get(importedFieldName);

    const firstParams = new URLSearchParams({
      page_size: String(pageSize),
      ordering: 'added',
    });

    const docs = [];
    let nextUrl = `/api/documents/?${firstParams}`;
    while (nextUrl) {
      const page = await request(nextUrl);
      docs.push(...(page.results ?? []));
      nextUrl = page.next ? resolveUrl(page.next, api.baseUrl) : null;
    }

    return docs
      .filter((doc) => {
        if (!matchesSignal(doc, { tagIds, documentTypeIds, correspondentIds })) return false;
        const day = String(doc.added ?? doc.created ?? '').slice(0, 10);
        return day >= start && day <= end;
      })
      .map((doc) => {
        let importedValue = null;
        if (importedFieldId != null && Array.isArray(doc.custom_fields)) {
          const entry = doc.custom_fields.find(
            (e) => e && e.field === importedFieldId && e.value != null && e.value !== '',
          );
          if (entry) importedValue = String(entry.value);
        }
        return { id: doc.id, title: doc.title ?? null, importedValue };
      });
  }

  /** @returns {Promise<object>} full document */
  async function getDocument(id) {
    return request(`/api/documents/${id}/`);
  }

  /** Resolves a tag id by exact name, or null when the tag does not exist. */
  async function tagIdByName(name) {
    const data = await request('/api/tags/');
    const rows = Array.isArray(data) ? data : (data?.results ?? []);
    const tag = rows.find((t) => t.name === name);
    return tag ? tag.id : null;
  }

  /** Resolves a tag id by name, creating the tag via POST when missing. */
  async function ensureTag(name) {
    const existing = await tagIdByName(name);
    if (existing != null) return existing;
    const created = await request('/api/tags/', { method: 'POST', body: { name } });
    return created.id;
  }

  /**
   * Patches a document's custom fields and tags.
   *
   * @param {number} id
   * @param {{custom_fields?: Array<{field: number, value: unknown}>, tags?: number[]}} changes
   * @returns {Promise<object>} the updated document
   */
  async function updateDoc(id, { custom_fields, tags } = {}) {
    const body = {};
    if (custom_fields !== undefined) body.custom_fields = custom_fields;
    if (tags !== undefined) body.tags = tags;
    return request(`/api/documents/${id}/`, { method: 'PATCH', body });
  }

  return {
    listCustomFields,
    listDocumentTypes,
    listCorrespondents,
    listCandidateDocs,
    listSignalDocsInRange,
    getDocument,
    tagIdByName,
    ensureTag,
    updateDoc,
  };
}