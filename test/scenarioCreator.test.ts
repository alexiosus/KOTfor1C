import * as projectFormatModule from '../src/projectFormat';
import * as projectLegacyModule from '../src/projectLegacyMetadata';
import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { v4 } from 'uuid';
import { parseDocument } from 'yaml';
import * as etalonBases from '../src/etalonBases';
import * as fields from '../src/yamlHeaderFields';
import * as categories from '../src/scenarioCategory';
import * as descriptor from '../src/scenarioDescriptor';
import * as metadata from '../src/projectLibraryMetadata';
import { ProjectLibraryStore } from '../src/projectLibraryStore';
import { resolveMainScenarioGroupSeed } from '../src/scenarioCreationSeed';
import { TestNumberingStore, validateNewTestCode } from '../src/testNumberingStore';
import { ProjectPropertyCatalogStore } from '../src/projectPropertyCatalogStore';
import * as propertyModel from '../src/scenarioPropertiesModel';
import { ScenarioYamlDocument } from '../src/scenarioYamlDocument';
import * as spprFormat from '../src/spprScenarioFormat';

function uri(fsPath: string) {
    return { scheme: 'file', fsPath, toString: () => pathToFileURL(fsPath).toString() };
}

async function harness(t: test.TestContext, inputs: string[], customTemplate?: string, preferredFormat: 'legacy' | 'native' | 'default' = 'legacy') {
    const root = await v3Fixture(fsp.mkdtemp(path.join(os.tmpdir(), 'kot-scenario-creator-')));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const modelPath = path.join(root, 'bases.yml');
    await fsp.writeFile(modelPath, etalonBases.stringifyEtalonBasesYaml([{
        name: 'Synthetic QA', databaseId: 'synthetic-db', dtFilePath: '',
        userProfiles: [{ profileName: 'Tester', login: 'test-user', password: '' }]
    }]));
    const errors: string[] = [];
    const groupPickItems: Array<{ label: string; groupName: string }> = [];
    const opened: string[] = []; const prompts: Array<{ prompt?: string; value?: string }> = [];
    const state = new Map<string, unknown>();
    let seriesChoice: string | undefined; let propertyChoice: string | undefined; let cancelFolder = false; let manualHeaders = false;
    let destination = root; let scanGate: Promise<void> | undefined; let releaseScan = () => {};
    const propertyChoices = new Map<string, string>();
    const host = {
        Uri: { file: uri, joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
        FileType: { File: 1, Directory: 2 },
        workspace: {
            workspaceFolders: [{ uri: uri(root) }], textDocuments: [],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'phaseSwitcher.autoAddNewScenariosToFavorites' ? false
                : key === 'newScenarioDefaults.format' && preferredFormat !== 'default' ? preferredFormat : fallback }),
            fs: {
                createDirectory: (target: ReturnType<typeof uri>) => fsp.mkdir(target.fsPath, { recursive: true }),
                readFile: (target: ReturnType<typeof uri>) => customTemplate && target.fsPath.endsWith('scen.yaml')
                    ? Promise.resolve(Buffer.from(customTemplate)) : fsp.readFile(target.fsPath),
                writeFile: (target: ReturnType<typeof uri>, content: Uint8Array) => fsp.writeFile(target.fsPath, content),
                stat: async (target: ReturnType<typeof uri>) => ({ type: (await fsp.stat(target.fsPath)).isDirectory() ? 2 : 1 })
            },
            openTextDocument: async (target: ReturnType<typeof uri>) => ({ uri: target, getText: () => fs.readFileSync(target.fsPath, 'utf8') })
        },
        window: {
            createQuickPick: () => {
                let accept = () => {};
                const picker = {
                    value: '', items: [] as Array<{ label: string; groupName: string }>, selectedItems: [] as Array<{ label: string; groupName: string }>, activeItems: [],
                    onDidChangeValue: () => {}, onDidAccept: (callback: () => void) => { accept = callback; }, onDidHide: () => {}, dispose: () => {},
                    show: () => { groupPickItems.push(...picker.items); picker.selectedItems = picker.items.filter(item => item.groupName === ''); accept(); }
                };
                return picker;
            },
            showInputBox: async (options: { prompt?: string; value?: string }) => { prompts.push(options); const input = inputs.length ? inputs.shift() : '$default'; return input === '$default' ? options.value : input; },
            showOpenDialog: async () => cancelFolder ? undefined : [uri(destination)],
            showErrorMessage: async (message: string) => { errors.push(message); },
            showInformationMessage: async () => {},
            showTextDocument: async (document: { uri: ReturnType<typeof uri> }) => { opened.push(document.uri.fsPath); },
            showQuickPick: async (items: Array<{ action?: string; mode?: string; value?: string; series?: { prefix: string }; entryKind?: string; category?: string; base?: unknown; profile?: unknown }>, options: { title?: string }) =>
                items.find(item => seriesChoice ? item.series?.prefix === seriesChoice : item.action === 'manual')
                ?? items.find(item => options.title && propertyChoices.get(options.title) === item.value && item.value !== undefined)
                ?? items.find(item => propertyChoice && item.value === propertyChoice)
                ?? items.find(item => item.mode === (manualHeaders ? 'manual' : 'defaults') || item.category === 'Reporting' || item.base || item.profile)
                ?? items.find(item => item.value !== undefined)
                ?? items.find(item => item.action === 'none')
        },
        commands: { executeCommand: async () => {} },
        l10n: { t: (message: string) => message }
    };
    const ts = require('typescript') as typeof import('typescript');
    const modules = new Map<string, unknown>();
    const load = (name: string): unknown => {
        if (modules.has(name)) { return modules.get(name); }
        const dependencies: Record<string, unknown> = {
            vscode: host, uuid: { v4 }, path, 'node:path': path,
            './localization': { getTranslator: async () => (message: string) => message },
            './yamlParametersManager': { YamlParametersManager: { getInstance: () => ({ loadParameters: async () => [{ key: 'ModelDBSettings', value: modelPath }] }) } },
            './etalonBases': etalonBases, './yamlHeaderFields': fields, './scenarioCategory': categories,
            './scenarioCreationSeed': { resolveMainScenarioGroupSeed }, './scenarioDescriptor': descriptor,
            './projectFormat': projectFormatModule, './projectLegacyMetadata': projectLegacyModule, './projectLibraryMetadata': metadata,
            './testNumberingStore': { TestNumberingStore, validateNewTestCode },
            './projectPropertyCatalogStore': { ProjectPropertyCatalogStore },
            './scenarioPropertiesModel': propertyModel,
            './scenarioYamlDocument': { ScenarioYamlDocument }, './spprScenarioFormat': spprFormat,
            './projectSystemFunctions.js': { loadProjectSystemFunctions: async (_target: unknown, defaults: unknown) => defaults },
            './scenarioScanRoot': { getScenarioScanRootPath: () => destination, resolveScenarioScanRootFsPath: () => destination, resolveProcessScanRootFsPath: () => destination },
            './workspaceScanner': { scanWorkspaceForScenarioCatalog: async () => { await scanGate; return { all: [] }; } },
            './gherkinLanguage': { getConfiguredScenarioLanguage: () => 'en', applyPreferredStepKeyword: (line: string) => line }
        };
        if (Object.hasOwn(dependencies, name)) { return dependencies[name]; }
        if (!name.startsWith('./')) { return require(name); }
        if (!['./scenarioCreator', './projectLibraryIntegration', './testNumbering', './scenarioCreationProperties'].includes(name)) { return {}; }
        const module = { exports: {} };
        const source = fs.readFileSync(path.join(process.cwd(), 'src', `${name.slice(2)}.ts`), 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
            transformers: { before: [context => {
                const visit: import('typescript').Visitor = node => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
                    ? ts.factory.updateCallExpression(node, ts.factory.createIdentifier('require'), node.typeArguments, node.arguments)
                    : ts.visitEachChild(node, visit, context);
                return sourceFile => ts.visitNode(sourceFile, visit) as import('typescript').SourceFile;
            }] }
        }).outputText;
        vm.runInNewContext(compiled, { module, exports: module.exports, require: load, console, Buffer, setTimeout, clearTimeout });
        modules.set(name, module.exports);
        return module.exports;
    };
    return { root, errors, opened, prompts, groupPickItems, useSeries(prefix: string) { seriesChoice = prefix; }, chooseProperty(value: string) { propertyChoice = value; },
        selectHeader(title: string, value: string) { propertyChoices.set(title, value); }, useDestination(folder: string) { destination = folder; },
        pauseScanning() { scanGate = new Promise(resolve => { releaseScan = resolve; }); }, resumeScanning() { releaseScan(); },
        fillHeadersManually() { manualHeaders = true; }, cancelFolder() { cancelFolder = true; }, api: load('./scenarioCreator') as typeof import('../src/scenarioCreator'),
        context: { extensionUri: uri(process.cwd()), workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } } as Parameters<typeof import('../src/scenarioCreator').handleCreateMainScenario>[0] };
}

