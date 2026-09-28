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
