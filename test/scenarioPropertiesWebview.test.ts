import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

class Element {
    children: Element[] = [];
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    listeners = new Map<string, Array<(event: any) => void>>();
    parentElement?: Element;
    tagName: string;
    className = '';
    textContent = '';
    value = '';
    disabled = false;
    readOnly = false;
    open = false;
    hidden = false;
    title = '';
    type = '';
    id = '';
    draggable = false;
    clientWidth = 0;
    scrollWidth = 0;
    style = { setProperty: (key: string, value: string) => { this.attributes[key] = value; } };
    selectionStart = 0;
    selectionEnd = 0;
    onFocus?: (element: Element) => void;
    classList = {
        add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); },
        remove: (...names: string[]) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        toggle: (name: string, force: boolean) => { if (force) { this.classList.add(name); } else { this.classList.remove(name); } }
    };
    constructor(tagName = 'div') { this.tagName = tagName.toUpperCase(); }
    set innerHTML(_value: string) { throw new Error('Unsafe HTML interpolation'); }
    append(...children: Element[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    prepend(...children: Element[]) { for (const child of children) { child.parentElement = this; } this.children.unshift(...children); }
    appendChild(child: Element) { this.append(child); return child; }
    replaceChildren(...children: Element[]) { for (const child of this.children) { child.parentElement = undefined; } this.children = []; this.append(...children); }
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
    getAttribute(name: string) { return this.attributes[name]; }
    addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
    contains(element: Element): boolean { return this === element || this.children.some(child => child.contains(element)); }
    focus() { this.onFocus?.(this); }
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
    fire(name: string, fields: Record<string, unknown> = {}) {
        const event = { target: this, preventDefault() {}, stopPropagation() {}, ...fields };
        for (const listener of this.listeners.get(name) ?? []) { listener(event); }
    }
}

function nodes(root: Element): Element[] { return [root, ...root.children.flatMap(nodes)]; }
function textOf(root: Element): string { return nodes(root).map(node => node.textContent).join(' '); }

function loadProtocol() {
    const context = { module: { exports: {} as any } };
    const file = path.join(process.cwd(), 'media/scenarioPropertiesProtocol.js');
    if (fs.existsSync(file)) { vm.runInNewContext(fs.readFileSync(file, 'utf8'), context); }
    return context.module.exports;
}

test('navigation remains serialized without reporting pending changes', () => {
    const api = loadProtocol(); const messages: any[] = []; const pending: boolean[] = [];
    const client = api.createClient({ postMessage: (value: any) => messages.push(value), onPending: (value: boolean) => pending.push(value) });
    client.setState(snapshot()); client.action('openSource');
    assert.equal(client.isPending(), false); assert.equal(pending.at(-1), false);
    client.enqueue({ command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 3, edit: { section: 'ДанныеСценария', field: 'Проект', value: 'New' } });
    assert.equal(client.isPending(), true); assert.equal(messages.length, 1);
    client.setState(snapshot()); assert.equal(messages.length, 2); assert.equal(messages.at(-1).command, 'edit');
});

function harness(saved: any = {}, options: { animate?: boolean; reducedMotion?: boolean; frames?: boolean } = {}) {
    const messages: any[] = [];
    const persisted: any[] = [];
    const animations: any[] = [];
    const frames: Array<() => void> = [];
    const root = new Element(); root.id = 'scenario-properties';
    const body = new Element('body'); body.append(root);
    const listeners = new Map<string, (event: any) => void>();
    const document: any = {
        body, activeElement: null,
        getElementById: (id: string) => nodes(body).find(node => node.id === id) ?? null,
        createElement: (tag: string) => {
            const element = new Element(tag);
            if (options.animate) {
                Object.defineProperty(element, 'offsetHeight', { get: () => element.open ? 140 : 32 });
                (element as any).getBoundingClientRect = () => ({ height: element.open ? 140 : 32 });
                (element as any).animate = (frames: any, animationOptions: any) => {
                    const animation: any = { element, frames, options: animationOptions, onfinish: null, cancelled: false,
                        cancel() { this.cancelled = true; } };
                    animations.push(animation); return animation;
                };
            }
            element.onFocus = node => { document.activeElement = node; };
            return element;
        }
    };
    const window: any = { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn), matchMedia: () => ({ matches: options.reducedMotion === true }) };
    if (options.frames) { window.requestAnimationFrame = (fn: () => void) => frames.push(fn); }
    const vscode = {
        postMessage: (message: any) => messages.push(JSON.parse(JSON.stringify(message))),
        getState: () => saved,
        setState: (state: any) => persisted.push(JSON.parse(JSON.stringify(state)))
    };
    const context = { window, document, acquireVsCodeApi: () => vscode, console, setTimeout, clearTimeout, btoa, navigator: { clipboard: { writeText: () => Promise.resolve() } } };
    for (const name of ['scenarioPropertiesProtocol.js', 'scenarioFilesProtocol.js', 'featureProperties.js', 'scenarioProperties.js']) {
        const file = path.join(process.cwd(), 'media', name);
        if (fs.existsSync(file)) { vm.runInNewContext(fs.readFileSync(file, 'utf8'), context); }
    }
    const message = (value: any) => listeners.get('message')?.({ data: value });
    const state = (value: any) => message({ command: 'state', state: value });
    const find = (predicate: (node: Element) => boolean) => nodes(root).find(predicate);
    const field = (name: string, extra: Record<string, string> = {}) => find(node => ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)
        && node.dataset.field === name && Object.entries(extra).every(([key, value]) => node.dataset[key] === value));
    const action = (name: string, extra: Record<string, string> = {}) => find(node => node.tagName === 'BUTTON'
        && node.dataset.action === name && Object.entries(extra).every(([key, value]) => node.dataset[key] === value));
    return { root, messages, persisted, document, state, message, field, action, find, animations, frames };
}

function snapshot() {
    return {
        source: { uri: 'file:///scenario.yml', version: 3, model: {
            kind: 'scenario', title: '<img src=x onerror=alert(1)>',
            header: [{ key: 'Имя', value: 'Checkout', readonly: true }, { key: 'Код', value: 'SMOKE', readonly: true }, { key: 'UID', value: 'scenario-uid', readonly: true }],
            sections: [
                { key: 'ПараметрыСценария', records: [
                    { key: 'customer', fields: [{ key: 'Имя', value: 'Customer' }, { key: 'Тип', value: 'Строка', choices: ['Строка', 'Таблица'] }, { key: 'Значение', value: '<script>bad()</script>', multiline: true }] },
                    { key: 'amount', fields: [{ key: 'Имя', value: 'Amount' }, { key: 'Значение', value: '10' }] }
                ] },
                { key: 'ВложенныеСценарии', records: [{ key: 'nested-uid', fields: [{ key: 'UIDВложенныйСценарий', value: 'nested-uid' }, { key: 'Имя', value: 'Nested' }] }] },
                { key: 'ТегиСценария', records: [{ key: 'tag-smoke', fields: [{ key: 'Имя', value: '@smoke' }] }] }
            ]
        } },
        settings: [
            { uri: 'file:///settings-a.yml', label: 'Main settings', version: 4, model: { kind: 'test', title: 'Main settings', header: [{ key: 'База', value: 'main' }], sections: [{ key: 'ТегиТеста', records: [{ key: 'tag-ci', fields: [{ key: 'Имя', value: '@ci' }] }] }] } },
            { uri: 'file:///settings-b.yml', label: 'Other settings', version: 7, model: { kind: 'test', title: 'Other settings', header: [{ key: 'База', value: 'other' }], sections: [{ key: 'ПараметрыТеста', records: [{ key: 'override', fields: [{ key: 'Значение', value: '42' }] }] }] } }
        ],
        selectedSettingsUri: 'file:///settings-b.yml',
        metadata: { uri: 'file:///scenario.yml.kot.yml', version: 2, values: { groupId: 'smoke', order: 1, description: 'Existing description', category: 'UI' } },
        groups: [{ id: 'smoke', name: 'Smoke tests' }, { id: 'regression', name: '<b>Regression</b>' }],
        pinned: false, dirty: false,
        labels: { header: 'Header', save: 'Save test', metadata: 'KOT metadata', groupId: 'Group', addRecord: 'Add row', parameterConsequences: 'Renaming or removing a parameter only changes this file.' }
    };
}

