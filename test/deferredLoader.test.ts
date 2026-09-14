import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeferredLoader } from '../src/deferredLoader';

test('does not invoke the factory before first use and reuses the loaded value', async () => {
    let calls = 0;
    const value = { command: 'ready' };
    const load = createDeferredLoader(async () => {
        calls += 1;
        return value;
    });

    assert.equal(calls, 0);
    assert.equal(await load(), value);
    assert.equal(await load(), value);
    assert.equal(calls, 1);
});

test('coalesces concurrent loads', async () => {
    let calls = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>(resolve => {
        release = resolve;
    });
    const load = createDeferredLoader(async () => {
        calls += 1;
        return pending;
    });

    const first = load();
    const second = load();
    release('loaded');

    assert.equal(await first, 'loaded');
    assert.equal(await second, 'loaded');
    assert.equal(calls, 1);
});

test('allows a retry after a failed load', async () => {
    let calls = 0;
    const load = createDeferredLoader(async () => {
        calls += 1;
        if (calls === 1) {
            throw new Error('temporary failure');
        }
        return 'loaded';
    });

    await assert.rejects(load(), /temporary failure/);
    assert.equal(await load(), 'loaded');
    assert.equal(calls, 2);
});
