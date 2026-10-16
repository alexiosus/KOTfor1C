import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import * as descriptor from '../src/scenarioDescriptor';
import * as metadata from '../src/projectLibraryMetadata';
import { projectEntityKey, waitForProjectLibraryIdle } from '../src/projectLibraryStore';
import { parseDocument } from 'yaml';
import type { TestInfo } from '../src/types';

function uri(fsPath: string) {
    return { fsPath, scheme: 'file', toString: () => pathToFileURL(fsPath).toString() };
}

function harness(root: string, external = path.join(root, 'tests'), waitForIdle = waitForProjectLibraryIdle) {
    const documents: Array<{ uri: ReturnType<typeof uri>; isDirty: boolean }> = [];
    const opened: string[] = [];
    const watchers: Array<{ pattern: string; root: string; disposed: boolean; create?: () => void; change?: () => void; delete?: () => void }> = [];
    let rootsChanged: (() => void) | undefined;
    let foldersChanged: (() => void) | undefined;
    const disposable = () => ({ dispose() {} });
    const host = {
        Uri: { file: uri },
        RelativePattern: class { constructor(readonly base: ReturnType<typeof uri>, readonly pattern: string) {} },
        workspace: {
            workspaceFolders: [{ uri: uri(root) }], textDocuments: documents,
            openTextDocument: async (target: ReturnType<typeof uri>) => ({ uri: target, getText: () => fs.readFileSync(target.fsPath, 'utf8') }),
            onDidChangeWorkspaceFolders: (callback: () => void) => { foldersChanged = callback; return disposable(); },
            createFileSystemWatcher: (pattern: { base: ReturnType<typeof uri>; pattern: string }) => {
                const state: (typeof watchers)[number] = { pattern: pattern.pattern, root: pattern.base.fsPath, disposed: false };
                watchers.push(state);
                return {
                    dispose: () => { state.disposed = true; },
                    onDidCreate: (callback: () => void) => { state.create = callback; return disposable(); },
                    onDidChange: (callback: () => void) => { state.change = callback; return disposable(); },
                    onDidDelete: (callback: () => void) => { state.delete = callback; return disposable(); }
                };
            }
        },
        window: { showTextDocument: async (document: { uri: ReturnType<typeof uri> }) => { opened.push(document.uri.fsPath); } },
        l10n: { t: (message: string) => message }
    };
    const dependencies: Record<string, unknown> = {
        vscode: host, 'node:path': path,
        './scenarioDescriptor': descriptor, './projectLibraryMetadata': metadata,
        './projectLibraryStore': { waitForProjectLibraryIdle: waitForIdle },
        './scenarioScanRoot': {
            resolveScenarioScanRootFsPath: () => external,
            resolveProcessScanRootFsPath: () => external,
            onDidChangeScenarioScanRoot: (callback: () => void) => { rootsChanged = callback; return disposable(); }
        }
    };
    const ts = require('typescript') as typeof import('typescript');
    const module = { exports: {} as typeof import('../src/projectLibraryIntegration') };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/projectLibraryIntegration.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name], console, process, setTimeout, clearTimeout });
    return { api: module.exports, documents, opened, watchers,
        changeRoots: () => rootsChanged?.(), changeFolders: () => foldersChanged?.() };
}

test('dirty adjacent metadata and central groups block writes, while source and other project editors do not', () => {
    const h = harness('/repo');
    for (const file of ['/repo/tests/scen.yaml.kot.yml', '/repo/tests/UPPER.yaml.KOT.YML', '/repo/.kot/groups.yml']) {
        h.documents.splice(0, h.documents.length, { uri: uri(file), isDirty: true });
        assert.throws(() => h.api.assertProjectMetadataSaved('/repo'), /Save project metadata/);
    }
    h.documents.splice(0, h.documents.length,
        { uri: uri('/repo/tests/scen.yaml'), isDirty: true },
        { uri: uri('/repo/tests/scen.yaml.kot.yml'), isDirty: false },
        { uri: uri('/repo-other/tests/scen.yaml.kot.yml'), isDirty: true });
    assert.doesNotThrow(() => h.api.assertProjectMetadataSaved('/repo'));
});

