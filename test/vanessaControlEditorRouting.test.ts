import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as feature from '../src/vanessaControlFeature';
import * as yaml from '../src/vanessaControlYaml';

test('YAML F11 uses a direct step trial even when a compiled map exists; compiled execution is explicit', async () => {
    const handlers = new Map<string, () => Promise<void>>(); const invoked: string[] = []; const compiled: string[] = [];
    const text = 'ТипФайла: "Сценарий"\nТекстСценария: |\n    And Delay "1"\n';
    const editor = { document: { uri: { toString: () => 'file:///scen.yaml', fsPath: '/scen.yaml' }, version: 1, isDirty: false,
        lineCount: 4, getText: () => text }, selection: { active: { line: 2 } } };
    const noop = () => ({ dispose() {} });
    const module = { exports: {} as Record<string, unknown> };
    const vscode = { l10n: { t: (text: string) => text }, ProgressLocation: { Notification: 1 },
        window: { activeTextEditor: editor, visibleTextEditors: [editor], onDidChangeActiveTextEditor: noop, onDidChangeTextEditorSelection: noop,
            onDidChangeVisibleTextEditors: noop, showErrorMessage: (error: string) => { throw new Error(error); } },
        workspace: { onDidChangeTextDocument: noop },
        debug: { onDidStartDebugSession: noop, onDidTerminateDebugSession: noop },
        commands: { registerCommand: (name: string, handler: () => Promise<void>) => { handlers.set(name, handler); return noop(); },
            executeCommand: async (name: string) => { if (name !== 'setContext') { invoked.push(name); } } } };
    const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join('src', 'vanessaControlCommands.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, Error, require: (name: string) => {
        if (name === 'vscode') { return vscode; }
        if (name === './vanessaControlFeature') { return feature; }
        if (name === './vanessaControlYaml') { return yaml; }
        if (name === './vanessaControlHighlighting') { return { VanessaExecutionHighlighter: class { render() {} } }; }
        return require(name);
    } });
    const register = module.exports.registerVanessaControlCommands as (...args: unknown[]) => void;
    register({ subscriptions: [] }, { snapshot: { status: 'ready', capabilities: { oneStep: { supported: true },
        editorContent: { supported: true }, openFeature: { supported: true } } }, onDidChange: noop },
    { run: async (mode: string) => { compiled.push(mode); } });
    await handlers.get('kotTestToolkit.vanessaControl.oneStep')!();
    assert.deepEqual(invoked, ['kotTestToolkit.vanessaControl.tryYamlStep']); assert.deepEqual(compiled, []);
    const explicit = handlers.get('kotTestToolkit.vanessaControl.oneCompiledStep'); assert.ok(explicit);
    await explicit(); assert.deepEqual(compiled, ['oneStep']);
});

test('a late failed-step error updates its hover without repainting unrelated failed lines with that error', () => {
    const noop = () => ({ dispose() {} }); const painted: any[][] = []; let update!: () => void;
    const text = 'Feature: Own\nScenario: Own\n  And Own\n  And Other\n';
    const editor = { document: { uri: { toString: () => 'file:///own.feature', fsPath: '/own.feature' }, version: 1,
        lineCount: 5, getText: () => text, lineAt: (line: number) => ({ range: line }) }, selection: { active: { line: 2 } } };
    const session: any = { snapshot: { status: 'ready', execution: { filePath: '/own.feature', lineNumber: 3, status: 'failed',
        steps: [{ lineNumber: 3, status: 'failed' }, { lineNumber: 4, status: 'failed' }] } },
        executionMatchesSource: () => true, onDidChange: (listener: () => void) => { update = listener; return noop(); } };
    const vscode = { l10n: { t: (value: string) => value }, window: { activeTextEditor: editor, visibleTextEditors: [editor],
        onDidChangeActiveTextEditor: noop, onDidChangeTextEditorSelection: noop, onDidChangeVisibleTextEditors: noop, showErrorMessage: noop },
        workspace: { onDidChangeTextDocument: noop }, debug: { onDidStartDebugSession: noop, onDidTerminateDebugSession: noop },
        commands: { registerCommand: noop, executeCommand: noop } };
    const module = { exports: {} as any }; const ts = require('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlCommands.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: (name: string) => name === 'vscode' ? vscode : name.endsWith('Highlighting')
            ? { VanessaExecutionHighlighter: class { render() {} renderMany(_editor: unknown, lines: any[]) { painted.push(lines); } } }
            : name.endsWith('Feature') ? feature : yaml });
    module.exports.registerVanessaControlCommands({ subscriptions: [] }, session);
    assert.equal(painted.length, 1);
    session.failure = { generation: 1, filePath: '/own.feature', lineNumber: 3, message: 'Own assertion failed' }; update();
    assert.equal(painted.length, 2);
    assert.equal(painted[1].find(line => line.range === 2).detail, 'Own assertion failed');
    assert.equal(painted[1].find(line => line.range === 3).detail, undefined);
});
