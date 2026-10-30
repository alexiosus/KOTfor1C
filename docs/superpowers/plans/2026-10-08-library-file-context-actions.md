# Library File Context Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add matching attachment-file context menus and safe trash deletion to compact and full Library surfaces.

**Architecture:** Extend the existing shared scenario-files protocol and `ScenarioFilesService` once, then keep both Library providers as thin adapters. A shared browser-protocol function defines menu action order while each webview renders its local VS Code-styled menu.

**Tech Stack:** TypeScript, VS Code webview API, `workspace.fs`, vanilla browser JavaScript/CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-08-library-files-test-filters-artifact-freshness-design.md`

## Global Constraints

- Delete only regular attachment files; never delete compiled `.feature` rows or directories.
- Every delete requires modal confirmation and uses the OS trash.
- Reuse current relative-path, realpath, and symlink containment protections.
- Keep drag/drop, row-click open, reveal, and editor insertion behavior unchanged.
- Compact and full Library menus use the same action order and localized labels.
- Do not stage or commit pre-existing unrelated dirty-worktree changes.

## Review Focus

- An empty or traversal path must never reach confirmation or deletion; pinned by Task 1 protocol/service tests.
- A symlink leaf or symlink escape must not delete its target; pinned by Task 1.
- Cancelled confirmation must be silent and retain the file; pinned by Task 1.
- Context-menu clicks must not also open/toggle the row; pinned by Task 3 browser contract tests.
- The details-column file rows must receive the same menu as results/sidebar rows; pinned by Task 3 static contracts.

---

### Task 1: Add typed and filesystem-safe delete support

**Files:**
- Modify: `src/scenarioFilesWebviewProtocol.ts`
- Modify: `src/scenarioFilesService.ts`
- Modify: `test/scenarioFilesWebviewProtocol.test.ts`
- Modify: `test/scenarioFilesService.test.ts`

**Interfaces:**
- Produces: `ScenarioFilesMessage` variant `{ command: 'deleteScenarioFile'; itemId: string; relativePath: string }`.
- Produces: `ScenarioFilesHost.confirmDelete(relativePath: string): PromiseLike<boolean>` and `ScenarioFilesHost.deleteFile(uri: ScenarioFilesUri): PromiseLike<void>`.
- Produces: `ScenarioFilesService.deleteFile(item: StepLibraryItem, relativePath: string): Promise<'deleted' | 'cancelled'>`.

- [ ] **Step 1: Write failing protocol tests**

Assert that `parseScenarioFilesMessage` normalizes `Folder\\Input.xlsx`, rejects `''`, absolute paths, `..`, oversized ids/paths, and does not accept directory/root deletion messages.

- [ ] **Step 2: Write failing service tests**

Extend `RecordingHost` with confirmation and trash-delete recording. Cover: confirmed regular file deletion, cancellation, missing file, directory rejection, symlink-leaf rejection, symlink-directory escape rejection, and compiled-main attachment deletion within its explicit `Файлы` root.

- [ ] **Step 3: Run the focused tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/scenarioFilesWebviewProtocol.test.js out/test/scenarioFilesService.test.js`

Expected: FAIL because the message and service method do not exist.

- [ ] **Step 4: Implement the protocol variant and service method**

Parse delete messages through `cleanId` and `cleanPath(..., false)`. In `deleteFile`, resolve the same resource root as list/open, require a safe existing regular non-symlink leaf, await confirmation, and invoke `host.deleteFile`; return `cancelled` only for declined confirmation and throw validation/filesystem errors.

- [ ] **Step 5: Re-run focused tests**

Run: `npm run compile-tests && node --test out/test/scenarioFilesWebviewProtocol.test.js out/test/scenarioFilesService.test.js`

Expected: PASS.

- [ ] **Step 6: Commit when working from an isolated clean baseline**

```bash
git add src/scenarioFilesWebviewProtocol.ts src/scenarioFilesService.ts test/scenarioFilesWebviewProtocol.test.ts test/scenarioFilesService.test.ts
git commit -m "feat: safely delete Library attachments"
```

### Task 2: Wire deletion through both Library providers

**Files:**
- Modify: `src/extension.ts:1120-1175`
- Modify: `src/stepLibraryPanel.ts`
- Modify: `src/stepLibrarySidebarProvider.ts`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`
- Modify: `test/stepLibraryPanel.test.ts`
- Modify: `test/stepLibrarySidebarProvider.test.ts`

**Interfaces:**
- Consumes: `ScenarioFilesService.deleteFile(...)` from Task 1.
- Produces: webview result `{ command: 'scenarioFileActionResult', action: 'delete', itemId, relativePath, succeeded, cancelled? }`.

- [ ] **Step 1: Write failing provider tests**

For each provider, send `deleteScenarioFile` and assert: the correct snapshot item is resolved, the service receives its normalized relative path, success posts the delete result, cancellation posts `cancelled: true`, and thrown errors use the existing `scenarioFileTransferFailed`/localized failure path without reporting success.

- [ ] **Step 2: Run the provider tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/stepLibraryPanel.test.js out/test/stepLibrarySidebarProvider.test.js`

