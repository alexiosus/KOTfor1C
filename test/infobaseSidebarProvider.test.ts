import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as sidebarModel from '../src/infobaseSidebarModel';
import type { ManagedInfobaseRecord } from '../src/infobaseManager';
import type { ManagedInfobaseSnapshot } from '../src/managedInfobaseService';

interface Disposable { dispose(): void; }

class EventHub<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void): Disposable => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }
}

class FakeWebview {
    html = '';
    options: unknown;
    readonly cspSource = 'vscode-webview-resource:';
    readonly messages: unknown[] = [];
    readonly inbound = new EventHub<unknown>();
    asWebviewUri(value: { toString(): string }) { return { toString: () => `webview:${value.toString()}` }; }
    async postMessage(message: unknown): Promise<boolean> { this.messages.push(message); return true; }
    onDidReceiveMessage(listener: (message: unknown) => void): Disposable { return this.inbound.event(listener); }
}

class FakeWebviewView {
    readonly webview = new FakeWebview();
    readonly visibilityEvents = new EventHub<void>();
    visible = true;
    onDidChangeVisibility(listener: () => void): Disposable { return this.visibilityEvents.event(listener); }
    setVisible(value: boolean): void { this.visible = value; this.visibilityEvents.fire(); }
}

function uri(value: string) {
    return { toString: () => value, fsPath: value.replace(/^file:\/\//u, '') };
}

function record(id: string, overrides: Partial<ManagedInfobaseRecord> = {}): ManagedInfobaseRecord {
    return {
        id,
        infobaseKind: 'file',
        infobasePath: `/workspace/${id}`,
        locationLabel: `/workspace/${id}`,
        displayName: id.toUpperCase(),
        launcherName: null,
        launcherRegistered: false,
        exists: true,
        markerExists: true,
        state: 'ready',
        roles: [],
        sources: ['manual'],
        lastLaunchAt: null,
        lastLaunchKind: null,
        lastSnapshotPath: null,
        lastSnapshotAt: null,
        lastRunLogPath: null,
        lastRunLogAt: null,
        startupParametersMode: 'none',
        startupParameters: null,
        preferredPlatformClientExePath: null,
        logTargets: [],
        hidden: false,
        ...overrides
    };
}

function snapshot(revision: number, records: readonly ManagedInfobaseRecord[], activeId: string | null = null): ManagedInfobaseSnapshot {
    return Object.freeze({
        revision,
        profileId: 'profile-one',
        profileName: 'QA profile',
        activeInfobaseIdentity: activeId ? records.find(value => value.id === activeId)?.infobasePath ?? null : null,
        infobases: Object.freeze([...records])
    });
}

async function flush(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
}

function createHarness(initial: ManagedInfobaseSnapshot = snapshot(1, [record('one'), record('two')], 'two')) {
    const providerPath = path.join(process.cwd(), 'src', 'infobaseSidebarProvider.ts');
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.readFileSync(providerPath, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const commands: string[] = [];
    const errors: string[] = [];
    const vscode = {
        Uri: { joinPath: (base: { toString(): string }, ...parts: string[]) => uri(`${base.toString()}/${parts.join('/')}`) },
        commands: { executeCommand: async (command: string) => { commands.push(command); } },
        window: { showErrorMessage: (message: string) => { errors.push(message); } }
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') { return vscode; }
            if (specifier === './infobaseSidebarModel') { return sidebarModel; }
            return require(specifier);
        },
        console
    });

    const invalidations = new EventHub<void>();
    const runtimeChanges = new EventHub<ReadonlySet<string>>();
    let runningIdentities = new Set<string>();
    let current = initial;
    let ensureError: Error | null = null;
    let ensureCalls = 0;
    let refreshCalls = 0;
    const calls: Array<{ action: string; id?: string }> = [];
    const operationGates = new Map<string, Promise<void>>();
    const runOperation = async (action: string, value?: ManagedInfobaseRecord): Promise<void> => {
        calls.push({ action, ...(value ? { id: value.id } : {}) });
        await operationGates.get(`${action}:${value?.id ?? ''}`);
    };
    const service = {
        onDidInvalidate: invalidations.event,
        ensureReady: async () => {
            ensureCalls += 1;
            if (ensureError) { throw ensureError; }
            return current;
        },
        refresh: async () => {
            refreshCalls += 1;
            invalidations.fire();
            return current;
        }
    };
    const operations = {
        createInfobase: async () => runOperation('create'),
        openEnterprise: async (value: ManagedInfobaseRecord) => runOperation('enterprise', value),
        openDesigner: async (value: ManagedInfobaseRecord) => runOperation('designer', value),
        openFormExplorer: async (value: ManagedInfobaseRecord) => runOperation('formExplorer', value),
        copy: async (value: ManagedInfobaseRecord) => runOperation('copy', value),
        recreate: async (value: ManagedInfobaseRecord) => runOperation('recreate', value),
        updateConfiguration: async (value: ManagedInfobaseRecord) => runOperation('updateConfiguration', value),
        edit: async (value: ManagedInfobaseRecord) => runOperation('edit', value),
        addToLauncher: async (value: ManagedInfobaseRecord) => runOperation('addToLauncher', value),
        removeFromLauncher: async (value: ManagedInfobaseRecord) => runOperation('removeFromLauncher', value),
        reveal: async (value: ManagedInfobaseRecord) => runOperation('reveal', value),
        logs: async (value: ManagedInfobaseRecord) => runOperation('logs', value),
        exportDt: async (value: ManagedInfobaseRecord) => runOperation('exportDt', value),
        importDt: async (value: ManagedInfobaseRecord) => runOperation('importDt', value),
        restoreFromTemplate: async (value: ManagedInfobaseRecord) => runOperation('restoreFromTemplate', value),
        exportCf: async (value: ManagedInfobaseRecord) => runOperation('exportCf', value),
        importCf: async (value: ManagedInfobaseRecord) => runOperation('importCf', value)
    };
    const Provider = moduleObject.exports.InfobaseSidebarProvider as new (services: unknown) => {
        resolveWebviewView(view: unknown): void;
        dispose(): void;
    };
    const provider = new Provider({
        extensionUri: uri('file:///extension'),
        managedInfobaseService: service,
        runtimeTracker: {
            onDidChange: runtimeChanges.event,
            runningIdentities: () => runningIdentities
        },
        loadOperations: async () => operations
    });
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view);
    return {
        provider, view, invalidations, commands, errors, calls,
        setOperationGate(action: string, infobaseId: string, gate: Promise<void>) {
            operationGates.set(`${action}:${infobaseId}`, gate);
        },
        setSnapshot(value: ManagedInfobaseSnapshot) { current = value; },
        setEnsureError(value: Error | null) { ensureError = value; },
        setRunningIdentities(value: ReadonlySet<string>) {
            runningIdentities = new Set(value);
            runtimeChanges.fire(runningIdentities);
        },
        get ensureCalls() { return ensureCalls; },
        get refreshCalls() { return refreshCalls; }
    };
}

