import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const script = fs.readFileSync(path.join(process.cwd(), 'media/kotWebviewText.js'), 'utf8');
function getFunction(name: string, next: string, context: Record<string, unknown>) {
    const start = script.indexOf(`    function ${name}(`); const end = script.indexOf(`    function ${next}(`, start);
    assert.ok(start >= 0 && end > start, `${name} must exist`);
    return vm.runInNewContext(`${script.slice(start, end)}\n${name}`, context);
}

test('native dropdown selections never receive a scrolling overlay', () => {
    const mirror = getFunction('mirror', 'refresh', {
        controls: new WeakMap(), document: { createElement() { throw new Error('native SELECT must remain a native control'); } }
    });
    mirror({ tagName: 'SELECT', type: 'select-one' });
});

test('left overflow fade appears only after the text has moved away from its start', () => {
    const classes = new Set<string>();
    const element = { getBoundingClientRect: () => ({ left: 10, right: 110 }), classList: { toggle: (name: string, enabled: boolean) => { if (enabled) { classes.add(name); } else { classes.delete(name); } } } };
    let trackLeft = 10;
    const track = { getBoundingClientRect: () => ({ left: trackLeft, right: trackLeft + 180 }) };
    const sync = getFunction('updateScrollFade', 'measure', {});
    sync(element, track); assert.equal(classes.has('kot-text-scrolled'), false);
    trackLeft = -12; sync(element, track); assert.equal(classes.has('kot-text-scrolled'), true);
    trackLeft = 10; sync(element, track); assert.equal(classes.has('kot-text-scrolled'), false);
});

test('overflow fades never cover the first or last letters at either scroll endpoint', () => {
    const classes = new Set<string>();
    const element = { getBoundingClientRect: () => ({ left: 10, right: 110 }), classList: { toggle: (name: string, enabled: boolean) => { if (enabled) { classes.add(name); } else { classes.delete(name); } } } };
    let left = 10;
    const track = { getBoundingClientRect: () => ({ left, right: left + 180 }) };
    const sync = getFunction('updateScrollFade', 'measure', {});
    for (const [position, fadedLeft, fadedRight] of [[10, false, true], [-30, true, true], [-70, true, false], [10, false, true]] as const) {
        left = position; sync(element, track);
        assert.equal(classes.has('kot-text-scrolled'), fadedLeft);
        assert.equal(classes.has('kot-text-more-right'), fadedRight);
    }
});

function textHarness(count: number) {
    const frames: Array<() => void> = []; const events: string[] = []; const roots: any[] = [];
    class Element {
        children: Element[] = []; parentNode: Element | null = null; textContent = 'Long caption'; nodeType = 1; type = ''; tagName = 'SPAN';
        className = ''; private classes = new Set<string>();
        classList = { contains: (name: string) => this.classes.has(name), add: (name: string) => { this.classes.add(name); },
            toggle: (name: string, enabled: boolean) => { events.push('write'); if (enabled) { this.classes.add(name); } else { this.classes.delete(name); } } };
        style = { setProperty: () => { events.push('write'); } };
        get firstElementChild() { return this.children[0]; }
        get scrollWidth() { events.push(`read:${roots.indexOf(this.parentNode)}`); return 200; }
        get clientWidth() { events.push(`read:${roots.indexOf(this)}`); return 100; }
        getClientRects() { events.push(`read:${roots.indexOf(this)}`); return [{}]; }
        getBoundingClientRect() { events.push(`read:${roots.indexOf(this.parentNode ?? this)}`); return { left: 0, right: this.parentNode ? 200 : 100 }; }
        replaceChildren(child: Element) { this.children = [child]; child.parentNode = this; }
        addEventListener() { /* Captions have no input interaction in this test. */ }
        querySelectorAll(selector: string) { return selector === '.caption' ? roots : []; }
        contains(element: Element) { return roots.includes(element); }
    }
    for (let i = 0; i < count; i++) { roots.push(new Element()); }
    let intersect!: (entries: Array<{target: Element; isIntersecting: boolean}>) => void;
    const document = { body: new Element(), createElement: () => new Element() };
    const window: any = { addEventListener() {} };
    vm.runInNewContext(script, { window, document, HTMLElement: Element, Node: { TEXT_NODE: 3 }, requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
        MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} unobserve() {} },
        IntersectionObserver: class { constructor(callback: typeof intersect) { intersect = callback; } observe() {} unobserve() {} } });
    return { roots, events, refresh: () => window.KotWebviewText.refresh(document.body, '.caption'), visible: (indices: number[]) => intersect(indices.map(i => ({ target: roots[i], isIntersecting: true }))),
        flush: () => { const pending = frames.splice(0); for (const callback of pending) { callback(); } } };
}

test('large webviews measure scrolling captions only when visible, with geometry reads batched before style writes', () => {
    const own = textHarness(1000); own.refresh(); own.flush();
    assert.equal(own.events.filter(event => event.startsWith('read:')).length, 0, 'offscreen captions must not force layouts');
    own.visible([0, 1]); own.events.length = 0; own.flush();
    const reads = own.events.filter(event => event.startsWith('read:'));
    assert.ok(reads.length > 0); assert.ok(reads.every(event => event === 'read:0' || event === 'read:1'));
    const firstWrite = own.events.indexOf('write'); assert.ok(firstWrite > 0);
    assert.ok(own.events.slice(firstWrite).every(event => event === 'write'), 'one caption must not invalidate layout before the next caption is measured');
});
