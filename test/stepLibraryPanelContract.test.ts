import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function projectFile(relativePath: string): string {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('full Library source uses the unified branded panel title', () => {
    const source = projectFile('src/stepLibraryPanel.ts');

    assert.match(source, /t\('KOT for 1C: Library'\)/u);
    assert.doesNotMatch(source, /t\('KOT Library'\)/u);
});

test('panel HTML uses a restrictive CSP, nonce scripts, and only local assets', () => {
    const source = projectFile('src/stepLibraryPanel.ts');

    assert.match(source, /default-src 'none'/u);
    assert.match(source, /style-src \$\{webview\.cspSource\}/u);
    assert.match(source, /font-src \$\{webview\.cspSource\}/u);
    assert.match(source, /script-src 'nonce-\$\{nonce\}'/u);
    assert.match(source, /stepLibrary\.css/u);
    assert.match(source, /kotSidebar\.css/u);
    assert.match(source, /stepLibraryProtocol\.js/u);
    assert.match(source, /scenarioFilesProtocol\.js/u);
    assert.match(source, /stepLibrary\.js/u);
    assert.doesNotMatch(source, /https?:\/\//u);
});

test('step-library assets exist, are included by VSIX rules, and render data without innerHTML', () => {
    for (const relativePath of [
        'media/stepLibrary.css',
        'media/stepLibrary.js',
        'media/stepLibraryProtocol.js',
        'media/scenarioFilesProtocol.js'
    ]) {
        assert.equal(fs.existsSync(path.join(process.cwd(), relativePath)), true, relativePath);
    }
    const ignore = projectFile('.vscodeignore');
    assert.doesNotMatch(ignore, /^media\/(?:\*\*|stepLibrary)/mu);

    const client = projectFile('media/stepLibrary.js');
    assert.match(client, /textContent/u);
    assert.doesNotMatch(client, /\.innerHTML\s*=/u);
    assert.match(client, /requestAnimationFrame/u);
    assert.match(client, /getState\(\)|setState\(/u);
    assert.match(client, /\.style\.setProperty\(\s*'--category-pane-width'/u);
    assert.match(client, /\.style\.setProperty\(\s*'--details-pane-width'/u);
    assert.doesNotMatch(client, /\.style\.(?:cssText|background|color|display)\b/u);
});

test('full library renders nested scenario resources through the shared browser protocol', () => {
    const panel = projectFile('src/stepLibraryPanel.ts');
    const client = projectFile('media/stepLibrary.js');
    const css = projectFile('media/stepLibrary.css');

    assert.match(panel, /listScenarioFiles/u);
    assert.match(client, /KotScenarioFilesProtocol/u);
    assert.match(client, /projectDirectChildren/u);
    assert.doesNotMatch(client, /filesRootNode/u);
    assert.match(client, /openScenarioFile/u);
    assert.match(client, /revealScenarioFile/u);
    assert.match(client, /setEditorDragData/u);
    assert.match(client, /beginDrop/u);
    assert.match(client, /scenario-resource-empty/u);
    assert.match(css, /scenario-resource/u);
    assert.match(css, /scenario-resource-empty/u);
    assert.match(panel, /data-empty-directory/u);
});

test('both Library surfaces render scenario files directly without a synthetic Files row', () => {
    const fullClient = projectFile('media/stepLibrary.js');
    const compactClient = projectFile('media/stepLibrarySidebar.js');
    const sharedProtocol = projectFile('media/scenarioFilesProtocol.js');

    for (const source of [fullClient, compactClient]) {
        assert.match(source, /projectDirectChildren/u);
        assert.doesNotMatch(source, /filesRootNode/u);
    }
    assert.doesNotMatch(sharedProtocol, /function filesRootNode/u);
});

test('first compiled main-scenario expansion keeps its entering animation until the next frame', () => {
    const compactClient = projectFile('media/stepLibrarySidebar.js');

    assert.match(
        compactClient,
        /function requestChildren\(parentId, offset, knownParent, renderSynchronousChildren = true\)/u
    );
    assert.match(
        compactClient,
        /if \(renderSynchronousChildren\) \{\s*queueMicrotask\(render\);\s*\}/u
    );
    assert.match(
        compactClient,
        /requestChildren\(node\.id, 0, node, false\)/u
    );
    assert.match(compactClient, /createPendingExpansionTracker\(\)/u);
    assert.doesNotMatch(compactClient, /animatedParentId\s*=\s*null/u);
});

test('full Library animates category branches and keeps filled favorite stars fixed at the trailing edge', () => {
    const client = projectFile('media/stepLibrary.js');
    const css = projectFile('media/stepLibrary.css');

    assert.match(client, /function setTreeChildrenExpandedState\(/u);
    assert.match(client, /setTreeChildrenExpandedState\(elements\.children, expanded\)/u);
    assert.doesNotMatch(client, /elements\.children\.hidden\s*=\s*!expanded/u);
    assert.match(
        css,
        /\.tree-children\s*\{[^}]*overflow:\s*hidden[^}]*max-height:\s*0[^}]*transition:/isu
    );
    assert.match(
        client,
        /protocol\.definitionRowActionOrder\(item\)/u
    );
    assert.match(client, /favorite\.className\s*=\s*'definition-action definition-favorite icon-button codicon'/u);
    assert.doesNotMatch(client, /definition-favorite scenario-resource-action/u);
    assert.match(client, /favorite\.classList\.toggle\('is-favorite', isFavorite\)/u);
    assert.match(css, /\.definition-favorite\.is-favorite\s*\{[^}]*opacity:\s*1/isu);
    assert.match(
        css,
        /\.definition-actions\.has-favorite\s*>\s*\.definition-action:not\(\.definition-favorite\)\s*\{[^}]*display:\s*none/isu
    );
    assert.match(
        css,
        /\.definition-row:hover\s+\.definition-actions\.has-favorite\s*>\s*\.definition-action[\s\S]*?display:\s*inline-flex/isu
    );
    assert.match(css, /\.definition-action\s*\{[^}]*background:\s*transparent/isu);
    assert.match(css, /\.definition-action:hover/isu);
});

test('full Library uses shared row semantics and opens resource leaves with one click', () => {
    const client = projectFile('media/stepLibrary.js');

    assert.match(client, /scenarioDefinitionRowAction\(/u);
    assert.match(client, /scenarioResourceRowAction\(/u);
    assert.match(
        client,
        /function openScenarioResourceNode[\s\S]*?command: 'openCompiledScenarioFeature'/u
    );
    assert.match(
        client,
        /function openScenarioResourceNode[\s\S]*?command: 'openScenarioFile'/u
    );
    assert.match(client, /row\.addEventListener\('click',[\s\S]*?scenarioResourceRowAction/u);
});

test('full Library keeps a stable disclosure gutter and animates resource branches', () => {
    const client = projectFile('media/stepLibrary.js');
    const css = projectFile('media/stepLibrary.css');

    assert.match(client, /definition-resource-disclosure-spacer/u);
    assert.match(client, /function animateScenarioResourceExpansion/u);
    assert.match(client, /function collapseScenarioResourceBeforeRender/u);
    assert.match(client, /requestAnimationFrame/u);
    assert.match(
        css,
        /\.scenario-resource-tree,\s*\.scenario-resource-children\s*\{[^}]*max-height:\s*0[^}]*transition:/su
    );
    assert.match(css, /\.definition-resource-disclosure-spacer/u);
    assert.match(
        css,
        /\.definition-row\s*\{[^}]*padding-inline-start:\s*30px/isu
    );
    assert.match(
        client,
        /message\.command === 'scenarioFileChildren'[\s\S]*?scenarioFileChildrenRenderTarget\(/u
    );
    assert.match(
        client,
        /protocol\.preserveScrollPosition\(definitionList,\s*\(\) => renderResults\(\)\)/u
    );
});

test('client shell is three-pane, accessible, responsive, and initially renders at most 100 rows', () => {
    const panel = projectFile('src/stepLibraryPanel.ts');
    const css = projectFile('media/stepLibrary.css');
    const client = projectFile('media/stepLibrary.js');

    assert.match(panel, /role="tree"/u);
    assert.match(panel, /role="listbox"/u);
    assert.match(panel, /aria-live="polite"/u);
    assert.match(css, /grid-template-columns/u);
    assert.match(css, /@media\s*\(max-width:/u);
    assert.match(client, /(?:const|let)\s+BATCH_SIZE\s*=\s*100/u);
    assert.match(client, /ArrowDown|ArrowUp|ArrowRight|ArrowLeft|Home|End|Escape/u);
    assert.match(panel, /id="detailsBack"/u);
    assert.equal((panel.match(/role="separator"/gu) ?? []).length, 2);
    assert.match(css, /\.pane-resizer/u);
    assert.match(css, /--category-pane-width/u);
    assert.match(css, /white-space:\s*pre;/u);
    assert.match(client, /resizePaneLayout/u);
});

test('definition list fits the middle pane and scrolls overflowing labels behind a fade', () => {
    const panel = projectFile('src/stepLibraryPanel.ts');
    const css = projectFile('media/stepLibrary.css');
    const client = projectFile('media/stepLibrary.js');

    assert.match(panel, /class="definition-list-content"/u);
    assert.match(css, /\.definition-list\s*\{[^}]*width:\s*100%;/su);
    assert.match(css, /\.definition-list\s*\{[^}]*min-width:\s*0;/su);
    assert.match(css, /\.definition-list-content\s*\{[^}]*display:\s*flex;/su);
    assert.match(css, /\.definition-list-content\s*\{[^}]*width:\s*100%;/su);
    assert.match(css, /\.definition-list-content\s*\{[^}]*min-width:\s*0;/su);
    assert.match(css, /\.definition-row\s*\{[^}]*width:\s*100%;/su);
    assert.match(css, /\.definition-row\s*\{[^}]*flex:\s*0\s+0\s+auto;/su);
    assert.match(client, /definition-text kot-tree-label/u);
    assert.match(client, /row\.className = 'definition-row kot-tree-row'/u);
    assert.match(client, /scenario-resource-row kot-tree-row/u);
    assert.match(client, /kot-scroll-content/u);
    assert.match(client, /--kot-overflow-distance/u);
    assert.match(client, /new ResizeObserver\(scheduleScenarioResourceLabelOverflowUpdate\)/u);
    assert.doesNotMatch(css, /definition-text-marquee|scenario-resource-marquee/u);
});

test('full Library overflow preview does not stay translated after pointer focus', () => {
    const css = projectFile('media/stepLibrary.css');

    assert.match(
        css,
        /\.details-scroll-label\.is-overflowing:hover\s+\.kot-scroll-content,\s*\.details-scroll-label\.is-overflowing:focus-visible\s+\.kot-scroll-content,\s*\.details-scroll-label\.is-overflowing:has\(:focus-visible\)\s+\.kot-scroll-content/isu
    );
    assert.doesNotMatch(
        css,
        /\.details-scroll-label\.is-overflowing:focus-within\s+\.kot-scroll-content/iu
    );
});

test('full Library scenario rows expose the same hover actions as the compact Library', () => {
    const panel = projectFile('src/stepLibraryPanel.ts');
    const client = projectFile('media/stepLibrary.js');
    const css = projectFile('media/stepLibrary.css');

    assert.match(panel, /data-insert=/u);
    assert.match(panel, /data-copy=/u);
    assert.match(client, /className = 'definition-actions kot-row-actions'/u);
    assert.match(client, /createDefinitionActionButton\('insert'/u);
    assert.match(client, /createDefinitionActionButton\('copy'/u);
    assert.match(client, /createDefinitionActionButton\('openDefinition'/u);
    assert.match(css, /\.definition-row:hover \.definition-actions/u);
});

test('full Library renders compiled feature and attachment files in the details pane', () => {
    const client = projectFile('media/stepLibrary.js');
    const css = projectFile('media/stepLibrary.css');

    assert.match(client, /function renderDetailsResources\(item\)/u);
    assert.match(client, /details-resource-list/u);
    assert.match(client, /projectCompiledScenarioChildren/u);
    assert.match(css, /\.details-resource-list/u);
});

test('full Library constrains third-pane labels and gives them the shared fade and hover-scroll behavior', () => {
    const client = projectFile('media/stepLibrary.js');
    const css = projectFile('media/stepLibrary.css');

    assert.match(client, /details-scroll-label kot-tree-label/u);
    assert.match(
        client,
        /querySelectorAll\(\s*'\.definition-text, \.scenario-resource-name, \.details-scroll-label'\s*\)/u
    );
    assert.match(client, /protocol\.overflowPresentation\(/u);
    assert.match(css, /\.details-content\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*hidden/isu);
    assert.match(css, /\.details-scroll-label\s*\{[^}]*max-width:\s*100%/isu);
    assert.match(css, /\.details-scroll-label\.is-overflowing:hover\s+\.kot-scroll-content/isu);
    assert.match(css, /\.details-resource-row\s*\{[^}]*max-width:\s*100%/isu);
});

test('full Library details pane loads direct files for nested scenarios', () => {
    const client = projectFile('media/stepLibrary.js');

    const renderStart = client.indexOf('    function renderDetailsResources(item)');
    const renderEnd = client.indexOf('    function renderDetails()', renderStart);
    const renderSource = client.slice(renderStart, renderEnd);

    assert.notEqual(renderStart, -1);
    assert.notEqual(renderEnd, -1);
    assert.match(renderSource, /item\.hasScenarioFiles !== true/u);
    assert.doesNotMatch(
        renderSource,
        /item\.hasScenarioFiles !== true \|\| !item\.compiledFeatureUri \|\| !item\.scenarioFilesRootUri/u
    );
    assert.match(renderSource, /scenarioExpansionId\(item\.id\)/u);
    assert.match(renderSource, /requestScenarioFileChildren\(root\)/u);
    assert.match(renderSource, /resourceChildrenByParent\.get\(root\.id\)/u);
});

test('full Library exposes one attachment context menu in results and details', () => {
    const panel = projectFile('src/stepLibraryPanel.ts');
    const client = projectFile('media/stepLibrary.js');
    const css = projectFile('media/stepLibrary.css');
    const resultsStart = client.indexOf('    function renderScenarioResourceNode(');
    const resultsEnd = client.indexOf('\n    function ', resultsStart + 20);
    const detailsStart = client.indexOf('    function renderDetailsResourceNode(');
    const detailsEnd = client.indexOf('\n    function ', detailsStart + 20);

    assert.match(panel, /data-delete=/u);
    assert.match(client, /function showScenarioResourceContextMenu\(/u);
    assert.match(client, /scenarioResourceContextActions/u);
    assert.match(client.slice(resultsStart, resultsEnd), /contextmenu/u);
    assert.match(client.slice(detailsStart, detailsEnd), /contextmenu/u);
    assert.match(client, /'deleteScenarioFile'/u);
    assert.match(client, /event\.preventDefault\(\)/u);
    assert.match(client, /event\.stopPropagation\(\)/u);
    assert.match(client, /closeScenarioResourceContextMenu/u);
    assert.match(client, /event\.key === 'Escape'/u);
    assert.match(client, /scenarioFileActionResult[\s\S]*action === 'delete'[\s\S]*resourceChildrenByParent\.delete/u);
    assert.match(css, /\.scenario-resource-context-menu\s*\{[^}]*position:\s*fixed/isu);
    assert.match(css, /--vscode-menu-background/u);
    assert.match(css, /--vscode-menu-foreground/u);
    assert.match(css, /--vscode-menu-border/u);
    assert.match(css, /--vscode-menu-selectionBackground/u);
});

test('client keeps tree and result interaction incremental', () => {
    const client = projectFile('media/stepLibrary.js');

    assert.match(client, /createResultPager/u);
    assert.match(client, /renderedRowsById/u);
    assert.match(client, /treeElementsById/u);
    assert.match(client, /snapshotItemsById/u);
    assert.match(client, /languageItemsCache/u);
    assert.match(client, /filteredItemsCache/u);
    assert.doesNotMatch(client, /requestAnimationFrame\(appendBatch\)/u);
});

test('inbound message type has no caller-supplied URI or arbitrary command shape', () => {
    const source = projectFile('src/stepLibraryPanel.ts');
    const typeBlock = source.match(
        /export type StepLibraryInboundMessage\s*=([\s\S]*?);\n/u
    )?.[1] ?? '';

    assert.match(typeBlock, /'ready'/u);
    assert.match(typeBlock, /'refresh'/u);
    assert.match(typeBlock, /'insert'/u);
    assert.match(typeBlock, /'copy'/u);
    assert.match(typeBlock, /'openDefinition'/u);
    assert.doesNotMatch(typeBlock, /uri|url|path/iu);
});

test('client gates insertion, supports copy shortcut, and suppresses duplicate actions', () => {
    const client = projectFile('media/stepLibrary.js');

    assert.match(client, /insertionTarget\.available/u);
    assert.match(client, /pendingActions/u);
    assert.match(client, /event\.(?:ctrlKey|metaKey)/u);
    assert.match(client, /message\.command\s*===\s*'actionResult'/u);
    assert.match(client, /prepareItems/u);
    assert.match(client, /reconcileCategorySelection/u);
    assert.match(client, /reconcileFiltersAndSelection/u);
    assert.match(client, /state\.snapshot\?\.viewIdentity[\s\S]*message\.snapshot\.viewIdentity/u);
    assert.match(client, /__normalizedDisplayText/u);
});

test('webview document language follows the active VS Code locale', () => {
    const panel = projectFile('src/stepLibraryPanel.ts');

    assert.match(panel, /vscode\.env\.language/u);
    assert.match(panel, /<html lang="\$\{documentLanguage\}">/u);
});

test('package and runtime locale bundles have matching keys for the visual library', () => {
    const packageEn = JSON.parse(projectFile('package.nls.json')) as Record<string, string>;
    const packageRu = JSON.parse(projectFile('package.nls.ru.json')) as Record<string, string>;
    const runtimeEn = JSON.parse(projectFile('l10n/bundle.l10n.json')) as Record<string, string>;
    const runtimeRu = JSON.parse(projectFile('l10n/bundle.l10n.ru.json')) as Record<string, string>;

    assert.deepEqual(Object.keys(packageRu).sort(), Object.keys(packageEn).sort());
    assert.deepEqual(Object.keys(runtimeRu).sort(), Object.keys(runtimeEn).sort());
    assert.ok(packageEn['cmd.openStepLibrary.title']);
    for (const key of [
        'KOT Step Library',
        'Search steps and scenarios',
        'Sources and categories',
        'All definitions',
        'Vanessa built-in steps',
        'User steps',
        'Exported scenarios',
        'Nested scenarios',
        'Main scenarios',
        'Scenario code',
        'Uncategorized',
        'Insert',
        'Copy',
        'Open definition',
        'Loading step library...',
        'Could not refresh the step library.',
        'Open Step Library',
        'Files',
        'Open externally',
        'Show in Finder / Explorer',
        'Replace',
        'Save copy',
        'Skip',
        'The resource action could not be completed.',
        'Empty directory'
    ]) {
        assert.ok(runtimeEn[key], `missing English runtime key: ${key}`);
        assert.ok(runtimeRu[key], `missing Russian runtime key: ${key}`);
    }
});

test('full Library uses the same explicit search clear affordance', () => {
    const panel = projectFile('src/stepLibraryPanel.ts');
    const script = projectFile('media/stepLibrary.js');
    const css = projectFile('media/stepLibrary.css');

    assert.match(panel, /search:\s*t\('Search steps and scenarios'\)/u);
    assert.match(panel, /id="searchClearBtn"[\s\S]*?search-clear-button/u);
    assert.match(script, /searchClearButton\.classList\.toggle\('hidden', !hasValue\)/u);
    assert.match(script, /searchClearButton\.addEventListener\('click'/u);
    assert.match(css, /\.search-clear-button:hover/u);
});

test('both Library surfaces load the same scenario files protocol and commands', () => {
    const fullPanel = projectFile('src/stepLibraryPanel.ts');
    const compactPanel = projectFile('src/stepLibrarySidebarProvider.ts');
    for (const source of [fullPanel, compactPanel]) {
        assert.match(source, /scenarioFilesProtocol\.js/u);
        assert.match(source, /data-empty-directory/u);
        for (const command of [
            'listScenarioFiles',
            'openScenarioFile',
            'revealScenarioFile',
            'prepareScenarioFileDrop',
            'appendScenarioFileChunk',
            'completeScenarioFileTransfer'
        ]) {
            assert.match(source, new RegExp(command, 'u'));
        }
    }
});
