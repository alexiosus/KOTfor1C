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

test('Test Manager loads the shared native sidebar stylesheet', () => {
    assert.match(html, /<link href="\$\{sidebarStylesUri\}" rel="stylesheet">/u);
    assert.match(provider, /media', 'kotSidebar\.css'/u);
    assert.match(provider, /replace\('\$\{sidebarStylesUri\}', sidebarStylesUri\.toString\(\)\)/u);
    assert.equal(fs.existsSync(sharedCssPath), true);
});

test('shared tree primitives prevent horizontal overflow and preserve a fixed action gutter', () => {
    const css = read('media/kotSidebar.css');
    assert.match(css, /\.kot-tree\s*\{[^}]*overflow-x:\s*hidden/isu);
    assert.match(css, /\.kot-tree-label\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/isu);
    assert.match(css, /\.kot-row-actions\s*\{[^}]*flex:\s*0\s+0\s+var\(--kot-sidebar-action-gutter\)/isu);
    assert.match(css, /\.kot-tree-row\s*\{[^}]*min-height:\s*(?:30|31|32)px/isu);
    assert.match(css, /\.kot-icon-button\s*\{[^}]*min-height:\s*(?:28|29|30)px/isu);
    assert.match(phaseCss, /\.phase-tree-container\s*\{[^}]*overflow-x:\s*hidden/isu);
});

test('sidebar colors use VS Code theme tokens and distinguish current from relationships', () => {
    const css = read('media/kotSidebar.css');
    assert.match(css, /--kot-sidebar-related:\s*var\(--vscode-charts-purple/u);
    assert.match(css, /\.is-current\s*\{[^}]*--vscode-list-activeSelectionBackground/isu);
    assert.match(css, /\.is-related\s*\{[^}]*--kot-sidebar-related/isu);
    assert.match(css, /\.is-transitive\s*\{[^}]*opacity/isu);
    assert.match(css, /\.is-modified[\s\S]*--vscode-editorWarning-foreground/u);
});

test('tree toggles and icon-only controls expose localized accessible names', () => {
    assert.match(script, /setAttribute\('aria-expanded',\s*phaseExpandedState\[phaseName\] \? 'true' : 'false'\)/u);
    assert.match(script, /button\.setAttribute\('aria-expanded', nextExpanded \? 'true' : 'false'\)/u);

    const iconOnlyButtons = [...html.matchAll(/<button\b(?=[^>]*\bicon-only\b)[^>]*>/gsu)]
        .map(match => match[0]);
    assert.ok(iconOnlyButtons.length >= 8);
    for (const button of iconOnlyButtons) {
        assert.match(button, /aria-label="\$\{loc\.[A-Za-z0-9]+\}"/u);
    }
});

test('relationship, current, and modified states have non-color text alternatives', () => {
    assert.match(html, /id="relationshipToggleBtn"[^>]*aria-pressed="true"[^>]*aria-label="\$\{loc\.relationshipToggleTitle\}"/su);
    assert.match(html, /id="relationshipCurrentContext"[^>]*aria-live="polite"/su);
    assert.match(html, /id="relationshipSummaryContext"/u);
    assert.match(script, /class="scenario-relationship-icon[^"\n]*"[^>]*role="img"[^>]*aria-label=/u);
    assert.match(script, /class="kot-modified"[^>]*title="\$\{viewState\.escapedModifiedTitle\}"[^>]*aria-label=/u);
});

test('relationship toggle and compact context remain independent from build checkboxes', () => {
    assert.match(
        script,
        /relationshipToggleBtn\.addEventListener\('click'[\s\S]*?command: 'setRelationshipHighlightEnabled'[\s\S]*?enabled: !relationshipState\.enabled/u
    );
    assert.match(script, /function renderRelationshipContext\(\)/u);
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
    assert.match(script, /scrollTop:\s*phaseTreeContainer\.scrollTop/u);
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

    assert.match(compactCss, /overflow-x:\s*hidden/u);
    assert.match(compactCss, /\.kot-tree-label\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/isu);
    assert.match(compactCss, /white-space:\s*pre/u);
    assert.doesNotMatch(compactCss, /gradient|box-shadow/iu);
});

test('compact Step Library exposes relationship direction without horizontal overflow', () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), 'media/stepLibrarySidebar.js')), true);
    const compactScript = read('media/stepLibrarySidebar.js');
    const compactCss = read('media/stepLibrarySidebar.css');

    assert.match(compactScript, /relationshipDecorationForNode/u);
    assert.match(compactScript, /arrow-right-to-line|arrow-right-from-line/u);
    assert.match(compactScript, /git-branch/u);
    assert.match(compactScript, /aria-expanded/u);
    assert.match(compactCss, /\.is-current/u);
    assert.match(compactCss, /\.is-related/u);
    assert.match(compactCss, /\.is-transitive/u);
    assert.match(compactCss, /overflow-x:\s*hidden/u);
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
    assert.match(compactScript, /activeMarker/u);
    assert.match(compactScript, /aria-haspopup/u);
    assert.match(compactScript, /Escape/u);
    assert.match(compactScript, /getState\(\)/u);
    assert.match(compactScript, /setState\(/u);
    assert.doesNotMatch(compactScript, /innerHTML\s*=/u);
    assert.match(compactCss, /overflow-x:\s*hidden/u);
    assert.doesNotMatch(compactCss, /gradient|box-shadow/iu);
});

test('compact workbench views source user-facing strings from localization bundles', () => {
    const english = JSON.parse(read('l10n/bundle.l10n.json')) as Record<string, string>;
    const russian = JSON.parse(read('l10n/bundle.l10n.ru.json')) as Record<string, string>;
    const requiredKeys = [
        'Search steps',
        'Refresh step library',
        'Open full Step Library',
        'Currently open scenario',
        'Calls the open scenario directly',
        'Called by the open scenario directly',
        'Active profile infobase',
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

test('workbench performance gates are structural rather than wall-clock thresholds', () => {
    const performanceTests = read('test/stepLibraryPerformance.test.ts');
    assert.match(performanceTests, /without scans or path lookup/u);
    assert.match(performanceTests, /share one in-flight resolver generation/u);
    assert.match(performanceTests, /share one in-flight collector generation/u);
    assert.doesNotMatch(performanceTests, /assert\.(?:ok|equal)\([^\n]*durationMs/u);

    const compactProviderTests = read('test/stepLibrarySidebarProvider.test.ts');
    assert.match(compactProviderTests, /initial ready posts loading and five roots without transferring the snapshot/u);
    assert.match(compactProviderTests, /expand and search return bounded host-side pages only/u);
    assert.match(compactProviderTests, /defers hidden invalidation and publishes the latest revision when shown again/u);
});