test('metadata watcher coalesces migration events until the active transaction finishes', async t => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const h = harness('/repo', '/repo/tests', () => pending);
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    t.after(() => context.subscriptions.forEach(value => value.dispose()));
    let refreshes = 0;
    h.api.watchProjectLibrary(context as any, () => { refreshes++; });
    h.watchers[0].change?.();
    await new Promise(resolve => setTimeout(resolve, 130));
    h.watchers[1].change?.(); h.watchers[0].create?.();
    assert.equal(refreshes, 0, 'do not read partially migrated metadata');
    release();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(refreshes, 1, 'one refresh covers all files written by the transaction');
});

test('ordering guards only the affected source editors while metadata edits remain independently guarded', () => {
    const h = harness('/repo');
    h.documents.push({ uri: uri('/repo/tests/a.yaml'), isDirty: true }, { uri: uri('/repo/tests/b.feature'), isDirty: true });
    assert.throws(() => (h.api as any).assertProjectOrderingSourcesSaved(['/repo/tests/a.yaml']), /Save changed test sources/u);
    assert.throws(() => (h.api as any).assertProjectOrderingSourcesSaved(['/repo/tests/b.feature']), /Save changed test sources/u);
    assert.doesNotThrow(() => (h.api as any).assertProjectOrderingSourcesSaved(['/repo/tests/c.yaml']));
});

test('Git sidecar and group changes refresh both owning roots and reconfigure watches with project roots', async t => {
    const h = harness('/repo', '/external-tests');
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    t.after(() => context.subscriptions.forEach(value => value.dispose()));
    let refreshes = 0;
    h.api.watchProjectLibrary(context as Parameters<typeof h.api.watchProjectLibrary>[0], () => { refreshes++; });
    assert.deepEqual(h.watchers.map(value => [value.root, value.pattern]), [
        ['/repo', '.kot/**/*.{yaml,yml}'], ['/repo', '**/*.kot.yml'],
        ['/external-tests', '.kot/**/*.{yaml,yml}'], ['/external-tests', '**/*.kot.yml']
    ]);
    h.watchers[0].change?.(); h.watchers[1].create?.(); h.watchers[3].delete?.();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(refreshes, 1);
    h.changeRoots();
    assert.ok(h.watchers.slice(0, 4).every(value => value.disposed));
    h.changeFolders();
    assert.ok(h.watchers.slice(4, 8).every(value => value.disposed));
});

test('opening scenario metadata creates and opens its adjacent file without altering source YAML', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-meta-editor-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'tests/scen.yaml');
    const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Sales\n    UID: sales\nТекстСценария: |\n    And I open a Sales form\n';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, source);
    const h = harness(root);
    await h.api.openProjectMetadata(uri(file) as Parameters<typeof h.api.openProjectMetadata>[0]);
    assert.deepEqual(h.opened, [`${file}.kot.yml`]);
    assert.equal(await fsp.readFile(file, 'utf8'), source);
    assert.match(await fsp.readFile(`${file}.kot.yml`, 'utf8'), /version: 2/);
});

