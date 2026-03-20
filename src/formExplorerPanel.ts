import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    FormExplorerSnapshot,
    FormExplorerSourceLocation,
    parseFormExplorerSnapshotText
} from './formExplorerTypes';
import { getFormExplorerGeneratedArtifactsDirectory, getFormExplorerSnapshotPath } from './formExplorerPaths';
import { getTranslator } from './localization';
import { enrichFormExplorerSnapshot } from './formExplorerEnrichment';

type AdapterMode = 'auto' | 'manual' | 'unknown';

interface FormExplorerWebviewState {
    snapshotPath: string | null;
    usingCustomSnapshotPath: boolean;
    snapshotExists: boolean;
    snapshotMtime: string | null;
    adapterMode: AdapterMode;
    adapterModeStatePath: string | null;
    lastError: string | null;
    snapshot: FormExplorerSnapshot | null;
}

interface FormExplorerWebviewMessage {
    command?: string;
    value?: string;
    source?: FormExplorerSourceLocation;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const DEFAULT_ADAPTER_SETTINGS_FILE_NAME = 'adapter-settings.json';
const DEFAULT_ADAPTER_MODE_FILE_NAME = 'adapter-mode.txt';
const DEFAULT_ADAPTER_MODE_REQUEST_FILE_NAME = 'adapter-mode-request.txt';

export class FormExplorerPanel implements vscode.Disposable {
    public static readonly panelType = 'kotTestToolkit.formExplorerPanel';

