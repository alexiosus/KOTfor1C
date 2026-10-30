import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import {
    readScenarioProperties, applyScenarioPropertyEdit, addScenarioPropertyRecord,
    removeScenarioPropertyRecord, moveScenarioPropertyRecord, applyYamlMapField
} from '../src/scenarioPropertiesModel';
import { buildCompilerProcessFiles } from '../src/compilerProcesses';

test('compiler flag aliases have only the two canonical presentation values', () => {
    const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: uid\n    Имя: Test\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: P\n        ИсходящийПараметр: No\n';
    const value = readScenarioProperties(source).sections[0].records![0].fields.find(field => field.key === 'ИсходящийПараметр')!;
    assert.equal(value.value, 'Нет'); assert.deepEqual(value.choices, ['Да', 'Нет']);
});

test('parameter rename rewrites exact body substitutions including tables and docstrings, preserving comments and escaped text', () => {
    const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: uid\n    Имя: Test\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: Old\n        Значение: x\nТекстСценария: |\n    And I use "[Old]" and "[OldOther]"\n    | [Old] |\n    """\n    [Old]\n    """\n    // [Old]\n    /*\n    [Old]\n    */\n    And I use "\\[Old]"\n';
    const updated = applyScenarioPropertyEdit(source, { section: 'ПараметрыСценария', recordKey: 'Old', field: 'Имя', value: 'New' });
    assert.match(updated, /Имя: "New"/);
    assert.match(updated, /"\[New\]" and "\[OldOther\]"/);
    assert.match(updated, /\| \[New\] \|/);
    assert.match(updated, /"""\n    \[New\]\n    """/);
    assert.match(updated, /\/\/ \[Old\]/);
    assert.match(updated, /\/\*\n    \[Old\]/);
    assert.match(updated, /\\\[Old\]/);
    const record = readScenarioProperties(source).sections[0].records![0];
    assert.equal(record.usages, 3);
});

const scenario = '\uFEFFТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "scenario-uid"\n    Имя: "Order"\n    Код: "Order"\n    Проект: "Drive" # project\n    CustomHeader: "kept"\nПараметрыСценария:\n    # currency\n    - ПараметрыСценария7:\n        НомерСтроки: "7"\n        Имя: "Currency"\n        Значение: "EUR;USD" # variants\n        ТипПараметра: "Строка"\n        Custom: "untouched"\n    - ПараметрыСценария9:\n        НомерСтроки: "9"\n        Имя: "Rows"\n        Значение: | # table\n            | Currency |\n            | EUR |\n        ТипПараметра: "Таблица"\nВложенныеСценарии:\n    - ВложенныеСценарии:\n        UIDВложенныйСценарий: "nested-1"\n        ИмяСценария: "Create order"\n    - ВложенныеСценарии:\n        UIDВложенныйСценарий: "nested-2"\n        ИмяСценария: "Check order"\nТегиСценария: [] # tags\nТекстСценария: |\n    # language: en\n    And Create order\n    # preserve: body\nТегиТеста:\n';
const field = (fields: { key: string; value: string; readonly?: boolean; multiline?: boolean; choices?: string[] }[], key: string) => fields.find(item => item.key === key)!;
const sourceBody = (source: string) => source.slice(source.indexOf('ТекстСценария:'));
function processSource(): string {
    return buildCompilerProcessFiles({ name: 'Process', code: 'Process', fullCode: 'Drive.Process', uid: 'process', settingsUid: 'settings', project: 'Drive', userProfile: 'Tester', databaseId: 'base', reportLevel1: '', reportLevel2: '', steps: [
        { uid: 'step-a', scenario: { name: 'Order', uid: 'order', scenarioCode: 'Order', parameters: [{ name: 'Result', type: 'Строка', outgoing: true, value: '' }] } },
        { uid: 'step-b', scenario: { name: 'Check', uid: 'check', scenarioCode: 'Check', parameters: [{ name: 'Input', type: 'Таблица', outgoing: false, value: '| A |\n| B |' }] } }
    ] }).processSource;
}

