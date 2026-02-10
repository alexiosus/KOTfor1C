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
    clearAndFillScenarioParameters,
    clearScenarioParameterSessionCache,
    alignNestedScenarioCallParameters,
    alignGherkinTables,
    parseCalledScenariosFromScriptBody,
    parseUsedParametersFromScriptBody
} from './commandHandlers';
import { getTranslator } from './localization';
import { setExtensionUri } from './appContext';
import { handleCreateNestedScenario, handleCreateMainScenario } from './scenarioCreator';
import { TestInfo } from './types'; // Импортируем TestInfo
import { SettingsProvider } from './settingsProvider';
import { ScenarioDiagnosticsProvider } from './scenarioDiagnostics';
import { extractScenarioParameterNameFromText } from './scenarioParameterUtils';
import { isScenarioYamlFile } from './yamlValidator';

// Debounce mechanism to prevent double processing from VS Code auto-save
const processingFiles = new Set<string>();

interface ScenarioSaveSnapshot {
    scenarioName: string | null;
    calledScenariosSignature: string;
    usedParametersSignature: string;
}

interface ScenarioDirtyFlags {
    nameChanged: boolean;
    calledScenariosChanged: boolean;
    usedParametersChanged: boolean;
}

const lastSavedScenarioSnapshots = new Map<string, ScenarioSaveSnapshot>();
const scenarioDirtyFlagsByUri = new Map<string, ScenarioDirtyFlags>();

function parseScenarioNameFromDocumentText(documentText: string): string | null {
    const lines = documentText.split(/\r\n|\r|\n/);
    for (const line of lines) {
        const match = line.match(/^\s*Имя:\s*"(.+?)"\s*$/);
        if (match?.[1]) {
            return match[1].trim();
        }
    }
    return null;
}

function buildScenarioSaveSnapshot(document: vscode.TextDocument): ScenarioSaveSnapshot {
    const documentText = document.getText();
    return {
        scenarioName: parseScenarioNameFromDocumentText(documentText),
        calledScenariosSignature: parseCalledScenariosFromScriptBody(documentText).join('\u001f'),
        usedParametersSignature: parseUsedParametersFromScriptBody(documentText).join('\u001f')
    };
}

function calculateScenarioDirtyFlags(
    currentSnapshot: ScenarioSaveSnapshot,
    lastSavedSnapshot?: ScenarioSaveSnapshot
): ScenarioDirtyFlags {
    if (!lastSavedSnapshot) {
        return {
            nameChanged: true,
            calledScenariosChanged: true,
            usedParametersChanged: true
        };
    }

    return {
        nameChanged: currentSnapshot.scenarioName !== lastSavedSnapshot.scenarioName,
        calledScenariosChanged: currentSnapshot.calledScenariosSignature !== lastSavedSnapshot.calledScenariosSignature,
        usedParametersChanged: currentSnapshot.usedParametersSignature !== lastSavedSnapshot.usedParametersSignature
    };
}

function setScenarioSnapshotAsSaved(document: vscode.TextDocument, snapshot?: ScenarioSaveSnapshot): void {
    const fileKey = document.uri.toString();
    const savedSnapshot = snapshot ?? buildScenarioSaveSnapshot(document);
    lastSavedScenarioSnapshots.set(fileKey, savedSnapshot);
    scenarioDirtyFlagsByUri.set(fileKey, {
        nameChanged: false,
        calledScenariosChanged: false,
        usedParametersChanged: false
    });
}

const EXTERNAL_STEPS_URL_CONFIG_KEY = 'kotTestToolkit.steps.externalUrl'; // Ключ для отслеживания изменений