test('main creation writes group and order to the adjacent metadata while keeping compiler identity and settings linked', async t => {
    const h = await harness(t, ['Main', 'Main', '7']);
    await h.api.handleCreateMainScenario(h.context, { groupName: 'Smoke' });
    assert.deepEqual(h.errors, []);
    const file = path.join(h.root, 'Main/scen.yaml');
    const source = parseDocument(await fsp.readFile(file, 'utf8')).toJS();
    const sidecar = parseDocument(await fsp.readFile(`${file}.kot.yml`, 'utf8')).toJS();
    const settings = parseDocument(await fsp.readFile(path.join(h.root, 'Main/test/Main.yaml'), 'utf8')).toJS();
    assert.equal(Object.hasOwn(source, 'KOTМетаданные'), false);
    assert.equal(source.ДанныеСценария.Имя, 'Main');
    assert.equal(source.ДанныеСценария.Код, 'Main');
    assert.equal(settings.ДанныеТеста.UIDСценария, source.ДанныеСценария.UID);
    assert.equal(sidecar.identity.uid, source.ДанныеСценария.UID);
    assert.equal(sidecar.metadata.order, undefined);
    assert.equal((await new ProjectLibraryStore(h.root).read()).metadata[`uid:${sidecar.identity.uid.toLowerCase()}`].order, 7);
    const group = (await new ProjectLibraryStore(h.root).read()).groups.find(value => value.id === sidecar.metadata.groupId);
    assert.equal(group?.name, 'Smoke');
    assert.deepEqual(group?.sections, ['main']);
    assert.deepEqual(h.opened, [file]);
});

