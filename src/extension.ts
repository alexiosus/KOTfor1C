import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { handleCreateNestedScenario, handleCreateMainScenario } from './scenarioCreator';
import {
    openSubscenarioHandler,
    findCurrentFileReferencesHandler,
    insertNestedScenarioRefHandler,
    insertScenarioParamHandler,
    insertUidHandler
} from './commandHandlers';

import { DriveCompletionProvider } from './completionProvider';
import { DriveHoverProvider } from './hoverProvider';

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

    const completionProvider = new DriveCompletionProvider(context);
    const hoverProvider = new DriveHoverProvider(context);
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { pattern: '**/*.yaml' },
            completionProvider,
            ' ', '.', ',', ':', ';', '(', ')', '"', "'",
            'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
            'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
            'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 
            'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
        )
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { pattern: '**/*.yaml' },
            hoverProvider
        )
    );


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