import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import type * as vscode from 'vscode';
import type { DriveCompletionProvider } from '../src/completionProvider';
import type { ProjectDefinitionResolver } from '../src/projectDefinitionResolver';
import { createProjectDefinitionView, type ProjectDefinition } from '../src/projectDefinition';
import * as blockKeywordParser from '../src/blockKeywordParser';
import * as gherkinDefinitionKeywords from '../src/gherkinDefinitionKeywords';
import * as gherkinInsertionContext from '../src/gherkinInsertionContext';
import * as gherkinTableUtils from '../src/gherkinTableUtils';
import * as preparedStepStateCache from '../src/preparedStepStateCache';
import * as projectDefinitionSnippet from '../src/projectDefinitionSnippet';
import * as scenarioParameterUtils from '../src/scenarioParameterUtils';
import * as scenarioCompilerSyntax from '../src/scenarioCompilerSyntax';
import { renderFeatureTemplate } from '../src/featureTemplate';

class MarkdownString {
    public value = '';
    public appendMarkdown(value: string): this { this.value += value; return this; }
    public appendCodeblock(value: string): this { this.value += value; return this; }
}

class SnippetString {
    public constructor(public value = '') {}
}

const host = {
    CompletionItem: class {
        public constructor(public label: string | { label: string }, public kind: number) {}
    },
    CompletionItemKind: { Snippet: 1, Keyword: 14, Field: 5, Value: 12, Module: 8, Variable: 6 },
    CompletionList: class {
        public constructor(public items: unknown[] = [], public isIncomplete = false) {}
    },
    MarkdownString,
    SnippetString,
    Range: class {
        public constructor(
            public startLine: number, public startCharacter: number,
            public endLine: number, public endCharacter: number
        ) {}
    },
    l10n: { t: (message: string) => message },
    workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        onDidCloseTextDocument: () => ({ dispose: () => undefined })
    }
};

function loadModule(fileName: string, dependencies: Record<string, unknown>): Record<string, unknown> {
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(ts.transpileModule(
        fs.readFileSync(path.join(process.cwd(), 'src', fileName), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
    ).outputText, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => dependencies[specifier] ?? {},
        console: { log: () => undefined, warn: () => undefined }
    });
    return moduleObject.exports;
}

const languageModule = loadModule('gherkinLanguage.ts', {
    vscode: host, './gherkinDefinitionKeywords': gherkinDefinitionKeywords
});
let liveFormSnapshot: any = null;
let snapshotReads = 0;
const completionModule = loadModule('completionProvider.ts', {
    './formExplorerLiveSnapshot': { loadLiveFormExplorerSnapshot: async () => { snapshotReads++; return liveFormSnapshot; } },
    vscode: host,
    './gherkinLanguage': languageModule,
    './blockKeywordParser': blockKeywordParser,
    './gherkinInsertionContext': gherkinInsertionContext,
    './gherkinTableUtils': gherkinTableUtils,
    './preparedStepStateCache': preparedStepStateCache,
    './projectDefinitionSnippet': projectDefinitionSnippet,
    './scenarioParameterUtils': scenarioParameterUtils,
    './scenarioCompilerSyntax': scenarioCompilerSyntax
});
const Provider = completionModule.DriveCompletionProvider as new (
    context: vscode.ExtensionContext, resolver: ProjectDefinitionResolver
) => DriveCompletionProvider;

function definitions(language: 'ru' | 'en'): ProjectDefinition[] {
    const keyword = language === 'ru' ? 'И' : 'And';
    const shared = language === 'ru' ? 'общее' : 'shared';
    return [
        { id: `built:${language}`, kind: 'builtInStep', template: `${keyword} ${shared} built-in` },
        { id: `user:${language}`, kind: 'userStep', template: `${keyword} ${shared} user step` },
        {
            id: `export:${language}`, kind: 'exportScenario', template: `${shared} export "WindowName"`,
            usageExample: `${language === 'ru' ? 'Тогда' : 'Then'} ${shared} export "Main"`,
            parameters: [{ name: 'WindowName', index: 0, source: 'quoted' as const }]
        },
        {
            id: `nested:${language}`, kind: 'nestedScenario', template: `${shared} YAML scenario`,
            parameters: [{ name: 'User', index: 0, source: 'snippet' as const }]
        }
    ].map(item => ({
        normalizedTemplate: item.template,
        parameters: [],
        language,
        sourceLabel: item.id,
        ...item
    }));
}

