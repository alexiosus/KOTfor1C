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
