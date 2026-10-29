import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildStepLibrarySnapshot } from '../src/stepLibraryModel';
import { StepLibrarySidebarIndex } from '../src/stepLibrarySidebarModel';

class Element {
    children: Element[] = [];
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    listeners = new Map<string, Array<(event: any) => void>>();
    parentElement?: Element;
    className = ''; textContent = ''; value = ''; disabled = false;
    scrollTop = 0; scrollLeft = 0; scrollWidth = 0; scrollHeight = 0;
    clientWidth = 800; clientHeight = 600; offsetHeight = 0; tabIndex = -1;
    onFocus: (element: Element, options?: unknown) => void = () => undefined;
    onReplace: (element: Element) => void = () => undefined;
    style = { setProperty() {}, left: '', top: '', maxHeight: '' };
    classList = {
        add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); },
        remove: (...names: string[]) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        contains: (name: string) => this.className.split(' ').includes(name),
        toggle: (name: string, force?: boolean) => { const add = force ?? !this.classList.contains(name); add ? this.classList.add(name) : this.classList.remove(name); return add; }
    };
    constructor(readonly tag = 'div') {}
    get firstElementChild() { return this.children[0]; }
    get offsetParent() { return this.parentElement; }
    get isConnected() { return true; }
    append(...values: Element[]) { for (const value of values) { if (value.tag === '#fragment') { this.append(...value.children); } else { this.children.push(value); value.parentElement = this; } } }
    appendChild(value: Element) { this.append(value); return value; }
    prepend(...values: Element[]) { this.children.unshift(...values); for (const value of values) { value.parentElement = this; } }
    replaceChildren(...values: Element[]) { this.onReplace(this); this.children = []; this.append(...values); }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    getAttribute(key: string) { return this.attributes[key]; }
    addEventListener(name: string, callback: (event: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
    removeEventListener(name: string, callback: (event: any) => void) { this.listeners.set(name, (this.listeners.get(name) || []).filter(value => value !== callback)); }
    remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); } }
    contains(value: Element): boolean { return this === value || this.children.some(child => child.contains(value)); }
    matches(selector: string): boolean {
        return selector.split(',').some(part => {
            const simple = part.trim().split(' ').at(-1)!;
            const attribute = /\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/u.exec(simple);
            if (attribute) {
                const key = attribute[1];
                const value = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())] : this.attributes[key];
                return value !== undefined && (attribute[2] === undefined || value === attribute[2]);
            }
            const classes = simple.match(/\.[\w-]+/gu);
            if (classes) { return classes.every(name => this.classList.contains(name.slice(1))); }
            return simple === this.tag;
        });
    }
    querySelectorAll(selector: string): Element[] { return descendants(this).filter(value => value.matches(selector)); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
    closest(selector: string): Element | undefined { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    focus(options?: unknown) { this.onFocus(this, options); } scrollIntoView() {}
    getBoundingClientRect() { return { width: 150, height: 26, left: 0, bottom: 26 }; }
    click() { this.fire('click'); }
    fire(name: string, values: Record<string, unknown> = {}) { for (const callback of this.listeners.get(name) || []) { callback({ target: this, preventDefault() {}, stopPropagation() {}, key: '', ...values }); } }
}
function descendants(element: Element): Element[] { return element.children.flatMap(child => [child, ...descendants(child)]); }
function text(element: Element): string { return [element.textContent, ...element.children.map(text)].join(' '); }

const snapshot = buildStepLibrarySnapshot({ identity: 'native', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [], new Map(), {
    revision: 1, groups: [{ id: 'smoke', name: 'Smoke' }, { id: 'empty', name: 'Empty group' }],
    features: [
        { id: 'file:///z.feature', uri: 'file:///z.feature', name: 'z', title: 'Zulu', relativePath: 'z.feature', language: 'en', groupId: 'smoke', order: 0 },
        { id: 'file:///a.feature', uri: 'file:///a.feature', name: 'a', title: 'Alpha', relativePath: 'a.feature', language: 'en', groupId: 'smoke', order: 1 }
    ]
});

function harness(sidebar: boolean) {
    const body = new Element('body'); const window = new Element();
    let activeElement = body;
    const focusOptions: unknown[] = [];
    const element = (tag = 'div') => {
        const node = new Element(tag);
        node.onFocus = (focused, options) => { activeElement = focused; focusOptions.push(options); };
        node.onReplace = replaced => { if (replaced.contains(activeElement)) { activeElement = body; } };
        return node;
    };
    const elements = new Map<string, Element>();
    const ids = sidebar ? ['tree', 'treeScroll', 'searchInput', 'searchClearBtn', 'status'] : ['searchInput', 'searchClearBtn', 'languageFilter', 'sortMode', 'refreshButton', 'createButton', 'categoryToggle', 'categoryBack', 'detailsBack', 'categoryTree', 'statusMessage', 'definitionList', 'definitionListContent', 'resultCount', 'detailsContent', 'insertButton', 'copyButton', 'openDefinitionButton', 'favoriteButton', 'liveRegion'];
    for (const id of ids) { const node = element(); elements.set(id, node); body.append(node); }
    elements.get('favoriteButton')?.append(new Element('span'));
    if (!sidebar) { elements.get('definitionList')!.append(elements.get('definitionListContent')!); }
    const shell = new Element(); shell.className = sidebar ? 'step-sidebar' : 'library-shell'; body.append(shell);
    const grid = new Element(); grid.className = 'library-grid'; body.append(grid);
    const labels = { sourceStandalone: 'Standalone features', sourceLabel: 'Source', categoryLabel: 'Category', templateLabel: 'Template', ungrouped: 'Ungrouped', uncategorized: 'Uncategorized', allDefinitions: 'All definitions', favorites: 'Favorites', preferredLanguage: 'en', removeFavorite: 'Remove favorite', addFavorite: 'Add favorite', openDefinition: 'Open definition', copy: 'Copy', copyStep: 'Copy', insert: 'Insert' };
    Object.assign(body.dataset, labels); Object.assign(shell.dataset, labels);
    const messages: any[] = []; const timers: Array<() => void> = [];
    const document = {
        body, get activeElement() { return activeElement; },
        getElementById: (id: string) => elements.get(id),
        querySelector: (selector: string) => body.querySelector(selector),
        querySelectorAll: (selector: string) => body.querySelectorAll(selector),
        createElement: element, createTextNode: (value: string) => { const node = element('#text'); node.textContent = value; return node; },
        createDocumentFragment: () => element('#fragment'), addEventListener() {}
    };
    Object.assign(window, { innerWidth: 1200, innerHeight: 900, matchMedia: () => ({ matches: true }), setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, __standaloneFeatureLabels: { openFeature: 'Open feature', generateJson: 'Generate JSON', selectJson: 'Select JSON', openJson: 'Open JSON', moveFeature: 'Move feature', createFeature: 'New feature', createGroup: 'New group', renameGroup: 'Rename group', deleteGroup: 'Delete group', actions: 'Actions' } });
    const context = vm.createContext({ window, document, Element, HTMLElement: Element, console, CSS: { escape: (value: string) => value }, requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout() {}, acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (message: unknown) => messages.push(JSON.parse(JSON.stringify(message))) }) });
    for (const file of [sidebar ? 'stepLibrarySidebarProtocol.js' : 'stepLibraryProtocol.js', 'scenarioFilesProtocol.js', 'stepLibraryFeatureProtocol.js', 'userStepLibraries.js', sidebar ? 'stepLibrarySidebar.js' : 'stepLibrary.js']) {
        vm.runInContext(fs.readFileSync(`media/${file}`, 'utf8'), context);
    }
    return { body, window, elements, messages, shell, get activeElement() { return activeElement; }, focusOptions, receive: (message: unknown) => window.fire('message', { data: message }), runTimers: () => { while (timers.length) { timers.shift()!(); } } };
}

