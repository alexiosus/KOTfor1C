import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { scanWorkspaceForTests, SCAN_DIR_RELATIVE_PATH, SCAN_GLOB_PATTERN } from './workspaceScanner';
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
 * Провайдер для Webview в боковой панели, управляющий переключением тестов.
 */
export class PhaseSwitcherProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = '1cDriveHelper.phaseSwitcherView';
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext; // Контекст нужен для SecretStorage

    private _testCache: Map<string, TestInfo> | null = null;
    private _isScanning: boolean = false;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
         this._extensionUri = extensionUri;
         this._context = context; // Сохраняем контекст
         console.log("[PhaseSwitcherProvider] Initialized.");
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

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
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

        // === Загрузка и установка HTML ===
        const nonce = getNonce();
        const styleUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.css'));
        const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.js'));
        const htmlTemplateUri = vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.html'); // Используем обновленный HTML
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
        } catch (err) {
             console.error("[PhaseSwitcherProvider] Failed to read or process webview HTML template:", err);
             webviewView.webview.html = `<body>Ошибка загрузки интерфейса: ${err}</body>`;
             return;
        }

        // === Обработчик сообщений от Webview ===
        webviewView.webview.onDidReceiveMessage(async message => {
            // console.log("[WebviewView] Received message:", message.command);
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
                    await this._handleRunAssembleScript(recordGL, driveTrade);
                    return;
                case 'openScenario':
                    if (message.name && this._testCache) {
                        const testInfo = this._testCache.get(message.name);
                        if (testInfo && testInfo.yamlFileUri) { // Проверяем наличие yamlFileUri
                            try {
                                const doc = await vscode.workspace.openTextDocument(testInfo.yamlFileUri);
                                await vscode.window.showTextDocument(doc, { preview: false });
                            } catch (error) {
                                console.error(`[PhaseSwitcherProvider] Error opening scenario file: ${error}`);
                                vscode.window.showErrorMessage(`Не удалось открыть файл сценария: ${error}`);
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

                // --- ОБРАБОТЧИКИ ПАРОЛЯ УДАЛЕНЫ ИЗ WEBVIEW ---
                // case 'savePassword': ...
                // case 'clearPassword': ...
            }
        }, undefined, this._context.subscriptions);

         webviewView.onDidDispose(() => {
             console.log("[PhaseSwitcherProvider] View disposed.");
             this._view = undefined;
         }, null, this._context.subscriptions);

        console.log("[PhaseSwitcherProvider] Webview resolved successfully.");
    }

    // === Вспомогательные методы Provider ===

    /** Отправка начального состояния в Webview */
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
                catch { try { await vscode.workspace.fs.stat(offPathTestDir); stateResult = 'unchecked'; } catch { stateResult = 'disabled'; } }

                states[info.name] = stateResult;
                if (stateResult === 'checked') checkedCount++;
            }));

            console.log("[PhaseSwitcherProvider:_sendInitialState] Current _testCache content (before grouping):");
            console.log(JSON.stringify(Array.from(this._testCache.entries()), null, 2));

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

    /** Запуск скрипта сборки */
    private async _handleRunAssembleScript(recordGLValue: string, driveTradeValue: string): Promise<void> {
        const methodStartLog = "[PhaseSwitcherProvider:_handleRunAssembleScript]";
        console.log(`${methodStartLog} Starting with RecordGL=${recordGLValue}, DriveTrade=${driveTradeValue}`);

        const webview = this._view?.webview;
        if (!webview) {
            console.error(`${methodStartLog} Cannot run script, view is not available.`);
            // Не отправляем сообщение в webview, если его нет
            vscode.window.showErrorMessage("Не удалось запустить скрипт: панель 1cDrive Helper не активна.");
            return;
        }

        const sendStatus = (text: string, enableControls: boolean = false, target: 'main' | 'assemble' = 'assemble') => {
             // Проверяем наличие webview перед отправкой
             if (this._view?.webview) {
                 this._view.webview.postMessage({ command: 'updateStatus', text: text, enableControls: enableControls, target: target });
             } else {
                 console.warn(`${methodStartLog} Cannot send status, view is not available. Status: ${text}`);
             }
        };

        // --- 1. Получаем настройки VS Code ---
        const config = vscode.workspace.getConfiguration('1cDriveHelper');

        // --- 2. Определяем путь к .bat скрипту ---
        const batScriptName = 'BuildYAML.bat';
        const batUri = vscode.Uri.joinPath(this._extensionUri, 'res', batScriptName);
        const batPath = batUri.fsPath;

        // --- 3. Проверка существования скрипта ---
        try {
             await vscode.workspace.fs.stat(batUri);
             console.log(`${methodStartLog} Found assemble script at: ${batPath}`);
        } catch (err) {
             console.error(`${methodStartLog} Assemble script not found at path: ${batPath}`, err);
             vscode.window.showErrorMessage(`Скрипт сборки '${batScriptName}' не найден в папке res расширения.`);
             sendStatus(`Ошибка: ${batScriptName} не найден.`, true);
             return;
        }

        // --- 4. Читаем остальные пути и параметры из настроек ---
        const buildRelativePath = config.get<string>('assembleScript.buildPath') || '.vscode/1cdrive_build';
        const oneCPath_raw = config.get<string>('paths.oneCEnterpriseExe');
        const emptyIbPath_raw = config.get<string>('paths.emptyInfobase');
        const psPath_raw = config.get<string>('paths.powershell');
        const dbUser = config.get<string>('params.dbUser');
        const dbPassword = config.get<string>('params.dbPassword');
        const splitFeatures = config.get<string>('params.splitFeatureFiles');
        // Параметры Email (КРОМЕ ПАРОЛЯ)
        const emailAddr = config.get<string>('params.emailAddress');
        const emailIncServer = config.get<string>('params.emailIncomingServer');
        const emailIncPort = config.get<string>('params.emailIncomingPort');
        const emailOutServer = config.get<string>('params.emailOutgoingServer');
        const emailOutPort = config.get<string>('params.emailOutgoingPort');
        const emailProto = config.get<string>('params.emailProtocol');

        // --- 4.1 ПОЛУЧАЕМ ПАРОЛЬ ИЗ SECRET STORAGE ---
        let emailPass: string | undefined;
        try {
            emailPass = await this._context.secrets.get(EMAIL_PASSWORD_KEY);
            if (!emailPass) {
                console.warn(`${methodStartLog} Email password not found in SecretStorage.`);
                // Используем команду для предложения установить пароль
                const setPasswordAction = 'Установить пароль';
                const result = await vscode.window.showErrorMessage(
                    `Пароль тестовой почты не найден. Пожалуйста, сохраните его.`,
                    setPasswordAction
                );
                if (result === setPasswordAction) {
                    vscode.commands.executeCommand('1cDriveHelper.setEmailPassword');
                }
                sendStatus('Ошибка: Пароль почты не сохранен.', true);
                return;
            }
            console.log(`${methodStartLog} Email password retrieved from SecretStorage.`);
        } catch (error) {
            console.error(`${methodStartLog} Error retrieving password from SecretStorage:`, error);
            vscode.window.showErrorMessage(`Ошибка чтения пароля из безопасного хранилища: ${error}`);
            sendStatus('Критическая ошибка чтения пароля.', true);
            return;
        }

        // Проверка критичного пути к 1С
        if (!oneCPath_raw || !fs.existsSync(oneCPath_raw)) {
             vscode.window.showErrorMessage(`Путь к 1С (настройка '1cDriveHelper.paths.oneCEnterpriseExe') не указан или файл не найден.`);
             sendStatus('Ошибка: Не найден 1cv8.exe.', true);
             return;
        }

        // --- 5. Получаем корень проекта ---
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {
             vscode.window.showErrorMessage("Необходимо открыть папку проекта.");
             sendStatus('Ошибка: Папка проекта не открыта.', true);
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const absoluteBuildPath = path.resolve(workspaceRoot, buildRelativePath);

        // --- 6. Готовим переменные окружения ---
        const currentEnv = { ...process.env };
        currentEnv['BUILD_SOURCESDIRECTORY'] = workspaceRoot;
        currentEnv['BuildPath'] = absoluteBuildPath;
        currentEnv['AppThin'] = oneCPath_raw ? `"${oneCPath_raw}"` : "";
        currentEnv['EmptyInfobasePath'] = emptyIbPath_raw || "";
        currentEnv['PSPath'] = psPath_raw ? `"${psPath_raw}"` : "";
        if (dbUser) currentEnv['DBUser'] = dbUser;
        if (dbPassword) currentEnv['DBPassword'] = dbPassword;
        currentEnv['RecordGLAccounts'] = recordGLValue;
        currentEnv['DriveTrade'] = driveTradeValue;
        if (splitFeatures) currentEnv['SplitFeatureFiles'] = splitFeatures;
        // Email параметры (Включая пароль из SecretStorage)
        if (emailAddr) currentEnv['EMailTestEmailAddress'] = emailAddr;
        if (emailPass) currentEnv['EMailTestPassword'] = emailPass; // <<< ПАРОЛЬ ИЗ SECRET STORAGE
        if (emailIncServer) currentEnv['EMailTestIncomingMailServer'] = emailIncServer;
        if (emailIncPort) currentEnv['EMailTestIncomingMailPort'] = emailIncPort;
        if (emailOutServer) currentEnv['EMailTestOutgoingMailServer'] = emailOutServer;
        if (emailOutPort) currentEnv['EMailTestOutgoingMailPort'] = emailOutPort;
        if (emailProto) currentEnv['EMailTestProtocol'] = emailProto;

        sendStatus(`Сборка тестов в процессе`, false);

        // --- 7. Создаем или получаем Output Channel ---
        const outputChannel = vscode.window.createOutputChannel("1cDrive Test Assembly", { log: true });
        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine(`[${new Date().toISOString()}] Starting script: ${batPath}`);
        outputChannel.appendLine(`Working directory: ${workspaceRoot}`);
        outputChannel.appendLine(`Using Params: RecordGLAccounts=${recordGLValue}, DriveTrade=${driveTradeValue}`);
        outputChannel.appendLine(`-------------------- Script Output Start --------------------`);

        // --- 8. Запускаем .bat скрипт ---
        try {
            const command = batPath.includes(' ') ? `"${batPath}"` : batPath;
            const args: string[] = [];
            const options: cp.SpawnOptions = {
                cwd: workspaceRoot,
                env: currentEnv,
                shell: true,
                windowsHide: true
            };

            const child = cp.spawn(command, args, options);

            // --- 9. Обработка вывода скрипта ---
            child.stdout?.on('data', (data) => { outputChannel.append(data.toString()); });
            child.stderr?.on('data', (data) => { outputChannel.append(`STDERR: ${data.toString()}`); });

            // --- 10. Обработка ошибок ЗАПУСКА скрипта ---
            child.on('error', (error) => {
                console.error(`${methodStartLog} Failed to start script '${command}': ${error.message}`);
                outputChannel.appendLine(`--- ERROR STARTING SCRIPT: ${error.message} ---`);
                vscode.window.showErrorMessage(`Ошибка запуска скрипта сборки: ${error.message}`);
                sendStatus(`Ошибка запуска: ${error.message}`, true);
            });

            // --- 11. Обработка ЗАВЕРШЕНИЯ скрипта ---
            child.on('close', (code) => {
                outputChannel.appendLine(`--- Script finished with exit code ${code} ---`);
                console.log(`${methodStartLog} Script finished with code ${code}`);
                const success = (code === 0);
                const endStatus = success ? 'Сборка тестов завершена успешно.' : `Ошибка сборки (код: ${code}). Смотрите Output.`;

                if (success) {
                    vscode.window.showInformationMessage('Сборка тестов успешно завершена.');
                } else {
                    vscode.window.showErrorMessage(`Сборка тестов завершилась с ошибкой (код: ${code}). Смотрите Output "1cDrive Test Assembly".`);
                }
                // Используем setTimeout для гарантии отправки статуса после всех событий
                setTimeout(() => sendStatus(endStatus, true), 0);
            });

        } catch (error: any) {
            console.error(`${methodStartLog} Error spawning script process:`, error);
            outputChannel.appendLine(`--- UNEXPECTED ERROR spawning script: ${error.message || error} ---`);
            vscode.window.showErrorMessage(`Критическая ошибка при запуске скрипта сборки: ${error.message || error}`);
             sendStatus(`Критическая ошибка: ${error.message || error}`, true);
        }
    }

    /** Группировка и сортировка данных для UI */
    private _groupAndSortTestData(cache: Map<string, TestInfo>): { [tabName: string]: TestInfo[] } {
        const grouped: { [tabName: string]: TestInfo[] } = {};
        if (!cache) return grouped;

        for (const info of cache.values()) {
             // Добавляем yamlFileUriString для кнопки открытия файла
             let finalUriString = '';
             if (info.yamlFileUri && typeof info.yamlFileUri.toString === 'function') {
                 finalUriString = info.yamlFileUri.toString();
             }
             // Создаем новый объект с добавленным полем, чтобы не мутировать исходный кэш
             const infoWithUriString = { ...info, yamlFileUriString: finalUriString };

            if (!grouped[info.tabName]) { grouped[info.tabName] = []; }
            grouped[info.tabName].push(infoWithUriString);
        }

        // Сортировка тестов внутри вкладок
        for (const tabName in grouped) {
            grouped[tabName].sort((a, b) => {
                if (a.order !== b.order) return a.order - b.order; // Сначала по order
                return a.name.localeCompare(b.name); // Затем по имени
            });
        }
        return grouped;
    }


    /** Применение изменений (перемещение папок) */
    private async _handleApplyChanges(states: { [testName: string]: boolean }) {
        console.log("[PhaseSwitcherProvider:_handleApplyChanges] Starting...");
        if (!this._view || !this._testCache) {  return; }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {  return; }
        const workspaceRootUri = workspaceFolders[0].uri;

        const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, SCAN_DIR_RELATIVE_PATH);
        const baseOffDirUri = vscode.Uri.joinPath(workspaceRootUri, 'RegressionTests_Disabled', 'Yaml', 'Drive');

        // Проверяем наличие webview перед отправкой сообщения
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
            let currentIncrement = 0;

            for (const [name, shouldBeEnabled] of Object.entries(states)) {
                currentIncrement += increment;
                progress.report({ increment: currentIncrement, message: `Обработка ${name}...` });

                const info = this._testCache!.get(name);
                if (!info) { stats.error++; continue; }

                const onPathTestDir = vscode.Uri.joinPath(baseOnDirUri, info.relativePath, 'test');
                const offPathTestDir = vscode.Uri.joinPath(baseOffDirUri, info.relativePath, 'test');
                const targetOffDirParent = vscode.Uri.joinPath(baseOffDirUri, info.relativePath);

                let currentState: 'enabled' | 'disabled' | 'missing' = 'missing';
                try { await vscode.workspace.fs.stat(onPathTestDir); currentState = 'enabled'; } catch { try { await vscode.workspace.fs.stat(offPathTestDir); currentState = 'disabled'; } catch { /* missing */ } }

                try {
                    if (shouldBeEnabled && currentState === 'disabled') {
                        // Перемещаем из 'disabled' в 'enabled'
                        await vscode.workspace.fs.rename(offPathTestDir, onPathTestDir, { overwrite: true });
                        stats.enabled++;
                    } else if (!shouldBeEnabled && currentState === 'enabled') {
                        // Перемещаем из 'enabled' в 'disabled'
                        // Убеждаемся, что родительская папка для 'disabled' существует
                        try { await vscode.workspace.fs.createDirectory(targetOffDirParent); } catch (dirErr: any) {
                            // Игнорируем ошибку, если папка уже существует
                            if (dirErr.code !== 'EEXIST' && dirErr.code !== 'FileExists') throw dirErr;
                        }
                        await vscode.workspace.fs.rename(onPathTestDir, offPathTestDir, { overwrite: true });
                        stats.disabled++;
                    } else {
                        // Состояние уже соответствует желаемому или папка отсутствует
                        stats.skipped++;
                    }
                } catch (moveError: any) {
                    console.error(`[PhaseSwitcherProvider] Error moving test "${name}":`, moveError);
                    vscode.window.showErrorMessage(`Ошибка перемещения "${name}": ${moveError.message || moveError}`);
                    stats.error++;
                }
            }

            progress.report({ increment: 100, message: "Завершено!" });
            const resultMessage = `Включено: ${stats.enabled}, Выключено: ${stats.disabled}, Пропущено: ${stats.skipped}, Ошибки: ${stats.error}`;
            if (stats.error > 0) { vscode.window.showWarningMessage(`Изменения применены с ошибками! ${resultMessage}`); }
            else if (stats.enabled > 0 || stats.disabled > 0) { vscode.window.showInformationMessage(`Изменения фаз успешно применены! ${resultMessage}`); }
            else { vscode.window.showInformationMessage(`Изменения фаз: нечего применять. ${resultMessage}`); }

            // Обновляем состояние в Webview ПОСЛЕ завершения, если webview все еще доступна
            if (this._view?.webview) {
                 console.log("[PhaseSwitcherProvider] Refreshing state after apply...");
                 await this._sendInitialState(this._view.webview);
            } else {
                 console.warn("[PhaseSwitcherProvider] Cannot refresh state after apply, view is not available.");
            }
        });
    }

} // --- Конец класса PhaseSwitcherProvider ---
