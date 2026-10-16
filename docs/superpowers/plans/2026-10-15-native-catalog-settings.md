# Native VS Code catalog settings implementation plan

> Use superpowers:executing-plans inline. The user explicitly chose ordinary VS Code settings, including catalog editing. Preserve the current dirty checkout; do not change external Drive files or commit.

**Goal:** Edit shared catalogs and tester series from Ctrl+, and set a personal numbering prefix there.

**Architecture:** Resource-scoped catalog settings project the common `.kot/property-catalogs.yml` and `.kot/test-numbering.yml` into native Settings controls. A serialized synchronizer uses per-field baselines to distinguish user settings edits from project/Git changes, mirrors successful edits, and refuses conflicting changes. Prefix selection is a separate local/machine setting. Workspace/Folder hold project catalogs; User-tab catalog edits prompt to open project settings or explicitly transfer additions into one selected project. No automatic transfer occurs.

**Tech Stack:** Existing TypeScript, YAML AST stores, VS Code configuration/file events, node:test.

## Constraints and review focus

- `.kot` remains shared storage; do not replace it with an independent settings-only catalog.
- Preserve YAML comments, unrelated fields, system-function UIDs and issued counters.
- No source renaming or UID changes from catalog-only edits.
- Native settings are a synchronized projection and can add corresponding values to workspace settings.json; no reflection before a catalog exists or a setting is explicitly edited.
- Conflicting simultaneous edits must preserve both versions and report an actionable error.
- Retired issued numbering prefixes cannot be deleted/reused; settings only expose prefix/author, never a decrementable counter.
- Existing creator and palette flows stay usable; a configured personal prefix is honored by creation and can be changed by the manager.

## Tasks

- [x] Add failing tests and guarded replacement methods to both stores. Bulk catalog edits retain unrelated data; series definition changes preserve counters and cannot drop issued history.
- [x] Add/test a per-field settings synchronization engine with filesystem-backed stores and native configuration adapter. Cover initial seed, Git changes, settings edits, conflicts, invalid values, dirty metadata and loop prevention.
- [x] Add native configuration controls for projects, responsibles, report levels, categories, system functions, numbering definitions and personal prefix; keep Workspace catalog scope explicit.
- [x] Connect synchronizer lifecycle and prefix selection, add creation regressions and localizations.
- [x] Update docs, run npm run vscode:prepublish, obtain focused independent review and resolve material findings.

## Verification

- Focused review found concurrent-edit loss and generated Folder overrides masking Workspace edits. Both were reproduced with failing tests and fixed. Field baselines record only consumed values; persistent projection ownership preserves genuine Folder overrides while accepting later Workspace edits.
- Native map comparisons ignore key enumeration order; ambiguous system function names are reported without collapsing their UIDs. Explicit empty lists are persisted.
- `npm run vscode:prepublish`: 1839 tests, 1837 passed, 2 skipped, 0 failed; type checks, lint and production bundling passed. Log: `/private/tmp/kot-native-catalogs-final-gate.log`.
- Eight native configuration controls and both manifest locale dictionaries were checked. No live VS Code Extension Host, external project catalogs, real 1C launch, commit or installation was used.

## Follow-up from native Settings screenshots

- Removed redundant KOT prefix from section title.
- Reproduced User-tab rejection and missing startup migration. Real Drive data confirmed functions exist in `.kot` and Workspace; the empty User table is a scope distinction.
- Native startup migrates explicitly configured legacy functions into a missing shared section. Existing and deliberately empty catalogs stay authoritative.
- Per user's final preference, User additions remain untouched until a notification action is selected. Opening project settings does not move data; explicit transfer merges additions into a single active/selected project, preserves counters, and clears only successfully transferred User values. Rejected transfers restore the previous project setting.
- Regression harness now distinguishes real single-folder Workspace inspection from multi-root Folder overrides.
- Independent follow-up review reproduced a transfer race: a concurrent Workspace edit could be applied instead of the proposed merge, then User input was cleared. Added a failing regression and verification of transferred entries in the actual shared catalog before clearing User; generated function UIDs are supported. Focused native suite: 17 passed.
- Final combined verification after the debug-client follow-up: `npm run vscode:prepublish` passed, 1853 tests / 1851 passed / 2 skipped / 0 failed. Log: `/private/tmp/kot-settings-and-debug-final-gate.log`.
- Debug-client follow-up corrected PathToInfobase vs AdditionalParameters authentication according to the upstream Vanessa form parser, covered Windows file paths, embedded server credentials and launch orchestration. Optional custom client keys are available in the basic wizard and remain in SecretStorage. Independent overlay review found no material defects; actual 1C execution was not performed.
