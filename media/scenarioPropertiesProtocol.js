(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) { module.exports = api; }
    root.ScenarioPropertiesProtocol = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_LABELS = Object.freeze({
        properties: 'Properties', fillParameters: 'Fill from scenario text', fillNested: 'Fill from scenario text',
        fillProcessDefaults: 'Fill missing process defaults',
        createChoice: 'Create new…', dismissError: 'Dismiss error', tagName: 'Tag name', defaultValue: 'Default value',
        loadingRelated: 'Loading linked settings…',
        usages: 'Usages in scenario text', unnamedRecord: 'Unnamed record',
        sourceStep: 'Source step', 'No source step': 'No source step', unknownReference: 'Missing reference', unknownGroup: 'Missing group',
        combinations: 'Build variants', combinationsHint: 'Preview of parameter combinations for the selected settings. Semicolon lists are combined; this is not a scenario result.',
        variantLimitWarning: 'The compiler supports at most {0} parameter combinations; the selected settings produce {1}.',
        title: 'Test properties', header: 'Header', testSettings: 'Test settings', metadata: 'KOT metadata',
        copyPath: 'Copy path',
        scenario: 'Scenario', process: 'Process', test: 'Test settings', processTest: 'Process settings',
        empty: 'Open a scenario or process to edit its properties.', noRecords: 'No records', noSettings: 'No linked test settings.',
        selectSettings: 'Test settings file', createSettings: 'Create test settings', save: 'Save test',
        saved: 'Saved', unsaved: 'Unsaved changes', applying: 'Applying changes…', pin: 'Pin test', unpin: 'Unpin test',
        openSource: 'Open YAML', openText: 'Fold service sections', openSettings: 'Open settings YAML', openMetadata: 'Open KOT metadata',
        rename: 'Rename', changeCode: 'Change code', systemFunction: 'System function', copy: 'Copy UID', copied: 'Copied',
        base: 'Select infobase', users: 'Select users', addRecord: 'Add record', removeRecord: 'Remove record',
        addSteps: 'Add process step', addNested: 'Add nested scenario', openReference: 'Open referenced definition',
        moveUp: 'Move up', moveDown: 'Move down', dragRecord: 'Drag to reorder', dropAtEnd: 'Move record to the end',
        groupId: 'Group', ungrouped: 'Ungrouped', order: 'Order', description: 'Description', category: 'Category',
        newGroup: 'New group', aiDescription: 'Generate description with AI',
        files: 'Files', dropAttachments: 'Drop files anywhere in this panel to attach them to the test.',
        openAttachment: 'Open attachment', revealAttachments: 'Open folder', deleteAttachment: 'Delete attachment', renameAttachment: 'Rename attachment',
        addAttachments: 'Add files', insertAttachment: 'Insert file name',
        parameterConsequences: 'Renaming updates declarations and bracket references in this scenario. Arguments in callers remain unchanged.',
        nestingHint: 'Declarations do not change execution order. Edit calls and arguments in the scenario text.',
        processHint: 'Steps run in the listed order.', selectSettingsHint: 'Select a settings file to edit its values.',
        invalidState: 'Properties are unavailable. Open YAML to check the source.',
        'ПараметрыСценария': 'Scenario parameters', 'ВложенныеСценарии': 'Nested scenarios', 'ШагиПроцесса': 'Process steps',
        'ПараметрыШага': 'Step parameters', 'ПараметрыТеста': 'Test parameters', 'ТегиСценария': 'Scenario tags',
        'ТегиПроцесса': 'Process tags', 'ТегиТеста': 'Test tags'
    });
    const actions = new Set(['save', 'pin', 'openSource', 'openText', 'openSettings', 'openMetadata', 'copyPath', 'rename', 'changeCode',
        'systemFunction', 'base', 'users', 'addSteps', 'aiDescription', 'changeGroup', 'newGroup', 'createSettings',
        'selectSettings', 'addNested', 'openReference', 'fillParameters', 'fillNested', 'dismissError']);
    const metadataFields = new Set(['groupId', 'order', 'description', 'category']);
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const nonempty = value => typeof value === 'string' && value.length > 0;
    const optionalString = value => value === undefined || nonempty(value);
    const revision = value => Number.isSafeInteger(value) && value >= 0;

    function remapUri(uri, moves) {
        for (const move of moves || []) {
            const old = move.oldUri.replace(/\/$/u, '');
            if (uri === old || uri.startsWith(old + '/')) { uri = move.newUri.replace(/\/$/u, '') + uri.slice(old.length); }
        }
        return uri;
    }

    function validTarget(target) {
        return object(target) && nonempty(target.section) && optionalString(target.recordKey) && optionalString(target.stepUid);
    }
    function validateMessage(message) {
        if (!object(message)) { return false; }
        if (message.command === 'ready') { return true; }
        if (message.command === 'action') { return actions.has(message.action) && (message.value === undefined || typeof message.value === 'string'); }
        if (!nonempty(message.documentUri) || !revision(message.documentVersion)) { return false; }
        if (message.command === 'fillProcessDefaults') {
            return revision(message.sourceVersion) && object(message.target) && message.target.section === 'ПараметрыТеста'
                && message.target.recordKey === undefined && message.target.stepUid === undefined;
        }
        if (['createChoice', 'catalogChoice'].includes(message.command)) {
            return validTarget(message.target) && nonempty(message.target.field) && message.target.recordKey === undefined
                && message.target.stepUid === undefined && (message.command === 'createChoice' || typeof message.value === 'string');
        }
        if (message.command === 'edit') { return validTarget(message.edit) && nonempty(message.edit.field) && typeof message.edit.value === 'string'; }
        if (message.command === 'editMetadata') { return metadataFields.has(message.field) && typeof message.value === 'string'; }
        if (!validTarget(message.target)) { return false; }
        if (message.command === 'addRecord') { return message.target.recordKey === undefined; }
        if (message.command === 'removeRecord') { return nonempty(message.target.recordKey); }
        return message.command === 'moveRecord' && nonempty(message.target.recordKey)
            && (message.target.beforeRecordKey === null || nonempty(message.target.beforeRecordKey));
    }

    function validDocument(value) {
        return object(value) && nonempty(value.uri) && revision(value.version) && object(value.model)
            && ['scenario', 'process', 'test', 'processTest'].includes(value.model.kind)
            && typeof value.model.title === 'string' && Array.isArray(value.model.header) && Array.isArray(value.model.sections);
    }
    function normalizeState(state) {
        if (!object(state) || state.source !== null && !validDocument(state.source)) { return null; }
        return {
            ...state, settings: Array.isArray(state.settings) ? state.settings.filter(validDocument) : [],
            metadata: object(state.metadata) && nonempty(state.metadata.uri) && revision(state.metadata.version)
                && object(state.metadata.values) ? state.metadata : null,
            groups: Array.isArray(state.groups) ? state.groups.filter(group => object(group) && nonempty(group.id) && typeof group.name === 'string') : [],
            uriMoves: Array.isArray(state.uriMoves) ? state.uriMoves.filter(move => object(move) && nonempty(move.oldUri) && nonempty(move.newUri)) : [],
            labels: { ...DEFAULT_LABELS, ...(object(state.labels) ? Object.fromEntries(Object.entries(state.labels).filter(([, value]) => typeof value === 'string')) : {}) }
        };
    }

    function createClient(options) {
        let state = null;
        let active = false;
        let activeMessage = null;
        const queue = [];
        const navigation = new Set(['openSource', 'openText', 'openSettings', 'openMetadata', 'openReference', 'copyPath', 'pin', 'dismissError']);
        const changes = message => message && (message.command !== 'action' || !navigation.has(message.action));
        function isPending() { return Boolean(active && changes(activeMessage) || queue.some(request => changes(request.message))); }
        function notify() { options.onPending?.(isPending()); }
        function boundDocument(uri) {
            return [state?.source, ...(state?.settings || []), state?.metadata].find(document => document?.uri === uri);
        }
        function flush() {
            if (active || !state?.source) { notify(); return; }
            while (queue.length) {
                const request = queue.shift();
                if (request.sourceUri !== state.source.uri) { continue; }
                const message = request.message;
                if (message.command !== 'action') {
                    const document = message.command === 'editMetadata' && message.documentUri === state.source.uri
                        ? state.metadata || state.source : boundDocument(message.documentUri);
                    if (!document) { continue; }
                    message.documentUri = document.uri;
                    message.documentVersion = document.version;
                    if (message.command === 'fillProcessDefaults') { message.sourceVersion = state.source.version; }
                }
                active = true;
                activeMessage = message;
                options.postMessage(message);
                break;
            }
            notify();
        }
        function enqueue(message) {
            if (!state?.source || !validateMessage(message) || message.command === 'ready') { return false; }
            if (message.command !== 'action' && !boundDocument(message.documentUri)) { return false; }
            queue.push({ sourceUri: state.source.uri, message: JSON.parse(JSON.stringify(message)) });
            flush();
            return true;
        }
        function setState(value, acknowledgement = true) {
            const next = normalizeState(value);
            const failed = acknowledgement && active && (next?.mutationError ?? !!next?.error);
            const uid = source => source?.model?.header?.find(field => field.key === 'UID')?.value?.trim().toLowerCase();
            const moved = !failed && next?.source && state?.source && next.uriMoves.length
                && remapUri(state.source.uri, next.uriMoves) === next.source.uri && uid(state.source) && uid(state.source) === uid(next.source)
                && state.source.model.kind === next.source.model.kind && [state.source, ...state.settings, state.metadata]
                    .some(document => document && remapUri(document.uri, next.uriMoves) !== document.uri);
            if (moved) {
                for (const request of queue) {
                    request.sourceUri = remapUri(request.sourceUri, next.uriMoves);
                    if (request.message.documentUri) { request.message.documentUri = remapUri(request.message.documentUri, next.uriMoves); }
                    if (request.message.command === 'action' && request.message.action === 'selectSettings') {
                        request.message.value = remapUri(request.message.value, next.uriMoves);
                    }
                }
                options.onMove?.(next.uriMoves);
            }
            if (!acknowledgement && active && (next?.source?.uri === state?.source?.uri || moved)) {
                state = next; options.onState?.(state, false); notify(); return;
            }
            if (next?.source && !failed && state?.source?.uri === next.source.uri && activeMessage?.command === 'edit' && activeMessage.edit.recordKey) {
                const edit = activeMessage.edit;
                const previous = findRecords(state, activeMessage.documentUri, edit);
                const updated = findRecords(next, activeMessage.documentUri, edit);
                const matches = updated.filter(record => record.fields.some(field => field.key === edit.field && field.value === edit.value));
                if (previous.some(record => record.key === edit.recordKey) && !updated.some(record => record.key === edit.recordKey) && matches.length === 1) {
                    const newKey = matches[0].key;
                    for (const request of queue) {
                        const target = request.message.edit || request.message.target;
                        if (request.message.documentUri === activeMessage.documentUri && target?.section === edit.section && target.stepUid === edit.stepUid) {
                            if (target.recordKey === edit.recordKey) { target.recordKey = newKey; }
                            if (target.beforeRecordKey === edit.recordKey) { target.beforeRecordKey = newKey; }
                        }
                    }
                    options.onRekey?.({ documentUri: activeMessage.documentUri, section: edit.section, stepUid: edit.stepUid, oldKey: edit.recordKey, newKey });
                }
            }
            state = next;
            active = false;
            activeMessage = null;
            if (!state?.source || failed) { queue.length = 0; }
            options.onState?.(state, failed);
            flush();
        }
        return Object.freeze({ setState, enqueue, action: (action, value) => enqueue({ command: 'action', action,
            ...(value === undefined ? {} : { value }) }), isPending, getState: () => state });
    }

    function findRecords(state, uri, target) {
        const model = [state.source, ...state.settings].find(document => document.uri === uri)?.model;
        const found = [];
        function visit(sections, stepUid) {
            for (const section of sections || []) {
                if (section.key === target.section && stepUid === target.stepUid) { found.push(...(section.records || [])); }
                for (const record of section.records || []) {
                    const uid = section.key === 'ШагиПроцесса' ? record.fields.find(field => field.key === 'UID')?.value : stepUid;
                    visit(record.sections, uid);
                }
            }
        }
        visit(model?.sections);
        return found;
    }
    return Object.freeze({ DEFAULT_LABELS, normalizeState, validateMessage, createClient, remapUri });
}));
