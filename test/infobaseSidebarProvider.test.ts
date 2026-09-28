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
    let current = initial;
    let ensureError: Error | null = null;
    let ensureCalls = 0;
    let refreshCalls = 0;
    const calls: Array<{ action: string; id?: string }> = [];
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
        createInfobase: async () => { calls.push({ action: 'create' }); },
        openEnterprise: async (value: ManagedInfobaseRecord) => { calls.push({ action: 'enterprise', id: value.id }); },
        openDesigner: async (value: ManagedInfobaseRecord) => { calls.push({ action: 'designer', id: value.id }); },
        exportDt: async (value: ManagedInfobaseRecord) => { calls.push({ action: 'exportDt', id: value.id }); },
        importDt: async (value: ManagedInfobaseRecord) => { calls.push({ action: 'importDt', id: value.id }); },
        exportCf: async (value: ManagedInfobaseRecord) => { calls.push({ action: 'exportCf', id: value.id }); },
        importCf: async (value: ManagedInfobaseRecord) => { calls.push({ action: 'importCf', id: value.id }); }
    };
    const Provider = moduleObject.exports.InfobaseSidebarProvider as new (services: unknown) => {
        resolveWebviewView(view: unknown): void;
        dispose(): void;
    };
    const provider = new Provider({
        extensionUri: uri('file:///extension'),
        managedInfobaseService: service,
        loadOperations: async () => operations
    });
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view);
    return {
        provider, view, invalidations, commands, errors, calls,
        setSnapshot(value: ManagedInfobaseSnapshot) { current = value; },
        setEnsureError(value: Error | null) { ensureError = value; },
        get ensureCalls() { return ensureCalls; },
        get refreshCalls() { return refreshCalls; }
    };
}

async function send(harness: ReturnType<typeof createHarness>, message: unknown): Promise<void> {
    harness.view.webview.inbound.fire(message);
    await flush();
}

test('ready publishes loading and a sorted model with active-profile semantics', async () => {
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
    assert.deepEqual(state.items.map(item => [item.id, item.active]), [['two', true], ['one', false]]);
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
        { command: 'maintenance', infobaseId: 'one', action: 'exportDt' },
        { command: 'maintenance', infobaseId: 'one', action: 'importDt' },
        { command: 'maintenance', infobaseId: 'one', action: 'exportCf' },
        { command: 'maintenance', infobaseId: 'one', action: 'importCf' }
    ]) {
        await send(harness, message);
    }

    assert.deepEqual(harness.calls.map(call => call.action), [
        'enterprise', 'designer', 'exportDt', 'importDt', 'exportCf', 'importCf'
    ]);
    assert.equal(harness.refreshCalls, 6);
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
