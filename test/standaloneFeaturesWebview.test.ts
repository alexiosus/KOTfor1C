import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const phaseProtocol = require(path.join(process.cwd(), 'media', 'phaseSwitcherProtocol.js'));

class Element {
    readonly children: Element[] = [];
    readonly dataset: Record<string, string> = {};
    readonly attributes: Record<string, string> = {};
    readonly listeners = new Map<string, Array<(event: any) => void>>();
    parentElement?: Element;
    className = '';
    textContent = '';
    tabIndex = -1;
    disabled = false;
    title = '';
    scrollTop = 0;
    scrollHeight = 300;
    clientWidth = 100;
    scrollWidth = 200;
    onFocus?: (element: Element, options?: { preventScroll?: boolean }) => void;
    onDetach?: (element: Element) => void;
    styleProperties = new Map<string, string>();
    style = {
        setProperty: (name: string, value: string) => { this.styleProperties.set(name, value); },
        getPropertyValue: (name: string) => this.styleProperties.get(name) ?? '',
        left: '', top: ''
    };
    classList = {
        add: (...values: string[]) => { this.className = [...new Set([...this.className.split(' '), ...values])].join(' ').trim(); },
        remove: (...values: string[]) => { this.className = this.className.split(' ').filter(value => !values.includes(value)).join(' '); },
        contains: (value: string) => this.className.split(' ').includes(value),
        toggle: (value: string, force?: boolean) => { const add = force ?? !this.classList.contains(value); if (add) { this.classList.add(value); } else { this.classList.remove(value); } return add; }
    };
    append(...values: Element[]): void { for (const value of values) { value.remove(); this.children.push(value); value.parentElement = this; } }
    appendChild(value: Element): Element { this.append(value); return value; }
    insertBefore(value: Element, before?: Element | null): void {
        if (!before) { this.append(value); return; }
        value.remove();
        this.children.splice(this.children.indexOf(before), 0, value);
        value.parentElement = this;
    }
    replaceChildren(...values: Element[]): void { this.children.splice(0); this.append(...values); }
    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    getAttribute(name: string): string | undefined { return this.attributes[name]; }
    addEventListener(name: string, listener: (event: any) => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
    removeEventListener(name: string, listener: (event: any) => void): void { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(value => value !== listener)); }
    remove(): void {
        if (this.parentElement) {
            const siblings = this.parentElement.children;
            const index = siblings.indexOf(this);
            if (index >= 0) { siblings.splice(index, 1); this.onDetach?.(this); }
            this.parentElement = undefined;
        }
    }
    contains(value: Element): boolean { return this === value || this.children.some(child => child.contains(value)); }
    closest(selector: string): Element | undefined {
        const className = selector.startsWith('.') ? selector.slice(1).split('[')[0] : '';
        return this.attributes.tag === selector || (className && this.classList.contains(className)) ? this : this.parentElement?.closest(selector);
    }
    focus(options?: { preventScroll?: boolean }): void { this.onFocus?.(this, options); this.fire('focus'); }
    getBoundingClientRect(): { width: number; height: number } { return { width: 180, height: 100 }; }
    querySelectorAll(selector: string): Element[] { return descendants(this).filter(value => selector === 'button' ? value.attributes.tag === 'button' : value.classList.contains(selector.slice(1).split('[')[0])); }
    querySelector(selector: string): Element | undefined { return this.querySelectorAll(selector)[0]; }
    fire(name: string, fields: Record<string, unknown> = {}): void {
        const event = { target: this, preventDefault: () => undefined, stopPropagation: () => undefined, ...fields };
        for (const listener of this.listeners.get(name) ?? []) { listener(event); }
    }
}

function descendants(root: Element): Element[] { return root.children.flatMap(child => [child, ...descendants(child)]); }
function textOf(root: Element): string { return [root.textContent, ...root.children.map(textOf)].join(' '); }