function createProvider(language: 'ru' | 'en', additional: ProjectDefinition[] = []): DriveCompletionProvider {
    const view = createProjectDefinitionView('shared-view', [...definitions(language), ...additional]);
    return new Provider({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
        getView: async () => view,
        onDidChangeView: () => ({ dispose: () => undefined })
    } as unknown as ProjectDefinitionResolver);
}

function document(language: 'ru' | 'en', kind: 'feature' | 'export' | 'yaml', semantic = false): vscode.TextDocument {
    const query = language === 'ru' ? 'общее' : 'shared';
    const keyword = language === 'ru' ? 'И' : 'And';
    const step = `    ${keyword} ${semantic ? '!' : ''}${query}`;
    const lines = kind === 'yaml'
        ? ['ТипФайла: "Сценарий"', `#language: ${language}`, 'ТекстСценария: |', step]
        : [
            `#language: ${language}`,
            ...(kind === 'export' ? ['@ExportScenarios'] : []),
            `${language === 'ru' ? 'Функционал' : 'Feature'}: Project`,
            `${language === 'ru' ? 'Сценарий' : 'Scenario'}: Caller`, step
        ];
    const fileName = `/repo/${kind === 'yaml' ? 'scen.yaml' : `${kind}.feature`}`;
    return {
        fileName,
        uri: { fsPath: fileName, toString: () => `file://${fileName}` },
        languageId: kind === 'yaml' ? 'yaml' : 'feature',
        version: 1,
        lineCount: lines.length,
        getText: () => lines.join('\n'),
        lineAt: (line: number) => ({ text: lines[line] })
    } as unknown as vscode.TextDocument;
}

async function complete(
    provider: DriveCompletionProvider, target: vscode.TextDocument, position?: vscode.Position
): Promise<vscode.CompletionItem[]> {
    const line = target.lineCount - 1;
    const result = await provider.provideCompletionItems(
        target, position ?? { line, character: target.lineAt(line).text.length } as vscode.Position,
        { isCancellationRequested: false } as vscode.CancellationToken, {} as vscode.CompletionContext
    );
    return Array.isArray(result) ? result : result.items;
}

function sourceKinds(items: readonly vscode.CompletionItem[]): string[] {
    return Array.from(items, item => item.detail?.split(' - ')[0] ?? '').sort();
}

function withScenarioText(
    language: 'ru' | 'en', kind: 'feature' | 'export' | 'yaml', text: string
): vscode.TextDocument {
    const original = document(language, kind);
    const lines = original.getText().split('\n').slice(0, -1).concat(text.split('\n'));
    return {
        ...original,
        lineCount: lines.length,
        getText: () => lines.join('\n'),
        lineAt: (index: number) => ({ text: lines[index] })
    } as unknown as vscode.TextDocument;
}

function keywordItems(items: readonly vscode.CompletionItem[]): vscode.CompletionItem[] {
    return items.filter(item => item.kind === host.CompletionItemKind.Keyword);
}

for (const kind of ['feature', 'export', 'yaml'] as const) {
    test(`${kind} offers Vanessa branches and exception constructs on a blank scenario line`, async () => {
        const items = keywordItems(await complete(createProvider('en'), withScenarioText('en', kind, '    ')));
        const labels = items.map(item => item.label);
        for (const label of ['Else', 'ElseIf', 'Try', 'Except']) {
            assert.ok(labels.includes(label), `${label} should be offered`);
        }
        for (const label of ['EndIf', 'EndTry', 'EndDo', 'КонецЕсли', 'КонецПопытки', 'КонецЦикла']) {
            assert.equal(labels.includes(label), kind === 'yaml', `${label} is YAML only`);
        }
    });
}

for (const [prefix, expected] of [
    ['el', ['Else', 'ElseIf']], ['tR', ['Try']], ['ex', ['Except']],
    ['Ина', ['Иначе', 'ИначеЕсли']], ['Поп', ['Попытка']], ['Иск', ['Исключение']]
] as const) {
    test(`control completion filters the keyword prefix ${prefix} without adding a Gherkin step prefix`, async () => {
        const items = keywordItems(await complete(createProvider('en'), withScenarioText('en', 'feature', `\t\t${prefix}`)));
        assert.deepEqual(Array.from(items, item => item.label).sort(), [...expected].sort());
        for (const item of items) {
            const value = typeof item.insertText === 'string' ? item.insertText : (item.insertText as SnippetString).value;
            assert.ok(value.startsWith(String(item.label)));
            assert.doesNotMatch(value, /^(?:And|И)\s/u);
            assert.equal((item.range as unknown as { startCharacter: number }).startCharacter, 2);
        }
    });
}

