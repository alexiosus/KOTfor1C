# Author series test numbering implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. The user approved implementation of the linked proposal; proceed in the current checkout and preserve its existing changes. Do not commit or modify the external Drive corpus.

**Goal:** Suggest consecutive nine-character test codes within each tester's shared six-character series.

**Architecture:** A filesystem store owns `.kot/test-numbering.yml`, validates series and records the highest issued suffix. A VS Code service selects the local default series, provides editable code suggestions, and claims a code immediately before creation. The three YAML creation commands use that service; existing sources and linked settings retain their identities.

**Tech Stack:** TypeScript, existing YAML document library, Node filesystem, VS Code QuickPick/InputBox, node:test.

**Spec:** [approved proposal](../specs/2026-10-15-test-numbering-proposal.md).

## Global constraints

- Prefix is six digits, suffix is three digits; keep leading zeroes.
- No renumbering of existing tests, no assignment of real people from examples.
- Shared series and high-water marks belong in Git; selected series belongs in workspaceState.
- Names, current responsible, groups and identity UIDs stay independent from codes.
- No new dependencies, no external writes, no real 1C launch.

## Review focus

- Deleted latest test must not allow its number to be reused.
- Concurrent commands/windows must not issue the same code in different parent folders.
- Cancellation before creation must not consume a suggested number.
- Invalid, dirty, symlinked or externally changed catalog must not be overwritten.
- Existing manual workflows/custom templates and settings filenames must remain usable.

## Task 1: Shared store

- [x] Add `test/testNumberingStore.test.ts`: nine-digit codes, existing maximum, high-water mark after deletion, concurrent claims, duplicate code across kinds, exhaustion, malformed/duplicate YAML, stale writes and symlinks.
- [x] Observe failing tests, then implement `src/testNumberingStore.ts`: `TestNumberingStore.read()`, `addSeries(prefix, author, codes)`, `suggest(prefix, codes)`, `claim(code, loadCodes)`. Preserve comments through YAML AST; serialize writers and use an exclusive lock while claiming/writing. Empty read does not create files.
- [x] Run targeted store tests.

## Task 2: Selection and creation

- [x] Add behavior tests for setup/manual mode, remembered series, editable suggestions, cancellation, main/nested/process files and fresh duplicate checks.
- [x] Implement `src/testNumbering.ts`: first-use series/manual choice, shared-series creation with author selection, a manage command for switching/adding/opening the catalog, code suggestion and deferred claim.
- [x] Integrate all three creators. Main gets a separate code field and code-named folder/settings file; add `Code_Placeholder` to the stock settings template. Claim only after remaining wizard prompts; refuse existing folders with exclusive creation. A failed creation may leave a consumed number; do not roll the shared counter back.
- [x] Register/localize `kotTestToolkit.manageTestNumbering`. Keep manual creation available for projects without configured series. Test through host harnesses using real temporary files.
- [x] Run targeted store/UI/creator tests and types/lint.

## Task 3: Documentation and verification

- [x] Document first-use setup, command, shared YAML schema, manual mode, exhaustion, counter gaps on failure and merge collisions.
- [x] Mark the proposal implemented with exact supported scope.
- [x] Run `npm run vscode:prepublish`; inspect the complete result.
- [x] Obtain one focused independent review and fix material findings with regression tests.

## Execution notes

- Native implementation in the existing dirty checkout keeps the previously authorized changes together; no commit or worktree reset.
- Manual entry remains available. With a configured series, a lower or previously issued number in that series is rejected even if its file was deleted.
- First creation without a catalog offers setup or manual entry; the manager also exposes those choices later.
- Whole-branch history is unrelated to this feature review; review the files in this plan and their immediate consumers.

- User clarification: retain short/full header modes; Responsible is offered in both.
- Review: external-root ownership corrected by choosing the destination before code selection; covered by the external configured root creator regression.
- Review: CI scalar decoding and manual creation race fixed with failing regressions followed by green runs. The claim lock now includes source publication.
- Additional regression: changing responsible in a custom template clears an unrelated SPPR user UID.
- Verification: `npm run vscode:prepublish` passed: 1814 total, 1812 passed, 2 skipped, 0 failed. `git diff --check` passed. No 1C or live Extension Host was launched.
