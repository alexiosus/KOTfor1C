import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = (relativePath: string): string => fs.readFileSync(
    path.join(process.cwd(), relativePath),
    'utf8'
);

const html = read('media/phaseSwitcher.html');
const script = read('media/phaseSwitcher.js');
const provider = read('src/phaseSwitcher.ts');
const phaseCss = read('media/phaseSwitcher.css');
const sharedCssPath = path.join(process.cwd(), 'media', 'kotSidebar.css');

test('all KOT view containers compose one common non-duplicated title', () => {
    const manifest = JSON.parse(read('package.json')) as {
        contributes: {
            viewsContainers: { activitybar: Array<{ id: string; title: string }> };
            views: Record<string, Array<{ id: string; name: string; contextualTitle?: string }>>;
        };
    };
    const english = JSON.parse(read('package.nls.json')) as Record<string, string>;
    const russian = JSON.parse(read('package.nls.ru.json')) as Record<string, string>;

    const kotContainers = manifest.contributes.viewsContainers.activitybar
        .filter(container => ['kotTestToolkitContainer', 'kotTestToolkitLibraryContainer'].includes(container.id));
    assert.equal(kotContainers.length, 2);
    assert.deepEqual(kotContainers.map(container => container.title), [
        '%ext.displayName%',
        '%ext.displayName%'
    ]);

    const kotViews = Object.values(manifest.contributes.views)
        .flat()
        .filter(view => [
            'kotTestToolkit.phaseSwitcherView',
            'kotTestToolkit.stepLibrarySidebarView',
            'kotTestToolkit.infobaseSidebarView'
        ].includes(view.id));
    assert.equal(kotViews.length, 3);
    assert.deepEqual(kotViews.map(view => view.contextualTitle), [
        'KOT for 1C',
        'KOT for 1C',
        'KOT for 1C'
    ]);

    assert.equal(english['ext.displayName'], 'KOT for 1C');
    assert.ok(!Object.keys(english).some(key => key.endsWith('.contextualTitle')));
    assert.ok(!Object.keys(russian).some(key => key.endsWith('.contextualTitle')));
    assert.deepEqual([
        english['view.phaseSwitcher.name'],
        english['view.stepLibrary.name'],
        english['view.infobases.name']
    ], ['Test Manager', 'Library', 'Infobases']);
    assert.deepEqual([
        russian['view.phaseSwitcher.name'],
        russian['view.stepLibrary.name'],
        russian['view.infobases.name']
    ], ['Менеджер тестов', 'Библиотека', 'Информационные базы']);

});

function resolveClassOnlyCssProperty(
    stylesheets: readonly string[],
    classNames: readonly string[],
    property: string
): string | undefined {
    let order = 0;
    let winner: { important: boolean; specificity: number; order: number; value: string } | undefined;
    const propertyPattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'iu');

    for (const stylesheet of stylesheets) {
        for (const match of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gsu)) {
            for (const rawSelector of match[1].split(',')) {
                const selector = rawSelector.trim();
                const selectorClasses = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/gu)]
                    .map(classMatch => classMatch[1]);
                const isClassOnly = selectorClasses.length > 0
                    && selector.replace(/\.[A-Za-z0-9_-]+/gu, '').trim() === '';
                const declaration = match[2].match(propertyPattern)?.[1]?.trim();
                order += 1;
                if (!isClassOnly || !declaration || !selectorClasses.every(name => classNames.includes(name))) {
                    continue;
                }

                const important = /!important\s*$/iu.test(declaration);
                const candidate = {
                    important,
                    specificity: selectorClasses.length,
                    order,
                    value: declaration.replace(/\s*!important\s*$/iu, '').trim()
                };
                if (!winner
                    || Number(candidate.important) > Number(winner.important)
                    || (candidate.important === winner.important && candidate.specificity > winner.specificity)
                    || (candidate.important === winner.important
                        && candidate.specificity === winner.specificity
                        && candidate.order > winner.order)) {
                    winner = candidate;
                }
            }
        }
    }

    return winner?.value;
}

test('Test Manager loads the shared native sidebar stylesheet', () => {
    assert.match(html, /<link href="\$\{sidebarStylesUri\}" rel="stylesheet">/u);
    assert.match(provider, /media', 'kotSidebar\.css'/u);
    assert.match(provider, /replace\('\$\{sidebarStylesUri\}', sidebarStylesUri\.toString\(\)\)/u);
    assert.equal(fs.existsSync(sharedCssPath), true);
});

test('Test Manager group headers keep their four-column grid after the shared tree stylesheet loads', () => {
    assert.equal(
        resolveClassOnlyCssProperty(
            [phaseCss, read('media/kotSidebar.css')],
            ['phase-header', 'kot-tree-row'],
            'display'
        ),
        'grid'
    );
});

test('Test Manager reveals the group create button on hover or visible keyboard focus, not retained pointer focus', () => {
    const stabilizedCss = phaseCss.slice(phaseCss.lastIndexOf('/* Activity Bar stabilization'));

    assert.match(
        stabilizedCss,
        /\.phase-create-main-btn\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/isu
    );
    assert.match(
        stabilizedCss,
        /\.phase-header:hover\s+\.phase-create-main-btn:not\(:disabled\),\s*\.phase-header:has\(:focus-visible\)\s+\.phase-create-main-btn:not\(:disabled\)\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/isu
    );
    assert.doesNotMatch(
        stabilizedCss,
        /\.phase-header:focus-within\s+\.phase-create-main-btn/iu
    );
});

test('shared tree primitives prevent horizontal overflow without reserving an empty action gutter', () => {
    const css = read('media/kotSidebar.css');
    assert.match(css, /\.kot-tree\s*\{[^}]*overflow-x:\s*hidden/isu);
    assert.match(css, /\.kot-tree-label\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/isu);
    assert.doesNotMatch(css, /\.kot-row-actions\s*\{[^}]*var\(--kot-sidebar-action-gutter\)/isu);
    assert.match(css, /\.kot-row-actions\s*\{[^}]*flex:\s*0\s+0\s+auto/isu);
    assert.match(css, /\.kot-tree-row\s*\{[^}]*min-height:\s*(?:30|31|32)px/isu);
    assert.match(css, /\.kot-icon-button\s*\{[^}]*min-height:\s*(?:28|29|30)px/isu);
    assert.match(phaseCss, /\.phase-tree-container\s*\{[^}]*overflow-x:\s*hidden/isu);
});

test('overflowing sidebar labels do not stay translated after pointer focus', () => {
    const css = read('media/kotSidebar.css');

    assert.match(
        css,
        /\.kot-tree-row:hover\s+\.kot-tree-label\.is-overflowing\s+\.kot-scroll-content,\s*\.kot-tree-row:focus-visible\s+\.kot-tree-label\.is-overflowing\s+\.kot-scroll-content,\s*\.kot-tree-row:has\(:focus-visible\)\s+\.kot-tree-label\.is-overflowing\s+\.kot-scroll-content/isu
    );
    assert.doesNotMatch(
        css,
        /\.kot-tree-row:focus-within\s+\.kot-tree-label\.is-overflowing\s+\.kot-scroll-content/iu
    );
});

test('compact sidebar geometry keeps search and tree controls inside the viewport', () => {
    const sharedCss = read('media/kotSidebar.css');
    const stepCss = read('media/stepLibrarySidebar.css');
    const infobaseCss = read('media/infobaseSidebar.css');
    const stabilizedSearchCss = phaseCss.slice(phaseCss.lastIndexOf('/* Activity Bar stabilization'));

    assert.match(stabilizedSearchCss, /\.scenario-search-row\s*\{[^}]*box-sizing:\s*border-box/isu);
    assert.match(sharedCss, /--kot-sidebar-disclosure-size:\s*11px/u);
    assert.match(
        sharedCss,
        /\.kot-tree-disclosure\s*\{[^}]*width:\s*18px[^}]*font-size:\s*var\(--kot-sidebar-disclosure-size\)[^}]*line-height:\s*1/isu
    );
    assert.match(script, /phase-toggle-icon kot-tree-disclosure/u);
    assert.match(read('media/stepLibrarySidebar.js'), /step-chevron[^\n]*[\s\S]*?kot-tree-disclosure/u);
    assert.match(stepCss, /\.step-tree\s*\{[^}]*padding-block:\s*2px\s+6px[^}]*border-radius:\s*0/isu);
    assert.match(infobaseCss, /\.infobase-list\s*\{[^}]*padding-block:\s*6px\s+2px[^}]*border-radius:\s*0/isu);
    assert.match(phaseCss, /\.phase-title,\s*\.checkbox-label-text\s*\{[^}]*font-size:\s*var\(--vscode-font-size\)/isu);
    assert.match(infobaseCss, /\.infobase-runtime-marker\.is-pending\s*\{[^}]*charts-yellow/isu);
});