for (const sidebar of [true, false]) {
    test(`${sidebar ? 'sidebar' : 'full'} Library withholds copy and insertion but routes EPF actions for an uncompiled step`, () => {
        const h = harness(sidebar);
        const item = { ...snapshot.items[0], id: 'uncompiled', definitionId: 'step:uncompiled',
            kind: 'userStep', sourceGroup: 'user', featureId: undefined, displayText: 'And custom step',
            insertable: false, navigable: true, categoryPath: [], userStepLibrary: {
                status: 'uncompiled', sourceDirectory: '/src', rootXmlPath: '/src/Обработка.xml', targetEpfPath: '/Steps.epf'
            } };
        h.receive(sidebar ? { command: 'roots', identity: 'uncompiled-library', insertionTarget: { available: true },
            nodes: [{ ...item, kind: 'definition', definitionType: 'userStep', itemId: item.id, label: item.displayText, depth: 0, expandable: false }] }
            : { command: 'snapshot', snapshot: { ...snapshot, items: [item] }, insertionTarget: { available: true } });
        const row = sidebar ? h.elements.get('tree')!.querySelectorAll('.step-row')[0]
            : h.elements.get('definitionListContent')!.querySelectorAll('[role="option"]')[0];
        row.fire('contextmenu');
        const menu = h.body.querySelector('[role="menu"]')!;
        assert.equal(menu.querySelector('[data-action="insert"]'), undefined);
        assert.equal(menu.querySelector('[data-action="copy"]'), undefined);
        assert.ok(menu.querySelector('[data-action="openDefinition"]'));
        menu.querySelector('[data-action="buildUserStepLibrary"]')!.click();
        assert.deepEqual(h.messages.at(-1), { command: 'buildUserStepLibrary', itemId: item.id });
    });
}

for (const sidebar of [true, false]) {
    for (const status of ['ready', 'uncompiled'] as const) {
        test(`${sidebar ? 'sidebar' : 'full'} Library moves user-step source operations into the row overflow menu (${status})`, () => {
            const h = harness(sidebar);
            const item = { ...snapshot.items[0], id: 'compact-user-step', definitionId: 'step:compact', kind: 'userStep', sourceGroup: 'user',
                featureId: undefined, groupId: undefined, categoryPath: [], displayText: 'And custom step', navigable: true, insertable: status === 'ready',
                userStepLibrary: { status, sourceDirectory: '/src', rootXmlPath: '/src/Обработка.xml', targetEpfPath: '/Steps.epf' } };
            h.receive(sidebar ? { command: 'roots', identity: 'compact-actions', insertionTarget: { available: true },
                nodes: [{ ...item, kind: 'definition', definitionType: 'userStep', itemId: item.id, label: item.displayText, depth: 0, expandable: false }] }
                : { command: 'snapshot', snapshot: { ...snapshot, items: [item] }, insertionTarget: { available: true } });
            const row = h.elements.get(sidebar ? 'tree' : 'definitionListContent')!.querySelector(sidebar ? '.step-row' : '.definition-row')!;
            const actions = row.querySelector(sidebar ? '.step-actions' : '.definition-actions')!;
            assert.ok(actions.querySelectorAll('button').length <= 4, 'Source operations must not expand the inline toolbar');
            assert.equal(actions.querySelector('.step-action-buildUserStepLibrary'), undefined);
            assert.equal(actions.querySelector('.step-action-dumpUserStepLibrary'), undefined);
            assert.equal(actions.querySelector('.codicon-tools'), undefined);
            assert.equal(actions.querySelector('.codicon-file-code'), undefined);
            assert.equal(actions.querySelector('.codicon-go-to-file'), undefined);
            const more = actions.querySelector('.codicon-ellipsis');
            assert.ok(more, 'Source operations remain discoverable without a right click');
            for (const command of ['openDefinition', 'buildUserStepLibrary', ...(status === 'ready' ? ['dumpUserStepLibrary'] : [])]) {
                more.click();
                const menu = h.body.querySelector('[role="menu"]')!;
                menu.querySelector(`[data-action="${command}"]`)!.click();
                assert.deepEqual(h.messages.at(-1), { command, itemId: item.id });
                assert.equal(h.body.querySelector('[role="menu"]'), undefined);
                if (!sidebar) { h.receive({ command: 'actionResult', action: command, itemId: item.id, succeeded: true }); }
            }
        });
    }
}

