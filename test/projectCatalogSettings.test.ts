import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectPropertyCatalogStore } from '../src/projectPropertyCatalogStore';
import { TestNumberingStore } from '../src/testNumberingStore';
import { ProjectCatalogSettings, type CatalogSettingsBaseline } from '../src/projectCatalogSettings';

async function fixture(t: test.TestContext) {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-native-catalogs-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const settings = new Map<string, unknown>(); const userOnly = new Set<string>();
    let baseline: CatalogSettingsBaseline | undefined; let dirty = false; let writes = 0;
    const host = {
        readSetting: (key: string) => ({ value: settings.get(key) ?? [], explicit: settings.has(key), userOnly: userOnly.has(key) }),
        writeSetting: async (key: string, value: unknown) => { writes++; settings.set(key, structuredClone(value)); },
        readBaseline: () => baseline,
        writeBaseline: async (value: CatalogSettingsBaseline) => { baseline = structuredClone(value); },
        assertSaved: () => { if (dirty) { throw new Error('Save modified catalog'); } },
        loadCodes: async () => ['000012009']
    };
    return { root, settings, userOnly, host, store: new ProjectPropertyCatalogStore(root), numbering: new TestNumberingStore(root),
        sync: new ProjectCatalogSettings(root, host), restart: () => new ProjectCatalogSettings(root, host),
        dirty() { dirty = true; }, writes: () => writes };
}

test('native settings stay inert until shared data or explicit workspace values exist', async t => {
    const h = await fixture(t);
    assert.deepEqual(await h.sync.synchronize('project'), []);
    assert.deepEqual(await fs.readdir(path.join(h.root,'.kot')), ['project.yml']); assert.equal(h.writes(), 0);
    h.settings.set('catalogs.responsibles', ['Owner']);
    assert.deepEqual(await h.sync.synchronize('settings'), []);
    assert.deepEqual((await h.store.read()).responsibles, ['Owner']);
});

test('an explicit empty native list creates an empty shared field', async t => {
    const h = await fixture(t); await h.sync.synchronize('project'); h.settings.set('catalogs.projects', []);
    assert.deepEqual(await h.sync.synchronize('settings', ['catalogs.projects']), []);
    assert.match(await fs.readFile(h.store.filePath, 'utf8'), /projects: \[\]/u);
});

