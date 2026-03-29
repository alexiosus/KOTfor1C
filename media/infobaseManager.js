(function () {
    const vscode = acquireVsCodeApi();
    const loc = window.__infobaseManagerLoc || {};
    let state = window.__initialInfobaseManagerState || {
        infobases: [],
        platforms: [],
        selectedInfobasePath: null,
        pendingAction: null,
        lastError: null,
        sortMode: 'lastOpened',
        showHidden: false
    };
    const persistedUiState = vscode.getState() || {};
    const uiState = {
        searchQuery: typeof persistedUiState.searchQuery === 'string' ? persistedUiState.searchQuery : '',
        technicalExpanded: Boolean(persistedUiState.technicalExpanded),
        moreActionsOpen: false,
        sortMenuOpen: false,
        launchPlatformMenuOpen: false
    };
    const dragState = {
        draggedPath: '',
        targetPath: '',
        placement: 'before'
    };
    const clickState = {
        lastInfobasePath: '',
        lastTimestamp: 0
    };
    const autoScrollAnimations = new WeakMap();

    const refs = {
        infobaseCountValue: document.getElementById('infobaseCountValue'),
        statusChip: document.getElementById('statusChip'),
        statusValue: document.getElementById('statusValue'),
        refreshBtn: document.getElementById('refreshBtn'),
        createBtn: document.getElementById('createBtn'),
        addManualBtn: document.getElementById('addManualBtn'),
        manageEtalonBasesBtn: document.getElementById('manageEtalonBasesBtn'),
        searchInput: document.getElementById('searchInput'),
        sortMenuBtn: document.getElementById('sortMenuBtn'),
        sortMenu: document.getElementById('sortMenu'),
        sortMenuLabel: document.getElementById('sortMenuLabel'),
        infobaseList: document.getElementById('infobaseList'),
        emptyState: document.getElementById('emptyState'),
        detailsContent: document.getElementById('detailsContent'),
        infobaseTitle: document.getElementById('infobaseTitle'),
        infobasePath: document.getElementById('infobasePath'),
        stateBadge: document.getElementById('stateBadge'),
        lastLaunchValue: document.getElementById('lastLaunchValue'),
        lastRunLogValue: document.getElementById('lastRunLogValue'),
        startupParametersValue: document.getElementById('startupParametersValue'),
        launcherValue: document.getElementById('launcherValue'),
        rolesValue: document.getElementById('rolesValue'),
        sourcesValue: document.getElementById('sourcesValue'),
        lastSnapshotValue: document.getElementById('lastSnapshotValue'),
        existsValue: document.getElementById('existsValue'),
        markerValue: document.getElementById('markerValue'),
        technicalToggle: document.getElementById('technicalToggle'),
        technicalToggleIcon: document.getElementById('technicalToggleIcon'),
        technicalBody: document.getElementById('technicalBody'),
        errorPanel: document.getElementById('errorPanel'),
        errorValue: document.getElementById('errorValue'),
        launchPlatformBtn: document.getElementById('launchPlatformBtn'),
        launchPlatformLabel: document.getElementById('launchPlatformLabel'),
        launchPlatformMenu: document.getElementById('launchPlatformMenu'),
        moreActionsBtn: document.getElementById('moreActionsBtn'),
        moreActionsMenu: document.getElementById('moreActionsMenu'),
        addToLauncherAction: document.getElementById('addToLauncherAction'),
        removeFromLauncherAction: document.getElementById('removeFromLauncherAction'),
        forgetManualAction: document.getElementById('forgetManualAction'),
        toggleHiddenAction: document.getElementById('toggleHiddenAction'),
        toggleHiddenActionLabel: document.getElementById('toggleHiddenActionLabel')
    };

    function persistUiState() {
        vscode.setState({
            searchQuery: uiState.searchQuery,
            technicalExpanded: uiState.technicalExpanded
        });
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDate(value) {
        if (!value) {
            return loc.none || 'None';
        }

        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            return value;
        }

        return parsed.toLocaleString();
    }

    function compareDateStrings(left, right) {
        const leftValue = left ? Date.parse(left) : 0;
        const rightValue = right ? Date.parse(right) : 0;
        return leftValue - rightValue;
    }

    function getSelectedInfobase() {
        const selectedPath = state.selectedInfobasePath || '';
        if (!selectedPath) {
            return null;
        }

        return (state.infobases || []).find(item => item.infobasePath === selectedPath) || null;
    }

    function getVisibleInfobases() {
        return (state.infobases || []).filter(record => state.showHidden || !record.hidden);
    }

    function normalizePlatformPath(rawPath) {
        const source = String(rawPath || '').trim();
        if (!source) {
            return '';
        }

        const normalized = source.replace(/[\\/]+/g, '/');
        return normalized.toLowerCase();
    }

    function getConfiguredPlatforms() {
        return Array.isArray(state.platforms) ? state.platforms : [];
    }

    function getDefaultPlatform() {
        return getConfiguredPlatforms()[0] || null;
    }

    function resolveEffectiveLaunchPlatform(record) {
        const platforms = getConfiguredPlatforms();
        if (!platforms.length) {
            return null;
        }

        const preferredPlatformPath = normalizePlatformPath(record?.preferredPlatformClientExePath || '');
        if (preferredPlatformPath) {
            const preferredPlatform = platforms.find(platform =>
                normalizePlatformPath(platform?.clientExePath || '') === preferredPlatformPath
            );
            if (preferredPlatform) {
                return preferredPlatform;
            }
        }

        return getDefaultPlatform();
    }

    function getEffectiveLaunchPlatformClientExePath(record) {
        return resolveEffectiveLaunchPlatform(record)?.clientExePath || null;
    }

    function formatPlatformButtonLabel(platform) {
        if (!platform) {
            return loc.launchPlatform || loc.platform || 'Platform';
        }

        const platformName = String(platform?.name || '').trim();
        const versionMatch = platformName.match(/(\d+(?:\.\d+)+)\s*$/);
        if (versionMatch?.[1]) {
            return versionMatch[1];
        }

        return platformName || String(platform?.clientExePath || '').trim() || (loc.launchPlatform || loc.platform || 'Platform');
    }

    function syncAutoScrollText(root, selector) {
        if (!(root instanceof HTMLElement)) {
            return;
        }

        root.querySelectorAll(selector).forEach(node => {
            if (!(node instanceof HTMLElement)) {
                return;
            }

            const originalText = node.dataset.autoScrollSource ?? node.textContent ?? '';
            node.dataset.autoScrollSource = originalText;
            node.classList.add('auto-scroll-text');

            let track = node.firstElementChild;
            if (!(track instanceof HTMLElement) || !track.classList.contains('auto-scroll-track')) {
                node.textContent = '';
                track = document.createElement('span');
                track.className = 'auto-scroll-track';
                track.textContent = originalText;
                node.appendChild(track);
            } else if (track.textContent !== originalText) {
                track.textContent = originalText;
            }

            const runningAnimation = autoScrollAnimations.get(node);
            if (runningAnimation) {
                runningAnimation.cancel();
                autoScrollAnimations.delete(node);
            }

            track.style.transform = 'translateX(0)';
            const overflowWidth = Math.ceil(track.scrollWidth - node.clientWidth);
            if (overflowWidth <= 6) {
                return;
            }

            const edgePauseDuration = 560;
            const travelDuration = Math.min(Math.max(overflowWidth * 55, 2400), 9000);
            const totalDuration = travelDuration * 2 + edgePauseDuration * 2;
            const startHoldOffset = edgePauseDuration / totalDuration;
            const endReachOffset = (edgePauseDuration + travelDuration) / totalDuration;
            const endHoldOffset = (edgePauseDuration + travelDuration + edgePauseDuration) / totalDuration;
            const animation = track.animate(
                [
                    { transform: 'translateX(0)', offset: 0 },
                    { transform: 'translateX(0)', offset: startHoldOffset },
                    { transform: `translateX(${-overflowWidth}px)`, offset: endReachOffset },
                    { transform: `translateX(${-overflowWidth}px)`, offset: endHoldOffset },
                    { transform: 'translateX(0)', offset: 1 }
                ],
                {
                    duration: totalDuration,
                    easing: 'linear',
                    iterations: Infinity
                }
            );
            autoScrollAnimations.set(node, animation);
        });
    }

    function supportsFileOperations(record) {
        return Boolean(record) && record.infobaseKind === 'file';
    }

    function supportsDesignerOperations(record) {
        return Boolean(record) && record.infobaseKind !== 'web';
    }

    function getInfobaseByPath(infobasePath) {
        return (state.infobases || []).find(item => item.infobasePath === infobasePath) || null;
    }

    function getLastActivity(record) {
        const candidates = [
            record.lastLaunchAt || null,
            record.lastRunLogAt || null,
            record.lastSnapshotAt || null
        ].filter(Boolean);
        if (!candidates.length) {
            return null;
        }

        return candidates.reduce((latest, current) => compareDateStrings(latest, current) >= 0 ? latest : current);
    }

    function matchesSearch(record) {
        const normalizedQuery = uiState.searchQuery.trim().toLowerCase();
        if (!normalizedQuery) {
            return true;
        }

        const haystack = [
            record.displayName,
            record.locationLabel,
            record.infobasePath,
            record.launcherName,
            record.state,
            record.lastLaunchKind,
            record.lastRunLogPath
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        return haystack.includes(normalizedQuery);
    }

    function getStateLabel(stateKey) {
        if (stateKey === 'ready') {
            return loc.ready || 'Ready';
        }
        if (stateKey === 'empty') {
            return loc.empty || 'Empty';
        }
        if (stateKey === 'dirty') {
            return loc.dirty || 'Dirty';
        }
        if (stateKey === 'missing') {
            return loc.missing || 'Missing';
        }
        return stateKey || '';
    }

    function getStateHint(stateKey) {
        if (stateKey === 'ready') {
            return loc.stateReadyHint || '';
        }
        if (stateKey === 'empty') {
            return loc.stateEmptyHint || '';
        }
        if (stateKey === 'dirty') {
            return loc.stateDirtyHint || '';
        }
        if (stateKey === 'missing') {
            return loc.stateMissingHint || '';
        }
        return '';
    }

    function getRoleLabel(roleKey) {
        if (roleKey === 'startup') {
            return loc.startup || 'Startup';
        }
        if (roleKey === 'vanessa') {
            return loc.vanessa || 'Vanessa';
        }
        if (roleKey === 'formExplorer') {
            return loc.formExplorer || 'Form Explorer';
        }
        if (roleKey === 'snapshot') {
            return loc.snapshot || 'Snapshot';
        }
        return roleKey || '';
    }

    function getSourceLabel(sourceKey) {
        if (sourceKey === 'launcher') {
            return loc.launcher || 'Launcher';
        }
        if (sourceKey === 'runtime') {
            return loc.runtime || 'Runtime';
        }
        if (sourceKey === 'manual') {
            return loc.manual || 'Manual';
        }
        if (sourceKey === 'snapshot') {
            return loc.snapshot || 'Snapshot';
        }
        if (sourceKey === 'workspaceState') {
            return loc.workspaceState || 'Workspace state';
        }
        return sourceKey || '';
    }

    function formatValueWithPath(timestamp, filePath) {
        if (!filePath) {
            return loc.none || 'None';
        }
        return `${formatDate(timestamp)}\n${filePath}`;
    }

    function formatLastLaunch(record) {
        if (!record.lastLaunchAt) {
            return loc.none || 'None';
        }

        if (!record.lastLaunchKind) {
            return formatDate(record.lastLaunchAt);
        }

        return `${formatDate(record.lastLaunchAt)}\n${record.lastLaunchKind}`;
    }

    function shortenStatusText(value) {
        const source = String(value || '').trim();
        if (!source) {
            return getStateLabel('ready');
        }

        const normalized = source.replace(/\.\.\.$/, '').trim();
        return normalized.length > 32
            ? `${normalized.slice(0, 31)}…`
            : normalized;
    }

    function getStartupParametersLabel(record) {
        if (record.startupParametersMode === 'custom') {
            return record.startupParameters || (loc.noLaunchKeys || 'No launch keys');
        }
        if (record.startupParametersMode === 'inherit') {
            return loc.workspaceDefaults || 'Use workspace defaults';
        }
        return loc.noLaunchKeys || 'No launch keys';
    }

    function isManualSortMode() {
        return state.sortMode === 'manual';
    }

    function getSortModeLabel(sortMode) {
        if (sortMode === 'alphabetical') {
            return loc.sortAlphabetical || 'Alphabetical';
        }
        if (sortMode === 'manual') {
            return loc.sortManual || 'Manual order';
        }
        return loc.sortLastOpened || 'Last opened';
    }

    function isManualDragEnabled() {
        return isManualSortMode() && !state.pendingAction;
    }

    function clearDropIndicator() {
        if (!(refs.infobaseList instanceof HTMLElement)) {
            return;
        }

        refs.infobaseList.querySelectorAll('.infobase-item.is-drop-before, .infobase-item.is-drop-after, .infobase-item.is-dragging')
            .forEach(item => item.classList.remove('is-drop-before', 'is-drop-after', 'is-dragging'));
        dragState.targetPath = '';
        dragState.placement = 'before';
    }

    function getDropPlacement(target, clientY) {
        const bounds = target.getBoundingClientRect();
        return clientY >= bounds.top + bounds.height / 2
            ? 'after'
            : 'before';
    }

    function renderList() {
        if (!(refs.infobaseList instanceof HTMLElement)) {
            return;
        }

        const visibleInfobases = getVisibleInfobases().filter(matchesSearch);
        const manualDragEnabled = isManualDragEnabled();
        if (refs.infobaseCountValue instanceof HTMLElement) {
            refs.infobaseCountValue.textContent = String(visibleInfobases.length || 0);
        }

        if (!visibleInfobases.length) {
            refs.infobaseList.innerHTML = `
                <div class="list-empty">
                    <strong>${escapeHtml(loc.noInfobases || 'No infobases discovered yet.')}</strong>
                    <p>${escapeHtml(loc.noInfobasesHint || '')}</p>
                </div>
            `;
            return;
        }

        refs.infobaseList.innerHTML = visibleInfobases.map(record => {
            const isSelected = record.infobasePath === state.selectedInfobasePath;
            const lastActivity = getLastActivity(record);
            const launcherState = record.launcherRegistered
                ? (loc.launcherRegistered || 'Registered in 1C launcher')
                : (loc.launcherNotRegistered || 'Not registered in 1C launcher');
            return `
                <button class="infobase-item${isSelected ? ' is-selected' : ''}${manualDragEnabled ? ' is-draggable' : ''}${record.hidden ? ' is-hidden-infobase' : ''}" type="button" data-path="${escapeHtml(record.infobasePath)}" draggable="${manualDragEnabled ? 'true' : 'false'}">
                    <div class="infobase-item-head">
                        <div class="infobase-item-title-row">
                            ${manualDragEnabled ? '<span class="codicon codicon-gripper item-grip" aria-hidden="true"></span>' : ''}
                            <span class="infobase-item-title">${escapeHtml(record.displayName)}</span>
                        </div>
                        <span class="state-pill compact is-${escapeHtml(record.state)}">${escapeHtml(getStateLabel(record.state))}</span>
                    </div>
                    <div class="infobase-item-path">${escapeHtml(record.locationLabel || record.infobasePath)}</div>
                    <div class="infobase-item-meta">
                        <span>${escapeHtml(launcherState)}</span>
                        ${record.hidden ? `<span class="hidden-chip">${escapeHtml(loc.hidden || 'Hidden')}</span>` : ''}
                    </div>
                    <div class="infobase-item-activity">
                        <span>${escapeHtml(loc.lastActivity || 'Last activity')}: ${escapeHtml(lastActivity ? formatDate(lastActivity) : (loc.none || 'None'))}</span>
                    </div>
                </button>
            `;
        }).join('');
        syncAutoScrollText(
            refs.infobaseList,
            '.infobase-item-title, .infobase-item-path, .infobase-item-activity'
        );
    }

    function measureSectionBodyHeight(body) {
        if (!(body instanceof HTMLElement)) {
            return 1;
        }

        const inner = body.querySelector('.section-card-inner');
        const innerHeight = inner instanceof HTMLElement ? inner.scrollHeight : 0;
        return Math.max(body.scrollHeight, innerHeight, 1);
    }

    function applyTechnicalSectionExpandedState(expanded, animate) {
        if (!(refs.technicalToggle instanceof HTMLElement) || !(refs.technicalBody instanceof HTMLElement)) {
            return;
        }

        refs.technicalToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const sectionCard = refs.technicalBody.closest('.section-card');
        if (sectionCard instanceof HTMLElement) {
            sectionCard.classList.toggle('is-expanded', expanded);
            sectionCard.classList.toggle('is-collapsed', !expanded);
        }
        if (refs.technicalToggleIcon instanceof HTMLElement) {
            refs.technicalToggleIcon.classList.toggle('codicon-chevron-right', !expanded);
            refs.technicalToggleIcon.classList.toggle('codicon-chevron-down', expanded);
        }

        if (!animate) {
            refs.technicalBody.classList.toggle('is-collapsed', !expanded);
            refs.technicalBody.style.maxHeight = expanded ? 'none' : '0px';
            return;
        }

        if (expanded) {
            refs.technicalBody.classList.remove('is-collapsed');
            refs.technicalBody.style.maxHeight = '0px';
            void refs.technicalBody.offsetHeight;
            refs.technicalBody.style.maxHeight = `${measureSectionBodyHeight(refs.technicalBody)}px`;
            window.setTimeout(() => {
                if (uiState.technicalExpanded) {
                    refs.technicalBody.style.maxHeight = 'none';
                }
            }, 260);
            return;
        }

        refs.technicalBody.style.maxHeight = `${measureSectionBodyHeight(refs.technicalBody)}px`;
        void refs.technicalBody.offsetHeight;
        refs.technicalBody.classList.add('is-collapsed');
        refs.technicalBody.style.maxHeight = '0px';
    }

    function syncTechnicalSection() {
        applyTechnicalSectionExpandedState(uiState.technicalExpanded, false);
    }

    function toggleSortMenu(open) {
        uiState.sortMenuOpen = open;
        if (open) {
            uiState.moreActionsOpen = false;
            uiState.launchPlatformMenuOpen = false;
        }
        if (refs.sortMenuBtn instanceof HTMLElement) {
            refs.sortMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        if (refs.sortMenu instanceof HTMLElement) {
            refs.sortMenu.classList.toggle('is-open', open);
        }
        if (open) {
            if (refs.moreActionsBtn instanceof HTMLElement) {
                refs.moreActionsBtn.setAttribute('aria-expanded', 'false');
            }
            if (refs.moreActionsMenu instanceof HTMLElement) {
                refs.moreActionsMenu.classList.remove('is-open');
            }
            if (refs.launchPlatformBtn instanceof HTMLElement) {
                refs.launchPlatformBtn.setAttribute('aria-expanded', 'false');
            }
            if (refs.launchPlatformMenu instanceof HTMLElement) {
                refs.launchPlatformMenu.classList.remove('is-open');
            }
        }
    }

    function toggleMoreActions(open) {
        uiState.moreActionsOpen = open;
        if (open) {
            toggleSortMenu(false);
            toggleLaunchPlatformMenu(false);
        }
        if (refs.moreActionsBtn instanceof HTMLElement) {
            refs.moreActionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        if (refs.moreActionsMenu instanceof HTMLElement) {
            refs.moreActionsMenu.classList.toggle('is-open', open);
        }
    }

    function toggleLaunchPlatformMenu(open) {
        uiState.launchPlatformMenuOpen = open;
        if (open) {
            toggleSortMenu(false);
            toggleMoreActions(false);
        }
        if (refs.launchPlatformBtn instanceof HTMLElement) {
            refs.launchPlatformBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        if (refs.launchPlatformMenu instanceof HTMLElement) {
            refs.launchPlatformMenu.classList.toggle('is-open', open);
        }
    }

    function renderLaunchPlatformMenu(selectedInfobase) {
        if (!(refs.launchPlatformMenu instanceof HTMLElement)) {
            return;
        }

        const configuredPlatforms = getConfiguredPlatforms();
        const effectivePlatform = resolveEffectiveLaunchPlatform(selectedInfobase);
        refs.launchPlatformMenu.classList.toggle('is-open', uiState.launchPlatformMenuOpen);
        if (!uiState.launchPlatformMenuOpen) {
            refs.launchPlatformMenu.innerHTML = '';
            return;
        }

        if (!selectedInfobase || !configuredPlatforms.length) {
            refs.launchPlatformMenu.innerHTML = `
                <div class="menu-item platform-menu-empty" role="presentation">
                    <span>${escapeHtml(loc.none || 'None')}</span>
                </div>
            `;
            return;
        }

        const defaultPlatformPath = normalizePlatformPath(getDefaultPlatform()?.clientExePath || '');
        refs.launchPlatformMenu.innerHTML = configuredPlatforms.map(platform => {
            const clientExePath = String(platform?.clientExePath || '');
            const isSelected = normalizePlatformPath(clientExePath) === normalizePlatformPath(effectivePlatform?.clientExePath || '');
            const isDefault = normalizePlatformPath(clientExePath) === defaultPlatformPath;
            const detailParts = [];
            if (isDefault) {
                detailParts.push(loc.defaultLabel || 'Default');
            }
            detailParts.push(clientExePath);
            return `
                <button
                    class="menu-item platform-menu-item${isSelected ? ' is-selected' : ''}"
                    type="button"
                    data-platform-path="${escapeHtml(clientExePath)}"
                    title="${escapeHtml(clientExePath)}"
                >
                    <span class="codicon codicon-check sort-menu-check" aria-hidden="true"></span>
                    <span class="platform-menu-copy">
                        <span class="platform-menu-title">${escapeHtml(String(platform?.name || clientExePath))}</span>
                        <span class="platform-menu-detail">${escapeHtml(detailParts.join(' • '))}</span>
                    </span>
                </button>
            `;
        }).join('');
    }

    function renderDetails() {
        const selected = getSelectedInfobase();
        const hasSelection = Boolean(selected);

        if (refs.emptyState instanceof HTMLElement) {
            refs.emptyState.classList.toggle('hidden', hasSelection);
        }
        if (refs.detailsContent instanceof HTMLElement) {
            refs.detailsContent.classList.toggle('hidden', !hasSelection);
        }

        const actionButtons = Array.from(document.querySelectorAll('[data-requires-selection="true"]'));
        actionButtons.forEach(button => {
            if (button instanceof HTMLButtonElement) {
                button.disabled = !hasSelection || Boolean(state.pendingAction);
            }
        });

        if (!selected) {
            toggleMoreActions(false);
            toggleLaunchPlatformMenu(false);
            if (refs.launchPlatformLabel instanceof HTMLElement) {
                refs.launchPlatformLabel.textContent = loc.launchPlatform || loc.platform || 'Platform';
            }
            return;
        }

        if (refs.infobaseTitle instanceof HTMLElement) {
            refs.infobaseTitle.textContent = selected.displayName || '';
        }
        if (refs.infobasePath instanceof HTMLElement) {
            refs.infobasePath.textContent = selected.locationLabel || selected.infobasePath || '';
        }
        if (refs.stateBadge instanceof HTMLElement) {
            refs.stateBadge.textContent = getStateLabel(selected.state);
            refs.stateBadge.className = `state-pill compact is-${selected.state || 'ready'}`;
            refs.stateBadge.title = getStateHint(selected.state);
        }
        if (refs.lastLaunchValue instanceof HTMLElement) {
            refs.lastLaunchValue.textContent = formatLastLaunch(selected);
        }
        if (refs.lastRunLogValue instanceof HTMLElement) {
            refs.lastRunLogValue.textContent = formatValueWithPath(selected.lastRunLogAt, selected.lastRunLogPath);
        }
        if (refs.startupParametersValue instanceof HTMLElement) {
            refs.startupParametersValue.textContent = getStartupParametersLabel(selected);
        }
        if (refs.launcherValue instanceof HTMLElement) {
            refs.launcherValue.textContent = selected.launcherRegistered
                ? (selected.launcherName || (loc.launcherRegistered || 'Registered in 1C launcher'))
                : (loc.launcherNotRegistered || 'Not registered in 1C launcher');
        }
        if (refs.rolesValue instanceof HTMLElement) {
            refs.rolesValue.textContent = (selected.roles || []).map(getRoleLabel).join(', ') || (loc.none || 'None');
        }
        if (refs.sourcesValue instanceof HTMLElement) {
            refs.sourcesValue.textContent = (selected.sources || []).map(getSourceLabel).join(', ') || (loc.none || 'None');
        }
        if (refs.lastSnapshotValue instanceof HTMLElement) {
            refs.lastSnapshotValue.textContent = formatValueWithPath(selected.lastSnapshotAt, selected.lastSnapshotPath);
        }
        if (refs.existsValue instanceof HTMLElement) {
            refs.existsValue.textContent = selected.exists ? (loc.present || 'Present') : (loc.absent || 'Absent');
        }
        if (refs.markerValue instanceof HTMLElement) {
            refs.markerValue.textContent = selected.markerExists ? (loc.present || 'Present') : (loc.absent || 'Absent');
        }
        if (refs.addToLauncherAction instanceof HTMLElement) {
            refs.addToLauncherAction.classList.toggle('hidden', selected.launcherRegistered);
        }
        if (refs.removeFromLauncherAction instanceof HTMLElement) {
            refs.removeFromLauncherAction.classList.toggle('hidden', !selected.launcherRegistered);
        }
        if (refs.forgetManualAction instanceof HTMLElement) {
            refs.forgetManualAction.classList.toggle('hidden', !(selected.sources || []).includes('manual'));
        }
        if (refs.toggleHiddenActionLabel instanceof HTMLElement) {
            refs.toggleHiddenActionLabel.textContent = selected.hidden
                ? (loc.unhideInfobase || 'Unhide infobase')
                : (loc.hideInfobase || 'Hide infobase');
        }

        const showLogsAction = document.querySelector('[data-command="showLogs"]');
        if (showLogsAction instanceof HTMLButtonElement) {
            showLogsAction.disabled = !selected.logTargets?.length || Boolean(state.pendingAction);
        }
        const revealFolderAction = document.querySelector('[data-command="revealFolder"]');
        if (revealFolderAction instanceof HTMLButtonElement) {
            revealFolderAction.disabled = !supportsFileOperations(selected) || !selected.exists || Boolean(state.pendingAction);
        }
        const copyBaseAction = document.querySelector('[data-command="copyBase"]');
        if (copyBaseAction instanceof HTMLButtonElement) {
            copyBaseAction.disabled = !supportsFileOperations(selected) || !selected.exists || Boolean(state.pendingAction);
        }
        const recreateAction = document.querySelector('[data-command="recreate"]');
        if (recreateAction instanceof HTMLButtonElement) {
            recreateAction.disabled = !supportsFileOperations(selected) || Boolean(state.pendingAction);
        }
        const editBaseAction = document.querySelector('[data-command="editBase"]');
        if (editBaseAction instanceof HTMLButtonElement) {
            editBaseAction.disabled = !supportsFileOperations(selected) || Boolean(state.pendingAction);
        }
        const saveCfAction = document.querySelector('[data-command="saveCf"]');
        if (saveCfAction instanceof HTMLButtonElement) {
            saveCfAction.disabled = !supportsDesignerOperations(selected) || Boolean(state.pendingAction);
        }
        const openDesignerAction = document.querySelector('[data-command="openDesigner"]');
        if (openDesignerAction instanceof HTMLButtonElement) {
            openDesignerAction.disabled = !supportsDesignerOperations(selected) || Boolean(state.pendingAction);
        }
        const startFormExplorerAction = document.querySelector('[data-command="startFormExplorer"]');
        if (startFormExplorerAction instanceof HTMLButtonElement) {
            startFormExplorerAction.disabled = !supportsDesignerOperations(selected) || Boolean(state.pendingAction);
        }
        const restoreDtAction = document.querySelector('[data-command="restoreDt"]');
        if (restoreDtAction instanceof HTMLButtonElement) {
            restoreDtAction.disabled = !supportsDesignerOperations(selected) || Boolean(state.pendingAction);
        }
        const exportDtAction = document.querySelector('[data-command="exportDt"]');
        if (exportDtAction instanceof HTMLButtonElement) {
            exportDtAction.disabled = !supportsDesignerOperations(selected) || Boolean(state.pendingAction);
        }
        const updateConfigAction = document.querySelector('[data-command="updateConfig"]');
        if (updateConfigAction instanceof HTMLButtonElement) {
            updateConfigAction.disabled = !supportsDesignerOperations(selected) || Boolean(state.pendingAction);
        }
        const effectivePlatform = resolveEffectiveLaunchPlatform(selected);
        const launchPlatformLabel = formatPlatformButtonLabel(effectivePlatform);
        if (refs.launchPlatformBtn instanceof HTMLButtonElement) {
            refs.launchPlatformBtn.disabled = Boolean(state.pendingAction) || getConfiguredPlatforms().length === 0;
            refs.launchPlatformBtn.title = effectivePlatform?.clientExePath || launchPlatformLabel;
        }
        if (refs.launchPlatformLabel instanceof HTMLElement) {
            refs.launchPlatformLabel.textContent = launchPlatformLabel;
            refs.launchPlatformLabel.title = effectivePlatform?.clientExePath || launchPlatformLabel;
        }
        renderLaunchPlatformMenu(selected);

        syncTechnicalSection();
    }

    function renderStatus() {
        if (refs.statusChip instanceof HTMLElement && refs.statusValue instanceof HTMLElement) {
            const chipState = state.pendingAction
                ? 'busy'
                : (state.lastError ? 'error' : 'idle');
            const statusText = state.pendingAction
                ? shortenStatusText(state.pendingAction)
                : (state.lastError ? (loc.lastError || 'Error') : getStateLabel('ready'));
            refs.statusChip.setAttribute('data-state', chipState);
            refs.statusChip.title = state.pendingAction || state.lastError || '';
            refs.statusValue.textContent = statusText;
        }

        const hasError = Boolean(state.lastError);
        if (refs.errorPanel instanceof HTMLElement) {
            refs.errorPanel.classList.toggle('hidden', !hasError);
        }
        if (refs.errorValue instanceof HTMLElement) {
            refs.errorValue.textContent = hasError ? state.lastError : '';
        }
    }

    function render() {
        if (refs.searchInput instanceof HTMLInputElement && refs.searchInput.value !== uiState.searchQuery) {
            refs.searchInput.value = uiState.searchQuery;
        }
        if (refs.sortMenuLabel instanceof HTMLElement) {
            refs.sortMenuLabel.textContent = getSortModeLabel(state.sortMode);
            refs.sortMenuLabel.title = getSortModeLabel(state.sortMode);
        }
        if (refs.sortMenu instanceof HTMLElement) {
            refs.sortMenu.querySelectorAll('[data-sort-mode]').forEach(item => {
                if (!(item instanceof HTMLElement)) {
                    return;
                }
                item.classList.toggle('is-selected', item.dataset.sortMode === state.sortMode);
            });
            refs.sortMenu.querySelectorAll('[data-toggle-show-hidden]').forEach(item => {
                if (!(item instanceof HTMLElement)) {
                    return;
                }
                item.classList.toggle('is-selected', Boolean(state.showHidden));
            });
        }

        renderList();
        renderDetails();
        renderStatus();
    }

    refs.refreshBtn?.addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
    });

    refs.createBtn?.addEventListener('click', () => {
        vscode.postMessage({ command: 'create' });
    });

    refs.addManualBtn?.addEventListener('click', () => {
        vscode.postMessage({ command: 'addManual' });
    });

    refs.manageEtalonBasesBtn?.addEventListener('click', () => {
        vscode.postMessage({ command: 'manageEtalonBases' });
    });

    refs.searchInput?.addEventListener('input', event => {
        uiState.searchQuery = event.target instanceof HTMLInputElement ? event.target.value : '';
        persistUiState();
        render();
    });

    refs.sortMenuBtn?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggleSortMenu(!uiState.sortMenuOpen);
    });

    refs.technicalToggle?.addEventListener('click', () => {
        uiState.technicalExpanded = !uiState.technicalExpanded;
        persistUiState();
        applyTechnicalSectionExpandedState(uiState.technicalExpanded, true);
    });

    refs.moreActionsBtn?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggleMoreActions(!uiState.moreActionsOpen);
    });

    refs.launchPlatformBtn?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.pendingAction || !getConfiguredPlatforms().length) {
            return;
        }
        toggleLaunchPlatformMenu(!uiState.launchPlatformMenuOpen);
        renderLaunchPlatformMenu(getSelectedInfobase());
    });

    refs.infobaseList?.addEventListener('click', event => {
        const target = event.target instanceof HTMLElement
            ? event.target.closest('.infobase-item')
            : null;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const targetPath = target.dataset.path || '';
        if (!targetPath) {
            return;
        }

        const targetRecord = getInfobaseByPath(targetPath);
        if (!targetRecord) {
            return;
        }

        const now = Date.now();
        const isDoubleClick = clickState.lastInfobasePath === targetPath
            && now - clickState.lastTimestamp <= 400;
        clickState.lastInfobasePath = targetPath;
        clickState.lastTimestamp = now;

        state.selectedInfobasePath = targetPath;
        render();
        vscode.postMessage({ command: 'select', infobasePath: targetPath });
        if (isDoubleClick && !state.pendingAction) {
            vscode.postMessage({
                command: 'openEnterprise',
                infobasePath: targetPath,
                platformClientExePath: getEffectiveLaunchPlatformClientExePath(targetRecord)
            });
        }
    });

    refs.infobaseList?.addEventListener('dragstart', event => {
        const target = event.target instanceof HTMLElement
            ? event.target.closest('.infobase-item')
            : null;
        if (!(target instanceof HTMLElement) || !isManualDragEnabled()) {
            event.preventDefault();
            return;
        }

        const targetPath = target.dataset.path || '';
        if (!targetPath) {
            event.preventDefault();
            return;
        }

        dragState.draggedPath = targetPath;
        target.classList.add('is-dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', targetPath);
        }
    });

    refs.infobaseList?.addEventListener('dragover', event => {
        if (!isManualDragEnabled() || !dragState.draggedPath) {
            return;
        }

        const target = event.target instanceof HTMLElement
            ? event.target.closest('.infobase-item')
            : null;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const targetPath = target.dataset.path || '';
        if (!targetPath || targetPath === dragState.draggedPath) {
            return;
        }

        event.preventDefault();
        clearDropIndicator();
        const placement = getDropPlacement(target, event.clientY);
        target.classList.add(placement === 'after' ? 'is-drop-after' : 'is-drop-before');
        dragState.targetPath = targetPath;
        dragState.placement = placement;
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
    });

    refs.infobaseList?.addEventListener('drop', event => {
        if (!isManualDragEnabled() || !dragState.draggedPath || !dragState.targetPath) {
            clearDropIndicator();
            dragState.draggedPath = '';
            return;
        }

        event.preventDefault();
        const movedInfobasePath = dragState.draggedPath;
        const targetInfobasePath = dragState.targetPath;
        const dropPlacement = dragState.placement;
        clearDropIndicator();
        dragState.draggedPath = '';
        vscode.postMessage({
            command: 'reorderManual',
            movedInfobasePath,
            targetInfobasePath,
            dropPlacement
        });
    });

    refs.infobaseList?.addEventListener('dragend', () => {
        clearDropIndicator();
        dragState.draggedPath = '';
    });

    document.body.addEventListener('click', event => {
        const actionTarget = event.target instanceof HTMLElement
            ? event.target.closest('[data-command]')
            : null;

        if (actionTarget instanceof HTMLElement) {
            const command = actionTarget.dataset.command || '';
            const selected = getSelectedInfobase();
            if (command && selected) {
                toggleMoreActions(false);
                toggleLaunchPlatformMenu(false);
                vscode.postMessage({
                    command,
                    infobasePath: selected.infobasePath,
                    platformClientExePath: getEffectiveLaunchPlatformClientExePath(selected)
                });
                return;
            }
        }

        const platformTarget = event.target instanceof HTMLElement
            ? event.target.closest('[data-platform-path]')
            : null;
        if (platformTarget instanceof HTMLElement) {
            const selected = getSelectedInfobase();
            const platformClientExePath = platformTarget.dataset.platformPath || '';
            if (selected && platformClientExePath) {
                toggleLaunchPlatformMenu(false);
                vscode.postMessage({
                    command: 'setPreferredPlatform',
                    infobasePath: selected.infobasePath,
                    platformClientExePath
                });
            }
            return;
        }

        const sortTarget = event.target instanceof HTMLElement
            ? event.target.closest('[data-sort-mode]')
            : null;
        if (sortTarget instanceof HTMLElement) {
            const sortMode = sortTarget.dataset.sortMode || '';
            if (sortMode) {
                toggleSortMenu(false);
                vscode.postMessage({ command: 'setSortMode', sortMode });
                return;
            }
        }

        const toggleHiddenTarget = event.target instanceof HTMLElement
            ? event.target.closest('[data-toggle-show-hidden]')
            : null;
        if (toggleHiddenTarget instanceof HTMLElement) {
            vscode.postMessage({ command: 'setShowHidden', showHidden: !state.showHidden });
            return;
        }

        if (!(event.target instanceof HTMLElement) || !event.target.closest('.menu-shell')) {
            toggleMoreActions(false);
            toggleSortMenu(false);
            toggleLaunchPlatformMenu(false);
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            toggleMoreActions(false);
            toggleSortMenu(false);
            toggleLaunchPlatformMenu(false);
        }
    });

    window.addEventListener('resize', () => {
        syncAutoScrollText(
            refs.infobaseList instanceof HTMLElement ? refs.infobaseList : document.body,
            '.infobase-item-title, .infobase-item-path, .infobase-item-activity'
        );
    });

    window.addEventListener('message', event => {
        const message = event.data || {};
        if (message.command !== 'renderState') {
            return;
        }

        state = message.state || state;
        render();
    });

    render();
})();
