# Scenario Catalog and Lazy Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve all scenario definitions, expose duplicate names explicitly, and avoid scanning the complete scenario corpus until a feature requests scenario data.

**Architecture:** Add an immutable duplicate-aware `ScenarioCatalog` and a testable `LazyScenarioCatalog` state holder. `workspaceScanner` produces the catalog, while `PhaseSwitcherProvider` publishes both the complete catalog and a deterministic compatibility map so consumers can migrate incrementally. Navigation, diagnostics, hover, completion, and metadata updates use the complete catalog whenever choosing one definition matters.

**Tech Stack:** TypeScript 5.8+, Node.js `node:test`, esbuild, VS Code Extension API, ESLint 9.

**Spec:** `docs/superpowers/specs/2026-09-13-scenario-catalog-design.md`

## Global Constraints

- Keep `/Users/alexeremeev/Development/1cDrive/tests/RegressionTests/Yaml/Drive` read-only.
- Preserve public VS Code command IDs, settings, and YAML call syntax.
- Keep `getTestCache()` and its existing event as a compatibility boundary during this increment.
- Do not add a persistent on-disk index.
- Do not migrate build artifact identity or Test Manager selection persistence from scenario name to URI in this increment.
- Do not introduce `any` to bypass strict TypeScript checks.
- Every task must leave `npm run check` green before its commit.

---

### Task 1: Build the duplicate-aware catalog

**Files:**
- Create: `src/scenarioCatalog.ts`
- Create: `test/scenarioCatalog.test.ts`

**Interfaces:**
- Consumes: `TestInfo` from `src/types.ts` as a type-only import.
- Produces: `ScenarioCatalog`, `ScenarioResolution`, `buildScenarioCatalog`, `resolveScenarioByName`, `upsertScenarioInCatalog`, and `removeScenarioFromCatalogByUri`.

- [x] **Step 1: Write catalog tests**

Create `test/scenarioCatalog.test.ts` with a URI stub and exact assertions for preservation, stable ordering, resolution, upsert, and removal:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestInfo } from '../src/types';
import {
    buildScenarioCatalog,
    removeScenarioFromCatalogByUri,
    resolveScenarioByName,
    upsertScenarioInCatalog
} from '../src/scenarioCatalog';

function scenario(name: string, relativePath: string, uri: string, scenarioCode?: string): TestInfo {
    return {
        name,
        relativePath,
        scenarioCode,
        yamlFileUri: { toString: () => uri } as TestInfo['yamlFileUri']
    };
}

test('preserves duplicate definitions and chooses a stable compatibility primary', () => {
    const second = scenario('Duplicate', 'z/second', 'file:///z/scen.yaml');
    const first = scenario('Duplicate', 'a/first', 'file:///a/scen.yaml');
    const catalog = buildScenarioCatalog([second, first]);

    assert.equal(catalog.all.length, 2);
    assert.deepEqual(catalog.byName.get('Duplicate'), [first, second]);
    assert.equal(catalog.primaryByName.get('Duplicate'), first);
    assert.equal(buildScenarioCatalog([first, second]).primaryByName.get('Duplicate'), first);
});

test('returns missing, unique, and ambiguous name resolutions', () => {
    const one = scenario('One', 'one', 'file:///one/scen.yaml');
    const duplicateA = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const duplicateB = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const catalog = buildScenarioCatalog([duplicateB, one, duplicateA]);

    assert.deepEqual(resolveScenarioByName(catalog, 'Missing'), { kind: 'missing', name: 'Missing' });
    assert.deepEqual(resolveScenarioByName(catalog, 'One'), { kind: 'unique', name: 'One', scenario: one });
    assert.deepEqual(resolveScenarioByName(catalog, 'Duplicate'), {
        kind: 'ambiguous',
        name: 'Duplicate',
        scenarios: [duplicateA, duplicateB]
    });
});

