import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { HTMLElement as ParsedElement, parse } from 'node-html-parser';

const elementCache = new WeakMap<ParsedElement, Element>();
const styles = ['kotWebviewTheme.css', 'phaseSwitcher.css', 'kotSidebar.css', 'standaloneFeatures.css']
    .map(file => fs.readFileSync(path.join(process.cwd(), 'media', file), 'utf8'))
    .join('\n').replace(/\/\*[\s\S]*?\*\/|@import[^;]+;/gu, '');

class Element {
    readonly listeners = new Map<string, Array<(event: any) => void>>();
    readonly style: Record<string, any> = { setProperty: () => undefined };
    readonly dataset: Record<string, string>;
    readonly classList;
    checked = false;
    indeterminate = false;
    disabled = false;
    hidden = false;
    value = '';
    scrollTop = 0;
    scrollHeight = 300;
    clientWidth = 200;
    scrollWidth = 200;
    offsetHeight = 300;
    tabIndex = -1;

    constructor(readonly node: ParsedElement) {
        elementCache.set(node, this);
        this.dataset = new Proxy({}, {
            get: (_, key: string) => node.getAttribute(`data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`),
            set: (_, key: string, value: string) => {
                node.setAttribute(`data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`, value);
                return true;
            }
        });
        this.classList = {
            add: (...values: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...values])].join(' '); },
            remove: (...values: string[]) => { this.className = this.className.split(' ').filter(value => !values.includes(value)).join(' '); },
            contains: (value: string) => this.className.split(' ').includes(value),
            toggle: (value: string, force?: boolean) => {
                const add = force ?? !this.classList.contains(value);
                if (add) { this.classList.add(value); } else { this.classList.remove(value); }
                return add;
            }
        };
    }

    get className(): string { return this.node.getAttribute('class') || ''; }
    set className(value: string) { this.node.setAttribute('class', value); }
    get id(): string { return this.node.id; }
    set id(value: string) { this.node.id = value; }
    get name(): string { return this.node.getAttribute('name') || ''; }
    set name(value: string) { this.node.setAttribute('name', value); }
    get title(): string { return this.node.getAttribute('title') || ''; }
    set title(value: string) { this.node.setAttribute('title', value); }
    get type(): string { return this.node.getAttribute('type') || ''; }
    set type(value: string) { this.node.setAttribute('type', value); }
    get tagName(): string { return this.node.tagName; }
    get innerHTML(): string { return this.node.innerHTML; }
    set innerHTML(value: string) { this.node.set_content(value); }
    get textContent(): string { return this.node.textContent; }
    set textContent(value: string) { this.node.set_content(value); }
    get children(): Element[] { return this.node.childNodes.filter((node): node is ParsedElement => node instanceof ParsedElement).map(wrap); }
    get content(): { firstElementChild?: Element } { return { firstElementChild: this.children[0] }; }
    get parentElement(): Element | undefined { return this.node.parentNode ? wrap(this.node.parentNode) : undefined; }
    get isConnected(): boolean { return !!this.node.parentNode; }
    append(...values: Element[]): void { values.forEach(value => this.node.appendChild(value.node)); }
    appendChild(value: Element): Element { this.append(value); return value; }
    insertBefore(value: Element, before: Element | null): void { if (before) { before.node.before(value.node); } else { this.append(value); } }
    contains(value: Element): boolean { return this === value || this.children.some(child => child.contains(value)); }
    querySelectorAll(selector: string): Element[] { return this.node.querySelectorAll(selector).map(wrap); }
    querySelector(selector: string): Element | null { const node = this.node.querySelector(selector); return node ? wrap(node) : null; }
    closest(selector: string): Element | null {
        const node = this.node.closest(selector);
        return node ? wrap(node) : null;
    }
    setAttribute(name: string, value: string): void { this.node.setAttribute(name, value); }
    getAttribute(name: string): string | null { return this.node.getAttribute(name) ?? null; }
    removeAttribute(name: string): void { this.node.removeAttribute(name); }
    remove(): void { this.node.remove(); }
    focus(): void {}
    scrollIntoView(): void {}
    getBoundingClientRect(): Record<string, number> { return { left: 10, top: 10, right: 200, bottom: 40, width: 190, height: 30 }; }
    addEventListener(name: string, listener: (event: any) => void): void { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]); }
    removeEventListener(name: string, listener: (event: any) => void): void { this.listeners.set(name, (this.listeners.get(name) || []).filter(value => value !== listener)); }
    click(): void { this.fire('click'); }
    fire(name: string, fields: Record<string, unknown> = {}): void {
        const event = { target: this, currentTarget: this, preventDefault: () => undefined, stopPropagation: () => undefined, ...fields };
        for (const listener of this.listeners.get(name) || []) { listener(event); }
    }
}

