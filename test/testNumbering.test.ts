import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { TestNumberingStore } from '../src/testNumberingStore';
import { ProjectPropertyCatalogStore } from '../src/projectPropertyCatalogStore';
import { resolveProjectLibraryRoot } from '../src/projectLibraryMetadata';

async function fixture(t: test.TestContext) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kot-numbering-ui-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });
    const state = new Map<string, unknown>(); const choices: string[] = []; const inputs: Array<string | undefined> = [];
    const inputDefaults: Array<string | undefined> = []; const errors: string[] = []; const codes: string[] = [];
    const documents: Array<{ isDirty: boolean; uri: ReturnType<typeof uri> }> = [];
    const config = new Map<string, unknown>();
    const context = { extensionUri: uri(process.cwd()), workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } };
    const host = { Uri: { file: uri }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        workspace: { workspaceFolders: [{ uri: uri(root) }], textDocuments: documents,
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => config.get(key) ?? fallback,
                inspect: (key: string) => ({ globalValue: config.get(key) }),
                update: async (key: string, value: unknown) => { config.set(key, value); } }) },
        window: {
            activeTextEditor: undefined,
            showQuickPick: async (items: Array<{ action?: string; prefix?: string; value?: string; series?: { prefix: string } }>) => {
                const wanted = choices.shift();
                if (wanted === undefined) { return items[0]; }
                return items.find(item => item.action === wanted || item.prefix === wanted || item.series?.prefix === wanted || item.value === wanted);
            },
            showInputBox: async (options: { value?: string }) => { inputDefaults.push(options.value); const value = inputs.shift(); return value === '$default' ? options.value : value; },
            showErrorMessage: async (value: string) => { errors.push(value); },
            showTextDocument: async () => {}
        } };
    const deps: Record<string, unknown> = {
        vscode: host, './testNumberingStore': { TestNumberingStore, validateNewTestCode: require('../src/testNumberingStore').validateNewTestCode },
        './projectPropertyCatalogStore': { ProjectPropertyCatalogStore }, './projectLibraryMetadata': { resolveProjectLibraryRoot },
        './projectLibraryIntegration': { projectLibraryEnvironment: () => ({ workspaceRoots: [root], scanRoots: [root] }) },
        './workspaceScanner': { scanWorkspaceForScenarioCatalog: async () => ({ all: codes.map((code, index) => ({ name: String(index), scenarioCode: code, yamlFileUri: uri(path.join(root, `${index}.yaml`)) })) }) },
        './localization': { getTranslator: async () => (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_: string, index: string) => args[Number(index)] ?? '') }
    };
    const sourcePath = path.join(process.cwd(), 'src/testNumbering.ts');
    const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : 'export {};';
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
        { module, exports: module.exports, require: (name: string) => deps[name] ?? require(name), console, Buffer });
    // The real command uses VS Code; only host prompts/state and discovery are simulated here.
    const api = module.exports as {
        promptForNewTestCode(context: unknown, target: unknown, options: { prompt: string; initialValue?: string; numericOnly?: boolean }): Promise<{ code: string; author?: string; root: string; claim(): Promise<void> } | undefined>;
        handleManageTestNumbering(context: unknown): Promise<void>;
    };
    return { root, target: uri(root), context, api, choices, inputs, inputDefaults, state, config, errors, codes, documents, store: new TestNumberingStore(root) };
}

test('a selected series prefills the code and author and is remembered locally without claiming on preview', async t => {
    const h = await fixture(t); assert.equal(typeof h.api.promptForNewTestCode, 'function');
    await h.store.addSeries('000012', 'Tester A', ['000012005']);
    h.choices.push('000012'); h.inputs.push('$default');
    const first = await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    assert.equal(first?.code, '000012006'); assert.equal(first.author, 'Tester A');
    assert.equal((await h.store.read()).series[0].lastNumber, 5);
    await first.claim(); h.inputs.push('$default');
    const second = await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    assert.equal(second?.code, '000012007'); assert.equal(h.choices.length, 0);
    assert.equal((await h.store.read()).series[0].lastNumber, 6);
});

