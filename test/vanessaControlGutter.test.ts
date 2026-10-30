import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import * as feature from '../src/vanessaControlFeature';
import * as yaml from '../src/vanessaControlYaml';
import { sameVanessaFeaturePath } from '../src/vanessaControlProtocol';

function harness(yamlCancelled = false) {
    const filePath = yamlCancelled ? '/scen.yaml' : '/safe.feature';
    const uri = { toString: () => `file://${filePath}`, fsPath: filePath, path: filePath };
    const text = yamlCancelled ? 'ТипФайла: "Сценарий"\nТекстСценария: |\n    And Delay "1"\n    And Delay "2"\n'
        : '# language: en\nFeature: Safe\nScenario: Safe\n    And Delay "1"\n    And Delay "2"\n';
    const listeners: Array<(event: { added: Point[]; removed: Point[]; changed: Point[] }) => void> = [];
    const changed: Array<() => void> = []; const commands = new Map<string, () => Promise<unknown>>();
    let serial = 0;
    class Point {
        id = String(++serial); enabled = true; condition?: string; hitCondition?: string; logMessage?: string;
        constructor(public location: { uri: typeof uri; range: { start: { line: number } } }) {}
    }
    const points: Point[] = [];
    const emit = (added: Point[], removed: Point[] = []) => { for (const listener of listeners) { listener({ added, removed, changed: [] }); } };
    const noop = () => ({ dispose() {} });
    const document = { uri, version: 1, isDirty: false, lineCount: text.split('\n').length, getText: () => text,
        lineAt: (line: number) => ({ range: { start: { line } } }) };
    const editor = { document, selection: { active: { line: 3 } }, setDecorations() {} };
    const h = { snapshot: { generation: 1, capabilities: { breakpoints: { supported: true } },
        breakpoints: undefined as undefined | { filePath: string; lines: number[]; ownedLines: number[] } },
    points, editor, remote: [] as number[], writes: [] as number[][], errors: [] as string[], activeDebugger: false, fail: false,
    async click(line: number) {
        const existing = points.find(point => point.location.range.start.line === line);
        if (existing) { points.splice(points.indexOf(existing), 1); emit([], [existing]); }
        else { const point = new Point({ uri, range: { start: { line } } }); points.push(point); emit([point]); }
        for (let n = 0; n < 30; n++) { await new Promise<void>(resolve => setImmediate(resolve)); }
    },
    changeGeneration() { h.snapshot.generation++; h.snapshot.breakpoints = undefined; for (const notify of changed) { notify(); } },
    command: async () => { await commands.get('kotTestToolkit.vanessaControl.toggleBreakpoint')!(); }
    };
    const vscode = {
        SourceBreakpoint: Point,
        Location: class { constructor(public uri: object, public range: object) {} },
        Range: class { start: { line: number }; constructor(line: number) { this.start = { line }; } },
        Uri: { parse: () => uri }, ThemeColor: class {}, DecorationRangeBehavior: { ClosedClosed: 0 }, OverviewRulerLane: { Left: 0 },
        ExtensionMode: { Development: 2 }, l10n: { t: (value: string) => value },
        window: { activeTextEditor: editor, visibleTextEditors: [editor], createTextEditorDecorationType: noop,
            onDidChangeVisibleTextEditors: noop, showErrorMessage: (error: string) => { h.errors.push(error); }, showInformationMessage() {} },
        workspace: { onDidChangeTextDocument: noop },
        commands: { registerCommand: (name: string, handler: () => Promise<unknown>) => { commands.set(name, handler); return noop(); } },
        debug: { breakpoints: points, get activeDebugSession() { return h.activeDebugger ? {} : undefined; }, onDidChangeBreakpoints: (listener: typeof listeners[number]) => { listeners.push(listener); return noop(); },
            addBreakpoints: (added: Point[]) => { points.push(...added); emit(added); },
            removeBreakpoints: (removed: Point[]) => { for (const point of removed) { const i = points.indexOf(point); if (i >= 0) { points.splice(i, 1); } } emit([], removed); } }
    };
    const session = { get snapshot() { return h.snapshot; }, ownedBreakpointsForSource: () => h.snapshot.breakpoints?.ownedLines ?? [],
        onDidChange: (listener: () => void) => { changed.push(listener); return noop(); },
        synchronizeBreakpoints: async (filePath: string, desired?: number[]) => {
            if (h.fail) { throw new Error('Not confirmed'); }
            if (desired) { h.writes.push([...desired]); h.remote = [...desired]; }
            h.snapshot.breakpoints = { filePath, lines: [...h.remote], ownedLines: [...h.remote] };
            for (const notify of changed) { notify(); }
            return [...h.remote];
        } };
    const ts = require('typescript') as typeof import('typescript');
    const modules = new Map<string, Record<string, unknown>>();
    const load = (name: string): Record<string, unknown> => {
        if (modules.has(name)) { return modules.get(name)!; }
        const module = { exports: {} as Record<string, unknown> }; modules.set(name, module.exports);
        const source = fs.readFileSync(path.join(process.cwd(), 'src', name + '.ts'), 'utf8');
        vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
            { module, exports: module.exports, Error, require: (name: string) => {
                if (name === 'vscode') { return vscode; }
                if (name === 'node:fs/promises') { return { stat: async () => ({ isFile: () => true }), readFile: async () => text }; }
                if (name === './vanessaControlFeature') { return feature; }
                if (name === './vanessaControlSession') { return { sameVanessaFeaturePath }; }
                if (name === './vanessaControlYaml') { return yaml; }
                if (name.startsWith('./')) { return load(name.slice(2)); }
                return require(name);
            } });
        return module.exports;
    };
    const register = load('vanessaControlBreakpointCommands').registerVanessaBreakpointCommands as (context: object, session: object, yaml?: object) => void;
    register({ subscriptions: [], asAbsolutePath: (value: string) => value }, session, yamlCancelled ? { run: async () => undefined } : undefined);
    return h;
}

test('gutter clicks retain a native confirmed marker and the next click removes the same remote breakpoint', async () => {
    const h = harness();
    await h.click(4);
    assert.deepEqual(h.remote, [5], 'use the clicked line, not the caret');
    assert.equal(h.points.length, 1, 'keep the native clickable marker instead of replacing it with a decoration');
    await h.click(4);
    assert.deepEqual(h.remote, []); assert.equal(h.points.length, 0);
    assert.deepEqual(h.writes, [[5], []]); assert.deepEqual(h.errors, []);
});

test('context menu points use the same native gutter; detach clears only KOT native markers', async () => {
    const h = harness();
    h.activeDebugger = true; await h.click(4); h.activeDebugger = false;
    await h.command();
    assert.deepEqual(h.remote, [4]); assert.equal(h.points.length, 2);
    h.changeGeneration();
    assert.equal(h.points.length, 1); assert.equal(h.points[0].location.range.start.line, 4, 'other debugger point survives');
});

test('unconfirmed gutter requests leave no success-looking native breakpoint', async () => {
    const h = harness(); h.fail = true;
    await h.click(4);
    assert.deepEqual(h.remote, []); assert.equal(h.points.length, 0); assert.deepEqual(h.errors, ['Not confirmed']);
});

test('cancelling the YAML invocation picker leaves no unconfirmed native marker', async () => {
    const h = harness(true); await h.click(3);
    assert.equal(h.points.length, 0); assert.deepEqual(h.remote, []); assert.deepEqual(h.errors, []);
});
