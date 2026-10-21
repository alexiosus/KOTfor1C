import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { FormExplorerSnapshot } from '../src/formExplorerTypes';
import * as formStepsApi from '../src/vanessaControlFormSteps';

function load(file: string, dependencies: Record<string, unknown>) {
    const module = { exports: {} as any };
    const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, console, setTimeout, clearTimeout, setInterval, clearInterval, require: (name: string) => dependencies[name] ?? (name === './vanessaControlFormSteps' ? formStepsApi : require(name)) });
    return module.exports;
}
const form = { schemaVersion: 1, generatedAt: 'now', source: { adapter: 'MCP' }, form: { title: 'Own' }, elements: [], tables: [], attributes: [], commands: [], notes: [] } as FormExplorerSnapshot;

test('editor uses the shared live MCP cache and never falls back to another client snapshot on an MCP error', async () => {
    let mode = 'auto'; let snapshot: FormExplorerSnapshot | undefined = form; let available = true; let reads = 0;
    const live = load('src/formExplorerLiveSnapshot.ts', {
        vscode: { workspace: { getConfiguration: () => ({ get: () => mode }) } },
        './formExplorerPaths': { getFormExplorerSnapshotPath: () => { reads++; return null; }, getFormExplorerGeneratedArtifactsDirectory: () => null },
        './formExplorerEnrichment': { enrichFormExplorerSnapshot: async (value: unknown) => value }, './formExplorerTypes': {} });
    const handle = live.registerFormExplorerMcpSource({ get available() { return available; }, cached: () => snapshot });
    assert.equal((await live.loadLiveFormExplorerSnapshot()).snapshot, form); assert.equal(reads, 0);
    snapshot = undefined; assert.equal(await live.loadLiveFormExplorerSnapshot(), null); assert.equal(reads, 0);
    mode = 'mcp'; available = false; assert.equal(await live.loadLiveFormExplorerSnapshot(), null); assert.equal(reads, 0);
    mode = 'snapshot'; await live.loadLiveFormExplorerSnapshot(); assert.equal(reads, 1);
    handle.dispose();
});

test('Form Explorer takes MCP data through its existing model and does not touch bridge requests for unavailable MCP actions', async () => {
    const source = { available: true, state: { status: 'ready' }, refresh: async () => form };
    const module = load('src/formExplorerPanel.ts', {
        vscode: { workspace: { getConfiguration: () => ({ get: () => 'mcp' }) }, l10n: { t: (s: string) => s } },
        './localization': { getTranslator: async () => (s: string) => s }, './formExplorerEnrichment': { enrichFormExplorerSnapshot: async (value: unknown) => value },
        './formExplorerPaths': { getFormExplorerGeneratedArtifactsDirectory: () => null },
        './formExplorerTypes': {}, './infobaseManager': {}, './formExplorerStepSuggestions': {}, './gherkinLanguage': {}, './oneCInfobaseConnection': {}, './oneCPlatform': {} });
    const panel = Object.create(module.FormExplorerPanel.prototype);
    Object.assign(panel, { snapshotRevision: 0, mcpSource: source, context: {}, selectedElementPath: null, postState: async () => {}, refreshSuggestedSteps: async () => {},
        refreshStartedInfobaseProcessState: async () => { throw new Error('legacy process access'); },
        writeAdapterModeRequest: async () => { throw new Error('legacy bridge access'); } });
    await panel.refreshSnapshot(true); assert.equal(panel.latestSnapshot, form);
    assert.equal(panel.resolvedSnapshotPath, null); assert.equal(panel.adapterMode, 'mcp');
    await panel.requestAdapterLocator(); assert.match(panel.lastError, /snapshot source/iu);
    await panel.requestTableSnapshotRefresh('Form.Lines'); assert.match(panel.lastError, /snapshot source/iu);
});

test('a delayed legacy snapshot cannot replace the MCP form after switching sources', async () => {
    let mode = 'snapshot'; let finish!: (text: string) => void; let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const legacy = { ...form, source: { adapter: 'legacy' }, form: { title: 'Other client' } };
    const module = load('src/formExplorerPanel.ts', {
        vscode: { workspace: { getConfiguration: () => ({ get: () => mode }) } },
        'node:fs': { promises: { stat: async () => ({ mtime: new Date(), mtimeMs: 1, size: 1 }), readFile: () => { started(); return new Promise(resolve => { finish = resolve; }); } } },
        './localization': { getTranslator: async () => (s: string) => s }, './formExplorerTypes': { parseFormExplorerSnapshotText: () => legacy },
        './formExplorerEnrichment': { enrichFormExplorerSnapshot: async (value: unknown) => value }, './formExplorerPaths': {},
        './infobaseManager': {}, './formExplorerStepSuggestions': {}, './gherkinLanguage': {}, './oneCInfobaseConnection': {}, './oneCPlatform': {} });
    const panel = Object.create(module.FormExplorerPanel.prototype);
    Object.assign(panel, { snapshotRevision: 0, context: {}, mcpSource: { available: true, refresh: async () => form }, selectedElementPath: null,
        postState: async () => {}, refreshSuggestedSteps: async () => {}, refreshStartedInfobaseProcessState: async () => false,
        readAdapterModeState: async () => ({ mode: 'auto' }), resolveActualSnapshotPath: async () => '/own.json', resolvePendingOperation: () => {} });
    const pending = panel.refreshSnapshot(true); await reading;
    mode = 'mcp'; await panel.refreshSnapshot(true); finish('own fixture'); await pending;
    assert.equal(panel.latestSnapshot, form); assert.equal(panel.adapterMode, 'mcp');
});

