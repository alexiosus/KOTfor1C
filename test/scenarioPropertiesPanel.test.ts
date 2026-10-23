import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as descriptor from '../src/scenarioDescriptor';
import * as metadata from '../src/projectLibraryMetadata';
import * as store from '../src/projectLibraryStore';
import * as session from '../src/scenarioPropertiesSession';
import * as model from '../src/scenarioPropertiesModel';
import * as bindings from '../src/scenarioPropertiesBindings';
import * as compilerFormat from '../src/compilerFormatDiagnostics';
import * as attachments from '../src/scenarioPropertiesAttachments';
import * as spprFormat from '../src/spprScenarioFormat';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
const protocol = require(path.join(process.cwd(), 'media/scenarioPropertiesProtocol.js'));

class Emitter<T> {
    readonly listeners = new Set<(event: T) => unknown>();
    readonly event = (listener: (event: T) => unknown) => {
        this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) };
    };
    async fire(event: T) { await Promise.all([...this.listeners].map(listener => listener(event))); }
    dispose() { this.listeners.clear(); }
}

class Uri {
    constructor(readonly scheme: string, readonly path: string, readonly query = '', readonly fragment = '', readonly authority = '') {}
    static file(value: string) { return Uri.parse(pathToFileURL(value).toString()); }
    static parse(value: string) {
        const url = new URL(value);
        return new Uri(url.protocol.slice(0, -1), decodeURIComponent(url.pathname), url.search.slice(1), url.hash.slice(1), url.host);
    }
    static joinPath(base: Uri, ...segments: string[]) { return base.with({ path: path.posix.join(base.path, ...segments) }); }
    with(value: Partial<Uri>) {
        return new Uri(value.scheme ?? this.scheme, value.path ?? this.path, value.query ?? this.query,
            value.fragment ?? this.fragment, value.authority ?? this.authority);
    }
    get fsPath() { return this.scheme === 'file' ? fileURLToPath(this.toString().split(/[?#]/)[0]) : this.path; }
    toString() {
        return `${this.scheme}://${this.authority}${this.path.split('/').map(encodeURIComponent).join('/')}`
            + (this.query ? '?' + this.query : '') + (this.fragment ? '#' + this.fragment : '');
    }
}

const sourceText = 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Sales\n    UID: sales\n    Проект: Drive\nПараметрыСценария:\nВложенныеСценарии:\nТекстСценария: |\n    Given ready\n';
const settingsText = (uid = 'sales') => `ТипФайла: НастройкаТеста\nДанныеТеста:\n    Имя: Sales test\n    UID: test-${uid}\n    UIDСценария: ${uid}\nПараметрыТеста:\nТегиТеста:\n`;
const processText = 'ТипФайла: Процесс\nДанныеПроцесса:\n    Имя: Workflow\n    UID: workflow\nШагиПроцесса:\nТегиПроцесса:\n';
async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.ok(predicate(), 'The panel did not reach the expected state.');
}

async function harness(t: test.TestContext, initialSource = false) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-properties-panel-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const yamlRoot = path.join(root, 'tests'); const processRoot = path.join(root, 'processes');
    await fsp.mkdir(yamlRoot); await fsp.mkdir(processRoot); await fsp.mkdir(path.join(root, '.kot'));
    await fsp.writeFile(path.join(root, '.kot/groups.yml'), 'version: 1\nlegacyImports: [scenario]\ngroups:\n'
        + '  - {id: main, name: Main, sections: [main], order: 0}\n'
        + '  - {id: process, name: Process, sections: [process], order: 1}\n'
        + '  - {id: standalone, name: Features, sections: [standalone], order: 2}\n');
    const sourceUri = Uri.file(path.join(yamlRoot, 'sales.yaml'));
    const settingsUri = Uri.file(path.join(yamlRoot, 'test.yml'));
    await fsp.writeFile(sourceUri.fsPath, sourceText); await fsp.writeFile(settingsUri.fsPath, settingsText());
    const documents: any[] = []; const panels: any[] = []; const visible: any[] = [];
    const textOpens: string[] = []; const actions: any[] = []; const saved: string[] = []; const writes: any[] = [];
    const watchers: any[] = []; let readdirCount = 0;
    const changed = new Emitter<any>(); const savedEvent = new Emitter<any>(); const active = new Emitter<any>();
    const visibleEditorsChanged = new Emitter<any>(); const viewCommands: any[] = [];
    const tabsChanged = new Emitter<any>();
    class TabInputWebview { constructor(readonly viewType: string) {} }
    const renamed = new Emitter<any>(); const deleted = new Emitter<any>(); const created = new Emitter<any>();
    const rootsChanged = new Emitter<any>(); const foldersChanged = new Emitter<any>(); const configuration = new Emitter<any>();
    let scenarioRoot = yamlRoot; const workspaceRoots = [root];
    let saveSucceeds = true; let applySucceeds = true;
    let autoOpenProperties = true;
    const makeDocument = (uri: Uri, text: string) => ({
        uri, text, version: 1, isDirty: false, isClosed: false, isUntitled: false, languageId: 'yaml',
        getText() { return this.text; }, positionAt(offset: number) { return { offset }; },
        async save() {
            saved.push(this.uri.toString());
            if (!saveSucceeds) { return false; }
            if (this.uri.scheme === 'file') { await fsp.writeFile(this.uri.fsPath, this.text); }
            this.isDirty = false; await savedEvent.fire(this); return true;
        }
    });
    const openDocument = async (uri: Uri) => {
        const existing = documents.find(document => document.uri.toString() === uri.toString() && !document.isClosed);
        if (existing) { return existing; }
        const document = makeDocument(uri, await fsp.readFile(uri.fsPath, 'utf8')); documents.push(document); return document;
    };
    class Edit {
        readonly edits: any[] = [];
        replace(uri: Uri, range: any, text: string) { this.edits.push({ uri, range, text }); }
    }
    let viewProvider: any; let viewOptions: any;
    const host = {
        TabInputWebview,
        Uri, ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
        EventEmitter: Emitter, Range: class { constructor(readonly start: any, readonly end: any) {} }, WorkspaceEdit: Edit,
        RelativePattern: class { constructor(readonly base: Uri, readonly pattern: string) {} },
        workspace: {
            textDocuments: documents, workspaceFolders: workspaceRoots.map(value => ({ uri: Uri.file(value) })),
            openTextDocument: openDocument,
            getWorkspaceFolder: (uri: Uri) => host.workspace.workspaceFolders.filter(folder => uri.fsPath.startsWith(folder.uri.fsPath + path.sep)).at(-1),
            fs: { readFile: async (uri: Uri) => fsp.readFile(uri.fsPath), stat: async (uri: Uri) => fsp.stat(uri.fsPath) },
            applyEdit: async (edit: Edit) => {
                if (!applySucceeds) { return false; }
                for (const item of edit.edits) {
                    const document = await openDocument(item.uri); writes.push(item);
                    document.text = document.text.slice(0, item.range.start.offset) + item.text + document.text.slice(item.range.end.offset);
                    document.version++; document.isDirty = true; await changed.fire({ document, contentChanges: [{}] });
                }
                return true;
            },
            onDidChangeTextDocument: changed.event, onDidSaveTextDocument: savedEvent.event,
            onDidRenameFiles: renamed.event, onDidDeleteFiles: deleted.event, onDidCreateFiles: created.event,
            onDidChangeWorkspaceFolders: foldersChanged.event, onDidChangeConfiguration: configuration.event,
            getConfiguration: () => ({ get: (key: string) => key === 'editor.autoOpenTestProperties' ? autoOpenProperties : undefined }),
            createFileSystemWatcher: (pattern: any) => {
                const watcher = { pattern, disposed: false, changes: new Emitter<Uri>(), creates: new Emitter<Uri>(), deletes: new Emitter<Uri>(),
                    onDidChange(callback: (uri: Uri) => unknown) { return this.changes.event(callback); },
                    onDidCreate(callback: (uri: Uri) => unknown) { return this.creates.event(callback); },
                    onDidDelete(callback: (uri: Uri) => unknown) { return this.deletes.event(callback); },
                    dispose() { this.disposed = true; } };
                watchers.push(watcher); return watcher;
            }
        },
        window: {
            tabGroups: { activeTabGroup: { activeTab: { input: {} as unknown } }, onDidChangeTabs: tabsChanged.event },
            activeTextEditor: undefined as any,
            visibleTextEditors: [] as any[],
            onDidChangeActiveTextEditor: active.event,
            onDidChangeVisibleTextEditors: visibleEditorsChanged.event,
            showTextDocument: async (document: any, options: any = {}) => {
                host.window.tabGroups.activeTabGroup.activeTab.input = {};
                visible.push({ uri: document.uri.toString(), options });
                const editor = { document, viewColumn: options.viewColumn > 0 ? options.viewColumn : 1,
                    selection: new host.Range(document.positionAt(0), document.positionAt(0)),
                    edit: async (callback: (builder: any) => void) => {
                        const edit = new Edit(); callback({ replace: (range: any, text: string) => edit.replace(document.uri, range, text) });
                        return host.workspace.applyEdit(edit);
                    } };
                host.window.activeTextEditor = editor;
                host.window.visibleTextEditors = [editor];
                return editor;
            },
            showErrorMessage: async (_message: string) => undefined,
            registerWebviewViewProvider: (_id: string, provider: any, options: any) => { viewProvider = provider; viewOptions = options; return { dispose() {} }; },
            createView: () => {
                const receive = new Emitter<any>(); const disposed = new Emitter<any>(); const views = new Emitter<any>();
                const panel = { kind: 'kotTestToolkit.scenarioProperties', title: '', visible: true, reveals: [] as any[], disposed: false,
                    webview: { html: '', options: {} as any, cspSource: 'vscode-webview:',
                        asWebviewUri: (uri: Uri) => ({ toString: () => 'https://webview.test' + uri.path }),
                        messages: [] as any[], onDidReceiveMessage: receive.event,
                        postMessage(message: any) { this.messages.push(JSON.parse(JSON.stringify(message))); return Promise.resolve(true); } },
                    onDidDispose: disposed.event, onDidChangeVisibility: views.event,
                    show(preserveFocus?: boolean) { this.reveals.push({ preserveFocus }); },
                    async dispose() { this.disposed = true; await disposed.fire(undefined); }, receive,
                    state() { return this.webview.messages.at(-1)?.state; } };
                panels.push(panel); return panel;
            }
        },
        commands: { executeCommand: async (id: string, options?: any) => {
            assert.equal(id, 'kotTestToolkit.scenarioProperties.focus');
            viewCommands.push({ id, options });
            if (!panels.at(-1) || panels.at(-1).disposed) { await viewProvider.resolveWebviewView(host.window.createView()); }
        } },
        l10n: { t: (value: string) => 'localized:' + value }
    };
    const scanRoot = { resolveScenarioScanRootFsPath: () => scenarioRoot, resolveProcessScanRootFsPath: () => processRoot,
        onDidChangeScenarioScanRoot: rootsChanged.event };
    const load = (filename: string, dependencies: Record<string, any>) => {
        const module = { exports: {} as any };
        const sourceFile = path.join(process.cwd(), 'src', filename);
        if (fs.existsSync(sourceFile)) {
            vm.runInNewContext(ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
                compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
            }).outputText, { module, exports: module.exports, require: (name: string) => name in dependencies ? dependencies[name] : require(name),
                Buffer, URL, console, setTimeout, clearTimeout, TextDecoder, TextEncoder });
        }
        return module.exports;
    };
    const integration = load('projectLibraryIntegration.ts', { vscode: host, './scenarioDescriptor': descriptor,
        './projectLibraryMetadata': metadata, './projectLibraryStore': store, './scenarioScanRoot': scanRoot });
    const yamlValidator = load('yamlValidator.ts', { vscode: host, yaml: require(path.join(process.cwd(), 'node_modules/yaml')), './compilerFormatDiagnostics': compilerFormat });
    const options = { runAction: async (...args: any[]) => { actions.push(args); } };
    const textEditor = { open: async (uri: Uri) => {
        textOpens.push(uri.toString());
        const document = await openDocument(uri);
        return host.window.showTextDocument(document);
    } };
    const spprFiles = load('spprScenarioFiles.ts', { vscode: host, './spprScenarioFormat': spprFormat, './projectLibraryStore': store });
    const api = load('scenarioPropertiesPanel.ts', { vscode: host, './spprScenarioFiles.js': spprFiles, './scenarioPropertiesSession': session,
        './scenarioPropertiesBindings': bindings, './scenarioPropertiesModel': model, './scenarioDescriptor': descriptor,
        './scenarioPropertiesAttachments': attachments,
        './projectLibraryMetadata': metadata, './projectLibraryStore': store, './projectLibraryIntegration': integration,
        './scenarioScanRoot': scanRoot, './yamlValidator': yamlValidator, '../media/scenarioPropertiesProtocol.js': protocol,
        './scenarioPropertiesCatalogs.js': { loadScenarioPropertiesCatalogs: async () => ({ projects: ['Drive'], reportLevel1: [], reportLevel2: [], categories: [], systemFunctions: [], bases: [], userProfiles: [], settingsUserProfiles: [] }) },
        'node:fs/promises': { ...fsp, readdir: async (...args: any[]) => { readdirCount++; return (fsp.readdir as any)(...args); } } });
    const context = { extensionUri: Uri.file(process.cwd()), extensionPath: process.cwd(), subscriptions: [] as any[] };
    const native = api.createScenarioPropertiesHost ? api.createScenarioPropertiesHost(options) : undefined;
    if (initialSource) {
        const editor = { document: await openDocument(sourceUri), viewColumn: 1 };
        host.window.activeTextEditor = editor; host.window.visibleTextEditors = [editor];
    }
    const panel = api.ScenarioPropertiesPanel ? new api.ScenarioPropertiesPanel(context, textEditor, options) : undefined;
    t.after(() => panel?.dispose());
    return { root, yamlRoot, processRoot, sourceUri, settingsUri, native, panel, api, host, documents, panels, watchers, visible,
        textOpens, actions, saved, writes, openDocument, get viewOptions() { return viewOptions; }, changed, savedEvent, active, visibleEditorsChanged, viewCommands, renamed, deleted, created, rootsChanged,
        get readdirCount() { return readdirCount; },
        async open(uri = sourceUri) {
            assert.ok(panel, 'ScenarioPropertiesPanel must connect the native editor and properties session'); await panel.open(uri);
            for (let attempt = 0; attempt < 100 && panels.at(-1)?.state()?.loading; attempt++) { await new Promise(resolve => setTimeout(resolve, 5)); }
            return panels.at(-1);
        },
        async edit(uri: Uri, text: string) { const document = await openDocument(uri); document.text = text; document.version++; document.isDirty = true;
            await changed.fire({ document, contentChanges: [{}] }); return document; },
        async setActive(document: any) { host.window.tabGroups.activeTabGroup.activeTab.input = {}; const editor = document ? { document, viewColumn: 1 } : undefined; host.window.activeTextEditor = editor;
            if (editor) { host.window.visibleTextEditors = [editor]; } await active.fire(editor); },
        setAutoOpen(value: boolean) { autoOpenProperties = value; },
        async setActiveWebview(viewType: string, staleEditor = false) {
            host.window.tabGroups.activeTabGroup.activeTab.input = new TabInputWebview(viewType);
            if (!staleEditor) { host.window.activeTextEditor = undefined; }
            await tabsChanged.fire({ changed: [host.window.tabGroups.activeTabGroup.activeTab] });
        },
        setSaveSucceeds(value: boolean) { saveSucceeds = value; }, setApplySucceeds(value: boolean) { applySucceeds = value; },
        async changeRoots(next: string) { scenarioRoot = next; await rootsChanged.fire(next); },
        addOwner(value: string) { workspaceRoots.push(value); host.workspace.workspaceFolders.push({ uri: Uri.file(value) }); }
    };
}

