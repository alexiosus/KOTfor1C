import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as stepLibraryModel from '../src/stepLibraryModel';
import * as projectDefinitionSnippet from '../src/projectDefinitionSnippet';
import { getGherkinInsertionContext as actualInsertionContext } from '../src/gherkinInsertionContext';
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
            createWebviewPanel: () => fakePanel,
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
    let refreshDefinitionsCalls = 0;
    const panel = new Panel({
        extensionUri: uri('file:///extension'),
        resolver: {
            getView,
            ensureReady,
            onDidChangeView: changes.event
        },
        getScenarios,
        refreshDefinitions: async () => {
            refreshDefinitionsCalls += 1;
        }
    });
    return {
        panel,
        fakePanel,
        runtime,
        changes,
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
    const callsAfterCapture = harness.runtime.insertionContextCalls;

    editor.document.version = 2;
    await sendWebviewMessage(harness, {
        command: 'insert', itemId: `${definition.id}#en`
    });
    assert.ok(harness.runtime.insertionContextCalls > callsAfterCapture);
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
