import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectEntityDisplayOrder } from '../src/projectEntityDisplayOrder';

function fixture() {
    const values = new Map<string, unknown>();
    return { values, order: new ProjectEntityDisplayOrder({ get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key, value) => { values.set(key, value); } }) };
}

test('personal entity order preserves initial legacy fallback and stays isolated by project, section and workspace', async () => {
    const f = fixture();
    assert.equal(f.order.rank('/one', 'main', 'g', 'a', 7), 7);
    await f.order.move('/one', 'main', 'g', 'g', 'c', 'a', ['a', 'b', 'c'], ['a', 'b', 'c']);
    assert.deepEqual(['a', 'b', 'c'].map(key => f.order.rank('/one', 'main', 'g', key)), [1, 2, 0]);
    assert.equal(f.order.rank('/two', 'main', 'g', 'a', 7), 7);
    assert.equal(f.order.rank('/one', 'process', 'g', 'a', 7), 7);
    assert.equal(fixture().order.rank('/one', 'main', 'g', 'a', 7), 7);
    assert.equal(f.order.rank('/one', 'main', 'g', 'new', 1), undefined, 'new members follow the personal ordering');
});

test('moving between groups changes local positions in both lists without persisting source data', async () => {
    const f = fixture();
    await f.order.move('/one', 'main', 'first', 'second', 'b', 'x', ['a', 'b'], ['x', 'y']);
    assert.equal(f.order.rank('/one', 'main', 'first', 'a'), 0);
    assert.equal(f.order.rank('/one', 'main', 'first', 'b'), undefined);
    assert.deepEqual(['b', 'x', 'y'].map(key => f.order.rank('/one', 'main', 'second', key)), [0, 1, 2]);
    assert.equal(f.values.size, 1, 'one local state update covers both lists');
});

test('manual display order and reset are local, and state can be restored after a shared-write failure', async () => {
    const f = fixture();
    const before = f.order.capture('/one', 'main');
    await f.order.set('/one', 'main', 'g', 'a', 4, [{ key: 'b', order: 8 }]);
    assert.equal(f.order.rank('/one', 'main', 'g', 'a'), 4);
    assert.equal(f.order.rank('/one', 'main', 'g', 'b'), 8);
    await f.order.set('/one', 'main', 'g', 'a', null);
    assert.equal(f.order.rank('/one', 'main', 'g', 'a', 7), undefined);
    await f.order.restore('/one', 'main', before);
    assert.equal(f.order.rank('/one', 'main', 'g', 'a', 7), 7);
});

test('malformed local state and unsafe moves do not damage current state', async () => {
    const f = fixture();
    await f.order.move('/one', 'main', 'g', 'g', 'a', undefined, ['a', 'b'], ['a', 'b']);
    const before = f.order.capture('/one', 'main');
    await assert.rejects(f.order.move('/one', 'main', 'g', 'g', 'missing', undefined, ['a', 'b'], ['a', 'b']));
    await assert.rejects(f.order.set('/one', 'main', 'g', 'a', -1));
    assert.deepEqual(f.order.capture('/one', 'main'), before);
    for (const key of f.values.keys()) { f.values.set(key, { g: { a: 'bad', b: Infinity } }); }
    assert.equal(f.order.rank('/one', 'main', 'g', 'a', 3), 3);
});
