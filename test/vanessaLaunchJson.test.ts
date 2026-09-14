import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyAdditionalVanessaParameters,
    applyGlobalVanessaVariables,
    findObjectKeyByAlias,
    getJsonValueAtPointer,
    parseAdditionalParameterPointer,
    resolveExistingPointerByAliases,
    setJsonValueAtPointer
} from '../src/vanessaLaunchJson';

test('JSON pointer get and set support root, nested, escaped tokens, arrays and missing paths', () => {
    const source = {
        config: {
            'path/to': [
                { '~name': 'old' }
            ]
        }
    };

    assert.equal(getJsonValueAtPointer(source, ''), source);
    assert.equal(getJsonValueAtPointer(source, '/config/path~1to/0/~0name'), 'old');
    assert.equal(getJsonValueAtPointer(source, '/config/missing'), undefined);

    const updated = setJsonValueAtPointer(source, '/config/path~1to/0/~0name', 'new');
    assert.equal(getJsonValueAtPointer(updated, '/config/path~1to/0/~0name'), 'new');
    assert.equal(source.config['path/to'][0]['~name'], 'old');

    const replacedRoot = setJsonValueAtPointer(source, '', { replaced: true });
    assert.deepEqual(replacedRoot, { replaced: true });
});

test('JSON pointer set creates array and object containers without mutating its input', () => {
    const source = { untouched: true };

    const updated = setJsonValueAtPointer(source, '/clients/0/name', 'Test client');

    assert.deepEqual(updated, {
        untouched: true,
        clients: [{ name: 'Test client' }]
    });
    assert.deepEqual(source, { untouched: true });
    assert.equal(parseAdditionalParameterPointer('clients[0].name')?.join('/'), 'clients/0/name');
});

test('alias resolution uses current Vanessa aliases and preserves unknown keys', () => {
    const source = {
        VersionVA: '1.2',
        CustomSetting: true
    };

    assert.equal(findObjectKeyByAlias(source, 'ВерсияVA'), 'VersionVA');
    assert.equal(findObjectKeyByAlias(source, 'customsetting'), 'CustomSetting');
    assert.equal(findObjectKeyByAlias(source, 'UnknownSetting'), null);
    assert.deepEqual(resolveExistingPointerByAliases(source, ['ВерсияVA']), ['VersionVA']);
});

test('additional Vanessa parameters resolve aliases, preserve existing types and clone input', () => {
    const source = {
        VersionVA: 'old',
        RunningScripts: {
            Timeout: 1,
            Enabled: false
        },
        clients: [{ Name: 'Old client' }]
    };

    const result = applyAdditionalVanessaParameters(source, [
        { key: 'ВерсияVA', value: 'new', overrideExisting: true },
        { key: 'RunningScripts.Timeout', value: '2', overrideExisting: true },
        { key: '/RunningScripts/Enabled', value: 'true', overrideExisting: true },
        { key: 'clients[0].Name', value: 'New client', overrideExisting: true },
        { key: 'UnknownSetting', value: '{"mode":"safe"}', overrideExisting: true }
    ]);

    assert.equal(result.changedCount, 5);
    assert.deepEqual(result.value, {
        VersionVA: 'new',
        RunningScripts: {
            Timeout: 2,
            Enabled: true
        },
        clients: [{ Name: 'New client' }],
        UnknownSetting: { mode: 'safe' }
    });
    assert.deepEqual(source, {
        VersionVA: 'old',
        RunningScripts: {
            Timeout: 1,
            Enabled: false
        },
        clients: [{ Name: 'Old client' }]
    });
});

test('additional Vanessa parameters respect override and SPPR client compatibility rules', () => {
    const source = {
        КлиентыТестирования: [{ Имя: 'Existing' }],
        stoponerror: false
    };

    const result = applyAdditionalVanessaParameters(source, [
        { key: 'datatestclients[0].Name', value: 'Skipped', overrideExisting: true },
        { key: 'ОстановкаПриВозникновенииОшибки', value: 'true', overrideExisting: false }
    ]);

    assert.equal(result.changedCount, 0);
    assert.deepEqual(result.value, source);
    assert.notEqual(result.value, source);
});

test('global Vanessa variables are applied to an aliased cloned container', () => {
    const source = {
        global_vars: {
            Existing: 1
        }
    };

    const result = applyGlobalVanessaVariables(source, [
        { key: 'Existing', value: '2', overrideExisting: true },
        { key: 'NewValue', value: 'false', overrideExisting: true }
    ]);

    assert.equal(result.changedCount, 2);
    assert.deepEqual(result.value, {
        global_vars: {
            Existing: 2,
            NewValue: false
        }
    });
    assert.deepEqual(source, { global_vars: { Existing: 1 } });
});
