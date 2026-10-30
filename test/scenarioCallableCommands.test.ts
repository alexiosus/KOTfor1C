import { v3Fixture } from './helpers/projectFormat';
import * as projectFormatModule from '../src/projectFormat';
import * as projectLegacyModule from '../src/projectLegacyMetadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as core from '../src/scenarioCallableConversion';
import * as files from '../src/scenarioCallableFiles';
import * as formats from '../src/spprScenarioFormat';
import * as descriptor from '../src/scenarioDescriptor';
import * as parser from '../src/exportScenarioParser';
import * as syntax from '../src/scenarioCompilerSyntax';
import * as matcher from '../src/projectDefinitionMatcher';
import * as definitions from '../src/projectDefinition';
import * as model from '../src/scenarioPropertiesModel';
import * as yaml from 'yaml';
import * as nativeSnapshot from '../src/scenarioNativeDocumentSnapshot';
import { collectCompilerFormatIssues } from '../src/compilerFormatDiagnostics';

async function harness(t: test.TestContext, native = false) {
    const directory = await v3Fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'kot-callable-command-'))); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const uri = (file: string): any => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
    const metadata = path.join(directory, native ? 'meta.yaml' : 'scen.yaml'); const script = path.join(directory, 'scen.feature');
    const exported = path.join(directory, 'nested.feature'); let caller = path.join(directory, 'parent.yaml');
    const original = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "nested-uid"\n    Имя: "Nested"\n    Код: "NESTED"\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Value"\n        Значение: "default"\nВложенныеСценарии:\nТекстСценария: |\n    # language: en\n    And I input "[Value]"\n';
    const pair = formats.splitLegacySpprScenario(original);
    fs.writeFileSync(metadata, native ? pair.metadata : original); if (native) { fs.writeFileSync(script, pair.script); }
    fs.writeFileSync(metadata + '.kot.yml', 'version: 2\nidentity:\n  kind: scenario\n  uid: nested-uid\nmetadata:\n  category: Shared\n');
    fs.writeFileSync(caller, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "parent-uid"\n    Имя: "Parent"\nВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "nested-uid"\n        ИмяСценария: "Nested"\nТекстСценария: |\n    And Nested\n        Value = "actual"\n');
    const context = { sourceUri: uri(exported).toString(), workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage: 'en' as const };
    const extraDefinitions: any[] = [];
    let encodedIndexUris = false;
    const getView = () => definitions.createProjectDefinitionView('test', [...(fs.existsSync(metadata) ? [{
        id: uri(metadata).toString(), kind: 'nestedScenario', template: 'Nested', normalizedTemplate: 'Nested', sourceLabel: '', parameters: [{ name: 'Value', index: 0, source: 'snippet', defaultValue: 'default' }],
        definitionLocation: { uri: uri(metadata).toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }
    }] : []), ...(fs.existsSync(exported) ? parser.parseExportScenarios(fs.readFileSync(exported, 'utf8'), {
        ...context, sourceUri: encodedIndexUris ? context.sourceUri.replace('/nested.feature', '/%6eested.feature') : context.sourceUri
    }).definitions : []), ...extraDefinitions]);
    const notices: string[] = []; const dirty = new Set<string>(); const buffers: any[] = []; let cancel = false; let cancelDestination = false; let invalidName = false; let refresh = 0; let opened = '';
    let libraryRoots = [directory]; const registeredLibraries: string[] = []; let appendExisting = false; const changedSources: string[][] = [];
    const libraryFiles = [exported]; const existingChoices: any[][] = []; let pickedExisting = exported; let openDialogs = 0;
    const generated = path.join(directory, 'compiled.feature');
    const vscode: any = {
        Uri: { file: uri, parse: (value: string) => uri(fileURLToPath(value)), joinPath: (base: any, ...segments: string[]) => uri(path.join(base.fsPath, ...segments)) },
        l10n: { t: (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/gu, (_, index) => args[Number(index)] ?? '') },
        workspace: { get textDocuments() { return [...buffers, ...[...dirty].map(file => ({ uri: uri(file), isDirty: true, isClosed: false }))]; },
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), openTextDocument: async (value: any) => ({ uri: value }) },
        window: { showInputBox: async (options: any) => {
            if (cancel) { return undefined; }
            const name = invalidName ? 'Nested without argument' : options.value;
            const validation = options.validateInput(name);
            if (validation) { notices.push(validation); return undefined; }
            return name;
        }, showSaveDialog: async () => cancelDestination ? undefined : uri(fs.existsSync(metadata) ? exported : metadata),
        showOpenDialog: async () => { openDialogs++; return cancelDestination ? undefined : [uri(pickedExisting)]; },
        showQuickPick: async (choices: any[], options: any) => options?.title === 'Export destination' ? choices[appendExisting ? 1 : 0]
            : options?.title === 'Existing feature file' ? (existingChoices.push(choices), cancelDestination ? undefined : choices.find(item => item.uri?.fsPath === pickedExisting) ?? choices.find(item => item.targetKind === 'browse'))
            : choices.find(item => item.definition?.template.startsWith('Nested')) ?? choices[0],
        showErrorMessage: (message: string) => { notices.push(message); }, showInformationMessage: (message: string) => { notices.push(message); },
        showTextDocument: async (document: any) => { opened = document.uri.toString(); } }
    };
    const resolvePair = async (resource: any) => {
        if (resource.fsPath === exported) { return undefined; }
        const file = path.basename(resource.fsPath); const folder = path.dirname(resource.fsPath);
        if (/\.feature$/iu.test(file) && file !== 'scen.feature') { return undefined; }
        if (['scen.feature', 'meta.yaml'].includes(file) && fs.existsSync(path.join(folder, 'meta.yaml')) && fs.existsSync(path.join(folder, 'scen.feature'))) {
            return { format: 'native', metadataUri: uri(path.join(folder, 'meta.yaml')), scriptUri: uri(path.join(folder, 'scen.feature')) };
        }
        return { format: 'legacy', metadataUri: resource, scriptUri: resource };
    };
    const dependencies: Record<string, unknown> = { vscode, './projectFormat': projectFormatModule, './projectLegacyMetadata': projectLegacyModule, yaml, './scenarioNativeDocumentSnapshot': nativeSnapshot, './scenarioCallableConversion': core, './scenarioCallableFiles': files, './spprScenarioFormat': formats,
        './scenarioDescriptor': descriptor, './exportScenarioParser': parser, './scenarioCompilerSyntax': syntax, './projectDefinitionMatcher': matcher,
        './projectDefinition': definitions, './scenarioPropertiesModel': model, './spprScenarioFiles': { resolveScenarioSourceUris: resolvePair },
        './scenarioCreator': { getNewScenarioDefaults: () => ({ project: 'Project', systemFunctions: [{ name: 'Function', uid: 'function-uid' }],
            allowCrossFunctionUsage: true, userProfile: 'User', reportLevel1: 'Tests', nestedReportLevel2: 'Nested' }) }, './projectLibraryStore': { waitForProjectLibraryIdle: async () => undefined } };
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/scenarioCallableCommands.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: (name: string) => dependencies[name] ?? require(name) });
    const services: any = { resolver: { ensureReady: async () => getView(), resolve: async (_uri: unknown, line: string, view = getView()) => matcher.resolveProjectInvocation(view, line) },
        references: { findReferences: async (id: string) => {
            const view = getView(); return [caller, ...(fs.existsSync(generated) ? [generated] : [])].flatMap(file => fs.readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
                const result = matcher.resolveProjectInvocation(view, line);
                return result.kind === 'unique' && result.match.definition.id === id ? [{ uri: uri(file), range: { start: { line: index } } }] : [];
            }));
        } }, catalog: () => ({ all: [] }), sourceForGenerated: async (resource: any) => resource.fsPath === generated ? uri(caller) : undefined,
        loadLibraryRoots: async () => libraryRoots.map(folder => ({ uri: uri(folder).toString() })),
        listLibraryFeatureUris: async () => libraryFiles.filter(file => fs.existsSync(file)).map(file => uri(file).toString()),
        withLibraryFolder: async (_resource: string, folder: string, operation: () => Promise<void>) => {
            await operation(); if (!libraryRoots.includes(folder)) { registeredLibraries.push(folder); libraryRoots.push(folder); }
        }, refresh: async (uris: any[] = []) => { refresh++; changedSources.push(uris.map(uri => uri.fsPath)); } };
    return { directory, metadata, script, exported, caller, generated, original, dirty, buffers, notices,
        addChild: (name: string, body: string) => {
            const file = path.join(directory, `${name}.yaml`);
            const text = `ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "${name}-uid"\n    Имя: "${name}"\n    Код: "${name}"\nПараметрыСценария:\nВложенныеСценарии:\nТекстСценария: |\n    #language: en\n${body.split('\n').map(line => '    ' + line).join('\n')}\n`;
            fs.writeFileSync(file, text);
            extraDefinitions.push({ id: uri(file).toString(), kind: 'nestedScenario', template: name, normalizedTemplate: name, parameters: [], sourceLabel: '',
                definitionLocation: { uri: uri(file).toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } });
            return file;
        },
        nativeCaller: () => {
            const folder = path.join(directory, 'parent'); fs.mkdirSync(folder);
            const pair = formats.splitLegacySpprScenario(fs.readFileSync(caller, 'utf8'));
            fs.unlinkSync(caller); fs.writeFileSync(path.join(folder, 'meta.yaml'), pair.metadata);
            caller = path.join(folder, 'scen.feature'); fs.writeFileSync(caller, pair.script);
            return { script: caller, metadata: path.join(folder, 'meta.yaml') };
        },
        cancel: () => { cancel = true; }, cancelDestination: () => { cancelDestination = true; }, withoutLibraries: () => { libraryRoots = []; }, registeredLibraries,
        invalidName: () => { invalidName = true; }, encodeIndexUris: () => { encodedIndexUris = true; }, appendToExisting: () => { appendExisting = true; },
        refreshed: () => refresh, opened: () => opened, changedSources, libraryFiles, existingChoices,
        chooseExisting: (file: string) => { pickedExisting = file; }, openDialogs: () => openDialogs,
        convert: (file?: string) => module.exports.handleConvertCallableScenario(services, uri(file ?? (fs.existsSync(metadata) ? native ? script : metadata : exported))) };
}

