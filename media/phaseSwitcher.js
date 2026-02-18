// Файл: media/phaseSwitcher.js
// Скрипт для управления интерфейсом Webview панели KOT for 1C

(function() {
    const vscode = acquireVsCodeApi();

    // === Глобальные переменные состояния ===
    let testDataByPhase = {};
    let initialTestStates = {};
    let currentCheckboxStates = {};
    let testDefaultStates = {};
    let phaseExpandedState = {}; 
    let runArtifacts = {};
    let affectedMainScenarioNames = new Set();
    let favoriteScenarios = [];
    let favoriteSortMode = 'code';
    let activeManagerTab = 'tests';
    let activeScenarioSearchQuery = '';
    let isScenarioSearchVisible = false;
    let settings = {
        assemblerEnabled: true,
        switcherEnabled: true,
        driveFeaturesEnabled: false,
        highlightAffectedMainScenarios: true
    };
    let isBuildInProgress = false;
    let phaseControlsActive = false;
    let areAllPhasesCurrentlyExpanded = false; 
    let activeRunModeMenu = null;
    let activeContextMenu = null;
    const FAVORITE_SCENARIO_DROP_MIME = 'application/x-kot-favorite-scenario-uri';

    // === Получение ссылок на элементы DOM ===
    const refreshBtn = document.getElementById('refreshBtn');
    const runVanessaTopBtn = document.getElementById('runVanessaTopBtn');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const collapseAllBtn = document.getElementById('collapseAllBtn');
    const assembleSplitContainer = document.getElementById('assembleSplitContainer');
    const assembleMenuBtn = document.getElementById('assembleMenuBtn');
    const assembleDropdownContent = document.getElementById('assembleDropdownContent');
    const createFirstLaunchBtn = document.getElementById('createFirstLaunchBtn');

    // Новые элементы для выпадающего меню
    const addScenarioDropdownBtn = document.getElementById('addScenarioDropdownBtn');
    const addScenarioDropdownContent = document.getElementById('addScenarioDropdownContent');
    const createMainScenarioFromDropdownBtn = document.getElementById('createMainScenarioFromDropdownBtn');
    const createNestedScenarioFromDropdownBtn = document.getElementById('createNestedScenarioFromDropdownBtn');
    const testsTabBtn = document.getElementById('testsTabBtn');
    const favoritesTabBtn = document.getElementById('favoritesTabBtn');
    const globalListActions = document.getElementById('globalListActions');
    const toggleScenarioSearchBtn = document.getElementById('toggleScenarioSearchBtn');
    const favoritesSortControls = document.getElementById('favoritesSortControls');
    const favoritesSortSelect = document.getElementById('favoritesSortSelect');
    const scenarioSearchRow = document.getElementById('scenarioSearchRow');
    const scenarioSearchInput = document.getElementById('scenarioSearchInput');
    const scenarioSearchClearBtn = document.getElementById('scenarioSearchClearBtn');

    const phaseSwitcherSectionElements = document.querySelectorAll('.phase-switcher-section');
    const phaseTreeContainer = document.getElementById('phaseTreeContainer');
    const favoritesContainer = document.getElementById('favoritesContainer');

    const selectionSummaryBar = document.getElementById('selectionSummaryBar');
    const statusBar = document.getElementById('statusBar');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const selectDefaultsBtn = document.getElementById('selectDefaultsBtn');

    const driveAccountingModeRow = document.getElementById('driveAccountingModeRow');
    const recordGLModeList = document.getElementById('recordGLModeList');
    const recordGLOptionButtons = Array.from(document.querySelectorAll('.record-gl-option-btn'));
    const driveActionsRow = document.getElementById('driveActionsRow');

    const assembleBtn = document.getElementById('assembleTestsBtn');
    const cancelAssembleBtn = document.getElementById('cancelAssembleBtn');
    const assembleStatus = document.getElementById('assembleStatus');
    let currentRecordGLValue = '2';

    /**
     * Логирует сообщение в консоль webview и отправляет его в расширение.
     * @param {string} message - Сообщение для логирования.
     */
    function log(message) {
        console.log("[Webview]", message);
        vscode.postMessage({ command: 'log', text: "[Webview] " + message });
    }

    /**
     * Обновляет текстовое содержимое статус-бара.
     * @param {string} text - Текст для отображения.
     * @param {'main' | 'assemble'} target - Целевая область статуса ('main' или 'assemble').
     * @param {boolean} [refreshButtonEnabled] - Состояние активности кнопки обновления.
     */
    function updateStatus(text, target = 'main', refreshButtonEnabled) {
        let area = statusBar;
        if (target === 'assemble' && assembleStatus) {
            area = assembleStatus;
        }
        if (area instanceof HTMLElement) {
            area.textContent = text;
            area.classList.toggle('is-empty', !(typeof text === 'string' && text.trim().length > 0));
        }
        // Always respect explicit refresh button state
        if (refreshButtonEnabled !== undefined && refreshBtn instanceof HTMLButtonElement) {
            refreshBtn.disabled = isBuildInProgress ? true : !refreshButtonEnabled;
            log(`Refresh button explicitly set to: ${refreshButtonEnabled ? 'enabled' : 'disabled'}`);
        }
        if (collapseAllBtn instanceof HTMLButtonElement) {
            const hasPhases = Object.keys(testDataByPhase).length > 0;
            const refreshEnabled = refreshBtn instanceof HTMLButtonElement ? !refreshBtn.disabled : true;
            collapseAllBtn.disabled = !(refreshEnabled && hasPhases && settings.switcherEnabled);
        }
        // Кнопка создания сценариев (плюс)
        if (addScenarioDropdownBtn instanceof HTMLButtonElement) {
            addScenarioDropdownBtn.disabled = !settings.switcherEnabled;
        }
        updateTopRunButtonState();
        log(`Status updated [${target}]: ${text}. Refresh button enabled: ${refreshButtonEnabled === undefined ? 'unchanged' : refreshButtonEnabled}`);
    }

    /**
     * Включает или отключает основные элементы управления Test Manager.
     * @param {boolean} enable - True для включения, false для отключения.
     * @param {boolean} [refreshButtonAlso=true] - Управляет ли также кнопкой обновления.
     */
    function enablePhaseControls(enable, refreshButtonAlso = true) {
        const isPhaseSwitcherVisible = settings.switcherEnabled;
        const effectiveEnable = enable && isPhaseSwitcherVisible && !isBuildInProgress;
        phaseControlsActive = effectiveEnable;
        const isDisabled = !effectiveEnable;

        if (selectAllBtn instanceof HTMLButtonElement) selectAllBtn.disabled = isDisabled;

        if (collapseAllBtn instanceof HTMLButtonElement) {
            const hasPhases = Object.keys(testDataByPhase).length > 0;
            collapseAllBtn.disabled = isDisabled || !hasPhases;
        }
        
        if (addScenarioDropdownBtn instanceof HTMLButtonElement) {
            addScenarioDropdownBtn.disabled = !isPhaseSwitcherVisible;
        }


        if (phaseTreeContainer) {
            const checkboxes = phaseTreeContainer.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                if (cb instanceof HTMLInputElement) {
                    const isInitiallyDisabled = initialTestStates[cb.name] === 'disabled';
                    cb.disabled = isDisabled || isInitiallyDisabled;
                    cb.closest('.checkbox-item')?.classList.toggle('globally-disabled', isDisabled && !isInitiallyDisabled);
                }
            });
            const phaseHeaders = phaseTreeContainer.querySelectorAll('.phase-header');
            phaseHeaders.forEach(header => {
                if (isDisabled) header.classList.add('disabled-header');
                else header.classList.remove('disabled-header');

                const toggleBtn = header.querySelector('.phase-toggle-checkboxes-btn');
                if (toggleBtn instanceof HTMLButtonElement) {
                    toggleBtn.disabled = isDisabled;
                }
            });
        }
        if (isBuildInProgress && refreshBtn instanceof HTMLButtonElement) {
             refreshBtn.disabled = true;
        } else if (refreshButtonAlso === true && refreshBtn instanceof HTMLButtonElement) {
             refreshBtn.disabled = isDisabled;
             log(`Refresh button set by enablePhaseControls to: ${isDisabled ? 'disabled' : 'enabled'}`);
        } else if (refreshButtonAlso === false && refreshBtn instanceof HTMLButtonElement) {
             // If refreshButtonAlso is explicitly false, don't change the refresh button state
             // This allows the refresh button to remain enabled even when other controls are disabled
             log(`Refresh button state preserved by enablePhaseControls (refreshButtonAlso=false)`);
        }
        updateRunButtonsState();
        updateSelectDefaultsButtonState();
        log(`Phase controls enabled: ${effectiveEnable} (request ${enable}, feature ${isPhaseSwitcherVisible})`);
    }

    function areCurrentStatesMatchingDefaults() {
        let hasComparableScenario = false;
        for (const name in initialTestStates) {
            if (!Object.prototype.hasOwnProperty.call(initialTestStates, name)) {
                continue;
            }
            if (initialTestStates[name] === 'disabled') {
                continue;
            }
            hasComparableScenario = true;
            const currentState = !!currentCheckboxStates[name];
            const defaultState = !!testDefaultStates[name];
            if (currentState !== defaultState) {
                return false;
            }
        }
        return hasComparableScenario;
    }

    function updateSelectDefaultsButtonState() {
        if (!(selectDefaultsBtn instanceof HTMLButtonElement)) {
            return;
        }
        const noScenarios = !testDataByPhase || Object.keys(testDataByPhase).length === 0;
        const defaultsAlreadyApplied = areCurrentStatesMatchingDefaults();
        selectDefaultsBtn.disabled = !phaseControlsActive || noScenarios || defaultsAlreadyApplied;
    }

    function updateRunButtonsState() {
        if (!phaseTreeContainer) return;
        const runButtons = phaseTreeContainer.querySelectorAll('.run-scenario-btn');
        runButtons.forEach(button => {
            if (button instanceof HTMLButtonElement) {
                const scenarioName = button.getAttribute('data-name') || '';
                const runInfo = scenarioName && runArtifacts ? runArtifacts[scenarioName] : null;
                const isRunInProgress = runInfo?.runStatus === 'running';
                button.disabled = isBuildInProgress || isRunInProgress;
            }
        });
        updateTopRunButtonState();
    }

    function hasRunnableArtifacts() {
        if (!runArtifacts || typeof runArtifacts !== 'object') {
            return false;
        }
        return Object.values(runArtifacts).some(info => !!(info && (info.featurePath || info.jsonPath)));
    }

    function updateTopRunButtonState() {
        const canRun = settings.switcherEnabled && !isBuildInProgress;
        if (runVanessaTopBtn instanceof HTMLButtonElement) {
            runVanessaTopBtn.disabled = !canRun;
        }
    }

    function normalizeAffectedMainScenarioNames(names) {
        if (!Array.isArray(names)) {
            return new Set();
        }
        const result = new Set();
        names.forEach(name => {
            if (typeof name === 'string') {
                const trimmed = name.trim();
                if (trimmed) {
                    result.add(trimmed);
                }
            }
        });
        return result;
    }

    function isScenarioSearchActive() {
        return activeManagerTab === 'tests' && typeof activeScenarioSearchQuery === 'string' && activeScenarioSearchQuery.trim().length > 0;
    }

    function clearAffectedMainScenarioHighlighting() {
        if (!(phaseTreeContainer instanceof HTMLElement)) {
            return;
        }
        const checkboxes = phaseTreeContainer.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            if (!(cb instanceof HTMLInputElement)) return;
            const label = cb.closest('.checkbox-item');
            label?.classList.remove('affected-main-scenario');
        });
        const phaseGroups = phaseTreeContainer.querySelectorAll('.phase-group');
        phaseGroups.forEach(group => {
            if (!(group instanceof HTMLElement)) return;
            group.classList.remove('phase-group-affected');
            const header = group.querySelector('.phase-header');
            if (header instanceof HTMLElement) {
                header.classList.remove('phase-header-affected');
            }
        });
    }

    function applyAffectedMainScenarioHighlighting() {
        if (!phaseTreeContainer) return;
        if (settings.highlightAffectedMainScenarios === false || isScenarioSearchActive()) {
            clearAffectedMainScenarioHighlighting();
            return;
        }

        const checkboxes = phaseTreeContainer.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            if (!(cb instanceof HTMLInputElement)) return;
            const name = cb.name || cb.getAttribute('name') || '';
            const label = cb.closest('.checkbox-item');
            if (!label) return;
            label.classList.toggle('affected-main-scenario', !!name && affectedMainScenarioNames.has(name));
        });

        const phaseGroups = phaseTreeContainer.querySelectorAll('.phase-group');
        phaseGroups.forEach(group => {
            if (!(group instanceof HTMLElement)) return;
            const groupCheckboxes = group.querySelectorAll('input[type="checkbox"]');
            let hasAffectedScenarioInGroup = false;
            groupCheckboxes.forEach(cb => {
                if (hasAffectedScenarioInGroup || !(cb instanceof HTMLInputElement)) {
                    return;
                }
                const name = cb.name || cb.getAttribute('name') || '';
                if (name && affectedMainScenarioNames.has(name)) {
                    hasAffectedScenarioInGroup = true;
                }
            });

            group.classList.toggle('phase-group-affected', hasAffectedScenarioInGroup);
            const header = group.querySelector('.phase-header');
            if (header instanceof HTMLElement) {
                header.classList.toggle('phase-header-affected', hasAffectedScenarioInGroup);
            }
        });
    }

    /**
     * Включает или отключает элементы управления сборкой тестов.
     * @param {boolean} enable - True для включения, false для отключения.
     */
     function enableAssembleControls(enable) {
         const isAssemblerVisible = settings.assemblerEnabled;
         const effectiveEnable = enable && isAssemblerVisible && !isBuildInProgress;
         const showCancelButton = isAssemblerVisible && isBuildInProgress;
         const driveFeaturesVisible = settings.driveFeaturesEnabled !== false;
         const firstLaunchVisible = driveFeaturesVisible && !!settings.firstLaunchFolderExists;

         if (assembleSplitContainer instanceof HTMLElement) {
             assembleSplitContainer.style.display = isAssemblerVisible ? (showCancelButton ? 'none' : 'inline-flex') : 'none';
         }
         if (assembleBtn instanceof HTMLButtonElement) {
             assembleBtn.disabled = !effectiveEnable;
         }
         if (assembleMenuBtn instanceof HTMLButtonElement) {
             assembleMenuBtn.style.display = driveFeaturesVisible ? 'inline-flex' : 'none';
             assembleMenuBtn.disabled = !effectiveEnable;
         }
         if (cancelAssembleBtn instanceof HTMLButtonElement) {
             cancelAssembleBtn.style.display = (isAssemblerVisible && showCancelButton) ? 'inline-flex' : 'none';
             cancelAssembleBtn.disabled = !showCancelButton;
         }
         if (recordGLModeList instanceof HTMLElement) {
             recordGLModeList.classList.toggle('is-disabled', !effectiveEnable);
         }
         recordGLOptionButtons.forEach(button => {
             if (button instanceof HTMLButtonElement) {
                 button.disabled = !effectiveEnable;
             }
         });
         if (recordGLModeList instanceof HTMLElement) {
             recordGLModeList.classList.toggle('hidden', !driveFeaturesVisible);
         }
         if (driveAccountingModeRow instanceof HTMLElement) {
             driveAccountingModeRow.style.display = driveFeaturesVisible ? 'flex' : 'none';
         }
         if (createFirstLaunchBtn instanceof HTMLButtonElement) {
             const showBuildFlButton = isAssemblerVisible && firstLaunchVisible;
             createFirstLaunchBtn.style.display = showBuildFlButton ? 'inline-flex' : 'none';
             createFirstLaunchBtn.disabled = !showBuildFlButton;
         }
         if (driveActionsRow instanceof HTMLElement) {
             driveActionsRow.style.display = (isAssemblerVisible && firstLaunchVisible) ? 'flex' : 'none';
         }

         syncBuildFlButtonWidth();

         log(`Assemble controls enabled: ${effectiveEnable} (request ${enable}, feature ${isAssemblerVisible})`);
     }

    function syncBuildFlButtonWidth() {
        if (!(createFirstLaunchBtn instanceof HTMLButtonElement)) {
            return;
        }

        const buildFlVisible = createFirstLaunchBtn.style.display !== 'none';
        if (!buildFlVisible) {
            createFirstLaunchBtn.style.removeProperty('width');
            createFirstLaunchBtn.style.removeProperty('flex-basis');
            createFirstLaunchBtn.style.removeProperty('max-width');
            return;
        }

        let referenceElement = null;
        if (assembleSplitContainer instanceof HTMLElement && assembleSplitContainer.style.display !== 'none') {
            referenceElement = assembleSplitContainer;
        } else if (cancelAssembleBtn instanceof HTMLButtonElement && cancelAssembleBtn.style.display !== 'none') {
            referenceElement = cancelAssembleBtn;
        } else if (selectDefaultsBtn instanceof HTMLButtonElement && selectDefaultsBtn.style.display !== 'none') {
            referenceElement = selectDefaultsBtn;
        }

        if (!(referenceElement instanceof HTMLElement)) {
            return;
        }

        const width = Math.round(referenceElement.getBoundingClientRect().width);
        if (width <= 0) {
            return;
        }

        const widthPx = `${width}px`;
        createFirstLaunchBtn.style.width = widthPx;
        createFirstLaunchBtn.style.flexBasis = widthPx;
        createFirstLaunchBtn.style.maxWidth = widthPx;
    }

    function normalizeRecordGLValue(value) {
        return value === '0' || value === '1' || value === '2' ? value : '2';
    }

    function updateRecordGLSelection(value) {
        currentRecordGLValue = normalizeRecordGLValue(value);
        recordGLOptionButtons.forEach(button => {
            if (!(button instanceof HTMLButtonElement)) {
                return;
            }
            const buttonValue = normalizeRecordGLValue(button.dataset.value || '');
            const isSelected = buttonValue === currentRecordGLValue;
            button.classList.toggle('is-selected', isSelected);
            button.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        });
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

    function normalizeFavoriteSortMode(value) {
        return value === 'name' ? 'name' : 'code';
    }

    function sortFavoriteScenarios(entries, sortMode) {
        const mode = normalizeFavoriteSortMode(sortMode);
        const sorted = [...entries];
        if (mode === 'name') {
            sorted.sort((left, right) => {
                const leftName = (left?.name || '').toString();
                const rightName = (right?.name || '').toString();
                return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
            });
            return sorted;
        }

        sorted.sort((left, right) => {
            const leftName = (left?.name || '').toString();
            const rightName = (right?.name || '').toString();
            const leftCode = (left?.scenarioCode || '').toString().trim();
            const rightCode = (right?.scenarioCode || '').toString().trim();
            const leftHasCode = leftCode.length > 0;
            const rightHasCode = rightCode.length > 0;
            if (leftHasCode && rightHasCode) {
                const byCode = leftCode.localeCompare(rightCode, undefined, { sensitivity: 'base' });
                if (byCode !== 0) {
                    return byCode;
                }
                return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
            }
            if (leftHasCode) {
                return -1;
            }
            if (rightHasCode) {
                return 1;
            }
            return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
        });
        return sorted;
    }

    function renderFavoritesList() {
        if (!(favoritesContainer instanceof HTMLElement)) {
            return;
        }

        const emptyText = window.__loc?.favoritesEmpty || 'No favorite scenarios yet.';
        const sortedFavorites = sortFavoriteScenarios(Array.isArray(favoriteScenarios) ? favoriteScenarios : [], favoriteSortMode);
        if (sortedFavorites.length === 0) {
            favoritesContainer.innerHTML = `<p>${escapeHtmlText(emptyText)}</p>`;
            return;
        }

        const openTitle = window.__loc?.favoritesOpenTitle || 'Open scenario';
        const removeTitle = window.__loc?.favoritesRemoveTitle || 'Remove from favorites';
        const noCode = window.__loc?.noCode || 'No code';

        const itemsHtml = sortedFavorites.map(entry => {
            const uri = typeof entry?.uri === 'string' ? entry.uri : '';
            const name = typeof entry?.name === 'string' ? entry.name : '';
            const scenarioCode = typeof entry?.scenarioCode === 'string' ? entry.scenarioCode : '';
            return `
                <div class="favorite-item" data-uri="${escapeHtmlAttr(uri)}" data-name="${escapeHtmlAttr(name)}" draggable="true" tabindex="0" role="button" title="${escapeHtmlAttr(openTitle)}">
                    <div class="favorite-main" title="${escapeHtmlAttr(uri)}">
                        <span class="favorite-label">${escapeHtmlText(name)}</span>
                        <span class="favorite-meta">${escapeHtmlText(scenarioCode || noCode)}</span>
                    </div>
                    <div class="favorite-actions">
                        <button type="button" class="favorite-action-btn remove" data-action="remove" data-uri="${escapeHtmlAttr(uri)}" title="${escapeHtmlAttr(removeTitle)}">
                            <span class="codicon codicon-close"></span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        favoritesContainer.innerHTML = `<div class="favorites-list">${itemsHtml}</div>`;
    }

    function setActiveManagerTab(tabName) {
        const nextTab = tabName === 'favorites' ? 'favorites' : 'tests';
        activeManagerTab = nextTab;
        const isFavoritesTab = nextTab === 'favorites';

        if (phaseTreeContainer instanceof HTMLElement) {
            phaseTreeContainer.classList.toggle('hidden', isFavoritesTab);
        }
        if (favoritesContainer instanceof HTMLElement) {
            favoritesContainer.classList.toggle('hidden', !isFavoritesTab);
        }
        if (testsTabBtn instanceof HTMLButtonElement) {
            testsTabBtn.classList.toggle('is-active', !isFavoritesTab);
        }
        if (favoritesTabBtn instanceof HTMLButtonElement) {
            favoritesTabBtn.classList.toggle('is-active', isFavoritesTab);
        }
        if (favoritesSortControls instanceof HTMLElement) {
            favoritesSortControls.classList.toggle('hidden', !isFavoritesTab);
        }
        if (globalListActions instanceof HTMLElement) {
            globalListActions.classList.toggle('hidden', isFavoritesTab);
        }
        if (isFavoritesTab) {
            isScenarioSearchVisible = false;
        }
        if (scenarioSearchRow instanceof HTMLElement) {
            scenarioSearchRow.classList.toggle('hidden', isFavoritesTab || !isScenarioSearchVisible);
        }
        if (toggleScenarioSearchBtn instanceof HTMLButtonElement) {
            toggleScenarioSearchBtn.classList.toggle('hidden', isFavoritesTab);
            toggleScenarioSearchBtn.classList.toggle('is-active', !isFavoritesTab && isScenarioSearchVisible);
            toggleScenarioSearchBtn.setAttribute('aria-pressed', (!isFavoritesTab && isScenarioSearchVisible) ? 'true' : 'false');
        }
        syncScenarioSearchHighlightState(false);
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
    }

    function syncScenarioSearchHighlightState(scrollToMatch = false) {
        if (!(scenarioSearchInput instanceof HTMLInputElement)) {
            clearScenarioSearchHighlights();
            applyAffectedMainScenarioHighlighting();
            updateScenarioSearchClearButtonState();
            return;
        }
        activeScenarioSearchQuery = (scenarioSearchInput.value || '').trim();
        const shouldHighlight =
            activeManagerTab === 'tests' &&
            isScenarioSearchVisible &&
            document.activeElement === scenarioSearchInput &&
            activeScenarioSearchQuery.length > 0;

        if (shouldHighlight) {
            applyScenarioSearch(activeScenarioSearchQuery, scrollToMatch);
            return;
        }

        clearScenarioSearchHighlights();
        applyAffectedMainScenarioHighlighting();
        updateScenarioSearchClearButtonState();
    }

    function applyScenarioSearch(query, scrollToMatch = true) {
        activeScenarioSearchQuery = (query || '').trim();
        clearScenarioSearchHighlights();
        applyAffectedMainScenarioHighlighting();
        updateScenarioSearchClearButtonState();

        if (!(phaseTreeContainer instanceof HTMLElement)) {
            return;
        }
        if (!activeScenarioSearchQuery || activeManagerTab !== 'tests') {
            return;
        }

        const normalizedQuery = activeScenarioSearchQuery.toLocaleLowerCase();
        const scenarioLabels = Array.from(phaseTreeContainer.querySelectorAll('.checkbox-item[data-name]'));
        const matchedScenarioLabels = scenarioLabels.filter(node => {
            if (!(node instanceof HTMLElement)) {
                return false;
            }
            const scenarioName = (node.getAttribute('data-name') || '').trim();
            return scenarioName.toLocaleLowerCase().includes(normalizedQuery);
        });

        if (matchedScenarioLabels.length === 0) {
            return;
        }

        phaseTreeContainer.classList.add('scenario-search-active');
        scenarioLabels.forEach(node => {
            if (node instanceof HTMLElement) {
                node.classList.add('search-dim');
            }
        });

        const phaseHeaders = Array.from(phaseTreeContainer.querySelectorAll('.phase-header'));
        phaseHeaders.forEach(node => {
            if (node instanceof HTMLElement) {
                node.classList.add('phase-header-search-dim');
            }
        });

        const phaseGroups = Array.from(phaseTreeContainer.querySelectorAll('.phase-group'));
        phaseGroups.forEach(node => {
            if (node instanceof HTMLElement) {
                node.classList.add('phase-group-search-dim');
            }
        });

        const matchedPhaseGroups = new Set();
        matchedScenarioLabels.forEach(label => {
            if (!(label instanceof HTMLElement)) {
                return;
            }
            label.classList.remove('search-dim');
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
            phaseGroup.classList.remove('phase-group-search-dim');
            phaseGroup.classList.add('phase-group-search-focus');

            const phaseHeader = phaseGroup.querySelector('.phase-header');
            if (phaseHeader instanceof HTMLElement) {
                phaseHeader.classList.remove('phase-header-search-dim');
                phaseHeader.classList.add('phase-header-search-match');
            }
        });
    }

    /**
     * Создает HTML-разметку для чекбокса теста.
     * @param {object} testInfo - Информация о тесте.
     * @returns {string} HTML-строка.
     */
    function createCheckboxHtml(testInfo) {
        if (!testInfo || typeof testInfo.name !== 'string' || !testInfo.name) {
             log("ERROR: Invalid testInfo in createCheckboxHtml!");
             const checkboxError = window.__loc?.checkboxDataError || 'Checkbox data error';
             return `<p style="color:var(--vscode-errorForeground);">${checkboxError}</p>`;
        }
        const name = testInfo.name;
        const relativePath = testInfo.relativePath || '';
        const defaultState = !!testInfo.defaultState;
        const safeName = name.replace(/[^a-zA-Z0-9_\\-]/g, '_'); 
        const escapedNameAttr = escapeHtmlAttr(name);
        const escapedTitleAttr = escapeHtmlAttr(relativePath);
        const fileUriString = testInfo.yamlFileUriString || '';
        const isAffectedMainScenario = affectedMainScenarioNames.has(name);
        const escapedIconTitle = escapeHtmlAttr((window.__loc?.openScenarioFileTitle || 'Open scenario file {0}').replace('{0}', name));
        const runInfo = runArtifacts && typeof runArtifacts === 'object' ? runArtifacts[name] : null;
        const hasRunArtifact = !!(runInfo && (runInfo.featurePath || runInfo.jsonPath));
        const runStatus = runInfo?.runStatus || 'idle';
        const isStale = Boolean(runInfo?.stale);
        const isRunInProgress = runStatus === 'running';
        const isRunPassed = runStatus === 'passed';
        const isRunPassedStale = isRunPassed && isStale;
        const isRunPassedFresh = isRunPassed && !isStale;
        const isRunFailed = runStatus === 'failed';
        const runMessage = typeof runInfo?.runMessage === 'string' ? runInfo.runMessage.trim() : '';
        const runTitleTemplate = window.__loc?.runScenarioJsonTitle || 'Run scenario in Vanessa Automation by json: {0}';
        const runTitle = runTitleTemplate.replace('{0}', name);
        const staleSuffix = isStale ? ` • ${window.__loc?.runScenarioStaleSuffix || 'Build is stale'}` : '';
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
        const runButtonIconClass = isRunInProgress
            ? 'codicon codicon-loading codicon-modifier-spin'
            : (isRunPassed
                ? 'codicon codicon-check'
                : (isRunFailed
                    ? 'codicon codicon-error'
                    : 'codicon codicon-play-circle'));
        const runButtonTitle = `${runTitle}${statusSuffix}${staleSuffix}${runMessage ? `\n${runMessage}` : ''}`;
        const escapedRunTitle = escapeHtmlAttr(runButtonTitle);
        const runButtonDisabledAttr = (isBuildInProgress || isRunInProgress) ? ' disabled' : '';
        const canWatchLiveLog = !!runInfo?.canWatchLiveLog;
        const runLogTitleTemplate = canWatchLiveLog
            ? (window.__loc?.runScenarioWatchLogTitle || 'Watch live run log for scenario: {0}')
            : (window.__loc?.runScenarioLogTitle || 'Open run log for scenario: {0}');
        const runLogTitle = escapeHtmlAttr(runLogTitleTemplate.replace('{0}', name));

        const openButtonHtml = fileUriString
            ? `<button class="open-scenario-btn" data-name="${escapedNameAttr}" title="${escapedIconTitle}">
                   <span class="codicon codicon-circle-small-filled open-scenario-icon-idle"></span>
                   <span class="codicon codicon-edit open-scenario-icon-edit"></span>
               </button>`
            : '';

        const runButtonHtml = hasRunArtifact
            ? `<button class="${runButtonClass}" data-name="${escapedNameAttr}" title="${escapedRunTitle}"${runButtonDisabledAttr}>
                   <span class="${runButtonIconClass}"></span>
               </button>`
            : '';
        const runLogButtonHtml = (runInfo?.hasRunLog || canWatchLiveLog)
            ? `<button class="run-scenario-log-btn${canWatchLiveLog ? ' run-scenario-log-btn-live' : ''}" data-name="${escapedNameAttr}" title="${runLogTitle}">
                   <span class="codicon ${canWatchLiveLog ? 'codicon-list-flat' : 'codicon-output'}"></span>
               </button>`
            : '';

        return `
            <div class="item-container">
                <label class="checkbox-item${isAffectedMainScenario ? ' affected-main-scenario' : ''}" id="label-${safeName}" data-name="${escapedNameAttr}" title="${escapedTitleAttr}">
                    <input
                        type="checkbox"
                        id="chk-${safeName}"
                        name="${escapedNameAttr}"
                        data-default="${defaultState}">
                    <span class="checkbox-label-text">${name}</span>
                    ${runLogButtonHtml}
                    ${runButtonHtml}
                    ${openButtonHtml}
                </label>
            </div>
        `;
    }

    /**
     * Отрисовывает дерево фаз и тестов.
     * @param {object} allPhaseData - Данные о фазах и тестах.
     */
    function renderPhaseTree(allPhaseData) {
        log('Rendering phase tree...');
        if (!phaseTreeContainer) { log("Error: Phase tree container not found!"); return; }
        phaseTreeContainer.innerHTML = '';

        const sortedPhaseNames = Object.keys(allPhaseData).sort();

        if (sortedPhaseNames.length === 0) {
            const noPhasesMessage = window.__loc?.noPhasesToDisplay || 'No groups to display.';
            phaseTreeContainer.innerHTML = `<p>${noPhasesMessage}</p>`;
            if (collapseAllBtn instanceof HTMLButtonElement) collapseAllBtn.disabled = true;
            return;
        } else {
             if (collapseAllBtn instanceof HTMLButtonElement) {
                collapseAllBtn.disabled = !settings.switcherEnabled;
            }
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
                    if (testInfo && initialTestStates[testInfo.name] !== 'disabled') {
                        totalInPhase++;
                        if (currentCheckboxStates[testInfo.name]) {
                            enabledCount++;
                        }
                    }
                });
            }

            const phaseGroupDiv = document.createElement('div');
            phaseGroupDiv.className = 'phase-group';
            phaseGroupDiv.id = phaseGroupId;

            const phaseHeaderDiv = document.createElement('div');
            phaseHeaderDiv.className = 'phase-header';
            phaseHeaderDiv.id = phaseHeaderId;
            phaseHeaderDiv.dataset.phaseName = phaseName;

            const expandCollapseButton = document.createElement('button');
            expandCollapseButton.className = 'phase-expand-collapse-btn button-with-icon';
            expandCollapseButton.setAttribute('role', 'button');
            expandCollapseButton.setAttribute('tabindex', '0');
            expandCollapseButton.setAttribute('aria-expanded', phaseExpandedState[phaseName] ? 'true' : 'false');
            expandCollapseButton.setAttribute('aria-controls', testsListId);
            expandCollapseButton.title = phaseExpandedState[phaseName]
                ? (window.__loc?.collapsePhaseTitle || 'Collapse group')
                : (window.__loc?.expandPhaseTitle || 'Expand group');

            const iconSpan = document.createElement('span');
            iconSpan.className = `codicon phase-toggle-icon ${phaseExpandedState[phaseName] ? 'codicon-chevron-down' : 'codicon-chevron-right'}`;
            expandCollapseButton.appendChild(iconSpan);

            const titleSpan = document.createElement('span');
            titleSpan.className = 'phase-title';
            titleSpan.textContent = phaseName;
            expandCollapseButton.appendChild(titleSpan);

            const countSpan = document.createElement('span');
            countSpan.className = 'phase-test-count';
            countSpan.textContent = `${enabledCount}/${totalInPhase}`;

            const toggleCheckboxesBtn = document.createElement('button');
            toggleCheckboxesBtn.className = 'phase-toggle-checkboxes-btn button-with-icon';
            toggleCheckboxesBtn.title = window.__loc?.toggleAllInPhaseTitle || 'Toggle all tests in this group';
            toggleCheckboxesBtn.dataset.phaseName = phaseName;
            const toggleIcon = document.createElement('span');
            toggleIcon.className = 'codicon codicon-check-all';
            toggleCheckboxesBtn.appendChild(toggleIcon);

            phaseHeaderDiv.appendChild(expandCollapseButton);
            phaseHeaderDiv.appendChild(countSpan);
            phaseHeaderDiv.appendChild(toggleCheckboxesBtn);

            const testsListDiv = document.createElement('div');
            testsListDiv.className = 'phase-tests-list';
            testsListDiv.id = testsListId;

            if (Array.isArray(testsInPhase)) {
                if (testsInPhase.length === 0) {
                    const txt = window.__loc?.noTestsInPhase || 'No tests in this group.';
                    testsListDiv.innerHTML = `<p class="no-tests-in-phase">${txt}</p>`;
                } else {
                    testsInPhase.forEach(info => { if (info?.name) testsListDiv.innerHTML += createCheckboxHtml(info); });
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
            expandCollapseButton.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handlePhaseHeaderClick(event);
                }
            });
            toggleCheckboxesBtn.addEventListener('click', handleTogglePhaseCheckboxesClick);
            phaseHeaderDiv.addEventListener('contextmenu', handlePhaseContextMenu);
        });
        applyCheckboxStatesToVisible();
        syncScenarioSearchHighlightState(false);
        log('Phase tree rendered.');
        updateAreAllPhasesExpandedState();
    }

    function setPhaseListExpandedState(testsList, expanded, animate = true) {
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
            return;
        }

        if (expanded) {
            testsList.classList.add('expanded');
            testsList.style.maxHeight = '0px';
            void testsList.offsetHeight;

            const targetHeight = testsList.scrollHeight;
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
            testsList.style.maxHeight = `${targetHeight}px`;
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
        const icon = button.querySelector('.phase-toggle-icon');

        if (!testsList || !icon) return;

        const nextExpanded = !phaseExpandedState[phaseName];
        phaseExpandedState[phaseName] = nextExpanded;
        setPhaseListExpandedState(testsList, nextExpanded, true);
        icon.classList.toggle('codicon-chevron-right', !nextExpanded);
        icon.classList.toggle('codicon-chevron-down', nextExpanded);
        button.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
        button.title = nextExpanded
            ? (window.__loc?.collapsePhaseTitle || 'Collapse group')
            : (window.__loc?.expandPhaseTitle || 'Expand group');
        log(`Phase '${phaseName}' expanded state: ${nextExpanded}`);
        updateAreAllPhasesExpandedState();
    }

    /**
     * Обработчик клика по кнопке переключения всех чекбоксов внутри фазы.
     * @param {MouseEvent} event
     */
    function handleTogglePhaseCheckboxesClick(event) {
        const button = event.currentTarget;
        if (!(button instanceof HTMLButtonElement)) return;
        event.stopPropagation();

        const phaseName = button.dataset.phaseName;
        if (!phaseName) {
            log("ERROR: Toggle phase checkboxes button clicked without phaseName!");
            return;
        }
        log(`Toggle checkboxes for phase '${phaseName}' clicked.`);

        const testsListId = 'tests-list-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        const testsList = document.getElementById(testsListId);
        if (!testsList) return;

        const checkboxesInPhase = testsList.querySelectorAll('input[type="checkbox"]:not(:disabled)');
        if (checkboxesInPhase.length === 0) return;

        let shouldCheckAll = false;
        for (const cb of checkboxesInPhase) {
            if (cb instanceof HTMLInputElement && !cb.checked) {
                shouldCheckAll = true;
                break;
            }
        }

        checkboxesInPhase.forEach(cb => {
            if (cb instanceof HTMLInputElement) {
                const testName = cb.name;
                cb.checked = shouldCheckAll;
                updateCurrentState(testName, shouldCheckAll);
            }
        });

        updatePendingStatus();
        updateHighlighting();
        sendScenarioSelectionStates();
    }

    /**
     * Обновляет состояние и иконку кнопки "Свернуть/Развернуть все".
     */
    function updateAreAllPhasesExpandedState() {
        if (!phaseTreeContainer || !collapseAllBtn) return;
        const phaseHeaders = phaseTreeContainer.querySelectorAll('.phase-header');
        if (phaseHeaders.length === 0) {
            areAllPhasesCurrentlyExpanded = false;
            if (collapseAllBtn.firstElementChild) collapseAllBtn.firstElementChild.className = 'codicon codicon-expand-all';
            collapseAllBtn.title = window.__loc?.expandAllPhasesTitle || 'Expand all groups';
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
        if (collapseAllBtn.firstElementChild) {
             collapseAllBtn.firstElementChild.className = areAllPhasesCurrentlyExpanded ? 'codicon codicon-collapse-all' : 'codicon codicon-expand-all';
        }
        collapseAllBtn.title = areAllPhasesCurrentlyExpanded
            ? (window.__loc?.collapseAllPhasesTitle || 'Collapse all groups')
            : (window.__loc?.expandAllPhasesTitle || 'Expand all groups');
    }

    /**
     * Обрабатывает клик по кнопке "Свернуть/Развернуть все".
     */
    function handleCollapseAllClick() {
        log('Collapse/Expand All button clicked.');
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

    /**
     * Обновляет подсветку измененных чекбоксов.
     */
    function updateHighlighting() {
        if (!phaseTreeContainer) return;
        const checkboxes = phaseTreeContainer.querySelectorAll('input[type=checkbox]');
        checkboxes.forEach(cb => {
            if (!(cb instanceof HTMLInputElement)) return;
            const label = cb.closest('.checkbox-item');
            if (!label) return;
            label.classList.remove('changed');
        });
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
        vscode.postMessage({
            command: 'openScenario',
            name: name
        });
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
        const runInfo = runArtifacts && typeof runArtifacts === 'object' ? runArtifacts[name] : null;
        if (runInfo?.runStatus === 'running') {
            log(`Run request ignored for "${name}" because run is already in progress.`);
            return;
        }
        log(`Run scenario button clicked: ${name}`);
        vscode.postMessage({
            command: 'runScenarioInVanessa',
            name
        });
    }

    function handleRunLogClick(event) {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('.run-scenario-log-btn');
        if (!(button instanceof HTMLButtonElement)) return;

        event.preventDefault();
        event.stopPropagation();
        const name = button.getAttribute('data-name');
        if (!name) {
            log('ERROR: Run log button clicked without data-name attribute!');
            return;
        }
        const runInfo = runArtifacts && typeof runArtifacts === 'object' ? runArtifacts[name] : null;
        log(`Run log button clicked for: ${name}`);
        vscode.postMessage({
            command: runInfo?.canWatchLiveLog ? 'watchRunScenarioLog' : 'openRunScenarioLog',
            name
        });
    }

    function closeRunModeMenu() {
        if (!activeRunModeMenu) return;
        activeRunModeMenu.remove();
        activeRunModeMenu = null;
    }

    function closeAssembleOptionsMenu() {
        if (!(assembleSplitContainer instanceof HTMLElement)) {
            return;
        }
        assembleSplitContainer.classList.remove('show');
        resetAssembleDropdownPosition();
    }

    function closeContextMenu() {
        if (!activeContextMenu) return;
        activeContextMenu.remove();
        activeContextMenu = null;
    }

    function showContextMenuAt(positionX, positionY, actions, scopeKey = '') {
        if (!Array.isArray(actions) || actions.length === 0) {
            return;
        }
        closeRunModeMenu();
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
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'run-mode-menu-item';
            item.innerHTML = `<span class="codicon ${escapeHtmlAttr(action.icon || 'codicon-edit')}"></span><span>${escapeHtmlAttr(action.label || '')}</span>`;
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
        showContextMenuAt(event.clientX, event.clientY, [
            {
                icon: 'codicon-rename',
                label: window.__loc?.renameGroupTitle || 'Rename group',
                onClick: () => vscode.postMessage({ command: 'renameGroup', groupName: phaseName })
            }
        ], `phase:${phaseName}`);
    }

    function handleScenarioContextMenu(event) {
        if (!(event.currentTarget instanceof HTMLElement)) return;
        const name = event.currentTarget.getAttribute('data-name');
        if (!name) return;

        event.preventDefault();
        event.stopPropagation();
        const runInfo = runArtifacts && typeof runArtifacts === 'object' ? runArtifacts[name] : null;
        const hasRunArtifact = !!(runInfo && (runInfo.featurePath || runInfo.jsonPath));
        const hasFeatureArtifact = !!(runInfo && runInfo.featurePath);
        const isRunInProgress = runInfo?.runStatus === 'running';
        const runDisabled = isBuildInProgress || isRunInProgress || !hasRunArtifact;
        const runModeAutomaticLabel = window.__loc?.runScenarioModeAutomatic || 'Run test (auto close)';
        const runLabel = runModeAutomaticLabel.replace(/\s*\([^)]*\)\s*$/, '') || 'Run test';
        const runHint = window.__loc?.runScenarioModeAutomaticHint || 'Runs scenario with StartFeaturePlayer and waits for completion.';
        const runUnavailable = window.__loc?.runScenarioNoArtifacts || 'No build artifacts found. Build tests first in current session.';
        const openFeatureLabel = window.__loc?.runScenarioModeOpenFeature || 'Open feature in editor';
        const openFeatureHint = window.__loc?.runScenarioModeOpenFeatureHint || 'Opens built feature file for this scenario in editor.';
        const openFeatureUnavailable = window.__loc?.runScenarioNoFeatureArtifact || 'Feature artifact is not available for this scenario.';

        showContextMenuAt(event.clientX, event.clientY, [
            {
                icon: 'codicon-edit',
                label: window.__loc?.openScenarioTitle || 'Open scenario',
                onClick: () => vscode.postMessage({ command: 'openScenario', name })
            },
            {
                icon: 'codicon-rename',
                label: window.__loc?.renameScenarioTitle || 'Rename scenario',
                onClick: () => vscode.postMessage({ command: 'renameScenario', name })
            },
            {
                icon: 'codicon-go-to-file',
                label: openFeatureLabel,
                title: hasFeatureArtifact ? openFeatureHint : openFeatureUnavailable,
                disabled: !hasFeatureArtifact,
                onClick: () => vscode.postMessage({ command: 'openScenarioFeatureInEditor', name })
            },
            {
                icon: 'codicon-play-circle',
                label: runLabel,
                title: runDisabled ? runUnavailable : runHint,
                disabled: runDisabled,
                onClick: () => vscode.postMessage({ command: 'runScenarioInVanessa', name })
            }
        ], `scenario:${name}`);
    }

    function showRunModeMenu(anchorButton, scenarioName, options = {}) {
        const includeManual = options?.includeManual !== false;
        const menuScope = scenarioName || '__top__';
        if (activeRunModeMenu && activeRunModeMenu.getAttribute('data-scenario') === menuScope) {
            closeRunModeMenu();
            return;
        }
        closeRunModeMenu();
        closeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'run-mode-menu';
        menu.setAttribute('data-scenario', menuScope);

        const autoLabel = window.__loc?.runScenarioModeAutomatic || 'Run test (auto close)';
        const manualLabel = window.__loc?.runScenarioModeManual || 'Open for debugging (keep Vanessa open)';
        const menuTitle = window.__loc?.runScenarioModeTitle || 'Choose launch mode';
        const autoHint = window.__loc?.runScenarioModeAutomaticHint || 'Runs scenario with StartFeaturePlayer and waits for completion.';
        const manualHint = window.__loc?.runScenarioModeManualHint || 'Opens Vanessa for manual debugging without StartFeaturePlayer.';
        const canRunAuto = scenarioName ? true : hasRunnableArtifacts();
        const runInfo = scenarioName && runArtifacts && typeof runArtifacts === 'object' ? runArtifacts[scenarioName] : null;
        const hasFeatureArtifact = !!(scenarioName && runInfo && runInfo.featurePath);

        const autoItem = document.createElement('button');
        autoItem.type = 'button';
        autoItem.className = 'run-mode-menu-item';
        autoItem.innerHTML = `<span class="codicon codicon-play-circle"></span><span>${escapeHtmlAttr(autoLabel)}</span>`;
        autoItem.title = canRunAuto
            ? `${menuTitle}\n${autoHint}`
            : (window.__loc?.runScenarioNoArtifacts || 'No build artifacts found. Build tests first in current session.');
        if (!canRunAuto) {
            autoItem.disabled = true;
            autoItem.classList.add('run-mode-menu-item-disabled');
        }
        autoItem.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            if (autoItem.disabled) {
                return;
            }
            closeRunModeMenu();
            if (scenarioName) {
                vscode.postMessage({
                    command: 'runScenarioInVanessa',
                    name: scenarioName
                });
            } else {
                vscode.postMessage({
                    command: 'runScenarioViaPicker',
                    mode: 'auto'
                });
            }
        });

        const manualItem = document.createElement('button');
        manualItem.type = 'button';
        manualItem.className = 'run-mode-menu-item';
        manualItem.innerHTML = `<span class="codicon codicon-debug-alt"></span><span>${escapeHtmlAttr(manualLabel)}</span>`;
        manualItem.title = `${menuTitle}\n${manualHint}`;
        manualItem.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            closeRunModeMenu();
            if (scenarioName) {
                vscode.postMessage({
                    command: 'openScenarioInVanessaManual',
                    name: scenarioName
                });
            } else {
                vscode.postMessage({
                    command: 'runScenarioViaPicker',
                    mode: 'debug'
                });
            }
        });

        menu.appendChild(autoItem);
        if (includeManual) {
            menu.appendChild(manualItem);
        }

        if (scenarioName) {
            const openFeatureLabel = window.__loc?.runScenarioModeOpenFeature || 'Open feature in editor';
            const openFeatureHint = window.__loc?.runScenarioModeOpenFeatureHint || 'Opens built feature file for this scenario in editor.';
            const openFeatureUnavailable = window.__loc?.runScenarioNoFeatureArtifact || 'Feature artifact is not available for this scenario.';
            const openFeatureItem = document.createElement('button');
            openFeatureItem.type = 'button';
            openFeatureItem.className = 'run-mode-menu-item';
            openFeatureItem.innerHTML = `<span class="codicon codicon-go-to-file"></span><span>${escapeHtmlAttr(openFeatureLabel)}</span>`;
            openFeatureItem.title = hasFeatureArtifact
                ? `${menuTitle}\n${openFeatureHint}`
                : openFeatureUnavailable;
            if (!hasFeatureArtifact) {
                openFeatureItem.disabled = true;
                openFeatureItem.classList.add('run-mode-menu-item-disabled');
            }
            openFeatureItem.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                if (openFeatureItem.disabled) {
                    return;
                }
                closeRunModeMenu();
                vscode.postMessage({
                    command: 'openScenarioFeatureInEditor',
                    name: scenarioName
                });
            });
            menu.appendChild(openFeatureItem);
        }
        document.body.appendChild(menu);

        const rect = anchorButton.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const topSpace = rect.top;
        const bottomSpace = window.innerHeight - rect.bottom;
        const placeAbove = bottomSpace < menuRect.height + 8 && topSpace > menuRect.height + 8;
        const top = placeAbove ? rect.top - menuRect.height - 4 : rect.bottom + 4;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));

        menu.style.top = `${Math.max(8, top)}px`;
        menu.style.left = `${left}px`;

        activeRunModeMenu = menu;
    }

    function handleTopRunVanessaClick(event) {
        if (!(runVanessaTopBtn instanceof HTMLButtonElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (runVanessaTopBtn.disabled) {
            return;
        }
        showRunModeMenu(runVanessaTopBtn, '');
    }

    /**
     * Применяет текущие состояния чекбоксов к видимым элементам.
     */
    function applyCheckboxStatesToVisible() {
        log('Applying states to visible checkboxes...');
        if (!phaseTreeContainer) return;
        const checkboxes = phaseTreeContainer.querySelectorAll('input[type="checkbox"]');
        let count = 0;
        checkboxes.forEach(cb => {
            if (!(cb instanceof HTMLInputElement)) return;
            const name = cb.getAttribute('name');
            const label = cb.closest('.checkbox-item');
            cb.removeEventListener('change', handleCheckboxChange);

            if (name && initialTestStates.hasOwnProperty(name)) {
                count++;
                const initialState = initialTestStates[name];
                cb.disabled = (initialState === 'disabled');
                cb.checked = !!currentCheckboxStates[name];
                if(label) {
                    label.classList.toggle('disabled', cb.disabled);
                    label.classList.remove('changed');
                }
                if (!cb.disabled) {
                    cb.addEventListener('change', handleCheckboxChange);
                }
            } else if (name) {
                cb.disabled = true;
                if(label) label.classList.add('disabled');
            } else {
                log("ERROR: Checkbox found with NO NAME attribute!");
            }
        });

        const scenarioLabels = phaseTreeContainer.querySelectorAll('.checkbox-item[data-name]');
        scenarioLabels.forEach(label => {
            if (!(label instanceof HTMLElement)) return;
            label.removeEventListener('contextmenu', handleScenarioContextMenu);
            label.addEventListener('contextmenu', handleScenarioContextMenu);
        });

        const openButtons = phaseTreeContainer.querySelectorAll('.open-scenario-btn');
        openButtons.forEach(btn => {
            btn.removeEventListener('click', handleOpenScenarioClick);
            btn.addEventListener('click', handleOpenScenarioClick);
        });

        const runButtons = phaseTreeContainer.querySelectorAll('.run-scenario-btn');
        runButtons.forEach(btn => {
            if (!(btn instanceof HTMLButtonElement)) return;
            const scenarioName = btn.getAttribute('data-name') || '';
            const runInfo = scenarioName && runArtifacts ? runArtifacts[scenarioName] : null;
            const isRunInProgress = runInfo?.runStatus === 'running';
            btn.disabled = isBuildInProgress || isRunInProgress;
            btn.removeEventListener('click', handleRunScenarioClick);
            btn.addEventListener('click', handleRunScenarioClick);
        });

        const runLogButtons = phaseTreeContainer.querySelectorAll('.run-scenario-log-btn');
        runLogButtons.forEach(btn => {
            btn.removeEventListener('click', handleRunLogClick);
            btn.addEventListener('click', handleRunLogClick);
        });

        log(`Applied states to ${count} visible checkboxes.`);
        updateHighlighting();
        applyAffectedMainScenarioHighlighting();
        updateAreAllPhasesExpandedState();
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
        updateHighlighting();
        sendScenarioSelectionStates();
    }

    /**
     * Обновляет счетчики тестов для каждой фазы, включая индикацию изменений.
     */
    function updatePhaseCounts() {
        if (!phaseTreeContainer) return;
        const phaseHeaders = phaseTreeContainer.querySelectorAll('.phase-header');
        phaseHeaders.forEach(header => {
            if (!(header instanceof HTMLElement)) return;
            const phaseName = header.dataset.phaseName;
            if (!phaseName || !testDataByPhase[phaseName]) return;

            const testsInPhase = testDataByPhase[phaseName];
            let enabledCount = 0;
            let totalInPhase = 0;

            if (Array.isArray(testsInPhase)) {
                testsInPhase.forEach(testInfo => {
                    if (testInfo && initialTestStates[testInfo.name] !== 'disabled') {
                        totalInPhase++;
                        if (currentCheckboxStates[testInfo.name]) {
                            enabledCount++;
                        }
                    }
                });
            }
            const countElement = header.querySelector('.phase-test-count');
            if (countElement) {
                countElement.textContent = `${enabledCount}/${totalInPhase}`;
                countElement.classList.remove('group-changed');
            }
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
        let enabled = 0;
        let total = 0;
        for (const name in initialTestStates) {
            if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') {
                total++;
                const currentState = !!currentCheckboxStates[name];
                if (currentState) {
                    enabled++;
                }
            }
        }

        if (selectionSummaryBar instanceof HTMLElement) {
            const statusTemplate = window.__loc?.selectionStateSummary || 'Selected: {0}/{1}';
            selectionSummaryBar.textContent = statusTemplate
                .replace('{0}', String(enabled))
                .replace('{1}', String(total));
        }

        updateHighlighting();
        updatePhaseCounts();
        updateAreAllPhasesExpandedState();
        updateSelectDefaultsButtonState();
    }

    // Обработчик сообщений от расширения
    window.addEventListener('message', event => {
        const message = event.data;
        log('Received message command: ' + message?.command);

        switch (message?.command) {
            case 'loadInitialState':
                if (assembleStatus instanceof HTMLElement) assembleStatus.textContent = '';

                if (message.error) {
                     closeRunModeMenu();
                     closeAssembleOptionsMenu();
                     closeContextMenu();
                     runArtifacts = {};
                     const errorTemplate = window.__loc?.errorWithDetails || 'Error: {0}';
                     updateStatus(errorTemplate.replace('{0}', message.error), 'main', true);
                      phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = 'none'; });
                     enablePhaseControls(false, true); enableAssembleControls(false);
                     if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.disabled = false;
                } else {
                    closeRunModeMenu();
                    closeAssembleOptionsMenu();
                    closeContextMenu();
                    testDataByPhase = message.tabData || {};
                    initialTestStates = message.states || {};
                    runArtifacts = message.runArtifacts || {};
                    favoriteScenarios = Array.isArray(message.favorites) ? message.favorites : [];
                    favoriteSortMode = normalizeFavoriteSortMode(message.favoriteSortMode || favoriteSortMode);
                    affectedMainScenarioNames = normalizeAffectedMainScenarioNames(message.affectedMainScenarioNames);
                    settings = message.settings || {
                        assemblerEnabled: true,
                        switcherEnabled: true,
                        driveFeaturesEnabled: false,
                        highlightAffectedMainScenarios: true
                    };
                    if (typeof settings.highlightAffectedMainScenarios !== 'boolean') {
                        settings.highlightAffectedMainScenarios = true;
                    }
                    isBuildInProgress = !!settings.buildInProgress;
                    log("Received settings in webview:");
                    console.log(settings);

                    currentCheckboxStates = {}; testDefaultStates = {};
                    if (Object.keys(phaseExpandedState).length === 0 && testDataByPhase) {
                        Object.keys(testDataByPhase).forEach(phaseName => {
                            phaseExpandedState[phaseName] = false;
                        });
                    }

                    Object.keys(testDataByPhase).forEach(phaseName => {
                        if (Array.isArray(testDataByPhase[phaseName])) {
                            testDataByPhase[phaseName].forEach(info => {
                                const name = info.name;
                                if (name && initialTestStates.hasOwnProperty(name)) {
                                    if (initialTestStates[name] !== 'disabled') {
                                        currentCheckboxStates[name] = initialTestStates[name] === 'checked';
                                    }
                                    testDefaultStates[name] = !!info.defaultState;
                                }
                            });
                        }
                    });

                    log("State caches initialized.");

                    const phaseSwitcherVisible = settings.switcherEnabled;
                    const assemblerVisible = settings.assemblerEnabled;
                    const driveFeaturesVisible = settings.driveFeaturesEnabled !== false;
                    const firstLaunchVisible = driveFeaturesVisible && !!settings.firstLaunchFolderExists;
                    const managerSectionVisible = phaseSwitcherVisible || assemblerVisible;
                    log(`Applying visibility based on settings: Switcher=${phaseSwitcherVisible}, Assembler=${assemblerVisible}, DriveFeatures=${driveFeaturesVisible}, FirstLaunch=${firstLaunchVisible}`);

                    const managerDisplay = managerSectionVisible ? '' : 'none';
                    phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = managerDisplay; });
                    
                    if (addScenarioDropdownBtn instanceof HTMLButtonElement) { // Управление видимостью новой кнопки
                        addScenarioDropdownBtn.style.display = phaseSwitcherVisible ? 'inline-flex' : 'none';
                    }

                    if (driveAccountingModeRow instanceof HTMLElement) {
                        driveAccountingModeRow.style.display = driveFeaturesVisible ? 'flex' : 'none';
                        log(`  Drive accounting mode display set to: ${driveAccountingModeRow.style.display}`);
                    }
                    if (recordGLModeList instanceof HTMLElement) {
                        recordGLModeList.classList.toggle('hidden', !driveFeaturesVisible);
                    }
                    if (createFirstLaunchBtn instanceof HTMLButtonElement) {
                        createFirstLaunchBtn.style.display = firstLaunchVisible ? 'inline-flex' : 'none';
                        log(`  Build FL button display set to: ${createFirstLaunchBtn.style.display}`);
                    }
                    if (driveActionsRow instanceof HTMLElement) {
                        driveActionsRow.style.display = firstLaunchVisible ? 'flex' : 'none';
                    }
                    if (assembleMenuBtn instanceof HTMLButtonElement) {
                        assembleMenuBtn.style.display = driveFeaturesVisible ? 'inline-flex' : 'none';
                    }

                    if (phaseSwitcherVisible) {
                        renderPhaseTree(testDataByPhase);
                    } else {
                        if (phaseTreeContainer instanceof HTMLElement) {
                            phaseTreeContainer.innerHTML = `<p>${window.__loc?.phaseSwitcherDisabled || 'Test Manager is disabled in settings.'}</p>`;
                        }
                         if (collapseAllBtn instanceof HTMLButtonElement) collapseAllBtn.disabled = true;
                    }
                    if (favoritesSortSelect instanceof HTMLSelectElement) {
                        favoritesSortSelect.value = favoriteSortMode;
                    }
                    renderFavoritesList();
                    setActiveManagerTab(activeManagerTab);

                    updatePendingStatus();
                    enablePhaseControls(phaseSwitcherVisible && !!testDataByPhase && Object.keys(testDataByPhase).length > 0, true);
                    enableAssembleControls(assemblerVisible);
                    if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.disabled = false;

                    if (isBuildInProgress) {
                        const buildMessage = window.__loc?.statusBuildingInProgress || 'Building tests in progress...';
                        updateStatus(buildMessage, 'main', false);
                        updateStatus(buildMessage, 'assemble', false);
                        enablePhaseControls(false, false);
                        enableAssembleControls(false);
                    } else {
                        updateStatus('', 'main', true);
                    }
                    updateTopRunButtonState();
                }
                break;

            case 'updateRunArtifactsState':
                closeRunModeMenu();
                closeAssembleOptionsMenu();
                closeContextMenu();
                runArtifacts = message.runArtifacts || {};
                updateTopRunButtonState();
                if (settings.switcherEnabled && testDataByPhase && Object.keys(testDataByPhase).length > 0) {
                    renderPhaseTree(testDataByPhase);
                    updatePendingStatus();
                } else {
                    updateRunButtonsState();
                }
                applyAffectedMainScenarioHighlighting();
                break;

            case 'updateFavoritesState':
                favoriteScenarios = Array.isArray(message.favorites) ? message.favorites : [];
                favoriteSortMode = normalizeFavoriteSortMode(message.favoriteSortMode || favoriteSortMode);
                if (favoritesSortSelect instanceof HTMLSelectElement) {
                    favoritesSortSelect.value = favoriteSortMode;
                }
                renderFavoritesList();
                setActiveManagerTab(activeManagerTab);
                break;

            case 'updateAffectedMainScenarios':
                affectedMainScenarioNames = normalizeAffectedMainScenarioNames(message.names);
                applyAffectedMainScenarioHighlighting();
                break;

             case 'updateStatus':
                 const target = message.target || 'main';
                 const controlsEnabled = message.enableControls === undefined ? undefined : message.enableControls;
                 let refreshEnabled = message.refreshButtonEnabled;
                 const refreshButtonAlso = message.refreshButtonAlso;

                 if (refreshEnabled === undefined) {
                     refreshEnabled = controlsEnabled === undefined ? (refreshBtn ? !refreshBtn.disabled : true) : controlsEnabled;
                 }

                 updateStatus(message.text, target, refreshEnabled);

                 if (controlsEnabled !== undefined) {
                     // Enable phase controls only if there are tests, but respect refresh button state
                     const shouldEnablePhaseControls = controlsEnabled && settings.switcherEnabled;
                     enablePhaseControls(shouldEnablePhaseControls, refreshButtonAlso !== undefined ? refreshButtonAlso : refreshEnabled);
                     enableAssembleControls(controlsEnabled && settings.assemblerEnabled);
                 }
                 break;

            case 'setRefreshButtonState':
                if (refreshBtn instanceof HTMLButtonElement) {
                    refreshBtn.disabled = isBuildInProgress ? true : !message.enabled;
                    log(`External: Refresh button state set to enabled: ${message.enabled}`);
                }
                break;

            case 'buildStateChanged': {
                isBuildInProgress = !!message.inProgress;
                if (isBuildInProgress) {
                    closeRunModeMenu();
                    closeAssembleOptionsMenu();
                    closeContextMenu();
                    const buildMessage = window.__loc?.statusBuildingInProgress || 'Building tests in progress...';
                    updateStatus(buildMessage, 'main', false);
                    updateStatus(buildMessage, 'assemble', false);
                    enablePhaseControls(false, false);
                    enableAssembleControls(false);
                } else {
                    const mainControlsShouldBeActive = settings.switcherEnabled && !!testDataByPhase && Object.keys(testDataByPhase).length > 0;
                    enablePhaseControls(mainControlsShouldBeActive, true);
                    enableAssembleControls(settings.assemblerEnabled);
                    updatePendingStatus();
                }
                updateTopRunButtonState();
                break;
            }

            default:
                log(`Received unknown command: ${message?.command}`);
                break;
         }
    });

    if(selectAllBtn instanceof HTMLButtonElement) selectAllBtn.addEventListener('click', () => {
        log('Toggle ALL clicked.');
        const keys = Object.keys(initialTestStates).filter(n => initialTestStates[n] !== 'disabled');
        if(keys.length === 0) return;
        let check = false;
        for(const name of keys){ if(!currentCheckboxStates[name]) { check = true; break; } }
        log(`New state for ALL enabled will be: ${check}`);
        keys.forEach(name => { currentCheckboxStates[name] = check; });
        applyCheckboxStatesToVisible();
        updatePendingStatus();
        sendScenarioSelectionStates();
    });

    if(selectDefaultsBtn instanceof HTMLButtonElement) selectDefaultsBtn.addEventListener('click', () => {
        log('Select Defaults for ALL clicked.');
        for (const name in initialTestStates) {
            if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') {
                const defaultState = !!testDefaultStates[name];
                currentCheckboxStates[name] = defaultState;
            }
        }
        applyCheckboxStatesToVisible();
        updatePendingStatus();
        const mainControlsShouldBeActive = settings.switcherEnabled && !!testDataByPhase && Object.keys(testDataByPhase).length > 0;
        enablePhaseControls(mainControlsShouldBeActive, true);
        sendScenarioSelectionStates();
    });

    if(refreshBtn instanceof HTMLButtonElement) refreshBtn.addEventListener('click', () => {
        log('Refresh button clicked.');
        vscode.postMessage({ command: 'refreshData' });
    });

    if (runVanessaTopBtn instanceof HTMLButtonElement) {
        runVanessaTopBtn.addEventListener('click', handleTopRunVanessaClick);
    }

    if (testsTabBtn instanceof HTMLButtonElement) {
        testsTabBtn.addEventListener('click', event => {
            event.preventDefault();
            setActiveManagerTab('tests');
        });
    }

    if (favoritesTabBtn instanceof HTMLButtonElement) {
        favoritesTabBtn.addEventListener('click', event => {
            event.preventDefault();
            setActiveManagerTab('favorites');
        });
    }

    if (favoritesSortSelect instanceof HTMLSelectElement) {
        favoritesSortSelect.addEventListener('change', () => {
            favoriteSortMode = normalizeFavoriteSortMode(favoritesSortSelect.value);
            renderFavoritesList();
            vscode.postMessage({
                command: 'setFavoriteSortMode',
                mode: favoriteSortMode
            });
        });
    }

    if (toggleScenarioSearchBtn instanceof HTMLButtonElement) {
        toggleScenarioSearchBtn.addEventListener('click', event => {
            event.preventDefault();
            if (activeManagerTab !== 'tests') {
                return;
            }
            isScenarioSearchVisible = !isScenarioSearchVisible;
            setActiveManagerTab(activeManagerTab);
            if (isScenarioSearchVisible && scenarioSearchInput instanceof HTMLInputElement) {
                scenarioSearchInput.focus();
            }
        });
    }

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

    if (favoritesContainer instanceof HTMLElement) {
        favoritesContainer.addEventListener('dragstart', event => {
            if (!(event.target instanceof Element)) {
                return;
            }
            const favoriteItem = event.target.closest('.favorite-item');
            if (!(favoriteItem instanceof HTMLElement) || !event.dataTransfer) {
                return;
            }
            const uri = favoriteItem.getAttribute('data-uri');
            const name = favoriteItem.getAttribute('data-name') || '';
            if (!uri) {
                return;
            }

            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData(FAVORITE_SCENARIO_DROP_MIME, uri);
            event.dataTransfer.setData('text/plain', `And ${name}`.trim());
        });

        favoritesContainer.addEventListener('click', event => {
            if (!(event.target instanceof Element)) {
                return;
            }
            const actionButton = event.target.closest('.favorite-action-btn.remove');
            if (actionButton instanceof HTMLButtonElement) {
                const uri = actionButton.getAttribute('data-uri');
                if (!uri) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                favoriteScenarios = favoriteScenarios.filter(entry => (entry?.uri || '') !== uri);
                renderFavoritesList();
                vscode.postMessage({ command: 'removeFavoriteScenario', uri });
                return;
            }

            const favoriteItem = event.target.closest('.favorite-item');
            if (!(favoriteItem instanceof HTMLElement)) {
                return;
            }
            const uri = favoriteItem.getAttribute('data-uri');
            if (!uri) {
                return;
            }
            event.preventDefault();
            vscode.postMessage({ command: 'openFavoriteScenario', uri });
        });

        favoritesContainer.addEventListener('keydown', event => {
            if (!(event.target instanceof HTMLElement)) {
                return;
            }
            if (event.key !== 'Enter' && event.key !== ' ') {
                return;
            }
            const favoriteItem = event.target.closest('.favorite-item');
            if (!(favoriteItem instanceof HTMLElement)) {
                return;
            }
            if (event.target.closest('.favorite-action-btn.remove')) {
                return;
            }
            const uri = favoriteItem.getAttribute('data-uri');
            if (!uri) {
                return;
            }
            event.preventDefault();
            if (event.key === 'Enter' || event.key === ' ') {
                vscode.postMessage({ command: 'openFavoriteScenario', uri });
            }
        });
    }

    if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.addEventListener('click', () => {
        log('Open Settings button clicked.');
        vscode.postMessage({ command: 'openSettings' });
    });

    if (collapseAllBtn instanceof HTMLButtonElement) {
        collapseAllBtn.addEventListener('click', handleCollapseAllClick);
    }

    function resetAddScenarioDropdownPosition() {
        if (!(addScenarioDropdownContent instanceof HTMLElement)) {
            return;
        }
        addScenarioDropdownContent.style.left = '';
        addScenarioDropdownContent.style.right = '';
    }

    function positionAddScenarioDropdownWithinViewport() {
        if (!(addScenarioDropdownBtn instanceof HTMLElement) || !(addScenarioDropdownContent instanceof HTMLElement)) {
            return;
        }

        const container = addScenarioDropdownBtn.closest('.dropdown-container');
        if (!(container instanceof HTMLElement) || !container.classList.contains('show')) {
            return;
        }

        addScenarioDropdownContent.style.left = '0px';
        addScenarioDropdownContent.style.right = 'auto';

        const viewportPadding = 8;
        const rect = addScenarioDropdownContent.getBoundingClientRect();
        let shiftX = 0;

        if (rect.right > window.innerWidth - viewportPadding) {
            shiftX += (window.innerWidth - viewportPadding) - rect.right;
        }
        if (rect.left + shiftX < viewportPadding) {
            shiftX += viewportPadding - (rect.left + shiftX);
        }

        addScenarioDropdownContent.style.left = `${shiftX}px`;
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

    // Обработчики для новой кнопки и выпадающего меню
    if (addScenarioDropdownBtn && addScenarioDropdownContent) {
        addScenarioDropdownBtn.addEventListener('click', (event) => {
            event.stopPropagation(); // Предотвращаем закрытие при клике на кнопку
            const container = addScenarioDropdownBtn.closest('.dropdown-container');
            const isShown = !!container?.classList.toggle('show');
            if (isShown) {
                requestAnimationFrame(() => positionAddScenarioDropdownWithinViewport());
            } else {
                resetAddScenarioDropdownPosition();
            }
            log('Add scenario dropdown toggled.');
        });

        if (createMainScenarioFromDropdownBtn) {
            createMainScenarioFromDropdownBtn.addEventListener('click', (event) => {
                event.preventDefault();
                log('Create Main Scenario from dropdown clicked.');
                vscode.postMessage({ command: 'createMainScenario' });
                addScenarioDropdownBtn.closest('.dropdown-container')?.classList.remove('show');
                resetAddScenarioDropdownPosition();
            });
        }

        if (createNestedScenarioFromDropdownBtn) {
            createNestedScenarioFromDropdownBtn.addEventListener('click', (event) => {
                event.preventDefault();
                log('Create Nested Scenario from dropdown clicked.');
                vscode.postMessage({ command: 'createNestedScenario' });
                addScenarioDropdownBtn.closest('.dropdown-container')?.classList.remove('show');
                resetAddScenarioDropdownPosition();
            });
        }
    }

    if (assembleMenuBtn && assembleSplitContainer) {
        assembleMenuBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (assembleMenuBtn instanceof HTMLButtonElement && assembleMenuBtn.disabled) {
                return;
            }
            closeRunModeMenu();
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

    if (recordGLOptionButtons.length > 0) {
        const initiallySelected = recordGLOptionButtons.find(button =>
            button instanceof HTMLButtonElement && button.classList.contains('is-selected')
        );
        if (initiallySelected instanceof HTMLButtonElement) {
            updateRecordGLSelection(initiallySelected.dataset.value || '2');
        } else {
            updateRecordGLSelection('2');
        }

        recordGLOptionButtons.forEach(button => {
            if (!(button instanceof HTMLButtonElement)) {
                return;
            }
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (button.disabled) {
                    return;
                }
                updateRecordGLSelection(button.dataset.value || '2');
                closeAssembleOptionsMenu();
            });
        });
    }

    if (createFirstLaunchBtn instanceof HTMLButtonElement) {
        createFirstLaunchBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (createFirstLaunchBtn.disabled) {
                return;
            }
            closeAssembleOptionsMenu();
            log('Build FL button clicked.');
            vscode.postMessage({ command: 'createFirstLaunchZip' });
        });
    }

    // Закрытие выпадающего списка при клике вне его
    window.addEventListener('click', (event) => {
        if (addScenarioDropdownBtn && addScenarioDropdownContent) {
            const container = addScenarioDropdownBtn.closest('.dropdown-container');
            if (container && !container.contains(event.target)) {
                container.classList.remove('show');
                resetAddScenarioDropdownPosition();
            }
        }
        if (assembleSplitContainer && !assembleSplitContainer.contains(event.target)) {
            closeAssembleOptionsMenu();
        }
        if (activeRunModeMenu && event.target instanceof Node && !activeRunModeMenu.contains(event.target)) {
            closeRunModeMenu();
        }
        if (activeContextMenu && event.target instanceof Node && !activeContextMenu.contains(event.target)) {
            closeContextMenu();
        }
    });

    window.addEventListener('resize', () => {
        positionAddScenarioDropdownWithinViewport();
        positionAssembleDropdownWithinViewport();
        syncBuildFlButtonWidth();
    });


    if(assembleBtn instanceof HTMLButtonElement) {
        assembleBtn.addEventListener('click', () => {
            log('Assemble tests button clicked.');
            closeAssembleOptionsMenu();
            const recordGLValue = normalizeRecordGLValue(currentRecordGLValue);
            isBuildInProgress = true;
            updateStatus(window.__loc?.statusStartingAssembly || 'Starting assembly...', 'assemble', false);
            enablePhaseControls(false, false);
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
            updateStatus(window.__loc?.statusCancellingBuild || 'Cancelling build...', 'assemble', false);
            vscode.postMessage({ command: 'cancelAssembleScript' });
        });
    }

    function requestInitialState() {
        log('Requesting initial state...');
        updateStatus(window.__loc?.statusRequestingData || 'Requesting data...', 'main', false);
        enablePhaseControls(false, false);
        enableAssembleControls(false);
        vscode.postMessage({ command: 'getInitialState' });
    }

    log('Webview script initialized.');
    setActiveManagerTab('tests');
    updateScenarioSearchClearButtonState();
    renderFavoritesList();
    updateStatus(window.__loc?.statusLoadingShort || 'Loading...', 'main', false);
    enablePhaseControls(false, false);
    enableAssembleControls(false);
    requestInitialState();

    // Обработчик для кнопки YAML параметров
    const openYamlParamsBtn = document.getElementById('openYamlParamsBtn');
    if(openYamlParamsBtn instanceof HTMLButtonElement) {
        openYamlParamsBtn.addEventListener('click', () => {
            log('Open Build Scenario Parameters Manager button clicked.');
            vscode.postMessage({ command: 'openYamlParametersManager' });
        });
    }
}());
