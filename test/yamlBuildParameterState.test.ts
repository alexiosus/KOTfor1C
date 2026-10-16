import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { parse, HTMLElement as HtmlNode } from 'node-html-parser';

function loadState(): any {
    const file = path.join(process.cwd(), 'media/yamlBuildParameterState.js');
    const context: any = { window: {} };
    vm.runInNewContext(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', context);
    return context.window.KotYamlBuildParameterState || {};
}
const defaults = [{ key: 'ModelDBSettings', value: 'bases.yaml' }, { key: 'LaunchDBFolder', value: 'launch-base' }];
const value = (rows: any[], key: string) => rows.find(row => row.key === key)?.value;

test('webview preserves explicit empty model settings across profile switching', () => {
    const rows = loadState().normalize([{ key: 'ModelDBSettings', value: '' }], defaults);
    assert.equal(value(rows, 'ModelDBSettings'), '');
});
test('webview keeps folder and explicit connection roles with compiler precedence', () => {
    const rows = loadState().normalize([
        { key: 'LaunchDBFolder', value: '/file' }, { key: 'TestClientDBPath', value: '/other' },
        { key: 'InfobasePath', value: 'Srvr="old";Ref="base";' }, { key: 'TestClientDB', value: 'Srvr="new";Ref="base";' }
    ], defaults);
    assert.equal(value(rows, 'LaunchDBFolder'), '/file');
    assert.equal(value(rows, 'TestClientDB'), 'Srvr="new";Ref="base";');
    assert.equal(rows.filter(row => /^(LaunchDBFolder|TestClientDBPath)$/u.test(row.key)).length, 1);
    assert.equal(rows.filter(row => /^(InfobasePath|TestClientDB)$/u.test(row.key)).length, 1);
});
test('TestFolder takes precedence over both roots in webview and Drive values survive', () => {
    const rows = loadState().normalize([
        { key: 'TestFolder', value: '/all' }, { key: 'ScenarioFolder', value: '/scenario' },
        { key: 'ProcessFolder', value: '/other' }, { key: 'SplitFeatureFiles', value: 'True' }
    ], defaults);
    assert.equal(value(rows, 'ScenarioFolder'), '/all');
    assert.equal(value(rows, 'ProcessFolder'), '/all');
    assert.equal(value(rows, 'SplitFeatureFiles'), 'True');
});
test('reset of the folder alias uses the canonical default', () => {
    assert.equal(loadState().defaultValue('TestClientDBPath', defaults), 'launch-base');
});
test('compile-only webview validation does not require launch parameters', () => {
    const rows = [{ key: 'ScenarioFolder', value: '/yaml' }, { key: 'FeatureFolder', value: '/feature' }, { key: 'CreateJson', value: 'False' }];
    assert.equal(loadState().requiredMissing('VanessaFolder', rows), false);
    assert.equal(loadState().requiredMissing('LaunchDBFolder', rows), false);
    assert.equal(loadState().requiredMissing('FeatureFolder', rows), false);
});

test('connection-only webview profiles keep one optional connection role without adding a folder role', () => {
    const state = loadState();
    const rows = state.normalize([{ key: 'InfobasePath', value: 'Srvr="server";Ref="QA";' }], defaults);
    assert.equal(rows.some((row: any) => state.folderAliases.includes(row.key)), false);
    assert.equal(value(rows, 'InfobasePath'), 'Srvr="server";Ref="QA";');
    assert.equal(state.requiredMissing('InfobasePath', rows), false);
});

test('a basename VanessaPath EPF resolves to the current folder in the webview', () => {
    const rows = loadState().normalize([{ key: 'VanessaPath', value: 'vanessa.epf' }], defaults);
    assert.equal(value(rows, 'VanessaFolder'), '.');
});

test('duplicate keys use the last stored value just as compiler JSON reader does', () => {
    const rows = loadState().normalize([
        { key: 'InfobasePath', value: 'Srvr="old";Ref="QA";' },
        { key: 'Infobase_Path', value: 'Srvr="new";Ref="QA";' }
    ], defaults);
    assert.equal(value(rows, 'Infobase_Path'), 'Srvr="new";Ref="QA";');
});

test('webview library arrays keep the compiler list delimiter when profiles are normalized', () => {
    const rows = loadState().normalize([{ key: 'VanessaLibraries', value: ['lib/one', 'lib/two'] }], defaults);
    assert.equal(value(rows, 'VanessaLibraries'), 'lib/one|lib/two');
});

const vanessaDefinitions = [
    { keys: ['ИспользоватьКомпонентуVanessaExt', 'useaddin'], keyOptions: ['ИспользоватьКомпонентуVanessaExt', 'useaddin'], valueKind: 'boolean', aliases: ['useaddin'], description: 'Control windows with VanessaExt.' },
    { keys: ['ВыполнениеСценариев.Пауза', 'ScenarioExecution.Delay', 'Пауза'], valueKind: 'number' },
    { keys: ['КаталогФич', 'featurepath'], valueKind: 'string' },
    { keys: ['ОтчетAllure', 'Allure'], valueKind: 'object' },
    { keys: ['ОтчетAllure.Метки', 'Allure.Labels', 'Метки'], valueKind: 'array' }
];
function editorHarness(parameters: Array<{ key: string; value: string }>, definitions: Array<{ key: string; fixed?: boolean; valueKind?: string; min?: number; max?: number; step?: number | string }> = [], additional: Array<{ key: string; value: string; overrideExisting?: boolean; valueKind?: string }> = []) {
    const documentRoot = parse(fs.readFileSync(path.join(process.cwd(), 'media/yamlParameters.html'), 'utf8'));
    const wrappers = new WeakMap<HtmlNode, DomElement>();
    class DomElement {
        listeners = new Map<string, Array<(event: any) => void>>();
        style: Record<string, string> = {};
        rect = { left: 800, right: 900, top: 100, bottom: 124, width: 100, height: 24 };
        constructor(readonly node: HtmlNode) {}
        get parentElement(): DomElement | undefined { return this.node.parentNode instanceof HtmlNode ? wrap(this.node.parentNode) : undefined; }
        hasAttribute(name: string) { return this.node.hasAttribute(name); }
        remove() { this.node.remove(); }
        getBoundingClientRect() { return this.id === 'priorityTooltip' ? { ...this.rect, width: 320, height: 96 } : this.rect; }
        get id() { return this.node.id; }
        get dataset() { return Object.fromEntries(Object.entries(this.node.attributes).filter(([name]) => name.startsWith('data-')).map(([name, item]) => [name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), item])); }
        get hidden() { return this.node.hasAttribute('hidden'); }
        set hidden(value: boolean) { value ? this.node.setAttribute('hidden', '') : this.node.removeAttribute('hidden'); }
        get readOnly() { return this.node.hasAttribute('readonly'); }
        get checked() { return this.node.hasAttribute('checked'); }
        set checked(value: boolean) { value ? this.node.setAttribute('checked', '') : this.node.removeAttribute('checked'); }
        get value() { return this.node.getAttribute('value') ?? (this.node.tagName === 'TEXTAREA' ? this.node.text : undefined) ?? this.node.querySelector('option[selected]')?.getAttribute('value') ?? this.node.querySelector('option')?.getAttribute('value') ?? ''; }
        set value(value: string) { this.node.setAttribute('value', value); }
        get innerHTML() { return this.node.innerHTML; }
        set innerHTML(value: string) { this.node.set_content(value); }
        get textContent() { return this.node.textContent; }
        set textContent(value: string) { this.node.set_content(value); }
        set title(value: string) { this.node.setAttribute('title', value); }
        get classList() {
            return {
                contains: (name: string) => this.node.classList.contains(name),
                add: (name: string) => this.node.classList.add(name),
                remove: (name: string) => this.node.classList.remove(name),
                toggle: (name: string, force?: boolean) => {
                    const enabled = force ?? !this.node.classList.contains(name);
                    enabled ? this.node.classList.add(name) : this.node.classList.remove(name);
                    return enabled;
                }
            };
        }
        querySelector(selector: string): DomElement | undefined { const found = this.node.querySelector(selector); return found ? wrap(found) : undefined; }
        querySelectorAll(selector: string): DomElement[] { return this.node.querySelectorAll(selector).map(wrap); }
        closest(selector: string): DomElement | undefined { const found = this.node.closest(selector); return found ? wrap(found) : undefined; }
        contains(element: DomElement): boolean { return element === this || this.node.querySelectorAll('*').includes(element.node); }
        get children() { return this.node.childNodes.filter((child): child is HtmlNode => child instanceof HtmlNode).map(wrap); }
        appendChild(child: DomElement) { this.node.appendChild(child.node); }
        setAttribute(name: string, value: string) { this.node.setAttribute(name, value); }
        toggleAttribute(name: string, value: boolean) { value ? this.node.setAttribute(name, '') : this.node.removeAttribute(name); }
        addEventListener(name: string, callback: (event: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
        fire(name: string, details = {}) { for (const callback of this.listeners.get(name) ?? []) { callback({ target: this, preventDefault() {}, stopPropagation() {}, ...details }); } }
        focus() {}
        select() {}
    }
    class Input extends DomElement {}
    class TextArea extends DomElement {}
    class Select extends DomElement {}
    class Button extends DomElement {}
    class Row extends DomElement {}
    function wrap(node: HtmlNode): DomElement {
        let value = wrappers.get(node);
        if (!value) {
            const Constructor = ({ INPUT: Input, SELECT: Select, TEXTAREA: TextArea, BUTTON: Button, TR: Row } as Record<string, typeof DomElement>)[node.tagName] ?? DomElement;
            value = new Constructor(node);
            wrappers.set(node, value);
        }
        return value;
    }
    const root = wrap(documentRoot);
    const body = root.querySelector('body')!;
    const documentListeners = new Map<string, Array<(event: any) => void>>();
    const windowListeners = new Map<string, Array<(event: any) => void>>();
    const messages: any[] = [];
    const timers: Array<() => void> = [];
    const element = (id: string) => root.querySelector(`#${id}`)!;
    const document = {
        body, getElementById: element, querySelector: root.querySelector.bind(root), querySelectorAll: root.querySelectorAll.bind(root),
        createElement: (tag: string) => wrap(parse(`<${tag}></${tag}>`).firstChild as HtmlNode),
        addEventListener: (name: string, callback: (event: any) => void) => documentListeners.set(name, [...(documentListeners.get(name) ?? []), callback])
    };
    const window = {
        innerWidth: 1000, innerHeight: 800,
        __buildParameters: parameters, __buildParameterDefinitions: definitions,
        __additionalParameters: additional, __vanessaParameterDefinitions: vanessaDefinitions,
        __fixedBuildParameterKeys: definitions.filter(item => item.fixed).map(item => item.key),
        __defaultBuildParameters: defaults, __activeProfileId: 'synthetic',
        __profiles: [{ id: 'synthetic', name: 'Synthetic', buildParameters: parameters, additionalVanessaParameters: additional, globalVanessaVariables: [] }],
        addEventListener: (name: string, callback: (event: any) => void) => windowListeners.set(name, [...(windowListeners.get(name) ?? []), callback])
    };
    const context = vm.createContext({
        window, document, HTMLElement: DomElement, HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: Select, HTMLButtonElement: Button, HTMLTableRowElement: Row,
        console: { log() {} }, setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout() {},
        acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (message: unknown) => messages.push(JSON.parse(JSON.stringify(message))) })
    });
    for (const file of ['yamlBuildParameterState.js', 'yamlParameters.js']) {
        vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'media', file), 'utf8'), context);
    }
    return {
        element, messages,
        dispatch: (name: string, target: DomElement, details = {}) => { for (const callback of documentListeners.get(name) ?? []) { callback({ target, preventDefault() {}, ...details }); } },
        windowEvent: (name: string) => { for (const callback of windowListeners.get(name) ?? []) { callback({}); } },
        row: (key: string) => element('buildParametersTableBody').querySelectorAll('tr').find(row => row.querySelector('.param-key')?.value === key)!,
        additionalRow: (key: string) => element('additionalParametersTableBody').querySelectorAll('tr').find(row => row.querySelector('.param-key')?.value === key)!,
        inputControl: (target: DomElement, text: string) => { target.value = text; for (const callback of documentListeners.get('input') ?? []) { callback({ target }); } },
        receive: (data: unknown) => { for (const callback of windowListeners.get('message') ?? []) { callback({ data }); } },
        focus: (target: DomElement) => { for (const callback of documentListeners.get('focusin') ?? []) { callback({ target }); } },
        input: (id: string, text: string) => {
            const target = element(id);
            target.value = text;
            for (const callback of documentListeners.get('input') ?? []) { callback({ target }); }
        },
        change: (target: DomElement, text: string) => {
            target.value = text;
            for (const callback of documentListeners.get('change') ?? []) { callback({ target }); }
        },
        runTimers: () => { while (timers.length) { timers.shift()!(); } }
    };
}

