import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import {
    ProjectLibraryStore,
    projectEntityKey,
    type ProjectEntityIdentity
} from '../src/projectLibraryStore';

async function root(t: test.TestContext): Promise<string> {
    const directory = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-project-library-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

const scenario: ProjectEntityIdentity = { kind: 'scenario', uid: 'ABC-123', relativePath: 'tests/a/scen.yaml' };
const feature: ProjectEntityIdentity = { kind: 'feature', relativePath: 'features/smoke.feature' };

test('metadata writes report actual completed files in each stage', async t => {
    const directory = await root(t);
    const progress: Array<{ label: string; completed?: number; total?: number }> = [];
    const store = new ProjectLibraryStore(directory, { onProgress: value => progress.push({ ...value }) });
    await store.importLegacy({ groups: [], entities: [{ identity: scenario, metadata: { description: 'Imported' } }] });
    for (const label of ['Preparing project metadata…', 'Writing project metadata…']) {
        const stage = progress.filter(value => value.label === label);
        assert.ok(stage.length > 1, label);
        assert.equal(stage[0].completed, 0);
        assert.ok(stage[0].total! > 0);
        assert.deepEqual(stage.map(value => value.completed), Array.from({ length: stage[0].total! + 1 }, (_, index) => index));
    }
});

test('project identities remain portable and scenario metadata follows its UID after a move', async t => {
    const firstRoot = await root(t);
    const secondRoot = await root(t);
    const first = new ProjectLibraryStore(firstRoot);
    const group = await first.ensureGroup('Sales', 'main');
    await first.setMetadata(scenario, { groupId: group.id, order: 4, description: 'Shared description' });
    await first.setMetadata(feature, { groupId: '', category: 'Smoke' });
    await fs.cp(firstRoot, secondRoot, { recursive: true });
    const cloned = new ProjectLibraryStore(secondRoot);
    const originalSnapshot = await first.read();
    const { order: _personal, ...sharedMetadata } = originalSnapshot.metadata[projectEntityKey(scenario)];
    assert.deepEqual((await cloned.read()).metadata[projectEntityKey(scenario)], sharedMetadata);
    const moved = { ...scenario, uid: 'abc-123', relativePath: 'tests/renamed/scen.yaml' };
    assert.equal(projectEntityKey(moved), projectEntityKey(scenario));
    await cloned.setMetadata(moved, { description: 'Updated' });
    const snapshot = await cloned.read();
    assert.equal(snapshot.metadata[projectEntityKey(moved)].groupId, group.id);
    assert.equal(snapshot.metadata[projectEntityKey(moved)].order, undefined);
    assert.equal(snapshot.identities[projectEntityKey(moved)].relativePath, moved.relativePath);
    await assert.rejects(fs.stat(cloned.metadataFilePath(scenario)), { code: 'ENOENT' });
    for (const identity of [moved, feature]) {
        const text = await fs.readFile(cloned.metadataFilePath(identity), 'utf8');
        assert.ok(!text.includes(firstRoot) && !text.includes(secondRoot));
    }
});

test('empty groups persist and main/process sections share a stable business group', async t => {
    const store = new ProjectLibraryStore(await root(t));
    const main = await store.ensureGroup('Sales', 'main', 'legacy-sales');
    const process = await store.ensureGroup('Sales', 'process');
    const standalone = await store.ensureGroup('Sales', 'standalone');
    assert.equal(main.id, process.id);
    assert.notEqual(standalone.id, main.id);
    const renamed = await store.renameGroup(main.id, 'Commercial');
    assert.equal(renamed.id, main.id);
    const groups = (await store.read()).groups;
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.find(value => value.id === main.id)?.sections, ['main', 'process']);
    assert.equal(groups.find(value => value.id === main.id)?.name, 'Commercial');
});

test('reading an untouched project does not create shared objects', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    assert.deepEqual(await store.read(), { groups: [], metadata: {}, identities: {}, legacyImports: [], knownScenarioKeys: [] });
    await assert.rejects(fs.stat(path.join(directory, '.kot/groups')), { code: 'ENOENT' });
});

test('an imported group name reuses the shared group identity and preserves its order', async t => {
    const store = new ProjectLibraryStore(await root(t));
    const shared = await store.ensureGroup('Sales', 'main', 'shared-sales');
    await store.importLegacy({
        groups: [{ id: 'legacy-sales', name: 'Sales', sections: ['main'], order: 40 }],
        entities: [{ identity: scenario, metadata: { groupId: 'legacy-sales' } }]
    });
    const snapshot = await store.read();
    assert.equal(snapshot.groups.length, 1);
    assert.equal(snapshot.groups[0].order, shared.order);
    assert.equal(snapshot.metadata[projectEntityKey(scenario)].groupId, shared.id);
});

