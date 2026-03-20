(function() {
    const vscode = acquireVsCodeApi();
    const loc = window.__formExplorerLoc || {};
    let viewState = window.__formExplorerInitialState || {};
    const persistedState = vscode.getState() || {};
    let copiedResetTimer = null;
    let overflowMenuOpen = false;
    let filterMenuOpen = false;

    const uiState = {
        selectedElementPath: typeof persistedState.selectedElementPath === 'string' ? persistedState.selectedElementPath : '',
        searchQuery: typeof persistedState.searchQuery === 'string' ? persistedState.searchQuery : '',
        showTechnical: Boolean(persistedState.showTechnical),
        showGroups: Boolean(persistedState.showGroups),
        followActive: persistedState.followActive !== false,
        activeTab: isKnownTab(persistedState.activeTab) ? persistedState.activeTab : 'attributes'
    };

    let pendingScrollPath = '';

    const refs = {
        currentFormPanel: document.getElementById('currentFormPanel'),
        moreActionsBtn: document.getElementById('moreActionsBtn'),
        moreActionsMenu: document.getElementById('moreActionsMenu'),
        openSettingsBtn: document.getElementById('openSettingsBtn'),
        openSnapshotFileBtn: document.getElementById('openSnapshotFileBtn'),
        revealSnapshotFileBtn: document.getElementById('revealSnapshotFileBtn'),
        currentFormOpenSourceBtn: document.getElementById('currentFormOpenSourceBtn'),
        focusActiveBtn: document.getElementById('focusActiveBtn'),
        filterMenuBtn: document.getElementById('filterMenuBtn'),
        filterMenu: document.getElementById('filterMenu'),
        showTechnicalInput: document.getElementById('showTechnicalInput'),
        showGroupsInput: document.getElementById('showGroupsInput'),
        searchInput: document.getElementById('searchInput'),
        alertBanner: document.getElementById('alertBanner'),
        alertText: document.getElementById('alertText'),
        pathModeChip: document.getElementById('pathModeChip'),
        pathModeValue: document.getElementById('pathModeValue'),
        modeChip: document.getElementById('modeChip'),
        modeValue: document.getElementById('modeValue'),
        generatedAtValue: document.getElementById('generatedAtValue'),
        formTitleValue: document.getElementById('formTitleValue'),
        formMetaLine: document.getElementById('formMetaLine'),
        elementCountValue: document.getElementById('elementCountValue'),
        elementTree: document.getElementById('elementTree'),
        selectedKeyFacts: document.getElementById('selectedKeyFacts'),
        selectedStateRow: document.getElementById('selectedStateRow'),
        detailsPanel: document.getElementById('detailsPanel'),
        attributesPanel: document.getElementById('attributesPanel'),
        commandsPanel: document.getElementById('commandsPanel'),
        attributeCountValue: document.getElementById('attributeCountValue'),
        commandCountValue: document.getElementById('commandCountValue')
    };

    const tabButtons = Array.from(document.querySelectorAll('[data-tab]'));
    const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'));

    initialize();

    function initialize() {
        bindStaticEvents();
        if (refs.searchInput instanceof HTMLInputElement) {
            refs.searchInput.value = uiState.searchQuery;
        }
        render();
        window.addEventListener('message', event => {
            const message = event.data || {};
            if (message.command === 'setState') {
                viewState = message.state || {};
                render();
            }
        });
        vscode.postMessage({ command: 'ready' });
    }

    function bindStaticEvents() {
        bindClick(refs.moreActionsBtn, event => {
            event.preventDefault();
            event.stopPropagation();
            filterMenuOpen = false;
            overflowMenuOpen = !overflowMenuOpen;
            renderOverflowMenu();
            renderFilterMenu();
        });
        bindClick(refs.filterMenuBtn, event => {
            event.preventDefault();
            event.stopPropagation();
            overflowMenuOpen = false;
            filterMenuOpen = !filterMenuOpen;
            renderFilterMenu();
            renderOverflowMenu();
        });
        bindClick(refs.modeChip, event => {
            event.preventDefault();
            event.stopPropagation();
            overflowMenuOpen = false;
            filterMenuOpen = false;
            renderOverflowMenu();
            renderFilterMenu();
            post('toggleAdapterMode');
        });
        bindClick(refs.openSettingsBtn, () => post('openSettings'));
        bindClick(refs.openSnapshotFileBtn, () => post('openSnapshotFile'));
        bindClick(refs.revealSnapshotFileBtn, () => post('revealSnapshotFile'));
        bindClick(refs.currentFormOpenSourceBtn, event => {
            const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
            if (!(target instanceof HTMLElement) || !target.dataset.path) {
                return;
            }
            post('openSourceLocation', {
                source: {
                    path: target.dataset.path,
                    line: parseNumber(target.dataset.line),
                    column: parseNumber(target.dataset.column)
                }
            });
        });
        bindClick(refs.focusActiveBtn, () => focusActiveElement());
        if (refs.showTechnicalInput instanceof HTMLInputElement) {
            refs.showTechnicalInput.checked = uiState.showTechnical;
            refs.showTechnicalInput.addEventListener('change', () => {
                uiState.showTechnical = refs.showTechnicalInput.checked;
                persistUiState();
                render();
            });
        }
        if (refs.showGroupsInput instanceof HTMLInputElement) {
            refs.showGroupsInput.checked = uiState.showGroups;
            refs.showGroupsInput.addEventListener('change', () => {
                uiState.showGroups = refs.showGroupsInput.checked;
                persistUiState();
                render();
            });
        }

        if (refs.searchInput instanceof HTMLInputElement) {
            refs.searchInput.addEventListener('input', () => {
                uiState.searchQuery = refs.searchInput.value || '';
                persistUiState();
                render();
            });
        }

        for (const button of tabButtons) {
            button.addEventListener('click', () => {
                const nextTab = String(button.dataset.tab || '');
                if (!isKnownTab(nextTab)) {
                    return;
                }
                uiState.activeTab = nextTab;
                persistUiState();
                renderTabs();
            });
        }

        document.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            const action = String(target.dataset.action || '');
            if (action === 'select-element') {
                overflowMenuOpen = false;
                renderOverflowMenu();
                uiState.selectedElementPath = String(target.dataset.path || '');
                uiState.followActive = false;
                pendingScrollPath = uiState.selectedElementPath;
                persistUiState();
                render();
                return;
            }

            if (action === 'focus-active') {
                overflowMenuOpen = false;
                renderOverflowMenu();
                focusActiveElement();
                return;
            }

            if (action === 'copy') {
                overflowMenuOpen = false;
                filterMenuOpen = false;
                renderOverflowMenu();
                renderFilterMenu();
                post('copyToClipboard', { value: String(target.dataset.value || '') });
                flashCopied(target);
                return;
            }

            if (action === 'refresh-snapshot') {
                overflowMenuOpen = false;
                renderOverflowMenu();
                post('refreshSnapshot');
                return;
            }

            if (action === 'build-extension') {
                overflowMenuOpen = false;
                renderOverflowMenu();
                post('buildExtension');
                return;
            }

            if (action === 'choose-snapshot-file') {
                overflowMenuOpen = false;
                renderOverflowMenu();
                post('chooseSnapshotFile');
                return;
            }

            if (action === 'use-configured-path') {
                overflowMenuOpen = false;
                renderOverflowMenu();
                post('useConfiguredSnapshotPath');
                return;
            }

            if (action === 'open-source') {
                overflowMenuOpen = false;
                filterMenuOpen = false;
                renderOverflowMenu();
                renderFilterMenu();
                const sourcePath = String(target.dataset.path || '');
                if (!sourcePath) {
                    return;
                }
                post('openSourceLocation', {
                    source: {
                        path: sourcePath,
                        line: parseNumber(target.dataset.line),
                        column: parseNumber(target.dataset.column)
                    }
                });
            }
        });

        document.addEventListener('click', event => {
            if (!overflowMenuOpen) {
                return;
            }
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('.menu-shell') || target?.closest('.filter-shell')) {
                return;
            }
            overflowMenuOpen = false;
            filterMenuOpen = false;
            renderOverflowMenu();
            renderFilterMenu();
        });
    }

    function focusActiveElement() {
        const snapshot = viewState.snapshot;
        const activePath = snapshot?.form?.activeElementPath || findActiveElementPath(snapshot?.elements || []);
        if (!activePath) {
            return;
        }

        uiState.searchQuery = '';
        if (refs.searchInput instanceof HTMLInputElement) {
            refs.searchInput.value = '';
        }
        uiState.followActive = true;
        uiState.selectedElementPath = activePath;
        pendingScrollPath = activePath;
        persistUiState();
        render();
    }

    function render() {
        renderStaticFrame();
        renderBanner();

        const snapshot = viewState.snapshot;
        if (!snapshot) {
            renderEmptyView();
            return;
        }

        const rawElements = snapshot.elements || [];
        const attributes = snapshot.attributes || [];
        const attributesByPath = new Map(attributes.map(attribute => [attribute.path, attribute]));
        const activePath = snapshot.form?.activeElementPath || findActiveElementPath(rawElements);
        const filteredElements = filterElementTree(rawElements, normalizeQuery(uiState.searchQuery));
        const flatElements = flattenElements(filteredElements);
        const visiblePaths = new Set(flatElements.map(item => item.element.path));

        if (uiState.followActive && activePath && activePath !== uiState.selectedElementPath) {
            uiState.selectedElementPath = activePath;
            pendingScrollPath = activePath;
            persistUiState();
        }

        if (!visiblePaths.has(uiState.selectedElementPath)) {
            const fallbackPath = activePath && visiblePaths.has(activePath)
                ? activePath
                : flatElements[0]?.element.path || '';
            if (fallbackPath !== uiState.selectedElementPath) {
                uiState.selectedElementPath = fallbackPath;
                pendingScrollPath = fallbackPath;
                persistUiState();
            }
        }

        const selectedElement = uiState.selectedElementPath
            ? findElementByPath(rawElements, uiState.selectedElementPath)
            : null;
        const activeElement = activePath
            ? findElementByPath(rawElements, activePath)
            : null;

        renderSidebar(snapshot, flatElements, activeElement);
        renderElementTree(flatElements, activePath, attributesByPath);
        renderSelectedElementHeader(selectedElement, activeElement, snapshot, attributesByPath);
        renderElementDetails(snapshot, selectedElement, activeElement);
        renderAttributes(attributes, selectedElement);
        renderCommands(snapshot.commands || []);

        setText(refs.attributeCountValue, String(attributes.length));
        setText(refs.commandCountValue, String((snapshot.commands || []).length));
        renderTabs();
        scrollPendingSelectionIntoView();
    }

    function renderStaticFrame() {
        const snapshot = viewState.snapshot;
        const generatedAt = snapshot?.generatedAt || viewState.snapshotMtime || '';
        setText(
            refs.pathModeValue,
            viewState.usingCustomSnapshotPath
                ? t('usingCustomPath', 'Custom file')
                : t('usingConfiguredPath', 'Configured path')
        );
        const adapterMode = String(viewState.adapterMode || 'unknown');
        setText(
            refs.modeValue,
            adapterMode === 'auto'
                ? t('modeAuto', 'Auto')
                : adapterMode === 'manual'
                    ? t('modeManual', 'Manual')
                    : t('unknownValue', 'n/a')
        );
        setText(refs.generatedAtValue, generatedAt ? formatDateTime(generatedAt) : t('unknownValue', 'n/a'));
        if (refs.pathModeChip instanceof HTMLElement) {
            refs.pathModeChip.title = viewState.snapshotPath || '';
        }
        if (refs.modeChip instanceof HTMLElement) {
            refs.modeChip.title = viewState.adapterModeStatePath || '';
            refs.modeChip.dataset.mode = adapterMode;
        }

        if (refs.openSnapshotFileBtn instanceof HTMLButtonElement) {
            refs.openSnapshotFileBtn.disabled = !viewState.snapshotPath;
        }
        if (refs.revealSnapshotFileBtn instanceof HTMLButtonElement) {
            refs.revealSnapshotFileBtn.disabled = !viewState.snapshotPath;
        }
        if (refs.searchInput instanceof HTMLInputElement && refs.searchInput.value !== uiState.searchQuery) {
            refs.searchInput.value = uiState.searchQuery;
        }
        if (refs.showGroupsInput instanceof HTMLInputElement) {
            refs.showGroupsInput.checked = uiState.showGroups;
        }
        if (refs.showTechnicalInput instanceof HTMLInputElement) {
            refs.showTechnicalInput.checked = uiState.showTechnical;
        }
        renderOverflowMenu();
        renderFilterMenu();
    }

    function renderBanner() {
        const hasError = Boolean(viewState.lastError);
        refs.alertBanner?.classList.toggle('hidden', !hasError);
        setText(refs.alertText, viewState.lastError || '');
    }

    function renderEmptyView() {
        setText(refs.formTitleValue, t('waitingForSnapshot', 'Waiting for snapshot'));
        if (refs.formTitleValue instanceof HTMLButtonElement) {
            refs.formTitleValue.disabled = true;
            refs.formTitleValue.removeAttribute('data-action');
            refs.formTitleValue.removeAttribute('data-value');
        }
        setText(refs.formMetaLine, '');
        setText(refs.elementCountValue, '0');
        if (refs.currentFormOpenSourceBtn instanceof HTMLButtonElement) {
            refs.currentFormOpenSourceBtn.disabled = true;
            delete refs.currentFormOpenSourceBtn.dataset.path;
            delete refs.currentFormOpenSourceBtn.dataset.line;
            delete refs.currentFormOpenSourceBtn.dataset.column;
        }
        if (refs.focusActiveBtn instanceof HTMLButtonElement) {
            refs.focusActiveBtn.disabled = true;
        }
        if (refs.elementTree) {
            refs.elementTree.innerHTML = renderEmptyState(
                t('waitingForSnapshot', 'Waiting for snapshot'),
                t('noSnapshotHint', 'The panel reads a universal JSON snapshot file produced by a 1C-side adapter in the current client session.')
            );
        }
        if (refs.selectedKeyFacts) {
            refs.selectedKeyFacts.innerHTML = renderEmptyState(
                t('noSelection', 'Select an element in the tree to inspect its details.'),
                ''
            );
        }
        if (refs.selectedStateRow) {
            refs.selectedStateRow.innerHTML = '';
        }
        if (refs.detailsPanel) {
            refs.detailsPanel.innerHTML = renderEmptyState(
                t('waitingForSnapshot', 'Waiting for snapshot'),
                t('noSnapshotHint', 'The panel reads a universal JSON snapshot file produced by a 1C-side adapter in the current client session.')
            );
        }
        if (refs.attributesPanel) {
            refs.attributesPanel.innerHTML = renderEmptyState(t('noAttributes', 'No form attributes in snapshot.'), '');
        }
        if (refs.commandsPanel) {
            refs.commandsPanel.innerHTML = renderEmptyState(t('noCommands', 'No commands in snapshot.'), '');
        }
        setText(refs.attributeCountValue, '0');
        setText(refs.commandCountValue, '0');
        renderTabs();
    }

    function renderSidebar(snapshot, flatElements, activeElement) {
        const formLabel = getFormLabel(snapshot.form);
        setText(refs.formTitleValue, formLabel);
        setText(refs.elementCountValue, String(flatElements.length));
        setText(
            refs.formMetaLine,
            [snapshot.form?.metadataPath, firstDefined(snapshot.form?.type, snapshot.form?.viewKind)]
                .filter(Boolean)
                .join(' • ')
        );
        if (refs.formTitleValue instanceof HTMLButtonElement) {
            refs.formTitleValue.disabled = !formLabel;
            refs.formTitleValue.dataset.action = 'copy';
            refs.formTitleValue.dataset.value = formLabel;
        }

        if (refs.focusActiveBtn instanceof HTMLButtonElement) {
            refs.focusActiveBtn.disabled = !activeElement;
        }
        if (refs.currentFormOpenSourceBtn instanceof HTMLButtonElement) {
            const source = snapshot.form?.source;
            refs.currentFormOpenSourceBtn.disabled = !source?.path;
            if (source?.path) {
                refs.currentFormOpenSourceBtn.dataset.path = source.path;
                refs.currentFormOpenSourceBtn.dataset.line = source.line ? String(source.line) : '';
                refs.currentFormOpenSourceBtn.dataset.column = source.column ? String(source.column) : '';
            } else {
                delete refs.currentFormOpenSourceBtn.dataset.path;
                delete refs.currentFormOpenSourceBtn.dataset.line;
                delete refs.currentFormOpenSourceBtn.dataset.column;
            }
        }
    }

    function renderElementTree(flatElements, activePath, attributesByPath) {
        if (!refs.elementTree) {
            return;
        }

        const preservedScrollTop = refs.elementTree.scrollTop;
        const shouldPreserveScroll = !pendingScrollPath;

        if (flatElements.length === 0) {
            refs.elementTree.innerHTML = renderEmptyState(
                uiState.searchQuery
                    ? t('noMatchingElements', 'No elements match the current filter.')
                    : t('noElements', 'No form elements in snapshot.'),
                uiState.searchQuery || ''
            );
            if (shouldPreserveScroll) {
                refs.elementTree.scrollTop = preservedScrollTop;
            }
            return;
        }

        refs.elementTree.innerHTML = flatElements.map(item => renderOutlineRow(item.element, item.depth, activePath, attributesByPath)).join('');
        if (shouldPreserveScroll) {
            refs.elementTree.scrollTop = preservedScrollTop;
        }
    }

    function renderSelectedElementHeader(selectedElement, activeElement, snapshot, attributesByPath) {
        if (refs.selectedStateRow) {
            refs.selectedStateRow.innerHTML = selectedElement
                ? renderStateChips(collectElementStateChips(selectedElement, activeElement?.path))
                : '';
        }

        if (refs.selectedKeyFacts) {
            if (!selectedElement) {
                refs.selectedKeyFacts.innerHTML = renderEmptyState(
                    t('noSelection', 'Select an element in the tree to inspect its details.'),
                    ''
                );
                return;
            }

            const linkedAttribute = selectedElement.boundAttributePath
                ? (snapshot.attributes || []).find(attribute => attribute.path === selectedElement.boundAttributePath) || null
                : null;

            refs.selectedKeyFacts.innerHTML = [
                renderKeyFactCard(
                    t('uiName', 'UI name'),
                    getElementLabel(selectedElement, attributesByPath),
                    'copy'
                ),
                renderKeyFactCard(
                    t('technicalName', 'Technical name'),
                    firstDefined(selectedElement.name, lastSegment(selectedElement.path), selectedElement.path),
                    'copy'
                ),
                renderKeyFactCard(
                    t('valuePreview', 'Value'),
                    firstDefined(selectedElement.valuePreview, linkedAttribute?.valuePreview, ''),
                    'copy'
                )
            ].filter(Boolean).join('');
        }
    }

    function renderElementDetails(snapshot, selectedElement, activeElement) {
        if (!refs.detailsPanel) {
            return;
        }

        if (!selectedElement) {
            refs.detailsPanel.innerHTML = renderEmptyState(
                t('noSelection', 'Select an element in the tree to inspect its details.'),
                ''
            );
            return;
        }

        const notes = []
            .concat(Array.isArray(snapshot.notes) ? snapshot.notes : [])
            .concat(Array.isArray(snapshot.form?.notes) ? snapshot.form.notes : [])
            .filter(Boolean);

        const sections = [
            renderSectionCard(
                t('elementDetails', 'Element details'),
                renderDetailRows([
                    createDetailRow(t('path', 'Path'), selectedElement.path, true),
                    createDetailRow(t('formType', 'Type'), firstDefined(selectedElement.type, selectedElement.kind)),
                    createDetailRow(t('boundAttribute', 'Bound attribute'), selectedElement.boundAttributePath, true),
                    createDetailRow(t('metadataPath', 'Metadata path'), selectedElement.metadataPath, true),
                    createSourceDetailRow(t('source', 'Source'), selectedElement.source)
                ])
            ),
            (selectedElement.toolTip || selectedElement.titleDataPath)
                ? renderSectionCard(
                    t('details', 'Details'),
                    renderDetailRows([
                        createDetailRow(t('toolTip', 'Tooltip'), selectedElement.toolTip),
                        createDetailRow(t('titleDataPath', 'Title data path'), selectedElement.titleDataPath, true)
                    ])
                )
                : '',
            notes.length > 0
                ? renderSectionCard(
                    t('notes', 'Notes'),
                    `<ul class="notes-list">${notes.map(note => `<li>${escapeHtml(String(note))}</li>`).join('')}</ul>`
                )
                : ''
        ].filter(Boolean);

        refs.detailsPanel.innerHTML = sections.join('');
    }

    function renderAttributes(attributes, selectedElement) {
        if (!refs.attributesPanel) {
            return;
        }

        const linkedAttributePath = selectedElement?.boundAttributePath || '';
        const orderedAttributes = attributes.slice().sort((left, right) => {
            const leftScore = left.path === linkedAttributePath ? 1 : 0;
            const rightScore = right.path === linkedAttributePath ? 1 : 0;
            return rightScore - leftScore || getAttributeLabel(left).localeCompare(getAttributeLabel(right));
        });

        if (orderedAttributes.length === 0) {
            refs.attributesPanel.innerHTML = renderEmptyState(t('noAttributes', 'No form attributes in snapshot.'), '');
            return;
        }

        refs.attributesPanel.innerHTML = `<div class="record-list">${orderedAttributes.map(attribute => renderAttributeCard(attribute, linkedAttributePath)).join('')}</div>`;
    }

    function renderCommands(commands) {
        if (!refs.commandsPanel) {
            return;
        }

        if (commands.length === 0) {
            refs.commandsPanel.innerHTML = renderEmptyState(t('noCommands', 'No commands in snapshot.'), '');
            return;
        }

        refs.commandsPanel.innerHTML = `<div class="record-list">${commands.map(command => renderCommandCard(command)).join('')}</div>`;
    }

    function renderTabs() {
        for (const button of tabButtons) {
            const isActive = button.dataset.tab === uiState.activeTab;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        }

        for (const panel of tabPanels) {
            const isActive = panel.dataset.tabPanel === uiState.activeTab;
            panel.classList.toggle('is-active', isActive);
        }
    }

    function renderOutlineRow(element, depth, activePath, attributesByPath) {
        const uiLabel = getElementLabel(element, attributesByPath);
        const technicalName = firstDefined(
            element.name,
            lastSegment(element.path),
            element.path
        );
        const preview = trimText(firstDefined(element.valuePreview, ''), 90);
        const stateChips = renderStateChips(collectOutlineChips(element, activePath));

        return `
            <button
                class="outline-row${element.path === uiState.selectedElementPath ? ' is-selected' : ''}${element.path === activePath ? ' is-active' : ''}"
                type="button"
                data-action="select-element"
                data-path="${escapeHtml(element.path)}"
                style="--depth:${depth};"
            >
                <span class="outline-main">
                    <span class="outline-title">${escapeHtml(uiLabel)}</span>
                    ${technicalName ? `<span class="outline-subtitle">${escapeHtml(technicalName)}</span>` : ''}
                    ${preview ? `<span class="outline-value">${escapeHtml(preview)}</span>` : ''}
                </span>
                ${stateChips ? `<span class="outline-side">${stateChips}</span>` : ''}
            </button>
        `;
    }

    function renderAttributeCard(attribute, highlightedPath) {
        const isHighlighted = highlightedPath && attribute.path === highlightedPath;
        return `
            <article class="record-card${isHighlighted ? ' is-highlighted' : ''}">
                <div class="record-head">
                    <div class="record-copy">
                        <h3 class="record-title">${escapeHtml(getAttributeLabel(attribute))}</h3>
                        <p class="record-subtitle">${escapeHtml(attribute.path)}</p>
                    </div>
                    <div class="inline-actions">
                        ${renderActionButton({
                            label: t('copyPath', 'Copy path'),
                            icon: 'copy',
                            action: 'copy',
                            value: attribute.path,
                            compact: true
                        })}
                        ${attribute.source?.path ? renderActionButton({
                            label: t('openSourceFile', 'Open source file'),
                            icon: 'go-to-file',
                            action: 'open-source',
                            source: attribute.source,
                            compact: true
                        }) : ''}
                    </div>
                </div>
                <div class="chip-row">${renderStateChips(collectAttributeStateChips(attribute, isHighlighted))}</div>
                <dl class="record-grid">
                    ${renderRecordPair(t('valuePreview', 'Value'), attribute.valuePreview)}
                    ${renderRecordPair(t('formType', 'Type'), attribute.type)}
                    ${renderRecordPair(t('metadataPath', 'Metadata path'), attribute.metadataPath)}
                </dl>
            </article>
        `;
    }

    function renderCommandCard(command) {
        return `
            <article class="record-card">
                <div class="record-head">
                    <div class="record-copy">
                        <h3 class="record-title">${escapeHtml(firstDefined(command.title, command.name, t('unknownValue', 'n/a')))}</h3>
                        <p class="record-subtitle">${escapeHtml(command.name)}</p>
                    </div>
                    <div class="inline-actions">
                        ${renderActionButton({
                            label: t('copyPath', 'Copy path'),
                            icon: 'copy',
                            action: 'copy',
                            value: command.name,
                            compact: true
                        })}
                    </div>
                </div>
                <div class="chip-row">${renderStateChips(collectCommandStateChips(command))}</div>
                <dl class="record-grid">
                    ${renderRecordPair(t('name', 'Name'), command.name)}
                    ${renderRecordPair(t('source', 'Source'), command.action)}
                </dl>
            </article>
        `;
    }

    function renderKeyFactCard(label, value, action, emphasize) {
        const normalizedValue = firstDefined(value, '');
        const className = `key-fact${normalizedValue ? '' : ' is-empty'}${emphasize ? ' emphasized' : ''}${normalizedValue && action ? ' is-copyable' : ''}`;
        if (!normalizedValue) {
            return `
                <div class="${className}">
                    <span class="key-fact-label">${escapeHtml(label)}</span>
                    <span class="key-fact-value empty">${escapeHtml(t('unknownValue', 'n/a'))}</span>
                </div>
            `;
        }

        return `
            <button class="${className}" type="button" data-action="${escapeHtml(action)}" data-value="${escapeHtml(normalizedValue)}">
                <span class="key-fact-label-row">
                    <span class="key-fact-label">${escapeHtml(label)}</span>
                    <span class="key-fact-copy codicon codicon-copy"></span>
                </span>
                <span class="key-fact-value">${escapeHtml(normalizedValue)}</span>
            </button>
        `;
    }

    function renderSectionCard(title, bodyHtml) {
        if (!bodyHtml) {
            return '';
        }
        return `
            <section class="section-card">
                <h3>${escapeHtml(title)}</h3>
                ${bodyHtml}
            </section>
        `;
    }

    function renderDetailRows(rows) {
        const visibleRows = rows.filter(Boolean);
        if (visibleRows.length === 0) {
            return renderEmptyState(t('unknownValue', 'n/a'), '');
        }
        return `<dl class="detail-list">${visibleRows.join('')}</dl>`;
    }

    function createDetailRow(label, value, emphasize) {
        if (!value) {
            return '';
        }
        const renderedValue = emphasize
            ? `<code>${escapeHtml(String(value))}</code>`
            : escapeHtml(String(value));
        return `
            <div class="detail-row">
                <dt>${escapeHtml(label)}</dt>
                <dd>${renderedValue}</dd>
            </div>
        `;
    }

    function createSourceDetailRow(label, source) {
        if (!source || !source.path) {
            return '';
        }

        const displayValue = formatSourceLocation(source);
        return `
            <div class="detail-row">
                <dt>${escapeHtml(label)}</dt>
                <dd>
                    <button
                        class="detail-link"
                        type="button"
                        data-action="open-source"
                        data-path="${escapeHtml(source.path)}"
                        ${source.line ? `data-line="${String(source.line)}"` : ''}
                        ${source.column ? `data-column="${String(source.column)}"` : ''}
                    >
                        <code>${escapeHtml(displayValue)}</code>
                    </button>
                </dd>
            </div>
        `;
    }

    function renderRecordPair(label, value) {
        if (!value) {
            return '';
        }
        return `
            <div class="record-pair">
                <dt>${escapeHtml(label)}</dt>
                <dd>${escapeHtml(String(value))}</dd>
            </div>
        `;
    }

    function renderEmptyState(title, hint) {
        return `
            <div class="empty-state">
                <strong>${escapeHtml(title)}</strong>
                ${hint ? `<span>${escapeHtml(hint)}</span>` : ''}
            </div>
        `;
    }

    function renderActionButton(options) {
        const attrs = [
            `class="${options.compact ? 'mini-btn compact' : 'mini-btn'}"`,
            'type="button"',
            `data-action="${escapeHtml(options.action)}"`
        ];

        if (options.value !== undefined) {
            attrs.push(`data-value="${escapeHtml(String(options.value))}"`);
        }
        if (options.source?.path) {
            attrs.push(`data-path="${escapeHtml(options.source.path)}"`);
            if (options.source.line) {
                attrs.push(`data-line="${String(options.source.line)}"`);
            }
            if (options.source.column) {
                attrs.push(`data-column="${String(options.source.column)}"`);
            }
        }

        return `
            <button ${attrs.join(' ')}>
                <span class="codicon codicon-${escapeHtml(options.icon)}"></span>
                <span>${escapeHtml(options.label)}</span>
            </button>
        `;
    }

    function renderStateChips(chips) {
        return chips.map(chip => `
            <span class="state-chip${chip.tone ? ` ${chip.tone}` : ''}">${escapeHtml(chip.label)}</span>
        `).join('');
    }

    function collectOutlineChips(element, activePath) {
        const chips = [];
        if (element.path === activePath || element.active) {
            chips.push({ label: t('active', 'Active'), tone: 'accent' });
        }
        if (element.visible === false) {
            chips.push({ label: t('hidden', 'Hidden'), tone: 'muted' });
        }
        if (element.available === false || element.enabled === false) {
            chips.push({ label: t('disabled', 'Disabled'), tone: 'warning' });
        }
        if (element.readOnly) {
            chips.push({ label: t('readOnly', 'Read-only'), tone: 'neutral' });
        }
        return chips;
    }

    function collectElementStateChips(element, activePath) {
        const chips = [];
        if (element.path === activePath || element.active) {
            chips.push({ label: t('active', 'Active'), tone: 'accent' });
        }
        if (element.visible !== undefined) {
            chips.push({
                label: element.visible ? t('visible', 'Visible') : t('hidden', 'Hidden'),
                tone: element.visible ? 'good' : 'muted'
            });
        }
        if (element.available !== undefined) {
            chips.push({
                label: element.available ? t('available', 'Available') : t('unavailable', 'Unavailable'),
                tone: element.available ? 'good' : 'warning'
            });
        }
        if (element.readOnly !== undefined) {
            chips.push({
                label: element.readOnly ? t('readOnly', 'Read-only') : t('writable', 'Writable'),
                tone: element.readOnly ? 'neutral' : 'good'
            });
        }
        return chips;
    }

    function collectAttributeStateChips(attribute, isHighlighted) {
        const chips = [];
        if (isHighlighted) {
            chips.push({ label: t('linkedAttribute', 'Linked attribute'), tone: 'accent' });
        }
        if (attribute.visible !== undefined) {
            chips.push({
                label: attribute.visible ? t('visible', 'Visible') : t('hidden', 'Hidden'),
                tone: attribute.visible ? 'good' : 'muted'
            });
        }
        if (attribute.available !== undefined) {
            chips.push({
                label: attribute.available ? t('available', 'Available') : t('unavailable', 'Unavailable'),
                tone: attribute.available ? 'good' : 'warning'
            });
        }
        if (attribute.readOnly !== undefined) {
            chips.push({
                label: attribute.readOnly ? t('readOnly', 'Read-only') : t('writable', 'Writable'),
                tone: attribute.readOnly ? 'neutral' : 'good'
            });
        }
        if (attribute.required) {
            chips.push({ label: t('required', 'Required'), tone: 'accent' });
        }
        return chips;
    }

    function collectCommandStateChips(command) {
        if (command.available === undefined) {
            return [];
        }
        return [{
            label: command.available ? t('available', 'Available') : t('unavailable', 'Unavailable'),
            tone: command.available ? 'good' : 'warning'
        }];
    }

    function filterElementTree(elements, query) {
        return (elements || [])
            .map(element => filterElementNode(element, query))
            .filter(Boolean);
    }

    function filterElementNode(element, query) {
        const children = (element.children || [])
            .map(child => filterElementNode(child, query))
            .filter(Boolean);
        const hiddenTechnical = !uiState.showTechnical && isTechnicalElement(element);
        const hiddenGroup = !uiState.showGroups && isGroupElement(element);
        const matchesSelf = !query || elementMatchesQuery(element, query);

        if ((hiddenTechnical || hiddenGroup) && children.length === 0) {
            return null;
        }

        if (!query) {
            return { ...element, children };
        }

        if (!hiddenTechnical && !hiddenGroup && (matchesSelf || children.length > 0)) {
            return { ...element, children };
        }

        if (children.length > 0) {
            return { ...element, children };
        }

        return null;
    }

    function flattenElements(elements, depth) {
        const result = [];
        for (const element of elements || []) {
            const baseDepth = depth || 0;
            const hiddenTechnical = !uiState.showTechnical && isTechnicalElement(element);
            const hiddenGroup = !uiState.showGroups && isGroupElement(element);
            if (!hiddenTechnical && !hiddenGroup) {
                result.push({ element, depth: baseDepth });
            }
            result.push(...flattenElements(element.children || [], (hiddenTechnical || hiddenGroup) ? baseDepth : baseDepth + 1));
        }
        return result;
    }

    function findElementByPath(elements, targetPath) {
        for (const element of elements || []) {
            if (element.path === targetPath) {
                return element;
            }
            const nested = findElementByPath(element.children || [], targetPath);
            if (nested) {
                return nested;
            }
        }
        return null;
    }

    function findActiveElementPath(elements) {
        for (const element of elements || []) {
            if (element.active) {
                return element.path;
            }
            const nested = findActiveElementPath(element.children || []);
            if (nested) {
                return nested;
            }
        }
        return '';
    }

    function elementMatchesQuery(element, query) {
        return matchesQuery([
            element.title,
            element.synonym,
            element.name,
            element.path,
            element.boundAttributePath,
            element.valuePreview,
            element.toolTip,
            element.inputHint
        ], query);
    }

    function matchesQuery(values, query) {
        return values.some(value => normalizeQuery(value).includes(query));
    }

    function scrollPendingSelectionIntoView() {
        if (!pendingScrollPath || !refs.elementTree) {
            return;
        }
        const rows = refs.elementTree.querySelectorAll('[data-action="select-element"]');
        for (const row of rows) {
            if (!(row instanceof HTMLElement)) {
                continue;
            }
            if (row.dataset.path === pendingScrollPath) {
                row.scrollIntoView({ block: 'center' });
                break;
            }
        }
        pendingScrollPath = '';
    }

    function isTechnicalElement(element) {
        const probe = normalizeQuery([
            element.path,
            element.name,
            element.kind,
            element.type
        ].filter(Boolean).join(' '));
        return /contextmenu|extendedtooltip|tooltip/.test(probe);
    }

    function isGroupElement(element) {
        const probe = normalizeQuery([element.kind, element.type].filter(Boolean).join(' '));
        return probe.includes('form group');
    }

    function getFormLabel(form) {
        return firstDefined(
            form?.windowTitle,
            form?.title,
            humanizeToken(form?.name),
            humanizeMetadataPath(form?.metadataPath),
            t('waitingForSnapshot', 'Waiting for snapshot')
        );
    }

    function getElementLabel(element, attributesByPath) {
        const linkedAttribute = element?.boundAttributePath ? attributesByPath?.get(element.boundAttributePath) : null;
        return firstDefined(
            element.title,
            linkedAttribute?.title,
            linkedAttribute?.synonym,
            element.synonym,
            humanizeToken(element.name),
            humanizeMetadataPath(element.boundAttributePath),
            humanizeMetadataPath(element.path),
            t('unknownValue', 'n/a')
        );
    }

    function getAttributeLabel(attribute) {
        return firstDefined(
            attribute.title,
            attribute.synonym,
            humanizeToken(attribute.name),
            humanizeMetadataPath(attribute.path),
            t('unknownValue', 'n/a')
        );
    }

    function humanizeMetadataPath(candidatePath) {
        if (!candidatePath) {
            return '';
        }
        const segment = lastSegment(candidatePath);
        return humanizeToken(segment) || candidatePath;
    }

    function humanizeToken(value) {
        if (!value) {
            return '';
        }
        return String(value)
            .replace(/[_-]+/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim();
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

    function formatSourceLocation(source) {
        if (!source || !source.path) {
            return '';
        }
        const suffix = source.line
            ? `:${source.line}${source.column ? `:${source.column}` : ''}`
            : '';
        return `${source.path}${suffix}`;
    }

    function trimText(value, maxLength) {
        const text = String(value || '');
        if (text.length <= maxLength) {
            return text;
        }
        return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
    }

    function normalizeQuery(value) {
        return String(value || '').trim().toLocaleLowerCase();
    }

    function firstDefined() {
        for (const value of arguments) {
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
        return '';
    }

    function lastSegment(value) {
        if (!value) {
            return '';
        }
        const parts = String(value).split('.').filter(Boolean);
        return parts[parts.length - 1] || '';
    }

    function parseNumber(value) {
        if (!value) {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    function bindClick(element, handler) {
        if (element) {
            element.addEventListener('click', handler);
        }
    }

    function setText(element, value) {
        if (element) {
            element.textContent = value || '';
        }
    }

    function renderOverflowMenu() {
        if (refs.moreActionsMenu instanceof HTMLElement) {
            refs.moreActionsMenu.classList.toggle('is-open', overflowMenuOpen);
        }
        if (refs.moreActionsBtn instanceof HTMLButtonElement) {
            refs.moreActionsBtn.setAttribute('aria-expanded', overflowMenuOpen ? 'true' : 'false');
        }
    }

    function renderFilterMenu() {
        if (refs.filterMenu instanceof HTMLElement) {
            refs.filterMenu.classList.toggle('is-open', filterMenuOpen);
        }
        if (refs.filterMenuBtn instanceof HTMLButtonElement) {
            refs.filterMenuBtn.setAttribute('aria-expanded', filterMenuOpen ? 'true' : 'false');
            refs.filterMenuBtn.classList.toggle('is-active', uiState.showTechnical || uiState.showGroups);
        }
    }

    function flashCopied(target) {
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const feedbackTarget = target;

        const previous = document.querySelector('.is-copied');
        if (previous instanceof HTMLElement && previous !== feedbackTarget) {
            previous.classList.remove('is-copied');
            previous.removeAttribute('data-copy-feedback');
        }

        feedbackTarget.classList.add('is-copied');
        feedbackTarget.setAttribute('data-copy-feedback', t('copied', 'Copied'));

        if (copiedResetTimer) {
            clearTimeout(copiedResetTimer);
        }

        copiedResetTimer = setTimeout(() => {
            feedbackTarget.classList.remove('is-copied');
            feedbackTarget.removeAttribute('data-copy-feedback');
        }, 1200);
    }

    function post(command, extra) {
        vscode.postMessage({
            command,
            ...(extra || {})
        });
    }

    function persistUiState() {
        vscode.setState({ ...uiState });
    }

    function t(key, fallback) {
        return loc[key] || fallback;
    }

    function isKnownTab(value) {
        return value === 'attributes' || value === 'commands';
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
})();
