import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs'; 
import { scanWorkspaceForTests, SCAN_DIR_RELATIVE_PATH } from './workspaceScanner';
import { TestInfo } from './types';

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
    private _outputChannel: vscode.OutputChannel | undefined;
    private _langOverride: 'System' | 'English' | 'Русский' = 'System';
    private _ruBundle: Record<string, string> | null = null;

    // Событие, которое будет генерироваться после обновления _testCache
    private _onDidUpdateTestCache: vscode.EventEmitter<Map<string, TestInfo> | null> = new vscode.EventEmitter<Map<string, TestInfo> | null>();
    public readonly onDidUpdateTestCache: vscode.Event<Map<string, TestInfo> | null> = this._onDidUpdateTestCache.event;

    /**
     * Публичный геттер для доступа к кешу тестов.
     */
    public getTestCache(): Map<string, TestInfo> | null {
        return this._testCache;
    }


    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        console.log("[PhaseSwitcherProvider] Initialized.");
        this._outputChannel = vscode.window.createOutputChannel("1cDrive Test Assembly", { log: true });


        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            const affectsSwitcher = e.affectsConfiguration('1cDriveHelper.features.enablePhaseSwitcher');
            const affectsAssembler = e.affectsConfiguration('1cDriveHelper.features.enableAssembleTests');

            if (affectsSwitcher || affectsAssembler) {
                console.log("[PhaseSwitcherProvider] Relevant configuration changed.");
                if (this._view && this._view.visible) {
                    console.log("[PhaseSwitcherProvider] View is visible, sending updated state and settings...");
                    this._sendInitialState(this._view.webview);
                } else {
                    console.log("[PhaseSwitcherProvider] View not visible, update will occur on next resolve or activation.");
                }
            }
        }));
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
            await this._sendInitialState(this._view.webview);
        } else {
            console.log("[PhaseSwitcherProvider] Panel not visible or not resolved, cannot refresh programmatically yet. Will refresh on next resolve/show.");
            // Можно установить флаг, чтобы _sendInitialState вызвался при следующем resolveWebviewView или onDidChangeVisibility
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
                pendingNoChanges: this.t('No pending changes.'),
                pendingTotalChanged: this.t('Total changed: {0}'),
                pendingEnabled: this.t('Enabled: {0}'),
                pendingDisabled: this.t('Disabled: {0}'),
                pendingPressApply: this.t('Press "Apply"')
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
                    if (!message.data || !Array.isArray(message.data)) {
                        vscode.window.showErrorMessage(this.t('Error: Invalid data received for application.'));
                        this._view?.webview.postMessage({ command: 'updateStatus', text: this.t('Error: invalid data.'), enableControls: true });
                        return;
                    }
                    await this._handleApplyChanges(message.data);
                    return;
                case 'getInitialState': 
                case 'refreshData': 
                    await this._sendInitialState(webviewView.webview);
                    return;
                case 'log':
                    console.log(message.text);
                    return;
                case 'runAssembleScript':
                    const params = message.params || {};
                    const recordGL = typeof params.recordGL === 'string' ? params.recordGL : 'No';
                    const driveTrade = typeof params.driveTrade === 'string' ? params.driveTrade : '0';
                    await this._handleRunAssembleScriptTypeScript(recordGL, driveTrade);
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
        if (this._isScanning) {
            console.log("[PhaseSwitcherProvider:_sendInitialState] Scan already in progress...");
            webview.postMessage({ command: 'updateStatus', text: this.t('Scanning in progress...') });
            return;
        }
        console.log("[PhaseSwitcherProvider:_sendInitialState] Preparing and sending initial state...");
        webview.postMessage({ command: 'updateStatus', text: this.t('Scanning files...'), enableControls: false, refreshButtonEnabled: false });

        const config = vscode.workspace.getConfiguration('1cDriveHelper.features');
        const switcherEnabled = config.get<boolean>('enablePhaseSwitcher') ?? true;
        const assemblerEnabled = config.get<boolean>('enableAssembleTests') ?? true;

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

        this._isScanning = true;
        try {
            this._testCache = await scanWorkspaceForTests(workspaceRootUri); 
        } catch (scanError: any) {
            console.error("[PhaseSwitcherProvider:_sendInitialState] Error during scanWorkspaceForTests:", scanError);
            vscode.window.showErrorMessage(this.t('Error scanning scenario files: {0}', scanError.message));
            this._testCache = null;
        } finally {
            this._isScanning = false;
        }


        let states: { [key: string]: 'checked' | 'unchecked' | 'disabled' } = {};
        let status = this.t('Scan error or no tests found');
        let tabDataForUI: { [tabName: string]: TestInfo[] } = {}; // Данные только для UI Phase Switcher
        let checkedCount = 0;
        let testsForPhaseSwitcherCount = 0;


        if (this._testCache) {
            status = this.t('Checking test state...');
            webview.postMessage({ command: 'updateStatus', text: status, refreshButtonEnabled: false });

            const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, SCAN_DIR_RELATIVE_PATH);
            const baseOffDirUri = vscode.Uri.joinPath(workspaceRootUri, 'RegressionTests_Disabled', 'Yaml', 'Drive');

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
                switcherEnabled: switcherEnabled
            },
            error: !this._testCache ? status : undefined // Ошибка, если _testCache пуст
        });
        webview.postMessage({ command: 'updateStatus', text: status, enableControls: !!this._testCache && testsForPhaseSwitcherCount > 0, refreshButtonEnabled: true });
        
        // Генерируем событие с ПОЛНЫМ кэшем для других компонентов (например, CompletionProvider)
        this._onDidUpdateTestCache.fire(this._testCache);
    }

    private async _handleRunAssembleScriptTypeScript(recordGLValue: string, driveTradeValue: string): Promise<void> {
        const methodStartLog = "[PhaseSwitcherProvider:_handleRunAssembleScriptTypeScript]";
        console.log(`${methodStartLog} Starting with RecordGL=${recordGLValue}, DriveTrade=${driveTradeValue}`);
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
        
        sendStatus(this.t('Building tests in progress...'), false, 'assemble', false);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: this.t('Building 1C:Drive tests'),
            cancellable: false
        }, async (progress) => {
            let featureFileDirUri: vscode.Uri; // Объявляем здесь, чтобы была доступна в конце
            try {
                progress.report({ increment: 0, message: this.t('Preparing...') });
                outputChannel.appendLine(`[${new Date().toISOString()}] Starting TypeScript YAML build process...`);

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
                outputChannel.appendLine(`Build directory ensured: ${absoluteBuildPath}`);

                progress.report({ increment: 10, message: this.t('Copying parameters...') });
                const localSettingsPath = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_parameters.json');
                const yamlParamsSourcePath = vscode.Uri.joinPath(workspaceRootUri, 'build', 'develop_parallel', 'yaml_parameters.json');
                
                await vscode.workspace.fs.copy(yamlParamsSourcePath, localSettingsPath, { overwrite: true });

                let yamlParamsContent = Buffer.from(await vscode.workspace.fs.readFile(localSettingsPath)).toString('utf-8');
                const buildPathForwardSlash = absoluteBuildPath.replace(/\\/g, '/');
                const sourcesPathForwardSlash = workspaceRootPath.replace(/\\/g, '/');
                
                const vanessaTestFileEnv = process.env.VanessaTestFile; 
                const splitFeatureFilesFromConfig = config.get<boolean>('params.splitFeatureFiles');
                const splitFeatureFilesValue = vanessaTestFileEnv ? "True" : (splitFeatureFilesFromConfig ? "True" : "False");

                yamlParamsContent = yamlParamsContent.replace(/#BuildPath/g, buildPathForwardSlash);
                yamlParamsContent = yamlParamsContent.replace(/#SourcesPath/g, sourcesPathForwardSlash);
                yamlParamsContent = yamlParamsContent.replace(/#SplitFeatureFiles/g, splitFeatureFilesValue);
                await vscode.workspace.fs.writeFile(localSettingsPath, Buffer.from(yamlParamsContent, 'utf-8'));
                outputChannel.appendLine(`yaml_parameters.json prepared at ${localSettingsPath.fsPath}`);

                if (driveTradeValue === '1') {
                    progress.report({ increment: 20, message: this.t('Processing DriveTrade...') });
                    outputChannel.appendLine(`DriveTrade is 1, running CutCodeByTags.epf...`);
                    const cutCodeEpfPath = vscode.Uri.joinPath(workspaceRootUri, 'build', 'DriveTrade', 'CutCodeByTags.epf').fsPath;
                    const errorLogPathForCut = vscode.Uri.joinPath(absoluteBuildPathUri, 'CutTestsByTags_error.log');
                    const cutCodeParams = [
                        "ENTERPRISE",
                        `/IBConnectionString`, `"File=${emptyIbPath_raw};"`,
                        `/L`, `en`, 
                        `/DisableStartupMessages`,
                        `/DisableStartupDialogs`,
                        `/C"Execute;SourceDirectory=${path.join(workspaceRootPath, 'tests', 'RegressionTests', 'yaml')}\\; Extensions=yaml,txt,xml; ErrorFile=${errorLogPathForCut.fsPath}"`,
                        `/Execute${cutCodeEpfPath}`
                    ];
                    await this.execute1CProcess(oneCExePath, cutCodeParams, workspaceRootPath, "CutCodeByTags.epf", 
                        { filePath: errorLogPathForCut.fsPath, successContent: undefined, timeoutMs: 60000 });
                }

                progress.report({ increment: 40, message: this.t('Building YAML in feature...') });
                outputChannel.appendLine(`Building YAML files to feature file...`);
                const yamlBuildLogFileUri = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_build_log.txt');
                const yamlBuildResultFileUri = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_build_result.txt');
                const buildScenarioBddEpfPath = vscode.Uri.joinPath(workspaceRootUri, 'build', 'BuildScenarioBDD.epf').fsPath;

                const yamlBuildParams = [
                    "ENTERPRISE",
                    `/IBConnectionString`, `"File=${emptyIbPath_raw};"`,
                    `/L`, `en`,
                    `/DisableStartupMessages`,
                    `/DisableStartupDialogs`,
                    `/Execute`, `"${buildScenarioBddEpfPath}"`,
                    `/C"СобратьСценарии;JsonParams=${localSettingsPath.fsPath};ResultFile=${yamlBuildResultFileUri.fsPath};LogFile=${yamlBuildLogFileUri.fsPath}"`
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
                outputChannel.appendLine(`YAML build successful.`);

                progress.report({ increment: 70, message: this.t('Writing parameters...') });
                const vanessaErrorLogsDir = vscode.Uri.joinPath(absoluteBuildPathUri, "vanessa_error_logs");
                await vscode.workspace.fs.createDirectory(vanessaErrorLogsDir);

                outputChannel.appendLine(`Writing parameters from pipeline into tests...`);
                featureFileDirUri = vscode.Uri.joinPath(absoluteBuildPathUri, 'tests', 'EtalonDrive');
                const featureFilesPattern = new vscode.RelativePattern(featureFileDirUri, '**/*.feature');
                const featureFiles = await vscode.workspace.findFiles(featureFilesPattern);

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
                        fileContent = fileContent.replace(/DriveTradeParameterFromPipeline/g, driveTradeValue === '1' ? 'Yes' : 'No');
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fileContent, 'utf-8'));
                    }
                }
                
                progress.report({ increment: 90, message: this.t('Correcting files...') });
                outputChannel.appendLine(`Repairing specific feature files...`);
                const filesToRepairRelative = [
                    'tests/EtalonDrive/001_Company_tests.feature',
                    'tests/EtalonDrive/I_start_my_first_launch.feature',
                    'tests/EtalonDrive/I_start_my_first_launch_templates.feature'
                ];
                const repairScriptEpfPath = vscode.Uri.joinPath(workspaceRootUri, 'build', 'RepairTestFile.epf').fsPath;

                for (const relativePathSuffix of filesToRepairRelative) {
                    const featureFileToRepairUri = vscode.Uri.joinPath(featureFileDirUri, path.basename(relativePathSuffix)); 
                    try {
                        await vscode.workspace.fs.stat(featureFileToRepairUri); 
                        const repairParams = ["ENTERPRISE", `/IBConnectionString`, `"File=${emptyIbPath_raw};"`, `/L`, `en`, `/DisableStartupMessages`, `/DisableStartupDialogs`, `/Execute`, `"${repairScriptEpfPath}"`, `/C"TestFile=${featureFileToRepairUri.fsPath}"`];
                        await this.execute1CProcess(oneCExePath, repairParams, workspaceRootPath, "RepairTestFile.epf");
                    } catch (error: any) {
                        if (error.code !== 'FileNotFound') {
                            outputChannel.appendLine(`--- WARNING: Error repairing file ${featureFileToRepairUri.fsPath}: ${error.message || error} ---`);
                        }
                    }
                }
                
                const companyTestFeaturePath = vscode.Uri.joinPath(featureFileDirUri, '001_Company_tests.feature');
                try {
                    outputChannel.appendLine(`Removing "Administrator" from 001_Company_tests...`);
                    await vscode.workspace.fs.stat(companyTestFeaturePath);
                    outputChannel.appendLine(`  - Correcting user in ${companyTestFeaturePath.fsPath}`);
                    const companyTestContentBytes = await vscode.workspace.fs.readFile(companyTestFeaturePath);
                    let companyTestContent = Buffer.from(companyTestContentBytes).toString('utf-8');
    
                    companyTestContent = companyTestContent.replace(/using "Administrator"/g, 'using ""');
                    
                    await vscode.workspace.fs.writeFile(companyTestFeaturePath, Buffer.from(companyTestContent, 'utf-8'));
                    outputChannel.appendLine(`  - Correction applied successfully.`);
    
                } catch (error: any) {
                    if (error.code === 'FileNotFound') {
                        outputChannel.appendLine(`  - Skipped user correction: ${companyTestFeaturePath.fsPath} not found.`);
                    } else {
                        outputChannel.appendLine(`--- WARNING: Error applying correction to ${companyTestFeaturePath.fsPath}: ${error.message || error} ---`);
                    }
                }

                progress.report({ increment: 100, message: this.t('Completed!') });
                outputChannel.appendLine(`TypeScript YAML build process completed successfully.`);
                sendStatus(this.t('Tests successfully built.'), true, 'assemble', true); 
                vscode.window.showInformationMessage(
                    this.t('Tests successfully built.'),
                    this.t('Open folder')
                ).then(selection => {
                    if (selection === this.t('Open folder')) {
                        vscode.commands.executeCommand('1cDriveHelper.openBuildFolder', featureFileDirUri.fsPath);
                    }
                });

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

        const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, SCAN_DIR_RELATIVE_PATH);
        const baseOffDirUri = vscode.Uri.joinPath(workspaceRootUri, 'RegressionTests_Disabled', 'Yaml', 'Drive');

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

            const resultMessage = this.t('Enabled: {0}, Disabled: {1}, Skipped (not in UI): {2}, Errors: {3}', 
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