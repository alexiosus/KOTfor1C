import * as vscode from 'vscode';
import { getTranslator } from './localization';
import {
    type StepLibraryItem,
    type StepLibrarySnapshot
} from './stepLibraryModel';
import type { StepLibraryActionService, StepLibraryProcessStepMove, StepLibraryProcessStepReorder,
    StepLibraryProcessStepRemove, StepLibraryProcessTarget } from './stepLibraryActions';
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

export interface StepLibraryPanelServices {
    readonly extensionUri: vscode.Uri;
    readonly snapshotService: StepLibrarySnapshotService;
    readonly actionService: StepLibraryActionService;
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

export type StepLibraryInboundMessage =
    | { readonly command: 'ready' }
    | { readonly command: 'refresh' }
    | { readonly command: 'create' }
    | { readonly command: 'insert'; readonly itemId: string }
    | { readonly command: 'copy'; readonly itemId: string }
    | { readonly command: 'openDefinition' | 'openScenarioProperties' | 'convertFormat'; readonly itemId: string }
    | { readonly command: 'rename'; readonly itemId: string }
    | { readonly command: 'renameMainGroup'; readonly itemId: string }
    | { readonly command: 'deleteDefinition'; readonly itemId: string }
    | { readonly command: 'toggleFavorite'; readonly itemId: string }
    | ({ readonly command: 'moveProcessStep'; readonly itemId: string; readonly viewIdentity: string } & StepLibraryProcessStepMove)
    | ({ readonly command: 'reorderProcessStep'; readonly itemId: string; readonly viewIdentity: string } & StepLibraryProcessStepReorder)
    | ({ readonly command: 'removeProcessStep'; readonly itemId: string; readonly viewIdentity: string } & StepLibraryProcessStepRemove)
    | ({ readonly command: 'addProcessSteps'; readonly itemId: string; readonly viewIdentity: string } & StepLibraryProcessTarget)
    | ScenarioFilesMessage
    | StandaloneFeatureMessage;

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
    const standaloneMessage = parseStandaloneFeatureMessage(value);
    if (standaloneMessage) { return standaloneMessage; }
    const scenarioFilesMessage = parseScenarioFilesMessage(value);
    if (scenarioFilesMessage) {
        return scenarioFilesMessage;
    }
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.command === 'reorderProcessStep' || record.command === 'removeProcessStep' || record.command === 'addProcessSteps') {
        const keys = ['itemId', 'processUri', 'processUid', 'viewIdentity', 'stepsSignature'] as const;
        if (keys.some(key => typeof record[key] !== 'string' || !(record[key] as string).trim())) { return null; }
        const target = { itemId: record.itemId as string, processUri: record.processUri as string, processUid: record.processUid as string,
            viewIdentity: record.viewIdentity as string, stepsSignature: record.stepsSignature as string };
        if (record.command === 'addProcessSteps') { return { command: record.command, ...target }; }
        if (typeof record.stepUid !== 'string' || !record.stepUid.trim()) { return null; }
        if (record.command === 'removeProcessStep') { return { command: record.command, ...target, stepUid: record.stepUid }; }
        if (record.beforeStepUid !== null && (typeof record.beforeStepUid !== 'string' || !record.beforeStepUid.trim())) { return null; }
        return { command: record.command, ...target, stepUid: record.stepUid, beforeStepUid: record.beforeStepUid as string | null };
    }
    if (record.command === 'moveProcessStep') {
        const keys = ['itemId', 'processUri', 'processUid', 'stepUid', 'viewIdentity', 'stepsSignature'] as const;
        if (keys.some(key => typeof record[key] !== 'string' || !(record[key] as string).trim())
            || (record.direction !== 'up' && record.direction !== 'down')) { return null; }
        return { command: 'moveProcessStep', itemId: record.itemId as string, processUri: record.processUri as string,
            processUid: record.processUid as string, stepUid: record.stepUid as string, viewIdentity: record.viewIdentity as string,
            stepsSignature: record.stepsSignature as string, direction: record.direction };
    }
    if (record.command === 'ready' || record.command === 'refresh' || record.command === 'create') {
        return { command: record.command };
    }
    if (
        record.command === 'insert'
        || record.command === 'copy'
        || record.command === 'openDefinition'
        || record.command === 'openScenarioProperties'
        || record.command === 'convertFormat'
        || record.command === 'rename'
        || record.command === 'renameMainGroup'
        || record.command === 'deleteDefinition'
        || record.command === 'toggleFavorite'
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
    private readonly pendingActions = new Set<string>();
    private readonly scenarioFileWatches = new Map<string, { dispose(): void }>();
    private readonly scenarioFileTransfers = new Map<string, {
        readonly itemId: string;
        readonly targetRelativePath: string;
    }>();
    private refreshDefinitionsInProgress = false;
    private standaloneController: StandaloneFeatureController | undefined;

    constructor(private readonly services: StepLibraryPanelServices) {
        this.disposables.push(
            this.services.snapshotService.onDidInvalidate(() => {
                this.scheduleRefresh();
            }),
            this.services.actionService.onDidChangeInsertionTarget(target => {
                if (target.resource && this.resource?.toString() !== target.resource.toString()) {
                    this.resource = target.resource;
                    if (this.lastSuccessfulSnapshot) {
                        this.scheduleRefresh();
                    }
                    return;
                }
                if (this.lastSuccessfulSnapshot) {
                    void this.postSnapshotIfChanged(this.lastSuccessfulSnapshot);
                }
            }),
            this.services.favoritesService?.onDidChange(() => {
                if (this.lastSuccessfulSnapshot) {
                    void this.postSnapshotIfChanged(this.lastSuccessfulSnapshot, true);
                }
            }) ?? { dispose: () => undefined }
        );
    }

    public async open(resource?: vscode.Uri): Promise<void> {
        if (resource) {
            this.resource = resource;
        }
        const t = await getTranslator(this.services.extensionUri);
        if (this.panel) {
            this.panel.title = t('KOT for 1C: Library');
            this.panel.reveal(vscode.ViewColumn.One);
            await this.refreshSnapshot();
            return;
        }

        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        const panel = vscode.window.createWebviewPanel(
            StepLibraryPanel.panelType,
            t('KOT for 1C: Library'),
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
        this.disposeScenarioFileState();
        panel.webview.html = this.getWebviewHtml(panel.webview, t);
        if (this.services.context && this.services.standaloneFeatureService) {
            this.standaloneController = new StandaloneFeatureController(
                this.services.context, this.services.standaloneFeatureService, panel.webview,
                this.services.standaloneFeatureControllerOptions
            );
        }
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

        await this.services.prepareStandaloneFeatures?.();
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
        this.pendingActions.clear();
    }

    private disposePanelSubscriptions(): void {
        this.standaloneController?.dispose();
        this.standaloneController = undefined;
        this.disposeScenarioFileState();
        for (const disposable of this.panelDisposables.splice(0)) {
            disposable.dispose();
        }
    }

    private scheduleRefresh(): void {
        if (!this.panel || this.refreshDefinitionsInProgress) {
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
            const snapshot = await this.services.snapshotService.ensureReady(this.resource);
            if (generation !== this.loadGeneration || this.panel !== panel) {
                return;
            }
            if (!panel.visible) {
                this.pendingRefreshWhenVisible = true;
                return;
            }
            this.lastSuccessfulSnapshot = snapshot;
            await this.postSnapshotIfChanged(snapshot, force, true);
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
        force = false,
        rebindScenarioFileWatches = false
    ): Promise<void> {
        if (!this.panel) {
            return;
        }
        const insertionTarget = this.services.actionService.getInsertionTargetState();
        const favoriteItemIds = [
            ...(this.services.favoritesService?.favoriteItemIds(snapshot) ?? new Set<string>())
        ].sort();
        const identity = `${snapshot.viewIdentity}\0${insertionTarget.identity}\0${favoriteItemIds.join(',')}`;
        if (!force && identity === this.lastPostedIdentity) {
            return;
        }
        if (rebindScenarioFileWatches) {
            this.disposeScenarioFileWatches();
        }
        this.lastPostedIdentity = identity;
        await this.panel.webview.postMessage({
            command: 'snapshot',
            snapshot,
            favoriteItemIds,
            insertionTarget: {
                identity: insertionTarget.identity,
                available: insertionTarget.available
            }
        });
    }

    private findItem(itemId: string): StepLibraryItem | undefined {
        return this.lastSuccessfulSnapshot?.items.find(item => item.id === itemId);
    }

    private async postActionResult(
        action: 'insert' | 'copy' | 'openDefinition' | 'openScenarioProperties' | 'convertFormat' | 'rename' | 'renameMainGroup' | 'deleteDefinition' | 'moveProcessStep' | 'reorderProcessStep' | 'removeProcessStep' | 'addProcessSteps',
        itemId: string,
        success: boolean,
        message?: string
    ): Promise<void> {
        await this.panel?.webview.postMessage({
            command: 'actionResult',
            action,
            itemId,
            success,
            ...(message ? { message } : {})
        });
    }

    private async runItemAction(
        action: 'insert' | 'copy' | 'openDefinition' | 'openScenarioProperties' | 'convertFormat' | 'rename' | 'renameMainGroup' | 'deleteDefinition' | 'moveProcessStep' | 'reorderProcessStep' | 'removeProcessStep' | 'addProcessSteps',
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
        } catch (error) {
            const t = await getTranslator(this.services.extensionUri);
            await this.postActionResult(action, itemId, false, t(errorMessage(error)));
        } finally {
            this.pendingActions.delete(key);
        }
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
                if (this.refreshDefinitionsInProgress) {
                    return;
                }
                this.refreshDefinitionsInProgress = true;
                try {
                    await this.services.refreshDefinitions(this.resource);
                    await this.services.standaloneFeatureService?.refresh();
                    this.services.snapshotService.invalidate();
                    await this.refreshSnapshot(true);
                } catch (error) {
                    await this.panel?.webview.postMessage({
                        command: 'error',
                        message: errorMessage(error),
                        hasSnapshot: this.lastSuccessfulSnapshot !== null
                    });
                } finally {
                    this.refreshDefinitionsInProgress = false;
                }
                return;
            case 'create':
                await vscode.commands.executeCommand('kotTestToolkit.showCreateScenarioMenu');
                return;
            case 'standaloneFeatureAction':
                await this.standaloneController?.handleMessage(message);
                return;
            case 'insert':
                await this.runItemAction(
                    'insert',
                    message.itemId,
                    item => this.services.actionService.insert(item, this.resource)
                );
                return;
            case 'copy':
                await this.runItemAction(
                    'copy',
                    message.itemId,
                    item => this.services.actionService.copy(item)
                );
                return;
            case 'convertFormat':
                await this.runItemAction('convertFormat', message.itemId, item => this.services.actionService.convertFormat(item, this.resource,
                    async (uri, line) => { await vscode.commands.executeCommand('kotTestToolkit.convertScenario', vscode.Uri.parse(uri), line); }));
                return;
            case 'openScenarioProperties':
                await this.runItemAction('openScenarioProperties', message.itemId, item => this.services.actionService.openScenarioProperties(item, this.resource,
                    async uri => { await vscode.commands.executeCommand('kotTestToolkit.openScenarioEditor', vscode.Uri.parse(uri)); }));
                return;
            case 'openDefinition':
                await this.runItemAction(
                    'openDefinition',
                    message.itemId,
                    item => item.featureId && this.standaloneController
                        ? this.standaloneController.handleMessage({ command: 'standaloneFeatureAction', action: 'openFeature', featureId: item.featureId })
                        : this.services.actionService.openDefinition(item, this.resource)
                );
                return;
            case 'toggleFavorite': {
                const item = this.findItem(message.itemId);
                if (item) {
                    await this.services.favoritesService?.toggle(item);
                }
                return;
            }
            case 'rename':
                await this.runItemAction('rename', message.itemId, item => this.services.actionService.rename(item, this.resource));
                return;
            case 'renameMainGroup':
                await this.runItemAction('renameMainGroup', message.itemId, item => this.services.actionService.renameMainGroup(item));
                return;
            case 'deleteDefinition':
                await this.runItemAction('deleteDefinition', message.itemId, item => this.services.actionService.delete(item, this.resource));
                return;
            case 'moveProcessStep':
            case 'reorderProcessStep':
            case 'removeProcessStep':
            case 'addProcessSteps':
                await this.runItemAction(message.command, message.itemId, async item => {
                    if (this.lastSuccessfulSnapshot?.viewIdentity !== message.viewIdentity) { return false; }
                    const moved = message.command === 'moveProcessStep' ? await this.services.actionService.moveProcessStep(item, message)
                        : message.command === 'reorderProcessStep' ? await this.services.actionService.reorderProcessStep(item, message)
                        : message.command === 'removeProcessStep' ? await this.services.actionService.removeProcessStep(item, message)
                        : await this.services.actionService.addProcessSteps(item, message);
                    if (moved) {
                        try {
                            await this.services.refreshDefinitions(this.resource);
                            this.services.snapshotService.invalidate();
                            await this.refreshSnapshot(true);
                        } catch (error) {
                            await this.panel?.webview.postMessage({
                                command: 'error', message: errorMessage(error), hasSnapshot: this.lastSuccessfulSnapshot !== null
                            });
                        }
                    }
                    return moved;
                });
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

    private async listScenarioFiles(
        message: Extract<ScenarioFilesMessage, { command: 'listScenarioFiles' }>
    ): Promise<void> {
        const item = scenarioFilesItemForResource(this.findItem(message.itemId), message.resource);
        if (!item) {
            await this.postScenarioFileFailure(undefined, new Error('Unknown scenario file item.'), message.requestId);
            return;
        }
        try {
            const nodes = await this.services.scenarioFilesService.listChildren(
                item,
                message.relativePath
            );
            await this.panel?.webview.postMessage({
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
        const item = this.findItem(itemId);
        if (!item) {
            return;
        }
        try {
            this.scenarioFileWatches.set(itemId, this.services.scenarioFilesService.watch(
                item,
                event => {
                    void this.panel?.webview.postMessage({
                        command: 'scenarioFileInvalidated',
                        itemId: event.itemId
                    });
                }
            ));
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
        const item = scenarioFilesItemForResource(this.findItem(itemId), resource);
        if (!item) {
            return;
        }
        const succeeded = action === 'open'
            ? await this.services.scenarioFilesService.openExternal(item, relativePath)
            : await this.services.scenarioFilesService.revealInOs(item, relativePath);
        await this.panel?.webview.postMessage({
            command: 'scenarioFileActionResult',
            action,
            itemId,
            relativePath,
            succeeded
        });
    }

    private async openCompiledScenarioFeature(itemId: string): Promise<void> {
        const item = this.findItem(itemId);
        if (!item) {
            return;
        }
        const succeeded = await this.services.scenarioFilesService.openCompiledFeature(item);
        await this.panel?.webview.postMessage({
            command: 'scenarioFileActionResult',
            action: 'openFeature',
            itemId,
            succeeded
        });
    }

    private async deleteScenarioFile(
        message: Extract<ScenarioFilesMessage, { command: 'deleteScenarioFile' | 'renameScenarioFile' }>
    ): Promise<void> {
        const item = scenarioFilesItemForResource(this.findItem(message.itemId), message.resource);
        if (!item) {
            await this.postScenarioFileFailure(
                undefined,
                new Error('Unknown scenario file item.')
            );
            return;
        }
        try {
            const result = await this.services.scenarioFilesService[message.command === 'renameScenarioFile' ? 'renameFile' : 'deleteFile'](item, message.relativePath);
            await this.panel?.webview.postMessage({
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
        const item = scenarioFilesItemForResource(this.findItem(message.itemId), message.resource);
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
            await this.panel?.webview.postMessage({
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
            await this.panel?.webview.postMessage({
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
            await this.panel?.webview.postMessage({
                command: 'scenarioFileTransferCompleted',
                transferId,
                itemId: transfer.itemId
            });
            await this.panel?.webview.postMessage({
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
        await this.panel?.webview.postMessage({
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

    private getWebviewHtml(webview: vscode.Webview, t: Translator): string {
        const nonce = getNonce();
        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'codicon.css'));
        const sharedStylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'kotSidebar.css'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrary.css'));
        const protocolUri = webview.asWebviewUri(
            vscode.Uri.joinPath(mediaUri, 'stepLibraryProtocol.js')
        );
        const scenarioFilesProtocolUri = webview.asWebviewUri(
            vscode.Uri.joinPath(mediaUri, 'scenarioFilesProtocol.js')
        );
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibrary.js'));
        const featureProtocolUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'stepLibraryFeatureProtocol.js'));
        const standaloneLabels = JSON.stringify(getStandaloneFeatureLabels(t)).replace(/</gu, '\\u003c');
        const labels = {
            title: t('KOT for 1C: Library'),
            search: t('Search steps and scenarios'),
            searchPlaceholder: t('Search steps and scenarios'),
            clearSearch: t('Clear search'),
            categories: t('Sources and categories'),
            definitions: t('Definitions'),
            details: t('Step details'),
            refresh: t('Refresh step library'),
            create: t('Create'),
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
            favorites: t('Favorites'),
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
            processNotInsertable: t('Use Add process steps to include a subprocess.'),
            inserted: t('Step inserted.'),
            copied: t('Step copied.'),
            opened: t('Definition opened.'),
            addFavorite: t('Add to favorites'),
            removeFavorite: t('Remove from favorites'),
            actionFailed: t('The action could not be completed.'),
            builtIn: t('Vanessa built-in steps'),
            user: t('User steps'),
            export: t('Export scenarios'),
            nested: t('Nested scenarios'),
            main: t('Main scenarios'),
            process: t('Processes'),
            mainScenarioDefinition: t('Main scenario'),
            processDefinition: t('Process'),
            builtInDefinition: t('Vanessa step'),
            userDefinition: t('User step'),
            exportDefinition: t('Export scenario'),
            nestedDefinition: t('Nested scenario'),
            standaloneDefinition: t('Feature'),
            definitionType: t('Type'),
            standalone: t('Standalone features'),
            ungrouped: t('Ungrouped'),
            uncategorized: t('Uncategorized'),
            loadFailed: t('Could not refresh the step library.'),
            showCategories: t('Show sources and categories'),
            resizeCategories: t('Resize sources and categories pane'),
            resizeDetails: t('Resize step details pane'),
            back: t('Back'),
            files: t('Files'),
            sourceFiles: t('Source files'), compiledFiles: t('Compiled files'), renameAttachment: t('Rename attachment'),
            openExternally: t('Open externally'),
            showInFileManager: t('Show in Finder / Explorer'),
            delete: t('Delete'),
            resourceActionFailed: t('The resource action could not be completed.'),
            emptyDirectory: t('Empty directory'),
            processSteps: t('Process steps'),
            addProcessSteps: t('Add process steps'),
            removeProcessStep: t('Remove process step'),
            dragProcessStep: t('Drag to reorder. Alt+Up/Down moves the focused step.'),
            processStepRemoved: t('Process step removed.'),
            moveStepUp: t('Move process step up'),
            moveStepDown: t('Move process step down'),
            scenarioStep: t('Scenario step'),
            processStep: t('Process step'),
            emptyProcessSteps: t('This process has no steps.'),
            processStepMoved: t('Process step moved.'),
            processStepMoveFailed: t('Could not move the process step. Refresh the Library and try again.')
        };
        const documentLanguage = (vscode.env.language || 'en').toLocaleLowerCase().startsWith('ru')
            ? 'ru'
            : 'en';
        return `<!DOCTYPE html>
<html lang="${documentLanguage}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>${escapeHtml(labels.title)}</title>
    <link href="${codiconsUri}" rel="stylesheet">
    <link href="${sharedStylesUri}" rel="stylesheet">
    <link href="${stylesUri}" rel="stylesheet">
</head>
<body
    data-source-built-in="${escapeHtml(labels.builtIn)}"
    data-source-user="${escapeHtml(labels.user)}"
    data-source-export="${escapeHtml(labels.export)}"
    data-source-nested="${escapeHtml(labels.nested)}"
    data-source-main="${escapeHtml(labels.main)}"
    data-source-process="${escapeHtml(labels.process)}"
    data-main-scenario-definition="${escapeHtml(labels.mainScenarioDefinition)}"
    data-process-definition="${escapeHtml(labels.processDefinition)}"
    data-built-in-definition="${escapeHtml(labels.builtInDefinition)}"
    data-user-definition="${escapeHtml(labels.userDefinition)}"
    data-export-definition="${escapeHtml(labels.exportDefinition)}"
    data-nested-definition="${escapeHtml(labels.nestedDefinition)}"
    data-standalone-definition="${escapeHtml(labels.standaloneDefinition)}"
    data-definition-type="${escapeHtml(labels.definitionType)}"
    data-source-standalone="${escapeHtml(labels.standalone)}"
    data-ungrouped="${escapeHtml(labels.ungrouped)}"
    data-uncategorized="${escapeHtml(labels.uncategorized)}"
    data-no-results="${escapeHtml(labels.noResults)}"
    data-no-definitions="${escapeHtml(labels.noDefinitions)}"
    data-select-definition="${escapeHtml(labels.selectDefinition)}"
    data-all-definitions="${escapeHtml(labels.allDefinitions)}"
    data-favorites="${escapeHtml(labels.favorites)}"
    data-source-label="${escapeHtml(labels.source)}"
    data-category-label="${escapeHtml(labels.category)}"
    data-scenario-code-label="${escapeHtml(labels.scenarioCode)}"
    data-description-label="${escapeHtml(labels.description)}"
    data-parameters-label="${escapeHtml(labels.parameters)}"
    data-translation-label="${escapeHtml(labels.translation)}"
    data-template-label="${escapeHtml(labels.template)}"
    data-insertion-unavailable="${escapeHtml(labels.insertionUnavailable)}"
    data-item-not-insertable="${escapeHtml(labels.itemNotInsertable)}"
    data-process-not-insertable="${escapeHtml(labels.processNotInsertable)}"
    data-inserted="${escapeHtml(labels.inserted)}"
    data-copied="${escapeHtml(labels.copied)}"
    data-opened="${escapeHtml(labels.opened)}"
    data-insert="${escapeHtml(labels.insert)}"
    data-copy="${escapeHtml(labels.copy)}"
    data-open-definition="${escapeHtml(labels.openDefinition)}"
    data-add-favorite="${escapeHtml(labels.addFavorite)}"
    data-remove-favorite="${escapeHtml(labels.removeFavorite)}"
    data-action-failed="${escapeHtml(labels.actionFailed)}"
    data-load-failed="${escapeHtml(labels.loadFailed)}"
    data-files="${escapeHtml(labels.files)}"
    data-source-files="${escapeHtml(labels.sourceFiles)}" data-compiled-files="${escapeHtml(labels.compiledFiles)}" data-rename-attachment="${escapeHtml(labels.renameAttachment)}"
    data-open-externally="${escapeHtml(labels.openExternally)}"
    data-show-in-file-manager="${escapeHtml(labels.showInFileManager)}"
    data-delete="${escapeHtml(labels.delete)}"
    data-resource-action-failed="${escapeHtml(labels.resourceActionFailed)}"
    data-empty-directory="${escapeHtml(labels.emptyDirectory)}"
    data-process-steps="${escapeHtml(labels.processSteps)}"
    data-add-process-steps="${escapeHtml(labels.addProcessSteps)}"
    data-remove-process-step="${escapeHtml(labels.removeProcessStep)}"
    data-drag-process-step="${escapeHtml(labels.dragProcessStep)}"
    data-process-step-removed="${escapeHtml(labels.processStepRemoved)}"
    data-move-step-up="${escapeHtml(labels.moveStepUp)}"
    data-move-step-down="${escapeHtml(labels.moveStepDown)}"
    data-scenario-step="${escapeHtml(labels.scenarioStep)}"
    data-process-step="${escapeHtml(labels.processStep)}"
    data-empty-process-steps="${escapeHtml(labels.emptyProcessSteps)}"
    data-process-step-moved="${escapeHtml(labels.processStepMoved)}"
    data-process-step-move-failed="${escapeHtml(labels.processStepMoveFailed)}"
    data-preferred-language="${documentLanguage}"
>
    <div class="library-shell">
        <header class="library-toolbar">
            <button id="categoryToggle" class="icon-button mobile-only" type="button" aria-label="${escapeHtml(labels.showCategories)}">☰</button>
            <div class="search-field">
                <label class="sr-only" for="searchInput">${escapeHtml(labels.search)}</label>
                <span class="codicon codicon-search search-field-icon" aria-hidden="true"></span>
                <input id="searchInput" type="text" autocomplete="off" placeholder="${escapeHtml(labels.searchPlaceholder)}">
                <button id="searchClearBtn" class="search-clear-button hidden" type="button" title="${escapeHtml(labels.clearSearch)}" aria-label="${escapeHtml(labels.clearSearch)}">
                    <span class="codicon codicon-close" aria-hidden="true"></span>
                </button>
            </div>
            <select id="languageFilter" aria-label="${escapeHtml(labels.allLanguages)}">
                <option value="both">${escapeHtml(labels.allLanguages)}</option>
                <option value="ru">${escapeHtml(labels.russian)}</option>
                <option value="en">${escapeHtml(labels.english)}</option>
            </select>
            <select id="sortMode" aria-label="${escapeHtml(labels.relevance)}">
                <option value="relevance">${escapeHtml(labels.relevance)}</option>
                <option value="alphabetical">${escapeHtml(labels.alphabetical)}</option>
            </select>
            <button id="createButton" class="icon-button codicon codicon-add" type="button" title="${escapeHtml(labels.create)}" aria-label="${escapeHtml(labels.create)}"></button>
            <button id="refreshButton" class="icon-button codicon codicon-refresh" type="button" title="${escapeHtml(labels.refresh)}" aria-label="${escapeHtml(labels.refresh)}"></button>
        </header>
        <main class="library-grid">
            <aside id="categoryPane" class="pane category-pane" aria-label="${escapeHtml(labels.categories)}">
                <div class="pane-heading">
                    <h2>${escapeHtml(labels.categories)}</h2>
                    <button id="categoryBack" class="icon-button mobile-only" type="button" aria-label="${escapeHtml(labels.back)}">←</button>
                </div>
                <div id="categoryTree" class="category-tree" role="tree" tabindex="0"></div>
            </aside>
            <div id="categoryResizer" class="pane-resizer" data-divider="category" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(labels.resizeCategories)}" tabindex="0"></div>
            <section class="pane definitions-pane" aria-label="${escapeHtml(labels.definitions)}">
                <div class="pane-heading">
                    <h2>${escapeHtml(labels.definitions)}</h2>
                    <span id="resultCount" class="count-badge">0</span>
                </div>
                <div id="statusMessage" class="status-message">${escapeHtml(labels.loading)}</div>
                <div id="definitionList" class="definition-list" role="listbox" tabindex="0" aria-busy="true">
                    <div id="definitionListContent" class="definition-list-content"></div>
                </div>
            </section>
            <div id="detailsResizer" class="pane-resizer" data-divider="details" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(labels.resizeDetails)}" tabindex="0"></div>
            <section id="detailsPane" class="pane details-pane" aria-label="${escapeHtml(labels.details)}">
                <div class="pane-heading">
                    <button id="detailsBack" class="icon-button mobile-only" type="button" aria-label="${escapeHtml(labels.back)}">←</button>
                    <h2>${escapeHtml(labels.details)}</h2>
                </div>
                <div id="detailsContent" class="details-content">
                    <p class="empty-details">${escapeHtml(labels.selectDefinition)}</p>
                </div>
                <div class="details-actions">
                    <button id="favoriteButton" type="button" disabled aria-label="${escapeHtml(labels.addFavorite)}"><span class="codicon codicon-star-empty"></span></button>
                    <button id="insertButton" class="primary-button" type="button" disabled>${escapeHtml(labels.insert)}</button>
                    <button id="copyButton" type="button" disabled>${escapeHtml(labels.copy)}</button>
                    <button id="convertFormatButton" type="button" hidden>${escapeHtml(t('Conversions…'))}</button>
                    <button id="openDefinitionButton" type="button" disabled>${escapeHtml(labels.openDefinition)}</button>
                </div>
            </section>
        </main>
        <div id="liveRegion" class="sr-only" aria-live="polite"></div>
    </div>
    <script nonce="${nonce}" src="${protocolUri}"></script>
    <script nonce="${nonce}" src="${scenarioFilesProtocolUri}"></script>
    <script nonce="${nonce}">window.__standaloneFeatureLabels = ${standaloneLabels};</script>
    <script nonce="${nonce}" src="${featureProtocolUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
