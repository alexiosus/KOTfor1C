# Scenario Catalog and Lazy Indexing Design

## Context

The extension currently represents discovered scenarios as `Map<string, TestInfo>`. The scenario name is the only key, so a later file silently replaces an earlier file with the same name. A read-only scan of the 1C:Drive corpus found 1,885 named scenario files, 1,878 unique names, and 7 duplicated names across 14 files. The current cache therefore loses seven valid definitions.

The same map is also initialized eagerly from `activate()`. That reads and parses the complete scenario corpus before the user opens Test Manager, requests scenario completion, navigates to a scenario, or runs diagnostics. Save handling already performs some incremental updates, but create, delete, rename, scan-root, workspace, and Git branch changes schedule another complete scan.

## Goal

Preserve every scenario definition, make ambiguity visible instead of silently selecting a file, and defer the initial corpus scan until a feature that needs scenario data is used.

## Non-goals

- Do not change the YAML scenario format or add path information to scenario call text.
- Do not migrate YAML editing to a CST library in this increment.
- Do not split the large PhaseSwitcher or completion modules beyond extracting the catalog boundary.
- Do not redesign build artifact identity or Test Manager selection persistence.
- Do not write to the external 1C:Drive corpus.

## Considered Approaches

### 1. Lazy-load the existing map

This is the smallest performance change, but duplicated definitions remain lost and later work would need another cache migration. It is rejected because it preserves a demonstrated correctness defect.

### 2. Replace every map consumer at once

This produces the cleanest final architecture but changes dozens of call sites, diagnostics, completion, Test Manager, build selection, and navigation in one high-risk change. It is rejected for this increment.

### 3. Add a duplicate-aware catalog with a compatibility view

This is the selected approach. The scanner produces one catalog containing all definitions. New duplicate-sensitive flows consume the catalog directly, while existing PhaseSwitcher flows temporarily use a deterministic `primaryByName` view. This removes scan-order nondeterminism and creates a controlled migration boundary without forcing an all-at-once rewrite.

## Catalog Model

Create a pure `src/scenarioCatalog.ts` module with these public contracts:

```ts
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

export function buildScenarioCatalog(scenarios: readonly TestInfo[]): ScenarioCatalog;
export function resolveScenarioByName(catalog: ScenarioCatalog, name: string): ScenarioResolution;
export function upsertScenarioInCatalog(catalog: ScenarioCatalog, scenario: TestInfo): ScenarioCatalog;
export function removeScenarioFromCatalogByUri(catalog: ScenarioCatalog, uriKey: string): ScenarioCatalog;
```

`buildScenarioCatalog` sorts definitions by normalized `relativePath`, then by URI. `primaryByName` uses the first item in that stable order only as a compatibility view. Duplicate-aware consumers must use `byName` or `resolveScenarioByName`; they must not infer uniqueness from `primaryByName`.

URI keys use `yamlFileUri.toString()`. Scenario names remain exact and case-sensitive to preserve current behavior. Empty names are never indexed.

Create `src/lazyScenarioCatalog.ts` as a small state holder around an injected loader:

```ts
export class LazyScenarioCatalog {
    public constructor(loader: () => Promise<ScenarioCatalog>);
    public get current(): ScenarioCatalog | null;
    public get isDirty(): boolean;
    public ensureLoaded(): Promise<ScenarioCatalog>;
    public replace(catalog: ScenarioCatalog): void;
    public update(transform: (catalog: ScenarioCatalog) => ScenarioCatalog): boolean;
    public invalidate(): void;
}
```

`ensureLoaded` returns the current clean catalog immediately, coalesces concurrent loads through one in-flight promise, and publishes only a complete successful result. A rejected load clears the in-flight promise, keeps the state dirty, and can be retried. `invalidate` never starts loading. `update` returns `false` without invoking the transform when no catalog has been loaded, which lets file watchers remain passive before first use.

## Scanner and Provider Integration

`workspaceScanner.ts` will expose `readScenarioInfo(fileUri, scanRootUri)` for one descriptor and `scanWorkspaceForScenarioCatalog(workspaceRootUri, token)` for a full scan. The full scanner calls the same one-file function for every descriptor, collects every `TestInfo`, and calls `buildScenarioCatalog`. The existing `scanWorkspaceForTests` remains temporarily as a compatibility adapter returning a copied `Map` from `catalog.primaryByName`; new code must not call it.

`PhaseSwitcherProvider` owns one `LazyScenarioCatalog` and exposes:

```ts
public getScenarioCatalog(): ScenarioCatalog | null;
public getScenarioDefinitions(name: string): readonly TestInfo[];
public async ensureFreshScenarioCatalog(): Promise<ScenarioCatalog | null>;
```

