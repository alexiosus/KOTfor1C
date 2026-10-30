# Library and process controls Implementation Plan

> **For agentic workers:** Apply systematic debugging and TDD per independent task; root integrates shared protocols and runs the release gate.

**Goal:** Complete the nine Library, Test Manager and compiler compatibility corrections supplied by the user.

**Architecture:** Keep existing shared groups and exact URI identities. Reuse process YAML mutations, editor commands and deletion workflows; add validated Library messages for process step changes. Built-in definitions remain read-only.

**Tech Stack:** TypeScript, VS Code APIs, native webview JavaScript/CSS, node:test, bundled BSL source inspection.

**Spec:** User request dated 2026-10-12, points 1–9 with two screenshots.

## Global Constraints

- Preserve all intended dirty workspace changes; no commits, publishing or external YAML/compiler writes.
- Process reordering preserves step UIDs/parameter bindings and renumbers record blocks.
- Validate URI, process UID, snapshot identity and step signature before mutations.
- Ordinary value spaces are valid; tab diagnostics reflect the compiler's actual parsing rules.

## Review Focus

- Duplicate step UIDs, stale snapshot and simultaneous step changes reject edits.
- Drop from another process or a definition card cannot silently reorder a process.
- Referenced/dirty definition deletion follows existing safety and refresh conventions.
- Hidden group controls reserve no label width and remain hidden during build.
- English scenario content in processes and quoted/table values retain meaning.

### Task 1: Library definition presentation
- [x] Reproduce mixed-type icon and meta baseline layout failures.
- [x] Give every type a consistent icon/type label in both Library views; align metadata labels.
- [x] Verify DOM/type projection and CSS layout contracts.

### Task 2: Process steps in full Library
- [x] Write failing tests for drag reorder, remove and Add commands.
- [x] Add validated step target messages and source-preserving mutation APIs using existing move/remove helpers and Add wizard.
- [x] Implement drag handle/drop affordance, deletion and Add control; preserve focus/pending state and report errors.
- [x] Verify stale/foreign/duplicate UID rejection and parameter/number preservation.

### Task 3: Test Manager header controls
- [x] Reproduce hidden + width/fade and build-state visibility failures.
- [x] Fix controls and regression tests in the independent layout task.

### Task 4: Process and Library definition actions
- [x] Reproduce process rename/delete routing failures.
- [x] Reuse exact URI command routing; expose supported local definition deletion in both Library UIs.
- [x] Verify dirty/reference handling and cancellation; keep built-in catalog entries read-only.

### Task 5: YAML/compiler diagnostics and language
- [x] Inspect compiler indentation and English generation sources.
- [x] Reproduce and fix tab diagnostic/quick-fix gaps and KOT English compatibility bugs.
- [x] Verify structural YAML versus scalar content and document actual compiler limitations.

### Task 6: Integration
- [x] Integrate localization/command registration and document controls.
- [x] Scoped code review, git diff/JS syntax checks and npm run vscode:prepublish.

Validation: npm run vscode:prepublish passed after all fixes (1244 passing tests, 2 skipped, types, lint and production bundle). Scoped independent review findings for duplicate parameter sections, multiline structural codes and false Add success were reproduced and fixed; follow-up review found no remaining significant issue in these repairs. Test Manager hidden/create/fade behavior was also reproduced and verified in headless Chromium. Library DOM fixtures exercise all icons, native process drag messages and guarded Add/remove/deletion routing. Compiler behavior was inspected in the supplied BSL sources; no EPF execution or external scenario edits were performed.
