import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import * as parser from '../src/exportScenarioParser';
import * as descriptors from '../src/scenarioDescriptor';
import * as selection from '../src/compilerProcessSelection';
import * as yaml from '../src/scenarioYamlDocument';
import * as compilerSyntax from '../src/scenarioCompilerSyntax';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import * as projectLibraryStore from '../src/projectLibraryStore';
import * as projectLibraryMetadata from '../src/projectLibraryMetadata';

async function harness(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-definition-delete-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });
    const documents: any[] = [];
    const deleted: { uri: string; recursive?: boolean; useTrash?: boolean }[] = [];
    const confirmations: { readonly message: string; readonly detail: string }[] = [];
    let confirm = true; let duringConfirmation: (() => Promise<void>) | undefined;
    const open = async (resource: ReturnType<typeof uri>) => {
        const existing = documents.find(doc => doc.uri.toString() === resource.toString());
        if (existing) { return existing; }
        const document = { uri: resource, version: 1, isDirty: false, text: await fs.readFile(resource.fsPath, 'utf8'),
            getText() { return this.text; }, positionAt(offset: number) {
                const parts = this.text.slice(0, offset).split('\n'); return { line: parts.length - 1, character: parts.at(-1)!.length };
            }, async save() { await fs.writeFile(resource.fsPath, this.text); this.isDirty = false; return true; } };
        documents.push(document); return document;
    };
    const scan = async () => {
        const files: string[] = [];
        const visit = async (directory: string) => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                if (entry.name === '.trash') { continue; }
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) { await visit(file); }
                else if (/\.yaml$/iu.test(file)) { files.push(file); }
            }
        };
        await visit(root);
        return buildScenarioCatalog((await Promise.all(files.map(async file => descriptors.parseTestInfoFromScenarioSource(
            await fs.readFile(file, 'utf8'), uri(file) as any, file
        )))).filter((info): info is NonNullable<typeof info> => !!info));
    };
    class Edit { deletions: any[] = []; delete(resource: any, range: any) { this.deletions.push({ resource, range }); } }
    const host = {
        Uri: { file: uri, parse: (value: string) => uri(value.replace(/^file:\/\//u, '')) },
        Range: class {
            readonly start: any; readonly end: any;
            constructor(start: any, end: any, endLine?: number, endCharacter?: number) {
                this.start = typeof start === 'number' ? { line: start, character: end } : start;
                this.end = typeof start === 'number' ? { line: endLine, character: endCharacter } : end;
            }
        }, WorkspaceEdit: Edit,
        window: { showWarningMessage: async (message: string, options: { detail: string }, action: any) => {
            confirmations.push({ message, detail: options.detail });
            await duringConfirmation?.(); duringConfirmation = undefined; return confirm ? action : undefined;
        }, showInformationMessage: async () => {} },
        workspace: { workspaceFolders: [{ uri: uri(root) }], getWorkspaceFolder: () => ({ uri: uri(root) }), textDocuments: documents,
            openTextDocument: open, fs: { readFile: (resource: any) => fs.readFile(resource.fsPath),
                delete: async (resource: any, options: any) => {
                    deleted.push({ uri: resource.toString(), ...options });
                    await fs.mkdir(path.join(root, '.trash'), { recursive: true });
                    await fs.rename(resource.fsPath, path.join(root, '.trash', `${deleted.length}-${path.basename(resource.fsPath)}`));
                } }, applyEdit: async (edit: Edit) => {
                    for (const item of edit.deletions) {
                        const document = await open(item.resource);
                        const offset = (position: any) => document.text.split('\n').slice(0, position.line).reduce((n: number, line: string) => n + line.length + 1, position.character);
                        document.text = document.text.slice(0, offset(item.range.start)) + document.text.slice(offset(item.range.end));
                        document.version++; document.isDirty = true;
                    } return true;
                } }, l10n: { t: (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '') }
    };
    const dependencies: Record<string, unknown> = {
        vscode: host, './workspaceScanner': { scanWorkspaceForScenarioCatalog: scan }, './scenarioScanRoot': { resolveProcessScanRootFsPath: () => root },
        './compilerProcessSelection': selection, './scenarioDescriptor': descriptors, './scenarioYamlDocument': yaml, './scenarioCatalog': { buildScenarioCatalog },
        './exportScenarioParser': parser, './scenarioCompilerSyntax': compilerSyntax, './localization': { getTranslator: async () => host.l10n.t },
        './projectLibraryIntegration': { projectedProjectScenario: (document: { uri: any; getText(): string }) =>
            descriptors.parseTestInfoFromScenarioSource(document.getText(), document.uri, document.uri.fsPath),
            projectLibraryEnvironment: () => ({ workspaceRoots: [root], scanRoots: [root] }) },
        './projectLibraryStore': projectLibraryStore, './projectLibraryMetadata': projectLibraryMetadata
    };
    const module = { exports: {} as any };
    try {
        const source = await fs.readFile(path.join(process.cwd(), 'src/projectDefinitionDeletion.ts'), 'utf8');
        const ts = require('typescript') as typeof import('typescript');
        vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
            { module, exports: module.exports, Buffer, console, require: (name: string) => dependencies[name] ?? require(name) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    return { api: module.exports, root, uri, open, deleted, confirmations, scan, host, context: { extensionUri: uri('/extension') },
        async write(name: string, text: string) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return uri(file); },
        cancel() { confirm = false; }, mutateDuringConfirmation(callback: () => Promise<void>) { duringConfirmation = callback; } };
}
const processSource = (uid: string, name: string, extra = '') => `ТипФайла: Процесс\nДанныеПроцесса:\n    UID: ${uid}\n    Имя: ${name}\n    Код: '001'\nШагиПроцесса:\n${extra}`;
const scenarioSource = (name: string, extra = '') => `ДанныеСценария:\n    UID: ${name}\n    Имя: ${name}\n    Код: '001'\n${extra}`;
const sidecarSource = (kind: 'scenario' | 'process' | 'feature', uid?: string) => JSON.stringify({
    version: 2, identity: { kind, ...(uid ? { uid } : {}) }, metadata: { description: 'Shared description' }
});

test('process deletion reviews and trashes its bound adjacent metadata with its settings', async t => {
    const h = await harness(t);
    const target = await h.write('Process/process.yaml', processSource('one', 'One'));
    const metadata = await h.write('Process/process.yaml.kot.yml', sidecarSource('process', 'one'));
    const settings = await h.write('Process/settings.yaml', 'ТипФайла: НастройкаПроцесса\nДанныеТеста:\n    UIDПроцесса: one\n');
    await h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: target.toString() });
    assert.deepEqual(h.deleted.map(item => item.uri).sort(), [target, metadata, settings].map(item => item.toString()).sort());
    assert.ok(h.deleted.every(item => item.useTrash && !item.recursive));
    assert.ok(h.confirmations[0].detail.includes(metadata.fsPath));
});

test('nested and standalone deletion include adjacent metadata without removing siblings', async t => {
    for (const kind of ['scenario', 'feature'] as const) {
        const h = await harness(t);
        const filename = kind === 'scenario' ? 'Nested/scen.yaml' : 'Features/run.feature';
        const target = await h.write(filename, kind === 'scenario' ? scenarioSource('Nested') : 'Feature: Run\nScenario: Run\n    Given ready\n');
        const metadata = await h.write(`${filename}.kot.yml`, sidecarSource(kind, kind === 'scenario' ? 'nested' : undefined));
        const sibling = await h.write(`${path.dirname(filename)}/keep.txt`, 'keep');
        if (kind === 'scenario') { await h.api.deleteScenarioDefinition(h.context, { name: 'Nested', uri: target.toString() }); }
        else { await h.api.deleteStandaloneFeature(target, 'Run'); }
        assert.deepEqual(h.deleted.map(item => item.uri), [target.toString(), metadata.toString()]);
        assert.ok(h.confirmations[0].detail.includes(metadata.fsPath));
        assert.equal(await fs.readFile(sibling.fsPath, 'utf8'), 'keep');
    }
});

test('main folder deletion covers its sidecar and blocks an unsaved metadata buffer', async t => {
    for (const dirty of [false, true]) {
        const h = await harness(t);
        const target = await h.write('Main/scen.yaml', scenarioSource('Main', 'KOTМетаданные:\n    PhaseSwitcher:\n        Tab: Smoke\n'));
        const metadata = await h.write('Main/scen.yaml.kot.yml', sidecarSource('scenario', 'main'));
        if (dirty) {
            const document = await h.open(metadata); document.isDirty = true; document.text += '\n# unsaved';
            await assert.rejects(() => h.api.deleteScenarioDefinition(h.context, { name: 'Main', uri: target.toString() }), /modified/iu);
            assert.deepEqual(h.deleted, []);
        } else {
            await h.api.deleteScenarioDefinition(h.context, { name: 'Main', uri: target.toString() });
            assert.deepEqual(h.deleted, [{ uri: h.uri(path.dirname(target.fsPath)).toString(), recursive: true, useTrash: true }]);
            assert.equal(await fs.readFile(path.join(h.root, '.trash', '1-Main', 'scen.yaml.kot.yml'), 'utf8'), sidecarSource('scenario', 'main'));
        }
    }
});

test('adjacent metadata changes and newly dirty metadata prevent deletion after confirmation', async t => {
    for (const kind of ['process', 'feature'] as const) {
        for (const mutation of ['dirty', 'disk', 'version', 'created'] as const) {
            const h = await harness(t);
            const filename = kind === 'process' ? 'process.yaml' : 'run.feature';
            const target = await h.write(filename, kind === 'process' ? processSource('one', 'One') : 'Feature: Run\nScenario: Run\n    Given ready\n');
            const metadata = mutation === 'created' ? h.uri(`${target.fsPath}.kot.yml`)
                : await h.write(`${filename}.kot.yml`, sidecarSource(kind, kind === 'process' ? 'one' : undefined));
            const document = mutation === 'dirty' || mutation === 'version' ? await h.open(metadata) : undefined;
            h.mutateDuringConfirmation(async () => {
                if (document && mutation === 'version') { document.version++; }
                else if (document) { document.isDirty = true; document.text += '\n# unsaved'; }
                else if (mutation === 'created') { await fs.writeFile(metadata.fsPath, sidecarSource(kind, kind === 'process' ? 'one' : undefined)); }
                else { await fs.appendFile(metadata.fsPath, '\n# edited'); }
            });
            const action = () => kind === 'process' ? h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: target.toString() })
                : h.api.deleteStandaloneFeature(target, 'Run');
            await assert.rejects(action, /modified|changed/iu);
            assert.deepEqual(h.deleted, []);
        }
    }
});

