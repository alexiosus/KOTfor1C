# Nested and exported scenario conversion

Execute inline in the existing workspace; preserve unrelated work. Version remains 3.0.0. No commit requested.

**Goal:** Add nested ↔ exported scenario conversion to Conversions in the editor, Library and Properties.

**Design:** Nested → export prompts for a callable name prefilled with every declared parameter in quotes. Validation requires exactly the existing parameter names, allowing reordering. Export → nested asks for a name and creates declared SPPR parameters from the quoted arguments. Keep source language, body and comments; retain original nested metadata/defaults in a companion archive for a reversible conversion. Update saved SPPR callers and their nested declarations. Refuse ambiguous calls, dirty/changed files, collisions and constructs without a safe equivalent rather than silently losing behavior. Keep other scenarios in a shared export file intact.

**Implementation choice:** Use a pure source planner, a guarded file transaction with rollback, and a VS Code command adapter. Reuse existing parsing, parameter, reference and Properties services. A standalone feature cannot call an SPPR nested scenario, and process steps cannot directly reference an exported scenario; report these incompatibilities before writes.

- [x] Test and implement title validation, parameter/body mapping, reverse conversion and caller rewriting.
- [x] Test and implement guarded multi-file conversion and rollback, preserving nested metadata.
- [x] Integrate command, universal conversion picker, Properties and both Library surfaces; localize.
- [x] Update documentation/changelog, run focused tests, full check, compile and diff check.

## Verification

`npm run check` passed: 2490 total, 2488 passed, 0 failed, 2 skipped. Application/tool types and lint passed. `npm run compile` and `git diff --check` passed. Tests cover both SPPR formats, native callers, parameter reordering/removal, tags, Russian/CRLF input, defaults, cancellation, dirty files/collisions, partial rollback, unsupported hard links, existing exports without an archive and exclusion of generated build artifacts from reference rewrites. New title validation reuses the parsed parameter list; Properties detects export tags from its existing structure scan. No live DevHost acceptance or commit was performed.

## Follow-up: conversion menu and saved native documents

- [x] Replace the Properties disclosure group with one Conversions dropdown, including export-scenario rows; retain keyboard navigation and Escape.
- [x] Reproduce BOM-stripped VS Code models against BOM-bearing YAML/native files. Reuse `nativeDocumentTextMatchesFileText`; keep raw filesystem snapshots, reject dirty/content-changed models, and allow clean model reloads caused by the transaction itself.
- [x] Verify final disk contents before committing the transaction; concurrent writers are retained and cause recovery rather than false success.
- [x] Expand parameterless nested calls recursively, retaining dependencies and root arguments; reject cycles, excessive depth, incompatible languages, child tags/attachments and parameterized dependencies. Reverse conversion removes obsolete nested declarations from the inlined script metadata.
- [x] Match the creation wizard when promoting either scenarios or processes: automatically create `test/<code>.yaml` and its folder after infobase/user selection. Preserve existing archived settings paths on restore. No save-file picker.

Latest verification: `npm run check` passed with 2497 total, 2495 passed, 0 failed, 2 skipped; types and lint passed. `npm run compile` and `git diff --check` passed. A separate read-only compatibility check copied `native-workspace/tests/2000303/scen.yaml` and its `KOT mapped nested` dependency into a temporary fixture: export conversion passed, `buttonParam` became a callable argument, nested steps were expanded, and the actual user source SHA-256 remained `6fc9505b1d1354304a88d239f393e2844e3197e71f20370c7dde7aa25d50f013`. The external corpus is not part of automated tests. No live DevHost acceptance or commit was performed.

## Follow-up: missing export library configuration

- [x] With no configured library, default to the scenario's folder instead of rejecting conversion. Allow another chosen destination and register its folder for the active profile.
- [x] Reuse effective library resolution for compiler Libraries / VanessaLibraries and the winning priority Additional librarycatalogs alias; preserve other catalogs and profile settings. Keep workspace-local compiler paths relative.
- [x] Serialize registration with profile writes, reject a switched profile, restore the exact original settings when file conversion fails, and preserve externally changed settings during recovery. Notify consumers after successful file conversion.
- [x] Verify bidirectional caller rewriting with a reordered export title, explicit parent parameter references and omitted defaults. Update user documentation, translations and 3.0.0 changelog.