test('cached MCP polling does not resend or rebuild the unchanged form on each timer tick', async () => {
    let posts = 0; let suggestions = 0;
    const module = load('src/formExplorerPanel.ts', {
        vscode: { workspace: { getConfiguration: () => ({ get: () => 'mcp' }) } },
        './formExplorerPaths': {}, './localization': {}, './formExplorerEnrichment': {}, './formExplorerTypes': {},
        './infobaseManager': {}, './formExplorerStepSuggestions': {}, './gherkinLanguage': {}, './oneCInfobaseConnection': {}, './oneCPlatform': {} });
    const panel = Object.create(module.FormExplorerPanel.prototype);
    Object.assign(panel, { snapshotRevision: 0, latestSnapshot: null, lastError: null, mcpSource: { available: true, refresh: async () => form }, selectedElementPath: null,
        postState: async () => { posts++; }, refreshSuggestedSteps: async () => { suggestions++; } });
    await panel.refreshSnapshot(true);
    for (let i = 0; i < 10; i++) { await panel.refreshSnapshot(false); }
    assert.equal(posts, 1); assert.equal(suggestions, 1);
    await panel.refreshSnapshot(true); assert.equal(posts, 2, 'an explicit refresh must still respond');
});

function nativePanel() {
    const module = load('src/formExplorerPanel.ts', {
        vscode: { workspace: { getConfiguration: () => ({ get: () => 'mcp' }) }, l10n: { t: (s: string) => s } },
        './formExplorerPaths': {}, './localization': {}, './formExplorerEnrichment': {}, './formExplorerTypes': {},
        './infobaseManager': {}, './formExplorerStepSuggestions': {}, './gherkinLanguage': { getConfiguredScenarioLanguage: () => 'en' }, './oneCInfobaseConnection': {}, './oneCPlatform': {} });
    const panel = Object.create(module.FormExplorerPanel.prototype);
    const snapshot = { ...form, elements: ['A', 'B', 'C'].map(name => ({ path: 'Form.' + name, name, kind: 'field', children: [] })) };
    Object.assign(panel, { panel: { visible: true }, nativeStepsRevision: 0, nativeStepsWanted: false, nativeStepsReading: false,
        latestSnapshot: snapshot, selectedElementPath: null, mcpSource: { available: true, inspectionReady: true },
        nativeSteps: { loading: false }, postState: async () => {}, refreshSuggestedSteps: async () => {} });
    return panel;
}
test('automatic native-step queue coalesces A→B→C and never runs concurrent analyses', async () => {
    const panel = nativePanel(); const reads: string[] = []; let finish!: (value: unknown) => void;
    const firstReply = new Promise(resolve => { finish = resolve; }); let obsolete!: () => boolean;
    panel.readNativeSteps = async (snapshot: FormExplorerSnapshot, path: string, current: () => boolean) => {
        reads.push(path);
        if (path === 'Form.A') { obsolete = current; return firstReply; }
        return { snapshot, text: 'And own C', cached: false };
    };
    await panel.handleElementSelectionChanged('Form.A');
    const pending = panel.refreshNativeSteps();
    await panel.handleElementSelectionChanged('Form.A');
    assert.equal(obsolete(), true, 'a repeated event must not supersede the current inspection');
    await panel.handleElementSelectionChanged('Form.B'); await panel.handleElementSelectionChanged('Form.C');
    assert.equal(obsolete(), false); assert.equal(panel.nativeSteps.text, undefined);
    await panel.refreshNativeSteps(); assert.deepEqual(reads, ['Form.A']);
    finish({ snapshot: panel.latestSnapshot, text: 'And obsolete A', cached: false }); await pending;
    assert.equal(panel.nativeSteps.text, undefined);
    await panel.refreshNativeSteps();
    assert.deepEqual(reads, ['Form.A', 'Form.C']); assert.equal(panel.nativeSteps.text, 'And own C');
    panel.invalidateNativeSteps();
});
test('a form change or panel disposal rejects late native replies; busy source postpones inspection', { timeout: 2_000 }, async () => {
    const panel = nativePanel(); let finish!: (value: unknown) => void; let reads = 0;
    let started!: () => void; let beginning = new Promise<void>(resolve => { started = resolve; });
    panel.readNativeSteps = () => { reads++; started(); return new Promise(resolve => { finish = resolve; }); };
    await panel.handleElementSelectionChanged('Form.A');
    panel.mcpSource.inspectionReady = false; await panel.refreshNativeSteps(); assert.equal(reads, 0);
    panel.mcpSource.inspectionReady = true; const pending = panel.refreshNativeSteps();
    await beginning;
    panel.latestSnapshot = { ...panel.latestSnapshot, form: { title: 'Other form' } };
    finish({ snapshot: form, text: 'And stale form', cached: false }); await pending;
    assert.equal(panel.nativeSteps.text, undefined);
    panel.invalidateNativeSteps();
    beginning = new Promise<void>(resolve => { started = resolve; });
    await panel.handleElementSelectionChanged('Form.B'); const next = panel.refreshNativeSteps();
    await beginning;
    panel.panel = null; panel.invalidateNativeSteps();
    finish({ snapshot: form, text: 'And closed panel', cached: false }); await next;
    assert.equal(panel.nativeSteps.text, undefined);
});
test('the MCP window picker activates an exact selected client window and publishes its refreshed form', async () => {
    let activated = '';
    const module = load('src/formExplorerPanel.ts', {
        vscode: { workspace: { getConfiguration: () => ({ get: () => 'mcp' }) }, l10n: { t: (s: string) => s }, ProgressLocation: { Notification: 15 },
            window: { showQuickPick: async () => 'Other', withProgress: async (_options: unknown, work: () => unknown) => work() } },
        './formExplorerPaths': {}, './localization': {}, './formExplorerEnrichment': {}, './formExplorerTypes': {},
        './infobaseManager': {}, './formExplorerStepSuggestions': {}, './gherkinLanguage': {}, './oneCInfobaseConnection': {}, './oneCPlatform': {} });
    const panel = Object.create(module.FormExplorerPanel.prototype);
    Object.assign(panel, { panel: {}, snapshotRevision: 0, latestSnapshot: null, selectedElementPath: null, postState: async () => {}, refreshSuggestedSteps: async () => {},
        mcpSource: { available: true, windowControlsAvailable: true, windows: async () => ({ client: 'own', titles: ['Other'] }),
            activateWindow: async (_windows: unknown, title: string) => { activated = title; return form; } } });
    await panel.handleMessage({ command: 'chooseClientWindow' });
    assert.equal(activated, 'Other'); assert.equal(panel.latestSnapshot, form);
});