test('Priority help appears on hover and keyboard focus in both tables, with no native header tooltip', () => {
    const editor = editorHarness([]);
    for (const table of ['additionalParametersTable', 'globalVarsTable']) {
        const header = editor.element(table).querySelector('.priority-header')!;
        assert.equal(header.node.hasAttribute('title'), false);
        const heading = header.querySelector('.priority-heading')!;
        const button = header.querySelector('.priority-hint')!;
        const tooltip = editor.element('priorityTooltip');
        assert.ok(heading); assert.ok(button); assert.ok(tooltip);
        assert.equal(tooltip.hidden, true);
        assert.equal(tooltip.node.getAttribute('role'), 'tooltip');
        assert.equal(tooltip.closest('.table-container'), undefined, 'the table scroll container must not clip the tooltip');
        editor.dispatch('mouseover', heading);
        assert.equal(tooltip.hidden, false);
        editor.dispatch('mouseout', heading, { relatedTarget: button });
        assert.equal(tooltip.hidden, false, 'moving from the label to its icon retains the tooltip');
        editor.focus(button);
        editor.dispatch('mouseout', heading);
        assert.equal(tooltip.hidden, false, 'keyboard focus keeps the help visible');
        editor.dispatch('keydown', button, { key: 'Escape' });
        assert.equal(tooltip.hidden, true);
        editor.dispatch('focusout', button);
        editor.focus(button);
        assert.equal(tooltip.hidden, false);
        editor.windowEvent('resize');
        assert.equal(tooltip.hidden, true);
        editor.dispatch('focusout', button);
    }
});

