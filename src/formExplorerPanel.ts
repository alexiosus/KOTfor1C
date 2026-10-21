import type { VanessaFormExplorerSource } from './vanessaControlFormSource';
import { formStepContext, formStepTarget, type VanessaFormStepResult } from './vanessaControlFormSteps';
import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    FormExplorerElementInfo,
    FormExplorerSnapshot,
    FormExplorerSourceLocation,
    parseFormExplorerSnapshotText
} from './formExplorerTypes';
import { getFormExplorerGeneratedArtifactsDirectory, getFormExplorerSnapshotPath } from './formExplorerPaths';
import { getTranslator } from './localization';
import { enrichFormExplorerSnapshot } from './formExplorerEnrichment';
import {
    getManagedInfobasePreferredPlatformClientExePath,
    setManagedInfobasePreferredPlatformClientExePath
} from './infobaseManager';
import {
    FormExplorerSuggestedStep,
    suggestFormExplorerSteps
} from './formExplorerStepSuggestions';
import { getConfiguredScenarioLanguage, ScenarioLanguage } from './gherkinLanguage';
import type {
    StartFormExplorerBridgeCommandOptions,
    StartFormExplorerBridgeResult
} from './formExplorerBridgeGenerator';
import type { StepCatalogProvider } from './stepCatalogService';
import { normalizeInfobaseReference } from './oneCInfobaseConnection';
import {
    type ConfiguredOneCPlatform,
    ensureOneCPlatformsCatalogInitialized,
    normalizeOneCClientExePath
} from './oneCPlatform';

type AdapterMode = 'auto' | 'manual' | 'unknown' | 'mcp';
type PendingOperationKind = 'refresh' | 'table' | 'locator' | 'start';

interface PendingOperationState {
    kind: PendingOperationKind;
    startedAt: number;
    baselineFingerprint: string | null;
}

interface FormExplorerWebviewState {
    liveSource: 'mcp' | 'snapshot';
    windowControlsAvailable: boolean;
    choosingClientWindow: boolean;
    snapshotPath: string | null;
    snapshotExists: boolean;
    snapshotMtime: string | null;
    platforms: ConfiguredOneCPlatform[];
    launchInfobasePath: string | null;
    launchPlatformClientExePath: string | null;
    startedInfobaseClientRunning: boolean;
    adapterMode: AdapterMode;
    adapterModeStatePath: string | null;
    lastError: string | null;
    snapshot: FormExplorerSnapshot | null;
    scenarioLanguage: ScenarioLanguage;
    selectedElementPath: string | null;
    suggestedSteps: FormExplorerSuggestedStep[];
    suggestedStepsForPath: string | null;
    suggestedStepsError: string | null;
    nativeStepsAvailable: boolean;
    nativeSteps: NativeStepsState;
    pendingOperation: PendingOperationKind | null;
}

interface NativeStepsState { loading: boolean; forPath?: string; text?: string; error?: string }

interface FormExplorerWebviewMessage {
    command?: string;
    value?: string;
    elementPath?: string;
    platformClientExePath?: string | null;
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
const DEFAULT_ADAPTER_RUNTIME_STATE_FILE_NAME = 'adapter-runtime-state.json';
const DEFAULT_ADAPTER_MODE_FILE_NAME = 'adapter-mode.txt';
const DEFAULT_ADAPTER_MODE_REQUEST_FILE_NAME = 'adapter-mode-request.txt';
const DEFAULT_ADAPTER_REQUEST_CONTEXT_FILE_NAME = 'adapter-request-context.json';

export class FormExplorerPanel implements vscode.Disposable {
    public static readonly panelType = 'kotTestToolkit.formExplorerPanel';

