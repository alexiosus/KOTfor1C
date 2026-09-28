# KOT Sidebar Workbench Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing KOT Activity Bar container into a native three-section workbench with a compact Test Manager, unified Step Library, and Infobases view while preserving build semantics, sharing cached catalogs, and making scenario relationships visible without horizontal overflow.

**Architecture:** Keep `PhaseSwitcherProvider` as the owner of Test Manager and the published `ScenarioCatalog`. Add a pure identity-based `ScenarioRelationshipIndex` plus a lightweight shared relationship service. Add shared snapshot/action services so the compact Step Library and full panel reuse one prepared model, and add a lazy managed-infobase service so the compact and full managers reuse one normalized scan. Register three independent `WebviewViewProvider`s under the existing Activity Bar container; expensive resolver, catalog, and infobase work starts only when a visible view asks for it.

**Tech Stack:** TypeScript 5.8, Node.js 20 APIs, VS Code 1.98 Webview View APIs, vanilla JavaScript/CSS using Codicons and `--vscode-*` theme tokens, esbuild, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-28-sidebar-workbench-redesign-design.md`

## Global Constraints

- Preserve Test Manager build-selection meaning: only main scenarios have build checkboxes; nested scenarios never become build rows.
- Keep the current `kotTestToolkit.phaseSwitcherView` ID and all existing build/run/create commands working.
- Reuse `kotTestToolkit.phaseSwitcher.highlightAffectedMainScenarios`; the toolbar toggle updates it with `ConfigurationTarget.Workspace` and defaults to `true`.
- Use scenario URI/runtime keys for graph identity. Names may be duplicated and must never become runtime identity.
- For an ambiguous called name, connect the caller to every exact-name catalog candidate in stable URI order. This is conservative, deterministic, and avoids silently hiding a valid relationship.
- Relationship traversal must tolerate cycles and missing callees and must not read files, invoke the resolver, or trigger a scan.
- The Step Library sidebar consumes a shared prepared `StepLibrarySnapshot`; it never invokes a Vanessa/project scan independently.
- The Infobases sidebar and full manager consume one lazy managed-infobase service with an in-flight/cached collection; activation itself must not discover launcher entries or inspect base directories.
- Build webview HTML with a restrictive CSP and local scripts/styles. New compact views render scenario, step, path, and error text via DOM `textContent`; existing Test Manager templates must keep explicit escaping, and new dynamic relationship text uses `textContent`.
- Validate every inbound webview command and stable ID in the Extension Host. Webviews cannot submit executable paths or command-line arguments.
- `.dt` and `.cf` imports, including configuration source-directory load, require a modal confirmation naming the exact source and target before any 1C process starts.
- Sidebar trees must use vertical scrolling only at 320, 360, and 430 px widths. Long labels use `min-width: 0`, ellipsis, and a fixed decoration/action gutter.
- Use current-file blue and relationship purple as distinct theme-aware states. Direction remains available through icon and accessible text, not color alone.
- Do not redesign the full Step Library, Infobase Manager, YAML Parameters, Form Explorer, or AI flows in this increment.
- Keep all commits authored as `Alexey Eremeev <48015759+alexiosus@users.noreply.github.com>`.

## Review Focus

- Build checkboxes, Favorites, search, selected counts, and build payloads remain independent of relationship state; pinned by Tasks 3 and 4.
- An active nested scenario highlights all transitive owning main scenarios/phases and shows incoming/outgoing nested relationships without name-key collisions; pinned by Tasks 1–3 and 7.
- Opening either Step Library surface reuses one in-flight/cached definition snapshot; expanding and searching the compact view performs no workspace I/O; pinned by Tasks 5–7.
- RU/EN built-ins remain one family in the compact tree and category branches are not duplicated; pinned by Tasks 6 and 7.
- Opening either Infobase surface reuses one in-flight/cached normalized collection, while active-profile changes refresh only infobase presentation; pinned by Tasks 8 and 10.
- Destructive imports cannot start without a modal target/source confirmation; pinned by Task 9.
- View registration remains cheap at activation and hidden views do not rebuild DOM/model projections; pinned by Tasks 7, 10, and 11.
- Narrow-width layout has no horizontal tree scrolling, actions remain keyboard reachable, and current/related/modified states are visually and accessibly distinct; pinned by Tasks 4, 7, 10, and 11.

## File Structure

### New shared runtime modules

- `src/scenarioRelationshipIndex.ts` — pure stable-identity graph and deterministic projections.
- `src/scenarioRelationshipService.ts` — catalog/active-editor/configuration coordination and shared event.
- `src/stepLibrarySnapshotService.ts` — one cached/in-flight prepared Step Library snapshot.
- `src/stepLibraryActions.ts` — shared insertion target, insert, copy, and navigation actions.
- `src/managedInfobaseService.ts` — lazy cached/in-flight managed-infobase collection shared by both surfaces.
- `src/infobaseDestructiveConfirmation.ts` — typed modal confirmation for destructive imports.

### New compact view modules

- `src/stepLibrarySidebarModel.ts`
- `src/stepLibrarySidebarProvider.ts`
- `src/infobaseSidebarModel.ts`
- `src/infobaseSidebarProvider.ts`

### New webview assets

- `media/kotSidebar.css` — shared narrow-view primitives and semantic states.
- `media/stepLibrarySidebarProtocol.js`
- `media/stepLibrarySidebar.js`
- `media/stepLibrarySidebar.css`
- `media/infobaseSidebarProtocol.js`
- `media/infobaseSidebar.js`
- `media/infobaseSidebar.css`

### New tests

- `test/scenarioRelationshipIndex.test.ts`
- `test/scenarioRelationshipService.test.ts`
- `test/stepLibrarySnapshotService.test.ts`
- `test/stepLibraryActions.test.ts`
- `test/stepLibrarySidebarModel.test.ts`
- `test/stepLibrarySidebarProtocol.test.ts`
- `test/stepLibrarySidebarProvider.test.ts`
- `test/infobaseSidebarModel.test.ts`
- `test/managedInfobaseService.test.ts`
- `test/infobaseDestructiveConfirmation.test.ts`
- `test/infobaseSidebarProtocol.test.ts`
- `test/infobaseSidebarProvider.test.ts`
- `test/sidebarWorkbenchContract.test.ts`

---

### Task 1: Stable Scenario Relationship Index

**Files:**
- Create: `src/scenarioRelationshipIndex.ts`
- Modify: `src/scenarioCatalog.ts`
- Create: `test/scenarioRelationshipIndex.test.ts`
- Modify: `test/scenarioDirectoryIndex.test.ts`

**Interfaces:**

```ts
export interface ScenarioRelationshipEntry {
    readonly scenarioKey: string;
    readonly incomingDistance?: number;
    readonly outgoingDistance?: number;
}

