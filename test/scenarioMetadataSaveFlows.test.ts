import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as phaseMetadata from '../src/phaseSwitcherMetadata';

function harness(source: string, autoMigrate = false) {
    const ts = require('typescript') as typeof import('typescript');
    const sourceFile = ts.createSourceFile('extension.ts', fs.readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
    let save: import('typescript').Expression | undefined;
    let repair: import('typescript').Expression | undefined;
    const visit = (node: import('typescript').Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'onDidSaveTextDocument') {
            save = node.arguments[0];
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'runScenarioRepairBatch') {
            repair = node.initializer;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    assert.ok(save && repair);
    let saves = 0;
    const errors: unknown[] = [];
    const uri = { scheme: 'file', fsPath: '/repo/tests/scen.yaml', toString: () => 'file:///repo/tests/scen.yaml' };
    const document = {
        uri, languageId: 'yaml', fileName: uri.fsPath, text: source, isDirty: false,
        getText() { return this.text; }, positionAt(offset: number) { return { offset }; },
        async save() { saves++; return true; }
    };
    class WorkspaceEdit {
        text?: string;
        replace(_uri: unknown, _range: unknown, text: string) { this.text = text; }
    }
    const savedSnapshots = new Map();
    const state = {
        permitsNativeScenario: () => false, hasKotInteraction: () => false, assertKotPath: async (_file: string) => {}, ...phaseMetadata, console: { ...console, error: (...values: unknown[]) => { errors.push(values); } },
        context: { extensionUri: {} }, setTimeout, clearTimeout,
        isScenarioYamlFile: () => true, isMainScenarioDocument: () => true, hasProjectMetadata: () => false,
        buildScenarioSaveSnapshot: () => ({}), calculateScenarioDirtyFlags: () => ({}),
        setScenarioSnapshotAsSaved: () => { savedSnapshots.set(uri.toString(), document.text); },
        updateScenarioMetadataBlockSessionCache: () => {},
        getMissingCriticalScenarioSections: () => [],
        getTranslator: async () => (message: string) => message,
        collectAllYamlSourceDirectoryScenarioUris: async () => [uri], collectGitModifiedYamlUris: async () => [uri],
        internallyTriggeredSaves: new Set(), processingFiles: new Set(), pendingBackgroundScenarioFiles: new Set(),
        scenarioMetadataBlockSessionCache: new Map(), lastSavedScenarioSnapshots: new Map(), scenarioDirtyFlagsByUri: new Map(),
        batchProcessingInProgress: false, scenarioRepairCancellationSource: null,
        phaseSwitcherProvider: { upsertScenarioCacheEntryFromDocument() {}, setScenarioRepairInProgress() {}, setScenarioRepairCancelling() {} },
        vscode: {
            WorkspaceEdit, Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
            ProgressLocation: { Notification: 1 },
            CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() { this.token.isCancellationRequested = true; } dispose() {} },
            window: {
                activeTextEditor: { document }, showInformationMessage: async () => {},
                showErrorMessage: async (message: string) => { errors.push(message); },
                showWarningMessage: async (_message: string, _options: unknown, action: string) => action,
                withProgress: async (_options: unknown, work: (progress: unknown, token: unknown) => Promise<void>) => work(
                    { report() {} }, { onCancellationRequested: () => ({ dispose() {} }) })
            },
            workspace: {
                textDocuments: [document],
                workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/repo' } }],
                getConfiguration: () => ({ get: (key: string) => key === 'editor.autoMigrateScenarioYamlOnSave' && autoMigrate || key === 'editor.autoEnsureKotMetadataForMainScenarios' || key === 'editor.enableLegacyMetadataMigrationForMainScenarios' }),
                openTextDocument: async () => document,
                applyEdit: async (edit: WorkspaceEdit) => { document.text = edit.text ?? document.text; return true; }
            }
        }
    };
    const compiled = ts.transpileModule(`({ save: ${save.getText(sourceFile)}, repair: ${repair.getText(sourceFile)} })`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const handlers = vm.runInNewContext('const kotUi = vscode.window;\n' + compiled, state) as { save(document: unknown): Promise<void>; repair(mode: 'all'): Promise<void> };
    return { document, errors, savedSnapshots, handlers, state, saves: () => saves };
}

const scenario = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Sales"\n    UID: "sales"\nПараметрыСценария:\nВложенныеСценарии:\nТекстСценария: |\n    #language: en\n    And I open a form\n';

test('agent batch repair refuses dirty or disallowed sources before any write', async () => {
    const h = harness(scenario); h.state.hasKotInteraction = () => true; h.document.isDirty = true;
    await assert.rejects(h.handlers.repair('all'), /Save affected/); assert.equal(h.saves(), 0);
    h.document.isDirty = false; h.state.assertKotPath = async () => { throw new Error('outside configured roots'); };
    await assert.rejects(h.handlers.repair('all'), /outside configured/); assert.equal(h.saves(), 0);
});

test('batch cancellation propagates from native progress and returns actual partial counts', async () => {
    const h = harness(scenario);
    h.state.vscode.window.withProgress = async (_options, work) => work({ report() {} }, { onCancellationRequested: (cancel: () => void) => { cancel(); return { dispose() {} }; } });
    const result = await h.handlers.repair('all') as unknown as { cancelled: boolean; changed: number; failed: number };
    assert.equal(result.cancelled, true); assert.equal(result.changed, 0); assert.equal(result.failed, 0); assert.equal(h.saves(), 0);
});

test('native editor commands await asynchronous handlers and skip missing editors', async () => {
    const ts = require('typescript') as typeof import('typescript');
    const source = ts.createSourceFile('extension.ts', fs.readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
    const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'registerScenarioEditorCommand')!;
    const commands = new Map<string, () => Promise<unknown>>(); const window: { activeTextEditor?: object } = { activeTextEditor: {} };
    const register = vm.runInNewContext(ts.transpileModule(declaration.getText(source) + '\nregisterScenarioEditorCommand;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
        { vscode: { window, commands: { registerCommand: (id: string, work: () => Promise<unknown>) => { commands.set(id, work); return {}; } } } });
    let complete: (() => void) | undefined; let calls = 0;
    register('editor.command', async (editor: unknown, edit: unknown) => { calls++; assert.equal(editor, window.activeTextEditor); assert.equal(edit, undefined); await new Promise<void>(resolve => { complete = resolve; }); return 'saved'; });
    const running = commands.get('editor.command')!(); assert.equal(calls, 1); complete!(); assert.equal(await running, 'saved');
    window.activeTextEditor = undefined; assert.equal(await commands.get('editor.command')!(), undefined); assert.equal(calls, 1);
});

for (const action of ['save', 'repair'] as const) {
    test(`${action} leaves a source without inline metadata intact even with legacy insertion settings enabled`, async () => {
        const h = harness(scenario);
        if (action === 'save') { await h.handlers.save(h.document); }
        else { await h.handlers.repair('all'); }
        assert.deepEqual(h.errors, []);
        assert.equal(h.document.text, scenario);
        assert.equal(h.saves(), 0);
        assert.equal(h.savedSnapshots.get(h.document.uri.toString()), scenario);
    });

    test(`${action} retains existing authored inline metadata without rewriting its shape`, async () => {
        const source = scenario.replace('ПараметрыСценария:', 'KOTМетаданные:\n    Description: Authored description\n    Категория: Reporting\n\nПараметрыСценария:');
        const h = harness(source);
        if (action === 'save') { await h.handlers.save(h.document); }
        else { await h.handlers.repair('all'); }
        assert.deepEqual(h.errors, []);
        assert.equal(h.document.text, source);
        assert.equal(h.saves(), 0);
    });
}

test('legacy branch ignores a user-level save-migration preference', async () => {
    const h=harness(scenario,true);await h.handlers.save(h.document);
    assert.deepEqual(h.errors,[]);assert.equal(h.document.text,scenario);assert.equal(h.saves(),0);
});
