import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as sidebarModel from '../src/stepLibrarySidebarModel';
import { buildStepLibrarySnapshot } from '../src/stepLibraryModel';
import * as scenarioFilesWebviewProtocol from '../src/scenarioFilesWebviewProtocol';
import type { StepLibraryItem, StepLibrarySnapshot } from '../src/stepLibraryModel';

interface Disposable {
    dispose(): void;
}

class EventHub<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void): Disposable => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }
}

class FakeWebview {
    html = '';
    options: unknown;
    readonly cspSource = 'vscode-webview-resource:';
    readonly messages: unknown[] = [];
    readonly inbound = new EventHub<unknown>();

    asWebviewUri(uri: { toString(): string }): { toString(): string } {
        return { toString: () => `webview:${uri.toString()}` };
    }

    async postMessage(message: unknown): Promise<boolean> {
        this.messages.push(message);
        return true;
    }

    onDidReceiveMessage(listener: (message: unknown) => void): Disposable {
        return this.inbound.event(listener);
    }
}

class FakeWebviewView {
    readonly webview = new FakeWebview();
    readonly visibilityEvents = new EventHub<void>();
    visible = true;

    onDidChangeVisibility(listener: () => void): Disposable {
        return this.visibilityEvents.event(listener);
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        this.visibilityEvents.fire();
    }
}