for (const [status, expectedActions] of [
    ['sourceOnly', ['Create EPF library…']],
    ['uncompiled', ['Build EPF']],
    ['ready', ['Build EPF', 'Dump sources…']]
] as const) {
    test(`full Library exposes ${status} library operations in the selected step's properties`, () => {
        const h = harness(false);
        h.body.dataset.epfLibrary = 'Библиотека EPF';
        const item = { ...snapshot.items[0], id: 'selected-user-step', definitionId: 'step:selected',
            kind: 'userStep', sourceGroup: 'user', featureId: undefined, groupId: undefined,
            displayText: 'And selected custom step', insertable: status === 'ready', navigable: true,
            categoryPath: [], userStepLibrary: { status, sourceDirectory: '/src',
                ...(status === 'sourceOnly' ? {} : { rootXmlPath: '/src/Обработка.xml', targetEpfPath: '/Steps.epf' }) } };
        h.receive({ command: 'snapshot', snapshot: { ...snapshot, items: [snapshot.items[1], item] }, insertionTarget: { available: true } });
        h.elements.get('definitionListContent')!.querySelector('[data-item-id="selected-user-step"]')!.click();
        const details = h.elements.get('detailsContent')!;
        const library = details.querySelector('.user-step-library-details');
        assert.ok(library, 'The selected step must expose an identifiable EPF library section');
        assert.equal(library.getAttribute('aria-label'), 'Библиотека EPF');
        const buttons = library.querySelectorAll('button');
        assert.deepEqual(buttons.map(button => button.textContent), [...expectedActions]);
        buttons[0].click();
        assert.deepEqual(h.messages.at(-1), { command: 'buildUserStepLibrary', itemId: 'selected-user-step' });
        assert.equal(details.querySelector('.user-step-library-details')!.querySelector('button')!.disabled, true);
    });
}

test('dragging a user step carries only the guarded definition ID, never a plain-text fallback', () => {
    const h = harness(true);
    h.receive({ command: 'roots', identity: 'user-drag', insertionTarget: { available: true }, nodes: [{
        id: 'user:step', kind: 'definition', definitionType: 'userStep', itemId: 'user:step', definitionId: 'definition:user',
        sourceGroup: 'user', label: 'And ready', insertable: true, navigable: true, depth: 0,
        expandable: false, dragText: 'And ready', userStepLibrary: { status: 'ready', sourceDirectory: '/src' }
    }] });
    const transferred = new Map<string, string>();
    h.elements.get('tree')!.querySelectorAll('.step-row')[0].fire('dragstart', {
        dataTransfer: { setData: (mime: string, value: string) => transferred.set(mime, value) }
    });
    assert.equal(transferred.get('application/x-kot-step-definition-id'), 'definition:user');
    assert.equal(transferred.has('text/plain'), false);
});