test('model DB health refreshes on edits and file changes and ignores stale responses', () => {
    const editor = editorHarness([{ key: 'ModelDBSettings', value: 'bases.yaml' }]);
    const requests = () => editor.messages.filter((item: any) => item.command === 'inspectModelDbSettings') as Array<{ requestId: number; activeProfileId: string }>;
    const reply = (request: { requestId: number; activeProfileId: string }, message: string) => editor.receive({
        ...request, command: 'modelDbSettingsStatus', state: 'ready', message
    });
    editor.runTimers();
    const first = requests().at(-1)!;
    reply(first, 'One infobase');
    const status = editor.element('modelDbSettingsStatus');
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, 'One infobase');
    editor.inputControl(editor.row('ModelDBSettings').querySelector('.param-value')!, 'other.yaml');
    assert.equal(status.hidden, true);
    reply(first, 'Outdated catalog');
    assert.equal(status.hidden, true);
    editor.runTimers();
    const current = requests().at(-1)!;
    reply({ ...current, activeProfileId: 'another-profile' }, 'Wrong profile');
    assert.equal(status.hidden, true);
    reply(current, 'Two infobases');
    assert.equal(status.textContent, 'Two infobases');
    editor.receive({ command: 'refreshModelDbSettings' });
    assert.equal(status.hidden, true);
    editor.runTimers();
    assert.ok(requests().at(-1)!.requestId > current.requestId);
});

