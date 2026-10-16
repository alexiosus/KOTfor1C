import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as realBlockParser from '../src/blockKeywordParser';
import * as compilerSyntax from '../src/scenarioCompilerSyntax';
import * as scenarioParameterUtils from '../src/scenarioParameterUtils';

type DefinitionKind = 'builtInStep' | 'userStep' | 'exportScenario' | 'nestedScenario';

interface Definition {
    id: string;
    kind: DefinitionKind;
    template: string;
    normalizedTemplate: string;
    parameters: readonly unknown[];
    sourceLabel: string;
    definitionLocation?: {
        uri: string;
        range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
        };
    };
}

class Position {
    public constructor(public line: number, public character: number) {}
}

class Range {
    public readonly start: Position;
    public readonly end: Position;

    public constructor(
        startOrLine: Position | number,
        startCharacterOrEnd: Position | number,
        endLine?: number,
        endCharacter?: number
    ) {
        if (startOrLine instanceof Position && startCharacterOrEnd instanceof Position) {
            this.start = startOrLine;
            this.end = startCharacterOrEnd;
            return;
        }
        this.start = new Position(startOrLine as number, startCharacterOrEnd as number);
        this.end = new Position(endLine as number, endCharacter as number);
    }
}

class Diagnostic {
    public source?: string;
    public code?: string;
    public relatedInformation?: unknown[];

    public constructor(
        public range: Range,
        public message: string,
        public severity: number
    ) {}
}

class CodeAction {
    public command?: { command: string; title: string; arguments?: unknown[] };
    public edit?: WorkspaceEdit;
    public diagnostics?: Diagnostic[];
    public isPreferred?: boolean;

    public constructor(public title: string, public kind: string) {}
}

class WorkspaceEdit {
    public readonly replacements: unknown[] = [];
    public readonly insertions: unknown[] = [];

    public replace(uri: unknown, range: unknown, value: string): void {
        this.replacements.push({ uri, range, value });
    }

    public insert(uri: unknown, position: unknown, value: string): void {
        this.insertions.push({ uri, position, value });
    }
}