test('ElseIf inserts an editable condition and Then without disturbing the existing indentation', async () => {
    const items = keywordItems(await complete(createProvider('en'), withScenarioText('en', 'yaml', '        ElseI')));
    const item = items.find(candidate => candidate.label === 'ElseIf');
    assert.ok(item);
    assert.equal((item.insertText as SnippetString).value, 'ElseIf ${1:condition} Then');
    assert.equal((item.range as unknown as { startCharacter: number }).startCharacter, 8);
});

test('Russian control snippets keep their native spelling and editable condition', async () => {
    const items = keywordItems(await complete(createProvider('ru'), withScenarioText('ru', 'yaml', '    ИначеЕ')));
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'ИначеЕсли');
    assert.equal((items[0].insertText as SnippetString).value, 'ИначеЕсли ${1:условие} Тогда');
});

test('control completion replaces the entire partial word when the cursor is inside it', async () => {
    const target = withScenarioText('en', 'feature', '        Else');
    const items = keywordItems(await complete(createProvider('en'), target, { line: 3, character: 10 } as vscode.Position));
    const item = items.find(candidate => candidate.label === 'Else');
    assert.ok(item);
    const range = item.range as unknown as { startCharacter: number; endCharacter: number };
    const original = target.lineAt(3).text;
    assert.equal(original.slice(0, range.startCharacter) + item.insertText + original.slice(range.endCharacter), '        Else');
});

for (const kind of ['feature', 'yaml'] as const) {
    test(`${kind} infers scenario indentation when inserting a control keyword on an empty line`, async () => {
        const target = withScenarioText('en', kind, '        Given ready\n');
        const items = keywordItems(await complete(createProvider('en'), target));
        assert.equal(items.find(item => item.label === 'Try')?.insertText, '        Try');
    });

    test(`${kind} does not replace an existing step keyword when completion is invoked before it`, async () => {
        const target = withScenarioText('en', kind, '    And ready');
        const items = keywordItems(await complete(createProvider('en'), target, {
            line: target.lineCount - 1, character: 4
        } as vscode.Position));
        assert.equal(items.some(item => item.label === 'Try'), false);
    });

    test(`${kind} resumes control completion after a closed docstring`, async () => {
        const target = withScenarioText('en', kind, '    Given ready\n    """\n    Try\n    """\n    Tr');
        const items = keywordItems(await complete(createProvider('en'), target));
        assert.deepEqual(Array.from(items, item => item.label), ['Try']);
    });
}

test('control completion stays out of YAML settings and fields after the scenario block', async () => {
    const target = withScenarioText('en', 'yaml', '    Given ready\nПараметрыСценария:\n    Tr');
    assert.equal(keywordItems(await complete(createProvider('en'), target)).length, 0);
    const text = 'ТипФайла: НастройкаТеста\nТекстСценария: |\n    Tr';
    const lines = text.split('\n');
    const setting = { ...target, lineCount: lines.length, getText: () => text, lineAt: (index: number) => ({ text: lines[index] }) } as unknown as vscode.TextDocument;
    assert.equal(keywordItems(await complete(createProvider('en'), setting)).length, 0);
});

test('YAML closing constructs complete their prefix and are absent from feature files', async () => {
    for (const kind of ['yaml', 'feature', 'export'] as const) {
        const items = keywordItems(await complete(createProvider('en'), withScenarioText('en', kind, '    End')));
        assert.deepEqual(Array.from(items, item => item.label).sort(), kind === 'yaml' ? ['EndDo', 'EndIf', 'EndTry'] : []);
    }
});

