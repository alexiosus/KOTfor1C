import * as vscode from 'vscode';
import { getTranslator } from './localization';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import {
    buildStepLibrarySnapshot,
    type StepLibrarySnapshot
} from './stepLibraryModel';

export interface StepLibraryPanelServices {
    readonly extensionUri: vscode.Uri;
    readonly resolver: ProjectDefinitionResolver;
    readonly refreshDefinitions: (resource?: vscode.Uri) => Promise<void>;
}

export type StepLibraryInboundMessage =
    | { readonly command: 'ready' }
    | { readonly command: 'refresh' }
    | { readonly command: 'insert'; readonly itemId: string }
    | { readonly command: 'copy'; readonly itemId: string }
    | { readonly command: 'openDefinition'; readonly itemId: string };

type Translator = (message: string, ...args: string[]) => string;

function getNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let index = 0; index < 32; index += 1) {
        result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return result;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function errorMessage(error: unknown): string {
    if (
        error
        && typeof error === 'object'
        && 'message' in error
        && typeof error.message === 'string'
    ) {
        return error.message;
    }
    return String(error);
}

export function parseStepLibraryInboundMessage(value: unknown): StepLibraryInboundMessage | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.command === 'ready' || record.command === 'refresh') {
        return { command: record.command };
    }
    if (
        record.command === 'insert'
        || record.command === 'copy'
        || record.command === 'openDefinition'
    ) {
        const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : '';
        return itemId ? { command: record.command, itemId } : null;
    }
    return null;
}

export class StepLibraryPanel implements vscode.Disposable {
    public static readonly panelType = 'kotTestToolkit.stepLibraryPanel';

    private panel: vscode.WebviewPanel | null = null;
    private readonly disposables: vscode.Disposable[] = [];
    private panelDisposables: vscode.Disposable[] = [];
    private resource: vscode.Uri | undefined;
    private loadGeneration = 0;
    private activeLoads = 0;
    private pendingRefreshWhenVisible = false;
    private lastPostedIdentity: string | null = null;
    private lastSuccessfulSnapshot: StepLibrarySnapshot | null = null;
    private readonly insertionTargetIdentity = 'unavailable';

    constructor(private readonly services: StepLibraryPanelServices) {
        this.disposables.push(this.services.resolver.onDidChangeView(() => {
            this.scheduleRefresh();
        }));
    }

    public async open(resource?: vscode.Uri): Promise<void> {
        if (resource) {
            this.resource = resource;
        }
        const t = await getTranslator(this.services.extensionUri);
        if (this.panel) {
            this.panel.title = t('KOT Step Library');
            this.panel.reveal(vscode.ViewColumn.One);
            await this.refreshSnapshot();
            return;
        }

        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        const panel = vscode.window.createWebviewPanel(
            StepLibraryPanel.panelType,
            t('KOT Step Library'),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [mediaUri]
            }
        );
        this.panel = panel;
        this.lastPostedIdentity = null;
        this.lastSuccessfulSnapshot = null;
        panel.webview.html = this.getWebviewHtml(panel.webview, t);
        this.panelDisposables = [
            panel.onDidDispose(() => {
                this.loadGeneration += 1;
                this.disposePanelSubscriptions();
                if (this.panel === panel) {
                    this.panel = null;
                }
                this.lastPostedIdentity = null;
                this.lastSuccessfulSnapshot = null;
                this.pendingRefreshWhenVisible = false;
            }),
            panel.onDidChangeViewState(event => {
                if (!event.webviewPanel.visible) {
                    return;
                }
                if (this.pendingRefreshWhenVisible) {
                    this.pendingRefreshWhenVisible = false;
                }
                void this.refreshSnapshot();
            }),
            panel.webview.onDidReceiveMessage(rawMessage => {
                const message = parseStepLibraryInboundMessage(rawMessage);
                if (message) {
                    void this.handleMessage(message);
                }
            })
        ];