test('upserts by URI and removal keeps the other duplicate', () => {
    const oldEntry = scenario('Old', 'same', 'file:///same/scen.yaml', '1');
    const replacement = scenario('New', 'same', 'file:///same/scen.yaml', '2');
    const other = scenario('New', 'other', 'file:///other/scen.yaml', '3');

    const updated = upsertScenarioInCatalog(buildScenarioCatalog([oldEntry, other]), replacement);
    assert.equal(updated.byName.has('Old'), false);
    assert.deepEqual(updated.byName.get('New'), [other, replacement]);

    const removed = removeScenarioFromCatalogByUri(updated, 'file:///same/scen.yaml');
    assert.deepEqual(removed.byName.get('New'), [other]);
    assert.equal(removed.byUri.has('file:///same/scen.yaml'), false);
});
```

- [x] **Step 2: Verify the tests fail for the missing module**

Run:

```bash
npm run compile-tests
```

Expected: esbuild fails to resolve `../src/scenarioCatalog`.

- [x] **Step 3: Implement the catalog**

Create `src/scenarioCatalog.ts` with exact-name lookup, stable path ordering, and URI-based replacement:

```ts
import type { TestInfo } from './types';

export interface ScenarioCatalog {
    readonly all: readonly TestInfo[];
    readonly byName: ReadonlyMap<string, readonly TestInfo[]>;
    readonly byUri: ReadonlyMap<string, TestInfo>;
    readonly primaryByName: ReadonlyMap<string, TestInfo>;
}

export type ScenarioResolution =
    | { kind: 'missing'; name: string }
    | { kind: 'unique'; name: string; scenario: TestInfo }
    | { kind: 'ambiguous'; name: string; scenarios: readonly TestInfo[] };

function compareDefinitions(left: TestInfo, right: TestInfo): number {
    const leftPath = left.relativePath.replace(/\\/g, '/');
    const rightPath = right.relativePath.replace(/\\/g, '/');
    return leftPath.localeCompare(rightPath, undefined, { sensitivity: 'base' })
        || left.yamlFileUri.toString().localeCompare(right.yamlFileUri.toString());
}

export function buildScenarioCatalog(scenarios: readonly TestInfo[]): ScenarioCatalog {
    const all = scenarios.filter(item => item.name.length > 0).slice().sort(compareDefinitions);
    const byName = new Map<string, TestInfo[]>();
    const byUri = new Map<string, TestInfo>();
    for (const scenario of all) {
        byUri.set(scenario.yamlFileUri.toString(), scenario);
        const bucket = byName.get(scenario.name) || [];
        bucket.push(scenario);
        byName.set(scenario.name, bucket);
    }
    const primaryByName = new Map<string, TestInfo>();
    for (const [name, definitions] of byName) {
        primaryByName.set(name, definitions[0]);
    }
    return { all, byName, byUri, primaryByName };
}

export function resolveScenarioByName(catalog: ScenarioCatalog, name: string): ScenarioResolution {
    const scenarios = catalog.byName.get(name) || [];
    if (scenarios.length === 0) {
        return { kind: 'missing', name };
    }
    return scenarios.length === 1
        ? { kind: 'unique', name, scenario: scenarios[0] }
        : { kind: 'ambiguous', name, scenarios };
}

export function upsertScenarioInCatalog(catalog: ScenarioCatalog, scenario: TestInfo): ScenarioCatalog {
    const uriKey = scenario.yamlFileUri.toString();
    return buildScenarioCatalog([...catalog.all.filter(item => item.yamlFileUri.toString() !== uriKey), scenario]);
}

export function removeScenarioFromCatalogByUri(catalog: ScenarioCatalog, uriKey: string): ScenarioCatalog {
    return buildScenarioCatalog(catalog.all.filter(item => item.yamlFileUri.toString() !== uriKey));
}
```

- [x] **Step 4: Run the focused tests and quality gate**

Run:

```bash
npm run compile-tests
node --test out/test/scenarioCatalog.test.js
npm run check
```

Expected: 3 catalog tests pass and the full gate exits 0.

- [x] **Step 5: Commit the catalog**

```bash
git add src/scenarioCatalog.ts test/scenarioCatalog.test.ts
git commit -m "feat: add duplicate-aware scenario catalog"
```

---

### Task 2: Add a coalescing lazy catalog state holder

**Files:**
- Create: `src/lazyScenarioCatalog.ts`
- Create: `test/lazyScenarioCatalog.test.ts`

**Interfaces:**
- Consumes: `ScenarioCatalog` from Task 1.
- Produces: `LazyScenarioCatalog` with `current`, `isDirty`, `ensureLoaded`, `replace`, `update`, and `invalidate`.

- [x] **Step 1: Write lazy-loading tests**

Create `test/lazyScenarioCatalog.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { LazyScenarioCatalog } from '../src/lazyScenarioCatalog';
import { buildScenarioCatalog } from '../src/scenarioCatalog';

