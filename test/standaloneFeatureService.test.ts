import * as projectFormatModule from '../src/projectFormat';
import * as projectLegacyModule from '../src/projectLegacyMetadata';
import { v3Fixture } from './helpers/projectFormat';
import * as projectSetupGate from '../src/projectSetupGate';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type {
    StandaloneFeatureService as CatalogService,
    StandaloneFeatureServiceDependencies
} from '../src/standaloneFeatureService';
import type { StandaloneFeatureSnapshot } from '../src/standaloneFeatureModel';
import * as standaloneFeatureModel from '../src/standaloneFeatureModel';
import * as projectLibraryStore from '../src/projectLibraryStore';
import * as projectLibraryMetadata from '../src/projectLibraryMetadata';
import * as projectEntityDisplayOrder from '../src/projectEntityDisplayOrder';
import * as projectGroupDisplayOrder from '../src/projectGroupDisplayOrder';

// The real filesystem service runs in Node; only its optional VS Code adapter is unavailable there.
function loadService(): typeof CatalogService {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = readFileSync(path.join(process.cwd(), 'src/standaloneFeatureService.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText;
    const module = { exports: {} as { StandaloneFeatureService: typeof CatalogService } };
    const execute = vm.runInThisContext(`(function(require, module, exports) {\n${compiled}\n})`, {
        filename: 'standaloneFeatureService.js'
    }) as (requireModule: (specifier: string) => unknown, module: unknown, exports: unknown) => void;
    execute(specifier => specifier === './projectFormat' ? projectFormatModule : specifier === './projectLegacyMetadata' ? projectLegacyModule : specifier === './projectSetupGate' ? projectSetupGate : specifier === './standaloneFeatureModel' ? standaloneFeatureModel
        : specifier === './projectEntityDisplayOrder' ? projectEntityDisplayOrder : specifier === './projectLibraryStore' ? projectLibraryStore
        : specifier === './projectLibraryMetadata' ? projectLibraryMetadata : specifier === './projectGroupDisplayOrder' ? projectGroupDisplayOrder : require(specifier), module, module.exports);
    return module.exports.StandaloneFeatureService;
}

const StandaloneFeatureService = loadService();
async function groupsText(root: string): Promise<string> {
    return JSON.stringify(await Promise.all((await fs.readdir(path.join(root, '.kot/groups'))).sort().map(name => fs.readFile(path.join(root, '.kot/groups', name), 'utf8'))));
}

test('standalone personal group order survives rename and shared content drag keeps source order scope', async t => {
    const h = await harness(t);
    const a = await h.write('a.feature');
    const b = await h.write('b.feature');
    const service = h.createService();
    const first = await service.createGroup('First');
    const second = await service.createGroup('Second');
    let snapshot = service.getSnapshot();
    const groupFilesBefore = await groupsText(h.root());
    await service.moveGroupDisplay(h.root(), second.id, first.id, [first.id, second.id], snapshot.revision);
    assert.deepEqual(service.getSnapshot().groups.map(group => group.id), [second.id, first.id]);
    assert.equal(await groupsText(h.root()), groupFilesBefore);
    await service.renameGroup(second.id, 'Renamed');
    assert.deepEqual((await h.createService().ensureReady()).groups.map(group => group.id), [second.id, first.id]);
    snapshot = service.getSnapshot();
    const readdir = fs.readdir;
    const walked: string[] = [];
    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => { walked.push(String(args[0])); return readdir(...args); }) as typeof fs.readdir;
    try {
        await service.moveFeature(pathToFileURL(b).href, '', pathToFileURL(a).href, { projectRoot: h.root(), revision: snapshot.revision });
    } finally { fs.readdir = readdir; }
    assert.ok(walked.every(directory => ['metadata', 'groups', 'history'].some(name => directory === path.join(h.root(), '.kot', name))), walked.join('\n'));
    assert.deepEqual(service.getSnapshot().features.map(feature => feature.id), [pathToFileURL(b).href, pathToFileURL(a).href]);
    const metadata = await new projectLibraryStore.ProjectLibraryStore(h.root()).read();
    assert.equal(metadata.metadata['feature:b.feature'].order, 0);
    assert.equal(metadata.metadata['feature:a.feature'].order, 1);
    await assert.rejects(service.moveFeature(pathToFileURL(a).href, second.id, undefined, { projectRoot: h.root(), revision: snapshot.revision }), /changed/u);
    await assert.rejects(service.moveFeature(pathToFileURL(a).href, second.id, undefined, { projectRoot: '/foreign', revision: service.getSnapshot().revision }), /another project/u);
});

test('standalone personal order isolates copied stable group IDs in separate project owners', async t => {
    const h = await harness(t);
    const firstRoot = h.root();
    const firstFile = await h.write('a.feature');
    const service = h.createService();
    const first = await service.createGroup('First');
    const second = await service.createGroup('Second');
    const secondRoot = path.join(h.temp, 'second-project');
    await fs.cp(firstRoot, secondRoot, { recursive: true });
    h.changeRoots([firstRoot, secondRoot]);
    const snapshot = await service.ensureReady();
    assert.equal(snapshot.groups.length, 4, 'each project retains its own display group for the copied shared IDs');
    const beforeFirst = await groupsText(firstRoot);
    const beforeSecond = await groupsText(secondRoot);
    await service.moveGroupDisplay(firstRoot, second.id, first.id, [first.id, second.id], snapshot.revision);
    const reordered = service.getSnapshot();
    assert.deepEqual(reordered.groups.filter(group => group.projectRoot === firstRoot).map(group => group.id), [second.id, first.id]);
    assert.deepEqual(reordered.groups.filter(group => group.projectRoot === secondRoot).map(group => group.id), [first.id, second.id]);
    assert.equal(await groupsText(firstRoot), beforeFirst);
    assert.equal(await groupsText(secondRoot), beforeSecond);
    await assert.rejects(service.moveFeature(pathToFileURL(firstFile).href, first.id, undefined, { projectRoot: secondRoot, revision: reordered.revision }), /another project/u);
});

test('standalone drag creates adjacent placement for a feature discovered after the project was imported', async t => {
    const h = await harness(t);
    await h.write('a.feature');
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    const added = await h.write('new.feature');
    const snapshot = await service.refresh();
    await assert.rejects(fs.stat(`${added}.kot.yml`), { code: 'ENOENT' });
    await service.moveFeature(pathToFileURL(added).href, group.id, undefined, { projectRoot: h.root(), revision: snapshot.revision });
    const shared = await new projectLibraryStore.ProjectLibraryStore(h.root()).read();
    assert.equal(shared.metadata['feature:new.feature'].groupId, group.id);
    assert.equal(shared.metadata['feature:new.feature'].order, 0);
    assert.match(await fs.readFile(`${added}.kot.yml`, 'utf8'), /groupId:/u);
});

function event<T>() {
    const listeners = new Set<(value: T) => void>();
    return {
        subscribe: (listener: (value: T) => void) => {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        },
        fire: (value: T) => { for (const listener of listeners) { listener(value); } }
    };
}

async function harness(t: test.TestContext) {
    const temp = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'standalone-feature-catalog-')));
    const state = new Map<string, unknown>();
    const rootChanged = event<void>();
    const renames = event<readonly { oldPath: string; newPath: string }[]>();
    const watches = new Map<string, () => void>();
    const metadataWatches = new Map<string, () => void>();
    const fileWatches = new Map<string, () => void>();
    const logs: string[] = [];
    const logged = event<string>();
    const dirtyProjects = new Set<string>();
    let roots = [path.join(temp, 'tests')];
    let beforeStateWrite: (() => Promise<void>) | undefined;
    await fs.mkdir(roots[0], { recursive: true }); await v3Fixture(roots[0]);
    const dependencies: StandaloneFeatureServiceDependencies = {
        getRoots: () => roots,
        assertProjectMetadataSaved: root => {
            if (dirtyProjects.has(root)) { throw new Error('Save project metadata first.'); }
        },
        workspaceState: {
            get: <T>(key: string, fallback?: T) => state.has(key) ? state.get(key) as T : fallback,
            update: async (key: string, value: unknown) => {
                const hook = beforeStateWrite;
                beforeStateWrite = undefined;
                await hook?.();
                state.set(key, structuredClone(value));
            }
        },
        watchRoot: (root, listener) => {
            watches.set(root, listener);
            return { dispose: () => { watches.delete(root); } };
        },
        watchFile: (file, listener) => {
            fileWatches.set(file, listener);
            return { dispose: () => { fileWatches.delete(file); } };
        },
        watchProjectMetadataRoot: (root, listener) => {
            metadataWatches.set(root, listener);
            return { dispose: () => { metadataWatches.delete(root); } };
        },
        onDidChangeRoots: rootChanged.subscribe,
        onDidRenameFiles: renames.subscribe,
        log: message => { logs.push(message); logged.fire(message); }
    };
    const services: CatalogService[] = [];
    const createService = (projectRoot?: string) => {
        const service = new StandaloneFeatureService({ ...dependencies,
            ...(projectRoot ? { getProjectRoot: () => projectRoot } : {}) });
        services.push(service);
        return service;
    };
    t.after(async () => {
        for (const service of services) { service.dispose(); }
        await fs.rm(temp, { recursive: true, force: true });
    });
    const write = async (relative: string, content = `Feature: ${relative}\nScenario: Run\n Given ready`) => {
        const filePath = path.join(roots[0], relative);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
        return filePath;
    };
    return {
        temp, state, createService, write, watches, metadataWatches, fileWatches, logs,
        nextLoggedError: (action: () => void) => new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Catalog did not log an error')); }, 3000);
            const subscription = logged.subscribe(message => {
                clearTimeout(timeout); subscription.dispose(); resolve(message);
            });
            action();
        }),
        setProjectMetadataDirty: (root: string, dirty = true) => {
            if (dirty) { dirtyProjects.add(root); } else { dirtyProjects.delete(root); }
        },
        root: () => roots[0],
        blockNextStateWrite: () => {
            let entered!: () => void;
            let release!: () => void;
            const started = new Promise<void>(resolve => { entered = resolve; });
            const gate = new Promise<void>(resolve => { release = resolve; });
            beforeStateWrite = async () => { entered(); await gate; };
            return { started, release };
        },
        changeRoot: (root: string) => { roots = [root]; rootChanged.fire(); },
        changeRoots: (nextRoots: string[]) => { roots = nextRoots; rootChanged.fire(); },
        rename: (oldPath: string, newPath: string) => { renames.fire([{ oldPath, newPath }]); }
    };
}

