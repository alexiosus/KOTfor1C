import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import vm from 'node:vm';
import { parseScenarioDescriptor } from '../src/scenarioDescriptor';
import { applyPreparedFileWrites } from '../src/preparedFileWrites';
import { findLinkedScenarioSettings } from '../src/scenarioPropertiesBindings';
import { applyScenarioPropertyIdentity } from '../src/scenarioPropertyIdentity';
import { nativeDocumentTextMatchesFileText } from '../src/scenarioNativeDocumentSnapshot';
import { nativeScenarioIdentityFiles } from './helpers/nativeScenarioIdentityFiles';

function provider(deleteDefinition: (context: unknown, target: unknown) => Promise<unknown> = async () => undefined,
    environment: { workspace?: unknown; modules?: Record<string, unknown> } = {}) {
    const ts = require('typescript') as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/phaseSwitcher.ts'), 'utf8');
    const module = { exports: {} as any };
    const errors: string[] = [];
    const vscode = { EventEmitter: class {}, workspace: environment.workspace, Uri: { parse: (value: string) => ({ toString: () => value, fsPath: new URL(value).pathname }) }, window: { activeTextEditor: undefined,
        showInformationMessage: () => {}, showErrorMessage: (message: string) => errors.push(message) } };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, Buffer, console, process, setTimeout, clearTimeout, setInterval, clearInterval,
            require: (name: string) => {
                if (name === 'vscode') { return vscode; }
                if (['fs', 'path', 'os'].includes(name)) { return require(name); }
                const dependency = environment.modules?.[name.replace(/\.js$/u, '')];
                if (dependency) { return dependency; }
                if (name === './projectDefinitionDeletion') { return { deleteScenarioDefinition: deleteDefinition }; }
                if (name === './scenarioRuntimeIdentity') { return { getScenarioRuntimeKey: (item: any) => item.yamlFileUri.toString() }; }
                if (name === './deferredLoader') { return { createDeferredLoader: (factory: unknown) => factory }; }
                return {};
            } });
    const result = Object.create(module.exports.PhaseSwitcherProvider.prototype) as any;
    result._context = {};
    result.t = (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '');
    return { result, errors };
}

