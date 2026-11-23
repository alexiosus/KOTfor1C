import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { assessVanessaControlCapabilities, normalizeVanessaControlEndpoint, sameVanessaFeaturePath } from '../src/vanessaControlProtocol';
import { discoverVanessaControlEndpoints } from '../src/vanessaControlDiscovery';
import { VanessaManagedRun } from '../src/vanessaControlManagedRun';
import * as runtimeSettings from '../src/vanessaControlSettings';

function harness(live: readonly string[], candidatePorts = [6000, 7000], autoAttach = true,
    startupOptions: { autoStart?: boolean; canAutoStart?: boolean; trusted?: boolean; recoveredLog?: string; useCurrent?: boolean;
        useTestJson?: boolean; confirmSettings?: boolean; editAfterRun?: boolean } = {}) {
    const tools = startupOptions.useTestJson ? JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.47/tools.live.json', 'utf8')).tools
        : [{ name: 'get_vanessa_automation_state', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_editor_state', inputSchema: { type: 'object', properties: { includeContent: { type: 'boolean' } } } }];
    const commands = new Map<string, () => Promise<unknown>>(); const inspected: string[] = []; const attached: string[] = [];
    const state = new Map<string, unknown>(); const prompts: unknown[][] = []; const errors: string[] = [];
    const contexts = new Map<string, unknown>();
    const tracked: Array<{ file: string; log?: string }> = [];
    const progressTitles: string[] = [];
    const timers: Array<{ callback(): void; delay: number; active: boolean; unref(): void }> = [];
    const listeners: Array<(snapshot: unknown) => void> = [];
    const subscriptions: Array<{ dispose(): void }> = []; let launches = 0; let trusted = startupOptions.trusted !== false; let informationPrompts = 0;
    const settingsCalls: Record<string, unknown>[] = [];
    const runEvents: string[] = [];
    const sessionChoices: string[][] = [];
    const settingPath = 'RunningScripts.stoponerror';
    let settingValue = 'false'; let revision = 1;
    const restoreOffers: Array<{ message: string; choose(answer: string): void }> = [];
    class TextTabInput {
        readonly uri: { scheme: 'file'; fsPath: string };
        constructor(fsPath: string) { this.uri = { scheme: 'file', fsPath }; }
    }
    const tab = (file: string) => ({ input: new TextTabInput(file) });
    let openTabs: ReturnType<typeof tab>[][] = [];
    let tabsChanged: (event: { closed: ReturnType<typeof tab>[] }) => void;
    let menuChoice: string | undefined;
    const status: any = { show() {}, hide() {}, dispose() {} };
    let resolvePorts: () => Promise<readonly number[]> = async () => candidatePorts;
    let initial!: () => void;
    const noop = () => ({ dispose() {} });
    class Session {
        busy = false;
        snapshot: any = { generation: 0, status: 'detached' };
        onDidChange(listener: typeof listeners[number]) { listeners.push(listener); return noop(); }
        async attach(_transport: unknown, endpoint: string) {
            attached.push(endpoint); this.snapshot = { generation: this.snapshot.generation + 1, status: 'ready', capabilities: assessVanessaControlCapabilities(tools) };
            for (const notify of listeners) { notify(this.snapshot); }
        }
        async detach() { this.snapshot = { generation: this.snapshot.generation + 1, status: 'detached' }; for (const notify of listeners) { notify(this.snapshot); } }
        async refreshState() {}
        ownedBreakpointsForSource() { return []; }
        async run() {
            runEvents.push(`run with ${settingValue}`);
            if (startupOptions.editAfterRun) { settingValue = 'newer value'; }
            this.snapshot.execution = { status: 'passed' };
        }
        async withSettingsControl<T>(work: (settings: runtimeSettings.VanessaRuntimeSettings) => Promise<T>, current: () => boolean) {
            return work(new runtimeSettings.VanessaRuntimeSettings(async (_name, args) => {
                assert.ok(current());
                settingsCalls.push(args);
                const action = String(args.action); const dryRun = args.dry_run === true;
                if (action === 'set') { assert.equal(args.expected_current_value, settingValue); settingValue = String(args.value); revision++; }
                if (action === 'apply' && !dryRun) { settingValue = 'true'; revision++; }
                const changed = action === 'list' ? [] : [settingPath];
                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, revision, errors: [], warnings: [], ignored: [],
                    out_of_scope: [], changed, applied: changed, dry_run: dryRun,
                    items: [{ key: 'stoponerror', path: settingPath, current: settingValue, current_present: true, settable: true, type: 'boolean' }] }) }] };
            }));
        }
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
        setTimeout: (callback: () => void, delay: number) => { if (delay === 500) { initial = callback; } const timer = { callback, delay, active: true, unref() {} }; timers.push(timer); return timer; },
        clearTimeout: (timer?: { active: boolean }) => { if (timer) { timer.active = false; } },
        setInterval: () => ({ unref() {} }), clearInterval() {},
        require: (name: string) => {
            if (name === './kotInteraction') { return nativeInteraction; }
            if (name === 'vscode') { return { l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/gu, (_token, index) => String(args[Number(index)])) }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 }, TabInputText: TextTabInput,
                workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'autoAttach' ? autoAttach : key === 'autoStart' ? startupOptions.autoStart ?? false : fallback }) },
                window: { createStatusBarItem: () => status,
                    tabGroups: { get all() { return openTabs.map(tabs => ({ tabs })); },
                        onDidChangeTabs: (listener: typeof tabsChanged) => { tabsChanged = listener; return noop(); } },
                    showQuickPick: async (items: Array<{ label?: string }>) => {
                        prompts.push(items);
                        return menuChoice === undefined ? items[1] : items.find(item => item.label === menuChoice);
                    },
                    showInputBox: async () => { throw new Error('Unexpected endpoint input'); }, showErrorMessage: (error: string) => errors.push(error),
                    showInformationMessage: async (message: string, options: unknown, ...actions: string[]) => {
                        informationPrompts++;
                        if (options === 'Restore previous settings') {
                            runEvents.push('offer restore');
                            return new Promise(resolve => { restoreOffers.push({ message, choose: resolve }); });
                        }
                        if (typeof options === 'object') { sessionChoices.push(actions); }
                        if (startupOptions.useTestJson && actions.includes('Apply test JSON to this session…')) { return 'Apply test JSON to this session…'; }
                        return startupOptions.useCurrent ? actions[0] : undefined;
                    },
                    showWarningMessage: () => undefined,
                    withProgress: async (options: { title: string }, work: (progress: unknown, token: unknown) => Promise<unknown>) => { progressTitles.push(options.title); return work({}, { onCancellationRequested: noop, isCancellationRequested: false }); } },
                commands: { registerCommand: (name: string, handler: () => Promise<unknown>) => { commands.set(name, handler); return noop(); },
                    executeCommand: async (command: string, key: string, value: unknown) => { if (command === 'setContext') { contexts.set(key, value); } } } }; }
            if (name === './vanessaControlSession') { return { VanessaControlSession: Session }; }
            if (name === './vanessaControlTransport') { return { VanessaControlHttpTransport: Transport }; }
            if (name === './vanessaControlProtocol') { return { assessVanessaControlCapabilities, normalizeVanessaControlEndpoint, sameVanessaFeaturePath }; }
            if (name === './vanessaControlReadiness') { return { awaitVanessaControlReady: async (attach: () => Promise<unknown>) => attach() }; }
            if (name === 'node:net') { return { createServer: () => ({ once() {}, listen(_port: number, _host: string, ready: () => void) { ready(); }, address: () => ({ port: 8888 }), close(done: () => void) { done(); } }) }; }
            if (name === './vanessaControlManagedRun') { return { VanessaManagedRun }; }
            if (name === './vanessaControlSettings') { return runtimeSettings; }
            if (name === './vanessaControlSettingsReport') { return { VanessaSettingsReport: class {
                async confirm() { runEvents.push('confirm preview'); return startupOptions.confirmSettings !== false; }
                show() {}
                unconfirmed() { runEvents.push('unconfirmed'); }
                dispose() {}
            } }; }
            if (name === './vanessaControlDiscovery') { return { discoverVanessaControlEndpoints, localOneCListeningPorts: () => resolvePorts() }; }
            return require(name);
        } });
    const register = module.exports.registerVanessaControl as (...args: unknown[]) => { ensureConnected(): Promise<boolean>; ensureAgentConnected(): Promise<boolean>;
        manager(action: 'list' | 'connect' | 'start', endpoint?: string): Promise<unknown>;
        runLogPath(): string | undefined; session: Session; runFeature(request: Parameters<VanessaManagedRun['run']>[0]): ReturnType<VanessaManagedRun['run']> };
    const control = register({ subscriptions, workspaceState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
        update: async (key: string, value: unknown) => { state.set(key, value); } }, secrets: { get: async () => undefined } },
    { managedRunLog: (port: number) => port === 8888 ? '/own/manager.log' : undefined,
        attachedRunLog: async () => startupOptions.recoveredLog, trackRun: (file: string, log?: string) => { tracked.push({ file, log }); return async () => {}; },
        launch: async () => { launches++; return true; }, canAutoStart: () => startupOptions.canAutoStart !== false });
    return { ...control, prompts, inspected, attached, errors, state, contexts, commands, status, tracked, progressTitles,
        settingsCalls, runEvents, sessionChoices, restoreOffers,
        chooseRestore: () => restoreOffers.at(-1)!.choose('Restore previous settings'),
        closeTab: (closed: string, remaining: string[][] = []) => {
            openTabs = remaining.map(group => group.map(tab));
            tabsChanged({ closed: [tab(closed)] });
        },
        chooseMenuItem: async (label: string) => {
            menuChoice = label;
            try { await commands.get('kotTestToolkit.vanessaControl')!(); } finally { menuChoice = undefined; }
        },
        setting: () => settingValue,
        expireHealthCheck: () => { const timer = timers.find(timer => timer.active && timer.delay === 3_000); assert.ok(timer); timer.callback(); },
        notify: (snapshot: unknown) => { for (const listener of listeners) { listener(snapshot); } }, setPorts: (value: typeof resolvePorts) => { resolvePorts = value; },
        launches: () => launches, informationPrompts: () => informationPrompts, trust: (value: boolean) => { trusted = value; },
        dispose: () => { for (const disposable of subscriptions) { disposable.dispose(); } },
        startup: async () => { initial(); for (let n = 0; n < 20; n++) { await new Promise<void>(resolve => setImmediate(resolve)); } } };
}

