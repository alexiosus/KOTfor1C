import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as syntax from '../src/scenarioCompilerSyntax';
import * as parameters from '../src/scenarioParameterUtils';
import * as yaml from '../src/scenarioYamlDocument';
import * as blockKeywords from '../src/blockKeywordParser';
import * as headerFields from '../src/yamlHeaderFields';
import * as phaseMetadata from '../src/phaseSwitcherMetadata';
import type * as vscode from 'vscode';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
class Position { constructor(public line: number, public character: number) {} }
class Range { constructor(public start: Position, public end: Position) {} }
class MarkdownString {
    value = '';
    appendMarkdown(value: string): this { this.value += value; return this; }
    appendCodeblock(value: string): this { this.value += value; return this; }
}
const edits: Array<{ range: Range; text: string }> = [];
const host = {
    Position, Range, MarkdownString,
    WorkspaceEdit: class { replace(_uri: unknown, range: Range, text: string): void { edits.push({ range, text }); } },
    InlayHint: class { constructor(public position: Position, public label: string) {} }, InlayHintKind: { Type: 1 },
    InlayHintLabelPart: class { constructor(public value: string) {} },
    SemanticTokensLegend: class { constructor(public types: string[]) {} },
    SemanticTokens: class { constructor(public data: Uint32Array) {} },
    SemanticTokensBuilder: class {
        tokens: number[][] = [];
        push(...value: number[]): void { this.tokens.push(value); }
        build(): number[][] { return this.tokens; }
    },
    EventEmitter: class { event = () => undefined; },
    l10n: { t: (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '') },
    workspace: { applyEdit: async () => true, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    window: { showErrorMessage: (message: string) => { throw new Error(message); } }
};

function load(file: string, extra: Record<string, unknown> = {}): any {
    const module = { exports: {} };
    const dependencies: Record<string, unknown> = {
        vscode: host, './scenarioCompilerSyntax': syntax, './scenarioParameterUtils': parameters,
        './scenarioYamlDocument': yaml, './blockKeywordParser': blockKeywords,
        './localization': { getTranslator: async () => host.l10n.t }, './appContext': { getExtensionUri: () => null },
        './phaseSwitcherMetadata': phaseMetadata,
        './projectLibraryIntegration': { projectedProjectScenario: () => null },
        './yamlHeaderFields': headerFields, ...extra
    };
    if (file !== 'yamlValidator.ts' && !extra['./yamlValidator']) {
        dependencies['./yamlValidator'] = load('yamlValidator.ts');
    }
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name] ?? {}, console });
    return module.exports;
}

function document(source: string): vscode.TextDocument {
    const lines = source.split('\n');
    return {
        languageId: 'yaml', fileName: '/repo/scen.yaml', lineCount: lines.length, getText: () => source,
        uri: { toString: () => 'file:///repo/scen.yaml' },
        lineAt: (line: number) => ({ text: lines[line] }),
        positionAt: (offset: number) => {
            const prefix = source.slice(0, offset).split('\n');
            return new Position(prefix.length - 1, prefix.at(-1)!.length);
        }
    } as unknown as vscode.TextDocument;
}

test('refilling parameters preserves tables without importing return variable aliases or commented parameters', async () => {
    edits.length = 0;
    const source = 'ПараметрыСценария:\n' +
        '    - ПараметрыСценария1:\n        Имя: "Rows"\n        Значение: |\n            | Name |\n            | A;B |\n        ТипПараметра: "Таблица"\n        ИсходящийПараметр: "Yes"\n' +
        'ТекстСценария: |\n    /*\n    And Ignored [Ignore]\n    */\n    And Child\n        Rows = [Rows]\n        Return Result as Saved\n';
    const commands = load('commandHandlers.ts');
    assert.deepEqual(Array.from(commands.parseCalledScenariosFromScriptBody(source)), ['Child']);
    assert.deepEqual(Array.from(commands.parseUsedParametersFromScriptBody(source)), ['Rows']);
    assert.equal(await commands.clearAndFillScenarioParameters(document(source), true), true);
    assert.equal(edits.length, 1);
    const text = edits[0].text;
    assert.ok(text.includes('Значение: |\n            | Name |\n            | A;B |'));
    assert.ok(text.includes('ИсходящийПараметр: "Да"'));
    assert.ok(!text.includes('Имя: "Saved"'));
    assert.ok(!text.includes('Ignore'));
});

