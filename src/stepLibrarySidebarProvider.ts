import * as vscode from 'vscode';
import type { ScenarioRelationshipService, ScenarioRelationshipState } from './scenarioRelationshipService';
import type { StepLibraryActionService, StepLibraryInsertionTargetState } from './stepLibraryActions';
import type { StepLibrarySnapshot } from './stepLibraryModel';
import {
    StepLibrarySidebarIndex,
    type StepLibrarySidebarNode
} from './stepLibrarySidebarModel';
import type { StepLibrarySnapshotService } from './stepLibrarySnapshotService';

export interface StepLibrarySidebarServices {
    readonly extensionUri: vscode.Uri;
    readonly snapshotService: StepLibrarySnapshotService;
    readonly actionService: StepLibraryActionService;
    readonly relationshipService: Pick<ScenarioRelationshipService, 'getState' | 'onDidChangeState'>;
    readonly refreshDefinitions: (resource?: vscode.Uri) => Promise<void>;
}

export type StepLibrarySidebarMessage =
    | { readonly command: 'ready' }
    | { readonly command: 'expand'; readonly nodeId: string; readonly offset: number }
    | { readonly command: 'search'; readonly query: string }
    | { readonly command: 'insert'; readonly itemId: string }
    | { readonly command: 'openDefinition'; readonly itemId: string }
    | { readonly command: 'refresh' }
    | { readonly command: 'openFullLibrary' };

function getNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let index = 0; index < 32; index += 1) {
        result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return result;
}

function errorMessage(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return error.message;
    }
    return String(error);
}

function cleanId(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 2_048 ? trimmed : null;
}

export function parseStepLibrarySidebarMessage(value: unknown): StepLibrarySidebarMessage | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (
        record.command === 'ready'
        || record.command === 'refresh'
        || record.command === 'openFullLibrary'
    ) {
        return { command: record.command };
    }
    if (record.command === 'expand') {
        const nodeId = cleanId(record.nodeId);
        const offset = record.offset;
        return nodeId && Number.isInteger(offset) && (offset as number) >= 0
            ? { command: 'expand', nodeId, offset: offset as number }
            : null;
    }
    if (record.command === 'search') {
        if (typeof record.query !== 'string' || record.query.length > 500) {
            return null;
        }
        return { command: 'search', query: record.query };
    }
    if (record.command === 'insert' || record.command === 'openDefinition') {
        const itemId = cleanId(record.itemId);
        return itemId ? { command: record.command, itemId } : null;
    }
    return null;
}

function sameResource(left: vscode.Uri | undefined, right: vscode.Uri | undefined): boolean {
    return (left?.toString() ?? null) === (right?.toString() ?? null);
}

