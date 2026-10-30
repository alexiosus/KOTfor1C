import assert from 'node:assert/strict';
import test from 'node:test';
import { fillMissingCompilerProcessDefaults } from '../src/compilerProcessDefaults';
import { parseScenarioParameterDefinitions } from '../src/scenarioParameterUtils';

const source = `ТипФайла: "Процесс"
ДанныеПроцесса:
    UID: "process-1"
    Имя: "Process"
ПараметрыСценария:
    - ПараметрыСценария1:
        Имя: "Currency"
        Значение: "EUR;GBP"
        ТипПараметра: "Строка"
    - ПараметрыСценария2:
        Имя: "Rows"
        Значение: |
            | Key | Value |
            | A   | 1     |
        ТипПараметра: "Таблица"
    - ПараметрыСценария3:
        Имя: "Literal"
        Значение: 'line\\nBob''s'
        ТипПараметра: "Строка"
ШагиПроцесса:
`;
const settings = `ТипФайла: "НастройкаПроцесса"
ДанныеТеста:
    UID: "settings-1"
    UIDПроцесса: "PROCESS-1"
    Имя: "Process"
ПараметрыТеста:
    - ПараметрыТеста8:
        Имя: "currency"
        Значение: ""
        ТипПараметра: "Строка"
ТегиТеста:
`;

test('explicit process defaults preserve blank overrides, table rows, compiler escapes and unrelated sections', () => {
    const result = fillMissingCompilerProcessDefaults(source, settings);
    assert.deepEqual(result.added, ['Rows', 'Literal']);
    const values = parseScenarioParameterDefinitions(result.text, 'ПараметрыТеста');
    assert.equal(values.get('currency')!.value, '');
    assert.equal(values.get('Rows')!.value, '| Key | Value |\n| A   | 1     |\n');
    assert.equal(values.get('Rows')!.type, 'table');
    assert.equal(values.get('Literal')!.value, "line\\nBob''s");
    assert.match(result.text, /Значение: \|\n {12}\| Key \| Value \|/u);
    assert.match(result.text, /ПараметрыТеста9:/u); assert.match(result.text, /ПараметрыТеста10:/u);
    assert.equal(result.text.slice(result.text.indexOf('ТегиТеста:')), 'ТегиТеста:\n');
    assert.deepEqual(fillMissingCompilerProcessDefaults(source, result.text), { text: result.text, added: [] });
    const crlf = fillMissingCompilerProcessDefaults(source.replace(/\n/gu, '\r\n'), settings.replace(/\n/gu, '\r\n'));
    assert.equal(crlf.text.replace(/\r\n/gu, '\n'), result.text);
});

test('process default fill refuses a different owner and ambiguous source identities or parameter names', () => {
    assert.throws(() => fillMissingCompilerProcessDefaults(source, settings.replace('PROCESS-1', 'foreign')), /linked/u);
    assert.throws(() => fillMissingCompilerProcessDefaults(source, settings.replace('НастройкаПроцесса', 'НастройкаТеста')), /linked/u);
    assert.throws(() => fillMissingCompilerProcessDefaults(source.replace('UID: "process-1"', 'UID: "process-1"\n    UID: "other"'), settings), /duplicate/u);
    assert.throws(() => fillMissingCompilerProcessDefaults(source.replace('Имя: "Rows"', 'Имя: "Currency"'), settings), /duplicate/u);
});
