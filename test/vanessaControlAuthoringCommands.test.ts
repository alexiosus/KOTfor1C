import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as authoring from '../src/vanessaControlAuthoring';
import * as insertion from '../src/gherkinInsertionContext';

function harness(formatChecks?: (text: string) => Promise<string>) {
    const commands = new Map<string, (...args: any[]) => any>(); const contexts = new Map<string, unknown>();
    const listeners: Array<() => unknown> = []; const errors: string[] = []; const edits: any[] = [];
    const documents = new Map<string, any>(); let contentProvider: any; const progress: string[] = []; const output = { text: '', shown: false };
    const uri = (value: string) => ({ scheme: value.split(':')[0], fsPath: value.replace(/^file:\/\//u, ''), toString: () => value });
    class Position { constructor(readonly line: number, readonly character: number) {} }
    class Range { constructor(readonly start: Position, readonly end: Position) {} }
    const document: any = { uri: uri('file:///own.feature'), version: 1, languageId: 'feature', eol: 1, text: '# language: en\nFeature: Own\n  Scenario: Own\n    \n',
        getText() { return this.text; }, get lineCount() { return this.text.split('\n').length; },
        lineAt(line: number) { return { text: this.text.split('\n')[line] }; },
        offsetAt(position: Position) { return this.text.split('\n').slice(0, position.line).reduce((sum: number, line: string) => sum + line.length + 1, 0) + position.character; },
        positionAt(offset: number) { const lines = this.text.slice(0, offset).split('\n'); return new Position(lines.length - 1, lines.at(-1)!.length); } };
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
    const vscode = { Position, Range, Uri: { parse: uri }, EndOfLine: { CRLF: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 },
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }, l10n: { t: (value: string) => value }, window,
        workspace: { registerTextDocumentContentProvider: (_scheme: string, provider: any) => { contentProvider = provider; return { dispose() {} }; },
            openTextDocument: async (value: any) => documents.get(value.toString()) ?? { uri: value, getText: () => contentProvider.provideTextDocumentContent(value) } },
        env: { clipboard: { writeText: async () => {} } }, commands: { executeCommand: async (_command: string, key: string, value: unknown) => { contexts.set(key, value); },
            registerCommand: (name: string, work: any) => { commands.set(name, work); return { dispose() {} }; } } };
    const module = { exports: {} as any }; const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlAuthoringCommands.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: (name: string) => name === 'vscode' ? vscode : name.endsWith('Authoring') ? authoring : insertion });
    const session: any = { snapshot: { generation: 1, capabilities: { recording: { supported: true } } },
        onDidChange: (listener: () => void) => { listeners.push(listener); return { dispose() {} }; },
        withAuthoringControl: async (work: any) => work({ start: async () => ({ generation: session.snapshot.generation, client: 'own' }), stop: async () => 'И я нажимаю кнопку "Own"', formSteps: async () => 'And own form check' }) };
    module.exports.registerVanessaAuthoringCommands({ subscriptions: [] }, session, async () => true, formatChecks);
    return { session, listeners, contexts, window, document, editor, errors, edits, progress, output,
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
