// Файл: media/phaseSwitcher.js
// Полная версия скрипта для Webview панели с Dropdown

(function() { // IIFE для изоляции области видимости
    // Получаем API для связи с расширением
    // @ts-ignore - VS Code инжектирует эту функцию в рантайме
    const vscode = acquireVsCodeApi();

    // === Состояния ===
    let testDataByPhase = {}; // { phaseName: [TestInfo...] } - Структура тестов
    let initialTestStates = {}; // { testName: 'checked'|'unchecked'|'disabled' } - Состояние с диска
    let currentCheckboxStates = {}; // { testName: boolean } - ТЕКУЩЕЕ состояние активных чекбоксов
    let testDefaultStates = {}; // { testName: boolean } - Кэш дефолтных состояний
    let currentPhase = null; // Имя текущей выбранной фазы

    // === Элементы UI ===
    const phaseSelector = document.getElementById('phaseSelector');
    const checkboxContainer = document.getElementById('checkbox-container');
    const statusBar = document.getElementById('statusBar');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const selectVisibleBtn = document.getElementById('selectVisibleBtn');
    const selectDefaultsBtn = document.getElementById('selectDefaultsBtn');
    const applyChangesBtn = document.getElementById('applyChangesBtn');
    const refreshBtn = document.getElementById('refreshBtn');

    // === Утилиты ===

    /** Простая функция логирования, отправляющая сообщение в Extension Host */
    function log(message) {
        // Выводим и в локальную консоль DevTools для удобства
        console.log("[Webview]", message);
        // Отправляем в Extension Host (там тоже будет console.log)
        vscode.postMessage({ command: 'log', text: "[Webview] " + message });
    }

    /** Обновляет текст в статус-баре */
    function updateStatus(text) {
        if (statusBar) {
            statusBar.textContent = text;
        }
        log("Status updated: " + text);
    }

    /** Включает/выключает кнопки управления (кроме Apply) */
    function enableControls(enable) {
        const buttons = document.querySelectorAll('.controls button:not(#applyChangesBtn), .controls-top button');
        const isDisabled = !enable;
        buttons.forEach(btn => { if(btn) btn.disabled = isDisabled; });
        // Кнопка Apply управляется отдельно, но выключаем ее при общем выключении
        if (isDisabled && applyChangesBtn) {
            applyChangesBtn.disabled = true;
        }
        if(phaseSelector) {
             phaseSelector.disabled = isDisabled;
        }
        // Используем простой лог
        log('Controls enabled: ' + enable + ' (Apply button state managed separately)');
    }

    // === Генерация HTML ===

    /** Генерирует HTML для одного чекбокса */
    function createCheckboxHtml(testInfo) {
        // log(`Creating checkbox HTML for testInfo: ${JSON.stringify(testInfo)}`);
        if (!testInfo || typeof testInfo.name !== 'string' || !testInfo.name) {
             log("ERROR: Invalid testInfo in createCheckboxHtml!");
             return '<p style="color:var(--vscode-errorForeground);">Ошибка данных чекбокса</p>';
        }
        const name = testInfo.name;
        const relativePath = testInfo.relativePath || '';
        const defaultState = !!testInfo.defaultState;
        const safeName = name.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        // Используем функцию экранирования
        const escapedNameAttr = escapeHtmlAttr(name);
        const escapedTitleAttr = escapeHtmlAttr(relativePath);
    
        // Добавляем название в title атрибут для отображения полного текста при наведении
        return `
            <div class="item-container">
                <label class="checkbox-item" id="label-${safeName}" title="${escapedNameAttr} (${escapedTitleAttr})">
                    <input
                        type="checkbox"
                        id="chk-${safeName}"
                        name="${escapedNameAttr}"
                        data-default="${defaultState}">
                    <span class="checkbox-label-text">${name}</span>
                    <button class="open-scenario-btn" data-name="${escapedNameAttr}" title="Открыть сценарий">⧁</button>
                </label>
            </div>
        `;
    }

     /** Вспомогательная функция экранирования HTML атрибутов */
     function escapeHtmlAttr(unsafe) {
         if (typeof unsafe !== 'string') {
             try { unsafe = String(unsafe); } catch { return ''; }
         }
         return unsafe
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
     }

    /** Генерирует HTML для содержимого выбранной фазы */
    function createPhaseContentHtml(phaseName, testsInPhase) {
        const contentId = 'content-' + phaseName.replace(/[^a-zA-Z0-9_\\-]/g, '_');
        let contentHtml = `<div id="${contentId}" class="tabcontent" style="display: block;">`; // Используем ID, сразу делаем видимым
        // log(`Creating content HTML for '${phaseName}' - Item count: ${Array.isArray(testsInPhase) ? testsInPhase.length : 'INVALID'}`);
        if (Array.isArray(testsInPhase)) {
             if (testsInPhase.length === 0) { contentHtml = '<p>Нет тестов в этой фазе.</p>'; }
             else { testsInPhase.forEach(info => { if(info?.name) contentHtml += createCheckboxHtml(info); }); }
        } else { contentHtml = '<p style="color:red;">Ошибка загрузки тестов.</p>'; }
        contentHtml += `</div>`;
        return contentHtml;
    }

    // === Управление UI ===

    /** Отрисовывает чекбоксы для выбранной фазы */
    function renderPhaseContent(phaseName) {
        log(`Rendering content for phase: ${phaseName}`);
        currentPhase = phaseName;
        if (!checkboxContainer) { log("Error: Checkbox container not found!"); return; }

        const testsInPhase = testDataByPhase[phaseName];
        // Используем createPhaseContentHtml, которая уже включает div
        checkboxContainer.innerHTML = createPhaseContentHtml(phaseName, testsInPhase, 'currentPhaseContent');

        log(`Rendered ${testsInPhase?.length || 0} checkboxes for ${phaseName}`);
        applyCheckboxStatesToVisible(); // Применяем состояния и вешаем листенеры
    }

    /** Заполняет dropdown и рендерит контент фазы */
    function populateDropdownAndRenderInitialContent(allPhaseData) {
        log('Populating dropdown...');
        if (!phaseSelector) return;
        phaseSelector.innerHTML = '';
        const sortedNames = Object.keys(allPhaseData).sort();
        if (sortedNames.length === 0) {  return; }
        const prevSelected = currentPhase;
        sortedNames.forEach(name => { const opt = document.createElement('option'); opt.value = name; opt.textContent = name; phaseSelector.appendChild(opt); });
        let phaseToRender = sortedNames[0];
        if (prevSelected && allPhaseData.hasOwnProperty(prevSelected)) { phaseSelector.value = prevSelected; phaseToRender = prevSelected; }
        else { phaseSelector.value = phaseToRender; }
        renderPhaseContent(phaseToRender); // Рендерим выбранную
        phaseSelector.removeEventListener('change', handlePhaseChange);
        phaseSelector.addEventListener('change', handlePhaseChange);
        log('Dropdown populated.');
    }

    /** Обрабатывает смену фазы в dropdown */
    function handlePhaseChange(event) {
        const selectedPhase = event.target.value;
        log(`Phase changed to: ${selectedPhase}`);
        renderPhaseContent(selectedPhase);
    }

    /** Обновляет подсветку для видимых измененных чекбоксов */
    function updateHighlighting() {
        if (!checkboxContainer) return;
        const checkboxes = checkboxContainer.querySelectorAll('input[type=checkbox]');
        checkboxes.forEach(cb => {
            const name = cb.getAttribute('name'); const label = cb.closest('.checkbox-item');
            if (!label || !name || !initialTestStates.hasOwnProperty(name) || initialTestStates[name] === 'disabled') { label?.classList.remove('changed'); return; }
            const initialChecked = initialTestStates[name] === 'checked';
            const currentChecked = !!currentCheckboxStates[name];
            label.classList.toggle('changed', initialChecked !== currentChecked);
        });
    }


    /** Обработчик клика по кнопке открытия сценария */
    function handleOpenScenarioClick(event) {
        event.preventDefault();
        event.stopPropagation();
        const name = event.target.getAttribute('data-name');
        log(`Open scenario button clicked for: ${name}`);
        vscode.postMessage({ 
            command: 'openScenario', 
            name: name 
        });
    }

    /** Применяет состояния (checked, disabled) к видимым чекбоксам и вешает обработчики */
    function applyCheckboxStatesToVisible() {
        log('Applying states to visible checkboxes...');
        if (!checkboxContainer) return;
        const checkboxes = checkboxContainer.querySelectorAll('input[type="checkbox"]');
        let count = 0;
        checkboxes.forEach(cb => {
            const name = cb.getAttribute('name'); const label = cb.closest('.checkbox-item');
            cb.removeEventListener('change', handleCheckboxChange);
            if (name && initialTestStates.hasOwnProperty(name)) {
                count++;
                const initialState = initialTestStates[name];
                cb.disabled = (initialState === 'disabled');
                cb.checked = !!currentCheckboxStates[name]; // Берем из актуального состояния
                if(label) { label.classList.toggle('disabled', cb.disabled); label.classList.remove('changed');}
                if (!cb.disabled) { cb.addEventListener('change', handleCheckboxChange); }
            } else if (name) { cb.disabled = true; if(label) label.classList.add('disabled'); }
            else { log("ERROR: Checkbox found with NO NAME attribute!"); }
        });
        
        // Добавляем обработчики для кнопок открытия сценария
        const openButtons = checkboxContainer.querySelectorAll('.open-scenario-btn');
        openButtons.forEach(btn => {
            btn.removeEventListener('click', handleOpenScenarioClick);
            btn.addEventListener('click', handleOpenScenarioClick);
        });
        
        log(`Applied states to ${count} visible checkboxes.`);
        updateHighlighting(); // Обновляем подсветку сразу
    }

    /** Обновляет ТЕКУЩЕЕ состояние в JS кэше */
    function updateCurrentState(name, isChecked) { if (initialTestStates[name] !== 'disabled') { currentCheckboxStates[name] = !!isChecked; } }

    /** Обработчик изменения состояния чекбокса */
    function handleCheckboxChange(event) { if(!event?.target) return; const name = event.target.name; const isChecked = event.target.checked; log(`Checkbox changed: ${name} = ${isChecked}`); updateCurrentState(name, isChecked); updatePendingStatus(); updateHighlighting(); }

    /** Обновляет промежуточный статус и состояние кнопки Apply */
    function updatePendingStatus() {
        log('Updating pending status...'); if (!applyChangesBtn) return;
        let changed=0, enabled=0, disabled=0;
        for (const name in initialTestStates) { if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') { const initial = initialTestStates[name] === 'checked'; const current = !!currentCheckboxStates[name]; if (initial !== current) { changed++; if (current) { enabled++; } else { disabled++; } } } }
        if (changed > 0) { updateStatus(`Всего изменено: ${changed} \nВключено тестов: ${enabled} \nВыключено тестов: ${disabled}\n\nНажмите Применить изменения`); applyChangesBtn.disabled = false; }
        else { if (!statusBar || !statusBar.textContent?.includes('Загрузка') && !statusBar.textContent?.includes('Применение')) { updateStatus('Нет несохраненных изменений.'); } applyChangesBtn.disabled = true; }
        // log(`Pending status: ${changed} changes. Apply btn disabled: ${applyChangesBtn.disabled}`);
    }

    // --- Связь с Расширением ---

    /** Обработка сообщений от расширения */
    window.addEventListener('message', event => {
        const message = event.data; log('Received message: ' + message.command);
        switch (message.command) {
             case 'loadInitialState':
                 if (message.error) { updateStatus(`Ошибка: ${message.error}`); enableControls(false); if(refreshBtn) refreshBtn.disabled = false; if(phaseSelector) phaseSelector.innerHTML = '<option>Ошибка</option>'; if(checkboxContainer) checkboxContainer.innerHTML = ''; }
                 else {
                     testDataByPhase = message.tabData || {};
                     initialTestStates = message.states || {};
                     currentCheckboxStates = {}; testDefaultStates = {};
                     log("Initializing current/default states...");
                     for (const phase in testDataByPhase) { if (Array.isArray(testDataByPhase[phase])) { testDataByPhase[phase].forEach(info => { const name = info.name; if (name && initialTestStates.hasOwnProperty(name)) { if (initialTestStates[name] !== 'disabled') { currentCheckboxStates[name] = initialTestStates[name] === 'checked'; } testDefaultStates[name] = !!info.defaultState; } }); } }
                     log("State caches initialized.");
                     populateDropdownAndRenderInitialContent(testDataByPhase);
                     updatePendingStatus(); // Обновляем кнопку Apply
                     enableControls(true);
                     updateStatus('Готово к работе.');
                 }
                 break;
             case 'updateStatus': updateStatus(message.text); if (message.enableControls !== undefined) { enableControls(message.enableControls); } break;
         }
    });

    /** Запрос начального состояния у расширения */
    function requestInitialState() { log('Requesting initial state...'); updateStatus('Запрос данных...'); enableControls(false); if(applyChangesBtn) applyChangesBtn.disabled = true; vscode.postMessage({ command: 'getInitialState' }); }

    // --- Обработчики кнопок управления ---
    if(applyChangesBtn) applyChangesBtn.addEventListener('click', () => { log('Apply button clicked.'); const statesToSend = { ...currentCheckboxStates }; updateStatus('Применение изменений...'); enableControls(false); if(applyChangesBtn) applyChangesBtn.disabled = true; vscode.postMessage({ command: 'applyChanges', states: statesToSend }); });
    if(selectAllBtn) selectAllBtn.addEventListener('click', () => { log('Toggle ALL clicked.'); const keys = Object.keys(initialTestStates).filter(n => initialTestStates[n] !== 'disabled'); if(keys.length === 0) return; let check = false; for(const name of keys){ if(!currentCheckboxStates[name]) { check = true; break; } } log(`New state for ALL enabled will be: ${check}`); keys.forEach(name => { currentCheckboxStates[name] = check; }); const visibleCbs = checkboxContainer?.querySelectorAll('input[type="checkbox"]:not(:disabled)'); visibleCbs?.forEach(cb => { const name = cb.getAttribute('name'); if(name && currentCheckboxStates.hasOwnProperty(name)){ cb.checked = currentCheckboxStates[name]; } }); updatePendingStatus(); updateHighlighting(); });
    if(selectVisibleBtn) selectVisibleBtn.addEventListener('click', () => { log('Toggle VISIBLE clicked.'); if (!checkboxContainer) return; const visibleCbs = checkboxContainer.querySelectorAll('input[type="checkbox"]:not(:disabled)'); if(visibleCbs.length === 0) return; let check = false; for(const cb of visibleCbs){ if(!cb.checked){ check = true; break; } } visibleCbs.forEach(cb => { cb.checked = check; updateCurrentState(cb.getAttribute('name'), check); }); updatePendingStatus(); updateHighlighting(); });
    if(selectDefaultsBtn) selectDefaultsBtn.addEventListener('click', () => { log('Select Defaults for ALL clicked.'); for (const name in initialTestStates) { if (initialTestStates.hasOwnProperty(name) && initialTestStates[name] !== 'disabled') { const defaultState = !!testDefaultStates[name]; currentCheckboxStates[name] = defaultState; } } if (checkboxContainer) { const visibleCbs = checkboxContainer.querySelectorAll('input[type="checkbox"]:not(:disabled)'); visibleCbs?.forEach(cb => { const name = cb.getAttribute('name'); if(name && currentCheckboxStates.hasOwnProperty(name)) { cb.checked = currentCheckboxStates[name]; } }); } updatePendingStatus(); updateHighlighting(); });
    if(refreshBtn) refreshBtn.addEventListener('click', () => { log('Refresh button clicked.'); requestInitialState(); });

    // --- Инициализация при загрузке скрипта ---
    log('Webview script initialized.'); updateStatus('Загрузка...'); enableControls(false); if(applyChangesBtn) applyChangesBtn.disabled = true; requestInitialState();

}()); // Конец IIFE