import { v3FixtureSync } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test, type TestContext } from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import * as etalonBases from '../src/etalonBases';
import * as storeModule from '../src/projectPropertyCatalogStore';
import * as yamlModule from '../src/scenarioYamlDocument';
import * as bindingModule from '../src/scenarioPropertiesBindings';
import type * as CatalogModule from '../src/scenarioPropertiesCatalogs';

function scenario(project = 'Existing project') {
    return `ТипФайла: Сценарий\nДанныеСценария:\n    UID: scenario-1\n    Проект: ${project}\n    УровеньОтчета1: Existing report\n    УровеньОтчета2: Existing subreport\nKOTМетаданные:\n    Категория: YAML category\n`;
}
function settings(name = 'Main', id = 'main', profile = 'Tester') {
    return `ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: scenario-1\n    ЭталоннаяБазаИмя: ${name}\n    ИдентификаторБазы: ${id}\n    ПрофильПользователя: ${profile}\n`;
}
function harness(t: TestContext) {
    const root = v3FixtureSync(fs.mkdtempSync(path.join(os.tmpdir(), 'properties-catalogs-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).toString() });
    const source = { uri: uri(path.join(root, 'scenario.yaml')).toString(), text: scenario() };
    const selectedSettings = { uri: uri(path.join(root, 'test.yaml')).toString(), text: settings() };
    const baseFile = path.join(root, 'bases.yaml');
    const defaults = { project: 'Default project', reportLevel1: 'Default report', mainReportLevel2: 'Parent', nestedReportLevel2: 'Tests', userProfile: 'Administrator', systemFunctions: [{ name: 'Configured function', uid: '98999f57-13dc-11e8-aed1-005056a5c4e8' }] };
    let input: string | undefined = 'New entry';
    let duringPrompt: (() => void) | undefined;
    let scanCalls = 0;
    let libraryReads = 0;
    const config: Record<string, unknown> = { 'newScenarioDefaults.systemFunctions': defaults.systemFunctions };
    const workspaces = [{ uri: uri(root) }]; const configurationUpdates: { scope: number; uri: string }[] = [];
    const dirty: { isDirty: boolean; uri: ReturnType<typeof uri> }[] = [];
    let createdBase: etalonBases.EtalonBaseDefinition | undefined = { name: 'New base', databaseId: 'new-base', dtFilePath: '', userProfiles: [{ profileName: 'Created', login: 'hidden-login', password: 'hidden-password' }] };
    let createdProfile: etalonBases.EtalonBaseUserProfile | undefined = { profileName: 'New profile', login: 'hidden-login', password: 'hidden-password' };
    const module = { exports: {} };
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const file = path.join(process.cwd(), 'src/scenarioPropertiesCatalogs.ts');
    const compiled = ts.transpileModule(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export {};', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    vm.runInNewContext(compiled, { module, exports: module.exports, console, Buffer, require: (specifier: string) => {
        switch (specifier.replace(/\.js$/u, '')) {
            case 'yaml': return { parseDocument };
            case 'vscode': return {
                Uri: { file: uri, parse: (value: string) => uri(fileURLToPath(value)) }, ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3, Global: 1 },
                workspace: { workspaceFolders: workspaces, textDocuments: dirty, getWorkspaceFolder: () => ({ uri: uri(root) }),
                    getConfiguration: (_section: string, scopeUri: ReturnType<typeof uri>) => ({ get: (key: string, fallback: unknown) => config[key] ?? fallback,
                        update: async (key: string, value: unknown, scope: number) => { assert.equal(scope, 2, 'Window-scoped systemFunctions cannot be written to a workspace folder');
                            configurationUpdates.push({ scope, uri: scopeUri.toString() }); config[key] = value; } }) },
                window: { showInputBox: async () => { duringPrompt?.(); return input; }, showQuickPick: async (items: unknown[]) => items[0] },
                l10n: { t: (value: string) => value }
            };
            case './localization': return { getTranslator: async () => (value: string) => value };
            case './projectPropertyCatalogStore': return storeModule;
            case './scenarioYamlDocument': return yamlModule;
            case './scenarioPropertiesBindings': return bindingModule;
            case './projectSystemFunctions': {
                const shared = { exports: {} }; const filename = path.join(process.cwd(), 'src/projectSystemFunctions.ts');
                vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
                    { module: shared, exports: shared.exports, console, Buffer, require: (specifier: string) => {
                        const key = specifier.replace(/\.js$/u, '');
                        if (key === 'vscode') { return { workspace: { textDocuments: dirty } }; }
                        if (key === './projectPropertyCatalogStore') { return storeModule; }
                        if (key === './projectLibraryIntegration') { return { projectLibraryEnvironment: () => ({ workspaceRoots: [root], scanRoots: [root] }) }; }
                        if (key === './projectLibraryMetadata') { return { resolveProjectLibraryRoot: () => root }; }
                        return require(specifier);
                    } });
                return shared.exports;
            }
            case './etalonBases': return etalonBases;
            case './yamlParametersManager': return { YamlParametersManager: { getInstance: () => ({ loadParameters: async () => [{ key: 'ModelDBSettings', value: baseFile }] }) } };
            case './scenarioCreator': return { getNewScenarioDefaults: () => defaults, getConfiguredSystemFunctions: () => config['newScenarioDefaults.systemFunctions'],
                promptForSystemFunctionName: async () => input,
                promptForEtalonBaseValues: async () => { duringPrompt?.(); return createdBase; }, promptForEtalonBaseProfileValues: async () => { duringPrompt?.(); return createdProfile; } };
            case './projectLibraryIntegration': return { projectLibraryEnvironment: () => ({ workspaceRoots: [root], scanRoots: [root] }), assertProjectMetadataSaved: () => {
                if (dirty.some(document => document.isDirty && document.uri.fsPath.includes(`${path.sep}.kot${path.sep}`))) { throw new Error('Save metadata'); }
            } };
            case './projectLibraryMetadata': return { resolveProjectLibraryRoot: () => root,
                getCachedProjectLibrarySnapshot: () => ({ metadata: { 'uid:other': { category: 'Sidecar category' } } }),
                createProjectLibraryStore: () => ({ read: async () => { libraryReads++; return { metadata: { 'uid:other': { category: 'Sidecar category' } } }; } }) };
            case './workspaceScanner': return { scanWorkspaceForScenarioCatalog: async () => { scanCalls++; return { all: [] }; } };
            default: return require(specifier);
        }
    } });
    fs.writeFileSync(baseFile, etalonBases.stringifyEtalonBasesYaml([
        { name: 'Main', databaseId: 'main', dtFilePath: '', userProfiles: [{ profileName: 'Tester', login: 'private-user', password: 'private-password' }] },
        { name: 'Other', databaseId: 'other', dtFilePath: '', userProfiles: [{ profileName: 'Other user', login: 'other-login', password: 'other-password' }] }
    ]));
    return { api: module.exports as typeof CatalogModule, context: {} as any, source, selectedSettings, root, baseFile, dirty, config, workspaces, configurationUpdates,
        input(value: string | undefined) { input = value; }, mutate(callback: () => void) { duringPrompt = callback; },
        get scanCalls() { return scanCalls; }, get libraryReads() { return libraryReads; }, cancelBase() { createdBase = undefined; }, cancelProfile() { createdProfile = undefined; } };
}

