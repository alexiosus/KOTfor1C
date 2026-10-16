import * as vscode from 'vscode';
import { buildInfobaseSidebarModel, type InfobaseSidebarModel } from './infobaseSidebarModel';
import type { ManagedInfobaseRecord } from './infobaseManager';
import type { ManagedInfobaseService, ManagedInfobaseSnapshot } from './managedInfobaseService';
import type { InfobaseRuntimeTrackerLike } from './infobaseRuntimeTracker';

export type InfobaseMaintenanceAction =
    | 'openFormExplorer'
    | 'copy'
    | 'recreate'
    | 'updateConfiguration'
    | 'updateFromSources'
    | 'updateFromTemplate'
    | 'edit'
    | 'addToLauncher'
    | 'removeFromLauncher'
    | 'reveal'
    | 'logs'
    | 'exportDt'
    | 'importDt'
    | 'exportCf'
    | 'importCf';

export type InfobaseSidebarMessage =
    | { readonly command: 'ready' }
    | { readonly command: 'refresh' }
    | { readonly command: 'openEnterprise'; readonly infobaseId: string }
    | { readonly command: 'openDesigner'; readonly infobaseId: string }
    | { readonly command: 'maintenance'; readonly infobaseId: string; readonly action: InfobaseMaintenanceAction }
    | { readonly command: 'createInfobase' }
    | { readonly command: 'openFullManager' };

export interface InfobaseSidebarOperations {
    readonly createInfobase: () => Promise<unknown>;
    readonly openEnterprise: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly openDesigner: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly openFormExplorer: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly copy: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly recreate: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly updateConfiguration: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly updateFromSources: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly updateFromTemplate: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly edit: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly addToLauncher: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly removeFromLauncher: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly reveal: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly logs: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly exportDt: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly importDt: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly exportCf: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
    readonly importCf: (infobase: ManagedInfobaseRecord) => Promise<unknown>;
}

export interface InfobaseSidebarServices {
    readonly extensionUri: vscode.Uri;
    readonly managedInfobaseService: Pick<
        ManagedInfobaseService,
        'ensureReady' | 'refresh' | 'onDidInvalidate'
    >;
    readonly runtimeTracker: InfobaseRuntimeTrackerLike;
    readonly loadOperations: () => Promise<InfobaseSidebarOperations>;
}

const MAINTENANCE_ACTIONS = new Set<InfobaseMaintenanceAction>([
    'openFormExplorer',
    'copy',
    'recreate',
    'updateConfiguration',
    'updateFromSources',
    'updateFromTemplate',
    'edit',
    'addToLauncher',
    'removeFromLauncher',
    'reveal',
    'logs',
    'exportDt',
    'importDt',
    'exportCf',
    'importCf'
]);

const ACTIONS_AVAILABLE_WHILE_RUNNING = new Set<keyof InfobaseSidebarOperations>([
    'openEnterprise',
    'openDesigner',
    'openFormExplorer',
    'reveal',
    'logs'
]);

const PASSIVE_ACTIONS = new Set<keyof InfobaseSidebarOperations>(['reveal', 'logs']);

function cleanId(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 2_048 ? trimmed : null;
}

export function parseInfobaseSidebarMessage(value: unknown): InfobaseSidebarMessage | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (
        record.command === 'ready'
        || record.command === 'refresh'
        || record.command === 'createInfobase'
        || record.command === 'openFullManager'
    ) {
        return { command: record.command };
    }
    if (record.command === 'openEnterprise' || record.command === 'openDesigner') {
        const infobaseId = cleanId(record.infobaseId);
        return infobaseId ? { command: record.command, infobaseId } : null;
    }
    if (record.command === 'maintenance') {
        const infobaseId = cleanId(record.infobaseId);
        const action = record.action as InfobaseMaintenanceAction;
        return infobaseId && MAINTENANCE_ACTIONS.has(action)
            ? { command: 'maintenance', infobaseId, action }
            : null;
    }
    return null;
}

