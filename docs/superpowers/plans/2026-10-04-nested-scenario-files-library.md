# Nested Scenario Files in Step Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each nested scenario's recursive `files` tree inline in both Step Library surfaces, with external open/reveal, editor filename drag, and safe inbound Finder/Explorer copy.

**Architecture:** Add one shared extension-host `ScenarioFilesService` and a pure resource model. Both webviews request directory levels lazily and share a browser-side transfer helper; the extension host remains authoritative for paths, collision decisions, chunked temporary writes, and watcher lifecycle.

**Tech Stack:** TypeScript, VS Code extension API, Node.js filesystem APIs, browser DOM drag-and-drop, Node test runner, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-04-nested-scenario-files-library-design.md`

## Global Constraints

- Only nested scenarios with a local captured YAML location expose `Files`.
- The resource root is the sibling `files` directory next to `scen.yaml`.
- Directory contents are loaded one level at a time; initial Step Library snapshots never recursively scan resources.
- Webviews never choose an authoritative absolute destination path.
- Inbound files are written to temporary siblings and published only after complete transfer.
- Conflicts offer Replace, Save copy, and Skip; existing directories merge recursively.
- Editor drag inserts only the file base name.
- OS-native outbound drag is represented by Show in Finder / Explorer, not simulated from the webview.
- External open/reveal is limited to local `file` resources.
- Compact and full-size Library surfaces use the same resource node semantics and transfer protocol.
- Preserve all pre-existing dirty worktree changes and stage only changes attributable to this plan.

## Review Focus

- A malicious webview sends `../`, an absolute path, or a Windows drive path: Task 1 tests normalization rejection and Task 3 tests that no destination is created.
- A transfer is interrupted or sends an out-of-order/oversized chunk: Task 3 tests rejection and temporary-file cleanup.
- A large library contains thousands of nested scenarios: Task 1 and Task 6 prove the snapshot and initial roots perform no resource directory reads.
- Finder changes an expanded directory while both Library surfaces are open: Task 2 tests shared watcher reference counting and scoped invalidation.
- A drop contains a directory that already exists plus conflicting files: Task 3 tests directory merge and each Replace/Save copy/Skip branch.

---

### Task 1: Pure Resource Model and Nested-Scenario Capability

**Files:**
- Create: `src/scenarioFilesModel.ts`
- Modify: `src/stepLibraryModel.ts`
- Modify: `src/stepLibrarySidebarModel.ts`
- Create: `test/scenarioFilesModel.test.ts`
- Modify: `test/stepLibraryModel.test.ts`
- Modify: `test/stepLibrarySidebarModel.test.ts`

**Interfaces:**
- Consumes: `StepLibraryItem.kind`, `sourceGroup`, `capturedLocation`, and `id`.
- Produces: `ScenarioFileNode`, `ScenarioFileManifestEntry`, `normalizeScenarioFileRelativePath()`, `scenarioFileNodeId()`, `scenarioFilesAvailable()`, and `StepLibraryItem.hasScenarioFiles`.

- [ ] **Step 1: Write failing pure-model tests**

```ts
test('normalizes safe resource paths and rejects traversal or absolute paths', () => {
    assert.equal(normalizeScenarioFileRelativePath('Fixtures/Input.xlsx'), 'Fixtures/Input.xlsx');
    for (const value of ['../secret.txt', '/tmp/file', 'C:\\temp\\file', '\\\\server\\share']) {
        assert.equal(normalizeScenarioFileRelativePath(value), null);
    }
});

