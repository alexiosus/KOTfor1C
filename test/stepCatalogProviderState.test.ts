import assert from 'node:assert/strict';
import test from 'node:test';
import { PreparedStepStateCache } from '../src/preparedStepStateCache';

test('prepared state cache reuses equal identities and separates different versions', () => {
    const cache = new PreparedStepStateCache<{ value: string }>(8);
    const first = cache.getOrCreate('versioned:aaa', () => ({ value: 'A' }));
    const same = cache.getOrCreate('versioned:aaa', () => ({ value: 'unused' }));
    const other = cache.getOrCreate('versioned:bbb', () => ({ value: 'B' }));

    assert.equal(first, same);
    assert.notEqual(first, other);
});

test('prepared state cache evicts the least recently used identity', () => {
    const cache = new PreparedStepStateCache<{ value: string }>(2);
    const first = cache.getOrCreate('first', () => ({ value: 'first' }));
    cache.getOrCreate('second', () => ({ value: 'second' }));
    assert.equal(cache.getOrCreate('first', () => ({ value: 'unused' })), first);
    cache.getOrCreate('third', () => ({ value: 'third' }));

    const rebuiltSecond = cache.getOrCreate('second', () => ({ value: 'rebuilt' }));
    assert.equal(rebuiltSecond.value, 'rebuilt');
});

test('prepared state cache supports targeted and full invalidation', () => {
    const cache = new PreparedStepStateCache<object>();
    const first = cache.getOrCreate('first', () => ({}));
    const second = cache.getOrCreate('second', () => ({}));
    cache.delete('first');
    assert.notEqual(cache.getOrCreate('first', () => ({})), first);
    assert.equal(cache.getOrCreate('second', () => ({})), second);

    cache.clear();
    assert.notEqual(cache.getOrCreate('second', () => ({})), second);
});

test('prepared state cache rejects non-positive capacity', () => {
    assert.throws(() => new PreparedStepStateCache(0), /positive integer/);
});
