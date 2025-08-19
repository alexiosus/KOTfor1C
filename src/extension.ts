import * as vscode from 'vscode';
import { DriveCompletionProvider } from './completionProvider';
import { DriveHoverProvider } from './hoverProvider';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { 
    openMxlFileFromTextHandler, 
    openMxlFileFromExplorerHandler,
    revealFileInExplorerHandler, 
    revealFileInOSHandler,
    openSubscenarioHandler,
    findCurrentFileReferencesHandler,
    insertNestedScenarioRefHandler,
    insertScenarioParamHandler,
    insertUidHandler,
    checkAndFillNestedScenariosHandler,
    checkAndFillScenarioParametersHandler,
    replaceTabsWithSpacesYamlHandler,
    handleCreateFirstLaunchZip,
    handleOpenYamlParametersManager,
    clearAndFillNestedScenarios,
    clearAndFillScenarioParameters
} from './commandHandlers';
import { getTranslator } from './localization';
import { setExtensionUri } from './appContext';
import { handleCreateNestedScenario, handleCreateMainScenario } from './scenarioCreator';
import { TestInfo } from './types'; // Импортируем TestInfo
import { SettingsProvider } from './settingsProvider';

// Debounce mechanism to prevent double processing from VS Code auto-save
const processingFiles = new Set<string>();

// Ключ для хранения пароля в SecretStorage (должен совпадать с ключом в phaseSwitcher.ts)
const EMAIL_PASSWORD_KEY = '1cDriveHelper.emailPassword';
const EXTERNAL_STEPS_URL_CONFIG_KEY = '1cDriveHelper.steps.externalUrl'; // Ключ для отслеживания изменений

