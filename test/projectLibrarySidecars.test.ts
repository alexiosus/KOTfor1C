import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deferProjectSetup, completeProjectSetup } from '../src/projectSetupGate';
import { parse, stringify } from 'yaml';
import { ProjectLibraryStore, metadataFilePath, projectEntityKey, type ProjectEntityIdentity } from '../src/projectLibraryStore';

async function root(t: test.TestContext): Promise<string> {
    const directory = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-adjacent-library-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}
async function write(rootPath: string, relativePath: string, text: string): Promise<string> {
    const file = path.join(rootPath, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
}
async function source(rootPath: string, identity: ProjectEntityIdentity): Promise<void> {
    await write(rootPath, identity.relativePath, identity.kind === 'feature' ? '# language: en\nFeature: Sales\n'
        : `${identity.kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеСценария'}:\n    UID: "${identity.uid ?? ''}"\n    Имя: Sales\n`);
}
async function central(rootPath: string, identity: ProjectEntityIdentity, description = 'Central'): Promise<string> {
    return write(rootPath, `.kot/metadata/${createHash('sha256').update(projectEntityKey(identity)).digest('hex')}.yml`,
        stringify({ version: 1, identity, metadata: { description } }));
}
const scenario: ProjectEntityIdentity = { kind: 'scenario', uid: 'sales-uid', relativePath: 'tests/sales/scen.yaml' };

test('test metadata uses the complete source filename and a path-free adjacent version 2 identity', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    await source(directory, scenario);
    assert.equal(metadataFilePath(directory, scenario), path.join(directory, 'tests/sales/scen.yaml.kot.yml'));
    await store.setMetadata(scenario, { description: 'Shared' });
    const document = parse(await fs.readFile(store.metadataFilePath(scenario), 'utf8'));
    assert.deepEqual(document, { version: 2, identity: { kind: 'scenario', uid: 'sales-uid' }, metadata: { description: 'Shared' } });
    await assert.rejects(fs.stat(path.join(directory, '.kot/metadata')), { code: 'ENOENT' });
});

test('central records migrate only after source validation and sidecar creation', async t => {
    const directory = await root(t);
    await source(directory, scenario);
    const oldFile = await central(directory, scenario);
    const store = new ProjectLibraryStore(directory);
    assert.equal((await store.read()).metadata[projectEntityKey(scenario)].description, 'Central');
    assert.equal(parse(await fs.readFile(store.metadataFilePath(scenario), 'utf8')).version, 2);
    await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' });
});

test('valid adjacent metadata wins over the same central identity without being rewritten', async t => {
    const directory = await root(t);
    await source(directory, scenario);
    const oldFile = await central(directory, scenario);
    const adjacent = stringify({ version: 2, identity: { kind: 'scenario', uid: scenario.uid }, metadata: { description: 'Adjacent wins' } });
    const file = await write(directory, `${scenario.relativePath}.kot.yml`, adjacent);
    const store = new ProjectLibraryStore(directory);
    assert.equal((await store.read()).metadata[projectEntityKey(scenario)].description, 'Adjacent wins');
    assert.equal(await fs.readFile(file, 'utf8'), adjacent);
    await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' });
});

test('central UID records follow a moved source and reject ambiguous duplicate sources', async t => {
    const directory = await root(t);
    const moved = { ...scenario, relativePath: 'tests/moved/scen.yaml' };
    await source(directory, moved);
    const oldFile = await central(directory, scenario);
    const store = new ProjectLibraryStore(directory);
    assert.deepEqual((await store.read()).identities[projectEntityKey(scenario)], moved);
    assert.equal(parse(await fs.readFile(store.metadataFilePath(moved), 'utf8')).metadata.description, 'Central');
    await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' });
    await fs.rm(store.metadataFilePath(moved));
    const retained = await central(directory, scenario);
    await source(directory, { ...scenario, relativePath: 'tests/copy/scen.yaml' });
    await assert.rejects(store.read(), /ambiguous|duplicate/i);
    assert.equal(parse(await fs.readFile(retained, 'utf8')).version, 1);
    await assert.rejects(fs.stat(store.metadataFilePath(moved)), { code: 'ENOENT' });
});

