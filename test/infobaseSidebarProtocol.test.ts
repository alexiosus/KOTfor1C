import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const protocol = require(path.join(process.cwd(), 'media', 'infobaseSidebarProtocol.js')) as {
    createState(value?: unknown): {
        selectedId: string | null;
        pendingId: string | null;
        menuId: string | null;
    };
    withItems(state: unknown, items: readonly unknown[]): ReturnType<typeof protocol.createState>;
    selectItem(state: unknown, itemId: string | null): ReturnType<typeof protocol.createState>;
    moveSelection(state: unknown, itemIds: readonly string[], delta: number): ReturnType<typeof protocol.createState>;
    withPending(state: unknown, itemId: string | null): ReturnType<typeof protocol.createState>;
    toggleMenu(state: unknown, itemId: string): ReturnType<typeof protocol.createState>;
    activeMarker(item: unknown): { visible: boolean; accessibleLabel: string };
};

test('owns immutable selection, pending-row, and overflow-menu state', () => {
    const initial = protocol.createState({ selectedId: 'one', menuId: 'one' });
    const selected = protocol.selectItem(initial, 'two');
    const pending = protocol.withPending(selected, 'two');
    const menu = protocol.toggleMenu(pending, 'two');

    assert.equal(initial.selectedId, 'one');
    assert.equal(selected.selectedId, 'two');
    assert.equal(pending.pendingId, 'two');
    assert.equal(menu.menuId, 'two');
    assert.ok(Object.isFrozen(menu));
});

test('reconciles removed items and clamps roving keyboard selection', () => {
    const initial = protocol.createState({ selectedId: 'missing', menuId: 'missing' });
    const reconciled = protocol.withItems(initial, [{ id: 'one' }, { id: 'two' }]);

    assert.equal(reconciled.selectedId, 'one');
    assert.equal(reconciled.menuId, null);
    assert.equal(protocol.moveSelection(reconciled, ['one', 'two'], 1).selectedId, 'two');
    assert.equal(protocol.moveSelection(reconciled, ['one', 'two'], 20).selectedId, 'two');
    assert.equal(protocol.moveSelection(reconciled, ['one', 'two'], -20).selectedId, 'one');
});

test('shows the active-profile marker only for the projected active base', () => {
    assert.deepEqual(protocol.activeMarker({ active: true }), {
        visible: true,
        accessibleLabel: 'Active profile infobase'
    });
    assert.deepEqual(protocol.activeMarker({ active: false }), {
        visible: false,
        accessibleLabel: ''
    });
});
