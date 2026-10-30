import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import * as authoring from '../src/vanessaControlAuthoring';
import * as insertion from '../src/gherkinInsertionContext';

function harness(formatChecks?: (text: string) => Promise<string>) {
    const commands = new Map<string, (...args: any[]) => any>(); const contexts = new Map<string, unknown>();
    const listeners: Array<() => unknown> = []; const errors: string[] = []; const edits: any[] = [];
    const documents = new Map<string, any>(); const files = new Map<string, string>();
    let contentProvider: any; const progress: string[] = []; const output = { text: '', shown: false };
    const uri = (value: string) => ({ scheme: value.split(':')[0], fsPath: value.replace(/^file:\/\//u, ''), toString: () => value });
    class Position { constructor(readonly line: number, readonly character: number) {} }
    class Range { constructor(readonly start: Position, readonly end: Position) {} }
    const document: any = { uri: uri('file:///own.feature'), version: 1, languageId: 'feature', eol: 1, text: '# language: en\nFeature: Own\n  Scenario: Own\n    \n',
        getText() { return this.text; }, get lineCount() { return this.text.split(/\r\n|\r|\n/u).length; },
        lineAt(line: number) { return { text: this.text.split(/\r\n|\r|\n/u)[line] }; },
        offsetAt(position: Position) {
            const breaks = [...this.text.matchAll(/\r\n|\r|\n/gu)];
            const previous = breaks[position.line - 1];
            return (previous ? previous.index + previous[0].length : 0) + position.character;
        },
        positionAt(offset: number) { const lines = this.text.slice(0, offset).split(/\r\n|\r|\n/u); return new Position(lines.length - 1, lines.at(-1)!.length); } };
    documents.set(document.uri.toString(), document);
    const editor: any = { document, selection: { active: new Position(3, 4) }, edit: async (work: any, options: any) => {
        work({ replace: (range: Range, text: string) => { edits.push({ range, text, options }); const from = document.offsetAt(range.start); const to = document.offsetAt(range.end);
            document.text = document.text.slice(0, from) + text + document.text.slice(to); document.version++; } }); return true;
    } };
    const window: any = { activeTextEditor: editor, createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        createOutputChannel: () => ({ clear: () => { output.text = ''; }, append: (text: string) => { output.text += text; }, show: () => { output.shown = true; }, dispose() {} }),
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        withProgress: async (options: any, work: any) => { progress.push(options.title); return work(); },
        showErrorMessage: async (message: string) => { errors.push(message); }, showInformationMessage: async () => {},
        showTextDocument: async (doc: any) => { window.activeTextEditor = doc === document ? editor : { document: doc }; return window.activeTextEditor; } };
    const vscode = { Position, Range, Uri: { parse: uri, joinPath: (base: any, ...parts: string[]) => uri('file://' + path.posix.join(base.fsPath, ...parts)) }, EndOfLine: { CRLF: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 },
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }, l10n: { t: (value: string) => value }, window,
        workspace: { get textDocuments() { return [...documents.values()]; }, fs: {
            readFile: async (value: any) => {
                const text = files.get(value.toString());
                if (text === undefined) { throw new Error('File not found'); }
                return Buffer.from(text);
            },
            stat: async (value: any) => {
                if (!files.has(value.toString()) && !documents.has(value.toString())) { throw new Error('File not found'); }
                return {};
            }
        }, registerTextDocumentContentProvider: (_scheme: string, provider: any) => { contentProvider = provider; return { dispose() {} }; },
            openTextDocument: async (value: any) => documents.get(value.toString()) ?? { uri: value, getText: () => contentProvider.provideTextDocumentContent(value) } },
        env: { clipboard: { writeText: async () => {} } }, commands: { executeCommand: async (_command: string, key: string, value: unknown) => { contexts.set(key, value); },
            registerCommand: (name: string, work: any) => { commands.set(name, work); return { dispose() {} }; } } };
    const module = { exports: {} as any }; const ts = require('typescript') as typeof import('typescript');
    const sourceFilesModule = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/spprScenarioFiles.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module: sourceFilesModule, exports: sourceFilesModule.exports, Buffer,
            require: (name: string) => name === 'vscode' ? vscode : name === 'node:path' ? path : {} });
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlAuthoringCommands.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: (name: string) => name === 'vscode' ? vscode : name === './spprScenarioFiles' ? sourceFilesModule.exports : name.endsWith('Authoring') ? authoring : insertion });
    const session: any = { snapshot: { generation: 1, capabilities: { recording: { supported: true } } },
        onDidChange: (listener: () => void) => { listeners.push(listener); return { dispose() {} }; },
        withAuthoringControl: async (work: any) => work({ start: async () => ({ generation: session.snapshot.generation, client: 'own' }), stop: async () => 'И я нажимаю кнопку "Own"', formSteps: async () => 'And own form check' }) };
    module.exports.registerVanessaAuthoringCommands({ subscriptions: [] }, session, async () => true, formatChecks);
    return { session, listeners, contexts, window, document, editor, errors, edits, progress, output, files, workspace: vscode.workspace,
        setSource: (file: string, text: string, line: number, character: number) => {
            documents.delete(document.uri.toString()); document.uri = uri('file://' + file); document.text = text;
            document.languageId = file.endsWith('.feature') ? 'feature' : 'yaml';
            document.eol = text.includes('\r\n') ? 2 : 1;
            documents.set(document.uri.toString(), document); editor.selection.active = new Position(line, character);
        },
        generate: () => commands.get('kotTestToolkit.vanessaControl.formChecks')!(),
        run: (command: string) => commands.get('kotTestToolkit.vanessaControl.recording.' + command)!() };
}

