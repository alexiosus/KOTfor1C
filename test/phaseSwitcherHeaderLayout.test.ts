import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { HTMLElement, parse } from 'node-html-parser';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), 'media', file), 'utf8');
const script = read('phaseSwitcher.js');
const styles = ['kotWebviewTheme.css', 'phaseSwitcher.css', 'kotSidebar.css', 'standaloneFeatures.css']
    .map(read).join('\n').replace(/\/\*[\s\S]*?\*\/|@import[^;]+;/gu, '');

test('ordering grippers overlay existing rows and mouse focus does not keep them visible', () => {
    for (const className of ['phase-header', 'standalone-features']) {
        const root = parse(`<div class="${className} kot-tree-row" data-focus-within><button><span class="project-order-drag-handle"></span></button></div>`);
        const handle = root.querySelector('.project-order-drag-handle')!;
        assert.equal(cssValue(handle, 'position'), 'absolute');
        assert.equal(cssValue(handle, 'opacity'), '0');
        root.querySelector('button')!.setAttribute('data-focus-visible', '');
        assert.equal(cssValue(handle, 'opacity'), '1');
    }
});

test('the group ordering gripper fits before the disclosure without reserving a grid column', () => {
    const root = parse('<div class="scenario-section-groups"><div class="phase-header kot-tree-row"><button class="phase-expand-collapse-btn"></button><span class="project-order-drag-handle"></span></div></div>');
    const row = root.querySelector('.phase-header')!;
    const handle = root.querySelector('.project-order-drag-handle')!;
    const handleStart = Number.parseFloat(cssValue(handle, 'inset-inline-start')!);
    const handleEnd = handleStart + Number.parseFloat(cssValue(handle, 'width')!);
    const disclosureStart = Number.parseFloat(cssValue(row, 'padding-inline-start') ?? cssValue(row, 'padding-inline')!);
    assert.ok(handleStart >= 0, 'the drag target must be inside the row background and hover area');
    assert.ok(handleEnd <= disclosureStart - 4, 'the drag target must end before the disclosure with a gap');
    assert.equal(Number.parseFloat(cssValue(root.firstChild as HTMLElement, 'padding-inline-start') ?? '0')
        + Number.parseFloat(cssValue(row, 'margin-inline-start') ?? '0') + disclosureStart, 22, 'the disclosure keeps its original position in the section');
    assert.equal(cssValue(handle, 'position'), 'absolute');
    assert.equal(cssValue(row, 'grid-template-columns'), '18px 18px minmax(0, 1fr) auto');
});

test('nested row backgrounds share the group edge while their content remains indented', () => {
    const root = parse(`<div class="scenario-section-groups phase-tests-list expanded"><div class="phase-group">
        <div class="phase-header kot-tree-row"><span class="project-order-drag-handle"></span></div>
        <div class="phase-tests-list expanded"><div class="item-container">
            <label class="checkbox-item kot-tree-row"><button class="scenario-resource-toggle"></button><span class="project-order-drag-handle"></span></label>
            <div class="scenario-resource-tree"><div class="scenario-resource-row"></div></div>
        </div></div>
    </div></div>`);
    const group = root.querySelector('.phase-header')!;
    const item = root.querySelector('label')!;
    assert.equal(cssValue(root.firstChild as HTMLElement, 'padding-inline-start'), '0');
    assert.equal(Number.parseFloat(cssValue(group, 'margin-inline-start') ?? '0'), 0);
    assert.equal(Number.parseFloat(cssValue(item, 'margin-inline-start') ?? '0'), 0);
    assert.equal(cssValue(item, 'padding-inline-start'), '66px', 'only the contents carry the test hierarchy indentation');
    assert.equal(cssValue(root.querySelector('.scenario-resource-toggle')!, 'inset-inline-start'), '40px');
    assert.equal(cssValue(root.querySelector('label .project-order-drag-handle')!, 'inset-inline-start'), '18px');
    assert.equal(cssValue(root.querySelector('.scenario-resource-row')!, 'padding-inline-start'), 'calc(63px + (var(--resource-depth, 1) * 15px))');
});

