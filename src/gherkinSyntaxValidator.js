'use strict';

// @cucumber/gherkin deliberately supports require(), but its package metadata is ESM-only.
// Keeping that compatibility boundary in JavaScript avoids weakening Node16 module checks
// across the TypeScript project.
const { AstBuilder, GherkinClassicTokenMatcher, Parser } = require('@cucumber/gherkin');
const { IdGenerator } = require('@cucumber/messages');

function maskVanessaMetadata(source) {
    return source
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
