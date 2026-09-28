import assert from 'node:assert/strict';
import test from 'node:test';
import {
    collectTreeWithConcurrencyLimit,
    ConcurrencyCancelledError,
    mapWithConcurrencyLimit,
    runWithConcurrencyLimit
} from '../src/boundedConcurrency';

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

test('tree collection overlaps directory reads within a bound and preserves discovery order', async () => {
    const children = new Map<string, string[]>([
        ['root', ['a', 'b', 'c', 'd', 'e']],
        ['a', ['a1']],
        ['c', ['c1']]
    ]);
    let active = 0;
    let maxActive = 0;

    const files = await collectTreeWithConcurrencyLimit('root', 3, async directory => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        return {
            children: children.get(directory) || [],
            values: [`${directory}/scen.yaml`]
        };
    });

    assert.equal(maxActive, 3);
    assert.deepEqual(files, [
        'root/scen.yaml',
        'a/scen.yaml', 'b/scen.yaml', 'c/scen.yaml', 'd/scen.yaml', 'e/scen.yaml',
        'a1/scen.yaml', 'c1/scen.yaml'
    ]);
});

test('tree collection does not start child-directory reads after cancellation', async () => {
    let cancelled = false;
    const visited: string[] = [];

    const files = await collectTreeWithConcurrencyLimit('root', 4, async directory => {
        visited.push(directory);
        cancelled = true;
        return { children: ['child'], values: ['root/scen.yaml'] };
    }, () => cancelled);

    assert.deepEqual(visited, ['root']);
    assert.deepEqual(files, ['root/scen.yaml']);
});

test('runWithConcurrencyLimit stops scheduling after cancellation and rejects partial results', async () => {
    let cancelled = false;
    const started: number[] = [];

    await assert.rejects(
        runWithConcurrencyLimit([1, 2, 3, 4], 2, async value => {
            started.push(value);
            if (started.length === 2) {
                cancelled = true;
            }
            await new Promise(resolve => setImmediate(resolve));
            return value;
        }, { shouldCancel: () => cancelled }),
        ConcurrencyCancelledError
    );

    assert.deepEqual(started, [1, 2]);
});

test('runWithConcurrencyLimit periodically yields without exceeding its concurrency bound', async () => {
    let active = 0;
    let maxActive = 0;
    let yields = 0;
    const result = await runWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async value => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        return value * 2;
    }, {
        yieldEvery: 2,
        yieldControl: async () => {
            yields += 1;
        }
    });

    assert.deepEqual(result, [2, 4, 6, 8, 10]);
    assert.equal(maxActive, 2);
    assert.equal(yields >= 2, true);
});