test('a compiled test applies its JSON in .47 and can restore confirmed values after the run', async () => {
    for (const editAfterRun of [false, true]) {
        const h = harness(['http://127.0.0.1:6000/mcp'], [6000], true, { useTestJson: true, editAfterRun });
        try {
            assert.equal(await h.ensureConnected(), true);
            const result = await h.runFeature({ filePath: 'own.feature', sourceText: 'own', isCurrent: () => true, configurationKey: 'own',
                settings: { parameters: '{"RunningScripts":{"stoponerror":true,"CloseSystemOnComplete":true},"textlogname":"different.log"}', basePath: '/own' },
                launch: async () => { throw new Error('Unexpected new process'); } });
            assert.equal(result, 'passed');
            assert.deepEqual(h.runEvents, ['confirm preview', 'run with true', 'offer restore']);
            const applies = h.settingsCalls.filter(call => call.action === 'apply');
            assert.equal(applies.length, 2);
            assert.deepEqual(applies.map(call => [call.dry_run, call.preserve_ci_flags, call.expected_revision]), [[true, true, 1], [false, true, 1]]);
            assert.equal(applies[1].parameters_json, '{"RunningScripts":{"stoponerror":true}}');
            h.chooseRestore();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(h.setting(), editAfterRun ? 'newer value' : 'false');
            assert.equal(h.settingsCalls.some(call => call.action === 'set'), !editAfterRun);
        } finally { h.dispose(); }
    }
});

