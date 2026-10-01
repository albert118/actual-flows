// Stage 5 reconcile-report stub (v2, deferred).
//
// The v2 reconcile report will compare Actual transactions against their
// Paperless source documents and flag mismatches. Not yet implemented — this
// stub exists so the `--reconcile` flag has a real route in the CLI and the
// command contract stays stable. `config`, `paperless`, and `actual` are
// accepted for signature stability and ignored for now.

/**
 * Reconcile report entry point (stub).
 *
 * @param {object} [args]
 * @param {object} [args.config]    resolved bridge config (unused)
 * @param {object} [args.paperless] Paperless client (unused)
 * @param {object} [args.actual]    Actual api handle (unused)
 * @returns {{implemented: boolean}}
 */
export function runReconcile({ config, paperless, actual } = {}) {
  console.log('reconcile report not yet implemented (v2)');
  return { implemented: false };
}