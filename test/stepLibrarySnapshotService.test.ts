import assert from 'node:assert/strict';
import test from 'node:test';
import { StepLibrarySnapshotService } from '../src/stepLibrarySnapshotService';
import type { ProjectDefinitionView } from '../src/projectDefinition';
import type { ScenarioCatalog } from '../src/scenarioCatalog';

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

function view(identity: string): ProjectDefinitionView {
    return {
        identity,
        all: [],
        byId: new Map(),
        byNormalizedTemplate: new Map()
    };
}

function emptyCatalog(): ScenarioCatalog {
    return {
        all: [],
        byName: new Map(),
        byUri: new Map(),
        primaryByName: new Map()
    };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

test('coalesces concurrent snapshot loads and reuses the resource cache', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    const pending = deferred<ProjectDefinitionView>();
    let calls = 0;
    const service = new StepLibrarySnapshotService({
        resolver: {
            ensureReady: async () => {
                calls += 1;
                return pending.promise;
            },
            onDidChangeView: resolverChanges.event
        },
        scenarios: {
            getScenarioCatalog: emptyCatalog,
            onDidUpdateScenarioCatalog: scenarioChanges.event
        }
    });
    const resource = { toString: () => 'file:///workspace/test.feature' } as never;

    const first = service.ensureReady(resource);
    const second = service.ensureReady(resource);
    assert.equal(calls, 1);
    pending.resolve(view('view:one'));

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    assert.equal(firstSnapshot, secondSnapshot);
    assert.equal(await service.ensureReady(resource), firstSnapshot);
    assert.equal(service.getCurrent(resource), firstSnapshot);
    assert.equal(calls, 1);
    service.dispose();
});

test('resolver and scenario changes invalidate lazily without rebuilding', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    let calls = 0;
    const service = new StepLibrarySnapshotService({
        resolver: {
            ensureReady: async () => view(`view:${++calls}`),
            onDidChangeView: resolverChanges.event
        },
        scenarios: {
            getScenarioCatalog: emptyCatalog,
            onDidUpdateScenarioCatalog: scenarioChanges.event
        }
    });
    let invalidations = 0;
    service.onDidInvalidate(() => {
        invalidations += 1;
    });

    await service.ensureReady();
    resolverChanges.fire({});
    assert.equal(calls, 1);
    assert.equal(service.getCurrent(), null);
    assert.equal(invalidations, 1);

    await service.ensureReady();
    scenarioChanges.fire(emptyCatalog());
    assert.equal(calls, 2);
    assert.equal(service.getCurrent(), null);
    assert.equal(invalidations, 2);
    service.dispose();
});

test('an invalidated in-flight generation is not published into the cache', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    const first = deferred<ProjectDefinitionView>();
    let calls = 0;
    const service = new StepLibrarySnapshotService({
        resolver: {
            ensureReady: async () => {
                calls += 1;
                return calls === 1 ? first.promise : view('view:new');
            },
            onDidChangeView: resolverChanges.event
        },
        scenarios: {
            getScenarioCatalog: emptyCatalog,
            onDidUpdateScenarioCatalog: scenarioChanges.event
        }
    });

    const staleLoad = service.ensureReady();
    service.invalidate();
    first.resolve(view('view:stale'));
    assert.equal((await staleLoad).viewIdentity, 'view:stale');
    assert.equal(service.getCurrent(), null);
    assert.equal((await service.ensureReady()).viewIdentity, 'view:new');
    service.dispose();
});
