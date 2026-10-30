import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { ProjectLibraryStore, projectEntityKey, type ProjectEntityIdentity } from '../src/projectLibraryStore';

async function fixture(t: test.TestContext) {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-sharded-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new ProjectLibraryStore(root);
    const identity: ProjectEntityIdentity = { kind: 'scenario', uid: 'first', relativePath: 'tests/first/meta.yaml' };
    await fs.mkdir(path.join(root, 'tests/first'), { recursive: true });
    await fs.writeFile(path.join(root, identity.relativePath), 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: first\n    Имя: First\n');
    await fs.writeFile(path.join(root, 'tests/first/scen.feature'), 'И шаг\n');
    return { root, store, identity };
}
async function files(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const visit = async (directory: string) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) { await visit(file); }
            else { result[path.relative(root, file)] = await fs.readFile(file, 'utf8'); }
        }
    };
    await visit(root); return result;
}

test('independent groups use separate files without a central groups list or persisted display order', async t => {
    const f = await fixture(t);
    const first = await f.store.ensureGroup('First', 'main', 'first-group');
    const firstPath = path.join(f.root, '.kot/groups/first-group.yml');
    const text = await fs.readFile(firstPath, 'utf8');
    assert.deepEqual(parse(text), { version: 1, id: first.id, name: 'First', sections: ['main'] });
    await f.store.ensureGroup('Second', 'main', 'second-group');
    assert.equal(await fs.readFile(firstPath, 'utf8'), text);
    assert.equal(await fs.stat(path.join(f.root, '.kot/groups.yml')).then(() => true, () => false), false);
    assert.equal((await new ProjectLibraryStore(f.root).readGroups()).length, 2);
});

test('new scenario metadata never appends to a common registry or rewrites group records', async t => {
    const f = await fixture(t);
    const group = await f.store.ensureGroup('Shared', 'main', 'shared');
    const before = await files(path.join(f.root, '.kot'));
    await f.store.setMetadata(f.identity, { groupId: group.id, description: 'First' });
    assert.deepEqual(await files(path.join(f.root, '.kot')), before);
    await f.store.setMetadata(f.identity, { description: 'Changed' });
    assert.deepEqual(await files(path.join(f.root, '.kot')), before);
    assert.ok((await f.store.read()).knownScenarioKeys?.includes(projectEntityKey(f.identity)));
});

test('deleting a newly known record retains per-object history without touching groups', async t => {
    const f = await fixture(t);
    await f.store.importLegacy({ groups: [], entities: [] });
    await f.store.setMetadata(f.identity, { description: 'Do not resurrect' });
    const imports = await fs.readFile(path.join(f.root, '.kot/imports.yml'), 'utf8');
    await f.store.deleteMetadata(f.identity);
    await f.store.seedLegacyEntity(f.identity, { description: 'Old value' }, { name: 'Old group', section: 'main' });
    const after = await f.store.read();
    assert.equal(after.metadata[projectEntityKey(f.identity)], undefined);
    assert.deepEqual(after.groups, []);
    assert.equal(await fs.readFile(path.join(f.root, '.kot/imports.yml'), 'utf8'), imports);
    assert.ok(Object.keys(await files(path.join(f.root, '.kot/history'))).length > 0);
});

test('misplaced or duplicate group records are rejected without changes', async t => {
    const f = await fixture(t);
    await f.store.ensureGroup('Sales', 'main', 'sales');
    await fs.copyFile(path.join(f.root, '.kot/groups/sales.yml'), path.join(f.root, '.kot/groups/another.yml'));
    const before = await files(path.join(f.root, '.kot'));
    await assert.rejects(f.store.read(), /Duplicate|misplaced/u);
    assert.deepEqual(await files(path.join(f.root, '.kot')), before);
});

test('failed group deletion restores the group and changed memberships', async t => {
    const f = await fixture(t);
    await f.store.ensureGroup('One', 'main', 'one');
    await f.store.setMetadata(f.identity, { groupId: 'one' });
    const before = await files(f.root); const unlink = fs.unlink;
    fs.unlink = async file => { if (String(file).endsWith('/groups/one.yml')) { throw new Error('Simulated deletion failure'); } return unlink(file); };
    try { await assert.rejects(f.store.deleteGroup('one'), /Simulated deletion failure/u); }
    finally { fs.unlink = unlink; }
    assert.deepEqual(await files(f.root), before);
    await f.store.deleteGroup('one'); assert.deepEqual((await f.store.read()).groups, []);
});

test('group IDs produce portable distinct filenames even for Windows reserved names and case variants', async t => {
    const f = await fixture(t);
    for (const [index, id] of ['con', 'CON', 'aux.data', 'Case', 'case', 'unsafe*id'].entries()) {
        await f.store.ensureGroup('Group ' + index, 'main', id);
    }
    const names = await fs.readdir(path.join(f.root, '.kot/groups'));
    assert.equal(new Set(names.map(name => name.toLowerCase())).size, 6);
    assert.ok(names.every(name => !/[*:<>?"|]/u.test(name) && !/^(?:con|aux)(?:\.|$)/iu.test(name)));
    assert.equal((await f.store.readGroups()).length, 6);
});
