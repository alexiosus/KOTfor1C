import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGherkinSyntaxErrors } from '../src/gherkinSyntaxValidator.js';
import { validateGherkinSyntax } from '../src/exportScenarioParser';

test('validates nested Vanessa Try and Except from a compiled BOM and CRLF feature', () => {
    const source = '\uFEFF' + [
        '# language: en',
        'Feature: FIFO',
        'Scenario: Wait for a report',
        '\tAnd While "$DoCheck$" 1C:Enterprise script is True Then',
        '\t\tTry',
        '\t\t\tAnd the attribute named "PrintForm1" is not read-only',
        '\t\tExcept',
        '\t\t\tTry',
        '\t\t\t\tThen 1C:Enterprise language expression "$Timer$ < $Timeout$" is true',
        '\t\t\tExcept',
        '\t\t\t\tThen I raise "Report timeout" exception',
        '\tAnd I close the report'
    ].join('\r\n');

    assert.deepEqual(collectGherkinSyntaxErrors(source), []);
    assert.deepEqual(validateGherkinSyntax(source, 'file:///tests/FIFO.feature'), []);
});

for (const { header, steps } of [
    {
        header: 'Feature: Conditions\nScenario: Conditional recovery',
        steps: ['If "first" Then', '    Try', '        Given ready', '    Except', '        Then recovered', 'ElseIf "second" Then', '    Then alternative', 'Else', '    Then fallback']
    },
    {
        header: '# language: ru\nФункциональность: Условия\nСценарий: Восстановление',
        steps: ['Если "первое" Тогда', '    Попытка', '        Дано готово', '    Исключение', '        Тогда восстановлено', 'ИначеЕсли "второе" Тогда', '    Тогда другое', 'Иначе', '    Тогда запасное']
    }
]) {
    test(`validates Vanessa conditional and exception branches in ${header.startsWith('#') ? 'Russian' : 'English'}`, () => {
        assert.deepEqual(collectGherkinSyntaxErrors(`${header}\n${steps.map(step => `    ${step}`).join('\n')}\n`), []);
    });
}

test('keeps the original diagnostic location after Vanessa control lines', () => {
    const source = [
        'Feature: Recovery',
        'Scenario: Recovery',
        '  Try',
        '    Given ready',
        '  Except',
        '    Then recovered',
        '      Unsupported line'
    ].join('\r\n');
    const warnings = validateGherkinSyntax(source, 'file:///tests/recovery.feature');

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].uri, 'file:///tests/recovery.feature');
    assert.match(warnings[0].message, /got 'Unsupported line'/u);
    assert.deepEqual(warnings[0].range, {
        start: { line: 6, character: 6 },
        end: { line: 6, character: 22 }
    });
});

test('does not accept misspelled or malformed bare Vanessa controls', () => {
    for (const line of ['TryAgain', 'Try invalid', 'Except invalid', 'Else invalid', 'ElseIf', 'ElseIf condition']) {
        const errors = collectGherkinSyntaxErrors(`Feature: Recovery\nScenario: Recovery\n    Given ready\n    ${line}\n`);
        assert.equal(errors.length, 1, line);
        assert.equal(errors[0].line, 4, line);
        assert.equal(errors[0].column, 5, line);
    }
});

test('keeps parser errors for malformed tables and unclosed docstrings within Vanessa blocks', () => {
    const prefix = 'Feature: Recovery\nScenario: Recovery\n    Try\n        Given a payload\n';
    assert.ok(collectGherkinSyntaxErrors(`${prefix}        | a | b |\n        | 1 |\n    Except\n        Then recovered\n`)
        .some(error => /inconsistent cell count/u.test(error.message)));
    assert.ok(collectGherkinSyntaxErrors(`${prefix}        """\n        Try\n        Except\n`)
        .some(error => /unexpected end of file/u.test(error.message)));
});

test('validates control-like text inside both docstring formats and controls after them', () => {
    for (const delimiter of ['"""', '```']) {
        const source = [
            'Feature: Recovery', 'Scenario: Recovery', '    Try', '        Given a payload',
            `        ${delimiter}`, '        Try', '        Except', '        ElseIf condition Then',
            '        Variables:', '        Scenario: literal text', `        ${delimiter}`,
            '    Except', '        Then recovered'
        ].join('\n');
        assert.deepEqual(collectGherkinSyntaxErrors(source), [], delimiter);
    }
});