class InputElement extends Element {}
class ButtonElement extends Element {}
class SelectElement extends Element {}

function wrap(node: ParsedElement): Element {
    const existing = elementCache.get(node);
    if (existing) { return existing; }
    const Type = node.tagName === 'INPUT' ? InputElement : node.tagName === 'BUTTON' ? ButtonElement : node.tagName === 'SELECT' ? SelectElement : Element;
    return new Type(node);
}

function cssValue(element: Element, property: string): string | undefined {
    const inline = element.style[property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())];
    let winner: { specificity: number; important: boolean; value: string } | undefined = typeof inline === 'string'
        ? { specificity: 1000, important: false, value: inline }
        : undefined;
    for (const rule of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        const declaration = rule[2].match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'u'))?.[1].trim();
        if (!declaration) { continue; }
        for (const original of rule[1].split(',')) {
            const selector = original.trim().replace(/:(focus-visible|focus-within|hover|focus|active|root)\b/gu, '[data-$1]')
                .replace(/:disabled\b/gu, '[disabled]');
            try { if (!element.node.matches(selector)) { continue; } } catch { continue; }
            const specificity = (selector.match(/#[\w-]+/gu)?.length ?? 0) * 100
                + ((selector.match(/\.[\w-]+/gu)?.length ?? 0) + (selector.match(/\[[^\]]+\]/gu)?.length ?? 0)) * 10
                + (selector.match(/(?:^|[\s>+~])[a-z][\w-]*/gu)?.length ?? 0);
            const important = /!important\s*$/u.test(declaration);
            if (!winner || Number(important) > Number(winner.important)
                || (important === winner.important && specificity >= winner.specificity)) {
                winner = { specificity, important, value: declaration.replace(/\s*!important\s*$/u, '') };
            }
        }
    }
    return winner?.value ?? (property === 'pointer-events' ? 'auto' : undefined);
}

function harness(savedState: Record<string, unknown> = {}, labels: Record<string, string> = {}) {
    const body = wrap(parse('<body><div class="manager-trees-scroll"><div id="phaseTreeContainer"></div></div><input id="selectAllBtn" type="checkbox"><span id="selectedCount"></span><span id="selectableCount"></span><input id="scenarioSearchInput"></body>').firstChild as ParsedElement);
    const window = wrap(parse('<window></window>').firstChild as ParsedElement);
    const messages: Array<Record<string, unknown>> = [];
    let state = savedState;
    const document = {
        body,
        activeElement: null,
        querySelectorAll: body.querySelectorAll.bind(body),
        querySelector: body.querySelector.bind(body),
        getElementById: (id: string) => body.querySelector(`#${id}`),
        createElement: (tag: string) => wrap(parse(`<${tag}></${tag}>`).firstChild as ParsedElement),
        addEventListener: window.addEventListener.bind(window)
    };
    Object.assign(window, { __loc: labels, innerWidth: 400, innerHeight: 800 });
    vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'media', 'phaseSwitcher.js'), 'utf8'), {
        document, window,
        HTMLElement: Element, Element, Node: Element,
        HTMLInputElement: InputElement, HTMLButtonElement: ButtonElement, HTMLSelectElement: SelectElement,
        PhaseSwitcherProtocol: require(path.join(process.cwd(), 'media', 'phaseSwitcherProtocol.js')),
        KotScenarioFilesProtocol: require(path.join(process.cwd(), 'media', 'scenarioFilesProtocol.js')),
        acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => messages.push(message), getState: () => state, setState: (value: Record<string, unknown>) => { state = value; } }),
        requestAnimationFrame: (callback: () => void) => callback(),
        setTimeout: () => undefined,
        console: { log: () => undefined, error: () => undefined }
    });
    const load = (tabData = fixture, states: Record<string, unknown> = { 'file:///main.yaml': 'checked', 'file:///process.yaml': 'unchecked', 'file:///other.yaml': 'checked' }, scenarioGroups: Array<{ id: string; name: string; sections: string[]; order: number; projectRoot?: string; key?: string; displayOrders?: Record<string, number> }> = []) => window.fire('message', { data: {
        command: 'loadInitialState', tabData, states, scenarioGroups, settings: { assemblerEnabled: false, switcherEnabled: true, driveFeaturesEnabled: false }, runArtifacts: {}
    } });
    return { body, window, messages, load, state: () => state, tree: body.querySelector('#phaseTreeContainer')! };
}

