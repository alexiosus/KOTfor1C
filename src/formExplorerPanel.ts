import * as vscode from 'vscode';
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
import { resolveLauncherInfobaseNameByPath } from './infobasePicker';
import {
    FormExplorerSuggestedStep,
    suggestFormExplorerSteps
} from './formExplorerStepSuggestions';
import { getConfiguredScenarioLanguage, ScenarioLanguage } from './gherkinLanguage';
import type { StartFormExplorerInfobaseResult } from './formExplorerExtensionGenerator';

type AdapterMode = 'auto' | 'manual' | 'unknown';
type PendingOperationKind = 'refresh' | 'table' | 'locator' | 'start';

interface PendingOperationState {
    kind: PendingOperationKind;
    startedAt: number;
    baselineFingerprint: string | null;
}

interface FormExplorerSnapshotCandidate {
    path: string;
    mtime: string | null;
    exists: boolean;
    infobase: string | null;
    infobaseDisplayName: string | null;
}

interface FormExplorerWebviewState {
    snapshotPath: string | null;
    usingCustomSnapshotPath: boolean;
    snapshotExists: boolean;
    snapshotMtime: string | null;
    snapshotCandidates: FormExplorerSnapshotCandidate[];
    selectedSnapshotPath: string | null;
    adapterMode: AdapterMode;
    adapterModeStatePath: string | null;
    lastError: string | null;
    snapshot: FormExplorerSnapshot | null;
    scenarioLanguage: ScenarioLanguage;
    selectedElementPath: string | null;
    suggestedSteps: FormExplorerSuggestedStep[];
    suggestedStepsForPath: string | null;
    suggestedStepsError: string | null;
    pendingOperation: PendingOperationKind | null;
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
const DEFAULT_ADAPTER_REQUEST_CONTEXT_FILE_NAME = 'adapter-request-context.json';

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
    private snapshotCandidates: FormExplorerSnapshotCandidate[] = [];
    private readonly snapshotCandidateMetadataCache = new Map<string, {
        fingerprint: string;
        infobase: string | null;
        infobaseDisplayName: string | null;
    }>();
    private selectedSnapshotPath: string | null = null;
    private pendingSnapshotInfobasePath: string | null = null;
    private adapterMode: AdapterMode = 'unknown';
    private adapterModeStatePath: string | null = null;
    private lastSnapshotFingerprint: string | null = null;
    private selectedElementPath: string | null = null;
    private suggestedSteps: FormExplorerSuggestedStep[] = [];
    private suggestedStepsForPath: string | null = null;
    private suggestedStepsError: string | null = null;
    private lastSuggestedStepsFingerprint: string | null = null;
    private pendingOperation: PendingOperationState | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                const affectsSnapshotPath = event.affectsConfiguration('kotTestToolkit.formExplorer.snapshotPath');
                const affectsRefreshSeconds = event.affectsConfiguration('kotTestToolkit.formExplorer.autoRefreshSeconds');
                const affectsScenarioLanguage = event.affectsConfiguration('kotTestToolkit.editor.newScenarioLanguage');
                if (affectsSnapshotPath || affectsRefreshSeconds || affectsScenarioLanguage) {
                    if (affectsSnapshotPath || affectsRefreshSeconds) {
                        this.restartRefreshTimer();
                    }
                    if (affectsScenarioLanguage) {
                        this.lastSuggestedStepsFingerprint = null;
                    }
                    this.lastSnapshotFingerprint = null;
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

        await this.clearSnapshotsOnPanelOpen();

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

    private async clearSnapshotsOnPanelOpen(): Promise<void> {
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
            this.snapshotCandidateMetadataCache.delete(snapshotPath);
        }

        this.customSnapshotPath = null;
        this.selectedSnapshotPath = null;
        this.pendingSnapshotInfobasePath = null;
        this.latestSnapshot = null;
        this.lastError = null;
        this.snapshotExists = false;
        this.snapshotMtime = null;
        this.snapshotCandidates = [];
        this.lastSnapshotFingerprint = null;
        this.selectedElementPath = null;
        this.suggestedSteps = [];
        this.suggestedStepsForPath = null;
        this.suggestedStepsError = null;
        this.lastSuggestedStepsFingerprint = null;
        this.pendingOperation = null;
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
                this.selectedSnapshotPath = null;
                this.lastSnapshotFingerprint = null;
                await this.refreshSnapshot(true);
                break;
            case 'selectSnapshotPath':
                await this.selectSnapshotPath(message.value);
                break;
            case 'deleteSnapshotPath':
                await this.deleteSnapshotPath(message.value);
                break;
            case 'buildExtension':
                await vscode.commands.executeCommand('kotTestToolkit.buildFormExplorerExtensionCfe');
                break;
            case 'installExtension':
                await vscode.commands.executeCommand('kotTestToolkit.installFormExplorerExtension');
                break;
            case 'startInfobase':
                await this.startInfobase();
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
                await this.requestTableSnapshotRefresh();
                break;
            case 'selectElementPath':
                await this.handleElementSelectionChanged(message.value);
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
        this.selectedSnapshotPath = this.customSnapshotPath;
        this.lastSnapshotFingerprint = null;
        await this.refreshSnapshot(true);
    }

