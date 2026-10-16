import * as vscode from 'vscode';
import type { ScenarioRelationshipService, ScenarioRelationshipState } from './scenarioRelationshipService';
import type { ScenarioRelationshipPresentationService } from './scenarioRelationshipPresentation';
import type { StepLibraryActionService, StepLibraryInsertionTargetState } from './stepLibraryActions';
import type { StepLibrarySnapshot } from './stepLibraryModel';
import {
    StepLibrarySidebarIndex,
    type StepLibrarySidebarNode
} from './stepLibrarySidebarModel';
import type { StepLibrarySnapshotService } from './stepLibrarySnapshotService';
import type { StepLibraryFavoritesService } from './stepLibraryFavorites';
import type { ScenarioFilesService } from './scenarioFilesService';
import {
    parseScenarioFilesMessage, scenarioFilesItemForResource, scopeScenarioFileNodes, type ScenarioFileResource,
    type ScenarioFilesMessage
} from './scenarioFilesWebviewProtocol';
import {
    StandaloneFeatureController, getStandaloneFeatureLabels, parseStandaloneFeatureMessage,
    type StandaloneFeatureCatalog, type StandaloneFeatureMessage, type StandaloneFeatureControllerOptions
} from './standaloneFeatureController';

export interface StepLibrarySidebarServices {
    readonly extensionUri: vscode.Uri;
    readonly snapshotService: StepLibrarySnapshotService;
    readonly actionService: StepLibraryActionService;
    readonly relationshipService: Pick<ScenarioRelationshipService, 'getState' | 'onDidChangeState'>;
    readonly relationshipPresentation: Pick<ScenarioRelationshipPresentationService, 'getMode' | 'onDidChangeMode'>;
    readonly favoritesService?: Pick<StepLibraryFavoritesService, 'favoriteItemIds' | 'toggle' | 'onDidChange'>;
    readonly scenarioFilesService: Pick<ScenarioFilesService,
        | 'listChildren'
        | 'openCompiledFeature'
        | 'openExternal'
        | 'revealInOs'
        | 'deleteFile'
        | 'renameFile'
        | 'watch'
        | 'prepareDrop'
        | 'appendTransferChunk'
        | 'completeTransfer'
        | 'cancelTransfer'>;
    readonly refreshDefinitions: (resource?: vscode.Uri) => Promise<void>;
    readonly context?: vscode.ExtensionContext;
    readonly standaloneFeatureService?: StandaloneFeatureCatalog;
    readonly prepareStandaloneFeatures?: () => Promise<void>;
    readonly standaloneFeatureControllerOptions?: StandaloneFeatureControllerOptions;
}

export type StepLibrarySidebarMessage =
    | { readonly command: 'ready' }
    | { readonly command: 'expand'; readonly nodeId: string; readonly offset: number }
    | { readonly command: 'search'; readonly query: string }
    | { readonly command: 'insert'; readonly itemId: string }
    | { readonly command: 'copy'; readonly itemId: string }
    | { readonly command: 'openDefinition' | 'openScenarioProperties'; readonly itemId: string }
    | { readonly command: 'rename'; readonly itemId: string }
    | { readonly command: 'renameMainGroup'; readonly itemId: string }
    | { readonly command: 'deleteDefinition'; readonly itemId: string }
    | { readonly command: 'toggleFavorite'; readonly itemId: string }
    | { readonly command: 'refresh' }
    | { readonly command: 'openFullLibrary' }
    | ScenarioFilesMessage
    | StandaloneFeatureMessage;

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

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/"/gu, '&quot;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;');
}

function translate(message: string, ...args: string[]): string {
    if (typeof vscode.l10n?.t === 'function') {
        return vscode.l10n.t(message, ...args);
    }
    return message.replace(/\{(\d+)\}/gu, (placeholder, index) => args[Number(index)] ?? placeholder);
}

function cleanId(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 2_048 ? trimmed : null;
}