test('parameter previews and attachment names use a measured scrolling fade', () => {
    const h = harness(); h.state(snapshot());
    h.message({ command: 'scenarioPropertiesFiles', sourceUri: 'file:///scenario.yml', paths: ['Fixtures/a-very-long-file-name.csv'] });
    for (const text of ['Customer', '<script>bad()</script>', 'Fixtures/a-very-long-file-name.csv']) {
        const content = h.find(node => node.textContent === text && node.parentElement?.className.includes('properties-scroll-title'));
        assert.ok(content, `${text} must have a scrolling caption`);
        const viewport = content.parentElement!; viewport.clientWidth = 80; content.scrollWidth = 180;
        viewport.fire('mouseenter');
        assert.ok(viewport.className.includes('is-overflowing'));
        assert.equal(viewport.attributes['--properties-scroll-distance'], '100px');
    }
    assert.doesNotMatch(fs.readFileSync(path.join(process.cwd(), 'media/scenarioProperties.css'), 'utf8'), /\.properties-scroll-title[^}]*text-overflow:\s*ellipsis/u);
});

test('native dropdowns have no scrolling mirror while text edits keep their original control', () => {
    const h = harness(); h.state(snapshot());
    const group = h.field('groupId')!;
    const wrapper = group.parentElement!;
    assert.equal(wrapper.className.includes('properties-overflow-control'), false);
    assert.equal(nodes(wrapper).some(node => node.className.includes('properties-control-preview')), false);
    group.value = 'regression'; group.fire('change');
    assert.equal(h.messages.at(-1).value, 'regression');
    const code = h.field('Код')!;
    code.readOnly = false; code.value = 'NEW'; code.fire('input');
    assert.ok(nodes(code.parentElement!).some(node => node.textContent === 'NEW'));
});

test('filling process defaults sends selected settings and both source revisions', () => {
    const h = harness(); const state: any = snapshot();
    state.source.model.kind = 'process'; state.settings[1].model.kind = 'processTest';
    h.state(state); h.action('testSettings')!.fire('click');
    const button = h.action('fillProcessDefaults')!; assert.ok(button);
    button.fire('click');
    assert.equal(h.messages.at(-1).command, 'fillProcessDefaults');
    assert.equal(h.messages.at(-1).documentUri, 'file:///settings-b.yml');
    assert.equal(h.messages.at(-1).documentVersion, 7); assert.equal(h.messages.at(-1).sourceVersion, 3);
    const scenario = harness(); scenario.state(snapshot()); scenario.action('testSettings')!.fire('click');
    assert.equal(scenario.action('fillProcessDefaults'), undefined);
});

test('a queued process fill uses the revision after preceding default edits have completed', () => {
    const protocol = loadProtocol(); const messages: any[] = [];
    const client = protocol.createClient({ postMessage: (message: any) => messages.push(message) });
    const state: any = snapshot(); state.source.model.kind = 'process'; client.setState(state);
    client.enqueue({ command: 'edit', documentUri: state.source.uri, documentVersion: 3,
        edit: { section: 'ПараметрыСценария', recordKey: 'customer', field: 'Значение', value: 'NEW' } });
    client.enqueue({ command: 'fillProcessDefaults', documentUri: 'file:///settings-b.yml', documentVersion: 7,
        sourceVersion: 3, target: { section: 'ПараметрыТеста' } });
    assert.equal(messages.length, 1);
    state.source.version = 4; client.setState(state);
    assert.equal(messages[1].command, 'fillProcessDefaults'); assert.equal(messages[1].sourceVersion, 4);
});

test('left fade follows actual movement and stops measuring when the transition ends', () => {
    const h = harness({}, { frames: true }); h.state(snapshot());
    const content = h.find(node => node.textContent === 'Customer' && node.parentElement?.className.includes('properties-scroll-title'))!;
    const viewport = content.parentElement!; viewport.clientWidth = 80; content.scrollWidth = 180;
    let movement = 0;
    (viewport as any).getBoundingClientRect = () => ({ left: 100, right: 180 });
    (content as any).getBoundingClientRect = () => ({ left: 100 - movement, right: 280 - movement });
    viewport.fire('mouseenter');
    assert.equal(viewport.className.includes('is-scrolled'), false);
    assert.equal(viewport.className.includes('is-more-right'), true);
    h.frames.splice(0).forEach(frame => frame());
    content.fire('transitionstart', { propertyName: 'transform' });
    h.frames.splice(0).forEach(frame => frame());
    assert.equal(viewport.className.includes('is-scrolled'), false);
    movement = 2; h.frames.splice(0).forEach(frame => frame());
    assert.equal(viewport.className.includes('is-scrolled'), true);
    movement = 100; h.frames.splice(0).forEach(frame => frame());
    assert.equal(viewport.className.includes('is-more-right'), false);
    movement = 0; content.fire('transitionend', { propertyName: 'transform' });
    h.frames.splice(0).forEach(frame => frame());
    assert.equal(viewport.className.includes('is-scrolled'), false);
    assert.equal(h.frames.length, 0);
});

test('the compiler variant limit warning remains visible while combinations are collapsed', () => {
    const h = harness(); const state: any = snapshot();
    state.source.model.sections[0].fields = [{ key: 'Parameter combinations', value: '101\nPreview', readonly: true }];
    state.variantLimitWarning = { count: '101', limit: 100 }; h.state(state);
    const preview = h.find(node => node.className === 'properties-combinations')!;
    assert.equal(preview.open, false);
    const warning = h.find(node => node.className === 'properties-warning')!;
    assert.match(warning.textContent, /100.*101/u); assert.equal(warning.attributes.role, 'status');
    assert.equal(preview.contains(warning), false);
    state.variantLimitWarning = null; h.state(state);
    assert.equal(h.find(node => node.className === 'properties-warning'), undefined);
});

test('pin visibly changes its icon and active styling', () => {
    const h = harness(); const state: any = snapshot(); h.state(state);
    assert.ok(h.action('pin')!.children.some(node => node.className.includes('codicon-pin')));
    state.pinned = true; h.state(state);
    assert.ok(h.action('pin')!.className.includes('is-active'));
    assert.ok(h.action('pin')!.children.some(node => node.className.includes('codicon-pinned')));
});

test('save, fold and pin share their own toolbar while status follows kind under the heading', () => {
    const h = harness(); h.state(snapshot()); const fold = h.action('openText')!; const pin = h.action('pin')!;
    assert.equal(fold.parentElement, pin.parentElement);
    assert.equal(fold.parentElement, h.action('save')!.parentElement);
    const status = h.find(node => node.attributes.role === 'status')!;
    assert.ok(status.parentElement?.className.includes('properties-meta-row'));
    assert.ok(status.parentElement?.children.some(node => node.className === 'properties-kind'));
    assert.ok(status.parentElement?.children.some(node => node.className === 'properties-meta-separator'));
    assert.equal(fold.textContent, ''); assert.ok(fold.children.some(child => child.className.includes('codicon-fold')));
    assert.equal(fold.attributes['aria-label'], 'Fold service sections');
});

test('file actions and YAML navigation have visible captions in aligned toolbars', () => {
    const h = harness(); h.state(snapshot());
    assert.match(textOf(h.action('openSource')!), /Open YAML/u);
    assert.match(textOf(h.action('copyPath')!), /Copy path/u);
    assert.match(textOf(h.action('revealAttachments')!), /Open folder/u);
    assert.match(textOf(h.action('addAttachments')!), /Add files/u);
});

test('Properties attachments show a recursive list and drag only the file name to the editor', () => {
    const h = harness(); h.state(snapshot());
    h.message({ command: 'scenarioPropertiesFiles', sourceUri: 'file:///scenario.yml', itemId: 'file:///scenario.yml', rootUri: 'file:///files', paths: ['Fixtures/Data.csv'] });
    const row = h.find(node => node.dataset.relativePath === 'Fixtures/Data.csv' && node.draggable)!;
    assert.ok(row); assert.ok(nodes(row).some(node => node.textContent === 'Fixtures/Data.csv'));
    const payload = new Map(); row.fire('dragstart', { dataTransfer: { setData: (key: string, value: string) => payload.set(key, value) } });
    assert.equal(payload.get('text/plain'), 'Data.csv');
    h.action('openAttachment')!.fire('click');
    assert.deepEqual(h.messages.at(-1), { command: 'openScenarioFile', sourceUri: 'file:///scenario.yml', itemId: 'file:///scenario.yml', relativePath: 'Fixtures/Data.csv' });
    h.message({ command: 'scenarioPropertiesFiles', sourceUri: 'file:///foreign.yml', paths: ['Foreign.csv'] });
    assert.equal(h.find(node => node.dataset.relativePath === 'Foreign.csv'), undefined);
});