    private panel: vscode.WebviewPanel | null = null;
    private readonly disposables: vscode.Disposable[] = [];
    private panelDisposables: vscode.Disposable[] = [];
    private refreshTimer: NodeJS.Timeout | null = null;
    private snapshotRevision = 0;
    private choosingClientWindow = false;
    private latestSnapshot: FormExplorerSnapshot | null = null;
    private lastError: string | null = null;
    private snapshotExists = false;
    private snapshotMtime: string | null = null;
    private adapterMode: AdapterMode = 'unknown';
    private adapterModeStatePath: string | null = null;
    private resolvedSnapshotPath: string | null = null;
    private lastSnapshotFingerprint: string | null = null;
    private selectedElementPath: string | null = null;
    private suggestedSteps: FormExplorerSuggestedStep[] = [];
    private suggestedStepsForPath: string | null = null;
    private suggestedStepsError: string | null = null;
    private lastSuggestedStepsFingerprint: string | null = null;
    private nativeStepsReading = false;
    private nativeStepsWanted = false;
    private nativeStepsRevision = 0;
    private nativeStepsTimer: NodeJS.Timeout | undefined;
    private nativeSteps: NativeStepsState = { loading: false };
    private pendingOperation: PendingOperationState | null = null;
    private availablePlatforms: ConfiguredOneCPlatform[] = [];
    private preferredStartInfobasePath: string | null = null;
    private preferredStartOneCClientExePath: string | null = null;
    private startedInfobaseProcessId: number | null = null;
    private startedBridgeProcessId: number | null = null;
    private processMonitorTimer: NodeJS.Timeout | null = null;
    private processStateRefreshPromise: Promise<boolean> | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly stepCatalogProvider: StepCatalogProvider,
        private readonly mcpSource?: VanessaFormExplorerSource,
        private readonly readNativeSteps?: (snapshot: FormExplorerSnapshot, path: string, isCurrent: () => boolean) => Promise<VanessaFormStepResult | undefined>,
        private readonly clearNativeStepsCache?: () => void,
        private readonly getCachedNativeSteps?: (snapshot: FormExplorerSnapshot, path: string) => string | undefined
    ) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(async event => {
                const affectsSnapshotPath = event.affectsConfiguration('kotTestToolkit.formExplorer.snapshotPath') || event.affectsConfiguration('kotTestToolkit.formExplorer.source');
                const affectsRefreshSeconds = event.affectsConfiguration('kotTestToolkit.formExplorer.autoRefreshSeconds');
                const affectsScenarioLanguage = event.affectsConfiguration('kotTestToolkit.editor.newScenarioLanguage');
                const affectsPlatformCatalog = event.affectsConfiguration('kotTestToolkit.platforms.catalog');
                if (affectsSnapshotPath || affectsRefreshSeconds || affectsScenarioLanguage || affectsPlatformCatalog) {
                    if (affectsSnapshotPath || affectsRefreshSeconds) {
                        this.restartRefreshTimer();
                    }
                    if (affectsScenarioLanguage) {
                        this.lastSuggestedStepsFingerprint = null;
                    }
                    if (affectsPlatformCatalog) {
                        await this.refreshAvailablePlatforms();
                    }
                    this.lastSnapshotFingerprint = null;
                    await this.refreshSnapshot(true);
                }
            })
        );
        if (this.mcpSource) {
            this.disposables.push(this.mcpSource.onDidChange(() => {
                if (!this.panel?.visible || !this.usesMcp()) { return; }
                if (['idle', 'unavailable', 'error'].includes(this.mcpSource!.state.status)) {
                    if (!this.mcpSource!.cached()) { this.resetLoadedSnapshotState(); }
                    this.lastError = this.mcpSource!.state.message ?? null; void this.postState();
                }
            }));
        }
        this.disposables.push(this.stepCatalogProvider.onDidChangeCatalog(() => {
            this.lastSuggestedStepsFingerprint = null;
            this.lastSnapshotFingerprint = null;
            if (this.panel?.visible) {
                void this.refreshSnapshot(true);
            }
        }));
    }

    public async open(): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        await this.refreshAvailablePlatforms();
        if (this.panel) {
            this.panel.title = t('KOT Form Explorer');
            this.panel.reveal(vscode.ViewColumn.One);
            await this.postState();
            this.startRefreshTimer();
            void this.refreshSnapshot(true);
            return;
        }

        if (!this.usesMcp()) { await this.clearSnapshotsOnPanelOpen(); }

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
                this.invalidateNativeSteps(true);
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
                    this.invalidateNativeSteps();
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

    public async openAndStart(options?: string | StartFormExplorerBridgeCommandOptions): Promise<void> {
        const commandOptions = typeof options === 'string'
            ? { preferredInfobasePath: options }
            : (options || {});
        this.preferredStartInfobasePath = typeof commandOptions.preferredInfobasePath === 'string' && commandOptions.preferredInfobasePath.trim()
            ? normalizeInfobaseReference(commandOptions.preferredInfobasePath.trim())
            : null;
        this.preferredStartOneCClientExePath = normalizeOneCClientExePath(commandOptions.oneCClientExePath || '') || null;
        await this.open();
        await this.startBridge(commandOptions);
    }

    private resetLoadedSnapshotState(): void {
        this.latestSnapshot = null;
        this.lastError = null;
        this.snapshotExists = false;
        this.snapshotMtime = null;
        this.resolvedSnapshotPath = null;
        this.lastSnapshotFingerprint = null;
        this.selectedElementPath = null;
        this.suggestedSteps = [];
        this.suggestedStepsForPath = null;
        this.suggestedStepsError = null;
        this.invalidateNativeSteps(true);
        this.lastSuggestedStepsFingerprint = null;
    }

    private async deleteKnownSnapshotFiles(): Promise<void> {
        const configuredPath = this.getConfiguredSnapshotPath();
        if (!configuredPath) {
            return;
        }

        const normalizedConfiguredPath = path.resolve(configuredPath);
        const snapshotPathsToDelete = new Set<string>([normalizedConfiguredPath]);
        const configuredDirectory = path.dirname(normalizedConfiguredPath);
        const configuredFileName = path.basename(normalizedConfiguredPath);
        const configuredPrefix = `${configuredFileName}.`;

        try {
            const directoryEntries = await fs.promises.readdir(configuredDirectory, { withFileTypes: true });
            for (const entry of directoryEntries) {
                if (!entry.isFile()) {
                    continue;
                }

                if (entry.name !== configuredFileName && !entry.name.startsWith(configuredPrefix)) {
                    continue;
                }

                snapshotPathsToDelete.add(path.join(configuredDirectory, entry.name));
            }
        } catch {
            // Ignore directory scan errors and still try the configured snapshot path itself.
        }

        for (const snapshotPath of snapshotPathsToDelete) {
            try {
                await fs.promises.rm(snapshotPath, { force: true });
            } catch {
                // Ignore cleanup errors and let normal refresh surface any remaining stale file.
            }
        }
    }

    private async refreshAvailablePlatforms(): Promise<void> {
        this.availablePlatforms = await ensureOneCPlatformsCatalogInitialized();
    }

    private async clearSnapshotsOnPanelOpen(): Promise<void> {
        if (this.hasTrackedFormExplorerProcesses()) {
            return;
        }

        await this.deleteKnownSnapshotFiles();
        this.resetLoadedSnapshotState();
        this.pendingOperation = null;
        this.startedInfobaseProcessId = null;
        this.startedBridgeProcessId = null;
        this.stopProcessMonitorTimer();
    }

    public dispose(): void {
        this.snapshotRevision++;
        this.invalidateNativeSteps(true);
        this.stopRefreshTimer();
        this.stopProcessMonitorTimer();
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
            case 'chooseSource':
                await this.chooseSource(); break;
            case 'chooseClientWindow':
                await this.chooseClientWindow(); break;
            case 'refreshSnapshot':
                await this.refreshSnapshot(true);
                break;
            case 'setPreferredStartPlatform':
                await this.setPreferredStartPlatform(message.platformClientExePath || null);
                break;
            case 'startInfobase':
                if (this.usesMcp()) { await vscode.commands.executeCommand('kotTestToolkit.vanessaControl.clients'); break; }
                await this.startBridge({
                    oneCClientExePath: normalizeOneCClientExePath(
                        message.platformClientExePath
                        || this.resolveEffectiveLaunchPlatformClientExePath()
                        || ''
                    ) || null
                });
                break;
            case 'startBridge':
                await this.startBridge({
                    oneCClientExePath: normalizeOneCClientExePath(
                        message.platformClientExePath
                        || this.resolveEffectiveLaunchPlatformClientExePath()
                        || ''
                    ) || null
                });
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
            case 'requestAdapterRefresh':
                await this.requestAdapterRefresh();
                break;
            case 'requestAdapterLocator':
                await this.requestAdapterLocator();
                break;
            case 'requestTableSnapshotRefresh':
                await this.requestTableSnapshotRefresh(message.elementPath);
                break;
            case 'selectElementPath':
                await this.handleElementSelectionChanged(message.value);
                break;
            case 'formTools': {
                const changed = await vscode.commands.executeCommand<boolean>('kotTestToolkit.vanessaControl.formTools',
                    this.latestSnapshot && this.selectedElementPath ? this.findElementByPath(this.latestSnapshot.elements, this.selectedElementPath)?.name : undefined);
                if (changed) { await this.refreshSnapshot(true); }
                break;
            }
            case 'formChecks':
                if (this.usesMcp()) { await vscode.commands.executeCommand('kotTestToolkit.vanessaControl.formChecks'); } break;
            case 'openSourceLocation':
                await this.openSourceLocation(message.source);
                break;
            default:
                break;
        }
    }

    private parseInfobasePathFromMarker(value: string): string | null {
        const trimmedValue = value.trim();
        if (!trimmedValue) {
            return null;
        }

        return normalizeInfobaseReference(trimmedValue);
    }

    private resolveSnapshotInfobasePath(): string | null {
        const infobaseMarker = typeof this.latestSnapshot?.source?.infobase === 'string'
            ? this.latestSnapshot.source.infobase.trim()
            : '';
        if (!infobaseMarker) {
            return null;
        }

        return this.parseInfobasePathFromMarker(infobaseMarker);
    }

    private resolveCurrentLaunchInfobasePath(): string | null {
        const snapshotInfobasePath = this.resolveSnapshotInfobasePath();
        if (snapshotInfobasePath?.trim()) {
            return normalizeInfobaseReference(snapshotInfobasePath.trim());
        }

        return typeof this.preferredStartInfobasePath === 'string' && this.preferredStartInfobasePath.trim()
            ? normalizeInfobaseReference(this.preferredStartInfobasePath.trim())
            : null;
    }

    private resolveConfiguredPlatformByClientPath(clientExePath: string | null): ConfiguredOneCPlatform | null {
        const normalizedClientPath = normalizeOneCClientExePath(clientExePath || '');
        if (!normalizedClientPath) {
            return null;
        }

        return this.availablePlatforms.find(platform =>
            normalizeOneCClientExePath(platform.clientExePath) === normalizedClientPath
        ) || null;
    }

    private resolveEffectiveLaunchPlatformClientExePath(): string | null {
        const explicitClientPath = normalizeOneCClientExePath(this.preferredStartOneCClientExePath || '');
        if (explicitClientPath) {
            return explicitClientPath;
        }

        const currentLaunchInfobasePath = this.resolveCurrentLaunchInfobasePath();
        if (currentLaunchInfobasePath) {
            const storedClientPath = getManagedInfobasePreferredPlatformClientExePath(this.context, currentLaunchInfobasePath);
            const resolvedStoredPlatform = this.resolveConfiguredPlatformByClientPath(storedClientPath);
            if (resolvedStoredPlatform) {
                return resolvedStoredPlatform.clientExePath;
            }
        }

        return this.availablePlatforms[0]?.clientExePath || null;
    }

    private async setPreferredStartPlatform(clientExePath: string | null): Promise<void> {
        const normalizedClientExePath = normalizeOneCClientExePath(clientExePath || '');
        const currentLaunchInfobasePath = this.resolveCurrentLaunchInfobasePath();
        if (currentLaunchInfobasePath) {
            await setManagedInfobasePreferredPlatformClientExePath(
                this.context,
                currentLaunchInfobasePath,
                normalizedClientExePath || null
            );
            this.preferredStartOneCClientExePath = null;
        } else {
            this.preferredStartOneCClientExePath = normalizedClientExePath || null;
        }

        await this.postState();
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

    private async handleElementSelectionChanged(rawPath: string | undefined): Promise<void> {
        const normalizedPath = typeof rawPath === 'string' ? rawPath.trim() : '';
        const nextSelectedPath = normalizedPath.length > 0 ? normalizedPath : null;

        if (this.selectedElementPath === nextSelectedPath) {
            return;
        }

        this.selectedElementPath = nextSelectedPath;
        this.invalidateNativeSteps();
        if (this.usesMcp() && this.readNativeSteps) {
            this.scheduleNativeSteps();
            await this.postState();
            return;
        }
        await this.postState();
        this.lastSuggestedStepsFingerprint = null;
        if (this.usesMcp() && nextSelectedPath) {
            const snapshot = await this.mcpSource?.element(nextSelectedPath);
            if (this.selectedElementPath !== nextSelectedPath || !this.usesMcp()) { return; }
            if (snapshot) { this.latestSnapshot = snapshot; this.snapshotMtime = snapshot.generatedAt; }
            else { this.lastError = this.mcpSource?.state.message ?? null; }
        }
        await this.refreshSuggestedSteps(false);
        await this.postState();
        this.scheduleNativeSteps();
    }

    private findElementByPath(elements: FormExplorerElementInfo[], targetPath: string): FormExplorerElementInfo | null {
        for (const element of elements) {
            if (element.path === targetPath) {
                return element;
            }

            const nested = this.findElementByPath(element.children || [], targetPath);
            if (nested) {
                return nested;
            }
        }

        return null;
    }

    private findActiveElementPath(elements: FormExplorerElementInfo[]): string | null {
        for (const element of elements) {
            if (element.active && element.path) {
                return element.path;
            }

            const nestedPath = this.findActiveElementPath(element.children || []);
            if (nestedPath) {
                return nestedPath;
            }
        }

        return null;
    }

    private invalidateNativeSteps(clearCache = false): void {
        this.nativeStepsRevision++;
        this.nativeStepsWanted = false;
        clearTimeout(this.nativeStepsTimer);
        this.nativeSteps = { loading: false };
        if (clearCache) { this.clearNativeStepsCache?.(); }
    }

    private scheduleNativeSteps(): void {
        this.invalidateNativeSteps();
        if (!this.panel?.visible || !this.usesMcp() || !this.readNativeSteps || !this.latestSnapshot || !this.selectedElementPath) { return; }
        if (!formStepTarget(this.latestSnapshot, this.selectedElementPath)) { return; }
        this.nativeStepsWanted = true;
        this.nativeSteps = { loading: true, forPath: this.selectedElementPath,
            text: this.getCachedNativeSteps?.(this.latestSnapshot, this.selectedElementPath) };
        this.nativeStepsTimer = setTimeout(() => { void this.refreshNativeSteps(); }, 350);
    }

    private async refreshNativeSteps(): Promise<void> {
        clearTimeout(this.nativeStepsTimer);
        const snapshot = this.latestSnapshot;
        const selectedPath = this.selectedElementPath;
        if (!this.nativeStepsWanted || !this.panel?.visible || !this.usesMcp() || !snapshot || !selectedPath || !this.readNativeSteps || this.nativeStepsReading) { return; }
        if (!this.mcpSource?.inspectionReady) {
            this.nativeStepsTimer = setTimeout(() => { void this.refreshNativeSteps(); }, 250);
            return;
        }
        const revision = this.nativeStepsRevision;
        const context = formStepContext(snapshot, getConfiguredScenarioLanguage());
        const current = () => !!this.panel?.visible && this.usesMcp() && revision === this.nativeStepsRevision && selectedPath === this.selectedElementPath &&
            !!this.latestSnapshot && formStepContext(this.latestSnapshot, getConfiguredScenarioLanguage()) === context;
        this.nativeStepsWanted = false;
        this.nativeStepsReading = true;
        const operation = { loading: true, forPath: selectedPath, text: this.nativeSteps.forPath === selectedPath ? this.nativeSteps.text : undefined };
        this.nativeSteps = operation; await this.postState();
        try {
            const result = await this.readNativeSteps(snapshot, selectedPath, current);
            if (current()) {
                if (result) {
                    this.latestSnapshot = result.snapshot; this.snapshotMtime = result.snapshot.generatedAt;
                    this.nativeSteps = { loading: false, forPath: selectedPath, text: result.text };
                } else {
                    this.nativeSteps = { loading: false, forPath: selectedPath, error: vscode.l10n.t(this.mcpSource?.state.message ?? 'Vanessa did not return suggested steps. Refresh the session or select a current element in the test client and retry.') };
                }
            }
        } catch (error) {
            if (current()) {
                this.nativeSteps = { loading: false, forPath: selectedPath, error: vscode.l10n.t(error instanceof Error ? error.message : 'Vanessa did not return suggested steps. Refresh the session or select a current element in the test client and retry.') };
            }
        } finally {
            this.nativeStepsReading = false;
            if (this.nativeSteps === operation) { this.nativeSteps = { loading: false }; }
            if (this.nativeStepsWanted) { this.nativeStepsTimer = setTimeout(() => { void this.refreshNativeSteps(); }, 0); }
            await this.postState();
        }
    }

    private async refreshSuggestedSteps(force: boolean): Promise<void> {
        if (this.usesMcp()) { this.suggestedSteps = []; this.suggestedStepsForPath = null; this.suggestedStepsError = null; return; }
        const snapshot = this.latestSnapshot;
        const selectedPath = this.selectedElementPath;
        const preferredLanguage = getConfiguredScenarioLanguage();

        if (!snapshot || !selectedPath) {
            this.suggestedSteps = [];
            this.suggestedStepsForPath = null;
            this.suggestedStepsError = null;
            this.lastSuggestedStepsFingerprint = null;
            return;
        }

        const suggestionFingerprint = `${this.lastSnapshotFingerprint || ''}|${selectedPath}|${preferredLanguage}`;
        if (!force && suggestionFingerprint === this.lastSuggestedStepsFingerprint) {
            return;
        }

        const selectedElement = this.findElementByPath(snapshot.elements, selectedPath);
        if (!selectedElement) {
            this.suggestedSteps = [];
            this.suggestedStepsForPath = selectedPath;
            this.suggestedStepsError = null;
            this.lastSuggestedStepsFingerprint = suggestionFingerprint;
            return;
        }

        try {
            this.suggestedSteps = await suggestFormExplorerSteps(
                this.stepCatalogProvider,
                snapshot,
                selectedElement,
                12,
                preferredLanguage
            );
            this.suggestedStepsForPath = selectedPath;
            this.suggestedStepsError = null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.suggestedSteps = [];
            this.suggestedStepsForPath = selectedPath;
            this.suggestedStepsError = message;
        }

        this.lastSuggestedStepsFingerprint = suggestionFingerprint;
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

    private getAdapterRuntimeStatePath(): string | null {
        const generatedArtifactsDirectory = this.getGeneratedArtifactsDirectory();
        if (!generatedArtifactsDirectory) {
            return null;
        }

        return path.join(generatedArtifactsDirectory, DEFAULT_ADAPTER_RUNTIME_STATE_FILE_NAME);
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

    private getAdapterRequestContextPath(): string | null {
        const generatedArtifactsDirectory = this.getGeneratedArtifactsDirectory();
        if (!generatedArtifactsDirectory) {
            return null;
        }

        return path.join(generatedArtifactsDirectory, DEFAULT_ADAPTER_REQUEST_CONTEXT_FILE_NAME);
    }

    private async isProcessRunning(processId: number): Promise<boolean> {
        if (!Number.isInteger(processId) || processId <= 0) {
            return false;
        }

        if (process.platform === 'win32') {
            return await new Promise<boolean>(resolve => {
                cp.execFile(
                    'tasklist',
                    ['/FI', `PID eq ${processId}`, '/FO', 'CSV', '/NH'],
                    { windowsHide: true },
                    (error, stdout) => {
                        if (error) {
                            resolve(false);
                            return;
                        }

                        const output = String(stdout || '').trim();
                        resolve(Boolean(output) && !/^"?INFO:/i.test(output));
                    }
                );
            });
        }

        try {
            process.kill(processId, 0);
            return true;
        } catch {
            return false;
        }
    }

    private hasTrackedFormExplorerProcesses(): boolean {
        return this.startedInfobaseProcessId !== null || this.startedBridgeProcessId !== null;
    }

    private setTrackedFormExplorerProcesses(
        infobaseProcessId: number | null,
        bridgeProcessId: number | null
    ): void {
        this.startedInfobaseProcessId = Number.isInteger(infobaseProcessId) && (infobaseProcessId ?? 0) > 0
            ? infobaseProcessId
            : null;
        this.startedBridgeProcessId = Number.isInteger(bridgeProcessId) && (bridgeProcessId ?? 0) > 0
            ? bridgeProcessId
            : null;

        if (this.hasTrackedFormExplorerProcesses()) {
            this.startProcessMonitorTimer();
            return;
        }

        this.stopProcessMonitorTimer();
    }

    private startProcessMonitorTimer(): void {
        if (this.processMonitorTimer) {
            return;
        }

        this.processMonitorTimer = setInterval(() => {
            void this.pollTrackedFormExplorerProcesses();
        }, 1000);
    }

    private stopProcessMonitorTimer(): void {
        if (this.processMonitorTimer) {
            clearInterval(this.processMonitorTimer);
            this.processMonitorTimer = null;
        }
    }

    private async pollTrackedFormExplorerProcesses(): Promise<void> {
        const stateChanged = await this.refreshStartedInfobaseProcessState();
        if (stateChanged) {
            await this.postState();
        }
    }

    private async terminateProcessTree(processId: number): Promise<void> {
        if (!(await this.isProcessRunning(processId))) {
            return;
        }

        if (process.platform === 'win32') {
            await new Promise<void>((resolve, reject) => {
                const killer = cp.spawn('taskkill', ['/PID', String(processId), '/T', '/F'], {
                    windowsHide: true,
                    shell: false
                });
                let stdoutText = '';
                let stderrText = '';

                killer.stdout?.on('data', data => {
                    stdoutText += data.toString();
                });
                killer.stderr?.on('data', data => {
                    stderrText += data.toString();
                });
                killer.on('error', reject);
                killer.on('close', code => {
                    const combinedOutput = `${stdoutText}\n${stderrText}`.toLowerCase();
                    if (
                        code === 0
                        || combinedOutput.includes('there is no running instance')
                        || combinedOutput.includes('not found')
                    ) {
                        resolve();
                        return;
                    }

                    reject(new Error(stderrText.trim() || stdoutText.trim() || `taskkill exited with code ${String(code)}`));
                });
            });
            return;
        }

        try {
            process.kill(processId, 'SIGTERM');
        } catch (error: any) {
            if (error?.code !== 'ESRCH') {
                throw error;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 350));

        if (await this.isProcessRunning(processId)) {
            try {
                process.kill(processId, 'SIGKILL');
            } catch (error: any) {
                if (error?.code !== 'ESRCH') {
                    throw error;
                }
            }
        }
    }

    private async doRefreshStartedInfobaseProcessState(): Promise<boolean> {
        const previousInfobaseProcessId = this.startedInfobaseProcessId;
        const previousBridgeProcessId = this.startedBridgeProcessId;
        if (!previousInfobaseProcessId && !previousBridgeProcessId) {
            this.stopProcessMonitorTimer();
            return false;
        }

        const infobaseRunning = previousInfobaseProcessId
            ? await this.isProcessRunning(previousInfobaseProcessId)
            : false;
        const bridgeRunning = previousBridgeProcessId
            ? await this.isProcessRunning(previousBridgeProcessId)
            : false;

        let nextInfobaseProcessId = infobaseRunning ? previousInfobaseProcessId : null;
        let nextBridgeProcessId = bridgeRunning ? previousBridgeProcessId : null;

        if (previousInfobaseProcessId && !infobaseRunning && previousBridgeProcessId && bridgeRunning) {
            try {
                await this.terminateProcessTree(previousBridgeProcessId);
            } catch {
                // Keep tracking the bridge PID if it could not be terminated.
            }
            nextBridgeProcessId = await this.isProcessRunning(previousBridgeProcessId)
                ? previousBridgeProcessId
                : null;
        } else if (previousBridgeProcessId && !bridgeRunning && previousInfobaseProcessId && infobaseRunning) {
            try {
                await this.terminateProcessTree(previousInfobaseProcessId);
            } catch {
                // Keep tracking the infobase PID if it could not be terminated.
            }
            nextInfobaseProcessId = await this.isProcessRunning(previousInfobaseProcessId)
                ? previousInfobaseProcessId
                : null;
        }

        const stateChanged = nextInfobaseProcessId !== previousInfobaseProcessId
            || nextBridgeProcessId !== previousBridgeProcessId;

        if (!stateChanged) {
            return false;
        }

        this.setTrackedFormExplorerProcesses(nextInfobaseProcessId, nextBridgeProcessId);
        if (!this.hasTrackedFormExplorerProcesses() && this.pendingOperation?.kind === 'start') {
            this.pendingOperation = null;
        }
        if (!this.hasTrackedFormExplorerProcesses()) {
            await this.deleteKnownSnapshotFiles();
            this.resetLoadedSnapshotState();
            this.pendingOperation = null;
            this.adapterMode = 'unknown';
            this.adapterModeStatePath = null;
            this.preferredStartInfobasePath = null;
        }
        return true;
    }

    private async refreshStartedInfobaseProcessState(): Promise<boolean> {
        if (this.processStateRefreshPromise) {
            return await this.processStateRefreshPromise;
        }

        const refreshPromise = this.doRefreshStartedInfobaseProcessState();
        this.processStateRefreshPromise = refreshPromise;
        try {
            return await refreshPromise;
        } finally {
            if (this.processStateRefreshPromise === refreshPromise) {
                this.processStateRefreshPromise = null;
            }
        }
    }

    private async resolveActualSnapshotPath(): Promise<string | null> {
        const configuredSnapshotPath = this.getConfiguredSnapshotPath();
        const candidatePaths = new Set<string>();
        if (configuredSnapshotPath) {
            const normalizedConfiguredPath = path.resolve(configuredSnapshotPath);
            candidatePaths.add(normalizedConfiguredPath);

            const configuredDirectory = path.dirname(normalizedConfiguredPath);
            const configuredFileName = path.basename(normalizedConfiguredPath);
            const configuredPrefix = `${configuredFileName}.`;
            try {
                const directoryEntries = await fs.promises.readdir(configuredDirectory, { withFileTypes: true });
                for (const entry of directoryEntries) {
                    if (!entry.isFile()) {
                        continue;
                    }
                    if (entry.name !== configuredFileName && !entry.name.startsWith(configuredPrefix)) {
                        continue;
                    }
                    candidatePaths.add(path.join(configuredDirectory, entry.name));
                }
            } catch {
                // Ignore directory scan errors and fall back to known explicit paths.
            }
        }

        const runtimeStatePath = this.getAdapterRuntimeStatePath();
        let runtimeSnapshotPath: string | null = null;
        if (runtimeStatePath) {
            try {
                const rawText = await fs.promises.readFile(runtimeStatePath, 'utf8');
                const parsed = JSON.parse(rawText) as { snapshotPath?: unknown } | null;
                runtimeSnapshotPath = typeof parsed?.snapshotPath === 'string'
                    ? parsed.snapshotPath.trim()
                    : '';
                if (runtimeSnapshotPath) {
                    candidatePaths.add(path.resolve(runtimeSnapshotPath));
                }
            } catch {
                // Ignore runtime-state read errors and fall back to configured snapshot path.
            }
        }

        const existingCandidates = await Promise.all(
            Array.from(candidatePaths).map(async candidatePath => {
                try {
                    const stat = await fs.promises.stat(candidatePath);
                    return {
                        path: path.resolve(candidatePath),
                        mtimeMs: stat.mtimeMs
                    };
                } catch {
                    return null;
                }
            })
        );
        const resolvedExistingCandidates = existingCandidates
            .filter((candidate): candidate is { path: string; mtimeMs: number } => candidate !== null)
            .sort((left, right) => right.mtimeMs - left.mtimeMs);

        const normalizedRuntimeSnapshotPath = runtimeSnapshotPath ? path.resolve(runtimeSnapshotPath) : null;
        if (normalizedRuntimeSnapshotPath) {
            const runtimeCandidate = resolvedExistingCandidates.find(candidate => candidate.path === normalizedRuntimeSnapshotPath);
            if (runtimeCandidate) {
                return runtimeCandidate.path;
            }
        }

        if (resolvedExistingCandidates.length > 0) {
            return resolvedExistingCandidates[0].path;
        }

        if (normalizedRuntimeSnapshotPath) {
            return normalizedRuntimeSnapshotPath;
        }

        return configuredSnapshotPath ? path.resolve(configuredSnapshotPath) : null;
    }

    private beginPendingOperation(kind: PendingOperationKind): void {
        this.pendingOperation = {
            kind,
            startedAt: Date.now(),
            baselineFingerprint: this.lastSnapshotFingerprint
        };
    }

    private resolvePendingOperation(nextFingerprint: string | null): void {
        if (!this.pendingOperation) {
            return;
        }

        if (!nextFingerprint) {
            return;
        }

        if (this.pendingOperation.baselineFingerprint !== nextFingerprint) {
            this.pendingOperation = null;
        }
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

    private async writeAdapterModeRequest(
        requestCode: string,
        context: { elementPath?: string } = {}
    ): Promise<boolean> {
        const t = await getTranslator(this.context.extensionUri);
        const modeRequestPath = this.getAdapterModeRequestPath();
        const requestContextPath = this.getAdapterRequestContextPath();
        if (!modeRequestPath) {
            vscode.window.showWarningMessage(
                t('Form Explorer generated artifacts directory is not configured. Set kotTestToolkit.formExplorer.generatedArtifactsDirectory.')
            );
            return false;
        }

        try {
            await fs.promises.mkdir(path.dirname(modeRequestPath), { recursive: true });
            if (requestContextPath) {
                await fs.promises.writeFile(
                    requestContextPath,
                    `${JSON.stringify({
                        elementPath: typeof context.elementPath === 'string' ? context.elementPath.trim() : ''
                    }, null, 2)}\n`,
                    'utf8'
                );
            }
            await fs.promises.writeFile(modeRequestPath, `${requestCode}\n`, 'utf8');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(t('Failed to write Form Explorer mode request: {0}', message));
            return false;
        }

        return true;
    }

    private async toggleAdapterModeRequest(): Promise<void> {
        const nextMode = this.adapterMode === 'auto' ? 'manual' : 'auto';
        const applied = await this.writeAdapterModeRequest(nextMode);
        if (!applied) {
            return;
        }

        await this.refreshSnapshot(true);
    }

    private async requestAdapterRefresh(): Promise<void> {
        if (this.usesMcp()) { await this.refreshSnapshot(true); return; }
        const applied = await this.writeAdapterModeRequest('refresh');
        if (!applied) {
            return;
        }

        this.beginPendingOperation('refresh');
        await this.postState();
        const previousFingerprint = this.lastSnapshotFingerprint;
        this.lastSnapshotFingerprint = null;
        await this.refreshSnapshot(true);
        if (this.lastSnapshotFingerprint === previousFingerprint) {
            await new Promise(resolve => setTimeout(resolve, 1200));
            this.lastSnapshotFingerprint = null;
            await this.refreshSnapshot(true);
        }
    }

    private async requestTableSnapshotRefresh(elementPath?: string): Promise<void> {
        if (this.usesMcp()) { this.lastError = 'UI table row capture is not verified for this MCP version. Use the snapshot source.'; await this.postState(); return; }
        const normalizedElementPath = typeof elementPath === 'string' && elementPath.trim()
            ? elementPath.trim()
            : (this.selectedElementPath || '');
        if (normalizedElementPath) {
            this.selectedElementPath = normalizedElementPath;
        }

        const applied = await this.writeAdapterModeRequest('table', {
            elementPath: normalizedElementPath
        });
        if (!applied) {
            return;
        }

        this.beginPendingOperation('table');
        await this.postState();
        this.lastSnapshotFingerprint = null;
        await this.refreshSnapshot(true);
    }

    private async requestAdapterLocator(): Promise<void> {
        if (this.usesMcp()) { this.lastError = 'The interactive locator is not available through MCP. Use the snapshot source.'; await this.postState(); return; }
        const applied = await this.writeAdapterModeRequest('locator');
        if (!applied) {
            return;
        }

        this.beginPendingOperation('locator');
        await this.postState();
        this.lastSnapshotFingerprint = null;
        await this.refreshSnapshot(true);
    }

    private async startBridge(options?: StartFormExplorerBridgeCommandOptions): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        const previousError = this.lastError;
        const explicitPreferredInfobasePath = typeof options?.preferredInfobasePath === 'string' && options.preferredInfobasePath.trim()
            ? normalizeInfobaseReference(options.preferredInfobasePath.trim())
            : null;
        await this.refreshStartedInfobaseProcessState();
        if (this.hasTrackedFormExplorerProcesses()) {
            this.pendingOperation = null;
            this.lastError = previousError;
            await this.postState();
            vscode.window.showWarningMessage(
                t('Form Explorer session is still running. Close the current 1C windows first.')
            );
            return;
        }

        this.lastError = null;
        this.beginPendingOperation('start');
        await this.postState();

        try {
            const bridgeResult = await vscode.commands.executeCommand<StartFormExplorerBridgeResult | null>(
                'kotTestToolkit.startFormExplorerBridge',
                {
                    preferredInfobasePath: explicitPreferredInfobasePath,
                    oneCClientExePath: normalizeOneCClientExePath(
                        options?.oneCClientExePath
                        || this.resolveEffectiveLaunchPlatformClientExePath()
                        || ''
                    ) || null
                } as StartFormExplorerBridgeCommandOptions
            );

            if (bridgeResult && bridgeResult.status === 'started' && bridgeResult.targetInfobasePath?.trim()) {
                this.preferredStartInfobasePath = normalizeInfobaseReference(bridgeResult.targetInfobasePath.trim());
                this.preferredStartOneCClientExePath = null;
                this.setTrackedFormExplorerProcesses(
                    typeof bridgeResult.workingProcessId === 'number' && bridgeResult.workingProcessId > 0
                        ? bridgeResult.workingProcessId
                        : null,
                    typeof bridgeResult.startupProcessId === 'number' && bridgeResult.startupProcessId > 0
                        ? bridgeResult.startupProcessId
                        : null
                );
                this.lastSnapshotFingerprint = null;
                await this.refreshSnapshot(true);
                return;
            }

            this.pendingOperation = null;
            this.setTrackedFormExplorerProcesses(null, null);
            this.lastError = bridgeResult?.status === 'error'
                ? bridgeResult.error || t('Failed to start Form Explorer Bridge.')
                : previousError;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.pendingOperation = null;
            this.setTrackedFormExplorerProcesses(null, null);
            this.lastError = t('Failed to start Form Explorer Bridge: {0}', message);
        }

        await this.postState();
    }

    private getEffectiveSnapshotPath(): string | null {
        if (this.usesMcp()) { return null; }
        return this.resolvedSnapshotPath || this.getConfiguredSnapshotPath();
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

    private usesMcp(): boolean {
        const mode = vscode.workspace.getConfiguration('kotTestToolkit.formExplorer').get<string>('source', 'auto');
        return mode === 'mcp' || mode !== 'snapshot' && !!this.mcpSource?.available;
    }

    private async chooseSource(): Promise<void> {
        const items = [
            { label: vscode.l10n.t('Automatic: MCP when supported'), value: 'auto' },
            { label: vscode.l10n.t('Vanessa MCP'), value: 'mcp' },
            { label: vscode.l10n.t('Snapshot bridge'), value: 'snapshot' }
        ];
        const selected = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Form Explorer data source') });
        if (selected) { await vscode.workspace.getConfiguration('kotTestToolkit.formExplorer').update('source', selected.value, vscode.ConfigurationTarget.Workspace); }
    }

    private async chooseClientWindow(): Promise<void> {
        if (this.choosingClientWindow || !this.usesMcp() || !this.mcpSource?.windowControlsAvailable) { return; }
        const source = this.mcpSource; const revision = ++this.snapshotRevision;
        this.invalidateNativeSteps(true);
        const current = () => !!this.panel && this.usesMcp() && source === this.mcpSource && revision === this.snapshotRevision;
        this.choosingClientWindow = true;
        try {
            await this.postState();
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Vanessa: selecting client window…') }, async () => {
                const windows = await source.windows();
                if (!windows || !current()) { return; }
                const title = await vscode.window.showQuickPick([...windows.titles], { title: vscode.l10n.t('Select an internal test-client window'), ignoreFocusOut: true });
                if (!title || !current()) { return; }
                const snapshot = await source.activateWindow(windows, title);
                if (!current()) { return; }
                if (!snapshot) { this.lastError = source.state.message ?? vscode.l10n.t('Could not read the selected client window.'); return; }
                this.latestSnapshot = snapshot; this.snapshotExists = true; this.snapshotMtime = snapshot.generatedAt; this.lastError = null;
                this.lastSnapshotFingerprint = snapshot.generatedAt; this.nativeSteps = { loading: false };
                this.selectedElementPath = snapshot.elements[0]?.path ?? null; this.lastSuggestedStepsFingerprint = null;
                await this.refreshSuggestedSteps(false);
                this.scheduleNativeSteps();
            });
        } catch (error) {
            if (current()) { this.lastError = error instanceof Error ? vscode.l10n.t(error.message) : vscode.l10n.t('Could not read the selected client window.'); }
        } finally { this.choosingClientWindow = false; if (current()) { await this.postState(); } }
    }

    private async refreshMcpSnapshot(force: boolean, isCurrent: () => boolean): Promise<void> {
        this.adapterMode = 'mcp'; this.adapterModeStatePath = null; this.resolvedSnapshotPath = null;
        const refreshed = await this.mcpSource?.refresh(force);
        const snapshot = refreshed ?? this.mcpSource?.cached();
        if (!this.usesMcp() || !isCurrent()) { return; }
        if (!force && snapshot && snapshot === this.latestSnapshot && this.lastError === null) { return; }
        const changedForm = !this.latestSnapshot || !snapshot || formStepContext(this.latestSnapshot, '') !== formStepContext(snapshot, '');
        if (changedForm) { this.invalidateNativeSteps(true); }
        this.latestSnapshot = snapshot ?? null; this.snapshotExists = !!snapshot; this.snapshotMtime = snapshot?.generatedAt ?? null;
        this.lastError = this.mcpSource?.state?.message ?? (snapshot ? null : 'Attach to a ready Vanessa session and connect one test client, then refresh the form.');
        this.lastSnapshotFingerprint = snapshot?.generatedAt ?? null;
        if (snapshot && (!this.selectedElementPath || !this.findElementByPath(snapshot.elements, this.selectedElementPath))) {
            this.selectedElementPath = snapshot.elements[0]?.path ?? null;
        }
        if (!snapshot) { this.suggestedSteps = []; this.suggestedStepsForPath = null; this.lastSuggestedStepsFingerprint = null; }
        else { await this.refreshSuggestedSteps(false); }
        if (!this.usesMcp() || !isCurrent()) { return; }
        if (changedForm || force) { this.scheduleNativeSteps(); }
        await this.postState();
    }

    private async refreshSnapshot(force: boolean): Promise<void> {
        if (this.choosingClientWindow) { return; }
        if (force) { this.invalidateNativeSteps(true); }
        const revision = ++this.snapshotRevision;
        if (this.usesMcp()) { await this.refreshMcpSnapshot(force, () => revision === this.snapshotRevision); return; }
        const current = () => revision === this.snapshotRevision && !this.usesMcp();
        const t = await getTranslator(this.context.extensionUri);
        if (!current()) { return; }
        const startProcessStateChanged = await this.refreshStartedInfobaseProcessState();
        if (!current()) { return; }
        const modeState = await this.readAdapterModeState();
        if (!current()) { return; }
        this.adapterMode = modeState.mode;
        this.adapterModeStatePath = modeState.statePath;
        const snapshotPath = await this.resolveActualSnapshotPath();
        if (!current()) { return; }
        this.resolvedSnapshotPath = snapshotPath;

        if (!snapshotPath) {
            this.snapshotExists = false;
            this.snapshotMtime = null;
            this.latestSnapshot = null;
            this.suggestedSteps = [];
            this.suggestedStepsForPath = null;
            this.suggestedStepsError = null;
            this.lastSuggestedStepsFingerprint = null;
            if (this.pendingOperation?.kind === 'start') {
                this.lastError = null;
                this.lastSnapshotFingerprint = 'waiting-for-started-infobase-snapshot';
                await this.postState();
                return;
            }
            const missingPathFingerprint = `missing-snapshot-path|${modeState.fingerprint || ''}`;
            if (!force && missingPathFingerprint === this.lastSnapshotFingerprint) {
                if (startProcessStateChanged) {
                    await this.postState();
                }
                return;
            }
            this.lastError = t(
                'Form Explorer snapshot path is not configured. Set kotTestToolkit.formExplorer.snapshotPath.'
            );
            this.lastSnapshotFingerprint = missingPathFingerprint;
            await this.postState();
            return;
        }

        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(snapshotPath);
            if (!current()) { return; }
            this.snapshotExists = true;
            this.snapshotMtime = stat.mtime.toISOString();
        } catch {
            if (!current()) { return; }
            this.snapshotExists = false;
            this.snapshotMtime = null;
            this.resetLoadedSnapshotState();
            if (this.pendingOperation?.kind === 'start') {
                this.lastError = null;
                this.lastSnapshotFingerprint = 'waiting-for-started-infobase-snapshot';
                await this.postState();
                return;
            }
            if (!this.hasTrackedFormExplorerProcesses()) {
                this.lastError = null;
                this.adapterMode = 'unknown';
                this.adapterModeStatePath = null;
                this.lastSnapshotFingerprint = `idle-without-snapshot:${snapshotPath}`;
                await this.postState();
                return;
            }
            const missingFileFingerprint = `missing-snapshot-file:${snapshotPath}|${modeState.fingerprint || ''}`;
            if (!force && missingFileFingerprint === this.lastSnapshotFingerprint) {
                if (startProcessStateChanged) {
                    await this.postState();
                }
                return;
            }
            this.lastError = t('Snapshot file not found: {0}', snapshotPath);
            this.lastSnapshotFingerprint = missingFileFingerprint;
            await this.postState();
            return;
        }

        const fingerprint = `${snapshotPath}:${stat.mtimeMs}:${stat.size}|${modeState.fingerprint || ''}`;
        if (!force && fingerprint === this.lastSnapshotFingerprint) {
            if (startProcessStateChanged) {
                await this.postState();
            }
            return;
        }

        try {
            const rawText = await fs.promises.readFile(snapshotPath, 'utf8');
            if (!current()) { return; }
            const parsedSnapshot = parseFormExplorerSnapshotText(rawText);
            const enrichedSnapshot = await enrichFormExplorerSnapshot(parsedSnapshot, snapshotPath);
            if (!current()) { return; }
            this.latestSnapshot = enrichedSnapshot;
            if (this.latestSnapshot) {
                const activeElementPath = this.latestSnapshot.form?.activeElementPath
                    || this.findActiveElementPath(this.latestSnapshot.elements)
                    || this.latestSnapshot.elements[0]?.path
                    || null;
                const selectedElementExists = this.selectedElementPath
                    ? this.findElementByPath(this.latestSnapshot.elements, this.selectedElementPath) !== null
                    : false;
                if (!selectedElementExists) {
                    this.selectedElementPath = activeElementPath;
                }
            }
            this.lastError = null;
            this.lastSnapshotFingerprint = fingerprint;
            this.resolvePendingOperation(fingerprint);
            await this.refreshSuggestedSteps(false);
        } catch (error) {
            if (!current()) { return; }
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = t('Failed to load Form Explorer snapshot from {0}: {1}', snapshotPath, message);
            this.latestSnapshot = null;
            this.suggestedSteps = [];
            this.suggestedStepsForPath = null;
            this.suggestedStepsError = null;
            this.lastSuggestedStepsFingerprint = null;
        }

        if (!current()) { return; }
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
            liveSource: this.usesMcp() ? 'mcp' : 'snapshot',
            windowControlsAvailable: this.usesMcp() && !!this.mcpSource?.windowControlsAvailable,
            choosingClientWindow: this.choosingClientWindow,
            snapshotPath: this.getEffectiveSnapshotPath(),
            snapshotExists: this.snapshotExists,
            snapshotMtime: this.snapshotMtime,
            platforms: this.availablePlatforms,
            launchInfobasePath: this.resolveCurrentLaunchInfobasePath(),
            launchPlatformClientExePath: this.resolveEffectiveLaunchPlatformClientExePath(),
            startedInfobaseClientRunning: this.hasTrackedFormExplorerProcesses(),
            adapterMode: this.adapterMode,
            adapterModeStatePath: this.adapterModeStatePath,
            lastError: this.lastError,
            snapshot: this.latestSnapshot,
            scenarioLanguage: getConfiguredScenarioLanguage(),
            selectedElementPath: this.selectedElementPath,
            suggestedSteps: this.suggestedSteps,
            suggestedStepsForPath: this.suggestedStepsForPath,
            suggestedStepsError: this.suggestedStepsError,
            nativeStepsAvailable: this.usesMcp() && !!this.latestSnapshot && !!this.readNativeSteps,
            nativeSteps: this.nativeSteps,
            pendingOperation: this.pendingOperation?.kind || null
        };
    }

    private async getWebviewHtml(webview: vscode.Webview): Promise<string> {
        const t = await getTranslator(this.context.extensionUri);
        const nonce = getNonce();
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicon.css'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'formExplorer.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'formExplorer.js'));
        const textScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'kotWebviewText.js'));
        const splitScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'kotWebviewSplit.js'));

        const loc = {
            title: t('KOT Form Explorer'),
            refresh: t('Refresh'),
            getTables: t('Get tables'),
            snapshotSource: t('Snapshot'), testClients: t('Test clients'),
            locator: t('Locator'),
            startInfobase: t('Start infobase'),
            infobaseClientRunning: t('Form Explorer session is still running'),
            launchPlatform: t('Platform'),
            defaultLabel: t('Default'),
            moreActions: t('More actions'),
            openSettings: t('Open settings'),
            toggleMode: t('Toggle mode'),
            openSnapshotFile: t('Open snapshot JSON'),
            revealSnapshotFile: t('Reveal snapshot file'),
            elements: t('Elements'),
            formElements: t('Form elements'),
            details: t('Details'),
            selectedElement: t('Selected element'),
            currentForm: t('Current form'),
            resizePanels: t('Resize panels'),
            formAttributes: t('Form attributes'),
            commands: t('Commands'),
            searchPlaceholder: t('Search elements'),
            searchTablesPlaceholder: t('Search tables'),
            waitingForSnapshot: t('Waiting for snapshot'),
            noSnapshotHint: t('The panel reads a universal JSON snapshot file produced by the Form Explorer bridge in the current client session.'),
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
            loadingForm: t('Loading form'),
            updating: t('Updating...'),
            starting: t('Starting...'),
            launchingInfobase: t('Launching infobase'),
            mode: t('Update mode'),
            modeAuto: t('Auto'),
            modeManual: t('Manual'),
            updatingSnapshot: t('Refreshing form snapshot...'),
            loadingTables: t('Loading tables into snapshot...'),
            locatingElement: t('Waiting for locator update...'),
            snapshotPath: t('Snapshot path'),
            showTechnicalItems: t('Show technical items'),
            hideTechnicalItems: t('Hide technical items'),
            showGroups: t('Show form groups'),
            showInvisibleElements: t('Show invisible elements'),
            filterByType: t('Filter by type'),
            showButtons: t('Show buttons'),
            showFields: t('Show fields'),
            showTables: t('Show tables'),
            showDecorations: t('Show decorations'),
            showOtherItems: t('Show other items'),
            technicalInfo: t('Technical info'),
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
            suggestedSteps: t('Suggested steps'),
            formTools: t('MCP form tools'),
            nativeSteps: t('Vanessa steps'),
            collapseGroup: t('Collapse group'),
            expandGroup: t('Expand group'),
            nativeStepsDescription: t('From Vanessa, for the current element in the test client.'),
            readingNativeSteps: t('Reading Vanessa steps…'),
            nativeStepsUnavailable: t('Select a visible field, button or table column to read Vanessa steps.'),
            nativeFormChecks: t('Insert full form checks'),
            suggestedStepsDescription: t('Recommended steps for the selected element from the connected Gherkin steps library.'),
            noSuggestedSteps: t('No suitable steps found for the selected element.'),
            suggestedStepsLoading: t('Preparing step suggestions...'),
            suggestedStepsError: t('Failed to build step suggestions.'),
            copySuggestedStep: t('Copy step'),
            copyStepTemplate: t('Copy template'),
            gherkinTable: t('Gherkin table'),
            gherkinTableDescription: t('Current tabular section snapshot in Gherkin format.'),
            formTables: t('Form tables'),
            formTablesDescription: t('Detected tabular sections from the current form snapshot.'),
            noFormTables: t('No form tables detected in snapshot.'),
            noMatchingTables: t('No tables match the current filter.'),
            copyGherkinTable: t('Copy Gherkin table'),
            copyGherkinStep: t('Copy full step'),
            noTableData: t('No tabular data is available for the selected element.'),
            tableRowsShown: t('Rows shown'),
            tableRowsTotal: t('Rows total'),
            tableRowsTruncated: t('Table is truncated in snapshot.'),
            copied: t('Copied'),
            activeElementNotDetected: t('Active element is not reported in snapshot.'),
            none: t('None')
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
                <button id="sourceBtn" class="toolbar-btn" type="button">${escapeHtml(t('Source'))}</button>
                <button id="clientWindowBtn" class="toolbar-btn" type="button">${escapeHtml(t('Windows'))}</button>
                <button id="modeChip" class="meta-chip compact interactive-chip" type="button" aria-label="${escapeHtml(loc.toggleMode)}">
                    <span class="meta-chip-label meta-chip-label-with-icon">
                        <span class="codicon codicon-arrow-swap" aria-hidden="true"></span>
                        <span>${escapeHtml(loc.mode)}</span>
                    </span>
                    <span id="modeValue" class="meta-chip-value"></span>
                </button>
                <div id="generatedAtChip" class="meta-chip compact generated-at-chip">
                    <span id="generatedAtLabel" class="meta-chip-label">${escapeHtml(loc.generatedAt)}</span>
                    <span id="generatedAtValue" class="meta-chip-value"></span>
                </div>
                <div class="menu-shell launch-split-shell">
                    <div class="split-btn-group">
                        <button id="startInfobaseBtn" class="toolbar-btn" type="button" aria-label="${escapeHtml(loc.startInfobase)}">
                            <span class="codicon codicon-play"></span>
                            <span id="startInfobaseLabel">${escapeHtml(loc.startInfobase)}</span>
                        </button>
                        <button
                            id="launchPlatformBtn"
                            class="toolbar-btn split-menu-btn launch-platform-btn"
                            type="button"
                            aria-haspopup="menu"
                            aria-expanded="false"
                            aria-label="${escapeHtml(loc.launchPlatform)}"
                            title="${escapeHtml(loc.launchPlatform)}"
                        >
                            <span id="launchPlatformLabel" class="platform-selector-label">${escapeHtml(loc.launchPlatform)}</span>
                            <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
                        </button>
                    </div>
                    <div id="launchPlatformMenu" class="menu-popover platform-menu" role="menu" aria-label="${escapeHtml(loc.launchPlatform)}"></div>
                </div>
                <button id="formToolsBtn" class="toolbar-btn" type="button"><span class="codicon codicon-tools"></span> ${escapeHtml(loc.formTools)}</button>
                <div class="menu-shell">
                    <button id="moreActionsBtn" class="toolbar-btn icon-only" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(loc.moreActions)}">
                        <span class="codicon codicon-ellipsis"></span>
                    </button>
                    <div id="moreActionsMenu" class="menu-popover" role="menu">
                        <button class="menu-item" type="button" data-action="refresh-snapshot" role="menuitem">
                            <span class="codicon codicon-refresh"></span> ${escapeHtml(loc.refresh)}
                        </button>
                        <div class="dropdown-separator menu-separator" role="separator"></div>
                        <label class="menu-check" for="showTechnicalTabsInput">
                            <input id="showTechnicalTabsInput" type="checkbox">
                            <span>${escapeHtml(loc.technicalInfo)}</span>
                        </label>
                    </div>
                </div>
            </div>
        </header>

        <section id="alertBanner" class="banner hidden" role="alert">
            <div class="banner-copy">
                <div id="alertText"></div>
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

        <section class="workspace" data-kot-split="before">


            <aside class="panel sidebar-panel">
                <section class="current-form-panel" id="currentFormPanel">
                    <div class="current-form-heading">
                        <p class="section-label current-form-label">${escapeHtml(loc.currentForm)}</p>
                        <div class="current-form-actions">
                            <button id="manualRefreshBtn" class="ghost-btn small view-hidden" type="button">
                                <span class="codicon codicon-refresh"></span> ${escapeHtml(loc.refresh)}
                            </button>
                            <button id="currentFormOpenSourceBtn" class="ghost-btn small view-hidden" type="button" disabled>
                                <span class="codicon codicon-go-to-file"></span> ${escapeHtml(loc.openSourceFile)}
                            </button>
                        </div>
                    </div>
                    <div class="current-form-copy">
                        <button id="formTitleValue" class="window-title-btn" type="button">${escapeHtml(loc.waitingForSnapshot)}</button>
                        <p id="formMetaLine" class="meta-line view-hidden"></p>
                    </div>
                    <button id="fullFormChecksBtn" class="ghost-btn small current-form-checks view-hidden" type="button" data-action="native-form-checks">
                        <span class="codicon codicon-checklist" aria-hidden="true"></span> ${escapeHtml(loc.nativeFormChecks)}
                    </button>
                </section>
                <div class="sidebar-section-head">
                    <p class="section-label">${escapeHtml(loc.formElements)}</p>
                    <span id="elementCountValue" class="count-pill">0</span>
                </div>
                <div class="sidebar-actions">
                    <button id="focusActiveBtn" class="ghost-btn small" type="button">
                        <span class="codicon codicon-target"></span> ${escapeHtml(loc.focusActive)}
                    </button>
                    <button id="locatorBtn" class="ghost-btn small view-hidden" type="button">
                        <span class="codicon codicon-location"></span> ${escapeHtml(loc.locator)}
                    </button>
                </div>
                <div class="search-row">
                    <label id="searchFrame" class="search-frame search-frame-wide">
                        <span class="codicon codicon-search" aria-hidden="true"></span>
                        <input id="searchInput" type="text" class="search-input" placeholder="${escapeHtml(loc.searchPlaceholder)}">
                    </label>
                    <div class="filter-shell filter-shell-inline">
                        <button id="filterMenuBtn" class="toggle-btn small icon-only" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(loc.filters)}">
                            <span class="codicon codicon-settings" aria-hidden="true"></span>
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
                            <label class="menu-check" for="showInvisibleInput">
                                <input id="showInvisibleInput" type="checkbox">
                                <span>${escapeHtml(loc.showInvisibleElements)}</span>
                            </label>
                            <div class="dropdown-separator menu-separator" role="separator"></div>
                            <div class="menu-section-title">${escapeHtml(loc.filterByType)}</div>
                            <label class="menu-check" for="showButtonsInput">
                                <input id="showButtonsInput" type="checkbox">
                                <span>${escapeHtml(loc.showButtons)}</span>
                            </label>
                            <label class="menu-check" for="showFieldsInput">
                                <input id="showFieldsInput" type="checkbox">
                                <span>${escapeHtml(loc.showFields)}</span>
                            </label>
                            <label class="menu-check" for="showTablesInput">
                                <input id="showTablesInput" type="checkbox">
                                <span>${escapeHtml(loc.showTables)}</span>
                            </label>
                            <label class="menu-check" for="showDecorationsInput">
                                <input id="showDecorationsInput" type="checkbox">
                                <span>${escapeHtml(loc.showDecorations)}</span>
                            </label>
                            <label class="menu-check" for="showOtherItemsInput">
                                <input id="showOtherItemsInput" type="checkbox">
                                <span>${escapeHtml(loc.showOtherItems)}</span>
                            </label>
                        </div>
                    </div>
                </div>
                <div id="elementTree" class="scroll-region outline-scroll" role="tree"></div>
            </aside>

            <div class="kot-pane-resizer" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(loc.resizePanels)}" tabindex="0"></div>
            <main class="content">
                <section class="panel tabs-panel">
                    <div id="detailsTabsBar" class="tabs-bar secondary-tabs-bar">
                        <div class="tab-buttons" role="tablist" aria-label="${escapeHtml(loc.selectedElement)}">
                            <button id="tabSelectedBtn" class="tab-btn" type="button" data-tab="selected" role="tab" aria-selected="true">
                                ${escapeHtml(loc.selectedElement)}
                            </button>
                            <button id="tabAttributesBtn" class="tab-btn" type="button" data-tab="attributes" role="tab" aria-selected="false">
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
                        <section class="tab-panel scroll-region is-active" data-tab-panel="selected">
                            <div class="selected-topline">
                                <p class="section-label">${escapeHtml(loc.selectedElement)}</p>
                                <div id="selectedStateRow" class="chip-row compact"></div>
                            </div>
                            <div id="selectedKeyFacts" class="key-facts"></div>
                            <section id="detailsPanel" class="selected-details"></section>
                        </section>
                        <section class="tab-panel scroll-region" data-tab-panel="attributes">
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
    <script nonce="${nonce}" src="${textScriptUri}"></script>
    <script nonce="${nonce}" src="${splitScriptUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
