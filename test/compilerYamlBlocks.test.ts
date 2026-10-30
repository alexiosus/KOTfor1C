import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from 'yaml';
import * as blocks from '../src/compilerYamlBlocks';

const processSource = 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "parent"\nПараметрыСценария:\nШагиПроцесса:\n    - ШагиПроцесса1:\n        UID: "first"\n        ПараметрыШага:\n        ТипШага: "0"\n    - ШагиПроцесса2:\n        UID: "second"\n        ПараметрыШага:\n        ТипШага: "1"\nТегиПроцесса:\n';

test('block actions target top-level sections and each exact process step', () => {
    const actions = blocks.buildCompilerYamlBlockActions(processSource);
    assert.deepEqual(actions.map(action => [action.section, action.stepUid]), [
        ['ПараметрыСценария', undefined], ['ТегиПроцесса', undefined], ['ПараметрыШага', 'first'], ['ПараметрыШага', 'second']
    ]);
    assert.deepEqual(actions.map(action => action.line), [3, 13, 7, 11]);
});

test('adding a parameter to a nested step preserves the other step and CRLF', () => {
    const source = processSource.replace(/\n/g, '\r\n');
    const updated = blocks.appendCompilerYamlBlock(source, { section: 'ПараметрыШага', stepUid: 'second' }, 'Currency');
    const data = parseDocument(updated).toJS();
    assert.equal(data.ШагиПроцесса[0].ШагиПроцесса1.ПараметрыШага, null);
    assert.deepEqual(data.ШагиПроцесса[1].ШагиПроцесса2.ПараметрыШага[0].ПараметрыШага1, {
        Имя: 'Currency', ТипПараметра: 'Строка', ШагПроцессаЗначениеПоСсылке: '', ШагПроцессаЗначениеПоСсылкеUID: '',
        ИсходящийПараметр: 'Нет', ЗначениеПоСсылке: '', ЗначениеПроизвольное: '', ИмяПараметраПоСсылке: ''
    });
    assert.equal(updated.replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(updated.slice(updated.indexOf('ТегиПроцесса:')), source.slice(source.indexOf('ТегиПроцесса:')));
});

test('settings records avoid existing key and row numbers, retaining literals and unrelated sections', () => {
    const source = 'ТипФайла: "НастройкаТеста"\nПараметрыТеста:\n    - ПараметрыТеста7:\n        НомерСтроки: "9"\n        Имя: "Rows"\n        Значение: |\n            | Currency |\n            | EUR |\n        ТипПараметра: "Таблица"\nТегиТеста: [] # keep comment\n';
    const updated = blocks.appendCompilerYamlBlock(source, { section: 'ПараметрыТеста' }, 'Amount');
    const data = parseDocument(updated).toJS();
    assert.equal(data.ПараметрыТеста[1].ПараметрыТеста10.Имя, 'Amount');
    assert.equal(data.ПараметрыТеста[1].ПараметрыТеста10.НомерСтроки, '10');
    assert.ok(updated.includes('| Currency |\n            | EUR |'));
    const tagged = blocks.appendCompilerYamlBlock(updated, { section: 'ТегиТеста' }, 'Smoke');
    assert.equal(parseDocument(tagged).toJS().ТегиТеста[0].ТегиТеста1.Имя, 'Smoke');
    assert.ok(tagged.includes('# keep comment'));
});

test('block mutations reject duplicate names, ambiguous step identities and sections of the wrong file type', () => {
    const once = blocks.appendCompilerYamlBlock(processSource, { section: 'ПараметрыСценария' }, 'Currency');
    assert.throws(() => blocks.appendCompilerYamlBlock(once, { section: 'ПараметрыСценария' }, 'currency'), /already|duplicate/iu);
    assert.throws(() => blocks.appendCompilerYamlBlock(processSource.replace('UID: "second"', 'UID: "first"'), { section: 'ПараметрыШага', stepUid: 'first' }, 'Currency'), /ambiguous/iu);
    assert.throws(() => blocks.appendCompilerYamlBlock(processSource, { section: 'ПараметрыТеста' }, 'Currency'), /section/iu);
});

test('unsupported process record keys cannot redirect a step parameter insertion', () => {
    for (const key of ['123', 'true', '""']) {
        const source = processSource.replace('ШагиПроцесса1:', `${key}:`);
        assert.deepEqual(blocks.buildCompilerYamlBlockActions(source), []);
        assert.throws(() => blocks.appendCompilerYamlBlock(source, { section: 'ПараметрыШага', stepUid: 'second' }, 'Currency'), /invalid record/iu);
    }
});

test('section buttons ignore fake headers inside scenario text and duplicated top-level sections', () => {
    const source = 'ТипФайла: "Сценарий"\nПараметрыСценария:\nТекстСценария: |\n    ПараметрыТеста:\n    ТегиТеста:\nТегиСценария:\n';
    assert.deepEqual(blocks.buildCompilerYamlBlockActions(source).map(action => action.section), ['ПараметрыСценария', 'ТегиСценария']);
    assert.deepEqual(blocks.buildCompilerYamlBlockActions(source + 'ПараметрыСценария:\n'), []);
});
