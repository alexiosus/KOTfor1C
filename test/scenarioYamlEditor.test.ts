import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function harness(text: string, nativePair?: { metadataUri: unknown; scriptUri: unknown }) {
    const calls: any[] = []; const opened: unknown[] = [];
    const document = { uri: { fsPath: nativePair ? '/repo/meta.yaml' : '/repo/scen.yaml', toString: () => nativePair ? 'file:///repo/scen.feature' : 'file:///repo/scen.yaml' }, getText: () => text, isClosed: false };
    const editor = { document };
    const host = {
        workspace: { openTextDocument: async (uri: unknown) => { opened.push(uri); return document; } },
        window: { activeTextEditor: editor as any, showTextDocument: async () => editor },
        commands: { executeCommand: async (...args: any[]) => { calls.push(args); } }
    };
    const module = { exports: {} as typeof import('../src/scenarioYamlEditor') };
    const filename = path.join(process.cwd(), 'src/scenarioYamlEditor.ts');
    if (fs.existsSync(filename)) {
        const ts = require('typescript') as typeof import('typescript');
        vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText, { module, exports: module.exports, require: (name: string) => name === './spprScenarioFiles' ? { resolveScenarioSourceUris: async () => nativePair ? { format: 'native', ...nativePair } : undefined } : host });
    }
    return { api: module.exports, document, editor, host, calls, opened };
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


test('native metadata opens its original SPPR script without folding script lines as YAML', async () => {
    const scriptUri = { fsPath: '/repo/scen.feature', toString: () => 'file:///repo/scen.feature' };
    const metadataUri = { fsPath: '/repo/meta.yaml', toString: () => 'file:///repo/meta.yaml' };
    const h = harness('#language: en\nAnd original script\n', { metadataUri, scriptUri });
    await new h.api.ScenarioYamlEditor().open(metadataUri as never);
    assert.equal(h.opened[0], scriptUri);
    assert.deepEqual(h.calls, []);
});


test('metadata files retain manual folding but are never collapsed by default', () => {
    const text = 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Own\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: Value\n';
    const h = harness(text);
    assert.deepEqual(Array.from(h.api.scenarioDefaultFoldLines(text, '/repo/meta.yaml')), []);
    assert.ok(h.api.scenarioYamlFoldRanges(text).length > 0);
    assert.ok(h.api.scenarioDefaultFoldLines(text, '/repo/scen.yaml').length > 0);
});
