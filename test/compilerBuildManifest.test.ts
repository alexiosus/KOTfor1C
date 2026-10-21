import assert from 'node:assert/strict';
import test from 'node:test';
import {
    fingerprintCompilerBuildInputs, fingerprintCompilerBuildArtifact, createCompilerBuildManifest,
    parseCompilerBuildManifest, verifyCompilerBuildManifest
} from '../src/compilerBuildManifest';

const files = [{ uri: 'file:///project/main/scen.yaml', content: 'main' },
    { uri: 'file:///project/nested/scen.yaml', content: 'nested' }, { uri: 'file:///tools/compiler.epf', content: new Uint8Array([0, 255, 42]) }];
const config = { profile: 'default', parameters: [{ key: 'Language', value: 'en' }], privateValue: 'fixture-secret' };
const inputs = () => fingerprintCompilerBuildInputs(files, config);
const artifact = (worker = 1) => fingerprintCompilerBuildArtifact(worker, `part-${worker}/same.feature`, 'Feature: A', `part-${worker}/same.str`, '{"ДанныеНомеровСтрок":[]}');
const manifest = () => createCompilerBuildManifest({ before: inputs(), after: inputs(), artifacts: [artifact()], successful: true })!;

test('input fingerprint binds dependency bytes, inventory and configuration without retaining values', () => {
    const original = inputs();
    assert.equal(original.digest, fingerprintCompilerBuildInputs([...files].reverse(), { privateValue: 'fixture-secret', parameters: config.parameters, profile: 'default' }).digest);
    assert.notEqual(original.digest, fingerprintCompilerBuildInputs([...files.slice(0, 1), { ...files[1], content: 'changed' }, files[2]], config).digest);
    assert.notEqual(original.digest, fingerprintCompilerBuildInputs(files.slice(0, 2), config).digest);
    assert.notEqual(original.digest, fingerprintCompilerBuildInputs([...files, { uri: 'file:///new.yaml', content: 'new' }], config).digest);
    assert.notEqual(original.digest, fingerprintCompilerBuildInputs(files, { ...config, profile: 'other' }).digest);
    assert.ok(!JSON.stringify(original).includes('fixture-secret'));
    assert.ok(!JSON.stringify(original).includes('nested"'));
});

test('only a successful unchanged build can produce an immutable manifest', () => {
    assert.equal(createCompilerBuildManifest({ before: inputs(), after: inputs(), artifacts: [artifact()], successful: false }), undefined);
    assert.equal(createCompilerBuildManifest({ before: inputs(), after: fingerprintCompilerBuildInputs(files, {}), artifacts: [artifact()], successful: true }), undefined);
    assert.equal(createCompilerBuildManifest({ before: inputs(), after: inputs(), artifacts: [], successful: true }), undefined);
    const value = manifest();
    assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.artifacts));
    assert.ok(!JSON.stringify(value).includes('fixture-secret'));
    assert.deepEqual(parseCompilerBuildManifest(JSON.stringify(value)), value);
});

test('freshness rejects old/missing maps, changed profile, dependency, compiler or feature bytes', () => {
    const value = manifest();
    assert.equal(verifyCompilerBuildManifest(undefined, inputs(), [artifact()]), 'missing');
    assert.equal(verifyCompilerBuildManifest(value, inputs(), [artifact()]), 'fresh');
    assert.equal(verifyCompilerBuildManifest(value, fingerprintCompilerBuildInputs(files, {}), [artifact()]), 'inputsChanged');
    assert.equal(verifyCompilerBuildManifest(value, fingerprintCompilerBuildInputs(files.map(file => file.uri.endsWith('.epf') ? { ...file, content: 'new compiler' } : file), config), [artifact()]), 'inputsChanged');
    assert.equal(verifyCompilerBuildManifest(value, inputs(), []), 'artifactsChanged');
    assert.equal(verifyCompilerBuildManifest(value, inputs(), [fingerprintCompilerBuildArtifact(1, 'part-1/same.feature', 'edited', 'part-1/same.str', '{}')]), 'artifactsChanged');
    assert.equal(verifyCompilerBuildManifest(value, inputs(), [fingerprintCompilerBuildArtifact(1, 'part-1/same.feature', 'Feature: A', 'part-1/same.str', 'edited map')]), 'artifactsChanged');
});

test('equal basenames from different workers remain distinct, and worker reassignment invalidates artifacts', () => {
    const parts = [artifact(1), artifact(2)];
    const value = createCompilerBuildManifest({ before: inputs(), after: inputs(), artifacts: parts, successful: true })!;
    assert.equal(value.artifacts.length, 2);
    assert.equal(verifyCompilerBuildManifest(value, inputs(), [...parts].reverse()), 'fresh');
    assert.equal(verifyCompilerBuildManifest(value, inputs(), [{ ...parts[0], worker: 2 }, parts[1]]), 'artifactsChanged');
    assert.throws(() => createCompilerBuildManifest({ before: inputs(), after: inputs(), artifacts: [parts[0], { ...parts[0], worker: 2 }], successful: true }), /duplicate|artifact/i);
});

test('untrusted manifests reject schema/hash tampering, traversal and duplicate source identity', () => {
    const value = manifest();
    for (const invalid of [null, {}, { ...value, schemaVersion: 99 }, { ...value, inputs: { ...value.inputs, digest: '0'.repeat(64) } },
        { ...value, artifacts: [{ ...artifact(), feature: '../outside.feature' }] }, { ...value, artifacts: [{ ...artifact(), sourceMap: 'C:\\outside.str' }] },
        { ...value, artifacts: [{ ...artifact(), featureHash: 'bad' }] }, { ...value, artifacts: [artifact(), artifact()] }]) {
        assert.equal(parseCompilerBuildManifest(JSON.stringify(invalid)), undefined);
    }
    assert.equal(parseCompilerBuildManifest('broken JSON'), undefined);
    assert.throws(() => fingerprintCompilerBuildInputs([files[0], files[0]], config), /duplicate/i);
    for (const file of ['/outside.feature', 'C:/outside.feature', 'part-1/../outside.feature', 'part-1\\outside.feature']) {
        assert.throws(() => fingerprintCompilerBuildArtifact(1, file, '', 'same.str', ''), /path|artifact/i);
    }
});
