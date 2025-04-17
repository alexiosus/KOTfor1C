import * as vscode from 'vscode';
import * as path from 'path';
import { scanWorkspaceForTests, SCAN_DIR_RELATIVE_PATH, SCAN_GLOB_PATTERN } from './workspaceScanner';
import { TestInfo } from './types';

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
    // Уникальный ID вида (должен совпадать с package.json)
    public static readonly viewType = '1cDriveHelper.phaseSwitcherView';

    private _view?: vscode.WebviewView; // Ссылка на текущий активный вид
    private _extensionUri: vscode.Uri; // Uri корневой папки расширения
    private _context: vscode.ExtensionContext; // Контекст расширения

    // Кэш найденных тестов и флаг сканирования
    private _testCache: Map<string, TestInfo> | null = null;
    private _isScanning: boolean = false;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
         this._extensionUri = extensionUri;
         this._context = context;
         console.log("[PhaseSwitcherProvider] Initialized.");
    }

    /**
     * Вызывается VS Code при создании или восстановлении Webview View.
     * @param webviewView Объект Webview View.
     * @param context Контекст разрешения.
     * @param _token Токен отмены.
     */
    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        console.log("[PhaseSwitcherProvider] Resolving webview view...");
        this._view = webviewView;

        // Настраиваем параметры Webview
        webviewView.webview.options = {
            // Разрешаем выполнение скриптов
            enableScripts: true,
            // Ограничиваем загрузку локальных ресурсов папкой 'media' расширения
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
        };

        // === Загрузка и установка HTML ===
        const nonce = getNonce();
        const styleUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.css'));
        const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.js'));
        const htmlTemplateUri = vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.html');

        try {
            const htmlBytes = await vscode.workspace.fs.readFile(htmlTemplateUri);
            let htmlContent = Buffer.from(htmlBytes).toString('utf-8');

            // Заменяем плейсхолдеры в HTML
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            htmlContent = htmlContent.replace('${stylesUri}', styleUri.toString());
            htmlContent = htmlContent.replace('${scriptUri}', scriptUri.toString());
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webviewView.webview.cspSource);

            webviewView.webview.html = htmlContent; // Устанавливаем готовый HTML
            console.log("[PhaseSwitcherProvider] HTML content set from template.");

        } catch (err) {
             console.error("[PhaseSwitcherProvider] Failed to read or process webview HTML template:", err);
             webviewView.webview.html = `<body>Ошибка загрузки интерфейса: ${err}</body>`;
             return; // Выходим, если HTML не загрузился
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
                         // Разблокируем UI в вебвью в случае ошибки
                         this._view?.webview.postMessage({ command: 'updateStatus', text: 'Ошибка: неверные данные.', enableControls: true });
                    }
                    return;
                case 'getInitialState':
                case 'refreshData':
                    await this._sendInitialState(webviewView.webview);
                    return;
                case 'log': // Сообщение для логирования из Webview
                    console.log(message.text); // Выводим текст лога в консоль Extension Host
                    return;
                case 'openScenario':
                    if (message.name && this._testCache) {
                        const testInfo = this._testCache.get(message.name);
                        if (testInfo) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(testInfo.yamlFileUri);
                                await vscode.window.showTextDocument(doc, { preview: false });
                            } catch (error) {
                                console.error(`[PhaseSwitcherProvider] Error opening scenario file: ${error}`);
                                vscode.window.showErrorMessage(`Не удалось открыть файл сценария: ${error}`);
                            }
                        } else {
                            vscode.window.showWarningMessage(`Сценарий "${message.name}" не найден в кэше.`);
                        }
                    }
                    return;
            }
        }, undefined, this._context.subscriptions); // Добавляем в подписки контекста

        // Обработка закрытия панели
         webviewView.onDidDispose(() => {
             console.log("[PhaseSwitcherProvider] View disposed.");
             this._view = undefined; // Очищаем ссылку
         }, null, this._context.subscriptions);

        console.log("[PhaseSwitcherProvider] Webview resolved successfully.");
        // Начальное состояние будет запрошено скриптом webview через 'getInitialState'
        }

    // === Вспомогательные методы Provider ===

    /**
     * Сканирует воркспейс, проверяет состояние файлов и отправляет данные в Webview.
     * @param webview Экземпляр Webview для отправки сообщений.
     */
    private async _sendInitialState(webview: vscode.Webview) {
        if (this._isScanning) {
             console.log("[PhaseSwitcherProvider:_sendInitialState] Scan already in progress...");
             webview.postMessage({ command: 'updateStatus', text: 'Идет сканирование...' });
             return;
        }
        console.log("[PhaseSwitcherProvider:_sendInitialState] Preparing and sending initial state...");
        webview.postMessage({ command: 'updateStatus', text: 'Сканирование файлов...', enableControls: false }); // Блокируем кнопки

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage("Пожалуйста, откройте папку проекта.");
            webview.postMessage({ command: 'loadInitialState', error: "Папка проекта не открыта" });
            webview.postMessage({ command: 'updateStatus', text: 'Ошибка: Папка проекта не открыта' });
            return;
        }
        const workspaceRootUri = workspaceFolders[0].uri;

        // --- Запускаем сканирование (обновляет this._testCache) ---
        this._isScanning = true;
        this._testCache = await scanWorkspaceForTests(workspaceRootUri); // Вызываем импортированную функцию
        this._isScanning = false;

        let states: { [key: string]: 'checked' | 'unchecked' | 'disabled' } = {};
        let status = "Ошибка сканирования или тесты не найдены";
        let tabData: { [tabName: string]: TestInfo[] } = {};
        let checkedCount = 0;

        if (this._testCache) { // Если сканирование прошло успешно и что-то найдено
            status = "Проверка состояния тестов...";
            webview.postMessage({ command: 'updateStatus', text: status });

            const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, SCAN_DIR_RELATIVE_PATH);
            const baseOffDirUri = vscode.Uri.joinPath(workspaceRootUri, 'RegressionTests_Disabled', 'Yaml', 'Drive'); // TODO: Сделать путь настраиваемым?

            // Асинхронно проверяем состояние для каждого теста
            await Promise.all(Array.from(this._testCache.values()).map(async (info) => {
                const onPathTestDir = vscode.Uri.joinPath(baseOnDirUri, info.relativePath, 'test');
                const offPathTestDir = vscode.Uri.joinPath(baseOffDirUri, info.relativePath, 'test');
                let stateResult: 'checked' | 'unchecked' | 'disabled' = 'disabled'; // Начинаем с 'disabled'

                try { await vscode.workspace.fs.stat(onPathTestDir); stateResult = 'checked'; }
                catch { try { await vscode.workspace.fs.stat(offPathTestDir); stateResult = 'unchecked'; } catch { stateResult = 'disabled'; } }

                states[info.name] = stateResult;
                if (stateResult === 'checked') checkedCount++;

                // console.log(`[ExtHost:_sendInitialState] State check for "${info.name}": ${stateResult}`);
            }));

            status = `Состояние загружено: \n${checkedCount} / ${this._testCache.size} включено`;
            tabData = this._groupAndSortTestData(this._testCache); // Группируем данные для UI
        } else {
             status = "Тесты не найдены или ошибка сканирования.";
        }

        console.log(`[PhaseSwitcherProvider:_sendInitialState] State check complete. Status: ${status}`);
        // console.log("[PhaseSwitcherProvider:_sendInitialState] Final states object being sent:", states); // Лог перед отправкой

        // Отправляем результат в Webview
        webview.postMessage({
            command: 'loadInitialState',
            tabData: tabData, // Сгруппированные TestInfo
            states: states,   // Актуальные состояния 'checked'/'unchecked'/'disabled'
            error: !this._testCache ? status : undefined // Сообщение об ошибке, если кэш пуст
        });
        // Финальный статус после загрузки (JS потом может его изменить на "Нет изменений")
        webview.postMessage({ command: 'updateStatus', text: status, enableControls: !!this._testCache }); // Включаем контролы, если кэш есть
    }

    /**
     * Группирует данные из кэша по вкладкам и сортирует тесты внутри вкладок.
     * @param cache Кэш тестов Map<string, TestInfo>.
     * @returns Объект, где ключ - имя вкладки, значение - массив TestInfo.
     */
    private _groupAndSortTestData(cache: Map<string, TestInfo>): { [tabName: string]: TestInfo[] } {
        const grouped: { [tabName: string]: TestInfo[] } = {};
        if (!cache) return grouped;

        // Группировка
        for (const info of cache.values()) {
            if (!grouped[info.tabName]) { grouped[info.tabName] = []; }
            grouped[info.tabName].push(info);
        }

        // Сортировка тестов внутри вкладок
        for (const tabName in grouped) {
            grouped[tabName].sort((a, b) => {
                if (a.order !== b.order) return a.order - b.order; // По order
                return a.name.localeCompare(b.name); // По имени
            });
        }
        return grouped;
    }

    /**
     * Обрабатывает применение изменений, перемещая папки './test/'.
     * @param states Объект с желаемым состоянием чекбоксов { testName: boolean }.
     */
    private async _handleApplyChanges(states: { [testName: string]: boolean }) {
        console.log("[PhaseSwitcherProvider:_handleApplyChanges] Starting...");
        if (!this._view || !this._testCache) {  return; }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {  return; }
        const workspaceRootUri = workspaceFolders[0].uri;

        const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, SCAN_DIR_RELATIVE_PATH);
        const baseOffDirUri = vscode.Uri.joinPath(workspaceRootUri, 'RegressionTests_Disabled', 'Yaml', 'Drive');

        // Блокируем UI в Webview
        this._view.webview.postMessage({ command: 'updateStatus', text: 'Применение изменений...', enableControls: false });

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Применение изменений фаз...",
            cancellable: false
        }, async (progress) => {
            let stats = { enabled: 0, disabled: 0, skipped: 0, error: 0 };
            const total = Object.keys(states).length;
            const increment = total > 0 ? 100 / total : 0;
            let currentIncrement = 0;

            // --- Логика перемещения ---
            for (const [name, shouldBeEnabled] of Object.entries(states)) {
                currentIncrement += increment; // Обновляем прогресс для каждого шага
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
                        await vscode.workspace.fs.rename(offPathTestDir, onPathTestDir, { overwrite: true });
                        stats.enabled++;
                    } else if (!shouldBeEnabled && currentState === 'enabled') {
                        try { await vscode.workspace.fs.createDirectory(targetOffDirParent); } catch (dirErr: any) { if (dirErr.code !== 'EEXIST' && dirErr.code !== 'FileExists') throw dirErr; }
                        await vscode.workspace.fs.rename(onPathTestDir, offPathTestDir, { overwrite: true });
                        stats.disabled++;
                    } else { stats.skipped++; }
                } catch (moveError: any) {
                    console.error(`[PhaseSwitcherProvider] Error moving test "${name}":`, moveError);
                    vscode.window.showErrorMessage(`Ошибка перемещения "${name}": ${moveError.message || moveError}`);
                    stats.error++;
                }
            }

            progress.report({ increment: 100, message: "Завершено!" }); // Финальный прогресс
            const resultMessage = `Включено: ${stats.enabled}, Выключено: ${stats.disabled}, Пропущено: ${stats.skipped}, Ошибки: ${stats.error}`;
            if (stats.error > 0) { vscode.window.showWarningMessage(`Изменения применены с ошибками! ${resultMessage}`); }
            else if (stats.enabled > 0 || stats.disabled > 0) { vscode.window.showInformationMessage(`Изменения фаз успешно применены! ${resultMessage}`); }
            else { vscode.window.showInformationMessage(`Изменения фаз: нечего применять. ${resultMessage}`); }

            // --- Обновляем состояние в Webview ПОСЛЕ завершения ---
            if (this._view) {
                 console.log("[PhaseSwitcherProvider] Refreshing state after apply...");
                 await this._sendInitialState(this._view.webview); // Запрашиваем новое состояние
            }
        }); 
    } // --- Конец _handleApplyChanges ---

} // --- Конец класса PhaseSwitcherProvider ---