function uri(value: string): { toString(): string } {
    return {
        toString: () => value,
        path: value.replace(/^file:\/\//u, ''),
        fsPath: value.replace(/^file:\/\//u, '')
    };
}

function item(index: number, overrides: Partial<StepLibraryItem> = {}): StepLibraryItem {
    const id = overrides.id ?? `item-${index}`;
    const displayText = overrides.displayText ?? `Bulk step ${String(index).padStart(3, '0')}`;
    return Object.freeze({
        id,
        definitionId: overrides.definitionId ?? id,
        familyId: overrides.familyId ?? id,
        kind: overrides.kind ?? 'nestedScenario',
        sourceGroup: overrides.sourceGroup ?? 'nested',
        template: overrides.template ?? displayText,
        displayText,
        categoryPath: Object.freeze([...(overrides.categoryPath ?? ['Tests'])]),
        parameters: Object.freeze([]),
        sourceLabel: overrides.sourceLabel ?? 'Nested scenarios',
        navigable: overrides.navigable ?? true,
        insertable: overrides.insertable ?? true,
        capturedLocation: overrides.capturedLocation ?? {
            uri: `file:///workspace/${id}/scen.yaml`,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        },
        searchText: overrides.searchText ?? displayText.toLowerCase(),
        ...overrides
    });
}

function snapshot(identity: string, items: readonly StepLibraryItem[]): StepLibrarySnapshot {
    return Object.freeze({
        viewIdentity: identity,
        items: Object.freeze([...items]),
        counts: Object.freeze({
            builtIn: items.filter(value => value.sourceGroup === 'builtIn').length,
            user: items.filter(value => value.sourceGroup === 'user').length,
            export: items.filter(value => value.sourceGroup === 'export').length,
            nested: items.filter(value => value.sourceGroup === 'nested').length,
            main: items.filter(value => value.sourceGroup === 'main').length
        })
    });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function flush(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
}

interface HarnessOptions {
    translations?: Readonly<Record<string, string>>;
    readonly ensureReady?: (resource?: unknown) => Promise<StepLibrarySnapshot>;
    readonly initialSnapshot?: StepLibrarySnapshot;
    readonly scenarioFileNodes?: readonly unknown[];
    readonly standalone?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
    const providerPath = path.join(process.cwd(), 'src', 'stepLibrarySidebarProvider.ts');
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(providerPath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const executedCommands: Array<{ command: string; args: unknown[] }> = [];
    const vscode = {
        env: { language: 'en' },
        Uri: {
            joinPath: (base: { toString(): string }, ...segments: string[]) =>
                uri(`${base.toString()}/${segments.join('/')}`)
        },
        commands: {
            executeCommand: async (command: string, ...args: unknown[]) => {
                executedCommands.push({ command, args });
            }
        },
        l10n: { t: (message: string) => options.translations?.[message] ?? message },
        window: { showInputBox: async () => 'Added group', showErrorMessage: async () => undefined }
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return vscode;
            }
            if (specifier === './stepLibrarySidebarModel') {
                return sidebarModel;
            }
            if (specifier === './scenarioFilesWebviewProtocol') {
                return scenarioFilesWebviewProtocol;
            }
            if (specifier === './standaloneFeatureController') {
                const controllerModule = { exports: {} };
                const controllerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'standaloneFeatureController.ts'), 'utf8');
                const controllerCompiled = ts.transpileModule(controllerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
                vm.runInNewContext(controllerCompiled, {
                    module: controllerModule, exports: controllerModule.exports,
                    require: (name: string) => name === 'vscode' ? vscode : { createFeature: async () => undefined, generateFeatureJson: async () => undefined }
                });
                return controllerModule.exports;
            }
            if (specifier === './localization') {
                return { getTranslator: async () => (message: string) => message };
            }
            return require(specifier);
        },
        console,
        setTimeout,
        clearTimeout
    });

    const invalidations = new EventHub<void>();
    const targetChanges = new EventHub<unknown>();
    const relationshipChanges = new EventHub<unknown>();
    const relationshipModeChanges = new EventHub<{ surface: 'testManager' | 'stepLibrary' }>();
    let current = options.initialSnapshot ?? snapshot('initial', []);
    let ensureReadyCalls = 0;
    let invalidateCalls = 0;
    let refreshCalls = 0;
    const inserted: StepLibraryItem[] = [];
    const copied: StepLibraryItem[] = [];
    const opened: StepLibraryItem[] = [];
    const renamed: StepLibraryItem[] = [];
    const renamedGroups: StepLibraryItem[] = [];
    const scenarioFileLists: Array<{ item: StepLibraryItem; relativePath: string }> = [];
    const scenarioFileOpens: Array<{ item: StepLibraryItem; relativePath: string }> = [];
    const scenarioFileReveals: Array<{ item: StepLibraryItem; relativePath: string }> = [];
    const scenarioFileDeletes: Array<{ item: StepLibraryItem; relativePath: string }> = [];
    const scenarioFileRenames: Array<{ item: StepLibraryItem; relativePath: string }> = [];
    let scenarioFileDeleteResult: 'deleted' | 'cancelled' = 'deleted';
    let scenarioFileDeleteError: unknown;
    const scenarioFilesService = {
        renameFile: async (value: StepLibraryItem, relativePath: string) => { scenarioFileRenames.push({ item: value, relativePath }); return 'renamed'; },
        listChildren: async (value: StepLibraryItem, relativePath: string) => {
            scenarioFileLists.push({ item: value, relativePath });
            return options.scenarioFileNodes ?? [];
        },
        openExternal: async (value: StepLibraryItem, relativePath: string) => {
            scenarioFileOpens.push({ item: value, relativePath });
            return true;
        },
        revealInOs: async (value: StepLibraryItem, relativePath: string) => {
            scenarioFileReveals.push({ item: value, relativePath });
            return true;
        },
        deleteFile: async (value: StepLibraryItem, relativePath: string) => {
            scenarioFileDeletes.push({ item: value, relativePath });
            if (scenarioFileDeleteError) {
                throw scenarioFileDeleteError;
            }
            return scenarioFileDeleteResult;
        },
        watch: () => ({ dispose: () => undefined }),
        prepareDrop: async () => ({ files: [], skipped: [] }),
        appendTransferChunk: async (_id: string, offset: number) => offset,
        completeTransfer: async () => undefined,
        cancelTransfer: async () => undefined
    };
    const snapshotService = {
        onDidInvalidate: invalidations.event,
        ensureReady: async (resource?: unknown) => {
            ensureReadyCalls += 1;
            if (options.standalone) {
                return buildStepLibrarySnapshot({ identity: 'standalone-native', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [], new Map(), standaloneSnapshot);
            }
            return options.ensureReady ? options.ensureReady(resource) : current;
        },
        invalidate: () => {
            invalidateCalls += 1;
            invalidations.fire();
        }
    };
    const actionService = {
        onDidChangeInsertionTarget: targetChanges.event,
        getInsertionTargetState: () => ({
            identity: 'file:///workspace/test.feature:1:0',
            available: true,
            resource: uri('file:///workspace/test.feature')
        }),
        insert: async (value: StepLibraryItem) => {
            inserted.push(value);
            return true;
        },
        copy: async (value: StepLibraryItem) => {
            copied.push(value);
            return true;
        },
        openDefinition: async (value: StepLibraryItem) => {
            opened.push(value);
            return true;
        },
        rename: async (value: StepLibraryItem) => { renamed.push(value); return true; },
        renameMainGroup: async (value: StepLibraryItem) => { renamedGroups.push(value); return true; }
    };
    let relationshipState: unknown = {
        enabled: true,
        currentScenarioKeys: [],
        relationships: [],
        affectedMainScenarioKeys: [],
        affectedPhaseNames: [],
        currentLabel: null,
        revision: 0
    };
    const relationshipService = {
        onDidChangeState: relationshipChanges.event,
        getState: () => relationshipState
    };
    let relationshipMode = { highlight: true, filter: false };
    const relationshipPresentation = {
        onDidChangeMode: relationshipModeChanges.event,
        getMode: () => relationshipMode
    };
    const standaloneChanges = new EventHub<unknown>();
    const standaloneSnapshot = { features: [], groups: [] as Array<{ id: string; name: string }>, revision: 1 };
    const standaloneService = {
        getSnapshot: () => standaloneSnapshot,
        ensureReady: async () => standaloneSnapshot,
        refresh: async () => standaloneSnapshot,
        onDidChange: standaloneChanges.event,
        createGroup: async (name: string) => {
            const group = { id: 'group-added', name };
            standaloneSnapshot.groups.push(group);
            standaloneSnapshot.revision += 1;
            standaloneChanges.fire(standaloneSnapshot);
            return group;
        }
    };
    if (options.standalone) { standaloneChanges.event(() => snapshotService.invalidate()); }
    const Provider = moduleObject.exports.StepLibrarySidebarProvider as new (services: unknown) => {
        resolveWebviewView(view: unknown): Promise<void> | void;
        toggleAllGroupsFromSidebar(): void;
        dispose(): void;
    };
    const provider = new Provider({
        extensionUri: uri('file:///extension'),
        snapshotService,
        actionService,
        relationshipService,
        relationshipPresentation,
        scenarioFilesService,
        ...(options.standalone ? { context: {}, standaloneFeatureService: standaloneService } : {}),
        refreshDefinitions: async () => {
            refreshCalls += 1;
        }
    });
    const view = new FakeWebviewView();
    void provider.resolveWebviewView(view);

    return {
        provider,
        view,
        invalidations,
        targetChanges,
        relationshipChanges,
        relationshipModeChanges,
        executedCommands,
        inserted,
        copied,
        opened,
        renamed,
        renamedGroups,
        standaloneChanges,
        standaloneSnapshot,
        scenarioFileLists,
        scenarioFileOpens,
        scenarioFileReveals,
        scenarioFileDeletes,
        scenarioFileRenames,
        setScenarioFileDeleteResult(value: 'deleted' | 'cancelled') {
            scenarioFileDeleteResult = value;
            scenarioFileDeleteError = undefined;
        },
        setScenarioFileDeleteError(value: unknown) { scenarioFileDeleteError = value; },
        setSnapshot(value: StepLibrarySnapshot) { current = value; },
        setRelationshipState(value: unknown) { relationshipState = value; },
        setRelationshipMode(value: { highlight: boolean; filter: boolean }) { relationshipMode = value; },
        get ensureReadyCalls() { return ensureReadyCalls; },
        get invalidateCalls() { return invalidateCalls; },
        get refreshCalls() { return refreshCalls; }
    };
}

test('scenario Files expansion stays lazy and does not reload the sidebar snapshot', async () => {
    const definition = item(1, {
        id: 'nested-files',
        hasScenarioFiles: true
    });
    const nodes = [{
        id: 'resource-file',
        kind: 'file',
        itemId: definition.id,
        name: 'Expected.xlsx',
        relativePath: 'Expected.xlsx',
        depth: 1,
        expandable: false
    }];
    const harness = createHarness({
        initialSnapshot: snapshot('catalog:files', [definition]),
        scenarioFileNodes: nodes
    });
    await send(harness, { command: 'ready' });

    await send(harness, {
        command: 'listScenarioFiles',
        itemId: definition.id,
        relativePath: '',
        requestId: 'scenario-file-root'
    });

    assert.equal(harness.ensureReadyCalls, 1);
    assert.deepEqual(harness.scenarioFileLists.map(entry => [entry.item.id, entry.relativePath]), [
        [definition.id, '']
    ]);
    const response = harness.view.webview.messages.at(-1) as any;
    assert.equal(response.command, 'scenarioFileChildren');
    assert.equal(response.requestId, 'scenario-file-root');
    assert.deepEqual(response.nodes, nodes);

    await send(harness, {
        command: 'openScenarioFile',
        itemId: definition.id,
        relativePath: 'Expected.xlsx'
    });
    await send(harness, {
        command: 'revealScenarioFile',
        itemId: definition.id,
        relativePath: 'Expected.xlsx'
    });
    assert.deepEqual(harness.scenarioFileOpens.map(entry => entry.item), [definition]);
    assert.deepEqual(harness.scenarioFileReveals.map(entry => entry.item), [definition]);
});

test('compact Library integrates standalone groups in native roots and replays hidden changes', async () => {
    const harness = createHarness({ standalone: true });
    await send(harness, { command: 'ready' });
    const rootMessages = () => harness.view.webview.messages.filter((value: any) => value.command === 'roots');
    assert.ok((rootMessages().at(-1) as any).nodes.some((node: any) => node.id === 'source:standalone'));
    assert.equal(harness.view.webview.messages.some((value: any) => value.command === 'standaloneFeatures'), false);
    await send(harness, { command: 'standaloneFeatureAction', action: 'createGroup' });
    assert.equal(harness.standaloneSnapshot.groups[0]?.name, 'Added group');
    await send(harness, { command: 'expand', nodeId: 'source:standalone', offset: 0 });
    const children = harness.view.webview.messages.at(-1) as any;
    assert.equal(children.nodes[0].label, 'Ungrouped');
    assert.equal(children.nodes[1].label, 'Added group');
    assert.equal(children.nodes[1].groupId, 'group-added');
    harness.view.setVisible(false);
    const count = rootMessages().length;
    harness.standaloneSnapshot.revision = 5;
    harness.standaloneChanges.fire(harness.standaloneSnapshot);
    await flush();
    assert.equal(rootMessages().length, count);
    harness.view.setVisible(true);
    await flush();
    assert.equal(rootMessages().length, count + 1);
    harness.provider.dispose();
    const disposedCount = harness.view.webview.messages.length;
    harness.standaloneChanges.fire(harness.standaloneSnapshot);
    await flush();
    assert.equal(harness.view.webview.messages.length, disposedCount);
});

test('compact Library reports attachment deletion success cancellation and failure', async () => {
    const definition = item(1, {
        id: 'nested-delete',
        hasScenarioFiles: true
    });
    const harness = createHarness({
        initialSnapshot: snapshot('catalog:delete', [definition])
    });
    await send(harness, { command: 'ready' });

    await send(harness, {
        command: 'deleteScenarioFile',
        itemId: definition.id,
        relativePath: 'Folder\\Input.xlsx'
    });
    assert.deepEqual(
        harness.scenarioFileDeletes.map(entry => [entry.item.id, entry.relativePath]),
        [[definition.id, 'Folder/Input.xlsx']]
    );
    assert.deepEqual(JSON.parse(JSON.stringify(harness.view.webview.messages.at(-1))), {
        command: 'scenarioFileActionResult',
        action: 'delete',
        itemId: definition.id,
        relativePath: 'Folder/Input.xlsx',
        succeeded: true
    });

    harness.setScenarioFileDeleteResult('cancelled');
    await send(harness, {
        command: 'deleteScenarioFile',
        itemId: definition.id,
        relativePath: 'Cancelled.xlsx'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.view.webview.messages.at(-1))), {
        command: 'scenarioFileActionResult',
        action: 'delete',
        itemId: definition.id,
        relativePath: 'Cancelled.xlsx',
        succeeded: false,
        cancelled: true
    });

    harness.setScenarioFileDeleteError(new Error('Delete denied'));
    const successCount = harness.view.webview.messages.filter(
        (message: any) => message.command === 'scenarioFileActionResult'
            && message.action === 'delete'
            && message.succeeded
    ).length;
    await send(harness, {
        command: 'deleteScenarioFile',
        itemId: definition.id,
        relativePath: 'Denied.xlsx'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.view.webview.messages.at(-1))), {
        command: 'scenarioFileTransferFailed',
        message: 'Delete denied'
    });
    assert.equal(harness.view.webview.messages.filter(
        (message: any) => message.command === 'scenarioFileActionResult'
            && message.action === 'delete'
            && message.succeeded
    ).length, successCount);
});

