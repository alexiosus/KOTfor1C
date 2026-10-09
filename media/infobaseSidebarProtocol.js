(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.InfobaseSidebarProtocol = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    function cleanId(value) {
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    function cleanPendingActions(value) {
        const source = value && typeof value === 'object' ? value : {};
        const result = {};
        for (const [rawId, rawAction] of Object.entries(source)) {
            const id = cleanId(rawId);
            const action = cleanId(rawAction);
            if (id && action) {
                result[id] = action;
            }
        }
        return Object.freeze(result);
    }

    function createState(value) {
        const source = value && typeof value === 'object' ? value : {};
        return Object.freeze({
            selectedId: cleanId(source.selectedId),
            pendingActions: cleanPendingActions(source.pendingActions),
            menuId: cleanId(source.menuId),
            submenuId: cleanId(source.submenuId)
        });
    }

    function withItems(state, items) {
        const current = createState(state);
        const ids = Array.isArray(items)
            ? items.map(item => cleanId(item && item.id)).filter(Boolean)
            : [];
        const idSet = new Set(ids);
        const pendingActions = Object.fromEntries(
            Object.entries(current.pendingActions)
                .filter(([id]) => id === '__create__' || idSet.has(id))
        );
        return createState({
            selectedId: idSet.has(current.selectedId) ? current.selectedId : (ids[0] || null),
            pendingActions,
            menuId: idSet.has(current.menuId) ? current.menuId : null,
            submenuId: idSet.has(current.submenuId) ? current.submenuId : null
        });
    }

    function selectItem(state, itemId) {
        const current = createState(state);
        return createState({ ...current, selectedId: cleanId(itemId), menuId: null, submenuId: null });
    }

    function moveSelection(state, itemIds, delta) {
        const current = createState(state);
        if (!Array.isArray(itemIds) || itemIds.length === 0) {
            return current;
        }
        const selectedIndex = Math.max(0, itemIds.indexOf(current.selectedId));
        const nextIndex = Math.max(0, Math.min(itemIds.length - 1, selectedIndex + Number(delta || 0)));
        return selectItem(current, itemIds[nextIndex]);
    }

    function withPending(state, itemId, action) {
        const current = createState(state);
        const id = cleanId(itemId);
        if (!id) {
            return current;
        }
        const pendingActions = { ...current.pendingActions };
        const nextAction = cleanId(action);
        if (nextAction) {
            pendingActions[id] = nextAction;
        } else {
            delete pendingActions[id];
        }
        return createState({ ...current, pendingActions, menuId: null, submenuId: null });
    }

    function toggleMenu(state, itemId) {
        const current = createState(state);
        const nextId = cleanId(itemId);
        return createState({
            ...current,
            menuId: current.menuId === nextId ? null : nextId,
            submenuId: null
        });
    }

    function toggleSubmenu(state, itemId) {
        const current = createState(state);
        const nextId = cleanId(itemId);
        if (!nextId || current.menuId !== nextId) {
            return current;
        }
        return createState({
            ...current,
            submenuId: current.submenuId === nextId ? null : nextId
        });
    }

    const AVAILABLE_WHILE_PENDING = new Set(['reveal', 'logs']);
    const AVAILABLE_WHILE_RUNNING = new Set([
        'openEnterprise',
        'openDesigner',
        'openFormExplorer',
        'reveal',
        'logs'
    ]);

    function actionEnabled(item, action, pendingAction = null) {
        if (cleanId(pendingAction)) {
            return AVAILABLE_WHILE_PENDING.has(action);
        }
        if (item && item.running === true) {
            return AVAILABLE_WHILE_RUNNING.has(action);
        }
        return true;
    }

    function runtimeMarker(item, pendingAction = null, labels = {}) {
        if (cleanId(pendingAction)) {
            return Object.freeze({
                state: 'pending',
                visible: true,
                accessibleLabel: labels.pending || 'Infobase operation in progress'
            });
        }
        if (item && item.running === true) {
            return Object.freeze({
                state: 'running',
                visible: true,
                accessibleLabel: labels.running || 'Running from KOT'
            });
        }
        return Object.freeze({ state: 'idle', visible: false, accessibleLabel: '' });
    }

    return Object.freeze({
        createState,
        withItems,
        selectItem,
        moveSelection,
        withPending,
        toggleMenu,
        toggleSubmenu,
        actionEnabled,
        runtimeMarker
    });
});