        await this.refreshSnapshot();
    }

    public dispose(): void {
        this.loadGeneration += 1;
        this.disposePanelSubscriptions();
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        const panel = this.panel;
        this.panel = null;
        panel?.dispose();
        this.lastPostedIdentity = null;
        this.lastSuccessfulSnapshot = null;
    }

    private disposePanelSubscriptions(): void {
        for (const disposable of this.panelDisposables.splice(0)) {
            disposable.dispose();
        }
    }

    private scheduleRefresh(): void {
        if (!this.panel) {
            return;
        }
        if (!this.panel.visible) {
            this.pendingRefreshWhenVisible = true;
            return;
        }
        void this.refreshSnapshot();
    }

    private async refreshSnapshot(): Promise<void> {
        const panel = this.panel;
        if (!panel) {
            return;
        }
        if (!panel.visible) {
            this.pendingRefreshWhenVisible = true;
            return;
        }
        const generation = ++this.loadGeneration;
        this.activeLoads += 1;
        try {
            if (!this.lastSuccessfulSnapshot) {
                await panel.webview.postMessage({ command: 'loading' });
            }
            const view = await this.services.resolver.getView(this.resource);
            if (generation !== this.loadGeneration || this.panel !== panel) {
                return;
            }
            if (!panel.visible) {
                this.pendingRefreshWhenVisible = true;
                return;
            }
            const snapshot = buildStepLibrarySnapshot(view);
            this.lastSuccessfulSnapshot = snapshot;
            await this.postSnapshotIfChanged(snapshot);
        } catch (error) {
            if (generation !== this.loadGeneration || this.panel !== panel) {
                return;
            }
            await panel.webview.postMessage({
                command: 'error',
                message: errorMessage(error),
                hasSnapshot: this.lastSuccessfulSnapshot !== null
            });
        } finally {
            this.activeLoads -= 1;
        }
    }

    private async postSnapshotIfChanged(
        snapshot: StepLibrarySnapshot,
        force = false
    ): Promise<void> {
        if (!this.panel) {
            return;
        }
        const identity = `${snapshot.viewIdentity}\0${this.insertionTargetIdentity}`;
        if (!force && identity === this.lastPostedIdentity) {
            return;
        }
        this.lastPostedIdentity = identity;
        await this.panel.webview.postMessage({
            command: 'snapshot',
            snapshot,
            insertionTarget: {
                identity: this.insertionTargetIdentity,
                available: false
            }
        });
    }

    private async handleMessage(message: StepLibraryInboundMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                if (this.lastSuccessfulSnapshot) {
                    await this.postSnapshotIfChanged(this.lastSuccessfulSnapshot, true);
                } else if (this.activeLoads === 0) {
                    await this.refreshSnapshot();
                }
                return;
            case 'refresh':
                try {
                    await this.services.refreshDefinitions(this.resource);
                    await this.refreshSnapshot();
                } catch (error) {
                    await this.panel?.webview.postMessage({
                        command: 'error',
                        message: errorMessage(error),
                        hasSnapshot: this.lastSuccessfulSnapshot !== null
                    });
                }
                return;
            case 'insert':
            case 'copy':
            case 'openDefinition':
                // Task 8 validates the editor target and performs these actions.
                return;
        }
    }

    private getWebviewHtml(webview: vscode.Webview, t: Translator): string {
        const nonce = getNonce();
        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrary.css'));
        const protocolUri = webview.asWebviewUri(
            vscode.Uri.joinPath(mediaUri, 'stepLibraryProtocol.js')
        );
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrary.js'));
        const labels = {
            title: t('KOT Step Library'),
            search: t('Search steps'),
            searchPlaceholder: t('Search templates, descriptions, categories, and parameters'),
            categories: t('Sources and categories'),
            definitions: t('Definitions'),
            details: t('Step details'),
            refresh: t('Refresh step library'),
            allLanguages: t('RU and EN'),
            russian: t('Russian'),
            english: t('English'),
            relevance: t('By relevance'),
            alphabetical: t('Alphabetically'),
            loading: t('Loading step library...'),
            noDefinitions: t('No step definitions are available.'),
            noResults: t('No steps match the current filters.'),
            selectDefinition: t('Select a definition to see its details.'),
            allDefinitions: t('All definitions'),
            source: t('Source'),
            category: t('Category'),
            description: t('Description'),
            parameters: t('Parameters'),
            translation: t('Translation'),
            template: t('Template'),
            insert: t('Insert'),
            copy: t('Copy'),
            openDefinition: t('Open definition'),
            insertionUnavailable: t('Open a supported Feature or scenario text block to insert a step.'),
            builtIn: t('Vanessa built-in steps'),
            user: t('User steps'),
            export: t('Export scenarios'),
            nested: t('Nested scenarios'),
            uncategorized: t('Uncategorized'),
            loadFailed: t('Could not refresh the step library.'),
            showCategories: t('Show sources and categories'),
            back: t('Back')
        };
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>${escapeHtml(labels.title)}</title>
    <link href="${stylesUri}" rel="stylesheet">
</head>
<body
    data-source-built-in="${escapeHtml(labels.builtIn)}"
    data-source-user="${escapeHtml(labels.user)}"
    data-source-export="${escapeHtml(labels.export)}"
    data-source-nested="${escapeHtml(labels.nested)}"
    data-uncategorized="${escapeHtml(labels.uncategorized)}"
    data-no-results="${escapeHtml(labels.noResults)}"
    data-no-definitions="${escapeHtml(labels.noDefinitions)}"
    data-select-definition="${escapeHtml(labels.selectDefinition)}"
    data-all-definitions="${escapeHtml(labels.allDefinitions)}"
    data-source-label="${escapeHtml(labels.source)}"
    data-category-label="${escapeHtml(labels.category)}"
    data-description-label="${escapeHtml(labels.description)}"
    data-parameters-label="${escapeHtml(labels.parameters)}"
    data-translation-label="${escapeHtml(labels.translation)}"
    data-template-label="${escapeHtml(labels.template)}"
    data-insertion-unavailable="${escapeHtml(labels.insertionUnavailable)}"
    data-load-failed="${escapeHtml(labels.loadFailed)}"
>
    <div class="library-shell">
        <header class="library-toolbar">
            <button id="categoryToggle" class="icon-button mobile-only" type="button" aria-label="${escapeHtml(labels.showCategories)}">☰</button>
            <label class="search-field">
                <span class="sr-only">${escapeHtml(labels.search)}</span>
                <input id="searchInput" type="search" autocomplete="off" placeholder="${escapeHtml(labels.searchPlaceholder)}">
            </label>
            <select id="languageFilter" aria-label="${escapeHtml(labels.allLanguages)}">
                <option value="both">${escapeHtml(labels.allLanguages)}</option>
                <option value="ru">${escapeHtml(labels.russian)}</option>
                <option value="en">${escapeHtml(labels.english)}</option>
            </select>
            <select id="sortMode" aria-label="${escapeHtml(labels.relevance)}">
                <option value="relevance">${escapeHtml(labels.relevance)}</option>
                <option value="alphabetical">${escapeHtml(labels.alphabetical)}</option>
            </select>
            <button id="refreshButton" class="icon-button" type="button" title="${escapeHtml(labels.refresh)}" aria-label="${escapeHtml(labels.refresh)}">↻</button>
        </header>
        <main class="library-grid">
            <aside id="categoryPane" class="pane category-pane" aria-label="${escapeHtml(labels.categories)}">
                <div class="pane-heading">
                    <h2>${escapeHtml(labels.categories)}</h2>
                    <button id="categoryBack" class="icon-button mobile-only" type="button" aria-label="${escapeHtml(labels.back)}">←</button>
                </div>
                <div id="categoryTree" class="category-tree" role="tree" tabindex="0"></div>
            </aside>
            <section class="pane definitions-pane" aria-label="${escapeHtml(labels.definitions)}">
                <div class="pane-heading">
                    <h2>${escapeHtml(labels.definitions)}</h2>
                    <span id="resultCount" class="count-badge">0</span>
                </div>
                <div id="statusMessage" class="status-message">${escapeHtml(labels.loading)}</div>
                <div id="definitionList" class="definition-list" role="listbox" tabindex="0" aria-busy="true"></div>
            </section>
            <section id="detailsPane" class="pane details-pane" aria-label="${escapeHtml(labels.details)}">
                <div class="pane-heading">
                    <button id="detailsBack" class="icon-button mobile-only" type="button" aria-label="${escapeHtml(labels.back)}">←</button>
                    <h2>${escapeHtml(labels.details)}</h2>
                </div>
                <div id="detailsContent" class="details-content">
                    <p class="empty-details">${escapeHtml(labels.selectDefinition)}</p>
                </div>
                <div class="details-actions">
                    <button id="insertButton" class="primary-button" type="button" disabled>${escapeHtml(labels.insert)}</button>
                    <button id="copyButton" type="button" disabled>${escapeHtml(labels.copy)}</button>
                    <button id="openDefinitionButton" type="button" disabled>${escapeHtml(labels.openDefinition)}</button>
                </div>
            </section>
        </main>
        <div id="liveRegion" class="sr-only" aria-live="polite"></div>
    </div>
    <script nonce="${nonce}" src="${protocolUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