function nativeContextMenus(h: ReturnType<typeof harness>, standaloneFeatures: unknown) {
    const source = fs.readFileSync(path.join(process.cwd(), 'media', 'phaseSwitcher.js'), 'utf8');
    const start = source.indexOf('    function closeAssembleOptionsMenu()');
    const end = source.indexOf('    function handlePhaseContextMenu(', start);
    return vm.runInNewContext(`(function () { let activeContextMenu = null; let activeContextSubmenu = null; ${source.slice(start, end)}; return { showContextMenuAt, showContextSubmenuForItem, closeContextMenu }; }())`, {
        standaloneFeatures, assembleSplitContainer: null, document: h.document, window: h.window,
        HTMLElement: Element, escapeHtmlAttr: (value: string) => value
    });
}

function harness(mode = 'library', managerUi: Record<string, unknown> = {}) {
    const messages: unknown[] = [];
    const body = new Element();
    const window = new Element();
    Object.assign(window, { innerWidth: 500, innerHeight: 900 });
    const scrollContainer = new Element();
    scrollContainer.className = 'manager-trees-scroll';
    const document: { activeElement?: Element; body: Element; createElement: (tag: string) => Element; addEventListener: any; removeEventListener: any } = {
        body,
        createElement: (tag: string) => {
            const value = new Element();
            value.attributes.tag = tag;
            value.onFocus = (element, options) => {
                document.activeElement = element;
                if (!options?.preventScroll) { scrollContainer.scrollTop = 0; }
            };
            value.onDetach = element => { if (document.activeElement && element.contains(document.activeElement)) { document.activeElement = undefined; } };
            return value;
        },
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window)
    };
    const file = path.join(process.cwd(), 'media', 'standaloneFeatures.js');
    vm.runInNewContext(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', { window, document, console, requestAnimationFrame: (fn: () => void) => fn() });
    const api = (window as unknown as { KotStandaloneFeatures?: { create(options: unknown): any } }).KotStandaloneFeatures;
    const container = new Element();
    body.append(scrollContainer);
    scrollContainer.append(container);
    const labels = { title: 'Standalone features', ungrouped: 'Ungrouped', empty: 'Empty', noMatches: 'No matches', emptyGroup: 'Empty group', createFeature: 'New feature', createGroup: 'New group', moveFeature: 'Move feature', openFeature: 'Open feature', run: 'Run feature', openLog: 'Open log', passed: 'Passed' };
    const create = () => api!.create({ container, mode, labels, managerUi: { relationshipProtocol: phaseProtocol, formatRunProgress: phaseProtocol.formatRunProgress, ...managerUi }, vscode: { postMessage: (message: unknown) => messages.push(message) } });
    return { api, create, container, messages, body, document, window, scrollContainer };
}

const snapshot = {
    revision: 1,
    groups: [{ id: 'smoke', name: 'Smoke' }, { id: 'empty', name: 'Empty group' }],
    features: [
        { id: 'file:///a/same.feature', uri: 'file:///a/same.feature', title: 'First title', name: 'same', relativePath: 'a/same.feature', groupId: '', order: 0 },
        { id: 'file:///c/other.feature', uri: 'file:///c/other.feature', title: 'Third title', name: 'other', relativePath: 'c/other.feature', groupId: '', order: 1 },
        { id: 'file:///b/same.feature', uri: 'file:///b/same.feature', title: 'Second title', name: 'same', relativePath: 'b/same.feature', groupId: 'smoke', order: 0 }
    ]
};