/**
 * Функция активации расширения. Вызывается VS Code при первом запуске команды расширения
 * или при наступлении activationEvents, указанных в package.json.
 * @param context Контекст расширения, предоставляемый VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "kotTestToolkit" activated.');
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

    const scenarioDiagnosticsProvider = new ScenarioDiagnosticsProvider(phaseSwitcherProvider, hoverProvider);
    context.subscriptions.push(
        scenarioDiagnosticsProvider,
        vscode.languages.registerCodeActionsProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            scenarioDiagnosticsProvider,
            { providedCodeActionKinds: ScenarioDiagnosticsProvider.providedCodeActionKinds }
        )
    );

    // Initialize incremental save snapshots for currently open scenario documents.
    vscode.workspace.textDocuments.forEach(document => {
        if (!document.isUntitled && isScenarioYamlFile(document)) {
            setScenarioSnapshotAsSaved(document);
        }
    });

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (!document.isUntitled && isScenarioYamlFile(document)) {
            setScenarioSnapshotAsSaved(document);
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        const document = event.document;
        if (document.isUntitled || !isScenarioYamlFile(document)) {
            return;
        }

        const fileKey = document.uri.toString();
        const currentSnapshot = buildScenarioSaveSnapshot(document);
        const lastSavedSnapshot = lastSavedScenarioSnapshots.get(fileKey);
        scenarioDirtyFlagsByUri.set(fileKey, calculateScenarioDirtyFlags(currentSnapshot, lastSavedSnapshot));
    }));


    // --- Регистрация Команд ---
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.openSubscenario', (editor, edit) => openSubscenarioHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.createNestedScenario', () => handleCreateNestedScenario(context)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.createMainScenario', () => handleCreateMainScenario(context)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.insertNestedScenarioRef', (editor, edit) => insertNestedScenarioRefHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.insertScenarioParam', insertScenarioParamHandler
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.insertUid', insertUidHandler
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.findCurrentFileReferences', findCurrentFileReferencesHandler
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.replaceTabsWithSpacesYaml', replaceTabsWithSpacesYamlHandler
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.checkAndFillNestedScenarios', (editor, edit) => checkAndFillNestedScenariosHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.checkAndFillScriptParameters', checkAndFillScenarioParametersHandler
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openMxlFileFromExplorer', (uri: vscode.Uri) => openMxlFileFromExplorerHandler(uri)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.openMxlFile', (editor, edit) => openMxlFileFromTextHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.revealFileInExplorer', (editor, edit) => revealFileInExplorerHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.revealFileInOS', (editor, edit) => revealFileInOSHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openBuildFolder', (folderPath: string) => {
            if (folderPath) {
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folderPath));
            }
        }
    ));


    // Команда для обновления Phase Switcher (вызывается из scenarioCreator)
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.refreshPhaseSwitcherFromCreate', () => {
            console.log('[Extension] Command kotTestToolkit.refreshPhaseSwitcherFromCreate invoked.');
            phaseSwitcherProvider.refreshPanelData();
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
        'kotTestToolkit.refreshGherkinSteps', 
        refreshGherkinStepsCommand
    ));

    // Слушатель изменения конфигурации
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration(EXTERNAL_STEPS_URL_CONFIG_KEY)) {
            console.log(`[Extension] Configuration for '${EXTERNAL_STEPS_URL_CONFIG_KEY}' changed. Refreshing Gherkin steps.`);
            await refreshGherkinStepsCommand(); 
        }

        if (event.affectsConfiguration('kotTestToolkit.localization.languageOverride')) {
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
        'kotTestToolkit.createFirstLaunchZip', 
        () => handleCreateFirstLaunchZip(context)
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openYamlParametersManager', 
        () => handleOpenYamlParametersManager(context)
    ));

    const runWorkspaceDiagnosticsScan = async (options: {
        refreshCache?: boolean;
        showCompletionMessage?: boolean;
        progressLocation?: vscode.ProgressLocation;
    } = {}) => {
        const t = await getTranslator(context.extensionUri);
        const refreshCache = options.refreshCache ?? true;
        const showCompletionMessage = options.showCompletionMessage ?? true;
        const progressLocation = options.progressLocation ?? vscode.ProgressLocation.Notification;

        await vscode.window.withProgress({
            location: progressLocation,
            title: t('Scanning workspace scenario diagnostics...'),
            cancellable: false
        }, async () => {
            await scenarioDiagnosticsProvider.scanWorkspaceDiagnostics({ refreshCache });
        });

        if (showCompletionMessage) {
            vscode.window.showInformationMessage(t('Workspace scenario diagnostics scan completed.'));
        }
    };

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.scanWorkspaceDiagnostics',
        async () => {
            try {
                const t = await getTranslator(context.extensionUri);
                const runScanAction = t('Run scan');
                const confirmation = await vscode.window.showWarningMessage(
                    t('Workspace diagnostics scan may create high load on large projects. Continue?'),
                    { modal: true },
                    runScanAction
                );
                if (confirmation !== runScanAction) {
                    return;
                }

                await runWorkspaceDiagnosticsScan({
                    refreshCache: true,
                    showCompletionMessage: true,
                    progressLocation: vscode.ProgressLocation.Notification
                });
            } catch (error) {
                const t = await getTranslator(context.extensionUri);
                const message = error instanceof Error ? error.message : String(error);
                console.error('[Extension] scanWorkspaceDiagnostics failed:', error);
                vscode.window.showErrorMessage(t('Failed to scan scenario diagnostics: {0}', message));
            }
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.fixScenarioIssues',
        async (targetUri?: vscode.Uri) => {
            const t = await getTranslator(context.extensionUri);
            let document: vscode.TextDocument | undefined;

            if (targetUri) {
                try {
                    document = await vscode.workspace.openTextDocument(targetUri);
                } catch (error) {
                    console.error('[Extension] Failed to open document for fixScenarioIssues:', error);
                    vscode.window.showErrorMessage(t('Failed to open file for fixing.'));
                    return;
                }
            } else {
                document = vscode.window.activeTextEditor?.document;
            }

            if (!document) {
                vscode.window.showWarningMessage(t('No active YAML scenario file.'));
                return;
            }

            const { isScenarioYamlFile } = await import('./yamlValidator.js');
            if (!isScenarioYamlFile(document)) {
                vscode.window.showWarningMessage(t('This command is only available for scenario YAML files.'));
                return;
            }

            const fileKey = document.uri.toString();
            processingFiles.add(fileKey);

            try {
                const completedOperations: string[] = [];
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('Fixing scenario issues...'),
                    cancellable: false
                }, async (progress) => {
                    progress.report({ increment: 10, message: t('Replacing tabs with spaces...') });
                    const fullText = document!.getText();
                    const newText = fullText.replace(/^\t+/gm, (match) => '    '.repeat(match.length));
                    if (newText !== fullText) {
                        const edit = new vscode.WorkspaceEdit();
                        const fullRange = new vscode.Range(
                            document!.positionAt(0),
                            document!.positionAt(fullText.length)
                        );
                        edit.replace(document!.uri, fullRange, newText);
                        await vscode.workspace.applyEdit(edit);
                        completedOperations.push('tabs');
                    }

                    progress.report({ increment: 20, message: t('Aligning Gherkin tables...') });
                    if (await alignGherkinTables(document!)) {
                        completedOperations.push('alignTables');
                    }

                    progress.report({ increment: 20, message: t('Aligning nested scenario parameters...') });
                    if (await alignNestedScenarioCallParameters(document!)) {
                        completedOperations.push('alignNested');
                    }

                    progress.report({ increment: 20, message: t('Refreshing scenario cache...') });
                    await phaseSwitcherProvider.ensureFreshTestCache();
                    const testCache = phaseSwitcherProvider.getTestCache();

                    progress.report({ increment: 15, message: t('Filling nested scenarios...') });
                    if (await clearAndFillNestedScenarios(document!, true, testCache)) {
                        completedOperations.push('nested');
                    }

                    progress.report({ increment: 15, message: t('Filling scenario parameters...') });
                    if (await clearAndFillScenarioParameters(document!, true)) {
                        completedOperations.push('params');
                    }
                });

                await document.save();
                if (completedOperations.length > 0) {
                    vscode.window.showInformationMessage(t('Scenario issues fixed.'));
                } else {
                    vscode.window.showInformationMessage(t('No issues to fix.'));
                }
            } catch (error) {
                console.error('[Extension] fixScenarioIssues failed:', error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(t('Failed to fix scenario issues: {0}', errorMessage));
            } finally {
                processingFiles.delete(fileKey);
            }
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.addScenarioParameterExclusion',
        async (rawParameterArg?: unknown, ...restArgs: unknown[]) => {
            const t = await getTranslator(context.extensionUri);

            const extractNameFromUnknownArg = (arg: unknown): string => {
                if (!arg) {
                    return '';
                }

                if (typeof arg === 'string') {
                    return extractScenarioParameterNameFromText(arg);
                }

                if (Array.isArray(arg)) {
                    for (const item of arg) {
                        const value = extractNameFromUnknownArg(item);
                        if (value) {
                            return value;
                        }
                    }
                    return '';
                }

                if (typeof arg === 'object') {
                    const record = arg as Record<string, unknown>;
                    const candidateKeys = ['parameterName', 'text', 'value', 'label', 'word'];
                    for (const key of candidateKeys) {
                        const rawValue = record[key];
                        if (typeof rawValue === 'string') {
                            const parsed = extractScenarioParameterNameFromText(rawValue);
                            if (parsed) {
                                return parsed;
                            }
                        }
                    }
                }

                return '';
            };

            try {
                let parameterName = '';
                for (const arg of [rawParameterArg, ...restArgs]) {
                    parameterName = extractNameFromUnknownArg(arg);
                    if (parameterName) {
                        break;
                    }
                }

                if (!parameterName) {
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        for (const selection of editor.selections) {
                            if (!selection.isEmpty) {
                                const selectedText = editor.document.getText(selection);
                                parameterName = extractScenarioParameterNameFromText(selectedText);
                                if (parameterName) {
                                    break;
                                }
                            }
                        }

                        if (!parameterName) {
                            const active = editor.selection.active;
                            const lineText = editor.document.lineAt(active.line).text;
                            const regex = /\[([A-Za-zА-Яа-яЁё0-9_-]+)\]/g;
                            let match: RegExpExecArray | null;
                            while ((match = regex.exec(lineText)) !== null) {
                                const start = match.index;
                                const end = match.index + match[0].length;
                                if (active.character >= start && active.character <= end) {
                                    parameterName = match[1];
                                    break;
                                }
                            }
                        }

                        if (!parameterName) {
                            const wordRange = editor.document.getWordRangeAtPosition(
                                editor.selection.active,
                                /[A-Za-zА-Яа-яЁё0-9_-]+/
                            );
                            if (wordRange) {
                                const wordText = editor.document.getText(wordRange);
                                parameterName = extractScenarioParameterNameFromText(wordText);
                            }
                        }
                    }
                }

                if (!parameterName) {
                    const input = await vscode.window.showInputBox({
                        prompt: t('Enter parameter name to exclude (without brackets).'),
                        placeHolder: 'ExampleParameter'
                    });
                    if (!input) {
                        return;
                    }
                    parameterName = extractScenarioParameterNameFromText(input);
                }

                if (!parameterName) {
                    vscode.window.showWarningMessage(t('Parameter name cannot be empty.'));
                    return;
                }

                const config = vscode.workspace.getConfiguration('kotTestToolkit');
                const existing = config.get<string[]>('editor.scenarioParameterExclusions', []) || [];
                if (existing.includes(parameterName)) {
                    vscode.window.showInformationMessage(t('Parameter "{0}" is already in exclusions.', parameterName));
                    return;
                }

                const target = vscode.workspace.workspaceFolders?.length
                    ? vscode.ConfigurationTarget.Workspace
                    : vscode.ConfigurationTarget.Global;

                await config.update(
                    'editor.scenarioParameterExclusions',
                    [...existing, parameterName],
                    target
                );
                vscode.window.showInformationMessage(t('Added "{0}" to scenario parameter exclusions.', parameterName));
            } catch (error) {
                console.error('[Extension] addScenarioParameterExclusion failed:', error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(t('Failed to add scenario parameter exclusion: {0}', errorMessage));
            }
        }
    ));

    // Регистрируем провайдер настроек
    const settingsProvider = SettingsProvider.getInstance(context);
    settingsProvider.registerSettingsProvider();

    // Добавляем автоматические операции после сохранения YAML файлов
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            // Проверяем, что это YAML файл сценария
            if (document.languageId === 'yaml' || document.fileName.toLowerCase().endsWith('.yaml')) {
                if (!isScenarioYamlFile(document)) {
                    return; // Пропускаем файлы, которые не являются сценариями
                }

                const fileKey = document.uri.toString();
                const currentSnapshot = buildScenarioSaveSnapshot(document);
                const lastSavedSnapshot = lastSavedScenarioSnapshots.get(fileKey);
                const dirtyFlags = scenarioDirtyFlagsByUri.get(fileKey)
                    ?? calculateScenarioDirtyFlags(currentSnapshot, lastSavedSnapshot);
                scenarioDirtyFlagsByUri.set(fileKey, dirtyFlags);

                // Debounce mechanism: prevent double processing from VS Code auto-save
                if (processingFiles.has(fileKey)) {
                    console.log(`[Extension] Skipping processing for ${document.fileName} - already in progress`);
                    setScenarioSnapshotAsSaved(document, currentSnapshot);
                    return;
                }

                processingFiles.add(fileKey);

                // Auto-cleanup after 5 seconds to prevent memory leaks
                setTimeout(() => {
                    processingFiles.delete(fileKey);
                }, 5000);
                const config = vscode.workspace.getConfiguration('kotTestToolkit');
                
                // Проверяем, какие операции нужно выполнить
                const enabledOperations: string[] = [];
                
                const tabsEnabled = config.get<boolean>('editor.autoReplaceTabsWithSpacesOnSave', true);
                const alignTablesEnabled = config.get<boolean>('editor.autoAlignGherkinTablesOnSave', true);
                const alignNestedCallParamsEnabled = config.get<boolean>('editor.autoAlignNestedScenarioParametersOnSave', true);
                const nestedEnabled = config.get<boolean>('editor.autoFillNestedScenariosOnSave', true);
                const paramsEnabled = config.get<boolean>('editor.autoFillScenarioParametersOnSave', true);
                const showRefillMessages = config.get<boolean>('editor.showRefillMessages', true);
                
                if (tabsEnabled && document.getText().includes('\t')) {
                    enabledOperations.push('tabs');
                }
                if (alignTablesEnabled) {
                    enabledOperations.push('alignTables');
                }
                if (alignNestedCallParamsEnabled) {
                    enabledOperations.push('alignNested');
                }
                if (nestedEnabled && dirtyFlags.calledScenariosChanged) {
                    enabledOperations.push('nested');
                }
                if (paramsEnabled && dirtyFlags.usedParametersChanged) {
                    enabledOperations.push('params');
                }

                const shouldUpsertScenarioCache =
                    dirtyFlags.nameChanged ||
                    dirtyFlags.calledScenariosChanged ||
                    dirtyFlags.usedParametersChanged;
                if (shouldUpsertScenarioCache) {
                    phaseSwitcherProvider.upsertScenarioCacheEntryFromDocument(document);
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
                        let testCache = phaseSwitcherProvider.getTestCache();
                        
                        try {
                            // 1. Замена табов на пробелы
                            if (enabledOperations.includes('tabs')) {
                                progress.report({ 
                                    increment: (100 / totalSteps), 
                                    message: t('Replacing tabs with spaces...') 
                                });
                                
                                const fullText = document.getText();
                                const newText = fullText.replace(/^\t+/gm, (match) => '    '.repeat(match.length));
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

                            // 2. Выравнивание таблиц Gherkin
                            if (enabledOperations.includes('alignTables')) {
                                progress.report({
                                    increment: (100 / totalSteps),
                                    message: t('Aligning Gherkin tables...')
                                });

                                const result = await alignGherkinTables(document);
                                if (result) {
                                    completedOperations.push('alignTables');
                                }
                            }

                            // 3. Выравнивание параметров вызовов вложенных сценариев
                            if (enabledOperations.includes('alignNested')) {
                                progress.report({
                                    increment: (100 / totalSteps),
                                    message: t('Aligning nested scenario parameters...')
                                });

                                const result = await alignNestedScenarioCallParameters(document);
                                if (result) {
                                    completedOperations.push('alignNested');
                                }
                            }

                            // 4. Заполнение NestedScenarios
                            if (enabledOperations.includes('nested')) {
                                progress.report({ 
                                    increment: (100 / totalSteps), 
                                    message: t('Filling nested scenarios...') 
                                });

                                if (shouldUpsertScenarioCache) {
                                    phaseSwitcherProvider.upsertScenarioCacheEntryFromDocument(document);
                                }
                                testCache = phaseSwitcherProvider.getTestCache();
                                if (!testCache) {
                                    await phaseSwitcherProvider.initializeTestCache();
                                    testCache = phaseSwitcherProvider.getTestCache();
                                }
                                const result = await clearAndFillNestedScenarios(document, true, testCache);
                                if (result) {
                                    completedOperations.push('nested');
                                }
                            }

                            // 5. Заполнение ScenarioParameters
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

                            const postProcessSnapshot = buildScenarioSaveSnapshot(document);
                            setScenarioSnapshotAsSaved(document, postProcessSnapshot);

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
                } else {
                    setScenarioSnapshotAsSaved(document, currentSnapshot);
                    processingFiles.delete(fileKey);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            const fileKey = document.uri.toString();
            lastSavedScenarioSnapshots.delete(fileKey);
            scenarioDirtyFlagsByUri.delete(fileKey);
            clearScenarioParameterSessionCache(document);
        })
    );

    // Инициализируем загрузку шагов Gherkin
    completionProvider.refreshSteps();
    hoverProvider.refreshSteps();

    console.log('kotTestToolkit commands and providers registered.');
}

/**
 * Builds a completion message based on completed operations
 */
async function buildCompletionMessage(completedOperations: string[], t: (key: string, ...args: string[]) => string, showRefillMessages: boolean): Promise<string> {
    const messages: string[] = [];
    
    if (completedOperations.includes('tabs')) {
        messages.push(t('tabs replaced'));
    }
    if (completedOperations.includes('alignTables')) {
        messages.push(t('Gherkin tables aligned'));
    }
    if (completedOperations.includes('alignNested')) {
        messages.push(t('nested scenario call parameters aligned'));
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
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
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
     console.log('kotTestToolkit extension deactivated.');
}
