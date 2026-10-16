import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectGroupDisplayOrder } from '../src/projectGroupDisplayOrder';
import type { ProjectGroup } from '../src/projectLibraryStore';

function fixture() {
    const values = new Map<string, unknown>();
    const state = { get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => { values.set(key, value); } };
    const groups: ProjectGroup[] = ['a', 'b', 'c'].map((id, order) => ({ id, name: id, order, sections: ['main', 'process'] }));
    return { values, state, groups, order: new ProjectGroupDisplayOrder(state) };
}

test('default group order is alphabetical regardless of creation or legacy import order', () => {
    const f = fixture();
    const groups: ProjectGroup[] = [
        { id: 'z', name: 'Zebra', order: 0, sections: ['main'] },
        { id: 'a', name: 'Alpha', order: 10, sections: ['main'] },
        { id: 'm', name: 'Middle', order: 1, sections: ['main'] }
    ];
    assert.deepEqual(f.order.ordered('/one', 'main', groups).map(group => group.name), ['Alpha', 'Middle', 'Zebra']);
    assert.deepEqual(groups.map(group => group.order), [0, 10, 1]);
    assert.equal(f.values.size, 0);
});

test('personal group drag overlays stable IDs per project and section without shared mutations', async () => {
    const f = fixture();
    await f.order.move('/one', 'main', f.groups, 'c', 'a', ['a', 'b', 'c']);
    assert.deepEqual(f.order.ordered('/one', 'main', f.groups).map(group => group.id), ['c', 'a', 'b']);
    assert.deepEqual(f.order.ordered('/one', 'process', f.groups).map(group => group.id), ['a', 'b', 'c']);
    assert.deepEqual(f.order.ordered('/two', 'main', f.groups).map(group => group.id), ['a', 'b', 'c']);
    assert.deepEqual(f.groups.map(group => group.order), [0, 1, 2]);
    assert.deepEqual(new ProjectGroupDisplayOrder({ get: () => undefined, update: async () => undefined }).ordered('/one', 'main', f.groups).map(group => group.id), ['a', 'b', 'c']);
    const changed = [{ ...f.groups[2], name: 'Renamed' }, { ...f.groups[0], order: 5 }, { id: 'd', name: 'New', order: 0, sections: ['main'] as const }];
    assert.deepEqual(f.order.ordered('/one', 'main', changed).map(group => group.id), ['c', 'a', 'd']);
});

test('personal group drag rejects stale IDs, foreign section, duplicate entries and malformed state', async () => {
    const f = fixture();
    for (const operation of [
        () => f.order.move('/one', 'main', f.groups, 'missing', 'a', ['a', 'b', 'c']),
        () => f.order.move('/one', 'standalone', f.groups, 'a', undefined, ['a', 'b', 'c']),
        () => f.order.move('/one', 'main', f.groups, 'a', 'missing', ['a', 'b', 'c']),
        () => f.order.move('/one', 'main', f.groups, 'a', 'b', ['a', 'a', 'c']),
        () => f.order.move('/one', 'main', f.groups, 'a', 'b', ['b', 'a', 'c'])
    ]) { await assert.rejects(operation); }
    assert.equal(f.values.size, 0);
    await f.order.move('/one', 'main', f.groups, 'c', undefined, ['a', 'b', 'c']);
    for (const key of f.values.keys()) { f.values.set(key, { invalid: true }); }
    assert.deepEqual(f.order.ordered('/one', 'main', f.groups).map(group => group.id), ['a', 'b', 'c']);
});
