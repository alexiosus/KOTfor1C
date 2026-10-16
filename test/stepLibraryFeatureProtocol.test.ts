import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Element {
    children: Element[] = [];
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    listeners = new Map<string, Array<(event: any) => void>>();
    parent?: Element;
    textContent = '';
    style = { left: '', top: '' };
    classList = { add() {}, remove() {} };
    append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]); }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(value => value !== this); } }
    contains(value: Element): boolean { return value === this || this.children.some(child => child.contains(value)); }
    focus() {}
    querySelector() { return this.children[0]; }
    getBoundingClientRect() { return { width: 100, height: 100 }; }
    fire(name: string, data: Record<string, unknown> = {}) { for (const listener of this.listeners.get(name) || []) { listener({ target: this, preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0, ...data }); } }
}

function harness() {
    const body = new Element();
    const messages: unknown[] = [];
    const context = {
        module: { exports: {} as any },
        document: { body, createElement: () => new Element(), addEventListener() {} },
        window: { innerWidth: 600, innerHeight: 800 },
        requestAnimationFrame: (callback: () => void) => callback()
    };
    const file = 'media/stepLibraryFeatureProtocol.js';
    if (fs.existsSync(file)) { vm.runInNewContext(fs.readFileSync(file, 'utf8'), context); }
    const api = context.module.exports;
    assert.equal(typeof api.createController, 'function');
    const controller = api.createController({ postMessage: (message: unknown) => messages.push(JSON.parse(JSON.stringify(message))), getFeatures: () => features, labels: { openFeature: 'Open feature', createGroup: 'New group', renameGroup: 'Rename', deleteGroup: 'Delete' } });
    return { controller, body, messages };
}
const features = [
    { featureId: 'file:///z.feature', sourceGroup: 'standalone', groupId: 'smoke', order: 0 },
    { featureId: 'file:///a.feature', sourceGroup: 'standalone', groupId: 'smoke', order: 1 }
];

test('both Library menus offer Properties for YAML and feature definitions and preserve the selected identity', () => {
    const { controller, body, messages } = harness();
    for (const sourceGroup of ['main', 'process', 'nested', 'export']) {
        const row = new Element();
        controller.install(row, { kind: 'definition', sourceGroup, navigable: true, scenarioPropertiesUri: 'file:///selected.yaml', itemId: `${sourceGroup}:selected` });
        row.fire('contextmenu');
        const properties = body.children[0]?.children.find(button => button.dataset.action === 'openScenarioProperties');
        assert.ok(properties, sourceGroup);
        properties.fire('click');
        assert.deepEqual(messages.at(-1), { command: 'openScenarioProperties', itemId: `${sourceGroup}:selected` });
    }
    const row = new Element();
    controller.install(row, { ...features[0], featureId: 'file:///test.feature' }); row.fire('contextmenu');
    assert.equal(body.children[0].children.some(button => button.dataset.action === 'openScenarioProperties'), true);
    const native = new Element();
    controller.install(native, { kind: 'definition', sourceGroup: 'export', navigable: true, capturedLocation: { uri: 'file:///export.feature' }, itemId: 'native:export' });
    native.fire('contextmenu');
    assert.equal(body.children[0].children.some(button => button.dataset.action === 'openScenarioProperties'), true);
});

test('main scenario group menus and F2 use a member identity; other category roots cannot rename', () => {
    const { controller, body, messages } = harness();
    const row = new Element();
    controller.install(row, { sourceGroup: 'main', renameGroupItemId: 'mainScenario#file:///scen.yaml', label: 'Smoke' });
    row.fire('contextmenu');
    const action = body.children[0]?.children.find(button => button.dataset.action === 'renameMainGroup');
    assert.ok(action);
    action.fire('click');
    row.fire('keydown', { key: 'F2' });
    assert.deepEqual(messages, Array(2).fill({ command: 'renameMainGroup', itemId: 'mainScenario#file:///scen.yaml' }));
    for (const sourceGroup of ['main', 'nested', 'export']) {
        const root = new Element();
        controller.install(root, { sourceGroup, label: 'Root' });
        root.fire('contextmenu');
        root.fire('keydown', { key: 'F2' });
    }
    assert.equal(messages.length, 2);
});