test('manager standalone groups and features reorder by drag handles with local and shared scopes', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot({ ...snapshot, ordering: { groupRoots: { smoke: ['/project'], empty: ['/project'] },
        featureRoots: Object.fromEntries(snapshot.features.map(feature => [feature.id, '/project'])) } });
    const groups = descendants(h.container).filter(row => row.classList.contains('standalone-group-row'));
    const handle = groups[2].querySelector('.project-order-drag-handle')!;
    assert.ok(handle);
    const data = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: '', dropEffect: '' };
    handle.fire('dragstart', { dataTransfer });
    groups[1].fire('dragover', { dataTransfer });
    assert.ok(groups[1].classList.contains('is-order-drop-before'));
    groups[1].fire('drop', { dataTransfer });
    assert.equal(JSON.stringify(h.messages[0]), JSON.stringify({ command: 'standaloneFeatureAction', action: 'reorderGroup',
        projectRoot: '/project', groupId: 'empty', beforeId: 'smoke', expectedIds: ['smoke', 'empty'], revision: 1 }));
    const features = descendants(h.container).filter(row => row.dataset.featureId);
    features[0].querySelector('.project-order-drag-handle')!.fire('dragstart', { dataTransfer });
    features[2].fire('drop', { dataTransfer });
    assert.equal(JSON.stringify(h.messages[1]), JSON.stringify({ command: 'standaloneFeatureAction', action: 'moveFeature',
        featureId: 'file:///a/same.feature', groupId: 'smoke', beforeId: 'file:///b/same.feature', projectRoot: '/project', revision: 1 }));
    features[0].fire('contextmenu');
    assert.equal(descendants(h.document.body).some(node => node.dataset.action === 'moveUp' || node.dataset.action === 'moveDown'), false);
    tree.dispose();
});

test('manager standalone drops reject another owner even when shared group IDs are copied', () => {
    const h = harness('manager');
    const tree = h.create();
    const owned = { ...snapshot, groups: [{ id: 'smoke', name: 'Smoke', projectRoot: '/one' }, { id: 'smoke', name: 'Smoke', projectRoot: '/two' }],
        ordering: { groupRoots: { smoke: ['/one', '/two'] }, featureRoots: Object.fromEntries(snapshot.features.map(feature => [feature.id, feature.id === 'file:///b/same.feature' ? '/two' : '/one'])) } };
    tree.setSnapshot(owned);
    const groups = descendants(h.container).filter(row => row.classList.contains('standalone-group-row'));
    assert.deepEqual(groups.map(group => group.querySelector('.standalone-count')!.textContent), ['2', '0', '1']);
    const feature = descendants(h.container).find(row => row.dataset.featureId === 'file:///a/same.feature')!;
    const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' };
    feature.querySelector('.project-order-drag-handle')!.fire('dragstart', { dataTransfer });
    groups[2].fire('dragover', { dataTransfer });
    groups[2].fire('drop', { dataTransfer });
    assert.equal(groups[2].classList.contains('is-order-drop-target'), false);
    assert.equal(h.messages.length, 0);
    tree.setSnapshot({ ...owned, revision: 2 });
    descendants(h.container).find(row => row.classList.contains('standalone-group-row'))!.fire('drop', { dataTransfer });
    assert.equal(h.messages.length, 0, 'refresh invalidates the stale drag');
    tree.dispose();
});

test('standalone manager patches relationships and related-only visibility without replacing focused rows or menus', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const feature = descendants(h.container).find(row => row.dataset.featureId === 'file:///a/same.feature')!;
    feature.focus({ preventScroll: true });
    h.scrollContainer.scrollTop = 120;
    feature.fire('contextmenu');
    const menu = h.body.querySelector('.standalone-context-menu');
    tree.setRelationshipState({ enabled: true, currentScenarioKeys: [], relationships: [
        { scenarioKey: 'file:///a/same.feature', incomingDistance: 1 }
    ] }, true);
    assert.ok(feature.classList.contains('affected-main-scenario'));
    assert.ok(feature.classList.contains('incoming-scenario'));
    assert.match(feature.getAttribute('data-relationship-label')!, /Calls the open scenario/u);
    const other = descendants(h.container).find(row => row.dataset.featureId === 'file:///b/same.feature')!;
    assert.ok(other.classList.contains('relationship-hidden'));
    assert.equal(feature, descendants(h.container).find(row => row.dataset.featureId === 'file:///a/same.feature'));
    assert.equal(h.body.querySelector('.standalone-context-menu'), menu);
    assert.equal(h.scrollContainer.scrollTop, 120);
    const ungrouped = descendants(h.container).find(row => row.classList.contains('standalone-group-row') && row.dataset.groupId === '')!;
    assert.ok(ungrouped.classList.contains('phase-header-affected'));
    const emptyChildren = descendants(h.container).find(row => row.classList.contains('standalone-group-children') && row.dataset.groupId === 'empty')!;
    assert.ok(emptyChildren.classList.contains('relationship-hidden'), 'hide empty children together with their unrelated group');
    assert.equal(ungrouped.querySelector('.standalone-count')!.textContent, '1');
    tree.setRelationshipState({ enabled: false, currentScenarioKeys: ['file:///a/same.feature'], relationships: [] }, false);
    assert.equal(feature.classList.contains('affected-main-scenario'), false);
    assert.equal(other.classList.contains('relationship-hidden'), false);
    assert.equal(emptyChildren.classList.contains('relationship-hidden'), false);
});

