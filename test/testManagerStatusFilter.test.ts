import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeTestManagerStatusFilter,
    TestManagerStatusFilterService,
    type TestManagerStatusFilter
} from '../src/testManagerStatusFilter';

class WorkspaceState {
    readonly updates: Array<{ key: string; value: unknown }> = [];

    constructor(
        private readonly values: Record<string, unknown> = {},
        private readonly beforeUpdate?: (value: unknown) => Promise<void>
    ) {}

    get<T>(key: string, fallback?: T): T | undefined {
        return (this.values[key] as T | undefined) ?? fallback;
    }

    async update(key: string, value: unknown): Promise<void> {
        await this.beforeUpdate?.(value);
        this.values[key] = value;
        this.updates.push({ key, value });
    }
}

test('normalizes missing and corrupt status filters to all', () => {
    for (const value of [undefined, null, '', 'stale', 1, false, {}]) {
        assert.equal(normalizeTestManagerStatusFilter(value), 'all');
    }
    for (const value of ['all', 'built', 'running'] as const) {
        assert.equal(normalizeTestManagerStatusFilter(value), value);
    }
});

test('restores every persisted mode and reports active filtering', () => {
    const modes: TestManagerStatusFilter[] = ['all', 'built', 'running'];
    for (const mode of modes) {
        const service = new TestManagerStatusFilterService(new WorkspaceState({
            'testManager.statusFilter': mode
        }));
        assert.equal(service.getMode(), mode);
        assert.equal(service.isActive(), mode !== 'all');
    }
});

test('persists before publishing one frozen event per real transition', async () => {
    const state = new WorkspaceState();
    const service = new TestManagerStatusFilterService(state);
    const events: Array<{ mode: TestManagerStatusFilter; persisted: boolean; frozen: boolean }> = [];
    service.onDidChangeMode(event => events.push({
        mode: event.mode,
        persisted: state.get('testManager.statusFilter') === event.mode,
        frozen: Object.isFrozen(event)
    }));

    await service.setMode('built');
    await service.setMode('built');
    await service.setMode('running');

    assert.deepEqual(state.updates, [
        { key: 'testManager.statusFilter', value: 'built' },
        { key: 'testManager.statusFilter', value: 'running' }
    ]);
    assert.deepEqual(events, [
        { mode: 'built', persisted: true, frozen: true },
        { mode: 'running', persisted: true, frozen: true }
    ]);
});

test('serializes concurrent transitions so an earlier slow write cannot win', async () => {
    let releaseBuilt!: () => void;
    const builtGate = new Promise<void>(resolve => {
        releaseBuilt = resolve;
    });
    const state = new WorkspaceState({}, async value => {
        if (value === 'built') {
            await builtGate;
        }
    });
    const service = new TestManagerStatusFilterService(state);
    const events: TestManagerStatusFilter[] = [];
    service.onDidChangeMode(event => events.push(event.mode));

    const built = service.setMode('built');
    const running = service.setMode('running');
    await Promise.resolve();
    assert.equal(service.getMode(), 'all');
    releaseBuilt();
    await Promise.all([built, running]);

    assert.deepEqual(state.updates, [
        { key: 'testManager.statusFilter', value: 'built' },
        { key: 'testManager.statusFilter', value: 'running' }
    ]);
    assert.deepEqual(events, ['built', 'running']);
    assert.equal(service.getMode(), 'running');
});

test('disposing removes change listeners', async () => {
    const service = new TestManagerStatusFilterService(new WorkspaceState());
    const events: TestManagerStatusFilter[] = [];
    service.onDidChangeMode(event => events.push(event.mode));
    service.dispose();

    await service.setMode('built');

    assert.deepEqual(events, []);
});
