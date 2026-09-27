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
    assert.doesNotMatch(client, /\.style\./u);
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
});