test('a folder move derives the current identity from adjacent filenames for every entity type', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    const entities: ProjectEntityIdentity[] = [scenario,
        { kind: 'process', uid: 'process-uid', relativePath: 'tests/sales/process.yaml' },
        { kind: 'feature', relativePath: 'tests/sales/test.feature' }];
    for (const identity of entities) { await source(directory, identity); await store.setMetadata(identity, { description: identity.kind }); }
    await fs.rename(path.join(directory, 'tests/sales'), path.join(directory, 'tests/renamed'));
    const snapshot = await store.read();
    for (const identity of entities) {
        const moved = { ...identity, relativePath: identity.relativePath.replace('sales/', 'renamed/') };
        assert.deepEqual(snapshot.identities[projectEntityKey(moved)], moved);
        assert.equal(snapshot.metadata[projectEntityKey(moved)].description, identity.kind);
    }
    assert.equal(snapshot.metadata[projectEntityKey(entities[2])], undefined);
});

test('same-UID source-only remapping moves metadata and removes the old adjacent path', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    await source(directory, scenario);
    await store.setMetadata(scenario, { description: 'Keep', order: 2 });
    const moved = { ...scenario, relativePath: 'tests/new-name.yaml' };
    await fs.rename(path.join(directory, scenario.relativePath), path.join(directory, moved.relativePath));
    await store.remapEntity(scenario, moved, true);
    await assert.rejects(fs.stat(store.metadataFilePath(scenario)), { code: 'ENOENT' });
    assert.equal((await store.read()).metadata[projectEntityKey(moved)].description, 'Keep');
});

test('invalid or mismatched adjacent objects stop the entire migration without changing central data', async t => {
    const directory = await root(t);
    await source(directory, scenario);
    const oldFile = await central(directory, scenario);
    const badFile = await write(directory, `${scenario.relativePath}.kot.yml`, stringify({ version: 2,
        identity: { kind: 'process', uid: 'other' }, metadata: { description: 'Keep conflict' } }));
    const original = await fs.readFile(badFile, 'utf8');
    await assert.rejects(new ProjectLibraryStore(directory).read(), /identity|kind|UID/i);
    assert.equal(await fs.readFile(badFile, 'utf8'), original);
    assert.equal(parse(await fs.readFile(oldFile, 'utf8')).metadata.description, 'Central');
});

test('missing central sources remain intact and are reported with the source location', async t => {
    const directory = await root(t);
    const oldFile = await central(directory, scenario);
    const warnings: string[] = [];
    const snapshot = await new ProjectLibraryStore(directory, { onWarning: warning => warnings.push(warning) }).read();
    assert.equal(snapshot.metadata[projectEntityKey(scenario)].description, 'Central');
    assert.match(warnings[0], /locate source tests\/sales\/scen.yaml/i);
    assert.equal(parse(await fs.readFile(oldFile, 'utf8')).version, 1);
    await assert.rejects(fs.stat(path.join(directory, `${scenario.relativePath}.kot.yml`)), { code: 'ENOENT' });
});

test('sidecar discovery ignores symlinks and generated/runtime dependency directories', async t => {
    const directory = await root(t);
    const external = await root(t);
    for (const subdirectory of ['node_modules', '.git', 'out', '.vscode/kot-runtime']) {
        await write(directory, `${subdirectory}/wrong.yaml.kot.yml`, 'invalid: [');
    }
    await write(external, 'wrong.yaml.kot.yml', 'invalid: [');
    await fs.symlink(external, path.join(directory, 'linked'), 'dir');
    assert.deepEqual((await new ProjectLibraryStore(directory).read()).metadata, {});
});

test('dirty-editor hooks guard migration destinations, retained central data and subsequent writes', async t => {
    const directory = await root(t);
    await source(directory, scenario);
    const oldFile = await central(directory, scenario);
    const paths: string[][] = [];
    const store = new ProjectLibraryStore(directory, { beforeWrite: changed => {
        paths.push([...changed]); throw new Error('Dirty editor');
    } });
    await assert.rejects(store.read(), /Dirty editor/);
    assert.ok(paths[0].includes(oldFile));
    assert.ok(paths[0].includes(store.metadataFilePath(scenario)));
    assert.equal(parse(await fs.readFile(oldFile, 'utf8')).version, 1);
    await assert.rejects(fs.stat(store.metadataFilePath(scenario)), { code: 'ENOENT' });
});

test('version 1 adjacent paths are replaced by the physical owner path after a folder move', async t => {
    const directory = await root(t);
    const moved = { ...scenario, relativePath: 'tests/moved/scen.yaml' };
    await source(directory, moved);
    await write(directory, `${moved.relativePath}.kot.yml`, stringify({ version: 1, identity: scenario, metadata: { description: 'Old adjacent schema' } }));
    const snapshot = await new ProjectLibraryStore(directory).read();
    assert.deepEqual(snapshot.identities[projectEntityKey(moved)], moved);
    assert.equal(snapshot.metadata[projectEntityKey(moved)].description, 'Old adjacent schema');
});

