# Test Manager Status Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent mutually exclusive `All / Built / Running` filtering to Test Manager and integrate it with search, relationship filtering, counts, and title-bar active state.

**Architecture:** A small workspace-state service owns the selected status mode and publishes changes. Extension commands/context keys render native checked menu entries, while pure helpers in `phaseSwitcherProtocol.js` determine status matches and visible counts for the webview.

**Tech Stack:** TypeScript, VS Code commands/context keys/Memento, vanilla webview JavaScript/CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-08-library-files-test-filters-artifact-freshness-design.md`

## Global Constraints

- Modes are exactly `all`, `built`, and `running`; only one is selected.
- Mode persists in workspace state, not global state.
- Built includes current and outdated artifacts with feature or JSON output.
- Running includes internal and externally tracked displayed runs.
- Status, relationship, and text filters compose by intersection.
- Hidden rows retain checkbox state; counts and select-visible operations use visible rows.
- Do not stage or commit pre-existing unrelated dirty-worktree changes; commit steps require an isolated clean baseline.

## Review Focus

- Corrupt persisted values must restore `all`, not hide every test; pinned by Task 1.
- A tracked run without a build artifact must match `running`; pinned by Task 2.
- A stale artifact must still match `built`; pinned by Task 2.
- Empty phases must disappear without losing their expanded state; pinned by Task 4.
- A run-state update must reapply filtering without resetting search/scroll/selection; pinned by Task 4.

---

### Task 1: Add the persistent status-filter state service

**Files:**
- Create: `src/testManagerStatusFilter.ts`
- Create: `test/testManagerStatusFilter.test.ts`

**Interfaces:**
- Produces: `type TestManagerStatusFilter = 'all' | 'built' | 'running'`.
- Produces: `normalizeTestManagerStatusFilter(value: unknown): TestManagerStatusFilter`.
- Produces: `TestManagerStatusFilterService.getMode()`, `setMode(mode)`, `isActive()`, `onDidChangeMode`, and `dispose()`.
- Storage key: `testManager.statusFilter`; dependency is a workspace `Memento`-like `{ get; update }`.

- [ ] **Step 1: Write failing service tests**

Cover default `all`, restoration of each valid mode, invalid-value fallback, no-op repeat set, one change event per real transition, workspace update key/value, and `isActive()` only for `built`/`running`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run compile-tests && node --test out/test/testManagerStatusFilter.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal service**

Freeze event payloads, update the Memento before publishing, and serialize concurrent `setMode` calls so a slower earlier write cannot overwrite a later choice.

- [ ] **Step 4: Re-run the service test**

Run: `npm run compile-tests && node --test out/test/testManagerStatusFilter.test.js`

Expected: PASS.

- [ ] **Step 5: Commit when working from an isolated clean baseline**

```bash
git add src/testManagerStatusFilter.ts test/testManagerStatusFilter.test.ts
git commit -m "feat: persist Test Manager status filter"
```

### Task 2: Define status-filter semantics in the webview protocol

**Files:**
- Modify: `media/phaseSwitcherProtocol.js`
- Modify: `test/phaseSwitcherProtocol.test.ts`

**Interfaces:**
- Produces: `normalizeStatusFilter(value)`.
- Produces: `matchesStatusFilter(runInfo, mode)`.
- Produces: `visibleScenarioAggregate(testInfos, states, runArtifacts, mode, relationshipPredicate, searchPredicate)` returning ordered visible keys plus selected/total counts.

- [ ] **Step 1: Write failing pure-protocol tests**

Assert:

- `built` matches feature-only, JSON-only, combined-JSON, and stale artifacts;
- `running` matches `runStatus: 'running'` regardless of `blocksControls` or artifact presence;
- missing/null artifact matches only `all`;
- invalid modes normalize to `all`;
- aggregate intersection excludes any scenario failing status, relationship, or search and counts only visible enabled keys.

- [ ] **Step 2: Run the protocol test and verify it fails**

Run: `npm run compile-tests && node --test out/test/phaseSwitcherProtocol.test.js`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Implement and export the pure helpers**

Keep helpers DOM-free and deterministic. Do not mutate `runArtifacts`, selection state, or test arrays.

- [ ] **Step 4: Run the protocol test and browser syntax check**

Run: `node --check media/phaseSwitcherProtocol.js && npm run compile-tests && node --test out/test/phaseSwitcherProtocol.test.js`

Expected: PASS.

- [ ] **Step 5: Commit when working from an isolated clean baseline**

```bash
git add media/phaseSwitcherProtocol.js test/phaseSwitcherProtocol.test.ts
git commit -m "feat: define Test Manager status filtering"
```

### Task 3: Add native filter commands, checked menu entries, and active icon state

**Files:**
- Modify: `src/extension.ts:895-1100`
- Modify: `package.json:780-1030,1060-1250`
- Modify: `package.nls.json`
- Modify: `package.nls.ru.json`
- Modify: `test/extensionActivationContract.test.ts`
- Modify: `test/sidebarWorkbenchContract.test.ts`

**Interfaces:**
- Consumes: `TestManagerStatusFilterService` from Task 1.
- Produces commands: `kotTestToolkit.setTestManagerStatusFilterAll`, `...Built`, `...Running`, plus checked-title variants used by menu context.
- Produces contexts: `kotTestToolkit.testManagerStatusFilterAll|Built|Running` and combined `kotTestToolkit.testManagerFiltersActive`.

- [ ] **Step 1: Write failing manifest/activation tests**

Assert all commands are registered, checked titles start with `✓`, both existing Test Manager filter submenus contain one visible entry per mode, mode contexts are mutually exclusive, and filled filter icon selection uses the combined active context rather than relationship state alone.

- [ ] **Step 2: Run targeted tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/extensionActivationContract.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: FAIL because status commands/contexts are absent.

- [ ] **Step 3: Register the service, commands, and contexts**

Instantiate with `context.workspaceState`, register disposal, update all four contexts at activation and on status/relationship change, and keep current relationship toggles in the same dropdown. Rename only the submenu label to localized `Filters`; retain stable submenu ids.

- [ ] **Step 4: Re-run targeted tests**

Run: `npm run compile-tests && node --test out/test/testManagerStatusFilter.test.js out/test/extensionActivationContract.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: PASS.

