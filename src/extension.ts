import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { DriveCompletionProvider } from './completionProvider';
import { DriveHoverProvider } from './hoverProvider';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { 
    openMxlFileFromTextHandler, 
    openMxlFileFromExplorerHandler,
    revealFileInExplorerHandler, 
    revealFileInOSHandler,
    openSubscenarioHandler,
    openNestedScenarioFromFeatureHandler,
    openScenarioByNameHandler,
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
    parseUsedParametersFromScriptBody,
    shouldRefillNestedScenariosSection,
    shouldRefillScenarioParametersSection
} from './commandHandlers';
import { getTranslator } from './localization';
import { setExtensionUri } from './appContext';
import { handleCreateNestedScenario, handleCreateMainScenario } from './scenarioCreator';
import { TestInfo } from './types'; // Импортируем TestInfo
import { SettingsProvider } from './settingsProvider';
import { ScenarioDiagnosticsProvider } from './scenarioDiagnostics';
import { isScenarioYamlFile } from './yamlValidator';
import { ScenarioHeaderInlayHintsProvider } from './scenarioHeaderInlayHintsProvider';
import {
    extractTopLevelKotMetadataBlock,
    migrateLegacyPhaseSwitcherMetadata,
    parsePhaseSwitcherMetadata,
    shouldKeepCachedKotMetadataBlock
} from './phaseSwitcherMetadata';

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

interface ScenarioRepairFailure {
    uri: vscode.Uri;
    reason: string;
}

interface CriticalScenarioSectionPresence {
    hasScenarioText: boolean;
    hasScenarioParameters: boolean;
    hasNestedScenarios: boolean;
}

const lastSavedScenarioSnapshots = new Map<string, ScenarioSaveSnapshot>();
const scenarioDirtyFlagsByUri = new Map<string, ScenarioDirtyFlags>();
const scenarioMetadataBlockSessionCache = new Map<string, string>();
const internallyTriggeredSaves = new Set<string>();
const pendingBackgroundScenarioFiles = new Set<string>();
const kotDescriptionBlockLineRegex = /^Описание:\s*[|>][-+0-9]*\s*$/;
const FAVORITE_SCENARIO_DROP_MIME = 'application/x-kot-favorite-scenario-uri';
const execFileAsync = promisify(execFile);

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasTopLevelScenarioSection(documentText: string, sectionName: string): boolean {
    const lines = documentText.split(/\r\n|\r|\n/);
    const sectionRegex = new RegExp(`^${escapeRegexLiteral(sectionName)}:\\s*(?:\\|[>+-0-9]*)?\\s*$`);

    for (const line of lines) {
        const normalizedLine = normalizeLeadingTabsForDescription(line);
        if (getDescriptionLineIndent(normalizedLine) !== 0) {
            continue;
        }

        const trimmedNoBom = stripBomFromLine(normalizedLine).trim();
        if (sectionRegex.test(trimmedNoBom)) {
            return true;
        }
    }

    return false;
}

function collectCriticalScenarioSectionPresence(documentText: string): CriticalScenarioSectionPresence {
    return {
        hasScenarioText: hasTopLevelScenarioSection(documentText, 'ТекстСценария'),
        hasScenarioParameters: hasTopLevelScenarioSection(documentText, 'ПараметрыСценария'),
        hasNestedScenarios: hasTopLevelScenarioSection(documentText, 'ВложенныеСценарии')
    };
}

function getMissingCriticalScenarioSections(beforeText: string, afterText: string): string[] {
    const beforePresence = collectCriticalScenarioSectionPresence(beforeText);
    const afterPresence = collectCriticalScenarioSectionPresence(afterText);
    const missingSections: string[] = [];

    if (beforePresence.hasScenarioText && !afterPresence.hasScenarioText) {
        missingSections.push('ТекстСценария');
    }
    if (beforePresence.hasScenarioParameters && !afterPresence.hasScenarioParameters) {
        missingSections.push('ПараметрыСценария');
    }
    if (beforePresence.hasNestedScenarios && !afterPresence.hasNestedScenarios) {
        missingSections.push('ВложенныеСценарии');
    }

    return missingSections;
}

async function collectGitModifiedYamlUris(workspaceRootFsPath: string): Promise<vscode.Uri[]> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            [
                '-c',
                'core.quotepath=false',
                'status',
                '--porcelain',
                '-z',
                '--untracked-files=no',
                '--',
                ':(glob)**/*.yaml'
            ],
            {
                cwd: workspaceRootFsPath,
                windowsHide: true,
                maxBuffer: 10 * 1024 * 1024
            }
        );

        const uris: vscode.Uri[] = [];
        const entries = stdout.split('\0');
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (!entry || entry.length < 3) {
                continue;
            }

            // format with -z:
            // normal: XY<space>path
            // rename/copy: XY<space>oldPath\0newPath
            const status = entry.slice(0, 2);
            // Skip deleted files
            const indexStatus = status[0];
            const worktreeStatus = status[1];
            if (indexStatus === 'D' || worktreeStatus === 'D') {
                continue;
            }

            let relativePath = entry.slice(3);
            const isRenameOrCopy =
                indexStatus === 'R' ||
                indexStatus === 'C' ||
                worktreeStatus === 'R' ||
                worktreeStatus === 'C';
            if (isRenameOrCopy) {
                const renamedPath = entries[index + 1];
                if (!renamedPath) {
                    continue;
                }
                relativePath = renamedPath;
                index++;
            }

            if (!relativePath) {
                continue;
            }

            const normalizedRelativePath = relativePath.replace(/\//g, path.sep);
            const absolutePath = path.resolve(workspaceRootFsPath, normalizedRelativePath);
            uris.push(vscode.Uri.file(absolutePath));
        }

        return uris;
    } catch {
        return [];
    }
}