export class StepLibrarySidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'kotTestToolkit.stepLibraryView';

    private readonly disposables: vscode.Disposable[] = [];
    private viewDisposables: vscode.Disposable[] = [];
    private view: vscode.WebviewView | null = null;
    private resource: vscode.Uri | undefined;
    private index: StepLibrarySidebarIndex | null = null;
    private snapshot: StepLibrarySnapshot | null = null;
    private ready = false;
    private pendingReload = false;
    private refreshInProgress = false;
    private loadGeneration = 0;
    private revision = 0;
    private readonly pendingActions = new Set<string>();

    constructor(private readonly services: StepLibrarySidebarServices) {
        this.resource = services.actionService.getInsertionTargetState().resource;
        this.disposables.push(
            services.snapshotService.onDidInvalidate(() => this.handleInvalidation()),
            services.actionService.onDidChangeInsertionTarget(target => {
                this.handleInsertionTargetChanged(target);
            }),
            services.relationshipService.onDidChangeState(state => {
                void this.postRelationshipState(state);
            })
        );
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context?: vscode.WebviewViewResolveContext,
        _token?: vscode.CancellationToken
    ): void {
        this.disposeViewSubscriptions();
        this.view = webviewView;
        this.ready = false;
        this.pendingReload = false;
        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [mediaUri]
        };
        webviewView.webview.html = this.getWebviewHtml(webviewView.webview);
        this.viewDisposables = [
            webviewView.webview.onDidReceiveMessage(rawMessage => {
                const message = parseStepLibrarySidebarMessage(rawMessage);
                if (message) {
                    void this.handleMessage(message);
                }
            }),
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible && this.ready && (this.pendingReload || !this.index)) {
                    this.pendingReload = false;
                    void this.loadIndex();
                }
            })
        ];
    }

    public dispose(): void {
        this.loadGeneration += 1;
        this.disposeViewSubscriptions();
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        this.view = null;
        this.index = null;
        this.snapshot = null;
        this.pendingActions.clear();
    }

    private disposeViewSubscriptions(): void {
        for (const disposable of this.viewDisposables.splice(0)) {
            disposable.dispose();
        }
    }

    private handleInvalidation(): void {
        this.loadGeneration += 1;
        this.index = null;
        this.snapshot = null;
        if (this.refreshInProgress || !this.ready || !this.view?.visible) {
            this.pendingReload = true;
            return;
        }
        void this.loadIndex();
    }

    private handleInsertionTargetChanged(target: StepLibraryInsertionTargetState): void {
        const resourceChanged = Boolean(target.resource) && !sameResource(this.resource, target.resource);
        if (target.resource) {
            this.resource = target.resource;
        }
        void this.view?.webview.postMessage({
            command: 'insertionTarget',
            identity: target.identity,
            available: target.available
        });
        if (!resourceChanged) {
            return;
        }
        this.loadGeneration += 1;
        this.index = null;
        this.snapshot = null;
        if (this.ready && this.view?.visible) {
            void this.loadIndex();
        } else {
            this.pendingReload = true;
        }
    }

    private async handleMessage(message: StepLibrarySidebarMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                this.ready = true;
                if (!this.view?.visible) {
                    this.pendingReload = true;
                    return;
                }
                if (this.index && this.snapshot) {
                    await this.postRoots(this.snapshot, this.index);
                } else {
                    await this.loadIndex();
                }
                return;
            case 'expand':
                if (!this.index || !this.view) {
                    return;
                }
                await this.view.webview.postMessage({
                    command: 'children',
                    offset: message.offset,
                    ...this.index.children(message.nodeId, message.offset, 100)
                });
                return;
            case 'search':
                if (!this.index || !this.view) {
                    return;
                }
                await this.view.webview.postMessage({
                    command: 'searchResults',
                    query: message.query,
                    nodes: this.index.search(message.query, 100)
                });
                return;
            case 'insert':
                await this.runItemAction(message.itemId, 'insert');
                return;
            case 'openDefinition':
                await this.runItemAction(message.itemId, 'openDefinition');
                return;
            case 'refresh':
                await this.refresh();
                return;
            case 'openFullLibrary':
                await vscode.commands.executeCommand('kotTestToolkit.openStepLibrary');
                return;
        }
    }

    private async runItemAction(itemId: string, action: 'insert' | 'openDefinition'): Promise<void> {
        const item = this.index?.getItem(itemId);
        const actionKey = `${action}\0${itemId}`;
        if (!item || this.pendingActions.has(actionKey)) {
            return;
        }
        this.pendingActions.add(actionKey);
        try {
            const succeeded = action === 'insert'
                ? await this.services.actionService.insert(item, this.resource)
                : await this.services.actionService.openDefinition(item, this.resource);
            await this.view?.webview.postMessage({
                command: 'actionResult',
                action,
                itemId,
                succeeded
            });
        } catch (error) {
            await this.postError(error);
        } finally {
            this.pendingActions.delete(actionKey);
        }
    }

    private async refresh(): Promise<void> {
        if (this.refreshInProgress) {
            return;
        }
        this.refreshInProgress = true;
        try {
            await this.services.refreshDefinitions(this.resource);
            this.services.snapshotService.invalidate();
        } catch (error) {
            await this.postError(error);
            return;
        } finally {
            this.refreshInProgress = false;
        }
        this.pendingReload = false;
        this.index = null;
        this.snapshot = null;
        await this.loadIndex();
    }

    private async loadIndex(): Promise<void> {
        const view = this.view;
        if (!view || !this.ready) {
            return;
        }
        if (!view.visible) {
            this.pendingReload = true;
            return;
        }
        const generation = ++this.loadGeneration;
        await view.webview.postMessage({ command: 'loading' });
        try {
            const snapshot = await this.services.snapshotService.ensureReady(this.resource);
            if (generation !== this.loadGeneration || this.view !== view || !view.visible) {
                return;
            }
            const preferredLanguage = vscode.env.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
            const index = StepLibrarySidebarIndex.fromSnapshot(snapshot, preferredLanguage);
            this.snapshot = snapshot;
            this.index = index;
            this.pendingReload = false;
            this.revision += 1;
            await this.postRoots(snapshot, index);
        } catch (error) {
            if (generation === this.loadGeneration && this.view === view) {
                await this.postError(error);
            }
        }
    }

    private async postRoots(snapshot: StepLibrarySnapshot, index: StepLibrarySidebarIndex): Promise<void> {
        const view = this.view;
        if (!view) {
            return;
        }
        const target = this.services.actionService.getInsertionTargetState();
        const relationship = this.relationshipPayload(this.services.relationshipService.getState());
        await view.webview.postMessage({
            command: 'roots',
            revision: this.revision,
            identity: snapshot.viewIdentity,
            nodes: index.roots(),
            insertionTarget: {
                identity: target.identity,
                available: target.available
            },
            ...relationship
        });
    }

    private relationshipPayload(state: ScenarioRelationshipState): {
        readonly relationshipState: ScenarioRelationshipState;
        readonly relatedAncestorIds: readonly string[];
    } {
        const index = this.index;
        const snapshot = this.snapshot;
        if (!index || !snapshot) {
            return { relationshipState: state, relatedAncestorIds: Object.freeze([]) };
        }
        const relatedKeys = new Set(state.currentScenarioKeys);
        if (state.enabled) {
            for (const entry of state.relationships) {
                relatedKeys.add(entry.scenarioKey);
            }
            for (const key of state.affectedMainScenarioKeys) {
                relatedKeys.add(key);
            }
        }
        const ancestorIds = new Set<string>();
        for (const item of snapshot.items) {
            if (!item.capturedLocation || !relatedKeys.has(item.capturedLocation.uri)) {
                continue;
            }
            for (const ancestorId of index.ancestorIds(item.id)) {
                ancestorIds.add(ancestorId);
            }
        }
        return {
            relationshipState: state,
            relatedAncestorIds: Object.freeze([...ancestorIds].sort())
        };
    }

    private async postRelationshipState(state: ScenarioRelationshipState): Promise<void> {
        if (!this.ready || !this.view) {
            return;
        }
        await this.view.webview.postMessage({
            command: 'relationshipState',
            ...this.relationshipPayload(state)
        });
    }

    private async postError(error: unknown): Promise<void> {
        await this.view?.webview.postMessage({
            command: 'error',
            message: errorMessage(error)
        });
    }

    private getWebviewHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        const sharedStylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'kotSidebar.css'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrarySidebar.css'));
        const codiconStylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'codicon.css'));
        const protocolUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrarySidebarProtocol.js'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrarySidebar.js'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link href="${codiconStylesUri}" rel="stylesheet">
    <link href="${sharedStylesUri}" rel="stylesheet">
    <link href="${stylesUri}" rel="stylesheet">
    <title>Step Library</title>
</head>
<body>
    <main class="step-sidebar">
        <div class="step-toolbar">
            <div class="step-search-wrap">
                <span class="codicon codicon-search" aria-hidden="true"></span>
                <input id="searchInput" type="search" aria-label="Search steps" placeholder="Search steps">
            </div>
            <button id="refreshButton" class="kot-icon-button" type="button" aria-label="Refresh step library" title="Refresh step library"><span class="codicon codicon-refresh" aria-hidden="true"></span></button>
            <button id="openFullButton" class="kot-icon-button" type="button" aria-label="Open full Step Library" title="Open full Step Library"><span class="codicon codicon-open-preview" aria-hidden="true"></span></button>
        </div>
        <div id="status" class="step-status" role="status" aria-live="polite"></div>
        <div id="tree" class="kot-tree step-tree" role="tree" aria-label="Steps"></div>
    </main>
    <script nonce="${nonce}" src="${protocolUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
