import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createCompilerBuildManifest, fingerprintCompilerBuildInputs, fingerprintCompilerBuildArtifact } from '../src/compilerBuildManifest';
import { mapYamlLineToFeatures, mapFeatureLineToYaml, prepareCompilerControlMappingContext, type CompilerControlMappingContext, type CompilerControlArtifact } from '../src/vanessaControlSourceMapping';

const yaml = (uid = 'nested') => ['ТипФайла: "Сценарий"', 'ДанныеСценария:', `    UID: "${uid}"`, 'ТекстСценария: |', '    # language: en', '    And Delay 1', ''].join('\r\n');
const source = { uri: 'file:///project/nested/scen.yaml', text: yaml() };
const featureText = '# language: en\nFeature: Compiled\nScenario: Safe\n    And Delay 1\n    And Delay 1\n';
const row = (featureLine = 4, uid = 'nested', bodyLine = 2, level = 1) => ({ UIDСценария: uid, СтрокаЛин: featureLine, СтрокаОриг: bodyLine, УровеньВложенности: level });
const artifact = (worker = 1, rows = [row()]) => ({ worker, feature: `part-${worker}/same.feature`, sourceMap: `part-${worker}/same.str`,
    featureContent: featureText, sourceMapContent: JSON.stringify({ ДанныеСценария: rows }) });
function context(artifacts = [artifact()], sources = [source]): CompilerControlMappingContext {
    const inputs = fingerprintCompilerBuildInputs(sources.map(item => ({ uri: item.uri, content: item.text })), { profile: 'default' });
    const manifest = createCompilerBuildManifest({ before: inputs, after: inputs, successful: true,
        artifacts: artifacts.map(item => fingerprintCompilerBuildArtifact(item.worker, item.feature, item.featureContent, item.sourceMap, item.sourceMapContent)) });
    return { inputs, manifest, artifacts, sources };
}

test('prepared mapping is an immutable captured-byte index independent of later caller mutations', () => {
    const originalSource = { ...source }; const originalArtifact = artifact();
    const value = context([originalArtifact], [originalSource]);
    const prepared = prepareCompilerControlMappingContext({ ...value, outputRoot: '/output' });
    originalSource.text += '# edited'; originalArtifact.featureContent += '# edited';
    assert.ok(Object.isFrozen(prepared)); assert.ok(Object.isFrozen(prepared.sources[0])); assert.ok(Object.isFrozen(prepared.artifacts[0]));
    assert.equal(prepared.outputRoot, '/output');
    assert.equal(mapYamlLineToFeatures(value, source.uri, 5).kind, 'stale');
    assert.deepEqual(mapFeatureLineToYaml(prepared, 1, 'part-1/same.feature', 4), { kind: 'unique', location: { uri: source.uri, lineIndex: 5 } });
    assert.deepEqual(mapYamlLineToFeatures(prepared, source.uri, 5), { kind: 'unique', location: { worker: 1, feature: 'part-1/same.feature', lineNumber: 4 } });
});

test('actual two-worker compiler maps preserve repeated calls, grouped variants and nested processes', () => {
    const fixture = JSON.parse(fs.readFileSync('test/fixtures/compiler-control/compiled-control.live.json', 'utf8')) as {
        sources: Array<{ uri: string; text: string }>; artifacts: CompilerControlArtifact[];
        expectedNestedLocations: Array<{ worker: number; feature: string; lineNumber: number }>;
    };
    const inputs = fingerprintCompilerBuildInputs(fixture.sources.map(item => ({ uri: item.uri, content: item.text })), { profile: 'live-fixture' });
    const manifest = createCompilerBuildManifest({ before: inputs, after: inputs, successful: true,
        artifacts: fixture.artifacts.map(item => fingerprintCompilerBuildArtifact(item.worker, item.feature, item.featureContent, item.sourceMap, item.sourceMapContent)) });
    const value = { inputs, manifest, artifacts: fixture.artifacts, sources: fixture.sources };
    const nested = fixture.sources.find(item => item.uri.endsWith('/nested/scen.yaml'))!;
    const nestedLine = nested.text.split('\n').findIndex(line => line.trim() === 'And Delay 1');
    const mapped = mapYamlLineToFeatures(value, nested.uri, nestedLine);
    assert.deepEqual(mapped, { kind: 'ambiguous', locations: fixture.expectedNestedLocations });
    assert.equal(fixture.expectedNestedLocations.length, 8);
    for (const location of fixture.expectedNestedLocations) {
        assert.deepEqual(mapFeatureLineToYaml(value, location.worker, location.feature, location.lineNumber),
            { kind: 'unique', location: { uri: nested.uri, lineIndex: nestedLine } });
    }
    const main = fixture.sources.find(item => item.uri.endsWith('/main/scen.yaml'))!;
    const parameterLine = main.text.split('\n').findIndex(line => line.includes('And Delay "[WaitValue]"'));
    const variants = mapYamlLineToFeatures(value, main.uri, parameterLine);
    assert.equal(variants.kind, 'ambiguous');
    if (variants.kind === 'ambiguous') {
        assert.equal(variants.locations.length, 4);
        const text = variants.locations.map(location => fixture.artifacts.find(artifact => artifact.feature === location.feature)!
            .featureContent.split(/\r?\n/u)[location.lineNumber - 1].trim());
        assert.ok(text.includes('And Delay "1"')); assert.ok(text.includes('And Delay "2"'));
    }
});

