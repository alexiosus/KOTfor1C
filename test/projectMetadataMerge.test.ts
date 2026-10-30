import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { mergeProjectMetadata, type MetadataKind } from '../src/projectMetadataMerge';
const yaml = (value: unknown) => value === undefined ? undefined : stringify(value);
const merge = (kind: MetadataKind, base: unknown, ours: unknown, theirs: unknown, choices = {}) => mergeProjectMetadata(kind, yaml(base), yaml(ours), yaml(theirs), choices);
const group = { version: 1, id: 'smoke', name: 'Smoke', sections: ['main'] };
test('independent group edits merge and swapping sides has the same result', () => {
    const ours = { ...group, name: 'Renamed' }; const theirs = { ...group, sections: ['main', 'process'] };
    const result = merge('group', group, ours, theirs);
    assert.deepEqual(result.conflicts, []); assert.deepEqual(parse(result.text!), { ...ours, sections: theirs.sections });
    assert.equal(result.text, merge('group', group, theirs, ours).text);
});
test('same-field and delete/edit conflicts require explicit choices', () => {
    const ours = { ...group, name: 'One' }; const theirs = { ...group, name: 'Two' };
    assert.equal(merge('group', group, ours, theirs).conflicts[0].path, '/name');
    assert.equal(parse(merge('group', group, ours, theirs, { '/name': 'theirs' }).text!).name, 'Two');
    assert.equal(merge('group', group, undefined, theirs).conflicts[0].path, '');
    assert.equal(merge('group', group, undefined, theirs, { '': 'ours' }).text, undefined);
    assert.equal(merge('group', undefined, ours, theirs).conflicts.length, 1);
});
test('sidecar fields merge independently but identity changes require a decision', () => {
    const base = { version: 2, identity: { kind: 'scenario', uid: 'one' }, metadata: { groupId: 'smoke', description: 'Before' } };
    const result = merge('sidecar', base, { ...base, metadata: { ...base.metadata, category: 'Cat' } }, { ...base, metadata: { ...base.metadata, description: 'After' } });
    assert.deepEqual(result.conflicts, []); assert.equal(parse(result.text!).metadata.category, 'Cat');
    assert.equal(merge('sidecar', base, { ...base, identity: { kind: 'scenario', uid: 'two' } }, base).conflicts[0].path, '/identity');
});
test('migration sets retain both histories without reviving catalog deletions', () => {
    const result = merge('imports', { version: 1, legacyImports: ['scenario'] },
        { version: 1, legacyImports: ['standalone'] }, { version: 1, legacyImports: ['scenario'] });
    assert.deepEqual(parse(result.text!).legacyImports, ['scenario', 'standalone']);
    const catalog = merge('catalogs', { version: 1, projects: ['A', 'B'] }, { version: 1, projects: ['A'] }, { version: 1, projects: ['A', 'B', 'C'] });
    assert.deepEqual(parse(catalog.text!).projects, ['A', 'C']);
});
test('numbering counters use the maximum while concurrent author edits remain explicit', () => {
    const catalog = (author: string, lastNumber: number) => ({ version: 1, series: [{ prefix: '123456', author, lastNumber }] });
    const result = merge('numbering', catalog('A', 3), catalog('B', 5), catalog('C', 8));
    assert.equal(result.conflicts.length, 1); assert.match(result.conflicts[0].path, /author/u);
    const resolved = merge('numbering', catalog('A', 3), catalog('B', 5), catalog('C', 8), { [result.conflicts[0].path]: 'ours' });
    assert.deepEqual(parse(resolved.text!).series, [{ prefix: '123456', author: 'B', lastNumber: 8 }]);
});
test('system functions merge by UID and reject invalid or colliding schema', () => {
    const uid = '00000000-0000-0000-0000-000000000001';
    const base = { version: 1, systemFunctions: [{ uid, name: 'A' }] };
    assert.equal(merge('catalogs', base, { ...base, systemFunctions: [{ uid, name: 'B' }] }, { ...base, systemFunctions: [{ uid, name: 'C' }] }).conflicts.length, 1);
    for (const bad of ['version: 99\n', 'version: 1\nprojects: &a [A]\nresponsibles: *a\n', 'version: 1\nunknown: true\n']) {
        assert.throws(() => mergeProjectMetadata('catalogs', undefined, bad, undefined));
    }
    assert.throws(() => merge('catalogs', undefined, { version: 1, projects: ['A', 'a'] }, undefined));
});

test('incompatible group families require a sections choice and stay readable by the store', () => {
    const base = { ...group, sections: ['main'] }; const ours = { ...group, sections: ['standalone'] }; const theirs = { ...group, sections: ['main', 'process'] };
    const unresolved = merge('group', base, ours, theirs);
    assert.equal(unresolved.conflicts[0]?.path, '/sections');
    assert.deepEqual(parse(merge('group', base, ours, theirs, { '/sections': 'ours' }).text!).sections, ['standalone']);
});