test('scenario file failures preserve request and drop identities for browser cleanup', async () => {
    const harness = createHarness({ initialSnapshot: snapshot('catalog:files', []) });
    await send(harness, { command: 'ready' });

    await send(harness, {
        command: 'listScenarioFiles',
        itemId: 'missing-item',
        relativePath: '',
        requestId: 'missing-request'
    });
    const requestFailure = harness.view.webview.messages.at(-1) as any;
    assert.equal(requestFailure.command, 'scenarioFileTransferFailed');
    assert.equal(requestFailure.requestId, 'missing-request');
    assert.equal(requestFailure.message, 'Unknown scenario file item.');

    await send(harness, {
        command: 'prepareScenarioFileDrop',
        dropId: 'missing-drop',
        itemId: 'missing-item',
        targetRelativePath: '',
        entries: []
    });
    const dropFailure = harness.view.webview.messages.at(-1) as any;
    assert.equal(dropFailure.command, 'scenarioFileTransferFailed');
    assert.equal(dropFailure.dropId, 'missing-drop');
    assert.equal(dropFailure.message, 'Unknown scenario file item.');
});

async function send(harness: ReturnType<typeof createHarness>, message: unknown): Promise<void> {
    harness.view.webview.inbound.fire(message);
    await flush();
}

test('initial ready posts loading and seven roots without transferring the snapshot', async () => {
    const catalog = snapshot('catalog:one', [item(1)]);
    const harness = createHarness({ initialSnapshot: catalog });

    assert.equal(harness.ensureReadyCalls, 0);
    await send(harness, { command: 'ready' });

    assert.equal(harness.ensureReadyCalls, 1);
    assert.equal((harness.view.webview.messages[0] as any).command, 'loading');
    const roots = harness.view.webview.messages.find((message: any) => message.command === 'roots') as any;
    assert.equal(roots.identity, 'catalog:one');
    assert.equal(roots.nodes.length, 7);
    assert.equal(roots.nodes[4].count, 1);
    assert.equal(Object.hasOwn(roots, 'snapshot'), false);
    assert.doesNotMatch(JSON.stringify(roots), /Bulk step 001/u);
});