test('importing a process into an existing main group adds its section while preserving shared identity and order', async t => {
    const store = new ProjectLibraryStore(await root(t));
    const shared = await store.ensureGroup('Sales', 'main', 'shared-sales');
    const process: ProjectEntityIdentity = { kind: 'process', uid: 'process-sales', relativePath: 'tests/sales/process.yaml' };
    await store.importLegacy({
        groups: [{ id: 'legacy-sales', name: 'Sales', sections: ['process'], order: 40 }],
        entities: [{ identity: process, metadata: { groupId: 'legacy-sales' } }]
    });
    const snapshot = await store.read();
    assert.deepEqual(snapshot.groups, [{ ...shared, sections: ['main', 'process'] }]);
    assert.equal(snapshot.metadata[projectEntityKey(process)].groupId, shared.id);
});

test('legacy imports run independently once per source and never restore Git deletions', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    const group = await store.ensureGroup('Shared', 'main', 'shared');
    await store.setMetadata(scenario, { groupId: group.id, description: 'Git wins' });
    const legacy = { groups: [{ id: 'old', name: 'Old', sections: ['main' as const], order: 8 }], entities: [
        { identity: scenario, metadata: { groupId: 'old', description: 'Legacy' } },
        { identity: { ...scenario, uid: 'new', relativePath: 'tests/new/scen.yaml' }, metadata: { groupId: 'old' } }
    ] };
    await store.importLegacy(legacy);
    assert.equal((await store.read()).metadata[projectEntityKey(scenario)].description, 'Git wins');
    await store.importLegacy({ groups: [{ id: 'local-feature', name: 'Local', sections: ['standalone'], order: 1 }], entities: [{ identity: feature, metadata: { groupId: 'local-feature' } }] }, 'standalone');
    assert.deepEqual((await store.read()).legacyImports, ['scenario', 'standalone']);
    await store.deleteMetadata({ ...scenario, uid: 'new' });
    await store.deleteGroup('old');
    await store.importLegacy(legacy);
    const snapshot = await store.read();
    assert.equal(snapshot.groups.some(item => item.id === 'old'), false);
    assert.equal(snapshot.metadata[projectEntityKey({ ...scenario, uid: 'new' })], undefined);
});

test('bootstrapping one legacy scenario preserves all its fields without completing the project-wide import', async t => {
    const store = new ProjectLibraryStore(await root(t));
    await store.seedLegacyEntity(scenario, { description: 'Legacy description', category: 'Legacy category', order: 7 },
        { name: 'Legacy sales', section: 'main' });
    const snapshot = await store.read();
    assert.deepEqual(snapshot.legacyImports, []);
    assert.equal(snapshot.groups[0].name, 'Legacy sales');
    assert.deepEqual(snapshot.metadata[projectEntityKey(scenario)], {
        groupId: snapshot.groups[0].id, description: 'Legacy description', category: 'Legacy category', order: 7
    });
    await store.importLegacy({ groups: [], entities: [{ identity: { ...scenario, uid: 'another', relativePath: 'tests/another/scen.yaml' }, metadata: { description: 'Bulk import still works' } }] });
    assert.equal((await store.read()).metadata[projectEntityKey({ ...scenario, uid: 'another' })].description, 'Bulk import still works');
});

test('legacy bootstrap preserves an existing shared record and never creates its proposed group', async t => {
    const store = new ProjectLibraryStore(await root(t));
    await store.setMetadata(scenario, { description: 'Shared wins', groupId: '', order: 1 });
    await store.seedLegacyEntity(scenario, { description: 'Old legacy', order: 7 }, { name: 'Do not create', section: 'main' });
    const snapshot = await store.read();
    assert.deepEqual(snapshot.groups, []);
    assert.deepEqual(snapshot.metadata[projectEntityKey(scenario)], { description: 'Shared wins', groupId: '', order: 1 });
});

test('legacy bootstrap cannot resurrect a record or group after the scenario import marker', async t => {
    const store = new ProjectLibraryStore(await root(t));
    await store.importLegacy({ groups: [], entities: [{ identity: scenario, metadata: { description: 'Imported' } }] });
    await store.deleteMetadata(scenario);
    await store.seedLegacyEntity(scenario, { description: 'Do not restore' }, { name: 'Deleted group', section: 'process' });
    const snapshot = await store.read();
    assert.deepEqual(snapshot.groups, []);
    assert.equal(snapshot.metadata[projectEntityKey(scenario)], undefined);
    assert.deepEqual(snapshot.legacyImports, ['scenario']);
});