test('native host reads dirty source/settings documents and binds exact UID rather than sibling names', async t => {
    const h = await harness(t); assert.ok(h.native, 'Native property host must read current VS Code documents');
    await fsp.writeFile(path.join(h.yamlRoot, 'sales-test.yaml'), settingsText('unrelated'));
    const source = await h.edit(h.sourceUri, sourceText.replace('Drive', 'Dirty project'));
    await h.edit(h.settingsUri, settingsText().replace('Sales test', 'Dirty settings'));
    const value = await h.native.readDocument(h.sourceUri.toString());
    assert.equal(value.text, source.text); assert.equal(value.dirty, true);
    const linked = bindings.findLinkedScenarioSettings(value, await h.native.listSettings(value));
    assert.deepEqual(Array.from(linked, item => item.uri), [h.settingsUri.toString()]);
    assert.match(linked[0].text, /Dirty settings/);
    const openedBefore = h.documents.length;
    const initial = await h.native.listInitialSettings(value);
    assert.equal(h.documents.length, openedBefore, 'Initial binding reads must not open unrelated editor documents');
    const initialLinked = bindings.findLinkedScenarioSettings(value, initial);
    assert.deepEqual(Array.from(initialLinked, item => item.uri), [h.settingsUri.toString()]);
    assert.match(initialLinked[0].text, /Dirty settings/);
});