test('reads scenario headers, optional fields and compiler parameter controls', () => {
    const model = readScenarioProperties(scenario);
    assert.equal(model.kind, 'scenario'); assert.equal(model.title, 'Order');
    assert.equal(field(model.header, 'CustomHeader').value, 'kept');
    for (const key of ['UID', 'Имя', 'Код']) { assert.equal(field(model.header, key).readonly, true); }
    assert.equal(field(model.header, 'ПрофильПользователя').value, '');
    const parameters = model.sections.find(section => section.key === 'ПараметрыСценария')!.records!;
    assert.deepEqual(parameters.map(record => record.key), ['Currency', 'Rows']);
    assert.deepEqual(field(parameters[0].fields, 'ИсходящийПараметр').choices, ['Да', 'Нет']);
    assert.deepEqual(field(parameters[0].fields, 'НесколькоЗначений').choices, ['Да', 'Нет']);
    assert.ok(field(parameters[0].fields, 'ТипПараметра').choices!.includes('Таблица'));
    assert.equal(field(parameters[1].fields, 'Значение').multiline, true);
    assert.match(field(parameters[1].fields, 'Значение').value, /\| EUR \|/u);
    assert.deepEqual(model.sections.find(section => section.key === 'ВложенныеСценарии')!.records!.map(record => record.key), ['nested-1', 'nested-2']);
});

test('reads process steps with nested parameters and run settings with exact linkage', () => {
    const process = readScenarioProperties(processSource());
    assert.equal(process.kind, 'process');
    const steps = process.sections.find(section => section.key === 'ШагиПроцесса')!.records!;
    assert.deepEqual(steps.map(record => record.key), ['step-a', 'step-b']);
    assert.equal(field(steps[0].fields, 'СценарийUID').readonly, true);
    assert.equal(steps[1].sections![0].key, 'ПараметрыШага');
    assert.equal(field(steps[1].sections![0].records![0].fields, 'ЗначениеПроизвольное').multiline, true);
    for (const [type, kind, linked] of [['НастройкаТеста', 'test', 'UIDСценария'], ['НастройкаПроцесса', 'processTest', 'UIDПроцесса']]) {
        const settings = readScenarioProperties(`ТипФайла: "${type}"\nДанныеТеста:\n    UID: "test"\n    Имя: "Settings"\n    ${linked}: "source"\n    Extra: "custom"\nПараметрыТеста:\nТегиТеста:\n`);
        assert.equal(settings.kind, kind); assert.equal(field(settings.header, linked).readonly, true);
        assert.equal(field(settings.header, 'Extra').value, 'custom');
        assert.ok(field(settings.header, 'ПараметрыЗапуска'));
        assert.deepEqual(settings.sections.map(section => section.key), ['ПараметрыТеста', 'ТегиТеста']);
    }
});

test('edits headers and parameters without rewriting comments, unknown fields or CRLF body', () => {
    const original = scenario.replace(/\n/gu, '\r\n');
    let updated = applyScenarioPropertyEdit(original, { section: 'ДанныеСценария', field: 'Проект', value: 'New: project' });
    updated = applyScenarioPropertyEdit(updated, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'Значение', value: 'GBP;CHF' });
    updated = applyScenarioPropertyEdit(updated, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'ИсходящийПараметр', value: 'Да' });
    assert.ok(updated.startsWith('\uFEFF')); assert.equal(sourceBody(updated), sourceBody(original));
    assert.match(updated, /Проект: "New: project" # project/u);
    assert.match(updated, /Значение: "GBP;CHF" # variants/u);
    assert.match(updated, /Custom: "untouched"/u);
    assert.equal(field(readScenarioProperties(updated).sections[0].records![0].fields, 'ИсходящийПараметр').value, 'Да');
    assert.equal(updated.replace(/\r\n/gu, '').includes('\n'), false);
});

test('filling an absent header or parameter field does not move controls in the properties form', () => {
    const before = readScenarioProperties(scenario);
    let updated = applyScenarioPropertyEdit(scenario, { section: 'ДанныеСценария', field: 'Ответственный', value: 'Owner' });
    assert.deepEqual(readScenarioProperties(updated).header.map(field => field.key), before.header.map(field => field.key));
    updated = applyScenarioPropertyEdit(updated, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'НесколькоЗначений', value: 'Да' });
    assert.deepEqual(readScenarioProperties(updated).sections[0].records![0].fields.map(field => field.key), before.sections[0].records![0].fields.map(field => field.key));
    assert.equal(sourceBody(updated), sourceBody(scenario));
    assert.equal(field(readScenarioProperties(updated).header, 'Ответственный').value, 'Owner');
});