test('Test Manager reuses Library overflow labels and renders a static selected-total count', () => {
    const stabilizedCss = phaseCss.slice(phaseCss.lastIndexOf('/* Activity Bar stabilization'));

    assert.match(script, /titleSpan\.className\s*=\s*'phase-title kot-tree-label'/u);
    assert.match(script, /titleContent\.className\s*=\s*'kot-scroll-content'/u);
    assert.match(script, /querySelectorAll\('\.kot-tree-label'\)/u);
    assert.match(stabilizedCss, /\.phase-title\.is-overflowing,\s*label\.checkbox-item span\.checkbox-label-text\.is-overflowing\s*\{[^}]*text-overflow:\s*clip/isu);

    assert.match(script, /const countElement = document\.createElement\('span'\)/u);
    assert.match(script, /countElement\.className\s*=\s*'phase-test-count kot-tree-count'/u);
    assert.match(read('media/stepLibrarySidebar.js'), /count\.className\s*=\s*'step-count kot-tree-count'/u);
    assert.match(read('media/kotSidebar.css'), /\.kot-tree-count\s*\{[^}]*descriptionForeground[^}]*font-size:\s*11px/isu);
    assert.match(script, /countElement\.textContent\s*=\s*`\$\{enabledCount\}\/\$\{totalInPhase\}`/u);
    assert.doesNotMatch(stabilizedCss, /\.phase-test-count:hover\s*\{/u);
});

test('all compact sidebar lists recompute fade distances after a panel resize', () => {
    const compactLibrary = read('media/stepLibrarySidebar.js');
    const infobases = read('media/infobaseSidebar.js');

    assert.match(compactLibrary, /new ResizeObserver\(\(\) => updateLabelOverflow\(\)\)/u);
    assert.match(compactLibrary, /labelResizeObserver\.observe\(tree\)/u);
    assert.match(infobases, /new ResizeObserver\(\(\) => updateAllRowLabelOverflow\(\)\)/u);
    assert.match(infobases, /labelResizeObserver\.observe\(list\)/u);
});

test('Test Manager child rows have explicit nesting and a running spinner occupies the checkbox slot', () => {
    const stabilizedCss = phaseCss.slice(phaseCss.lastIndexOf('/* Activity Bar stabilization'));
    assert.match(stabilizedCss, /\.phase-tests-list[^}]*\{[^}]*padding-left:\s*0/isu);
    assert.match(stabilizedCss, /\.phase-tests-list\s+\.item-container\s*\{[^}]*padding-inline-start:\s*0/isu);
    assert.match(stabilizedCss, /label\.checkbox-item\s*\{[^}]*padding-inline:\s*48px 2px/isu);
    assert.match(stabilizedCss, /\.checkbox-run-indicator\s*\{[^}]*flex:\s*0\s+0\s+16px[^}]*margin:\s*0/isu);

    const syncStart = script.indexOf('    function syncScenarioLeadingControl(');
    const syncEnd = script.indexOf('\n    function ', syncStart + 20);
    const syncBlock = script.slice(syncStart, syncEnd);
    assert.match(syncBlock, /scenarioFileIcon/u);
    assert.match(syncBlock, /label\.insertBefore\(indicator, leadingControlAnchor\)/u);
    assert.match(syncBlock, /label\.insertBefore\(checkbox, leadingControlAnchor\)/u);
});

test('running rows keep the file button from becoming the implicit label control', () => {
    const rowMarkupStart = script.indexOf('<label class="checkbox-item');
    const rowMarkupEnd = script.indexOf('</label>', rowMarkupStart);
    const rowMarkup = script.slice(rowMarkupStart, rowMarkupEnd);

    assert.notEqual(rowMarkupStart, -1);
    assert.notEqual(rowMarkupEnd, -1);
    assert.match(rowMarkup, /for="chk-\$\{viewState\.safeName\}"/u);
    assert.match(script, /id="chk-\$\{safeName\}"/u);
});

test('Test Manager keeps every run button visible while the log action remains hover-only', () => {
    const stabilizedCss = phaseCss.slice(phaseCss.lastIndexOf('/* Activity Bar stabilization'));

    assert.match(
        stabilizedCss,
        /label\.checkbox-item \.kot-row-actions\s*\{[^}]*max-width:\s*76px[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/isu
    );
    assert.match(stabilizedCss, /label\.checkbox-item \.run-scenario-log-btn\s*\{[^}]*display:\s*none/isu);
    assert.match(stabilizedCss, /label\.checkbox-item \.run-scenario-btn\s*\{[^}]*display:\s*inline-flex/isu);
    assert.doesNotMatch(stabilizedCss, /\.run-scenario-btn:not\(:where\([^}]+\)\)\s*\{[^}]*display:\s*none/isu);
    assert.match(
        stabilizedCss,
        /label\.checkbox-item:hover \.kot-row-actions,\s*label\.checkbox-item:focus-within \.kot-row-actions\s*\{[^}]*max-width:\s*132px/isu
    );
    assert.match(
        stabilizedCss,
        /label\.checkbox-item:hover \.run-scenario-log-btn,\s*label\.checkbox-item:focus-within \.run-scenario-log-btn\s*\{[^}]*display:\s*inline-flex/isu
    );
});

