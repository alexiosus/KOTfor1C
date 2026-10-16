import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildTestInfoFromScenarioDescriptor,
    parseScenarioDescriptor,
    parseTestInfoFromScenarioSource,
    parseTestSettingsTarget
} from '../src/scenarioDescriptor';
import type { TestInfo } from '../src/types';

test('settings establish main scenario identity only through a valid unambiguous compiler UID link', () => {
    assert.deepEqual(parseTestSettingsTarget('\uFEFFТипФайла: "НастройкаТеста"\nДанныеТеста:\n  UIDСценария: " MAIN "\n  Выключена: "Да"\n'), { kind: 'scenario', uid: 'main' });
    assert.deepEqual(parseTestSettingsTarget('ТипФайла: НастройкаПроцесса\nДанныеТеста:\n  UIDПроцесса: process\n'), { kind: 'process', uid: 'process' });
    for (const source of [
        'ТипФайла: Сценарий\nДанныеСценария:\n  UID: main\n',
        'ТипФайла: НастройкаТеста\nДанныеТеста:\n  Имя: Main\n',
        'ТипФайла: НастройкаТеста\nДанныеТеста:\n  UIDПроцесса: main\n',
        'ТипФайла: НастройкаТеста\nДанныеТеста:\n  UIDСценария: main\n  UIDСценария: other\n',
        'ТипФайла: НастройкаТеста\nДанныеТеста: ['
    ]) { assert.equal(parseTestSettingsTarget(source), undefined); }
});

const source = [
    '\uFEFFТипФайла: "Сценарий"',
    'ДругаяСекция:',
    '    Имя: "Wrong name"',
    'ДанныеСценария:',
    '    Имя: "Main: #1"',
    '    UID: "uid-main"',
    '    Код: "000000001"',
    'KOTМетаданные:',
    '    Описание: |',
    '        Description',
    '    PhaseSwitcher:',
    '        Tab: "Smoke"',
    '        Default: true',
    '        OrderOnTab: 10',
    'ПараметрыСценария:',
    '    - ПараметрыСценария1:',
    '        Имя: "Customer"',
    '        Значение: "Default: #1"',
    'ВложенныеСценарии:',
    '    - ВложенныеСценарии1:',
    '        ИмяСценария: "Nested one"',
    '    - ВложенныеСценарии2:',
    '        ИмяСценария: "Nested one"',
    'ТекстСценария: |',
    '    Given something',
    ''
].join('\r\n');

test('scenario descriptor reads one structural scenario definition with exact code coordinates', () => {
    const descriptor = parseScenarioDescriptor(source);

    assert.deepEqual(descriptor, {
        name: 'Main: #1',
        uid: 'uid-main',
        scenarioCode: '000000001',
        scenarioCodeLine: 6,
        scenarioCodeLineStartCharacter: 4,
        scenarioCodeLineEndCharacter: 20,
        parameters: ['Customer'],
        parameterDefaults: { Customer: '"Default: #1"' },
        nestedScenarioNames: ['Nested one'],
        scenarioDescription: 'Description',
        phaseSwitcher: {
            hasTab: true,
            tabName: 'Smoke',
            order: 10
        }
    });
});

const processSource = [
    'ТипФайла: "Процесс"',
    'ДанныеПроцесса:',
    '    Имя: "Sales cycle"',
    '    UID: "process-sales"',
    '    Код: "001"',
    '    ПолныйКод: "Sales.001"',
    'KOTМетаданные:',
    '    Описание: |',
    '        Process description',
    'ШагиПроцесса:',
    '    - ШагиПроцесса1:',
    '        UID: "step-order"',
    '        Наименование: "Create order"',
    '        СценарийНаименование: "Order"',
    '        СценарийUID: "scenario-order"',
    '        СценарийКод: "101"',
    '        ТипШага: "0"',
    '    - ШагиПроцесса2:',
    '        UID: "step-delivery"',
    '        Наименование: "Deliver"',
    '        ВложенныйПроцессНаименование: "Delivery"',
    '        ВложенныйПроцессUID: "process-delivery"',
    '        ТипШага: "1"',
    'ПараметрыСценария:',
    '    - ПараметрыСценария1:',
    '        Имя: "Customer"',
    '        Значение: "Example"',
    ''
].join('\r\n');