test('explicit properties opening publishes source and opens YAML before related inventory completes', async t => {
    const h = await harness(t); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.panel.host.listSettings = async () => { await gate; return []; };
    try {
        await h.panel.open(h.sourceUri);
        assert.equal(h.panels.at(-1).state().source.uri, h.sourceUri.toString());
        assert.equal(h.panels.at(-1).state().loading, true);
        assert.equal(h.panels.at(-1).state().canCreateSettings, true);
        assert.ok(h.panels.at(-1).state().groups.some((group: { id: string }) => group.id === 'main'));
        assert.deepEqual(h.textOpens, [h.sourceUri.toString()]);
    } finally { release(); }
});

test('delayed ready handshake cannot acknowledge either of two queued property edits', async t => {
    const h = await harness(t); const view = await h.open();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const client = protocol.createClient({ postMessage: (message: any) => { void view.receive.fire(message); } });
    client.setState(view.state());
    const original = view.webview.postMessage.bind(view.webview);
    let hold = true;
    view.webview.postMessage = async (message: any) => {
        if (hold && message.acknowledgement === false) { hold = false; entered(); await gate; }
        await original(message); client.setState(message.state, message.acknowledgement); return true;
    };
    const ready = view.receive.fire({ command: 'ready' }); await started;
    const source = view.state().source;
    for (const value of ['First edit', 'Second edit']) {
        client.enqueue({ command: 'edit', documentUri: source.uri, documentVersion: source.version, edit: { section: 'ДанныеСценария', field: 'Проект', value } });
    }
    release(); await ready;
    for (let attempt = 0; attempt < 100 && client.isPending(); attempt++) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(client.isPending(), false);
    assert.match((await h.openDocument(h.sourceUri)).text, /Проект: "Second edit"/);
    assert.equal(view.state().error, undefined);
});

test('ordinary scenario and process opening reveals properties without reopening or focusing the text editor', async t => {
    const h = await harness(t);
    const source = await h.openDocument(h.sourceUri); await h.setActive(source);
    assert.equal(h.panels.length, 1);
    assert.equal(h.panels[0].state().source.uri, h.sourceUri.toString());
    assert.equal(h.host.window.activeTextEditor.document, source);
    assert.equal(h.viewCommands[0].options?.preserveFocus, true);
    assert.deepEqual(h.textOpens, []);
    await h.panels[0].dispose();
    const process = Uri.file(path.join(h.processRoot, 'flow.yaml')); await fsp.writeFile(process.fsPath, processText);
    await h.setActive(await h.openDocument(process));
    assert.equal(h.panels.at(-1).state().source.model.kind, 'process');
    assert.deepEqual(h.textOpens, []);
});

test('default properties also resolve an independently opened settings or metadata tab', async t => {
    const h = await harness(t); await h.setActive(await h.openDocument(h.settingsUri));
    assert.equal(h.panels.length, 1); assert.equal(h.panels[0].state().source.uri, h.sourceUri.toString());
    assert.equal(h.panels[0].state().selectedSettingsUri, h.settingsUri.toString());
    await h.panels[0].dispose();
    const metadata = await h.native.ensureMetadata(await h.native.readDocument(h.sourceUri.toString()));
    await h.setActive(await h.openDocument(Uri.parse(metadata.uri)));
    assert.equal(h.panels.at(-1).state().source.uri, h.sourceUri.toString());
});

test('default properties skip hidden previews and stale editor instances but retry once the active editor is visible', async t => {
    const h = await harness(t); const document = await h.openDocument(h.sourceUri);
    const preview = { document, viewColumn: 1 }; h.host.window.activeTextEditor = preview;
    await h.active.fire(preview); assert.equal(h.panels.length, 0);
    h.host.window.visibleTextEditors = [{ document, viewColumn: 1 }];
    await h.active.fire(preview); assert.equal(h.panels.length, 0);
    h.host.window.visibleTextEditors = [preview]; await h.visibleEditorsChanged.fire([preview]);
    assert.equal(h.panels.length, 1); assert.equal(h.panels[0].state().source.uri, h.sourceUri.toString());
});