`getTestCache()` remains during migration and returns a cached copied `Map` of the catalog's `primaryByName`. That compatibility map is rebuilt only when a new catalog is published, so repeated reads do not allocate and existing internal PhaseSwitcher loops remain unchanged. Existing cache update events remain available for current consumers. A new catalog event provides the complete model to completion and diagnostics. Consumers receive read-only catalog structures and must not mutate them.

`LazyScenarioCatalog` replaces the existing initialization promise as the single coalescing mechanism. Failed scans leave the catalog unavailable and dirty so a later explicit request can retry. Cancellation rejects the load and publishes no partial catalog.

## Lazy Loading

Remove the unconditional `initializeTestCache()` call from `activate()`.

The first of these operations starts one shared scan:

- Test Manager becomes visible.
- Completion is requested inside a YAML scenario body and scenario completions have not been initialized.
- A navigation, refactoring, build, or diagnostics operation explicitly calls `ensureFreshScenarioCatalog()`.

Opening unrelated YAML/feature files, activating the extension, or loading Gherkin step definitions does not scan scenario files. `DriveCompletionProvider` receives an async `ensureScenarioCatalogLoaded` callback and invokes it only after confirming the cursor is inside a supported scenario-text block. The callback is awaited so the first relevant completion request includes scenario items.

Save updates use `readScenarioInfo` for closed files or the existing document parser for open files, followed by `upsertScenarioInCatalog`. Create parses only matching new descriptors, delete uses `removeScenarioFromCatalogByUri`, and rename removes the old URI before parsing the new URI. A failed incremental parse marks the loaded catalog dirty. No watcher triggers an initial scan when the catalog has never been loaded. Scan-root, workspace-folder, and Git branch changes invalidate the catalog and wait for the next demand instead of immediately rescanning.

## Ambiguity Behavior

Interactive navigation must never choose a duplicated name silently. For `ambiguous` resolution it shows a QuickPick containing relative path and scenario code/UID when present. Cancellation leaves the editor unchanged.

Diagnostics report an ambiguous scenario reference separately from a missing reference and attach all candidate file locations as related information. Non-interactive metadata/refactoring operations stop for that scenario and show a message listing candidate paths; they do not rewrite YAML using an arbitrary definition.

Completion emits one item per definition for duplicated names. Each duplicate item displays its relative path and uses that definition's parameters/defaults while inserting the unchanged scenario name. Unique names retain the current presentation. This does not change the runtime KOT call syntax; it only prevents the editor from hiding which definition supplied metadata.

Existing PhaseSwitcher main-scenario operations continue through `primaryByName` in this increment. Because that view is path-sorted, its behavior is deterministic. Migrating build artifacts and persisted selection identity from name to URI is deferred and documented as the next catalog migration step.

## Performance and Observability

The scanner records elapsed time, total files, total definitions, unique names, and duplicate-name count in one summary log entry. Per-file success logs remain disabled.

The catalog is immutable from the perspective of consumers. Incremental helpers return a new catalog, making event payloads and tests deterministic and preventing consumers from mutating shared indexes.

No persistent on-disk cache is introduced. The corpus is small enough for one demand-driven in-memory scan, and avoiding invalidation/versioning logic keeps this increment focused.

## Testing

Pure Node tests cover:

- all 1,885 synthetic-equivalent entries remain in `all` while duplicate names share one `byName` bucket;
- stable primary selection is independent of scanner input order;
- unique, missing, and ambiguous resolution results;
- upsert removes the previous definition for the same URI before inserting its replacement;
- removal preserves other definitions with the same name;
- concurrent lazy requests invoke the injected loader once;
- invalidation does not load until a subsequent `ensure` call;
- a failed load can be retried.

Type checking and the production bundle validate VS Code integration. A read-only corpus probe must report 1,885 definitions, 1,878 names, and 7 duplicate-name buckets. The existing `npm run check`, `npm run vscode:prepublish`, `npm audit --omit=dev`, and `git diff --check` gates remain mandatory.

## Rollout and Compatibility

The change stays in `codex/reliability-foundation`. Public VS Code commands and settings remain unchanged. The compatibility map prevents an immediate rewrite of unrelated PhaseSwitcher behavior, while new catalog APIs make accidental use of a single duplicate definition explicit.

If the catalog scan fails, existing UI shows the current scan error state and completion continues with Gherkin steps only. No partially parsed catalog is published.

## Acceptance Criteria

- Extension activation does not enumerate or parse scenario files.
- The first scenario-data consumer performs one coalesced scan.
- The 1C:Drive corpus produces 1,885 definitions, 1,878 unique names, and 7 duplicate buckets without losing a file.
- Duplicate-aware navigation, diagnostics, metadata operations, and completion do not silently select a definition.
- Existing PhaseSwitcher behavior remains available through a deterministic compatibility map.
- Save, create, delete, rename, scan-root, workspace, and Git branch changes cannot trigger an eager scan before first use.
- All unit, type, lint, production build, audit, and diff checks pass.