test('clicking the ordering overlay preserves the underlying native disclosure action', () => {
    const start = script.indexOf('    function bindProjectOrderingHandle(');
    const end = script.indexOf('    function bindProjectOrderingTarget(', start);
    assert.ok(start >= 0 && end > start);
    for (const [type, selector] of [['group', '.phase-expand-collapse-btn'], ['item', '.scenario-resource-toggle']]) {
        const listeners = new Map<string, (event: unknown) => void>();
        let clicks = 0;
        const handle = { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
            closest: () => ({ querySelector: (target: string) => target === selector ? { click: () => { clicks++; } } : null }) };
        vm.runInNewContext(script.slice(start, end) + '; bindProjectOrderingHandle(handle, source);', { handle, source: { type }, clearProjectOrderingDrag() {} });
        listeners.get('click')!({ preventDefault() {}, stopPropagation() {} });
        assert.equal(clicks, 1, type);
    }
});

// Resolve the cascade against real parsed markup, including the theme imported
// by phaseSwitcher.css and the shared stylesheet loaded after it.
function cssValue(element: HTMLElement, property: string): string | undefined {
    let winner: { specificity: number; important: boolean; value: string } | undefined;
    for (const rule of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        const declaration = rule[2].match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'u'))?.[1].trim();
        if (!declaration) { continue; }
        for (const original of rule[1].split(',')) {
            const selector = original.trim().replace(/:(focus-visible|focus-within|hover|focus|active|root)\b/gu, '[data-$1]')
                .replace(/:disabled\b/gu, '[disabled]');
            let matches = false;
            try { matches = element.matches(selector); } catch { continue; }
            if (!matches) { continue; }
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
    return winner?.value;
}

function header(state: 'idle' | 'hover' | 'focus', disabled = false) {
    const root = parse(`<div class="phase-header kot-tree-row" ${state === 'hover' ? 'data-hover' : ''}>
        <button class="phase-expand-collapse-btn" ${state === 'focus' ? 'data-focus-visible' : ''}></button>
        <input type="checkbox" class="phase-select-checkbox">
        <button class="phase-label-button"><span class="phase-folder-icon"></span><span class="phase-title kot-tree-label"><span class="kot-scroll-content"></span></span></button>
        <button class="phase-create-main-btn toolbar-btn ghost-btn icon-only kot-icon-button" ${disabled ? 'disabled' : ''}></button>
        <span class="phase-count-cluster"><span class="phase-test-count kot-tree-count">0/1</span></span>
    </div>`);
    return { row: root.firstChild as HTMLElement, create: root.querySelector('.phase-create-main-btn')! };
}

function labelWidth(row: HTMLElement, create: HTMLElement): number {
    const columns = cssValue(row, 'grid-template-columns')!.match(/minmax\([^)]*\)|[\d.]+px|auto/gu)!;
    const visibleItemWidths = [18, 18, 0, ...(cssValue(create, 'display') === 'none' ? [] : [24]), 20];
    const occupied = columns.reduce((sum, column, index) => sum + (column === 'auto'
        ? visibleItemWidths[index] ?? 0 : column.endsWith('px') ? Number.parseFloat(column) : 0), 0);
    // A 260px row has 4px inline padding, a 16px folder, and a 5px icon/title gap.
    return 260 - 8 - occupied - Number.parseFloat(cssValue(row, 'gap')!) * (columns.length - 1) - 21;
}

class OverflowElement {
    readonly classes = new Set<string>();
    readonly properties = new Map<string, string>();
    content?: OverflowElement;
    row?: OverflowElement;
    labels: OverflowElement[] = [];
    clientWidth = 100;
    scrollWidth = 100;
    classList = { toggle: (name: string, enabled: boolean) => { if (enabled) { this.classes.add(name); } else { this.classes.delete(name); } } };
    style = { setProperty: (name: string, value: string) => { this.properties.set(name, value); } };
    querySelector(): OverflowElement | undefined { return this.content; }
    querySelectorAll(): OverflowElement[] { return this.labels; }
    closest(): OverflowElement | undefined { return this.row; }
}

