(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) { module.exports = api; }
    else { root.UserStepLibraries = api; }
}(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const isUser = item => item?.kind === 'userStep' || item?.definitionType === 'userStep';
    function canCopy(item) { return Boolean(item && (!isUser(item) || item.insertable === true)); }
    function stateLabel(item, labels) {
        if (!isUser(item)) { return ''; }
        return {
            sourceOnly: labels.sourceOnly || 'Source only', uncompiled: labels.notBuilt || 'Not built',
            stale: labels.rebuildRequired || 'Rebuild required', ready: labels.libraryBuilt || 'Built'
        }[item.userStepLibrary?.status || 'sourceOnly'];
    }
    function actions(item, labels) {
        if (!isUser(item)) { return []; }
        const library = item.userStepLibrary;
        const result = [{ id: 'buildUserStepLibrary', icon: library?.rootXmlPath ? 'tools' : 'new-folder',
            label: library?.rootXmlPath ? labels.buildEpf || 'Build EPF' : labels.createStepLibrary || 'Create EPF library…' }];
        if (library?.targetEpfPath && ['ready', 'stale'].includes(library.status)) {
            result.push({ id: 'dumpUserStepLibrary', icon: 'file-code', label: labels.dumpSources || 'Dump sources…' });
        }
        return result;
    }
    return { canCopy, stateLabel, actions };
}));
