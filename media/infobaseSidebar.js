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
    const expandedBases = new Set(Array.isArray(persisted.expandedBases) ? persisted.expandedBases : []);
    let uiState = protocol.createState({ selectedId: persisted.selectedId });

    function persistState() {
        vscode.setState({ selectedId: uiState.selectedId, scrollTop: list.scrollTop, expandedBases: [...expandedBases] });
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
            vscode.postMessage(action === 'openDesigner' ? { command: 'openDesigner', infobaseId: item.id } : { command: 'maintenance', infobaseId: item.id, action });
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
        const disclosure = document.createElement('button');
        disclosure.className = 'kot-icon-button infobase-disclosure'; disclosure.type = 'button';
        disclosure.setAttribute('aria-label', `${loc.testClients || 'Test clients'}: ${item.displayName}`); disclosure.setAttribute('aria-expanded', String(expandedBases.has(item.id)));
        disclosure.appendChild(icon(expandedBases.has(item.id) ? 'chevron-down' : 'chevron-right'));
        disclosure.addEventListener('click', event => { event.stopPropagation(); if (expandedBases.has(item.id)) { expandedBases.delete(item.id); } else { expandedBases.add(item.id); } persistState(); const children = row.nextElementSibling; children?.classList.toggle('is-expanded', expandedBases.has(item.id)); if (children) { children.inert = !expandedBases.has(item.id); } disclosure.setAttribute('aria-expanded', String(expandedBases.has(item.id))); disclosure.querySelector('.codicon').className = 'codicon codicon-' + (expandedBases.has(item.id) ? 'chevron-down' : 'chevron-right'); lastRenderSignature = JSON.stringify([items, uiState, [...expandedBases]]); });
        row.append(disclosure, active);

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
        if (item.runtimeModes?.length) { const mode = document.createElement('span'); mode.className = 'infobase-mode'; mode.textContent = item.runtimeModes.map(value => value === 'enterprise' ? loc.enterpriseMode || 'Enterprise' : value === 'designer' ? loc.designerMode || 'Designer' : 'Vanessa').join(' · '); name.appendChild(mode); }
        row.appendChild(labels);

        const actions = document.createElement('span');
        actions.className = 'kot-row-actions infobase-actions';
        actions.appendChild(actionButton('play', loc.openEnterprise, 'openEnterprise', item));
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
                maintenanceItem(`${loc.restoreFromTemplate}…`, 'package', 'restoreFromTemplate', item),
                maintenanceItem(`${loc.exportDt}…`, 'cloud-upload', 'exportDt', item),
                maintenanceHeading(loc.cfHeading),
                maintenanceItem(loc.updateConfiguration, 'settings-gear', 'updateConfiguration', item),
                maintenanceItem(loc.updateFromTemplate || 'Update from installed template', 'package', 'updateFromTemplate', item),
                maintenanceItem(`${loc.exportCf}…`, 'save', 'exportCf', item),
                maintenanceHeading(loc.kotHeading),
                maintenanceItem(loc.openVanessa || 'Open with Vanessa', 'plug', 'openVanessa', item),
                maintenanceItem(loc.openFormExplorer, 'telescope', 'openFormExplorer', item),
                maintenanceItem(loc.openDesigner, 'tools', 'openDesigner', item),
                maintenanceItem(loc.vanessaClients || 'Vanessa test clients', 'plug', 'vanessaClients', item),
                otherActionsSubmenu(item)
            );
            row.appendChild(menu);
        }

        return row;
    }

    function clientRows(item) {
        const group = document.createElement('div'); group.className = 'infobase-client-list';
        const clients = item.clients || [];
        if (!clients.length) {
            const empty = document.createElement('div'); empty.className = 'infobase-client-row';
            const label = document.createElement('span'); label.className = 'infobase-client-empty'; label.textContent = loc.noClients || 'No saved test clients';
            empty.append(label); group.appendChild(empty);
        }
        for (const client of clients) {
            const row = document.createElement('div'); row.className = 'infobase-client-row';
            const marker = document.createElement('span'); marker.className = 'infobase-runtime-marker' + (client.connected ? ' is-running' : ''); marker.title = client.connected ? 'Vanessa' : '';
            const copy = document.createElement('span'); copy.className = 'infobase-labels';
            const name = document.createElement('span'); name.className = 'kot-tree-label infobase-name'; const text = document.createElement('span'); text.className = 'kot-scroll-content'; text.textContent = client.name; name.appendChild(text);
            const user = document.createElement('span'); user.className = 'infobase-location'; user.textContent = (client.username || loc.defaultUser || 'Default user') + (client.connected ? ' · Vanessa' : ''); copy.append(name, user);
            const actions = document.createElement('span'); actions.className = 'kot-row-actions infobase-client-actions';
            const action = (kind, glyph, label) => { const button = document.createElement('button'); button.className = 'kot-icon-button infobase-action'; button.type = 'button'; button.title = label; button.setAttribute('aria-label', `${label}: ${client.name}`); button.disabled = !!item.clientBusy || client.state === 'conflict' || client.state === 'unsupported'; button.appendChild(icon(glyph)); button.addEventListener('click', event => { event.stopPropagation(); vscode.postMessage({ command: 'clientAction', action: kind, infobaseId: item.id, clientId: client.id }); }); return button; };
            if (client.state === 'local') { actions.appendChild(action('add', 'add', loc.addToVanessa || 'Add to Vanessa')); }
            actions.appendChild(client.connected ? action('disconnect', 'debug-disconnect', loc.disconnect || 'Disconnect') : action('connect', 'debug-start', loc.connect || 'Connect'));
            row.append(marker, copy, actions); group.appendChild(row);
        }
        return group;
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
            for (const row of list.querySelectorAll('.infobase-row, .infobase-client-row')) {
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

    let lastRenderSignature;
    function render() {
        const signature = JSON.stringify([items, uiState, [...expandedBases]]);
        if (signature === lastRenderSignature) { return; } lastRenderSignature = signature;
        const scrollTop = list.scrollTop; const menuScroll = list.querySelector('.infobase-menu')?.scrollTop || 0;
        const fragment = document.createDocumentFragment();
        for (const item of items) {
            fragment.appendChild(makeRow(item));
            const children = document.createElement('div'); children.className = 'infobase-children'; children.classList.toggle('is-expanded', expandedBases.has(item.id)); children.inert = !expandedBases.has(item.id); const clip = document.createElement('div'); clip.className = 'infobase-children-clip'; clip.appendChild(clientRows(item)); children.appendChild(clip); fragment.appendChild(children);
        }
        list.replaceChildren(fragment);
        list.scrollTop = persisted.scrollTop !== undefined ? persisted.scrollTop : scrollTop;
        persisted.scrollTop = undefined;
        requestAnimationFrame(() => {
            const openMenu = list.querySelector('.infobase-menu');
            if (openMenu) { openMenu.scrollTop = menuScroll;
                const row = openMenu.closest('.infobase-row');
                const listRect = list.getBoundingClientRect();
                const rowRect = row?.getBoundingClientRect();
                const menuHeight = openMenu.getBoundingClientRect().height;
                if (rowRect && rowRect.bottom + menuHeight > listRect.bottom
                    && rowRect.top - menuHeight >= listRect.top) {
                    openMenu.classList.add('opens-upward');
                }
            }
            for (const row of list.querySelectorAll('.infobase-row, .infobase-client-row')) {
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