test('property catalogs reuse the current metadata snapshot instead of loading the project library again', async t => {
    const h = harness(t);
    const catalogs = await h.api.loadScenarioPropertiesCatalogs(h.context, h.source, [h.source]);
    assert.ok(catalogs.categories.includes('Sidecar category'));
    assert.equal(h.libraryReads, 0);
});

test('property catalogs reuse parsed source candidates from the session', async t => {
    const h = harness(t);
    const other = { uri: pathToFileURL(path.join(h.root, 'other.yaml')).toString(), text: scenario('Cached project') };
    const cached = yamlModule.ScenarioYamlDocument.parse(other.text);
    const original = yamlModule.ScenarioYamlDocument.parse;
    yamlModule.ScenarioYamlDocument.parse = text => {
        if (text === other.text) { throw new Error('The session already parsed this candidate'); }
        return original(text);
    };
    try {
        const catalogs = await h.api.loadScenarioPropertiesCatalogs(h.context, h.source, [h.source, other], undefined,
            source => source.uri === other.uri ? cached : original(source.text));
        assert.ok(catalogs.projects.includes('Cached project'));
    } finally { yamlModule.ScenarioYamlDocument.parse = original; }
});

test('dropdown catalogs union YAML/default/shared metadata names and scope safe profile choices to the selected base', async t => {
    const h = harness(t);
    await new storeModule.ProjectPropertyCatalogStore(h.root).add('projects', 'Unused shared project');
    const catalogs = await h.api.loadScenarioPropertiesCatalogs(h.context, h.source, [h.source], h.selectedSettings);
    assert.deepEqual(Array.from(catalogs.projects), ['Default project', 'Existing project', 'Unused shared project']);
    assert.deepEqual(Array.from(catalogs.categories), ['Sidecar category', 'YAML category']);
    assert.deepEqual(Array.from(catalogs.settingsUserProfiles), ['Tester']);
    assert.deepEqual(Array.from(catalogs.userProfiles), ['Other user', 'Tester']);
    assert.doesNotMatch(JSON.stringify(catalogs), /private|password|login|dtFile/iu);
    assert.equal(h.scanCalls, 0);
});