test('YAML preprocessor completion uses Russian compiler directives and stays out of feature files', async () => {
    const items = keywordItems(await complete(createProvider('en'), withScenarioText('en', 'yaml', '    #')));
    assert.deepEqual(Array.from(items, item => item.label).sort(), ['#Если', '#Иначе', '#ИначеЕсли', '#КонецЕсли']);
    const conditional = items.find(item => item.label === '#Если')!;
    assert.equal((conditional.insertText as SnippetString).value, '#Если ${1:условие} Тогда');
    assert.equal(items.find(item => item.label === '#КонецЕсли')!.insertText, '#КонецЕсли');
    assert.equal(keywordItems(await complete(createProvider('en'), withScenarioText('en', 'feature', '    #И'))).some(item => String(item.label).startsWith('#')), false);
    assert.equal(keywordItems(await complete(createProvider('en'), withScenarioText('en', 'yaml', '    /*\n    #И'))).length, 0);
});

test('returned parameter completion uses the child parameter and saved variable aliases', async () => {
    const child: ProjectDefinition = {
        id: 'child', kind: 'nestedScenario', template: 'Child', normalizedTemplate: 'Child', sourceLabel: 'YAML',
        parameters: [{ name: 'Result', index: 0, source: 'snippet' }]
    };
    const target = withScenarioText('en', 'yaml', '    And Child\n        Rows =\n            | Name |\n        Return Re');
    const items = await complete(createProvider('en', [child]), target);
    assert.deepEqual(Array.from(items, item => item.label), ['Result']);
    assert.equal(items[0].insertText, 'Result');
    const aliasSource = 'ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "SameHeaderParameter"\n        Значение: ""\n';
    const alias = withScenarioText('en', 'yaml', '    And I save "1" in "Saved" variable\n    And Child\n        Return Result as Sa');
    const text = alias.getText().replace('ТекстСценария:', `${aliasSource}ТекстСценария:`);
    const lines = text.split('\n');
    const local = { ...alias, getText: () => text, lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] }) } as unknown as vscode.TextDocument;
    assert.deepEqual(Array.from(await complete(createProvider('en', [child]), local), item => item.label), ['Saved']);
});

test('returned aliases complete as Vanessa variables after the call without a YAML header parameter', async () => {
    for (const binding of ['Return Result as Saved', 'Возврат Result как Saved', 'Result = Saved']) {
        const target = withScenarioText('en', 'yaml', `    /*\n    Return Result as Ignored\n    */\n    And Child\n        ${binding}\n    And I input "$Sa`);
        const items = await complete(createProvider('en'), target);
        assert.ok(items.some(item => item.insertText === '$Saved$'), binding);
        assert.ok(!items.some(item => item.insertText === '$Ignored$'), binding);
    }
});

test('table and docstring parameter substitutions still complete while step suggestions are excluded', async () => {
    for (const body of ['    | [Te', '    """\n    [Te']) {
        const target = withScenarioText('en', 'yaml', body);
        const text = target.getText().replace('ТекстСценария:', 'ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Text"\n        Значение: "x"\nТекстСценария:');
        const lines = text.split('\n');
        const local = { ...target, getText: () => text, lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] }) } as unknown as vscode.TextDocument;
        assert.ok((await complete(createProvider('en'), local)).some(item => typeof item.label === 'object' && item.label.label === '[Text]'), body);
    }
});

for (const semantic of [false, true]) {
    test(`${semantic ? 'semantic' : 'direct'} conditional step snippets add EndIf only in YAML`, async () => {
        const conditional: ProjectDefinition = {
            id: 'condition', kind: 'builtInStep', language: 'en',
            template: 'If I check "value" Then', normalizedTemplate: 'If I check "value" Then',
            parameters: [], sourceLabel: 'Vanessa'
        };
        for (const kind of ['feature', 'export', 'yaml'] as const) {
            const target = withScenarioText('en', kind, `    ${semantic ? '!check' : 'If I check'}`);
            const items = await complete(createProvider('en', [conditional]), target);
            const item = items.find(candidate => candidate.label === 'If I check "value" Then');
            assert.ok(item, kind);
            const value = typeof item.insertText === 'string' ? item.insertText : (item.insertText as SnippetString).value;
            assert.equal(value.includes('EndIf'), kind === 'yaml', kind);
        }
    });
}

for (const kind of ['feature', 'yaml'] as const) {
    for (const text of ['    And El', '    # Try', '    @Try', '    | Try |', '    // Try', '    """\n    Tr', '    ```\n    Tr']) {
        test(`${kind} does not suggest control constructs inside step text, comments, tags, tables or doc strings: ${JSON.stringify(text)}`, async () => {
            assert.equal(keywordItems(await complete(createProvider('en'), withScenarioText('en', kind, text)))
                .some(item => item.label === 'Try' || item.label === 'Else'), false);
        });
    }
}

