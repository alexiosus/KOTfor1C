(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const protocol = globalThis.StepLibrarySidebarProtocol;
    const filesProtocol = globalThis.KotScenarioFilesProtocol;
    const root = document.querySelector('.step-sidebar');
    const loc = root.dataset;
    const tree = document.getElementById('tree');
    const searchInput = document.getElementById('searchInput');
    const searchClearBtn = document.getElementById('searchClearBtn');
    const status = document.getElementById('status');
    const persisted = vscode.getState() || {};
    let uiState = protocol.createState({
        expandedIds: persisted.expandedIds,
        selectedId: persisted.selectedId
    });
    let roots = [];
    let searchResults = null;
    let searchTimer = null;
    let insertionAvailable = false;
    let relationshipState = protocol.createState().relationshipState;
    let relationshipFilterEnabled = false;
    let relatedAncestorIds = new Set();
    let relatedItemIds = new Set();
    let relationshipVisibleCounts = {};
    let favoriteItemIds = new Set();
    let libraryIdentity = null;
    const pendingExpansionAnimations = filesProtocol.createPendingExpansionTracker();
    let bulkEnteringNodeIds = new Set();
    const collapsingNodeIds = new Set();
    const nodesById = new Map();
    const childrenByParent = new Map();
    const requestedParents = new Set();
    const pendingParents = new Set();
    const resourceParentIdsByItem = new Map();
    const transferController = filesProtocol.createTransferController(message => vscode.postMessage(message));
    let scenarioResourceContextMenu = null;

    function closeScenarioResourceContextMenu() {
        scenarioResourceContextMenu?.remove();
        scenarioResourceContextMenu = null;
    }

    function runScenarioResourceContextAction(actionId, node) {
        if (actionId === 'open') {
            activateNode(node, true);
            return;
        }
        if (actionId === 'reveal') {
            vscode.postMessage({
                command: 'revealScenarioFile',
                itemId: node.itemId,
                relativePath: node.relativePath || ''
            });
            return;
        }
        if (actionId === 'delete' && node.kind === 'file') {
            vscode.postMessage({
                command: 'deleteScenarioFile',
                itemId: node.itemId,
                relativePath: node.relativePath
            });
        }
    }

    function showScenarioResourceContextMenu(event, node) {
        const actions = filesProtocol.scenarioResourceContextActions(node.kind, loc);
        if (actions.length === 0) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeScenarioResourceContextMenu();

        const menu = document.createElement('div');
        menu.className = 'scenario-resource-context-menu';
        menu.setAttribute('role', 'menu');
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;
        for (const action of actions) {
            if (action.id === 'separator') {
                const separator = document.createElement('div');
                separator.className = 'scenario-resource-context-separator';
                separator.setAttribute('role', 'separator');
                menu.append(separator);
                continue;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'scenario-resource-context-action';
            button.setAttribute('role', 'menuitem');
            button.textContent = action.label;
            button.addEventListener('click', clickEvent => {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                closeScenarioResourceContextMenu();
                runScenarioResourceContextAction(action.id, node);
            });
            menu.append(button);
        }
        document.body.append(menu);
        scenarioResourceContextMenu = menu;
        requestAnimationFrame(() => {
            if (scenarioResourceContextMenu !== menu) {
                return;
            }
            const rect = menu.getBoundingClientRect();
            menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4))}px`;
            menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4))}px`;
            menu.querySelector('button')?.focus();
        });
    }

    document.addEventListener('pointerdown', event => {
        if (scenarioResourceContextMenu && !scenarioResourceContextMenu.contains(event.target)) {
            closeScenarioResourceContextMenu();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeScenarioResourceContextMenu();
        }
    });

    function persistState() {
        vscode.setState({
            expandedIds: [...uiState.expandedIds],
            selectedId: uiState.selectedId,
            scrollTop: tree.scrollTop
        });
    }

    function updateSearchClearButton() {
        const hasValue = searchInput.value.length > 0;
        searchClearBtn.classList.toggle('hidden', !hasValue);
        searchClearBtn.disabled = !hasValue;
    }

    function createIcon(name, label) {
        const icon = document.createElement('span');
        icon.classList.add('codicon', `codicon-${name}`);
        if (label) {
            icon.setAttribute('role', 'img');
            icon.setAttribute('aria-label', label);
        } else {
            icon.setAttribute('aria-hidden', 'true');
        }
        return icon;
    }

    function appendSyntax(container, text) {
        const keywordPattern = /^(Given|When|Then|And|But|Дано|Когда|Тогда|И|Но)\b/u;
        const tokenPattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]+\]|\|)/gu;
        const lines = String(text).split('\n');
        lines.forEach((line, lineIndex) => {
            let cursor = 0;
            const keyword = keywordPattern.exec(line);
            if (keyword) {
                const span = document.createElement('span');
                span.className = 'syntax-keyword';
                span.textContent = keyword[0];
                container.appendChild(span);
                cursor = keyword[0].length;
            }
            tokenPattern.lastIndex = cursor;
            for (const match of line.matchAll(tokenPattern)) {
                if (match.index > cursor) {
                    container.appendChild(document.createTextNode(line.slice(cursor, match.index)));
                }
                const span = document.createElement('span');
                span.className = match[0] === '|' ? 'syntax-table' : 'syntax-value';
                span.textContent = match[0];
                container.appendChild(span);
                cursor = match.index + match[0].length;
            }
            if (cursor < line.length) {
                container.appendChild(document.createTextNode(line.slice(cursor)));
            }
            if (lineIndex < lines.length - 1) {
                container.appendChild(document.createTextNode('\n'));
            }
        });
    }

    function relationshipDecoration(node) {
        const state = protocol.withRelationshipState(uiState, relationshipState);
        return protocol.relationshipDecorationForNode(node, state, {
            current: loc.relationshipCurrent,
            incomingDirect: loc.relationshipIncomingDirect,
            incomingTransitive: loc.relationshipIncomingTransitive,
            outgoingDirect: loc.relationshipOutgoingDirect,
            outgoingTransitive: loc.relationshipOutgoingTransitive,
            containsRelated: loc.relationshipContainsRelated
        });
    }

    function createActionButton(command, iconName, label, node, disabled = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `kot-icon-button step-action step-action-${command}`;
        button.title = label;
        button.setAttribute('aria-label', `${label}: ${node.label}`);
        button.disabled = disabled;
        button.appendChild(createIcon(iconName));
        button.addEventListener('click', event => {
            event.stopPropagation();
            if (!button.disabled && node.itemId) {
                vscode.postMessage({ command, itemId: node.itemId });
            }
        });
        return button;
    }

    function createResourceActionButton(command, iconName, label, node) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `kot-icon-button step-action step-action-${command}`;
        button.title = label;
        button.setAttribute('aria-label', `${label}: ${node.label || node.name}`);
        button.appendChild(createIcon(iconName));
        button.addEventListener('click', event => {
            event.stopPropagation();
            vscode.postMessage({
                command,
                itemId: node.itemId,
                relativePath: node.relativePath || ''
            });
        });
        return button;
    }

    function nodeIconName(node) {
        if (node.id === 'favorites') {
            return 'star-full';
        }
        if (node.kind === 'category') {
            return 'folder';
        }
        if (node.kind === 'directory' || node.kind === 'attachments') {
            return 'folder';
        }
        if (node.kind === 'file' || node.kind === 'feature') {
            return 'file';
        }
        if (node.kind === 'more') {
            return 'ellipsis';
        }
        return {
            builtIn: 'extensions',
            user: 'symbol-method',
            export: 'package',
            nested: 'references',
            main: 'files'
        }[node.sourceGroup] || 'library';
    }

    function makeRow(node, parentId) {
        nodesById.set(node.id, node);
        const row = document.createElement('div');
        row.className = 'kot-tree-row step-row';
        row.dataset.nodeId = node.id;
        row.dataset.parentId = parentId || '';
        row.dataset.kind = node.kind;
        row.style.setProperty('--step-depth', String(node.depth));
        row.setAttribute('role', 'treeitem');
        row.title = protocol.nodeTooltip(node);
        row.tabIndex = node.id === uiState.selectedId ? 0 : -1;
        if (['feature', 'attachments', 'directory', 'file'].includes(node.kind)) {
            row.addEventListener('contextmenu', event => {
                showScenarioResourceContextMenu(event, node);
            });
        }
        if (node.kind === 'file') {
            row.draggable = true;
            row.addEventListener('dragstart', event => {
                if (filesProtocol.setEditorDragData(event, node)) {
                    row.classList.add('is-dragging');
                }
            });
            row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
        } else if (node.kind === 'definition' && node.insertable === true && typeof node.dragText === 'string') {
            row.draggable = true;
            row.addEventListener('dragstart', event => {
                if (!event.dataTransfer) {
                    return;
                }
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData('text/plain', node.dragText);
                row.classList.add('is-dragging');
            });
            row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
        }

        const acceptsDrop = (node.kind === 'definition' && node.hasScenarioFiles === true)
            || node.kind === 'directory'
            || node.kind === 'attachments';
        if (acceptsDrop) {
            row.addEventListener('dragover', event => {
                if (!event.dataTransfer?.types?.includes('Files')) {
                    return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                row.classList.add('is-drop-target');
            });
            row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
            row.addEventListener('drop', event => {
                row.classList.remove('is-drop-target');
                if (!event.dataTransfer?.types?.includes('Files')) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                void transferController.beginDrop(event.dataTransfer, {
                    itemId: node.itemId,
                    relativePath: node.kind === 'definition' ? '' : (node.relativePath || '')
                });
            });
        }

        const expanded = uiState.expandedIds.includes(node.id);
        const toggle = document.createElement('span');
        toggle.className = 'step-chevron';
        if (node.expandable) {
            const disclosureIcon = createIcon(expanded ? 'chevron-down' : 'chevron-right');
            disclosureIcon.classList.add('kot-tree-disclosure');
            toggle.appendChild(disclosureIcon);
            row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
        row.appendChild(toggle);

        if (node.kind !== 'definition') {
            const nodeIcon = document.createElement('span');
            nodeIcon.className = 'step-node-icon';
            nodeIcon.appendChild(createIcon(nodeIconName(node)));
            row.appendChild(nodeIcon);
        }

        const label = document.createElement(node.kind === 'definition' ? 'pre' : 'span');
        label.className = node.kind === 'definition'
            ? 'kot-tree-label step-code'
            : 'kot-tree-label';
        const labelContent = document.createElement('span');
        labelContent.className = 'kot-scroll-content';
        if (node.kind === 'definition') {
            appendSyntax(labelContent, node.label);
        } else {
            labelContent.textContent = node.label;
        }
        label.appendChild(labelContent);
        row.appendChild(label);

        const displayedCount = protocol.displayedNodeCount(
            node,
            relationshipFilterEnabled,
            relationshipVisibleCounts
        );
        if (typeof displayedCount === 'number') {
            const count = document.createElement('span');
            count.className = 'step-count kot-tree-count';
            count.textContent = String(displayedCount);
            row.appendChild(count);
        }

        const decoration = relationshipDecoration(node);
        if (decoration.state !== 'none') {
            row.classList.add(...decoration.classNames);
            const relationshipLabel = decoration.accessibleLabel
                ? `${node.label}. ${decoration.accessibleLabel}`
                : node.label;
            row.setAttribute('aria-label', relationshipLabel);
        } else if (protocol.shouldHighlightRelationshipAncestor(node.id, relatedAncestorIds, uiState)) {
            row.classList.add('is-related');
            const relationshipLabel = `${node.label}. ${loc.containsRelatedScenarios}`;
            row.setAttribute('aria-label', relationshipLabel);
        }

        const actions = document.createElement('span');
        actions.className = 'kot-row-actions step-actions';
        if (node.kind === 'definition' && node.itemId) {
            actions.appendChild(createActionButton(
                'toggleFavorite',
                node.favorite ? 'star-full' : 'star-empty',
                node.favorite ? loc.removeFavorite : loc.addFavorite,
                node
            ));
            if (node.insertable === true) {
                actions.appendChild(createActionButton(
                    'insert',
                    'insert',
                    insertionAvailable ? loc.insertStep : loc.insertionUnavailable,
                    node,
                    !insertionAvailable
                ));
            }
            actions.appendChild(createActionButton('copy', 'copy', loc.copyStep, node));
            if (node.navigable === true) {
                actions.appendChild(createActionButton('openDefinition', 'go-to-file', loc.openDefinition, node));
            }
        } else if (node.kind === 'feature' && node.itemId) {
            actions.appendChild(createResourceActionButton(
                'openCompiledScenarioFeature',
                'go-to-file',
                loc.openDefinition,
                node
            ));
        } else if (node.itemId && (
            node.kind === 'directory'
            || node.kind === 'attachments'
            || node.kind === 'file'
        )) {
            if (node.kind === 'file') {
                actions.appendChild(createResourceActionButton(
                    'openScenarioFile',
                    'link-external',
                    loc.openExternally,
                    node
                ));
            }
            actions.appendChild(createResourceActionButton(
                'revealScenarioFile',
                'folder-opened',
                loc.showInFileManager,
                node
            ));
        }
        row.appendChild(actions);
        return row;
    }

    function appendNode(fragment, node, parentId, entering = false) {
        if (!relationshipNodeVisible(node, parentId)) {
            return;
        }
        const branch = document.createElement('div');
        branch.className = 'step-branch';
        branch.dataset.nodeId = node.id;
        branch.appendChild(makeRow(node, parentId));
        fragment.appendChild(branch);
        if (!node.expandable || !uiState.expandedIds.includes(node.id)) {
            return;
        }
        const children = childrenByParent.get(node.id);
        if (!children) {
            requestChildren(node.id, 0);
            return;
        }

        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'step-children';
        childrenContainer.dataset.expansionId = node.id;
        childrenContainer.setAttribute('role', 'group');
        const bulkEntering = bulkEnteringNodeIds.has(node.id)
            && !bulkEnteringNodeIds.has(parentId);
        if (entering || pendingExpansionAnimations.has(node.id) || bulkEntering) {
            childrenContainer.classList.add('is-entering');
        } else {
            childrenContainer.classList.add('expanded');
            childrenContainer.style.maxHeight = 'none';
        }
        for (const child of children) {
            appendNode(childrenContainer, child, node.id, false);
        }
        if (children.length === 0 && (
            node.kind === 'directory'
            || node.kind === 'attachments'
            || (node.kind === 'definition' && node.hasScenarioFiles === true)
        )) {
            const empty = document.createElement('div');
            empty.className = 'step-resource-empty';
            empty.style.setProperty('--step-depth', String(Number(node.depth || 0) + 1));
            empty.textContent = loc.emptyDirectory;
            childrenContainer.appendChild(empty);
        }
        branch.appendChild(childrenContainer);
    }

    function relationshipNodeVisible(node, parentId = '') {
        return !relationshipFilterEnabled
            || relatedAncestorIds.has(node.id)
            || (node.kind === 'more' && relatedAncestorIds.has(parentId))
            || (node.itemId && relatedItemIds.has(node.itemId))
            || protocol.isNodeRelationshipMatch(node, uiState);
    }

    function prefersReducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function animateExpandedBranch(childrenContainer) {
        if (!(childrenContainer instanceof HTMLElement)) {
            return;
        }
        childrenContainer.classList.remove('is-entering');
        childrenContainer.classList.add('expanded');
        if (prefersReducedMotion()) {
            childrenContainer.style.maxHeight = 'none';
            return;
        }

        childrenContainer.style.maxHeight = '0px';
        void childrenContainer.offsetHeight;
        const targetHeight = childrenContainer.scrollHeight;
        childrenContainer.classList.add('animating');
        const onTransitionEnd = event => {
            if (event.target !== childrenContainer || event.propertyName !== 'max-height') {
                return;
            }
            childrenContainer.removeEventListener('transitionend', onTransitionEnd);
            childrenContainer.classList.remove('animating');
            childrenContainer.style.maxHeight = 'none';
        };
        childrenContainer.addEventListener('transitionend', onTransitionEnd);
        childrenContainer.style.maxHeight = `${targetHeight}px`;
    }

    function collapseBranchBeforeRender(node, onCollapsed) {
        if (collapsingNodeIds.has(node.id)) {
            return true;
        }
        const row = tree.querySelector(`.step-row[data-node-id="${CSS.escape(node.id)}"]`);
        const branch = row?.closest('.step-branch');
        const childrenContainer = branch
            ? Array.from(branch.children).find(child => child.classList.contains('step-children'))
            : null;
        if (!(childrenContainer instanceof HTMLElement) || prefersReducedMotion()) {
            return false;
        }

        collapsingNodeIds.add(node.id);
        const startHeight = childrenContainer.scrollHeight;
        childrenContainer.style.maxHeight = `${startHeight}px`;
        void childrenContainer.offsetHeight;
        childrenContainer.classList.add('animating');
        childrenContainer.classList.remove('expanded');

        let completed = false;
        const finish = () => {
            if (completed) {
                return;
            }
            completed = true;
            collapsingNodeIds.delete(node.id);
            childrenContainer.removeEventListener('transitionend', onTransitionEnd);
            onCollapsed();
        };
        const onTransitionEnd = event => {
            if (event.target === childrenContainer && event.propertyName === 'max-height') {
                finish();
            }
        };
        childrenContainer.addEventListener('transitionend', onTransitionEnd);
        window.setTimeout(finish, 260);
        childrenContainer.style.maxHeight = '0px';
        return true;
    }

    function render() {
        const scrollTop = tree.scrollTop;
        nodesById.clear();
        const fragment = document.createDocumentFragment();
        const visibleRoots = (searchResults === null ? roots : searchResults)
            .filter(relationshipNodeVisible);
        for (const node of visibleRoots) {
            appendNode(fragment, node, '', false);
        }
        tree.replaceChildren(fragment);
        tree.scrollTop = persisted.scrollTop !== undefined && roots.length > 0
            ? persisted.scrollTop
            : scrollTop;
        persisted.scrollTop = undefined;
        const enteringBranches = [...tree.querySelectorAll('.step-children.is-entering')];
        for (const enteringBranch of enteringBranches) {
            animateExpandedBranch(enteringBranch);
            pendingExpansionAnimations.consume(enteringBranch.dataset.expansionId || '');
        }
        bulkEnteringNodeIds.clear();
        requestAnimationFrame(() => updateLabelOverflow());
    }

    function updateLabelOverflow(labelRoot = tree) {
        for (const label of labelRoot.querySelectorAll('.kot-tree-label')) {
            const content = label.querySelector('.kot-scroll-content');
            if (!content) {
                continue;
            }
            const distance = Math.max(0, content.scrollWidth - label.clientWidth + 12);
            label.classList.toggle('is-overflowing', distance > 1);
            label.style.setProperty('--kot-overflow-distance', `${distance}px`);
            label.style.setProperty('--kot-overflow-duration', `${Math.max(1.2, distance / 45)}s`);
        }
    }

    const labelResizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => updateLabelOverflow())
        : null;
    if (labelResizeObserver) {
        labelResizeObserver.observe(tree);
    }

    function requestChildren(parentId, offset, knownParent, renderSynchronousChildren = true) {
        const requestKey = `${parentId}\0${offset}`;
        if (requestedParents.has(requestKey)) {
            return pendingParents.has(requestKey);
        }
        requestedParents.add(requestKey);
        pendingParents.add(requestKey);
        const parent = knownParent || nodesById.get(parentId);
        if (
            parent?.kind === 'definition'
            && parent.compiledFeatureUri
            && parent.scenarioFilesRootUri
        ) {
            const nodes = filesProtocol.projectCompiledScenarioChildren(parent, loc);
            childrenByParent.set(parent.id, nodes);
            const parents = resourceParentIdsByItem.get(parent.itemId) || new Set();
            parents.add(parent.id);
            for (const node of nodes) {
                if (node.expandable) {
                    parents.add(node.id);
                }
            }
            resourceParentIdsByItem.set(parent.itemId, parents);
            pendingParents.delete(requestKey);
            if (renderSynchronousChildren) {
                queueMicrotask(render);
            }
            return false;
        }
        if (parent?.kind === 'definition' && parent.hasScenarioFiles === true) {
            vscode.postMessage({
                command: 'listScenarioFiles',
                itemId: parent.itemId,
                relativePath: '',
                requestId: parent.id
            });
            return true;
        }
        if (parent?.kind === 'directory' || parent?.kind === 'attachments') {
            vscode.postMessage({
                command: 'listScenarioFiles',
                itemId: parent.itemId,
                relativePath: parent.relativePath || '',
                requestId: parent.id
            });
            return true;
        }
        vscode.postMessage({ command: 'expand', nodeId: parentId, offset });
        return true;
    }

    function toggleNode(node) {
        if (!node.expandable) {
            return;
        }
        const wasExpanded = uiState.expandedIds.includes(node.id);
        bulkExpansion.cancel();
        if (wasExpanded && collapseBranchBeforeRender(node, () => {
            uiState = protocol.toggleExpanded(uiState, node.id);
            pendingExpansionAnimations.cancel(node.id);
            persistState();
            render();
        })) {
            return;
        }
        uiState = protocol.toggleExpanded(uiState, node.id);
        if (wasExpanded) {
            pendingExpansionAnimations.cancel(node.id);
        } else {
            pendingExpansionAnimations.request(node.id);
        }
        if (node.kind === 'definition' && node.hasScenarioFiles === true) {
            vscode.postMessage({
                command: 'setScenarioFilesExpanded',
                itemId: node.itemId,
                expanded: !wasExpanded
            });
        }
        if (uiState.expandedIds.includes(node.id) && !childrenByParent.has(node.id)) {
            requestChildren(node.id, 0, node, false);
        }
        persistState();
        render();
    }

    function allKnownExpandableNodes() {
        const knownNodes = [...roots];
        for (const children of childrenByParent.values()) {
            knownNodes.push(...children);
        }
        return knownNodes.filter(node => node.expandable && node.kind !== 'more');
    }

    const bulkExpansion = protocol.createBulkExpansionController({
        getExpandableNodes: allKnownExpandableNodes,
        hasChildren: nodeId => childrenByParent.has(nodeId),
        requestChildren: node => requestChildren(node.id, 0, node),
        onComplete: expandedIds => {
            const transition = protocol.bulkExpansionTransition(
                uiState.expandedIds,
                expandedIds
            );
            bulkEnteringNodeIds = new Set(transition.expandingIds);
            uiState = protocol.createState({
                ...uiState,
                expandedIds,
                selectedId: uiState.selectedId
            });
            persistState();
            render();
        }
    });

    function collapseAllBranchesBeforeRender(nodeIds, onCollapsed) {
        if (prefersReducedMotion()) {
            return false;
        }
        const candidates = nodeIds.map(nodeId => {
            const row = tree.querySelector(`.step-row[data-node-id="${CSS.escape(nodeId)}"]`);
            const branch = row?.closest('.step-branch');
            return branch
                ? Array.from(branch.children).find(child => child.classList.contains('step-children'))
                : null;
        }).filter(container => container instanceof HTMLElement);
        const containers = candidates.filter(container => !candidates.some(other =>
            other !== container && other.contains(container)
        ));
        if (containers.length === 0) {
            return false;
        }
        let pending = containers.length;
        let completed = false;
        const finishOne = () => {
            pending -= 1;
            if (pending > 0 || completed) {
                return;
            }
            completed = true;
            onCollapsed();
        };
        for (const container of containers) {
            container.style.maxHeight = `${container.scrollHeight}px`;
            void container.offsetHeight;
            container.classList.add('animating');
            container.classList.remove('expanded');
            let finished = false;
            const finish = () => {
                if (finished) {
                    return;
                }
                finished = true;
                container.removeEventListener('transitionend', onTransitionEnd);
                finishOne();
            };
            const onTransitionEnd = event => {
                if (event.target === container && event.propertyName === 'max-height') {
                    finish();
                }
            };
            container.addEventListener('transitionend', onTransitionEnd);
            window.setTimeout(finish, 260);
            requestAnimationFrame(() => {
                container.style.maxHeight = '0px';
            });
        }
        return true;
    }

    function collapseAllGroups() {
        bulkExpansion.cancel();
        const transition = protocol.bulkExpansionTransition(uiState.expandedIds, []);
        const complete = () => {
            uiState = protocol.createState({
                ...uiState,
                expandedIds: [],
                selectedId: uiState.selectedId
            });
            persistState();
            render();
        };
        if (!collapseAllBranchesBeforeRender(transition.collapsingIds, complete)) {
            complete();
        }
    }

    function toggleAllGroups() {
        const expandableNodes = allKnownExpandableNodes();
        const allExpanded = expandableNodes.length > 0
            && expandableNodes.every(node => uiState.expandedIds.includes(node.id));
        if (bulkExpansion.active || allExpanded) {
            collapseAllGroups();
            return;
        }
        bulkExpansion.start(uiState.expandedIds);
    }

    function selectNode(nodeId) {
        uiState = protocol.selectNode(uiState, nodeId);
        persistState();
        render();
    }

    function activateNode(node, openDefinition) {
        if (node?.kind === 'feature') {
            vscode.postMessage({
                command: 'openCompiledScenarioFeature',
                itemId: node.itemId
            });
            return;
        }
        if (node?.kind === 'file') {
            vscode.postMessage({
                command: 'openScenarioFile',
                itemId: node.itemId,
                relativePath: node.relativePath
            });
            return;
        }
        if (!node || node.kind !== 'definition' || !node.itemId) {
            return;
        }
        vscode.postMessage({
            command: openDefinition ? 'openDefinition' : 'insert',
            itemId: node.itemId
        });
    }

    tree.addEventListener('click', event => {
        const row = event.target.closest('.step-row');
        if (!row) {
            return;
        }
        const node = nodesById.get(row.dataset.nodeId);
        if (!node) {
            return;
        }
        if (node.kind === 'more') {
            const match = /:more:(\d+)$/u.exec(node.id);
            requestChildren(row.dataset.parentId, match ? Number(match[1]) : 0);
            return;
        }
        selectNode(node.id);
        if (node.expandable) {
            toggleNode(node);
        }
    });

    const refreshHoveredLabelOverflow = event => {
        const row = event.target.closest('.step-row');
        if (row) {
            requestAnimationFrame(() => updateLabelOverflow(row));
        }
    };
    tree.addEventListener('mouseover', refreshHoveredLabelOverflow);
    tree.addEventListener('mouseout', refreshHoveredLabelOverflow);

    tree.addEventListener('dblclick', event => {
        if (event.target.closest('button')) {
            return;
        }
        const row = event.target.closest('.step-row');
        activateNode(row ? nodesById.get(row.dataset.nodeId) : null, false);
    });

    tree.addEventListener('keydown', event => {
        const visibleIds = [...tree.querySelectorAll('.step-row')].map(row => row.dataset.nodeId);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            uiState = protocol.moveSelection(uiState, visibleIds, event.key === 'ArrowDown' ? 1 : -1);
            persistState();
            render();
            tree.querySelector(`[data-node-id="${CSS.escape(uiState.selectedId || '')}"]`)?.focus();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            activateNode(nodesById.get(uiState.selectedId), event.metaKey || event.ctrlKey);
        }
    });

    searchInput.addEventListener('input', () => {
        updateSearchClearButton();
        if (searchTimer !== null) {
            clearTimeout(searchTimer);
        }
        searchTimer = setTimeout(() => {
            vscode.postMessage({ command: 'search', query: searchInput.value });
        }, 150);
    });
    searchClearBtn.addEventListener('click', () => {
        if (!searchInput.value) {
            return;
        }
        searchInput.value = '';
        updateSearchClearButton();
        if (searchTimer !== null) {
            clearTimeout(searchTimer);
            searchTimer = null;
        }
        vscode.postMessage({ command: 'search', query: '' });
        searchInput.focus();
    });
    updateSearchClearButton();

    window.addEventListener('message', event => {
        const message = event.data || {};
        closeScenarioResourceContextMenu();
        if (transferController.handleMessage(message)) {
            return;
        }
        switch (message.command) {
            case 'loading':
                status.textContent = loc.loading;
                break;
            case 'roots':
                bulkExpansion.cancel();
                if (libraryIdentity !== null && libraryIdentity !== message.identity) {
                    childrenByParent.clear();
                    requestedParents.clear();
                    pendingParents.clear();
                    pendingExpansionAnimations.clear();
                }
                libraryIdentity = message.identity || null;
                {
                    const nextFavorites = new Set(message.favoriteItemIds || []);
                    const favoritesChanged = nextFavorites.size !== favoriteItemIds.size
                        || [...nextFavorites].some(itemId => !favoriteItemIds.has(itemId));
                    favoriteItemIds = nextFavorites;
                    if (favoritesChanged) {
                        childrenByParent.delete('favorites');
                        for (const key of [...requestedParents]) {
                            if (key.startsWith('favorites\0')) {
                                requestedParents.delete(key);
                            }
                        }
                        for (const [parentId, children] of childrenByParent) {
                            childrenByParent.set(parentId, children.map(node => node.itemId
                                ? { ...node, favorite: favoriteItemIds.has(node.itemId) }
                                : node));
                        }
                    }
                }
                roots = Array.isArray(message.nodes) ? message.nodes : [];
                searchResults = null;
                insertionAvailable = message.insertionTarget?.available === true;
                relationshipState = message.relationshipState || relationshipState;
                relationshipFilterEnabled = message.relationshipFilterEnabled === true;
                relatedAncestorIds = new Set(message.relatedAncestorIds || []);
                relatedItemIds = new Set(message.relatedItemIds || []);
                relationshipVisibleCounts = message.relationshipVisibleCounts || {};
                uiState = protocol.withRelationshipState(uiState, relationshipState);
                status.textContent = '';
                render();
                break;
            case 'children': {
                pendingParents.delete(`${message.parentId}\0${message.offset}`);
                const current = message.offset > 0 && childrenByParent.has(message.parentId)
                    ? childrenByParent.get(message.parentId).filter(node => node.kind !== 'more')
                    : [];
                childrenByParent.set(message.parentId, [...current, ...(message.nodes || [])]);
                if (!bulkExpansion.childrenLoaded(message.parentId)) {
                    render();
                }
                break;
            }
            case 'scenarioFileChildren': {
                pendingParents.delete(`${message.requestId}\0${0}`);
                const parent = nodesById.get(message.requestId)
                    || allKnownExpandableNodes().find(node => node.id === message.requestId);
                const nodes = filesProtocol.projectDirectChildren(
                    Number(parent?.depth || 0),
                    message.nodes
                );
                childrenByParent.set(message.requestId, nodes);
                const parents = resourceParentIdsByItem.get(message.itemId) || new Set();
                parents.add(message.requestId);
                for (const node of nodes) {
                    if (node.expandable) {
                        parents.add(node.id);
                    }
                }
                resourceParentIdsByItem.set(message.itemId, parents);
                if (!bulkExpansion.childrenLoaded(message.requestId)) {
                    render();
                }
                break;
            }
            case 'scenarioFileInvalidated': {
                bulkExpansion.cancel();
                for (const parentId of resourceParentIdsByItem.get(message.itemId) || []) {
                    childrenByParent.delete(parentId);
                    for (const key of [...requestedParents]) {
                        if (key.startsWith(`${parentId}\0`)) {
                            requestedParents.delete(key);
                            pendingParents.delete(key);
                        }
                    }
                }
                render();
                break;
            }
            case 'scenarioFileTransferFailed':
                if (message.requestId) {
                    for (const key of [...requestedParents]) {
                        if (key.startsWith(`${message.requestId}\0`)) {
                            requestedParents.delete(key);
                            pendingParents.delete(key);
                        }
                    }
                }
                bulkExpansion.cancel();
                status.textContent = message.message || loc.resourceActionFailed;
                break;
            case 'scenarioFileActionResult':
                if (message.action === 'delete' && message.succeeded) {
                    for (const parentId of resourceParentIdsByItem.get(message.itemId) || []) {
                        childrenByParent.delete(parentId);
                        for (const key of [...requestedParents]) {
                            if (key.startsWith(`${parentId}\0`)) {
                                requestedParents.delete(key);
                                pendingParents.delete(key);
                            }
                        }
                    }
                    resourceParentIdsByItem.delete(message.itemId);
                    render();
                } else if (!message.succeeded && !message.cancelled) {
                    status.textContent = loc.resourceActionFailed;
                }
                break;
            case 'toggleAllGroups':
                toggleAllGroups();
                break;
            case 'searchResults':
                searchResults = message.query.trim() ? (message.nodes || []) : null;
                status.textContent = searchResults && searchResults.length === 0 ? loc.noMatches : '';
                render();
                break;
            case 'relationshipState':
                bulkExpansion.cancel();
                protocol.resetRelationshipPagingOnFilterChange(
                    relationshipFilterEnabled,
                    message.relationshipFilterEnabled === true,
                    childrenByParent,
                    requestedParents
                );
                pendingParents.clear();
                relationshipState = message.relationshipState || relationshipState;
                relationshipFilterEnabled = message.relationshipFilterEnabled === true;
                relatedAncestorIds = new Set(message.relatedAncestorIds || []);
                relatedItemIds = new Set(message.relatedItemIds || []);
                relationshipVisibleCounts = message.relationshipVisibleCounts || {};
                uiState = protocol.withRelationshipState(uiState, relationshipState);
                render();
                break;
            case 'insertionTarget':
                insertionAvailable = message.available === true;
                render();
                break;
            case 'actionResult':
                break;
            case 'error':
                status.textContent = message.message || loc.error;
                break;
        }
    });

    window.addEventListener('unload', () => transferController.dispose());

    vscode.postMessage({ command: 'ready' });
}());