test('round trips literal table and scalar multiline parameter values', () => {
    let updated = applyScenarioPropertyEdit(scenario, { section: 'ПараметрыСценария', recordKey: 'Rows', field: 'Значение', value: '| Currency |\n| GBP |\n' });
    assert.match(updated, /Значение: \| # table\n            \| Currency \|\n            \| GBP \|/u);
    assert.equal(field(readScenarioProperties(updated).sections[0].records![1].fields, 'Значение').value, '| Currency |\n| GBP |\n');
    updated = applyScenarioPropertyEdit(updated, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'Значение', value: 'first\nsecond' });
    assert.match(updated, /Значение: \| # variants\n            first\n            second/u);
    assert.equal(sourceBody(updated), sourceBody(scenario));
});

test('adds compiler-compatible records to empty or missing sections and removes by identity', () => {
    let updated = addScenarioPropertyRecord(scenario, { section: 'ТегиСценария' }, { Имя: 'smoke' });
    assert.match(updated, /ТегиСценария: # tags/u);
    assert.equal(readScenarioProperties(updated).sections.find(section => section.key === 'ТегиСценария')!.records![0].key, 'smoke');
    updated = addScenarioPropertyRecord(updated, { section: 'ПараметрыСценария' }, { Имя: 'Count', ТипПараметра: 'Число', Значение: '42' });
    const added = readScenarioProperties(updated).sections[0].records!.find(record => record.key === 'Count')!;
    assert.equal(field(added.fields, 'НесколькоЗначений').value, 'Нет');
    updated = removeScenarioPropertyRecord(updated, { section: 'ПараметрыСценария', recordKey: 'Currency' });
    assert.deepEqual(readScenarioProperties(updated).sections[0].records!.map(record => record.key), ['Rows', 'Count']);
    assert.equal(sourceBody(updated), sourceBody(scenario));
    const absent = scenario.replace('ТегиСценария: [] # tags\n', '');
    assert.equal(readScenarioProperties(addScenarioPropertyRecord(absent, { section: 'ТегиСценария' }, { Имя: 'new' })).sections[1].records![0].key, 'new');
});

test('reordering renumbers blocks and row numbers while preserving stable keys and comments', () => {
    const updated = moveScenarioPropertyRecord(scenario, { section: 'ПараметрыСценария', recordKey: 'Rows', beforeRecordKey: 'Currency' });
    assert.deepEqual(readScenarioProperties(updated).sections[0].records!.map(record => record.key), ['Rows', 'Currency']);
    assert.match(updated, /- ПараметрыСценария1:\n        НомерСтроки: "1"/u);
    assert.match(updated, /- ПараметрыСценария2:\n        НомерСтроки: "2"/u);
    assert.match(updated, /# currency/u); assert.match(updated, /# variants/u); assert.match(updated, /Custom: "untouched"/u);
    assert.equal(sourceBody(updated), sourceBody(scenario));
    const nested = moveScenarioPropertyRecord(scenario, { section: 'ВложенныеСценарии', recordKey: 'nested-2', beforeRecordKey: 'nested-1' });
    assert.deepEqual(readScenarioProperties(nested).sections[2].records!.map(record => record.key), ['nested-2', 'nested-1']);
});

test('edits scoped process parameters and uses process reorder and removal invariants', () => {
    let updated = applyScenarioPropertyEdit(processSource(), { section: 'ПараметрыШага', stepUid: 'step-b', recordKey: 'Input', field: 'ШагПроцессаЗначениеПоСсылкеUID', value: 'step-a' });
    updated = addScenarioPropertyRecord(updated, { section: 'ПараметрыШага', stepUid: 'step-b' }, { Имя: 'Other' });
    assert.equal(readScenarioProperties(updated).sections[2].records![1].sections![0].records!.length, 2);
    assert.throws(() => removeScenarioPropertyRecord(updated, { section: 'ШагиПроцесса', recordKey: 'step-a' }), /supplies parameters/u);
    updated = moveScenarioPropertyRecord(updated, { section: 'ШагиПроцесса', recordKey: 'step-b', beforeRecordKey: 'step-a' });
    const steps = readScenarioProperties(updated).sections[2].records!;
    assert.equal(steps[0].key, 'step-b'); assert.equal(field(steps[0].fields, 'ПолныйКод').value, 'Drive.Process.1');
    updated = removeScenarioPropertyRecord(updated, { section: 'ПараметрыШага', stepUid: 'step-b', recordKey: 'Other' });
    assert.equal(readScenarioProperties(updated).sections[2].records![0].sections![0].records!.length, 1);
    assert.throws(() => addScenarioPropertyRecord(updated, { section: 'ШагиПроцесса' }), /picker|existing|action/iu);
});

test('rejects ambiguous, stale, readonly and structurally unsafe changes', () => {
    assert.throws(() => applyScenarioPropertyEdit(scenario, { section: 'ДанныеСценария', field: 'UID', value: 'other' }), /readonly|identity/iu);
    assert.throws(() => applyScenarioPropertyEdit(scenario, { section: 'ПараметрыСценария', recordKey: 'absent', field: 'Значение', value: 'x' }), /stale|missing/iu);
    assert.throws(() => readScenarioProperties(scenario.replace('Имя: "Rows"', 'Имя: "Currency"')), /ambiguous|duplicate/iu);
    assert.throws(() => applyScenarioPropertyEdit(scenario.replace('Custom: "untouched"', 'Custom: "untouched"\n        Значение: "duplicate"'), { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'Значение', value: 'x' }), /duplicate|ambiguous/iu);
    assert.throws(() => addScenarioPropertyRecord(scenario + 'ПараметрыСценария:\n', { section: 'ПараметрыСценария' }, { Имя: 'New' }), /ambiguous/iu);
    assert.throws(() => moveScenarioPropertyRecord(scenario, { section: 'ПараметрыСценария', recordKey: 'Rows', beforeRecordKey: 'absent' }), /stale|missing/iu);
    assert.throws(() => applyScenarioPropertyEdit(scenario, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'ТипПараметра', value: 'unknown' }), /choice|type|invalid/iu);
    assert.throws(() => readScenarioProperties('ТипФайла: "Сценарий"\nДанныеСценария:\n    - invalid\n'), /mapping/iu);
});

test('patches standard metadata maps and creates missing nested fields without normalization', () => {
    const source = '\uFEFFversion: 1\r\nmetadata:\r\n  description: "old" # keep\r\n  unknown: [1, 2]\r\n# trailing\r\n';
    let updated = applyYamlMapField(source, ['metadata', 'description'], 'new: text');
    assert.match(updated, /description: "new: text" # keep/u); assert.match(updated, /unknown: \[1, 2\]/u);
    updated = applyYamlMapField(updated, ['metadata', 'order'], 2);
    updated = applyYamlMapField(updated, ['groups', 'selected'], 'one');
    updated = applyYamlMapField(updated, ['groups', 'selected'], null);
    assert.equal(parseDocument(updated).toJS().groups?.selected, undefined);
    assert.equal(parseDocument(updated).toJS().metadata.order, 2);
    assert.ok(updated.startsWith('\uFEFF')); assert.equal(updated.replace(/\r\n/gu, '').includes('\n'), false);
    assert.throws(() => applyYamlMapField('metadata:\n  order: 1\n  order: 2\n', ['metadata', 'order'], 3), /duplicate|unique|ambiguous/iu);
    assert.throws(() => applyYamlMapField('metadata: [1]\n', ['metadata', 'order'], 3), /mapping/iu);
});

test('metadata supports empty maps, literal descriptions and null deletion', () => {
    let updated = applyYamlMapField('metadata: {} # metadata\nunknown: true\n', ['metadata', 'description'], 'first\nsecond');
    assert.equal(parseDocument(updated).toJS().metadata.description, 'first\nsecond');
    assert.match(updated, /# metadata/u);
    updated = applyYamlMapField(updated, ['metadata', 'description'], null);
    assert.deepEqual(parseDocument(updated).toJS().metadata, {});
    assert.match(updated, /unknown: true/u);
    assert.equal(applyYamlMapField(updated, ['missing', 'field'], null), updated);
    updated = applyYamlMapField('metadata:\n  description: | # description\n    old\n  category: "smoke"\n', ['metadata', 'description'], 'new\nlines\n');
    assert.equal(parseDocument(updated).toJS().metadata.description, 'new\nlines\n');
    assert.match(updated, /category: "smoke"/u);
});

test('missing process parameter sections can be created and invalid nested identities are rejected', () => {
    const original = processSource().replace(/        ПараметрыШага:\n            - ПараметрыШага1:[\s\S]*?(?=        ТипШага:)/gu, '');
    const updated = addScenarioPropertyRecord(original, { section: 'ПараметрыШага', stepUid: 'step-a' }, { Имя: 'New' });
    assert.equal(readScenarioProperties(updated).sections[2].records![0].sections![0].records![0].key, 'New');
    assert.throws(() => addScenarioPropertyRecord(scenario, { section: 'ВложенныеСценарии' }, { UIDВложенныйСценарий: 'nested-new', ИмяСценария: 'invalid\nname' }), /line|identity|invalid/iu);
});

test('changing parameter type to table creates literal compiler rows', () => {
    const updated = applyScenarioPropertyEdit(scenario, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'ТипПараметра', value: 'Таблица' });
    assert.match(updated, /Значение: \| # variants\n            EUR;USD/u);
    assert.equal(sourceBody(updated), sourceBody(scenario));
    const step = applyScenarioPropertyEdit(processSource(), { section: 'ПараметрыШага', stepUid: 'step-a', recordKey: 'Result', field: 'ТипПараметра', value: 'Таблица' });
    assert.match(step, /ЗначениеПроизвольное: \|/u);
});

test('metadata flow maps patch and delete only the selected entry', () => {
    let updated = applyYamlMapField('metadata: {a: "one", b: "two", c: 3} # keep\n', ['metadata', 'b'], 'changed');
    assert.equal(updated, 'metadata: {a: "one", b: "changed", c: 3} # keep\n');
    updated = applyYamlMapField(updated, ['metadata', 'b'], null);
    assert.deepEqual(parseDocument(updated).toJS().metadata, { a: 'one', c: 3 });
    updated = applyYamlMapField(updated, ['metadata', 'c'], null);
    updated = applyYamlMapField(updated, ['metadata', 'a'], null);
    assert.deepEqual(parseDocument(updated).toJS().metadata, {});
    assert.match(updated, /# keep/u);
});

test('settings name and code edit locally while linked and system-function identities remain guarded', () => {
    const source = 'ТипФайла: "НастройкаТеста"\nДанныеТеста:\n    UID: "settings"\n    Имя: "Independent name"\n    Код: "IndependentCode"\n    UIDСценария: "source"\n    СценарийНаименование: "Source name"\nПараметрыТеста:\n';
    let updated = applyScenarioPropertyEdit(source, { section: 'ДанныеТеста', field: 'Имя', value: 'New settings name' });
    updated = applyScenarioPropertyEdit(updated, { section: 'ДанныеТеста', field: 'Код', value: 'NewSettingsCode' });
    const model = readScenarioProperties(updated);
    assert.equal(field(model.header, 'Имя').value, 'New settings name');
    assert.equal(field(model.header, 'Код').value, 'NewSettingsCode');
    assert.equal(field(model.header, 'UIDСценария').value, 'source');
    assert.equal(field(model.header, 'СценарийНаименование').readonly, true);
    assert.equal(field(readScenarioProperties(scenario).header, 'ФункцияСистемы').readonly, true);
    assert.throws(() => applyScenarioPropertyEdit(scenario, { section: 'ДанныеСценария', field: 'ФункцияСистемы', value: 'New function' }), /readonly|identity/iu);
});

test('table values missing in sparse compiler records are inserted as literal blocks', () => {
    const source = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Sparse"\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Rows"\n        ТипПараметра: "Таблица"\nТекстСценария: |\n    And run\n';
    const updated = applyScenarioPropertyEdit(source, { section: 'ПараметрыСценария', recordKey: 'Rows', field: 'Значение', value: '| A |\n| B |' });
    assert.match(updated, /Значение: \|\n            \| A \|\n            \| B \|/u);
    assert.equal(sourceBody(updated), sourceBody(source));
});

test('metadata multiline edits preserve the exact user string including final newline choice', () => {
    const source = 'metadata:\n  description: | # description\n    old\n  category: smoke\n';
    for (const value of ['first\nsecond', 'first\nsecond\n', 'one line']) {
        const updated = applyYamlMapField(source, ['metadata', 'description'], value);
        assert.equal(parseDocument(updated).toJS().metadata.description, value);
        assert.match(updated, /# description/u);
        assert.match(updated, /category: smoke/u);
    }
});

test('structured custom header values display their actual content and remain guarded', () => {
    const source = scenario.replace('    CustomHeader: "kept"\n', '    CustomHeader: "kept"\n    CustomMap:\n        Label: "actual value"\n        Enabled: true\n');
    const model = readScenarioProperties(source);
    assert.deepEqual(JSON.parse(field(model.header, 'CustomMap').value), { Label: 'actual value', Enabled: true });
    assert.equal(field(model.header, 'CustomMap').readonly, true);
    assert.throws(() => applyScenarioPropertyEdit(source, { section: 'ДанныеСценария', field: 'CustomMap', value: 'overwrite' }), /scalar|readonly|identity/iu);
});

test('scenario properties offer optional compiler grouping and report fields without inventing defaults', () => {
    const model = readScenarioProperties(scenario);
    const grouping = field(model.header, 'НеобратимоМеняетДанные');
    assert.equal(grouping.value, '');
    assert.deepEqual(grouping.choices, ['', 'Да', 'Нет']);
    assert.equal(field(model.header, 'Ответственный').value, '');
    assert.equal(applyScenarioPropertyEdit(scenario, { section: 'ДанныеСценария', field: 'НеобратимоМеняетДанные', value: '' }), scenario);
    const updated = applyScenarioPropertyEdit(scenario, { section: 'ДанныеСценария', field: 'НеобратимоМеняетДанные', value: 'Нет' });
    assert.equal(field(readScenarioProperties(updated).header, 'НеобратимоМеняетДанные').value, 'Нет');
    assert.equal(sourceBody(updated), sourceBody(scenario));
    assert.match(applyScenarioPropertyEdit(updated, { section: 'ДанныеСценария', field: 'Ответственный', value: 'Owner' }), /Ответственный: "Owner"/u);
});

test('disabling is offered only for scenario settings and remains unset until an explicit choice', () => {
    const settings = 'ТипФайла: "НастройкаТеста"\nДанныеТеста:\n    UID: "settings"\n    UIDСценария: "source"\n    Имя: "Test"\nПараметрыТеста:\nТегиТеста:\n';
    const disabled = field(readScenarioProperties(settings).header, 'Выключена');
    assert.equal(disabled.value, ''); assert.deepEqual(disabled.choices, ['', 'Да', 'Нет']);
    assert.equal(applyScenarioPropertyEdit(settings, { section: 'ДанныеТеста', field: 'Выключена', value: '' }), settings);
    const updated = applyScenarioPropertyEdit(settings, { section: 'ДанныеТеста', field: 'Выключена', value: 'Да' });
    assert.equal(field(readScenarioProperties(updated).header, 'Выключена').value, 'Да');
    assert.equal(field(readScenarioProperties(applyScenarioPropertyEdit(updated, { section: 'ДанныеТеста', field: 'Выключена', value: '' })).header, 'Выключена').value, '');
    const processSettings = settings.replace('НастройкаТеста', 'НастройкаПроцесса').replace('UIDСценария', 'UIDПроцесса');
    assert.ok(!readScenarioProperties(processSettings).header.some(value => value.key === 'Выключена'));
    assert.throws(() => applyScenarioPropertyEdit(processSettings, { section: 'ДанныеТеста', field: 'Выключена', value: 'Да' }), /Unsupported/iu);
});

test('native parameter type choices preserve existing legacy types without offering them to other records', () => {
    for (const legacy of ['Булево', 'Массив']) {
        const source = scenario.replace('ТипПараметра: "Строка"', `ТипПараметра: "${legacy}"`);
        const model = readScenarioProperties(source);
        const type = field(model.sections[0].records![0].fields, 'ТипПараметра');
        assert.equal(type.value, legacy);
        assert.deepEqual(type.choices, ['Строка', 'Число', 'Дата', 'Таблица']);
        assert.equal(applyScenarioPropertyEdit(source, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'ТипПараметра', value: legacy }), source);
        const changed = applyScenarioPropertyEdit(source, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'Значение', value: 'saved' });
        assert.equal(field(readScenarioProperties(changed).sections[0].records![0].fields, 'ТипПараметра').value, legacy);
        assert.throws(() => applyScenarioPropertyEdit(scenario, { section: 'ПараметрыСценария', recordKey: 'Currency', field: 'ТипПараметра', value: legacy }), /choice/iu);
    }
});


test('native metadata usage counts come from the paired script without a synthetic editable body', () => {
    const meta = scenario.slice(0, scenario.indexOf('ТекстСценария:'));
    const model = readScenarioProperties(meta, 'And Create order\nAnd I use "[Currency]"\nAnd I use "[Currency]"\n');
    assert.equal(model.sections.find(section => section.key === 'ПараметрыСценария')!.records!.find(record => record.key === 'Currency')!.usages, 2);
    assert.equal(model.sections.find(section => section.key === 'ВложенныеСценарии')!.records![0].usages, 1);
});