test('default properties can be disabled and unrelated YAML never opens them automatically', async t => {
    const h = await harness(t); h.setAutoOpen(false);
    await h.setActive(await h.openDocument(h.sourceUri)); assert.equal(h.panels.length, 0);
    h.setAutoOpen(true);
    const other = Uri.file(path.join(h.root, 'config.yaml')); await fsp.writeFile(other.fsPath, 'name: Other app\n');
    await h.setActive(await h.openDocument(other)); assert.equal(h.panels.length, 0);
    await h.setActive(await h.openDocument(h.sourceUri)); assert.equal(h.panels.length, 1);
});

test('default properties initialize a restored active scenario without requiring a new editor event', async t => {
    const h = await harness(t, true);
    for (let attempt = 0; !h.panels.at(-1)?.state()?.source && attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(h.panels.length, 1); assert.equal(h.panels[0].state().source.uri, h.sourceUri.toString());
});

test('cached candidate discovery stays in configured owner roots and direct source siblings', async t => {
    const h = await harness(t); assert.ok(h.native);
    const outside = path.join(h.root, 'cf'); await fsp.mkdir(outside);
    const sourceUri = Uri.file(path.join(outside, 'source.yaml')); await fsp.writeFile(sourceUri.fsPath, sourceText);
    await fsp.writeFile(path.join(outside, 'direct.yml'), settingsText());
    await fsp.mkdir(path.join(outside, 'large-config')); await fsp.writeFile(path.join(outside, 'large-config/ignored.yaml'), settingsText());
    for (const directory of ['.git', '.kot', 'node_modules', 'out', 'dist', 'generated', 'kot-runtime']) {
        await fsp.mkdir(path.join(h.yamlRoot, directory)); await fsp.writeFile(path.join(h.yamlRoot, directory, 'ignore.yaml'), settingsText());
    }
    const nested = path.join(h.yamlRoot, 'nested-project'); await fsp.mkdir(nested); h.addOwner(nested);
    await fsp.writeFile(path.join(nested, 'other-owner.yaml'), settingsText());
    await fsp.symlink(outside, path.join(h.yamlRoot, 'symlink'));
    const source = await h.native.readDocument(sourceUri.toString());
    let linked = bindings.findLinkedScenarioSettings(source, await h.native.listSettings(source));
    assert.deepEqual(Array.from(linked, item => path.basename(Uri.parse(item.uri).fsPath)).sort(), ['direct.yml', 'test.yml']);
    const scans = h.readdirCount;
    await h.native.listSettings(source); assert.equal(h.readdirCount, scans);
    const createdUri = Uri.file(path.join(h.yamlRoot, 'second.yaml')); await fsp.writeFile(createdUri.fsPath, settingsText());
    h.native.invalidateSettings(createdUri, true);
    linked = bindings.findLinkedScenarioSettings(source, await h.native.listSettings(source));
    assert.equal(linked.length, 3); assert.ok(h.readdirCount > scans);
});

test('native property replacement rejects stale revisions and preserves ordinary dirty source changes', async t => {
    const h = await harness(t); assert.ok(h.native);
    const before = await h.native.readDocument(h.sourceUri.toString());
    await h.edit(h.sourceUri, sourceText.replace('Drive', 'Changed'));
    assert.equal(await h.native.replaceDocument(before, sourceText.replace('Drive', 'Stale')), false);
    assert.equal(h.writes.length, 0);
    const current = await h.native.readDocument(h.sourceUri.toString());
    assert.equal(await h.native.replaceDocument(current, current.text.replace('Changed', 'Panel')), true);
    assert.equal((await h.openDocument(h.sourceUri)).isDirty, true);
    assert.equal(await fsp.readFile(h.sourceUri.fsPath, 'utf8'), sourceText);
});

test('metadata reads prefer dirty sidecars and validate kind and UID against the source', async t => {
    const h = await harness(t); assert.ok(h.native);
    const sidecar = Uri.file(h.sourceUri.fsPath + '.kot.yml');
    const valid = 'version: 2\nidentity: {kind: scenario, uid: sales}\nmetadata: {description: Disk}\n';
    await fsp.writeFile(sidecar.fsPath, valid); await h.edit(sidecar, valid.replace('Disk', 'Dirty metadata'));
    const source = await h.native.readDocument(h.sourceUri.toString());
    assert.match((await h.native.readMetadata(source)).text, /Dirty metadata/);
    await h.edit(sidecar, valid.replace('uid: sales', 'uid: wrong'));
    await assert.rejects(h.native.readMetadata(source), /identity|UID|match/i);
    await h.edit(sidecar, valid.replace('kind: scenario', 'kind: process'));
    await assert.rejects(h.native.readMetadata(source), /identity|kind|match/i);
});

test('metadata bootstrap uses the project store without showing a YAML editor and groups respect entity family', async t => {
    const h = await harness(t); assert.ok(h.native);
    const source = await h.native.readDocument(h.sourceUri.toString());
    assert.equal(await h.native.readMetadata(source), undefined);
    const sidecar = await h.native.ensureMetadata(source);
    assert.equal(sidecar.uri, h.sourceUri.toString() + '.kot.yml');
    assert.match(sidecar.text, /version: 2/); assert.equal(h.visible.length, 0);
    assert.deepEqual((await h.native.loadGroups(source)).map((group: any) => group.id), ['main']);
    const processUri = Uri.file(path.join(h.processRoot, 'workflow.yml')); await fsp.writeFile(processUri.fsPath, processText);
    const process = await h.native.readDocument(processUri.toString());
    assert.deepEqual((await h.native.loadGroups(process)).map((group: any) => group.id), ['process']);
});

test('loading property group choices does not enumerate scenario or metadata directories', async t => {
    const h = await harness(t);
    const source = await h.native.readDocument(h.sourceUri.toString());
    const original = store.ProjectLibraryStore.prototype.read;
    store.ProjectLibraryStore.prototype.read = async () => { throw new Error('Group choices must not load the full project library'); };
    try { assert.deepEqual((await h.native.loadGroups(source)).map((group: any) => group.id), ['main']); }
    finally { store.ProjectLibraryStore.prototype.read = original; }
});

test('native source save failure retains dirty YAML without a second body document', async t => {
    const h = await harness(t); await h.open();
    const document = await h.edit(h.sourceUri, sourceText.replace('Given ready', 'Given unsaved'));
    h.setSaveSucceeds(false); assert.equal(await h.native.saveDocument(h.sourceUri.toString()), false);
    assert.equal(document.isDirty, true); assert.match(document.text, /Given unsaved/);
    assert.equal(h.documents.filter(value => value.uri.scheme !== 'file').length, 0);
});

test('opening the singleton sidebar view uses the original YAML with localized state and secured resources', async t => {
    const h = await harness(t); const panel = await h.open();
    assert.deepEqual(h.textOpens, [h.sourceUri.toString()]);
    assert.equal(panel.webview.options.enableScripts, true); assert.equal(h.viewOptions.webviewOptions.retainContextWhenHidden, true);
    assert.match(panel.webview.html, /script-src 'nonce-[^']+'/); assert.doesNotMatch(panel.webview.html, /\{\{/);
    assert.match(panel.webview.html, /scenarioPropertiesProtocol\.js/);
    assert.equal(panel.state().source.uri, h.sourceUri.toString());
    assert.equal(panel.state().labels.save, 'localized:Save test');
    assert.deepEqual(Object.keys(panel.state().labels).sort(), Object.keys(protocol.DEFAULT_LABELS).sort());
    await h.open();
    assert.equal(h.panels.length, 1); assert.equal(panel.reveals.at(-1).preserveFocus, true);
});

test('process properties retain their native YAML step list', async t => {
    const h = await harness(t); const uri = Uri.file(path.join(h.processRoot, 'workflow.yml'));
    await fsp.writeFile(uri.fsPath, processText); const panel = await h.open(uri);
    assert.deepEqual(h.textOpens, [uri.toString()]); assert.equal(panel.state().source.model.kind, 'process');
    assert.ok(panel.state().source.model.sections.some((section: any) => section.key === 'ШагиПроцесса'));
});

test('every property message acknowledges new state including stale edits and invalid messages', async t => {
    const h = await harness(t); const panel = await h.open();
    const first = panel.state(); const count = panel.webview.messages.length;
    await panel.receive.fire({ command: 'edit', documentUri: h.sourceUri.toString(), documentVersion: first.source.version,
        edit: { section: 'ДанныеСценария', field: 'Проект', value: 'Panel project' } });
    assert.equal(panel.webview.messages.length, count + 1); assert.equal(panel.state().dirty, true);
    await panel.receive.fire({ command: 'edit', documentUri: h.sourceUri.toString(), documentVersion: first.source.version,
        edit: { section: 'ДанныеСценария', field: 'Проект', value: 'Stale' } });
    assert.match(panel.state().error, /changed|stale/i); assert.equal(panel.state().labels.save, 'localized:Save test');
    assert.match((await h.openDocument(h.sourceUri)).text, /Panel project/);
    const staleCount = panel.webview.messages.length;
    await panel.receive.fire({ command: 'edit', documentUri: 'unrelated', documentVersion: -1 });
    assert.equal(panel.webview.messages.length, staleCount + 1); assert.ok(panel.state().error);
});

test('panel focus and related settings keep the selected source while pinning blocks other supported editors', async t => {
    const h = await harness(t); const panel = await h.open();
    await h.setActive(undefined); await h.setActive(await h.openDocument(h.settingsUri));
    assert.equal(panel.state().source.uri, h.sourceUri.toString());
    await panel.receive.fire({ command: 'action', action: 'pin' });
    const other = Uri.file(path.join(h.yamlRoot, 'other.yaml')); await fsp.writeFile(other.fsPath, sourceText.replaceAll('sales', 'other').replace('Sales', 'Other'));
    await h.setActive(await h.openDocument(other)); assert.equal(panel.state().source.uri, h.sourceUri.toString());
    await panel.receive.fire({ command: 'action', action: 'pin' });
    assert.equal(panel.state().source.uri, other.toString());
    assert.equal(panel.state().pinned, false);
});

test('opening a manager webview clears unpinned Properties without saving the previous test', async t => {
    const h = await harness(t); const panel = await h.open();
    const document = await h.openDocument(h.sourceUri); document.isDirty = true;
    await h.setActiveWebview('kotTestToolkit.infobaseManagerPanel', true);
    assert.equal(panel.state().source, null); assert.equal(document.isDirty, true); assert.equal(h.saved.length, 0);
    assert.ok(h.watchers.every(watcher => watcher.disposed));
    await h.setActive(document);
    assert.equal(panel.state().source.uri, h.sourceUri.toString());
    await h.setActiveWebview('kotTestToolkit.formExplorerPanel');
    assert.equal(panel.state().source, null);
});

test('pinning intentionally retains the selected test when a manager webview is active', async t => {
    const h = await harness(t); const panel = await h.open();
    await panel.receive.fire({ command: 'action', action: 'pin' });
    await h.setActiveWebview('kotTestToolkit.infobaseManagerPanel');
    assert.equal(panel.state().source.uri, h.sourceUri.toString()); assert.equal(panel.state().pinned, true);
});

test('the sidebar follows the active scenario, its settings and adjacent metadata without replacing editor tabs', async t => {
    const h = await harness(t); const panel = await h.open();
    const other = Uri.file(path.join(h.yamlRoot, 'other.yaml'));
    const otherSettings = Uri.file(path.join(h.yamlRoot, 'other-test.yaml'));
    await fsp.writeFile(other.fsPath, sourceText.replaceAll('sales', 'other').replace('Sales', 'Other'));
    await fsp.writeFile(otherSettings.fsPath, settingsText('other'));
    await h.created.fire({ files: [other, otherSettings] });
    await h.setActive(await h.openDocument(other));
    assert.equal(panel.state().source.uri, other.toString());
    await h.setActive(await h.openDocument(h.settingsUri));
    assert.equal(panel.state().source.uri, h.sourceUri.toString());
    assert.equal(panel.state().selectedSettingsUri, h.settingsUri.toString());
    await h.setActive(await h.openDocument(otherSettings));
    assert.equal(panel.state().source.uri, other.toString());
    assert.equal(panel.state().selectedSettingsUri, otherSettings.toString());
    const otherSource = await h.native.readDocument(other.toString());
    const metadata = await h.native.ensureMetadata(otherSource);
    await h.setActive(await h.openDocument(Uri.parse(metadata.uri)));
    assert.equal(panel.state().error, undefined);
    assert.equal(panel.state().source.uri, other.toString());
    assert.deepEqual(h.textOpens, [h.sourceUri.toString()]);
    assert.equal(h.panels.length, 1);
});

test('an unrelated editor clears unpinned properties while sidebar focus retains the bound test', async t => {
    const h = await harness(t); const panel = await h.open();
    await h.setActive(undefined);
    assert.equal(panel.state().source.uri, h.sourceUri.toString());
    const other = Uri.file(path.join(h.root, 'notes.txt')); await fsp.writeFile(other.fsPath, 'Notes');
    await h.setActive(await h.openDocument(other));
    assert.equal(panel.state().source, null);
    await h.setActive(await h.openDocument(h.sourceUri));
    assert.equal(panel.state().source.uri, h.sourceUri.toString());
});

test('dirty source refresh and action failures retain state and route exact source/settings identities', async t => {
    const h = await harness(t); const panel = await h.open();
    await h.edit(h.sourceUri, sourceText.replace('Drive', 'Raw author'));
    await waitFor(() => panel.state().source.model.header.find((field: any) => field.key === 'Проект').value === 'Raw author');
    assert.equal(panel.state().source.model.header.find((field: any) => field.key === 'Проект').value, 'Raw author');
    await panel.receive.fire({ command: 'action', action: 'base', value: 'Selected base' });
    assert.equal(h.actions[0][0], 'base'); assert.equal(h.actions[0][1].uri, h.sourceUri.toString());
    assert.equal(h.actions[0][2], h.settingsUri.toString()); assert.equal(h.actions[0][3], 'Selected base');
    h.setSaveSucceeds(false); await panel.receive.fire({ command: 'action', action: 'save' });
    assert.match(panel.state().error, /save/i); assert.equal(panel.state().dirty, true);
});

test('filesystem creation and root changes invalidate settings inventory without ordinary refresh rescans', async t => {
    const h = await harness(t); const panel = await h.open(); const scans = h.readdirCount;
    await panel.receive.fire({ command: 'ready' }); assert.equal(h.readdirCount, scans);
    const second = Uri.file(path.join(h.yamlRoot, 'second.yaml')); await fsp.writeFile(second.fsPath, settingsText());
    await h.created.fire({ files: [second] }); await waitFor(() => panel.state().settings.length === 2);
    assert.equal(panel.state().settings.length, 2); assert.equal(panel.state().selectedSettingsUri, h.settingsUri.toString());
    const replacementRoot = path.join(h.root, 'new-tests'); await fsp.mkdir(replacementRoot);
    await fsp.writeFile(path.join(replacementRoot, 'new-settings.yaml'), settingsText());
    await h.changeRoots(replacementRoot); await waitFor(() => panel.state().settings.some((value: any) => value.uri.includes('/new-tests/new-settings.yaml')));
    assert.ok(panel.state().settings.some((value: any) => value.uri.includes('/new-tests/new-settings.yaml')));
    assert.ok(h.watchers.some(value => value.disposed));
});

test('renamed selected sources remap a pinned session and reopen exact native text identity', async t => {
    const h = await harness(t); const panel = await h.open();
    await panel.receive.fire({ command: 'action', action: 'pin' });
    const next = h.sourceUri.with({ path: path.join(h.yamlRoot, 'renamed.yaml') });
    await fsp.rename(h.sourceUri.fsPath, next.fsPath);
    const document = await h.openDocument(h.sourceUri); document.uri = next;
    await h.renamed.fire({ files: [{ oldUri: h.sourceUri, newUri: next }] });
    assert.equal(panel.state().source.uri, next.toString()); assert.equal(panel.state().pinned, true);
    assert.equal(h.textOpens.at(-1), next.toString()); assert.equal(h.panels.length, 1);
});

test('Properties binds the shared attachment service and dispatches file actions outside document edits', async t => {
    const h = await harness(t); const opened: any[] = [];
    const service = { listAttachmentPaths: async () => ['Data.csv'], watch: () => ({ dispose() {} }),
        openExternal: async (...args: any[]) => { opened.push(args); return true; }, revealInOs: async () => true,
        deleteFile: async () => 'deleted', prepareDrop: async () => ({ files: [], skipped: [] }),
        appendTransferChunk: async () => 0, completeTransfer: async () => undefined, cancelTransfer: async () => undefined };
    assert.equal(typeof h.panel.attachScenarioFilesService, 'function'); h.panel.attachScenarioFilesService(service);
    const panel = await h.open();
    await waitFor(() => panel.webview.messages.some((message: any) => message.command === 'scenarioPropertiesFiles'));
    const files = panel.webview.messages.find((message: any) => message.command === 'scenarioPropertiesFiles');
    assert.deepEqual(files.paths, ['Data.csv']); assert.equal(files.sourceUri, h.sourceUri.toString());
    await panel.receive.fire({ command: 'openScenarioFile', sourceUri: h.sourceUri.toString(), itemId: h.sourceUri.toString(), relativePath: 'Data.csv' });
    assert.equal(opened.length, 1); assert.equal(opened[0][1], 'Data.csv'); assert.equal(h.writes.length, 0);
    assert.match(panel.webview.html, /scenarioFilesProtocol\.js/);
    const editor = h.host.window.activeTextEditor; const position = sourceText.indexOf('ready');
    editor.selection = new h.host.Range(editor.document.positionAt(position), editor.document.positionAt(position + 'ready'.length));
    await panel.receive.fire({ command: 'insertScenarioFileName', sourceUri: h.sourceUri.toString(), itemId: h.sourceUri.toString(), relativePath: 'Data.csv' });
    assert.match(editor.document.getText(), /Given Data\.csv/); assert.equal(h.writes.length, 1);
});

test('batched file and folder moves preserve selected custom settings and linked metadata', async t => {
    const h = await harness(t); const custom = Uri.file(path.join(h.yamlRoot, 'custom.yaml'));
    await fsp.writeFile(custom.fsPath, settingsText()); const panel = await h.open();
    await panel.receive.fire({ command: 'action', action: 'selectSettings', value: custom.toString() });
    await panel.receive.fire({ command: 'editMetadata', documentUri: h.sourceUri.toString(), documentVersion: 1,
        field: 'description', value: 'Notes' });
    await waitFor(() => panel.state().metadata?.values.description === 'Notes');
    await panel.receive.fire({ command: 'action', action: 'pin' });
    const priorMetadata = panel.state().metadata.uri;
    const nextFolder = Uri.file(path.join(h.root, 'NEW')); const nextSettings = Uri.file(path.join(h.yamlRoot, 'NEW.yaml'));
    const moves = [{ oldUri: h.settingsUri, newUri: nextSettings }, { oldUri: Uri.file(h.yamlRoot), newUri: nextFolder }];
    await fsp.rename(h.settingsUri.fsPath, nextSettings.fsPath); await fsp.rename(h.yamlRoot, nextFolder.fsPath);
    for (const document of h.documents) {
        document.uri = Uri.parse(protocol.remapUri(document.uri.toString(), moves.map(move => ({ oldUri: move.oldUri.toString(), newUri: move.newUri.toString() }))));
    }
    await h.renamed.fire({ files: moves }); await waitFor(() => panel.state().source.uri.includes('/NEW/') && !panel.state().loading);
    assert.equal(panel.state().source.uri, Uri.file(path.join(nextFolder.fsPath, 'sales.yaml')).toString());
    assert.equal(panel.state().selectedSettingsUri, Uri.file(path.join(nextFolder.fsPath, 'custom.yaml')).toString());
    assert.equal(panel.state().metadata.uri, priorMetadata.replace('/tests/', '/NEW/'));
    assert.equal(panel.state().metadata.values.description, 'Notes'); assert.equal(panel.state().pinned, true);
    assert.equal(h.textOpens.at(-1), panel.state().source.uri);
});

test('source deletion acknowledges an actionable error and does not save orphaned dirty YAML', async t => {
    const h = await harness(t); const panel = await h.open();
    const projection = await h.openDocument(h.sourceUri); projection.isDirty = true;
    projection.text = sourceText.replace('Given ready', 'Given unsaved'); await fsp.unlink(h.sourceUri.fsPath);
    await h.deleted.fire({ files: [h.sourceUri] });
    await waitFor(() => /deleted|missing|source/i.test(panel.state().error ?? ''));
    assert.match(panel.state().error, /deleted|missing|source/i);
    await panel.receive.fire({ command: 'action', action: 'save' });
    assert.match(panel.state().error, /deleted|missing|source/i);
    assert.equal(h.saved.length, 0); assert.match(projection.text, /Given unsaved/); assert.equal(projection.isDirty, true);
});

test('disposing the panel service releases all native event listeners and configured watchers', async t => {
    const h = await harness(t); await h.open(); h.panel.dispose();
    assert.ok(h.watchers.every(value => value.disposed));
    assert.equal(h.active.listeners.size, 0); assert.equal(h.changed.listeners.size, 0);
    assert.equal(h.renamed.listeners.size, 0); assert.equal(h.deleted.listeners.size, 0);
});

test('initial multiple linked settings require explicit selection and keep it during source rename', async t => {
    const h = await harness(t); const second = Uri.file(path.join(h.yamlRoot, 'second.yaml'));
    await fsp.writeFile(second.fsPath, settingsText()); const panel = await h.open();
    assert.equal(panel.state().settings.length, 2); assert.equal(panel.state().selectedSettingsUri, null);
    await panel.receive.fire({ command: 'action', action: 'selectSettings', value: second.toString() });
    const next = h.sourceUri.with({ path: path.join(h.yamlRoot, 'renamed.yaml') });
    await fsp.rename(h.sourceUri.fsPath, next.fsPath); (await h.openDocument(h.sourceUri)).uri = next;
    await h.renamed.fire({ files: [{ oldUri: h.sourceUri, newUri: next }] });
    assert.equal(panel.state().selectedSettingsUri, second.toString()); assert.equal(panel.state().source.uri, next.toString());
});

test('open dirty YAML reached through a symlink is excluded from candidate overlays', async t => {
    const h = await harness(t); assert.ok(h.native);
    const outside = path.join(h.root, 'outside'); await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'linked.yaml'), settingsText());
    await fsp.symlink(outside, path.join(h.yamlRoot, 'linked-directory'));
    await h.edit(Uri.file(path.join(h.yamlRoot, 'linked-directory/linked.yaml')), settingsText().replace('Sales test', 'Dirty linked'));
    const source = await h.native.readDocument(h.sourceUri.toString());
    const linked = bindings.findLinkedScenarioSettings(source, await h.native.listSettings(source));
    assert.deepEqual(Array.from(linked, item => item.uri), [h.settingsUri.toString()]);
});

