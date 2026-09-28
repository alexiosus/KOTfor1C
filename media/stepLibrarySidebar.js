(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const protocol = globalThis.StepLibrarySidebarProtocol;
    const tree = document.getElementById('tree');
    const searchInput = document.getElementById('searchInput');
    const status = document.getElementById('status');
    const refreshButton = document.getElementById('refreshButton');
    const openFullButton = document.getElementById('openFullButton');
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
    let relatedAncestorIds = new Set();
    const relationshipIcons = new Set(['eye', 'arrow-right-to-line', 'arrow-right-from-line']);
    const nodesById = new Map();
    const childrenByParent = new Map();
    const requestedParents = new Set();

    function persistState() {
        vscode.setState({
            expandedIds: [...uiState.expandedIds],
            selectedId: uiState.selectedId,
            scrollTop: tree.scrollTop
        });
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
        return protocol.relationshipDecorationForNode(node, state);
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
        row.tabIndex = node.id === uiState.selectedId ? 0 : -1;
        if (node.id === uiState.selectedId) {
            row.classList.add('is-selected');
            row.setAttribute('aria-selected', 'true');
        }

        const expanded = uiState.expandedIds.includes(node.id);
        const toggle = document.createElement('span');
        toggle.className = 'step-chevron';
        if (node.expandable) {
            toggle.appendChild(createIcon(expanded ? 'chevron-down' : 'chevron-right'));
            row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
        row.appendChild(toggle);

        const label = document.createElement(node.kind === 'definition' ? 'pre' : 'span');
        label.className = node.kind === 'definition'
            ? 'kot-tree-label step-code'
            : 'kot-tree-label';
        label.title = node.alternateLabel
            ? `${node.label}\n${node.alternateLabel}`
            : node.label;
        if (node.kind === 'definition') {
            appendSyntax(label, node.label);
        } else {
            label.textContent = node.label;
        }
        row.appendChild(label);

        if (typeof node.count === 'number') {
            const count = document.createElement('span');
            count.className = 'step-count';
            count.textContent = String(node.count);
            row.appendChild(count);
        }

        const actions = document.createElement('span');
        actions.className = 'kot-row-actions step-actions';
        const decoration = relationshipDecoration(node);
        if (decoration.state !== 'none') {
            row.classList.add(...decoration.classNames);
            const icon = relationshipIcons.has(decoration.icon) ? decoration.icon : 'git-branch';
            actions.appendChild(createIcon(icon, decoration.accessibleLabel));
        } else if (relatedAncestorIds.has(node.id)) {
            row.classList.add('is-related');
            actions.appendChild(createIcon('git-branch', 'Contains scenarios related to the open scenario'));
        } else if (node.kind === 'definition') {
            actions.appendChild(createIcon('add', insertionAvailable ? 'Insert step' : 'Insertion target unavailable'));
        }
        row.appendChild(actions);
        return row;
    }

    function appendNode(fragment, node, parentId) {
        fragment.appendChild(makeRow(node, parentId));
        if (!node.expandable || !uiState.expandedIds.includes(node.id)) {
            return;
        }
        const children = childrenByParent.get(node.id);
        if (!children) {
            requestChildren(node.id, 0);
            return;
        }
        for (const child of children) {
            appendNode(fragment, child, node.id);
        }
    }

    function render() {
        const scrollTop = tree.scrollTop;
        nodesById.clear();
        const fragment = document.createDocumentFragment();
        const visibleRoots = searchResults === null ? roots : searchResults;
        for (const node of visibleRoots) {
            appendNode(fragment, node, '');
        }
        tree.replaceChildren(fragment);
        tree.scrollTop = persisted.scrollTop !== undefined && roots.length > 0
            ? persisted.scrollTop
            : scrollTop;
        persisted.scrollTop = undefined;
    }

    function requestChildren(parentId, offset) {
        const requestKey = `${parentId}\0${offset}`;
        if (requestedParents.has(requestKey)) {
            return;
        }
        requestedParents.add(requestKey);
        vscode.postMessage({ command: 'expand', nodeId: parentId, offset });
    }

    function toggleNode(node) {
        if (!node.expandable) {
            return;
        }
        uiState = protocol.toggleExpanded(uiState, node.id);
        if (uiState.expandedIds.includes(node.id) && !childrenByParent.has(node.id)) {
            requestChildren(node.id, 0);
        }
        persistState();
        render();
    }

    function selectNode(nodeId) {
        uiState = protocol.selectNode(uiState, nodeId);
        persistState();
        render();
    }

    function activateNode(node, openDefinition) {
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

    tree.addEventListener('dblclick', event => {
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
        if (searchTimer !== null) {
            clearTimeout(searchTimer);
        }
        searchTimer = setTimeout(() => {
            vscode.postMessage({ command: 'search', query: searchInput.value });
        }, 150);
    });

    refreshButton.addEventListener('click', () => {
        refreshButton.disabled = true;
        vscode.postMessage({ command: 'refresh' });
    });
    openFullButton.addEventListener('click', () => {
        vscode.postMessage({ command: 'openFullLibrary' });
    });

    window.addEventListener('message', event => {
        const message = event.data || {};
        switch (message.command) {
            case 'loading':
                status.textContent = 'Loading steps…';
                break;
            case 'roots':
                roots = Array.isArray(message.nodes) ? message.nodes : [];
                childrenByParent.clear();
                requestedParents.clear();
                searchResults = null;
                insertionAvailable = message.insertionTarget?.available === true;
                relationshipState = message.relationshipState || relationshipState;
                relatedAncestorIds = new Set(message.relatedAncestorIds || []);
                uiState = protocol.withRelationshipState(uiState, relationshipState);
                status.textContent = '';
                refreshButton.disabled = false;
                render();
                break;
            case 'children': {
                const current = message.offset > 0 && childrenByParent.has(message.parentId)
                    ? childrenByParent.get(message.parentId).filter(node => node.kind !== 'more')
                    : [];
                childrenByParent.set(message.parentId, [...current, ...(message.nodes || [])]);
                render();
                break;
            }
            case 'searchResults':
                searchResults = message.query.trim() ? (message.nodes || []) : null;
                status.textContent = searchResults && searchResults.length === 0 ? 'No matching steps' : '';
                render();
                break;
            case 'relationshipState':
                relationshipState = message.relationshipState || relationshipState;
                relatedAncestorIds = new Set(message.relatedAncestorIds || []);
                uiState = protocol.withRelationshipState(uiState, relationshipState);
                render();
                break;
            case 'insertionTarget':
                insertionAvailable = message.available === true;
                render();
                break;
            case 'actionResult':
                refreshButton.disabled = false;
                break;
            case 'error':
                status.textContent = message.message || 'Unable to load the Step Library';
                refreshButton.disabled = false;
                break;
        }
    });

    vscode.postMessage({ command: 'ready' });
}());