test('compact Library localizes source section titles while retaining authored business group names', async () => {
    const h = createHarness({ translations: { 'Main scenarios': 'Главные сценарии', Processes: 'Процессы' },
        initialSnapshot: snapshot('localized-types', [item(1, { kind: 'process', sourceGroup: 'process', categoryPath: ['Processes'] })]) });
    await send(h, { command: 'ready' });
    const roots = h.view.webview.messages.find((message: any) => message.command === 'roots') as any;
    assert.equal(roots.nodes.find((node: any) => node.id === 'source:main').label, 'Главные сценарии');
    assert.equal(roots.nodes.find((node: any) => node.id === 'source:process').label, 'Процессы');
    await send(h, { command: 'expand', nodeId: 'source:process', offset: 0 });
    assert.equal((h.view.webview.messages.at(-1) as any).nodes[0].label, 'Processes');
});

test('expand and search return bounded host-side pages only', async () => {
    const catalog = snapshot('catalog:bulk', Array.from({ length: 180 }, (_, index) => item(index)));
    const harness = createHarness({ initialSnapshot: catalog });
    await send(harness, { command: 'ready' });
    await send(harness, { command: 'expand', nodeId: 'source:nested', offset: 0 });
    const sourceChildren = harness.view.webview.messages.at(-1) as any;
    const category = sourceChildren.nodes.find((node: any) => node.kind === 'category');

    await send(harness, { command: 'expand', nodeId: category.id, offset: 0 });
    const page = harness.view.webview.messages.at(-1) as any;
    assert.equal(page.command, 'children');
    assert.equal(page.nodes.filter((node: any) => node.kind === 'definition').length, 100);
    assert.equal(page.nodes.at(-1).kind, 'more');
    assert.equal(page.nextOffset, 100);

    await send(harness, { command: 'search', query: 'bulk step' });
    const results = harness.view.webview.messages.at(-1) as any;
    assert.equal(results.command, 'searchResults');
    assert.equal(results.nodes.length, 100);
});

