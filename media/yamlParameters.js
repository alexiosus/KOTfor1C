// Файл: media/yamlParameters.js
// Скрипт для управления интерфейсом Build Scenario Parameters Manager

(function() {
    const vscode = acquireVsCodeApi();
    let buildParameters = window.__buildParameters || [];
    let additionalVanessaParameters = window.__additionalParameters || [];
    let globalVanessaVariables = window.__globalVanessaVariables || [];
    const defaultBuildParameters = window.__defaultBuildParameters || [];
    const uiLoc = {
        paramNamePlaceholder: document.body.dataset.paramNamePlaceholder || 'Parameter name',
        paramValuePlaceholder: document.body.dataset.paramValuePlaceholder || 'Parameter value',
        removeParameter: document.body.dataset.removeParameter || 'Remove parameter',
        overrideTitle: document.body.dataset.overrideTitle || 'Override existing value'
    };
    let activeTab = 'build';

    function log(message) {
        console.log('[Build Scenario Parameters]', message);
        vscode.postMessage({ command: 'log', text: '[Build Scenario Parameters] ' + message });
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function buildRowHtml(param, index) {
        return `
            <tr data-index="${index}">
                <td>
                    <input type="text" class="param-key" value="${escapeHtml(param.key || '')}" placeholder="${escapeHtml(uiLoc.paramNamePlaceholder)}">
                </td>
                <td>
                    <input type="text" class="param-value" value="${escapeHtml(param.value || '')}" placeholder="${escapeHtml(uiLoc.paramValuePlaceholder)}">
                </td>
                <td>
                    <button class="button-with-icon remove-row-btn" title="${escapeHtml(uiLoc.removeParameter)}">
                        <span class="codicon codicon-trash"></span>
                    </button>
                </td>
            </tr>
        `;
    }

    function additionalRowHtml(param, index) {
        const isOverride = Boolean(param.overrideExisting);
        return `
            <tr data-index="${index}">
                <td>
                    <input type="text" class="param-key" value="${escapeHtml(param.key || '')}" placeholder="${escapeHtml(uiLoc.paramNamePlaceholder)}">
                </td>
                <td>
                    <input type="text" class="param-value" value="${escapeHtml(param.value || '')}" placeholder="${escapeHtml(uiLoc.paramValuePlaceholder)}">
                </td>
                <td class="param-priority-cell">
                    <input type="checkbox" class="param-override" ${isOverride ? 'checked' : ''} title="${escapeHtml(uiLoc.overrideTitle)}">
                </td>
                <td>
                    <button class="button-with-icon remove-row-btn" title="${escapeHtml(uiLoc.removeParameter)}">
                        <span class="codicon codicon-trash"></span>
                    </button>
                </td>
            </tr>
        `;
    }

    function getTableBody(id) {
        return document.getElementById(id);
    }

    function getBuildParametersFromTable() {
        const body = getTableBody('buildParametersTableBody');
        if (!body) {
            return [];
        }
        const params = [];
        body.querySelectorAll('tr').forEach(row => {
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

    function getAdditionalParametersFromTable() {
        const body = getTableBody('additionalParametersTableBody');
        if (!body) {
            return [];
        }
        const params = [];
        body.querySelectorAll('tr').forEach(row => {
            const keyInput = row.querySelector('.param-key');
            const valueInput = row.querySelector('.param-value');
            const overrideInput = row.querySelector('.param-override');
            if (keyInput && valueInput && keyInput.value.trim()) {
                params.push({
                    key: keyInput.value.trim(),
                    value: valueInput.value.trim(),
                    overrideExisting: Boolean(overrideInput && overrideInput.checked)
                });
            }
        });
        return params;
    }

    function getGlobalVarsFromTable() {
        const body = getTableBody('globalVarsTableBody');
        if (!body) {
            return [];
        }
        const params = [];
        body.querySelectorAll('tr').forEach(row => {
            const keyInput = row.querySelector('.param-key');
            const valueInput = row.querySelector('.param-value');
            const overrideInput = row.querySelector('.param-override');
            if (keyInput && valueInput && keyInput.value.trim()) {
                params.push({
                    key: keyInput.value.trim(),
                    value: valueInput.value.trim(),
                    overrideExisting: Boolean(overrideInput && overrideInput.checked)
                });
            }
        });
        return params;
    }

    function updateRowIndices(bodyId) {
        const body = getTableBody(bodyId);
        if (!body) {
            return;
        }
        body.querySelectorAll('tr').forEach((row, index) => {
            row.setAttribute('data-index', String(index));
        });
    }

    function updateBuildTable() {
        const body = getTableBody('buildParametersTableBody');
        if (!body) {
            return;
        }
        body.innerHTML = buildParameters.map((param, index) => buildRowHtml(param, index)).join('');
    }

    function updateAdditionalTable() {
        const body = getTableBody('additionalParametersTableBody');
        if (!body) {
            return;
        }
        body.innerHTML = additionalVanessaParameters.map((param, index) => additionalRowHtml(param, index)).join('');
    }

    function updateGlobalVarsTable() {
        const body = getTableBody('globalVarsTableBody');
        if (!body) {
            return;
        }
        body.innerHTML = globalVanessaVariables.map((param, index) => additionalRowHtml(param, index)).join('');
    }

    function appendBuildRow() {
        const body = getTableBody('buildParametersTableBody');
        if (!body) {
            return;
        }
        const row = document.createElement('tr');
        row.setAttribute('data-index', String(body.children.length));
        row.innerHTML = `
            <td>
                <input type="text" class="param-key" value="" placeholder="${escapeHtml(uiLoc.paramNamePlaceholder)}">
            </td>
            <td>
                <input type="text" class="param-value" value="" placeholder="${escapeHtml(uiLoc.paramValuePlaceholder)}">
            </td>
            <td>
                <button class="button-with-icon remove-row-btn" title="${escapeHtml(uiLoc.removeParameter)}">
                    <span class="codicon codicon-trash"></span>
                </button>
            </td>
        `;
        body.appendChild(row);
        row.querySelector('.param-key')?.focus();
    }

    function appendAdditionalRow() {
        const body = getTableBody('additionalParametersTableBody');
        if (!body) {
            return;
        }
        const row = document.createElement('tr');
        row.setAttribute('data-index', String(body.children.length));
        row.innerHTML = `
            <td>
                <input type="text" class="param-key" value="" placeholder="${escapeHtml(uiLoc.paramNamePlaceholder)}">
            </td>
            <td>
                <input type="text" class="param-value" value="" placeholder="${escapeHtml(uiLoc.paramValuePlaceholder)}">
            </td>
            <td class="param-priority-cell">
                <input type="checkbox" class="param-override" title="${escapeHtml(uiLoc.overrideTitle)}">
            </td>
            <td>
                <button class="button-with-icon remove-row-btn" title="${escapeHtml(uiLoc.removeParameter)}">
                    <span class="codicon codicon-trash"></span>
                </button>
            </td>
        `;
        body.appendChild(row);
        row.querySelector('.param-key')?.focus();
    }

    function appendGlobalVarRow() {
        const body = getTableBody('globalVarsTableBody');
        if (!body) {
            return;
        }
        const row = document.createElement('tr');
        row.setAttribute('data-index', String(body.children.length));
        row.innerHTML = `
            <td>
                <input type="text" class="param-key" value="" placeholder="${escapeHtml(uiLoc.paramNamePlaceholder)}">
            </td>
            <td>
                <input type="text" class="param-value" value="" placeholder="${escapeHtml(uiLoc.paramValuePlaceholder)}">
            </td>
            <td class="param-priority-cell">
                <input type="checkbox" class="param-override" title="${escapeHtml(uiLoc.overrideTitle)}">
            </td>
            <td>
                <button class="button-with-icon remove-row-btn" title="${escapeHtml(uiLoc.removeParameter)}">
                    <span class="codicon codicon-trash"></span>
                </button>
            </td>
        `;
        body.appendChild(row);
        row.querySelector('.param-key')?.focus();
    }

    function getCurrentState() {
        return {
            buildParameters: getBuildParametersFromTable(),
            additionalVanessaParameters: getAdditionalParametersFromTable(),
            globalVanessaVariables: getGlobalVarsFromTable()
        };
    }

    function setActiveTab(tabName) {
        const buildTabBtn = document.getElementById('buildTabBtn');
        const additionalTabBtn = document.getElementById('additionalTabBtn');
        const globalVarsTabBtn = document.getElementById('globalVarsTabBtn');
        const buildTabPanel = document.getElementById('buildTabPanel');
        const additionalTabPanel = document.getElementById('additionalTabPanel');
        const globalVarsTabPanel = document.getElementById('globalVarsTabPanel');
        if (!buildTabBtn || !additionalTabBtn || !globalVarsTabBtn || !buildTabPanel || !additionalTabPanel || !globalVarsTabPanel) {
            return;
        }

        const nextTab = tabName === 'additional' || tabName === 'globalVars' ? tabName : 'build';
        activeTab = nextTab;

        const showBuild = nextTab === 'build';
        const showAdditional = nextTab === 'additional';
        const showGlobalVars = nextTab === 'globalVars';

        buildTabBtn.classList.toggle('active', showBuild);
        buildTabBtn.setAttribute('aria-selected', showBuild ? 'true' : 'false');
        additionalTabBtn.classList.toggle('active', showAdditional);
        additionalTabBtn.setAttribute('aria-selected', showAdditional ? 'true' : 'false');
        globalVarsTabBtn.classList.toggle('active', showGlobalVars);
        globalVarsTabBtn.setAttribute('aria-selected', showGlobalVars ? 'true' : 'false');

        buildTabPanel.classList.toggle('active', showBuild);
        buildTabPanel.hidden = !showBuild;
        additionalTabPanel.classList.toggle('active', showAdditional);
        additionalTabPanel.hidden = !showAdditional;
        globalVarsTabPanel.classList.toggle('active', showGlobalVars);
        globalVarsTabPanel.hidden = !showGlobalVars;
    }

    function setupDropdown(buttonId) {
        const button = document.getElementById(buttonId);
        const container = button?.closest('.dropdown-container');
        if (!button || !container) {
            return;
        }

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelectorAll('.dropdown-container.show').forEach(item => {
                if (item !== container) {
                    item.classList.remove('show');
                }
            });
            container.classList.toggle('show');
        });
    }

    document.addEventListener('click', (event) => {
        const removeBtn = event.target.closest('.remove-row-btn');
        if (removeBtn) {
            const row = removeBtn.closest('tr');
            const body = row?.parentElement;
            if (row && body) {
                row.remove();
                if (body.id) {
                    updateRowIndices(body.id);
                }
            }
            return;
        }

        document.querySelectorAll('.dropdown-container.show').forEach(container => {
            if (!container.contains(event.target)) {
                container.classList.remove('show');
            }
        });
    });

    document.getElementById('addBuildRowBtn').addEventListener('click', () => {
        log('Add build parameter button clicked.');
        appendBuildRow();
    });

    document.getElementById('addAdditionalRowBtn').addEventListener('click', () => {
        log('Add additional Vanessa parameter button clicked.');
        appendAdditionalRow();
    });

    document.getElementById('addGlobalVarRowBtn').addEventListener('click', () => {
        log('Add GlobalVar parameter button clicked.');
        appendGlobalVarRow();
    });

    document.getElementById('saveBtn').addEventListener('click', () => {
        log('Save parameters button clicked.');
        const state = getCurrentState();
        vscode.postMessage({
            command: 'saveParameters',
            buildParameters: state.buildParameters,
            additionalVanessaParameters: state.additionalVanessaParameters,
            globalVanessaVariables: state.globalVanessaVariables
        });
    });

    setupDropdown('moreActionsBtn');

    document.getElementById('createBuildFileBtn').addEventListener('click', (e) => {
        e.preventDefault();
        const state = getCurrentState();
        vscode.postMessage({
            command: 'createYamlFile',
            buildParameters: state.buildParameters
        });
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    document.getElementById('loadBuildFromJsonBtn').addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ command: 'loadBuildFromJson' });
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    document.getElementById('resetBuildDefaultsBtn').addEventListener('click', (e) => {
        e.preventDefault();
        buildParameters = [...defaultBuildParameters];
        updateBuildTable();
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    document.getElementById('createAdditionalFileBtn').addEventListener('click', (e) => {
        e.preventDefault();
        const state = getCurrentState();
        vscode.postMessage({
            command: 'createAdditionalJsonFile',
            additionalVanessaParameters: state.additionalVanessaParameters
        });
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    document.getElementById('loadAdditionalFromJsonBtn').addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ command: 'loadAdditionalFromJson' });
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    document.getElementById('clearAdditionalBtn').addEventListener('click', (e) => {
        e.preventDefault();
        additionalVanessaParameters = [];
        updateAdditionalTable();
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    document.getElementById('createGlobalVarsFileBtn').addEventListener('click', (e) => {
        e.preventDefault();
        const state = getCurrentState();
        vscode.postMessage({
            command: 'createGlobalVarsJsonFile',
            globalVanessaVariables: state.globalVanessaVariables
        });
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    document.getElementById('loadGlobalVarsFromJsonBtn').addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ command: 'loadGlobalVarsFromJson' });
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    document.getElementById('clearGlobalVarsBtn').addEventListener('click', (e) => {
        e.preventDefault();
        globalVanessaVariables = [];
        updateGlobalVarsTable();
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    const buildTabBtn = document.getElementById('buildTabBtn');
    const additionalTabBtn = document.getElementById('additionalTabBtn');
    const globalVarsTabBtn = document.getElementById('globalVarsTabBtn');
    if (buildTabBtn && additionalTabBtn && globalVarsTabBtn) {
        buildTabBtn.addEventListener('click', () => setActiveTab('build'));
        additionalTabBtn.addEventListener('click', () => setActiveTab('additional'));
        globalVarsTabBtn.addEventListener('click', () => setActiveTab('globalVars'));
        buildTabBtn.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowRight') {
                event.preventDefault();
                setActiveTab('additional');
                additionalTabBtn.focus();
            }
        });
        additionalTabBtn.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowRight') {
                event.preventDefault();
                setActiveTab('globalVars');
                globalVarsTabBtn.focus();
            }
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setActiveTab('build');
                buildTabBtn.focus();
            }
        });
        globalVarsTabBtn.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setActiveTab('additional');
                additionalTabBtn.focus();
            }
        });
    }

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'loadBuildParameters':
                log('Loading build parameters from extension.');
                buildParameters = message.buildParameters || [];
                updateBuildTable();
                break;
            case 'loadAdditionalParameters':
                log('Loading additional Vanessa parameters from extension.');
                additionalVanessaParameters = message.additionalParameters || [];
                updateAdditionalTable();
                break;
            case 'loadGlobalVanessaVariables':
                log('Loading GlobalVars from extension.');
                globalVanessaVariables = message.globalVanessaVariables || [];
                updateGlobalVarsTable();
                break;
            case 'loadParameters':
                // Legacy fallback message support.
                log('Loading legacy parameter payload from extension.');
                buildParameters = message.parameters || [];
                updateBuildTable();
                break;
        }
    });

    const helpBtn = document.getElementById('helpBtn');
    const helpTooltip = document.getElementById('helpTooltip');

    let isHoveringHelp = false;

    helpBtn.addEventListener('mouseenter', () => {
        isHoveringHelp = true;
        helpTooltip.classList.add('show');
    });

    helpTooltip.addEventListener('mouseenter', () => {
        isHoveringHelp = true;
        helpTooltip.classList.add('show');
    });

    helpBtn.addEventListener('mouseleave', () => {
        isHoveringHelp = false;
        setTimeout(() => {
            if (!isHoveringHelp) {
                helpTooltip.classList.remove('show');
            }
        }, 100);
    });

    helpTooltip.addEventListener('mouseleave', () => {
        isHoveringHelp = false;
        setTimeout(() => {
            if (!isHoveringHelp) {
                helpTooltip.classList.remove('show');
            }
        }, 100);
    });

    log('Build Scenario Parameters Manager script initialized.');
    setActiveTab(activeTab);
    updateBuildTable();
    updateAdditionalTable();
    updateGlobalVarsTable();
}());