Verification: `npm run check` passed, including application/tool types and lint: 2507 total, 2505 passed, 0 failed, 2 skipped. `npm run compile` and `git diff --check` passed. The read-only compatibility fixture for `tests/2000303/scen.yaml` also passed with **no configured library roots**; its export folder was registered, `buttonParam` and inlined nested steps were retained, and the actual source SHA-256 remained unchanged. No live DevHost acceptance or commit was performed.

## Follow-up: shared exports, navigation and execution paint (2026-10-24)

- [x] Offer new or existing feature destination after the callable title. Append only the new exported declaration; validate language, syntax and duplicate names before writes. Retain unrelated declarations and support a collection of reversible metadata archives, including the original single-entry format.
- [x] Match equivalent file URI encodings for reverse conversion and relationship highlighting. Retain configured library paths for editor navigation while using physical paths for reading and deduplication, avoiding unexpected Parallels UNC links.
- [x] Share execution decoration rendering between MCP and log tracking, painting each line once with failure/running precedence and retaining other sources when a tracker is disposed. Restore the common panel button style in both Infobases surfaces.
- [x] Run regression tests, full checks, compile and Windows DevHost acceptance; update documentation and the 3.0.0 changelog.

Verification: `npm run check` passed with 2524 total, 2522 passed, 0 failed and 2 skipped, including application/tool type checks and lint. `npm run compile` passed. Regression tests cover logical path aliases during scans and watcher updates, URI encoding identity, shared execution paint and disposal, append/reverse conversions with other declarations and archive entries preserved, and rejection of language mismatch before writes.

The compiled bundle was reloaded in the Windows DevHost in Parallels. Opening the exported `KOTNESTED.feature` worked without the UNC error, F12 from its YAML caller opened the exported declaration, and Library relationship highlighting was visible. Reverse conversion from the exported scenario's Properties reached the prefilled name prompt; it was cancelled before file writes. The complete append/reverse transaction was verified in temporary test fixtures, not by converting the user's live source again. No commit or push was performed.

## Follow-up: SPPR metadata indentation (2026-10-24)

Both reverse conversion and the no-archive defaults adapter used the YAML serializer's default two-space indent. A shared metadata writer now uses four-space mappings and aligns actual CST sequence markers to the SPPR record layout (4 spaces for markers, 8 for record fields). CST offsets avoid changing dash-prefixed lines inside literal scalar payloads; serialized metadata is checked for valid YAML before the file transaction.

Three indentation regressions failed before the change. After it, all 25 focused callable conversion tests passed, covering archived/native round trips, new scenarios without archives, parameter/tag records and multiline scalar content. `npm run check` passed: 2530 total, 2528 passed, 0 failed, 2 skipped; types and lint passed. `npm run compile` passed. No user source files were rewritten during verification.

## Follow-up: immediate reverse conversion and existing-file picker (2026-10-24)

- [x] Reproduce immediate reversal with unchanged open models for deleted legacy/native sources produced by the old indentation writer, and with a caller editor still showing the pre-conversion text.
- [x] Bind a completed KOT file write to the exact unchanged document instance and version using a WeakMap. Permit its pending model reload only when the disk bytes match that completed write, including deletion; retain dirty-model, replaced-model, version, external-writer and exclusive-destination guards. No editor text is rewritten to force synchronization.
- [x] Replace the Existing feature file dialog with a searchable QuickPick from the existing project index and configured library roots, retaining logical navigation paths. Deduplicate files, omit native SPPR scripts and known generated artifacts, and retain a browse fallback. Cancel before changing any files.
- [x] Run focused tests and update the activation contract to distinguish an eager index wait from a deferred command callback, instead of banning the same text anywhere in the module. Update localization, user documentation and the 3.0.0 changelog.

All 22 focused command tests passed, including the two previously failing immediate-conversion cases and QuickPick selection/cancellation. Negative fixtures verify that a new editor instance, changed version, dirty buffer, externally changed caller and recreated target remain protected.

Full verification: `npm run check` passed with 2537 total, 2535 passed, 0 failed and 2 skipped, including types and lint. `npm run compile` passed. No live user test files were converted during this verification; the DevHost needs to reload the compiled bundle.
