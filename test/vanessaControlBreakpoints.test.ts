import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaBreakpointReconciler, type VanessaBreakpointPorts } from '../src/vanessaControlBreakpoints';
const target = { generation: 1, filePath: 'C:\\KOT\\safe.feature' };
function remote(initial: number[] = []) {
    let points = [...initial]; let current = true; let editor = { featurePath: target.filePath, dirty: false };
    const calls: number[] = [];
    const ports: VanessaBreakpointPorts = {
        assertCurrent: () => { if (!current) { throw new Error('changed'); } },
        editor: async () => editor, list: async () => [...points],
        settle: async () => undefined,
        toggle: async line => { calls.push(line); points = points.includes(line) ? points.filter(value => value !== line) : [...points, line]; }
    };
    return { ports, calls, points: () => points, userAdd: (line: number) => { if (!points.includes(line)) { points.push(line); } }, changeSession: () => { current = false; },
        select: (path: string, dirty = false) => { editor = { featurePath: path, dirty }; } };
}

test('reconciliation adds/removes only its own delta and preserves user-created remote points', async () => {
    const r = remote([4]); const sync = new VanessaBreakpointReconciler();
    assert.deepEqual(await sync.reconcile(target, [4, 8], r.ports), [4, 8]);
    assert.deepEqual(r.calls, [8]);
    assert.deepEqual(await sync.reconcile(target, [], r.ports), [4]);
    assert.deepEqual(r.calls, [8, 8]);
});

test('timeout after success is reconciled by reading before any retry, never blind toggle', async () => {
    const r = remote(); const toggle = r.ports.toggle;
    r.ports.toggle = async line => { await toggle(line); throw new Error('timeout'); };
    const sync = new VanessaBreakpointReconciler();
    assert.deepEqual(await sync.reconcile(target, [8], r.ports), [8]);
    assert.deepEqual(await sync.reconcile(target, [8], r.ports), [8]);
    assert.deepEqual(r.calls, [8]);
});

test('an unconfirmed toggle is retried only after a fresh list and never removes a point added meanwhile', async () => {
    const r = remote(); const sync = new VanessaBreakpointReconciler(); const toggle = r.ports.toggle;
    r.ports.toggle = async () => { throw new Error('timeout'); };
    await assert.rejects(sync.reconcile(target, [8], r.ports));
    await toggle(8); r.ports.toggle = toggle;
    assert.deepEqual(await sync.reconcile(target, [8], r.ports), [8]);
    assert.deepEqual(await sync.reconcile(target, [], r.ports), [8], 'the independently added point is not owned');
    assert.deepEqual(r.calls, [8]);
});

test('wrong active tab, dirty remote editor and changed attachment prevent mutations', async () => {
    for (const mode of ['wrong', 'dirty', 'changed'] as const) {
        const r = remote(); const sync = new VanessaBreakpointReconciler();
        if (mode === 'wrong') { r.select('C:\\other.feature'); }
        if (mode === 'dirty') { r.select(target.filePath, true); }
        if (mode === 'changed') { r.changeSession(); }
        await assert.rejects(sync.reconcile(target, [8], r.ports));
        assert.deepEqual(r.calls, []);
    }
});

test('active feature is rechecked between toggles and a late reply cannot mutate another attachment', async () => {
    const r = remote(); const toggle = r.ports.toggle;
    r.ports.toggle = async line => { await toggle(line); r.select('C:\\other.feature'); };
    await assert.rejects(new VanessaBreakpointReconciler().reconcile(target, [8, 12], r.ports));
    assert.deepEqual(r.calls, [8]);
});

test('detach/reset discards ownership without deleting remote breakpoints and validates one-based lines', async () => {
    const r = remote(); const sync = new VanessaBreakpointReconciler();
    await sync.reconcile(target, [8], r.ports); sync.reset();
    assert.deepEqual(await sync.reconcile({ ...target, generation: 2 }, [], r.ports), [8]);
    for (const lines of [[0], [-1], [1.5], [NaN], [8, 8]]) { await assert.rejects(sync.reconcile(target, lines, r.ports)); }
});

test('a read-only list never removes owned points, and reset invalidates an in-flight response', async () => {
    const r = remote(); const sync = new VanessaBreakpointReconciler();
    await sync.reconcile(target, [8], r.ports);
    assert.deepEqual(await sync.reconcile(target, undefined, r.ports), [8]);
    assert.deepEqual(r.calls, [8]);
    const list = r.ports.list;
    r.ports.list = async () => { sync.reset(); return list(); };
    await assert.rejects(sync.reconcile(target, [12], r.ports));
    assert.deepEqual(r.calls, [8]); assert.deepEqual(sync.ownedLines(target), []);
});

test('a point added externally between delta operations is never toggled off or claimed', async () => {
    const r = remote(); const toggle = r.ports.toggle; const sync = new VanessaBreakpointReconciler();
    r.ports.toggle = async line => { await toggle(line); if (line === 8) { r.userAdd(12); } };
    assert.deepEqual(await sync.reconcile(target, [8, 12], r.ports), [8, 12]);
    assert.deepEqual(r.calls, [8]);
    assert.deepEqual(await sync.reconcile(target, [], r.ports), [12]);
});

test('a toggle acknowledgement waits for the editor event before publishing ownership, without repeating toggle', async () => {
    const r = remote(); const toggle = r.ports.toggle; let pending: number | undefined;
    r.ports.toggle = async line => { pending = line; };
    r.ports.settle = async () => { if (pending) { await toggle(pending); pending = undefined; } };
    const sync = new VanessaBreakpointReconciler();
    assert.deepEqual(await sync.reconcile(target, [8], r.ports), [8]);
    assert.deepEqual(r.calls, [8]); assert.deepEqual(sync.ownedLines(target), [8]);
});
