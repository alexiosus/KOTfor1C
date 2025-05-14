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


    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        console.log("[PhaseSwitcherProvider] Initialized.");
        // Инициализация OutputChannel
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

    private getOutputChannel(): vscode.OutputChannel {
        if (!this._outputChannel) {
            this._outputChannel = vscode.window.createOutputChannel("1cDrive Test Assembly", { log: true });
        }
        return this._outputChannel;
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
            webviewView.webview.html = htmlContent;
            console.log("[PhaseSwitcherProvider] HTML content set from template.");
        } catch (err: any) {
            console.error("[PhaseSwitcherProvider] Failed to read or process webview HTML template:", err);
            webviewView.webview.html = `<body>Ошибка загрузки интерфейса: ${err.message || err}</body>`;
            return;
        }

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'applyChanges':
                    if (typeof message.states === 'object' && message.states !== null) {
                        await this._handleApplyChanges(message.states);
                    } else {
                        console.error("Invalid states received for applyChanges:", message.states);
                        vscode.window.showErrorMessage("Ошибка: Получены неверные данные для применения.");
                        this._view?.webview.postMessage({ command: 'updateStatus', text: 'Ошибка: неверные данные.', enableControls: true });
                    }
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
                    await this._handleRunAssembleScriptTypeScript(recordGL, driveTrade); // <--- ИЗМЕНЕН ВЫЗОВ
                    return;
                case 'openScenario':
                    if (message.name && this._testCache) {
                        const testInfo = this._testCache.get(message.name);
                        if (testInfo && testInfo.yamlFileUri) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(testInfo.yamlFileUri);
                                await vscode.window.showTextDocument(doc, { preview: false });
                            } catch (error: any) {
                                console.error(`[PhaseSwitcherProvider] Error opening scenario file: ${error}`);
                                vscode.window.showErrorMessage(`Не удалось открыть файл сценария: ${error.message || error}`);
                            }
                        } else {
                            vscode.window.showWarningMessage(`Сценарий "${message.name}" не найден или его путь не определен.`);
                        }
                    }
                    return;
                case 'openSettings':
                    console.log("[PhaseSwitcherProvider] Opening extension settings...");
                    vscode.commands.executeCommand('workbench.action.openSettings', '1cDriveHelper');
                    return;
            }
        }, undefined, this._context.subscriptions);

        webviewView.onDidDispose(() => {
            console.log("[PhaseSwitcherProvider] View disposed.");
            this._view = undefined;
        }, null, this._context.subscriptions);

        console.log("[PhaseSwitcherProvider] Webview resolved successfully.");
    }

    private async _sendInitialState(webview: vscode.Webview) {
        if (this._isScanning) {
            console.log("[PhaseSwitcherProvider:_sendInitialState] Scan already in progress...");
            webview.postMessage({ command: 'updateStatus', text: 'Идет сканирование...' });
            return;
        }
        console.log("[PhaseSwitcherProvider:_sendInitialState] Preparing and sending initial state...");
        webview.postMessage({ command: 'updateStatus', text: 'Сканирование файлов...', enableControls: false });

        const config = vscode.workspace.getConfiguration('1cDriveHelper.features');
        const switcherEnabled = config.get<boolean>('enablePhaseSwitcher') ?? true;
        const assemblerEnabled = config.get<boolean>('enableAssembleTests') ?? true;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage("Пожалуйста, откройте папку проекта.");
            webview.postMessage({ command: 'loadInitialState', error: "Папка проекта не открыта" });
            webview.postMessage({ command: 'updateStatus', text: 'Ошибка: Папка проекта не открыта' });
            return;
        }
        const workspaceRootUri = workspaceFolders[0].uri;

        this._isScanning = true;
        this._testCache = await scanWorkspaceForTests(workspaceRootUri);
        this._isScanning = false;

        let states: { [key: string]: 'checked' | 'unchecked' | 'disabled' } = {};
        let status = "Ошибка сканирования или тесты не найдены";
        let tabData: { [tabName: string]: TestInfo[] } = {};
        let checkedCount = 0;

        if (this._testCache) {
            status = "Проверка состояния тестов...";
            webview.postMessage({ command: 'updateStatus', text: status });

            const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, SCAN_DIR_RELATIVE_PATH);
            const baseOffDirUri = vscode.Uri.joinPath(workspaceRootUri, 'RegressionTests_Disabled', 'Yaml', 'Drive');

            await Promise.all(Array.from(this._testCache.values()).map(async (info) => {
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

            status = `Состояние загружено: \n${checkedCount} / ${this._testCache.size} включено`;
            tabData = this._groupAndSortTestData(this._testCache);
        } else {
            status = "Тесты не найдены или ошибка сканирования.";
        }

        console.log(`[PhaseSwitcherProvider:_sendInitialState] State check complete. Status: ${status}`);

        webview.postMessage({
            command: 'loadInitialState',
            tabData: tabData,
            states: states,
            settings: {
                assemblerEnabled: assemblerEnabled,
                switcherEnabled: switcherEnabled
            },
            error: !this._testCache ? status : undefined
        });
        webview.postMessage({ command: 'updateStatus', text: status, enableControls: !!this._testCache });
    }

    /**
     * Запускает процесс сборки тестов с использованием TypeScript логики.
     * @param recordGLValue Значение для RecordGLAccounts.
     * @param driveTradeValue Значение для DriveTrade (0 или 1).
     */
    private async _handleRunAssembleScriptTypeScript(recordGLValue: string, driveTradeValue: string): Promise<void> {
        const methodStartLog = "[PhaseSwitcherProvider:_handleRunAssembleScriptTypeScript]";
        console.log(`${methodStartLog} Starting with RecordGL=${recordGLValue}, DriveTrade=${driveTradeValue}`);
        const outputChannel = this.getOutputChannel();
        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine(`[${new Date().toISOString()}] Starting TypeScript YAML build process...`);

        const webview = this._view?.webview;
        if (!webview) {
            console.error(`${methodStartLog} Cannot run script, view is not available.`);
            vscode.window.showErrorMessage("Не удалось запустить сборку: панель 1cDrive Helper не активна.");
            return;
        }

        const sendStatus = (text: string, enableControls: boolean = false, target: 'main' | 'assemble' = 'assemble') => {
            if (this._view?.webview) {
                this._view.webview.postMessage({ command: 'updateStatus', text: text, enableControls: enableControls, target: target });
            } else {
                console.warn(`${methodStartLog} Cannot send status, view is not available. Status: ${text}`);
            }
        };
        
        sendStatus(`Сборка тестов в процессе...`, false, 'assemble');

        try {
            // 1. Получаем настройки VS Code и пути
            const config = vscode.workspace.getConfiguration('1cDriveHelper');
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders?.length) {
                throw new Error("Необходимо открыть папку проекта.");
            }
            const workspaceRootUri = workspaceFolders[0].uri;
            const workspaceRootPath = workspaceRootUri.fsPath;

            const oneCPath_raw = config.get<string>('paths.oneCEnterpriseExe');
            if (!oneCPath_raw || !fs.existsSync(oneCPath_raw)) { // Синхронная проверка, т.к. это критично для запуска
                throw new Error(`Путь к 1С (настройка '1cDriveHelper.paths.oneCEnterpriseExe') не указан или файл не найден: ${oneCPath_raw}`);
            }
            const oneCExePath = oneCPath_raw; // Уже проверенный путь

            const emptyIbPath_raw = config.get<string>('paths.emptyInfobase');
            
            // --- ИСПРАВЛЕНИЕ ФОРМИРОВАНИЯ ПУТИ СБОРКИ ---
            const buildPathSetting = config.get<string>('assembleScript.buildPath');
            let absoluteBuildPathUri: vscode.Uri;

            if (buildPathSetting && path.isAbsolute(buildPathSetting)) {
                absoluteBuildPathUri = vscode.Uri.file(buildPathSetting);
                outputChannel.appendLine(`Using absolute build path from settings: ${absoluteBuildPathUri.fsPath}`);
            } else {
                // Если путь не абсолютный или не задан, используем относительный путь от корня рабочей области
                const relativeBuildPath = buildPathSetting || '.vscode/1cdrive_build'; // Значение по умолчанию, если настройка пуста
                absoluteBuildPathUri = vscode.Uri.joinPath(workspaceRootUri, relativeBuildPath);
                outputChannel.appendLine(`Using relative build path: ${relativeBuildPath} from workspace ${workspaceRootPath}, resolved to: ${absoluteBuildPathUri.fsPath}`);
            }
            const absoluteBuildPath = absoluteBuildPathUri.fsPath;
            // --- КОНЕЦ ИСПРАВЛЕНИЯ ---
            
            // Убедимся, что папка сборки существует
            try {
                await vscode.workspace.fs.createDirectory(absoluteBuildPathUri);
                outputChannel.appendLine(`Build directory ensured: ${absoluteBuildPath}`);
            } catch(dirError: any) {
                if (dirError.code !== 'EEXIST' && dirError.code !== 'FileExists') {
                     throw new Error(`Ошибка создания директории сборки ${absoluteBuildPath}: ${dirError.message || dirError}`);
                } else {
                    outputChannel.appendLine(`Build directory already exists: ${absoluteBuildPath}`);
                }
            }


            const pathVanessa = vscode.Uri.joinPath(workspaceRootUri, 'tools', 'vanessa', 'vanessa-automation.epf').fsPath;
            outputChannel.appendLine(`PathVanessa: ${pathVanessa}`);

            // 2. Подготовка yaml_parameters.json
            const localSettingsPath = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_parameters.json');
            const yamlParamsSourcePath = vscode.Uri.joinPath(workspaceRootUri, 'build', 'develop_parallel', 'yaml_parameters.json');
            
            outputChannel.appendLine(`Copying ${yamlParamsSourcePath.fsPath} to ${localSettingsPath.fsPath}`);
            try {
                await vscode.workspace.fs.copy(yamlParamsSourcePath, localSettingsPath, { overwrite: true });
            } catch (copyError: any) {
                 throw new Error(`Ошибка копирования yaml_parameters.json: ${copyError.message || copyError}`);
            }

            let yamlParamsContent = Buffer.from(await vscode.workspace.fs.readFile(localSettingsPath)).toString('utf-8');
            const buildPathForwardSlash = absoluteBuildPath.replace(/\\/g, '/');
            const sourcesPathForwardSlash = workspaceRootPath.replace(/\\/g, '/');
            
            const vanessaTestFileEnv = process.env.VanessaTestFile; 
            const splitFeatureFilesValue = vanessaTestFileEnv ? "True" : (config.get<string>('params.splitFeatureFiles') || "False");


            yamlParamsContent = yamlParamsContent.replace(/#BuildPath/g, buildPathForwardSlash);
            yamlParamsContent = yamlParamsContent.replace(/#SourcesPath/g, sourcesPathForwardSlash);
            yamlParamsContent = yamlParamsContent.replace(/#SplitFeatureFiles/g, splitFeatureFilesValue);
            await vscode.workspace.fs.writeFile(localSettingsPath, Buffer.from(yamlParamsContent, 'utf-8'));
            outputChannel.appendLine(`yaml_parameters.json prepared at ${localSettingsPath.fsPath}`);

            // 3. Условное выполнение CutCodeByTags.epf
            if (driveTradeValue === '1') {
                outputChannel.appendLine(`DriveTrade is 1, running CutCodeByTags.epf...`);
                const cutCodeEpfPath = vscode.Uri.joinPath(workspaceRootUri, 'build', 'DriveTrade', 'CutCodeByTags.epf').fsPath;
                const cutCodeParams = [
                    "ENTERPRISE",
                    `/IBConnectionString`, `"File=${emptyIbPath_raw};"`,
                    `/L`, `en`, 
                    `/DisableStartupMessages`,
                    `/DisableStartupDialogs`,
                    `/C"Execute;SourceDirectory=${path.join(workspaceRootPath, 'tests', 'RegressionTests', 'yaml')}\\; Extensions=yaml,txt,xml; ErrorFile=${path.join(absoluteBuildPath, 'CutTestsByTags_error.log')}"`,
                    `/Execute${cutCodeEpfPath}`
                ];
                await this.execute1CProcess(oneCExePath, cutCodeParams, workspaceRootPath, "CutCodeByTags.epf");
                
                const errorLogPath = vscode.Uri.joinPath(absoluteBuildPathUri, 'CutTestsByTags_error.log');
                try {
                    const errorLogContent = Buffer.from(await vscode.workspace.fs.readFile(errorLogPath)).toString('utf-8');
                    if (errorLogContent.includes("Result: failed") || errorLogContent.includes("The number of start tags is not equal to the number of end tags")) {
                        throw new Error(`Ошибка в CutCodeByTags.epf. См. лог: ${errorLogPath.fsPath}`);
                    }
                } catch (e:any) { 
                    if (e.code !== 'FileNotFound') outputChannel.appendLine(`Warning: Could not read CutTestsByTags_error.log: ${e.message}`);
                }
            }

            // 4. Сборка YAML в Feature файлы (BuildScenarioBDD.epf)
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
            await this.execute1CProcess(oneCExePath, yamlBuildParams, workspaceRootPath, "BuildScenarioBDD.epf");
            
            try {
                const buildResultContent = Buffer.from(await vscode.workspace.fs.readFile(yamlBuildResultFileUri)).toString('utf-8');
                if (!buildResultContent.includes("0")) { 
                    const buildLogContent = Buffer.from(await vscode.workspace.fs.readFile(yamlBuildLogFileUri)).toString('utf-8');
                    outputChannel.appendLine("BuildScenarioBDD Error Log:\n" + buildLogContent);
                    throw new Error(`Ошибка сборки YAML. См. лог: ${yamlBuildLogFileUri.fsPath}`);
                }
            } catch (e: any) {
                 if (e.code === 'FileNotFound') throw new Error(`Файл результата сборки ${yamlBuildResultFileUri.fsPath} не найден.`);
                 throw e; 
            }
            outputChannel.appendLine(`YAML build successful.`);

            const vanessaErrorLogsDir = vscode.Uri.joinPath(absoluteBuildPathUri, "vanessa_error_logs");
            try { await vscode.workspace.fs.createDirectory(vanessaErrorLogsDir); } catch (e:any) { if(e.code !== 'EEXIST' && e.code !== 'FileExists') throw e;}

            // 5. Замена параметров в .feature файлах
            outputChannel.appendLine(`Writing parameters from pipeline into tests...`);
            const featureFileDirUri = vscode.Uri.joinPath(absoluteBuildPathUri, 'tests', 'EtalonDrive');
            const featureFilesPattern = new vscode.RelativePattern(featureFileDirUri, '**/*.feature');
            const featureFiles = await vscode.workspace.findFiles(featureFilesPattern);

            if (featureFiles.length === 0) {
                outputChannel.appendLine(`WARNING: No .feature files found in ${featureFileDirUri.fsPath}, skipping replacement.`);
            } else {
                const emailAddr = config.get<string>('params.emailAddress') || '';
                const emailPass = await this._context.secrets.get(EMAIL_PASSWORD_KEY) || '';
                const emailIncServer = config.get<string>('params.emailIncomingServer') || '';
                const emailIncPort = config.get<string>('params.emailIncomingPort') || '';
                const emailOutServer = config.get<string>('params.emailOutgoingServer') || '';
                const emailOutPort = config.get<string>('params.emailOutgoingPort') || '';
                const emailProto = config.get<string>('params.emailProtocol') || '';
                const azureProjectName = process.env.SYSTEM_TEAM_PROJECT || ''; 

                for (const fileUri of featureFiles) {
                    outputChannel.appendLine(`  Processing feature file: "${fileUri.fsPath}"`);
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
                outputChannel.appendLine(`  Finished writing parameters from pipeline into tests.`);
            }
            
            // 6. "Ремонт" специфичных feature файлов
            outputChannel.appendLine(`Repairing specific feature files...`);
            const filesToRepairRelative = [
                'tests/EtalonDrive/001_Company_tests.feature',
                'tests/EtalonDrive/I_start_my_first_launch.feature',
                'tests/EtalonDrive/I_start_my_first_launch_templates.feature'
            ];
            const repairScriptEpfPath = vscode.Uri.joinPath(workspaceRootUri, 'build', 'RepairTestFile.epf').fsPath;

            for (const relativePathSuffix of filesToRepairRelative) {
                const featureFileToRepairUri = vscode.Uri.joinPath(featureFileDirUri, path.basename(relativePathSuffix)); // Строим путь от featureFileDirUri
                outputChannel.appendLine(`Checking for ${featureFileToRepairUri.fsPath}`);
                try {
                    await vscode.workspace.fs.stat(featureFileToRepairUri); 
                    outputChannel.appendLine(`  Found. Repairing ${featureFileToRepairUri.fsPath}`);
                    const repairParams = [
                        "ENTERPRISE",
                        `/IBConnectionString`, `"File=${emptyIbPath_raw};"`,
                        `/L`, `en`,
                        `/DisableStartupMessages`,
                        `/DisableStartupDialogs`,
                        `/Execute`, `"${repairScriptEpfPath}"`,
                        `/C"TestFile=${featureFileToRepairUri.fsPath}"`
                    ];
                    await this.execute1CProcess(oneCExePath, repairParams, workspaceRootPath, "RepairTestFile.epf");
                    outputChannel.appendLine(`  Repaired ${featureFileToRepairUri.fsPath} successfully.`);
                } catch (error: any) {
                    if (error.code === 'FileNotFound') {
                        outputChannel.appendLine(`  Skipped: ${featureFileToRepairUri.fsPath} not found.`);
                    } else {
                        throw new Error(`Ошибка при проверке/ремонте файла ${featureFileToRepairUri.fsPath}: ${error.message || error}`);
                    }
                }
            }
            
            outputChannel.appendLine(`TypeScript YAML build process completed successfully.`);
            sendStatus('Сборка тестов завершена успешно.', true, 'assemble');
            vscode.window.showInformationMessage('Сборка тестов успешно завершена.');

        } catch (error: any) {
            console.error(`${methodStartLog} Error:`, error);
            outputChannel.appendLine(`--- ERROR: ${error.message || error} ---`);
            if (error.stack) {
                outputChannel.appendLine(`Stack: ${error.stack}`);
            }
            vscode.window.showErrorMessage(`Ошибка сборки: ${error.message || error}. Смотрите Output.`);
            sendStatus(`Ошибка сборки: ${error.message || error}`, true, 'assemble');
        }
    }

    /**
     * Вспомогательный метод для выполнения процесса 1С.
     * @param exePath Путь к 1cv8.exe.
     * @param args Массив аргументов для процесса.
     * @param cwd Рабочая директория.
     * @param processName Имя процесса для логирования.
     * @returns Promise, который разрешается при успешном завершении или отклоняется при ошибке.
     */
    private execute1CProcess(exePath: string, args: string[], cwd: string, processName: string): Promise<void> {
        const outputChannel = this.getOutputChannel();
        return new Promise((resolve, reject) => {
            outputChannel.appendLine(`Executing 1C process: ${processName} with args: ${args.join(' ')}`);
            const command = exePath.includes(' ') ? `"${exePath}"` : exePath;
            
            const child = cp.spawn(command, args, {
                cwd: cwd,
                shell: true, 
                windowsHide: true
            });

            child.stdout?.on('data', (data) => { outputChannel.append(data.toString()); });
            child.stderr?.on('data', (data) => { outputChannel.append(`STDERR for ${processName}: ${data.toString()}`); });

            child.on('error', (error) => {
                outputChannel.appendLine(`--- ERROR STARTING 1C PROCESS ${processName}: ${error.message} ---`);
                reject(new Error(`Ошибка запуска процесса ${processName}: ${error.message}`));
            });

            child.on('close', (code) => {
                outputChannel.appendLine(`--- 1C Process ${processName} finished with exit code ${code} ---`);
                if (code !== 0 && code !== 255) { 
                    reject(new Error(`Процесс ${processName} завершился с кодом ${code}.`));
                } else {
                    resolve();
                }
            });
        });
    }


    private _groupAndSortTestData(cache: Map<string, TestInfo>): { [tabName: string]: TestInfo[] } {
        const grouped: { [tabName: string]: TestInfo[] } = {};
        if (!cache) {
            return grouped;
        }

        for (const info of cache.values()) {
            let finalUriString = '';
            if (info.yamlFileUri && typeof info.yamlFileUri.toString === 'function') {
                finalUriString = info.yamlFileUri.toString();
            }
            const infoWithUriString = { ...info, yamlFileUriString: finalUriString };

            if (!grouped[info.tabName]) { grouped[info.tabName] = []; }
            grouped[info.tabName].push(infoWithUriString);
        }

        for (const tabName in grouped) {
            grouped[tabName].sort((a, b) => {
                if (a.order !== b.order) {
                    return a.order - b.order;
                }
                return a.name.localeCompare(b.name);
            });
        }
        return grouped;
    }

    private async _handleApplyChanges(states: { [testName: string]: boolean }) {
        console.log("[PhaseSwitcherProvider:_handleApplyChanges] Starting...");
        if (!this._view || !this._testCache) { return; }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) { return; }
        const workspaceRootUri = workspaceFolders[0].uri;

        const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, SCAN_DIR_RELATIVE_PATH);
        const baseOffDirUri = vscode.Uri.joinPath(workspaceRootUri, 'RegressionTests_Disabled', 'Yaml', 'Drive');

        if (this._view.webview) {
            this._view.webview.postMessage({ command: 'updateStatus', text: 'Применение изменений...', enableControls: false });
        } else {
            console.warn("[PhaseSwitcherProvider:_handleApplyChanges] Cannot send status, view is not available.");
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Применение изменений фаз...",
            cancellable: false
        }, async (progress) => {
            let stats = { enabled: 0, disabled: 0, skipped: 0, error: 0 };
            const total = Object.keys(states).length;
            const increment = total > 0 ? 100 / total : 0;

            for (const [name, shouldBeEnabled] of Object.entries(states)) {
                progress.report({ increment: increment , message: `Обработка ${name}...` });

                const info = this._testCache!.get(name);
                if (!info) { stats.error++; continue; }

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
                    vscode.window.showErrorMessage(`Ошибка перемещения "${name}": ${moveError.message || moveError}`);
                    stats.error++;
                }
            }

            const resultMessage = `Включено: ${stats.enabled}, Выключено: ${stats.disabled}, Пропущено: ${stats.skipped}, Ошибки: ${stats.error}`;
            if (stats.error > 0) { vscode.window.showWarningMessage(`Изменения применены с ошибками! ${resultMessage}`); }
            else if (stats.enabled > 0 || stats.disabled > 0) { vscode.window.showInformationMessage(`Изменения фаз успешно применены! ${resultMessage}`); }
            else { vscode.window.showInformationMessage(`Изменения фаз: нечего применять. ${resultMessage}`); }

            if (this._view?.webview) {
                console.log("[PhaseSwitcherProvider] Refreshing state after apply...");
                await this._sendInitialState(this._view.webview);
            } else {
                console.warn("[PhaseSwitcherProvider] Cannot refresh state after apply, view is not available.");
            }
        });
    }
}
