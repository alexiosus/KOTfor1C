# Versioned Vanessa Step Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicate runtime `steps.htm` loading with one cache-first service that selects an immutable built-in step catalog for the exact Vanessa Automation version used by each workspace folder, with catalogs generated and published by GitHub Actions.

**Architecture:** A pure catalog contract and validator sits between all producers and consumers. A folder-scoped runtime service resolves Vanessa versions, reads immutable local cache entries, starts bounded background downloads, and falls back to one shared legacy HTML adapter. A separate Node CLI converts Vanessa's official four-column `Template.xml` into deterministic JSON and publishes append-only assets to the `step-catalogs` branch.

**Tech Stack:** TypeScript 5.8, Node.js 20 APIs, VS Code 1.98 extension API, `node-html-parser` for the temporary HTML fallback and spreadsheet XML parsing, esbuild, Node test runner, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-23-versioned-vanessa-step-catalog-design.md`

## Global Constraints

- Keep `res/steps.htm` as first-run offline and compatibility fallback; do not remove it in this change.
- Do not launch 1C, unpack EPFs, download Vanessa source, or invoke MCP/AI from the Extension Host.
- Do not parse user libraries or exported scenarios.
- Never choose the latest or nearest catalog when the exact four-component Vanessa version is missing.
- Keep exact catalogs immutable and namespace disk cache entries by normalized catalog-index URL hash and Vanessa version.
- Completion, hover, and diagnostics must share one service and one prepared state per catalog identity.
- Activation must not force a refresh, wait for network I/O, or display a warning for an automatic background failure.
- Preserve current matching, semantic ranking, snippet insertion, hover text, and unknown-step behavior.
- Published-branch commits use `Alexey Eremeev <48015759+alexiosus@users.noreply.github.com>`.
- Generated catalog publishing must be append-only and leave the existing index untouched on generation failure.

## Review Focus

- Windows absolute paths, UNC paths, BOM, and CRLF in `Changelog.md` must still resolve the exact version; pinned by Task 2 tests.
- A slow or unavailable network on first launch must return bundled definitions without blocking activation; pinned by Task 4 tests.
- Invalid hashes, version mismatches, oversized responses, unsafe relative paths, and HTTPS downgrade redirects must preserve the last valid cache; pinned by Task 3 tests.
- Two workspace folders on different Vanessa versions must not share prepared definitions, while equal versions should share them; pinned by Task 5 tests.
- Upstream `Template.xml` namespace or cell-shape drift must fail generation before any publication changes; pinned by Task 6 tests.

---

### Task 1: Catalog Contract and Legacy HTML Adapter

**Files:**
- Create: `src/stepCatalog.ts`
- Create: `src/legacyStepCatalog.ts`
- Create: `test/stepCatalog.test.ts`
- Create: `test/legacyStepCatalog.test.ts`

**Interfaces:**
- Consumes: current `res/steps.htm` four-column row format.
- Produces: `BuiltInStepCatalog`, `BuiltInStepDefinition`, `StepCatalogIndex`, `ResolvedStepCatalog`, `parseBuiltInStepCatalog()`, `parseStepCatalogIndex()`, `createStepDefinitionId()`, and `parseLegacyStepsHtml()`.

- [ ] **Step 1: Write failing catalog validation tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createStepDefinitionId,
    parseBuiltInStepCatalog,
    parseStepCatalogIndex
} from '../src/stepCatalog';

const validCatalog = {
    schemaVersion: 1,
    vanessaVersion: '1.2.043.28',
    generatedAt: '2026-09-22T00:00:00.000Z',
    source: {
        repository: 'Pr-Mex/vanessa-automation',
        ref: '1.2.043.28',
        commit: '0123456789abcdef0123456789abcdef01234567'
    },
    steps: [{
        id: createStepDefinitionId('И пауза 1', 'And 1 second pause'),
        ru: { pattern: 'И пауза 1', description: 'Пауза' },
        en: { pattern: 'And 1 second pause', description: 'Pause' }
    }]
};

test('catalog parser rejects a requested-version mismatch', () => {
    assert.throws(
        () => parseBuiltInStepCatalog(validCatalog, '1.2.043.27'),
        /expected 1\.2\.043\.27/
    );
});

test('catalog parser rejects duplicate language patterns', () => {
    assert.throws(
        () => parseBuiltInStepCatalog({
            ...validCatalog,
            steps: [...validCatalog.steps, { ...validCatalog.steps[0], id: 'different-id' }]
        }),
        /duplicate Russian pattern/
    );
});

test('index parser accepts only safe relative catalog paths', () => {
    assert.throws(() => parseStepCatalogIndex({
        schemaVersion: 1,
        generatedAt: validCatalog.generatedAt,
        catalogs: {
            '1.2.043.28': {
                path: '../catalog.json',
                sha256: 'a'.repeat(64),
                stepCount: 1,
                sourceCommit: validCatalog.source.commit
            }
        }
    }), /relative path/);
});
```

- [ ] **Step 2: Run the catalog test and verify the missing-module failure**

Run: `npm run compile-tests && node --test out/test/stepCatalog.test.js`

Expected: FAIL because `src/stepCatalog.ts` does not exist.

