import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs'; 
import { scanWorkspaceForTests, getScanDirRelativePath } from './workspaceScanner';
import { TestInfo } from './types';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';

// Ключ для хранения пароля в SecretStorage
const EMAIL_PASSWORD_KEY = '1cDriveHelper.emailPassword';

// --- Вспомогательная функция для Nonce ---
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

interface CompletionMarker {
    filePath: string; 
    successContent?: string; 
    checkIntervalMs?: number; 
    timeoutMs?: number; 
}


/**
 * Провайдер для Webview в боковой панели, управляющий переключением тестов и сборкой.
 */
export class PhaseSwitcherProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = '1cDriveHelper.phaseSwitcherView';
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;

    private _testCache: Map<string, TestInfo> | null = null;
    private _isScanning: boolean = false;
    private _cacheDirty: boolean = false;
    private _cacheRefreshPromise: Promise<void> | null = null;
    private _cacheRefreshTimer: NodeJS.Timeout | null = null;
    private _isBuildInProgress: boolean = false;
    private _outputChannel: vscode.OutputChannel | undefined;
    private _langOverride: 'System' | 'English' | 'Русский' = 'System';
    private _ruBundle: Record<string, string> | null = null;
    
    // Этот промис будет хранить состояние первоначального сканирования.
    // Он создается один раз при вызове initializeTestCache.
    public initializationPromise: Promise<void> | null = null;

    // Событие, которое будет генерироваться после обновления _testCache
    private _onDidUpdateTestCache: vscode.EventEmitter<Map<string, TestInfo> | null> = new vscode.EventEmitter<Map<string, TestInfo> | null>();
    public readonly onDidUpdateTestCache: vscode.Event<Map<string, TestInfo> | null> = this._onDidUpdateTestCache.event;

    /**
     * Публичный геттер для доступа к кешу тестов.
     */
    public getTestCache(): Map<string, TestInfo> | null {
        return this._testCache;
    }

    /**
     * Обеспечивает актуальность кеша перед операциями, чувствительными к свежим данным.
     */
    public async ensureFreshTestCache(): Promise<void> {
        await this.initializeTestCache();
        if (this._cacheDirty || this._testCache === null) {
            await this.refreshTestCacheFromDisk('ensureFreshTestCache');
        }
    }

    private shouldTrackUriForCache(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') {
            return false;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        const workspaceRootPath = workspaceFolders[0].uri.fsPath;
        const scanDirPath = path.join(workspaceRootPath, getScanDirRelativePath());
        const normalizedScanDirPath = path.resolve(scanDirPath);
        const normalizedUriPath = path.resolve(uri.fsPath);

        if (!normalizedUriPath.startsWith(normalizedScanDirPath)) {
            return false;
        }

        const lowerPath = normalizedUriPath.toLowerCase();
        const baseName = path.basename(lowerPath);
        if (baseName === 'scen.yaml' || baseName === 'scen.yml') {
            return true;
        }

        // Folder create/rename/delete events may come without file extension.
        return path.extname(lowerPath) === '';
    }

    private parseNestedScenarioNamesFromText(documentText: string): string[] {
        const names: string[] = [];
        const sectionRegex = /ВложенныеСценарии:\s*([\s\S]*?)(?=\n(?![ \t])[А-Яа-яЁёA-Za-z]+:|\n*$)/;
        const match = sectionRegex.exec(documentText);
        if (!match || !match[1]) {
            return names;
        }

        const nameRegex = /^\s*ИмяСценария:\s*"([^"]+)"/gm;
        let nameMatch: RegExpExecArray | null;
        while ((nameMatch = nameRegex.exec(match[1])) !== null) {
            const name = nameMatch[1].trim();
            if (name.length > 0) {
                names.push(name);
            }
        }

        return names;
    }

    private extractScenarioNameAndUid(documentText: string): { name: string | null; uid: string | null } {
        let name: string | null = null;
        let uid: string | null = null;
        const lines = documentText.split(/\r\n|\r|\n/);

        for (const line of lines) {
            if (!name) {
                const nameMatch = line.match(/^\s*Имя:\s*"(.+?)"\s*$/);
                if (nameMatch?.[1]) {
                    name = nameMatch[1].trim();
                }
            }

            if (!uid) {
                const uidMatch = line.match(/^\s*UID:\s*"(.+?)"\s*$/);
                if (uidMatch?.[1]) {
                    uid = uidMatch[1].trim();
                }
            }

            if (name && uid) {
                break;
            }
        }

        return { name, uid };
    }

    private computeRelativePathForScenarioFile(fileUri: vscode.Uri): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return path.dirname(fileUri.fsPath);
        }

        const workspaceRootPath = workspaceFolders[0].uri.fsPath;
        const scanDirPath = path.join(workspaceRootPath, getScanDirRelativePath());
        const parentDirPath = path.dirname(fileUri.fsPath);

        if (parentDirPath.startsWith(scanDirPath)) {
            return path.relative(scanDirPath, parentDirPath).replace(/\\/g, '/');
        }

        return vscode.workspace.asRelativePath(parentDirPath, false);
    }

    private buildTestInfoFromDocument(document: vscode.TextDocument): TestInfo | null {
        const documentText = document.getText();
        const { name, uid } = this.extractScenarioNameAndUid(documentText);
        if (!name) {
            return null;
        }

        const nestedScenarioNames = this.parseNestedScenarioNamesFromText(documentText);
        const defaultsMap = parseScenarioParameterDefaults(documentText);
        const parameters = defaultsMap.size > 0 ? Array.from(defaultsMap.keys()) : undefined;
        const parameterDefaults = defaultsMap.size > 0 ? Object.fromEntries(defaultsMap.entries()) : undefined;

        return {
            name,
            yamlFileUri: document.uri,
            relativePath: this.computeRelativePathForScenarioFile(document.uri),
            parameters,
            parameterDefaults,
            nestedScenarioNames: nestedScenarioNames.length > 0 ? [...new Set(nestedScenarioNames)] : undefined,
            uid: uid || undefined
        };
    }

    private areStringArraysEqual(left?: string[], right?: string[]): boolean {
        if (!left?.length && !right?.length) {
            return true;
        }
        if (!left || !right || left.length !== right.length) {
            return false;
        }
        return left.every((item, index) => item === right[index]);
    }

    private areDefaultsEqual(
        left?: Record<string, string>,
        right?: Record<string, string>
    ): boolean {
        const leftEntries = Object.entries(left || {});
        const rightEntries = Object.entries(right || {});
        if (leftEntries.length !== rightEntries.length) {
            return false;
        }

        const rightMap = new Map(rightEntries);
        for (const [key, value] of leftEntries) {
            if (rightMap.get(key) !== value) {
                return false;
            }
        }
        return true;
    }

    private isSameTestInfo(left: TestInfo, right: TestInfo): boolean {
        return (
            left.name === right.name &&
            left.yamlFileUri.toString() === right.yamlFileUri.toString() &&
            left.relativePath === right.relativePath &&
            (left.uid || '') === (right.uid || '') &&
            this.areStringArraysEqual(left.parameters, right.parameters) &&
            this.areDefaultsEqual(left.parameterDefaults, right.parameterDefaults) &&
            this.areStringArraysEqual(left.nestedScenarioNames, right.nestedScenarioNames) &&
            left.tabName === right.tabName &&
            left.defaultState === right.defaultState &&
            left.order === right.order
        );
    }

    public upsertScenarioCacheEntryFromDocument(document: vscode.TextDocument): boolean {
        if (!this.shouldTrackUriForCache(document.uri)) {
            return false;
        }

        try {
            const updatedInfo = this.buildTestInfoFromDocument(document);
            if (!this._testCache) {
                this._testCache = new Map<string, TestInfo>();
            }

            const uriKey = document.uri.toString();
            let changed = false;

            for (const [cachedName, cachedInfo] of this._testCache) {
                if (cachedInfo.yamlFileUri.toString() === uriKey && (!updatedInfo || cachedName !== updatedInfo.name)) {
                    this._testCache.delete(cachedName);
                    changed = true;
                }
            }

            if (updatedInfo) {
                const existing = this._testCache.get(updatedInfo.name);
                if (!existing || !this.isSameTestInfo(existing, updatedInfo)) {
                    this._testCache.set(updatedInfo.name, updatedInfo);
                    changed = true;
                }
            }

            if (changed) {
                this._onDidUpdateTestCache.fire(this._testCache);
            }

            return true;
        } catch (error) {
            console.error('[PhaseSwitcherProvider] Failed to incrementally update scenario cache entry:', error);
            return false;
        }
    }

    private markCacheDirtyAndScheduleRefresh(reason: string, immediate: boolean = false): void {
        this._cacheDirty = true;
        if (this._cacheRefreshTimer) {
            clearTimeout(this._cacheRefreshTimer);
            this._cacheRefreshTimer = null;
        }

        const delay = immediate ? 0 : 500;
        this._cacheRefreshTimer = setTimeout(() => {
            this.refreshTestCacheFromDisk(reason).catch(error => {
                console.error('[PhaseSwitcherProvider] Scheduled cache refresh failed:', error);
            });
        }, delay);
    }

    private async refreshTestCacheFromDisk(reason: string): Promise<void> {
        if (this._cacheRefreshPromise) {
            await this._cacheRefreshPromise;
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this._testCache = null;
            this._cacheDirty = false;
            this._onDidUpdateTestCache.fire(this._testCache);
            return;
        }

        const workspaceRootUri = workspaceFolders[0].uri;
        console.log(`[PhaseSwitcherProvider] Refreshing test cache from disk. Reason: ${reason}`);

        this._cacheRefreshPromise = (async () => {
            this._isScanning = true;
            try {
                this._testCache = await scanWorkspaceForTests(workspaceRootUri);
                this._cacheDirty = false;
                this._onDidUpdateTestCache.fire(this._testCache);
                console.log(`[PhaseSwitcherProvider] Cache refreshed. Total scenarios: ${this._testCache?.size || 0}`);
            } catch (scanError) {
                console.error('[PhaseSwitcherProvider] Error during cache refresh:', scanError);
            } finally {
                this._isScanning = false;
                this._cacheRefreshPromise = null;
            }
        })();

        await this._cacheRefreshPromise;
    }

    /**
     * Инициализирует кеш тестов. Этот метод теперь идемпотентный:
     * он выполняет сканирование только один раз и возвращает один и тот же промис
     * при последующих вызовах.
     */
    public initializeTestCache(): Promise<void> {
        if (this.initializationPromise) {
            console.log("[PhaseSwitcherProvider:initializeTestCache] Initialization already started or completed.");
            return this.initializationPromise;
        }

        console.log("[PhaseSwitcherProvider:initializeTestCache] Starting initial cache load...");
        // Создаем и сохраняем промис. IIFE (Immediately Invoked Function Expression)
        // немедленно запускает асинхронную операцию.
        this.initializationPromise = (async () => {
            if (this._isScanning) {
                // Эта проверка на всякий случай, с новой логикой она не должна срабатывать.
                console.log("[PhaseSwitcherProvider:initializeTestCache] Scan was already in progress.");
                return;
            }

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                console.log("[PhaseSwitcherProvider:initializeTestCache] No workspace folder, skipping cache initialization.");
                this._testCache = null;
                this._cacheDirty = false;
                this._onDidUpdateTestCache.fire(this._testCache);
                return;
            }

            const workspaceRootUri = workspaceFolders[0].uri;
            this._isScanning = true;
            try {
                this._testCache = await scanWorkspaceForTests(workspaceRootUri);
                this._cacheDirty = false;
                console.log(`[PhaseSwitcherProvider:initializeTestCache] Initial cache loaded with ${this._testCache?.size || 0} scenarios`);
                this._onDidUpdateTestCache.fire(this._testCache);
            } catch (scanError: any) {
                console.error("[PhaseSwitcherProvider:initializeTestCache] Error during initial scan:", scanError);
                this._testCache = null;
                this._cacheDirty = true;
                this._onDidUpdateTestCache.fire(this._testCache);
            } finally {
                this._isScanning = false;
                console.log("[PhaseSwitcherProvider:initializeTestCache] Initial scan finished.");
            }
        })();

        return this.initializationPromise;
    }


    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        console.log("[PhaseSwitcherProvider] Initialized.");
        this._outputChannel = vscode.window.createOutputChannel("1cDrive Test Assembly", { log: true });


        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            // Configuration changes will trigger panel refresh when needed
                if (this._view && this._view.visible) {
                console.log("[PhaseSwitcherProvider] Configuration changed, refreshing panel...");
                    this._sendInitialState(this._view.webview);
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
            if (!this.shouldTrackUriForCache(document.uri)) {
                return;
            }

            const updatedIncrementally = this.upsertScenarioCacheEntryFromDocument(document);
            if (!updatedIncrementally) {
                this.markCacheDirtyAndScheduleRefresh(`save:${path.basename(document.uri.fsPath)}`);
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidCreateFiles(event => {
            if (event.files.some(uri => this.shouldTrackUriForCache(uri))) {
                this.markCacheDirtyAndScheduleRefresh('createFiles');
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidDeleteFiles(event => {
            if (event.files.some(uri => this.shouldTrackUriForCache(uri))) {
                this.markCacheDirtyAndScheduleRefresh('deleteFiles');
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidRenameFiles(event => {
            const affectsCache = event.files.some(({ oldUri, newUri }) =>
                this.shouldTrackUriForCache(oldUri) || this.shouldTrackUriForCache(newUri)
            );
            if (affectsCache) {
                this.markCacheDirtyAndScheduleRefresh('renameFiles');
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this._testCache = null;
            this._cacheDirty = true;
            this.initializationPromise = null;
            this.markCacheDirtyAndScheduleRefresh('workspaceFoldersChanged', true);
        }));

        context.subscriptions.push({
            dispose: () => {
                if (this._cacheRefreshTimer) {
                    clearTimeout(this._cacheRefreshTimer);
                    this._cacheRefreshTimer = null;
                }
            }
        });
    }

    private async loadLocalizationBundleIfNeeded(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('1cDriveHelper.localization');
        const override = (cfg.get<string>('languageOverride') as 'System' | 'English' | 'Русский') || 'System';
        this._langOverride = override;
        if (override === 'Русский') {
            try {
                const ruUri = vscode.Uri.joinPath(this._extensionUri, 'l10n', 'bundle.l10n.ru.json');
                const bytes = await vscode.workspace.fs.readFile(ruUri);
                this._ruBundle = JSON.parse(Buffer.from(bytes).toString('utf-8')) as Record<string, string>;
            } catch (e) {
                console.warn('[PhaseSwitcherProvider] Failed to load RU bundle:', e);
                this._ruBundle = null;
            }
                } else {
            this._ruBundle = null;
        }
    }

    private formatPlaceholders(template: string, args: string[]): string {
        return template.replace(/\{(\d+)\}/g, (m, idx) => {
            const i = Number(idx);
            return i >= 0 && i < args.length ? args[i] : m;
        });
    }

    private t(message: string, ...args: string[]): string {
        if (this._langOverride === 'System') {
            return vscode.l10n.t(message, ...args);
        }
        if (this._langOverride === 'Русский') {
            const translated = (this._ruBundle && this._ruBundle[message]) || message;
            return args.length ? this.formatPlaceholders(translated, args) : translated;
        }
        // en override: return default English and format placeholders
        return args.length ? this.formatPlaceholders(message, args) : message;
    }

    private getOutputChannel(): vscode.OutputChannel {
        if (!this._outputChannel) {
            this._outputChannel = vscode.window.createOutputChannel("1cDrive Test Assembly", { log: true });
        }
        return this._outputChannel;
    }

    /**
     * Публичный метод для принудительного обновления данных панели.
     * Может быть вызван извне, например, после создания нового сценария.
     */
    public async refreshPanelData() {
        if (this._view && this._view.webview && this._view.visible) {
            console.log("[PhaseSwitcherProvider] Refreshing panel data programmatically...");
            this._testCache = null;
            this._cacheDirty = true;
            await this._sendInitialState(this._view.webview);
        } else {
            console.log("[PhaseSwitcherProvider] Panel not visible or not resolved, cannot refresh programmatically yet. Will refresh on next resolve/show.");
            // Можно установить флаг, чтобы _sendInitialState вызвался при следующем resolveWebviewView или onDidChangeVisibility
            this._cacheDirty = true;
        }
    }


    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        context: vscode.WebviewViewResolveContext,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _token: vscode.CancellationToken,
    ) {
        console.log("[PhaseSwitcherProvider] Resolving webview view...");
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'node_modules')
            ]
        };
        // Ждем завершения промиса первоначальной инициализации.
        // Если он еще не был создан, это не страшно (будет null).
        // Если он уже выполняется, мы дождемся его завершения.
        if (this.initializationPromise) {
            console.log("[PhaseSwitcherProvider] Waiting for initial test cache to be ready...");
            await this.initializationPromise;
            console.log("[PhaseSwitcherProvider] Initial test cache is ready.");
        }

        await this.loadLocalizationBundleIfNeeded();
        const nonce = getNonce();
        const styleUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.css'));
        const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.js'));
        const htmlTemplateUri = vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.html');
        const codiconsUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicon.css'));

        try {
            const htmlBytes = await vscode.workspace.fs.readFile(htmlTemplateUri);
            let htmlContent = Buffer.from(htmlBytes).toString('utf-8');
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            htmlContent = htmlContent.replace('${stylesUri}', styleUri.toString());
            htmlContent = htmlContent.replace('${scriptUri}', scriptUri.toString());
            htmlContent = htmlContent.replace('${codiconsUri}', codiconsUri.toString());
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webviewView.webview.cspSource);

            const langOverride = this._langOverride;
            const effectiveLang = langOverride === 'System' ? (vscode.env.language || 'English') : langOverride;
            const localeHtmlLang = effectiveLang.split('-')[0];
            const extDisplayName = this.t('1C:Drive Test Helper');
            const loc = {
                phaseSwitcherTitle: this.t('Phase Switcher'),
                openSettingsTitle: this.t('Open extension settings'),
                createScenarioTitle: this.t('Create scenario'),
                createMainScenario: this.t('Main scenario'),
                createNestedScenario: this.t('Nested scenario'),
                refreshTitle: this.t('Refresh from disk'),
                collapseExpandAllTitle: this.t('Collapse/Expand all phases'),
                toggleAllCheckboxesTitle: this.t('Toggle all checkboxes'),
                loadingPhasesAndTests: this.t('Loading phases and tests...'),
                defaults: this.t('Defaults'),
                apply: this.t('Apply'),
                statusInit: this.t('Status: Initializing...'),
                assemblyTitle: this.t('Assembly'),
                accountingMode: this.t('Accounting mode'),
                createFirstLaunchZipTitle: this.t('Create FirstLaunch archive'),
                buildFL: this.t('Build FL'),
                buildTests: this.t('Build tests'),
                collapsePhaseTitle: this.t('Collapse phase'),
                expandPhaseTitle: this.t('Expand phase'),
                toggleAllInPhaseTitle: this.t('Toggle all tests in this phase'),
                noTestsInPhase: this.t('No tests in this phase.'),
                errorLoadingTests: this.t('Error loading tests.'),
                expandAllPhasesTitle: this.t('Expand all phases'),
                collapseAllPhasesTitle: this.t('Collapse all phases'),
                phaseSwitcherDisabled: this.t('Phase Switcher is disabled in settings.'),
                openScenarioFileTitle: this.t('Open scenario file {0}', '{0}'),
                statusLoadingShort: this.t('Loading...'),
                statusRequestingData: this.t('Requesting data...'),
                statusApplyingPhaseChanges: this.t('Applying phase changes...'),
                statusStartingAssembly: this.t('Starting assembly...'),
                statusBuildingInProgress: this.t('Building tests in progress...'),
                pendingNoChanges: this.t('No pending changes.'),
                pendingTotalChanged: this.t('Total changed: {0}'),
                pendingEnabled: this.t('Enabled: {0}'),
                pendingDisabled: this.t('Disabled: {0}'),
                pendingPressApply: this.t('Press "Apply"'),
                openYamlParametersManagerTitle: this.t('Open Build Scenario Parameters Manager'),
                yamlParameters: this.t('Build Scenario Parameters')
            };

            htmlContent = htmlContent.replace('${localeHtmlLang}', localeHtmlLang);
            htmlContent = htmlContent.replace('${extDisplayName}', extDisplayName);
            for (const [k, v] of Object.entries(loc)) {
                htmlContent = htmlContent.replace(new RegExp(`\\$\\{loc\\.${k}\\}`, 'g'), v);
            }
            htmlContent = htmlContent.replace('${webviewLoc}', JSON.stringify(loc));
            webviewView.webview.html = htmlContent;
            console.log("[PhaseSwitcherProvider] HTML content set from template.");
        } catch (err: any) {
            console.error('[PhaseSwitcher] Error loading interface:', err);
            webviewView.webview.html = `<body>${this.t('Error loading interface: {0}', err.message || err)}</body>`;
        }

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'applyChanges':
                    if (!message.data || typeof message.data !== 'object') {
                        vscode.window.showErrorMessage(this.t('Error: Invalid data received for application.'));
                        this._view?.webview.postMessage({ command: 'updateStatus', text: this.t('Error: invalid data.'), enableControls: true });
                        return;
                    }
                    await this._handleApplyChanges(message.data);
                    return;
                case 'getInitialState': 
                    await this._sendInitialState(webviewView.webview);
                    return;
                case 'refreshData': 
                    this._testCache = null;
                    this._cacheDirty = true;
                    await this._sendInitialState(webviewView.webview);
                    return;
                case 'scanWorkspaceDiagnostics':
                    await vscode.commands.executeCommand('1cDriveHelper.scanWorkspaceDiagnostics');
                    return;
                case 'log':
                    console.log(message.text);
                    return;
                case 'runAssembleScript':
                    const params = message.params || {};
                    const recordGL = typeof params.recordGL === 'string' ? params.recordGL : 'No';
                    await this._handleRunAssembleScriptTypeScript(recordGL);
                    return;
                case 'openScenario':
                    if (message.name && this._testCache) {
                        const testInfo = this._testCache.get(message.name);
                        if (testInfo && testInfo.yamlFileUri) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(testInfo.yamlFileUri);
                                await vscode.window.showTextDocument(doc, { preview: false });
                            } catch (error: any) {
                                console.error(`[PhaseSwitcherProvider] Error opening scenario file: ${error.message || error}`);
                                vscode.window.showErrorMessage(this.t('Failed to open scenario file: {0}', error.message || error));
                            }
                        } else {
                            vscode.window.showWarningMessage(this.t('Scenario "{0}" not found or its path is not defined.', message.name));
                        }
                    }
                    return;
                case 'openSettings':
                    console.log("[PhaseSwitcherProvider] Opening extension settings...");
                    vscode.commands.executeCommand('workbench.action.openSettings', '1cDriveHelper');
                    return;
                case 'createMainScenario':
                    console.log("[PhaseSwitcherProvider] Received createMainScenario command from webview.");
                    vscode.commands.executeCommand('1cDriveHelper.createMainScenario');
                    return;
                case 'createNestedScenario':
                    console.log("[PhaseSwitcherProvider] Received createNestedScenario command from webview.");
                    vscode.commands.executeCommand('1cDriveHelper.createNestedScenario');
                    return;
                case 'createFirstLaunchZip':
                    console.log("[PhaseSwitcherProvider] Received createFirstLaunchZip command from webview.");
                    vscode.commands.executeCommand('1cDriveHelper.createFirstLaunchZip');
                    return;
                case 'openYamlParametersManager':
                    console.log("[PhaseSwitcherProvider] Received openYamlParametersManager command from webview.");
                    vscode.commands.executeCommand('1cDriveHelper.openYamlParametersManager');
                    return;
            }
        }, undefined, this._context.subscriptions);

        // Добавляем обработчик изменения видимости
        webviewView.onDidChangeVisibility(async () => {
            if (webviewView.visible) {
                console.log("[PhaseSwitcherProvider] View became visible. Refreshing state.");
                await this._sendInitialState(webviewView.webview);
            }
        }, null, this._context.subscriptions);


        webviewView.onDidDispose(() => {
            console.log("[PhaseSwitcherProvider] View disposed.");
            this._view = undefined;
        }, null, this._context.subscriptions);

        // Первоначальная загрузка данных при первом разрешении
        if (webviewView.visible) {
            await this._sendInitialState(webviewView.webview);
        }

        console.log("[PhaseSwitcherProvider] Webview resolved successfully.");
    }

    private async _sendInitialState(webview: vscode.Webview) {
        console.log("[PhaseSwitcherProvider:_sendInitialState] Preparing and sending initial state...");
        webview.postMessage({ command: 'updateStatus', text: this.t('Scanning files...'), enableControls: false, refreshButtonEnabled: false });

        // Panels are always enabled now
        const switcherEnabled = true;
        const assemblerEnabled = true;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage(this.t('Please open a project folder.'));
            webview.postMessage({ command: 'loadInitialState', error: this.t('Project folder is not open') });
            webview.postMessage({ command: 'updateStatus', text: this.t('Error: Project folder is not open'), refreshButtonEnabled: true });
            this._testCache = null; 
            this._onDidUpdateTestCache.fire(this._testCache); // Уведомляем об отсутствии данных
            return;
        }
        const workspaceRootUri = workspaceFolders[0].uri;

        // Check if first launch folder exists (independent of test cache)
        const projectPaths = this.getProjectPaths(workspaceRootUri);
        let firstLaunchFolderExists = false;
        try {
            await vscode.workspace.fs.stat(projectPaths.firstLaunchFolder);
            firstLaunchFolderExists = true;
        } catch {
            // Folder doesn't exist
            firstLaunchFolderExists = false;
        }

        // Use existing cache if available, otherwise scan (or refresh stale cache)
        if (this._testCache === null || this._cacheDirty) {
            const reason = this._testCache === null
                ? "cache is empty"
                : "cache marked as dirty";
            console.log(`[PhaseSwitcherProvider:_sendInitialState] Refreshing cache because ${reason}.`);
            try {
                await this.refreshTestCacheFromDisk('_sendInitialState');
            } catch (scanError: any) {
                console.error("[PhaseSwitcherProvider:_sendInitialState] Error during cache refresh:", scanError);
                vscode.window.showErrorMessage(this.t('Error scanning scenario files: {0}', scanError.message || scanError));
                this._testCache = null;
            }
        } else {
            console.log(`[PhaseSwitcherProvider:_sendInitialState] Using existing cache with ${this._testCache.size} scenarios`);
        }


        let states: { [key: string]: 'checked' | 'unchecked' | 'disabled' } = {};
        let status = this.t('Scan error or no tests found');
        let tabDataForUI: { [tabName: string]: TestInfo[] } = {}; // Данные только для UI Phase Switcher
        let checkedCount = 0;
        let testsForPhaseSwitcherCount = 0;


        if (this._testCache) {
            status = this.t('Checking test state...');
            webview.postMessage({ command: 'updateStatus', text: status, refreshButtonEnabled: false });

            const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, getScanDirRelativePath());
            const baseOffDirUri = projectPaths.disabledTestsDirectory;

            const testsForPhaseSwitcherProcessing: TestInfo[] = [];
            this._testCache.forEach(info => {
                // Для Phase Switcher UI используем только тесты, у которых есть tabName
                if (info.tabName && typeof info.tabName === 'string' && info.tabName.trim() !== "") {
                    testsForPhaseSwitcherProcessing.push(info);
                }
            });
            testsForPhaseSwitcherCount = testsForPhaseSwitcherProcessing.length;


            await Promise.all(testsForPhaseSwitcherProcessing.map(async (info) => {
                const onPathTestDir = vscode.Uri.joinPath(baseOnDirUri, info.relativePath, 'test');
                const offPathTestDir = vscode.Uri.joinPath(baseOffDirUri, info.relativePath, 'test');
                let stateResult: 'checked' | 'unchecked' | 'disabled' = 'disabled';

                try { await vscode.workspace.fs.stat(onPathTestDir); stateResult = 'checked'; }
                catch { try { await vscode.workspace.fs.stat(offPathTestDir); stateResult = 'unchecked'; } catch { /* stateResult remains 'disabled' */ } }

                states[info.name] = stateResult;
                if (stateResult === 'checked') {
                    checkedCount++;
                }
            }));
            
            // Группируем и сортируем данные только для тех тестов, что идут в UI
            tabDataForUI = this._groupAndSortTestData(new Map(testsForPhaseSwitcherProcessing.map(info => [info.name, info])));


            status = this.t('State loaded: \n{0} / {1} enabled', String(checkedCount), String(testsForPhaseSwitcherCount));
        } else {
            status = this.t('No tests found or scan error.');
        }

        console.log(`[PhaseSwitcherProvider:_sendInitialState] State check complete. Status: ${status}`);

        webview.postMessage({
            command: 'loadInitialState',
            tabData: tabDataForUI, // Передаем отфильтрованные и сгруппированные данные для UI
            states: states,
            settings: {
                assemblerEnabled: assemblerEnabled,
                switcherEnabled: switcherEnabled,
                firstLaunchFolderExists: firstLaunchFolderExists,
                buildInProgress: this._isBuildInProgress
            },
            error: !this._testCache ? status : undefined // Ошибка, если _testCache пуст
        });
        // Always enable refresh button, but only enable other controls if there are tests and no build is running
        const hasTests = !!this._testCache && testsForPhaseSwitcherCount > 0;
        if (this._isBuildInProgress) {
            webview.postMessage({
                command: 'updateStatus',
                text: this.t('Building tests in progress...'),
                enableControls: false,
                refreshButtonEnabled: false,
                target: 'main'
            });
            webview.postMessage({
                command: 'updateStatus',
                text: this.t('Building tests in progress...'),
                enableControls: false,
                refreshButtonEnabled: false,
                target: 'assemble'
            });
        } else {
            webview.postMessage({ command: 'updateStatus', text: status, enableControls: hasTests });
        }
        
        // Explicitly enable refresh button if there are no tests
        if (!hasTests && !this._isBuildInProgress) {
            webview.postMessage({ command: 'setRefreshButtonState', enabled: true });
        }
        
        // Генерируем событие с ПОЛНЫМ кэшем для других компонентов (например, CompletionProvider)
        this._onDidUpdateTestCache.fire(this._testCache);
    }

    /**
     * Builds 1C:Enterprise startup parameters based on configuration settings
     */
    private buildStartupParams(emptyIbPath: string): string[] {
        const config = vscode.workspace.getConfiguration('1cDriveHelper');
        const startupParameters = config.get<string>('startupParams.parameters') || '/L en /DisableStartupMessages /DisableStartupDialogs';

        const params = [
            "ENTERPRISE",
            `/IBConnectionString`, `"File=${emptyIbPath};"`
        ];

        // Add custom startup parameters (split by space and filter empty strings)
        if (startupParameters.trim()) {
            const customParams = startupParameters.trim().split(/\s+/).filter(p => p.length > 0);
            params.push(...customParams);
            console.log(`[PhaseSwitcherProvider] ${this.t('Using startup parameters: {0}', startupParameters.trim())}`);
        } else {
            console.log(`[PhaseSwitcherProvider] ${this.t('Using default startup parameters')}`);
        }

        return params;
    }

    /**
     * Gets project structure paths from configuration
     */
    private getProjectPaths(workspaceRootUri: vscode.Uri) {
        const config = vscode.workspace.getConfiguration('1cDriveHelper');
        
        const repairTestFileEpfPath = config.get<string>('paths.repairTestFileEpf')?.trim();
        
        return {
            buildScenarioBddEpf: vscode.Uri.joinPath(workspaceRootUri, config.get<string>('paths.buildScenarioBddEpf') || 'build/BuildScenarioBDD.epf'),
            repairTestFileEpf: repairTestFileEpfPath ? vscode.Uri.joinPath(workspaceRootUri, repairTestFileEpfPath) : null,

            yamlSourceDirectory: path.join(workspaceRootUri.fsPath, config.get<string>('paths.yamlSourceDirectory') || 'tests/RegressionTests/yaml'),
            disabledTestsDirectory: vscode.Uri.joinPath(workspaceRootUri, config.get<string>('paths.disabledTestsDirectory') || 'RegressionTests_Disabled/Yaml/Drive'),
            firstLaunchFolder: vscode.Uri.joinPath(workspaceRootUri, config.get<string>('paths.firstLaunchFolder') || 'first_launch'),
            etalonDriveDirectory: 'tests'
        };
    }

    /**
     * Builds BuildScenarioBDD /C command with custom parameters and ErrorFolder
     */
    private buildBuildScenarioBddCommand(jsonParamsPath: string, resultFilePath: string, logFilePath: string, errorFolderPath: string): string {
        // Ensure ErrorFolder path ends with a slash
        const errorFolderWithSlash = errorFolderPath.endsWith(path.sep) ? errorFolderPath : errorFolderPath + path.sep;

        const command = `СобратьСценарии;JsonParams=${jsonParamsPath};ResultFile=${resultFilePath};LogFile=${logFilePath};ErrorFolder=${errorFolderWithSlash}`;

        return `/C"${command}"`;
    }

    /**
     * Ensures BuildErrors folder exists and is empty
     */
    private async prepareBuildErrorsFolder(buildPathUri: vscode.Uri, outputChannel: vscode.OutputChannel): Promise<vscode.Uri> {
        const buildErrorsPathUri = vscode.Uri.joinPath(buildPathUri, 'BuildErrors');
        
        try {
            // Try to stat the directory to see if it exists
            await vscode.workspace.fs.stat(buildErrorsPathUri);
            
            // Directory exists, clear its contents
            outputChannel.appendLine(this.t('Clearing BuildErrors folder: {0}', buildErrorsPathUri.fsPath));
            const existingFiles = await vscode.workspace.fs.readDirectory(buildErrorsPathUri);
            for (const [name, type] of existingFiles) {
                const itemUri = vscode.Uri.joinPath(buildErrorsPathUri, name);
                if (type === vscode.FileType.File) {
                    await vscode.workspace.fs.delete(itemUri);
                } else if (type === vscode.FileType.Directory) {
                    await vscode.workspace.fs.delete(itemUri, { recursive: true });
                }
            }
        } catch (error: any) {
            if (error.code === 'FileNotFound' || error.code === 'ENOENT') {
                // Directory doesn't exist, create it
                outputChannel.appendLine(this.t('Creating BuildErrors folder: {0}', buildErrorsPathUri.fsPath));
                await vscode.workspace.fs.createDirectory(buildErrorsPathUri);
            } else {
                throw error;
            }
        }
        
        return buildErrorsPathUri;
    }

    /**
     * Checks BuildErrors folder for error files and notifies user if errors are found
     * @returns true if errors were found, false if build was successful
     */
    private async checkBuildErrors(buildErrorsPathUri: vscode.Uri, outputChannel: vscode.OutputChannel): Promise<{hasErrors: boolean, junitFileUri?: vscode.Uri, errorCount?: number}> {
        try {
            const errorFiles = await vscode.workspace.fs.readDirectory(buildErrorsPathUri);
            
            if (errorFiles.length === 0) {
                outputChannel.appendLine(this.t('Build completed successfully - no errors found.'));
                return {hasErrors: false}; // No errors found
            }

            // outputChannel.appendLine(this.t('Build errors detected: {0} error files found', errorFiles.length.toString()));

            // Look for JUnit XML files specifically
            const junitFiles = errorFiles.filter(([name, type]) => 
                type === vscode.FileType.File && name.toLowerCase().includes('junit') && name.toLowerCase().endsWith('.xml')
            );

            if (junitFiles.length > 0) {
                // Parse the first JUnit file to check if there are actual failures
                const junitFileName = junitFiles[0][0];
                const junitFileUri = vscode.Uri.joinPath(buildErrorsPathUri, junitFileName);
                
                // Read and check the XML content first
                const junitContent = Buffer.from(await vscode.workspace.fs.readFile(junitFileUri)).toString('utf-8');
                
                // Check if there are any actual failures in the XML
                const testsuiteMatch = junitContent.match(/<testsuites[^>]*failures="(\d+)"[^>]*>/);
                const totalFailures = testsuiteMatch ? parseInt(testsuiteMatch[1], 10) : 0;
                
                if (totalFailures === 0) {
                    // No actual failures, just an empty XML file
                    outputChannel.appendLine(this.t('Build completed successfully - no errors found.'));
                    return {hasErrors: false};
                }
                
                // There are real failures, parse them
                const errorCount = await this.parseAndShowJunitErrors(junitFileUri, outputChannel, false); // Don't show notification here
                return {hasErrors: true, junitFileUri, errorCount}; // Return status, file path, and error count
            } else {
                // Show generic error message for non-JUnit files
                const fileNames = errorFiles.map(([name]) => name).join(', ');
                const errorMessage = this.t('Build failed with errors. Check error files in BuildErrors folder: {0}', fileNames);
                
                vscode.window.showErrorMessage(errorMessage, this.t('Open BuildErrors Folder')).then(selection => {
                    if (selection === this.t('Open BuildErrors Folder')) {
                        vscode.commands.executeCommand('revealFileInOS', buildErrorsPathUri);
                    }
                });
                return {hasErrors: true}; // Errors found but no JUnit file
            }

        } catch (error: any) {
            outputChannel.appendLine(this.t('Error checking build errors: {0}', error.message || error));
            return {hasErrors: false}; // Assume no errors if we can't check
        }
    }

    /**
     * Parses JUnit XML file and shows detailed error information
     */
    private async parseAndShowJunitErrors(junitFileUri: vscode.Uri, outputChannel: vscode.OutputChannel, showNotification: boolean = true): Promise<number> {
        try {
            const junitContent = Buffer.from(await vscode.workspace.fs.readFile(junitFileUri)).toString('utf-8');
            
            // Simple XML parsing to extract failure information
            const failureMatches = junitContent.match(/<failure[^>]*message="([^"]*)"[^>]*>(.*?)<\/failure>/gs);
            
            if (!failureMatches || failureMatches.length === 0) {
                outputChannel.appendLine(this.t('No detailed error information found in JUnit file.'));
                return 0;
            }

            // Extract failed test names and scenario codes
            const failedTests: {testName: string, scenarioCode: string}[] = [];
            const testsuiteMatches = junitContent.match(/<testsuite[^>]*name="([^"]*)"[^>]*failures="[1-9]\d*"[^>]*>/g);
            
            if (testsuiteMatches) {
                for (const testsuiteMatch of testsuiteMatches) {
                    // Extract test name and remove "Компиляция настройки сценария" prefix
                    const nameMatch = testsuiteMatch.match(/name="(?:Компиляция настройки сценария )?([^"]*)"/);
                    if (!nameMatch) continue;
                    
                    const testName = nameMatch[1];
                    
                    // Find the failure element within this testsuite to extract scenario code and error
                    const testsuiteStartIndex = junitContent.indexOf(testsuiteMatch);
                    const testsuiteEndIndex = junitContent.indexOf('</testsuite>', testsuiteStartIndex);
                    const testsuiteContent = junitContent.substring(testsuiteStartIndex, testsuiteEndIndex);
                    
                    // Extract failure message from this specific testsuite
                    const failureMatch = testsuiteContent.match(/<failure[^>]*message="([^"]*)"[^>]*>/);
                    if (failureMatch) {
                        const message = failureMatch[1];
                        
                        // Extract scenario code (Код: <Item>) - look for the last occurrence
                        let scenarioCode = '';
                        const codeMatches = message.match(/Код:\s*&lt;([^&]*)&gt;/g);
                        if (codeMatches && codeMatches.length > 0) {
                            const lastCodeMatch = codeMatches[codeMatches.length - 1].match(/Код:\s*&lt;([^&]*)&gt;/);
                            if (lastCodeMatch) {
                                scenarioCode = lastCodeMatch[1];
                            }
                        }
                        
                        // No need to extract detailed error message - user can check XML file for details
                        
                        failedTests.push({
                            testName,
                            scenarioCode
                        });
                    } else {
                        // Fallback if no detailed failure message found
                        failedTests.push({
                            testName,
                            scenarioCode: ''
                        });
                    }
                }
            }

            if (failedTests.length > 0) {
                outputChannel.appendLine(`  ${this.t('Build failed with {0} compilation error(s):', failedTests.length.toString())}`);
                failedTests.forEach((failedTest, index) => {
                    const scenarioInfo = failedTest.scenarioCode ? ` - Scenario ${failedTest.scenarioCode}` : '';
                    outputChannel.appendLine(`  ${index + 1}. ${failedTest.testName}${scenarioInfo}`);
                });
                
                if (showNotification) {
                    vscode.window.showErrorMessage(
                        this.t('Build failed with {0} compilation errors. Open error file for details.', failedTests.length.toString()),
                        this.t('Open Error File'),
                        this.t('Show Output')
                    ).then(selection => {
                        if (selection === this.t('Open Error File')) {
                            vscode.commands.executeCommand('vscode.open', junitFileUri);
                        } else if (selection === this.t('Show Output')) {
                            outputChannel.show();
                        }
                    });
                }
                
                return failedTests.length;
            }
            
            // If no failed tests found, return 0
            return 0;

        } catch (error: any) {
            outputChannel.appendLine(this.t('Error parsing JUnit file: {0}', error.message || error));
            return 0;
        }
    }

    private async openBuiltFeatureFiles(featureFiles: vscode.Uri[]): Promise<void> {
        if (!featureFiles.length) {
            return;
        }

        if (featureFiles.length === 1) {
            const doc = await vscode.workspace.openTextDocument(featureFiles[0]);
            await vscode.window.showTextDocument(doc, { preview: false });
            return;
        }

        let first = true;
        for (const featureFile of featureFiles) {
            const doc = await vscode.workspace.openTextDocument(featureFile);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: !first });
            first = false;
        }
    }

    private async _handleRunAssembleScriptTypeScript(recordGLValue: string): Promise<void> {
        const methodStartLog = "[PhaseSwitcherProvider:_handleRunAssembleScriptTypeScript]";
        console.log(`${methodStartLog} Starting with RecordGL=${recordGLValue}`);
        const outputChannel = this.getOutputChannel();
        outputChannel.clear();
        
        const config = vscode.workspace.getConfiguration('1cDriveHelper');
        const showOutputPanel = config.get<boolean>('assembleScript.showOutputPanel');

        if (showOutputPanel) {
            outputChannel.show(true);
        }

        const webview = this._view?.webview;
        if (!webview) {
            console.error(`${methodStartLog} Cannot run script, view is not available.`);
            vscode.window.showErrorMessage(this.t('Failed to run assembly: Panel is not active.'));
            return;
        }

        const sendStatus = (text: string, enableControls: boolean = false, target: 'main' | 'assemble' = 'assemble', refreshButtonEnabled?: boolean) => {
            if (this._view?.webview) {
                this._view.webview.postMessage({ 
                    command: 'updateStatus', 
                    text: text, 
                    enableControls: enableControls, 
                    target: target,
                    refreshButtonEnabled: refreshButtonEnabled 
                });
            } else {
                console.warn(`${methodStartLog} Cannot send status, view is not available. Status: ${text}`);
            }
        };
        
        this._isBuildInProgress = true;
        if (this._view?.webview) {
            this._view.webview.postMessage({ command: 'buildStateChanged', inProgress: true });
        }
        sendStatus(this.t('Building tests in progress...'), false, 'assemble', false);

        try {
            await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: this.t('Building .feature files'),
            cancellable: false
        }, async (progress) => {
            let featureFileDirUri: vscode.Uri; // Объявляем здесь, чтобы была доступна в конце
            try {
                progress.report({ increment: 0, message: this.t('Preparing...') });
                outputChannel.appendLine(`[${new Date().toISOString()}] ${this.t('Starting build process...')}`);

                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders?.length) {
                    throw new Error(this.t('Project folder must be opened.'));
                }
                const workspaceRootUri = workspaceFolders[0].uri;
                const workspaceRootPath = workspaceRootUri.fsPath;

                const oneCPath_raw = config.get<string>('paths.oneCEnterpriseExe');
                if (!oneCPath_raw) {
                    sendStatus(this.t('Build error.'), true, 'assemble', true);
                    vscode.window.showErrorMessage(
                        this.t('Path to 1C:Enterprise (1cv8.exe) is not specified in settings.'),
                        this.t('Open Settings')
                    ).then(selection => {
                        if (selection === this.t('Open Settings')) {
                            vscode.commands.executeCommand('workbench.action.openSettings', '1cDriveHelper.paths.oneCEnterpriseExe');
                        }
                    });
                    return;
                }
                if (!fs.existsSync(oneCPath_raw)) {
                    sendStatus(this.t('Build error.'), true, 'assemble', true);
                    vscode.window.showErrorMessage(
                        this.t('1C:Enterprise file (1cv8.exe) not found at path: {0}', oneCPath_raw),
                        this.t('Open Settings')
                    ).then(selection => {
                        if (selection === this.t('Open Settings')) {
                            vscode.commands.executeCommand('workbench.action.openSettings', '1cDriveHelper.paths.oneCEnterpriseExe');
                        }
                    });
                    return;
                }
                const oneCExePath = oneCPath_raw;

                const emptyIbPath_raw = config.get<string>('paths.emptyInfobase');
                if (!emptyIbPath_raw) {
                    sendStatus(this.t('Build error.'), true, 'assemble', true);
                    vscode.window.showErrorMessage(
                        this.t('Path to empty infobase is not specified in settings.'),
                        this.t('Open Settings')
                    ).then(selection => {
                        if (selection === this.t('Open Settings')) {
                            vscode.commands.executeCommand('workbench.action.openSettings', '1cDriveHelper.paths.emptyInfobase');
                        }
                    });
                    return;
                }
                if (!fs.existsSync(emptyIbPath_raw)) {
                    sendStatus(this.t('Build error.'), true, 'assemble', true);
                    vscode.window.showErrorMessage(
                        this.t('Empty infobase directory not found at path: {0}', emptyIbPath_raw),
                        this.t('Open Settings')
                    ).then(selection => {
                        if (selection === this.t('Open Settings')) {
                            vscode.commands.executeCommand('workbench.action.openSettings', '1cDriveHelper.paths.emptyInfobase');
                        }
                    });
                    return;
                }
                
                const buildPathSetting = config.get<string>('assembleScript.buildPath');
                let absoluteBuildPathUri: vscode.Uri;

                if (buildPathSetting && path.isAbsolute(buildPathSetting)) {
                    absoluteBuildPathUri = vscode.Uri.file(buildPathSetting);
                } else {
                    const relativeBuildPath = buildPathSetting || '.vscode/1cdrive_build'; 
                    absoluteBuildPathUri = vscode.Uri.joinPath(workspaceRootUri, relativeBuildPath);
                }
                const absoluteBuildPath = absoluteBuildPathUri.fsPath;
                
                await vscode.workspace.fs.createDirectory(absoluteBuildPathUri);
                outputChannel.appendLine(this.t('Build directory ensured: {0}', absoluteBuildPath));

                progress.report({ increment: 10, message: this.t('Preparing parameters...') });
                const localSettingsPath = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_parameters.json');
                
                // Генерируем yaml_parameters.json из сохранённых параметров через Build Scenario Parameters Manager
                const { YamlParametersManager } = await import('./yamlParametersManager.js');
                const yamlParametersManager = YamlParametersManager.getInstance(this._context);
                await yamlParametersManager.createYamlParametersFile(localSettingsPath.fsPath);
                
                outputChannel.appendLine(this.t('yaml_parameters.json generated at {0}', localSettingsPath.fsPath));

                // Получаем пути проекта
                const projectPaths = this.getProjectPaths(workspaceRootUri);

                progress.report({ increment: 40, message: this.t('Building YAML in feature...') });
                outputChannel.appendLine(this.t('Building YAML files to feature file...'));
                const yamlBuildLogFileUri = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_build_log.txt');
                const yamlBuildResultFileUri = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_build_result.txt');
                const buildScenarioBddEpfPath = projectPaths.buildScenarioBddEpf.fsPath;

                // Prepare BuildErrors folder (create if missing, clear if exists)
                const buildErrorsPathUri = await this.prepareBuildErrorsFolder(absoluteBuildPathUri, outputChannel);

                const yamlBuildParams = [
                    ...this.buildStartupParams(emptyIbPath_raw),
                    `/Execute`, `"${buildScenarioBddEpfPath}"`,
                    this.buildBuildScenarioBddCommand(localSettingsPath.fsPath, yamlBuildResultFileUri.fsPath, yamlBuildLogFileUri.fsPath, buildErrorsPathUri.fsPath)
                ];
                await this.execute1CProcess(oneCExePath, yamlBuildParams, workspaceRootPath, "BuildScenarioBDD.epf", 
                    { filePath: yamlBuildResultFileUri.fsPath, successContent: "0", timeoutMs: 600000 }); 
                
                try {
                    const buildResultContent = Buffer.from(await vscode.workspace.fs.readFile(yamlBuildResultFileUri)).toString('utf-8');
                    if (!buildResultContent.includes("0")) { 
                        const buildLogContent = Buffer.from(await vscode.workspace.fs.readFile(yamlBuildLogFileUri)).toString('utf-8');
                        outputChannel.appendLine("BuildScenarioBDD Error Log:\n" + buildLogContent);
                        throw new Error(this.t('YAML build error. See log: {0}', yamlBuildLogFileUri.fsPath));
                    }
                } catch (e: any) {
                     if (e.code === 'FileNotFound') throw new Error(this.t('Build result file {0} not found after waiting.', yamlBuildResultFileUri.fsPath));
                     throw e; 
                }
                outputChannel.appendLine(this.t('YAML build successful.'));

                progress.report({ increment: 70, message: this.t('Writing parameters...') });
                const vanessaErrorLogsDir = vscode.Uri.joinPath(absoluteBuildPathUri, "vanessa_error_logs");
                await vscode.workspace.fs.createDirectory(vanessaErrorLogsDir);

                outputChannel.appendLine(this.t('Writing parameters from pipeline into tests...'));
                
                // Получаем ModelDBid из параметров YAML для определения правильного пути к сценариям
                const parameters = await yamlParametersManager.loadParameters();
                const modelDBidParam = parameters.find(p => p.key === "ModelDBid");
                const modelDBid = modelDBidParam ? modelDBidParam.value : "EtalonDrive"; // Значение по умолчанию
                
                // Определяем путь к сценариям с учетом ModelDBid
                // Если ModelDBid указан и не пустой, добавляем его к пути
                const etalonDrivePath = modelDBid && modelDBid.trim() !== ""
                    ? path.join(projectPaths.etalonDriveDirectory, modelDBid)
                    : projectPaths.etalonDriveDirectory;
                
                outputChannel.appendLine(this.t('Using ModelDBid: {0}, etalonDrivePath: {1}', modelDBid, etalonDrivePath));
                
                featureFileDirUri = vscode.Uri.joinPath(absoluteBuildPathUri, etalonDrivePath);
                const featureFilesPattern = new vscode.RelativePattern(featureFileDirUri, '**/*.feature');
                const featureFiles = await vscode.workspace.findFiles(featureFilesPattern);
                
                outputChannel.appendLine(this.t('Feature files directory: {0}', featureFileDirUri.fsPath));
                outputChannel.appendLine(this.t('Found {0} feature file(s):', featureFiles.length.toString()));
                featureFiles.forEach((fileUri, index) => {
                    outputChannel.appendLine(`  ${index + 1}. ${path.basename(fileUri.fsPath)}`);
                });



                if (featureFiles.length > 0) {
                    const emailAddr = config.get<string>('params.emailAddress') || '';
                    const emailPass = await this._context.secrets.get(EMAIL_PASSWORD_KEY) || '';
                    const emailIncServer = config.get<string>('params.emailIncomingServer') || '';
                    const emailIncPort = config.get<string>('params.emailIncomingPort') || '';
                    const emailOutServer = config.get<string>('params.emailOutgoingServer') || '';
                    const emailOutPort = config.get<string>('params.emailOutgoingPort') || '';
                    const emailProto = config.get<string>('params.emailProtocol') || '';
                    const azureProjectName = process.env.SYSTEM_TEAM_PROJECT || ''; 

                    for (const fileUri of featureFiles) {
                        let fileContent = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf-8');
                        fileContent = fileContent.replace(/RecordGLAccountsParameterFromPipeline/g, recordGLValue);
                        fileContent = fileContent.replace(/AzureProjectNameParameterFromPipeline/g, azureProjectName);
                        fileContent = fileContent.replace(/EMailTestEmailAddressParameterFromPipeline/g, emailAddr);
                        fileContent = fileContent.replace(/EMailTestPasswordParameterFromPipeline/g, emailPass);
                        fileContent = fileContent.replace(/EMailTestIncomingMailServerParameterFromPipeline/g, emailIncServer);
                        fileContent = fileContent.replace(/EMailTestIncomingMailPortParameterFromPipeline/g, emailIncPort);
                        fileContent = fileContent.replace(/EMailTestOutgoingMailServerParameterFromPipeline/g, emailOutServer);
                        fileContent = fileContent.replace(/EMailTestOutgoingMailPortParameterFromPipeline/g, emailOutPort);
                        fileContent = fileContent.replace(/EMailTestProtocolParameterFromPipeline/g, emailProto);
                        fileContent = fileContent.replace(/DriveTradeParameterFromPipeline/g, 'No');
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fileContent, 'utf-8'));
                    }
                }
                
                progress.report({ increment: 90, message: this.t('Correcting files...') });
                if (projectPaths.repairTestFileEpf) {
                    outputChannel.appendLine(this.t('Starting file repair processing...'));
                    outputChannel.appendLine(this.t('RepairTestFile.epf path: {0}', projectPaths.repairTestFileEpf.fsPath));
                    
                    const filesToRepairRelative = [
                        `${etalonDrivePath}/001_Company_tests.feature`,
                        `${etalonDrivePath}/I_start_my_first_launch.feature`,
                        `${etalonDrivePath}/I_start_my_first_launch_templates.feature`
                    ];
                    
                    outputChannel.appendLine(this.t('Files to repair (relative paths):'));
                    filesToRepairRelative.forEach((filePath, index) => {
                        outputChannel.appendLine(`  ${index + 1}. ${filePath}`);
                    });
                    
                    const repairScriptEpfPath = projectPaths.repairTestFileEpf.fsPath;

                    for (const relativePathSuffix of filesToRepairRelative) {
                        const featureFileToRepairUri = vscode.Uri.joinPath(featureFileDirUri, path.basename(relativePathSuffix));
                        outputChannel.appendLine(this.t('Processing file: {0}', featureFileToRepairUri.fsPath));
                        
                        try {
                            await vscode.workspace.fs.stat(featureFileToRepairUri);
                            outputChannel.appendLine(this.t('  ✓ File found, executing repair...'));
                            
                            const repairParams = [
                                ...this.buildStartupParams(emptyIbPath_raw),
                                `/Execute`, `"${repairScriptEpfPath}"`,
                                `/C"TestFile=${featureFileToRepairUri.fsPath}"`
                            ];
                            await this.execute1CProcess(oneCExePath, repairParams, workspaceRootPath, "RepairTestFile.epf");
                            outputChannel.appendLine(this.t('  ✓ Repair completed successfully'));
                        } catch (error: any) {
                            if (error.code === 'FileNotFound') {
                                outputChannel.appendLine(this.t('  ✗ File not found: {0}', featureFileToRepairUri.fsPath));
                            } else {
                                outputChannel.appendLine(`--- WARNING: Error repairing file ${featureFileToRepairUri.fsPath}: ${error.message || error} ---`);
                            }
                        }
                    }
                } else {
                    outputChannel.appendLine(this.t('Feature file repair processing skipped - RepairTestFile.epf path not configured'));
                }
                
                // Only show repair messages if repairTestFileEpf is configured
                if (projectPaths.repairTestFileEpf) {
                    outputChannel.appendLine(this.t('Starting Administrator replacement processing...'));
                    const companyTestFeaturePath = vscode.Uri.joinPath(featureFileDirUri, '001_Company_tests.feature');
                    outputChannel.appendLine(this.t('Target file path: {0}', companyTestFeaturePath.fsPath));
                    
                    try {
                        await vscode.workspace.fs.stat(companyTestFeaturePath);
                        outputChannel.appendLine(this.t('  ✓ File found, removing "Administrator"...'));
                        
                        const companyTestContentBytes = await vscode.workspace.fs.readFile(companyTestFeaturePath);
                        let companyTestContent = Buffer.from(companyTestContentBytes).toString('utf-8');
        
                        const originalContent = companyTestContent;
                        companyTestContent = companyTestContent.replace(/using "Administrator"/g, 'using ""');
                        
                        if (originalContent !== companyTestContent) {
                            await vscode.workspace.fs.writeFile(companyTestFeaturePath, Buffer.from(companyTestContent, 'utf-8'));
                            outputChannel.appendLine(this.t('  ✓ Administrator replacement completed successfully'));
                        } else {
                            outputChannel.appendLine(this.t('  - No "Administrator" found in file, no changes needed'));
                        }
        
                    } catch (error: any) {
                        if (error.code === 'FileNotFound') {
                            outputChannel.appendLine(this.t('  ✗ File not found: {0}', companyTestFeaturePath.fsPath));
                        } else {
                            outputChannel.appendLine(this.t('--- WARNING: Error applying correction to {0}: {1} ---', companyTestFeaturePath.fsPath, error.message || error));
                        }
                    }
                }

                progress.report({ increment: 95, message: this.t('Checking for build errors...') });
 
                // Log build results summary
                outputChannel.appendLine(`${'='.repeat(60)}`);
                outputChannel.appendLine(`${this.t('Build Results Summary')}`);
                outputChannel.appendLine(`${'='.repeat(60)}`);
                
                // Log successfully built scenarios first
                if (featureFiles.length > 0) {
                    outputChannel.appendLine(`  ${this.t('Successfully built {0} scenario(s):', featureFiles.length.toString())}`);
                    featureFiles.forEach((fileUri, index) => {
                        const fileName = path.basename(fileUri.fsPath, '.feature');
                        outputChannel.appendLine(`  ${index + 1}. ${fileName}`);
                    });
                } else {
                    outputChannel.appendLine(`  ${this.t('No scenarios were built.')}`);
                }
                
                // Check for build errors after showing successes
                const buildResult = await this.checkBuildErrors(buildErrorsPathUri, outputChannel);
                const hasErrors = buildResult.hasErrors;
                const junitFileUri = buildResult.junitFileUri;
                const errorCount = buildResult.errorCount || 0;
                
                progress.report({ increment: 100, message: this.t('Completed!') });
                
                const scenariosBuilt = featureFiles.length > 0;
                const openFeatureButtonLabel = featureFiles.length === 1
                    ? this.t('Open feature file')
                    : this.t('Open feature files');
                
                if (hasErrors && scenariosBuilt) {
                    // Has errors but some scenarios were built
                    outputChannel.appendLine(this.t('Build process completed with errors, but {0} scenario(s) were built.', featureFiles.length.toString()));
                    if (junitFileUri) {
                        outputChannel.appendLine(this.t('For more details, check {0}', junitFileUri.fsPath));
                    }
                    sendStatus(this.t('Build completed with errors.'), true, 'assemble', true);
                    
                    // Prepare buttons based on whether JUnit file is available
                    const buttons = [openFeatureButtonLabel, this.t('Open folder'), this.t('Show Output')];
                    if (junitFileUri) {
                        buttons.push(this.t('Open Error File'));
                    }
                    
                    vscode.window.showWarningMessage(
                        this.t('Build completed: {0} successful, {1} errors.', featureFiles.length.toString(), errorCount.toString()),
                        ...buttons
                    ).then(selection => {
                        if (selection === openFeatureButtonLabel) {
                            this.openBuiltFeatureFiles(featureFiles).catch(error => {
                                console.error('[PhaseSwitcherProvider] Failed to open feature files:', error);
                            });
                        } else if (selection === this.t('Open folder')) {
                            vscode.commands.executeCommand('1cDriveHelper.openBuildFolder', featureFileDirUri.fsPath);
                        } else if (selection === this.t('Show Output')) {
                            outputChannel.show();
                        } else if (selection === this.t('Open Error File') && junitFileUri) {
                            vscode.commands.executeCommand('vscode.open', junitFileUri);
                        }
                    });
                } else if (hasErrors && !scenariosBuilt) {
                    // Has errors and no scenarios built
                    outputChannel.appendLine(this.t('Build process failed - no scenarios were built.'));
                    if (junitFileUri) {
                        outputChannel.appendLine(this.t('For more details, check {0}', junitFileUri.fsPath));
                    }
                    sendStatus(this.t('Build failed - no scenarios built.'), true, 'assemble', true);
                    
                    // Show single simplified notification for complete failure
                    const buttons = [this.t('Show Output')];
                    if (junitFileUri) {
                        buttons.push(this.t('Open Error File'));
                    }
                    
                    vscode.window.showErrorMessage(
                        this.t('Build failed: {0} errors.', errorCount.toString()),
                        ...buttons
                    ).then(selection => {
                        if (selection === this.t('Show Output')) {
                            outputChannel.show();
                        } else if (selection === this.t('Open Error File') && junitFileUri) {
                            vscode.commands.executeCommand('vscode.open', junitFileUri);
                        }
                    });
                } else if (!hasErrors && scenariosBuilt) {
                    // No errors and scenarios built - perfect success
                    outputChannel.appendLine(this.t('Build process completed successfully with {0} scenario(s).', featureFiles.length.toString()));
                    sendStatus(this.t('Tests successfully built.'), true, 'assemble', true); 
                vscode.window.showInformationMessage(
                        this.t('Build completed: {0} successful.', featureFiles.length.toString()),
                        openFeatureButtonLabel,
                        this.t('Open folder')
                ).then(selection => {
                        if (selection === openFeatureButtonLabel) {
                            this.openBuiltFeatureFiles(featureFiles).catch(error => {
                                console.error('[PhaseSwitcherProvider] Failed to open feature files:', error);
                            });
                        } else if (selection === this.t('Open folder')) {
                        vscode.commands.executeCommand('1cDriveHelper.openBuildFolder', featureFileDirUri.fsPath);
                    }
                });
                } else {
                    // No errors but no scenarios built either (strange case)
                    outputChannel.appendLine(this.t('Build process completed but no scenarios were found.'));
                    sendStatus(this.t('Build completed - no scenarios found.'), true, 'assemble', true);
                    vscode.window.showWarningMessage(this.t('Build completed but no scenarios were found.'));
                }

            } catch (error: any) {
                console.error(`${methodStartLog} Error:`, error);
                const errorMessage = error.message || String(error);
                outputChannel.appendLine(`--- ERROR: ${errorMessage} ---`);
                if (error.stack) {
                    outputChannel.appendLine(`Stack: ${error.stack}`);
                }

                const logFileMatch = errorMessage.match(/См\. лог:\s*(.*)/);
                if (logFileMatch && logFileMatch[1]) {
                    const logFilePath = logFileMatch[1].trim();
                    vscode.window.showErrorMessage(this.t('Build error.'), this.t('Open log'))
                        .then(selection => {
                            if (selection === this.t('Open log')) {
                                vscode.workspace.openTextDocument(vscode.Uri.file(logFilePath)).then(doc => {
                                    vscode.window.showTextDocument(doc);
                                });
                            }
                        });
                } else {
                    vscode.window.showErrorMessage(this.t('Build error: {0}. See Output.', errorMessage));
                }
                
                sendStatus(this.t('Build error.'), true, 'assemble', true); 
            }
        });
        } finally {
            this._isBuildInProgress = false;
            if (this._view?.webview) {
                this._view.webview.postMessage({ command: 'buildStateChanged', inProgress: false });
            }
        }
    }

    private async execute1CProcess( 
        exePath: string, 
        args: string[], 
        cwd: string, 
        processName: string,
        completionMarker?: CompletionMarker
    ): Promise<void> {
        const outputChannel = this.getOutputChannel();
        
        if (process.platform === 'darwin' && completionMarker && completionMarker.filePath) {
            try {
                await vscode.workspace.fs.delete(vscode.Uri.file(completionMarker.filePath), { useTrash: false });
                outputChannel.appendLine(`Deleted previous marker file (if existed): ${completionMarker.filePath}`);
            } catch (e: any) {
                if (e.code === 'FileNotFound') {
                    outputChannel.appendLine(`No previous marker file to delete: ${completionMarker.filePath}`);
                } else {
                    outputChannel.appendLine(`Warning: Could not delete marker file ${completionMarker.filePath}: ${e.message}`);
                }
            }
        }

        return new Promise((resolve, reject) => {
            outputChannel.appendLine(`Executing 1C process: ${processName} with args: ${args.join(' ')}`);
            const command = exePath.includes(' ') && !exePath.startsWith('"') ? `"${exePath}"` : exePath;
            
            const child = cp.spawn(command, args, {
                cwd: cwd,
                shell: true, 
                windowsHide: true
            });

            let stdoutData = '';
            let stderrData = '';

            child.stdout?.on('data', (data) => { 
                const strData = data.toString();
                stdoutData += strData;
                outputChannel.append(strData); 
            });
            child.stderr?.on('data', (data) => { 
                const strData = data.toString();
                stderrData += strData;
                outputChannel.append(`STDERR for ${processName}: ${strData}`); 
            });

            child.on('error', (error) => {
                outputChannel.appendLine(`--- ERROR STARTING 1C PROCESS ${processName}: ${error.message} ---`);
                reject(new Error(this.t('Error starting process {0}: {1}', processName, error.message)));
            });

            const handleClose = (code: number | null) => {
                outputChannel.appendLine(`--- 1C Process ${processName} (launcher) finished with exit code ${code} ---`);
                if (code !== 0 && code !== 255) { 
                    reject(new Error(this.t('Process {0} (launcher) finished with code {1}. stderr: {2}', processName, String(code), stderrData)));
                } else {
                    resolve();
                }
            };

            if (process.platform === 'darwin' && completionMarker) {
                outputChannel.appendLine(`macOS detected. Will poll for completion marker: ${completionMarker.filePath}`);
                let pollInterval: NodeJS.Timeout;
                const startTime = Date.now();
                const timeoutMs = completionMarker.timeoutMs || 180000; 
                const checkIntervalMs = completionMarker.checkIntervalMs || 2000; 

                const checkCompletion = async () => {
                    if (Date.now() - startTime > timeoutMs) {
                        clearInterval(pollInterval);
                        outputChannel.appendLine(`--- TIMEOUT waiting for completion marker for ${processName} ---`);
                        reject(new Error(this.t('Timeout waiting for process {0} completion by marker {1}', processName, completionMarker.filePath)));
                        return;
                    }

                    try {
                        await vscode.workspace.fs.stat(vscode.Uri.file(completionMarker.filePath!));
                        outputChannel.appendLine(`Completion marker ${completionMarker.filePath} found for ${processName}.`);
                        
                        if (completionMarker.successContent) {
                            const content = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(completionMarker.filePath!))).toString('utf-8');
                            if (content.includes(completionMarker.successContent)) {
                                outputChannel.appendLine(`Success content "${completionMarker.successContent}" found in marker file.`);
                                clearInterval(pollInterval);
                                resolve();
                            } else {
                                outputChannel.appendLine(`Marker file found, but success content "${completionMarker.successContent}" NOT found. Continuing polling.`);
                            }
                        } else {
                            clearInterval(pollInterval);
                            resolve();
                        }
                    } catch (e: any) {
                        if (e.code === 'FileNotFound') {
                            outputChannel.appendLine(`Polling for ${completionMarker.filePath}... not found yet.`);
                        } else {
                            outputChannel.appendLine(`Error checking marker file ${completionMarker.filePath}: ${e.message}. Continuing polling.`);
                        }
                    }
                };
                child.on('close', (code) => {
                     outputChannel.appendLine(`--- 1C Launcher ${processName} exited with code ${code}. Polling for completion continues... ---`);
                });
                pollInterval = setInterval(checkCompletion, checkIntervalMs);
                checkCompletion(); 

            } else {
                child.on('close', handleClose);
            }
        });
    }

    /**
     * Группирует и сортирует данные тестов для отображения в Phase Switcher.
     * Использует только тесты, у которых есть tabName.
     */
    private _groupAndSortTestData(testCacheForUI: Map<string, TestInfo>): { [tabName: string]: TestInfo[] } {
        const grouped: { [tabName: string]: TestInfo[] } = {};
        if (!testCacheForUI) {
            return grouped;
        }

        for (const info of testCacheForUI.values()) {
            // Убедимся, что tabName существует и является строкой для группировки
            if (info.tabName && typeof info.tabName === 'string' && info.tabName.trim() !== "") {
                let finalUriString = '';
                if (info.yamlFileUri && typeof info.yamlFileUri.toString === 'function') {
                    finalUriString = info.yamlFileUri.toString();
                }
                const infoWithUriString = { ...info, yamlFileUriString: finalUriString };

                if (!grouped[info.tabName]) { grouped[info.tabName] = []; }
                grouped[info.tabName].push(infoWithUriString);
            }
        }

        for (const tabName in grouped) {
            grouped[tabName].sort((a, b) => {
                const orderA = a.order !== undefined ? a.order : Infinity;
                const orderB = b.order !== undefined ? b.order : Infinity;
                if (orderA !== orderB) {
                    return orderA - orderB;
                }
                return a.name.localeCompare(b.name);
            });
        }
        return grouped;
    }

    private async _handleApplyChanges(states: { [testName: string]: boolean }) {
        console.log("[PhaseSwitcherProvider:_handleApplyChanges] Starting...");
        if (!this._view || !this._testCache) { 
            console.warn("[PhaseSwitcherProvider:_handleApplyChanges] View or testCache is not available.");
            return; 
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) { 
            console.warn("[PhaseSwitcherProvider:_handleApplyChanges] No workspace folder open.");
            return; 
        }
        const workspaceRootUri = workspaceFolders[0].uri;

        const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, getScanDirRelativePath());
        const projectPaths = this.getProjectPaths(workspaceRootUri);
        const baseOffDirUri = projectPaths.disabledTestsDirectory;
        


        if (this._view.webview) {
            this._view.webview.postMessage({ command: 'updateStatus', text: this.t('Applying changes...'), enableControls: false, refreshButtonEnabled: false });
        } else {
            console.warn("[PhaseSwitcherProvider:_handleApplyChanges] Cannot send status, webview is not available.");
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: this.t('Applying phase changes...'),
            cancellable: false
        }, async (progress) => {
            let stats = { enabled: 0, disabled: 0, skipped: 0, error: 0 };
            const total = Object.keys(states).length;
            const increment = total > 0 ? 100 / total : 0;

            for (const [name, shouldBeEnabled] of Object.entries(states)) {
                progress.report({ increment: increment , message: this.t('Processing {0}...', name) });

                const info = this._testCache!.get(name);
                // Применяем изменения только для тестов, которые имеют tabName (т.е. управляются через Phase Switcher)
                if (!info || !info.tabName) { 
                    // console.log(`[PhaseSwitcherProvider-v6:_handleApplyChanges] Skipping "${name}" as it's not part of Phase Switcher UI (no tabName).`);
                    stats.skipped++; 
                    continue; 
                }

                const onPathTestDir = vscode.Uri.joinPath(baseOnDirUri, info.relativePath, 'test');
                const offPathTestDir = vscode.Uri.joinPath(baseOffDirUri, info.relativePath, 'test');
                const targetOffDirParent = vscode.Uri.joinPath(baseOffDirUri, info.relativePath);

                let currentState: 'enabled' | 'disabled' | 'missing' = 'missing';
                try { await vscode.workspace.fs.stat(onPathTestDir); currentState = 'enabled'; }
                catch { try { await vscode.workspace.fs.stat(offPathTestDir); currentState = 'disabled'; } catch { /* missing */ } }

                try {
                    if (shouldBeEnabled && currentState === 'disabled') {
                        await vscode.workspace.fs.rename(offPathTestDir, onPathTestDir, { overwrite: true });
                        stats.enabled++;
                    } else if (!shouldBeEnabled && currentState === 'enabled') {
                        try { await vscode.workspace.fs.createDirectory(targetOffDirParent); }
                        catch (dirErr: any) {
                            if (dirErr.code !== 'EEXIST' && dirErr.code !== 'FileExists') {
                                throw dirErr;
                            }
                        }
                        await vscode.workspace.fs.rename(onPathTestDir, offPathTestDir, { overwrite: true });
                        stats.disabled++;
                    } else {
                        stats.skipped++;
                    }
                } catch (moveError: any) {
                    console.error(`[PhaseSwitcherProvider] Error moving test "${name}":`, moveError);
                    vscode.window.showErrorMessage(this.t('Error moving "{0}": {1}', name, moveError.message || moveError));
                    stats.error++;
                }
            }

            const resultMessage = this.t('Enabled: {0}, Disabled: {1}, Skipped: {2}, Errors: {3}', 
                String(stats.enabled), String(stats.disabled), String(stats.skipped), String(stats.error));
            if (stats.error > 0) { vscode.window.showWarningMessage(this.t('Changes applied with errors! {0}', resultMessage)); }
            else if (stats.enabled > 0 || stats.disabled > 0) { vscode.window.showInformationMessage(this.t('Phase changes successfully applied! {0}', resultMessage)); }
            else { vscode.window.showInformationMessage(this.t('Phase changes: nothing to apply. {0}', resultMessage)); }

            if (this._view?.webview) {
                console.log("[PhaseSwitcherProvider] Refreshing state after apply...");
                // _sendInitialState вызовет _onDidUpdateTestCache с полным списком
                await this._sendInitialState(this._view.webview); 
            } else {
                console.warn("[PhaseSwitcherProvider] Cannot refresh state after apply, view is not available.");
            }
        });
    }
}