test('Files has its own counted tab, keeps selection on refresh and accepts drops on another tab', async () => {
    const h = harness(); const state = snapshot(); h.state(state);
    const properties = h.find(node => node.id === 'properties-tab-content')!;
    assert.equal(nodes(properties).some(node => node.dataset.section === 'files'), false);
    const files = h.find(node => node.id === 'files-tab-content')!; const tab = h.action('files')!;
    assert.ok(files); assert.equal(files.hidden, true); assert.equal(tab.getAttribute('aria-controls'), files.id);
    h.message({ command: 'scenarioPropertiesFiles', sourceUri: state.source.uri, paths: ['A.csv', 'folder/B.csv'] });
    assert.equal(nodes(tab).find(node => node.className === 'properties-tab-count')?.textContent, '2');
    tab.fire('click'); assert.equal(files.hidden, false); assert.equal(properties.hidden, true);
    h.state(state); assert.equal(h.action('files')!.getAttribute('aria-selected'), 'true');
    h.action('properties')!.fire('click');
    h.root.fire('drop', { dataTransfer: { types: ['text/uri-list'], getData: () => 'file:///tmp/C.csv' } });
    assert.equal(h.messages.at(-1).command, 'addScenarioFilesFromUris');
    h.action('files')!.fire('keydown', { key: 'Home' }); assert.equal(h.action('properties')!.getAttribute('aria-selected'), 'true');
    h.action('properties')!.fire('keydown', { key: 'End' }); assert.equal(h.action('files')!.getAttribute('aria-selected'), 'true');
});

