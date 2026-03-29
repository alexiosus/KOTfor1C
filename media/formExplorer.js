(function() {
    const vscode = acquireVsCodeApi();
    const loc = window.__formExplorerLoc || {};
    let viewState = window.__formExplorerInitialState || {};
    const persistedState = vscode.getState() || {};
    let copiedResetTimer = null;
    let overflowMenuOpen = false;
    let filterMenuOpen = false;
    let launchPlatformMenuOpen = false;
    let lastSelectionPosted = '';
    let focusAfterLocatorPending = false;
    let locatorFocusBaseline = '';
    const suggestedStepsCache = new Map();
    const autoScrollAnimations = new WeakMap();

    const uiState = {
        selectedElementPath: typeof persistedState.selectedElementPath === 'string' ? persistedState.selectedElementPath : '',
        searchQuery: typeof persistedState.searchQuery === 'string' ? persistedState.searchQuery : '',
        showTechnical: Boolean(persistedState.showTechnical),
        showGroups: Boolean(persistedState.showGroups),
        showTechnicalInfo: typeof persistedState.showTechnicalInfo === 'boolean'
            ? persistedState.showTechnicalInfo
            : false,
        followActive: persistedState.followActive !== false,
        detailsExpanded: typeof persistedState.detailsExpanded === 'boolean'
            ? persistedState.detailsExpanded
            : false,
        suggestedStepsExpanded: persistedState.suggestedStepsExpanded !== false,
        activeTab: isKnownTab(persistedState.activeTab) ? persistedState.activeTab : 'selected'
    };

    let pendingScrollPath = '';
    let pendingScrollReset = false;

    const refs = {
        currentFormPanel: document.getElementById('currentFormPanel'),
        moreActionsBtn: document.getElementById('moreActionsBtn'),
        moreActionsMenu: document.getElementById('moreActionsMenu'),
        openSettingsBtn: document.getElementById('openSettingsBtn'),
        openSnapshotFileBtn: document.getElementById('openSnapshotFileBtn'),
        revealSnapshotFileBtn: document.getElementById('revealSnapshotFileBtn'),
        currentFormOpenSourceBtn: document.getElementById('currentFormOpenSourceBtn'),
        manualRefreshBtn: document.getElementById('manualRefreshBtn'),
        focusActiveBtn: document.getElementById('focusActiveBtn'),
        locatorBtn: document.getElementById('locatorBtn'),
        filterMenuBtn: document.getElementById('filterMenuBtn'),
        filterMenu: document.getElementById('filterMenu'),
        searchFrame: document.getElementById('searchFrame'),
        showTechnicalTabsInput: document.getElementById('showTechnicalTabsInput'),
        showTechnicalInput: document.getElementById('showTechnicalInput'),
        showGroupsInput: document.getElementById('showGroupsInput'),
        searchInput: document.getElementById('searchInput'),
        alertBanner: document.getElementById('alertBanner'),
        alertText: document.getElementById('alertText'),
        modeChip: document.getElementById('modeChip'),
        modeValue: document.getElementById('modeValue'),
        generatedAtChip: document.getElementById('generatedAtChip'),
        generatedAtLabel: document.getElementById('generatedAtLabel'),
        generatedAtValue: document.getElementById('generatedAtValue'),
        startInfobaseBtn: document.getElementById('startInfobaseBtn'),
        startInfobaseLabel: document.getElementById('startInfobaseLabel'),
        launchPlatformBtn: document.getElementById('launchPlatformBtn'),
        launchPlatformLabel: document.getElementById('launchPlatformLabel'),
        launchPlatformMenu: document.getElementById('launchPlatformMenu'),
        formTitleValue: document.getElementById('formTitleValue'),
        formMetaLine: document.getElementById('formMetaLine'),
        elementCountValue: document.getElementById('elementCountValue'),
        elementTree: document.getElementById('elementTree'),
        selectedKeyFacts: document.getElementById('selectedKeyFacts'),
        selectedStateRow: document.getElementById('selectedStateRow'),
        detailsPanel: document.getElementById('detailsPanel'),
        attributesPanel: document.getElementById('attributesPanel'),
        commandsPanel: document.getElementById('commandsPanel'),
        detailsTabsBar: document.getElementById('detailsTabsBar'),
        attributeCountValue: document.getElementById('attributeCountValue'),
        commandCountValue: document.getElementById('commandCountValue')
    };

    const tabButtons = Array.from(document.querySelectorAll('[data-tab]'));
    const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'));

    initialize();

    function normalizePlatformPath(rawPath) {
        const source = String(rawPath || '').trim();
        if (!source) {
            return '';
        }

        return source.replace(/[\\/]+/g, '/').toLowerCase();
    }

    function getConfiguredPlatforms() {
        return Array.isArray(viewState.platforms) ? viewState.platforms : [];
    }

    function getDefaultPlatform() {
        return getConfiguredPlatforms()[0] || null;
    }

    function resolveCurrentLaunchPlatform() {
        const configuredPlatforms = getConfiguredPlatforms();
        if (!configuredPlatforms.length) {
            return null;
        }

        const preferredPlatformPath = normalizePlatformPath(viewState.launchPlatformClientExePath || '');
        if (preferredPlatformPath) {
            const preferredPlatform = configuredPlatforms.find(platform =>
                normalizePlatformPath(platform?.clientExePath || '') === preferredPlatformPath
            );
            if (preferredPlatform) {
                return preferredPlatform;
            }
        }

        return getDefaultPlatform();
    }

    function getCurrentLaunchPlatformClientExePath() {
        return resolveCurrentLaunchPlatform()?.clientExePath || null;
    }

    function formatPlatformButtonLabel(platform) {
        if (!platform) {
            return t('launchPlatform', 'Platform');
        }

        const platformName = String(platform?.name || '').trim();
        const versionMatch = platformName.match(/(\d+(?:\.\d+)+)\s*$/);
        if (versionMatch?.[1]) {
            return versionMatch[1];
        }

        return platformName || String(platform?.clientExePath || '').trim() || t('launchPlatform', 'Platform');
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

    function initialize() {
        bindStaticEvents();
        if (refs.searchInput instanceof HTMLInputElement) {
            refs.searchInput.value = uiState.searchQuery;
        }
        render();
        window.addEventListener('message', event => {
            const message = event.data || {};
            if (message.command === 'setState') {
                viewState = message.state || {};
                const suggestedPath = typeof viewState.suggestedStepsForPath === 'string'
                    ? viewState.suggestedStepsForPath
                    : '';
                if (suggestedPath && Array.isArray(viewState.suggestedSteps)) {
                    suggestedStepsCache.set(suggestedPath, viewState.suggestedSteps.slice());
                } else {
                    const selectedPath = typeof viewState.selectedElementPath === 'string'
                        ? viewState.selectedElementPath
                        : '';
                    if (selectedPath && Array.isArray(viewState.suggestedSteps) && viewState.suggestedSteps.length > 0) {
                        suggestedStepsCache.set(selectedPath, viewState.suggestedSteps.slice());
                    }
                }
                if (focusAfterLocatorPending) {
                    const currentStamp = String(viewState.snapshotMtime || viewState?.snapshot?.generatedAt || '');
                    const activePath = viewState?.snapshot?.form?.activeElementPath || findActiveElementPath(viewState?.snapshot?.elements || []);
                    const hasFreshSnapshot = !locatorFocusBaseline || (currentStamp && currentStamp !== locatorFocusBaseline);
                    if (activePath && hasFreshSnapshot) {
                        uiState.searchQuery = '';
                        if (refs.searchInput instanceof HTMLInputElement) {
                            refs.searchInput.value = '';
                        }
                        uiState.followActive = true;
                        uiState.selectedElementPath = activePath;
                        pendingScrollPath = activePath;
                        persistUiState();
                        focusAfterLocatorPending = false;
                        locatorFocusBaseline = '';
                    }
                }
                render();
            }
        });
        vscode.postMessage({ command: 'ready' });
    }

    function bindStaticEvents() {
        bindClick(refs.moreActionsBtn, event => {
            event.preventDefault();
            event.stopPropagation();
            filterMenuOpen = false;
            launchPlatformMenuOpen = false;
            overflowMenuOpen = !overflowMenuOpen;
            renderOverflowMenu();
            renderFilterMenu();
            renderLaunchPlatformMenu();
        });
        bindClick(refs.filterMenuBtn, event => {
            event.preventDefault();
            event.stopPropagation();
            overflowMenuOpen = false;
            launchPlatformMenuOpen = false;
            filterMenuOpen = !filterMenuOpen;
            renderFilterMenu();
            renderOverflowMenu();
            renderLaunchPlatformMenu();
        });
        bindClick(refs.modeChip, event => {
            event.preventDefault();
            event.stopPropagation();
            overflowMenuOpen = false;
            filterMenuOpen = false;
            launchPlatformMenuOpen = false;
            renderOverflowMenu();
            renderFilterMenu();
            renderLaunchPlatformMenu();
            post('toggleAdapterMode');
        });
        bindClick(refs.launchPlatformBtn, event => {
            event.preventDefault();
            event.stopPropagation();
            overflowMenuOpen = false;
            filterMenuOpen = false;
            launchPlatformMenuOpen = !launchPlatformMenuOpen;
            renderOverflowMenu();
            renderFilterMenu();
            renderLaunchPlatformMenu();
        });
        bindClick(refs.startInfobaseBtn, () => {
            launchPlatformMenuOpen = false;
            renderLaunchPlatformMenu();
            post('startInfobase', {
                platformClientExePath: getCurrentLaunchPlatformClientExePath()
            });
        });
        bindClick(refs.manualRefreshBtn, () => post('requestAdapterRefresh'));
        bindClick(refs.locatorBtn, () => {
            focusAfterLocatorPending = true;
            locatorFocusBaseline = String(viewState.snapshotMtime || viewState?.snapshot?.generatedAt || '');
            post('requestAdapterLocator');
        });
        bindClick(refs.openSettingsBtn, () => post('openSettings'));
        bindClick(refs.openSnapshotFileBtn, () => post('openSnapshotFile'));
        bindClick(refs.revealSnapshotFileBtn, () => post('revealSnapshotFile'));
        bindClick(refs.currentFormOpenSourceBtn, event => {
            const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
            if (!(target instanceof HTMLElement) || !target.dataset.path) {
                return;
            }
            post('openSourceLocation', {
                source: {
                    path: target.dataset.path,
                    line: parseNumber(target.dataset.line),
                    column: parseNumber(target.dataset.column)
                }
            });
        });
        bindClick(refs.focusActiveBtn, () => focusActiveElement());
        if (refs.showTechnicalTabsInput instanceof HTMLInputElement) {
            refs.showTechnicalTabsInput.checked = uiState.showTechnicalInfo;
            refs.showTechnicalTabsInput.addEventListener('change', () => {
                uiState.showTechnicalInfo = refs.showTechnicalTabsInput.checked;
                if (!uiState.showTechnicalInfo && (uiState.activeTab === 'attributes' || uiState.activeTab === 'commands')) {
                    uiState.activeTab = 'selected';
                }
                persistUiState();
                renderTabs();
            });
        }
        if (refs.showTechnicalInput instanceof HTMLInputElement) {
            refs.showTechnicalInput.checked = uiState.showTechnical;
            refs.showTechnicalInput.addEventListener('change', () => {
                uiState.showTechnical = refs.showTechnicalInput.checked;
                pendingScrollReset = true;
                persistUiState();
                render();
            });
        }
        if (refs.showGroupsInput instanceof HTMLInputElement) {
            refs.showGroupsInput.checked = uiState.showGroups;
            refs.showGroupsInput.addEventListener('change', () => {
                uiState.showGroups = refs.showGroupsInput.checked;
                pendingScrollReset = true;
                persistUiState();
                render();
            });
        }

        if (refs.searchInput instanceof HTMLInputElement) {
            refs.searchInput.addEventListener('input', () => {
                uiState.searchQuery = refs.searchInput.value || '';
                pendingScrollReset = true;
                persistUiState();
                render();
            });
        }
        for (const button of tabButtons) {
            button.addEventListener('click', () => {
                const nextTab = String(button.dataset.tab || '');
                if (!isKnownTab(nextTab)) {
                    return;
                }
                uiState.activeTab = nextTab;
                persistUiState();
                renderTabs();
            });
        }

        document.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const action = String(target.dataset.action || '');
            if (action === 'select-element') {
                overflowMenuOpen = false;
                renderOverflowMenu();
                uiState.selectedElementPath = String(target.dataset.path || '');
                uiState.followActive = false;
                pendingScrollPath = uiState.selectedElementPath;
                persistUiState();
                render();
                return;
            }

            if (action === 'focus-active') {
                overflowMenuOpen = false;
                renderOverflowMenu();
                focusActiveElement();
                return;
            }

            if (action === 'toggle-details') {
                uiState.detailsExpanded = !uiState.detailsExpanded;
                persistUiState();
                if (!toggleSectionCard('details', uiState.detailsExpanded)) {
                    renderElementDetails(viewState.snapshot, getSelectedElementFromState(viewState.snapshot));
                }
                return;
            }

            if (action === 'toggle-suggested-steps') {
                uiState.suggestedStepsExpanded = !uiState.suggestedStepsExpanded;
                persistUiState();
                if (!toggleSectionCard('suggested', uiState.suggestedStepsExpanded)) {
                    renderElementDetails(viewState.snapshot, getSelectedElementFromState(viewState.snapshot));
                }
                if (uiState.suggestedStepsExpanded) {
                    const selectedPath = uiState.selectedElementPath || '';
                    const suggestionsPath = String(viewState.suggestedStepsForPath || '');
                    if (selectedPath && suggestionsPath !== selectedPath) {
                        post('selectElementPath', { value: selectedPath });
                    }
                }
                return;
            }

            if (action === 'copy') {
                overflowMenuOpen = false;
                filterMenuOpen = false;
                launchPlatformMenuOpen = false;
                renderOverflowMenu();
                renderFilterMenu();
                renderLaunchPlatformMenu();
                post('copyToClipboard', { value: String(target.dataset.value || '') });
                flashCopied(target);
                return;
            }

            if (action === 'copy-gherkin-inline') {
                overflowMenuOpen = false;
                filterMenuOpen = false;
                launchPlatformMenuOpen = false;
                renderOverflowMenu();
                renderFilterMenu();
                renderLaunchPlatformMenu();
                const codeNode = target.querySelector('code');
                const value = codeNode?.textContent || '';
                post('copyToClipboard', { value });
                flashCopied(target);
                return;
            }

            if (action === 'refresh-table-snapshot') {
                post('requestTableSnapshotRefresh');
                return;
            }

            if (action === 'refresh-snapshot') {
                overflowMenuOpen = false;
                launchPlatformMenuOpen = false;
                renderOverflowMenu();
                renderLaunchPlatformMenu();
                if (String(viewState.adapterMode || '') === 'manual') {
                    post('requestAdapterRefresh');
                } else {
                    post('refreshSnapshot');
                }
                return;
            }

            if (action === 'build-extension') {
                overflowMenuOpen = false;
                launchPlatformMenuOpen = false;
                renderOverflowMenu();
                renderLaunchPlatformMenu();
                post('buildExtension', {
                    platformClientExePath: getCurrentLaunchPlatformClientExePath()
                });
                return;
            }

            if (action === 'install-extension') {
                overflowMenuOpen = false;
                launchPlatformMenuOpen = false;
                renderOverflowMenu();
                renderLaunchPlatformMenu();
                post('installExtension', {
                    platformClientExePath: getCurrentLaunchPlatformClientExePath()
                });
                return;
            }

            if (action === 'open-source') {
                overflowMenuOpen = false;
                filterMenuOpen = false;
                launchPlatformMenuOpen = false;
                renderOverflowMenu();
                renderFilterMenu();
                renderLaunchPlatformMenu();
                const sourcePath = String(target.dataset.path || '');
                if (!sourcePath) {
                    return;
                }
                post('openSourceLocation', {
                    source: {
                        path: sourcePath,
                        line: parseNumber(target.dataset.line),
                        column: parseNumber(target.dataset.column)
                    }
                });
            }

            if (action === 'select-launch-platform') {
                const platformClientExePath = String(target.dataset.platformPath || '');
                launchPlatformMenuOpen = false;
                renderLaunchPlatformMenu();
                post('setPreferredStartPlatform', {
                    platformClientExePath
                });
                return;
            }
        });

        document.addEventListener('click', event => {
            if (!overflowMenuOpen && !filterMenuOpen && !launchPlatformMenuOpen) {
                return;
            }
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('.menu-shell') || target?.closest('.filter-shell')) {
                return;
            }
            overflowMenuOpen = false;
            filterMenuOpen = false;
            launchPlatformMenuOpen = false;
            renderOverflowMenu();
            renderFilterMenu();
            renderLaunchPlatformMenu();
        });
    }

    function focusActiveElement() {
        const snapshot = viewState.snapshot;
        const activePath = snapshot?.form?.activeElementPath || findActiveElementPath(snapshot?.elements || []);
        if (!activePath) {
            return;
        }

        uiState.searchQuery = '';
        if (refs.searchInput instanceof HTMLInputElement) {
            refs.searchInput.value = '';
        }
        uiState.followActive = true;
        uiState.selectedElementPath = activePath;
        pendingScrollPath = activePath;
        persistUiState();
        render();
    }

    function render() {
        renderStaticFrame();
        renderBanner();

        const snapshot = viewState.snapshot;
        if (!snapshot) {
            renderEmptyView();
            notifySelectionChanged();
            return;
        }

        const rawElements = snapshot.elements || [];
        const attributes = snapshot.attributes || [];
        const attributesByPath = new Map(attributes.map(attribute => [attribute.path, attribute]));
        const activePath = snapshot.form?.activeElementPath || findActiveElementPath(rawElements);
        const filteredElements = filterElementTree(rawElements, normalizeQuery(uiState.searchQuery));
        const flatElements = flattenElements(filteredElements);
        const visiblePaths = new Set(flatElements.map(item => item.element.path));

        if (!uiState.selectedElementPath && typeof viewState.selectedElementPath === 'string' && viewState.selectedElementPath) {
            uiState.selectedElementPath = viewState.selectedElementPath;
            pendingScrollPath = uiState.selectedElementPath;
            persistUiState();
        }

        if (uiState.followActive && activePath && activePath !== uiState.selectedElementPath) {
            uiState.selectedElementPath = activePath;
            pendingScrollPath = activePath;
            persistUiState();
        }

        if (!visiblePaths.has(uiState.selectedElementPath)) {
            const fallbackPath = activePath && visiblePaths.has(activePath)
                ? activePath
                : flatElements[0]?.element.path || '';
            if (fallbackPath !== uiState.selectedElementPath) {
                uiState.selectedElementPath = fallbackPath;
                pendingScrollPath = fallbackPath;
                persistUiState();
            }
        }

        const selectedElement = uiState.selectedElementPath
            ? findElementByPath(rawElements, uiState.selectedElementPath)
            : null;
        const activeElement = activePath
            ? findElementByPath(rawElements, activePath)
            : null;

        renderSidebar(snapshot, flatElements, activeElement);
        renderElementTree(flatElements, activePath, attributesByPath);
        renderSelectedElementHeader(selectedElement, activeElement, snapshot, attributesByPath);
        renderElementDetails(snapshot, selectedElement);
        renderAttributes(attributes, selectedElement);
        renderCommands(snapshot.commands || []);

        setText(refs.attributeCountValue, String(attributes.length));
        setText(refs.commandCountValue, String((snapshot.commands || []).length));
        renderTabs();
        scrollPendingSelectionIntoView();
        notifySelectionChanged();
        syncAutoScrollText(
            document.body,
            '.outline-title, .outline-subtitle'
        );
    }

    function renderStaticFrame() {
        const snapshot = viewState.snapshot;
        const generatedAt = snapshot?.generatedAt || viewState.snapshotMtime || '';
        const adapterMode = String(viewState.adapterMode || 'unknown');
        const pendingOperation = String(viewState.pendingOperation || '');
        const isPending = Boolean(pendingOperation);
        const isStartingInfobase = pendingOperation === 'start';
        const isStartedInfobaseClientRunning = Boolean(viewState.startedInfobaseClientRunning);
        const isStartLocked = isStartingInfobase || isStartedInfobaseClientRunning;
        setText(
            refs.modeValue,
            adapterMode === 'auto'
                ? t('modeAuto', 'Auto')
                : adapterMode === 'manual'
                    ? t('modeManual', 'Manual')
                    : t('unknownValue', 'n/a')
        );
        if (refs.modeChip instanceof HTMLElement) {
            refs.modeChip.title = viewState.adapterModeStatePath || '';
            refs.modeChip.dataset.mode = adapterMode;
        }
        if (refs.generatedAtChip instanceof HTMLElement) {
            refs.generatedAtChip.dataset.pending = isPending ? 'true' : 'false';
        }
        setText(
            refs.generatedAtLabel,
            isPending
                ? (isStartingInfobase
                    ? t('starting', 'Starting...')
                    : t('updating', 'Updating...'))
                : t('generatedAt', 'Updated at')
        );
        setText(
            refs.generatedAtValue,
            isPending
                ? (isStartingInfobase
                    ? t('launchingInfobase', 'Launching infobase')
                    : t('loadingForm', 'Loading form'))
                : generatedAt
                    ? formatDateTime(generatedAt)
                    : t('unknownValue', 'n/a')
        );
        if (refs.generatedAtValue instanceof HTMLElement) {
            refs.generatedAtValue.title = isPending ? '' : String(generatedAt || '');
        }
        if (refs.manualRefreshBtn instanceof HTMLButtonElement) {
            refs.manualRefreshBtn.classList.toggle('view-hidden', adapterMode !== 'manual');
            refs.manualRefreshBtn.title = pendingOperation === 'refresh'
                ? t('updatingSnapshot', 'Refreshing form snapshot...')
                : t('refresh', 'Refresh');
            refs.manualRefreshBtn.disabled = adapterMode !== 'manual' || Boolean(pendingOperation);
        }
        if (refs.locatorBtn instanceof HTMLButtonElement) {
            refs.locatorBtn.classList.toggle('view-hidden', adapterMode !== 'manual');
            refs.locatorBtn.disabled = adapterMode !== 'manual' || Boolean(pendingOperation);
        }
        if (refs.startInfobaseBtn instanceof HTMLButtonElement) {
            refs.startInfobaseBtn.disabled = isStartLocked;
            refs.startInfobaseBtn.title = isStartingInfobase
                ? t('launchingInfobase', 'Launching infobase')
                : isStartedInfobaseClientRunning
                    ? t('infobaseClientRunning', '1C client is still running')
                : t('startInfobase', 'Start infobase');
        }
        setText(
            refs.startInfobaseLabel,
            isStartingInfobase
                ? t('starting', 'Starting...')
                : t('startInfobase', 'Start infobase')
        );
        const currentLaunchPlatform = resolveCurrentLaunchPlatform();
        const launchPlatformLabel = currentLaunchPlatform
            ? formatPlatformButtonLabel(currentLaunchPlatform)
            : (getConfiguredPlatforms().length ? t('launchPlatform', 'Platform') : t('none', 'None'));
        setText(refs.launchPlatformLabel, launchPlatformLabel);
        if (refs.launchPlatformLabel instanceof HTMLElement) {
            refs.launchPlatformLabel.title = currentLaunchPlatform?.clientExePath || currentLaunchPlatform?.name || launchPlatformLabel;
        }
        if (refs.launchPlatformBtn instanceof HTMLButtonElement) {
            refs.launchPlatformBtn.disabled = isStartLocked || !getConfiguredPlatforms().length;
            refs.launchPlatformBtn.title = currentLaunchPlatform?.clientExePath || currentLaunchPlatform?.name || t('launchPlatform', 'Platform');
        }
        renderLaunchPlatformMenu();

        if (refs.openSnapshotFileBtn instanceof HTMLButtonElement) {
            refs.openSnapshotFileBtn.disabled = !viewState.snapshotPath;
        }
        if (refs.revealSnapshotFileBtn instanceof HTMLButtonElement) {
            refs.revealSnapshotFileBtn.disabled = !viewState.snapshotPath;
        }
        if (refs.searchInput instanceof HTMLInputElement && refs.searchInput.value !== uiState.searchQuery) {
            refs.searchInput.value = uiState.searchQuery;
        }
        if (refs.showGroupsInput instanceof HTMLInputElement) {
            refs.showGroupsInput.checked = uiState.showGroups;
        }
        if (refs.showTechnicalInput instanceof HTMLInputElement) {
            refs.showTechnicalInput.checked = uiState.showTechnical;
        }
        if (refs.showTechnicalTabsInput instanceof HTMLInputElement) {
            refs.showTechnicalTabsInput.checked = uiState.showTechnicalInfo;
        }
        renderOverflowMenu();
        renderFilterMenu();
    }

    function renderLaunchPlatformMenu() {
        if (!(refs.launchPlatformMenu instanceof HTMLElement)) {
            return;
        }

        if (refs.launchPlatformBtn instanceof HTMLButtonElement) {
            refs.launchPlatformBtn.setAttribute('aria-expanded', launchPlatformMenuOpen ? 'true' : 'false');
        }
        refs.launchPlatformMenu.classList.toggle('is-open', launchPlatformMenuOpen);

        if (!launchPlatformMenuOpen) {
            refs.launchPlatformMenu.innerHTML = '';
            return;
        }

        const configuredPlatforms = getConfiguredPlatforms();
        if (!configuredPlatforms.length) {
            refs.launchPlatformMenu.innerHTML = `<div class="menu-item platform-menu-empty" role="presentation">${escapeHtml(t('none', 'None'))}</div>`;
            return;
        }

        const defaultPlatformPath = normalizePlatformPath(getDefaultPlatform()?.clientExePath || '');
        const currentPlatformPath = normalizePlatformPath(getCurrentLaunchPlatformClientExePath() || '');
        refs.launchPlatformMenu.innerHTML = configuredPlatforms.map(platform => {
            const clientExePath = String(platform?.clientExePath || '');
            const normalizedClientExePath = normalizePlatformPath(clientExePath);
            const isSelected = normalizedClientExePath === currentPlatformPath;
            const isDefault = normalizedClientExePath === defaultPlatformPath;
            const detailParts = [];
            if (isDefault) {
                detailParts.push(t('defaultLabel', 'Default'));
            }
            detailParts.push(clientExePath);
            return `
                <button
                    class="menu-item platform-menu-item${isSelected ? ' is-selected' : ''}"
                    type="button"
                    data-action="select-launch-platform"
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

    function renderBanner() {
        const hasSnapshotFile = Boolean(viewState.snapshotExists);
        const hasError = Boolean(viewState.lastError);
        const shouldShowBanner = hasError && hasSnapshotFile;
        refs.alertBanner?.classList.toggle('hidden', !shouldShowBanner);
        setText(refs.alertText, shouldShowBanner ? (viewState.lastError || '') : '');
    }

    function renderEmptyView() {
        setText(refs.formTitleValue, t('waitingForSnapshot', 'Waiting for snapshot'));
        if (refs.formTitleValue instanceof HTMLButtonElement) {
            refs.formTitleValue.disabled = true;
            refs.formTitleValue.removeAttribute('data-action');
            refs.formTitleValue.removeAttribute('data-value');
        }
        setText(refs.formMetaLine, '');
        setText(refs.elementCountValue, '0');
        if (refs.currentFormOpenSourceBtn instanceof HTMLButtonElement) {
            refs.currentFormOpenSourceBtn.disabled = true;
            delete refs.currentFormOpenSourceBtn.dataset.path;
            delete refs.currentFormOpenSourceBtn.dataset.line;
            delete refs.currentFormOpenSourceBtn.dataset.column;
        }
        if (refs.focusActiveBtn instanceof HTMLButtonElement) {
            refs.focusActiveBtn.disabled = true;
        }
        if (refs.elementTree) {
            refs.elementTree.innerHTML = renderEmptyState(
                t('waitingForSnapshot', 'Waiting for snapshot'),
                ''
            );
        }
        if (refs.selectedKeyFacts) {
            refs.selectedKeyFacts.innerHTML = renderEmptyState(
                t('noSelection', 'Select an element in the tree to inspect its details.'),
                ''
            );
        }
        if (refs.selectedStateRow) {
            refs.selectedStateRow.innerHTML = '';
        }
        if (refs.detailsPanel) {
            refs.detailsPanel.innerHTML = renderEmptyState(
                t('waitingForSnapshot', 'Waiting for snapshot'),
                ''
            );
        }
        if (refs.attributesPanel) {
            refs.attributesPanel.innerHTML = renderEmptyState(t('noAttributes', 'No form attributes in snapshot.'), '');
        }
        if (refs.commandsPanel) {
            refs.commandsPanel.innerHTML = renderEmptyState(t('noCommands', 'No commands in snapshot.'), '');
        }
        setText(refs.attributeCountValue, '0');
        setText(refs.commandCountValue, '0');
        renderTabs();
    }

    function renderSidebar(snapshot, flatElements, activeElement) {
        const formLabel = getFormLabel(snapshot.form);
        setText(refs.formTitleValue, formLabel);
        setText(refs.elementCountValue, String(flatElements.length));
        setText(
            refs.formMetaLine,
            [snapshot.form?.metadataPath, firstDefined(snapshot.form?.type, snapshot.form?.viewKind)]
                .filter(Boolean)
                .join(' • ')
        );
        if (refs.formTitleValue instanceof HTMLButtonElement) {
            refs.formTitleValue.disabled = !formLabel;
            refs.formTitleValue.dataset.action = 'copy';
            refs.formTitleValue.dataset.value = formLabel;
        }

        if (refs.focusActiveBtn instanceof HTMLButtonElement) {
            refs.focusActiveBtn.disabled = !activeElement;
        }
        if (refs.currentFormOpenSourceBtn instanceof HTMLButtonElement) {
            const source = snapshot.form?.source;
            refs.currentFormOpenSourceBtn.disabled = !source?.path;
            if (source?.path) {
                refs.currentFormOpenSourceBtn.dataset.path = source.path;
                refs.currentFormOpenSourceBtn.dataset.line = source.line ? String(source.line) : '';
                refs.currentFormOpenSourceBtn.dataset.column = source.column ? String(source.column) : '';
            } else {
                delete refs.currentFormOpenSourceBtn.dataset.path;
                delete refs.currentFormOpenSourceBtn.dataset.line;
                delete refs.currentFormOpenSourceBtn.dataset.column;
            }
        }
    }

    function renderElementTree(flatElements, activePath, attributesByPath) {
        if (!refs.elementTree) {
            return;
        }

        const preservedScrollTop = refs.elementTree.scrollTop;
        const shouldResetScroll = pendingScrollReset;
        const shouldPreserveScroll = !pendingScrollPath && !shouldResetScroll;

        if (flatElements.length === 0) {
            refs.elementTree.innerHTML = renderEmptyState(
                uiState.searchQuery
                    ? t('noMatchingElements', 'No elements match the current filter.')
                    : t('noElements', 'No form elements in snapshot.'),
                uiState.searchQuery || ''
            );
            if (shouldResetScroll) {
                refs.elementTree.scrollTop = 0;
            } else if (shouldPreserveScroll) {
                refs.elementTree.scrollTop = preservedScrollTop;
            }
            pendingScrollReset = false;
            return;
        }

        refs.elementTree.innerHTML = flatElements.map(item => renderOutlineRow(item.element, item.depth, activePath, attributesByPath)).join('');
        if (shouldResetScroll) {
            refs.elementTree.scrollTop = 0;
        } else if (shouldPreserveScroll) {
            refs.elementTree.scrollTop = preservedScrollTop;
        }
        pendingScrollReset = false;
    }

    function renderSelectedElementHeader(selectedElement, activeElement, snapshot, attributesByPath) {
        if (refs.selectedStateRow) {
            refs.selectedStateRow.innerHTML = selectedElement
                ? renderStateChips(collectElementStateChips(selectedElement, activeElement?.path))
                : '';
        }

        if (refs.selectedKeyFacts) {
            if (!selectedElement) {
                refs.selectedKeyFacts.innerHTML = renderEmptyState(
                    t('noSelection', 'Select an element in the tree to inspect its details.'),
                    ''
                );
            } else {
                const linkedAttribute = selectedElement.boundAttributePath
                    ? (snapshot.attributes || []).find(attribute => attribute.path === selectedElement.boundAttributePath) || null
                    : null;

                refs.selectedKeyFacts.innerHTML = [
                    renderKeyFactCard(
                        t('uiName', 'UI name'),
                        getElementLabel(selectedElement, attributesByPath),
                        'copy'
                    ),
                    renderKeyFactCard(
                        t('technicalName', 'Technical name'),
                        firstDefined(selectedElement.name, lastSegment(selectedElement.path), selectedElement.path),
                        'copy'
                    ),
                    renderKeyFactCard(
                        t('valuePreview', 'Value'),
                        firstDefined(selectedElement.valuePreview, linkedAttribute?.valuePreview, ''),
                        'copy'
                    )
                ].filter(Boolean).join('');
            }
        }

    }

    function renderElementDetails(snapshot, selectedElement) {
        if (!refs.detailsPanel) {
            return;
        }

        const suggestedScrollState = captureSuggestedScrollState();

        if (!selectedElement) {
            refs.detailsPanel.innerHTML = renderEmptyState(
                t('noSelection', 'Select an element in the tree to inspect its details.'),
                ''
            );
            return;
        }

        const notes = []
            .concat(Array.isArray(snapshot.notes) ? snapshot.notes : [])
            .concat(Array.isArray(snapshot.form?.notes) ? snapshot.form.notes : [])
            .filter(Boolean);

        const sections = [
            renderSectionCard(
                t('elementDetails', 'Element details'),
                renderDetailRows([
                    createDetailRow(t('path', 'Path'), selectedElement.path, true),
                    createDetailRow(t('formType', 'Type'), firstDefined(selectedElement.type, selectedElement.kind)),
                    createDetailRow(t('boundAttribute', 'Bound attribute'), selectedElement.boundAttributePath, true),
                    createDetailRow(t('metadataPath', 'Metadata path'), selectedElement.metadataPath, true),
                    createSourceDetailRow(t('source', 'Source'), selectedElement.source)
                ]),
                {
                    collapsible: true,
                    expanded: uiState.detailsExpanded,
                    action: 'toggle-details',
                    sectionKey: 'details'
                }
            ),
            renderSuggestedStepsSection(selectedElement),
            notes.length > 0
                ? renderSectionCard(
                    t('notes', 'Notes'),
                    `<ul class="notes-list">${notes.map(note => `<li>${escapeHtml(String(note))}</li>`).join('')}</ul>`
                )
                : ''
        ].filter(Boolean);

        refs.detailsPanel.innerHTML = sections.join('');
        restoreSuggestedScrollState(suggestedScrollState);
    }

    function renderAttributes(attributes, selectedElement) {
        if (!refs.attributesPanel) {
            return;
        }

        const linkedAttributePath = selectedElement?.boundAttributePath || '';
        const orderedAttributes = attributes.slice().sort((left, right) => {
            const leftScore = left.path === linkedAttributePath ? 1 : 0;
            const rightScore = right.path === linkedAttributePath ? 1 : 0;
            return rightScore - leftScore || getAttributeLabel(left).localeCompare(getAttributeLabel(right));
        });

        if (orderedAttributes.length === 0) {
            refs.attributesPanel.innerHTML = renderEmptyState(t('noAttributes', 'No form attributes in snapshot.'), '');
            return;
        }

        refs.attributesPanel.innerHTML = `<div class="record-list">${orderedAttributes.map(attribute => renderAttributeCard(attribute, linkedAttributePath)).join('')}</div>`;
    }

    function renderCommands(commands) {
        if (!refs.commandsPanel) {
            return;
        }

        if (commands.length === 0) {
            refs.commandsPanel.innerHTML = renderEmptyState(t('noCommands', 'No commands in snapshot.'), '');
            return;
        }

        refs.commandsPanel.innerHTML = `<div class="record-list">${commands.map(command => renderCommandCard(command)).join('')}</div>`;
    }

    function renderTabs() {
        if (!uiState.showTechnicalInfo && (uiState.activeTab === 'attributes' || uiState.activeTab === 'commands')) {
            uiState.activeTab = 'selected';
            persistUiState();
        }

        if (refs.detailsTabsBar instanceof HTMLElement) {
            refs.detailsTabsBar.classList.toggle('view-hidden', !uiState.showTechnicalInfo);
        }

        for (const button of tabButtons) {
            const tab = String(button.dataset.tab || '');
            const hidden = !uiState.showTechnicalInfo && (tab === 'attributes' || tab === 'commands');
            button.classList.toggle('view-hidden', hidden);
            if (hidden) {
                button.setAttribute('aria-selected', 'false');
                button.classList.remove('is-active');
                continue;
            }

            const isActive = tab === uiState.activeTab;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        }

        for (const panel of tabPanels) {
            const tab = String(panel.dataset.tabPanel || '');
            const hidden = !uiState.showTechnicalInfo && (tab === 'attributes' || tab === 'commands');
            panel.classList.toggle('view-hidden', hidden);
            const isActive = !hidden && tab === uiState.activeTab;
            panel.classList.toggle('is-active', isActive);
        }
    }

    function renderOutlineRow(element, depth, activePath, attributesByPath) {
        const uiLabel = getElementLabel(element, attributesByPath);
        const technicalName = firstDefined(
            element.name,
            lastSegment(element.path),
            element.path
        );
        const preview = trimText(firstDefined(element.valuePreview, ''), 90);
        const stateChips = renderStateChips(collectOutlineChips(element, activePath));

        return `
            <button
                class="outline-row${element.path === uiState.selectedElementPath ? ' is-selected' : ''}${element.path === activePath ? ' is-active' : ''}"
                type="button"
                data-action="select-element"
                data-path="${escapeHtml(element.path)}"
                style="--depth:${depth};"
            >
                <span class="outline-main">
                    <span class="outline-title">${escapeHtml(uiLabel)}</span>
                    ${technicalName ? `<span class="outline-subtitle">${escapeHtml(technicalName)}</span>` : ''}
                    ${preview ? `<span class="outline-value">${escapeHtml(preview)}</span>` : ''}
                </span>
                ${stateChips ? `<span class="outline-side">${stateChips}</span>` : ''}
            </button>
        `;
    }

    function renderAttributeCard(attribute, highlightedPath) {
        const isHighlighted = highlightedPath && attribute.path === highlightedPath;
        return `
            <article class="record-card${isHighlighted ? ' is-highlighted' : ''}">
                <div class="record-head">
                    <div class="record-copy">
                        <h3 class="record-title">${escapeHtml(getAttributeLabel(attribute))}</h3>
                        <p class="record-subtitle">${escapeHtml(attribute.path)}</p>
                    </div>
                    <div class="inline-actions">
                        ${renderActionButton({
                            label: t('copyPath', 'Copy path'),
                            icon: 'copy',
                            action: 'copy',
                            value: attribute.path,
                            compact: true
                        })}
                        ${attribute.source?.path ? renderActionButton({
                            label: t('openSourceFile', 'Open source file'),
                            icon: 'go-to-file',
                            action: 'open-source',
                            source: attribute.source,
                            compact: true
                        }) : ''}
                    </div>
                </div>
                <div class="chip-row">${renderStateChips(collectAttributeStateChips(attribute, isHighlighted))}</div>
                <dl class="record-grid">
                    ${renderRecordPair(t('valuePreview', 'Value'), attribute.valuePreview)}
                    ${renderRecordPair(t('formType', 'Type'), attribute.type)}
                    ${renderRecordPair(t('metadataPath', 'Metadata path'), attribute.metadataPath)}
                </dl>
            </article>
        `;
    }

    function renderCommandCard(command) {
        return `
            <article class="record-card">
                <div class="record-head">
                    <div class="record-copy">
                        <h3 class="record-title">${escapeHtml(firstDefined(command.title, command.name, t('unknownValue', 'n/a')))}</h3>
                        <p class="record-subtitle">${escapeHtml(command.name)}</p>
                    </div>
                    <div class="inline-actions">
                        ${renderActionButton({
                            label: t('copyPath', 'Copy path'),
                            icon: 'copy',
                            action: 'copy',
                            value: command.name,
                            compact: true
                        })}
                    </div>
                </div>
                <div class="chip-row">${renderStateChips(collectCommandStateChips(command))}</div>
                <dl class="record-grid">
                    ${renderRecordPair(t('name', 'Name'), command.name)}
                    ${renderRecordPair(t('source', 'Source'), command.action)}
                </dl>
            </article>
        `;
    }

    function renderSelectedFormTable(selectedTableEntry) {
        if (!refs.tablesPanel) {
            return;
        }

        const previousCard = refs.tablesPanel.querySelector('.form-table-card');
        const previousPreview = refs.tablesPanel.querySelector('.gherkin-table-preview.inline');
        const previousTableKey = previousCard instanceof HTMLElement
            ? String(previousCard.dataset.tableKey || '')
            : '';
        const preservedPanelScrollTop = refs.tablesPanel.scrollTop;
        const preservedPreviewScrollTop = previousPreview instanceof HTMLElement
            ? previousPreview.scrollTop
            : 0;
        const preservedPreviewScrollLeft = previousPreview instanceof HTMLElement
            ? previousPreview.scrollLeft
            : 0;

        if (!selectedTableEntry) {
            refs.tablesPanel.innerHTML = renderEmptyState(
                t('noFormTables', 'No form tables detected in snapshot.'),
                ''
            );
            return;
        }

        refs.tablesPanel.innerHTML = `<div class="record-list">${renderFormTableCard(selectedTableEntry)}</div>`;

        if (previousTableKey && previousTableKey === selectedTableEntry.key) {
            refs.tablesPanel.scrollTop = preservedPanelScrollTop;
            const nextPreview = refs.tablesPanel.querySelector('.gherkin-table-preview.inline');
            if (nextPreview instanceof HTMLElement) {
                nextPreview.scrollTop = preservedPreviewScrollTop;
                nextPreview.scrollLeft = preservedPreviewScrollLeft;
            }
        }
    }

    function resolveSelectedFormTableEntry(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
            if (uiState.selectedTableKey) {
                uiState.selectedTableKey = '';
                persistUiState();
            }
            return null;
        }

        let selected = uiState.selectedTableKey
            ? entries.find(entry => entry.key === uiState.selectedTableKey) || null
            : null;
        if (!selected) {
            selected = entries[0];
            if (selected && uiState.selectedTableKey !== selected.key) {
                uiState.selectedTableKey = selected.key;
                persistUiState();
            }
        }

        return selected;
    }

    function renderFormTableList(entries) {
        if (!refs.tableTree) {
            return;
        }

        const query = normalizeQuery(uiState.tableSearchQuery);
        const filteredEntries = query
            ? entries.filter(entry => matchesTableSearch(entry, query))
            : entries;

        if (filteredEntries.length === 0) {
            refs.tableTree.innerHTML = renderEmptyState(
                query
                    ? t('noMatchingTables', 'No tables match the current filter.')
                    : t('noFormTables', 'No form tables detected in snapshot.'),
                ''
            );
            return;
        }

        refs.tableTree.innerHTML = filteredEntries
            .map(entry => renderTableOutlineRow(entry))
            .join('');
    }

    function renderTableOutlineRow(entry) {
        const rowCountTotal = Number.isFinite(entry.tableData.rowCount)
            ? Number(entry.tableData.rowCount)
            : entry.tableData.rows.length;
        const rowCountShown = entry.tableData.rows.length;
        const preview = `${t('tableRowsShown', 'Rows shown')}: ${rowCountShown} • ${t('tableRowsTotal', 'Rows total')}: ${rowCountTotal}`;
        const chips = renderStateChips([
            ...(entry.tableData.truncated ? [{ label: t('tableRowsTruncated', 'Table is truncated in snapshot.'), tone: 'warning' }] : [])
        ]);

        return `
            <button
                class="outline-row${entry.key === uiState.selectedTableKey ? ' is-selected' : ''}"
                type="button"
                data-action="select-table"
                data-table-key="${escapeHtml(entry.key)}"
            >
                <span class="outline-main">
                    <span class="outline-title">${escapeHtml(entry.label)}</span>
                    ${entry.subtitle ? `<span class="outline-subtitle">${escapeHtml(entry.subtitle)}</span>` : ''}
                    <span class="outline-value">${escapeHtml(preview)}</span>
                </span>
                ${chips ? `<span class="outline-side">${chips}</span>` : ''}
            </button>
        `;
    }

    function matchesTableSearch(entry, query) {
        const probe = normalizeQuery([
            entry.label,
            entry.subtitle,
            entry.path,
            entry.elementPath,
            entry.boundAttributePath
        ].filter(Boolean).join(' '));
        return probe.includes(query);
    }

    function renderSuggestedStepsSection(selectedElement) {
        const pendingOperation = String(viewState.pendingOperation || '');
        const headerActionsHtml = isTableLikeElement(selectedElement)
            ? `
                <button class="mini-btn compact" type="button" data-action="refresh-table-snapshot" ${pendingOperation ? 'disabled' : ''}>
                    <span class="codicon codicon-refresh"></span>
                    <span>${escapeHtml(pendingOperation === 'table'
                        ? t('loadingTables', 'Loading tables into snapshot...')
                        : t('getTables', 'Get tables'))}</span>
                </button>
            `
            : '';
        return renderSectionCard(
            t('suggestedSteps', 'Suggested steps'),
            renderSuggestedStepsBody(selectedElement),
            {
                collapsible: true,
                expanded: uiState.suggestedStepsExpanded,
                action: 'toggle-suggested-steps',
                sectionKey: 'suggested',
                className: 'suggested-steps-card',
                headerActionsHtml
            }
        );
    }

    function renderSuggestedStepsBody(selectedElement) {
        if (!selectedElement) {
            return renderEmptyState(
                t('noSelection', 'Select an element in the tree to inspect its details.'),
                ''
            );
        }

        const currentPath = selectedElement.path;
        const suggestionsForPath = viewState.suggestedStepsForPath || '';
        const backendSuggestions = Array.isArray(viewState.suggestedSteps)
            ? viewState.suggestedSteps
            : [];
        const backendSelectedPath = typeof viewState.selectedElementPath === 'string'
            ? viewState.selectedElementPath
            : '';
        const hasCurrentSuggestions = suggestionsForPath === currentPath
            || (backendSelectedPath === currentPath && backendSuggestions.length > 0);
        const currentSuggestions = hasCurrentSuggestions
            ? backendSuggestions
            : [];
        const cachedSuggestions = suggestedStepsCache.get(currentPath);
        const fallbackSuggestions = backendSuggestions.length > 0 ? backendSuggestions : [];
        const suggestions = currentSuggestions.length > 0
            ? currentSuggestions
            : (Array.isArray(cachedSuggestions) && cachedSuggestions.length > 0
                ? cachedSuggestions
                : fallbackSuggestions);

        if (viewState.suggestedStepsError && hasCurrentSuggestions) {
            return renderEmptyState(
                t('suggestedStepsError', 'Failed to build step suggestions.'),
                String(viewState.suggestedStepsError || '')
            );
        }

        if (!hasCurrentSuggestions && suggestions.length === 0) {
            return renderEmptyState(
                t('suggestedStepsLoading', 'Preparing step suggestions...'),
                ''
            );
        }

        if (suggestions.length === 0) {
            return renderEmptyState(
                t('noSuggestedSteps', 'No suitable steps found for the selected element.'),
                ''
            );
        }

        return `
            <div class="suggested-steps-scroll" data-suggested-path="${escapeHtml(currentPath)}">
                <div class="record-list step-suggestion-list">${suggestions.map((step, index) => renderSuggestedStepCard(step, index)).join('')}</div>
            </div>
        `;
    }

    function isTableLikeElement(element) {
        if (!element) {
            return false;
        }

        if (element.tableData && Array.isArray(element.tableData.columns)) {
            return true;
        }

        const probe = normalizeQuery([element.kind, element.type, element.path, element.boundAttributePath].filter(Boolean).join(' '));
        return isTableLikeProbe(probe);
    }

    function renderSuggestedStepCard(step, index) {
        const filledText = firstDefined(step.filledText, step.templateText);
        const normalizedFilledText = normalizeSuggestedStepText(filledText);
        const isMultiline = normalizedFilledText.includes('\n');
        const scoreText = typeof step.score === 'number' && Number.isFinite(step.score)
            ? String(step.score)
            : '';
        const chips = renderStateChips([
            ...(scoreText ? [{ label: `Score ${scoreText}`, tone: 'muted' }] : [])
        ]);
        const stepKey = String(index);

        return `
            <article class="record-card step-suggestion-card" data-action="copy-gherkin-inline">
                <button class="gherkin-inline-copy step-suggestion-inline-copy" type="button" data-action="copy-gherkin-inline">
                    <div class="gherkin-inline-head step-suggestion-copy-head">
                        <span class="codicon codicon-copy" aria-hidden="true"></span>
                    </div>
                    <pre class="gherkin-table-preview inline step-suggestion-preview${isMultiline ? '' : ' single-line'}" data-step-key="${escapeHtml(stepKey)}"><code>${escapeHtml(normalizedFilledText)}</code></pre>
                    ${step.description ? `<p class="record-subtitle step-suggestion-description">${escapeHtml(step.description)}</p>` : ''}
                </button>
                ${chips ? `<div class="chip-row compact step-suggestion-meta">${chips}</div>` : ''}
            </article>
        `;
    }

    function captureSuggestedScrollState() {
        if (!(refs.detailsPanel instanceof HTMLElement)) {
            return null;
        }

        const container = refs.detailsPanel.querySelector('.suggested-steps-scroll');
        if (!(container instanceof HTMLElement)) {
            return null;
        }

        return {
            path: String(container.dataset.suggestedPath || ''),
            scrollTop: container.scrollTop,
            scrollLeft: container.scrollLeft,
            previews: Array.from(container.querySelectorAll('.step-suggestion-preview'))
                .filter(node => node instanceof HTMLElement)
                .map(node => ({
                    stepKey: String(node.dataset.stepKey || ''),
                    scrollLeft: node.scrollLeft,
                    scrollTop: node.scrollTop
                }))
        };
    }

    function restoreSuggestedScrollState(state) {
        if (!state || !(refs.detailsPanel instanceof HTMLElement)) {
            return;
        }

        const container = refs.detailsPanel.querySelector('.suggested-steps-scroll');
        if (!(container instanceof HTMLElement)) {
            return;
        }

        if (String(container.dataset.suggestedPath || '') !== state.path) {
            return;
        }

        container.scrollTop = state.scrollTop;
        container.scrollLeft = state.scrollLeft;
        if (Array.isArray(state.previews)) {
            const previewNodes = Array.from(container.querySelectorAll('.step-suggestion-preview'));
            for (const previewState of state.previews) {
                const matchingNode = previewNodes.find(node => String(node.dataset.stepKey || '') === previewState.stepKey);
                if (!(matchingNode instanceof HTMLElement)) {
                    continue;
                }

                matchingNode.scrollLeft = Number.isFinite(previewState.scrollLeft) ? previewState.scrollLeft : 0;
                matchingNode.scrollTop = Number.isFinite(previewState.scrollTop) ? previewState.scrollTop : 0;
            }
        }
    }

    function normalizeSuggestedStepText(value) {
        const raw = String(value || '')
            .replace(/\r\n|\r/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .trim();
        if (!raw) {
            return '';
        }

        const lines = raw.split('\n');
        const compactLines = [];
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const trimmedLine = line.trim();
            if (trimmedLine.length === 0) {
                const previousLine = compactLines.length > 0 ? compactLines[compactLines.length - 1].trim() : '';
                let nextNonEmptyLine = '';
                for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex++) {
                    const candidate = lines[nextIndex].trim();
                    if (candidate.length > 0) {
                        nextNonEmptyLine = candidate;
                        break;
                    }
                }
                const betweenTableLines = previousLine.startsWith('|') && nextNonEmptyLine.startsWith('|');
                const duplicateGap = previousLine.length === 0 || nextNonEmptyLine.length === 0;
                if (betweenTableLines || duplicateGap) {
                    continue;
                }
            }
            compactLines.push(line);
        }

        return compactLines
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function normalizeTableData(rawTableData) {
        if (!rawTableData) {
            return null;
        }

        const rowsRaw = Array.isArray(rawTableData.rows) ? rawTableData.rows : [];
        const rows = rowsRaw
            .filter(row => Array.isArray(row))
            .map(row => row.map(cell => sanitizeTableCellValue(cell)));
        const columnsRaw = Array.isArray(rawTableData.columns) ? rawTableData.columns : [];
        if (columnsRaw.length === 0 && rows.length === 0) {
            return null;
        }
        const maxColumns = rows.length > 0 ? Math.max(...rows.map(row => row.length), 0) : columnsRaw.length;
        const columns = columnsRaw.length > 0
            ? columnsRaw.map(column => sanitizeTableCellValue(column))
            : Array.from({ length: maxColumns }, (_, index) => `Column${index + 1}`);

        return {
            columns,
            rows,
            rowCount: Number.isFinite(rawTableData.rowCount) ? Number(rawTableData.rowCount) : rows.length,
            truncated: Boolean(rawTableData.truncated),
            sourcePath: firstDefined(rawTableData.sourcePath)
        };
    }

    function sanitizeTableCellValue(value) {
        if (value === undefined || value === null) {
            return '';
        }

        const normalized = String(value);
        const trimmed = normalized.trim();
        if (trimmed === '""' || trimmed === "''") {
            return '';
        }

        return normalized;
    }

    function collectFormTableEntries(snapshot, selectedElement, attributesByPath) {
        const entries = [];
        const dedupe = new Set();
        const allElements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];

        const tryAdd = (rawEntry, fallbackElement) => {
            const tableData = normalizeTableData(rawEntry?.tableData || rawEntry);
            if (!tableData) {
                return;
            }

            const path = firstDefined(rawEntry?.path, rawEntry?.boundAttributePath, tableData.sourcePath);
            const elementPath = firstDefined(rawEntry?.elementPath, fallbackElement?.path);
            const boundAttributePath = firstDefined(rawEntry?.boundAttributePath, fallbackElement?.boundAttributePath, path);
            const linkedAttribute = boundAttributePath ? attributesByPath?.get(boundAttributePath) : null;
            const resolvedTableElement = fallbackElement
                || findTableElementByBoundPath(allElements, boundAttributePath || path)
                || null;
            const tableName = firstDefined(rawEntry?.name, resolvedTableElement?.name, lastSegment(path), lastSegment(elementPath));
            const projectedTableData = projectTableDataForDisplay(tableData, resolvedTableElement, tableName);
            const label = firstDefined(
                getTableElementUiLabel(resolvedTableElement, allElements, attributesByPath),
                linkedAttribute?.title,
                linkedAttribute?.synonym,
                fallbackElement ? firstDefined(fallbackElement.title, fallbackElement.synonym) : '',
                humanizeToken(firstDefined(rawEntry?.title, rawEntry?.name)),
                humanizeMetadataPath(path),
                t('gherkinTable', 'Gherkin table')
            );
            const subtitle = firstDefined(path, elementPath, tableData.sourcePath);

            const dedupeKey = [
                firstDefined(path),
                firstDefined(elementPath),
                firstDefined(projectedTableData.sourcePath),
                firstDefined(rawEntry?.name),
                firstDefined(rawEntry?.title)
            ].join('::');
            if (dedupe.has(dedupeKey)) {
                return;
            }
            dedupe.add(dedupeKey);

            entries.push({
                key: dedupeKey,
                label,
                subtitle,
                path,
                elementPath,
                boundAttributePath,
                tableData: projectedTableData,
                related: false
            });
        };

        const snapshotTables = Array.isArray(snapshot?.tables) ? snapshot.tables : [];
        for (const rawTable of snapshotTables) {
            const fallbackElement = rawTable?.elementPath ? findElementByPath(allElements, String(rawTable.elementPath)) : null;
            tryAdd(rawTable, fallbackElement);
        }

        const collectFromElements = (elements) => {
            for (const element of elements || []) {
                tryAdd({
                    path: firstDefined(element.boundAttributePath, element.path),
                    elementPath: element.path,
                    boundAttributePath: element.boundAttributePath,
                    title: firstDefined(element.title, element.synonym),
                    name: element.name,
                    tableData: element.tableData
                }, element);

                if (Array.isArray(element.children) && element.children.length > 0) {
                    collectFromElements(element.children);
                }
            }
        };
        collectFromElements(allElements);

        entries.sort((left, right) => {
            return left.label.localeCompare(right.label, 'ru')
                || left.subtitle.localeCompare(right.subtitle, 'ru');
        });

        return entries;
    }

    function getTableElementUiLabel(tableElement, allElements, attributesByPath) {
        if (!tableElement) {
            return '';
        }

        const directLabel = firstDefined(tableElement.title, tableElement.synonym);
        if (directLabel) {
            return directLabel;
        }

        const chain = findElementPathChain(allElements, tableElement.path);
        if (chain.length > 1) {
            const ancestors = chain.slice(0, -1).reverse();
            for (const ancestor of ancestors) {
                const ancestorLabel = firstDefined(ancestor.title, ancestor.synonym);
                if (!ancestorLabel) {
                    continue;
                }

                const probe = normalizeQuery([ancestor.kind, ancestor.type, ancestor.name].filter(Boolean).join(' '));
                if (probe.includes('page') || probe.includes('вклад') || probe.includes('tab')) {
                    return ancestorLabel;
                }
            }

            for (const ancestor of ancestors) {
                const ancestorLabel = firstDefined(ancestor.title, ancestor.synonym);
                if (ancestorLabel) {
                    return ancestorLabel;
                }
            }
        }

        return getElementLabel(tableElement, attributesByPath);
    }

    function findElementPathChain(elements, targetPath, chain) {
        const nextChain = Array.isArray(chain) ? chain : [];
        for (const element of elements || []) {
            const currentChain = nextChain.concat(element);
            if (element.path === targetPath) {
                return currentChain;
            }

            const nested = findElementPathChain(element.children || [], targetPath, currentChain);
            if (nested.length > 0) {
                return nested;
            }
        }

        return [];
    }

    function findTableElementByBoundPath(elements, targetPath) {
        if (!targetPath) {
            return null;
        }

        for (const element of elements || []) {
            const isTableElement = isTableLikeProbe(normalizeQuery([element.kind, element.type].filter(Boolean).join(' ')));
            if (isTableElement && firstDefined(element.boundAttributePath, '') === targetPath) {
                return element;
            }

            const nested = findTableElementByBoundPath(element.children || [], targetPath);
            if (nested) {
                return nested;
            }
        }

        return null;
    }

    function projectTableDataForDisplay(tableData, tableElement, tableName) {
        const columns = Array.isArray(tableData.columns) ? tableData.columns : [];
        const rows = Array.isArray(tableData.rows) ? tableData.rows : [];
        if (columns.length === 0) {
            return tableData;
        }

        const descriptors = collectTableColumnDescriptorsFromElement(tableElement, tableName);
        const selectedIndexes = [];
        const selectedColumns = [];

        for (let index = 0; index < columns.length; index += 1) {
            const rawColumnName = sanitizeTableCellValue(columns[index]);
            const descriptor = findColumnDescriptor(descriptors, rawColumnName, tableName);
            if (descriptor && descriptor.visible === false) {
                continue;
            }

            selectedIndexes.push(index);
            selectedColumns.push(buildDisplayColumnTitle(rawColumnName, descriptor, tableName));
        }

        if (selectedIndexes.length === 0) {
            return tableData;
        }

        const nextRows = rows.map(row => {
            const sourceRow = Array.isArray(row) ? row : [];
            return selectedIndexes.map(index => sanitizeTableCellValue(sourceRow[index]));
        });

        return {
            ...tableData,
            columns: selectedColumns,
            rows: nextRows
        };
    }

    function collectTableColumnDescriptorsFromElement(tableElement, tableName) {
        if (!tableElement || !Array.isArray(tableElement.children)) {
            return [];
        }

        const descriptors = [];
        for (const child of tableElement.children) {
            if (!isTableColumnElement(child)) {
                continue;
            }

            const name = firstDefined(child.name, lastSegment(child.path), '');
            if (!name) {
                continue;
            }

            const title = firstDefined(
                child.title,
                child.synonym,
                buildFallbackColumnTitle(name, tableName)
            );

            descriptors.push({
                key: toCaseFoldKey(name),
                shortKey: toCaseFoldKey(trimTechnicalTablePrefix(name, tableName)),
                title,
                visible: child.visible !== false
            });
        }

        return descriptors;
    }

    function isTableColumnElement(element) {
        const probe = normalizeQuery([element?.kind, element?.type].filter(Boolean).join(' '));
        return probe.includes('field') || probe.includes('поле');
    }

    function findColumnDescriptor(descriptors, rawColumnName, tableName) {
        if (!Array.isArray(descriptors) || descriptors.length === 0) {
            return null;
        }

        const key = toCaseFoldKey(rawColumnName);
        const shortKey = toCaseFoldKey(trimTechnicalTablePrefix(rawColumnName, tableName));

        return descriptors.find(descriptor => {
            return descriptor.key === key
                || (descriptor.shortKey && descriptor.shortKey === key)
                || (shortKey && (descriptor.key === shortKey || descriptor.shortKey === shortKey));
        }) || null;
    }

    function toCaseFoldKey(value) {
        return normalizeQuery(String(value || '')).replace(/[\s._-]+/g, '');
    }

    function buildDisplayColumnTitle(rawColumnName, descriptor, tableName) {
        if (descriptor && descriptor.title) {
            return descriptor.title;
        }
        return buildFallbackColumnTitle(rawColumnName, tableName);
    }

    function buildFallbackColumnTitle(rawColumnName, tableName) {
        const rawName = sanitizeTableCellValue(rawColumnName);
        if (!rawName) {
            return '';
        }

        const withoutPrefix = trimTechnicalTablePrefix(rawName, tableName);
        if (/^(line(number)?|linenumber)$/i.test(withoutPrefix)) {
            return '#';
        }

        const humanized = humanizeToken(withoutPrefix);
        return humanized || rawName;
    }

    function trimTechnicalTablePrefix(columnName, tableName) {
        const rawColumn = String(columnName || '');
        const rawTable = String(tableName || '');
        if (!rawColumn || !rawTable) {
            return rawColumn;
        }

        if (rawColumn.length > rawTable.length && rawColumn.toLowerCase().startsWith(rawTable.toLowerCase())) {
            return rawColumn.slice(rawTable.length);
        }

        return rawColumn;
    }

    function renderFormTableCard(entry) {
        const gherkinTable = buildGherkinTable(entry.label, entry.tableData);
        const rowCountShown = entry.tableData.rows.length;
        const rowCountTotal = Number.isFinite(entry.tableData.rowCount)
            ? Number(entry.tableData.rowCount)
            : rowCountShown;
        const rowMetricChips = renderStateChips([
            { label: `${t('tableRowsShown', 'Rows shown')}: ${rowCountShown}`, tone: 'neutral' },
            { label: `${t('tableRowsTotal', 'Rows total')}: ${rowCountTotal}`, tone: 'muted' }
        ]);
        const statusChips = renderStateChips([
            ...(entry.tableData.truncated ? [{ label: t('tableRowsTruncated', 'Table is truncated in snapshot.'), tone: 'warning' }] : [])
        ]);

        return `
            <article class="record-card form-table-card${entry.related ? ' is-highlighted' : ''}" data-table-key="${escapeHtml(entry.key)}">
                ${statusChips ? `<div class="chip-row compact">${statusChips}</div>` : ''}
                <button class="gherkin-inline-copy" type="button" data-action="copy-gherkin-inline">
                    <div class="gherkin-inline-head">
                        <span class="section-label">${escapeHtml(t('copyGherkinStep', 'Copy full step'))}</span>
                        <span class="codicon codicon-copy" aria-hidden="true"></span>
                    </div>
                    <pre class="gherkin-table-preview inline"><code>${escapeHtml(gherkinTable.fullStep)}</code></pre>
                </button>
            </article>
        `;
    }

    function buildGherkinTable(label, tableData) {
        const columns = tableData.columns.length > 0
            ? tableData.columns
            : Array.from(
                { length: Math.max(...tableData.rows.map(row => row.length), 0) },
                (_, index) => `Column${index + 1}`
            );
        if (columns.length === 0) {
            columns.push('Column1');
        }

        const normalizedRows = tableData.rows.map(row => {
            const copy = row.slice(0, columns.length);
            while (copy.length < columns.length) {
                copy.push('');
            }
            return copy;
        });

        const escapedRows = [columns, ...normalizedRows]
            .map(row => row.map(value => `'${escapeGherkinCell(value)}'`));
        const columnWidths = columns.map((_, columnIndex) => {
            return escapedRows.reduce((maxWidth, row) => {
                const width = row[columnIndex]?.length || 0;
                return width > maxWidth ? width : maxWidth;
            }, 0);
        });
        const tableLines = escapedRows.map(row => formatAlignedGherkinLine(row, columnWidths));

        const scenarioLanguage = getScenarioLanguage();
        const elementLabel = firstDefined(label, scenarioLanguage === 'ru' ? 'Список' : 'List');
        const escapedStepName = escapeGherkinSingleQuotedText(elementLabel);
        const header = scenarioLanguage === 'ru'
            ? `И таблица '${escapedStepName}' стала равной:`
            : `And '${escapedStepName}' table became equal`;
        const tableOnly = tableLines.join('\n');
        const fullStep = `${header}\n${tableOnly}`;

        return {
            tableOnly,
            fullStep
        };
    }

    function formatAlignedGherkinLine(row, columnWidths) {
        const paddedCells = row.map((value, index) => value.padEnd(columnWidths[index], ' '));
        return `    | ${paddedCells.join(' | ')} |`;
    }

    function getScenarioLanguage() {
        return String(viewState?.scenarioLanguage || '').toLowerCase() === 'ru' ? 'ru' : 'en';
    }

    function escapeGherkinSingleQuotedText(value) {
        return String(value || '')
            .replace(/\r\n|\r|\n/g, ' ')
            .replace(/'/g, "''");
    }

    function escapeGherkinCell(value) {
        return String(value || '')
            .replace(/\r\n|\r|\n/g, '\\n')
            .replace(/\|/g, '\\|')
            .replace(/'/g, "''");
    }

    function renderKeyFactCard(label, value, action, emphasize) {
        const normalizedValue = firstDefined(value, '');
        const className = `key-fact${normalizedValue ? '' : ' is-empty'}${emphasize ? ' emphasized' : ''}${normalizedValue && action ? ' is-copyable' : ''}`;
        if (!normalizedValue) {
            return `
                <div class="${className}">
                    <span class="key-fact-label">${escapeHtml(label)}</span>
                    <span class="key-fact-value empty">${escapeHtml(t('unknownValue', 'n/a'))}</span>
                </div>
            `;
        }

        return `
            <button class="${className}" type="button" data-action="${escapeHtml(action)}" data-value="${escapeHtml(normalizedValue)}">
                <span class="key-fact-label-row">
                    <span class="key-fact-label">${escapeHtml(label)}</span>
                    <span class="key-fact-copy codicon codicon-copy"></span>
                </span>
                <span class="key-fact-value">${escapeHtml(normalizedValue)}</span>
            </button>
        `;
    }

    function renderSectionCard(title, bodyHtml, options) {
        if (!bodyHtml) {
            return '';
        }
        const collapsible = Boolean(options?.collapsible);
        const expanded = collapsible ? options?.expanded === true : true;
        const action = collapsible ? String(options?.action || '') : '';
        const extraClassName = String(options?.className || '').trim();
        const sectionKey = String(options?.sectionKey || '').trim();
        const headerActionsHtml = String(options?.headerActionsHtml || '').trim();
        return `
            <section class="section-card${collapsible ? ' is-collapsible' : ''}${expanded ? ' is-expanded' : ' is-collapsed'}${extraClassName ? ` ${escapeHtml(extraClassName)}` : ''}"${sectionKey ? ` data-section-key="${escapeHtml(sectionKey)}"` : ''}>
                ${collapsible
                    ? `<div class="section-toggle-row">
                        <button class="section-toggle" type="button" data-action="${escapeHtml(action)}" aria-expanded="${expanded ? 'true' : 'false'}">
                            <span class="codicon codicon-chevron-${expanded ? 'down' : 'right'} section-toggle-icon"></span>
                            <span class="section-toggle-text">${escapeHtml(title)}</span>
                        </button>
                        ${headerActionsHtml ? `<div class="section-toggle-actions">${headerActionsHtml}</div>` : ''}
                    </div>`
                    : `<h3>${escapeHtml(title)}</h3>`}
                <div class="section-card-body${expanded ? '' : ' is-collapsed'}">
                    <div class="section-card-inner">
                        ${bodyHtml}
                    </div>
                </div>
            </section>
        `;
    }

    function toggleSectionCard(sectionKey, expanded) {
        if (!(refs.detailsPanel instanceof HTMLElement) || !sectionKey) {
            return false;
        }

        const card = refs.detailsPanel.querySelector(`.section-card[data-section-key="${sectionKey}"]`);
        if (!(card instanceof HTMLElement)) {
            return false;
        }

        applySectionExpandedState(card, expanded);
        return true;
    }

    function applySectionExpandedState(card, expanded) {
        card.classList.toggle('is-expanded', expanded);
        card.classList.toggle('is-collapsed', !expanded);

        const toggle = card.querySelector('.section-toggle');
        if (toggle instanceof HTMLElement) {
            toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            const icon = toggle.querySelector('.section-toggle-icon');
            if (icon instanceof HTMLElement) {
                icon.classList.toggle('codicon-chevron-down', expanded);
                icon.classList.toggle('codicon-chevron-right', !expanded);
            }
        }

        const body = card.querySelector('.section-card-body');
        if (body instanceof HTMLElement) {
            if (expanded) {
                body.classList.remove('is-collapsed');
                body.style.maxHeight = '0px';
                // Trigger reflow so expansion animation starts from 0.
                void body.offsetHeight;
                const expandedHeight = measureSectionBodyHeight(body);
                body.style.maxHeight = `${expandedHeight}px`;
                window.setTimeout(() => {
                    if (card.classList.contains('is-expanded')) {
                        body.style.maxHeight = 'none';
                    }
                }, 260);
            } else {
                const collapsedHeight = measureSectionBodyHeight(body);
                body.style.maxHeight = `${collapsedHeight}px`;
                void body.offsetHeight;
                body.classList.add('is-collapsed');
                body.style.maxHeight = '0px';
            }
        }
    }

    function measureSectionBodyHeight(body) {
        if (!(body instanceof HTMLElement)) {
            return 1;
        }

        const inner = body.querySelector('.section-card-inner');
        const innerHeight = inner instanceof HTMLElement ? inner.scrollHeight : 0;
        return Math.max(body.scrollHeight, innerHeight, 1);
    }

    function renderDetailRows(rows) {
        const visibleRows = rows.filter(Boolean);
        if (visibleRows.length === 0) {
            return renderEmptyState(t('unknownValue', 'n/a'), '');
        }
        return `<dl class="detail-list">${visibleRows.join('')}</dl>`;
    }

    function createDetailRow(label, value, emphasize) {
        if (!value) {
            return '';
        }
        const renderedValue = emphasize
            ? `<code>${escapeHtml(String(value))}</code>`
            : escapeHtml(String(value));
        return `
            <div class="detail-row">
                <dt>${escapeHtml(label)}</dt>
                <dd>${renderedValue}</dd>
            </div>
        `;
    }

    function createSourceDetailRow(label, source) {
        if (!source || !source.path) {
            return '';
        }

        const displayValue = formatSourceLocation(source);
        return `
            <div class="detail-row">
                <dt>${escapeHtml(label)}</dt>
                <dd>
                    <button
                        class="detail-link"
                        type="button"
                        data-action="open-source"
                        data-path="${escapeHtml(source.path)}"
                        ${source.line ? `data-line="${String(source.line)}"` : ''}
                        ${source.column ? `data-column="${String(source.column)}"` : ''}
                    >
                        <code>${escapeHtml(displayValue)}</code>
                    </button>
                </dd>
            </div>
        `;
    }

    function renderRecordPair(label, value) {
        if (!value) {
            return '';
        }
        return `
            <div class="record-pair">
                <dt>${escapeHtml(label)}</dt>
                <dd>${escapeHtml(String(value))}</dd>
            </div>
        `;
    }

    function renderEmptyState(title, hint) {
        return `
            <div class="empty-state">
                <strong>${escapeHtml(title)}</strong>
                ${hint ? `<span>${escapeHtml(hint)}</span>` : ''}
            </div>
        `;
    }

    function renderActionButton(options) {
        const attrs = [
            `class="${options.compact ? 'mini-btn compact' : 'mini-btn'}"`,
            'type="button"',
            `data-action="${escapeHtml(options.action)}"`
        ];

        if (options.value !== undefined) {
            attrs.push(`data-value="${escapeHtml(String(options.value))}"`);
        }
        if (options.source?.path) {
            attrs.push(`data-path="${escapeHtml(options.source.path)}"`);
            if (options.source.line) {
                attrs.push(`data-line="${String(options.source.line)}"`);
            }
            if (options.source.column) {
                attrs.push(`data-column="${String(options.source.column)}"`);
            }
        }

        return `
            <button ${attrs.join(' ')}>
                <span class="codicon codicon-${escapeHtml(options.icon)}"></span>
                <span>${escapeHtml(options.label)}</span>
            </button>
        `;
    }

    function renderStateChips(chips) {
        return chips.map(chip => `
            <span class="state-chip${chip.tone ? ` ${chip.tone}` : ''}">${escapeHtml(chip.label)}</span>
        `).join('');
    }

    function collectOutlineChips(element, activePath) {
        const chips = [];
        if (element.path === activePath || element.active) {
            chips.push({ label: t('active', 'Active'), tone: 'accent' });
        }
        if (element.visible === false) {
            chips.push({ label: t('hidden', 'Hidden'), tone: 'muted' });
        }
        if (element.available === false || element.enabled === false) {
            chips.push({ label: t('disabled', 'Disabled'), tone: 'warning' });
        }
        if (element.readOnly) {
            chips.push({ label: t('readOnly', 'Read-only'), tone: 'neutral' });
        }
        return chips;
    }

    function collectElementStateChips(element, activePath) {
        const chips = [];
        if (element.path === activePath || element.active) {
            chips.push({ label: t('active', 'Active'), tone: 'accent' });
        }
        if (element.visible !== undefined) {
            chips.push({
                label: element.visible ? t('visible', 'Visible') : t('hidden', 'Hidden'),
                tone: element.visible ? 'good' : 'muted'
            });
        }
        if (element.available !== undefined) {
            chips.push({
                label: element.available ? t('available', 'Available') : t('unavailable', 'Unavailable'),
                tone: element.available ? 'good' : 'warning'
            });
        }
        if (element.readOnly !== undefined) {
            chips.push({
                label: element.readOnly ? t('readOnly', 'Read-only') : t('writable', 'Writable'),
                tone: element.readOnly ? 'neutral' : 'good'
            });
        }
        return chips;
    }

    function collectAttributeStateChips(attribute, isHighlighted) {
        const chips = [];
        if (isHighlighted) {
            chips.push({ label: t('linkedAttribute', 'Linked attribute'), tone: 'accent' });
        }
        if (attribute.visible !== undefined) {
            chips.push({
                label: attribute.visible ? t('visible', 'Visible') : t('hidden', 'Hidden'),
                tone: attribute.visible ? 'good' : 'muted'
            });
        }
        if (attribute.available !== undefined) {
            chips.push({
                label: attribute.available ? t('available', 'Available') : t('unavailable', 'Unavailable'),
                tone: attribute.available ? 'good' : 'warning'
            });
        }
        if (attribute.readOnly !== undefined) {
            chips.push({
                label: attribute.readOnly ? t('readOnly', 'Read-only') : t('writable', 'Writable'),
                tone: attribute.readOnly ? 'neutral' : 'good'
            });
        }
        if (attribute.required) {
            chips.push({ label: t('required', 'Required'), tone: 'accent' });
        }
        return chips;
    }

    function collectCommandStateChips(command) {
        if (command.available === undefined) {
            return [];
        }
        return [{
            label: command.available ? t('available', 'Available') : t('unavailable', 'Unavailable'),
            tone: command.available ? 'good' : 'warning'
        }];
    }

    function filterElementTree(elements, query) {
        return (elements || [])
            .map(element => filterElementNode(element, query))
            .filter(Boolean);
    }

    function filterElementNode(element, query) {
        const children = (element.children || [])
            .map(child => filterElementNode(child, query))
            .filter(Boolean);
        const hiddenTechnical = !uiState.showTechnical && isTechnicalElement(element);
        const hiddenGroup = !uiState.showGroups && isGroupElement(element);
        const matchesSelf = !query || elementMatchesQuery(element, query);

        if ((hiddenTechnical || hiddenGroup) && children.length === 0) {
            return null;
        }

        if (!query) {
            return { ...element, children };
        }

        if (!hiddenTechnical && !hiddenGroup && (matchesSelf || children.length > 0)) {
            return { ...element, children };
        }

        if (children.length > 0) {
            return { ...element, children };
        }

        return null;
    }

    function flattenElements(elements, depth) {
        const result = [];
        for (const element of elements || []) {
            const baseDepth = depth || 0;
            const hiddenTechnical = !uiState.showTechnical && isTechnicalElement(element);
            const hiddenGroup = !uiState.showGroups && isGroupElement(element);
            if (!hiddenTechnical && !hiddenGroup) {
                result.push({ element, depth: baseDepth });
            }
            result.push(...flattenElements(element.children || [], (hiddenTechnical || hiddenGroup) ? baseDepth : baseDepth + 1));
        }
        return result;
    }

    function findElementByPath(elements, targetPath) {
        for (const element of elements || []) {
            if (element.path === targetPath) {
                return element;
            }
            const nested = findElementByPath(element.children || [], targetPath);
            if (nested) {
                return nested;
            }
        }
        return null;
    }

    function findActiveElementPath(elements) {
        for (const element of elements || []) {
            if (element.active) {
                return element.path;
            }
            const nested = findActiveElementPath(element.children || []);
            if (nested) {
                return nested;
            }
        }
        return '';
    }

    function elementMatchesQuery(element, query) {
        return matchesQuery([
            element.title,
            element.synonym,
            element.name,
            element.path,
            element.boundAttributePath,
            element.valuePreview,
            element.toolTip,
            element.inputHint
        ], query);
    }

    function matchesQuery(values, query) {
        return values.some(value => normalizeQuery(value).includes(query));
    }

    function scrollPendingSelectionIntoView() {
        if (!pendingScrollPath || !refs.elementTree) {
            return;
        }
        const rows = refs.elementTree.querySelectorAll('[data-action="select-element"]');
        for (const row of rows) {
            if (!(row instanceof HTMLElement)) {
                continue;
            }
            if (row.dataset.path === pendingScrollPath) {
                row.scrollIntoView({ block: 'center' });
                break;
            }
        }
        pendingScrollPath = '';
    }

    function isTechnicalElement(element) {
        const probe = normalizeQuery([
            element.path,
            element.name,
            element.kind,
            element.type
        ].filter(Boolean).join(' '));
        return /contextmenu|extendedtooltip|tooltip/.test(probe);
    }

    function isGroupElement(element) {
        const probe = normalizeQuery([element.kind, element.type].filter(Boolean).join(' '));
        return probe.includes('form group');
    }

    function getFormLabel(form) {
        return firstDefined(
            form?.windowTitle,
            form?.title,
            humanizeToken(form?.name),
            humanizeMetadataPath(form?.metadataPath),
            t('waitingForSnapshot', 'Waiting for snapshot')
        );
    }

    function getElementLabel(element, attributesByPath) {
        const linkedAttribute = element?.boundAttributePath ? attributesByPath?.get(element.boundAttributePath) : null;
        return firstDefined(
            element.title,
            linkedAttribute?.title,
            linkedAttribute?.synonym,
            element.synonym,
            humanizeToken(element.name),
            humanizeMetadataPath(element.boundAttributePath),
            humanizeMetadataPath(element.path),
            t('unknownValue', 'n/a')
        );
    }

    function getAttributeLabel(attribute) {
        return firstDefined(
            attribute.title,
            attribute.synonym,
            humanizeToken(attribute.name),
            humanizeMetadataPath(attribute.path),
            t('unknownValue', 'n/a')
        );
    }

    function humanizeMetadataPath(candidatePath) {
        if (!candidatePath) {
            return '';
        }
        const segment = lastSegment(candidatePath);
        return humanizeToken(segment) || candidatePath;
    }

    function humanizeToken(value) {
        if (!value) {
            return '';
        }
        return String(value)
            .replace(/[_-]+/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function formatDateTime(value) {
        if (!value) {
            return '';
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return String(value);
        }
        return date.toLocaleString();
    }

    function formatSourceLocation(source) {
        if (!source || !source.path) {
            return '';
        }
        const suffix = source.line
            ? `:${source.line}${source.column ? `:${source.column}` : ''}`
            : '';
        return `${source.path}${suffix}`;
    }

    function trimText(value, maxLength) {
        const text = String(value || '');
        if (text.length <= maxLength) {
            return text;
        }
        return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
    }

    function normalizeQuery(value) {
        return String(value || '').trim().toLocaleLowerCase();
    }

    function isTableLikeProbe(probe) {
        const normalized = normalizeQuery(probe);
        return normalized.includes('table')
            || normalized.includes('таблиц')
            || normalized.includes('dynamiclist')
            || normalized.includes('dynamic list')
            || normalized.includes('динамическийспис')
            || normalized.includes('динамический спис');
    }

    function firstDefined() {
        for (const value of arguments) {
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
        return '';
    }

    function lastSegment(value) {
        if (!value) {
            return '';
        }
        const parts = String(value).split('.').filter(Boolean);
        return parts[parts.length - 1] || '';
    }

    function parseNumber(value) {
        if (!value) {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    function bindClick(element, handler) {
        if (element) {
            element.addEventListener('click', handler);
        }
    }

    function setText(element, value) {
        if (element) {
            element.textContent = value || '';
        }
    }

    function renderOverflowMenu() {
        if (refs.moreActionsMenu instanceof HTMLElement) {
            refs.moreActionsMenu.classList.toggle('is-open', overflowMenuOpen);
        }
        if (refs.moreActionsBtn instanceof HTMLButtonElement) {
            refs.moreActionsBtn.setAttribute('aria-expanded', overflowMenuOpen ? 'true' : 'false');
        }
    }

    function renderFilterMenu() {
        if (refs.filterMenu instanceof HTMLElement) {
            refs.filterMenu.classList.toggle('is-open', filterMenuOpen);
        }
        if (refs.filterMenuBtn instanceof HTMLButtonElement) {
            refs.filterMenuBtn.setAttribute('aria-expanded', filterMenuOpen ? 'true' : 'false');
            refs.filterMenuBtn.classList.toggle('is-active', uiState.showTechnical || uiState.showGroups);
        }
    }

    function flashCopied(target) {
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const feedbackTarget = target;

        const previous = document.querySelector('.is-copied');
        if (previous instanceof HTMLElement && previous !== feedbackTarget) {
            previous.classList.remove('is-copied');
            previous.removeAttribute('data-copy-feedback');
        }

        feedbackTarget.classList.add('is-copied');
        feedbackTarget.setAttribute('data-copy-feedback', t('copied', 'Copied'));

        if (copiedResetTimer) {
            clearTimeout(copiedResetTimer);
        }

        copiedResetTimer = setTimeout(() => {
            feedbackTarget.classList.remove('is-copied');
            feedbackTarget.removeAttribute('data-copy-feedback');
        }, 1200);
    }

    function notifySelectionChanged() {
        const selectedPath = viewState.snapshot ? (uiState.selectedElementPath || '') : '';
        if (selectedPath === lastSelectionPosted) {
            return;
        }

        lastSelectionPosted = selectedPath;
        post('selectElementPath', { value: selectedPath });
    }

    function post(command, extra) {
        vscode.postMessage({
            command,
            ...(extra || {})
        });
    }

    function getSelectedElementFromState(snapshot) {
        const elements = snapshot?.elements || [];
        return uiState.selectedElementPath
            ? findElementByPath(elements, uiState.selectedElementPath)
            : null;
    }

    function persistUiState() {
        vscode.setState({ ...uiState });
    }

    function t(key, fallback) {
        return loc[key] || fallback;
    }

    window.addEventListener('resize', () => {
        syncAutoScrollText(
            document.body,
            '.outline-title, .outline-subtitle'
        );
    });

    function isKnownTab(value) {
        return value === 'selected'
            || value === 'attributes'
            || value === 'commands';
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
})();
