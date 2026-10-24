import * as projectSetupGate from '../src/projectSetupGate';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as synchronizer from '../src/projectCatalogSettings';
import { ProjectPropertyCatalogStore, validatePropertyCatalogName } from '../src/projectPropertyCatalogStore';
import { TestNumberingStore } from '../src/testNumberingStore';
import * as discovery from '../src/projectCatalogDiscovery';

async function waitFor(condition: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 2000;
    while (!await condition()) {
        assert.ok(Date.now() < deadline, 'settings action did not finish');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function fixture(t: test.TestContext, multiRoot = false, savedWorkspace = false) {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kot-native-catalog-controller-'));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
    const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });
    const roots = multiRoot ? [path.join(base, 'first'), path.join(base, 'second')] : [base];
    for (const root of roots) { await fs.promises.mkdir(root, { recursive: true }); }
    const folders = roots.map((root, index) => ({ uri: uri(root), name: `Project ${index + 1}` }));
    const workspaceConfig = new Map<string, unknown>(); const globalConfig = new Map<string, unknown>();
    const folderScope = multiRoot || savedWorkspace;
    const configs = roots.map(() => folderScope ? new Map<string, unknown>() : workspaceConfig);
    const [root] = roots; const [config] = configs;
    const baseline = new Map<string, unknown>(); const errors: string[] = [];
    const callbacks: Array<(event: { affectsConfiguration(key: string, resource?: { fsPath: string }): boolean }) => unknown> = [];
    const event = (key: string, folderIndex?: number) => ({
        affectsConfiguration: (changed: string, resource?: { fsPath: string }) => changed === `kotTestToolkit.${key}`
            && (!resource || folderIndex === undefined ? !resource || !configs[roots.indexOf(resource.fsPath)]?.has(key) : roots[folderIndex] === resource.fsPath)
    });
    const watchers: Array<{ change?: () => void }> = [];
    const updates: string[] = []; const commands: Array<{ command: string; args: unknown[] }> = [];
    let afterUpdate: ((key: string, value: unknown, target: number) => void) | undefined;
    const information: string[] = []; const notifications: Array<{ actions: string[]; respond(value?: string): void }> = [];
    const disposable = () => ({ dispose() {} });
    const host = {
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        RelativePattern: class { constructor(readonly base: unknown, readonly pattern: string) {} },
        workspace: {
            workspaceFolders: folders, workspaceFile: savedWorkspace ? uri(path.join(base, 'project.code-workspace')) : undefined, textDocuments: [],
            getWorkspaceFolder: (resource: { fsPath: string }) => folders.find(folder => resource.fsPath === folder.uri.fsPath || resource.fsPath.startsWith(folder.uri.fsPath + path.sep)),
            onDidChangeConfiguration: (callback: typeof callbacks[number]) => { callbacks.push(callback); return disposable(); },
            onDidChangeWorkspaceFolders: () => disposable(),
            createFileSystemWatcher: () => {
                const watch: typeof watchers[number] = {}; watchers.push(watch);
                return { onDidChange: (callback: () => void) => { watch.change = callback; return disposable(); }, onDidCreate: () => disposable(), onDidDelete: () => disposable(), dispose() {} };
            },
            getConfiguration: (_section: string, resource?: { fsPath: string }) => ({
                get: (key: string, fallback: unknown) => (resource ? configs[roots.indexOf(resource.fsPath)]?.get(key) : undefined) ?? workspaceConfig.get(key) ?? globalConfig.get(key) ?? fallback,
                inspect: (key: string) => ({ workspaceFolderValue: folderScope && resource ? configs[roots.indexOf(resource.fsPath)].get(key) : undefined,
                    workspaceValue: workspaceConfig.get(key), globalValue: globalConfig.get(key) }),
                update: async (key: string, value: unknown, target: number) => {
                    assert.ok([1, 2, 3].includes(target)); updates.push(key);
                    assert.ok(updates.length < 60, 'configuration reflection loop');
                    const index = resource ? roots.indexOf(resource.fsPath) : 0;
                    const values = target === 1 ? globalConfig : target === 2 ? workspaceConfig : configs[index];
                    if (value === undefined) { values.delete(key); } else { values.set(key, value); }
                    for (const callback of callbacks) { void callback(event(key, target === 3 && folderScope ? index : undefined)); }
                    afterUpdate?.(key, value, target);
                }
            })
        }, window: {
            activeTextEditor: undefined as { document: { uri: ReturnType<typeof uri> } } | undefined,
            showErrorMessage: async (message: string) => { errors.push(message); },
            showInformationMessage: (message: string, ...actions: string[]) => {
                information.push(message);
                return new Promise<string | undefined>(resolve => { notifications.push({ actions, respond: resolve }); });
            },
            showWorkspaceFolderPick: async () => undefined
        }, commands: { executeCommand: async (command: string, ...args: unknown[]) => { commands.push({ command, args }); } }
    };
    const sourcePath = path.join(process.cwd(), 'src/nativeProjectCatalogSettings.ts');
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} };
    const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : 'export {};';
    const deps: Record<string, unknown> = { './projectSetupGate': projectSetupGate, vscode: host, './projectCatalogSettings': synchronizer, './projectCatalogDiscovery': discovery,
        './projectPropertyCatalogStore': { ProjectPropertyCatalogStore, validatePropertyCatalogName }, './testNumberingStore': { TestNumberingStore },
        './workspaceScanner': { scanWorkspaceForScenarioCatalog: async () => ({ all: [] }) },
        './localization': { getTranslator: async () => (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)] ?? '') } };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
        { module, exports: module.exports, require: (name: string) => deps[name] ?? require(name), console, setTimeout, clearTimeout, structuredClone });
    const api = module.exports as { registerNativeProjectCatalogSettings(context: unknown, provider?: unknown): Promise<{ dispose(): void }> };
    const start = async (provider?: unknown) => {
        assert.equal(typeof api.registerNativeProjectCatalogSettings, 'function');
        const service = await api.registerNativeProjectCatalogSettings({ extensionUri: uri(process.cwd()), workspaceState: {
            get: (key: string) => baseline.get(key), update: async (key: string, value: unknown) => { baseline.set(key, value); }
        } }, provider);
        t.after(() => service.dispose()); return service;
    };
    const change = async (key: string, value: unknown, scope: number | 'workspace' | 'user' = 0) => {
        const values = scope === 'user' ? globalConfig : scope === 'workspace' ? workspaceConfig : configs[scope];
        if (value === undefined) { values.delete(key); } else { values.set(key, value); }
        await Promise.all(callbacks.map(callback => callback(event(key, typeof scope === 'number' ? scope : undefined))));
    };
    return { root, roots, start, change, config, configs, workspaceConfig, globalConfig, updates, errors, information, notifications, commands, watchers,
        setActive: (index: number) => { host.window.activeTextEditor = { document: { uri: uri(path.join(roots[index], 'scenario.yaml')) } }; },
        onUpdate: (callback: typeof afterUpdate) => { afterUpdate = callback; },
        stores: roots.map(root => new ProjectPropertyCatalogStore(root)), store: new ProjectPropertyCatalogStore(root), numbering: new TestNumberingStore(root) };
}

