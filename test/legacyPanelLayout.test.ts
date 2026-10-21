import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'node-html-parser';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), name), 'utf8');
function runFunction(script: string, name: string, nextName: string, context: Record<string, unknown>) {
    const start = script.indexOf(`    function ${name}(`);
    const end = script.indexOf(`    function ${nextName}(`, start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`${script.slice(start, end)}\n${name}`, context);
}

test('manager pane dividers are accessible siblings between their two panes', () => {
    for (const [file, selector] of [
        ['src/infobaseManagerPanel.ts', 'main.manager-workspace'],
        ['src/formExplorerPanel.ts', 'section.workspace'],
        ['media/yamlParameters.html', '.parameters-workspace']
    ]) {
        const source = read(file);
        const markup = source.slice(source.indexOf('<!DOCTYPE html>'));
        const container = parse(markup).querySelector(selector); assert.ok(container, file);
        assert.equal(container.children.length, 3);
        const divider = container.children[1];
        assert.equal(divider.getAttribute('role'), 'separator');
        assert.equal(divider.getAttribute('tabindex'), '0');
        assert.ok(divider.getAttribute('aria-label'));
    }
});

test('selected-infobase actions are grouped by purpose without losing or duplicating commands', () => {
    const source = read('src/infobaseManagerPanel.ts');
    const grid = parse(source.slice(source.indexOf('<div class="action-grid">'), source.indexOf('<div class="chip-row">')));
    const expected = {
        launch: ['openEnterprise', 'openDesigner', 'startFormExplorer'],
        data: ['restoreDt', 'restoreFromTemplate', 'exportDt', 'copyBase', 'recreate'],
        configuration: ['updateFromTemplate', 'updateConfig', 'saveCf'],
        management: ['editBase', 'revealFolder', 'showLogs', 'addToLauncher', 'removeFromLauncher', 'forgetManual', 'toggleHidden']
    };
    for (const [category, commands] of Object.entries(expected)) {
        const group = grid.querySelector(`.action-category[data-category="${category}"]`);
        assert.ok(group, category);
        assert.ok(group.querySelector('.action-category-title'));
        assert.deepEqual(group.querySelectorAll('[data-command]').map(button => button.getAttribute('data-command')), commands);
    }
    const commands = grid.querySelectorAll('[data-command]');
    assert.equal(commands.length, Object.values(expected).flat().length);
    assert.ok(commands.every(button => button.getAttribute('data-requires-selection') === 'true'));
    assert.equal(grid.querySelectorAll('#moreActionsMenu [data-command]').length, 4);
});

test('selected-infobase name and path stay together beside the status and platform', () => {
    const source = read('src/infobaseManagerPanel.ts');
    const hero = parse(source.slice(source.indexOf('<div class="details-hero">'), source.indexOf('<div class="action-grid">')));
    const controls = hero.querySelector('.details-hero-controls'); assert.ok(controls);
    assert.ok(controls.querySelector('#stateBadge')); assert.ok(controls.querySelector('#launcherStatus'));
    assert.equal(controls.children[0].classNames.includes('details-status'), true);
    assert.equal(controls.children[1].classNames.includes('details-hero-platform-shell'), true);
    const copy = hero.querySelector('.details-copy'); assert.ok(copy);
    assert.deepEqual(copy.children.map(child => child.id), ['infobaseTitle', 'infobasePath']);
});

test('the current form uses a compact outline header without a second panel background', () => {
    const source = read('src/formExplorerPanel.ts');
    const form = parse(source.slice(source.indexOf('<aside class="panel sidebar-panel">'), source.indexOf('<div class="sidebar-section-head">')));
    const current = form.querySelector('#currentFormPanel'); assert.ok(current);
    assert.equal(current.classNames.split(/\s+/u).includes('panel'), false);
    assert.ok(current.querySelector('.current-form-heading .current-form-label'));
    assert.ok(current.querySelector('.current-form-heading #currentFormOpenSourceBtn'));
});

test('infobase action menus stay within the content panel when their button wraps to another line', () => {
    for (const bounds of [{ left: -80, right: 160, hostLeft: 0, hostRight: 420 },
        { left: 320, right: 560, hostLeft: 340, hostRight: 1280 },
        { left: 1050, right: 1290, hostLeft: 340, hostRight: 1280 }]) {
        const menu = { style: { transform: 'translateX(99px)' }, getBoundingClientRect: () => {
            assert.equal(menu.style.transform, ''); return bounds;
        }, closest: () => ({ getBoundingClientRect: () => ({ left: bounds.hostLeft, right: bounds.hostRight }) }) };
        const fit = runFunction(read('media/infobaseManager.js'), 'fitActionMenu', 'toggleMoreActions', { window: { innerWidth: bounds.hostRight } });
        fit(menu);
        const shift = Number(/translateX\(([-.\d]+)px\)/u.exec(menu.style.transform)![1]);
        assert.ok(bounds.left + shift >= bounds.hostLeft + 8);
        assert.ok(bounds.right + shift <= bounds.hostRight - 8);
        fit(menu); // Reopening or resizing must not accumulate the previous offset.
    }
});

