import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { nativeInteraction } from './helpers/kotInteraction';
import { createProjectDefinitionView, normalizeProjectDefinitionTemplate } from '../src/projectDefinition';
import * as trial from '../src/vanessaControlYamlTrial';
import * as selections from '../src/vanessaControlSelection';
import { nativeDocumentTextMatchesFileText } from '../src/scenarioNativeDocumentSnapshot';

for (const outcome of ['passed', 'failed', 'missing metadata', 'selection changed', 'complete feature selection'] as const) {
test(`native SPPR trial command: ${outcome}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-native-trial-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const completeFeature = outcome === 'complete feature selection';
    const text = completeFeature ? '#language: en\n@tree\nFeature: Own\nScenario: Own\n\t*And custom group\n\t\tAnd custom step\n\tAnd later\n'
        : '#language: en\nAnd Delay 1\n# gap\nAnd Delay 2\n';
    const file = path.join(root, completeFeature ? 'built.feature' : 'scen.feature'); let saves = 0;
    const uri = { scheme: 'file', fsPath: file, toString: () => new URL(`file://${file}`).toString() };
    class Selection {
        constructor(readonly line: number) {}
        get active() { return { line: this.line }; }
        get start() { return { line: this.line }; }
        get end() { return { line: this.line + 1, character: 12 }; }
        get isEmpty() { return false; }
        isEqual(other: Selection) { return this === other; }
    }
    const document = { uri, version: 1, isDirty: true, lineCount: 5, getText: () => text,
        save: async () => { saves++; fs.writeFileSync(file, text); document.isDirty = false; return true; },
        lineAt: (line: number) => ({ range: line }) };
    const editor = { document, selection: new Selection(completeFeature ? 4 : 1), revealRange() {}, get selections() { return [this.selection]; } };
    const handlers = new Map<string, () => Promise<void>>(); const errors: string[] = []; const rendered: unknown[][] = [];
    const noop = () => ({ dispose() {} });
    const vscode = { l10n: { t: (value: string) => value }, Uri: { parse: () => uri }, Selection,
        ProgressLocation: { Notification: 1 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
        window: { activeTextEditor: editor, visibleTextEditors: [editor], onDidChangeVisibleTextEditors: noop,
            showErrorMessage: (message: string) => { errors.push(message); },
            withProgress: async (_options: unknown, work: () => Promise<void>) => work() },
        workspace: { onDidChangeTextDocument: noop }, debug: {},
        commands: { registerCommand: (name: string, handler: () => Promise<void>) => { handlers.set(name, handler); return noop(); } } };
    const module = { exports: {} as any }; const ts = require('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlYamlTrialCommands.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, Error, Buffer, require: (name: string) => {
        if (name === 'vscode') { return vscode; }
        if (name === './kotInteraction') { return nativeInteraction; }
        if (name === './gherkinLanguage') { return { getConfiguredScenarioLanguage: () => 'en' }; }
        if (name === './vanessaControlYamlTrial') { return trial; }
        if (name === './vanessaControlSelection') { return selections; }
        if (name === './scenarioNativeDocumentSnapshot') { return { nativeDocumentTextMatchesFileText }; }
        if (name === './vanessaControlSession') { return { sameVanessaFeaturePath: (left: string, right: string) => left === right }; }
        if (name === './vanessaControlHighlighting') { return { VanessaExecutionHighlighter: class { render(...args: unknown[]) { rendered.push(args); } } }; }
        if (name === './spprScenarioFiles') { return { readNativeScenarioMetadata: async (target: unknown) => {
            assert.equal(target, uri);
            if (outcome === 'selection changed') { editor.selection = new Selection(3); }
            return outcome === 'missing metadata' ? undefined : { uri, text: 'ТипФайла: Сценарий\n' };
        } }; }
        return require(name);
    } });
    const snapshot: any = { generation: 1, status: 'ready' }; let executions = 0;
    const session = { snapshot, onDidChange: noop, run: async (mode: string, runtimeFile: string, line: number, featureText: string, guard: () => boolean) => {
        t.after(() => fs.rmSync(path.dirname(runtimeFile), { recursive: true, force: true }));
        assert.equal(mode, completeFeature ? 'runFromLine' : 'oneStep'); assert.equal(line, completeFeature ? 5 : 4); assert.equal(guard(), true);
        assert.equal(fs.readFileSync(runtimeFile, 'utf8'), featureText);
        if (completeFeature) {
            assert.match(featureText, /\n\t\*And custom group\n\t\tAnd custom step\n$/u);
            assert.doesNotMatch(featureText, /And later/u);
        } else {
            assert.match(featureText, /\n    And Delay 1\n$/u); assert.doesNotMatch(featureText, /Delay 2/u);
        }
        snapshot.execution = { filePath: runtimeFile, lineNumber: line, status: completeFeature ? 'passed' : outcome }; executions++;
    } };
    const definitions = createProjectDefinitionView('native', [{ id: 'delay', kind: 'builtInStep', template: 'And Delay "%1 seconds"',
        normalizedTemplate: normalizeProjectDefinitionTemplate('And Delay "%1 seconds"'), language: 'en', sourceLabel: 'fixture',
        parameters: [{ name: 'seconds', index: 0, source: 'quoted' }] }]);
    module.exports.registerVanessaYamlTrialCommand({ subscriptions: [], workspaceState: { get: () => true } }, session, async () => {
        assert.equal(completeFeature, false, 'compiled feature selection must work outside a configured project');
        return definitions;
    });
    await handlers.get(completeFeature ? 'kotTestToolkit.vanessaControl.runSelection' : 'kotTestToolkit.vanessaControl.tryYamlStep')!();
    assert.equal(saves, 1); assert.equal(fs.readFileSync(file, 'utf8'), text);
    if (completeFeature) {
        assert.deepEqual(errors, []); assert.equal(executions, 1);
    } else if (outcome === 'passed' || outcome === 'failed') {
        assert.deepEqual(errors, []); assert.equal(executions, 1);
        assert.equal(editor.selection.active.line, outcome === 'passed' ? 3 : 1);
        assert.equal(rendered.at(-1)![1], 1); assert.equal(rendered.at(-1)![2], outcome);
    } else {
        assert.equal(executions, 0); assert.equal(errors.length, 1);
        assert.match(errors[0], outcome === 'missing metadata' ? /meta.yaml/u : /source or selection changed/u);
    }
});
}