async function send(harness: ReturnType<typeof createHarness>, message: unknown): Promise<void> {
    harness.view.webview.inbound.fire(message);
    await flush();
}

test('ready publishes loading and an alphabetically sorted model', async () => {
    const harness = createHarness();
    assert.equal(harness.ensureCalls, 0);
    await send(harness, { command: 'ready' });

    assert.equal(harness.ensureCalls, 1);
    assert.deepEqual(
        harness.view.webview.messages.map(value => (value as { command: string }).command),
        ['loading', 'state']
    );
    const state = harness.view.webview.messages.at(-1) as { profileName: string; activeInfobaseId: string; items: Array<{ id: string; active: boolean }> };
    assert.equal(state.profileName, 'QA profile');
    assert.equal(state.activeInfobaseId, 'two');
    assert.deepEqual(state.items.map(item => [item.id, item.active]), [['one', false], ['two', true]]);
});

test('runtime process changes update markers without rescanning infobases', async () => {
    const harness = createHarness();
    await send(harness, { command: 'ready' });
    const ensureCalls = harness.ensureCalls;

    harness.setRunningIdentities(new Set(['/workspace/one']));
    await flush();

    assert.equal(harness.ensureCalls, ensureCalls);
    const state = harness.view.webview.messages.at(-1) as {
        command: string;
        items: Array<{ id: string; running: boolean }>;
    };
    assert.equal(state.command, 'state');
    assert.deepEqual(state.items.map(item => [item.id, item.running]), [
        ['one', true],
        ['two', false]
    ]);
});

test('publishes an explicit empty state without retrying the shared snapshot', async () => {
    const harness = createHarness(snapshot(1, []));
    await send(harness, { command: 'ready' });

    const state = harness.view.webview.messages.at(-1) as { command: string; items: unknown[] };
    assert.equal(state.command, 'state');
    assert.deepEqual(state.items, []);
    assert.equal(harness.ensureCalls, 1);
});