test('Git inventory changes reload candidate paths while dirty settings values overlay disk', async t => {
    const h = await harness(t); const panel = await h.open();
    await h.edit(h.settingsUri, settingsText().replace('Sales test', 'Dirty after Git'));
    const second = Uri.file(path.join(h.yamlRoot, 'from-git.yaml')); await fsp.writeFile(second.fsPath, settingsText());
    const gitWatcher = h.watchers.find(watcher => watcher.pattern.pattern.startsWith('.git/'));
    assert.ok(gitWatcher); await gitWatcher.changes.fire(Uri.file(path.join(h.root, '.git/HEAD')));
    await waitFor(() => panel.state().settings.length === 2);
    assert.equal(panel.state().settings.length, 2);
    assert.equal(panel.state().settings.find((value: any) => value.uri === h.settingsUri.toString()).model.title, 'Dirty after Git');
});

test('invalid adjacent metadata keeps a source link and watchers so repairing it restores properties', async t => {
    const h = await harness(t); const sidecar = Uri.file(h.sourceUri.fsPath + '.kot.yml');
    await fsp.writeFile(sidecar.fsPath, 'version: 2\nidentity: {kind: scenario, uid: wrong}\nmetadata: {}\n');
    const panel = await h.open();
    assert.equal(panel.state().source.uri, h.sourceUri.toString()); assert.match(panel.state().error, /identity|UID|match/i);
    const repaired = 'version: 2\nidentity: {kind: scenario, uid: sales}\nmetadata: {description: Repaired}\n';
    await fsp.writeFile(sidecar.fsPath, repaired);
    const native = await h.openDocument(sidecar); native.text = repaired; native.version++;
    await Promise.all(h.watchers.map(watcher => watcher.changes.fire(sidecar)));
    await waitFor(() => panel.state().metadata?.values.description === 'Repaired');
    assert.equal(panel.state().error, undefined); assert.equal(panel.state().metadata.values.description, 'Repaired');
});