test('cached scanner headers appear in native settings at startup and after a saved header changes', async t => {
    const f = await fixture(t);
    let refresh = () => {};
    const info = { name: 'Test', relativePath: 'test', yamlFileUri: { scheme: 'file', fsPath: path.join(f.root, 'test/scen.yaml') },
        catalogValues: { project: 'Drive', responsible: 'Alex' } };
    const provider = { getScenarioCatalog: () => ({ all: [info] }),
        onDidUpdateScenarioCatalog: (callback: () => void) => { refresh = callback; return { dispose() {} }; } };
    await f.start(provider);
    assert.deepEqual(f.config.get('catalogs.projects'), ['Drive']);
    assert.deepEqual(f.config.get('catalogs.responsibles'), ['Alex']);
    info.catalogValues.responsible = 'Nikolay'; refresh();
    await waitFor(() => (f.config.get('catalogs.responsibles') as string[]).includes('Nikolay'));
    assert.deepEqual((await f.store.read()).responsibles, ['Alex', 'Nikolay']);
    assert.deepEqual(f.errors, []);
});

test('ordinary settings lists persist in the shared catalog without a palette command', async t => {
    const h = await fixture(t); await h.start();
    await h.change('catalogs.responsibles', ['Owner', 'Another owner']);
    assert.deepEqual((await h.store.read()).responsibles, ['Owner', 'Another owner']);
    assert.deepEqual(h.errors, []);
});