test('an unseen legacy scenario from a new scan root can be seeded after the project-wide import', async t => {
    const store = new ProjectLibraryStore(await root(t));
    await store.importLegacy({ groups: [], entities: [{ identity: scenario, metadata: { description: 'Original root' } }] });
    const newlyDiscovered = { ...scenario, uid: 'new-scan-root-uid', relativePath: 'different-tests/main/scen.yaml' };
    await store.seedLegacyEntity(newlyDiscovered, { description: 'New root description', category: 'Sales', order: 4 },
        { name: 'New root sales', section: 'main' });
    const snapshot = await store.read();
    assert.equal(snapshot.metadata[projectEntityKey(newlyDiscovered)].description, 'New root description');
    assert.equal(snapshot.groups[0].name, 'New root sales');
    assert.deepEqual(snapshot.knownScenarioKeys, [projectEntityKey(scenario), projectEntityKey(newlyDiscovered)].sort());
    assert.deepEqual(snapshot.legacyImports, ['scenario']);
});


test('the scenario ledger keeps both path identities after moving a legacy file without a UID', async t => {
    const store = new ProjectLibraryStore(await root(t));
    const original: ProjectEntityIdentity = { kind: 'scenario', relativePath: 'tests/old/scen.yaml' };
    const renamed = { ...original, relativePath: 'tests/new/scen.yaml' };
    await store.setMetadata(original, { description: 'No UID' });
    await store.remapEntity(original, renamed, true);
    assert.deepEqual((await store.read()).knownScenarioKeys, [projectEntityKey(original), projectEntityKey(renamed)].sort());
    await store.deleteMetadata(renamed);
    await store.seedLegacyEntity(original, { description: 'Do not restore the old filename' });
    await store.seedLegacyEntity(renamed, { description: 'Do not restore the deleted destination' });
    assert.deepEqual((await store.read()).metadata, {});
});

test('deleting a group preserves explicit ungrouped membership and unrelated metadata', async t => {
    const store = new ProjectLibraryStore(await root(t));
    const group = await store.ensureGroup('Sales', 'main');
    await store.setMetadata(scenario, { groupId: group.id, description: 'Keep', category: 'Sales', order: 0 });
    await store.deleteGroup(group.id);
    assert.deepEqual((await store.read()).metadata[projectEntityKey(scenario)], { groupId: '', description: 'Keep', category: 'Sales' });
    await store.setMetadata(scenario, { description: '', category: '', order: null });
    assert.deepEqual((await store.read()).metadata[projectEntityKey(scenario)], { groupId: '', description: '', category: '' });
});

test('independent store instances serialize mutations without dropping groups or fields', async t => {
    const directory = await root(t);
    const first = new ProjectLibraryStore(directory);
    const second = new ProjectLibraryStore(directory);
    await Promise.all([first.ensureGroup('Sales', 'main'), second.ensureGroup('Stock', 'process')]);
    await Promise.all([first.setMetadata(scenario, { description: 'Description' }), second.setMetadata(scenario, { category: 'Category', order: 2 })]);
    assert.equal((await first.read()).groups.length, 2);
    assert.deepEqual((await first.read()).metadata[projectEntityKey(scenario)], { description: 'Description', category: 'Category', order: 2 });
});

test('external valid YAML edits are reread by the next mutation', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    const group = await store.ensureGroup('Sales', 'main');
    const file = path.join(directory, '.kot', 'groups', group.id + '.yml');
    const document = parse(await fs.readFile(file, 'utf8'));
    document.name = 'Git renamed';
    await fs.writeFile(file, stringify(document));
    await store.ensureGroup('Stock', 'process');
    assert.equal((await store.read()).groups.find(item => item.id === group.id)?.name, 'Git renamed');
});

test('invalid, conflicted and unsupported group YAML is reported and preserved', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    await fs.mkdir(path.join(directory, '.kot/groups'), { recursive: true });
    const file = path.join(directory, '.kot/groups/invalid.yml');
    for (const content of ['<<<<<<< HEAD\nversion: 1\n=======\nversion: 2\n>>>>>>> branch\n', 'version: 8\ngroups: []\n', 'version: 1\ngroups: []\nunknownSetting: true\n', 'version: 1\nversion: 1\ngroups: []\n']) {
        await fs.writeFile(file, content);
        await assert.rejects(store.ensureGroup('Do not overwrite', 'main'));
        assert.equal(await fs.readFile(file, 'utf8'), content);
    }
});