test('unsaved adjacent metadata prevents the deletion prompt for a process or standalone feature', async t => {
    for (const kind of ['process', 'feature'] as const) {
        const h = await harness(t);
        const filename = kind === 'process' ? 'process.yaml' : 'run.feature';
        const target = await h.write(filename, kind === 'process' ? processSource('one', 'One') : 'Feature: Run\nScenario: Run\n    Given ready\n');
        const metadata = await h.write(`${filename}.kot.yml`, sidecarSource(kind, kind === 'process' ? 'one' : undefined));
        const document = await h.open(metadata); document.isDirty = true; document.text += '\n# unsaved';
        const action = () => kind === 'process' ? h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: target.toString() })
            : h.api.deleteStandaloneFeature(target, 'Run');
        await assert.rejects(action, /modified/iu);
        assert.deepEqual(h.deleted, []);
        assert.deepEqual(h.confirmations, []);
    }
});

test('a coincident sidecar with invalid or unrelated identity is never deleted', async t => {
    for (const source of [sidecarSource('scenario', 'one'), sidecarSource('process', 'different'),
        '{"version": 3}', 'unrelated: file']) {
        const h = await harness(t);
        const target = await h.write('one.yaml', processSource('one', 'One'));
        const metadata = await h.write('one.yaml.kot.yml', source);
        await assert.rejects(() => h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: target.toString() }), /identity|metadata|version|document/iu);
        assert.deepEqual(h.deleted, []);
        assert.equal(await fs.readFile(metadata.fsPath, 'utf8'), source);
    }
});