    private async selectSnapshotPath(rawPath: string | undefined): Promise<void> {
        const selectedPath = typeof rawPath === 'string' ? rawPath.trim() : '';
        if (!selectedPath) {
            this.customSnapshotPath = null;
            this.selectedSnapshotPath = null;
            this.lastSnapshotFingerprint = null;
            await this.refreshSnapshot(true);
            return;
        }

        const normalizedPath = path.resolve(selectedPath);
        this.customSnapshotPath = null;
        this.selectedSnapshotPath = normalizedPath;
        this.lastSnapshotFingerprint = null;
        await this.refreshSnapshot(true);
    }

    private async deleteSnapshotPath(rawPath: string | undefined): Promise<void> {
        const targetPath = typeof rawPath === 'string' ? rawPath.trim() : '';
        if (!targetPath) {
            return;
        }

        const normalizedPath = path.resolve(targetPath);
        const t = await getTranslator(this.context.extensionUri);
        try {
            await fs.promises.rm(normalizedPath, { force: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(t('Failed to delete snapshot file: {0}', message));
            return;
        }

        if (this.customSnapshotPath === normalizedPath) {
            this.customSnapshotPath = null;
        }
        if (this.selectedSnapshotPath === normalizedPath) {
            this.selectedSnapshotPath = null;
        }
        this.snapshotCandidateMetadataCache.delete(normalizedPath);
        this.lastSnapshotFingerprint = null;
        await this.refreshSnapshot(true);
    }

    private async collectSnapshotCandidates(): Promise<FormExplorerSnapshotCandidate[]> {
        const candidates = new Map<string, FormExplorerSnapshotCandidate>();

        const addCandidate = async (candidatePath: string | null | undefined): Promise<void> => {
            if (!candidatePath) {
                return;
            }
            const normalizedPath = path.resolve(candidatePath);
            if (candidates.has(normalizedPath)) {
                return;
            }

            try {
                const stat = await fs.promises.stat(normalizedPath);
                const metadata = await this.readSnapshotCandidateMetadata(normalizedPath, stat);
                candidates.set(normalizedPath, {
                    path: normalizedPath,
                    mtime: stat.mtime.toISOString(),
                    exists: true,
                    infobase: metadata.infobase,
                    infobaseDisplayName: metadata.infobaseDisplayName
                });
            } catch {
                candidates.set(normalizedPath, {
                    path: normalizedPath,
                    mtime: null,
                    exists: false,
                    infobase: null,
                    infobaseDisplayName: null
                });
            }
        };

        if (this.customSnapshotPath) {
            await addCandidate(this.customSnapshotPath);
        }

        const configuredPath = this.getConfiguredSnapshotPath();
        if (configuredPath) {
            const normalizedConfiguredPath = path.resolve(configuredPath);
            await addCandidate(normalizedConfiguredPath);

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

                    await addCandidate(path.join(configuredDirectory, entry.name));
                }
            } catch {
                // Ignore directory scan errors and keep explicit candidates only.
            }
        }

        const result = Array.from(candidates.values());
        const candidatePaths = new Set(result.map(candidate => candidate.path));
        for (const cachedPath of this.snapshotCandidateMetadataCache.keys()) {
            if (!candidatePaths.has(cachedPath)) {
                this.snapshotCandidateMetadataCache.delete(cachedPath);
            }
        }
        result.sort((left, right) => {
            const leftMtime = left.mtime ? Date.parse(left.mtime) : 0;
            const rightMtime = right.mtime ? Date.parse(right.mtime) : 0;
            if (rightMtime !== leftMtime) {
                return rightMtime - leftMtime;
            }
            if (left.exists !== right.exists) {
                return left.exists ? -1 : 1;
            }
            return left.path.localeCompare(right.path, undefined, { sensitivity: 'base' });
        });

        return result;
    }

