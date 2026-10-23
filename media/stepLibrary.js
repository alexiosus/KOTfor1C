(function startStepLibraryClient() {
    'use strict';

    const vscode = acquireVsCodeApi();
    const protocol = globalThis.StepLibraryProtocol;
    const filesProtocol = globalThis.KotScenarioFilesProtocol;
    const BATCH_SIZE = 100;
    const shell = document.querySelector('.library-shell');
    const libraryGrid = document.querySelector('.library-grid');
    const searchInput = document.getElementById('searchInput');
    const searchClearButton = document.getElementById('searchClearBtn');
    const languageFilter = document.getElementById('languageFilter');
    const sortMode = document.getElementById('sortMode');
    const refreshButton = document.getElementById('refreshButton');
    const createButton = document.getElementById('createButton');
    const categoryToggle = document.getElementById('categoryToggle');
    const categoryBack = document.getElementById('categoryBack');
    const detailsBack = document.getElementById('detailsBack');
    const categoryTree = document.getElementById('categoryTree');
    const statusMessage = document.getElementById('statusMessage');
    const definitionList = document.getElementById('definitionList');
    const definitionListContent = document.getElementById('definitionListContent');
    const resultCount = document.getElementById('resultCount');
    const detailsContent = document.getElementById('detailsContent');
    const insertButton = document.getElementById('insertButton');
    const copyButton = document.getElementById('copyButton');
    const convertFormatButton = document.getElementById('convertFormatButton');
    const openDefinitionButton = document.getElementById('openDefinitionButton');
    const favoriteButton = document.getElementById('favoriteButton');
    const paneResizers = [...document.querySelectorAll('.pane-resizer')];
    const liveRegion = document.getElementById('liveRegion');
    const labels = document.body.dataset;
    const persisted = vscode.getState() || {};
    const renderedRowsById = new Map();
    const resourceChildrenByParent = new Map();
    const resourceNodesById = new Map();
    const resourceParentIdsByItem = new Map();
    const requestedResourceNodes = new Set();
    const watchedScenarioIds = new Set();
    const treeElementsById = new Map();
    let selectedDefinitionRow = null;
    let selectedTreeButton = null;
    let resultPager = null;
    let resultIdentity = '';
    let visibleResultCount = BATCH_SIZE;
    let resultScrollFrame = null;
    let scenarioLabelOverflowFrame = null;
    const pendingScenarioResourceAnimations = filesProtocol.createPendingExpansionTracker();
    const scheduledScenarioResourceAnimations = new Set();
    const collapsingScenarioResourceIds = new Set();
    const detailsExpandedResourceIds = new Set();
    let snapshotItemsById = new Map();
    let languageItemsCache = { key: '', items: [] };
    let filteredItemsCache = { key: '', items: [] };
    const state = {
        snapshot: null,
        query: typeof persisted.query === 'string' ? persisted.query : '',
        sourceGroup: typeof persisted.sourceGroup === 'string' ? persisted.sourceGroup : null,
        favoritesOnly: persisted.favoritesOnly === true,
        categoryPath: Array.isArray(persisted.categoryPath) ? persisted.categoryPath : [],
        groupId: typeof persisted.groupId === 'string' ? persisted.groupId : undefined,
        uncategorized: persisted.uncategorized === true,
        expandedNodes: new Set(Array.isArray(persisted.expandedNodes)
            ? persisted.expandedNodes
            : []),
        selectedItemId: typeof persisted.selectedItemId === 'string'
            ? persisted.selectedItemId
            : null,
        language: persisted.language === 'ru' || persisted.language === 'en'
            ? persisted.language
            : 'both',
        sortMode: persisted.sortMode === 'alphabetical' ? 'alphabetical' : 'relevance',
        insertionTarget: { available: false, identity: 'unavailable' },
        favoriteItemIds: new Set(),
        pendingActions: new Set(),
        paneLayout: {
            categoryWidth: Number.isFinite(persisted.paneLayout?.categoryWidth)
                ? persisted.paneLayout.categoryWidth
                : 270,
            detailsWidth: Number.isFinite(persisted.paneLayout?.detailsWidth)
                ? persisted.paneLayout.detailsWidth
                : 380
        }
    };
    const featureLabels = window.__standaloneFeatureLabels || {};
    const featureActions = globalThis.StepLibraryFeatureProtocol.createController({
        postMessage: message => vscode.postMessage(message),
        getFeatures: () => state.snapshot?.items.filter(item => item.featureId) || [],
        getItemActions: item => item.definitionId ? protocol.definitionRowActionOrder(item).map(action => ({
            id: action === 'favorite' ? 'toggleFavorite' : action,
            label: action === 'favorite'
                ? state.favoriteItemIds.has(item.id) ? labels.removeFavorite : labels.addFavorite
                : labels[action],
            disabled: action !== 'favorite' && (state.pendingActions.has(`${action}\0${item.id}`)
                || (action === 'insert' && !state.insertionTarget.available))
        })) : [],
        runItemAction: (action, item) => {
            if (action === 'toggleFavorite') { vscode.postMessage({ command: action, itemId: item.id }); }
            else if (action === 'insert') { requestInsert(item.id); }
            else { sendAction(action, item.id); }
        },
        labels: featureLabels
    });
    const transferController = filesProtocol.createTransferController(message => {
        vscode.postMessage(message);
    });
    let scenarioResourceContextMenu = null;

    function closeScenarioResourceContextMenu() {
        scenarioResourceContextMenu?.remove();
        scenarioResourceContextMenu = null;
    }

    function saveState() {
        vscode.setState({
            query: state.query,
            sourceGroup: state.sourceGroup,
            favoritesOnly: state.favoritesOnly,
            categoryPath: [...state.categoryPath],
            groupId: state.groupId,
            uncategorized: state.uncategorized,
            expandedNodes: [...state.expandedNodes],
            selectedItemId: state.selectedItemId,
            language: state.language,
            sortMode: state.sortMode,
            paneLayout: state.paneLayout
        });
    }

    function languageOptions(extra) {
        return {
            language: state.language,
            preferredLanguage: labels.preferredLanguage === 'ru' ? 'ru' : 'en',
            ...extra
        };
    }

    function applyPaneLayout(layout, persist) {
        if (!libraryGrid) {
            return;
        }
        state.paneLayout = libraryGrid.clientWidth > 900
            ? protocol.resizePaneLayout(
                layout,
                'category',
                0,
                libraryGrid.clientWidth
            )
            : layout;
        libraryGrid.style.setProperty(
            '--category-pane-width',
            `${state.paneLayout.categoryWidth}px`
        );
        libraryGrid.style.setProperty(
            '--details-pane-width',
            `${state.paneLayout.detailsWidth}px`
        );
        for (const resizer of paneResizers) {
            const value = resizer.dataset.divider === 'category'
                ? state.paneLayout.categoryWidth
                : Math.max(0, libraryGrid.clientWidth - state.paneLayout.detailsWidth);
            resizer.setAttribute('aria-valuenow', String(Math.round(value)));
        }
        if (persist) {
            saveState();
        }
        scheduleScenarioResourceLabelOverflowUpdate();
    }

    function setupPaneResizer(resizer) {
        const divider = resizer.dataset.divider;
        if (divider !== 'category' && divider !== 'details') {
            return;
        }
        let drag = null;
        resizer.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !libraryGrid || libraryGrid.clientWidth <= 900) {
                return;
            }
            event.preventDefault();
            drag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startLayout: { ...state.paneLayout },
                containerWidth: libraryGrid.clientWidth
            };
            resizer.setPointerCapture(event.pointerId);
            shell.classList.add('resizing-panes');
        });
        resizer.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) {
                return;
            }
            applyPaneLayout(protocol.resizePaneLayout(
                drag.startLayout,
                divider,
                event.clientX - drag.startX,
                drag.containerWidth
            ), false);
        });
        const finishDrag = event => {
            if (!drag || event.pointerId !== drag.pointerId) {
                return;
            }
            drag = null;
            shell.classList.remove('resizing-panes');
            saveState();
        };
        resizer.addEventListener('pointerup', finishDrag);
        resizer.addEventListener('pointercancel', finishDrag);
        resizer.addEventListener('lostpointercapture', finishDrag);
        resizer.addEventListener('keydown', event => {
            if (!libraryGrid || !['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                return;
            }
            event.preventDefault();
            const delta = event.key === 'ArrowLeft' ? -16 : 16;
            applyPaneLayout(protocol.resizePaneLayout(
                state.paneLayout,
                divider,
                delta,
                libraryGrid.clientWidth
            ), true);
        });
    }

    function announce(message) {
        liveRegion.textContent = '';
        requestAnimationFrame(() => {
            liveRegion.textContent = message;
        });
    }

    function setStatus(message, kind) {
        statusMessage.textContent = message || '';
        statusMessage.classList.toggle('visible', Boolean(message));
        statusMessage.classList.toggle('error', kind === 'error');
    }

    function appendHighlightedText(element, value) {
        element.replaceChildren();
        for (const token of protocol.tokenizeGherkinText(value)) {
            if (token.kind === 'plain') {
                element.append(document.createTextNode(token.text));
                continue;
            }
            const span = document.createElement('span');
            span.className = `syntax-${token.kind}`;
            span.textContent = token.text;
            element.append(span);
        }
    }

    function sourceLabel(sourceGroup) {
        return labels[`source${sourceGroup.charAt(0).toUpperCase()}${sourceGroup.slice(1)}`]
            || sourceGroup;
    }

    function categoryLabel(item) {
        return item.categoryPath && item.categoryPath.length > 0
            ? item.categoryPath.join(' / ')
            : item.featureId ? labels.ungrouped : labels.uncategorized;
    }

    function allItemsForLanguage() {
        if (!state.snapshot) {
            return [];
        }
        const key = `${state.snapshot.viewIdentity}\0${state.language}\0${labels.preferredLanguage}`;
        if (languageItemsCache.key === key) {
            return languageItemsCache.items;
        }
        const items = protocol.searchItems(state.snapshot.items, '', languageOptions({
            limit: Number.MAX_SAFE_INTEGER
        }));
        languageItemsCache = { key, items };
        return items;
    }

    function filteredItems() {
        if (!state.snapshot) {
            return [];
        }
        const key = JSON.stringify([
            state.snapshot.viewIdentity,
            state.language,
            labels.preferredLanguage,
            state.query,
            state.favoritesOnly,
            [...state.favoriteItemIds].sort(),
            state.sourceGroup,
            state.categoryPath,
            state.groupId,
            state.uncategorized,
            state.sortMode
        ]);
        if (filteredItemsCache.key === key) {
            return filteredItemsCache.items;
        }
        if (
            !state.query
            && !state.favoritesOnly
            && !state.sourceGroup
            && state.categoryPath.length === 0
            && !state.uncategorized
        ) {
            const items = [...allItemsForLanguage()];
            filteredItemsCache = { key, items };
            return items;
        }
        const sourceItems = state.favoritesOnly
            ? state.snapshot.items.filter(item => state.favoriteItemIds.has(item.id))
            : state.snapshot.items;
        const items = protocol.searchItems(sourceItems, state.query, languageOptions({
            sourceGroup: state.sourceGroup || undefined,
            categoryPath: state.uncategorized ? undefined : state.categoryPath,
            groupId: state.sourceGroup === 'standalone' ? state.groupId : undefined,
            uncategorized: state.uncategorized,
            limit: Number.MAX_SAFE_INTEGER
        }));
        if (state.sortMode === 'alphabetical') {
            items.sort((left, right) => {
                const leftText = left.__normalizedDisplayText
                    || left.displayText.toLowerCase();
                const rightText = right.__normalizedDisplayText
                    || right.displayText.toLowerCase();
                return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
            });
        }
        filteredItemsCache = { key, items };
        return items;
    }

    function currentResultIdentity() {
        return JSON.stringify([
            state.snapshot?.viewIdentity || '',
            state.language,
            labels.preferredLanguage,
            state.query,
            state.favoritesOnly,
            [...state.favoriteItemIds].sort(),
            state.sourceGroup,
            state.categoryPath,
            state.groupId,
            state.uncategorized,
            state.sortMode
        ]);
    }

    function reconcileFiltersAndSelection() {
        if (!state.snapshot) {
            return;
        }
        if (!state.favoritesOnly) {
            const reconciled = protocol.reconcileCategorySelection(
                allItemsForLanguage(),
                state,
                state.snapshot.standaloneGroups,
                state.snapshot.scenarioGroups
            );
            state.sourceGroup = reconciled.sourceGroup;
            state.categoryPath = reconciled.categoryPath;
            state.uncategorized = reconciled.uncategorized;
            state.groupId = reconciled.groupId;
        }
        const visibleItems = filteredItems();
        if (!visibleItems.some(item => item.id === state.selectedItemId)) {
            state.selectedItemId = visibleItems[0]?.id || null;
        }
        saveState();
    }

    function isSelectedTreeNode(node) {
        if (node.id === 'all') {
            return !state.sourceGroup && !state.favoritesOnly;
        }
        if (node.id === 'favorites') {
            return state.favoritesOnly;
        }
        if (node.sourceGroup === 'standalone') {
            return state.sourceGroup === 'standalone' && node.groupId === state.groupId;
        }
        if (protocol.isUncategorizedNodeId(node.id)) {
            return state.sourceGroup === node.sourceGroup && state.uncategorized;
        }
        return state.sourceGroup === node.sourceGroup
            && !state.uncategorized
            && node.path.length === state.categoryPath.length
            && node.path.every((segment, index) => segment === state.categoryPath[index]);
    }

    function selectTreeNode(node) {
        state.groupId = node.sourceGroup === 'standalone' ? node.groupId : undefined;
        if (node.id === 'all') {
            state.favoritesOnly = false;
            state.sourceGroup = null;
            state.categoryPath = [];
            state.uncategorized = false;
        } else if (node.id === 'favorites') {
            state.favoritesOnly = true;
            state.sourceGroup = null;
            state.categoryPath = [];
            state.uncategorized = false;
        } else {
            state.favoritesOnly = false;
            state.sourceGroup = node.sourceGroup;
            state.categoryPath = [...node.path];
            state.uncategorized = protocol.isUncategorizedNodeId(node.id);
        }
        saveState();
        if (selectedTreeButton) {
            selectedTreeButton.setAttribute('aria-selected', 'false');
            selectedTreeButton.tabIndex = -1;
        }
        selectedTreeButton = treeElementsById.get(node.id)?.button || null;
        if (selectedTreeButton) {
            selectedTreeButton.setAttribute('aria-selected', 'true');
            selectedTreeButton.tabIndex = 0;
        }
        renderResults();
        shell.classList.remove('categories-open');
    }

    function treeNodeIconName(node, level) {
        if (level > 1) { return 'folder'; }
        if (node.id === 'favorites') { return 'star-full'; }
        return {
            builtIn: 'extensions',
            user: 'symbol-method',
            export: 'package',
            nested: 'references',
            main: 'files',
            process: 'list-ordered',
            standalone: 'file-code'
        }[node.sourceGroup] || 'library';
    }

    function createTreeNode(node, level) {
        const container = document.createElement('div');
        container.className = 'tree-node';
        const standaloneNode = node.sourceGroup === 'standalone';
        const renameableGroup = featureActions.canRenameGroup(node);
        const button = document.createElement(standaloneNode || renameableGroup ? 'div' : 'button');
        const children = document.createElement('div');
        const expandable = node.children.length > 0;
        const expanded = state.expandedNodes.has(node.id);
        button.type = 'button';
        button.className = 'tree-item';
        button.setAttribute('role', 'treeitem');
        button.setAttribute('aria-level', String(level));
        button.setAttribute('aria-selected', String(isSelectedTreeNode(node)));
        button.dataset.nodeId = node.id;
        featureActions.install(button, node);
        if (expandable) {
            button.setAttribute('aria-expanded', String(expanded));
        }
        button.tabIndex = isSelectedTreeNode(node) ? 0 : -1;

        const chevron = document.createElement('span');
        chevron.className = expandable
            ? `tree-chevron codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`
            : 'tree-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.label;
        const count = document.createElement('span');
        count.className = 'tree-count';
        count.textContent = String(node.count);
        const icon = document.createElement('span');
        icon.className = `tree-node-icon codicon codicon-${treeNodeIconName(node, level)}`;
        icon.setAttribute('aria-hidden', 'true');
        button.append(chevron, icon, label);
        if (standaloneNode || renameableGroup) {
            const actions = document.createElement('span');
            actions.className = 'tree-feature-actions';
            if (renameableGroup) { featureActions.appendMenuButton(actions, node, 'tree-feature-action icon-button'); }
            else { featureActions.appendTreeActionButton(actions, node, 'tree-feature-action icon-button'); }
            button.append(actions);
            button.addEventListener('keydown', event => {
                if (event.target === button && event.key === ' ') {
                    event.preventDefault();
                    selectTreeNode(node);
                }
            });
        }
        button.append(count);
        if (expandable) {
            chevron.addEventListener('click', event => {
                event.stopPropagation();
                toggleTreeNode(node.id);
            });
        }
        button.addEventListener('click', () => {
            if (standaloneNode || renameableGroup) { button.focus({ preventScroll: true }); }
            selectTreeNode(node);
        });
        button.addEventListener('dblclick', () => {
            if (expandable) {
                toggleTreeNode(node.id);
            }
        });
        container.append(button);

        children.className = 'tree-children';
        children.setAttribute('role', 'group');
        children.setAttribute('aria-hidden', String(!expanded));
        if (expanded) {
            children.classList.add('expanded');
            children.style.maxHeight = 'none';
        }
        for (const child of node.children) {
            children.append(createTreeNode(child, level + 1));
        }
        if (expandable) {
            container.append(children);
        }
        treeElementsById.set(node.id, { button, children, chevron });
        if (isSelectedTreeNode(node)) {
            selectedTreeButton = button;
        }
        return container;
    }

    function setTreeChildrenExpandedState(children, expanded) {
        if (!(children instanceof HTMLElement)) {
            return;
        }
        const previousHandler = children.__treeTransitionHandler;
        if (typeof previousHandler === 'function') {
            children.removeEventListener('transitionend', previousHandler);
            children.__treeTransitionHandler = null;
        }
        children.setAttribute('aria-hidden', String(!expanded));
        if (prefersReducedMotion()) {
            children.classList.toggle('expanded', expanded);
            children.classList.remove('animating');
            children.style.maxHeight = expanded ? 'none' : '0px';
            return;
        }

        let completed = false;
        const finish = () => {
            if (completed || children.__treeTransitionHandler !== onTransitionEnd) {
                return;
            }
            completed = true;
            children.removeEventListener('transitionend', onTransitionEnd);
            children.__treeTransitionHandler = null;
            children.classList.remove('animating');
            children.style.maxHeight = expanded ? 'none' : '0px';
        };
        const onTransitionEnd = event => {
            if (event.target === children && event.propertyName === 'max-height') {
                finish();
            }
        };
        children.__treeTransitionHandler = onTransitionEnd;
        children.addEventListener('transitionend', onTransitionEnd);
        window.setTimeout(finish, 260);

        if (expanded) {
            children.style.maxHeight = '0px';
            void children.offsetHeight;
            children.classList.add('animating', 'expanded');
            requestAnimationFrame(() => {
                if (children.isConnected) {
                    children.style.maxHeight = `${children.scrollHeight}px`;
                }
            });
            return;
        }

        children.style.maxHeight = `${children.scrollHeight}px`;
        void children.offsetHeight;
        children.classList.add('animating');
        children.classList.remove('expanded');
        requestAnimationFrame(() => {
            if (children.isConnected) {
                children.style.maxHeight = '0px';
            }
        });
    }

    function toggleTreeNode(nodeId) {
        if (state.expandedNodes.has(nodeId)) {
            state.expandedNodes.delete(nodeId);
        } else {
            state.expandedNodes.add(nodeId);
        }
        saveState();
        const elements = treeElementsById.get(nodeId);
        if (!elements) {
            return;
        }
        const expanded = state.expandedNodes.has(nodeId);
        elements.button.setAttribute('aria-expanded', String(expanded));
        setTreeChildrenExpandedState(elements.children, expanded);
        elements.chevron.classList.toggle('codicon-chevron-down', expanded);
        elements.chevron.classList.toggle('codicon-chevron-right', !expanded);
        elements.button.focus({ preventScroll: true });
    }

    function renderTree() {
        const items = allItemsForLanguage();
        const roots = protocol.buildCategoryTree(items, {
            sources: {
                builtIn: labels.sourceBuiltIn,
                user: labels.sourceUser,
                export: labels.sourceExport,
                nested: labels.sourceNested,
                main: labels.sourceMain,
                process: labels.sourceProcess,
                standalone: labels.sourceStandalone
            },
            uncategorized: labels.uncategorized,
            ungrouped: labels.ungrouped,
            standaloneGroups: state.snapshot?.standaloneGroups,
            scenarioGroups: state.snapshot?.scenarioGroups
        });
        const allNode = {
            id: 'all',
            sourceGroup: '',
            label: labels.allDefinitions,
            path: [],
            count: items.length,
            children: []
        };
        const favoritesNode = {
            id: 'favorites',
            sourceGroup: '',
            label: labels.favorites,
            path: [],
            count: items.filter(item => state.favoriteItemIds.has(item.id)).length,
            children: []
        };
        protocol.preserveScrollPosition(categoryTree, () => {
            treeElementsById.clear();
            selectedTreeButton = null;
            categoryTree.replaceChildren(
                createTreeNode(allNode, 1),
                createTreeNode(favoritesNode, 1),
                ...roots.map(root => createTreeNode(root, 1))
            );
        });
    }

    function resourceIconClass(node) {
        if (node.kind === 'file' || node.kind === 'feature') {
            return 'codicon-file';
        }
        return 'codicon-folder';
    }

    function requestScenarioFileChildren(node) {
        if (requestedResourceNodes.has(node.id)) {
            return;
        }
        requestedResourceNodes.add(node.id);
        vscode.postMessage({
            command: 'listScenarioFiles',
            itemId: node.itemId,
            ...(node.resource ? { resource: node.resource } : {}),
            relativePath: node.relativePath || '',
            requestId: node.id
        });
    }

    function prefersReducedMotion() {
        return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    }

    function scenarioResourceExpansionElement(expansionId) {
        return Array.from(definitionListContent.querySelectorAll('[data-resource-expansion-id]'))
            .find(element => element instanceof HTMLElement
                && element.dataset.resourceExpansionId === expansionId) || null;
    }

    function animateScenarioResourceExpansion(expansionId) {
        if (scheduledScenarioResourceAnimations.has(expansionId)) {
            return;
        }
        scheduledScenarioResourceAnimations.add(expansionId);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                scheduledScenarioResourceAnimations.delete(expansionId);
                if (!pendingScenarioResourceAnimations.has(expansionId)) {
                    return;
                }
                const container = scenarioResourceExpansionElement(expansionId);
                if (!(container instanceof HTMLElement)) {
                    return;
                }
                container.classList.remove('is-entering');
                container.classList.add('expanded');
                if (prefersReducedMotion()) {
                    container.style.maxHeight = 'none';
                    pendingScenarioResourceAnimations.consume(expansionId);
                    return;
                }
                container.style.maxHeight = '0px';
                container.classList.add('animating');
                let completed = false;
                const finish = () => {
                    if (completed) {
                        return;
                    }
                    completed = true;
                    container.removeEventListener('transitionend', onTransitionEnd);
                    container.classList.remove('animating');
                    container.style.maxHeight = 'none';
                };
                const onTransitionEnd = event => {
                    if (event.target === container && event.propertyName === 'max-height') {
                        finish();
                    }
                };
                container.addEventListener('transitionend', onTransitionEnd);
                window.setTimeout(finish, 260);
                if (container.isConnected) {
                    container.style.maxHeight = `${container.scrollHeight}px`;
                    pendingScenarioResourceAnimations.consume(expansionId);
                }
            });
        });
    }

    function collapseScenarioResourceBeforeRender(expansionId, onCollapsed) {
        const container = scenarioResourceExpansionElement(expansionId);
        if (!(container instanceof HTMLElement) || prefersReducedMotion()) {
            return false;
        }
        if (collapsingScenarioResourceIds.has(expansionId)) {
            return true;
        }
        collapsingScenarioResourceIds.add(expansionId);
        container.style.maxHeight = `${container.scrollHeight}px`;
        container.classList.add('expanded', 'animating');
        void container.offsetHeight;
        let completed = false;
        const finish = () => {
            if (completed) {
                return;
            }
            completed = true;
            collapsingScenarioResourceIds.delete(expansionId);
            container.removeEventListener('transitionend', onTransitionEnd);
            onCollapsed();
        };
        const onTransitionEnd = event => {
            if (event.target === container && event.propertyName === 'max-height') {
                finish();
            }
        };
        container.addEventListener('transitionend', onTransitionEnd);
        window.setTimeout(finish, 260);
        requestAnimationFrame(() => {
            container.classList.remove('expanded');
            container.style.maxHeight = '0px';
        });
        return true;
    }

    function updateScenarioResourceLabelOverflow() {
        for (const root of [definitionListContent, detailsContent]) {
            for (const label of root.querySelectorAll(
                '.definition-text, .scenario-resource-name, .details-scroll-label'
            )) {
                const content = label.querySelector('.kot-scroll-content');
                if (!(content instanceof HTMLElement)) {
                    continue;
                }
                const presentation = protocol.overflowPresentation(
                    content.scrollWidth,
                    label.clientWidth
                );
                label.classList.toggle('is-overflowing', presentation.overflowing);
                label.style.setProperty('--kot-overflow-distance', `${presentation.distance}px`);
                label.style.setProperty('--kot-overflow-duration', `${presentation.duration}s`);
            }
        }
    }

    function scheduleScenarioResourceLabelOverflowUpdate() {
        if (scenarioLabelOverflowFrame !== null) {
            return;
        }
        scenarioLabelOverflowFrame = requestAnimationFrame(() => {
            scenarioLabelOverflowFrame = null;
            updateScenarioResourceLabelOverflow();
        });
    }

    function completeResourceCollapse(expansionId, itemId) {
        pendingScenarioResourceAnimations.cancel(expansionId);
        scheduledScenarioResourceAnimations.delete(expansionId);
        state.expandedNodes.delete(expansionId);
        if (itemId) {
            watchedScenarioIds.delete(itemId);
            vscode.postMessage({
                command: 'setScenarioFilesExpanded',
                itemId,
                expanded: false
            });
        }
        saveState();
        renderResultsPreservingScroll();
    }

    function toggleScenarioResourceNode(node) {
        if (!node.expandable) {
            return;
        }
        const expanded = state.expandedNodes.has(node.id);
        if (expanded) {
            if (!collapseScenarioResourceBeforeRender(
                node.id,
                () => completeResourceCollapse(node.id)
            )) {
                completeResourceCollapse(node.id);
            }
            return;
        }
        state.expandedNodes.add(node.id);
        pendingScenarioResourceAnimations.request(node.id);
        if (!resourceChildrenByParent.has(node.id)) {
            requestScenarioFileChildren(node);
        }
        saveState();
        renderResultsPreservingScroll();
    }

    function openScenarioResourceNode(node) {
        if (node.kind === 'feature') {
            vscode.postMessage({
                command: 'openCompiledScenarioFeature',
                itemId: node.itemId
            });
            return;
        }
        if (node.kind === 'file') {
            vscode.postMessage({
                command: 'openScenarioFile',
                itemId: node.itemId,
                ...(node.resource ? { resource: node.resource } : {}),
                relativePath: node.relativePath
            });
        }
    }

    function runScenarioResourceContextAction(actionId, node) {
        if (actionId === 'open') {
            openScenarioResourceNode(node);
            return;
        }
        if (actionId === 'reveal') {
            vscode.postMessage({
                command: 'revealScenarioFile',
                itemId: node.itemId,
                ...(node.resource ? { resource: node.resource } : {}),
                relativePath: node.relativePath || ''
            });
            return;
        }
        if ((actionId === 'delete' || actionId === 'rename') && node.kind === 'file') {
            vscode.postMessage({
                command: actionId === 'rename' ? 'renameScenarioFile' : 'deleteScenarioFile',
                itemId: node.itemId,
                ...(node.resource ? { resource: node.resource } : {}),
                relativePath: node.relativePath
            });
        }
    }

    function showScenarioResourceContextMenu(event, node) {
        const actions = filesProtocol.scenarioResourceContextActions(node.kind, labels);
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

    function installResourceDropTarget(element, target) {
        element.addEventListener('dragover', event => {
            if (!event.dataTransfer?.types?.includes('Files')) {
                return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            element.classList.add('is-drop-target');
        });
        element.addEventListener('dragleave', event => {
            if (!element.contains(event.relatedTarget)) {
                element.classList.remove('is-drop-target');
            }
        });
        element.addEventListener('drop', event => {
            if (!event.dataTransfer) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            element.classList.remove('is-drop-target');
            void transferController.beginDrop(event.dataTransfer, target).catch(() => {
                announce(labels.resourceActionFailed);
            });
        });
    }

    function renderScenarioResourceNode(node, depth) {
        resourceNodesById.set(node.id, node);
        const branch = document.createElement('div');
        branch.className = 'scenario-resource-branch';
        const row = document.createElement('div');
        row.className = `scenario-resource-row kot-tree-row scenario-resource-${node.kind}`;
        row.dataset.nodeId = node.id;
        row.dataset.itemId = node.itemId;
        row.style.setProperty('--resource-depth', String(depth));
        row.setAttribute('role', 'treeitem');
        row.addEventListener('contextmenu', event => {
            showScenarioResourceContextMenu(event, node);
        });

        const expanded = node.expandable && state.expandedNodes.has(node.id);
        let disclosure;
        if (node.expandable) {
            disclosure = document.createElement('button');
            disclosure.type = 'button';
            disclosure.className = 'scenario-resource-disclosure codicon';
            disclosure.tabIndex = -1;
            disclosure.classList.add(expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
            disclosure.setAttribute('aria-label', node.name);
            disclosure.addEventListener('click', event => {
                event.stopPropagation();
                toggleScenarioResourceNode(node);
            });
        } else {
            disclosure = document.createElement('span');
            disclosure.className = 'scenario-resource-disclosure-spacer';
            disclosure.setAttribute('aria-hidden', 'true');
        }

        const icon = document.createElement('span');
        icon.className = `scenario-resource-icon codicon ${resourceIconClass(node)}`;
        const name = document.createElement('span');
        name.className = 'scenario-resource-name kot-tree-label';
        const nameContent = document.createElement('span');
        nameContent.className = 'scenario-resource-name-content kot-scroll-content';
        nameContent.textContent = node.name;
        name.append(nameContent);
        row.append(disclosure, icon, name);

        const actions = document.createElement('span');
        actions.className = 'scenario-resource-actions';
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'scenario-resource-action icon-button codicon codicon-folder-opened';
        reveal.title = labels.showInFileManager;
        reveal.setAttribute('aria-label', labels.showInFileManager);
        reveal.addEventListener('click', event => {
            event.stopPropagation();
            vscode.postMessage({
                command: 'revealScenarioFile',
                itemId: node.itemId,
                ...(node.resource ? { resource: node.resource } : {}),
                relativePath: node.relativePath || ''
            });
        });
        actions.append(reveal);
        if (node.kind === 'file') {
            const rename = document.createElement('button');
            rename.type = 'button'; rename.className = 'scenario-resource-action icon-button codicon codicon-edit';
            rename.title = labels.renameAttachment || 'Rename attachment'; rename.setAttribute('aria-label', rename.title);
            rename.addEventListener('click', event => { event.stopPropagation(); runScenarioResourceContextAction('rename', node); });
            actions.append(rename);
        }
        if (node.kind === 'feature') {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'scenario-resource-action icon-button codicon codicon-go-to-file';
            open.title = labels.openDefinition;
            open.setAttribute('aria-label', labels.openDefinition);
            open.addEventListener('click', event => {
                event.stopPropagation();
                openScenarioResourceNode(node);
            });
            actions.prepend(open);
        } else if (node.kind === 'file') {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'scenario-resource-action icon-button codicon codicon-link-external';
            open.title = labels.openExternally;
            open.setAttribute('aria-label', labels.openExternally);
            open.addEventListener('click', event => {
                event.stopPropagation();
                openScenarioResourceNode(node);
            });
            actions.prepend(open);
            row.draggable = true;
            row.addEventListener('dragstart', event => {
                filesProtocol.setEditorDragData(event, node);
            });
        }
        row.addEventListener('click', event => {
            const originatedFromButton = event.target instanceof Element
                && !!event.target.closest('button');
            const action = filesProtocol.scenarioResourceRowAction(
                node.kind,
                originatedFromButton
            );
            if (action === 'toggle') {
                event.preventDefault();
                toggleScenarioResourceNode(node);
            } else if (action === 'open') {
                event.preventDefault();
                openScenarioResourceNode(node);
            }
        });
        row.append(actions);
        if (node.kind === 'directory' || node.kind === 'attachments') {
            installResourceDropTarget(row, {
                itemId: node.itemId,
                ...(node.resource ? { resource: node.resource } : {}),
                relativePath: node.relativePath || ''
            });
        }
        branch.append(row);

        if (expanded) {
            if (!resourceChildrenByParent.has(node.id)) {
                requestScenarioFileChildren(node);
            }
            const childrenKnown = resourceChildrenByParent.has(node.id);
            const children = resourceChildrenByParent.get(node.id) || [];
            const childGroup = document.createElement('div');
            childGroup.className = pendingScenarioResourceAnimations.has(node.id)
                ? 'scenario-resource-children is-entering'
                : 'scenario-resource-children expanded';
            childGroup.dataset.resourceExpansionId = node.id;
            childGroup.setAttribute('role', 'group');
            if (children.length > 0) {
                for (const child of children) {
                    childGroup.append(renderScenarioResourceNode(child, depth + 1));
                }
            } else {
                const empty = document.createElement('div');
                empty.className = 'scenario-resource-empty';
                empty.style.setProperty('--resource-depth', String(depth + 1));
                if (childrenKnown) {
                    empty.textContent = labels.emptyDirectory;
                } else {
                    const spinner = document.createElement('span');
                    spinner.className = 'codicon codicon-loading codicon-modifier-spin';
                    empty.append(spinner);
                }
                childGroup.append(empty);
            }
            branch.append(childGroup);
        }
        return branch;
    }

    function scenarioExpansionId(itemId) {
        return `scenario-resources:${itemId}`;
    }

    function toggleDefinitionResources(item, resourcesExpanded) {
        const expansionId = scenarioExpansionId(item.id);
        if (resourcesExpanded) {
            if (!collapseScenarioResourceBeforeRender(
                expansionId,
                () => completeResourceCollapse(expansionId, item.id)
            )) {
                completeResourceCollapse(expansionId, item.id);
            }
            return;
        }
        state.expandedNodes.add(expansionId);
        pendingScenarioResourceAnimations.request(expansionId);
        saveState();
        renderResultsPreservingScroll();
    }

    function createDefinitionActionButton(command, iconName, label, item, disabled = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `definition-action icon-button codicon codicon-${iconName}`;
        button.title = label;
        button.setAttribute('aria-label', `${label}: ${item.displayText}`);
        button.disabled = disabled;
        button.addEventListener('click', event => {
            event.stopPropagation();
            if (button.disabled) {
                return;
            }
            if (command === 'insert') {
                requestInsert(item.id);
                return;
            }
            sendAction(command, item.id);
        });
        return button;
    }

    function createDefinitionRow(item) {
        const entry = document.createElement('div');
        entry.className = 'definition-entry';
        const row = document.createElement('div');
        row.className = 'definition-row kot-tree-row';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(item.id === state.selectedItemId));
        row.tabIndex = item.id === state.selectedItemId ? 0 : -1;
        row.dataset.itemId = item.id;
        featureActions.install(row, item);
        const isScenarioDefinition = ['main', 'process', 'nested', 'standalone'].includes(item.sourceGroup);
        if (isScenarioDefinition) {
            row.classList.add('is-scenario-definition');
        }
        const resourcesExpanded = item.hasScenarioFiles === true
            && state.expandedNodes.has(scenarioExpansionId(item.id));
        if (item.hasScenarioFiles === true) {
            const disclosure = document.createElement('button');
            disclosure.type = 'button';
            disclosure.className = 'definition-resource-disclosure codicon';
            disclosure.classList.add(resourcesExpanded
                ? 'codicon-chevron-down'
                : 'codicon-chevron-right');
            disclosure.title = labels.files;
            disclosure.setAttribute('aria-label', labels.files);
            disclosure.addEventListener('click', event => {
                event.stopPropagation();
                toggleDefinitionResources(item, resourcesExpanded);
            });
            row.append(disclosure);
        } else if (isScenarioDefinition) {
            const disclosureSpacer = document.createElement('span');
            disclosureSpacer.className = 'definition-resource-disclosure-spacer';
            disclosureSpacer.setAttribute('aria-hidden', 'true');
            row.append(disclosureSpacer);
        }
        const text = document.createElement('div');
        text.className = 'definition-text kot-tree-label';
        const textContent = document.createElement('span');
        textContent.className = 'definition-text-content kot-scroll-content';
        appendHighlightedText(textContent, item.displayText);
        text.append(textContent);
        const meta = document.createElement('div');
        meta.className = 'definition-meta';
        const source = document.createElement('span');
        const presentation = protocol.definitionPresentation(item, labels);
        source.className = 'definition-type';
        const icon = document.createElement('span');
        icon.className = `codicon codicon-${presentation.icon}`;
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = presentation.label;
        source.append(icon, label);
        const category = document.createElement('span');
        category.className = 'definition-category';
        category.textContent = categoryLabel(item);
        meta.append(source, category);
        const actions = document.createElement('span');
        actions.className = 'definition-actions kot-row-actions';
        const favorite = document.createElement('button');
        favorite.type = 'button';
        favorite.className = 'definition-action definition-favorite icon-button codicon';
        const isFavorite = state.favoriteItemIds.has(item.id);
        favorite.classList.add(isFavorite ? 'codicon-star-full' : 'codicon-star-empty');
        favorite.classList.toggle('is-favorite', isFavorite);
        favorite.title = isFavorite ? labels.removeFavorite : labels.addFavorite;
        favorite.setAttribute('aria-label', `${favorite.title}: ${item.displayText}`);
        favorite.addEventListener('click', event => {
            event.stopPropagation();
            vscode.postMessage({ command: 'toggleFavorite', itemId: item.id });
        });
        actions.classList.toggle('has-favorite', isFavorite);
        const actionButtons = new Map([['favorite', favorite]]);
        if (item.insertable !== false) {
            actionButtons.set('insert', createDefinitionActionButton('insert',
                'insert',
                labels.insert,
                item,
                !state.insertionTarget.available || state.pendingActions.has(`insert\0${item.id}`)
            ));
        }
        actionButtons.set('copy', createDefinitionActionButton('copy',
            'copy',
            labels.copy,
            item,
            state.pendingActions.has(`copy\0${item.id}`)
        ));
        if (item.navigable === true) {
            actionButtons.set('openDefinition', createDefinitionActionButton('openDefinition',
                'go-to-file',
                labels.openDefinition,
                item,
                state.pendingActions.has(`openDefinition\0${item.id}`)
            ));
        }
        for (const actionName of protocol.definitionRowActionOrder(item)) {
            const actionButton = actionButtons.get(actionName);
            if (actionButton) {
                actions.append(actionButton);
            }
        }
        if (item.featureId) {
            row.addEventListener('dblclick', () => featureActions.send('openFeature', item));
        }
        row.append(text, meta, actions);
        row.addEventListener('click', event => {
            const originatedFromInteractiveControl = event.target instanceof Element
                && !!event.target.closest('button, input, a');
            const action = filesProtocol.scenarioDefinitionRowAction(
                item.hasScenarioFiles === true,
                originatedFromInteractiveControl,
                false
            );
            if (action === 'none') {
                return;
            }
            selectItem(item.id, false, true);
        });
        if (!isScenarioDefinition) {
            row.addEventListener('dblclick', () => requestInsert(item.id));
        }
        renderedRowsById.set(item.id, row);
        if (item.id === state.selectedItemId) {
            selectedDefinitionRow = row;
        }
        if (item.hasScenarioFiles === true) {
            row.classList.add('has-scenario-resources');
            installResourceDropTarget(row, { itemId: item.id, relativePath: '', ...(item.sourceScenarioFilesRootUri ? { resource: 'source' } : {}) });
        }
        entry.append(row);
        if (resourcesExpanded) {
            if (!watchedScenarioIds.has(item.id)) {
                watchedScenarioIds.add(item.id);
                vscode.postMessage({
                    command: 'setScenarioFilesExpanded',
                    itemId: item.id,
                    expanded: true
                });
            }
            const resources = document.createElement('div');
            const expansionId = scenarioExpansionId(item.id);
            resources.className = pendingScenarioResourceAnimations.has(expansionId)
                ? 'scenario-resource-tree is-entering'
                : 'scenario-resource-tree expanded';
            resources.dataset.resourceExpansionId = expansionId;
            resources.setAttribute('role', 'tree');
            const root = {
                id: scenarioExpansionId(item.id),
                itemId: item.id,
                relativePath: '',
                depth: -1
            };
            const parents = resourceParentIdsByItem.get(item.id) || new Set();
            parents.add(root.id);
            let childrenKnown = true;
            let children;
            if (item.compiledFeatureUri && item.scenarioFilesRootUri) {
                children = filesProtocol.projectCompiledScenarioChildren({
                    ...item,
                    itemId: item.id,
                    depth: -1
                }, labels);
                for (const attachments of children.filter(node => node.kind === 'attachments')) {
                    parents.add(attachments.id);
                }
            } else {
                if (!resourceChildrenByParent.has(root.id)) {
                    requestScenarioFileChildren(root);
                }
                childrenKnown = resourceChildrenByParent.has(root.id);
                children = resourceChildrenByParent.get(root.id) || [];
            }
            resourceParentIdsByItem.set(item.id, parents);
            for (const child of children) {
                resources.append(renderScenarioResourceNode(child, 0));
            }
            if (childrenKnown && children.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'scenario-resource-empty';
                empty.style.setProperty('--resource-depth', '0');
                empty.textContent = labels.emptyDirectory;
                resources.append(empty);
            }
            entry.append(resources);
        }
        return entry;
    }

    function selectItem(itemId, focus, showDetails) {
        state.selectedItemId = itemId;
        saveState();
        if (selectedDefinitionRow) {
            selectedDefinitionRow.setAttribute('aria-selected', 'false');
            selectedDefinitionRow.tabIndex = -1;
        }
        selectedDefinitionRow = renderedRowsById.get(itemId) || null;
        if (selectedDefinitionRow) {
            selectedDefinitionRow.setAttribute('aria-selected', 'true');
            selectedDefinitionRow.tabIndex = 0;
            if (focus) {
                selectedDefinitionRow.focus();
            }
        }
        renderDetails();
        if (showDetails) {
            shell.classList.add('details-open');
        }
    }

    function renderResults(preserveVisibleCount = false) {
        const items = filteredItems();
        const nextResultIdentity = currentResultIdentity();
        if (nextResultIdentity !== resultIdentity) {
            resultIdentity = nextResultIdentity;
            if (!preserveVisibleCount) { visibleResultCount = BATCH_SIZE; }
        }
        resultCount.textContent = String(items.length);
        renderedRowsById.clear();
        selectedDefinitionRow = null;
        resultPager = null;
        definitionListContent.replaceChildren();
        definitionList.setAttribute('aria-busy', 'false');
        if (!state.snapshot || state.snapshot.items.length === 0) {
            setStatus(labels.noDefinitions);
            state.selectedItemId = null;
            renderDetails();
            return;
        }
        if (items.length === 0) {
            setStatus(labels.noResults);
            state.selectedItemId = null;
            renderDetails();
            return;
        }
        setStatus('');
        const selectedIndex = items.findIndex(item => item.id === state.selectedItemId);
        if (selectedIndex < 0) {
            state.selectedItemId = items[0].id;
            saveState();
        }
        resultPager = protocol.createResultPager(
            items,
            BATCH_SIZE,
            Math.max(visibleResultCount, selectedIndex + 1)
        );
        appendNextResultBatch();
        renderDetails();
        for (const container of definitionListContent.querySelectorAll(
            '.is-entering[data-resource-expansion-id]'
        )) {
            animateScenarioResourceExpansion(container.dataset.resourceExpansionId || '');
        }
        scheduleScenarioResourceLabelOverflowUpdate();
    }

    function renderResultsPreservingScroll() {
        protocol.preserveScrollPosition(definitionList, () => renderResults());
    }

    function appendNextResultBatch() {
        if (!resultPager?.hasMore) {
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const item of resultPager.next()) {
            fragment.append(createDefinitionRow(item));
        }
        definitionListContent.append(fragment);
        visibleResultCount = definitionListContent.querySelectorAll(':scope > .definition-entry').length;
        scheduleScenarioResourceLabelOverflowUpdate();
    }

    function createDetailsScrollLabel(value, highlight) {
        const label = document.createElement('span');
        label.className = 'details-scroll-label kot-tree-label';
        const content = document.createElement('span');
        content.className = 'kot-scroll-content';
        if (highlight) {
            appendHighlightedText(content, value);
        } else {
            content.textContent = value;
        }
        label.append(content);
        return label;
    }

    function addDetailsField(labelText, value, code, scrollable = false) {
        const field = document.createElement('section');
        field.className = 'details-field';
        const label = document.createElement('span');
        label.className = 'details-label';
        label.textContent = labelText;
        const content = document.createElement(code ? 'pre' : 'p');
        content.className = code ? 'details-code' : 'details-value';
        if (scrollable) {
            content.append(createDetailsScrollLabel(value, code));
        } else if (code) {
            appendHighlightedText(content, value);
        } else {
            content.textContent = value;
        }
        field.append(label, content);
        detailsContent.append(field);
    }

    function renderDetailsResourceNode(node, depth) {
        resourceNodesById.set(node.id, node);
        const branch = document.createElement('div');
        branch.className = 'details-resource-branch';
        const row = document.createElement('div');
        row.className = `scenario-resource-row kot-tree-row details-resource-row scenario-resource-${node.kind}`;
        row.style.setProperty('--resource-depth', String(depth));
        row.setAttribute('role', 'treeitem');
        row.addEventListener('contextmenu', event => {
            showScenarioResourceContextMenu(event, node);
        });

        const isContainer = node.kind === 'attachments' || node.kind === 'directory';
        const expanded = isContainer && detailsExpandedResourceIds.has(node.id);
        if (isContainer) {
            const disclosure = document.createElement('button');
            disclosure.type = 'button';
            disclosure.className = 'scenario-resource-disclosure codicon';
            disclosure.classList.add(expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
            disclosure.setAttribute('aria-expanded', String(expanded));
            disclosure.setAttribute('aria-label', node.name);
            disclosure.addEventListener('click', event => {
                event.stopPropagation();
                if (expanded) {
                    detailsExpandedResourceIds.delete(node.id);
                } else {
                    detailsExpandedResourceIds.add(node.id);
                    if (!resourceChildrenByParent.has(node.id)) {
                        requestScenarioFileChildren(node);
                    }
                }
                renderDetails();
            });
            row.append(disclosure);
        } else {
            const spacer = document.createElement('span');
            spacer.className = 'scenario-resource-disclosure-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            row.append(spacer);
        }

        const icon = document.createElement('span');
        icon.className = `scenario-resource-icon codicon ${resourceIconClass(node)}`;
        const name = document.createElement('span');
        name.className = 'scenario-resource-name kot-tree-label';
        const nameContent = document.createElement('span');
        nameContent.className = 'scenario-resource-name-content kot-scroll-content';
        nameContent.textContent = node.name;
        name.append(nameContent);
        row.append(icon, name);

        const actions = document.createElement('span');
        actions.className = 'scenario-resource-actions';
        if (node.kind === 'feature' || node.kind === 'file') {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = `scenario-resource-action icon-button codicon ${node.kind === 'feature' ? 'codicon-go-to-file' : 'codicon-link-external'}`;
            open.title = node.kind === 'feature' ? labels.openDefinition : labels.openExternally;
            open.setAttribute('aria-label', open.title);
            open.addEventListener('click', event => {
                event.stopPropagation();
                openScenarioResourceNode(node);
            });
            actions.append(open);
        }
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'scenario-resource-action icon-button codicon codicon-folder-opened';
        reveal.title = labels.showInFileManager;
        reveal.setAttribute('aria-label', labels.showInFileManager);
        reveal.addEventListener('click', event => {
            event.stopPropagation();
            vscode.postMessage({
                command: 'revealScenarioFile',
                itemId: node.itemId,
                ...(node.resource ? { resource: node.resource } : {}),
                relativePath: node.relativePath || ''
            });
        });
        actions.append(reveal);
        if (node.kind === 'file') {
            const rename = document.createElement('button');
            rename.type = 'button'; rename.className = 'scenario-resource-action icon-button codicon codicon-edit';
            rename.title = labels.renameAttachment || 'Rename attachment'; rename.setAttribute('aria-label', rename.title);
            rename.addEventListener('click', event => { event.stopPropagation(); runScenarioResourceContextAction('rename', node); });
            actions.append(rename);
        }
        row.append(actions);

        if (node.kind === 'feature' || node.kind === 'file') {
            row.classList.add('is-openable');
            row.addEventListener('click', event => {
                if (event.target instanceof Element && event.target.closest('button')) {
                    return;
                }
                openScenarioResourceNode(node);
            });
        }
        if (node.kind === 'file') {
            row.draggable = true;
            row.addEventListener('dragstart', event => filesProtocol.setEditorDragData(event, node));
        }
        if (isContainer) {
            installResourceDropTarget(row, {
                itemId: node.itemId,
                ...(node.resource ? { resource: node.resource } : {}),
                relativePath: node.relativePath || ''
            });
        }
        branch.append(row);

        if (expanded) {
            const childGroup = document.createElement('div');
            childGroup.className = 'details-resource-children';
            childGroup.setAttribute('role', 'group');
            const childrenKnown = resourceChildrenByParent.has(node.id);
            const children = resourceChildrenByParent.get(node.id) || [];
            if (!childrenKnown) {
                requestScenarioFileChildren(node);
            }
            if (children.length > 0) {
                for (const child of children) {
                    childGroup.append(renderDetailsResourceNode(child, depth + 1));
                }
            } else {
                const empty = document.createElement('div');
                empty.className = 'scenario-resource-empty';
                empty.style.setProperty('--resource-depth', String(depth + 1));
                if (childrenKnown) {
                    empty.textContent = labels.emptyDirectory;
                } else {
                    const spinner = document.createElement('span');
                    spinner.className = 'codicon codicon-loading codicon-modifier-spin';
                    empty.append(spinner);
                }
                childGroup.append(empty);
            }
            branch.append(childGroup);
        }
        return branch;
    }

    function renderDetailsResources(item) {
        if (item.hasScenarioFiles !== true) {
            return;
        }
        const section = document.createElement('section');
        section.className = 'details-field details-resources';
        const label = document.createElement('span');
        label.className = 'details-label';
        label.textContent = labels.files;
        const list = document.createElement('div');
        list.className = 'details-resource-list';
        list.setAttribute('role', 'tree');
        installResourceDropTarget(list, { itemId: item.id, relativePath: '', ...(item.sourceScenarioFilesRootUri ? { resource: 'source' } : {}) });

        if (item.compiledFeatureUri && item.scenarioFilesRootUri) {
            const projected = filesProtocol.projectCompiledScenarioChildren({ ...item, itemId: item.id, depth: -1 }, labels);
            const parents = resourceParentIdsByItem.get(item.id) || new Set();
            for (const node of projected) {
                if (node.expandable) { parents.add(node.id); }
                list.append(renderDetailsResourceNode(node, 0));
            }
            resourceParentIdsByItem.set(item.id, parents);
        } else {
            const root = {
                id: scenarioExpansionId(item.id),
                itemId: item.id,
                relativePath: '',
                depth: -1
            };
            resourceNodesById.set(root.id, root);
            const parents = resourceParentIdsByItem.get(item.id) || new Set();
            parents.add(root.id);
            resourceParentIdsByItem.set(item.id, parents);
            if (!resourceChildrenByParent.has(root.id)) {
                requestScenarioFileChildren(root);
            }
            const childrenKnown = resourceChildrenByParent.has(root.id);
            const children = resourceChildrenByParent.get(root.id) || [];
            for (const child of children) {
                list.append(renderDetailsResourceNode(child, 0));
            }
            if (children.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'scenario-resource-empty';
                empty.style.setProperty('--resource-depth', '0');
                if (childrenKnown) {
                    empty.textContent = labels.emptyDirectory;
                } else {
                    const spinner = document.createElement('span');
                    spinner.className = 'codicon codicon-loading codicon-modifier-spin';
                    empty.append(spinner);
                }
                list.append(empty);
            }
        }
        section.append(label, list);
        detailsContent.append(section);
        scheduleScenarioResourceLabelOverflowUpdate();
    }

    function renderProcessSteps(item) {
        if (!item.processUri || !Array.isArray(item.processSteps)) { return; }
        const dragType = 'application/vnd.kot.process-step';
        const pendingKey = `processSteps\0${item.id}`;
        const pending = state.pendingActions.has(pendingKey);
        const identity = state.snapshot?.viewIdentity;
        const uidCounts = new Map();
        for (const step of item.processSteps) {
            const uid = String(step.uid || '').trim().toLowerCase();
            uidCounts.set(uid, (uidCounts.get(uid) || 0) + 1);
        }
        const editable = Boolean(item.processUid && item.processStepsSignature && identity)
            && item.processSteps.every(step => step.uid && uidCounts.get(step.uid.trim().toLowerCase()) === 1);
        const section = document.createElement('section');
        section.className = 'details-field process-steps';
        const header = document.createElement('div');
        header.className = 'process-steps-header';
        const heading = document.createElement('span');
        heading.className = 'details-label'; heading.textContent = labels.processSteps;
        const add = document.createElement('button');
        add.type = 'button'; add.className = 'icon-button codicon codicon-add';
        add.dataset.action = 'addProcessSteps'; add.title = labels.addProcessSteps;
        add.setAttribute('aria-label', labels.addProcessSteps); add.disabled = pending || !editable;
        header.append(heading, add); section.append(header);
        const list = document.createElement('ol'); list.className = 'process-step-list';
        let dragging = null;
        const send = (command, extra) => {
            if (!editable || state.pendingActions.has(pendingKey) || state.snapshot?.viewIdentity !== identity) { return; }
            state.pendingActions.add(pendingKey); renderDetails();
            vscode.postMessage({ command, itemId: item.id, processUri: item.processUri, processUid: item.processUid,
                viewIdentity: identity, stepsSignature: item.processStepsSignature, ...extra });
        };
        const reorder = (stepUid, beforeStepUid) => {
            const from = item.processSteps.findIndex(step => step.uid === stepUid);
            const before = beforeStepUid === null ? item.processSteps.length : item.processSteps.findIndex(step => step.uid === beforeStepUid);
            if (from < 0 || before < 0 || before === from || before === from + 1) { return; }
            send('reorderProcessStep', { stepUid, beforeStepUid });
        };
        const clearDropTargets = () => {
            for (const row of list.querySelectorAll('.process-step-row')) { row.classList.remove('is-drop-before', 'is-drop-after'); }
            list.classList.remove('is-drop-end');
        };
        const readDrag = event => {
            if (!editable || pending || !dragging || state.snapshot?.viewIdentity !== identity
                || !Array.from(event.dataTransfer?.types || []).includes(dragType)) { return null; }
            return dragging;
        };
        add.addEventListener('click', () => { if (!add.disabled) { send('addProcessSteps', {}); } });
        if (!item.processSteps.length) {
            const empty = document.createElement('p'); empty.className = 'details-value'; empty.textContent = labels.emptyProcessSteps; section.append(empty);
        }
        item.processSteps.forEach((step, index) => {
            const row = document.createElement('li'); row.className = 'process-step-row'; row.dataset.stepUid = step.uid || '';
            row.tabIndex = 0; row.draggable = editable && !pending;
            const handle = document.createElement('span'); handle.className = 'process-step-drag codicon codicon-gripper';
            handle.title = labels.dragProcessStep; handle.setAttribute('aria-hidden', 'true');
            const number = document.createElement('span'); number.className = 'process-step-number'; number.textContent = String(index + 1);
            const content = document.createElement('div'); content.className = 'process-step-content';
            const name = document.createElement('span'); name.className = 'process-step-name';
            name.textContent = step.name || step.scenarioName || step.processName || step.uid || '';
            const kind = document.createElement('span'); kind.className = 'process-step-kind';
            kind.textContent = step.type === 'process' ? labels.processStep : labels.scenarioStep;
            content.append(name, kind);
            row.setAttribute('aria-label', `${number.textContent}. ${name.textContent}. ${labels.dragProcessStep}`);
            const remove = document.createElement('button'); remove.type = 'button';
            remove.className = 'icon-button codicon codicon-trash'; remove.dataset.action = 'removeProcessStep';
            remove.title = labels.removeProcessStep; remove.setAttribute('aria-label', `${labels.removeProcessStep}: ${name.textContent}`);
            remove.disabled = pending || !editable;
            remove.addEventListener('click', () => { if (!remove.disabled) { send('removeProcessStep', { stepUid: step.uid }); } });
            row.addEventListener('dragstart', event => {
                if (!row.draggable || !event.dataTransfer || event.target.closest('button')) { event.preventDefault(); return; }
                event.stopPropagation(); dragging = { stepUid: step.uid };
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(dragType, JSON.stringify({ processUri: item.processUri, processUid: item.processUid, stepUid: step.uid, stepsSignature: item.processStepsSignature }));
                row.classList.add('is-dragging');
            });
            row.addEventListener('dragend', () => { dragging = null; row.classList.remove('is-dragging'); clearDropTargets(); });
            row.addEventListener('dragover', event => {
                if (!readDrag(event)) { return; }
                event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; clearDropTargets();
                const rect = row.getBoundingClientRect();
                row.classList.add(event.clientY >= rect.top + rect.height / 2 ? 'is-drop-after' : 'is-drop-before');
            });
            row.addEventListener('dragleave', () => row.classList.remove('is-drop-before', 'is-drop-after'));
            row.addEventListener('drop', event => {
                const payload = readDrag(event); if (!payload) { return; }
                event.preventDefault(); event.stopPropagation(); clearDropTargets();
                const rect = row.getBoundingClientRect();
                const after = event.clientY >= rect.top + rect.height / 2;
                reorder(payload.stepUid, after ? item.processSteps[index + 1]?.uid || null : step.uid);
            });
            row.addEventListener('keydown', event => {
                if (event.target !== row || !editable || pending || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) { return; }
                event.preventDefault();
                if (event.key === 'ArrowUp' && index > 0) { reorder(step.uid, item.processSteps[index - 1].uid); }
                if (event.key === 'ArrowDown' && index < item.processSteps.length - 1) { reorder(step.uid, item.processSteps[index + 2]?.uid || null); }
            });
            row.append(handle, number, content, remove); list.append(row);
        });
        list.addEventListener('dragover', event => {
            if (!readDrag(event)) { return; }
            event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; clearDropTargets(); list.classList.add('is-drop-end');
        });
        list.addEventListener('dragleave', () => list.classList.remove('is-drop-end'));
        list.addEventListener('drop', event => {
            const payload = readDrag(event); if (!payload) { return; }
            event.preventDefault(); event.stopPropagation(); clearDropTargets(); reorder(payload.stepUid, null);
        });
        section.append(list); detailsContent.append(section);
    }

    function renderDetails() {
        detailsContent.replaceChildren();
        const item = state.selectedItemId
            ? snapshotItemsById.get(state.selectedItemId)
            : undefined;
        const insertPending = item && state.pendingActions.has(`insert\0${item.id}`);
        const copyPending = item && state.pendingActions.has(`copy\0${item.id}`);
        const openPending = item && state.pendingActions.has(`openDefinition\0${item.id}`);
        insertButton.classList.toggle('hidden', Boolean(item?.featureId));
        insertButton.disabled = !protocol.canInsertItem(
            item,
            state.insertionTarget.available
        ) || insertPending;
        copyButton.disabled = !item || copyPending;
        openDefinitionButton.disabled = !item || !item.navigable || openPending;
        favoriteButton.disabled = !item;
        if (convertFormatButton) { convertFormatButton.hidden = !item || !['mainScenario', 'process', 'nestedScenario', 'exportScenario'].includes(item.kind) || !/\.(?:ya?ml|feature)$/iu.test(item.capturedLocation?.uri || ''); convertFormatButton.disabled = !item; }
        if (!item) {
            const empty = document.createElement('p');
            empty.className = 'empty-details';
            empty.textContent = labels.selectDefinition;
            detailsContent.append(empty);
            return;
        }
        const isFavorite = state.favoriteItemIds.has(item.id);
        favoriteButton.title = isFavorite ? labels.removeFavorite : labels.addFavorite;
        favoriteButton.setAttribute('aria-label', favoriteButton.title);
        favoriteButton.firstElementChild.className = `codicon ${isFavorite ? 'codicon-star-full' : 'codicon-star-empty'}`;
        const title = document.createElement('h3');
        title.append(createDetailsScrollLabel(item.displayText, true));
        detailsContent.append(title);
        addDetailsField(labels.definitionType || 'Type', protocol.definitionPresentation(item, labels).label, false);
        addDetailsField(
            labels.sourceLabel,
            item.sourceLabel || sourceLabel(item.sourceGroup),
            false,
            true
        );
        addDetailsField(labels.categoryLabel, categoryLabel(item), false, true);
        renderProcessSteps(item);
        if (item.featureId) {
            if (item.jsonPath) { addDetailsField(featureLabels.openJson || 'Launch JSON', item.jsonPath, false, true); }
            const actions = document.createElement('div');
            actions.className = 'feature-details-actions';
            for (const action of ['generateJson', 'selectJson', 'openJson', 'moveFeature']) {
                const button = document.createElement('button');
                button.type = 'button'; button.textContent = featureLabels[action];
                button.dataset.action = action;
                button.addEventListener('click', () => featureActions.send(action, item));
                actions.append(button);
            }
            detailsContent.append(actions);
        }
        if (item.scenarioCode) {
            addDetailsField(labels.scenarioCodeLabel, item.scenarioCode, true, true);
        }
        if (item.description) {
            addDetailsField(labels.descriptionLabel, item.description);
        }
        if (item.parameters && item.parameters.length > 0) {
            const values = item.parameters.map(parameter => parameter.defaultValue === undefined
                ? parameter.name
                : `${parameter.name} = ${parameter.defaultValue}`
            ).join('\n');
            addDetailsField(labels.parametersLabel, values, true, true);
        }
        if (item.alternateDisplayText) {
            addDetailsField(labels.translationLabel, item.alternateDisplayText, true, true);
        }
        addDetailsField(
            labels.templateLabel,
            item.templateDisplayText || item.template,
            true,
            true
        );
        renderDetailsResources(item);
        if (item.insertable !== false && !state.insertionTarget.available) {
            const targetHint = document.createElement('p');
            targetHint.className = 'target-hint';
            targetHint.textContent = labels.insertionUnavailable;
            detailsContent.append(targetHint);
        } else if (item.insertable === false && !item.featureId) {
            const targetHint = document.createElement('p');
            targetHint.className = 'target-hint';
            targetHint.textContent = item.kind === 'process' ? labels.processNotInsertable : labels.itemNotInsertable;
            detailsContent.append(targetHint);
        }
    }

    function sendAction(command, itemId) {
        const key = `${command}\0${itemId}`;
        if (state.pendingActions.has(key)) {
            return;
        }
        state.pendingActions.add(key);
        renderDetails();
        vscode.postMessage({ command, itemId });
    }

    function requestInsert(itemId) {
        const item = snapshotItemsById.get(itemId);
        if (item?.featureId) {
            featureActions.send('openFeature', item);
            return;
        }
        if (!protocol.canInsertItem(item, state.insertionTarget.available)) {
            shell.classList.add('details-open');
            announce(item?.insertable === false
                ? item.kind === 'process' ? labels.processNotInsertable : labels.itemNotInsertable
                : labels.insertionUnavailable);
            return;
        }
        sendAction('insert', itemId);
    }

    function moveListFocus(key) {
        const rows = [...definitionList.querySelectorAll('[role="option"]')];
        if (rows.length === 0) {
            return;
        }
        const activeIndex = Math.max(0, rows.indexOf(document.activeElement));
        let nextIndex = activeIndex;
        if (key === 'ArrowDown') {
            nextIndex = Math.min(rows.length - 1, activeIndex + 1);
        } else if (key === 'ArrowUp') {
            nextIndex = Math.max(0, activeIndex - 1);
        } else if (key === 'Home') {
            nextIndex = 0;
        } else if (key === 'End') {
            nextIndex = rows.length - 1;
        }
        selectItem(rows[nextIndex].dataset.itemId, true);
    }

    function moveTreeFocus(key) {
        const nodes = [...categoryTree.querySelectorAll('[role="treeitem"]')]
            .filter(node => node.offsetParent !== null);
        if (nodes.length === 0) {
            return;
        }
        const activeIndex = Math.max(0, nodes.indexOf(document.activeElement));
        let nextIndex = activeIndex;
        if (key === 'ArrowDown') {
            nextIndex = Math.min(nodes.length - 1, activeIndex + 1);
        } else if (key === 'ArrowUp') {
            nextIndex = Math.max(0, activeIndex - 1);
        } else if (key === 'Home') {
            nextIndex = 0;
        } else if (key === 'End') {
            nextIndex = nodes.length - 1;
        }
        nodes[nextIndex].focus();
    }

    function expandOrCollapseTreeNode(key) {
        const active = document.activeElement;
        const nodeId = active?.dataset.nodeId;
        if (!nodeId) {
            return;
        }
        const expanded = active.getAttribute('aria-expanded');
        if (key === 'ArrowRight') {
            if (expanded === 'false') {
                toggleTreeNode(nodeId);
                return;
            }
            if (expanded === 'true') {
                active.parentElement?.querySelector('.tree-children [role="treeitem"]')?.focus();
            }
            return;
        }
        if (expanded === 'true') {
            toggleTreeNode(nodeId);
            return;
        }
        const parentGroup = active.closest('.tree-children');
        parentGroup?.parentElement?.querySelector(':scope > [role="treeitem"]')?.focus();
    }

    let searchTimer;
    function updateSearchClearButton() {
        const hasValue = searchInput.value.length > 0;
        searchClearButton.classList.toggle('hidden', !hasValue);
        searchClearButton.disabled = !hasValue;
    }

    searchInput.value = state.query;
    updateSearchClearButton();
    languageFilter.value = state.language;
    sortMode.value = state.sortMode;
    paneResizers.forEach(setupPaneResizer);
    requestAnimationFrame(() => applyPaneLayout(state.paneLayout, false));
    const scenarioResourceLabelResizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(scheduleScenarioResourceLabelOverflowUpdate)
        : null;
    if (scenarioResourceLabelResizeObserver) {
        scenarioResourceLabelResizeObserver.observe(libraryGrid);
        scenarioResourceLabelResizeObserver.observe(definitionListContent);
        scenarioResourceLabelResizeObserver.observe(detailsContent);
    }
    const refreshHoveredScenarioLabelOverflow = event => {
        if (
            event.target instanceof Element
            && event.target.closest('.kot-tree-row, .details-scroll-label')
        ) {
            scheduleScenarioResourceLabelOverflowUpdate();
        }
    };
    definitionListContent.addEventListener('mouseover', refreshHoveredScenarioLabelOverflow);
    definitionListContent.addEventListener('mouseout', refreshHoveredScenarioLabelOverflow);
    detailsContent.addEventListener('mouseover', refreshHoveredScenarioLabelOverflow);
    detailsContent.addEventListener('mouseout', refreshHoveredScenarioLabelOverflow);
    window.addEventListener('resize', () => {
        applyPaneLayout(state.paneLayout, false);
        scheduleScenarioResourceLabelOverflowUpdate();
    });
    searchInput.addEventListener('input', () => {
        state.query = searchInput.value;
        updateSearchClearButton();
        saveState();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            renderResults();
        }, 80);
    });
    searchClearButton.addEventListener('click', () => {
        if (!searchInput.value) {
            return;
        }
        searchInput.value = '';
        state.query = '';
        updateSearchClearButton();
        saveState();
        clearTimeout(searchTimer);
        renderResults();
        searchInput.focus();
    });
    languageFilter.addEventListener('change', () => {
        state.language = languageFilter.value;
        reconcileFiltersAndSelection();
        renderTree();
        renderResults();
    });
    sortMode.addEventListener('change', () => {
        state.sortMode = sortMode.value;
        saveState();
        renderResults();
    });
    refreshButton.addEventListener('click', () => {
        refreshButton.disabled = true;
        vscode.postMessage({ command: 'refresh' });
    });
    createButton.addEventListener('click', () => {
        vscode.postMessage({ command: 'create' });
    });
    categoryToggle.addEventListener('click', () => {
        shell.classList.add('categories-open');
        categoryTree.querySelector('[role="treeitem"]')?.focus();
    });
    categoryBack.addEventListener('click', () => {
        shell.classList.remove('categories-open');
        categoryToggle.focus();
    });
    detailsBack.addEventListener('click', () => {
        shell.classList.remove('details-open');
        definitionList.querySelector('[aria-selected="true"]')?.focus();
    });
    definitionList.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && state.selectedItemId) {
            event.preventDefault();
            sendAction('copy', state.selectedItemId);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            moveListFocus(event.key);
        } else if (event.key === 'Enter' && state.selectedItemId) {
            event.preventDefault();
            requestInsert(state.selectedItemId);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            searchInput.focus();
        }
    });
    definitionList.addEventListener('scroll', () => {
        if (resultScrollFrame !== null) {
            return;
        }
        resultScrollFrame = requestAnimationFrame(() => {
            resultScrollFrame = null;
            const remaining = definitionList.scrollHeight
                - definitionList.scrollTop
                - definitionList.clientHeight;
            if (remaining < 480) {
                appendNextResultBatch();
            }
        });
    });
    categoryTree.addEventListener('keydown', event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            moveTreeFocus(event.key);
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            expandOrCollapseTreeNode(event.key);
        } else if (event.key === 'Enter' && document.activeElement?.dataset.nodeId) {
            event.preventDefault();
            document.activeElement.click();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            shell.classList.remove('categories-open');
            definitionList.focus();
        }
    });
    insertButton.addEventListener('click', () => {
        if (state.selectedItemId) {
            requestInsert(state.selectedItemId);
        }
    });
    copyButton.addEventListener('click', () => {
        if (state.selectedItemId) {
            sendAction('copy', state.selectedItemId);
        }
    });
    convertFormatButton?.addEventListener('click', () => { if (state.selectedItemId) { sendAction('convertFormat', state.selectedItemId); } });
    openDefinitionButton.addEventListener('click', () => {
        if (state.selectedItemId) {
            sendAction('openDefinition', state.selectedItemId);
        }
    });
    favoriteButton.addEventListener('click', () => {
        if (state.selectedItemId) {
            vscode.postMessage({ command: 'toggleFavorite', itemId: state.selectedItemId });
        }
    });

    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message !== 'object') {
            return;
        }
        closeScenarioResourceContextMenu();
        featureActions.closeMenu();
        if (message.command === 'standaloneFeatureActionResult') {
            if (message.succeeded === false) { announce(message.message || labels.actionFailed); }
            return;
        }
        if (message.command === 'loading') {
            definitionList.setAttribute('aria-busy', 'true');
            setStatus(labels.loading);
            return;
        }
        if (message.command === 'snapshot' && message.snapshot) {
            const active = document.activeElement;
            const focusedFeature = active instanceof HTMLElement && definitionListContent.contains(active)
                && active.classList.contains('definition-row') && active.dataset.featureId ? active : null;
            const previousRows = [...definitionListContent.querySelectorAll('[role="option"]')];
            const focusedIndex = focusedFeature ? previousRows.indexOf(focusedFeature) : -1;
            const focusedItemId = focusedFeature?.dataset.itemId;
            const listScroll = { top: definitionList.scrollTop, left: definitionList.scrollLeft };
            const previousFilter = JSON.stringify([state.query, state.favoritesOnly, state.sourceGroup,
                state.sourceGroup === 'standalone' ? state.groupId : state.categoryPath,
                state.uncategorized, state.language, state.sortMode]);
            const preparedItems = state.snapshot?.viewIdentity === message.snapshot.viewIdentity
                ? state.snapshot.items
                : protocol.prepareItems(message.snapshot.items);
            state.snapshot = {
                ...message.snapshot,
                items: preparedItems
            };
            snapshotItemsById = new Map(preparedItems.map(item => [item.id, item]));
            resourceChildrenByParent.clear();
            resourceNodesById.clear();
            resourceParentIdsByItem.clear();
            requestedResourceNodes.clear();
            watchedScenarioIds.clear();
            pendingScenarioResourceAnimations.clear();
            scheduledScenarioResourceAnimations.clear();
            state.insertionTarget = message.insertionTarget || {
                available: false,
                identity: 'unavailable'
            };
            state.favoriteItemIds = new Set(Array.isArray(message.favoriteItemIds)
                ? message.favoriteItemIds
                : []);
            reconcileFiltersAndSelection();
            const sameFilter = previousFilter === JSON.stringify([state.query, state.favoritesOnly, state.sourceGroup,
                state.sourceGroup === 'standalone' ? state.groupId : state.categoryPath,
                state.uncategorized, state.language, state.sortMode]);
            refreshButton.disabled = false;
            renderTree();
            renderResults(sameFilter);
            if (focusedFeature && sameFilter) {
                const rows = [...definitionListContent.querySelectorAll('[role="option"]')];
                const target = rows.find(row => row.dataset.itemId === focusedItemId)
                    || rows[Math.min(focusedIndex, rows.length - 1)];
                if (target) {
                    selectItem(target.dataset.itemId, false);
                    target.focus({ preventScroll: true });
                } else {
                    definitionList.focus({ preventScroll: true });
                }
            }
            if (sameFilter) {
                definitionList.scrollTop = listScroll.top;
                definitionList.scrollLeft = listScroll.left;
            }
            announce(`${message.snapshot.items.length}`);
            return;
        }
        if (transferController.handleMessage(message)) {
            return;
        }
        if (message.command === 'scenarioFileChildren') {
            const expandedInResults = state.expandedNodes.has(message.requestId);
            requestedResourceNodes.delete(message.requestId);
            const parentDepth = resourceNodesById.get(message.requestId)?.depth ?? -1;
            resourceChildrenByParent.set(
                message.requestId,
                filesProtocol.projectDirectChildren(parentDepth, message.nodes)
            );
            const parents = resourceParentIdsByItem.get(message.itemId) || new Set();
            parents.add(message.requestId);
            resourceParentIdsByItem.set(message.itemId, parents);
            if (expandedInResults) {
                pendingScenarioResourceAnimations.request(message.requestId);
            }
            const renderTarget = filesProtocol.scenarioFileChildrenRenderTarget(
                expandedInResults,
                state.selectedItemId === message.itemId
            );
            if (renderTarget === 'results') {
                renderResultsPreservingScroll();
            } else if (renderTarget === 'details') {
                renderDetails();
            }
            return;
        }
        if (message.command === 'scenarioFileInvalidated') {
            for (const parentId of resourceParentIdsByItem.get(message.itemId) || []) {
                resourceChildrenByParent.delete(parentId);
                requestedResourceNodes.delete(parentId);
            }
            resourceParentIdsByItem.delete(message.itemId);
            renderResultsPreservingScroll();
            return;
        }
        if (message.command === 'scenarioFileTransferFailed') {
            if (message.requestId) {
                requestedResourceNodes.delete(message.requestId);
            }
            announce(message.message || labels.resourceActionFailed);
            return;
        }
        if (message.command === 'scenarioFileActionResult') {
            if ((message.action === 'delete' || message.action === 'rename') && message.succeeded) {
                for (const parentId of resourceParentIdsByItem.get(message.itemId) || []) {
                    resourceChildrenByParent.delete(parentId);
                    requestedResourceNodes.delete(parentId);
                }
                resourceParentIdsByItem.delete(message.itemId);
                renderResultsPreservingScroll();
                if (state.selectedItemId === message.itemId) {
                    renderDetails();
                }
            } else if (!message.succeeded && !message.cancelled) {
                announce(labels.resourceActionFailed);
            }
            return;
        }
        if (message.command === 'error') {
            refreshButton.disabled = false;
            const detail = typeof message.message === 'string' ? ` ${message.message}` : '';
            setStatus(`${labels.loadFailed}${detail}`, 'error');
            announce(`${labels.loadFailed}${detail}`);
            return;
        }
        if (message.command === 'actionResult' && typeof message.itemId === 'string') {
            const key = `${message.action}\0${message.itemId}`;
            state.pendingActions.delete(key);
            if (['moveProcessStep', 'reorderProcessStep', 'removeProcessStep', 'addProcessSteps'].includes(message.action)) {
                state.pendingActions.delete(`processSteps\0${message.itemId}`);
            }
            renderDetails();
            if (message.action === 'deleteDefinition' && !message.message) { return; }
            const successLabels = {
                insert: labels.inserted,
                copy: labels.copied,
                openDefinition: labels.opened,
                moveProcessStep: labels.processStepMoved,
                reorderProcessStep: labels.processStepMoved,
                removeProcessStep: labels.processStepRemoved
            };
            announce(message.success ? successLabels[message.action]
                : message.message || (['moveProcessStep', 'reorderProcessStep'].includes(message.action) ? labels.processStepMoveFailed : labels.actionFailed));
        }
    });

    setStatus(labels.loading);
    vscode.postMessage({ command: 'ready' });
    window.addEventListener('beforeunload', () => transferController.dispose());
}());