test('a missing literal body still exposes properties and the original YAML for repair', async t => {
    const h = await harness(t);
    await fsp.writeFile(h.sourceUri.fsPath, sourceText.replace(/ТекстСценария:[\s\S]*$/, ''));
    const panel = await h.open();
    assert.equal(panel.state().source.uri, h.sourceUri.toString()); assert.equal(panel.state().error, undefined);
    await panel.receive.fire({ command: 'action', action: 'openSource' });
    assert.equal(h.actions[0][0], 'openSource'); assert.equal(h.actions[0][1].uri, h.sourceUri.toString());
});

test('a background refresh cannot acknowledge a pending form edit and release its next edit with a stale revision', async t => {
    const h = await harness(t); const panel = await h.open();
    const source = await h.openDocument(h.sourceUri); source.isClosed = true;
    const originalOpen = h.host.workspace.openTextDocument;
    h.host.workspace.openTextDocument = async (uri: Uri) => {
        if (uri.toString() === h.sourceUri.toString()) { await new Promise(resolve => setTimeout(resolve, 40)); }
        return originalOpen(uri);
    };
    const deliveries: Promise<unknown>[] = [];
    const client = protocol.createClient({ postMessage: (value: unknown) => deliveries.push(panel.receive.fire(value)) });
    client.setState(panel.state());
    const originalPost = panel.webview.postMessage.bind(panel.webview);
    panel.webview.postMessage = (message: any) => { client.setState(message.state); return originalPost(message); };
    await h.watchers[0].changes.fire(h.sourceUri);
    await new Promise(resolve => setTimeout(resolve, 95));
    for (const value of ['First queued edit', 'Second queued edit']) {
        assert.equal(client.enqueue({ command: 'edit', documentUri: h.sourceUri.toString(), documentVersion: 1,
            edit: { section: 'ДанныеСценария', field: 'Проект', value } }), true);
    }
    await new Promise(resolve => setTimeout(resolve, 160));
    await Promise.all(deliveries);
    assert.equal(panel.state().error, undefined);
    assert.equal(panel.state().source.model.header.find((field: any) => field.key === 'Проект').value, 'Second queued edit');
    assert.equal(client.isPending(), false);
});

