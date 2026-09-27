import * as vscode from 'vscode';
import { getTranslator } from './localization';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import {
    buildStepLibrarySnapshot,
    type StepLibraryItem,
    type StepLibrarySnapshot
} from './stepLibraryModel';
import {
    getGherkinInsertionContext,
    type GherkinInsertionContext
} from './gherkinInsertionContext';
import { buildProjectDefinitionInsertion } from './projectDefinitionSnippet';
import { openProjectDefinitionHandler } from './projectDefinitionNavigation';
import type { TestInfo } from './types';

export interface StepLibraryPanelServices {
    readonly extensionUri: vscode.Uri;
    readonly resolver: ProjectDefinitionResolver;
    readonly getScenarios: () => readonly TestInfo[];
    readonly refreshDefinitions: (resource?: vscode.Uri) => Promise<void>;
}

export type StepLibraryInboundMessage =
    | { readonly command: 'ready' }
    | { readonly command: 'refresh' }
    | { readonly command: 'insert'; readonly itemId: string }
    | { readonly command: 'copy'; readonly itemId: string }
    | { readonly command: 'openDefinition'; readonly itemId: string };

interface CapturedInsertionTarget {
    readonly editor: vscode.TextEditor;
    readonly uri: string;
    readonly version: number;
    readonly selections: readonly vscode.Selection[];
    readonly context: GherkinInsertionContext;
    readonly indentation: string;
    readonly identity: string;
}

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
    private insertionTarget: CapturedInsertionTarget | null = null;
    private insertionTargetGeneration = 0;
    private readonly pendingActions = new Set<string>();

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
            if (vscode.window.activeTextEditor) {
                this.updateInsertionTarget(vscode.window.activeTextEditor);
            }
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
        this.pendingActions.clear();
        if (vscode.window.activeTextEditor) {
            this.updateInsertionTarget(vscode.window.activeTextEditor);
        }
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
                this.insertionTarget = null;
                this.insertionTargetGeneration += 1;
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
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    this.updateInsertionTarget(editor);
                }
            }),
            vscode.window.onDidChangeTextEditorSelection(event => {
                this.updateInsertionTarget(event.textEditor);
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (this.insertionTarget?.uri === event.document.uri.toString()) {
                    this.updateInsertionTarget(this.insertionTarget.editor);
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
        this.insertionTarget = null;
        this.insertionTargetGeneration += 1;
        this.pendingActions.clear();
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

    private async refreshSnapshot(force = false): Promise<void> {
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
            const view = await this.services.resolver.ensureReady(this.resource);
            if (generation !== this.loadGeneration || this.panel !== panel) {
                return;
            }
            if (!panel.visible) {
                this.pendingRefreshWhenVisible = true;
                return;
            }
            const snapshot = buildStepLibrarySnapshot(view, this.services.getScenarios());
            this.lastSuccessfulSnapshot = snapshot;
            await this.postSnapshotIfChanged(snapshot, force);
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
                available: this.insertionTarget !== null
            }
        });
    }

    private get insertionTargetIdentity(): string {
        return this.insertionTarget?.identity ?? 'unavailable';
    }

    private cloneSelection(selection: vscode.Selection): vscode.Selection {
        return new vscode.Selection(
            new vscode.Position(selection.anchor.line, selection.anchor.character),
            new vscode.Position(selection.active.line, selection.active.character)
        );
    }

    private positionsEqual(left: vscode.Position, right: vscode.Position): boolean {
        return left.line === right.line && left.character === right.character;
    }

    private orderedSelectionStart(selection: vscode.Selection): vscode.Position {
        const anchorBeforeActive = selection.anchor.line < selection.active.line
            || (
                selection.anchor.line === selection.active.line
                && selection.anchor.character <= selection.active.character
            );
        return anchorBeforeActive ? selection.anchor : selection.active;
    }

    private buildInsertionSelection(
        editor: vscode.TextEditor,
        selection: vscode.Selection,
        context: GherkinInsertionContext
    ): { readonly selection: vscode.Selection; readonly indentation: string } {
        if (!this.positionsEqual(selection.anchor, selection.active)) {
            const start = this.orderedSelectionStart(selection);
            return {
                selection: this.cloneSelection(selection),
                indentation: start.character === 0 ? context.indentation : ''
            };
        }

        const position = selection.active;
        const linePrefix = editor.document.lineAt(position.line).text.slice(0, position.character);
        const actualIndentation = /^\s*/u.exec(linePrefix)?.[0] ?? '';
        if (!linePrefix.trim()) {
            if (actualIndentation !== context.indentation) {
                return {
                    selection: new vscode.Selection(
                        new vscode.Position(position.line, 0),
                        new vscode.Position(position.line, position.character)
                    ),
                    indentation: context.indentation
                };
            }
            return { selection: this.cloneSelection(selection), indentation: '' };
        }

        return {
            selection: new vscode.Selection(
                new vscode.Position(position.line, actualIndentation.length),
                new vscode.Position(position.line, position.character)
            ),
            indentation: ''
        };
    }

    private captureInsertionTarget(editor: vscode.TextEditor): CapturedInsertionTarget | null {
        if (editor.selections.length === 0) {
            return null;
        }
        const contexts: GherkinInsertionContext[] = [];
        const insertionSelections: vscode.Selection[] = [];
        const insertionIndentations: string[] = [];
        for (const selection of editor.selections) {
            const anchorContext = getGherkinInsertionContext(editor.document, selection.anchor);
            const activeContext = selection.anchor.line === selection.active.line
                && selection.anchor.character === selection.active.character
                ? anchorContext
                : getGherkinInsertionContext(editor.document, selection.active);
            if (!anchorContext || !activeContext) {
                return null;
            }
            contexts.push(activeContext);
            const insertion = this.buildInsertionSelection(editor, selection, activeContext);
            insertionSelections.push(insertion.selection);
            insertionIndentations.push(insertion.indentation);
        }
        const context = contexts[0];
        const indentation = insertionIndentations[0];
        const homogeneous = contexts.every((candidate, index) =>
            candidate.language === context.language
            && candidate.typedKeyword === context.typedKeyword
            && candidate.fallbackKeyword === context.fallbackKeyword
            && insertionIndentations[index] === indentation
        );
        if (!homogeneous) {
            return null;
        }
        const uri = editor.document.uri.toString();
        return {
            editor,
            uri,
            version: editor.document.version,
            selections: insertionSelections,
            context,
            indentation,
            identity: `available\0${uri}`
        };
    }

    private updateInsertionTarget(editor: vscode.TextEditor): void {
        const previousIdentity = this.insertionTargetIdentity;
        this.insertionTargetGeneration += 1;
        this.insertionTarget = this.captureInsertionTarget(editor);
        if (
            this.insertionTarget
            && this.resource?.toString() !== editor.document.uri.toString()
        ) {
            this.resource = editor.document.uri;
            if (this.lastSuccessfulSnapshot) {
                this.scheduleRefresh();
            }
        }
        if (previousIdentity !== this.insertionTargetIdentity && this.lastSuccessfulSnapshot) {
            void this.postSnapshotIfChanged(this.lastSuccessfulSnapshot);
        }
    }

    private revalidateInsertionTarget(
        captured: CapturedInsertionTarget | null = this.insertionTarget
    ): CapturedInsertionTarget | null {
        if (
            !captured
            || this.insertionTarget?.editor !== captured.editor
            || captured.editor.document.uri.toString() !== captured.uri
        ) {
            return null;
        }
        const current = this.captureInsertionTarget(captured.editor);
        if (!current) {
            this.insertionTarget = null;
            if (this.lastSuccessfulSnapshot) {
                void this.postSnapshotIfChanged(this.lastSuccessfulSnapshot);
            }
            return null;
        }
        this.insertionTarget = current;
        return current;
    }

    private findItem(itemId: string): StepLibraryItem | undefined {
        return this.lastSuccessfulSnapshot?.items.find(item => item.id === itemId);
    }

    private async postActionResult(
        action: 'insert' | 'copy' | 'openDefinition',
        itemId: string,
        success: boolean
    ): Promise<void> {
        await this.panel?.webview.postMessage({
            command: 'actionResult',
            action,
            itemId,
            success
        });
    }

    private async runItemAction(
        action: 'insert' | 'copy' | 'openDefinition',
        itemId: string,
        operation: (item: StepLibraryItem) => Promise<boolean>
    ): Promise<void> {
        const key = `${action}\0${itemId}`;
        if (this.pendingActions.has(key)) {
            return;
        }
        const item = this.findItem(itemId);
        if (!item) {
            await this.postActionResult(action, itemId, false);
            return;
        }
        this.pendingActions.add(key);
        try {
            await this.postActionResult(action, itemId, await operation(item));
        } catch {
            await this.postActionResult(action, itemId, false);
        } finally {
            this.pendingActions.delete(key);
        }
    }

    private async insertItem(item: StepLibraryItem): Promise<boolean> {
        if (!item.insertable) {
            return false;
        }
        let target = this.revalidateInsertionTarget();
        if (!target) {
            return false;
        }
        const targetGeneration = this.insertionTargetGeneration;
        const view = await this.services.resolver.getView(target.editor.document.uri);
        const definition = view.byId.get(item.definitionId);
        if (!definition) {
            return false;
        }
        if (
            targetGeneration !== this.insertionTargetGeneration
            || this.insertionTarget?.editor !== target.editor
        ) {
            return false;
        }
        target = this.revalidateInsertionTarget(target);
        if (!target) {
            return false;
        }
        const insertion = buildProjectDefinitionInsertion(definition, {
            preferredText: definition.kind === 'exportScenario'
                ? definition.usageExample ?? definition.template
                : definition.template,
            typedKeyword: target.context.typedKeyword,
            fallbackKeyword: target.context.fallbackKeyword,
            indentation: target.indentation,
            language: target.context.language
        });
        return target.editor.insertSnippet(
            new vscode.SnippetString(insertion.snippetText),
            [...target.selections]
        );
    }

    private async copyItem(item: StepLibraryItem): Promise<boolean> {
        await vscode.env.clipboard.writeText(item.displayText);
        return true;
    }

    private async openItem(item: StepLibraryItem): Promise<boolean> {
        if (item.kind === 'builtInStep' || !item.navigable || !item.capturedLocation) {
            return false;
        }
        return openProjectDefinitionHandler(
            item.definitionId,
            this.resource,
            this.services.resolver,
            item.capturedLocation
        );
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
                    await this.refreshSnapshot(true);
                } catch (error) {
                    await this.panel?.webview.postMessage({
                        command: 'error',
                        message: errorMessage(error),
                        hasSnapshot: this.lastSuccessfulSnapshot !== null
                    });
                }
                return;
            case 'insert':
                await this.runItemAction('insert', message.itemId, item => this.insertItem(item));
                return;
            case 'copy':
                await this.runItemAction('copy', message.itemId, item => this.copyItem(item));
                return;
            case 'openDefinition':
                await this.runItemAction(
                    'openDefinition',
                    message.itemId,
                    item => this.openItem(item)
                );
                return;
        }
    }

    private getWebviewHtml(webview: vscode.Webview, t: Translator): string {
        const nonce = getNonce();
        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'codicon.css'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrary.css'));
        const protocolUri = webview.asWebviewUri(
            vscode.Uri.joinPath(mediaUri, 'stepLibraryProtocol.js')
        );
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrary.js'));
        const labels = {
            title: t('KOT Step Library'),
            search: t('Search steps'),
            searchPlaceholder: t('Search templates, descriptions, codes, categories, and parameters'),
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
            scenarioCode: t('Scenario code'),
            description: t('Description'),
            parameters: t('Parameters'),
            translation: t('Translation'),
            template: t('Template'),
            insert: t('Insert'),
            copy: t('Copy'),
            openDefinition: t('Open definition'),
            insertionUnavailable: t('Open a supported Feature or scenario text block to insert a step.'),
            itemNotInsertable: t('Main scenarios cannot be inserted.'),
            inserted: t('Step inserted.'),
            copied: t('Step copied.'),
            opened: t('Definition opened.'),
            actionFailed: t('The action could not be completed.'),
            builtIn: t('Vanessa built-in steps'),
            user: t('User steps'),
            export: t('Export scenarios'),
            nested: t('Nested scenarios'),
            main: t('Main scenarios'),
            uncategorized: t('Uncategorized'),
            loadFailed: t('Could not refresh the step library.'),
            showCategories: t('Show sources and categories'),
            back: t('Back')
        };
        const documentLanguage = (vscode.env.language || 'en').toLocaleLowerCase().startsWith('ru')
            ? 'ru'
            : 'en';
        return `<!DOCTYPE html>
<html lang="${documentLanguage}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>${escapeHtml(labels.title)}</title>
    <link href="${codiconsUri}" rel="stylesheet">
    <link href="${stylesUri}" rel="stylesheet">
</head>
<body
    data-source-built-in="${escapeHtml(labels.builtIn)}"
    data-source-user="${escapeHtml(labels.user)}"
    data-source-export="${escapeHtml(labels.export)}"
    data-source-nested="${escapeHtml(labels.nested)}"
    data-source-main="${escapeHtml(labels.main)}"
    data-uncategorized="${escapeHtml(labels.uncategorized)}"
    data-no-results="${escapeHtml(labels.noResults)}"
    data-no-definitions="${escapeHtml(labels.noDefinitions)}"
    data-select-definition="${escapeHtml(labels.selectDefinition)}"
    data-all-definitions="${escapeHtml(labels.allDefinitions)}"
    data-source-label="${escapeHtml(labels.source)}"
    data-category-label="${escapeHtml(labels.category)}"
    data-scenario-code-label="${escapeHtml(labels.scenarioCode)}"
    data-description-label="${escapeHtml(labels.description)}"
    data-parameters-label="${escapeHtml(labels.parameters)}"
    data-translation-label="${escapeHtml(labels.translation)}"
    data-template-label="${escapeHtml(labels.template)}"
    data-insertion-unavailable="${escapeHtml(labels.insertionUnavailable)}"
    data-item-not-insertable="${escapeHtml(labels.itemNotInsertable)}"
    data-inserted="${escapeHtml(labels.inserted)}"
    data-copied="${escapeHtml(labels.copied)}"
    data-opened="${escapeHtml(labels.opened)}"
    data-action-failed="${escapeHtml(labels.actionFailed)}"
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