test('rejects unknown IDs and actions while routing every allowed action exactly once', async () => {
    const harness = createHarness();
    await send(harness, { command: 'ready' });
    await send(harness, { command: 'openEnterprise', infobaseId: 'missing' });
    await send(harness, { command: 'maintenance', infobaseId: 'one', action: 'delete' });
    for (const message of [
        { command: 'openEnterprise', infobaseId: 'one' },
        { command: 'openDesigner', infobaseId: 'one' },
        { command: 'maintenance', infobaseId: 'one', action: 'openFormExplorer' },
        { command: 'maintenance', infobaseId: 'one', action: 'copy' },
        { command: 'maintenance', infobaseId: 'one', action: 'recreate' },
        { command: 'maintenance', infobaseId: 'one', action: 'updateConfiguration' },
        { command: 'maintenance', infobaseId: 'one', action: 'edit' },
        { command: 'maintenance', infobaseId: 'one', action: 'addToLauncher' },
        { command: 'maintenance', infobaseId: 'one', action: 'removeFromLauncher' },
        { command: 'maintenance', infobaseId: 'one', action: 'reveal' },
        { command: 'maintenance', infobaseId: 'one', action: 'logs' },
        { command: 'maintenance', infobaseId: 'one', action: 'exportDt' },
        { command: 'maintenance', infobaseId: 'one', action: 'importDt' },
        { command: 'maintenance', infobaseId: 'one', action: 'restoreFromTemplate' },
        { command: 'maintenance', infobaseId: 'one', action: 'exportCf' },
        { command: 'maintenance', infobaseId: 'one', action: 'importCf' }
    ]) {
        await send(harness, message);
    }

    assert.deepEqual(harness.calls.map(call => call.action), [
        'enterprise', 'designer', 'formExplorer', 'copy', 'recreate', 'updateConfiguration', 'edit',
        'addToLauncher', 'removeFromLauncher', 'reveal', 'logs',
        'exportDt', 'importDt', 'restoreFromTemplate', 'exportCf', 'importCf'
    ]);
    assert.equal(harness.refreshCalls, 16);
    const pending = harness.view.webview.messages.filter(value => (value as { command: string }).command === 'pending') as Array<{ infobaseId: string | null }>;
    assert.equal(pending.every(message => message.infobaseId === 'one' || message.infobaseId === null), true);
});

test('retains the last valid state on refresh error and defers hidden invalidation', async () => {
    const harness = createHarness();
    await send(harness, { command: 'ready' });
    const stateCount = () => harness.view.webview.messages.filter(value => (value as { command: string }).command === 'state').length;
    assert.equal(stateCount(), 1);

    harness.view.setVisible(false);
    harness.invalidations.fire();
    await flush();
    assert.equal(harness.ensureCalls, 1);

    harness.setEnsureError(new Error('scan failed'));
    harness.view.setVisible(true);
    await flush();
    assert.equal(harness.ensureCalls, 2);
    assert.equal(stateCount(), 1);
    assert.equal(harness.errors.at(-1), 'scan failed');
    assert.equal((harness.view.webview.messages.at(-1) as { command: string }).command, 'error');
});

test('routes create, refresh, and full-manager commands without accepting caller paths', async () => {
    const harness = createHarness();
    await send(harness, { command: 'ready' });
    await send(harness, { command: 'createInfobase', infobasePath: '/injected' });
    await send(harness, { command: 'refresh' });
    await send(harness, { command: 'openFullManager' });

    assert.deepEqual(harness.calls, [{ action: 'create' }]);
    assert.equal(harness.refreshCalls, 2);
    assert.deepEqual(harness.commands, ['kotTestToolkit.openInfobaseManager']);
});

test('allows operations on different infobases while one infobase is busy', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const harness = createHarness();
    harness.setOperationGate('updateConfiguration', 'one', firstGate);
    await send(harness, { command: 'ready' });

    await send(harness, { command: 'maintenance', infobaseId: 'one', action: 'updateConfiguration' });
    await send(harness, { command: 'maintenance', infobaseId: 'two', action: 'exportDt' });

    assert.deepEqual(harness.calls.slice(-2), [
        { action: 'updateConfiguration', id: 'one' },
        { action: 'exportDt', id: 'two' }
    ]);
    const pending = harness.view.webview.messages.filter(
        value => (value as { command?: string }).command === 'pending'
    ) as Array<{ infobaseId: string; action: string | null }>;
    assert.deepEqual(pending.slice(0, 2).map(message => [message.infobaseId, message.action]), [
        ['one', 'updateConfiguration'],
        ['two', 'exportDt']
    ]);

    releaseFirst();
    await flush();
});

test('blocks exclusive maintenance but keeps launch available for a running infobase', async () => {
    const harness = createHarness();
    await send(harness, { command: 'ready' });
    harness.setRunningIdentities(new Set(['/workspace/one']));
    await flush();

    await send(harness, { command: 'maintenance', infobaseId: 'one', action: 'updateConfiguration' });
    await send(harness, { command: 'maintenance', infobaseId: 'one', action: 'exportDt' });
    await send(harness, { command: 'maintenance', infobaseId: 'one', action: 'restoreFromTemplate' });
    await send(harness, { command: 'openEnterprise', infobaseId: 'one' });

    assert.deepEqual(harness.calls, [{ action: 'enterprise', id: 'one' }]);
});