test('resetting ModelDBSettings refreshes health and its file watcher for the default path', () => {
    const editor = editorHarness([{ key: 'ModelDBSettings', value: 'custom.yaml' }], [{ key: 'ModelDBSettings', fixed: true }]);
    editor.runTimers();
    const first = editor.messages.filter((item: any) => item.command === 'inspectModelDbSettings').at(-1) as any;
    editor.receive({ ...first, command: 'modelDbSettingsStatus', state: 'ready', message: 'Custom catalog' });
    const status = editor.element('modelDbSettingsStatus');
    assert.equal(status.hidden, false);
    editor.dispatch('click', editor.row('ModelDBSettings').querySelector('.reset-row-btn')!);
    assert.equal(editor.row('ModelDBSettings').querySelector('.param-value')!.value, 'bases.yaml');
    assert.equal(status.hidden, true);
    editor.runTimers();
    const refreshed = editor.messages.filter((item: any) => item.command === 'inspectModelDbSettings').at(-1) as any;
    assert.ok(refreshed.requestId > first.requestId);
    assert.equal(refreshed.parameters.find((row: any) => row.key === 'ModelDBSettings').value, 'bases.yaml');
});

test('removing ModelDBid refreshes catalog health without retaining its previous filter', () => {
    const editor = editorHarness([{ key: 'ModelDBSettings', value: 'bases.yaml' }, { key: 'ModelDBid', value: 'missing' }]);
    editor.runTimers();
    const first = editor.messages.filter((item: any) => item.command === 'inspectModelDbSettings').at(-1) as any;
    editor.receive({ ...first, command: 'modelDbSettingsStatus', state: 'selectedBaseMissing', message: 'Missing selected base' });
    assert.equal(editor.element('modelDbSettingsStatus').hidden, false);
    editor.dispatch('click', editor.row('ModelDBid').querySelector('.remove-row-btn')!);
    assert.equal(editor.element('modelDbSettingsStatus').hidden, true);
    editor.runTimers();
    const refreshed = editor.messages.filter((item: any) => item.command === 'inspectModelDbSettings').at(-1) as any;
    assert.ok(refreshed.requestId > first.requestId);
    assert.equal(refreshed.parameters.some((row: any) => row.key === 'ModelDBid'), false);
});

