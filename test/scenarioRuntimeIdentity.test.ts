import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import {
    buildUniqueCaseInsensitiveNameLookup,
    getScenarioRuntimeKey,
    migrateLegacyScenarioValues,
    migrateLegacySelectionStates,
    planDisabledScenarioTestFileMoves,
    projectScenarioBuildSelection,
    projectCompilerScenarioSelection,
    applyScenarioRuntimeRenamePlanToRecord,
    removeRuntimeKey,
    remapRuntimeKey,
    resolveConfirmedScenarioRuntimeRenames,
    resolveScenarioRuntimeTarget,
    resolveUniqueRuntimeKeyByName,
    validateEnabledScenarioKeys
} from '../src/scenarioRuntimeIdentity';
import type { TestInfo } from '../src/types';

function scenario(
    name: string,
    relativePath: string,
    uri: string
): TestInfo {
    return {
        name,
        relativePath,
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
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const unique = scenario('Unique', 'u', 'file:///u/scen.yaml');
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

test('an old scenario Default value does not enable a scenario without saved selection', () => {
    const oldScenario = {
        ...scenario('Old', 'old', 'file:///old/scen.yaml'),
        defaultState: true
    };
    const catalog = buildScenarioCatalog([oldScenario]);

    assert.deepEqual(migrateLegacySelectionStates(catalog, {}, {}), {
        'file:///old/scen.yaml': false
    });
});

test('source format conversion preserves selected and unselected scenarios in either direction', () => {
    for (const [oldName, newName] of [['scen.yaml', 'meta.yaml'], ['meta.yaml', 'scen.yaml']]) {
        const converted = scenario('Same name', 'converted', `file:///converted/${newName}`);
        const sibling = scenario('Same name', 'sibling', `file:///sibling/${newName}`);
        const catalog = buildScenarioCatalog([converted, sibling]);
        for (const selected of [true, false]) {
            assert.deepEqual(migrateLegacySelectionStates(catalog, { 'Same name': !selected }, {
                [`file:///converted/${oldName}`]: selected
            }), {
                [`file:///converted/${newName}`]: selected,
                [`file:///sibling/${newName}`]: false
            });
        }
        assert.equal(migrateLegacySelectionStates(catalog, {}, {
            [`file:///converted/${oldName}`]: true,
            [`file:///converted/${newName}`]: false
        })[`file:///converted/${newName}`], false, 'the current descriptor state takes precedence');
    }
});

test('coexisting YAML descriptors do not borrow each other\'s selection', () => {
    const legacy = scenario('Legacy', 'same', 'file:///same/scen.yaml');
    const native = scenario('Native', 'same', 'file:///same/meta.yaml');
    assert.deepEqual(migrateLegacySelectionStates(buildScenarioCatalog([legacy, native]), {}, {
        'file:///same/scen.yaml': true
    }), { 'file:///same/scen.yaml': true, 'file:///same/meta.yaml': false });
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

test('build projection isolates a disabled duplicate without filtering out the enabled sibling', () => {
    const enabledDuplicate = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const disabledDuplicate = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const disabledUnique = scenario('Unique', 'u', 'file:///u/scen.yaml');

    assert.deepEqual(
        projectScenarioBuildSelection(
            [enabledDuplicate, disabledDuplicate, disabledUnique],
            { 'file:///a/scen.yaml': true }
        ),
        {
            total: 3,
            enabledKeys: ['file:///a/scen.yaml'],
            disabledKeys: ['file:///b/scen.yaml', 'file:///u/scen.yaml'],
            enabledNames: ['Duplicate'],
            disabledNames: ['Unique'],
            isolatedDisabledKeys: ['file:///b/scen.yaml'],
            enabledKeyByName: { Duplicate: 'file:///a/scen.yaml' }
        }
    );
});

test('compiler selection isolates codes that SPPR splits on spaces or semicolons', () => {
    const infos = ['KEEP', 'new main scen', 'part;other'].map((code, index) => ({
        ...scenario(code, String(index), `file:///source/${index}/meta.yaml`), scenarioCode: code
    }));
    const selection = projectCompilerScenarioSelection(infos, [infos[0].yamlFileUri.toString()]);
    assert.deepEqual(selection.disabledCodes, []);
    assert.deepEqual(selection.isolatedDisabledKeys, ['file:///source/1/meta.yaml', 'file:///source/2/meta.yaml']);
});

test('disabled test-file moves distinguish duplicate-name isolation from legacy mode', () => {
    assert.deepEqual(
        planDisabledScenarioTestFileMoves(
            false,
            ['file:///disabled-a/scen.yaml', 'file:///disabled-b/scen.yaml'],
            ['file:///disabled-b/scen.yaml']
        ),
        {
            mode: 'duplicate-name-isolation',
            scenarioKeys: ['file:///disabled-b/scen.yaml']
        }
    );

    assert.deepEqual(
        planDisabledScenarioTestFileMoves(
            true,
            ['file:///disabled-a/scen.yaml', 'file:///disabled-b/scen.yaml'],
            ['file:///disabled-b/scen.yaml']
        ),
        {
            mode: 'legacy',
            scenarioKeys: ['file:///disabled-a/scen.yaml', 'file:///disabled-b/scen.yaml']
        }
    );

    assert.deepEqual(
        planDisabledScenarioTestFileMoves(false, ['file:///disabled/scen.yaml'], []),
        { mode: 'none', scenarioKeys: [] }
    );
});

test('legacy scenario values migrate to one stable URI and preserve URI-backed values', () => {
    const first = scenario('Duplicate', 'a', 'file:///a/scen.yaml');
    const second = scenario('Duplicate', 'b', 'file:///b/scen.yaml');
    const unique = scenario('Unique', 'u', 'file:///u/scen.yaml');
    const catalog = buildScenarioCatalog([second, unique, first]);

    assert.deepEqual(
        migrateLegacyScenarioValues(
            catalog,
            { Duplicate: '/legacy/duplicate', Unique: '/legacy/unique' },
            { 'file:///b/scen.yaml': '/current/duplicate' }
        ),
        {
            'file:///a/scen.yaml': '/legacy/duplicate',
            'file:///b/scen.yaml': '/current/duplicate',
            'file:///u/scen.yaml': '/legacy/unique'
        }
    );
});

test('case-insensitive lookup rejects aliases shared by differently-cased names', () => {
    assert.deepEqual(
        [...buildUniqueCaseInsensitiveNameLookup(['Foo', 'foo', 'Bar'])],
        [['bar', 'Bar']]
    );
});

test('rename plan remaps only descriptor URIs confirmed by the refreshed catalog', () => {
    const renamed = scenario('Renamed', 'renamed', 'file:///renamed/scen.yaml');
    const catalog = buildScenarioCatalog([renamed]);

    const plan = resolveConfirmedScenarioRuntimeRenames([
        { oldKey: 'file:///old/scen.yaml', newKey: 'file:///renamed/scen.yaml' },
        { oldKey: 'file:///invalid/scen.yaml', newKey: 'file:///invalid/renamed.yaml' }
    ], catalog);

    assert.deepEqual([...plan.remappedKeys], [
        ['file:///old/scen.yaml', 'file:///renamed/scen.yaml']
    ]);
    assert.deepEqual([...plan.removedKeys], ['file:///invalid/scen.yaml']);
    assert.deepEqual(
        applyScenarioRuntimeRenamePlanToRecord({
            'file:///old/scen.yaml': 'preserved',
            'file:///invalid/scen.yaml': 'removed',
            'file:///untouched/scen.yaml': 'untouched'
        }, plan),
        {
            'file:///renamed/scen.yaml': 'preserved',
            'file:///untouched/scen.yaml': 'untouched'
        }
    );
});
