import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from 'yaml';
import * as compilerProcesses from '../src/compilerProcesses';
import {
    appendCompilerProcessScenarioStep,
    buildCompilerProcessFiles,
    moveCompilerProcessStep,
    removeCompilerProcessStep,
    readCompilerProcessScenarioParameters
} from '../src/compilerProcesses';

const scenario = {
    name: 'Create "order": #1', uid: 'scenario-order', scenarioCode: '101',
    parameters: [{ name: 'Amount', value: '10', type: 'Число', outgoing: false }]
};

test('process creation emits all stock compiler fields and connects settings by process UID', () => {
    const files = buildCompilerProcessFiles({
        name: 'Sales', code: '001', fullCode: 'Sales.001', uid: 'process-sales', settingsUid: 'settings-sales',
        project: 'Synthetic', userProfile: 'Tester', databaseId: 'synthetic-db', reportLevel1: 'Sales', reportLevel2: 'Process',
        steps: [{ scenario, uid: 'step-order' }]
    });
    const process = parseDocument(files.processSource).toJS();
    const settings = parseDocument(files.settingsSource).toJS();
    assert.equal(Object.hasOwn(process, 'KOTМетаданные'), false);
    assert.equal(process.ТипФайла, 'Процесс');
    assert.deepEqual(process.ДанныеПроцесса, {
        UID: 'process-sales', Имя: 'Sales', Код: '001', ПолныйКод: 'Sales.001', ВерсияСценария: '1',
        Проект: 'Synthetic', ПрофильПользователя: 'Tester', Ответственный: '', УровеньОтчета1: 'Sales', УровеньОтчета2: 'Process'
    });
    assert.deepEqual(process.ШагиПроцесса[0].ШагиПроцесса1, {
        ШагПроцесса: 'step-order', UID: 'step-order', Процесс: 'process-sales', Наименование: 'Create "order": #1',
        Сценарий: 'scenario-order', СценарийНаименование: 'Create "order": #1', СценарийКод: '101', СценарийUID: 'scenario-order',
        ПолныйКод: 'Sales.001.1', ИсполнительНаименование: 'Tester',
        ПараметрыШага: [{ ПараметрыШага1: {
            Имя: 'Amount', ТипПараметра: 'Число', ШагПроцессаЗначениеПоСсылке: '', ШагПроцессаЗначениеПоСсылкеUID: '',
            ИсходящийПараметр: 'Нет', ЗначениеПоСсылке: '', ЗначениеПроизвольное: '10', ИмяПараметраПоСсылке: ''
        } }],
        ТипШага: '0'
    });
    assert.equal(settings.ТипФайла, 'НастройкаПроцесса');
    assert.deepEqual(settings.ДанныеТеста, {
        UID: 'settings-sales', Код: '001', Имя: 'Sales', UIDПроцесса: 'process-sales', ПроцессНаименование: 'Sales',
        ИдентификаторБазы: 'synthetic-db', ПрофильПользователя: 'Tester', ПараметрыЗапуска: ''
    });
    // The external reader removes the first/last character of scalar values:
    // emitted numbers and flags must therefore remain quoted strings.
    for (const line of `${files.processSource}\n${files.settingsSource}`.split('\n')) {
        if (line.trim() && !/^\s*-|^\s*#/.test(line) && !line.trim().endsWith(':')) {
            assert.match(line, /:\s+"(?:[^"\\]|\\.)*"$/);
        }
    }
});

const editableProcess = [
    'ТипФайла: "Процесс"',
    'ДанныеПроцесса:',
    '    UID: "process-sales"',
    '    Имя: "Sales"',
    '    Код: "001"',
    '    ПолныйКод: "Sales.001"',
    '    ПрофильПользователя: "Tester"',
    'ШагиПроцесса:',
    '    - ШагиПроцесса1:',
    '        UID: "step-existing"',
    '        Наименование: "Existing step"',
    '        СценарийUID: "scenario-existing"',
    '        ТипШага: "0"',
    '        ПараметрыШага:',
    '            - ПараметрыШага1:',
    '                Имя: "Custom"',
    '                ЗначениеПоСсылке: "Общий параметр.Customer"',
    'ТегиПроцесса:',
    '    - ТегиПроцесса1:',
    '        НомерСтроки: "1"',
    '        Имя: "Smoke"',
    ''
].join('\r\n');