test('Test Manager uses the leading file icon as the open action without occupying the status area', () => {
    const checkboxMarkupStart = script.indexOf('                <label class="checkbox-item');
    const checkboxMarkupEnd = script.indexOf('                </label>', checkboxMarkupStart);
    const checkboxMarkup = script.slice(checkboxMarkupStart, checkboxMarkupEnd);
    const actionsMarkupStart = script.indexOf('                    <span class="kot-row-actions">');
    const actionsMarkupEnd = script.indexOf('                    </span>', actionsMarkupStart);
    const actionsMarkup = script.slice(actionsMarkupStart, actionsMarkupEnd);

    assert.notEqual(checkboxMarkupStart, -1);
    assert.notEqual(checkboxMarkupEnd, -1);
    assert.notEqual(actionsMarkupStart, -1);
    assert.notEqual(actionsMarkupEnd, -1);
    assert.ok(checkboxMarkup.indexOf('${viewState.openButtonHtml}') < checkboxMarkup.indexOf('checkbox-label-text'));
    assert.doesNotMatch(actionsMarkup, /openButtonHtml/u);
    assert.ok(actionsMarkup.indexOf('${viewState.runLogButtonHtml}') < actionsMarkup.indexOf('${viewState.progressHtml}'));
    assert.ok(actionsMarkup.indexOf('${viewState.progressHtml}') < actionsMarkup.indexOf('${viewState.runButtonHtml}'));

    const openButtonStart = script.indexOf('        const openButtonHtml =');
    const runButtonStart = script.indexOf('        const runButtonHtml =', openButtonStart);
    const openButtonSource = script.slice(openButtonStart, runButtonStart);
    assert.match(openButtonSource, /<button type="button" class="open-scenario-btn scenario-file-icon"/u);
    assert.match(openButtonSource, /aria-label="\$\{escapedIconTitle\}"/u);
    assert.match(openButtonSource, /codicon-\$\{fileIcon\} open-scenario-icon-idle/u);
    assert.match(openButtonSource, /codicon-go-to-file open-scenario-icon-action/u);
    assert.doesNotMatch(openButtonSource, /codicon-edit/u);

    const refreshStart = script.indexOf('    function updateVisibleScenarioRunState()');
    const refreshEnd = script.indexOf('\n    function ', refreshStart + 20);
    const refresh = script.slice(refreshStart, refreshEnd);
    assert.match(
        refresh,
        /syncScenarioActionButton\(label, '\.run-scenario-log-btn', viewState\.runLogButtonHtml, '\.scenario-run-progress, \.run-scenario-btn'\)/u
    );

    const stabilizedCss = phaseCss.slice(phaseCss.lastIndexOf('/* Activity Bar stabilization'));
    assert.match(stabilizedCss, /label\.checkbox-item \.scenario-file-icon\s*\{[^}]*display:\s*inline-grid[^}]*flex:\s*0\s+0\s+16px[^}]*pointer-events:\s*auto[^}]*cursor:\s*pointer/isu);
    assert.match(stabilizedCss, /\.scenario-file-icon \.open-scenario-icon-idle\s*\{[^}]*display:\s*inline-block/isu);
    assert.match(stabilizedCss, /\.scenario-file-icon \.open-scenario-icon-action\s*\{[^}]*display:\s*none/isu);
    assert.match(
        stabilizedCss,
        /label\.checkbox-item:hover \.scenario-file-icon \.open-scenario-icon-idle,\s*\.scenario-file-icon:hover \.open-scenario-icon-idle\s*\{[^}]*display:\s*none/isu
    );
    assert.match(
        stabilizedCss,
        /label\.checkbox-item:hover \.scenario-file-icon \.open-scenario-icon-action,\s*\.scenario-file-icon:hover \.open-scenario-icon-action\s*\{[^}]*display:\s*inline-block/isu
    );
    assert.match(
        stabilizedCss,
        /label\.checkbox-item \.scenario-file-icon:hover\s*\{[^}]*border:\s*0[^}]*border-radius:\s*3px[^}]*background:\s*var\(--tm-surface-2\)/isu
    );
    assert.doesNotMatch(
        stabilizedCss,
        /label\.checkbox-item:hover \.scenario-file-icon\s*\{[^}]*(?:border-color|background):/isu
    );
    assert.doesNotMatch(
        phaseCss,
        /\.open-scenario-btn:hover,\s*\.open-scenario-btn:focus-visible[^}]*\{[^}]*(?:border-color|background):/isu
    );
    assert.match(stabilizedCss, /label\.checkbox-item \.scenario-file-icon:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--vscode-focusBorder\)/isu);
});