/**
 * Функция активации расширения. Вызывается VS Code при первом запуске команды расширения
 * или при наступлении activationEvents, указанных в package.json.
 * @param context Контекст расширения, предоставляемый VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "1cDriveHelper" activated.');
    setExtensionUri(context.extensionUri);

    // --- Регистрация Провайдера для Webview (Phase Switcher) ---
    const phaseSwitcherProvider = new PhaseSwitcherProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PhaseSwitcherProvider.viewType,
            phaseSwitcherProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Инициализируем кеш тестов сразу после активации для быстрого доступа
    phaseSwitcherProvider.initializeTestCache().catch(error => {
        console.error('[Extension] Error during eager cache initialization:', error);
    });

    // --- Регистрация Провайдеров Языковых Функций (Автодополнение и Подсказки) ---
    const completionProvider = new DriveCompletionProvider(context);
    const hoverProvider = new DriveHoverProvider(context);
    
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { pattern: '**/*.yaml', scheme: 'file' }, 
            completionProvider,
            ' ', '.', ',', ':', ';', '(', ')', '"', "'",
            // Добавляем буквы для триггера автодополнения
            'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
            'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
            'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
            'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
            'а', 'б', 'в', 'г', 'д', 'е', 'ё', 'ж', 'з', 'и', 'й', 'к', 'л', 'м',
            'н', 'о', 'п', 'р', 'с', 'т', 'у', 'ф', 'х', 'ц', 'ч', 'ш', 'щ',
            'ъ', 'ы', 'ь', 'э', 'ю', 'я',
            'А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ё', 'Ж', 'З', 'И', 'Й', 'К', 'Л', 'М',
            'Н', 'О', 'П', 'Р', 'С', 'Т', 'У', 'Ф', 'Х', 'Ц', 'Ч', 'Ш', 'Щ',
            'Ъ', 'Ы', 'Ь', 'Э', 'Ю', 'Я'
        )
    );
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            hoverProvider
        )
    );

    // Подписываемся на событие обновления кэша тестов от PhaseSwitcherProvider
    // и обновляем автодополнение сценариев
    context.subscriptions.push(
        phaseSwitcherProvider.onDidUpdateTestCache((testCache: Map<string, TestInfo> | null) => {
            if (testCache) {
                completionProvider.updateScenarioCompletions(testCache);
                console.log('[Extension] Scenario completions updated based on PhaseSwitcher cache.');
            } else {
                completionProvider.updateScenarioCompletions(new Map()); 
                console.log('[Extension] Scenario completions cleared due to null PhaseSwitcher cache.');
            }
        })
    );


    // --- Регистрация Команд ---
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.openSubscenario', (editor, edit) => openSubscenarioHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createNestedScenario', () => handleCreateNestedScenario(context)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createMainScenario', () => handleCreateMainScenario(context)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.insertNestedScenarioRef', (editor, edit) => insertNestedScenarioRefHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.insertScenarioParam', insertScenarioParamHandler
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.insertUid', insertUidHandler
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.findCurrentFileReferences', findCurrentFileReferencesHandler
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.replaceTabsWithSpacesYaml', replaceTabsWithSpacesYamlHandler
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.checkAndFillNestedScenarios', (editor, edit) => checkAndFillNestedScenariosHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.checkAndFillScriptParameters', checkAndFillScenarioParametersHandler
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.openMxlFileFromExplorer', (uri: vscode.Uri) => openMxlFileFromExplorerHandler(uri)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.openMxlFile', (editor, edit) => openMxlFileFromTextHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.revealFileInExplorer', (editor, edit) => revealFileInExplorerHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.revealFileInOS', (editor, edit) => revealFileInOSHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.openBuildFolder', (folderPath: string) => {
            if (folderPath) {
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folderPath));
            }
        }
    ));


    // Команда для обновления Phase Switcher (вызывается из scenarioCreator)
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.refreshPhaseSwitcherFromCreate', () => {
            console.log('[Extension] Command 1cDriveHelper.refreshPhaseSwitcherFromCreate invoked.');
            phaseSwitcherProvider.refreshPanelData();
        }
    ));


    // --- КОМАНДЫ ДЛЯ УПРАВЛЕНИЯ ПАРОЛЕМ ЧЕРЕЗ ПАЛИТРУ КОМАНД (Ctrl+Shift+P) ---
    // Команда для сохранения пароля тестовой почты
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.saveEmailPassword', async () => {
            const t = await getTranslator(context.extensionUri);
            // Запрашиваем пароль у пользователя
            const password = await vscode.window.showInputBox({
                prompt: vscode.l10n.t('Enter password for test email'),
                password: true,
                ignoreFocusOut: true,
                placeHolder: vscode.l10n.t('Password will not be saved in settings')
            });

            // Проверяем, что пользователь ввел значение и не нажал Escape (password !== undefined)
            if (password !== undefined) {
                if (password) { 
                    try {
                        // Сохраняем пароль в безопасное хранилище VS Code
                        await context.secrets.store(EMAIL_PASSWORD_KEY, password);
                        vscode.window.showInformationMessage(t('Test email password saved.'));
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.error("Error saving password via command:", message);
                        vscode.window.showErrorMessage(t('Error saving password: {0}', message));
                    }
                } else {
                    // Если пользователь ввел пустую строку, считаем это отменой
                    vscode.window.showWarningMessage(t('Password saving cancelled (empty value).'));
                }
            } else {
                 // Если пользователь нажал Escape (password === undefined)
                 vscode.window.showInformationMessage(t('Password saving cancelled.'));
            }
        }
    ));

    // Команда для очистки сохраненного пароля
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.clearEmailPassword', async () => {
            const t = await getTranslator(context.extensionUri);
            // Запрашиваем подтверждение у пользователя перед удалением
            const confirmation = await vscode.window.showWarningMessage(
                t('Are you sure you want to delete the saved test email password?'),
                { modal: true }, 
                t('Delete')
            );

            // Если пользователь нажал кнопку "Удалить"
            if (confirmation === t('Delete')) {
                try {
                    // Удаляем пароль из безопасного хранилища
                    await context.secrets.delete(EMAIL_PASSWORD_KEY);
                    vscode.window.showInformationMessage(t('Saved test email password deleted.'));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error("Error clearing password via command:", message);
                    vscode.window.showErrorMessage(t('Error deleting password: {0}', message));
                }
            } else {
                 // Если пользователь закрыл диалог или нажал отмену
                 vscode.window.showInformationMessage(t('Password deletion cancelled.'));
            }
        }
    ));

    const refreshGherkinStepsCommand = async () => {
        const t = await getTranslator(context.extensionUri);
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('Updating Gherkin steps...'),
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: t('Loading Gherkin step definitions...') });
            try {
                await completionProvider.refreshSteps(); // Обновляет только Gherkin шаги
                progress.report({ increment: 50, message: t('Gherkin autocompletion update completed.') });
                await hoverProvider.refreshSteps();
                progress.report({ increment: 100, message: t('Gherkin hints update completed.') });
                
                // Для обновления автодополнения сценариев, мы полагаемся на событие от PhaseSwitcherProvider,
                // которое должно сработать, если пользователь нажмет "Обновить" в панели Phase Switcher.
                // Если нужно принудительное обновление сценариев здесь, то нужно будет вызвать
                // логику сканирования сценариев и затем completionProvider.updateScenarioCompletions().
                // Пока что команда `refreshGherkinSteps` обновляет только Gherkin.
                // Обновление сценариев происходит через Phase Switcher UI.

            } catch (error: any) {
                console.error("[refreshGherkinSteps Command] Error during refresh:", error.message);
            }
        });
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            foldSectionsInEditor(editor);
        })
    );
    if (vscode.window.activeTextEditor) {
        foldSectionsInEditor(vscode.window.activeTextEditor);
    }

    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.refreshGherkinSteps', 
        refreshGherkinStepsCommand
    ));

    // Слушатель изменения конфигурации
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration(EXTERNAL_STEPS_URL_CONFIG_KEY)) {
            console.log(`[Extension] Configuration for '${EXTERNAL_STEPS_URL_CONFIG_KEY}' changed. Refreshing Gherkin steps.`);
            await refreshGherkinStepsCommand(); 
        }

        if (event.affectsConfiguration('1cDriveHelper.localization.languageOverride')) {
            console.log('[Extension] Language override setting changed. Prompting for reload.');
            const message = vscode.l10n.t('Language setting changed. Reload window to apply?');
            const reloadNow = vscode.l10n.t('Reload Window');
            const later = vscode.l10n.t('Later');
            const choice = await vscode.window.showInformationMessage(message, reloadNow, later);
            if (choice === reloadNow) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createFirstLaunchZip', 
        () => handleCreateFirstLaunchZip(context)
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.openYamlParametersManager', 
        () => handleOpenYamlParametersManager(context)
    ));

    // Регистрируем провайдер настроек
    const settingsProvider = SettingsProvider.getInstance(context);
    settingsProvider.registerSettingsProvider();

    // Добавляем автоматические операции после сохранения YAML файлов
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            // Проверяем, что это YAML файл
            if (document.languageId === 'yaml' || document.fileName.toLowerCase().endsWith('.yaml')) {
                
                // Debounce mechanism: prevent double processing from VS Code auto-save
                const fileKey = document.uri.toString();
                if (processingFiles.has(fileKey)) {
                    console.log(`[Extension] Skipping processing for ${document.fileName} - already in progress`);
                    return;
                }
                
                processingFiles.add(fileKey);
                
                // Auto-cleanup after 5 seconds to prevent memory leaks
                setTimeout(() => {
                    processingFiles.delete(fileKey);
                }, 5000);
                const config = vscode.workspace.getConfiguration('1cDriveHelper');
                
                // Проверяем, какие операции нужно выполнить
                const enabledOperations: string[] = [];
                
                const tabsEnabled = config.get<boolean>('editor.autoReplaceTabsWithSpacesOnSave', true);
                const nestedEnabled = config.get<boolean>('editor.autoFillNestedScenariosOnSave', true);
                const paramsEnabled = config.get<boolean>('editor.autoFillScenarioParametersOnSave', true);
                const showRefillMessages = config.get<boolean>('editor.showRefillMessages', true);
                
                if (tabsEnabled && document.getText().includes('\t')) {
                    enabledOperations.push('tabs');
                }
                if (nestedEnabled) {
                    enabledOperations.push('nested');
                }
                if (paramsEnabled) {
                    enabledOperations.push('params');
                }

                // Если есть операции для выполнения, показываем единый прогресс
                if (enabledOperations.length > 0) {
                    const t = await getTranslator(context.extensionUri);
                    
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: t('Processing file after save...'),
                        cancellable: false
                    }, async (progress) => {
                        const totalSteps = enabledOperations.length;
                        const completedOperations: string[] = [];
                        
                        try {
                            // 1. Замена табов на пробелы
                            if (enabledOperations.includes('tabs')) {
                                progress.report({ 
                                    increment: (100 / totalSteps), 
                                    message: t('Replacing tabs with spaces...') 
                                });
                                
                                const fullText = document.getText();
                                const newText = fullText.replace(/\t/g, '    ');
                                if (newText !== fullText) {
                                    const edit = new vscode.WorkspaceEdit();
                                    const fullRange = new vscode.Range(
                                        document.positionAt(0),
                                        document.positionAt(fullText.length)
                                    );
                                    edit.replace(document.uri, fullRange, newText);
                                    await vscode.workspace.applyEdit(edit);
                                    completedOperations.push('tabs');
                                }
                            }

                            // 2. Заполнение NestedScenarios
                            if (enabledOperations.includes('nested')) {
                                progress.report({ 
                                    increment: (100 / totalSteps), 
                                    message: t('Filling nested scenarios...') 
                                });
                                
                                // Pass the test cache for fast scenario lookup
                                const testCache = phaseSwitcherProvider.getTestCache();
                                const result = await clearAndFillNestedScenarios(document, true, testCache);
                                if (result) {
                                    completedOperations.push('nested');
                                }
                            }

                            // 3. Заполнение ScenarioParameters
                            if (enabledOperations.includes('params')) {
                                progress.report({ 
                                    increment: (100 / totalSteps), 
                                    message: t('Filling scenario parameters...') 
                                });
                                
                                const result = await clearAndFillScenarioParameters(document, true);
                                if (result) {
                                    completedOperations.push('params');
                                }
                            }

                            // Показываем единое сообщение о завершении
                            if (completedOperations.length > 0) {
                                const message = await buildCompletionMessage(completedOperations, t, showRefillMessages);
                                if (showRefillMessages) {
                                    vscode.window.showInformationMessage(message);
                                }
                                
                                // Save the file after processing to prevent user from seeing unsaved changes
                                // Extend debounce protection to cover the auto-save
                                setTimeout(async () => {
                                    try {
                                        await document.save();
                                        console.log(`[Extension] Saved ${document.fileName} after processing`);
                                    } catch (saveError) {
                                        console.warn(`[Extension] Failed to save ${document.fileName}:`, saveError);
                                        // Don't show error to user - they can save manually if needed
                                    } finally {
                                        // Remove debounce protection after auto-save is complete
                                        processingFiles.delete(fileKey);
                                    }
                                }, 100); // Small delay to ensure our processing is complete
                            } else {
                                // No operations completed, clean up debounce immediately
                                processingFiles.delete(fileKey);
                            }

                        } catch (error) {
                            console.error('[Extension] Error during post-save operations:', error);
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            vscode.window.showErrorMessage(t('Error processing file after save: {0}', errorMessage));
                            // Clean up debounce immediately on error (no auto-save will happen)
                            processingFiles.delete(fileKey);
                        }
                        // Note: debounce cleanup is handled either in the setTimeout callback (success) or catch block (error)
                    });
                }
            }
        })
    );

    // Инициализируем загрузку шагов Gherkin
    completionProvider.refreshSteps();
    hoverProvider.refreshSteps();

    console.log('1cDriveHelper commands and providers registered.');
}

