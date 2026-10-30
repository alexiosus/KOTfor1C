import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenarioVariantPreview, parseScenarioParameterDefinitions, renderScenarioParameterDefault } from '../src/scenarioParameterUtils';
import { parseScenarioDescriptor } from '../src/scenarioDescriptor';
import { buildProjectDefinitionInsertion } from '../src/projectDefinitionSnippet';

const source = [
    'ТипФайла: "Сценарий"', 'ПараметрыСценария:',
    '    - ПараметрыСценария1:', '        Имя: "Rows"', '        ТипПараметра: "Таблица"',
    '        Значение: |', '            | Name | Value |', '            | A;B | 10 |',
    '    - ПараметрыСценария2:', '        Имя: "Text"', '        Значение: "a;b;"',
    'ТекстСценария: |', '    And I use [Rows]'
].join('\n');

test('table defaults retain the decoded rows, type and source range in LF and CRLF', () => {
    for (const text of [source, source.replace(/\n/g, '\r\n')]) {
        const rows = parseScenarioParameterDefinitions(text).get('Rows')!;
        assert.equal(rows.type, 'table');
        assert.equal(rows.normalizedDefaultValue, '| Name | Value |\n| A;B | 10 |');
        assert.ok(text.slice(rows.valueRange!.startOffset, rows.valueRange!.endOffset).includes('| A;B | 10 |'));
        const descriptor = parseScenarioDescriptor(text);
        assert.equal(descriptor.parameterTypes?.Rows, 'table');
        assert.equal(descriptor.parameterDefaults?.Rows, rows.normalizedDefaultValue);
    }
});

test('variants follow unescaped semicolons and preserve empty alternatives', () => {
    const preview = buildScenarioVariantPreview(source, 2);
    assert.equal(preview.count, '3');
    assert.equal(preview.samples.length, 2);
    assert.equal(preview.truncated, true);
    const escaped = source.replace('a;b;', 'a\\;b;c');
    assert.equal(buildScenarioVariantPreview(escaped).count, '2');
    assert.equal(buildScenarioVariantPreview(escaped).samples[0].Text, 'a;b');
});

test('variant preview decodes only escapes supported by the compiler YAML reader', () => {
    for (const [token, expected] of [
        ['"a\\nb;c"', 'a\\nb'],
        ['"a\\tb;c"', 'a\\tb'],
        ['"a\\\\;b;c"', 'a;b'],
        ['"a\\\"b;c"', 'a"b'],
        ["'a''b;c'", "a''b"]
    ]) {
        const text = `ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Text"\n        Значение: ${token}`;
        assert.equal(buildScenarioVariantPreview(text).samples[0].Text, expected);
    }
});

test('variant previews bound memory for huge Cartesian products', () => {
    const text = 'ПараметрыСценария:\n' + Array.from({ length: 60 }, (_, index) =>
        `    - ПараметрыСценария${index}:\n        Имя: "P${index}"\n        Значение: "a;b"`).join('\n');
    const preview = buildScenarioVariantPreview(text, 3);
    assert.equal(preview.count, (2n ** 60n).toString());
    assert.equal(preview.samples.length, 3);
});

test('refill rendering preserves table rows and escaped scalar text', () => {
    assert.equal(renderScenarioParameterDefault('| A |\n| B |\n', 'Таблица'), '|\n        | A |\n        | B |');
    assert.equal(renderScenarioParameterDefault('a\\;b "c"', 'Строка'), '"a\\\\;b \\"c\\""');
    assert.equal(renderScenarioParameterDefault('hello\nworld', 'Строка'), '|\n        hello\n        world');
});

test('editing a scalar block default leaves the next YAML field on its own line', () => {
    for (const eol of ['\n', '\r\n']) {
        const text = ['ПараметрыСценария:', '    - ПараметрыСценария1:', '        Имя: "Text"',
            '        Значение: |', '            hello', '            world', '        ТипПараметра: "Строка"'].join(eol);
        const range = parseScenarioParameterDefinitions(text).get('Text')!.valueRange!;
        const edited = text.slice(0, range.startOffset) + '"changed"' + text.slice(range.endOffset);
        assert.ok(edited.includes(`Значение: "changed"${eol}        ТипПараметра:`));
    }
});

test('calling a child with a multiline scalar default retains its implicit default instead of emitting a broken assignment', () => {
    const descriptor = parseScenarioDescriptor('ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Text"\n        Значение: |-\n            hello\n            world\n        ТипПараметра: "Строка"');
    const result = buildProjectDefinitionInsertion({ id: 'child', kind: 'nestedScenario', template: 'Child', normalizedTemplate: 'Child', sourceLabel: 'YAML',
        parameters: [{ name: 'Text', index: 0, source: 'snippet', defaultValue: descriptor.parameterDefaults!.Text },
            { name: 'Amount', index: 1, source: 'snippet', defaultValue: '"100"' }] },
    { fallbackKeyword: 'And', language: 'en', documentFormat: 'yaml' });
    assert.equal(result.displayText, 'And Child\n    Amount = "100"');
    const referenced = buildProjectDefinitionInsertion({ id: 'child', kind: 'nestedScenario', template: 'Child', normalizedTemplate: 'Child', sourceLabel: 'YAML',
        parameters: [{ name: 'Text', index: 0, source: 'snippet' }] },
    { fallbackKeyword: 'And', language: 'en', documentFormat: 'yaml', parameterDefaults: { Text: '"hello\nworld"' } });
    assert.equal(referenced.displayText, 'And Child\n    Text = [Text]');
    for (const marker of ['|', '>']) {
        const single = `ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Text"\n        Значение: ${marker}\n            hello\n`;
        const defaultValue = parseScenarioDescriptor(single).parameterDefaults!.Text;
        assert.equal(defaultValue, '"hello\n"');
        assert.equal(parseScenarioParameterDefinitions(single).get('Text')!.normalizedDefaultValue, defaultValue);
        const inserted = buildProjectDefinitionInsertion({ id: 'single', kind: 'nestedScenario', template: 'Child', normalizedTemplate: 'Child', sourceLabel: 'YAML',
            parameters: [{ name: 'Text', index: 0, source: 'snippet', defaultValue }] }, { fallbackKeyword: 'And', language: 'en', documentFormat: 'yaml' });
        assert.equal(inserted.displayText, 'And Child');
        assert.equal(inserted.hasPlaceholders, false);
    }
});
