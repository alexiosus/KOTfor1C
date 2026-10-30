import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ProjectLibraryStore } from '../src/projectLibraryStore';
import { applyCachedProjectScenarioMetadata, hasCachedProjectScenarioMetadata, loadProjectLibraryGroups, loadProjectScenarioMetadata, reloadProjectScenarioMetadata, remapProjectScenarioMetadata, renameProjectLibraryGroup, resolveProjectLibraryRoot, resolveProjectEntityIdentity } from '../src/projectLibraryMetadata';
import { completeProjectSetup, deferProjectSetup } from '../src/projectSetupGate';
import type { TestInfo } from '../src/types';

function scenario(root: string, file = 'tests/main/scen.yaml'): TestInfo {
    const fsPath = path.join(root, file);
    return { name: 'Sales', uid: '11111111-1111-4111-8111-111111111111', tabName: 'Sales tests', order: 7,
        scenarioDescription: 'Legacy description', yamlFileUri: { fsPath, scheme: 'file', toString: () => pathToFileURL(fsPath).toString() } as TestInfo['yamlFileUri'], relativePath: 'main' };
}

test('pending setup displays legacy groups and cached scenario metadata without migrating project files', async t => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-pending-')));
    t.after(async () => { completeProjectSetup(root); await fs.rm(root, { recursive: true, force: true }); });
    const info = scenario(root);
    await writeSource(info);
    const original = await fs.readFile(info.yamlFileUri.fsPath, 'utf8');
    deferProjectSetup(root);
    const [projected] = await loadProjectScenarioMetadata([info], [root], [path.join(root, 'tests')]);
    assert.equal(projected.tabName, 'Sales tests');
    assert.equal(applyCachedProjectScenarioMetadata(projected, [root], [root]).tabName, 'Sales tests');
    assert.equal(hasCachedProjectScenarioMetadata(projected, [root], [root]), false, 'displayed legacy metadata is not a persisted sidecar');
    const groups = await loadProjectLibraryGroups([root], [root]);
    assert.deepEqual(groups.map(group => group.name), ['Sales tests']);
    const [refreshed] = await reloadProjectScenarioMetadata([projected], [root], [root]);
    assert.equal(refreshed.tabName, 'Sales tests');
    assert.equal(refreshed.scenarioDescription, 'Legacy description');
    assert.equal(refreshed.order, 7);
    assert.equal((await loadProjectLibraryGroups([root], [root]))[0].id, groups[0].id);
    assert.equal(await fs.readFile(info.yamlFileUri.fsPath, 'utf8'), original);
    await assert.rejects(fs.stat(path.join(root, '.kot/groups')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(info.yamlFileUri.fsPath + '.kot.yml'), { code: 'ENOENT' });
    completeProjectSetup(root);
    await loadProjectScenarioMetadata([info], [root], [path.join(root, 'tests')]);
    assert.equal((await loadProjectLibraryGroups([root], [root]))[0].id, groups[0].id);
    assert.equal((await new ProjectLibraryStore(root).read()).legacyImports.includes('scenario'), true);
});

test('pending setup preserves authoritative shared metadata and does not restore a deleted imported record', async t => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-pending-shared-')));
    t.after(async () => { completeProjectSetup(root); await fs.rm(root, { recursive: true, force: true }); });
    const info = scenario(root);
    await writeSource(info);
    await loadProjectScenarioMetadata([info], [root], [root]);
    const identity = resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, 'scenario', info.uid);
    const store = new ProjectLibraryStore(root);
    await store.setMetadata(identity, { groupId: '', description: 'Shared description', order: 2 });
    deferProjectSetup(root);
    const [shared] = await loadProjectScenarioMetadata([info], [root], [root]);
    assert.equal(shared.tabName, 'Ungrouped');
    assert.equal(shared.scenarioDescription, 'Shared description');
    assert.equal(shared.order, 2);
    await store.deleteMetadata(identity);
    const [deleted] = await loadProjectScenarioMetadata([info], [root], [root]);
    assert.equal(deleted.tabName, 'Ungrouped');
    assert.equal(deleted.scenarioDescription, '');
});