test('duplicate physical sidecar UIDs are reported before migration or group writes', async t => {
    const directory = await root(t);
    await source(directory, scenario);
    const oldFile = await central(directory, scenario);
    const document = stringify({ version: 2, identity: { kind: 'scenario', uid: scenario.uid }, metadata: { description: 'Duplicate' } });
    await write(directory, `${scenario.relativePath}.kot.yml`, document);
    await write(directory, 'tests/copy/scen.yaml.kot.yml', document);
    const store = new ProjectLibraryStore(directory);
    await assert.rejects(store.ensureGroup('Do not create', 'main'), /duplicate.*UID/i);
    assert.equal(parse(await fs.readFile(oldFile, 'utf8')).metadata.description, 'Central');
    await assert.rejects(fs.stat(path.join(directory, '.kot/groups.yml')), { code: 'ENOENT' });
});

test('a bulk import cannot write two entity identities beside one source filename', async t => {
    const directory = await root(t);
    const store = new ProjectLibraryStore(directory);
    await assert.rejects(store.importLegacy({ groups: [], entities: [
        { identity: scenario, metadata: { description: 'First' } },
        { identity: { ...scenario, uid: 'other' }, metadata: { description: 'Second' } }
    ] }), /conflicting.*filename|different entity/i);
    await assert.rejects(fs.stat(store.metadataFilePath(scenario)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(directory, '.kot/groups.yml')), { code: 'ENOENT' });
});

test('a changed source UID does not cause central metadata to attach to the replacement source', async t => {
    const directory = await root(t);
    await source(directory, { ...scenario, uid: 'replacement' });
    const oldFile = await central(directory, scenario);
    const warnings: string[] = [];
    const store = new ProjectLibraryStore(directory, { onWarning: value => warnings.push(value) });
    assert.equal((await store.read()).metadata[projectEntityKey(scenario)].description, 'Central');
    assert.equal(warnings.length, 1);
    assert.equal(parse(await fs.readFile(oldFile, 'utf8')).identity.uid, scenario.uid);
    await assert.rejects(fs.stat(store.metadataFilePath(scenario)), { code: 'ENOENT' });
    await assert.rejects(store.setMetadata(scenario, { description: 'Must not bind replacement' }), /source UID/i);
});

test('discovery roots limit crawling while explicit source identities and nested project exclusions remain supported', async t => {
    const directory = await root(t);
    const moved = { ...scenario, relativePath: 'different-tests/moved/scen.yaml' };
    await source(directory, moved);
    const oldFile = await central(directory, scenario);
    await write(directory, 'cf/not-test.yaml.kot.yml', 'invalid: [');
    await write(directory, 'tests/nested-project/not-ours.yaml.kot.yml', 'invalid: [');
    const store = new ProjectLibraryStore(directory, { discoveryRoots: [path.join(directory, 'tests')],
        excludedRoots: [path.join(directory, 'tests/nested-project')], sourceIdentities: [moved] });
    assert.deepEqual((await store.read()).identities[projectEntityKey(moved)], moved);
    assert.equal((await store.read()).metadata[projectEntityKey(moved)].description, 'Central');
    await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' });
});

test('group deletion changes retained orphan central metadata in place without creating its missing source folder', async t => {
    const directory = await root(t);
    await write(directory, '.kot/groups/sales.yml', stringify({ version: 1, id: 'sales', name: 'Sales', sections: ['main'] }));
    const oldFile = await central(directory, scenario);
    const document = parse(await fs.readFile(oldFile, 'utf8'));
    document.metadata.groupId = 'sales';
    await fs.writeFile(oldFile, stringify(document));
    await new ProjectLibraryStore(directory).deleteGroup('sales');
    assert.equal(parse(await fs.readFile(oldFile, 'utf8')).metadata.groupId, '');
    await assert.rejects(fs.stat(path.join(directory, 'tests')), { code: 'ENOENT' });
});

test('failed destination preparation leaves every central record intact', async t => {
    const directory = await root(t);
    await source(directory, scenario);
    const oldFile = await central(directory, scenario);
    const store = new ProjectLibraryStore(directory);
    const writeFile = fs.writeFile;
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]).includes('.kot.yml.') && String(args[0]).endsWith('.tmp')) { throw new Error('Simulated destination write failure'); }
        return writeFile(...args);
    }) as typeof fs.writeFile;
    try { await assert.rejects(store.read(), /destination write failure/i); }
    finally { fs.writeFile = writeFile; }
    assert.equal(parse(await fs.readFile(oldFile, 'utf8')).metadata.description, 'Central');
    await assert.rejects(fs.stat(store.metadataFilePath(scenario)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.dirname(store.metadataFilePath(scenario))), ['scen.yaml']);
});

