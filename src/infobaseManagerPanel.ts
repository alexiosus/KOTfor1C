import * as vscode from 'vscode';
import {
    addInfobaseToLauncherInteractive,
    collectManagedInfobases,
    configureInfobaseStartupParametersInteractive,
    copyInfobaseInteractive,
    createInfobaseInteractive,
    exportInfobaseConfigurationToCfInteractive,
    editInfobaseInteractive,
    exportInfobaseToDtInteractive,
    forgetManagedInfobase,
    ManagedInfobaseRecord,
    openInfobaseInDesigner,
    openInfobaseInEnterprise,
    recreateInfobaseInteractive,
    rememberManualInfobase,
    removeInfobaseFromLauncherInteractive,
    restoreInfobaseFromDtInteractive,
    revealInfobaseInOs,
    showInfobaseLogsInteractive,
    updateInfobaseConfigurationInteractive
} from './infobaseManager';
import { getTranslator } from './localization';
import { normalizeInfobaseConnectionIdentity } from './oneCInfobaseConnection';

type InfobaseManagerSortMode = 'alphabetical' | 'lastOpened' | 'manual';

const INFOBASE_MANAGER_SORT_MODE_KEY = 'infobaseManager.sortMode';
const INFOBASE_MANAGER_MANUAL_ORDER_KEY = 'infobaseManager.manualOrder';

interface InfobaseManagerWebviewState {
    infobases: ManagedInfobaseRecord[];
    selectedInfobasePath: string | null;
    pendingAction: string | null;
    lastError: string | null;
    sortMode: InfobaseManagerSortMode;
}

interface InfobaseManagerWebviewMessage {
    command?: string;
    infobasePath?: string;
    sortMode?: string;
    movedInfobasePath?: string;
    targetInfobasePath?: string;
    dropPlacement?: string;
}

function getNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let index = 0; index < 32; index += 1) {
        result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return result;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export class InfobaseManagerPanel implements vscode.Disposable {
    public static readonly panelType = 'kotTestToolkit.infobaseManagerPanel';

    private panel: vscode.WebviewPanel | null = null;
    private readonly disposables: vscode.Disposable[] = [];
    private panelDisposables: vscode.Disposable[] = [];
    private infobases: ManagedInfobaseRecord[] = [];
    private selectedInfobasePath: string | null = null;
    private pendingAction: string | null = null;
    private lastError: string | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {}

    public dispose(): void {
        this.panelDisposables.forEach(disposable => disposable.dispose());
        this.disposables.forEach(disposable => disposable.dispose());
        this.panel?.dispose();
        this.panel = null;
    }

    public async open(preferredInfobasePath?: string | null): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        if (preferredInfobasePath?.trim()) {
            this.selectedInfobasePath = preferredInfobasePath.trim();
        }

        if (this.panel) {
            this.panel.title = t('KOT Infobase Manager');
            this.panel.reveal(vscode.ViewColumn.One);
            await this.refreshState();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            InfobaseManagerPanel.panelType,
            t('KOT Infobase Manager'),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'media')
                ]
            }
        );

        this.panel.webview.html = await this.getWebviewHtml(this.panel.webview);
        this.panelDisposables = [
            this.panel.onDidDispose(() => {
                this.panelDisposables.forEach(disposable => disposable.dispose());
                this.panelDisposables = [];
                this.panel = null;
            }),
            this.panel.webview.onDidReceiveMessage(message => {
                void this.handleMessage(message as InfobaseManagerWebviewMessage);
            })
        ];

        await this.refreshState();
    }

    private async refreshState(): Promise<void> {
        this.infobases = await this.sortInfobasesForDisplay(await collectManagedInfobases(this.context));
        if (this.selectedInfobasePath) {
            const selectedKey = this.normalizePathForCompare(this.selectedInfobasePath);
            const hasSelected = this.infobases.some(infobase => this.normalizePathForCompare(infobase.infobasePath) === selectedKey);
            if (!hasSelected) {
                this.selectedInfobasePath = null;
            }
        }

        if (!this.selectedInfobasePath && this.infobases.length > 0) {
            this.selectedInfobasePath = this.infobases[0].infobasePath;
        }

        await this.postState();
    }

    private async postState(): Promise<void> {
        if (!this.panel) {
            return;
        }

        await this.panel.webview.postMessage({
            command: 'renderState',
            state: this.buildState()
        });
    }

    private buildState(): InfobaseManagerWebviewState {
        return {
            infobases: this.infobases,
            selectedInfobasePath: this.selectedInfobasePath,
            pendingAction: this.pendingAction,
            lastError: this.lastError,
            sortMode: this.getSortMode()
        };
    }

    private getSortMode(): InfobaseManagerSortMode {
        const storedValue = this.context.workspaceState.get<string>(INFOBASE_MANAGER_SORT_MODE_KEY);
        return storedValue === 'alphabetical' || storedValue === 'lastOpened' || storedValue === 'manual'
            ? storedValue
            : 'lastOpened';
    }

    private async setSortMode(sortMode: InfobaseManagerSortMode): Promise<void> {
        if (sortMode === 'manual') {
            const currentPaths = this.infobases.map(record => this.normalizePathForCompare(record.infobasePath));
            const storedOrder = this.getStoredManualOrder().filter(item => currentPaths.includes(item));
            const nextManualOrder = storedOrder.length > 0
                ? [...storedOrder, ...currentPaths.filter(item => !storedOrder.includes(item))]
                : currentPaths;
            await this.setStoredManualOrder(nextManualOrder);
        }

        await this.context.workspaceState.update(INFOBASE_MANAGER_SORT_MODE_KEY, sortMode);
    }

    private getStoredManualOrder(): string[] {
        const storedValue = this.context.workspaceState.get<unknown>(INFOBASE_MANAGER_MANUAL_ORDER_KEY);
        if (!Array.isArray(storedValue)) {
            return [];
        }

        return storedValue
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .map(entry => this.normalizePathForCompare(entry));
    }

    private async setStoredManualOrder(paths: string[]): Promise<void> {
        const normalizedPaths = paths.map(item => this.normalizePathForCompare(item));
        await this.context.workspaceState.update(INFOBASE_MANAGER_MANUAL_ORDER_KEY, normalizedPaths);
    }

    private buildReconciledManualOrder(records: ManagedInfobaseRecord[]): string[] {
        const knownPaths = records.map(record => this.normalizePathForCompare(record.infobasePath));
        const knownPathSet = new Set(knownPaths);
        const storedPaths = this.getStoredManualOrder().filter(pathValue => knownPathSet.has(pathValue));
        const missingPaths = knownPaths.filter(pathValue => !storedPaths.includes(pathValue));
        return [...storedPaths, ...missingPaths];
    }

    private async sortInfobasesForDisplay(records: ManagedInfobaseRecord[]): Promise<ManagedInfobaseRecord[]> {
        const sortMode = this.getSortMode();
        if (sortMode === 'manual') {
            const manualOrder = this.buildReconciledManualOrder(records);
            const storedOrder = this.getStoredManualOrder();
            if (manualOrder.length !== storedOrder.length || manualOrder.some((item, index) => item !== storedOrder[index])) {
                await this.setStoredManualOrder(manualOrder);
            }

            const rankByPath = new Map<string, number>();
            manualOrder.forEach((item, index) => rankByPath.set(item, index));
            return records.slice().sort((left, right) => {
                const leftRank = rankByPath.get(this.normalizePathForCompare(left.infobasePath)) ?? Number.MAX_SAFE_INTEGER;
                const rightRank = rankByPath.get(this.normalizePathForCompare(right.infobasePath)) ?? Number.MAX_SAFE_INTEGER;
                if (leftRank !== rightRank) {
                    return leftRank - rightRank;
                }

                return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
            });
        }

        if (sortMode === 'alphabetical') {
            return records.slice().sort((left, right) => {
                const byName = left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
                if (byName !== 0) {
                    return byName;
                }

                return left.infobasePath.localeCompare(right.infobasePath, undefined, { sensitivity: 'base' });
            });
        }

        return records.slice().sort((left, right) => {
            const leftTimestamp = left.lastLaunchAt ? Date.parse(left.lastLaunchAt) : 0;
            const rightTimestamp = right.lastLaunchAt ? Date.parse(right.lastLaunchAt) : 0;
            if (leftTimestamp !== rightTimestamp) {
                return rightTimestamp - leftTimestamp;
            }

            const byName = left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
            if (byName !== 0) {
                return byName;
            }

            return left.infobasePath.localeCompare(right.infobasePath, undefined, { sensitivity: 'base' });
        });
    }

    private async reorderManualInfobases(
        movedInfobasePath?: string,
        targetInfobasePath?: string,
        dropPlacement?: string
    ): Promise<void> {
        const movedKey = movedInfobasePath ? this.normalizePathForCompare(movedInfobasePath) : '';
        const targetKey = targetInfobasePath ? this.normalizePathForCompare(targetInfobasePath) : '';
        if (!movedKey || !targetKey || movedKey === targetKey) {
            return;
        }

        const currentOrder = this.buildReconciledManualOrder(this.infobases);
        const movedIndex = currentOrder.indexOf(movedKey);
        const targetIndex = currentOrder.indexOf(targetKey);
        if (movedIndex < 0 || targetIndex < 0) {
            return;
        }

        currentOrder.splice(movedIndex, 1);
        const insertionIndex = currentOrder.indexOf(targetKey);
        const normalizedPlacement = dropPlacement === 'after' ? 'after' : 'before';
        currentOrder.splice(insertionIndex + (normalizedPlacement === 'after' ? 1 : 0), 0, movedKey);
        await this.setStoredManualOrder(currentOrder);
    }

    private normalizePathForCompare(value: string): string {
        const normalized = value.trim();
        if (!normalized) {
            return normalized;
        }

        return normalizeInfobaseConnectionIdentity(normalized);
    }

    private findInfobaseRecord(targetPath?: string | null): ManagedInfobaseRecord | null {
        const effectivePath = targetPath?.trim() || this.selectedInfobasePath || '';
        if (!effectivePath) {
            return null;
        }

        const normalizedTarget = this.normalizePathForCompare(effectivePath);
        return this.infobases.find(infobase =>
            this.normalizePathForCompare(infobase.infobasePath) === normalizedTarget
        ) || null;
    }

    private async executePanelAction(
        pendingActionLabel: string,
        action: () => Promise<void>
    ): Promise<void> {
        this.pendingAction = pendingActionLabel;
        this.lastError = null;
        await this.postState();

        try {
            await action();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = message;
            vscode.window.showErrorMessage(message);
        } finally {
            this.pendingAction = null;
            await this.refreshState();
        }
    }

    private async handleMessage(message: InfobaseManagerWebviewMessage): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        switch (message.command) {
            case 'refresh':
                await this.executePanelAction(t('Refreshing infobases...'), async () => {
                    // State refresh happens in finally.
                });
                return;
            case 'select':
                this.selectedInfobasePath = message.infobasePath?.trim() || null;
                await this.postState();
                return;
            case 'create':
                await this.executePanelAction(t('Creating infobase...'), async () => {
                    const createdInfobasePath = await createInfobaseInteractive(this.context);
                    if (createdInfobasePath?.trim()) {
                        this.selectedInfobasePath = createdInfobasePath.trim();
                    }
                });
                return;
            case 'setSortMode': {
                const nextSortMode = message.sortMode === 'alphabetical' || message.sortMode === 'lastOpened' || message.sortMode === 'manual'
                    ? message.sortMode
                    : null;
                if (!nextSortMode) {
                    return;
                }

                await this.setSortMode(nextSortMode);
                await this.refreshState();
                return;
            }
            case 'reorderManual':
                await this.executePanelAction(t('Updating infobase order...'), async () => {
                    await this.reorderManualInfobases(message.movedInfobasePath, message.targetInfobasePath, message.dropPlacement);
                });
                return;
            case 'addManual':
                await this.executePanelAction(t('Adding infobase path...'), async () => {
                    const selection = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        title: t('Choose infobase folder'),
                        openLabel: t('Use this folder')
                    });
                    if (!selection || selection.length === 0) {
                        return;
                    }

                    const selectedPath = selection[0].fsPath;
                    await rememberManualInfobase(this.context, selectedPath, null);
                    this.selectedInfobasePath = selectedPath;
                });
                return;
            default:
                break;
        }

        const selectedInfobase = this.findInfobaseRecord(message.infobasePath);
        if (!selectedInfobase) {
            this.lastError = t('Select an infobase first.');
            await this.postState();
            return;
        }

        switch (message.command) {
            case 'openEnterprise':
                await this.executePanelAction(t('Opening infobase in 1C:Enterprise...'), async () => {
                    await openInfobaseInEnterprise(this.context, selectedInfobase);
                });
                return;
            case 'openDesigner':
                await this.executePanelAction(t('Opening infobase in Designer...'), async () => {
                    await openInfobaseInDesigner(this.context, selectedInfobase);
                });
                return;
            case 'startFormExplorer':
                await this.executePanelAction(t('Opening Form Explorer for infobase...'), async () => {
                    await vscode.commands.executeCommand(
                        'kotTestToolkit.openFormExplorerForInfobase',
                        selectedInfobase.infobasePath
                    );
                });
                return;
            case 'restoreDt':
                await this.executePanelAction(t('Restoring infobase from DT...'), async () => {
                    await restoreInfobaseFromDtInteractive(this.context, selectedInfobase);
                });
                return;
            case 'exportDt':
                await this.executePanelAction(t('Exporting infobase to DT...'), async () => {
                    await exportInfobaseToDtInteractive(this.context, selectedInfobase.infobasePath);
                });
                return;
            case 'saveCf':
                await this.executePanelAction(t('Saving infobase configuration to CF...'), async () => {
                    await exportInfobaseConfigurationToCfInteractive(this.context, selectedInfobase.infobasePath);
                });
                return;
            case 'updateConfig':
                await this.executePanelAction(t('Updating infobase configuration...'), async () => {
                    await updateInfobaseConfigurationInteractive(this.context, selectedInfobase);
                });
                return;
            case 'configureLaunchKeys':
                await this.executePanelAction(t('Editing infobase launch keys...'), async () => {
                    await configureInfobaseStartupParametersInteractive(this.context, selectedInfobase);
                });
                return;
            case 'recreate':
                await this.executePanelAction(t('Recreating infobase...'), async () => {
                    await recreateInfobaseInteractive(this.context, selectedInfobase);
                });
                return;
            case 'editBase':
                await this.executePanelAction(t('Editing infobase...'), async () => {
                    const updatedInfobasePath = await editInfobaseInteractive(this.context, selectedInfobase);
                    if (updatedInfobasePath?.trim()) {
                        this.selectedInfobasePath = updatedInfobasePath.trim();
                    }
                });
                return;
            case 'revealFolder':
                await this.executePanelAction(t('Opening infobase folder...'), async () => {
                    await revealInfobaseInOs(selectedInfobase);
                });
                return;
            case 'copyBase':
                await this.executePanelAction(t('Copying infobase...'), async () => {
                    const copiedInfobasePath = await copyInfobaseInteractive(this.context, selectedInfobase);
                    if (copiedInfobasePath?.trim()) {
                        this.selectedInfobasePath = copiedInfobasePath.trim();
                    }
                });
                return;
            case 'showLogs':
                await this.executePanelAction(t('Opening infobase logs...'), async () => {
                    await showInfobaseLogsInteractive(selectedInfobase);
                });
                return;
            case 'addToLauncher':
                await this.executePanelAction(t('Adding infobase to launcher...'), async () => {
                    await addInfobaseToLauncherInteractive(this.context, selectedInfobase);
                });
                return;
            case 'removeFromLauncher':
                await this.executePanelAction(t('Removing infobase from launcher...'), async () => {
                    await removeInfobaseFromLauncherInteractive(selectedInfobase, this.context);
                });
                return;
            case 'forgetManual':
                await this.executePanelAction(t('Forgetting infobase path from manager...'), async () => {
                    await forgetManagedInfobase(this.context, selectedInfobase.infobasePath);
                });
                return;
            default:
                return;
        }
    }

    private async getWebviewHtml(webview: vscode.Webview): Promise<string> {
        const t = await getTranslator(this.context.extensionUri);
        const nonce = getNonce();
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicon.css'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'infobaseManager.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'infobaseManager.js'));

        const loc = {
            title: t('KOT Infobase Manager'),
            infobases: t('Infobases'),
            status: t('Status'),
            refresh: t('Refresh'),
            createInfobase: t('Create infobase'),
            addInfobasePath: t('Add path'),
            searchPlaceholder: t('Filter by name, path or state'),
            sortLabel: t('Sort'),
            sortAlphabetical: t('Alphabetical'),
            sortLastOpened: t('Last opened'),
            sortManual: t('Manual order'),
            noInfobases: t('No infobases discovered yet.'),
            noInfobasesHint: t('Create a new infobase or add an existing one manually to start managing it here.'),
            noSelection: t('Select an infobase to inspect it and run operations.'),
            noSelectionHint: t('The manager combines launcher entries, runtime infobases, snapshots and manual paths in one place.'),
            state: t('State'),
            lastLaunch: t('Last launch'),
            lastRunLog: t('Last run log'),
            startupKeys: t('Launch keys'),
            startupKeysWorkspaceDefault: t('Using workspace default launch keys'),
            technicalDetails: t('Technical details'),
            launcher: t('Launcher'),
            roles: t('Roles'),
            sources: t('Sources'),
            lastSnapshot: t('Last snapshot'),
            exists: t('Directory'),
            markerFile: t('1Cv8.1CD'),
            present: t('Present'),
            absent: t('Absent'),
            none: t('None'),
            launcherRegistered: t('Registered in 1C launcher'),
            launcherNotRegistered: t('Not registered in 1C launcher'),
            openEnterprise: t('Open in 1C'),
            openDesigner: t('Open in Designer'),
            openWithFormExplorer: t('Open with Form Explorer'),
            restoreDt: t('Restore from DT'),
            exportDt: t('Export DT'),
            saveCf: t('Save CF'),
            updateConfig: t('Update configuration'),
            recreate: t('Recreate'),
            editBase: t('Edit base'),
            moreActions: t('More actions'),
            copyBase: t('Copy infobase'),
            revealFolder: t('Open folder'),
            showLogs: t('Show logs'),
            addToLauncher: t('Add to launcher'),
            removeFromLauncher: t('Remove from launcher'),
            forgetManual: t('Forget manual path'),
            lastError: t('Last error'),
            ready: t('Ready'),
            empty: t('Empty'),
            dirty: t('Dirty'),
            missing: t('Missing'),
            startup: t('Startup'),
            vanessa: t('Vanessa'),
            formExplorer: t('Form Explorer'),
            snapshot: t('Snapshot'),
            runtime: t('Runtime'),
            manual: t('Manual'),
            workspaceState: t('Workspace state'),
            lastActivity: t('Last activity'),
            noLaunchKeys: t('No launch keys'),
            workspaceDefaults: t('Use workspace defaults'),
            stateReadyHint: t('The infobase directory exists and looks ready to use.'),
            stateEmptyHint: t('The directory exists but the infobase is empty and needs preparation.'),
            stateDirtyHint: t('The directory exists but does not look like a ready file infobase.'),
            stateMissingHint: t('The infobase path is known, but the directory is currently missing.'),
            openMenu: t('Open menu')
        };

        const initialStateJson = JSON.stringify(this.buildState());
        const locJson = JSON.stringify(loc);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(loc.title)}</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link href="${codiconsUri}" rel="stylesheet">
    <link href="${stylesUri}" rel="stylesheet">