test('nested definitions with local YAML locations advertise one expandable Files child', () => {
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot([item({
        id: 'nested-local',
        kind: 'nestedScenario',
        sourceGroup: 'nested',
        displayText: 'Create invoice',
        hasScenarioFiles: true,
        capturedLocation: {
            uri: 'file:///workspace/CreateInvoice/scen.yaml',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        }
    })]), 'en');
    const nested = index.search('Create invoice')[0];
    assert.equal(nested.expandable, true);
    assert.equal(nested.hasScenarioFiles, true);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run compile-tests && node --test --test-name-pattern="resource paths|advertise one expandable Files" out/test/*.test.js`

Expected: compilation fails because `scenarioFilesModel.ts`, `hasScenarioFiles`, and the new node properties do not exist.

- [ ] **Step 3: Implement the immutable pure model**

```ts
export type ScenarioFileNodeKind = 'filesRoot' | 'directory' | 'file';

export interface ScenarioFileNode {
    readonly id: string;
    readonly kind: ScenarioFileNodeKind;
    readonly itemId: string;
    readonly name: string;
    readonly relativePath: string;
    readonly depth: number;
    readonly expandable: boolean;
}

export interface ScenarioFileManifestEntry {
    readonly clientPath: string;
    readonly kind: 'directory' | 'file';
    readonly size?: number;
}

export function normalizeScenarioFileRelativePath(value: string): string | null;
export function scenarioFileNodeId(itemId: string, kind: ScenarioFileNodeKind, relativePath: string): string;
export function scenarioFilesAvailable(item: StepLibraryItem): boolean;
```

`normalizeScenarioFileRelativePath` converts `\\` to `/`, removes `.` segments, rejects empty file segments, `..`, leading slash, drive prefixes, NUL, and UNC prefixes. `scenarioFilesAvailable` accepts only `kind === 'nestedScenario'`, `sourceGroup === 'nested'`, a captured URI beginning with `file:`, and a non-empty item ID.

`buildStepLibrarySnapshot` sets `hasScenarioFiles: true` only for those items. `definitionNode` carries that flag and becomes expandable without changing search, paging, favorites, or relationship ancestry.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run compile-tests && node --test --test-name-pattern="resource paths|advertise one expandable Files|step library" out/test/*.test.js`

Expected: the new tests and existing Step Library model tests pass.

- [ ] **Step 5: Commit the task**

```bash
git add src/scenarioFilesModel.ts src/stepLibraryModel.ts src/stepLibrarySidebarModel.ts test/scenarioFilesModel.test.ts test/stepLibraryModel.test.ts test/stepLibrarySidebarModel.test.ts
git commit -m "feat: model nested scenario resources"
```

### Task 2: Shared Lazy Directory Service, Open/Reveal, and Watchers

**Files:**
- Create: `src/scenarioFilesService.ts`
- Create: `test/scenarioFilesService.test.ts`

**Interfaces:**
- Consumes: Task 1 `ScenarioFileNode`, `normalizeScenarioFileRelativePath()`, `scenarioFileNodeId()`, and `StepLibraryItem`.
- Produces: `ScenarioFilesService.listChildren()`, `openExternal()`, `revealInOs()`, `watch()`, `onDidInvalidate`, and `dispose()`.
- Test helper: `createScenarioFilesFixture(files: Readonly<Record<string, string>>)` creates a real `mkdtemp` scenario directory, writes `scen.yaml` and the supplied `files/**` entries, returns a nested `StepLibraryItem`, the service, a recording host, and cleanup through `t.after()`.

- [ ] **Step 1: Write failing service tests with real temporary directories**

```ts
test('lists one directory level with directories first and does not traverse grandchildren', async () => {
    const fixture = await createScenarioFilesFixture({
        'z.txt': 'z',
        'Alpha/a.txt': 'a',
        'beta.txt': 'b'
    });
    const nodes = await fixture.service.listChildren(fixture.item, '');
    assert.deepEqual(nodes.map(node => [node.kind, node.name]), [
        ['directory', 'Alpha'],
        ['file', 'beta.txt'],
        ['file', 'z.txt']
    ]);
    assert.equal(fixture.host.readDirectoryCalls.length, 1);
});

test('shares a watcher for the same root and disposes it after the final subscriber', async () => {
    const first = service.watch(item, () => firstInvalidations += 1);
    const second = service.watch(item, () => secondInvalidations += 1);
    assert.equal(host.createdWatchers.length, 1);
    first.dispose();
    assert.equal(host.createdWatchers[0].disposed, false);
    second.dispose();
    assert.equal(host.createdWatchers[0].disposed, true);
});
```

The same test file adds these literal cases:

- no `files` directory returns `[]` and does not create the directory;
- listing `Alpha` returns only `a.txt` and records exactly one read of `files/Alpha`;
- `openExternal(item, 'z.txt')` and `revealInOs(item, 'Alpha')` record their exact local URIs;
- a `userStep` item and an item with `https:` location both reject without a filesystem call;
- three watcher events within 100 ms produce one invalidation containing the nested item ID for both subscribers.

- [ ] **Step 2: Run the service tests and verify RED**

Run: `npm run compile-tests && node --test --test-name-pattern="lists one directory level|shares a watcher|scenario files service" out/test/*.test.js`

Expected: compilation fails because `ScenarioFilesService` does not exist.

- [ ] **Step 3: Implement the host boundary and lazy service**

```ts
export interface ScenarioFilesHost {
    readonly readDirectory: (uri: vscode.Uri) => Thenable<readonly [string, vscode.FileType][]>;
    readonly stat: (uri: vscode.Uri) => Thenable<vscode.FileStat>;
    readonly createDirectory: (uri: vscode.Uri) => Thenable<void>;
    readonly openExternal: (uri: vscode.Uri) => Thenable<boolean>;
    readonly revealInOs: (uri: vscode.Uri) => Thenable<void>;
    readonly createWatcher: (root: vscode.Uri) => vscode.FileSystemWatcher;
}

export class ScenarioFilesService implements vscode.Disposable {
    readonly onDidInvalidate: vscode.Event<ScenarioFilesInvalidation>;
    listChildren(item: StepLibraryItem, relativeDirectory: string): Promise<readonly ScenarioFileNode[]>;
    openExternal(item: StepLibraryItem, relativePath: string): Promise<boolean>;
    revealInOs(item: StepLibraryItem, relativePath: string): Promise<boolean>;
    watch(item: StepLibraryItem, listener: (event: ScenarioFilesInvalidation) => void): vscode.Disposable;
    dispose(): void;
}
```

Use `vscode.Uri.parse(capturedLocation.uri)` plus `vscode.Uri.joinPath(dirnameUri, 'files')`. Catch only file-not-found for an empty root; propagate permission and malformed-entry failures. Sort with a stable case-insensitive primary comparison and exact-name tie break. Share watchers by root URI and debounce bursts for 100 ms.

- [ ] **Step 4: Run service tests and verify GREEN**

Run: `npm run compile-tests && node --test --test-name-pattern="scenario files service|lists one directory level|shares a watcher" out/test/*.test.js`

Expected: all Task 2 tests pass without reading grandchildren.

- [ ] **Step 5: Commit the task**

```bash
git add src/scenarioFilesService.ts test/scenarioFilesService.test.ts
git commit -m "feat: add lazy scenario files service"
```

### Task 3: Safe Drop Planning and Chunked Atomic Transfers

**Files:**
- Modify: `src/scenarioFilesService.ts`
- Modify: `test/scenarioFilesService.test.ts`

**Interfaces:**
- Consumes: Task 1 manifest types and Task 2 resource-root resolution.
- Produces: `prepareDrop()`, `appendTransferChunk()`, `completeTransfer()`, `cancelTransfer()`, `ScenarioFileDropPlan`, and `ScenarioFileConflictDecision`.

- [ ] **Step 1: Write failing transfer and conflict tests**

```ts
test('writes ordered chunks to a temporary sibling and publishes only on completion', async () => {
    const plan = await fixture.service.prepareDrop(fixture.item, '', [
        { clientPath: 'Expected.xlsx', kind: 'file', size: 6 }
    ]);
    const transfer = plan.files[0];
    await fixture.service.appendTransferChunk(transfer.transferId, 0, Buffer.from('abc').toString('base64'));
    assert.equal(await fixture.exists('Expected.xlsx'), false);
    await fixture.service.appendTransferChunk(transfer.transferId, 3, Buffer.from('def').toString('base64'));
    await fixture.service.completeTransfer(transfer.transferId);
    assert.equal(await fixture.read('Expected.xlsx'), 'abcdef');
});

test('replace, save copy, and skip preserve the selected collision semantics', async () => {
    const cases = [
        { decision: 'replace', destination: 'Expected.xlsx', transfers: 1 },
        { decision: 'copy', destination: 'Expected (1).xlsx', transfers: 1 },
        { decision: 'skip', destination: undefined, transfers: 0 }
    ] as const;
    for (const expected of cases) {
        const fixture = await createConflictFixture(expected.decision);
        const plan = await fixture.service.prepareDrop(fixture.item, '', [
            { clientPath: 'Expected.xlsx', kind: 'file', size: 3 }
        ]);
        assert.equal(plan.files[0]?.destinationRelativePath, expected.destination);
        assert.equal(plan.files.length, expected.transfers);
    }
});
```

The transfer test table additionally pins these exact behaviors:

- manifest `Fixtures` plus `Fixtures/Input.xlsx` merges into an existing `Fixtures` directory;
- targets `../outside`, `/absolute`, `C:\\outside`, and `\\\\server\\share` reject and leave the temporary root empty;
- a second chunk at offset `2` after writing three bytes rejects and removes the transfer;
- a four-byte decoded chunk for a declared three-byte file rejects and removes the temporary file;
- `cancelTransfer()` and `dispose()` both close the handle and unlink the temporary sibling;
- `completeTransfer()` after two bytes of a declared three-byte file rejects without publishing the destination.

- [ ] **Step 2: Run transfer tests and verify RED**

Run: `npm run compile-tests && node --test --test-name-pattern="ordered chunks|collision semantics|traversal rejection" out/test/*.test.js`

Expected: compilation fails because transfer APIs are absent.

- [ ] **Step 3: Implement manifest validation and transfer lifecycle**

```ts
export type ScenarioFileConflictDecision = 'replace' | 'copy' | 'skip';

export interface ScenarioFileDropPlan {
    readonly files: readonly {
        readonly clientPath: string;
        readonly destinationRelativePath: string;
        readonly transferId: string;
    }[];
    readonly skipped: readonly string[];
}

prepareDrop(
    item: StepLibraryItem,
    targetDirectory: string,
    entries: readonly ScenarioFileManifestEntry[]
): Promise<ScenarioFileDropPlan>;
appendTransferChunk(transferId: string, offset: number, base64: string): Promise<number>;
completeTransfer(transferId: string): Promise<void>;
cancelTransfer(transferId: string): Promise<void>;
```

Resolve every destination beneath the trusted resource root, inspect every existing path before creating transfer state, merge directories, and request conflict decisions through an injected host callback. Limit decoded chunks to 256 KiB, require the exact next offset, and reject bytes beyond the declared size. Use a random temporary sibling name and Node file handles; close and unlink it on every failed/cancelled path. At completion, require exact byte count, close the handle, then rename. For Replace on Windows, remove the old destination only after the complete temporary file is closed and immediately before the final rename.

- [ ] **Step 4: Run transfer tests and verify GREEN**

Run: `npm run compile-tests && node --test --test-name-pattern="scenario files service|ordered chunks|collision semantics|traversal rejection" out/test/*.test.js`

Expected: all service and transfer tests pass with no leftover temporary files.

- [ ] **Step 5: Commit the task**

```bash
git add src/scenarioFilesService.ts test/scenarioFilesService.test.ts
git commit -m "feat: copy scenario resources safely"
```

### Task 4: Shared Webview Resource Protocol and Compact Library Tree

**Files:**
- Create: `src/scenarioFilesWebviewProtocol.ts`
- Create: `media/scenarioFilesProtocol.js`
- Modify: `src/stepLibrarySidebarProvider.ts`
- Modify: `media/stepLibrarySidebar.js`
- Modify: `media/stepLibrarySidebar.css`
- Modify: `media/stepLibrarySidebarProtocol.js`
- Create: `test/scenarioFilesWebviewProtocol.test.ts`
- Modify: `test/stepLibrarySidebarProvider.test.ts`
- Modify: `test/stepLibrarySidebarProtocol.test.ts`
- Modify: `test/stepLibraryPanelContract.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 service APIs and node/manifest types.
- Produces: validated resource messages, common DOM drop collection/chunk pump, compact Files tree rendering, open/reveal actions, and watcher subscriptions.

- [ ] **Step 1: Write failing protocol and compact-provider tests**

```ts
test('rejects oversized chunks and untrusted paths before they reach the service', () => {
    assert.equal(parseScenarioFilesMessage({
        command: 'appendScenarioFileChunk',
        transferId: 'id', offset: 0, base64: 'x'.repeat(MAX_MESSAGE_CHARS + 1)
    }), null);
});

test('expanding a nested definition requests Files lazily and never reloads the snapshot', async () => {
    await fixture.ready();
    await fixture.receive({ command: 'expand', nodeId: fixture.nestedNodeId, offset: 0 });
    assert.equal(fixture.snapshotLoads, 1);
    assert.deepEqual(fixture.lastMessage.nodes.map(node => node.kind), ['filesRoot']);
});
```

The protocol/provider tests use these exact cases:

- expanding `Files` at `relativePath: ''` returns `Fixtures` then `Expected.xlsx` from the fake service;
- `openScenarioFile` and `revealScenarioFile` call the fake service with the item obtained from `StepLibrarySidebarIndex`, not any URI from the message;
- `setScenarioFilesExpanded` creates one watch; collapsing and disposing the view each dispose it exactly once;
- `prepareScenarioFileDrop` echoes the drop ID and returns only the service's accepted client paths;
- after a valid chunk, the host posts the exact returned next offset; a service error posts `scenarioFileTransferFailed`;
- `setEditorDragData` sets `text/plain` to `Expected.xlsx`;
- a fake Chromium entry tree `Fixtures/Input.xlsx` produces one directory manifest entry and one file entry with the literal relative paths.

- [ ] **Step 2: Run compact protocol tests and verify RED**

Run: `npm run compile-tests && node --test --test-name-pattern="oversized chunks|Files lazily|recursive DOM manifest" out/test/*.test.js`

Expected: compilation/assertion failure because the resource protocol and rendering hooks are absent.

- [ ] **Step 3: Implement the common protocol and browser transfer helper**

The TypeScript parser accepts these commands with bounded IDs, paths, entry counts, declared sizes, offsets, and base64 lengths:

```ts
type ScenarioFilesMessage =
    | { command: 'listScenarioFiles'; itemId: string; relativePath: string; requestId: string }
    | { command: 'setScenarioFilesExpanded'; itemId: string; expanded: boolean }
    | { command: 'openScenarioFile'; itemId: string; relativePath: string }
    | { command: 'revealScenarioFile'; itemId: string; relativePath: string }
    | { command: 'prepareScenarioFileDrop'; dropId: string; itemId: string; targetRelativePath: string; entries: readonly ScenarioFileManifestEntry[] }
    | { command: 'appendScenarioFileChunk'; transferId: string; offset: number; base64: string }
    | { command: 'completeScenarioFileTransfer'; transferId: string }
    | { command: 'cancelScenarioFileTransfer'; transferId: string };
```

`media/scenarioFilesProtocol.js` exports a frozen `globalThis.KotScenarioFilesProtocol` with `collectDropEntries(dataTransfer)`, `setEditorDragData(event, node)`, and a one-chunk-at-a-time transfer pump driven by host acknowledgements.

- [ ] **Step 4: Integrate compact provider and DOM tree**

Inject `ScenarioFilesService` into `StepLibrarySidebarServices`. For nested definition expansion return one synthetic `Files` node. For resource expansion call `listChildren`; resource nodes carry only item ID, normalized relative path, name, kind, and depth. Maintain per-view watcher disposables and transfer ownership; dispose both on collapse/view disposal.

Render `filesRoot`, `directory`, and `file` rows with existing arrow/indent styles. Double-click files to open externally. Add a hover/context action for reveal. Accept drop on the nested row, `Files`, and directories. File drag sets `text/plain` to the base name and optional `text/uri-list`, never the absolute path as plain text.

- [ ] **Step 5: Run compact tests and verify GREEN**

Run: `npm run compile-tests && node --test --test-name-pattern="scenario files|Files lazily|step library sidebar" out/test/*.test.js`

Expected: all Task 4 tests and existing compact Library tests pass.

- [ ] **Step 6: Commit the task**

```bash
git add src/scenarioFilesWebviewProtocol.ts media/scenarioFilesProtocol.js src/stepLibrarySidebarProvider.ts media/stepLibrarySidebar.js media/stepLibrarySidebar.css media/stepLibrarySidebarProtocol.js test/scenarioFilesWebviewProtocol.test.ts test/stepLibrarySidebarProvider.test.ts test/stepLibrarySidebarProtocol.test.ts test/stepLibraryPanelContract.test.ts
git commit -m "feat: browse resources in compact library"
```

### Task 5: Full-Size Library Inline Resource Tree

**Files:**
- Modify: `src/stepLibraryPanel.ts`
- Modify: `media/stepLibrary.js`
- Modify: `media/stepLibrary.css`
- Modify: `media/stepLibraryProtocol.js`
- Modify: `test/stepLibraryPanel.test.ts`
- Modify: `test/stepLibraryPanelContract.test.ts`
- Modify: `test/stepLibraryProtocol.test.ts`

**Interfaces:**
- Consumes: Task 4 shared parser/browser helper and Tasks 1–3 service APIs.
- Produces: full-size inline resource expansion with interaction parity.

- [ ] **Step 1: Write failing full-panel behavior and contract tests**

```ts
test('full panel resolves resource messages through the same shared service', async () => {
    await fixture.open();
    await fixture.receive({
        command: 'listScenarioFiles', itemId: fixture.nestedItemId,
        relativePath: '', requestId: 'request-1'
    });
    assert.deepEqual(fixture.lastMessage, {
        command: 'scenarioFileChildren', requestId: 'request-1',
        itemId: fixture.nestedItemId, relativePath: '', nodes: fixture.nodes
    });
});
```

Contract tests execute the real browser script and assert that the center list renders `scenario → Files → directory → file`, that a file double-click posts open, reveal posts reveal, drag inserts the base name, and the drop state machine is the same helper used by the compact view.

- [ ] **Step 2: Run full-panel tests and verify RED**

Run: `npm run compile-tests && node --test --test-name-pattern="full panel resolves resource|inline resource|step library panel" out/test/*.test.js`

Expected: assertions fail because the panel ignores resource commands and renders flat definition rows.

- [ ] **Step 3: Integrate the service into `StepLibraryPanel`**

Add `scenarioFilesService` to `StepLibraryPanelServices`, parse shared messages before definition actions, resolve current server-owned items from the last successful snapshot, own per-panel watcher/transfer subscriptions, and post the same children/ack/invalidation shapes used by the compact surface. Dispose all subscriptions and cancel panel-owned transfers on panel disposal.

- [ ] **Step 4: Render the selected inline hierarchy**

Extend the center-list row renderer so nested definitions have a disclosure control and child group. Reuse the shared helper for manifest collection, drag payload, and chunk pumping. Preserve definition selection, double-click insertion outside disclosure/resource rows, keyboard navigation, result paging, search, category filters, details, favorites, and narrow layouts. Add resource-specific CSS using the same indentation scale as the compact Library.

- [ ] **Step 5: Run full-panel and parity tests and verify GREEN**

Run: `npm run compile-tests && node --test --test-name-pattern="full panel resolves resource|inline resource|step library panel|step library protocol" out/test/*.test.js`

Expected: full panel, browser contracts, paging, search, and existing definition actions pass.

- [ ] **Step 6: Commit the task**

```bash
git add src/stepLibraryPanel.ts media/stepLibrary.js media/stepLibrary.css media/stepLibraryProtocol.js test/stepLibraryPanel.test.ts test/stepLibraryPanelContract.test.ts test/stepLibraryProtocol.test.ts
git commit -m "feat: browse resources in full step library"
```

### Task 6: Activation Wiring, Localization, Performance, and Final Verification

**Files:**
- Modify: `src/extension.ts`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`
- Modify: `test/extensionActivationContract.test.ts`
- Modify: `test/stepLibraryPerformance.test.ts`
- Modify: `test/stepLibraryPanelContract.test.ts`

**Interfaces:**
- Consumes: all previous task interfaces.
- Produces: one shared, disposable service wired to both Library surfaces with localized UI and complete regression coverage.

- [ ] **Step 1: Write failing activation and performance tests**

```ts
test('activation shares one scenario files service across both Library surfaces', () => {
    assert.equal(source.match(/new ScenarioFilesService\(/gu)?.length, 1);
    assert.match(source, /new StepLibrarySidebarProvider\(\{[\s\S]*?scenarioFilesService/u);
    assert.match(source, /new StepLibraryPanel\(\{[\s\S]*?scenarioFilesService/u);
    assert.match(source, /context\.subscriptions\.push\([\s\S]*?scenarioFilesService/u);
});

test('initial Library loading performs no scenario resource directory reads', async () => {
    await fixture.openBothLibrariesWithNestedScenarios(10_000);
    assert.equal(fixture.scenarioFilesHost.readDirectoryCalls.length, 0);
});
```

Add a contract assertion that both HTML documents load `scenarioFilesProtocol.js`, carry localized labels for Files/Open externally/Show in Finder or Explorer/Replace/Save copy/Skip, and use identical resource node command names.

- [ ] **Step 2: Run activation/performance tests and verify RED**

Run: `npm run compile-tests && node --test --test-name-pattern="shares one scenario files service|no scenario resource directory reads|localized labels" out/test/*.test.js`

Expected: failures because the shared service is not created in activation and labels are absent.

- [ ] **Step 3: Wire and localize the shared service**

Create one `ScenarioFilesService` after the Step Library snapshot/action services. Supply a production host backed by `vscode.workspace.fs`, `vscode.env.openExternal`, `revealFileInOS`, a `RelativePattern` watcher, and `showWarningMessage` conflict choices. Register the service in `context.subscriptions` and pass it to compact and deferred full-panel constructors.

Add English/Russian strings for `Files`, `Open externally`, `Show in Finder`, `Show in Explorer`, empty directory, retry, transfer failure, invalid path, Replace, Save copy, Skip, and non-local resource messages.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run compile-tests && node --test --test-name-pattern="scenario files|step library|shares one scenario files service|no scenario resource directory reads" out/test/*.test.js`

Expected: all new and existing Step Library tests pass.

- [ ] **Step 5: Run complete verification**

Run: `npm run check`

Expected: TypeScript checks pass, ESLint reports zero warnings, and the complete Node test suite reports zero failures.

- [ ] **Step 6: Inspect the final diff against the design**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only planned files plus pre-existing worktree changes are listed. Review every requirement in `docs/superpowers/specs/2026-10-04-nested-scenario-files-library-design.md` against a test or an explicit implementation path.

- [ ] **Step 7: Commit the task**

```bash
git add src/extension.ts l10n/bundle.l10n.json l10n/bundle.l10n.ru.json test/extensionActivationContract.test.ts test/stepLibraryPerformance.test.ts test/stepLibraryPanelContract.test.ts
git commit -m "feat: wire nested scenario resources into library"
```
