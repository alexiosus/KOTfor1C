import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as stepLibraryModel from '../src/stepLibraryModel';
import * as scenarioFilesWebviewProtocol from '../src/scenarioFilesWebviewProtocol';
import * as projectDefinitionSnippet from '../src/projectDefinitionSnippet';
import { getGherkinInsertionContext as actualInsertionContext } from '../src/gherkinInsertionContext';
import { StepLibraryActionService } from '../src/stepLibraryActions';
import { StepLibrarySnapshotService } from '../src/stepLibrarySnapshotService';
import type { ProjectDefinition } from '../src/projectDefinition';
import type { ProjectDefinitionView } from '../src/projectDefinition';
import type { TestInfo } from '../src/types';

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

class FakePanel {
    readonly webview = new FakeWebview();
    readonly disposeEvents = new EventHub<void>();
    readonly viewStateEvents = new EventHub<{ webviewPanel: FakePanel }>();
    visible = true;
    title = '';
    disposed = false;

    reveal(): void {
        this.visible = true;
    }

    onDidDispose(listener: () => void): Disposable {
        return this.disposeEvents.event(listener);
    }

    onDidChangeViewState(
        listener: (event: { webviewPanel: FakePanel }) => void
    ): Disposable {
        return this.viewStateEvents.event(listener);
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        this.viewStateEvents.fire({ webviewPanel: this });
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.disposeEvents.fire();
    }
}