test('shared tree retains empty groups and searches relative paths without merging duplicate filenames', () => {
    const h = harness();
    assert.ok(h.api, 'shared feature tree API is available');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    assert.equal(descendants(h.container).filter(row => row.dataset.featureId).length, 3);
    assert.ok(textOf(h.container).includes('Empty group'));
    assert.ok(textOf(h.container).includes('a/same.feature'));
    tree.setSearch('b/same');
    assert.deepEqual(descendants(h.container).filter(row => row.dataset.featureId).map(row => row.dataset.featureId), ['file:///b/same.feature']);
    tree.dispose();
});

test('tree drag ordering and keyboard move emit URI identities and destination group', () => {
    const h = harness();
    assert.ok(h.api, 'shared feature tree API is available');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const rows = descendants(h.container).filter(row => row.dataset.featureId);
    const data = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: '', dropEffect: '' };
    rows[0].fire('dragstart', { dataTransfer });
    rows[2].fire('drop', { dataTransfer });
    assert.equal(JSON.stringify(h.messages[0]), JSON.stringify({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///a/same.feature', groupId: 'smoke', beforeId: 'file:///b/same.feature' }));
    rows[0].fire('keydown', { key: 'M', ctrlKey: true, shiftKey: true });
    assert.equal(JSON.stringify(h.messages[1]), JSON.stringify({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///a/same.feature' }));
    rows[0].fire('keydown', { key: 'ArrowDown', altKey: true });
    assert.equal(JSON.stringify(h.messages[2]), JSON.stringify({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///a/same.feature', groupId: '' }));
    tree.dispose();
});

test('manager tree presents run status and sends run and log actions', () => {
    const h = harness('manager');
    assert.ok(h.api, 'shared feature tree API is available');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'passed', canOpenRunLog: true } });
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    assert.equal(row.dataset.runStatus, 'passed');
    descendants(row).find(value => value.dataset.action === 'run')!.fire('click');
    row.fire('contextmenu', { clientX: 40, clientY: 60 });
    const menu = descendants(h.body).find(value => value.attributes.role === 'menu')!;
    descendants(menu).find(value => value.dataset.action === 'openLog')!.fire('click');
    assert.equal(JSON.stringify(h.messages), JSON.stringify([
        { command: 'standaloneFeatureAction', action: 'run', featureId: 'file:///a/same.feature' },
        { command: 'standaloneFeatureAction', action: 'openLog', featureId: 'file:///a/same.feature' }
    ]));
    tree.dispose();
});

test('manager hierarchy assigns one native indentation depth per level and retains the file/status slots', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const section = descendants(h.container).find(value => value.dataset.identity === 'standalone-section')!;
    const group = descendants(h.container).find(value => value.dataset.identity === 'standalone-group:smoke')!;
    const feature = descendants(h.container).find(value => value.dataset.featureId === 'file:///b/same.feature')!;
    const depths = [section, group, feature].map(row => row.style.getPropertyValue('--standalone-depth'));
    assert.deepEqual(depths, ['0', '1', '2'], 'each hierarchy level advances one native disclosure slot');
    assert.deepEqual([section, group, feature].map(row => row.attributes['aria-level']), ['1', '2', '3']);
    assert.ok(feature.parentElement?.classList.contains('standalone-group-children'));
    const status = feature.querySelector('.standalone-leading-control')!;
    const source = descendants(feature).find(value => value.dataset.action === 'openFeature')!;
    const label = feature.querySelector('.checkbox-label-text')!;
    assert.ok(feature.children.indexOf(status) < feature.children.indexOf(source));
    assert.ok(feature.children.indexOf(source) < feature.children.indexOf(label));
    assert.ok(source.querySelector('.codicon-file'));
    tree.dispose();
});

test('disabled manager keeps source navigation while suppressing run and organization changes', () => {
    const h = harness('manager');
    assert.ok(h.api, 'shared feature tree API is available');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    assert.equal(typeof tree.setEnabled, 'function');
    tree.setEnabled(false);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    const run = descendants(row).find(value => value.dataset.action === 'run')!;
    assert.equal(run.disabled, true);
    row.fire('keydown', { key: 'M', ctrlKey: true, shiftKey: true });
    row.fire('keydown', { key: 'Enter' });
    assert.equal(JSON.stringify(h.messages), JSON.stringify([{ command: 'standaloneFeatureAction', action: 'openFeature', featureId: 'file:///a/same.feature' }]));
    tree.dispose();
});

test('feature rows select on click and do not treat action-button keys as source activation', () => {
    const h = harness('manager');
    assert.ok(h.api, 'shared feature tree API is available');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    row.fire('click');
    assert.equal(row.attributes['aria-selected'], 'true');
    const run = descendants(row).find(value => value.dataset.action === 'run')!;
    row.fire('keydown', { key: 'Enter', target: run });
    assert.equal(h.messages.length, 0);
    tree.dispose();
});

test('selecting a feature preserves the current manager scroll position', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    h.scrollContainer.scrollTop = 600;
    row.fire('click');
    assert.equal(row.attributes['aria-selected'], 'true');
    assert.equal(h.scrollContainer.scrollTop, 600);
    tree.dispose();
});

test('control and run updates preserve feature rows and an open context menu', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    row.fire('contextmenu', { clientX: 40, clientY: 60 });
    const menu = descendants(h.body).find(value => value.attributes.role === 'menu')!;
    assert.ok(menu);
    tree.setEnabled(true);
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'passed', canOpenRunLog: true } });
    assert.ok(descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature') === row, 'run updates preserve the existing row');
    assert.equal(row.dataset.runStatus, 'passed');
    assert.ok(h.body.contains(menu), 'the currently open menu stays visible');
    const openLog = descendants(menu).find(value => value.dataset.action === 'openLog')!;
    assert.ok(openLog, 'log availability is updated in the visible menu');
    assert.equal(openLog.disabled, false);
    openLog.fire('click');
    assert.equal(JSON.stringify(h.messages.at(-1)), JSON.stringify({ command: 'standaloneFeatureAction', action: 'openLog', featureId: 'file:///a/same.feature' }));
    tree.dispose();
});