export function createDeferredInfobaseSidebarOperations(
    context: vscode.ExtensionContext
): () => Promise<InfobaseSidebarOperations> {
    let cached: Promise<InfobaseSidebarOperations> | null = null;
    return () => {
        cached ??= import('./infobaseManager.js').then(manager => Object.freeze({
            createInfobase: () => manager.createInfobaseInteractive(context),
            openEnterprise: (infobase: ManagedInfobaseRecord) => manager.openInfobaseInEnterprise(context, infobase, {
                forcePlatformPicker: true
            }),
            openDesigner: (infobase: ManagedInfobaseRecord) => manager.openInfobaseInDesigner(context, infobase, {
                forcePlatformPicker: true
            }),
            openFormExplorer: async (infobase: ManagedInfobaseRecord) => await vscode.commands.executeCommand(
                'kotTestToolkit.openFormExplorerForInfobase',
                infobase.infobasePath
            ),
            copy: (infobase: ManagedInfobaseRecord) => manager.copyInfobaseInteractive(context, infobase),
            recreate: (infobase: ManagedInfobaseRecord) => manager.recreateInfobaseInteractive(context, infobase),
            updateConfiguration: (infobase: ManagedInfobaseRecord) =>
                manager.updateInfobaseConfigurationInteractive(context, infobase),
            updateFromSources: (infobase: ManagedInfobaseRecord) =>
                manager.updateInfobaseConfigurationInteractive(context, infobase, 'sourceDirectory'),
            updateFromTemplate: (infobase: ManagedInfobaseRecord) =>
                manager.updateInfobaseConfigurationInteractive(context, infobase, 'template'),
            edit: (infobase: ManagedInfobaseRecord) => manager.editInfobaseInteractive(context, infobase),
            addToLauncher: (infobase: ManagedInfobaseRecord) => manager.addInfobaseToLauncherInteractive(context, infobase),
            removeFromLauncher: (infobase: ManagedInfobaseRecord) => manager.removeInfobaseFromLauncherInteractive(infobase, context),
            reveal: (infobase: ManagedInfobaseRecord) => manager.revealInfobaseInOs(infobase),
            logs: (infobase: ManagedInfobaseRecord) => manager.showInfobaseLogsInteractive(infobase),
            exportDt: (infobase: ManagedInfobaseRecord) => manager.exportInfobaseToDtInteractive(context, infobase.infobasePath),
            importDt: (infobase: ManagedInfobaseRecord) => manager.restoreInfobaseFromDtInteractive(context, infobase),
            exportCf: (infobase: ManagedInfobaseRecord) => manager.exportInfobaseConfigurationToCfInteractive(context, infobase.infobasePath),
            importCf: (infobase: ManagedInfobaseRecord) => manager.updateInfobaseConfigurationInteractive(context, infobase, 'cfFile')
        }));
        return cached;
    };
}

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

