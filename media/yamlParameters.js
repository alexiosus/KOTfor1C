// Файл: media/yamlParameters.js
// Скрипт для управления интерфейсом Compilation and run parameters

(function() {
    const vscode = acquireVsCodeApi();
    const persistedState = vscode.getState() || {};
    let paneSizes = persistedState.paneSizes;
    const paneSplitter = window.KotWebviewSplit?.attach(document.querySelector('.parameters-workspace'), paneSizes, sizes => {
        paneSizes = sizes; persistPanelState();
    });
    let buildParameters = window.__buildParameters || [];
    let additionalVanessaParameters = window.__additionalParameters || [];
    let globalVanessaVariables = window.__globalVanessaVariables || [];
    let profiles = Array.isArray(window.__profiles) ? window.__profiles : [];
    let activeProfileId = String(window.__activeProfileId || '');
    const defaultBuildParameters = window.__defaultBuildParameters || [];
    const buildParameterDefinitions = Array.isArray(window.__buildParameterDefinitions) ? window.__buildParameterDefinitions : [];
    let additionalParameterDefinitions = Array.isArray(window.__vanessaParameterDefinitions) ? window.__vanessaParameterDefinitions : [];
    let additionalCatalogStatus = window.__vanessaCatalogStatus || '';
    let expectedCatalogRevision = 0;
    const fixedBuildParameterKeys = new Set((window.__fixedBuildParameterKeys || []).map(key => normalizeBuildKey(key)));
    function inspectParameter(event) {
        const row = event.target instanceof HTMLElement ? event.target.closest('tr[data-index]') : null;
        const additional = row?.closest('#additionalParametersTable');
        if (!row || (!row.closest('#buildParametersTable') && !additional)) { return; }
        const key = row.querySelector('.param-key')?.value || '';
        const title = document.getElementById('parameterInspectorTitle');
        const description = document.getElementById('parameterInspectorDescription');
        if (!title || !description) { return; }
        const definition = additional ? getAdditionalParameterDefinition(key) : getBuildParameterDefinition(key);
        title.textContent = key || uiLoc.paramNamePlaceholder;
        description.textContent = definition?.description || (additional ? uiLoc.customVanessaParameterDescription : uiLoc.customBuildParameterDescription);
        const meta = document.getElementById('parameterInspectorMeta');
        if (meta) { meta.textContent = additional ? [definition?.valueKind !== 'unknown' ? definition?.valueKind || row.dataset.valueKind : row.dataset.valueKind, ...(definition?.aliases || [])].filter(Boolean).join(' · ') : ''; }
        document.querySelectorAll('tr.is-inspected').forEach(candidate => candidate.classList.remove('is-inspected'));
        row.classList.add('is-inspected');
    }
    document.addEventListener('focusin', inspectParameter, true);
    document.addEventListener('click', inspectParameter, true);
    document.addEventListener('input', inspectParameter, true);
    const launchInfobaseBuildParameterOptions = ['LaunchDBFolder', 'TestClientDBPath', 'InfobasePath', 'TestClientDB'];
    const buildState = window.KotYamlBuildParameterState;
    const uiLoc = {
        paramNamePlaceholder: document.body.dataset.paramNamePlaceholder || 'Parameter name',
        paramValuePlaceholder: document.body.dataset.paramValuePlaceholder || 'Parameter value',
        removeParameter: document.body.dataset.removeParameter || 'Remove parameter',
        overrideTitle: document.body.dataset.overrideTitle || 'When enabled, this value replaces an existing value in the generated Vanessa JSON. Otherwise, it is added only when the key is absent.',
        fixedBuildParameterHint: document.body.dataset.fixedBuildParameterHint || 'This parameter is fixed and cannot be removed.',
        resetBuildParameterValue: document.body.dataset.resetBuildParameterValue || 'Reset value to default',
        genericBuildParameterDescription: document.body.dataset.genericBuildParameterDescription || 'Additional SPPR parameter passed to СборкаТекстовСценариев.',
        addBuildParameter: document.body.dataset.addBuildParameter || 'Add build parameter',
        noMatchingBuildParameters: document.body.dataset.noMatchingBuildParameters || 'No parameters found',
        customBuildParameterDescription: document.body.dataset.customBuildParameterDescription || 'User parameter added manually and passed to SPPR processing.',
        customVanessaParameterDescription: document.body.dataset.customVanessaParameterDescription || 'Custom parameter passed to Vanessa Automation.',
        expectedBoolean: document.body.dataset.expectedBoolean || 'Choose true or false.',
        expectedNumber: document.body.dataset.expectedNumber || 'Enter a finite number.',
        expectedArray: document.body.dataset.expectedArray || 'Enter a JSON array.',
        expectedObject: document.body.dataset.expectedObject || 'Enter a JSON object.',
        expectedString: document.body.dataset.expectedString || 'Enter a string.',
        unsupportedVanessaParameter: document.body.dataset.unsupportedVanessaParameter || 'This parameter is absent from the selected Vanessa sources. Check version compatibility.',
        addCustomBuildParameter: document.body.dataset.addCustomBuildParameter || 'Add custom parameter',
        profileNamePrompt: document.body.dataset.profileNamePrompt || 'Profile name',
        createProfileTitle: document.body.dataset.createProfileTitle || 'Create profile',
        duplicateProfileTitle: document.body.dataset.duplicateProfileTitle || 'Duplicate profile',
        renameProfileTitle: document.body.dataset.renameProfileTitle || 'Rename profile',
        deleteProfileConfirmation: document.body.dataset.deleteProfileConfirmation || 'Delete profile "{0}"?',
        deleteProfileBlocked: document.body.dataset.deleteProfileBlocked || 'At least one profile must remain.',
        updatedAt: document.body.dataset.updatedAt || 'Updated at',
        neverSaved: document.body.dataset.neverSaved || 'n/a',
        selectProfile: document.body.dataset.selectProfile || 'Select profile',
        cancel: document.body.dataset.cancel || 'Cancel',
        ok: document.body.dataset.ok || 'OK',
        duplicateProfileDefaultName: document.body.dataset.duplicateProfileDefaultName || '{0} copy',
        autosaveEnabled: document.body.dataset.autosaveEnabled || 'Auto-save',
        saving: document.body.dataset.saving || 'Saving...',
        saved: document.body.dataset.saved || 'Saved',
        savedWithIssues: document.body.dataset.savedWithIssues || 'Saved with issues',
        autosaveError: document.body.dataset.autosaveError || 'Auto-save error'
    };
    const priorityTooltip = document.getElementById('priorityTooltip');
    let priorityHover = null;
    let priorityFocus = null;
    let priorityDismissed = false;
    function updatePriorityTooltip() {
        if (!priorityTooltip) { return; }
        const trigger = priorityHover || priorityFocus;
        priorityTooltip.hidden = !trigger || priorityDismissed;
        if (priorityTooltip.hidden) { return; }
        const anchor = trigger.getBoundingClientRect();
        const rect = priorityTooltip.getBoundingClientRect();
        const left = Math.max(12, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 12));
        const below = anchor.bottom + 8;
        const top = below + rect.height <= window.innerHeight - 12 ? below : anchor.top - rect.height - 8;
        priorityTooltip.style.left = `${left}px`;
        priorityTooltip.style.top = `${Math.max(12, top)}px`;
    }
    function hidePriorityTooltip() {
        priorityHover = null; priorityFocus = null; priorityDismissed = false;
        if (priorityTooltip) { priorityTooltip.hidden = true; }
    }
    function priorityTrigger(target) { return target instanceof HTMLElement ? target.closest('.priority-heading') : null; }
    document.addEventListener('mouseover', event => {
        const trigger = priorityTrigger(event.target);
        if (trigger && trigger !== priorityHover) { priorityHover = trigger; priorityDismissed = false; updatePriorityTooltip(); }
    });
    document.addEventListener('mouseout', event => {
        const trigger = priorityTrigger(event.target);
        if (trigger && !(event.relatedTarget instanceof HTMLElement && trigger.contains(event.relatedTarget))) {
            priorityHover = null; if (!priorityFocus) { priorityDismissed = false; } updatePriorityTooltip();
        }
    });
    document.addEventListener('focusin', event => {
        const trigger = priorityTrigger(event.target);
        if (trigger) { priorityFocus = trigger; priorityDismissed = false; updatePriorityTooltip(); }
    });
    document.addEventListener('focusout', event => {
        const trigger = priorityTrigger(event.target);
        if (trigger && !(event.relatedTarget instanceof HTMLElement && trigger.contains(event.relatedTarget))) {
            priorityFocus = null; if (!priorityHover) { priorityDismissed = false; } updatePriorityTooltip();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && priorityTooltip && !priorityTooltip.hidden) { priorityDismissed = true; updatePriorityTooltip(); }
    });
    document.addEventListener('click', event => { if (!priorityTrigger(event.target)) { hidePriorityTooltip(); } });
    window.addEventListener('resize', hidePriorityTooltip);
    window.addEventListener('scroll', hidePriorityTooltip, true);
    let activeTab = 'build';
    let modelDbRequestId = 0;
    let modelDbStatusTimer;
    function requestModelDbStatus() {
        const status = document.getElementById('modelDbSettingsStatus');
        if (status) { status.hidden = true; }
        const requestId = ++modelDbRequestId;
        clearTimeout(modelDbStatusTimer);
        modelDbStatusTimer = setTimeout(() => vscode.postMessage({ command: 'inspectModelDbSettings',
            requestId, activeProfileId, parameters: getBuildParametersFromTable() }), 200);
    }
    document.addEventListener('input', event => {
        const row = event.target.closest?.('#buildParametersTableBody tr');
        if (row && ['modeldbsettings', 'modeldbid'].includes(normalizeBuildKey(row.querySelector('.param-key')?.value))) { requestModelDbStatus(); }
    });
    let buildParameterCatalogQuery = '';
    let autoSaveTimer = null;
    let pendingProfileRequest = null;
    let lastAutoSavedStateSignature = '';
    let lastSavedAt = typeof persistedState.lastSavedAt === 'string' ? persistedState.lastSavedAt : '';
    let lastSaveKind = typeof persistedState.lastSaveKind === 'string' ? persistedState.lastSaveKind : 'idle';
    let lastSaveMessage = typeof persistedState.lastSaveMessage === 'string' ? persistedState.lastSaveMessage : '';

    function log(message) {
        console.log('[SPPR compilation parameters]', message);
        vscode.postMessage({ command: 'log', text: '[SPPR compilation parameters] ' + message });
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatText(template, ...args) {
        return String(template || '').replace(/\{(\d+)\}/g, (_, index) => {
            const numericIndex = Number(index);
            return numericIndex >= 0 && numericIndex < args.length ? String(args[numericIndex]) : _;
        });
    }

    function makeProfileId() {
        return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizeProfile(profile, index) {
        const safeProfile = profile && typeof profile === 'object' ? profile : {};
        return {
            id: String(safeProfile.id || '').trim() || (index === 0 ? 'default' : makeProfileId()),
            name: String(safeProfile.name || '').trim() || (index === 0 ? 'Default' : `Profile ${index + 1}`),
            buildParameters: createBuildParameterState(Array.isArray(safeProfile.buildParameters) ? safeProfile.buildParameters : []),
            additionalVanessaParameters: Array.isArray(safeProfile.additionalVanessaParameters) ? safeProfile.additionalVanessaParameters : [],
            globalVanessaVariables: Array.isArray(safeProfile.globalVanessaVariables) ? safeProfile.globalVanessaVariables : []
        };
    }

    function ensureProfilesState() {
        const fallbackProfile = normalizeProfile({
            id: 'default',
            name: 'Default',
            buildParameters,
            additionalVanessaParameters,
            globalVanessaVariables
        }, 0);

        profiles = Array.isArray(profiles) && profiles.length > 0
            ? profiles.map((profile, index) => normalizeProfile(profile, index))
            : [fallbackProfile];

        const uniqueProfiles = [];
        const usedIds = new Set();
        profiles.forEach((profile, index) => {
            let nextId = profile.id;
            while (!nextId || usedIds.has(nextId)) {
                nextId = index === 0 ? 'default' : makeProfileId();
            }
            usedIds.add(nextId);
            uniqueProfiles.push({ ...profile, id: nextId });
        });
        profiles = uniqueProfiles;

        if (!profiles.some(profile => profile.id === activeProfileId)) {
            activeProfileId = profiles[0].id;
        }
    }

    function getActiveProfile() {
        ensureProfilesState();
        return profiles.find(profile => profile.id === activeProfileId) || profiles[0];
    }

    function syncActiveProfileFromTables() {
        const activeProfile = getActiveProfile();
        const nextBuildParameters = createBuildParameterState(getBuildParametersFromTable());
        const nextAdditionalParameters = getAdditionalParametersFromTable();
        const nextGlobalVariables = getGlobalVarsFromTable();
        profiles = profiles.map(profile => profile.id === activeProfile.id
            ? {
                ...profile,
                buildParameters: nextBuildParameters,
                additionalVanessaParameters: nextAdditionalParameters,
                globalVanessaVariables: nextGlobalVariables
            }
            : profile);
    }

    function loadProfileIntoTables(profileId) {
        ensureProfilesState();
        const targetProfile = profiles.find(profile => profile.id === profileId) || profiles[0];
        activeProfileId = targetProfile.id;
        buildParameters = createBuildParameterState(targetProfile.buildParameters);
        additionalVanessaParameters = [...targetProfile.additionalVanessaParameters];
        globalVanessaVariables = [...targetProfile.globalVanessaVariables];
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

    function persistPanelState() {
        vscode.setState({
            lastSavedAt,
            lastSaveKind,
            lastSaveMessage,
            paneSizes
        });
    }

    function renderProfilePicker() {
        const profilePickerBtnLabel = document.getElementById('profilePickerBtnLabel');
        const profilePickerBtn = document.getElementById('profilePickerBtn');
        if (!(profilePickerBtnLabel instanceof HTMLElement) || !(profilePickerBtn instanceof HTMLButtonElement)) {
            return;
        }

        ensureProfilesState();
        const activeProfile = getActiveProfile();
        profilePickerBtnLabel.textContent = activeProfile?.name || uiLoc.selectProfile;
        profilePickerBtn.title = activeProfile?.name || uiLoc.selectProfile;
        profilePickerBtn.disabled = Boolean(pendingProfileRequest);
    }

    function renderUpdatedAtChip() {
        const updatedAtChip = document.getElementById('updatedAtChip');
        const updatedAtLabel = document.getElementById('updatedAtLabel');
        const updatedAtValue = document.getElementById('updatedAtValue');
        if (!(updatedAtChip instanceof HTMLElement) || !(updatedAtLabel instanceof HTMLElement) || !(updatedAtValue instanceof HTMLElement)) {
            return;
        }

        updatedAtChip.dataset.pending = lastSaveKind === 'saving' ? 'true' : 'false';
        updatedAtChip.dataset.state = lastSaveKind;
        updatedAtLabel.textContent = uiLoc.updatedAt;
        updatedAtValue.textContent = lastSavedAt ? formatDateTime(lastSavedAt) : uiLoc.neverSaved;
        updatedAtChip.title = lastSaveMessage || lastSavedAt || '';
        updatedAtValue.title = lastSavedAt || '';
        persistPanelState();
    }

    function setSaveStatus(kind, message, savedAt) {
        lastSaveKind = kind;
        lastSaveMessage = String(message || '');
        if (savedAt) {
            lastSavedAt = String(savedAt);
        }
        renderUpdatedAtChip();
    }

    function resetParameterInspector() {
        const title = document.getElementById('parameterInspectorTitle');
        const description = document.getElementById('parameterInspectorDescription');
        const meta = document.getElementById('parameterInspectorMeta');
        if (title) { title.textContent = uiLoc.paramNamePlaceholder; }
        if (description) { description.textContent = document.querySelector(activeTab === 'additional' ? '#additionalTabPanel .section-description' : '#buildTabPanel .section-description')?.textContent || ''; }
        if (meta) { meta.textContent = ''; }
        const catalog = document.getElementById('parameterCatalogStatus');
        if (catalog) { catalog.textContent = additionalCatalogStatus; catalog.hidden = activeTab !== 'additional'; }
        document.querySelectorAll('tr.is-inspected').forEach(row => row.classList.remove('is-inspected'));
    }

    function getBuildParameterDefinition(key) {
        const normalized = normalizeBuildKey(key);
        return buildParameterDefinitions.find(definition => normalizeBuildKey(definition.key) === normalized) || null;
    }

    function isBooleanBuildParameter(key) {
        return getBuildParameterDefinition(key)?.valueKind === 'boolean';
    }

    function isLaunchInfobaseBuildParameter(key) {
        const normalized = normalizeBuildKey(key);
        return launchInfobaseBuildParameterOptions.some(option => normalizeBuildKey(option) === normalized);
    }

    function getAvailableBuildParameterDefinitions() {
        return buildState.availableDefinitions(getBuildParametersFromTable(), buildParameterDefinitions);
    }

    function isFixedBuildParameter(key) {
        return fixedBuildParameterKeys.has(normalizeBuildKey(key));
    }

    function getDefaultBuildParameterValue(key) {
        return buildState.defaultValue(key, defaultBuildParameters);
    }

    function normalizeVanessaFolderValue(value) {
        const trimmedValue = String(value || '').trim();
        if (!trimmedValue) {
            return '';
        }

        const withoutTrailingSeparators = trimmedValue.replace(/[\\/]+$/, '');
        if (!withoutTrailingSeparators) {
            return trimmedValue;
        }

        const lastSegment = withoutTrailingSeparators.split(/[\\/]/).pop() || '';
        if (/\.epf$/i.test(lastSegment)) {
            const directory = withoutTrailingSeparators.replace(/[\\/][^\\/]+$/, '');
            return directory || '.';
        }

        return withoutTrailingSeparators;
    }

    function normalizeBooleanBuildValue(value) {
        return isTruthyBuildValue(value) ? 'True' : 'False';
    }

    function createBuildParameterState(params) {
        return buildState.normalize(params, defaultBuildParameters);
    }

    function buildRowHtml(param, index) {
        const definition = getBuildParameterDefinition(param.key);
        const policy = buildState.rowPolicy(param.key, buildParameterDefinitions);
        const normalizedKey = normalizeBuildKey(param.key);
        const isLaunchInfobaseParameter = isLaunchInfobaseBuildParameter(param.key);
        const fixed = isFixedBuildParameter(param.key);
        const missingRequired = isRequiredBuildParameterMissing(normalizedKey, buildParameters);
        const keyReadonly = definition ? 'readonly' : '';
        const keyClassName = definition ? 'param-key is-catalog' : 'param-key';
        const description = definition?.description || uiLoc.customBuildParameterDescription;
        const isBooleanParameter = isBooleanBuildParameter(param.key);
        const rawValue = String(param.value ?? '');
        const isNumericParameter = definition?.valueKind === 'number';
        // Native number inputs sanitize malformed values; keep imported drafts as text.
        const numericValue = rawValue === '' || (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawValue) && Number.isFinite(Number(rawValue)));
        const valueInputType = isNumericParameter && numericValue ? 'number' : 'text';
        const numericAttributes = isNumericParameter
            ? `inputmode="decimal" ${definition.min !== undefined ? `min="${definition.min}"` : ''} ${definition.max !== undefined ? `max="${definition.max}"` : ''} step="${definition.step ?? 'any'}"`
            : '';
        const retainedBooleanOption = ['False', 'True'].includes(rawValue) ? ''
            : `<option value="${escapeHtml(rawValue)}" selected>${escapeHtml(rawValue)}</option>`;
        const hintHtml = `<span class="param-hint codicon codicon-info" title="${escapeHtml(description)}" aria-label="${escapeHtml(description)}"></span>`;
        const keyInputHtml = isLaunchInfobaseParameter
            ? `<div class="param-key-select-wrap">
                    <input type="hidden" class="param-key" value="${escapeHtml(param.key || 'LaunchDBFolder')}">
                    <select class="param-bool-select param-key-select param-launch-key-select" aria-label="${escapeHtml(param.key || 'LaunchDBFolder')}">
                        ${(buildState.connectionAliases.some(option => normalizeBuildKey(option) === normalizedKey) ? buildState.connectionAliases : buildState.folderAliases).map(option => `<option value="${escapeHtml(option)}" ${normalizeBuildKey(param.key) === normalizeBuildKey(option) ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
                    </select>
               </div>`
            : `<input type="text" class="${keyClassName}" list="buildParameterSuggestions" value="${escapeHtml(param.key || '')}" placeholder="${escapeHtml(uiLoc.paramNamePlaceholder)}" ${keyReadonly}>`;
        const removeButtonHtml = policy.readOnly ? '' : fixed
            ? `<button class="button-with-icon reset-row-btn" type="button" title="${escapeHtml(uiLoc.resetBuildParameterValue)}" aria-label="${escapeHtml(uiLoc.resetBuildParameterValue)}">
                    <span class="codicon codicon-discard"></span>
               </button>`
            : `<button class="button-with-icon remove-row-btn" title="${escapeHtml(uiLoc.removeParameter)}">
                    <span class="codicon codicon-trash"></span>
               </button>`;
        const valueHtml = isBooleanParameter
            ? `<select class="param-bool-select param-value-bool-select" aria-label="${escapeHtml(param.key || 'AuthCompile')}">
                    ${retainedBooleanOption}
                    <option value="False" ${rawValue === 'False' ? 'selected' : ''}>False</option>
                    <option value="True" ${rawValue === 'True' ? 'selected' : ''}>True</option>
               </select>`
            : `<input type="${valueInputType}" ${numericAttributes} class="param-value ${missingRequired ? 'is-required-missing' : ''}" value="${escapeHtml(param.value || '')}" placeholder="${escapeHtml(uiLoc.paramValuePlaceholder)}" title="${escapeHtml(description)}" ${policy.readOnly ? 'readonly' : ''}>`;

        return `
            <tr data-index="${index}" ${policy.hidden ? 'hidden' : ''} ${fixed ? 'data-fixed="true"' : ''} ${missingRequired ? 'data-required-missing="true"' : ''}>
                <td>
                    <div class="param-key-cell">
                        ${hintHtml}
                        ${keyInputHtml}
                    </div>
                </td>
                <td>
                    ${valueHtml}
                </td>
                <td>
                    ${removeButtonHtml}
                </td>
            </tr>
        `;
    }

    function getAdditionalParameterDefinition(rawKey) {
        const key = String(rawKey || '').trim().replace(/^\//, '').replace(/~[01]/g, token => token === '~1' ? '/' : '~').replace(/\//g, '.').toLocaleLowerCase();
        return additionalParameterDefinitions.find(definition => definition.keys.some(alias => alias.toLocaleLowerCase() === key)) || null;
    }

    function sameAdditionalParameter(first, second) {
        const definition = getAdditionalParameterDefinition(first);
        return (definition && definition === getAdditionalParameterDefinition(second))
            || String(first).trim().toLocaleLowerCase() === String(second).trim().toLocaleLowerCase();
    }

    function additionalValueError(kind, rawValue, sourceKind) {
        const value = String(rawValue ?? '').trim();
        if (sourceKind && kind && kind !== 'unknown' && sourceKind !== kind) {
            return ({ boolean: uiLoc.expectedBoolean, number: uiLoc.expectedNumber, array: uiLoc.expectedArray, object: uiLoc.expectedObject, string: uiLoc.expectedString })[kind];
        }
        if (kind === 'boolean' && !/^(?:true|false)$/i.test(value)) { return uiLoc.expectedBoolean; }
        if (kind === 'number' && (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)))) { return uiLoc.expectedNumber; }
        if (kind === 'array' || kind === 'object') {
            try {
                const parsed = JSON.parse(value);
                if (kind === 'array' ? Array.isArray(parsed) : parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) { return ''; }
            } catch { /* Retain invalid drafts for correction. */ }
            return kind === 'array' ? uiLoc.expectedArray : uiLoc.expectedObject;
        }
        return '';
    }

    function additionalValueHtml(param, typed = true) {
        const declaredKind = typed ? getAdditionalParameterDefinition(param.key)?.valueKind : undefined;
        const kind = typed ? (declaredKind && declaredKind !== 'unknown' ? declaredKind : param.valueKind) : 'unknown';
        const rawValue = String(param.value ?? '');
        const error = additionalValueError(kind, rawValue, param.valueKind);
        const attrs = `class="param-value ${kind === 'boolean' ? 'param-bool-select' : ''}" aria-label="${escapeHtml(param.key || uiLoc.paramValuePlaceholder)}" aria-invalid="${error ? 'true' : 'false'}"`;
        let html;
        if (kind === 'boolean') {
            const valid = /^(?:true|false)$/i.test(rawValue.trim());
            html = `<select ${attrs}>${!valid ? `<option value="${escapeHtml(rawValue)}" selected>${escapeHtml(rawValue)}</option>` : ''}
                ${['true', 'false'].map(value => {
                    const selected = valid && rawValue.trim().toLocaleLowerCase() === value;
                    return `<option value="${escapeHtml(selected ? rawValue : value)}" ${selected ? 'selected' : ''}>${value}</option>`;
                }).join('')}</select>`;
        } else if (kind === 'array' || kind === 'object') {
            html = `<textarea ${attrs} rows="3" spellcheck="false" placeholder="${kind === 'array' ? '[]' : '{}'}">${escapeHtml(rawValue)}</textarea>`;
        } else {
            html = `<input ${attrs} type="${kind === 'number' && (!rawValue || !error) ? 'number' : 'text'}" ${kind === 'number' ? 'step="any" inputmode="decimal"' : ''} value="${escapeHtml(rawValue)}" placeholder="${escapeHtml(uiLoc.paramValuePlaceholder)}">`;
        }
        const unsupported = typed && getAdditionalParameterDefinition(param.key)?.availability === 'unsupported';
        return `${html}<div class="param-value-error" role="status" ${error ? '' : 'hidden'}>${escapeHtml(error)}</div>
            <div class="param-compatibility-warning" role="status" ${unsupported ? '' : 'hidden'}>${escapeHtml(uiLoc.unsupportedVanessaParameter)}</div>`;
    }

    function validateAdditionalValue(row) {
        const field = row?.querySelector('.param-value');
        if (!field) { return; }
        const declaredKind = getAdditionalParameterDefinition(row.querySelector('.param-key')?.value)?.valueKind;
        const error = additionalValueError(declaredKind && declaredKind !== 'unknown' ? declaredKind : row.dataset.valueKind, field.value, row.dataset.valueKind);
        field.setAttribute('aria-invalid', error ? 'true' : 'false');
        const message = row.querySelector('.param-value-error');
        if (message) { message.textContent = error; message.hidden = !error; }
    }

    function additionalRowHtml(param, index, typed = true) {
        const isOverride = Boolean(param.overrideExisting);
        const definition = typed ? getAdditionalParameterDefinition(param.key) : null;
        const options = [...new Set(definition?.keyOptions || [])];
        if (options.length && !options.includes(param.key)) { options.unshift(param.key); }
        const nameHtml = typed && options.length > 1
            ? `<div class="param-key-select-wrap"><input type="hidden" class="param-key" readonly value="${escapeHtml(param.key)}">
                <select class="param-bool-select param-additional-key-select" aria-label="${escapeHtml(param.key)}">
                    ${options.map(key => `<option value="${escapeHtml(key)}" ${key === param.key ? 'selected' : ''}>${escapeHtml(key)}</option>`).join('')}
                </select></div>`
            : `<input type="text" class="param-key ${typed ? 'is-catalog' : ''}" ${typed ? 'readonly' : ''} value="${escapeHtml(param.key || '')}" placeholder="${escapeHtml(uiLoc.paramNamePlaceholder)}">`;
        const hint = typed ? definition?.description || uiLoc.customVanessaParameterDescription : '';
        return `
            <tr data-index="${index}" ${typed && param.valueKind ? `data-value-kind="${escapeHtml(param.valueKind)}" data-original-key="${escapeHtml(param.key)}"` : ''}>
                <td>
                    <div class="param-key-cell">${typed ? `<span class="codicon codicon-info param-hint" tabindex="0" title="${escapeHtml(hint)}" aria-label="${escapeHtml(hint)}"></span>` : ''}${nameHtml}</div>
                </td>
                <td>
                    ${additionalValueHtml(param, typed)}
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

    function normalizeBuildKey(key) {
        return String(key || '')
            .trim()
            .toLocaleLowerCase()
            .replace(/[_\-\s]/g, '');
    }

    function syncBuildParametersStateFromTable() {
        const modelFields = rows => JSON.stringify(rows.filter(row => ['modeldbsettings', 'modeldbid'].includes(normalizeBuildKey(row.key))));
        const previous = modelFields(buildParameters);
        buildParameters = createBuildParameterState(getBuildParametersFromTable());
        if (previous !== modelFields(buildParameters)) { requestModelDbStatus(); }
    }

    function isTruthyBuildValue(value) {
        const normalized = String(value || '').trim().toLocaleLowerCase();
        return normalized === 'true' || normalized === 'истина';
    }

    function getBuildParameterMap(params) {
        const paramMap = new Map();
        params.forEach(param => {
            const normalizedKey = normalizeBuildKey(param.key);
            if (!normalizedKey || paramMap.has(normalizedKey)) {
                return;
            }
            paramMap.set(normalizedKey, String(param.value || '').trim());
        });
        return paramMap;
    }

    function isRequiredBuildParameterMissing(normalizedKey, params) {
        return buildState.requiredMissing(normalizedKey, params);
    }

    function updateBuildRequiredFieldHighlighting() {
        const body = getTableBody('buildParametersTableBody');
        if (!body) {
            return;
        }
        const buildParams = getBuildParametersFromTable();
        body.querySelectorAll('tr').forEach(row => {
            const keyInput = row.querySelector('.param-key');
            const valueInput = row.querySelector('.param-value');
            if (!(keyInput instanceof HTMLInputElement)) {
                return;
            }

            const missingRequired = isRequiredBuildParameterMissing(normalizeBuildKey(keyInput.value), buildParams);
            row.toggleAttribute('data-required-missing', missingRequired);
            if (valueInput instanceof HTMLInputElement) {
                valueInput.classList.toggle('is-required-missing', missingRequired);
            }
        });
    }

    function setBuildParameterCatalogOpen(isOpen) {
        const container = document.getElementById('buildParameterCatalogPicker');
        const trigger = document.getElementById('buildParameterCatalogTrigger');
        const searchInput = document.getElementById('buildParameterCatalogSearchInput');
        if (!container || !(trigger instanceof HTMLButtonElement)) {
            return;
        }

        container.classList.toggle('show', isOpen);
        trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

        if (isOpen) {
            renderBuildParameterCatalogList();
            if (searchInput instanceof HTMLInputElement) {
                searchInput.focus();
                searchInput.select();
            }
        }
    }

    function shouldOfferCustomBuildParameter(query, availableDefinitions) {
        const trimmedQuery = query.trim();
        if (!trimmedQuery) {
            return false;
        }

        const normalizedQuery = normalizeBuildKey(trimmedQuery);
        if (!normalizedQuery) {
            return false;
        }

        return !buildParameterDefinitions.some(definition => normalizeBuildKey(definition.key) === normalizedQuery)
            && buildState.canAddParameter(trimmedQuery, getBuildParametersFromTable(), buildParameterDefinitions);
    }

    function renderBuildParameterCatalogList() {
        const listNode = document.getElementById('buildParameterCatalogList');
        if (!listNode) {
            return;
        }

        const query = buildParameterCatalogQuery.trim().toLocaleLowerCase();
        const availableDefinitions = getAvailableBuildParameterDefinitions();
        const definitions = availableDefinitions.filter(definition => {
            if (!query) {
                return true;
            }
            return definition.key.toLocaleLowerCase().includes(query)
                || String(definition.description || '').toLocaleLowerCase().includes(query);
        });

        const items = definitions.map(definition => `
                <button
                    type="button"
                    class="catalog-picker-option"
                    data-key="${escapeHtml(definition.key)}"
                    role="option"
                    aria-selected="false"
                    title="${escapeHtml(definition.description || uiLoc.genericBuildParameterDescription)}"
                >
                    <span class="catalog-picker-option-key">${escapeHtml(definition.key)}</span>
                    <span class="catalog-picker-option-description">${escapeHtml(definition.description || uiLoc.genericBuildParameterDescription)}</span>
                </button>
        `);

        if (shouldOfferCustomBuildParameter(buildParameterCatalogQuery, availableDefinitions)) {
            items.unshift(`
                <button
                    type="button"
                    class="catalog-picker-option is-custom"
                    data-custom-key="${escapeHtml(buildParameterCatalogQuery.trim())}"
                    role="option"
                    aria-selected="false"
                    title="${escapeHtml(uiLoc.customBuildParameterDescription)}"
                >
                    <span class="catalog-picker-option-key">${escapeHtml(uiLoc.addCustomBuildParameter)}: ${escapeHtml(buildParameterCatalogQuery.trim())}</span>
                    <span class="catalog-picker-option-description">${escapeHtml(uiLoc.customBuildParameterDescription)}</span>
                </button>
            `);
        }

        if (items.length === 0) {
            listNode.innerHTML = `<div class="catalog-picker-empty">${escapeHtml(uiLoc.noMatchingBuildParameters)}</div>`;
            return;
        }

        listNode.innerHTML = items.join('');
    }

    function updateBuildParameterCatalogOptions() {
        renderBuildParameterCatalogList();
    }

    function addBuildParameterByKey(key) {
        const trimmedKey = String(key || '').trim();
        if (!trimmedKey || !buildState.canAddParameter(trimmedKey, getBuildParametersFromTable(), buildParameterDefinitions)) {
            return;
        }

        buildParameters = createBuildParameterState([
            ...getBuildParametersFromTable(),
            { key: trimmedKey, value: '' }
        ]);
        buildParameterCatalogQuery = '';
        updateBuildTable();
        const body = getTableBody('buildParametersTableBody');
        const addedRow = body?.querySelector(`tr[data-index="${buildParameters.length - 1}"] .param-value, tr[data-index="${buildParameters.length - 1}"] .param-value-bool-select`);
        if (addedRow instanceof HTMLInputElement) {
            addedRow.focus();
        } else if (addedRow instanceof HTMLSelectElement) {
            addedRow.focus();
        }
        const searchInput = document.getElementById('buildParameterCatalogSearchInput');
        if (searchInput instanceof HTMLInputElement) {
            searchInput.value = '';
        }
        setBuildParameterCatalogOpen(false);
        scheduleAutoSave();
    }

    function getSearchInput(tabName) {
        if (tabName === 'additional') {
            return document.getElementById('additionalSearchInput');
        }
        if (tabName === 'globalVars') {
            return document.getElementById('globalVarsSearchInput');
        }
        return document.getElementById('buildSearchInput');
    }

    function getSearchClearButton(tabName) {
        if (tabName === 'additional') {
            return document.getElementById('additionalSearchClearBtn');
        }
        if (tabName === 'globalVars') {
            return document.getElementById('globalVarsSearchClearBtn');
        }
        return document.getElementById('buildSearchClearBtn');
    }

    function getTableBodyByTab(tabName) {
        if (tabName === 'additional') {
            return getTableBody('additionalParametersTableBody');
        }
        if (tabName === 'globalVars') {
            return getTableBody('globalVarsTableBody');
        }
        return getTableBody('buildParametersTableBody');
    }

    function applySearchFilter(tabName) {
        const body = getTableBodyByTab(tabName);
        if (!body) {
            return;
        }

        const searchInput = getSearchInput(tabName);
        const query = (searchInput && 'value' in searchInput)
            ? String(searchInput.value || '').trim().toLocaleLowerCase()
            : '';

        body.querySelectorAll('tr').forEach(row => {
            const keyInput = row.querySelector('.param-key');
            const keyText = (keyInput && 'value' in keyInput)
                ? String(keyInput.value || '').toLocaleLowerCase()
                : '';
            const policyHidden = tabName === 'build' && buildState.rowPolicy(keyInput?.value || '', buildParameterDefinitions).hidden;
            const names = tabName === 'additional' ? [keyText, ...(getAdditionalParameterDefinition(keyInput?.value)?.keys || [])] : [keyText];
            row.hidden = policyHidden || (query.length > 0 && !names.some(name => name.toLocaleLowerCase().includes(query)));
        });

        const clearButton = getSearchClearButton(tabName);
        if (clearButton) {
            clearButton.classList.toggle('visible', query.length > 0);
        }
    }

    function clearSearch(tabName) {
        const input = getSearchInput(tabName);
        if (!(input instanceof HTMLInputElement)) {
            return;
        }
        input.value = '';
        applySearchFilter(tabName);
        input.focus();
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
            const boolSelect = row.querySelector('.param-value-bool-select');
            if (keyInput && keyInput.value.trim()) {
                params.push({
                    key: keyInput.value.trim(),
                    value: boolSelect instanceof HTMLSelectElement
                        ? boolSelect.value
                        : (valueInput instanceof HTMLInputElement ? valueInput.value : '')
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
                    value: valueInput.value,
                    overrideExisting: Boolean(overrideInput && overrideInput.checked),
                    ...(row.dataset.valueKind ? { valueKind: row.dataset.valueKind } : {})
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

    function resetFixedBuildParameterRow(row) {
        if (!(row instanceof HTMLTableRowElement)) {
            return;
        }

        const keyInput = row.querySelector('.param-key');
        if (!(keyInput instanceof HTMLInputElement)) {
            return;
        }

        const keyValue = keyInput.value.trim();
        const defaultValue = getDefaultBuildParameterValue(keyValue);
        const boolSelect = row.querySelector('.param-value-bool-select');
        const textInput = row.querySelector('.param-value');

        if (boolSelect instanceof HTMLSelectElement) {
            boolSelect.value = normalizeBooleanBuildValue(defaultValue || 'False');
        } else if (textInput instanceof HTMLInputElement) {
            textInput.value = defaultValue;
        }

        syncBuildParametersStateFromTable();
        updateBuildRequiredFieldHighlighting();
        applySearchFilter('build');
        scheduleAutoSave();
    }

    function updateBuildTable() {
        const body = getTableBody('buildParametersTableBody');
        if (!body) {
            return;
        }
        buildParameters = createBuildParameterState(buildParameters);
        body.innerHTML = buildParameters.map((param, index) => buildRowHtml(param, index)).join('');
        const inspectorTitle = document.getElementById('parameterInspectorTitle');
        const inspectorDescription = document.getElementById('parameterInspectorDescription');
        if (inspectorTitle) { inspectorTitle.textContent = uiLoc.paramNamePlaceholder; }
        if (inspectorDescription) { inspectorDescription.textContent = document.querySelector('#buildTabPanel .section-description')?.textContent || ''; }
        updateBuildRequiredFieldHighlighting();
        updateBuildParameterCatalogOptions();
        applySearchFilter('build');
        requestModelDbStatus();
    }

    function updateAdditionalTable() {
        const body = getTableBody('additionalParametersTableBody');
        if (!body) {
            return;
        }
        body.innerHTML = additionalVanessaParameters.map((param, index) => additionalRowHtml(param, index)).join('');
        if (activeTab === 'additional') { resetParameterInspector(); }
        applySearchFilter('additional');
    }

    function updateGlobalVarsTable() {
        const body = getTableBody('globalVarsTableBody');
        if (!body) {
            return;
        }
        body.innerHTML = globalVanessaVariables.map((param, index) => additionalRowHtml(param, index, false)).join('');
        applySearchFilter('globalVars');
    }

    function appendAdditionalRow(parameter = { key: '', value: '', overrideExisting: false }) {
        const body = getTableBody('additionalParametersTableBody');
        if (!body) {
            return;
        }
        const row = document.createElement('tr');
        row.setAttribute('data-index', String(body.children.length));
        if (parameter.valueKind) { row.setAttribute('data-value-kind', parameter.valueKind); row.setAttribute('data-original-key', parameter.key); }
        const rendered = additionalRowHtml(parameter, body.children.length);
        row.innerHTML = rendered.slice(rendered.indexOf('>') + 1, rendered.lastIndexOf('</tr>'));
        body.appendChild(row);
        row.querySelector('.param-key').value = parameter.key;
        row.querySelector('.param-override').checked = Boolean(parameter.overrideExisting);
        row.querySelector(parameter.key ? '.param-value' : '.param-key')?.focus();
        applySearchFilter('additional');
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
        applySearchFilter('globalVars');
    }

    function getCurrentState() {
        syncActiveProfileFromTables();
        return {
            activeProfileId,
            profiles: profiles.map(profile => ({
                id: profile.id,
                name: profile.name,
                buildParameters: profile.buildParameters,
                additionalVanessaParameters: profile.additionalVanessaParameters,
                globalVanessaVariables: profile.globalVanessaVariables
            }))
        };
    }

    function getCurrentStateSignature() {
        return JSON.stringify(getCurrentState());
    }

    function flushAutoSave() {
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
        if (pendingProfileRequest) { return; }
        const state = getCurrentState();
        const nextSignature = JSON.stringify(state);
        if (nextSignature === lastAutoSavedStateSignature) {
            return;
        }

        setSaveStatus('saving', uiLoc.saving);
        lastAutoSavedStateSignature = nextSignature;
        vscode.postMessage({
            command: 'autoSaveParameters',
            activeProfileId: state.activeProfileId,
            profiles: state.profiles
        });
    }

    function scheduleAutoSave(delayMs = 500) {
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
        }
        autoSaveTimer = setTimeout(() => flushAutoSave(), delayMs);
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
        const inspector = document.getElementById('parameterInspector');
        if (inspector) { inspector.hidden = showGlobalVars; }
        document.querySelector('.parameters-workspace')?.classList.toggle('has-build-inspector', !showGlobalVars);
        resetParameterInspector();
        paneSplitter?.update();
    }

    function applyProfilesResponse(message) {
        let hasLocalEdits = false;
        const localState = pendingProfileRequest && message.requestId === pendingProfileRequest.id ? getCurrentState() : null;
        profiles = Array.isArray(message.profiles) ? message.profiles.map(profile => {
            const original = pendingProfileRequest?.profiles.find(item => item.id === profile.id);
            const local = localState?.profiles.find(item => item.id === profile.id);
            if (!original || !local) { return profile; }
            const merged = { ...profile };
            for (const section of ['buildParameters', 'additionalVanessaParameters', 'globalVanessaVariables']) {
                if (JSON.stringify(local[section]) !== JSON.stringify(original[section])) {
                    merged[section] = local[section];
                    hasLocalEdits = true;
                }
            }
            return merged;
        }) : profiles;
        activeProfileId = String(message.activeProfileId || activeProfileId);
        if (message.requestId === pendingProfileRequest?.id) { pendingProfileRequest = null; }
        return hasLocalEdits;
    }

    function manageProfiles() {
        if (pendingProfileRequest) { return; }
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
        const state = getCurrentState();
        pendingProfileRequest = { id: makeProfileId(), profiles: JSON.parse(JSON.stringify(state.profiles)) };
        renderProfilePicker();
        setSaveStatus('saving', uiLoc.saving);
        vscode.postMessage({
            command: 'manageProfiles',
            requestId: pendingProfileRequest.id,
            activeProfileId: state.activeProfileId,
            profiles: state.profiles
        });
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
        const resetBtn = event.target.closest('.reset-row-btn');
        if (resetBtn) {
            const row = resetBtn.closest('tr');
            if (row instanceof HTMLTableRowElement) {
                resetFixedBuildParameterRow(row);
            }
            return;
        }

        const clearSearchBtn = event.target.closest('.search-clear-btn');
        if (clearSearchBtn) {
            if (clearSearchBtn.id === 'buildSearchClearBtn') {
                clearSearch('build');
                return;
            }
            if (clearSearchBtn.id === 'additionalSearchClearBtn') {
                clearSearch('additional');
                return;
            }
            if (clearSearchBtn.id === 'globalVarsSearchClearBtn') {
                clearSearch('globalVars');
                return;
            }
        }

        const removeBtn = event.target.closest('.remove-row-btn');
        if (removeBtn) {
            if (removeBtn.hasAttribute('disabled')) {
                return;
            }
            const row = removeBtn.closest('tr');
            const body = row?.parentElement;
            if (row && body) {
                row.remove();
                if (body.id) {
                    updateRowIndices(body.id);
                    if (body.id === 'buildParametersTableBody') {
                        syncBuildParametersStateFromTable();
                        updateBuildRequiredFieldHighlighting();
                        updateBuildParameterCatalogOptions();
                    }
                }
                scheduleAutoSave();
            }
            return;
        }

        const catalogTrigger = event.target.closest('#buildParameterCatalogTrigger');
        if (catalogTrigger) {
            const container = document.getElementById('buildParameterCatalogPicker');
            if (container) {
                const willOpen = !container.classList.contains('show');
                if (willOpen) {
                    buildParameterCatalogQuery = '';
                    const searchInput = document.getElementById('buildParameterCatalogSearchInput');
                    if (searchInput instanceof HTMLInputElement) {
                        searchInput.value = '';
                    }
                }
                setBuildParameterCatalogOpen(willOpen);
            }
            return;
        }

        const catalogOption = event.target.closest('.catalog-picker-option');
        if (catalogOption instanceof HTMLButtonElement) {
            const customKey = catalogOption.dataset.customKey || '';
            const parameterKey = customKey || catalogOption.dataset.key || '';
            addBuildParameterByKey(parameterKey);
            return;
        }

        document.querySelectorAll('.dropdown-container.show').forEach(container => {
            if (!container.contains(event.target)) {
                container.classList.remove('show');
                const trigger = container.querySelector('#buildParameterCatalogTrigger');
                if (trigger instanceof HTMLButtonElement) {
                    trigger.setAttribute('aria-expanded', 'false');
                }
            }
        });
    });

    document.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
            return;
        }

        if (target.id === 'buildSearchInput') {
            applySearchFilter('build');
            return;
        }
        if (target.id === 'buildParameterCatalogSearchInput') {
            buildParameterCatalogQuery = target.value || '';
            renderBuildParameterCatalogList();
            return;
        }
        if (target.id === 'additionalSearchInput') {
            applySearchFilter('additional');
            return;
        }
        if (target.id === 'globalVarsSearchInput') {
            applySearchFilter('globalVars');
            return;
        }

        if (!target.classList.contains('param-key')) {
            if (target.classList.contains('param-value')) {
                const body = target.closest('tbody');
                if (body?.id === 'additionalParametersTableBody') {
                    const row = target.closest('tr');
                    const kind = getAdditionalParameterDefinition(row.querySelector('.param-key')?.value)?.valueKind;
                    if (kind && kind !== 'unknown') { row.setAttribute('data-value-kind', kind); row.setAttribute('data-original-key', row.querySelector('.param-key').value.trim()); }
                    validateAdditionalValue(row);
                }
                if (body?.id === 'buildParametersTableBody') {
                    syncBuildParametersStateFromTable();
                    updateBuildRequiredFieldHighlighting();
                    updateBuildParameterCatalogOptions();
                }
                scheduleAutoSave(800);
            }
            return;
        }
        const body = target.closest('tbody');
        if (!body) {
            return;
        }
        if (body.id === 'buildParametersTableBody') {
            syncBuildParametersStateFromTable();
            updateBuildRequiredFieldHighlighting();
            updateBuildParameterCatalogOptions();
            applySearchFilter('build');
            scheduleAutoSave(800);
            return;
        }
        if (body.id === 'additionalParametersTableBody') {
            const row = target.closest('tr');
            if (row.dataset.originalKey && row.dataset.originalKey !== target.value.trim()) { row.setAttribute('data-value-kind', ''); }
            applySearchFilter('additional');
            scheduleAutoSave(800);
            return;
        }
        if (body.id === 'globalVarsTableBody') {
            applySearchFilter('globalVars');
            scheduleAutoSave(800);
        }
    });

    document.addEventListener('change', (event) => {
        const target = event.target;
        if (target instanceof HTMLSelectElement && target.classList.contains('param-value') && target.closest('tbody')?.id === 'additionalParametersTableBody') {
            const row = target.closest('tr');
            row.setAttribute('data-value-kind', 'boolean'); row.setAttribute('data-original-key', row.querySelector('.param-key').value.trim());
            validateAdditionalValue(target.closest('tr')); scheduleAutoSave(); return;
        }
        if (!(target instanceof HTMLSelectElement)) {
            return;
        }

        if (target.classList.contains('param-additional-key-select')) {
            const row = target.closest('tr');
            const keyInput = row?.querySelector('.param-key');
            if (keyInput && sameAdditionalParameter(keyInput.value, target.value)) {
                keyInput.value = target.value;
                if (row.dataset.originalKey) { row.setAttribute('data-original-key', target.value); }
                inspectParameter({ target }); applySearchFilter('additional'); scheduleAutoSave();
            }
            return;
        }

        if (target.classList.contains('param-launch-key-select')) {
            const keyCell = target.closest('.param-key-select-wrap');
            const hiddenKeyInput = keyCell?.querySelector('.param-key');
            if (hiddenKeyInput instanceof HTMLInputElement) {
                hiddenKeyInput.value = target.value;
            }
            syncBuildParametersStateFromTable();
            updateBuildRequiredFieldHighlighting();
            updateBuildParameterCatalogOptions();
            applySearchFilter('build');
            scheduleAutoSave();
            return;
        }

        if (target.classList.contains('param-value-bool-select')) {
            const body = target.closest('tbody');
            if (body?.id === 'buildParametersTableBody') {
                syncBuildParametersStateFromTable();
                updateBuildTable();
                scheduleAutoSave();
            }
            return;
        }

        if (target.classList.contains('param-key-select')) {
            scheduleAutoSave();
        }
    });

    document.addEventListener('change', (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement) {
            if (
                target.classList.contains('param-key')
                || target.classList.contains('param-value')
                || target.classList.contains('param-override')
            ) {
                scheduleAutoSave();
            }
        }
    });

    document.getElementById('addAdditionalRowBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'selectAdditionalParameter', keys: getAdditionalParametersFromTable().map(row => row.key) });
    });

    document.getElementById('addGlobalVarRowBtn').addEventListener('click', () => {
        log('Add GlobalVar parameter button clicked.');
        appendGlobalVarRow();
        scheduleAutoSave();
    });

    document.getElementById('profilePickerBtn')?.addEventListener('click', () => {
        manageProfiles();
    });

    document.getElementById('openGeneratedYamlBtn').addEventListener('click', (e) => {
        e.preventDefault();
        log('Open generated yaml_parameters.json button clicked.');
        vscode.postMessage({
            command: 'openGeneratedYamlParametersFile',
            buildParameters: getBuildParametersFromTable()
        });
        document.getElementById('moreActionsBtn')?.closest('.dropdown-container')?.classList.remove('show');
    });

    setupDropdown('moreActionsBtn');

    document.getElementById('createBuildFileBtn').addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({
            command: 'createYamlFile',
            buildParameters: getBuildParametersFromTable()
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
        buildParameters = createBuildParameterState([...defaultBuildParameters]);
        updateBuildTable();
        scheduleAutoSave();
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
        scheduleAutoSave();
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
        scheduleAutoSave();
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
            case 'refreshModelDbSettings':
                requestModelDbStatus();
                break;
            case 'modelDbSettingsStatus': {
                if (message.requestId !== modelDbRequestId || message.activeProfileId !== activeProfileId) { break; }
                const status = document.getElementById('modelDbSettingsStatus');
                if (status) {
                    status.textContent = message.message;
                    status.hidden = false;
                    status.dataset.state = message.state;
                }
                break;
            }
            case 'appendAdditionalParameter':
                if (message.activeProfileId && message.activeProfileId !== activeProfileId) { break; }
                if (typeof message.catalogStatus === 'string') { additionalCatalogStatus = message.catalogStatus; }
                if (Array.isArray(message.definitions)) {
                    additionalVanessaParameters = getAdditionalParametersFromTable();
                    additionalParameterDefinitions = message.definitions; updateAdditionalTable();
                }
                if (message.parameter && !getAdditionalParametersFromTable().some(row => sameAdditionalParameter(row.key, message.parameter.key))) {
                    appendAdditionalRow(message.parameter);
                    scheduleAutoSave();
                }
                break;
            case 'vanessaParameterDefinitionsUpdated':
                if (message.activeProfileId !== activeProfileId || message.revision !== expectedCatalogRevision || !Array.isArray(message.definitions)) { break; }
                additionalVanessaParameters = getAdditionalParametersFromTable();
                additionalParameterDefinitions = message.definitions;
                additionalCatalogStatus = String(message.catalogStatus || '');
                updateAdditionalTable();
                break;
            case 'loadBuildParameters':
                log('Loading build parameters from extension.');
                buildParameters = createBuildParameterState(message.buildParameters || []);
                updateBuildTable();
                scheduleAutoSave();
                break;
            case 'loadAdditionalParameters':
                log('Loading additional Vanessa parameters from extension.');
                additionalVanessaParameters = message.additionalParameters || [];
                updateAdditionalTable();
                scheduleAutoSave();
                break;
            case 'loadGlobalVanessaVariables':
                log('Loading GlobalVars from extension.');
                globalVanessaVariables = message.globalVanessaVariables || [];
                updateGlobalVarsTable();
                scheduleAutoSave();
                break;
            case 'loadParameters':
                // Legacy fallback message support.
                log('Loading legacy parameter payload from extension.');
                buildParameters = createBuildParameterState(message.parameters || []);
                updateBuildTable();
                scheduleAutoSave();
                break;
            case 'profilesStateUpdated': {
                expectedCatalogRevision = message.catalogRevision ?? expectedCatalogRevision;
                additionalParameterDefinitions = additionalParameterDefinitions.map(definition => ({ ...definition, availability: 'unverified' }));
                additionalCatalogStatus = '';
                const hasLocalEdits = applyProfilesResponse(message);
                ensureProfilesState();
                loadProfileIntoTables(activeProfileId);
                renderProfilePicker();
                updateBuildTable();
                updateAdditionalTable();
                updateGlobalVarsTable();
                applySearchFilter('build');
                applySearchFilter('additional');
                applySearchFilter('globalVars');
                lastAutoSavedStateSignature = hasLocalEdits ? '' : getCurrentStateSignature();
                if (message.kind === 'warning') {
                    setSaveStatus('warning', message.message || uiLoc.savedWithIssues, message.savedAt);
                } else if (message.kind === 'error') {
                    setSaveStatus('error', message.message || uiLoc.autosaveError, message.savedAt);
                } else {
                    setSaveStatus('saved', message.message || uiLoc.saved, message.savedAt);
                }
                if (hasLocalEdits) { setSaveStatus('saving', uiLoc.saving); scheduleAutoSave(); }
                break;
            }
            case 'saveStatus':
                if (pendingProfileRequest && message.requestId !== pendingProfileRequest.id) { break; }
                if (pendingProfileRequest && message.requestId === pendingProfileRequest.id) {
                    pendingProfileRequest = null; renderProfilePicker(); scheduleAutoSave();
                }
                if (message.kind === 'warning') {
                    setSaveStatus('warning', message.message || uiLoc.savedWithIssues, message.savedAt);
                } else if (message.kind === 'error') {
                    setSaveStatus('error', message.message || uiLoc.autosaveError);
                } else {
                    setSaveStatus('saved', message.message || uiLoc.saved, message.savedAt);
                }
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

    log('Compilation and run parameters script initialized.');
    ensureProfilesState();
    loadProfileIntoTables(activeProfileId);
    renderProfilePicker();
    setActiveTab(activeTab);
    updateBuildTable();
    updateAdditionalTable();
    updateGlobalVarsTable();
    applySearchFilter('build');
    applySearchFilter('additional');
    applySearchFilter('globalVars');
    lastAutoSavedStateSignature = getCurrentStateSignature();
    renderUpdatedAtChip();
}());
