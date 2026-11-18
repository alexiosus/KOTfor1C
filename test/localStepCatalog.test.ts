import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findLocalStepCategoryEpfs, generateLocalStepCatalog, localStepCatalogNeedsUpgrade, resolveLocalStepCatalog } from '../src/localStepCatalog';
import { StepCatalogService } from '../src/stepCatalogService';
import { withLocalStepTemplate } from '../src/localStepCatalogDump';
import { ProjectDefinitionResolver } from '../src/projectDefinitionResolver';
import { buildProjectDefinitionSnapshot } from '../src/projectDefinitionIndex';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import { StepLibrarySnapshotService } from '../src/stepLibrarySnapshotService';

async function localSource(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-local-steps-'));
    const directory = path.join(root, 'locales', 'Steps', 'Templates', 'en', 'Ext');
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile('test/fixtures/step-catalog/Template.xml', path.join(directory, 'Template.xml'));
    return root;
}

test('offline generation uses local translations, preserves descriptions and fingerprints the input', async () => {
    const root = await localSource();
    const one = await generateLocalStepCatalog(root, '1.2.043.47');
    const two = await generateLocalStepCatalog(root, '1.2.043.47');
    assert.equal(one.steps.length, 2);
    assert.equal(one.steps[0].en?.description, 'Checks value & title');
    assert.equal(one.source.kind, 'local');
    assert.equal(one.source.sha256, two.source.sha256);
    const resolved = resolveLocalStepCatalog(JSON.stringify(one), '1.2.043.47');
    assert.equal(resolved.source, 'local'); assert.equal(resolved.steps.length, 2);
    assert.throws(() => resolveLocalStepCatalog(JSON.stringify(one), '1.2.043.45'));
    assert.throws(() => resolveLocalStepCatalog(JSON.stringify({ ...one, steps: [{ ...one.steps[0], id: '0'.repeat(64) }] })));
    const signal = AbortSignal.abort();
    await assert.rejects(generateLocalStepCatalog(root, '1.2.043.47', signal));
});

test('the configured local catalog is used on load and refresh without network requests', async t => {
    const catalog = await generateLocalStepCatalog(await localSource(), '1.2.043.47');
    const content = new TextEncoder().encode(JSON.stringify(catalog));
    let network = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { network++; throw new Error('Offline'); };
    t.after(() => { globalThis.fetch = original; });
    const folder = { uri: { fsPath: 'C:/Own', toString: () => 'file:///C:/Own' } };
    const api = {
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        Uri: { file: (fsPath: string) => ({ fsPath }), parse: () => folder.uri }, window: {},
        workspace: { workspaceFolders: [folder], getWorkspaceFolder: () => folder,
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'steps.catalogMode' ? 'offline' : key === 'steps.localCatalogPath' ? 'catalog.json' : fallback }),
            onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
            fs: { readFile: async () => content, stat: async () => ({}) } }
    };
    const service = new StepCatalogService({ globalStorageUri: folder.uri } as any, api as any);
    t.after(() => service.dispose());
    const first = await service.getCatalog();
    assert.equal(first.source, 'local');
    assert.equal(await service.getCatalog(), first, 'unchanged local catalogs retain compiled definition caches');
    assert.equal((await service.refresh())[0].source, 'local');
    assert.equal(network, 0);
});

test('ordinary distributions export translations and step categories through one isolated temporary IB', async () => {
    const root = await localSource(); const calls: readonly string[][] = [];
    let work = '';
    const result = await withLocalStepTemplate(path.join(root, 'Steps.epf'), '1cv8', async (args, directory) => {
        work = directory; (calls as string[][]).push([...args]);
        if (args[5] === path.join(root, 'Steps.epf')) {
            const template = path.join(args[4], 'Templates', 'en', 'Ext');
            await fs.mkdir(template, { recursive: true });
            await fs.copyFile('test/fixtures/step-catalog/Template.xml', path.join(template, 'Template.xml'));
        } else if (args[0] === 'DESIGNER') {
            await fs.mkdir(path.join(args[4], 'Ext'), { recursive: true });
            await fs.writeFile(path.join(args[4], 'Ext', 'ObjectModule.bsl'),
                'Процедура Регистрация()\nДобавитьШагВМассивТестов(ВсеТесты, "Check()", "Check", "И поле <Имя> равно ""Значение""", "", "Файлы");\nКонецПроцедуры');
        }
        return { exitCode: 0, stdout: '', stderr: '', cancelled: false };
    }, { isCancellationRequested: false }, (template, sources) => generateLocalStepCatalog(root, '1.2.043.47', undefined, template, [sources]),
    [path.join(root, 'Steps.epf'), path.join(root, 'Library.epf')]);
    assert.equal(result?.steps.length, 2);
    assert.equal(calls[0][0], 'CREATEINFOBASE');
    assert.equal(calls[1][0], 'DESIGNER');
    assert.ok(calls[1].includes('/DumpExternalDataProcessorOrReportToFiles'));
    assert.equal(calls.length, 3, 'Steps.epf is exported once and the category module shares its temporary IB');
    assert.deepEqual(result?.steps[0].categoryPath, { ru: ['Файлы'], en: ['Files'] });
    assert.equal(await fs.stat(work).then(() => true, () => false), false);
    assert.equal((await fs.stat(root)).isDirectory(), true);
});

