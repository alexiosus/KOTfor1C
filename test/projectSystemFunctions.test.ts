import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { resolveProjectLibraryRoot } from '../src/projectLibraryMetadata';
import * as storeModule from '../src/projectPropertyCatalogStore';
import * as headerFields from '../src/yamlHeaderFields';

const first = { name: 'Sales', uid: '98999f57-13dc-11e8-aed1-005056a5c4e8' };
const second = { name: 'Purchases', uid: '11111111-2222-4333-8444-555555555555' };
const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');

async function harness(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-functions-native-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const roots = [path.join(directory, 'first-project'), path.join(directory, 'second-project')];
    const external = path.join(directory, 'external-tests');
    await Promise.all([...roots, external].map(root => fs.mkdir(root)));
    const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).toString() });
    const folders = roots.map((root, index) => ({ name: `Project ${index}`, uri: uri(root), index }));
    const documents: any[] = []; const inputs: string[] = []; const picks: string[] = []; const choices: any[] = []; const updates: any[] = [];
    const config: Record<string, unknown> = { 'newScenarioDefaults.systemFunctions': [first] };
    const document: any = { uri: uri(path.join(roots[1], 'scenario.yaml')), version: 1, isDirty: false, isClosed: false,
        text: `ТипФайла: Сценарий\nДанныеСценария:\n    UID: scenario\n    Имя: Test\n    ФункцияСистемы: Sales\n    UIDФункцияСистемы: ${first.uid}\nТекстСценария: |\n    Given ready\n`,
        getText() { return this.text; }, get lineCount() { return this.text.split('\n').length; },
        lineAt(line: number) { const text = this.text.split('\n')[line]; return { text, range: { start: { line, character: 0 }, end: { line, character: text.length } } }; }
    };
    const editor = { document, edit: async (callback: (builder: any) => void) => {
        const lines = document.text.split('\n'); callback({ replace: (range: any, text: string) => { lines[range.start.line] = text; } });
        document.text = lines.join('\n'); document.version++; document.isDirty = true; return true;
    } };
    documents.push(document);
    const host: any = { Uri: { file: uri, parse: (value: string) => uri(fileURLToPath(value)) },
        workspace: { workspaceFolders: folders, textDocuments: documents,
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => config[key] ?? fallback, update: async (...args: any[]) => { updates.push(args); } }) },
        window: { activeTextEditor: editor,
            showQuickPick: async (items: any[]) => { choices.push(items); const next = picks.shift(); return next === undefined ? undefined : items.find(item => item.label === next || item.action === next); },
            showInputBox: async () => inputs.shift(), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
        l10n: { t: (text: string) => text }
    };
    const modules = new Map<string, any>();
    const dependencies: Record<string, any> = { vscode: host, './projectPropertyCatalogStore': storeModule, './yamlHeaderFields': headerFields,
        uuid: { v4: randomUUID },
        './projectLibraryMetadata': { resolveProjectLibraryRoot },
        './projectLibraryIntegration': { projectLibraryEnvironment: () => ({ workspaceRoots: roots, scanRoots: [external] }) },
        './localization': { getTranslator: async () => (message: string) => message },
        './yamlValidator': { isScenarioYamlFile: () => true }
    };
    function load(name: string): any {
        if (modules.has(name)) { return modules.get(name); }
        const module = { exports: {} }; modules.set(name, module.exports);
        const filename = path.join(process.cwd(), 'src', name + '.ts');
        const code = ts.transpileModule(syncFs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
        vm.runInNewContext(code, { module, exports: module.exports, Buffer, console, URL, require: (specifier: string) => {
            const key = specifier.replace(/\.js$/u, '');
            if (dependencies[key]) { return dependencies[key]; }
            if (key === './projectSystemFunctions') { return load('projectSystemFunctions'); }
            return key.startsWith('./') ? {} : require(specifier);
        } });
        return module.exports;
    }
    return { roots, external, uri, host, document, inputs, picks, choices, config, documents, updates,
        api: load('projectSystemFunctions'), creator: load('scenarioCreator'), context: { extensionUri: uri('/extension') } };
}