test('base selection returns both stock identities with a profile belonging to that base', async t => {
    const h = harness(t);
    const result = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsBase', mode: 'select', source: h.source, selectedSettings: h.selectedSettings, value: 'other' });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { target: 'settings', value: 'other', fields: { ЭталоннаяБазаИмя: 'Other', ИдентификаторБазы: 'other', ПрофильПользователя: 'Other user' } });
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsUserProfile', mode: 'select', source: h.source, selectedSettings: h.selectedSettings, value: 'Other user' }), /profile|base/iu);
});

test('missing, renamed and ambiguous base/profile selections are rejected', async t => {
    const h = harness(t);
    for (const text of [settings('Old name'), settings('Missing', 'missing')]) {
        const selectedSettings = { ...h.selectedSettings, text };
        assert.deepEqual(Array.from((await h.api.loadScenarioPropertiesCatalogs(h.context, h.source, [h.source], selectedSettings)).settingsUserProfiles), []);
        await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsUserProfile', mode: 'select', source: h.source, selectedSettings, value: 'Tester' }), /base|changed|missing/iu);
    }
    const bases = await etalonBases.loadEtalonBasesFromFile(h.baseFile);
    bases.push({ ...bases[0] }); await etalonBases.saveEtalonBasesToFile(h.baseFile, bases);
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsBase', mode: 'select', source: h.source, selectedSettings: h.selectedSettings, value: 'main' }), /ambiguous|unique/iu);
});

test('selecting a base without profiles clears the old profile so a valid profile can be created for it', async t => {
    const h = harness(t);
    const bases = await etalonBases.loadEtalonBasesFromFile(h.baseFile);
    bases[1].userProfiles = [];
    await etalonBases.saveEtalonBasesToFile(h.baseFile, bases);
    const result = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsBase', mode: 'select', source: h.source, selectedSettings: h.selectedSettings, value: 'other' });
    assert.equal(result?.fields?.ПрофильПользователя, '');
    assert.equal(result?.fields?.ИдентификаторБазы, 'other');
});

test('ambiguous profiles and system function UIDs cannot be selected', async t => {
    const h = harness(t);
    const bases = await etalonBases.loadEtalonBasesFromFile(h.baseFile);
    bases[0].userProfiles.push({ profileName: 'tester', login: 'other', password: 'secret' });
    await etalonBases.saveEtalonBasesToFile(h.baseFile, bases);
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsUserProfile', mode: 'select', source: h.source, selectedSettings: h.selectedSettings, value: 'Tester' }), /profile|ambiguous/iu);
    const uid = '98999f57-13dc-11e8-aed1-005056a5c4e8';
    h.config['newScenarioDefaults.systemFunctions'] = [{ name: 'First', uid }, { name: 'Second', uid }];
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'systemFunction', mode: 'select', source: h.source, value: uid }), /ambiguous/iu);
});

