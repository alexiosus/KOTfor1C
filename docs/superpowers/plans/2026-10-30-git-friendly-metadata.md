# Git-friendly Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Implement inline; user explicitly delegated design and execution without further approvals.

**Goal:** Minimize unrelated Git changes and make real KOT metadata conflicts reviewable and safe to resolve.

**Architecture:** Shard group definitions, retain legacy import/deletion history without a growing global ledger, and put display order in workspace state. Keep shared membership/description/catalog facts versioned and provide typed three-way merging for their actual conflicts.

**Tech Stack:** TypeScript, Node fs/child_process, existing yaml package, VS Code API, Node test runner; Windows PowerShell 5.1-compatible 1cDrive CI readers.

**Spec:** `docs/superpowers/specs/2026-10-30-git-friendly-metadata-design.md`

## Final user revisions

- The former groups.yml format was test-only and has no runtime/CI compatibility requirement. Read only individual group records; our own metadata was prepared once.
- No `.kot/migrations` or frozen global scenario ledger. Use `.kot/imports.yml` for the older embedded-metadata import marker and per-object history for explicit deletions/remaps.
- Python CI checks are temporary developer verification only; no Python file belongs in either repository. All fixture reads/writes use explicit UTF-8.

## Global Constraints

- Preserve authored scenario text, parameters, process steps, UIDs and group IDs.
- `.yml` service files only; no Node dependencies added.
- Continue in the existing `codex/reliability-foundation` branch; preserve the user's unrelated `THIRD_PARTY_LICENSES.md` edit.
- Update external `/Users/alexeremeev/Development/1cDrive/build` only within the authorized CI scope; do not publish/merge or use Parallels.
- User chose native execution without additional approvals. No intermediate approval or execution-method handoff.

## Review Focus

- Concurrent migration/write interruption must not discard old groups, history or user edits.
- Membership and personal ordering must remain consistent across Test Manager/Library and multiple project roots.
- Deleting/remapping metadata must not resurrect old imported groups or descriptions.
- Semantic merges must respect deletions, immutable identities, invalid YAML and numbering collisions.
- Git conflict actions must preserve dirty/manual edits and reject stale index/disk snapshots or unsafe paths.

### Task 1: Distributed group storage and retained migration history

**Files:** `src/projectLibraryStore.ts`, new focused metadata-layout helper(s), `test/projectLibraryStore.test.ts`, `test/projectLibrarySidecars.test.ts`, new storage/migration tests; affected setup/watchers.

**Interfaces:** Keep `ProjectLibrarySnapshot`, `ProjectEntityIdentity`, `readGroups()` and group CRUD compatible for consumers. Add pure parse/serialize/layout helpers and atomic pending-write plans; derive known keys from tombstones and existing records.

- [x] Write failing tests: separate files for independent groups, no shared writes for new/edited objects, retained per-object deletion history, malformed/duplicate group records.
- [x] Run focused Node tests; observe expected failures before implementation.
- [x] Implement layout and integrate it with existing transaction guards, metadata cleanup and group-only reads. Migrate without gratuitous writes.
- [x] Run storage/sidecar/catalog tests and repair only regressions caused by the deliberate layout change.

### Task 2: Local ordering everywhere

**Files:** `src/projectGroupDisplayOrder.ts`, new `src/projectEntityDisplayOrder.ts`, `src/phaseSwitcher.ts`, `src/projectLibraryMetadata.ts`, `src/standaloneFeatureService.ts`, Properties session/host bindings, ordering tests.

**Interfaces:** Local state orders stable entity keys per root/section/group, validates expected visible sequences and excludes removed members. Membership mutation validates source ownership but writes only the moved record. Both views consume the same local ordering projection.

- [x] Write failing tests for in-group zero writes, cross-group one-sidecar writes, fresh workspace isolation, stale drops, deleted items, Properties local order and unchanged process steps.
- [x] Run focused tests and observe failures.
- [x] Implement local drag/Properties order and shared membership mutation, preserving existing layout as an initial fallback.
- [x] Verify main/process/standalone ordering and provider/Properties integration tests.

### Task 3: Typed three-way metadata merging

**Files:** new `src/projectMetadataMerge.ts`, new merge unit tests.

**Interfaces:** A pure merge accepts base/ours/theirs text or absence plus supported metadata kind and returns validated merged data with explicit conflict records. Resolution choices produce a schema-checked final document. No filesystem writes in the engine.

- [x] Write failing cases for independent group/sidecar edits, add/add, delete/edit, set history, catalog values/system-function UID collisions, numbering max counters and conflicting author edits.
- [x] Implement domain-keyed merge and validation using existing schemas where possible.
- [x] Prove deterministic, order-independent clean merges and explicit unresolved conflicts.

### Task 4: Reviewable resolution command and documentation

**Files:** new VS Code integration module, `src/extension.ts`, manifest/localizations, Maintenance menu, integration tests, user/technical guides and generated references.

**Interfaces:** Read Git unmerged stages with argument-safe execFile, constrain supported paths to the project, show conflicts and a proposed diff, then apply through an optimistic guarded write. Leave staging/commit to the user. Surface actual remaining duplicate identities/codes/references.

- [x] Write failing tests for stale/dirty/manual input, path safety, cancel/no-write, same-field choices, clean merge preview/apply and unchanged index.
- [x] Implement and register the command early enough to work with conflicted project metadata.
- [x] Update terminology and migration/merge instructions; regenerate references and validate localization/docs.

### Task 5: CI compatibility and our project migration

**Files:** `/Users/alexeremeev/Development/1cDrive/build/develop_parallel/SpprCi.Common.ps1`, CI tests/README, tracked demo and own `.kot` organization data.

- [x] Write failing PowerShell fixtures for `.kot/groups/<id>.yml`, duplicate IDs and readonly phase selection.
- [x] Update readers and prove phase filters select the expected setting UIDs without changing sources.
- [x] Migrate our metadata using the guarded store, comparing identity/membership/history and source hashes before/after.
- [x] Run `npm run check`, `npm run compile`, `npm run verify:demo`, `npm run docs:check`, CI PowerShell tests and whitespace checks.
- [x] Request one fresh final review as required by executing-plans, fix important findings with regression tests, and report verified scope and remaining live-CI limits. No release/merge/push is part of this task.