for (const seed of [undefined, { groupName: '' }]) {
    test(`main creation without groups uses virtual Ungrouped (${seed ? 'explicit' : 'fresh project'})`, async t => {
        const h = await harness(t, ['Main', 'Main', '7']);
        await h.api.handleCreateMainScenario(h.context, seed);
        assert.deepEqual(h.errors, []);
        const file = path.join(h.root, 'Main/scen.yaml');
        const sidecar = parseDocument(await fsp.readFile(`${file}.kot.yml`, 'utf8')).toJS();
        assert.equal(sidecar.metadata.groupId, '');
        assert.equal(sidecar.metadata.order, undefined);
    assert.equal((await new ProjectLibraryStore(h.root).read()).metadata[`uid:${sidecar.identity.uid.toLowerCase()}`].order, 7);
        assert.deepEqual(await new ProjectLibraryStore(h.root).readGroups(), []);
        assert.equal(h.prompts.some(prompt => prompt.prompt === 'Enter group name'), false);
    });
}

test('the existing group picker can explicitly leave a new main scenario ungrouped', async t => {
    const h = await harness(t, ['Main', 'Main', '7']);
    await new ProjectLibraryStore(h.root).ensureGroup('Smoke', 'main');
    await h.api.handleCreateMainScenario(h.context);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.groupPickItems.map(item => [item.label, item.groupName]), [['Ungrouped', ''], ['Smoke', 'Smoke']]);
    const sidecar = parseDocument(await fsp.readFile(path.join(h.root, 'Main/scen.yaml.kot.yml'), 'utf8')).toJS();
    assert.equal(sidecar.metadata.groupId, '');
    assert.deepEqual((await new ProjectLibraryStore(h.root).readGroups()).map(group => group.name), ['Smoke']);
});

