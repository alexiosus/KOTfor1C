import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ProjectPropertyCatalogStore } from '../src/projectPropertyCatalogStore';

async function fixture(t: TestContext) {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'property-catalogs-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, file: path.join(root, '.kot', 'property-catalogs.yml') };
}

test('unused catalog names persist in the project and parallel writers retain every addition', async t => {
    const { root, file } = await fixture(t);
    const first = new ProjectPropertyCatalogStore(root);
    assert.deepEqual(await first.read(), { projects: [], reportLevel1: [], reportLevel2: [], categories: [], responsibles: [] });
    await Promise.all([
        first.add('projects', ' Shared project '),
        new ProjectPropertyCatalogStore(root).add('reportLevel1', 'Accounting'),
        new ProjectPropertyCatalogStore(root).add('categories', 'Sales'),
        new ProjectPropertyCatalogStore(root).add('responsibles', 'Alex')
    ]);
    assert.deepEqual(await new ProjectPropertyCatalogStore(root).read(), {
        projects: ['Shared project'], reportLevel1: ['Accounting'], reportLevel2: [], categories: ['Sales'], responsibles: ['Alex']
    });
    assert.equal(await first.add('projects', 'shared PROJECT'), 'Shared project');
    assert.equal(await first.add('responsibles', ' alex '), 'Alex');
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /uid|id:/iu);
});

test('dirty metadata and external edits block catalog writes without replacing their text', async t => {
    const { root, file } = await fixture(t);
    const saved = new ProjectPropertyCatalogStore(root);
    await saved.add('categories', 'Original');
    const original = await fs.readFile(file, 'utf8');
    await assert.rejects(new ProjectPropertyCatalogStore(root, { beforeWrite: () => { throw new Error('Save metadata'); } }).add('categories', 'Dirty'), /Save metadata/u);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    let changed = false;
    await assert.rejects(new ProjectPropertyCatalogStore(root, { beforeWrite: async () => {
        if (!changed) { changed = true; await fs.writeFile(file, 'version: 1\nprojects: [External]\n'); }
    } }).add('categories', 'Conflict'), /conflict|changed/iu);
    assert.equal(await fs.readFile(file, 'utf8'), 'version: 1\nprojects: [External]\n');
});

test('invalid or ambiguous catalog YAML is rejected before any write', async t => {
    const { root, file } = await fixture(t);
    await fs.mkdir(path.dirname(file), { recursive: true });
    for (const text of ['version: 1\nprojects: [42]\n', 'version: 1\nprojects: [A]\nprojects: [B]\n', 'version: 2\n', 'version: 1\nprojects: [A, a]\n']) {
        await fs.writeFile(file, text);
        await assert.rejects(new ProjectPropertyCatalogStore(root).add('projects', 'New'), /catalog|version|duplicate|ambiguous/iu);
        assert.equal(await fs.readFile(file, 'utf8'), text);
    }
    for (const name of ['', 'Two\nlines', 'nul\0name']) {
        await assert.rejects(new ProjectPropertyCatalogStore(root).add('projects', name), /name/iu);
    }
});

