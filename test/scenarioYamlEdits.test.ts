import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getSectionBodyReplacement,
    getSectionInsertion,
    type SourceEdit
} from '../src/scenarioYamlDocument';

function applyEdit(source: string, edit: SourceEdit): string {
    return source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end);
}

test('YAML section insertion appends a nested scenario and preserves CRLF and comments', () => {
    const source = [
        'ТипФайла: Сценарий',
        'ВложенныеСценарии:',
        '  # этот комментарий остается',
        '    - ВложенныеСценарии1:',
        '        UIDВложенныйСценарий: "uid-1"',
        '        ИмяСценария: "Первый"',
        'ТекстСценария: |',
        '    И Первый',
        ''
    ].join('\r\n');

    const edit = getSectionInsertion(source, 'ВложенныеСценарии', [
        '- ВложенныеСценарии2:',
        '    UIDВложенныйСценарий: "uid-2"',
        '    ИмяСценария: "Второй"'
    ].join('\n'));

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ТипФайла: Сценарий',
        'ВложенныеСценарии:',
        '  # этот комментарий остается',
        '    - ВложенныеСценарии1:',
        '        UIDВложенныйСценарий: "uid-1"',
        '        ИмяСценария: "Первый"',
        '    - ВложенныеСценарии2:',
        '        UIDВложенныйСценарий: "uid-2"',
        '        ИмяСценария: "Второй"',
        'ТекстСценария: |',
        '    И Первый',
        ''
    ].join('\r\n'));
});

test('YAML section insertion fills an empty section before adjacent comments', () => {
    const source = 'ВложенныеСценарии:\n# пояснение следующей секции\nТекстСценария: |\n    И Сценарий\n';
    const edit = getSectionInsertion(
        source,
        'ВложенныеСценарии',
        '- ВложенныеСценарии1:\n    ИмяСценария: "Сценарий"'
    );

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Сценарий"',
        '# пояснение следующей секции',
        'ТекстСценария: |',
        '    И Сценарий',
        ''
    ].join('\n'));
});

test('YAML section replacement changes only nested-scenario items', () => {
    const source = [
        'ТипФайла: Сценарий',
        'ВложенныеСценарии:',
        '  # описание списка',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Старый"',
        '# комментарий следующей секции',
        'ТекстСценария: |',
        '    И Новый',
        ''
    ].join('\n');
    const edit = getSectionBodyReplacement(
        source,
        'ВложенныеСценарии',
        '- ВложенныеСценарии1:\n    ИмяСценария: "Новый"'
    );

    assert.ok(edit);
    const result = applyEdit(source, edit);
    assert.equal(result, [
        'ТипФайла: Сценарий',
        'ВложенныеСценарии:',
        '  # описание списка',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Новый"',
        '# комментарий следующей секции',
        'ТекстСценария: |',
        '    И Новый',
        ''
    ].join('\n'));
    assert.equal(result.slice(0, edit.range.start), source.slice(0, edit.range.start));
    assert.equal(result.slice(edit.range.start + edit.text.length), source.slice(edit.range.end));
});

test('YAML section replacement supports inline empty sequences', () => {
    const source = 'ВложенныеСценарии: []\nТекстСценария: |\n    И Сценарий\n';
    const edit = getSectionBodyReplacement(
        source,
        'ВложенныеСценарии',
        '- ВложенныеСценарии1:\n    ИмяСценария: "Сценарий"'
    );

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Сценарий"',
        'ТекстСценария: |',
        '    И Сценарий',
        ''
    ].join('\n'));
});

test('YAML section replacement preserves parameter neighbors and quoted punctuation', () => {
    const source = [
        'ДанныеСценария:',
        '  Имя: Тест',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: Старый',
        '        Значение: "A: #1"',
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: Сосед',
        'ТекстСценария: |',
        '    И Сосед',
        ''
    ].join('\n');
    const edit = getSectionBodyReplacement(source, 'ПараметрыСценария', [
        '- ПараметрыСценария1:',
        '    Имя: "Новый"',
        '    Значение: "B: #2"'
    ].join('\n'));

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ДанныеСценария:',
        '  Имя: Тест',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: "Новый"',
        '        Значение: "B: #2"',
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: Сосед',
        'ТекстСценария: |',
        '    И Сосед',
        ''
    ].join('\n'));
});

test('YAML section edits refuse malformed documents and ignore missing sections', () => {
    assert.throws(
        () => getSectionBodyReplacement('ВложенныеСценарии:\n  - [broken\n', 'ВложенныеСценарии', ''),
        /YAML/i
    );
    assert.equal(getSectionInsertion('ДанныеСценария:\n  Имя: Тест\n', 'ВложенныеСценарии', '- item'), null);
});