// --- Функция активации ---
// (Импорты ваших обработчиков команд)
import { handleCreateNestedScenario, handleCreateMainScenario } from './scenarioCreator';
import {  } from './navigationUtils';
import {  } from './commandHandlers';

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "1cDriveHelper" activating...');

    // --- Регистрация Провайдера для Webview ---
    const provider = new PhaseSwitcherProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PhaseSwitcherProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } })
    );

    // --- Регистрация всех команд ---
    // context.subscriptions.push(vscode.commands.registerTextEditorCommand('1cDriveHelper.openSubscenario', openSubscenarioHandler));
    context.subscriptions.push(vscode.commands.registerCommand('1cDriveHelper.createNestedScenario', () => handleCreateNestedScenario(context)));
    context.subscriptions.push(vscode.commands.registerCommand('1cDriveHelper.createMainScenario', () => handleCreateMainScenario(context)));
    // context.subscriptions.push(vscode.commands.registerTextEditorCommand('1cDriveHelper.insertNestedScenarioRef', insertNestedScenarioRefHandler));
    // context.subscriptions.push(vscode.commands.registerTextEditorCommand('1cDriveHelper.insertScenarioParam', insertScenarioParamHandler));
    // context.subscriptions.push(vscode.commands.registerTextEditorCommand('1cDriveHelper.insertUid', insertUidHandler));
    // context.subscriptions.push(vscode.commands.registerCommand('1cDriveHelper.findCurrentFileReferences', findCurrentFileReferencesHandler));
    console.log('1cDriveHelper extension activated successfully.');
}

// --- Функция деактивации ---
export function deactivate() {
     console.log('1cDriveHelper extension deactivated.');
}