test('a scan with unchanged project metadata traverses its source directories only once', async t => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-startup-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const info = scenario(root);
    await writeSource(info);
    await loadProjectScenarioMetadata([info], [root], [path.join(root, 'tests')]);
    const original = fs.readdir;
    let sourceTraversals = 0;
    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
        if (String(args[0]) === path.join(root, 'tests')) { sourceTraversals++; }
        return Reflect.apply(original, fs, args);
    }) as typeof fs.readdir;
    try {
        const [projected] = await loadProjectScenarioMetadata([info], [root], [path.join(root, 'tests')]);
        assert.equal(projected.scenarioDescription, 'Legacy description');
        assert.equal(sourceTraversals, 1);
    } finally { fs.readdir = original; }
});

async function writeSource(info: TestInfo): Promise<void> {
    await fs.mkdir(path.dirname(info.yamlFileUri.fsPath), { recursive: true });
    await fs.writeFile(info.yamlFileUri.fsPath, `${info.kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеСценария'}:\n    UID: "${info.uid ?? ''}"\n    Имя: Sales\n`);
}

test('ungrouped main scenarios and processes do not create a shared group or promote nested scenarios', async t => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-ungrouped-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const main = { ...scenario(root), tabName: undefined, hasTestSettings: true };
    const nested = { ...scenario(root, 'tests/nested/scen.yaml'), uid: 'nested', tabName: undefined };
    const process = { ...scenario(root, 'tests/process/process.yaml'), uid: 'process', kind: 'process' as const, tabName: undefined };
    const [projectedMain, projectedNested, projectedProcess] = await loadProjectScenarioMetadata([main, nested, process], [root], [root]);
    assert.equal(projectedMain.tabName, 'Ungrouped');
    assert.equal(projectedNested.tabName, undefined);
    assert.equal(projectedProcess.tabName, 'Ungrouped');
    const snapshot = await new ProjectLibraryStore(root).read();
    assert.deepEqual(snapshot.groups, []);
    const mainMetadata = Object.values(snapshot.metadata).filter(value => Object.hasOwn(value, 'groupId'));
    assert.equal(mainMetadata.length, 2);
    assert.ok(mainMetadata.every(value => value.groupId === ''));
});

test('scenario metadata imports once, remains authoritative after source saves and travels to a cloned checkout', async () => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-')));
    const clone = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-clone-')));
    try {
        const legacy = scenario(root);
        await writeSource(legacy);
        const [initial] = await loadProjectScenarioMetadata([legacy], [root], [path.join(root, 'tests')]);
        const store = new ProjectLibraryStore(root);
        const snapshot = await store.read();
        assert.equal(snapshot.groups.length, 1);
        assert.equal(initial.tabName, 'Sales tests');
        const identity = resolveProjectEntityIdentity(legacy.yamlFileUri.fsPath, root, 'scenario', legacy.uid);
        await store.renameGroup(snapshot.groups[0].id, 'Shared sales');
        await store.setMetadata(identity, { description: 'Shared description', order: 2 });
        const [projected] = await loadProjectScenarioMetadata([legacy], [root], [path.join(root, 'tests')]);
        assert.equal(projected.tabName, 'Shared sales');
        assert.equal(projected.scenarioDescription, 'Shared description');
        assert.equal(projected.order, 2);
        assert.equal(applyCachedProjectScenarioMetadata(legacy, [root], [path.join(root, 'tests')]).scenarioDescription, 'Shared description');
        await fs.cp(path.join(root, '.kot'), path.join(clone, '.kot'), { recursive: true });
        await fs.cp(path.join(root, 'tests'), path.join(clone, 'tests'), { recursive: true });
        await fs.rename(path.join(clone, 'tests/main'), path.join(clone, 'tests/moved'));
        const [cloned] = await loadProjectScenarioMetadata([scenario(clone, 'tests/moved/scen.yaml')], [clone], [path.join(clone, 'tests')]);
        assert.equal(cloned.tabName, 'Shared sales');
        assert.equal(cloned.scenarioDescription, 'Shared description');
        assert.equal(cloned.order, 7, 'personal override is not copied; legacy initial position remains');
        for (const name of await fs.readdir(path.join(clone, '.kot', 'groups'))) {
            assert.doesNotMatch(await fs.readFile(path.join(clone, '.kot', 'groups', name), 'utf8'), /kot-meta-/u);
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(clone, { recursive: true, force: true }); }
});