</head>
<body>
    <div class="app-shell">
        <header class="topbar">
            <div class="topbar-title-wrap">
                <h1 class="topbar-title">${escapeHtml(loc.title)}</h1>
            </div>
            <div class="toolbar">
                <div id="statusChip" class="meta-chip compact status-chip" data-state="idle">
                    <span class="meta-chip-label">${escapeHtml(loc.status)}</span>
                    <span id="statusValue" class="meta-chip-value">${escapeHtml(loc.ready)}</span>
                </div>
                <button id="refreshBtn" class="toolbar-btn" type="button">
                    <span class="codicon codicon-refresh" aria-hidden="true"></span>
                    <span>${escapeHtml(loc.refresh)}</span>
                </button>
                <button id="createBtn" class="toolbar-btn primary" type="button">
                    <span class="codicon codicon-add" aria-hidden="true"></span>
                    <span>${escapeHtml(loc.createInfobase)}</span>
                </button>
                <button id="addManualBtn" class="toolbar-btn" type="button">
                    <span class="codicon codicon-folder-opened" aria-hidden="true"></span>
                    <span>${escapeHtml(loc.addInfobasePath)}</span>
                </button>
            </div>
        </header>

        <main class="workspace manager-workspace">
            <aside class="panel sidebar-panel">
                <div class="sidebar-section-head">
                    <p class="section-label">${escapeHtml(loc.infobases)}</p>
                    <span id="infobaseCountValue" class="count-pill">0</span>
                </div>
                <div class="sidebar-controls">
                    <div class="search-row">
                        <label class="search-frame search-frame-wide">
                            <span class="codicon codicon-search" aria-hidden="true"></span>
                            <input id="searchInput" type="text" class="search-input" placeholder="${escapeHtml(loc.searchPlaceholder)}">
                        </label>
                        <div class="menu-shell sort-shell-inline">
                            <button id="sortMenuBtn" class="toolbar-btn sort-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(loc.sortLabel)}" title="${escapeHtml(loc.sortLabel)}">
                                <span class="codicon codicon-list-selection" aria-hidden="true"></span>
                                <span id="sortMenuLabel">${escapeHtml(loc.sortLastOpened)}</span>
                                <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
                            </button>
                            <div id="sortMenu" class="menu-popover sort-menu" role="menu" aria-label="${escapeHtml(loc.sortLabel)}">
                                <button class="menu-item sort-menu-item" type="button" data-sort-mode="lastOpened">
                                    <span class="codicon codicon-check sort-menu-check" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.sortLastOpened)}</span>
                                </button>
                                <button class="menu-item sort-menu-item" type="button" data-sort-mode="alphabetical">
                                    <span class="codicon codicon-check sort-menu-check" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.sortAlphabetical)}</span>
                                </button>
                                <button class="menu-item sort-menu-item" type="button" data-sort-mode="manual">
                                    <span class="codicon codicon-check sort-menu-check" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.sortManual)}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                <div id="infobaseList" class="infobase-list"></div>
            </aside>

            <section class="panel content-panel">
                <div id="emptyState" class="empty-state hidden">
                    <strong>${escapeHtml(loc.noSelection)}</strong>
                    <p>${escapeHtml(loc.noSelectionHint)}</p>
                </div>

                <div id="detailsContent" class="details-layout hidden">
                    <div class="details-hero">
                        <div class="details-copy">
                            <h2 id="infobaseTitle"></h2>
                            <p id="infobasePath" class="details-path"></p>
                        </div>
                        <div id="stateBadge" class="state-pill compact"></div>
                    </div>

                    <div class="action-grid">
                        <button class="toolbar-btn" type="button" data-command="openEnterprise" data-requires-selection="true">
                            <span class="codicon codicon-play" aria-hidden="true"></span>
                            <span>${escapeHtml(loc.openEnterprise)}</span>
                        </button>
                        <button class="toolbar-btn" type="button" data-command="openDesigner" data-requires-selection="true">
                            <span class="codicon codicon-tools" aria-hidden="true"></span>
                            <span>${escapeHtml(loc.openDesigner)}</span>
                        </button>
                        <button class="toolbar-btn" type="button" data-command="startFormExplorer" data-requires-selection="true">
                            <span class="codicon codicon-telescope" aria-hidden="true"></span>
                            <span>${escapeHtml(loc.openWithFormExplorer)}</span>
                        </button>
                        <button class="toolbar-btn" type="button" data-command="restoreDt" data-requires-selection="true">
                            <span class="codicon codicon-cloud-download" aria-hidden="true"></span>
                            <span>${escapeHtml(loc.restoreDt)}</span>
                        </button>
                        <button class="toolbar-btn" type="button" data-command="exportDt" data-requires-selection="true">
                            <span class="codicon codicon-cloud-upload" aria-hidden="true"></span>
                            <span>${escapeHtml(loc.exportDt)}</span>
                        </button>
                        <button class="toolbar-btn" type="button" data-command="updateConfig" data-requires-selection="true">
                            <span class="codicon codicon-repo-sync" aria-hidden="true"></span>
                            <span>${escapeHtml(loc.updateConfig)}</span>
                        </button>
                        <button class="toolbar-btn" type="button" data-command="recreate" data-requires-selection="true">
                            <span class="codicon codicon-discard" aria-hidden="true"></span>
                            <span>${escapeHtml(loc.recreate)}</span>
                        </button>
                        <button class="toolbar-btn" type="button" data-command="editBase" data-requires-selection="true">
                            <span class="codicon codicon-edit" aria-hidden="true"></span>
                            <span>${escapeHtml(loc.editBase)}</span>
                        </button>
                        <div class="menu-shell">
                            <button id="moreActionsBtn" class="toolbar-btn more-actions-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(loc.openMenu)}">
                                <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
                                <span>${escapeHtml(loc.moreActions)}</span>
                            </button>
                            <div id="moreActionsMenu" class="menu-popover" role="menu" aria-label="${escapeHtml(loc.moreActions)}">
                                <button class="menu-item" type="button" data-command="copyBase" data-requires-selection="true">
                                    <span class="codicon codicon-copy" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.copyBase)}</span>
                                </button>
                                <button class="menu-item" type="button" data-command="saveCf" data-requires-selection="true">
                                    <span class="codicon codicon-save" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.saveCf)}</span>
                                </button>
                                <button class="menu-item" type="button" data-command="revealFolder" data-requires-selection="true">
                                    <span class="codicon codicon-folder-opened" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.revealFolder)}</span>
                                </button>
                                <button class="menu-item" type="button" data-command="showLogs" data-requires-selection="true">
                                    <span class="codicon codicon-output" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.showLogs)}</span>
                                </button>
                                <div class="dropdown-separator menu-separator" role="separator"></div>
                                <button id="addToLauncherAction" class="menu-item" type="button" data-command="addToLauncher" data-requires-selection="true">
                                    <span class="codicon codicon-add" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.addToLauncher)}</span>
                                </button>
                                <button id="removeFromLauncherAction" class="menu-item" type="button" data-command="removeFromLauncher" data-requires-selection="true">
                                    <span class="codicon codicon-remove" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.removeFromLauncher)}</span>
                                </button>
                                <button id="forgetManualAction" class="menu-item hidden" type="button" data-command="forgetManual" data-requires-selection="true">
                                    <span class="codicon codicon-close" aria-hidden="true"></span>
                                    <span>${escapeHtml(loc.forgetManual)}</span>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="chip-row">
                        <div class="meta-chip wide">
                            <span class="meta-chip-label">${escapeHtml(loc.lastLaunch)}</span>
                            <span id="lastLaunchValue" class="meta-chip-value"></span>
                        </div>
                        <div class="meta-chip wide">
                            <span class="meta-chip-label">${escapeHtml(loc.lastRunLog)}</span>
                            <span id="lastRunLogValue" class="meta-chip-value"></span>
                        </div>
                        <button id="startupParametersChip" class="meta-chip wide interactive-chip" type="button" data-command="configureLaunchKeys" data-requires-selection="true">
                            <span class="meta-chip-label">${escapeHtml(loc.startupKeys)}</span>
                            <span id="startupParametersValue" class="meta-chip-value"></span>
                        </button>
                    </div>

                    <section class="section-card is-collapsible" data-section-key="technical">
                        <div class="section-toggle-row">
                            <button id="technicalToggle" class="section-toggle" type="button" aria-expanded="false">
                                <span id="technicalToggleIcon" class="codicon codicon-chevron-right section-toggle-icon" aria-hidden="true"></span>
                                <span class="section-toggle-text">${escapeHtml(loc.technicalDetails)}</span>
                            </button>
                        </div>
                        <div id="technicalBody" class="section-card-body is-collapsed">
                            <div class="section-card-inner">
                                <dl class="record-grid">
                                    <div class="record-pair">
                                        <dt>${escapeHtml(loc.launcher)}</dt>
                                        <dd id="launcherValue"></dd>
                                    </div>
                                    <div class="record-pair">
                                        <dt>${escapeHtml(loc.roles)}</dt>
                                        <dd id="rolesValue"></dd>
                                    </div>
                                    <div class="record-pair">
                                        <dt>${escapeHtml(loc.sources)}</dt>
                                        <dd id="sourcesValue"></dd>
                                    </div>
                                    <div class="record-pair">
                                        <dt>${escapeHtml(loc.lastSnapshot)}</dt>
                                        <dd id="lastSnapshotValue"></dd>
                                    </div>
                                    <div class="record-pair">
                                        <dt>${escapeHtml(loc.exists)}</dt>
                                        <dd id="existsValue"></dd>
                                    </div>
                                    <div class="record-pair">
                                        <dt>${escapeHtml(loc.markerFile)}</dt>
                                        <dd id="markerValue"></dd>
                                    </div>
                                </dl>
                            </div>
                        </div>
                    </section>

                    <section id="errorPanel" class="section-card error-card hidden">
                        <div class="section-card-inner">
                            <div class="section-label">${escapeHtml(loc.lastError)}</div>
                            <div id="errorValue" class="error-copy"></div>
                        </div>
                    </section>
                </div>
            </section>
        </main>
    </div>

    <script nonce="${nonce}">
        window.__initialInfobaseManagerState = ${initialStateJson};
        window.__infobaseManagerLoc = ${locJson};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