export interface ScenarioRelationshipProjection {
    readonly currentScenarioKeys: readonly string[];
    readonly relationships: readonly ScenarioRelationshipEntry[];
    readonly affectedMainScenarioKeys: readonly string[];
    readonly affectedPhaseNames: readonly string[];
}

export class ScenarioRelationshipIndex {
    public static fromCatalog(catalog: ScenarioCatalog): ScenarioRelationshipIndex;
    public project(currentScenarioKeys: readonly string[]): ScenarioRelationshipProjection;
    public getCallerNamesByCalleeName(): ReadonlyMap<string, ReadonlySet<string>>;
}
```

- [ ] **Step 1: Extend the directory-index tests for stable keys**

Add `key` to indexed definitions and assert that `getRelatedScenarioKeys()` returns both raw and canonical Windows/UNC aliases without collapsing two same-name scenarios:

```ts
assert.deepEqual(index.getRelatedScenarioKeys('C:\\Mac\\repo\\A\\test\\test.feature'), [
    'file:///C:/Mac/repo/A/scen.yaml'
]);
```

- [ ] **Step 2: Write failing graph tests**

Cover main → nested → nested traversal, nested → all owning mains/phases, direct/transitive distances, cycles, missing names, duplicate called-name candidates, and stable URI ordering.

```ts
const projection = ScenarioRelationshipIndex.fromCatalog(catalog).project([nestedBKey]);
assert.deepEqual(projection.affectedMainScenarioKeys, [mainKey]);
assert.deepEqual(projection.affectedPhaseNames, ['Accounting']);
assert.deepEqual(projection.relationships, [
    { scenarioKey: nestedAKey, incomingDistance: 1 },
    { scenarioKey: mainKey, incomingDistance: 2 }
]);
```

- [ ] **Step 3: Run targeted tests and verify failure**

Run: `npm run compile-tests && node --test out/test/scenarioDirectoryIndex.test.js out/test/scenarioRelationshipIndex.test.js`

Expected: FAIL because key lookup and `ScenarioRelationshipIndex` do not exist.

- [ ] **Step 4: Implement identity-based adjacency and traversal**

Build forward/reverse maps from `getScenarioRuntimeKey(info)`. Resolve each `nestedScenarioNames` entry through `catalog.byName`; sort candidates by runtime key before adding every edge. Use breadth-first traversal with a per-direction distance map and a visited set. Derive main scenarios from non-empty `tabName` and return every array in case-insensitive label + URI order.

Keep the existing `ScenarioDirectoryIndex.getRelatedScenarioNames()` compatibility method. Accept an optional key during the transition, store `{ key, name, order }`, add `getRelatedScenarioKeys()`, and make Task 2 pass a runtime key for every production definition.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/scenarioDirectoryIndex.test.js out/test/scenarioRelationshipIndex.test.js`

Expected: PASS.

```bash
git add src/scenarioCatalog.ts src/scenarioRelationshipIndex.ts test/scenarioDirectoryIndex.test.ts test/scenarioRelationshipIndex.test.ts
git commit -m "feat: index scenario relationships by identity"
```

### Task 2: Shared Relationship Service and Workspace Toggle

**Files:**
- Create: `src/scenarioRelationshipService.ts`
- Create: `test/scenarioRelationshipService.test.ts`
- Modify: `src/phaseSwitcher.ts`
- Modify: `test/phaseSwitcherWebviewContract.test.ts`

**Interfaces:**

```ts
export interface ScenarioRelationshipState extends ScenarioRelationshipProjection {
    readonly enabled: boolean;
    readonly currentLabel: string | null;
    readonly revision: number;
}

export class ScenarioRelationshipService implements vscode.Disposable {
    public readonly onDidChangeState: vscode.Event<ScenarioRelationshipState>;
    public getState(): ScenarioRelationshipState;
    public handleActiveEditorChanged(uri: vscode.Uri | undefined): void;
    public setEnabled(enabled: boolean): Promise<void>;
}
```