test('Library labels and icons distinguish a process from a main scenario in separate sources', () => {
    const mixed = buildStepLibrarySnapshot({ identity: 'mixed-types', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [
        { name: 'Sales chain', kind: 'process', uid: 'process', tabName: 'Sales', relativePath: 'process.yaml', yamlFileUri: { toString: () => 'file:///process.yaml' } as any },
        { name: 'Create invoice', tabName: 'Sales', relativePath: 'scen.yaml', yamlFileUri: { toString: () => 'file:///scen.yaml' } as any }
    ]);
    const h = harness(false);
    Object.assign(h.body.dataset, { processDefinition: 'Process', mainScenarioDefinition: 'Main scenario' });
    h.receive({ command: 'snapshot', snapshot: mixed, insertionTarget: { available: false } });
    const rows = h.elements.get('definitionListContent')!.querySelectorAll('.definition-row');
    const process = rows.find(row => row.dataset.itemId === 'mainScenario#file:///process.yaml')!;
    const scenario = rows.find(row => row.dataset.itemId === 'mainScenario#file:///scen.yaml')!;
    assert.equal(text(process.querySelector('.definition-type')!).trim(), 'Process');
    assert.equal(text(scenario.querySelector('.definition-type')!).trim(), 'Main scenario');
    assert.ok(process.querySelector('.codicon-list-ordered'));
    assert.ok(scenario.querySelector('.codicon-file'));
    const index = StepLibrarySidebarIndex.fromSnapshot(mixed, 'en');
    const nodes = [...index.children('category:main:Sales').nodes, ...index.children('category:process:Sales').nodes];
    assert.equal(nodes.find(node => node.itemId === 'mainScenario#file:///process.yaml')?.definitionType, 'process');
    assert.equal(nodes.find(node => node.itemId === 'mainScenario#file:///scen.yaml')?.definitionType, 'mainScenario');
});

test('sidebar background refresh keeps the displayed tree and does not flash the initial loading message', () => {
    const h = harness(true);
    h.shell.dataset.loading = 'Loading step library...';
    h.receive({ command: 'loading', retainItems: false });
    assert.equal(h.elements.get('status')!.textContent, 'Loading step library...');
    h.receive({ command: 'roots', identity: 'ready', nodes: [
        { id: 'source:nested', kind: 'sourceGroup', label: 'Nested', depth: 0, expandable: true }
    ] });
    const tree = h.elements.get('tree')!;
    const rows = [...tree.children];
    h.receive({ command: 'loading', retainItems: true });
    assert.equal(h.elements.get('status')!.textContent, '');
    assert.deepEqual(tree.children, rows);
});

test('every Library definition type has an icon while steps keep syntax highlighting', () => {
    const kinds = [['builtIn', 'builtInStep', 'extensions'], ['user', 'userStep', 'symbol-method'],
        ['export', 'exportScenario', 'package'], ['nested', 'nestedScenario', 'references'],
        ['main', 'mainScenario', 'file'], ['standalone', 'standaloneFeature', 'file-code']] as const;
    const mixed = { ...snapshot, items: kinds.map(([sourceGroup, kind]) => ({ ...snapshot.items[0], id: sourceGroup,
        sourceGroup, kind, featureId: undefined, categoryPath: [], displayText: 'And ready' })) };
    const full = harness(false); full.receive({ command: 'snapshot', snapshot: mixed, insertionTarget: { available: false } });
    const rows = full.elements.get('definitionListContent')!.querySelectorAll('.definition-row');
    for (const [group, , icon] of kinds) {
        assert.ok(rows.find(row => row.dataset.itemId === group)!.querySelector(`.definition-type .codicon-${icon}`));
    }
    const index = StepLibrarySidebarIndex.fromSnapshot(mixed as any, 'en');
    const definitions = (parentId: string): any[] => index.children(parentId).nodes.flatMap(node =>
        node.kind === 'definition' ? [node] : node.expandable ? definitions(node.id) : []);
    const nodes = kinds.flatMap(([group]) => definitions(`source:${group}`));
    const sidebar = harness(true); sidebar.receive({ command: 'roots', identity: mixed.viewIdentity, nodes });
    const sidebarRows = sidebar.elements.get('tree')!.querySelectorAll('.step-row');
    for (const [group, , icon] of kinds.filter(([group]) => group !== 'standalone')) {
        const row = sidebarRows.find(row => row.dataset.nodeId === `definition:${group}`)!;
        assert.ok(row.querySelector(`.step-node-icon .codicon-${icon}`));
        if (group === 'builtIn' || group === 'user' || group === 'nested' || group === 'export') { assert.ok(row.querySelector('.step-code')); }
    }
});

test('both Libraries expose Delete for local definitions including processes', () => {
    const selected = { ...snapshot.items[0], id: 'process:selected', definitionId: 'process', kind: 'process',
        sourceGroup: 'process', processUri: 'file:///process.yaml', displayText: 'Process', featureId: undefined, categoryPath: [] };
    for (const sidebar of [false, true]) {
        const h = harness(sidebar);
        if (sidebar) { h.receive({ command: 'roots', identity: 'delete-local', nodes: [
            { ...selected, id: 'definition:process', itemId: selected.id, kind: 'definition', depth: 0, expandable: false }
        ] }); }
        else { h.receive({ command: 'snapshot', snapshot: { ...snapshot, items: [selected] }, insertionTarget: { available: false } }); }
        const row = h.elements.get(sidebar ? 'tree' : 'definitionListContent')!.querySelector(sidebar ? '.step-row' : '.definition-row')!;
        row.fire('contextmenu');
        const menu = h.body.querySelector('[role="menu"]')!;
        const remove = menu.querySelector('[data-action="deleteDefinition"]');
        assert.ok(remove); remove.click();
        assert.deepEqual(h.messages.at(-1), { command: 'deleteDefinition', itemId: selected.id });
    }
});

test('process third column supports guarded drag reorder and Add/remove controls', () => {
    const processSnapshot = buildStepLibrarySnapshot({ identity: 'process-details', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [{
        name: 'Process', kind: 'process', uid: 'parent', tabName: 'Processes', relativePath: 'process.yaml',
        yamlFileUri: { toString: () => 'file:///process.yaml' } as any,
        processSteps: [{ uid: 'step-a', type: 'scenario', scenarioUid: 'a', scenarioName: 'First scenario' },
            { uid: 'step-b', type: 'process', processUid: 'b', processName: 'Second process' }]
    }]);
    const h = harness(false);
    Object.assign(h.body.dataset, { processSteps: 'Process steps', moveStepUp: 'Move up', moveStepDown: 'Move down', scenarioStep: 'Scenario', processStep: 'Process' });
    h.receive({ command: 'snapshot', snapshot: processSnapshot, insertionTarget: { available: false } });
    h.elements.get('definitionListContent')!.querySelector('.definition-row')!.click();
    const details = h.elements.get('detailsContent')!;
    const rows = details.querySelectorAll('.process-step-row');
    assert.equal(rows.length, 2);
    assert.match(text(rows[0]), /First scenario/u);
    assert.match(text(rows[1]), /Second process/u);
    assert.equal(rows[0].querySelector('[data-direction="up"]'), undefined);
    assert.ok(details.querySelector('[data-action="addProcessSteps"]'));
    assert.ok(rows[0].querySelector('[data-action="removeProcessStep"]'));
    const values = new Map<string, string>();
    const dataTransfer = { types: [] as string[], setData(type: string, value: string) { values.set(type, value); this.types.push(type); }, getData: (type: string) => values.get(type) || '' };
    rows[1].fire('dragstart', { dataTransfer });
    rows[0].fire('drop', { dataTransfer, clientY: 0 });
    assert.deepEqual(h.messages.at(-1), {
        command: 'reorderProcessStep', itemId: processSnapshot.items[0].id, processUri: 'file:///process.yaml', processUid: 'parent',
        stepUid: 'step-b', beforeStepUid: 'step-a', viewIdentity: processSnapshot.viewIdentity,
        stepsSignature: (processSnapshot.items[0] as any).processStepsSignature
    });
    assert.equal(details.querySelectorAll('.process-step-row button').every(button => button.disabled), true);
});

test('both Library renderers expose main group Rename through its inline menu and F2', () => {
    const groupSnapshot = buildStepLibrarySnapshot({ identity: 'main-rename', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [{
        name: 'Main', tabName: 'Accounting', yamlFileUri: { toString: () => 'file:///main/scen.yaml' } as any,
        relativePath: 'main'
    }]);
    const expected = { command: 'renameMainGroup', itemId: groupSnapshot.items[0].id };
    for (const sidebar of [true, false]) {
        const h = harness(sidebar);
        let group: Element;
        if (sidebar) {
            const index = StepLibrarySidebarIndex.fromSnapshot(groupSnapshot, 'en');
            h.receive({ command: 'roots', identity: groupSnapshot.viewIdentity, nodes: index.roots() });
            const tree = h.elements.get('tree')!;
            tree.fire('click', { target: tree.querySelectorAll('.step-row').find(row => row.dataset.nodeId === 'source:main')! });
            h.receive({ command: 'children', offset: 0, ...index.children('source:main') });
            group = tree.querySelectorAll('.step-row').find(row => row.dataset.nodeId === 'category:main:Accounting')!;
        } else {
            h.receive({ command: 'snapshot', snapshot: groupSnapshot, insertionTarget: { available: false } });
            group = h.elements.get('categoryTree')!.querySelectorAll('[role="treeitem"]').find(row => row.dataset.nodeId === 'main::Accounting')!;
            group.click();
            assert.equal(h.activeElement, group, 'clicking a main group focuses its row for keyboard navigation and F2');
        }
        assert.ok(group);
        group.querySelector('.codicon-ellipsis')!.click();
        h.body.querySelector('[role="menu"]')!.querySelector('[data-action="renameMainGroup"]')!.click();
        assert.deepEqual(h.messages.at(-1), expected);
        group.fire('keydown', { key: 'F2' });
        assert.deepEqual(h.messages.at(-1), expected);
    }
});

test('sidebar drag carries the definition identity so YAML insertion can adapt Vanessa loops', () => {
    const h = harness(true);
    const node = {
        id: 'definition:repeat', kind: 'definition', depth: 0, expandable: false,
        itemId: 'repeat:en', definitionId: 'builtIn:repeat:en', label: 'And I repeat "" times',
        sourceGroup: 'builtIn', insertable: true, navigable: false, dragText: 'And I repeat "" times'
    };
    h.receive({ command: 'roots', identity: 'loop-drag', nodes: [node] });
    const row = h.elements.get('tree')!.querySelector('.step-row')!;
    const transferred = new Map<string, string>();
    row.fire('dragstart', { dataTransfer: { setData: (type: string, value: string) => transferred.set(type, value) } });
    assert.equal(transferred.get('application/x-kot-step-definition-id'), 'builtIn:repeat:en');
    assert.equal(transferred.get('text/plain'), 'And I repeat "" times');
});

for (const sidebar of [true, false]) {
    test(`${sidebar ? 'sidebar' : 'full'} Library context actions route hover commands for every definition kind`, () => {
        const h = harness(sidebar);
        const items = [
            ['builtIn', 'builtInStep', true, false], ['user', 'userStep', true, true],
            ['nested', 'nestedScenario', true, true], ['export', 'exportScenario', true, true],
            ['main', 'mainScenario', false, true], ['standalone', 'standaloneFeature', false, true]
        ].map(([sourceGroup, kind, insertable, navigable]) => ({
            ...snapshot.items[0], id: `${sourceGroup}:selected`, definitionId: `${sourceGroup}:definition`,
            displayText: `${sourceGroup} selected`, sourceGroup, kind, insertable, navigable,
            featureId: sourceGroup === 'standalone' ? 'file:///selected.feature' : undefined,
            groupId: undefined, categoryPath: []
        }));
        const render = (available: boolean, favorite: boolean) => h.receive(sidebar ? {
            command: 'roots', identity: 'context-actions', insertionTarget: { available },
            favoriteItemIds: favorite ? items.map(item => item.id) : [],
            nodes: items.map(item => ({ ...item, kind: 'definition', itemId: item.id,
                label: item.displayText, depth: 0, expandable: false, favorite }))
        } : { command: 'snapshot', snapshot: { ...snapshot, items },
            insertionTarget: { available }, favoriteItemIds: favorite ? items.map(item => item.id) : [] });
        const rowFor = (id: string) => sidebar
            ? h.elements.get('tree')!.querySelectorAll('.step-row').find(row => row.dataset.nodeId === id)!
            : h.elements.get('definitionListContent')!.querySelectorAll('[role="option"]').find(row => row.dataset.itemId === id)!;
        render(true, false);
        for (const item of items) {
            const expectedActions = [
                'toggleFavorite', ...(item.insertable ? ['insert'] : []), 'copy',
                ...(item.navigable ? ['openDefinition'] : [])
            ];
            for (const action of expectedActions) {
                rowFor(item.id).fire('contextmenu');
                const menu = h.body.querySelector('[role="menu"]')!;
                const button = menu?.querySelector(`[data-action="${action}"]`);
                assert.ok(button, `${item.kind} exposes ${action}`);
                assert.equal(button.disabled, false);
                button.click();
                assert.deepEqual(h.messages.at(-1), { command: action, itemId: item.id });
                assert.equal(h.body.querySelector('[role="menu"]'), undefined);
                if (!sidebar && action !== 'toggleFavorite') {
                    h.receive({ command: 'actionResult', action, itemId: item.id, succeeded: true });
                }
            }
        }
        render(false, true);
        for (const item of items) {
            rowFor(item.id).fire('contextmenu');
            const menu = h.body.querySelector('[role="menu"]')!;
            assert.equal(menu.querySelector('[data-action="toggleFavorite"]')!.textContent, 'Remove favorite');
            if (item.insertable) {
                const insert = menu.querySelector('[data-action="insert"]')!;
                assert.equal(insert.disabled, true, 'unavailable editor insertion remains disabled in context menu');
                const count = h.messages.length;
                insert.click();
                assert.equal(h.messages.length, count);
            }
        }
    });
}

test('sidebar native renderer selects features and provides favorite, source, organization actions in the existing tree', () => {
    const h = harness(true);
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot, 'en');
    h.receive({ command: 'roots', identity: snapshot.viewIdentity, nodes: index.roots(), standaloneItems: snapshot.items });
    const source = h.elements.get('tree')!.querySelectorAll('.step-row').find(row => row.dataset.nodeId === 'source:standalone')!;
    assert.ok(source);
    h.elements.get('tree')!.fire('click', { target: source });
    h.receive({ command: 'children', offset: 0, ...index.children('source:standalone') });
    const group = h.elements.get('tree')!.querySelectorAll('.step-row').find(row => row.dataset.groupId === 'smoke')!;
    h.elements.get('tree')!.fire('click', { target: group });
    h.receive({ command: 'children', offset: 0, ...index.children('category:standalone:smoke') });
    const row = h.elements.get('tree')!.querySelector('[data-feature-id="file:///z.feature"]')!;
    assert.ok(row); assert.equal(row.attributes.role, 'treeitem');
    assert.ok(text(h.elements.get('tree')!).includes('Empty group'));
    assert.ok(row.querySelector('.step-action-toggleFavorite'));
    assert.ok(row.querySelector('.codicon-file-code'));
    assert.equal(row.querySelector('.step-code'), undefined);
    assert.equal(row.querySelector('.step-action-insert'), undefined);
    h.elements.get('tree')!.fire('dblclick', { target: row });
    assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'openFeature', featureId: 'file:///z.feature' });
    row.fire('contextmenu');
    h.body.querySelector('[data-action="moveFeature"]')!.click();
    assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///z.feature' });
});

