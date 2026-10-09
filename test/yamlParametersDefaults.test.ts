import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ensureDefaultLibrariesParameter } from '../src/yamlParameterDefaults';

test('adds Libraries relative to the effective VanessaFolder when it is missing', () => {
    const parameters = ensureDefaultLibrariesParameter([
        { key: 'VanessaFolder', value: path.join('tools', 'vanessa') },
        { key: 'FeatureFolder', value: 'build/features' }
    ]);

    assert.deepEqual(parameters, [
        { key: 'VanessaFolder', value: path.join('tools', 'vanessa') },
        { key: 'Libraries', value: path.join('tools', 'vanessa', 'features', 'Libraries') },
        { key: 'FeatureFolder', value: 'build/features' }
    ]);
});

test('preserves an explicitly configured Libraries parameter', () => {
    const parameters = ensureDefaultLibrariesParameter([
        { key: 'VanessaFolder', value: path.join('tools', 'vanessa') },
        { key: 'Libraries', value: 'custom/libraries' }
    ]);

    assert.deepEqual(parameters, [
        { key: 'VanessaFolder', value: path.join('tools', 'vanessa') },
        { key: 'Libraries', value: 'custom/libraries' }
    ]);
});