test('structural refresh restores feature focus without moving the scrolled manager', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    row.focus({ preventScroll: true });
    h.scrollContainer.scrollTop = 600;
    tree.setSnapshot({ ...snapshot, revision: 2, features: snapshot.features.map(feature => ({ ...feature })) });
    assert.equal(h.document.activeElement?.dataset.featureId, 'file:///a/same.feature');
    assert.equal(h.scrollContainer.scrollTop, 600);
    tree.dispose();
});

test('manager features use native source, run, retry, and context-menu affordances', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    const open = descendants(row).find(value => value.dataset.action === 'openFeature')!;
    assert.ok(open, 'source file remains directly clickable');
    assert.ok(open.querySelector('.open-scenario-icon-idle'));
    assert.ok(open.querySelector('.open-scenario-icon-action'));
    const run = descendants(row).find(value => value.dataset.action === 'run')!;
    assert.ok(run.querySelector('.codicon-play-circle'));
    open.fire('click');
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'passed' } });
    assert.ok(descendants(row).find(value => value.dataset.action === 'run')!.querySelector('.codicon-check'));
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'failed', canOpenRunLog: true } });
    const retry = descendants(row).find(value => value.dataset.action === 'run')!;
    assert.ok(retry.querySelector('.run-scenario-icon-failed'));
    assert.ok(retry.querySelector('.run-scenario-icon-retry'));
    row.fire('contextmenu', { clientX: 40, clientY: 60 });
    const menu = descendants(h.body).find(value => value.attributes.role === 'menu')!;
    assert.ok(menu.classList.contains('phase-context-menu'));
    assert.deepEqual(descendants(menu).filter(value => value.attributes.role === 'menuitem').slice(0, 6).map(value => value.dataset.action), ['openFeature', 'openScenarioProperties', 'run', 'openJson', 'openLog', 'watchLog']);
    assert.equal(JSON.stringify(h.messages), JSON.stringify([{ command: 'standaloneFeatureAction', action: 'openFeature', featureId: 'file:///a/same.feature' }]));
    tree.dispose();
});

