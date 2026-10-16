import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCompilerParameterReferences, getCompilerScenarioBody, parseCompilerParameterBinding, scanCompilerLines, validateCompilerBlocks } from '../src/scenarioCompilerSyntax';

test('compiler blocks use one stack and distinguish preprocessor and delimiter languages', () => {
    assert.equal(validateCompilerBlocks(['If condition Then', '#Если A = "x" Тогда', '#Иначе', '#КонецЕсли', 'Else', 'EndIf']).length, 0);
    for (const lines of [
        ['If x Then', 'Do repeat', 'EndIf', 'EndDo'],
        ['Do repeat', 'КонецЦикла'], ['#Если x Тогда', 'EndIf'],
        ['Else'], ['Except'], ['Try', 'Except', 'Except', 'EndTry'],
        ['If x Then', 'Else', 'ElseIf y Then', 'EndIf']
    ]) { assert.ok(validateCompilerBlocks(lines).length, lines.join('\n')); }
});

test('compiler scanner ignores blocks and steps inside comments and docstrings', () => {
    const lines = ['/*', 'EndDo', 'And fake', '*/', '"""', 'EndIf', '"""', '// Try'];
    assert.deepEqual(scanCompilerLines(lines).map(line => line.kind), ['comment', 'comment', 'comment', 'comment', 'docString', 'docString', 'docString', 'comment']);
    assert.equal(validateCompilerBlocks(lines).length, 0);
    assert.equal(validateCompilerBlocks(['/*', 'comment'])[0].kind, 'comment');
});

test('preprocessor conditions receive structural checks without evaluating BSL', () => {
    for (const line of ['#Если Тогда', '#Если x', '#Если (x Тогда', '#Если "x Тогда']) {
        assert.ok(validateCompilerBlocks([line]).some(issue => issue.kind === 'expression'), line);
    }
});

test('returned results and table assignments have distinct binding kinds', () => {
    assert.deepEqual(parseCompilerParameterBinding('Возврат Result как Alias'), { name: 'Result', value: '', kind: 'return', alias: 'Alias' });
    assert.equal(parseCompilerParameterBinding('Result = CallerResult')?.kind, 'output');
    assert.equal(parseCompilerParameterBinding('Rows =')?.kind, 'table');
    assert.equal(parseCompilerParameterBinding('Text = "literal"')?.kind, 'input');
    assert.equal(parseCompilerParameterBinding('Return Result как Alias'), null);
    assert.ok(validateCompilerBlocks(['Return Result as']).some(issue => issue.kind === 'binding'));
});

test('body extraction ignores nested YAML header text in block scalars', () => {
    const source = 'Описание: |\n    ТекстСценария: |\n        And fake [Fake]\nТекстСценария: |\n    And real [Real]';
    const body = getCompilerScenarioBody(source)!;
    assert.equal(body.startLine, 4);
    assert.deepEqual(collectCompilerParameterReferences(body.lines), ['Real']);
});

test('orphan comment ends and unclosed docstrings are compiler syntax errors', () => {
    assert.ok(validateCompilerBlocks(['*/']).some(issue => issue.kind === 'order'));
    assert.ok(validateCompilerBlocks(['"""', 'text']).some(issue => issue.kind === 'docString'));
});

test('parameter references include substitutions but exclude literal return aliases and comments', () => {
    assert.deepEqual(collectCompilerParameterReferences([
        '/*', '[Ignored]', '*/', 'Result = CallerResult', 'Return Result as Alias', 'Возврат Other',
        '| [Rows] |', '"""', '[Text]', '"""', '// [IgnoredToo]', 'And escaped \\[Escaped]'
    ]), ['Rows', 'Text']);
});
