import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import type * as vscode from 'vscode';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');

function scenarioDocument(languageId = 'feature'): vscode.TextDocument {
    return {
        uri: { fsPath: '/repo/nested/scen.yaml', toString: () => 'file:///repo/nested/scen.yaml' },
        fileName: '/repo/nested/scen.yaml',
        languageId,
        isUntitled: false,
        isClosed: false,
        getText: () => 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Nested call"\nТекстСценария: |\n    And ready\n'
    } as unknown as vscode.TextDocument;
}

function languageHarness() {
    const switchedDocuments: vscode.TextDocument[] = [];
    const host = {
        window: { visibleTextEditors: [] as Array<{ document: vscode.TextDocument }> },
        languages: {
            setTextDocumentLanguage: async (document: vscode.TextDocument, languageId: string) => {
                assert.equal(languageId, 'yaml');
                switchedDocuments.push(document);
                return { ...document, languageId };
            }
        }
    };
    const validatorModule = { exports: {} as Record<string, (document: vscode.TextDocument) => boolean> };
    const compile = (source: string) => ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    vm.runInNewContext(compile(fs.readFileSync(path.join(process.cwd(), 'src/yamlValidator.ts'), 'utf8')), {
        module: validatorModule,
        exports: validatorModule.exports,
        require: () => host
    });

    // Exercise the activation helper without activating unrelated extension services.
    const source = fs.readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8');
    const parsed = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.ES2022, true);
    const helper = parsed.statements.find(statement =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'ensureScenarioYamlLanguage'
    );
    assert.ok(helper);
    const ensureLanguage = vm.runInNewContext(
        compile(`${helper.getText(parsed)}\nensureScenarioYamlLanguage;`),
        {
            vscode: host,
            isScenarioYamlFile: validatorModule.exports.isScenarioYamlFile,
            isCompilerYamlFile: validatorModule.exports.isCompilerYamlFile,
            console
        }
    ) as (document: vscode.TextDocument) => Promise<void>;

    let visibilityListener: ts.ArrowFunction | undefined;
    const findVisibilityListener = (node: ts.Node): void => {
        if (ts.isCallExpression(node)
            && node.expression.getText(parsed) === 'vscode.window.onDidChangeVisibleTextEditors'
            && ts.isArrowFunction(node.arguments[0])) {
            visibilityListener = node.arguments[0];
        }
        ts.forEachChild(node, findVisibilityListener);
    };
    findVisibilityListener(parsed);
    assert.ok(visibilityListener);
    const visibleEditorsChanged = vm.runInNewContext(
        compile(`const listener = ${visibilityListener.getText(parsed)};\nlistener;`),
        {
            vscode: host,
            ensureScenarioYamlLanguage: ensureLanguage,
            updateKotDescriptionDecorationsForVisibleEditors: () => undefined,
            updateScenarioPlainTextDecorationsForVisibleEditors: () => undefined,
            updateScenarioBracketParameterDecorationsForVisibleEditors: () => undefined,
            kotDescriptionTextDecorationType: {},
            scenarioPlainTextDecorationType: {},
            scenarioBracketParameterDecorationType: {}
        }
    ) as () => void;

    return { host, ensureLanguage, switchedDocuments, visibleEditorsChanged };
}

test('definition previews do not switch hidden YAML models out of their configured language', async () => {
    const { ensureLanguage, switchedDocuments } = languageHarness();

    // A preview releases its model reference; resolving it again restores the
    // configured *.yaml -> feature association with a new TextDocument instance.
    for (let preview = 0; preview < 20; preview++) {
        await ensureLanguage(scenarioDocument());
    }

    assert.equal(switchedDocuments.length, 0);
});

test('visible process and both compiler test settings enable native YAML highlighting', async () => {
    for (const type of ['Процесс', 'НастройкаТеста', 'НастройкаПроцесса']) {
        const { host, ensureLanguage, switchedDocuments } = languageHarness();
        const document = { ...scenarioDocument(), getText: () => `ТипФайла: "${type}"\n` };
        host.window.visibleTextEditors = [{ document }];

        await ensureLanguage(document);

        assert.deepEqual(switchedDocuments, [document], type);
    }
});

test('hidden process previews keep their configured language', async () => {
    const { ensureLanguage, switchedDocuments } = languageHarness();
    const document = { ...scenarioDocument(), getText: () => 'ТипФайла: "Процесс"\n' };

    await ensureLanguage(document);

    assert.equal(switchedDocuments.length, 0);
});

test('opening a scenario in a visible editor still enables YAML highlighting', async () => {
    const { host, ensureLanguage, switchedDocuments } = languageHarness();
    const document = scenarioDocument();
    host.window.visibleTextEditors = [{ document }];

    await ensureLanguage(document);

    assert.deepEqual(switchedDocuments, [document]);
});

test('a stale preview document cannot switch the visible document with the same URI', async () => {
    const { host, ensureLanguage, switchedDocuments } = languageHarness();
    host.window.visibleTextEditors = [{ document: scenarioDocument('yaml') }];

    await ensureLanguage(scenarioDocument());

    assert.equal(switchedDocuments.length, 0);
});

test('a scenario shown beside the focused editor switches language when it becomes visible', async () => {
    const { host, ensureLanguage, switchedDocuments, visibleEditorsChanged } = languageHarness();
    const document = scenarioDocument();
    await ensureLanguage(document);
    assert.equal(switchedDocuments.length, 0);

    // preserveFocus: true only fires the visible-editor event, not an active-editor change.
    host.window.visibleTextEditors = [{ document }];
    visibleEditorsChanged();

    assert.deepEqual(switchedDocuments, [document]);
});

test('visible YAML scenarios and ordinary YAML files keep their language', async () => {
    const { host, ensureLanguage, switchedDocuments } = languageHarness();
    const yamlScenario = scenarioDocument('yaml');
    const ordinaryYaml = { ...scenarioDocument(), getText: () => 'setting: value\n' };
    host.window.visibleTextEditors = [{ document: yamlScenario }, { document: ordinaryYaml }];

    await ensureLanguage(yamlScenario);
    await ensureLanguage(ordinaryYaml);

    assert.equal(switchedDocuments.length, 0);
});
