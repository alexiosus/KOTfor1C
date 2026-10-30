import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStepLibrarySnapshot } from '../src/stepLibraryModel';
import { StepLibrarySidebarIndex } from '../src/stepLibrarySidebarModel';
import { StepLibrarySnapshotService } from '../src/stepLibrarySnapshotService';
import type { StandaloneFeatureSnapshot } from '../src/standaloneFeatureModel';
import fs from 'node:fs';
import vm from 'node:vm';

function protocol() {
    const context = { module: { exports: {} } };
    vm.runInNewContext(fs.readFileSync('media/stepLibraryProtocol.js', 'utf8'), context);
    return context.module.exports as any;
}

const view = { identity: 'definitions', all: [], byId: new Map(), byNormalizedTemplate: new Map() };
const standalone: StandaloneFeatureSnapshot = {
    revision: 1,
    groups: [{ id: 'z', name: 'Zebra' }, { id: 'empty', name: 'Empty group' }],
    features: [
        { id: 'file:///b.feature', uri: 'file:///b.feature', name: 'b', title: 'Alpha', relativePath: 'b.feature', language: 'en', groupId: 'z', order: 1 },
        { id: 'file:///a.feature', uri: 'file:///a.feature', name: 'a', title: 'Zulu', relativePath: 'a.feature', language: 'en', groupId: 'z', order: 0, jsonPath: '/a.json' },
        { id: 'file:///free.feature', uri: 'file:///free.feature', name: 'free', title: 'Free', relativePath: 'free.feature', language: 'en', groupId: '', order: 0 }
    ]
};

function build(catalog = standalone) {
    return (buildStepLibrarySnapshot as any)(view, [], new Map(), catalog);
}

test('standalone catalog contributes native navigable items and changes the shared snapshot identity', () => {
    const snapshot = build();
    assert.equal(snapshot.items.length, 3);
    const feature = snapshot.items.find((value: any) => value.featureId === 'file:///a.feature');
    assert.deepEqual({ kind: feature.kind, source: feature.sourceGroup, insertable: feature.insertable, navigable: feature.navigable, uri: feature.capturedLocation.uri, jsonPath: feature.jsonPath }, {
        kind: 'standaloneFeature', source: 'standalone', insertable: false, navigable: true, uri: 'file:///a.feature', jsonPath: '/a.json'
    });
    assert.equal(snapshot.counts.standalone, 3);
    assert.equal(feature.scenarioKey, 'file:///a.feature', 'relationship identity is the standalone URI');
    assert.notEqual(snapshot.viewIdentity, build({ ...standalone, groups: [{ id: 'z', name: 'Renamed' }], revision: 2 }).viewIdentity);
    assert.deepEqual(snapshot.standaloneGroups.map((group: any) => group.name), ['Zebra', 'Empty group']);
});

test('sidebar native source retains empty custom groups and persisted feature ordering', () => {
    const index = StepLibrarySidebarIndex.fromSnapshot(build(), 'en', new Set(['standaloneFeature#file:///a.feature']));
    const root = index.roots().find(node => node.sourceGroup === 'standalone' as any)!;
    assert.ok(root, 'Standalone is an existing-tree source root');
    const groups = index.children(root.id).nodes;
    assert.deepEqual(groups.map(node => [node.label, (node as any).groupId, node.count]), [['Ungrouped', '', 1], ['Zebra', 'z', 2], ['Empty group', 'empty', 0]]);
    const features = index.children(groups[1].id).nodes;
    assert.deepEqual(features.map(node => [node.label, (node as any).featureId]), [['Zulu', 'file:///a.feature'], ['Alpha', 'file:///b.feature']]);
    assert.equal(features[0].dragText, undefined);
    assert.equal(features[0].scenarioKey, 'file:///a.feature', 'the native row exposes its relationship identity');
    assert.equal(features[0].favorite, true);
    assert.equal((index.search('a.feature')[0] as any).featureId, 'file:///a.feature');
    assert.equal((index.children('favorites').nodes[0] as any).featureId, 'file:///a.feature');
});

test('standalone changes invalidate cached shared Library snapshots', async () => {
    let listener: () => void = () => undefined;
    let catalog = standalone;
    const event = () => ({ dispose() {} });
    const service = new StepLibrarySnapshotService({
        resolver: { ensureReady: async () => view, onDidChangeView: event },
        scenarios: { getScenarioCatalog: () => null, onDidUpdateScenarioCatalog: event },
        standaloneFeatures: { ensureReady: async () => catalog, onDidChange: (callback: () => void) => { listener = callback; return { dispose() {} }; } }
    } as any);
    const first = await service.ensureReady();
    assert.equal(first.items.length, 3);
    catalog = { ...standalone, revision: 2, features: [] };
    listener();
    assert.equal(service.getCurrent(), null);
    const second = await service.ensureReady();
    assert.equal(second.items.length, 0);
    assert.notEqual(first.viewIdentity, second.viewIdentity);
    service.dispose();
});

test('full Library native categories retain catalog groups and filter by group identity', () => {
    const api = protocol();
    const items = build().items;
    const roots = api.buildCategoryTree(items, { standaloneGroups: standalone.groups, ungrouped: 'Ungrouped' });
    assert.equal(roots[0]?.sourceGroup, 'standalone');
    assert.deepEqual(JSON.parse(JSON.stringify(roots[0].children.map((group: any) => [group.label, group.groupId, group.count]))), [['Ungrouped', '', 1], ['Zebra', 'z', 2], ['Empty group', 'empty', 0]]);
    assert.deepEqual(Array.from(api.searchItems(items, '', { sourceGroup: 'standalone', groupId: 'z' }), (item: any) => item.displayText), ['Zulu', 'Alpha']);
    const selection = api.reconcileCategorySelection(items, { sourceGroup: 'standalone', groupId: 'empty', categoryPath: ['Empty group'] }, standalone.groups);
    assert.equal(selection.sourceGroup, 'standalone');
    assert.equal(selection.groupId, 'empty');
    assert.equal(api.canInsertItem(items[0], true), false);
});
