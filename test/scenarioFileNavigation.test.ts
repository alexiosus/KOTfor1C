import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test, { type TestContext } from 'node:test';
import * as references from '../src/scenarioFileReferences';

test('file references preserve exact quoted and table ranges and exclude comments, code blocks, variables and URLs', () => {
    const source = ['Feature: file references', '# "ignored.mxl"', 'Scenario: example',
        '  And I compare "Отчет с пробелами.mxl" with \'other.csv\'', '  | Fixtures/input.json | "other.csv" |',
        '  And run code', '  """', '  "hidden.mxl"', '  """', '  And open "$Unknown$" and "https://example.com/file.mxl"'].join('\n');
    const result = references.collectScenarioFileReferences(source, false);
    assert.deepEqual(result.map(row => row.text), ['Отчет с пробелами.mxl', 'other.csv', 'Fixtures/input.json', 'other.csv']);
    for (const row of result) { assert.equal(source.split('\n')[row.line].slice(row.start, row.end), row.text); }
    const yaml = 'Имя: "not-a-reference.mxl"\nТекстСценария: |\n  И открыть "file.mxl"\nПараметрыСценария:\n  Value: "also-not-a-reference.mxl"';
    assert.deepEqual(references.collectScenarioFileReferences(yaml, true).map(row => [row.line, row.text]), [[2, 'file.mxl']]);
});

test('file names can omit the extension while explicit extensions and subdirectories remain significant', () => {
    assert.equal(references.matchesFileReference('Отчет с пробелами', 'Fixtures/Отчет с пробелами.mxl'), true);
    assert.equal(references.matchesFileReference('data.csv', 'data.mxl'), false);
    assert.equal(references.matchesFileReference('data.csv', 'data.csv.mxl'), false);
    assert.equal(references.matchesFileReference('Report.2024', 'Report.2024.mxl'), true);
    assert.equal(references.matchesFileReference('Other/data.csv', 'Fixtures/data.csv'), false);
    assert.equal(references.matchesFileReference('files/Fixtures/data.csv', 'Fixtures/data.csv'), true);
    assert.equal(references.matchesFileReference('Fixtures\\data.csv', 'Fixtures/data.csv'), true);
});

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'kot-file-links-'));
    assert.ok(path.basename(root).startsWith('kot-file-links-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    class Uri {
        readonly scheme: string; readonly path: string; readonly fsPath: string;
        constructor(private readonly value: string) { const parsed = new URL(value); this.scheme = parsed.protocol.slice(0, -1); this.path = decodeURIComponent(parsed.pathname); this.fsPath = this.scheme === 'file' ? fileURLToPath(parsed) : ''; }
        toString() { return this.value; }
        static file(file: string) { return new Uri(pathToFileURL(file).toString()); }
        static parse(value: string) { return new Uri(value); }
    }
    const folder = { uri: Uri.file(root) }; const commands = new Map<string, Function>(); const opened: string[] = []; const notifications: string[] = [];
    let picked: any[] = []; let cancelPick = false; let scans = 0; let content = 'And I open "document"';
    const source = Uri.file(path.join(root, 'Scenario', 'scen.feature'));
    const document = { uri: source, version: 1, get lineCount() { return content.split('\n').length; },
        getText(range?: any) { return range ? content.split('\n')[range.start.line].slice(range.start.character, range.end.character) : content; },
        lineAt(line: number) { return { text: content.split('\n')[line] }; } };
    const active = { document, selection: { isEmpty: true, active: { line: 0, character: 18 } } };
    const items: any[] = []; const projectFiles: any[] = []; const invalidate: Function[] = [];
    const vscode: any = { Uri, FileType: { File: 1 }, l10n: { t: (value: string) => value },
        Range: class { start: any; end: any; constructor(line: number, start: number, endLine: number, end: number) { this.start = { line, character: start }; this.end = { line: endLine, character: end }; } },
        DocumentLink: class { constructor(readonly range: any, readonly target: any) {} },
        RelativePattern: class { constructor(readonly base: any, readonly pattern: string) {} },
        workspace: { workspaceFolders: [folder], getWorkspaceFolder: (uri: Uri) => uri.fsPath.startsWith(root + path.sep) || uri.fsPath === root ? folder : undefined,
            fs: { stat: async (uri: Uri) => ({ type: (await fs.stat(uri.fsPath)).isFile() ? 1 : 2 }) },
            findFiles: async (pattern: any) => { scans++; return typeof pattern === 'string' && pattern.includes('{files,') ? projectFiles : projectFiles.filter(uri => path.basename(uri.fsPath).startsWith((pattern.pattern ?? pattern).slice(3).replace(/\.\*$/u, ''))); },
            onDidChangeWorkspaceFolders: () => ({ dispose() {} }), openTextDocument: async () => document,
            createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: (callback: Function) => { invalidate.push(callback); return { dispose() {} }; }, onDidDelete: () => ({ dispose() {} }) }) },
        window: { activeTextEditor: active, showInformationMessage: (message: string) => { notifications.push(message); }, showErrorMessage: (message: string) => { notifications.push(message); },
            showQuickPick: async (rows: any[]) => { picked = rows; return cancelPick ? undefined : rows.at(-1); } },
        env: { openExternal: async (uri: Uri) => { opened.push(uri.fsPath); return true; } },
        commands: { registerCommand: (name: string, action: Function) => { commands.set(name, action); return { dispose() {} }; }, executeCommand: async () => undefined },
        languages: { registerDocumentLinkProvider: () => ({ dispose() {} }) } };
    const module = { exports: {} as any }; const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(await fs.readFile('src/scenarioFileNavigation.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, process, require: (name: string) => name === 'vscode' ? vscode : name === './scenarioFileReferences' ? references : require(name) });
    const snapshots = { ensureReady: async () => ({ items }) };
    const files = { resolveAttachmentUri: async (item: any, relative: string) => Uri.file(path.join(item.root, relative)) };
    const navigation = new module.exports.ScenarioFileNavigation(snapshots, files); t.after(() => navigation.dispose());
    const create = async (relative: string, text = 'fixture') => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return Uri.file(file); };
    return { root, source, document, active, items, projectFiles, navigation, create, opened, commands, notifications,
        scans: () => scans, picked: () => picked, cancel: () => { cancelPick = true; }, text: (value: string) => { content = value; document.version++; }, invalidate: () => invalidate.forEach(callback => callback()),
        register: () => { const subscriptions: any[] = []; module.exports.registerScenarioFileNavigation({ subscriptions }, snapshots, files); t.after(() => subscriptions.forEach(item => item.dispose())); } };
}