const fixture = {
    'Sales & inventory': [
        { name: 'Main sales', kind: 'main', scenarioKey: 'file:///main.yaml', yamlFileUriString: 'file:///main.yaml' },
        { name: 'Sales process', kind: 'process', scenarioKey: 'file:///process.yaml', yamlFileUriString: 'file:///process.yaml' }
    ],
    'Sales _ inventory': [
        { name: 'Other main', scenarioKey: 'file:///other.yaml', yamlFileUriString: 'file:///other.yaml' }
    ]
};

function dragTransfer() {
    const data = new Map<string, string>();
    return { effectAllowed: '', dropEffect: '', types: [] as string[],
        setData(type: string, value: string) { data.set(type, value); this.types.push(type); },
        getData: (type: string) => data.get(type) || '' };
}

test('group and item drag handles emit scoped ordering commands and highlight only valid drops', () => {
    const h = harness();
    const groups = ['a', 'b'].map((id, order) => ({ id, name: id, key: id, sections: ['main', 'process'], order,
        projectRoot: '/project', displayOrders: { main: 1 - order, process: order } }));
    const data: any = { a: [{ name: 'First', scenarioKey: 'file:///main.yaml', yamlFileUriString: 'file:///main.yaml',
        projectRoot: '/project', groupId: 'a', entityKey: 'uid:first', order: 0 }], b: [] };
    h.load(data, undefined, groups);
    const headers = h.tree.querySelectorAll('.scenario-type-section')[0].querySelectorAll('.phase-header');
    assert.deepEqual(headers.map(header => header.dataset.groupId), ['b', 'a']);
    const handle = headers[1].querySelector('.project-order-drag-handle')!;
    assert.ok(handle, 'group exposes a drag handle');
    assert.equal(handle.getAttribute('draggable'), 'true');
    const transfer = dragTransfer();
    handle.fire('dragstart', { dataTransfer: transfer });
    headers[0].fire('dragover', { dataTransfer: transfer, clientY: 15 });
    assert.ok(headers[0].classList.contains('is-order-drop-before'));
    assert.equal(cssValue(headers[0], 'box-shadow'), 'inset 0 2px 0 var(--vscode-focusBorder)');
    headers[0].fire('drop', { dataTransfer: transfer, clientY: 15 });
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), { command: 'reorderProjectLibrary', type: 'group',
        projectRoot: '/project', section: 'main', groupId: 'a', beforeId: 'b', expectedIds: ['b', 'a'] });
    const row = h.tree.querySelector('.checkbox-item[data-key]')!;
    const itemHandle = row.querySelector('.project-order-drag-handle')!;
    assert.ok(itemHandle, 'item exposes a drag handle');
    const itemTransfer = dragTransfer();
    itemHandle.fire('dragstart', { dataTransfer: itemTransfer });
    const processTarget = h.tree.querySelectorAll('.scenario-type-section')[1].querySelector('.phase-header')!;
    processTarget.fire('dragover', { dataTransfer: itemTransfer });
    assert.equal(processTarget.classList.contains('is-order-drop-target'), false);
    headers[0].fire('drop', { dataTransfer: itemTransfer });
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), { command: 'reorderProjectLibrary', type: 'item',
        projectRoot: '/project', section: 'main', uri: 'file:///main.yaml', groupId: 'b',
        expectedSource: [{ key: 'uid:first', order: 0 }], expectedDestination: [] });
    const count = h.messages.length;
    headers[0].fire('drop', { dataTransfer: itemTransfer });
    assert.equal(h.messages.length, count, 'an external or completed drag cannot replay a write');
});

test('Test Manager ordering rejects foreign project targets and invalidates active drags on refreshed state', () => {
    const h = harness();
    const groups = [
        { id: 'a', key: 'first', name: 'Same name', projectRoot: '/one', sections: ['main'], order: 0 },
        { id: 'a', key: 'second', name: 'Same name', projectRoot: '/two', sections: ['main'], order: 0 }
    ];
    const data: any = { first: [{ name: 'First', scenarioKey: 'file:///main.yaml', yamlFileUriString: 'file:///main.yaml', projectRoot: '/one', groupId: 'a', entityKey: 'uid:first', order: 0 }], second: [] };
    h.load(data, undefined, groups);
    const target = h.tree.querySelectorAll('.phase-header')[1];
    const transfer = dragTransfer();
    h.tree.querySelector('.checkbox-item .project-order-drag-handle')!.fire('dragstart', { dataTransfer: transfer });
    target.fire('dragover', { dataTransfer: transfer });
    target.fire('drop', { dataTransfer: transfer });
    assert.equal(target.classList.contains('is-order-drop-target'), false);
    assert.equal(h.messages.filter(message => message.command === 'reorderProjectLibrary').length, 0);
    h.load(data, undefined, groups);
    h.tree.querySelector('.phase-header')!.fire('drop', { dataTransfer: transfer });
    assert.equal(h.messages.filter(message => message.command === 'reorderProjectLibrary').length, 0, 'the old drag cannot write after a refresh');
});