test('closing a panel while its HTML loads does not recreate a panel after the close', async t => {
    const h = await harness(t);
    const originalRead = h.host.workspace.fs.readFile;
    let release: (() => void) | undefined; let first = true;
    h.host.workspace.fs.readFile = async (uri: Uri) => {
        if (first && uri.path.endsWith('scenarioProperties.html')) {
            first = false; await new Promise<void>(resolve => { release = resolve; });
        }
        return originalRead(uri);
    };
    const opening = h.panel.open(h.sourceUri);
    for (let attempts = 0; !release && attempts < 100; attempts++) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.ok(release);
    await h.panels[0].dispose(); release(); await opening;
    assert.equal(h.panels.length, 1); assert.equal(h.panels[0].disposed, true);
});

test('reopening the sidebar after source edits loads the current YAML values', async t => {
    const h = await harness(t); const previous = await h.open(); await previous.dispose();
    await h.edit(h.sourceUri, sourceText.replace('Drive', 'After sidebar close'));
    await h.host.commands.executeCommand('kotTestToolkit.scenarioProperties.focus');
    const current = h.panels.at(-1);
    assert.equal(current.state().source.model.header.find((field: any) => field.key === 'Проект').value, 'After sidebar close');
});

test('native Properties follows features, preserves native edits, redirects generated features and clears on webviews', async t => {
    const { FeaturePropertiesController } = await import('../src/featurePropertiesController');
    const h = await harness(t);
    const featureUri = Uri.file(path.join(h.root, 'test.feature')); await fsp.writeFile(featureUri.fsPath, 'Feature: Test\nScenario: Ready\n');
    const generatedUri = Uri.file(path.join(h.root, 'generated.feature')); await fsp.writeFile(generatedUri.fsPath, 'Feature: Generated\nScenario: Ready\n');
    let favorite = false;
    h.panel.attachLibrarySupport({
        favorite: () => ({ canFavorite: true, favorite }), toggleFavorite: async () => { favorite = !favorite; },
        sourceForGenerated: async (uri: Uri) => uri.toString() === generatedUri.toString() ? h.sourceUri : undefined,
        onDidChange: () => ({ dispose() {} }),
        createFeatureController: (documents: any) => new FeaturePropertiesController({ ...documents,
            decorate: async () => ({ canFavorite: true, favorite }), action: async action => { if (action === 'favorite') { favorite = !favorite; } } })
    });
    const view = await h.open(featureUri); assert.equal(view.webview.messages.at(-1).command, 'featureState');
    assert.equal(view.state().model.title, 'Test');
    await view.receive.fire({ command: 'featureAction', uri: featureUri.toString(), version: view.state().version, action: 'edit', field: 'title', value: 'Changed', baseValue: 'Test' });
    assert.match((await h.openDocument(featureUri)).getText(), /Feature: Changed/u); assert.equal(view.state().dirty, true);
    await view.receive.fire({ command: 'featureAction', uri: featureUri.toString(), version: view.state().version, action: 'pin' });
    await h.setActive(await h.openDocument(h.sourceUri)); assert.equal(view.state().uri, featureUri.toString());
    await view.receive.fire({ command: 'featureAction', uri: featureUri.toString(), version: view.state().version, action: 'pin' });
    assert.equal(view.state().source.uri, h.sourceUri.toString());
    await h.setActive(await h.openDocument(generatedUri)); assert.equal(view.state().source.uri, h.sourceUri.toString());
    assert.ok(!h.textOpens.includes(generatedUri.toString()), 'compiled source remains the active text editor');
    await h.setActive(await h.openDocument(featureUri));
    await view.receive.fire({ command: 'featureAction', uri: featureUri.toString(), version: view.state().version, action: 'pin' });
    await fsp.unlink(featureUri.fsPath); await h.deleted.fire({ files: [featureUri] });
    await h.setActive(await h.openDocument(h.sourceUri)); assert.equal(view.state().pinned, true);
    await view.receive.fire({ command: 'featureAction', uri: featureUri.toString(), version: view.state().version, action: 'pin' });
    assert.equal(view.state().source.uri, h.sourceUri.toString(), 'a missing pinned feature must allow unpin and resume following');
    await h.setActiveWebview('kotTestToolkit.infobaseManager'); assert.equal(view.state().source, null);
});