test('process header hints expose settings and distinct name and code editors without scenario actions', () => {
    const Provider = load('scenarioHeaderInlayHintsProvider.ts').ScenarioHeaderInlayHintsProvider;
    const source = [
        'ТипФайла: "Процесс"',
        'ДанныеПроцесса:',
        '    Имя: "Продажи"',
        '    Код: "001"',
        '    ФункцияСистемы: "Продажи"',
        '    UIDФункцияСистемы: "function"',
        'KOTМетаданные:',
        '    Описание: "Процесс продаж"',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: "Currency"',
        '        Значение: "USD;EUR"'
    ].join('\n');
    const processDocument = document(source);
    const hints = new Provider().provideInlayHints(processDocument, {}, {});

    const actions = Array.from(hints).filter((hint: any) => Array.isArray(hint.label)) as any[];
    assert.deepEqual(actions.map(hint => [hint.position.line, hint.label[0].command.command]), [
        [0, 'kotTestToolkit.openProcessTestSettingsFromEditor'],
        [0, 'kotTestToolkit.changeScenarioGroup'],
        [2, 'kotTestToolkit.renameProcessFromEditor'],
        [2, 'kotTestToolkit.openProjectMetadata'],
        [3, 'kotTestToolkit.changeProcessCodeFromEditor']
    ]);
    for (const hint of actions) {
        assert.equal(hint.label[0].command.arguments?.[0], processDocument.uri);
    }
    const variants = Array.from(hints).find((hint: any) => typeof hint.label === 'string') as any;
    assert.equal(variants, undefined);
});

test('scenario header actions use shared main classification without legacy KOT metadata', () => {
    const Provider = load('scenarioHeaderInlayHintsProvider.ts', {
        './projectLibraryIntegration': { projectedProjectScenario: () => ({ tabName: 'Shared group' }) }
    }).ScenarioHeaderInlayHintsProvider;
    const source = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Sales"\n    Код: "Sales"\n';
    const hints = new Provider().provideInlayHints(document(source), {}, {});
    const commands = Array.from(hints).filter((hint: any) => Array.isArray(hint.label))
        .map((hint: any) => hint.label[0].command.command);
    assert.ok(commands.includes('kotTestToolkit.openMainScenarioTestSettingsFromEditor'));
    assert.ok(commands.includes('kotTestToolkit.renameScenarioFromEditor'));
    assert.ok(commands.includes('kotTestToolkit.openProjectMetadata'));
    assert.ok(commands.includes('kotTestToolkit.changeScenarioGroup'));
    assert.ok(commands.includes('kotTestToolkit.generateScenarioDescriptionWithAi'));
    assert.ok(!commands.includes('kotTestToolkit.changeNestedScenarioName'));
});

test('process test settings hints link process fields and reuse base and user pickers', () => {
    const Provider = load('scenarioHeaderInlayHintsProvider.ts').ScenarioHeaderInlayHintsProvider;
    const source = [
        'ТипФайла: "НастройкаПроцесса"',
        'ДанныеТеста:',
        '    Код: "001"',
        '    Имя: "Продажи"',
        '    UIDПроцесса: "process"',
        '    ПроцессНаименование: "Продажи"',
        '    ЭталоннаяБазаИмя: "Drive"',
        '    ИдентификаторБазы: "base-id"',
        '    ПрофильПользователя: "Tester"'
    ].join('\n');
    const settingsDocument = document(source);
    const hints = new Provider().provideInlayHints(settingsDocument, {}, {});

    assert.deepEqual(Array.from(hints, (hint: any) => [hint.position.line, hint.label[0].command.command]), [
        [2, 'kotTestToolkit.changeProcessTestSettingsFromEditor'],
        [3, 'kotTestToolkit.changeProcessTestSettingsFromEditor'],
        [4, 'kotTestToolkit.changeProcessTestSettingsFromEditor'],
        [5, 'kotTestToolkit.changeProcessTestSettingsFromEditor'],
        [6, 'kotTestToolkit.changeTestSettingsEtalonBaseFromEditor'],
        [7, 'kotTestToolkit.changeTestSettingsEtalonBaseFromEditor'],
        [8, 'kotTestToolkit.changeTestSettingsUserProfileFromEditor']
    ]);
    for (const hint of hints.slice(0, 4)) {
        assert.equal(hint.label[0].command.arguments?.[0], settingsDocument.uri);
    }
});

