import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { assessVanessaControlCapabilities, normalizeVanessaControlEndpoint } from '../src/vanessaControlProtocol';
import { discoverVanessaControlEndpoints } from '../src/vanessaControlDiscovery';
import { VanessaManagedRun } from '../src/vanessaControlManagedRun';

function harness(live: readonly string[], candidatePorts = [6000, 7000], autoAttach = true,
    startupOptions: { autoStart?: boolean; canAutoStart?: boolean; trusted?: boolean; recoveredLog?: string; useCurrent?: boolean } = {}) {
    const tools = [{ name: 'get_vanessa_automation_state', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_editor_state', inputSchema: { type: 'object', properties: { includeContent: { type: 'boolean' } } } }];
    const commands = new Map<string, () => Promise<unknown>>(); const inspected: string[] = []; const attached: string[] = [];
    const state = new Map<string, unknown>(); const prompts: unknown[][] = []; const errors: string[] = [];
    const tracked: Array<{ file: string; log?: string }> = [];
    const listeners: Array<(snapshot: unknown) => void> = [];
    const subscriptions: Array<{ dispose(): void }> = []; let launches = 0; let trusted = startupOptions.trusted !== false; let informationPrompts = 0;
    const status: any = { show() {}, hide() {}, dispose() {} };
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
        ownedBreakpointsForSource() { return []; }
        async run() { this.snapshot.execution = { status: 'passed' }; }
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
                workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'autoAttach' ? autoAttach : key === 'autoStart' ? startupOptions.autoStart ?? false : fallback }) },
                window: { createStatusBarItem: () => status,
                    showQuickPick: async (items: unknown[]) => { prompts.push(items); return items[1]; },
                    showInputBox: async () => { throw new Error('Unexpected endpoint input'); }, showErrorMessage: (error: string) => errors.push(error),
                    showInformationMessage: async (_message: string, _options: unknown, current: string) => { informationPrompts++; return startupOptions.useCurrent ? current : undefined; },
                    withProgress: async (_options: unknown, work: (progress: unknown, token: unknown) => Promise<unknown>) => work({}, { onCancellationRequested: noop, isCancellationRequested: false }) },
                commands: { registerCommand: (name: string, handler: () => Promise<unknown>) => { commands.set(name, handler); return noop(); }, executeCommand: async () => undefined } }; }
            if (name === './vanessaControlSession') { return { VanessaControlSession: Session }; }
            if (name === './vanessaControlTransport') { return { VanessaControlHttpTransport: Transport }; }
            if (name === './vanessaControlProtocol') { return { assessVanessaControlCapabilities, normalizeVanessaControlEndpoint }; }
            if (name === './vanessaControlReadiness') { return { awaitVanessaControlReady: async (attach: () => Promise<unknown>) => attach() }; }
            if (name === 'node:net') { return { createServer: () => ({ once() {}, listen(_port: number, _host: string, ready: () => void) { ready(); }, address: () => ({ port: 8888 }), close(done: () => void) { done(); } }) }; }
            if (name === './vanessaControlManagedRun') { return { VanessaManagedRun }; }
            if (name === './vanessaControlDiscovery') { return { discoverVanessaControlEndpoints, localOneCListeningPorts: () => resolvePorts() }; }
            return require(name);
        } });
    const register = module.exports.registerVanessaControl as (...args: unknown[]) => { ensureConnected(): Promise<boolean>; runLogPath(): string | undefined; session: Session; runFeature(request: Parameters<VanessaManagedRun['run']>[0]): ReturnType<VanessaManagedRun['run']> };
    const control = register({ subscriptions, workspaceState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
        update: async (key: string, value: unknown) => { state.set(key, value); } }, secrets: { get: async () => undefined } },
    { managedRunLog: (port: number) => port === 8888 ? '/own/manager.log' : undefined,
        attachedRunLog: async () => startupOptions.recoveredLog, trackRun: (file: string, log?: string) => { tracked.push({ file, log }); return async () => {}; },
        launch: async () => { launches++; return true; }, canAutoStart: () => startupOptions.canAutoStart !== false });
    return { ...control, prompts, inspected, attached, errors, state, commands, status, tracked, notify: (snapshot: unknown) => { for (const listener of listeners) { listener(snapshot); } }, setPorts: (value: typeof resolvePorts) => { resolvePorts = value; },
        launches: () => launches, informationPrompts: () => informationPrompts, trust: (value: boolean) => { trusted = value; },
        dispose: () => { for (const disposable of subscriptions) { disposable.dispose(); } },
        startup: async () => { initial(); for (let n = 0; n < 20; n++) { await new Promise<void>(resolve => setImmediate(resolve)); } } };
}

