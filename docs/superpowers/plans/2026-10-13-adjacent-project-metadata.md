# Adjacent Project Metadata Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for scoped tasks.

**Goal:** Keep each test's KOT metadata next to its source while groups remain shared.

**Architecture:** The project store discovers adjacent sidecars and migrates its central records safely. Existing catalog and UI APIs continue using snapshots keyed by UID or relative feature path. Rename/delete/watch integrations preserve sidecars with their owners.

**Tech Stack:** TypeScript, Node filesystem, yaml, existing VS Code services, node:test.

**Spec:** `docs/superpowers/specs/2026-10-13-adjacent-project-metadata-design.md`

## Global Constraints

- Preserve all prior dirty work, runtime identities and local preferences.
- Do not commit/publish or migrate external Drive files during development.
- Sidecars end in `.kot.yml`; groups remain `.kot/groups.yml`.
- Validate and guard migration before removing old records; invalid/conflicting files remain intact.

## Review Focus

- Directory moves don't leave stale identity paths or lose groups/descriptions.
- Source-only filename moves keep their sidecars, including legacy files without UID.
- Existing adjacent metadata and dirty documents survive migration/edits.
- Deletion, Git updates and changes to test roots refresh all panels consistently.
- Neither old nor new metadata enters compiler `*.yaml` inputs.

### Task 1: Storage and migration

- [x] RED tests for adjacent paths, central import, precedence/conflict and relocation.
- [x] Change projectLibraryStore discovery/write/migration while keeping public APIs stable.
- [x] Verify guarded writes, old-format compatibility and sidecar-derived current identity.

### Task 2: Catalog/editor lifecycle

- [x] Watch adjacent files and guard their unsaved editors.
- [x] Preserve scenario/process sidecars on source-only file and folder rename.
- [x] Open/edit/create metadata through existing commands and refresh catalog after migration.
- [x] Verify targeted integration tests.

### Task 3: Standalone and deletion

- [x] Preserve feature sidecars during rename/group changes and multi-root moves.
- [x] Include sidecars in standalone/nested/process/main deletion plans without changing referenced-source guards.
- [x] Verify filename/directory relocation, local JSON state and trash behavior.

### Task 4: Completion

- [x] Update user docs with adjacent examples, migration and Git instructions.
- [x] Review storage/lifecycle/conflict behavior. Independent review was attempted but the reviewer hit its service usage limit; completed direct review and added regression coverage for cross-project destination conflicts instead.
- [x] Run full vscode:prepublish and git diff --check; record verified results.

Verified 2026-10-13: `npm run vscode:prepublish` exited 0 (1369 passed, 2 skipped, 1371 total; type checks, lint, tests and minified extension bundle). `git diff --check` passed. Log: `/private/tmp/kot-adjacent-release-gate.log`. No external Drive migration, 1C execution, commit or publication was performed.
