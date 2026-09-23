import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

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