test('manager feature title and filename rename use separate menu actions and F2 changes the title', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    for (const action of ['renameFeature', 'renameFeatureFile']) {
        row.fire('contextmenu');
        const menu = descendants(h.body).find(value => value.attributes.role === 'menu')!;
        descendants(menu).find(value => value.dataset.action === action)!.fire('click');
    }
    row.fire('keydown', { key: 'F2' });
    assert.equal(JSON.stringify(h.messages), JSON.stringify(['renameFeature', 'renameFeatureFile', 'renameFeature'].map(action => ({
        command: 'standaloneFeatureAction', action, featureId: 'file:///a/same.feature'
    }))));
    tree.dispose();
});

test('running and failed features expose the current-step action without treating buttons as row clicks', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'running', blocksControls: true } });
    assert.ok(row.querySelector('.checkbox-run-indicator')?.querySelector('.codicon-modifier-spin'));
    assert.equal(descendants(row).find(value => value.dataset.action === 'run'), undefined, 'blocking runs hide the play button');
    row.fire('click');
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'failed' } });
    const failedStep = descendants(row).find(value => value.dataset.action === 'openRunStep')!;
    assert.ok(failedStep?.querySelector('.codicon-go-to-file'));
    failedStep.fire('click');
    row.fire('click', { target: failedStep });
    assert.equal(JSON.stringify(h.messages), JSON.stringify([
        { command: 'standaloneFeatureAction', action: 'openRunStep', featureId: 'file:///a/same.feature' },
        { command: 'standaloneFeatureAction', action: 'openRunStep', featureId: 'file:///a/same.feature' }
    ]));
    tree.dispose();
});

test('manager groups wait for the native collapse transition before removing feature rows', () => {
    let completeCollapse: (() => void) | undefined;
    const h = harness('manager', {
        expand: (_element: Element, expanded: boolean, animate: boolean, onCollapsed?: () => void) => {
            if (!expanded && animate) { completeCollapse = onCollapsed; }
        }
    });
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const group = descendants(h.container).find(value => value.dataset.groupId === 'smoke')!;
    group.fire('click');
    assert.equal(group.attributes['aria-expanded'], 'false');
    assert.ok(completeCollapse, 'collapse uses the native animation completion hook');
    assert.ok(descendants(h.container).some(value => value.dataset.featureId === 'file:///b/same.feature'), 'rows remain available for the outgoing transition');
    completeCollapse!();
    assert.equal(descendants(h.container).some(value => value.dataset.featureId === 'file:///b/same.feature'), false);
    tree.dispose();
});