/**
 * Builds a completion message based on completed operations
 */
async function buildCompletionMessage(completedOperations: string[], t: (key: string, ...args: string[]) => string, showRefillMessages: boolean): Promise<string> {
    const messages: string[] = [];
    
    if (completedOperations.includes('tabs')) {
        messages.push(t('tabs replaced'));
    }
    if (completedOperations.includes('nested')) {
        messages.push(t('nested scenarios filled'));
    }
    if (completedOperations.includes('params')) {
        messages.push(t('scenario parameters filled'));
    }
    
    if (messages.length === 1) {
        return t('Save completed: {0}.', messages[0]);
    } else if (messages.length === 2) {
        return t('Save completed: {0} and {1}.', messages[0], messages[1]);
    } else if (messages.length >= 3) {
        const lastMessage = messages.pop()!;
        return t('Save completed: {0}, and {1}.', messages.join(', '), lastMessage);
    }
    
    return t('Save completed.');
}

async function foldSectionsInEditor(editor: vscode.TextEditor | undefined) {
    if (!editor) {
        return;
    }

    // Проверяем, включена ли настройка
    const config = vscode.workspace.getConfiguration('1cDriveHelper');
    if (!config.get<boolean>('editor.autoCollapseOnOpen')) {
        return;
    }

    const document = editor.document;
    // Проверяем, что это YAML файл
    if (!document.fileName.endsWith('.yaml')) {
        return;
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    // Сохраняем исходное положение курсора и выделения
    const originalSelections = editor.selections;
    const originalVisibleRanges = editor.visibleRanges;


    const text = document.getText();
    const sectionsToFold = ['ВложенныеСценарии', 'ПараметрыСценария'];

    for (const sectionName of sectionsToFold) {
        const sectionRegex = new RegExp(`${sectionName}:`, 'm');
        const match = text.match(sectionRegex);

        if (match && typeof match.index === 'number') {
            const startPosition = document.positionAt(match.index);
            // Устанавливаем курсор на начало секции и вызываем команду сворачивания
            editor.selections = [new vscode.Selection(startPosition, startPosition)];
            await vscode.commands.executeCommand('editor.fold');
        }
    }
    // Восстанавливаем исходное положение курсора и выделения
    editor.selections = originalSelections;
    if (originalSelections.length > 0) {
        editor.revealRange(originalVisibleRanges[0], vscode.TextEditorRevealType.AtTop);
    }
}

/**
 * Функция деактивации расширения. Вызывается VS Code при выгрузке расширения.
 * Используется для освобождения ресурсов.
 */
export function deactivate() {
     console.log('1cDriveHelper extension deactivated.');
}