function identityFixture(t: TestContext, options: { bom?: boolean; eol?: string; mixedEol?: boolean; nativeText?: string; dirty?: boolean; transientReload?: boolean; changeAfterRead?: boolean; linkedFiles?: boolean; dirtyRelated?: boolean; dedicated?: boolean; nested?: boolean } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-identity-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const eol = options.eol ?? '\n';
    const sourceText = 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: scenario\n    Имя: Old\n    Код: "001"\nТекстСценария: |\n    And I do a step\n';
    let line = 0;
    const before = (options.bom ? '\uFEFF' : '') + sourceText.replace(/\n/gu, () => options.mixedEol ? line++ % 2 ? '\n' : '\r\n' : eol);
    const sourceDirectory = options.dedicated ? path.join(directory, '001') : directory;
    fs.mkdirSync(path.join(sourceDirectory, 'test'), { recursive: true });
    const file = path.join(sourceDirectory, 'scen.yaml');
    fs.writeFileSync(file, before);
    const uri = { fsPath: file, toString: () => new URL(`file://${file}`).toString() };
    const scenario = { name: 'Old', uid: 'scenario', scenarioCode: '001', yamlFileUri: uri };
    let nativeText = options.nativeText ?? sourceText.replace(/\n/gu, eol);
    const document = { uri, version: 1, isClosed: false, isDirty: options.dirty ?? false, getText: () => nativeText };
    const catalog = [scenario];
    const settings: { uri: string; text: string }[] = [];
    const related: Record<string, { file: string; before: string }> = {};
    const textDocuments = [document];
    if (options.linkedFiles) {
        const add = (name: string, text: string, item?: { uid: string; name: string; scenarioCode?: string }) => {
            const file = options.dedicated && ['settings', 'variant'].includes(name)
                ? path.join(sourceDirectory, 'test', name === 'settings' ? '001.yaml' : 'Custom.yaml') : path.join(directory, name + '.yaml');
            const before = '\uFEFF' + text.replace(/\n/gu, '\r\n');
            fs.writeFileSync(file, before); related[name] = { file, before };
            const resource = { fsPath: file, toString: () => new URL(`file://${file}`).toString() };
            if (item) { catalog.push({ scenarioCode: '', ...item, yamlFileUri: resource }); }
            else { settings.push({ uri: resource.toString(), text: before }); }
            if (name === 'settings' && options.dirtyRelated) { textDocuments.push({ uri: resource, version: 1, isClosed: false, isDirty: true, getText: () => text }); }
        };
        add('caller', 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: caller\n    Имя: Caller\n    Код: "010"\nВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: scenario\n        ИмяСценария: Old\nТекстСценария: |\n    And Old\n', { uid: 'caller', name: 'Caller', scenarioCode: '010' });
        add('process', 'ТипФайла: Процесс\nДанныеПроцесса:\n    UID: process\n    Имя: Process\nШагиПроцесса:\n    - ШагиПроцесса1:\n        ТипШага: "0"\n        UID: step\n        СценарийUID: scenario\n        СценарийНаименование: Old\n        СценарийКод: "001"\n        Наименование: Old\n', { uid: 'process', name: 'Process' });
        add('settings', 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: scenario\n    СценарийНаименование: Old\n    Имя: Old\n    Код: "001"\n');
        add('variant', 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: scenario\n    СценарийНаименование: Old\n    Имя: Custom variant\n    Код: CustomCode\n');
        add('unrelated', 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: other\n    СценарийНаименование: Old\n    Имя: Old\n    Код: "001"\n');
    }
    const listeners = new Set<(event: { document: typeof document }) => void>();
    const writes: string[] = [];
    const resource = (file: string) => ({ fsPath: file, toString: () => new URL(`file://${file}`).toString() });
    class Edit {
        moves: { oldUri: typeof uri; newUri: typeof uri }[] = [];
        renameFile(oldUri: typeof uri, newUri: typeof uri) { this.moves.push({ oldUri, newUri }); }
    }
    const moves: { oldUri: typeof uri; newUri: typeof uri }[] = [];
    const workspace = {
        textDocuments,
        applyEdit: async (edit: Edit) => {
            for (const move of edit.moves) {
                await fs.promises.rename(move.oldUri.fsPath, move.newUri.fsPath); moves.push(move);
                for (const doc of textDocuments) {
                    const relative = path.relative(move.oldUri.fsPath, doc.uri.fsPath);
                    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { doc.uri = resource(path.join(move.newUri.fsPath, relative)); }
                }
            }
            return true;
        },
        onDidChangeTextDocument: (listener: (event: { document: typeof document }) => void) => {
            listeners.add(listener); return { dispose: () => listeners.delete(listener) };
        },
        fs: {
            readFile: async (resource: typeof uri) => {
                const bytes = await fs.promises.readFile(resource.fsPath);
                if (options.changeAfterRead) { nativeText += '# changed during preparation\n'; document.version++; options.changeAfterRead = false; }
                return bytes;
            },
            writeFile: async (resource: typeof uri, bytes: Uint8Array) => {
                await fs.promises.writeFile(resource.fsPath, bytes); writes.push(resource.toString());
                if (resource.toString() === uri.toString()) {
                    if (options.transientReload) {
                        setTimeout(() => { nativeText += '# intermediate native change\n'; document.version++; listeners.forEach(listener => listener({ document })); }, 5);
                    }
                    setTimeout(() => {
                        nativeText = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/u, '').replace(/\r\n|\r|\n/gu, eol);
                        document.version++; listeners.forEach(listener => listener({ document }));
                    }, 15);
                }
            }
        }
    };
    const { result: subject } = provider(undefined, { workspace, modules: {
        './scenarioDescriptor': { parseScenarioDescriptor }, './preparedFileWrites': { applyPreparedFileWrites },
        './scenarioNativeDocumentSnapshot': { nativeDocumentTextMatchesFileText },
        './scenarioPropertiesBindings': { findLinkedScenarioSettings }, './scenarioPropertyIdentity': { applyScenarioPropertyIdentity },
        './scenarioIdentityFiles': nativeScenarioIdentityFiles({ workspace, Uri: { file: resource }, WorkspaceEdit: Edit }),
        './projectLibraryIntegration': { projectLibraryEnvironment: () => ({ workspaceRoots: [directory], scanRoots: [directory] }) },
        './scenarioPropertiesPanel': { createScenarioPropertiesHost: () => ({
            readDocument: async () => ({ uri: document.uri.toString(), text: document.getText(), version: document.version, dirty: document.isDirty }),
            listSettings: async () => settings
        }) }
    } });
    const favorite = { name: 'Old', scenarioCode: '001', uri: uri.toString() };
    subject.isMainScenario = () => !options.nested;
    subject.ensureFreshScenarioCatalog = async () => ({ all: catalog });
    subject.getFavoriteEntries = () => [favorite];
    subject.doesFavoriteEntryMatchUri = () => true;
    subject.saveFavoriteEntries = async () => undefined;
    subject.markBuiltArtifactsAsStale = () => undefined;
    subject.sendRunArtifactsStateToWebview = () => undefined;
    subject.refreshTestCacheFromDisk = async () => undefined;
    subject.sendRelationshipStateToWebview = () => undefined;
    return { subject, scenario, document, file, before, writes, favorite, related, directory, moves };
}

test('a saved BOM scenario can change its name and code without losing the disk BOM or line endings', async t => {
    for (const eol of ['\n', '\r\n']) {
        const fixture = identityFixture(t, { bom: true, eol });
        await fixture.subject.changeScenarioIdentityField(fixture.scenario, 'code', '002');
        assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.before.replace('Код: "001"', 'Код: "002"'));
        assert.match(fixture.document.getText(), /Код: "002"/u);
        assert.equal(fixture.favorite.scenarioCode, '002');
        fixture.scenario.scenarioCode = '002';
        await fixture.subject.changeScenarioIdentityField(fixture.scenario, 'name', 'New');
        assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.before.replace('Имя: Old', 'Имя: "New"').replace('Код: "001"', 'Код: "002"'));
        assert.match(fixture.document.getText(), /Имя: "New"/u);
        assert.equal(fixture.favorite.name, 'New');
    }
});

test('identity changes preserve mixed disk line endings while accepting the normalized native source', async t => {
    const fixture = identityFixture(t, { bom: true, mixedEol: true });
    await fixture.subject.changeScenarioIdentityField(fixture.scenario, 'code', '002');
    assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.before.replace('Код: "001"', 'Код: "002"'));
    assert.match(fixture.document.getText(), /Код: "002"/u);
});

