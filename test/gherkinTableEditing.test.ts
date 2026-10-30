import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import type * as vscode from 'vscode';
import * as tableUtils from '../src/gherkinTableUtils';
import * as scenarioYaml from '../src/scenarioYamlDocument';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
const body = '    And table\n        | Name | Value |\n        | Alice | 1 |\n        | Bob | 2 |\n';

function harness(source: string, fileName = '/repo/own.feature', opened = true) {
    const document = {
        text: source, version: 1, fileName, languageId: fileName.endsWith('.feature') ? 'feature' : 'yaml',
        uri: { scheme: 'file', toString: () => `file://${fileName}` },
        getText() { return this.text; },
        positionAt(offset: number) { return { offset }; }
    };
    type Change = (event: vscode.TextDocumentChangeEvent) => unknown;
    let onChange: Change;
    let onOpen: (document: unknown) => unknown;
    let onClose: (document: unknown) => unknown;
    const edits: Array<{ undoStopBefore: boolean; undoStopAfter: boolean }> = [];
    let apply = true;
    let undoGroupBefore = source;
    let undoGroupAfter = source;
    const editor = {
        document,
        async edit(callback: (builder: { delete(range: { start: { offset: number }; end: { offset: number } }): void }) => void, options: { undoStopBefore: boolean; undoStopAfter: boolean }) {
            edits.push(options);
            if (!apply) { return false; }
            const deletions: Array<{ start: { offset: number }; end: { offset: number } }> = [];
            callback({ delete: range => deletions.push(range) });
            const changes = deletions.map(range => ({ rangeOffset: range.start.offset, rangeLength: range.end.offset - range.start.offset, text: '' }));
            for (const range of deletions.sort((a, b) => b.start.offset - a.start.offset)) {
                document.text = document.text.slice(0, range.start.offset) + document.text.slice(range.end.offset);
            }
            document.version++;
            undoGroupAfter = document.text;
            await onChange({ document, contentChanges: changes } as unknown as vscode.TextDocumentChangeEvent);
            return true;
        }
    };
    const host = {
        Range: class { constructor(readonly start: { offset: number }, readonly end: { offset: number }) {} },
        window: { activeTextEditor: editor as typeof editor | undefined },
        workspace: {
            textDocuments: opened ? [document] : [],
            onDidChangeTextDocument: (handler: Change) => { onChange = handler; return { dispose() {} }; },
            onDidOpenTextDocument: (handler: typeof onOpen) => { onOpen = handler; return { dispose() {} }; },
            onDidCloseTextDocument: (handler: typeof onClose) => { onClose = handler; return { dispose() {} }; }
        }
    };
    const module = { exports: {} as typeof import('../src/gherkinTableEditing') };
    const dependencies: Record<string, unknown> = { vscode: host, './gherkinTableUtils': tableUtils, './scenarioYamlDocument': scenarioYaml };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/gherkinTableEditing.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, console, require: (name: string) => dependencies[name] ?? {} });
    module.exports.registerGherkinTableColumnDeletion({ subscriptions: [] } as unknown as vscode.ExtensionContext);

    async function change(chunk: string, replacement = '', extra: Partial<vscode.TextDocumentChangeEvent> = {}) {
        const rangeOffset = document.text.indexOf(chunk);
        assert.ok(rangeOffset >= 0, chunk);
        undoGroupBefore = document.text;
        document.text = document.text.slice(0, rangeOffset) + replacement + document.text.slice(rangeOffset + chunk.length);
        document.version++;
        undoGroupAfter = document.text;
        await onChange({ document, contentChanges: [{ rangeOffset, rangeLength: chunk.length, text: replacement }], ...extra } as unknown as vscode.TextDocumentChangeEvent);
    }

    return {
        document, edits, change,
        open: () => onOpen(document), close: () => onClose(document),
        deactivate: () => { host.window.activeTextEditor = undefined; },
        refuseEdit: () => { apply = false; },
        async undo() { document.text = undoGroupBefore; document.version++; await onChange({ document, contentChanges: [], reason: 1 } as unknown as vscode.TextDocumentChangeEvent); },
        async redo() { document.text = undoGroupAfter; document.version++; await onChange({ document, contentChanges: [], reason: 2 } as unknown as vscode.TextDocumentChangeEvent); }
    };
}