test('relationship filter pages the related definitions instead of raw catalog batches', async () => {
    const relatedScenarioKey = 'file:///workspace/related/scen.yaml';
    const definitions = Array.from({ length: 180 }, (_, index) => item(index, {
        scenarioKey: index === 179 ? relatedScenarioKey : `file:///workspace/unrelated-${index}/scen.yaml`
    }));
    const harness = createHarness({ initialSnapshot: snapshot('catalog:related-page', definitions) });
    harness.setRelationshipState({
        enabled: true,
        currentScenarioKeys: [relatedScenarioKey],
        relationships: [],
        affectedMainScenarioKeys: [],
        affectedPhaseNames: [],
        currentLabel: 'Bulk step 179',
        revision: 1
    });
    harness.setRelationshipMode({ highlight: true, filter: true });

    await send(harness, { command: 'ready' });
    const roots = harness.view.webview.messages.at(-1) as any;
    assert.equal(roots.relationshipVisibleCounts['source:nested'], 1);
    await send(harness, { command: 'expand', nodeId: 'source:nested', offset: 0 });
    const sourceChildren = harness.view.webview.messages.at(-1) as any;
    const category = sourceChildren.nodes.find((node: any) => node.kind === 'category');

    await send(harness, { command: 'expand', nodeId: category.id, offset: 0 });
    const page = harness.view.webview.messages.at(-1) as any;

    assert.deepEqual(
        page.nodes.map((node: any) => [node.kind, node.itemId]),
        [['definition', 'item-179']]
    );
    assert.equal(page.nextOffset, null);
});