test('Priority tooltip stays in the viewport near the right and bottom edges', () => {
    const editor = editorHarness([]);
    const trigger = editor.element('additionalParametersTable').querySelector('.priority-heading')!;
    assert.ok(trigger);
    trigger.rect = { left: 950, right: 990, top: 760, bottom: 784, width: 40, height: 24 };
    editor.dispatch('mouseover', trigger);
    const tooltip = editor.element('priorityTooltip');
    assert.equal(tooltip.hidden, false);
    assert.ok(Number.parseFloat(tooltip.style.left) >= 12);
    assert.ok(Number.parseFloat(tooltip.style.left) + 320 <= 988);
    assert.ok(Number.parseFloat(tooltip.style.top) + 96 < trigger.rect.top);
});

test('Vanessa fields use catalog types for saved aliases and nested paths while custom keys remain text', () => {
    const editor = editorHarness([], [], [
        { key: 'useaddin', value: 'true' }, { key: '/ScenarioExecution/Delay', value: '1.5' },
        { key: 'ОтчетAllure', value: '{"folder":"one"}' }, { key: 'Allure.Labels', value: '["one"]' },
        { key: 'featurepath', value: '123' }, { key: 'Custom', value: 'true' }
    ]);
    assert.equal(editor.additionalRow('useaddin').querySelector('.param-value')?.node.tagName, 'SELECT');
    assert.equal(editor.additionalRow('/ScenarioExecution/Delay').querySelector('.param-value')?.node.getAttribute('type'), 'number');
    assert.equal(editor.additionalRow('ОтчетAllure').querySelector('.param-value')?.node.tagName, 'TEXTAREA');
    assert.equal(editor.additionalRow('Allure.Labels').querySelector('.param-value')?.node.tagName, 'TEXTAREA');
    for (const key of ['featurepath', 'Custom']) { assert.equal(editor.additionalRow(key).querySelector('.param-value')?.node.getAttribute('type'), 'text'); }
});

test('unknown imported keys use their explicit JSON kinds, without guessing types for manually entered custom values', () => {
    const editor = editorHarness([], [], [
        { key: 'ImportedFlag', value: 'false', valueKind: 'boolean' }, { key: 'ImportedRows', value: '["one"]', valueKind: 'array' },
        { key: 'ManualFlag', value: 'false' }
    ]);
    assert.equal(editor.additionalRow('ImportedFlag').querySelector('.param-value')?.node.tagName, 'SELECT');
    assert.equal(editor.additionalRow('ImportedRows').querySelector('.param-value')?.node.tagName, 'TEXTAREA');
    assert.equal(editor.additionalRow('ManualFlag').querySelector('.param-value')?.node.getAttribute('type'), 'text');
});