async function nextSnapshot(service: CatalogService, action: () => void): Promise<StandaloneFeatureSnapshot> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Catalog did not refresh')); }, 3000);
        const subscription = service.onDidChange(snapshot => {
            clearTimeout(timeout);
            subscription.dispose();
            resolve(snapshot);
        });
        action();
    });
}

test('refreshes source consumers after step edits without changing catalog metadata or rebuilding its rows', async t => {
    const h = await harness(t);
    await h.write('authored.feature', 'Feature: Authored\nScenario: Run\n Given original');
    const service = h.createService();
    const original = await service.ensureReady();
    const catalogUpdates: StandaloneFeatureSnapshot[] = [];
    const sourceUpdates: StandaloneFeatureSnapshot[] = [];
    service.onDidChange(snapshot => { catalogUpdates.push(snapshot); });
    service.onDidRefresh(snapshot => { sourceUpdates.push(snapshot); });
    await h.write('authored.feature', 'Feature: Authored\nScenario: Run\n Given shared export');
    h.watches.get(h.root())!();
    await service.ensureReady();
    assert.equal(service.getSnapshot(), original);
    assert.deepEqual(catalogUpdates, []);
    assert.deepEqual(sourceUpdates, [original]);
    await service.createGroup('Smoke');
    assert.equal(sourceUpdates.length, 2, 'organization changes also refresh the relationship projection');
});