test('workspace root owns portable metadata and external test roots own theirs', () => {
    assert.equal(resolveProjectLibraryRoot('/project/tests/a/scen.yaml', ['/project'], ['/project/tests']), '/project');
    assert.equal(resolveProjectLibraryRoot('/external/tests/a/scen.yaml', ['/project'], ['/external/tests']), '/external/tests');
    assert.throws(() => resolveProjectLibraryRoot('/elsewhere/a.yaml', ['/project'], ['/external/tests']));
    assert.equal(resolveProjectEntityIdentity('/project/tests/a.feature', '/project', 'feature').relativePath, 'tests/a.feature');
    assert.throws(() => resolveProjectEntityIdentity('/other/a.feature', '/project', 'feature'));
});

test('shared deletion is not undone by legacy grouping on a later scan', async () => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-delete-')));
    try {
        const legacy = scenario(root);
        await loadProjectScenarioMetadata([legacy], [root], [path.join(root, 'tests')]);
        const store = new ProjectLibraryStore(root);
        const group = (await store.read()).groups[0];
        await store.deleteGroup(group.id);
        const [projected] = await loadProjectScenarioMetadata([legacy], [root], [path.join(root, 'tests')]);
        assert.equal((await store.read()).groups.length, 0);
        assert.notEqual(projected.tabName, legacy.tabName);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('matching business groups across project roots preserve both sections and independently renamed names', async () => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-roots-')));
    const external = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-external-')));
    try {
        await loadProjectScenarioMetadata([scenario(root), { ...scenario(external), kind: 'process' }], [root], [root, external]);
        const groups = await loadProjectLibraryGroups([root], [root, external]);
        assert.equal(groups.length, 1);
        assert.deepEqual([...groups[0].sections].sort(), ['main', 'process']);
        await new ProjectLibraryStore(external).renameGroup(groups[0].id, 'Independent process group');
        const separate = await loadProjectLibraryGroups([root], [root, external]);
        assert.equal(separate.length, 2);
        assert.deepEqual(separate.map(group => group.name).sort(), ['Independent process group', 'Sales tests']);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(external, { recursive: true, force: true }); }
});

test('newly discovered legacy files migrate after the initial scan while deleted known metadata stays deleted', async () => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-new-root-')));
    try {
        const first = scenario(root);
        await loadProjectScenarioMetadata([first], [root], [root]);
        const store = new ProjectLibraryStore(root);
        await store.deleteMetadata(resolveProjectEntityIdentity(first.yamlFileUri.fsPath, root, 'scenario', first.uid));
        const next = { ...scenario(root, 'other-tests/new.yaml'), uid: 'new-uid', tabName: 'New tests', scenarioDescription: 'New legacy description' };
        const [deleted, added] = await loadProjectScenarioMetadata([first, next], [root], [root]);
        assert.equal(deleted.scenarioDescription, '');
        assert.equal(added.scenarioDescription, 'New legacy description');
        assert.equal(added.tabName, 'New tests');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('renaming a business group checks every owning project before making any changes', async () => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-rename-')));
    const other = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-rename-other-')));
    try {
        await loadProjectScenarioMetadata([scenario(root), { ...scenario(other), kind: 'process' }], [root], [root, other]);
        const group = (await loadProjectLibraryGroups([root], [root, other]))[0];
        await assert.rejects(renameProjectLibraryGroup(group.id, group.name, 'Renamed', [root, other], value => {
            if (value === other) { throw new Error('Unsaved project metadata'); }
        }), /Unsaved/u);
        assert.equal((await new ProjectLibraryStore(root).read()).groups[0].name, group.name);
        assert.equal((await new ProjectLibraryStore(other).read()).groups[0].name, group.name);
        await new ProjectLibraryStore(other).ensureGroup('Collision', 'process');
        await assert.rejects(renameProjectLibraryGroup(group.id, group.name, 'Collision', [root, other], () => undefined), /already exists/u);
        assert.equal((await new ProjectLibraryStore(root).read()).groups[0].name, group.name);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true }); }
});

