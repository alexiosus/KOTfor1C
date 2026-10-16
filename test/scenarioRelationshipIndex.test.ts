import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import {
    ScenarioRelationshipIndex,
    type ScenarioRelationshipEntry
} from '../src/scenarioRelationshipIndex';
import type { TestInfo } from '../src/types';

function scenario(
    name: string,
    key: string,
    options: {
        calls?: readonly string[];
        phase?: string;
    } = {}
): TestInfo {
    return {
        name,
        relativePath: key.replace(/^file:\/\//u, ''),
        yamlFileUri: { toString: () => key } as TestInfo['yamlFileUri'],
        nestedScenarioNames: options.calls ? [...options.calls] : [],
        ...(options.phase ? { tabName: options.phase } : {})
    };
}

function byKey(entries: readonly ScenarioRelationshipEntry[]): Record<string, ScenarioRelationshipEntry> {
    return Object.fromEntries(entries.map(entry => [entry.scenarioKey, entry]));
}

test('projects transitive callers to owning main scenarios and phases', () => {
    const mainKey = 'file:///main/scen.yaml';
    const nestedAKey = 'file:///nested-a/scen.yaml';
    const nestedBKey = 'file:///nested-b/scen.yaml';
    const catalog = buildScenarioCatalog([
        scenario('Main test', mainKey, { calls: ['Nested A'], phase: 'Accounting' }),
        scenario('Nested A', nestedAKey, { calls: ['Nested B'] }),
        scenario('Nested B', nestedBKey)
    ]);

    const projection = ScenarioRelationshipIndex.fromCatalog(catalog).project([nestedBKey]);

    assert.deepEqual(projection.currentScenarioKeys, [nestedBKey]);
    assert.deepEqual(projection.relationships, [
        { scenarioKey: nestedAKey, incomingDistance: 1 },
        { scenarioKey: mainKey, incomingDistance: 2 }
    ]);
    assert.deepEqual(projection.affectedMainScenarioKeys, [mainKey]);
    assert.deepEqual(projection.affectedPhaseNames, ['Accounting']);
});

test('projects callees from a main scenario and keeps the current main in affected owners', () => {
    const mainKey = 'file:///main/scen.yaml';
    const nestedAKey = 'file:///nested-a/scen.yaml';
    const nestedBKey = 'file:///nested-b/scen.yaml';
    const catalog = buildScenarioCatalog([
        scenario('Main test', mainKey, { calls: ['Nested A'], phase: 'Accounting' }),
        scenario('Nested A', nestedAKey, { calls: ['Nested B'] }),
        scenario('Nested B', nestedBKey)
    ]);

    const projection = ScenarioRelationshipIndex.fromCatalog(catalog).project([mainKey]);

    assert.deepEqual(projection.relationships, [
        { scenarioKey: nestedAKey, outgoingDistance: 1 },
        { scenarioKey: nestedBKey, outgoingDistance: 2 }
    ]);
    assert.deepEqual(projection.affectedMainScenarioKeys, [mainKey]);
    assert.deepEqual(projection.affectedPhaseNames, ['Accounting']);
});

test('terminates cycles and records both directions without returning the current node', () => {
    const mainKey = 'file:///main/scen.yaml';
    const nestedAKey = 'file:///nested-a/scen.yaml';
    const nestedBKey = 'file:///nested-b/scen.yaml';
    const catalog = buildScenarioCatalog([
        scenario('Main test', mainKey, { calls: ['Nested A'], phase: 'Accounting' }),
        scenario('Nested A', nestedAKey, { calls: ['Nested B'] }),
        scenario('Nested B', nestedBKey, { calls: ['Nested A'] })
    ]);

    const projection = ScenarioRelationshipIndex.fromCatalog(catalog).project([nestedBKey]);
    const relationships = byKey(projection.relationships);

    assert.equal(relationships[nestedBKey], undefined);
    assert.deepEqual(relationships[nestedAKey], {
        scenarioKey: nestedAKey,
        incomingDistance: 1,
        outgoingDistance: 1
    });
    assert.deepEqual(relationships[mainKey], {
        scenarioKey: mainKey,
        incomingDistance: 2
    });
    assert.equal(projection.relationships.length, 2);
});

test('connects ambiguous exact-name callees in stable URI order and ignores missing names', () => {
    const mainKey = 'file:///main/scen.yaml';
    const sharedAKey = 'file:///a/shared/scen.yaml';
    const sharedZKey = 'file:///z/shared/scen.yaml';
    const catalog = buildScenarioCatalog([
        scenario('Shared', sharedZKey),
        scenario('Main test', mainKey, {
            calls: ['Missing', 'Shared'],
            phase: 'Accounting'
        }),
        scenario('Shared', sharedAKey)
    ]);

    const projection = ScenarioRelationshipIndex.fromCatalog(catalog).project([mainKey]);

    assert.deepEqual(projection.relationships, [
        { scenarioKey: sharedAKey, outgoingDistance: 1 },
        { scenarioKey: sharedZKey, outgoingDistance: 1 }
    ]);
});

test('exposes the name-based caller projection for stale-artifact compatibility', () => {
    const catalog = buildScenarioCatalog([
        scenario('Main Z', 'file:///z/scen.yaml', { calls: ['Nested'], phase: 'Z' }),
        scenario('Nested', 'file:///nested/scen.yaml'),
        scenario('Main A', 'file:///a/scen.yaml', { calls: ['Nested'], phase: 'A' })
    ]);

    const callers = ScenarioRelationshipIndex.fromCatalog(catalog).getCallerNamesByCalleeName();

    assert.deepEqual([...(callers.get('Nested') ?? [])], ['Main A', 'Main Z']);
});

test('process dependencies follow typed UIDs through nested processes in both directions', () => {
    const parent = { ...scenario('Parent', 'file:///parent.yaml', { phase: 'Processes' }), kind: 'process' as const, uid: 'parent',
        nestedScenarioNames: ['Shared'], processSteps: [{ uid: 'p1', type: 'process' as const, processUid: 'CHILD', processName: 'Old child name' }] };
    const child = { ...scenario('Child', 'file:///child.yaml'), kind: 'process' as const, uid: 'child',
        processSteps: [{ uid: 'c1', type: 'scenario' as const, scenarioUid: 'target', scenarioName: 'Shared' }] };
    const target = { ...scenario('Shared', 'file:///target.yaml'), uid: 'target' };
    const unrelated = { ...scenario('Shared', 'file:///unrelated.yaml'), uid: 'other' };
    const index = ScenarioRelationshipIndex.fromCatalog(buildScenarioCatalog([parent, child, target, unrelated]));
    assert.deepEqual(index.project(['file:///parent.yaml']).relationships, [
        { scenarioKey: 'file:///child.yaml', outgoingDistance: 1 },
        { scenarioKey: 'file:///target.yaml', outgoingDistance: 2 }
    ]);
    const incoming = index.project(['file:///target.yaml']);
    assert.deepEqual(incoming.relationships, [
        { scenarioKey: 'file:///child.yaml', incomingDistance: 1 },
        { scenarioKey: 'file:///parent.yaml', incomingDistance: 2 }
    ]);
    assert.deepEqual(incoming.affectedPhaseNames, ['Processes']);
});

test('process references never fall back from a missing or ambiguous UID to an unrelated same-name record', () => {
    const parent = { ...scenario('Parent', 'file:///parent.yaml'), kind: 'process' as const, uid: 'parent', processSteps: [
        { type: 'scenario' as const, scenarioUid: 'missing', scenarioName: 'Only' },
        { type: 'scenario' as const, scenarioUid: 'duplicate', scenarioName: 'One' },
        { type: 'scenario' as const, scenarioName: 'Shared' },
        { type: 'process' as const, processName: 'Only' },
        { type: 'scenario' as const, scenarioName: 'Unique' }
    ] };
    const index = ScenarioRelationshipIndex.fromCatalog(buildScenarioCatalog([
        parent, scenario('Only', 'file:///only.yaml'),
        { ...scenario('One', 'file:///one.yaml'), uid: 'duplicate' },
        { ...scenario('Two', 'file:///two.yaml'), uid: 'DUPLICATE' },
        scenario('Shared', 'file:///shared-a.yaml'), scenario('Shared', 'file:///shared-b.yaml'),
        scenario('Unique', 'file:///unique.yaml')
    ]));
    assert.deepEqual(index.project(['file:///parent.yaml']).relationships, [
        { scenarioKey: 'file:///unique.yaml', outgoingDistance: 1 }
    ]);
});

test('ordinary nested scenario calls exclude same-name process records', () => {
    const index = ScenarioRelationshipIndex.fromCatalog(buildScenarioCatalog([
        scenario('Caller', 'file:///caller.yaml', { calls: ['Shared'] }),
        scenario('Shared', 'file:///scenario.yaml'),
        { ...scenario('Shared', 'file:///process.yaml'), kind: 'process', uid: 'process' }
    ]));
    assert.deepEqual(index.project(['file:///caller.yaml']).relationships, [
        { scenarioKey: 'file:///scenario.yaml', outgoingDistance: 1 }
    ]);
});

test('imported processes without a tab remain affected runnable owners in the Processes group', () => {
    const index = ScenarioRelationshipIndex.fromCatalog(buildScenarioCatalog([
        { ...scenario('Imported process', 'file:///process.yaml'), kind: 'process', uid: 'parent',
            processSteps: [{ type: 'scenario', scenarioUid: 'target' }] },
        { ...scenario('Target', 'file:///target.yaml'), uid: 'target' }
    ]));
    const projection = index.project(['file:///target.yaml']);
    assert.deepEqual(projection.affectedMainScenarioKeys, ['file:///process.yaml']);
    assert.deepEqual(projection.affectedPhaseNames, ['Processes']);
    assert.deepEqual(index.project(['file:///process.yaml']).affectedMainScenarioKeys, ['file:///process.yaml']);
});