test('an invalid bulk import never writes any part of its groups or records', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    await assert.rejects(store.importLegacy({
        groups: [{ id: 'sales', name: 'Sales', sections: ['main'], order: 0 }],
        entities: [
            { identity: scenario, metadata: { groupId: 'sales' } },
            { identity: { kind: 'scenario', relativePath: '../invalid.yaml' }, metadata: {} }
        ]
    }));
    assert.deepEqual(await store.read(), { groups: [], metadata: {}, identities: {}, legacyImports: [], knownScenarioKeys: [] });
    await assert.rejects(fs.stat(path.join(directory, '.kot/groups')), { code: 'ENOENT' });
});

test('invalid metadata prevents a mutation without rewriting any shared object', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    await store.setMetadata(scenario, { description: 'Original' });
    const file = store.metadataFilePath(scenario);
    const invalid = 'version: 1\nidentity:\n  kind: scenario\n  relativePath: ../outside.yaml\nmetadata: {}\n';
    await fs.writeFile(file, invalid);
    await assert.rejects(store.setMetadata(scenario, { description: 'Change' }));
    assert.equal(await fs.readFile(file, 'utf8'), invalid);
});

test('relative identities reject absolute paths, traversal and machine-specific fields', async t => {
    const store = new ProjectLibraryStore(await root(t));
    for (const relativePath of ['/Users/someone/tests/a.yaml', 'C:\\Users\\someone\\a.yaml', '../tests/a.yaml', 'tests/../a.yaml', '\\\\server\\share\\a.yaml']) {
        await assert.rejects(store.setMetadata({ kind: 'scenario', relativePath }, { description: 'Reject' }));
    }
    await assert.rejects(store.setMetadata(scenario, { jsonPath: '/Users/local/launch.json' } as never));
    assert.deepEqual(await store.read(), { groups: [], metadata: {}, identities: {}, legacyImports: [], knownScenarioKeys: [] });
});

test('remapping a standalone feature preserves its metadata and removes the old portable record', async t => {
    const store = new ProjectLibraryStore(await root(t));
    await store.setMetadata(feature, { description: 'Keep', order: 2 });
    const renamed = { ...feature, relativePath: 'features/new.feature' };
    await store.remapEntity(feature, renamed);
    const snapshot = await store.read();
    assert.equal(snapshot.metadata[projectEntityKey(feature)], undefined);
    assert.deepEqual(snapshot.metadata[projectEntityKey(renamed)], { description: 'Keep', order: 2 });
});

test('remapping into an existing shared feature preserves the destination metadata', async t => {
    const store = new ProjectLibraryStore(await root(t));
    const renamed = { ...feature, relativePath: 'features/new.feature' };
    await store.setMetadata(feature, { description: 'Old', order: 2 });
    await store.setMetadata(renamed, { description: 'Git destination', order: 4 });
    await store.remapEntity(feature, renamed);
    const snapshot = await store.read();
    assert.equal(snapshot.metadata[projectEntityKey(feature)], undefined);
    assert.deepEqual(snapshot.metadata[projectEntityKey(renamed)], { description: 'Git destination', order: 4 });
});

test('an explicit feature file rename replaces a retained destination record with the source metadata', async t => {
    const store = new ProjectLibraryStore(await root(t));
    const renamed = { ...feature, relativePath: 'features/previously-deleted.feature' };
    const group = await store.ensureGroup('Current smoke', 'standalone');
    const source = { groupId: group.id, description: 'Current source', order: 2 };
    await store.setMetadata(feature, source);
    await store.setMetadata(renamed, { description: 'Retained deleted target', category: 'Old target', order: 4 });
    await store.remapEntity(feature, renamed, true);
    const snapshot = await store.read();
    assert.equal(snapshot.metadata[projectEntityKey(feature)], undefined);
    assert.deepEqual(snapshot.metadata[projectEntityKey(renamed)], source);
    assert.deepEqual(snapshot.identities[projectEntityKey(renamed)], renamed);
});

test('external edits during a write cause a conflict and remain intact', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    await store.setMetadata(scenario, { description: 'Original' });
    const file = store.metadataFilePath(scenario);
    const metadataDirectory = path.dirname(file);
    const document = parse(await fs.readFile(file, 'utf8'));
    document.metadata.description = 'External edit';
    const externallyEdited = stringify(document);
    const mkdir = fs.mkdir;
    let intercepted = false;
    fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
        if (!intercepted && args[0] === metadataDirectory) {
            intercepted = true;
            await fs.writeFile(file, externallyEdited);
        }
        return mkdir(...args);
    }) as typeof fs.mkdir;
    try {
        await assert.rejects(store.setMetadata(scenario, { description: 'Do not overwrite' }), /conflict/i);
    } finally {
        fs.mkdir = mkdir;
    }
    assert.equal(intercepted, true);
    assert.equal(await fs.readFile(file, 'utf8'), externallyEdited);
});