test('the whole Properties area accepts external file and Explorer URI drops', async () => {
    const h = harness(); h.state(snapshot());
    h.root.fire('drop', { target: h.field('Код'), dataTransfer: { types: ['Files'], files: [{ name: 'Data.csv', size: 3 }], items: [] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.messages.at(-1).command, 'prepareScenarioFileDrop'); assert.equal(h.messages.at(-1).sourceUri, 'file:///scenario.yml');
    assert.deepEqual(h.messages.at(-1).entries, [{ clientPath: 'Data.csv', kind: 'file', size: 3 }]);
    h.root.fire('drop', { dataTransfer: { types: ['text/uri-list'], files: [], getData: () => '#comment\r\nfile:///tmp/Other.csv\r\n' } });
    assert.deepEqual(h.messages.at(-1), { command: 'addScenarioFilesFromUris', sourceUri: 'file:///scenario.yml', itemId: 'file:///scenario.yml', uris: ['file:///tmp/Other.csv'] });
});

test('attachment upload acknowledgements send ordered chunks and keep their source identity', async () => {
    const h = harness(); h.state(snapshot());
    const file = { name: 'Data.csv', size: 3, slice: () => ({ arrayBuffer: async () => new Uint8Array([97, 98, 99]).buffer }) };
    h.root.fire('drop', { dataTransfer: { types: ['Files'], files: [file] } }); await new Promise(resolve => setImmediate(resolve));
    const drop = h.messages.at(-1);
    h.message({ command: 'scenarioFileDropPrepared', sourceUri: drop.sourceUri, dropId: drop.dropId,
        files: [{ clientPath: 'Data.csv', transferId: 'upload-1' }] }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.messages.at(-1), { command: 'appendScenarioFileChunk', sourceUri: drop.sourceUri, transferId: 'upload-1', offset: 0, base64: 'YWJj' });
    h.message({ command: 'scenarioFileChunkAccepted', sourceUri: drop.sourceUri, transferId: 'upload-1', nextOffset: 3 });
    assert.deepEqual(h.messages.at(-1), { command: 'completeScenarioFileTransfer', sourceUri: drop.sourceUri, transferId: 'upload-1' });
});

test('Explorer drops with an empty Files payload fall back to the URI list', async () => {
    const h = harness(); h.state(snapshot());
    h.root.fire('drop', { dataTransfer: { types: ['Files', 'text/uri-list'], files: [], getData: () => 'file:///tmp/Data.csv' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.messages.at(-1).command, 'addScenarioFilesFromUris'); assert.deepEqual(h.messages.at(-1).uris, ['file:///tmp/Data.csv']);
});

test('process steps are collapsed editable groups with hover open/delete and drag order', () => {
    const h = harness(); const state: any = snapshot(); state.source.model.kind = 'process';
    state.source.model.sections = [{ key: 'ШагиПроцесса', records: [{ key: 'step-a', fields: [
        { key: 'UID', value: 'uid-a' }, { key: 'Наименование', value: 'Approve order' }, { key: 'ИсполнительНаименование', value: 'Administrator' }
    ] }, { key: 'step-b', fields: [{ key: 'Наименование', value: 'Ship order' }] }] }];
    h.state(state);
    const row = h.find(node => node.tagName === 'DETAILS' && node.dataset.recordKey === 'step-a')!;
    assert.ok(row); assert.equal(row.open, false); assert.equal(row.draggable, true);
    assert.equal(row.children[0].tagName, 'SUMMARY'); assert.equal(nodes(row.children[0]).find(node => node.className.includes('properties-record-title'))?.textContent, 'Approve order');
    assert.equal(h.action('moveUp', { section: 'ШагиПроцесса' }), undefined); assert.equal(h.action('moveDown', { section: 'ШагиПроцесса' }), undefined);
    assert.ok(h.action('openReference')!.className.includes('hover-action')); assert.ok(h.action('removeRecord')!.className.includes('hover-action'));
    assert.equal(h.field('ИсполнительНаименование', { recordKey: 'step-a' })?.value, 'Administrator');
    row.open = true; row.fire('toggle'); h.state(state);
    assert.equal(h.find(node => node.tagName === 'DETAILS' && node.dataset.recordKey === 'step-a')!.open, true);
});

test('source actions and path belong to Properties, settings have no duplicate settings group', () => {
    const h = harness(); h.state(snapshot());
    const toolbar = h.find(node => node.className === 'properties-toolbar')!;
    assert.equal(nodes(toolbar).some(node => node.dataset.action === 'openSource'), false);
    assert.equal(nodes(toolbar).some(node => node.className === 'properties-path'), false);
    const properties = h.find(node => node.id === 'properties-tab-content')!;
    assert.ok(nodes(properties).some(node => node.dataset.action === 'openSource'));
    assert.ok(nodes(properties).some(node => node.dataset.action === 'copyPath'));
    assert.equal(nodes(properties).some(node => node.className.includes('properties-path')), false);
    const settings = h.find(node => node.id === 'settings-tab-content')!;
    assert.equal(nodes(settings).some(node => node.tagName === 'DETAILS' && node.dataset.section === 'testSettings'), false);
    assert.doesNotMatch(textOf(h.root), /Renaming.*bracket references|Declarations do not change execution order/);
});

test('parameters start collapsed with name/default/count in the summary and fields inside', () => {
    const h = harness(); const state: any = snapshot();
    state.source.model.sections[0].records[1].usages = 3; h.state(state);
    const row = h.find(node => node.dataset.recordKey === 'amount' && node.tagName === 'DETAILS')!;
    assert.ok(row); assert.equal(row.open, false);
    assert.equal(row.children[0].tagName, 'SUMMARY'); assert.match(textOf(row.children[0]), /Amount.*10.*3 ×/);
    assert.ok(h.field('Значение', { recordKey: 'amount' }));
    row.open = true; row.fire('toggle'); h.state(state);
    assert.equal(h.find(node => node.dataset.recordKey === 'amount' && node.tagName === 'DETAILS')!.open, true);
});

test('tag title is directly editable, arrow buttons are removed and deletion is a hover action', () => {
    const h = harness(); h.state(snapshot());
    const tag = h.field('Имя', { section: 'ТегиСценария', recordKey: 'tag-smoke' })!;
    assert.ok(tag); assert.ok(h.find(node => node.className.includes('properties-tag-heading') && node.contains(tag)));
    assert.equal(h.action('moveUp', { section: 'ТегиСценария' }), undefined);
    assert.equal(h.action('moveDown', { section: 'ТегиСценария' }), undefined);
    assert.ok(h.action('removeRecord', { section: 'ТегиСценария' })!.className.includes('hover-action'));
    tag.value = 'regression'; tag.fire('change'); assert.equal(h.messages.at(-1).edit.value, 'regression');
});

test('nested opening precedes the count and is a hover action with scrolling title', () => {
    const h = harness(); const state: any = snapshot(); state.source.model.sections[1].records[0].usages = 2; h.state(state);
    const heading = h.find(node => node.className === 'properties-record-heading' && node.parentElement?.dataset.section === 'ВложенныеСценарии')!;
    assert.ok(heading.children.at(-1)!.className.includes('properties-usage'));
    assert.ok(h.action('openReference')!.className.includes('hover-action'));
    assert.ok(h.find(node => node.className.includes('properties-scroll-title')));
});

test('generated lists show usage counts and rename but no structural controls or raw identifiers', () => {
    const h = harness(); const state: any = snapshot();
    state.autoFill = { parameters: true, nested: true };
    state.source.model.sections[0].records[0].usages = 4;
    state.source.model.sections[0].records[0].fields.push({ key: 'НомерСтроки', value: '1' });
    state.source.model.sections[1].records[0].usages = 2;
    state.source.model.sections[1].records[0].fields.push({ key: 'ИмяСценария', value: 'Nested' });
    h.state(state);
    assert.equal(h.field('UID'), undefined); assert.equal(h.field('UIDВложенныйСценарий'), undefined);
    assert.equal(h.field('НомерСтроки'), undefined); assert.equal(h.field('ИмяСценария'), undefined);
    assert.ok(h.field('Имя', { recordKey: 'customer' }));
    assert.equal(h.action('removeRecord', { section: 'ПараметрыСценария' }), undefined);
    assert.equal(h.action('moveUp', { section: 'ВложенныеСценарии' }), undefined);
    assert.equal(h.action('addNested'), undefined); assert.equal(h.action('fillParameters'), undefined);
    assert.equal(h.find(node => node.draggable && node.dataset.section === 'ПараметрыСценария'), undefined);
    assert.match(textOf(h.root), /4 ×/); assert.match(textOf(h.root), /2 ×/);
    state.autoFill = { parameters: false, nested: false }; h.state(state);
    assert.ok(h.action('fillParameters')); assert.ok(h.action('fillNested'));
    h.action('fillNested')!.fire('click');
    assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'fillNested' });
});

test('metadata follows Header, tags follow Nested scenarios and settings use accessible tabs', () => {
    const h = harness(); h.state(snapshot());
    const content = h.find(node => node.id === 'properties-tab-content')!;
    assert.deepEqual(content.children.map(node => node.dataset.section).filter(Boolean), ['ДанныеСценария', 'metadata', 'ПараметрыСценария', 'ВложенныеСценарии', 'ТегиСценария']);
    const settings = h.find(node => node.id === 'settings-tab-content')!;
    assert.equal(settings.hidden, true);
    const tab = h.action('testSettings')!; tab.fire('click');
    assert.equal(settings.hidden, false); assert.equal(content.hidden, true);
    assert.equal(tab.getAttribute('aria-selected'), 'true');
    tab.fire('keydown', { key: 'ArrowLeft' });
    assert.equal(content.hidden, false);
});

test('system function uses descriptive options and stock catalogs use native selects with inline creation', () => {
    const h = harness(); const state: any = snapshot();
    state.source.model.header.push({ key: 'ФункцияСистемы', value: 'fn-uid', action: 'systemFunction', choices: ['fn-uid', 'other-uid'], choiceLabels: { 'fn-uid': 'Sales', 'other-uid': 'Purchases' } }, { key: 'Проект', value: 'Drive', suggestions: ['Drive', 'Other project'] });
    h.state(state);
    const system = h.field('ФункцияСистемы')!; assert.equal(system.tagName, 'SELECT');
    assert.deepEqual(system.children.map(option => option.textContent), ['Sales', 'Purchases']);
    const project = h.field('Проект')!; assert.equal(project.tagName, 'SELECT');
    assert.equal(project.children.at(-1)?.value, '__kot_create_choice__');
    system.value = 'other-uid'; system.fire('change');
    assert.equal(h.messages.at(-1).edit.value, 'other-uid');
});

test('properties protocol queues edits and rebases each request onto its acknowledged document revision', () => {
    const api = loadProtocol();
    assert.equal(typeof api.createClient, 'function');
    const messages: any[] = [];
    const client = api.createClient({ postMessage: (message: any) => messages.push(JSON.parse(JSON.stringify(message))) });
    client.setState(snapshot());
    client.enqueue({ command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 3, edit: { section: 'ПараметрыСценария', recordKey: 'customer', field: 'Имя', value: 'New customer' } });
    client.enqueue({ command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 3, edit: { section: 'ПараметрыСценария', recordKey: 'amount', field: 'Значение', value: '20' } });
    assert.equal(messages.length, 1);
    assert.equal(client.isPending(), true);
    const next = snapshot(); next.source.version = 4;
    client.setState(next);
    assert.deepEqual(messages[1], { command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 4, edit: { section: 'ПараметрыСценария', recordKey: 'amount', field: 'Значение', value: '20' } });
    client.setState({ ...next, error: 'Document changed. Reopen source.' });
    assert.equal(client.isPending(), false);
});

test('an unsolicited visibility/enrichment state never releases another edit before the mutation acknowledgement', () => {
    const api = loadProtocol(); const messages: any[] = [];
    const client = api.createClient({ postMessage: (message: any) => messages.push(message) });
    client.setState(snapshot());
    for (const value of ['First', 'Second']) {
        client.enqueue({ command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 3,
            edit: { section: 'ПараметрыСценария', recordKey: 'amount', field: 'Значение', value } });
    }
    client.setState(snapshot(), false); assert.equal(messages.length, 1); assert.equal(client.isPending(), true);
    const acknowledged = snapshot(); acknowledged.source.version = 4;
    client.setState(acknowledged, true); assert.equal(messages.length, 2); assert.equal(messages[1].documentVersion, 4);
});

test('an unsolicited URI move rebases queued edits without acknowledging the active mutation', () => {
    const api = loadProtocol(); const messages: any[] = []; const moves: any[] = [];
    const client = api.createClient({ postMessage: (message: any) => messages.push(message), onMove: (value: any) => moves.push(value) });
    client.setState(snapshot());
    for (const value of ['First', 'Second']) {
        client.enqueue({ command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 3,
            edit: { section: 'ПараметрыСценария', recordKey: 'amount', field: 'Значение', value } });
    }
    const next: any = snapshot(); next.source.uri = 'file:///new/scenario.yml'; next.source.version = 4;
    next.uriMoves = [{ oldUri: 'file:///scenario.yml', newUri: next.source.uri }];
    client.setState(next, false); assert.equal(messages.length, 1); assert.equal(client.isPending(), true); assert.equal(moves.length, 1);
    client.setState(next, true); assert.equal(messages.length, 2);
    assert.equal(messages[1].documentUri, next.source.uri); assert.equal(messages[1].documentVersion, 4);
});

test('properties protocol rejects malformed mutations and refuses to send edits to unbound documents', () => {
    const api = loadProtocol();
    assert.equal(typeof api.validateMessage, 'function');
    assert.equal(api.validateMessage({ command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 1, edit: { section: 'ПараметрыСценария', field: 'Имя', value: 1 } }), false);
    assert.equal(api.validateMessage({ command: 'moveRecord', documentUri: 'file:///scenario.yml', documentVersion: -1, target: { section: 'ПараметрыСценария', recordKey: 'customer', beforeRecordKey: null } }), false);
    assert.equal(api.validateMessage({ command: 'action', action: 'executeScript' }), false);
    const messages: any[] = [];
    const client = api.createClient({ postMessage: (message: any) => messages.push(message) });
    client.setState(snapshot());
    assert.equal(client.enqueue({ command: 'removeRecord', documentUri: 'file:///unrelated.yml', documentVersion: 3, target: { section: 'ТегиСценария', recordKey: 'tag-smoke' } }), false);
    assert.equal(messages.length, 0);
});

test('properties form renders safe source, selected settings and metadata controls and edits their exact documents', () => {
    const h = harness(); h.state(snapshot());
    assert.deepEqual(h.messages[0], { command: 'ready' });
    assert.match(textOf(h.root), /<img src=x onerror=alert\(1\)>/);
    assert.equal(nodes(h.root).some(node => ['IMG', 'SCRIPT'].includes(node.tagName)), false);
    assert.equal(h.field('База', { documentUri: 'file:///settings-b.yml' })?.value, 'other');
    assert.equal(h.field('База', { documentUri: 'file:///settings-a.yml' }), undefined);
    assert.equal(h.field('Значение', { recordKey: 'customer' })?.tagName, 'TEXTAREA');
    const override = h.field('Значение', { recordKey: 'override' }); assert.ok(override);
    override.value = '84'; override.fire('input'); override.fire('change');
    assert.deepEqual(h.messages[1], { command: 'edit', documentUri: 'file:///settings-b.yml', documentVersion: 7, edit: { section: 'ПараметрыТеста', recordKey: 'override', field: 'Значение', value: '84' } });
    h.state(snapshot());
    const group = h.field('groupId'); assert.ok(group);
    group.value = 'regression'; group.fire('change');
    assert.deepEqual(h.messages[2], { command: 'editMetadata', documentUri: 'file:///scenario.yml.kot.yml', documentVersion: 2, field: 'groupId', value: 'regression' });
});

test('properties form hides identifiers and edits identity through revision-guarded fields', () => {
    const h = harness(); const current = snapshot(); h.state(current);
    assert.equal(h.field('UID'), undefined);
    for (const name of ['rename', 'changeCode', 'systemFunction']) { assert.equal(h.action(name), undefined); }
    (current.source.model.header[0] as any).action = 'rename'; current.source.model.header[0].readonly = false;
    h.state(current); const nameField = h.field('Имя', { section: 'ДанныеСценария' })!;
    nameField.value = 'Changed'; nameField.fire('change');
    assert.deepEqual(h.messages.at(-1), { command: 'edit', documentUri: current.source.uri, documentVersion: 3, edit: { section: 'ДанныеСценария', field: 'Имя', value: 'Changed' } });
    h.state(current);
    for (const name of ['base', 'users', 'newGroup']) { assert.equal(h.action(name), undefined); }
    for (const name of ['aiDescription', 'openText', 'save', 'pin']) {
        const action = h.action(name); assert.ok(action, name);
        action.fire('click');
        assert.deepEqual(h.messages.at(-1), { command: 'action', action: name });
        h.state(current);
    }
    const group = h.field('groupId')!; group.value = '__kot_create_choice__'; group.fire('change');
    assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'newGroup' }); h.state(current);
    const selector = h.find(node => node.tagName === 'SELECT' && node.dataset.action === 'selectSettings'); assert.ok(selector);
    selector.value = 'file:///settings-a.yml'; selector.fire('change');
    assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'selectSettings', value: 'file:///settings-a.yml' });
});