test('discovers independent features with URI identity and excludes compiled and export-only files', async t => {
    const h = await harness(t);
    const first = await h.write('one/login.feature', '\uFEFF# language: ru\nФункциональность: Вход клиента\nСценарий: Вход');
    const second = await h.write('two/login.feature', 'Feature: Customer login\nScenario: Login');
    await h.write('one/login.json', '{}');
    const compiled = await h.write('generated.feature');
    await h.write('exports.feature', '@ExportScenarios\nFeature: Library\nScenario: Shared login');
    await h.write('tagged-export.feature', 'Feature: Library\n@ExportScenarios\nScenario: Shared login');
    await h.write('mixed.feature', 'Feature: Mixed\n@ExportScenarios\nScenario: Shared login\n Given ready\nScenario: Authored');
    const service = h.createService();
    service.setCompiledFeaturePaths([compiled]);

    const snapshot = await service.ensureReady();

    assert.deepEqual(snapshot.features.map(feature => feature.relativePath), ['mixed.feature', 'one/login.feature', 'two/login.feature']);
    const russian = service.find(pathToFileURL(first).toString());
    const english = service.find(pathToFileURL(second).toString());
    assert.equal(russian?.title, 'Вход клиента');
    assert.equal(russian?.language, 'ru');
    assert.equal(russian?.name, 'login');
    assert.equal(russian?.jsonPath, path.join(h.root(), 'one/login.json'));
    assert.equal(english?.title, 'Customer login');
    assert.equal(english?.language, 'en');
    assert.equal(english?.jsonPath, undefined);
    assert.notEqual(russian?.id, english?.id);
    assert.equal(russian?.id, russian?.uri);
    assert.ok(snapshot.features.every(feature => feature.groupId === ''));

    service.setCompiledFeaturePaths([pathToFileURL(first).toString()]);
    assert.deepEqual((await service.ensureReady()).features.map(feature => feature.relativePath), ['mixed.feature', 'two/login.feature', 'generated.feature']);
});

test('persists empty groups and file moves and order without rewriting test files', async t => {
    const h = await harness(t);
    const files = await Promise.all(['a.feature', 'b.feature', 'c.feature'].map(relative => h.write(relative)));
    const contents = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
    const [a, b, c] = files.map(file => pathToFileURL(file).toString());
    const service = h.createService();
    await service.ensureReady();
    const group = await service.createGroup(' Smoke ');
    const empty = await service.createGroup('Empty');
    await service.moveFeature(c, group.id);
    await service.moveFeature(a, group.id, c);
    await service.moveFeature(c, group.id, a);
    await service.renameGroup(group.id, 'Checkout');
    await service.moveFeature(b, group.id);

    const restart = h.createService();
    const snapshot = await restart.ensureReady();
    assert.deepEqual(snapshot.groups, [{ id: group.id, name: 'Checkout' }, { id: empty.id, name: 'Empty' }]);
    assert.deepEqual(snapshot.features.map(feature => [feature.id, feature.groupId, feature.order]), [
        [c, group.id, 0], [a, group.id, 1], [b, group.id, 2]
    ]);
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), contents);
    await restart.deleteGroup(group.id);
    const deleted = await restart.refresh();
    assert.deepEqual(deleted.groups, [{ id: empty.id, name: 'Empty' }]);
    assert.deepEqual(deleted.features.map(feature => [feature.id, feature.groupId]), [[c, ''], [a, ''], [b, '']]);
});

test('keeps organization through temporary file loss and validates move targets', async t => {
    const h = await harness(t);
    const file = await h.write('checkout.feature');
    const id = pathToFileURL(file).toString();
    const service = h.createService();
    const group = await service.createGroup('Checkout');
    await service.moveFeature(id, group.id);
    await fs.rm(file);
    assert.equal((await service.refresh()).features.length, 0);
    await h.write('checkout.feature');
    assert.equal((await service.refresh()).features[0].groupId, group.id);
    await assert.rejects(service.moveFeature('missing', group.id));
    await assert.rejects(service.moveFeature(id, 'missing'));
    await assert.rejects(service.moveFeature(id, group.id, 'missing'));
    await assert.rejects(service.createGroup('   '));
});

test('keeps explicit JSON separate for same filenames and falls back when it disappears', async t => {
    const h = await harness(t);
    const one = pathToFileURL(await h.write('one/login.feature')).toString();
    const two = pathToFileURL(await h.write('two/login.feature')).toString();
    const adjacent = await h.write('one/login.json', '{}');
    const selected = await h.write('profiles/custom.json', '{}');
    const service = h.createService();
    await service.setLaunchJson(one, selected);
    assert.equal(service.find(one)?.jsonPath, selected);
    assert.equal(service.find(two)?.jsonPath, undefined);
    await fs.rm(selected);
    assert.equal((await service.refresh()).features.find(feature => feature.id === one)?.jsonPath, adjacent);
    await fs.writeFile(selected, '{}');
    assert.equal((await service.refresh()).features.find(feature => feature.id === one)?.jsonPath, selected);
    await assert.rejects(service.setLaunchJson(one, path.join(h.root(), 'missing.json')));
    await assert.rejects(service.setLaunchJson(one, path.join(h.root(), 'one/login.feature')));
    await assert.rejects(service.setLaunchJson(two, h.root()));
    await assert.rejects(service.setLaunchJson('missing', selected));
});

test('watch events update sources and adjacent JSON and rebind an external scan root', async t => {
    const h = await harness(t);
    const file = await h.write('checkout.feature');
    const service = h.createService();
    await service.ensureReady();
    await fs.writeFile(file, 'Feature: Changed checkout\nScenario: Run');
    const changed = await nextSnapshot(service, () => h.watches.get(h.root())!());
    assert.equal(changed.features[0].title, 'Changed checkout');
    await h.write('checkout.json', '{}');
    const jsonAdded = await nextSnapshot(service, () => h.watches.get(h.root())!());
    assert.equal(jsonAdded.features[0].jsonPath, path.join(h.root(), 'checkout.json'));
    const external = path.join(h.temp, 'external');
    await v3Fixture(external);
    await fs.writeFile(path.join(external, 'outside.feature'), 'Feature: External\nScenario: Run');
    const oldRoot = h.root();
    const changedRoot = await nextSnapshot(service, () => h.changeRoot(external));
    assert.deepEqual(changedRoot.features.map(feature => feature.title), ['External']);
    assert.equal(h.watches.has(oldRoot), false);
    assert.equal(h.watches.has(external), true);
    await fs.rm(path.join(external, 'outside.feature'));
    const removed = await nextSnapshot(service, () => h.watches.get(external)!());
    assert.equal(removed.features.length, 0);
});