test('inline code changes return the final bound source and exact resource moves', async t => {
    const fixture = identityFixture(t);
    const result = await fixture.subject.changeScenarioIdentityField(fixture.scenario, 'code', '002');
    assert.equal(result.sourceUri, fixture.scenario.yamlFileUri.toString());
    assert.equal(JSON.stringify(result.uriMoves), '[]');
});

test('main and nested code fields move dedicated folders while retaining their native BOM source and UID callers', async t => {
    for (const nested of [false, true]) {
        const f = identityFixture(t, { dedicated: true, nested, bom: true, eol: '\r\n', linkedFiles: true });
        const result = await f.subject.changeScenarioIdentityField(f.scenario, 'code', '002');
        const directory = path.join(f.directory, '002');
        assert.equal(fs.readFileSync(path.join(directory, 'scen.yaml'), 'utf8'), f.before.replace('Код: "001"', 'Код: "002"'));
        assert.ok(fs.existsSync(path.join(directory, 'test', '002.yaml')));
        assert.ok(fs.existsSync(path.join(directory, 'test', 'Custom.yaml')));
        assert.equal(f.document.uri.toString(), result.sourceUri);
        assert.equal(f.favorite.uri, result.sourceUri);
        assert.match(fs.readFileSync(f.related.process.file, 'utf8'), /СценарийКод: "002"/u);
        assert.equal(fs.readFileSync(f.related.caller.file, 'utf8'), f.related.caller.before);
        assert.equal(result.uriMoves.length, 2);
    }
});