test('native rows move with canonical feature identities without editor insertion drag data', () => {
    const { controller, messages } = harness();
    const first = new Element(); const second = new Element();
    controller.install(first, features[0]); controller.install(second, features[1]);
    const data = new Map();
    const transfer = { types: [], setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) || '' };
    first.fire('dragstart', { dataTransfer: transfer });
    assert.equal(data.has('text/plain'), false);
    second.fire('drop', { dataTransfer: transfer });
    assert.deepEqual(messages[0], { command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///z.feature', groupId: 'smoke', beforeId: 'file:///a.feature' });
    second.fire('keydown', { key: 'ArrowUp', altKey: true });
    assert.deepEqual(messages[1], { command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///a.feature', groupId: 'smoke', beforeId: 'file:///z.feature' });
    first.fire('keydown', { key: 'M', ctrlKey: true, shiftKey: true });
    assert.deepEqual(messages[2], { command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///z.feature' });
});

test('native empty-group menu exposes create, rename and delete actions', () => {
    const { controller, body, messages } = harness();
    const row = new Element();
    controller.install(row, { sourceGroup: 'standalone', groupId: 'empty' });
    row.fire('contextmenu');
    const menu = body.children[0];
    assert.equal(menu.attributes.role, 'menu');
    assert.ok(menu.children.some(button => button.dataset.action === 'createFeature'));
    menu.children.find(button => button.dataset.action === 'renameGroup')!.fire('click');
    assert.deepEqual(messages[0], { command: 'standaloneFeatureAction', action: 'renameGroup', groupId: 'empty' });
    row.fire('keydown', { key: 'F10', shiftKey: true });
    body.children[0].children.find(button => button.dataset.action === 'deleteGroup')!.fire('click');
    assert.deepEqual(messages[1], { command: 'standaloneFeatureAction', action: 'deleteGroup', groupId: 'empty' });
});

test('feature menus in both libraries offer Rename with the selected canonical feature identity', () => {
    const { controller, body, messages } = harness();
    const row = new Element();
    controller.install(row, features[1]);
    row.fire('contextmenu');
    const rename = body.children[0].children.find(button => button.dataset.action === 'renameFeature');
    assert.ok(rename, 'Rename is available for a standalone feature');
    rename.fire('click');
    assert.deepEqual(messages[0], { command: 'standaloneFeatureAction', action: 'renameFeature', featureId: 'file:///a.feature' });
});

test('feature title and filename rename are separate menu actions', () => {
    const { controller, body, messages } = harness();
    const row = new Element();
    controller.install(row, features[0]);
    row.fire('contextmenu');
    const filename = body.children[0].children.find(button => button.dataset.action === 'renameFeatureFile');
    assert.ok(filename);
    filename.fire('click');
    assert.deepEqual(messages[0], { command: 'standaloneFeatureAction', action: 'renameFeatureFile', featureId: 'file:///z.feature' });
});

for (const sourceGroup of ['main', 'nested', 'export']) {
    test(`${sourceGroup} library rows offer Rename from their context menu and F2`, () => {
        const { controller, body, messages } = harness();
        const row = new Element();
        controller.install(row, { kind: 'definition', sourceGroup, navigable: true, itemId: `${sourceGroup}:selected` });
        row.fire('contextmenu');
        const rename = body.children[0]?.children.find(button => button.dataset.action === 'renameScenario');
        assert.ok(rename);
        rename.fire('click');
        row.fire('keydown', { key: 'F2' });
        assert.deepEqual(messages, [
            { command: 'rename', itemId: `${sourceGroup}:selected` }, { command: 'rename', itemId: `${sourceGroup}:selected` }
        ]);
    });
}
