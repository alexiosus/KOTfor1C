import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function harness(text: string) {
    const calls: any[] = [];
    const document = { uri: { toString: () => 'file:///repo/scen.yaml' }, getText: () => text, isClosed: false };
    const editor = { document };
    const host = {
        workspace: { openTextDocument: async () => document },
        window: { activeTextEditor: editor as any, showTextDocument: async () => editor },
        commands: { executeCommand: async (...args: any[]) => { calls.push(args); } }
    };
    const module = { exports: {} as typeof import('../src/scenarioYamlEditor') };
    const filename = path.join(process.cwd(), 'src/scenarioYamlEditor.ts');
    if (fs.existsSync(filename)) {
        const ts = require('typescript') as typeof import('typescript');
        vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText, { module, exports: module.exports, require: () => host });
    }
    return { api: module.exports, document, editor, host, calls };
}

test('property mode folds populated service sections and keeps the literal scenario body expanded', async () => {
    const text = '\uFEFFТипФайла: Сценарий\r\nДанныеСценария:\r\n    Имя: Test\r\nПараметрыСценария:\r\n    - ПараметрыСценария1:\r\n        Имя: Name\r\nВложенныеСценарии:\r\nТекстСценария: |\r\n    Given text\r\n    ДанныеСценария:\r\nТегиСценария:\r\n    - ТегиСценария1:\r\n        Тег: smoke\r\n';
    const h = harness(text);
    assert.equal(typeof h.api.scenarioServiceSectionLines, 'function');
    assert.deepEqual(Array.from(h.api.scenarioServiceSectionLines(text)), [1, 3, 10]);
    const editor = await new h.api.ScenarioYamlEditor().open(h.document.uri as any);
    assert.equal(editor.document, h.document);
    assert.equal(editor.document.getText(), text);
    assert.equal(h.calls[0][0], 'editor.fold');
    assert.deepEqual(Array.from(h.calls[0][1].selectionLines), [0, 10]);
});

test('process properties retain steps and fold their header and parameters', () => {
    const h = harness('');
    assert.deepEqual(Array.from(h.api.scenarioServiceSectionLines('ДанныеПроцесса:\n    Имя: Flow\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: Name\nШагиПроцесса:\n    - ШагиПроцесса1:\n        UID: step\n')), [0, 2]);
});

test('one default folding region spans the entire header while preserving body and later sections', () => {
    const text = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Test"\nПараметрыСценария:\n\nТекстСценария: |\n    Given text\n    And text\nТегиСценария:\n    - ТегиСценария1:\n        Имя: "smoke"\n';
    const h = harness(text); const ranges = Array.from(h.api.scenarioYamlFoldRanges(text));
    assert.deepEqual(JSON.parse(JSON.stringify(ranges.find(range => range.header))), { start: 0, end: 4, header: true });
    assert.ok(ranges.some(range => range.start === 5 && range.end === 7));
    assert.deepEqual(Array.from(h.api.scenarioDefaultFoldLines(text)), [0, 8]);
    assert.equal(h.api.scenarioYamlFoldRanges('Name: "regular YAML"\nOther:\n    field: "value"').length, 0);
    const process = 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    Имя: "Flow"\nШагиПроцесса:\n    - ШагиПроцесса1:\n        Наименование: "Step"\n';
    assert.deepEqual(Array.from(h.api.scenarioDefaultFoldLines(process)), [0]);
    assert.equal(h.api.scenarioYamlFoldRanges(process)[0].end, 2);
});

test('empty service sections never fold the following body', () => {
    const h = harness('');
    assert.deepEqual(Array.from(h.api.scenarioServiceSectionLines('ПараметрыСценария:\n# comment\nВложенныеСценарии:\n\nТекстСценария: |\n    Given body\n')), []);
});

test('a one-line header never folds the following scenario body', () => {
    const text = 'ТипФайла: "Сценарий"\nТекстСценария: |\n    Given text\n';
    const h = harness(text);
    assert.equal(h.api.scenarioYamlFoldRanges(text).some(range => range.header), false);
    assert.deepEqual(Array.from(h.api.scenarioDefaultFoldLines(text)), []);
});

test('fold command cannot affect an editor selected while the source was opening', async () => {
    const h = harness('ДанныеСценария:\n    Имя: Test\nТекстСценария: |\n    Given body\n');
    h.host.window.showTextDocument = async () => { h.host.window.activeTextEditor = undefined; return h.editor; };
    await new h.api.ScenarioYamlEditor().open(h.document.uri as any);
    assert.equal(h.calls.length, 0);
});