test('an external configured root uses its own shared series rather than the workspace series', async t => {
    const h = await harness(t, ['External nested', '$default']);
    const external = await v3Fixture(fsp.mkdtemp(path.join(os.tmpdir(), 'kot-external-numbering-')));
    t.after(() => fsp.rm(external, { recursive: true, force: true }));
    await new TestNumberingStore(external).addSeries('000013', 'External author', []);
    h.useDestination(external); h.useSeries('000013');
    await h.api.handleCreateNestedScenario(h.context, { existingCategories: ['Reporting'] });
    assert.deepEqual(h.errors, []);
    assert.equal(fs.existsSync(path.join(external, '000013001/scen.yaml')), true);
    assert.equal(fs.existsSync(path.join(h.root, '.kot/test-numbering.yml')), false);
});

test('the full wizard selects project and report levels from shared catalogs', async t => {
    const h = await harness(t, ['Nested', '101']); h.fillHeadersManually();
    const store = new ProjectPropertyCatalogStore(h.root);
    await store.add('projects', 'Shared project'); await store.add('reportLevel1', 'Accounting'); await store.add('reportLevel2', 'Operations');
    h.selectHeader('Project', 'Shared project'); h.selectHeader('Report level 1', 'Accounting');
    h.selectHeader('Enter report level 2 for nested scenario', 'Operations');
    await h.api.handleCreateNestedScenario(h.context, { existingCategories: ['Reporting'] });
    assert.deepEqual(h.errors, []);
    const source = parseDocument(await fsp.readFile(path.join(h.root, '101/scen.yaml'), 'utf8')).toJS();
    assert.equal(source.ДанныеСценария.Проект, 'Shared project');
    assert.equal(source.ДанныеСценария.УровеньОтчета1, 'Accounting');
    assert.equal(source.ДанныеСценария.УровеньОтчета2, 'Operations');
});

test('a new responsible selected in a custom template cannot retain another persons SPPR UID', async t => {
    const template = fs.readFileSync(path.join(process.cwd(), 'res/scen.yaml'), 'utf8').replace('    Код:', '    Ответственный: "Old owner"\n    UIDОтветственный: "11111111-2222-4333-8444-555555555555"\n    Код:');
    const h = await harness(t, ['Nested', '101'], template);
    await new ProjectPropertyCatalogStore(h.root).add('responsibles', 'New owner'); h.chooseProperty('New owner');
    await h.api.handleCreateNestedScenario(h.context, { existingCategories: ['Reporting'] });
    const source = parseDocument(await fsp.readFile(path.join(h.root, '101/scen.yaml'), 'utf8')).toJS();
    assert.equal(source.ДанныеСценария.Ответственный, 'New owner');
    assert.equal(source.ДанныеСценария.UIDОтветственный, '');
});

test('main creation separates its name from the sequential code and uses the series author', async t => {
    const h = await harness(t, ['Readable main name', '$default', '']);
    await new TestNumberingStore(h.root).addSeries('000012', 'Tester A', ['000012009']); h.useSeries('000012');
    await h.api.handleCreateMainScenario(h.context, { groupName: 'Smoke' });
    assert.deepEqual(h.errors, []);
    const source = parseDocument(await fsp.readFile(path.join(h.root, '000012010/scen.yaml'), 'utf8')).toJS();
    assert.equal(source.ДанныеСценария.Имя, 'Readable main name');
    assert.equal(source.ДанныеСценария.Код, '000012010');
    assert.equal(source.ДанныеСценария.Ответственный, 'Tester A');
    const settings = parseDocument(await fsp.readFile(path.join(h.root, '000012010/test/000012010.yaml'), 'utf8')).toJS();
    assert.equal(settings.ДанныеТеста.Код, '000012010');
    assert.equal(settings.ДанныеТеста.Имя, 'Readable main name');
    assert.equal((await new TestNumberingStore(h.root).read()).series[0].lastNumber, 10);
});