test('properties form preserves focused drafts and selection while state updates and queues rapid changes', () => {
    const h = harness(); const current = snapshot(); h.state(current);
    const input = h.field('Имя', { recordKey: 'customer' }); assert.ok(input);
    input.focus(); input.value = 'Uncommitted draft'; input.selectionStart = 4; input.selectionEnd = 8; input.fire('input');
    assert.match(textOf(h.root), /Unsaved/);
    const next = snapshot(); next.source.version = 4; next.dirty = true; h.state(next);
    const focused = h.document.activeElement as Element;
    assert.equal(focused.value, 'Uncommitted draft');
    assert.equal(focused.selectionStart, 4); assert.equal(focused.selectionEnd, 8);
    focused.fire('change');
    const amount = h.field('Значение', { recordKey: 'amount' }); assert.ok(amount);
    amount.value = '20'; amount.fire('input'); amount.fire('change');
    assert.equal(h.messages.filter(message => message.command === 'edit').length, 1);
    next.source.version = 5; h.state(next);
    assert.equal(h.messages.at(-1).documentVersion, 5);
    assert.equal(h.messages.at(-1).edit.recordKey, 'amount');
    assert.match(textOf(h.root), /Unsaved/);
});

test('Save test commits a focused draft restored after refresh before requesting document saves', () => {
    const h = harness(); const current = snapshot(); h.state(current);
    const input = h.field('Значение', { recordKey: 'amount' }); assert.ok(input);
    input.focus(); input.value = 'Saved draft'; input.fire('input');
    const refreshed = snapshot(); refreshed.source.version = 4; h.state(refreshed);
    const save = h.find(node => node.tagName === 'BUTTON' && node.dataset.action === 'save'); assert.ok(save);
    save.fire('click');
    assert.equal(h.messages.at(-1).command, 'edit');
    assert.equal(h.messages.at(-1).edit.value, 'Saved draft');
    assert.equal(h.messages.at(-1).documentVersion, 4);
    const acknowledged = snapshot(); acknowledged.source.version = 5;
    const record = acknowledged.source.model.sections[0].records.find((value: any) => value.key === 'amount');
    record.fields.find((value: any) => value.key === 'Значение').value = 'Saved draft';
    h.state(acknowledged);
    assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'save' });
});

test('blur commits a refreshed field draft once even when change and Save test follow it', () => {
    const h = harness(); h.state(snapshot());
    const input = h.field('Значение', { recordKey: 'amount' }); assert.ok(input);
    input.focus(); input.value = 'Committed value'; input.fire('input');
    h.state(snapshot());
    const refreshed = h.document.activeElement as Element;
    refreshed.fire('blur');
    assert.equal(h.messages.at(-1).command, 'edit');
    refreshed.fire('change');
    h.find(node => node.tagName === 'BUTTON' && node.dataset.action === 'save')!.fire('click');
    assert.equal(h.messages.filter(message => message.command === 'edit').length, 1);
    assert.equal(h.messages.at(-1).edit.value, 'Committed value');
});

test('properties form adds, removes and reorders opaque record keys with keyboard and drag actions', () => {
    const h = harness(); const current = snapshot(); h.state(current);
    const add = h.action('addRecord', { section: 'ТегиСценария' }); assert.ok(add); add.fire('click');
    assert.deepEqual(h.messages.at(-1), { command: 'addRecord', documentUri: 'file:///scenario.yml', documentVersion: 3, target: { section: 'ТегиСценария' } });
    h.state(current);
    const remove = h.action('removeRecord', { section: 'ПараметрыСценария', recordKey: 'amount' }); assert.ok(remove); remove.fire('click');
    assert.deepEqual(h.messages.at(-1).target, { section: 'ПараметрыСценария', recordKey: 'amount' });
    h.state(current);
    const move = h.action('moveUp', { section: 'ПараметрыСценария', recordKey: 'amount' }); assert.ok(move); move.fire('click');
    assert.deepEqual(h.messages.at(-1), { command: 'moveRecord', documentUri: 'file:///scenario.yml', documentVersion: 3, target: { section: 'ПараметрыСценария', recordKey: 'amount', beforeRecordKey: 'customer' } });
    h.state(current);
    const first = h.find(node => node.draggable && node.dataset.recordKey === 'customer');
    const second = h.find(node => node.draggable && node.dataset.recordKey === 'amount'); assert.ok(first); assert.ok(second);
    const data = new Map<string, string>();
    const dataTransfer = { types: [] as string[], setData(type: string, value: string) { data.set(type, value); this.types.push(type); }, getData: (type: string) => data.get(type) ?? '' };
    second.fire('dragstart', { dataTransfer }); first.fire('drop', { dataTransfer });
    assert.deepEqual(h.messages.at(-1).target, { section: 'ПараметрыСценария', recordKey: 'amount', beforeRecordKey: 'customer' });
});

test('process step fields and nested parameter records carry the containing step UID and picker additions', () => {
    const h = harness(); const current = snapshot();
    current.source.model.kind = 'process';
    current.source.model.sections = [{ key: 'ШагиПроцесса', records: [{ key: 'opaque-step', fields: [{ key: 'UID', value: 'step-uid', readonly: true }, { key: 'Наименование', value: 'Build process stage' }], sections: [{ key: 'ПараметрыШага', records: [{ key: 'input', fields: [{ key: 'Имя', value: 'Input' }, { key: 'Значение', value: '[prior.Output]' }] }] }] }] }] as any;
    h.state(current);
    assert.equal(h.find(node => node.className === 'properties-record-title')?.textContent, 'Build process stage');
    const field = h.field('Значение', { stepUid: 'step-uid', recordKey: 'input' }); assert.ok(field);
    field.value = '[prior.NewOutput]'; field.fire('change');
    assert.deepEqual(h.messages.at(-1), { command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 3, edit: { section: 'ПараметрыШага', stepUid: 'step-uid', recordKey: 'input', field: 'Значение', value: '[prior.NewOutput]' } });
    h.state(current);
    const add = h.action('addRecord', { section: 'ПараметрыШага', stepUid: 'step-uid' }); assert.ok(add); add.fire('click');
    assert.deepEqual(h.messages.at(-1).target, { section: 'ПараметрыШага', stepUid: 'step-uid' });
    h.state(current);
    h.action('addSteps')?.fire('click');
    assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'addSteps' });
    assert.equal(h.action('addRecord', { section: 'ШагиПроцесса' }), undefined);
    assert.ok(h.action('openText'));
});

test('properties form persists collapse state, displays errors and offers explicit creation for missing settings', () => {
    const h = harness(); const current = snapshot(); h.state(current);
    const section = h.find(node => node.tagName === 'DETAILS' && node.dataset.section === 'ПараметрыСценария'); assert.ok(section);
    section.open = false; section.fire('toggle');
    const persisted = h.persisted.at(-1); assert.ok(persisted);
    h.state({ ...current, error: 'The source changed; open YAML and retry.' });
    assert.match(textOf(h.root), /The source changed; open YAML and retry\./);
    const reopened = harness(persisted); current.settings = []; current.selectedSettingsUri = null as any; reopened.state(current);
    assert.equal(reopened.find(node => node.tagName === 'DETAILS' && node.dataset.section === 'ПараметрыСценария')?.open, false);
    const create = reopened.action('createSettings'); assert.ok(create); create.fire('click');
    assert.deepEqual(reopened.messages.at(-1), { command: 'action', action: 'createSettings' });
});