for (const groupName of ['Sales tests', '']) {
    test(`created main scenario retains classification and ordering with ${groupName ? 'a named' : 'an empty'} group`, async t => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-created-main-'));
        t.after(() => fsp.rm(root, { recursive: true, force: true }));
        const file = path.join(root, 'tests/scen.yaml');
        const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Sales\n    UID: sales\nТекстСценария: |\n    And I open a Sales form\n';
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, source);
        const h = harness(root);
        await h.api.registerCreatedProjectScenario(uri(file) as Parameters<typeof h.api.registerCreatedProjectScenario>[0], source,
            { main: true, groupName, order: 7 });
        const document = { uri: uri(file), getText: () => source };
        assert.equal(h.api.projectedProjectScenario(document as Parameters<typeof h.api.projectedProjectScenario>[0])?.tabName, groupName || 'Ungrouped');
        assert.equal(h.api.projectedProjectScenario(document as Parameters<typeof h.api.projectedProjectScenario>[0])?.order, 7);
        const record = parseDocument(await fsp.readFile(`${file}.kot.yml`, 'utf8')).toJS();
        assert.ok(Object.hasOwn(record.metadata, 'groupId'));
        assert.equal(await fsp.readFile(file, 'utf8'), source);
        await h.api.persistProjectMetadata(document as Parameters<typeof h.api.persistProjectMetadata>[0], { category: 'Reporting', description: 'Shared description' });
        const projected = h.api.projectedProjectScenario(document as Parameters<typeof h.api.projectedProjectScenario>[0]);
        assert.equal(projected?.tabName, groupName || 'Ungrouped');
        assert.equal(projected?.order, 7);
        assert.equal(projected?.scenarioCategory, 'Reporting');
        assert.equal(projected?.scenarioDescription, 'Shared description');
    });
}

test('created nested category lives in the sidecar without introducing a main group and removes migrated inline data', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-created-nested-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'tests/scen.yaml');
    const source = 'ДанныеСценария:\n    Имя: Nested\n    UID: nested\nKOTМетаданные:\n    Описание: Authored description\n    Категория: Legacy category\nТекстСценария: |\n    And I open a form\n';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, source);
    const h = harness(root);
    await h.api.registerCreatedProjectScenario(uri(file) as Parameters<typeof h.api.registerCreatedProjectScenario>[0], source, { category: 'Reporting' });
    const projected = h.api.projectedProjectScenario({ uri: uri(file), getText: () => source } as Parameters<typeof h.api.projectedProjectScenario>[0]);
    assert.equal(projected?.tabName, undefined);
    assert.equal(projected?.scenarioCategory, 'Reporting');
    assert.equal(projected?.scenarioDescription, 'Authored description');
    assert.equal(await fsp.readFile(file, 'utf8'), source.replace('KOTМетаданные:\n    Описание: Authored description\n    Категория: Legacy category\n', ''));
    const record = parseDocument(await fsp.readFile(`${file}.kot.yml`, 'utf8')).toJS();
    assert.equal(Object.hasOwn(record.metadata, 'groupId'), false);
});

test('single-source reads guard automatic central migration against unsaved sidecars', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-meta-editor-migration-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'tests/scen.yaml');
    const identity = { kind: 'scenario' as const, uid: 'sales', relativePath: 'tests/scen.yaml' };
    const record = path.join(root, '.kot/metadata', `${createHash('sha256').update(projectEntityKey(identity)).digest('hex')}.yml`);
    const central = 'version: 1\nidentity:\n  kind: scenario\n  uid: sales\n  relativePath: tests/scen.yaml\nmetadata:\n  description: Shared sales\n';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'ДанныеСценария:\n    Имя: Sales\n    UID: sales\n');
    await fsp.mkdir(path.dirname(record), { recursive: true });
    await fsp.writeFile(record, central);
    const h = harness(root);
    const info = { name: 'Sales', uid: 'sales', yamlFileUri: uri(file), relativePath: 'tests' } as TestInfo;
    h.documents.push({ uri: uri(`${file}.kot.yml`), isDirty: true });
    await assert.rejects(h.api.loadSingleProjectScenario(info), /Save project metadata/);
    assert.equal(await fsp.readFile(record, 'utf8'), central);
    await assert.rejects(fsp.stat(`${file}.kot.yml`), { code: 'ENOENT' });
    h.documents.length = 0;
    assert.equal((await h.api.loadSingleProjectScenario(info)).scenarioDescription, 'Shared sales');
    await assert.rejects(fsp.stat(record), { code: 'ENOENT' });
    assert.match(await fsp.readFile(`${file}.kot.yml`, 'utf8'), /Shared sales/);
});