test('scenario section headers match standalone action track and retain both hidden creation controls in one row', () => {
    const h = harness();
    h.load();
    for (const heading of h.tree.querySelectorAll('.scenario-section-header')) {
        const create = heading.querySelector('.scenario-section-create-btn')!;
        assert.equal(cssValue(heading, 'display'), 'grid');
        assert.equal(cssValue(heading, 'grid-template-columns'), '18px minmax(0, 1fr) 48px auto');
        assert.equal(heading.children.length, 4, 'all header children have an explicit grid column');
        const actions = heading.querySelector('.scenario-section-actions')!;
        assert.equal(actions.children.length, 2, 'scenario creation and group creation share one action track');
        assert.equal(cssValue(actions, 'width'), '48px');
        assert.equal(cssValue(create, 'display'), 'inline-flex', 'the hidden action retains its column like Standalone features');
        assert.equal(cssValue(create, 'opacity'), '0', 'shared icon button styles cannot reveal idle section creation');
        assert.equal(cssValue(create, 'pointer-events'), 'none');
        assert.equal(cssValue(create, 'min-height'), '24px');
    }
});

test('scenario section creation reveals on hover and keyboard focus without moving its count', () => {
    for (const state of ['hover', 'focus-visible', 'child-focus'] as const) {
        const h = harness();
        h.load();
        for (const heading of h.tree.querySelectorAll('.scenario-section-header')) {
            const create = heading.querySelector('.scenario-section-create-btn')!;
            (state === 'child-focus' ? create : heading).setAttribute(`data-${state === 'child-focus' ? 'focus-visible' : state}`, '');
            assert.equal(cssValue(heading, 'grid-template-columns'), '18px minmax(0, 1fr) 48px auto', state);
            assert.equal(cssValue(create, 'opacity'), '1', state);
            assert.equal(cssValue(create, 'pointer-events'), 'auto', state);
            const newGroup = heading.querySelector('.scenario-section-new-group-btn')!;
            assert.equal(cssValue(newGroup, 'opacity'), '1', state);
            assert.equal(cssValue(newGroup, 'pointer-events'), 'auto', state);
        }
    }
});

test('disabled scenario section creation remains hidden on hover and focus', () => {
    const h = harness();
    h.load();
    for (const heading of h.tree.querySelectorAll('.scenario-section-header')) {
        const create = heading.querySelector('.scenario-section-create-btn')!;
        create.setAttribute('disabled', '');
        heading.setAttribute('data-hover', '');
        heading.setAttribute('data-focus-visible', '');
        create.setAttribute('data-focus-visible', '');
        assert.equal(cssValue(create, 'opacity'), '0', 'build-disabled theme and interaction styles cannot reveal creation');
        assert.equal(cssValue(create, 'pointer-events'), 'none');
        assert.equal(cssValue(heading, 'grid-template-columns'), '18px minmax(0, 1fr) 48px auto');
    }
});

test('Test Manager partitions shared business groups into independent scenario and process sections', () => {
    const h = harness();
    h.load();
    const sections = h.tree.querySelectorAll('.scenario-type-section');
    assert.equal(sections.length, 2);
    assert.deepEqual(sections.map(section => section.dataset.scenarioKind), ['main', 'process']);
    assert.equal(sections[0].querySelector('.scenario-section-title')?.textContent, 'Main scenarios');
    assert.equal(sections[1].querySelector('.scenario-section-title')?.textContent, 'Processes');
    assert.deepEqual(sections[0].querySelectorAll('.checkbox-item').map(row => row.dataset.key), ['file:///main.yaml', 'file:///other.yaml']);
    assert.deepEqual(sections[1].querySelectorAll('.checkbox-item').map(row => row.dataset.key), ['file:///process.yaml']);
    const groups = h.tree.querySelectorAll('.phase-group');
    assert.equal(new Set(groups.map(group => group.id)).size, 3, 'type and punctuation differences never collide');
    assert.equal(sections[0].querySelector('.phase-test-count')?.textContent, '1/1');
    assert.equal(sections[1].querySelector('.phase-test-count')?.textContent, '0/1');
});

