import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ensureDefaultLibrariesParameter, getDefaultAdditionalVanessaParameters } from '../src/yamlParameterDefaults';

test('new profile defaults enable VanessaExt and disable the first-launch helper with explicit profile priority', () => {
    assert.deepEqual(getDefaultAdditionalVanessaParameters(), [
        { key: 'ИспользоватьКомпонентуVanessaExt', value: 'true', overrideExisting: true },
        { key: 'ИспользоватьПарсерGherkinИзКомпонентыVanessaExt', value: 'true', overrideExisting: true },
        { key: 'ПоискФайловСПомощьюКомпонентыVanessaExt', value: 'true', overrideExisting: true },
        { key: 'ShowHelperOnFirstLaunch', value: 'false', overrideExisting: true }
    ]);
});

test('does not duplicate the built-in library already supplied by the compiler', () => {
    const parameters = ensureDefaultLibrariesParameter([
        { key: 'VanessaFolder', value: path.join('tools', 'vanessa') },
        { key: 'FeatureFolder', value: 'build/features' }
    ]);

    assert.deepEqual(parameters, [
        { key: 'VanessaFolder', value: path.join('tools', 'vanessa') },
        { key: 'FeatureFolder', value: 'build/features' },
        { key: 'Libraries', value: '' }
    ]);
});

test('does not override VanessaLibraries by adding the Libraries alias', () => {
    const parameters = ensureDefaultLibrariesParameter([
        { key: 'VanessaFolder', value: 'tools/vanessa' },
        { key: 'VanessaLibraries', value: 'custom/one|custom/two' }
    ]);

    assert.deepEqual(parameters, [
        { key: 'VanessaFolder', value: 'tools/vanessa' },
        { key: 'VanessaLibraries', value: 'custom/one|custom/two' }
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