const vscode = {
    CodeAction,
    CodeActionKind: { QuickFix: 'quickfix' },
    Diagnostic,
    DiagnosticRelatedInformation: class {
        public constructor(public location: unknown, public message: string) {}
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Location: class {
        public constructor(public uri: unknown, public range: unknown) {}
    },
    Position,
    Range,
    Uri: {
        parse: (value: string) => ({ toString: () => value, fsPath: value.replace(/^file:\/\//, '') })
    },
    WorkspaceEdit,
    l10n: {
        t: (message: string, ...args: string[]) =>
            message.replace(/\{(\d+)\}/g, (_match: string, index: string) => args[Number(index)] ?? '')
    }
};

function similarity(left: string, right: string): number {
    if (left === right) {
        return 1;
    }
    const rows = Array.from({ length: left.length + 1 }, (_, row) => {
        const values = Array<number>(right.length + 1).fill(0);
        values[0] = row;
        return values;
    });
    for (let column = 0; column <= right.length; column++) {
        rows[0][column] = column;
    }
    for (let row = 1; row <= left.length; row++) {
        for (let column = 1; column <= right.length; column++) {
            rows[row][column] = Math.min(
                rows[row - 1][column] + 1,
                rows[row][column - 1] + 1,
                rows[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
            );
        }
    }
    return 1 - rows[left.length][right.length] / Math.max(left.length, right.length, 1);
}

function loadDiagnosticsModule(ignoredDiagnosticCodes: readonly string[] = []): Record<string, unknown> {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'scenarioDiagnostics.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const moduleObject = { exports: {} as Record<string, unknown> };

    const vscodeApi = {
        ...vscode,
        workspace: {
            getConfiguration: () => ({
                get: <T>(key: string, fallback: T): T => key === 'diagnostics.ignoredCodes'
                    ? [...ignoredDiagnosticCodes] as T
                    : fallback
            })
        }
    };

    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return vscodeApi;
            }
            if (specifier === 'path') {
                return path;
            }
            if (specifier === './yamlValidator') {
                return { isScenarioYamlFile: () => true, isCompilerYamlFile: () => true, collectYamlIndentationTabs: () => [], collectCompilerFormatDiagnostics: () => [] };
            }
            if (specifier === './scenarioParameterUtils') {
                return scenarioParameterUtils;
            }
            if (specifier === './gherkinLanguage') {
                return {
                    getScenarioCallKeyword: () => 'And',
                    getScenarioLanguageForDocument: () => 'en'
                };
            }
            if (specifier === './blockKeywordParser') {
                return realBlockParser;
            }
            if (specifier === './scenarioCompilerSyntax') { return compilerSyntax; }
            if (specifier === './scenarioScanRoot') {
                return { getScenarioScanRootPath: () => undefined };
            }
            if (specifier === './scenarioCatalog') {
                return {
                    resolveScenarioByName: (_catalog: unknown, name: string) => ({ kind: 'missing', name })
                };
            }
            if (specifier === './scenarioValidationPolicy') {
                return {
                    createDocumentValidationCancellation: (
                        document: { version: number },
                        token?: { isCancellationRequested: boolean }
                    ) => {
                        const version = document.version;
                        return () => document.version !== version || token?.isCancellationRequested === true;
                    },
                    getScenarioValidationOptions: () => ({ includeSuggestions: true, includeStepChecks: true })
                };
            }
            if (specifier === './stringSimilarity') {
                return { calculateLevenshteinSimilarity: similarity };
            }
            if (specifier === './exportScenarioParser') {
                return { validateGherkinSyntax: () => [] };
            }
            return {};
        },
        console: { error: () => undefined, log: () => undefined },
        clearTimeout,
        setImmediate,
        setTimeout
    });
    return moduleObject.exports;
}

function definition(kind: DefinitionKind, id = kind, sourceLabel = kind): Definition {
    return {
        id,
        kind,
        template: 'And project definition',
        normalizedTemplate: 'And project definition',
        parameters: [],
        sourceLabel
    };
}

function match(item: Definition) {
    return { definition: item, invocationRange: { start: 0, end: item.template.length }, arguments: [] };
}

function documentWithLine(invocation: string) {
    const lines = ['ТекстСценария: |', ...invocation.split('\n').map(line => `    ${line}`)];
    const uri = { scheme: 'file', fsPath: '/repo/scenario.yaml', toString: () => 'file:///repo/scenario.yaml' };
    return {
        fileName: '/repo/scenario.yaml',
        isUntitled: false,
        languageId: 'yaml',
        lineCount: lines.length,
        uri,
        version: 1,
        getText: () => lines.join('\n'),
        lineAt: (line: number) => {
            const text = lines[line];
            return {
                text,
                firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
                range: new Range(line, 0, line, text.length)
            };
        }
    };
}

function featureDocumentWithLine(invocation: string) {
    const lines = [
        '# language: en',
        'Feature: Project feature',
        'Scenario: Project scenario',
        `    ${invocation}`
    ];
    const uri = { scheme: 'file', fsPath: '/repo/project.feature', toString: () => 'file:///repo/project.feature' };
    return {
        fileName: '/repo/project.feature',
        isUntitled: false,
        languageId: 'feature',
        lineCount: lines.length,
        uri,
        version: 1,
        getText: () => lines.join('\n'),
        lineAt: (line: number) => {
            const text = lines[line];
            return {
                text,
                firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
                range: new Range(line, 0, line, text.length)
            };
        }
    };
}

const messages = {
    fixAll: 'Fix scenario issues',
    unknownStep: 'Unknown Gherkin step.',
    unknownScenario: 'Unknown nested scenario call.',
    ambiguousScenario: 'Definition resolves to multiple sources:',
    maybeDidYouMeanHeader: 'Maybe you meant:',
    extraScenarioParameter: 'Extra parameter: {0}.',
    missingScenarioParameters: 'Missing parameters:',
    paramValueShouldBeQuoted: 'Parameter value should be quoted.',
    sectionIncomplete: 'Section is incomplete.',
    unmatchedIf: 'Unmatched If.',
    extraEndIf: 'Extra EndIf.',
    unmatchedDo: 'Unmatched Do.',
    extraEndDo: 'Extra EndDo.',
    unmatchedTry: 'Unmatched Try.',
    extraEndTry: 'Extra EndTry.',
    unmatchedQuote: 'Unmatched quote.',
    missingQuotesLikely: 'Likely missing quotes.',
    defaultDescription: 'Default description.',
    duplicateScenarioCode: 'Duplicate code.'
};

function createProvider(resolver: object, ignoredDiagnosticCodes: readonly string[] = []) {
    const exports = loadDiagnosticsModule(ignoredDiagnosticCodes);
    const Provider = exports.ScenarioDiagnosticsProvider as { prototype: object };
    const published = new Map<string, Diagnostic[]>();
    const provider = Object.create(Provider.prototype) as {
        diagnostics: { set: (uri: { toString(): string }, diagnostics: Diagnostic[]) => void; delete: () => void };
        duplicateCodeDiagnostics: { set: () => void; delete: () => void };
        messages: typeof messages;
        phaseSwitcherProvider: object;
        definitionResolver: object;
        rawDiagnosticsByUri: Map<string, { uri: unknown; diagnostics: Diagnostic[] }>;
        validateDocument: (
            document: ReturnType<typeof documentWithLine>,
            options: object,
            shouldCancel?: () => boolean
        ) => Promise<void>;
        republishDiagnostics: () => void;
        provideCodeActions: (...args: any[]) => Promise<CodeAction[]>;
    };
    provider.diagnostics = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        delete: () => undefined
    };
    provider.duplicateCodeDiagnostics = { set: () => undefined, delete: () => undefined };
    provider.messages = messages;
    provider.rawDiagnosticsByUri = new Map();
    provider.phaseSwitcherProvider = {
        ensureFreshScenarioCatalog: async () => ({ all: [], byName: new Map() }),
        getScenarioCatalog: () => ({ all: [], byName: new Map() })
    };
    provider.definitionResolver = resolver;
    return { provider, published };
}