test('first metadata edit targets the source and preserves a focused draft when the sidecar is created', () => {
    const h = harness(); const current = snapshot(); current.metadata = null as any; h.state(current);
    const description = h.field('description'); assert.ok(description);
    description.focus(); description.value = 'First description'; description.fire('input'); description.fire('change');
    assert.deepEqual(h.messages.at(-1), { command: 'editMetadata', documentUri: 'file:///scenario.yml', documentVersion: 3, field: 'description', value: 'First description' });
    description.value = 'Still typing'; description.selectionStart = 5; description.selectionEnd = 5; description.fire('input');
    const next = snapshot(); next.metadata.values.description = 'First description'; h.state(next);
    assert.equal(h.document.activeElement.value, 'Still typing');
    assert.equal(h.document.activeElement.dataset.documentUri, 'file:///scenario.yml.kot.yml');
    h.document.activeElement.fire('change');
    assert.deepEqual(h.messages.at(-1), { command: 'editMetadata', documentUri: 'file:///scenario.yml.kot.yml', documentVersion: 2, field: 'description', value: 'Still typing' });
});

test('parameter rename acknowledgement rebinds focused controls and queued edits to the new semantic record key', () => {
    const h = harness(); const current = snapshot(); h.state(current);
    const name = h.field('Имя', { recordKey: 'customer' }); assert.ok(name);
    name.value = 'Renamed customer'; name.fire('change');
    const value = h.field('Значение', { recordKey: 'customer' }); assert.ok(value);
    value.focus(); value.value = 'Draft after rename'; value.fire('input'); value.fire('change');
    const next = snapshot(); next.source.version = 4;
    next.source.model.sections[0].records[0].key = 'Renamed customer';
    next.source.model.sections[0].records[0].fields[0].value = 'Renamed customer';
    h.state(next);
    assert.deepEqual(h.messages.at(-1), { command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 4, edit: { section: 'ПараметрыСценария', recordKey: 'Renamed customer', field: 'Значение', value: 'Draft after rename' } });
    assert.equal(h.document.activeElement.dataset.recordKey, 'Renamed customer');
    assert.equal(h.document.activeElement.value, 'Draft after rename');
});

test('drag reorder can append a record but rejects a foreign section or another process step', () => {
    const h = harness(); const current = snapshot(); h.state(current);
    const last = h.find(node => node.dataset.action === 'dropAtEnd' && node.dataset.section === 'ПараметрыСценария'); assert.ok(last);
    const transfer = (value: any) => ({ getData: () => JSON.stringify(value) });
    last.fire('drop', { dataTransfer: transfer({ documentUri: 'file:///scenario.yml', section: 'ТегиСценария', recordKey: 'tag-smoke' }) });
    assert.equal(h.messages.length, 1);
    last.fire('drop', { dataTransfer: transfer({ documentUri: 'file:///scenario.yml', section: 'ПараметрыСценария', recordKey: 'customer', stepUid: 'foreign-step' }) });
    assert.equal(h.messages.length, 1);
    last.fire('drop', { dataTransfer: transfer({ documentUri: 'file:///scenario.yml', section: 'ПараметрыСценария', recordKey: 'customer' }) });
    assert.deepEqual(h.messages.at(-1), { command: 'moveRecord', documentUri: 'file:///scenario.yml', documentVersion: 3, target: { section: 'ПараметрыСценария', recordKey: 'customer', beforeRecordKey: null } });
});

test('nested definitions hide missing settings creation but still show actually linked settings', () => {
    const h = harness(); const current = { ...snapshot(), canCreateSettings: false };
    current.settings = []; current.selectedSettingsUri = null as any; h.state(current);
    assert.equal(Boolean(h.action('createSettings')), false);
    assert.equal(Boolean(h.find(node => node.tagName === 'DETAILS' && node.dataset.section === 'testSettings')), false);
    assert.equal(Boolean(h.field('groupId')), false);
    assert.equal(Boolean(h.field('order')), false);
    assert.equal(Boolean(h.action('newGroup')), false);
    assert.ok(h.field('description')); assert.ok(h.field('category'));
    h.state({ ...snapshot(), canCreateSettings: false });
    assert.equal(h.field('База')?.value, 'other');
});

test('an unavailable source preserves actionable errors and releases queued requests', () => {
    const unavailable = { source: null, settings: [], metadata: null, groups: [], selectedSettingsUri: null, pinned: false, dirty: false,
        canCreateSettings: false, error: 'Source YAML is malformed; open raw YAML and repair the duplicate field.' };
    const h = harness(); h.state(unavailable);
    assert.match(textOf(h.root), /Source YAML is malformed/);
    assert.ok(h.find(node => node.getAttribute('role') === 'alert'));
    const api = loadProtocol(); const messages: any[] = [];
    const client = api.createClient({ postMessage: (message: any) => messages.push(message) }); client.setState(snapshot());
    const mutation = { command: 'edit', documentUri: 'file:///scenario.yml', documentVersion: 3, edit: { section: 'ДанныеСценария', field: 'Проект', value: 'Changed' } };
    client.enqueue(mutation); client.enqueue(mutation); client.setState(unavailable);
    assert.equal(client.isPending(), false); assert.equal(messages.length, 1); assert.equal(client.getState().error, unavailable.error);
    h.state(snapshot()); assert.equal(h.field('База')?.value, 'other');
});

test('an older visible error does not discard queued edits or prevent rekeying after a successful rename', () => {
    const api = loadProtocol(); const messages: any[] = []; const rekeys: any[] = [];
    const client = api.createClient({ postMessage: (value: any) => messages.push(value), onRekey: (value: any) => rekeys.push(value) });
    const state = { ...snapshot(), error: 'Previous catalog error', mutationError: false }; client.setState(state);
    const documentUri = state.source.uri;
    client.enqueue({ command: 'edit', documentUri, documentVersion: 3, edit: { section: 'ПараметрыСценария', recordKey: 'customer', field: 'Имя', value: 'Client' } });
    client.enqueue({ command: 'edit', documentUri, documentVersion: 3, edit: { section: 'ПараметрыСценария', recordKey: 'customer', field: 'Значение', value: 'Other' } });
    const next = { ...snapshot(), error: state.error, mutationError: false }; next.source.version = 4;
    next.source.model.sections[0].records[0].key = 'Client'; next.source.model.sections[0].records[0].fields[0].value = 'Client';
    client.setState(next);
    assert.equal(messages.length, 2); assert.equal(messages[1].edit.recordKey, 'Client'); assert.equal(messages[1].documentVersion, 4); assert.equal(rekeys.length, 1);
});
test('object creation and selection use bound revision guards and create sentinel never becomes a YAML value', () => {
    const h = harness(); const state = snapshot();
    state.source.model.header.push({ key: 'Проект', value: 'Drive', choices: ['Drive', 'Other'], createAction: 'createChoice', action: 'catalogChoice' } as any);
    h.state(state); const field = h.field('Проект')!;
    field.value = '__kot_create_choice__'; field.fire('input'); field.fire('change'); field.fire('blur');
    assert.deepEqual(h.messages.at(-1), { command: 'createChoice', documentUri: state.source.uri, documentVersion: 3, target: { section: 'ДанныеСценария', field: 'Проект' } });
    assert.equal(h.messages.filter(message => message.command === 'createChoice').length, 1);
    h.state(state); const next = h.field('Проект')!; next.value = 'Other'; next.fire('change');
    assert.deepEqual(h.messages.at(-1), { command: 'catalogChoice', documentUri: state.source.uri, documentVersion: 3, target: { section: 'ДанныеСценария', field: 'Проект' }, value: 'Other' });
});

test('opening metadata belongs to the metadata group header and file paths keep their open button beside them', () => {
    for (const main of [true, false]) {
        const h = harness(); h.state({ ...snapshot(), canCreateSettings: main });
        const metadata = h.action('openMetadata')!;
        assert.equal(metadata.parentElement?.tagName, 'SUMMARY'); assert.equal(metadata.parentElement?.parentElement?.dataset.section, 'metadata');
        const settings = h.action('openSettings')!;
        assert.ok(settings.parentElement?.className.includes('properties-source-path'));
        const copy = settings.parentElement?.children.find(node => node.dataset.action === 'copyPath')!;
        assert.ok(copy); copy.fire('click');
        assert.equal(h.messages.at(-1).value, 'file:///settings-b.yml');
        assert.equal(settings.parentElement?.children.some(node => node.tagName === 'P'), false);
    }
});

test('automatic declaration lists omit the saved-YAML hint while manual mode retains fill actions', () => {
    const h = harness(); const state = snapshot(); (state as any).autoFill = { parameters: true, nested: true }; h.state(state);
    assert.doesNotMatch(textOf(h.root), /This list is filled automatically when YAML is saved/);
    assert.equal(h.action('fillParameters'), undefined); assert.equal(h.action('fillNested'), undefined);
    (state as any).autoFill = { parameters: false, nested: false }; h.state(state);
    assert.ok(h.action('fillParameters')); assert.ok(h.action('fillNested'));
});