function uri(value: string): { toString(): string } {
    return {
        toString: () => value,
        path: value.replace(/^file:\/\//u, ''),
        fsPath: value.replace(/^file:\/\//u, '')
    } as { toString(): string };
}

function view(identity: string): ProjectDefinitionView {
    return {
        identity,
        all: [],
        byId: new Map(),
        byNormalizedTemplate: new Map()
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

interface PanelRuntime {
    activeEditor: any;
    visibleEditors: any[];
    readonly activeEditorEvents: EventHub<any>;
    readonly selectionEvents: EventHub<any>;
    readonly documentEvents: EventHub<any>;
    readonly clipboardWrites: string[];
    readonly navigationCalls: any[][];
    insertionContextCalls: number;
}

class FakeSnippetString {
    constructor(readonly value: string) {}
}

function createRuntime(activeEditor?: any): PanelRuntime {
    return {
        activeEditor,
        visibleEditors: activeEditor ? [activeEditor] : [],
        activeEditorEvents: new EventHub<any>(),
        selectionEvents: new EventHub<any>(),
        documentEvents: new EventHub<any>(),
        clipboardWrites: [],
        navigationCalls: [],
        insertionContextCalls: 0
    };
}

function loadPanelModule(
    fakePanel: FakePanel,
    runtime: PanelRuntime
): Record<string, unknown> {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'stepLibraryPanel.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const vscode = {
        ViewColumn: { One: 1 },
        Position: class {
            constructor(readonly line: number, readonly character: number) {}
        },
        Selection: class {
            constructor(readonly anchor: unknown, readonly active: unknown) {}
        },
        SnippetString: FakeSnippetString,
        Uri: {
            joinPath: (base: { toString(): string }, ...segments: string[]) =>
                uri(`${base.toString()}/${segments.join('/')}`),
            parse: (value: string) => uri(value)
        },
        window: {
            createWebviewPanel: (_viewType: string, title: string) => {
                fakePanel.title = title;
                return fakePanel;
            },
            get activeTextEditor() { return runtime.activeEditor; },
            get visibleTextEditors() { return runtime.visibleEditors; },
            onDidChangeActiveTextEditor: runtime.activeEditorEvents.event,
            onDidChangeTextEditorSelection: runtime.selectionEvents.event
        },
        workspace: {
            onDidChangeTextDocument: runtime.documentEvents.event
        },
        env: {
            clipboard: {
                writeText: async (value: string) => {
                    runtime.clipboardWrites.push(value);
                }
            }
        }
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return vscode;
            }
            if (specifier === './stepLibraryModel') {
                return stepLibraryModel;
            }
            if (specifier === './scenarioFilesWebviewProtocol') {
                return scenarioFilesWebviewProtocol;
            }
            if (specifier === './projectDefinitionSnippet') {
                return projectDefinitionSnippet;
            }
            if (specifier === './gherkinInsertionContext') {
                return {
                    getGherkinInsertionContext: (...args: Parameters<typeof actualInsertionContext>) => {
                        runtime.insertionContextCalls += 1;
                        return actualInsertionContext(...args);
                    }
                };
            }
            if (specifier === './projectDefinitionNavigation') {
                return {
                    openProjectDefinitionHandler: async (...args: any[]) => {
                        runtime.navigationCalls.push(args);
                        return true;
                    }
                };
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
    return moduleObject.exports;
}

function createHarness(
    getView: (resource?: unknown) => Promise<ProjectDefinitionView>,
    activeEditor?: any,
    getScenarios: () => readonly TestInfo[] = () => [],
    ensureReady: (resource?: unknown) => Promise<ProjectDefinitionView> = getView
) {
    const fakePanel = new FakePanel();
    const runtime = createRuntime(activeEditor);
    const moduleExports = loadPanelModule(fakePanel, runtime);
    const Panel = moduleExports.StepLibraryPanel as new (services: unknown) => {
        open(resource?: unknown): Promise<void>;
        dispose(): void;
    };
    const changes = new EventHub<unknown>();
    const scenarioChanges = new EventHub<unknown>();
    let refreshDefinitionsCalls = 0;
    const scenarioFileNodes = [{
        id: 'scenario-file:nested:file:Fixtures/Input.xlsx',
        kind: 'file',
        itemId: '',
        name: 'Input.xlsx',
        relativePath: 'Fixtures/Input.xlsx',
        depth: 2,
        expandable: false
    }];
    let scenarioFileDeleteResult: 'deleted' | 'cancelled' = 'deleted';
    let scenarioFileDeleteError: unknown;
    let activeScenarioFileWatches = 0;
    const scenarioFiles = {
        listCalls: [] as Array<{ item: any; relativePath: string }>,
        openCalls: [] as Array<{ item: any; relativePath: string }>,
        revealCalls: [] as Array<{ item: any; relativePath: string }>,
        deleteCalls: [] as Array<{ item: any; relativePath: string }>,
        async listChildren(item: any, relativePath: string) {
            scenarioFiles.listCalls.push({ item, relativePath });
            return scenarioFileNodes.map(node => ({ ...node, itemId: item.id }));
        },
        async openExternal(item: any, relativePath: string) {
            scenarioFiles.openCalls.push({ item, relativePath });
            return true;
        },
        async revealInOs(item: any, relativePath: string) {
            scenarioFiles.revealCalls.push({ item, relativePath });
            return true;
        },
        async deleteFile(item: any, relativePath: string) {
            scenarioFiles.deleteCalls.push({ item, relativePath });
            if (scenarioFileDeleteError) {
                throw scenarioFileDeleteError;
            }
            return scenarioFileDeleteResult;
        },
        watch() {
            activeScenarioFileWatches += 1;
            let active = true;
            return {
                dispose: () => {
                    if (active) {
                        active = false;
                        activeScenarioFileWatches -= 1;
                    }
                }
            };
        },
        async prepareDrop() { return { files: [], skipped: [] }; },
        async appendTransferChunk(_transferId: string, offset: number) { return offset; },
        async completeTransfer() { return undefined; },
        async cancelTransfer() { return undefined; }
    };
    const resolver = {
        getView,
        ensureReady,
        onDidChangeView: changes.event
    };
    const snapshotService = new StepLibrarySnapshotService({
        resolver,
        scenarios: {
            getScenarioCatalog: () => ({
                all: getScenarios(),
                byName: new Map(),
                byUri: new Map(),
                primaryByName: new Map()
            }),
            onDidUpdateScenarioCatalog: scenarioChanges.event
        }
    });
    const actionService = new StepLibraryActionService({
        resolver,
        openDefinition: async (...args: any[]) => {
            runtime.navigationCalls.push(args);
            return true;
        },
        host: {
            getActiveTextEditor: () => runtime.activeEditor,
            onDidChangeActiveTextEditor: runtime.activeEditorEvents.event,
            onDidChangeTextEditorSelection: runtime.selectionEvents.event,
            onDidChangeTextDocument: runtime.documentEvents.event,
            createPosition: (line, character) => ({ line, character }) as any,
            createSelection: (anchor, active) => ({ anchor, active }) as any,
            createSnippetString: value => new FakeSnippetString(value) as any,
            writeClipboardText: async value => {
                runtime.clipboardWrites.push(value);
            }
        }
    });
    const panel = new Panel({
        extensionUri: uri('file:///extension'),
        snapshotService,
        actionService,
        scenarioFilesService: scenarioFiles,
        refreshDefinitions: async () => {
            refreshDefinitionsCalls += 1;
        }
    });
    return {
        panel,
        fakePanel,
        runtime,
        changes,
        scenarioFiles,
        get activeScenarioFileWatches() { return activeScenarioFileWatches; },
        setScenarioFileDeleteResult(value: 'deleted' | 'cancelled') {
            scenarioFileDeleteResult = value;
            scenarioFileDeleteError = undefined;
        },
        setScenarioFileDeleteError(value: unknown) { scenarioFileDeleteError = value; },
        get refreshDefinitionsCalls() { return refreshDefinitionsCalls; }
    };
}

function projectDefinition(
    overrides: Partial<ProjectDefinition> & Pick<ProjectDefinition, 'id' | 'kind' | 'template'>
): ProjectDefinition {
    return {
        normalizedTemplate: overrides.template.replace(/\s+/gu, ' ').trim(),
        parameters: [],
        sourceLabel: 'Project definitions',
        language: 'en',
        ...overrides
    };
}

function definitionView(identity: string, definitions: readonly ProjectDefinition[]): ProjectDefinitionView {
    return {
        identity,
        all: definitions,
        byId: new Map(definitions.map(definition => [definition.id, definition])),
        byNormalizedTemplate: new Map()
    };
}

function createFeatureEditor(initialText = [
    '#language: en',
    'Feature: Demo',
    'Scenario: Search',
    '    '
].join('\n')): any {
    const document: any = {
        uri: uri('file:///workspace/test.feature'),
        languageId: 'gherkin',
        fileName: '/workspace/test.feature',
        version: 1,
        text: initialText,
        getText: () => document.text,
        lineAt: (line: number) => {
            const lines = document.text.split(/\r\n|\r|\n/u);
            if (line < 0 || line >= lines.length) {
                throw new RangeError('stale line');
            }
            return { text: lines[line] };
        }
    };
    const insertionPosition = { line: 3, character: 4 };
    const editor: any = {
        document,
        selections: [{ anchor: insertionPosition, active: insertionPosition }],
        inserted: [] as Array<{ value: string; selections: unknown[] }>,
        async insertSnippet(snippet: FakeSnippetString, selections: unknown[]) {
            editor.inserted.push({ value: snippet.value, selections });
            return true;
        }
    };
    return editor;
}

function createYamlEditorAtBlankColumnZero(): any {
    const editor = createFeatureEditor([
        'ТипФайла: Сценарий',
        'ТекстСценария: |',
        '    Тогда форма открыта',
        ''
    ].join('\n'));
    editor.document.uri = uri('file:///workspace/test.yaml');
    editor.document.languageId = 'yaml';
    editor.document.fileName = '/workspace/test.yaml';
    const position = { line: 3, character: 0 };
    editor.selections = [{ anchor: position, active: position }];
    return editor;
}

async function sendWebviewMessage(harness: ReturnType<typeof createHarness>, message: unknown): Promise<void> {
    harness.fakePanel.webview.inbound.fire(message);
    await flush();
    await flush();
}

test('full Library uses the same branded title on creation and reopen', async () => {
    const harness = createHarness(async () => view('view:title'));

    await harness.panel.open();
    assert.equal(harness.fakePanel.title, 'KOT for 1C: Library');

    harness.fakePanel.title = 'Changed by host';
    await harness.panel.open();
    assert.equal(harness.fakePanel.title, 'KOT for 1C: Library');
    assert.match(harness.fakePanel.webview.html, /KOT for 1C: Library/u);
});

test('initial open waits for physically routed project definitions', async () => {
    const exportDefinition = projectDefinition({
        id: 'export:ready',
        kind: 'exportScenario',
        template: 'Window is ready'
    });
    const harness = createHarness(
        async () => view('view:unavailable'),
        undefined,
        () => [],
        async () => definitionView('view:ready', [exportDefinition])
    );

    await harness.panel.open(uri('file:///alias/libraries/exports.feature'));

    const snapshot = harness.fakePanel.webview.messages.find(
        (message: any) => message.command === 'snapshot'
    ) as any;
    assert.equal(snapshot.snapshot.counts.export, 1);
});

test('full panel resolves resource messages through the shared scenario files service', async () => {
    const nested = projectDefinition({
        id: 'nested:resources',
        kind: 'nestedScenario',
        template: 'Create invoice',
        definitionLocation: {
            uri: 'file:///workspace/CreateInvoice/scen.yaml',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        }
    });
    const harness = createHarness(async () => definitionView('view:resources', [nested]));
    await harness.panel.open(uri('file:///workspace/test.feature'));
    const snapshot = harness.fakePanel.webview.messages.find(
        (message: any) => message.command === 'snapshot'
    ) as any;
    const item = snapshot.snapshot.items.find((candidate: any) => candidate.hasScenarioFiles);

    await sendWebviewMessage(harness, {
        command: 'listScenarioFiles',
        itemId: item.id,
        relativePath: 'Fixtures',
        requestId: 'request-1'
    });

    assert.equal(harness.scenarioFiles.listCalls.length, 1);
    assert.equal(harness.scenarioFiles.listCalls[0].item.id, item.id);
    assert.equal(harness.scenarioFiles.listCalls[0].relativePath, 'Fixtures');
    const response = harness.fakePanel.webview.messages.at(-1) as any;
    assert.equal(response.command, 'scenarioFileChildren');
    assert.equal(response.requestId, 'request-1');
    assert.equal(response.itemId, item.id);
    assert.equal(response.relativePath, 'Fixtures');
    assert.equal(response.nodes[0].name, 'Input.xlsx');
});

test('full panel reports attachment deletion success cancellation and failure', async () => {
    const nested = projectDefinition({
        id: 'nested:delete',
        kind: 'nestedScenario',
        template: 'Delete attachment',
        definitionLocation: {
            uri: 'file:///workspace/DeleteAttachment/scen.yaml',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        }
    });
    const harness = createHarness(async () => definitionView('view:delete', [nested]));
    await harness.panel.open(uri('file:///workspace/test.feature'));
    const snapshotMessage = harness.fakePanel.webview.messages.find(
        (message: any) => message.command === 'snapshot'
    ) as any;
    const item = snapshotMessage.snapshot.items.find((candidate: any) => candidate.hasScenarioFiles);

    await sendWebviewMessage(harness, {
        command: 'deleteScenarioFile',
        itemId: item.id,
        relativePath: 'Folder\\Input.xlsx'
    });
    assert.deepEqual(
        harness.scenarioFiles.deleteCalls.map(entry => [entry.item.id, entry.relativePath]),
        [[item.id, 'Folder/Input.xlsx']]
    );
    assert.deepEqual(JSON.parse(JSON.stringify(harness.fakePanel.webview.messages.at(-1))), {
        command: 'scenarioFileActionResult',
        action: 'delete',
        itemId: item.id,
        relativePath: 'Folder/Input.xlsx',
        succeeded: true
    });

    harness.setScenarioFileDeleteResult('cancelled');
    await sendWebviewMessage(harness, {
        command: 'deleteScenarioFile',
        itemId: item.id,
        relativePath: 'Cancelled.xlsx'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.fakePanel.webview.messages.at(-1))), {
        command: 'scenarioFileActionResult',
        action: 'delete',
        itemId: item.id,
        relativePath: 'Cancelled.xlsx',
        succeeded: false,
        cancelled: true
    });

    harness.setScenarioFileDeleteError(new Error('Delete denied'));
    const successCount = harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'scenarioFileActionResult'
            && message.action === 'delete'
            && message.succeeded
    ).length;
    await sendWebviewMessage(harness, {
        command: 'deleteScenarioFile',
        itemId: item.id,
        relativePath: 'Denied.xlsx'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.fakePanel.webview.messages.at(-1))), {
        command: 'scenarioFileTransferFailed',
        message: 'Delete denied'
    });
    assert.equal(harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'scenarioFileActionResult'
            && message.action === 'delete'
            && message.succeeded
    ).length, successCount);
});

