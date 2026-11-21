import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { VanessaSetting, VanessaSettingsReply } from './vanessaControlSettings';
import type { VanessaControlSession } from './vanessaControlSession';

type Phase = 'preview' | 'applying' | 'result' | 'details' | 'cancelled' | 'stale' | 'unconfirmed';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Render server values as text only; the page never receives executable markup or arbitrary commands. */
export function settingsReportHtml(report: VanessaSettingsReply, items: readonly VanessaSetting[], phase: Phase, assets: { style: string; csp: string; nonce: string }): string {
    const t = vscode.l10n.t;
    const names = new Map(items.flatMap(item => [[item.key, item.synonym || item.key], [item.path, item.synonym || item.path]] as const));
    const name = (key: unknown) => names.get(String(key)) ?? (key === 'GlobalVars' ? t('Global variables') : String(key ?? ''));
    const entry = (value: unknown): string => {
        if (!value || typeof value !== 'object') { return `<li>${escape(name(value))}</li>`; }
        const row = value as Record<string, unknown>;
        const message = [row.message, row.hint].filter(value => typeof value === 'string' && value).join(' ');
        const detail = message || (typeof row.reason === 'string' ? row.reason : typeof row.code === 'string' ? row.code : '');
        return `<li>${row.key ? `<strong>${escape(name(row.key))}</strong>` : ''}${detail ? `<p>${escape(detail)}</p>` : ''}</li>`;
    };
    const section = (title: string, values: readonly unknown[], className = '') => values.length
        ? `<section class="${className}"><h2>${escape(title)} <span class="count">${values.length}</span></h2><ul>${values.map(entry).join('')}</ul></section>` : '';
    const preview = phase === 'preview';
    const failed = !report.ok || report.errors.length > 0;
    const title = phase === 'applying' ? t('Applying Vanessa settings…') : phase === 'cancelled' ? t('Application cancelled')
        : phase === 'stale' ? t('The Vanessa connection changed') : phase === 'unconfirmed' ? t('Application was not confirmed')
            : preview ? t('Review Vanessa settings') : phase === 'result' && !failed ? t('Vanessa settings applied') : t('Vanessa settings report');
    const summary = phase === 'stale' ? t('Open the settings command again to check the current session.')
        : phase === 'unconfirmed' ? t('Refresh the connection and check the current settings before trying again.')
            : phase === 'cancelled' ? t('These settings were not applied.')
                : phase === 'applying' ? t('Waiting for Vanessa to confirm the changes.')
                    : failed ? t('Some settings could not be processed. Review the errors below.')
                        : preview ? t('Check the proposed changes, then apply them to the running Vanessa session.')
                            : phase === 'result' ? t('Vanessa confirmed the result shown below.') : '';
    const changed = new Set(report.changed.filter(value => typeof value === 'string'));
    const equal = report.applied.filter(value => typeof value === 'string' && !changed.has(value));
    const item = report.item;
    const details = item ? `<section><h2>${escape(item.synonym || item.key)}</h2><p>${escape(item.hint)}</p><dl><dt>${escape(t('Current value'))}</dt><dd>${escape(item.password_mode ? '••••' : item.current)}</dd></dl></section>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${assets.csp}; script-src 'nonce-${assets.nonce}';"><link rel="stylesheet" href="${escape(assets.style)}"></head><body>
        <header><p class="eyebrow">Vanessa Automation</p><h1>${escape(title)}</h1><p role="status">${escape(summary)}</p></header><main>
        ${section(t('Errors'), report.errors, 'errors')}${section(t('Warnings'), report.warnings, 'warnings')}
        ${details}${section(phase === 'result' ? t('Settings changed') : t('Proposed changes'), report.changed)}
        ${section(t('Already match the requested values'), equal)}${section(t('Skipped settings'), report.ignored)}
        ${report.out_of_scope.length ? `<section><h2>${escape(t('Managed separately'))}</h2><p>${escape(t('Test client profiles and global variables are managed separately from Vanessa settings.'))}</p><ul>${report.out_of_scope.map(entry).join('')}</ul></section>` : ''}
        ${!details && !report.changed.length && !equal.length && !report.ignored.length && !report.out_of_scope.length && !failed ? `<p>${escape(t('No settings need to be changed.'))}</p>` : ''}
        </main>${preview && !failed ? `<footer><button id="apply" class="primary">${escape(t('Apply settings'))}</button><button id="cancel">${escape(t('Cancel'))}</button></footer>` : ''}
        <script nonce="${assets.nonce}">const api=acquireVsCodeApi();for(const action of ['apply','cancel'])document.getElementById(action)?.addEventListener('click',()=>{for(const button of document.querySelectorAll('button'))button.disabled=true;api.postMessage({action,pageId:'${assets.nonce}'});});</script></body></html>`;
}

/** One page for preview and outcome; closing or changing sessions cancels a pending confirmation. */
export class VanessaSettingsReport implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private report?: VanessaSettingsReply;
    private items: readonly VanessaSetting[] = [];
    private confirmation?: { current(): boolean; resolve(value: boolean): void };
    private pageId = '';
    private readonly connection: vscode.Disposable;
    constructor(private readonly context: vscode.ExtensionContext, session: VanessaControlSession) {
        this.connection = session.onDidChange(() => {
            if (this.confirmation && !this.confirmation.current()) { this.finish(false, 'stale'); }
        });
    }
    show(report: VanessaSettingsReply, items: readonly VanessaSetting[] = [], phase: Phase = 'details'): void {
        this.finish(false);
        this.report = report; this.items = items;
        if (!this.panel) {
            const panel = vscode.window.createWebviewPanel('kotTestToolkit.vanessaSettingsReport', vscode.l10n.t('Vanessa settings report'), vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
            this.panel = panel;
            const receive = panel.webview.onDidReceiveMessage(message => {
                if (message?.pageId !== this.pageId) { return; }
                if (message?.action === 'cancel') { this.finish(false, 'cancelled'); }
                if (message?.action === 'apply' && this.confirmation) {
                    const current = this.confirmation.current();
                    this.finish(current, current ? 'applying' : 'stale');
                }
            });
            const close = panel.onDidDispose(() => { this.panel = undefined; this.finish(false); receive.dispose(); close.dispose(); });
        }
        this.render(phase); this.panel.reveal();
    }
    async confirm(report: VanessaSettingsReply, items: readonly VanessaSetting[], current: () => boolean): Promise<boolean> {
        this.show(report, items, current() ? 'preview' : 'stale');
        if (!current() || !report.ok || report.errors.length) { return false; }
        return new Promise(resolve => { this.confirmation = { current, resolve }; });
    }
    unconfirmed(): void { if (this.panel) { this.finish(false, 'unconfirmed'); } }
    private finish(value: boolean, phase?: Phase): void {
        const pending = this.confirmation; this.confirmation = undefined;
        if (phase) { this.render(phase); }
        pending?.resolve(value);
    }
    private render(phase: Phase): void {
        if (!this.panel || !this.report) { return; }
        this.pageId = randomUUID().replace(/-/gu, '');
        this.panel.webview.html = settingsReportHtml(this.report, this.items, phase, {
            style: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vanessaSettingsReport.css')).toString(),
            csp: this.panel.webview.cspSource, nonce: this.pageId
        });
    }
    dispose(): void { this.connection.dispose(); this.finish(false); this.panel?.dispose(); }
}
