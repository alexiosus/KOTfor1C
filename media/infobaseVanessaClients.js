(function () {
    function escapeHtml(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function renderClientRows(rows, _selected, t) {
        const states = { local: t('local', 'Saved locally'), added: t('added', 'Added to Vanessa'), connected: t('connected', 'Connected'),
            outdated: t('outdated', 'Changes not applied'), conflict: t('conflict', 'Profile conflict'), unsupported: t('unsupported', 'Unsupported profile'), unknown: t('unknown', 'Not checked') };
        const button = (action, icon, label, id, text = false) => `<button class="${text ? 'toolbar-btn' : 'ghost-btn v-client-icon'}" type="button" data-client-action="${action}" data-client-id="${escapeHtml(id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="codicon codicon-${icon}" aria-hidden="true"></span>${text ? ' ' + escapeHtml(label) : ''}</button>`;
        return rows.map(row => `<div class="v-client-row" role="row" data-client-row-id="${escapeHtml(row.id)}">
            <div class="v-client-copy"><span class="infobase-item-name">${escapeHtml(row.name)}</span><span class="infobase-item-path">${escapeHtml(row.username || t('defaultUser', 'Default user'))}</span></div>
            <div class="v-client-runtime"><span class="v-client-state ${row.connected || row.state === 'connected' ? 'is-connected' : row.state === 'conflict' || row.state === 'unsupported' || row.state === 'outdated' ? 'is-conflict' : ''}">${escapeHtml(states[row.state] || states.unknown)}${row.remoteOnly ? ' · ' + escapeHtml(t('liveOnly', 'Vanessa only')) : ''}</span><span class="v-client-meta">${escapeHtml(row.remoteClientType || row.clientType)} · ${escapeHtml(row.computerName)}${row.remoteOnly ? '' : ':' + row.port}</span></div>
            <div class="v-client-actions"><span class="v-client-add-slot">${!row.remoteOnly && row.state === 'local' ? button('add', 'add', t('add', 'Add to Vanessa'), row.id, true) : ''}</span><span class="v-client-connect-slot">${row.connected || row.state === 'connected' ? button('disconnect', 'debug-disconnect', t('disconnect', 'Disconnect'), row.id, true) : button('connect', 'debug-start', row.state === 'outdated' ? t('updateConnect', 'Apply and connect') : t('connect', 'Connect'), row.id, true)}</span><span class="v-client-tools-slot">${row.remoteOnly ? button('import', 'save', t('saveToKot', 'Save to KOT'), row.id) : button('edit', 'edit', t('edit', 'Edit client'), row.id)}${row.replaceable ? button('replace', 'replace', t('replace', 'Replace Vanessa profile'), row.id) : ''}${row.remoteOnly ? '' : button('remove', 'trash', t('remove', 'Remove saved client'), row.id)}</span></div>
        </div>`).join('');
    }
    function create(container, options) {
        if (!container) { return { render() {} }; }
        const t = (key, fallback) => options.loc?.[key] || fallback;
        let base = ''; let view = null; let draft = null; let saving = false; let request = 0; let pendingEditor = null; let pendingSave = null;
        const icon = (action, code, label) => `<button class="ghost-btn v-client-icon" type="button" data-client-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="codicon codicon-${code}" aria-hidden="true"></span></button>`;
        container.innerHTML = `<details class="v-client-group" open><summary class="v-client-heading"><span class="codicon codicon-chevron-right v-client-disclosure" aria-hidden="true"></span><span class="v-client-title">${escapeHtml(t('title', 'Vanessa test clients'))}</span><span class="v-client-toolbar">${icon('refresh', 'refresh', t('refresh', 'Refresh'))}${icon('new', 'add', t('new', 'Add user'))}</span></summary><div class="v-client-body"><p class="v-client-meta" data-client-progress role="status" hidden></p><p class="v-client-hint" data-client-empty>${escapeHtml(t('emptyShort', 'No saved test clients.'))}</p><div class="v-client-rows" role="table" aria-label="${escapeHtml(t('title', 'Vanessa test clients'))}"></div><div class="v-client-editor" hidden></div><p class="v-client-error" role="alert" hidden></p></div></details>`;
        const rowsHost = container.querySelector('.v-client-rows'); const editor = container.querySelector('.v-client-editor');
        const send = (command, extra = {}) => options.post({ command, infobasePath: base, ...extra });
        function placeEditor() {
            const row = draft?.id && [...rowsHost.querySelectorAll('.v-client-row')].find(item => item.dataset.clientRowId === draft.id);
            if (editor.parentElement === (row || rowsHost.parentElement)) { return; }
            if (row) { row.appendChild(editor); } else { rowsHost.after(editor); }
        }
        function showEditor(fields, id) {
            draft = { ...fields, password: fields.password || '', additionalParameters: fields.additionalParameters || '', id }; saving = false;
            const input = (key, label, type = 'text') => `<label>${escapeHtml(label)}<input type="${type}" data-client-field="${key}" value="${escapeHtml(draft[key])}"${key === 'port' ? ' min="1" max="65535"' : ''}></label>`;
            editor.hidden = false;
            editor.innerHTML = `<form class="v-client-form"><div class="v-client-fields v-client-identity">${input('name', t('name', 'Client name'))}${input('username', t('username', 'Infobase user (optional)'))}${input('password', t('passwordLabel', 'Password'), 'password')}</div><details open><summary>${escapeHtml(t('details', 'Connection details'))}</summary><div class="v-client-fields"><label>${escapeHtml(t('type', 'Client type'))}<select data-client-field="clientType"><option value="Thin"${draft.clientType === 'Thin' ? ' selected' : ''}>${escapeHtml(t('thin', 'Thin'))}</option><option value="Thick"${draft.clientType === 'Thick' ? ' selected' : ''}>${escapeHtml(t('thick', 'Thick'))}</option></select></label>${input('additionalParameters', t('keysLabel', 'Launch keys'))}${input('synonym', t('synonym', 'Synonym'))}${input('computerName', t('computer', 'Computer'))}${input('port', t('port', 'Saved port'), 'number')}</div></details><div class="v-client-toolbar"><button type="submit" class="toolbar-btn" data-client-action="save">${escapeHtml(t('save', 'Save'))}</button><button type="button" class="toolbar-btn" data-client-action="cancel">${escapeHtml(t('cancel', 'Cancel'))}</button></div></form>`;
            placeEditor();
            editor.querySelector('input')?.focus();
        }
        function closeEditor() { draft = null; saving = false; pendingEditor = null; pendingSave = null; editor.hidden = true; editor.innerHTML = ''; }
        const changeField = event => { const key = event.target.dataset.clientField; if (draft && key) { draft[key] = key === 'port' ? Number(event.target.value) : event.target.value; } };
        container.addEventListener('input', changeField); container.addEventListener('change', changeField);
        const save = () => { if (!draft || saving) { return; } const { name, username, synonym, clientType, computerName, port, password, additionalParameters } = draft; saving = true; pendingSave = String(++request);
            send('clientSave', { requestId: pendingSave, ...(draft.id ? { clientId: draft.id } : {}), fields: { name, username, synonym, clientType, computerName, port, password, additionalParameters } }); };
        container.addEventListener('submit', event => { event.preventDefault(); save(); });
        container.addEventListener('click', event => {
            const button = event.target.closest('[data-client-action]'); if (!button || button.disabled) { return; } event.preventDefault(); event.stopPropagation();
            const kind = button.dataset.clientAction; const id = button.dataset.clientId;
            if (kind === 'new') { container.querySelector('details').open = true; pendingEditor = null; showEditor(view.defaults); return; }
            if (kind === 'edit') { pendingEditor = String(++request); container.dataset.editingClientId = id; send('clientEdit', { clientId: id, requestId: pendingEditor }); return; }
            if (kind === 'cancel') { closeEditor(); return; }
            if (kind === 'save') { save(); return; }
            if (kind === 'remove') { send('clientRemove', { clientId: id }); return; }
            if (kind === 'refresh') { send('clientRefresh'); return; }
            if (kind === 'import') { send('clientImport', { clientId: id }); }
            if (['add', 'connect', 'disconnect', 'replace'].includes(kind)) { send('clientOperate', { action: kind, clientIds: [id] }); }
        });
        window.addEventListener('message', event => {
            const packet = event.data;
            if (packet?.command === 'clientSaveResult' && packet.infobasePath === base && packet.requestId === pendingSave) {
                saving = false; pendingSave = null; if (packet.success) { closeEditor(); } render(view, base);
            }
            if (packet?.command === 'clientEditor' && packet.infobasePath === base && packet.requestId === pendingEditor && packet.clientId === container.dataset.editingClientId) {
                pendingEditor = null; showEditor(packet.draft, packet.clientId);
            }
        });
        function render(next, infobase) {
            container.classList.toggle('hidden', !next || !infobase); if (!next || !infobase) { closeEditor(); base = ''; return; }
            if (base !== infobase) { closeEditor(); base = infobase; } view = next;
            const busy = !!view.pendingAction || saving; const connection = view.connection;
            container.querySelector('[data-client-empty]').hidden = !!view.rows.length;
            const progress = container.querySelector('[data-client-progress]'); progress.hidden = !busy; progress.textContent = busy ? t('working', 'Updating clients…') : '';
            const markup = renderClientRows(view.rows, null, t); let focused = null;
            if (rowsHost._lastMarkup !== markup) {
                focused = editor.contains(document.activeElement) ? document.activeElement : null;
                rowsHost.after(editor);
                rowsHost.innerHTML = markup; rowsHost._lastMarkup = markup;
            }
            placeEditor();
            focused?.focus({ preventScroll: true });
            for (const button of container.querySelectorAll('[data-client-action]')) {
                const action = button.dataset.clientAction; let disabled = !!view.pendingAction;
                if (action === 'import') { disabled ||= !connection.ready || connection.busy || !connection.read; }
                if (['add', 'connect', 'disconnect', 'replace'].includes(action)) {
                    const row = view.rows.find(item => item.id === button.dataset.clientId);
                    disabled ||= connection.busy || connection.ready && !connection.read || row?.state === 'unsupported' || row?.state === 'conflict' && action !== 'replace';
                    disabled ||= action === 'disconnect' && (!connection.ready || !connection.disconnect) || connection.ready && ((action === 'add' || action === 'replace') && !connection.write || action === 'connect' && !connection.connect);
                }
                button.disabled = disabled || saving && action === 'save';
            }
            const error = container.querySelector('.v-client-error'); error.hidden = !view.error; error.textContent = view.error || '';

        }
        return { render };
    }
    window.KotInfobaseClients = { create };
})();
