import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProjectDefinition,
    ProjectDefinitionFileRecord,
    ProjectDefinitionWarning
} from '../src/projectDefinition';
import {
    buildProjectDefinitionSnapshot,
    updateProjectDefinitionSnapshot
} from '../src/projectDefinitionIndex';

function definition(
    id: string,
    uri: string,
    line: number,
    template = 'And shared project step'
): ProjectDefinition {
    return {
        id,
        kind: 'userStep',
        template,
        normalizedTemplate: template,
        parameters: [],
        sourceLabel: uri,
        definitionLocation: {
            uri,
            range: {
                start: { line, character: 4 },
                end: { line, character: 20 }
            }
        }
    };
}

function record(
    uri: string,
    definitions: readonly ProjectDefinition[],
    warnings: readonly ProjectDefinitionWarning[] = [],
    mtimeMs = 1
): ProjectDefinitionFileRecord {
    return {
        uri,
        size: 100,
        mtimeMs,
        parserVersion: 'parser-v1',
        definitions,
        warnings
    };
}

function input(files: readonly ProjectDefinitionFileRecord[]) {
    return {
        configurationIdentity: 'profile-roots-v1',
        workspaceFolderUri: 'file:///workspace',
        profileId: 'active',
        generation: 7,
        parserVersion: 'parser-v1',
        files,
        warnings: []
    };
}

test('builds deterministic file and definition order independent of completion order', () => {
    const first = record('file:///workspace/B.bsl', [
        definition('b-20', 'file:///workspace/B.bsl', 20),
        definition('b-2', 'file:///workspace/B.bsl', 2)
    ]);
    const second = record('file:///workspace/a.feature', [
        definition('a-5', 'file:///workspace/a.feature', 5)
    ]);

    const left = buildProjectDefinitionSnapshot(input([first, second]));
    const right = buildProjectDefinitionSnapshot(input([second, first]));

    assert.deepEqual([...left.files.keys()], [
        'file:///workspace/a.feature',
        'file:///workspace/B.bsl'
    ]);
    assert.deepEqual(left.definitions.map(item => item.id), ['a-5', 'b-2', 'b-20']);
    assert.deepEqual(right.definitions.map(item => item.id), left.definitions.map(item => item.id));
    assert.equal(left.identity, right.identity);
});

test('retains duplicate templates in indexes by template and source URI', () => {
    const firstUri = 'file:///workspace/one.bsl';
    const secondUri = 'file:///workspace/two.feature';
    const snapshot = buildProjectDefinitionSnapshot(input([
        record(firstUri, [definition('one', firstUri, 1)]),
        record(secondUri, [definition('two', secondUri, 1)])
    ]));

    assert.deepEqual(snapshot.byNormalizedTemplate.get('And shared project step')?.map(item => item.id), [
        'one',
        'two'
    ]);
    assert.deepEqual(snapshot.bySourceUri.get(firstUri)?.map(item => item.id), ['one']);
    assert.equal(snapshot.byId.get('two')?.definitionLocation?.uri, secondUri);
    assert.equal('set' in snapshot.files, false);
});

test('includes parser and configuration identities in the stable content identity', () => {
    const source = record('file:///workspace/one.bsl', [definition('one', 'file:///workspace/one.bsl', 1)]);
    const base = buildProjectDefinitionSnapshot(input([source]));
    const parserChanged = buildProjectDefinitionSnapshot({ ...input([source]), parserVersion: 'parser-v2' });
    const configurationChanged = buildProjectDefinitionSnapshot({
        ...input([source]),
        configurationIdentity: 'profile-roots-v2'
    });

    assert.notEqual(base.identity, parserChanged.identity);
    assert.notEqual(base.identity, configurationChanged.identity);
    assert.equal(base.identity, buildProjectDefinitionSnapshot(input([source])).identity);
});

test('removes one file without mutating the prior snapshot and shares unchanged records', () => {
    const firstUri = 'file:///workspace/one.bsl';
    const secondUri = 'file:///workspace/two.feature';
    const previous = buildProjectDefinitionSnapshot(input([
        record(firstUri, [definition('one', firstUri, 1)]),
        record(secondUri, [definition('two', secondUri, 1)])
    ]));
    const shared = previous.files.get(secondUri);

    const updated = updateProjectDefinitionSnapshot(previous, { uri: firstUri, removed: true });

    assert.deepEqual(previous.definitions.map(item => item.id), ['one', 'two']);
    assert.deepEqual(updated.definitions.map(item => item.id), ['two']);
    assert.equal(updated.files.get(secondUri), shared);
    assert.equal(updated.generation, previous.generation + 1);
    assert.notEqual(updated.identity, previous.identity);
});

test('isolates a malformed file and deduplicates equal warnings', () => {
    const validUri = 'file:///workspace/valid.bsl';
    const invalidUri = 'file:///workspace/invalid.feature';
    const warning = {
        uri: invalidUri,
        message: 'Malformed source file.',
        range: {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 8 }
        }
    };
    const previous = buildProjectDefinitionSnapshot({
        ...input([record(validUri, [definition('valid', validUri, 1)])]),
        warnings: [warning]
    });

    const updated = updateProjectDefinitionSnapshot(
        previous,
        record(invalidUri, [], [warning], 2)
    );

    assert.deepEqual(updated.definitions.map(item => item.id), ['valid']);
    assert.equal(updated.files.has(invalidUri), true);
    assert.equal(updated.warnings.filter(item => item.message === warning.message).length, 1);
});