test('infobase list rows omit activity and registration status while keeping path, state and hidden status', () => {
    const refs = { infobaseList: { innerHTML: '' } };
    class Element { static [Symbol.hasInstance](value: unknown) { return Boolean(value); } }
    const render = runFunction(read('media/infobaseManager.js'), 'renderList', 'measureSectionBodyHeight', {
        HTMLElement: Element, refs, getVisibleInfobases: () => [{ displayName: 'Demo', infobasePath: '/demo', state: 'ready', hidden: true }],
        matchesSearch: () => true, isManualDragEnabled: () => false, state: {}, loc: {}, escapeHtml: String,
        getStateLabel: () => 'Ready', getLastActivity: () => '', syncAutoScrollText() {}
    });
    render();
    assert.match(refs.infobaseList.innerHTML, /Demo/u); assert.match(refs.infobaseList.innerHTML, /\/demo/u);
    assert.match(refs.infobaseList.innerHTML, /Ready/u); assert.match(refs.infobaseList.innerHTML, /Hidden/u);
    assert.doesNotMatch(refs.infobaseList.innerHTML, /Last activity|1C launcher/u);
});

test('Form Explorer without a snapshot shows one compact details prompt and no duplicate empty facts', () => {
    const refs = Object.fromEntries(['formTitleValue', 'formMetaLine', 'elementCountValue', 'selectedStateRow', 'selectedKeyFacts', 'elementTree', 'detailsPanel', 'attributesPanel', 'commandsPanel', 'attributeCountValue', 'commandCountValue'].map(key => [key, { innerHTML: '', textContent: '', classList: { toggle() {} } }]));
    class Button {}
    const render = runFunction(read('media/formExplorer.js'), 'renderEmptyView', 'renderSidebar', {
        refs, HTMLButtonElement: Button, t: (_key: string, fallback: string) => fallback,
        setText: (element: { textContent: string }, value: string) => { if (element) { element.textContent = value; } },
        renderEmptyState: (title: string) => `<div class="empty-state">${title}</div>`, renderTabs() {}, uiState: {}
    });
    render();
    assert.equal(refs.formTitleValue.textContent, 'Waiting for snapshot');
    assert.equal(refs.selectedKeyFacts.innerHTML, '');
    assert.equal(refs.elementTree.innerHTML, '');
    assert.match(refs.detailsPanel.innerHTML, /Waiting for snapshot/u);
});

test('current form hides unavailable source and empty metadata, restoring them with a new snapshot', () => {
    class Button {
        disabled = false;
        dataset: Record<string, string> = {};
        classes = new Set<string>();
        classList = { toggle: (name: string, enabled: boolean) => { if (enabled) { this.classes.add(name); } else { this.classes.delete(name); } } };
        removeAttribute() {}
    }
    const source = new Button();
    const metadata = Object.assign(new Button(), { textContent: '' });
    const refs = { currentFormOpenSourceBtn: source, formMetaLine: metadata };
    const context = { refs, HTMLButtonElement: Button, uiState: {}, firstDefined: (...values: unknown[]) => values.find(Boolean),
        getFormLabel: () => 'Invoice', renderTabs() {}, renderEmptyState: () => '', t: (_key: string, fallback: string) => fallback,
        setText: (element: { textContent: string } | undefined, value: string) => { if (element) { element.textContent = value; } } };
    const renderEmpty = runFunction(read('media/formExplorer.js'), 'renderEmptyView', 'renderSidebar', context);
    const render = runFunction(read('media/formExplorer.js'), 'renderSidebar', 'renderElementTree', context);
    const assertHidden = (hidden: boolean) => {
        assert.equal(source.classes.has('view-hidden'), hidden);
        assert.equal(metadata.classes.has('view-hidden'), hidden);
        assert.equal(source.disabled, hidden);
    };
    render({ form: { metadataPath: 'Document.Invoice.Form', source: { path: '/demo/Form.xml', line: 12, column: 3 } } }, [], null);
    assertHidden(false);
    assert.deepEqual(source.dataset, { path: '/demo/Form.xml', line: '12', column: '3' });
    renderEmpty();
    assertHidden(true);
    assert.deepEqual(source.dataset, {});
    render({ form: {} }, [], null);
    assertHidden(true);
    render({ form: { metadataPath: 'Document.Invoice.Form', source: { path: '/demo/Form.xml' } } }, [], null);
    assertHidden(false);
});

test('snapshot without a selected element keeps the selection prompt only in details', () => {
    const refs = { selectedKeyFacts: { innerHTML: 'old facts' }, selectedStateRow: { innerHTML: '' } };
    const render = runFunction(read('media/formExplorer.js'), 'renderSelectedElementHeader', 'renderElementDetails', {
        refs, t: (_key: string, fallback: string) => fallback, renderEmptyState: (title: string) => title
    });
    render(null, null, {}, new Map());
    assert.equal(refs.selectedKeyFacts.innerHTML, '');
});

test('rapid Form Explorer search input keeps the final query and schedules one list rebuild', () => {
    let input!: () => void; let renders = 0; let serial = 0;
    const timers = new Map<number, () => void>();
    class Input { value = ''; addEventListener(_name: string, callback: () => void) { input = callback; } }
    const search = new Input(); const state: Record<string, unknown> = {};
    const bind = runFunction(read('media/formExplorer.js'), 'bindStaticEvents', 'focusActiveElement', {
        refs: new Proxy({}, { get: (_target, key) => key === 'searchInput' ? search : null }), HTMLInputElement: Input,
        bindClick() {}, bindElementTypeToggle() {}, tabButtons: [], document: { addEventListener() {} },
        uiState: state, searchRenderTimer: null, pendingScrollReset: false, persistUiState() {}, render: () => { renders++; },
        setTimeout: (callback: () => void) => { timers.set(++serial, callback); return serial; }, clearTimeout: (id: number) => timers.delete(id)
    });
    bind();
    for (const query of ['V', 'Va', 'Van', 'Vanessa']) { search.value = query; input(); }
    assert.equal(state.searchQuery, 'Vanessa'); assert.equal(renders, 0); assert.equal(timers.size, 1);
    for (const callback of timers.values()) { callback(); } assert.equal(renders, 1);
});