test('immediate export to nested accepts clean editor models for files removed by the export', async t => {
    for (const native of [false, true]) {
        const h = await harness(t, native);
        const pair = formats.splitLegacySpprScenario(h.original);
        const oldMetadata = yaml.parseDocument(pair.metadata).toString(); // Files produced by the previous two-space writer.
        fs.writeFileSync(h.metadata, native ? oldMetadata : formats.joinNativeSpprScenario(oldMetadata, pair.script));
        for (const file of native ? [h.metadata, h.script] : [h.metadata]) {
            const text = fs.readFileSync(file, 'utf8');
            h.buffers.push({ uri: { toString: () => pathToFileURL(file).href, fsPath: file }, version: 1, isDirty: false, isClosed: false, getText: () => text });
        }
        assert.ok(await h.convert(), h.notices.join('\n'));
        assert.ok(await h.convert(), h.notices.join('\n'));
        assert.equal(descriptor.parseScenarioDescriptor(fs.readFileSync(h.metadata, 'utf8')).uid, 'nested-uid');
        assert.match(fs.readFileSync(h.caller, 'utf8'), /Value = "actual"/u);
    }
});

test('immediate reverse conversion accepts a caller editor still showing the last KOT write input', async t => {
    const h = await harness(t); const callerText = fs.readFileSync(h.caller, 'utf8');
    h.buffers.push({ uri: { toString: () => pathToFileURL(h.caller).href, fsPath: h.caller }, version: 1, isDirty: false, isClosed: false, getText: () => callerText });
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.match(fs.readFileSync(h.caller, 'utf8'), /Value = "actual"/u);
});

