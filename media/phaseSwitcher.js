// Файл: media/phaseSwitcher.js
// Скрипт для управления интерфейсом Webview панели 1C:Drive Test Helper

(function() {
    const vscode = acquireVsCodeApi();

    // === Глобальные переменные состояния ===
    let testDataByPhase = {};
    let initialTestStates = {};
    let currentCheckboxStates = {};
    let testDefaultStates = {};
    let phaseExpandedState = {}; // Состояние раскрытия для каждой фазы
    let settings = {
        assemblerEnabled: true,
        switcherEnabled: true
    };
    let areAllPhasesCurrentlyExpanded = false; // Для отслеживания состояния всех групп

    // === Получение ссылок на элементы DOM ===
    const refreshBtn = document.getElementById('refreshBtn');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const collapseAllBtn = document.getElementById('collapseAllBtn'); // Новая кнопка

    const phaseSwitcherSectionElements = document.querySelectorAll('.phase-switcher-section');
    const phaseTreeContainer = document.getElementById('phaseTreeContainer');

    const statusBar = document.getElementById('statusBar');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const selectDefaultsBtn = document.getElementById('selectDefaultsBtn');
    const applyChangesBtn = document.getElementById('applyChangesBtn');

    const recordGLSelect = document.getElementById('recordGLSelect');
    const driveTradeChk = document.getElementById('driveTradeChk');
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
        if (refreshButtonEnabled !== undefined && refreshBtn instanceof HTMLButtonElement) {
            refreshBtn.disabled = !refreshButtonEnabled;
        }
        // Обновляем состояние кнопки Свернуть/Развернуть все
        if (collapseAllBtn instanceof HTMLButtonElement) {
            // Кнопка "Свернуть/Развернуть все" должна быть активна, если активна кнопка "Обновить"
            // и если есть фазы для сворачивания/разворачивания.
            const hasPhases = Object.keys(testDataByPhase).length > 0;
            collapseAllBtn.disabled = !(refreshButtonEnabled && hasPhases && settings.switcherEnabled);
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
        const effectiveEnable = enable && isPhaseSwitcherVisible;
        const isDisabled = !effectiveEnable;

        if (selectAllBtn instanceof HTMLButtonElement) selectAllBtn.disabled = isDisabled;
        if (selectDefaultsBtn instanceof HTMLButtonElement) selectDefaultsBtn.disabled = isDisabled;

        // Управление кнопкой "Свернуть/Развернуть все"
        if (collapseAllBtn instanceof HTMLButtonElement) {
            const hasPhases = Object.keys(testDataByPhase).length > 0;
            collapseAllBtn.disabled = isDisabled || !hasPhases;
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
        if (refreshButtonAlso && refreshBtn instanceof HTMLButtonElement) {
             refreshBtn.disabled = isDisabled;
        }
        log(`Phase controls (excluding Apply, Settings) enabled: ${effectiveEnable} (request ${enable}, feature ${isPhaseSwitcherVisible})`);
    }

    /**
     * Включает или отключает элементы управления сборкой тестов.
     * @param {boolean} enable - True для включения, false для отключения.
     */
     function enableAssembleControls(enable) {
         const isAssemblerVisible = settings.assemblerEnabled;
         const effectiveEnable = enable && isAssemblerVisible;

         if (assembleBtn instanceof HTMLButtonElement) assembleBtn.disabled = !effectiveEnable;
         if (recordGLSelect instanceof HTMLSelectElement) recordGLSelect.disabled = !effectiveEnable;
         if (driveTradeChk instanceof HTMLInputElement) driveTradeChk.disabled = !effectiveEnable;
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
             return '<p style="color:var(--vscode-errorForeground);">Ошибка данных чекбокса</p>';
        }
        const name = testInfo.name;
        const relativePath = testInfo.relativePath || '';
        const defaultState = !!testInfo.defaultState;
        const safeName = name.replace(/[^a-zA-Z0-9_\\-]/g, '_'); // Для ID
        const escapedNameAttr = escapeHtmlAttr(name);
        const escapedTitleAttr = escapeHtmlAttr(relativePath);
        const fileUriString = testInfo.yamlFileUriString || ''; // Предполагается, что это строка URI
        const escapedIconTitle = escapeHtmlAttr(`Открыть файл сценария ${name}`);

        // Кнопка открытия файла сценария
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
        phaseTreeContainer.innerHTML = ''; // Очищаем контейнер

        const sortedPhaseNames = Object.keys(allPhaseData).sort();

        if (sortedPhaseNames.length === 0) {
            phaseTreeContainer.innerHTML = '<p>Нет фаз для отображения.</p>';
            if (collapseAllBtn instanceof HTMLButtonElement) collapseAllBtn.disabled = true;
            return;
        } else {
             // Включаем кнопку, если есть фазы и Phase Switcher включен
             if (collapseAllBtn instanceof HTMLButtonElement) {
                collapseAllBtn.disabled = !settings.switcherEnabled;
            }
        }


        // Инициализируем или сохраняем состояние раскрытия для каждой фазы
        const newPhaseExpandedState = {};
        sortedPhaseNames.forEach(phaseName => {
            if (phaseExpandedState.hasOwnProperty(phaseName)) {
                newPhaseExpandedState[phaseName] = phaseExpandedState[phaseName];
            } else {
                // По умолчанию все свернуты
                newPhaseExpandedState[phaseName] = false;
            }
        });
        phaseExpandedState = newPhaseExpandedState;
        updateAreAllPhasesExpandedState(); // Обновляем состояние кнопки "Свернуть/Развернуть все"

        sortedPhaseNames.forEach(phaseName => {
            const testsInPhase = allPhaseData[phaseName];
            // Создание уникальных ID
            const phaseGroupId = 'phase-group-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
            const phaseHeaderId = 'phase-header-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
            const testsListId = 'tests-list-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');

            // Подсчет включенных/всего тестов в фазе
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
            phaseHeaderDiv.dataset.phaseName = phaseName; // Сохраняем имя фазы

            // Кнопка для сворачивания/разворачивания
            const expandCollapseButton = document.createElement('button');
            expandCollapseButton.className = 'phase-expand-collapse-btn button-with-icon';
            expandCollapseButton.setAttribute('role', 'button');
            expandCollapseButton.setAttribute('tabindex', '0'); // Для доступности
            expandCollapseButton.setAttribute('aria-expanded', phaseExpandedState[phaseName] ? 'true' : 'false');
            expandCollapseButton.setAttribute('aria-controls', testsListId);
            expandCollapseButton.title = phaseExpandedState[phaseName] ? "Свернуть фазу" : "Развернуть фазу";

            const iconSpan = document.createElement('span');
            iconSpan.className = `codicon phase-toggle-icon ${phaseExpandedState[phaseName] ? 'codicon-chevron-down' : 'codicon-chevron-right'}`;
            expandCollapseButton.appendChild(iconSpan);

            const titleSpan = document.createElement('span');
            titleSpan.className = 'phase-title';
            titleSpan.textContent = phaseName;
            expandCollapseButton.appendChild(titleSpan); // Добавляем название фазы в кнопку

            // Счетчик тестов
            const countSpan = document.createElement('span');
            countSpan.className = 'phase-test-count';
            countSpan.textContent = `${enabledCount}/${totalInPhase}`;

            // Кнопка для переключения всех чекбоксов в фазе
            const toggleCheckboxesBtn = document.createElement('button');
            toggleCheckboxesBtn.className = 'phase-toggle-checkboxes-btn button-with-icon';
            toggleCheckboxesBtn.title = 'Переключить все тесты в этой фазе';
            toggleCheckboxesBtn.dataset.phaseName = phaseName;
            const toggleIcon = document.createElement('span');
            toggleIcon.className = 'codicon codicon-check-all'; // Иконка для переключения чекбоксов
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
                    testsListDiv.innerHTML = '<p class="no-tests-in-phase">Нет тестов в этой фазе.</p>';
                } else {
                    testsInPhase.forEach(info => { if (info?.name) testsListDiv.innerHTML += createCheckboxHtml(info); });
                }
            } else {
                testsListDiv.innerHTML = '<p style="color:var(--vscode-errorForeground);">Ошибка загрузки тестов.</p>';
            }

            phaseGroupDiv.appendChild(phaseHeaderDiv);
            phaseGroupDiv.appendChild(testsListDiv);
            phaseTreeContainer.appendChild(phaseGroupDiv);

            // Добавляем обработчики событий
            expandCollapseButton.addEventListener('click', handlePhaseHeaderClick);
            expandCollapseButton.addEventListener('keydown', (event) => { // Для доступности с клавиатуры
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handlePhaseHeaderClick(event);
                }
            });
            toggleCheckboxesBtn.addEventListener('click', handleTogglePhaseCheckboxesClick);
        });
        applyCheckboxStatesToVisible(); // Применяем состояния к созданным чекбоксам
        log('Phase tree rendered.');
        updateAreAllPhasesExpandedState();
    }

    /**
     * Обрабатывает клик по заголовку фазы для сворачивания/разворачивания.
     * @param {Event} event - Событие клика.
     */
    function handlePhaseHeaderClick(event) {
        const button = event.currentTarget; // Теперь это кнопка
        if (!(button instanceof HTMLElement)) return;
        const phaseHeader = button.closest('.phase-header');
        if (!phaseHeader || !(phaseHeader instanceof HTMLElement)) return;

        const phaseName = phaseHeader.dataset.phaseName;
        if (!phaseName) return;

        const testsListId = 'tests-list-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        const testsList = document.getElementById(testsListId);
        const icon = button.querySelector('.phase-toggle-icon'); // Иконка внутри кнопки

        if (!testsList || !icon) return;

        phaseExpandedState[phaseName] = !phaseExpandedState[phaseName]; // Инвертируем состояние
        testsList.classList.toggle('expanded');
        icon.classList.toggle('codicon-chevron-right', !phaseExpandedState[phaseName]);
        icon.classList.toggle('codicon-chevron-down', phaseExpandedState[phaseName]);
        button.setAttribute('aria-expanded', phaseExpandedState[phaseName] ? 'true' : 'false');
        button.title = phaseExpandedState[phaseName] ? "Свернуть фазу" : "Развернуть фазу";
        log(`Phase '${phaseName}' expanded state: ${phaseExpandedState[phaseName]}`);
        updateAreAllPhasesExpandedState(); // Обновляем состояние общей кнопки
    }

    /**
     * Обработчик клика по кнопке переключения всех чекбоксов внутри фазы.
     * @param {MouseEvent} event
     */
    function handleTogglePhaseCheckboxesClick(event) {
        const button = event.currentTarget;
        if (!(button instanceof HTMLButtonElement)) return;
        event.stopPropagation(); // Предотвращаем всплытие до заголовка фазы

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

        // Определяем, нужно ли отметить все или снять все
        let shouldCheckAll = false;
        for (const cb of checkboxesInPhase) {
            if (cb instanceof HTMLInputElement && !cb.checked) {
                shouldCheckAll = true; // Если хотя бы один не отмечен, то отмечаем все
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

        updatePendingStatus(); // Обновляем статус изменений
        updateHighlighting(); // Обновляем подсветку
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
            collapseAllBtn.title = "Развернуть все фазы";
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
        collapseAllBtn.title = areAllPhasesCurrentlyExpanded ? "Свернуть все фазы" : "Развернуть все фазы";
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
                    button.click(); // Имитируем клик для переключения
                }
            }
        });
        updateAreAllPhasesExpandedState(); // Обновляем состояние кнопки в конце
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
                label?.classList.remove('changed'); // Убираем подсветку, если элемент неактивен или нет данных
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
        if (!(button instanceof HTMLButtonElement)) return; // Убедимся, что это кнопка

        event.preventDefault(); // Предотвращаем стандартное действие (если есть)
        event.stopPropagation(); // Останавливаем всплытие, чтобы не сработал клик по label
        const name = button.getAttribute('data-name'); // Получаем имя из data-атрибута
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
            const label = cb.closest('.checkbox-item'); // Находим родительский label
            cb.removeEventListener('change', handleCheckboxChange); // Удаляем старый обработчик

            if (name && initialTestStates.hasOwnProperty(name)) { // Проверяем, что имя есть и для него есть начальное состояние
                count++;
                const initialState = initialTestStates[name]; // 'checked', 'unchecked', или 'disabled'
                cb.disabled = (initialState === 'disabled'); // Отключаем, если начальное состояние 'disabled'
                cb.checked = !!currentCheckboxStates[name]; // Устанавливаем текущее состояние
                if(label) {
                    label.classList.toggle('disabled', cb.disabled); // Добавляем/удаляем класс disabled для стилизации
                    label.classList.remove('changed'); // Убираем подсветку изменений при перерисовке
                }
                if (!cb.disabled) { // Добавляем обработчик только если чекбокс не отключен
                    cb.addEventListener('change', handleCheckboxChange);
                }
            } else if (name) { // Если имя есть, но нет начального состояния (не должно быть, но на всякий случай)
                cb.disabled = true; // Отключаем
                if(label) label.classList.add('disabled');
            } else { // Если у чекбокса вообще нет имени
                log("ERROR: Checkbox found with NO NAME attribute!");
            }
        });

        // Переназначаем обработчики для кнопок открытия сценариев
        const openButtons = phaseTreeContainer.querySelectorAll('.open-scenario-btn');
        openButtons.forEach(btn => {
            btn.removeEventListener('click', handleOpenScenarioClick); // Удаляем старый
            btn.addEventListener('click', handleOpenScenarioClick); // Добавляем новый
        });

        log(`Applied states to ${count} visible checkboxes.`);
        updateHighlighting(); // Обновляем подсветку измененных
        updateAreAllPhasesExpandedState();
    }

    /**
     * Обновляет текущее состояние чекбокса в `currentCheckboxStates`.
     * @param {string} name - Имя теста.
     * @param {boolean} isChecked - Новое состояние чекбокса.
     */
    function updateCurrentState(name, isChecked) {
        // Обновляем только если тест не был изначально 'disabled'
        if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') {
            currentCheckboxStates[name] = !!isChecked; // Приводим к boolean
        }
    }

    /**
     * Обрабатывает изменение состояния чекбокса.
     * @param {Event} event - Событие изменения.
     */
    function handleCheckboxChange(event) {
        if(!(event.target instanceof HTMLInputElement)) return; // Убедимся, что это input
        const name = event.target.name; // Имя теста
        const isChecked = event.target.checked; // Новое состояние
        log(`Checkbox changed: ${name} = ${isChecked}`);
        updateCurrentState(name, isChecked); // Обновляем внутреннее состояние
        updatePendingStatus(); // Обновляем статус о наличии несохраненных изменений
        updateHighlighting(); // Обновляем подсветку
    }

    /**
     * Обновляет счетчики тестов для каждой фазы.
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
                    // Считаем только активные (не 'disabled') тесты
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
            }
        });
    }

    /**
     * Обновляет статус-бар информацией о несохраненных изменениях.
     */
    function updatePendingStatus() {
        log('Updating pending status...');
        if (!(applyChangesBtn instanceof HTMLButtonElement)) return; // Проверяем, что кнопка существует

        let changed=0, enabled=0, disabled=0; // Счетчик изменений
        // Сравниваем текущие состояния с начальными
        for (const name in initialTestStates) {
            if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') { // Учитываем только активные тесты
                const initial = initialTestStates[name] === 'checked'; // Начальное состояние (boolean)
                const current = !!currentCheckboxStates[name]; // Текущее состояние (boolean)
                if (initial !== current) { // Если состояние изменилось
                    changed++;
                    if (current) { enabled++; } else { disabled++; }
                }
            }
        }

        const mainControlsActive = settings.switcherEnabled && !!testDataByPhase && Object.keys(testDataByPhase).length > 0;

        if (changed > 0) { // Если есть изменения
            updateStatus(`Всего изменено: ${changed} \nВключено тестов: ${enabled} \nВыключено тестов: ${disabled}\n\nНажмите "Применить"`, 'main', mainControlsActive);
            applyChangesBtn.disabled = false; // Включаем кнопку "Применить"
        } else { // Если изменений нет
            // Не перезаписываем статус, если идет загрузка или применение
            if (!statusBar || !statusBar.textContent?.includes('Загрузка') && !statusBar.textContent?.includes('Применение')) {
                updateStatus('Нет несохраненных изменений.', 'main', mainControlsActive);
            }
            applyChangesBtn.disabled = true; // Отключаем кнопку "Применить"
        }
        log(`Pending status: ${changed} changes. Apply btn disabled: ${applyChangesBtn.disabled}`);
        updateHighlighting(); // Обновляем подсветку
        updatePhaseCounts(); // Обновляем счетчики фаз
        updateAreAllPhasesExpandedState();
    }

    // Обработчик сообщений от расширения
    window.addEventListener('message', event => {
        const message = event.data; // Сообщение от расширения
        log('Received message command: ' + message?.command);

        switch (message?.command) {
            case 'loadInitialState':
                if (assembleStatus instanceof HTMLElement) assembleStatus.textContent = ''; // Очищаем статус сборки

                if (message.error) { // Если пришла ошибка
                     updateStatus(`Ошибка: ${message.error}`, 'main', true);
                      // Скрываем секции, если ошибка
                      phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = 'none'; });
                     if (assembleSection instanceof HTMLElement) assembleSection.style.display = 'none';
                     if (separator instanceof HTMLElement) separator.style.display = 'none';
                     enablePhaseControls(false, true); enableAssembleControls(false);
                     if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.disabled = false; // Кнопка настроек всегда доступна
                } else { // Если данные загружены успешно
                    testDataByPhase = message.tabData || {};
                    initialTestStates = message.states || {};
                    settings = message.settings || { assemblerEnabled: true, switcherEnabled: true };
                    log("Received settings in webview:");
                    console.log(settings); // Логируем полученные настройки

                    // Сбрасываем и инициализируем состояния
                    currentCheckboxStates = {}; testDefaultStates = {};
                    // Инициализируем phaseExpandedState, если он еще не инициализирован
                    if (Object.keys(phaseExpandedState).length === 0 && testDataByPhase) {
                        Object.keys(testDataByPhase).forEach(phaseName => {
                            phaseExpandedState[phaseName] = false; // Все свернуты по умолчанию
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
                                    testDefaultStates[name] = !!info.defaultState; // Сохраняем состояние по умолчанию
                                }
                            });
                        }
                    });

                    log("State caches initialized.");

                    // Применяем видимость секций на основе настроек
                    const phaseSwitcherVisible = settings.switcherEnabled;
                    const assemblerVisible = settings.assemblerEnabled;
                    log(`Applying visibility based on settings: Switcher=${phaseSwitcherVisible}, Assembler=${assemblerVisible}`);

                    const switcherDisplay = phaseSwitcherVisible ? '' : 'none';
                    phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = switcherDisplay; });

                    if (assembleSection instanceof HTMLElement) {
                        assembleSection.style.display = assemblerVisible ? 'block' : 'none';
                        log(`  Assemble section display set to: ${assembleSection.style.display}`);
                    } else { log("WARN: Assemble section not found!"); }

                    if (separator instanceof HTMLElement) {
                         separator.style.display = (phaseSwitcherVisible && assemblerVisible) ? 'block' : 'none';
                         log(`  Separator display set to: ${separator.style.display}`);
                    } else { log("WARN: Separator element not found!"); }

                    if (phaseSwitcherVisible) {
                        renderPhaseTree(testDataByPhase); // Отрисовываем дерево
                    } else { // Если Phase Switcher отключен
                        if(phaseTreeContainer instanceof HTMLElement) phaseTreeContainer.innerHTML = '<p>Phase Switcher отключен в настройках.</p>';
                         if (collapseAllBtn instanceof HTMLButtonElement) collapseAllBtn.disabled = true;
                    }

                    updatePendingStatus(); // Обновляем статус о несохраненных изменениях
                    // Включаем/отключаем контролы на основе видимости и наличия данных
                    enablePhaseControls(phaseSwitcherVisible && !!testDataByPhase && Object.keys(testDataByPhase).length > 0, true);
                    enableAssembleControls(assemblerVisible);
                    if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.disabled = false; // Кнопка настроек

                    updateStatus('Готово к работе.', 'main', true); // Обновляем статус
                }
                break;

             case 'updateStatus': // Обновление статуса из расширения
                 const target = message.target || 'main'; // main или assemble
                 const controlsEnabled = message.enableControls === undefined ? undefined : message.enableControls;
                 let refreshEnabled = message.refreshButtonEnabled;

                 // Если состояние кнопки Обновить не передано, определяем его на основе controlsEnabled
                 // или оставляем текущее, если controlsEnabled тоже не передано
                 if (refreshEnabled === undefined) {
                     refreshEnabled = controlsEnabled === undefined ? (refreshBtn ? !refreshBtn.disabled : true) : controlsEnabled;
                 }

                 updateStatus(message.text, target, refreshEnabled); // Обновляем текст и кнопку Обновить

                 if (controlsEnabled !== undefined) { // Если передано состояние для контролов
                     enablePhaseControls(controlsEnabled && settings.switcherEnabled, refreshEnabled); // Управляем контролами Phase Switcher
                     enableAssembleControls(controlsEnabled && settings.assemblerEnabled); // Управляем контролами сборки
                 }
                 break;

            case 'setRefreshButtonState': // Явное управление состоянием кнопки Обновить
                if (refreshBtn instanceof HTMLButtonElement) {
                    refreshBtn.disabled = !message.enabled;
                    log(`External: Refresh button state set to enabled: ${message.enabled}`);
                }
                break;

            default:
                log(`Received unknown command: ${message?.command}`);
                break;
         }
    });

    // Обработчик кнопки "Применить"
    if(applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.addEventListener('click', () => {
        log('Apply Phase Changes button clicked.');
        const statesToSend = { ...currentCheckboxStates }; // Копируем текущие состояния для отправки
        updateStatus('Применение изменений фаз...', 'main', false); // Обновляем статус, отключаем кнопку Обновить
        enablePhaseControls(false, false); enableAssembleControls(false); // Отключаем все контролы
        if(applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true; // Отключаем саму кнопку
        vscode.postMessage({ command: 'applyChanges', states: statesToSend });
    });

    // Обработчик кнопки "Переключить все" (чекбоксы)
    if(selectAllBtn instanceof HTMLButtonElement) selectAllBtn.addEventListener('click', () => {
        log('Toggle ALL clicked.');
        const keys = Object.keys(initialTestStates).filter(n => initialTestStates[n] !== 'disabled'); // Получаем ключи активных тестов
        if(keys.length === 0) return; // Если нет активных тестов, ничего не делаем
        // Определяем, нужно ли отметить все или снять все
        let check = false;
        for(const name of keys){ if(!currentCheckboxStates[name]) { check = true; break; } } // Если хотя бы один не отмечен, то отмечаем все
        log(`New state for ALL enabled will be: ${check}`);
        keys.forEach(name => { currentCheckboxStates[name] = check; }); // Устанавливаем новое состояние для всех
        applyCheckboxStatesToVisible(); // Применяем к видимым чекбоксам
        updatePendingStatus(); // Обновляем статус изменений
    });


    // Обработчик кнопки "По умолчанию"
    if(selectDefaultsBtn instanceof HTMLButtonElement) selectDefaultsBtn.addEventListener('click', () => {
        log('Select Defaults for ALL clicked.');
        for (const name in initialTestStates) {
            if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') {
                const defaultState = !!testDefaultStates[name]; // Получаем состояние по умолчанию
                currentCheckboxStates[name] = defaultState; // Устанавливаем его как текущее
            }
        }
        applyCheckboxStatesToVisible(); // Применяем к видимым чекбоксам
        updatePendingStatus(); // Обновляем статус изменений
        const mainControlsShouldBeActive = settings.switcherEnabled && !!testDataByPhase && Object.keys(testDataByPhase).length > 0;
        enablePhaseControls(mainControlsShouldBeActive, true); // Включаем контролы
    });

    // Обработчик кнопки "Обновить"
    if(refreshBtn instanceof HTMLButtonElement) refreshBtn.addEventListener('click', () => {
        log('Refresh button clicked.');
        requestInitialState(); // Запрашиваем начальное состояние
    });

    // Обработчик кнопки "Открыть настройки"
    if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.addEventListener('click', () => {
        log('Open Settings button clicked.');
        vscode.postMessage({ command: 'openSettings' }); // Отправляем команду в расширение
    });

    // Обработчик для новой кнопки "Свернуть/Развернуть все"
    if (collapseAllBtn instanceof HTMLButtonElement) {
        collapseAllBtn.addEventListener('click', handleCollapseAllClick);
    }

    // Обработчик кнопки "Собрать тесты"
    if(assembleBtn instanceof HTMLButtonElement) {
        assembleBtn.addEventListener('click', () => {
            log('Assemble tests button clicked.');
            const recordGLValue = (recordGLSelect instanceof HTMLSelectElement) ? recordGLSelect.value : '0';
            const driveTradeValue = (driveTradeChk instanceof HTMLInputElement) && driveTradeChk.checked ? '1' : '0';
            updateStatus('Запуск сборки...', 'assemble', false); // Обновляем статус сборки, отключаем кнопку Обновить
            enablePhaseControls(false, false); // Отключаем контролы Phase Switcher
            enableAssembleControls(false); // Отключаем контролы сборки
            vscode.postMessage({
                command: 'runAssembleScript',
                params: { recordGL: recordGLValue, driveTrade: driveTradeValue }
            });
        });
    }

    /**
     * Запрашивает начальное состояние у расширения.
     */
    function requestInitialState() {
        log('Requesting initial state...');
        updateStatus('Запрос данных...', 'main', false); // Обновляем статус, отключаем кнопку Обновить
        enablePhaseControls(false, false); // Отключаем контролы Phase Switcher
        enableAssembleControls(false); // Отключаем контролы сборки
        if (applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true; // Отключаем кнопку "Применить"
        vscode.postMessage({ command: 'getInitialState' });
    }

    // Инициализация при загрузке webview
    log('Webview script initialized.');
    updateStatus('Загрузка...', 'main', false); // Начальный статус, кнопка Обновить отключена
    enablePhaseControls(false, false); // Контролы Phase Switcher отключены
    enableAssembleControls(false); // Контролы сборки отключены
    if (applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true; // Кнопка "Применить" отключена
    requestInitialState(); // Запрашиваем начальное состояние

}());