export class InfobaseSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'kotTestToolkit.infobaseSidebarView';

    private readonly disposables: vscode.Disposable[] = [];
    private viewDisposables: vscode.Disposable[] = [];
    private view: vscode.WebviewView | null = null;
    private ready = false;
    private pendingReload = false;
    private loadGeneration = 0;
    private refreshInProgress = false;
    private expectedRefreshInvalidation = false;
    private readonly pendingActions = new Map<string, keyof InfobaseSidebarOperations>();
    private refreshAfterActions = false;
    private snapshot: ManagedInfobaseSnapshot | null = null;
    private model: InfobaseSidebarModel | null = null;

    constructor(private readonly services: InfobaseSidebarServices) {
        this.disposables.push(
            services.managedInfobaseService.onDidInvalidate(() => this.handleInvalidation()),
            services.runtimeTracker.onDidChange(() => {
                if (!this.snapshot) {
                    return;
                }
                this.model = buildInfobaseSidebarModel(
                    this.snapshot,
                    this.services.runtimeTracker.runningIdentities()
                );
                void this.postModel(this.model);
            })
        );
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
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
            webviewView.webview.onDidReceiveMessage(raw => {
                const message = parseInfobaseSidebarMessage(raw);
                if (message) {
                    void this.handleMessage(message);
                }
            }),
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible && this.ready && (this.pendingReload || !this.model)) {
                    this.pendingReload = false;
                    void this.load(false);
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
        this.snapshot = null;
        this.model = null;
        this.pendingActions.clear();
    }

    public async refresh(): Promise<void> {
        await this.load(true);
    }

    public async createInfobase(): Promise<void> {
        await this.runAction('__create__', 'createInfobase');
    }

    private disposeViewSubscriptions(): void {
        for (const disposable of this.viewDisposables.splice(0)) {
            disposable.dispose();
        }
    }

    private handleInvalidation(): void {
        if (this.expectedRefreshInvalidation) {
            this.expectedRefreshInvalidation = false;
            return;
        }
        this.loadGeneration += 1;
        if (this.refreshInProgress || this.pendingActions.size > 0 || !this.ready || !this.view?.visible) {
            this.pendingReload = true;
            return;
        }
        void this.load(false);
    }

    private async handleMessage(message: InfobaseSidebarMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                this.ready = true;
                if (!this.view?.visible) {
                    this.pendingReload = true;
                    return;
                }
                if (this.model) {
                    await this.postModel(this.model);
                } else {
                    await this.load(false);
                }
                return;
            case 'refresh':
                await this.load(true);
                return;
            case 'openFullManager':
                await vscode.commands.executeCommand('kotTestToolkit.openInfobaseManager');
                return;
            case 'createInfobase':
                await this.runAction('__create__', 'createInfobase');
                return;
            case 'openEnterprise':
                await this.runAction(message.infobaseId, 'openEnterprise');
                return;
            case 'openDesigner':
                await this.runAction(message.infobaseId, 'openDesigner');
                return;
            case 'maintenance':
                await this.runAction(message.infobaseId, message.action);
                return;
        }
    }

    private findRecord(infobaseId: string): ManagedInfobaseRecord | null {
        if (!this.model?.items.some(item => item.id === infobaseId)) {
            return null;
        }
        return this.snapshot?.infobases.find(record => record.id === infobaseId && !record.hidden) ?? null;
    }

    private async runAction(
        infobaseId: string,
        action: keyof InfobaseSidebarOperations
    ): Promise<void> {
        const record = action === 'createInfobase' ? null : this.findRecord(infobaseId);
        if (action !== 'createInfobase' && !record) {
            return;
        }
        const passive = PASSIVE_ACTIONS.has(action);
        if (this.pendingActions.has(infobaseId) && !passive) {
            return;
        }
        const item = this.model?.items.find(candidate => candidate.id === infobaseId);
        if (item?.running && !ACTIONS_AVAILABLE_WHILE_RUNNING.has(action)) {
            return;
        }
        if (!passive) {
            this.pendingActions.set(infobaseId, action);
            await this.view?.webview.postMessage({ command: 'pending', infobaseId, action });
        }
        try {
            const operations = await this.services.loadOperations();
            if (action === 'createInfobase') {
                await operations.createInfobase();
            } else {
                await operations[action](record!);
            }
            this.refreshAfterActions = true;
        } catch (error) {
            await this.postError(error);
        } finally {
            if (!passive) {
                this.pendingActions.delete(infobaseId);
                await this.view?.webview.postMessage({ command: 'pending', infobaseId, action: null });
            }
            if (this.pendingActions.size === 0 && this.refreshAfterActions) {
                this.refreshAfterActions = false;
                this.pendingReload = false;
                await this.load(true);
            }
        }
    }

    private async load(forceRefresh: boolean): Promise<void> {
        const view = this.view;
        if (!view || !this.ready) {
            return;
        }
        if (!view.visible) {
            this.pendingReload = true;
            return;
        }
        if (this.pendingActions.size > 0) {
            this.pendingReload = true;
            return;
        }
        if (this.refreshInProgress) {
            return;
        }
        this.refreshInProgress = true;
        const generation = ++this.loadGeneration;
        await view.webview.postMessage({ command: 'loading', retainItems: this.model !== null });
        try {
            this.expectedRefreshInvalidation = forceRefresh;
            const snapshot = forceRefresh
                ? await this.services.managedInfobaseService.refresh()
                : await this.services.managedInfobaseService.ensureReady();
            this.expectedRefreshInvalidation = false;
            if (generation !== this.loadGeneration || this.view !== view || !view.visible) {
                return;
            }
            this.snapshot = snapshot;
            this.model = buildInfobaseSidebarModel(
                snapshot,
                this.services.runtimeTracker.runningIdentities()
            );
            this.pendingReload = false;
            await this.postModel(this.model);
        } catch (error) {
            if (generation === this.loadGeneration && this.view === view) {
                await this.postError(error);
            }
        } finally {
            this.expectedRefreshInvalidation = false;
            this.refreshInProgress = false;
            if (this.pendingReload && this.ready && this.view?.visible) {
                this.pendingReload = false;
                void this.load(false);
            }
        }
    }

    private async postModel(model: InfobaseSidebarModel): Promise<void> {
        await this.view?.webview.postMessage({ command: 'state', ...model });
    }

    private async postError(error: unknown): Promise<void> {
        const message = errorMessage(error);
        void vscode.window.showErrorMessage(message);
        await this.view?.webview.postMessage({ command: 'error', message, retainItems: this.model !== null });
    }

    private getWebviewHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const mediaUri = vscode.Uri.joinPath(this.services.extensionUri, 'media');
        const sharedStylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'kotSidebar.css'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'infobaseSidebar.css'));
        const codiconStylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'codicon.css'));
        const protocolUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'infobaseSidebarProtocol.js'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'infobaseSidebar.js'));
        const t = (message: string) => escapeHtmlAttribute(translate(message));
        return `<!DOCTYPE html>
<html lang="${escapeHtmlAttribute(vscode.env?.language || 'en')}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link href="${codiconStylesUri}" rel="stylesheet">
    <link href="${sharedStylesUri}" rel="stylesheet">
    <link href="${stylesUri}" rel="stylesheet">
    <title>${t('Infobases')}</title>
</head>
<body>
    <main class="infobase-sidebar" data-runtime-marker="${t('Running from KOT')}" data-pending-marker="${t('Infobase operation in progress')}" data-open-enterprise="${t('Open in 1C:Enterprise')}" data-open-designer="${t('Open in Designer')}" data-maintenance="${t('Maintenance actions')}" data-open-form-explorer="${t('Open KOT Form Explorer')}" data-copy="${t('Copy infobase')}" data-recreate="${t('Recreate infobase')}" data-update-configuration="${t('Update configuration')}" data-update-from-template="${t('Update from installed template')}" data-edit="${t('Edit infobase')}" data-add-to-launcher="${t('Add to 1C launcher')}" data-remove-from-launcher="${t('Remove from launcher')}" data-reveal="${t('Open infobase folder')}" data-logs="${t('Show infobase logs')}" data-export-dt="${t('Export DT')}" data-import-dt="${t('Import DT')}" data-export-cf="${t('Export .cf')}" data-general-heading="${t('Other actions')}" data-dt-heading="${t('Infobase data · DT')}" data-cf-heading="${t('Configuration · CF and files')}" data-kot-heading="${t('KOT tools')}" data-refreshing="${t('Refreshing infobases...')}" data-loading="${t('Loading infobases...')}" data-empty="${t('No managed infobases')}" data-running="${t('Running action...')}" data-error="${t('Unable to load infobases')}">
        <div id="list" class="infobase-list" role="list" aria-label="${t('Infobases')}"></div>
        <div id="status" class="infobase-status" role="status" aria-live="polite"></div>
    </main>
    <script nonce="${nonce}" src="${protocolUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