test('version compatibility warnings update without deleting rows and stale responses from other profiles are ignored', () => {
    const editor = editorHarness([], [], [{ key: 'useaddin', value: 'true' }, { key: 'Custom', value: '42' }]);
    editor.receive({ command: 'vanessaParameterDefinitionsUpdated', activeProfileId: 'synthetic', revision: 0,
        catalogStatus: 'Vanessa sources: 1.2.001', definitions: [{ ...vanessaDefinitions[0], availability: 'unsupported' }] });
    const row = editor.additionalRow('useaddin');
    assert.equal(row.querySelector('.param-compatibility-warning')?.hidden, false);
    assert.equal(row.querySelector('.param-value')?.value, 'true');
    assert.equal(editor.additionalRow('Custom').querySelector('.param-compatibility-warning')?.hidden, true);
    editor.receive({ command: 'vanessaParameterDefinitionsUpdated', activeProfileId: 'another-profile', revision: 0,
        definitions: [{ ...vanessaDefinitions[0], availability: 'supported' }] });
    assert.equal(editor.additionalRow('useaddin').querySelector('.param-compatibility-warning')?.hidden, false);
    editor.receive({ command: 'vanessaParameterDefinitionsUpdated', activeProfileId: 'synthetic', revision: -1,
        definitions: [{ ...vanessaDefinitions[0], availability: 'supported' }] });
    assert.equal(editor.additionalRow('useaddin').querySelector('.param-compatibility-warning')?.hidden, false);
    editor.receive({ command: 'vanessaParameterDefinitionsUpdated', activeProfileId: 'synthetic', revision: 0,
        catalogStatus: 'Vanessa sources: 1.2.043', definitions: [{ ...vanessaDefinitions[0], availability: 'supported' }] });
    assert.equal(editor.additionalRow('useaddin').querySelector('.param-compatibility-warning')?.hidden, true);
});

test('editing typed Vanessa values schedules autosave with the selected boolean, number and multiline JSON', () => {
    const editor = editorHarness([], [], [
        { key: 'useaddin', value: 'true', overrideExisting: true }, { key: 'Пауза', value: '1' },
        { key: 'Allure.Labels', value: '[]' }
    ]);
    editor.change(editor.additionalRow('useaddin').querySelector('.param-value')!, 'false');
    editor.inputControl(editor.additionalRow('Пауза').querySelector('.param-value')!, '2.5');
    editor.inputControl(editor.additionalRow('Allure.Labels').querySelector('.param-value')!, '[\n  "first",\n  "second"\n]');
    editor.runTimers();
    const saved = editor.messages.filter(message => message.command === 'autoSaveParameters').at(-1);
    assert.deepEqual(saved?.profiles[0].additionalVanessaParameters, [
        { key: 'useaddin', value: 'false', valueKind: 'boolean', overrideExisting: true }, { key: 'Пауза', value: '2.5', valueKind: 'number', overrideExisting: false },
        { key: 'Allure.Labels', value: '[\n  "first",\n  "second"\n]', valueKind: 'array', overrideExisting: false }
    ]);
});

test('Vanessa selection shows its own description, type and alias in the resizable inspector', () => {
    const editor = editorHarness([], [], [{ key: 'useaddin', value: 'true' }]);
    editor.element('additionalTabBtn').fire('click');
    assert.equal(editor.element('parameterInspector').hidden, false);
    editor.focus(editor.additionalRow('useaddin').querySelector('.param-value')!);
    assert.equal(editor.element('parameterInspectorDescription').textContent, 'Control windows with VanessaExt.');
    assert.match(editor.element('parameterInspectorMeta').textContent, /boolean.*useaddin/);
    editor.element('globalVarsTabBtn').fire('click');
    assert.equal(editor.element('parameterInspector').hidden, true);
});

test('malformed imported typed values remain intact and show validation without losing their draft', () => {
    const editor = editorHarness([], [], [
        { key: 'useaddin', value: 'maybe' }, { key: 'Пауза', value: 'many' }, { key: 'Allure.Labels', value: '{}' }
    ]);
    for (const [key, value] of [['useaddin', 'maybe'], ['Пауза', 'many'], ['Allure.Labels', '{}']]) {
        const field = editor.additionalRow(key).querySelector('.param-value')!;
        assert.equal(field.value, value); assert.equal(field.node.getAttribute('aria-invalid'), 'true');
    }
    assert.equal(editor.additionalRow('Пауза').querySelector('.param-value')?.node.getAttribute('type'), 'text');
    editor.inputControl(editor.additionalRow('Allure.Labels').querySelector('.param-value')!, '[]');
    assert.equal(editor.additionalRow('Allure.Labels').querySelector('.param-value')?.node.getAttribute('aria-invalid'), 'false');
    editor.element('profilePickerBtn').fire('click');
    assert.equal(editor.messages.at(-1).profiles[0].additionalVanessaParameters[0].value, 'maybe');
});

