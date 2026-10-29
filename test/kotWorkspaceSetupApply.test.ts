import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
    const uri = { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' };
    const saved = new Map<string, unknown>(); const events: Array<{ type: string; label?: string; id?: string }> = [];
    const nativeRequire = createRequire(__filename);
    const manager = { loadActiveProfileSnapshot: async () => ({ buildParameters: [] }), validateCompilerBuildParameters: () => [] };
    const mocks: Record<string, unknown> = {
        vscode: { workspace: { isTrusted: true, workspaceFolders: [{ uri }], textDocuments: [], onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
            ProgressLocation: { Notification: 15 }, window: { withProgress: async (_options: unknown, work: (progress: { report(value: unknown): void }) => unknown) => work({ report() {} }) },
            commands: { executeCommand: async () => undefined } },
        './yamlParametersManager': { YamlParametersManager: { getInstance: () => manager } },
        './projectSetupGate': { completeProjectSetup() {} },
        './kotProjectSetup': { assertPrimarySetupFolder() {} },
        './workspaceScanner.js': { scanWorkspaceForScenarioCatalog: async (_uri: unknown, _token: unknown, report?: (value: unknown) => void) => {
            report?.({ label: 'Reading scenario source files…', completed: 2, total: 2 });
        } }
    };
    const exports: Record<string, any> = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/kotWorkspacePanel.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { exports, require: (id: string) => id.startsWith('node:') ? nativeRequire(id) : mocks[id] ?? {}, console: { info() {} }, process, Error });
    const panel = new exports.KotWorkspacePanel({ workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: unknown) => { saved.set(key, value); } } });
    panel.panel = { webview: { postMessage: async (message: typeof events[number]) => { events.push(message); } } };
    panel.review = { id: 'review', folder: uri.toString(), draft: { run: true, mode: 'sppr' }, filesApplied: true, settingsApplied: true, profileApplied: true, platformApplied: true };
    return { panel, events, saved, manager };
}

test('setup completes and persists readiness without waiting for Vanessa interaction', async () => {
    const h = fixture(); let prepareCalled = false;
    h.panel.bindExecution(() => { prepareCalled = true; return new Promise(() => {}); });
    let result: any;
    void h.panel.applySetup('review', 'request').then((value: unknown) => { result = value; });
    await flush();
    assert.equal(result?.complete, true);
    assert.equal(prepareCalled, false);
    assert.equal((h.saved.values().next().value as any).step, 6);
    assert.ok(h.events.some(event => event.type === 'setupProgress' && event.id === 'request' && event.label === 'Reading scenario source files…'));
});

test('setup reserves application before asynchronous preflight and releases it on error', async () => {
    const h = fixture(); h.panel.review.profileApplied = false;
    const profile = { buildParameters: [] };
    h.panel.review.profileToken = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    let reject!: (error: Error) => void;
    h.manager.loadActiveProfileSnapshot = () => new Promise((_resolve, fail) => { reject = fail; });
    const first = h.panel.applySetup('review', 'first');
    await assert.rejects(h.panel.applySetup('review', 'second'), /Review the setup changes again/u);
    reject(new Error('Profile unavailable'));
    await assert.rejects(first, /Profile unavailable/u);
    assert.equal(h.panel.applying, false);
});

test('a failed Vanessa preparation retains completed setup and can be retried', async () => {
    const h = fixture(); await h.panel.applySetup('review', 'apply');
    let fail!: (error: Error) => void;
    h.panel.bindExecution(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = h.panel.retryExecution('file:///project');
    await assert.rejects(h.panel.retryExecution('file:///project'), /already in progress/u);
    fail(new Error('Launch failed'));
    await assert.rejects(first, /Launch failed/u);
    const saved = h.saved.values().next().value as any;
    assert.equal(saved.complete, true);
    assert.equal(saved.readiness.executionError, 'Launch failed');
    h.panel.bindExecution(async () => true);
    assert.equal((await h.panel.retryExecution('file:///project')).executionReady, true);
    assert.equal((h.saved.values().next().value as any).readiness.executionError, '');
});