    private async readSnapshotCandidateMetadata(
        snapshotPath: string,
        stat: fs.Stats
    ): Promise<{ infobase: string | null; infobaseDisplayName: string | null }> {
        const fingerprint = `${stat.mtimeMs}:${stat.size}`;
        const cached = this.snapshotCandidateMetadataCache.get(snapshotPath);
        if (cached && cached.fingerprint === fingerprint) {
            return {
                infobase: cached.infobase,
                infobaseDisplayName: cached.infobaseDisplayName
            };
        }

        let infobase: string | null = null;
        let infobaseDisplayName: string | null = null;
        try {
            const rawText = await fs.promises.readFile(snapshotPath, 'utf8');
            const parsedSnapshot = parseFormExplorerSnapshotText(rawText);
            const normalizedInfobase = typeof parsedSnapshot.source?.infobase === 'string'
                ? parsedSnapshot.source.infobase.trim()
                : '';
            infobase = normalizedInfobase || null;
            const snapshotDisplayName = typeof parsedSnapshot.source?.infobaseName === 'string'
                ? parsedSnapshot.source.infobaseName.trim()
                : '';
            if (snapshotDisplayName) {
                infobaseDisplayName = snapshotDisplayName;
            } else if (infobase) {
                const parsedInfobasePath = this.parseInfobasePathFromMarker(infobase);
                if (parsedInfobasePath) {
                    infobaseDisplayName = await resolveLauncherInfobaseNameByPath(parsedInfobasePath);
                }
            }
        } catch {
            infobase = null;
            infobaseDisplayName = null;
        }

        this.snapshotCandidateMetadataCache.set(snapshotPath, {
            fingerprint,
            infobase,
            infobaseDisplayName
        });

        return {
            infobase,
            infobaseDisplayName
        };
    }

    private resolveSnapshotPathFromCandidates(candidates: FormExplorerSnapshotCandidate[]): string | null {
        if (this.pendingSnapshotInfobasePath) {
            const targetInfobasePath = this.normalizePathForCompare(this.pendingSnapshotInfobasePath);
            const matchedCandidate = candidates.find(candidate => {
                if (!candidate.exists || !candidate.infobase) {
                    return false;
                }
                const parsedInfobasePath = this.parseInfobasePathFromMarker(candidate.infobase);
                if (!parsedInfobasePath) {
                    return false;
                }
                return this.normalizePathForCompare(parsedInfobasePath) === targetInfobasePath;
            });
            if (matchedCandidate) {
                this.pendingSnapshotInfobasePath = null;
                this.customSnapshotPath = null;
                this.selectedSnapshotPath = matchedCandidate.path;
                return matchedCandidate.path;
            }

            this.selectedSnapshotPath = null;
            return null;
        }

        if (this.customSnapshotPath) {
            return this.customSnapshotPath;
        }

        if (this.selectedSnapshotPath) {
            const selectedEntry = candidates.find(candidate => candidate.path === this.selectedSnapshotPath);
            if (selectedEntry) {
                return selectedEntry.path;
            }
        }

        const firstExistingCandidate = candidates.find(candidate => candidate.exists);
        if (firstExistingCandidate) {
            this.selectedSnapshotPath = firstExistingCandidate.path;
            return firstExistingCandidate.path;
        }

        const configuredPath = this.getConfiguredSnapshotPath();
        if (configuredPath) {
            const normalizedConfiguredPath = path.resolve(configuredPath);
            this.selectedSnapshotPath = normalizedConfiguredPath;
            return normalizedConfiguredPath;
        }

        this.selectedSnapshotPath = null;
        return null;
    }

