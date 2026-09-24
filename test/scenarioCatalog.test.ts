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

function windowsScenario(
    name: string,
    relativePath: string,
    uri: string,
    fsPath: string,
    scenarioCode?: string
): TestInfo {
    return {
        ...scenario(name, relativePath, uri, scenarioCode),
        yamlFileUri: {
            scheme: 'file',
            fsPath,
            toString: () => uri
        } as TestInfo['yamlFileUri']
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

test('keeps definition-specific parameters for duplicate names', () => {
    const first = {
        ...scenario('Duplicate', 'a', 'file:///a/scen.yaml'),
        parameters: ['FirstParameter'],
        parameterDefaults: { FirstParameter: '"first"' }
    };
    const second = {
        ...scenario('Duplicate', 'b', 'file:///b/scen.yaml'),
        parameters: ['SecondParameter'],
        parameterDefaults: { SecondParameter: '"second"' }
    };

    const definitions = buildScenarioCatalog([second, first]).byName.get('Duplicate');
    assert.deepEqual(definitions?.map(item => item.parameters), [['FirstParameter'], ['SecondParameter']]);
    assert.deepEqual(definitions?.map(item => item.parameterDefaults), [
        { FirstParameter: '"first"' },
        { SecondParameter: '"second"' }
    ]);
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

test('collapses case-only Windows URI aliases into one scenario definition', () => {
    const original = windowsScenario(
        'test',
        'Parent scenarios/test',
        'file:///C:/Repo/Tests/Parent%20scenarios/test/scen.yaml',
        'C:\\Repo\\Tests\\Parent scenarios\\test\\scen.yaml'
    );
    const alias = windowsScenario(
        'test',
        'Parent scenarios/test',
        'file:///c:/repo/tests/parent%20scenarios/test/scen.yaml',
        'c:\\repo\\tests\\parent scenarios\\test\\scen.yaml'
    );

    const catalog = buildScenarioCatalog([original, alias]);

    assert.equal(catalog.all.length, 1);
    assert.equal(catalog.byName.get('test')?.length, 1);
    assert.equal(catalog.all[0].yamlFileUri.toString(), original.yamlFileUri.toString());
    assert.equal(catalog.byUri.get(alias.yamlFileUri.toString()), catalog.all[0]);
});

test('case-only Windows URI upsert updates metadata without changing the stable key', () => {
    const original = windowsScenario(
        'Old name',
        'Parent scenarios/test',
        'file:///C:/Repo/Tests/Parent%20scenarios/test/scen.yaml',
        'C:\\Repo\\Tests\\Parent scenarios\\test\\scen.yaml',
        'old'
    );
    const refreshedAlias = windowsScenario(
        'test',
        'Parent scenarios/test',
        'file:///c:/repo/tests/parent%20scenarios/test/scen.yaml',
        'c:\\repo\\tests\\parent scenarios\\test\\scen.yaml',
        'new'
    );

    const catalog = upsertScenarioInCatalog(buildScenarioCatalog([original]), refreshedAlias);

    assert.equal(catalog.all.length, 1);
    assert.equal(catalog.all[0].name, 'test');
    assert.equal(catalog.all[0].scenarioCode, 'new');
    assert.equal(catalog.all[0].yamlFileUri.toString(), original.yamlFileUri.toString());
    assert.equal(catalog.byUri.get(refreshedAlias.yamlFileUri.toString()), catalog.all[0]);
});

test('case-only Windows URI removal deletes the matching stable definition', () => {
    const original = windowsScenario(
        'test',
        'Parent scenarios/test',
        'file:///C:/Repo/Tests/Parent%20scenarios/test/scen.yaml',
        'C:\\Repo\\Tests\\Parent scenarios\\test\\scen.yaml'
    );
    const catalog = buildScenarioCatalog([original]);

    const removed = removeScenarioFromCatalogByUri(
        catalog,
        'file:///c:/repo/tests/parent%20scenarios/test/scen.yaml'
    );

    assert.equal(removed.all.length, 0);
});

test('keeps 1885 definitions in 1878 name buckets', () => {
    const entries = Array.from({ length: 1878 }, (_, index) =>
        scenario(`Scenario ${index}`, `base/${index}`, `file:///base/${index}/scen.yaml`)
    );
    for (let index = 0; index < 7; index += 1) {
        entries.push(scenario(`Scenario ${index}`, `duplicate/${index}`, `file:///duplicate/${index}/scen.yaml`));
    }

    const catalog = buildScenarioCatalog(entries);

    assert.equal(catalog.all.length, 1885);
    assert.equal(catalog.byName.size, 1878);
    assert.equal([...catalog.byName.values()].filter(items => items.length > 1).length, 7);
});