test('source distributions and compiled libraries produce identical localized categories and stable fingerprints', async () => {
    const root = await localSource(); const exported = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-category-source-'));
    const module = 'Процедура Регистрация()\nДобавитьШагВМассивТестов(ВсеТесты, "Check()", "Check", "И поле <Имя> равно ""Значение""", "", "Файлы");\nКонецПроцедуры';
    await fs.writeFile(path.join(root, 'Library.bsl'), module);
    const online = await generateLocalStepCatalog(root, '1.2.043.47');
    await fs.rename(path.join(root, 'Library.bsl'), path.join(exported, 'Library.bsl'));
    const offline = await generateLocalStepCatalog(root, '1.2.043.47', undefined, undefined, [exported]);
    assert.deepEqual(offline.steps, online.steps);
    const moved = `${exported}-moved`; await fs.rename(exported, moved);
    const repeated = await generateLocalStepCatalog(root, '1.2.043.47', undefined, undefined, [moved]);
    assert.equal(repeated.source.sha256, offline.source.sha256, 'temporary export paths do not affect the fingerprint');
});

test('category extraction skips EPFs with existing sources and includes compiled libraries', async () => {
    const root = await localSource();
    await fs.writeFile(path.join(root, 'Compiled.epf'), 'compiled');
    await fs.writeFile(path.join(root, 'Sources.epf'), 'compiled');
    await fs.mkdir(path.join(root, 'Sources'));
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'Ignored.epf'), 'ignored');
    assert.deepEqual(await findLocalStepCategoryEpfs(root), [path.join(root, 'Compiled.epf')]);
});