test('display name fields retain dedicated folder and code-named settings paths', async t => {
    const f = identityFixture(t, { dedicated: true, linkedFiles: true });
    const result = await f.subject.changeScenarioIdentityField(f.scenario, 'name', 'New');
    assert.equal(result.sourceUri, f.scenario.yamlFileUri.toString());
    assert.equal(result.uriMoves.length, 0);
    assert.ok(fs.existsSync(f.file)); assert.ok(fs.existsSync(f.related.settings.file));
    assert.deepEqual(f.moves, []);
});

test('BOM identity edits update linked caller, settings and process files while preserving custom variant identity', async t => {
    const fixture = identityFixture(t, { bom: true, eol: '\r\n', linkedFiles: true });
    await fixture.subject.changeScenarioIdentityField(fixture.scenario, 'name', 'New');
    fixture.scenario.name = 'New';
    await fixture.subject.changeScenarioIdentityField(fixture.scenario, 'code', '002');
    const content = (name: string) => fs.readFileSync(fixture.related[name].file, 'utf8');
    assert.equal(content('caller'), fixture.related.caller.before.replace('ИмяСценария: Old', 'ИмяСценария: "New"').replace('And Old', 'And New'));
    assert.equal(content('process'), fixture.related.process.before.replace('СценарийНаименование: Old', 'СценарийНаименование: "New"').replace('СценарийКод: "001"', 'СценарийКод: "002"').replace('Наименование: Old', 'Наименование: "New"'));
    assert.equal(content('settings'), fixture.related.settings.before.replace('СценарийНаименование: Old', 'СценарийНаименование: "New"').replace('Имя: Old', 'Имя: "New"').replace('Код: "001"', 'Код: "002"'));
    assert.equal(content('variant'), fixture.related.variant.before.replace('СценарийНаименование: Old', 'СценарийНаименование: "New"'));
    assert.equal(content('unrelated'), fixture.related.unrelated.before);
    assert.equal(fixture.favorite.name, 'New'); assert.equal(fixture.favorite.scenarioCode, '002');
});

test('dirty linked files stop BOM identity changes before any disk write', async t => {
    const fixture = identityFixture(t, { bom: true, linkedFiles: true, dirtyRelated: true });
    await assert.rejects(fixture.subject.changeScenarioIdentityField(fixture.scenario, 'name', 'New'), /Save modified related files/u);
    assert.deepEqual(fixture.writes, []); assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.before);
    for (const related of Object.values(fixture.related)) { assert.equal(fs.readFileSync(related.file, 'utf8'), related.before); }
});

test('identity changes still reject native source text that differs from disk beyond BOM or line endings', async t => {
    const fixture = identityFixture(t, { bom: true, nativeText: 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: scenario\n    Имя: Old\n    Код: "001"\nТекстСценария: |\n    And an unsaved step\n' });
    await assert.rejects(fixture.subject.changeScenarioIdentityField(fixture.scenario, 'code', '002'), /Save the source/u);
    assert.deepEqual(fixture.writes, []); assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.before);
});

test('identity changes reject dirty native documents even when their text matches the disk snapshot', async t => {
    const fixture = identityFixture(t, { dirty: true });
    await assert.rejects(fixture.subject.changeScenarioIdentityField(fixture.scenario, 'code', '002'), /Save.*before changing identity/u);
    assert.deepEqual(fixture.writes, []);
});

test('identity changes reject a source model that changed during file preparation', async t => {
    const fixture = identityFixture(t, { changeAfterRead: true });
    await assert.rejects(fixture.subject.changeScenarioIdentityField(fixture.scenario, 'code', '002'), /source changed/u);
    assert.deepEqual(fixture.writes, []); assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.before);
});

