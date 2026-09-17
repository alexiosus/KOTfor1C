import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import {
    getScenarioRuntimeKey,
    migrateLegacySelectionStates,
    removeRuntimeKey,
    remapRuntimeKey,
    resolveScenarioRuntimeTarget,
    resolveUniqueRuntimeKeyByName,
    validateEnabledScenarioKeys
} from '../src/scenarioRuntimeIdentity';
import type { TestInfo } from '../src/types';

function scenario(
    name: string,
    relativePath: string,
    uri: string,
    defaultState = false
): TestInfo {
    return {
        name,
        relativePath,
        defaultState,
        yamlFileUri: { toString: () => uri } as TestInfo['yamlFileUri']
    };
}

test('runtime target resolution is exact by URI and strict about stale names', () => {
    const first = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const catalog = buildScenarioCatalog([second, first]);

    assert.equal(getScenarioRuntimeKey(second), 'file:///b/scen.yaml');
    assert.deepEqual(resolveScenarioRuntimeTarget(catalog, {
        key: 'file:///b/scen.yaml',
        name: 'Duplicate'
    }), {
        kind: 'unique',
        name: 'Duplicate',
        scenario: second
    });
    assert.deepEqual(resolveScenarioRuntimeTarget(catalog, {
        key: 'file:///b/scen.yaml',
        name: 'Renamed'
    }), { kind: 'missing', name: 'Renamed' });
    assert.equal(resolveScenarioRuntimeTarget(catalog, { name: 'Duplicate' }).kind, 'ambiguous');
});

test('legacy selection migrates only to the stable primary and preserves URI state', () => {
    const first = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml', true);
    const unique = scenario('Unique', 'u', 'file:///u/scen.yaml', true);
    const catalog = buildScenarioCatalog([second, unique, first]);

    assert.deepEqual(
        migrateLegacySelectionStates(
            catalog,
            { Duplicate: true, Unique: false },
            { 'file:///b/scen.yaml': false }
        ),
        {
            'file:///a/scen.yaml': true,
            'file:///b/scen.yaml': false,
            'file:///u/scen.yaml': false
        }
    );
});

test('name-only runtime association is allowed only for unique definitions', () => {
    const first = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const unique = scenario('Unique', 'u', 'file:///u/scen.yaml');
    const catalog = buildScenarioCatalog([second, unique, first]);

    assert.equal(resolveUniqueRuntimeKeyByName(catalog, 'Unique'), 'file:///u/scen.yaml');
    assert.equal(resolveUniqueRuntimeKeyByName(catalog, 'Duplicate'), null);
    assert.equal(resolveUniqueRuntimeKeyByName(catalog, 'Missing'), null);
});

test('build selection rejects two enabled definitions with the same name', () => {
    const first = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const unique = scenario('Unique', 'u', 'file:///u/scen.yaml');
    const catalog = buildScenarioCatalog([second, unique, first]);

    assert.deepEqual(validateEnabledScenarioKeys(catalog, [
        'file:///b/scen.yaml',
        'file:///a/scen.yaml'
    ]), {
        kind: 'ambiguous',
        name: 'Duplicate',
        keys: ['file:///a/scen.yaml', 'file:///b/scen.yaml']
    });
    assert.deepEqual(validateEnabledScenarioKeys(catalog, [
        'file:///a/scen.yaml',
        'file:///u/scen.yaml'
    ]), { kind: 'valid' });
});

test('runtime map changes affect one URI without touching a same-named sibling', () => {
    const original = new Map([
        ['file:///a/scen.yaml', 'A'],
        ['file:///b/scen.yaml', 'B']
    ]);

    const remapped = remapRuntimeKey(original, 'file:///a/scen.yaml', 'file:///renamed/scen.yaml');
    assert.deepEqual([...remapped], [
        ['file:///b/scen.yaml', 'B'],
        ['file:///renamed/scen.yaml', 'A']
    ]);
    assert.deepEqual([...original], [
        ['file:///a/scen.yaml', 'A'],
        ['file:///b/scen.yaml', 'B']
    ]);

    assert.deepEqual(
        [...removeRuntimeKey(remapped, 'file:///renamed/scen.yaml')],
        [['file:///b/scen.yaml', 'B']]
    );
});