test('group expansion and selection affect only their section when group names match', () => {
    const h = harness();
    h.load();
    const sections = h.tree.querySelectorAll('.scenario-type-section');
    const mainGroup = sections[0].querySelector('.phase-group')!;
    const processGroup = sections[1].querySelector('.phase-group')!;
    processGroup.querySelector('.phase-expand-collapse-btn')!.click();
    assert.equal(processGroup.querySelector('.phase-tests-list')!.classList.contains('expanded'), true);
    assert.equal(mainGroup.querySelector('.phase-tests-list')!.classList.contains('expanded'), false);
    const checkbox = processGroup.querySelector('.phase-select-checkbox')!;
    checkbox.checked = true;
    checkbox.fire('change');
    const selection = h.messages.findLast(message => message.command === 'updateScenarioSelectionStates');
    assert.deepEqual(JSON.parse(JSON.stringify(selection?.data)), { 'file:///main.yaml': true, 'file:///process.yaml': true, 'file:///other.yaml': true });
    checkbox.checked = false;
    checkbox.fire('change');
    assert.equal((h.messages.findLast(message => message.command === 'updateScenarioSelectionStates')?.data as Record<string, unknown>)['file:///main.yaml'], true);
    h.window.fire('message', { data: { command: 'scenarioFileInvalidated', itemId: 'file:///main.yaml' } });
    assert.equal(h.tree.querySelectorAll('.scenario-type-section')[1].querySelector('.phase-tests-list')!.classList.contains('expanded'), true, 'refresh retains process expansion independently');
});

test('section collapse survives refresh and webview restore without losing selections or standalone state', () => {
    const h = harness({ standaloneFeatures: { selectedId: 'file:///standalone.feature' } });
    h.load();
    const process = h.tree.querySelectorAll('.scenario-type-section')[1];
    process.querySelector('.scenario-section-header')!.click();
    assert.equal(process.querySelector('.scenario-section-groups')!.classList.contains('expanded'), false);
    assert.equal((h.state().standaloneFeatures as Record<string, unknown>).selectedId, 'file:///standalone.feature');
    h.window.fire('message', { data: { command: 'scenarioFileInvalidated', itemId: 'file:///process.yaml' } });
    assert.equal(h.tree.querySelectorAll('.scenario-type-section')[1].querySelector('.scenario-section-groups')!.classList.contains('expanded'), false);
    assert.equal(h.body.querySelector('#selectedCount')!.textContent, '2');
    const restored = harness(h.state());
    restored.load();
    assert.equal(restored.tree.querySelectorAll('.scenario-type-section')[1].querySelector('.scenario-section-groups')!.classList.contains('expanded'), false);
});

test('group and section creation use the chosen type and exact shared group name', () => {
    const h = harness({}, { mainScenariosSection: 'Основные сценарии', processesSection: 'Процессы' });
    h.load();
    const process = h.tree.querySelectorAll('.scenario-type-section')[1];
    process.querySelector('.phase-create-main-btn')!.click();
    h.body.querySelector('.phase-context-menu .run-mode-menu-item')!.click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'createProcess'))), { command: 'createProcess', groupName: 'Sales & inventory' });
    process.querySelector('.scenario-section-create-btn')!.click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'createProcess'))), { command: 'createProcess' });
    const main = h.tree.querySelectorAll('.scenario-type-section')[0];
    assert.equal(main.querySelector('.scenario-section-title')!.textContent, 'Основные сценарии');
    process.querySelector('.phase-header')!.fire('contextmenu', { clientX: 10, clientY: 10 });
    h.body.querySelector('.phase-context-menu .run-mode-menu-item')!.click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'createProcess'))), { command: 'createProcess', groupName: 'Sales & inventory' });
});

test('status and search filters update per-section groups and counts while retaining hidden selections', () => {
    const h = harness();
    h.load();
    h.window.fire('message', { data: { command: 'updateRunArtifactsState', runArtifacts: { 'file:///process.yaml': { featurePath: '/process.feature', jsonPath: '/process.json' } } } });
    h.window.fire('message', { data: { command: 'updateStatusFilter', statusFilter: 'built' } });
    const sections = h.tree.querySelectorAll('.scenario-type-section');
    assert.equal(sections[0].querySelector('.phase-group')!.classList.contains('filter-hidden'), true);
    assert.equal(sections[1].querySelector('.phase-group')!.classList.contains('filter-hidden'), false);
    assert.equal(sections[0].querySelector('.scenario-section-count')!.textContent, '0');
    assert.equal(sections[1].querySelector('.scenario-section-count')!.textContent, '1');
    const selectAll = h.body.querySelector('#selectAllBtn')!;
    selectAll.checked = true;
    selectAll.fire('change');
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'updateScenarioSelectionStates')?.data)), { 'file:///main.yaml': true, 'file:///process.yaml': true, 'file:///other.yaml': true });
    const search = h.body.querySelector('#scenarioSearchInput')!;
    search.value = 'Other';
    search.fire('input');
    assert.equal(h.body.querySelector('#selectableCount')!.textContent, '0');
});

