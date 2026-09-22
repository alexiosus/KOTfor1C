import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

test('scenario completion logging does not grow with the number of matching scenarios', async () => {
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
        CompletionList: class { public items: unknown[] = []; },
        Range: class {
            public constructor(
                public startLine: number,
                public startCharacter: number,
                public endLine: number,
                public endCharacter: number
            ) {}
        },
        SnippetString: class {}
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
            return {};
        },
        console: { log: (...args: unknown[]) => logs.push(args.join(' ')) }
    });

    const Provider = moduleObject.exports.DriveCompletionProvider as { prototype: object };
    const document = {
        fileName: 'test.yaml',
        lineAt: () => ({ text: '    ' })
    };
    const position = { line: 0, character: 4 };

    async function complete(count: number): Promise<{ itemCount: number; logCount: number }> {
        logs.length = 0;
        const provider = Object.create(Provider.prototype);
        provider.scenarioCompletionsInitialized = true;
        provider.scenarioCompletionEntries = Array.from({ length: count }, (_, index) => ({
            item: { label: `Scenario ${index}`, kind: 1 },
            scenario: { name: `Scenario ${index}` }
        }));
        provider.gherkinCompletionItems = [];
        provider.isLoadingGherkin = false;
        provider.isInScenarioTextBlock = () => true;
        provider.loadGherkinCompletionItems = async () => {};
        provider.getScenarioParameterDefaults = () => new Map();
        provider.resolveScenarioCallInsertIndent = () => ({
            baseIndent: '    ', firstLinePrefix: '', replacementStartCharacter: 4
        });
        provider.buildScenarioCallInsertText = () => 'Call scenario';

        const result = await provider.provideCompletionItems(document, position, {}, {});
        return { itemCount: result.items.length, logCount: logs.length };
    }

    const one = await complete(1);
    const many = await complete(100);
    assert.equal(one.itemCount, 1);
    assert.equal(many.itemCount, 100);
    assert.equal(many.logCount, one.logCount);
});
