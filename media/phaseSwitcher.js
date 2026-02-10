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
    let settings = {
        assemblerEnabled: true,
        switcherEnabled: true
    };
    let isBuildInProgress = false;
    let areAllPhasesCurrentlyExpanded = false; 

    // === Получение ссылок на элементы DOM ===
    const refreshBtn = document.getElementById('refreshBtn');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const collapseAllBtn = document.getElementById('collapseAllBtn');
    const createFirstLaunchBtn = document.getElementById('createFirstLaunchBtn');

    // Новые элементы для выпадающего меню
    const addScenarioDropdownBtn = document.getElementById('addScenarioDropdownBtn');
    const addScenarioDropdownContent = document.getElementById('addScenarioDropdownContent');
    const createMainScenarioFromDropdownBtn = document.getElementById('createMainScenarioFromDropdownBtn');
    const createNestedScenarioFromDropdownBtn = document.getElementById('createNestedScenarioFromDropdownBtn');

    const phaseSwitcherSectionElements = document.querySelectorAll('.phase-switcher-section');
    const phaseTreeContainer = document.getElementById('phaseTreeContainer');

    const statusBar = document.getElementById('statusBar');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const selectDefaultsBtn = document.getElementById('selectDefaultsBtn');
    const applyChangesBtn = document.getElementById('applyChangesBtn');

    const recordGLSelect = document.getElementById('recordGLSelect');

    const assembleBtn = document.getElementById('assembleTestsBtn');
    const assembleStatus = document.getElementById('assembleStatus');
    const assembleSection = document.getElementById('assembleSection');
    const separator = document.getElementById('sectionSeparator');

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
        log(`Status updated [${target}]: ${text}. Refresh button enabled: ${refreshButtonEnabled === undefined ? 'unchanged' : refreshButtonEnabled}`);
    }

    /**
     * Включает или отключает основные элементы управления Phase Switcher.
     * @param {boolean} enable - True для включения, false для отключения.
     * @param {boolean} [refreshButtonAlso=true] - Управляет ли также кнопкой обновления.
     */
    function enablePhaseControls(enable, refreshButtonAlso = true) {
        const isPhaseSwitcherVisible = settings.switcherEnabled;
        const effectiveEnable = enable && isPhaseSwitcherVisible && !isBuildInProgress;
        const isDisabled = !effectiveEnable;

        if (selectAllBtn instanceof HTMLButtonElement) selectAllBtn.disabled = isDisabled;
        if (selectDefaultsBtn instanceof HTMLButtonElement) selectDefaultsBtn.disabled = isDisabled;

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
        log(`Phase controls (excluding Apply, Settings) enabled: ${effectiveEnable} (request ${enable}, feature ${isPhaseSwitcherVisible})`);
    }

    /**
     * Включает или отключает элементы управления сборкой тестов.
     * @param {boolean} enable - True для включения, false для отключения.
     */
     function enableAssembleControls(enable) {
         const isAssemblerVisible = settings.assemblerEnabled;
         const effectiveEnable = enable && isAssemblerVisible && !isBuildInProgress;

         if (assembleBtn instanceof HTMLButtonElement) assembleBtn.disabled = !effectiveEnable;
         if (recordGLSelect instanceof HTMLSelectElement) recordGLSelect.disabled = !effectiveEnable;

         log(`Assemble controls enabled: ${effectiveEnable} (request ${enable}, feature ${isAssemblerVisible})`);
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
        const escapedIconTitle = escapeHtmlAttr((window.__loc?.openScenarioFileTitle || 'Open scenario file {0}').replace('{0}', name));

        const openButtonHtml = fileUriString
            ? `<button class="open-scenario-btn" data-name="${escapedNameAttr}" title="${escapedIconTitle}">
                   <span class="codicon codicon-edit"></span>
               </button>`
            : '';

        return `
            <div class="item-container">
                <label class="checkbox-item" id="label-${safeName}" title="${escapedTitleAttr}">
                    <input
                        type="checkbox"
                        id="chk-${safeName}"
                        name="${escapedNameAttr}"
                        data-default="${defaultState}">
                    <span class="checkbox-label-text">${name}</span>
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
            const noPhasesMessage = window.__loc?.noPhasesToDisplay || 'No phases to display.';
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
            let hasUnappliedChangesInGroup = false;

            if (Array.isArray(testsInPhase)) {
                testsInPhase.forEach(testInfo => {
                    if (testInfo && initialTestStates[testInfo.name] !== 'disabled') {
                        totalInPhase++;
                        if (currentCheckboxStates[testInfo.name]) {
                            enabledCount++;
                        }
                        const initialChecked = initialTestStates[testInfo.name] === 'checked';
                        const currentChecked = !!currentCheckboxStates[testInfo.name];
                        if (initialChecked !== currentChecked) {
                            hasUnappliedChangesInGroup = true;
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
                ? (window.__loc?.collapsePhaseTitle || 'Collapse phase')
                : (window.__loc?.expandPhaseTitle || 'Expand phase');

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
            countSpan.classList.toggle('group-changed', hasUnappliedChangesInGroup);

            const toggleCheckboxesBtn = document.createElement('button');
            toggleCheckboxesBtn.className = 'phase-toggle-checkboxes-btn button-with-icon';
            toggleCheckboxesBtn.title = window.__loc?.toggleAllInPhaseTitle || 'Toggle all tests in this phase';
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
            if (phaseExpandedState[phaseName]) {
                testsListDiv.classList.add('expanded');
            }

            if (Array.isArray(testsInPhase)) {
                if (testsInPhase.length === 0) {
                    const txt = window.__loc?.noTestsInPhase || 'No tests in this phase.';
                    testsListDiv.innerHTML = `<p class="no-tests-in-phase">${txt}</p>`;
                } else {
                    testsInPhase.forEach(info => { if (info?.name) testsListDiv.innerHTML += createCheckboxHtml(info); });
                }
            } else {
                const txt = window.__loc?.errorLoadingTests || 'Error loading tests.';
                testsListDiv.innerHTML = `<p style="color:var(--vscode-errorForeground);">${txt}</p>`;
            }

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
        });
        applyCheckboxStatesToVisible();
        log('Phase tree rendered.');
        updateAreAllPhasesExpandedState();
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

        phaseExpandedState[phaseName] = !phaseExpandedState[phaseName];
        testsList.classList.toggle('expanded');
        icon.classList.toggle('codicon-chevron-right', !phaseExpandedState[phaseName]);
        icon.classList.toggle('codicon-chevron-down', phaseExpandedState[phaseName]);
        button.setAttribute('aria-expanded', phaseExpandedState[phaseName] ? 'true' : 'false');
        button.title = phaseExpandedState[phaseName]
            ? (window.__loc?.collapsePhaseTitle || 'Collapse phase')
            : (window.__loc?.expandPhaseTitle || 'Expand phase');
        log(`Phase '${phaseName}' expanded state: ${phaseExpandedState[phaseName]}`);
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
            collapseAllBtn.title = window.__loc?.expandAllPhasesTitle || 'Expand all phases';
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
            ? (window.__loc?.collapseAllPhasesTitle || 'Collapse all phases')
            : (window.__loc?.expandAllPhasesTitle || 'Expand all phases');
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
            const name = cb.getAttribute('name');
            const label = cb.closest('.checkbox-item');
            if (!label || !name || !initialTestStates.hasOwnProperty(name) || initialTestStates[name] === 'disabled') {
                label?.classList.remove('changed');
                return;
            }
            const initialChecked = initialTestStates[name] === 'checked';
            const currentChecked = !!currentCheckboxStates[name];
            label.classList.toggle('changed', initialChecked !== currentChecked);
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

        const openButtons = phaseTreeContainer.querySelectorAll('.open-scenario-btn');
        openButtons.forEach(btn => {
            btn.removeEventListener('click', handleOpenScenarioClick);
            btn.addEventListener('click', handleOpenScenarioClick);
        });

        log(`Applied states to ${count} visible checkboxes.`);
        updateHighlighting();
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
            let hasUnappliedChangesInGroup = false;

            if (Array.isArray(testsInPhase)) {
                testsInPhase.forEach(testInfo => {
                    if (testInfo && initialTestStates[testInfo.name] !== 'disabled') {
                        totalInPhase++;
                        if (currentCheckboxStates[testInfo.name]) {
                            enabledCount++;
                        }
                        const initialChecked = initialTestStates[testInfo.name] === 'checked';
                        const currentChecked = !!currentCheckboxStates[testInfo.name];
                        if (initialChecked !== currentChecked) {
                            hasUnappliedChangesInGroup = true;
                        }
                    }
                });
            }
            const countElement = header.querySelector('.phase-test-count');
            if (countElement) {
                countElement.textContent = `${enabledCount}/${totalInPhase}`;
                countElement.classList.toggle('group-changed', hasUnappliedChangesInGroup);
            }
        });
    }


    /**
     * Обновляет статус-бар информацией о несохраненных изменениях.
     */
    function updatePendingStatus() {
        log('Updating pending status...');
        if (!(applyChangesBtn instanceof HTMLButtonElement)) return;

        let changed=0, enabled=0, disabled=0;
        for (const name in initialTestStates) {
            if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') {
                const initial = initialTestStates[name] === 'checked';
                const current = !!currentCheckboxStates[name];
                if (initial !== current) {
                    changed++;
                    if (current) { enabled++; } else { disabled++; }
                }
            }
        }

        const mainControlsActive = settings.switcherEnabled && !!testDataByPhase && Object.keys(testDataByPhase).length > 0;

        if (changed > 0) {
            const t = window.__loc || {};
            const parts = [
                (t.pendingTotalChanged || 'Total changed: {0}').replace('{0}', String(changed)),
                (t.pendingEnabled || 'Enabled: {0}').replace('{0}', String(enabled)),
                (t.pendingDisabled || 'Disabled: {0}').replace('{0}', String(disabled))
            ];
            const tail = t.pendingPressApply || 'Press "Apply"';
            updateStatus(`${parts.join(' \n')}\n\n${tail}`, 'main', mainControlsActive);
            applyChangesBtn.disabled = false;
        } else {
            if (!statusBar || !statusBar.textContent?.includes((window.__loc?.statusLoadingShort || 'Loading...')) && !statusBar.textContent?.includes((window.__loc?.statusApplyingPhaseChanges || 'Applying phase changes...'))) {
                updateStatus((window.__loc?.pendingNoChanges || 'No pending changes.'), 'main', mainControlsActive);
            }
            applyChangesBtn.disabled = true;
        }
        log(`Pending status: ${changed} changes. Apply btn disabled: ${applyChangesBtn.disabled}`);
        updateHighlighting();
        updatePhaseCounts();
        updateAreAllPhasesExpandedState();
    }

    // Обработчик сообщений от расширения
    window.addEventListener('message', event => {
        const message = event.data;
        log('Received message command: ' + message?.command);

        switch (message?.command) {
            case 'loadInitialState':
                if (assembleStatus instanceof HTMLElement) assembleStatus.textContent = '';

                if (message.error) {
                     updateStatus(`Ошибка: ${message.error}`, 'main', true);
                      phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = 'none'; });
                     if (assembleSection instanceof HTMLElement) assembleSection.style.display = 'none';
                     if (separator instanceof HTMLElement) separator.style.display = 'none';
                     enablePhaseControls(false, true); enableAssembleControls(false);
                     if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.disabled = false;
                } else {
                    testDataByPhase = message.tabData || {};
                    initialTestStates = message.states || {};
                    settings = message.settings || { assemblerEnabled: true, switcherEnabled: true };
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
                    const firstLaunchVisible = settings.firstLaunchFolderExists;
                    log(`Applying visibility based on settings: Switcher=${phaseSwitcherVisible}, Assembler=${assemblerVisible}, FirstLaunch=${firstLaunchVisible}`);

                    const switcherDisplay = phaseSwitcherVisible ? '' : 'none';
                    phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = switcherDisplay; });
                    
                    if (addScenarioDropdownBtn instanceof HTMLButtonElement) { // Управление видимостью новой кнопки
                        addScenarioDropdownBtn.style.display = phaseSwitcherVisible ? 'inline-flex' : 'none';
                    }
                    
                    if (createFirstLaunchBtn instanceof HTMLButtonElement) { // Управление видимостью кнопки первого запуска
                        createFirstLaunchBtn.style.display = firstLaunchVisible ? 'inline-flex' : 'none';
                        log(`  First Launch button display set to: ${createFirstLaunchBtn.style.display}`);
                    }


                    if (assembleSection instanceof HTMLElement) {
                        assembleSection.style.display = assemblerVisible ? 'block' : 'none';
                        log(`  Assemble section display set to: ${assembleSection.style.display}`);
                    } else { log("WARN: Assemble section not found!"); }

                    if (separator instanceof HTMLElement) {
                         separator.style.display = (phaseSwitcherVisible && assemblerVisible) ? 'block' : 'none';
                         log(`  Separator display set to: ${separator.style.display}`);
                    } else { log("WARN: Separator element not found!"); }

                    if (phaseSwitcherVisible) {
                        renderPhaseTree(testDataByPhase);
                    } else {
                        if(phaseTreeContainer instanceof HTMLElement) phaseTreeContainer.innerHTML = '<p>Phase Switcher отключен в настройках.</p>';
                         if (collapseAllBtn instanceof HTMLButtonElement) collapseAllBtn.disabled = true;
                    }

                    updatePendingStatus();
                    enablePhaseControls(phaseSwitcherVisible && !!testDataByPhase && Object.keys(testDataByPhase).length > 0, true);
                    enableAssembleControls(assemblerVisible);
                    if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.disabled = false;

                    const readyMessage = window.__loc?.readyToWork || 'Ready to work.';
                    if (isBuildInProgress) {
                        const buildMessage = window.__loc?.statusBuildingInProgress || 'Building tests in progress...';
                        updateStatus(buildMessage, 'main', false);
                        updateStatus(buildMessage, 'assemble', false);
                        enablePhaseControls(false, false);
                        enableAssembleControls(false);
                        if (applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true;
                    } else {
                        updateStatus(readyMessage, 'main', true);
                    }
                }
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
                    const buildMessage = window.__loc?.statusBuildingInProgress || 'Building tests in progress...';
                    updateStatus(buildMessage, 'main', false);
                    updateStatus(buildMessage, 'assemble', false);
                    enablePhaseControls(false, false);
                    enableAssembleControls(false);
                    if (applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true;
                } else {
                    const mainControlsShouldBeActive = settings.switcherEnabled && !!testDataByPhase && Object.keys(testDataByPhase).length > 0;
                    enablePhaseControls(mainControlsShouldBeActive, true);
                    enableAssembleControls(settings.assemblerEnabled);
                    updatePendingStatus();
                }
                break;
            }

            default:
                log(`Received unknown command: ${message?.command}`);
                break;
         }
    });

    if(applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.addEventListener('click', () => {
        log('Apply Phase Changes button clicked.');
        const statesToSend = { ...currentCheckboxStates };
        updateStatus(window.__loc?.statusApplyingPhaseChanges || 'Applying phase changes...', 'main', false);
        enablePhaseControls(false, false); enableAssembleControls(false);
        if(applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true;
        vscode.postMessage({ command: 'applyChanges', data: statesToSend });
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
    });

    if(refreshBtn instanceof HTMLButtonElement) refreshBtn.addEventListener('click', () => {
        log('Refresh button clicked.');
        vscode.postMessage({ command: 'refreshData' });
    });

    if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.addEventListener('click', () => {
        log('Open Settings button clicked.');
        vscode.postMessage({ command: 'openSettings' });
    });

    if (collapseAllBtn instanceof HTMLButtonElement) {
        collapseAllBtn.addEventListener('click', handleCollapseAllClick);
    }

    // Обработчики для новой кнопки и выпадающего меню
    if (addScenarioDropdownBtn && addScenarioDropdownContent) {
        addScenarioDropdownBtn.addEventListener('click', (event) => {
            event.stopPropagation(); // Предотвращаем закрытие при клике на кнопку
            const container = addScenarioDropdownBtn.closest('.dropdown-container');
            container?.classList.toggle('show');
            log('Add scenario dropdown toggled.');
        });

        if (createMainScenarioFromDropdownBtn) {
            createMainScenarioFromDropdownBtn.addEventListener('click', (event) => {
                event.preventDefault();
                log('Create Main Scenario from dropdown clicked.');
                vscode.postMessage({ command: 'createMainScenario' });
                addScenarioDropdownBtn.closest('.dropdown-container')?.classList.remove('show');
            });
        }

        if (createNestedScenarioFromDropdownBtn) {
            createNestedScenarioFromDropdownBtn.addEventListener('click', (event) => {
                event.preventDefault();
                log('Create Nested Scenario from dropdown clicked.');
                vscode.postMessage({ command: 'createNestedScenario' });
                addScenarioDropdownBtn.closest('.dropdown-container')?.classList.remove('show');
            });
        }
    }
    // Закрытие выпадающего списка при клике вне его
    window.addEventListener('click', (event) => {
        if (addScenarioDropdownBtn && addScenarioDropdownContent) {
            const container = addScenarioDropdownBtn.closest('.dropdown-container');
            if (container && !container.contains(event.target)) {
                container.classList.remove('show');
            }
        }
    });


    if(assembleBtn instanceof HTMLButtonElement) {
        assembleBtn.addEventListener('click', () => {
            log('Assemble tests button clicked.');
            const recordGLValue = (recordGLSelect instanceof HTMLSelectElement) ? recordGLSelect.value : '0';
            updateStatus(window.__loc?.statusStartingAssembly || 'Starting assembly...', 'assemble', false);
            enablePhaseControls(false, false);
            enableAssembleControls(false);
            vscode.postMessage({
                command: 'runAssembleScript',
                params: { recordGL: recordGLValue }
            });
        });
    }

    function requestInitialState() {
        log('Requesting initial state...');
        updateStatus('Запрос данных...', 'main', false);
        enablePhaseControls(false, false);
        enableAssembleControls(false);
        if (applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true;
        vscode.postMessage({ command: 'getInitialState' });
    }

    log('Webview script initialized.');
    updateStatus('Загрузка...', 'main', false);
    enablePhaseControls(false, false);
    enableAssembleControls(false);
    if (applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true;
    requestInitialState();

    if(createFirstLaunchBtn instanceof HTMLButtonElement) {
        createFirstLaunchBtn.addEventListener('click', () => {
            log('Create FirstLaunch.zip button clicked.');
            vscode.postMessage({ command: 'createFirstLaunchZip' });
        });
    }

    // Обработчик для кнопки YAML параметров
    const openYamlParamsBtn = document.getElementById('openYamlParamsBtn');
    if(openYamlParamsBtn instanceof HTMLButtonElement) {
        openYamlParamsBtn.addEventListener('click', () => {
            log('Open Build Scenario Parameters Manager button clicked.');
            vscode.postMessage({ command: 'openYamlParametersManager' });
        });
    }
}());
