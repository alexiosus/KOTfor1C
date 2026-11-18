import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { VanessaSettingsReply } from '../src/vanessaControlSettings';

const preview: VanessaSettingsReply = { ok: true, revision: 8, errors: [], warnings: [], ignored: [], out_of_scope: ['GlobalVars'],
    changed: ['useaddin'], applied: ['useaddin', 'filtertags'], dry_run: true };
function harness() {
    let receive!: (message: unknown) => void; let close!: () => void; let connection!: () => void; let creates = 0;
    const panel = { reveal() {}, dispose: () => close(), onDidDispose: (callback: typeof close) => { close = callback; return { dispose() {} }; },
        webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (uri: unknown) => String(uri),
            onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return { dispose() {} }; } } };
    const vscode = { l10n: { t: (text: string) => text }, ViewColumn: { One: 1 }, Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') },
        window: { createWebviewPanel: () => { creates++; return panel; } } };
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlSettingsReport.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => name === 'vscode' ? vscode : require(name) });
    const view = new module.exports.VanessaSettingsReport({ extensionUri: 'extension' }, { onDidChange: (callback: typeof connection) => { connection = callback; return { dispose() {} }; } });
    const pageId = () => /pageId:'([^']+)'/u.exec(panel.webview.html)![1];
    return { view, panel, close: () => close(), changed: () => connection(), creates: () => creates,
        send: (action: string, id = pageId()) => receive({ action, pageId: id }), pageId, html: module.exports.settingsReportHtml };
}

test('human-readable preview applies once and updates the same page with a confirmed outcome', async () => {
    const h = harness();
    const pending = h.view.confirm(preview, [{ key: 'useaddin', path: 'useaddin', synonym: 'Use VanessaExt' }], () => true);
    assert.match(h.panel.webview.html, /Review Vanessa settings/u);
    assert.match(h.panel.webview.html, /Use VanessaExt/u);
    assert.match(h.panel.webview.html, /Already match the requested values/u);
    assert.match(h.panel.webview.html, /Managed separately/u);
    const oldPage = h.pageId(); h.send('apply'); h.send('apply', oldPage);
    assert.equal(await pending, true); assert.match(h.panel.webview.html, /Applying Vanessa settings/u);
    h.view.show({ ...preview, dry_run: false }, [], 'result');
    assert.equal(h.creates(), 1); assert.match(h.panel.webview.html, /Vanessa settings applied/u);
    assert.ok(!h.panel.webview.html.includes('id="apply"')); assert.ok(!h.panel.webview.html.includes('"revision"'));
});

for (const action of ['cancel', 'close', 'connection'] as const) {
    test(`${action} ends preview without applying settings`, async () => {
        const h = harness(); let current = true;
        const pending = h.view.confirm(preview, [], () => current);
        if (action === 'close') { h.close(); }
        else if (action === 'connection') { current = false; h.changed(); }
        else { h.send('cancel'); }
        assert.equal(await pending, false);
        if (action !== 'close') { assert.ok(!h.panel.webview.html.includes('id="apply"')); }
    });
}

test('messages from an older report cannot confirm a new preview and errors never offer Apply', async () => {
    const h = harness(); const first = h.view.confirm(preview, [], () => true); const oldPage = h.pageId();
    h.send('cancel'); assert.equal(await first, false);
    let applied = false; const next = h.view.confirm(preview, [], () => true).then((value: boolean) => { applied = value; return value; });
    h.send('apply', oldPage); await Promise.resolve(); assert.equal(applied, false);
    h.send('cancel'); assert.equal(await next, false);
    assert.equal(await h.view.confirm({ ...preview, ok: false, errors: ['Rejected'] }, [], () => true), false);
    assert.ok(!h.panel.webview.html.includes('id="apply"'));
});

test('report values stay escaped, passwords stay masked and an uncertain write is never described as applied', async () => {
    const h = harness(); const attack = '</script><img src=x onerror=alert(1)>';
    h.view.show({ ...preview, item: { key: 'password', path: 'password', synonym: attack, current: 'private-password', settable: true, password_mode: true },
        errors: [{ key: attack, message: attack, hint: 'Try again' }], warnings: ['Warning'], ignored: [{ key: 'Flag', message: 'Not available in this version' }] });
    assert.ok(!h.panel.webview.html.includes('<img')); assert.ok(!h.panel.webview.html.includes('private-password'));
    assert.match(h.panel.webview.html, /&lt;img/u); assert.match(h.panel.webview.html, /Try again/u);
    h.view.unconfirmed(); assert.match(h.panel.webview.html, /Application was not confirmed/u);
    assert.ok(!h.panel.webview.html.includes('Vanessa settings applied'));
});
