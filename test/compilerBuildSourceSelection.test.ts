import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCompilerBuildSources } from '../src/compilerBuildSourceSelection';
import { collectCompilerBuildPreflightIssues } from '../src/compilerBuildPreflight';

const source = (uri: string, kind: string, uid: string, extra = '') => ({ uri,
    text: `ТипФайла: "${kind}"\n${kind === 'Процесс' ? 'ДанныеПроцесса' : 'ДанныеСценария'}:\n    UID: "${uid}"\n    Имя: "${uri}"\n${extra}` });
const setting = (uri: string, kind: string, uid: string) => ({ uri, text: `ТипФайла: "${kind}"\nДанныеТеста:\n    ${kind === 'НастройкаПроцесса' ? 'UIDПроцесса' : 'UIDСценария'}: "${uid}"\n` });

test('preflight selects root settings, transitive process/scenario definitions and excludes dependency settings', () => {
    const sources = [
        source('root.yaml', 'Процесс', 'root', 'ШагиПроцесса:\n    - ШагиПроцесса1:\n        ТипШага: "1"\n        ВложенныйПроцессUID: "child"\n'),
        source('child.yaml', 'Процесс', 'child', 'ШагиПроцесса:\n    - ШагиПроцесса1:\n        ТипШага: "0"\n        СценарийUID: "scenario"\n        ВложенныйПроцессUID: "unrelated-process"\n'),
        source('scenario.yaml', 'Сценарий', 'scenario', 'ВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "nested"\n'),
        source('nested.yaml', 'Сценарий', 'nested'), source('unrelated.yaml', 'Сценарий', 'unrelated'),
        source('unrelated-process.yaml', 'Процесс', 'unrelated-process'),
        setting('root-test.yaml', 'НастройкаПроцесса', 'ROOT'), setting('child-test.yaml', 'НастройкаПроцесса', 'child'),
        setting('scenario-test.yaml', 'НастройкаТеста', 'scenario'), setting('unrelated-test.yaml', 'НастройкаТеста', 'unrelated')
    ];
    const result = selectCompilerBuildSources(sources, ['root.yaml']);
    assert.deepEqual(result.map(item => item.uri), ['root.yaml', 'child.yaml', 'scenario.yaml', 'nested.yaml', 'root-test.yaml']);
    assert.deepEqual(selectCompilerBuildSources(sources, []), []);
});

test('cycles terminate and ambiguous UID definitions remain visible to preflight', () => {
    const refs = 'ВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "same"\n';
    const sources = [source('a.yaml', 'Сценарий', 'same', refs), source('b.yaml', 'Сценарий', 'SAME', refs)];
    assert.deepEqual(selectCompilerBuildSources(sources, ['a.yaml']).map(item => item.uri), ['a.yaml', 'b.yaml']);
});

test('duplicate enabled-root UIDs remain ambiguous even without a self-reference or a selected peer', () => {
    const sources = [source('a.yaml', 'Сценарий', 'same'), source('b.yaml', 'Сценарий', 'SAME'), setting('test.yaml', 'НастройкаТеста', 'same')];
    const selected = selectCompilerBuildSources(sources, ['a.yaml']);
    assert.deepEqual(selected.map(item => item.uri), ['a.yaml', 'b.yaml', 'test.yaml']);
    assert.ok(collectCompilerBuildPreflightIssues([], selected).some(issue => issue.code === 'ambiguousSettingsSource'));
    assert.ok(collectCompilerBuildPreflightIssues([{ key: 'ScenarioSettingsFilter', value: 'unselected' }], selected).some(issue => issue.code === 'ambiguousSourceUid'));
});
