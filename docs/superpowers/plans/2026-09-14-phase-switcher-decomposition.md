# PhaseSwitcher Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each extraction and superpowers:verification-before-completion before claiming completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract two pure, testable domains from `phaseSwitcher.ts` with no user-visible behavior change.

**Architecture:** `PhaseSwitcherProvider` keeps VS Code orchestration and I/O. `vanessaRunLog.ts` owns log interpretation; `vanessaLaunchJson.ts` owns plain JSON traversal and transformation. Characterization tests define the compatibility boundary before old methods are removed.

**Tech Stack:** TypeScript 5.9, Node.js `node:test`, VS Code Extension API, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-14-phase-switcher-decomposition-design.md`

## Global Constraints

- Do not modify AI code, `steps.htm`, `stepsFetcher.ts`, completion providers, or IntelliSense behavior.
- Do not change command IDs, settings schema, user messages, process arguments, or persistence formats.
- Pure extracted modules must not import `vscode`, access files, or read process environment state.
- Each extraction must leave the full project check green before the next begins.

---

### Task 1: Characterize Vanessa run-log parsing

**Files:**
- Create: `test/vanessaRunLog.test.ts`
- Create: `src/vanessaRunLog.ts`
- Modify: `src/phaseSwitcher.ts`

**Interfaces:**
- Extract the existing feature-path, feature-line, scenario-name, failed-step, failure-summary, and last-step-location logic as pure functions accepting strings and explicit identity/options.
- Return structured values; keep localized message selection and VS Code objects in `phaseSwitcher.ts`.

- [x] Inventory the private log helpers and their call graph with `rg`; record the exact set being moved in the test descriptions.
- [x] Write characterization tests from current accepted inputs: Russian/English markers, Windows/Unix file paths, missing scenario name, failed step with details, summary-only failure, and last location.
- [x] Confirm tests fail because the pure module does not yet expose the behavior.
- [x] Implement the pure module by moving behavior without simplifying its matching rules.
- [x] Replace provider calls with the module functions and delete the moved private methods.
- [x] Confirm `src/vanessaRunLog.ts` has no `vscode`, filesystem, or process imports.
- [x] Run the focused tests and `npm run check`.
- [x] Commit with `refactor: extract Vanessa run log parser`.

Moved helper set: feature-path, feature-line and scenario-name extraction; scenario-name comparison and marker filtering; failed-summary recognition; failed-block collection and formatting; failed-step detail extraction; and last-step location extraction. The provider retains only file-tail reading and VS Code state updates.

### Task 2: Characterize launch JSON pointer and alias logic

**Files:**
- Create: `test/vanessaLaunchJson.test.ts`
- Create: `src/vanessaLaunchJson.ts`
- Modify: `src/phaseSwitcher.ts`

**Interfaces:**
- Export a JSON-compatible value type.
- Export pure get/set JSON-pointer functions with RFC 6901 token unescaping compatible with current behavior.
- Export alias resolution and additional-parameter application functions used by the existing launch preparation flow.
- Return a cloned transformed value rather than mutating caller-owned configuration.

- [x] Inventory the launch JSON helpers and distinguish pure transformations from prompts, workspace paths, and file I/O.
- [x] Write characterization tests for root/nested pointers, `~0`/`~1`, missing paths, arrays, supported aliases, unknown aliases, additional parameters, and input immutability.
- [x] Confirm the new tests fail before implementation.
- [x] Move only the pure traversal and transformation logic to `vanessaLaunchJson.ts`.
- [x] Keep workspace-relative path resolution in the provider unless it can be expressed with an explicit base-path argument and no environment reads.
- [x] Switch provider call sites and remove the obsolete private methods.
- [x] Confirm the new module has no `vscode`, filesystem, or process imports.
- [x] Run the focused tests and `npm run check`.
- [x] Commit with `refactor: extract Vanessa launch JSON transforms`.

Moved helper set: immutable JSON-pointer get/set with RFC 6901 decoding; dot/bracket pointer parsing; alias lookup and path resolution; typed value conversion; additional-parameter and global-variable transformations. Workspace path resolution, prompts, file reads/writes, infobase preparation and runtime-path selection remain in the provider.

### Task 3: Boundary and regression verification

**Files:**
- Modify: `docs/superpowers/plans/2026-09-14-phase-switcher-decomposition.md`

**Interfaces:**
- Consumes: both extracted modules and unchanged `PhaseSwitcherProvider` public behavior.
- Produces: recorded size, dependency, and verification evidence.

- [ ] Compare `phaseSwitcher.ts` line count before/after and verify both extracted implementations exist only in their new modules.
- [ ] Run `rg -n "from './vanessa(RunLog|LaunchJson)'" src/phaseSwitcher.ts` and verify the provider is the dependency owner.
- [ ] Run `rg -n "vscode|node:fs|child_process|process\." src/vanessaRunLog.ts src/vanessaLaunchJson.ts` and inspect any match; expected result is none.
- [ ] Run `git diff --check`, `npm run check`, and `npm run vscode:prepublish`.
- [ ] Verify no excluded IntelliSense, steps, or AI files changed relative to the pre-decomposition commit.
- [ ] Record verification evidence in this plan and commit with `test: verify phase switcher extraction`.