test('sidebar standalone root creates a group directly before its counter, while group menus create features in that group', () => {
    const h = harness(true);
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot, 'en');
    h.receive({ command: 'roots', identity: snapshot.viewIdentity, nodes: index.roots(), standaloneItems: snapshot.items });
    const tree = h.elements.get('tree')!;
    const root = tree.querySelectorAll('.step-row').find(row => row.dataset.nodeId === 'source:standalone')!;
    const actions = root.querySelector('.step-actions')!;
    const createGroup = actions.querySelector('[data-action="createGroup"]');
    assert.ok(createGroup, 'the root has a direct New feature group button');
    assert.ok(root.querySelector('.codicon-file-code'));
    assert.equal(actions.children.length, 1);
    assert.equal(actions.querySelector('.codicon-ellipsis'), undefined);
    assert.ok(root.children.indexOf(actions) < root.children.indexOf(root.querySelector('.step-count')!));
    createGroup.click();
    assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'createGroup' });
    assert.equal(h.body.querySelector('[role="menu"]'), undefined, 'the direct action does not open a menu');
    tree.fire('click', { target: root });
    h.receive({ command: 'children', offset: 0, ...index.children('source:standalone') });
    for (const groupId of ['smoke', 'empty', '']) {
        const group = tree.querySelectorAll('.step-row').find(row => row.dataset.groupId === groupId)!;
        const groupActions = group.querySelector('.step-actions')!;
        assert.ok(group.children.indexOf(groupActions) < group.children.indexOf(group.querySelector('.step-count')!));
        groupActions.querySelector('.codicon-ellipsis')!.click();
        const menu = h.body.querySelector('[role="menu"]')!;
        assert.equal(menu.querySelector('[data-action="createGroup"]'), undefined, 'groups do not create nested feature groups');
        menu.querySelector('[data-action="createFeature"]')!.click();
        assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'createFeature', groupId });
    }
    root.fire('contextmenu');
    assert.ok(h.body.querySelector('[data-action="createGroup"]'), 'root context menu retains group creation');
});