test('creation always offers another author series after remembering the previous author', async t => {
    const h = await fixture(t);
    await h.store.addSeries('000012', 'Author A', []); await h.store.addSeries('000013', 'Author B', []);
    h.choices.push('000012'); h.inputs.push('$default');
    assert.equal((await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' }))?.author, 'Author A');
    h.choices.push('000013'); h.inputs.push('$default');
    assert.equal((await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' }))?.author, 'Author B');
});

test('a personal prefix set in ordinary VS Code settings takes effect without the palette', async t => {
    const h = await fixture(t);
    await h.store.addSeries('000012', 'Author A', []); await h.store.addSeries('000013', 'Author B', []);
    h.choices.push('manual'); h.inputs.push('legacy');
    await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    h.config.set('numbering.prefix', '000013'); h.inputs.push('$default');
    const chosen = await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    assert.equal(chosen?.code, '000013001'); assert.equal(chosen.author, 'Author B');
});

test('the manager updates an explicitly configured prefix and unknown configured series fail clearly', async t => {
    const h = await fixture(t);
    await h.store.addSeries('000012', 'Author A', []); await h.store.addSeries('000013', 'Author B', []);
    h.config.set('numbering.prefix', '000012'); h.choices.push('000013');
    await h.api.handleManageTestNumbering(h.context);
    assert.equal(h.config.get('numbering.prefix'), '000013');
    h.config.set('numbering.prefix', '000099');
    assert.equal(await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' }), undefined);
    assert.match(h.errors.join('\n'), /configured|defined|series/iu);
});

test('first-use manual entry and cancelling code do not create a numbering catalog', async t => {
    const h = await fixture(t); assert.equal(typeof h.api.promptForNewTestCode, 'function');
    h.choices.push('manual'); h.inputs.push('legacy-main');
    const selected = await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code', initialValue: 'Name' });
    assert.equal(selected?.code, 'legacy-main');
    assert.equal(fs.existsSync(h.store.filePath), false);
    await selected.claim(); assert.equal(fs.existsSync(h.store.filePath), false);
    h.inputs.push(undefined);
    assert.equal(await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' }), undefined);
});

test('first-use setup stores a shared series and creates a reusable responsible name', async t => {
    const h = await fixture(t); assert.equal(typeof h.api.promptForNewTestCode, 'function');
    h.choices.push('new', 'create'); h.inputs.push('000014', 'Tester C', '$default');
    const selected = await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    assert.equal(selected?.code, '000014001');
    assert.deepEqual((await h.store.read()).series, [{ prefix: '000014', author: 'Tester C', lastNumber: 0 }]);
    assert.deepEqual((await new ProjectPropertyCatalogStore(h.root).read()).responsibles, ['Tester C']);
});

test('editing the suggested code keeps display identity independent and confirms the effective series author', async t => {
    const h = await fixture(t); assert.equal(typeof h.api.promptForNewTestCode, 'function');
    await h.store.addSeries('000012', 'Tester A', []); await h.store.addSeries('000013', 'Tester B', []);
    h.choices.push('000012'); h.inputs.push('000013050');
    const selection = await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    assert.equal(selection?.author, 'Tester B'); await selection.claim();
    assert.equal((await h.store.read()).series[1].lastNumber, 50);
    assert.equal((await h.store.read()).series[0].lastNumber, 0);
});

test('a code added while the wizard is open is rejected at claim time', async t => {
    const h = await fixture(t); assert.equal(typeof h.api.promptForNewTestCode, 'function');
    await h.store.addSeries('000012', 'Tester A', []); h.choices.push('000012'); h.inputs.push('$default');
    const selection = await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    h.codes.push('000012001');
    await assert.rejects(selection!.claim(), /already|exists|used/iu);
    assert.equal((await h.store.read()).series[0].lastNumber, 0);
});

test('a dirty numbering catalog blocks issuing a number', async t => {
    const h = await fixture(t); assert.equal(typeof h.api.promptForNewTestCode, 'function');
    await h.store.addSeries('000012', 'Tester A', []); h.choices.push('000012'); h.inputs.push('$default');
    const selected = await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    h.documents.push({ uri: { scheme: 'file', fsPath: h.store.filePath, toString: () => h.store.filePath }, isDirty: true });
    await assert.rejects(selected!.claim(), /Save|modified/iu);
    assert.equal((await h.store.read()).series[0].lastNumber, 0);
});

test('the manager switches the local default without rewriting shared author assignments', async t => {
    const h = await fixture(t);
    await h.store.addSeries('000012', 'Tester A', []); await h.store.addSeries('000013', 'Tester B', []);
    h.choices.push('000012'); h.inputs.push('$default');
    await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' });
    const before = await fs.promises.readFile(h.store.filePath, 'utf8');
    h.choices.push('000013'); await h.api.handleManageTestNumbering(h.context);
    h.inputs.push('$default');
    assert.equal((await h.api.promptForNewTestCode(h.context, h.target, { prompt: 'Code' }))?.code, '000013001');
    assert.equal(await fs.promises.readFile(h.store.filePath, 'utf8'), before);
});