test('adding and reordering steps preserves existing bindings, unrelated YAML and CRLF', () => {
    const appended = appendCompilerProcessScenarioStep(editableProcess, scenario, 'step-added');
    const moved = moveCompilerProcessStep(appended, 1, 0);
    const yaml = parseDocument(moved).toJS();
    assert.deepEqual(yaml.ШагиПроцесса.map((item: Record<string, { UID: string }>) => Object.values(item)[0].UID), ['step-added', 'step-existing']);
    assert.equal(yaml.ШагиПроцесса[1].ШагиПроцесса2.ПараметрыШага[0].ПараметрыШага1.ЗначениеПоСсылке, 'Общий параметр.Customer');
    assert.equal(moved.slice(moved.indexOf('ТегиПроцесса:')), editableProcess.slice(editableProcess.indexOf('ТегиПроцесса:')));
    assert.equal(moved.includes('\n') && moved.replace(/\r\n/g, '').includes('\n'), false);
    const removed = removeCompilerProcessStep(moved, 0);
    assert.equal(parseDocument(removed).toJS().ШагиПроцесса.length, 1);
    assert.equal(removed.includes('Общий параметр.Customer'), true);
});

test('process edits reject ambiguous sections and missing scenario UID instead of corrupting YAML', () => {
    assert.throws(() => appendCompilerProcessScenarioStep(editableProcess, { name: 'Unnamed identity', scenarioCode: '1' }, 'new'), /UID/);
    assert.throws(() => moveCompilerProcessStep(editableProcess, 10, 0), /index/i);
    assert.throws(() => removeCompilerProcessStep(`${editableProcess}\r\nШагиПроцесса:\r\n`, 0), /ambiguous|duplicate/i);
});

test('step parameter definitions retain compiler types, literal defaults and outgoing flags', () => {
    assert.deepEqual(readCompilerProcessScenarioParameters([
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: "Amount"',
        '        Значение: "10"',
        '        ТипПараметра: "Число"',
        '        ИсходящийПараметр: "Нет"',
        '    - ПараметрыСценария2:',
        '        Имя: "Result"',
        '        Значение: ""',
        '        ТипПараметра: "Строка"',
        '        ИсходящийПараметр: "Да"'
    ].join('\n')), [
        { name: 'Amount', value: '10', type: 'Число', outgoing: false },
        { name: 'Result', value: '', type: 'Строка', outgoing: true }
    ]);
});

test('moving a final step without an EOF newline keeps record boundaries valid', () => {
    const source = editableProcess.slice(0, editableProcess.indexOf('ТегиПроцесса:')).trimEnd();
    const appended = appendCompilerProcessScenarioStep(source, scenario, 'step-added');
    const moved = moveCompilerProcessStep(appended, 1, 0);
    const document = parseDocument(moved);
    assert.deepEqual(document.errors, []);
    assert.deepEqual(document.toJS().ШагиПроцесса.map((item: Record<string, { UID: string }>) => Object.values(item)[0].UID), ['step-added', 'step-existing']);
});


