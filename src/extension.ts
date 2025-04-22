import * as vscode from 'vscode';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { handleCreateNestedScenario, handleCreateMainScenario } from './scenarioCreator';
import {
    openSubscenarioHandler,
    findCurrentFileReferencesHandler,
    insertNestedScenarioRefHandler,
    insertScenarioParamHandler,
    insertUidHandler
} from './commandHandlers'; // Предполагается, что эти обработчики существуют и импортированы

import { DriveCompletionProvider } from './completionProvider'; // Предполагается, что эти классы существуют и импортированы
import { DriveHoverProvider } from './hoverProvider';

// Ключ для хранения пароля в SecretStorage (должен совпадать с ключом в phaseSwitcher.ts)
const EMAIL_PASSWORD_KEY = '1cDriveHelper.emailPassword';

/**
 * Функция активации расширения. Вызывается VS Code при первом запуске команды расширения
 * или при наступлении activationEvents, указанных в package.json.
 * @param context Контекст расширения, предоставляемый VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "1cDriveHelper" activated.');

    // --- Регистрация Провайдера для Webview (Phase Switcher) ---
    // Создаем экземпляр провайдера, передавая ему URI расширения и контекст
    // Контекст необходим для доступа к SecretStorage и управления подписками
    const provider = new PhaseSwitcherProvider(context.extensionUri, context);
    // Регистрируем провайдер для вида '1cDriveHelper.phaseSwitcherView'
    context.subscriptions.push( // Добавляем в подписки для автоматической очистки при деактивации
        vscode.window.registerWebviewViewProvider(
            PhaseSwitcherProvider.viewType, // Статический ID вида из класса провайдера
            provider,
            // Опции Webview: сохранять контекст, когда панель скрыта
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // --- Регистрация Провайдеров Языковых Функций (Автодополнение и Подсказки) ---
    // Создаем экземпляры провайдеров
    const completionProvider = new DriveCompletionProvider(context);
    const hoverProvider = new DriveHoverProvider(context);
    // Регистрируем провайдер автодополнения для YAML файлов
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { pattern: '**/*.yaml' }, // Применяется ко всем файлам .yaml в рабочей области
            completionProvider,
            // Символы, после которых будет срабатывать автодополнение
            ' ', '.', ',', ':', ';', '(', ')', '"', "'",
            // Буквы (для автодополнения сразу после начала ввода слова)
            'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
            'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
            'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
            'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
        )
    );
    // Регистрируем провайдер подсказок при наведении для YAML файлов
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { pattern: '**/*.yaml' },
            hoverProvider
        )
    );

    // --- Регистрация Команд ---
    // Регистрируем команды, определенные в package.json, связывая их с обработчиками
    // Команды для работы со сценариями (предполагается, что обработчики импортированы)
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.openSubscenario', openSubscenarioHandler
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createNestedScenario', () => handleCreateNestedScenario(context) // Передаем context, если он нужен обработчику
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createMainScenario', () => handleCreateMainScenario(context) // Передаем context
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

    // --- КОМАНДЫ ДЛЯ УПРАВЛЕНИЯ ПАРОЛЕМ ЧЕРЕЗ ПАЛИТРУ КОМАНД (Ctrl+Shift+P) ---
    // Команда для установки/сохранения пароля
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.setEmailPassword', async () => {
            // Запрашиваем ввод пароля у пользователя
            const password = await vscode.window.showInputBox({
                prompt: 'Введите пароль для тестовой почты', // Текст подсказки
                password: true, // Скрывать вводимые символы (отображать точки)
                ignoreFocusOut: true, // Не закрывать окно ввода при потере фокуса
                placeHolder: 'Пароль не будет сохранен в настройках' // Дополнительная подсказка
            });

            // Проверяем, что пользователь ввел значение и не нажал Escape (password !== undefined)
            if (password !== undefined) {
                if (password) { // Убеждаемся, что введен непустой пароль
                    try {
                        // Сохраняем пароль в безопасное хранилище VS Code
                        await context.secrets.store(EMAIL_PASSWORD_KEY, password);
                        vscode.window.showInformationMessage('Пароль тестовой почты сохранен.'); // Уведомляем пользователя
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.error("Error saving password via command:", message);
                        vscode.window.showErrorMessage(`Ошибка сохранения пароля: ${message}`); // Показываем ошибку, если сохранение не удалось
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
                { modal: true }, // Делаем диалог модальным (блокирует остальной интерфейс)
                'Удалить' // Текст кнопки подтверждения
            );

            // Если пользователь нажал кнопку "Удалить"
            if (confirmation === 'Удалить') {
                try {
                    // Удаляем пароль из безопасного хранилища
                    await context.secrets.delete(EMAIL_PASSWORD_KEY);
                    vscode.window.showInformationMessage('Сохраненный пароль тестовой почты удален.'); // Уведомляем пользователя
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error("Error clearing password via command:", message);
                    vscode.window.showErrorMessage(`Ошибка удаления пароля: ${message}`); // Показываем ошибку, если удаление не удалось
                }
            } else {
                 // Если пользователь закрыл диалог или нажал отмену
                 vscode.window.showInformationMessage('Удаление пароля отменено.');
            }
        }
    ));


    console.log('1cDriveHelper commands and providers registered.');
}

/**
 * Функция деактивации расширения. Вызывается VS Code при выгрузке расширения.
 * Используется для освобождения ресурсов.
 */
export function deactivate() {
     console.log('1cDriveHelper extension deactivated.');
     // Здесь можно добавить код для очистки, если это необходимо
     // (VS Code автоматически очистит ресурсы, добавленные в context.subscriptions)
}