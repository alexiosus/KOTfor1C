import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { assessVanessaControlCapabilities, normalizeVanessaControlEndpoint } from '../src/vanessaControlProtocol';
import { discoverVanessaControlEndpoints } from '../src/vanessaControlDiscovery';

function harness(live: readonly string[], candidatePorts = [6000, 7000]) {
    const tools = [{ name: 'get_vanessa_automation_state', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_editor_state', inputSchema: { type: 'object', properties: { includeContent: { type: 'boolean' } } } }];
    const commands = new Map<string, () => Promise<unknown>>(); const inspected: string[] = []; const attached: string[] = [];
    const state = new Map<string, unknown>(); const prompts: unknown[][] = []; const errors: string[] = [];
    const listeners: Array<(snapshot: unknown) => void> = [];
    const status: any = { show() {}, hide() {} };
    let resolvePorts: () => Promise<readonly number[]> = async () => candidatePorts;
    let initial!: () => void;
    const noop = () => ({ dispose() {} });
    class Session {
        snapshot: any = { generation: 0, status: 'detached' };
        onDidChange(listener: typeof listeners[number]) { listeners.push(listener); return noop(); }
        async attach(_transport: unknown, endpoint: string) {
            attached.push(endpoint); this.snapshot = { generation: this.snapshot.generation + 1, status: 'ready', capabilities: assessVanessaControlCapabilities(tools) };
            for (const notify of listeners) { notify(this.snapshot); }
        }
        async detach() { this.snapshot = { generation: this.snapshot.generation + 1, status: 'detached' }; for (const notify of listeners) { notify(this.snapshot); } }
        async refreshState() {}
    }
    class Transport {
        endpoint = '';
        async initialize(endpoint: string) { inspected.push(endpoint); this.endpoint = endpoint; if (!live.includes(endpoint)) { throw new Error('closed'); } }
        async listTools() { return tools; }
        async dispose() {}
    }
    const module = { exports: {} as Record<string, unknown> };
    const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlConnection.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, AbortController, URL, Error,
        setTimeout: (callback: () => void) => { initial = callback; return { unref() {} }; }, clearTimeout() {},
        setInterval: () => ({ unref() {} }), clearInterval() {},
        require: (name: string) => {
            if (name === 'vscode') { return { l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/gu, (_token, index) => String(args[Number(index)])) }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
                workspace: { isTrusted: true, getConfiguration: () => ({ get: () => true }) },
                window: { createStatusBarItem: () => status,
                    showQuickPick: async (items: unknown[]) => { prompts.push(items); return items[1]; },
                    showInputBox: async () => { throw new Error('Unexpected endpoint input'); }, showErrorMessage: (error: string) => errors.push(error),
                    showInformationMessage: async () => undefined },
                commands: { registerCommand: (name: string, handler: () => Promise<unknown>) => { commands.set(name, handler); return noop(); }, executeCommand: async () => undefined } }; }
            if (name === './vanessaControlSession') { return { VanessaControlSession: Session }; }
            if (name === './vanessaControlTransport') { return { VanessaControlHttpTransport: Transport }; }
            if (name === './vanessaControlProtocol') { return { assessVanessaControlCapabilities, normalizeVanessaControlEndpoint }; }
            if (name === './vanessaControlReadiness') { return {}; }
            if (name === './vanessaControlManagedRun') { return { VanessaManagedRun: class {} }; }
            if (name === './vanessaControlDiscovery') { return { discoverVanessaControlEndpoints, localOneCListeningPorts: () => resolvePorts() }; }
            return require(name);
        } });
    const register = module.exports.registerVanessaControl as (...args: unknown[]) => { ensureConnected(): Promise<boolean>; session: Session };
    const control = register({ subscriptions: [], workspaceState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
        update: async (key: string, value: unknown) => { state.set(key, value); } }, secrets: { get: async () => undefined } },
    { launch: async () => { throw new Error('Discovery must not launch a manager'); } });
    return { ...control, prompts, inspected, attached, errors, state, commands, status, notify: (snapshot: unknown) => { for (const listener of listeners) { listener(snapshot); } }, setPorts: (value: typeof resolvePorts) => { resolvePorts = value; },
        startup: async () => { initial(); for (let n = 0; n < 20; n++) { await new Promise<void>(resolve => setImmediate(resolve)); } } };
}

test('a single verified local Vanessa is attached without endpoint selection or entry', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp']);
    assert.equal(await h.ensureConnected(), true);
    assert.deepEqual(h.attached, ['http://127.0.0.1:6000/mcp']); assert.deepEqual(h.prompts, []); assert.deepEqual(h.errors, []);
    const inspected = h.inspected.length;
    assert.equal(await h.ensureConnected(), true); assert.equal(h.inspected.length, inspected, 'attached F11 does not scan again');
});

test('a stale unavailable session is rediscovered instead of treated as an already healthy connection', async () => {
    const live = ['http://127.0.0.1:6000/mcp']; const h = harness(live);
    await h.ensureConnected(); h.session.snapshot.status = 'unknown'; live[0] = 'http://127.0.0.1:7000/mcp';
    assert.equal(await h.ensureConnected(), true);
    assert.deepEqual(h.attached, ['http://127.0.0.1:6000/mcp', 'http://127.0.0.1:7000/mcp']);
});

test('an unavailable session that recovers after refresh is reused without scanning or reconnecting', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp']); await h.ensureConnected(); const reads = h.inspected.length;
    h.session.snapshot.status = 'unknown'; h.session.refreshState = async () => { h.session.snapshot.status = 'ready'; };
    assert.equal(await h.ensureConnected(), true); assert.equal(h.session.snapshot.status, 'ready');
    assert.equal(h.inspected.length, reads); assert.equal(h.attached.length, 1);
});
test('automatic state polling keeps Ready stable while explicit long requests display progress', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp']); await h.ensureConnected();
    const ready = h.status.text;
    h.notify({ ...h.session.snapshot, request: { tool: 'get_vanessa_automation_state', count: 1 } });
    assert.equal(h.status.text, ready);
    h.notify({ ...h.session.snapshot, request: { tool: 'get_form_analysis', count: 1 } });
    assert.match(h.status.text, /loading~spin/u); assert.match(h.status.text, /Reading form/u);
    h.notify(h.session.snapshot); assert.equal(h.status.text, ready);
});

test('startup does not choose between live sessions; an explicit action asks once', async () => {
    const live = ['http://127.0.0.1:6000/mcp', 'http://127.0.0.1:7000/mcp']; const h = harness(live);
    await h.startup(); assert.deepEqual(h.attached, []); assert.deepEqual(h.prompts, []);
    assert.equal(await h.ensureConnected(), true);
    assert.deepEqual(h.attached, [live[1]]); assert.deepEqual(h.prompts.map(items => Array.from(items)), [live]);
});

test('detach cancels discovery and prevents a late result from attaching another session', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp']); let release!: (ports: number[]) => void;
    h.setPorts(() => new Promise(resolve => { release = resolve; }));
    const pending = h.ensureConnected(); await h.commands.get('kotTestToolkit.vanessaControl.detach')!(); release([6000]);
    assert.equal(await pending, false); assert.deepEqual(h.attached, []); assert.deepEqual(h.prompts, []);
});