const fullValidation = {
    includeSuggestions: true,
    includeStepChecks: true,
    includeStepSuggestions: true,
    includeScenarioSuggestions: true
};

test('compiler diagnostics reject crossed blocks, mixed delimiters and orphan branches', async () => {
    for (const body of [
        'If known Then\nDo known\nEndIf\nEndDo',
        'Do known\nКонецЦикла',
        '#Если Истина Тогда\nEndIf',
        'Else', 'Except', 'If known Then\nElse\nElse\nEndIf'
    ]) {
        const known = definition('builtInStep');
        const { provider, published } = createProvider({
            resolve: async () => ({ kind: 'unique', match: match(known) }),
            getView: async () => ({ identity: 'known', all: [known], byId: new Map(), byNormalizedTemplate: new Map() })
        });
        const document = documentWithLine(body);
        await provider.validateDocument(document, fullValidation);
        assert.ok((published.get(document.uri.toString()) ?? []).some(item => item.severity === 0), body);
    }
});

test('compiler diagnostics ignore controls, quotes and missing steps in block comments and docstrings', async () => {
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'missing' }),
        getView: async () => ({ identity: 'empty', all: [], byId: new Map(), byNormalizedTemplate: new Map() })
    });
    const document = documentWithLine('/*\nEndDo\nAnd missing "\n*/\n"""\nEndIf\nAnd missing "\n"""');
    await provider.validateDocument(document, fullValidation);
    assert.equal((published.get(document.uri.toString()) ?? []).length, 0);
});

test('return mappings and parameters after a table are validated without requiring quoted results', async () => {
    const nested = { ...definition('nestedScenario'), template: 'Child', parameters: [{ name: 'Rows' }, { name: 'Output' }] };
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'unique', match: match(nested) }),
        getView: async () => ({ identity: 'child', all: [nested], byId: new Map(), byNormalizedTemplate: new Map() })
    });
    const document = documentWithLine('And Child\n    Rows =\n        | Name |\n        | A |\n    Output = CallerOutput\n    Return Output as Result');
    await provider.validateDocument(document, fullValidation);
    assert.equal((published.get(document.uri.toString()) ?? []).some(item => item.code === 'kotTestToolkit.missingQuotes'), false);
    const invalid = documentWithLine('And Child\n    Rows =\n        | Name |\n        | A |\n    Unknown = CallerOutput\n    Return Missing as Result');
    await provider.validateDocument(invalid, fullValidation);
    assert.equal((published.get(invalid.uri.toString()) ?? []).filter(item => item.code === 'kotTestToolkit.extraScenarioParameter').length, 2);
});