export function parseStepLibrarySidebarMessage(value: unknown): StepLibrarySidebarMessage | null {
    const standaloneMessage = parseStandaloneFeatureMessage(value);
    if (standaloneMessage) {
        return standaloneMessage;
    }
    const scenarioFilesMessage = parseScenarioFilesMessage(value);
    if (scenarioFilesMessage) {
        return scenarioFilesMessage;
    }
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
    if (
        record.command === 'insert'
        || record.command === 'copy'
        || record.command === 'openDefinition'
        || record.command === 'openScenarioProperties'
        || record.command === 'rename'
        || record.command === 'renameMainGroup'
        || record.command === 'deleteDefinition'
        || record.command === 'toggleFavorite'
    ) {
        const itemId = cleanId(record.itemId);
        return itemId ? { command: record.command, itemId } : null;
    }
    return null;
}

function sameResource(left: vscode.Uri | undefined, right: vscode.Uri | undefined): boolean {
    return (left?.toString() ?? null) === (right?.toString() ?? null);
}

export class StepLibrarySidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'kotTestToolkit.stepLibrarySidebarView';

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
    private standaloneController: StandaloneFeatureController | undefined;
    private readonly scenarioFileWatches = new Map<string, { dispose(): void }>();
    private readonly scenarioFileTransfers = new Map<string, {
        readonly itemId: string;
        readonly targetRelativePath: string;
    }>();

    constructor(private readonly services: StepLibrarySidebarServices) {
        this.resource = services.actionService.getInsertionTargetState().resource;
        this.disposables.push(
            services.snapshotService.onDidInvalidate(() => this.handleInvalidation()),
            services.actionService.onDidChangeInsertionTarget(target => {
                this.handleInsertionTargetChanged(target);
            }),
            services.relationshipService.onDidChangeState(state => {
                void this.postRelationshipState(state);
            }),
            services.relationshipPresentation.onDidChangeMode(event => {
                if (event.surface === 'stepLibrary') {
                    void this.postRelationshipState(services.relationshipService.getState());
                }
            }),
            services.favoritesService?.onDidChange(() => this.handleFavoritesChanged()) ?? { dispose: () => undefined }
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
        if (this.services.context && this.services.standaloneFeatureService) {
            this.standaloneController = new StandaloneFeatureController(
                this.services.context, this.services.standaloneFeatureService, webviewView.webview,
                this.services.standaloneFeatureControllerOptions
            );
            this.standaloneController.setVisible(webviewView.visible);
        }
        this.viewDisposables = [
            webviewView.webview.onDidReceiveMessage(rawMessage => {
                const message = parseStepLibrarySidebarMessage(rawMessage);
                if (message) {
                    void this.handleMessage(message);
                }
            }),
            webviewView.onDidChangeVisibility(() => {
                this.standaloneController?.setVisible(webviewView.visible);
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

    public toggleAllGroupsFromSidebar(): void {
        void this.view?.webview.postMessage({ command: 'toggleAllGroups' });
    }

    private disposeViewSubscriptions(): void {
        this.standaloneController?.dispose();
        this.standaloneController = undefined;
        this.disposeScenarioFileState();
        for (const disposable of this.viewDisposables.splice(0)) {
            disposable.dispose();
        }
    }

    private handleInvalidation(): void {
        this.loadGeneration += 1;
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
                try {
                    await this.services.prepareStandaloneFeatures?.();
                } catch (error) {
                    await this.postError(error);
                }
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
                const relationship = this.relationshipPayload(
                    this.services.relationshipService.getState()
                );
                const visibleItemIds = relationship.relationshipFilterEnabled
                    ? new Set(relationship.relatedItemIds)
                    : undefined;
                const page = this.index.children(message.nodeId, message.offset, 100, visibleItemIds);
                await this.view.webview.postMessage({
                    command: 'children',
                    offset: message.offset,
                    ...page,
                    nodes: page.nodes.map(node => this.localizeNode(node))
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
            case 'copy':
                await this.runItemAction(message.itemId, 'copy');
                return;
            case 'openScenarioProperties':
                await this.runItemAction(message.itemId, 'openScenarioProperties');
                return;
            case 'openDefinition':
                await this.runItemAction(message.itemId, 'openDefinition');
                return;
            case 'rename':
                await this.runItemAction(message.itemId, 'rename');
                return;
            case 'renameMainGroup':
                await this.runItemAction(message.itemId, 'renameMainGroup');
                return;
            case 'deleteDefinition':
                await this.runItemAction(message.itemId, 'deleteDefinition');
                return;
            case 'toggleFavorite':
                await this.toggleFavorite(message.itemId);
                return;
            case 'refresh':
                await this.refresh();
                return;
            case 'openFullLibrary':
                await vscode.commands.executeCommand('kotTestToolkit.openStepLibrary');
                return;
            case 'standaloneFeatureAction':
                await this.standaloneController?.handleMessage(message);
                return;
            case 'listScenarioFiles':
                await this.listScenarioFiles(message);
                return;
            case 'setScenarioFilesExpanded':
                this.setScenarioFilesExpanded(message.itemId, message.expanded);
                return;
            case 'openScenarioFile':
                await this.runScenarioFileAction(message.itemId, message.relativePath, 'open', message.resource);
                return;
            case 'openCompiledScenarioFeature':
                await this.openCompiledScenarioFeature(message.itemId);
                return;
            case 'revealScenarioFile':
                await this.runScenarioFileAction(message.itemId, message.relativePath, 'reveal', message.resource);
                return;
            case 'renameScenarioFile':
            case 'deleteScenarioFile':
                await this.deleteScenarioFile(message);
                return;
            case 'prepareScenarioFileDrop':
                await this.prepareScenarioFileDrop(message);
                return;
            case 'appendScenarioFileChunk':
                await this.appendScenarioFileChunk(message.transferId, message.offset, message.base64);
                return;
            case 'completeScenarioFileTransfer':
                await this.completeScenarioFileTransfer(message.transferId);
                return;
            case 'cancelScenarioFileTransfer':
                await this.cancelScenarioFileTransfer(message.transferId);
                return;
        }
    }

    private handleFavoritesChanged(): void {
        if (!this.snapshot || !this.ready || !this.view?.visible) {
            this.pendingReload = true;
            return;
        }
        const preferredLanguage = vscode.env.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
        this.index = StepLibrarySidebarIndex.fromSnapshot(
            this.snapshot,
            preferredLanguage,
            this.services.favoritesService?.favoriteItemIds(this.snapshot) ?? new Set<string>()
        );
        this.revision += 1;
        void this.postRoots(this.snapshot, this.index);
    }

    private async toggleFavorite(itemId: string): Promise<void> {
        const item = this.index?.getItem(itemId);
        const favoritesService = this.services.favoritesService;
        const actionKey = `toggleFavorite\0${itemId}`;
        if (!item || !favoritesService || this.pendingActions.has(actionKey)) {
            return;
        }
        this.pendingActions.add(actionKey);
        try {
            const favorite = await favoritesService.toggle(item);
            await this.view?.webview.postMessage({
                command: 'actionResult',
                action: 'toggleFavorite',
                itemId,
                succeeded: true,
                favorite
            });
        } catch (error) {
            await this.postError(error);
        } finally {
            this.pendingActions.delete(actionKey);
        }
    }

    private async runItemAction(itemId: string, action: 'insert' | 'copy' | 'openDefinition' | 'openScenarioProperties' | 'rename' | 'renameMainGroup' | 'deleteDefinition'): Promise<void> {
        const item = this.index?.getItem(itemId);
        const actionKey = `${action}\0${itemId}`;
        if (!item || this.pendingActions.has(actionKey)) {
            return;
        }
        this.pendingActions.add(actionKey);
        try {
            const succeeded = action === 'insert'
                ? await this.services.actionService.insert(item, this.resource)
                : action === 'copy'
                    ? await this.services.actionService.copy(item)
                    : action === 'openScenarioProperties'
                        ? await this.services.actionService.openScenarioProperties(item, this.resource,
                            async uri => { await vscode.commands.executeCommand('kotTestToolkit.openScenarioEditor', vscode.Uri.parse(uri)); })
                    : action === 'rename'
                        ? await this.services.actionService.rename(item, this.resource)
                    : action === 'renameMainGroup'
                        ? await this.services.actionService.renameMainGroup(item)
                    : action === 'deleteDefinition'
                        ? await this.services.actionService.delete(item, this.resource)
                    : item.featureId && this.standaloneController
                        ? await this.standaloneController.handleMessage({ command: 'standaloneFeatureAction', action: 'openFeature', featureId: item.featureId })
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

    public async refresh(): Promise<void> {
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
        try {
            await this.services.standaloneFeatureService?.refresh();
        } catch (error) {
            await this.postError(error);
        }
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
        await view.webview.postMessage({
            command: 'loading',
            retainItems: this.index !== null && this.snapshot !== null
        });
        try {
            const snapshot = await this.services.snapshotService.ensureReady(this.resource);
            if (generation !== this.loadGeneration || this.view !== view || !view.visible) {
                return;
            }
            const preferredLanguage = vscode.env.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
            const index = StepLibrarySidebarIndex.fromSnapshot(
                snapshot,
                preferredLanguage,
                this.services.favoritesService?.favoriteItemIds(snapshot) ?? new Set<string>()
            );
            this.disposeScenarioFileWatches();
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
        const favoriteItemIds = [
            ...(this.services.favoritesService?.favoriteItemIds(snapshot) ?? new Set<string>())
        ].sort();
        await view.webview.postMessage({
            command: 'roots',
            revision: this.revision,
            identity: snapshot.viewIdentity,
            favoriteItemIds,
            nodes: index.roots().map(node => this.localizeNode(node)),
            standaloneItems: snapshot.items.filter(item => item.featureId),
            insertionTarget: {
                identity: target.identity,
                available: target.available
            },
            ...relationship
        });
    }

    private localizeNode(node: StepLibrarySidebarNode): StepLibrarySidebarNode {
        if (node.kind === 'source') {
            return { ...node, label: translate(node.label) };
        }
        if (node.sourceGroup === 'standalone' && node.kind === 'category' && node.groupId === '') {
            return { ...node, label: translate('Ungrouped') };
        }
        return node;
    }

    private relationshipPayload(state: ScenarioRelationshipState): {
        readonly relationshipState: ScenarioRelationshipState;
        readonly relationshipFilterEnabled: boolean;
        readonly relatedAncestorIds: readonly string[];
        readonly relatedItemIds: readonly string[];
        readonly relationshipVisibleCounts: Readonly<Record<string, number>>;
    } {
        const mode = this.services.relationshipPresentation.getMode('stepLibrary');
        const relationshipState = Object.freeze({ ...state, enabled: mode.highlight });
        const index = this.index;
        const snapshot = this.snapshot;
        if (!index || !snapshot) {
            return {
                relationshipState,
                relationshipFilterEnabled: mode.filter,
                relatedAncestorIds: Object.freeze([]),
                relatedItemIds: Object.freeze([]),
                relationshipVisibleCounts: Object.freeze({})
            };
        }
        const relatedKeys = new Set(state.currentScenarioKeys);
        for (const entry of state.relationships) {
            relatedKeys.add(entry.scenarioKey);
        }
        for (const key of state.affectedMainScenarioKeys) {
            relatedKeys.add(key);
        }
        const relatedDefinitionIds = new Set(state.currentDefinitionIds ?? []);
        for (const entry of state.definitionRelationships ?? []) {
            relatedDefinitionIds.add(entry.definitionId);
        }
        const ancestorIds = new Set<string>();
        const itemIds = new Set<string>();
        for (const item of snapshot.items) {
            const isRelated = Boolean(item.scenarioKey && relatedKeys.has(item.scenarioKey))
                || relatedDefinitionIds.has(item.definitionId);
            if (!isRelated) {
                continue;
            }
            itemIds.add(item.id);
            for (const ancestorId of index.ancestorIds(item.id)) {
                ancestorIds.add(ancestorId);
            }
        }
        return {
            relationshipState,
            relationshipFilterEnabled: mode.filter,
            relatedAncestorIds: Object.freeze([...ancestorIds].sort()),
            relatedItemIds: Object.freeze([...itemIds].sort()),
            relationshipVisibleCounts: index.countsForItems(itemIds)
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

    private async listScenarioFiles(
        message: Extract<ScenarioFilesMessage, { command: 'listScenarioFiles' }>
    ): Promise<void> {
        const item = scenarioFilesItemForResource(this.index?.getItem(message.itemId), message.resource);
        if (!item) {
            await this.postScenarioFileFailure(
                undefined,
                new Error('Unknown scenario file item.'),
                message.requestId
            );
            return;
        }
        try {
            const nodes = await this.services.scenarioFilesService.listChildren(
                item,
                message.relativePath
            );
            await this.view?.webview.postMessage({
                command: 'scenarioFileChildren',
                requestId: message.requestId,
                itemId: item.id,
                relativePath: message.relativePath,
                nodes: scopeScenarioFileNodes(nodes, message.resource)
            });
        } catch (error) {
            await this.postScenarioFileFailure(undefined, error, message.requestId);
        }
    }

    private setScenarioFilesExpanded(itemId: string, expanded: boolean): void {
        this.scenarioFileWatches.get(itemId)?.dispose();
        this.scenarioFileWatches.delete(itemId);
        if (!expanded) {
            return;
        }
        const item = this.index?.getItem(itemId);
        if (!item) {
            return;
        }
        try {
            const watch = this.services.scenarioFilesService.watch(item, event => {
                void this.view?.webview.postMessage({
                    command: 'scenarioFileInvalidated',
                    itemId: event.itemId
                });
            });
            this.scenarioFileWatches.set(itemId, watch);
        } catch (error) {
            void this.postScenarioFileFailure(undefined, error);
        }
    }

    private async runScenarioFileAction(
        itemId: string,
        relativePath: string,
        action: 'open' | 'reveal',
        resource?: ScenarioFileResource
    ): Promise<void> {
        const item = scenarioFilesItemForResource(this.index?.getItem(itemId), resource);
        if (!item) {
            return;
        }
        const succeeded = action === 'open'
            ? await this.services.scenarioFilesService.openExternal(item, relativePath)
            : await this.services.scenarioFilesService.revealInOs(item, relativePath);
        await this.view?.webview.postMessage({
            command: 'scenarioFileActionResult',
            action,
            itemId,
            relativePath,
            succeeded
        });
    }

    private async openCompiledScenarioFeature(itemId: string): Promise<void> {
        const item = this.index?.getItem(itemId);
        if (!item) {
            return;
        }
        const succeeded = await this.services.scenarioFilesService.openCompiledFeature(item);
        await this.view?.webview.postMessage({
            command: 'scenarioFileActionResult',
            action: 'openFeature',
            itemId,
            succeeded
        });
    }

    private async deleteScenarioFile(
        message: Extract<ScenarioFilesMessage, { command: 'deleteScenarioFile' | 'renameScenarioFile' }>
    ): Promise<void> {
        const item = scenarioFilesItemForResource(this.index?.getItem(message.itemId), message.resource);
        if (!item) {
            await this.postScenarioFileFailure(
                undefined,
                new Error('Unknown scenario file item.')
            );
            return;
        }
        try {
            const result = await this.services.scenarioFilesService[message.command === 'renameScenarioFile' ? 'renameFile' : 'deleteFile'](item, message.relativePath);
            await this.view?.webview.postMessage({
                command: 'scenarioFileActionResult',
                action: message.command === 'renameScenarioFile' ? 'rename' : 'delete',
                itemId: item.id,
                relativePath: message.relativePath,
                succeeded: result !== 'cancelled',
                ...(result === 'cancelled' ? { cancelled: true } : {})
            });
        } catch (error) {
            await this.postScenarioFileFailure(undefined, error);
        }
    }

    private async prepareScenarioFileDrop(
        message: Extract<ScenarioFilesMessage, { command: 'prepareScenarioFileDrop' }>
    ): Promise<void> {
        const item = scenarioFilesItemForResource(this.index?.getItem(message.itemId), message.resource);
        if (!item) {
            await this.postScenarioFileFailure(
                undefined,
                new Error('Unknown scenario file item.'),
                undefined,
                message.dropId
            );
            return;
        }
        try {
            const plan = await this.services.scenarioFilesService.prepareDrop(
                item,
                message.targetRelativePath,
                message.entries
            );
            for (const file of plan.files) {
                this.scenarioFileTransfers.set(file.transferId, {
                    itemId: item.id,
                    targetRelativePath: message.targetRelativePath
                });
            }
            await this.view?.webview.postMessage({
                command: 'scenarioFileDropPrepared',
                dropId: message.dropId,
                itemId: item.id,
                files: plan.files,
                skipped: plan.skipped
            });
        } catch (error) {
            await this.postScenarioFileFailure(undefined, error, undefined, message.dropId);
        }
    }

    private async appendScenarioFileChunk(
        transferId: string,
        offset: number,
        base64: string
    ): Promise<void> {
        if (!this.scenarioFileTransfers.has(transferId)) {
            return;
        }
        try {
            const nextOffset = await this.services.scenarioFilesService.appendTransferChunk(
                transferId,
                offset,
                base64
            );
            await this.view?.webview.postMessage({
                command: 'scenarioFileChunkAccepted',
                transferId,
                nextOffset
            });
        } catch (error) {
            this.scenarioFileTransfers.delete(transferId);
            await this.postScenarioFileFailure(transferId, error);
        }
    }

    private async completeScenarioFileTransfer(transferId: string): Promise<void> {
        const transfer = this.scenarioFileTransfers.get(transferId);
        if (!transfer) {
            return;
        }
        try {
            await this.services.scenarioFilesService.completeTransfer(transferId);
            this.scenarioFileTransfers.delete(transferId);
            await this.view?.webview.postMessage({
                command: 'scenarioFileTransferCompleted',
                transferId,
                itemId: transfer.itemId
            });
            await this.view?.webview.postMessage({
                command: 'scenarioFileInvalidated',
                itemId: transfer.itemId
            });
        } catch (error) {
            this.scenarioFileTransfers.delete(transferId);
            await this.postScenarioFileFailure(transferId, error);
        }
    }

    private async cancelScenarioFileTransfer(transferId: string): Promise<void> {
        if (!this.scenarioFileTransfers.has(transferId)) {
            return;
        }
        this.scenarioFileTransfers.delete(transferId);
        await this.services.scenarioFilesService.cancelTransfer(transferId);
    }

    private async postScenarioFileFailure(
        transferId: string | undefined,
        error: unknown,
        requestId?: string,
        dropId?: string
    ): Promise<void> {
        await this.view?.webview.postMessage({
            command: 'scenarioFileTransferFailed',
            ...(transferId ? { transferId } : {}),
            ...(requestId ? { requestId } : {}),
            ...(dropId ? { dropId } : {}),
            message: errorMessage(error)
        });
    }

    private disposeScenarioFileState(): void {
        this.disposeScenarioFileWatches();
        for (const transferId of this.scenarioFileTransfers.keys()) {
            void this.services.scenarioFilesService.cancelTransfer(transferId);
        }
        this.scenarioFileTransfers.clear();
    }

    private disposeScenarioFileWatches(): void {
        for (const watch of this.scenarioFileWatches.values()) {
            watch.dispose();
        }
        this.scenarioFileWatches.clear();
    }

    private getWebviewHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        const sharedStylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'kotSidebar.css'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrarySidebar.css'));
        const codiconStylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'codicon.css'));
        const protocolUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrarySidebarProtocol.js'));
        const scenarioFilesProtocolUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'scenarioFilesProtocol.js'));
        const featureProtocolUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibraryFeatureProtocol.js'));
        const standaloneLabels = JSON.stringify(getStandaloneFeatureLabels()).replace(/</gu, '\\u003c');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrarySidebar.js'));
        const t = (message: string) => escapeHtmlAttribute(translate(message));
        return `<!DOCTYPE html>
<html lang="${escapeHtmlAttribute(vscode.env.language || 'en')}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link href="${codiconStylesUri}" rel="stylesheet">
    <link href="${sharedStylesUri}" rel="stylesheet">
    <link href="${stylesUri}" rel="stylesheet">
    <title>${t('Library')}</title>
</head>
<body>
    <main class="step-sidebar" data-loading="${t('Loading step library...')}" data-no-matches="${t('No steps match the current filters.')}" data-error="${t('Unable to load the Step Library')}" data-contains-related-scenarios="${t('Contains scenarios related to the open scenario')}" data-insert-step="${t('Insert step')}" data-copy-step="${t('Copy step')}" data-open-definition="${t('Open definition')}" data-add-favorite="${t('Add to favorites')}" data-remove-favorite="${t('Remove from favorites')}" data-insertion-unavailable="${t('Insertion target unavailable')}" data-files="${t('Files')}" data-source-files="${t('Source files')}" data-compiled-files="${t('Compiled files')}" data-rename-attachment="${t('Rename attachment')}" data-open-externally="${t('Open externally')}" data-show-in-file-manager="${t('Show in Finder / Explorer')}" data-delete="${t('Delete')}" data-resource-action-failed="${t('The resource action could not be completed.')}" data-empty-directory="${t('Empty directory')}" data-relationship-current="${t('Currently open scenario')}" data-relationship-incoming-direct="${t('Calls the open scenario directly')}" data-relationship-incoming-transitive="${t('Calls the open scenario through {0} scenarios')}" data-relationship-outgoing-direct="${t('Called by the open scenario directly')}" data-relationship-outgoing-transitive="${t('Called by the open scenario through {0} scenarios')}" data-relationship-contains-related="${t('Contains a scenario related to the open scenario')}">
        <div class="step-toolbar">
            <div class="step-search-wrap kot-search-frame">
                <span class="codicon codicon-search kot-search-icon" aria-hidden="true"></span>
                <input id="searchInput" class="kot-search-input" type="text" aria-label="${t('Search steps and scenarios')}" placeholder="${t('Search steps and scenarios')}">
                <button id="searchClearBtn" class="kot-search-clear hidden" type="button" title="${t('Clear search')}" aria-label="${t('Clear search')}">
                    <span class="codicon codicon-close" aria-hidden="true"></span>
                </button>
            </div>
        </div>
        <div id="treeScroll" class="step-content">
            <div id="tree" class="kot-tree step-tree" role="tree" aria-label="${t('Steps')}"></div>
        </div>
        <div id="status" class="step-status" role="status" aria-live="polite"></div>
    </main>
    <script nonce="${nonce}" src="${protocolUri}"></script>
    <script nonce="${nonce}" src="${scenarioFilesProtocolUri}"></script>
    <script nonce="${nonce}">window.__standaloneFeatureLabels = ${standaloneLabels};</script>
    <script nonce="${nonce}" src="${featureProtocolUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
