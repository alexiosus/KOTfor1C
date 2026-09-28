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

    function createState(value) {
        const source = value && typeof value === 'object' ? value : {};
        return Object.freeze({
            selectedId: cleanId(source.selectedId),
            pendingId: cleanId(source.pendingId),
            menuId: cleanId(source.menuId)
        });
    }

    function withItems(state, items) {
        const current = createState(state);
        const ids = Array.isArray(items)
            ? items.map(item => cleanId(item && item.id)).filter(Boolean)
            : [];
        const idSet = new Set(ids);
        return createState({
            selectedId: idSet.has(current.selectedId) ? current.selectedId : (ids[0] || null),
            pendingId: current.pendingId === '__create__' || idSet.has(current.pendingId)
                ? current.pendingId
                : null,
            menuId: idSet.has(current.menuId) ? current.menuId : null
        });
    }

    function selectItem(state, itemId) {
        const current = createState(state);
        return createState({ ...current, selectedId: cleanId(itemId), menuId: null });
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

    function withPending(state, itemId) {
        const current = createState(state);
        return createState({ ...current, pendingId: cleanId(itemId), menuId: null });
    }

    function toggleMenu(state, itemId) {
        const current = createState(state);
        const nextId = cleanId(itemId);
        return createState({ ...current, menuId: current.menuId === nextId ? null : nextId });
    }

    function activeMarker(item) {
        return item && item.active === true
            ? Object.freeze({ visible: true, accessibleLabel: 'Active profile infobase' })
            : Object.freeze({ visible: false, accessibleLabel: '' });
    }

    return Object.freeze({
        createState,
        withItems,
        selectItem,
        moveSelection,
        withPending,
        toggleMenu,
        activeMarker
    });
});