test('empty sections retain localized creation actions and participate in collapse all', () => {
    const h = harness({}, { noMainScenarios: 'Нет основных сценариев.', noProcesses: 'Нет процессов.' });
    h.load({}, {});
    const sections = h.tree.querySelectorAll('.scenario-type-section');
    assert.deepEqual(sections.map(section => section.querySelector('.scenario-section-empty')!.textContent), ['Нет основных сценариев.', 'Нет процессов.']);
    sections[1].querySelector('.scenario-section-create-btn')!.click();
    assert.equal(h.messages.findLast(message => message.command === 'createProcess')?.command, 'createProcess');
    h.window.fire('message', { data: { command: 'toggleAllGroups' } });
    assert.deepEqual(sections.map(section => section.querySelector('.scenario-section-groups')!.classList.contains('expanded')), [false, false]);
    h.window.fire('message', { data: { command: 'toggleAllGroups' } });
    assert.deepEqual(sections.map(section => section.querySelector('.scenario-section-groups')!.classList.contains('expanded')), [true, true]);
});

test('shared empty business groups offer type-specific creation until a visibility filter is active', () => {
    const h = harness();
    h.load({ 'Planned phase': [] }, {}, [{ id: 'planned', name: 'Planned phase', sections: ['main', 'process'], order: 1 }]);
    const groups = h.tree.querySelectorAll('.phase-group');
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(group => group.classList.contains('filter-hidden')), [false, false]);
    groups[1].querySelector('.phase-create-main-btn')!.click();
    h.body.querySelector('.phase-context-menu .run-mode-menu-item')!.click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'createProcess'))), { command: 'createProcess', groupName: 'Planned phase' });
    h.window.fire('message', { data: { command: 'updateStatusFilter', statusFilter: 'built' } });
    assert.deepEqual(groups.map(group => group.classList.contains('filter-hidden')), [true, true]);
});

test('new-group actions send the section kind and localized caption without collapsing the section', () => {
    const h = harness({}, { createGroup: 'Новая группа' });
    h.load({}, {});
    for (const section of h.tree.querySelectorAll('.scenario-type-section')) {
        const action = section.querySelector('.scenario-section-new-group-btn')!;
        assert.ok(action.querySelector('.codicon-new-folder'));
        assert.equal(action.title, 'Новая группа');
        action.click();
        assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'createScenarioGroup'))), {
            command: 'createScenarioGroup', kind: section.dataset.scenarioKind
        });
        assert.equal(section.querySelector('.scenario-section-header')!.getAttribute('aria-expanded'), 'true');
    }
});

test('declared empty groups keep their own section and project order even when the other type has members', () => {
    const h = harness();
    const groups = [
        { id: 'later', name: 'A later', sections: ['main'], order: 2 },
        { id: 'first', name: 'Z first', sections: ['main'], order: 1 },
        { id: 'cross-type', name: 'Sales', sections: ['main', 'process'], order: 3 },
        { id: 'only-process', name: 'Process only', sections: ['process'], order: 1 }
    ];
    h.load({ Sales: [fixture['Sales & inventory'][0]], 'A later': [], 'Z first': [], 'Process only': [], 'Orphan legacy empty': [] }, { 'file:///main.yaml': 'checked' }, groups);
    const [main, process] = h.tree.querySelectorAll('.scenario-type-section');
    const groupNames = (section: Element) => section.querySelectorAll('.phase-header').map(header => header.dataset.phaseName);
    assert.deepEqual(groupNames(main), ['Z first', 'A later', 'Sales']);
    assert.deepEqual(groupNames(process), ['Process only', 'Sales']);
    const processSales = process.querySelectorAll('.phase-header').find(header => header.dataset.phaseName === 'Sales')!;
    assert.equal(processSales.dataset.groupId, 'cross-type');
    assert.equal(processSales.closest('.phase-group')!.classList.contains('filter-hidden'), false, 'empty process projection stays available despite existing mains');
    h.window.fire('message', { data: { command: 'updateStatusFilter', statusFilter: 'built' } });
    assert.ok(h.tree.querySelectorAll('.phase-group').every(group => group.classList.contains('filter-hidden')));
});