async function offlineService(t: test.TestContext, fail = false, invalid = false, initialMode = 'offline') {
    const content = new TextEncoder().encode(JSON.stringify(await generateLocalStepCatalog(await localSource(), '1.2.043.47')));
    const files = new Map<string, Uint8Array>(); let mode = initialMode; let local = ''; let builds = 0; let network = 0;
    let configurationChanged!: (event: { affectsConfiguration(section: string): boolean }) => void;
    class Uri {
        constructor(readonly fsPath: string) {}
        toString() { return this.fsPath; }
        static file(value: string) { return new Uri(path.resolve(value)); }
        static parse(value: string) { return new Uri(value); }
    }
    const folder = { uri: Uri.file('offline-project') }; const target = Uri.file(path.join(folder.uri.fsPath, 'generated.json')).fsPath;
    if (invalid) { files.set(target, new TextEncoder().encode('{invalid')); local = target; }
    const configuration = { get: (key: string, fallback: unknown) => key === 'steps.catalogMode' ? mode : key === 'steps.localCatalogPath' ? local : fallback };
    const api = {
        EventEmitter: class {
            listeners = new Set<(event: any) => void>();
            event = (listener: (event: any) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
            fire(event: unknown) { for (const listener of this.listeners) { listener(event); } }
            dispose() { this.listeners.clear(); }
        }, Uri, window: {},
        workspace: { workspaceFolders: [folder],
            getWorkspaceFolder: (resource: Uri) => { assert.ok(resource instanceof Uri, 'VS Code requires a complete URI'); return folder; },
            getConfiguration: (_section: string, resource: Uri) => { assert.ok(resource instanceof Uri, 'VS Code requires a complete URI'); return configuration; },
            onDidChangeConfiguration: (listener: typeof configurationChanged) => { configurationChanged = listener; return { dispose() {} }; }, onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
            fs: { stat: async (uri: Uri) => { if (!files.has(uri.fsPath)) { throw new Error('Missing'); } return {}; },
                readFile: async (uri: Uri) => { const value = files.get(uri.fsPath); if (!value) { throw new Error('Missing'); } return value; } } }
    };
    const service = new StepCatalogService({ globalStorageUri: folder.uri } as any, api as any, async (resource, report) => {
        assert.equal(resource, folder.uri);
        if (!files.has(target) || localStepCatalogNeedsUpgrade(new TextDecoder().decode(files.get(target)))) {
            builds++; await new Promise(resolve => setImmediate(resolve));
            report?.({ phase: 'exporting', completed: 1, total: 2 });
            if (fail) { throw new Error('No local VA'); }
            report?.({ phase: 'exporting', completed: 2, total: 2 }); files.set(target, content);
        }
        return target;
    });
    (service as any).coordinator.getCatalog = async () => { network++; return { source: 'network', identity: 'online' }; };
    (service as any).coordinator.refresh = async () => { network++; return [{ source: 'network', identity: 'online' }]; };
    t.after(() => service.dispose());
    return { service, files, target, folder, builds: () => builds, network: () => network,
        online: () => { mode = 'online'; }, useFile: (file: string) => { local = file; },
        enableOffline: () => { mode = 'offline'; configurationChanged({ affectsConfiguration: section => section === 'kotTestToolkit.steps.catalogMode' }); } };
}

test('offline catalogs load through the project resolver for IntelliSense and the Step Library', async t => {
    const h = await offlineService(t);
    const subscribe = () => ({ dispose() {} });
    const local = buildProjectDefinitionSnapshot({ configurationIdentity: 'offline', workspaceFolderUri: h.folder.uri.toString(),
        profileId: 'active', generation: 1, parserVersion: 'v1', files: [] });
    const scenarios = { getScenarioCatalog: () => buildScenarioCatalog([]), onDidUpdateScenarioCatalog: subscribe };
    const resolver = new ProjectDefinitionResolver({
        local: { getSnapshot: () => local, ensureReady: async () => local, onDidChangeSnapshot: subscribe },
        scenarios: scenarios as any, steps: h.service
    });
    const library = new StepLibrarySnapshotService({ resolver, scenarios: scenarios as any });
    t.after(() => { library.dispose(); resolver.dispose(); });
    const view = await resolver.getView(h.folder.uri as any);
    assert.ok(view.all.some(definition => definition.kind === 'builtInStep'));
    const snapshot = await library.ensureReady(h.folder.uri as any);
    assert.ok(snapshot.items.some(item => item.kind === 'builtInStep'));
    assert.equal(h.builds(), 1);
    assert.equal(h.network(), 0);
});

test('an existing legacy offline catalog is upgraded once without network access', async t => {
    const h = await offlineService(t); await h.service.getCatalog();
    const legacy = JSON.parse(new TextDecoder().decode(h.files.get(h.target)));
    delete legacy.source.generatorVersion;
    h.files.set(h.target, new TextEncoder().encode(JSON.stringify(legacy))); h.useFile(h.target);
    assert.equal((await h.service.getCatalog()).source, 'local');
    assert.equal((await h.service.getCatalog()).source, 'local');
    assert.equal(h.builds(), 2); assert.equal(h.network(), 0);
    assert.equal(localStepCatalogNeedsUpgrade(new TextDecoder().decode(h.files.get(h.target))), false);
});

test('offline mode generates a missing catalog once for concurrent requests and regenerates a removed file without networking', async t => {
    const h = await offlineService(t);
    const catalogs = await Promise.all(Array.from({ length: 5 }, () => h.service.getCatalog()));
    assert.ok(catalogs.every(catalog => catalog.source === 'local')); assert.equal(h.builds(), 1);
    await h.service.getCatalog(); assert.equal(h.builds(), 1);
    h.files.delete(h.target); await h.service.getCatalog(); assert.equal(h.builds(), 2); assert.equal(h.network(), 0);
});

test('offline catalog preparation exposes export counts and retains ready or failed state for the workspace page', async t => {
    const h = await offlineService(t); const events: any[] = [];
    h.service.onDidChangePreparation(event => events.push(event));
    await h.service.getCatalog();
    assert.deepEqual(events.map(event => event.progress), [
        { phase: 'exporting', completed: 1, total: 2 }, { phase: 'exporting', completed: 2, total: 2 },
        { phase: 'ready', stepCount: 2 }
    ]);
    assert.ok(events.every(event => event.workspaceFolderUri.toString() === h.folder.uri.toString()));
    assert.deepEqual(h.service.getPreparationState(h.folder.uri as any), { phase: 'ready', stepCount: 2 });
    await h.service.getCatalog(); assert.equal(events.length, 3, 'cached reads do not repeat completion events');
    const failed = await offlineService(t, true); await failed.service.getCatalog();
    assert.deepEqual(failed.service.getPreparationState(failed.folder.uri as any), { phase: 'error', error: 'No local VA' });
});

test('saving offline mode starts catalog generation and publishes progress without opening a library or requesting completion', async t => {
    const h = await offlineService(t, false, false, 'online'); const events: any[] = [];
    const ready = new Promise<void>(resolve => h.service.onDidChangePreparation(event => {
        events.push(event.progress); if (event.progress?.phase === 'ready') { resolve(); }
    }));
    assert.equal(h.builds(), 0); h.enableOffline(); await ready;
    assert.ok(events.some(event => event?.phase === 'exporting' && event.completed === 1));
    assert.equal(h.builds(), 1); assert.equal(h.network(), 0);
});

test('failed or invalid offline catalogs never fall back to the network', async t => {
    const failed = await offlineService(t, true);
    assert.equal((await failed.service.getCatalog()).source, 'unavailable');
    assert.equal((await failed.service.getCatalog()).source, 'unavailable'); assert.equal(failed.builds(), 1); assert.equal(failed.network(), 0);
    const invalid = await offlineService(t, false, true);
    assert.equal((await invalid.service.getCatalog()).source, 'unavailable'); assert.equal(invalid.builds(), 0); assert.equal(invalid.network(), 0);
});

test('switching back online uses the network source even when the local file remains configured', async t => {
    const h = await offlineService(t); await h.service.getCatalog(); h.useFile(h.target); h.online();
    assert.equal((await h.service.getCatalog()).source, 'network');
    await h.service.refresh(); assert.equal(h.network(), 2); assert.equal(h.builds(), 1);
});
