# Gherkin Column Deletion Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Work in the current checkout and preserve unrelated edits. Do not commit unless requested.

**Goal:** Delete a complete Gherkin column by deleting its header cell, without the formatter restoring removed cells.

**Architecture:** A pure edit planner recognizes structural deletions using the previous text. A VS Code listener applies data-row edits in the same undo group and skips undo, redo, stale snapshots and non-script YAML.

**Tech Stack:** TypeScript, VS Code editor API, node:test.

**Spec:** [Approved behavior](../specs/2026-10-28-gherkin-column-deletion-design.md).

## Global Constraints

- YAML, native SPPR fragments and standalone feature files have the same table behavior.
- No external dependency or extra configuration.
- Preserve existing unrelated working tree changes.

## Review Focus

- First/middle/last and duplicate or empty header cells: delete only an unambiguous complete cell.
- Escaped pipes and LF/CRLF: preserve values and line endings.
- Comments, docstrings and YAML metadata: no automatic changes.
- Undo/redo, another editor, multiple selections and concurrent versions: no repeated or stale edits.
- Unequal or unfinished rows: leave them untouched during alignment.

## Task 1: Pure table edits

- [x] Add regression tests proving alignment currently recreates cells; observe failures.
- [x] Add failing planner tests for structural deletion and non-deletion cases.
- [x] Modify `src/gherkinTableUtils.ts`: skip unfinished/ragged blocks and export `planGherkinHeaderColumnDeletion(text, deletion)` returning old-text deletion ranges.
- [x] Run the focused tests and confirm they pass.

## Task 2: Editor integration

- [x] Add `src/gherkinTableEditing.ts` and its tests: snapshot lifetime, scope, undo/redo, guards, same-undo edit options.
- [x] Register the listener from `src/extension.ts`.
- [x] Explain header deletion and incomplete-table behavior in `documentation/blocks/editor-and-intellisense.md`.
- [x] Run `npm run check`, `npm run compile`, `npm run docs:check` and scoped `git diff --check`.

## Verification

- Focused tests: 22 passed, 0 failed. Regression failures were observed before implementation.
- `npm run check`: types, lint, localization and 2661 passing tests; 2 skipped, 0 failed.
- `npm run compile`, `npm run docs:check` and scoped whitespace checks passed.
- No live Development Host verification or commit in this task.