test('renaming into a previously deleted filename preserves the source placement and JSON', async t => {
    const h = await harness(t);
    const source = await h.write('a.feature');
    const destination = await h.write('b.feature');
    const service = h.createService();
    await service.ensureReady();
    const currentGroup = await service.createGroup('Current');
    const previousGroup = await service.createGroup('Previous');
    await service.moveFeature(pathToFileURL(source).toString(), currentGroup.id);
    await service.moveFeature(pathToFileURL(destination).toString(), previousGroup.id);
    const currentJson = path.join(h.root(), 'current.json');
    const previousJson = path.join(h.root(), 'previous.json');
    await fs.writeFile(currentJson, '{}');
    await fs.writeFile(previousJson, '{}');
    await service.setLaunchJson(pathToFileURL(source).toString(), currentJson);
    await service.setLaunchJson(pathToFileURL(destination).toString(), previousJson);
    const before = service.find(pathToFileURL(source).toString())!;
    await fs.unlink(destination);
    await service.refresh();
    await fs.rename(source, destination);
    const renamed = await nextSnapshot(service, () => h.rename(source, destination));
    const entry = renamed.features.find(feature => feature.id === pathToFileURL(destination).toString())!;
    assert.equal(entry.groupId, currentGroup.id);
    assert.equal(entry.order, before.order);
    assert.equal(entry.jsonPath, currentJson);
});

test('file and directory rename events preserve group order and explicit JSON associations', async t => {
    const h = await harness(t);
    const file = await h.write('one/login.feature');
    const json = await h.write('profiles/login.json', '{}');
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    await service.moveFeature(pathToFileURL(file).toString(), group.id);
    await service.setLaunchJson(pathToFileURL(file).toString(), json);
    const originalSidecar = `${file}.kot.yml`;
    const originalMetadata = await fs.readFile(originalSidecar, 'utf8');
    const renamed = path.join(h.root(), 'one/session.feature');
    await fs.rename(file, renamed);
    assert.equal(await fs.readFile(originalSidecar, 'utf8'), originalMetadata);
    let snapshot = await nextSnapshot(service, () => h.rename(file, renamed));
    assert.equal(snapshot.features[0].id, pathToFileURL(renamed).toString());
    assert.equal(snapshot.features[0].groupId, group.id);
    assert.equal(snapshot.features[0].jsonPath, json);
    await assert.rejects(fs.stat(originalSidecar), { code: 'ENOENT' });
    const relocatedSidecar = `${renamed}.kot.yml`;
    const relocatedMetadata = await fs.readFile(relocatedSidecar, 'utf8');
    const from = path.join(h.root(), 'one');
    const to = path.join(h.root(), 'two');
    await fs.rename(from, to);
    snapshot = await nextSnapshot(service, () => h.rename(from, to));
    assert.equal(snapshot.features[0].relativePath, 'two/session.feature');
    assert.equal(snapshot.features[0].groupId, group.id);
    assert.equal(snapshot.features[0].jsonPath, json);
    assert.equal(await fs.readFile(path.join(to, 'session.feature.kot.yml'), 'utf8'), relocatedMetadata,
        'directory moves carry the sidecar without rewriting its contents');
    await assert.rejects(fs.stat(relocatedSidecar), { code: 'ENOENT' });
    assert.equal((await h.createService().ensureReady()).features[0].groupId, group.id);
});

test('a deleted shared group is not recreated when moving a feature with its adjacent metadata', async t => {
    const h = await harness(t);
    const file = await h.write('one/login.feature');
    const service = h.createService();
    const group = await service.createGroup('Deleted smoke');
    await service.moveFeature(pathToFileURL(file).toString(), group.id);
    await new projectLibraryStore.ProjectLibraryStore(h.root()).deleteGroup(group.id);
    const from = path.join(h.root(), 'one');
    const to = path.join(h.root(), 'two');
    await fs.rename(from, to);

    const snapshot = await nextSnapshot(service, () => h.rename(from, to));

    assert.equal(snapshot.features[0].groupId, '');
    assert.deepEqual(snapshot.groups, []);
    assert.deepEqual((await new projectLibraryStore.ProjectLibraryStore(h.root()).read()).groups, []);
});

test('source-only renames preserve dirty adjacent metadata until it is saved', async t => {
    const h = await harness(t);
    const source = await h.write('login.feature');
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    await service.moveFeature(pathToFileURL(source).toString(), group.id);
    const oldSidecar = `${source}.kot.yml`;
    const content = await fs.readFile(oldSidecar, 'utf8');
    const destination = path.join(h.root(), 'session.feature');
    h.setProjectMetadataDirty(h.root());
    await fs.rename(source, destination);

    assert.match(await h.nextLoggedError(() => h.rename(source, destination)), /Save project metadata first/u);

    assert.equal(await fs.readFile(oldSidecar, 'utf8'), content);
    await assert.rejects(fs.stat(`${destination}.kot.yml`), { code: 'ENOENT' });
});

test('source-only renames never overwrite invalid destination sidecars', async t => {
    const h = await harness(t);
    const source = await h.write('login.feature');
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    await service.moveFeature(pathToFileURL(source).toString(), group.id);
    const oldSidecar = `${source}.kot.yml`;
    const original = await fs.readFile(oldSidecar, 'utf8');
    const destination = path.join(h.root(), 'session.feature');
    const invalid = 'version: 1\nidentity: [invalid\n';
    await fs.writeFile(`${destination}.kot.yml`, invalid);
    await fs.rename(source, destination);

    assert.match(await h.nextLoggedError(() => h.rename(source, destination)), /Invalid project YAML/u);

    assert.equal(await fs.readFile(oldSidecar, 'utf8'), original);
    assert.equal(await fs.readFile(`${destination}.kot.yml`, 'utf8'), invalid);
});