test('full Library standalone root creates groups directly and group actions precede the counter', () => {
    const h = harness(false);
    h.receive({ command: 'snapshot', snapshot, insertionTarget: { available: true } });
    const tree = h.elements.get('categoryTree')!;
    const root = tree.querySelectorAll('[role="treeitem"]').find(row => row.dataset.nodeId === 'standalone')!;
    const actions = root.querySelector('.tree-feature-actions');
    assert.ok(actions, 'standalone actions live in the row before its counter');
    assert.ok(root.querySelector('.codicon-file-code'));
    const createGroup = actions.querySelector('[data-action="createGroup"]');
    assert.ok(createGroup);
    assert.equal(actions.querySelector('.codicon-ellipsis'), undefined);
    assert.ok(root.children.indexOf(actions) < root.children.indexOf(root.querySelector('.tree-count')!));
    root.focus({ preventScroll: true });
    tree.fire('keydown', { key: 'Enter', target: root });
    assert.equal(h.activeElement, root, 'selecting the standalone root retains native tree keyboard focus');
    assert.equal((h.focusOptions.at(-1) as any).preventScroll, true);
    createGroup.click();
    assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'createGroup' });
    for (const groupId of ['smoke', 'empty', '']) {
        const group = tree.querySelectorAll('[role="treeitem"]').find(row => row.dataset.groupId === groupId)!;
        const groupActions = group.querySelector('.tree-feature-actions')!;
        assert.ok(group.children.indexOf(groupActions) < group.children.indexOf(group.querySelector('.tree-count')!));
        groupActions.querySelector('.codicon-ellipsis')!.click();
        const menu = h.body.querySelector('[role="menu"]')!;
        assert.equal(menu.querySelector('[data-action="createGroup"]'), undefined);
        menu.querySelector('[data-action="createFeature"]')!.click();
        assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'createFeature', groupId });
        group.fire('keydown', { key: ' ' });
        const rows = h.elements.get('definitionListContent')!.querySelectorAll('[role="option"]');
        assert.ok(rows.every(row => row.dataset.groupId === groupId), 'Space selects the focused standalone group');
    }
});

test('full Library uses the sidebar icons for source groups and every category level', () => {
    const sources = [
        ['builtIn', 'builtInStep', 'extensions'],
        ['user', 'userStep', 'symbol-method'],
        ['export', 'exportScenario', 'package'],
        ['nested', 'nestedScenario', 'references'],
        ['main', 'mainScenario', 'files']
    ] as const;
    const h = harness(false);
    h.receive({ command: 'snapshot', snapshot: {
        ...snapshot,
        items: [...snapshot.items, ...sources.map(([sourceGroup, kind]) => ({
            ...snapshot.items[0], id: sourceGroup, sourceGroup, kind,
            featureId: undefined, groupId: undefined, categoryPath: ['First', 'Second']
        }))]
    }, insertionTarget: { available: true } });
    const rows = h.elements.get('categoryTree')!.querySelectorAll('[role="treeitem"]');
    for (const [nodeId, icon] of [
        ['all', 'library'], ['favorites', 'star-full'], ['standalone', 'file-code'],
        ...sources.map(([sourceGroup, , name]) => [sourceGroup, name])
    ]) {
        const row = rows.find(value => value.dataset.nodeId === nodeId)!;
        assert.ok(row.querySelector(`.codicon-${icon}`), `${nodeId} uses the sidebar source icon`);
    }
    for (const row of rows.filter(value => Number(value.getAttribute('aria-level')) > 1)) {
        assert.ok(row.querySelector('.codicon-folder'), `${row.dataset.nodeId} uses the sidebar category icon`);
        assert.equal(row.querySelector('.tree-node-icon')!.getAttribute('aria-hidden'), 'true');
        assert.ok(row.children.indexOf(row.querySelector('.tree-node-icon')!) < row.children.indexOf(row.querySelector('.tree-label')!));
    }
});