test('shared catalogs populate native controls and native edits preserve unrelated YAML and comments', async t => {
    const h = await fixture(t); await h.store.add('projects', 'From Git'); await h.store.add('responsibles', 'Owner');
    await fs.writeFile(h.store.filePath, '# Shared project\n' + await fs.readFile(h.store.filePath, 'utf8'));
    await h.sync.synchronize('project');
    assert.deepEqual(h.settings.get('catalogs.projects'), ['From Git']);
    h.settings.set('catalogs.projects', ['Edited in settings']);
    assert.deepEqual(await h.sync.synchronize('settings'), []);
    assert.deepEqual((await h.store.read()).projects, ['Edited in settings']);
    assert.deepEqual((await h.store.read()).responsibles, ['Owner']);
    assert.match(await fs.readFile(h.store.filePath, 'utf8'), /# Shared project/u);
    const writes = h.writes(); await h.sync.synchronize('settings'); await h.sync.synchronize('project');
    assert.equal(h.writes(), writes);
});

test('Git updates refresh native settings after a restart without importing stale reflected values', async t => {
    const h = await fixture(t); await h.store.add('categories', 'Old'); await h.sync.synchronize('project');
    await h.store.add('categories', 'New from Git');
    assert.deepEqual(await h.restart().synchronize('project'), []);
    assert.deepEqual(h.settings.get('catalogs.categories'), ['Old', 'New from Git']);
});

test('settings edited offline are imported only when the shared field has not also changed', async t => {
    const h = await fixture(t); await h.store.add('reportLevel1', 'Old'); await h.sync.synchronize('project');
    h.settings.set('catalogs.reportLevel1', ['Settings edit']);
    assert.deepEqual(await h.restart().synchronize('project'), []);
    assert.deepEqual((await h.store.read()).reportLevel1, ['Settings edit']);
    h.settings.set('catalogs.reportLevel1', ['Another settings edit']); await h.store.add('reportLevel1', 'Git edit');
    const source = await fs.readFile(h.store.filePath, 'utf8');
    assert.match((await h.restart().synchronize('project')).join('\n'), /conflict|both|changed/iu);
    assert.equal(await fs.readFile(h.store.filePath, 'utf8'), source);
    assert.deepEqual(h.settings.get('catalogs.reportLevel1'), ['Another settings edit']);
});

test('simultaneous project and settings edits preserve both versions until the user resolves the field', async t => {
    const h = await fixture(t); await h.store.add('projects', 'Original'); await h.sync.synchronize('project');
    h.settings.set('catalogs.projects', ['Settings']); await h.store.add('projects', 'Git');
    const errors = await h.sync.synchronize('settings'); assert.match(errors.join('\n'), /conflict|both|changed/iu);
    assert.deepEqual((await h.store.read()).projects, ['Original', 'Git']);
    assert.deepEqual(h.settings.get('catalogs.projects'), ['Settings']);
    h.settings.set('catalogs.projects', ['Original', 'Git']);
    assert.deepEqual(await h.sync.synchronize('settings'), []);
});

test('series controls expose definitions and preserve counters updated by a running creation wizard', async t => {
    const h = await fixture(t); await h.numbering.addSeries('000012', 'Owner', []);
    await h.sync.synchronize('project');
    assert.deepEqual(h.settings.get('numbering.series'), [{ prefix: '000012', author: 'Owner' }]);
    await h.numbering.claim('000012010', async () => []);
    h.settings.set('numbering.series', [{ prefix: '000012', author: 'Renamed owner' }]);
    assert.deepEqual(await h.sync.synchronize('settings'), []);
    assert.deepEqual((await h.numbering.read()).series, [{ prefix: '000012', author: 'Renamed owner', lastNumber: 10 }]);
    h.settings.set('numbering.series', []);
    assert.match((await h.sync.synchronize('settings')).join('\n'), /issued|remove|history/iu);
    assert.equal((await h.numbering.read()).series[0].lastNumber, 10);
});

test('native system function changes retain compiler UIDs and seed a missing catalog', async t => {
    const h = await fixture(t); const fn = { name: 'Sales', uid: '11111111-2222-4333-8444-555555555555' };
    h.settings.set('catalogs.systemFunctions', [fn]);
    assert.deepEqual(await h.sync.synchronize('settings'), []);
    assert.deepEqual((await h.store.read()).systemFunctions, [fn]);
    h.settings.set('catalogs.systemFunctions', [{ ...fn, name: 'Sales renamed' }]);
    assert.deepEqual(await h.sync.synchronize('settings'), []);
    assert.equal((await h.store.read()).systemFunctions?.[0].uid, fn.uid);
});

test('invalid, dirty and User-level catalogs cannot replace shared data', async t => {
    const h = await fixture(t); await h.store.add('projects', 'Original'); await h.sync.synchronize('project');
    h.settings.set('catalogs.projects', ['Duplicate', 'duplicate']);
    assert.match((await h.sync.synchronize('settings')).join('\n'), /duplicate/iu);
    assert.deepEqual((await h.store.read()).projects, ['Original']);
    h.settings.set('catalogs.projects', ['User scope']); h.userOnly.add('catalogs.projects');
    assert.match((await h.sync.synchronize('settings')).join('\n'), /Workspace|workspace/iu);
    assert.deepEqual((await h.store.read()).projects, ['Original']);
    h.userOnly.clear(); h.dirty();
    assert.match((await h.sync.synchronize('settings')).join('\n'), /Save/iu);
    assert.deepEqual((await h.store.read()).projects, ['Original']);
});

test('an unrelated settings event cannot overwrite another pending catalog edit', async t => {
    const h = await fixture(t); await h.store.add('projects', 'Project'); await h.store.add('categories', 'Category');
    await h.sync.synchronize('project');
    h.settings.set('catalogs.projects', ['Changed project']); h.settings.set('catalogs.categories', ['Pending category']);
    await h.sync.synchronize('settings', ['catalogs.projects']);
    assert.deepEqual(h.settings.get('catalogs.categories'), ['Pending category']);
    assert.deepEqual((await h.store.read()).categories, ['Category']);
    await h.sync.synchronize('settings', ['catalogs.categories']);
    assert.deepEqual((await h.store.read()).categories, ['Pending category']);
});

test('global catalog defaults do not create workspace configuration or project YAML on startup', async t => {
    const h = await fixture(t);
    h.settings.set('catalogs.projects', ['Global default']); h.userOnly.add('catalogs.projects');
    h.host.readSetting = key => ({ value: h.settings.get(key) ?? [], explicit: !h.userOnly.has(key) && h.settings.has(key), userOnly: h.userOnly.has(key) });
    await h.sync.synchronize('project');
    assert.equal(h.writes(), 0); assert.deepEqual(await fs.readdir(path.join(h.root,'.kot')), ['project.yml']);
});

test('a new native system function gets a stable generated UID while blanking an existing UID preserves it', async t => {
    const h = await fixture(t);
    h.settings.set('catalogs.systemFunctions', [{ name: 'Sales', uid: '' }]);
    assert.deepEqual(await h.sync.synchronize('settings'), []);
    const fn = (await h.store.read()).systemFunctions![0];
    assert.match(fn.uid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
    assert.deepEqual(h.settings.get('catalogs.systemFunctions'), [fn]);
    h.settings.set('catalogs.systemFunctions', [{ name: 'Sales', uid: '' }]);
    await h.sync.synchronize('settings');
    assert.equal((await h.store.read()).systemFunctions![0].uid, fn.uid);
});

test('a newer native edit arriving during an earlier write is applied by its queued pass', async t => {
    const h = await fixture(t); await h.numbering.addSeries('000012', 'Original', []);
    await h.sync.synchronize('project');
    h.settings.set('numbering.series', [{ prefix: '000012', author: 'First edit' }]);
    let queued: Promise<string[]> | undefined;
    h.host.loadCodes = async () => {
        if (!queued) {
            h.settings.set('numbering.series', [{ prefix: '000012', author: 'Newer edit' }]);
            queued = h.sync.synchronize('settings', ['numbering.series']);
        }
        return [];
    };
    assert.deepEqual(await h.sync.synchronize('settings', ['numbering.series']), []);
    assert.deepEqual(await queued, []);
    assert.equal((await h.numbering.read()).series[0].author, 'Newer edit');
    assert.deepEqual(h.settings.get('numbering.series'), [{ prefix: '000012', author: 'Newer edit' }]);
});

test('native map enumeration order does not reorder series or trigger reflection writes', async t => {
    const h = await fixture(t);
    await h.numbering.addSeries('200000', 'Second', []); await h.numbering.addSeries('100000', 'First', []);
    await h.sync.synchronize('project');
    h.settings.set('numbering.series', [{ prefix: '100000', author: 'First' }, { prefix: '200000', author: 'Second' }]);
    const before = await fs.readFile(h.numbering.filePath, 'utf8'); const writes = h.writes();
    assert.deepEqual(await h.sync.synchronize('settings', ['numbering.series']), []);
    assert.equal(await fs.readFile(h.numbering.filePath, 'utf8'), before);
    assert.equal(h.writes(), writes);
});