test('form-generated steps appear in the bottom output without modifying the scenario and remain insertable', async () => {
    const h = harness(); await h.generate();
    assert.equal(h.output.text, 'And own form check'); assert.equal(h.output.shown, true); assert.equal(h.edits.length, 0);
    assert.equal(h.contexts.get('kotTestToolkit.vanessaDraftAvailable'), true);
    await h.run('insertHere'); assert.equal(h.edits.length, 1);
});

test('recording inserts directly at the current scenario without a preview or a pending-draft gate', async () => {
    const h = harness(); await h.run('start');
    h.document.text += '# authored while recording\n'; h.document.version++;
    await h.run('stop');
    assert.equal(h.edits.length, 1); assert.equal(h.edits[0].text, '    И я нажимаю кнопку "Own"\n');
    assert.equal(h.edits[0].options.undoStopBefore, true); assert.equal(h.edits[0].options.undoStopAfter, true);
    assert.equal(h.contexts.get('kotTestToolkit.vanessaDraftAvailable'), false);
    assert.ok(h.progress.length >= 2);
    await h.run('start'); assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), true);
});

test('recording accepts an SPPR feature fragment and inserts steps at its current indentation', async () => {
    for (const [text, line, character, expected] of [
        ['#language: en\n', 1, 0, '#language: en\nИ я нажимаю кнопку "Own"\n'],
        ['#language: en\nAnd existing\n', 1, 5, '#language: en\nAnd existing\nИ я нажимаю кнопку "Own"\n'],
        ['#language: en\r\nAnd existing\r\n', 1, 5, '#language: en\r\nAnd existing\r\nИ я нажимаю кнопку "Own"\r\n'],
        ['#language: en\n* Group\n    And existing\n    ', 3, 4, '#language: en\n* Group\n    And existing\n    И я нажимаю кнопку "Own"\n']
    ] as const) {
        const h = harness();
        h.setSource('/native/scen.feature', text, line, character);
        h.files.set('file:///native/meta.yaml', 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Own"\n');
        await h.run('start');
        assert.deepEqual(h.errors, []);
        assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), true);
        await h.run('stop');
        assert.deepEqual(h.errors, []);
        assert.equal(h.document.text, expected);
        assert.equal(h.edits.length, 1);
        assert.equal(h.edits[0].options.undoStopBefore, true);
        assert.equal(h.edits[0].options.undoStopAfter, true);
        assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), false);
    }
});

test('recording does not start against an editor replaced during native metadata resolution', async () => {
    const h = harness();
    h.setSource('/native/scen.feature', 'And existing\n', 0, 4);
    h.files.set('file:///native/meta.yaml', 'ТипФайла: "Сценарий"\n');
    const read = h.workspace.fs.readFile;
    h.workspace.fs.readFile = async value => {
        const content = await read(value);
        h.window.activeTextEditor = { ...h.editor, document: { ...h.document } };
        return content;
    };
    await h.run('start');
    assert.equal(h.errors.length, 1);
    assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), false);
    assert.equal(h.document.text, 'And existing\n');
});

test('recording rejects unpaired feature fragments and non-scenario metadata', async () => {
    for (const metadata of [undefined, 'ТипФайла: "Процесс"\n']) {
        const h = harness();
        h.setSource('/standalone/scen.feature', 'And existing\n', 0, 4);
        if (metadata) { h.files.set('file:///standalone/meta.yaml', metadata); }
        await h.run('start');
        assert.equal(h.errors.length, 1);
        assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), false);
        assert.equal(h.edits.length, 0);
    }
});

test('recording rejects native fragment comments, tables and multiline step arguments', async () => {
    for (const [text, line] of [
        ['#language: en\nAnd existing\n', 0],
        ['And existing\n    | Name |\n', 1],
        ['And existing\n    """\n    And text inside an argument\n    """\n', 2]
    ] as const) {
        const h = harness();
        h.setSource('/native/scen.feature', text, line, 0);
        h.files.set('file:///native/meta.yaml', 'ТипФайла: "Сценарий"\n');
        await h.run('start');
        assert.equal(h.errors.length, 1);
        assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), false);
    }
});

