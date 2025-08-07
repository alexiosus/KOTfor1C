import * as vscode from 'vscode';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { handleCreateNestedScenario, handleCreateMainScenario } from './scenarioCreator';
import {
    openSubscenarioHandler,
    findCurrentFileReferencesHandler,
    insertNestedScenarioRefHandler,
    insertScenarioParamHandler,
    insertUidHandler,
    replaceTabsWithSpacesYamlHandler,
    checkAndFillNestedScenariosHandler,
    checkAndFillScenarioParametersHandler,
    openMxlFileFromExplorerHandler,
    openMxlFileFromTextHandler,
    revealFileInExplorerHandler,
    revealFileInOSHandler,
    handleCreateFirstLaunchZip
} from './commandHandlers';

import { DriveCompletionProvider } from './completionProvider';
import { DriveHoverProvider } from './hoverProvider';
import { TestInfo } from './types'; // Импортируем TestInfo

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

    // --- Регистрация Провайдера для Webview (Phase Switcher) ---
    const phaseSwitcherProvider = new PhaseSwitcherProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PhaseSwitcherProvider.viewType,
            phaseSwitcherProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

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
        '1cDriveHelper.openSubscenario', openSubscenarioHandler
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createNestedScenario', () => handleCreateNestedScenario(context)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createMainScenario', () => handleCreateMainScenario(context)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.insertNestedScenarioRef', insertNestedScenarioRefHandler
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
        '1cDriveHelper.checkAndFillNestedScenarios', checkAndFillNestedScenariosHandler
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
    // Команда для установки/сохранения пароля
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.setEmailPassword', async () => {
            // Запрашиваем ввод пароля у пользователя
            const password = await vscode.window.showInputBox({
                prompt: 'Введите пароль для тестовой почты',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'Пароль не будет сохранен в настройках'
            });

            // Проверяем, что пользователь ввел значение и не нажал Escape (password !== undefined)
            if (password !== undefined) {
                if (password) { 
                    try {
                        // Сохраняем пароль в безопасное хранилище VS Code
                        await context.secrets.store(EMAIL_PASSWORD_KEY, password);
                        vscode.window.showInformationMessage('Пароль тестовой почты сохранен.');
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.error("Error saving password via command:", message);
                        vscode.window.showErrorMessage(`Ошибка сохранения пароля: ${message}`);
                    }
                } else {
                    // Если пользователь ввел пустую строку, считаем это отменой
                    vscode.window.showWarningMessage('Сохранение пароля отменено (пустое значение).');
                }
            } else {
                 // Если пользователь нажал Escape (password === undefined)
                 vscode.window.showInformationMessage('Сохранение пароля отменено.');
            }
        }
    ));

    // Команда для очистки сохраненного пароля
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.clearEmailPassword', async () => {
            // Запрашиваем подтверждение у пользователя перед удалением
            const confirmation = await vscode.window.showWarningMessage(
                'Вы уверены, что хотите удалить сохраненный пароль тестовой почты?',
                { modal: true }, 
                'Удалить'
            );

            // Если пользователь нажал кнопку "Удалить"
            if (confirmation === 'Удалить') {
                try {
                    // Удаляем пароль из безопасного хранилища
                    await context.secrets.delete(EMAIL_PASSWORD_KEY);
                    vscode.window.showInformationMessage('Сохраненный пароль тестовой почты удален.');
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error("Error clearing password via command:", message);
                    vscode.window.showErrorMessage(`Ошибка удаления пароля: ${message}`);
                }
            } else {
                 // Если пользователь закрыл диалог или нажал отмену
                 vscode.window.showInformationMessage('Удаление пароля отменено.');
            }
        }
    ));

    const refreshGherkinStepsCommand = async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Обновление шагов Gherkin...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Загрузка определений шагов Gherkin..." });
            try {
                await completionProvider.refreshSteps(); // Обновляет только Gherkin шаги
                progress.report({ increment: 50, message: "Обновление автодополнения Gherkin завершено." });
                await hoverProvider.refreshSteps();
                progress.report({ increment: 100, message: "Обновление подсказок Gherkin завершено." });
                
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
    }));

    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createFirstLaunchZip', 
        () => handleCreateFirstLaunchZip(context)
    ));

    console.log('1cDriveHelper commands and providers registered.');
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