test('reverse conversion preserves dirty orphan editors, recreated destinations and mismatched input models', async t => {
    for (const state of ['dirty', 'recreated', 'mismatch']) {
        const h = await harness(t); assert.ok(await h.convert(), h.notices.join('\n'));
        const feature = fs.readFileSync(h.exported, 'utf8');
        if (state === 'dirty') { h.dirty.add(h.metadata); }
        if (state === 'recreated') { fs.writeFileSync(h.metadata, 'external source'); }
        if (state === 'mismatch') { h.buffers.push({ uri: { toString: () => pathToFileURL(h.exported).href, fsPath: h.exported }, version: 1, isDirty: false, isClosed: false, getText: () => 'different source' }); }
        assert.equal(await h.convert(h.exported), undefined);
        assert.equal(fs.readFileSync(h.exported, 'utf8'), feature);
        assert.equal(fs.existsSync(h.metadata), state === 'recreated');
        if (state === 'recreated') { assert.equal(fs.readFileSync(h.metadata, 'utf8'), 'external source'); }
    }
});

test('existing destination offers indexed library features in QuickPick without opening a file dialog', async t => {
    const h = await harness(t, true); h.appendToExisting();
    fs.writeFileSync(h.exported, '# language: en\nFeature: Shared\n');
    const another = path.join(h.directory, 'other.feature'); fs.writeFileSync(another, '# language: en\nFeature: Other\n');
    h.libraryFiles.push(another, another, h.script); // Include a duplicate and an SPPR paired script.
    h.chooseExisting(another);
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.equal(h.openDialogs(), 0);
    assert.deepEqual(Array.from(h.existingChoices[0].filter(item => item.uri), item => item.uri.fsPath).sort(), [h.exported, another].sort());
    assert.match(fs.readFileSync(another, 'utf8'), /Scenario: Nested "Value"/u);
    assert.equal(fs.readFileSync(h.exported, 'utf8'), '# language: en\nFeature: Shared\n');
});