test('nested creation offers the shared responsible field even when using header defaults', async t => {
    const h = await harness(t, ['Nested', '101']);
    await new ProjectPropertyCatalogStore(h.root).add('responsibles', 'QA owner'); h.chooseProperty('QA owner');
    await h.api.handleCreateNestedScenario(h.context, { existingCategories: ['Reporting'] });
    const source = parseDocument(await fsp.readFile(path.join(h.root, '101/scen.yaml'), 'utf8')).toJS();
    assert.equal(source.ДанныеСценария.Ответственный, 'QA owner');
});

test('cancelling the folder picker does not consume a proposed series number', async t => {
    const h = await harness(t, ['Nested', '$default']);
    const store = new TestNumberingStore(h.root); await store.addSeries('000012', 'Tester A', []); h.useSeries('000012'); h.cancelFolder();
    await h.api.handleCreateNestedScenario(h.context);
    assert.equal((await store.read()).series[0].lastNumber, 0);
    assert.equal(fs.existsSync(path.join(h.root, '000012001')), false);
});

test('creating a nested scenario never overwrites an existing code-named folder', async t => {
    const h = await harness(t, ['Nested', '101']);
    await fsp.mkdir(path.join(h.root, '101')); await fsp.writeFile(path.join(h.root, '101/scen.yaml'), 'Authored');
    await h.api.handleCreateNestedScenario(h.context, { existingCategories: ['Reporting'] });
    assert.equal(await fsp.readFile(path.join(h.root, '101/scen.yaml'), 'utf8'), 'Authored');
    assert.equal(h.errors.length, 1);
});

test('nested creation stores its chosen category without adding an inline block or main grouping', async t => {
    const h = await harness(t, ['Nested', '101']);
    await h.api.handleCreateNestedScenario(h.context, { existingCategories: ['Reporting'] });
    assert.deepEqual(h.errors, []);
    const file = path.join(h.root, '101/scen.yaml');
    const source = parseDocument(await fsp.readFile(file, 'utf8')).toJS();
    const sidecar = parseDocument(await fsp.readFile(`${file}.kot.yml`, 'utf8')).toJS();
    assert.equal(Object.hasOwn(source, 'KOTМетаданные'), false);
    assert.equal(source.ДанныеСценария.Код, '101');
    assert.equal(sidecar.metadata.category, 'Reporting');
    assert.equal(Object.hasOwn(sidecar.metadata, 'groupId'), false);
    assert.equal(sidecar.identity.uid, source.ДанныеСценария.UID);
});

test('nested creation retains authored legacy template metadata and records the new category separately', async t => {
    const legacyBlock = 'KOTМетаданные:\n    Описание: Authored description\n    Категория: Authored category\n';
    const template = fs.readFileSync(path.join(process.cwd(), 'res/scen.yaml'), 'utf8')
        .replace(/KOTМетаданные:[\s\S]*?(?=ПараметрыСценария:)/u, '')
        .replace('ПараметрыСценария:', `${legacyBlock}\nПараметрыСценария:`);
    const h = await harness(t, ['Nested', '101'], template);
    await h.api.handleCreateNestedScenario(h.context, { existingCategories: ['Reporting'] });
    assert.deepEqual(h.errors, []);
    const file = path.join(h.root, '101/scen.yaml');
    assert.ok((await fsp.readFile(file, 'utf8')).includes(legacyBlock));
    const sidecar = parseDocument(await fsp.readFile(`${file}.kot.yml`, 'utf8')).toJS();
    assert.equal(sidecar.metadata.description, 'Authored description');
    assert.equal(sidecar.metadata.category, 'Reporting');
});

