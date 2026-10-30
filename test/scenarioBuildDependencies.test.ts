import assert from 'node:assert/strict';
import test from 'node:test';
import { findExportScenarioBuildCallers } from '../src/scenarioBuildDependencies';
import { createProjectDefinitionView, type ProjectDefinition } from '../src/projectDefinition';

const uri = (value: string) => ({ toString: () => value }) as any;
function exported(id: string, source: string): ProjectDefinition {
    return { id, kind: 'exportScenario', template: id, normalizedTemplate: id, parameters: [], sourceLabel: source,
        definitionLocation: { uri: source, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } } } };
}

test('export edits invalidate native fragment callers through exported libraries, including cycles, with one reference scan', async () => {
    const leaf = 'file:///libraries/leaf.feature'; const middle = 'file:///libraries/middle.feature';
    const nested = 'file:///tests/nested/scen.feature'; const other = 'file:///libraries/other.feature';
    const definitions = [exported('leaf', leaf), exported('middle', middle), exported('other', other)];
    const view = createProjectDefinitionView('test', definitions);
    let scans = 0;
    const callers = await findExportScenarioBuildCallers(uri(leaf), {
        resolver: { getView: async () => view },
        references: { findReferencesForDefinitions: async ids => {
            scans++; assert.deepEqual(ids, ['leaf', 'middle', 'other']);
            return new Map([['leaf', [{ uri: uri(middle) }]], ['middle', [{ uri: uri(leaf) }, { uri: uri(nested) }]],
                ['other', [{ uri: uri('file:///tests/unrelated/scen.yaml') }]]]) as any;
        } }
    });
    assert.deepEqual(new Set(callers.map(item => item.toString())), new Set([middle, leaf, nested]));
    assert.equal(scans, 1);
});

test('non-library features do not trigger reference searches and encoded drive URIs identify the same export', async () => {
    const source = 'file:///C:/library/exports.feature'; const nested = uri('file:///C:/tests/nested/scen.feature');
    const view = createProjectDefinitionView('test', [exported('export', source)]);
    let scans = 0;
    const services = { resolver: { getView: async () => view }, references: { findReferencesForDefinitions: async () => {
        scans++; return new Map([['export', [{ uri: nested }]]]) as any;
    } } };
    assert.deepEqual(await findExportScenarioBuildCallers(uri('file:///tests/standalone.feature'), services), []);
    assert.equal(scans, 0);
    assert.deepEqual(await findExportScenarioBuildCallers(uri('file:///c%3A/library/exports.feature'), services), [nested]);
    assert.equal(scans, 1);
});
