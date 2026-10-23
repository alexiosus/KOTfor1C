(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.StepLibraryFeatureProtocol = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const DRAG_TYPE = 'application/vnd.kot.library-feature';
    const DEFAULT_LABELS = {
        createFeature: 'New feature', createGroup: 'New feature group',
        renameGroup: 'Rename group', deleteGroup: 'Delete group',
        openFeature: 'Open feature', renameFeature: 'Change feature title', renameFeatureFile: 'Rename feature file', generateJson: 'Generate launch JSON',
        selectJson: 'Select launch JSON', openJson: 'Open launch JSON',
        moveFeature: 'Move feature', moveUp: 'Move up', moveDown: 'Move down', actions: 'Feature actions',
        renameScenario: 'Rename scenario', renameMainGroup: 'Rename group', scenarioActions: 'Scenario actions', deleteDefinition: 'Delete',
        renameProcess: 'Rename process', processActions: 'Process actions', openScenarioProperties: 'Open test properties', convertFormat: 'Conversions…'
    };

    function createController(options) {
        const labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };
        let menu = null;
        function closeMenu() { menu?.remove(); menu = null; }
        function canRename(node) {
            return Boolean(node?.itemId || node?.id) && node.navigable === true
                && ['main', 'process', 'nested', 'export'].includes(node.sourceGroup);
        }
        function canRenameGroup(node) {
            return (node?.sourceGroup === 'main' || node?.sourceGroup === 'process') && Boolean(node.renameGroupItemId);
        }
        function canDelete(node) {
            return Boolean(node?.itemId || node?.id) && node.navigable === true
                && ['main', 'process', 'nested', 'export', 'standalone'].includes(node.sourceGroup);
        }
        function canOpenProperties(node) {
            const uri = node?.scenarioPropertiesUri || node?.capturedLocation?.uri || node?.featureId;
            return (canRename(node) || Boolean(node?.featureId)) && typeof uri === 'string' && /^file:.*\.(?:ya?ml|feature)$/iu.test(uri);
        }
        function send(action, node, extra) {
            if (['toggleFavorite', 'insert', 'copy', 'openDefinition', 'openScenarioProperties', 'convertFormat', 'deleteDefinition'].includes(action) && (node?.itemId || node?.id)) {
                if (action === 'deleteDefinition' && !canDelete(node)) { return; }
                if (options.runItemAction) { options.runItemAction(action, node); }
                else { options.postMessage({ command: action, itemId: node.itemId || node.id }); }
                return;
            }
            if (action === 'renameMainGroup' && canRenameGroup(node)) {
                options.postMessage({ command: 'renameMainGroup', itemId: node.renameGroupItemId });
                return;
            }
            if (action === 'renameScenario' && canRename(node)) {
                options.postMessage({ command: 'rename', itemId: node.itemId || node.id });
                return;
            }
            options.postMessage({
                command: 'standaloneFeatureAction', action,
                ...(node?.featureId ? { featureId: node.featureId } : {}),
                ...(!node?.featureId && node?.groupId !== undefined ? { groupId: node.groupId } : {}),
                ...extra
            });
        }
        function move(node, direction) {
            const siblings = (options.getFeatures() || [])
                .filter(feature => feature.groupId === node.groupId)
                .sort((left, right) => (left.order || 0) - (right.order || 0));
            const index = siblings.findIndex(feature => feature.featureId === node.featureId);
            if (index < 0 || (direction < 0 && index === 0) || (direction > 0 && index >= siblings.length - 1)) {
                return;
            }
            const before = direction < 0 ? siblings[index - 1] : siblings[index + 2];
            send('moveFeature', node, { groupId: node.groupId || '', ...(before ? { beforeId: before.featureId } : {}) });
        }
        function actions(node) {
            if (canRenameGroup(node)) { return ['renameMainGroup']; }
            const itemActions = [...(options.getItemActions?.(node) || []), ...(canDelete(node) ? ['deleteDefinition'] : [])];
            if (canRename(node)) { return [...itemActions, ...(canOpenProperties(node) ? ['openScenarioProperties'] : []), ...(/\.(?:ya?ml|feature)$/iu.test(node.scenarioPropertiesUri || node.sourceUri || node.uri || node.capturedLocation?.uri || '') ? ['convertFormat'] : []), 'renameScenario']; }
            if (node.featureId) {
                return [...itemActions, ...(canOpenProperties(node) ? ['openScenarioProperties'] : []), ...(itemActions.some(action => action.id === 'openDefinition') ? [] : ['openFeature']),
                    'renameFeature', 'renameFeatureFile', 'generateJson', 'selectJson', 'openJson', 'moveFeature', 'moveUp', 'moveDown'];
            }
            if (itemActions.length) { return itemActions; }
            if (node.groupId !== undefined) {
                return ['createFeature', ...(node.groupId ? ['renameGroup', 'deleteGroup'] : [])];
            }
            return ['createFeature', 'createGroup'];
        }
        function showMenu(event, node) {
            event.preventDefault(); event.stopPropagation(); closeMenu();
            const element = document.createElement('div');
            element.className = 'scenario-resource-context-menu';
            element.setAttribute('role', 'menu');
            const x = event.clientX || 0; const y = event.clientY || 0;
            element.style.left = `${x}px`; element.style.top = `${y}px`;
            for (const descriptor of actions(node)) {
                const action = typeof descriptor === 'string' ? descriptor : descriptor.id;
                const button = document.createElement('button');
                button.type = 'button'; button.className = 'scenario-resource-context-action';
                button.dataset.action = action; button.setAttribute('role', 'menuitem');
                button.textContent = descriptor.label || (action === 'renameScenario' && (node.processUri || node.definitionType === 'process') ? labels.renameProcess : labels[action]);
                button.disabled = descriptor.disabled === true;
                button.addEventListener('click', click => {
                    if (button.disabled) { return; }
                    click.preventDefault(); click.stopPropagation(); closeMenu();
                    if (action === 'moveUp' || action === 'moveDown') { move(node, action === 'moveUp' ? -1 : 1); }
                    else { send(action, node); }
                });
                element.append(button);
            }
            document.body.append(element); menu = element;
            requestAnimationFrame(() => {
                if (menu !== element) { return; }
                const rect = element.getBoundingClientRect();
                element.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
                element.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
                element.querySelector('button')?.focus();
            });
        }
        function appendMenuButton(container, node, className) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = `${className} codicon codicon-ellipsis`;
            const title = node.processUri || node.definitionType === 'process' ? labels.processActions
                : canRename(node) || canRenameGroup(node) ? labels.scenarioActions : labels.actions;
            button.title = title; button.setAttribute('aria-label', `${title}: ${node.label || node.displayText || ''}`);
            button.addEventListener('click', event => {
                const rect = button.getBoundingClientRect();
                showMenu({ ...event, clientX: rect.left || 0, clientY: rect.bottom || 0,
                    preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, node);
            });
            container.append(button);
        }
        function appendTreeActionButton(container, node, className) {
            if (node.groupId !== undefined || node.featureId) {
                appendMenuButton(container, node, className);
                return;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `${className} codicon codicon-new-folder`;
            button.dataset.action = 'createGroup';
            button.title = labels.createGroup;
            button.setAttribute('aria-label', labels.createGroup);
            button.addEventListener('click', event => {
                event.preventDefault(); event.stopPropagation(); closeMenu();
                send('createGroup', node);
            });
            container.append(button);
        }
        function install(element, node) {
            if ((node.sourceGroup !== 'standalone' && !canRename(node) && !canRenameGroup(node)
                && !(options.getItemActions?.(node) || []).length) || node.kind === 'more') { return; }
            if (node.featureId) { element.dataset.featureId = node.featureId; }
            if (node.groupId !== undefined) { element.dataset.groupId = node.groupId; }
            element.addEventListener('contextmenu', event => showMenu(event, node));
            element.addEventListener('keydown', event => {
                if (event.target !== element) { return; }
                if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
                    showMenu(event, node);
                } else if (event.key === 'F2' && (node.featureId || canRename(node) || canRenameGroup(node))) {
                    event.preventDefault(); event.stopPropagation();
                    send(node.featureId ? 'renameFeature' : canRenameGroup(node) ? 'renameMainGroup' : 'renameScenario', node);
                } else if (event.key === 'Delete' && canDelete(node)) {
                    event.preventDefault(); event.stopPropagation(); send('deleteDefinition', node);
                } else if (node.featureId && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                    event.preventDefault(); event.stopPropagation(); move(node, event.key === 'ArrowUp' ? -1 : 1);
                } else if (node.featureId && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
                    event.preventDefault(); event.stopPropagation(); send('moveFeature', node);
                }
            });
            if (node.featureId) {
                element.draggable = true;
                element.addEventListener('dragstart', event => {
                    if (!event.dataTransfer) { return; }
                    event.stopPropagation(); event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(DRAG_TYPE, node.featureId); element.classList.add('is-dragging');
                });
                element.addEventListener('dragend', () => element.classList.remove('is-dragging'));
            }
            if (node.groupId !== undefined) {
                element.addEventListener('dragover', event => {
                    if (!Array.from(event.dataTransfer?.types || []).includes(DRAG_TYPE)) { return; }
                    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; element.classList.add('is-drop-target');
                });
                element.addEventListener('dragleave', () => element.classList.remove('is-drop-target'));
                element.addEventListener('drop', event => {
                    element.classList.remove('is-drop-target');
                    const featureId = event.dataTransfer?.getData(DRAG_TYPE);
                    if (!featureId || featureId === node.featureId) { return; }
                    event.preventDefault(); event.stopPropagation();
                    send('moveFeature', { featureId }, { groupId: node.groupId,
                        ...(node.featureId ? { beforeId: node.featureId } : {}) });
                });
            }
        }
        document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) { closeMenu(); } });
        document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(); } });
        return Object.freeze({ install, send, canRename, canRenameGroup, appendMenuButton, appendTreeActionButton, closeMenu });
    }
    return Object.freeze({ createController });
}));
