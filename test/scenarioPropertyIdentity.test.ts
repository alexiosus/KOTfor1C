import assert from 'node:assert/strict';
import test from 'node:test';
import { applyScenarioPropertyIdentity } from '../src/scenarioPropertyIdentity';

const change = { uid: 'scenario', oldName: 'Old', oldCode: '001', field: 'name' as const, value: 'New' };
test('inline rename updates caller text and declarations while leaving unrelated settings untouched', () => {
    const caller = 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: caller\n    Имя: Caller\nВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: scenario\n        ИмяСценария: Old\nТекстСценария: |\n    And Old\n    * And Old # call\n    // And Old\n    /*\n    And Old\n    */\n    """\n    And Old\n    """\n';
    const result = applyScenarioPropertyIdentity(caller, change);
    assert.match(result, /ИмяСценария: "New"/); assert.match(result, /And New/); assert.match(result, /\/\/ And Old/);
    assert.match(result, /\* And New # call/); assert.match(result, /\/\*\n    And Old\n    \*\//); assert.match(result, /"""\n    And Old\n    """/);
    const settings = 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: other\n    СценарийНаименование: Old\n    Имя: Old\n';
    assert.equal(applyScenarioPropertyIdentity(settings, change), settings);
});
test('inline names/codes are independent, preserve custom variants and update process references by UID', () => {
    const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: scenario\n    Имя: Old\n    Код: "001"\nТекстСценария: |\n    And I do a step\n';
    assert.match(applyScenarioPropertyIdentity(source, change), /Код: "001"/);
    assert.match(applyScenarioPropertyIdentity(source, { ...change, field: 'code', value: '002' }), /Имя: Old/);
    const settings = 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: scenario\n    СценарийНаименование: Old\n    Имя: Custom variant\n    Код: CustomCode\n';
    const renamed = applyScenarioPropertyIdentity(settings, change);
    assert.match(renamed, /СценарийНаименование: "New"/); assert.match(renamed, /Имя: Custom variant/);
    assert.match(applyScenarioPropertyIdentity(settings, { ...change, field: 'code', value: '002' }), /Код: CustomCode/);
    const process = 'ТипФайла: Процесс\nДанныеПроцесса:\n    UID: process\nШагиПроцесса:\n    - ШагиПроцесса1:\n        ТипШага: "0"\n        UID: step\n        СценарийUID: scenario\n        СценарийНаименование: Old\n        СценарийКод: "001"\n        Наименование: Old\n';
    assert.match(applyScenarioPropertyIdentity(process, change), /СценарийНаименование: "New"/);
    assert.match(applyScenarioPropertyIdentity(process, { ...change, field: 'code', value: '002' }), /СценарийКод: "002"/);
    assert.equal(applyScenarioPropertyIdentity(process.replace('СценарийUID: scenario', 'СценарийUID: other'), change), process.replace('СценарийUID: scenario', 'СценарийUID: other'));
});

test('inline rename updates supported legacy callers without a file type', () => {
    const caller = 'ДанныеСценария:\n    UID: caller\n    Имя: Caller\nВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: scenario\n        ИмяСценария: Old\nТекстСценария: |\n    And Old\n';
    const renamed = applyScenarioPropertyIdentity(caller, change);
    assert.match(renamed, /ИмяСценария: "New"/u);
    assert.match(renamed, /And New/u);
    assert.match(renamed, /UID: caller\n    Имя: Caller/u);
});

test('legacy caller recognition does not edit malformed or non-scenario header shapes', () => {
    const body = 'ТекстСценария: |\n    And Old\n';
    for (const header of ['ДанныеСценария: []\n', 'ДанныеСценария:\n    UID: caller\n', 'ТипФайла: Процесс\nДанныеСценария:\n    Имя: Caller\n']) {
        const source = header + body;
        assert.equal(applyScenarioPropertyIdentity(source, change), source);
    }
    assert.throws(() => applyScenarioPropertyIdentity('ДанныеСценария:\n    Имя: Caller\nДанныеСценария:\n    Имя: Other\n' + body, change), /ambiguous/iu);
});
