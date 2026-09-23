import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

interface Definition {
    id: string;
    kind: 'builtInStep' | 'userStep' | 'exportScenario' | 'nestedScenario';
    template: string;
    normalizedTemplate: string;
    language?: 'ru' | 'en';
    parameters: readonly unknown[];
    description?: string;
    category?: string;
    sourceLabel: string;
    definitionLocation?: {
        uri: string;
        range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
        };
    };
}

function transpileModule(fileName: string): string {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    return ts.transpileModule(
        fs.readFileSync(path.join(process.cwd(), 'src', fileName), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
    ).outputText;
}

class MarkdownString {
    public value = '';
    public isTrusted = false;
    public supportThemeIcons = false;

    public appendMarkdown(value: string): this {
        this.value += value;
        return this;
    }

    public appendText(value: string): this {
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

class Range {
    public constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number
    ) {}
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

        public constructor(public label: string | { label: string; description?: string }, public kind: number) {}
    },
    CompletionItemKind: { Snippet: 1, Function: 2 },
    CompletionList: class {
        public constructor(public items: unknown[] = [], public isIncomplete = false) {}
    },
    Hover: class {
        public constructor(public contents: MarkdownString, public range?: unknown) {}
    },
    MarkdownString,
    Range,
    SnippetString,
    l10n: { t: (message: string, ...args: string[]) =>
        message.replace(/\{(\d+)\}/g, (_match: string, index: string) => args[Number(index)] ?? '') },
    workspace: {
        getConfiguration: () => ({ get: () => 'System' })
    }
};

function loadProvider(fileName: string): Record<string, unknown> {
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(transpileModule(fileName), {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return vscode;
            }
            if (specifier === 'path') {
                return path;
            }
            if (specifier === './gherkinLanguage') {
                return {
                    getScenarioLanguageForDocument: () => 'en',
                    getScenarioCallKeyword: () => 'And'
                };
            }
            if (specifier === './blockKeywordParser') {
                return { parseBlockKeyword: () => null, getBlockClosingKeyword: () => null };
            }
            if (specifier === './gherkinTableUtils') {
                return { normalizeMultilineStepInsertText: (value: string) => value };
            }
            if (specifier === './yamlValidator.js') {
                return { isScenarioYamlFile: () => true };
            }
            if (specifier === './stepSuggestionIndex') {
                return { StepSuggestionIndex: class { public getSuggestions(): string[] { return []; } } };
            }
            if (specifier === './localization') {
                return { getTranslator: async () => (message: string) => message };
            }
            return {};
        },
        console: { log: () => undefined, error: () => undefined },
        setImmediate
    });
    return moduleObject.exports;
}

function definition(overrides: Partial<Definition> & Pick<Definition, 'id' | 'kind' | 'template' | 'sourceLabel'>): Definition {
    return {
        normalizedTemplate: overrides.template.replace(/\s+/g, ' ').trim(),
        parameters: [],
        ...overrides
    };
}

test('completion includes project definitions, preserves duplicate sources, and ranks them before built-ins', async () => {
    const exports = loadProvider('completionProvider.ts');
    const Provider = exports.DriveCompletionProvider as { prototype: object };
    const definitions = [
        definition({
            id: 'built:shared', kind: 'builtInStep', template: 'And shared step',
            sourceLabel: 'Vanessa 1.2 (EN)', language: 'en'
        }),
        definition({
            id: 'user:shared', kind: 'userStep', template: 'And shared step',
            sourceLabel: 'User library /steps/common.feature', language: 'en'
        }),
        definition({
            id: 'export:login', kind: 'exportScenario', template: 'And export login',
            sourceLabel: 'Export scenario /features/login.feature', language: 'en'
        })
    ];
    const provider = Object.create(Provider.prototype);
    provider.definitionResolver = {
        getView: async () => ({
            identity: 'view:project-and-builtins',
            all: definitions,
            byId: new Map(definitions.map(item => [item.id, item])),
            byNormalizedTemplate: new Map()
        })
    };
    provider.preparedGherkinStates = { getOrCreate: (_identity: string, factory: () => unknown) => factory() };
    provider.scenarioDefaultsByDocument = new Map();
    provider.isInScenarioTextBlock = () => true;
    provider.fuzzyMatch = () => ({ matched: true, score: 1 });
    provider.getScenarioParameterDefaults = () => new Map();

    const document = {
        fileName: 'test.feature',
        uri: { toString: () => 'file:///test.feature' },
        lineAt: () => ({ text: 'And ' })
    };
    const result = await provider.provideCompletionItems(
        document,
        { line: 0, character: 4 },
        { isCancellationRequested: false },
        {}
    );
    const items = result.items as Array<{
        label: string | { label: string; description?: string };
        sortText: string;
    }>;
    assert.equal(items.length, 3);

    const shared = items.filter(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'And shared step');
    assert.equal(shared.length, 2);
    assert.deepEqual(
        shared.map(item => typeof item.label === 'string' ? '' : item.label.description).sort(),
        ['User library /steps/common.feature', 'Vanessa 1.2 (EN)']
    );
    const user = shared.find(item => typeof item.label !== 'string' && item.label.description?.startsWith('User'));
    const builtIn = shared.find(item => typeof item.label !== 'string' && item.label.description?.startsWith('Vanessa'));
    assert.ok(user && builtIn);
    assert.ok(user.sortText < builtIn.sortText);
    assert.ok(items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'And export login'));
});

