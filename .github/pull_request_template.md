## Summary

<!-- What changes and why, in a few lines. -->

## Changes

-

## Checks

- [ ] Tests added or updated for each behaviour change, including failure paths
- [ ] Tests use no network (injected fetch and fakes)
- [ ] `--dry-run` and `--reconcile` still make zero writes to Paperless and Actual
- [ ] Re-running `--import` stays idempotent (`imported_id = paperless:<id>`, no duplicates)
- [ ] No tokens, passwords or real documents in code, fixtures, logs or commit history
- [ ] New or changed config keys are in `config.example.json`, `.env.example` and the README
- [ ] No new dependency, or the reason is given below
- [ ] No Node version change, or `.node-version`, the Dockerfile and CI move together

## Dependencies and risks

<!-- New dependencies and why. Anything that can write to Paperless or Actual in a new way, or import a document twice. "None" if none. -->

## Notes for the reviewer

<!-- Optional: where to start, what to ignore, follow-ups. -->
