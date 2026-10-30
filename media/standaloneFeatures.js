(function () {
    'use strict';

    const dragType = 'application/x-kot-standalone-feature';

    function create({ container, vscode, mode = 'library', labels = {}, managerUi = {} }) {
        let snapshot = { features: [], groups: [], revision: 0 };
        let artifacts = {};
        let search = '';
        let disposed = false;
        let menu = null;
        let menuItems = null;
        let dragId = null;
        let orderDrag = null;
        let enabled = true;
        let rows = [];
        let sectionBranch = null;
        const relationshipProtocol = managerUi.relationshipProtocol;
        let relationshipState = relationshipProtocol?.parseRelationshipState(undefined);
        let relationshipFilterEnabled = false;
        const saved = vscode.getState?.()?.standaloneFeatures || {};
        const collapsedGroups = new Set(Array.isArray(saved.collapsedGroups) ? saved.collapsedGroups : []);
        let sectionCollapsed = saved.sectionCollapsed === true;
        let selectedId = typeof saved.selectedId === 'string' ? saved.selectedId : '';
        const label = key => labels[key] || key;
        container.classList.add('standalone-features');
        container.classList.add(`standalone-features-${mode}`);
        const readOnlyActions = ['openScenarioProperties', 'openFeature', 'openJson', 'openLog', 'watchLog', 'openRunStep'];

        function persist() {
            if (vscode.setState) {
                vscode.setState({
                    ...(vscode.getState?.() || {}),
                    standaloneFeatures: { collapsedGroups: [...collapsedGroups], sectionCollapsed, selectedId }
                });
            }
        }

        function send(action, fields = {}) {
            if (!disposed && (enabled || readOnlyActions.includes(action))) {
                vscode.postMessage({ command: 'standaloneFeatureAction', action, ...fields });
            }
        }

        function groupProjectRoot(group) {
            const roots = snapshot.ordering?.groupRoots[group.id];
            return group.projectRoot || (roots?.length === 1 ? roots[0] : '');
        }

        function groupStateId(group) {
            return group.projectRoot ? JSON.stringify([group.projectRoot, group.id]) : group.id;
        }

        function icon(name) {
            const node = document.createElement('span');
            node.className = `codicon codicon-${name}`;
            node.setAttribute('aria-hidden', 'true');
            return node;
        }

        function text(className, value) {
            const node = document.createElement('span');
            node.className = className;
            node.textContent = value;
            return node;
        }

        function actionButton(action, iconName, fields, disabled = false) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'kot-icon-button standalone-action';
            button.dataset.action = action;
            button.title = label(action);
            button.setAttribute('aria-label', label(action));
            button.updateDisabled = () => {
                button.disabled = (typeof disabled === 'function' ? disabled() : disabled) || (!enabled && !readOnlyActions.includes(action));
            };
            button.updateDisabled();
            button.append(icon(iconName));
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (!button.disabled) {
                    send(action, fields);
                }
            });
            return button;
        }

        function closeMenu() {
            menu?.remove();
            menu = null;
            menuItems = null;
        }

        function reorder(feature, direction) {
            const siblings = snapshot.features.filter(value => value.groupId === feature.groupId)
                .sort((left, right) => left.order - right.order);
            const index = siblings.findIndex(value => value.id === feature.id);
            if (direction < 0 && index > 0) {
                send('moveFeature', { featureId: feature.id, groupId: feature.groupId, beforeId: siblings[index - 1].id });
            } else if (direction > 0 && index >= 0 && index < siblings.length - 1) {
                send('moveFeature', {
                    featureId: feature.id, groupId: feature.groupId,
                    ...(siblings[index + 2] ? { beforeId: siblings[index + 2].id } : {})
                });
            }
        }

        function featureMenuItems(feature) {
            const fields = { featureId: feature.id };
            const state = artifacts[feature.id] || {};
            const items = [
                { action: 'openFeature', fields },
                { action: 'openScenarioProperties', fields },
                ...(mode === 'manager' ? [
                    { separator: true },
                    { action: 'run', fields, disabled: runBlocked(feature) },
                    { action: 'openJson', fields, disabled: !feature.jsonPath },
                    { action: 'openLog', fields, disabled: !state.canOpenRunLog },
                    { action: 'watchLog', fields, disabled: state.runStatus !== 'running' },
                    { separator: true }
                ] : []),
                { action: 'generateJson', fields },
                { action: 'selectJson', fields },
                ...(mode !== 'manager' && feature.jsonPath ? [{ action: 'openJson', fields }] : []),
                { action: 'renameFeature', fields },
                { action: 'renameFeatureFile', fields },
                { action: 'moveFeature', fields },
                ...(mode === 'manager' ? [] : [
                    { action: 'moveUp', run: () => reorder(feature, -1) },
                    { action: 'moveDown', run: () => reorder(feature, 1) }
                ])
            ];
            return items;
        }

        function groupMenuItems(group) {
            return [
                { action: 'createFeature', fields: { groupId: group.id } },
                ...(group.id ? [
                    { action: 'renameGroup', fields: { groupId: group.id } },
                    { action: 'deleteGroup', fields: { groupId: group.id } }
                ] : [])
            ];
        }

        const actionIcons = {
            openScenarioProperties: 'settings-gear', openFeature: 'edit', run: 'play-circle', openJson: 'file-code', openLog: 'output', watchLog: 'list-flat',
            generateJson: 'file-code', selectJson: 'folder-opened', moveFeature: 'move', moveUp: 'arrow-up', moveDown: 'arrow-down',
            createFeature: 'add', createGroup: 'new-folder', renameGroup: 'rename', deleteGroup: 'trash',
            renameFeature: 'rename', renameFeatureFile: 'rename'
        };

        function updateMenuState() {
            if (!menu || !menuItems) { return; }
            const items = typeof menuItems === 'function' ? menuItems() : menuItems;
            const buttons = [...menu.querySelectorAll('button')];
            items.filter(item => !item.separator).forEach((item, index) => {
                buttons[index].disabled = item.disabled === true || (!enabled && !readOnlyActions.includes(item.action));
            });
        }

        function showMenu(event, origin, getItems) {
            event.preventDefault();
            event.stopPropagation();
            managerUi.beforeMenu?.();
            closeMenu();
            const popup = document.createElement('div');
            popup.className = mode === 'manager' ? 'run-mode-menu phase-context-menu standalone-context-menu' : 'standalone-context-menu';
            popup.setAttribute('role', 'menu');
            const originRect = origin.getBoundingClientRect();
            const x = Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : originRect.left || 8;
            const y = Number.isFinite(event.clientY) && event.clientY > 0 ? event.clientY : originRect.bottom || 8;
            popup.style.left = `${x}px`;
            popup.style.top = `${y}px`;
            const items = typeof getItems === 'function' ? getItems() : getItems;
            const buttons = items.map(item => {
                if (item.separator) {
                    const separator = document.createElement('div');
                    separator.className = 'run-mode-menu-separator';
                    separator.setAttribute('role', 'separator');
                    popup.append(separator);
                    return null;
                }
                const button = document.createElement('button');
                button.type = 'button';
                button.className = mode === 'manager' ? 'run-mode-menu-item standalone-context-action' : 'standalone-context-action';
                button.dataset.action = item.action;
                button.setAttribute('role', 'menuitem');
                if (mode === 'manager') { button.append(icon(actionIcons[item.action] || 'edit')); }
                button.append(text('', label(item.action)));
                button.disabled = item.disabled === true || (!enabled && !readOnlyActions.includes(item.action));
                button.addEventListener('click', clickEvent => {
                    clickEvent.preventDefault();
                    clickEvent.stopPropagation();
                    if (button.disabled) { return; }
                    closeMenu();
                    origin.focus({ preventScroll: true });
                    if (item.run) { item.run(); } else { send(item.action, item.fields); }
                });
                popup.append(button);
                return button;
            }).filter(Boolean);
            popup.addEventListener('keydown', keyEvent => {
                const enabled = buttons.filter(button => !button.disabled);
                const current = enabled.indexOf(keyEvent.target);
                if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
                    keyEvent.preventDefault();
                    enabled[(current + (keyEvent.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]?.focus({ preventScroll: true });
                } else if (keyEvent.key === 'Escape') {
                    keyEvent.preventDefault();
                    closeMenu();
                    origin.focus({ preventScroll: true });
                }
            });
            document.body.append(popup);
            menu = popup;
            menuItems = getItems;
            requestAnimationFrame(() => {
                if (menu !== popup) { return; }
                const rect = popup.getBoundingClientRect();
                popup.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
                popup.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
                buttons.find(button => !button.disabled)?.focus({ preventScroll: true });
            });
        }

        function menuButton(origin, items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'kot-icon-button standalone-action';
            button.title = label('actions');
            button.setAttribute('aria-label', label('actions'));
            button.append(icon('ellipsis'));
            button.addEventListener('click', event => showMenu(event, origin, items));
            return button;
        }

        function row(className, identity, items) {
            const node = document.createElement(mode === 'manager' && className === 'standalone-feature-row' ? 'label' : 'div');
            node.className = `kot-tree-row standalone-row ${className}`;
            node.dataset.identity = identity;
            node.tabIndex = selectedId === identity ? 0 : -1;
            node.setAttribute('role', 'treeitem');
            const depth = className === 'standalone-section-row' ? 0 : className === 'standalone-group-row' ? 1 : 2;
            node.style.setProperty('--standalone-depth', String(depth));
            node.setAttribute('aria-level', String(depth + 1));
            node.setAttribute('aria-selected', String(selectedId === identity));
            node.addEventListener('focus', () => {
                selectedId = identity;
                for (const other of rows) {
                    other.tabIndex = other === node ? 0 : -1;
                    other.setAttribute('aria-selected', String(other === node));
                }
                persist();
            });
            node.addEventListener('contextmenu', event => showMenu(event, node, items));
            node.addEventListener('keydown', event => {
                if (event.target !== node) { return; }
                if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
                    showMenu(event, node, items);
                } else if (event.key === 'F2' && node.dataset.featureId) {
                    event.preventDefault(); event.stopPropagation();
                    send('renameFeature', { featureId: node.dataset.featureId });
                } else if (!event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                    event.preventDefault();
                    const index = rows.indexOf(node);
                    rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
                } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus();
                }
            });
            rows.push(node);
            return node;
        }

        function dropTarget(node, groupId, beforeId, groupRoot) {
            const rootForGroup = () => groupRoot || (snapshot.ordering?.groupRoots[groupId]?.length === 1 ? snapshot.ordering.groupRoots[groupId][0] : '');
            const valid = () => enabled && orderDrag && orderDrag.revision === snapshot.revision
                && (orderDrag.type === 'group' ? !beforeId && groupId && rootForGroup() === orderDrag.projectRoot
                    : beforeId ? snapshot.ordering?.featureRoots[beforeId] === orderDrag.projectRoot
                        : !groupId || rootForGroup() === orderDrag.projectRoot);
            const after = event => event.clientY > node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2;
            node.addEventListener('dragover', event => {
                if (orderDrag) {
                    if (!valid()) { return; }
                    event.preventDefault(); event.stopPropagation();
                    node.classList.remove('is-order-drop-before', 'is-order-drop-after', 'is-order-drop-target');
                    node.classList.add(beforeId || orderDrag.type === 'group' ? (after(event) ? 'is-order-drop-after' : 'is-order-drop-before') : 'is-order-drop-target');
                    if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
                    return;
                }
                if (mode === 'manager' || snapshot.ordering) { return; }
                if (enabled && (dragId || event.dataTransfer?.types?.includes(dragType))) {
                    event.preventDefault();
                    event.stopPropagation();
                    node.classList.add(beforeId ? 'is-drop-before' : 'is-drop-target');
                    event.dataTransfer.dropEffect = 'move';
                }
            });
            node.addEventListener('dragleave', () => node.classList.remove('is-drop-target', 'is-drop-before', 'is-order-drop-before', 'is-order-drop-after', 'is-order-drop-target'));
            node.addEventListener('drop', event => {
                if (orderDrag) {
                    if (!valid()) { return; }
                    event.preventDefault(); event.stopPropagation();
                    if (orderDrag.type === 'group') {
                        const beforeGroupId = after(event) ? orderDrag.expectedIds[orderDrag.expectedIds.indexOf(groupId) + 1] : groupId;
                        send('reorderGroup', { projectRoot: orderDrag.projectRoot, groupId: orderDrag.groupId,
                            ...(beforeGroupId ? { beforeId: beforeGroupId } : {}), expectedIds: orderDrag.expectedIds, revision: orderDrag.revision });
                    } else if (orderDrag.featureId !== beforeId) {
                        const siblings = snapshot.features.filter(feature => feature.groupId === groupId
                            && snapshot.ordering.featureRoots[feature.id] === orderDrag.projectRoot).sort((left, right) => left.order - right.order);
                        const beforeFeatureId = beforeId && after(event) ? siblings[siblings.findIndex(feature => feature.id === beforeId) + 1]?.id : beforeId;
                        send('moveFeature', { featureId: orderDrag.featureId, groupId, ...(beforeFeatureId ? { beforeId: beforeFeatureId } : {}),
                            projectRoot: orderDrag.projectRoot, revision: orderDrag.revision });
                    }
                    clearOrderDrag();
                    return;
                }
                if (mode === 'manager' || snapshot.ordering) { return; }
                const featureId = event.dataTransfer?.getData(dragType) || dragId;
                node.classList.remove('is-drop-target', 'is-drop-before');
                if (!enabled || !featureId || featureId === beforeId) { return; }
                event.preventDefault();
                event.stopPropagation();
                send('moveFeature', { featureId, groupId, ...(beforeId ? { beforeId } : {}) });
                dragId = null;
            });
        }

        function clearOrderDrag() {
            orderDrag = null;
            dragId = null;
            container.querySelectorAll('.is-order-dragging').forEach(node => node.classList.remove('is-order-dragging'));
            container.querySelectorAll('.is-order-drop-before').forEach(node => node.classList.remove('is-order-drop-before'));
            container.querySelectorAll('.is-order-drop-after').forEach(node => node.classList.remove('is-order-drop-after'));
            container.querySelectorAll('.is-order-drop-target').forEach(node => node.classList.remove('is-order-drop-target'));
        }

        function orderingHandle(node, start) {
            const handle = icon('gripper');
            handle.classList.add('project-order-drag-handle');
            handle.setAttribute('draggable', 'true');
            handle.title = labels.dragToReorder || 'Drag to reorder';
            handle.setAttribute('aria-label', handle.title);
            handle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
            handle.addEventListener('dragstart', event => {
                if (!enabled || !event.dataTransfer) { event.preventDefault(); return; }
                clearOrderDrag();
                orderDrag = start();
                if (!orderDrag) { event.preventDefault(); return; }
                event.dataTransfer.setData(dragType, orderDrag.type);
                event.dataTransfer.effectAllowed = 'move';
                node.classList.add('is-order-dragging');
                event.stopPropagation();
            });
            handle.addEventListener('dragend', clearOrderDrag);
            return handle;
        }

        function runBlocked(feature) {
            const state = artifacts[feature.id];
            return !enabled || (state?.runStatus === 'running' && state.blocksControls !== false);
        }

        function syncManagerFeature(node, feature) {
            const state = artifacts[feature.id] || {};
            const status = ['running', 'passed', 'failed'].includes(state.runStatus) ? state.runStatus : 'idle';
            node.dataset.runStatus = status;
            const leading = node.querySelector('.standalone-leading-control');
            leading.className = `standalone-leading-control ${status === 'running' ? 'checkbox-run-indicator' : 'standalone-selection-spacer'}`;
            if (status === 'running') {
                if (!leading.querySelector('.codicon-loading')) {
                    const spinner = icon('loading');
                    spinner.classList.add('codicon-modifier-spin');
                    leading.append(spinner);
                }
                leading.title = label('running');
            } else {
                leading.replaceChildren();
                leading.title = '';
            }
            const actions = node.querySelector('.kot-row-actions');
            let failedStep = actions.querySelector('.run-scenario-log-btn');
            if (status === 'failed' && !failedStep) {
                failedStep = actionButton('openRunStep', 'go-to-file', { featureId: feature.id });
                failedStep.className = 'run-scenario-log-btn';
                actions.insertBefore(failedStep, actions.querySelector('.scenario-run-progress') || actions.querySelector('.run-scenario-btn'));
            } else if (status !== 'failed') { failedStep?.remove(); }

            const progress = managerUi.formatRunProgress?.({
                isRunning: status === 'running', currentLine: state.progressCurrentLine,
                totalLines: state.progressTotalLines, percent: state.progressPercent, iteration: state.progressIteration
            });
            let progressNode = actions.querySelector('.scenario-run-progress');
            if (progress?.hasLineProgress) {
                if (!progressNode) {
                    progressNode = document.createElement('span');
                    progressNode.className = 'scenario-run-progress has-hover-counter';
                    progressNode.append(text('scenario-run-progress-percent', ''), text('scenario-run-progress-counter', ''));
                    actions.insertBefore(progressNode, actions.querySelector('.run-scenario-btn'));
                }
                progressNode.title = progress.title;
                progressNode.querySelector('.scenario-run-progress-percent').textContent = progress.badgeText;
                progressNode.querySelector('.scenario-run-progress-counter').textContent = progress.counterText;
            } else { progressNode?.remove(); }

            let run = actions.querySelector('.run-scenario-btn');
            const blockingRun = status === 'running' && state.blocksControls !== false;
            if (blockingRun) { run?.remove(); }
            else {
                if (!run) {
                    run = actionButton('run', 'play-circle', { featureId: feature.id }, () => runBlocked(feature));
                }
                run.className = ['run-scenario-btn', state.stale ? 'run-scenario-btn-stale' : '',
                    status === 'running' ? 'run-scenario-btn-running' : '',
                    status === 'passed' ? (state.stale ? 'run-scenario-btn-stale-passed' : 'run-scenario-btn-passed') : '',
                    status === 'failed' ? 'run-scenario-btn-failed' : ''].filter(Boolean).join(' ');
                run.replaceChildren();
                if (status === 'failed') {
                    const error = icon('error');
                    error.classList.add('run-scenario-icon-failed');
                    const retry = icon('play-circle');
                    retry.classList.add('run-scenario-icon-retry');
                    run.append(error, retry);
                } else { run.append(icon(status === 'passed' ? 'check' : 'play-circle')); }
                const runTitle = (labels.runTitle || label('run')).replace('{0}', feature.title || feature.name);
                run.title = [runTitle, status !== 'idle' ? label(status) : '', state.activeRunSource === 'tracked' ? (labels.tracked || 'Tracked log') : '', state.stale ? (labels.stale || 'Build is stale') : '', progress?.title || ''].filter(Boolean).join(' • ')
                    + (state.runMessage ? `\n${state.runMessage}` : '')
                    + (state.activeRunLogPath ? `\n${(labels.selectedLog || 'Log: {0}').replace('{0}', state.activeRunLogPath)}` : '');
                run.setAttribute('aria-label', run.title);
                run.updateDisabled();
                if (!run.parentElement) { actions.append(run); }
            }
            if (failedStep) {
                failedStep.title = (labels.openRunStep || 'Open failed step in feature').replace('{0}', feature.title || feature.name);
                failedStep.setAttribute('aria-label', failedStep.title);
            }
        }

        function updateControlsAndRuns() {
            for (const node of rows) {
                if (node.dataset.featureId) {
                    node.draggable = mode !== 'manager' && enabled;
                    const feature = snapshot.features.find(value => value.id === node.dataset.featureId);
                    if (mode === 'manager' && feature) { syncManagerFeature(node, feature); }
                }
                for (const button of node.querySelectorAll('button')) { button.updateDisabled?.(); }
            }
            updateMenuState();
            updateOverflow();
        }

        function updateOverflow() {
            requestAnimationFrame(() => {
                if (disposed) { return; }
                for (const node of container.querySelectorAll('.kot-tree-label')) { managerUi.updateOverflow?.(node); }
            });
        }

        function updateRelationshipPresentation() {
            if (mode !== 'manager' || !relationshipProtocol) { return; }
            const matches = feature => !relationshipFilterEnabled || relationshipProtocol.isScenarioRelationshipMatch(feature.id, relationshipState);
            const searchMatches = feature => !search || `${feature.title}\n${feature.name}\n${feature.relativePath}`.toLocaleLowerCase().includes(search);
            const visibleGroups = new Set();
            for (const node of rows) {
                if (node.dataset.featureId) {
                    const id = node.dataset.featureId;
                    const decoration = relationshipProtocol.relationshipDecorationForScenario(id, relationshipState);
                    const highlighted = relationshipProtocol.isScenarioRelationshipHighlighted(id, relationshipState);
                    node.classList.toggle('affected-main-scenario', highlighted);
                    node.classList.toggle('is-related', highlighted);
                    node.classList.toggle('incoming-scenario', decoration.state === 'incoming');
                    node.classList.toggle('outgoing-scenario', decoration.state === 'outgoing');
                    node.classList.toggle('transitive-scenario', highlighted && !decoration.direct);
                    node.classList.toggle('is-transitive', highlighted && !decoration.direct);
                    node.setAttribute('data-relationship-label', decoration.accessibleLabel);
                    node.classList.toggle('relationship-hidden', relationshipFilterEnabled && !relationshipProtocol.isScenarioRelationshipMatch(id, relationshipState));
                } else {
                    const features = snapshot.features.filter(feature => node.classList.contains('standalone-section-row')
                        || (feature.groupId === node.dataset.groupId && (!node.dataset.projectRoot || snapshot.ordering?.featureRoots[feature.id] === node.dataset.projectRoot)));
                    const aggregate = relationshipProtocol.aggregatePhaseRelationship(features.map(feature => feature.id), relationshipState);
                    node.classList.toggle('phase-header-affected', aggregate.state === 'related');
                    node.classList.toggle('is-related', aggregate.state === 'related');
                    node.setAttribute('data-relationship-label', aggregate.accessibleLabel);
                    const visibleCount = features.filter(feature => searchMatches(feature) && matches(feature)).length;
                    if (visibleCount > 0) { visibleGroups.add(node.dataset.groupKey || node.dataset.groupId); }
                    node.classList.toggle('relationship-hidden', relationshipFilterEnabled && visibleCount === 0);
                    const count = node.querySelector('.standalone-count');
                    if (count) { count.textContent = String(node.classList.contains('standalone-section-row') && !relationshipFilterEnabled ? features.length : visibleCount); }
                }
            }
            container.querySelectorAll('.standalone-group-children').forEach(node => {
                node.classList.toggle('relationship-hidden', relationshipFilterEnabled && !visibleGroups.has(node.dataset.groupKey || node.dataset.groupId));
            });
            sectionBranch?.classList.toggle('relationship-hidden', relationshipFilterEnabled && !snapshot.features.some(feature => searchMatches(feature) && matches(feature)));
        }

        function featureRow(feature) {
            const node = row('standalone-feature-row', feature.id, () => featureMenuItems(feature));
            node.dataset.featureId = feature.id;
            node.title = `${feature.title || feature.name}\n${feature.relativePath || feature.uri}`;
            node.draggable = mode !== 'manager' && enabled;
            if (mode === 'manager') {
                node.classList.add('checkbox-item');
                // An explicit association avoids the file button becoming the
                // implicit label control when the row has no selection input.
                node.setAttribute('for', `standalone-selection:${feature.id}`);
                node.append(text('scenario-resource-toggle-spacer', ''), text('standalone-leading-control standalone-selection-spacer', ''));
                const open = actionButton('openFeature', 'file', { featureId: feature.id });
                open.className = 'open-scenario-btn scenario-file-icon';
                open.title = (labels.openFeatureTitle || label('openFeature')).replace('{0}', feature.title || feature.name);
                open.setAttribute('aria-label', open.title);
                open.children[0].classList.add('open-scenario-icon-idle');
                const openIcon = icon('go-to-file');
                openIcon.classList.add('open-scenario-icon-action');
                open.append(openIcon);
                node.append(open);
            } else { node.append(icon('file-code')); }
            const name = document.createElement('span');
            name.className = mode === 'manager' ? 'checkbox-label-text kot-tree-label' : 'kot-tree-label standalone-feature-label';
            if (snapshot.ordering?.featureRoots[feature.id]) {
                node.append(orderingHandle(node, () => ({ type: 'item', featureId: feature.id,
                    projectRoot: snapshot.ordering.featureRoots[feature.id], revision: snapshot.revision })));
            }
            if (mode === 'manager') { name.append(text('kot-scroll-content', feature.title || feature.name)); }
            else { name.append(text('standalone-feature-title', feature.title || feature.name), text('standalone-feature-path', feature.relativePath || feature.name)); }
            node.append(name);
            const actions = document.createElement('span');
            actions.className = mode === 'manager' ? 'kot-row-actions' : 'standalone-actions';
            if (mode !== 'manager') {
                actions.append(actionButton('openFeature', 'go-to-file', { featureId: feature.id }));
                actions.append(menuButton(node, () => featureMenuItems(feature)));
            }
            node.append(actions);
            if (mode === 'manager') { syncManagerFeature(node, feature); }
            node.addEventListener('click', event => {
                if (event.target.closest?.('button')) { return; }
                node.focus({ preventScroll: true });
                const status = artifacts[feature.id]?.runStatus;
                if (mode === 'manager' && (status === 'running' || status === 'failed')) {
                    event.preventDefault();
                    send('openRunStep', { featureId: feature.id });
                }
            });
            node.addEventListener('dblclick', event => {
                if (event.target.closest?.('button')) { return; }
                event.stopPropagation(); send('openFeature', { featureId: feature.id });
            });
            node.addEventListener('keydown', event => {
                if (event.target !== node) { return; }
                if (event.key === 'Enter') {
                    event.preventDefault(); send('openFeature', { featureId: feature.id });
                } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
                    event.preventDefault(); send('moveFeature', { featureId: feature.id });
                } else if (mode !== 'manager' && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                    event.preventDefault(); reorder(feature, event.key === 'ArrowUp' ? -1 : 1);
                }
            });
            node.addEventListener('dragstart', event => {
                if (mode === 'manager') { event.preventDefault(); return; }
                if (!enabled) { event.preventDefault(); return; }
                if (snapshot.ordering?.featureRoots[feature.id]) {
                    orderDrag = { type: 'item', featureId: feature.id, projectRoot: snapshot.ordering.featureRoots[feature.id], revision: snapshot.revision };
                }
                dragId = feature.id;
                event.dataTransfer?.setData(dragType, feature.id);
                if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; }
                node.classList.add('is-dragging');
            });
            node.addEventListener('dragend', () => { clearOrderDrag(); node.classList.remove('is-dragging'); });
            dropTarget(node, feature.groupId, feature.id);
            return node;
        }

        function render(expandingId = '') {
            if (disposed) { return; }
            const focusedId = rows.find(node => node.contains(document.activeElement))?.dataset.identity;
            const scrollState = [];
            for (let parent = container; parent; parent = parent.parentElement) {
                scrollState.push({ element: parent, top: parent.scrollTop, left: parent.scrollLeft });
            }
            rows = [];
            sectionBranch = null;
            closeMenu();
            container.replaceChildren();
            const heading = row('standalone-section-row', 'standalone-section', [
                { action: 'createFeature' }, { action: 'createGroup' }
            ]);
            heading.setAttribute('aria-expanded', String(!sectionCollapsed));
            const sectionDisclosure = icon(sectionCollapsed ? 'chevron-right' : 'chevron-down');
            sectionDisclosure.classList.add('kot-tree-disclosure');
            heading.append(sectionDisclosure, text('kot-tree-label', label('title')));
            const sectionActions = document.createElement('span');
            sectionActions.className = 'standalone-actions';
            sectionActions.append(actionButton('createFeature', mode === 'manager' ? 'add' : 'new-file'), actionButton('createGroup', 'new-folder'));
            heading.append(sectionActions);
            heading.append(text('standalone-count kot-tree-count', String(snapshot.features.length)));
            const toggleSection = () => {
                heading.focus({ preventScroll: true });
                sectionCollapsed = !sectionCollapsed;
                heading.setAttribute('aria-expanded', String(!sectionCollapsed));
                persist();
                if (sectionCollapsed && sectionBranch && managerUi.expand) {
                    managerUi.expand(sectionBranch, false, true, () => render());
                } else { render(sectionCollapsed ? '' : 'standalone-section'); }
            };
            heading.addEventListener('click', toggleSection);
            heading.addEventListener('keydown', event => {
                if (event.target !== heading) { return; }
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleSection(); }
            });
            container.append(heading);
            if (!sectionCollapsed || search) {
                const branch = document.createElement('div');
                branch.className = mode === 'manager' ? 'standalone-groups phase-tests-list expanded' : 'standalone-groups';
                branch.setAttribute('role', 'group');
                container.append(branch);
                sectionBranch = branch;
                const filtered = snapshot.features.filter(feature => !search || `${feature.title}\n${feature.name}\n${feature.relativePath}`.toLocaleLowerCase().includes(search));
                const groups = [{ id: '', name: label('ungrouped') }, ...snapshot.groups];
                for (const group of groups) {
                    const groupRoot = groupProjectRoot(group);
                    const stateId = groupStateId(group);
                    const features = filtered.filter(feature => feature.groupId === group.id
                        && (!group.projectRoot || snapshot.ordering?.featureRoots[feature.id] === group.projectRoot)).sort((left, right) => left.order - right.order);
                    if (search && features.length === 0) { continue; }
                    const groupRow = row('standalone-group-row', `standalone-group:${stateId}`, groupMenuItems(group));
                    groupRow.dataset.groupId = group.id;
                    groupRow.dataset.groupKey = stateId;
                    if (group.projectRoot) { groupRow.dataset.projectRoot = group.projectRoot; groupRow.title = `${group.name}\n${group.projectRoot}`; }
                    const expanded = Boolean(search) || !collapsedGroups.has(stateId);
                    groupRow.setAttribute('aria-expanded', String(expanded));
                    const disclosure = icon(expanded ? 'chevron-down' : 'chevron-right');
                    disclosure.classList.add('kot-tree-disclosure');
                    const groupLabel = text('kot-tree-label phase-title', '');
                    if (group.id && groupRoot) {
                        groupRow.append(orderingHandle(groupRow, () => ({ type: 'group', groupId: group.id,
                            projectRoot: groupRoot, revision: snapshot.revision,
                            expectedIds: snapshot.groups.filter(candidate => groupProjectRoot(candidate) === groupRoot)
                                .map(candidate => candidate.id) })));
                    }
                    groupLabel.append(text('kot-scroll-content', group.name));
                    groupRow.append(disclosure, icon('folder'), groupLabel);
                    const groupActions = document.createElement('span');
                    groupActions.className = 'standalone-actions';
                    groupActions.append(actionButton('createFeature', mode === 'manager' ? 'add' : 'new-file', { groupId: group.id }));
                    if (mode !== 'manager') { groupActions.append(menuButton(groupRow, groupMenuItems(group))); }
                    groupRow.append(groupActions);
                    groupRow.append(text('standalone-count kot-tree-count', String(features.length)));
                    const children = document.createElement('div');
                    children.className = mode === 'manager' ? 'standalone-group-children phase-tests-list expanded' : 'standalone-group-children';
                    children.setAttribute('role', 'group');
                    children.dataset.groupId = group.id;
                    children.dataset.groupKey = stateId;
                    if (group.projectRoot) { children.dataset.projectRoot = group.projectRoot; }
                    const toggleGroup = () => {
                        groupRow.focus({ preventScroll: true });
                        const collapse = !collapsedGroups.has(stateId);
                        if (collapse) { collapsedGroups.add(stateId); } else { collapsedGroups.delete(stateId); }
                        groupRow.setAttribute('aria-expanded', String(!collapse));
                        disclosure.className = `codicon codicon-chevron-${collapse ? 'right' : 'down'} kot-tree-disclosure`;
                        persist();
                        if (collapse && expanded && managerUi.expand) {
                            managerUi.expand(children, false, true, () => render());
                        } else { render(collapse ? '' : `standalone-group:${stateId}`); }
                    };
                    groupRow.addEventListener('click', toggleGroup);
                    groupRow.addEventListener('keydown', event => {
                        if (event.target !== groupRow) { return; }
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleGroup(); }
                        else if ((event.key === 'ArrowRight' && !expanded) || (event.key === 'ArrowLeft' && expanded)) { event.preventDefault(); toggleGroup(); }
                    });
                    dropTarget(groupRow, group.id, undefined, groupRoot);
                    dropTarget(children, group.id, undefined, groupRoot);
                    branch.append(groupRow);
                    if (expanded) {
                        for (const feature of features) { children.append(featureRow(feature)); }
                        if (features.length === 0 && group.id) { children.append(text('standalone-empty-group', label('emptyGroup'))); }
                        branch.append(children);
                        managerUi.expand?.(children, true, expandingId === `standalone-group:${stateId}`);
                    }
                }
                if (filtered.length === 0) { branch.append(text('standalone-empty', label(search ? 'noMatches' : 'empty'))); }
                managerUi.expand?.(branch, true, expandingId === 'standalone-section');
            }
            if (!rows.some(node => node.tabIndex === 0) && rows[0]) { rows[0].tabIndex = 0; }
            for (const value of scrollState) { value.element.scrollTop = value.top; value.element.scrollLeft = value.left; }
            if (focusedId) { rows.find(node => node.dataset.identity === focusedId)?.focus({ preventScroll: true }); }
            updateRelationshipPresentation();
            updateOverflow();
        }

        function dismissMenu(event) {
            if (menu && !menu.contains(event.target)) { closeMenu(); }
        }
        function handleMessage(event) {
            const message = event.data || {};
            if (message.command === 'standaloneFeatureActionResult' && message.succeeded === false) {
                closeMenu();
            }
        }
        document.addEventListener('pointerdown', dismissMenu);
        window.addEventListener('message', handleMessage);
        render();
        return {
            closeMenu,
            setSnapshot(value) {
                const next = value && Array.isArray(value.features) && Array.isArray(value.groups) ? value : { features: [], groups: [], revision: 0 };
                if (JSON.stringify(next) === JSON.stringify(snapshot)) { return; }
                snapshot = next;
                clearOrderDrag();
                render();
            },
            setRunArtifacts(value) { artifacts = value && typeof value === 'object' ? value : {}; updateControlsAndRuns(); },
            setRelationshipState(value, filterEnabled = false) {
                if (!relationshipProtocol) { return; }
                const next = relationshipProtocol.parseRelationshipState(value);
                if (JSON.stringify(next) === JSON.stringify(relationshipState) && relationshipFilterEnabled === filterEnabled) { return; }
                relationshipState = next;
                relationshipFilterEnabled = filterEnabled;
                updateRelationshipPresentation();
            },
            setSearch(value) {
                const next = String(value || '').trim().toLocaleLowerCase();
                if (next === search) { return; }
                search = next; render();
            },
            setEnabled(value) {
                const next = value !== false;
                if (next === enabled) { return; }
                enabled = next; updateControlsAndRuns();
            },
            toggleAllGroups() {
                const ids = ['', ...snapshot.groups.map(groupStateId)];
                if (ids.every(groupId => collapsedGroups.has(groupId))) { collapsedGroups.clear(); }
                else { for (const groupId of ids) { collapsedGroups.add(groupId); } }
                persist(); render();
            },
            dispose() {
                disposed = true;
                closeMenu();
                document.removeEventListener('pointerdown', dismissMenu);
                window.removeEventListener('message', handleMessage);
                container.replaceChildren();
            }
        };
    }

    window.KotStandaloneFeatures = { create };
}());
