import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPropertyCatalogPresentation } from '../src/scenarioPropertiesCatalogPresentation';
import { readScenarioProperties } from '../src/scenarioPropertiesModel';
import type { ScenarioPropertiesCatalogs } from '../src/scenarioPropertiesCatalogs';

const catalogs: ScenarioPropertiesCatalogs = {
    projects: ['Drive'], reportLevel1: ['Sales'], reportLevel2: ['Checkout'], categories: ['Smoke'], responsibles: ['Alex'],
    systemFunctions: [{ name: 'Sales function', uid: 'fn-id' }],
    bases: [{ name: 'Etalon', id: 'base-id', profiles: ['Administrator', 'Tester'] }, { name: 'Other', id: 'other-id', profiles: ['Runner'] }],
    userProfiles: ['Administrator', 'Runner', 'Tester'], settingsUserProfiles: ['Administrator', 'Tester']
};

test('source catalogs use native choices and creation while system function labels hide identities', () => {
    const model = readScenarioProperties('ТипФайла: Сценарий\nДанныеСценария:\n    UID: source\n    ФункцияСистемы: Old name\n    UIDФункцияСистемы: fn-id\nТекстСценария: |\n    Given ready\n');
    applyPropertyCatalogPresentation(model, catalogs);
    for (const key of ['Проект', 'УровеньОтчета1', 'УровеньОтчета2', 'ПрофильПользователя', 'ФункцияСистемы', 'Ответственный']) {
        const field = model.header.find(field => field.key === key)!;
        assert.ok(field.choices); assert.equal(field.action, 'catalogChoice'); assert.equal(field.createAction, 'createChoice');
    }
    const fn = model.header.find(field => field.key === 'ФункцияСистемы')!;
    assert.equal(fn.value, 'fn-id'); assert.deepEqual(fn.choices, ['fn-id']); assert.equal(fn.choiceLabels?.['fn-id'], 'Sales function');
    assert.deepEqual(model.header.find(field => field.key === 'ПрофильПользователя')?.choices, ['', ...catalogs.userProfiles]);
});

function settings(baseName = 'Etalon', baseId = 'base-id', profileFirst = false) {
    return readScenarioProperties(`ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: source\n${profileFirst ? '    ПрофильПользователя: Tester\n' : ''}    ЭталоннаяБазаИмя: ${baseName}\n    ИдентификаторБазы: ${baseId}\n${profileFirst ? '' : '    ПрофильПользователя: Tester\n'}`);
}
test('settings base labels use names and profiles are scoped to the matching base irrespective of YAML field order', () => {
    for (const first of [false, true]) {
        const model = settings('Etalon', 'base-id', first); applyPropertyCatalogPresentation(model, catalogs);
        const base = model.header.find(field => field.key === 'ЭталоннаяБазаИмя')!;
        assert.equal(base.value, 'base-id'); assert.equal(base.choiceLabels?.['other-id'], 'Other');
        assert.deepEqual(model.header.find(field => field.key === 'ПрофильПользователя')?.choices, ['', 'Administrator', 'Tester']);
    }
});
test('an inconsistent base name and identity cannot offer profiles from that identity', () => {
    const model = settings('Deleted base', 'base-id'); applyPropertyCatalogPresentation(model, catalogs);
    const base = model.header.find(field => field.key === 'ЭталоннаяБазаИмя')!;
    assert.equal(base.value, '__kot_missing_base__'); assert.equal(base.choiceLabels?.[base.value], 'Deleted base');
    assert.deepEqual(model.header.find(field => field.key === 'ПрофильПользователя')?.choices, ['']);
    assert.equal(base.createAction, 'createChoice');
});