test('ignores invalid inbound messages and resolves actions from server-owned items', async () => {
    const definition = item(1, { id: 'safe-item' });
    const harness = createHarness({ initialSnapshot: snapshot('catalog:actions', [definition]) });
    await send(harness, { command: 'ready' });
    const baseline = harness.view.webview.messages.length;

    await send(harness, { command: 'expand', nodeId: '', offset: -1 });
    await send(harness, { command: 'search', query: 42 });
    await send(harness, { command: 'insert', itemId: '../unsafe' });
    assert.equal(harness.view.webview.messages.length, baseline);
    assert.equal(harness.inserted.length, 0);

    await send(harness, { command: 'insert', itemId: 'safe-item' });
    await send(harness, { command: 'copy', itemId: 'safe-item' });
    await send(harness, { command: 'openDefinition', itemId: 'safe-item' });
    await send(harness, { command: 'rename', itemId: 'safe-item', uri: 'file:///forged/scen.yaml' });
    await send(harness, { command: 'renameMainGroup', itemId: 'safe-item', groupName: 'Forged' });
    await send(harness, { command: 'renameMainGroup', itemId: 'unknown' });
    assert.deepEqual(harness.inserted.map(value => value.id), ['safe-item']);
    assert.deepEqual(harness.copied.map(value => value.id), ['safe-item']);
    assert.deepEqual(harness.opened.map(value => value.id), ['safe-item']);
    assert.deepEqual(harness.renamed, [definition]);
    assert.deepEqual(harness.renamedGroups, [definition]);
});