test('does not follow symbolic directory loops or duplicate feature aliases', async t => {
    const h = await harness(t);
    const file = await h.write('safe/checkout.feature');
    await fs.symlink(h.root(), path.join(h.root(), 'safe/loop'), 'dir');
    await fs.symlink(file, path.join(h.root(), 'alias.feature'), 'file');
    const snapshot = await h.createService().ensureReady();
    assert.deepEqual(snapshot.features.map(feature => feature.relativePath), ['safe/checkout.feature']);
});

test('watches an explicit JSON outside the test root and refreshes its availability', async t => {
    const h = await harness(t);
    const id = pathToFileURL(await h.write('checkout.feature')).toString();
    const externalJson = path.join(h.temp, 'external-profile.json');
    await fs.writeFile(externalJson, '{}');
    const service = h.createService();
    await service.setLaunchJson(id, externalJson);
    await fs.rm(externalJson);

    const snapshot = await nextSnapshot(service, () => h.fileWatches.get(externalJson)?.());

    assert.equal(snapshot.features[0].jsonPath, undefined);
    await fs.writeFile(externalJson, '{}');
    const restored = await nextSnapshot(service, () => h.fileWatches.get(externalJson)?.());
    assert.equal(restored.features[0].jsonPath, externalJson);
    service.dispose();
    assert.equal(h.fileWatches.size, 0);
});

test('an exclusion change while saving a scan never publishes the old compiled artifact', async t => {
    const h = await harness(t);
    const compiled = await h.write('generated.feature');
    await h.write('authored.feature');
    const service = h.createService();
    const snapshots: StandaloneFeatureSnapshot[] = [];
    service.onDidChange(snapshot => { snapshots.push(snapshot); });
    const blocked = h.blockNextStateWrite();
    const loading = service.ensureReady();
    await blocked.started;
    service.setCompiledFeaturePaths([compiled]);
    blocked.release();

    const snapshot = await loading;

    assert.deepEqual(snapshot.features.map(feature => feature.relativePath), ['authored.feature']);
    assert.ok(snapshots.length > 0);
    assert.ok(snapshots.every(value => value.features.every(feature => feature.relativePath !== 'generated.feature')));
});

test('an exclusion change while saving a move cannot republish the compiled artifact', async t => {
    const h = await harness(t);
    const compiled = await h.write('generated.feature');
    await h.write('authored.feature');
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    const snapshots: StandaloneFeatureSnapshot[] = [];
    service.onDidChange(snapshot => { snapshots.push(snapshot); });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rename = fs.rename;
    let blocked = false;
    fs.rename = async (from, to) => {
        if (!blocked && String(to) === `${compiled}.kot.yml`) { blocked = true; entered(); await gate; }
        return rename(from, to);
    };
    try {
        const moving = service.moveFeature(pathToFileURL(compiled).toString(), group.id);
        await started;
        service.setCompiledFeaturePaths([compiled]);
        release();
        await moving;
    } finally { release(); fs.rename = rename; }
    await service.ensureReady();

    assert.ok(snapshots.every(value => value.features.every(feature => feature.relativePath !== 'generated.feature')));
});

test('equivalent encoded file URIs share lookup, group moves, JSON association and persisted placement', async t => {
    const h = await harness(t);
    const id = pathToFileURL(await h.write('test:name.feature')).toString();
    const encoded = id.replace('test:name.feature', 'test%3Aname.feature');
    const json = await h.write('profiles/launch.json', '{}');
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    assert.equal(service.find(encoded)?.id, id);
    await service.moveFeature(encoded, group.id);
    await service.setLaunchJson(encoded, json);
    assert.equal(service.find(id)?.groupId, group.id);
    assert.equal(service.find(id)?.jsonPath, json);
    for (const [key, value] of h.state) {
        const organization = value as { groups: unknown; placements?: Record<string, unknown> };
        if (organization?.placements?.[id]) {
            organization.placements[encoded] = organization.placements[id];
            delete organization.placements[id];
            h.state.set(key, organization);
        }
    }
    const restored = await h.createService().ensureReady();
    assert.equal(restored.features[0].id, id);
    assert.equal(restored.features[0].groupId, group.id);
    assert.equal(restored.features[0].jsonPath, json);
});

test('shares portable groups and ordering across cloned roots while keeping launch JSON local', async t => {
    const source = await harness(t);
    const files = await Promise.all(['a.feature', 'b.feature'].map(relative => source.write(relative)));
    const service = source.createService();
    const group = await service.createGroup('Shared smoke');
    const empty = await service.createGroup('Empty shared group');
    await service.moveFeature(pathToFileURL(files[1]).toString(), group.id);
    await service.moveFeature(pathToFileURL(files[0]).toString(), group.id);
    const json = await source.write('local-profile.json', '{}');
    await service.setLaunchJson(pathToFileURL(files[0]).toString(), json);

    const clone = await harness(t);
    await fs.cp(source.root(), clone.root(), { recursive: true });
    const snapshot = await clone.createService().ensureReady();
    assert.deepEqual(snapshot.groups, [{ id: empty.id, name: 'Empty shared group' }, { id: group.id, name: 'Shared smoke' }]);
    assert.deepEqual(snapshot.features.map(feature => [feature.relativePath, feature.groupId, feature.order]), [
        ['a.feature', group.id, 0], ['b.feature', group.id, 1]
    ]);
    assert.ok(snapshot.features.every(feature => feature.jsonPath === undefined));
    const shared = await new projectLibraryStore.ProjectLibraryStore(source.root()).read();
    assert.ok(Object.values(shared.identities).every(identity => !path.isAbsolute(identity.relativePath)));
    assert.ok(!JSON.stringify(shared).includes(source.temp), 'project metadata contains no machine paths');
    assert.ok(!JSON.stringify(shared).includes('jsonPath'), 'launch selection stays outside the shared object');
    const local = source.state.get('kotTestToolkit.standaloneFeatures') as { groups?: unknown; placements: Record<string, unknown> };
    assert.equal(local.groups, undefined);
    assert.deepEqual(local.placements[pathToFileURL(files[0]).toString()], { jsonPath: json });
    await fs.stat(`${files[0]}.kot.yml`);
    await fs.stat(path.join(clone.root(), 'a.feature.kot.yml'));
    await assert.rejects(fs.stat(path.join(source.root(), '.kot', 'metadata')), { code: 'ENOENT' });
});