test('YAML favorite actions use the shared service and publish external changes', async t => {
    const h = await harness(t); let favorite = false; let changed: (() => void) | undefined;
    h.panel.attachLibrarySupport({ favorite: () => ({ canFavorite: true, favorite }),
        toggleFavorite: async () => { favorite = !favorite; }, sourceForGenerated: async () => undefined,
        createFeatureController: () => undefined, onDidChange: (listener: () => void) => { changed = listener; return { dispose() {} }; } });
    const view = await h.open(); assert.equal(view.state().favorite, false);
    await view.receive.fire({ command: 'action', action: 'favorite', documentUri: h.sourceUri.toString(), documentVersion: view.state().source.version }); assert.equal(view.state().favorite, true);
    favorite = false; changed?.(); await waitFor(() => view.state().favorite === false);
    assert.equal(h.actions.length, 0);
});

test('following a feature resumes correctly after explicitly opening Properties for another feature', async t => {
    const { FeaturePropertiesController } = await import('../src/featurePropertiesController');
    const h = await harness(t); await h.open();
    const a = Uri.file(path.join(h.root, 'a.feature')); const b = Uri.file(path.join(h.root, 'b.feature'));
    await fsp.writeFile(a.fsPath, 'Feature: A\nScenario: Ready\n'); await fsp.writeFile(b.fsPath, 'Feature: B\nScenario: Ready\n');
    h.panel.attachLibrarySupport({ favorite: () => ({ canFavorite: false, favorite: false }), toggleFavorite: async () => undefined,
        sourceForGenerated: async () => undefined, onDidChange: () => ({ dispose() {} }),
        createFeatureController: (documents: any) => new FeaturePropertiesController({ ...documents, decorate: async () => ({}), action: async () => undefined }) });
    await h.setActive(await h.openDocument(a)); assert.equal(h.panels.at(-1)!.state().uri, a.toString());
    await h.panel.open(b); assert.equal(h.panels.at(-1)!.state().uri, b.toString());
    await h.setActive(await h.openDocument(a)); assert.equal(h.panels.at(-1)!.state().uri, a.toString());
});


test('SPPR native script opens properties bound to meta.yaml and keeps script and metadata edits separate', async t => {
    const h = await harness(t);
    const folder = path.join(h.yamlRoot, 'native'); await fsp.mkdir(folder);
    const meta = Uri.file(path.join(folder, 'meta.yaml'));
    const script = Uri.file(path.join(folder, 'scen.feature'));
    await fsp.writeFile(meta.fsPath, sourceText.slice(0, sourceText.indexOf('ТекстСценария:')));
    await fsp.writeFile(script.fsPath, 'Given native script\n');
    const view = await h.open(script);
    assert.equal(view.state().source.uri, meta.toString());
    assert.equal(view.state().source.model.kind, 'scenario');
    await h.edit(script, 'Given unsaved script\n');
    await view.receive.fire({ command: 'edit', documentUri: meta.toString(), documentVersion: view.state().source.version, edit: { section: 'ДанныеСценария', field: 'Проект', value: 'Native project' } });
    const metadataDocument = await h.openDocument(meta);
    assert.match(metadataDocument.getText(), /Проект: "Native project"/u);
    assert.equal((await h.openDocument(script)).getText(), 'Given unsaved script\n');
    assert.equal(metadataDocument.getText().includes('ТекстСценария:'), false);
});

test('a successful source URI move clears deletion events raised during the format transaction', async t => {
    const h = await harness(t); const panel = await h.open();
    const next = Uri.file(path.join(h.yamlRoot, 'converted.yaml'));
    h.panel.host.runAction = async () => {
        await fsp.rename(h.sourceUri.fsPath, next.fsPath);
        h.panel.fileEvent(h.sourceUri, 'delete');
        return { sourceUri: next.toString(), uriMoves: [{ oldUri: h.sourceUri.toString(), newUri: next.toString() }] };
    };
    await panel.receive.fire({ command: 'action', action: 'convertFormat' });
    assert.equal(panel.state().source.uri, next.toString());
    assert.equal(panel.state().error, undefined);
    await panel.receive.fire({ command: 'action', action: 'save' });
    assert.equal(panel.state().error, undefined);
    assert.ok(h.saved.includes(next.toString()));
});