test('imported JSON kinds survive property edits and a string in a boolean field is repaired only on selection', () => {
    const editor = editorHarness([], [], [
        { key: 'useaddin', value: 'false', valueKind: 'string' }, { key: 'Custom', value: '0', valueKind: 'string' },
        { key: 'Allure.Labels', value: '["one"]', valueKind: 'array' }
    ]);
    assert.equal(editor.additionalRow('useaddin').querySelector('.param-value')?.node.getAttribute('aria-invalid'), 'true');
    editor.change(editor.additionalRow('useaddin').querySelector('.param-value')!, 'true');
    editor.runTimers();
    const saved = editor.messages.filter(message => message.command === 'autoSaveParameters').at(-1);
    assert.deepEqual(saved.profiles[0].additionalVanessaParameters, [
        { key: 'useaddin', value: 'true', valueKind: 'boolean', overrideExisting: false },
        { key: 'Custom', value: '0', valueKind: 'string', overrideExisting: false },
        { key: 'Allure.Labels', value: '["one"]', valueKind: 'array', overrideExisting: false }
    ]);
});

test('added names are locked while equivalent language switches retain values, kinds and priority', () => {
    const editor = editorHarness([], [], [{ key: 'Custom', value: 'text' }, { key: 'ОтчетAllure', value: '{"name":"</textarea><script>bad</script>"}' },
        { key: 'useaddin', value: 'false', valueKind: 'string', overrideExisting: true }]);
    assert.equal(editor.additionalRow('Custom').querySelector('.param-key')?.readOnly, true);
    const field = editor.additionalRow('ОтчетAllure').querySelector('.param-value')!;
    assert.equal(field.node.tagName, 'TEXTAREA');
    assert.equal(field.value, '{"name":"</textarea><script>bad</script>"}');
    assert.equal(editor.additionalRow('ОтчетAllure').querySelector('script'), undefined);
    const selector = editor.additionalRow('useaddin').querySelector('.param-additional-key-select')!;
    assert.ok(selector);
    assert.deepEqual(selector.querySelectorAll('option').map(option => option.value), ['ИспользоватьКомпонентуVanessaExt', 'useaddin']);
    editor.change(selector, 'ИспользоватьКомпонентуVanessaExt');
    assert.equal(editor.additionalRow('ИспользоватьКомпонентуVanessaExt').querySelector('.param-value')?.value, 'false');
    assert.equal(editor.additionalRow('ИспользоватьКомпонентуVanessaExt').querySelector('.param-override')?.checked, true);
    editor.element('profilePickerBtn').fire('click');
    assert.equal(editor.messages.at(-1).profiles[0].additionalVanessaParameters.find((row: any) => row.key === 'ИспользоватьКомпонентуVanessaExt').valueKind, 'string');
    editor.receive({ command: 'appendAdditionalParameter', parameter: { key: 'useaddin', value: 'true' } });
    assert.equal(editor.element('additionalParametersTableBody').querySelectorAll('tr').length, 3, 'stale picker cannot append an equivalent name twice');
});

test('additional search recognizes either language and parameter hints do not contain catalog status', () => {
    const editor = editorHarness([], [], [{ key: 'useaddin', value: 'true' }, { key: 'Custom', value: 'false' }]);
    editor.element('additionalTabBtn').fire('click');
    editor.input('additionalSearchInput', 'ИспользоватьКомпонентуVanessaExt');
    assert.equal(editor.additionalRow('useaddin').hidden, false);
    assert.equal(editor.additionalRow('Custom').hidden, true);
    assert.equal(editor.additionalRow('useaddin').querySelector('.param-hint')?.node.getAttribute('title'), 'Control windows with VanessaExt.');
    const status = editor.element('parameterCatalogStatus');
    assert.ok(status.closest('#additionalTabPanel'));
    assert.equal(status.closest('#parameterInspector'), undefined);
    assert.ok(editor.additionalRow('useaddin').querySelector('.param-override')?.node.hasAttribute('title'));
});

test('Drive rows stay hidden during searches and remain present in exported profiles', () => {
    const editor = editorHarness([{ key: 'SplitFeatureFiles', value: 'True' }]);
    assert.equal(editor.row('SplitFeatureFiles').hidden, true);
    editor.input('buildSearchInput', 'SplitFeatureFiles');
    assert.equal(editor.row('SplitFeatureFiles').hidden, true);
    editor.element('createBuildFileBtn').fire('click');
    assert.equal(editor.messages.at(-1).buildParameters.find((item: any) => item.key === 'SplitFeatureFiles')?.value, 'True');
    const driveEditor = editorHarness([{ key: 'SplitFeatureFiles', value: 'True' }], [{ key: 'SplitFeatureFiles', valueKind: 'boolean' }]);
    assert.equal(driveEditor.row('SplitFeatureFiles').hidden, false);
});