const featureSources = ['Export Scenario (1C)', 'Gherkin Step (1C)', 'User Step (1C)'];

for (const semantic of [false, true]) {
    for (const [language, template, query, yamlSnippet] of [
        ['en', 'And I repeat "%1 Count" times', 'And I repeat', 'Do I repeat "${1}" times\n    $0\nEndDo'],
        ['en', 'And While "%1 Condition" 1C:Enterprise script is True I do', 'And While', 'Do While "${1}" 1C:Enterprise script is True I do\n    $0\nEndDo'],
        ['ru', 'И я делаю "%1 Количество" раз', 'И я делаю', 'Цикл я делаю "${1}" раз\n    $0\nКонецЦикла']
    ] as const) {
        test(`${semantic ? 'semantic' : 'direct'} completion adapts ${template} only in YAML`, async () => {
            const loop: ProjectDefinition = {
                id: 'loop', kind: 'builtInStep', language, template, normalizedTemplate: template,
                parameters: [], sourceLabel: 'Vanessa'
            };
            for (const kind of ['yaml', 'feature', 'export'] as const) {
                const text = semantic ? `!${query.replace(/^(?:And|И) /u, '')}` : query;
                const target = withScenarioText(language, kind, `    ${text}`);
                const items = await complete(createProvider(language, [loop]), target);
                const item = items.find(candidate => candidate.detail?.includes('· Vanessa'));
                assert.ok(item, kind);
                const value = typeof item.insertText === 'string' ? item.insertText : (item.insertText as SnippetString).value;
                const nativeSnippet = language === 'ru'
                    ? 'И я делаю "${1}" раз'
                    : query === 'And While'
                        ? 'And While "${1}" 1C:Enterprise script is True I do'
                        : 'And I repeat "${1}" times';
                assert.equal(value, kind === 'yaml' ? yamlSnippet : nativeSnippet, kind);
            }
        });
    }
}

const yamlSources = ['Export Scenario (1C)', 'Gherkin Step (1C)', 'Nested Scenario (1C)', 'User Step (1C)'];

test('generated English Functionality declaration enables scenario and background structure completion', async () => {
    const source = renderFeatureTemplate({ language: 'en', featureTitle: 'Order validation', scenarioTitle: 'Create order' });
    const lines = source.split('\n');
    const line = lines.findIndex(value => value.startsWith('Functionality:')) + 1;
    const target = {
        ...document('en', 'feature'),
        lineCount: lines.length,
        getText: () => source,
        lineAt: (index: number) => ({ text: lines[index] })
    } as unknown as vscode.TextDocument;
    const result = await createProvider('en').provideCompletionItems(
        target, { line, character: 0 } as vscode.Position,
        { isCancellationRequested: false } as vscode.CancellationToken, {} as vscode.CompletionContext
    );
    const items = Array.isArray(result) ? result : result.items;
    assert.deepEqual(Array.from(items, item => item.label), ['Scenario', 'Scenario Outline', 'Background']);
});

for (const language of ['en', 'ru'] as const) {
    for (const kind of ['feature', 'export'] as const) {
        for (const semantic of [false, true]) {
            test(`${language} ${kind} ${semantic ? 'semantic' : 'direct'} completion excludes YAML scenarios and retains Vanessa, user and export steps`, async () => {
                const items = await complete(createProvider(language), document(language, kind, semantic));
                assert.deepEqual(sourceKinds(items), featureSources);
                const exported = items.find(item => item.detail?.startsWith('Export Scenario'));
                assert.ok(exported);
                assert.match((exported.insertText as SnippetString).value, /"\$\{1:WindowName\}"/u);
            });
        }
    }
}