- [ ] **Step 1: Write failing service tests**

Use fake catalog/configuration events. Assert that active-editor changes project the cached catalog without calling `ensureFreshScenarioCatalog`, the same URI/state emits nothing twice, catalog replacement increments the revision, disabled state clears relationship entries but retains current identity, and `setEnabled(false)` writes `ConfigurationTarget.Workspace`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/scenarioRelationshipService.test.js`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement the service without I/O**

The service subscribes to `ScenarioCatalogProvider.onDidUpdateScenarioCatalog` and the existing configuration key. It rebuilds `ScenarioRelationshipIndex` only when the catalog object changes. Resolve active files through exact `catalog.byUri` first and then `ScenarioDirectoryIndex.getRelatedScenarioKeys()` for files under a scenario directory. Do not call `ensureFreshScenarioCatalog()` from active-editor handling.

- [ ] **Step 4: Replace PhaseSwitcher name-BFS with the shared projection**

Add `attachRelationshipService(service)` to `PhaseSwitcherProvider`. Replace `getAffectedMainScenarioNamesForActiveEditor()` and `updateAffectedMainScenarios` payload generation with stable keys from `service.getState()`. Keep a name projection only at the final legacy webview boundary until Task 4 changes the row protocol.

Adapt `buildCallersByCalleeFromCache()` to delegate to `ScenarioRelationshipIndex.getCallerNamesByCalleeName()` so stale-artifact propagation and UI highlighting share graph construction.

- [ ] **Step 5: Prove build selection is not coupled to relationships**

Extend the contract test so relationship messages contain no checkbox/build mutation command and changing the toggle only writes the configuration and posts relationship state.

- [ ] **Step 6: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/scenarioRelationshipService.test.js out/test/phaseSwitcherWebviewContract.test.js out/test/scenarioCatalog.test.js`

Expected: PASS.

```bash
git add src/scenarioRelationshipService.ts src/phaseSwitcher.ts test/scenarioRelationshipService.test.ts test/phaseSwitcherWebviewContract.test.ts
git commit -m "refactor: share scenario relationship state"
```

### Task 3: Characterize and Simplify Test Manager Protocol

**Files:**
- Modify: `media/phaseSwitcherProtocol.js`
- Modify: `media/phaseSwitcher.js`
- Modify: `src/phaseSwitcher.ts`
- Modify: `test/phaseSwitcherWebviewContract.test.ts`
- Create: `test/phaseSwitcherProtocol.test.ts`

**Interfaces:**

```js
function parseRelationshipState(value) {}
function relationshipDecorationForScenario(scenarioKey, state) {}
function aggregatePhaseRelationship(scenarioKeys, state) {}
function nextVisibleSelection(currentKeys, visibleKeys, mode) {}
```

- [ ] **Step 1: Add failing pure protocol tests**

Pin checked/unchecked/indeterminate aggregation, `Select visible`, Favorites filtering, current-vs-focused state separation, current blue precedence over purple relationship state, parent/caller and child/callee icon selection, transitive accessible text, and phase aggregation.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/phaseSwitcherProtocol.test.js out/test/phaseSwitcherWebviewContract.test.js`

Expected: FAIL because the protocol only builds scenario commands.

- [ ] **Step 3: Move pure row/relationship decisions out of the DOM script**

Return a small immutable decoration record:

```js
{
    state: 'current' | 'incoming' | 'outgoing' | 'related' | 'none',
    icon: 'eye' | 'arrow-right-to-line' | 'arrow-right-from-line' | null,
    direct: boolean,
    accessibleLabel: string
}
```

When both directions occur through a cycle, use incoming icon precedence and include both directions in the accessible label. Keep current-file precedence unconditional.

- [ ] **Step 4: Change the Extension Host payload to stable keys**

Post `updateRelationshipState` with `currentScenarioKeys`, `relationships`, `affectedMainScenarioKeys`, `affectedPhaseNames`, `currentLabel`, and `enabled`. Parse the relationship-toggle message exhaustively and call `ScenarioRelationshipService.setEnabled()`.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/phaseSwitcherProtocol.test.js out/test/phaseSwitcherWebviewContract.test.js`

Expected: PASS.

```bash
git add media/phaseSwitcherProtocol.js media/phaseSwitcher.js src/phaseSwitcher.ts test/phaseSwitcherProtocol.test.ts test/phaseSwitcherWebviewContract.test.ts
git commit -m "refactor: type test manager relationship protocol"
```

### Task 4: Native Compact Test Manager Visual System

**Files:**
- Create: `media/kotSidebar.css`
- Modify: `media/kotWebviewTheme.css`
- Modify: `media/phaseSwitcher.html`
- Modify: `media/phaseSwitcher.css`
- Modify: `media/phaseSwitcher.js`
- Modify: `src/phaseSwitcher.ts`
- Modify: `test/phaseSwitcherWebviewContract.test.ts`
- Create: `test/sidebarWorkbenchContract.test.ts`

- [ ] **Step 1: Add failing narrow-layout and accessibility contracts**

Assert that Test Manager loads `kotSidebar.css`, tree scrollers set `overflow-x: hidden`, flexible labels have `min-width: 0` + ellipsis, row actions occupy a fixed end gutter, tree toggles expose `aria-expanded`, icon-only controls have localized labels, and relationship/current/modified states expose text alternatives.