Expected: FAIL because providers do not handle deletion.

- [ ] **Step 3: Add VS Code host adapters and provider handlers**

In `extension.ts`, implement modal confirmation with localized `Delete`/cancel semantics and `workspace.fs.delete(uri, { recursive: false, useTrash: true })`. Add `deleteFile` to both provider service picks and message switches. Do not add it to Test Manager UI.

- [ ] **Step 4: Re-run provider tests**

Run: `npm run compile-tests && node --test out/test/stepLibraryPanel.test.js out/test/stepLibrarySidebarProvider.test.js`

Expected: PASS.

- [ ] **Step 5: Commit when working from an isolated clean baseline**

```bash
git add src/extension.ts src/stepLibraryPanel.ts src/stepLibrarySidebarProvider.ts l10n/bundle.l10n.json l10n/bundle.l10n.ru.json test/stepLibraryPanel.test.ts test/stepLibrarySidebarProvider.test.ts
git commit -m "feat: wire Library attachment deletion"
```

### Task 3: Add identical context menus to compact and full Library

**Files:**
- Modify: `media/scenarioFilesProtocol.js`
- Modify: `media/stepLibrarySidebar.js`
- Modify: `media/stepLibrarySidebar.css`
- Modify: `media/stepLibrary.js`
- Modify: `media/stepLibrary.css`
- Modify: `src/stepLibrarySidebarProvider.ts`
- Modify: `src/stepLibraryPanel.ts`
- Modify: `test/scenarioFilesWebviewProtocol.test.ts`
- Modify: `test/stepLibraryPanelContract.test.ts`
- Modify: `test/sidebarWorkbenchContract.test.ts`

**Interfaces:**
- Produces: `KotScenarioFilesProtocol.scenarioResourceContextActions(kind, labels)` returning ordered descriptors with ids `open`, `reveal`, separator, `delete` for `file`, reveal-only for directory/group, and no delete for `feature`.
- Consumes: `deleteScenarioFile` and `scenarioFileActionResult` from Tasks 1-2.

- [ ] **Step 1: Write failing browser-protocol tests**

Assert exact action ids/order for `file`, `directory`, `attachments`, and `feature`; assert only `file` receives `delete`.

- [ ] **Step 2: Write failing webview contract tests**

Assert both clients register `contextmenu` on every attachment file-row renderer, stop propagation/default handling, call the shared descriptor function, post `deleteScenarioFile`, close menus on Escape/outside click/message refresh, and clear the owning resource cache after successful deletion. Assert the full Library details renderer is included.

- [ ] **Step 3: Run targeted tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/scenarioFilesWebviewProtocol.test.js out/test/stepLibraryPanelContract.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: FAIL because no Library resource context menu exists.

- [ ] **Step 4: Implement the shared descriptors and compact menu**

Add a fixed-position, keyboard-dismissible menu using VS Code menu foreground/background/border/selection tokens. Map descriptor ids to existing open/reveal messages and the new delete message; preserve row click behavior by stopping the context-menu event.

- [ ] **Step 5: Implement the full Library menu in both resource renderers**

Use the same descriptors and command mapping in `renderScenarioResourceNode` and `renderDetailsResourceNode`. On successful deletion, invalidate `resourceChildrenByParent` entries for the item and rerender without changing selection or scroll.

- [ ] **Step 6: Run browser syntax and targeted tests**

Run: `node --check media/scenarioFilesProtocol.js && node --check media/stepLibrarySidebar.js && node --check media/stepLibrary.js`

Expected: all exit 0.

Run: `npm run compile-tests && node --test out/test/scenarioFilesWebviewProtocol.test.js out/test/scenarioFilesService.test.js out/test/stepLibraryPanel.test.js out/test/stepLibrarySidebarProvider.test.js out/test/stepLibraryPanelContract.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: PASS.

- [ ] **Step 7: Run full checks**

Run: `npm run check && git diff --check`

Expected: all checks pass with no whitespace errors.

- [ ] **Step 8: Commit when working from an isolated clean baseline**

```bash
git add media/scenarioFilesProtocol.js media/stepLibrarySidebar.js media/stepLibrarySidebar.css media/stepLibrary.js media/stepLibrary.css src/stepLibrarySidebarProvider.ts src/stepLibraryPanel.ts test/scenarioFilesWebviewProtocol.test.ts test/stepLibraryPanelContract.test.ts test/sidebarWorkbenchContract.test.ts
git commit -m "feat: add Library file context menus"
```
