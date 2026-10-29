import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import type * as vscode from 'vscode';
import { getGherkinInsertionContext } from '../src/gherkinInsertionContext';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
function harness() {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8');
    const parsed = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.ES2022, true);
    const names = new Set(['isFeatureDocument', 'isInScenarioTextBlockForAutoSuggest', 'getQuotedTextContextForAutoSuggest', 'shouldAutoTriggerFormExplorerQuotedSuggest']);
    const constants = new Set(['GHERKIN_STEP_LINE_REGEX', 'FEATURE_SCENARIO_HEADER_REGEX', 'FEATURE_SCENARIO_BLOCK_BREAK_REGEX', 'FEATURE_NON_STEP_LINE_REGEX', 'FORM_EXPLORER_SUGGEST_RELEVANT_LINE_REGEX']);
    const declarations = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text ?? '')
        || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => constants.has(declaration.name.getText(parsed))));
    const scope = {
        getGherkinInsertionContext,
        isScenarioYamlFile: (document: vscode.TextDocument) => /ТипФайла: Сценарий/u.test(document.getText()),
        readNativeScenarioMetadata: async (uri: vscode.Uri) => uri.fsPath === '/repo/native/scen.feature' ? { text: 'ТипФайла: Сценарий\n' } : undefined,
        vscode: { Position: class { constructor(public line: number, public character: number) {} }, Range: class { constructor(public start: vscode.Position, public end: vscode.Position) {} } }
    };
    return vm.runInNewContext(ts.transpileModule(declarations.map(node => node.getText(parsed)).join('\n') + '\nshouldAutoTriggerFormExplorerQuotedSuggest;', {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, scope) as (document: vscode.TextDocument, position: vscode.Position) => boolean | Promise<boolean>;
}
function target(fileName: string, marked: string) {
    const offset = marked.indexOf('¦'); const text = marked.replace('¦', ''); const lines = text.split('\n');
    const prefix = text.slice(0, offset).split('\n'); const position = { line: prefix.length - 1, character: prefix.at(-1)!.length } as vscode.Position;
    const document = { fileName, uri: { fsPath: fileName, toString: () => `file://${fileName}` }, languageId: fileName.endsWith('.feature') ? 'feature' : 'yaml',
        getText: (range?: vscode.Range) => range ? text.slice(0, offset) : text,
        lineAt: (line: number) => ({ text: lines[line] }) } as unknown as vscode.TextDocument;
    return { document, position };
}
for (const [fileName, text] of [
    ['/repo/native/scen.feature', '#language: en\nAnd I click "¦" button'],
    ['/repo/russian.feature', '#language: ru\nФункционал: Демо\nСценарий: Проверка\n    И я нажимаю \"¦\" кнопку'],
    ['/repo/standalone.feature', '#language: en\nFeature: Demo\nScenario: Test\n    And I click "¦" button'],
    ['/repo/scen.yaml', 'ТипФайла: Сценарий\nТекстСценария: |\n    And I click "¦" button']
]) {
    test(`form argument caret requests suggestions in ${fileName}`, async () => {
        const { document, position } = target(fileName, text);
        assert.equal(await harness()(document, position), true);
    });
}
for (const text of [
    'Feature: Demo\nScenario: Test\n    """\n    And I click "¦" button\n    """',
    'Feature: Demo\nScenario: Test\n    # And I click "¦" button',
    'Feature: Demo\nAnd I click "¦" button'
]) {
    test(`form suggestions stay out of non-executable text: ${JSON.stringify(text)}`, async () => {
        const { document, position } = target('/repo/standalone.feature', text);
        assert.equal(await harness()(document, position), false);
    });
}