test('project catalogs resolve their own workspace and external scan root and survive repository copying', async t => {
    const h = await harness(t);
    await new storeModule.ProjectPropertyCatalogStore(h.roots[0]).ensureSystemFunctions([first]);
    await new storeModule.ProjectPropertyCatalogStore(h.roots[1]).ensureSystemFunctions([second]);
    await new storeModule.ProjectPropertyCatalogStore(h.external).ensureSystemFunctions([second]);
    const result = await h.creator.getProjectScenarioDefaults(h.document.uri);
    assert.deepEqual(JSON.parse(JSON.stringify(result.systemFunctions)), [second]);
    assert.deepEqual(await h.api.loadProjectSystemFunctions(h.uri(path.join(h.external, 'scenario.yaml')), [first]), [second]);
    const clone = path.join(h.roots[0], 'clone'); await fs.mkdir(path.join(clone, '.kot'), { recursive: true });
    await fs.copyFile(path.join(h.roots[1], '.kot', 'property-catalogs.yml'), path.join(clone, '.kot', 'property-catalogs.yml'));
    assert.deepEqual(await new storeModule.ProjectPropertyCatalogStore(clone).ensureSystemFunctions([]), [second]);
    assert.equal(h.updates.length, 0);
});

test('the header picker updates both stock fields from shared functions absent in local settings', async t => {
    const h = await harness(t); await new storeModule.ProjectPropertyCatalogStore(h.roots[1]).ensureSystemFunctions([second]);
    h.picks.push('Purchases'); await h.creator.handleChangeScenarioSystemFunctionFromEditor(h.context);
    assert.match(h.document.text, /ФункцияСистемы: "Purchases"/u); assert.match(h.document.text, new RegExp(`UIDФункцияСистемы: "${second.uid}"`, 'u'));
    assert.equal(h.updates.length, 0); assert.equal(h.choices[0].length, 1);
});

test('manager changes the active project catalog, retaining UID and keeping the other project unchanged', async t => {
    const h = await harness(t); const store = new storeModule.ProjectPropertyCatalogStore(h.roots[1]);
    await store.ensureSystemFunctions([first, second]); await new storeModule.ProjectPropertyCatalogStore(h.roots[0]).ensureSystemFunctions([first]);
    h.picks.push('Sales', 'editName'); h.inputs.push('Order sales');
    await h.creator.handleManageSystemFunctions(h.context);
    assert.deepEqual((await store.read()).systemFunctions, [{ ...first, name: 'Order sales' }, second]);
    assert.deepEqual((await new storeModule.ProjectPropertyCatalogStore(h.roots[0]).read()).systemFunctions, [first]);
    assert.equal(h.updates.length, 0);
});

test('native catalog guards reject dirty YAML and a source outside the project roots before writing', async t => {
    const h = await harness(t); const target = h.document.uri; const store = h.api.projectSystemFunctionStore(target);
    await store.ensureSystemFunctions([first]);
    const file = path.join(h.roots[1], '.kot', 'property-catalogs.yml'); const before = await fs.readFile(file, 'utf8');
    h.documents.push({ uri: h.uri(file), isDirty: true, isClosed: false });
    await assert.rejects(store.addSystemFunction(second.name, second.uid), /Save|modified/i);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.throws(() => h.api.projectSystemFunctionStore(h.uri('/unrelated/scenario.yaml')), /outside|roots/i);
});

test('manager offers external test projects when no scenario editor identifies the catalog', async t => {
    const h = await harness(t); const store = new storeModule.ProjectPropertyCatalogStore(h.external); await store.ensureSystemFunctions([second]);
    h.host.window.activeTextEditor = undefined; h.picks.push('external-tests', 'Purchases', 'editName'); h.inputs.push('External purchases');
    await h.creator.handleManageSystemFunctions(h.context);
    assert.deepEqual((await store.read()).systemFunctions, [{ ...second, name: 'External purchases' }]);
    await assert.rejects(fs.access(path.join(h.roots[0], '.kot', 'property-catalogs.yml')), /ENOENT/u);
});

test('manager default ordering and UID edits persist to the shared file and deletion cannot restore legacy settings', async t => {
    const h = await harness(t); const store = new storeModule.ProjectPropertyCatalogStore(h.roots[1]);
    await store.ensureSystemFunctions([first, second]);
    h.picks.push('Purchases', 'makeDefault'); await h.creator.handleManageSystemFunctions(h.context);
    assert.deepEqual((await store.read()).systemFunctions, [second, first]);
    const updatedUid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    h.picks.push('Sales', 'editUid'); h.inputs.push(updatedUid); await h.creator.handleManageSystemFunctions(h.context);
    assert.deepEqual((await store.read()).systemFunctions, [second, { ...first, uid: updatedUid }]);
    h.picks.push('Sales', 'delete'); await h.creator.handleManageSystemFunctions(h.context);
    assert.deepEqual((await h.creator.getProjectScenarioDefaults(h.document.uri)).systemFunctions, [second]);
    assert.equal(h.updates.length, 0);
});
