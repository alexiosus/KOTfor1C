import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestInfo } from '../src/types';
import {
    buildScenarioCatalog,
    removeScenarioFromCatalogByUri,
    resolveScenarioByName,
    upsertScenarioInCatalog
} from '../src/scenarioCatalog';

function scenario(name: string, relativePath: string, uri: string, scenarioCode?: string): TestInfo {
    return {
        name,
        relativePath,
        scenarioCode,
        yamlFileUri: { toString: () => uri } as TestInfo['yamlFileUri']
    };
}

test('preserves duplicate definitions and chooses a stable compatibility primary', () => {
    const second = scenario('Duplicate', 'z/second', 'file:///z/scen.yaml');
    const first = scenario('Duplicate', 'a/first', 'file:///a/scen.yaml');
    const catalog = buildScenarioCatalog([second, first]);

    assert.equal(catalog.all.length, 2);
    assert.deepEqual(catalog.byName.get('Duplicate'), [first, second]);
    assert.equal(catalog.primaryByName.get('Duplicate'), first);
    assert.equal(buildScenarioCatalog([first, second]).primaryByName.get('Duplicate'), first);
});

test('returns missing, unique, and ambiguous name resolutions', () => {
    const one = scenario('One', 'one', 'file:///one/scen.yaml');
    const duplicateA = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const duplicateB = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const catalog = buildScenarioCatalog([duplicateB, one, duplicateA]);

    assert.deepEqual(resolveScenarioByName(catalog, 'Missing'), { kind: 'missing', name: 'Missing' });
    assert.deepEqual(resolveScenarioByName(catalog, 'One'), { kind: 'unique', name: 'One', scenario: one });
    assert.deepEqual(resolveScenarioByName(catalog, 'Duplicate'), {
        kind: 'ambiguous',
        name: 'Duplicate',
        scenarios: [duplicateA, duplicateB]
    });
});

test('upserts by URI and removal keeps the other duplicate', () => {
    const oldEntry = scenario('Old', 'same', 'file:///same/scen.yaml', '1');
    const replacement = scenario('New', 'same', 'file:///same/scen.yaml', '2');
    const other = scenario('New', 'other', 'file:///other/scen.yaml', '3');

    const updated = upsertScenarioInCatalog(buildScenarioCatalog([oldEntry, other]), replacement);
    assert.equal(updated.byName.has('Old'), false);
    assert.deepEqual(updated.byName.get('New'), [other, replacement]);

    const removed = removeScenarioFromCatalogByUri(updated, 'file:///same/scen.yaml');
    assert.deepEqual(removed.byName.get('New'), [other]);
    assert.equal(removed.byUri.has('file:///same/scen.yaml'), false);
});
