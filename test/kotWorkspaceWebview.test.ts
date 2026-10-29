import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

/** Minimal DOM boundary; the unmodified webview script owns handlers, requests and status updates. */
class Element {
    children: Element[] = [];
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    classes = new Set<string>();
    textContent = ''; value = ''; disabled = false; hidden = false; scrollTop = 0; inert = false;
    onclick?: () => unknown;
    classList = { toggle: (key: string, active: boolean) => { if (active) { this.classes.add(key); } else { this.classes.delete(key); } } };
    constructor(readonly id = '') {}
    set innerHTML(html: string) {
        this.children = [...html.matchAll(/<\w+\b([^>]*)>/gu)].map(([, attributes]) => {
            const element = new Element(attributes.match(/\bid="([^"]+)"/u)?.[1]);
            for (const [, key, value] of attributes.matchAll(/data-([\w-]+)="([^"]*)"/gu)) { element.dataset[key] = value; }
            return element;
        });
    }
    insertAdjacentHTML(_position: string, html: string) { const wrapper = new Element(); wrapper.innerHTML = html; this.children.push(...wrapper.children); }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    removeAttribute(key: string) { this.attributes.delete(key); }
    querySelectorAll(selector: string): Element[] {
        const key = selector.match(/^\[data-([\w-]+)\]$/u)?.[1];
        return this.children.flatMap(child => [...(key && Object.hasOwn(child.dataset, key) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(): null { return null; }
}

async function fixture(setup = false) {
    const roots = ['content', 'notice', 'brand', 'navigation', 'section-navigation', 'section-select'].map(id => new Element(id));
    const find = (id: string, elements = roots): Element | undefined => elements.find(node => node.id === id) ?? elements.map(node => find(id, node.children)).find(Boolean);
    let receive!: (event: { data: unknown }) => void;
    const messages: Array<{ id: string; type: string }> = [];
    const workbench = new Element();
    const document = { getElementById: find, addEventListener() {}, querySelector: () => workbench };
    vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'media/kotWorkspace.js'), 'utf8'), {
        document, window: { addEventListener: (_name: string, callback: typeof receive) => { receive = callback; } },
        acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (message: typeof messages[number]) => messages.push(message) })
    });
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
    const model = { strings: {}, settings: [], sections: [{ id: 'editor', title: 'Editor' }] };
    if (setup) {
        receive({ data: { type: 'boot', view: 'setup', folder: 'file:///project', folders: [{ id: 'file:///project' }], model,
            progress: { step: 5, draft: { route: 'sppr', mode: 'sppr', run: true } } } });
        receive({ data: { type: 'response', id: messages.find(message => message.type === 'reviewSetup')!.id,
            data: { id: 'review', files: [], settings: [], migrate: [], profile: '', run: true } } }); await flush();
        return { click: () => find('next')!.onclick!(), respond, messages, notice: find('notice')!, content: find('content')!, workbench, find,
            send: async (data: unknown) => { receive({ data }); await flush(); } };
    }
    receive({ data: { type: 'boot', view: 'settings', folder: '', folders: [], model } });
    const settings = messages.find(message => message.type === 'settings')!;
    receive({ data: { type: 'response', id: settings.id, data: [] } }); await flush();
    roots.find(node => node.id === 'navigation')!.querySelectorAll('[data-view]').find(button => button.dataset.view === 'help')!.onclick!();
    const click = () => find('show-tool')!.onclick!();
    async function respond(id: string, error?: string, data?: unknown) { receive({ data: { type: 'response', id, error, data } }); await flush(); }
    return { click, respond, messages, notice: find('notice')!, content: find('content')!, workbench, find,
        send: async (data: unknown) => { receive({ data }); await flush(); } };
}

test('Show in VS Code clears its progress after the tool opens', async () => {
    const h = await fixture(); const operation = h.click();
    assert.equal(h.notice.textContent, 'Opening tool…'); assert.equal(h.content.attributes.get('aria-busy'), 'true');
    await h.respond(h.messages.at(-1)!.id); await operation;
    assert.equal(h.notice.textContent, ''); assert.equal(h.content.attributes.has('aria-busy'), false);
});

test('a failed tool opening retains the error after busy state ends', async () => {
    const h = await fixture(); const operation = h.click();
    await h.respond(h.messages.at(-1)!.id, 'Tool is unavailable'); await operation;
    assert.equal(h.notice.textContent, 'Tool is unavailable'); assert.equal(h.notice.classes.has('notice-error'), true);
    assert.equal(h.content.attributes.has('aria-busy'), false);
});

test('completion of an older tool request leaves the newer request in progress', async () => {
    const h = await fixture(); const first = h.click(); const firstId = h.messages.at(-1)!.id;
    const second = h.click(); const secondId = h.messages.at(-1)!.id;
    await h.respond(firstId); await first;
    assert.equal(h.notice.textContent, 'Opening tool…'); assert.equal(h.content.attributes.get('aria-busy'), 'true');
    await h.respond(secondId); await second;
    assert.equal(h.notice.textContent, ''); assert.equal(h.content.attributes.has('aria-busy'), false);
});

test('applying setup leaves the page scrollable and restores controls after failure', async () => {
    const h = await fixture(true); h.click();
    assert.equal(h.workbench.inert, false);
    assert.equal(h.find('next')!.disabled, true);
    assert.equal(h.find('back')!.disabled, true);
    await h.respond(h.messages.find(message => message.type === 'applySetup')!.id, 'Migration failed');
    assert.equal(h.find('next')!.disabled, false);
    assert.equal(h.find('back')!.disabled, false);
    assert.equal(h.notice.textContent, 'Migration failed');
});

test('setup progress shows file counts only for the current application', async () => {
    const h = await fixture(true); h.click();
    const id = h.messages.find(message => message.type === 'applySetup')!.id;
    await h.send({ type: 'setupProgress', id: 'older', label: 'Wrong operation', completed: 50, total: 100 });
    assert.notEqual(h.notice.textContent, 'Wrong operation');
    await h.send({ type: 'setupProgress', id, label: 'Migrating project metadata…', completed: 42, total: 100 });
    assert.match(h.notice.textContent, /Migrating project metadata.*42.*100/u);
    await h.respond(id, 'Migration failed');
    await h.send({ type: 'setupProgress', id, label: 'Late progress', completed: 80, total: 100 });
    assert.equal(h.notice.textContent, 'Migration failed');
});

test('finished setup opens the ready page while Vanessa preparation is still pending', async () => {
    const h = await fixture(true); h.click();
    h.click();
    assert.equal(h.messages.filter(message => message.type === 'applySetup').length, 1);
    await h.respond(h.messages.find(message => message.type === 'applySetup')!.id, undefined, { complete: true, executionReady: false });
    assert.ok(h.find('example'));
    assert.equal(h.find('example')!.disabled, false);
    assert.equal(h.workbench.inert, false);
    assert.equal(h.find('execution-state')!.attributes.get('aria-busy'), 'true');
    assert.equal(h.messages.filter(message => message.type === 'retryExecution').length, 1);
    await h.respond(h.messages.find(message => message.type === 'retryExecution')!.id, 'Vanessa failed');
    assert.equal(h.find('execution-state')!.attributes.get('aria-busy'), 'false');
    assert.ok(h.find('retry-execution'));
    assert.equal(h.notice.textContent, 'Vanessa failed');
});