test('build and repair hide and disable both section creation buttons and prevent messages', () => {
    for (const mode of ['build', 'repair'] as const) {
        const h = harness();
        h.load();
        h.window.fire('message', { data: mode === 'build'
            ? { command: 'buildStateChanged', inProgress: true }
            : { command: 'loadInitialState', tabData: fixture, states: {}, scenarioGroups: [], settings: { assemblerEnabled: false, switcherEnabled: true, scenarioRepairInProgress: true } }
        });
        for (const heading of h.tree.querySelectorAll('.scenario-section-header')) {
            heading.setAttribute('data-hover', '');
            const actions = heading.querySelectorAll('.scenario-section-action');
            assert.equal(actions.length, 2);
            for (const action of actions) {
                assert.equal(action.disabled, true, mode);
                // The lightweight DOM adapter stores the native disabled property separately.
                action.setAttribute('disabled', '');
                assert.equal(cssValue(action, 'opacity'), '0', mode);
                assert.equal(cssValue(action, 'pointer-events'), 'none', mode);
                action.click();
            }
        }
        assert.equal(h.messages.some(message => ['createMainScenario', 'createProcess', 'createScenarioGroup'].includes(String(message.command))), false, mode);
    }
});

test('all three section headers share grid dimensions and build-disabled standalone actions stay hidden', () => {
    const h = harness();
    h.load();
    const standalone = wrap(parse('<div class="standalone-features-manager"><div class="standalone-section-row standalone-row kot-tree-row"><span></span><span></span><span class="standalone-actions"><button class="standalone-action"></button><button class="standalone-action"></button></span><span class="standalone-count kot-tree-count"></span></div></div>').firstChild as ParsedElement);
    const heading = standalone.querySelector('.standalone-section-row')!;
    const mainHeading = h.tree.querySelector('.scenario-section-header')!;
    for (const property of ['display', 'grid-template-columns', 'gap', 'min-height']) {
        assert.equal(cssValue(mainHeading, property), cssValue(heading, property), property);
    }
    const actions = heading.querySelector('.standalone-actions')!;
    assert.equal(cssValue(actions, 'width'), '48px');
    assert.equal(cssValue(actions, 'gap'), '0');
    for (const button of actions.children) { button.setAttribute('disabled', ''); }
    heading.setAttribute('data-hover', '');
    heading.setAttribute('data-focus-visible', '');
    actions.children[0].setAttribute('data-focus-visible', '');
    assert.equal(cssValue(actions, 'opacity'), '0');
    assert.equal(cssValue(actions, 'pointer-events'), 'none');
});

test('declared group rename carries stable identity along with its captured name', () => {
    const h = harness();
    h.load({ Sales: [] }, {}, [{ id: 'shared-sales', name: 'Sales', sections: ['process'], order: 0 }]);
    const header = h.tree.querySelector('.phase-header')!;
    header.fire('contextmenu', { clientX: 10, clientY: 10 });
    h.body.querySelectorAll('.phase-context-menu .run-mode-menu-item')[2].click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'renameGroup'))), {
        command: 'renameGroup', groupName: 'Sales', groupId: 'shared-sales'
    });
});

test('virtual Ungrouped creation preserves the empty group identity in both sections', () => {
    const h = harness();
    h.load({ Ungrouped: [fixture['Sales & inventory'][0], fixture['Sales & inventory'][1]] }, undefined,
        [{ id: '', name: 'Ungrouped', sections: ['main', 'process'], order: Infinity }]);
    for (const group of h.tree.querySelectorAll('.phase-group')) {
        group.querySelector('.phase-create-main-btn')!.click();
        const menu = h.body.querySelector('.phase-context-menu')!;
        menu.querySelectorAll('.run-mode-menu-item')[0].click();
        assert.equal(h.messages.findLast(message => message.command === 'createMainScenario' || message.command === 'createProcess')?.groupName, '');
        group.querySelector('.phase-header')!.fire('contextmenu', { clientX: 10, clientY: 10 });
        const context = h.body.querySelector('.phase-context-menu')!;
        assert.equal(context.querySelectorAll('.run-mode-menu-item').length, 2, 'virtual groups offer creation without shared rename');
        context.querySelectorAll('.run-mode-menu-item')[1].click();
        assert.equal(h.messages.findLast(message => message.command === 'createMainScenario' || message.command === 'createProcess')?.groupName, '');
    }
});

test('virtual group labels are localized without translating user group names or changing group identity', () => {
    const h = harness({}, { ungrouped: 'Без группы' });
    h.load({ virtual: [fixture['Sales & inventory'][0]], named: [fixture['Sales & inventory'][1]] }, undefined, [
        { id: '', key: 'virtual', name: 'Ungrouped', sections: ['main', 'process'], order: Infinity },
        { id: 'custom', key: 'named', name: 'Ungrouped', sections: ['process'], order: 0 }
    ]);
    const headers = h.tree.querySelectorAll('.phase-header');
    assert.equal(headers.filter(header => header.textContent.includes('Без группы')).length, 2);
    assert.equal(headers.filter(header => header.textContent.includes('Ungrouped')).length, 1);
    const virtual = headers.find(header => header.textContent.includes('Без группы'))!;
    assert.equal(virtual.getAttribute('data-phase-name'), 'virtual');
});