test('completion still returns built-ins when the local definition snapshot is unavailable', async () => {
    const exports = loadProvider('completionProvider.ts');
    const Provider = exports.DriveCompletionProvider as { prototype: object };
    const builtIn = definition({
        id: 'built:only', kind: 'builtInStep', template: 'And built-in only',
        sourceLabel: 'Vanessa 1.2 (EN)', language: 'en'
    });
    const provider = Object.create(Provider.prototype);
    provider.definitionResolver = {
        getView: async () => ({
            identity: 'view:local-unavailable', all: [builtIn],
            byId: new Map([[builtIn.id, builtIn]]), byNormalizedTemplate: new Map()
        })
    };
    provider.preparedGherkinStates = { getOrCreate: (_identity: string, factory: () => unknown) => factory() };
    provider.isInScenarioTextBlock = () => true;
    provider.fuzzyMatch = () => ({ matched: true, score: 1 });
    provider.getScenarioParameterDefaults = () => new Map();

    const result = await provider.provideCompletionItems(
        {
            fileName: 'test.feature', uri: { toString: () => 'file:///test.feature' },
            lineAt: () => ({ text: 'And built' })
        },
        { line: 0, character: 9 },
        { isCancellationRequested: false },
        {}
    );
    assert.equal(result.items.length, 1);
});

test('nested scenario completion preserves the call keyword and parameter block', async () => {
    const exports = loadProvider('completionProvider.ts');
    const Provider = exports.DriveCompletionProvider as { prototype: object };
    const nested = definition({
        id: 'nested:login', kind: 'nestedScenario', template: 'Login as administrator',
        sourceLabel: 'Nested scenario (auth/login)',
        parameters: [
            { name: 'User', index: 0, source: 'snippet' },
            { name: 'Role', index: 1, source: 'snippet' }
        ]
    });
    const provider = Object.create(Provider.prototype);
    provider.definitionResolver = {
        getView: async () => ({
            identity: 'view:nested', all: [nested],
            byId: new Map([[nested.id, nested]]), byNormalizedTemplate: new Map()
        })
    };
    provider.preparedGherkinStates = { getOrCreate: (_identity: string, factory: () => unknown) => factory() };
    provider.isInScenarioTextBlock = () => true;
    provider.fuzzyMatch = () => ({ matched: true, score: 1 });
    provider.getScenarioParameterDefaults = () => new Map();

    const result = await provider.provideCompletionItems(
        {
            fileName: 'test.yaml', languageId: 'yaml', version: 1,
            uri: { toString: () => 'file:///test.yaml' },
            lineAt: () => ({ text: '    Log' }),
            getText: () => 'ТекстСценария: |\n    Log'
        },
        { line: 0, character: 7 },
        { isCancellationRequested: false },
        {}
    );
    assert.equal(result.items.length, 1);
    const item = result.items[0] as { label: string | { label: string }; insertText: SnippetString };
    assert.equal(typeof item.label === 'string' ? item.label : item.label.label, 'And Login as administrator');
    assert.match(item.insertText.value, /^And Login as administrator\n/);
    assert.match(item.insertText.value, /User\s+= \$\{1:/);
    assert.match(item.insertText.value, /Role\s+= \$\{2:/);
});

test('hover renders every ambiguous definition with its source and open link', async () => {
    const exports = loadProvider('hoverProvider.ts');
    const Provider = exports.DriveHoverProvider as { prototype: object };
    const definitions = [
        definition({
            id: 'user:a', kind: 'userStep', template: 'And shared step',
            sourceLabel: 'User library /steps/a.feature', description: 'User step', category: 'Project',
            definitionLocation: {
                uri: 'file:///repo/steps/a.feature',
                range: { start: { line: 4, character: 0 }, end: { line: 4, character: 15 } }
            }
        }),
        definition({
            id: 'export:b', kind: 'exportScenario', template: 'And shared step',
            sourceLabel: 'Export scenario /features/b.feature', description: 'Exported scenario',
            definitionLocation: {
                uri: 'file:///repo/features/b.feature',
                range: { start: { line: 8, character: 0 }, end: { line: 8, character: 15 } }
            }
        })
    ];
    const provider = Object.create(Provider.prototype);
    provider.definitionResolver = {
        resolve: async () => ({
            kind: 'ambiguous',
            matches: definitions.map(item => ({ definition: item, invocationRange: { start: 0, end: 15 }, arguments: [] }))
        })
    };
    provider.provideYamlFieldHover = async () => null;
    provider.isFeatureDocument = () => true;
    provider.isInScenarioTextBlock = () => true;
    provider.provideVariableHover = async () => null;

    const hover = await provider.provideHover(
        {
            fileName: 'test.feature', languageId: 'gherkin', uri: { toString: () => 'file:///test.feature' },
            lineAt: () => ({ text: 'And shared step' })
        },
        { line: 0, character: 8 },
        { isCancellationRequested: false }
    );
    assert.ok(hover);
    const markdown = hover.contents.value as string;
    assert.match(markdown, /User library \/steps\/a\.feature/);
    assert.match(markdown, /Export scenario \/features\/b\.feature/);
    assert.equal((markdown.match(/command:kotTestToolkit\.openProjectDefinition/g) ?? []).length, 2);
});
