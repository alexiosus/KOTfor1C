import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse, HTMLElement } from 'node-html-parser';

function clientPanel() {
    const messages: any[] = []; const listeners = new Map<string, (event: any) => void>();
    const windowListeners = new Map<string, (event: any) => void>();
    const wrappers = new WeakMap<HTMLElement, any>(); const nodes = new WeakMap<object, HTMLElement>();
    let active: any = null;
    const wrap = (element: HTMLElement | null): any => {
        if (!element) { return null; }
        if (wrappers.has(element)) { return wrappers.get(element); }
        const proxy = new Proxy(element, {
            get(target, key) {
                if (key === 'dataset') {
                    const attribute = (name: string) => 'data-' + name.replace(/[A-Z]/gu, letter => '-' + letter.toLowerCase());
                    return new Proxy({}, { get: (_, name: string) => target.getAttribute(attribute(name)),
                        set: (_, name: string, value: string) => { target.setAttribute(attribute(name), value); return true; } });
                }
                if (key === 'parentElement') { return wrap(target.parentNode); }
                if (key === 'querySelector' || key === 'closest') { return (selector: string) => wrap(target[key](selector)); }
                if (key === 'querySelectorAll') { return (selector: string) => target.querySelectorAll(selector).map(wrap); }
                if (key === 'appendChild' || key === 'after') { return (child: object) => target[key](nodes.get(child)!); }
                if (key === 'contains') { return (child: object | null) => {
                    let node = child ? nodes.get(child) : undefined;
                    while (node) { if (node === target) { return true; } node = node.parentNode; }
                    return false;
                }; }
                if (key === 'addEventListener') { return (name: string, callback: (event: any) => void) => listeners.set(name, callback); }
                if (key === 'focus') { return () => { active = proxy; }; }
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set: (target, key, value) => Reflect.set(target, key, value, target)
        });
        wrappers.set(element, proxy); nodes.set(proxy, element); return proxy;
    };
    const container = wrap(parse('<main></main>').querySelector('main'));
    const window: any = { addEventListener: (name: string, callback: (event: any) => void) => windowListeners.set(name, callback) };
    vm.runInNewContext(fs.readFileSync('media/infobaseVanessaClients.js', 'utf8'), { window, document: { get activeElement() { return active; } } });
    const panel = window.KotInfobaseClients.create(container, { post: (message: unknown) => messages.push(message) });
    const click = (selector: string) => listeners.get('click')!({ target: container.querySelector(selector), preventDefault() {}, stopPropagation() {} });
    return { container, panel, messages, click,
        receive: (packet: unknown) => windowListeners.get('message')!({ data: packet }),
        input: (field: string, value: string) => {
            const target = container.querySelector(`[data-client-field="${field}"]`); target.value = value;
            listeners.get('input')!({ target });
        }
    };
}
test('client rows expose per-profile status/actions without bulk selection without rendering credentials or private launch keys', () => {
    const script = fs.readFileSync('media/infobaseVanessaClients.js', 'utf8');
    const start = script.indexOf('    function escapeHtml('); const end = script.indexOf('    function create(', start);
    const context = vm.createContext({}); vm.runInContext(script.slice(start, end), context);
    const html = context.renderClientRows([{ id: 'own', name: '<b>Own</b>', username: 'Tester', state: 'connected', active: true,
        clientType: 'Thin', computerName: 'localhost', port: 1538, password: 'PRIVATE', additionalParameters: 'PRIVATE-KEY' }], new Set(['own']), (_key: string, fallback: string) => fallback);
    const doc = parse(html); assert.equal(doc.querySelector('b'), null); assert.ok(doc.textContent.includes('<b>Own</b>'));
    assert.equal(doc.querySelector('input[type="checkbox"]'), null);
    assert.ok(doc.querySelector('[data-client-action="disconnect"]'));
    assert.equal(doc.querySelector('[data-client-action="add"]'), null);
    assert.ok(doc.querySelector('[data-client-action="edit"]'));
 assert.ok(doc.querySelector('[data-client-action="remove"]'));
    assert.ok(!html.includes('PRIVATE')); assert.match(html, /Connected/u);
});

test('client editor opens under the selected row and keeps its draft across row updates', () => {
    const h = clientPanel();
    const own = { id: 'own', name: 'First', username: 'Tester', state: 'connected', clientType: 'Thin', computerName: 'localhost', port: 1538 };
    const other = { ...own, id: 'other', name: 'Second', state: 'added' };
    const view = { rows: [own, other], defaults: { ...own, name: 'New client' }, connection: { ready: true, read: true, write: true, connect: true, disconnect: true } };
    h.panel.render(view, 'C:\\QA');
    h.click('[data-client-action="edit"][data-client-id="own"]');
    h.receive({ command: 'clientEditor', infobasePath: 'C:\\QA', clientId: 'own', requestId: h.messages.at(-1).requestId, draft: own });
    const editor = h.container.querySelector('.v-client-editor');
    assert.equal(editor.closest('.v-client-row'), h.container.querySelectorAll('.v-client-row')[0]);
    h.input('username', 'Changed user');
    h.panel.render({ ...view, rows: [{ ...own, state: 'added' }, other] }, 'C:\\QA');
    assert.equal(h.container.querySelector('.v-client-editor'), editor);
    assert.equal(editor.closest('.v-client-row'), h.container.querySelectorAll('.v-client-row')[0]);
    assert.equal(editor.querySelector('[data-client-field="username"]').value, 'Changed user');
    h.click('[data-client-action="save"]');
    assert.equal(h.messages.at(-1).clientId, 'own');
    assert.equal(h.messages.at(-1).fields.username, 'Changed user');
});

test('switching the edited client moves the form, while adding a new client keeps it below the list', () => {
    const h = clientPanel();
    const own = { id: 'own', name: 'First', state: 'added', clientType: 'Thin', computerName: 'localhost', port: 1538 };
    const other = { ...own, id: 'other', name: 'Second' };
    h.panel.render({ rows: [own, other], defaults: { ...own, name: 'New client' }, connection: { ready: true, read: true, write: true, connect: true } }, 'C:\\QA');
    for (const row of [own, other]) {
        h.click(`[data-client-action="edit"][data-client-id="${row.id}"]`);
        h.receive({ command: 'clientEditor', infobasePath: 'C:\\QA', clientId: row.id, requestId: h.messages.at(-1).requestId, draft: row });
        const edited = h.container.querySelector(`[data-client-action="edit"][data-client-id="${row.id}"]`).closest('.v-client-row');
        assert.equal(h.container.querySelector('.v-client-editor').parentElement, edited);
    }
    h.click('[data-client-action="cancel"]');
    assert.equal(h.container.querySelector('.v-client-editor').hidden, true);
    h.click('[data-client-action="new"]');
    const editor = h.container.querySelector('.v-client-editor');
    assert.equal(editor.hidden, false);
    assert.equal(editor.closest('.v-client-row'), null);
    assert.equal(editor.parentElement, h.container.querySelector('.v-client-rows').parentElement);
});