const emptyCatalog = buildScenarioCatalog([]);

test('coalesces concurrent loads', async () => {
    let loadCount = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = new LazyScenarioCatalog(async () => {
        loadCount += 1;
        await gate;
        return emptyCatalog;
    });

    const first = state.ensureLoaded();
    const second = state.ensureLoaded();
    assert.equal(loadCount, 1);
    release();
    assert.equal(await first, emptyCatalog);
    assert.equal(await second, emptyCatalog);
});

test('invalidation stays lazy until the next ensure call', async () => {
    let loadCount = 0;
    const state = new LazyScenarioCatalog(async () => {
        loadCount += 1;
        return emptyCatalog;
    });
    await state.ensureLoaded();
    state.invalidate();
    assert.equal(loadCount, 1);
    assert.equal(state.isDirty, true);
    await state.ensureLoaded();
    assert.equal(loadCount, 2);
});

test('retries after a failed load and does not publish a partial value', async () => {
    let loadCount = 0;
    const state = new LazyScenarioCatalog(async () => {
        loadCount += 1;
        if (loadCount === 1) {
            throw new Error('scan failed');
        }
        return emptyCatalog;
    });
    await assert.rejects(state.ensureLoaded(), /scan failed/);
    assert.equal(state.current, null);
    assert.equal(await state.ensureLoaded(), emptyCatalog);
    assert.equal(loadCount, 2);
});

test('update does not initialize an unloaded state', () => {
    let transformed = false;
    const state = new LazyScenarioCatalog(async () => emptyCatalog);
    assert.equal(state.update(catalog => {
        transformed = true;
        return catalog;
    }), false);
    assert.equal(transformed, false);
});
```

- [x] **Step 2: Verify the tests fail for the missing module**

Run `npm run compile-tests` and expect an unresolved `../src/lazyScenarioCatalog` error.

- [x] **Step 3: Implement the lazy holder**

Create `src/lazyScenarioCatalog.ts`:

```ts
import type { ScenarioCatalog } from './scenarioCatalog';

export class LazyScenarioCatalog {
    private catalog: ScenarioCatalog | null = null;
    private dirty = true;
    private inFlight: Promise<ScenarioCatalog> | null = null;

    public constructor(private readonly loader: () => Promise<ScenarioCatalog>) {}

    public get current(): ScenarioCatalog | null {
        return this.catalog;
    }

    public get isDirty(): boolean {
        return this.dirty;
    }

    public ensureLoaded(): Promise<ScenarioCatalog> {
        if (this.catalog && !this.dirty) {
            return Promise.resolve(this.catalog);
        }
        if (this.inFlight) {
            return this.inFlight;
        }
        this.inFlight = this.loader()
            .then(catalog => {
                this.replace(catalog);
                return catalog;
            })
            .finally(() => {
                this.inFlight = null;
            });
        return this.inFlight;
    }

    public replace(catalog: ScenarioCatalog): void {
        this.catalog = catalog;
        this.dirty = false;
    }

    public update(transform: (catalog: ScenarioCatalog) => ScenarioCatalog): boolean {
        if (!this.catalog) {
            return false;
        }
        this.replace(transform(this.catalog));
        return true;
    }