test('drops an older resolver result that completes after a newer load', async () => {
    const first = deferred<ProjectDefinitionView>();
    const second = deferred<ProjectDefinitionView>();
    const requests = [first, second];
    const harness = createHarness(async () => requests.shift()!.promise);

    const olderOpen = harness.panel.open(uri('file:///workspace/old.feature'));
    await flush();
    const newerOpen = harness.panel.open(uri('file:///workspace/new.feature'));
    second.resolve(view('view:new'));
    await newerOpen;
    first.resolve(view('view:old'));
    await olderOpen;

    const snapshots = harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'snapshot'
    ) as any[];
    assert.deepEqual(snapshots.map(message => message.snapshot.viewIdentity), ['view:new']);
});

test('does not start a duplicate resolver load when the webview becomes ready', async () => {
    const pending = deferred<ProjectDefinitionView>();
    let calls = 0;
    const harness = createHarness(async () => {
        calls += 1;
        return pending.promise;
    });

    const opening = harness.panel.open(uri('file:///workspace/test.feature'));
    await flush();
    harness.fakePanel.webview.inbound.fire({ command: 'ready' });
    await flush();

    assert.equal(calls, 1);
    pending.resolve(view('view:ready'));
    await opening;
});

test('does not repost an unchanged view identity and refreshes after resolver changes', async () => {
    let calls = 0;
    const harness = createHarness(async () => {
        calls += 1;
        return view('view:same');
    });
    await harness.panel.open(uri('file:///workspace/test.feature'));

    harness.changes.fire({ reason: 'local' });
    await flush();

    assert.equal(calls, 2);
    assert.equal(harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'snapshot'
    ).length, 1);
});

