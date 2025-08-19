// Файл: media/yamlParameters.js
// Скрипт для управления интерфейсом Build Scenario Parameters Manager

(function() {
    const vscode = acquireVsCodeApi();
    let parameters = window.__parameters || [];
    const defaultParameters = window.__defaultParameters || [];

    /**
     * Логирует сообщение в консоль webview и отправляет его в расширение.
     * @param {string} message - Сообщение для логирования.
     */
    function log(message) {
        console.log("[Build Scenario Parameters]", message);
        vscode.postMessage({ command: 'log', text: "[Build Scenario Parameters] " + message });
    }

    /**
     * Экранирует HTML символы
     * @param {string} text - Текст для экранирования
     * @returns {string} Экранированный текст
     */
    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Получает текущие параметры из таблицы
     * @returns {Array} Массив параметров
     */
    function getCurrentParameters() {
        const params = [];
        const rows = document.querySelectorAll('#parametersTableBody tr');
        rows.forEach(row => {
            const keyInput = row.querySelector('.param-key');
            const valueInput = row.querySelector('.param-value');
            if (keyInput && valueInput && keyInput.value.trim()) {
                params.push({
                    key: keyInput.value.trim(),
                    value: valueInput.value.trim()
                });
            }
        });
        return params;
    }

    /**
     * Обновляет таблицу параметров
     */
    function updateTable() {
        const tbody = document.getElementById('parametersTableBody');
        tbody.innerHTML = parameters.map((param, index) => `
            <tr data-index="${index}">
                <td>
                    <input type="text" class="param-key" value="${escapeHtml(param.key)}" placeholder="Parameter name">
                </td>
                <td>
                    <input type="text" class="param-value" value="${escapeHtml(param.value)}" placeholder="Parameter value">
                </td>
                <td>
                    <button class="button-with-icon remove-row-btn" title="Remove parameter">
                        <span class="codicon codicon-trash"></span>
                    </button>
                </td>
            </tr>
        `).join('');
        updateRemoveButtons();
    }

    /**
     * Обновляет обработчики кнопок удаления строк
     */
    function updateRemoveButtons() {
        document.querySelectorAll('.remove-row-btn').forEach(btn => {
            btn.onclick = function() {
                const row = this.closest('tr');
                row.remove();
                updateRowIndices();
            };
        });
    }

    /**
     * Обновляет индексы строк после удаления
     */
    function updateRowIndices() {
        const rows = document.querySelectorAll('#parametersTableBody tr');
        rows.forEach((row, index) => {
            row.setAttribute('data-index', index);
        });
    }

    // === Обработчики событий ===

    // Добавить новую строку
    document.getElementById('addRowBtn').addEventListener('click', () => {
        log('Add parameter button clicked.');
        const tbody = document.getElementById('parametersTableBody');
        const newIndex = tbody.children.length;
        const newRow = document.createElement('tr');
        newRow.setAttribute('data-index', newIndex);
        newRow.innerHTML = `
            <td>
                <input type="text" class="param-key" value="" placeholder="Parameter name">
            </td>
            <td>
                <input type="text" class="param-value" value="" placeholder="Parameter value">
            </td>
            <td>
                <button class="button-with-icon remove-row-btn" title="Remove parameter">
                    <span class="codicon codicon-trash"></span>
                </button>
            </td>
        `;
        tbody.appendChild(newRow);
        updateRemoveButtons();
        
        // Фокус на новом поле
        const newKeyInput = newRow.querySelector('.param-key');
        if (newKeyInput) {
            newKeyInput.focus();
        }
    });

    // Сохранить параметры (Apply)
    document.getElementById('saveBtn').addEventListener('click', () => {
        log('Save parameters button clicked.');
        const currentParams = getCurrentParameters();
        vscode.postMessage({
            command: 'saveParameters',
            parameters: currentParams
        });
    });

    // Выпадающее меню More Actions
    const moreActionsBtn = document.getElementById('moreActionsBtn');
    const moreActionsDropdown = document.getElementById('moreActionsDropdown');
    const dropdownContainer = moreActionsBtn.parentElement;

    moreActionsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropdownContainer.classList.toggle('show');
    });

    // Закрытие выпадающего меню при клике вне его
    document.addEventListener('click', (e) => {
        if (!dropdownContainer.contains(e.target)) {
            dropdownContainer.classList.remove('show');
        }
    });

    // Обработчики для элементов выпадающего меню
    document.getElementById('createFileFromDropdownBtn').addEventListener('click', (e) => {
        e.preventDefault();
        log('Create file from dropdown clicked.');
        dropdownContainer.classList.remove('show');
        const currentParams = getCurrentParameters();
        vscode.postMessage({
            command: 'createYamlFile',
            parameters: currentParams
        });
    });

    document.getElementById('loadFromJsonFromDropdownBtn').addEventListener('click', (e) => {
        e.preventDefault();
        log('Load from JSON from dropdown clicked.');
        dropdownContainer.classList.remove('show');
        vscode.postMessage({
            command: 'loadFromJson'
        });
    });

    document.getElementById('resetDefaultsFromDropdownBtn').addEventListener('click', (e) => {
        e.preventDefault();
        log('Reset defaults from dropdown clicked.');
        dropdownContainer.classList.remove('show');
        parameters = [...defaultParameters];
        updateTable();
    });

    // Обработка сообщений от расширения
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'loadParameters':
                log('Loading parameters from extension.');
                parameters = message.parameters || [];
                updateTable();
                break;
        }
    });

    // Кнопка справки с ховером
    const helpBtn = document.getElementById('helpBtn');
    const helpTooltip = document.getElementById('helpTooltip');
    const helpContainer = helpBtn.parentElement;

    let isHoveringHelp = false;

    // Показать тултип при наведении на кнопку
    helpBtn.addEventListener('mouseenter', () => {
        isHoveringHelp = true;
        helpTooltip.classList.add('show');
    });

    // Показать тултип при наведении на сам тултип
    helpTooltip.addEventListener('mouseenter', () => {
        isHoveringHelp = true;
        helpTooltip.classList.add('show');
    });

    // Скрыть тултип при уходе с кнопки
    helpBtn.addEventListener('mouseleave', () => {
        isHoveringHelp = false;
        setTimeout(() => {
            if (!isHoveringHelp) {
                helpTooltip.classList.remove('show');
            }
        }, 100);
    });

    // Скрыть тултип при уходе с тултипа
    helpTooltip.addEventListener('mouseleave', () => {
        isHoveringHelp = false;
        setTimeout(() => {
            if (!isHoveringHelp) {
                helpTooltip.classList.remove('show');
            }
        }, 100);
    });

    // === Инициализация ===
    log('Build Scenario Parameters Manager script initialized.');
    updateRemoveButtons();
}());