for (const semantic of [false, true]) {
    for (const first of ['feature', 'yaml'] as const) {
        test(`${semantic ? 'semantic' : 'direct'} completion keeps document source rules when shared cache is populated by ${first}`, async () => {
            const provider = createProvider('en');
            const order = first === 'feature' ? ['feature', 'yaml', 'export', 'yaml'] as const
                : ['yaml', 'feature', 'yaml', 'export'] as const;
            for (const kind of order) {
                const items = await complete(provider, document('en', kind, semantic));
                assert.deepEqual(sourceKinds(items), kind === 'yaml' ? yamlSources : featureSources, kind);
                if (kind === 'yaml') {
                    const nested = items.find(item => item.detail?.startsWith('Nested Scenario'));
                    assert.ok(nested);
                    assert.match((nested.insertText as SnippetString).value, /^And shared YAML scenario\n\s+User\s+= \$\{1:/u);
                }
            }
        });
    }
}

function argumentTarget(text: string, kind: 'feature' | 'yaml' = 'feature') {
    const character = text.indexOf('|'); const line = '    ' + text.replace('|', '');
    const source = withScenarioText('en', kind, line);
    return { source, position: { line: source.lineCount - 1, character: character + 4 } as vscode.Position };
}
const formSnapshot = { snapshot: { form: { title: 'Primary chart of accounts' }, elements: [
    { path: 'Description', name: 'Description', title: 'Description', kind: 'InputField', valuePreview: 'Revenue', children: [] },
    { path: 'Unrelated', name: 'Unrelated', title: 'Unrelated', kind: 'InputField', valuePreview: 'Irrelevant', children: [] },
    { path: 'FormCreate', name: 'FormCreate', title: 'Create', kind: 'Button', children: [] }], tables: [{ name: 'Items', tableData: { columns: ['Quantity'], rows: [['10']] } }], attributes: [] } };

test('quoted argument completion never falls through to step suggestions, including final or unclosed arguments', async () => {
    for (const kind of ['feature', 'yaml'] as const) {
        for (const text of ['And "sh|ared"', 'And "sh|ared', 'And I wait "10|" seconds']) {
            const { source, position } = argumentTarget(text, kind);
            const provider = createProvider('en'); let catalogReads = 0;
            const resolver = (provider as any).definitionResolver; const getView = resolver.getView;
            resolver.getView = async (...args: any[]) => { catalogReads++; return getView(...args); };
            assert.equal((await complete(provider, source, position)).length, 0, text);
            assert.equal(catalogReads, 0, 'argument completion must not query the step catalog');
        }
    }
});

test('Form Explorer suggests only values for an explicitly identified argument', async () => {
    liveFormSnapshot = formSnapshot;
    try {
        for (const kind of ['feature', 'yaml'] as const) {
            for (const text of [
                'And I wait "Primary chart of accounts" window opening in "|" seconds',
                'And Delay "|"', 'And I select "Revenue" value from the field named "Description" within "|" seconds',
                'And custom step "|" and "Description" field', 'And custom field step "Description" and "|"',
                'And I input "|" text in the field named "Missing"'
            ]) {
                const { source, position } = argumentTarget(text, kind);
                assert.equal((await complete(createProvider('en'), source, position)).length, 0, `${kind}: ${text}`);
            }
            for (const [text, expected, excluded] of [
                ['And I wait "|" window opening in "10" seconds', 'Primary chart of accounts', 'Revenue'],
                ['And I input "|" text in the field named "Description"', 'Revenue', 'Irrelevant'],
                ['And I click the button named "|"', 'FormCreate', 'Description'],
                ['И я жду открытия окна "|"', 'Primary chart of accounts', 'Revenue'],
                ['И я ввожу "|" текст в поле с именем "Description"', 'Revenue', 'Irrelevant'],
                ['И я нажимаю на "|" кнопку', 'Create', 'Description'],
                ['Then "|" реквизит формы', 'Description', 'FormCreate'],
                ['And in the table "|" I go to first row', 'Items', 'Revenue'],
                ['Then in table "Items" field named "Quantity" became equal to "|"', '10', 'Irrelevant']
            ]) {
                const { source, position } = argumentTarget(text, kind); const items = await complete(createProvider('en'), source, position);
                const values = items.map((item: any) => typeof item.label === 'string' ? item.label : item.label.label);
                assert.ok(values.includes(expected), text); assert.ok(!values.includes(excluded), text);
            }
        }
        snapshotReads = 0; const timeout = argumentTarget('And I wait "Name" window opening in "|" seconds');
        await complete(createProvider('en'), timeout.source, timeout.position); assert.equal(snapshotReads, 0, 'unrelated arguments do not read the form snapshot');
    } finally { liveFormSnapshot = null; }
});