test('an unchanged full refresh preserves expanded scenario attachment watches', async () => {
    const nested = projectDefinition({
        id: 'nested:watched',
        kind: 'nestedScenario',
        template: 'Watched resources',
        definitionLocation: {
            uri: 'file:///workspace/Watched/scen.yaml',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        }
    });
    const harness = createHarness(async () => definitionView('view:same', [nested]));
    await harness.panel.open(uri('file:///workspace/test.feature'));
    const snapshotMessage = harness.fakePanel.webview.messages.find(
        (message: any) => message.command === 'snapshot'
    ) as any;
    const item = snapshotMessage.snapshot.items.find((candidate: any) => candidate.hasScenarioFiles);
    await sendWebviewMessage(harness, {
        command: 'setScenarioFilesExpanded',
        itemId: item.id,
        expanded: true
    });
    assert.equal(harness.activeScenarioFileWatches, 1);

    harness.changes.fire({ reason: 'local' });
    await flush();

    assert.equal(harness.activeScenarioFileWatches, 1);
});

test('manual refresh acknowledges completion even when the library identity is unchanged', async () => {
    const harness = createHarness(async () => view('view:same'));
    await harness.panel.open(uri('file:///workspace/test.feature'));

    await sendWebviewMessage(harness, { command: 'refresh' });

    assert.equal(harness.refreshDefinitionsCalls, 1);
    assert.equal(harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'snapshot'
    ).length, 2);
});