test('sidebar standalone paging rows do not present a group-creation shortcut', () => {
    const h = harness(true);
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot, 'en');
    h.receive({ command: 'roots', identity: snapshot.viewIdentity, nodes: index.roots(), standaloneItems: snapshot.items });
    const tree = h.elements.get('tree')!;
    tree.fire('click', { target: tree.querySelectorAll('.step-row').find(row => row.dataset.nodeId === 'source:standalone')! });
    h.receive({ command: 'children', offset: 0, ...index.children('source:standalone') });
    tree.fire('click', { target: tree.querySelectorAll('.step-row').find(row => row.dataset.groupId === 'smoke')! });
    h.receive({ command: 'children', offset: 0, ...index.children('category:standalone:smoke', 0, 1) });
    const more = tree.querySelectorAll('.step-row').find(row => row.dataset.kind === 'more')!;
    assert.ok(more);
    assert.equal(Boolean(more.querySelector('[data-action="createGroup"]')), false, 'only the standalone source root creates groups directly');
});

test('full Library native renderer filters groups, shows source details and opens standalone features on Enter', () => {
    const h = harness(false);
    h.receive({ command: 'snapshot', snapshot, insertionTarget: { available: true } });
    const tree = h.elements.get('categoryTree')!;
    assert.ok(text(tree).includes('Empty group'));
    tree.querySelector('[data-group-id="smoke"]')!.click();
    const rows = h.elements.get('definitionListContent')!.querySelectorAll('[role="option"]');
    assert.deepEqual(rows.map(row => row.dataset.featureId), ['file:///z.feature', 'file:///a.feature']);
    rows[0].click();
    assert.ok(text(h.elements.get('detailsContent')!).includes('z.feature'));
    assert.ok(h.elements.get('insertButton')!.classList.contains('hidden'));
    h.elements.get('detailsContent')!.querySelector('[data-action="selectJson"]')!.click();
    assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'selectJson', featureId: 'file:///z.feature' });
    h.elements.get('definitionList')!.fire('keydown', { key: 'Enter' });
    assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'openFeature', featureId: 'file:///z.feature' });
    tree.querySelector('[data-group-id="empty"]')!.click();
    assert.equal(h.elements.get('definitionListContent')!.querySelectorAll('[role="option"]').length, 0);
});