    private parseInfobasePathFromMarker(value: string): string | null {
        const match = value.match(/File\s*=\s*("([^"]+)"|([^;]+))/i);
        if (!match) {
            return null;
        }

        const extractedPath = (match[2] || match[3] || '').trim();
        if (!extractedPath) {
            return null;
        }

        return extractedPath.replace(/[\\/]+$/, '');
    }

    private normalizePathForCompare(value: string): string {
        const normalized = path.resolve(value.trim());
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    private resolvePreferredStartInfobasePath(): string | undefined {
        const selectedSnapshotPath = this.getEffectiveSnapshotPath();
        if (!selectedSnapshotPath) {
            return undefined;
        }

        const selectedCandidate = this.snapshotCandidates.find(candidate => candidate.path === selectedSnapshotPath);
        const infobaseMarker = (selectedCandidate?.infobase || '').trim();
        if (!infobaseMarker) {
            return undefined;
        }

        const parsedPath = this.parseInfobasePathFromMarker(infobaseMarker);
        return parsedPath || undefined;
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
        this.lastSuggestedStepsFingerprint = null;
        await this.refreshSuggestedSteps(false);
        await this.postState();
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

    private async refreshSuggestedSteps(force: boolean): Promise<void> {
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
            this.suggestedSteps = await suggestFormExplorerSteps(this.context, snapshot, selectedElement, 12, preferredLanguage);
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

    private async requestTableSnapshotRefresh(): Promise<void> {
        const applied = await this.writeAdapterModeRequest('table', {
            elementPath: this.selectedElementPath || ''
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
        const applied = await this.writeAdapterModeRequest('locator');
        if (!applied) {
            return;
        }

        this.beginPendingOperation('locator');
        await this.postState();
        this.lastSnapshotFingerprint = null;
        await this.refreshSnapshot(true);
    }

    private async startInfobase(): Promise<void> {
        const t = await getTranslator(this.context.extensionUri);
        const previousError = this.lastError;
        this.lastError = null;
        this.beginPendingOperation('start');
        await this.postState();

        try {
            const startResult = await vscode.commands.executeCommand<StartFormExplorerInfobaseResult | string | null>(
                'kotTestToolkit.startFormExplorerInfobase',
                this.resolvePreferredStartInfobasePath()
            );

            if (typeof startResult === 'string' && startResult.trim()) {
                this.pendingSnapshotInfobasePath = path.resolve(startResult.trim());
                this.selectedSnapshotPath = null;
                this.customSnapshotPath = null;
                this.lastSnapshotFingerprint = null;
                await this.refreshSnapshot(true);
                return;
            }

            if (startResult?.status === 'started' && startResult.infobasePath?.trim()) {
                this.pendingSnapshotInfobasePath = path.resolve(startResult.infobasePath.trim());
                this.selectedSnapshotPath = null;
                this.customSnapshotPath = null;
                this.lastSnapshotFingerprint = null;
                await this.refreshSnapshot(true);
                return;
            }

            this.pendingOperation = null;
            this.lastError = startResult?.status === 'error'
                ? startResult.error || t('Failed to start target infobase for Form Explorer.')
                : previousError;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.pendingOperation = null;
            this.lastError = t('Failed to start target infobase for Form Explorer: {0}', message);
        }

        await this.postState();
    }

    private getEffectiveSnapshotPath(): string | null {
        if (this.pendingSnapshotInfobasePath) {
            return null;
        }

        return this.customSnapshotPath || this.selectedSnapshotPath || this.getConfiguredSnapshotPath();
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
        this.snapshotCandidates = await this.collectSnapshotCandidates();
        const snapshotPath = this.resolveSnapshotPathFromCandidates(this.snapshotCandidates);

        if (!snapshotPath) {
            this.snapshotExists = false;
            this.snapshotMtime = null;
            this.latestSnapshot = null;
            this.suggestedSteps = [];
            this.suggestedStepsForPath = null;
            this.suggestedStepsError = null;
            this.lastSuggestedStepsFingerprint = null;
            if (this.pendingSnapshotInfobasePath) {
                this.lastError = null;
                this.lastSnapshotFingerprint = 'waiting-for-started-infobase-snapshot';
                await this.postState();
                return;
            }
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
            this.latestSnapshot = null;
            this.suggestedSteps = [];
            this.suggestedStepsForPath = null;
            this.suggestedStepsError = null;
            this.lastSuggestedStepsFingerprint = null;
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
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = t('Failed to load Form Explorer snapshot from {0}: {1}', snapshotPath, message);
            this.latestSnapshot = null;
            this.suggestedSteps = [];
            this.suggestedStepsForPath = null;
            this.suggestedStepsError = null;
            this.lastSuggestedStepsFingerprint = null;
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
            snapshotCandidates: this.snapshotCandidates,
            selectedSnapshotPath: this.getEffectiveSnapshotPath(),
            adapterMode: this.adapterMode,
            adapterModeStatePath: this.adapterModeStatePath,
            lastError: this.lastError,
            snapshot: this.latestSnapshot,
            scenarioLanguage: getConfiguredScenarioLanguage(),
            selectedElementPath: this.selectedElementPath,
            suggestedSteps: this.suggestedSteps,
            suggestedStepsForPath: this.suggestedStepsForPath,
            suggestedStepsError: this.suggestedStepsError,
            pendingOperation: this.pendingOperation?.kind || null
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
            getTables: t('Get tables'),
            locator: t('Locator'),
            buildExtension: t('Build .cfe'),
            installExtension: t('Install to infobase'),
            startInfobase: t('Start infobase'),
            chooseSnapshotFile: t('Choose snapshot file'),
            useConfiguredPath: t('Use configured path'),
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
            formAttributes: t('Form attributes'),
            commands: t('Commands'),
            searchPlaceholder: t('Search elements'),
            searchTablesPlaceholder: t('Search tables'),
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
            snapshots: t('Snapshots'),
            deleteSnapshot: t('Delete snapshot'),
            selectSnapshot: t('Select snapshot'),
            showTechnicalItems: t('Show technical items'),
            hideTechnicalItems: t('Hide technical items'),
            showGroups: t('Show form groups'),
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
            suggestedSteps: t('Suggested steps'),
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
                <div class="meta-chip compact snapshot-picker">
                    <span class="meta-chip-label">${escapeHtml(loc.snapshots)}</span>
                    <div class="snapshot-picker-controls">
                        <button id="snapshotPickerBtn" class="snapshot-picker-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(loc.selectSnapshot)}"></button>
                        <div id="snapshotMenu" class="snapshot-menu" role="menu" aria-label="${escapeHtml(loc.snapshots)}"></div>
                    </div>
                </div>
                <button id="startInfobaseBtn" class="toolbar-btn" type="button" aria-label="${escapeHtml(loc.startInfobase)}">
                    <span class="codicon codicon-play"></span>
                    <span id="startInfobaseLabel">${escapeHtml(loc.startInfobase)}</span>
                </button>
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
                        <div class="dropdown-separator menu-separator" role="separator"></div>
                        <button class="menu-item" type="button" data-action="build-extension" role="menuitem">
                            <span class="codicon codicon-tools"></span> ${escapeHtml(loc.buildExtension)}
                        </button>
                        <button class="menu-item" type="button" data-action="install-extension" role="menuitem">
                            <span class="codicon codicon-cloud-upload"></span> ${escapeHtml(loc.installExtension)}
                        </button>
                        <div class="dropdown-separator menu-separator" role="separator"></div>
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
                    <button id="manualRefreshBtn" class="ghost-btn small view-hidden" type="button">
                        <span class="codicon codicon-refresh"></span> ${escapeHtml(loc.refresh)}
                    </button>
                    <button id="currentFormOpenSourceBtn" class="ghost-btn small" type="button">
                        <span class="codicon codicon-go-to-file"></span> ${escapeHtml(loc.openSourceFile)}
                    </button>
                </div>
            </section>

            <aside class="panel sidebar-panel">
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
                        </div>
                    </div>
                </div>
                <div id="elementTree" class="scroll-region outline-scroll"></div>
            </aside>

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
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