test('disclosure collapse remains visible while animating, persists intent and settles to its native closed state', () => {
    const h = harness({}, { animate: true }); h.state(snapshot());
    const section = h.find(node => node.tagName === 'DETAILS' && node.dataset.section === 'ДанныеСценария')!;
    section.children[0].fire('click'); assert.equal(h.animations.length, 1);
    assert.equal(section.open, true); assert.ok(section.className.includes('is-animating'));
    assert.deepEqual(JSON.parse(JSON.stringify(h.animations[0].frames)), [{ height: '140px' }, { height: '32px' }]);
    assert.equal(h.animations[0].options.duration, 200);
    assert.ok(Object.values(h.persisted.at(-1).collapsed).includes(true));
    h.animations[0].onfinish(); assert.equal(section.open, false); assert.ok(!section.className.includes('is-animating'));
    section.children[0].fire('click'); h.animations[1].onfinish(); assert.equal(section.open, true);
});

test('rapid disclosure reversals and state refreshes cancel stale animations without changing saved intent', () => {
    const h = harness({}, { animate: true }); h.state(snapshot());
    const parameter = h.find(node => node.tagName === 'DETAILS' && node.dataset.recordKey === 'customer')!;
    parameter.children[0].fire('click'); parameter.children[0].fire('click'); assert.equal(h.animations[0].cancelled, true);
    h.animations[1].onfinish(); assert.equal(parameter.open, false);
    parameter.children[0].fire('click'); h.state(snapshot()); assert.equal(h.animations[2].cancelled, true);
    assert.equal(h.find(node => node.tagName === 'DETAILS' && node.dataset.recordKey === 'customer')!.open, true);
});

test('reduced motion changes disclosure state immediately without an animation', () => {
    const h = harness({}, { animate: true, reducedMotion: true }); h.state(snapshot());
    const section = h.find(node => node.tagName === 'DETAILS' && node.dataset.section === 'ДанныеСценария')!;
    section.children[0].fire('click'); assert.equal(section.open, false); assert.equal(h.animations.length, 0);
});

test('a code rename acknowledgement rebases queued field edits and retained drafts onto its final source URI', () => {
    const h = harness(); const state = snapshot(); h.state(state);
    const parameter = h.find(node => node.tagName === 'DETAILS' && node.dataset.recordKey === 'customer')!;
    parameter.open = true; parameter.fire('toggle');
    const code = h.field('Код')!; code.readOnly = false; code.value = 'NEW'; code.fire('change');
    const name = h.field('Имя', { section: 'ДанныеСценария' })!; name.readOnly = false; name.value = 'New name'; name.fire('input'); name.fire('change');
    const next: any = snapshot(); next.source.uri = 'file:///new/scenario.yml'; next.source.version = 8; next.metadata.uri = next.source.uri + '.kot.yml';
    next.uriMoves = [{ oldUri: state.source.uri, newUri: next.source.uri }, { oldUri: state.metadata.uri, newUri: next.metadata.uri }];
    h.state(next);
    assert.equal(h.messages.at(-1).documentUri, next.source.uri); assert.equal(h.messages.at(-1).documentVersion, 8);
    assert.equal(h.messages.at(-1).edit.value, 'New name'); assert.equal(h.field('Имя', { section: 'ДанныеСценария' })?.value, 'New name');
    assert.equal(h.find(node => node.tagName === 'DETAILS' && node.dataset.recordKey === 'customer')!.open, true);
});

test('a code rename acknowledgement rebases a queued settings selection before sending it', () => {
    const h = harness(); const state = snapshot(); h.state(state);
    const code = h.field('Код')!; code.readOnly = false; code.value = 'NEW'; code.fire('change');
    h.action('testSettings')!.fire('click');
    const selector = h.find(node => node.tagName === 'SELECT' && node.dataset.action === 'selectSettings')!;
    selector.value = state.settings[0].uri; selector.fire('change');
    const next: any = snapshot(); next.source.uri = 'file:///new/scenario.yml'; next.source.version++;
    next.settings[0].uri = 'file:///new/custom.yml'; next.settings[1].uri = 'file:///new/other.yml';
    next.selectedSettingsUri = next.settings[1].uri; next.metadata.uri = next.source.uri + '.kot.yml';
    next.uriMoves = [{ oldUri: state.source.uri, newUri: next.source.uri },
        { oldUri: state.settings[0].uri, newUri: next.settings[0].uri }, { oldUri: state.settings[1].uri, newUri: next.settings[1].uri },
        { oldUri: state.metadata.uri, newUri: next.metadata.uri }];
    h.state(next);
    assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'selectSettings', value: next.settings[0].uri });
});

test('Properties Run button passes protocol validation and reaches the extension', () => {
    const h = harness(); h.state({ ...snapshot(), canCreateSettings: true });
    assert.ok(h.action('run')); h.action('run')!.fire('click');
    assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'run' });
});