test('recording keeps the YAML body wrapper when inserting into an embedded scenario', async () => {
    const h = harness();
    h.setSource('/legacy/scen.yaml', 'ТипФайла: "Сценарий"\nТекстСценария: |\n    And existing\n    ', 3, 4);
    await h.run('start'); await h.run('stop');
    assert.deepEqual(h.errors, []);
    assert.equal(h.document.text, 'ТипФайла: "Сценарий"\nТекстСценария: |\n    And existing\n    И я нажимаю кнопку "Own"\n');
});

test('external stop clears the native control without a reload and allows the next recording', async () => {
    const h = harness(); await h.run('start');
    const control = h.session.withAuthoringControl; let requests = 0;
    h.session.withAuthoringControl = async () => { requests++; throw new Error('A new recording may have started since the observed external Stop'); };
    h.session.snapshot.observed = { kind: 'state', state: 'idle', recording: false };
    for (const listener of h.listeners) { await listener(); }
    assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), false);
    assert.equal(requests, 0, 'confirmed external Stop clears locally without racing with a new recording');
    assert.equal(h.edits.length, 0, 'the unavailable result must not become an invented insertion');
    h.session.withAuthoringControl = control;
    await h.run('start'); assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), true);
});

test('a recording recovered before start remains available after the new capture is inserted', async () => {
    const h = harness();
    h.session.withAuthoringControl = async (work: any) => work({ start: async () => ({ generation: 1, client: 'own', previousSteps: 'And previous capture' }), stop: async () => 'And current capture' });
    await h.run('start');
    assert.equal(h.contexts.get('kotTestToolkit.vanessaDraftAvailable'), true);
    await h.run('stop');
    assert.equal(h.edits.length, 1); assert.match(h.edits[0].text, /current capture/u);
    assert.equal(h.contexts.get('kotTestToolkit.vanessaDraftAvailable'), true);
    await h.run('insertHere');
    assert.equal(h.edits.length, 2); assert.match(h.edits[1].text, /previous capture/u);
    assert.equal(h.contexts.get('kotTestToolkit.vanessaDraftAvailable'), false);
});
test('steps returned by Stop remain insertable when its follow-up state check fails', async () => {
    const h = harness(); await h.run('start');
    h.session.withAuthoringControl = async (work: any) => work({ stop: async () => {
        throw new authoring.VanessaAuthoringError('Check recording', true, { generation: 1, client: 'own', previousSteps: 'And recovered capture' });
    } });
    await h.run('stop');
    assert.equal(h.contexts.get('kotTestToolkit.vanessaDraftAvailable'), true);
    await h.run('insertHere'); assert.equal(h.edits.length, 1); assert.match(h.edits[0].text, /recovered capture/u);
});

test('Stop acknowledges an already stopped recorder and a failed insertion never gates a new capture', async () => {
    const h = harness(); await h.run('start');
    h.session.withAuthoringControl = async (work: any) => work({ stop: async () => null });
    await h.run('stop'); assert.equal(h.edits.length, 0); assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), false);
    h.session.withAuthoringControl = async (work: any) => work({ start: async () => ({ generation: 1, client: 'own' }), stop: async () => 'And own' });
    await h.run('start'); h.document.isClosed = true; h.window.activeTextEditor = undefined; await h.run('stop');
    assert.equal(h.contexts.get('kotTestToolkit.vanessaDraftAvailable'), true);
    h.document.isClosed = false; h.window.activeTextEditor = h.editor;
    await h.run('start'); assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), true);
});

test('a late uncertain recording reply cannot mark a reconnected session as recording', async () => {
    const h = harness(); let reject!: (error: Error) => void; let started!: () => void;
    const beginning = new Promise<void>(resolve => { started = resolve; });
    h.session.withAuthoringControl = () => new Promise((_resolve, failed) => { reject = failed; started(); });
    const pending = h.run('start'); await beginning;
    h.session.snapshot.generation++; for (const listener of h.listeners) { listener(); }
    reject(new authoring.VanessaAuthoringError('Unknown old capture', true)); await pending;
    assert.equal(h.contexts.get('kotTestToolkit.vanessaRecording'), false);
});


test('form-check language normalization is applied to generated checks and never to recorded actions', async () => {
    const normalized: string[] = [];
    const h = harness(async text => { normalized.push(text); return 'Then localized check'; });
    await h.generate(); assert.equal(h.output.text, 'Then localized check');
    await h.run('start'); await h.run('stop');
    assert.deepEqual(normalized, ['And own form check']);
    assert.ok(h.edits[0].text.includes('И я нажимаю кнопку'));
});