test('header deletion updates feature, native fragment and YAML tables in the same undo group', async () => {
    for (const [fileName, prefix] of [
        ['/repo/own.feature', 'Feature: Own\nScenario: Own\n'],
        ['/repo/scen.feature', '#language: en\n'],
        ['/repo/scen.yaml', 'ТипФайла: "Сценарий"\nТекстСценария: |\n']
    ]) {
        const source = prefix + body;
        const h = harness(source, fileName);
        await h.change(' Value |');
        const expected = prefix + '    And table\n        | Name |\n        | Alice |\n        | Bob |\n';
        assert.equal(h.document.text, expected);
        assert.equal(h.edits.length, 1, 'own edit must not trigger another deletion');
        assert.equal(h.edits[0].undoStopBefore, false);
        assert.equal(h.edits[0].undoStopAfter, false);
        await h.undo(); assert.equal(h.document.text, source);
        await h.redo(); assert.equal(h.document.text, expected);
        assert.equal(h.edits.length, 1);
    }
});

test('clearing or replacing a header label, multiple edits and undo/redo leave other cells unchanged', async () => {
    for (const [chunk, replacement, extra] of [
        ['Value', '', {}], [' Value |', ' Other |', {}],
        [' Value |', '', { reason: 1 }], [' Value |', '', { reason: 2 }],
        [' Value |', '', { contentChanges: [{}, {}] }]
    ] as const) {
        const h = harness(body);
        await h.change(chunk, replacement, extra);
        assert.ok(h.document.text.includes('| Alice | 1 |'));
        assert.equal(h.edits.length, 0);
    }
});

test('YAML metadata tables stay untouched while the script table is edited', async () => {
    const metadata = 'ТипФайла: "Сценарий"\nОписание: |\n' + body.replace('Name', 'Metadata') + 'ТекстСценария: |\n';
    const h = harness(metadata + body, '/repo/scen.yaml');
    await h.change('| Metadata ');
    assert.equal(h.edits.length, 0);
    assert.equal(h.document.text, metadata.replace('| Metadata ', '') + body);
    await h.change('        | Name ');
    assert.equal(h.edits.length, 0, 'deleting indentation with the header cell is not a structural cell deletion');

    const nativeMetadata = harness('Описание: |\n' + body, '/repo/meta.yaml');
    await nativeMetadata.change(' Value |');
    assert.equal(nativeMetadata.edits.length, 0);
    const quotedScript = harness('ТекстСценария: "' + body + '"\n', '/repo/scen.yaml');
    await quotedScript.change(' Value |');
    assert.equal(quotedScript.edits.length, 0, 'only an unambiguous YAML script block is supported');
});

test('opened documents are tracked, closed snapshots and inactive editors cannot cause stale deletions', async () => {
    const opened = harness(body, '/repo/own.feature', false);
    opened.open(); await opened.change(' Value |');
    assert.equal(opened.edits.length, 1);
    const closed = harness(body);
    closed.close(); await closed.change(' Value |');
    assert.equal(closed.edits.length, 0);
    const inactive = harness(body);
    inactive.deactivate(); await inactive.change(' Value |');
    assert.equal(inactive.edits.length, 0);
    const stale = harness(body);
    stale.document.version++;
    await stale.change(' Value |');
    assert.equal(stale.edits.length, 0);
});

test('a rejected edit leaves the header change intact and does not lock later edits', async () => {
    const h = harness(body.replace('Value |', 'Value | Flag |').replace('1 |', '1 | A |').replace('2 |', '2 | B |'));
    h.refuseEdit();
    await h.change(' Value |');
    assert.equal(h.edits.length, 1);
    assert.ok(h.document.text.includes('| Alice | 1 | A |'));
    await h.undo();
    await h.change(' Value |');
    assert.equal(h.edits.length, 2, 'a refused edit must release the in-progress guard');
});

test('a second header deletion uses the updated table snapshot and removes only the new target column', async () => {
    const h = harness(body.replace('Value |', 'Value | Flag |').replace('1 |', '1 | A |').replace('2 |', '2 | B |'));
    await h.change(' Value |');
    await h.change(' Flag |');
    assert.equal(h.document.text, '    And table\n        | Name |\n        | Alice |\n        | Bob |\n');
    assert.equal(h.edits.length, 2);
});
