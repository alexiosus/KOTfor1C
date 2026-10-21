import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as yamlLibrary from 'yaml';
import * as compilerFormat from '../src/compilerFormatDiagnostics';
import * as parameters from '../src/scenarioParameterUtils';
import * as syntax from '../src/scenarioCompilerSyntax';
import * as yaml from '../src/scenarioYamlDocument';
import * as tableUtils from '../src/gherkinTableUtils';
import type * as vscode from 'vscode';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');

function harness(source: string) {
    const formatters: vscode.DocumentFormattingEditProvider[] = [];
    let beforeSave: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined; let alignment = true;
    const document = {
        text: source, languageId: 'yaml', fileName: '/repo/scenario.yaml',
        uri: { scheme: 'file', toString: () => 'file:///repo/scenario.yaml' },
        getText() { return this.text; },
        positionAt(offset: number) { return { offset }; }
    };
    class Range { constructor(readonly start: { offset: number }, readonly end: { offset: number }) {} }
    class WorkspaceEdit {
        replacements: Array<{ range: Range; text: string }> = [];
        replace(_uri: unknown, range: Range, text: string) { this.replacements.push({ range, text }); }
    }
    const snippets: string[] = [];
    const host = {
        Range, WorkspaceEdit, SnippetString: class { constructor(readonly value: string) {} },
        TextEdit: { replace: (range: Range, text: string) => ({ range, newText: text }) },
        languages: { registerDocumentFormattingEditProvider: (_selector: unknown, provider: vscode.DocumentFormattingEditProvider) => { formatters.push(provider); return { dispose() {} }; } },
        window: {
            showErrorMessage(message: string) { throw new Error(message); },
            showWarningMessage(message: string) { throw new Error(message); }
        },
        workspace: {
            getConfiguration: () => ({ get: () => alignment }),
            onWillSaveTextDocument: (handler: typeof beforeSave) => { beforeSave = handler; return { dispose() {} }; },
            async applyEdit(edit: WorkspaceEdit) {
                for (const replacement of [...edit.replacements].sort((left, right) => right.range.start.offset - left.range.start.offset)) {
                    document.text = document.text.slice(0, replacement.range.start.offset)
                        + replacement.text + document.text.slice(replacement.range.end.offset);
                }
                return true;
            }
        }
    };
    function load(file: string, dependencies: Record<string, unknown>) {
        const module = { exports: {} as any };
        vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText, { module, exports: module.exports, console, require: (name: string) => dependencies[name] ?? {} });
        return module.exports;
    }
    const validator = load('yamlValidator.ts', { vscode: host, yaml: yamlLibrary, './compilerFormatDiagnostics': compilerFormat });
    const commands = load('commandHandlers.ts', {
        vscode: host, './scenarioParameterUtils': parameters, './scenarioCompilerSyntax': syntax, './gherkinTableUtils': tableUtils,
        './scenarioYamlDocument': yaml, './yamlValidator.js': validator,
        './localization': { getTranslator: async () => (message: string) => message },
        './appContext': { getExtensionUri: () => null }
    }) as typeof import('../src/commandHandlers');
    const editor = {
        document,
        async insertSnippet(snippet: { value: string }) { snippets.push(snippet.value); return true; }
    } as unknown as vscode.TextEditor;
    return { commands, document: document as unknown as vscode.TextDocument, editor, snippets,
        formatters, beforeSave: (event: vscode.TextDocumentWillSaveEvent) => beforeSave?.(event), configureAlignment: (enabled: boolean) => { alignment = enabled; },
        setText(value: string) { document.text = value; } };
}

test('Feature table formatting is available explicitly and before save, respecting the auto-alignment setting', async () => {
    const h = harness('Feature: Own\nScenario: Own\n  And table\n    | A | Value |\n    | Longer | 1 |\n');
    Object.assign(h.document, { languageId: 'feature', fileName: '/repo/own.feature' });
    assert.equal(await h.commands.alignGherkinTables(h.document), true);
    assert.ok(h.document.getText().includes('| A      | Value |'));
    const register = (h.commands as any).registerGherkinTableFormatting;
    assert.equal(typeof register, 'function');
    register({ subscriptions: [] }); assert.equal(h.formatters.length, 1);
    h.setText('Feature: Own\nScenario: Own\n  And table\n    | A | Value |\n    | Longer | 1 |\n');
    let pending: Thenable<readonly vscode.TextEdit[]> | undefined;
    h.beforeSave({ document: h.document, waitUntil: (value: typeof pending) => { pending = value; } } as vscode.TextDocumentWillSaveEvent);
    assert.equal((await pending)?.length, 1);
    h.configureAlignment(false); pending = undefined;
    h.beforeSave({ document: h.document, waitUntil: (value: typeof pending) => { pending = value; } } as vscode.TextDocumentWillSaveEvent);
    assert.equal(pending, undefined);
});