test('existing destination keeps a browse fallback when the configured library has no feature files', async t => {
    const h = await harness(t); h.appendToExisting(); h.withoutLibraries();
    fs.writeFileSync(h.exported, '# language: en\nFeature: Shared\n');
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.equal(h.openDialogs(), 1);
    assert.ok(h.existingChoices[0].some(item => item.targetKind === 'browse'));
});

test('recent KOT writes do not authorize changed documents or another writer', async t => {
    for (const state of ['version', 'document', 'disk', 'dirty']) {
        const h = await harness(t); const callerText = fs.readFileSync(h.caller, 'utf8');
        const document = { uri: { toString: () => pathToFileURL(h.caller).href, fsPath: h.caller }, version: 1, isDirty: false, isClosed: false, getText: () => callerText };
        h.buffers.push(document); assert.ok(await h.convert(), h.notices.join('\n'));
        if (state === 'version') { document.version++; }
        if (state === 'document') { h.buffers.splice(0, 1, { ...document }); }
        if (state === 'disk') { fs.appendFileSync(h.caller, '# external writer\n'); }
        if (state === 'dirty') { document.isDirty = true; }
        const feature = fs.readFileSync(h.exported, 'utf8'); const caller = fs.readFileSync(h.caller, 'utf8');
        assert.equal(await h.convert(), undefined);
        assert.equal(fs.readFileSync(h.exported, 'utf8'), feature); assert.equal(fs.readFileSync(h.caller, 'utf8'), caller);
        assert.equal(fs.existsSync(h.metadata), false);
    }
});