test('source identity changes during migration preserve central metadata without creating a stale sidecar', async t => {
    const directory = await root(t);
    await source(directory, scenario);
    const oldFile = await central(directory, scenario);
    const store = new ProjectLibraryStore(directory, { beforeWrite: () => undefined });
    const mkdir = fs.mkdir;
    let edited = false;
    fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
        if (!edited && args[0] === path.dirname(store.metadataFilePath(scenario))) {
            edited = true;
            await fs.writeFile(path.join(directory, scenario.relativePath), 'ДанныеСценария:\n    UID: replacement\n');
        }
        return mkdir(...args);
    }) as typeof fs.mkdir;
    try { await assert.rejects(store.read(), /write conflict/i); }
    finally { fs.mkdir = mkdir; }
    assert.equal(edited, true);
    assert.equal(parse(await fs.readFile(oldFile, 'utf8')).metadata.description, 'Central');
    await assert.rejects(fs.stat(store.metadataFilePath(scenario)), { code: 'ENOENT' });
});

test('new metadata cannot be written through a symbolic link to another project', async t => {
    const directory = await root(t);
    const outside = await root(t);
    await fs.symlink(outside, path.join(directory, 'tests'), 'dir');
    await assert.rejects(new ProjectLibraryStore(directory).setMetadata(scenario, { description: 'Do not escape' }), /symlink/i);
    assert.deepEqual((await fs.readdir(outside)).filter(name => name !== '.kot'), []);
});

test('creating a sidecar removes migrated KOT metadata without changing the scenario body', async t => {
    const directory = await root(t); await source(directory, scenario);
    const file = path.join(directory, scenario.relativePath);
    const original = await fs.readFile(file, 'utf8');
    const block = 'KOTМетаданные:\n    Описание: "Legacy"\n    PhaseSwitcher:\n        Tab: "Sales"\n        Default: true\n';
    await fs.writeFile(file, original + block);
    const store = new ProjectLibraryStore(directory);
    await store.setMetadata(scenario, { description: 'Legacy', groupId: '' });
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.equal(parse(await fs.readFile(store.metadataFilePath(scenario), 'utf8')).metadata.description, 'Legacy');
    await fs.appendFile(file, block);
    await store.read();
    assert.equal(await fs.readFile(file, 'utf8'), original, 'existing sidecars also trigger legacy cleanup');
});

test('inline cleanup retains unknown extension data and skips dirty sources', async t => {
    const directory = await root(t); await source(directory, scenario);
    const file = path.join(directory, scenario.relativePath);
    const original = await fs.readFile(file, 'utf8');
    let canClean = false;
    const store = new ProjectLibraryStore(directory, { canCleanSource: () => canClean } as any);
    await fs.writeFile(file, original + 'KOTМетаданные:\n    Описание: "Legacy"\n');
    await store.setMetadata(scenario, { description: 'Legacy' });
    assert.match(await fs.readFile(file, 'utf8'), /KOTМетаданные/);
    canClean = true; await store.read();
    assert.equal(await fs.readFile(file, 'utf8'), original);
    const custom = original + 'KOTМетаданные:\n    ExternalToolField: "Keep me"\n';
    await fs.writeFile(file, custom); await store.read();
    assert.equal(await fs.readFile(file, 'utf8'), custom);
});

test('setup preview reads central metadata without creating sidecars or deleting the original record', async t => {
    const directory = await root(t); await source(directory, scenario);
    const oldFile = await central(directory, scenario); const text = await fs.readFile(oldFile, 'utf8');
    const store = new ProjectLibraryStore(directory); deferProjectSetup(directory); t.after(() => completeProjectSetup(directory));
    assert.equal((await store.read()).metadata[projectEntityKey(scenario)].description, 'Central');
    assert.equal(await fs.readFile(oldFile, 'utf8'), text);
    await assert.rejects(fs.stat(store.metadataFilePath(scenario)), { code: 'ENOENT' });
    completeProjectSetup(directory); await store.read();
    assert.equal(parse(await fs.readFile(store.metadataFilePath(scenario), 'utf8')).version, 2);
});

test('postponing setup still permits explicit group and metadata edits', async t => {
    const directory = await root(t); await source(directory, scenario);
    const store = new ProjectLibraryStore(directory); deferProjectSetup(directory); t.after(() => completeProjectSetup(directory));
    await store.ensureGroup('My tests', 'main');
    await store.setMetadata(scenario, { description: 'Edited without setup' });
    const snapshot = await store.read();
    assert.equal(snapshot.metadata[projectEntityKey(scenario)].description, 'Edited without setup');
    assert.ok(snapshot.groups.some(group => group.name === 'My tests'));
});
