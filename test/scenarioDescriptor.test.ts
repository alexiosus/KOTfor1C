import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildTestInfoFromScenarioDescriptor,
    parseScenarioDescriptor,
    parseTestInfoFromScenarioSource
} from '../src/scenarioDescriptor';
import type { TestInfo } from '../src/types';

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
            defaultState: true,
            order: 10
        }
    });
});

test('test info adapter rejects unnamed descriptors and copies mutable metadata', () => {
    const descriptor = parseScenarioDescriptor(source);
    const uri = { toString: () => 'file:///scenario/scen.yaml' } as TestInfo['yamlFileUri'];
    const info = buildTestInfoFromScenarioDescriptor(descriptor, uri, 'Scenario');

    assert.ok(info);
    assert.equal(info.name, 'Main: #1');
    assert.equal(info.yamlFileUri, uri);
    assert.equal(info.relativePath, 'Scenario');

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