- [ ] **Step 3: Implement the pure catalog contract and validators**

```ts
export interface StepTextVariant {
    readonly pattern: string;
    readonly description: string;
}

export interface BuiltInStepDefinition {
    readonly id: string;
    readonly ru?: StepTextVariant;
    readonly en?: StepTextVariant;
}

export interface BuiltInStepCatalog {
    readonly schemaVersion: 1;
    readonly vanessaVersion: string;
    readonly generatedAt: string;
    readonly source: {
        readonly repository: 'Pr-Mex/vanessa-automation';
        readonly ref: string;
        readonly commit: string;
    };
    readonly steps: readonly BuiltInStepDefinition[];
}

export type ResolvedStepCatalogSource =
    | 'versioned-cache'
    | 'versioned-download'
    | 'custom-html'
    | 'bundled-html';

export interface ResolvedStepCatalog {
    readonly identity: string;
    readonly requestedVersion?: string;
    readonly catalogVersion: string;
    readonly source: ResolvedStepCatalogSource;
    readonly steps: readonly BuiltInStepDefinition[];
}
```

Use `node:crypto` SHA-256 over `${normalizedRu}\0${normalizedEn}` for `id`. Validate ISO timestamps, exact `X.Y.Z.W` versions, 40-character lowercase commit SHA values, 64-character lowercase content hashes, non-empty patterns, at least one variant per step, duplicate IDs, duplicate language patterns, and paths that are relative, slash-separated, and contain no empty, `.` or `..` segment.

- [ ] **Step 4: Write failing full-fallback adapter tests**

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseLegacyStepsHtml } from '../src/legacyStepCatalog';

test('bundled steps HTML converts all 1177 rows into paired definitions', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'res', 'steps.htm'), 'utf8');
    const steps = parseLegacyStepsHtml(html);
    assert.equal(steps.length, 1177);
    assert.ok(steps.some(step => step.ru?.pattern && step.en?.pattern));
});

test('legacy adapter rejects an HTML document without valid step rows', () => {
    assert.throws(() => parseLegacyStepsHtml('<html><body>empty</body></html>'), /step rows/);
});
```

- [ ] **Step 5: Implement `parseLegacyStepsHtml()` as the sole HTML parser**

Parse `tr` elements whose class starts with `R`, require at least four cells, normalize CRLF to LF, preserve meaningful embedded table/block text, construct RU/EN variants, skip only rows with both patterns empty, and reject the document when no valid row remains. Do not put version resolution, file access, HTTP, or VS Code calls in this module.

- [ ] **Step 6: Run tests and commit the contract**

Run: `npm run compile-tests && node --test out/test/stepCatalog.test.js out/test/legacyStepCatalog.test.js`

Expected: PASS with 1,177 converted legacy definitions.

```bash
git add src/stepCatalog.ts src/legacyStepCatalog.ts test/stepCatalog.test.ts test/legacyStepCatalog.test.ts
git commit -m "refactor: add shared step catalog contract"
```

### Task 2: Folder-scoped Vanessa Version Resolution

**Files:**
- Create: `src/vanessaVersion.ts`
- Create: `test/vanessaVersion.test.ts`
- Modify: `src/phaseSwitcher.ts:9098`

**Interfaces:**
- Consumes: folder-scoped `kotTestToolkit.steps.vanessaVersion`, `kotTestToolkit.runVanessa.vanessaEpfPath`, workspace root path, and changelog contents/stat metadata.
- Produces: `normalizeVanessaVersion()`, `extractVanessaVersionFromChangelog()`, `resolveWorkspaceSettingPath()`, `getVanessaChangelogPath()`, and `VanessaVersionCacheKey`.

- [ ] **Step 1: Write failing version and path tests, including Review Focus cases**

```ts
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    extractVanessaVersionFromChangelog,
    normalizeVanessaVersion,
    resolveWorkspaceSettingPath
} from '../src/vanessaVersion';

test('extracts the first four-part version from BOM and CRLF changelog text', () => {
    assert.equal(
        extractVanessaVersionFromChangelog('\uFEFF# История\r\n\r\n## 1.2.043.28\r\n## 1.2.043.27'),
        '1.2.043.28'
    );
});

test('rejects a three-part override instead of guessing', () => {
    assert.equal(normalizeVanessaVersion('1.2.43'), null);
});

test('keeps Windows drive and UNC paths absolute under win32 rules', () => {
    assert.equal(
        resolveWorkspaceSettingPath('C:\\tools\\vanessa\\vanessa-automation.epf', 'C:\\project', path.win32),
        'C:\\tools\\vanessa\\vanessa-automation.epf'
    );
    assert.equal(
        resolveWorkspaceSettingPath('\\\\server\\share\\vanessa.epf', 'C:\\project', path.win32),
        '\\\\server\\share\\vanessa.epf'
    );
});
```

- [ ] **Step 2: Run the version test and verify it fails**

Run: `npm run compile-tests && node --test out/test/vanessaVersion.test.js`

Expected: FAIL because the version helpers do not exist.

- [ ] **Step 3: Implement strict, platform-injectable path and version helpers**

```ts
export interface PathOperations {
    isAbsolute(value: string): boolean;
    join(...parts: string[]): string;
    dirname(value: string): string;
    normalize(value: string): string;
}

