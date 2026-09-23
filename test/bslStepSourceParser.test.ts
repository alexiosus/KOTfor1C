import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseUserStepSource, scanBslTokens } from '../src/bslStepSourceParser';

const fixturePath = path.join(
    process.cwd(),
    'test',
    'fixtures',
    'project-definitions',
    'UserSteps.bsl'
);

const context = {
    sourceUri: 'file:///workspace/libraries/step_definitions-src/UserSteps/Module.bsl',
    workspaceFolderUri: 'file:///workspace',
    profileId: 'active',
    libraryRootUri: 'file:///workspace/libraries',
    sourceLabel: 'User steps'
};

test('lexes comments, newlines, punctuation and doubled-quote BSL strings', () => {
    const source = '// Fake.Call("ignored")\r\nName = "text ""in quotes""";\r\n';
    const tokens = scanBslTokens(source);

    assert.equal(tokens[0].kind, 'comment');
    assert.equal(tokens[1].kind, 'newline');
    assert.deepEqual(
        tokens.filter(token => token.kind === 'identifier').map(token => token.text),
        ['Name']
    );
    const string = tokens.find(token => token.kind === 'string');
    assert.equal(string?.value, 'text "in quotes"');
    assert.deepEqual(string?.range.start, { line: 1, character: 7 });
    assert.equal(tokens.filter(token => token.kind === 'newline').length, 2);
});

test('parses static multiline registrations and resolves their implementations', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const result = parseUserStepSource(source, context);

    assert.deepEqual(result.definitions.map(item => item.template), [
        'И я открываю "Имя" для "Роль"',
        'И шаг без реализации'
    ]);
    assert.equal(result.definitions[0].description, 'Открывает "особую" карточку.');
    assert.equal(result.definitions[0].category, 'UI');
    assert.deepEqual(
        result.definitions[0].parameters.map(item => ({ name: item.name, source: item.source })),
        [
            { name: 'Имя', source: 'snippet' },
            { name: 'Роль', source: 'snippet' }
        ]
    );
    assert.equal(result.definitions[0].implementationLocation?.range.start.line, 25);
    assert.equal(result.definitions[1].implementationLocation, result.definitions[1].definitionLocation);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.declarations.map(item => item.name).includes('ОткрытьКарточку'), true);
});

test('returns parser-proven insertion ranges for one registration function and module', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const result = parseUserStepSource(source, context);

    assert.deepEqual(result.registrationInsertionRange?.start, { line: 21, character: 0 });
    assert.deepEqual(result.registrationInsertionRange?.end, result.registrationInsertionRange?.start);
    assert.deepEqual(result.moduleAppendRange?.start, { line: 28, character: 0 });
    assert.deepEqual(result.moduleAppendRange?.end, result.moduleAppendRange?.start);
});

test('skips only a dynamic registration and reports its range', () => {
    const source = [
        'Функция ПолучитьСписокТестов(Контекст) Экспорт',
        '    ВсеТесты = Новый Массив;',
        '    Ванесса.ДобавитьШагВМассивТестов(ВсеТесты, "Static()", "Static", "И статический шаг", "", "");',
        '',
        '    Имя = "Dynamic";',
        '    Снипет = "Dynamic()";',
        '    // dynamic template must not hide the neighboring static registration',
        '',
        '    Ванесса.ДобавитьШагВМассивТестов(ВсеТесты, Снипет, Имя, ПолучитьПредставление(), "", "");',
        '    Возврат ВсеТесты;',
        'КонецФункции'
    ].join('\n');
    const result = parseUserStepSource(source, context);

    assert.deepEqual(result.definitions.map(item => item.template), ['И статический шаг']);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /dynamic expression/i);
    assert.equal(result.warnings[0].range?.start.line, 8);
});

test('does not expose unsafe insertion points for ambiguous or unterminated modules', () => {
    const source = [
        'Функция ПолучитьСписокТестов() Экспорт',
        'КонецФункции',
        'Функция ПолучитьСписокТестов() Экспорт',
        'КонецФункции',
        'Процедура НеЗакрыта()'
    ].join('\n');
    const result = parseUserStepSource(source, context);

    assert.equal(result.registrationInsertionRange, null);
    assert.equal(result.moduleAppendRange, null);
    assert.match(result.warnings.map(item => item.message).join('\n'), /ambiguous/i);
    assert.match(result.warnings.map(item => item.message).join('\n'), /unterminated/i);
});
