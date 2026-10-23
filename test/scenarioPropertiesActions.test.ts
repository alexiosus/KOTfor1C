import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as properties from '../src/scenarioPropertiesModel';
import * as settingsModel from '../src/scenarioTestSettingsModel';
import { resolveProjectLibraryRoot } from '../src/projectLibraryMetadata';
import { buildScenarioCatalog } from '../src/scenarioCatalog';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
class Uri {
    constructor(readonly scheme: string, readonly path: string, readonly authority = '', readonly query = '', readonly fragment = '') {}
    static file(file: string) { return new Uri('file', file); }
    static parse(value: string) { const url = new URL(value); return new Uri(url.protocol.slice(0, -1), decodeURIComponent(url.pathname), url.host, url.search.slice(1), url.hash.slice(1)); }
    static joinPath(base: Uri, ...segments: string[]) { return base.with({ path: path.posix.join(base.path, ...segments) }); }
    with(change: Partial<Uri>) { return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.authority ?? this.authority, change.query ?? this.query, change.fragment ?? this.fragment); }
    get fsPath() { return this.path; }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`; }
}
const scenario = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "source-uid"\n    Имя: "Checkout"\n    Код: "001"\n    ПрофильПользователя: "Tester"\nТекстСценария: |\n    Given checkout\nВложенныеСценарии:\nПараметрыСценария:\nТегиСценария:\n';
const processSource = 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "source-uid"\n    Имя: "Checkout"\n    Код: "001"\nШагиПроцесса:\n';

function harness(initial = scenario) {
    const documents: any[] = [];
    const existing = new Set<string>();
    const commands: any[] = []; const shown: any[] = []; const editorOpens: string[] = [];
    const createdFolders: string[] = [];
    const renameCalls: any[] = []; const edits: any[] = []; const dialogs: any[] = []; const aiCalls: any[] = []; const groupCalls: any[] = [];
    const catalogCalls: any[] = []; let catalogResult: any; let catalogMutation: ((request: any) => void) | undefined;
    let metadataDocument: any; let metadataSaveMutation: (() => void) | undefined;
    let dialogUri: Uri | undefined = Uri.file('/repo/scenarios/Checkout/test/test.yaml');
    let sourceMain = false; let promptMutation: ((kind: string) => void) | undefined;
    let executeMutation: ((command: string) => void) | undefined; let renameMutation: (() => void) | undefined; let showMutation: (() => void) | undefined;
    let statMutation: ((uri: Uri) => void) | undefined;
    let input: string | undefined = 'Smoke'; let pickIndex = 0; let applySuccess = true; let renameResult: any;
    let catalogItems: any[] = [{ kind: 'scenario', uid: 'child-uid', name: 'Child', yamlFileUri: Uri.file('/repo/scenarios/Child.yaml'), relativePath: 'Child', scenarioCode: '002' }];
    const document = (uri: Uri, text: string, dirty = false) => {
        const result = { uri, text, isDirty: dirty, isClosed: false, version: 1, getText() { return this.text; }, positionAt(offset: number) { return { offset }; } };
        documents.push(result); existing.add(uri.toString()); return result;
    };
    const raw = document(Uri.file('/repo/scenarios/Checkout/scenario.yaml'), initial);
    const selectedSettings = document(Uri.file('/repo/scenarios/Checkout/test/variant.yaml'), 'ТипФайла: "НастройкаТеста"\nДанныеТеста:\n    UIDСценария: "source-uid"\n');
    const folder = { uri: Uri.file('/repo'), name: 'Project', index: 0 };
    class Edit {
        operations: any[] = [];
        createFile(uri: Uri, options: any) { this.operations.push({ kind: 'create', uri, options }); }
        insert(uri: Uri, position: any, text: string) { this.operations.push({ kind: 'insert', uri, position, text }); }
        replace(uri: Uri, range: any, text: string) { this.operations.push({ kind: 'replace', uri, range, text }); }
    }
    const host: any = {
        Uri, ViewColumn: { One: 1 }, Position: class { constructor(readonly line: number, readonly character: number) {} },
        Range: class { constructor(readonly start: any, readonly end: any) {} }, WorkspaceEdit: Edit,
        window: {
            activeTextEditor: undefined, visibleTextEditors: [],
            showTextDocument: async (doc: any, options: any) => {
                showMutation?.();
                shown.push({ uri: doc.uri.toString(), options }); const editor = { document: doc, viewColumn: options?.viewColumn ?? 1 };
                host.window.activeTextEditor = editor; return editor;
            },
            showSaveDialog: async (options: any) => { dialogs.push(options); promptMutation?.('save'); return dialogUri; },
            showQuickPick: async (items: any[], options: any) => { dialogs.push({ items, options }); promptMutation?.('pick'); return items[pickIndex]; },
            showInputBox: async (options: any) => { dialogs.push(options); promptMutation?.('group'); return input; }
        },
        workspace: {
            textDocuments: documents, workspaceFolders: [folder], getWorkspaceFolder: (uri: Uri) => uri.fsPath.startsWith('/repo/') ? folder : undefined,
            fs: { createDirectory: async (uri: Uri) => { createdFolders.push(uri.toString()); }, stat: async (uri: Uri) => { statMutation?.(uri); if (!existing.has(uri.toString())) { throw Object.assign(new Error('Missing'), { code: 'FileNotFound' }); } return { type: 1 }; } },
            openTextDocument: async (uri: Uri) => { const found = documents.find(doc => doc.uri.toString() === uri.toString()); if (!found) { throw Object.assign(new Error('Missing'), { code: 'FileNotFound' }); } return found; },
            applyEdit: async (edit: Edit) => {
                edits.push(edit.operations); if (!applySuccess) { return false; }
                for (const operation of edit.operations) {
                    if (operation.kind === 'create') {
                        if (existing.has(operation.uri.toString())) { return false; }
                        document(operation.uri, '');
                    } else {
                        const doc = documents.find(doc => doc.uri.toString() === operation.uri.toString()); assert.ok(doc);
                        if (operation.kind === 'insert') { doc.text = operation.text + doc.text; }
                        else { doc.text = doc.text.slice(0, operation.range.start.offset) + operation.text + doc.text.slice(operation.range.end.offset); }
                        doc.version++; doc.isDirty = true;
                    }
                }
                return true;
            }
        },
        commands: { executeCommand: async (command: string, ...args: any[]) => { commands.push({ command, args, activeUri: host.window.activeTextEditor?.document.uri.toString() }); executeMutation?.(command); } },
        l10n: { t: (value: string) => value }
    };
    const translator = (value: string, ...args: string[]) => value.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '');
    const dependencies: Record<string, any> = {
        vscode: host, './scenarioPropertiesModel': properties, './scenarioTestSettingsModel': settingsModel,
        './localization': { getTranslator: async () => translator },
        './scenarioPropertiesPanel': { createScenarioPropertiesHost: () => ({ readMetadata: async () => metadataDocument && ({ uri: metadataDocument.uri.toString(), text: metadataDocument.text, version: metadataDocument.version, dirty: metadataDocument.isDirty }),
            saveDocument: async () => { metadataSaveMutation?.(); if (metadataDocument) { metadataDocument.isDirty = false; } return true; } }) },
        './scenarioPropertiesCatalogs': { runScenarioPropertiesCatalogAction: async (_context: any, request: any) => {
            catalogCalls.push(request); catalogMutation?.(request); request.assertCurrent();
            if (catalogResult && request.mode === 'create') { await request.prepareWrite?.(); }
            return catalogResult;
        } },
        './scenarioCreator': { getProjectScenarioDefaults: async () => ({ systemFunctions: host.workspace.getConfiguration('kotTestToolkit').get('newScenarioDefaults.systemFunctions', []) }),
            promptForSelectedEtalonBaseValues: async (_t: any, _context: any, user: string, workspaceRoot: string) => { dialogs.push({ user, workspaceRoot }); promptMutation?.('base'); return { baseName: 'Etalon', baseId: 'base-id', userProfile: 'Runner' }; } },
        './scenarioAiDescription': { handleGenerateScenarioDescriptionWithAi: async (editor: any) => { await Promise.resolve(); aiCalls.push(editor.document.uri.toString()); } },
        './workspaceScanner': { scanWorkspaceForScenarioCatalog: async () => buildScenarioCatalog(catalogItems) },
        './scenarioScanRoot': { resolveScenarioScanRootFsPath: () => '/repo/scenarios', resolveProcessScanRootFsPath: () => '/repo/processes' },
        './projectLibraryIntegration': {
            projectedProjectScenario: (doc: any) => { const model = properties.readScenarioProperties(doc.getText()); return { kind: model.kind, name: model.title, uid: 'source-uid', ...(sourceMain ? { tabName: 'Smoke' } : {}) }; },
            projectLibraryEnvironment: () => ({ workspaceRoots: host.workspace.workspaceFolders.map((folder: any) => folder.uri.fsPath), scanRoots: ['/repo/scenarios', '/repo/processes'] }),
            assertProjectMetadataSaved: (root: string) => groupCalls.push({ guard: root }),
            persistProjectMetadata: async (doc: any, patch: any) => { groupCalls.push({ uri: doc.uri.toString(), patch }); return true; }
        },
        './projectLibraryMetadata': { resolveProjectLibraryRoot, createProjectLibraryStore: (root: string) => ({ ensureGroup: async (name: string, section: string) => { groupCalls.push({ root, name, section }); return { id: 'new-group' }; } }) }
    };
    function load(name: string) {
        const module = { exports: {} as any }; const file = path.join(process.cwd(), 'src', name + '.ts');
        if (fs.existsSync(file)) {
            vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
                { module, exports: module.exports, console, Buffer, require: (name: string) => dependencies[name.replace(/\.js$/u, '')] ?? require(name) });
        }
        return module.exports;
    }
    const rawEditor = { document: raw, viewColumn: 2 }; host.window.activeTextEditor = rawEditor; host.window.visibleTextEditors = [rawEditor];
    const api = load('scenarioPropertiesActions');
    assert.equal(typeof api.createScenarioPropertiesActions, 'function', 'Action adapter must route the panel actions');
    const textEditor = { open: async (uri: Uri) => { editorOpens.push(uri.toString()); host.window.activeTextEditor = rawEditor; return rawEditor; } };
    const context = { extensionUri: Uri.file('/extension') };
    const action = api.createScenarioPropertiesActions(context, textEditor, { renameScenario: async (target: any, value?: string, field?: string) => { renameCalls.push({ ...target, ...(value === undefined ? {} : { value, field }) }); renameMutation?.(); return renameResult; } });
    const source = () => ({ uri: raw.uri.toString(), text: raw.text, version: raw.version, dirty: raw.isDirty });
    return { action, source, raw, selectedSettings, editorOpens, commands, shown, renameCalls, edits, dialogs, aiCalls, groupCalls, existing, host, document, catalogCalls, createdFolders,
        catalogResult(value: any) { catalogResult = value; }, onCatalog(callback: (request: any) => void) { catalogMutation = callback; },
        metadata(value: any) { metadataDocument = value; }, onMetadataSave(callback: () => void) { metadataSaveMutation = callback; },
        main(value: boolean) { sourceMain = value; }, target(value: Uri | undefined) { dialogUri = value; },
        duringPrompt(callback: (kind: string) => void) { promptMutation = callback; }, onExecute(callback: (command: string) => void) { executeMutation = callback; }, onRename(callback: () => void) { renameMutation = callback; },
        onShow(callback: () => void) { showMutation = callback; }, renameOutcome(value: any) { renameResult = value; },
        onStat(callback: (uri: Uri) => void) { statMutation = callback; },
        catalog(value: any[]) { catalogItems = value; }, input(value: string | undefined) { input = value; }, pick(index: number) { pickIndex = index; }, apply(value: boolean) { applySuccess = value; } };
}

test('properties actions open native YAML and exactly selected settings; message values never choose a document', async () => {
    const h = harness();
    await h.action('openSource', h.source(), null, 'file:///other.yml');
    assert.equal(h.shown[0].uri, 'file:///repo/scenarios/Checkout/scenario.yaml');
    await h.action('openText', h.source(), null);
    assert.deepEqual(h.editorOpens, ['file:///repo/scenarios/Checkout/scenario.yaml']);
    await h.action('openSettings', h.source(), h.selectedSettings.uri.toString(), 'file:///other.yml');
    await h.action('base', h.source(), h.selectedSettings.uri.toString(), 'file:///other.yml');
    await h.action('users', h.source(), h.selectedSettings.uri.toString(), 'file:///other.yml');
    assert.equal(h.shown.at(-1).uri, h.selectedSettings.uri.toString());
    assert.deepEqual(h.commands.map(value => [value.command, value.args[0].toString()]), [
        ['kotTestToolkit.changeTestSettingsEtalonBaseFromEditor', 'file:///repo/scenarios/Checkout/test/variant.yaml'],
        ['kotTestToolkit.changeTestSettingsUserProfileFromEditor', 'file:///repo/scenarios/Checkout/test/variant.yaml']
    ]);
    await assert.rejects(h.action('base', h.source(), null, h.selectedSettings.uri.toString()), /select|settings/i);
});

test('identity and AI actions refuse unsaved source changes before any external action', async () => {
    const h = harness(); h.raw.isDirty = true;
    for (const action of ['rename', 'changeCode', 'systemFunction', 'aiDescription']) { await assert.rejects(h.action(action, h.source(), null), /save/i); }
    await assert.rejects(h.action('rename', h.source(), null), /save/i);
    assert.equal(h.renameCalls.length + h.commands.length + h.aiCalls.length + h.shown.length, 0);
});

test('nested identity actions activate the exact existing YAML document', async () => {
    const h = harness();
    await h.action('changeCode', h.source(), null);
    assert.equal(h.commands[0].command, 'kotTestToolkit.changeNestedScenarioCode');
    assert.equal(h.commands[0].activeUri, h.raw.uri.toString());
    assert.equal(h.shown[0].options.viewColumn, 2); assert.equal(h.shown[0].options.preview, false);
    assert.deepEqual(h.editorOpens, []);
    await h.action('systemFunction', h.source(), null);
    assert.equal(h.commands.at(-1).command, 'kotTestToolkit.changeScenarioSystemFunctionFromEditor');
    await h.action('aiDescription', h.source(), null);
    assert.deepEqual(h.aiCalls, [h.raw.uri.toString()]);
    assert.equal(h.commands.some(value => value.command.includes('generateScenarioDescription')), false);
});

test('main rename/code use the existing exact-URI rename service and do not reopen a missing old source', async () => {
    const h = harness(); h.main(true);
    await h.action('changeCode', h.source(), null);
    assert.deepEqual(h.renameCalls[0], { name: 'Checkout', uri: h.raw.uri.toString() });
    h.onRename(() => h.existing.delete(h.raw.uri.toString()));
    await h.action('rename', h.source(), null);
    assert.equal(h.editorOpens.length, 0);
});

test('direct name/code fields pass exact values through the identity service without input dialogs', async () => {
    const h = harness(); h.main(true);
    await h.action('rename', h.source(), null, 'New name');
    await h.action('changeCode', h.source(), null, 'NEW_CODE');
    assert.deepEqual(h.renameCalls.map(call => [call.uri, call.value, call.field]), [[h.raw.uri.toString(), 'New name', 'name'], [h.raw.uri.toString(), 'NEW_CODE', 'code']]);
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.shown.length, 0);
});

test('inline code action returns native identity moves to rebind the properties session', async () => {
    const h = harness();
    const result = { sourceUri: 'file:///repo/scenarios/002/scenario.yaml', uriMoves: [{ oldUri: 'file:///repo/scenarios/Checkout', newUri: 'file:///repo/scenarios/002' }] };
    h.renameOutcome(result);
    assert.equal(await h.action('changeCode', h.source(), null, '002'), result);
});

test('function dropdown updates the stock name and UID together using a native document edit', async () => {
    const h = harness();
    h.host.workspace.getConfiguration = () => ({ get: () => [{ name: 'Sales', uid: 'fn-uid' }] });
    await h.action('systemFunction', h.source(), null, 'fn-uid');
    assert.match(h.raw.text, /ФункцияСистемы: "Sales"/);
    assert.match(h.raw.text, /UIDФункцияСистемы: "fn-uid"/);
    assert.equal(h.dialogs.length, 0); assert.equal(h.raw.isDirty, true);
    await assert.rejects(h.action('systemFunction', h.source(), null, 'unknown'), /configured/);
});

test('process actions route to their registered commands with an exact source URI', async () => {
    const h = harness(processSource);
    for (const action of ['rename', 'changeCode', 'addSteps', 'changeGroup', 'openMetadata']) { await h.action(action, h.source(), null); }
    assert.deepEqual(h.commands.map(value => [value.command, value.args[0].toString()]), [
        ['kotTestToolkit.renameProcessFromEditor', h.raw.uri.toString()], ['kotTestToolkit.changeProcessCodeFromEditor', h.raw.uri.toString()],
        ['kotTestToolkit.addProcessSteps', h.raw.uri.toString()], ['kotTestToolkit.changeScenarioGroup', h.raw.uri.toString()],
        ['kotTestToolkit.openProjectMetadata', h.raw.uri.toString()]
    ]);
});

test('settings creation inserts compiler-linked YAML into a new dirty native document without opening it visibly', async () => {
    const h = harness(); await h.action('createSettings', h.source(), null);
    const created = h.host.workspace.textDocuments.find((doc: any) => doc.uri.toString() === 'file:///repo/scenarios/Checkout/test/001.yaml'); assert.ok(created);
    const parsed = properties.readScenarioProperties(created.text);
    assert.equal(parsed.header.find(field => field.key === 'UIDСценария')?.value, 'source-uid');
    assert.equal(parsed.header.find(field => field.key === 'ИдентификаторБазы')?.value, 'base-id');
    assert.equal(created.isDirty, true); assert.equal(h.shown.length, 0);
    assert.equal(h.dialogs[0].user, 'Tester');
    assert.equal(h.dialogs.length, 1, 'only infobase/user selection is needed; the settings path follows the source structure');
    assert.equal(h.edits[0][0].kind, 'create'); assert.equal(h.edits[0][0].options.overwrite, false);
    assert.deepEqual(h.createdFolders, ['file:///repo/scenarios/Checkout/test']);
});

test('settings creation rejects overwrite, dirty targets, foreign project paths and source changes during prompts', async () => {
    const existing = harness(); existing.document(Uri.file('/repo/scenarios/Checkout/test/001.yaml'), 'Existing');
    await assert.rejects(existing.action('createSettings', existing.source(), null), /exist|overwrite/i); assert.equal(existing.edits.length, 0);
    const dirty = harness(); const target = dirty.document(Uri.file('/repo/scenarios/Checkout/test/001.yaml'), 'Draft', true); dirty.existing.delete(target.uri.toString());
    await assert.rejects(dirty.action('createSettings', dirty.source(), null), /dirty|save|modified/i); assert.equal(dirty.edits.length, 0);
    const foreign = harness(scenario.replace('Код: "001"', 'Код: "../outside"'));
    await assert.rejects(foreign.action('createSettings', foreign.source(), null), /code|filename/i); assert.equal(foreign.edits.length, 0);
    const stale = harness(); const before = stale.source(); stale.duringPrompt(kind => { if (kind === 'base') { stale.raw.version++; stale.raw.text += '# changed\n'; } });
    await assert.rejects(stale.action('createSettings', before, null), /changed|stale/i); assert.equal(stale.edits.length, 0);
});

test('process and native scenario promotion use the same test/code.yaml structure as the creation wizard', async () => {
    const process = harness(processSource); await process.action('createSettings', process.source(), null);
    assert.equal(process.edits[0][0].uri.toString(), 'file:///repo/scenarios/Checkout/test/001.yaml');
    const native = harness(); native.raw.uri = Uri.file('/repo/scenarios/Checkout/meta.yaml'); native.existing.add(native.raw.uri.toString());
    await native.action('createSettings', native.source(), null);
    assert.equal(native.edits[0][0].uri.toString(), 'file:///repo/scenarios/Checkout/test/001.yaml');
    assert.equal(process.dialogs.length, 1); assert.equal(native.dialogs.length, 1);
});

test('nested picker uses unique catalog UIDs and its guarded edit preserves scenario body text', async () => {
    const h = harness(); const body = h.raw.text.slice(h.raw.text.indexOf('ТекстСценария:'));
    await h.action('addNested', h.source(), null);
    const model = properties.readScenarioProperties(h.raw.text);
    assert.equal(model.sections.find(section => section.key === 'ВложенныеСценарии')?.records?.[0].key, 'child-uid');
    assert.match(h.raw.text, /UIDВложенныйСценарий: "child-uid"/);
    assert.match(h.raw.text, /ТекстСценария: \|\n    Given checkout\n/);
    assert.equal(body.includes('Given checkout'), true);
    const stale = harness(); const before = stale.source(); stale.duringPrompt(kind => { if (kind === 'pick') { stale.raw.version++; } });
    await assert.rejects(stale.action('addNested', before, null), /changed|stale/i); assert.equal(stale.edits.length, 0);
});

test('open reference resolves an opaque current declaration key by UID and rejects arbitrary URI values', async () => {
    const h = harness(properties.addScenarioPropertyRecord(scenario, { section: 'ВложенныеСценарии' }, { UIDВложенныйСценарий: 'child-uid', ИмяСценария: 'Stale displayed name' }));
    await h.action('openReference', h.source(), null, 'child-uid');
    assert.deepEqual(h.editorOpens, ['file:///repo/scenarios/Child.yaml']);
    await assert.rejects(h.action('openReference', h.source(), null, 'file:///other.yml'), /reference|record|missing|stale/i);
    h.catalog([{ uid: 'child-uid', name: 'Child', yamlFileUri: Uri.file('/repo/scenarios/Child.yaml'), relativePath: '' }, { uid: 'child-uid', name: 'Copy', yamlFileUri: Uri.file('/repo/scenarios/Copy.yaml'), relativePath: '' }]);
    await assert.rejects(h.action('openReference', h.source(), null, 'child-uid'), /ambiguous|unique/i);
});

test('new group uses the source project owner and existing shared store, then persists the chosen group identity', async () => {
    const h = harness(processSource); await h.action('newGroup', h.source(), null);
    assert.ok(h.groupCalls.some(value => value.guard === '/repo'));
    assert.ok(h.groupCalls.some(value => value.root === '/repo' && value.name === 'Smoke' && value.section === 'process'));
    assert.ok(h.groupCalls.some(value => value.uri === h.raw.uri.toString() && value.patch.groupId === 'new-group'));
});

test('active-only action rechecks unsaved source changes after activating YAML', async () => {
    const h = harness(); h.onShow(() => { h.raw.isDirty = true; });
    await assert.rejects(h.action('changeCode', h.source(), null), /save/i);
    assert.equal(h.commands.length, 0);
});

test('active-only actions do not reopen a source removed by the awaited command', async () => {
    const h = harness(); h.onExecute(() => { h.existing.delete(h.raw.uri.toString()); });
    await h.action('changeCode', h.source(), null);
    assert.equal(h.commands.length, 1); assert.equal(h.editorOpens.length, 0);
});

test('process reference keys resolve their current subprocess UID through the registered editor command', async () => {
    const source = processSource.replace('ШагиПроцесса:\n', 'ШагиПроцесса:\n    - ШагиПроцесса1:\n        UID: "process-step"\n        ТипШага: "1"\n        ВложенныйПроцессUID: "child-process"\n        ВложенныйПроцессНаименование: "Child process"\n');
    const h = harness(source); h.catalog([{ kind: 'process', uid: 'child-process', name: 'Child process', yamlFileUri: Uri.file('/repo/processes/Child.yaml'), relativePath: '' }]);
    await h.action('openReference', h.source(), null, 'process-step');
    assert.equal(h.commands[0].command, 'kotTestToolkit.openScenarioEditor');
    assert.equal(h.commands[0].args[0].toString(), 'file:///repo/processes/Child.yaml');
    assert.equal(h.editorOpens.length, 0);
});

test('nested picker filters duplicate UIDs, processes and the source and rejects stale catalog choices', async () => {
    const h = harness(); const child = { uid: 'child-uid', name: 'Child', yamlFileUri: Uri.file('/repo/scenarios/Child.yaml'), relativePath: '' };
    h.catalog([child, { ...child, uid: 'dup', name: 'Duplicate A' }, { ...child, uid: 'dup', name: 'Duplicate B' },
        { ...child, uid: 'process', kind: 'process', name: 'Process' }, { ...child, uid: 'source-uid', yamlFileUri: h.raw.uri, name: 'Self' }]);
    h.duringPrompt(kind => { if (kind === 'pick') { h.catalog([{ ...child, name: 'Changed' }]); } });
    await assert.rejects(h.action('addNested', h.source(), null), /changed|ambiguous/i);
    assert.deepEqual(h.dialogs[0].items.map((item: any) => item.label), ['Child']);
    assert.equal(h.edits.length, 0);
});

test('process settings creation uses dirname/test/code.yaml and the process UID linkage', async () => {
    const h = harness(processSource);
    await h.action('createSettings', h.source(), null);
    const created = h.host.workspace.textDocuments.find((doc: any) => doc.uri.toString() === 'file:///repo/scenarios/Checkout/test/001.yaml'); assert.ok(created);
    const model = properties.readScenarioProperties(created.text);
    assert.equal(model.kind, 'processTest'); assert.equal(model.header.find(field => field.key === 'UIDПроцесса')?.value, 'source-uid');
    assert.equal(h.dialogs.length, 1);
});

test('settings creation rejects a target that acquires a dirty native draft during its existence check', async () => {
    const h = harness();
    h.onStat(uri => {
        if (uri.toString() === 'file:///repo/scenarios/Checkout/test/001.yaml') {
            const target = h.document(uri, 'Concurrent draft', true); h.existing.delete(target.uri.toString());
        }
    });
    await assert.rejects(h.action('createSettings', h.source(), null), /modified|dirty|save/i);
    assert.equal(h.edits.length, 0);
});

function catalogTarget(document: any, section: string, field: string, value?: string): string {
    return JSON.stringify({ documentUri: document.uri.toString(), documentVersion: document.version, section, field, ...(value === undefined ? {} : { value }) });
}
test('a native base choice atomically updates the selected settings name, identifier and valid user profile', async () => {
    const h = harness(); const selected = h.selectedSettings;
    h.catalogResult({ target: 'settings', value: 'new-id', fields: { ЭталоннаяБазаИмя: 'New base', ИдентификаторБазы: 'new-id', ПрофильПользователя: 'Runner' } });
    await h.action('catalogChoice', h.source(), selected.uri.toString(), catalogTarget(selected, 'ДанныеТеста', 'ЭталоннаяБазаИмя', 'new-id'));
    assert.equal(h.catalogCalls[0].kind, 'settingsBase'); assert.equal(h.catalogCalls[0].selectedSettings.uri, selected.uri.toString());
    assert.equal(h.edits.length, 1); assert.equal(h.raw.text, scenario);
    const model = properties.readScenarioProperties(selected.text);
    for (const [key, value] of Object.entries({ ЭталоннаяБазаИмя: 'New base', ИдентификаторБазы: 'new-id', ПрофильПользователя: 'Runner' })) {
        assert.equal(model.header.find(field => field.key === key)?.value, value);
    }
});
test('source catalog creation is cancelled without editing YAML, and otherwise creates and selects the new value', async () => {
    const h = harness();
    await h.action('createChoice', h.source(), null, catalogTarget(h.raw, 'ДанныеСценария', 'Проект'));
    assert.equal(h.edits.length, 0); assert.equal(h.catalogCalls[0].kind, 'project');
    h.catalogResult({ target: 'source', value: 'New project' });
    await h.action('createChoice', h.source(), null, catalogTarget(h.raw, 'ДанныеСценария', 'Проект'));
    assert.equal(properties.readScenarioProperties(h.raw.text).header.find(field => field.key === 'Проект')?.value, 'New project');
});

test('responsible selection updates its name and clears an old stock UID in one document edit', async () => {
    const h = harness();
    h.raw.text = h.raw.text.replace('ДанныеСценария:', 'ДанныеСценария:\n    Ответственный: Old owner\n    UIDОтветственный: previous-person');
    h.catalogResult({ target: 'source', value: 'New owner', fields: { Ответственный: 'New owner', UIDОтветственный: '' } });
    await h.action('catalogChoice', h.source(), null, catalogTarget(h.raw, 'ДанныеСценария', 'Ответственный', 'New owner'));
    assert.equal(h.catalogCalls[0].kind, 'responsible');
    assert.match(h.raw.text, /Ответственный: "New owner"/u);
    assert.match(h.raw.text, /UIDОтветственный: ""/u);
});
test('native catalog choices reject a settings document changed during a prompt and a foreign target', async () => {
    const h = harness(); h.catalogResult({ target: 'settings', value: 'Runner', fields: { ПрофильПользователя: 'Runner' } });
    h.onCatalog(() => { h.selectedSettings.text += '# concurrent edit\n'; h.selectedSettings.version++; });
    await assert.rejects(h.action('createChoice', h.source(), h.selectedSettings.uri.toString(), catalogTarget(h.selectedSettings, 'ДанныеТеста', 'ПрофильПользователя')), /changed/i);
    assert.equal(h.edits.length, 0);
    const foreign = h.document(Uri.file('/repo/foreign.yaml'), h.selectedSettings.text);
    await assert.rejects(h.action('catalogChoice', h.source(), h.selectedSettings.uri.toString(), catalogTarget(foreign, 'ДанныеТеста', 'ПрофильПользователя', 'Runner')), /not bound/i);
});
test('saving dirty metadata before catalog creation cannot rebase a concurrent settings edit', async () => {
    const h = harness(); h.catalogResult({ target: 'settings', value: 'Runner', fields: { ПрофильПользователя: 'Runner' } });
    h.metadata(h.document(Uri.parse(h.source().uri + '.kot.yml'), 'metadata: {}\n', true));
    h.onMetadataSave(() => { h.selectedSettings.version++; h.selectedSettings.text += '# concurrent edit\n'; });
    await assert.rejects(h.action('createChoice', h.source(), h.selectedSettings.uri.toString(), catalogTarget(h.selectedSettings, 'ДанныеТеста', 'ПрофильПользователя')), /changed/i);
    assert.equal(h.catalogCalls.length, 1); assert.equal(h.edits.length, 0);
});

test('cancelling inline object or group creation preserves dirty metadata without saving it', async () => {
    const h = harness(); const metadata = h.document(Uri.parse(h.source().uri + '.kot.yml'), 'metadata: { description: draft }\n', true); h.metadata(metadata);
    let saves = 0; h.onMetadataSave(() => { saves++; });
    await h.action('createChoice', h.source(), null, catalogTarget(h.raw, 'ДанныеСценария', 'Проект'));
    h.input(undefined); await h.action('newGroup', h.source(), null);
    assert.equal(saves, 0); assert.equal(metadata.isDirty, true); assert.equal(h.edits.length, 0);
});

test('settings creation scopes the etalon picker to its own workspace instead of the first folder', async () => {
    const h = harness(); const otherFolder = { uri: Uri.file('/second'), name: 'Second', index: 1 };
    h.host.workspace.workspaceFolders.push(otherFolder);
    h.host.workspace.getWorkspaceFolder = (uri: Uri) => uri.fsPath.startsWith('/second/') ? otherFolder : h.host.workspace.workspaceFolders[0];
    h.raw.uri = Uri.file('/second/scenarios/Checkout/scenario.yaml');
    await h.action('createSettings', h.source(), null);
    assert.equal(h.dialogs[0].workspaceRoot, '/second'); assert.equal(h.dialogs[0].user, 'Tester');
    assert.ok(h.host.workspace.textDocuments.some((doc: any) => doc.uri.toString() === 'file:///second/scenarios/Checkout/test/001.yaml'));
});
