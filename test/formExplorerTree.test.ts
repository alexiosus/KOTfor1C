import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'node-html-parser';
const script = fs.readFileSync('media/formExplorer.js', 'utf8');
const field = (name: string) => ({ path: 'Form.Parent.' + name, name, title: name, kind: 'field', visible: true, children: [] });
function tree(state: Record<string, unknown>) {
    const start = script.indexOf('    function filterElementTree('); const end = script.indexOf('    function findElementByPath(', start);
    const context = vm.createContext({ uiState: { showTechnical: true, showGroups: true, showInvisible: false, collapsedPaths: [], searchQuery: '', ...state },
        isTechnicalElement: () => false, isGroupElement: (row: any) => row.kind === 'group', isElementHiddenByTypeFilter: () => false,
        elementMatchesQuery: (row: any, query: string) => [row.title, row.name].some(text => text.toLowerCase().includes(query)) });
    vm.runInContext(script.slice(start, end), context);
    return { filter: context.filterElementTree, flatten: context.flattenElements };
}
const group = { path: 'Form.Parent', name: 'Parent', title: 'Parent', kind: 'group', visible: true, children: [field('Price'), field('Name')] };
test('form groups retain hierarchy, can collapse, and search expands matching paths without unrelated siblings', () => {
    const closed = tree({ collapsedPaths: ['Form.Parent'] }); assert.deepEqual(Array.from(closed.flatten([group]), (row: any) => row.element.name), ['Parent']);
    const searched = tree({ collapsedPaths: ['Form.Parent'], searchQuery: 'price' });
    const rows = searched.flatten(searched.filter([group], 'price'));
    assert.deepEqual(Array.from(rows, (row: any) => [row.element.name, row.depth]), [['Parent', 0], ['Price', 1]]);
});
test('elements of an invisible parent never leak out as visible top-level search results', () => {
    const own = tree({}); assert.equal(own.flatten(own.filter([{ ...group, visible: false }], '')).length, 0);
});
test('selecting an already visible outline row does not request scrolling it to the center', () => {
    const selection = script.slice(script.indexOf("if (action === 'select-element')"), script.indexOf("if (action === 'focus-active')"));
    assert.ok(!selection.includes('pendingScrollPath = uiState.selectedElementPath'));
    assert.match(selection, /followActive = false/u);
});

test('row selection does not fold a group; the expander does not select it', () => {
    const start = script.indexOf("            const action = String(target.dataset.action || '');");
    const end = script.indexOf("            if (action === 'focus-active')", start);
    const uiState = { selectedElementPath: group.children[0].path, followActive: false, collapsedPaths: [] as string[] };
    const context = vm.createContext({ uiState, viewState: { snapshot: { elements: [group] } }, overflowMenuOpen: false,
        target: { dataset: { action: 'select-element', path: group.path } }, event: { preventDefault: () => {} },
        renderOverflowMenu: () => {}, persistUiState: () => {}, render: () => {},
        findElementByPath: () => group, refs: { elementTree: { querySelector: () => ({ focus: () => {} }) } }, CSS: { escape: (text: string) => text } });
    const click = new vm.Script('(function(){' + script.slice(start, end) + '})()');
    click.runInContext(context);
    assert.equal(uiState.selectedElementPath, group.path); assert.deepEqual(Array.from(uiState.collapsedPaths), []);
    uiState.selectedElementPath = group.children[0].path;
    context.target.dataset.action = 'toggle-element';
    click.runInContext(context);
    assert.equal(uiState.selectedElementPath, group.children[0].path); assert.deepEqual(Array.from(uiState.collapsedPaths), [group.path]);
    click.runInContext(context);
    assert.equal(uiState.selectedElementPath, group.children[0].path); assert.deepEqual(Array.from(uiState.collapsedPaths), []);
});

test('group arrow is a separate accessible button and leaf rows have no fold action', () => {
    const start = script.indexOf('    function renderOutlineRow('); const end = script.indexOf('    function renderAttributeCard(', start);
    const context = vm.createContext({ uiState: { selectedElementPath: '', searchQuery: '', collapsedPaths: [] },
        getElementLabel: (row: any) => row.title, renderStateChips: () => '', collectOutlineChips: () => [],
        escapeHtml: (text: string) => text, t: (_key: string, fallback: string) => fallback });
    vm.runInContext(script.slice(start, end), context);
    const html = parse(context.renderOutlineRow(group, 0, '', new Map()));
    const row = html.querySelector('[data-action="select-element"]')!;
    assert.notEqual(row.tagName, 'BUTTON', 'the expander cannot be nested inside a row button');
    const arrow = row.querySelector('[data-action="toggle-element"]')!;
    assert.equal(arrow?.tagName, 'BUTTON'); assert.match(arrow.getAttribute('aria-label')!, /Collapse group/u);
    const leaf = parse(context.renderOutlineRow(group.children[0], 1, '', new Map()));
    assert.equal(leaf.querySelector('[data-action="toggle-element"]'), null);
});