test('identity changes acknowledge only the expected native reload rather than an intermediate model change', async t => {
    const fixture = identityFixture(t, { transientReload: true });
    await fixture.subject.changeScenarioIdentityField(fixture.scenario, 'code', '002');
    assert.match(fixture.document.getText(), /Код: "002"/u);
    assert.doesNotMatch(fixture.document.getText(), /intermediate native change/u);
});

test('a process rename uses its exact target even when its phase metadata has no group', async () => {
    const { result: subject } = provider();
    const process = { kind: 'process', name: 'Process', yamlFileUri: { toString: () => 'file:///one/process.yaml' } };
    subject.resolveScenarioOperationTarget = async () => process;
    const calls: unknown[] = [];
    subject.renameScenario = async (target: unknown) => calls.push(['process', target]);
    subject.changeNestedScenarioName = async () => calls.push(['nested']);
    await subject.renameScenarioTarget({ name: 'Process', uri: 'file:///one/process.yaml' });
    assert.equal(JSON.stringify(calls), JSON.stringify([['process', { name: 'Process', uri: 'file:///one/process.yaml' }]]));
});

test('inline scenario name/code are independent field mutations, rather than the legacy combined rename dialog', async () => {
    const { result: subject } = provider();
    const scenario = { name: 'Main', yamlFileUri: { toString: () => 'file:///one/scen.yaml' } };
    subject.resolveScenarioOperationTarget = async () => scenario;
    const calls: unknown[] = [];
    subject.changeScenarioIdentityField = async (...args: unknown[]) => calls.push(args);
    subject.renameScenario = () => assert.fail('inline fields must not use the combined name/code dialog');
    await subject.renameScenarioTarget({ name: 'Main', uri: 'file:///one/scen.yaml' }, 'New name', 'name');
    await subject.renameScenarioTarget({ name: 'Main', uri: 'file:///one/scen.yaml' }, 'NEW_CODE', 'code');
    assert.equal(JSON.stringify(calls), JSON.stringify([[scenario, 'name', 'New name'], [scenario, 'code', 'NEW_CODE']]));
});

test('shared deletion returns success only after runtime state and views refresh', async () => {
    const target = { name: 'Process', uri: 'file:///one/process.yaml' };
    const resource = { fsPath: '/one/process.yaml', toString: () => target.uri };
    const scenario = { kind: 'process', name: target.name, yamlFileUri: resource };
    const { result: subject } = provider(async (_context, request) => {
        assert.equal(JSON.stringify(request), JSON.stringify(target)); return { scenario, deletedUris: [resource] };
    });
    const calls: string[] = [];
    subject.removeScenarioCustomInfobasePathsForUris = () => calls.push('paths');
    subject.removeFavoriteEntriesUnderDirectory = async () => calls.push('favorites');
    subject.removeMainScenarioSelectionStatesForUris = async () => calls.push('selection');
    subject.cleanupDeletedScenarioRuntimeState = () => calls.push('runtime');
    subject.sendRunArtifactsStateToWebview = () => calls.push('artifacts');
    subject.refreshTestCacheFromDisk = async () => calls.push('catalog');
    subject.pruneScenarioBuildArtifactsByCache = () => calls.push('prune');
    subject.handleActiveEditorChanged = () => calls.push('editor');
    subject.sendRelationshipStateToWebview = () => calls.push('relationships');
    assert.equal(typeof subject.deleteScenarioTarget, 'function');
    assert.equal(await subject.deleteScenarioTarget(target), true);
    assert.ok(calls.includes('runtime')); assert.ok(calls.indexOf('catalog') > calls.indexOf('runtime'));
    assert.ok(calls.includes('selection')); assert.ok(calls.includes('favorites')); assert.ok(calls.includes('relationships'));
});

test('cancelled deletion leaves runtime and favorite state unchanged', async () => {
    const { result: subject } = provider();
    subject.refreshTestCacheFromDisk = async () => assert.fail('cancelled deletion must not refresh or clean up state');
    assert.equal(typeof subject.deleteScenarioTarget, 'function');
    assert.equal(await subject.deleteScenarioTarget({ name: 'Cancelled', uri: 'file:///one/scen.yaml' }), false);
});
