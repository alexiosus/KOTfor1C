import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as sidebarModel from '../src/stepLibrarySidebarModel';
import type { StepLibraryItem, StepLibrarySnapshot } from '../src/stepLibraryModel';

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
    options: unknown;
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

class FakeWebviewView {
    readonly webview = new FakeWebview();
    readonly visibilityEvents = new EventHub<void>();
    visible = true;

    onDidChangeVisibility(listener: () => void): Disposable {
        return this.visibilityEvents.event(listener);
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        this.visibilityEvents.fire();
    }
}

function uri(value: string): { toString(): string } {
    return {
        toString: () => value,
        path: value.replace(/^file:\/\//u, ''),
        fsPath: value.replace(/^file:\/\//u, '')
    };
}

function item(index: number, overrides: Partial<StepLibraryItem> = {}): StepLibraryItem {
    const id = overrides.id ?? `item-${index}`;
    const displayText = overrides.displayText ?? `Bulk step ${String(index).padStart(3, '0')}`;
    return Object.freeze({
        id,
        definitionId: overrides.definitionId ?? id,
        familyId: overrides.familyId ?? id,
        kind: overrides.kind ?? 'nestedScenario',
        sourceGroup: overrides.sourceGroup ?? 'nested',
        template: overrides.template ?? displayText,
        displayText,
        categoryPath: Object.freeze([...(overrides.categoryPath ?? ['Tests'])]),
        parameters: Object.freeze([]),
        sourceLabel: overrides.sourceLabel ?? 'Nested scenarios',
        navigable: overrides.navigable ?? true,
        insertable: overrides.insertable ?? true,
        capturedLocation: overrides.capturedLocation ?? {
            uri: `file:///workspace/${id}/scen.yaml`,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        },
        searchText: overrides.searchText ?? displayText.toLowerCase(),
        ...overrides
    });
}

function snapshot(identity: string, items: readonly StepLibraryItem[]): StepLibrarySnapshot {
    return Object.freeze({
        viewIdentity: identity,
        items: Object.freeze([...items]),
        counts: Object.freeze({
            builtIn: items.filter(value => value.sourceGroup === 'builtIn').length,
            user: items.filter(value => value.sourceGroup === 'user').length,
            export: items.filter(value => value.sourceGroup === 'export').length,
            nested: items.filter(value => value.sourceGroup === 'nested').length,
            main: items.filter(value => value.sourceGroup === 'main').length
        })
    });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function flush(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
}

interface HarnessOptions {
    readonly ensureReady?: (resource?: unknown) => Promise<StepLibrarySnapshot>;
    readonly initialSnapshot?: StepLibrarySnapshot;
}

function createHarness(options: HarnessOptions = {}) {
    const providerPath = path.join(process.cwd(), 'src', 'stepLibrarySidebarProvider.ts');
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(providerPath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const executedCommands: Array<{ command: string; args: unknown[] }> = [];
    const vscode = {
        env: { language: 'en' },
        Uri: {
            joinPath: (base: { toString(): string }, ...segments: string[]) =>
                uri(`${base.toString()}/${segments.join('/')}`)
        },
        commands: {
            executeCommand: async (command: string, ...args: unknown[]) => {
                executedCommands.push({ command, args });
            }
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
            if (specifier === './stepLibrarySidebarModel') {
                return sidebarModel;
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

    const invalidations = new EventHub<void>();
    const targetChanges = new EventHub<unknown>();
    const relationshipChanges = new EventHub<unknown>();
    let current = options.initialSnapshot ?? snapshot('initial', []);
    let ensureReadyCalls = 0;
    let invalidateCalls = 0;
    let refreshCalls = 0;
    const inserted: StepLibraryItem[] = [];
    const copied: StepLibraryItem[] = [];
    const opened: StepLibraryItem[] = [];
    const snapshotService = {
        onDidInvalidate: invalidations.event,
        ensureReady: async (resource?: unknown) => {
            ensureReadyCalls += 1;
            return options.ensureReady ? options.ensureReady(resource) : current;
        },
        invalidate: () => {
            invalidateCalls += 1;
            invalidations.fire();
        }
    };
    const actionService = {
        onDidChangeInsertionTarget: targetChanges.event,
        getInsertionTargetState: () => ({
            identity: 'file:///workspace/test.feature:1:0',
            available: true,
            resource: uri('file:///workspace/test.feature')
        }),
        insert: async (value: StepLibraryItem) => {
            inserted.push(value);
            return true;
        },
        copy: async (value: StepLibraryItem) => {
            copied.push(value);
            return true;
        },
        openDefinition: async (value: StepLibraryItem) => {
            opened.push(value);
            return true;
        }
    };
    let relationshipState: unknown = {
        enabled: true,
        currentScenarioKeys: [],
        relationships: [],
        affectedMainScenarioKeys: [],
        affectedPhaseNames: [],
        currentLabel: null,
        revision: 0
    };
    const relationshipService = {
        onDidChangeState: relationshipChanges.event,
        getState: () => relationshipState
    };
    const Provider = moduleObject.exports.StepLibrarySidebarProvider as new (services: unknown) => {
        resolveWebviewView(view: unknown): Promise<void> | void;
        dispose(): void;
    };
    const provider = new Provider({
        extensionUri: uri('file:///extension'),
        snapshotService,
        actionService,
        relationshipService,
        refreshDefinitions: async () => {
            refreshCalls += 1;
        }
    });
    const view = new FakeWebviewView();
    void provider.resolveWebviewView(view);

    return {
        provider,
        view,
        invalidations,
        targetChanges,
        relationshipChanges,
        executedCommands,
        inserted,
        copied,
        opened,
        setSnapshot(value: StepLibrarySnapshot) { current = value; },
        setRelationshipState(value: unknown) { relationshipState = value; },
        get ensureReadyCalls() { return ensureReadyCalls; },
        get invalidateCalls() { return invalidateCalls; },
        get refreshCalls() { return refreshCalls; }
    };
}

async function send(harness: ReturnType<typeof createHarness>, message: unknown): Promise<void> {
    harness.view.webview.inbound.fire(message);
    await flush();
}

test('initial ready posts loading and five roots without transferring the snapshot', async () => {
    const catalog = snapshot('catalog:one', [item(1)]);
    const harness = createHarness({ initialSnapshot: catalog });

    assert.equal(harness.ensureReadyCalls, 0);
    await send(harness, { command: 'ready' });

    assert.equal(harness.ensureReadyCalls, 1);
    assert.equal((harness.view.webview.messages[0] as any).command, 'loading');
    const roots = harness.view.webview.messages.find((message: any) => message.command === 'roots') as any;
    assert.equal(roots.identity, 'catalog:one');
    assert.equal(roots.nodes.length, 5);
    assert.equal(roots.nodes[3].count, 1);
    assert.equal(Object.hasOwn(roots, 'snapshot'), false);
    assert.doesNotMatch(JSON.stringify(roots), /Bulk step 001/u);
});

test('expand and search return bounded host-side pages only', async () => {
    const catalog = snapshot('catalog:bulk', Array.from({ length: 180 }, (_, index) => item(index)));
    const harness = createHarness({ initialSnapshot: catalog });
    await send(harness, { command: 'ready' });
    await send(harness, { command: 'expand', nodeId: 'source:nested', offset: 0 });
    const sourceChildren = harness.view.webview.messages.at(-1) as any;
    const category = sourceChildren.nodes.find((node: any) => node.kind === 'category');

    await send(harness, { command: 'expand', nodeId: category.id, offset: 0 });
    const page = harness.view.webview.messages.at(-1) as any;
    assert.equal(page.command, 'children');
    assert.equal(page.nodes.filter((node: any) => node.kind === 'definition').length, 100);
    assert.equal(page.nodes.at(-1).kind, 'more');
    assert.equal(page.nextOffset, 100);

    await send(harness, { command: 'search', query: 'bulk step' });
    const results = harness.view.webview.messages.at(-1) as any;
    assert.equal(results.command, 'searchResults');
    assert.equal(results.nodes.length, 100);
});

test('ignores invalid inbound messages and resolves actions from server-owned items', async () => {
    const definition = item(1, { id: 'safe-item' });
    const harness = createHarness({ initialSnapshot: snapshot('catalog:actions', [definition]) });
    await send(harness, { command: 'ready' });
    const baseline = harness.view.webview.messages.length;

    await send(harness, { command: 'expand', nodeId: '', offset: -1 });
    await send(harness, { command: 'search', query: 42 });
    await send(harness, { command: 'insert', itemId: '../unsafe' });
    assert.equal(harness.view.webview.messages.length, baseline);
    assert.equal(harness.inserted.length, 0);

    await send(harness, { command: 'insert', itemId: 'safe-item' });
    await send(harness, { command: 'copy', itemId: 'safe-item' });
    await send(harness, { command: 'openDefinition', itemId: 'safe-item' });
    assert.deepEqual(harness.inserted.map(value => value.id), ['safe-item']);
    assert.deepEqual(harness.copied.map(value => value.id), ['safe-item']);
    assert.deepEqual(harness.opened.map(value => value.id), ['safe-item']);
});

test('discards stale generations and publishes only the newest snapshot', async () => {
    const first = deferred<StepLibrarySnapshot>();
    const second = deferred<StepLibrarySnapshot>();
    const loads = [first, second];
    const harness = createHarness({ ensureReady: async () => loads.shift()!.promise });

    harness.view.webview.inbound.fire({ command: 'ready' });
    await flush();
    harness.invalidations.fire();
    await flush();
    assert.equal(harness.ensureReadyCalls, 2);

    second.resolve(snapshot('catalog:new', [item(2)]));
    await flush();
    first.resolve(snapshot('catalog:old', [item(1)]));
    await flush();

    const identities = harness.view.webview.messages
        .filter((message: any) => message.command === 'roots')
        .map((message: any) => message.identity);
    assert.deepEqual(identities, ['catalog:new']);
});

test('defers hidden invalidation and publishes the latest revision when shown again', async () => {
    const harness = createHarness({ initialSnapshot: snapshot('catalog:first', [item(1)]) });
    await send(harness, { command: 'ready' });
    harness.view.setVisible(false);
    harness.setSnapshot(snapshot('catalog:latest', [item(2)]));
    harness.invalidations.fire();
    await flush();

    assert.equal(harness.ensureReadyCalls, 1);
    harness.view.setVisible(true);
    await flush();
    assert.equal(harness.ensureReadyCalls, 2);
    const roots = harness.view.webview.messages.filter((message: any) => message.command === 'roots') as any[];
    assert.deepEqual(roots.map(message => message.identity), ['catalog:first', 'catalog:latest']);
    assert.ok(roots[1].revision > roots[0].revision);
});

test('refreshes the shared catalog and opens the full library command', async () => {
    const harness = createHarness({ initialSnapshot: snapshot('catalog:one', []) });
    await send(harness, { command: 'ready' });
    await send(harness, { command: 'refresh' });
    await send(harness, { command: 'openFullLibrary' });

    assert.equal(harness.refreshCalls, 1);
    assert.equal(harness.invalidateCalls, 1);
    assert.deepEqual(harness.executedCommands, [{
        command: 'kotTestToolkit.openStepLibrary',
        args: []
    }]);
});

test('relationship updates are lightweight and do not rebuild the catalog', async () => {
    const harness = createHarness({ initialSnapshot: snapshot('catalog:one', [item(1)]) });
    await send(harness, { command: 'ready' });
    const nextState = {
        enabled: true,
        currentScenarioKeys: ['file:///workspace/item-1/scen.yaml'],
        relationships: [],
        affectedMainScenarioKeys: [],
        affectedPhaseNames: [],
        currentLabel: 'Bulk step 001',
        revision: 1
    };
    harness.setRelationshipState(nextState);
    harness.relationshipChanges.fire(nextState);
    await flush();

    assert.equal(harness.ensureReadyCalls, 1);
    const message = harness.view.webview.messages.at(-1) as any;
    assert.equal(message.command, 'relationshipState');
    assert.deepEqual([...message.relatedAncestorIds], [
        'category:nested:Tests',
        'source:nested'
    ]);
});