- [ ] **Step 2: Run the contracts and verify failure**

Run: `npm run compile-tests && node --test out/test/sidebarWorkbenchContract.test.js out/test/phaseSwitcherWebviewContract.test.js`

Expected: FAIL because the shared sidebar stylesheet and required semantics do not exist.

- [ ] **Step 3: Add reusable sidebar primitives**

Define only theme-token-based primitives: `.kot-sidebar-toolbar`, `.kot-sidebar-search`, `.kot-tree`, `.kot-tree-row`, `.kot-tree-label`, `.kot-row-actions`, `.is-current`, `.is-related`, `.is-transitive`, `.is-modified`, `.kot-empty`, `.kot-error`, and `.kot-loading`. Use 30–32 px rows and 28–30 px controls. Derive purple from `--vscode-charts-purple` with list/editor fallbacks; do not hard-code a theme background.

- [ ] **Step 4: Restructure Test Manager while retaining existing IDs/commands**

Keep Tests/Favorites, search, create/refresh/collapse/overflow, phase/main tree, selected count, build mode, and `Build tests`. Remove redundant row prose and decorative status chips. Add the pressed `git-branch` relationship toggle and two-line compact context summary. Render modified state as amber `M` with tooltip. Keep only main scenario rows.

- [ ] **Step 5: Preserve scroll and focus during incremental updates**

Patch existing rows by scenario key instead of replacing the whole tree for relationship/run-state changes. Before a necessary structural render, capture `scrollTop`, focused scenario key, and expanded phase IDs; restore them after rendering.

- [ ] **Step 6: Run Test Manager regression tests and commit**

Run: `npm run compile-tests && node --test out/test/phaseSwitcherWebviewContract.test.js out/test/phaseSwitcherProtocol.test.js out/test/sidebarWorkbenchContract.test.js out/test/scenarioRuntimeIdentity.test.js`

Expected: PASS.

```bash
git add media/kotSidebar.css media/kotWebviewTheme.css media/phaseSwitcher.html media/phaseSwitcher.css media/phaseSwitcher.js src/phaseSwitcher.ts test/phaseSwitcherWebviewContract.test.ts test/sidebarWorkbenchContract.test.ts
git commit -m "feat: modernize test manager sidebar"
```

### Task 5: Shared Step Library Snapshot and Action Services

**Files:**
- Create: `src/stepLibrarySnapshotService.ts`
- Create: `src/stepLibraryActions.ts`
- Modify: `src/stepLibraryPanel.ts`
- Create: `test/stepLibrarySnapshotService.test.ts`
- Create: `test/stepLibraryActions.test.ts`
- Modify: `test/stepLibraryPanel.test.ts`
- Modify: `test/extensionActivationContract.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**

```ts
export class StepLibrarySnapshotService implements vscode.Disposable {
    public readonly onDidInvalidate: vscode.Event<void>;
    public getCurrent(resource?: vscode.Uri): StepLibrarySnapshot | null;
    public ensureReady(resource?: vscode.Uri): Promise<StepLibrarySnapshot>;
    public invalidate(): void;
}

export class StepLibraryActionService implements vscode.Disposable {
    public readonly onDidChangeInsertionTarget: vscode.Event<StepLibraryInsertionTargetState>;
    public getInsertionTargetState(): StepLibraryInsertionTargetState;
    public insert(item: StepLibraryItem, resource?: vscode.Uri): Promise<boolean>;
    public copy(item: StepLibraryItem): Promise<boolean>;
    public openDefinition(item: StepLibraryItem, resource?: vscode.Uri): Promise<boolean>;
}
```

- [ ] **Step 1: Write failing snapshot-service tests**

Assert two concurrent `ensureReady()` calls invoke `resolver.ensureReady()` once, subsequent calls reuse the same snapshot, resolver/scenario-catalog changes invalidate it, and invalidation does not eagerly rebuild.

- [ ] **Step 2: Write failing shared-action tests**

Move the existing panel cases for YAML/Feature insertion context, multi-cursor homogeneity, stale editor generation, copy, captured-location navigation, and unsupported editors to the new service suite.

- [ ] **Step 3: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/stepLibrarySnapshotService.test.js out/test/stepLibraryActions.test.js`

Expected: FAIL because both services are absent.

- [ ] **Step 4: Implement cached snapshots with in-flight deduplication**

Key cache entries by resource URI and store the resolver `view.identity` inside the snapshot. Subscribe to `resolver.onDidChangeView` and `ScenarioCatalogProvider.onDidUpdateScenarioCatalog`; clear cached/in-flight generations and emit invalidation, but do not call the resolver from the event handler.

- [ ] **Step 5: Extract actions without changing snippet bytes**

Move insertion-target capture/revalidation and `insertItem`, `copyItem`, `openItem` behavior from `StepLibraryPanel` into `StepLibraryActionService`. Keep `buildProjectDefinitionInsertion()` and `openProjectDefinitionHandler()` unchanged. The full panel delegates to the service and listens for insertion-target changes.

- [ ] **Step 6: Update the full panel to consume the services**

Replace direct `resolver.ensureReady()` + `buildStepLibrarySnapshot()` and private action code with injected `snapshotService` and `actionService`. Preserve generation guards, hidden-panel deferral, pending-action suppression, and last successful snapshot/error behavior.

