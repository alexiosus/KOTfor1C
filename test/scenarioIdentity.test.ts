import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import {
    resolveScenarioRenameTarget,
    resolveScenarioTarget
} from '../src/scenarioIdentity';
import type { TestInfo } from '../src/types';

function scenario(name: string, relativePath: string, uri: string): TestInfo {
    return {
        name,
        relativePath,
        yamlFileUri: { toString: () => uri } as TestInfo['yamlFileUri']
    };
}

test('URI selects the exact definition when names are duplicated', () => {
    const first = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const catalog = buildScenarioCatalog([first, second]);

    assert.deepEqual(resolveScenarioTarget(catalog, {
        name: 'Duplicate',
        uri: 'file:///b/scen.yaml'
    }), {
        kind: 'unique',
        name: 'Duplicate',
        scenario: second
    });
});

test('name-only target remains ambiguous instead of selecting a primary definition', () => {
    const first = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const catalog = buildScenarioCatalog([first, second]);

    assert.deepEqual(resolveScenarioTarget(catalog, { name: 'Duplicate' }), {
        kind: 'ambiguous',
        name: 'Duplicate',
        scenarios: [first, second]
    });
});

test('stale URI and name pairs do not resolve to a different definition', () => {
    const current = scenario('Current', 'a', 'file:///a/scen.yaml');
    const catalog = buildScenarioCatalog([current]);

    assert.deepEqual(resolveScenarioTarget(catalog, {
        name: 'Old name',
        uri: 'file:///a/scen.yaml'
    }), {
        kind: 'missing',
        name: 'Old name'
    });
});

test('rename remains ambiguous when an exact file shares its scenario name', () => {
    const first = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const catalog = buildScenarioCatalog([first, second]);

    assert.deepEqual(resolveScenarioRenameTarget(catalog, {
        name: 'Duplicate',
        uri: 'file:///b/scen.yaml'
    }), {
        kind: 'ambiguous',
        name: 'Duplicate',
        scenarios: [first, second]
    });
});