test('cancelling the existing library picker leaves source and destination unchanged', async t => {
    const h = await harness(t); h.appendToExisting(); h.cancelDestination();
    fs.writeFileSync(h.exported, '# language: en\nFeature: Shared\n');
    assert.equal(await h.convert(), undefined);
    assert.equal(fs.readFileSync(h.metadata, 'utf8'), h.original);
    assert.equal(fs.readFileSync(h.exported, 'utf8'), '# language: en\nFeature: Shared\n');
    assert.equal(h.refreshed(), 0); assert.equal(h.openDialogs(), 0);
});

test('reverse conversion finds the declaration when editor and index encode the same file URI differently', async t => {
    const h = await harness(t); assert.ok(await h.convert(), h.notices.join('\n')); h.encodeIndexUris();
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.equal(descriptor.parseScenarioDescriptor(fs.readFileSync(h.metadata, 'utf8')).uid, 'nested-uid');
});

test('conversion appends to an existing export file and reverses only the selected declaration and archive', async t => {
    const h = await harness(t); h.appendToExisting();
    const existing = '# language: en\n@ExportScenarios\nFeature: Shared\n\nScenario: Other\n    And Delay 1\n';
    const archive = { version: 1, title: 'Other', source: h.original.replace(/Nested/gu, 'Other').replace('nested-uid', 'other-uid'), format: 'legacy' };
    fs.writeFileSync(h.exported, existing); fs.writeFileSync(h.exported + '.kot-nested.json', JSON.stringify(archive));
    assert.ok(await h.convert(), h.notices.join('\n'));
    const content = fs.readFileSync(h.exported, 'utf8'); assert.ok(content.startsWith(existing));
    assert.deepEqual(parser.parseExportScenarios(content, { sourceUri: '', workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage: 'en' }).scenarios.map(item => item.title), ['Other', 'Nested "Value"']);
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.match(fs.readFileSync(h.exported, 'utf8'), /Scenario: Other\n    And Delay 1/u);
    assert.doesNotMatch(fs.readFileSync(h.exported, 'utf8'), /Scenario: Nested/u);
    assert.equal(descriptor.parseScenarioDescriptor(fs.readFileSync(h.metadata, 'utf8')).uid, 'nested-uid');
    assert.match(fs.readFileSync(h.exported + '.kot-nested.json', 'utf8'), /other-uid/u);
});

test('appending does not make unrelated scenarios exported or overwrite a library with a different language', async t => {
    for (const language of ['en', 'ru']) {
        const h = await harness(t); h.appendToExisting();
        const existing = language === 'en' ? '# language: en\nFeature: Shared\nScenario: Ordinary test\n    And Delay 1\n'
            : '# language: ru\nФункциональность: Библиотека\nСценарий: Другой\n    И Пауза 1\n';
        fs.writeFileSync(h.exported, existing);
        if (language === 'ru') {
            assert.equal(await h.convert(), undefined);
            assert.equal(fs.readFileSync(h.exported, 'utf8'), existing); assert.equal(fs.readFileSync(h.metadata, 'utf8'), h.original);
        } else {
            assert.ok(await h.convert(), h.notices.join('\n'));
            const parsed = parser.parseExportScenarios(fs.readFileSync(h.exported, 'utf8'), { sourceUri: '', workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage: 'en' });
            assert.deepEqual(parsed.scenarios.map(item => item.exported), [false, true]);
        }
    }
});

test('export conversion registers its destination when the profile has no library folders', async t => {
    for (const native of [false, true]) {
        const h = await harness(t, native); h.withoutLibraries();
        assert.ok(await h.convert(), h.notices.join('\n'));
        assert.deepEqual(h.registeredLibraries, [h.directory]);
        assert.match(fs.readFileSync(h.caller, 'utf8'), /And Nested "actual"/u);
        assert.ok(await h.convert(), h.notices.join('\n'));
        assert.match(fs.readFileSync(h.caller, 'utf8'), /Value = "actual"/u);
    }
});