test('publishes main scenarios from the scenario catalog and opens their captured location', async () => {
    const mainScenario: TestInfo = {
        name: 'Monthly close',
        tabName: 'Accounting',
        scenarioCode: '000020026',
        yamlFileUri: uri('file:///workspace/main/scen.yaml') as TestInfo['yamlFileUri'],
        relativePath: 'Accounting/MonthlyClose'
    };
    const harness = createHarness(
        async () => view('view:main'),
        undefined,
        () => [mainScenario]
    );
    await harness.panel.open(mainScenario.yamlFileUri);

    const snapshotMessage = harness.fakePanel.webview.messages.find(
        (message: any) => message.command === 'snapshot'
    ) as any;
    const item = snapshotMessage.snapshot.items.find(
        (candidate: any) => candidate.kind === 'mainScenario'
    );
    assert.equal(item.scenarioCode, '000020026');
    assert.equal(item.sourceGroup, 'main');

    await sendWebviewMessage(harness, {
        command: 'openDefinition',
        itemId: item.id
    });
    assert.equal(harness.runtime.navigationCalls.length, 1);
    assert.equal(
        harness.runtime.navigationCalls[0][3].uri,
        'file:///workspace/main/scen.yaml'
    );
});

test('defers resolver work while hidden and refreshes when visible again', async () => {
    let calls = 0;
    const harness = createHarness(async () => view(`view:${++calls}`));
    await harness.panel.open(uri('file:///workspace/test.feature'));
    harness.fakePanel.setVisible(false);

    harness.changes.fire({ reason: 'builtIn' });
    await flush();
    assert.equal(calls, 1);

    harness.fakePanel.setVisible(true);
    await flush();
    assert.equal(calls, 2);
});