test('imports legacy local organization once and does not revive deleted shared groups', async t => {
    const h = await harness(t);
    const file = await h.write('smoke.feature');
    const id = pathToFileURL(file).toString();
    const legacy = { groups: [{ id: 'legacy-smoke', name: 'Old smoke' }], placements: { [id]: { groupId: 'legacy-smoke', order: 7 } } };
    h.state.set('kotTestToolkit.standaloneFeatures', legacy);
    const service = h.createService();
    assert.deepEqual((await service.ensureReady()).groups, legacy.groups);
    assert.equal(service.find(id)?.order, 7);
    await service.deleteGroup('legacy-smoke');
    h.state.set('kotTestToolkit.standaloneFeatures', legacy);
    const restarted = await h.createService().ensureReady();
    assert.deepEqual(restarted.groups, []);
    assert.equal(restarted.features[0].groupId, '');
});

test('refreshes shared Git edits and refuses a move into a group deleted by another tester', async t => {
    const h = await harness(t);
    const id = pathToFileURL(await h.write('smoke.feature')).toString();
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    await service.moveFeature(id, group.id);
    const external = new projectLibraryStore.ProjectLibraryStore(h.root());
    await external.renameGroup(group.id, 'Shared checkout');
    const edited = await nextSnapshot(service, () => h.watches.get(path.join(h.root(), '.kot'))?.());
    assert.equal(edited.groups[0].name, 'Shared checkout');
    await external.deleteGroup(group.id);
    await assert.rejects(service.moveFeature(id, group.id), /no longer exists/u);
    assert.deepEqual((await service.refresh()).groups, []);
    assert.equal(service.find(id)?.groupId, '');
});

test('does not scan feature files inside project metadata storage', async t => {
    const h = await harness(t);
    await h.write('authored.feature');
    await h.write('.kot/fixtures/helper.feature');
    assert.deepEqual((await h.createService().ensureReady()).features.map(feature => feature.relativePath), ['authored.feature']);
});

test('keeps project objects above a contained test root and watches that shared directory', async t => {
    const h = await harness(t);
    const id = pathToFileURL(await h.write('smoke.feature')).toString();
    const service = h.createService(h.temp);
    const group = await service.createGroup('Workspace smoke');
    await service.moveFeature(id, group.id);
    const snapshot = await new projectLibraryStore.ProjectLibraryStore(h.temp).read();
    assert.equal(Object.values(snapshot.identities)[0].relativePath, 'tests/smoke.feature');
    assert.equal(Object.values(snapshot.metadata)[0].groupId, group.id);
    assert.equal(h.watches.has(path.join(h.temp, '.kot')), true);
    assert.equal(h.metadataWatches.has(h.temp), true);
    await assert.rejects(fs.stat(path.join(h.root(), '.kot/groups')), { code: 'ENOENT' });
});

test('workspace sidecar edits refresh standalone organization and dispose their scoped watcher', async t => {
    const h = await harness(t);
    const source = await h.write('smoke.feature');
    const id = pathToFileURL(source).toString();
    const service = h.createService(h.temp);
    const group = await service.createGroup('Workspace smoke');
    const store = new projectLibraryStore.ProjectLibraryStore(h.temp);
    await store.setMetadata({ kind: 'feature', relativePath: 'tests/smoke.feature' }, { groupId: group.id, order: 9 });

    const edited = await nextSnapshot(service, () => h.metadataWatches.get(h.temp)?.());

    assert.equal(edited.features[0].id, id);
    assert.equal(edited.features[0].groupId, group.id);
    assert.equal(edited.features[0].order, 9);
    service.dispose();
    assert.equal(h.metadataWatches.size, 0);
});

test('moving between independent project groups with the same name uses the destination project identity', async t => {
    const h = await harness(t);
    const firstRoot = h.root();
    const secondRoot = path.join(h.temp, 'second-project');
    const firstFile = await h.write('first.feature');
    await v3Fixture(secondRoot);
    const secondFile = path.join(secondRoot, 'second.feature');
    await fs.writeFile(secondFile, 'Feature: Second\nScenario: Run');
    h.changeRoots([firstRoot, secondRoot]);
    const firstStore = new projectLibraryStore.ProjectLibraryStore(firstRoot);
    const secondStore = new projectLibraryStore.ProjectLibraryStore(secondRoot);
    const firstGroup = await firstStore.ensureGroup('Smoke', 'standalone');
    const secondGroup = await secondStore.ensureGroup('Smoke', 'standalone');
    const firstIdentity = { kind: 'feature' as const, relativePath: 'first.feature' };
    const secondIdentity = { kind: 'feature' as const, relativePath: 'second.feature' };
    await firstStore.setMetadata(firstIdentity, { groupId: firstGroup.id, order: 7, description: 'First project' });
    await secondStore.setMetadata(secondIdentity, { groupId: secondGroup.id, order: 3, description: 'Second project' });
    const firstBefore = await firstStore.read();
    const service = h.createService();
    await service.ensureReady();

    await service.moveFeature(pathToFileURL(secondFile).toString(), firstGroup.id);

    const secondAfter = await secondStore.read();
    assert.deepEqual(secondAfter.groups, [{ ...secondGroup }]);
    assert.deepEqual(secondAfter.metadata[projectLibraryStore.projectEntityKey(secondIdentity)], {
        groupId: secondGroup.id, order: 0, description: 'Second project'
    });
    assert.deepEqual((await firstStore.read()).metadata, firstBefore.metadata);
    assert.equal(service.find(pathToFileURL(firstFile).toString())?.groupId, firstGroup.id);
    assert.equal(service.find(pathToFileURL(secondFile).toString())?.groupId, secondGroup.id);
});