test('process descriptors expose compiler identity, ordered step references and catalog dependencies', () => {
    const info = parseTestInfoFromScenarioSource(
        processSource,
        { toString: () => 'file:///process/process.yaml' } as TestInfo['yamlFileUri'],
        'Process'
    );
    assert.ok(info);
    assert.equal(info.kind, 'process');
    assert.equal(info.name, 'Sales cycle');
    assert.equal(info.uid, 'process-sales');
    assert.equal(info.scenarioCode, '001');
    assert.equal(info.processCode, 'Sales.001');
    assert.equal(info.scenarioCodeLine, 4);
    assert.equal(info.tabName, undefined);
    assert.equal(info.order, undefined);
    assert.deepEqual(info.parameters, ['Customer']);
    assert.deepEqual(info.nestedScenarioNames, ['Order', 'Delivery']);
    assert.deepEqual(info.processSteps, [
        { uid: 'step-order', name: 'Create order', type: 'scenario', scenarioName: 'Order', scenarioUid: 'scenario-order', scenarioCode: '101' },
        { uid: 'step-delivery', name: 'Deliver', type: 'process', processName: 'Delivery', processUid: 'process-delivery' }
    ]);
});

test('process descriptors keep an explicit group and reject settings files as definitions', () => {
    const uri = { toString: () => 'file:///process/process.yaml' } as TestInfo['yamlFileUri'];
    const info = parseTestInfoFromScenarioSource(processSource.replace(
        '    Описание: |',
        '    PhaseSwitcher:\r\n        Tab: "Smoke"\r\n        OrderOnTab: "7"\r\n    Описание: |'
    ), uri, 'Process');
    assert.equal(info?.tabName, 'Smoke');
    assert.equal(info?.order, 7);
    assert.equal(parseTestInfoFromScenarioSource([
        'ТипФайла: "НастройкаПроцесса"',
        'ДанныеТеста:',
        '    Имя: "Settings"',
        '    UIDПроцесса: "process-sales"'
    ].join('\n'), uri, 'Process/test'), null);
});

test('test info adapter rejects unnamed descriptors and copies mutable metadata', () => {
    const descriptor = parseScenarioDescriptor(source);
    const uri = { toString: () => 'file:///scenario/scen.yaml' } as TestInfo['yamlFileUri'];
    const info = buildTestInfoFromScenarioDescriptor(descriptor, uri, 'Scenario');

    assert.ok(info);
    assert.equal(info.name, 'Main: #1');
    assert.equal(info.yamlFileUri, uri);
    assert.equal(info.relativePath, 'Scenario');
    assert.equal(Object.hasOwn(info, 'defaultState'), false);

    info.parameters?.push('Changed');
    if (info.parameterDefaults) {
        info.parameterDefaults.Customer = '"Changed"';
    }
    assert.deepEqual(descriptor.parameters, ['Customer']);
    assert.deepEqual(descriptor.parameterDefaults, { Customer: '"Default: #1"' });

    const unnamed = parseScenarioDescriptor('ДанныеСценария:\n    UID: "uid-only"\n');
    assert.equal(buildTestInfoFromScenarioDescriptor(unnamed, uri, 'Scenario'), null);
});

test('source adapter cannot borrow scenario identity from an unrelated section', () => {
    const uri = { toString: () => 'file:///scenario/scen.yaml' } as TestInfo['yamlFileUri'];
    const info = parseTestInfoFromScenarioSource(source, uri, 'Scenario');

    assert.ok(info);
    assert.equal(info.name, 'Main: #1');
    assert.equal(info.uid, 'uid-main');
    assert.equal(info.scenarioCode, '000000001');
    assert.deepEqual(info.nestedScenarioNames, ['Nested one']);
});

test('scenario category is independent from the PhaseSwitcher tab', () => {
    const descriptor = parseScenarioDescriptor([
        'ДанныеСценария:',
        '    Имя: Создать заказ',
        'KOTМетаданные:',
        '    Категория: "Продажи.Заказы"',
        '    PhaseSwitcher:',
        '        Tab: "Регресс"'
    ].join('\n'));
    const uri = { toString: () => 'file:///scenario/scen.yaml' } as TestInfo['yamlFileUri'];
    const info = buildTestInfoFromScenarioDescriptor(descriptor, uri, 'Scenario');

    assert.equal(descriptor.scenarioCategory, 'Продажи.Заказы');
    assert.equal(descriptor.phaseSwitcher.tabName, 'Регресс');
    assert.equal(info?.scenarioCategory, 'Продажи.Заказы');
    assert.equal(info?.tabName, 'Регресс');
});

test('scenario category remains structural after a legacy free-form description', () => {
    const descriptor = parseScenarioDescriptor([
        'ДанныеСценария:',
        '    Имя: Установить расширение',
        'KOTМетаданные:',
        '    Описание: |',
        '        Installs an extension from .cfe.',
        '    -',
        '    Категория: "Tests Environment"',
        'ПараметрыСценария:',
        ''
    ].join('\n'));

    assert.equal(descriptor.scenarioCategory, 'Tests Environment');
});

test('empty scenario category is treated as absent', () => {
    const descriptor = parseScenarioDescriptor([
        'ДанныеСценария:',
        '    Имя: Без категории',
        'KOTМетаданные:',
        '    Категория: "   "'
    ].join('\n'));

    assert.equal(descriptor.scenarioCategory, undefined);
});