- [ ] **Step 7: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/stepLibrarySnapshotService.test.js out/test/stepLibraryActions.test.js out/test/stepLibraryPanel.test.js out/test/stepLibraryPanelContract.test.js out/test/projectDefinitionSnippet.test.js`

Expected: PASS with existing snippet assertions unchanged.

```bash
git add src/stepLibrarySnapshotService.ts src/stepLibraryActions.ts src/stepLibraryPanel.ts src/extension.ts test/stepLibrarySnapshotService.test.ts test/stepLibraryActions.test.ts test/stepLibraryPanel.test.ts test/extensionActivationContract.test.ts
git commit -m "refactor: share step library state and actions"
```

### Task 6: Pure Compact Step Library Projection

**Files:**
- Create: `src/stepLibrarySidebarModel.ts`
- Create: `test/stepLibrarySidebarModel.test.ts`
- Create: `media/stepLibrarySidebarProtocol.js`
- Create: `test/stepLibrarySidebarProtocol.test.ts`

**Interfaces:**

```ts
export interface StepLibrarySidebarNode {
    readonly id: string;
    readonly kind: 'source' | 'category' | 'definition' | 'more';
    readonly label: string;
    readonly count?: number;
    readonly depth: number;
    readonly expandable: boolean;
    readonly itemId?: string;
}

export interface StepLibrarySidebarPage {
    readonly parentId: string;
    readonly nodes: readonly StepLibrarySidebarNode[];
    readonly nextOffset: number | null;
}

export class StepLibrarySidebarIndex {
    public static fromSnapshot(snapshot: StepLibrarySnapshot, preferredLanguage: 'ru' | 'en'): StepLibrarySidebarIndex;
    public roots(): readonly StepLibrarySidebarNode[];
    public children(parentId: string, offset?: number, limit?: number): StepLibrarySidebarPage;
    public search(query: string, limit?: number): readonly StepLibrarySidebarNode[];
    public getItem(itemId: string): StepLibraryItem | undefined;
}
```

- [ ] **Step 1: Write failing projection tests**

Cover five source roots, hierarchical categories, uncategorized placement, direct definitions, stable order, 100-row pagination, empty state, query ranking, code/category/parameter search, and preservation of multiline aligned Gherkin text.

- [ ] **Step 2: Pin RU/EN family deduplication**

Create RU and EN built-in definitions with the same `familyId`. Assert exactly one definition and one category branch, preferred-language display text, and the alternate text retained for tooltip/search.

- [ ] **Step 3: Add relationship decoration input tests**

The client protocol accepts a relationship state and returns current/incoming/outgoing/transitive classes and `eye`, `arrow-right-to-line`, or `arrow-right-from-line` without changing tree expansion or selection.

- [ ] **Step 4: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/stepLibrarySidebarModel.test.js out/test/stepLibrarySidebarProtocol.test.js`

Expected: FAIL because the compact model/protocol are absent.

- [ ] **Step 5: Implement a bounded host-side index and pure client state helpers**

Build normalized search fields once. Initial `roots()` returns counts only. `children()` returns immediate category nodes plus at most `limit` direct definitions and a `more` node. `search()` returns at most 100 definitions. The browser protocol owns expanded IDs, selected ID, keyboard movement, and relationship class calculation only; it never filters the entire snapshot.

- [ ] **Step 6: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/stepLibrarySidebarModel.test.js out/test/stepLibrarySidebarProtocol.test.js out/test/stepLibraryModel.test.js`

Expected: PASS.

```bash
git add src/stepLibrarySidebarModel.ts media/stepLibrarySidebarProtocol.js test/stepLibrarySidebarModel.test.ts test/stepLibrarySidebarProtocol.test.ts
git commit -m "feat: project compact step library tree"
```

### Task 7: Compact Step Library Webview View

**Files:**
- Create: `src/stepLibrarySidebarProvider.ts`
- Create: `media/stepLibrarySidebar.js`
- Create: `media/stepLibrarySidebar.css`
- Create: `test/stepLibrarySidebarProvider.test.ts`
- Modify: `test/sidebarWorkbenchContract.test.ts`

**Inbound protocol:**

```ts
type StepLibrarySidebarMessage =
    | { command: 'ready' }
    | { command: 'expand'; nodeId: string; offset: number }
    | { command: 'search'; query: string }
    | { command: 'insert'; itemId: string }
    | { command: 'openDefinition'; itemId: string }
    | { command: 'refresh' }
    | { command: 'openFullLibrary' };