test('main scenario refresh preserves the shared scroll viewport used by standalone features', () => {
    const h = harness('manager');
    const phaseTreeContainer = new Element();
    h.scrollContainer.append(phaseTreeContainer);
    const row = new Element();
    row.className = 'checkbox-item';
    row.setAttribute('data-key', 'file:///main.yaml');
    phaseTreeContainer.append(row);
    h.document.activeElement = row;
    h.scrollContainer.scrollTop = 600;
    const source = fs.readFileSync(path.join(process.cwd(), 'media', 'phaseSwitcher.js'), 'utf8');
    const start = source.indexOf('    function capturePhaseTreeViewState()');
    const end = source.indexOf('    function renderPhaseTree(', start);
    const operations = vm.runInNewContext(`(function () { ${source.slice(start, end)}; return { capturePhaseTreeViewState, restorePhaseTreeViewState }; }())`, {
        phaseTreeContainer, document: h.document, Element, HTMLElement: Element, phaseExpandedState: { main: true }
    });
    const state = operations.capturePhaseTreeViewState();
    h.scrollContainer.scrollTop = 0;
    operations.restorePhaseTreeViewState(state);
    assert.equal(h.scrollContainer.scrollTop, 600);
});

test('run refresh does not detach a focused run button while inserting a failed-step shortcut', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    const run = descendants(row).find(value => value.dataset.action === 'run')!;
    run.focus({ preventScroll: true });
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'failed' } });
    assert.ok(h.document.activeElement === run, 'patching run state retains the focused button');
    assert.deepEqual(descendants(row.querySelector('.kot-row-actions')!).filter(value => value.dataset.action).map(value => value.dataset.action), ['openRunStep', 'run']);
    tree.dispose();
});

test('running progress refresh preserves the spinner so its animation continues', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'running', progressCurrentLine: 1, progressTotalLines: 12 } });
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    const spinner = row.querySelector('.codicon-loading')!;
    tree.setRunArtifacts({ 'file:///a/same.feature': { runStatus: 'running', progressCurrentLine: 3, progressTotalLines: 12, progressIteration: 2 } });
    assert.ok(row.querySelector('.codicon-loading') === spinner, 'run progress does not restart the spinner animation');
    assert.equal(row.querySelector('.scenario-run-progress-percent')!.textContent, '25% · ×2');
    assert.equal(row.querySelector('.scenario-run-progress-counter')!.textContent, '3/12 · ×2');
    tree.dispose();
});

test('opening a main context menu dismisses the standalone menu', () => {
    const h = harness('manager');
    const tree = h.create();
    tree.setSnapshot(snapshot);
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    row.fire('contextmenu', { clientX: 40, clientY: 60 });
    const standaloneMenu = descendants(h.body).find(value => value.classList.contains('standalone-context-menu'))!;
    const native = nativeContextMenus(h, tree);
    native.showContextMenuAt(80, 100, [{ label: 'Open main scenario' }], 'main');
    assert.equal(h.body.contains(standaloneMenu), false);
    assert.equal(descendants(h.body).filter(value => value.classList.contains('phase-context-menu')).length, 1);
    native.closeContextMenu();
    tree.dispose();
});

test('opening a standalone context menu dismisses the main menu and its submenu', () => {
    let native: ReturnType<typeof nativeContextMenus>;
    const h = harness('manager', { beforeMenu: () => native.closeContextMenu() });
    const tree = h.create();
    tree.setSnapshot(snapshot);
    native = nativeContextMenus(h, tree);
    native.showContextMenuAt(80, 100, [{ label: 'Open main scenario' }], 'main');
    const mainMenu = descendants(h.body).find(value => value.classList.contains('phase-context-menu'))!;
    native.showContextSubmenuForItem(mainMenu.children[0], [{ label: 'Open JSON' }], 'main:json');
    const submenu = descendants(h.body).find(value => value.classList.contains('phase-context-submenu'))!;
    const row = descendants(h.container).find(value => value.dataset.featureId === 'file:///a/same.feature')!;
    row.fire('contextmenu', { clientX: 40, clientY: 60 });
    assert.equal(h.body.contains(mainMenu), false);
    assert.equal(h.body.contains(submenu), false);
    assert.equal(descendants(h.body).filter(value => value.classList.contains('phase-context-menu')).length, 1);
    tree.dispose();
});