test('deleting a relocated source recognizes a legacy sidecar by its matching UID and physical location', async t => {
    const h = await harness(t);
    const target = await h.write('Moved/process.yaml', processSource('one', 'One'));
    const metadata = await h.write('Moved/process.yaml.kot.yml', JSON.stringify({ version: 1,
        identity: { kind: 'process', uid: 'ONE', relativePath: 'Old/process.yaml' }, metadata: { description: 'Moved description' } }));
    await h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: target.toString() });
    assert.deepEqual(h.deleted.map(item => item.uri), [target.toString(), metadata.toString()]);
});

test('process deletion trashes exactly the descriptor and UID-linked settings, preserving siblings', async t => {
    const h = await harness(t);
    const process = await h.write('process.yaml', processSource('one', 'One'));
    const settings = await h.write('settings.yaml', 'ТипФайла: НастройкаПроцесса\nДанныеТеста:\n    UIDПроцесса: one\n');
    const other = await h.write('other.yaml', processSource('two', 'Two'));
    assert.equal(typeof h.api.deleteScenarioDefinition, 'function');
    const result = await h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: process.toString() });
    assert.ok(result);
    assert.deepEqual(h.deleted.map(item => item.uri).sort(), [process.toString(), settings.toString()].sort());
    assert.ok(h.deleted.every(item => item.useTrash === true && item.recursive === false));
    assert.equal(await fs.readFile(other.fsPath, 'utf8'), processSource('two', 'Two'));
});