```

- [ ] **Step 1: Write failing provider lifecycle/protocol tests**

Assert invalid messages are ignored, initial resolve posts loading then roots only, an expanded branch requests one bounded page, search is capped, stale generation results are discarded, hidden invalidation defers rebuilding, reopen receives the latest revision, and full-library action invokes `kotTestToolkit.openStepLibrary`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/stepLibrarySidebarProvider.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: FAIL because the provider/assets are absent.

- [ ] **Step 3: Implement the provider over shared services**

On visible `ready`, call `snapshotService.ensureReady(resource)` and build `StepLibrarySidebarIndex`. Subscribe to snapshot invalidation, action target changes, relationship state, and view visibility. Reuse `StepLibraryActionService` for Enter/Cmd-or-Ctrl+Enter. `refresh` delegates to the existing refresh callback and then invalidates/loads the shared snapshot.

- [ ] **Step 4: Implement the unified tree UI**

Use event delegation, `DocumentFragment`, and `textContent`. Debounce search by 150 ms and send only the query to the host. Render source/category chevrons with `aria-expanded`; render syntax spans from a local tokenizer over only returned rows. Keep expanded IDs and scroll position in `vscode.getState()`.

- [ ] **Step 5: Apply relationship/current rendering**

Map nested/main definition items to their captured scenario URI keys. Current rows use blue + `eye`; incoming/outgoing use purple + directional icon; transitive rows lower opacity; source/category ancestors use `git-branch`. The Test Manager setting controls all relationship markers in this view.

- [ ] **Step 6: Add narrow-width CSS contracts**

Require `overflow-x: hidden`, `.kot-tree-label { min-width: 0; text-overflow: ellipsis; }`, multiline definition blocks with `white-space: pre`, and a fixed end gutter. No card backgrounds, gradients, or horizontal scrolling.

- [ ] **Step 7: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/stepLibrarySidebarProvider.test.js out/test/stepLibrarySidebarProtocol.test.js out/test/sidebarWorkbenchContract.test.js out/test/stepLibraryPerformance.test.js`

Expected: PASS.

```bash
git add src/stepLibrarySidebarProvider.ts media/stepLibrarySidebar.js media/stepLibrarySidebar.css test/stepLibrarySidebarProvider.test.ts test/sidebarWorkbenchContract.test.ts
git commit -m "feat: add compact step library view"
```

### Task 8: Shared Managed Infobase Service and Active-Profile Projection

**Files:**
- Create: `src/managedInfobaseService.ts`
- Create: `src/infobaseSidebarModel.ts`
- Modify: `src/infobaseManager.ts`
- Modify: `src/infobaseManagerPanel.ts`
- Create: `test/managedInfobaseService.test.ts`
- Create: `test/infobaseSidebarModel.test.ts`
- Modify: `test/extensionActivationContract.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**

```ts
export interface ManagedInfobaseSnapshot {
    readonly revision: number;
    readonly profileId: string;
    readonly profileName: string;
    readonly activeInfobaseIdentity: string | null;
    readonly infobases: readonly ManagedInfobaseRecord[];
}

export class ManagedInfobaseService implements vscode.Disposable {
    public readonly onDidInvalidate: vscode.Event<void>;
    public getCurrent(): ManagedInfobaseSnapshot | null;
    public ensureReady(): Promise<ManagedInfobaseSnapshot>;
    public refresh(): Promise<ManagedInfobaseSnapshot>;
}
```

- [ ] **Step 1: Write failing active-profile model tests**

Resolve `LaunchDBFolder`, `TestClientDBPath`, `InfobasePath`, or `TestClientDB` case/underscore/hyphen-insensitively. Resolve relative file paths against the workspace root. Assert normalized identity matches file/server/web records, marks one active row, sorts it first, hides hidden records, and leaves other managed bases visible.

- [ ] **Step 2: Write failing cache/laziness tests**

Assert constructor/activation does not call the collector, concurrent `ensureReady()` calls collect once, repeated calls reuse the snapshot, explicit refresh collects once, and active-profile change invalidates without collecting until a consumer calls `ensureReady()`.

- [ ] **Step 3: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/managedInfobaseService.test.js out/test/infobaseSidebarModel.test.js`

Expected: FAIL because the service/model are absent.

- [ ] **Step 4: Allow profile observations in the existing collector**

Add an optional `activeProfileInfobasePath` argument to `collectManagedInfobases()`. Feed it through the existing internal `observeInfobase()` path with a new in-memory `profile` source so an active path not yet seen in launcher/manual/runtime data still receives a normal `ManagedInfobaseRecord`. Do not persist a new format.

- [ ] **Step 5: Implement the lazy shared service**

Inject a collector callback so `extension.ts` can use dynamic `import('./infobaseManager.js')` and keep activation cheap. Load `YamlParametersManager.loadActiveProfileSnapshot()`, resolve the active path, coalesce in-flight collection, freeze the snapshot, and invalidate on `onDidChangeActiveProfile`.

- [ ] **Step 6: Refactor the full manager to use the service**

Inject `ManagedInfobaseService` into `InfobaseManagerPanel`. Replace direct `collectManagedInfobases()` calls with `ensureReady()`/`refresh()`. After every mutating action, refresh the service so both surfaces observe the same revision.

- [ ] **Step 7: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/managedInfobaseService.test.js out/test/infobaseSidebarModel.test.js out/test/extensionActivationContract.test.js`

Expected: PASS, including the assertion that optional infobase infrastructure remains deferred.

```bash
git add src/managedInfobaseService.ts src/infobaseSidebarModel.ts src/infobaseManager.ts src/infobaseManagerPanel.ts src/extension.ts test/managedInfobaseService.test.ts test/infobaseSidebarModel.test.ts test/extensionActivationContract.test.ts
git commit -m "refactor: share managed infobase snapshots"
```

### Task 9: Mandatory Confirmation for Destructive Infobase Imports

**Files:**
- Create: `src/infobaseDestructiveConfirmation.ts`
- Modify: `src/infobaseManager.ts`
- Create: `test/infobaseDestructiveConfirmation.test.ts`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`

**Interfaces:**

