import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { VanessaControlSession } from './vanessaControlSession';
import { createVanessaDiagnosticArchive } from './vanessaControlDiagnosticArchive';
import { redactVanessaDiagnosticText, type VanessaDiagnosticReport } from './vanessaControlDiagnostics';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';

/** One explicit local report. No background log collection, source execution, or automatic upload. */
export function registerVanessaDiagnosticsCommands(context: vscode.ExtensionContext, session: VanessaControlSession, ensureConnected: () => Promise<boolean>): void {
    let panel: vscode.WebviewPanel | undefined; let report: VanessaDiagnosticReport | undefined;
    let detail: { title: string; text: string } | undefined; let error: string | undefined; let busy = false;
    let controller: AbortController | undefined; let generation = session.snapshot.generation; let lastEditor = vscode.window.activeTextEditor;
    const images: Buffer[] = []; const options = { managerLog: false, clientLog: false };
    const render = () => { void panel?.webview.postMessage({ report: report && { ...report, sections: report.sections.map(section => ({ ...section,
        text: section.status === 'error' && section.text ? vscode.l10n.t(section.text) : section.text })) }, detail, error, busy, images: images.map(data => data.toString('base64')) }); };
    const clear = () => { report = undefined; detail = undefined; error = undefined; images.length = 0; render(); };
    const html = () => {
        const nonce = randomBytes(16).toString('hex');
        const escape = (text: string) => text.replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
        const t = (text: string) => escape(vscode.l10n.t(text));
        const buttons = [['refresh', 'Refresh'], ['managerLog', 'Manager log'], ['clientLog', 'Client log'], ['screenshot', 'Screenshot'],
            ['search', 'Search runtime steps'], ['syntax', 'Check feature syntax'], ['export', 'Export ZIP'], ['clear', 'Clear']];
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size)/1.5 var(--vscode-font-family)}
header{padding:18px 22px;border-bottom:1px solid var(--vscode-panel-border)}h1{margin:0 0 12px;font-size:20px}nav{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;padding:5px 10px;border:1px solid var(--vscode-button-border,transparent);color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled{opacity:.5;cursor:default}main{padding:12px 22px 24px}details{border-bottom:1px solid var(--vscode-panel-border);padding:10px 0}
summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}pre{font:var(--vscode-editor-font-size)/1.5 var(--vscode-editor-font-family);white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}
img{display:block;max-width:100%;margin:16px 0}#status{color:var(--vscode-descriptionForeground);min-height:1.5em;margin-top:8px}#error{color:var(--vscode-errorForeground)}
</style></head><body><header><h1>${t('Vanessa diagnostics')}</h1><nav>${buttons.map(([command, label]) => `<button data-command="${command}">${t(label)}</button>`).join('')}</nav>
<div id="status"></div><div id="error" role="alert"></div></header><main id="content"></main><script nonce="${nonce}">
const vscode=acquireVsCodeApi();const content=document.getElementById('content');
document.querySelector('nav').addEventListener('click',e=>{const button=e.target.closest('button');if(button)vscode.postMessage({command:button.dataset.command});});
const labels=${JSON.stringify({ busy: vscode.l10n.t('Request in progress…'), empty: vscode.l10n.t('Collect a report or choose a diagnostic action.'),
            available: vscode.l10n.t('Available'), unavailable: vscode.l10n.t('Unavailable in this session'), error: vscode.l10n.t('Could not read this section'),
            get_vanessa_automation_state: vscode.l10n.t('Vanessa state'), get_environment_data: vscode.l10n.t('Environment and versions'),
            manage_test_client_profiles: vscode.l10n.t('Test clients'), get_test_results: vscode.l10n.t('Test results'),
            get_event_log_manager: vscode.l10n.t('Manager log'), get_event_log_test_client: vscode.l10n.t('Client log') }).replace(/</gu, '\\u003c')};
