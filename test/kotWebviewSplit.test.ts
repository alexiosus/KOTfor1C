import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function harness(after = false, saved?: { x?: number; y?: number }) {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const attributes: Record<string, string> = {};
    const properties = new Map<string, string>();
    const persisted: Array<{ x?: number; y?: number }> = [];
    let axis = 'x';
    const separator = { setAttribute: (key: string, value: string) => { attributes[key] = value; },
        addEventListener: (key: string, handler: (event: Record<string, unknown>) => void) => handlers.set(key, handler),
        setPointerCapture() {} };
    const pane = { getBoundingClientRect: () => ({ width: Number.parseFloat(properties.get('--kot-split-width') || '300'), height: Number.parseFloat(properties.get('--kot-split-height') || '220') }) };
    const container = { dataset: { kotSplit: after ? 'after' : 'before' }, firstElementChild: pane, lastElementChild: pane,
        clientWidth: 1000, clientHeight: 600, querySelector: () => separator, classList: { add() {}, remove() {} },
        style: { setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) } };
    const context = vm.createContext({ window: { addEventListener() {} }, getComputedStyle: () => ({ getPropertyValue: (name: string) => name === '--kot-split-axis' ? axis : '160' }) });
    vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'media/kotWebviewSplit.js'), 'utf8'), context);
    const controller = context.KotWebviewSplit.attach(container, saved, (sizes: { x?: number; y?: number }) => persisted.push(sizes));
    const fire = (type: string, fields: Record<string, unknown> = {}) => handlers.get(type)!({ type, button: 0, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {}, ...fields });
    return { controller, fire, attributes, properties, persisted, container, axis: (value: string) => { axis = value; controller.update(); } };
}

test('pane dividers resize under pointer capture and persist only the completed drag', () => {
    const h = harness();
    h.fire('pointerdown'); h.fire('pointermove', { clientX: 180 });
    assert.equal(h.properties.get('--kot-split-width'), '380px');
    assert.equal(h.persisted.length, 0);
    h.fire('pointermove', { pointerId: 2, clientX: 400 });
    assert.equal(h.properties.get('--kot-split-width'), '380px');
    h.fire('pointerup'); h.fire('lostpointercapture');
    assert.equal(h.persisted.length, 1); assert.equal(h.persisted[0].x, 380);
    h.fire('pointerdown'); h.fire('pointermove', { clientX: 220 }); h.fire('pointercancel');
    assert.equal(h.properties.get('--kot-split-width'), '380px'); assert.equal(h.persisted.length, 1);
});

test('right-hand panels follow the divider and expose keyboard limits', () => {
    const h = harness(true);
    h.fire('keydown', { key: 'ArrowRight' }); assert.equal(h.persisted[0].x, 284);
    h.fire('keydown', { key: 'Home' }); assert.equal(h.persisted[1].x, 836);
    h.fire('keydown', { key: 'End' }); assert.equal(h.persisted[2].x, 160);
    assert.equal(h.attributes['aria-valuemin'], '160'); assert.equal(h.attributes['aria-valuemax'], '836');
});

test('responsive layouts retain independent width and height and restore width after shrinking', () => {
    const h = harness(false, { x: 500, y: 240 });
    h.container.clientWidth = 600; h.controller.update();
    assert.equal(h.properties.get('--kot-split-width'), '436px');
    h.axis('y'); assert.equal(h.attributes['aria-orientation'], 'horizontal');
    h.fire('keydown', { key: 'ArrowDown' }); assert.equal(h.persisted[0].y, 256); assert.equal(h.persisted[0].x, 500);
    h.container.clientWidth = 1000; h.axis('x');
    assert.equal(h.properties.get('--kot-split-width'), '500px');
    assert.equal(h.attributes['aria-orientation'], 'vertical');
});