test('Library matches compact tree rhythm without persistent click selection', () => {
    const sharedCss = read('media/kotSidebar.css');
    const stepCss = read('media/stepLibrarySidebar.css');
    const compactScript = read('media/stepLibrarySidebar.js');

    assert.match(stepCss, /\.step-row\s*\{[^}]*var\(--step-depth,\s*0\)\s*\*\s*10px/isu);
    assert.doesNotMatch(
        stepCss,
        /\.step-row\[data-kind="(?:definition|directory|file)"\][^{]*\{[^}]*padding-left/isu
    );
    assert.match(stepCss, /\.step-chevron\s*\{[^}]*flex:\s*0\s+0\s+18px/isu);
    assert.match(stepCss, /\.step-node-icon\s*\{[^}]*flex:\s*0\s+0\s+18px/isu);
    assert.doesNotMatch(stepCss, /\.step-row\.is-selected\s*\{[^}]*background|\.step-row\.is-selected\s*\{[^}]*border-color/isu);
    assert.doesNotMatch(stepCss, /\.step-row:hover\s*\{[^}]*background/isu);
    assert.doesNotMatch(compactScript, /classList\.add\('is-selected'\)|aria-selected/u);
    assert.match(
        sharedCss,
        /\.kot-tree-row:hover\s+\.kot-tree-label\.is-overflowing[^}]*\{[^}]*mask-image:\s*linear-gradient\(to right,\s*transparent/isu
    );
});

test('Library definition titles have type icons and preserve compact layout', () => {
    const stepCss = read('media/stepLibrarySidebar.css');
    const compactScript = read('media/stepLibrarySidebar.js');

    assert.match(
        stepCss,
        /\.step-row\[data-kind="definition"\]\s+\.step-chevron\s*\+\s*\.kot-tree-label\s*\{[^}]*margin-inline-start:\s*2px/isu
    );
    assert.match(
        compactScript,
        /const nodeIcon = document\.createElement\('span'\);[\s\S]*?row\.appendChild\(nodeIcon\);/u
    );
    assert.match(compactScript, /process:\s*'list-ordered',\s*mainScenario:\s*'file'/u);
    assert.doesNotMatch(compactScript, /node\.kind\s*===\s*'definition'[\s\S]{0,80}corner-down-right/u);
});

test('Library definition tooltips cover the full row and expose descriptions instead of translated labels', () => {
    const compactScript = read('media/stepLibrarySidebar.js');
    const compactModel = read('src/stepLibrarySidebarModel.ts');

    assert.match(compactModel, /readonly description\?: string/u);
    assert.match(compactModel, /item\.description \? \{ description: item\.description \} : \{\}/u);
    assert.match(compactScript, /row\.title\s*=\s*protocol\.nodeTooltip\(node\)/u);
    assert.doesNotMatch(compactScript, /label\.title\s*=/u);
    assert.doesNotMatch(compactScript, /label\.title\s*=\s*node\.alternateLabel/u);
});

test('compact Infobases keeps row focus without persistent click selection', () => {
    const compactProvider = read('src/infobaseSidebarProvider.ts');
    const compactScript = read('media/infobaseSidebar.js');
    const compactCss = read('media/infobaseSidebar.css');

    assert.match(compactProvider, /class="infobase-list" role="list"/u);
    assert.match(compactScript, /row\.setAttribute\('role', 'listitem'\)/u);
    assert.doesNotMatch(compactScript, /row\.setAttribute\('aria-selected'/u);
    assert.doesNotMatch(compactScript, /row\.classList\.add\('is-selected'\)/u);
    assert.doesNotMatch(compactScript, /row\.addEventListener\('click',[\s\S]*?selectItem/u);
    assert.doesNotMatch(compactCss, /\.infobase-row\.is-selected\s*\{/u);
    assert.match(compactCss, /\.infobase-row:focus-visible\s*\{/u);
});

test('compact Infobases reveals row actions only on hover or keyboard focus', () => {
    const compactScript = read('media/infobaseSidebar.js');
    const compactCss = read('media/infobaseSidebar.css');

    assert.match(compactCss, /\.infobase-actions\s*\{[^}]*max-width:\s*0[^}]*opacity:\s*0[^}]*pointer-events:\s*none/isu);
    assert.match(
        compactCss,
        /\.infobase-row:hover\s+\.infobase-actions,\s*\.infobase-row:has\(\.infobase-action:focus-visible\)\s+\.infobase-actions\s*\{[^}]*max-width:\s*56px[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/isu
    );
    assert.doesNotMatch(compactCss, /\.infobase-row:focus-within/u, 'mouse focus must not retain action padding after hover leaves');
    const clientRows = compactScript.slice(compactScript.indexOf('function clientRows('), compactScript.indexOf('function updateRowLabelOverflow('));
    assert.doesNotMatch(clientRows, /action:\s*'vanessaClients'/u, 'client management stays in the base menu');
    assert.match(compactCss, /\.infobase-action\s*\{[^}]*box-sizing:\s*border-box[^}]*width:\s*28px[^}]*padding:\s*0/isu);
    assert.match(compactScript, /function updateRowLabelOverflow\(/u);
    assert.match(compactScript, /addEventListener\('mouseover', refreshHoveredRowOverflow\)/u);
});

test('sidebar colors use VS Code theme tokens without separately highlighting the open scenario', () => {
    const css = read('media/kotSidebar.css');
    assert.match(css, /--kot-sidebar-related:\s*var\(--vscode-charts-purple/u);
    assert.doesNotMatch(css, /\.is-current\s*\{/u);
    assert.match(css, /\.is-related\s*\{[^}]*--kot-sidebar-related/isu);
    assert.doesNotMatch(css, /\.is-transitive\s*\{[^}]*opacity/isu);
});

test('tree toggles and icon-only controls expose localized accessible names', () => {
    assert.match(script, /setAttribute\('aria-expanded',\s*phaseExpandedState\[groupKey\] \? 'true' : 'false'\)/u);
    assert.match(script, /toggleButton\.setAttribute\('aria-expanded', nextExpanded \? 'true' : 'false'\)/u);

    const iconOnlyButtons = [...html.matchAll(/<button\b(?=[^>]*\bicon-only\b)[^>]*>/gsu)]
        .map(match => match[0]);
    assert.ok(iconOnlyButtons.length >= 2);
    for (const button of iconOnlyButtons) {
        assert.match(button, /aria-label="\$\{loc\.[A-Za-z0-9]+\}"/u);
    }
});

test('relationship states have non-color text alternatives without duplicate current-eye icons', () => {
    assert.doesNotMatch(html, /id="relationshipContext"/u);
    assert.doesNotMatch(script, /scenario-relationship-icon[^\n]*codicon-eye/u);
    assert.match(script, /class="scenario-relationship-icon[^"\n]*"[^>]*role="img"[^>]*aria-label=/u);
    const stabilizedCss = phaseCss.slice(phaseCss.lastIndexOf('/* Activity Bar stabilization'));
    assert.match(
        stabilizedCss,
        /\.scenario-relationship-icon\s*\{[^}]*position:\s*absolute[^}]*width:\s*1px[^}]*height:\s*1px[^}]*clip-path:\s*inset\(50%\)/isu
    );
});

test('live build selection does not pretend to have unapplied row changes', () => {
    assert.doesNotMatch(script, /class="kot-modified"|>M<|classList\.toggle\('is-modified'|classList\.toggle\('changed'/u);
    assert.doesNotMatch(read('media/kotSidebar.css'), /\.kot-modified|\.is-modified/u);
    assert.doesNotMatch(script, /selectionStateSummary/u);
    assert.doesNotMatch(html, /id="selectDefaultsBtn"/u);
});

test('relationship state updates remain independent from build checkboxes', () => {
    const relationshipUpdateStart = script.indexOf("case 'updateRelationshipState':");
    const nextCase = script.indexOf("case 'updateStatus':", relationshipUpdateStart);
    assert.notEqual(relationshipUpdateStart, -1);
    assert.notEqual(nextCase, -1);
    assert.doesNotMatch(
        script.slice(relationshipUpdateStart, nextCase),
        /currentCheckboxStates|sendScenarioSelectionStates|updateCurrentState/u
    );
});

test('structural renders restore tree scroll, focus, and expanded phases', () => {
    assert.match(script, /function capturePhaseTreeViewState\(\)/u);
    assert.match(script, /function restorePhaseTreeViewState\(viewState\)/u);
    assert.match(script, /scrollTop:\s*scrollContainer\.scrollTop/u);
    assert.match(script, /focusedScenarioKey/u);
    assert.match(script, /expandedPhaseNames/u);
    assert.match(script, /focus\(\{ preventScroll: true \}\)/u);
});

test('relationship and run-state refreshes patch existing keyed rows', () => {
    assert.match(script, /function patchScenarioRelationshipDecorations\(\)/u);
    assert.match(script, /querySelectorAll\('\.checkbox-item\[data-key\]'\)/u);
    const patchStart = script.indexOf('    function patchScenarioRelationshipDecorations()');
    const patchEnd = script.indexOf('\n    function ', patchStart + 20);
    assert.notEqual(patchStart, -1);
    assert.doesNotMatch(script.slice(patchStart, patchEnd), /innerHTML\s*=/u);
    assert.match(script, /function updateVisibleScenarioRunState\(\)/u);
});

test('compact Step Library uses bounded host pages and native sidebar assets', () => {
    const assetPaths = [
        'src/stepLibrarySidebarProvider.ts',
        'media/stepLibrarySidebar.js',
        'media/stepLibrarySidebar.css',
        'media/stepLibrarySidebarProtocol.js'
    ];
    for (const assetPath of assetPaths) {
        assert.equal(fs.existsSync(path.join(process.cwd(), assetPath)), true, assetPath);
    }

    const compactProvider = read('src/stepLibrarySidebarProvider.ts');
    const compactScript = read('media/stepLibrarySidebar.js');
    const compactCss = read('media/stepLibrarySidebar.css');
    assert.match(compactProvider, /StepLibrarySidebarIndex\.fromSnapshot/u);
    assert.match(compactProvider, /snapshotService\.ensureReady/u);
    assert.match(compactProvider, /index\.children\([^)]*100/u);
    assert.match(compactProvider, /index\.search\([^)]*100/u);
    assert.doesNotMatch(compactProvider, /ProjectDefinitionResolver|WorkspaceScanner/u);

    assert.match(compactScript, /addEventListener\('click'/u);
    assert.match(compactScript, /DocumentFragment|createDocumentFragment/u);
    assert.match(compactScript, /textContent/u);
    assert.match(compactScript, /searchTimer\s*=\s*setTimeout\([\s\S]*?\},\s*150\)/u);
    assert.match(compactScript, /getState\(\)/u);
    assert.match(compactScript, /setState\(/u);
    assert.doesNotMatch(compactScript, /innerHTML\s*=/u);
    assert.doesNotMatch(compactScript, /getElementById\('refreshButton'\)|getElementById\('openFullButton'\)/u);
    assert.ok(compactProvider.indexOf('id="status"') > compactProvider.indexOf('id="tree"'));

    assert.match(compactCss, /overflow-x:\s*hidden/u);
    assert.match(compactCss, /\.kot-tree-label\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/isu);
    assert.match(compactCss, /white-space:\s*pre/u);
    assert.doesNotMatch(compactCss, /background(?:-image)?:[^;]*gradient|box-shadow/iu);
});

test('compact Step Library exposes relationships without extra row icons or horizontal overflow', () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), 'media/stepLibrarySidebar.js')), true);
    const compactScript = read('media/stepLibrarySidebar.js');
    const compactCss = read('media/stepLibrarySidebar.css');

    assert.match(compactScript, /relationshipDecorationForNode/u);
    assert.match(compactScript, /setAttribute\('aria-label',\s*relationshipLabel\)/u);
    assert.doesNotMatch(compactScript, /relationshipIcons|step-relation|arrow-right-to-line|arrow-right-from-line/u);
    assert.match(compactScript, /aria-expanded/u);
    assert.doesNotMatch(compactCss, /\.is-current|\.step-relation/u);
    assert.match(compactCss, /\.is-related/u);
    assert.doesNotMatch(compactCss, /\.is-transitive\s*\{[^}]*opacity/isu);
    assert.match(compactCss, /overflow-x:\s*hidden/u);
});

