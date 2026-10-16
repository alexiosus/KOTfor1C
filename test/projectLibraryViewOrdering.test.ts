import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStepLibrarySnapshot } from '../src/stepLibraryModel';
import { StepLibrarySidebarIndex } from '../src/stepLibrarySidebarModel';
import type { TestInfo } from '../src/types';
import type { ProjectDisplayGroup } from '../src/projectGroupDisplayOrder';

const view = { identity: 'definitions', all: [], byId: new Map(), byNormalizedTemplate: new Map() };
function scenario(name: string, file: string, order: number, kind: 'scenario' | 'process' = 'scenario'): TestInfo {
    return { name, tabName: 'Smoke', kind, order, relativePath: file,
        yamlFileUri: { scheme: 'file', fsPath: file, toString: () => `file://${file}` } as TestInfo['yamlFileUri'] };
}

test('Library assigns a same-name group to the most specific nested project owner', () => {
    const groups: ProjectDisplayGroup[] = [
        { id: 'parent', name: 'Smoke', sections: ['main'], order: 0, key: 'parent', projectRoot: '/repo' },
        { id: 'nested', name: 'Smoke', sections: ['main'], order: 0, key: 'nested', projectRoot: '/repo/tests' }
    ];
    const snapshot = buildStepLibrarySnapshot(view, [scenario('Nested', '/repo/tests/scen.yaml', 0)], new Map(), undefined, groups);
    assert.equal(snapshot.items[0].scenarioGroupKey, 'nested');
});

test('Library honors shared content order and invalidates its snapshot when only order changes', () => {
    const scenarios = [scenario('Alpha', '/one/a.yaml', 1), scenario('Zulu', '/one/b.yaml', 0)];
    const first = buildStepLibrarySnapshot(view, scenarios);
    const root = StepLibrarySidebarIndex.fromSnapshot(first, 'en').children('source:main').nodes[0];
    assert.deepEqual(StepLibrarySidebarIndex.fromSnapshot(first, 'en').children(root.id).nodes.map(node => node.label), ['Zulu', 'Alpha']);
    const changed = buildStepLibrarySnapshot(view, [scenarios[0], { ...scenarios[1], order: 2 }]);
    assert.notEqual(changed.viewIdentity, first.viewIdentity);
});

test('Library keeps same-name groups from distinct project owners and honors per-section personal group order', () => {
    const groups: ProjectDisplayGroup[] = [
        { id: 'one-smoke', name: 'Smoke', sections: ['main', 'process'], order: 1, key: 'one-smoke', projectRoot: '/one', displayOrders: { main: 0, process: 1 } },
        { id: 'two-smoke', name: 'Smoke', sections: ['main'], order: 2, key: 'two-smoke', projectRoot: '/two', displayOrders: { main: 1 } },
        { id: 'one-empty', name: 'Empty', sections: ['main', 'process'], order: 0, key: 'one-empty', projectRoot: '/one', displayOrders: { main: 1, process: 0 } }
    ];
    const snapshot = buildStepLibrarySnapshot(view, [scenario('One', '/one/a.yaml', 0), scenario('Two', '/two/a.yaml', 0), scenario('Process', '/one/p.yaml', 0, 'process')], new Map(), undefined, groups);
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot, 'en');
    const main = index.children('source:main').nodes;
    assert.equal(main.length, 3);
    assert.deepEqual(main.filter(node => node.label === 'Smoke').map(node => index.children(node.id).nodes.map(item => item.label)), [['One'], ['Two']]);
    assert.deepEqual(index.children('source:process').nodes.map(node => node.label), ['Empty', 'Smoke']);
});

test('Library keeps copied standalone group IDs in separate owner-specific branches', () => {
    const standalone: any = { revision: 1, groups: [{ id: 'same', name: 'Smoke', projectRoot: '/one' }, { id: 'same', name: 'Smoke', projectRoot: '/two' }],
        features: [
            { id: 'file:///one/a.feature', uri: 'file:///one/a.feature', name: 'One', title: 'One', groupId: 'same', order: 0, language: 'en', relativePath: 'a.feature' },
            { id: 'file:///two/a.feature', uri: 'file:///two/a.feature', name: 'Two', title: 'Two', groupId: 'same', order: 0, language: 'en', relativePath: 'a.feature' }
        ], ordering: { groupRoots: { same: ['/one', '/two'] }, featureRoots: { 'file:///one/a.feature': '/one', 'file:///two/a.feature': '/two' } } };
    const index = StepLibrarySidebarIndex.fromSnapshot(buildStepLibrarySnapshot(view, [], new Map(), standalone), 'en');
    const groups = index.children('source:standalone').nodes.filter(group => group.label === 'Smoke');
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(group => index.children(group.id).nodes.map(node => node.label)), [['One'], ['Two']]);
});