test('scenario header hints preserve main scenario and test settings actions with the real validator', () => {
    const Provider = load('scenarioHeaderInlayHintsProvider.ts').ScenarioHeaderInlayHintsProvider;
    const main = [
        'ТипФайла: "Сценарий"',
        'ДанныеСценария:',
        '    Имя: "Оплата"',
        '    Код: "001"',
        'KOTМетаданные:',
        '    PhaseSwitcher:',
        '        Tab: "Продажи"'
    ].join('\n');
    const mainHints = new Provider().provideInlayHints(document(main), {}, {});
    assert.deepEqual(Array.from(mainHints, (hint: any) => hint.label[0].command.command), [
        'kotTestToolkit.openMainScenarioTestSettingsFromEditor',
        'kotTestToolkit.changeScenarioGroup',
        'kotTestToolkit.renameScenarioFromEditor',
        'kotTestToolkit.openProjectMetadata',
        'kotTestToolkit.renameScenarioFromEditor',
        'kotTestToolkit.generateScenarioDescriptionWithAi'
    ]);

    const settings = 'ТипФайла: "НастройкаТеста"\nДанныеТеста:\n    UIDСценария: "scenario"\n';
    const settingsHints = new Provider().provideInlayHints(document(settings), {}, {});
    assert.equal(settingsHints.length, 1);
    assert.equal(settingsHints[0].label[0].command.command, 'kotTestToolkit.changeTestSettingsScenarioFromEditor');
});

test('process YAML keeps compiler Gherkin semantic tokens disabled', () => {
    const Provider = load('scenarioSyntaxHighlightProvider.ts').ScenarioSyntaxHighlightProvider;
    const source = 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    Имя: "Продажи"\nТекстСценария: |\n    And ready\n';
    const tokens = new Provider().provideDocumentSemanticTokens(document(source));
    assert.equal(tokens.data.length, 0);
});

test('refill preserves compiler escape spelling and unused outgoing parameter defaults', async () => {
    edits.length = 0;
    const source = 'ПараметрыСценария:\n' +
        '    - ПараметрыСценария1:\n        Имя: "Text"\n        Значение: "a\\;b;c"\n        ТипПараметра: "Строка"\n' +
        '    - ПараметрыСценария2:\n        Имя: "Result"\n        Значение: "42"\n        ИсходящийПараметр: "Да"\n' +
        'ТекстСценария: |\n    And I use [Text]\n';
    const commands = load('commandHandlers.ts');
    assert.equal(await commands.clearAndFillScenarioParameters(document(source), true), true);
    const emitted = 'ПараметрыСценария:\n' + edits[0].text;
    assert.ok(emitted.includes('Значение: "a\\;b;c"'));
    assert.equal(parameters.parseScenarioParameterDefinitions(emitted).get('Text')!.value, 'a\\;b;c');
    assert.equal(parameters.buildScenarioVariantPreview(emitted).count, '2');
    assert.equal(parameters.parseScenarioParameterDefinitions(emitted).get('Result')!.value, '42');
    assert.equal(parameters.parseScenarioParameterDefinitions(emitted).get('Result')!.outgoing, true);
});