test('Test Manager child rows keep their content indent while full-row relationship highlighting stays aligned', () => {
    assert.match(
        phaseCss,
        /\.phase-tests-list \.item-container\s*\{[^}]*padding-inline-start:\s*0/isu
    );
    assert.match(
        phaseCss,
        /label\.checkbox-item\s*\{[^}]*padding-inline:\s*48px 2px/isu
    );
    assert.doesNotMatch(script, /current-main-scenario|classList\.toggle\('is-current'/u);
    assert.doesNotMatch(phaseCss, /label\.checkbox-item\.current-main-scenario/u);
});

test('compact Step Library exposes insert, copy, open, and editor drag affordances', () => {
    const compactProvider = read('src/stepLibrarySidebarProvider.ts');
    const compactScript = read('media/stepLibrarySidebar.js');
    const compactCss = read('media/stepLibrarySidebar.css');

    assert.match(compactProvider, /\| \{ readonly command: 'copy'; readonly itemId: string \}/u);
    assert.match(compactProvider, /actionService\.copy\(item, this\.resource\)/u);
    assert.match(compactScript, /createActionButton\(\s*'insert'/u);
    assert.match(compactScript, /createActionButton\('copy'/u);
    assert.match(compactScript, /createActionButton\('openDefinition'/u);
    assert.match(compactScript, /node\.insertable === true[\s\S]*?row\.draggable\s*=\s*true/u);
    assert.match(compactScript, /dataTransfer\.setData\('text\/plain', node\.dragText\)/u);
    assert.match(compactCss, /\.step-row:hover \.step-actions/u);
    assert.match(compactCss, /\.step-row:has\(\.step-action:focus-visible\) \.step-actions/u);
});

test('compact Step Library expands and collapses nested branches with the same height transition as Test Manager', () => {
    const compactScript = read('media/stepLibrarySidebar.js');
    const compactCss = read('media/stepLibrarySidebar.css');

    assert.match(compactScript, /childrenContainer\.className\s*=\s*'step-children'/u);
    assert.match(compactScript, /function animateExpandedBranch\(/u);
    assert.match(compactScript, /function collapseBranchBeforeRender\(/u);
    assert.match(compactScript, /case 'toggleAllGroups':/u);
    assert.match(compactScript, /function toggleAllGroups\(/u);
    assert.match(compactCss, /\.step-children\s*\{[^}]*overflow:\s*hidden[^}]*transition:[^}]*max-height\s+0\.2s\s+ease/isu);
    assert.match(compactCss, /\.step-children\.expanded\s*\{[^}]*opacity:\s*1/isu);
});

test('Test Manager uses flat sidebar chrome and keeps search and selection summary visible', () => {
    assert.match(html, /id="selectionSummary"/u);
    assert.match(html, /id="selectedCount"/u);
    assert.match(html, /id="selectableCount"/u);
    assert.match(html, /id="clearSelectionBtn"/u);
    assert.doesNotMatch(html, /id="toggleScenarioSearchBtn"/u);
    assert.doesNotMatch(html, /phase-switcher-topbar|id="relationshipContext"|id="selectDefaultsBtn"/u);
    assert.doesNotMatch(html, /manager-tabs|favoritesContainer|favoritesTabBtn/u);
    assert.doesNotMatch(script, /selectionSummary\.classList\.(?:add|toggle)\('hidden'/u);
    const nativeOverrides = phaseCss.slice(phaseCss.indexOf('/* Native sidebar workbench overrides.'));
    assert.match(nativeOverrides, /\.phase-group\s*\{[^}]*border-radius:\s*0/isu);
    assert.match(nativeOverrides, /label\.checkbox-item\s*\{[^}]*border-radius:\s*0/isu);
});

test('Test Manager search filters rows and Compile options own the parameters-manager shortcut', () => {
    assert.match(script, /classList\.toggle\('search-hidden'/u);
    const stabilizedSearchCss = phaseCss.slice(phaseCss.lastIndexOf('/* Activity Bar stabilization'));
    assert.match(stabilizedSearchCss, /\.scenario-search-input-wrap\s*\{[^}]*display:\s*flex\s*!important/isu);
    assert.match(stabilizedSearchCss, /\.scenario-search-input-wrap\.search-frame\s*>\s*\.scenario-search-icon[^{]*\{[^}]*position:\s*static\s*!important/isu);
    assert.match(stabilizedSearchCss, /\.scenario-search-input-wrap\s*>\s*\.scenario-search-icon\s*\{[^}]*flex:\s*0\s+0\s+18px/isu);
    assert.match(stabilizedSearchCss, /\.scenario-search-input\s*\{[^}]*flex:\s*1\s+1\s+0[^}]*min-width:\s*0[^}]*padding:\s*0\s+2px\s*!important/isu);
    assert.match(stabilizedSearchCss, /\.scenario-search-input:focus[^\{]*\{[^}]*outline:\s*0\s*!important/isu);
    assert.match(stabilizedSearchCss, /\.scenario-search-input:focus[^\{]*\{[^}]*border:\s*0\s*!important/isu);
    assert.match(stabilizedSearchCss, /\.scenario-search-clear-btn\s*>\s*\.codicon\s*\{[^}]*position:\s*static\s*!important/isu);
    assert.match(stabilizedSearchCss, /\.scenario-search-input-wrap\s*>\s*\.scenario-search-clear-btn\s*\{[^}]*min-width:\s*20px[^}]*max-width:\s*20px/isu);
    assert.match(stabilizedSearchCss, /\.phase-header\.phase-header-search-match[^\{]*\{[^}]*box-shadow:\s*none/isu);
    assert.match(html, /id="yamlProfileRow"[\s\S]*?id="yamlProfileSelect"[\s\S]*?id="openYamlParametersQuickBtn"/u);
    assert.doesNotMatch(html, /id="openPlatformManagerQuickBtn"/u);
    assert.match(phaseCss, /\.profile-control-line\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+28px/isu);
});

test('Test Manager tree keeps native chevron-checkbox-icon-label order', () => {
    const appendStart = script.indexOf('phaseHeaderDiv.appendChild');
    const appendEnd = script.indexOf('updatePhaseCountButton', appendStart);
    const appendBlock = script.slice(appendStart, appendEnd);
    assert.ok(appendBlock.indexOf('expandCollapseButton') < appendBlock.indexOf('phaseCheckbox'));
    assert.ok(appendBlock.indexOf('phaseCheckbox') < appendBlock.indexOf('phaseLabelButton'));
});

test('compact Infobase menu exposes one configuration update path and nests secondary actions', () => {
    const compactScript = read('media/infobaseSidebar.js');
    assert.doesNotMatch(compactScript, /maintenanceItem\(loc\.updateFromSources/u);
    assert.doesNotMatch(compactScript, /maintenanceItem\(`\$\{loc\.importCf\}/u);
    assert.match(compactScript, /maintenanceItem\(loc\.updateConfiguration/u);
    assert.match(compactScript, /loc\.exportCf/u);
    assert.match(compactScript, /toggleSubmenu/u);
    assert.match(compactScript, /aria-haspopup[^\n]*menu/u);
    assert.match(compactScript, /maintenanceHeading\(loc\.kotHeading\)[\s\S]*maintenanceItem\(loc\.openFormExplorer/u);
});

test('Test Manager overflow menu starts with create and groups settings with build tools', () => {
    const manifest = JSON.parse(read('package.json')) as {
        contributes: {
            submenus: Array<{ id: string }>;
            menus: Record<string, Array<{ command?: string; submenu?: string; when?: string }>>;
        };
    };
    const phaseActions = manifest.contributes.menus['view/title']
        .filter(item => item.when?.includes('view == kotTestToolkit.phaseSwitcherView'))
        .filter(item => !String((item as { group?: string }).group || '').startsWith('navigation'));
    assert.deepEqual(phaseActions.map(item => item.command || item.submenu), [
        'kotTestToolkit.phaseSwitcher.create',
        'kotTestToolkit.openSettings',
        'kotTestToolkit.openYamlParametersManager',
        'kotTestToolkit.managePlatforms',
        'kotTestToolkit.phaseSwitcher.maintenance',
        'kotTestToolkit.phaseSwitcher.ai',
        'kotTestToolkit.vanessaControl.connectionSettings'
    ]);
    assert.deepEqual(
        manifest.contributes.menus['kotTestToolkit.phaseSwitcher.create'].map(item => item.command),
        [
            'kotTestToolkit.createMainScenario',
            'kotTestToolkit.createFeature',
            'kotTestToolkit.createProcess',
            'kotTestToolkit.createNestedScenario',
            'kotTestToolkit.createExportScenario',
            'kotTestToolkit.createUserStep',
            'kotTestToolkit.createFirstLaunchZip'
        ]
    );
    assert.equal(
        manifest.contributes.menus['kotTestToolkit.phaseSwitcher.create']
            .find(item => item.command === 'kotTestToolkit.createFirstLaunchZip')?.when,
        'kotTestToolkit.firstLaunchArchiveAvailable'
    );
    assert.equal(
        manifest.contributes.menus.commandPalette
            .find(item => item.command === 'kotTestToolkit.createFirstLaunchZip')?.when,
        'kotTestToolkit.firstLaunchArchiveAvailable'
    );
    assert.doesNotMatch(read('package.nls.json'), /"cmd\.createMainScenario\.title"\s*:\s*"KOT\s*-/u);
    assert.doesNotMatch(read('package.nls.ru.json'), /"cmd\.createMainScenario\.title"\s*:\s*"KOT\s*-/u);
});

test('compact Infobases view uses native sidebar primitives and a closed maintenance protocol', () => {
    for (const assetPath of [
        'src/infobaseSidebarProvider.ts',
        'media/infobaseSidebarProtocol.js',
        'media/infobaseSidebar.js',
        'media/infobaseSidebar.css'
    ]) {
        assert.equal(fs.existsSync(path.join(process.cwd(), assetPath)), true, assetPath);
    }

    const compactProvider = read('src/infobaseSidebarProvider.ts');
    const compactScript = read('media/infobaseSidebar.js');
    const compactCss = read('media/infobaseSidebar.css');
    assert.match(compactProvider, /buildInfobaseSidebarModel/u);
    assert.match(compactProvider, /managedInfobaseService\.ensureReady/u);
    assert.match(compactProvider, /managedInfobaseService\.refresh/u);
    assert.doesNotMatch(compactProvider, /collectManagedInfobases/u);
    assert.doesNotMatch(compactProvider, /infobasePath:\s*record\./u);
    assert.match(compactProvider, /openInfobaseInEnterprise/u);
    assert.match(compactProvider, /openInfobaseInDesigner/u);
    assert.match(compactProvider, /exportInfobaseToDtInteractive/u);
    assert.match(compactProvider, /restoreInfobaseFromDtInteractive/u);
    assert.match(compactProvider, /exportInfobaseConfigurationToCfInteractive/u);
    assert.match(compactProvider, /updateInfobaseConfigurationInteractive\(context, infobase, 'cfFile'\)/u);
    assert.match(compactScript, /runtimeMarker/u);
    assert.match(compactScript, /aria-haspopup/u);
    assert.match(compactScript, /Escape/u);
    assert.match(compactScript, /getState\(\)/u);
    assert.match(compactScript, /setState\(/u);
    assert.doesNotMatch(compactScript, /innerHTML\s*=/u);
    assert.doesNotMatch(compactScript, /getElementById\('refreshButton'\)|getElementById\('createButton'\)|getElementById\('openFullButton'\)/u);
    assert.ok(compactProvider.indexOf('id="status"') > compactProvider.indexOf('id="list"'));
    assert.match(compactCss, /overflow-x:\s*hidden/u);
    assert.doesNotMatch(compactCss, /gradient|box-shadow/iu);
});

test('compact workbench views source user-facing strings from localization bundles', () => {
    const english = JSON.parse(read('l10n/bundle.l10n.json')) as Record<string, string>;
    const russian = JSON.parse(read('l10n/bundle.l10n.ru.json')) as Record<string, string>;
    const requiredKeys = [
        'Search steps and scenarios',
        'Search main scenario',
        'Clear search',
        'Refresh step library',
        'Open full Step Library',
        'Currently open scenario',
        'Calls the open scenario directly',
        'Called by the open scenario directly',
        'Running from KOT',
        'Refresh infobases',
        'Open in 1C:Enterprise',
        'Maintenance actions',
        'No managed infobases',
        'Open full Infobase Manager'
    ];
    for (const key of requiredKeys) {
        assert.equal(typeof english[key], 'string', `English: ${key}`);
        assert.equal(typeof russian[key], 'string', `Russian: ${key}`);
    }
    assert.match(read('src/stepLibrarySidebarProvider.ts'), /vscode\.l10n\.t/u);
    assert.match(read('src/infobaseSidebarProvider.ts'), /vscode\.l10n\.t/u);
});

test('compact Library and Test Manager share the same explicit search clear control', () => {
    const compactProvider = read('src/stepLibrarySidebarProvider.ts');
    const compactScript = read('media/stepLibrarySidebar.js');
    const compactCss = read('media/kotSidebar.css');

    assert.match(compactProvider, /class="step-search-wrap kot-search-frame"/u);
    assert.match(compactProvider, /id="searchClearBtn"[\s\S]*?kot-search-clear/u);
    assert.match(compactProvider, /Search steps and scenarios/u);
    assert.match(compactScript, /searchClearBtn\.classList\.toggle\('hidden', !hasValue\)/u);
    assert.match(compactScript, /searchClearBtn\.addEventListener\('click'/u);
    assert.match(compactCss, /\.kot-search-frame\s*\{/u);
    assert.match(compactCss, /\.kot-search-clear:hover/u);
});

test('compact Library attachment rows use the shared dismissible context menu', () => {
    const provider = read('src/stepLibrarySidebarProvider.ts');
    const client = read('media/stepLibrarySidebar.js');
    const css = read('media/stepLibrarySidebar.css');
    const makeRowStart = client.indexOf('    function makeRow(');
    const makeRowEnd = client.indexOf('\n    function ', makeRowStart + 20);
    const makeRowSource = client.slice(makeRowStart, makeRowEnd);

    assert.match(provider, /data-delete=/u);
    assert.match(client, /function showScenarioResourceContextMenu\(/u);
    assert.match(client, /scenarioResourceContextActions/u);
    assert.match(makeRowSource, /contextmenu/u);
    assert.match(client, /'deleteScenarioFile'/u);
    assert.match(client, /event\.preventDefault\(\)/u);
    assert.match(client, /event\.stopPropagation\(\)/u);
    assert.match(client, /closeScenarioResourceContextMenu/u);
    assert.match(client, /event\.key === 'Escape'/u);
    assert.match(client, /scenarioFileActionResult[\s\S]*action === 'delete'[\s\S]*childrenByParent\.delete/u);
    assert.match(css, /\.scenario-resource-context-menu\s*\{[^}]*position:\s*fixed/isu);
    assert.match(css, /--vscode-menu-background/u);
    assert.match(css, /--vscode-menu-selectionBackground/u);
});

test('Activity Bar views expose native title actions with an expanded 2:1 main layout', () => {
    const manifest = JSON.parse(read('package.json')) as {
        contributes: {
            commands: Array<{ command: string; title: string; icon?: string }>;
            views: Record<string, Array<{
                id: string;
                visibility?: string;
                initialSize?: number;
            }>>;
            submenus: Array<{ id: string; label: string; icon?: string }>;
            menus: Record<string, Array<{
                command?: string;
                submenu?: string;
                when?: string;
                group?: string;
            }>>;
        };
    };
    assert.deepEqual(
        manifest.contributes.views.kotTestToolkitContainer.map(view => ({
            id: view.id,
            initialSize: view.initialSize,
            visibility: view.visibility
        })),
        [
            {
                id: 'kotTestToolkit.phaseSwitcherView',
                initialSize: 2,
                visibility: undefined
            },
            {
                id: 'kotTestToolkit.infobaseSidebarView',
                initialSize: 1,
                visibility: undefined
            }
        ]
    );
    assert.equal(
        manifest.contributes.views.kotTestToolkitLibraryContainer[0]?.visibility,
        undefined
    );
    const titleActions = manifest.contributes.menus['view/title'];
    const commandsFor = (viewId: string) => titleActions
        .filter(action => action.when?.includes(`view == ${viewId}`))
        .map(action => action.command ?? action.submenu);
    assert.deepEqual(commandsFor('kotTestToolkit.stepLibrarySidebarView'), [
        'kotTestToolkit.showCreateScenarioMenu',
        'kotTestToolkit.stepLibrary.relationships',
        'kotTestToolkit.stepLibrary.relationshipsActive',
        'kotTestToolkit.toggleStepLibraryGroups',
        'kotTestToolkit.refreshStepLibrarySidebar',
        'kotTestToolkit.openStepLibrary'
    ]);
    assert.deepEqual(commandsFor('kotTestToolkit.infobaseSidebarView'), [
        'kotTestToolkit.createInfobase',
        'kotTestToolkit.openFormExplorer',
        'kotTestToolkit.refreshInfobaseSidebar',
        'kotTestToolkit.openInfobaseManager'
    ]);
    assert.ok(commandsFor('kotTestToolkit.phaseSwitcherView').includes('kotTestToolkit.testManager.relationships'));
    assert.ok(commandsFor('kotTestToolkit.phaseSwitcherView').includes('kotTestToolkit.testManager.relationshipsActive'));
    assert.equal(commandsFor('kotTestToolkit.phaseSwitcherView').includes('kotTestToolkit.stepLibrary.relationships'), false);
    assert.equal(commandsFor('kotTestToolkit.stepLibrarySidebarView').includes('kotTestToolkit.testManager.relationships'), false);
    assert.equal(
        manifest.contributes.submenus.find(item => item.id === 'kotTestToolkit.stepLibrary.relationshipsActive')?.icon,
        '$(filter-filled)'
    );
    assert.equal(
        manifest.contributes.submenus.find(item => item.id === 'kotTestToolkit.testManager.relationshipsActive')?.icon,
        '$(filter-filled)'
    );
    assert.equal(
        manifest.contributes.submenus.find(item => item.id === 'kotTestToolkit.stepLibrary.relationships')?.icon,
        '$(filter)'
    );
    for (const surface of [
        {
            menuIds: [
                'kotTestToolkit.testManager.relationships',
                'kotTestToolkit.testManager.relationshipsActive'
            ],
            commandPrefix: 'TestManager',
            contextPrefix: 'testManager'
        },
        {
            menuIds: [
                'kotTestToolkit.stepLibrary.relationships',
                'kotTestToolkit.stepLibrary.relationshipsActive'
            ],
            commandPrefix: 'StepLibrary',
            contextPrefix: 'stepLibrary'
        }
    ]) {
        for (const option of [
            {
                commandSuffix: 'Highlight',
                contextSuffix: 'HighlightEnabled',
                titleKey: 'cmd.relationships.highlight.checked.title',
                group: 'navigation@1'
            },
            {
                commandSuffix: 'Filter',
                contextSuffix: 'FilterEnabled',
                titleKey: 'cmd.relationships.filter.checked.title',
                group: 'navigation@2'
            }
        ]) {
            const uncheckedCommand = `kotTestToolkit.toggle${surface.commandPrefix}Relationship${option.commandSuffix}`;
            const checkedCommand = `${uncheckedCommand}Checked`;
            const stateContext = `kotTestToolkit.${surface.contextPrefix}Relationship${option.contextSuffix}`;
            const checkedContribution = manifest.contributes.commands
                .find(command => command.command === checkedCommand);
            assert.equal(
                checkedContribution?.title,
                `%${option.titleKey}%`,
                `${checkedCommand} must expose its checked state in the visible title`
            );
            assert.equal(checkedContribution?.icon, undefined);
            for (const localePath of ['package.nls.json', 'package.nls.ru.json']) {
                const locale = JSON.parse(read(localePath)) as Record<string, string>;
                assert.match(locale[option.titleKey], /^✓\s/u);
            }
            for (const menuId of surface.menuIds) {
                const items = manifest.contributes.menus[menuId]
                    .filter(item => item.group === option.group)
                    .map(item => ({ command: item.command, when: item.when }));
                assert.deepEqual(items, [
                    { command: uncheckedCommand, when: `!${stateContext}` },
                    { command: checkedCommand, when: stateContext }
                ]);
            }
        }
    }
    assert.doesNotMatch(JSON.stringify(manifest.contributes.menus), /"toggled"/u);
    assert.equal(commandsFor('kotTestToolkit.phaseSwitcherView').includes('kotTestToolkit.openVanessa'), false);
    assert.deepEqual(commandsFor('kotTestToolkit.phaseSwitcherView').slice(0, 5), [
        'kotTestToolkit.showCreateScenarioMenu',
        'kotTestToolkit.testManager.relationships',
        'kotTestToolkit.testManager.relationshipsActive',
        'kotTestToolkit.toggleTestManagerGroups',
        'kotTestToolkit.refreshPhaseSwitcher'
    ]);
});

test('Test Manager filter dropdown combines status and relationship filters with an active icon', () => {
    const manifest = JSON.parse(read('package.json')) as {
        contributes: {
            commands: Array<{ command: string; title: string }>;
            submenus: Array<{ id: string; label: string; icon?: string }>;
            menus: Record<string, Array<{
                command?: string;
                submenu?: string;
                when?: string;
                group?: string;
            }>>;
        };
    };
    const english = JSON.parse(read('package.nls.json')) as Record<string, string>;
    const russian = JSON.parse(read('package.nls.ru.json')) as Record<string, string>;
    const menuIds = [
        'kotTestToolkit.testManager.relationships',
        'kotTestToolkit.testManager.relationshipsActive'
    ];
    const modes = [
        { suffix: 'All', context: 'All', title: 'All tests' },
        { suffix: 'Built', context: 'Built', title: 'Built tests' },
        { suffix: 'Running', context: 'Running', title: 'Running tests' }
    ];

    for (const mode of modes) {
        const command = `kotTestToolkit.setTestManagerStatusFilter${mode.suffix}`;
        const checkedCommand = `${command}Checked`;
        const context = `kotTestToolkit.testManagerStatusFilter${mode.context}`;
        const contribution = manifest.contributes.commands.find(item => item.command === command);
        const checkedContribution = manifest.contributes.commands.find(item => item.command === checkedCommand);
        assert.ok(contribution);
        assert.ok(checkedContribution);
        assert.equal(english[checkedContribution!.title.slice(1, -1)].startsWith('✓ '), true);
        assert.equal(russian[checkedContribution!.title.slice(1, -1)].startsWith('✓ '), true);
        for (const menuId of menuIds) {
            const items = manifest.contributes.menus[menuId]
                .filter(item => item.command === command || item.command === checkedCommand)
                .map(item => ({ command: item.command, when: item.when }));
            assert.deepEqual(items, [
                { command, when: `!${context}` },
                { command: checkedCommand, when: context }
            ]);
        }
    }

    for (const menuId of menuIds) {
        const submenu = manifest.contributes.submenus.find(item => item.id === menuId);
        assert.equal(submenu?.label, '%submenu.testManager.filters%');
    }
    assert.equal(english['submenu.testManager.filters'], 'Filters');
    assert.equal(russian['submenu.testManager.filters'], 'Фильтры');

    const titleMenus = manifest.contributes.menus['view/title']
        .filter(item => item.submenu && menuIds.includes(item.submenu));
    assert.deepEqual(titleMenus.map(item => item.when), [
        'view == kotTestToolkit.phaseSwitcherView && !kotTestToolkit.testManagerFiltersActive',
        'view == kotTestToolkit.phaseSwitcherView && kotTestToolkit.testManagerFiltersActive'
    ]);
    assert.equal(
        manifest.contributes.submenus.find(item => item.id === menuIds[1])?.icon,
        '$(filter-filled)'
    );
});

test('relationship filtering keeps only direct matches and their tree ancestors', () => {
    const compactScript = read('media/stepLibrarySidebar.js');
    const compactProtocol = read('media/stepLibrarySidebarProtocol.js');
    assert.match(compactProtocol, /function isNodeRelationshipMatch\(/u);
    assert.match(compactScript, /relationshipFilterEnabled/u);
    assert.match(compactScript, /relatedAncestorIds\.has\(node\.id\)/u);
    assert.match(compactScript, /protocol\.isNodeRelationshipMatch\(node, uiState\)/u);

    assert.match(script, /settings\.filterRelatedScenarios/u);
    assert.match(script, /scenarioProtocol\.isScenarioRelationshipMatch\(/u);
    assert.match(phaseCss, /\.relationship-hidden\s*\{[^}]*display:\s*none\s*!important/isu);
});

test('Test Manager filter visibility has one hidden-row contract', () => {
    assert.match(phaseCss, /\.status-hidden\s*\{[^}]*display:\s*none\s*!important/isu);
    assert.match(phaseCss, /\.filter-hidden\s*\{[^}]*display:\s*none\s*!important/isu);
    assert.match(script, /function applyScenarioVisibility\(/u);
    assert.match(script, /visibleAggregate\.visibleKeys/u);
    assert.match(
        script,
        /updatePhaseCountButton\([\s\S]*?phaseAggregate\.selectedCount,[\s\S]*?phaseAggregate\.totalCount/u
    );
    assert.match(script, /currentVisibleScenarioKeys/u);
});

test('workbench performance gates are structural rather than wall-clock thresholds', () => {
    const performanceTests = read('test/stepLibraryPerformance.test.ts');
    assert.match(performanceTests, /without scans or path lookup/u);
    assert.match(performanceTests, /share one in-flight resolver generation/u);
    assert.match(performanceTests, /share one in-flight collector generation/u);
    assert.doesNotMatch(performanceTests, /assert\.(?:ok|equal)\([^\n]*durationMs/u);

    const compactProviderTests = read('test/stepLibrarySidebarProvider.test.ts');
    assert.match(compactProviderTests, /initial ready posts loading and seven roots without transferring the snapshot/u);
    assert.match(compactProviderTests, /expand and search return bounded host-side pages only/u);
    assert.match(compactProviderTests, /defers hidden invalidation and publishes the latest revision when shown again/u);
});
