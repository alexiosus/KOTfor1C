import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as projectDefinitionSnippet from '../src/projectDefinitionSnippet';

test('project definition completion logging does not grow with the number of matching definitions', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'completionProvider.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const logs: string[] = [];
    const vscode = {
        CompletionItem: class {
            public constructor(public label: string, public kind: number) {}
        },
        CompletionItemKind: { Snippet: 1 },
        CompletionList: class { public items: unknown[] = []; },
        MarkdownString: class {
            public appendMarkdown(): this { return this; }
            public appendCodeblock(): this { return this; }
        },
        Range: class {
            public constructor(
                public startLine: number,
                public startCharacter: number,
                public endLine: number,
                public endCharacter: number
            ) {}
        },
        SnippetString: class { public constructor(public value = '') {} },
        l10n: { t: (message: string) => message }
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
            if (specifier === './yamlValidator.js') {
                return { isScenarioYamlFile: () => true };
            }
            if (specifier === './blockKeywordParser') {
                return { parseBlockKeyword: () => null, getBlockClosingKeyword: () => null };
            }
            if (specifier === './gherkinTableUtils') {
                return { normalizeMultilineStepInsertText: (value: string) => value };
            }
            if (specifier === './projectDefinitionSnippet') {
                return projectDefinitionSnippet;
            }
            if (specifier === './gherkinInsertionContext') {
                return { getGherkinInsertionContext: () => ({ supported: true }) };
            }
            return {};
        },
        console: { log: (...args: unknown[]) => logs.push(args.join(' ')) }
    });

    const Provider = moduleObject.exports.DriveCompletionProvider as { prototype: object };
    const document = {
        fileName: 'test.feature',
        uri: { toString: () => 'file:///test.feature' },
        lineAt: () => ({ text: 'And ' })
    };
    const position = { line: 0, character: 4 };

    async function complete(count: number): Promise<{ itemCount: number; logCount: number }> {
        logs.length = 0;
        const provider = Object.create(Provider.prototype);
        const definitions = Array.from({ length: count }, (_, index) => ({
            id: `definition:${index}`,
            kind: 'exportScenario',
            template: `And Scenario ${index}`,
            normalizedTemplate: `And Scenario ${index}`,
            language: 'en',
            parameters: [],
            sourceLabel: `Scenario ${index}`
        }));
        provider.definitionResolver = {
            getView: async () => ({
                identity: `test:${count}`,
                all: definitions,
                byId: new Map(),
                byNormalizedTemplate: new Map()
            })
        };
        provider.preparedGherkinStates = {
            getOrCreate: (_identity: string, factory: () => unknown) => factory()
        };
        provider.isInScenarioTextBlock = () => true;
        provider.fuzzyMatch = () => ({ matched: true, score: 1 });

        const result = await provider.provideCompletionItems(document, position, {}, {});
        return { itemCount: result.items.length, logCount: logs.length };
    }

    const one = await complete(1);
    const many = await complete(100);
    assert.equal(one.itemCount, 1);
    assert.equal(many.itemCount, 100);
    assert.equal(many.logCount, one.logCount);
});

test('Feature IntelliSense offers structural Gherkin keywords outside a scenario body', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'completionProvider.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const vscode = {
        CompletionItem: class {
            public insertText?: unknown;
            public range?: unknown;
            public sortText?: string;
            public constructor(public label: string, public kind: number) {}
        },
        CompletionItemKind: { Keyword: 14, Snippet: 1 },
        CompletionList: class {
            public constructor(public items: unknown[] = []) {}
        },
        MarkdownString: class {
            public appendMarkdown(): this { return this; }
            public appendCodeblock(): this { return this; }
        },
        Range: class {
            public constructor(
                public startLine: number,
                public startCharacter: number,
                public endLine: number,
                public endCharacter: number
            ) {}
        },
        SnippetString: class { public constructor(public value = '') {} },
        l10n: { t: (message: string) => message }
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
            if (specifier === './gherkinInsertionContext') {
                return { getGherkinInsertionContext: () => null };
            }
            if (specifier === './projectDefinitionSnippet') {
                return projectDefinitionSnippet;
            }
            if (specifier === './blockKeywordParser') {
                return { parseBlockKeyword: () => null, getBlockClosingKeyword: () => null };
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
    const lines = ['# language: en', 'Feature: Project feature', ''];
    const document = {
        fileName: '/repo/project.feature',
        uri: { toString: () => 'file:///repo/project.feature' },
        lineCount: lines.length,
        getText: () => lines.join('\n'),
        lineAt: (line: number) => ({ text: lines[line] })
    };

    const result = await provider.provideCompletionItems(
        document,
        { line: 2, character: 0 },
        { isCancellationRequested: false },
        {}
    );
    const labels = Array.from(result.items ?? result, (item: { label: string }) => item.label);

    assert.ok(labels.includes('Scenario'));
    assert.ok(labels.includes('Scenario Outline'));
    assert.ok(labels.includes('Background'));
});