export function normalizeVanessaVersion(value: string): string | null {
    const normalized = value.trim().replace(/^v/i, '');
    return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

export function extractVanessaVersionFromChangelog(source: string): string | null {
    for (const line of source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
        const match = line.match(/^\s*##\s+v?(\d+\.\d+\.\d+\.\d+)\s*$/i);
        if (match) {
            return match[1];
        }
    }
    return null;
}
```

`getVanessaChangelogPath()` returns `<dirname(epf)>/docs/Changelog.md`. `VanessaVersionCacheKey` contains workspace URI, normalized EPF path, override, changelog modification time, and changelog size so a replaced file invalidates the value.

- [ ] **Step 4: Make the Vanessa launcher delegate to the same path helper**

Replace the body of `PhaseSwitcherProvider.resolvePathFromWorkspaceSetting()` with `resolveWorkspaceSettingPath(rawPath, workspaceRootPath, path)`. This prevents catalog detection and launch from disagreeing on relative/absolute paths.

- [ ] **Step 5: Run focused checks and commit**

Run: `npm run compile-tests && node --test out/test/vanessaVersion.test.js`

Run: `npm run check:types`

Expected: both PASS.

```bash
git add src/vanessaVersion.ts src/phaseSwitcher.ts test/vanessaVersion.test.ts
git commit -m "feat: resolve project Vanessa versions"
```

### Task 3: Immutable Catalog HTTP Client and Cache Core

**Files:**
- Create: `src/stepCatalogClient.ts`
- Create: `src/stepCatalogHttp.ts`
- Create: `test/stepCatalogClient.test.ts`
- Create: `test/stepCatalogHttp.test.ts`

**Interfaces:**
- Consumes: validated catalog/index contract from Task 1.
- Produces: `StepCatalogStorage`, `StepCatalogTransport`, `VersionedStepCatalogClient.getExactCatalog()`, `VersionedStepCatalogClient.refreshExactCatalog()`, and `fetchHttpsBytes()`.

- [ ] **Step 1: Write failing client tests with in-memory storage and transport**

```ts
test('returns one shared promise for concurrent exact-version requests', async () => {
    const pending = deferred<StepCatalogHttpResponse>();
    const transport = new FakeTransport([pending.promise]);
    const client = new VersionedStepCatalogClient(memoryStorage(), transport, () => 1_000);
    const first = client.getExactCatalog(INDEX_URL, '1.2.043.28');
    const second = client.getExactCatalog(INDEX_URL, '1.2.043.28');
    assert.equal(first, second);
    pending.resolve(indexResponseFor(CATALOG));
    await Promise.all([first, second]);
});

test('does not fall forward when the exact version is absent', async () => {
    const client = clientWithIndex({ '1.2.043.29': entryFor(CATALOG_29) });
    assert.equal(await client.getExactCatalog(INDEX_URL, '1.2.043.28'), null);
});

test('invalid downloaded hash preserves a valid exact cache', async () => {
    const storage = memoryStorageWithCatalog(CATALOG);
    const client = clientWithStorageAndResponses(storage, [indexResponseWithHash('0'.repeat(64)), catalogResponse(CATALOG)]);
    const result = await client.refreshExactCatalog(INDEX_URL, '1.2.043.28');
    assert.equal(result?.source, 'versioned-cache');
    assert.deepEqual(await storage.read(cacheCatalogPath(INDEX_URL, '1.2.043.28')), CATALOG_BYTES);
});
```

Define the test doubles in the same file so the cases are self-contained:

```ts
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

class FakeTransport implements StepCatalogTransport {
    public calls = 0;
    public constructor(private readonly responses: readonly Promise<StepCatalogHttpResponse>[]) {}
    public get(): Promise<StepCatalogHttpResponse> {
        return this.responses[this.calls++];
    }
}

function memoryStorage(initial: Readonly<Record<string, Uint8Array>> = {}): StepCatalogStorage {
    const files = new Map(Object.entries(initial));
    return {
        read: async key => files.get(key) ?? null,
        writeAtomic: async (key, value) => { files.set(key, value); }
    };
}
```

Build `CATALOG`, `CATALOG_BYTES`, index responses, and cache paths with small local fixture factories that call the real `createStepDefinitionId()` and SHA-256 helper from Task 1; do not hard-code a digest that could disagree with production normalization.

Add explicit cases for an oversized index, oversized catalog, unsafe index path, catalog version mismatch, invalid JSON, offline cache hit, first-run offline miss, and different index URLs using different cache namespaces.

- [ ] **Step 2: Run client tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/stepCatalogClient.test.js`

Expected: FAIL because the client is missing.

- [ ] **Step 3: Implement the injected cache/client state machine**

```ts
export interface StepCatalogStorage {
    read(relativePath: string): Promise<Uint8Array | null>;
    writeAtomic(relativePath: string, bytes: Uint8Array): Promise<void>;
}

export interface StepCatalogTransport {
    get(url: URL, options: {
        readonly signal?: AbortSignal;
        readonly maxBytes: number;
        readonly etag?: string;
    }): Promise<StepCatalogHttpResponse>;
}

export interface StepCatalogHttpResponse {
    readonly status: number;
    readonly body: Uint8Array;
    readonly etag?: string;
}

export interface VersionedCatalogResult {
    readonly catalog: BuiltInStepCatalog;
    readonly source: 'versioned-cache' | 'versioned-download';
    readonly digest: string;
}
```

Use SHA-256 of the normalized index URL as the first cache path segment. Store `index.json`, `index-meta.json`, `<version>/catalog.json`, and `<version>/catalog-meta.json`. Parse and validate cached bytes before returning them. A network, parse, schema, hash, count, path, or version failure returns the valid exact cache when one exists and otherwise returns `null`. Write catalog bytes before metadata through `writeAtomic()`; never delete a valid catalog during refresh.

- [ ] **Step 4: Write failing transport policy tests**

Test pure exported helpers so no external network is needed:

```ts
test('redirect policy rejects an HTTPS to HTTP downgrade', () => {
    assert.throws(
        () => resolveCatalogRedirect(new URL('https://host/index.json'), 'http://host/index.json'),
        /HTTPS/
    );
});

test('response accumulator aborts after the configured byte limit', () => {
    const accumulator = new BoundedResponseAccumulator(4);
    accumulator.append(Buffer.from('1234'));
    assert.throws(() => accumulator.append(Buffer.from('5')), /maximum size/);
});
```

- [ ] **Step 5: Implement bounded HTTPS transport**

`fetchHttpsBytes()` accepts only `https:` URLs, follows at most three redirects, rejects protocol downgrade, drains non-success responses, honors `AbortSignal`, uses a 15-second socket timeout, and destroys the request as soon as accumulated bytes exceed the index or catalog limit. Export `resolveCatalogRedirect()` and `BoundedResponseAccumulator` for direct tests.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm run compile-tests && node --test out/test/stepCatalogClient.test.js out/test/stepCatalogHttp.test.js`

Expected: PASS.

```bash
git add src/stepCatalogClient.ts src/stepCatalogHttp.ts test/stepCatalogClient.test.ts test/stepCatalogHttp.test.ts
git commit -m "feat: add immutable step catalog client"
```

### Task 4: Workspace Catalog Service and Non-blocking Fallback

**Files:**
- Create: `src/stepCatalogService.ts`
- Create: `test/stepCatalogService.test.ts`
- Modify: `src/stepsFetcher.ts`

**Interfaces:**
- Consumes: version helpers, exact catalog client, bundled/custom legacy adapter, VS Code workspace/global storage.
- Produces: `StepCatalogProvider`, `StepCatalogChangeEvent`, `StepCatalogService.getCatalog()`, `StepCatalogService.refresh()`, and `StepCatalogService.onDidChangeCatalog`.

- [ ] **Step 1: Write failing coordinator tests with injected workspace dependencies**

```ts
test('first offline request returns bundled catalog without waiting for remote completion', async () => {
    const remote = deferred<VersionedCatalogResult | null>();
    const coordinator = createCoordinator({
        version: '1.2.043.28',
        bundledHtml: LEGACY_HTML,
        getExactCatalog: () => remote.promise
    });
    const resolved = await coordinator.getCatalog('file:///workspace/test.yaml');
    assert.equal(resolved.source, 'bundled-html');
    assert.equal(resolved.steps.length, 1);
});

test('background exact catalog emits one change after fallback was returned', async () => {
    const remote = deferred<VersionedCatalogResult | null>();
    const coordinator = createCoordinator({ version: '1.2.043.28', bundledHtml: LEGACY_HTML, getExactCatalog: () => remote.promise });
    const events: StepCatalogChangeEvent[] = [];
    coordinator.onDidChangeCatalog(event => events.push(event));
    await coordinator.getCatalog('file:///workspace/test.yaml');
    remote.resolve(downloadedResult(CATALOG));
    await coordinator.whenIdle();
    assert.deepEqual(events.map(event => event.newIdentity), [`versioned:${CATALOG_DIGEST}`]);
});
```

Define `createCoordinator()` with a fixed one-folder dependency object, `LEGACY_HTML` as one valid four-cell row, and `downloadedResult()` from the valid catalog fixture shared with the client test. The coordinator dependency interface uses URI strings and byte/string readers; `StepCatalogService` is the only layer that converts these values to VS Code types.

Also test unknown version, malformed override, custom HTML failure falling through to bundle, equal-version folder reuse, changelog mtime invalidation, configuration invalidation, and stale background result suppression by generation token.

- [ ] **Step 2: Run service tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/stepCatalogService.test.js`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement a testable coordinator and thin VS Code adapter**

```ts
export interface StepCatalogProvider {
    getCatalog(documentUri?: vscode.Uri): Promise<ResolvedStepCatalog>;
    refresh(documentUri?: vscode.Uri): Promise<readonly ResolvedStepCatalog[]>;
    readonly onDidChangeCatalog: vscode.Event<StepCatalogChangeEvent>;
}

export interface StepCatalogChangeEvent {
    readonly workspaceFolderUri?: vscode.Uri;
    readonly oldIdentity?: string;
    readonly newIdentity: string;
}
```

Keep filesystem/configuration access behind injected dependencies in `WorkspaceStepCatalogCoordinator`; let `StepCatalogService` translate VS Code URIs and events. Resolve folder-scoped configuration with `vscode.workspace.getConfiguration('kotTestToolkit', folder.uri)`. Read at most the configured EPF path, its parent `docs/Changelog.md`, the namespaced cache, optional custom HTML, and bundled HTML. Parse bundled HTML once per service instance.

Return cache or fallback immediately. Start the remote exact lookup with `void` and emit an event only when its identity differs from the folder's current identity. Log automatic failures to `console.warn`; do not show VS Code notifications.

- [ ] **Step 4: Reduce `stepsFetcher.ts` to a deprecated compatibility shim**

Keep its exported names temporarily if any non-provider caller remains, but move HTML parsing and primary orchestration out. Add a source comment identifying `StepCatalogService` as the only new runtime entry point. Delete timestamp/cache behavior once `rg "getStepsHtml|forceRefreshSteps" src` shows no provider consumers in Task 5.

- [ ] **Step 5: Run service and fallback tests, then commit**

Run: `npm run compile-tests && node --test out/test/stepCatalogService.test.js out/test/legacyStepCatalog.test.js`

Expected: PASS, including the unresolved remote promise test.

```bash
git add src/stepCatalogService.ts src/stepsFetcher.ts test/stepCatalogService.test.ts
git commit -m "feat: add workspace step catalog service"
```

### Task 5: One Catalog Path for Completion, Hover, and Diagnostics

**Files:**
- Create: `src/preparedStepStateCache.ts`
- Modify: `src/completionProvider.ts:1-3,601-841,880-1086,2376-2810`
- Modify: `src/hoverProvider.ts:1-255,350-380,1175-1285`
- Modify: `src/scenarioDiagnostics.ts:800-825,1410-1490,1570-1610`
- Modify: `src/extension.ts:495,583-611,668,1115-1190,2315-2316`
- Modify: `test/completionLogging.test.ts`
- Modify: `test/extensionActivationContract.test.ts`
- Create: `test/stepCatalogProviderState.test.ts`

**Interfaces:**
- Consumes: `StepCatalogProvider` and `ResolvedStepCatalog` from Task 4.
- Produces: `PreparedStepStateCache<T>`, per-identity `GherkinCompletionState`, per-identity `HoverStepState`, document-aware `isKnownStepLine()`, and document-aware `getStepSuggestions()`.

- [ ] **Step 1: Write failing state-cache and activation contract tests**

```ts
test('prepared state cache reuses equal identities and separates different versions', () => {
    const cache = new PreparedStepStateCache(value => ({ value }), 8);
    const first = cache.getOrCreate('versioned:aaa', () => 'A');
    const same = cache.getOrCreate('versioned:aaa', () => 'unused');
    const other = cache.getOrCreate('versioned:bbb', () => 'B');
    assert.equal(first, same);
    assert.notEqual(first, other);
});
```

Add activation assertions that `extension.ts` constructs exactly one `StepCatalogService`, passes it to both providers, does not contain `completionProvider.refreshSteps()` or `hoverProvider.refreshSteps()` during activation, and the refresh command calls `stepCatalogService.refresh()` once.

Implement `PreparedStepStateCache<T>` as an access-ordered `Map<string, T>` with constructor `maxEntries = 8`, `getOrCreate(identity, factory)`, `delete(identity)`, and `clear()`. `getOrCreate()` deletes and reinserts hits, builds misses exactly once, and evicts the oldest identity after an insertion exceeds the limit.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/stepCatalogProviderState.test.js out/test/extensionActivationContract.test.js`

Expected: FAIL on the missing state cache and old activation refresh calls.

- [ ] **Step 3: Convert completion state from instance globals to an explicit per-catalog object**

```ts
interface GherkinCompletionState {
    readonly items: vscode.CompletionItem[];
    readonly semanticEntries: SemanticStepEntry[];
    readonly idfByTerm: Map<string, number>;
    readonly postingsByTerm: Map<string, number[]>;
    readonly termsByPrefix: Map<string, string[]>;
    readonly vectorScoreCache: Map<string, Map<number, number>>;
    readonly languageByItem: WeakMap<vscode.CompletionItem, ScenarioLanguage>;
}
```

Replace `parseAndStoreGherkinCompletions(html)` with `buildGherkinCompletionState(steps)`. It iterates `step.ru` and `step.en`, creates the same labels, documentation, snippets, details, filter text, and semantic related text as the old four-cell loop. Change `rebuildSemanticVectorIndex`, `calculateSemanticVectorScores`, `getSemanticStepScore`, `buildSemanticStepCompletionList`, and `getStepLanguageForItem` to receive the selected state explicitly. `provideCompletionItems()` awaits `catalogProvider.getCatalog(document.uri)`, gets or builds the LRU state by `resolved.identity`, and passes that local state through every ranking call.

- [ ] **Step 4: Convert hover state and diagnostic calls to document-aware lookup**

```ts
interface HoverStepState {
    readonly definitions: readonly StepDefinition[];
    readonly suggestions: StepSuggestionIndex;
    readonly regexByTemplate: Map<string, RegExp>;
}

public async isKnownStepLine(documentUri: vscode.Uri, lineText: string): Promise<boolean>;
public async getStepSuggestions(
    documentUri: vscode.Uri,
    lineText: string,
    maxSuggestions?: number,
    shouldCancel?: () => boolean
): Promise<string[]>;
```

Build the state from RU/EN variants with the existing English-primary/Russian-secondary behavior. Pass the local state's regex cache into template compilation. In `provideHover()`, select state with `document.uri`. In diagnostics and quick fixes, pass `document.uri` to every known-step and suggestion call.

- [ ] **Step 5: Wire one service and one refresh command in `extension.ts`**

Instantiate and register `StepCatalogService` before the providers. Inject it into both constructors. Replace the two provider refresh calls with one service refresh; provider event subscriptions lazily evict only the prior identity. On manual refresh, show one localized success message containing requested version, source, and count. Remove the activation tail calls entirely. Let the service own configuration-change invalidation for `steps.vanessaVersion`, `steps.catalogIndexUrl`, `steps.externalUrl`, and `runVanessa.vanessaEpfPath`.

- [ ] **Step 6: Update tests and eliminate direct HTML consumers**

Update `completionLogging.test.ts` to install a fake `catalogProvider`, a prepared empty state, and the new cache rather than setting removed global fields. Run:

`rg -n "node-html-parser|getStepsHtml|forceRefreshSteps" src/completionProvider.ts src/hoverProvider.ts src/extension.ts`

Expected: no matches.

- [ ] **Step 7: Run provider, diagnostic, and full project tests; commit**

Run: `npm run check`

Expected: all type checks, lint checks, and tests PASS.

```bash
git add src/preparedStepStateCache.ts src/completionProvider.ts src/hoverProvider.ts src/scenarioDiagnostics.ts src/extension.ts test/completionLogging.test.ts test/extensionActivationContract.test.ts test/stepCatalogProviderState.test.ts src/stepsFetcher.ts
git commit -m "refactor: share versioned step catalogs"
```

### Task 6: Deterministic Official `Template.xml` Generator

**Files:**
- Create: `src/stepCatalogTemplateXml.ts`
- Create: `tools/step-catalog/cli.ts`
- Create: `tsconfig.tools.json`
- Create: `test/fixtures/step-catalog/Template.xml`
- Create: `test/stepCatalogGenerator.test.ts`
- Modify: `package.json:scripts`
- Modify: `.vscodeignore`

**Interfaces:**
- Consumes: `<vanessa-source>/locales/Steps/Templates/en/Ext/Template.xml`, version, source ref, source commit, and deterministic source timestamp.
- Produces: `parseVanessaStepTemplateXml()`, `generateBuiltInStepCatalog()`, `writeCatalogPublication()`, `catalog.json`, and `generation-report.json`.

- [ ] **Step 1: Add a minimal namespaced spreadsheet fixture and failing parser tests**

The fixture contains a multilingual header row, one syntax row with `Специальный текст` / `Special text`, one bilingual executable row with escaped XML characters and a numeric entity, and one RU-only executable row.

```ts
test('official template parser keeps executable rows and excludes header and syntax rows', () => {
    const xml = readFixture('step-catalog/Template.xml');
    const result = parseVanessaStepTemplateXml(xml);
    assert.equal(result.steps.length, 2);
    assert.equal(result.excludedSyntaxRows, 1);
    assert.equal(result.steps[0].ru?.pattern, 'И поле <Имя> равно "Значение"');
    assert.equal(result.steps[0].en?.description, 'Checks value & title');
});

test('official template parser rejects a row with three outer cells', () => {
    assert.throws(() => parseVanessaStepTemplateXml(threeCellFixture()), /exactly four cells/);
});

test('official template parser rejects namespace or header drift', () => {
    assert.throws(() => parseVanessaStepTemplateXml(fixtureWithoutExpectedHeader()), /header/);
});
```

- [ ] **Step 2: Run generator tests and verify they fail**

Run: `npm run compile-tests && node --test out/test/stepCatalogGenerator.test.js`

Expected: FAIL because the XML parser does not exist.

- [ ] **Step 3: Implement strict spreadsheet parsing and deterministic generation**

Use `node-html-parser` to locate `rowsItem`, then inspect direct outer `c` children under each `row` rather than flattening every nested localized `v8:content`. For each outer cell, select the innermost text container value used by the template. Require the exact four header labels. Decode XML entities through the parser, normalize CRLF, trim only outer blank space, and keep internal newlines.

```ts
export interface VanessaTemplateParseResult {
    readonly steps: readonly BuiltInStepDefinition[];
    readonly sourceRows: number;
    readonly excludedSyntaxRows: number;
}

export interface GenerateCatalogOptions {
    readonly version: string;
    readonly sourceRef: string;
    readonly sourceCommit: string;
    readonly sourceTimestamp: string;
}
```

Sort by RU pattern, then EN pattern, then ID. Use `sourceTimestamp` for `generatedAt`, so identical source inputs produce byte-identical JSON. Emit JSON with two-space indentation and one trailing newline.

- [ ] **Step 4: Add compatibility reporting and append-only publication writer tests**

```ts
test('publication refuses to replace an existing version with different bytes', async () => {
    const root = await temporaryPublication({ '1.2.043.28/catalog.json': OLD_BYTES });
    await assert.rejects(
        () => writeCatalogPublication(root, generatedCatalogWithDifferentBytes()),
        /immutable catalog already exists/
    );
});

test('compatibility report lists every normalized legacy pattern missing from generated data', () => {
    const report = compareCatalogWithLegacyHtml(generated, LEGACY_HTML);
    assert.deepEqual(report.missingLegacyRuPatterns, ['И старый шаг']);
});
```

The generation report records source row count, excluded syntax count, output step count, RU/EN counts, duplicate checks, and normalized legacy patterns absent from the generated catalog. Publication writes `<version>/catalog.json`, `<version>/generation-report.json`, and a sorted `index.json` whose hash is calculated from exact catalog bytes.

- [ ] **Step 5: Add the CLI, tool typecheck, and package scripts**

```json
{
  "scripts": {
    "check:types": "tsc --noEmit && tsc -p tsconfig.tools.json --noEmit",
    "build:step-catalog-tool": "esbuild ./tools/step-catalog/cli.ts --bundle --outfile=out/tools/step-catalog.js --platform=node --format=cjs",
    "generate:step-catalog": "npm run build:step-catalog-tool && node out/tools/step-catalog.js"
  }
}
```

The CLI requires `--source`, `--version`, `--ref`, `--commit`, `--source-timestamp`, `--publication-root`, and `--legacy-html`. Missing or malformed arguments exit non-zero with one concise message. Add `tools/step-catalog/**`, `tsconfig.tools.json`, and generator fixtures to `.vscodeignore` so development inputs do not enter the VSIX.

- [ ] **Step 6: Verify the full official 1.2.043.28 template**

Shallow-clone the official `1.2.043.28` tag to `/tmp/vanessa-automation-1.2.043.28`, resolve its commit and commit timestamp, then run:

```bash
STEP_CATALOG_COMMIT=$(git -C /tmp/vanessa-automation-1.2.043.28 rev-parse HEAD)
STEP_CATALOG_TIMESTAMP=$(git -C /tmp/vanessa-automation-1.2.043.28 show -s --format=%cI HEAD)
npm run generate:step-catalog -- \
  --source /tmp/vanessa-automation-1.2.043.28 \
  --version 1.2.043.28 \
  --ref 1.2.043.28 \
  --commit "$STEP_CATALOG_COMMIT" \
  --source-timestamp "$STEP_CATALOG_TIMESTAMP" \
  --publication-root /tmp/kot-step-catalog-publication \
  --legacy-html res/steps.htm
```

Expected: 1,613 generated step rows, 11 excluded syntax rows, valid SHA-256 index entry, and a compatibility report containing every normalized legacy pattern not present in the official XML.

- [ ] **Step 7: Run all generator checks and commit**

Run: `npm run check`

Run the generation command twice into two empty temporary directories and compare `catalog.json` with `cmp`; expected exit code `0`.

```bash
git add src/stepCatalogTemplateXml.ts tools/step-catalog/cli.ts tsconfig.tools.json test/fixtures/step-catalog/Template.xml test/stepCatalogGenerator.test.ts package.json package-lock.json .vscodeignore
git commit -m "feat: generate catalogs from Vanessa sources"
```

### Task 7: Catalog Publication Workflow, Settings, and User Documentation

**Files:**
- Create: `.github/workflows/publish-step-catalogs.yml`
- Modify: `package.json:190-205`
- Modify: `package.nls.json`
- Modify: `package.nls.ru.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `test/stepCatalogWorkflowContract.test.ts`

**Interfaces:**
- Consumes: generator CLI and append-only publication directory from Task 6.
- Produces: scheduled/manual `step-catalogs` branch publisher and user-visible configuration for exact version override/index URL.

- [ ] **Step 1: Write a failing workflow contract test**

```ts
test('catalog workflow is append-only, serialized, and uses noreply commit identity', () => {
    const source = fs.readFileSync('.github/workflows/publish-step-catalogs.yml', 'utf8');
    assert.match(source, /permissions:\s*\n\s*contents: write/);
    assert.match(source, /concurrency:/);
    assert.match(source, /step-catalogs/);
    assert.match(source, /48015759\+alexiosus@users\.noreply\.github\.com/);
    assert.match(source, /npm run generate:step-catalog/);
    assert.doesNotMatch(source, /--force|push --force/);
});
```

- [ ] **Step 2: Run the workflow contract test and verify it fails**

Run: `npm run compile-tests && node --test out/test/stepCatalogWorkflowContract.test.js`

Expected: FAIL because the workflow does not exist.

- [ ] **Step 3: Add folder-scoped settings and localization**

Add these properties under “Diagnostics and Steps Library”:

```json
"kotTestToolkit.steps.vanessaVersion": {
  "type": "string",
  "default": "",
  "scope": "resource",
  "pattern": "^(|v?\\d+\\.\\d+\\.\\d+\\.\\d+)$",
  "description": "%config.stepsVanessaVersion.description%",
  "order": 1
},
"kotTestToolkit.steps.catalogIndexUrl": {
  "type": "string",
  "default": "https://raw.githubusercontent.com/alexiosus/KOTfor1C/step-catalogs/index.json",
  "scope": "resource",
  "description": "%config.stepsCatalogIndexUrl.description%",
  "order": 2
}
```

Move deprecated `steps.externalUrl` to order 3, set its default to an empty string, and explain in both NLS files that it is only the legacy HTML fallback. The runtime still honors explicitly configured values.

- [ ] **Step 4: Implement the serialized GitHub Actions publisher**

The workflow uses `workflow_dispatch` with optional exact `version` input and a weekly schedule. For a scheduled run, query the latest non-prerelease official release; for a manual empty input, do the same. Resolve the tag to a 40-character commit and its ISO timestamp, download the pinned source archive, prepare a temporary checkout of the existing `step-catalogs` branch or an orphan branch on first run, and invoke the CLI.

Before committing, run the generator tests and validate the generated index. If the publication directory is unchanged, exit successfully without a commit. Otherwise configure:

```bash
git config user.name "Alexey Eremeev"
git config user.email "48015759+alexiosus@users.noreply.github.com"
git add index.json "${VERSION}/catalog.json" "${VERSION}/generation-report.json"
git commit -m "catalog: publish Vanessa ${VERSION}"
git push origin HEAD:step-catalogs
```

Do not use force push. Pin official GitHub actions to stable major versions, grant only `contents: write`, and set one concurrency group with `cancel-in-progress: false`.

- [ ] **Step 5: Document source selection and fallback behavior**

Add a README subsection explaining version detection beside `runVanessa.vanessaEpfPath`, the exact-version override, immutable local cache, bundled offline fallback, manual “Refresh steps library” command, and the fact that user/export libraries remain separate. Add a 2.8.0 changelog bullet for version-aware catalogs and removal of duplicate HTML loading.

- [ ] **Step 6: Run workflow/settings tests and commit**

Run: `npm run compile-tests && node --test out/test/stepCatalogWorkflowContract.test.js out/test/extensionActivationContract.test.js`

Run: `npm run check`

Expected: PASS.

```bash
git add .github/workflows/publish-step-catalogs.yml package.json package.nls.json package.nls.ru.json README.md CHANGELOG.md test/stepCatalogWorkflowContract.test.ts
git commit -m "ci: publish versioned Vanessa step catalogs"
```

### Task 8: End-to-end Verification and Branch Handoff

**Files:**
- Modify only files required by failures found during verification.

**Interfaces:**
- Consumes: all completed tasks.
- Produces: a packageable 2.8.0 branch and evidence for the existing pull request.

- [ ] **Step 1: Verify no duplicate or eager step loading remains**

Run:

```bash
rg -n "getStepsHtml|forceRefreshSteps|parseAndStoreGherkinCompletions\(html|parseAndStoreStepDefinitions\(html" src
rg -n "completionProvider\.refreshSteps\(\)|hoverProvider\.refreshSteps\(\)" src/extension.ts
```

Expected: no matches.

- [ ] **Step 2: Run all automated verification**

Run: `npm run check`

Run: `npm run vscode:prepublish`

Run: `git diff --check`

Expected: all commands exit `0`.

- [ ] **Step 3: Package and inspect the VSIX contents**

Run: `npx vsce package`

Expected: a 2.8.0 VSIX is created; `res/steps.htm` and `out/extension.js` are present, while `tools/step-catalog`, generator fixtures, TypeScript sources, and test output are absent.

- [ ] **Step 4: Perform a local smoke test with the user's Vanessa project**

Open `/Users/alexeremeev/Development/1cDrive` in the Extension Development Host and verify:

1. `tools/vanessa/docs/Changelog.md` resolves to `1.2.043.28`.
2. With an empty global storage cache and network disabled, the first completion and hover appear from bundled HTML without waiting for the remote request.
3. With a generated local index URL or populated exact cache, the source switches to `1.2.043.28` and exposes the generated step count.
4. “Refresh steps library” performs one service refresh and reports one result.
5. Unknown-step diagnostics and suggestions still react without visible Extension Host stalls.

- [ ] **Step 5: Audit commit email and working tree**

Run:

```bash
git log main..HEAD --format='%h %an <%ae> %s'
git status --short
```

Expected: every email is `48015759+alexiosus@users.noreply.github.com` and the working tree is clean except for an intentionally retained VSIX, which remains ignored.

- [ ] **Step 6: Push and update the pull request**

Push `codex/reliability-foundation`, update the PR description with the versioned-catalog architecture, performance effect, offline fallback, test evidence, and post-merge catalog bootstrap instructions. Attach the PR to the task after the push.

### Deferred Follow-up: Visual Step Library

Build a separate native VS Code step browser after the versioned catalog rollout. Vanessa category rows (`Категория шагов` / `Steps category`) are translation metadata, not executable steps; keep them out of IntelliSense. The browser should instead group real steps by their hierarchical `ТипШага` path (for example, `Файлы.Удаление файлов.Очистка каталога`), support search and step insertion, and show descriptions without requiring `steps.htm`.

The translation `Template.xml` contains category names but not the step-to-category relationship. Before implementing the browser, extend the catalog source with category paths obtained from Vanessa source definitions or Vanessa's JSON export (`section` / `category`). Treat this as a separately designed feature rather than inferring ownership from row order.