test('duplicate scenario and process UIDs are rejected before any legacy data is written', async () => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-duplicate-')));
    try {
        const first = scenario(root);
        const second = { ...scenario(root, 'tests/second/process.yaml'), kind: 'process' as const, tabName: 'Returns', scenarioDescription: 'Different description' };
        await assert.rejects(loadProjectScenarioMetadata([first, second], [root], [root]), /Duplicate.*UID/u);
        await assert.rejects(fs.stat(path.join(root, '.kot/groups')), { code: 'ENOENT' });
        const store = new ProjectLibraryStore(root);
        await assert.rejects(store.importLegacy({ groups: [], entities: [first, second].map(info => ({
            identity: resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid), metadata: {}
        })) }), /Duplicate.*UID/u);
        await assert.rejects(fs.stat(path.join(root, '.kot/groups')), { code: 'ENOENT' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('project objects inside an external test root cannot match the stock compiler yaml inputs', async () => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-compiler-')));
    try {
        await loadProjectScenarioMetadata([scenario(root)], [], [root]);
        assert.equal((await fs.readdir(path.join(root, '.kot'))).includes('groups'), true);
        const records = await fs.readdir(path.join(root, 'tests/main'));
        assert.deepEqual(records, ['scen.yaml.kot.yml']);
        await assert.rejects(fs.stat(path.join(root, '.kot', 'metadata')), { code: 'ENOENT' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const kind of ['scenario', 'process'] as const) {
    for (const hasUid of [true, false]) {
        test(`${kind} source-only rename preserves adjacent fields and group with${hasUid ? '' : 'out'} UID`, async t => {
            const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-file-rename-')));
            t.after(() => fs.rm(root, { recursive: true, force: true }));
            const previous = { ...scenario(root), kind, ...(hasUid ? {} : { uid: undefined }) };
            const next = { ...scenario(root, 'tests/main/renamed.yaml'), kind, uid: previous.uid };
            await writeSource(previous);
            await loadProjectScenarioMetadata([previous], [root], [path.join(root, 'tests')]);
            const store = new ProjectLibraryStore(root);
            const identity = resolveProjectEntityIdentity(previous.yamlFileUri.fsPath, root, kind, previous.uid);
            await store.setMetadata(identity, { category: 'Sales category' });
            await fs.rename(previous.yamlFileUri.fsPath, next.yamlFileUri.fsPath);
            await remapProjectScenarioMetadata(previous, next, [root], [path.join(root, 'tests')]);
            await assert.rejects(fs.stat(`${previous.yamlFileUri.fsPath}.kot.yml`), { code: 'ENOENT' });
            const [projected] = await loadProjectScenarioMetadata([next], [root], [path.join(root, 'tests')]);
            assert.equal(projected.tabName, 'Sales tests');
            assert.equal(projected.order, 7);
            assert.equal(projected.scenarioDescription, 'Legacy description');
            assert.equal(projected.scenarioCategory, 'Sales category');
            assert.equal(applyCachedProjectScenarioMetadata(next, [root], [path.join(root, 'tests')]).scenarioCategory, 'Sales category');
        });
    }
}

test('carried scenario folder metadata is unchanged after a rename notification', async t => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-folder-rename-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const previous = scenario(root);
    const next = scenario(root, 'tests/moved/scen.yaml');
    await writeSource(previous);
    await loadProjectScenarioMetadata([previous], [root], [path.join(root, 'tests')]);
    const bytes = await fs.readFile(`${previous.yamlFileUri.fsPath}.kot.yml`, 'utf8');
    await fs.rename(path.dirname(previous.yamlFileUri.fsPath), path.dirname(next.yamlFileUri.fsPath));
    await remapProjectScenarioMetadata(previous, next, [root], [path.join(root, 'tests')]);
    assert.equal(await fs.readFile(`${next.yamlFileUri.fsPath}.kot.yml`, 'utf8'), bytes);
    assert.equal((await loadProjectScenarioMetadata([next], [root], [path.join(root, 'tests')]))[0].tabName, 'Sales tests');
});

for (const carried of [true, false]) {
    test(`cross-project ${carried ? 'folder' : 'source-only'} move uses the destination group ID`, async t => {
        const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-move-old-')));
        const target = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-move-new-')));
        t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(target, { recursive: true, force: true }); });
        const previous = scenario(root);
        const next = scenario(target);
        await writeSource(previous);
        await loadProjectScenarioMetadata([previous], [root, target], [root, target]);
        const store = new ProjectLibraryStore(target);
        const group = await store.ensureGroup('Sales tests', 'main');
        await fs.mkdir(path.dirname(path.dirname(next.yamlFileUri.fsPath)), { recursive: true });
        if (carried) { await fs.rename(path.dirname(previous.yamlFileUri.fsPath), path.dirname(next.yamlFileUri.fsPath)); }
        else { await fs.mkdir(path.dirname(next.yamlFileUri.fsPath)); await fs.rename(previous.yamlFileUri.fsPath, next.yamlFileUri.fsPath); }
        await remapProjectScenarioMetadata(previous, next, [root, target], [root, target]);
        const identity = resolveProjectEntityIdentity(next.yamlFileUri.fsPath, target, 'scenario', next.uid);
        assert.equal((await store.read()).metadata[`uid:${next.uid}`].groupId, group.id);
        assert.ok(await fs.stat(store.metadataFilePath(identity)));
        await assert.rejects(fs.stat(`${previous.yamlFileUri.fsPath}.kot.yml`), { code: 'ENOENT' });
        const [projected] = await loadProjectScenarioMetadata([next], [root, target], [root, target]);
        assert.equal(projected.tabName, 'Sales tests');
        assert.equal(projected.scenarioDescription, 'Legacy description');
        assert.equal(projected.order, 7);
    });
}

test('cross-project rename rejects independent destination metadata without changing either record', async t => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-conflict-old-')));
    const target = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-meta-conflict-new-')));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(target, { recursive: true, force: true }); });
    const previous = scenario(root);
    const next = scenario(target);
    await writeSource(previous);
    await writeSource(next);
    await loadProjectScenarioMetadata([previous], [root, target], [root, target]);
    const store = new ProjectLibraryStore(target);
    await store.setMetadata(resolveProjectEntityIdentity(next.yamlFileUri.fsPath, target, 'scenario', next.uid), { description: 'Destination description' });
    await fs.rm(previous.yamlFileUri.fsPath);
    const oldText = await fs.readFile(`${previous.yamlFileUri.fsPath}.kot.yml`, 'utf8');
    const targetText = await fs.readFile(`${next.yamlFileUri.fsPath}.kot.yml`, 'utf8');
    await assert.rejects(remapProjectScenarioMetadata(previous, next, [root, target], [root, target]), /already.*metadata|conflict/i);
    assert.equal(await fs.readFile(`${previous.yamlFileUri.fsPath}.kot.yml`, 'utf8'), oldText);
    assert.equal(await fs.readFile(`${next.yamlFileUri.fsPath}.kot.yml`, 'utf8'), targetText);
});
