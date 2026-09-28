import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function projectFile(relativePath: string): string {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('panel HTML uses a restrictive CSP, nonce scripts, and only local assets', () => {
    const source = projectFile('src/stepLibraryPanel.ts');

    assert.match(source, /default-src 'none'/u);
    assert.match(source, /style-src \$\{webview\.cspSource\}/u);
    assert.match(source, /font-src \$\{webview\.cspSource\}/u);
    assert.match(source, /script-src 'nonce-\$\{nonce\}'/u);
    assert.match(source, /stepLibrary\.css/u);
    assert.match(source, /stepLibraryProtocol\.js/u);
    assert.match(source, /stepLibrary\.js/u);
    assert.doesNotMatch(source, /https?:\/\//u);
});

test('step-library assets exist, are included by VSIX rules, and render data without innerHTML', () => {
    for (const relativePath of [
        'media/stepLibrary.css',
        'media/stepLibrary.js',
        'media/stepLibraryProtocol.js'
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

test('definition row backgrounds span the full horizontally scrollable list width', () => {
    const css = projectFile('media/stepLibrary.css');

    assert.match(css, /\.definition-list\s*\{[^}]*display:\s*flex;/su);
    assert.match(css, /\.definition-list\s*\{[^}]*flex-direction:\s*column;/su);
    assert.match(css, /\.definition-list\s*\{[^}]*width:\s*max-content;/su);
    assert.match(css, /\.definition-list\s*\{[^}]*min-width:\s*100%;/su);
    assert.match(css, /\.definition-row\s*\{[^}]*width:\s*100%;/su);
    assert.match(css, /\.definition-row\s*\{[^}]*flex:\s*0\s+0\s+auto;/su);
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
        'Search steps',
        'Sources and categories',
        'All definitions',
        'Vanessa built-in steps',
        'User steps',
        'Export scenarios',
        'Nested scenarios',
        'Main scenarios',
        'Scenario code',
        'Uncategorized',
        'Insert',
        'Copy',
        'Open definition',
        'Loading step library...',
        'Could not refresh the step library.',
        'Open Step Library'
    ]) {
        assert.ok(runtimeEn[key], `missing English runtime key: ${key}`);
        assert.ok(runtimeRu[key], `missing Russian runtime key: ${key}`);
    }
});