test('nested process records survive parameter-preserving reorder and removal', () => {
    const original = `ДанныеПроцесса:
    UID: "parent"
    Код: "P"
ШагиПроцесса:
`.replace(/\n/g, '\r\n');
    const withScenario = appendCompilerProcessScenarioStep(original, { name: 'Scenario', uid: 'scenario', scenarioCode: 'S', parameters: [{ name: 'Value', value: 'keep', type: 'Строка', outgoing: false }] }, 'scenario-step');
    const mixed = appendCompilerProcessScenarioStep(withScenario, { kind: 'process', name: 'Nested', uid: 'nested' }, 'process-step');
    const reordered = moveCompilerProcessStep(mixed, 1, 0);
    const records = parseDocument(reordered).toJS().ШагиПроцесса;
    assert.equal(records[0].ШагиПроцесса1.ТипШага, '1');
    assert.equal(records[0].ШагиПроцесса1.ВложенныйПроцессUID, 'nested');
    assert.equal('Сценарий' in records[0].ШагиПроцесса1, false);
    assert.equal('СценарийНаименование' in records[0].ШагиПроцесса1, false);
    assert.equal('СценарийКод' in records[0].ШагиПроцесса1, false);
    assert.equal('СценарийUID' in records[0].ШагиПроцесса1, false);
    assert.equal(records[1].ШагиПроцесса2.ПараметрыШага[0].ПараметрыШага1.ЗначениеПроизвольное, 'keep');
    assert.equal(reordered.replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(parseDocument(removeCompilerProcessStep(reordered, 0)).toJS().ШагиПроцесса.length, 1);
    assert.throws(() => appendCompilerProcessScenarioStep(original, { kind: 'process', name: 'Parent', uid: 'PARENT' }, 'self-step'), /itself/u);
});

const numberedProcess = [
    'ДанныеПроцесса:',
    '    UID: "parent"',
    '    ПолныйКод: "Sales.001"',
    'ШагиПроцесса:',
    '    - ШагиПроцесса1: # first record',
    '        UID: "first"',
    '        ПолныйКод: "Sales.001.1"',
    '        ТипШага: "0"',
    '        ПараметрыШага:',
    '            - ПараметрыШага1:',
    '                ШагПроцессаЗначениеПоСсылкеUID: "second"',
    '                ЗначениеПроизвольное: |',
    '                    - ШагиПроцесса99:',
    '                        ПолныйКод: "leave this literal alone"',
    '    - ШагиПроцесса2:',
    '        UID: "second"',
    '        ПолныйКод: "Sales.001.2"',
    '        ТипШага: "1"',
    '        ВложенныйПроцессUID: "nested"',
    '    - ШагиПроцесса3:',
    '        UID: "third"',
    '        ПолныйКод: "Sales.001.3"',
    'ТегиПроцесса:',
    '    - ТегиПроцесса1:',
    '        Имя: "keep tags"',
    ''
].join('\r\n');

test('moving process steps updates block numbers and full codes while keeping UID references and literals', () => {
    const moved = moveCompilerProcessStep(numberedProcess, 2, 0);
    const yaml = parseDocument(moved).toJS();
    assert.deepEqual(yaml.ШагиПроцесса.map((record: object) => Object.keys(record)[0]), ['ШагиПроцесса1', 'ШагиПроцесса2', 'ШагиПроцесса3']);
    const steps = yaml.ШагиПроцесса.map((record: object) => Object.values(record)[0]);
    assert.deepEqual(steps.map((step: { UID: string }) => step.UID), ['third', 'first', 'second']);
    assert.deepEqual(steps.map((step: { ПолныйКод: string }) => step.ПолныйКод), ['Sales.001.1', 'Sales.001.2', 'Sales.001.3']);
    assert.equal(steps[1].ПараметрыШага[0].ПараметрыШага1.ШагПроцессаЗначениеПоСсылкеUID, 'second');
    assert.equal(steps[1].ПараметрыШага[0].ПараметрыШага1.ЗначениеПроизвольное, '- ШагиПроцесса99:\n    ПолныйКод: "leave this literal alone"\n');
    assert.equal(steps[2].ВложенныйПроцессUID, 'nested');
    assert.ok(moved.includes('# first record'));
    assert.equal(moved.slice(moved.indexOf('ТегиПроцесса:')), numberedProcess.slice(numberedProcess.indexOf('ТегиПроцесса:')));
    assert.equal(moved.replace(/\r\n/g, '').includes('\n'), false);
    const restored = parseDocument(moveCompilerProcessStep(moved, 0, 2)).toJS();
    assert.deepEqual(restored.ШагиПроцесса, parseDocument(numberedProcess).toJS().ШагиПроцесса);
});

test('removing then appending a process step keeps numbering contiguous instead of reusing a previous block key', () => {
    const removed = removeCompilerProcessStep(numberedProcess, 0);
    const remaining = parseDocument(removed).toJS().ШагиПроцесса;
    assert.deepEqual(remaining.map((record: object) => Object.keys(record)[0]), ['ШагиПроцесса1', 'ШагиПроцесса2']);
    assert.equal(remaining[1].ШагиПроцесса2.UID, 'third');
    assert.equal(remaining[1].ШагиПроцесса2.ПолныйКод, 'Sales.001.2');
    const appended = appendCompilerProcessScenarioStep(removed, scenario, 'added');
    const records = parseDocument(appended).toJS().ШагиПроцесса;
    assert.deepEqual(records.map((record: object) => Object.keys(record)[0]), ['ШагиПроцесса1', 'ШагиПроцесса2', 'ШагиПроцесса3']);
    assert.equal(records[2].ШагиПроцесса3.UID, 'added');
    assert.equal(records[2].ШагиПроцесса3.ПолныйКод, 'Sales.001.3');
});

test('shared process removal rejects a step used by another step parameter', () => {
    assert.throws(() => removeCompilerProcessStep(numberedProcess, 1), /supplies parameters/iu);
});

test('process mutations reject multiline quoted full codes before partial replacement', () => {
    const source = numberedProcess.replace('ПолныйКод: "Sales.001.1"', 'ПолныйКод: "Sales.001.1\r\n            tail"');
    assert.equal(parseDocument(source).errors.length, 0);
    assert.throws(() => moveCompilerProcessStep(source, 0, 2), /scalar|full code/iu);
    assert.throws(() => removeCompilerProcessStep(source, 2), /scalar|full code/iu);
});

test('process identity edits update only UID-linked references and preserve custom names and settings variants', () => {
    const update = compilerProcesses.updateCompilerProcessIdentity;
    const identity = { uid: 'child', oldName: 'Child', name: 'Renamed', oldCode: '001', code: '002' };
    const own = 'ДанныеПроцесса:\n    UID: "child"\n    Имя: "Child"\n    Код: "001"\n    ПолныйКод: "Sales.001"\nШагиПроцесса:\n    - ШагиПроцесса1:\n        UID: "step"\n        ПолныйКод: "Sales.001.1"\n';
    const ownData = parseDocument(update(own, identity)).toJS();
    assert.equal(ownData.ДанныеПроцесса.UID, 'child');
    assert.equal(ownData.ДанныеПроцесса.Имя, 'Renamed');
    assert.equal(ownData.ДанныеПроцесса.Код, '002');
    assert.equal(ownData.ДанныеПроцесса.ПолныйКод, 'Sales.002');
    assert.equal(ownData.ШагиПроцесса[0].ШагиПроцесса1.ПолныйКод, 'Sales.002.1');
    const parent = 'ДанныеПроцесса:\n    UID: "parent"\nШагиПроцесса:\n    - ШагиПроцесса1:\n        UID: "calling"\n        ТипШага: "1"\n        ВложенныйПроцессUID: "CHILD"\n        ВложенныйПроцессНаименование: "Child"\n        Наименование: "Custom step title"\n        ПараметрыШага:\n            - ПараметрыШага1:\n                ЗначениеПроизвольное: "Child"\n    - ШагиПроцесса2:\n        UID: "other-call"\n        ТипШага: "1"\n        ВложенныйПроцессUID: "other"\n        ВложенныйПроцессНаименование: "Child"\n';
    const parentData = parseDocument(update(parent, identity)).toJS();
    assert.equal(parentData.ШагиПроцесса[0].ШагиПроцесса1.ВложенныйПроцессНаименование, 'Renamed');
    assert.equal(parentData.ШагиПроцесса[0].ШагиПроцесса1.Наименование, 'Custom step title');
    assert.equal(parentData.ШагиПроцесса[0].ШагиПроцесса1.ПараметрыШага[0].ПараметрыШага1.ЗначениеПроизвольное, 'Child');
    assert.equal(parentData.ШагиПроцесса[1].ШагиПроцесса2.ВложенныйПроцессНаименование, 'Child');
    const setting = 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n    UIDПроцесса: "child"\n    ПроцессНаименование: "Child"\n    Имя: "Variant"\n    Код: "variant-code"\n';
    assert.deepEqual(parseDocument(update(setting, identity)).toJS().ДанныеТеста, { UIDПроцесса: 'child', ПроцессНаименование: 'Renamed', Имя: 'Variant', Код: 'variant-code' });
    const defaultSetting = setting.replace('"Variant"', '"Child"').replace('"variant-code"', '"001"');
    assert.equal(parseDocument(update(defaultSetting, identity)).toJS().ДанныеТеста.Имя, 'Renamed');
    assert.equal(parseDocument(update(defaultSetting, identity)).toJS().ДанныеТеста.Код, '002');
});

test('process identity edits reject incomplete required fields before modifying linked identities', () => {
    const identity = { uid: 'child', oldName: 'Child', name: 'Renamed', oldCode: '001', code: '002' };
    assert.throws(() => compilerProcesses.updateCompilerProcessIdentity('ДанныеПроцесса:\n    UID: "child"\n    Имя: "Child"\n    ПолныйКод: "Sales.001"\n', identity), /Код/u);
    assert.throws(() => compilerProcesses.updateCompilerProcessIdentity('ДанныеПроцесса:\n    UID: "child"\n    Имя: "Child"\n    Код: ""\n    ПолныйКод: "Sales.001"\n', identity), /Код/u);
    assert.throws(() => compilerProcesses.updateCompilerProcessIdentity('ДанныеТеста:\n    UIDПроцесса: "child"\n    Имя: "Child"\n', identity), /ПроцессНаименование/u);
});