test('catalog hides alternate aliases when their launch role is already represented', () => {
    const definitions = [{ key: 'LaunchDBFolder', fixed: true }, { key: 'TestClientDBPath', fixed: true }, { key: 'InfobasePath' }, { key: 'TestClientDB' }];
    const editor = editorHarness([{ key: 'InfobasePath', value: 'Srvr="server";Ref="QA";' }], definitions);
    const keys = editor.element('buildParameterCatalogList').querySelectorAll('button').map(button => button.dataset.key);
    assert.equal(keys.includes('TestClientDB'), false);
    assert.equal(keys.includes('InfobasePath'), false);
    const newEditor = editorHarness([], definitions);
    const newKeys = newEditor.element('buildParameterCatalogList').querySelectorAll('button').map(button => button.dataset.key);
    assert.equal(newKeys.includes('InfobasePath'), true);
});

test('managed compiler paths are read-only, excluded from picker and preserved in saved state', () => {
    const editor = editorHarness([{ key: 'ResultFile', value: 'synthetic/result.txt' }], [{ key: 'ResultFile' }, { key: 'LogFile' }, { key: 'ErrorFolder' }]);
    assert.equal(editor.row('ResultFile').querySelector('.param-value')?.readOnly, true);
    assert.equal(editor.row('ResultFile').querySelector('.remove-row-btn'), undefined);
    const keys = editor.element('buildParameterCatalogList').querySelectorAll('button').map(button => button.dataset.key);
    assert.equal(keys.some(key => ['ResultFile', 'LogFile', 'ErrorFolder'].includes(key)), false);
    editor.element('profilePickerBtn').fire('click');
    assert.equal(editor.messages.at(-1).profiles[0].buildParameters.find((item: any) => item.key === 'ResultFile')?.value, 'synthetic/result.txt');
});

test('changing the launch alias schedules auto-save for the selected key and retained value', () => {
    const definitions = [{ key: 'LaunchDBFolder', fixed: true }, { key: 'TestClientDBPath', fixed: true }];
    const editor = editorHarness([{ key: 'LaunchDBFolder', value: 'bases/qa' }], definitions);
    editor.change(editor.row('LaunchDBFolder').querySelector('.param-launch-key-select')!, 'TestClientDBPath');
    editor.runTimers();
    const saved = editor.messages.find(message => message.command === 'autoSaveParameters');
    assert.equal(saved?.profiles[0].buildParameters.find((item: any) => item.key === 'TestClientDBPath')?.value, 'bases/qa');
});


test('typed numeric definitions render native number fields with compiler bounds', () => {
    const editor = editorHarness([{ key: 'TestClientPort', value: '48000' }, { key: 'WaitWindowTime', value: '0.5' }], [
        { key: 'TestClientPort', valueKind: 'number', min: 1, max: 65535, step: 1 }, { key: 'WaitWindowTime', valueKind: 'number', min: 0, step: 'any' }
    ]);
    const port = editor.row('TestClientPort').querySelector('.param-value')!;
    assert.equal(port.node.getAttribute('type'), 'number'); assert.equal(port.node.getAttribute('min'), '1');
    assert.equal(port.node.getAttribute('max'), '65535'); assert.equal(port.node.getAttribute('step'), '1');
    assert.equal(editor.row('WaitWindowTime').querySelector('.param-value')?.node.getAttribute('step'), 'any');
});

test('opening typed rows preserves malformed numeric, Boolean and blank values until the user edits', () => {
    const parameters = [{ key: 'TestClientPort', value: 'not-a-port' }, { key: 'DebugMode', value: 'unknown-mode' }, { key: 'CreateJson', value: '' }, { key: 'CaptureScreen', value: 'Истина' }];
    const editor = editorHarness(parameters, [{ key: 'TestClientPort', valueKind: 'number', min: 1, max: 65535, step: 1 }, ...['DebugMode', 'CreateJson', 'CaptureScreen'].map(key => ({ key, valueKind: 'boolean' }))]);
    assert.equal(editor.row('TestClientPort').querySelector('.param-value')?.node.getAttribute('type'), 'text');
    editor.element('profilePickerBtn').fire('click');
    const saved = editor.messages.at(-1).profiles[0].buildParameters;
    for (const parameter of parameters) { assert.equal(saved.find((item: any) => item.key === parameter.key)?.value, parameter.value, parameter.key); }
});