window.addEventListener('message',e=>{const state=e.data;document.getElementById('status').textContent=state.busy?labels.busy:state.report?.createdAt||'';
document.getElementById('error').textContent=state.error||'';document.querySelectorAll('button').forEach(b=>b.disabled=!!state.busy||(b.dataset.command==='export'&&!state.report));content.replaceChildren();
if(!state.report&&!state.detail){const p=document.createElement('p');p.textContent=labels.empty;content.append(p);}
for(const row of state.report?.sections||[]){const group=document.createElement('details');const title=document.createElement('summary');title.textContent=(labels[row.tool]||row.tool)+' · '+labels[row.status];group.append(title);
const pre=document.createElement('pre');pre.textContent=row.text||labels[row.status];group.append(pre);content.append(group);}
if(state.detail){const h=document.createElement('h2');h.textContent=state.detail.title;const pre=document.createElement('pre');pre.textContent=state.detail.text;content.append(h,pre);}
for(const image of state.images||[]){const img=document.createElement('img');img.src='data:image/png;base64,'+image;content.append(img);}});vscode.postMessage({command:'ready'});
</script></body></html>`;
    };
    const show = () => {
        if (panel) { panel.reveal(); return; }
        panel = vscode.window.createWebviewPanel('kotVanessaDiagnostics', vscode.l10n.t('Vanessa diagnostics'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
        panel.webview.html = html();
        context.subscriptions.push(panel.onDidDispose(() => { controller?.abort(); panel = undefined; clear(); }), panel.webview.onDidReceiveMessage(message => {
            if (!message || typeof message.command !== 'string') { return; }
            const actions: Record<string, () => unknown> = { ready: render, refresh: collect, managerLog: () => { options.managerLog = true; return collect(); },
                clientLog: () => { options.clientLog = true; return collect(); }, search, syntax, screenshot, export: exportReport,
                clear: () => { if (!busy) { options.managerLog = false; options.clientLog = false; clear(); } } };
            if (Object.hasOwn(actions, message.command)) { return actions[message.command](); }
        }));
    };
    const run = async (title: string, work: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
        if (busy) { return; } show(); busy = true; error = undefined; render();
        const own = new AbortController();
        try {
            if (!await ensureConnected() || !panel) { return; }
            controller = own;
            const ownGeneration = session.snapshot.generation;
            const current = () => !!panel && !own.signal.aborted && ownGeneration === session.snapshot.generation;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t(title), cancellable: true }, async (_progress, token) => {
                const cancel = token.onCancellationRequested(() => own.abort());
                try { if (token.isCancellationRequested) { own.abort(); } await work(own.signal, current); }
                finally { cancel.dispose(); }
            });
        } catch (failure) {
            if (!own.signal.aborted) { error = vscode.l10n.t(redactVanessaDiagnosticText(failure instanceof Error ? failure.message : 'The diagnostic request failed.')); void vscode.window.showErrorMessage(error); }
        } finally { if (controller === own) { controller = undefined; } busy = false; render(); }
    };
    const collect = () => run('Vanessa: collecting diagnostics…', async (signal, current) => {
        const value = await session.withDiagnosticControl(d => d.collect(options, signal)); if (current()) { report = value; }
    });
    const search = () => run('Vanessa: searching runtime steps…', async (signal, current) => {
        const query = await vscode.window.showInputBox({ title: vscode.l10n.t('Search steps in the running Vanessa'), ignoreFocusOut: true });
        if (!query || !current()) { return; }
        const text = await session.withDiagnosticControl(d => d.search(query, signal)); if (current()) { detail = { title: vscode.l10n.t('Runtime step search'), text }; }
    });
    const syntax = () => {
        const document = vscode.window.activeTextEditor?.document ?? lastEditor?.document;
        return run('Vanessa: checking feature syntax…', async (signal, current) => {
            if (!document || document.isClosed || document.uri.scheme !== 'file' || !/\.feature$/iu.test(document.uri.fsPath)) { throw new Error(vscode.l10n.t('Open a saved feature file before runtime syntax validation.')); }
            if (document.isDirty && !await document.save()) { return; }
            const text = document.getText(); const version = document.version;
            if (!current() || !nativeDocumentTextMatchesFileText(text, await fs.readFile(document.uri.fsPath, 'utf8'))) { throw new Error(vscode.l10n.t('The feature source changed. Run syntax validation again.')); }
            const result = await session.withDiagnosticControl(d => d.checkSyntax(document.uri.fsPath, signal));
            if (!current() || document.isClosed || document.isDirty || document.version !== version || document.getText() !== text) { throw new Error(vscode.l10n.t('The feature source changed. Run syntax validation again.')); }
            detail = { title: vscode.l10n.t('Runtime syntax validation'), text: result };
        });
    };
    const screenshot = () => run('Vanessa: capturing client window…', async (signal, current) => {
        const windows = await session.withDiagnosticControl(d => d.windows(signal));
        const title = await vscode.window.showQuickPick([...windows.titles], { title: vscode.l10n.t('Select a test-client window'), ignoreFocusOut: true });
        if (!title || !current()) { return; }
        const image = await session.withDiagnosticControl(d => d.screenshot(windows, title, signal));
        if (current()) {
            if (images.reduce((total, value) => total + value.length, image.length) > 64_000_000) { throw new Error(vscode.l10n.t('Clear the diagnostic report before capturing more screenshots.')); }
            images.push(image);
        }
    });
    const exportReport = () => run('Vanessa: exporting diagnostics…', async (_signal, current) => {
        if (!report) { return; }
        const include = images.length ? await vscode.window.showQuickPick([
            { label: vscode.l10n.t('Report only'), include: false }, { label: vscode.l10n.t('Report and screenshots (images are not redacted)'), include: true }
        ], { title: vscode.l10n.t('Diagnostic package contents'), ignoreFocusOut: true }) : { include: false };
        if (!include || !current()) { return; }
        const target = await vscode.window.showSaveDialog({ title: vscode.l10n.t('Export local diagnostic package'), filters: { ZIP: ['zip'] } });
        if (!target || !current()) { return; }
        const data = await createVanessaDiagnosticArchive(report, images, include.include);
        if (current()) { await vscode.workspace.fs.writeFile(target, data); }
    });
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => { if (editor?.document.uri.scheme === 'file') { lastEditor = editor; } }),
        session.onDidChange(() => { if (generation !== session.snapshot.generation) { generation = session.snapshot.generation; controller?.abort(); clear(); } }),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.diagnostics', collect),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.searchRuntimeSteps', search),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.checkRuntimeSyntax', syntax),
        { dispose: () => { controller?.abort(); panel?.dispose(); clear(); } });
}