test('process deletion refuses incoming process calls without removing the caller or settings', async t => {
    const h = await harness(t);
    const target = await h.write('one.yaml', processSource('one', 'One'));
    await h.write('parent.yaml', processSource('parent', 'Parent', '    - ШагиПроцесса1:\n        ТипШага: "1"\n        ВложенныйПроцессUID: one\n        ВложенныйПроцессНаименование: One\n'));
    await assert.rejects(() => h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: target.toString() }), /referenced/iu);
    assert.deepEqual(h.deleted, []);
    assert.equal(await fs.readFile(target.fsPath, 'utf8'), processSource('one', 'One'));
});

test('deletion revalidates dirty files and saved source changes after confirmation', async t => {
    for (const mutation of ['dirty', 'disk'] as const) {
        const h = await harness(t);
        const target = await h.write(`case-${mutation}/one.yaml`, processSource('one', 'One'));
        const document = await h.open(target);
        h.mutateDuringConfirmation(async () => {
            if (mutation === 'dirty') { document.isDirty = true; document.text += '# unsaved\n'; }
            else { await fs.appendFile(target.fsPath, '# changed\n'); }
        });
        await assert.rejects(() => h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: target.toString() }), /modified|changed/iu);
        assert.deepEqual(h.deleted, []);
    }
});

test('exact identity and cancellation prevent deletion even when a name exists elsewhere', async t => {
    const h = await harness(t); const target = await h.write('one.yaml', processSource('one', 'One'));
    await assert.rejects(() => h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: h.uri(path.join(h.root, 'missing.yaml')).toString() }), /stale|found/iu);
    h.cancel(); assert.equal(await h.api.deleteScenarioDefinition(h.context, { name: 'One', uri: target.toString() }), undefined);
    assert.deepEqual(h.deleted, []);
});

test('main deletion trashes only its folder; nested deletion trashes only its own YAML', async t => {
    const h = await harness(t);
    const main = await h.write('Main/scen.yaml', scenarioSource('Main', 'KOTМетаданные:\n    PhaseSwitcher:\n        Tab: Smoke\n'));
    await h.write('Main/test.yaml', 'settings'); const nested = await h.write('Nested/scen.yaml', scenarioSource('Nested'));
    await h.write('Nested/sibling.txt', 'keep');
    await h.api.deleteScenarioDefinition(h.context, { name: 'Main', uri: main.toString() });
    await h.api.deleteScenarioDefinition(h.context, { name: 'Nested', uri: nested.toString() });
    assert.equal(h.deleted[0].uri, h.uri(path.dirname(main.fsPath)).toString()); assert.equal(h.deleted[0].recursive, true);
    assert.equal(h.deleted[1].uri, nested.toString()); assert.equal(await fs.readFile(path.join(h.root, 'Nested/sibling.txt'), 'utf8'), 'keep');
});