test('bindings need a nested scenario owner and cannot belong to a built-in step', async () => {
    const known = definition('builtInStep');
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'unique', match: match(known) }),
        getView: async () => ({ identity: 'known', all: [known], byId: new Map(), byNormalizedTemplate: new Map() })
    });
    for (const body of ['Return Result', 'Rows =', 'Result = Saved', 'And known\n    Return Result']) {
        const document = documentWithLine(body);
        await provider.validateDocument(document, fullValidation);
        assert.ok((published.get(document.uri.toString()) ?? []).some(item => item.code === 'kotTestToolkit.compilerSyntax'), body);
    }
});

test('all compiler Gherkin prefixes can own nested scenario arguments', async () => {
    const nested = { ...definition('nestedScenario'), template: 'Child', parameters: [{ name: 'Value' }] };
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'unique', match: match(nested) }),
        getView: async () => ({ identity: 'child', all: [nested], byId: new Map(), byNormalizedTemplate: new Map() })
    });
    for (const prefix of ['Given', 'When', 'Then', 'And', 'But', 'И', 'Когда', 'Тогда', 'Затем', 'Дано', 'Допустим', 'Пусть', 'То', 'К тому же', 'Также', 'Но', 'А']) {
        const document = documentWithLine(`${prefix} Child\n    Value = 'Completed'`);
        await provider.validateDocument(document, fullValidation);
        assert.equal((published.get(document.uri.toString()) ?? []).some(item => item.code === 'kotTestToolkit.compilerSyntax'), false, prefix);
    }
});

test('multiline scalar child defaults remain implicit and are not diagnosed as missing assignments', async () => {
    const nested = { ...definition('nestedScenario'), template: 'Child',
        parameters: [{ name: 'Text', defaultValue: '"hello\nworld"' }, { name: 'Amount', defaultValue: '"100"' }] };
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'unique', match: match(nested) }),
        getView: async () => ({ identity: 'child', all: [nested], byId: new Map(), byNormalizedTemplate: new Map() })
    });
    const document = documentWithLine('And Child\n    Amount = "100"');
    await provider.validateDocument(document, fullValidation);
    assert.equal((published.get(document.uri.toString()) ?? []).some(item => item.code === 'kotTestToolkit.missingScenarioParameter'), false);
});

test('Gherkin diagnostics use the .feature extension instead of a stale language mode', () => {
    const exports = loadDiagnosticsModule();
    const isGherkinFeatureDocument = exports.isGherkinFeatureDocument as (
        document: { fileName: string; languageId: string }
    ) => boolean;

    assert.equal(typeof isGherkinFeatureDocument, 'function');
    assert.equal(isGherkinFeatureDocument({
        fileName: '/repo/test.yaml',
        languageId: 'feature'
    }), false);
    assert.equal(isGherkinFeatureDocument({
        fileName: '/repo/export.feature',
        languageId: 'plaintext'
    }), true);
});

for (const kind of ['builtInStep', 'userStep', 'exportScenario', 'nestedScenario'] as const) {
    test(`unified diagnostics recognize ${kind}`, async () => {
        const item = definition(kind);
        const { provider, published } = createProvider({
            resolve: async () => ({ kind: 'unique', match: match(item) }),
            getView: async () => ({ identity: kind, all: [item], byId: new Map(), byNormalizedTemplate: new Map() })
        });
        const document = documentWithLine('And project definition');

        await provider.validateDocument(document, fullValidation);

        const diagnostics = published.get(document.uri.toString()) ?? [];
        assert.equal(diagnostics.some(item => item.code === 'kotTestToolkit.unknownStep'), false);
        assert.equal(diagnostics.some(item => item.code === 'kotTestToolkit.unknownScenario'), false);
    });
}

test('project and built-in ambiguity reports every source label', async () => {
    const definitions = [
        definition('userStep', 'user', 'User library /steps/common.feature'),
        definition('builtInStep', 'built', 'Vanessa 1.2 (EN)')
    ];
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'ambiguous', matches: definitions.map(match) }),
        getView: async () => ({ identity: 'ambiguous', all: definitions, byId: new Map(), byNormalizedTemplate: new Map() })
    });
    const document = documentWithLine('And project definition');

    await provider.validateDocument(document, fullValidation);

    const diagnostic = (published.get(document.uri.toString()) ?? [])
        .find(item => item.code === 'kotTestToolkit.ambiguousDefinition');
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /User library \/steps\/common\.feature/);
    assert.match(diagnostic.message, /Vanessa 1\.2 \(EN\)/);
});

