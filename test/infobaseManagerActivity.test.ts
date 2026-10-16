import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { InfobaseRuntimeTracker } from '../src/infobaseRuntimeTracker';
import { normalizeInfobaseConnectionIdentity } from '../src/oneCInfobaseConnection';

test('full infobase manager receives live process activity and shares the template operation', async () => {
    const tracker = new InfobaseRuntimeTracker(); const messages: any[] = []; const updates: any[] = [];
    const record = { infobasePath: 'C:\\QA', displayName: 'QA', hidden: false };
    const service = { onDidInvalidate: () => ({ dispose() {} }), refresh: async () => ({ infobases: [record] }), ensureReady: async () => ({ infobases: [record] }) };
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    const dependencies: Record<string, unknown> = {
        vscode: { workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) }, window: { showErrorMessage: (error: string) => assert.fail(error) } },
        './infobaseRuntimeTracker': { managedInfobaseRuntimeTracker: tracker }, './oneCInfobaseConnection': { normalizeInfobaseConnectionIdentity },
        './localization': { getTranslator: async () => (message: string) => message },
        './oneCPlatform': { ensureOneCPlatformsCatalogInitialized: async () => [] },
        './infobaseManager': { updateInfobaseConfigurationInteractive: async (...args: unknown[]) => updates.push(args) }
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/infobaseManagerPanel.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name] ?? {}, console });
    const context = { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } };
    const panel = new module.exports.InfobaseManagerPanel(context, service);
    panel.panel = { webview: { postMessage: async (value: unknown) => messages.push(value) } };
    panel.infobases = [record]; panel.selectedInfobasePath = record.infobasePath;
    const listeners = new Map<string, () => void>();
    tracker.track(record.infobasePath, { pid: 101, once: (event: string, callback: () => void) => listeners.set(event, callback) });
    assert.equal(messages.at(-1).state.infobases[0].running, true);
    listeners.get('exit')!();
    assert.equal(messages.at(-1).state.infobases[0].running, false);
    await panel.handleMessage({ command: 'updateFromTemplate', infobasePath: record.infobasePath });
    assert.equal(updates.length, 1); assert.equal(updates[0][2], 'template');
    assert.ok(messages.some(message => message.state.infobases[0]?.operation));
    assert.equal(messages.at(-1).state.infobases[0].operation, null);
});
