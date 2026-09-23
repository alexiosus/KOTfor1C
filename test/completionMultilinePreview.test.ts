import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

test('multiline step documentation renders each localized template as a code block', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'completionProvider.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;

    class MarkdownString {
        public value = '';

        public appendMarkdown(value: string): this {
            this.value += value;
            return this;
        }

        public appendCodeblock(value: string, language = ''): this {
            this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
            return this;
        }
    }

    class SnippetString {
        public constructor(public value = '') {}
    }

    const vscode = {
        CompletionItem: class {
            public documentation?: MarkdownString;
            public detail?: string;
            public insertText?: string | SnippetString;
            public filterText?: string;
            public range?: unknown;
            public command?: unknown;
            public sortText?: string;

            public constructor(public label: string, public kind: number) {}
        },
        CompletionItemKind: { Snippet: 1 },
        CompletionList: class {
            public items: unknown[];

            public constructor(items: unknown[] = []) {
                this.items = items;
            }
        },
        MarkdownString,
        Range: class {
            public constructor(
                public startLine: number,
                public startCharacter: number,
                public endLine: number,
                public endCharacter: number
            ) {}
        },
        SnippetString
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return vscode;
            }
            if (specifier === './gherkinLanguage') {
                return {
                    getScenarioLanguageForDocument: () => 'en',
                    getScenarioCallKeyword: () => 'Call'
                };
            }
            if (specifier === './blockKeywordParser') {
                return {
                    parseBlockKeyword: () => null,
                    getBlockClosingKeyword: () => null
                };
            }
            if (specifier === './gherkinTableUtils') {
                return { normalizeMultilineStepInsertText: (value: string) => value };
            }
            return {};
        },
        console: { log: () => undefined }
    });

    const Provider = moduleObject.exports.DriveCompletionProvider as { prototype: object };
    const provider = Object.create(Provider.prototype);
    provider.scenarioCompletionsInitialized = true;
    provider.scenarioCompletionEntries = [];
    provider.catalogProvider = {
        getCatalog: async () => ({
            identity: 'test:multiline',
            steps: [{
                id: 'multiline-table-step',
                ru: {
                    pattern: 'Если таблица содержит колонки Тогда\n    | Колонка1 |\n    | Колонка2 |',
                    description: 'Проверяет колонки таблицы.'
                },
                en: {
                    pattern: 'If table contains columns Then\n    | Column1 |\n    | Column2 |',
                    description: 'Checks table columns.'
                }
            }]
        })
    };
    provider.preparedGherkinStates = {
        getOrCreate: (_identity: string, factory: () => unknown) => factory()
    };
    provider.isInScenarioTextBlock = () => true;
    provider.getScenarioParameterDefaults = () => new Map();
    provider.fuzzyMatch = () => ({ matched: true, score: 1 });

    const document = {
        fileName: 'test.feature',
        uri: { toString: () => 'file:///test.feature' },
        lineAt: () => ({ text: 'If table' })
    };
    const position = { line: 0, character: 8 };
    const result = await provider.provideCompletionItems(document, position, {}, {});
    const englishItem = result.items.find((item: { detail?: string }) => item.detail?.endsWith('English'));
    assert.ok(englishItem);

    const documentation = englishItem.documentation.value as string;
    assert.match(
        documentation,
        /```gherkin\nIf table contains columns Then\n    \| Column1 \|\n    \| Column2 \|\n```/
    );
    assert.match(
        documentation,
        /```gherkin\nЕсли таблица содержит колонки Тогда\n    \| Колонка1 \|\n    \| Колонка2 \|\n```/
    );
});