test('two local definitions remain ambiguous and retain both source labels', async () => {
    const definitions = [
        definition('userStep', 'local:a', 'User library /steps/a.feature'),
        definition('userStep', 'local:b', 'User library /steps/b.feature')
    ];
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'ambiguous', matches: definitions.map(match) }),
        getView: async () => ({ identity: 'local-duplicates', all: definitions, byId: new Map(), byNormalizedTemplate: new Map() })
    });
    const document = documentWithLine('And project definition');

    await provider.validateDocument(document, fullValidation);

    const diagnostic = (published.get(document.uri.toString()) ?? [])
        .find(item => item.code === 'kotTestToolkit.ambiguousDefinition');
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /steps\/a\.feature/);
    assert.match(diagnostic.message, /steps\/b\.feature/);
});

test('missing project definition produces the existing unknown-step diagnostic', async () => {
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'missing', invocation: 'And missing "value"' }),
        getView: async () => ({ identity: 'empty', all: [], byId: new Map(), byNormalizedTemplate: new Map() })
    });
    const document = documentWithLine('And missing "value"');

    await provider.validateDocument(document, {
        includeSuggestions: false,
        includeStepChecks: true,
        includeStepSuggestions: false,
        includeScenarioSuggestions: false
    });

    const diagnostics = published.get(document.uri.toString()) ?? [];
    assert.ok(diagnostics.some(item => item.code === 'kotTestToolkit.unknownStep'));
});

test('unknown compiler loop steps receive diagnostics and fixes retain delimiters and arguments', async () => {
    for (const [invocation, template, expected] of [
        ['Do I repeet "10" times', 'And I repeat "%1 Count" times', 'Do I repeat "10" times'],
        ['Цикл я делаю "10" раа', 'И я делаю "%1 Count" раз', 'Цикл я делаю "10" раз']
    ]) {
        const candidate = { ...definition('builtInStep'), template, normalizedTemplate: template };
        const { provider, published } = createProvider({
            resolve: async () => ({ kind: 'missing', invocation }),
            getView: async () => ({ identity: 'loop', all: [candidate], byId: new Map(), byNormalizedTemplate: new Map() })
        });
        const document = documentWithLine(invocation);
        await provider.validateDocument(document, fullValidation);
        const diagnostic = (published.get(document.uri.toString()) ?? [])
            .find(item => item.code === 'kotTestToolkit.unknownStep');
        assert.ok(diagnostic, invocation);
        assert.ok(diagnostic.message.includes(expected), diagnostic.message);
        const actions = await provider.provideCodeActions(document, diagnostic.range, { diagnostics: [diagnostic] }, { isCancellationRequested: false });
        assert.ok(actions.some(action => action.edit?.replacements.some(replacement =>
            (replacement as { value: string }).value === `    ${expected}`)), expected);
    }
});

test('Feature diagnostics reuse project definitions for unknown steps', async () => {
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'missing', invocation: 'Given a missing project step' }),
        getView: async () => ({ identity: 'empty', all: [], byId: new Map(), byNormalizedTemplate: new Map() })
    });
    const document = featureDocumentWithLine('Given a missing project step');

    await provider.validateDocument(document as ReturnType<typeof documentWithLine>, {
        includeSuggestions: false,
        includeStepChecks: true,
        includeStepSuggestions: false,
        includeScenarioSuggestions: false
    });

    const diagnostics = published.get(document.uri.toString()) ?? [];
    assert.ok(diagnostics.some(item => item.code === 'kotTestToolkit.unknownStep'));
});

test('probable missing step quotes use the missing-quotes diagnostic code', async () => {
    const candidate = {
        ...definition('builtInStep'),
        template: 'And I choose "%1 Value"',
        normalizedTemplate: 'And I choose "%1 Value"'
    };
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'missing', invocation: 'And I choose value' }),
        getView: async () => ({
            identity: 'quoted-candidate',
            all: [candidate],
            byId: new Map(),
            byNormalizedTemplate: new Map()
        })
    });
    const document = documentWithLine('And I choose value');

    await provider.validateDocument(document, fullValidation);

    const diagnostics = published.get(document.uri.toString()) ?? [];
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'kotTestToolkit.missingQuotes');
});

