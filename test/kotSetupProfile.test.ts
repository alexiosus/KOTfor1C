import assert from 'node:assert/strict';
import test from 'node:test';
import { setupProfileParameters } from '../src/kotSetupProfile';
import { getCompilerBuildParameterValue } from '../src/compilerBuildParameters';

test('a setup profile replaces source and library aliases while retaining unrelated custom options', () => {
    const result = setupProfileParameters([{ key: 'ScenarioFolder', value: 'old' }, { key: 'VanessaLibraries', value: 'old-lib' }, { key: 'CustomOption', value: 'keep' }], '/second', 'tests', 'libraries');
    assert.equal(getCompilerBuildParameterValue(result, 'ScenarioFolder', 'TestFolder'), '/second/tests');
    assert.equal(getCompilerBuildParameterValue(result, 'Libraries', 'VanessaLibraries'), '/second/libraries');
    assert.equal(getCompilerBuildParameterValue(result, 'CustomOption'), 'keep');
    assert.equal(result.filter(row => ['Libraries', 'VanessaLibraries'].includes(row.key)).length, 1);
});

test('setup preserves multiple configured library roots as separate paths', () => {
    const result = setupProfileParameters([], '/second', 'tests', 'libraries|shared');
    assert.equal(getCompilerBuildParameterValue(result, 'Libraries'), '/second/libraries|/second/shared');
});

test('setup keeps separate scenario and process roots in an existing profile', () => {
    const result = setupProfileParameters([{ key: 'ScenarioFolder', value: 'scenarios' }, { key: 'ProcessFolder', value: 'processes' }], '/project', 'scenarios', 'libraries');
    assert.equal(getCompilerBuildParameterValue(result, 'TestFolder', 'ScenarioFolder'), '/project/scenarios');
    assert.equal(getCompilerBuildParameterValue(result, 'TestFolder', 'ProcessFolder'), '/project/processes');
});