async function collectAllYamlSourceDirectoryScenarioUris(): Promise<vscode.Uri[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return [];
    }

    const excludePattern = '**/{node_modules,.git,out,dist,.vscode/kot-runtime}/**';
    const uriByKey = new Map<string, vscode.Uri>();
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const configuredYamlSourceDirectory = (config.get<string>('paths.yamlSourceDirectory') || 'tests/RegressionTests/yaml').trim();

    for (const workspaceFolder of workspaceFolders) {
        const yamlSourceDirectoryPath = path.isAbsolute(configuredYamlSourceDirectory)
            ? configuredYamlSourceDirectory
            : path.resolve(workspaceFolder.uri.fsPath, configuredYamlSourceDirectory);

        const yamlFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(yamlSourceDirectoryPath, '**/*.yaml'),
            excludePattern
        );

        for (const fileUri of yamlFiles) {
            uriByKey.set(fileUri.toString(), fileUri);
        }
    }

    return Array.from(uriByKey.values());
}

function isMainScenarioDocument(document: vscode.TextDocument | undefined): boolean {
    if (!document || !isScenarioYamlFile(document)) {
        return false;
    }
    return parsePhaseSwitcherMetadata(document.getText()).hasTab;
}

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

function updateScenarioMetadataBlockSessionCache(document: vscode.TextDocument): void {
    const fileKey = document.uri.toString();
    const metadataBlock = extractTopLevelKotMetadataBlock(document.getText());
    if (!metadataBlock) {
        return;
    }

    const existingCachedBlock = scenarioMetadataBlockSessionCache.get(fileKey);
    if (shouldKeepCachedKotMetadataBlock(existingCachedBlock, metadataBlock)) {
        return;
    }

    scenarioMetadataBlockSessionCache.set(fileKey, metadataBlock);
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

    // --- Регистрация Провайдера для Webview (Test Manager) ---
    const phaseSwitcherProvider = new PhaseSwitcherProvider(context.extensionUri, context);
    let batchProcessingInProgress = false;
    let scenarioRepairCancellationSource: vscode.CancellationTokenSource | null = null;
    const updateActiveScenarioContext = async (editor?: vscode.TextEditor) => {
        const isScenario = !!(editor && isScenarioYamlFile(editor.document));
        const isInFavorites = !!(
            isScenario &&
            editor &&
            phaseSwitcherProvider.isScenarioUriInFavorites(editor.document.uri)
        );
        const isMainScenario = !!(isScenario && editor && isMainScenarioDocument(editor.document));

        await Promise.all([
            vscode.commands.executeCommand('setContext', 'kotTestToolkit.activeScenarioInFavorites', isInFavorites),
            vscode.commands.executeCommand('setContext', 'kotTestToolkit.activeScenarioIsMain', isMainScenario)
        ]);
    };
    void updateActiveScenarioContext(vscode.window.activeTextEditor);
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
    const hoverProvider = new DriveHoverProvider(context, phaseSwitcherProvider);
    const completionAndHoverSelector: vscode.DocumentSelector = [
        { pattern: '**/*.yaml', scheme: 'file' },
        { pattern: '**/*.feature', scheme: 'file' }
    ];
    
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            completionAndHoverSelector,
            completionProvider,
            ' ', '.', ',', ':', ';', '(', ')', '"', "'", '$', '!',
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
            completionAndHoverSelector,
            hoverProvider
        )
    );
    context.subscriptions.push(
        vscode.languages.registerDocumentDropEditProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            {
                async provideDocumentDropEdits(document, position, dataTransfer) {
                    if (!isScenarioYamlFile(document)) {
                        return undefined;
                    }

                    const uriItem = dataTransfer.get(FAVORITE_SCENARIO_DROP_MIME);
                    if (!uriItem) {
                        return undefined;
                    }

                    const scenarioUriRaw = (await uriItem.asString()).trim();
                    if (!scenarioUriRaw) {
                        return undefined;
                    }

                    const insertText = await phaseSwitcherProvider.buildNestedScenarioCallInsertTextForUri(
                        scenarioUriRaw,
                        document,
                        position
                    );
                    if (!insertText) {
                        return undefined;
                    }

                    return new vscode.DocumentDropEdit(
                        insertText,
                        vscode.l10n.t('Insert nested scenario call with parameters'),
                        vscode.DocumentDropOrPasteEditKind.Text.append('kotFavoriteScenario')
                    );
                }
            },
            {
                dropMimeTypes: [FAVORITE_SCENARIO_DROP_MIME],
                providedDropEditKinds: [vscode.DocumentDropOrPasteEditKind.Text.append('kotFavoriteScenario')]
            }
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
    context.subscriptions.push(
        vscode.languages.registerInlayHintsProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            new ScenarioHeaderInlayHintsProvider()
        )
    );

    const kotDescriptionTextDecorationType = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('editorInfo.foreground')
    });
    context.subscriptions.push(kotDescriptionTextDecorationType);

    // Seed per-file session caches for currently open scenario documents.
    vscode.workspace.textDocuments.forEach(document => {
        if (!document.isUntitled && isScenarioYamlFile(document)) {
            setScenarioSnapshotAsSaved(document);
            updateScenarioMetadataBlockSessionCache(document);
        }
    });
    updateKotDescriptionDecorationsForVisibleEditors(kotDescriptionTextDecorationType);

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (document.isUntitled || !isScenarioYamlFile(document)) {
            return;
        }

        setScenarioSnapshotAsSaved(document);
        updateScenarioMetadataBlockSessionCache(document);
        updateKotDescriptionDecorationsForDocument(document, kotDescriptionTextDecorationType);
        if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
            void updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        const document = event.document;
        if (document.isUntitled || !isScenarioYamlFile(document)) {
            return;
        }

        updateKotDescriptionDecorationsForDocument(document, kotDescriptionTextDecorationType);
        const fileKey = document.uri.toString();
        const currentSnapshot = buildScenarioSaveSnapshot(document);
        const lastSavedSnapshot = lastSavedScenarioSnapshots.get(fileKey);
        scenarioDirtyFlagsByUri.set(fileKey, calculateScenarioDirtyFlags(currentSnapshot, lastSavedSnapshot));
        if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
            void updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    }));

    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
        updateKotDescriptionDecorationsForVisibleEditors(kotDescriptionTextDecorationType);
    }));


    // --- Регистрация Команд ---
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.openSubscenario', (editor, edit) => openSubscenarioHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.openNestedScenarioFromFeature',
        (editor, edit) => openNestedScenarioFromFeatureHandler(editor, edit, phaseSwitcherProvider)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openScenarioByName',
        async (scenarioName: unknown) => {
            if (typeof scenarioName !== 'string') {
                return;
            }
            await openScenarioByNameHandler(scenarioName, phaseSwitcherProvider);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openRunScenarioLog',
        async (scenarioName: unknown) => {
            if (typeof scenarioName !== 'string') {
                return;
            }
            await phaseSwitcherProvider.openRunScenarioLogFromCommand(scenarioName);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openFailedNestedScenarioFromRun',
        async (scenarioName: unknown) => {
            if (typeof scenarioName !== 'string') {
                return;
            }
            await phaseSwitcherProvider.openFailedNestedScenarioFromCommand(scenarioName);
        }
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


    // Команда для обновления Test Manager (вызывается из scenarioCreator)
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.refreshPhaseSwitcherFromCreate', async () => {
            console.log('[Extension] Command kotTestToolkit.refreshPhaseSwitcherFromCreate invoked.');
            await phaseSwitcherProvider.refreshPanelData();
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
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
                // которое должно сработать, если пользователь нажмет "Обновить" в панели Test Manager.
                // Если нужно принудительное обновление сценариев здесь, то нужно будет вызвать
                // логику сканирования сценариев и затем completionProvider.updateScenarioCompletions().
                // Пока что команда `refreshGherkinSteps` обновляет только Gherkin.
                // Обновление сценариев происходит через Test Manager UI.

            } catch (error: any) {
                console.error("[refreshGherkinSteps Command] Error during refresh:", error.message);
            }
        });
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            foldSectionsInEditor(editor);
            phaseSwitcherProvider.handleActiveEditorChanged(editor);
            void updateActiveScenarioContext(editor);
            if (editor) {
                updateKotDescriptionDecorationForEditor(editor, kotDescriptionTextDecorationType);
            }
        })
    );
    if (vscode.window.activeTextEditor) {
        foldSectionsInEditor(vscode.window.activeTextEditor);
        phaseSwitcherProvider.handleActiveEditorChanged(vscode.window.activeTextEditor);
        void updateActiveScenarioContext(vscode.window.activeTextEditor);
        updateKotDescriptionDecorationForEditor(vscode.window.activeTextEditor, kotDescriptionTextDecorationType);
    } else {
        phaseSwitcherProvider.handleActiveEditorChanged(undefined);
        void updateActiveScenarioContext(undefined);
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

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openScenarioInVanessaManual',
        async () => {
            await phaseSwitcherProvider.openScenarioInVanessaManualFromCommandPalette();
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.processQueuedScenarioFiles',
        async () => {
            await runScenarioRepairBatch('changed');
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.processAllScenarioFiles',
        async () => {
            await runScenarioRepairBatch('all');
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.cancelScenarioRepair',
        async () => {
            const t = await getTranslator(context.extensionUri);
            if (!batchProcessingInProgress || !scenarioRepairCancellationSource) {
                vscode.window.showInformationMessage(t('No scenario repair is currently running.'));
                return;
            }

            if (!scenarioRepairCancellationSource.token.isCancellationRequested) {
                scenarioRepairCancellationSource.cancel();
                phaseSwitcherProvider.setScenarioRepairCancelling(true);
            }
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.toggleActiveScenarioFavorite',
        async () => {
            await phaseSwitcherProvider.toggleFavoriteForActiveScenario();
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.addActiveScenarioToFavorites',
        async () => {
            await phaseSwitcherProvider.addActiveScenarioToFavorites();
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.removeActiveScenarioFromFavorites',
        async () => {
            await phaseSwitcherProvider.removeActiveScenarioFromFavorites();
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.showFavoriteScenarios',
        async () => {
            await phaseSwitcherProvider.showFavoriteScenariosPicker();
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeNestedScenarioCode',
        async () => {
            await phaseSwitcherProvider.changeNestedScenarioCodeForActiveEditor();
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeNestedScenarioName',
        async () => {
            await phaseSwitcherProvider.changeNestedScenarioNameForActiveEditor();
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.renameScenarioFromEditor',
        async () => {
            await phaseSwitcherProvider.renameScenarioForActiveEditor();
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit._addScenarioFavoriteByUri',
        async (target?: vscode.Uri | string) => {
            if (!target) {
                return false;
            }
            const result = await phaseSwitcherProvider.addScenarioToFavoritesByUri(target, { silent: true });
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
            return result;
        }
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

    const writeScenarioRepairFailureReport = async (
        mode: 'changed' | 'all',
        cancelled: boolean,
        changedCount: number,
        unchangedCount: number,
        failedCount: number,
        failures: ScenarioRepairFailure[],
        t: (key: string, ...args: string[]) => string
    ): Promise<vscode.Uri | null> => {
        if (failedCount <= 0 || failures.length === 0) {
            return null;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        const reportBaseUri = workspaceRoot?.scheme === 'file'
            ? vscode.Uri.joinPath(workspaceRoot, '.vscode', 'kot-runtime', 'scenario-repair')
            : vscode.Uri.joinPath(vscode.Uri.file(os.tmpdir()), 'kot-test-toolkit', 'scenario-repair');

        await vscode.workspace.fs.createDirectory(reportBaseUri);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const reportUri = vscode.Uri.joinPath(reportBaseUri, `scenario-repair-${mode}-${timestamp}.md`);

        const modeText = mode === 'all'
            ? t('All scenarios in yamlSourceDirectory')
            : t('Changed scenarios');
        const statusText = cancelled ? t('Cancelled') : t('Completed');
        const lines: string[] = [
            `# ${t('Scenario repair failed files report')}`,
            '',
            `- ${t('Mode')}: ${modeText}`,
            `- ${t('Status')}: ${statusText}`,
            `- ${t('Updated')}: ${changedCount}`,
            `- ${t('Unchanged')}: ${unchangedCount}`,
            `- ${t('Failed')}: ${failedCount}`,
            '',
            `## ${t('Failed files')}`,
            ''
        ];

        failures.forEach((failure, index) => {
            const displayPath = failure.uri.scheme === 'file' ? failure.uri.fsPath : failure.uri.toString();
            lines.push(`${index + 1}. \`${displayPath}\``);
            lines.push(`   - ${t('Reason')}: ${failure.reason}`);
            lines.push(`   - [${t('Open file')}](${failure.uri.toString()})`);
            lines.push('');
        });

        const reportContent = lines.join('\n');
        await vscode.workspace.fs.writeFile(reportUri, Buffer.from(reportContent, 'utf8'));
        return reportUri;
    };

    const runScenarioRepairBatch = async (mode: 'changed' | 'all') => {
        const t = await getTranslator(context.extensionUri);
        if (batchProcessingInProgress) {
            vscode.window.showInformationMessage(t('Scenario repair is already running.'));
            return;
        }

        const runRepairAction = mode === 'all' ? t('Run full repair') : t('Run repair');
        const confirmationMessageLines: string[] = [
            mode === 'all'
                ? t('Run full scenario repair?')
                : t('Run repair for changed scenarios?'),
            '',
            mode === 'all'
                ? t('Scope: all scenario files in configured YAML source directory.')
                : t('Scope: changed scenario files from pending queue and git modified files.'),
            mode === 'all'
                ? t('Warning: this operation may create high load on large projects.')
                : t('Load: optimized for changed files only.'),
            '',
            t('The command will:'),
            t('- replace tabs with spaces (if enabled);'),
            t('- align Gherkin tables (if enabled);'),
            t('- align nested scenario call parameters (if enabled);'),
            t('- refill NestedScenarios and ScenarioParameters sections (if enabled);'),
            t('- ensure KOT metadata Description block for scenarios;'),
            t('- migrate legacy # PhaseSwitcher_* tags into KOT metadata for main scenarios (if enabled);'),
            t('- validate critical sections and rollback file on unsafe result;'),
            t('- save updated files and refresh Test Manager data.')
        ];
        const confirmation = await vscode.window.showWarningMessage(
            confirmationMessageLines.join('\n'),
            { modal: true },
            runRepairAction
        );
        if (confirmation !== runRepairAction) {
            return;
        }

        const candidateUrisByKey = new Map<string, vscode.Uri>();
        if (mode === 'changed') {
            for (const rawUri of pendingBackgroundScenarioFiles) {
                try {
                    const parsedUri = vscode.Uri.parse(rawUri);
                    candidateUrisByKey.set(parsedUri.toString(), parsedUri);
                } catch {
                    // skip invalid cached URI
                }
            }

            const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
            for (const workspaceFolder of workspaceFolders) {
                if (workspaceFolder.uri.scheme !== 'file') {
                    continue;
                }
                const gitModifiedUris = await collectGitModifiedYamlUris(workspaceFolder.uri.fsPath);
                for (const gitUri of gitModifiedUris) {
                    candidateUrisByKey.set(gitUri.toString(), gitUri);
                }
            }
        } else {
            const allYamlUris = await collectAllYamlSourceDirectoryScenarioUris();
            for (const yamlUri of allYamlUris) {
                candidateUrisByKey.set(yamlUri.toString(), yamlUri);
            }
        }

        const candidateUris = Array.from(candidateUrisByKey.values());
        if (candidateUris.length === 0) {
            vscode.window.showInformationMessage(
                mode === 'all'
                    ? t('No scenario YAML files found in configured YAML source directory.')
                    : t('No changed scenario files to repair.')
            );
            return;
        }

        const cancellationSource = new vscode.CancellationTokenSource();
        scenarioRepairCancellationSource = cancellationSource;
        batchProcessingInProgress = true;
        phaseSwitcherProvider.setScenarioRepairInProgress(true, false);

        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const tabsEnabled = config.get<boolean>('editor.autoReplaceTabsWithSpacesOnSave', true);
        const alignTablesEnabled = config.get<boolean>('editor.autoAlignGherkinTablesOnSave', true);
        const alignNestedCallParamsEnabled = config.get<boolean>('editor.autoAlignNestedScenarioParametersOnSave', true);
        const nestedEnabled = config.get<boolean>('editor.autoFillNestedScenariosOnSave', true);
        const paramsEnabled = config.get<boolean>('editor.autoFillScenarioParametersOnSave', true);
        const autoEnsureKotMetadataForAllScenariosEnabled = config.get<boolean>(
            'editor.autoEnsureKotMetadataForMainScenarios',
            true
        );
        const legacyMetadataMigrationForMainScenariosEnabled = config.get<boolean>(
            'editor.enableLegacyMetadataMigrationForMainScenarios',
            false
        ) && autoEnsureKotMetadataForAllScenariosEnabled;

        let changedCount = 0;
        let unchangedCount = 0;
        let failedCount = 0;
        let cancelled = false;
        const failedFiles: ScenarioRepairFailure[] = [];

        try {
            let testCache = phaseSwitcherProvider.getTestCache();
            if (!testCache && nestedEnabled) {
                await phaseSwitcherProvider.initializeTestCache();
                testCache = phaseSwitcherProvider.getTestCache();
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: mode === 'all'
                    ? t('Repairing all scenario files in configured YAML source directory...')
                    : t('Repairing changed scenario files...'),
                cancellable: true
            }, async (progress, progressToken) => {
                const cancelOnProgress = progressToken.onCancellationRequested(() => {
                    cancellationSource.cancel();
                    phaseSwitcherProvider.setScenarioRepairCancelling(true);
                });

                try {
                    for (let index = 0; index < candidateUris.length; index++) {
                        if (cancellationSource.token.isCancellationRequested) {
                            cancelled = true;
                            break;
                        }

                        const fileUri = candidateUris[index];
                        const fileKey = fileUri.toString();
                        pendingBackgroundScenarioFiles.delete(fileKey);

                        progress.report({
                            increment: 100 / candidateUris.length,
                            message: t('Repairing {0} of {1}', String(index + 1), String(candidateUris.length))
                        });

                        try {
                            const document = await vscode.workspace.openTextDocument(fileUri);
                            if (!isScenarioYamlFile(document)) {
                                unchangedCount++;
                                continue;
                            }

                            if (processingFiles.has(fileKey)) {
                                unchangedCount++;
                                continue;
                            }

                            processingFiles.add(fileKey);
                            try {
                                const originalText = document.getText();

                                if (tabsEnabled && document.getText().includes('\t')) {
                                    const fullText = document.getText();
                                    const newText = fullText.replace(/^\t+/gm, match => '    '.repeat(match.length));
                                    if (newText !== fullText) {
                                        const edit = new vscode.WorkspaceEdit();
                                        edit.replace(
                                            document.uri,
                                            new vscode.Range(document.positionAt(0), document.positionAt(fullText.length)),
                                            newText
                                        );
                                        await vscode.workspace.applyEdit(edit);
                                    }
                                }

                                if (alignTablesEnabled) {
                                    await alignGherkinTables(document);
                                }

                                if (alignNestedCallParamsEnabled) {
                                    await alignNestedScenarioCallParameters(document);
                                }

                                const currentText = document.getText();
                                if (nestedEnabled && shouldRefillNestedScenariosSection(currentText)) {
                                    await clearAndFillNestedScenarios(document, true, testCache);
                                }

                                if (paramsEnabled && shouldRefillScenarioParametersSection(document.getText())) {
                                    await clearAndFillScenarioParameters(document, true);
                                }

                                if (isScenarioYamlFile(document) && autoEnsureKotMetadataForAllScenariosEnabled) {
                                    const migrationSourceText = document.getText();
                                    const cachedMetadataBlock = scenarioMetadataBlockSessionCache.get(fileKey);
                                    const migrationResult = migrateLegacyPhaseSwitcherMetadata(migrationSourceText, {
                                        cachedKotMetadataBlock: cachedMetadataBlock,
                                        migrateLegacyPhaseSwitcherTags:
                                            legacyMetadataMigrationForMainScenariosEnabled && isMainScenarioDocument(document)
                                    });
                                    if (migrationResult.changed) {
                                        const migrationEdit = new vscode.WorkspaceEdit();
                                        migrationEdit.replace(
                                            document.uri,
                                            new vscode.Range(document.positionAt(0), document.positionAt(migrationSourceText.length)),
                                            migrationResult.content
                                        );
                                        await vscode.workspace.applyEdit(migrationEdit);
                                    }
                                }

                                const missingCriticalSections = getMissingCriticalScenarioSections(originalText, document.getText());
                                if (missingCriticalSections.length > 0) {
                                    const rollbackEdit = new vscode.WorkspaceEdit();
                                    const rollbackText = document.getText();
                                    rollbackEdit.replace(
                                        document.uri,
                                        new vscode.Range(document.positionAt(0), document.positionAt(rollbackText.length)),
                                        originalText
                                    );
                                    const rollbackApplied = await vscode.workspace.applyEdit(rollbackEdit);
                                    failedCount++;
                                    failedFiles.push({
                                        uri: document.uri,
                                        reason: rollbackApplied
                                            ? t('Missing critical sections after repair: {0}', missingCriticalSections.join(', '))
                                            : t(
                                                'Missing critical sections after repair and rollback failed: {0}',
                                                missingCriticalSections.join(', ')
                                            )
                                    });
                                    console.error(
                                        `[Extension] Scenario repair aborted for ${document.fileName}: missing critical sections ${missingCriticalSections.join(', ')}.${rollbackApplied ? '' : ' Rollback applyEdit failed.'}`
                                    );
                                    continue;
                                }

                                phaseSwitcherProvider.upsertScenarioCacheEntryFromDocument(document);
                                updateScenarioMetadataBlockSessionCache(document);
                                setScenarioSnapshotAsSaved(document, buildScenarioSaveSnapshot(document));

                                const finalText = document.getText();
                                const netChanged = finalText !== originalText;

                                if (netChanged) {
                                    const expectedTextForSave = finalText;
                                    internallyTriggeredSaves.add(fileKey);
                                    try {
                                        const saved = await document.save();
                                        if (!saved) {
                                            internallyTriggeredSaves.delete(fileKey);
                                            throw new Error('Unable to save scenario file after repair.');
                                        }
                                    } catch (saveError) {
                                        internallyTriggeredSaves.delete(fileKey);
                                        const saveErrorMessage = saveError instanceof Error ? saveError.message : String(saveError);
                                        if (!/Document has been closed/i.test(saveErrorMessage)) {
                                            throw saveError;
                                        }

                                        const reopenedDocument = await vscode.workspace.openTextDocument(fileUri);
                                        if (reopenedDocument.getText() !== expectedTextForSave) {
                                            const reopenedFullText = reopenedDocument.getText();
                                            const reopenEdit = new vscode.WorkspaceEdit();
                                            reopenEdit.replace(
                                                reopenedDocument.uri,
                                                new vscode.Range(
                                                    reopenedDocument.positionAt(0),
                                                    reopenedDocument.positionAt(reopenedFullText.length)
                                                ),
                                                expectedTextForSave
                                            );
                                            const reopenedApplied = await vscode.workspace.applyEdit(reopenEdit);
                                            if (!reopenedApplied) {
                                                throw new Error('Unable to restore pending scenario changes after document close.');
                                            }
                                        }

                                        const documentForRetrySave = await vscode.workspace.openTextDocument(fileUri);
                                        const retrySaveKey = documentForRetrySave.uri.toString();
                                        internallyTriggeredSaves.add(retrySaveKey);
                                        const retrySaved = await documentForRetrySave.save();
                                        if (!retrySaved) {
                                            internallyTriggeredSaves.delete(retrySaveKey);
                                            throw new Error('Unable to save scenario file after reopening.');
                                        }
                                    }
                                    changedCount++;
                                } else {
                                    unchangedCount++;
                                }
                            } finally {
                                processingFiles.delete(fileKey);
                            }
                        } catch (error) {
                            failedCount++;
                            const reason = error instanceof Error ? error.message : String(error);
                            failedFiles.push({
                                uri: fileUri,
                                reason: t('Processing error: {0}', reason)
                            });
                            console.error('[Extension] Failed to repair scenario file:', error);
                        }
                    }
                } finally {
                    cancelOnProgress.dispose();
                }
            });

            let failureReportUri: vscode.Uri | null = null;
            if (failedCount > 0 && failedFiles.length > 0) {
                try {
                    failureReportUri = await writeScenarioRepairFailureReport(
                        mode,
                        cancelled || cancellationSource.token.isCancellationRequested,
                        changedCount,
                        unchangedCount,
                        failedCount,
                        failedFiles,
                        t
                    );
                } catch (error) {
                    const reportError = error instanceof Error ? error.message : String(error);
                    console.error('[Extension] Failed to write scenario repair report:', error);
                    vscode.window.showErrorMessage(t('Unable to generate scenario repair report: {0}', reportError));
                }
            }

            if (cancelled || cancellationSource.token.isCancellationRequested) {
                const cancelledSummary = t(
                    'Scenario repair cancelled. Updated: {0}, unchanged: {1}, failed: {2}.',
                    String(changedCount),
                    String(unchangedCount),
                    String(failedCount)
                );
                if (failureReportUri) {
                    const openReportAction = t('Open report');
                    const choice = await vscode.window.showWarningMessage(
                        `${cancelledSummary} ${t('Failure report generated.')}`,
                        openReportAction
                    );
                    if (choice === openReportAction) {
                        const reportDoc = await vscode.workspace.openTextDocument(failureReportUri);
                        await vscode.window.showTextDocument(reportDoc, { preview: false });
                    }
                } else {
                    vscode.window.showWarningMessage(cancelledSummary);
                }
                return;
            }

            const summary = t(
                'Scenario repair completed. Updated: {0}, unchanged: {1}, failed: {2}.',
                String(changedCount),
                String(unchangedCount),
                String(failedCount)
            );
            if (failedCount > 0) {
                if (failureReportUri) {
                    const openReportAction = t('Open report');
                    const choice = await vscode.window.showWarningMessage(
                        `${summary} ${t('Failure report generated.')}`,
                        openReportAction
                    );
                    if (choice === openReportAction) {
                        const reportDoc = await vscode.workspace.openTextDocument(failureReportUri);
                        await vscode.window.showTextDocument(reportDoc, { preview: false });
                    }
                } else {
                    vscode.window.showWarningMessage(summary);
                }
            } else {
                vscode.window.showInformationMessage(summary);
            }
        } finally {
            batchProcessingInProgress = false;
            if (scenarioRepairCancellationSource) {
                scenarioRepairCancellationSource.dispose();
            }
            scenarioRepairCancellationSource = null;
            phaseSwitcherProvider.setScenarioRepairInProgress(false, false);
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
                if (internallyTriggeredSaves.delete(fileKey)) {
                    phaseSwitcherProvider.upsertScenarioCacheEntryFromDocument(document);
                    updateScenarioMetadataBlockSessionCache(document);
                    setScenarioSnapshotAsSaved(document);
                    return;
                }

                if (processingFiles.has(fileKey)) {
                    setScenarioSnapshotAsSaved(document);
                    return;
                }

                const activeScenarioDocumentUri = vscode.window.activeTextEditor?.document.uri.toString();
                if (activeScenarioDocumentUri !== fileKey) {
                    pendingBackgroundScenarioFiles.add(fileKey);
                    phaseSwitcherProvider.upsertScenarioCacheEntryFromDocument(document);
                    setScenarioSnapshotAsSaved(document);
                    return;
                }

                const config = vscode.workspace.getConfiguration('kotTestToolkit');
                const autoEnsureKotMetadataForAllScenariosEnabled = config.get<boolean>(
                    'editor.autoEnsureKotMetadataForMainScenarios',
                    true
                );
                const legacyMetadataMigrationForMainScenariosEnabled = config.get<boolean>(
                    'editor.enableLegacyMetadataMigrationForMainScenarios',
                    false
                ) && autoEnsureKotMetadataForAllScenariosEnabled;
                processingFiles.add(fileKey);

                try {
                    if (isScenarioYamlFile(document) && autoEnsureKotMetadataForAllScenariosEnabled) {
                        // Migrate KOT metadata only on explicit save flow to avoid heavy work on file open.
                        const cachedMetadataBlock = scenarioMetadataBlockSessionCache.get(fileKey);
                        const migrationResult = migrateLegacyPhaseSwitcherMetadata(document.getText(), {
                            cachedKotMetadataBlock: cachedMetadataBlock,
                            migrateLegacyPhaseSwitcherTags:
                                legacyMetadataMigrationForMainScenariosEnabled && isMainScenarioDocument(document)
                        });
                        if (migrationResult.changed) {
                            const originalText = document.getText();
                            const missingCriticalSectionsAfterMigration = getMissingCriticalScenarioSections(
                                originalText,
                                migrationResult.content
                            );
                            if (missingCriticalSectionsAfterMigration.length > 0) {
                                console.error(
                                    `[Extension] Skipping KOT metadata migration because it would remove critical sections: ${missingCriticalSectionsAfterMigration.join(', ')}.`
                                );
                                processingFiles.delete(fileKey);
                                return;
                            }
                            const fullRange = new vscode.Range(
                                document.positionAt(0),
                                document.positionAt(originalText.length)
                            );
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document.uri, fullRange, migrationResult.content);

                            const applied = await vscode.workspace.applyEdit(edit);
                            if (applied) {
                                phaseSwitcherProvider.upsertScenarioCacheEntryFromDocument(document);
                                updateScenarioMetadataBlockSessionCache(document);
                                setScenarioSnapshotAsSaved(document);

                                const t = await getTranslator(context.extensionUri);
                                vscode.window.showInformationMessage(
                                    t('KOT metadata block was migrated. The file will be saved again.')
                                );

                                internallyTriggeredSaves.add(fileKey);
                                const migratedSaved = await document.save();
                                if (!migratedSaved) {
                                    internallyTriggeredSaves.delete(fileKey);
                                    throw new Error('Unable to save scenario file after KOT metadata migration.');
                                }
                                processingFiles.delete(fileKey);
                                return;
                            }
                        }
                    }
                } catch (migrationError) {
                    console.error('[Extension] Failed to migrate KOT metadata on save:', migrationError);
                }

                const documentText = document.getText();
                const currentSnapshot = buildScenarioSaveSnapshot(document);
                const lastSavedSnapshot = lastSavedScenarioSnapshots.get(fileKey);
                const dirtyFlags = scenarioDirtyFlagsByUri.get(fileKey)
                    ?? calculateScenarioDirtyFlags(currentSnapshot, lastSavedSnapshot);
                scenarioDirtyFlagsByUri.set(fileKey, dirtyFlags);

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
                const nestedSectionOutdated = nestedEnabled
                    ? shouldRefillNestedScenariosSection(documentText)
                    : false;
                const paramsSectionOutdated = paramsEnabled
                    ? shouldRefillScenarioParametersSection(documentText)
                    : false;

                if (nestedEnabled && (dirtyFlags.calledScenariosChanged || nestedSectionOutdated)) {
                    enabledOperations.push('nested');
                }
                if (paramsEnabled && (dirtyFlags.usedParametersChanged || paramsSectionOutdated)) {
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

                            updateScenarioMetadataBlockSessionCache(document);
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
                                        internallyTriggeredSaves.add(fileKey);
                                        const saved = await document.save();
                                        if (!saved) {
                                            internallyTriggeredSaves.delete(fileKey);
                                            console.warn(`[Extension] Save returned false for ${document.fileName} after processing`);
                                        } else {
                                            console.log(`[Extension] Saved ${document.fileName} after processing`);
                                        }
                                    } catch (saveError) {
                                        console.warn(`[Extension] Failed to save ${document.fileName}:`, saveError);
                                        internallyTriggeredSaves.delete(fileKey);
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
                    updateScenarioMetadataBlockSessionCache(document);
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
            scenarioMetadataBlockSessionCache.delete(fileKey);
            internallyTriggeredSaves.delete(fileKey);
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

function normalizeLeadingTabsForDescription(line: string): string {
    return line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
}

function getDescriptionLineIndent(line: string): number {
    const normalized = normalizeLeadingTabsForDescription(line);
    const match = normalized.match(/^(\s*)/);
    return match ? match[1].length : 0;
}

function stripBomFromLine(line: string): string {
    return line.replace(/^\uFEFF/, '');
}

function isIgnorableYamlLine(line: string): boolean {
    const trimmed = stripBomFromLine(line).trim();
    return trimmed.length === 0 || trimmed.startsWith('#');
}

function isYamlKeyLine(trimmedNoBom: string): boolean {
    return /^[^:#][^:]*:\s*(.*)$/.test(trimmedNoBom);
}

function collectKotDescriptionContentRanges(document: vscode.TextDocument): vscode.Range[] {
    const ranges: vscode.Range[] = [];
    let lineIndex = 0;

    while (lineIndex < document.lineCount) {
        const lineText = document.lineAt(lineIndex).text;
        const trimmedNoBom = stripBomFromLine(lineText).trim();

        if (getDescriptionLineIndent(lineText) !== 0 || trimmedNoBom !== 'KOTМетаданные:') {
            lineIndex++;
            continue;
        }

        const metadataIndent = 0;
        lineIndex++;

        while (lineIndex < document.lineCount) {
            const metadataLine = document.lineAt(lineIndex).text;
            const metadataTrimmed = stripBomFromLine(metadataLine).trim();
            const metadataIndentation = getDescriptionLineIndent(metadataLine);

            if (!isIgnorableYamlLine(metadataLine) && metadataIndentation <= metadataIndent && isYamlKeyLine(metadataTrimmed)) {
                break;
            }

            if (metadataIndentation > metadataIndent && kotDescriptionBlockLineRegex.test(metadataTrimmed)) {
                const descriptionIndent = metadataIndentation;
                const descriptionContentIndent = descriptionIndent + 4;
                lineIndex++;

                while (lineIndex < document.lineCount) {
                    const descriptionLine = document.lineAt(lineIndex).text;
                    const descriptionTrimmed = stripBomFromLine(descriptionLine).trim();
                    const descriptionLineIndent = getDescriptionLineIndent(descriptionLine);

                    if (descriptionTrimmed.length > 0 && descriptionLineIndent <= descriptionIndent) {
                        break;
                    }

                    if (descriptionTrimmed.length > 0 && descriptionLineIndent < descriptionContentIndent) {
                        break;
                    }

                    if (descriptionTrimmed.length > 0 && descriptionLineIndent >= descriptionContentIndent) {
                        const firstNonWhitespace = descriptionLine.search(/\S/);
                        if (firstNonWhitespace >= 0) {
                            ranges.push(
                                new vscode.Range(
                                    new vscode.Position(lineIndex, firstNonWhitespace),
                                    new vscode.Position(lineIndex, descriptionLine.length)
                                )
                            );
                        }
                    }

                    lineIndex++;
                }

                continue;
            }

            lineIndex++;
        }
    }

    return ranges;
}

function updateKotDescriptionDecorationForEditor(
    editor: vscode.TextEditor,
    decorationType: vscode.TextEditorDecorationType
): void {
    const document = editor.document;
    if (!isScenarioYamlFile(document)) {
        editor.setDecorations(decorationType, []);
        return;
    }

    const ranges = collectKotDescriptionContentRanges(document);
    editor.setDecorations(decorationType, ranges);
}

function updateKotDescriptionDecorationsForDocument(
    document: vscode.TextDocument,
    decorationType: vscode.TextEditorDecorationType
): void {
    const uriString = document.uri.toString();
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === uriString) {
            updateKotDescriptionDecorationForEditor(editor, decorationType);
        }
    }
}

function updateKotDescriptionDecorationsForVisibleEditors(
    decorationType: vscode.TextEditorDecorationType
): void {
    for (const editor of vscode.window.visibleTextEditors) {
        updateKotDescriptionDecorationForEditor(editor, decorationType);
    }
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
    if (!isScenarioYamlFile(document)) {
        return;
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    const sectionsToFold = ['ВложенныеСценарии', 'ПараметрыСценария'];

    const findTopLevelSectionLine = (sectionName: string): number => {
        const target = `${sectionName}:`;
        for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
            const lineText = document.lineAt(lineIndex).text;
            if (lineText.trim() !== target) {
                continue;
            }
            if ((lineText.match(/^\s*/) || [''])[0].length !== 0) {
                continue;
            }
            return lineIndex;
        }
        return -1;
    };

    const sectionLines: number[] = [];
    for (const sectionName of sectionsToFold) {
        const sectionLine = findTopLevelSectionLine(sectionName);
        if (sectionLine >= 0) {
            sectionLines.push(sectionLine);
        }
    }

    if (sectionLines.length === 0) {
        return;
    }

    if (vscode.window.activeTextEditor?.document.uri.toString() !== document.uri.toString()) {
        return;
    }

    await vscode.commands.executeCommand('editor.fold', {
        levels: 1,
        direction: 'down',
        selectionLines: sectionLines
    });
}

/**
 * Функция деактивации расширения. Вызывается VS Code при выгрузке расширения.
 * Используется для освобождения ресурсов.
 */
export function deactivate() {
     console.log('kotTestToolkit extension deactivated.');
}
