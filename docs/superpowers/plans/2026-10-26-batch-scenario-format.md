# Batch SPPR Format Conversion Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. Preserve unrelated workspace changes; no task commit was requested.

**Goal:** Add selected YAML → feature + meta conversion to Maintenance.

**Architecture:** A small runner reuses `convertSpprScenarioFiles`; a command owns native selection, progress, a single refresh and a report. Existing individual conversion stays unchanged.

**Tech Stack:** TypeScript, VS Code API, existing SPPR converter, Node test runner.

**Spec:** ../specs/2026-10-26-batch-scenario-format-design.md

- [x] Test candidate filtering, partial success, dirty source/sidecar protection, destination conflicts and cancellation using real temporary files.
- [x] Implement the runner and command in `src/spprScenarioBatchConversion.ts`; register it in `extension.ts` and Maintenance in `package.json`.
- [x] Verify one catalog refresh with all changed source URIs, no per-file notification flood, and preservation of unrelated scenario data.
- [x] Add Russian/English labels, update the source-formats guide, command reference and changelog.
- [x] Run focused tests, `npm run check`, `npm run compile`, `npm run docs:reference` and `npm run docs:check`.

## Execution record

- RED: five new tests failed because the batch module did not exist. GREEN: all seven focused tests pass, including active-editor replacement and duplicate-command recovery after picker cancellation.
- `npm run check`: 2,617 tests, 2,615 passed, two skipped, zero failures; types, lint and localization passed.
- `npm run compile`: passed. Documentation reference regenerated for 176 commands; documentation check passed (64 Markdown files, 633 links/images).
- Ruling: preserve the shared checkout and existing unfinished changes; implement this small extension of the current converter in place without a commit. No live project files were converted during verification; tests use temporary directories.
