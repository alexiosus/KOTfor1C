import assert from 'node:assert/strict';
import test from 'node:test';
import { mapWithConcurrencyLimit } from '../src/boundedConcurrency';

test('limits concurrent work and preserves input order', async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];

    const resultPromise = mapWithConcurrencyLimit([1, 2, 3, 4], 2, async value => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>(resolve => release.push(resolve));
        active -= 1;
        return value * 10;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, 2);
    release.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
    release.splice(0).forEach(resolve => resolve());

    assert.deepEqual(await resultPromise, [10, 20, 30, 40]);
    assert.equal(maxActive, 2);
});

test('stops scheduling new work after the first failure', async () => {
    const started: number[] = [];

    await assert.rejects(
        mapWithConcurrencyLimit([1, 2, 3, 4], 2, async value => {
            started.push(value);
            if (value === 1) {
                throw new Error('failed');
            }
            await new Promise(resolve => setImmediate(resolve));
            return value;
        }),
        /failed/
    );

    assert.deepEqual(started, [1, 2]);
});
