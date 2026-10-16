# Shared system functions

Keep system function name/UID pairs in `.kot/property-catalogs.yml` alongside the existing shared project catalogs. Initialize a missing systemFunctions section once from legacy KOT settings, preserving UIDs. Once present, the project section is authoritative; local defaults cannot reintroduce deleted or renamed entries.

Use the same catalog for properties, scenario creation, header selection and the existing management command. Add/edit/reorder/delete write the project YAML while preserving other catalog fields and checking dirty documents/concurrent edits. Resolve ownership from the source or chosen creation folder, including external test roots and multi-root workspaces. Keep legacy settings as migration input and clarify their role in documentation/settings descriptions.

Validate migration/portability, native consumers and conflicts; run the full prepublish gate. No release, commit, installation or external Drive changes.

Completed 2026-10-14. Migration retains valid legacy GUID formats; project lists remain authoritative after local settings change. Native consumer tests verify paired header fields, manager rename/default order/UID/delete, multi-root and external project ownership, repository copy without local settings, and dirty/stale catalog guards. Review found an external-root manager selection gap; the selector now includes external project owners and its regression passes.

`npm run vscode:prepublish` passed: 1547 passed, 2 skipped, 0 failed, including type checks, lint and minified extension build. `git diff --check` passed. All tests use temporary projects; external Drive files remain unchanged.