const exportContext = { sourceUri: 'file:///local/exports.feature', workspaceFolderUri: 'file:///local', profileId: 'default', libraryRootUri: 'file:///local', sourceLabel: 'Local', defaultLanguage: 'en' as const };
test('export deletion removes one scenario and its metadata while keeping adjacent tags and docstring declarations', async t => {
    const h = await harness(t);
    const source = '#language: en\r\n@ExportScenarios\r\nFeature: Library\r\n\r\n@First\r\n@exampleofuse: Given first\r\nScenario: first\r\n    Given ready\r\n    """\r\nScenario: inside string\r\n    """\r\n\r\n@Second\r\n# second description\r\nScenario: second\r\n    Given ready\r\n';
    const id = parser.parseExportScenarios(source, exportContext).definitions[0].id;
    assert.equal(typeof h.api.planExportScenarioDeletion, 'function');
    const plan = h.api.planExportScenarioDeletion({ ...exportContext, text: source }, id);
    assert.equal(plan.after, '#language: en\r\n@ExportScenarios\r\nFeature: Library\r\n\r\n@Second\r\n# second description\r\nScenario: second\r\n    Given ready\r\n');
    assert.throws(() => h.api.planExportScenarioDeletion({ ...exportContext, text: source.replace('Scenario: first', 'Scenario: renamed') }, id), /changed/iu);
});

test('unsaved callers also prevent nested definition deletion', async t => {
    const h = await harness(t); const target = await h.write('target.yaml', scenarioSource('Nested'));
    const caller = await h.write('caller.yaml', scenarioSource('Caller'));
    const document = await h.open(caller);
    document.isDirty = true;
    document.text += 'ВложенныеСценарии:\n    - ВложенныеСценарии1:\n        ИмяСценария: Nested\n';
    await assert.rejects(() => h.api.deleteScenarioDefinition(h.context, { name: 'Nested', uri: target.toString() }), /referenced|modified/iu);
    assert.deepEqual(h.deleted, []);
});

async function exportHarness(t: test.TestContext) {
    const h = await harness(t);
    const source = '#language: en\n@ExportScenarios\nFeature: Exports\nScenario: first\n    Given ready\nScenario: second\n    Given ready\n';
    const target = await h.write('exports.feature', source);
    const context = { ...exportContext, sourceUri: target.toString() };
    const parsed = parser.parseExportScenarios(source, context);
    const references: any[] = [];
    const resolver = { getView: async () => {
        const current = parser.parseExportScenarios(await fs.readFile(target.fsPath, 'utf8'), context);
        return { all: current.definitions, byId: new Map(current.definitions.map(item => [item.id, item])) };
    } };
    return { ...h, source, target, definition: parsed.definitions[0], resolver, references,
        referenceService: { findReferences: async () => references } };
}

test('export deletion succeeds if a clean source is opened during reference collection', async t => {
    const h = await exportHarness(t);
    h.referenceService.findReferences = async () => { await h.open(h.target); return []; };
    assert.equal(await h.api.deleteExportScenario(h.definition.id, h.target, h.resolver, h.referenceService, h.definition.definitionLocation), true);
    assert.equal(await fs.readFile(h.target.fsPath, 'utf8'), '#language: en\n@ExportScenarios\nFeature: Exports\nScenario: second\n    Given ready\n');
    assert.deepEqual(h.deleted, []);
});

test('deleting an export block preserves its shared feature metadata beside the remaining blocks', async t => {
    const h = await exportHarness(t);
    const source = sidecarSource('feature');
    const metadata = await h.write('exports.feature.kot.yml', source);
    assert.equal(await h.api.deleteExportScenario(h.definition.id, h.target, h.resolver, h.referenceService), true);
    assert.equal(await fs.readFile(metadata.fsPath, 'utf8'), source);
    assert.deepEqual(h.deleted, []);
    assert.ok((await fs.readFile(h.target.fsPath, 'utf8')).includes('Scenario: second'));
});

