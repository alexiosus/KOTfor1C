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
