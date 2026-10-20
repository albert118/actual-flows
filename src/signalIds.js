// Shared read-only signal-name → Paperless-id resolution.
//
// Both bridge.js (resolveSignalIds({create:false}) — dry-run/report) and
// report.js (reconcile) must resolve the configured signal names to the same
// Paperless ids, so the implementation lives here instead of being duplicated
// in each file. Strictly read-only: tags are looked up with tagIdByName, never
// ensureTag, so this can never create a Paperless tag.

import { signalEntryName } from './config.js';

/**
 * Resolves configured signal names to Paperless ids using read-only lookups
 * (tagIdByName / listDocumentTypes / listCorrespondents — never ensureTag).
 * Unresolvable names are logged and skipped, never fatal.
 *
 * Returns `{signals: {tagIds, documentTypeIds, correspondentIds}}` — the flat
 * id lists listCandidateDocs' OR-filter and listSignalDocsInRange consume —
 * plus `matches`, per kind in config order, the resolved `{entry, id}` pairs
 * so per-doc account mapping can find which entry matched a document.
 *
 * @param {object} args
 * @param {object} args.paperless paperless client (listDocumentTypes,
 *                                listCorrespondents, tagIdByName)
 * @param {object} args.signals   resolved config `signals` section
 * @returns {Promise<{signals: {tagIds: number[], documentTypeIds: number[], correspondentIds: number[]}, matches: {tags: Array<{entry, id}>, documentTypes: Array<{entry, id}>, correspondents: Array<{entry, id}>}}>}
 */
export async function resolveSignalIdsReadOnly({ paperless, signals }) {
  const listedTags = Array.isArray(signals.tags) ? signals.tags : [];
  const listedDocumentTypes = Array.isArray(signals.documentTypes) ? signals.documentTypes : [];
  const listedCorrespondents = Array.isArray(signals.correspondents) ? signals.correspondents : [];

  const tagIds = [];
  const tags = [];
  for (const entry of listedTags) {
    const name = signalEntryName(entry);
    const id = await paperless.tagIdByName(name);
    if (id != null) {
      tagIds.push(id);
      tags.push({ entry, id });
    } else console.warn(`actual-flows: signal tag "${name}" does not exist in Paperless; skipping`);
  }

  const documentTypeIds = [];
  const documentTypes = [];
  const docTypes = await paperless.listDocumentTypes();
  for (const entry of listedDocumentTypes) {
    const name = signalEntryName(entry);
    const id = docTypes.get(name);
    if (id != null) {
      documentTypeIds.push(id);
      documentTypes.push({ entry, id });
    } else console.warn(`actual-flows: signal document type "${name}" does not exist; skipping`);
  }

  const correspondentIds = [];
  const correspondents = [];
  const correspondentMap = await paperless.listCorrespondents();
  for (const entry of listedCorrespondents) {
    const name = signalEntryName(entry);
    const id = correspondentMap.get(name);
    if (id != null) {
      correspondentIds.push(id);
      correspondents.push({ entry, id });
    } else console.warn(`actual-flows: signal correspondent "${name}" does not exist; skipping`);
  }

  return {
    signals: { tagIds, documentTypeIds, correspondentIds },
    matches: { tags, documentTypes, correspondents },
  };
}