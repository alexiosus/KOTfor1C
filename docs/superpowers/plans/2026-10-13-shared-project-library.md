# Shared Project Library Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for the independent implementation domains below.

**Goal:** Share library organization and KOT metadata through Git, preserve legacy data, and provide consistent group creation in all Test Manager sections.

**Architecture:** A filesystem store owns group objects and per-entity YAML metadata. Scenario scanning and standalone discovery project these records into existing catalogs, keeping their runtime URI identities. Editor/group actions write through the same store; local runtime state remains in VS Code.

**Tech Stack:** Existing TypeScript, Node filesystem, `yaml`, native webview JavaScript/CSS, node:test.

**Spec:** `docs/superpowers/specs/2026-10-13-shared-project-library-design.md`

## Global Constraints

- Preserve the current dirty tree; do not commit, publish, or modify external Drive files.
- Project record paths are relative; machine paths and credentials stay local.
- Existing shared data wins over legacy import. Invalid records are preserved and reported.
- Empty groups and stable identities survive reload and cloning.

## Review Focus

- A second checkout has different absolute paths but identical shared grouping and metadata.
- Git edits, deletes or conflicts never silently resurrect or overwrite shared records.
- Concurrent store consumers merge independent changes without dropping fields.
- Existing metadata editor actions and source saves do not restore a competing YAML authority.
- Hidden/disabled controls never move counts to a second row or appear during builds.

### Task 1: Project store

Files: new `src/projectLibraryStore.ts`, `test/projectLibraryStore.test.ts`.

- [x] Define exported group/entity snapshot, identity, import and mutation interfaces.
- [x] RED tests for portable identity, import idempotence, empty groups, invalid YAML, conflicts and concurrent writes.
- [x] Implement serialized validated YAML storage with stable group IDs, section projection and per-entity objects.
- [x] Verify targeted tests and type checks.

### Task 2: Standalone organization adapter

Files: `src/standaloneFeatureService.ts`, related tests.

- [x] RED tests for legacy organization import, shared grouping across two checkouts and keeping launch selection local.
- [x] Replace shared placement/group persistence with project store; retain local jsonPath bindings and runtime URI identities.
- [x] Refresh on project object changes and preserve rename/move behavior.
- [x] Verify existing and new standalone service tests.

### Task 3: Scenario metadata integration

Files: scanner/metadata adapter, `src/phaseSwitcher.ts`, metadata editor commands, scenario/process creators.

- [x] RED tests for authoritative group/order/description/category, legacy fallback and UID after rename.
- [x] Import and overlay project metadata during scanning; route metadata changes to project objects and avoid automatic competing metadata writes.
- [x] Persist new scenario/process metadata and group rename through the shared store.
- [x] Refresh Library/Test Manager on store changes, and expose empty groups and group creation commands.
- [x] Verify targeted scanner/editor/phase tests.

### Task 4: Header/group UI and library projection

Files: `media/phaseSwitcher.js`, `media/phaseSwitcher.css`, `media/standaloneFeatures.css`, library models/media, tests, localization.

- [x] RED regressions for new-group messages and identical header/control alignment in all sections.
- [x] Add new-folder actions and exact shared group identity; retain one group + dropdown.
- [x] Include persistent empty groups in both Libraries and Test Manager.
- [x] Verify hover/focus/build behavior and source/search/selection compatibility.

### Task 5: Review and completion

- [x] Document storage, migration, Git sharing and personal-state boundaries.
- [x] Review consumer/editor completeness, compatibility and conflict behavior.
- [x] Run `npm run vscode:prepublish`, inspect all results and `git diff --check`.

Validation: `npm run vscode:prepublish` passed: 1321 passed, 2 skipped, type checks, lint and production bundle successful. Independent reviews resolved shared-root section merging, rename preflight, bootstrap before migration, root ownership, dirty metadata, duplicate UIDs and compiler input compatibility. Core/scenario/standalone storage uses `.yml` and a known-scenario ledger; source corpus/EPF were read-only and no live 1C execution was performed.