test('does not publish diagnostics whose codes are ignored in configuration', async () => {
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'missing', invocation: 'And missing "value"' }),
        getView: async () => ({ identity: 'empty', all: [], byId: new Map(), byNormalizedTemplate: new Map() })
    }, ['kotTestToolkit.unknownStep']);
    const document = documentWithLine('And missing "value"');

    await provider.validateDocument(document, {
        includeSuggestions: false,
        includeStepChecks: true,
        includeStepSuggestions: false,
        includeScenarioSuggestions: false
    });

    const diagnostics = published.get(document.uri.toString()) ?? [];
    assert.equal(diagnostics.some(item => item.code === 'kotTestToolkit.unknownStep'), false);
});

test('reapplies changed ignored diagnostic codes without validating the document again', async () => {
    const ignoredDiagnosticCodes: string[] = [];
    const { provider, published } = createProvider({
        resolve: async () => ({ kind: 'missing', invocation: 'And missing "value"' }),
        getView: async () => ({ identity: 'empty', all: [], byId: new Map(), byNormalizedTemplate: new Map() })
    }, ignoredDiagnosticCodes);
    const document = documentWithLine('And missing "value"');

    await provider.validateDocument(document, {
        includeSuggestions: false,
        includeStepChecks: true,
        includeStepSuggestions: false,
        includeScenarioSuggestions: false
    });
    assert.equal((published.get(document.uri.toString()) ?? []).length, 1);

    ignoredDiagnosticCodes.push('kotTestToolkit.unknownStep');
    provider.republishDiagnostics();
    assert.equal((published.get(document.uri.toString()) ?? []).length, 0);

    ignoredDiagnosticCodes.length = 0;
    provider.republishDiagnostics();
    assert.equal((published.get(document.uri.toString()) ?? []).length, 1);
});

test('similarity lookup stops when the request is cancelled', async () => {
    const token = { isCancellationRequested: false };
    const candidate = definition('builtInStep');
    const { provider } = createProvider({
        getView: async () => {
            token.isCancellationRequested = true;
            return { identity: 'cancelled', all: [candidate], byId: new Map(), byNormalizedTemplate: new Map() };
        }
    });
    const document = documentWithLine('And missing "value"');
    const diagnostic = new Diagnostic(new Range(1, 4, 1, 23), 'Unknown', 0);
    diagnostic.source = 'KOT for 1C';
    diagnostic.code = 'kotTestToolkit.unknownStep';

    const actions = await provider.provideCodeActions(
        document,
        diagnostic.range,
        { diagnostics: [diagnostic] },
        token
    );

    assert.equal(actions.length, 0);
});

test('unknown invocation offers both creation commands with a serializable seed', async () => {
    const { provider } = createProvider({
        getView: async () => ({ identity: 'empty', all: [], byId: new Map(), byNormalizedTemplate: new Map() })
    });
    const document = documentWithLine('And missing "value"');
    const diagnostic = new Diagnostic(new Range(1, 4, 1, 23), 'Unknown', 0);
    diagnostic.source = 'KOT for 1C';
    diagnostic.code = 'kotTestToolkit.unknownStep';

    const actions = await provider.provideCodeActions(
        document,
        diagnostic.range,
        { diagnostics: [diagnostic] },
        { isCancellationRequested: false }
    );
    const creationActions = actions.filter(action => action.command?.command.startsWith('kotTestToolkit.create'));

    assert.deepEqual(
        Array.from(creationActions, action => action.command?.command).sort(),
        ['kotTestToolkit.createExportScenario', 'kotTestToolkit.createUserStep']
    );
    for (const action of creationActions) {
        const seed = action.command?.arguments?.[0] as Record<string, unknown>;
        assert.equal(seed.invocation, 'And missing "value"');
        assert.equal(seed.language, 'en');
        assert.equal(seed.documentUri, 'file:///repo/scenario.yaml');
        assert.deepEqual(JSON.parse(JSON.stringify(seed.range)), {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 23 }
        });
        assert.doesNotThrow(() => JSON.stringify(seed));
    }
});