test('keeps the last successful snapshot when a later refresh fails', async () => {
    let fail = false;
    const harness = createHarness(async () => {
        if (fail) {
            throw new Error('scan failed');
        }
        return view('view:success');
    });
    await harness.panel.open(uri('file:///workspace/test.feature'));
    fail = true;

    harness.changes.fire({ reason: 'local' });
    await flush();

    assert.equal(harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'snapshot'
    ).length, 1);
    assert.equal(harness.fakePanel.webview.messages.some(
        (message: any) => message.command === 'error' && message.message === 'scan failed'
    ), true);
});

test('accepts only the five inbound commands and strips untrusted fields', () => {
    const fakePanel = new FakePanel();
    const moduleExports = loadPanelModule(fakePanel, createRuntime());
    const parseMessage = moduleExports.parseStepLibraryInboundMessage as
        (value: unknown) => unknown;
    const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

    assert.deepEqual(plain(parseMessage({ command: 'ready', uri: 'file:///evil' })), {
        command: 'ready'
    });
    assert.deepEqual(plain(parseMessage({ command: 'refresh' })), { command: 'refresh' });
    for (const command of ['insert', 'copy', 'openDefinition']) {
        assert.deepEqual(plain(parseMessage({ command, itemId: ' item ', uri: 'file:///evil' })), {
            command,
            itemId: 'item'
        });
        assert.equal(parseMessage({ command, itemId: '   ' }), null);
    }
    assert.equal(parseMessage({ command: 'openUri', uri: 'file:///evil' }), null);
    assert.equal(parseMessage(null), null);
});

test('inserts into the last eligible editor after the webview takes focus', async () => {
    const definition = projectDefinition({
        id: 'export:search',
        kind: 'exportScenario',
        template: 'Search for "Value"',
        parameters: [{ name: 'Value', index: 0, source: 'quoted' }]
    });
    const editor = createFeatureEditor();
    const harness = createHarness(
        async () => definitionView('view:insert', [definition]),
        editor
    );
    await harness.panel.open(editor.document.uri);

    harness.runtime.activeEditor = undefined;
    harness.runtime.activeEditorEvents.fire(undefined);
    await sendWebviewMessage(harness, {
        command: 'insert',
        itemId: `${definition.id}#en`,
        uri: 'file:///untrusted.feature'
    });

    assert.equal(editor.inserted.length, 1);
    assert.equal(editor.inserted[0].value, 'And Search for "${1:Value}"');
});