test('nested project roots keep source discovery and legacy sidecar imports with their owner', async t => {
    const h = await harness(t);
    const outerRoot = h.root();
    const nestedRoot = path.join(outerRoot, 'nested-project');
    const outerFile = await h.write('outer.feature');
    const nestedFile = await h.write('nested-project/inner.feature');
    await v3Fixture(nestedRoot);
    h.changeRoots([outerRoot, nestedRoot]);
    const outerStore = new projectLibraryStore.ProjectLibraryStore(outerRoot, { excludedRoots: [nestedRoot] });
    const nestedStore = new projectLibraryStore.ProjectLibraryStore(nestedRoot);
    const outerGroup = await outerStore.ensureGroup('Smoke', 'standalone');
    const nestedGroup = await nestedStore.ensureGroup('Smoke', 'standalone');
    await outerStore.setMetadata({ kind: 'feature', relativePath: 'outer.feature' }, { groupId: outerGroup.id, order: 3 });
    await nestedStore.setMetadata({ kind: 'feature', relativePath: 'inner.feature' }, {
        groupId: nestedGroup.id, order: 7, description: 'Owned by nested project'
    });
    const nestedSidecar = await fs.readFile(`${nestedFile}.kot.yml`, 'utf8');

    const snapshot = await h.createService().ensureReady();

    assert.deepEqual(snapshot.features.map(feature => [feature.id, feature.relativePath, feature.groupId, feature.order]), [
        [pathToFileURL(outerFile).toString(), 'outer.feature', outerGroup.id, 3],
        [pathToFileURL(nestedFile).toString(), 'inner.feature', nestedGroup.id, 7]
    ]);
    assert.equal(await fs.readFile(`${nestedFile}.kot.yml`, 'utf8'), nestedSidecar);
    assert.deepEqual(Object.keys((await outerStore.read()).metadata), ['feature:outer.feature']);
    assert.deepEqual(Object.keys((await nestedStore.read()).metadata), ['feature:inner.feature']);
});

test('a filesystem rename into another project maps a same-name group to its destination identity', async t => {
    const h = await harness(t);
    const firstRoot = h.root();
    const secondRoot = path.join(h.temp, 'second-project');
    const firstFile = await h.write('source.feature');
    await v3Fixture(secondRoot);
    h.changeRoots([firstRoot, secondRoot]);
    const firstStore = new projectLibraryStore.ProjectLibraryStore(firstRoot);
    const secondStore = new projectLibraryStore.ProjectLibraryStore(secondRoot);
    const sourceGroup = await firstStore.ensureGroup('Smoke', 'standalone');
    const destinationGroup = await secondStore.ensureGroup('Smoke', 'standalone');
    const sourceIdentity = { kind: 'feature' as const, relativePath: 'source.feature' };
    await firstStore.setMetadata(sourceIdentity, { groupId: sourceGroup.id, order: 7, description: 'Keep source description' });
    const service = h.createService();
    await service.ensureReady();
    const renamedFile = path.join(secondRoot, 'renamed.feature');
    await fs.rename(firstFile, renamedFile);

    const snapshot = await nextSnapshot(service, () => h.rename(firstFile, renamedFile));

    assert.equal(snapshot.features[0].groupId, destinationGroup.id);
    assert.equal((await firstStore.read()).metadata[projectLibraryStore.projectEntityKey(sourceIdentity)], undefined);
    const destination = await secondStore.read();
    assert.deepEqual(destination.metadata['feature:renamed.feature'], {
        groupId: destinationGroup.id, order: 7, description: 'Keep source description'
    });
    assert.deepEqual(destination.groups, [{ ...destinationGroup }]);
});

test('a directory move between projects rebinds carried sidecars and local JSON to the destination group', async t => {
    const h = await harness(t);
    const firstRoot = h.root();
    const secondRoot = path.join(h.temp, 'second-project');
    const firstFile = await h.write('source/login.feature');
    const json = await h.write('source/profile.json', '{}');
    await v3Fixture(secondRoot);
    h.changeRoots([firstRoot, secondRoot]);
    const firstStore = new projectLibraryStore.ProjectLibraryStore(firstRoot);
    const secondStore = new projectLibraryStore.ProjectLibraryStore(secondRoot);
    const sourceGroup = await firstStore.ensureGroup('Smoke', 'standalone');
    const destinationGroup = await secondStore.ensureGroup('Smoke', 'standalone');
    const sourceIdentity = { kind: 'feature' as const, relativePath: 'source/login.feature' };
    await firstStore.setMetadata(sourceIdentity, { groupId: sourceGroup.id, order: 7, description: 'Carried source description' });
    const service = h.createService();
    await service.ensureReady();
    await service.setLaunchJson(pathToFileURL(firstFile).toString(), json);
    await fs.stat(`${firstFile}.kot.yml`);
    const from = path.join(firstRoot, 'source');
    const to = path.join(secondRoot, 'moved');
    await fs.rename(from, to);

    const snapshot = await nextSnapshot(service, () => h.rename(from, to));

    assert.equal(snapshot.features[0].groupId, destinationGroup.id);
    assert.equal(snapshot.features[0].jsonPath, path.join(to, 'profile.json'));
    assert.equal(snapshot.features[0].order, 7);
    await assert.rejects(fs.stat(`${firstFile}.kot.yml`), { code: 'ENOENT' });
    await fs.stat(path.join(to, 'login.feature.kot.yml'));
    const destination = await secondStore.read();
    assert.deepEqual(destination.metadata['feature:moved/login.feature'], {
        groupId: destinationGroup.id, order: 7, description: 'Carried source description'
    });
    assert.deepEqual(destination.groups, [{ ...destinationGroup }]);
    assert.deepEqual((await h.createService().ensureReady()).features.map(feature => [feature.groupId, feature.jsonPath]), [
        [destinationGroup.id, path.join(to, 'profile.json')]
    ]);
});