test('full Library selects persistent empty scenario groups and keeps the zero-result category after refresh', () => {
    const h = harness(false);
    const shared = buildStepLibrarySnapshot({ identity: 'empty-groups', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [], new Map(), undefined, [
        { id: 'planned-main', name: 'Planned main', sections: ['main'], order: 0 },
        { id: 'planned-process', name: 'Planned process', sections: ['process'], order: 1 }
    ]);
    h.receive({ command: 'snapshot', snapshot: shared, insertionTarget: { available: false } });
    const tree = h.elements.get('categoryTree')!;
    const main = tree.querySelectorAll('[role="treeitem"]').find(row => text(row).includes('Planned main'))!;
    assert.ok(main, 'declared empty groups are visible without fake items');
    main.click();
    assert.equal(main.getAttribute('aria-selected'), 'true');
    assert.equal(h.elements.get('definitionListContent')!.querySelectorAll('[role="option"]').length, 0);
    assert.equal(main.dataset.groupId, undefined, 'an empty scenario group has no standalone actions');
    h.receive({ command: 'snapshot', snapshot: { ...shared, viewIdentity: 'empty-groups:next' }, insertionTarget: { available: false } });
    const selected = tree.querySelectorAll('[role="treeitem"]').find(row => row.getAttribute('aria-selected') === 'true')!;
    assert.ok(text(selected).includes('Planned main'), 'refresh preserves selected empty category rather than falling back to all');
    const process = tree.querySelectorAll('[role="treeitem"]').find(row => text(row).includes('Planned process'))!;
    process.click();
    assert.equal(process.getAttribute('aria-selected'), 'true');
    assert.equal(h.elements.get('definitionListContent')!.querySelectorAll('[role="option"]').length, 0);
});

test('full Library uses the shared Ungrouped label for standalone feature rows and details', () => {
    const h = harness(false);
    const ungrouped = { ...snapshot, items: snapshot.items.map(item => ({ ...item, groupId: '', categoryPath: [] })) };
    h.receive({ command: 'snapshot', snapshot: ungrouped, insertionTarget: { available: false } });
    const rows = h.elements.get('definitionListContent')!.querySelectorAll('[role="option"]');
    assert.ok(rows.every(row => text(row).includes('Ungrouped')));
    assert.ok(text(h.elements.get('detailsContent')!).includes('Ungrouped'));
    assert.equal(text(h.elements.get('detailsContent')!).includes('Uncategorized'), false);
});

test('sidebar catalog reorder restores feature keyboard focus after lazy native pages reload', () => {
    const h = harness(true);
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot, 'en');
    const tree = h.elements.get('tree')!;
    const scroller = h.elements.get('treeScroll')!;
    let scrollPosition = 0;
    let maximumScroll = 0;
    Object.defineProperty(scroller, 'scrollTop', {
        get: () => scrollPosition,
        set: (value: number) => { scrollPosition = Math.max(0, Math.min(value, maximumScroll)); }
    });
    const replaceChildren = tree.replaceChildren.bind(tree);
    tree.replaceChildren = (...children: Element[]) => {
        replaceChildren(...children);
        // A browser clamps scrolling while the expanded lazy pages are temporarily absent.
        maximumScroll = tree.querySelector('[data-feature-id]') ? 1000 : 0;
        scroller.scrollTop = scroller.scrollTop;
    };
    const roots = (identity: string) => h.receive({ command: 'roots', identity, nodes: index.roots(), standaloneItems: snapshot.items });
    const rowFor = (id: string) => tree.querySelectorAll('.step-row').find(row => row.dataset.nodeId === id)!;
    roots('initial');
    tree.fire('click', { target: rowFor('source:standalone') });
    h.receive({ command: 'children', offset: 0, ...index.children('source:standalone') });
    tree.fire('click', { target: rowFor('category:standalone:smoke') });
    h.receive({ command: 'children', offset: 0, ...index.children('category:standalone:smoke') });
    const featureRow = tree.querySelector('[data-feature-id="file:///z.feature"]')!;
    featureRow.focus();
    h.elements.get('treeScroll')!.scrollTop = 350;
    featureRow.fire('keydown', { key: 'ArrowDown', altKey: true });
    roots('reordered');
    h.receive({ command: 'children', offset: 0, ...index.children('source:standalone') });
    h.receive({ command: 'children', offset: 0, ...index.children('category:standalone:smoke') });
    assert.equal(h.activeElement.dataset.featureId, 'file:///z.feature');
    assert.equal(h.elements.get('treeScroll')!.scrollTop, 350);
    assert.equal((h.focusOptions.at(-1) as any).preventScroll, true);
    h.activeElement.fire('keydown', { key: 'M', ctrlKey: true, shiftKey: true });
    assert.deepEqual(h.messages.at(-1), { command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///z.feature' });
    h.elements.get('searchInput')!.focus();
    roots('another-change');
    h.receive({ command: 'children', offset: 0, ...index.children('source:standalone') });
    assert.equal(h.activeElement, h.elements.get('searchInput'));
});

test('full Library catalog reorder preserves native feature focus, scroll and loaded row count', () => {
    const h = harness(false);
    const many = { ...snapshot, items: [...snapshot.items, ...Array.from({ length: 160 }, (_, order) => ({ ...snapshot.items[0], id: `bulk:${order}`, featureId: `file:///bulk-${order}.feature`, displayText: `Bulk ${order}`, order: order + 2 }))] };
    const receive = (viewIdentity: string) => h.receive({ command: 'snapshot', snapshot: { ...many, viewIdentity } });
    receive('first');
    h.elements.get('categoryTree')!.querySelector('[data-group-id="smoke"]')!.click();
    const list = h.elements.get('definitionList')!;
    list.fire('scroll');
    const content = h.elements.get('definitionListContent')!;
    const count = content.querySelectorAll('[role="option"]').length;
    assert.ok(count > 100);
    const row = content.querySelector('[data-feature-id="file:///z.feature"]')!;
    row.focus();
    list.scrollTop = 420;
    receive('changed');
    assert.equal(content.querySelectorAll('[role="option"]').length, count);
    assert.equal(h.activeElement.dataset.featureId, 'file:///z.feature');
    assert.equal(list.scrollTop, 420);
    assert.equal((h.focusOptions.at(-1) as any).preventScroll, true);
    h.elements.get('searchInput')!.focus();
    receive('search-focused');
    assert.equal(h.activeElement, h.elements.get('searchInput'));
});


for (const sidebar of [false, true]) {
    test(`${sidebar ? 'compact' : 'full'} Library keeps source attachment scope when listing and renaming after assembly`, () => {
        const scenario = { name: 'Main', tabName: 'Smoke', relativePath: 'main', yamlFileUri: { toString: () => 'file:///project/main/scen.yaml' } as any };
        const mixed = buildStepLibrarySnapshot({ identity: 'attachments', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [scenario],
            new Map([['file:///project/main/scen.yaml', { featureUri: 'file:///build/Main.feature', filesRootUri: 'file:///build/Main/Файлы' }]]));
        const h = harness(sidebar);
        const tree = h.elements.get(sidebar ? 'tree' : 'detailsContent')!;
        if (sidebar) {
            const index = StepLibrarySidebarIndex.fromSnapshot(mixed, 'en');
            h.receive({ command: 'roots', identity: mixed.viewIdentity, nodes: index.children('category:main:Smoke').nodes });
            tree.fire('click', { target: tree.querySelector('.step-row')! });
        } else {
            h.receive({ command: 'snapshot', snapshot: mixed, insertionTarget: { available: false } });
            h.elements.get('definitionListContent')!.querySelector('.definition-row')!.click();
        }
        const source = tree.querySelectorAll(sidebar ? '.step-row' : '.scenario-resource-row').find(row => text(row).includes('Source files'))!;
        assert.ok(source);
        if (sidebar) { tree.fire('click', { target: source }); } else { source.querySelector('.scenario-resource-disclosure')!.click(); }
        const request = h.messages.findLast(message => message.command === 'listScenarioFiles');
        assert.equal(request.resource, 'source');
        h.receive({ command: 'scenarioFileChildren', itemId: mixed.items[0].id, requestId: request.requestId, relativePath: '', nodes: [
            { id: 'source-data', kind: 'file', itemId: mixed.items[0].id, name: 'Data.csv', relativePath: 'Data.csv', resource: 'source', expandable: false }
        ] });
        const file = tree.querySelectorAll(sidebar ? '.step-row' : '.scenario-resource-file').find(row => text(row).includes('Data.csv'))!;
        assert.ok(file);
        file.querySelector(sidebar ? '.step-action-renameScenarioFile' : '.codicon-edit')!.click();
        assert.deepEqual(h.messages.at(-1), { command: 'renameScenarioFile', itemId: mixed.items[0].id, resource: 'source', relativePath: 'Data.csv' });
    });
}