test('opening follows the current position and never guesses a different file elsewhere on the line', async t => {
    const h = await fixture(t); const first = await h.create('Scenario/files/first.csv'); const second = await h.create('Scenario/files/document.mxl');
    h.projectFiles.push(first, second); h.text('And I open "first.csv"\nAnd I open "document"'); h.register();
    h.active.selection.active = { line: 0, character: 15 };
    await h.commands.get('kotTestToolkit.openFile')!(); assert.deepEqual(h.opened, [first.fsPath]);
    h.active.selection.active = { line: 1, character: 15 };
    await h.commands.get('kotTestToolkit.openFile')!(); assert.deepEqual(h.opened, [first.fsPath, second.fsPath]);
    h.active.selection.active = { line: 1, character: 1 };
    await h.commands.get('kotTestToolkit.openFile')!(); assert.deepEqual(h.opened, [first.fsPath, second.fsPath]);
});

test('cursor opening and command links use the system association, prefer local files and retain the legacy command alias', async t => {
    const h = await fixture(t); const local = await h.create('Scenario/files/document.mxl'); const remote = await h.create('Other/files/document.csv');
    h.projectFiles.push(local, remote); h.register();
    const links = await h.navigation.provideDocumentLinks(h.document, { isCancellationRequested: false });
    assert.equal(links.length, 1); assert.equal(links[0].target.scheme, 'command');
    await h.commands.get('kotTestToolkit.openFile')!(); assert.deepEqual(h.opened, [local.fsPath]);
    await h.commands.get('kotTestToolkit.openMxlFile')!(); assert.deepEqual(h.opened, [local.fsPath, local.fsPath]);
    const args = JSON.parse(decodeURIComponent(new URL(links[0].target.toString()).search.slice(1)));
    await h.commands.get('kotTestToolkit.openFile')!(args[0]); assert.equal(h.opened.length, 3);
    h.text('And I open "different"'); await h.commands.get('kotTestToolkit.openFile')!(args[0]); assert.equal(h.opened.length, 3);
});

test('duplicate names offer a choice; cancellation opens nothing; indexes refresh when attachments are added', async t => {
    const h = await fixture(t); const a = await h.create('A/files/document.csv'); const b = await h.create('B/files/document.mxl');
    h.projectFiles.push(a, b); h.register();
    await h.commands.get('kotTestToolkit.openFile')!(); assert.equal(h.picked().length, 2); assert.equal(h.opened.length, 1);
    h.cancel(); await h.commands.get('kotTestToolkit.openFile')!(); assert.equal(h.opened.length, 1);
    const count = h.scans(); await h.navigation.provideDocumentLinks(h.document, { isCancellationRequested: false });
    const once = h.scans(); await h.navigation.provideDocumentLinks(h.document, { isCancellationRequested: false }); assert.equal(h.scans(), once);
    assert.ok(once >= count); h.invalidate(); await h.navigation.provideDocumentLinks(h.document, { isCancellationRequested: false }); assert.ok(h.scans() > once);
});

test('Library attachments outside the workspace resolve through its service; explicit paths never select a different directory', async t => {
    const h = await fixture(t); const linked = await h.create('Library/files/data.json');
    h.items.push({ displayText: 'Imported scenario', template: 'Imported scenario', attachmentPaths: ['data.json'], root: path.dirname(linked.fsPath) });
    h.text('And I open "data.json"'); h.active.selection.active.character = 16;
    assert.equal((await h.navigation.fromEditor())?.fsPath, linked.fsPath);
    h.projectFiles.push(linked); h.text('And I open "Missing/data.json"');
    assert.equal(await h.navigation.fromEditor(), undefined);
    const token = { isCancellationRequested: true };
    assert.equal((await h.navigation.provideDocumentLinks(h.document, token)).length, 0);
    await fs.unlink(linked.fsPath); h.text('And I open "data.json"'); assert.equal(await h.navigation.fromEditor(), undefined);
});