test('system function creation stores stock name and UID in the shared project catalog without changing local settings', async t => {
    const h = harness(t); h.input('Created function');
    const result = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'systemFunction', mode: 'create', source: h.source });
    assert.equal(result?.fields?.ФункцияСистемы, 'Created function');
    assert.match(result?.fields?.UIDФункцияСистемы ?? '', /^[0-9a-f-]{36}$/u);
    const functions = (await new storeModule.ProjectPropertyCatalogStore(h.root).read()).systemFunctions!;
    assert.equal(functions.length, 2);
    assert.equal(functions[1].uid, result?.fields?.UIDФункцияСистемы);
    assert.equal((h.config['newScenarioDefaults.systemFunctions'] as unknown[]).length, 1);
    assert.equal(h.configurationUpdates.length, 0);
});

test('creation persists an unused shared string catalog entry and respects source/metadata guards', async t => {
    const h = harness(t);
    h.input(' New category ');
    const request = { kind: 'category' as const, mode: 'create' as const, source: h.source, candidates: [h.source] };
    const result = await h.api.runScenarioPropertiesCatalogAction(h.context, request);
    assert.equal(result?.value, 'New category');
    assert.deepEqual((await new storeModule.ProjectPropertyCatalogStore(h.root).read()).categories, ['New category']);
    h.input('Not written'); h.mutate(() => h.dirty.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(h.root, '.kot', 'property-catalogs.yml'), toString: () => '' } }));
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, request), /Save metadata/u);
    assert.deepEqual((await new storeModule.ProjectPropertyCatalogStore(h.root).read()).categories, ['New category']);
});

test('responsibles combine shared unused entries with names from scenario and process sources', async t => {
    const h = harness(t);
    await new storeModule.ProjectPropertyCatalogStore(h.root).add('responsibles', 'Shared owner');
    const source = { ...h.source, text: h.source.text.replace('    UID: scenario-1', '    Ответственный: Scenario owner\n    UID: scenario-1') };
    const process = { uri: source.uri.replace('scenario.yaml', 'process.yaml'), text: 'ТипФайла: Процесс\nДанныеПроцесса:\n    Ответственный: Process owner\n' };
    const catalogs = await h.api.loadScenarioPropertiesCatalogs(h.context, source, [source, process]);
    assert.deepEqual(Array.from(catalogs.responsibles!), ['Process owner', 'Scenario owner', 'Shared owner']);
});

test('responsible creation is shared and selecting another name clears a previous stock identity', async t => {
    const h = harness(t); h.input(' New owner ');
    const source = { ...h.source, text: h.source.text.replace('    UID: scenario-1', '    Ответственный: Old owner\n    UIDОтветственный: stock-person-id\n    UID: scenario-1') };
    const created = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'responsible', mode: 'create', source });
    assert.equal(created?.value, 'New owner');
    assert.equal(created?.fields?.UIDОтветственный, '');
    assert.deepEqual((await new storeModule.ProjectPropertyCatalogStore(h.root).read()).responsibles, ['New owner']);
    const selected = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'responsible', mode: 'select', source, candidates: [source], value: 'Old owner' });
    assert.equal(selected?.value, 'Old owner');
    assert.equal(selected?.fields?.UIDОтветственный, undefined, 'choosing the same person preserves the stock identity');
    const cleared = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'responsible', mode: 'select', source, candidates: [source], value: '' });
    assert.equal(cleared?.fields?.UIDОтветственный, '');
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'responsible', mode: 'select', source, candidates: [source], value: 'Deleted person' }), /missing|stale/u);
});

test('existing etalon wizards create catalog entries and return only safe linked field values', async t => {
    const h = harness(t);
    const selectedSettings = { ...h.selectedSettings, text: settings('Missing', 'missing') };
    const base = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsBase', mode: 'create', source: h.source, selectedSettings });
    assert.equal(base?.fields?.ИдентификаторБазы, 'new-base');
    assert.equal(base?.fields?.ЭталоннаяБазаИмя, 'New base');
    assert.doesNotMatch(JSON.stringify(base), /hidden|login|password/iu);
    const profile = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsUserProfile', mode: 'create', source: h.source, selectedSettings: h.selectedSettings });
    assert.equal(profile?.value, 'New profile');
    const bases = await etalonBases.loadEtalonBasesFromFile(h.baseFile);
    assert.deepEqual(bases.find(base => base.databaseId === 'main')?.userProfiles.map(value => value.profileName), ['Tester', 'New profile']);
});