test('source mapping converts CRLF YAML body offsets and one-based feature lines exactly', () => {
    const value = context();
    assert.deepEqual(mapYamlLineToFeatures(value, source.uri, 5), { kind: 'unique', location: { worker: 1, feature: 'part-1/same.feature', lineNumber: 4 } });
    assert.deepEqual(mapFeatureLineToYaml(value, 1, 'part-1/same.feature', 4), { kind: 'unique', location: { uri: source.uri, lineIndex: 5 } });
    for (const line of [-1, 0, 2, 3, 4, 6, 5.5]) { assert.equal(mapYamlLineToFeatures(value, source.uri, line).kind, 'unmapped'); }
    for (const line of [0, 1, 2, 3, 7, 4.5]) { assert.equal(mapFeatureLineToYaml(value, 1, 'part-1/same.feature', line).kind, 'unmapped'); }
});

test('repeated nested calls and worker/variant occurrences require an explicit choice', () => {
    const value = context([artifact(1, [row(4), row(5)]), artifact(2)]);
    const result = mapYamlLineToFeatures(value, source.uri, 5);
    assert.equal(result.kind, 'ambiguous');
    if (result.kind === 'ambiguous') { assert.deepEqual(result.locations, [
        { worker: 1, feature: 'part-1/same.feature', lineNumber: 4 }, { worker: 1, feature: 'part-1/same.feature', lineNumber: 5 },
        { worker: 2, feature: 'part-2/same.feature', lineNumber: 4 }
    ]); }
    assert.equal(mapFeatureLineToYaml(value, 1, 'same.feature', 4).kind, 'unmapped');
    assert.equal(mapFeatureLineToYaml(value, 2, 'part-1/same.feature', 4).kind, 'unmapped');
});

test('reverse mapping uses the deepest unique source in grouped features', () => {
    const outer = { uri: 'file:///project/main/scen.yaml', text: yaml('main') };
    const value = context([artifact(1, [row(4, 'main', 2, 0), row(4), row(5, 'main', 2, 0)])], [source, outer]);
    assert.deepEqual(mapFeatureLineToYaml(value, 1, 'part-1/same.feature', 4), { kind: 'unique', location: { uri: source.uri, lineIndex: 5 } });
    assert.deepEqual(mapFeatureLineToYaml(value, 1, 'part-1/same.feature', 5), { kind: 'unique', location: { uri: outer.uri, lineIndex: 5 } });
    const ambiguous = context([artifact(1, [row(), row(4, 'main', 2, 1)])], [source, outer]);
    assert.equal(mapFeatureLineToYaml(ambiguous, 1, 'part-1/same.feature', 4).kind, 'unmapped');
});

test('missing manifests and changed source/profile/dependency/maps can never authorize a location', () => {
    const value = context();
    const changed = [
        { ...value, manifest: undefined },
        { ...value, inputs: fingerprintCompilerBuildInputs([{ uri: source.uri, content: source.text }], { profile: 'other' }) },
        { ...value, sources: [{ ...source, text: source.text.replace('Delay 1', 'Delay 2') }] },
        { ...value, artifacts: [{ ...artifact(), sourceMapContent: '{}' }] },
        { ...value, artifacts: [{ ...artifact(), featureContent: featureText.replace('Delay 1', 'Delay 2') }] }
    ];
    for (const candidate of changed) {
        assert.equal(mapYamlLineToFeatures(candidate, source.uri, 5).kind, 'stale');
        assert.equal(mapFeatureLineToYaml(candidate, 1, 'part-1/same.feature', 4).kind, 'stale');
    }
});

test('invalid maps, duplicate UIDs and processes without a body remain unmapped', () => {
    const duplicate = { ...source, uri: 'file:///project/duplicate/scen.yaml' };
    const duplicateContext = context([artifact()], [source, duplicate]);
    assert.equal(mapYamlLineToFeatures(duplicateContext, source.uri, 5).kind, 'unmapped');
    assert.equal(mapFeatureLineToYaml(duplicateContext, 1, 'part-1/same.feature', 4).kind, 'unmapped');
    const process = { ...source, text: 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "nested"\nШагиПроцесса:\n' };
    const processContext = context([artifact()], [process]);
    assert.equal(mapYamlLineToFeatures(processContext, source.uri, 3).kind, 'unmapped');
    assert.equal(mapFeatureLineToYaml(processContext, 1, 'part-1/same.feature', 4).kind, 'unmapped');
    const invalid = context([{ ...artifact(), sourceMapContent: 'broken' }]);
    assert.equal(mapYamlLineToFeatures(invalid, source.uri, 5).kind, 'unmapped');
    assert.equal(mapFeatureLineToYaml(invalid, 1, 'part-1/same.feature', 4).kind, 'unmapped');
    const outOfRange = context([artifact(1, [row(4, 'nested', 90)])]);
    assert.equal(mapFeatureLineToYaml(outOfRange, 1, 'part-1/same.feature', 4).kind, 'unmapped');
});
