import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';
import {
    findScenarioHeaderFieldLines,
    findProcessHeaderFieldLines,
    findTestSettingsFieldLines,
    parseYamlSectionFieldValues
} from '../src/yamlHeaderFields';

function textDocument(source: string): vscode.TextDocument {
    const lines = source.split(/\r?\n/);
    return {
        lineCount: lines.length,
        lineAt: (line: number) => ({ text: lines[line] }),
        getText: () => source
    } as vscode.TextDocument;
}

test('YAML header fields resolve direct map entries and ignore comments and nested keys', () => {
    const source = [
        '\uFEFFТипФайла: Сценарий',
        'ДанныеСценария:',
        '  # Имя: "Комментарий"',
        '  ВложенныеДанные:',
        '    Имя: "Не то поле"',
        '  Имя: "Оплата: этап #1" # комментарий',
        '  Код: 000015110',
        '  ФункцияСистемы: Продажи',
        '  UIDФункцияСистемы: uid-1',
        'ДругаяСекция:',
        '  Код: неверный',
        'KOTМетаданные:',
        '  Описание: "Описание: #1"',
        ''
    ].join('\n');

    assert.deepEqual(findScenarioHeaderFieldLines(textDocument(source)), {
        fileTypeLine: 0,
        nameLine: 5,
        codeLine: 6,
        systemFunctionLine: 7,
        systemFunctionUidLine: 8,
        kotDescriptionLine: 12
    });
});

test('process header fields resolve process identity without scenario-only actions', () => {
    const source = [
        'ТипФайла: "Процесс"',
        'ДанныеСценария:',
        '  Имя: "Не сценарий"',
        'ДанныеПроцесса:',
        '  # Имя: "Комментарий"',
        '  ДополнительныеДанные:',
        '    Имя: "Не процесс"',
        '  Имя: "Продажи: этап #1"',
        '  Код: 001',
        '  ФункцияСистемы: Продажи',
        '  UIDФункцияСистемы: uid-function',
        'KOTМетаданные:',
        '  Описание: "Описание процесса"'
    ].join('\r\n');

    assert.deepEqual(findProcessHeaderFieldLines(textDocument(source)), {
        fileTypeLine: 0,
        nameLine: 7,
        codeLine: 8,
        systemFunctionLine: null,
        systemFunctionUidLine: null,
        kotDescriptionLine: null
    });
});

test('process run settings expose linked process identity and existing base and user fields', () => {
    const source = [
        'ТипФайла: "НастройкаПроцесса"',
        'ДанныеТеста:',
        '  Код: PROCESS-1',
        '  Имя: "Продажи"',
        '  UIDПроцесса: process-uid',
        '  ПроцессНаименование: Процесс',
        '  UIDСценария: wrong-uid',
        '  СценарийНаименование: Не сценарий',
        '  ЭталоннаяБазаИмя: Эталон',
        '  ПрофильПользователя: Администратор',
        '  ИдентификаторБазы: base-id'
    ].join('\n');

    assert.deepEqual(findTestSettingsFieldLines(textDocument(source)), {
        codeLine: 2,
        nameLine: 3,
        scenarioUidLine: 4,
        scenarioNameLine: 5,
        etalonBaseNameLine: 8,
        userProfileLine: 9,
        modelDbIdLine: 10
    });
});

test('YAML header fields keep exact lines in CRLF run settings', () => {
    const source = [
        'ДанныеТеста:',
        '  Код: TEST-1',
        '  Имя: "Проверка: #1"',
        '  UIDСценария: uid',
        '  СценарийНаименование: Сценарий',
        '  ЭталоннаяБазаИмя: Эталон',
        '  ПрофильПользователя: Администратор',
        '  ИдентификаторБазы: base-id',
        'СледующаяСекция:',
        '  Имя: Не тест',
        ''
    ].join('\r\n');

    assert.deepEqual(findTestSettingsFieldLines(textDocument(source)), {
        codeLine: 1,
        nameLine: 2,
        scenarioUidLine: 3,
        scenarioNameLine: 4,
        etalonBaseNameLine: 5,
        userProfileLine: 6,
        modelDbIdLine: 7
    });
});

test('YAML header value parsing decodes quotes but preserves plain scalar spelling', () => {
    const source = [
        'ДанныеСценария:',
        '  Имя: "Оплата: этап #1" # комментарий',
        '  Код: 000015110',
        "  Проект: 'Drive # retail'",
        '  UID: value\\with\\slashes',
        ''
    ].join('\n');

    assert.deepEqual(
        parseYamlSectionFieldValues(source, 'ДанныеСценария', ['Имя', 'Код', 'Проект', 'UID', 'НетПоля']),
        {
            Имя: 'Оплата: этап #1',
            Код: '000015110',
            Проект: 'Drive # retail',
            UID: 'value\\with\\slashes',
            НетПоля: ''
        }
    );
});
