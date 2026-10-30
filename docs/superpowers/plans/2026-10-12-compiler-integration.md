# Compiler integration implementation plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development for each owned task. Independent domains may run in parallel.

**Goal:** Fix all audited profile defects and implement the missing external compiler integrations approved by the user.

**Architecture:** Keep profile strings intact and classify actual path fields explicitly. Keep Drive-specific values in storage but omit them from stock compiler payloads. Extend the existing Test Manager with process descriptors, shared compiled artifacts and source maps; partition builds into isolated output roots and merge them after completion.

**Tech Stack:** Existing TypeScript, Node tests, VS Code webviews and local 1C launch infrastructure; no new dependencies.

**Spec:** User-approved audit `/private/tmp/kot-compiler-audit-2026-10-11-01a1259c.md`; user confirms both defects and missing functions. SplitFeatureFiles exists only in the Drive compiler.

## Global constraints

- Preserve all existing uncommitted work; no commits or external compiler changes.
- Never read or print actual profile secrets for tests; use synthetic fixtures.
- Stock builds must not receive SplitFeatureFiles. Hiding Drive controls must not delete profile values.
- Separate each worker's FeatureFolder, compile/result/log/error paths; compiler clears its output root.
- Retain custom launch templates and feature-only compilation.

## Review focus

- Connection strings, URL/version/date/branch values and Windows paths survive storage and JSON serialization.
- Importing aliases and arrays preserves compiler precedence and libraries across compiled/standalone launch.
- Shared artifacts associate every original UID while launches execute a shared feature once.
- Malformed or absent .str/reports do not prevent build or navigation to feature fallback.
- Cancellation/failure in any worker prevents a successful aggregate result and cleans up processes.

## Task 1: Profile backend and compiler values

Files: src/yamlParametersManager.ts, src/yamlParameterDefaults.ts, new focused value-policy module, profile tests.

- [x] Add and run failing synthetic tests for string corruption, arrays, aliases, empty ModelDBSettings, TestFolder priority, Drive storage/payload separation and compile-only validation.
- [x] Implement explicit path/list value rules, separate folder/connection roles and lossless profile normalization.
- [x] Remove redundant library default; fix key descriptions and emit-time Drive gating.
- [x] Run focused tests and report public helper interfaces to parent.

## Task 2: Process model and creation

Files: focused process modules, src/scenarioDescriptor.ts, src/types.ts, src/workspaceScanner.ts, process tests. Parent owns src/phaseSwitcher.ts and all media files.

- [x] Add and run failing tests using hand-derived compiler-compatible process/settings YAML fixtures.
- [x] Recognize process descriptors and their scenario steps; discover named descriptors beyond scen.yaml.
- [x] Add creation/editing commands using existing VS Code interaction patterns, without writing to external test corpora.
- [x] Provide parent command-registration and Test Manager integration details; run focused tests.

## Task 3: Compiled artifact maps

Files: new compilerArtifacts.ts and tests only; parent integrates phaseSwitcher and webview.

- [x] Add and run failing tests for actual .str JSON fields, source line conversion, all grouped original UIDs, malformed/absent maps and reports.
- [x] Implement source-map parsing and lookup, artifact membership and compile report parsing in pure functions.
- [x] Return interfaces and fixture examples; run focused tests.

## Task 4: Runtime, settings UI and Test Manager integration

Files: src/phaseSwitcher.ts, media/yamlParameters.js, media/phaseSwitcher.*, extension/command integration, focused runtime/UI tests, documentation and localization.

- [x] Add and run failing tests for managed runtime paths, worker partitions/merge/cancellation, compile-only runs, shared artifact launch/status, UI profile preservation and reset.
- [x] Integrate backend policy with lossless UI and managed build protocol.
- [x] Run requested partitions in isolated roots, merge feature/json/str/report outputs and show aggregate report.
- [x] Integrate process UI, source navigation and all shared artifact members with deduplicated launches.
- [x] Update English/Russian descriptions and usage documentation.

## Task 5: Verification and review

- [x] Run npm test and npm run vscode:prepublish; report any failure by name.
- [x] Review the changes independently against the audit and user correction.
- [x] Fix review findings and rerun only checks affected by those changes.
- [x] Report completed functions and the material limitation that EPF execution was not exercised if no local 1C runtime is used.


## Implementation and verification ledger

- Profile policy, real webview state tests, standalone launch defaults and aliases completed.
- Process descriptors, ordered step editing, separate-root scanning and disabled-settings isolation completed.
- Source maps enrich the existing feature/nested-source navigation; grouped features bind every UID and share execution/stale states.
- Build workers use isolated managed paths, two-process concurrency, abort pending launches after failure, merge namespaces and inventories, and aggregate reports.
- Independent review found process filter OR semantics, model database path duplication, aggregate JUnit deletion during merge, stale grouped members and Windows path-case overlap. Each finding was corrected and covered by targeted fixtures.
- Final `npm run vscode:prepublish` passed: TypeScript, ESLint, 1140 passed tests, 2 skipped, and minified extension bundle. `npm test` also passed independently before the final additional race and discovery fixtures.
- No external compiler or Drive corpus files were edited. No EPF execution in 1C was performed; compatibility is checked against the supplied BSL and synthetic fixtures.
- Existing per-scenario single-artifact selection across multiple test-setting variants is outside this audit's shared-feature integration and remains unchanged.
