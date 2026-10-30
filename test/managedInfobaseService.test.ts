import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActiveYamlParametersProfile } from '../src/activeYamlParametersProfile';
import type { ManagedInfobaseRecord } from '../src/infobaseManager';
import { ManagedInfobaseService } from '../src/managedInfobaseService';

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

function profile(id: string, value: string): ActiveYamlParametersProfile {
    return Object.freeze({
        id,
        name: `Profile ${id}`,
        buildParameters: Object.freeze([Object.freeze({ key: 'LaunchDBFolder', value })]),
        additionalVanessaParameters: Object.freeze([]),
        globalVanessaVariables: Object.freeze([])
    });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createHarness(
    collector?: (activeProfileInfobasePath: string | null) => Promise<readonly ManagedInfobaseRecord[]>
) {
    const profileChanges = new EventHub<unknown>();
    let currentProfile = profile('one', 'runtime/one');
    let collectorCalls = 0;
    const collectedPaths: Array<string | null> = [];
    const service = new ManagedInfobaseService({
        loadActiveProfile: async () => currentProfile,
        onDidChangeActiveProfile: profileChanges.event,
        workspaceRootPath: '/workspace',
        collect: async activeProfileInfobasePath => {
            collectorCalls += 1;
            collectedPaths.push(activeProfileInfobasePath);
            return collector ? collector(activeProfileInfobasePath) : [];
        }
    });
    return {
        service,
        profileChanges,
        collectedPaths,
        setProfile(value: ActiveYamlParametersProfile) { currentProfile = value; },
        get collectorCalls() { return collectorCalls; }
    };
}

test('stays lazy and coalesces concurrent ensure calls into one collection', async () => {
    const pending = deferred<readonly ManagedInfobaseRecord[]>();
    const harness = createHarness(async () => pending.promise);

    assert.equal(harness.collectorCalls, 0);
    assert.equal(harness.service.getCurrent(), null);
    const first = harness.service.ensureReady();
    const second = harness.service.ensureReady();
    assert.equal(harness.collectorCalls, 0);
    await Promise.resolve();
    assert.equal(harness.collectorCalls, 1);
    pending.resolve([]);

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    assert.strictEqual(firstSnapshot, secondSnapshot);
    assert.strictEqual(await harness.service.ensureReady(), firstSnapshot);
    assert.equal(harness.collectorCalls, 1);
    assert.deepEqual(harness.collectedPaths, ['/workspace/runtime/one']);
});

test('explicit refresh recollects once and publishes a new revision', async () => {
    const harness = createHarness();
    const first = await harness.service.ensureReady();
    const refreshed = await harness.service.refresh();

    assert.equal(harness.collectorCalls, 2);
    assert.ok(refreshed.revision > first.revision);
    assert.equal(refreshed.profileId, 'one');
    assert.equal(refreshed.profileName, 'Profile one');
    assert.ok(Object.isFrozen(refreshed));
    assert.ok(Object.isFrozen(refreshed.infobases));
});

test('active-profile changes invalidate without collecting until the next consumer', async () => {
    const harness = createHarness();
    const invalidations: number[] = [];
    harness.service.onDidInvalidate(() => invalidations.push(harness.collectorCalls));
    await harness.service.ensureReady();

    harness.setProfile(profile('two', 'runtime/two'));
    harness.profileChanges.fire({ reason: 'selection' });
    assert.equal(harness.service.getCurrent(), null);
    assert.equal(harness.collectorCalls, 1);
    assert.deepEqual(invalidations, [1]);

    const next = await harness.service.ensureReady();
    assert.equal(harness.collectorCalls, 2);
    assert.equal(next.profileId, 'two');
    assert.equal(next.activeInfobaseIdentity, '/workspace/runtime/two');
    assert.deepEqual(harness.collectedPaths, [
        '/workspace/runtime/one',
        '/workspace/runtime/two'
    ]);
});

test('does not publish an obsolete in-flight profile snapshot', async () => {
    const first = deferred<readonly ManagedInfobaseRecord[]>();
    const second = deferred<readonly ManagedInfobaseRecord[]>();
    const pending = [first, second];
    const harness = createHarness(async () => pending.shift()!.promise);

    const obsolete = harness.service.ensureReady();
    await Promise.resolve();
    harness.setProfile(profile('two', 'runtime/two'));
    harness.profileChanges.fire({ reason: 'selection' });
    const latest = harness.service.ensureReady();
    await Promise.resolve();
    second.resolve([]);
    const latestSnapshot = await latest;
    first.resolve([]);
    await obsolete;

    assert.strictEqual(harness.service.getCurrent(), latestSnapshot);
    assert.equal(latestSnapshot.profileId, 'two');
});
