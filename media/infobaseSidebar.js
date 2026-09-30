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
        button.disabled = uiState.pendingId !== null;
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

    function makeRow(item) {
        const row = document.createElement('div');
        row.className = 'kot-tree-row infobase-row';
        row.dataset.infobaseId = item.id;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', item.id === uiState.selectedId ? 'true' : 'false');
        row.tabIndex = item.id === uiState.selectedId ? 0 : -1;
        if (item.id === uiState.selectedId) {
            row.classList.add('is-selected');
        }
        if (item.id === uiState.pendingId) {
            row.classList.add('is-pending');
            row.setAttribute('aria-busy', 'true');
        }

        const marker = protocol.runtimeMarker(item, loc.runtimeMarker);
        const active = document.createElement('span');
        active.className = 'infobase-runtime-marker';
        if (marker.visible) {
            active.classList.add('is-running');
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
        menuButton.disabled = uiState.pendingId !== null;
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
                maintenanceItem(loc.updateFromSources, 'folder-opened', 'updateFromSources', item),
                maintenanceItem(`${loc.importCf}…`, 'repo-sync', 'importCf', item),
                maintenanceItem(`${loc.exportCf}…`, 'save', 'exportCf', item),
                maintenanceItem(loc.updateConfiguration, 'settings-gear', 'updateConfiguration', item),
                maintenanceHeading(loc.generalHeading),
                maintenanceItem(loc.openFormExplorer, 'telescope', 'openFormExplorer', item),
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
            row.appendChild(menu);
        }

        row.addEventListener('click', () => {
            uiState = protocol.selectItem(uiState, item.id);
            persistState();
            render();
        });
        return row;
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
            for (const label of list.querySelectorAll('.kot-tree-label')) {
                const content = label.querySelector('.kot-scroll-content');
                if (!content) {
                    continue;
                }
                const distance = Math.max(0, content.scrollWidth - label.clientWidth + 12);
                label.classList.toggle('is-overflowing', distance > 1);
                label.style.setProperty('--kot-overflow-distance', `${distance}px`);
                label.style.setProperty('--kot-overflow-duration', `${Math.max(1.2, distance / 45)}s`);
            }
        });
    }

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
            uiState = protocol.toggleMenu(uiState, uiState.menuId);
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
                uiState = protocol.withPending(uiState, message.infobaseId);
                status.textContent = message.infobaseId ? loc.running : '';
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