test('closing the last tab for the compiled feature reoffers restoration and the Vanessa menu can restore it', async () => {
    const filePath = 'C:\\Own\\test.feature';
    const restore = 'Restore previous settings';
    const h = harness(['http://127.0.0.1:6000/mcp'], [6000], true, { useTestJson: true });
    try {
        await h.ensureConnected();
        await h.chooseMenuItem(restore);
        assert.equal((h.prompts.at(-1)! as Array<{ label: string }>).some(item => item.label === restore), false);
        assert.equal(await h.runFeature({ filePath, sourceText: 'own', isCurrent: () => true,
            settings: { parameters: '{"stoponerror":true}', basePath: 'C:/Own' }, launch: async () => false }), 'passed');
        h.restoreOffers[0].choose('Keep applied settings');
        h.closeTab('C:\\Own\\other.feature', [[filePath]]);
        h.closeTab(filePath, [[filePath]]);
        assert.equal(h.restoreOffers.length, 1);
        h.closeTab('c:/own/test.feature');
        assert.equal(h.restoreOffers.length, 2);
        assert.match(h.restoreOffers[1].message, /compiled feature was closed/u);
        await h.chooseMenuItem(restore);
        assert.equal(h.setting(), 'false');
        h.restoreOffers[1].choose(restore);
        h.closeTab(filePath);
        await h.chooseMenuItem(restore);
        assert.equal(h.restoreOffers.length, 2);
        assert.equal(h.settingsCalls.filter(call => call.action === 'set').length, 1);
        assert.equal((h.prompts.at(-1)! as Array<{ label: string }>).some(item => item.label === restore), false);
    } finally { h.dispose(); }
});

