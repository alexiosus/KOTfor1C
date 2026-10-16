# Compiler YAML section actions

User scope: buttons adding records in scenario/process parameter sections, each process step's parameters, and scenario/process/test tags. Also explain whether stock SPPR fields can replace KOT metadata; no metadata migration requested.

- [x] Structural section detection for each file type and exact process step UID.
- [x] Source-preserving record insertion, quoted stock fields, safe numbering, duplicate-name checks and CRLF.
- [x] Localized CodeLens actions, exact document/version targets and stale-dialog protection.
- [x] Complete regression tests, review and full release gate.
- [x] Document actions and explain metadata equivalence/tradeoffs using compiler sources.

Validation: `npm run vscode:prepublish` passed (types, lint, 1201 passing tests, 2 skipped, production bundle). Scoped review reproduced an insertion into the wrong step when a preceding record had a numeric/non-string key; editable record validation now rejects unsupported keys, with regression coverage for numeric, boolean and empty keys. Interface fixtures cover main scenario/process labels and icons, exact document targets and both process step header actions. Native VS Code rendering and compiler execution in 1C were not performed for this change.