test('cancelled or failed export conversion does not register a library folder', async t => {
    for (const cancelled of [false, true]) {
        const h = await harness(t); h.withoutLibraries();
        if (cancelled) { h.cancelDestination(); } else { fs.writeFileSync(h.exported, 'existing'); }
        assert.equal(await h.convert(), undefined);
        assert.deepEqual(h.registeredLibraries, []);
        assert.equal(fs.readFileSync(h.metadata, 'utf8'), h.original);
    }
});

test('conversion command round trips both SPPR formats and updates saved callers and declarations', async t => {
    for (const native of [false, true]) {
        const h = await harness(t, native);
        assert.ok(await h.convert(), h.notices.join('\n'));
        assert.equal(fs.existsSync(h.metadata), false);
        assert.ok(h.changedSources[0].includes(h.metadata));
        assert.ok(h.changedSources[0].includes(h.caller));
        assert.ok(h.changedSources[0].includes(h.exported));
        assert.match(fs.readFileSync(h.caller, 'utf8'), /And Nested "actual"/u);
        assert.doesNotMatch(fs.readFileSync(h.caller, 'utf8'), /ИмяСценария: "Nested"/u);
        assert.ok(await h.convert(), h.notices.join('\n'));
        const restored = native ? formats.joinNativeSpprScenario(fs.readFileSync(h.metadata, 'utf8'), fs.readFileSync(h.script, 'utf8')) : fs.readFileSync(h.metadata, 'utf8');
        assert.deepEqual(collectCompilerFormatIssues(restored, h.metadata).filter(issue => issue.kind === 'indentation'), []);
        assert.equal(descriptor.parseScenarioDescriptor(restored).uid, 'nested-uid');
        assert.match(fs.readFileSync(h.caller, 'utf8'), /And Nested\n        Value = "actual"/u);
        assert.match(fs.readFileSync(h.caller, 'utf8'), /ИмяСценария: "Nested"/u);
        assert.equal(h.refreshed(), 2); assert.ok(h.opened());
        assert.ok(h.changedSources[1].includes(h.metadata));
        assert.ok(h.changedSources[1].includes(h.exported));
    }
});
test('cancelled prompt, missing title parameter and dirty source never write files', async t => {
    for (const state of ['cancel', 'invalidName', 'dirty'] as const) {
        const h = await harness(t);
        if (state === 'dirty') { h.dirty.add(h.metadata); } else { h[state](); }
        assert.equal(await h.convert(), undefined);
        assert.equal(fs.readFileSync(h.metadata, 'utf8'), h.original); assert.equal(fs.existsSync(h.exported), false);
        assert.equal(h.refreshed(), 0);
    }
});
test('destination collision and dirty callers retain the original scenario', async t => {
    const collision = await harness(t); fs.writeFileSync(collision.exported, 'existing');
    assert.equal(await collision.convert(), undefined); assert.equal(fs.readFileSync(collision.metadata, 'utf8'), collision.original);
    assert.equal(fs.readFileSync(collision.exported, 'utf8'), 'existing');
    const dirty = await harness(t); dirty.dirty.add(dirty.caller);
    assert.equal(await dirty.convert(), undefined); assert.equal(fs.readFileSync(dirty.metadata, 'utf8'), dirty.original);
});

test('native SPPR caller script and metadata are both rewritten', async t => {
    const h = await harness(t); const caller = h.nativeCaller();
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.match(fs.readFileSync(caller.script, 'utf8'), /And Nested "actual"/u);
    assert.doesNotMatch(fs.readFileSync(caller.metadata, 'utf8'), /ИмяСценария/u);
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.match(fs.readFileSync(caller.script, 'utf8'), /And Nested\n    Value = "actual"/u);
    assert.match(fs.readFileSync(caller.metadata, 'utf8'), /ИмяСценария: "Nested"/u);
});