- [ ] **Step 5: Commit when working from an isolated clean baseline**

```bash
git add src/extension.ts package.json package.nls.json package.nls.ru.json test/extensionActivationContract.test.ts test/sidebarWorkbenchContract.test.ts
git commit -m "feat: add Test Manager status filter menu"
```

### Task 4: Apply the filter in Test Manager without losing UI state

**Files:**
- Modify: `src/phaseSwitcher.ts`
- Modify: `media/phaseSwitcher.js`
- Modify: `media/phaseSwitcher.css`
- Modify: `test/phaseSwitcherWebviewContract.test.ts`
- Modify: `test/sidebarWorkbenchContract.test.ts`

**Interfaces:**
- Consumes: status service `getMode()`/`onDidChangeMode` and protocol helpers from Tasks 1-2.
- Produces: initial setting `statusFilter` and incremental message `{ command: 'updateStatusFilter', statusFilter }`.

- [ ] **Step 1: Write failing host/client contract tests**

Assert initial state includes the restored mode, service changes post the incremental message, and the client centralizes visibility in one function that:

- toggles a status-hidden class on scenario rows;
- hides a phase only when no child survives all filters;
- computes phase/global counts and select-visible keys from the surviving set;
- is called after initial render, search change, relationship change, status change, and `updateRunArtifactsState`;
- does not recreate selection/search/expanded state for status-only changes.

- [ ] **Step 2: Run contract tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/phaseSwitcherWebviewContract.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: FAIL because no status-filter state reaches the webview.

- [ ] **Step 3: Attach the service to `PhaseSwitcherProvider`**

Add a narrow `attachStatusFilterService(...)` dependency, dispose/replace its subscription safely, include mode in `_sendInitialState`, and post incremental updates only while a webview exists.

- [ ] **Step 4: Implement centralized client filtering**

Use the Task 2 helpers to calculate the visible set, then update DOM classes, group visibility, counters, select-visible state, and the existing compiled indicator. Preserve checkbox values, `phaseExpandedState`, active search query, resource expansions, and scroll position.

- [ ] **Step 5: Run targeted checks**

Run: `node --check media/phaseSwitcher.js && npm run compile-tests && node --test out/test/testManagerStatusFilter.test.js out/test/phaseSwitcherProtocol.test.js out/test/phaseSwitcherWebviewContract.test.js out/test/extensionActivationContract.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm run check && git diff --check`

Expected: all checks pass.

- [ ] **Step 7: Commit when working from an isolated clean baseline**

```bash
git add src/phaseSwitcher.ts media/phaseSwitcher.js media/phaseSwitcher.css test/phaseSwitcherWebviewContract.test.ts test/sidebarWorkbenchContract.test.ts
git commit -m "feat: filter Test Manager by build status"
```
