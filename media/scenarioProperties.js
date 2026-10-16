(function () {
    'use strict';
    const root = document.getElementById('scenario-properties');
    const protocol = globalThis.ScenarioPropertiesProtocol;
    if (!root || !protocol) { return; }
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState() || {};
    const collapsed = { ...(saved.collapsed || {}) };
    const drafts = new Map();
    const controls = new Map();
    const committers = new Map();
    const CREATE_CHOICE = '__kot_create_choice__';
    function persistViewState() { vscode.setState({ ...saved, collapsed, activeTab }); }
    const DRAG_TYPE = 'application/vnd.kot.property-record';
    let state = null;
    let labels = protocol.DEFAULT_LABELS;
    let status = null;
    let nextId = 0;
    const titleMeasurements = [];
    const scrollingTitles = new Map();
    let scrollingFrame;
    const disclosureAnimations = new Set();
    let activeTab = saved.activeTab || 'properties';
    let filesState = null;
    let filesContent = null;
    let filesCount = null;
    let fileDragDepth = 0;
    const fileProtocol = globalThis.KotScenarioFilesProtocol;
    const fileTransferSources = new Map();
    const fileTransfers = fileProtocol?.createTransferController(message => {
        const sourceUri = message.itemId || fileTransferSources.get(message.transferId);
        if (sourceUri) { vscode.postMessage({ ...message, sourceUri }); }
    });
    const client = protocol.createClient({ postMessage: message => vscode.postMessage(message), onState: render, onPending: updatePending, onRekey: rekey, onMove: moveDocuments });

    function fileAction(command, relativePath) {
        if (state?.source) { vscode.postMessage({ command, sourceUri: state.source.uri, itemId: state.source.uri, relativePath }); }
    }
    function updateFiles() {
        if (!filesContent || !state?.source) { return; }
        const current = filesState?.sourceUri === state.source.uri ? filesState : null;
        const paths = current?.paths || [];
        if (filesCount) { filesCount.textContent = String(paths.length); filesCount.parentElement?.setAttribute('aria-label', `${label('files')}: ${paths.length}`); }
        const children = [];
        if (current?.error) { const error = node('p', 'properties-files-error', current.error); error.setAttribute('role', 'alert'); children.push(error); }
        for (const relativePath of paths) {
            const row = node('div', 'properties-attachment'); row.dataset.relativePath = relativePath; row.draggable = true; row.tabIndex = 0;
            row.append(icon('file'), scrollText(relativePath, 'properties-record-caption', 'properties-record-title')); row.title = relativePath;
            row.addEventListener('dragstart', event => {
                event.stopPropagation(); fileProtocol?.setEditorDragData(event, { kind: 'file', name: relativePath.split('/').at(-1) });
            });
            row.addEventListener('dblclick', () => fileAction('openScenarioFile', relativePath));
            const actions = node('div', 'properties-record-actions');
            for (const [action, glyph, command] of [['insertAttachment', 'insert', 'insertScenarioFileName'], ['openAttachment', 'go-to-file', 'openScenarioFile'], ['renameAttachment', 'edit', 'renameScenarioFile'], ['deleteAttachment', 'trash', 'deleteScenarioFile']]) {
                const control = button(action, () => fileAction(command, relativePath), { icon: glyph, iconOnly: true });
                control.className += ' hover-action'; actions.append(control);
            }
            row.append(actions); children.push(row);
            row.addEventListener('mouseenter', () => window.requestAnimationFrame?.(measureTitles));
            row.addEventListener('mouseleave', () => window.requestAnimationFrame?.(measureTitles));
        }
        if (!paths.length) { children.push(node('p', 'properties-hint', label('dropAttachments'))); }
        filesContent.replaceChildren(...children);
        window.requestAnimationFrame?.(measureTitles);
    }
    function attachmentsPanel() {
        const panel = node('div', 'properties-files'); panel.id = 'files-tab-content'; panel.setAttribute('role', 'tabpanel');
        const toolbar = node('div', 'properties-files-toolbar');
        toolbar.append(button('revealAttachments', () => fileAction('revealScenarioFile', ''), { icon: 'folder-opened' }),
            button('addAttachments', () => fileAction('chooseScenarioFiles', ''), { icon: 'add' }));
        filesContent = node('div', 'properties-files-content'); panel.append(toolbar, filesContent); updateFiles(); return panel;
    }
    function externalFiles(event) {
        const types = Array.from(event.dataTransfer?.types || []);
        return state?.source && (types.includes('Files') || types.includes('text/uri-list'));
    }
    root.addEventListener('dragenter', event => {
        if (!externalFiles(event)) { return; }
        event.preventDefault(); fileDragDepth++; root.classList.add('is-file-drop-target');
    }, true);
    root.addEventListener('dragover', event => {
        if (!externalFiles(event)) { return; }
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; root.classList.add('is-file-drop-target');
    }, true);
    root.addEventListener('dragleave', () => {
        if (--fileDragDepth <= 0) { fileDragDepth = 0; root.classList.remove('is-file-drop-target'); }
    }, true);
    root.addEventListener('drop', event => {
        if (!externalFiles(event)) { return; }
        event.preventDefault(); event.stopPropagation(); fileDragDepth = 0; root.classList.remove('is-file-drop-target');
        const sourceUri = state.source.uri;
        const uris = (event.dataTransfer.getData?.('text/uri-list') || '').split(/\r?\n/u).map(uri => uri.trim()).filter(uri => uri && !uri.startsWith('#'));
        const sendUris = () => {
            if (uris.length && state?.source?.uri === sourceUri) { vscode.postMessage({ command: 'addScenarioFilesFromUris', sourceUri, itemId: sourceUri, uris }); }
        };
        if (Array.from(event.dataTransfer?.files || []).length || Array.from(event.dataTransfer?.types || []).includes('Files')) {
            void fileTransfers?.beginDrop(event.dataTransfer, { itemId: sourceUri }).then(dropId => { if (!dropId) { sendUris(); } }).catch(reason => {
                if (state?.source?.uri === sourceUri) { filesState = { ...filesState, sourceUri, error: String(reason.message || reason) }; updateFiles(); }
            });
        } else { sendUris(); }
    }, true);

    function moveDocuments(moves) {
        for (const key of Object.keys(collapsed)) {
            let parts; try { parts = JSON.parse(key); } catch { continue; }
            parts[0] = protocol.remapUri(parts[0], moves); parts[1] = protocol.remapUri(parts[1], moves);
            const next = JSON.stringify(parts); if (next !== key) { collapsed[next] = collapsed[key]; delete collapsed[key]; }
        }
        for (const key of new Set([...drafts.keys(), ...controls.keys()])) {
            if (!key.startsWith('[')) { continue; }
            const parts = JSON.parse(key); parts[0] = protocol.remapUri(parts[0], moves); const next = JSON.stringify(parts);
            if (drafts.has(key) && next !== key) { drafts.set(next, drafts.get(key)); drafts.delete(key); }
            if (controls.has(key)) { controls.get(key).dataset.focusKey = next; }
        }
    }

    function rekey(change) {
        for (const key of Object.keys(collapsed)) {
            let identity; try { identity = JSON.parse(key); } catch { continue; }
            if (identity[1] === change.documentUri && identity[2] === (change.stepUid || '') && identity[3] === change.oldKey && identity[4] === change.section) {
                identity[3] = change.newKey; collapsed[JSON.stringify(identity)] = collapsed[key]; delete collapsed[key];
            }
        }
        for (const key of new Set([...drafts.keys(), ...controls.keys()])) {
            if (!key.startsWith('[')) { continue; }
            const identity = JSON.parse(key);
            if (identity[0] !== change.documentUri || identity[1] !== change.section || identity[2] !== (change.stepUid || '') || identity[3] !== change.oldKey) { continue; }
            identity[3] = change.newKey;
            const nextKey = JSON.stringify(identity);
            if (drafts.has(key)) { drafts.set(nextKey, drafts.get(key)); drafts.delete(key); }
            const control = controls.get(key);
            if (control) { control.dataset.focusKey = nextKey; }
        }
    }

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) { element.className = className; }
        if (text !== undefined) { element.textContent = String(text); }
        return element;
    }
    function scrollText(text, className = '', textClass = 'properties-scroll-content', tag = 'span') {
        const viewport = node(tag, `properties-scroll-title ${className}`.trim());
        const content = node('span', textClass, text); viewport.append(content); viewport.title = String(text);
        const fade = () => {
            const clip = viewport.getBoundingClientRect?.();
            const text = content.getBoundingClientRect?.();
            viewport.classList.toggle('is-scrolled', (clip?.left || 0) - (text?.left || 0) > 1);
            viewport.classList.toggle('is-more-right', (text?.right || 0) - (clip?.right || 0) > 1);
        };
        const measure = () => {
            const distance = Math.max(0, (content.scrollWidth || 0) - (viewport.clientWidth || 0));
            viewport.classList.toggle('is-overflowing', distance > 0);
            viewport.style?.setProperty('--properties-scroll-distance', `${distance}px`);
            viewport.style?.setProperty('--properties-scroll-duration', `${Math.max(1.2, distance / 45)}s`);
            fade();
        };
        content.addEventListener('transitionstart', event => {
            if (event.propertyName !== 'transform') { return; }
            scrollingTitles.set(viewport, fade);
            if (scrollingFrame === undefined) { scrollingFrame = window.requestAnimationFrame?.(followScrollingTitles); }
        });
        for (const eventName of ['transitionend', 'transitioncancel']) {
            content.addEventListener(eventName, event => {
                if (event.propertyName !== 'transform') { return; }
                scrollingTitles.delete(viewport); fade();
            });
        }
        measure.viewport = viewport;
        viewport.addEventListener('mouseenter', measure); viewport.addEventListener('focusin', measure);
        titleMeasurements.push(measure);
        return viewport;
    }
    function followScrollingTitles() {
        for (const [viewport, fade] of scrollingTitles) {
            if (root.contains(viewport)) { fade(); } else { scrollingTitles.delete(viewport); }
        }
        scrollingFrame = scrollingTitles.size ? window.requestAnimationFrame?.(followScrollingTitles) : undefined;
    }
    function measureTitles() {
        for (let index = titleMeasurements.length - 1; index >= 0; index--) {
            const measure = titleMeasurements[index];
            if (!root.contains(measure.viewport)) { titleMeasurements.splice(index, 1); }
            else { measure(); }
        }
    }
    function overflowControl(control) {
        if (control.tagName === 'TEXTAREA' || control.tagName === 'SELECT') { return control; }
        const wrapper = node('div', `properties-overflow-control${control.readOnly ? ' is-readonly' : ''}`);
        const preview = scrollText('', 'properties-control-preview'); preview.setAttribute('aria-hidden', 'true');
        const sync = () => {
            const text = control.value;
            preview.children[0].textContent = text; preview.title = text;
            wrapper.classList.toggle('is-disabled', Boolean(control.disabled));
            window.requestAnimationFrame?.(measureTitles);
        };
        for (const event of ['input', 'change', 'blur']) { control.addEventListener(event, sync); }
        wrapper.addEventListener('mouseenter', measureTitles);
        wrapper.append(control, preview); sync(); return wrapper;
    }
    function errorNode(text) {
        const error = node('div', 'properties-error'); error.setAttribute('role', 'alert'); error.append(node('span', '', text), actionButton('dismissError', undefined, { icon: 'close', iconOnly: true })); return error;
    }
    function label(key) { return typeof labels[key] === 'string' ? labels[key] : key; }
    function icon(name) {
        const element = node('span', `codicon codicon-${name}`);
        element.setAttribute('aria-hidden', 'true');
        return element;
    }
    function button(action, callback, options = {}) {
        const element = node('button', options.primary ? 'primary' : '');
        element.type = 'button'; element.dataset.action = action;
        element.title = options.title || label(action); element.setAttribute('aria-label', element.title);
        if (options.icon) { element.append(icon(options.icon)); }
        if (!options.iconOnly) { element.append(scrollText(label(action), 'properties-button-caption')); }
        element.disabled = options.disabled === true;
        element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!element.disabled) { callback(); } });
        return element;
    }
    function actionButton(action, value, options) {
        return button(action, () => {
            if (action === 'save') { for (const commit of committers.values()) { commit(); } }
            client.action(action, value);
        }, options);
    }
    function targetData(element, document, target) {
        element.dataset.documentUri = document.uri;
        for (const key of ['section', 'recordKey', 'stepUid']) { if (target[key] !== undefined) { element.dataset[key] = target[key]; } }
    }
    function mutation(command, document, target) {
        return client.enqueue({ command, documentUri: document.uri, documentVersion: document.version, target });
    }
    function updatePending() {
        const pending = client.isPending();
        const dirty = state?.dirty || [...controls.keys()].some(key => {
            const draft = drafts.get(key);
            return draft && draft.value !== draft.baseValue;
        });
        root.setAttribute('aria-busy', String(pending));
        if (status) {
            status.classList.toggle('is-dirty', Boolean(dirty));
            status.children[0].textContent = dirty ? `${label('unsaved')}${pending ? ` · ${label('applying')}` : ''}`
                : label(pending ? 'applying' : 'saved');
            status.title = status.children[0].textContent;
            window.requestAnimationFrame?.(measureTitles);
        }
    }
    function fieldId(document, target, field) { return JSON.stringify([document.uri, target.section, target.stepUid || '', target.recordKey || '', field]); }
    function fieldControl(field, document, target, metadata = false) {
        if (field.suggestions && !field.choices) { field = { ...field, choices: field.suggestions, createAction: 'createChoice', action: 'catalogChoice' }; }
        const value = String(field.value ?? '');
        const key = fieldId(metadata ? state.source : document, target, field.key);
        const wrapper = node('div', `properties-field${field.multiline ? ' is-wide' : ''}`);
        const fieldLabel = scrollText(label(field.label || field.key), '', 'properties-scroll-content', 'label');
        const control = node(Array.isArray(field.choices) ? 'select' : field.multiline ? 'textarea' : 'input');
        control.id = `property-field-${++nextId}`; fieldLabel.setAttribute('for', control.id);
        control.setAttribute('aria-label', label(field.label || field.key));
        control.dataset.focusKey = key; control.dataset.field = field.key;
        targetData(control, document, target);
        if (control.tagName === 'INPUT') { control.type = field.key === 'order' ? 'number' : 'text'; }
        if (Array.isArray(field.choices)) {
            const choices = [...new Set([value, ...field.choices])];
            for (const choice of choices) {
                const option = node('option', '', metadata && field.key === 'groupId' ? choice ? state.groups.find(group => group.id === choice)?.name || label('unknownGroup') : label('ungrouped') : field.choiceLabels ? label(field.choiceLabels[choice] || 'unknownReference') : label(choice));
                option.value = choice; control.append(option);
            }
            if (field.createAction) { const option = node('option', '', label('createChoice')); option.value = CREATE_CHOICE; control.append(option); }
        }
        const draft = drafts.get(key);
        const focused = documentFocusKey() === key;
        if (draft && draft.value === value && !focused) { drafts.delete(key); }
        else if (draft) { draft.baseValue = value; }
        control.value = drafts.get(key)?.value ?? value;
        control.readOnly = field.readonly === true;
        if (control.tagName === 'SELECT') { control.disabled = control.readOnly; }
        control.addEventListener('input', () => {
            if (control.value === CREATE_CHOICE) { return; }
            if (!control.readOnly) {
                drafts.set(key, { value: control.value, baseValue: value, submittedValue: drafts.get(key)?.submittedValue });
                updatePending();
            }
        });
        const commit = () => {
            if (control.value === CREATE_CHOICE) {
                control.value = drafts.get(key)?.value === CREATE_CHOICE ? value : drafts.get(key)?.value ?? value;
                if (field.createAction === 'newGroup') { client.action('newGroup'); }
                else { client.enqueue({ command: 'createChoice', documentUri: document.uri, documentVersion: document.version, target: { ...target, field: field.key } }); }
                return;
            }
            if (['rename', 'changeCode'].includes(field.action)) { control.value = control.value.trim(); }
            if (metadata && field.key === 'order' && control.value.trim() && Number.isFinite(Number(control.value))) { control.value = String(Number(control.value)); }
            if (control.readOnly || !root.contains(control) || control.value === value || drafts.get(key)?.submittedValue === control.value) { return; }
            drafts.set(key, { value: control.value, baseValue: value, submittedValue: control.value });
            if (field.action === 'catalogChoice') {
                client.enqueue({ command: 'catalogChoice', documentUri: document.uri, documentVersion: document.version, target: { ...target, field: field.key }, value: control.value });
            } else if (metadata) {
                client.enqueue({ command: 'editMetadata', documentUri: document.uri, documentVersion: document.version, field: field.key, value: control.value });
            } else {
                client.enqueue({ command: 'edit', documentUri: document.uri, documentVersion: document.version, edit: { ...target, field: field.key, value: control.value } });
            }
        };
        control.addEventListener('change', commit);
        control.addEventListener('blur', commit);
        committers.set(key, commit);
        controls.set(key, control);
        const controlsRow = node('div', 'properties-field-controls'); controlsRow.append(overflowControl(control));
        if (field.suggestions?.length && control.tagName === 'INPUT') {
            const suggestions = node('datalist'); suggestions.id = `${control.id}-choices`;
            control.setAttribute('list', suggestions.id);
            for (const suggestion of field.suggestions) { const option = node('option'); option.value = suggestion; suggestions.append(option); }
            controlsRow.append(suggestions);
        }
        if (field.inlineAction) { controlsRow.append(actionButton(field.inlineAction, undefined, { icon: field.inlineAction === 'aiDescription' ? 'sparkle' : 'go-to-file', iconOnly: true })); }
        wrapper.append(fieldLabel, controlsRow);
        return wrapper;
    }
    function documentFocusKey() { return document.activeElement?.dataset?.focusKey; }
    function fields(fields, sourceDocument, target, metadata = false) {
        const grid = node('div', 'properties-fields');
        for (const field of (fields || []).filter(field => (!field.key.includes('UID') || field.choiceLabels) && field.key !== 'НомерСтроки' && !['ШагПроцесса', 'Процесс', 'Сценарий', 'ИдентификаторБазы', 'ШагПроцессаЗначениеПоСсылке'].includes(field.key))) { grid.append(fieldControl(field, sourceDocument, target, metadata)); }
        return grid;
    }
    function installDisclosure(section, summary, remember) {
        let expanded = section.open;
        let animation;
        const stop = () => {
            if (!animation) { return; }
            const previous = animation; animation = null; previous.onfinish = null; previous.cancel();
            disclosureAnimations.delete(stop); section.classList.remove('is-animating', 'is-collapsing');
        };
        section.addEventListener('toggle', () => {
            if (!root.contains(section) || animation) { return; }
            expanded = section.open; summary.setAttribute('aria-expanded', String(expanded)); remember(expanded);
            window.requestAnimationFrame?.(measureTitles);
        });
        summary.setAttribute('aria-expanded', String(expanded));
        summary.addEventListener('click', event => {
            event.preventDefault(); if (!root.contains(section)) { return; }
            const start = section.getBoundingClientRect?.().height ?? section.offsetHeight;
            stop(); expanded = !expanded; summary.setAttribute('aria-expanded', String(expanded)); remember(expanded);
            if (typeof section.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
                section.open = expanded; window.requestAnimationFrame?.(measureTitles); return;
            }
            section.open = expanded; const end = section.offsetHeight; section.open = true;
            section.classList.add('is-animating'); section.classList.toggle('is-collapsing', !expanded);
            animation = section.animate([{ height: `${start}px` }, { height: `${end}px` }], { duration: 200, easing: 'ease', fill: 'both' });
            disclosureAnimations.add(stop);
            animation.onfinish = () => { stop(); if (root.contains(section)) { section.open = expanded; window.requestAnimationFrame?.(measureTitles); } };
        });
    }
    function filePathRow(action, uri) {
        const row = node('div', 'properties-source-path');
        row.append(actionButton(action, undefined, { icon: 'go-to-file' }), actionButton('copyPath', uri, { icon: 'copy' }));
        return row;
    }
    function sectionShell(key, sourceDocument, target, count, title) {
        const section = node('details', 'properties-section'); targetData(section, sourceDocument, target);
        const collapseKey = JSON.stringify([state.source.uri, key === 'metadata' ? state.source.uri : sourceDocument.uri, target.stepUid || '', target.recordKey || '', key]);
        section.open = collapsed[collapseKey] !== true;
        const summary = node('summary'); summary.append(icon('chevron-right'), scrollText(title || label(key), 'properties-section-title'));
        summary.children[0].className += ' properties-chevron';
        if (count !== undefined) { summary.append(node('span', 'properties-count', count)); }
        const content = node('div', 'properties-section-content'); section.append(summary, content);
        installDisclosure(section, summary, expanded => {
            collapsed[collapseKey] = !expanded;
            persistViewState();
            window.requestAnimationFrame?.(measureTitles);
        });
        return { section, summary, content };
    }
    function header(sourceDocument, isSettings = false) {
        const section = isSettings ? 'ДанныеТеста' : sourceDocument.model.kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеСценария';
        const shell = sectionShell(section, sourceDocument, { section }, undefined, label('header'));
        shell.content.append(fields(sourceDocument.model.header, sourceDocument, { section }));
        return shell.section;
    }
    function rowTitle(record) {
        const field = record.fields.find(field => ['Имя', 'Наименование', 'ИмяСценария', 'СценарийНаименование', 'ВложенныйПроцессНаименование', 'Сценарий', 'ИмяПроцесса', 'Процесс'].includes(field.key));
        return field?.value || label('unnamedRecord');
    }
    function records(section, sourceDocument, target) {
        const container = node('div', 'properties-records');
        const records = section.records || [];
        const generated = Boolean(state.autoFill && sourceDocument.model.kind === 'scenario' && ['ПараметрыСценария', 'ВложенныеСценарии'].includes(section.key));
        function move(record, beforeRecordKey) { mutation('moveRecord', sourceDocument, { ...target, recordKey: record.key, beforeRecordKey }); }
        function installDrop(element, beforeRecordKey) {
            element.addEventListener('dragover', event => {
                if (!Array.from(event.dataTransfer?.types || []).includes(DRAG_TYPE)) { return; }
                event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; element.classList.add('is-drop-target');
            });
            element.addEventListener('dragleave', () => element.classList.remove('is-drop-target'));
            element.addEventListener('drop', event => {
                event.stopPropagation(); element.classList.remove('is-drop-target');
                let dragged;
                try { dragged = JSON.parse(event.dataTransfer?.getData(DRAG_TYPE) || ''); } catch { return; }
                if (!dragged || dragged.documentUri !== sourceDocument.uri || dragged.section !== target.section || dragged.stepUid !== target.stepUid
                    || dragged.recordKey === beforeRecordKey || !records.some(candidate => candidate.key === dragged.recordKey)) { return; }
                event.preventDefault(); mutation('moveRecord', sourceDocument, { ...target, recordKey: dragged.recordKey, beforeRecordKey });
            });
        }
        const tags = section.key.startsWith('Теги');
        const parameters = section.key === 'ПараметрыСценария';
        const nestedScenarios = section.key === 'ВложенныеСценарии';
        const processSteps = section.key === 'ШагиПроцесса';
        const grouped = parameters || processSteps;
        for (let index = 0; index < records.length; index++) {
            const record = records[index];
            const recordTarget = { ...target, recordKey: record.key };
            const row = node(grouped ? 'details' : 'div', `properties-record${grouped ? ' properties-record-group' : ''}${parameters ? ' properties-parameter' : ''}${processSteps ? ' properties-process-step' : ''}${tags ? ' properties-tag' : ''}`);
            row.draggable = !generated; targetData(row, sourceDocument, recordTarget);
            if (grouped) {
                const collapseKey = JSON.stringify([state.source.uri, sourceDocument.uri, target.stepUid || '', record.key, section.key]);
                row.open = collapsed[collapseKey] === false;
                // The row's summary is installed below, after its children are rendered.
                row.dataset.collapseKey = collapseKey;
            }
            const heading = node(grouped ? 'summary' : 'div', 'properties-record-heading');
            if (grouped) { const chevron = icon('chevron-right'); chevron.className += ' properties-chevron'; heading.append(chevron); }
            const handle = icon('gripper'); handle.className += ' properties-record-handle'; handle.title = label('dragRecord');
            let title;
            if (tags) {
                title = fieldControl({ ...record.fields.find(field => field.key === 'Имя'), label: 'tagName' }, sourceDocument, recordTarget);
                title.className = 'properties-tag-heading';
            } else { title = scrollText(rowTitle(record), parameters ? 'properties-parameter-name' : 'properties-record-caption', 'properties-record-title'); }
            const actions = node('div', 'properties-record-actions');
            for (const [name, glyph, disabled, before] of generated || tags || processSteps ? [] : [
                ['moveUp', 'arrow-up', index === 0, records[index - 1]?.key || null],
                ['moveDown', 'arrow-down', index === records.length - 1, records[index + 2]?.key || null]
            ]) {
                const control = button(name, () => move(record, before), { icon: glyph, iconOnly: true, disabled });
                targetData(control, sourceDocument, recordTarget); actions.append(control);
            }
            if (nestedScenarios || section.key === 'ШагиПроцесса') {
                const open = actionButton('openReference', record.key, { icon: 'go-to-file', iconOnly: true });
                if (nestedScenarios || processSteps) { open.className += ' hover-action'; }
                actions.append(open);
            }
            if (!generated) {
                const remove = button('removeRecord', () => mutation('removeRecord', sourceDocument, recordTarget), { icon: 'trash', iconOnly: true });
                if (tags || processSteps) { remove.className += ' hover-action'; }
                targetData(remove, sourceDocument, recordTarget); actions.append(remove);
            }
            if (!generated) { heading.append(handle); }
            heading.append(title);
            if (parameters) {
                const value = record.fields.find(field => field.key === 'Значение')?.value || '—';
                const preview = scrollText(String(value).replace(/\s+/gu, ' '), 'properties-parameter-default');
                preview.title = `${label('defaultValue')}: ${value}`; heading.append(preview);
            }
            const usage = record.usages === undefined ? null : node('span', 'properties-usage', `${record.usages} ×`);
            if (usage) { usage.title = label('usages'); usage.setAttribute('aria-label', `${label('usages')}: ${record.usages}`); }
            if (nestedScenarios) { heading.append(actions); if (usage) { heading.append(usage); } }
            else { if (usage) { heading.append(usage); } heading.append(actions); }
            row.append(heading);
            if (grouped) { installDisclosure(row, heading, expanded => { collapsed[row.dataset.collapseKey] = !expanded; persistViewState(); }); }
            if (!nestedScenarios) {
                const editable = tags ? record.fields.filter(field => field.key !== 'Имя') : record.fields;
                if (editable.length) { row.append(fields(editable, sourceDocument, recordTarget)); }
            }
            const stepUid = section.key === 'ШагиПроцесса' ? record.fields.find(field => field.key === 'UID')?.value : target.stepUid;
            for (const nested of record.sections || []) { row.append(renderSection(nested, sourceDocument, { ...(stepUid ? { stepUid } : {}) })); }
            row.addEventListener('keydown', event => {
                if (generated || event.target !== row || !event.altKey) { return; }
                if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); move(record, records[index - 1].key); }
                if (event.key === 'ArrowDown' && index < records.length - 1) { event.preventDefault(); move(record, records[index + 2]?.key || null); }
            });
            row.tabIndex = 0; row.setAttribute('aria-label', generated ? rowTitle(record) : `${rowTitle(record)}. ${label('dragRecord')}`);
            row.addEventListener('mouseenter', () => window.requestAnimationFrame?.(measureTitles));
            row.addEventListener('mouseleave', () => window.requestAnimationFrame?.(measureTitles));
            row.addEventListener('dragstart', event => {
                if (generated || !event.dataTransfer || event.target !== row) { return; }
                event.stopPropagation(); event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ documentUri: sourceDocument.uri, ...recordTarget })); row.classList.add('is-dragging');
            });
            row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
            if (!generated) { installDrop(row, record.key); }
            container.append(row);
        }
        if (!records.length) { container.append(node('p', 'properties-empty', label('noRecords'))); }
        else if (!generated) {
            const end = node('div', 'properties-record-end'); end.dataset.action = 'dropAtEnd'; targetData(end, sourceDocument, target);
            end.title = label('dropAtEnd'); end.setAttribute('aria-label', label('dropAtEnd')); installDrop(end, null); container.append(end);
        }
        return container;
    }
    function renderSection(section, sourceDocument, extra = {}) {
        const target = { section: section.key, ...extra };
        const shell = sectionShell(section.key, sourceDocument, target, section.records?.length);
        if (section.key === 'ШагиПроцесса') { shell.content.append(node('p', 'properties-hint', label('processHint'))); }
        if (section.fields) {
            const preview = section.fields.find(field => field.key === 'Parameter combinations');
            if (preview && BigInt(preview.value.split('\n')[0] || '1') > 1n) {
                if (state.variantLimitWarning && section.key === 'ПараметрыСценария') {
                    const text = label('variantLimitWarning').replace('{0}', String(state.variantLimitWarning.limit)).replace('{1}', state.variantLimitWarning.count);
                    const warning = node('p', 'properties-warning', text); warning.setAttribute('role', 'status'); shell.content.append(warning);
                }
                const combinations = node('details', 'properties-combinations');
                const collapseKey = JSON.stringify([state.source.uri, sourceDocument.uri, target.stepUid || '', target.recordKey || '', 'parameterCombinations']);
                combinations.open = collapsed[collapseKey] === false;
                combinations.append(node('summary', '', `${label('combinations')}: ${preview.value.split('\n')[0]}`),
                    node('p', 'properties-hint', label('combinationsHint')), node('pre', '', preview.value.split('\n').slice(1).join('\n')));
                installDisclosure(combinations, combinations.children[0], expanded => { collapsed[collapseKey] = !expanded; persistViewState(); });
                shell.content.append(combinations);
            }
            shell.content.append(fields(section.fields.filter(field => field.key !== 'Parameter combinations'), sourceDocument, target));
        }
        if (section.records) {
            shell.content.append(records(section, sourceDocument, target));
            const actions = node('div', 'properties-actions');
            const generated = state.autoFill && sourceDocument.model.kind === 'scenario' && ['ПараметрыСценария', 'ВложенныеСценарии'].includes(section.key);
            if (generated) {
                const automatic = section.key === 'ПараметрыСценария' ? state.autoFill.parameters : state.autoFill.nested;
                if (!automatic) { actions.append(actionButton(section.key === 'ПараметрыСценария' ? 'fillParameters' : 'fillNested', undefined, { icon: 'sync' })); }
            } else if (section.key === 'ШагиПроцесса') { actions.append(actionButton('addSteps', undefined, { icon: 'add' })); }
            else if (section.key === 'ВложенныеСценарии') { actions.append(actionButton('addNested', undefined, { icon: 'add' })); }
            else {
                if (section.key === 'ПараметрыТеста' && sourceDocument.model.kind === 'processTest' && state.source.model.kind === 'process') {
                    const fill = button('fillProcessDefaults', () => client.enqueue({ command: 'fillProcessDefaults', documentUri: sourceDocument.uri,
                        documentVersion: sourceDocument.version, sourceVersion: state.source.version, target }), { icon: 'sync' });
                    targetData(fill, sourceDocument, target); actions.append(fill);
                }
                const add = button('addRecord', () => mutation('addRecord', sourceDocument, target), { icon: 'add' });
                targetData(add, sourceDocument, target); actions.append(add);
            }
            shell.content.append(actions);
        }
        return shell.section;
    }
    function settingsSection() {
        const content = node('div', 'properties-settings'); targetData(content, state.source, { section: 'testSettings' });
        const shell = { section: content, content };
        if (state.loading) { shell.content.append(node('p', 'properties-hint', label('loadingRelated'))); }
        if (!state.settings.length && !state.loading) {
            shell.content.append(node('p', 'properties-empty', label('noSettings')), actionButton('createSettings', undefined, { icon: 'add' }));
            return shell.section;
        }
        const selected = state.settings.find(item => item.uri === state.selectedSettingsUri);
        if (state.settings.length > 1 || !selected) {
            const wrapper = node('div', 'properties-field properties-settings-picker');
            const selector = node('select'); selector.id = 'properties-settings-selector'; selector.dataset.action = 'selectSettings';
            selector.dataset.focusKey = 'settings-selector'; controls.set('settings-selector', selector);
            const pickerLabel = scrollText(label('selectSettings'), '', 'properties-scroll-content', 'label'); pickerLabel.setAttribute('for', selector.id);
            if (!selected) { const placeholder = node('option', '', label('selectSettingsHint')); placeholder.value = ''; selector.append(placeholder); }
            for (const setting of state.settings) { const option = node('option', '', setting.label || setting.model.title || setting.uri); option.value = setting.uri; selector.append(option); }
            selector.value = selected?.uri || '';
            selector.addEventListener('change', () => { if (selector.value) { client.action('selectSettings', selector.value); } });
            wrapper.append(pickerLabel, overflowControl(selector)); shell.content.append(wrapper);
        }
        if (selected) {
            shell.content.append(filePathRow('openSettings', selected.uri), header(selected, true));
            for (const section of selected.model.sections) { shell.content.append(renderSection(section, selected)); }
        }
        return shell.section;
    }
    function metadataSection() {
        const sourceDocument = state.metadata || state.source;
        const shell = sectionShell('metadata', sourceDocument, { section: 'metadata' });
        const values = state.metadata?.values || {};
        const hasGroup = state.canCreateSettings !== false || state.settings.length > 0;
        shell.content.append(fields([
            ...(hasGroup ? [{ key: 'groupId', value: values.groupId || '', choices: ['', ...state.groups.map(group => group.id)], createAction: 'newGroup' },
                { key: 'order', value: values.order ?? '' }] : []),
            { key: 'description', value: values.description || '', multiline: true, inlineAction: 'aiDescription' },
            { key: 'category', value: values.category || '', choices: ['', ...(state.catalogs?.categories || [])], createAction: 'createChoice', action: 'catalogChoice' }
        ], sourceDocument, { section: 'metadata' }, true));
        const open = actionButton('openMetadata', undefined, { icon: 'go-to-file', iconOnly: true }); open.className += ' properties-header-action'; shell.section.children[0].append(open);
        return shell.section;
    }
    function render(nextState, failed = false) {
        const active = document.activeElement;
        const focus = root.contains(active) ? { key: active.dataset?.focusKey, start: active.selectionStart, end: active.selectionEnd } : null;
        for (const stop of disclosureAnimations) { stop(); }
        if (state?.source?.uri !== nextState?.source?.uri) {
            fileTransfers?.dispose(); fileTransferSources.clear(); filesState = null; fileDragDepth = 0; root.classList.remove('is-file-drop-target');
        }
        state = nextState; labels = state?.labels || protocol.DEFAULT_LABELS; filesContent = null; filesCount = null;
        controls.clear(); committers.clear(); titleMeasurements.length = 0; nextId = 0;
        if (failed) { for (const draft of drafts.values()) { delete draft.submittedValue; } }
        if (!state?.source) {
            status = null;
            root.replaceChildren(...(state?.error ? [errorNode(state.error)] : []), node('p', 'properties-empty', label(state?.error ? 'invalidState' : 'empty')));
            updatePending(); return;
        }
        document.title = label('title');
        const toolbar = node('header', 'properties-toolbar');
        const titleRow = node('div', 'properties-title-row'); const heading = node('div', 'properties-heading');
        heading.append(node('h1', '', state.source.model.title));
        const meta = node('div', 'properties-meta-row');
        const separator = node('span', 'properties-meta-separator'); separator.setAttribute('aria-hidden', 'true');
        status = scrollText('', `properties-status${state.dirty ? ' is-dirty' : ''}`); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        meta.append(node('span', 'properties-kind', label(state.source.model.kind)), separator, status); heading.append(meta);
        const pin = actionButton('pin', undefined, { icon: state.pinned ? 'pinned' : 'pin', iconOnly: true, title: label(state.pinned ? 'unpin' : 'pin') });
        pin.classList.toggle('is-active', Boolean(state.pinned)); pin.setAttribute('aria-pressed', String(state.pinned));
        titleRow.append(heading);
        const actions = node('div', 'properties-actions');
        actions.append(actionButton('save', undefined, { primary: true, icon: 'save' }), actionButton('openText', undefined, { icon: 'fold', iconOnly: true }), pin);
        toolbar.append(titleRow, actions);
        const children = [toolbar];
        if (state.error) { children.push(errorNode(state.error)); }
        const tabs = node('div', 'properties-tabs'); tabs.setAttribute('role', 'tablist');
        const properties = node('div'); properties.setAttribute('role', 'tabpanel'); properties.id = 'properties-tab-content';
        properties.append(filePathRow('openSource', state.source.uri), header(state.source), metadataSection());
        const ordered = [...state.source.model.sections].sort((left, right) => {
            const order = ['ПараметрыСценария', 'ВложенныеСценарии', 'ТегиСценария', 'ТегиПроцесса', 'ШагиПроцесса'];
            return order.indexOf(left.key) - order.indexOf(right.key);
        });
        for (const section of ordered) { properties.append(renderSection(section, state.source)); }
        const files = attachmentsPanel();
        const settings = node('div'); settings.id = 'settings-tab-content'; settings.setAttribute('role', 'tabpanel');
        const hasSettings = state.settings.length || state.canCreateSettings !== false || state.loading;
        if (hasSettings) { settings.append(settingsSection()); } else if (activeTab === 'testSettings') { activeTab = 'properties'; }
        const tabPanels = { properties, ...(hasSettings ? { testSettings: settings } : {}), files };
        const tabNames = Object.keys(tabPanels);
        const tabButtons = [];
        const selectTab = name => {
            activeTab = tabNames.includes(name) ? name : 'properties';
            for (const [key, panel] of Object.entries(tabPanels)) { panel.hidden = key !== activeTab; }
            for (const control of tabButtons) {
                control.setAttribute('aria-selected', String(control.dataset.action === activeTab));
                control.tabIndex = control.dataset.action === activeTab ? 0 : -1;
            }
            persistViewState();
        };
        for (const name of tabNames) {
            const control = button(name, () => selectTab(name)); control.setAttribute('role', 'tab');
            control.id = `${name}-tab`; control.setAttribute('aria-controls', tabPanels[name].id);
            tabPanels[name].setAttribute('aria-labelledby', control.id);
            if (name === 'files') { filesCount = node('span', 'properties-tab-count', 0); control.append(filesCount); updateFiles(); }
            control.addEventListener('keydown', event => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const index = tabNames.indexOf(name); const offset = event.key === 'ArrowLeft' ? -1 : 1;
                    selectTab(event.key === 'Home' ? tabNames[0] : event.key === 'End' ? tabNames.at(-1) : tabNames[(index + offset + tabNames.length) % tabNames.length]);
                    tabButtons.find(button => button.dataset.action === activeTab)?.focus();
                }
            });
            tabButtons.push(control); tabs.append(control);
        }
        selectTab(activeTab);
        children.push(tabs, properties, ...(hasSettings ? [settings] : []), files, node('div', 'properties-footer'));
        root.replaceChildren(...children);
        window.requestAnimationFrame?.(measureTitles);
        if (focus?.key && controls.has(focus.key)) {
            const control = controls.get(focus.key); control.focus({ preventScroll: true });
            if (typeof focus.start === 'number' && ['TEXTAREA', 'INPUT'].includes(control.tagName) && control.type !== 'number') {
                control.setSelectionRange?.(focus.start, focus.end);
            }
        }
        updatePending();
    }
    window.addEventListener('message', event => {
        const message = event.data;
        if (message?.command === 'scenarioFileDropPrepared') {
            if (message.sourceUri !== state?.source?.uri) {
                fileTransfers?.handleMessage({ command: 'scenarioFileTransferFailed', dropId: message.dropId });
                for (const file of message.files || []) { vscode.postMessage({ command: 'cancelScenarioFileTransfer', sourceUri: message.sourceUri, transferId: file.transferId }); }
                return;
            }
            for (const file of message.files || []) { fileTransferSources.set(file.transferId, message.sourceUri); }
        }
        if (message?.command === 'state') { client.setState(message.state, message.acknowledgement !== false); }
        else if (message?.command === 'scenarioPropertiesFiles' && message.sourceUri === state?.source?.uri) {
            filesState = { ...message, paths: Array.isArray(message.paths) ? message.paths.filter(path => typeof path === 'string') : [] }; updateFiles();
        } else if (fileTransfers?.handleMessage(message) && message.command === 'scenarioFileTransferFailed' && message.sourceUri === state?.source?.uri) {
            filesState = { ...filesState, sourceUri: message.sourceUri, error: message.error }; updateFiles();
        }
        if (['scenarioFileTransferCompleted', 'scenarioFileTransferFailed'].includes(message?.command)) { fileTransferSources.delete(message.transferId); }
    });
    window.addEventListener('resize', measureTitles);
    root.replaceChildren(node('p', 'properties-empty', label('empty')));
    vscode.postMessage({ command: 'ready' });
}());