test('explicit Connect starts a managed session when discovery finds none without a second confirmation', async () => {
    const h = harness([]);
    await h.commands.get('kotTestToolkit.vanessaControl.connect')!();
    assert.equal(h.launches(), 1); assert.equal(h.informationPrompts(), 0);
    assert.deepEqual(h.attached, ['http://127.0.0.1:8888/mcp']); assert.deepEqual(h.errors, []);
});

test('startup launching is opt-in, checks readiness and trust, and discovers even when auto-attach is disabled', async () => {
    const off = harness([]); await off.startup(); assert.equal(off.launches(), 0);
    for (const options of [{ canAutoStart: false }, { trusted: false }]) {
        const h = harness([], [], true, { autoStart: true, ...options }); await h.startup(); assert.equal(h.launches(), 0);
    }
    const live = harness(['http://127.0.0.1:6000/mcp'], [6000], false, { autoStart: true });
    await live.startup(); assert.equal(live.launches(), 0); assert.equal(live.attached.length, 1);
    const empty = harness([], [], false, { autoStart: true }); await empty.startup();
    assert.equal(empty.launches(), 1); assert.equal(empty.informationPrompts(), 0);
    await empty.startup(); assert.equal(empty.launches(), 1, 'the activation attempt is never repeated');
});

test('multiple discovered sessions, disposal and trust revocation prevent automatic launch', async () => {
    const multiple = harness(['http://127.0.0.1:6000/mcp', 'http://127.0.0.1:7000/mcp'], undefined, true, { autoStart: true });
    await multiple.startup(); assert.equal(multiple.launches(), 0); assert.equal(multiple.prompts.length, 0);
    const disposed = harness([], [], true, { autoStart: true }); disposed.dispose(); await disposed.startup(); assert.equal(disposed.launches(), 0);
    const revoked = harness([], [], true, { autoStart: true });
    revoked.setPorts(async () => { revoked.trust(false); return []; }); await revoked.startup(); assert.equal(revoked.launches(), 0);
});

test('a single verified local Vanessa is attached without endpoint selection or entry', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp']);
    assert.equal(await h.ensureConnected(), true);
    assert.deepEqual(h.attached, ['http://127.0.0.1:6000/mcp']); assert.deepEqual(h.prompts, []); assert.deepEqual(h.errors, []);
    const inspected = h.inspected.length;
    assert.equal(await h.ensureConnected(), true); assert.equal(h.inspected.length, inspected, 'attached F11 does not scan again');
});

test('disabling background auto-attach still allows explicit Connect discovery', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp'], [6000], false);
    await h.startup(); assert.deepEqual(h.attached, []);
    await h.commands.get('kotTestToolkit.vanessaControl.connect')!();
    assert.deepEqual(h.attached, ['http://127.0.0.1:6000/mcp']); assert.deepEqual(h.prompts, []);
});

test('Connect Vanessa discovers only the manager and connection settings keeps legacy launch available', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp']);
    assert.ok(h.commands.has('kotTestToolkit.vanessaControl.connect'));
    await h.commands.get('kotTestToolkit.vanessaControl.connect')!();
    assert.deepEqual(h.attached, ['http://127.0.0.1:6000/mcp']);
    assert.deepEqual(h.prompts, []);
    await h.commands.get('kotTestToolkit.vanessaControl.connectionSettings')!();
    const items = h.prompts[0] as Array<{ label: string }>;
    assert.ok(items.some(row => row.label === 'Legacy process / Debug launch…'));
    assert.ok(!items.some(row => row.label === 'Stop execution'));
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


test('a managed session log is available only for its confirmed attachment generation', async () => {
    const h = harness([]);
    assert.equal(h.runLogPath(), undefined);
    await h.commands.get('kotTestToolkit.vanessaControl.connect')!();
    assert.equal(h.runLogPath(), '/own/manager.log');
    await h.session.attach({}, 'http://127.0.0.1:8888/mcp');
    assert.equal(h.runLogPath(), undefined);
});

test('Run with current session settings keeps its recovered log for every feature without launching a manager', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp'], [6000], true, { recoveredLog: '/current/session.log', useCurrent: true });
    assert.equal(await h.ensureConnected(), true); assert.equal(h.runLogPath(), '/current/session.log');
    for (const file of ['one.feature', 'two.feature']) {
        assert.equal(await h.runFeature({ filePath: file, sourceText: 'steps', isCurrent: () => true, configurationKey: file, launch: async () => assert.fail('Do not launch another manager') }), 'passed');
    }
    assert.deepEqual(h.tracked, [{ file: 'one.feature', log: '/current/session.log' }, { file: 'two.feature', log: '/current/session.log' }]);
    assert.equal(h.launches(), 0);
    await h.session.detach(); assert.equal(h.runLogPath(), undefined);
});