    private panel: vscode.WebviewPanel | null = null;
    private readonly disposables: vscode.Disposable[] = [];
    private panelDisposables: vscode.Disposable[] = [];
    private refreshTimer: NodeJS.Timeout | null = null;
    private customSnapshotPath: string | null = null;
    private latestSnapshot: FormExplorerSnapshot | null = null;
    private lastError: string | null = null;
    private snapshotExists = false;
    private snapshotMtime: string | null = null;
    private adapterMode: AdapterMode = 'unknown';
    private adapterModeStatePath: string | null = null;
    private lastSnapshotFingerprint: string | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (
                    event.affectsConfiguration('kotTestToolkit.formExplorer.snapshotPath')
                    || event.affectsConfiguration('kotTestToolkit.formExplorer.autoRefreshSeconds')
                ) {
                    this.lastSnapshotFingerprint = null;
                    this.restartRefreshTimer();
                    void this.refreshSnapshot(true);
                }
            })
        );
    }

    public async open(): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        if (this.panel) {
            this.panel.title = t('KOT Form Explorer');
            this.panel.reveal(vscode.ViewColumn.One);
            await this.postState();
            this.startRefreshTimer();
            void this.refreshSnapshot(true);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            FormExplorerPanel.panelType,
            t('KOT Form Explorer'),
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
                this.stopRefreshTimer();
                this.panelDisposables.forEach(disposable => disposable.dispose());
                this.panelDisposables = [];
                this.panel = null;
            }),
            this.panel.onDidChangeViewState(event => {
                if (event.webviewPanel.visible) {
                    this.startRefreshTimer();
                    void this.refreshSnapshot(true);
                } else {
                    this.stopRefreshTimer();
                }
            }),
            this.panel.webview.onDidReceiveMessage(message => {
                void this.handleMessage(message as FormExplorerWebviewMessage);
            })
        ];

        this.startRefreshTimer();
        await this.refreshSnapshot(true);
    }

    public dispose(): void {
        this.stopRefreshTimer();
        this.panelDisposables.forEach(disposable => disposable.dispose());
        this.panelDisposables = [];
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
        this.panel?.dispose();
        this.panel = null;
    }

    private async handleMessage(message: FormExplorerWebviewMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                await this.postState();
                break;
            case 'refreshSnapshot':
                await this.refreshSnapshot(true);
                break;
            case 'chooseSnapshotFile':
                await this.chooseSnapshotFile();
                break;
            case 'useConfiguredSnapshotPath':
                this.customSnapshotPath = null;
                this.lastSnapshotFingerprint = null;
                await this.refreshSnapshot(true);
                break;
            case 'buildExtension':
                await vscode.commands.executeCommand('kotTestToolkit.generateFormExplorerExtension');
                break;
            case 'openSettings':
                await vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.formExplorer.snapshotPath');
                break;
            case 'openSnapshotFile':
                await this.openSnapshotFile();
                break;
            case 'revealSnapshotFile':
                await this.revealSnapshotFile();
                break;
            case 'copyToClipboard':
                if (typeof message.value === 'string') {
                    await vscode.env.clipboard.writeText(message.value);
                }
                break;
            case 'toggleAdapterMode':
                await this.toggleAdapterModeRequest();
                break;
            case 'openSourceLocation':
                await this.openSourceLocation(message.source);
                break;
            default:
                break;
        }
    }

    private async chooseSnapshotFile(): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        const defaultPath = this.getEffectiveSnapshotPath();
        const defaultUri = defaultPath ? vscode.Uri.file(defaultPath) : undefined;
        const selection = await vscode.window.showOpenDialog({
            title: t('Choose Form Explorer snapshot JSON file'),
            defaultUri,
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                [t('JSON Files')]: ['json']
            }
        });
        if (!selection || selection.length === 0) {
            return;
        }

        this.customSnapshotPath = selection[0].fsPath;
        this.lastSnapshotFingerprint = null;
        await this.refreshSnapshot(true);
    }

    private async openSnapshotFile(): Promise<void> {
        const snapshotPath = this.getEffectiveSnapshotPath();
        if (!snapshotPath) {
            const t = await getTranslator(this.context.extensionUri);
            vscode.window.showWarningMessage(t('Snapshot path is not configured.'));
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(snapshotPath));
            await vscode.window.showTextDocument(document, { preview: false });
        } catch (error) {
            const t = await getTranslator(this.context.extensionUri);
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(t('Failed to open snapshot file: {0}', message));
        }
    }

    private async revealSnapshotFile(): Promise<void> {
        const snapshotPath = this.getEffectiveSnapshotPath();
        if (!snapshotPath) {
            const t = await getTranslator(this.context.extensionUri);
            vscode.window.showWarningMessage(t('Snapshot path is not configured.'));
            return;
        }

        try {
            await fs.promises.stat(snapshotPath);
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(snapshotPath));
        } catch (error) {
            const t = await getTranslator(this.context.extensionUri);
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(t('Failed to reveal snapshot file: {0}', message));
        }
    }

    private async openSourceLocation(source: FormExplorerSourceLocation | undefined): Promise<void> {
        if (!source?.path) {
            return;
        }

        const absolutePath = this.resolveSourcePath(source.path);
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
            const line = Math.max(0, (source.line ?? 1) - 1);
            const column = Math.max(0, (source.column ?? 1) - 1);
            const position = new vscode.Position(line, column);
            await vscode.window.showTextDocument(document, {
                preview: false,
                selection: new vscode.Range(position, position)
            });
        } catch (error) {
            const t = await getTranslator(this.context.extensionUri);
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(t('Failed to open source location: {0}', message));
        }
    }

    private resolveSourcePath(candidatePath: string): string {
        if (path.isAbsolute(candidatePath)) {
            return candidatePath;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            return path.resolve(workspaceRoot, candidatePath);
        }

        const snapshotPath = this.getEffectiveSnapshotPath();
        if (snapshotPath) {
            return path.resolve(path.dirname(snapshotPath), candidatePath);
        }

        return path.resolve(process.cwd(), candidatePath);
    }

    private getConfiguredSnapshotPath(): string | null {
        return getFormExplorerSnapshotPath();
    }

    private getGeneratedArtifactsDirectory(): string | null {
        return getFormExplorerGeneratedArtifactsDirectory();
    }

    private getAdapterSettingsStatePath(): string | null {
        const generatedArtifactsDirectory = this.getGeneratedArtifactsDirectory();
        if (!generatedArtifactsDirectory) {
            return null;
        }

        return path.join(generatedArtifactsDirectory, DEFAULT_ADAPTER_SETTINGS_FILE_NAME);
    }

    private getAdapterModeStatePath(): string | null {
        const generatedArtifactsDirectory = this.getGeneratedArtifactsDirectory();
        if (!generatedArtifactsDirectory) {
            return null;
        }

        return path.join(generatedArtifactsDirectory, DEFAULT_ADAPTER_MODE_FILE_NAME);
    }

    private getAdapterModeRequestPath(): string | null {
        const generatedArtifactsDirectory = this.getGeneratedArtifactsDirectory();
        if (!generatedArtifactsDirectory) {
            return null;
        }

        return path.join(generatedArtifactsDirectory, DEFAULT_ADAPTER_MODE_REQUEST_FILE_NAME);
    }

    private normalizeAdapterMode(rawValue: unknown): AdapterMode {
        if (typeof rawValue !== 'string') {
            return 'unknown';
        }

        const normalizedValue = rawValue.trim().toLowerCase();
        if (normalizedValue === 'auto' || normalizedValue === '1' || normalizedValue === 'true') {
            return 'auto';
        }
        if (normalizedValue === 'manual' || normalizedValue === '0' || normalizedValue === 'false') {
            return 'manual';
        }

        return 'unknown';
    }

    private async readAdapterModeState(): Promise<{ mode: AdapterMode; fingerprint: string | null; statePath: string | null }> {
        const modeStatePath = this.getAdapterModeStatePath();
        if (modeStatePath) {
            try {
                const stat = await fs.promises.stat(modeStatePath);
                const rawText = await fs.promises.readFile(modeStatePath, 'utf8');
                const mode = this.normalizeAdapterMode(rawText);
                if (mode !== 'unknown') {
                    return {
                        mode,
                        fingerprint: `${modeStatePath}:${stat.mtimeMs}:${stat.size}:${mode}`,
                        statePath: modeStatePath
                    };
                }
            } catch {
                // fall through to settings fallback
            }
        }

        const settingsStatePath = this.getAdapterSettingsStatePath();
        if (settingsStatePath) {
            try {
                const stat = await fs.promises.stat(settingsStatePath);
                const rawText = await fs.promises.readFile(settingsStatePath, 'utf8');
                const parsed = JSON.parse(rawText) as { autoSnapshotEnabled?: unknown } | null;
                if (typeof parsed?.autoSnapshotEnabled === 'boolean') {
                    const mode: AdapterMode = parsed.autoSnapshotEnabled ? 'auto' : 'manual';
                    return {
                        mode,
                        fingerprint: `${settingsStatePath}:${stat.mtimeMs}:${stat.size}:${mode}`,
                        statePath: modeStatePath || settingsStatePath
                    };
                }
            } catch {
                // ignore settings fallback errors
            }
        }

        return {
            mode: 'unknown',
            fingerprint: modeStatePath || settingsStatePath,
            statePath: modeStatePath || settingsStatePath
        };
    }

    private async toggleAdapterModeRequest(): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        const modeRequestPath = this.getAdapterModeRequestPath();
        if (!modeRequestPath) {
            vscode.window.showWarningMessage(
                t('Form Explorer generated artifacts directory is not configured. Set kotTestToolkit.formExplorer.generatedArtifactsDirectory.')
            );
            return;
        }

        const nextMode = this.adapterMode === 'auto' ? 'manual' : 'auto';

        try {
            await fs.promises.mkdir(path.dirname(modeRequestPath), { recursive: true });
            await fs.promises.writeFile(modeRequestPath, `${nextMode}\n`, 'utf8');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(t('Failed to write Form Explorer mode request: {0}', message));
            return;
        }

        await this.refreshSnapshot(true);
    }

    private getEffectiveSnapshotPath(): string | null {
        return this.customSnapshotPath || this.getConfiguredSnapshotPath();
    }

    private getRefreshIntervalMs(): number {
        const seconds = vscode.workspace
            .getConfiguration('kotTestToolkit.formExplorer')
            .get<number>('autoRefreshSeconds', 1);
        const normalizedSeconds = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 60) : 1;
        return normalizedSeconds * 1000;
    }

    private startRefreshTimer(): void {
        if (!this.panel || !this.panel.visible || this.refreshTimer) {
            return;
        }

        this.refreshTimer = setInterval(() => {
            void this.refreshSnapshot(false);
        }, this.getRefreshIntervalMs());
    }

    private stopRefreshTimer(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    private restartRefreshTimer(): void {
        this.stopRefreshTimer();
        this.startRefreshTimer();
    }

    private async refreshSnapshot(force: boolean): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        const modeState = await this.readAdapterModeState();
        this.adapterMode = modeState.mode;
        this.adapterModeStatePath = modeState.statePath;
        const snapshotPath = this.getEffectiveSnapshotPath();

        if (!snapshotPath) {
            this.snapshotExists = false;
            this.snapshotMtime = null;
            const missingPathFingerprint = `missing-snapshot-path|${modeState.fingerprint || ''}`;
            if (!force && missingPathFingerprint === this.lastSnapshotFingerprint) {
                return;
            }
            this.lastError = t(
                'Form Explorer snapshot path is not configured. Set kotTestToolkit.formExplorer.snapshotPath or choose a file manually.'
            );
            this.lastSnapshotFingerprint = missingPathFingerprint;
            await this.postState();
            return;
        }

        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(snapshotPath);
            this.snapshotExists = true;
            this.snapshotMtime = stat.mtime.toISOString();
        } catch {
            this.snapshotExists = false;
            this.snapshotMtime = null;
            const missingFileFingerprint = `missing-snapshot-file:${snapshotPath}|${modeState.fingerprint || ''}`;
            if (!force && missingFileFingerprint === this.lastSnapshotFingerprint) {
                return;
            }
            this.lastError = t('Snapshot file not found: {0}', snapshotPath);
            this.lastSnapshotFingerprint = missingFileFingerprint;
            await this.postState();
            return;
        }

        const fingerprint = `${snapshotPath}:${stat.mtimeMs}:${stat.size}|${modeState.fingerprint || ''}`;
        if (!force && fingerprint === this.lastSnapshotFingerprint) {
            return;
        }

        try {
            const rawText = await fs.promises.readFile(snapshotPath, 'utf8');
            const parsedSnapshot = parseFormExplorerSnapshotText(rawText);
            this.latestSnapshot = await enrichFormExplorerSnapshot(parsedSnapshot, snapshotPath);
            this.lastError = null;
            this.lastSnapshotFingerprint = fingerprint;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = t('Failed to load Form Explorer snapshot from {0}: {1}', snapshotPath, message);
        }

        this.lastSnapshotFingerprint = fingerprint;
        await this.postState();
    }

    private async postState(): Promise<void> {
        if (!this.panel) {
            return;
        }

        await this.panel.webview.postMessage({
            command: 'setState',
            state: this.buildState()
        });
    }

    private buildState(): FormExplorerWebviewState {
        return {
            snapshotPath: this.getEffectiveSnapshotPath(),
            usingCustomSnapshotPath: !!this.customSnapshotPath,
            snapshotExists: this.snapshotExists,
            snapshotMtime: this.snapshotMtime,
            adapterMode: this.adapterMode,
            adapterModeStatePath: this.adapterModeStatePath,
            lastError: this.lastError,
            snapshot: this.latestSnapshot
        };
    }

    private async getWebviewHtml(webview: vscode.Webview): Promise<string> {
        const t = await getTranslator(this.context.extensionUri);
        const nonce = getNonce();
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicon.css'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'formExplorer.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'formExplorer.js'));

        const loc = {
            title: t('KOT Form Explorer'),
            refresh: t('Refresh'),
            buildExtension: t('Build .cfe'),
            chooseSnapshotFile: t('Choose snapshot file'),
            useConfiguredPath: t('Use configured path'),
            moreActions: t('More actions'),
            openSettings: t('Open settings'),
            toggleMode: t('Toggle mode'),
            openSnapshotFile: t('Open snapshot JSON'),
            revealSnapshotFile: t('Reveal snapshot file'),
            elements: t('Elements'),
            details: t('Details'),
            selectedElement: t('Selected element'),
            currentForm: t('Current form'),
            formAttributes: t('Form attributes'),
            commands: t('Commands'),
            searchPlaceholder: t('Search elements'),
            waitingForSnapshot: t('Waiting for snapshot'),
            noSnapshotHint: t('The panel reads a universal JSON snapshot file produced by a 1C-side adapter in the current client session.'),
            noElements: t('No form elements in snapshot.'),
            noMatchingElements: t('No elements match the current filter.'),
            noAttributes: t('No form attributes in snapshot.'),
            noCommands: t('No commands in snapshot.'),
            noSelection: t('Select an element in the tree to inspect its details.'),
            active: t('Active'),
            path: t('Path'),
            name: t('Name'),
            uiName: t('UI name'),
            windowTitle: t('Window title'),
            technicalName: t('Technical name'),
            boundAttribute: t('Bound attribute'),
            metadataPath: t('Metadata path'),
            titleDataPath: t('Title data path'),
            toolTip: t('Tooltip'),
            inputHint: t('Input hint'),
            generatedAt: t('Updated at'),
            pathMode: t('Path mode'),
            mode: t('Update mode'),
            modeAuto: t('Auto'),
            modeManual: t('Manual'),
            snapshotPath: t('Snapshot path'),
            usingConfiguredPath: t('Configured path'),
            usingCustomPath: t('Custom file'),
            showTechnicalItems: t('Show technical items'),
            hideTechnicalItems: t('Hide technical items'),
            showGroups: t('Show form groups'),
            filters: t('Filters'),
            focusActive: t('Focus active'),
            copyPath: t('Copy path'),
            copyValue: t('Copy value'),
            openSourceFile: t('Open source file'),
            source: t('Source'),
            formTitle: t('Form'),
            activeElement: t('Active element'),
            infobase: t('Infobase'),
            user: t('User'),
            platformVersion: t('Platform'),
            configurationVersion: t('Configuration'),
            sessionId: t('Session'),
            host: t('Host'),
            application: t('Application'),
            adapter: t('Adapter'),
            origin: t('Origin'),
            project: t('Project'),
            viewKind: t('View'),
            formType: t('Type'),
            valuePreview: t('Value'),
            notes: t('Notes'),
            schemaVersion: t('Schema'),
            unknownValue: t('n/a'),
            visible: t('Visible'),
            hidden: t('Hidden'),
            enabled: t('Enabled'),
            disabled: t('Disabled'),
            readOnly: t('Read-only'),
            writable: t('Writable'),
            available: t('Available'),
            unavailable: t('Unavailable'),
            required: t('Required'),
            yes: t('Yes'),
            no: t('No'),
            linkedAttribute: t('Linked attribute'),
            sessionInfo: t('Session'),
            elementDetails: t('Element details'),
            attributesDescription: t('Form attributes are underlying data items bound to UI controls.'),
            commandsDescription: t('Commands available in the current snapshot.'),
            copied: t('Copied'),
            activeElementNotDetected: t('Active element is not reported in snapshot.')
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
                <span class="beta-inline-symbol" aria-hidden="true">β</span>
            </div>
            <div class="toolbar">
                <div id="pathModeChip" class="meta-chip compact">
                    <span class="meta-chip-label">${escapeHtml(loc.pathMode)}</span>
                    <span id="pathModeValue" class="meta-chip-value"></span>
                </div>
                <button id="modeChip" class="meta-chip compact interactive-chip" type="button" aria-label="${escapeHtml(loc.toggleMode)}">
                    <span class="meta-chip-label">${escapeHtml(loc.mode)}</span>
                    <span id="modeValue" class="meta-chip-value"></span>
                </button>
                <div class="meta-chip compact">
                    <span class="meta-chip-label">${escapeHtml(loc.generatedAt)}</span>
                    <span id="generatedAtValue" class="meta-chip-value"></span>
                </div>
                <div class="menu-shell">
                    <button id="moreActionsBtn" class="toolbar-btn icon-only" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(loc.moreActions)}">
                        <span class="codicon codicon-ellipsis"></span>
                    </button>
                    <div id="moreActionsMenu" class="menu-popover" role="menu">
                        <button class="menu-item" type="button" data-action="refresh-snapshot" role="menuitem">
                            <span class="codicon codicon-refresh"></span> ${escapeHtml(loc.refresh)}
                        </button>
                        <button class="menu-item" type="button" data-action="build-extension" role="menuitem">
                            <span class="codicon codicon-tools"></span> ${escapeHtml(loc.buildExtension)}
                        </button>
                        <button class="menu-item" type="button" data-action="choose-snapshot-file" role="menuitem">
                            <span class="codicon codicon-folder-opened"></span> ${escapeHtml(loc.chooseSnapshotFile)}
                        </button>
                        <button class="menu-item" type="button" data-action="use-configured-path" role="menuitem">
                            <span class="codicon codicon-debug-restart"></span> ${escapeHtml(loc.useConfiguredPath)}
                        </button>
                    </div>
                </div>
            </div>
        </header>

        <section id="alertBanner" class="banner hidden" role="alert">
            <div class="banner-copy">
                <div id="alertText"></div>
                <p>${escapeHtml(loc.noSnapshotHint)}</p>
            </div>
            <div class="banner-actions">
                <button id="openSettingsBtn" class="ghost-btn" type="button">
                    <span class="codicon codicon-settings-gear"></span> ${escapeHtml(loc.openSettings)}
                </button>
                <button id="openSnapshotFileBtn" class="ghost-btn" type="button">
                    <span class="codicon codicon-json"></span> ${escapeHtml(loc.openSnapshotFile)}
                </button>
                <button id="revealSnapshotFileBtn" class="ghost-btn" type="button">
                    <span class="codicon codicon-folder"></span> ${escapeHtml(loc.revealSnapshotFile)}
                </button>
            </div>
        </section>

        <section class="workspace">
            <section class="panel current-form-panel" id="currentFormPanel">
                <p class="section-label current-form-label">${escapeHtml(loc.currentForm)}</p>
                <div class="current-form-copy">
                    <button id="formTitleValue" class="window-title-btn" type="button">${escapeHtml(loc.waitingForSnapshot)}</button>
                    <p id="formMetaLine" class="meta-line"></p>
                </div>
                <div class="current-form-actions">
                    <button id="currentFormOpenSourceBtn" class="ghost-btn small" type="button">
                        <span class="codicon codicon-go-to-file"></span> ${escapeHtml(loc.openSourceFile)}
                    </button>
                </div>
            </section>

            <aside class="panel sidebar-panel">
                <div class="sidebar-section-head">
                    <p class="section-label">${escapeHtml(loc.elements)}</p>
                    <div id="elementCountValue" class="count-pill">0</div>
                </div>
                <div class="sidebar-actions">
                    <button id="focusActiveBtn" class="ghost-btn small" type="button">
                        <span class="codicon codicon-target"></span> ${escapeHtml(loc.focusActive)}
                    </button>
                    <div class="filter-shell">
                        <button id="filterMenuBtn" class="toggle-btn small" type="button" aria-haspopup="menu" aria-expanded="false">
                            <span class="codicon codicon-settings"></span> ${escapeHtml(loc.filters)}
                        </button>
                        <div id="filterMenu" class="menu-popover filter-menu" role="menu">
                            <label class="menu-check" for="showTechnicalInput">
                                <input id="showTechnicalInput" type="checkbox">
                                <span>${escapeHtml(loc.showTechnicalItems)}</span>
                            </label>
                            <label class="menu-check" for="showGroupsInput">
                                <input id="showGroupsInput" type="checkbox">
                                <span>${escapeHtml(loc.showGroups)}</span>
                            </label>
                        </div>
                    </div>
                </div>
                <label class="search-frame search-frame-wide">
                    <span class="codicon codicon-search" aria-hidden="true"></span>
                    <input id="searchInput" type="text" class="search-input" placeholder="${escapeHtml(loc.searchPlaceholder)}">
                </label>

                <div id="elementTree" class="scroll-region outline-scroll"></div>
            </aside>

            <main class="content">
                <section class="panel selected-panel">
                    <div class="selected-topline">
                        <p class="section-label">${escapeHtml(loc.selectedElement)}</p>
                        <div id="selectedStateRow" class="chip-row compact"></div>
                    </div>
                    <div id="selectedKeyFacts" class="key-facts"></div>
                    <section id="detailsPanel" class="selected-details"></section>
                </section>
                <section class="panel tabs-panel">
                    <div class="tabs-bar">
                        <div class="tab-buttons" role="tablist" aria-label="${escapeHtml(loc.details)}">
                            <button id="tabAttributesBtn" class="tab-btn" type="button" data-tab="attributes" role="tab" aria-selected="true">
                                ${escapeHtml(loc.formAttributes)}
                                <span id="attributeCountValue" class="tab-count">0</span>
                            </button>
                            <button id="tabCommandsBtn" class="tab-btn" type="button" data-tab="commands" role="tab" aria-selected="false">
                                ${escapeHtml(loc.commands)}
                                <span id="commandCountValue" class="tab-count">0</span>
                            </button>
                        </div>
                    </div>

                    <div class="tab-stage">
                        <section class="tab-panel scroll-region is-active" data-tab-panel="attributes">
                            <div class="tab-note">${escapeHtml(loc.attributesDescription)}</div>
                            <div id="attributesPanel"></div>
                        </section>
                        <section class="tab-panel scroll-region" data-tab-panel="commands">
                            <div class="tab-note">${escapeHtml(loc.commandsDescription)}</div>
                            <div id="commandsPanel"></div>
                        </section>
                    </div>
                </section>
            </main>
        </section>
    </div>

    <script nonce="${nonce}">
        window.__formExplorerInitialState = ${initialStateJson};
        window.__formExplorerLoc = ${locJson};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