    public invalidate(): void {
        this.dirty = true;
    }
}
```

- [x] **Step 4: Run focused and full checks**

```bash
npm run compile-tests
node --test out/test/lazyScenarioCatalog.test.js
npm run check
```

Expected: 4 lazy-state tests pass and the full gate exits 0.

- [x] **Step 5: Commit the lazy holder**

```bash
git add src/lazyScenarioCatalog.ts test/lazyScenarioCatalog.test.ts
git commit -m "feat: add lazy scenario catalog state"
```

---

### Task 3: Make the workspace scanner preserve every definition

**Files:**
- Modify: `src/workspaceScanner.ts:186-405`
- Modify: `src/scenarioCreator.ts:850-900,2050-2110`
- Test: `test/scenarioCatalog.test.ts`

**Interfaces:**
- Consumes: `buildScenarioCatalog` and `ScenarioCatalog` from Task 1.
- Produces: `readScenarioInfo(fileUri, scanRootUri)` and `scanWorkspaceForScenarioCatalog(workspaceRootUri, token)`; preserves `scanWorkspaceForTests` as an adapter.

- [x] **Step 1: Extend the catalog test to model the measured corpus counts**

Append a synthetic cardinality test that creates 1,878 unique names and seven second definitions:

```ts
test('keeps 1885 definitions in 1878 name buckets', () => {
    const entries = Array.from({ length: 1878 }, (_, index) =>
        scenario(`Scenario ${index}`, `base/${index}`, `file:///base/${index}/scen.yaml`)
    );
    for (let index = 0; index < 7; index += 1) {
        entries.push(scenario(`Scenario ${index}`, `duplicate/${index}`, `file:///duplicate/${index}/scen.yaml`));
    }
    const catalog = buildScenarioCatalog(entries);
    assert.equal(catalog.all.length, 1885);
    assert.equal(catalog.byName.size, 1878);
    assert.equal([...catalog.byName.values()].filter(items => items.length > 1).length, 7);
});
```

- [x] **Step 2: Run the focused test as a baseline**

Run `npm run compile-tests && node --test out/test/scenarioCatalog.test.js` and confirm the new cardinality test passes against the catalog while the workspace scanner still returns only a map.

- [x] **Step 3: Extract one-file parsing and add the catalog scanner**

Move the current per-file loop body from `scanWorkspaceForTests` into a private `readScenarioDefinitions(fileUris: readonly vscode.Uri[], scanRootUri: vscode.Uri, token?: vscode.CancellationToken): Promise<TestInfo[]>` helper. Initialize `const definitions: TestInfo[] = []`, iterate the supplied `fileUris`, retain the current cancellation/read/parse error behavior, replace `discoveredTests.set(name, testInfo)` with `definitions.push(testInfo)`, remove the obsolete `discoveredTests.has(name)` branch, and return `definitions`. Keep the current name, UID, code, parameters, nested-scenario, KOT metadata, and relative-path parsing statements unchanged.

```ts
export async function readScenarioInfo(
    fileUri: vscode.Uri,
    scanRootUri: vscode.Uri
): Promise<TestInfo | null> {
    return (await readScenarioDefinitions([fileUri], scanRootUri))[0] || null;
}
```

Replace the map write in the full scan with collection and one summary:

```ts
export async function scanWorkspaceForScenarioCatalog(
    workspaceRootUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<ScenarioCatalog> {
    const startedAt = Date.now();
    const scanRootUri = vscode.Uri.file(resolveScanDirFsPath(workspaceRootUri));
    const definitions: TestInfo[] = [];
    for (const fileUri of await findScenarioDescriptorUris(workspaceRootUri, token)) {
        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        try {
            const scenario = await readScenarioInfo(fileUri, scanRootUri);
            if (scenario) {
                definitions.push(scenario);
            }
        } catch (error) {
            console.warn(`[WorkspaceScanner] Failed to parse ${fileUri.fsPath}:`, error);
        }
    }
    const catalog = buildScenarioCatalog(definitions);
    const duplicateNames = [...catalog.byName.values()].filter(items => items.length > 1).length;
    console.log(`[WorkspaceScanner] Scanned ${definitions.length} definitions, ${catalog.byName.size} names, ${duplicateNames} duplicate names in ${Date.now() - startedAt} ms.`);
    return catalog;
}

export async function scanWorkspaceForTests(
    workspaceRootUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<Map<string, TestInfo> | null> {
    const catalog = await scanWorkspaceForScenarioCatalog(workspaceRootUri, token);
    return new Map(catalog.primaryByName);
}
```

- [x] **Step 4: Migrate direct scanner calls in scenario creation**

Use `scanWorkspaceForScenarioCatalog` in `scenarioCreator.ts`. Build uniqueness sets from `catalog.all` so codes and groups from duplicate-name files are not lost:

```ts
const catalog = await scanWorkspaceForScenarioCatalog(workspaceRootUri);
for (const scenario of catalog.all) {
    index.names.add(normalizeScenarioName(scenario.name));
    if (scenario.scenarioCode) {
        index.codes.add(normalizeScenarioCode(scenario.scenarioCode));
    }
}
```

- [x] **Step 5: Run scanner compatibility checks**

```bash
npm run check
npm run vscode:prepublish
```

Expected: strict types, lint, tests, and bundle exit 0.

- [x] **Step 6: Commit scanner migration**

```bash
git add src/workspaceScanner.ts src/scenarioCreator.ts test/scenarioCatalog.test.ts
git commit -m "refactor: preserve all scanned scenarios"
```

---

### Task 4: Integrate lazy loading into PhaseSwitcher and activation

**Files:**
- Modify: `src/phaseSwitcher.ts:430-575,1510-1690,1750-1930,7000-7140`
- Modify: `src/extension.ts:660-805`
- Modify: `src/completionProvider.ts:590-625,850-900`

**Interfaces:**
- Consumes: `LazyScenarioCatalog`, `ScenarioCatalog`, scanner APIs, and incremental catalog helpers.
- Produces: `getScenarioCatalog`, `getScenarioDefinitions`, `ensureFreshScenarioCatalog`, and `onDidUpdateScenarioCatalog`; keeps `getTestCache`, `initializeTestCache`, and `onDidUpdateTestCache` operational.

- [x] **Step 1: Add provider catalog state and publication**

Import the catalog APIs and construct one lazy store in `PhaseSwitcherProvider`. Keep one compatibility map that is rebuilt only on publication:

```ts
private readonly scenarioCatalogState: LazyScenarioCatalog;
private _testCache: Map<string, TestInfo> | null = null;
private readonly _onDidUpdateScenarioCatalog = new vscode.EventEmitter<ScenarioCatalog | null>();
public readonly onDidUpdateScenarioCatalog = this._onDidUpdateScenarioCatalog.event;

private publishScenarioCatalog(catalog: ScenarioCatalog | null): void {
    this._testCache = catalog ? new Map(catalog.primaryByName) : null;
    this._onDidUpdateScenarioCatalog.fire(catalog);
    this._onDidUpdateTestCache.fire(this._testCache);
}

public getScenarioCatalog(): ScenarioCatalog | null {
    return this.scenarioCatalogState.current;
}

public getScenarioDefinitions(name: string): readonly TestInfo[] {
    return this.scenarioCatalogState.current?.byName.get(name) || [];
}

public async ensureFreshScenarioCatalog(): Promise<ScenarioCatalog | null> {
    try {
        const catalog = await this.scenarioCatalogState.ensureLoaded();
        if (this._testCache === null || this._cacheDirty) {
            this.publishScenarioCatalog(catalog);
        }
        this._cacheDirty = false;
        return catalog;
    } catch (error) {
        this._cacheDirty = true;
        console.error('[PhaseSwitcherProvider] Scenario catalog scan failed:', error);
        return null;
    }
}
```

Initialize `scenarioCatalogState` in the constructor with `scanWorkspaceForScenarioCatalog` and the current workspace folder. Throw a descriptive error when no workspace is open; `ensureFreshScenarioCatalog` converts it to the existing unavailable state.

- [x] **Step 2: Preserve compatibility methods without a second scan mechanism**

Make `initializeTestCache()` and `ensureFreshTestCache()` delegate to `ensureFreshScenarioCatalog()`:

```ts
public async initializeTestCache(): Promise<void> {
    await this.ensureFreshScenarioCatalog();
}

public async ensureFreshTestCache(): Promise<void> {
    await this.ensureFreshScenarioCatalog();
}
```

Replace assignments from full scans with `scenarioCatalogState.replace(catalog)` followed by `publishScenarioCatalog(catalog)`. Replace invalidation assignments with `scenarioCatalogState.invalidate()` and `publishScenarioCatalog(null)` only when the active scan root becomes invalid.

- [x] **Step 3: Keep watchers passive before first use**

Update the save/create/delete/rename handlers to call `scenarioCatalogState.update`. For create and rename, await `readScenarioInfo`; for delete remove by URI. If `update` returns false, do nothing because the catalog has not been requested. If parsing a loaded catalog fails, call `invalidate()` without starting a scan.

Use these exact transformations:

```ts
this.scenarioCatalogState.update(catalog => upsertScenarioInCatalog(catalog, updatedInfo));
this.scenarioCatalogState.update(catalog => removeScenarioFromCatalogByUri(catalog, uri.toString()));
```

After a successful update, call `publishScenarioCatalog(this.scenarioCatalogState.current)`. Scan-root, workspace-folder, and Git HEAD events call only `invalidate()` unless a visible Test Manager immediately invokes `_sendInitialState` as an active consumer.

- [x] **Step 4: Remove eager activation and add completion demand loading**

Delete the complete eager-initialization statement in `activate()`—the call to `phaseSwitcherProvider.initializeTestCache()` together with its `.catch` handler—so provider construction is followed directly by language-provider registration.

Extend the completion constructor:

```ts
private scenarioCompletionsInitialized = false;
private readonly ensureScenarioCatalogLoaded?: () => Promise<void>;

constructor(
    context: vscode.ExtensionContext,
    ensureScenarioCatalogLoaded?: () => Promise<void>
) {
    this.context = context;
    this.ensureScenarioCatalogLoaded = ensureScenarioCatalogLoaded;
}
```

Keep the existing document-close subscription, Gherkin loader call, error notification, and initialization log after these assignments.

Inside `provideCompletionItems`, after confirming the cursor is in a scenario text block and before building scenario items, load once:

```ts
if (!this.scenarioCompletionsInitialized && this.ensureScenarioCatalogLoaded) {
    await this.ensureScenarioCatalogLoaded();
    this.scenarioCompletionsInitialized = true;
}
```

Construct the provider in `extension.ts` with an async callback to `ensureFreshScenarioCatalog`. Reset the completion initialization flag when the scan root changes or the catalog event publishes `null`.

- [x] **Step 5: Verify lazy integration**

```bash
npm run check
npm run vscode:prepublish
rg -n "initializeTestCache\(\)" src/extension.ts
```

Expected: quality/build gates exit 0 and `rg` finds no unconditional activation call near `activate()`; command-specific compatibility calls may remain.

- [x] **Step 6: Commit lazy provider integration**

```bash
git add src/phaseSwitcher.ts src/extension.ts src/completionProvider.ts
git commit -m "perf: load scenario catalog on demand"
```

---

### Task 5: Make duplicate-sensitive editor flows explicit

**Files:**
- Modify: `src/completionProvider.ts:600-715,1015-1085,3100-3145`
- Modify: `src/navigationUtils.ts:1-125`
- Modify: `src/commandHandlers.ts:320-580,1320-1405`
- Modify: `src/hoverProvider.ts:30-45,650-725`
- Modify: `src/scenarioDiagnostics.ts:1-140,850-965,995-1120,1300-1540`
- Modify: `src/extension.ts:775-795`
- Test: `test/scenarioCatalog.test.ts`

**Interfaces:**
- Consumes: complete catalogs and `ScenarioResolution` from Tasks 1 and 4.
- Produces: duplicate entries in completion, interactive disambiguation for navigation, ambiguity hover/diagnostics, and safe refusal in non-interactive metadata updates.

- [x] **Step 1: Change completion entries from name-keyed metadata to definition-keyed metadata**

Replace `scenarioCompletionItems`, `scenarioParametersByName`, and `calledScenarioDefaultsByName` with entries that retain their source definition:

```ts
interface ScenarioCompletionEntry {
    item: vscode.CompletionItem;
    scenario: TestInfo;
}

private scenarioCompletionEntries: ScenarioCompletionEntry[] = [];

public updateScenarioCompletions(catalog: ScenarioCatalog | null): void {
    this.scenarioCompletionEntries = [];
    for (const scenario of catalog?.all || []) {
        const duplicateCount = catalog?.byName.get(scenario.name)?.length || 0;
        const label: vscode.CompletionItemLabel | string = duplicateCount > 1
            ? { label: scenario.name, description: scenario.relativePath }
            : scenario.name;
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);
        item.filterText = scenario.name;
        item.insertText = scenario.name;
        item.detail = duplicateCount > 1
            ? vscode.l10n.t('Nested scenario (1C) — {0}', scenario.relativePath)
            : vscode.l10n.t('Nested scenario (1C)');
        this.scenarioCompletionEntries.push({ item, scenario });
    }
}
```

Iterate these entries in `provideCompletionItems` and replace the current insert-text call with:

```ts
completionItem.insertText = this.buildScenarioCallInsertText(
    entry.scenario,
    scenarioCallBaseIndent,
    scenarioCallFirstLinePrefix,
    scenarioParameterDefaults,
    scenarioCallKeyword
);
```

Change the first parameter of `buildScenarioCallInsertText` from `scenarioName: string` to `scenario: TestInfo`. Define `const scenarioName = scenario.name`, read `const params = scenario.parameters || []`, and build the defaults map from `scenario.parameterDefaults` inside that method. This removes both name-keyed metadata maps, so duplicated definitions never share parameter data.

- [x] **Step 2: Make navigation choose among duplicate definitions**

Change `findFileByName` to accept `ScenarioCatalog | null`. Resolve cached results first and show a QuickPick only for ambiguity:

```ts
async function pickScenarioDefinition(
    name: string,
    definitions: readonly TestInfo[]
): Promise<TestInfo | undefined> {
    return vscode.window.showQuickPick(
        definitions.map(scenario => ({
            label: scenario.relativePath || scenario.name,
            description: scenario.scenarioCode || scenario.uid,
            detail: scenario.yamlFileUri.fsPath,
            scenario
        })),
        { title: vscode.l10n.t('Multiple scenarios named "{0}"', name), ignoreFocusOut: true }
    ).then(item => item?.scenario);
}
```

If no catalog is supplied, call `scanWorkspaceForScenarioCatalog` once and resolve from it. Update navigation call sites to await `phaseSwitcherProvider.ensureFreshScenarioCatalog()` and pass `getScenarioCatalog()`. A cancelled picker returns `null` and does not show a misleading not-found message.

- [x] **Step 3: Stop non-interactive metadata rewrites on ambiguity**

Change `clearAndFillNestedScenarios` to accept `ScenarioCatalog | null`. For each called name, switch on `resolveScenarioByName`. Add the unique definition normally; collect ambiguous paths and return `false` before editing when any ambiguity exists:

```ts
const ambiguousCalls: string[] = [];
const resolution = resolveScenarioByName(catalog, calledName);
if (resolution.kind === 'ambiguous') {
    ambiguousCalls.push(`${calledName}: ${resolution.scenarios.map(item => item.relativePath).join(', ')}`);
    continue;
}
if (resolution.kind === 'unique') {
    scenariosToAdd.push({ name: calledName, uid: resolution.scenario.uid || '' });
}
```

Show one error containing the collected lines and do not apply a `WorkspaceEdit`. Update all callers in `extension.ts` and `commandHandlers.ts` to pass the catalog.

- [x] **Step 4: Show ambiguity in hover and diagnostics**

Expand the cache-provider interfaces with `getScenarioCatalog` and `ensureFreshScenarioCatalog`. Hover uses all definitions; for duplicates it lists relative paths and keeps the existing open command, which now opens the navigation picker.

Add diagnostic code `kotTestToolkit.ambiguousScenario` and message `Scenario name resolves to multiple files:`. At the start of validation await the catalog, then resolve each call:

```ts
const resolution = catalog
    ? resolveScenarioByName(catalog, block.name)
    : { kind: 'missing' as const, name: block.name };
if (resolution.kind === 'ambiguous') {
    const diagnostic = createDiagnostic(
        document,
        block.line,
        formatMultilineListMessage(this.messages.ambiguousScenario, resolution.scenarios.map(item => item.relativePath)),
        vscode.DiagnosticSeverity.Error,
        CODE_AMBIGUOUS_SCENARIO
    );
    diagnostic.relatedInformation = resolution.scenarios.map(item => new vscode.DiagnosticRelatedInformation(
        new vscode.Location(item.yamlFileUri, new vscode.Position(0, 0)),
        item.relativePath
    ));
    diagnostics.push(diagnostic);
    continue;
}
const scenarioInfo = resolution.kind === 'unique' ? resolution.scenario : undefined;
```

Build duplicate-code diagnostics from `catalog.all`. In the dependency graph, retain every `scenarioNameByUri` entry, but create a callee edge only when `resolveScenarioByName` is unique; ambiguous calls already have their own diagnostic and must not create a false edge.

- [x] **Step 5: Update catalog events and run editor-flow checks**

Subscribe completion to `onDidUpdateScenarioCatalog`; retain the old map event for consumers not migrated in this task. Run:

```bash
npm run check
npm run vscode:prepublish
```

Expected: all tests, strict types, zero-warning lint, and production bundle exit 0.

- [x] **Step 6: Commit duplicate-aware editor behavior**

```bash
git add src/completionProvider.ts src/navigationUtils.ts src/commandHandlers.ts src/hoverProvider.ts src/scenarioDiagnostics.ts src/extension.ts test/scenarioCatalog.test.ts
git commit -m "fix: surface ambiguous scenario definitions"
```

---

### Task 6: Verify the real corpus and record migration boundaries

**Files:**
- Modify: `docs/superpowers/plans/2026-09-13-scenario-catalog.md`

**Interfaces:**
- Consumes: the completed catalog, scanner, lazy provider, and editor integrations.
- Produces: fresh verification evidence and an explicit boundary for the next optimization increment.

- [ ] **Step 1: Run all automated gates**

```bash
npm run check
npm run vscode:prepublish
npm audit --omit=dev
git diff --check main
```

Expected: 0 failed tests, 0 TypeScript diagnostics, 0 lint warnings, successful production bundle, 0 production vulnerabilities, and no whitespace errors.

- [ ] **Step 2: Probe the corpus read-only**

Run a temporary Node probe that reads every `*scen.yaml`, builds `{name, path}` records, and prints only aggregate counts. Expected JSON:

```json
{
  "files": 1885,
  "definitions": 1885,
  "uniqueNames": 1878,
  "duplicateNames": 7,
  "lostDefinitions": 0
}
```

Run:

```bash
git -C /Users/alexeremeev/Development/1cDrive status --short -- tests/RegressionTests/Yaml/Drive
```

Expected: the pre-existing modified `Service/000015110/scen.yaml` and untracked `Parent scenarios/test/` may remain; this branch must not add or alter corpus paths.

- [ ] **Step 3: Inspect migration boundaries**

```bash
rg -n "scanWorkspaceForTests\(" src
rg -n "getTestCache\(\).*\.get|_testCache\.get" src
git diff --stat main
git status --short --branch
```

The compatibility scanner may exist only as its exported adapter. Remaining `getTestCache` usages must be PhaseSwitcher flows where deterministic primary selection is explicitly accepted by the spec. The branch worktree must contain no uncommitted files.

- [ ] **Step 4: Record verification evidence and deferred identity migration**

Append the actual command results to this document. Record that build artifact maps, persisted Test Manager selection state, and PhaseSwitcher main-scenario identity remain name-keyed and are the next catalog migration target.

- [ ] **Step 5: Commit verification notes**

```bash
git add docs/superpowers/plans/2026-09-13-scenario-catalog.md
git commit -m "docs: record scenario catalog verification"
```