test('the first wizard prompt opens before slow scenario discovery completes', async t => {
    const h = await harness(t, []); h.pauseScanning();
    const running = h.api.handleCreateMainScenario(h.context);
    await new Promise(resolve => setTimeout(resolve, 10));
    const visible = h.prompts.length;
    h.resumeScanning(); await running;
    assert.ok(visible > 0, 'the name dialog must not await the full catalog scan');
});


test('main creation defaults to native SPPR when no source-format setting is present', async t => {
    const h = await harness(t, ['Native Default', 'NativeDefault', '7'], undefined, 'default');
    await h.api.handleCreateMainScenario(h.context, { groupName: 'Smoke' });
    assert.deepEqual(h.errors, []);
    await fsp.access(path.join(h.root, 'NativeDefault/meta.yaml'));
    assert.deepEqual(h.opened, [path.join(h.root, 'NativeDefault/scen.feature')]);
    await assert.rejects(fsp.access(path.join(h.root, 'NativeDefault/scen.yaml')));
});

test('main creation selects native SPPR files while keeping UID and settings linked', async t => {
    const h = await harness(t, ['Native Main', 'NativeMain', '7']);
    h.selectHeader('SPPR scenario file format', 'native');
    await h.api.handleCreateMainScenario(h.context, { groupName: 'Smoke' });
    assert.deepEqual(h.errors, []);
    const file = path.join(h.root, 'NativeMain/meta.yaml');
    const source = parseDocument(await fsp.readFile(file, 'utf8')).toJS();
    const script = await fsp.readFile(path.join(h.root, 'NativeMain/scen.feature'), 'utf8');
    const settings = parseDocument(await fsp.readFile(path.join(h.root, 'NativeMain/test/NativeMain.yaml'), 'utf8')).toJS();
    assert.equal(Object.hasOwn(source, 'ТекстСценария'), false);
    assert.equal(source.ДанныеСценария.Имя, 'Native Main');
    assert.equal(settings.ДанныеТеста.UIDСценария, source.ДанныеСценария.UID);
    assert.match(script, /#language: en/u);
    await assert.rejects(fsp.stat(path.join(h.root, 'NativeMain/scen.yaml')));
    assert.deepEqual(h.opened, [path.join(h.root, 'NativeMain/scen.feature')]);
    assert.equal(parseDocument(await fsp.readFile(`${file}.kot.yml`, 'utf8')).toJS().identity.uid, source.ДанныеСценария.UID);
});

test('nested creation selects native SPPR files without flattening its script', async t => {
    const h = await harness(t, ['Native Nested', '001']);
    h.selectHeader('SPPR scenario file format', 'native');
    await h.api.handleCreateNestedScenario(h.context, { existingCategories: ['Reporting'] });
    assert.deepEqual(h.errors, []);
    const meta = await fsp.readFile(path.join(h.root, '001/meta.yaml'), 'utf8');
    const script = await fsp.readFile(path.join(h.root, '001/scen.feature'), 'utf8');
    assert.equal(parseDocument(meta).toJS().ДанныеСценария.Имя, 'Native Nested');
    assert.match(script, /#language: en/u);
    await assert.rejects(fsp.stat(path.join(h.root, '001/scen.yaml')));
    assert.deepEqual(h.opened, [path.join(h.root, '001/scen.feature')]);
});

test('legacy project creation keeps unified YAML despite a native user default', async t => {
    const h = await harness(t, ['Legacy', 'Legacy', '7'], undefined, 'native');
    await fsp.unlink(path.join(h.root, '.kot/project.yml'));
    await h.api.handleCreateMainScenario(h.context, { groupName: 'Smoke', format: 'native' });
    assert.deepEqual(h.errors, []);
    const file = path.join(h.root, 'Legacy/scen.yaml');
    const source = parseDocument(await fsp.readFile(file, 'utf8')).toJS();
    assert.equal(source.KOTМетаданные.PhaseSwitcher.Tab, 'Smoke');
    await assert.rejects(fsp.stat(file + '.kot.yml'), { code: 'ENOENT' });
    await assert.rejects(fsp.stat(path.join(h.root, 'Legacy/meta.yaml')), { code: 'ENOENT' });
});
