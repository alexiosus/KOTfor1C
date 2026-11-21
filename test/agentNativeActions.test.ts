import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { AgentWorkspace, agentContains } from '../src/agentWorkspace';
import * as definitionQueries from '../src/agentDefinitionQueries';
import * as uiCommands from '../src/agentUiCommands';
import * as featureEditorActions from '../src/featureEditorActions';
import * as exportScenarioMetadata from '../src/exportScenarioMetadata';
import * as standaloneFeatureModel from '../src/standaloneFeatureModel';
import { AgentActions, type AgentActionPorts } from '../src/agentActions';
import { AgentStore } from '../src/agentStore';
import { agentString, validateAgentArguments } from '../src/agentTools';
import { VanessaDebugClientStore } from '../src/vanessaDebugClients';
import { ScenarioPropertiesSession } from '../src/scenarioPropertiesSession';
import { kotWindow } from '../src/kotInteraction';
import * as filesModel from '../src/scenarioFilesModel';

async function harness(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-native-actions-'));
    t.after(async () => { assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); });
    const uri = (file: string) => ({ fsPath: file, scheme: 'file', toString: () => pathToFileURL(file).href });
    const values = new Map<string, unknown>(); const secrets = new Map<string, string>(); const calls: unknown[][] = [];
    const context = { extensionPath: process.cwd(), workspaceState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } },
        secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } } };
    const documents: any[] = []; let propertySession: ScenarioPropertiesSession; let items: any[] = []; const files: any = {};
    const nativeWindow = { activeTextEditor: undefined as any, showInputBox: async () => undefined,
        showTextDocument: async (document: any) => { const editor = { document, selection: undefined }; nativeWindow.activeTextEditor = editor; return editor; } };
    const window = kotWindow(nativeWindow);
    const base = { id: 'existing', infobaseKind: 'file', infobasePath: root, displayName: 'Before', state: 'ready', roles: [], sources: [] };
    const module = { exports: {} as any }; const ts = require('typescript') as typeof import('typescript');
    const dependencies: Record<string, unknown> = {
        vscode: { window: nativeWindow, workspace: { textDocuments: documents, openTextDocument: async (target: { fsPath: string }) => documents.find(value => value.uri.fsPath === target.fsPath) },
            Uri: { file: uri, parse: (value: string) => uri(fileURLToPath(value)) }, Selection: class {},
            commands: { getCommands: async () => ['kotTestToolkit.fixScenarioIssues'], executeCommand: async (...args: unknown[]) => { calls.push(args); } },
            CancellationTokenSource: class { token = {}; cancel() {} } },
        './agentWorkspace': { AgentWorkspace, agentHash: (value: string) => require('crypto').createHash('sha256').update(value).digest('hex') },
        './agentTools': { agentString }, './vanessaDebugClients': { VanessaDebugClientStore },
        './agentDefinitionQueries': definitionQueries, './agentUiCommands': uiCommands,
        './featureEditorActions': featureEditorActions, './exportScenarioMetadata': exportScenarioMetadata, './standaloneFeatureModel': standaloneFeatureModel,
        './infobaseManager': { renameInfobaseInteractive: async (_context: unknown, target: any) => { target.displayName = await window.showInputBox({ title: 'Launcher name' }); return target.displayName; },
            exportInfobaseToDtInteractive: async (_context: unknown, target: unknown) => { calls.push(['dump', target]); } },
        './kotSettingsModel': {}, './kotWorkspaceConfiguration': {}, './yamlParametersManager': {}, './projectLibraryIntegration': {},
        './projectLibraryMetadata': {}, './projectGroupDisplayOrder': {}, './oneCPlatform': {},
        './spprScenarioFiles': { resolveScenarioSourceUris: async () => undefined },
        './scenarioFilesModel': filesModel,
        '../media/scenarioPropertiesProtocol.js': require(path.resolve('media/scenarioPropertiesProtocol.js'))
    };
    vm.runInNewContext(ts.transpileModule(await fs.readFile('src/agentNativeActions.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { exports: module.exports, module, process, Buffer, console, require: (name: string) => name in dependencies ? dependencies[name] : require(name) });
    const ports: any = { context, workspace: new AgentWorkspace(root), provider: { refreshFromExternalStateChange: async () => {} }, standalone: { refresh: async () => {} }, session: {},
        infobases: { refresh: async () => ({ infobases: [base] }) }, snapshots: { invalidate() {}, ensureReady: async () => ({ items, viewIdentity: 'empty' }) }, library: {}, favorites: {}, files,
        infobasePreferences: async () => ({}), properties: () => ({ session: propertySession }) };
    const adapter = module.exports.createAgentNativeActions(ports) as AgentActionPorts;
    return { root, adapter, calls, documents, context, base, uri, dependencies, files, ports, items: (value: any[]) => { items = value; },
        properties: (host: ConstructorParameters<typeof ScenarioPropertiesSession>[0]) => { propertySession = new ScenarioPropertiesSession(host); }, nativeWindow };
}

test('every contributed command and menu alias has an API route or an explicit native-user control', async t => {
    const h = await harness(t);
    const registered = new Set<string>();
    for (const file of await fs.readdir('src')) {
        if (!file.endsWith('.ts')) { continue; }
        const source = await fs.readFile(path.join('src', file), 'utf8');
        for (const match of source.matchAll(/register(?:TextEditor)?Command\(\s*['"](kotTestToolkit\.[^'"]+)['"]/gu)) { registered.add(match[1]); }
    }
    (h.dependencies.vscode as any).commands.getCommands = async () => [...registered];
    const coverage = await h.adapter.invoke('ui.commands', {}) as any[];
    assert.ok(coverage.length >= JSON.parse(await fs.readFile('package.json', 'utf8')).contributes.commands.length);
    for (const command of registered) { assert.ok(coverage.some(row => row.command === command), command); }
    assert.equal(coverage.filter(row => row.status === 'unmapped').length, 0, JSON.stringify(coverage.filter(row => row.status === 'unmapped')));
    const actions = new Set(h.adapter.list().map(action => action.id));
    for (const row of coverage) {
        if (row.action && !row.action.startsWith('kot_')) { assert.ok(actions.has(row.action), row.command); }
    }
    assert.equal(coverage.find(row => row.command === 'kotTestToolkit.agent.approveRepair').status, 'user_control');
    assert.ok(!actions.has('ui.agent.approveRepair')); assert.ok(!actions.has('ui.agent.stop'));
});

test('editor buffer saving rejects stale revisions and reports unsuccessful native saves', async t => {
    const h = await harness(t); const file = path.join(h.root, 'buffer.feature'); await fs.writeFile(file, 'saved');
    let text = 'edited'; let saved = 0;
    const document = { uri: h.uri(file), version: 2, isDirty: true, getText: () => text,
        save: async () => { saved++; await fs.writeFile(file, text); document.isDirty = false; return true; } };
    h.documents.push(document);
    const read = await h.adapter.invoke('ui.source_state', { source: file }) as any;
    assert.equal(read.text, 'edited'); assert.equal(read.dirty, true); assert.equal(await fs.readFile(file, 'utf8'), 'saved');
    text = 'newer'; document.version++;
    await assert.rejects(h.adapter.invoke('ui.save_source', { source: file, expectedRevision: read.revision }), /buffer changed/);
    assert.equal(saved, 0);
    const current = await h.adapter.invoke('ui.source_state', { source: file }) as any;
    const result = await h.adapter.invoke('ui.save_source', { source: file, expectedRevision: current.revision }) as any;
    assert.equal(saved, 1); assert.equal(result.dirty, false); assert.equal(await fs.readFile(file, 'utf8'), 'newer');
    document.isDirty = true; document.save = async () => false;
    await assert.rejects(h.adapter.invoke('ui.save_source', { source: file, expectedRevision: current.revision }), /Could not save/);
});

test('feature CodeLens routes use current native targets and reject stale source revisions', async t => {
    const h = await harness(t); const file = path.join(h.root, 'export.feature');
    const text = '#language: en\n@ExportScenarios\nFeature: export\nScenario: Own export\n    And Delay 1\n'; await fs.writeFile(file, text);
    const document = { uri: h.uri(file), version: 4, isDirty: false, getText: () => text }; h.documents.push(document);
    const read = await h.adapter.invoke('feature.editor_read', { source: file }) as any;
    assert.ok(read.structure.length); assert.ok(read.metadata.length);
    const target = read.structure[0].target;
    await assert.rejects(h.adapter.invoke('feature.structure', { source: file, expectedRevision: 'stale', kind: target.kind, line: target.line }), /Feature changed/);
    assert.equal(h.calls.length, 0);
    await h.adapter.invoke('feature.structure', { source: file, expectedRevision: read.revision, kind: target.kind, line: target.line });
    assert.equal(h.calls[0][0], 'kotTestToolkit.editFeatureStructure');
    assert.equal((h.calls[0][1] as any).version, document.version); assert.equal((h.calls[0][1] as any).uri, h.uri(file).toString());
    const metadata = read.metadata[0].target;
    await h.adapter.invoke('feature.export_metadata', { source: file, expectedRevision: read.revision, ...metadata.scenarioStart, kind: metadata.kind });
    assert.equal(h.calls[1][0], 'kotTestToolkit.addExportScenarioMetadata'); assert.equal((h.calls[1][1] as any).documentVersion, 4);
    await assert.rejects(h.adapter.invoke('feature.structure', { source: file, expectedRevision: read.revision, kind: 'stepTag', line: 4 }), /stepLine/);
});

test('native UI routes preserve source validation, shared buffers and actual control results', async t => {
    const h = await harness(t); const api = (h.dependencies.vscode as any);
    api.commands.getCommands = async () => ['kotTestToolkit.setTestManagerStatusFilterBuilt', 'kotTestToolkit.vanessaControl.recording.copy'];
    h.ports.uiState = () => ({ statusFilter: 'built' });
    h.ports.authoring = { read: () => ({ pending: 'And a recorded step' }) };
    const state = await h.adapter.invoke('ui.setTestManagerStatusFilterBuilt', {}) as any;
    assert.equal(state.state.statusFilter, 'built');
    const copied = await h.adapter.invoke('ui.vanessaControl.recording.copy', {}) as any;
    assert.equal(copied.buffer.pending, 'And a recorded step');
    assert.equal((await h.adapter.invoke('debug.record_read', {}) as any).pending, 'And a recorded step');
    let stopped = 0; let detached = 0;
    Object.assign(h.ports.session, { snapshot: { status: 'ready' }, stop: async () => { stopped++; }, detach: async () => { detached++; } });
    await h.adapter.invoke('debug.stop', {}); await h.adapter.invoke('debug.detach', {});
    assert.equal(stopped, 1); assert.equal(detached, 1);
    assert.equal(h.adapter.list().find(value => value.id === 'debug.stop')!.interrupts, true);
    await assert.rejects(h.adapter.invoke('ui.insertUid', { source: path.join(h.root, '..', 'not-allowed'), line: 0 }), /outside|ENOENT/);
    const schema = h.adapter.list().find(value => value.id === 'ui.insertUid')!.inputSchema;
    assert.throws(() => validateAgentArguments(schema, { source: 'allowed', command: 'workbench.action.terminal.new' }), /arguments/);
});

test('native catalog is unique, schema guarded and invokes a named launcher wizard through the real action runner', async t => {
    const h = await harness(t); const entries = h.adapter.list();
    assert.ok(entries.length > 80); assert.equal(new Set(entries.map(value => value.id)).size, entries.length);
    assert.ok(entries.some(value => value.id === 'properties.apply')); assert.ok(entries.some(value => value.id === 'infobase.restore_template'));
    const store = new AgentStore(path.join(h.root, 'operations')); const actions = new AgentActions(store, h.adapter); t.after(() => actions.dispose());
    await assert.rejects(actions.start('workbench.action.terminal.new', {}, 'arbitrary'), /Unknown action/);
    await assert.rejects(actions.start('infobase.rename', { infobaseId: 'existing', command: 'anything' }, 'schema'), /arguments/);
    const operation = await actions.start('infobase.rename', { infobaseId: 'existing' }, 'rename');
    for (let i = 0; (await store.get(operation.id)).status !== 'awaiting_agent' && i < 200; i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
    const question = actions.question(operation.id); assert.equal(question.title, 'Launcher name');
    await actions.answer(operation.id, question.id, { text: 'KOT-test-ib' }, 'name');
    for (let i = 0; actions.busy && i < 200; i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal((await store.get(operation.id)).status, 'completed'); assert.equal(h.base.displayName, 'KOT-test-ib');
    await h.adapter.invoke('infobase.dump_dt', { infobaseId: 'existing' }); assert.deepEqual(h.calls[0], ['dump', h.root]);
    await assert.rejects(h.adapter.invoke('infobase.rename', { infobaseId: 'stale' }), /infobase changed/);
});

test('attachments select source files by default, require explicit compiled resources and cancel changed uploads', async t => {
    const h = await harness(t); const file = path.join(h.root, 'scen.yaml'); await fs.writeFile(file, 'source');
    const attachment = path.join(h.root, 'sample.txt'); await fs.writeFile(attachment, 'attachment');
    const item = { id: 'main', kind: 'mainScenario', sourceGroup: 'main', capturedLocation: { uri: h.uri(file).toString() },
        sourceScenarioFilesRootUri: h.uri(path.join(h.root, 'files')).toString(), scenarioFilesRootUri: h.uri(path.join(h.root, 'runtime/files')).toString(), compiledFeatureUri: h.uri(path.join(h.root, 'runtime/main.feature')).toString() };
    h.items([item]); let selected = ''; let received = ''; let completed = 0; let cancelled = 0; let changeSource = false;
    h.files.listChildren = async (target: any) => { selected = target.scenarioFilesRootUri; return []; };
    h.files.prepareDrop = async (target: any) => { selected = target.scenarioFilesRootUri; return { files: [{ transferId: 'upload', destinationRelativePath: 'sample.txt' }], skipped: [] }; };
    h.files.appendTransferChunk = async (_id: string, offset: number, chunk: string) => {
        const bytes = Buffer.from(chunk, 'base64'); received += bytes.toString();
        if (changeSource) { await fs.utimes(attachment, new Date(), new Date(Date.now() + 10000)); }
        return offset + bytes.length;
    };
    h.files.completeTransfer = async () => { completed++; }; h.files.cancelTransfer = async () => { cancelled++; };
    await h.adapter.invoke('attachments.list', { itemId: 'main' }); assert.equal(selected, item.sourceScenarioFilesRootUri);
    await h.adapter.invoke('attachments.list', { itemId: 'main', resource: 'compiled' }); assert.equal(selected, item.scenarioFilesRootUri);
    await h.adapter.invoke('attachments.import', { itemId: 'main', path: attachment });
    assert.equal(received, 'attachment'); assert.equal(completed, 1); assert.equal(selected, item.sourceScenarioFilesRootUri);
    changeSource = true;
    await assert.rejects(h.adapter.invoke('attachments.import', { itemId: 'main', path: attachment }), /changed during import/); assert.equal(cancelled, 1); assert.equal(completed, 1);
    h.items([{ ...item, kind: 'standaloneFeature', sourceGroup: 'standalone', sourceScenarioFilesRootUri: undefined }]);
    await assert.rejects(h.adapter.invoke('attachments.import', { itemId: 'main', path: attachment }), /Standalone features/);
});

test('native property API saves through the document session, rejects a stale model and refuses dirty sources', async t => {
    const h = await harness(t); const file = path.join(h.root, 'scen.yaml');
    const source = { uri: h.uri(file).toString(), text: 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Native\n    UID: native\n    Код: 001\n    Проект: Before\nТекстСценария: |\n    And I open a form\n', version: 1, dirty: false };
    await fs.writeFile(file, source.text); const editor = { uri: h.uri(file), isDirty: false }; h.documents.push(editor);
    h.properties({ readDocument: async value => { assert.equal(value, source.uri); return { ...source }; },
        replaceDocument: async (before, text) => { assert.equal(before.version, source.version); source.text = text; source.version++; source.dirty = true; return true; },
        saveDocument: async () => { await fs.writeFile(file, source.text); source.dirty = false; return true; }, listSettings: async () => [], loadGroups: async () => [],
        readMetadata: async () => undefined, ensureMetadata: async () => { throw new Error('No metadata needed'); }, runAction: async () => {} });
    const read = await h.adapter.invoke('properties.read', { source: file }) as any;
    const message = { command: 'edit', documentUri: source.uri, documentVersion: 1, edit: { section: 'ДанныеСценария', field: 'Проект', value: 'After' } };
    validateAgentArguments(h.adapter.list().find(value => value.id === 'properties.apply')!.inputSchema, { source: file, expectedRevision: read.revision, message });
    const applied = await h.adapter.invoke('properties.apply', { source: file, expectedRevision: read.revision, message }) as any;
    assert.equal(applied.saved, true); assert.match(await fs.readFile(file, 'utf8'), /Проект: "After"/); assert.equal(source.dirty, false);
    await assert.rejects(h.adapter.invoke('properties.apply', { source: file, expectedRevision: read.revision, message }), /Properties changed/);
    editor.isDirty = true; await assert.rejects(h.adapter.invoke('properties.read', { source: file }), /Save the source/);
});

test('saved-client API validates revisions, persists secrets securely and preserves an omitted password on rename', async t => {
    const h = await harness(t);
    let read = await h.adapter.invoke('clients.list', {}) as any;
    await h.adapter.invoke('clients.save', { name: 'Administrator', infobase: h.root, username: 'administrator', password: 'private-native-password', expectedRevision: read.revision });
    read = await h.adapter.invoke('clients.list', {}) as any;
    assert.doesNotMatch(JSON.stringify(read), /private-native-password/);
    await h.adapter.invoke('clients.save', { id: read.clients[0].id, name: 'Renamed', expectedRevision: read.revision });
    const catalog = await new VanessaDebugClientStore(h.context.workspaceState, h.context.secrets).loadCatalog();
    assert.equal(catalog[0].password, 'private-native-password'); assert.equal(catalog[0].name, 'Renamed');
    await assert.rejects(h.adapter.invoke('clients.delete', { id: read.clients[0].id, expectedRevision: read.revision }), /catalog changed/);
    const schema = h.adapter.list().find(value => value.id === 'scenario.selection_set')!.inputSchema;
    assert.doesNotThrow(() => validateAgentArguments(schema, { expectedRevision: 'revision', states: { 'test-id': false } }));
    assert.throws(() => validateAgentArguments(schema, { expectedRevision: 'revision', states: { 'test-id': 'false' } }));
    await assert.rejects(h.adapter.invoke('settings.apply', { changes: [{ key: 'kotTestToolkit.agent.repairPolicy', scope: 'workspace', token: 'revision', value: 'all' }] }), /cannot grant itself/);
});

test('native prompt paths stay within allowed roots, with only the explicitly selected known base as a scoped exception', async t => {
    const h = await harness(t);
    const file = path.join(h.root, 'allowed.txt'); await fs.writeFile(file, 'allowed');
    assert.equal((await h.adapter.resolvePath(file, false) as any).fsPath, await fs.realpath(file));
    await assert.rejects(h.adapter.resolvePath(path.join(os.tmpdir(), 'outside-kot-action'), true), /outside|allowed/i);
    await assert.rejects(h.adapter.invoke('project.repair', {}), /source|path|string/i);
});