test('collapsing a selected child’s parent preserves its selection across renders and does not select another element', () => {
    const start = script.indexOf('    function render()'); const end = script.indexOf('    function renderStaticFrame(', start);
    const chainStart = script.indexOf('    function findElementPathChain('); const chainEnd = script.indexOf('    function findTableElementByBoundPath(', chainStart);
    const uiState = { selectedElementPath: group.children[0].path, followActive: false, searchQuery: '', collapsedPaths: [group.path] };
    const noop = () => {};
    const context = vm.createContext({ uiState, viewState: { snapshot: { elements: [group], attributes: [] } },
        renderStaticFrame: noop, renderBanner: noop, renderEmptyView: noop, notifySelectionChanged: noop, findActiveElementPath: () => null,
        normalizeQuery: () => '', filterElementTree: (rows: unknown) => rows, flattenElements: () => [{ element: group }],
        findElementByPath: (_rows: unknown, path: string) => path === group.path ? group : group.children[0],
        persistUiState: noop, maybeRequestAutoTableSnapshot: noop, renderSidebar: noop, renderElementTree: noop,
        renderSelectedElementHeader: noop, renderElementDetails: noop, renderAttributes: noop, renderCommands: noop,
        setText: noop, refs: {}, renderTabs: noop, scrollPendingSelectionIntoView: noop, syncAutoScrollText: noop, document: { body: {} } });
    vm.runInContext(script.slice(chainStart, chainEnd) + script.slice(start, end), context);
    context.render(); assert.equal(uiState.selectedElementPath, group.children[0].path);
    context.viewState.snapshot = { elements: [{ ...group, children: [] }], attributes: [] };
    context.render(); assert.equal(uiState.selectedElementPath, group.path, 'a removed element still needs the ordinary selection fallback');
});


test('outline indentation is applied through the DOM when webview CSP rejects inline style attributes', () => {
    const start = script.indexOf('    function applyOutlineDepths(');
    assert.ok(start >= 0, 'outline needs CSP-compatible depth application');
    const end = script.indexOf('    function captureOutlineScrollAnchor(', start);
    const depths: string[] = [];
    const rows = [1, 2, 4].map(level => ({ getAttribute: () => String(level), style: { setProperty: (key: string, value: string) => { assert.equal(key, '--depth'); depths.push(value); } } }));
    const context = vm.createContext({}); vm.runInContext(script.slice(start, end), context);
    context.applyOutlineDepths({ querySelectorAll: () => rows });
    assert.deepEqual(depths, ['0', '1', '3']);
});

test('native steps allow free selection in a read-only textarea, hide stale text and have no manual fetch controls', () => {
    const start = script.indexOf('    function renderSuggestedStepsSection(');
    const end = script.indexOf('    function renderSuggestedStepsBody(', start);
    const viewState = { liveSource: 'mcp', nativeStepsAvailable: true, nativeSteps: { forPath: 'Form.A', text: 'And first\nAnd second <&>' } };
    const context = vm.createContext({ viewState, uiState: {}, t: (_key: string, fallback: string) => fallback,
        escapeHtml: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        renderEmptyState: (text: string) => text,
        renderSectionCard: (_title: string, body: string, options: { headerActionsHtml?: string }) => body + (options.headerActionsHtml ?? '') });
    vm.runInContext(script.slice(start, end), context);
    const html = context.renderSuggestedStepsSection({ path: 'Form.A' });
    assert.match(html, /<textarea[^>]*readonly/u); assert.match(html, /And first\nAnd second &lt;&amp;&gt;/u);
    assert.doesNotMatch(html, /gherkin-inline-copy|toggle-auto-native|read-native-steps|native-form-checks/u);
    assert.doesNotMatch(context.renderSuggestedStepsSection({ path: 'Form.B' }), /And first/u);
});

test('collapsing and reopening native steps is local and sends no selection or MCP request', () => {
    const start = script.indexOf("            if (action === 'toggle-suggested-steps')");
    const end = script.indexOf("            if (action === 'native-form-checks')", start);
    for (const mode of ['mcp', 'snapshot']) {
        const posts: string[] = [];
        const context = vm.createContext({ action: 'toggle-suggested-steps',
            uiState: { suggestedStepsExpanded: true, selectedElementPath: 'Form.A' }, viewState: { liveSource: mode },
            persistUiState: () => {}, toggleSectionCard: () => true, post: (command: string) => posts.push(command) });
        const toggle = new vm.Script('(function(){' + script.slice(start, end) + '})()');
        toggle.runInContext(context); toggle.runInContext(context);
        assert.equal(context.uiState.suggestedStepsExpanded, true);
        assert.deepEqual(posts, mode === 'mcp' ? [] : ['selectElementPath']);
    }
});
