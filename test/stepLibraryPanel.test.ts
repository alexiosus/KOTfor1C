import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as stepLibraryModel from '../src/stepLibraryModel';
import type { ProjectDefinitionView } from '../src/projectDefinition';

interface Disposable {
    dispose(): void;
}

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
    readonly cspSource = 'vscode-webview-resource:';
    readonly messages: unknown[] = [];
    readonly inbound = new EventHub<unknown>();

    asWebviewUri(uri: { toString(): string }): { toString(): string } {
        return { toString: () => `webview:${uri.toString()}` };
    }

    async postMessage(message: unknown): Promise<boolean> {
        this.messages.push(message);
        return true;
    }

    onDidReceiveMessage(listener: (message: unknown) => void): Disposable {
        return this.inbound.event(listener);
    }
}

class FakePanel {
    readonly webview = new FakeWebview();
    readonly disposeEvents = new EventHub<void>();
    readonly viewStateEvents = new EventHub<{ webviewPanel: FakePanel }>();
    visible = true;
    title = '';
    disposed = false;

    reveal(): void {
        this.visible = true;
    }

    onDidDispose(listener: () => void): Disposable {
        return this.disposeEvents.event(listener);
    }

    onDidChangeViewState(
        listener: (event: { webviewPanel: FakePanel }) => void
    ): Disposable {
        return this.viewStateEvents.event(listener);
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        this.viewStateEvents.fire({ webviewPanel: this });
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.disposeEvents.fire();
    }
}

function uri(value: string): { toString(): string } {
    return { toString: () => value };
}

function view(identity: string): ProjectDefinitionView {
    return {
        identity,
        all: [],
        byId: new Map(),
        byNormalizedTemplate: new Map()
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

function loadPanelModule(fakePanel: FakePanel): Record<string, unknown> {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'stepLibraryPanel.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const vscode = {
        ViewColumn: { One: 1 },
        Uri: {
            joinPath: (base: { toString(): string }, ...segments: string[]) =>
                uri(`${base.toString()}/${segments.join('/')}`)
        },
        window: {
            createWebviewPanel: () => fakePanel
        }
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return vscode;
            }
            if (specifier === './stepLibraryModel') {
                return stepLibraryModel;
            }
            if (specifier === './localization') {
                return { getTranslator: async () => (message: string) => message };
            }
            return require(specifier);
        },
        console,
        setTimeout,
        clearTimeout
    });
    return moduleObject.exports;
}

function createHarness(getView: (resource?: unknown) => Promise<ProjectDefinitionView>) {
    const fakePanel = new FakePanel();
    const moduleExports = loadPanelModule(fakePanel);
    const Panel = moduleExports.StepLibraryPanel as new (services: unknown) => {
        open(resource?: unknown): Promise<void>;
        dispose(): void;
    };
    const changes = new EventHub<unknown>();
    let refreshDefinitionsCalls = 0;
    const panel = new Panel({
        extensionUri: uri('file:///extension'),
        resolver: {
            getView,
            onDidChangeView: changes.event
        },
        refreshDefinitions: async () => {
            refreshDefinitionsCalls += 1;
        }
    });
    return {
        panel,
        fakePanel,
        changes,
        get refreshDefinitionsCalls() { return refreshDefinitionsCalls; }
    };
}

test('drops an older resolver result that completes after a newer load', async () => {
    const first = deferred<ProjectDefinitionView>();
    const second = deferred<ProjectDefinitionView>();
    const requests = [first, second];
    const harness = createHarness(async () => requests.shift()!.promise);

    const olderOpen = harness.panel.open(uri('file:///workspace/old.feature'));
    await flush();
    const newerOpen = harness.panel.open(uri('file:///workspace/new.feature'));
    second.resolve(view('view:new'));
    await newerOpen;
    first.resolve(view('view:old'));
    await olderOpen;

    const snapshots = harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'snapshot'
    ) as any[];
    assert.deepEqual(snapshots.map(message => message.snapshot.viewIdentity), ['view:new']);
});

test('does not start a duplicate resolver load when the webview becomes ready', async () => {
    const pending = deferred<ProjectDefinitionView>();
    let calls = 0;
    const harness = createHarness(async () => {
        calls += 1;
        return pending.promise;
    });

    const opening = harness.panel.open(uri('file:///workspace/test.feature'));
    await flush();
    harness.fakePanel.webview.inbound.fire({ command: 'ready' });
    await flush();

    assert.equal(calls, 1);
    pending.resolve(view('view:ready'));
    await opening;
});

test('does not repost an unchanged view identity and refreshes after resolver changes', async () => {
    let calls = 0;
    const harness = createHarness(async () => {
        calls += 1;
        return view('view:same');
    });
    await harness.panel.open(uri('file:///workspace/test.feature'));

    harness.changes.fire({ reason: 'local' });
    await flush();

    assert.equal(calls, 2);
    assert.equal(harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'snapshot'
    ).length, 1);
});

test('defers resolver work while hidden and refreshes when visible again', async () => {
    let calls = 0;
    const harness = createHarness(async () => view(`view:${++calls}`));
    await harness.panel.open(uri('file:///workspace/test.feature'));
    harness.fakePanel.setVisible(false);

    harness.changes.fire({ reason: 'builtIn' });
    await flush();
    assert.equal(calls, 1);

    harness.fakePanel.setVisible(true);
    await flush();
    assert.equal(calls, 2);
});

test('keeps the last successful snapshot when a later refresh fails', async () => {
    let fail = false;
    const harness = createHarness(async () => {
        if (fail) {
            throw new Error('scan failed');
        }
        return view('view:success');
    });
    await harness.panel.open(uri('file:///workspace/test.feature'));
    fail = true;

    harness.changes.fire({ reason: 'local' });
    await flush();

    assert.equal(harness.fakePanel.webview.messages.filter(
        (message: any) => message.command === 'snapshot'
    ).length, 1);
    assert.equal(harness.fakePanel.webview.messages.some(
        (message: any) => message.command === 'error' && message.message === 'scan failed'
    ), true);
});

test('accepts only the five inbound commands and strips untrusted fields', () => {
    const fakePanel = new FakePanel();
    const moduleExports = loadPanelModule(fakePanel);
    const parseMessage = moduleExports.parseStepLibraryInboundMessage as
        (value: unknown) => unknown;
    const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

    assert.deepEqual(plain(parseMessage({ command: 'ready', uri: 'file:///evil' })), {
        command: 'ready'
    });
    assert.deepEqual(plain(parseMessage({ command: 'refresh' })), { command: 'refresh' });
    for (const command of ['insert', 'copy', 'openDefinition']) {
        assert.deepEqual(plain(parseMessage({ command, itemId: ' item ', uri: 'file:///evil' })), {
            command,
            itemId: 'item'
        });
        assert.equal(parseMessage({ command, itemId: '   ' }), null);
    }
    assert.equal(parseMessage({ command: 'openUri', uri: 'file:///evil' }), null);
    assert.equal(parseMessage(null), null);
});