test('Properties offers the shared favorite toggle and an inset readable empty state', () => {
    const h = harness(); h.state({ ...snapshot(), canFavorite: true, favorite: false });
    assert.equal(h.action('favorite')?.getAttribute('aria-pressed'), 'false');
    h.action('favorite')!.fire('click'); assert.equal(h.messages.at(-1).action, 'favorite');
    h.state({ ...snapshot(), canFavorite: true, favorite: true });
    assert.equal(h.action('favorite')?.getAttribute('aria-pressed'), 'true');
    const css = fs.readFileSync('media/scenarioProperties.css', 'utf8');
    assert.match(css, /\.properties-empty\s*\{[^}]*padding:\s*20px 16px/u);
    assert.match(css, /\.properties-empty\s*\{[^}]*font-size:\s*var\(--vscode-font-size/u);
});

test('feature Properties edits queue against acknowledged native versions and reset on YAML switch', () => {
    const h = harness();
    const feature = { uri: 'file:///test.feature', version: 1, dirty: false, pinned: false, canFavorite: true, favorite: false,
        model: { title: 'Test', description: '', tags: ['@Smoke'], actions: [{ title: '+ Background', kind: 'background', line: 0 }],
            scenarios: [{ title: 'Ready', line: 2, actions: [] }] }, standalone: { groupId: '', groups: [], jsonPath: '/test.json' } };
    h.message({ command: 'featureState', state: feature, acknowledgement: false });
    assert.equal(h.field('title')?.value, 'Test'); assert.ok(h.action('chooseJson')); assert.ok(h.action('structure'));
    h.field('title')!.value = 'Changed'; h.field('title')!.fire('input'); h.field('title')!.fire('change');
    h.field('tags')!.value = '@Other'; h.field('tags')!.fire('input'); h.field('tags')!.fire('change');
    assert.equal(h.messages.at(-1).field, 'title'); assert.equal(h.messages.at(-1).version, 1);
    h.field('tags')!.focus();
    const count = h.messages.length;
    h.message({ command: 'featureState', acknowledgement: false, state: { ...feature, version: 2, model: { ...feature.model, title: 'Changed' } } });
    assert.equal(h.messages.length, count, 'external refresh is not an edit acknowledgement');
    assert.equal(h.document.activeElement, h.field('tags'), 'refresh preserves the focused feature field');
    h.message({ command: 'featureState', acknowledgement: true, state: { ...feature, version: 2, model: { ...feature.model, title: 'Changed' } } });
    assert.equal(h.messages.at(-1).field, 'tags'); assert.equal(h.messages.at(-1).version, 2);
    h.state(snapshot()); assert.ok(h.action('openSource')); assert.equal(h.field('title'), undefined);
});

test('queued positional feature actions retain the version of the clicked scenario', () => {
    const h = harness(); const feature = { uri: 'file:///test.feature', version: 1, dirty: false, pinned: false,
        model: { title: 'Test', description: 'Line one\nLine two', tags: [], actions: [], scenarios: [
            { title: 'One', line: 3, actions: [] }, { title: 'Two', line: 5, actions: [] }] } };
    h.message({ command: 'featureState', state: feature });
    h.field('description')!.value = ''; h.field('description')!.fire('input'); h.field('description')!.fire('change');
    h.action('renameScenario')!.fire('click'); assert.equal(h.messages.at(-1).action, 'edit');
    h.message({ command: 'featureState', acknowledgement: true, state: { ...feature, version: 2, model: { ...feature.model, description: '', scenarios: [
        { title: 'One', line: 1, actions: [] }, { title: 'Two', line: 3, actions: [] }] } } });
    assert.equal(h.messages.at(-1).action, 'renameScenario'); assert.equal(h.messages.at(-1).line, 3);
    assert.equal(h.messages.at(-1).version, 1, 'a new version must not bless a stale scenario line');
});

test('feature drafts keep their original field base after external edits', () => {
    const h = harness(); const feature = { uri: 'file:///test.feature', version: 1, dirty: false, pinned: false,
        model: { title: 'Original', description: '', tags: [], actions: [], scenarios: [] } };
    h.message({ command: 'featureState', state: feature });
    h.field('title')!.value = 'Local'; h.field('title')!.fire('input');
    h.message({ command: 'featureState', acknowledgement: false, state: { ...feature, version: 2, model: { ...feature.model, title: 'External' } } });
    h.field('title')!.fire('change'); assert.equal(h.messages.at(-1).value, 'Local'); assert.equal(h.messages.at(-1).baseValue, 'Original');
});

test('successful feature edits settle normalized drafts while preserving later typing', () => {
    const h = harness(); const feature = { uri: 'file:///test.feature', version: 1, dirty: false, pinned: false,
        model: { title: 'Original', description: '', tags: [], actions: [], scenarios: [] } };
    h.message({ command: 'featureState', state: feature });
    h.field('tags')!.value = 'Smoke'; h.field('tags')!.fire('input'); h.field('tags')!.fire('change');
    h.message({ command: 'featureState', acknowledgement: true, state: { ...feature, version: 2, model: { ...feature.model, tags: ['@Smoke'] } } });
    assert.equal(h.field('tags')!.value, '@Smoke'); h.action('save')!.fire('click'); assert.equal(h.messages.at(-1).action, 'save');
    h.message({ command: 'featureState', acknowledgement: true, state: { ...feature, version: 2, model: { ...feature.model, tags: ['@Smoke'] } } });
    assert.ok(textOf(h.root).includes('Saved')); assert.ok(!textOf(h.root).includes('Unsaved changes'));
    h.field('title')!.value = ' First '; h.field('title')!.fire('input'); h.field('title')!.fire('change');
    h.field('title')!.value = 'Second'; h.field('title')!.fire('input'); h.field('title')!.fire('change');
    h.message({ command: 'featureState', acknowledgement: true, state: { ...feature, version: 3, model: { ...feature.model, title: 'First', tags: ['@Smoke'] } } });
    assert.equal(h.field('title')!.value, 'Second'); assert.equal(h.messages.at(-1).baseValue, 'First');
});

test('favorite follows Save and Launch JSON is an independently collapsible section', () => {
    const h = harness(); h.state({ ...snapshot(), canFavorite: true });
    const yamlActions = h.action('save')!.parentElement!;
    assert.ok(yamlActions.children.indexOf(h.action('favorite')!) > yamlActions.children.indexOf(h.action('save')!));
    const feature = { uri: 'file:///test.feature', version: 1, dirty: false, pinned: false,
        model: { title: 'Test', description: '', tags: [], actions: [{ title: '+ Background', kind: 'background', line: 0 }], scenarios: [] }, standalone: { groupId: '', groups: [] } };
    h.message({ command: 'featureState', state: feature });
    const actions = h.action('save')!.parentElement!; assert.deepEqual(actions.children.map(node => node.dataset.action), ['save', 'run', 'favorite', 'pin']);
    assert.equal(h.action('run')!.parentElement, actions, 'Run belongs in the header toolbar');
    assert.ok(h.find(node => node.tagName === 'DETAILS' && node.className.includes('properties-feature-blocks')));
    const section = h.find(node => node.tagName === 'DETAILS' && node.className.includes('properties-feature-launch'));
    assert.ok(section); assert.ok(section.open); section.children[0].fire('click'); assert.equal(section.open, false);
    h.message({ command: 'featureState', state: { ...feature, dirty: true }, acknowledgement: false });
    assert.equal(h.find(node => node.tagName === 'DETAILS' && node.className.includes('properties-feature-launch'))?.open, false);
});

test('feature unpin bypasses unsent drafts and survives a rejected pending edit', () => {
    const h = harness(); const feature = { uri: 'file:///test.feature', version: 1, dirty: false, pinned: true,
        model: { title: 'Original', description: '', tags: [], actions: [], scenarios: [] } };
    h.message({ command: 'featureState', state: feature });
    h.field('title')!.value = 'Draft'; h.field('title')!.fire('input'); h.action('pin')!.fire('click');
    assert.equal(h.messages.at(-1).action, 'pin');
    h.message({ command: 'featureState', acknowledgement: true, state: feature });
    h.field('title')!.fire('change'); assert.equal(h.messages.at(-1).action, 'edit');
    h.action('pin')!.fire('click');
    h.message({ command: 'featureState', acknowledgement: true, state: { ...feature, error: 'The source was deleted.' } });
    assert.equal(h.messages.at(-1).action, 'pin', 'source recovery must survive the failed edit');
});

test('feature Properties offers the scenario plus in the Scenarios heading without duplicating it in blocks', () => {
    const h = harness(); h.message({ command: 'featureState', state: { uri: 'file:///test.feature', version: 3, pinned: false,
        model: { title: 'Test', description: '', tags: [], actions: [{ title: '+ Scenario', kind: 'scenario', line: 0 }], scenarios: [] } } });
    const plus = h.action('structure'); assert.ok(plus); assert.equal(plus.parentElement?.tagName, 'SUMMARY');
    plus.fire('click'); assert.equal(h.messages.at(-1).value, 'scenario'); assert.equal(h.messages.at(-1).line, 0);
    assert.ok(!h.find(node => node.className.includes('properties-feature-blocks')));
});


test('pressing Save before blur queues the save even when the edit acknowledgement replaces its button', () => {
    const h = harness(); h.state(snapshot());
    const input = h.field('Значение', { recordKey: 'amount' }); input.focus(); input.value = 'First click'; input.fire('input');
    const save = h.action('save'); save.fire('pointerdown');
    const acknowledged = snapshot(); acknowledged.source.version++;
    acknowledged.source.model.sections[0].records[0].fields.find((field: any) => field.key === 'Значение').value = 'First click';
    h.state(acknowledged);
    assert.equal(h.messages.filter(message => message.command === 'edit').length, 1); assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'save' });
});


test('native Properties offers Open feature before Open YAML without changing metadata edit identity', () => {
    const h = harness(); const state = snapshot(); state.source.uri = 'file:///repo/meta.yaml'; state.source.scriptUri = 'file:///repo/scen.feature'; h.state(state);
    const actions = nodes(h.root).filter(node => node.tagName === 'BUTTON').map(node => node.dataset.action);
    assert.ok(actions.indexOf('openFeature') < actions.indexOf('openSource'));
    h.action('openFeature').fire('click'); assert.deepEqual(h.messages.at(-1), { command: 'action', action: 'openFeature' });
});

test('Properties exposes conversions through one dropdown button and sends the explicit target role', () => {
    const h = harness(); const main = snapshot(); main.source.uri = 'file:///repo/scen.yaml'; h.state(main);
    const trigger = h.action('conversions'); assert.ok(trigger);
    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu'); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    const menu = h.find(node => node.getAttribute('role') === 'menu'); assert.ok(menu); assert.equal(menu.hidden, true);
    assert.equal(h.find(node => node.tagName === 'DETAILS' && textOf(node).includes('Conversions')), undefined);
    trigger.fire('click'); assert.equal(menu.hidden, false); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const role = h.action('convertRole')!; const format = h.action('convertFormat')!;
    assert.ok(role); assert.ok(format); assert.equal(role.parentElement, format.parentElement);
    role.fire('click'); assert.equal(h.messages.at(-1).action, 'convertRole'); assert.equal(h.messages.at(-1).value, 'nested');
    assert.equal(menu.hidden, true);
    const nested = harness(); const state = snapshot(); state.settings = []; state.canCreateSettings = false; nested.state(state);
    const exportButton = nested.action('convertCallable'); assert.ok(exportButton);
    assert.equal(exportButton.parentElement, nested.action('convertRole')!.parentElement);
    nested.action('conversions')!.fire('click');
    nested.action('convertRole')!.fire('click'); assert.equal(nested.messages.at(-1).value, 'main');
    assert.equal(h.action('convertCallable'), undefined);
});

test('Conversions dropdown supports arrow keys and Escape without submitting an action', () => {
    const h = harness(); const state = snapshot(); state.settings = []; state.canCreateSettings = false; state.source.uri = 'file:///repo/scen.yaml'; h.state(state);
    const trigger = h.action('conversions')!; const menu = h.find(node => node.getAttribute('role') === 'menu')!;
    trigger.fire('keydown', { key: 'ArrowDown' });
    assert.equal(h.document.activeElement, h.action('convertRole')); assert.equal(menu.hidden, false);
    menu.fire('keydown', { key: 'End' }); assert.equal(h.document.activeElement, h.action('convertCallable'));
    menu.fire('keydown', { key: 'Escape' }); assert.equal(menu.hidden, true); assert.equal(h.document.activeElement, trigger);
    assert.equal(h.messages.filter(message => message.command === 'action').length, 0);
});