test('repeated selection messages do not restart a finished native inspection', async () => {
    const panel = nativePanel(); let reads = 0;
    panel.readNativeSteps = async (snapshot: FormExplorerSnapshot) => ({ snapshot, text: 'And checked ' + ++reads, cached: false });
    await panel.handleElementSelectionChanged('Form.A'); await panel.refreshNativeSteps();
    await panel.handleElementSelectionChanged('Form.A'); await panel.refreshNativeSteps();
    assert.equal(reads, 1); assert.equal(panel.nativeSteps.text, 'And checked 1'); panel.invalidateNativeSteps();
});

test('returning to an inspected element shows its cached text immediately during background validation', async () => {
    const panel = nativePanel(); const cache = new Map<string, string>(); let finish!: (value: unknown) => void;
    panel.getCachedNativeSteps = (_snapshot: FormExplorerSnapshot, path: string) => cache.get(path);
    panel.readNativeSteps = async (snapshot: FormExplorerSnapshot, path: string) => {
        cache.set(path, 'And own ' + path);
        return { snapshot, text: cache.get(path), cached: false };
    };
    await panel.handleElementSelectionChanged('Form.A'); await panel.refreshNativeSteps();
    await panel.handleElementSelectionChanged('Form.B'); await panel.refreshNativeSteps();
    panel.readNativeSteps = () => new Promise(resolve => { finish = resolve; });
    await panel.handleElementSelectionChanged('Form.A');
    assert.equal(panel.nativeSteps.text, 'And own Form.A'); assert.equal(panel.nativeSteps.loading, true);
    const checking = panel.refreshNativeSteps();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(panel.nativeSteps.text, 'And own Form.A', 'validation must not blank the cached text');
    finish({ snapshot: panel.latestSnapshot, text: 'And own Form.A', cached: true }); await checking;
    assert.equal(panel.nativeSteps.loading, false); assert.equal(panel.nativeSteps.text, 'And own Form.A');
    panel.invalidateNativeSteps();
});