test('export deletion rejects references introduced while confirmation is open', async t => {
    const h = await exportHarness(t);
    h.mutateDuringConfirmation(async () => {
        h.references.push({ uri: h.uri(path.join(h.root, 'caller.feature')), range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } } });
    });
    await assert.rejects(() => h.api.deleteExportScenario(h.definition.id, h.target, h.resolver, h.referenceService), /referenced/iu);
    assert.equal(await fs.readFile(h.target.fsPath, 'utf8'), h.source);
});

test('read-only catalog definitions cannot delete their physical source', async t => {
    const h = await exportHarness(t);
    for (const kind of ['builtInStep', 'userStep']) {
        const definition = { ...h.definition, kind };
        const resolver = { getView: async () => ({ all: [definition], byId: new Map([[definition.id, definition]]) }) };
        assert.equal(await h.api.deleteExportScenario(definition.id, h.target, resolver, h.referenceService), false);
    }
    assert.equal(await fs.readFile(h.target.fsPath, 'utf8'), h.source); assert.deepEqual(h.deleted, []);
});

test('standalone deletion keeps launch JSON and other features and refuses an export library', async t => {
    const h = await harness(t);
    const target = await h.write('standalone.feature', 'Feature: Standalone\nScenario: Run\n    Given ready\n');
    const json = await h.write('standalone.json', '{"featurepath":"standalone.feature"}');
    const other = await h.write('other.feature', 'Feature: Other\n');
    assert.equal(await h.api.deleteStandaloneFeature(target, 'Standalone'), true);
    assert.equal(await fs.readFile(json.fsPath, 'utf8'), '{"featurepath":"standalone.feature"}');
    assert.equal(await fs.readFile(other.fsPath, 'utf8'), 'Feature: Other\n');
    assert.equal(h.deleted[0].uri, target.toString()); assert.equal(h.deleted[0].useTrash, true);
    const library = await h.write('library.feature', '@ExportScenarios\nFeature: Library\nScenario: Reusable\n    Given ready\n');
    await assert.rejects(() => h.api.deleteStandaloneFeature(library), /changed/iu);
    assert.equal(h.deleted.length, 1);
});

test('export deletion preserves a following Rule container and its scenario', async t => {
    const h = await harness(t);
    const source = '#language: en\n@ExportScenarios\nFeature: Exports\nRule: First\n    Scenario: first\n        Given ready\n\nRule: Second\n    @Keep\n    Scenario: second\n        Given ready\n';
    const id = parser.parseExportScenarios(source, exportContext).definitions[0].id;
    const plan = h.api.planExportScenarioDeletion({ ...exportContext, text: source }, id);
    assert.equal(plan.after, '#language: en\n@ExportScenarios\nFeature: Exports\nRule: First\n\nRule: Second\n    @Keep\n    Scenario: second\n        Given ready\n');
});

test('nested deletion also refuses feature callers discovered by shared definition references', async t => {
    const h = await harness(t); const target = await h.write('nested.yaml', scenarioSource('Nested'));
    const definition = { id: target.toString(), kind: 'nestedScenario', definitionLocation: { uri: target.toString() } };
    const services = { resolver: { getView: async () => ({ all: [definition] }) }, references: {
        findReferencesForDefinitions: async () => new Map([[definition.id, [{ uri: h.uri(path.join(h.root, 'caller.feature')) }]]])
    } };
    await assert.rejects(() => h.api.deleteScenarioDefinition(h.context, { name: 'Nested', uri: target.toString() }, services), /referenced/iu);
    assert.deepEqual(h.deleted, []);
});

test('export deletion considers unsaved feature callers as well as the complete saved scan', async t => {
    const h = await exportHarness(t);
    const referenceService = { findReferences: async (_id: string, _resource: any, options: any) => options.failOnScanError ? [] : [
        { uri: h.uri(path.join(h.root, 'dirty-caller.feature')), range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } } }
    ] };
    await assert.rejects(() => h.api.deleteExportScenario(h.definition.id, h.target, h.resolver, referenceService), /referenced/iu);
    assert.equal(await fs.readFile(h.target.fsPath, 'utf8'), h.source);
});
