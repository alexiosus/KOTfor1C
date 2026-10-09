// Файл: media/phaseSwitcher.js
// Скрипт для управления интерфейсом Webview панели KOT for 1C

(function() {
    const vscode = acquireVsCodeApi();
    const scenarioProtocol = globalThis.PhaseSwitcherProtocol;
    if (!scenarioProtocol) {
        throw new Error('PhaseSwitcherProtocol is not loaded');
    }
    const scenarioFilesProtocol = globalThis.KotScenarioFilesProtocol;
    if (!scenarioFilesProtocol) {
        throw new Error('ScenarioFilesProtocol is not loaded');
    }
    const scenarioFileTransferController = scenarioFilesProtocol.createTransferController(
        message => vscode.postMessage(message)
    );

    // === Глобальные переменные состояния ===
    let testDataByPhase = {};
    let initialTestStates = {};
    let currentCheckboxStates = {};
    let testInfoByKey = new Map();
    let phaseExpandedState = {}; 
    let runArtifacts = {};
    const expandedScenarioResources = new Set();
    const expandedScenarioFileDirectories = new Set();
    const scenarioFileChildrenByParent = new Map();
    const scenarioFileNodesById = new Map();
    const pendingScenarioFileRequests = new Map();
    const pendingScenarioResourceAnimations = scenarioFilesProtocol.createPendingExpansionTracker();
    const scheduledScenarioResourceAnimations = new Set();
    const collapsingScenarioResourceIds = new Set();
    let relationshipState = scenarioProtocol.parseRelationshipState(undefined);
    let statusFilter = 'all';
    let currentVisibleScenarioKeys = [];
    let activeScenarioSearchQuery = '';
    const isScenarioSearchVisible = true;
    let settings = {
        assemblerEnabled: true,
        switcherEnabled: true,
        driveFeaturesEnabled: false,
        highlightAffectedMainScenarios: true,
        filterRelatedScenarios: false,
        statusFilter: 'all'
    };
    let isBuildInProgress = false;
    let isScenarioRepairInProgress = false;
    let isScenarioRepairCancelling = false;
    let isDemoMode = false;
    let phaseControlsActive = false;
    let areAllPhasesCurrentlyExpanded = false; 
    let activeContextMenu = null;
    let activeContextSubmenu = null;

    // === Получение ссылок на элементы DOM ===
    const assembleSplitContainer = document.getElementById('assembleSplitContainer');
    const assembleMenuBtn = document.getElementById('assembleMenuBtn');
    const assembleDropdownContent = document.getElementById('assembleDropdownContent');
    const openVanessaBtn = document.getElementById('openVanessaBtn');
    const openYamlParametersQuickBtn = document.getElementById('openYamlParametersQuickBtn');

    const scenarioSearchRow = document.getElementById('scenarioSearchRow');
    const scenarioSearchInput = document.getElementById('scenarioSearchInput');
    const scenarioSearchClearBtn = document.getElementById('scenarioSearchClearBtn');
    const selectedCount = document.getElementById('selectedCount');
    const selectableCount = document.getElementById('selectableCount');
    const clearSelectionBtn = document.getElementById('clearSelectionBtn');
    const selectionSummary = document.getElementById('selectionSummary');

    const phaseSwitcherSectionElements = document.querySelectorAll('.phase-switcher-section');
    const phaseTreeContainer = document.getElementById('phaseTreeContainer');

    const statusBar = document.getElementById('statusBar');
    const selectAllBtn = document.getElementById('selectAllBtn');

    const yamlProfileRow = document.getElementById('yamlProfileRow');
    const yamlProfileSelect = document.getElementById('yamlProfileSelect');
    const driveAccountingModeRow = document.getElementById('driveAccountingModeRow');
    const recordGLSelect = document.getElementById('recordGLSelect');

    const assembleBtn = document.getElementById('assembleTestsBtn');
    const cancelAssembleBtn = document.getElementById('cancelAssembleBtn');
    let currentRecordGLValue = '2';
    let yamlParameterProfiles = [];
    let activeYamlParameterProfileId = '';
    let mainStatusText = '';

    /**
     * Логирует сообщение в консоль webview и отправляет его в расширение.
     * @param {string} message - Сообщение для логирования.
     */
    function log(message) {
        console.log("[Webview]", message);
        vscode.postMessage({ command: 'log', text: "[Webview] " + message });
    }

    function renderMainStatusBar() {
        if (!(statusBar instanceof HTMLElement)) {
            return;
        }
        const visibleText = (typeof mainStatusText === 'string' ? mainStatusText : '').trim();
        statusBar.textContent = visibleText;
        statusBar.classList.remove('is-summary');
        statusBar.classList.toggle('is-empty', visibleText.length === 0);
    }

    /**
     * Обновляет текстовое содержимое статус-бара.
     * @param {string} text - Текст для отображения.
     * @param {'main' | 'assemble'} target - Целевая область статуса.
     */
    function updateStatus(text, target = 'main') {
        if (target === 'main' || target === 'assemble') {
            mainStatusText = typeof text === 'string' ? text : '';
            renderMainStatusBar();
        }
        updateTopRunButtonState();
        log(`Status updated [${target}]: ${text}`);
    }

    function rebuildTestInfoIndex() {
        const nextIndex = new Map();
        if (testDataByPhase && typeof testDataByPhase === 'object') {
            Object.values(testDataByPhase).forEach(groupItems => {
                if (!Array.isArray(groupItems)) {
                    return;
                }
                groupItems.forEach(testInfo => {
                    const scenarioKey = scenarioProtocol.getScenarioKey(testInfo);
                    if (scenarioKey) {
                        nextIndex.set(scenarioKey, testInfo);
                    }
                });
            });
        }
        testInfoByKey = nextIndex;
    }

    function getTestInfoByKey(key) {
        return typeof key === 'string' && key
            ? (testInfoByKey.get(key) || null)
            : null;
    }

    function getScenarioCommandFromElement(command, element, extra = {}) {
        if (!(element instanceof Element)) {
            return null;
        }
        const scenarioKey = element.getAttribute('data-key') || '';
        const testInfo = getTestInfoByKey(scenarioKey);
        return testInfo
            ? scenarioProtocol.createScenarioCommand(command, testInfo, extra)
            : null;
    }

    /**
     * Включает или отключает основные элементы управления Test Manager.
     * @param {boolean} enable - True для включения, false для отключения.
     */
    function enablePhaseControls(enable) {
        const isPhaseSwitcherVisible = settings.switcherEnabled;
        const effectiveEnable = enable && isPhaseSwitcherVisible && !isBuildInProgress;
        phaseControlsActive = effectiveEnable;
        const isDisabled = !effectiveEnable;

        if (selectAllBtn instanceof HTMLInputElement) selectAllBtn.disabled = isDisabled;

        if (phaseTreeContainer) {
            const checkboxes = phaseTreeContainer.querySelectorAll('.checkbox-item input[type="checkbox"]');
            checkboxes.forEach(cb => {
                if (cb instanceof HTMLInputElement) {
                    const isInitiallyDisabled = initialTestStates[cb.name] === 'disabled';
                    cb.removeEventListener('change', handleCheckboxChange);
                    cb.disabled = isDisabled || isInitiallyDisabled;
                    if (!cb.disabled) {
                        cb.addEventListener('change', handleCheckboxChange);
                    }
                    const checkboxLabel = cb.closest('.checkbox-item');
                    if (checkboxLabel instanceof HTMLElement) {
                        checkboxLabel.classList.toggle('disabled', cb.disabled);
                        checkboxLabel.classList.toggle('globally-disabled', isDisabled && !isInitiallyDisabled);
                    }
                }
            });
            const phaseHeaders = phaseTreeContainer.querySelectorAll('.phase-header');
            phaseHeaders.forEach(header => {
                if (isDisabled) header.classList.add('disabled-header');
                else header.classList.remove('disabled-header');

                const createScenarioButton = header.querySelector('.phase-create-main-btn');
                if (createScenarioButton instanceof HTMLButtonElement) {
                    createScenarioButton.disabled = isDisabled;
                }

                const countElement = header.querySelector('.phase-test-count');
                if (countElement instanceof HTMLElement) {
                    const phaseName = header instanceof HTMLElement ? header.dataset.phaseName : '';
                    const aggregate = phaseVisibilityAggregate(phaseName || '');
                    updatePhaseCountButton(
                        countElement,
                        phaseName || '',
                        aggregate.selectedCount,
                        aggregate.totalCount
                    );
                }
            });
        }
        updateRunButtonsState();
        log(`Phase controls enabled: ${effectiveEnable} (request ${enable}, feature ${isPhaseSwitcherVisible})`);
    }

    function setTooltipValue(element, title) {
        if (!(element instanceof HTMLElement)) {
            return;
        }
        const normalized = typeof title === 'string' ? title.trim() : '';
        if (normalized.length > 0) {
            element.title = normalized;
            return true;
        }
        return false;
    }

    function syncTooltipDataAttributes(root = document) {
        if (!root || typeof root.querySelectorAll !== 'function') {
            return;
        }
        root.querySelectorAll('[title]').forEach(node => {
            if (!(node instanceof HTMLElement)) {
                return;
            }
            setTooltipValue(node, node.getAttribute('title') || '');
        });
    }

    function updateRunButtonsState() {
        if (!phaseTreeContainer) return;
        const runButtons = phaseTreeContainer.querySelectorAll('.run-scenario-btn');
        runButtons.forEach(button => {
            if (button instanceof HTMLButtonElement) {
                const scenarioKey = button.getAttribute('data-key') || '';
                const runInfo = scenarioKey && runArtifacts ? runArtifacts[scenarioKey] : null;
                const hasRunArtifact = !!(runInfo && (runInfo.featurePath || runInfo.jsonPath));
                const isBlockingRunInProgress = runInfo?.runStatus === 'running' && runInfo?.blocksControls !== false;
                button.disabled = isBuildInProgress || isBlockingRunInProgress || !hasRunArtifact;
            }
        });
        updateTopRunButtonState();
    }

    function hasScenarioRunsInProgress() {
        if (isDemoMode || !runArtifacts || typeof runArtifacts !== 'object') {
            return false;
        }
        return Object.values(runArtifacts).some(info => !!info && info.runStatus === 'running' && info.blocksControls !== false);
    }

    function updateTopRunButtonState() {
        const canRun = settings.switcherEnabled && !isBuildInProgress;
        if (openVanessaBtn instanceof HTMLButtonElement) {
            openVanessaBtn.disabled = !canRun;
            openVanessaBtn.title = canRun
                ? (window.__loc?.runVanessaTopTitle || 'Open Vanessa')
                : (window.__loc?.statusBuildingInProgress || 'Building tests in progress...');
        }
    }

    function patchScenarioRelationshipDecorations() {
        if (!phaseTreeContainer) return;
        const scenarioLabels = phaseTreeContainer.querySelectorAll('.checkbox-item[data-key]');
        scenarioLabels.forEach(label => {
            if (!(label instanceof HTMLElement)) return;
            const scenarioKey = label.getAttribute('data-key') || '';
            const decoration = scenarioProtocol.relationshipDecorationForScenario(
                scenarioKey,
                relationshipState
            );
            const isRelationshipHighlighted = scenarioProtocol.isScenarioRelationshipHighlighted(
                scenarioKey,
                relationshipState
            );
            label.classList.toggle('affected-main-scenario', isRelationshipHighlighted);
            label.classList.toggle('is-related', isRelationshipHighlighted);
            label.classList.toggle('incoming-scenario', decoration.state === 'incoming');
            label.classList.toggle('outgoing-scenario', decoration.state === 'outgoing');
            label.classList.toggle(
                'transitive-scenario',
                decoration.state !== 'none' && !decoration.direct
            );
            label.classList.toggle(
                'is-transitive',
                decoration.state !== 'none' && !decoration.direct
            );
            if (decoration.accessibleLabel) {
                label.setAttribute('data-relationship-label', decoration.accessibleLabel);
            } else {
                label.removeAttribute('data-relationship-label');
            }
            const icon = label.querySelector('.scenario-relationship-icon');
            if (icon instanceof HTMLElement) {
                Array.from(icon.classList)
                    .filter(className => className.startsWith('codicon-'))
                    .forEach(className => icon.classList.remove(className));
                icon.classList.toggle('codicon', !!decoration.icon);
                if (decoration.icon) {
                    icon.classList.add(`codicon-${decoration.icon}`);
                    icon.setAttribute('role', 'img');
                    icon.setAttribute('aria-label', decoration.accessibleLabel);
                    icon.title = decoration.accessibleLabel;
                    icon.removeAttribute('aria-hidden');
                } else {
                    icon.removeAttribute('role');
                    icon.removeAttribute('aria-label');
                    icon.removeAttribute('title');
                    icon.setAttribute('aria-hidden', 'true');
                }
            }
        });

        const phaseGroups = phaseTreeContainer.querySelectorAll('.phase-group');
        phaseGroups.forEach(group => {
            if (!(group instanceof HTMLElement)) return;
            const scenarioKeys = Array.from(group.querySelectorAll('.checkbox-item[data-key]'))
                .map(label => label instanceof HTMLElement ? label.getAttribute('data-key') || '' : '')
                .filter(Boolean);
            const aggregate = scenarioProtocol.aggregatePhaseRelationship(
                scenarioKeys,
                relationshipState
            );
            const hasAffectedScenarioInGroup = aggregate.state === 'related';

            group.classList.toggle('phase-group-affected', hasAffectedScenarioInGroup);
            group.classList.toggle('is-related', hasAffectedScenarioInGroup);
            group.classList.toggle('is-transitive', hasAffectedScenarioInGroup && !aggregate.direct);
            if (aggregate.accessibleLabel) {
                group.setAttribute('data-relationship-label', aggregate.accessibleLabel);
            } else {
                group.removeAttribute('data-relationship-label');
            }
            const header = group.querySelector('.phase-header');
            if (header instanceof HTMLElement) {
                header.classList.toggle('phase-header-affected', hasAffectedScenarioInGroup);
            }
        });
    }

    function applyAffectedMainScenarioHighlighting() {
        patchScenarioRelationshipDecorations();
    }

    function visibilitySelectionStates() {
        const result = {};
        Object.keys(initialTestStates).forEach(key => {
            result[key] = initialTestStates[key] === 'disabled'
                ? 'disabled'
                : !!currentCheckboxStates[key];
        });
        return result;
    }

    function scenarioRelationshipPredicate(_testInfo, scenarioKey) {
        return settings.filterRelatedScenarios !== true
            || scenarioProtocol.isScenarioRelationshipMatch(scenarioKey, relationshipState);
    }

    function scenarioSearchPredicate(testInfo) {
        return scenarioProtocol.matchesScenarioSearch(testInfo, activeScenarioSearchQuery);
    }

    function phaseTestInfos(phaseName) {
        const items = Array.isArray(testDataByPhase?.[phaseName])
            ? testDataByPhase[phaseName]
            : [];
        return items.map(testInfo => Object.assign({}, testInfo, { phaseName }));
    }

    function phaseVisibilityAggregate(phaseName, states = visibilitySelectionStates()) {
        return scenarioProtocol.visibleScenarioAggregate(
            phaseTestInfos(phaseName),
            states,
            runArtifacts,
            statusFilter,
            scenarioRelationshipPredicate,
            scenarioSearchPredicate
        );
    }

    function applyScenarioVisibility() {
        if (!(phaseTreeContainer instanceof HTMLElement)) {
            currentVisibleScenarioKeys = [];
            return;
        }

        const states = visibilitySelectionStates();
        const allTestInfos = Object.keys(testDataByPhase || {})
            .flatMap(phaseName => phaseTestInfos(phaseName));
        const relationshipPredicate = scenarioRelationshipPredicate;
        const searchPredicate = scenarioSearchPredicate;
        const visibleAggregate = scenarioProtocol.visibleScenarioAggregate(
            allTestInfos,
            states,
            runArtifacts,
            statusFilter,
            relationshipPredicate,
            searchPredicate
        );
        const visibleKeys = new Set(visibleAggregate.visibleKeys);
        currentVisibleScenarioKeys = visibleAggregate.visibleKeys
            .filter(key => initialTestStates[key] !== 'disabled');

        phaseTreeContainer.querySelectorAll('.checkbox-item[data-key]').forEach(row => {
            if (!(row instanceof HTMLElement)) {
                return;
            }
            const scenarioKey = row.getAttribute('data-key') || '';
            const testInfo = getTestInfoByKey(scenarioKey);
            const runInfo = scenarioKey ? runArtifacts?.[scenarioKey] : null;
            const statusMatch = scenarioProtocol.matchesStatusFilter(runInfo, statusFilter);
            const relationshipMatch = !!testInfo && scenarioRelationshipPredicate(testInfo, scenarioKey);
            const searchMatch = !!testInfo && scenarioSearchPredicate(testInfo, scenarioKey);
            row.classList.toggle('status-hidden', !statusMatch);
            row.classList.toggle('relationship-hidden', !relationshipMatch);
            row.classList.toggle('search-hidden', !searchMatch);
            row.classList.toggle('search-match', !!activeScenarioSearchQuery && searchMatch);
            const itemContainer = row.closest('.item-container');
            if (itemContainer instanceof HTMLElement) {
                itemContainer.classList.toggle(
                    'filter-hidden',
                    !(statusMatch && relationshipMatch && searchMatch)
                );
            }
        });

        phaseTreeContainer.querySelectorAll('.phase-group').forEach(group => {
            if (!(group instanceof HTMLElement)) {
                return;
            }
            const header = group.querySelector('.phase-header');
            const phaseName = header instanceof HTMLElement ? header.dataset.phaseName || '' : '';
            const phaseAggregate = phaseVisibilityAggregate(phaseName, states);
            const hasVisibleScenario = phaseAggregate.visibleKeys.length > 0;
            group.classList.remove('relationship-hidden', 'search-hidden');
            group.classList.toggle('filter-hidden', !hasVisibleScenario);
            if (header instanceof HTMLElement) {
                header.classList.remove('relationship-hidden', 'search-hidden');
                const countElement = header.querySelector('.phase-test-count');
                if (countElement instanceof HTMLElement) {
                    updatePhaseCountButton(
                        countElement,
                        phaseName,
                        phaseAggregate.selectedCount,
                        phaseAggregate.totalCount
                    );
                }
                const compiledIndicator = header.querySelector('.phase-compiled-indicator');
                const phaseVisibleKeys = new Set(phaseAggregate.visibleKeys);
                updatePhaseCompiledIndicator(
                    compiledIndicator,
                    phaseTestInfos(phaseName).filter(testInfo =>
                        phaseVisibleKeys.has(scenarioProtocol.getScenarioKey(testInfo))
                    )
                );
            }
        });

        updateSelectionControls();
        updateAreAllPhasesExpandedState();
    }

    /**
     * Включает или отключает элементы управления сборкой тестов.
     * @param {boolean} enable - True для включения, false для отключения.
     */
     function enableAssembleControls(enable) {
         const isAssemblerVisible = settings.assemblerEnabled;
         const effectiveEnable = enable && isAssemblerVisible && !isBuildInProgress && !hasScenarioRunsInProgress();
         const showCancelButton = isAssemblerVisible && isBuildInProgress;
         const driveFeaturesVisible = settings.driveFeaturesEnabled !== false;
         const canSwitchYamlProfile = effectiveEnable && yamlParameterProfiles.length > 1;

         if (assembleSplitContainer instanceof HTMLElement) {
             assembleSplitContainer.style.display = isAssemblerVisible ? (showCancelButton ? 'none' : 'inline-flex') : 'none';
         }
         if (assembleBtn instanceof HTMLButtonElement) {
             assembleBtn.disabled = !effectiveEnable;
         }
         if (assembleMenuBtn instanceof HTMLButtonElement) {
             assembleMenuBtn.style.display = isAssemblerVisible ? 'inline-flex' : 'none';
             assembleMenuBtn.disabled = !effectiveEnable;
         }
         if (cancelAssembleBtn instanceof HTMLButtonElement) {
             cancelAssembleBtn.style.display = (isAssemblerVisible && showCancelButton) ? 'inline-flex' : 'none';
             cancelAssembleBtn.disabled = !showCancelButton;
         }
         if (yamlProfileRow instanceof HTMLElement) {
             yamlProfileRow.style.display = isAssemblerVisible ? 'flex' : 'none';
         }
         if (yamlProfileSelect instanceof HTMLSelectElement) {
             yamlProfileSelect.disabled = !canSwitchYamlProfile;
         }
         if (recordGLSelect instanceof HTMLSelectElement) {
             recordGLSelect.disabled = !effectiveEnable;
             recordGLSelect.classList.toggle('hidden', !driveFeaturesVisible);
         }
         if (driveAccountingModeRow instanceof HTMLElement) {
             driveAccountingModeRow.style.display = driveFeaturesVisible ? 'flex' : 'none';
         }
         updateAssembleMainButtonLayout();

         log(`Assemble controls enabled: ${effectiveEnable} (request ${enable}, feature ${isAssemblerVisible})`);
     }

    function updateAssembleMainButtonLayout() {
        if (!(assembleBtn instanceof HTMLButtonElement)) {
            return;
        }
        const content = assembleBtn.querySelector('.split-main-content');
        if (content instanceof HTMLElement) {
            content.style.transform = '';
        }

        if (!(assembleMenuBtn instanceof HTMLButtonElement)) {
            return;
        }
        const menuVisible = assembleMenuBtn.style.display !== 'none' && assembleMenuBtn.offsetParent !== null;
        if (!menuVisible) {
            return;
        }

        if (!(content instanceof HTMLElement)) {
            return;
        }
        const buttonRect = assembleBtn.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const menuRect = assembleMenuBtn.getBoundingClientRect();
        const overlapRight = contentRect.right - (menuRect.left - 4);
        if (overlapRight > 0) {
            const maxShiftLeft = Math.max(0, contentRect.left - (buttonRect.left + 4));
            const shiftLeft = Math.min(overlapRight, maxShiftLeft);
            content.style.transform = `translateX(${-shiftLeft}px)`;
        }
    }

    function normalizeRecordGLValue(value) {
        return value === '0' || value === '1' || value === '2' ? value : '2';
    }

    function updateRecordGLSelection(value) {
        currentRecordGLValue = normalizeRecordGLValue(value);
        if (recordGLSelect instanceof HTMLSelectElement) {
            recordGLSelect.value = currentRecordGLValue;
        }
    }

    function normalizeYamlParametersProfilesState(value) {
        const rawProfiles = Array.isArray(value?.profiles) ? value.profiles : [];
        const profiles = rawProfiles
            .map(profile => ({
                id: typeof profile?.id === 'string' ? profile.id.trim() : '',
                name: typeof profile?.name === 'string' ? profile.name.trim() : ''
            }))
            .filter(profile => profile.id.length > 0);
        const requestedActiveProfileId = typeof value?.activeProfileId === 'string'
            ? value.activeProfileId.trim()
            : '';
        const activeProfileId = profiles.some(profile => profile.id === requestedActiveProfileId)
            ? requestedActiveProfileId
            : (profiles[0]?.id || '');

        return { activeProfileId, profiles };
    }

    function renderYamlParametersProfileSelect() {
        if (!(yamlProfileSelect instanceof HTMLSelectElement)) {
            return;
        }

        yamlProfileSelect.textContent = '';
        if (yamlParameterProfiles.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = window.__loc?.selectProfile || 'Select profile';
            yamlProfileSelect.appendChild(option);
            yamlProfileSelect.value = '';
            return;
        }

        yamlParameterProfiles.forEach(profile => {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.name || profile.id;
            yamlProfileSelect.appendChild(option);
        });

        const resolvedActiveProfileId = yamlParameterProfiles.some(profile => profile.id === activeYamlParameterProfileId)
            ? activeYamlParameterProfileId
            : yamlParameterProfiles[0].id;
        activeYamlParameterProfileId = resolvedActiveProfileId;
        yamlProfileSelect.value = resolvedActiveProfileId;
    }

    function applyYamlParametersProfilesState(value) {
        const normalizedState = normalizeYamlParametersProfilesState(value);
        yamlParameterProfiles = normalizedState.profiles;
        activeYamlParameterProfileId = normalizedState.activeProfileId;
        renderYamlParametersProfileSelect();
    }

    /**
     * Экранирует специальные символы для использования в HTML атрибутах.
     * @param {string} unsafe - Небезопасная строка.
     * @returns {string} Экранированная строка.
     */
     function escapeHtmlAttr(unsafe) {
         if (typeof unsafe !== 'string') { try { unsafe = String(unsafe); } catch { return ''; } }
         return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
     }

    function escapeHtmlText(value) {
        if (typeof value !== 'string') {
            try {
                value = String(value);
            } catch {
                return '';
            }
        }
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function updateScenarioLabelOverflowFor(label) {
        if (!(label instanceof HTMLElement)) {
            return;
        }
        const content = label.querySelector('.kot-scroll-content');
        if (!(content instanceof HTMLElement)) {
            return;
        }
        const distance = Math.max(0, content.scrollWidth - label.clientWidth + 12);
        label.classList.toggle('is-overflowing', distance > 1);
        label.style.setProperty('--kot-overflow-distance', `${distance}px`);
        label.style.setProperty('--kot-overflow-duration', `${Math.max(1.2, distance / 45)}s`);
    }

    function updateScenarioLabelOverflow() {
        requestAnimationFrame(() => {
            for (const label of phaseTreeContainer?.querySelectorAll('.kot-tree-label') || []) {
                updateScenarioLabelOverflowFor(label);
            }
        });
    }

    const scenarioLabelResizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => updateScenarioLabelOverflow())
        : null;
    if (phaseTreeContainer && scenarioLabelResizeObserver) {
        scenarioLabelResizeObserver.observe(phaseTreeContainer);
    }

    function updateScenarioSearchClearButtonState() {
        if (!(scenarioSearchClearBtn instanceof HTMLButtonElement)) {
            return;
        }
        const value = scenarioSearchInput instanceof HTMLInputElement ? scenarioSearchInput.value : activeScenarioSearchQuery;
        const hasValue = typeof value === 'string' && value.trim().length > 0;
        scenarioSearchClearBtn.classList.toggle('hidden', !hasValue);
        scenarioSearchClearBtn.disabled = !hasValue;
    }

    function clearScenarioSearch(resetInput = true) {
        activeScenarioSearchQuery = '';
        if (resetInput && scenarioSearchInput instanceof HTMLInputElement) {
            scenarioSearchInput.value = '';
        }
        clearScenarioSearchHighlights();
        applyAffectedMainScenarioHighlighting();
        updateScenarioSearchClearButtonState();
        applyScenarioVisibility();
    }

    function clearScenarioSearchHighlights() {
        if (!(phaseTreeContainer instanceof HTMLElement)) {
            return;
        }
        phaseTreeContainer.classList.remove('scenario-search-active');
        const highlightedScenarios = phaseTreeContainer.querySelectorAll('.checkbox-item.search-match');
        highlightedScenarios.forEach(node => node.classList.remove('search-match'));
        const dimmedScenarios = phaseTreeContainer.querySelectorAll('.checkbox-item.search-dim');
        dimmedScenarios.forEach(node => node.classList.remove('search-dim'));
        const highlightedGroups = phaseTreeContainer.querySelectorAll('.phase-header.phase-header-search-match');
        highlightedGroups.forEach(node => node.classList.remove('phase-header-search-match'));
        const dimmedHeaders = phaseTreeContainer.querySelectorAll('.phase-header.phase-header-search-dim');
        dimmedHeaders.forEach(node => node.classList.remove('phase-header-search-dim'));
        const focusedPhaseGroups = phaseTreeContainer.querySelectorAll('.phase-group.phase-group-search-focus');
        focusedPhaseGroups.forEach(node => node.classList.remove('phase-group-search-focus'));
        const dimmedPhaseGroups = phaseTreeContainer.querySelectorAll('.phase-group.phase-group-search-dim');
        dimmedPhaseGroups.forEach(node => node.classList.remove('phase-group-search-dim'));
        phaseTreeContainer.querySelectorAll('.search-hidden').forEach(node => node.classList.remove('search-hidden'));
    }

    function syncScenarioSearchHighlightState(scrollToMatch = false) {
        if (!(scenarioSearchInput instanceof HTMLInputElement)) {
            clearScenarioSearchHighlights();
            applyAffectedMainScenarioHighlighting();
            updateScenarioSearchClearButtonState();
            applyScenarioVisibility();
            return;
        }
        activeScenarioSearchQuery = (scenarioSearchInput.value || '').trim();
        const shouldHighlight = isScenarioSearchVisible && activeScenarioSearchQuery.length > 0;

        if (shouldHighlight) {
            applyScenarioSearch(activeScenarioSearchQuery, scrollToMatch);
            return;
        }

        clearScenarioSearchHighlights();
        applyAffectedMainScenarioHighlighting();
        updateScenarioSearchClearButtonState();
        applyScenarioVisibility();
    }

    function applyScenarioSearch(query, scrollToMatch = true) {
        activeScenarioSearchQuery = (query || '').trim();
        clearScenarioSearchHighlights();
        applyAffectedMainScenarioHighlighting();
        updateScenarioSearchClearButtonState();

        if (!(phaseTreeContainer instanceof HTMLElement)) {
            return;
        }
        if (!activeScenarioSearchQuery) {
            return;
        }

        const scenarioLabels = Array.from(phaseTreeContainer.querySelectorAll('.checkbox-item[data-name]'));
        const matchedScenarioLabels = scenarioLabels.filter(node => {
            if (!(node instanceof HTMLElement)) {
                return false;
            }
            const phaseName = node.closest('.phase-group')?.querySelector('.phase-header')?.getAttribute('data-phase-name') || '';
            return scenarioProtocol.matchesScenarioSearch({
                name: node.getAttribute('data-name') || '',
                phaseName
            }, activeScenarioSearchQuery);
        });

        phaseTreeContainer.classList.add('scenario-search-active');

        const matchedPhaseGroups = new Set();
        matchedScenarioLabels.forEach(label => {
            if (!(label instanceof HTMLElement)) {
                return;
            }
            label.classList.add('search-match');
            const phaseGroup = label.closest('.phase-group');
            if (phaseGroup instanceof HTMLElement) {
                matchedPhaseGroups.add(phaseGroup);
            }
        });

        matchedPhaseGroups.forEach(phaseGroup => {
            if (!(phaseGroup instanceof HTMLElement)) {
                return;
            }
            phaseGroup.classList.add('phase-group-search-focus');

            const phaseHeader = phaseGroup.querySelector('.phase-header');
            if (phaseHeader instanceof HTMLElement) {
                phaseHeader.classList.add('phase-header-search-match');
            }
        });
        applyScenarioVisibility();
        if (scrollToMatch && matchedScenarioLabels[0] instanceof HTMLElement) {
            matchedScenarioLabels[0].scrollIntoView({ block: 'nearest' });
        }
    }

    function scenarioResourceId(node) {
        return typeof node?.id === 'string' && node.id
            ? node.id
            : scenarioFilesProtocol.scenarioResourceNodeKey(node);
    }

    function clearScenarioFileCache(itemId) {
        for (const [nodeId, node] of scenarioFileNodesById) {
            if (node?.itemId !== itemId) {
                continue;
            }
            scenarioFileNodesById.delete(nodeId);
            scenarioFileChildrenByParent.delete(nodeId);
            pendingScenarioFileRequests.delete(nodeId);
            expandedScenarioFileDirectories.delete(nodeId);
            pendingScenarioResourceAnimations.cancel(nodeId);
            scheduledScenarioResourceAnimations.delete(nodeId);
            collapsingScenarioResourceIds.delete(nodeId);
        }
    }

    function requestScenarioFileChildren(node) {
        const nodeId = scenarioResourceId(node);
        if (!nodeId || pendingScenarioFileRequests.has(nodeId)) {
            return;
        }
        scenarioFileNodesById.set(nodeId, node);
        pendingScenarioFileRequests.set(nodeId, nodeId);
        vscode.postMessage({
            command: 'listScenarioFiles',
            itemId: node.itemId,
            relativePath: node.relativePath || '',
            requestId: node.id
        });
    }

    function renderScenarioFileNode(node) {
        const nodeId = scenarioResourceId(node);
        scenarioFileNodesById.set(nodeId, node);
        const itemId = typeof node?.itemId === 'string' ? node.itemId : '';
        const relativePath = typeof node?.relativePath === 'string' ? node.relativePath : '';
        const isContainer = node?.kind === 'attachments' || node?.kind === 'directory';
        const expanded = isContainer && expandedScenarioFileDirectories.has(nodeId);
        const icon = node?.kind === 'feature'
            ? 'file'
            : node?.kind === 'file'
                ? 'file'
                : (expanded ? 'folder-opened' : 'folder');
        const label = typeof node?.label === 'string'
            ? node.label
            : (typeof node?.name === 'string' ? node.name : '');
        const depth = Math.max(1, Number(node?.depth) || 1);
        const escapedItemId = escapeHtmlAttr(itemId);
        const escapedPath = escapeHtmlAttr(relativePath);
        const escapedLabel = escapeHtmlText(label);
        const escapedNodeKey = escapeHtmlAttr(scenarioFilesProtocol.scenarioResourceNodeKey(node));
        const toggle = isContainer
            ? `<button type="button" class="scenario-resource-disclosure kot-tree-disclosure codicon codicon-chevron-${expanded ? 'down' : 'right'}" aria-expanded="${expanded}" title="${escapeHtmlAttr(label)}" aria-label="${escapeHtmlAttr(label)}"></button>`
            : '<span class="scenario-resource-disclosure-spacer"></span>';
        const actionTitle = node?.kind === 'feature'
            ? (window.__loc?.openScenarioTitle || 'Open scenario')
            : (window.__loc?.openExternally || 'Open externally');
        const leadingIcon = node?.kind === 'feature' || node?.kind === 'file'
            ? `<button type="button" class="scenario-resource-file-icon scenario-file-icon" title="${escapeHtmlAttr(actionTitle)}" aria-label="${escapeHtmlAttr(actionTitle)}">
                   <span class="codicon codicon-file open-scenario-icon-idle" aria-hidden="true"></span>
                   <span class="codicon codicon-go-to-file open-scenario-icon-action" aria-hidden="true"></span>
               </button>`
            : `<span class="codicon codicon-${icon} scenario-resource-icon"></span>`;
        const revealAction = node?.kind !== 'feature'
            ? `<button type="button" class="scenario-resource-reveal-btn kot-icon-button" title="${escapeHtmlAttr(window.__loc?.showInFileManager || 'Show in Finder / Explorer')}" aria-label="${escapeHtmlAttr(window.__loc?.showInFileManager || 'Show in Finder / Explorer')}">
                   <span class="codicon codicon-folder-opened"></span>
               </button>`
            : '';
        let childrenHtml = '';
        if (expanded) {
            const children = scenarioFileChildrenByParent.get(nodeId);
            if (!children) {
                requestScenarioFileChildren(node);
                childrenHtml = '<div class="scenario-resource-empty"><span class="codicon codicon-loading codicon-modifier-spin"></span></div>';
            } else if (children.length === 0) {
                childrenHtml = `<div class="scenario-resource-empty">${escapeHtmlText(window.__loc?.emptyDirectory || 'Empty directory')}</div>`;
            } else {
                childrenHtml = children.map(child => renderScenarioFileNode(child)).join('');
            }
        }
        const childrenPresentation = scenarioFilesProtocol.scenarioResourceChildrenPresentation(
            expanded,
            pendingScenarioResourceAnimations.has(nodeId)
        );
        return `<div class="scenario-resource-node" data-node-key="${escapedNodeKey}" data-resource-id="${escapeHtmlAttr(nodeId)}" data-kind="${escapeHtmlAttr(node?.kind || '')}" data-item-id="${escapedItemId}" data-relative-path="${escapedPath}" data-name="${escapeHtmlAttr(node?.name || label)}" data-depth="${depth}" style="--resource-depth:${depth}">
                    <div class="scenario-resource-row kot-tree-row${isContainer ? ' scenario-resource-drop-target' : ' is-openable'}" draggable="${node?.kind === 'file'}">
                        ${toggle}
                        ${leadingIcon}
                        <span class="scenario-resource-label kot-tree-label"><span class="kot-scroll-content">${escapedLabel}</span></span>
                        <span class="scenario-resource-actions">${revealAction}</span>
                    </div>
                    ${expanded ? `<div class="${childrenPresentation.className}" data-resource-expansion-id="${escapeHtmlAttr(nodeId)}" style="max-height:${childrenPresentation.maxHeight}">${childrenHtml}</div>` : ''}
                </div>`;
    }

    function renderCompiledScenarioResources(scenarioKey, runInfo) {
        if (!expandedScenarioResources.has(scenarioKey)) {
            return '';
        }
        const nodes = scenarioFilesProtocol.projectCompiledScenarioChildren({
            itemId: scenarioKey,
            scenarioKey,
            compiledFeatureUri: runInfo?.compiledFeatureUri,
            scenarioFilesRootUri: runInfo?.scenarioFilesRootUri,
            depth: 0
        }, { files: window.__loc?.files || 'Files' });
        return `<div class="scenario-resource-tree expanded" role="group" data-scenario-key="${escapeHtmlAttr(scenarioKey)}" style="max-height:none">${nodes.map(renderScenarioFileNode).join('')}</div>`;
    }

    /**
     * Создает HTML-разметку для чекбокса теста.
     * @param {object} testInfo - Информация о тесте.
     * @returns {string} HTML-строка.
     */
    function createCheckboxHtml(testInfo) {
        const viewState = buildScenarioViewState(testInfo);
        if (!viewState) {
             log("ERROR: Invalid testInfo in createCheckboxHtml!");
             const checkboxError = window.__loc?.checkboxDataError || 'Checkbox data error';
             return `<p style="color:var(--vscode-errorForeground);">${checkboxError}</p>`;
        }

        return `
            <div class="item-container">
                <label class="checkbox-item kot-tree-row${viewState.relationshipClassNames}${viewState.hasCompiledResources ? ' scenario-resource-drop-target' : ''}" id="label-${viewState.safeName}" for="chk-${viewState.safeName}" data-key="${viewState.escapedScenarioKeyAttr}" data-item-id="${viewState.escapedScenarioKeyAttr}" data-relative-path="" data-name="${viewState.escapedNameAttr}" data-uri="${viewState.escapedFileUriAttr}" data-relationship-label="${viewState.escapedRelationshipLabel}" title="${viewState.escapedTitleAttr}" tabindex="0" role="treeitem">
                    ${viewState.resourceToggleHtml}
                    ${viewState.leadingControlHtml}
                    ${viewState.relationshipIconHtml}
                    ${viewState.openButtonHtml}
                    <span class="checkbox-label-text kot-tree-label"><span class="kot-scroll-content">${escapeHtmlText(viewState.name)}</span></span>
                    <span class="kot-row-actions">
                        ${viewState.runLogButtonHtml}
                        ${viewState.progressHtml}
                        ${viewState.runButtonHtml}
                    </span>
                </label>
                ${viewState.resourceTreeHtml}
            </div>
        `;
    }

    function buildScenarioViewState(testInfo) {
        if (!testInfo || typeof testInfo.name !== 'string' || !testInfo.name) {
            return null;
        }

        const scenarioKey = scenarioProtocol.getScenarioKey(testInfo);
        if (!scenarioKey) {
            return null;
        }
        const name = testInfo.name;
        const relativePath = testInfo.relativePath || '';
        const safeName = scenarioKey.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        const escapedScenarioKeyAttr = escapeHtmlAttr(scenarioKey);
        const escapedNameAttr = escapeHtmlAttr(name);
        const escapedTitleAttr = escapeHtmlAttr(relativePath);
        const fileUriString = testInfo.yamlFileUriString || '';
        const escapedFileUriAttr = escapeHtmlAttr(fileUriString);
        const relationshipDecoration = scenarioProtocol.relationshipDecorationForScenario(
            scenarioKey,
            relationshipState
        );
        const isRelationshipHighlighted = scenarioProtocol.isScenarioRelationshipHighlighted(
            scenarioKey,
            relationshipState
        );
        const relationshipClassNames = [
            isRelationshipHighlighted ? 'affected-main-scenario' : '',
            isRelationshipHighlighted ? 'is-related' : '',
            relationshipDecoration.state === 'incoming' ? 'incoming-scenario' : '',
            relationshipDecoration.state === 'outgoing' ? 'outgoing-scenario' : '',
            relationshipDecoration.state !== 'none' && !relationshipDecoration.direct
                ? 'transitive-scenario'
                : '',
            relationshipDecoration.state !== 'none' && !relationshipDecoration.direct
                ? 'is-transitive'
                : ''
        ].filter(Boolean).map(className => ` ${className}`).join('');
        const escapedRelationshipLabel = escapeHtmlAttr(relationshipDecoration.accessibleLabel);
        const relationshipIconHtml = relationshipDecoration.icon
            ? `<span class="scenario-relationship-icon codicon codicon-${escapeHtmlAttr(relationshipDecoration.icon)}" role="img" aria-label="${escapedRelationshipLabel}" title="${escapedRelationshipLabel}"></span>`
            : '';
        const escapedIconTitle = escapeHtmlAttr((window.__loc?.openScenarioFileTitle || 'Open scenario file {0}').replace('{0}', name));
        const runInfo = runArtifacts && typeof runArtifacts === 'object'
            ? runArtifacts[scenarioKey]
            : null;
        const hasCompiledResources = !!(
            runInfo?.compiledFeatureUri
            && runInfo?.scenarioFilesRootUri
        );
        const resourcesExpanded = hasCompiledResources && expandedScenarioResources.has(scenarioKey);
        const resourceToggleTitle = resourcesExpanded
            ? (window.__loc?.collapsePhaseTitle || 'Collapse group')
            : (window.__loc?.expandPhaseTitle || 'Expand group');
        const resourceToggleHtml = hasCompiledResources
            ? `<button type="button" class="scenario-resource-toggle kot-tree-disclosure codicon codicon-chevron-${resourcesExpanded ? 'down' : 'right'}" data-key="${escapedScenarioKeyAttr}" aria-expanded="${resourcesExpanded}" title="${escapeHtmlAttr(resourceToggleTitle)}" aria-label="${escapeHtmlAttr(resourceToggleTitle)}"></button>`
            : '<span class="scenario-resource-toggle-spacer" aria-hidden="true"></span>';
        const resourceTreeHtml = hasCompiledResources
            ? renderCompiledScenarioResources(scenarioKey, runInfo)
            : '';
        const hasRunArtifact = !!(runInfo && (runInfo.featurePath || runInfo.jsonPath));
        const runStatus = runInfo?.runStatus || 'idle';
        const shouldShowRunIndicator = hasRunArtifact || runStatus !== 'idle';
        const isStale = Boolean(runInfo?.stale);
        const isRunInProgress = runStatus === 'running';
        const isBlockingRunInProgress = isRunInProgress && runInfo?.blocksControls !== false;
        const isRunPassed = runStatus === 'passed';
        const isRunPassedStale = isRunPassed && isStale;
        const isRunPassedFresh = isRunPassed && !isStale;
        const isRunFailed = runStatus === 'failed';
        const runMessage = typeof runInfo?.runMessage === 'string' ? runInfo.runMessage.trim() : '';
        const activeRunLogPath = typeof runInfo?.activeRunLogPath === 'string' ? runInfo.activeRunLogPath.trim() : '';
        const activeRunSource = typeof runInfo?.activeRunSource === 'string' ? runInfo.activeRunSource : '';
        const progress = scenarioProtocol.formatRunProgress({
            isRunning: isRunInProgress,
            currentLine: runInfo?.progressCurrentLine,
            totalLines: runInfo?.progressTotalLines,
            percent: runInfo?.progressPercent,
            iteration: runInfo?.progressIteration
        });
        const hasLineProgress = progress.hasLineProgress;
        const progressTitle = progress.title;
        const progressCounterText = progress.counterText;
        const progressBadgeText = progress.badgeText;
        const runTitleTemplate = window.__loc?.runScenarioJsonTitle || 'Run scenario in Vanessa Automation by json: {0}';
        const runTitle = runTitleTemplate.replace('{0}', name);
        const staleSuffix = isStale ? ` • ${window.__loc?.runScenarioStaleSuffix || 'Build is stale'}` : '';
        const trackedSourceSuffix = activeRunSource === 'tracked'
            ? ` • ${window.__loc?.runScenarioTrackedSourceSuffix || 'Tracked log'}`
            : '';
        const statusSuffix = isRunInProgress
            ? ` • ${window.__loc?.runScenarioRunningSuffix || 'Run in progress'}`
            : (isRunPassed
                ? ` • ${window.__loc?.runScenarioPassedSuffix || 'Last run passed'}`
                : (isRunFailed
                    ? ` • ${window.__loc?.runScenarioFailedSuffix || 'Last run failed'}`
                    : ''));
        const runButtonClass = [
            'run-scenario-btn',
            isStale ? 'run-scenario-btn-stale' : '',
            isRunInProgress ? 'run-scenario-btn-running' : '',
            isRunPassedFresh ? 'run-scenario-btn-passed' : '',
            isRunPassedStale ? 'run-scenario-btn-stale-passed' : '',
            isRunFailed ? 'run-scenario-btn-failed' : ''
        ].filter(Boolean).join(' ');
        const runButtonIconClass = isRunPassed
            ? 'codicon codicon-check'
            : 'codicon codicon-play-circle';
        const runButtonIconHtml = isRunFailed
            ? `<span class="codicon codicon-error run-scenario-icon-failed"></span>
               <span class="codicon codicon-play-circle run-scenario-icon-retry"></span>`
            : `<span class="${runButtonIconClass}"></span>`;
        const selectedLogTemplate = window.__loc?.runScenarioSelectedLog || 'Log: {0}';
        const runButtonTitle = `${runTitle}${statusSuffix}${trackedSourceSuffix}${staleSuffix}${progressTitle ? ` • ${progressTitle}` : ''}${runMessage ? `\n${runMessage}` : ''}${activeRunLogPath ? `\n${selectedLogTemplate.replace('{0}', activeRunLogPath)}` : ''}`;
        const escapedRunTitle = escapeHtmlAttr(runButtonTitle);
        const runButtonDisabledAttr = ((isBuildInProgress && !isDemoMode) || isBlockingRunInProgress || !hasRunArtifact) ? ' disabled' : '';
        const canOpenFailedStepInFeature = isRunFailed && !!runInfo?.featurePath;
        const runStepTitleTemplate = window.__loc?.runScenarioOpenFailedStepTitle || 'Open failed step in feature: {0}';
        const runStepTitle = escapeHtmlAttr(runStepTitleTemplate.replace('{0}', name));
        const runInProgressTitle = window.__loc?.runScenarioRunningSuffix || 'Run in progress';
        const escapedRunInProgressTitle = escapeHtmlAttr(runInProgressTitle);
        const leadingControlHtml = isRunInProgress
            ? `<span class="checkbox-run-indicator" title="${escapedRunInProgressTitle}">
                   <span class="codicon codicon-loading codicon-modifier-spin"></span>
               </span>`
            : `<input
                        type="checkbox"
                        id="chk-${safeName}"
                        name="${escapedScenarioKeyAttr}">`;
        const progressHtml = hasLineProgress
            ? `<span class="scenario-run-progress has-hover-counter" title="${escapeHtmlAttr(progressTitle)}">
                   <span class="scenario-run-progress-percent">${escapeHtmlText(progressBadgeText)}</span>
                   <span class="scenario-run-progress-counter">${escapeHtmlText(progressCounterText)}</span>
               </span>`
            : '';

        const openButtonHtml = fileUriString
            ? `<button type="button" class="open-scenario-btn scenario-file-icon" data-key="${escapedScenarioKeyAttr}" data-name="${escapedNameAttr}" data-uri="${escapedFileUriAttr}" title="${escapedIconTitle}" aria-label="${escapedIconTitle}">
                   <span class="codicon codicon-file open-scenario-icon-idle" aria-hidden="true"></span>
                   <span class="codicon codicon-go-to-file open-scenario-icon-action" aria-hidden="true"></span>
               </button>`
            : '';

        const runButtonHtml = shouldShowRunIndicator && !isBlockingRunInProgress
            ? `<button class="${runButtonClass}" data-key="${escapedScenarioKeyAttr}" data-name="${escapedNameAttr}" data-uri="${escapedFileUriAttr}" title="${escapedRunTitle}"${runButtonDisabledAttr}>
                   ${runButtonIconHtml}
               </button>`
            : '';
        const runLogButtonHtml = canOpenFailedStepInFeature
            ? `<button class="run-scenario-log-btn" data-key="${escapedScenarioKeyAttr}" data-name="${escapedNameAttr}" data-uri="${escapedFileUriAttr}" title="${runStepTitle}">
                   <span class="codicon codicon-go-to-file"></span>
               </button>`
            : '';

        return {
            name,
            scenarioKey,
            relativePath,
            safeName,
            escapedScenarioKeyAttr,
            escapedNameAttr,
            escapedFileUriAttr,
            fileUriString,
            escapedTitleAttr,
            relationshipDecoration,
            relationshipClassNames,
            escapedRelationshipLabel,
            relationshipIconHtml,
            isRunInProgress,
            hasLineProgress,
            progressBadgeText,
            progressCounterText,
            progressTitle,
            leadingControlHtml,
            runButtonHtml,
            runLogButtonHtml,
            progressHtml,
            openButtonHtml,
            resourceToggleHtml,
            resourceTreeHtml,
            hasCompiledResources,
            runInProgressTitle
        };
    }

    function createElementFromHtml(html) {
        if (typeof html !== 'string' || !html.trim()) {
            return null;
        }
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        return template.content.firstElementChild;
    }

    function findDirectScenarioChild(label, predicate) {
        return Array.from(label.children).find(predicate) || null;
    }

    function insertScenarioChildBefore(label, element, selector) {
        if (!(element instanceof Element)) {
            return;
        }
        const anchor = selector ? label.querySelector(selector) : null;
        if (anchor?.parentElement) {
            anchor.parentElement.insertBefore(element, anchor);
            return;
        }
        const actions = label.querySelector('.kot-row-actions');
        if (actions instanceof HTMLElement) {
            actions.appendChild(element);
        } else {
            label.appendChild(element);
        }
    }

    function syncScenarioLeadingControl(label, viewState) {
        const labelText = findDirectScenarioChild(
            label,
            child => child instanceof HTMLElement && child.classList.contains('checkbox-label-text')
        );
        if (!(labelText instanceof HTMLElement)) {
            return;
        }
        const scenarioFileIcon = findDirectScenarioChild(
            label,
            child => child instanceof HTMLElement && child.classList.contains('scenario-file-icon')
        );
        const leadingControlAnchor = scenarioFileIcon instanceof HTMLElement
            ? scenarioFileIcon
            : labelText;

        const existingCheckbox = findDirectScenarioChild(
            label,
            child => child instanceof HTMLInputElement && child.type === 'checkbox'
        );
        const existingIndicator = findDirectScenarioChild(
            label,
            child => child instanceof HTMLElement && child.classList.contains('checkbox-run-indicator')
        );

        if (viewState.isRunInProgress) {
            if (existingCheckbox instanceof HTMLInputElement) {
                existingCheckbox.remove();
            }
            if (existingIndicator instanceof HTMLElement) {
                existingIndicator.title = viewState.runInProgressTitle;
                return;
            }
            const indicator = createElementFromHtml(viewState.leadingControlHtml);
            if (indicator) {
                label.insertBefore(indicator, leadingControlAnchor);
            }
            return;
        }

        if (existingIndicator instanceof HTMLElement) {
            existingIndicator.remove();
        }
        if (existingCheckbox instanceof HTMLInputElement) {
            existingCheckbox.id = `chk-${viewState.safeName}`;
            existingCheckbox.name = viewState.scenarioKey;
            return;
        }
        const checkbox = createElementFromHtml(viewState.leadingControlHtml);
        if (checkbox) {
            label.insertBefore(checkbox, leadingControlAnchor);
        }
    }

    function syncScenarioProgress(label, viewState) {
        const existingProgress = label.querySelector('.scenario-run-progress');
        if (!viewState.hasLineProgress) {
            if (existingProgress instanceof HTMLElement) {
                existingProgress.remove();
            }
            return;
        }

        if (!(existingProgress instanceof HTMLElement)) {
            const progressElement = createElementFromHtml(viewState.progressHtml);
            if (progressElement) {
                insertScenarioChildBefore(label, progressElement, '.run-scenario-btn');
            }
            return;
        }

        existingProgress.classList.add('has-hover-counter');
        existingProgress.title = viewState.progressTitle;
        const percentElement = existingProgress.querySelector('.scenario-run-progress-percent');
        const counterElement = existingProgress.querySelector('.scenario-run-progress-counter');
        if (percentElement instanceof HTMLElement && counterElement instanceof HTMLElement) {
            percentElement.textContent = viewState.progressBadgeText;
            counterElement.textContent = viewState.progressCounterText;
        } else {
            existingProgress.innerHTML = `
                <span class="scenario-run-progress-percent">${escapeHtmlText(viewState.progressBadgeText)}</span>
                <span class="scenario-run-progress-counter">${escapeHtmlText(viewState.progressCounterText)}</span>
            `;
        }
    }

    function syncScenarioActionButton(label, selector, html, anchorSelector) {
        const existingButton = label.querySelector(selector);
        if (!html) {
            if (existingButton instanceof HTMLElement) {
                existingButton.remove();
            }
            return;
        }

        const desiredButton = createElementFromHtml(html);
        if (!(desiredButton instanceof HTMLButtonElement)) {
            return;
        }

        if (!(existingButton instanceof HTMLButtonElement)) {
            insertScenarioChildBefore(label, desiredButton, anchorSelector);
            return;
        }

        existingButton.className = desiredButton.className;
        existingButton.title = desiredButton.title;
        existingButton.disabled = desiredButton.disabled;
        const desiredName = desiredButton.getAttribute('data-name');
        if (desiredName !== null) {
            existingButton.setAttribute('data-name', desiredName);
        }
        const desiredKey = desiredButton.getAttribute('data-key');
        if (desiredKey !== null) {
            existingButton.setAttribute('data-key', desiredKey);
        } else {
            existingButton.removeAttribute('data-key');
        }
        const desiredUri = desiredButton.getAttribute('data-uri');
        if (desiredUri !== null) {
            existingButton.setAttribute('data-uri', desiredUri);
        } else {
            existingButton.removeAttribute('data-uri');
        }
        existingButton.innerHTML = desiredButton.innerHTML;
    }

    function updateVisibleScenarioRunState() {
        if (!(phaseTreeContainer instanceof HTMLElement)) {
            return;
        }

        const scenarioLabels = phaseTreeContainer.querySelectorAll('.checkbox-item[data-key]');
        scenarioLabels.forEach(label => {
            if (!(label instanceof HTMLElement)) {
                return;
            }
            const scenarioKey = label.getAttribute('data-key') || '';
            const testInfo = getTestInfoByKey(scenarioKey);
            const viewState = buildScenarioViewState(testInfo);
            if (!viewState) {
                return;
            }

            label.title = viewState.relativePath;
            label.setAttribute('data-key', viewState.scenarioKey);
            label.setAttribute('data-uri', viewState.fileUriString);
            syncScenarioLeadingControl(label, viewState);
            syncScenarioProgress(label, viewState);
            syncScenarioActionButton(label, '.run-scenario-log-btn', viewState.runLogButtonHtml, '.scenario-run-progress, .run-scenario-btn');
            syncScenarioActionButton(label, '.run-scenario-btn', viewState.runButtonHtml, '');
        });

        applyCheckboxStatesToVisible();
    }

    function capturePhaseTreeViewState() {
        if (!(phaseTreeContainer instanceof HTMLElement)) {
            return { scrollTop: 0, focusedScenarioKey: '', expandedPhaseNames: [] };
        }
        const focusedRow = document.activeElement instanceof Element
            ? document.activeElement.closest('.checkbox-item[data-key]')
            : null;
        return {
            scrollTop: phaseTreeContainer.scrollTop,
            focusedScenarioKey: focusedRow instanceof HTMLElement
                ? (focusedRow.getAttribute('data-key') || '')
                : '',
            expandedPhaseNames: Object.entries(phaseExpandedState)
                .filter(([, expanded]) => expanded)
                .map(([phaseName]) => phaseName)
        };
    }

    function restorePhaseTreeViewState(viewState) {
        if (!(phaseTreeContainer instanceof HTMLElement) || !viewState) {
            return;
        }
        phaseTreeContainer.scrollTop = Number.isFinite(viewState.scrollTop) ? viewState.scrollTop : 0;
        if (!viewState.focusedScenarioKey) {
            return;
        }
        const row = Array.from(phaseTreeContainer.querySelectorAll('.checkbox-item[data-key]'))
            .find(element => element instanceof HTMLElement
                && element.getAttribute('data-key') === viewState.focusedScenarioKey);
        if (row instanceof HTMLElement) {
            row.focus({ preventScroll: true });
        }
    }

    /**
     * Отрисовывает дерево фаз и тестов.
     * @param {object} allPhaseData - Данные о фазах и тестах.
     */
    function renderPhaseTree(allPhaseData) {
        log('Rendering phase tree...');
        if (!phaseTreeContainer) { log("Error: Phase tree container not found!"); return; }
        const preservedViewState = capturePhaseTreeViewState();
        phaseTreeContainer.innerHTML = '';

        const sortedPhaseNames = Object.keys(allPhaseData).sort();

        if (sortedPhaseNames.length === 0) {
            const noPhasesMessage = window.__loc?.noPhasesToDisplay || 'No groups to display.';
            phaseTreeContainer.innerHTML = `<p>${noPhasesMessage}</p>`;
            return;
        }

        const newPhaseExpandedState = {};
        sortedPhaseNames.forEach(phaseName => {
            newPhaseExpandedState[phaseName] = phaseExpandedState.hasOwnProperty(phaseName) ? phaseExpandedState[phaseName] : false;
        });
        phaseExpandedState = newPhaseExpandedState;
        updateAreAllPhasesExpandedState();

        sortedPhaseNames.forEach(phaseName => {
            const testsInPhase = allPhaseData[phaseName];
            const phaseGroupId = 'phase-group-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
            const phaseHeaderId = 'phase-header-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
            const testsListId = 'tests-list-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');

            let enabledCount = 0;
            let totalInPhase = 0;

            if (Array.isArray(testsInPhase)) {
                testsInPhase.forEach(testInfo => {
                    const scenarioKey = scenarioProtocol.getScenarioKey(testInfo);
                    if (scenarioKey && initialTestStates[scenarioKey] !== 'disabled') {
                        totalInPhase++;
                        if (currentCheckboxStates[scenarioKey]) {
                            enabledCount++;
                        }
                    }
                });
            }

            const phaseGroupDiv = document.createElement('div');
            phaseGroupDiv.className = 'phase-group';
            phaseGroupDiv.id = phaseGroupId;
            phaseGroupDiv.setAttribute('role', 'group');

            const phaseHeaderDiv = document.createElement('div');
            phaseHeaderDiv.className = 'phase-header kot-tree-row';
            phaseHeaderDiv.id = phaseHeaderId;
            phaseHeaderDiv.dataset.phaseName = phaseName;

            const expandCollapseButton = document.createElement('button');
            expandCollapseButton.type = 'button';
            expandCollapseButton.className = 'phase-expand-collapse-btn button-with-icon';
            expandCollapseButton.setAttribute('aria-expanded', phaseExpandedState[phaseName] ? 'true' : 'false');
            expandCollapseButton.setAttribute('aria-controls', testsListId);
            expandCollapseButton.title = phaseExpandedState[phaseName]
                ? (window.__loc?.collapsePhaseTitle || 'Collapse group')
                : (window.__loc?.expandPhaseTitle || 'Expand group');
            expandCollapseButton.setAttribute('aria-label', expandCollapseButton.title);

            const iconSpan = document.createElement('span');
            iconSpan.className = `codicon phase-toggle-icon kot-tree-disclosure ${phaseExpandedState[phaseName] ? 'codicon-chevron-down' : 'codicon-chevron-right'}`;
            expandCollapseButton.appendChild(iconSpan);

            const phaseCheckbox = document.createElement('input');
            phaseCheckbox.type = 'checkbox';
            phaseCheckbox.className = 'phase-select-checkbox';
            phaseCheckbox.dataset.phaseName = phaseName;
            phaseCheckbox.title = window.__loc?.toggleAllInPhaseTitle || 'Toggle all tests in this group';
            phaseCheckbox.setAttribute('aria-label', phaseCheckbox.title);

            const folderSpan = document.createElement('span');
            folderSpan.className = 'codicon codicon-folder phase-folder-icon';
            folderSpan.setAttribute('aria-hidden', 'true');

            const titleSpan = document.createElement('span');
            titleSpan.className = 'phase-title kot-tree-label';
            const titleContent = document.createElement('span');
            titleContent.className = 'kot-scroll-content';
            titleContent.textContent = phaseName;
            titleSpan.appendChild(titleContent);

            const phaseLabelButton = document.createElement('button');
            phaseLabelButton.type = 'button';
            phaseLabelButton.className = 'phase-label-button';
            phaseLabelButton.title = phaseName;
            phaseLabelButton.append(folderSpan, titleSpan);

            const countElement = document.createElement('span');
            countElement.className = 'phase-test-count kot-tree-count';

            const compiledIndicator = document.createElement('span');
            compiledIndicator.className = 'phase-compiled-indicator';
            compiledIndicator.setAttribute('aria-hidden', 'true');

            const phaseCountCluster = document.createElement('span');
            phaseCountCluster.className = 'phase-count-cluster';
            phaseCountCluster.append(compiledIndicator, countElement);

            const createScenarioButton = document.createElement('button');
            createScenarioButton.type = 'button';
            createScenarioButton.className = 'phase-create-main-btn toolbar-btn ghost-btn icon-only kot-icon-button';
            createScenarioButton.title = `${window.__loc?.createMainScenario || 'Create main scenario'}: ${phaseName}`;
            createScenarioButton.setAttribute('aria-label', createScenarioButton.title);
            createScenarioButton.disabled = !phaseControlsActive;
            const createScenarioIcon = document.createElement('span');
            createScenarioIcon.className = 'codicon codicon-add';
            createScenarioButton.appendChild(createScenarioIcon);

            phaseHeaderDiv.appendChild(expandCollapseButton);
            phaseHeaderDiv.appendChild(phaseCheckbox);
            phaseHeaderDiv.appendChild(phaseLabelButton);
            phaseHeaderDiv.appendChild(createScenarioButton);
            phaseHeaderDiv.appendChild(phaseCountCluster);
            // The aggregate checkbox lives in the header, so calculate its
            // checked/indeterminate state only after the controls share a DOM
            // parent. Calling this before appendChild left every group looking
            // unchecked even when all of its scenarios were selected.
            updatePhaseCountButton(countElement, phaseName, enabledCount, totalInPhase);
            updatePhaseCompiledIndicator(compiledIndicator, testsInPhase);

            const testsListDiv = document.createElement('div');
            testsListDiv.className = 'phase-tests-list';
            testsListDiv.id = testsListId;

            if (Array.isArray(testsInPhase)) {
                if (testsInPhase.length === 0) {
                    const txt = window.__loc?.noTestsInPhase || 'No tests in this group.';
                    testsListDiv.innerHTML = `<p class="no-tests-in-phase">${txt}</p>`;
                } else {
                    testsListDiv.innerHTML = testsInPhase
                        .filter(info => !!info?.name)
                        .map(info => createCheckboxHtml(info))
                        .join('');
                }
            } else {
                const txt = window.__loc?.errorLoadingTests || 'Error loading tests.';
                testsListDiv.innerHTML = `<p style="color:var(--vscode-errorForeground);">${txt}</p>`;
            }

            setPhaseListExpandedState(testsListDiv, !!phaseExpandedState[phaseName], false);

            phaseGroupDiv.appendChild(phaseHeaderDiv);
            phaseGroupDiv.appendChild(testsListDiv);
            phaseTreeContainer.appendChild(phaseGroupDiv);

            expandCollapseButton.addEventListener('click', handlePhaseHeaderClick);
            phaseLabelButton.addEventListener('click', handlePhaseHeaderClick);
            phaseCheckbox.addEventListener('change', handleTogglePhaseCheckboxesClick);
            createScenarioButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (createScenarioButton.disabled) {
                    return;
                }
                vscode.postMessage(
                    scenarioProtocol.createGroupScenarioCommand('createMainScenario', phaseName)
                );
            });
            phaseHeaderDiv.addEventListener('contextmenu', handlePhaseContextMenu);
        });
        applyCheckboxStatesToVisible();
        syncScenarioSearchHighlightState(false);
        log('Phase tree rendered.');
        updateAreAllPhasesExpandedState();
        restorePhaseTreeViewState(preservedViewState);
        for (const container of phaseTreeContainer.querySelectorAll(
            '.is-entering[data-resource-expansion-id]'
        )) {
            if (container instanceof HTMLElement) {
                animateScenarioResourceExpansion(container.dataset.resourceExpansionId || '');
            }
        }
    }

    /**
     * Обновляет интерактивный счетчик тестов в заголовке группы.
     * @param {HTMLElement} countElement
     * @param {string} phaseName
     * @param {number} enabledCount
     * @param {number} totalInPhase
     */
    function updatePhaseCountButton(countElement, phaseName, enabledCount, totalInPhase) {
        if (!(countElement instanceof HTMLElement)) {
            return;
        }

        countElement.dataset.phaseName = phaseName;
        countElement.dataset.totalCount = String(totalInPhase);
        countElement.textContent = `${enabledCount}/${totalInPhase}`;
        countElement.classList.remove('group-changed');

        const phaseCheckbox = countElement.closest('.phase-header')?.querySelector('.phase-select-checkbox');
        if (phaseCheckbox instanceof HTMLInputElement) {
            phaseCheckbox.checked = totalInPhase > 0 && enabledCount === totalInPhase;
            phaseCheckbox.indeterminate = enabledCount > 0 && enabledCount < totalInPhase;
            phaseCheckbox.disabled = !phaseControlsActive || totalInPhase === 0;
            phaseCheckbox.setAttribute(
                'aria-checked',
                phaseCheckbox.indeterminate ? 'mixed' : String(phaseCheckbox.checked)
            );
        }

    }

    function countCompiledTestsInPhase(testsInPhase) {
        if (!Array.isArray(testsInPhase)) {
            return 0;
        }
        return testsInPhase.reduce((count, testInfo) => {
            const scenarioKey = scenarioProtocol.getScenarioKey(testInfo);
            const runInfo = scenarioKey && runArtifacts && typeof runArtifacts === 'object'
                ? runArtifacts[scenarioKey]
                : null;
            return count + (runInfo && (runInfo.featurePath || runInfo.jsonPath) ? 1 : 0);
        }, 0);
    }

    function updatePhaseCompiledIndicator(compiledIndicator, testsInPhase) {
        if (!(compiledIndicator instanceof HTMLElement)) {
            return;
        }
        const compiledCount = countCompiledTestsInPhase(testsInPhase);
        const totalCount = Array.isArray(testsInPhase) ? testsInPhase.length : 0;
        compiledIndicator.hidden = compiledCount === 0;
        const titleTemplate = window.__loc?.compiledTestsInPhase || 'Compiled tests in group: {0} of {1}';
        const title = titleTemplate
            .replace('{0}', String(compiledCount))
            .replace('{1}', String(totalCount));
        compiledIndicator.title = title;
        compiledIndicator.setAttribute('aria-label', title);
    }

    function setPhaseListExpandedState(
        testsList,
        expanded,
        animate = true,
        onCollapsed = undefined,
        deferExpansion = false
    ) {
        if (!(testsList instanceof HTMLElement)) {
            return;
        }

        const previousHandler = testsList.__phaseTransitionHandler;
        if (typeof previousHandler === 'function') {
            testsList.removeEventListener('transitionend', previousHandler);
            testsList.__phaseTransitionHandler = null;
        }

        if (!animate) {
            testsList.classList.toggle('expanded', expanded);
            testsList.classList.remove('animating');
            testsList.style.maxHeight = expanded ? 'none' : '0px';
            if (!expanded && typeof onCollapsed === 'function') {
                onCollapsed();
            }
            return;
        }

        if (expanded) {
            testsList.classList.add('expanded');
            testsList.style.maxHeight = '0px';
            void testsList.offsetHeight;

            testsList.classList.add('animating');
            const onTransitionEnd = event => {
                if (event.target !== testsList || event.propertyName !== 'max-height') {
                    return;
                }
                testsList.removeEventListener('transitionend', onTransitionEnd);
                testsList.__phaseTransitionHandler = null;
                testsList.classList.remove('animating');
                testsList.style.maxHeight = 'none';
            };
            testsList.__phaseTransitionHandler = onTransitionEnd;
            testsList.addEventListener('transitionend', onTransitionEnd);
            const beginExpansion = () => {
                if (!testsList.isConnected) {
                    return;
                }
                testsList.style.maxHeight = `${testsList.scrollHeight}px`;
            };
            if (deferExpansion) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(beginExpansion);
                });
            } else {
                beginExpansion();
            }
            return;
        }

        const startHeight = testsList.scrollHeight;
        testsList.style.maxHeight = `${startHeight}px`;
        void testsList.offsetHeight;

        testsList.classList.add('animating');
        testsList.classList.remove('expanded');
        const onTransitionEnd = event => {
            if (event.target !== testsList || event.propertyName !== 'max-height') {
                return;
            }
            testsList.removeEventListener('transitionend', onTransitionEnd);
            testsList.__phaseTransitionHandler = null;
            testsList.classList.remove('animating');
            testsList.style.maxHeight = '0px';
            if (typeof onCollapsed === 'function') {
                onCollapsed();
            }
        };
        testsList.__phaseTransitionHandler = onTransitionEnd;
        testsList.addEventListener('transitionend', onTransitionEnd);
        testsList.style.maxHeight = '0px';
    }

    /**
     * Обрабатывает клик по заголовку фазы для сворачивания/разворачивания.
     * @param {Event} event - Событие клика.
     */
    function handlePhaseHeaderClick(event) {
        const button = event.currentTarget;
        if (!(button instanceof HTMLElement)) return;
        const phaseHeader = button.closest('.phase-header');
        if (!phaseHeader || !(phaseHeader instanceof HTMLElement)) return;

        const phaseName = phaseHeader.dataset.phaseName;
        if (!phaseName) return;

        const testsListId = 'tests-list-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        const testsList = document.getElementById(testsListId);
        const toggleButton = phaseHeader.querySelector('.phase-expand-collapse-btn');
        const icon = toggleButton?.querySelector('.phase-toggle-icon');

        if (!testsList || !icon || !(toggleButton instanceof HTMLButtonElement)) return;

        const nextExpanded = !phaseExpandedState[phaseName];
        phaseExpandedState[phaseName] = nextExpanded;
        setPhaseListExpandedState(testsList, nextExpanded, true);
        icon.classList.toggle('codicon-chevron-right', !nextExpanded);
        icon.classList.toggle('codicon-chevron-down', nextExpanded);
        toggleButton.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
        toggleButton.title = nextExpanded
            ? (window.__loc?.collapsePhaseTitle || 'Collapse group')
            : (window.__loc?.expandPhaseTitle || 'Expand group');
        toggleButton.setAttribute('aria-label', toggleButton.title);
        log(`Phase '${phaseName}' expanded state: ${nextExpanded}`);
        updateAreAllPhasesExpandedState();
    }

    /**
     * Обработчик клика по счетчику группы для переключения всех чекбоксов внутри фазы.
     * @param {MouseEvent} event
     */
    function handleTogglePhaseCheckboxesClick(event) {
        const button = event.currentTarget;
        if (!(button instanceof HTMLInputElement)) return;
        if (button.disabled) return;
        event.stopPropagation();

        const phaseName = button.dataset.phaseName;
        if (!phaseName) {
            log("ERROR: Phase count toggle clicked without phaseName!");
            return;
        }
        log(`Phase count toggle for phase '${phaseName}' clicked.`);

        const testsListId = 'tests-list-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        const testsList = document.getElementById(testsListId);
        if (!testsList) return;

        const visibleKeySet = new Set(currentVisibleScenarioKeys);
        const checkboxesInPhase = Array.from(
            testsList.querySelectorAll('input[type="checkbox"]:not(:disabled)')
        ).filter(checkbox => checkbox instanceof HTMLInputElement && visibleKeySet.has(checkbox.name));
        if (checkboxesInPhase.length === 0) return;

        const shouldCheckAll = button.checked;

        checkboxesInPhase.forEach(cb => {
            if (cb instanceof HTMLInputElement) {
                const testName = cb.name;
                cb.checked = shouldCheckAll;
                updateCurrentState(testName, shouldCheckAll);
            }
        });

        updatePendingStatus();
        updateSelectionControls();
        sendScenarioSelectionStates();
    }

    /**
     * Обновляет состояние и иконку кнопки "Свернуть/Развернуть все".
     */
    function updateAreAllPhasesExpandedState() {
        if (!phaseTreeContainer) return;
        const phaseHeaders = phaseTreeContainer.querySelectorAll('.phase-header');
        if (phaseHeaders.length === 0) {
            areAllPhasesCurrentlyExpanded = false;
            return;
        }

        let allExpanded = true;
        for (const header of phaseHeaders) {
            if (header instanceof HTMLElement) {
                const phaseName = header.dataset.phaseName;
                if (phaseName && !phaseExpandedState[phaseName]) {
                    allExpanded = false;
                    break;
                }
            }
        }
        areAllPhasesCurrentlyExpanded = allExpanded;
    }

    /**
     * Обрабатывает клик по кнопке "Свернуть/Развернуть все".
     */
    function handleCollapseAllClick() {
        log('Collapse/Expand All button clicked.');
        if (isBuildInProgress || settings.switcherEnabled === false) {
            return;
        }
        if (!phaseTreeContainer) return;

        const shouldExpandAll = !areAllPhasesCurrentlyExpanded;

        const phaseHeaderButtons = phaseTreeContainer.querySelectorAll('.phase-header .phase-expand-collapse-btn');
        phaseHeaderButtons.forEach(button => {
            if (button instanceof HTMLElement) {
                const phaseHeader = button.closest('.phase-header');
                if (!phaseHeader || !(phaseHeader instanceof HTMLElement)) return;

                const phaseName = phaseHeader.dataset.phaseName;
                if (!phaseName) return;

                if (phaseExpandedState[phaseName] !== shouldExpandAll) {
                    button.click();
                }
            }
        });
        updateAreAllPhasesExpandedState();
    }

    function updateSelectionControls() {
        updateSelectAllButtonState();
    }

    function getVisibleSelectableScenarioKeys() {
        return [...currentVisibleScenarioKeys];
    }

    function updateSelectAllButtonState() {
        if (!(selectAllBtn instanceof HTMLInputElement)) {
            return;
        }
        const visibleKeys = getVisibleSelectableScenarioKeys();
        const selectedKeys = Object.entries(currentCheckboxStates)
            .filter(([, selected]) => !!selected)
            .map(([key]) => key);
        const aggregate = scenarioProtocol.selectionAggregateForKeys(selectedKeys, visibleKeys);
        selectAllBtn.dataset.selectionState = aggregate;
        selectAllBtn.checked = aggregate === 'checked';
        selectAllBtn.indeterminate = aggregate === 'indeterminate';
        selectAllBtn.setAttribute('aria-checked', aggregate === 'indeterminate' ? 'mixed' : String(selectAllBtn.checked));
        const selectedTotal = visibleKeys.filter(key => !!currentCheckboxStates[key]).length;
        if (selectedCount instanceof HTMLElement) {
            selectedCount.textContent = String(selectedTotal);
        }
        if (selectableCount instanceof HTMLElement) {
            selectableCount.textContent = String(visibleKeys.length);
        }
        if (clearSelectionBtn instanceof HTMLButtonElement) {
            clearSelectionBtn.disabled = selectedTotal === 0 || !phaseControlsActive;
        }
    }

    /**
     * Обрабатывает клик по кнопке открытия файла сценария.
     * @param {Event} event - Событие клика.
     */
    function handleOpenScenarioClick(event) {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('.open-scenario-btn');
        if (!(button instanceof HTMLButtonElement)) return;

        event.preventDefault();
        event.stopPropagation();
        const name = button.getAttribute('data-name');
        if (!name) {
            log("ERROR: Open scenario button clicked without data-name attribute!");
            return;
        }
        log(`Open scenario button clicked for: ${name}`);
        const message = getScenarioCommandFromElement('openScenario', button);
        if (message) {
            vscode.postMessage(message);
        }
    }

    function handleRunScenarioClick(event) {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('.run-scenario-btn');
        if (!(button instanceof HTMLButtonElement)) return;

        event.preventDefault();
        event.stopPropagation();
        const name = button.getAttribute('data-name');
        if (!name) {
            log('ERROR: Run scenario button clicked without data-name attribute!');
            return;
        }
        const scenarioKey = button.getAttribute('data-key') || '';
        const runInfo = runArtifacts && typeof runArtifacts === 'object'
            ? runArtifacts[scenarioKey]
            : null;
        if (runInfo?.runStatus === 'running' && runInfo?.blocksControls !== false) {
            log(`Run request ignored for "${name}" because run is already in progress.`);
            return;
        }
        log(`Run scenario button clicked: ${name}`);
        const message = getScenarioCommandFromElement('runScenarioInVanessa', button);
        if (message) {
            vscode.postMessage(message);
        }
    }

    function handleRunLogClick(event) {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('.run-scenario-log-btn');
        if (!(button instanceof HTMLButtonElement)) return;

        event.preventDefault();
        event.stopPropagation();
        const name = button.getAttribute('data-name');
        if (!name) {
            log('ERROR: Run step button clicked without data-name attribute!');
            return;
        }
        log(`Run step button clicked for: ${name}`);
        const message = getScenarioCommandFromElement('openScenarioRunStepInFeature', button);
        if (message) {
            vscode.postMessage(message);
        }
    }

    function handleScenarioRowClick(event) {
        if (!(event.target instanceof Element)) return;
        const row = event.currentTarget;
        if (!(row instanceof HTMLElement)) return;

        const originatedFromInteractiveControl = !!event.target.closest('button, input, a');
        const scenarioKey = row.getAttribute('data-key') || '';
        const runInfo = runArtifacts && typeof runArtifacts === 'object'
            ? runArtifacts[scenarioKey]
            : null;
        const hasCompiledResources = !!(
            runInfo?.compiledFeatureUri
            && runInfo?.scenarioFilesRootUri
        );
        const action = scenarioFilesProtocol.scenarioDefinitionRowAction(
            hasCompiledResources,
            originatedFromInteractiveControl
        );
        if (action === 'none') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (action === 'toggle') {
            toggleScenarioResources(scenarioKey);
            return;
        }

        const name = row.getAttribute('data-name');
        if (!name) {
            return;
        }
        const runStatus = runInfo?.runStatus || 'idle';
        if (runStatus !== 'running' && runStatus !== 'failed') {
            return;
        }
        if (runStatus === 'running') {
            log(`Running scenario row clicked, opening current step in feature: ${name}`);
            const message = getScenarioCommandFromElement('openScenarioRunStepInFeature', row);
            if (message) {
                vscode.postMessage(message);
            }
            return;
        }

        log(`Failed scenario row clicked, opening scenario yaml: ${name}`);
        const message = getScenarioCommandFromElement('openScenario', row);
        if (message) {
            vscode.postMessage(message);
        }
    }

    function handleScenarioResourceToggle(event) {
        if (!(event.currentTarget instanceof HTMLButtonElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const scenarioKey = event.currentTarget.dataset.key || '';
        if (!scenarioKey) {
            return;
        }
        toggleScenarioResources(scenarioKey);
    }

    function toggleScenarioResources(scenarioKey) {
        const expanded = !expandedScenarioResources.has(scenarioKey);
        if (expanded) {
            expandedScenarioResources.add(scenarioKey);
            vscode.postMessage({
                command: 'setScenarioFilesExpanded',
                itemId: scenarioKey,
                expanded: true
            });
            renderPhaseTree(testDataByPhase);
            const resourceTree = Array.from(
                phaseTreeContainer?.querySelectorAll('.scenario-resource-tree[data-scenario-key]') || []
            ).find(element => element instanceof HTMLElement && element.dataset.scenarioKey === scenarioKey);
            if (resourceTree instanceof HTMLElement) {
                setPhaseListExpandedState(resourceTree, true, true);
            }
            return;
        }

        vscode.postMessage({
            command: 'setScenarioFilesExpanded',
            itemId: scenarioKey,
            expanded: false
        });
        const resourceTree = Array.from(
            phaseTreeContainer?.querySelectorAll('.scenario-resource-tree[data-scenario-key]') || []
        ).find(element => element instanceof HTMLElement && element.dataset.scenarioKey === scenarioKey);
        if (!(resourceTree instanceof HTMLElement)) {
            expandedScenarioResources.delete(scenarioKey);
            renderPhaseTree(testDataByPhase);
            return;
        }
        setPhaseListExpandedState(resourceTree, false, true, () => {
            expandedScenarioResources.delete(scenarioKey);
            renderPhaseTree(testDataByPhase);
        });
    }

    function handleScenarioResourceDisclosure(event) {
        if (!(event.currentTarget instanceof HTMLButtonElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const node = event.currentTarget.closest('.scenario-resource-node');
        if (!(node instanceof HTMLElement)) {
            return;
        }
        toggleScenarioResourceNode(node);
    }

    function prefersReducedMotion() {
        return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    }

    function scenarioResourceExpansionElement(expansionId) {
        return Array.from(
            phaseTreeContainer?.querySelectorAll('[data-resource-expansion-id]') || []
        ).find(element => element instanceof HTMLElement
            && element.dataset.resourceExpansionId === expansionId) || null;
    }

    function animateScenarioResourceExpansion(expansionId) {
        if (!expansionId || scheduledScenarioResourceAnimations.has(expansionId)) {
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

    function toggleScenarioResourceNode(node) {
        const key = node.dataset.resourceId || '';
        const resourceNode = scenarioFileNodesById.get(key);
        if (!key || !resourceNode) {
            return;
        }
        const transition = scenarioFilesProtocol.scenarioDirectoryExpansionTransition(
            expandedScenarioFileDirectories.has(key),
            scenarioFileChildrenByParent.has(key)
        );
        if (!transition.expanded) {
            pendingScenarioResourceAnimations.cancel(key);
            scheduledScenarioResourceAnimations.delete(key);
            const completeCollapse = () => {
                expandedScenarioFileDirectories.delete(key);
                renderPhaseTree(testDataByPhase);
            };
            if (!collapseScenarioResourceBeforeRender(key, completeCollapse)) {
                completeCollapse();
            }
            return;
        }

        expandedScenarioFileDirectories.add(key);
        if (transition.requestChildren) {
            requestScenarioFileChildren(resourceNode);
        }
        if (transition.animateImmediately) {
            pendingScenarioResourceAnimations.request(key);
        }
        renderPhaseTree(testDataByPhase);
    }

    function handleScenarioResourceRowClick(event) {
        if (!(event.currentTarget instanceof HTMLElement)) {
            return;
        }
        const node = event.currentTarget.closest('.scenario-resource-node');
        if (!(node instanceof HTMLElement)) {
            return;
        }
        const originatedFromButton = event.target instanceof Element
            && !!event.target.closest('button');
        const action = scenarioFilesProtocol.scenarioResourceRowAction(
            node.dataset.kind || '',
            originatedFromButton
        );
        if (action === 'toggle') {
            event.preventDefault();
            event.stopPropagation();
            toggleScenarioResourceNode(node);
            return;
        }
        if (action === 'open') {
            handleScenarioResourceOpen(event);
        }
    }

    function handleScenarioResourceOpen(event) {
        if (!(event.currentTarget instanceof HTMLElement)) {
            return;
        }
        if (
            event.currentTarget.classList.contains('scenario-resource-row')
            && event.target instanceof Element
            && event.target.closest('button')
        ) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const node = event.currentTarget.closest('.scenario-resource-node');
        if (!(node instanceof HTMLElement)) {
            return;
        }
        const itemId = node.dataset.itemId || '';
        if (node.dataset.kind === 'feature') {
            vscode.postMessage({
                command: 'openCompiledScenarioFeature',
                itemId
            });
            return;
        }
        vscode.postMessage({
            command: 'openScenarioFile',
            itemId,
            relativePath: node.dataset.relativePath || ''
        });
    }

    function handleScenarioResourceReveal(event) {
        if (!(event.currentTarget instanceof HTMLButtonElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const node = event.currentTarget.closest('.scenario-resource-node');
        if (!(node instanceof HTMLElement)) {
            return;
        }
        vscode.postMessage({
            command: 'revealScenarioFile',
            itemId: node.dataset.itemId || '',
            relativePath: node.dataset.relativePath || ''
        });
    }

    function handleScenarioResourceDragStart(event) {
        const nodeElement = event.currentTarget.closest('.scenario-resource-node');
        if (!(nodeElement instanceof HTMLElement)) {
            return;
        }
        scenarioFilesProtocol.setEditorDragData(event, {
            kind: nodeElement.dataset.kind,
            name: nodeElement.dataset.name || ''
        });
    }

    function handleScenarioResourceDragOver(event) {
        if (!event.dataTransfer?.types?.includes('Files')) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        event.currentTarget.classList.add('is-drop-target');
    }

    function handleScenarioResourceDragLeave(event) {
        event.currentTarget.classList.remove('is-drop-target');
    }

    function handleScenarioResourceDrop(event) {
        event.currentTarget.classList.remove('is-drop-target');
        if (!event.dataTransfer?.files?.length && !event.dataTransfer?.items?.length) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const target = event.currentTarget.closest('[data-item-id][data-relative-path]');
        if (!(target instanceof HTMLElement)) {
            return;
        }
        void scenarioFileTransferController.beginDrop(event.dataTransfer, {
            itemId: target.dataset.itemId || '',
            relativePath: target.dataset.relativePath || ''
        }).catch(error => {
            console.error('[Test Manager] Failed to prepare resource drop:', error);
        });
    }

    function closeAssembleOptionsMenu() {
        if (!(assembleSplitContainer instanceof HTMLElement)) {
            return;
        }
        assembleSplitContainer.classList.remove('show');
        resetAssembleDropdownPosition();
    }

    function closeContextMenu() {
        if (activeContextSubmenu) {
            activeContextSubmenu.remove();
            activeContextSubmenu = null;
        }
        if (!activeContextMenu) return;
        activeContextMenu.remove();
        activeContextMenu = null;
    }

    function closeContextSubmenu() {
        if (!activeContextSubmenu) {
            return;
        }
        activeContextSubmenu.remove();
        activeContextSubmenu = null;
    }

    function showContextSubmenuForItem(parentItem, actions, scopeKey = '') {
        if (!(parentItem instanceof HTMLElement) || !Array.isArray(actions) || actions.length === 0) {
            return;
        }

        closeContextSubmenu();

        const menu = document.createElement('div');
        menu.className = 'run-mode-menu phase-context-menu phase-context-submenu';
        menu.setAttribute('data-scope', scopeKey);

        actions.forEach(action => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'run-mode-menu-item';
            item.innerHTML = `<span class="codicon ${escapeHtmlAttr(action.icon || 'codicon-file-code')}"></span><span>${escapeHtmlAttr(action.label || '')}</span>`;
            if (typeof action.title === 'string' && action.title.trim()) {
                item.title = action.title;
            }
            if (action.disabled === true) {
                item.disabled = true;
                item.classList.add('run-mode-menu-item-disabled');
            }
            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (item.disabled) {
                    return;
                }
                closeContextMenu();
                action.onClick?.();
            });
            menu.appendChild(item);
        });

        document.body.appendChild(menu);

        const parentRect = parentItem.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const placeLeft = parentRect.right + menuRect.width + 8 > window.innerWidth
            && parentRect.left - menuRect.width - 4 >= 8;
        const preferredLeft = placeLeft
            ? parentRect.left - menuRect.width - 4
            : parentRect.right + 4;
        const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - menuRect.width - 8));
        const top = Math.max(8, Math.min(parentRect.top, window.innerHeight - menuRect.height - 8));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        activeContextSubmenu = menu;
    }

    function showContextMenuAt(positionX, positionY, actions, scopeKey = '') {
        if (!Array.isArray(actions) || actions.length === 0) {
            return;
        }
        closeAssembleOptionsMenu();

        if (activeContextMenu && activeContextMenu.getAttribute('data-scope') === scopeKey) {
            closeContextMenu();
            return;
        }

        closeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'run-mode-menu phase-context-menu';
        menu.setAttribute('data-scope', scopeKey);

        actions.forEach(action => {
            if (action?.separator) {
                const separator = document.createElement('div');
                separator.className = 'run-mode-menu-separator';
                separator.setAttribute('role', 'separator');
                menu.appendChild(separator);
                return;
            }
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'run-mode-menu-item';
            const hasChildren = Array.isArray(action.children) && action.children.length > 0;
            item.innerHTML = hasChildren
                ? `<span class="codicon ${escapeHtmlAttr(action.icon || 'codicon-edit')}"></span><span>${escapeHtmlAttr(action.label || '')}</span><span class="codicon codicon-chevron-right run-mode-menu-item-submenu-arrow"></span>`
                : `<span class="codicon ${escapeHtmlAttr(action.icon || 'codicon-edit')}"></span><span>${escapeHtmlAttr(action.label || '')}</span>`;
            if (typeof action.title === 'string' && action.title.trim()) {
                item.title = action.title;
            }
            if (action.disabled === true) {
                item.disabled = true;
                item.classList.add('run-mode-menu-item-disabled');
            }
            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (item.disabled) {
                    return;
                }
                if (hasChildren) {
                    showContextSubmenuForItem(item, action.children, `${scopeKey}:${action.label || 'submenu'}`);
                    return;
                }
                closeContextMenu();
                action.onClick?.();
            });
            menu.appendChild(item);
        });

        document.body.appendChild(menu);

        const menuRect = menu.getBoundingClientRect();
        const clampedLeft = Math.max(8, Math.min(positionX, window.innerWidth - menuRect.width - 8));
        const clampedTop = Math.max(8, Math.min(positionY, window.innerHeight - menuRect.height - 8));
        menu.style.left = `${clampedLeft}px`;
        menu.style.top = `${clampedTop}px`;

        activeContextMenu = menu;
    }

    function handlePhaseContextMenu(event) {
        if (!(event.currentTarget instanceof HTMLElement)) return;
        const phaseName = event.currentTarget.dataset.phaseName;
        if (!phaseName) return;

        event.preventDefault();
        event.stopPropagation();
        const actions = scenarioProtocol.createPhaseContextMenuActions(phaseName, {
            createMainScenario: window.__loc?.createMainScenario || 'Create main scenario',
            renameGroup: window.__loc?.renameGroupTitle || 'Rename group'
        }).map(action => ({
            ...action,
            onClick: () => vscode.postMessage(action.message)
        }));
        showContextMenuAt(event.clientX, event.clientY, actions, `phase:${phaseName}`);
    }

    function handleScenarioContextMenu(event) {
        if (!(event.currentTarget instanceof HTMLElement)) return;
        const scenarioRow = event.currentTarget;
        const name = scenarioRow.getAttribute('data-name');
        if (!name) return;
        const scenarioKey = scenarioRow.getAttribute('data-key') || '';
        const testInfo = getTestInfoByKey(scenarioKey);
        if (!testInfo) return;
        const postScenarioCommand = (command, extra = {}) => {
            vscode.postMessage(scenarioProtocol.createScenarioCommand(command, testInfo, extra));
        };

        event.preventDefault();
        event.stopPropagation();
        const runInfo = runArtifacts && typeof runArtifacts === 'object'
            ? runArtifacts[scenarioKey]
            : null;
        const hasRunArtifact = !!(runInfo && (runInfo.featurePath || runInfo.jsonPath));
        const hasFeatureArtifact = !!(runInfo && runInfo.featurePath);
        const hasOriginalJsonArtifact = !!(runInfo && runInfo.jsonPath);
        const hasCombinedJsonArtifact = !!(runInfo && (runInfo.combinedJsonPath || runInfo.jsonPath));
        const canOpenRunLog = !!runInfo?.canOpenRunLog;
        const isRunInProgress = runInfo?.runStatus === 'running';
        const isBlockingRunInProgress = isRunInProgress && runInfo?.blocksControls !== false;
        const runDisabled = isBuildInProgress || isBlockingRunInProgress || !hasRunArtifact;
        const runModeAutomaticLabel = window.__loc?.runScenarioModeAutomatic || 'Run test (auto close)';
        const runLabel = runModeAutomaticLabel.replace(/\s*\([^)]*\)\s*$/, '') || 'Run test';
        const runHint = window.__loc?.runScenarioModeAutomaticHint || 'Runs scenario with StartFeaturePlayer and waits for completion.';
        const runUnavailable = window.__loc?.runScenarioNoArtifacts || 'No build artifacts found. Build tests first in current session.';
        const openFeatureLabel = window.__loc?.runScenarioModeOpenFeature || 'Open feature in editor';
        const openFeatureHint = window.__loc?.runScenarioModeOpenFeatureHint || 'Opens built feature file for this scenario in editor.';
        const openFeatureUnavailable = window.__loc?.runScenarioNoFeatureArtifact || 'Feature artifact is not available for this scenario.';
        const openRunLogLabel = window.__loc?.runScenarioOpenRunLogFile || 'Open run log file';
        const openRunLogHint = window.__loc?.runScenarioOpenRunLogFileHint || 'Open run log file in editor for this scenario.';
        const openRunLogUnavailable = window.__loc?.runScenarioOpenRunLogFileUnavailable || 'Run log file path is not available for this scenario.';
        const watchLiveOutputLabel = window.__loc?.runScenarioWatchLiveOutput || 'Watch live log output';
        const watchLiveOutputHint = window.__loc?.runScenarioWatchLiveOutputHint || 'Open live run log output panel for this scenario.';
        const watchLiveOutputUnavailable = window.__loc?.runScenarioWatchLiveOutputUnavailable || 'Scenario is not running. Live log output is unavailable.';
        const openJsonMenuLabel = window.__loc?.openScenarioJsonMenuTitle || 'Open JSON';
        const openBuiltJsonLabel = window.__loc?.openScenarioBuiltJsonTitle || 'Open built JSON';
        const openBuiltJsonHint = window.__loc?.openScenarioBuiltJsonHint || 'Open original JSON artifact produced by SPPR for this scenario.';
        const openBuiltJsonUnavailable = window.__loc?.openScenarioBuiltJsonUnavailable || 'Built JSON artifact is not available for this scenario.';
        const openCombinedJsonLabel = window.__loc?.openScenarioCombinedJsonTitle || 'Open combined JSON';
        const openCombinedJsonHint = window.__loc?.openScenarioCombinedJsonHint || 'Open combined JSON artifact with Additional VA params and GlobalVars applied.';
        const openCombinedJsonUnavailable = window.__loc?.openScenarioCombinedJsonUnavailable || 'Combined JSON artifact is not available for this scenario.';

        showContextMenuAt(event.clientX, event.clientY, [
            {
                icon: 'codicon-edit',
                label: window.__loc?.openScenarioTitle || 'Open scenario',
                onClick: () => postScenarioCommand('openScenario')
            },
            {
                icon: 'codicon-settings-gear',
                label: window.__loc?.openTestSettingsTitle || 'Open test settings',
                onClick: () => postScenarioCommand('openMainScenarioTestSettings')
            },
            { separator: true },
            {
                icon: 'codicon-play-circle',
                label: runLabel,
                title: runDisabled ? runUnavailable : runHint,
                disabled: runDisabled,
                onClick: () => postScenarioCommand('runScenarioInVanessa')
            },
            {
                icon: 'codicon-go-to-file',
                label: openFeatureLabel,
                title: hasFeatureArtifact ? openFeatureHint : openFeatureUnavailable,
                disabled: !hasFeatureArtifact,
                onClick: () => postScenarioCommand('openScenarioFeatureInEditor')
            },
            {
                icon: 'codicon-file-code',
                label: openJsonMenuLabel,
                disabled: !hasOriginalJsonArtifact && !hasCombinedJsonArtifact,
                children: [
                    {
                        icon: 'codicon-file-code',
                        label: openBuiltJsonLabel,
                        title: hasOriginalJsonArtifact ? openBuiltJsonHint : openBuiltJsonUnavailable,
                        disabled: !hasOriginalJsonArtifact,
                        onClick: () => postScenarioCommand('openScenarioJsonArtifactInEditor', { variant: 'original' })
                    },
                    {
                        icon: 'codicon-file-code',
                        label: openCombinedJsonLabel,
                        title: hasCombinedJsonArtifact ? openCombinedJsonHint : openCombinedJsonUnavailable,
                        disabled: !hasCombinedJsonArtifact,
                        onClick: () => postScenarioCommand('openScenarioJsonArtifactInEditor', { variant: 'combined' })
                    }
                ]
            },
            {
                icon: 'codicon-output',
                label: openRunLogLabel,
                title: canOpenRunLog ? openRunLogHint : openRunLogUnavailable,
                disabled: !canOpenRunLog,
                onClick: () => postScenarioCommand('openRunScenarioLog')
            },
            {
                icon: 'codicon-list-flat',
                label: watchLiveOutputLabel,
                title: isRunInProgress ? watchLiveOutputHint : watchLiveOutputUnavailable,
                disabled: !isRunInProgress,
                onClick: () => postScenarioCommand('watchRunScenarioLog')
            },
            {
                separator: true
            },
            {
                icon: 'codicon-rename',
                label: window.__loc?.renameScenarioTitle || 'Rename scenario',
                onClick: () => postScenarioCommand('renameScenario')
            },
            {
                icon: 'codicon-trash',
                label: window.__loc?.deleteMainScenarioTitle || 'Delete main scenario',
                onClick: () => postScenarioCommand('deleteMainScenario')
            }
        ], `scenario:${name}`);
    }

    /**
     * Применяет текущие состояния чекбоксов к видимым элементам.
     */
    function applyCheckboxStatesToVisible() {
        log('Applying states to visible checkboxes...');
        if (!phaseTreeContainer) return;
        const checkboxes = phaseTreeContainer.querySelectorAll('.checkbox-item input[type="checkbox"]');
        const lockByRunningTests = hasScenarioRunsInProgress();
        const lockByGlobalState = !phaseControlsActive || isBuildInProgress || lockByRunningTests;
        let count = 0;
        checkboxes.forEach(cb => {
            if (!(cb instanceof HTMLInputElement)) return;
            const name = cb.getAttribute('name');
            const label = cb.closest('.checkbox-item');
            cb.removeEventListener('change', handleCheckboxChange);

            if (name && initialTestStates.hasOwnProperty(name)) {
                count++;
                const initialState = initialTestStates[name];
                const disabledByInitialState = initialState === 'disabled';
                cb.disabled = disabledByInitialState || lockByGlobalState;
                cb.checked = !!currentCheckboxStates[name];
                if(label) {
                    label.classList.toggle('disabled', cb.disabled);
                    label.classList.toggle('globally-disabled', !disabledByInitialState && lockByGlobalState);
                    label.classList.remove('changed');
                }
                if (!cb.disabled) {
                    cb.addEventListener('change', handleCheckboxChange);
                }
            } else if (name) {
                cb.disabled = true;
                if(label) {
                    label.classList.add('disabled');
                    label.classList.remove('globally-disabled');
                }
            } else {
                log("ERROR: Checkbox found with NO NAME attribute!");
            }
        });

        const scenarioLabels = phaseTreeContainer.querySelectorAll('.checkbox-item[data-key]');
        scenarioLabels.forEach(label => {
            if (!(label instanceof HTMLElement)) return;
            label.removeEventListener('contextmenu', handleScenarioContextMenu);
            label.addEventListener('contextmenu', handleScenarioContextMenu);
            label.removeEventListener('click', handleScenarioRowClick);
            label.addEventListener('click', handleScenarioRowClick);
        });

        const openButtons = phaseTreeContainer.querySelectorAll('.open-scenario-btn');
        openButtons.forEach(btn => {
            btn.removeEventListener('click', handleOpenScenarioClick);
            btn.addEventListener('click', handleOpenScenarioClick);
        });

        phaseTreeContainer.querySelectorAll('.scenario-resource-toggle').forEach(button => {
            button.addEventListener('click', handleScenarioResourceToggle);
        });
        phaseTreeContainer.querySelectorAll('.scenario-resource-disclosure').forEach(button => {
            button.addEventListener('click', handleScenarioResourceDisclosure);
        });
        phaseTreeContainer.querySelectorAll('.scenario-resource-file-icon').forEach(button => {
            button.addEventListener('click', handleScenarioResourceOpen);
        });
        phaseTreeContainer.querySelectorAll('.scenario-resource-reveal-btn').forEach(button => {
            button.addEventListener('click', handleScenarioResourceReveal);
        });
        phaseTreeContainer.querySelectorAll('.scenario-resource-node[data-kind="file"] .scenario-resource-row').forEach(row => {
            row.addEventListener('dragstart', handleScenarioResourceDragStart);
        });
        phaseTreeContainer.querySelectorAll('.scenario-resource-node > .scenario-resource-row').forEach(row => {
            row.addEventListener('click', handleScenarioResourceRowClick);
        });
        phaseTreeContainer.querySelectorAll('.scenario-resource-drop-target').forEach(target => {
            target.addEventListener('dragover', handleScenarioResourceDragOver);
            target.addEventListener('dragleave', handleScenarioResourceDragLeave);
            target.addEventListener('drop', handleScenarioResourceDrop);
        });

        const runButtons = phaseTreeContainer.querySelectorAll('.run-scenario-btn');
        runButtons.forEach(btn => {
            if (!(btn instanceof HTMLButtonElement)) return;
            const scenarioKey = btn.getAttribute('data-key') || '';
            const runInfo = runArtifacts ? runArtifacts[scenarioKey] : null;
            const hasRunArtifact = !!(runInfo && (runInfo.featurePath || runInfo.jsonPath));
            const isBlockingRunInProgress = runInfo?.runStatus === 'running' && runInfo?.blocksControls !== false;
            btn.disabled = isBuildInProgress || isBlockingRunInProgress || !hasRunArtifact;
            btn.removeEventListener('click', handleRunScenarioClick);
            btn.addEventListener('click', handleRunScenarioClick);
        });

        const runLogButtons = phaseTreeContainer.querySelectorAll('.run-scenario-log-btn');
        runLogButtons.forEach(btn => {
            btn.removeEventListener('click', handleRunLogClick);
            btn.addEventListener('click', handleRunLogClick);
        });

        log(`Applied states to ${count} visible checkboxes.`);
        updateSelectionControls();
        applyAffectedMainScenarioHighlighting();
        updateAreAllPhasesExpandedState();
        updateScenarioLabelOverflow();
    }

    /**
     * Обновляет текущее состояние чекбокса в `currentCheckboxStates`.
     * @param {string} name - Имя теста.
     * @param {boolean} isChecked - Новое состояние чекбокса.
     */
    function updateCurrentState(name, isChecked) {
        if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') {
            currentCheckboxStates[name] = !!isChecked;
        }
    }

    /**
     * Обрабатывает изменение состояния чекбокса.
     * @param {Event} event - Событие изменения.
     */
    function handleCheckboxChange(event) {
        if(!(event.target instanceof HTMLInputElement)) return;
        const name = event.target.name;
        const isChecked = event.target.checked;
        log(`Checkbox changed: ${name} = ${isChecked}`);
        updateCurrentState(name, isChecked);
        updatePendingStatus();
        updateSelectionControls();
        sendScenarioSelectionStates();
    }

    /**
     * Обновляет счетчики тестов для каждой фазы, включая индикацию изменений.
     */
    function updatePhaseCounts() {
        if (!phaseTreeContainer) return;
        const states = visibilitySelectionStates();
        const phaseHeaders = phaseTreeContainer.querySelectorAll('.phase-header');
        phaseHeaders.forEach(header => {
            if (!(header instanceof HTMLElement)) return;
            const phaseName = header.dataset.phaseName;
            if (!phaseName || !testDataByPhase[phaseName]) return;

            const testsInPhase = testDataByPhase[phaseName];
            const phaseAggregate = phaseVisibilityAggregate(phaseName, states);
            const countElement = header.querySelector('.phase-test-count');
            if (countElement instanceof HTMLElement) {
                updatePhaseCountButton(
                    countElement,
                    phaseName,
                    phaseAggregate.selectedCount,
                    phaseAggregate.totalCount
                );
            }
            const compiledIndicator = header.querySelector('.phase-compiled-indicator');
            const phaseVisibleKeys = new Set(phaseAggregate.visibleKeys);
            updatePhaseCompiledIndicator(
                compiledIndicator,
                Array.isArray(testsInPhase)
                    ? testsInPhase.filter(testInfo =>
                        phaseVisibleKeys.has(scenarioProtocol.getScenarioKey(testInfo))
                    )
                    : []
            );
        });
    }

    function sendScenarioSelectionStates() {
        const statesToSend = {};
        for (const [name, stateValue] of Object.entries(currentCheckboxStates)) {
            if (!initialTestStates.hasOwnProperty(name) || initialTestStates[name] === 'disabled') {
                continue;
            }
            statesToSend[name] = !!stateValue;
        }
        vscode.postMessage({ command: 'updateScenarioSelectionStates', data: statesToSend });
    }


    /**
     * Обновляет статус-бар краткой информацией о текущем выборе сценариев.
     */
    function updatePendingStatus() {
        renderMainStatusBar();

        updateSelectionControls();
        updatePhaseCounts();
        updateAreAllPhasesExpandedState();
    }

    function buildDemoRunArtifact(name, stateKey) {
        const fp = '/demo/' + name.replace(/[^a-zA-Z0-9]/g, '_') + '.feature';
        const jp = '/demo/' + name.replace(/[^a-zA-Z0-9]/g, '_') + '.json';
        switch (stateKey) {
            case 'passed':         return { runStatus: 'passed', featurePath: fp, jsonPath: jp, stale: false, hasRunLog: true,  canOpenRunLog: true,  canWatchLiveLog: false, canSwitchTrackedRun: false };
            case 'passed-stale':   return { runStatus: 'passed', featurePath: fp, jsonPath: jp, stale: true,  hasRunLog: true,  canOpenRunLog: true,  canWatchLiveLog: false, canSwitchTrackedRun: false };
            case 'failed':         return { runStatus: 'failed', featurePath: fp, jsonPath: jp, stale: false, runMessage: 'Assertion failed at step 5', hasRunLog: true, canOpenRunLog: true, canWatchLiveLog: false, canSwitchTrackedRun: false };
            case 'running-internal': return { runStatus: 'running', featurePath: fp, jsonPath: jp, stale: false, progressCurrentLine: 496, progressTotalLines: 9672, progressPercent: 26, blocksControls: true,  hasRunLog: false, canOpenRunLog: false, canWatchLiveLog: true, canSwitchTrackedRun: false };
            case 'running-tracked':  return { runStatus: 'running', featurePath: fp, jsonPath: jp, stale: false, activeRunSource: 'tracked', blocksControls: false, hasRunLog: false, canOpenRunLog: false, canWatchLiveLog: true, canSwitchTrackedRun: false };
            case 'idle-ready':     return { runStatus: 'idle',   featurePath: fp, jsonPath: jp, stale: false, hasRunLog: false, canOpenRunLog: false, canWatchLiveLog: false, canSwitchTrackedRun: false };
            case 'idle-no-button': return { runStatus: 'idle',   featurePath: undefined, jsonPath: undefined, stale: false, hasRunLog: false, canOpenRunLog: false, canWatchLiveLog: false, canSwitchTrackedRun: false };
            default: return null;
        }
    }

    // Обработчик сообщений от расширения
    window.addEventListener('message', event => {
        const message = event.data;
        log('Received message command: ' + message?.command);

        if (
            message?.command !== 'scenarioFileTransferFailed'
            && scenarioFileTransferController.handleMessage(message)
        ) {
            return;
        }

        switch (message?.command) {
            case 'scenarioFileChildren': {
                const parentKey = typeof message.requestId === 'string'
                    ? message.requestId
                    : '';
                if (!scenarioProtocol.isCurrentScenarioFileResponse(
                    pendingScenarioFileRequests.get(parentKey),
                    message.requestId
                )) {
                    break;
                }
                const animateLoadedChildren = expandedScenarioFileDirectories.has(parentKey);
                pendingScenarioFileRequests.delete(parentKey);
                const parentDepth = Number(scenarioFileNodesById.get(parentKey)?.depth) || 1;
                scenarioFileChildrenByParent.set(
                    parentKey,
                    scenarioFilesProtocol.projectDirectChildren(parentDepth, message.nodes)
                );
                if (animateLoadedChildren) {
                    pendingScenarioResourceAnimations.request(parentKey);
                }
                renderPhaseTree(testDataByPhase);
                break;
            }
            case 'scenarioFileInvalidated': {
                clearScenarioFileCache(message.itemId || '');
                renderPhaseTree(testDataByPhase);
                break;
            }
            case 'scenarioFileTransferFailed': {
                if (message.requestId) {
                    const key = message.requestId;
                    if (pendingScenarioFileRequests.get(key) === message.requestId) {
                        pendingScenarioFileRequests.delete(key);
                        scenarioFileChildrenByParent.set(key, []);
                    }
                    renderPhaseTree(testDataByPhase);
                } else {
                    scenarioFileTransferController.handleMessage(message);
                }
                console.error('[Test Manager] Scenario resource action failed:', message.message);
                break;
            }
            case 'scenarioFileActionResult':
                if (message.succeeded === false) {
                    console.error(window.__loc?.resourceActionFailed || 'The resource action could not be completed.');
                }
                break;
            case 'toggleAllGroups':
                handleCollapseAllClick();
                break;
            case 'loadInitialState':
                if (message.error) {
                     closeAssembleOptionsMenu();
                     closeContextMenu();
                     applyYamlParametersProfilesState(undefined);
                     runArtifacts = {};
                     const errorTemplate = window.__loc?.errorWithDetails || 'Error: {0}';
                     updateStatus(errorTemplate.replace('{0}', message.error), 'main');
                      phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = 'none'; });
                     enablePhaseControls(false); enableAssembleControls(false);
                } else {
                    closeAssembleOptionsMenu();
                    closeContextMenu();
                    testDataByPhase = message.tabData || {};
                    initialTestStates = message.states || {};
                    runArtifacts = message.runArtifacts || {};
                    relationshipState = scenarioProtocol.parseRelationshipState(message.relationshipState);
                    applyYamlParametersProfilesState(message.yamlParametersProfiles);
                    rebuildTestInfoIndex();
                    settings = message.settings || {
                        assemblerEnabled: true,
                        switcherEnabled: true,
                        driveFeaturesEnabled: false,
                        highlightAffectedMainScenarios: true,
                        filterRelatedScenarios: false,
                        statusFilter: 'all'
                    };
                    isScenarioRepairInProgress = !!settings.scenarioRepairInProgress;
                    isScenarioRepairCancelling = !!settings.scenarioRepairCancelling;
                    if (typeof settings.highlightAffectedMainScenarios !== 'boolean') {
                        settings.highlightAffectedMainScenarios = true;
                    }
                    settings.highlightAffectedMainScenarios = relationshipState.enabled;
                    settings.filterRelatedScenarios = settings.filterRelatedScenarios === true;
                    statusFilter = scenarioProtocol.normalizeStatusFilter(settings.statusFilter);
                    settings.statusFilter = statusFilter;
                    isBuildInProgress = !!settings.buildInProgress;
                    log("Received settings in webview:");
                    console.log(settings);

                    currentCheckboxStates = {};
                    if (Object.keys(phaseExpandedState).length === 0 && testDataByPhase) {
                        Object.keys(testDataByPhase).forEach(phaseName => {
                            phaseExpandedState[phaseName] = false;
                        });
                    }

                    Object.keys(testDataByPhase).forEach(phaseName => {
                        if (Array.isArray(testDataByPhase[phaseName])) {
                            testDataByPhase[phaseName].forEach(info => {
                                const scenarioKey = scenarioProtocol.getScenarioKey(info);
                                if (scenarioKey && initialTestStates.hasOwnProperty(scenarioKey)) {
                                    if (initialTestStates[scenarioKey] !== 'disabled') {
                                        currentCheckboxStates[scenarioKey] = initialTestStates[scenarioKey] === 'checked';
                                    }
                                }
                            });
                        }
                    });

                    log("State caches initialized.");

                    const phaseSwitcherVisible = settings.switcherEnabled;
                    const assemblerVisible = settings.assemblerEnabled;
                    const driveFeaturesVisible = settings.driveFeaturesEnabled !== false;
                    const managerSectionVisible = phaseSwitcherVisible || assemblerVisible;
                    log(`Applying visibility based on settings: Switcher=${phaseSwitcherVisible}, Assembler=${assemblerVisible}, DriveFeatures=${driveFeaturesVisible}`);

                    const managerDisplay = managerSectionVisible ? '' : 'none';
                    phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = managerDisplay; });
                    
                    if (driveAccountingModeRow instanceof HTMLElement) {
                        driveAccountingModeRow.style.display = driveFeaturesVisible ? 'flex' : 'none';
                        log(`  Drive accounting mode display set to: ${driveAccountingModeRow.style.display}`);
                    }
                    if (recordGLSelect instanceof HTMLSelectElement) {
                        recordGLSelect.classList.toggle('hidden', !driveFeaturesVisible);
                    }
                    if (assembleMenuBtn instanceof HTMLButtonElement) {
                        assembleMenuBtn.style.display = assemblerVisible ? 'inline-flex' : 'none';
                    }

                    if (phaseSwitcherVisible) {
                        renderPhaseTree(testDataByPhase);
                    } else {
                        if (phaseTreeContainer instanceof HTMLElement) {
                            phaseTreeContainer.innerHTML = `<p>${window.__loc?.phaseSwitcherDisabled || 'Test Manager is disabled in settings.'}</p>`;
                        }
                    }

                    updatePendingStatus();
                    enablePhaseControls(phaseSwitcherVisible && !!testDataByPhase && Object.keys(testDataByPhase).length > 0);
                    enableAssembleControls(assemblerVisible);

                    if (isBuildInProgress) {
                        const buildMessage = window.__loc?.statusBuildingInProgress || 'Building tests in progress...';
                        updateStatus(buildMessage, 'main');
                        enablePhaseControls(false);
                        enableAssembleControls(false);
                    } else {
                        updateStatus('', 'main');
                    }
                    updateTopRunButtonState();
                }
                break;

            case 'updateRunArtifactsState':
                isDemoMode = false;
                {
                    const nextRunArtifacts = message.runArtifacts || {};
                    const changedResourceKeys = scenarioProtocol.changedCompiledResourceKeys(
                        runArtifacts,
                        nextRunArtifacts
                    );
                    const resourcesChanged = changedResourceKeys.length > 0;
                    for (const scenarioKey of changedResourceKeys) {
                        clearScenarioFileCache(scenarioKey);
                        if (!nextRunArtifacts[scenarioKey]?.compiledFeatureUri) {
                            expandedScenarioResources.delete(scenarioKey);
                        }
                    }
                    runArtifacts = nextRunArtifacts;
                    updateTopRunButtonState();
                    updatePhaseCounts();
                    if (settings.switcherEnabled && testDataByPhase && Object.keys(testDataByPhase).length > 0) {
                        if (resourcesChanged) {
                            renderPhaseTree(testDataByPhase);
                        } else {
                            updateVisibleScenarioRunState();
                        }
                        updatePendingStatus();
                    } else {
                        updateRunButtonsState();
                    }
                }
                {
                    const mainControlsShouldBeActive = settings.switcherEnabled
                        && !!testDataByPhase
                        && Object.keys(testDataByPhase).length > 0;
                    enablePhaseControls(mainControlsShouldBeActive);
                    enableAssembleControls(settings.assemblerEnabled);
                }
                applyAffectedMainScenarioHighlighting();
                applyScenarioVisibility();
                break;

            case 'enableDemoMode': {
                isDemoMode = true;
                // Группа 0: результаты прогонов — passed×2, stale, failed, ready, no-button
                const patternA = ['passed-stale', 'running-tracked', 'running-internal', 'idle-ready', 'idle-no-button'];
                // Группа 1: активные прогоны — stale, running+button, running−button, ready, no-button
                const patternB = ['passed', 'passed', 'passed-stale', 'failed', 'idle-ready', 'idle-no-button'];
                // Остальные группы: все 7 состояний по кругу
                const patternC = ['passed', 'passed-stale', 'failed', 'running-tracked', 'running-internal', 'idle-ready', 'idle-no-button'];

                const demoOverlay = {};
                const groupNames = Object.keys(testDataByPhase).sort();
                groupNames.forEach((groupName, groupIdx) => {
                    const scenarios = testDataByPhase[groupName];
                    if (!Array.isArray(scenarios)) { return; }
                    const pattern = groupIdx === 0 ? patternA : groupIdx === 1 ? patternB : patternC;
                    scenarios.forEach((info, i) => {
                        const name = info?.name;
                        const scenarioKey = scenarioProtocol.getScenarioKey(info);
                        if (!name || !scenarioKey) { return; }
                        const stateKey = i < pattern.length ? pattern[i] : 'idle-no-button';
                        demoOverlay[scenarioKey] = buildDemoRunArtifact(name, stateKey);
                    });
                });

                runArtifacts = Object.assign({}, runArtifacts, demoOverlay);
                updateTopRunButtonState();
                if (settings.switcherEnabled && testDataByPhase && Object.keys(testDataByPhase).length > 0) {
                    updateVisibleScenarioRunState();
                    updatePendingStatus();
                } else {
                    updateRunButtonsState();
                }
                applyAffectedMainScenarioHighlighting();
                applyScenarioVisibility();
                break;
            }

            case 'setDemoState': {
                isDemoMode = true;
                const scenarioKey = message.key;
                const name = message.name;
                const stateKey = message.stateKey;
                if (!scenarioKey || !name || !stateKey) { break; }
                const artifact = buildDemoRunArtifact(name, stateKey);
                if (!artifact) { break; }
                runArtifacts = Object.assign({}, runArtifacts, { [scenarioKey]: artifact });
                updateTopRunButtonState();
                if (settings.switcherEnabled && testDataByPhase && Object.keys(testDataByPhase).length > 0) {
                    updateVisibleScenarioRunState();
                    updatePendingStatus();
                } else {
                    updateRunButtonsState();
                }
                applyAffectedMainScenarioHighlighting();
                applyScenarioVisibility();
                break;
            }

            case 'updateRelationshipState':
                relationshipState = scenarioProtocol.parseRelationshipState(message);
                settings.highlightAffectedMainScenarios = relationshipState.enabled;
                settings.filterRelatedScenarios = message.filterRelatedScenarios === true;
                applyAffectedMainScenarioHighlighting();
                applyScenarioVisibility();
                break;

            case 'updateStatusFilter':
                statusFilter = scenarioProtocol.normalizeStatusFilter(message.statusFilter);
                settings.statusFilter = statusFilter;
                applyScenarioVisibility();
                break;

             case 'updateStatus':
                 const target = message.target || 'main';
                 const controlsEnabled = message.enableControls === undefined ? undefined : message.enableControls;
                 updateStatus(message.text, target);

                 if (controlsEnabled !== undefined) {
                     const shouldEnablePhaseControls = controlsEnabled && settings.switcherEnabled;
                     enablePhaseControls(shouldEnablePhaseControls);
                     enableAssembleControls(controlsEnabled && settings.assemblerEnabled);
                 }
                 break;

            case 'buildStateChanged': {
                isBuildInProgress = !!message.inProgress;
                if (isBuildInProgress) {
                    closeAssembleOptionsMenu();
                    closeContextMenu();
                    const buildMessage = window.__loc?.statusBuildingInProgress || 'Building tests in progress...';
                    updateStatus(buildMessage, 'main');
                    enablePhaseControls(false);
                    enableAssembleControls(false);
                } else {
                    // Clear transient build status so selection summary can be shown again.
                    mainStatusText = '';
                    const mainControlsShouldBeActive = settings.switcherEnabled && !!testDataByPhase && Object.keys(testDataByPhase).length > 0;
                    enablePhaseControls(mainControlsShouldBeActive);
                    enableAssembleControls(settings.assemblerEnabled);
                    updatePendingStatus();
                }
                updateTopRunButtonState();
                break;
            }

            case 'scenarioRepairStateChanged': {
                isScenarioRepairInProgress = !!message.inProgress;
                if (typeof message.cancelling === 'boolean') {
                    isScenarioRepairCancelling = message.cancelling;
                } else if (!isScenarioRepairInProgress) {
                    isScenarioRepairCancelling = false;
                }

                if (isScenarioRepairInProgress && isScenarioRepairCancelling) {
                    updateStatus(
                        window.__loc?.statusCancellingScenarioRepair || 'Cancelling scenario repair...',
                        'main'
                    );
                }

                if (!isScenarioRepairInProgress) {
                    if (!isBuildInProgress) {
                        mainStatusText = '';
                        const mainControlsShouldBeActive = settings.switcherEnabled
                            && !!testDataByPhase
                            && Object.keys(testDataByPhase).length > 0;
                        enablePhaseControls(mainControlsShouldBeActive);
                        updatePendingStatus();
                    }
                }
                break;
            }

            default:
                log(`Received unknown command: ${message?.command}`);
                break;
         }
    });

    if(selectAllBtn instanceof HTMLInputElement) selectAllBtn.addEventListener('change', () => {
        log('Toggle visible scenarios clicked.');
        const visibleKeys = getVisibleSelectableScenarioKeys();
        if (visibleKeys.length === 0) return;
        const selectedKeys = Object.entries(currentCheckboxStates)
            .filter(([, selected]) => !!selected)
            .map(([key]) => key);
        const nextSelectedKeys = new Set(scenarioProtocol.nextVisibleSelection(
            selectedKeys,
            visibleKeys,
            'toggle'
        ));
        visibleKeys.forEach(key => {
            currentCheckboxStates[key] = nextSelectedKeys.has(key);
        });
        applyCheckboxStatesToVisible();
        updatePendingStatus();
        sendScenarioSelectionStates();
    });

    if (clearSelectionBtn instanceof HTMLButtonElement) clearSelectionBtn.addEventListener('click', () => {
        for (const key of Object.keys(currentCheckboxStates)) {
            if (initialTestStates[key] !== 'disabled') {
                currentCheckboxStates[key] = false;
            }
        }
        applyCheckboxStatesToVisible();
        updatePendingStatus();
        sendScenarioSelectionStates();
    });

    if (scenarioSearchInput instanceof HTMLInputElement) {
        scenarioSearchInput.addEventListener('input', () => {
            syncScenarioSearchHighlightState(true);
        });
        scenarioSearchInput.addEventListener('focus', () => {
            syncScenarioSearchHighlightState(false);
        });
        scenarioSearchInput.addEventListener('blur', () => {
            setTimeout(() => {
                syncScenarioSearchHighlightState(false);
            }, 0);
        });
        scenarioSearchInput.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                clearScenarioSearch(true);
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                syncScenarioSearchHighlightState(true);
            }
        });
    }

    if (scenarioSearchClearBtn instanceof HTMLButtonElement) {
        scenarioSearchClearBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            clearScenarioSearch(true);
            if (scenarioSearchInput instanceof HTMLInputElement) {
                scenarioSearchInput.focus();
            }
        });
    }

    if (phaseTreeContainer) {
        const refreshHoveredScenarioOverflow = event => {
            const row = event.target instanceof Element ? event.target.closest('.kot-tree-row') : null;
            requestAnimationFrame(() => {
                for (const label of row?.querySelectorAll('.kot-tree-label') || []) {
                    updateScenarioLabelOverflowFor(label);
                }
            });
        };
        phaseTreeContainer.addEventListener('mouseover', refreshHoveredScenarioOverflow);
        phaseTreeContainer.addEventListener('mouseout', refreshHoveredScenarioOverflow);
    }

    if (openVanessaBtn instanceof HTMLButtonElement) {
        openVanessaBtn.addEventListener('click', () => {
            if (!openVanessaBtn.disabled) {
                vscode.postMessage({ command: 'openVanessa' });
            }
        });
    }

    function resetAssembleDropdownPosition() {
        if (!(assembleDropdownContent instanceof HTMLElement)) {
            return;
        }
        assembleDropdownContent.style.left = '';
        assembleDropdownContent.style.right = '';
        assembleDropdownContent.style.top = '';
        assembleDropdownContent.style.bottom = '';
        assembleDropdownContent.style.maxHeight = '';
    }

    function positionAssembleDropdownWithinViewport() {
        if (!(assembleSplitContainer instanceof HTMLElement) || !(assembleDropdownContent instanceof HTMLElement)) {
            return;
        }
        if (!assembleSplitContainer.classList.contains('show')) {
            return;
        }

        const viewportPadding = 8;
        const anchorRect = assembleSplitContainer.getBoundingClientRect();

        // Default placement: below, right-aligned to split button.
        assembleDropdownContent.style.left = 'auto';
        assembleDropdownContent.style.right = '0px';
        assembleDropdownContent.style.top = 'calc(100% + 2px)';
        assembleDropdownContent.style.bottom = 'auto';
        assembleDropdownContent.style.maxHeight = '';

        let rect = assembleDropdownContent.getBoundingClientRect();

        // If there is not enough space below, place above.
        if (rect.bottom > window.innerHeight - viewportPadding) {
            assembleDropdownContent.style.top = 'auto';
            assembleDropdownContent.style.bottom = 'calc(100% + 2px)';
            rect = assembleDropdownContent.getBoundingClientRect();
        }

        const openedAbove = assembleDropdownContent.style.bottom !== 'auto';
        const availableSpace = openedAbove
            ? Math.max(120, Math.floor(anchorRect.top - viewportPadding))
            : Math.max(120, Math.floor(window.innerHeight - anchorRect.bottom - viewportPadding));

        if (rect.height > availableSpace) {
            assembleDropdownContent.style.maxHeight = `${availableSpace}px`;
            rect = assembleDropdownContent.getBoundingClientRect();
        }

        // Horizontal clamp.
        if (rect.right > window.innerWidth - viewportPadding) {
            const overflowRight = rect.right - (window.innerWidth - viewportPadding);
            assembleDropdownContent.style.right = `${overflowRight}px`;
            rect = assembleDropdownContent.getBoundingClientRect();
        }
        if (rect.left < viewportPadding) {
            const leftOffset = viewportPadding - anchorRect.left;
            assembleDropdownContent.style.right = 'auto';
            assembleDropdownContent.style.left = `${leftOffset}px`;
        }
    }

    if (openYamlParametersQuickBtn) {
        openYamlParametersQuickBtn.addEventListener('click', event => {
            event.preventDefault();
            vscode.postMessage({ command: 'openYamlParametersManager' });
        });
    }

    if (assembleMenuBtn && assembleSplitContainer) {
        assembleMenuBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (assembleMenuBtn instanceof HTMLButtonElement && assembleMenuBtn.disabled) {
                return;
            }
            closeContextMenu();
            const shouldShow = !assembleSplitContainer.classList.contains('show');
            if (!shouldShow) {
                closeAssembleOptionsMenu();
                return;
            }
            assembleSplitContainer.classList.add('show');
            requestAnimationFrame(() => positionAssembleDropdownWithinViewport());
        });
    }

    if (recordGLSelect instanceof HTMLSelectElement) {
        updateRecordGLSelection(recordGLSelect.value || '2');
        recordGLSelect.addEventListener('change', () => {
            if (recordGLSelect.disabled) {
                return;
            }
            updateRecordGLSelection(recordGLSelect.value);
        });
    }

    if (yamlProfileSelect instanceof HTMLSelectElement) {
        yamlProfileSelect.addEventListener('change', () => {
            const nextProfileId = typeof yamlProfileSelect.value === 'string'
                ? yamlProfileSelect.value.trim()
                : '';
            if (!nextProfileId || nextProfileId === activeYamlParameterProfileId || yamlProfileSelect.disabled) {
                return;
            }

            activeYamlParameterProfileId = nextProfileId;
            yamlProfileSelect.disabled = true;
            log(`Switching active build profile to: ${nextProfileId}`);
            vscode.postMessage({ command: 'setYamlParametersProfile', profileId: nextProfileId });
        });
    }

    // Закрытие выпадающего списка при клике вне его
    window.addEventListener('click', (event) => {
        if (assembleSplitContainer && !assembleSplitContainer.contains(event.target)) {
            closeAssembleOptionsMenu();
        }
        if (
            activeContextMenu
            && event.target instanceof Node
            && !activeContextMenu.contains(event.target)
            && !(activeContextSubmenu && activeContextSubmenu.contains(event.target))
        ) {
            closeContextMenu();
        }
    });

    window.addEventListener('resize', () => {
        positionAssembleDropdownWithinViewport();
        updateAssembleMainButtonLayout();
        updateScenarioLabelOverflow();
    });


    if(assembleBtn instanceof HTMLButtonElement) {
        assembleBtn.addEventListener('click', () => {
            log('Assemble tests button clicked.');
            closeAssembleOptionsMenu();
            const recordGLValue = normalizeRecordGLValue(currentRecordGLValue);
            isBuildInProgress = true;
            updateStatus(window.__loc?.statusStartingAssembly || 'Starting assembly...', 'main');
            enablePhaseControls(false);
            enableAssembleControls(false);
            vscode.postMessage({
                command: 'runAssembleScript',
                params: { recordGL: recordGLValue }
            });
        });
    }

    if (cancelAssembleBtn instanceof HTMLButtonElement) {
        cancelAssembleBtn.addEventListener('click', () => {
            if (cancelAssembleBtn.disabled) {
                return;
            }
            log('Cancel build button clicked.');
            updateStatus(window.__loc?.statusCancellingBuild || 'Cancelling build...', 'main');
            vscode.postMessage({ command: 'cancelAssembleScript' });
        });
    }

    function requestInitialState() {
        log('Requesting initial state...');
        updateStatus(window.__loc?.statusRequestingData || 'Requesting data...', 'main');
        enablePhaseControls(false);
        enableAssembleControls(false);
        vscode.postMessage({ command: 'getInitialState' });
    }

    log('Webview script initialized.');
    syncTooltipDataAttributes(document);
    updateScenarioSearchClearButtonState();
    updateStatus(window.__loc?.statusLoadingShort || 'Loading...', 'main');
    enablePhaseControls(false);
    enableAssembleControls(false);
    requestInitialState();

}());
