import assert from 'node:assert/strict';
import test from 'node:test';
import { LazyScenarioCatalog } from '../src/lazyScenarioCatalog';
import { buildScenarioCatalog } from '../src/scenarioCatalog';

const emptyCatalog = buildScenarioCatalog([]);

test('coalesces concurrent loads', async () => {
    let loadCount = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const state = new LazyScenarioCatalog(async () => {
        loadCount += 1;
        await gate;
        return emptyCatalog;
    });

    const first = state.ensureLoaded();
    const second = state.ensureLoaded();
    assert.equal(loadCount, 1);
    release();
    assert.equal(await first, emptyCatalog);
    assert.equal(await second, emptyCatalog);
});

test('invalidation stays lazy until the next ensure call', async () => {
    let loadCount = 0;
    const state = new LazyScenarioCatalog(async () => {
        loadCount += 1;
        return emptyCatalog;
    });

    await state.ensureLoaded();
    state.invalidate();
    assert.equal(loadCount, 1);
    assert.equal(state.isDirty, true);
    await state.ensureLoaded();
    assert.equal(loadCount, 2);
});

test('retries after a failed load and does not publish a partial value', async () => {
    let loadCount = 0;
    const state = new LazyScenarioCatalog(async () => {
        loadCount += 1;
        if (loadCount === 1) {
            throw new Error('scan failed');
        }
        return emptyCatalog;
    });

    await assert.rejects(state.ensureLoaded(), /scan failed/);
    assert.equal(state.current, null);
    assert.equal(await state.ensureLoaded(), emptyCatalog);
    assert.equal(loadCount, 2);
});

test('update does not initialize an unloaded state', () => {
    let transformed = false;
    const state = new LazyScenarioCatalog(async () => emptyCatalog);

    assert.equal(state.update(catalog => {
        transformed = true;
        return catalog;
    }), false);
    assert.equal(transformed, false);
});

test('update does not publish incremental changes over a dirty catalog', async () => {
    const state = new LazyScenarioCatalog(async () => emptyCatalog);
    await state.ensureLoaded();
    state.invalidate();

    assert.equal(state.update(catalog => catalog), false);
    assert.equal(state.isDirty, true);
});