test('catalog writes reject a symlinked metadata directory', async t => {
    const { root } = await fixture(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'property-catalog-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.rm(path.join(root, '.kot'), {recursive: true});
    await fs.symlink(outside, path.join(root, '.kot'));
    await assert.rejects(new ProjectPropertyCatalogStore(root).add('projects', 'Outside'), /symbolic|symlink|KOT 3/iu);
    assert.deepEqual(await fs.readdir(outside), []);
});

const salesFunction = { name: 'Sales', uid: '98999f57-13dc-11e8-aed1-005056a5c4e8' };
const purchaseFunction = { name: 'Purchases', uid: '11111111-2222-4333-8444-555555555555' };
test('discovered values merge without replacing shared names, function identities or comments', async t => {
    const { root, file } = await fixture(t); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '# Shared values\nversion: 1\nprojects: [Manual]\nsystemFunctions:\n  - name: Sales\n    uid: 98999f57-13dc-11e8-aed1-005056a5c4e8\n');
    const store = new ProjectPropertyCatalogStore(root);
    await store.mergeDetected({ projects: ['manual', 'Drive'], responsibles: ['Alex'], systemFunctions: [
        { ...salesFunction, name: 'Old sales' }, purchaseFunction
    ] });
    const current = await store.read();
    assert.deepEqual(current.projects, ['Manual', 'Drive']);
    assert.deepEqual(current.responsibles, ['Alex']);
    assert.deepEqual(current.systemFunctions, [salesFunction, purchaseFunction]);
    const saved = await fs.readFile(file, 'utf8'); assert.match(saved, /# Shared values/u);
    await store.mergeDetected({ projects: ['Drive'] });
    assert.equal(await fs.readFile(file, 'utf8'), saved);
});
test('legacy system functions migrate once preserving identities and remain portable without local settings', async t => {
    const { root, file } = await fixture(t); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '# Project catalogs\nversion: 1\nprojects: [Drive]\ncategories: [Smoke]\n');
    const store = new ProjectPropertyCatalogStore(root);
    assert.deepEqual(await store.ensureSystemFunctions([salesFunction]), [salesFunction]);
    assert.match(await fs.readFile(file, 'utf8'), /# Project catalogs/);
    assert.deepEqual((await store.read()).projects, ['Drive']);
    await store.addSystemFunction(purchaseFunction.name, purchaseFunction.uid);
    assert.deepEqual(await new ProjectPropertyCatalogStore(root).ensureSystemFunctions([]), [salesFunction, purchaseFunction]);
    assert.deepEqual(await store.ensureSystemFunctions([{ ...salesFunction, name: 'Different local default' }]), [salesFunction, purchaseFunction]);
});

test('shared system function edits retain other catalogs and reject stale list replacement', async t => {
    const { root, file } = await fixture(t); const store = new ProjectPropertyCatalogStore(root);
    await store.ensureSystemFunctions([salesFunction]); await store.add('categories', 'Unused category');
    const renamed = { ...salesFunction, name: 'Order sales' };
    await store.replaceSystemFunctions([renamed], [salesFunction]);
    await store.addSystemFunction(purchaseFunction.name, purchaseFunction.uid);
    const text = await fs.readFile(file, 'utf8');
    await assert.rejects(store.replaceSystemFunctions([salesFunction], [renamed]), /changed|conflict/iu);
    assert.equal(await fs.readFile(file, 'utf8'), text); assert.deepEqual((await store.read()).categories, ['Unused category']);
    await store.replaceSystemFunctions([purchaseFunction, renamed], [renamed, purchaseFunction]);
    assert.deepEqual((await store.read()).systemFunctions, [purchaseFunction, renamed]);
});

test('ambiguous or malformed shared system functions are rejected without altering YAML', async t => {
    const { root, file } = await fixture(t); await fs.mkdir(path.dirname(file), { recursive: true });
    for (const entries of [[salesFunction, { ...salesFunction, name: 'Another' }], [{ ...salesFunction, uid: 'invalid' }], [{ ...salesFunction, name: '' }]]) {
        const text = 'version: 1\nsystemFunctions: ' + JSON.stringify(entries) + '\n'; await fs.writeFile(file, text);
        await assert.rejects(new ProjectPropertyCatalogStore(root).ensureSystemFunctions([purchaseFunction]), /function|GUID|ambiguous|duplicate|name/iu);
        assert.equal(await fs.readFile(file, 'utf8'), text);
    }
});

test('native settings can replace one shared catalog without dropping unrelated fields or comments', async t => {
    const { root, file } = await fixture(t); const store = new ProjectPropertyCatalogStore(root);
    await store.add('projects', 'Original'); await store.add('responsibles', 'Owner');
    await fs.writeFile(file, '# Shared catalogs\n' + await fs.readFile(file, 'utf8'));
    await store.replace('projects', ['New project', 'Other project'], ['Original']);
    assert.deepEqual((await store.read()).projects, ['New project', 'Other project']);
    assert.deepEqual((await store.read()).responsibles, ['Owner']);
    assert.match(await fs.readFile(file, 'utf8'), /# Shared catalogs/u);
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(store.replace('projects', ['Stale'], ['Original']), /changed|conflict/iu);
    await assert.rejects(store.replace('projects', ['Duplicate', 'duplicate'], ['New project', 'Other project']), /duplicate/iu);
    assert.equal(await fs.readFile(file, 'utf8'), before);
});
