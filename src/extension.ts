import * as vscode from 'vscode';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { handleCreateNestedScenario, handleCreateMainScenario } from './scenarioCreator';
import {
    openSubscenarioHandler,
    findCurrentFileReferencesHandler,
    insertNestedScenarioRefHandler,
    insertScenarioParamHandler,
    insertUidHandler
} from './commandHandlers';

/**
 * Вызывается при активации расширения.
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "1cDriveHelper" activated.');

    // --- Регистрация Провайдера для Webview (Phase Switcher) ---
    const provider = new PhaseSwitcherProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PhaseSwitcherProvider.viewType, // Используем статический ID из класса
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // --- Регистрация Команд ---
    // Используем импортированные обработчики
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        '1cDriveHelper.openSubscenario', openSubscenarioHandler
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        '1cDriveHelper.createNestedScenario', () => handleCreateNestedScenario(context) // Передаем context
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

    console.log('1cDriveHelper commands and providers registered.');
}

/**
 * Вызывается при деактивации расширения.
 */
export function deactivate() {
     console.log('1cDriveHelper extension deactivated.');
}