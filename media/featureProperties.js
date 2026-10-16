/* Native feature document view, sharing the Properties toolbar and visual language. */
(function (root) {
    'use strict';
    root.FeaturePropertiesView = { create({ root: container, vscode, scrollText, measureTitles, overflowControl, installDisclosure, resetLayout, defaults }) {
        let state; let statusElement; let labels = defaults; let busy = false; let current;
        let scenariosExpanded = true; let jsonExpanded = true; let blocksExpanded = true;
        const queue = []; const drafts = new Map(); const controls = new Map();
        const label = key => labels[key] || key;
        const node = (tag, className = '', text = '') => { const element = document.createElement(tag); element.className = className; element.textContent = text; return element; };
        const icon = name => { const result = node('span', 'codicon codicon-' + name); result.setAttribute('aria-hidden', 'true'); return result; };
        function flush() {
            if (busy || !state || !queue.length) { return; }
            current = queue.shift();
            if (current.uri !== state.uri) { flush(); return; }
            busy = true; vscode.postMessage({ command: 'featureAction', ...current, version: Number.isInteger(current.line) ? current.version : state.version });
            updatePending();
        }
        function send(action, extra = {}) { if (!state) { return; } queue.push({ uri: state.uri, version: state.version, action, ...extra }); flush(); }
        const fieldValue = (model, key) => key === 'tags' ? model.tags.join(' ') : model[key];
        function commit() {
            for (const [field, draft] of drafts) {
                if (draft.value !== draft.base && draft.submitted !== draft.value) {
                    draft.submitted = draft.value; send('edit', { field, value: draft.value, baseValue: draft.base });
                }
            }
        }
        function button(action, options = {}) {
            const result = node('button', options.primary ? 'primary' : ''); result.type = 'button'; result.dataset.action = action;
            const caption = options.title || label(action);
            if (options.icon) { result.append(icon(options.icon)); }
            if (options.iconOnly) { result.className += ' icon-only'; result.setAttribute('aria-label', caption); result.title = caption; }
            else { result.append(node('span', '', caption)); }
            if (options.disabled) { result.disabled = true; }
            result.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (result.disabled) { return; } if (action !== 'pin') { commit(); } send(action, options.extra); });
            return result;
        }
        function field(key, value, multiline = false) {
            const wrapper = node('div', 'properties-field is-wide'); const id = 'feature-' + key;
            const caption = node('label', '', label({ title: 'featureTitle', description: 'description', tags: 'featureTags' }[key])); caption.setAttribute('for', id);
            const input = node(multiline ? 'textarea' : 'input'); input.id = id; input.dataset.field = key;
            const draft = drafts.get(key);
            if (draft?.value === value) { drafts.delete(key); }
            input.value = drafts.get(key)?.value ?? value;
            controls.set(key, input);
            input.addEventListener('input', () => { const old = drafts.get(key); drafts.set(key, { base: value, ...old, value: input.value }); updatePending(); });
            input.addEventListener('change', commit);
            wrapper.append(caption, overflowControl(input));
            return wrapper;
        }
        function updatePending() {
            const status = statusElement;
            const dirty = state?.dirty || [...drafts.values()].some(draft => draft.value !== draft.base);
            const mutation = busy && !['pin', 'openSource', 'openScenario', 'copyPath', 'openJson', 'dismissError'].includes(current?.action);
            if (status) { status.textContent = label(mutation ? 'applying' : dirty ? 'unsaved' : 'saved'); status.classList.toggle('is-dirty', !!dirty); }
            container.setAttribute('aria-busy', String(!!mutation));
        }
        function render() {
            if (!state) { return; }
            const active = document.activeElement;
            const focus = container.contains(active) && active?.dataset.field ? { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd } : null;
            resetLayout?.(); controls.clear();
            const toolbar = node('header', 'properties-toolbar'); const heading = node('div', 'properties-heading');
            heading.append(node('h1', '', state.model.title));
            const meta = node('div', 'properties-meta-row'); const status = node('span', 'properties-status'); statusElement = status; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            const separator = node('span', 'properties-meta-separator'); separator.setAttribute('aria-hidden', 'true');
            meta.append(node('span', 'properties-kind', label('feature')), separator, status); heading.append(meta);
            const actions = node('div', 'properties-actions');
            const favorite = button('favorite', { icon: state.favorite ? 'star-full' : 'star-empty', iconOnly: true, title: label(state.favorite ? 'unfavorite' : 'favorite'), disabled: !state.canFavorite });
            favorite.setAttribute('aria-pressed', String(!!state.favorite));
            const pin = button('pin', { icon: state.pinned ? 'pinned' : 'pin', iconOnly: true, title: label(state.pinned ? 'unpin' : 'pin') });
            pin.classList.toggle('is-active', !!state.pinned); pin.setAttribute('aria-pressed', String(!!state.pinned));
            actions.append(button('save', { primary: true, icon: 'save' }));
            if (state.standalone) { actions.append(button('run', { icon: 'play' })); }
            actions.append(favorite, pin); toolbar.append(heading, actions);
            const body = node('div', 'feature-properties-body');
            const paths = node('div', 'properties-actions'); paths.append(button('openSource', { title: label('openFeature'), icon: 'go-to-file' }), button('copyPath', { icon: 'copy' })); body.append(paths);
            if (state.error) { const error = node('div', 'properties-error', state.error); error.setAttribute('role', 'alert'); error.append(button('dismissError', { icon: 'close', iconOnly: true })); body.append(error); }
            const fields = node('div', 'properties-fields'); fields.append(field('title', state.model.title), field('description', state.model.description, true), field('tags', state.model.tags.join(' '))); body.append(fields);
            if (state.standalone) {
                const group = node('div', 'properties-field'); const caption = node('label', '', label('groupId')); caption.setAttribute('for', 'feature-group');
                const select = node('select'); select.id = 'feature-group'; select.dataset.field = 'group';
                for (const entry of [{ id: '', name: label('ungrouped') }, ...state.standalone.groups, { id: '__new__', name: label('createChoice') }]) {
                    const option = node('option', '', entry.name); option.value = entry.id; select.append(option);
                }
                select.value = state.standalone.groupId; select.addEventListener('change', () => { commit(); send('group', { value: select.value }); }); group.append(caption, select); body.append(group);
                const jsonSection = node('details', 'properties-section properties-feature-launch'); jsonSection.open = jsonExpanded;
                const jsonSummary = node('summary'); const jsonChevron = icon('chevron-right'); jsonChevron.className += ' properties-chevron';
                jsonSummary.append(jsonChevron, node('span', 'properties-section-title', label('launchJson')));
                const jsonContent = node('div', 'properties-section-content'); jsonSection.append(jsonSummary, jsonContent);
                installDisclosure?.(jsonSection, jsonSummary, expanded => { jsonExpanded = expanded; });
                const json = node('div', 'properties-record'); json.append(scrollText(state.standalone.jsonPath?.split(/[\\/]/u).at(-1) || label('noLaunchJson'), 'properties-record-caption'));
                const jsonActions = node('div', 'properties-actions'); jsonActions.append(button('chooseJson'), button('generateJson'), button('openJson', { disabled: !state.standalone.jsonPath })); jsonContent.append(json, jsonActions); body.append(jsonSection);
            }
            const featureActions = state.model.actions.filter(action => !['description', 'tags', 'scenario'].includes(action.kind));
            if (featureActions.length) {
                const blocks = node('details', 'properties-section properties-feature-blocks'); blocks.open = blocksExpanded;
                const summary = node('summary'); const chevron = icon('chevron-right'); chevron.className += ' properties-chevron';
                summary.append(chevron, node('span', 'properties-section-title', label('featureBlocks')));
                const content = node('div', 'properties-section-content'); const structure = node('div', 'properties-actions');
                for (const action of featureActions) { structure.append(button('structure', { title: action.title, extra: { value: action.kind, line: action.line } })); }
                content.append(structure); blocks.append(summary, content); body.append(blocks);
                installDisclosure?.(blocks, summary, expanded => { blocksExpanded = expanded; });
            }
            const scenarios = node('details', 'properties-section'); scenarios.open = scenariosExpanded;
            const summary = node('summary'); const chevron = icon('chevron-right'); chevron.className += ' properties-chevron'; summary.append(chevron, node('span', '', label('scenarios')), node('span', 'properties-count', String(state.model.scenarios.length))); const addScenario = state.model.actions.find(action => action.kind === 'scenario');
            if (addScenario) { summary.append(button('structure', { title: label('addScenario'), icon: 'add', iconOnly: true, extra: { value: 'scenario', line: addScenario.line } })); }
            scenarios.append(summary); installDisclosure?.(scenarios, summary, expanded => { scenariosExpanded = expanded; });
            const list = node('div', 'properties-section-content');
            for (const scenario of state.model.scenarios) {
                const block = node('div', 'properties-record'); block.append(scrollText(scenario.title, 'properties-record-caption', 'properties-record-title'));
                const rowActions = node('div', 'properties-record-actions');
                for (const [action, glyph] of [['openScenario', 'go-to-file'], ['renameScenario', 'edit']]) {
                    const control = button(action, { icon: glyph, iconOnly: true, extra: { line: scenario.line } }); control.className += ' hover-action'; rowActions.append(control);
                }
                block.append(rowActions); list.append(block);
                const edits = node('div', 'properties-actions');
                for (const action of scenario.actions) { edits.append(button('structure', { title: action.title, extra: { value: action.kind, line: action.line } })); } list.append(edits);
            }
            scenarios.append(list); body.append(scenarios); container.replaceChildren(toolbar, body);
            if (focus && controls.has(focus.field)) { const input = controls.get(focus.field); input.focus({ preventScroll: true }); if (typeof focus.start === 'number') { input.setSelectionRange?.(focus.start, focus.end); } }
            window.requestAnimationFrame?.(measureTitles); updatePending();
        }
        return {
            accept(next, acknowledgement = false) {
                if (!next || typeof next.uri !== 'string' || !next.model) { return; }
                if (state?.uri !== next.uri) { scenariosExpanded = true; jsonExpanded = true; blocksExpanded = true; queue.length = 0; drafts.clear(); busy = false; current = undefined; }
                if (acknowledgement) {
                    busy = false;
                    if (next.error) {
                        const pins = queue.filter(request => request.action === 'pin'); queue.splice(0, queue.length, ...pins);
                        for (const draft of drafts.values()) { delete draft.submitted; }
                        if (current?.action === 'edit') {
                            const draft = drafts.get(current.field);
                            if (draft) { draft.base = fieldValue(next.model, current.field); }
                        }
                    } else if (current?.action === 'edit') {
                        const canonical = fieldValue(next.model, current.field);
                        const draft = drafts.get(current.field);
                        if (draft?.value === current.value) { drafts.delete(current.field); }
                        else if (draft) { draft.base = canonical; }
                        for (const request of queue) { if (request.action === 'edit' && request.field === current.field) { request.baseValue = canonical; } }
                    }
                    current = undefined;
                }
                state = next; labels = { ...defaults, ...next.labels }; render(); flush();
            },
            clear() { state = undefined; queue.length = 0; drafts.clear(); busy = false; current = undefined; }
        };
    } };
}(typeof globalThis === 'object' ? globalThis : this));
