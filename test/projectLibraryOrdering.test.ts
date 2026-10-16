import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectLibraryStore, projectEntityKey, type ProjectEntityIdentity } from '../src/projectLibraryStore';

async function fixture(t: test.TestContext, kind: ProjectEntityIdentity['kind'] = 'scenario') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-order-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new ProjectLibraryStore(root);
    const section = kind === 'feature' ? 'standalone' : kind === 'process' ? 'process' : 'main';
    const group = await store.ensureGroup('First', section);
    const other = await store.ensureGroup('Second', section);
    const identities = ['a', 'b', 'c'].map(name => ({ kind, relativePath: `${name}.${kind === 'feature' ? 'feature' : 'yaml'}`,
        ...(kind === 'feature' ? {} : { uid: name }) }));
    for (const [order, identity] of identities.entries()) {
        await fs.writeFile(path.join(root, identity.relativePath), kind === 'feature' ? 'Feature: test\nScenario: test\n Given step\n'
            : `${kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеСценария'}:\n  UID: ${identity.uid}\n  Имя: ${identity.uid}\n  Шаги:\n    - Second\n    - First\n`);
        await store.setMetadata(identity, { groupId: group.id, order, description: `Description ${order}` });
    }
    return { root, store, section, group, other, identities, expected: identities.map((identity, order) => ({ key: projectEntityKey(identity), order })) };
}

for (const kind of ['scenario', 'process', 'feature'] as const) {
    test(`${kind} content drag shares adjacent order without changing source or group order`, async t => {
        const f = await fixture(t, kind);
        const source = await fs.readFile(path.join(f.root, f.identities[2].relativePath), 'utf8');
        const groups = await fs.readFile(path.join(f.root, '.kot', 'groups.yml'), 'utf8');
        await f.store.moveEntity(f.section, f.identities[2], f.group.id, f.expected[0].key, f.expected, f.expected);
        const clone = new ProjectLibraryStore(f.root);
        const snapshot = await clone.read();
        assert.deepEqual(f.identities.map(identity => snapshot.metadata[projectEntityKey(identity)].order), [1, 2, 0]);
        assert.equal(snapshot.metadata[f.expected[2].key].description, 'Description 2');
        assert.equal(await fs.readFile(path.join(f.root, f.identities[2].relativePath), 'utf8'), source);
        assert.equal(await fs.readFile(path.join(f.root, '.kot', 'groups.yml'), 'utf8'), groups);
        assert.match(await fs.readFile(clone.metadataFilePath(f.identities[2]), 'utf8'), /order: 0/u);
    });
}

test('content drag can change shared membership and rejects stale or malformed drops before writing', async t => {
    const f = await fixture(t);
    await f.store.moveEntity('main', f.identities[1], f.other.id, undefined, f.expected, []);
    const after = await f.store.read();
    assert.equal(after.metadata[f.expected[1].key].groupId, f.other.id);
    assert.deepEqual(f.identities.map(identity => after.metadata[projectEntityKey(identity)].order), [0, 0, 1]);
    const invalid = [
        () => f.store.moveEntity('main', f.identities[0], f.group.id, f.expected[2].key, f.expected, f.expected),
        () => f.store.moveEntity('process', f.identities[0], f.group.id, undefined, [], []),
        () => f.store.moveEntity('main', { ...f.identities[0], relativePath: '../foreign.yaml' }, f.group.id, undefined, [], []),
        () => f.store.moveEntity('main', { ...f.identities[0], uid: 'foreign' }, f.group.id, undefined, [], []),
        () => f.store.moveEntity('main', f.identities[0], 'missing', undefined, [], []),
        () => f.store.moveEntity('main', f.identities[0], f.group.id, 'foreign', [{ key: f.expected[0].key, order: 0 }, { key: f.expected[2].key, order: 1 }], [{ key: f.expected[0].key, order: 0 }, { key: f.expected[2].key, order: 1 }])
    ];
    for (const operation of invalid) { await assert.rejects(operation); assert.deepEqual(await f.store.read(), after); }
});

test('content drag honors dirty metadata guard and rejects deleted source ownership', async t => {
    const f = await fixture(t);
    const guarded = new ProjectLibraryStore(f.root, { beforeWrite: () => { throw new Error('Save metadata first'); } });
    await assert.rejects(guarded.moveEntity('main', f.identities[1], f.group.id, f.expected[0].key, f.expected, f.expected), /Save metadata first/u);
    assert.deepEqual((await f.store.read()).metadata[f.expected[1].key].order, 1);
    await fs.unlink(path.join(f.root, f.identities[1].relativePath));
    await assert.rejects(f.store.moveEntity('main', f.identities[1], f.group.id, undefined, f.expected, f.expected));
});

test('metadata-only ordering reads known sidecars without walking unrelated corpus directories', async t => {
    const f = await fixture(t);
    const store = new ProjectLibraryStore(f.root, { sourceIdentities: f.identities });
    const original = fs.readdir;
    const directories: string[] = [];
    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
        directories.push(String(args[0]));
        return original(...args);
    }) as typeof fs.readdir;
    try {
        const snapshot = await (store as any).moveEntity('main', f.identities[2], f.group.id, f.expected[0].key, f.expected, f.expected);
        assert.equal(snapshot.metadata[f.expected[2].key].order, 0);
        await (store as any).readMetadata();
        assert.ok(directories.every(directory => directory === path.join(f.root, '.kot', 'metadata')), directories.join('\n'));
    } finally { fs.readdir = original; }
});

test('a partial ordering write failure restores all previously written adjacent metadata', async t => {
    const f = await fixture(t);
    const before = await f.store.read();
    const store = new ProjectLibraryStore(f.root, { sourceIdentities: f.identities });
    const rename = fs.rename;
    let writes = 0;
    fs.rename = async (from, to) => {
        if (String(from).endsWith('.tmp') && ++writes === 2) { throw new Error('Disk write failed'); }
        return rename(from, to);
    };
    try { await assert.rejects(store.moveEntity('main', f.identities[2], f.group.id, f.expected[0].key, f.expected, f.expected), /Disk write failed/u); }
    finally { fs.rename = rename; }
    assert.deepEqual(await f.store.read(), before);
});