test('adds inferred YAML indentation and replaces an already typed keyword prefix', async () => {
    const definition = projectDefinition({
        id: 'user:ready', kind: 'userStep', template: 'Дано форма готова', language: 'ru'
    });
    const yamlEditor = createYamlEditorAtBlankColumnZero();
    const yamlHarness = createHarness(
        async () => definitionView('view:yaml-indent', [definition]),
        yamlEditor
    );
    await yamlHarness.panel.open(yamlEditor.document.uri);
    await sendWebviewMessage(yamlHarness, {
        command: 'insert', itemId: `${definition.id}#ru`
    });

    assert.equal(yamlEditor.inserted[0]?.value, '    Дано форма готова');
    assert.equal(yamlEditor.inserted[0]?.selections[0].anchor.character, 0);
    assert.equal(yamlEditor.inserted[0]?.selections[0].active.character, 0);

    const featureEditor = createFeatureEditor([
        '#language: en',
        'Feature: Demo',
        'Scenario: Search',
        '    Then '
    ].join('\n'));
    const cursor = { line: 3, character: 9 };
    featureEditor.selections = [{ anchor: cursor, active: cursor }];
    const english = projectDefinition({
        id: 'user:search', kind: 'userStep', template: 'Given search is ready'
    });
    const featureHarness = createHarness(
        async () => definitionView('view:typed-prefix', [english]),
        featureEditor
    );
    await featureHarness.panel.open(featureEditor.document.uri);
    await sendWebviewMessage(featureHarness, {
        command: 'insert', itemId: `${english.id}#en`
    });

    assert.equal(featureEditor.inserted[0]?.value, 'Then search is ready');
    assert.equal(featureEditor.inserted[0]?.selections[0].anchor.character, 4);
    assert.equal(featureEditor.inserted[0]?.selections[0].active.character, 9);
});

test('rejects heterogeneous multi-cursor insertion contexts', async () => {
    const editor = createFeatureEditor([
        'Feature: Demo',
        'Scenario: Search',
        '    Then ',
        '    Когда '
    ].join('\n'));
    editor.selections = [
        { anchor: { line: 2, character: 9 }, active: { line: 2, character: 9 } },
        { anchor: { line: 3, character: 10 }, active: { line: 3, character: 10 } }
    ];
    const definition = projectDefinition({
        id: 'user:mixed', kind: 'userStep', template: 'And ready'
    });
    const harness = createHarness(
        async () => definitionView('view:mixed', [definition]),
        editor
    );
    await harness.panel.open(editor.document.uri);
    await sendWebviewMessage(harness, {
        command: 'insert', itemId: `${definition.id}#en`
    });

    assert.equal(editor.inserted.length, 0);
});

test('aborts a deferred insertion when another eligible editor becomes active', async () => {
    const definition = projectDefinition({
        id: 'user:race', kind: 'userStep', template: 'And race-safe'
    });
    const editorA = createFeatureEditor();
    const editorB = createFeatureEditor();
    editorB.document.uri = uri('file:///workspace/other.feature');
    editorB.document.fileName = '/workspace/other.feature';
    const deferredView = deferred<ProjectDefinitionView>();
    let calls = 0;
    const harness = createHarness(async () => {
        calls += 1;
        return calls === 1
            ? definitionView('view:initial', [definition])
            : deferredView.promise;
    }, editorA);
    await harness.panel.open(editorA.document.uri);

    harness.fakePanel.webview.inbound.fire({
        command: 'insert', itemId: `${definition.id}#en`
    });
    await flush();
    harness.runtime.activeEditor = editorB;
    harness.runtime.visibleEditors = [editorA, editorB];
    harness.runtime.activeEditorEvents.fire(editorB);
    deferredView.resolve(definitionView('view:resolved', [definition]));
    await flush();
    await flush();

    assert.equal(editorA.inserted.length, 0);
    assert.equal(editorB.inserted.length, 0);
});