test('closing a feature during a run waits for completion, and reconnecting invalidates the reminder', async () => {
    const filePath = 'C:\\Own\\test.feature';
    const h = harness(['http://127.0.0.1:6000/mcp'], [6000], true, { useTestJson: true });
    try {
        await h.ensureConnected();
        const run = h.session.run.bind(h.session);
        h.session.run = async () => {
            h.session.busy = true;
            h.closeTab(filePath);
            assert.equal(h.restoreOffers.length, 0);
            await run();
            h.session.busy = false;
        };
        assert.equal(await h.runFeature({ filePath, sourceText: 'own', isCurrent: () => true,
            settings: { parameters: '{"stoponerror":true}', basePath: 'C:/Own' }, launch: async () => false }), 'passed');
        assert.deepEqual(h.restoreOffers.map(offer => offer.message), ['The compiled feature was closed. Restore the previous Vanessa settings?']);
        await h.session.attach({}, 'http://127.0.0.1:7000/mcp');
        h.chooseRestore();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.settingsCalls.some(call => call.action === 'set'), false);
    } finally { h.dispose(); }
});

test('cancelling the VAParams preview makes no runtime writes, and .45 only offers its existing choices', async () => {
    const request = { filePath: 'own.feature', sourceText: 'own', isCurrent: () => true,
        settings: { parameters: '{"stoponerror":true}', basePath: '/own' }, launch: async () => false };
    for (const useTestJson of [true, false]) {
        const h = harness(['http://127.0.0.1:6000/mcp'], [6000], true, { useTestJson, confirmSettings: false });
        try {
            assert.equal(await h.ensureConnected(), true);
            assert.equal(await h.runFeature(request), 'cancelled');
            assert.deepEqual(h.sessionChoices[0].slice(-2), ['Run with current session settings', 'Prepare configured session']);
            assert.equal(h.sessionChoices[0].includes('Apply test JSON to this session…'), useTestJson);
            assert.equal(h.settingsCalls.filter(call => call.action === 'apply' && call.dry_run === false).length, 0);
            assert.deepEqual(h.runEvents, useTestJson ? ['confirm preview'] : []);
        } finally { h.dispose(); }
    }
});

test('editor execution controls reset after completion and disable repeated stop while stopping', () => {
    const h=harness([]);const executing=()=>h.contexts.get('kotTestToolkit.vanessaControlExecuting');
    const canStop=()=>h.contexts.get('kotTestToolkit.vanessaControlCanStop');
    assert.equal(executing(),false);assert.equal(canStop(),false);
    const capabilities={stop:{supported:true}};
    for(const status of ['running','stopping','ready','unknown','detached'] as const){
        h.notify({generation:1,status,...(status==='detached'?{}:{capabilities})});
        assert.equal(executing(),status==='running'||status==='stopping',status);
        assert.equal(canStop(),status!=='stopping'&&status!=='detached',status);
    }
    h.notify({generation:1,status:'running',capabilities:{stop:{supported:false}}});
    assert.equal(executing(),true);assert.equal(canStop(),false);
    h.dispose();
});

test('Stop remains visible when a state poll fails during an unfinished run', () => {
    const h=harness([]);const capabilities={stop:{supported:true}};
    h.notify({generation:1,status:'running',runActive:true,capabilities});
    h.notify({generation:1,status:'unknown',runActive:true,error:'request',capabilities});
    assert.equal(h.contexts.get('kotTestToolkit.vanessaControlExecuting'),true);
    assert.equal(h.contexts.get('kotTestToolkit.vanessaControlCanStop'),true);
    h.notify({generation:1,status:'ready',runActive:false,capabilities});
    assert.equal(h.contexts.get('kotTestToolkit.vanessaControlExecuting'),false);
    h.dispose();
});

