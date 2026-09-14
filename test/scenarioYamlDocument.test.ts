import assert from 'node:assert/strict';
import test from 'node:test';
import { ScenarioYamlDocument } from '../src/scenarioYamlDocument';

test('ScenarioYamlDocument reads quoted scalars without confusing YAML punctuation', () => {
    const source = [
        'ДанныеСценария:',
        '  # Имя: "Комментарий не является полем"',
        '  Имя: "Оплата: этап #1" # настоящий комментарий',
        '  Код: DRIVE-1',
        '  Номер: 000015110',
        'ДругаяСекция:',
        '  Имя: Неверное имя',
        ''
    ].join('\n');

    const document = ScenarioYamlDocument.parse(source);
    const field = document.findField('ДанныеСценария', 'Имя');

    assert.deepEqual(document.errors, []);
    assert.equal(document.readScalar('ДанныеСценария', 'Имя'), 'Оплата: этап #1');
    assert.equal(document.readScalar('ДанныеСценария', 'Номер'), '000015110');
    assert.ok(field);
    assert.equal(source.slice(field.valueRange!.start, field.valueRange!.end), '"Оплата: этап #1"');
    assert.equal(source.slice(field.lineStart, field.lineEnd), '  Имя: "Оплата: этап #1" # настоящий комментарий');
    assert.equal(document.findField('ДанныеСценария', 'Несуществующее'), null);
});

test('ScenarioYamlDocument keeps BOM and CRLF offsets around a block scalar', () => {
    const source = '\uFEFFДанныеСценария:\r\n'
        + '  Имя: "Сценарий"\r\n'
        + 'ТекстСценария: |\r\n'
        + '  Допустим текст с : и #\r\n'
        + 'ПараметрыСценария:\r\n'
        + '  - ПараметрыСценария1:\r\n'
        + '      Имя: Код\r\n';

    const document = ScenarioYamlDocument.parse(source);
    const header = document.findSection('ДанныеСценария');
    const script = document.findSection('ТекстСценария');
    const parameters = document.findSection('ПараметрыСценария');

    assert.deepEqual(document.errors, []);
    assert.ok(header);
    assert.ok(script);
    assert.ok(parameters);
    assert.equal(header.pairRange.start, 1);
    assert.equal(source.slice(script.valueRange!.start, script.valueRange!.end), '|\r\n  Допустим текст с : и #\r\n');
    assert.equal(source.slice(parameters.bodyRange.start, parameters.bodyRange.end), '  - ПараметрыСценария1:\r\n      Имя: Код\r\n');
    assert.equal(parameters.keyIndent, '');
    assert.equal(parameters.itemIndent, '  ');
});

test('ScenarioYamlDocument reads sequence records as decoded field maps', () => {
    const source = [
        'ПараметрыСценария:',
        '  - ПараметрыСценария1:',
        '      Имя: "Артикул"',
        '      Значение: "A: #1"',
        '      НомерСтроки: 000015110',
        '      Описание: "Код # с двоеточием: да"',
        '  - ПараметрыСценария2:',
        '      Имя: Количество',
        ''
    ].join('\n');

    const records = ScenarioYamlDocument.parse(source).readRecords('ПараметрыСценария');

    assert.equal(records.length, 2);
    assert.equal(records[0].key, 'ПараметрыСценария1');
    assert.deepEqual(Object.fromEntries(records[0].fields), {
        Имя: 'Артикул',
        Значение: 'A: #1',
        НомерСтроки: '000015110',
        Описание: 'Код # с двоеточием: да'
    });
    assert.equal(source.slice(records[0].range.start, records[0].range.end), [
        'ПараметрыСценария1:',
        '      Имя: "Артикул"',
        '      Значение: "A: #1"',
        '      НомерСтроки: 000015110',
        '      Описание: "Код # с двоеточием: да"'
    ].join('\n'));
    assert.deepEqual(Object.fromEntries(records[1].fields), { Имя: 'Количество' });
});

test('ScenarioYamlDocument exposes a zero-width body for an empty section', () => {
    const source = 'ВложенныеСценарии:\nСледующаяСекция:\n  Значение: 1\n';
    const section = ScenarioYamlDocument.parse(source).findSection('ВложенныеСценарии');

    assert.ok(section);
    assert.deepEqual(section.bodyRange, {
        start: source.indexOf('СледующаяСекция:'),
        end: source.indexOf('СледующаяСекция:')
    });
    assert.equal(section.itemIndent, '    ');
});

test('ScenarioYamlDocument tolerates legacy scalar payloads but refuses structural errors', () => {
    const legacyScalar = ScenarioYamlDocument.parse([
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: NewAGP',
        '        Значение: "',
        ''
    ].join('\n'));
    assert.deepEqual(legacyScalar.errors, []);
    assert.equal(legacyScalar.readRecords('ПараметрыСценария')[0].fields.get('Значение'), '"');

    const document = ScenarioYamlDocument.parse('ДанныеСценария:\n    Имя: Тест\n  - structural error\n');

    assert.ok(document.errors.length > 0);
    assert.throws(() => document.requireValidForEdit(), /YAML/i);
});

test('ScenarioYamlDocument masks KOT free-form blocks without changing section offsets', () => {
    const source = [
        '\uFEFFТипФайла: "Сценарий"',
        'ДанныеСценария:',
        '    Имя: "Тест"',
        'KOTМетаданные:',
        '    Описание: |',
        '        ',
        '    -',
        'ПараметрыСценария:',
        'ВложенныеСценарии:',
        'ТекстСценария: |',
        '            ',
        '    And I go to line:',
        '        | value |',
        ''
    ].join('\n');

    const document = ScenarioYamlDocument.parse(source);

    assert.deepEqual(document.errors, []);
    assert.equal(document.readScalar('ДанныеСценария', 'Имя'), 'Тест');
    assert.equal(document.findSection('ПараметрыСценария')?.pairRange.start, source.indexOf('ПараметрыСценария:'));
    assert.equal(document.findSection('ВложенныеСценарии')?.pairRange.start, source.indexOf('ВложенныеСценарии:'));
});