test('discards stale generations and publishes only the newest snapshot', async () => {
    const first = deferred<StepLibrarySnapshot>();
    const second = deferred<StepLibrarySnapshot>();
    const loads = [first, second];
    const harness = createHarness({ ensureReady: async () => loads.shift()!.promise });

    harness.view.webview.inbound.fire({ command: 'ready' });
    await flush();
    harness.invalidations.fire();
    await flush();
    assert.equal(harness.ensureReadyCalls, 2);

    second.resolve(snapshot('catalog:new', [item(2)]));
    await flush();
    first.resolve(snapshot('catalog:old', [item(1)]));
    await flush();

    const identities = harness.view.webview.messages
        .filter((message: any) => message.command === 'roots')
        .map((message: any) => message.identity);
    assert.deepEqual(identities, ['catalog:new']);
});

test('defers hidden invalidation and publishes the latest revision when shown again', async () => {
    const harness = createHarness({ initialSnapshot: snapshot('catalog:first', [item(1)]) });
    await send(harness, { command: 'ready' });
    harness.view.setVisible(false);
    harness.setSnapshot(snapshot('catalog:latest', [item(2)]));
    harness.invalidations.fire();
    await flush();

    assert.equal(harness.ensureReadyCalls, 1);
    harness.view.setVisible(true);
    await flush();
    assert.equal(harness.ensureReadyCalls, 2);
    const roots = harness.view.webview.messages.filter((message: any) => message.command === 'roots') as any[];
    assert.deepEqual(roots.map(message => message.identity), ['catalog:first', 'catalog:latest']);
    assert.ok(roots[1].revision > roots[0].revision);
});

test('visible invalidation keeps the rendered tree while the replacement snapshot loads', async () => {
    const next = deferred<StepLibrarySnapshot>();
    let firstLoad = true;
    const harness = createHarness({
        ensureReady: async () => {
            if (firstLoad) {
                firstLoad = false;
                return snapshot('catalog:first', [item(1)]);
            }
            return next.promise;
        }
    });
    await send(harness, { command: 'ready' });

    harness.invalidations.fire();
    await flush();

    const loading = harness.view.webview.messages.at(-1) as { command: string; retainItems?: boolean };
    assert.equal(loading.command, 'loading');
    assert.equal(loading.retainItems, true);

    next.resolve(snapshot('catalog:next', [item(2)]));
    await flush();
    assert.equal((harness.view.webview.messages.at(-1) as { identity: string }).identity, 'catalog:next');
});

test('refreshes the shared catalog and opens the full library command', async () => {
    const harness = createHarness({ initialSnapshot: snapshot('catalog:one', []) });
    await send(harness, { command: 'ready' });
    await send(harness, { command: 'refresh' });
    await send(harness, { command: 'openFullLibrary' });

    assert.equal(harness.refreshCalls, 1);
    assert.equal(harness.invalidateCalls, 1);
    assert.deepEqual(harness.executedCommands, [{
        command: 'kotTestToolkit.openStepLibrary',
        args: []
    }]);
});

test('native Library title action delegates expand or collapse to the webview', async () => {
    const harness = createHarness({ initialSnapshot: snapshot('catalog:one', []) });

    harness.provider.toggleAllGroupsFromSidebar();
    await flush();

    assert.deepEqual(
        harness.view.webview.messages.map((message: any) => message.command),
        ['toggleAllGroups']
    );
});