test('explicit Connect starts a managed session when discovery finds none without a second confirmation', async () => {
    const h = harness([]);
    await h.commands.get('kotTestToolkit.vanessaControl.connect')!();
    assert.equal(h.launches(), 1); assert.equal(h.informationPrompts(), 0);
    assert.deepEqual(h.attached, ['http://127.0.0.1:8888/mcp']); assert.deepEqual(h.errors, []);
});

test('explicit Connect shows progress immediately and recovers from a closed session with a stuck state poll', async () => {
    const live = ['http://127.0.0.1:6000/mcp']; const h = harness(live);
    await h.ensureConnected();
    // The UI still has the last successful Ready snapshot after the manager closes.
    h.session.refreshState = () => new Promise(() => {});
    live.length = 0;
    const first = h.commands.get('kotTestToolkit.vanessaControl.connect')!();
    const repeated = h.commands.get('kotTestToolkit.vanessaControl.connect')!();
    assert.deepEqual(h.progressTitles, ['Connecting to Vanessa…']);
    h.expireHealthCheck();
    await Promise.all([first, repeated]);
    assert.equal(h.launches(), 1);
    assert.deepEqual(h.attached, ['http://127.0.0.1:6000/mcp', 'http://127.0.0.1:8888/mcp']);
    assert.deepEqual(h.errors, []);
});

test('a delayed connection check cannot detach a newer attachment or interrupt a running operation', async () => {
    const h = harness(['http://127.0.0.1:6000/mcp']); await h.ensureConnected();
    h.session.refreshState = () => new Promise(() => {});
    const pending = h.ensureConnected();
    await h.session.attach({}, 'http://127.0.0.1:7000/mcp');
    h.expireHealthCheck(); assert.equal(await pending, false);
    assert.equal(h.session.snapshot.status, 'ready'); assert.equal(h.attached.length, 2);
    h.session.snapshot.status = 'running'; (h.session as any).busy = true;
    assert.equal(await h.ensureConnected(), true);
    assert.equal(h.launches(), 0); assert.equal(h.attached.length, 2);
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
    for (const tool of ['get_vanessa_automation_state', 'manage_test_client_profiles', 'user_actions_recording']) {
        h.notify({ ...h.session.snapshot, request: { tool, count: 1, background: true } });
        assert.equal(h.status.text, ready, tool);
    }
    for (const [tool, message] of [['get_form_analysis', 'Reading form'], ['manage_test_client_profiles', 'Reading or updating clients'], ['user_actions_recording', 'Updating recording']]) {
        h.notify({ ...h.session.snapshot, request: { tool, count: 1, background: false } });
        assert.match(h.status.text, /loading~spin/u); assert.ok(h.status.text.includes(message), tool);
    }
    h.notify({ ...h.session.snapshot, status: 'unknown', error: 'request', request: { tool: 'user_actions_recording', count: 1, background: true } });
    assert.match(h.status.text, /State unavailable/u, 'background checks must not conceal a lost connection');
    h.notify(h.session.snapshot); assert.equal(h.status.text, ready);
});

test('startup does not choose between live sessions; an explicit action asks once', async () => {
    const live = ['http://127.0.0.1:6000/mcp', 'http://127.0.0.1:7000/mcp']; const h = harness(live);
    await h.startup(); assert.deepEqual(h.attached, []); assert.deepEqual(h.prompts, []);
    assert.equal(await h.ensureConnected(), true);
    assert.deepEqual(h.attached, [live[1]]); assert.deepEqual(h.prompts.map(items => Array.from(items)), [live]);
});

test('agent connections report ambiguity without opening a picker and accept an explicit discovered manager', async () => {
    const live = ['http://127.0.0.1:6000/mcp', 'http://127.0.0.1:7000/mcp']; const h = harness(live);
    await assert.rejects(h.ensureAgentConnected(), /kot_manager/); assert.deepEqual(h.prompts, []); assert.deepEqual(h.attached, []);
    await h.manager('connect', live[1]); assert.deepEqual(h.attached, [live[1]]);
    await assert.rejects(h.manager('connect', 'http://127.0.0.1:9999/mcp'), /available local endpoint/);
    h.dispose();
});

test('agent connections prefer the single manager associated with this workspace', async () => {
    const own = 'http://127.0.0.1:8888/mcp'; const h = harness(['http://127.0.0.1:6000/mcp', own], [6000, 8888]);
    assert.equal(await h.ensureAgentConnected(), true); assert.deepEqual(h.attached, [own]); assert.deepEqual(h.prompts, []);
    h.dispose();
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
