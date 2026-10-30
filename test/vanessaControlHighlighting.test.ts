import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('multiple completed steps retain their colors while the running decoration is cleared at completion', () => {
    let id = 0; const painted = new Map<number, any[]>();
    const vscode = { window: { createTextEditorDecorationType: () => ({ id: id++, dispose() {} }) },
        ThemeColor: class { constructor(readonly id: string) {} }, OverviewRulerLane: { Center: 1 }, DecorationRangeBehavior: { ClosedClosed: 1 },
        MarkdownString: class { appendText() {} } };
    const module = { exports: {} as any }; const ts = require('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlHighlighting.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: () => vscode });
    const highlighter = new module.exports.VanessaExecutionHighlighter();
    const editor = { setDecorations: (style: any, values: any[]) => painted.set(style.id, values) };
    const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 10 } });
    highlighter.renderMany(editor, [{ range: range(4), status: 'passed' }, { range: range(5), status: 'running' }]);
    assert.deepEqual(Array.from(painted.get(0)!, item => item.range.start.line), [5]);
    highlighter.renderMany(editor, [{ range: range(4), status: 'passed' }, { range: range(5), status: 'passed' }]);
    assert.equal(painted.get(0)!.length, 0); assert.deepEqual(Array.from(painted.get(1)!, item => item.range.start.line), [4, 5]);
});

test('log and MCP results share one whole-line paint and disposing one source retains the other', () => {
    let id = 0; const painted = new Map<number, any[]>();
    const vscode = { window: { createTextEditorDecorationType: () => ({ id: id++, dispose() {} }) },
        ThemeColor: class { constructor(readonly id: string) {} }, OverviewRulerLane: { Center: 1 }, DecorationRangeBehavior: { ClosedClosed: 1 },
        MarkdownString: class { value = ''; appendText(text: string) { this.value += text; } } };
    const module = { exports: {} as any }; const ts = require('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlHighlighting.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: () => vscode });
    const log = new module.exports.VanessaExecutionHighlighter(); const mcp = new module.exports.VanessaExecutionHighlighter();
    const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 10 } });
    const editor = { setDecorations: (style: any, values: any[]) => painted.set(style.id, values) };
    log.renderMany(editor, [{ range: range(3), status: 'passed' }, { range: range(8), status: 'passed' }]);
    mcp.renderMany(editor, [{ range: range(8), status: 'passed' }]);
    const hits = (line: number) => [...painted.values()].flat().filter(item => item.range.start.line === line);
    assert.equal(hits(3).length, 1); assert.equal(hits(8).length, 1, 'a completed line must not receive two translucent backgrounds');
    mcp.renderMany(editor, [{ range: range(8), status: 'failed', detail: 'Assertion failed' }]);
    assert.equal(hits(8).length, 1); assert.ok(JSON.stringify(hits(8)[0].hoverMessage).includes('Assertion failed'));
    log.renderMany(editor, [{ range: range(3), status: 'passed' }, { range: range(8), status: 'failed',
        hoverMessage: { value: 'Rich log failure with actions' }, hoverPriority: 2 }]);
    assert.equal(JSON.stringify(hits(8)[0].hoverMessage), '[{"value":"Rich log failure with actions"}]', 'the richer log hover replaces the plain MCP error instead of duplicating it');
    mcp.dispose(); assert.equal(hits(3).length, 1); assert.equal(hits(8).length, 1);
    log.dispose(); assert.equal([...painted.values()].flat().length, 0);
});

test('a failed line exposes its error while skipped lines remain unpainted', () => {
    const painted = new Map<object, any[]>();
    const vscode = { window: { createTextEditorDecorationType: (options: object) => ({ options, dispose() {} }) },
        ThemeColor: class { constructor(readonly id: string) {} }, OverviewRulerLane: { Center: 1 }, DecorationRangeBehavior: { ClosedClosed: 1 },
        MarkdownString: class { value = ''; appendText(text: string) { this.value += text; } } };
    const module = { exports: {} as any }; const ts = require('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlHighlighting.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: () => vscode });
    const highlighter = new module.exports.VanessaExecutionHighlighter();
    const editor = { setDecorations: (style: object, values: any[]) => painted.set(style, values) };
    const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 10 } });
    highlighter.renderMany(editor, [
        { range: range(27), status: 'failed', label: 'Step failed', detail: 'Клиент тестирования не подключен.' },
        { range: range(28), status: 'skipped', label: 'Step skipped' }
    ]);
    const values = [...painted.values()].flat();
    assert.equal(values.length, 1);
    assert.match(JSON.stringify(values.find(item => item.range.start.line === 27).hoverMessage), /Клиент тестирования не подключен/u);
    assert.equal(values.some(item => item.range.start.line === 28), false);
    highlighter.dispose();
});
