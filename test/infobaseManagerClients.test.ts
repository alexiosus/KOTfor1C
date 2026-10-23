import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as clientService from '../src/vanessaInfobaseClients';
import { normalizeInfobaseConnectionIdentity } from '../src/oneCInfobaseConnection';

test('full manager binds client actions to an existing base and updates clients without a base rescan', async () => {
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    const calls: Array<{ base: string; packet: unknown }> = []; const messages: any[] = []; let scans = 0;
    const noop = () => ({ dispose() {} });
    const dependencies: Record<string, unknown> = {
        vscode: { workspace: { onDidChangeConfiguration: noop }, commands: { executeCommand: async () => undefined } },
        './vanessaInfobaseClients': clientService,
        './infobaseRuntimeTracker': { managedInfobaseRuntimeTracker: { onDidChange: noop, runningIdentities: () => new Set() } },
        './oneCInfobaseConnection': { normalizeInfobaseConnectionIdentity },
        './localization': { getTranslator: async () => (message: string) => message }
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/infobaseManagerPanel.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name] ?? {} });
    const service = { onDidInvalidate: noop, refresh: async () => { scans++; }, ensureReady: async () => { scans++; } };
    const panel = new module.exports.InfobaseManagerPanel({ workspaceState: { get: () => undefined } }, service, {
        service: { onDidChange: noop, stateFor: (base: string) => ({ rows: [], base }) },
        handle: async (base: string, packet: unknown) => { calls.push({ base, packet }); return true; }
    });
    panel.panel = { webview: { postMessage: async (value: unknown) => messages.push(value) } };
    panel.infobases = [{ infobasePath: 'C:\\QA', displayName: 'QA' }]; panel.selectedInfobasePath = 'C:\\QA';
    await panel.handleMessage({ command: 'clientRefresh', infobasePath: 'c:\\qa' });
    assert.equal(calls[0].base, 'C:\\QA'); assert.equal(scans, 0);
    assert.equal(messages.at(-1).state.vanessaClients.base, 'C:\\QA');
    await panel.handleMessage({ command: 'clientRemove', infobasePath: 'C:\\Foreign', clientId: 'own' });
    assert.equal(calls.length, 1); assert.equal(scans, 0);
    assert.equal(messages.at(-1).state.lastError, 'Select an infobase first.');
    await panel.handleMessage({ command: 'clientRemove', clientId: 'own' });
    await panel.handleMessage({ command: 'clientRemove', infobasePath: {}, clientId: 'own' });
    assert.equal(calls.length, 1);
    let release!: (draft: unknown) => void;
    panel.clients.service.editorFor = () => new Promise(resolve => { release = resolve; });
    const reading = panel.handleMessage({ command: 'clientEdit', infobasePath: 'C:\\QA', clientId: 'own', requestId: '1' });
    await new Promise<void>(resolve => setImmediate(resolve));
    const replacementMessages: any[] = [];
    panel.panel = { webview: { postMessage: async (value: unknown) => replacementMessages.push(value) } };
    release({ password: 'private' }); await reading;
    assert.ok(!replacementMessages.some(message => message.command === 'clientEditor'));
    assert.ok(!JSON.stringify(replacementMessages).includes('private'));
});