test('a main-only business group can create its first process through the shared group menu', () => {
    const h = harness();
    h.load({ Sales: [fixture['Sales & inventory'][0]] }, { 'file:///main.yaml': 'checked' });
    const mainGroup = h.tree.querySelectorAll('.scenario-type-section')[0].querySelector('.phase-group')!;
    mainGroup.querySelector('.phase-create-main-btn')!.click();
    const menu = h.body.querySelector('.phase-context-menu')!;
    assert.ok(menu, 'the existing group plus offers both creation choices');
    assert.equal(menu.querySelectorAll('.run-mode-menu-item').length, 2);
    menu.querySelectorAll('.run-mode-menu-item')[1].click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'createProcess'))), { command: 'createProcess', groupName: 'Sales' });
    mainGroup.querySelector('.phase-header')!.fire('contextmenu', { clientX: 10, clientY: 10 });
    const context = h.body.querySelector('.phase-context-menu')!;
    assert.equal(context.querySelectorAll('.run-mode-menu-item').length, 3, 'group context menu has both creation choices and shared rename');
    context.querySelectorAll('.run-mode-menu-item')[1].click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.findLast(message => message.command === 'createProcess'))), { command: 'createProcess', groupName: 'Sales' });
});

test('search reveals matching group rows while a section can still collapse and clear its animation lock', () => {
    const h = harness();
    h.load();
    const search = h.body.querySelector('#scenarioSearchInput')!;
    search.value = 'Sales';
    search.fire('input');
    const process = h.tree.querySelectorAll('.scenario-type-section')[1];
    const groupList = process.querySelector('.phase-group > .phase-tests-list')!;
    const sectionGroups = process.querySelector('.scenario-section-groups')!;
    assert.equal(cssValue(groupList, 'max-height'), 'none', 'search reveals a stored collapsed group');
    assert.equal(cssValue(groupList, 'opacity'), '1');
    assert.equal(cssValue(sectionGroups, 'max-height'), 'none');
    process.querySelector('.scenario-section-header')!.click();
    assert.equal(cssValue(sectionGroups, 'max-height'), '0px', 'section collapse changes its effective height during search');
    assert.equal(cssValue(sectionGroups, 'opacity'), '0');
    sectionGroups.fire('transitionend', { propertyName: 'max-height' });
    assert.equal(sectionGroups.classList.contains('animating'), false);
    assert.equal(cssValue(sectionGroups, 'pointer-events'), 'auto');
    assert.equal(process.querySelector('.scenario-section-header')!.getAttribute('aria-expanded'), 'false');
});

test('group toggles under forced search reveal retain stored expansion without awaiting an impossible height transition', () => {
    const h = harness();
    h.load();
    const search = h.body.querySelector('#scenarioSearchInput')!;
    search.value = 'Sales';
    search.fire('input');
    const process = h.tree.querySelectorAll('.scenario-type-section')[1];
    const list = process.querySelector('.phase-group > .phase-tests-list')!;
    const toggle = process.querySelector('.phase-expand-collapse-btn')!;
    toggle.click();
    assert.equal(cssValue(list, 'max-height'), 'none');
    assert.equal(cssValue(list, 'pointer-events'), 'auto');
    assert.equal(list.classList.contains('animating'), false);
    toggle.click();
    assert.equal(cssValue(list, 'max-height'), 'none', 'search still reveals a stored collapsed group');
    assert.equal(cssValue(list, 'pointer-events'), 'auto');
    search.value = '';
    search.fire('input');
    assert.equal(cssValue(list, 'max-height'), '0px', 'clearing search restores the chosen expansion');
    assert.equal(list.classList.contains('animating'), false);
});

test('starting search during a group transition clears the lock before CSS forces natural height', () => {
    const h = harness();
    h.load();
    const process = h.tree.querySelectorAll('.scenario-type-section')[1];
    const list = process.querySelector('.phase-group > .phase-tests-list')!;
    process.querySelector('.phase-expand-collapse-btn')!.click();
    assert.equal(list.classList.contains('animating'), true);
    const search = h.body.querySelector('#scenarioSearchInput')!;
    search.value = 'Sales';
    search.fire('input');
    assert.equal(cssValue(list, 'max-height'), 'none');
    assert.equal(cssValue(list, 'pointer-events'), 'auto');
    assert.equal(list.classList.contains('animating'), false);
    assert.equal((list.listeners.get('transitionend') || []).length, 0);
    search.value = '';
    search.fire('input');
    assert.equal(cssValue(list, 'max-height'), 'none', 'stored expanded group survives search');
});
