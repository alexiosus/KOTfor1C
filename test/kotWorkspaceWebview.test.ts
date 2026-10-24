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
    textContent = ''; value = ''; disabled = false; hidden = false; scrollTop = 0;
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
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    removeAttribute(key: string) { this.attributes.delete(key); }
    querySelectorAll(selector: string): Element[] {
        const key = selector.match(/^\[data-([\w-]+)\]$/u)?.[1];
        return this.children.flatMap(child => [...(key && Object.hasOwn(child.dataset, key) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(): null { return null; }
}

async function fixture() {
    const roots = ['content', 'notice', 'brand', 'navigation', 'section-navigation', 'section-select'].map(id => new Element(id));
    const find = (id: string, elements = roots): Element | undefined => elements.find(node => node.id === id) ?? elements.map(node => find(id, node.children)).find(Boolean);
    let receive!: (event: { data: unknown }) => void;
    const messages: Array<{ id: string; type: string }> = [];
    const document = { getElementById: find, addEventListener() {} };
    vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'media/kotWorkspace.js'), 'utf8'), {
        document, window: { addEventListener: (_name: string, callback: typeof receive) => { receive = callback; } },
        acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: (message: typeof messages[number]) => messages.push(message) })
    });
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
    receive({ data: { type: 'boot', view: 'settings', folder: '', folders: [], model: { strings: {}, settings: [], sections: [{ id: 'editor', title: 'Editor' }] } } });
    const settings = messages.find(message => message.type === 'settings')!;
    receive({ data: { type: 'response', id: settings.id, data: [] } }); await flush();
    roots.find(node => node.id === 'navigation')!.querySelectorAll('[data-view]').find(button => button.dataset.view === 'help')!.onclick!();
    const click = () => find('show-tool')!.onclick!();
    const respond = async (id: string, error?: string) => { receive({ data: { type: 'response', id, error } }); await flush(); };
    return { click, respond, messages, notice: find('notice')!, content: find('content')! };
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