test('native key/value tables edit series authors and system function names with stable compiler UIDs', async t => {
    const h = await fixture(t); await h.start();
    await h.change('numbering.series', { '000012': 'Owner' });
    assert.deepEqual((await h.numbering.read()).series, [{ prefix: '000012', author: 'Owner', lastNumber: 0 }]);
    await h.change('catalogs.systemFunctions', { Sales: '' });
    const fn = (await h.store.read()).systemFunctions![0];
    assert.equal(fn.name, 'Sales'); assert.match(fn.uid, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(JSON.parse(JSON.stringify(h.config.get('catalogs.systemFunctions'))), { Sales: fn.uid });
    await h.change('catalogs.systemFunctions', { 'Sales renamed': fn.uid });
    assert.equal((await h.store.read()).systemFunctions![0].uid, fn.uid);
});

test('Git catalog changes refresh native controls without feedback loops', async t => {
    const h = await fixture(t); await h.store.add('projects', 'Initial'); await h.start();
    await h.store.add('projects', 'From Git'); h.watchers[0].change?.();
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.deepEqual(JSON.parse(JSON.stringify(h.config.get('catalogs.projects'))), ['Initial', 'From Git']);
    const writes = h.updates.length; await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(h.updates.length, writes); assert.deepEqual(h.errors, []);
});

test('Workspace edits reach each project despite generated Folder projections', async t => {
    const h = await fixture(t, true);
    await h.stores[0].add('projects', 'First project'); await h.stores[1].add('projects', 'Second project');
    await h.start();
    await h.change('catalogs.projects', ['Shared workspace edit'], 'workspace');
    for (const store of h.stores) { assert.deepEqual((await store.read()).projects, ['Shared workspace edit']); }
    assert.deepEqual(h.errors, []);
});

test('human Folder overrides retain normal precedence over later Workspace edits', async t => {
    const h = await fixture(t, true);
    for (const store of h.stores) { await store.add('projects', 'Initial'); }
    await h.start();
    await h.change('catalogs.projects', ['Human folder override'], 0);
    await h.change('catalogs.projects', ['Workspace edit'], 'workspace');
    assert.deepEqual((await h.stores[0].read()).projects, ['Human folder override']);
    assert.deepEqual((await h.stores[1].read()).projects, ['Workspace edit']);
    assert.deepEqual(h.errors, []);
});

test('unordered numeric prefixes do not cause native reflection loops', async t => {
    const h = await fixture(t);
    await h.numbering.addSeries('200000', 'Second', []); await h.numbering.addSeries('100000', 'First', []);
    await h.start(); await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(h.updates.filter(key => key === 'numbering.series').length, 1);
    assert.deepEqual(h.errors, []);
});

test('ambiguous system function names cannot lose compiler UIDs through the native map projection', async t => {
    const h = await fixture(t);
    await h.store.ensureSystemFunctions([
        { name: 'Same name', uid: '11111111-2222-4333-8444-555555555555' },
        { name: 'Same name', uid: '22222222-2222-4333-8444-555555555555' }
    ]);
    const before = await fs.promises.readFile(h.store.filePath, 'utf8');
    await h.start(); await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await fs.promises.readFile(h.store.filePath, 'utf8'), before);
    assert.match(h.errors.join('\n'), /unique|duplicate|ambiguous/iu);
});

test('adding a series on the User tab offers an explicit transfer before changing the project', async t => {
    const h = await fixture(t); await h.numbering.addSeries('000013', 'Existing author', []);
    await h.numbering.claim('000013005', async () => []);
    await h.start(); await h.change('numbering.series', { '000012': 'New author' }, 'user');
    assert.equal((await h.numbering.read()).series.length, 1);
    assert.equal(h.globalConfig.has('numbering.series'), true);
    assert.ok(h.notifications.at(-1)?.actions.includes('Move values to project'));
    h.notifications.at(-1)?.respond('Move values to project');
    await waitFor(() => h.commands.length > 0);
    assert.deepEqual((await h.numbering.read()).series, [
        { prefix: '000013', author: 'Existing author', lastNumber: 5 },
        { prefix: '000012', author: 'New author', lastNumber: 0 }
    ]);
    assert.equal(h.globalConfig.has('numbering.series'), false);
    assert.equal(h.commands.at(-1)?.command, 'workbench.action.openWorkspaceSettings');
    assert.deepEqual(h.errors, []);
});

test('opening project settings from a User-scope notice changes no catalog or User value', async t => {
    const h = await fixture(t); await h.start(); await h.change('catalogs.projects', ['Pending input'], 'user');
    h.notifications.at(-1)?.respond('Open project settings'); await waitFor(() => h.commands.length > 0);
    assert.deepEqual((await h.store.read()).projects, []);
    assert.deepEqual(h.globalConfig.get('catalogs.projects'), ['Pending input']); assert.deepEqual(h.errors, []);
});

test('a saved workspace with one folder opens the Folder scope containing the projected catalog', async t => {
    const h = await fixture(t, false, true); await h.store.add('projects', 'Shared project'); await h.start();
    await h.change('catalogs.projects', ['User input'], 'user');
    h.notifications.at(-1)?.respond('Open project settings'); await waitFor(() => h.commands.length > 0);
    assert.equal(h.commands.at(-1)?.command, '_workbench.action.openFolderSettings');
    assert.deepEqual(JSON.parse(JSON.stringify(h.config.get('catalogs.projects'))), ['Shared project']);
});