```ts
export type DestructiveInfobaseImportKind = 'dt' | 'cf' | 'sourceDirectory';

export interface DestructiveInfobaseImportConfirmation {
    readonly title: string;
    readonly detail: string;
    readonly confirmLabel: string;
}

export function buildDestructiveInfobaseImportConfirmation(
    kind: DestructiveInfobaseImportKind,
    sourcePath: string,
    target: Pick<ManagedInfobaseRecord, 'displayName' | 'infobasePath'>,
    t: Translator
): DestructiveInfobaseImportConfirmation;
```

- [ ] **Step 1: Write failing confirmation-content tests**

Assert `.dt`, `.cf`, and source-directory messages include the exact normalized source path, target display name, target connection/path, destructive consequence, and operation-specific confirm label.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/infobaseDestructiveConfirmation.test.js`

Expected: FAIL because the helper is absent.

- [ ] **Step 3: Add modal confirmation before process resolution**

After the source picker/choice but before `assertInfobaseNotBusy()`, platform resolution, log creation, or process start, call:

```ts
const answer = await vscode.window.showWarningMessage(
    confirmation.title,
    { modal: true, detail: confirmation.detail },
    confirmation.confirmLabel
);
if (answer !== confirmation.confirmLabel) {
    return;
}
```

Apply it to `restoreInfobaseFromDtInteractive()` and both branches of `updateInfobaseConfigurationInteractive()`.

- [ ] **Step 4: Add source-order contract assertions**

Assert in the manager source that confirmation appears after source selection and before `runInfobaseDesignerCommandWithAuthRetry()` for each destructive path.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/infobaseDestructiveConfirmation.test.js`

Expected: PASS.

```bash
git add src/infobaseDestructiveConfirmation.ts src/infobaseManager.ts test/infobaseDestructiveConfirmation.test.ts l10n/bundle.l10n.json l10n/bundle.l10n.ru.json
git commit -m "fix: confirm destructive infobase imports"
```

### Task 10: Compact Infobases Webview View

**Files:**
- Create: `src/infobaseSidebarProvider.ts`
- Create: `media/infobaseSidebarProtocol.js`
- Create: `media/infobaseSidebar.js`
- Create: `media/infobaseSidebar.css`
- Create: `test/infobaseSidebarProtocol.test.ts`
- Create: `test/infobaseSidebarProvider.test.ts`
- Modify: `test/sidebarWorkbenchContract.test.ts`

**Inbound protocol:**

```ts
type InfobaseSidebarMessage =
    | { command: 'ready' }
    | { command: 'refresh' }
    | { command: 'openEnterprise'; infobaseId: string }
    | { command: 'openDesigner'; infobaseId: string }
    | { command: 'maintenance'; infobaseId: string; action: 'exportDt' | 'importDt' | 'exportCf' | 'importCf' }
    | { command: 'createInfobase' }
    | { command: 'openFullManager' };
```

- [ ] **Step 1: Write failing protocol/provider tests**

Assert unknown action/ID rejection, last-valid-snapshot retention on error, loading/empty states, active-profile marker semantics, pending row action, hidden invalidation deferral, full-manager command, create command, and exact routing to existing Enterprise/Designer/DT/CF functions.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/infobaseSidebarProtocol.test.js out/test/infobaseSidebarProvider.test.js`

Expected: FAIL because the provider/assets are absent.

- [ ] **Step 3: Implement a lazy typed provider**

Inject `ManagedInfobaseService` and a deferred operations loader. Resolve `infobaseId` only against the current snapshot. Route create/launch/maintenance to existing functions, mark only that row pending, refresh the shared service after mutations, and report failures through the existing notifications/output behavior.

Map `importCf` to the `.cf` branch of `updateInfobaseConfigurationInteractive()` by adding an optional typed mode hint; the full manager keeps its chooser when no hint is supplied.

- [ ] **Step 4: Implement the compact list and menu**

Render profile name, base label/location, a green active-profile dot with tooltip, Enterprise and Designer icon buttons, and an accessible overflow menu. Footer buttons open the full manager and create a base. Use roving keyboard focus, Escape to close the menu, and no horizontal scrolling.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/infobaseSidebarProtocol.test.js out/test/infobaseSidebarProvider.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: PASS.

```bash
git add src/infobaseSidebarProvider.ts media/infobaseSidebarProtocol.js media/infobaseSidebar.js media/infobaseSidebar.css test/infobaseSidebarProtocol.test.ts test/infobaseSidebarProvider.test.ts test/sidebarWorkbenchContract.test.ts
git commit -m "feat: add compact infobase view"
```

### Task 11: Register the Three-View Workbench and Complete Localization

**Files:**
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.ru.json`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`
- Modify: `src/extension.ts`
- Modify: `test/extensionActivationContract.test.ts`
- Modify: `test/sidebarWorkbenchContract.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add failing contribution and activation tests**

Assert the existing container contributes exactly these ordered webview views:

```json
[
  "kotTestToolkit.phaseSwitcherView",
  "kotTestToolkit.stepLibrarySidebarView",
  "kotTestToolkit.infobaseSidebarView"
]
```

