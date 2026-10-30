import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compilerCreatesLaunchJson,
    getEffectiveCompilerLibraries,
    getEffectiveLaunchInfobase,
    getEffectiveVanessaFolder,
    importCompilerBuildParameters,
    normalizeCompilerBuildParameters,
    serializeCompilerBuildParameters
} from '../src/compilerBuildParameters';

test('JSON import keeps scalar and custom values as strings while using pipe separated library arrays', () => {
    assert.deepEqual(importCompilerBuildParameters({
        Libraries: ['lib/one', 'C:\\Shared\\Steps'], VanessaLibraries: ['fallback'],
        ThreadNumber: 0, CreateJson: false, ModelDBSettings: '',
        CustomUrl: 'https://example.invalid/x', CustomObject: { mode: 'QA' }
    }), [
        { key: 'Libraries', value: 'lib/one|C:\\Shared\\Steps' },
        { key: 'VanessaLibraries', value: 'fallback' }, { key: 'ThreadNumber', value: '0' },
        { key: 'CreateJson', value: 'false' }, { key: 'ModelDBSettings', value: '' },
        { key: 'CustomUrl', value: 'https://example.invalid/x' }, { key: 'CustomObject', value: '{"mode":"QA"}' }
    ]);
    for (const value of [null, [], 'wrong', 42]) {
        assert.equal(importCompilerBuildParameters(value), null);
    }
});

test('effective launch target obeys compiler role and alias priority independent of row order', () => {
    const parameters = [
        { key: 'TestClientDB', value: 'Srvr="preferred";Ref="QA";' },
        { key: 'InfobasePath', value: 'Srvr="fallback";Ref="QA";' },
        { key: 'TestClientDBPath', value: 'old-folder' }, { key: 'LaunchDBFolder', value: 'bases/qa' }
    ];
    assert.equal(getEffectiveLaunchInfobase(parameters, '/project'), 'Srvr="preferred";Ref="QA";');
    assert.equal(getEffectiveLaunchInfobase(parameters.slice(2), '/project'), 'File="/project/bases/qa";');
    assert.equal(getEffectiveLaunchInfobase([
        { key: 'LaunchDBFolder', value: 'File="C:\\Bases\\QA";' }
    ], '/project'), 'File="C:\\Bases\\QA";');
});

test('blank high priority aliases override fallback values consistently with the compiler', () => {
    assert.equal(getEffectiveLaunchInfobase([
        { key: 'InfobasePath', value: 'Srvr="ignored";Ref="QA";' },
        { key: 'TestClientDB', value: '' }, { key: 'LaunchDBFolder', value: 'base' }
    ], '/project'), 'File="/project/base";');
    assert.deepEqual(getEffectiveCompilerLibraries([
        { key: 'VanessaLibraries', value: 'ignored/lib' }, { key: 'Libraries', value: '' }
    ], '/project'), []);
    assert.equal(getEffectiveVanessaFolder([
        { key: 'VanessaFolder', value: 'ignored' }, { key: 'VanessaPath', value: '' }
    ]), '');
});

test('one library list policy serves compiler payloads and standalone launch without adding built-in directories', () => {
    const parameters = [
        { key: 'VanessaLibraries', value: 'ignored/library' },
        { key: 'Libraries', value: 'lib/one|C:\\Shared\\Steps|/shared/two' }
    ];
    assert.deepEqual(getEffectiveCompilerLibraries(parameters, '/project'), [
        '/project/lib/one', 'C:\\Shared\\Steps', '/shared/two'
    ]);
    assert.equal(serializeCompilerBuildParameters(parameters, '/project').Libraries,
        '/project/lib/one|C:\\Shared\\Steps|/shared/two');
});

test('explicit path keys resolve relative roots and preserve Windows and UNC absolute paths', () => {
    const payload = serializeCompilerBuildParameters([
        { key: 'ScenarioFolder', value: './tests' }, { key: 'ProcessFolder', value: '../processes' },
        { key: 'FeatureFolder', value: 'C:\\build\\features' },
        { key: 'ModelDBSettings', value: '\\\\server\\share\\model.yaml' },
        { key: 'CustomFile', value: 'relative/settings.yaml' },
        { key: 'TestClientDB', value: 'File="C:\\Bases\\QA";' }
    ], '/project');
    assert.deepEqual(payload, {
        ScenarioFolder: '/project/tests', ProcessFolder: '/processes', FeatureFolder: 'C:\\build\\features',
        ModelDBSettings: '\\\\server\\share\\model.yaml', CustomFile: 'relative/settings.yaml',
        TestClientDB: 'File="C:\\Bases\\QA";'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
});

test('TestFolder canonicalization preserves empty overrides and defaulting distinguishes missing fields', () => {
    const normalized = normalizeCompilerBuildParameters([
        { key: 'TestFolder', value: '' }, { key: 'ScenarioFolder', value: 'ignored' },
        { key: 'ProcessFolder', value: 'ignored-processes' }, { key: 'ModelDBSettings', value: '' }
    ], { defaultModelDbSettings: 'default-model.yaml', defaultVanessaFolder: 'default-vanessa' });
    assert.equal(normalized.find(item => item.key === 'ScenarioFolder')?.value, '');
    assert.equal(normalized.find(item => item.key === 'ProcessFolder')?.value, '');
    assert.equal(normalized.find(item => item.key === 'ModelDBSettings')?.value, '');
    assert.equal(normalized.find(item => item.key === 'VanessaFolder')?.value, 'default-vanessa');
    assert.equal(normalized.some(item => item.key === 'TestFolder'), false);
    assert.deepEqual(normalizeCompilerBuildParameters(normalized), normalized);
});

test('launch JSON is enabled by default and disabled explicitly in compiler-compatible boolean strings', () => {
    assert.equal(compilerCreatesLaunchJson([]), true);
    assert.equal(compilerCreatesLaunchJson([{ key: 'CreateJson', value: 'False' }]), false);
    assert.equal(compilerCreatesLaunchJson([{ key: 'CreateJson', value: 'Истина' }]), true);
    assert.equal(compilerCreatesLaunchJson([{ key: 'CreateJson', value: 'true' }]), true);
});

test('custom keys resembling object prototype properties survive JSON serialization', () => {
    const imported = importCompilerBuildParameters(JSON.parse('{"__proto__":"synthetic/value","constructor":"1.0.1"}'))!;
    const payload = serializeCompilerBuildParameters(imported, '/project');
    assert.equal(JSON.parse(JSON.stringify(payload)).__proto__, 'synthetic/value');
    assert.equal(payload.constructor, '1.0.1');
});

test('profile normalization preserves arbitrary compiler extension keys and their literal values', () => {
    const parameters = normalizeCompilerBuildParameters([
        { key: 'UC', value: 'synthetic\\token/1.0.1' },
        { key: 'CustomKey', value: 'https://example.invalid/path' }
    ]);
    const payload = serializeCompilerBuildParameters(parameters, '/project');
    assert.equal(payload.UC, 'synthetic\\token/1.0.1');
    assert.equal(payload.CustomKey, 'https://example.invalid/path');
});