test('revalidates a changed document and refuses a target that became unsupported', async () => {
    const definition = projectDefinition({
        id: 'user:ready', kind: 'userStep', template: 'And ready'
    });
    const editor = createFeatureEditor();
    const harness = createHarness(
        async () => definitionView('view:revalidate', [definition]),
        editor
    );
    await harness.panel.open(editor.document.uri);

    editor.document.version = 2;
    await sendWebviewMessage(harness, {
        command: 'insert', itemId: `${definition.id}#en`
    });
    assert.equal(editor.inserted.length, 1);

    editor.document.version = 3;
    editor.document.text = 'Feature: Metadata only';
    await sendWebviewMessage(harness, {
        command: 'insert', itemId: `${definition.id}#en`
    });
    assert.equal(editor.inserted.length, 1);
});

test('resolves an insertion item against the current view instead of trusting rendered text', async () => {
    const rendered = projectDefinition({
        id: 'user:current', kind: 'userStep', template: 'And stale text'
    });
    const current = projectDefinition({
        id: rendered.id, kind: 'userStep', template: 'And current text'
    });
    const editor = createFeatureEditor();
    let calls = 0;
    const harness = createHarness(async () => {
        calls += 1;
        return calls === 1
            ? definitionView('view:rendered', [rendered])
            : definitionView('view:current', [current]);
    }, editor);
    await harness.panel.open(editor.document.uri);

    await sendWebviewMessage(harness, {
        command: 'insert', itemId: `${rendered.id}#en`, template: 'And untrusted text'
    });

    assert.equal(editor.inserted[0]?.value, 'And current text');
});

test('copies plain display text without snippet syntax', async () => {
    const definition = projectDefinition({
        id: 'user:copy',
        kind: 'userStep',
        template: 'And choose "Default"',
        parameters: [{ name: 'Value', index: 0, source: 'quoted' }]
    });
    const harness = createHarness(async () => definitionView('view:copy', [definition]));
    await harness.panel.open(uri('file:///workspace/test.feature'));

    await sendWebviewMessage(harness, {
        command: 'copy', itemId: `${definition.id}#en`
    });

    assert.deepEqual(harness.runtime.clipboardWrites, ['And choose "Default"']);
    assert.doesNotMatch(harness.runtime.clipboardWrites[0], /\$\{/u);
});

test('opens only navigable project items using their server-captured location', async () => {
    const location = {
        uri: 'file:///workspace/library.feature',
        range: {
            start: { line: 4, character: 0 },
            end: { line: 4, character: 18 }
        }
    };
    const exported = projectDefinition({
        id: 'export:navigate',
        kind: 'exportScenario',
        template: 'Open project step',
        definitionLocation: location
    });
    const removedWithoutLocation = projectDefinition({
        id: 'export:missing', kind: 'exportScenario', template: 'Missing source'
    });
    const builtIn = projectDefinition({
        id: 'built:navigate', kind: 'builtInStep', template: 'And built in'
    });
    const harness = createHarness(async () => definitionView(
        'view:navigate',
        [exported, removedWithoutLocation, builtIn]
    ));
    const resource = uri('file:///workspace/caller.feature');
    await harness.panel.open(resource);

    await sendWebviewMessage(harness, {
        command: 'openDefinition', itemId: `${exported.id}#en`
    });
    assert.equal(harness.runtime.navigationCalls.length, 1);
    assert.equal(harness.runtime.navigationCalls[0][0], exported.id);
    assert.equal(harness.runtime.navigationCalls[0][1].toString(), resource.toString());
    assert.deepEqual(harness.runtime.navigationCalls[0][3], location);

    await sendWebviewMessage(harness, {
        command: 'openDefinition', itemId: `${removedWithoutLocation.id}#en`
    });
    await sendWebviewMessage(harness, {
        command: 'openDefinition', itemId: `${builtIn.id}#en`
    });
    assert.equal(harness.runtime.navigationCalls.length, 1);
});
