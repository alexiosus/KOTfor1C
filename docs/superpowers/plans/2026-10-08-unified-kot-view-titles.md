# Unified KOT View Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the common container, detached views, and full Library panel one non-duplicated `KOT for 1C` title system.

**Architecture:** Keep VS Code's localized view names, but make every generated/dedicated container use the common brand title so VS Code composes `KOT for 1C: <view>`. Give the editor-hosted Library panel the same explicitly localized composite title.

**Tech Stack:** VS Code extension manifest, VS Code localization bundles, TypeScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-08-library-files-test-filters-artifact-freshness-design.md`

## Global Constraints

- English branding is exactly `KOT for 1C`; `for` is never capitalized.
- Detached views must not render duplicated forms such as `KOT Library: Library`.
- Russian view names remain localized after the common brand prefix.
- Preserve the existing activity-bar icons and view ids.
- Do not alter unrelated dirty-worktree changes.
- Run commit steps only from an isolated clean baseline; otherwise leave the verified working-tree changes uncommitted.

## Review Focus

- A moved Test Manager view must compose the brand and `Test Manager`, not repeat either label; pinned by Task 1's manifest assertions.
- The dedicated Library activity-bar container must use the same brand as the common container; pinned by Task 1.
- Russian names must not regress to English; pinned by Task 1's RU assertions.
- Reopening an existing full Library panel must reset the same title used on creation; pinned by Task 2.
- No stale `KOT Library`, `KOT Test Manager`, or `KOT Infobases` contextual title may remain; pinned by Task 2's repository contract check.

---

### Task 1: Normalize manifest view and container titles

**Files:**
- Modify: `package.json:1580-1750`
- Modify: `package.nls.json:194-199`
- Modify: `package.nls.ru.json:194-199`
- Modify: `test/sidebarWorkbenchContract.test.ts`

**Interfaces:**
- Consumes: VS Code `viewsContainers.activitybar`, view `name`, and view `contextualTitle` contributions.
- Produces: `%ext.displayName%` as the common container/contextual brand and localized leaf view names.

- [ ] **Step 1: Write the failing manifest contract test**

Add a test named `all KOT view containers compose one common non-duplicated title` that parses `package.json`, `package.nls.json`, and `package.nls.ru.json` and asserts:

- both activity-bar container titles are `%ext.displayName%`;
- all three view `contextualTitle` values are `%ext.displayName%`;
- English `ext.displayName` is `KOT for 1C` and the leaf names are `Test Manager`, `Library`, `Infobases`;
- Russian leaf names remain `Менеджер тестов`, `Библиотека`, `Базы`;
- no contextual-title localization value matches `/^KOT (?:Library|Infobases|Test Manager)$/u`.

- [ ] **Step 2: Run the targeted test and verify it fails**

Run: `npm run compile-tests && node --test out/test/sidebarWorkbenchContract.test.js`

Expected: FAIL because the Library container and contextual titles still use per-view KOT labels.

- [ ] **Step 3: Update the manifest and NLS values**

Set the Library container title and all view contextual titles to `%ext.displayName%`. Remove or repurpose obsolete contextual-title strings so no duplicated branded label remains; retain localized `view.*.name` leaf strings.

- [ ] **Step 4: Re-run the targeted test**

Run: `npm run compile-tests && node --test out/test/sidebarWorkbenchContract.test.js`

Expected: PASS.

- [ ] **Step 5: Commit when working from an isolated clean baseline**

```bash
git add package.json package.nls.json package.nls.ru.json test/sidebarWorkbenchContract.test.ts
git commit -m "fix: unify KOT view titles"
```

### Task 2: Align the full Library panel title

**Files:**
- Modify: `src/stepLibraryPanel.ts:145-165,650-710`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`
- Modify: `test/stepLibraryPanel.test.ts`
- Modify: `test/stepLibraryPanelContract.test.ts`

**Interfaces:**
- Consumes: translator key `KOT for 1C: Library`.
- Produces: identical panel title on create, reveal, and HTML title rendering.

- [ ] **Step 1: Write failing panel-title tests**

Add assertions that creating and reopening `StepLibraryPanel` set `panel.title` to `KOT for 1C: Library`, and a contract assertion that `src/stepLibraryPanel.ts` no longer calls `t('KOT Library')`.

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/stepLibraryPanel.test.js out/test/stepLibraryPanelContract.test.js`

Expected: FAIL with the current `KOT Library` title.

- [ ] **Step 3: Implement the localized composite title**

Use `t('KOT for 1C: Library')` consistently for panel creation, existing-panel reveal, and the webview title label. Add English identity and Russian `KOT for 1C: Библиотека` bundle values.

- [ ] **Step 4: Run title tests and static checks**

Run: `npm run compile-tests && node --test out/test/sidebarWorkbenchContract.test.js out/test/stepLibraryPanel.test.js out/test/stepLibraryPanelContract.test.js`

Expected: PASS.

Run: `npm run check:types && git diff --check`

Expected: both commands exit 0.

- [ ] **Step 5: Commit when working from an isolated clean baseline**

```bash
git add src/stepLibraryPanel.ts l10n/bundle.l10n.json l10n/bundle.l10n.ru.json test/stepLibraryPanel.test.ts test/stepLibraryPanelContract.test.ts
git commit -m "fix: align full Library title"
```
