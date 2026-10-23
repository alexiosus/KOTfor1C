import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const protocol = require(path.join(process.cwd(), 'media', 'infobaseSidebarProtocol.js')) as {
    createState(value?: unknown): {
        selectedId: string | null;
        pendingActions: Readonly<Record<string, string>>;
        menuId: string | null;
        submenuId: string | null;
    };
    withItems(state: unknown, items: readonly unknown[]): ReturnType<typeof protocol.createState>;
    selectItem(state: unknown, itemId: string | null): ReturnType<typeof protocol.createState>;
    moveSelection(state: unknown, itemIds: readonly string[], delta: number): ReturnType<typeof protocol.createState>;
    withPending(state: unknown, itemId: string, action: string | null): ReturnType<typeof protocol.createState>;
    toggleMenu(state: unknown, itemId: string): ReturnType<typeof protocol.createState>;
    toggleSubmenu(state: unknown, itemId: string): ReturnType<typeof protocol.createState>;
    actionEnabled(item: unknown, action: string, pendingAction?: string | null): boolean;
    runtimeMarker(
        item: unknown,
        pendingAction?: string | null,
        labels?: { running?: string; pending?: string }
    ): { state: 'idle' | 'running' | 'pending'; visible: boolean; accessibleLabel: string };
};

test('owns immutable selection, pending-row, and overflow-menu state', () => {
    const initial = protocol.createState({ selectedId: 'one', menuId: 'one' });
    const selected = protocol.selectItem(initial, 'two');
    const pending = protocol.withPending(selected, 'two', 'importDt');
    const menu = protocol.toggleMenu(pending, 'two');

    assert.equal(initial.selectedId, 'one');
    assert.equal(selected.selectedId, 'two');
    assert.deepEqual(pending.pendingActions, { two: 'importDt' });
    assert.equal(menu.menuId, 'two');
    assert.ok(Object.isFrozen(menu));
    assert.ok(Object.isFrozen(menu.pendingActions));
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

test('shows a yellow pending marker before a green KOT runtime marker', () => {
    assert.equal(typeof protocol.runtimeMarker, 'function');
    assert.deepEqual(protocol.runtimeMarker({ running: true }), {
        state: 'running',
        visible: true,
        accessibleLabel: 'Running from KOT'
    });
    assert.deepEqual(protocol.runtimeMarker({ running: true }, 'updateConfiguration', {
        pending: 'Updating infobase'
    }), {
        state: 'pending',
        visible: true,
        accessibleLabel: 'Updating infobase'
    });
    assert.deepEqual(protocol.runtimeMarker({ running: false }, null), {
        state: 'idle',
        visible: false,
        accessibleLabel: ''
    });
});

test('locks only conflicting actions for the affected infobase', () => {
    const pending = protocol.withPending(protocol.createState(), 'one', 'exportDt');

    assert.equal(protocol.actionEnabled({ id: 'one', running: false }, 'openEnterprise', pending.pendingActions.one), false);
    assert.equal(protocol.actionEnabled({ id: 'one', running: false }, 'updateConfiguration', pending.pendingActions.one), false);
    assert.equal(protocol.actionEnabled({ id: 'one', running: false }, 'logs', pending.pendingActions.one), true);
    assert.equal(protocol.actionEnabled({ id: 'two', running: false }, 'updateConfiguration', pending.pendingActions.two), true);

    assert.equal(protocol.actionEnabled({ id: 'one', running: true }, 'openEnterprise'), true);
    assert.equal(protocol.actionEnabled({ id: 'one', running: true }, 'openFormExplorer'), true);
    assert.equal(protocol.actionEnabled({ id: 'one', running: true }, 'vanessaClients'), true);
    assert.equal(protocol.actionEnabled({ id: 'one', running: true }, 'vanessaClients', 'importDt'), true);
    assert.equal(protocol.actionEnabled({ id: 'one', running: true }, 'updateConfiguration'), false);
    assert.equal(protocol.actionEnabled({ id: 'one', running: true }, 'exportDt'), false);
    assert.equal(protocol.actionEnabled({ id: 'one', running: true }, 'logs'), true);
});

test('clearing one pending action preserves operations on other infobases', () => {
    const both = protocol.withPending(
        protocol.withPending(protocol.createState(), 'one', 'importDt'),
        'two',
        'exportCf'
    );
    const remaining = protocol.withPending(both, 'one', null);

    assert.deepEqual(remaining.pendingActions, { two: 'exportCf' });
});

test('owns an explicit other-actions submenu and closes it with its parent menu', () => {
    const menu = protocol.toggleMenu(protocol.createState(), 'base');
    const opened = protocol.toggleSubmenu(menu, 'base');
    assert.equal(opened.menuId, 'base');
    assert.equal(opened.submenuId, 'base');

    const closed = protocol.toggleMenu(opened, 'base');
    assert.equal(closed.menuId, null);
    assert.equal(closed.submenuId, null);
});