test('relationship updates are lightweight and do not rebuild the catalog', async () => {
    const scenarioKey = 'file:///workspace/item-1/scen.yaml';
    const harness = createHarness({
        initialSnapshot: snapshot('catalog:one', [item(1, { scenarioKey })])
    });
    await send(harness, { command: 'ready' });
    const nextState = {
        enabled: true,
        currentScenarioKeys: [scenarioKey],
        relationships: [],
        affectedMainScenarioKeys: [],
        affectedPhaseNames: [],
        currentLabel: 'Bulk step 001',
        revision: 1
    };
    harness.setRelationshipState(nextState);
    harness.relationshipChanges.fire(nextState);
    await flush();

    assert.equal(harness.ensureReadyCalls, 1);
    const message = harness.view.webview.messages.at(-1) as any;
    assert.equal(message.command, 'relationshipState');
    assert.equal(message.relationshipState.enabled, true);
    assert.equal(message.relationshipFilterEnabled, false);
    assert.deepEqual([...message.relatedAncestorIds], [
        'category:nested:Tests',
        'source:nested'
    ]);
});

test('Library relationship mode is independent and includes related export definitions', async () => {
    const exported = item(1, {
        id: 'export:shared#authored',
        definitionId: 'export:shared',
        kind: 'exportScenario',
        sourceGroup: 'export',
        categoryPath: ['Shared'],
        scenarioKey: undefined
    });
    const harness = createHarness({
        initialSnapshot: snapshot('catalog:export', [exported])
    });
    harness.setRelationshipState({
        enabled: false,
        currentScenarioKeys: [],
        relationships: [],
        currentDefinitionIds: [],
        definitionRelationships: [{ definitionId: 'export:shared', outgoingDistance: 1 }],
        affectedMainScenarioKeys: [],
        affectedPhaseNames: [],
        currentLabel: 'Main',
        revision: 1
    });
    harness.setRelationshipMode({ highlight: false, filter: true });

    await send(harness, { command: 'ready' });
    let message = harness.view.webview.messages.find((entry: any) => entry.command === 'roots') as any;
    assert.equal(message.relationshipState.enabled, false);
    assert.equal(message.relationshipFilterEnabled, true);
    assert.deepEqual([...message.relatedItemIds], ['export:shared#authored']);
    assert.deepEqual([...message.relatedAncestorIds], ['category:export:Shared', 'source:export']);

    harness.setRelationshipMode({ highlight: true, filter: false });
    harness.relationshipModeChanges.fire({ surface: 'stepLibrary' });
    await flush();

    message = harness.view.webview.messages.at(-1) as any;
    assert.equal(message.command, 'relationshipState');
    assert.equal(message.relationshipState.enabled, true);
    assert.equal(message.relationshipFilterEnabled, false);
    assert.equal(harness.ensureReadyCalls, 1);
});


test('compact Library file actions resolve authored roots independently of compiled files', async () => {
    const definition = item(1, { id: 'main-file-roots', kind: 'mainScenario', sourceGroup: 'main', hasScenarioFiles: true,
        sourceScenarioFilesRootUri: 'file:///source/files', scenarioFilesRootUri: 'file:///build/Файлы' });
    const h = createHarness({ initialSnapshot: snapshot('file-roots', [definition]) });
    await send(h, { command: 'ready' });
    await send(h, { command: 'listScenarioFiles', itemId: definition.id, resource: 'source', relativePath: '', requestId: 'source-root' });
    assert.equal(h.scenarioFileLists[0].item.scenarioFilesRootUri, 'file:///source/files');
    await send(h, { command: 'renameScenarioFile', itemId: definition.id, resource: 'source', relativePath: 'Data.csv' });
    assert.equal(h.scenarioFileRenames[0].item.scenarioFilesRootUri, 'file:///source/files');
    assert.equal(h.view.webview.messages.at(-1).action, 'rename');
    await send(h, { command: 'openScenarioFile', itemId: definition.id, relativePath: 'Generated.csv' });
    assert.equal(h.scenarioFileOpens[0].item.scenarioFilesRootUri, 'file:///build/Файлы');
});
