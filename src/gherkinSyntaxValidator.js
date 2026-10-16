'use strict';

// @cucumber/gherkin deliberately supports require(), but its package metadata is ESM-only.
// Keeping that compatibility boundary in JavaScript avoids weakening Node16 module checks
// across the TypeScript project.
const { AstBuilder, GherkinClassicTokenMatcher, Parser } = require('@cucumber/gherkin');
const { IdGenerator } = require('@cucumber/messages');

function maskVanessaSections(source) {
    const lines = source.split(/\n/u);
    let variables = false;
    let delimiter = '';
    return lines.map((line, index) => {
        const marker = /^\s*("""|```)/u.exec(line)?.[1];
        const inDocString = !!delimiter || !!marker;
        if (marker && (!delimiter || marker === delimiter)) { delimiter = delimiter ? '' : marker; }
        if (!inDocString && /^\s*(?:Variables|Hyperlinks|Links|Переменные|Гиперссылки|Ссылки)\s*:/iu.test(line)) {
            variables = true;
        } else if (!inDocString && /^\s*(?:Feature|Functionality|Business Need|Ability|Функциональность|Функционал|Функция|Background|Предыстория|Контекст|Scenario(?: Outline| Template)?|Сценарий|Структура сценария|Шаблон сценария|Rule|Правило)\s*:/iu.test(line)) {
            variables = false;
        }
        if (variables) { return line.replace(/[^\r]/gu, ' '); }
        if (!inDocString && /^\s*@(?:screenshot|recordvideo|StopRecordVideo|StartRecordVideo)\s*$/iu.test(line)) {
            const next = lines.slice(index + 1).find(value => value.trim() && !/^\s*(?:#|\/\/|@)/u.test(value));
            if (next && /^\s*(?:\*\s*|(?:Given|When|Then|And|But|If|Дано|Допустим|Когда|Тогда|И|Но|К тому же|Если)\s)/iu.test(next)) {
                return line.replace(/[^\r]/gu, ' ');
            }
        }
        if (!inDocString) {
            const control = /^([ \t]*)(Try|Except|Else|Попытка|Исключение|Иначе)(?=[ \t]*\r?$)/iu.exec(line)
                || /^([ \t]*)(ElseIf(?=[ \t]+.+[ \t]+Then[ \t]*\r?$)|ИначеЕсли(?=[ \t]+.+[ \t]+Тогда[ \t]*\r?$))/iu.exec(line);
            if (control) {
                // Vanessa uses indentation for these feature blocks. Keep each control as a
                // generic step for Cucumber, preserving source positions and parser errors.
                return `${control[1]}*${' '.repeat(control[2].length - 1)}${line.slice(control[0].length)}`;
            }
        }
        return line;
    }).join('\n');
}

function maskVanessaMetadata(source) {
    return maskVanessaSections(source)
        .replace(
            /^(\uFEFF?[ \t]*)Functionality([ \t]*):/gimu,
            (_value, indent, space) => `${indent}Feature${space}:${' '.repeat(6)}`
        )
        .replace(
            /^([ \t]*)(?:@(?:steptype|типшага|description|описание|exampleofuse|примериспользования)\s*:|@[\p{L}\p{N}_-]+\s*=|\/\/).*$/gimu,
            value => value.replace(/[^\r\n]/gu, ' ')
        )
        .replace(
            /^(\s*)\*(?=(?:And|But|Then|When|Given|If|И|Но|Тогда|Когда|Если|Допустим|Дано|К тому же)\s)/gimu,
            (_value, indent) => `${indent} `
        )
        .replace(
            /^(\s*)(If|Если)(?=\s)/gimu,
            (_value, indent, keyword) => `${indent}*${' '.repeat(Math.max(0, keyword.length - 1))}`
        );
}

function collectGherkinSyntaxErrors(source) {
    try {
        const parser = new Parser(
            new AstBuilder(IdGenerator.incrementing()),
            new GherkinClassicTokenMatcher()
        );
        parser.parse(maskVanessaMetadata(source));
        return [];
    } catch (error) {
        const errors = Array.isArray(error?.errors) && error.errors.length > 0
            ? error.errors
            : [error];
        return errors.map(item => ({
            message: String(item?.message || error?.message || 'Invalid Gherkin syntax.')
                .replace(/^\(\d+:\d+\):\s*/u, '')
                .trim(),
            line: Math.max(1, Number(item?.location?.line) || 1),
            column: Math.max(1, Number(item?.location?.column) || 1)
        }));
    }
}

module.exports = { collectGherkinSyntaxErrors };
