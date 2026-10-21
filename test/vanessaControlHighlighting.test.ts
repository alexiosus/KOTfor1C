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
    highlighter.renderMany(editor, [{ range: 4, status: 'passed' }, { range: 5, status: 'running' }]);
    assert.deepEqual(Array.from(painted.get(0)!, item => item.range), [5]);
    highlighter.renderMany(editor, [{ range: 4, status: 'passed' }, { range: 5, status: 'passed' }]);
    assert.equal(painted.get(0)!.length, 0); assert.deepEqual(Array.from(painted.get(1)!, item => item.range), [4, 5]);
});