test('an existing export without an archive gets a new UID, declared arguments and configured defaults', async t => {
    const h = await harness(t); fs.unlinkSync(h.metadata); fs.unlinkSync(h.metadata + '.kot.yml');
    fs.writeFileSync(h.exported, core.nestedToExport(h.original, 'Nested "Value"').feature);
    fs.writeFileSync(h.caller, fs.readFileSync(h.caller, 'utf8').replace('And Nested\n        Value = "actual"', 'And Nested "actual"'));
    assert.ok(await h.convert(), h.notices.join('\n'));
    const source = fs.readFileSync(h.metadata, 'utf8'); const data = yaml.parseDocument(source).toJS();
    assert.deepEqual(collectCompilerFormatIssues(source, h.metadata).filter(issue => issue.kind === 'indentation'), []);
    assert.notEqual(data.ДанныеСценария.UID, 'nested-uid'); assert.equal(data.ДанныеСценария.Проект, 'Project');
    assert.equal(data.ПараметрыСценария[0].ПараметрыСценария1.Имя, 'Value');
    assert.match(fs.readFileSync(h.caller, 'utf8'), /Value = "actual"/u);
});

test('compiled feature references are left for the next build in both conversion directions', async t => {
    const h = await harness(t); fs.writeFileSync(h.generated, 'And Nested\n');
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.equal(fs.readFileSync(h.generated, 'utf8'), 'And Nested\n');
    fs.writeFileSync(h.generated, 'And Nested "compiled value"\n');
    assert.ok(await h.convert(), h.notices.join('\n'));
    assert.equal(fs.readFileSync(h.generated, 'utf8'), 'And Nested "compiled value"\n');
});

test('saved BOM files and native editor line endings convert in both SPPR formats', async t => {
    for (const native of [false, true]) {
        const h = await harness(t, native);
        for (const file of native ? [h.metadata, h.script] : [h.metadata]) {
            const text = '\uFEFF' + fs.readFileSync(file, 'utf8').replace(/\n/gu, '\r\n'); fs.writeFileSync(file, text);
            h.buffers.push({ uri: { toString: () => pathToFileURL(file).href, fsPath: file }, version: 1, isDirty: false, isClosed: false,
                getText: () => text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n') });
        }
        assert.ok(await h.convert(), h.notices.join('\n'));
        assert.equal(JSON.parse(fs.readFileSync(h.exported + '.kot-nested.json', 'utf8')).source.startsWith('\uFEFF'), true);
    }
});

test('clean editor model reloads caused by conversion do not count as concurrent edits', async t => {
    const h = await harness(t); const initial = fs.readFileSync(h.metadata, 'utf8');
    h.buffers.push({ uri: { toString: () => pathToFileURL(h.metadata).href, fsPath: h.metadata }, isDirty: false, isClosed: false,
        get version() { return fs.existsSync(h.metadata) ? 1 : 2; }, getText: () => initial });
    assert.ok(await h.convert(), h.notices.join('\n'));
});

test('parameterless nested calls are expanded while root parameters remain callable arguments', async t => {
    const h = await harness(t); const child = h.addChild('Child', 'And Delay 1\nAnd I save "value" in "variable" variable');
    fs.writeFileSync(h.metadata, h.original.replace('And I input "[Value]"', 'And I input "[Value]"\n    And Child'));
    assert.ok(await h.convert(), h.notices.join('\n'));
    const feature = fs.readFileSync(h.exported, 'utf8');
    assert.match(feature, /Scenario: Nested "Value"/u); assert.match(feature, /And I input "Value"/u);
    assert.match(feature, /And Delay 1/u); assert.match(feature, /And I save "value"/u);
    assert.doesNotMatch(feature, /^\s*And Child\s*$/mu); assert.equal(fs.existsSync(child), true);
});

test('cyclic nested calls are rejected before creating an export', async t => {
    const h = await harness(t); h.addChild('Child', 'And Nested');
    fs.writeFileSync(h.metadata, h.original.replace('And I input "[Value]"', 'And Child'));
    assert.equal(await h.convert(), undefined); assert.equal(fs.existsSync(h.exported), false);
    assert.match(h.notices.at(-1) ?? '', /cyclic|recursive/iu);
});