function overflowHarness() {
    const start = script.indexOf('    function updateScenarioLabelOverflowFor(');
    const end = script.indexOf('    function updateScenarioLabelOverflow()', start);
    assert.ok(start >= 0 && end > start);
    const update = vm.runInNewContext(`(${script.slice(start, end).trim()})`, { HTMLElement: OverflowElement }) as (label: OverflowElement) => void;
    const label = new OverflowElement();
    label.content = new OverflowElement();
    return { update, label, content: label.content };
}

test('group text uses the hidden creation button space up to the count', () => {
    const h = header('idle');
    assert.equal(cssValue(h.row, 'display'), 'grid', 'shared row styles preserve the group grid');
    assert.equal(labelWidth(h.row, h.create), 163);
    const overflow = overflowHarness();
    overflow.label.clientWidth = labelWidth(h.row, h.create);
    overflow.content.scrollWidth = 150;
    overflow.update(overflow.label);
    assert.equal(overflow.label.classes.has('is-overflowing'), false, 'text fitting before the count has no fade');
});

test('enabled group creation reveals on hover and keyboard focus with its own space', () => {
    for (const state of ['hover', 'focus'] as const) {
        const h = header(state);
        assert.notEqual(cssValue(h.create, 'display'), 'none', state);
        assert.equal(cssValue(h.create, 'opacity'), '1', state);
        assert.equal(cssValue(h.create, 'pointer-events'), 'auto', state);
        assert.equal(labelWidth(h.row, h.create), 135, state);
    }
});

test('build-disabled creation buttons stay hidden in every interaction state', () => {
    for (const state of ['idle', 'hover', 'focus'] as const) {
        const h = header(state, true);
        assert.equal(cssValue(h.create, 'display'), 'none', `${state}: the disabled theme cannot reveal creation`);
        assert.equal(labelWidth(h.row, h.create), 163, state);
    }
});

test('text that fits the label does not acquire a fade or scroll distance', () => {
    const h = overflowHarness();
    for (const width of [90, 99, 100, 101]) {
        h.content.scrollWidth = width;
        h.update(h.label);
        assert.equal(h.label.classes.has('is-overflowing'), false, `${width}px respects a 1px rounding tolerance`);
        assert.equal(h.label.properties.get('--kot-overflow-distance'), '0px', `${width}px`);
    }
});

test('real label overflow scrolls past its clipped edge and clears when space grows', () => {
    const h = overflowHarness();
    h.content.scrollWidth = 130;
    h.update(h.label);
    assert.equal(h.label.classes.has('is-overflowing'), true);
    assert.equal(h.label.properties.get('--kot-overflow-distance'), '42px');
    h.label.clientWidth = 140;
    h.update(h.label);
    assert.equal(h.label.classes.has('is-overflowing'), false);
    assert.equal(h.label.properties.get('--kot-overflow-distance'), '0px');
});

test('keyboard focus updates label overflow as creation controls reveal and hide', () => {
    const h = overflowHarness();
    const row = new OverflowElement();
    row.labels = [h.label];
    h.label.row = row;
    h.content.scrollWidth = 150;
    const listeners = new Map<string, (event: { target: OverflowElement }) => void>();
    const phaseTreeContainer = { addEventListener: (event: string, listener: (event: { target: OverflowElement }) => void) => { listeners.set(event, listener); } };
    const start = script.indexOf('    if (phaseTreeContainer) {\n        const refreshHoveredScenarioOverflow');
    const end = script.indexOf('    if (openVanessaBtn instanceof HTMLButtonElement)', start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(script.slice(start, end), {
        phaseTreeContainer, Element: OverflowElement,
        requestAnimationFrame: (callback: () => void) => callback(), updateScenarioLabelOverflowFor: h.update
    });
    h.label.clientWidth = 135;
    assert.ok(listeners.has('focusin'), 'keyboard entry into the group schedules overflow refresh');
    listeners.get('focusin')!({ target: h.label });
    assert.equal(h.label.classes.has('is-overflowing'), true);
    h.label.clientWidth = 163;
    assert.ok(listeners.has('focusout'), 'keyboard exit from the group schedules overflow refresh');
    listeners.get('focusout')!({ target: h.label });
    assert.equal(h.label.classes.has('is-overflowing'), false);
});