test('refill preserves literal default source, spaces and blank rows in LF and CRLF', async () => {
    for (const eol of ['\n', '\r\n']) {
        for (const defaultSource of [
            '"  literal  "',
            '"C:\\\\temp"',
            '|\n            hello\n              world  \n            ',
            '|\n            ',
            '|2-\n              hello\n              world',
            '|+\n            hello\n            \n            '
        ]) {
            edits.length = 0;
            const source = ('ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Text"\n' +
                `        Значение: ${defaultSource}\n        ТипПараметра: "Строка"\n` +
                'ТекстСценария: |\n    And I use [Text]\n').replace(/\n/g, eol);
            const before = parameters.parseScenarioParameterDefinitions(source).get('Text')!;
            const commands = load('commandHandlers.ts');
            assert.equal(await commands.clearAndFillScenarioParameters(document(source), true), true);
            const emitted = `ПараметрыСценария:${eol}` + edits[0].text;
            assert.ok(emitted.includes(`Значение: ${defaultSource.replace(/\n/g, eol)}`), JSON.stringify({ defaultSource, emitted }));
            assert.equal(parameters.parseScenarioParameterDefinitions(emitted).get('Text')!.value, before.value, JSON.stringify({ eol, defaultSource, emitted }));
        }
    }
});

test('parameter alignment continues after tables and returns and ignores block comments', () => {
    const commands = load('commandHandlers.ts');
    const body = '/*\nAnd Fake\n    A= "fake"\n*/\nAnd Child\n    Rows=\n        | Name |\n    Return Result as Saved\n    Currency= "USD"';
    const aligned = commands.alignNestedScenarioCallParametersInText(body, '\n', new Set(['child']));
    assert.ok(aligned.includes('    Rows     = \n        | Name |'));
    assert.ok(aligned.includes('    Currency = "USD"'));
    assert.ok(aligned.includes('Return Result as Saved'));
    assert.ok(aligned.includes('    A= "fake"'));
});

test('header hint shows bounded compiler variants and the preview', () => {
    const Provider = load('scenarioHeaderInlayHintsProvider.ts').ScenarioHeaderInlayHintsProvider;
    const source = 'ТипФайла: "Сценарий"\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Currency"\n        Значение: "USD;EUR"\n';
    const hints = new Provider().provideInlayHints(document(source), {}, {});
    assert.equal(hints[0].label, 'Variants: 2');
    assert.equal(hints[0].position.line, 1);
    assert.ok(hints[0].tooltip.value.includes('Currency = USD'));
    assert.ok(hints[0].tooltip.value.includes('Currency = EUR'));
});

test('semantic tokens distinguish preprocessor, return keywords and block comments', () => {
    const Provider = load('scenarioSyntaxHighlightProvider.ts').ScenarioSyntaxHighlightProvider;
    const source = 'ТипФайла: "Сценарий"\nТекстСценария: |\n    /*\n    EndDo\n    */\n    #Если Истина Тогда\n    #КонецЕсли\n    Return Result';
    const tokens = new Provider().provideDocumentSemanticTokens(document(source)) as number[][];
    assert.ok(tokens.some(token => token[0] === 3 && token[3] === 0));
    assert.ok(tokens.some(token => token[0] === 5 && token[3] === 5));
    assert.ok(tokens.some(token => token[0] === 6 && token[3] === 5));
    assert.ok(tokens.some(token => token[0] === 7 && token[3] === 5));
});

test('native SPPR scripts retain parameter decoration offsets in steps and tables without a YAML wrapper', async () => {
    const api = load('scenarioSyntaxHighlightProvider.ts', { './spprScenarioFiles.js': { readNativeScenarioMetadata: async () => ({ text: 'ТипФайла: Сценарий' }) } });
    const source = 'And I use "[Amount]"\n| [Amount] |\n// [Ignored]\n';
    const native = { ...document(source), languageId: 'feature', fileName: '/repo/scen.feature' };
    const tokens = await new api.ScenarioSyntaxHighlightProvider().provideDocumentSemanticTokens(native);
    assert.ok(tokens.some((token: number[]) => token[0] === 0 && token[3] === 5));
    const ranges = api.collectScenarioBracketParameterRanges(native, true);
    assert.deepEqual(Array.from(ranges, (range: Range) => [range.start.line, range.start.character, range.end.character]), [[0, 11, 19], [1, 2, 10]]);
    assert.equal(api.collectScenarioBracketParameterRanges(native).length, 0);
});