test('cross-project directory moves keep missing source groups deleted despite cached placements', async t => {
    const h = await harness(t);
    const firstRoot = h.root();
    const secondRoot = path.join(h.temp, 'second-project');
    const firstFile = await h.write('source/login.feature');
    await v3Fixture(secondRoot);
    h.changeRoots([firstRoot, secondRoot]);
    const firstStore = new projectLibraryStore.ProjectLibraryStore(firstRoot);
    const secondStore = new projectLibraryStore.ProjectLibraryStore(secondRoot);
    const sourceGroup = await firstStore.ensureGroup('Deleted smoke', 'standalone');
    const destinationGroup = await secondStore.ensureGroup('Current group', 'standalone');
    await firstStore.setMetadata({ kind: 'feature', relativePath: 'source/login.feature' }, {
        groupId: sourceGroup.id, order: 8, description: 'Retain description'
    });
    const service = h.createService();
    await service.ensureReady();
    await fs.unlink(path.join(firstRoot, '.kot/groups', `${sourceGroup.id}.yml`));
    const from = path.join(firstRoot, 'source');
    const to = path.join(secondRoot, 'moved');
    await fs.rename(from, to);

    const snapshot = await nextSnapshot(service, () => h.rename(from, to));

    assert.equal(snapshot.features[0].groupId, '');
    assert.deepEqual(snapshot.groups, [{ id: destinationGroup.id, name: destinationGroup.name }]);
    assert.deepEqual((await secondStore.read()).metadata['feature:moved/login.feature'], {
        groupId: '', order: 8, description: 'Retain description'
    });
    assert.deepEqual((await firstStore.read()).groups, []);
    await assert.rejects(fs.stat(`${firstFile}.kot.yml`), { code: 'ENOENT' });
});

test('dirty project metadata blocks organization writes while local launch JSON remains editable', async t => {
    const h = await harness(t);
    const id = pathToFileURL(await h.write('smoke.feature')).toString();
    const json = await h.write('profile.json', '{}');
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    const store = new projectLibraryStore.ProjectLibraryStore(h.root());
    const before = await store.read();
    h.setProjectMetadataDirty(h.root());

    await assert.rejects(service.createGroup('Do not create'), /Save project metadata first/u);
    await assert.rejects(service.moveFeature(id, group.id), /Save project metadata first/u);
    await assert.rejects(service.renameGroup(group.id, 'Do not rename'), /Save project metadata first/u);
    await assert.rejects(service.deleteGroup(group.id), /Save project metadata first/u);
    assert.deepEqual(await store.read(), before);
    await service.setLaunchJson(id, json);
    assert.equal(service.find(id)?.jsonPath, json);
    assert.deepEqual(await store.read(), before);
});

test('dirty project metadata prevents the initial legacy import without clearing its local organization', async t => {
    const h = await harness(t);
    const id = pathToFileURL(await h.write('smoke.feature')).toString();
    const legacy = { groups: [{ id: 'legacy', name: 'Legacy' }], placements: { [id]: { groupId: 'legacy', order: 7 } } };
    h.state.set('kotTestToolkit.standaloneFeatures', legacy);
    h.setProjectMetadataDirty(h.root());
    const service = h.createService();

    await assert.rejects(service.ensureReady(), /Save project metadata first/u);
    await assert.rejects(fs.stat(path.join(h.root(), '.kot/groups')), { code: 'ENOENT' });
    assert.deepEqual(h.state.get('kotTestToolkit.standaloneFeatures'), legacy);
    h.setProjectMetadataDirty(h.root(), false);
    assert.equal((await service.ensureReady()).features[0].groupId, 'legacy');
});

test('dirty metadata prevents automatic central-record migration until shared objects are saved', async t => {
    const h = await harness(t);
    const source = await h.write('smoke.feature');
    const service = h.createService();
    const group = await service.createGroup('Smoke');
    const identity = { kind: 'feature' as const, relativePath: 'smoke.feature' };
    const key = projectLibraryStore.projectEntityKey(identity);
    const legacyDirectory = path.join(h.root(), '.kot', 'metadata');
    const legacyPath = path.join(legacyDirectory, `${createHash('sha256').update(key).digest('hex')}.yml`);
    const legacy = JSON.stringify({ version: 1, identity, metadata: { groupId: group.id, order: 9 } });
    await fs.rm(`${source}.kot.yml`, { force: true });
    await fs.mkdir(legacyDirectory, { recursive: true });
    await fs.writeFile(legacyPath, legacy);
    h.setProjectMetadataDirty(h.root());

    await assert.rejects(service.refresh(), /Save project metadata first/u);

    assert.equal(await fs.readFile(legacyPath, 'utf8'), legacy);
    await assert.rejects(fs.stat(`${source}.kot.yml`), { code: 'ENOENT' });
    h.setProjectMetadataDirty(h.root(), false);
    const migrated = await service.refresh();
    assert.equal(migrated.features[0].groupId, group.id);
    assert.equal(migrated.features[0].order, 9);
    await fs.stat(`${source}.kot.yml`);
    await assert.rejects(fs.stat(legacyPath), { code: 'ENOENT' });
});

test('creating a group from feature Properties writes it to that feature project', async t => {
    const h = await harness(t); const firstRoot = h.root(); const secondRoot = path.join(h.temp, 'other-tests');
    await v3Fixture(secondRoot); const file = path.join(secondRoot, 'other.feature');
    await fs.writeFile(file, 'Feature: Other\nScenario: Ready\n'); h.changeRoots([firstRoot, secondRoot]);
    const service = h.createService(); await service.ensureReady();
    const group = await service.createGroupForFeature(pathToFileURL(file).toString(), 'From Properties');
    assert.deepEqual([...service.getSnapshot().ordering!.groupRoots[group.id]], [secondRoot]);
    assert.match(await groupsText(secondRoot), /From Properties/u);
});

test('native SPPR scen.feature stays with its metadata instead of appearing as an independent Vanessa feature', async t => {
    const h = await harness(t);
    const native = await h.write('native/scen.feature');
    await fs.writeFile(path.join(path.dirname(native), 'meta.yaml'), 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "SPPR"\n    UID: "sppr-native"\n');
    const standalone = await h.write('ordinary/scen.feature');
    await fs.writeFile(path.join(path.dirname(standalone), 'meta.yaml'), 'Other: "configuration"\n');
    const snapshot = await h.createService().ensureReady();
    assert.deepEqual(snapshot.features.map(feature => feature.uri), [pathToFileURL(standalone).href]);
});