test('etalon wizard writes refuse dirty or externally changed bases and stale source snapshots', async t => {
    const h = harness(t);
    const original = fs.readFileSync(h.baseFile, 'utf8');
    const request = { kind: 'settingsBase' as const, mode: 'create' as const, source: h.source, selectedSettings: h.selectedSettings };
    h.mutate(() => fs.writeFileSync(h.baseFile, `${original}\n# external change\n`));
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, request), /conflict|changed/iu);
    assert.equal(fs.readFileSync(h.baseFile, 'utf8'), `${original}\n# external change\n`);
    h.mutate(() => {});
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, { ...request, assertCurrent: () => { throw new Error('Source changed'); } }), /Source changed/u);
    h.dirty.push({ isDirty: true, uri: { scheme: 'file', fsPath: h.baseFile, toString: () => h.baseFile } });
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, request), /save|modified|dirty/iu);
});

test('malformed etalon YAML is never overwritten by a catalog create action', async t => {
    const h = harness(t);
    const text = 'ЭталонныеБД: [unterminated\n';
    fs.writeFileSync(h.baseFile, text);
    await assert.rejects(h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'settingsBase', mode: 'create', source: h.source, selectedSettings: h.selectedSettings }), /invalid|ambiguous|YAML/iu);
    assert.equal(fs.readFileSync(h.baseFile, 'utf8'), text);
});

test('simple selection validates the same sibling inventory without a second full scan', async t => {
    const h = harness(t); const sibling = { uri: pathToFileURL(path.join(h.root, 'sibling.yaml')).toString(), text: scenario('Sibling-only project') };
    const result = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'project', mode: 'select', source: h.source,
        candidates: [h.source, sibling], value: 'Sibling-only project' });
    assert.equal(result?.value, 'Sibling-only project'); assert.equal(h.scanCalls, 0);
});

test('cancelled catalog prompts never prepare a write, successful creation prepares once before writing', async t => {
    const h = harness(t); let prepared = 0;
    const request = { kind: 'project' as const, mode: 'create' as const, source: h.source, prepareWrite: async () => { prepared++; } };
    h.input(undefined); assert.equal(await h.api.runScenarioPropertiesCatalogAction(h.context, request), undefined); assert.equal(prepared, 0);
    h.input('Created project'); await h.api.runScenarioPropertiesCatalogAction(h.context, request); assert.equal(prepared, 1);
    h.cancelBase(); await h.api.runScenarioPropertiesCatalogAction(h.context, { ...request, kind: 'settingsBase', selectedSettings: h.selectedSettings });
    assert.equal(prepared, 1);
});

test('shared function catalog is authoritative over different local defaults in multi-root projects', async t => {
    const h = harness(t); h.workspaces.push({ uri: { scheme: 'file', fsPath: path.join(h.root, 'other'), toString: () => pathToFileURL(path.join(h.root, 'other')).toString() } });
    h.input('New function'); const result = await h.api.runScenarioPropertiesCatalogAction(h.context, { kind: 'systemFunction', mode: 'create', source: h.source });
    assert.equal(result?.fields?.ФункцияСистемы, 'New function'); assert.equal(h.configurationUpdates.length, 0);
    h.config['newScenarioDefaults.systemFunctions'] = [];
    const loaded = await h.api.loadScenarioPropertiesCatalogs(h.context, h.source, [h.source]);
    assert.equal(loaded.systemFunctions.length, 2); assert.equal(loaded.systemFunctions[1].name, 'New function');
});

test('migration retains every valid stock GUID including mixed legacy GUID versions', async t => {
    const h = harness(t); const version7 = { name: 'Imported function', uid: '77777777-2222-7333-8444-555555555555' };
    const expected = [...h.config['newScenarioDefaults.systemFunctions'] as { name: string; uid: string }[], version7];
    h.config['newScenarioDefaults.systemFunctions'] = expected;
    const loaded = await h.api.loadScenarioPropertiesCatalogs(h.context, h.source, [h.source]);
    assert.deepEqual(JSON.parse(JSON.stringify(loaded.systemFunctions)), expected);
});
