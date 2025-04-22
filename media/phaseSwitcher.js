// Файл: media/phaseSwitcher.js
// Скрипт для управления интерфейсом Webview панели 1C:Drive Test Helper

(function() { // Используем IIFE для изоляции области видимости и предотвращения конфликтов
    // Получаем API VS Code для взаимодействия с расширением
    // @ts-ignore - VS Code инжектирует эту функцию во время выполнения
    const vscode = acquireVsCodeApi();

    // === Глобальные переменные состояния ===
    let testDataByPhase = {}; // Объект для хранения информации о тестах, сгруппированных по фазам { phaseName: [TestInfo...] }
    let initialTestStates = {}; // Объект для хранения исходного состояния чекбоксов (с диска) { testName: 'checked'|'unchecked'|'disabled' }
    let currentCheckboxStates = {}; // Объект для хранения ТЕКУЩЕГО состояния активных чекбоксов { testName: boolean }
    let testDefaultStates = {}; // Кэш состояний по умолчанию для каждого теста { testName: boolean }
    let currentPhase = null; // Имя текущей выбранной (отображаемой) фазы
    let settings = { // Настройки видимости секций, получаемые из расширения
        assemblerEnabled: true,
        switcherEnabled: true
    };

    // === Получение ссылок на элементы DOM ===
    // Общие элементы
    const refreshBtn = document.getElementById('refreshBtn'); // Кнопка "Обновить"
    const openSettingsBtn = document.getElementById('openSettingsBtn'); // Кнопка "Открыть настройки"
    // Элементы секции Phase Switcher
    const phaseSwitcherSectionElements = document.querySelectorAll('.phase-switcher-section'); // Все элементы секции переключателя фаз
    const phaseSelector = document.getElementById('phaseSelector'); // Выпадающий список фаз
    const checkboxContainer = document.getElementById('checkbox-container'); // Контейнер для чекбоксов
    const statusBar = document.getElementById('statusBar'); // Основная строка статуса (для Phase Switcher)
    const selectAllBtn = document.getElementById('selectAllBtn'); // Кнопка "Переключить все"
    const selectVisibleBtn = document.getElementById('selectVisibleBtn'); // Кнопка "Переключить фазу"
    const selectDefaultsBtn = document.getElementById('selectDefaultsBtn'); // Кнопка "По умолчанию"
    const applyChangesBtn = document.getElementById('applyChangesBtn'); // Кнопка "Применить изменения"
    // Элементы секции Сборка Тестов
    const recordGLSelect = document.getElementById('recordGLSelect'); // Выпадающий список Record GL
    const driveTradeChk = document.getElementById('driveTradeChk'); // Чекбокс DriveTrade
    const assembleBtn = document.getElementById('assembleTestsBtn'); // Кнопка "Собрать тесты"
    const assembleStatus = document.getElementById('assembleStatus'); // Строка статуса для сборки
    const assembleSection = document.getElementById('assembleSection'); // Секция сборки тестов
    const separator = document.getElementById('sectionSeparator'); // Разделитель между секциями
    // Элементы управления паролем были удалены

    // === Утилиты ===

    /**
     * Логирует сообщение в консоль Webview и отправляет его в Extension Host.
     * @param {string} message - Сообщение для логирования.
     */
    function log(message) {
        console.log("[Webview]", message);
        // Отправляем сообщение в Extension Host для логирования там
        vscode.postMessage({ command: 'log', text: "[Webview] " + message });
    }

    /**
     * Обновляет текстовое содержимое строки статуса.
     * @param {string} text - Текст для отображения.
     * @param {'main' | 'assemble'} [target='main'] - Целевая область статуса ('main' для Phase Switcher, 'assemble' для сборки).
     */
    function updateStatus(text, target = 'main') {
        let area = statusBar; // По умолчанию используем основную строку статуса
        if (target === 'assemble' && assembleStatus) {
            area = assembleStatus; // Используем строку статуса сборки, если указано
        }
        // Область статуса для пароля была удалена

        if (area instanceof HTMLElement) { // Проверяем, что элемент найден и является HTMLElement
            area.textContent = text; // Устанавливаем текст
        }
        log(`Status updated [${target}]: ${text}`); // Логируем обновление статуса
    }

    /**
     * Включает или выключает элементы управления в секции Phase Switcher.
     * Учитывает глобальную настройку видимости секции.
     * @param {boolean} enable - true для включения, false для выключения.
     */
    function enablePhaseControls(enable) {
        const isPhaseSwitcherVisible = settings.switcherEnabled; // Видима ли секция согласно настройкам
        const effectiveEnable = enable && isPhaseSwitcherVisible; // Элементы активны, только если запрошено И секция видима
        const isDisabled = !effectiveEnable; // Флаг для установки атрибута disabled

        // Находим все кнопки управления фазами (кроме "Применить")
        const phaseButtons = document.querySelectorAll('.phase-switcher-controls button:not(#applyChangesBtn)');
        phaseButtons.forEach(btn => { if (btn instanceof HTMLButtonElement) btn.disabled = isDisabled; }); // Устанавливаем disabled

        if (phaseSelector instanceof HTMLSelectElement) { phaseSelector.disabled = isDisabled; } // Блокируем/разблокируем выпадающий список
    
        if (checkboxContainer) {
            const checkboxes = checkboxContainer.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                if (cb instanceof HTMLInputElement) {
                    const isInitiallyDisabled = initialTestStates[cb.name] === 'disabled';
                    cb.disabled = isDisabled || isInitiallyDisabled;
                    cb.closest('.checkbox-item')?.classList.toggle('globally-disabled', isDisabled && !isInitiallyDisabled);
                }
            });
            // Блокируем/разблокируем кнопки открытия сценариев
        }

        // Кнопки "Обновить" и "Настройки" не блокируются здесь, они управляются отдельно
        log(`Phase controls (excluding Apply, Refresh, Settings) enabled: ${effectiveEnable} (request ${enable}, feature ${isPhaseSwitcherVisible})`);
    }

     /**
      * Включает или выключает элементы управления в секции Сборка Тестов.
      * Учитывает глобальную настройку видимости секции.
      * @param {boolean} enable - true для включения, false для выключения.
      */
     function enableAssembleControls(enable) {
         const isAssemblerVisible = settings.assemblerEnabled; // Видима ли секция согласно настройкам
         const effectiveEnable = enable && isAssemblerVisible; // Элементы активны, только если запрошено И секция видима

         if (assembleBtn instanceof HTMLButtonElement) assembleBtn.disabled = !effectiveEnable; // Кнопка "Собрать тесты"
         if (recordGLSelect instanceof HTMLSelectElement) recordGLSelect.disabled = !effectiveEnable; // Выбор Record GL
         if (driveTradeChk instanceof HTMLInputElement) driveTradeChk.disabled = !effectiveEnable; // Чекбокс DriveTrade
         // Элементы управления паролем были удалены

         log(`Assemble controls enabled: ${effectiveEnable} (request ${enable}, feature ${isAssemblerVisible})`);
     }

    /**
     * Экранирует специальные символы HTML для безопасного использования в атрибутах.
     * @param {string | any} unsafe - Строка или значение для экранирования.
     * @returns {string} Экранированная строка.
     */
     function escapeHtmlAttr(unsafe) {
         // Пытаемся преобразовать в строку, если это не строка
         if (typeof unsafe !== 'string') { try { unsafe = String(unsafe); } catch { return ''; } }
         // Заменяем специальные символы на их HTML-сущности
         return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
     }

    // === Генерация HTML ===
    /**
     * Создает HTML-разметку для одного чекбокса теста.
     * @param {object} testInfo - Информация о тесте (name, relativePath, defaultState, yamlFileUriString).
     * @returns {string} HTML-строка для чекбокса.
     */
    function createCheckboxHtml(testInfo) {
        // Проверка на валидность входных данных
        if (!testInfo || typeof testInfo.name !== 'string' || !testInfo.name) {
             log("ERROR: Invalid testInfo in createCheckboxHtml!");
             return '<p style="color:var(--vscode-errorForeground);">Ошибка данных чекбокса</p>';
        }
        const name = testInfo.name; // Имя теста
        const relativePath = testInfo.relativePath || ''; // Относительный путь (для title)
        const defaultState = !!testInfo.defaultState; // Состояние по умолчанию (true/false)
        // Создаем безопасный ID для HTML элемента
        const safeName = name.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        // Экранируем значения для атрибутов
        const escapedNameAttr = escapeHtmlAttr(name);
        const escapedTitleAttr = escapeHtmlAttr(relativePath);
        const fileUriString = testInfo.yamlFileUriString || ''; // Получаем URI файла сценария (если есть)
        const escapedIconTitle = escapeHtmlAttr(`Открыть файл сценария ${name}`);

        // Создаем HTML для кнопки "Открыть", только если URI файла доступен
        const openButtonHtml = fileUriString
            ? `<button class="open-scenario-btn" data-name="${escapedNameAttr}" title="${escapedIconTitle}">
                   <span class="codicon codicon-edit"></span>
               </button>`
            : ''; // Иначе пустая строка

        // Возвращаем полную HTML-разметку для элемента списка
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
     * Создает HTML-разметку для контейнера с чекбоксами для указанной фазы.
     * @param {string} phaseName - Имя фазы.
     * @param {Array<object>} testsInPhase - Массив объектов TestInfo для этой фазы.
     * @returns {string} HTML-строка для содержимого вкладки фазы.
     */
    function createPhaseContentHtml(phaseName, testsInPhase) {
        // Создаем ID для div-контейнера фазы
        const contentId = 'content-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        let contentHtml = `<div id="${contentId}" class="tabcontent" style="display: block;">`; // Начинаем div
        if (Array.isArray(testsInPhase)) { // Проверяем, что данные - массив
             if (testsInPhase.length === 0) { // Если тестов нет
                 contentHtml += '<p>Нет тестов в этой фазе.</p>';
             } else { // Если тесты есть, генерируем HTML для каждого
                 testsInPhase.forEach(info => { if(info?.name) contentHtml += createCheckboxHtml(info); });
             }
        } else { // Если данные некорректны
             contentHtml += '<p style="color:var(--vscode-errorForeground);">Ошибка загрузки тестов.</p>';
        }
        contentHtml += `</div>`; // Закрываем div
        return contentHtml;
    }

    // === Управление UI ===
    /**
     * Отрисовывает содержимое (чекбоксы) для выбранной фазы.
     * @param {string} phaseName - Имя фазы для отображения.
     */
    function renderPhaseContent(phaseName) {
        log(`Rendering content for phase: ${phaseName}`);
        currentPhase = phaseName; // Обновляем текущую активную фазу
        if (!checkboxContainer) { log("Error: Checkbox container not found!"); return; } // Проверка наличия контейнера

        const testsInPhase = testDataByPhase[phaseName]; // Получаем тесты для этой фазы
        // Генерируем и вставляем HTML для чекбоксов
        checkboxContainer.innerHTML = createPhaseContentHtml(phaseName, testsInPhase);

        log(`Rendered ${testsInPhase?.length || 0} checkboxes for ${phaseName}`);
        applyCheckboxStatesToVisible(); // Применяем актуальные состояния к отрисованным чекбоксам и вешаем обработчики
    }

    /**
     * Заполняет выпадающий список фаз и отрисовывает содержимое для начальной фазы.
     * @param {object} allPhaseData - Объект с данными тестов, сгруппированными по фазам.
     */
    function populateDropdownAndRenderInitialContent(allPhaseData) {
        log('Populating dropdown...');
        if (!(phaseSelector instanceof HTMLSelectElement)) { log("Dropdown selector not found"); return; }
        phaseSelector.innerHTML = ''; // Очищаем старые опции
        const sortedNames = Object.keys(allPhaseData).sort(); // Получаем и сортируем имена фаз

        if (sortedNames.length === 0) { // Если фаз нет
             phaseSelector.innerHTML = '<option value="">Нет фаз</option>';
             if (checkboxContainer instanceof HTMLElement) checkboxContainer.innerHTML = '<p>Нет тестов для отображения.</p>';
             return; // Выходим
        }

        const prevSelected = currentPhase; // Сохраняем предыдущую выбранную фазу (если была)
        // Создаем опции для выпадающего списка
        sortedNames.forEach(name => { const opt = document.createElement('option'); opt.value = name; opt.textContent = name; phaseSelector.appendChild(opt); });

        // Определяем, какую фазу отрисовать: предыдущую (если она еще существует) или первую
        let phaseToRender = sortedNames[0];
        if (prevSelected && allPhaseData.hasOwnProperty(prevSelected)) {
            phaseSelector.value = prevSelected; // Восстанавливаем выбор
            phaseToRender = prevSelected;
        } else {
            phaseSelector.value = phaseToRender; // Выбираем первую фазу
            currentPhase = phaseToRender; // Обновляем текущую фазу
        }

        renderPhaseContent(phaseToRender); // Отрисовываем контент для выбранной фазы

        // Добавляем обработчик смены фазы (предварительно удалив старый, если он был)
        phaseSelector.removeEventListener('change', handlePhaseChange);
        phaseSelector.addEventListener('change', handlePhaseChange);
        log('Dropdown populated.');
    }

    /**
     * Обработчик события смены выбранной фазы в выпадающем списке.
     * @param {Event} event - Событие 'change'.
     */
    function handlePhaseChange(event) {
        if (!(event.target instanceof HTMLSelectElement)) return;
        const selectedPhase = event.target.value; // Получаем выбранное значение
        log(`Phase changed to: ${selectedPhase}`);
        renderPhaseContent(selectedPhase); // Отрисовываем новую фазу
    }

    /**
     * Обновляет визуальное выделение (класс 'changed') для чекбоксов,
     * состояние которых отличается от исходного.
     */
    function updateHighlighting() {
        if (!checkboxContainer) return; // Проверка контейнера
        const checkboxes = checkboxContainer.querySelectorAll('input[type=checkbox]'); // Находим все чекбоксы
        checkboxes.forEach(cb => {
            if (!(cb instanceof HTMLInputElement)) return;
            const name = cb.getAttribute('name'); // Имя теста
            const label = cb.closest('.checkbox-item'); // Родительский label
            // Проверяем, что label и имя есть, и тест не отключен ('disabled')
            if (!label || !name || !initialTestStates.hasOwnProperty(name) || initialTestStates[name] === 'disabled') {
                label?.classList.remove('changed'); // Убираем выделение, если неактуально
                return;
            }
            // Сравниваем исходное и текущее состояние
            const initialChecked = initialTestStates[name] === 'checked';
            const currentChecked = !!currentCheckboxStates[name];
            // Добавляем/удаляем класс 'changed' в зависимости от результата сравнения
            label.classList.toggle('changed', initialChecked !== currentChecked);
        });
    }

    /**
     * Обработчик клика по кнопке "Открыть сценарий" (иконка карандаша).
     * @param {MouseEvent} event - Событие клика.
     */
    function handleOpenScenarioClick(event) {
        // Используем event.target и closest для надежного определения кнопки
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('.open-scenario-btn');
        if (!(button instanceof HTMLButtonElement)) return; // Если клик был не по кнопке, выходим

        event.preventDefault(); // Предотвращаем стандартное поведение
        event.stopPropagation(); // Останавливаем всплытие события (чтобы не сработал клик по label)
        const name = button.getAttribute('data-name'); // Получаем имя теста из атрибута
        if (!name) {
            log("ERROR: Open scenario button clicked without data-name attribute!");
            return;
        }
        log(`Open scenario button clicked for: ${name}`);
        // Отправляем команду в расширение для открытия файла
        vscode.postMessage({
            command: 'openScenario',
            name: name
        });
    }


    /**
     * Применяет сохраненные состояния (currentCheckboxStates) к видимым чекбоксам
     * и добавляет/удаляет обработчики событий.
     */
    function applyCheckboxStatesToVisible() {
        log('Applying states to visible checkboxes...');
        if (!checkboxContainer) return; // Проверка контейнера
        const checkboxes = checkboxContainer.querySelectorAll('input[type="checkbox"]'); // Находим все видимые чекбоксы
        let count = 0;
        checkboxes.forEach(cb => {
            if (!(cb instanceof HTMLInputElement)) return;
            const name = cb.getAttribute('name'); // Имя теста
            const label = cb.closest('.checkbox-item'); // Родительский label
            cb.removeEventListener('change', handleCheckboxChange); // Удаляем старый обработчик (если был)

            if (name && initialTestStates.hasOwnProperty(name)) { // Если имя есть и тест существует в исходных данных
                count++;
                const initialState = initialTestStates[name]; // Исходное состояние ('checked', 'unchecked', 'disabled')
                cb.disabled = (initialState === 'disabled'); // Устанавливаем disabled, если нужно
                // Устанавливаем checked на основе ТЕКУЩЕГО состояния (приводим к boolean)
                cb.checked = !!currentCheckboxStates[name];
                if(label) {
                    label.classList.toggle('disabled', cb.disabled); // Добавляем/удаляем класс 'disabled' для стилизации
                    label.classList.remove('changed'); // Убираем класс 'changed' при перерисовке
                }
                if (!cb.disabled) { // Если чекбокс не отключен, добавляем обработчик изменений
                    cb.addEventListener('change', handleCheckboxChange);
                }
            } else if (name) { // Если имя есть, но теста нет в исходных данных (странная ситуация)
                cb.disabled = true; // Отключаем его
                if(label) label.classList.add('disabled');
            } else { // Если у чекбокса нет имени (ошибка в HTML)
                log("ERROR: Checkbox found with NO NAME attribute!");
            }
        });

        // Находим все кнопки "Открыть сценарий" и вешаем на них обработчики
        const openButtons = checkboxContainer.querySelectorAll('.open-scenario-btn');
        openButtons.forEach(btn => {
            btn.removeEventListener('click', handleOpenScenarioClick); // Удаляем старый
            btn.addEventListener('click', handleOpenScenarioClick); // Добавляем новый
        });

        log(`Applied states to ${count} visible checkboxes.`);
        updateHighlighting(); // Обновляем подсветку измененных
    }

    /**
     * Обновляет ТЕКУЩЕЕ состояние чекбокса в кэше `currentCheckboxStates`.
     * @param {string} name - Имя теста.
     * @param {boolean} isChecked - Новое состояние (true/false).
     */
    function updateCurrentState(name, isChecked) {
        // Обновляем только если тест существует и не отключен ('disabled')
        if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') {
            currentCheckboxStates[name] = !!isChecked; // Сохраняем boolean значение
        }
    }

    /**
     * Обработчик события изменения состояния чекбокса.
     * @param {Event} event - Событие 'change'.
     */
    function handleCheckboxChange(event) {
        if(!(event.target instanceof HTMLInputElement)) return; // Проверка цели события
        const name = event.target.name; // Имя теста
        const isChecked = event.target.checked; // Новое состояние
        log(`Checkbox changed: ${name} = ${isChecked}`);
        updateCurrentState(name, isChecked); // Обновляем состояние в кэше
        updatePendingStatus(); // Обновляем статус и состояние кнопки "Применить"
        updateHighlighting(); // Обновляем подсветку
    }

    /**
     * Обновляет текст в строке статуса Phase Switcher, указывая на наличие
     * несохраненных изменений, и включает/выключает кнопку "Применить".
     */
    function updatePendingStatus() {
        log('Updating pending status...'); if (!(applyChangesBtn instanceof HTMLButtonElement)) return; // Проверка кнопки
        let changed=0, enabled=0, disabled=0; // Счетчики изменений
        // Считаем количество измененных, включенных и выключенных тестов
        for (const name in initialTestStates) {
            if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') { // Игнорируем отключенные
                const initial = initialTestStates[name] === 'checked'; // Исходное состояние
                const current = !!currentCheckboxStates[name]; // Текущее состояние
                if (initial !== current) { // Если состояние изменилось
                    changed++;
                    if (current) { enabled++; } else { disabled++; }
                }
            }
        }

        if (changed > 0) { // Если есть изменения
            // Формируем сообщение о количестве изменений
            updateStatus(`Всего изменено: ${changed} \nВключено тестов: ${enabled} \nВыключено тестов: ${disabled}\n\nНажмите Применить изменения`, 'main');
            applyChangesBtn.disabled = false; // Включаем кнопку "Применить"
        } else { // Если изменений нет
            // Если статус не показывает "Загрузка" или "Применение", ставим "Нет изменений"
            if (!statusBar || !statusBar.textContent?.includes('Загрузка') && !statusBar.textContent?.includes('Применение')) {
                updateStatus('Нет несохраненных изменений.', 'main');
            }
            applyChangesBtn.disabled = true; // Выключаем кнопку "Применить"
        }
        log(`Pending status: ${changed} changes. Apply btn disabled: ${applyChangesBtn.disabled}`);
        updateHighlighting(); // Обновляем подсветку
    }

    // === Связь с Расширением ===
    /**
     * Обрабатывает сообщения, полученные от Extension Host.
     */
    window.addEventListener('message', event => {
        const message = event.data; // Получаем данные сообщения
        log('Received message command: ' + message?.command); // Логируем команду

        switch (message?.command) {
            // Сообщение с начальными данными для отображения
            case 'loadInitialState':
                if (assembleStatus instanceof HTMLElement) assembleStatus.textContent = ''; // Очищаем статус сборки

                if (message.error) { // Если расширение прислало ошибку
                     updateStatus(`Ошибка: ${message.error}`, 'main');
                     // Скрываем обе секции
                      phaseSwitcherSectionElements.forEach(el => { if (el instanceof HTMLElement) el.style.display = 'none'; });
                     if (assembleSection instanceof HTMLElement) assembleSection.style.display = 'none';
                     if (separator instanceof HTMLElement) separator.style.display = 'none';
                     // Блокируем контролы, но оставляем активными "Обновить" и "Настройки"
                     enablePhaseControls(false); enableAssembleControls(false);
                     if (refreshBtn instanceof HTMLButtonElement) refreshBtn.disabled = false;
                     if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.disabled = false;
                } else { // Если данные пришли успешно
                    // Сохраняем полученные данные
                    testDataByPhase = message.tabData || {};
                    initialTestStates = message.states || {};
                    settings = message.settings || { assemblerEnabled: true, switcherEnabled: true };
                    log("Received settings in webview:");
                    console.log(settings); // Логируем полученные настройки

                    // Инициализируем кэши текущих и дефолтных состояний
                    currentCheckboxStates = {}; testDefaultStates = {};
                    for (const phase in testDataByPhase) {
                        if (Array.isArray(testDataByPhase[phase])) {
                            testDataByPhase[phase].forEach(info => {
                                const name = info.name;
                                if (name && initialTestStates.hasOwnProperty(name)) {
                                    if (initialTestStates[name] !== 'disabled') {
                                        // Устанавливаем текущее состояние равным исходному
                                        currentCheckboxStates[name] = initialTestStates[name] === 'checked';
                                    }
                                    // Сохраняем состояние по умолчанию
                                    testDefaultStates[name] = !!info.defaultState;
                                }
                            });
                        }
                    }
                    log("State caches initialized.");

                    // Устанавливаем видимость секций на основе настроек
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

                    // Заполняем dropdown и рендерим контент, если Phase Switcher включен
                    if (phaseSwitcherVisible) {
                        populateDropdownAndRenderInitialContent(testDataByPhase);
                    } else { // Иначе показываем заглушки
                        if(phaseSelector instanceof HTMLSelectElement) phaseSelector.innerHTML = '<option>Функция отключена</option>';
                        if(checkboxContainer instanceof HTMLElement) checkboxContainer.innerHTML = '<p>Phase Switcher отключен.</p>';
                    }

                    updatePendingStatus(); // Обновляем статус "Нет изменений" и кнопку "Применить"
                    // Включаем/выключаем контролы на основе актуальных настроек и наличия данных
                    enablePhaseControls(phaseSwitcherVisible && !!testDataByPhase && Object.keys(testDataByPhase).length > 0);
                    enableAssembleControls(assemblerVisible);
                    // Кнопки "Обновить" и "Настройки" всегда активны, если видимы
                    if (refreshBtn instanceof HTMLButtonElement) refreshBtn.disabled = false;
                    if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.disabled = false;

                    updateStatus('Готово к работе.', 'main'); // Финальный статус
                }
                break;

             // Сообщение для обновления строки статуса
             case 'updateStatus':
                 const target = message.target || 'main'; // Определяем целевую область
                 updateStatus(message.text, target); // Обновляем текст
                 if (message.enableControls !== undefined) { // Если пришло указание на состояние контролов
                     // Включаем/выключаем контролы, учитывая глобальные настройки
                     enablePhaseControls(message.enableControls && settings.switcherEnabled);
                     enableAssembleControls(message.enableControls && settings.assemblerEnabled);
                 }
                 break;

            // Обработчик статуса пароля был удален

            // Неизвестная команда
            default:
                log(`Received unknown command: ${message?.command}`);
                break;
         }
    });

    // === Обработчики событий кнопок ===

    // --- Кнопки Phase Switcher ---
    if(applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.addEventListener('click', () => {
        log('Apply Phase Changes button clicked.');
        const statesToSend = { ...currentCheckboxStates }; // Копируем текущие состояния для отправки
        updateStatus('Применение изменений фаз...', 'main');
        // Блокируем все контролы на время выполнения
        enablePhaseControls(false); enableAssembleControls(false);
        if(applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true; // Блокируем и саму кнопку "Применить"
        // Отправляем команду и данные в расширение
        vscode.postMessage({ command: 'applyChanges', states: statesToSend });
    });

    if(selectAllBtn instanceof HTMLButtonElement) selectAllBtn.addEventListener('click', () => {
        log('Toggle ALL clicked.');
        // Получаем ключи всех тестов, которые не 'disabled'
        const keys = Object.keys(initialTestStates).filter(n => initialTestStates[n] !== 'disabled');
        if(keys.length === 0) return; // Если нет активных тестов, выходим
        // Определяем новое состояние: если хотя бы один не отмечен, то ставим true, иначе false
        let check = false;
        for(const name of keys){ if(!currentCheckboxStates[name]) { check = true; break; } }
        log(`New state for ALL enabled will be: ${check}`);
        // Применяем новое состояние ко всем активным тестам в кэше
        keys.forEach(name => { currentCheckboxStates[name] = check; });
        applyCheckboxStatesToVisible(); // Обновляем видимые чекбоксы
        updatePendingStatus(); // Обновляем статус и кнопку "Применить"
    });

    if(selectVisibleBtn instanceof HTMLButtonElement) selectVisibleBtn.addEventListener('click', () => {
        log('Toggle VISIBLE clicked.');
        if (!checkboxContainer) return;
        // Находим все видимые и не отключенные чекбоксы
        const visibleCbs = checkboxContainer.querySelectorAll('input[type="checkbox"]:not(:disabled)');
        if(visibleCbs.length === 0) return; // Если таких нет, выходим
        // Определяем новое состояние: если хотя бы один не отмечен, то ставим true, иначе false
        let check = false;
        visibleCbs.forEach(cb => { if(cb instanceof HTMLInputElement && !cb.checked) check = true; });
        // Применяем новое состояние к видимым чекбоксам и обновляем кэш
        visibleCbs.forEach(cb => {
            if(cb instanceof HTMLInputElement) {
                const name = cb.getAttribute('name');
                if (name) {
                     cb.checked = check;
                     updateCurrentState(name, check); // Обновляем кэш
                }
            }
        });
        updatePendingStatus(); updateHighlighting(); // Обновляем статус и подсветку
    });

    if(selectDefaultsBtn instanceof HTMLButtonElement) selectDefaultsBtn.addEventListener('click', () => {
        log('Select Defaults for ALL clicked.');
        // Проходим по всем тестам, которые не 'disabled'
        for (const name in initialTestStates) {
            if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') {
                // Получаем состояние по умолчанию из кэша
                const defaultState = !!testDefaultStates[name];
                // Устанавливаем его как текущее состояние в кэше
                currentCheckboxStates[name] = defaultState;
            }
        }
        applyCheckboxStatesToVisible(); // Обновляем видимые чекбоксы
        updatePendingStatus(); // Обновляем статус и кнопку "Применить"
    });

    if(refreshBtn instanceof HTMLButtonElement) refreshBtn.addEventListener('click', () => {
        log('Refresh button clicked.');
        requestInitialState(); // Запрашиваем свежие данные у расширения
    });

    if (openSettingsBtn instanceof HTMLButtonElement) openSettingsBtn.addEventListener('click', () => {
        log('Open Settings button clicked.');
        vscode.postMessage({ command: 'openSettings' }); // Отправляем команду для открытия настроек
    });

    // Обработчики кнопок пароля были удалены

    // --- Кнопка Сборки Тестов ---
    if(assembleBtn instanceof HTMLButtonElement) {
        assembleBtn.addEventListener('click', () => {
            log('Assemble tests button clicked.');
            // Получаем значения параметров сборки из UI
            const recordGLValue = (recordGLSelect instanceof HTMLSelectElement) ? recordGLSelect.value : '0';
            const driveTradeValue = (driveTradeChk instanceof HTMLInputElement) && driveTradeChk.checked ? '1' : '0';
            updateStatus('Запуск сборки...', 'assemble'); // Обновляем статус сборки
            // Блокируем все контролы на время сборки
            enablePhaseControls(false);
            enableAssembleControls(false);
            // Отправляем команду на запуск скрипта в расширение
            vscode.postMessage({
                command: 'runAssembleScript',
                params: { recordGL: recordGLValue, driveTrade: driveTradeValue }
            });
        });
    }

    // === Инициализация при загрузке Webview ===
    /**
     * Запрашивает начальное состояние у расширения.
     */
    function requestInitialState() {
        log('Requesting initial state...');
        updateStatus('Запрос данных...', 'main'); // Устанавливаем статус "Запрос данных"
        // Блокируем контролы на время запроса
        enablePhaseControls(false);
        enableAssembleControls(false);
        if (applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true; // Блокируем кнопку "Применить"
        // Отправляем команду в расширение
        vscode.postMessage({ command: 'getInitialState' });
    }

    // Начальная точка выполнения скрипта
    log('Webview script initialized.');
    updateStatus('Загрузка...', 'main'); // Устанавливаем начальный статус
    // Блокируем контролы до получения данных
    enablePhaseControls(false);
    enableAssembleControls(false);
    if (applyChangesBtn instanceof HTMLButtonElement) applyChangesBtn.disabled = true;
    requestInitialState(); // Запрашиваем начальные данные

}()); // Немедленно вызываем IIFE
