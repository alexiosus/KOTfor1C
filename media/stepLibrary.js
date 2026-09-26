(function startStepLibraryClient() {
    'use strict';

    const vscode = acquireVsCodeApi();
    const protocol = globalThis.StepLibraryProtocol;
    const BATCH_SIZE = 100;
    const shell = document.querySelector('.library-shell');
    const searchInput = document.getElementById('searchInput');
    const languageFilter = document.getElementById('languageFilter');
    const sortMode = document.getElementById('sortMode');
    const refreshButton = document.getElementById('refreshButton');
    const categoryToggle = document.getElementById('categoryToggle');
    const categoryBack = document.getElementById('categoryBack');
    const detailsBack = document.getElementById('detailsBack');
    const categoryTree = document.getElementById('categoryTree');
    const statusMessage = document.getElementById('statusMessage');
    const definitionList = document.getElementById('definitionList');
    const resultCount = document.getElementById('resultCount');
    const detailsContent = document.getElementById('detailsContent');
    const insertButton = document.getElementById('insertButton');
    const copyButton = document.getElementById('copyButton');
    const openDefinitionButton = document.getElementById('openDefinitionButton');
    const liveRegion = document.getElementById('liveRegion');
    const labels = document.body.dataset;
    const persisted = vscode.getState() || {};
    const state = {
        snapshot: null,
        query: typeof persisted.query === 'string' ? persisted.query : '',
        sourceGroup: typeof persisted.sourceGroup === 'string' ? persisted.sourceGroup : null,
        categoryPath: Array.isArray(persisted.categoryPath) ? persisted.categoryPath : [],
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
        renderGeneration: 0
    };

    function saveState() {
        vscode.setState({
            query: state.query,
            sourceGroup: state.sourceGroup,
            categoryPath: [...state.categoryPath],
            uncategorized: state.uncategorized,
            expandedNodes: [...state.expandedNodes],
            selectedItemId: state.selectedItemId,
            language: state.language,
            sortMode: state.sortMode
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

    function sourceLabel(sourceGroup) {
        return labels[`source${sourceGroup.charAt(0).toUpperCase()}${sourceGroup.slice(1)}`]
            || sourceGroup;
    }

    function categoryLabel(item) {
        return item.categoryPath && item.categoryPath.length > 0
            ? item.categoryPath.join(' / ')
            : labels.uncategorized;
    }

    function allItemsForLanguage() {
        if (!state.snapshot) {
            return [];
        }
        return protocol.searchItems(state.snapshot.items, '', {
            language: state.language,
            limit: Number.MAX_SAFE_INTEGER
        });
    }

    function filteredItems() {
        if (!state.snapshot) {
            return [];
        }
        const items = protocol.searchItems(state.snapshot.items, state.query, {
            sourceGroup: state.sourceGroup || undefined,
            categoryPath: state.uncategorized ? undefined : state.categoryPath,
            uncategorized: state.uncategorized,
            language: state.language,
            limit: Number.MAX_SAFE_INTEGER
        });
        if (state.sortMode === 'alphabetical') {
            items.sort((left, right) => {
                const leftText = left.displayText.toLowerCase();
                const rightText = right.displayText.toLowerCase();
                return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
            });
        }
        return items;
    }

    function isSelectedTreeNode(node) {
        if (node.id === 'all') {
            return !state.sourceGroup;
        }
        if (node.id.endsWith('::uncategorized')) {
            return state.sourceGroup === node.sourceGroup && state.uncategorized;
        }
        return state.sourceGroup === node.sourceGroup
            && !state.uncategorized
            && node.path.length === state.categoryPath.length
            && node.path.every((segment, index) => segment === state.categoryPath[index]);
    }

    function selectTreeNode(node) {
        if (node.id === 'all') {
            state.sourceGroup = null;
            state.categoryPath = [];
            state.uncategorized = false;
        } else {
            state.sourceGroup = node.sourceGroup;
            state.categoryPath = [...node.path];
            state.uncategorized = node.id.endsWith('::uncategorized');
        }
        saveState();
        renderTree();
        renderResults();
        shell.classList.remove('categories-open');
        definitionList.focus();
    }

    function createTreeNode(node, level) {
        const container = document.createElement('div');
        const button = document.createElement('button');
        const children = document.createElement('div');
        const expandable = node.children.length > 0;
        const expanded = state.expandedNodes.has(node.id);
        button.type = 'button';
        button.className = 'tree-item';
        button.setAttribute('role', 'treeitem');
        button.setAttribute('aria-level', String(level));
        button.setAttribute('aria-selected', String(isSelectedTreeNode(node)));
        button.dataset.nodeId = node.id;
        if (expandable) {
            button.setAttribute('aria-expanded', String(expanded));
        }
        button.tabIndex = isSelectedTreeNode(node) ? 0 : -1;

        const chevron = document.createElement('span');
        chevron.className = 'tree-chevron';
        chevron.textContent = expandable ? (expanded ? '⌄' : '›') : '';
        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.label;
        const count = document.createElement('span');
        count.className = 'tree-count';
        count.textContent = String(node.count);
        button.append(chevron, label, count);
        if (expandable) {
            chevron.addEventListener('click', event => {
                event.stopPropagation();
                toggleTreeNode(node.id);
            });
        }
        button.addEventListener('click', () => {
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
        children.hidden = !expanded;
        for (const child of node.children) {
            children.append(createTreeNode(child, level + 1));
        }
        if (expandable) {
            container.append(children);
        }
        return container;
    }

    function toggleTreeNode(nodeId) {
        if (state.expandedNodes.has(nodeId)) {
            state.expandedNodes.delete(nodeId);
        } else {
            state.expandedNodes.add(nodeId);
        }
        saveState();
        renderTree(nodeId);
    }

    function renderTree(focusNodeId) {
        const items = allItemsForLanguage();
        const roots = protocol.buildCategoryTree(items, {
            sources: {
                builtIn: labels.sourceBuiltIn,
                user: labels.sourceUser,
                export: labels.sourceExport,
                nested: labels.sourceNested
            },
            uncategorized: labels.uncategorized
        });
        const allNode = {
            id: 'all',
            sourceGroup: '',
            label: labels.allDefinitions,
            path: [],
            count: items.length,
            children: []
        };
        categoryTree.replaceChildren(
            createTreeNode(allNode, 1),
            ...roots.map(root => createTreeNode(root, 1))
        );
        if (focusNodeId) {
            [...categoryTree.querySelectorAll('[data-node-id]')]
                .find(element => element.dataset.nodeId === focusNodeId)
                ?.focus();
        }
    }

    function createDefinitionRow(item) {
        const row = document.createElement('div');
        row.className = 'definition-row';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(item.id === state.selectedItemId));
        row.tabIndex = item.id === state.selectedItemId ? 0 : -1;
        row.dataset.itemId = item.id;
        const text = document.createElement('div');
        text.className = 'definition-text';
        text.textContent = item.displayText;
        const meta = document.createElement('div');
        meta.className = 'definition-meta';
        const source = document.createElement('span');
        source.textContent = sourceLabel(item.sourceGroup);
        const category = document.createElement('span');
        category.textContent = categoryLabel(item);
        meta.append(source, category);
        row.append(text, meta);
        row.addEventListener('click', () => selectItem(item.id, false, true));
        row.addEventListener('dblclick', () => requestInsert(item.id));
        return row;
    }

    function selectItem(itemId, focus, showDetails) {
        state.selectedItemId = itemId;
        saveState();
        for (const row of definitionList.querySelectorAll('[role="option"]')) {
            const selected = row.dataset.itemId === itemId;
            row.setAttribute('aria-selected', String(selected));
            row.tabIndex = selected ? 0 : -1;
            if (selected && focus) {
                row.focus();
            }
        }
        renderDetails();
        if (showDetails) {
            shell.classList.add('details-open');
        }
    }

    function renderResults() {
        const generation = ++state.renderGeneration;
        const items = filteredItems();
        resultCount.textContent = String(items.length);
        definitionList.replaceChildren();
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
        if (!items.some(item => item.id === state.selectedItemId)) {
            state.selectedItemId = items[0].id;
            saveState();
        }
        let offset = 0;
        function appendBatch() {
            if (generation !== state.renderGeneration) {
                return;
            }
            const fragment = document.createDocumentFragment();
            const end = Math.min(offset + BATCH_SIZE, items.length);
            for (; offset < end; offset += 1) {
                fragment.append(createDefinitionRow(items[offset]));
            }
            definitionList.append(fragment);
            if (offset < items.length) {
                requestAnimationFrame(appendBatch);
            }
        }
        appendBatch();
        renderDetails();
    }

    function addDetailsField(labelText, value, code) {
        const field = document.createElement('section');
        field.className = 'details-field';
        const label = document.createElement('span');
        label.className = 'details-label';
        label.textContent = labelText;
        const content = document.createElement(code ? 'pre' : 'p');
        content.className = code ? 'details-code' : 'details-value';
        content.textContent = value;
        field.append(label, content);
        detailsContent.append(field);
    }

    function renderDetails() {
        detailsContent.replaceChildren();
        const item = state.snapshot?.items.find(candidate => candidate.id === state.selectedItemId);
        insertButton.disabled = true;
        copyButton.disabled = true;
        openDefinitionButton.disabled = true;
        if (!item) {
            const empty = document.createElement('p');
            empty.className = 'empty-details';
            empty.textContent = labels.selectDefinition;
            detailsContent.append(empty);
            return;
        }
        const title = document.createElement('h3');
        title.textContent = item.displayText;
        detailsContent.append(title);
        addDetailsField(labels.sourceLabel, item.sourceLabel || sourceLabel(item.sourceGroup));
        addDetailsField(labels.categoryLabel, categoryLabel(item));
        if (item.description) {
            addDetailsField(labels.descriptionLabel, item.description);
        }
        if (item.parameters && item.parameters.length > 0) {
            const values = item.parameters.map(parameter => parameter.defaultValue === undefined
                ? parameter.name
                : `${parameter.name} = ${parameter.defaultValue}`
            ).join('\n');
            addDetailsField(labels.parametersLabel, values, true);
        }
        if (item.alternateDisplayText) {
            addDetailsField(labels.translationLabel, item.alternateDisplayText, true);
        }
        addDetailsField(labels.templateLabel, item.template, true);
        const targetHint = document.createElement('p');
        targetHint.className = 'target-hint';
        targetHint.textContent = labels.insertionUnavailable;
        detailsContent.append(targetHint);
    }

    function requestInsert(itemId) {
        if (!state.insertionTarget.available) {
            shell.classList.add('details-open');
            announce(labels.insertionUnavailable);
            return;
        }
        vscode.postMessage({ command: 'insert', itemId });
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
    searchInput.value = state.query;
    languageFilter.value = state.language;
    sortMode.value = state.sortMode;
    searchInput.addEventListener('input', () => {
        state.query = searchInput.value;
        saveState();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            renderResults();
        }, 80);
    });
    languageFilter.addEventListener('change', () => {
        state.language = languageFilter.value;
        saveState();
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
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
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
            vscode.postMessage({ command: 'copy', itemId: state.selectedItemId });
        }
    });
    openDefinitionButton.addEventListener('click', () => {
        if (state.selectedItemId) {
            vscode.postMessage({ command: 'openDefinition', itemId: state.selectedItemId });
        }
    });

    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message !== 'object') {
            return;
        }
        if (message.command === 'loading') {
            definitionList.setAttribute('aria-busy', 'true');
            setStatus(labels.loading);
            return;
        }
        if (message.command === 'snapshot' && message.snapshot) {
            state.snapshot = message.snapshot;
            state.insertionTarget = message.insertionTarget || {
                available: false,
                identity: 'unavailable'
            };
            refreshButton.disabled = false;
            renderTree();
            renderResults();
            announce(`${message.snapshot.items.length}`);
            return;
        }
        if (message.command === 'error') {
            refreshButton.disabled = false;
            const detail = typeof message.message === 'string' ? ` ${message.message}` : '';
            setStatus(`${labels.loadFailed}${detail}`, 'error');
            announce(`${labels.loadFailed}${detail}`);
        }
    });

    setStatus(labels.loading);
    vscode.postMessage({ command: 'ready' });
}());