test('a rejected User transfer preserves the input and previous Workspace representation', async t => {
    const h = await fixture(t); await h.numbering.addSeries('000012', 'Original author', []); await h.start();
    const before = JSON.stringify(h.config.get('numbering.series'));
    await h.change('numbering.series', { '000012': '' }, 'user');
    h.notifications.at(-1)?.respond('Move values to project'); await waitFor(() => h.errors.length > 0);
    assert.equal((await h.numbering.read()).series[0].author, 'Original author');
    assert.deepEqual(h.globalConfig.get('numbering.series'), { '000012': '' });
    await waitFor(() => JSON.stringify(h.config.get('numbering.series')) === before);
});

test('a concurrent Workspace edit cannot clear User additions that never reached the shared catalog', async t => {
    const h = await fixture(t); await h.store.add('projects', 'Existing'); await h.start();
    await h.change('catalogs.projects', ['User addition'], 'user');
    let injected = false;
    h.onUpdate((key, value, target) => {
        if (key === 'catalogs.projects' && target !== 1 && Array.isArray(value) && value.includes('User addition') && !injected) {
            injected = true; void h.change(key, ['Concurrent Workspace edit'], 'workspace');
        }
    });
    h.notifications.at(-1)?.respond('Move values to project');
    await waitFor(async () => (await h.store.read()).projects.includes('Concurrent Workspace edit'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(h.globalConfig.get('catalogs.projects'), ['User addition']);
    assert.deepEqual((await h.store.read()).projects, ['Concurrent Workspace edit']);
});

test('a confirmed transfer of a new function with blank UID clears User only after the generated identity is saved', async t => {
    const h = await fixture(t); await h.start();
    await h.change('catalogs.systemFunctions', { 'New function': '' }, 'user');
    h.notifications.at(-1)?.respond('Move values to project'); await waitFor(() => h.commands.length > 0);
    assert.match((await h.store.read()).systemFunctions![0].uid, /^[0-9a-f-]{36}$/u);
    assert.equal(h.globalConfig.has('catalogs.systemFunctions'), false); assert.deepEqual(h.errors, []);
});

test('pending User catalog values are kept on startup until the transfer action is chosen', async t => {
    const h = await fixture(t);
    h.globalConfig.set('catalogs.responsibles', ['New author']); h.globalConfig.set('numbering.series', { '000012': 'New author' });
    await h.start();
    assert.deepEqual((await h.store.read()).responsibles, []);
    assert.equal(h.globalConfig.has('numbering.series'), true);
    h.notifications.at(-1)?.respond('Move values to project');
    await waitFor(() => h.commands.length > 0);
    assert.deepEqual((await h.store.read()).responsibles, ['New author']);
    assert.equal((await h.numbering.read()).series[0]?.prefix, '000012');
    assert.equal(h.globalConfig.has('catalogs.responsibles'), false); assert.equal(h.globalConfig.has('numbering.series'), false);
    assert.deepEqual(h.errors, []);
});

test('a confirmed User catalog transfer only enters the active project in a multi-root workspace', async t => {
    const h = await fixture(t, true); await h.start(); h.setActive(1);
    await h.change('catalogs.projects', ['Active project'], 'user');
    h.notifications.at(-1)?.respond('Move values to project');
    await waitFor(() => h.commands.length > 0);
    assert.deepEqual((await h.stores[0].read()).projects, []);
    assert.deepEqual((await h.stores[1].read()).projects, ['Active project']);
    assert.equal(h.globalConfig.has('catalogs.projects'), false); assert.deepEqual(h.errors, []);
});

test('native settings migrate explicitly configured legacy functions before any scenario is opened', async t => {
    const h = await fixture(t);
    const functions = [{ name: 'Existing function', uid: '11111111-2222-4333-8444-555555555555' }];
    h.workspaceConfig.set('newScenarioDefaults.systemFunctions', functions);
    await h.start();
    assert.deepEqual((await h.store.read()).systemFunctions, functions);
    assert.deepEqual(JSON.parse(JSON.stringify(h.config.get('catalogs.systemFunctions'))), { 'Existing function': functions[0].uid });
    assert.deepEqual(h.errors, []);
});

test('an existing empty shared function catalog takes precedence over legacy defaults', async t => {
    const h = await fixture(t); await h.store.ensureSystemFunctions([]);
    h.workspaceConfig.set('newScenarioDefaults.systemFunctions', [{ name: 'Old default', uid: '11111111-2222-4333-8444-555555555555' }]);
    await h.start(); assert.deepEqual((await h.store.read()).systemFunctions, []);
});
