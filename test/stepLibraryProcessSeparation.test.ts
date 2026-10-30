import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStepLibrarySnapshot } from '../src/stepLibraryModel';
import { StepLibrarySidebarIndex } from '../src/stepLibrarySidebarModel';
import { StepLibraryFavoritesService } from '../src/stepLibraryFavorites';
import { scenarioFilesAvailable } from '../src/scenarioFilesModel';
import type { TestInfo } from '../src/types';
import type { ProjectGroup } from '../src/projectLibraryStore';

const protocol = require('../media/stepLibraryProtocol.js');

const uri = (value: string): any => ({ toString: () => value, fsPath: value.slice(7) });
const processUri = 'file:///workspace/process.yaml';
function snapshot() {
    return buildStepLibrarySnapshot({ identity: 'entity-sections', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [
        { name: 'Invoice', tabName: 'Sales', yamlFileUri: uri('file:///workspace/scen.yaml'), relativePath: 'scen.yaml' },
        { name: 'Sales chain', kind: 'process', uid: 'process', tabName: 'Sales', yamlFileUri: uri(processUri), relativePath: 'process.yaml', processSteps: [] }
    ] as TestInfo[], new Map([[processUri, { featureUri: 'file:///out/001.feature', filesRootUri: 'file:///out/001/files' }]]));
}

test('Library separates main scenarios and processes without changing existing identities or groups', () => {
    const result = snapshot();
    assert.equal(result.counts.main, 1); assert.equal((result.counts as any).process, 1);
    const process = result.items.find(item => item.processUri === processUri)!;
    assert.equal(process.sourceGroup, 'process'); assert.equal(process.kind, 'process');
    assert.equal(process.id, `mainScenario#${processUri}`);
    assert.equal(process.definitionId, `mainScenario:${processUri}`);
    assert.deepEqual(process.categoryPath, ['Sales']);
    assert.equal(scenarioFilesAvailable(process), true);
    const index = StepLibrarySidebarIndex.fromSnapshot(result, 'en');
    assert.equal(index.roots().find(node => node.sourceGroup === 'main')?.label, 'Main scenarios');
    assert.equal(index.roots().find(node => node.sourceGroup === 'process')?.label, 'Processes');
    assert.equal(index.children('category:main:Sales').nodes[0]?.label, 'Invoice');
    assert.equal(index.children('category:process:Sales').nodes[0]?.label, 'Sales chain');
});

test('separate Library processes continue to share URI favorites with Test Manager', async () => {
    const state = new Map<string, unknown>([['phaseSwitcher.favoriteScenarios', [{ uri: processUri, name: 'Sales chain' }]]]);
    const favorites = new StepLibraryFavoritesService({ get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
        update: async (key: string, value: unknown) => { state.set(key, value); } } as any);
    const result = snapshot(); const selected = result.items.find(item => item.processUri)!;
    assert.equal(favorites.favoriteItemIds(result).has(selected.id), true);
    assert.equal(await favorites.toggle(selected), false);
    assert.equal(favorites.favoriteItemIds(result).has(selected.id), false);
});

test('both Library projections retain empty project groups in declared sections and project order', () => {
    const groups: ProjectGroup[] = [
        { id: 'second', name: 'A later', sections: ['main'], order: 2 },
        { id: 'first', name: 'Z first', sections: ['main', 'process'], order: 1 },
        { id: 'process-only', name: 'Process only', sections: ['process'], order: 3 },
        { id: 'feature-only', name: 'Standalone only', sections: ['standalone'], order: 0 }
    ];
    const result = buildStepLibrarySnapshot({ identity: 'empty-project-groups', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [], new Map(), undefined, groups);
    assert.equal(result.items.length, 0, 'groups never become fake definitions');
    assert.equal(result.counts.main, 0); assert.equal(result.counts.process, 0);
    const compact = StepLibrarySidebarIndex.fromSnapshot(result, 'en');
    assert.deepEqual(compact.children('source:main').nodes.map(node => node.label), ['Z first', 'A later']);
    assert.deepEqual(compact.children('source:process').nodes.map(node => node.label), ['Z first', 'Process only']);
    const group = compact.children('source:main').nodes[0];
    assert.equal(group.count, 0); assert.equal(group.expandable, false);
    assert.equal(group.groupId, undefined, 'scenario groups cannot acquire standalone feature actions');
    assert.equal(group.scenarioGroupId, 'first'); assert.equal(group.groupOrder, 1);
    assert.equal(compact.roots().find(node => node.id === 'source:main')?.expandable, true);
    const tree = protocol.buildCategoryTree(result.items, { scenarioGroups: result.scenarioGroups });
    assert.deepEqual(tree.map((root: any) => [root.sourceGroup, root.count, root.children.map((child: any) => child.label)]), [
        ['main', 0, ['Z first', 'A later']], ['process', 0, ['Z first', 'Process only']]
    ]);
    assert.equal(tree[0].children[0].groupId, undefined);
    assert.equal(tree[0].children[0].scenarioGroupId, 'first');
    assert.deepEqual(protocol.reconcileCategorySelection(result.items, { sourceGroup: 'main', categoryPath: ['Z first'] }, undefined, result.scenarioGroups), {
        sourceGroup: 'main', categoryPath: ['Z first'], uncategorized: false
    });
});

test('project group edits change the Library identity while URI definitions and favorites stay stable', () => {
    const original = snapshot();
    const scenarios: TestInfo[] = [{ name: 'Invoice', tabName: 'Sales', yamlFileUri: uri('file:///workspace/scen.yaml'), relativePath: 'scen.yaml' }];
    const view = { identity: 'unchanged-catalog', all: [], byId: new Map(), byNormalizedTemplate: new Map() };
    const groups: ProjectGroup[] = [{ id: 'sales', name: 'Sales', sections: ['main', 'process'], order: 1 }];
    const first = buildStepLibrarySnapshot(view, scenarios, new Map(), undefined, groups);
    const next = buildStepLibrarySnapshot(view, scenarios, new Map(), undefined, [...groups, { id: 'planned', name: 'Planned', sections: ['process'], order: 0 }]);
    assert.notEqual(first.viewIdentity, next.viewIdentity);
    assert.equal(first.items[0].id, next.items[0].id);
    assert.equal(first.items[0].id, original.items.find(item => item.sourceGroup === 'main')!.id);
    assert.equal(first.items[0].groupId, undefined);
    assert.equal(first.items[0].groupOrder, 1);
    (groups[0].sections as Array<'main' | 'process'>).pop();
    assert.deepEqual(first.scenarioGroups?.[0].sections, ['main', 'process'], 'snapshot owns immutable copies');
});
