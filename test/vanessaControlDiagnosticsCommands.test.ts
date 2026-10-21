import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as archive from '../src/vanessaControlDiagnosticArchive';
import * as snapshot from '../src/scenarioNativeDocumentSnapshot';
function setup(attach = false) {
    const commands = new Map<string, () => Promise<unknown>>(); const messages: any[] = []; const listeners: Array<() => void> = []; const errors: string[] = [];
    let dispose!: () => void; let receive!: (message: any) => unknown; const noop = () => ({ dispose() {} });
    const panel: any = { webview: { html: '', postMessage: async (message: any) => { messages.push(message); }, onDidReceiveMessage: (listener: any) => { receive = listener; return noop(); } },
        reveal() {}, onDidDispose: (callback: () => void) => { dispose = callback; return noop(); } };
    const session: any = { snapshot: { generation: 1, status: 'ready' }, onDidChange: (listener: () => void) => { listeners.push(listener); return noop(); },
        withDiagnosticControl: async (work: any) => work({ collect: async () => ({ schemaVersion: 1, createdAt: 'own', sections: [{ tool: 'get_test_results', status: 'available', text: 'Own report' }] }) }) };
    const module = { exports: {} as any }; const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlDiagnosticsCommands.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
        { module, exports: module.exports, Buffer, AbortController, console, require: (name: string) => {
            if (name.endsWith('DiagnosticArchive')) { return archive; }
            if (name.endsWith('NativeDocumentSnapshot')) { return snapshot; }
            if (name.endsWith('ControlDiagnostics')) { return { redactVanessaDiagnosticText: (text: string) => text }; }
            if (name === 'vscode') { return { ViewColumn: { Active: 1 }, ProgressLocation: { Notification: 15 }, l10n: { t: (text: string) => text },
                commands: { registerCommand: (name: string, command: any) => { commands.set(name, command); return noop(); } },
                window: { activeTextEditor: undefined, createWebviewPanel: () => panel, onDidChangeActiveTextEditor: noop,
                    withProgress: async (_options: any, work: any) => work({}, { onCancellationRequested: noop }), showErrorMessage: (message: string) => { errors.push(message); } } }; }
            return require(name);
        } });
    module.exports.registerVanessaDiagnosticsCommands({ subscriptions: [] }, session, async () => {
        if (attach) { attach = false; session.snapshot.generation++; listeners.forEach(listener => listener()); } return true;
    });
    return { session, commands, messages, errors, panel, receive: (value: any) => receive(value), close: () => dispose(), changed: () => { listeners.forEach(l => l()); } };
}
test('native diagnostic entry shows collected data, ignores unknown messages and clears it on reconnect', async () => {
    const h = setup(); await h.commands.get('kotTestToolkit.vanessaControl.diagnostics')!();
    assert.ok(h.messages.some(message => message.report?.sections[0].text === 'Own report'));
    await h.receive({ command: 'arbitrary', tool: 'run_scenario' }); assert.deepEqual(h.errors, []);
    h.session.snapshot.generation++; h.changed();
    assert.equal(h.messages.at(-1).report, undefined); h.close();
});
test('a late diagnostic response after reconnect cannot repopulate the panel', async () => {
    const h = setup(); let complete!: (report: any) => void; let started!: () => void;
    const entering = new Promise<void>(resolve => { started = resolve; });
    h.session.withDiagnosticControl = async () => { started(); return new Promise(resolve => { complete = resolve; }); };
    const pending = h.commands.get('kotTestToolkit.vanessaControl.diagnostics')!(); await entering;
    h.session.snapshot.generation++; h.changed();
    complete({ sections: [{ text: 'Stale report' }] }); await pending;
    assert.ok(!JSON.stringify(h.messages).includes('Stale report')); h.close();
});
test('attaching for the first diagnostic request does not cancel that same user request', async () => {
    const h = setup(true); await h.commands.get('kotTestToolkit.vanessaControl.diagnostics')!();
    assert.ok(h.messages.some(message => message.report?.sections[0].text === 'Own report'));
    h.close();
});