Assert all providers register with `retainContextWhenHidden`, full-panel commands remain contributed, activation does not call `ensureReady()`/`collectManagedInfobases()`, and active-editor changes reach the shared relationship service once.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run compile-tests && node --test out/test/extensionActivationContract.test.js out/test/sidebarWorkbenchContract.test.js`

Expected: FAIL because the manifest and final wiring are incomplete.

- [ ] **Step 3: Wire shared services once in activation**

Create services in dependency order:

```ts
const phaseSwitcherProvider = new PhaseSwitcherProvider(context.extensionUri, context);
const relationshipService = new ScenarioRelationshipService(context, phaseSwitcherProvider);
phaseSwitcherProvider.attachRelationshipService(relationshipService);
const stepLibrarySnapshotService = new StepLibrarySnapshotService(projectDefinitionResolver, phaseSwitcherProvider);
const stepLibraryActions = new StepLibraryActionService(projectDefinitionResolver);
const managedInfobaseService = new ManagedInfobaseService(context, yamlParametersManager, lazyCollector);
```

Register the two compact providers without resolving their data. Pass the same step services to the full panel and the same infobase service to the full manager.

- [ ] **Step 4: Add manifest views, titles, commands, and localized labels**

Keep Test Manager first, Step Library second, Infobases third. Add localized view names/context titles and every new aria label, loading/empty/error message, relationship tooltip, profile label, and maintenance label. Avoid duplicate English keys and verify Russian bundle coverage.

- [ ] **Step 5: Document the new workbench**

Add a concise README section explaining the three collapsible sections, build-checkbox meaning, relationship toggle/icons/colors, compact-vs-full Step Library, and compact-vs-full Infobase Manager. Add the sidebar workbench and safe import confirmation to the unreleased `2.8.0` changelog section.

- [ ] **Step 6: Run integration tests and commit**

Run: `npm run compile-tests && node --test out/test/extensionActivationContract.test.js out/test/sidebarWorkbenchContract.test.js out/test/phaseSwitcherWebviewContract.test.js out/test/stepLibrarySidebarProvider.test.js out/test/infobaseSidebarProvider.test.js`

Expected: PASS.

```bash
git add package.json package.nls.json package.nls.ru.json l10n/bundle.l10n.json l10n/bundle.l10n.ru.json src/extension.ts test/extensionActivationContract.test.ts test/sidebarWorkbenchContract.test.ts README.md CHANGELOG.md
git commit -m "feat: register KOT sidebar workbench"
```

### Task 12: Performance, Packaging, and Manual Visual Verification

**Files:**
- Modify: `test/stepLibraryPerformance.test.ts`
- Modify: `test/sidebarWorkbenchContract.test.ts`
- Create: `docs/qa/sidebar-workbench-visual-matrix.md`
- Modify: files found defective during this task only

- [ ] **Step 1: Add deterministic performance-boundary tests**

Do not use fragile wall-clock assertions. Instead instrument dependencies and assert:

- active-editor relationship updates call neither filesystem nor resolver APIs;
- two visible Step Library consumers share one in-flight resolver call;
- initial compact Step Library payload contains roots/categories but no complete definition list;
- search/expand returns at most the configured page limit;
- hidden invalidation performs zero model rebuilds;
- two infobase consumers share one in-flight collector call.

- [ ] **Step 2: Run the complete automated suite**

Run: `npm run check`

Expected: typecheck, ESLint, and every Node test PASS with zero warnings.

- [ ] **Step 3: Package the extension**

Run: `vsce package`

Expected: the `vscode:prepublish` check passes and a `kot-test-toolkit-2.8.0.vsix` is produced.

- [ ] **Step 4: Execute and record the visual matrix**

Test macOS and the Windows/Parallels VM with dark and light themes, 100/125/150% UI scaling, and 320/360/430 px sidebar widths. Record pass/fail and screenshots for:

- three native collapsible/resizable sections;
- Tests/Favorites/search/build selection;
- current main, current nested, incoming/outgoing/transitive relations, toggle off/on persistence;
- long RU/EN labels and multiline/table steps without horizontal overflow;
- Step Library expand/search/insert/open/full-library actions;
- active-profile base, Enterprise/Designer, create, DT/CF menu, full manager;
- cancel and confirm paths for destructive imports;
- keyboard-only tree/menu traversal and visible focus.

- [ ] **Step 5: Check Extension Host responsiveness**

On the Windows VM, Reload Window, open each sidebar view, expand a large Step Library category, search, switch active YAML scenarios, and refresh once. Confirm no `UNRESPONSIVE extension host` warning and compare catalog/infobase scan counts with the baseline: each underlying source is loaded once, not once per view.

- [ ] **Step 6: Run final diff hygiene and commit QA evidence**

Run: `git diff --check && npm run check`

Expected: no whitespace errors and all checks PASS.

```bash
git add test/stepLibraryPerformance.test.ts test/sidebarWorkbenchContract.test.ts docs/qa/sidebar-workbench-visual-matrix.md
git commit -m "test: verify sidebar workbench performance"
```

## Final Review Checklist

- [ ] Every acceptance criterion in the design spec maps to at least one automated or manual check above.
- [ ] No task contains vague placeholders, deferred TODO work, invented scan paths, or unvalidated arbitrary commands.
- [ ] `ScenarioRelationshipProjection`, sidebar node IDs, and infobase IDs use stable identities consistently across host and webview protocols.
- [ ] Existing full panels, build/run workflows, Favorites, and creation commands remain available.
- [ ] Activation remains lazy for Step Library preparation and infobase discovery.
- [ ] AI-related files and behavior are untouched.
- [ ] `npm run check`, `vsce package`, and the Windows/Parallels visual/performance matrix pass before PR update.
