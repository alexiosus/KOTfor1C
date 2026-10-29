import assert from 'node:assert/strict';
import test from 'node:test';
import { setupProfileParameters } from '../src/kotSetupProfile';
import { getCompilerBuildParameterValue } from '../src/compilerBuildParameters';

test('a setup profile replaces source and library aliases while retaining unrelated custom options', () => {
    const result = setupProfileParameters([{ key: 'ScenarioFolder', value: 'old' }, { key: 'VanessaLibraries', value: 'old-lib' }, { key: 'CustomOption', value: 'keep' }], '/second', 'tests', 'libraries');
    assert.equal(getCompilerBuildParameterValue(result, 'ScenarioFolder', 'TestFolder'), 'tests');
    assert.equal(getCompilerBuildParameterValue(result, 'Libraries', 'VanessaLibraries'), 'libraries');
    assert.equal(getCompilerBuildParameterValue(result, 'CustomOption'), 'keep');
    assert.equal(result.filter(row => ['Libraries', 'VanessaLibraries'].includes(row.key)).length, 1);
});

test('setup preserves multiple configured library roots as separate paths', () => {
    const result = setupProfileParameters([], '/second', 'tests', 'libraries|shared');
    assert.equal(getCompilerBuildParameterValue(result, 'Libraries'), 'libraries|shared');
});

test('setup keeps separate scenario and process roots in an existing profile', () => {
    const result = setupProfileParameters([{ key: 'ScenarioFolder', value: 'scenarios' }, { key: 'ProcessFolder', value: 'processes' }], '/project', 'scenarios', 'libraries');
    assert.equal(getCompilerBuildParameterValue(result, 'TestFolder', 'ScenarioFolder'), 'scenarios');
    assert.equal(getCompilerBuildParameterValue(result, 'TestFolder', 'ProcessFolder'), 'processes');
});

test('setup keeps external libraries absolute while storing internal paths relative to the project', () => {
    const result = setupProfileParameters([], '/project', '/project/tests', '/project/libraries|/shared/library');
    assert.equal(getCompilerBuildParameterValue(result, 'ScenarioFolder'), 'tests');
    assert.equal(getCompilerBuildParameterValue(result, 'Libraries'), 'libraries|/shared/library');
    assert.equal(getCompilerBuildParameterValue(result, 'FeatureFolder'), '.vscode/kot-runtime/features');
});
