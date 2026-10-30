# Creation, editor controls, compiler feedback and infobase templates

> **For agentic workers:** Use superpowers:executing-plans to implement each task inline. Preserve unrelated working changes; do not commit or run destructive 1C operations.

**Goal:** Implement the eight user requests of 2026-10-16 in the existing extension.
**Architecture:** Reuse scenario catalog snapshots, shared metadata sidecars, compiler report generation, and the two existing infobase managers. Keep author series distinct from scenario responsible and catalog choices distinct from creation defaults.
**Tech Stack:** TypeScript, VS Code API, HTML/CSS/JavaScript, node:test.
**Spec:** User message in this thread, points 1–8. User confirmed installed 1C `tmplts` templates. Follow-up adds nonworking report links, large-corpus migration/startup/reordering performance, and responsible-vs-author semantics.

## Global constraints
- Editor action buttons default off; no scenario parameter-block action in editor.
- No author/series selection silently skipped; defaults remain personal suggestions.
- Remove inline KOT metadata only after its sidecar is safely persisted; preserve unrelated source and unsaved changes.
- Compiler line links must use actual source coordinates, not guessed feature offsets. Open current failure report automatically, never a stale report after cancellation.
- Reuse confirmations/authentication/busy checks for template imports; no actual database changes during implementation.

## Review focus
- Cancellation before the first wizard step must not wait for scanning or reserve a code.
- Existing and manually issued codes remain checked before file creation.
- Metadata migration must retain unknown keys rather than silently lose data.
- Nested scenario errors must link the nested source, with correct body-to-file offset and encoded paths.
- Both managers share template operations and runtime activity state.

## Tasks
- [x] Creation: show first input before scanning; reuse per-wizard catalog; always show author series with current selection; explain settings.
- [x] Editor: boolean setting + toggle command for action lenses/inlays, default false; suppress scenario parameter block action; refresh dynamically.
- [x] Metadata: atomic sidecar-first cleanup for legacy inline blocks; guard dirty/open files; regression tests.
- [x] Compiler: resolve reported body lines or step text to YAML line links; automatic failed-report preview; expose detailed compatibility issues in report; verify example.
- [x] Infobases: implement shared installed-template discovery/selection and create/update operations; connect both managers.
- [x] Full infobase manager: subscribe to the same runtime tracker and expose running/operation indicators.
- [x] Settings: clarify catalog-vs-default responsibilities; legacy duplicate system-functions setting remains deprecated for migration.
- [x] Follow-up: report-relative Markdown links and old-report upgrade; source snapshot reuse; batch legacy seeding; bounded transaction IO and unique parent checks; no cleanup/unchanged-source reads during reordering; watcher coalescing; remove false scanning status.
- [x] Ownership: responsible remains editable and separate from the author series; do not infer series authors from responsible headers; retain explicitly saved series.
- [x] Validation: targeted regression tests, full npm run vscode:prepublish, documentation, final answers to conceptual questions.

## Evidence and review

- Real Drive compiler JUnit resolves the unknown `LOL` binding in `0083_Work_orders/scen.yaml` to the actual YAML line: 170 before legacy-block removal, 163 in the current file. Final generated `file:` URI matches the current source; output written only to `/private/tmp`.
- Read-only review found nested line ownership and canonical `UIDВложенныйСценарий` issues. Resolver now follows the processing's root-first, indented stack through canonical declarations and refuses detached or unresolved child frames. Canonical regression fixtures cover equal line numbers, unavailable children, duplicate traces, and nested bindings.
- Metadata regressions retain unknown inline data, dirty documents, conflict detection, transactional rollback, and sidecar-first ordering.
- Final synthetic large-corpus benchmark: 1800 definitions, initial migration 1346 ms, clean metadata reload 243 ms, two-item reorder 219 ms / five source reads on local disk. These timings do not predict Windows shared-folder latency.
- No real 1C database operation executed. Template discovery, native launch arguments and both-manager routing verified through focused tests.
- Final `npm run vscode:prepublish` after the relative-link fix passed: type checks, ESLint, 1909 tests (1907 passed, 2 skipped), extension bundle. `git diff --check` passed. A test-host dependency map was updated for the new transaction-idle watcher dependency; its 36 native properties regressions pass.
- User's screenshot exposed that `file:` destinations render as literal Markdown. Installed VS Code's Markdown renderer explicitly blacklists `file:`. Corrected reports and old-report upgrade to the documented `vscode://file/…:line:column` format. Added the same Markdown parser family as a test-only dependency and verified actual anchor rendering for all report links, source line links, Windows, POSIX and UNC paths. No runtime parser dependency added. Live Windows clicks remain unexercised here.
- Read-only rendering of the user's existing Drive report reproduced zero anchors before conversion and all five expected anchors afterward, including `scen.yaml:163:1`. Preview-entry integration test verifies that opening the existing report applies the conversion before showing Markdown preview and remains idempotent.
- Follow-up screenshot showed `vscode://` handed the Windows path to macOS. Replaced ordinary links with paths relative to the report and `#L` coordinates, handled internally by Markdown preview. Historical reports derive their generating directory from managed `compiler-parts` artifact links. Regression tests verify identical Windows/POSIX/UNC relative links and resolve an old Windows report to an actual file in the current checkout. Cross-volume Windows files retain the local URL fallback because no relative path exists between volumes.
- Read-only conversion of the actual Drive report produced five relative links. Resolving each against the report's current macOS path found every target on disk, including `../../tests/RegressionTests/Yaml/Drive/Parent%20scenarios/0083_Work_orders/scen.yaml#L163`. The external Drive report was not modified during verification.
