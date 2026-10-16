(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const protocol = globalThis.InfobaseSidebarProtocol;
    const root = document.querySelector('.infobase-sidebar');
    const loc = root.dataset;
    const status = document.getElementById('status');
    const list = document.getElementById('list');
    const persisted = vscode.getState() || {};
    let items = [];
    let uiState = protocol.createState({ selectedId: persisted.selectedId });

    function persistState() {
        vscode.setState({ selectedId: uiState.selectedId, scrollTop: list.scrollTop });
    }

    function icon(name, label) {
        const value = document.createElement('span');
        value.classList.add('codicon', `codicon-${name}`);
        if (label) {
            value.setAttribute('role', 'img');
            value.setAttribute('aria-label', label);
        } else {
            value.setAttribute('aria-hidden', 'true');
        }
        return value;
    }

    function actionButton(iconName, label, command, item) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'kot-icon-button infobase-action';
        button.title = label;
        button.setAttribute('aria-label', `${label}: ${item.displayName}`);
        button.disabled = !protocol.actionEnabled(item, command, uiState.pendingActions[item.id]);
        button.appendChild(icon(iconName));
        button.addEventListener('click', event => {
            event.stopPropagation();
            vscode.postMessage({ command, infobaseId: item.id });
        });
        return button;
    }

    function maintenanceItem(label, iconName, action, item) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.disabled = !protocol.actionEnabled(item, action, uiState.pendingActions[item.id]);
        button.append(icon(iconName), document.createTextNode(label));
        button.addEventListener('click', event => {
            event.stopPropagation();
            uiState = protocol.toggleMenu(uiState, item.id);
            persistState();
            render();
            vscode.postMessage({ command: 'maintenance', infobaseId: item.id, action });
        });
        return button;
    }

    function maintenanceHeading(label) {
        const heading = document.createElement('div');
        heading.className = 'infobase-menu-heading';
        heading.textContent = label;
        return heading;
    }

    function otherActionsSubmenu(item) {
        const container = document.createElement('div');
        container.className = 'infobase-submenu-container';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'infobase-submenu-toggle';
        toggle.setAttribute('role', 'menuitem');
        toggle.setAttribute('aria-haspopup', 'menu');
        toggle.setAttribute('aria-expanded', uiState.submenuId === item.id ? 'true' : 'false');
        toggle.append(icon('ellipsis'), document.createTextNode(loc.generalHeading), icon(
            uiState.submenuId === item.id ? 'chevron-down' : 'chevron-right'
        ));
        toggle.addEventListener('click', event => {
            event.stopPropagation();
            uiState = protocol.toggleSubmenu(uiState, item.id);
            persistState();
            render();
        });
        container.appendChild(toggle);

        if (uiState.submenuId === item.id) {
            const submenu = document.createElement('div');
            submenu.className = 'infobase-submenu';
            submenu.setAttribute('role', 'menu');
            submenu.append(
                maintenanceItem(loc.copy, 'copy', 'copy', item),
                maintenanceItem(loc.recreate, 'discard', 'recreate', item),
                maintenanceItem(loc.edit, 'edit', 'edit', item),
                maintenanceItem(
                    item.launcherRegistered ? loc.removeFromLauncher : loc.addToLauncher,
                    item.launcherRegistered ? 'remove' : 'add',
                    item.launcherRegistered ? 'removeFromLauncher' : 'addToLauncher',
                    item
                ),
                maintenanceItem(loc.reveal, 'folder-opened', 'reveal', item),
                maintenanceItem(loc.logs, 'output', 'logs', item)
            );
            container.appendChild(submenu);
        }
        return container;
    }

    function makeRow(item) {
        const row = document.createElement('div');
        row.className = 'kot-tree-row infobase-row';
        row.dataset.infobaseId = item.id;
        row.setAttribute('role', 'listitem');
        row.tabIndex = item.id === uiState.selectedId ? 0 : -1;
        const pendingAction = uiState.pendingActions[item.id] || null;
        if (pendingAction) {
            row.classList.add('is-pending');
            row.setAttribute('aria-busy', 'true');
        }

        const marker = protocol.runtimeMarker(item, pendingAction, {
            running: loc.runtimeMarker,
            pending: loc.pendingMarker
        });
        const active = document.createElement('span');
        active.className = 'infobase-runtime-marker';
        if (marker.visible) {
            active.classList.add(`is-${marker.state}`);
            active.title = marker.accessibleLabel;
            active.setAttribute('role', 'img');
            active.setAttribute('aria-label', marker.accessibleLabel);
        } else {
            active.setAttribute('aria-hidden', 'true');
        }
        row.appendChild(active);

        const labels = document.createElement('span');
        labels.className = 'infobase-labels';
        const name = document.createElement('span');
        name.className = 'kot-tree-label infobase-name';
        const nameContent = document.createElement('span');
        nameContent.className = 'kot-scroll-content';
        nameContent.textContent = item.displayName;
        name.appendChild(nameContent);
        name.title = item.displayName;
        const location = document.createElement('span');
        location.className = 'kot-tree-label infobase-location';
        const locationContent = document.createElement('span');
        locationContent.className = 'kot-scroll-content';
        locationContent.textContent = item.locationLabel;
        location.appendChild(locationContent);
        location.title = item.infobasePath;
        labels.append(name, location);
        row.appendChild(labels);

        const actions = document.createElement('span');
        actions.className = 'kot-row-actions infobase-actions';
        actions.appendChild(actionButton('play', loc.openEnterprise, 'openEnterprise', item));
        actions.appendChild(actionButton('tools', loc.openDesigner, 'openDesigner', item));
        const menuButton = document.createElement('button');
        menuButton.type = 'button';
        menuButton.className = 'kot-icon-button infobase-action';
        menuButton.title = loc.maintenance;
        menuButton.setAttribute('aria-label', `${loc.maintenance}: ${item.displayName}`);
        menuButton.setAttribute('aria-haspopup', 'menu');
        menuButton.setAttribute('aria-expanded', uiState.menuId === item.id ? 'true' : 'false');
        menuButton.appendChild(icon('ellipsis'));
        menuButton.addEventListener('click', event => {
            event.stopPropagation();
            uiState = protocol.toggleMenu(uiState, item.id);
            persistState();
            render();
        });
        actions.appendChild(menuButton);
        row.appendChild(actions);

        if (uiState.menuId === item.id) {
            const menu = document.createElement('div');
            menu.className = 'infobase-menu';
            menu.setAttribute('role', 'menu');
            menu.append(
                maintenanceHeading(loc.dtHeading),
                maintenanceItem(`${loc.importDt}…`, 'cloud-download', 'importDt', item),
                maintenanceItem(`${loc.exportDt}…`, 'cloud-upload', 'exportDt', item),
                maintenanceHeading(loc.cfHeading),
                maintenanceItem(loc.updateConfiguration, 'settings-gear', 'updateConfiguration', item),
                maintenanceItem(loc.updateFromTemplate || 'Update from installed template', 'package', 'updateFromTemplate', item),
                maintenanceItem(`${loc.exportCf}…`, 'save', 'exportCf', item),
                maintenanceHeading(loc.kotHeading),
                maintenanceItem(loc.openFormExplorer, 'telescope', 'openFormExplorer', item),
                otherActionsSubmenu(item)
            );
            row.appendChild(menu);
        }

        return row;
    }

    function updateRowLabelOverflow(row) {
        if (!(row instanceof HTMLElement)) {
            return;
        }
        for (const label of row.querySelectorAll('.kot-tree-label')) {
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

    function updateAllRowLabelOverflow() {
        requestAnimationFrame(() => {
            for (const row of list.querySelectorAll('.infobase-row')) {
                updateRowLabelOverflow(row);
            }
        });
    }

    const labelResizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => updateAllRowLabelOverflow())
        : null;
    if (labelResizeObserver) {
        labelResizeObserver.observe(list);
    }

    function render() {
        const scrollTop = list.scrollTop;
        const fragment = document.createDocumentFragment();
        for (const item of items) {
            fragment.appendChild(makeRow(item));
        }
        list.replaceChildren(fragment);
        list.scrollTop = persisted.scrollTop !== undefined ? persisted.scrollTop : scrollTop;
        persisted.scrollTop = undefined;
        requestAnimationFrame(() => {
            const openMenu = list.querySelector('.infobase-menu');
            if (openMenu) {
                const row = openMenu.closest('.infobase-row');
                const listRect = list.getBoundingClientRect();
                const rowRect = row?.getBoundingClientRect();
                const menuHeight = openMenu.getBoundingClientRect().height;
                if (rowRect && rowRect.bottom + menuHeight > listRect.bottom
                    && rowRect.top - menuHeight >= listRect.top) {
                    openMenu.classList.add('opens-upward');
                }
            }
            for (const row of list.querySelectorAll('.infobase-row')) {
                updateRowLabelOverflow(row);
            }
        });
    }

    const refreshHoveredRowOverflow = event => {
        const row = event.target instanceof Element ? event.target.closest('.infobase-row') : null;
        requestAnimationFrame(() => updateRowLabelOverflow(row));
    };
    list.addEventListener('mouseover', refreshHoveredRowOverflow);
    list.addEventListener('mouseout', refreshHoveredRowOverflow);

    list.addEventListener('keydown', event => {
        const ids = items.map(item => item.id);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            uiState = protocol.moveSelection(uiState, ids, event.key === 'ArrowDown' ? 1 : -1);
            persistState();
            render();
            list.querySelector(`[data-infobase-id="${CSS.escape(uiState.selectedId || '')}"]`)?.focus();
            return;
        }
        if (event.key === 'Enter' && uiState.selectedId) {
            event.preventDefault();
            vscode.postMessage({ command: 'openEnterprise', infobaseId: uiState.selectedId });
            return;
        }
        if (event.key === 'Escape' && uiState.menuId) {
            event.preventDefault();
            uiState = uiState.submenuId
                ? protocol.toggleSubmenu(uiState, uiState.submenuId)
                : protocol.toggleMenu(uiState, uiState.menuId);
            persistState();
            render();
        }
    });

    document.addEventListener('click', event => {
        if (uiState.menuId && !event.target.closest('.infobase-menu, [aria-haspopup="menu"]')) {
            uiState = protocol.toggleMenu(uiState, uiState.menuId);
            persistState();
            render();
        }
    });
    window.addEventListener('message', event => {
        const message = event.data || {};
        switch (message.command) {
            case 'loading':
                status.textContent = message.retainItems ? loc.refreshing : loc.loading;
                break;
            case 'state':
                items = Array.isArray(message.items) ? message.items : [];
                uiState = protocol.withItems(uiState, items);
                status.textContent = items.length === 0 ? loc.empty : '';
                persistState();
                render();
                break;
            case 'pending':
                uiState = protocol.withPending(uiState, message.infobaseId, message.action);
                status.textContent = Object.keys(uiState.pendingActions).length > 0 ? loc.running : '';
                render();
                break;
            case 'error':
                status.textContent = message.message || loc.error;
                render();
                break;
        }
    });

    vscode.postMessage({ command: 'ready' });
})();