test('inserting a scenario parameter emits compiler flags and valid choices with or without an existing section', async () => {
    for (const suffix of ['', 'ПараметрыСценария:\n']) {
        const h = harness(`ТипФайла: "Сценарий"\n${suffix}`);
        await h.commands.insertScenarioParamHandler(h.editor, {} as vscode.TextEditorEdit);
        assert.equal(h.snippets.length, 1);
        const emitted = h.snippets[0];
        assert.ok(emitted.includes('ТипПараметра: "${4|Строка,Число,Булево,Массив,Дата|}"'));
        assert.ok(emitted.includes('ИсходящийПараметр: "${5|Нет,Да|}"'));
        assert.ok(!emitted.includes('\t'));
        const defaultText = emitted.replace(/\$\{\d+\|([^|]*)\|\}/gu, (_match, choices: string) => choices.split(',')[0]).replace(/\$\d+/gu, '');
        const parsed = yamlLibrary.parseDocument(defaultText);
        assert.deepEqual(parsed.errors, []);
        const record = Object.values(parsed.toJS()[0])[0] as Record<string, unknown>;
        assert.equal(record.ИсходящийПараметр, 'Нет');
    }
});

test('refilling newly discovered parameters emits Нет and retains it in the session cache', async () => {
    const source = 'ТипФайла: "Сценарий"\nПараметрыСценария:\nТекстСценария: |\n    And I use [Currency]\n';
    const h = harness(source);
    assert.equal(await h.commands.clearAndFillScenarioParameters(h.document, true), true);
    let record = yaml.ScenarioYamlDocument.parse(h.document.getText()).readRecords('ПараметрыСценария')[0];
    assert.equal(record.fields.get('ИсходящийПараметр'), 'Нет');
    assert.equal(record.fields.get('Значение'), 'Currency');
    const definition = parameters.parseScenarioParameterDefinitions(h.document.getText()).get('Currency')!;
    assert.equal(definition.outgoing, false);
    assert.equal(await h.commands.clearAndFillScenarioParameters(h.document, true), false);
    h.setText(source);
    assert.equal(await h.commands.clearAndFillScenarioParameters(h.document, true), true);
    record = yaml.ScenarioYamlDocument.parse(h.document.getText()).readRecords('ПараметрыСценария')[0];
    assert.equal(record.fields.get('ИсходящийПараметр'), 'Нет');
});

test('refilling preserves outgoing semantics and defaults while canonicalizing recognized flags', async () => {
    for (const [flag, expected, outgoing] of [
        ['"Yes"', 'Да', true], ['"Да"', 'Да', true], ['true', 'Да', true],
        ['"No"', 'Нет', false], ['"Нет"', 'Нет', false], ['false', 'Нет', false],
        ['', 'Нет', false], ['""', 'Нет', false], ['"custom"', 'custom', false]
    ] as const) {
        const source = 'ТипФайла: "Сценарий"\nПараметрыСценария:\n    - ПараметрыСценария1:\n'
            + '        Имя: "Rows"\n        Значение: |\n            | Name | Value |\n            | A;B | 10 |\n'
            + '        ТипПараметра: "Таблица"\n'
            + (flag ? `        ИсходящийПараметр: ${flag}\n` : '')
            + 'ТекстСценария: |\n    And I use [Rows]\n';
        const h = harness(source);
        await h.commands.clearAndFillScenarioParameters(h.document, true);
        const emitted = h.document.getText();
        const record = yaml.ScenarioYamlDocument.parse(emitted).readRecords('ПараметрыСценария')[0];
        assert.equal(record.fields.get('ИсходящийПараметр'), expected, flag);
        assert.equal(record.fields.get('ТипПараметра'), 'Таблица');
        assert.ok(emitted.includes('Значение: |\n            | Name | Value |\n            | A;B | 10 |\n'));
        assert.equal(parameters.parseScenarioParameterDefinitions(emitted).get('Rows')!.outgoing, outgoing);
    }
});
