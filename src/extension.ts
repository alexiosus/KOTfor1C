import * as vscode from 'vscode';
import { controlledCodeLenses, controlledInlayHints } from './editorActionControls';
import { registerScenarioPropertiesEditor } from './scenarioPropertiesEditorIntegration';
import { scenarioDefaultFoldLines } from './scenarioYamlEditor';
import { ProcessEditorCodeLensProvider } from './processEditorCodeLens';
import { openProjectMetadata, projectedProjectScenario, watchProjectLibrary } from './projectLibraryIntegration';
import { CompilerYamlBlockCodeLensProvider, addCompilerYamlBlockCommand } from './compilerYamlBlockEditor';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { DriveCompletionProvider } from './completionProvider';
import { DriveHoverProvider } from './hoverProvider';
import { StepCatalogService } from './stepCatalogService';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { StandaloneFeatureService } from './standaloneFeatureService';
import { ProjectFeatureTagCatalog } from './projectFeatureTags';
import {
    openMxlFileFromTextHandler,
    openMxlFileFromExplorerHandler,
    revealFileInExplorerHandler,
    revealFileInOSHandler,
    openCurrentScenarioFilesFolderHandler,
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
import {
    getScenarioScanRootPath,
    initializeScenarioScanRoot,
    onDidChangeScenarioScanRoot,
    resolveScenarioScanRootFsPath
} from './scenarioScanRoot';
import { TestInfo } from './types'; // Импортируем TestInfo
import { SettingsProvider } from './settingsProvider';
import { ScenarioDiagnosticsProvider } from './scenarioDiagnostics';
import {
    collectScenarioBracketParameterRanges,
    collectScenarioPlainTextRanges,
    ScenarioSyntaxHighlightProvider
} from './scenarioSyntaxHighlightProvider';
import { isScenarioYamlFile, isCompilerYamlFile, isProcessYamlFile, isProcessTestSettingsYamlFile } from './yamlValidator';
import { ScenarioHeaderInlayHintsProvider } from './scenarioHeaderInlayHintsProvider';
import {
    handleGenerateConfigurationDiffImpactReport,
    openSavedConfigurationDiffImpactReport
} from './configurationDiffAiReport';
import { handleGenerateScenarioDescriptionWithAi } from './scenarioAiDescription';
import {
    handleReviewChangedTestsWithAi,
    openSavedTestReviewReport
} from './testReviewAiReport';
import type {
    BuildFormExplorerExtensionCommandOptions,
    InstallFormExplorerExtensionCommandOptions
} from './formExplorerExtensionGenerator';
import type {
    StartFormExplorerBridgeCommandOptions
} from './formExplorerBridgeGenerator';
import {
    parsePhaseSwitcherMetadata
} from './phaseSwitcherMetadata';
import {
    normalizeScenarioCallParameterValue,
    parseScenarioParameterDefinitions
} from './scenarioParameterUtils';
import { createDeferredLoader, createDeferredResourceLoader } from './deferredLoader';
import { ProjectDefinitionIndexService } from './projectDefinitionIndexService';
import {
    ProjectDefinitionCache,
    resolveProjectDefinitionCacheDirectory
} from './projectDefinitionCache';
import { resolveProjectLibraryConfiguration } from './projectLibraryRoots';
import { ProjectDefinitionResolver } from './projectDefinitionResolver';
import {
    openProjectDefinitionHandler,
    ProjectDefinitionProvider
} from './projectDefinitionNavigation';
import {
    ProjectDefinitionReferenceProvider,
    ProjectDefinitionReferenceService,
    type ProjectDefinitionReferenceSearchRoot
} from './projectDefinitionReferences';
import {
    createExportScenarioCommand,
    type ExportScenarioLibraryRoot
} from './exportScenarioCommand';
import {
    addExportScenarioMetadataCommand,
    EXPORT_SCENARIO_METADATA_COMMAND,
    ExportScenarioMetadataCodeLensProvider
} from './exportScenarioMetadataCodeLens';
import {
    FeatureEditorCodeLensProvider, FeatureStepTagCodeActionProvider, FeatureStepTagCompletionProvider,
    editFeatureStructureCommand, FEATURE_EDITOR_COMMAND
} from './featureEditorCodeLens';
import { collectNestedScenarioCategories } from './scenarioCategory';
import {
    SCENARIO_CATEGORY_COMMAND,
    ScenarioCategoryCodeLensProvider,
    setScenarioCategoryCommand
} from './scenarioCategoryCodeLens';
import { resolveVanessaTemplateRoot } from './userStepCreator';
import type { UserStepLibraryRoot } from './userStepCommands';
import { ManagedInfobaseService } from './managedInfobaseService';
import { ScenarioRelationshipService } from './scenarioRelationshipService';
import {
    ScenarioRelationshipPresentationService,
    type ScenarioRelationshipSurface
} from './scenarioRelationshipPresentation';
import { TestManagerStatusFilterService } from './testManagerStatusFilter';
import { StepLibrarySnapshotService } from './stepLibrarySnapshotService';
import { buildStepLibraryDropSnippet, STEP_LIBRARY_DEFINITION_DROP_MIME, StepLibraryActionService } from './stepLibraryActions';
import { StepLibrarySidebarProvider } from './stepLibrarySidebarProvider';
import { renameExportScenario } from './featureRenameCommands';
import {
    createDeferredInfobaseSidebarOperations,
    InfobaseSidebarProvider
} from './infobaseSidebarProvider';
import { managedInfobaseRuntimeTracker } from './infobaseRuntimeTracker';
import { StepLibraryFavoritesService } from './stepLibraryFavorites';
import { deleteFileWithTrashFallback, ScenarioFilesService } from './scenarioFilesService';

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
const internallyTriggeredSaves = new Set<string>();
const pendingBackgroundScenarioFiles = new Set<string>();
const kotDescriptionBlockLineRegex = /^Описание:\s*[|>][-+0-9]*\s*$/;
const FAVORITE_SCENARIO_DROP_MIME = 'application/x-kot-favorite-scenario-uri';
const execFileAsync = promisify(execFile);
const loadFormExplorerExtensionGenerator = createDeferredLoader(
    () => import('./formExplorerExtensionGenerator.js')
);
const loadFormExplorerBridgeGenerator = createDeferredLoader(
    () => import('./formExplorerBridgeGenerator.js')
);
const loadScenarioCreator = createDeferredLoader(
    () => import('./scenarioCreator.js')
);
const loadFormExplorerBuilder = createDeferredLoader(
    () => import('./formExplorerBuilder.js')
);
const loadOneCPlatform = createDeferredLoader(
    () => import('./oneCPlatform.js')
);
const loadUserStepCommands = createDeferredLoader(
    () => import('./userStepCommands.js')
);
const GHERKIN_STEP_LINE_REGEX = /^(?:\*\s*)?(?:and|but|then|when|given|if|и|тогда|когда|если|допустим|дано|к тому же|но)\b/i;
const FEATURE_SCENARIO_HEADER_REGEX = /^(?:Scenario|Сценарий|Scenario Outline|Структура сценария|Background|Предыстория)\s*:/i;
const FEATURE_SCENARIO_BLOCK_BREAK_REGEX = /^(?:Feature|Функционал|Rule|Правило|Examples|Примеры)\s*:?/i;
const FEATURE_NON_STEP_LINE_REGEX = /^(?:Feature|Функционал|Rule|Правило|Scenario|Сценарий|Scenario Outline|Структура сценария|Examples|Примеры|Scenarios|Сценарии)\s*:/i;
const FORM_EXPLORER_SUGGEST_RELEVANT_LINE_REGEX = /(window|окн(?:о|а|у|е|ом)?|form|форм(?:а|ы|у|е|ой)?|table|таблиц|grid|spreadsheet\s+document|табличн(?:ый|ого)?\s+документ|field|поле|attribute|атрибут|реквизит|checkbox|флаг|radio\s*button|переключател|drop-?down|dropdown|выпадающ|html\s+(?:document\s+)?field|form\s+item\s+addition|дополнени(?:е|я)\s+формы|button|кнопк|hyperlink|link|гиперссыл|submenu|подменю|element|элемент(?:\s+формы)?|group|групп)/i;
const PROJECT_DEFINITION_PARSER_VERSION = '4';

function createProjectDefinitionIndexService(
    context: vscode.ExtensionContext
): ProjectDefinitionIndexService {
    const workspaceFolderCount = vscode.workspace.workspaceFolders?.length ?? 0;
    return new ProjectDefinitionIndexService({
        parserVersion: PROJECT_DEFINITION_PARSER_VERSION,
        fileSystem: {
            async readDirectory(directoryPath) {
                const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
                return entries
                    .filter(entry => entry.isDirectory() || entry.isFile())
                    .map(entry => ({
                        name: entry.name,
                        type: entry.isDirectory() ? 'directory' as const : 'file' as const
                    }));
            },
            async stat(filePath) {
                const value = await fs.promises.stat(filePath);
                return { size: value.size, mtimeMs: value.mtimeMs };
            },
            readFile: filePath => fs.promises.readFile(filePath, 'utf8'),
            realpath: filePath => fs.promises.realpath(filePath)
        },
        cacheFactory: configuration => new ProjectDefinitionCache(
            resolveProjectDefinitionCacheDirectory({
                storagePath: workspaceFolderCount <= 1 ? context.storageUri?.fsPath : undefined,
                globalStoragePath: context.globalStorageUri.fsPath,
                workspaceFolderUri: configuration.workspaceFolderUri
            })
        ),
        watch: (rootPath, callbacks) => {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(rootPath, '**/*.{feature,bsl,epf}')
            );
            watcher.onDidCreate(uri => callbacks.create(uri.fsPath));
            watcher.onDidChange(uri => callbacks.change(uri.fsPath));
            watcher.onDidDelete(uri => callbacks.delete(uri.fsPath));
            return watcher;
        },
        loadConfigurations: async () => {
            const folders = vscode.workspace.workspaceFolders ?? [];
            if (folders.length === 0) {
                return [];
            }
            const { YamlParametersManager } = await import('./yamlParametersManager.js');
            const profile = await YamlParametersManager.getInstance(context).loadActiveProfileSnapshot();
            return folders.map(folder => {
                const resolved = resolveProjectLibraryConfiguration({
                    workspaceFolderPath: folder.uri.fsPath,
                    workspaceFolderUri: folder.uri.toString(),
                    profileId: profile.id,
                    buildParameters: profile.buildParameters,
                    additionalVanessaParameters: profile.additionalVanessaParameters
                });
                return {
                    identity: resolved.identity,
                    workspaceFolderPath: resolved.workspaceFolderPath,
                    workspaceFolderUri: folder.uri.toString(),
                    profileId: resolved.profileId,
                    libraryRootPaths: resolved.libraryRootPaths,
                    warnings: resolved.warnings
                };
            });
        },
        watchConfigurations: async listener => {
            const { YamlParametersManager } = await import('./yamlParametersManager.js');
            return YamlParametersManager.getInstance(context).onDidChangeActiveProfile(listener);
        },
        directoryConcurrency: 8,
        readConcurrency: 4,
        yieldEvery: 24,
        yieldControl: () => new Promise(resolve => setImmediate(resolve)),
        log: message => console.warn(`[ProjectDefinitionIndex] ${message}`)
    });
}

async function loadExportScenarioLibraryRoots(
    context: vscode.ExtensionContext,
    resourceUriValue?: string
): Promise<readonly ExportScenarioLibraryRoot[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    let resourceFolder: vscode.WorkspaceFolder | undefined;
    if (resourceUriValue) {
        try {
            resourceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(resourceUriValue));
        } catch {
            // Fall back to all workspace folders for a stale Quick Fix resource.
        }
    }
    const folders = resourceFolder ? [resourceFolder] : workspaceFolders;
    if (folders.length === 0) {
        return [];
    }
    const { YamlParametersManager } = await import('./yamlParametersManager.js');
    const profile = await YamlParametersManager.getInstance(context).loadActiveProfileSnapshot();
    const result: ExportScenarioLibraryRoot[] = [];
    const seen = new Set<string>();
    for (const folder of folders) {
        const configuration = resolveProjectLibraryConfiguration({
            workspaceFolderPath: folder.uri.fsPath,
            workspaceFolderUri: folder.uri.toString(),
            profileId: profile.id,
            buildParameters: profile.buildParameters,
            additionalVanessaParameters: profile.additionalVanessaParameters
        });
        for (const rootPath of configuration.libraryRootPaths) {
            const uri = vscode.Uri.file(rootPath).toString();
            if (seen.has(uri)) {
                continue;
            }
            seen.add(uri);
            result.push(Object.freeze({
                uri,
                label: workspaceFolders.length > 1
                    ? `${folder.name}: ${path.basename(rootPath) || rootPath}`
                    : path.basename(rootPath) || rootPath,
                workspaceFolderUri: folder.uri.toString(),
                profileId: profile.id
            }));
        }
    }
    return Object.freeze(result);
}

async function loadUserStepLibraryRoots(
    context: vscode.ExtensionContext,
    resourceUriValue?: string
): Promise<readonly UserStepLibraryRoot[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    let resourceFolder: vscode.WorkspaceFolder | undefined;
    if (resourceUriValue) {
        try {
            resourceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(resourceUriValue));
        } catch {
            // Fall back to all workspace folders for a stale Quick Fix resource.
        }
    }
    const folders = resourceFolder ? [resourceFolder] : workspaceFolders;
    if (folders.length === 0) {
        return [];
    }
    const { YamlParametersManager } = await import('./yamlParametersManager.js');
    const profile = await YamlParametersManager.getInstance(context).loadActiveProfileSnapshot();
    const result: UserStepLibraryRoot[] = [];
    const seen = new Set<string>();
    for (const folder of folders) {
        const configuration = resolveProjectLibraryConfiguration({
            workspaceFolderPath: folder.uri.fsPath,
            workspaceFolderUri: folder.uri.toString(),
            profileId: profile.id,
            buildParameters: profile.buildParameters,
            additionalVanessaParameters: profile.additionalVanessaParameters
        });
        const configuredVanessaEpfPath = vscode.workspace
            .getConfiguration('kotTestToolkit', folder.uri)
            .get<string>('runVanessa.vanessaEpfPath', '');
        const templateRoot = resolveVanessaTemplateRoot({
            workspaceFolderPath: folder.uri.fsPath,
            buildParameters: profile.buildParameters,
            configuredVanessaEpfPath
        });
        for (const rootPath of configuration.libraryRootPaths) {
            const uri = vscode.Uri.file(rootPath).toString();
            if (seen.has(uri)) {
                continue;
            }
            seen.add(uri);
            result.push(Object.freeze({
                path: rootPath,
                uri,
                label: workspaceFolders.length > 1
                    ? `${folder.name}: ${path.basename(rootPath) || rootPath}`
                    : path.basename(rootPath) || rootPath,
                workspaceFolderUri: folder.uri.toString(),
                profileId: profile.id,
                templateRoot
            }));
        }
    }
    return Object.freeze(result);
}

function createProjectDefinitionReferenceService(
    context: vscode.ExtensionContext,
    resolver: ProjectDefinitionResolver,
    includeOpenDocuments = true
): ProjectDefinitionReferenceService {
    return new ProjectDefinitionReferenceService({
        resolver,
        loadSearchRoots: async resource => {
            const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
            const resourceFolder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
            const folders = resourceFolder ? [resourceFolder] : workspaceFolders;
            if (folders.length === 0) {
                return [];
            }
            const { YamlParametersManager } = await import('./yamlParametersManager.js');
            const profile = await YamlParametersManager.getInstance(context).loadActiveProfileSnapshot();
            const roots: ProjectDefinitionReferenceSearchRoot[] = [];
            for (const folder of folders) {
                const configuration = resolveProjectLibraryConfiguration({
                    workspaceFolderPath: folder.uri.fsPath,
                    workspaceFolderUri: folder.uri.toString(),
                    profileId: profile.id,
                    buildParameters: profile.buildParameters,
                    additionalVanessaParameters: profile.additionalVanessaParameters
                });
                roots.push({
                    path: resolveScenarioScanRootFsPath(folder.uri),
                    extensions: ['.yaml', '.yml', '.feature']
                });
                configuration.libraryRootPaths.forEach(rootPath => roots.push({
                    path: rootPath,
                    extensions: ['.feature']
                }));
                configuration.featureFolderPaths.forEach(rootPath => roots.push({
                    path: rootPath,
                    extensions: ['.feature']
                }));
            }
            return roots;
        },
        fileSystem: {
            async realpath(filePath) {
                return fs.promises.realpath(filePath);
            },
            async readDirectory(directoryPath) {
                const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
                return entries
                    .filter(entry => entry.isDirectory() || entry.isFile())
                    .map(entry => ({
                        name: entry.name,
                        type: entry.isDirectory() ? 'directory' as const : 'file' as const
                    }));
            },
            async stat(filePath) {
                const value = await fs.promises.stat(filePath);
                return { size: value.size, mtimeMs: value.mtimeMs };
            },
            readFile: filePath => fs.promises.readFile(filePath, 'utf8'),
            toUri: filePath => vscode.Uri.file(filePath).toString()
        },
        ...(includeOpenDocuments ? {
            getOpenDocuments: () => vscode.workspace.textDocuments
        } : {}),
        directoryConcurrency: 8,
        readConcurrency: 4,
        yieldEvery: 24,
        yieldControl: () => new Promise(resolve => setImmediate(resolve)),
        log: message => console.warn(`[ProjectDefinitionReferences] ${message}`)
    });
}

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isFeatureDocument(document: vscode.TextDocument): boolean {
    return document.fileName.toLowerCase().endsWith('.feature');
}

function isInScenarioTextBlockForAutoSuggest(document: vscode.TextDocument, position: vscode.Position): boolean {
    if (isFeatureDocument(document)) {
        const currentLine = document.lineAt(position.line).text.trim();
        if (!currentLine || currentLine.startsWith('#') || currentLine.startsWith('@') || currentLine.startsWith('|') || currentLine.startsWith('"""')) {
            return false;
        }
        if (FEATURE_NON_STEP_LINE_REGEX.test(currentLine)) {
            return false;
        }

        for (let lineIndex = position.line; lineIndex >= 0; lineIndex -= 1) {
            const trimmed = document.lineAt(lineIndex).text.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) {
                continue;
            }

            if (FEATURE_SCENARIO_HEADER_REGEX.test(trimmed)) {
                return true;
            }

            if (FEATURE_SCENARIO_BLOCK_BREAK_REGEX.test(trimmed)) {
                return false;
            }
        }

        return false;
    }

    if (!isScenarioYamlFile(document)) {
        return false;
    }

    const textUpToPosition = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const scenarioBlockStartRegex = /ТекстСценария:\s*\|?\s*(\r\n|\r|\n)/gm;
    let lastScenarioBlockStartOffset = -1;
    let match: RegExpExecArray | null;
    while ((match = scenarioBlockStartRegex.exec(textUpToPosition)) !== null) {
        lastScenarioBlockStartOffset = match.index + match[0].length;
    }

    if (lastScenarioBlockStartOffset < 0) {
        return false;
    }

    const textAfterLastBlockStart = textUpToPosition.substring(lastScenarioBlockStartOffset);
    for (const line of textAfterLastBlockStart.split(/\r\n|\r|\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }

        if (!line.startsWith(' ') && !line.startsWith('\t') && trimmedLine.includes(':') && !trimmedLine.startsWith('|')) {
            return false;
        }
    }

    return true;
}

function getQuotedTextContextForAutoSuggest(
    lineText: string,
    character: number
): { beforeQuote: string; afterQuote: string } | null {
    const safeCharacter = Math.max(0, Math.min(character, lineText.length));
    let activeQuote: '"' | "'" | null = null;
    let activeQuoteStart = -1;

    for (let index = 0; index < safeCharacter; index += 1) {
        const symbol = lineText[index];
        if (symbol !== '"' && symbol !== '\'') {
            continue;
        }

        if (!activeQuote) {
            activeQuote = symbol;
            activeQuoteStart = index;
            continue;
        }

        if (symbol === activeQuote) {
            activeQuote = null;
            activeQuoteStart = -1;
        }
    }

    if (!activeQuote || activeQuoteStart < 0 || safeCharacter < activeQuoteStart + 1) {
        return null;
    }

    let endCharacter = lineText.length;
    for (let index = safeCharacter; index < lineText.length; index += 1) {
        if (lineText[index] === activeQuote) {
            endCharacter = index;
            break;
        }
    }

    const afterQuote = endCharacter < lineText.length && lineText[endCharacter] === activeQuote
        ? lineText.slice(endCharacter + 1)
        : lineText.slice(endCharacter);
    return {
        beforeQuote: lineText.slice(0, activeQuoteStart),
        afterQuote
    };
}

function shouldAutoTriggerFormExplorerQuotedSuggest(
    document: vscode.TextDocument,
    position: vscode.Position
): boolean {
    if (!isInScenarioTextBlockForAutoSuggest(document, position)) {
        return false;
    }

    const lineText = document.lineAt(position.line).text;
    const quotedContext = getQuotedTextContextForAutoSuggest(lineText, position.character);
    if (!quotedContext) {
        return false;
    }

    const trimmedLine = lineText.trim();
    if (!GHERKIN_STEP_LINE_REGEX.test(trimmedLine)) {
        return false;
    }

    return FORM_EXPLORER_SUGGEST_RELEVANT_LINE_REGEX.test(`${quotedContext.beforeQuote} ${quotedContext.afterQuote}`);
}

async function ensureScenarioYamlLanguage(document: vscode.TextDocument): Promise<void> {
    // Definition previews resolve temporary models without showing an editor.
    // Changing their language resolves another model reference, which can reopen
    // the model with its configured file association and repeat onDidOpen forever.
    if (!vscode.window.visibleTextEditors.some(editor => editor.document === document)) {
        return;
    }

    if (document.isUntitled || !isCompilerYamlFile(document)) {
        return;
    }

    if (document.languageId === 'yaml') {
        return;
    }

    try {
        await vscode.languages.setTextDocumentLanguage(document, 'yaml');
    } catch (error) {
        console.warn(`[Extension] Failed to switch scenario YAML to yaml mode for ${document.uri.fsPath}:`, error);
    }
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
    const configuredYamlSourceDirectory = getScenarioScanRootPath().trim();

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
    const projected = projectedProjectScenario(document);
    return projected ? !!projected.tabName?.trim() : parsePhaseSwitcherMetadata(document.getText()).hasTab;
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

async function notifyIfUpdated(context: vscode.ExtensionContext): Promise<void> {
    const currentVersion = context.extension.packageJSON.version as string | undefined;
    if (!currentVersion) {
        return;
    }

    const stateKey = 'kotTestToolkit.lastActivatedVersion';
    const lastVersion = context.globalState.get<string>(stateKey);
    if (lastVersion === currentVersion) {
        return;
    }

    if (!lastVersion) {
        await context.globalState.update(stateKey, currentVersion);
        return;
    }

    const t = await getTranslator(context.extensionUri);
    const restartAction = t('Restart VS Code');
    const selection = await vscode.window.showInformationMessage(
        t('KOT for 1C updated to {0}. Restart VS Code to apply the update.', currentVersion),
        restartAction
    );
    await context.globalState.update(stateKey, currentVersion);
    if (selection === restartAction) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/**
 * Функция активации расширения. Вызывается VS Code при первом запуске команды расширения
 * или при наступлении activationEvents, указанных в package.json.
 * @param context Контекст расширения, предоставляемый VS Code.
 */
export async function activate(context: vscode.ExtensionContext) {
    console.log('Extension "kotTestToolkit" activated.');
    setExtensionUri(context.extensionUri);
    notifyIfUpdated(context).catch(e => console.error('[Extension] notifyIfUpdated error:', e));
    initializeScenarioScanRoot(context);
    // Resolve the saved profile before any discovery consumer can start scanning.
    const { YamlParametersManager } = await import('./yamlParametersManager.js');
    const initialProfile = await YamlParametersManager.getInstance(context).loadActiveProfileSnapshot();
    initializeScenarioScanRoot(context, initialProfile.buildParameters);
    const stepCatalogService = new StepCatalogService(context, vscode);
    context.subscriptions.push(stepCatalogService);
    const activeProfileChangeEvent: vscode.Event<unknown> = listener => {
        let disposed = false;
        let subscription: vscode.Disposable | undefined;
        void import('./yamlParametersManager.js').then(({ YamlParametersManager }) => {
            if (disposed) {
                return;
            }
            subscription = YamlParametersManager.getInstance(context)
                .onDidChangeActiveProfile(listener);
        });
        return {
            dispose: () => {
                disposed = true;
                subscription?.dispose();
            }
        };
    };
    const managedInfobaseService = new ManagedInfobaseService({
        loadActiveProfile: async () => {
            const { YamlParametersManager } = await import('./yamlParametersManager.js');
            return YamlParametersManager.getInstance(context).loadActiveProfileSnapshot();
        },
        onDidChangeActiveProfile: activeProfileChangeEvent,
        workspaceRootPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
        collect: async activeProfileInfobasePath => {
            const { collectManagedInfobases } = await import('./infobaseManager.js');
            return collectManagedInfobases(context, activeProfileInfobasePath);
        }
    });
    context.subscriptions.push(managedInfobaseService);
    const loadFormExplorerPanel = createDeferredResourceLoader(
        async () => {
            const { FormExplorerPanel } = await import('./formExplorerPanel.js');
            return new FormExplorerPanel(context, stepCatalogService);
        },
        panel => context.subscriptions.push(panel)
    );
    const loadInfobaseManagerPanel = createDeferredResourceLoader(
        async () => {
            const { InfobaseManagerPanel } = await import('./infobaseManagerPanel.js');
            return new InfobaseManagerPanel(context, managedInfobaseService);
        },
        panel => context.subscriptions.push(panel)
    );
    // --- Регистрация Провайдера для Webview (Test Manager) ---
    const phaseSwitcherProvider = new PhaseSwitcherProvider(context.extensionUri, context);
    const standaloneFeatureService = StandaloneFeatureService.getInstance(context);
    watchProjectLibrary(context, () => {
        return phaseSwitcherProvider.refreshProjectLibraryMetadata().catch(error => {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not refresh project library: {0}',
                error instanceof Error ? error.message : String(error)));
        });
    });
    phaseSwitcherProvider.attachStandaloneFeatureService(standaloneFeatureService);
    const stepLibraryFavoritesService = new StepLibraryFavoritesService(context.workspaceState);
    context.subscriptions.push(stepLibraryFavoritesService);
    context.subscriptions.push(phaseSwitcherProvider.onDidChangeFavoriteScenarios(() => {
        stepLibraryFavoritesService.notifyLegacyFavoritesChanged();
    }));
    const relationshipPresentation = new ScenarioRelationshipPresentationService({
        getConfiguration: () => vscode.workspace.getConfiguration('kotTestToolkit'),
        workspaceConfigurationTarget: vscode.ConfigurationTarget.Workspace,
        onDidChangeConfiguration: vscode.workspace.onDidChangeConfiguration
    });
    context.subscriptions.push(relationshipPresentation);
    const testManagerStatusFilter = new TestManagerStatusFilterService(context.workspaceState);
    context.subscriptions.push(testManagerStatusFilter);
    context.subscriptions.push(
        onDidChangeScenarioScanRoot(() => {
            phaseSwitcherProvider.handleScenarioScanRootChanged();
        })
    );
    let batchProcessingInProgress = false;
    let scenarioRepairCancellationSource: vscode.CancellationTokenSource | null = null;
    const scenarioPropertiesEditor = registerScenarioPropertiesEditor(context, { renameScenario: (target, value, field) => phaseSwitcherProvider.renameScenarioTarget(target, value, field) });
    const updateActiveScenarioContext = async (editor?: vscode.TextEditor) => {
        const document = editor?.document;
        const isScenario = !!(document && isScenarioYamlFile(document));
        const isProcess = !!(document && isProcessYamlFile(document));
        const isProcessSettings = !!(document && isProcessTestSettingsYamlFile(document));
        const isInFavorites = !!(
            isScenario &&
            document &&
            phaseSwitcherProvider.isScenarioUriInFavorites(document.uri)
        );
        const isMainScenario = !!(isScenario && document && isMainScenarioDocument(document));

        await Promise.all([
            vscode.commands.executeCommand('setContext', 'kotTestToolkit.activeScenarioInFavorites', isInFavorites),
            vscode.commands.executeCommand('setContext', 'kotTestToolkit.activeScenarioIsProcess', isProcess),
            vscode.commands.executeCommand('setContext', 'kotTestToolkit.activeProcessSettings', isProcessSettings),
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
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'kotTestToolkit.openVanessa',
            () => phaseSwitcherProvider.openVanessaFromSidebar()
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.configureVanessaDebugClients',
            () => phaseSwitcherProvider.configureVanessaDebugClients()
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleTestManagerGroups',
            () => phaseSwitcherProvider.toggleAllGroupsFromSidebar()
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleStepLibraryGroups',
            () => stepLibrarySidebarProvider.toggleAllGroupsFromSidebar()
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.showCreateScenarioMenu',
            async () => {
                const t = await getTranslator(context.extensionUri);
                const picked = await vscode.window.showQuickPick([
                    { label: t('Main scenario'), command: 'kotTestToolkit.createMainScenario' },
                    { label: t('Feature file'), command: 'kotTestToolkit.createFeature' },
                    { label: t('Process'), command: 'kotTestToolkit.createProcess' },
                    { label: t('Nested scenario'), command: 'kotTestToolkit.createNestedScenario' },
                    { label: t('Export scenario'), command: 'kotTestToolkit.createExportScenario' },
                    { label: t('User step'), command: 'kotTestToolkit.createUserStep' }
                ], {
                    title: t('Create'),
                    placeHolder: t('Choose what to create'),
                    ignoreFocusOut: true
                });
                if (picked) {
                    await vscode.commands.executeCommand(picked.command);
                }
            }
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.openConfigurationDiffReport',
            () => openSavedConfigurationDiffImpactReport()
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.openTestReviewReport',
            () => openSavedTestReviewReport()
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.openSettings',
            () => vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit')
        )
    );

    // --- Регистрация Провайдеров Языковых Функций (Автодополнение и Подсказки) ---
    const projectDefinitionIndex = createProjectDefinitionIndexService(context);
    const projectDefinitionResolver = new ProjectDefinitionResolver({
        local: projectDefinitionIndex,
        scenarios: phaseSwitcherProvider,
        steps: stepCatalogService
    });
    const projectDefinitionReferenceService = createProjectDefinitionReferenceService(
        context,
        projectDefinitionResolver
    );
    const definitionProvider = new ProjectDefinitionProvider(projectDefinitionResolver);
    const referenceProvider = new ProjectDefinitionReferenceProvider(projectDefinitionReferenceService, projectDefinitionResolver);
    const relationshipService = new ScenarioRelationshipService({
        catalogProvider: phaseSwitcherProvider,
        standaloneFeatures: standaloneFeatureService,
        getConfiguration: () => vscode.workspace.getConfiguration('kotTestToolkit'),
        workspaceConfigurationTarget: vscode.ConfigurationTarget.Workspace,
        onDidChangeConfiguration: vscode.workspace.onDidChangeConfiguration,
        getScanRootPaths: () => {
            const workspaceRootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!workspaceRootUri) {
                return null;
            }
            const scanRootPath = path.resolve(resolveScenarioScanRootFsPath(workspaceRootUri));
            let canonicalScanRootPath = scanRootPath;
            try {
                canonicalScanRootPath = fs.realpathSync.native(scanRootPath);
            } catch {
                // The scan root can be configured before it is created.
            }
            return { scanRootPath, canonicalScanRootPath };
        },
        resolveAdditionalScenarioKeysForUri: uri =>
            phaseSwitcherProvider.resolveCompiledScenarioKeysForUri(uri),
        projectDefinitions: {
            getView: resource => projectDefinitionResolver.getView(resource),
            findReferencesForDefinitions: (definitionIds, resource, options, token) =>
                projectDefinitionReferenceService.findReferencesForDefinitions(
                    definitionIds,
                    resource,
                    options ?? { includeDeclaration: false },
                    token ?? { isCancellationRequested: false }
                ),
            createUri: value => vscode.Uri.parse(value),
            onDidChangeView: projectDefinitionResolver.onDidChangeView
        }
    });
    phaseSwitcherProvider.attachRelationshipService(relationshipService);
    phaseSwitcherProvider.attachStatusFilterService(testManagerStatusFilter);

    const updateRelationshipModeContext = (surface: ScenarioRelationshipSurface) => {
        const mode = relationshipPresentation.getMode(surface);
        const prefix = surface === 'testManager' ? 'testManager' : 'stepLibrary';
        const updates = [
            vscode.commands.executeCommand(
                'setContext',
                `kotTestToolkit.${prefix}ScenarioRelationshipsActive`,
                mode.highlight || mode.filter
            ),
            vscode.commands.executeCommand(
                'setContext',
                `kotTestToolkit.${prefix}RelationshipHighlightEnabled`,
                mode.highlight
            ),
            vscode.commands.executeCommand(
                'setContext',
                `kotTestToolkit.${prefix}RelationshipFilterEnabled`,
                mode.filter
            )
        ];
        if (surface === 'testManager') {
            updates.push(vscode.commands.executeCommand(
                'setContext',
                'kotTestToolkit.testManagerFiltersActive',
                relationshipPresentation.isActive('testManager')
                    || testManagerStatusFilter.isActive()
            ));
        }
        return Promise.all(updates);
    };
    const updateTestManagerStatusFilterContext = () => {
        const mode = testManagerStatusFilter.getMode();
        return Promise.all([
            vscode.commands.executeCommand(
                'setContext',
                'kotTestToolkit.testManagerStatusFilterAll',
                mode === 'all'
            ),
            vscode.commands.executeCommand(
                'setContext',
                'kotTestToolkit.testManagerStatusFilterBuilt',
                mode === 'built'
            ),
            vscode.commands.executeCommand(
                'setContext',
                'kotTestToolkit.testManagerStatusFilterRunning',
                mode === 'running'
            ),
            vscode.commands.executeCommand(
                'setContext',
                'kotTestToolkit.testManagerFiltersActive',
                relationshipPresentation.isActive('testManager')
                    || testManagerStatusFilter.isActive()
            )
        ]);
    };
    void updateRelationshipModeContext('testManager');
    void updateRelationshipModeContext('stepLibrary');
    void updateTestManagerStatusFilterContext();
    context.subscriptions.push(
        projectDefinitionIndex,
        projectDefinitionResolver,
        projectDefinitionReferenceService
    );
    context.subscriptions.push(
        relationshipService,
        relationshipPresentation.onDidChangeMode(event => {
            void updateRelationshipModeContext(event.surface);
        }),
        testManagerStatusFilter.onDidChangeMode(() => {
            void updateTestManagerStatusFilterContext();
        }),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleTestManagerRelationshipHighlight',
            () => relationshipPresentation.toggleMode('testManager', 'highlight')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleTestManagerRelationshipHighlightChecked',
            () => relationshipPresentation.toggleMode('testManager', 'highlight')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleTestManagerRelationshipFilter',
            () => relationshipPresentation.toggleMode('testManager', 'filter')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleTestManagerRelationshipFilterChecked',
            () => relationshipPresentation.toggleMode('testManager', 'filter')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.setTestManagerStatusFilterAll',
            () => testManagerStatusFilter.setMode('all')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.setTestManagerStatusFilterAllChecked',
            () => testManagerStatusFilter.setMode('all')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.setTestManagerStatusFilterBuilt',
            () => testManagerStatusFilter.setMode('built')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.setTestManagerStatusFilterBuiltChecked',
            () => testManagerStatusFilter.setMode('built')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.setTestManagerStatusFilterRunning',
            () => testManagerStatusFilter.setMode('running')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.setTestManagerStatusFilterRunningChecked',
            () => testManagerStatusFilter.setMode('running')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleStepLibraryRelationshipHighlight',
            () => relationshipPresentation.toggleMode('stepLibrary', 'highlight')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleStepLibraryRelationshipHighlightChecked',
            () => relationshipPresentation.toggleMode('stepLibrary', 'highlight')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleStepLibraryRelationshipFilter',
            () => relationshipPresentation.toggleMode('stepLibrary', 'filter')
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.toggleStepLibraryRelationshipFilterChecked',
            () => relationshipPresentation.toggleMode('stepLibrary', 'filter')
        )
    );
    const snapshotService = new StepLibrarySnapshotService({
        resolver: projectDefinitionResolver,
        scenarios: phaseSwitcherProvider,
        standaloneFeatures: standaloneFeatureService
    });
    phaseSwitcherProvider.setDefinitionDeletionReferenceServices({
        resolver: projectDefinitionResolver, references: projectDefinitionReferenceService
    });
    const actionService = new StepLibraryActionService({
        resolver: projectDefinitionResolver,
        openDefinition: openProjectDefinitionHandler,
        processStepHost: {
            openDocument: async uri => vscode.workspace.openTextDocument(vscode.Uri.parse(uri)),
            addSteps: async (document, expectedVersion, expectedSource) => {
                if (document.version !== expectedVersion || document.getText() !== expectedSource) { return false; }
                const { handleAddProcessSteps } = await import('./processCreator.js');
                if (document.version !== expectedVersion || document.getText() !== expectedSource) { return false; }
                return handleAddProcessSteps(context, document.uri);
            },
            replaceDocument: async (document, replacement, expectedVersion, expectedSource) => {
                if (document.version !== expectedVersion || document.getText() !== expectedSource) { return false; }
                const edit = new vscode.WorkspaceEdit();
                edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(expectedSource.length)), replacement);
                return vscode.workspace.applyEdit(edit);
            }
        },
        renameMainGroup: item => phaseSwitcherProvider.renameMainScenarioGroup(
            { name: item.template, uri: item.capturedLocation!.uri }, item.categoryPath[0]
        ),
        deleteDefinition: async (item, resource) => {
            if (!item.capturedLocation) { return false; }
            const { deleteExportScenario, deleteStandaloneFeature } = await import('./projectDefinitionDeletion.js');
            const deleted = item.kind === 'exportScenario'
                ? await deleteExportScenario(item.definitionId, resource, projectDefinitionResolver, projectDefinitionReferenceService, item.capturedLocation)
                : item.kind === 'standaloneFeature'
                    ? await deleteStandaloneFeature(vscode.Uri.parse(item.capturedLocation.uri), item.template)
                    : await phaseSwitcherProvider.deleteScenarioTarget({ name: item.template, uri: item.capturedLocation.uri });
            if (deleted) {
                try {
                    await standaloneFeatureService.refresh();
                    await refreshStepDefinitions(resource);
                } catch (error) {
                    await vscode.window.showErrorMessage(vscode.l10n.t('Could not refresh the step library.') + ' ' + String(error));
                }
            }
            return deleted;
        },
        renameDefinition: async (item, resource) => {
            try {
                if (item.kind === 'exportScenario') {
                    const changed = await renameExportScenario(item.definitionId, resource, projectDefinitionResolver, projectDefinitionReferenceService);
                    if (changed) {
                        await projectDefinitionIndex.reloadConfigurations();
                        await projectDefinitionIndex.waitForIdle();
                        await phaseSwitcherProvider.refreshFromExternalStateChange({ refreshCache: true });
                    }
                    return changed;
                }
                if (!item.capturedLocation) { return false; }
                await phaseSwitcherProvider.renameScenarioTarget({ name: item.template, uri: item.capturedLocation.uri });
                await updateActiveScenarioContext(vscode.window.activeTextEditor);
                return true;
            } catch (error) {
                await vscode.window.showErrorMessage(vscode.l10n.t(error instanceof Error ? error.message : String(error)));
                return false;
            }
        },
        host: {
            getActiveTextEditor: () => vscode.window.activeTextEditor,
            onDidChangeActiveTextEditor: vscode.window.onDidChangeActiveTextEditor,
            onDidChangeTextEditorSelection: vscode.window.onDidChangeTextEditorSelection,
            onDidChangeTextDocument: vscode.workspace.onDidChangeTextDocument,
            createPosition: (line, character) => new vscode.Position(line, character),
            createSelection: (anchor, active) => new vscode.Selection(anchor, active),
            createSnippetString: value => new vscode.SnippetString(value),
            writeClipboardText: value => vscode.env.clipboard.writeText(value)
        }
    });
    const refreshStepDefinitions = async (resource?: vscode.Uri) => {
        await stepCatalogService.refresh(resource);
        await projectDefinitionIndex.reloadConfigurations();
        await projectDefinitionIndex.waitForIdle();
        await phaseSwitcherProvider.refreshFromExternalStateChange({ refreshCache: true });
    };
    const scenarioFilesService = new ScenarioFilesService({
        parseUri: value => vscode.Uri.parse(value),
        dirname: uri => (uri as vscode.Uri).with({
            path: path.posix.dirname((uri as vscode.Uri).path)
        }),
        joinPath: (base, ...segments) => vscode.Uri.joinPath(
            base as vscode.Uri,
            ...segments
        ),
        readDirectory: async uri => (await vscode.workspace.fs.readDirectory(uri as vscode.Uri))
            .map(([name, fileType]) => ({
                name,
                kind: (fileType & vscode.FileType.SymbolicLink) !== 0
                    ? 'symbolicLink' as const
                    : (fileType & vscode.FileType.Directory) !== 0
                        ? 'directory' as const
                        : 'file' as const
            })),
        isFileNotFound: error => error instanceof vscode.FileSystemError
            && error.code === 'FileNotFound',
        openExternal: uri => vscode.env.openExternal(uri as vscode.Uri),
        openInEditor: async uri => {
            const document = await vscode.workspace.openTextDocument(uri as vscode.Uri);
            await vscode.window.showTextDocument(document, { preview: true });
            return true;
        },
        revealInOs: async uri => {
            await vscode.commands.executeCommand('revealFileInOS', uri as vscode.Uri);
        },
        confirmDelete: async relativePath => {
            const deleteLabel = vscode.l10n.t('Delete');
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t('Delete scenario attachment "{0}"?', relativePath),
                { modal: true },
                deleteLabel
            );
            return choice === deleteLabel;
        },
        deleteFile: uri => deleteFileWithTrashFallback(
            uri as vscode.Uri,
            (target, options) => vscode.workspace.fs.delete(target, options)
        ),
        promptRename: name => vscode.window.showInputBox({ title: vscode.l10n.t('Rename attachment'), value: name,
            ignoreFocusOut: true, validateInput: value => !value.trim() || /[\\/:*?"<>|\x00-\x1f]/u.test(value)
                || value === '.' || value === '..' || /[. ]$/u.test(value) ? vscode.l10n.t('Enter a valid attachment file name without a path.') : undefined }),
        renameFile: (from, to) => vscode.workspace.fs.rename(from as vscode.Uri, to as vscode.Uri, { overwrite: false }),
        createWatcher: root => {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(root as vscode.Uri, '**/*')
            );
            return {
                onDidCreate: listener => watcher.onDidCreate(listener as (uri: vscode.Uri) => void),
                onDidChange: listener => watcher.onDidChange(listener as (uri: vscode.Uri) => void),
                onDidDelete: listener => watcher.onDidDelete(listener as (uri: vscode.Uri) => void),
                dispose: () => watcher.dispose()
            };
        },
        chooseConflict: async relativePath => {
            const replace = vscode.l10n.t('Replace');
            const saveCopy = vscode.l10n.t('Save copy');
            const skip = vscode.l10n.t('Skip');
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t('A resource named "{0}" already exists.', relativePath),
                { modal: true },
                replace,
                saveCopy,
                skip
            );
            return choice === replace ? 'replace' : choice === saveCopy ? 'copy' : 'skip';
        }
    });
    phaseSwitcherProvider.attachScenarioFilesService(scenarioFilesService);
    scenarioPropertiesEditor.panel.attachScenarioFilesService(scenarioFilesService);
    snapshotService.attachScenarioFilesService(scenarioFilesService);
    const stepLibrarySidebarProvider = new StepLibrarySidebarProvider({
        extensionUri: context.extensionUri,
        context,
        standaloneFeatureService,
        prepareStandaloneFeatures: async () => { await phaseSwitcherProvider.getCompiledScenarioResources(); },
        standaloneFeatureControllerOptions: phaseSwitcherProvider.getStandaloneFeatureControllerOptions(),
        snapshotService,
        actionService,
        relationshipService,
        relationshipPresentation,
        favoritesService: stepLibraryFavoritesService,
        scenarioFilesService,
        refreshDefinitions: refreshStepDefinitions
    });
    const infobaseSidebarProvider = new InfobaseSidebarProvider({
        extensionUri: context.extensionUri,
        managedInfobaseService,
        runtimeTracker: managedInfobaseRuntimeTracker,
        loadOperations: createDeferredInfobaseSidebarOperations(context)
    });
    context.subscriptions.push(
        snapshotService,
        actionService,
        scenarioFilesService,
        stepLibrarySidebarProvider,
        infobaseSidebarProvider,
        vscode.window.registerWebviewViewProvider(
            StepLibrarySidebarProvider.viewType,
            stepLibrarySidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.window.registerWebviewViewProvider(
            InfobaseSidebarProvider.viewType,
            infobaseSidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'kotTestToolkit.refreshStepLibrarySidebar',
            () => stepLibrarySidebarProvider.refresh()
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.refreshInfobaseSidebar',
            () => infobaseSidebarProvider.refresh()
        ),
        vscode.commands.registerCommand(
            'kotTestToolkit.createInfobase',
            () => infobaseSidebarProvider.createInfobase()
        )
    );
    let stepLibraryPanelPromise: Promise<import('./stepLibraryPanel.js').StepLibraryPanel>
        | undefined;
    const getStepLibraryPanel = () => {
        if (!stepLibraryPanelPromise) {
            stepLibraryPanelPromise = import('./stepLibraryPanel.js').then(({ StepLibraryPanel }) => {
                const panel = new StepLibraryPanel({
                    extensionUri: context.extensionUri,
                    context,
                    standaloneFeatureService,
                    prepareStandaloneFeatures: async () => { await phaseSwitcherProvider.getCompiledScenarioResources(); },
                    standaloneFeatureControllerOptions: phaseSwitcherProvider.getStandaloneFeatureControllerOptions(),
                    snapshotService,
                    actionService,
                    favoritesService: stepLibraryFavoritesService,
                    scenarioFilesService,
                    refreshDefinitions: refreshStepDefinitions
                });
                context.subscriptions.push(panel);
                return panel;
            }).catch(error => {
                stepLibraryPanelPromise = undefined;
                throw error;
            });
        }
        return stepLibraryPanelPromise;
    };
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openStepLibrary',
        async () => {
            const panel = await getStepLibraryPanel();
            await panel.open(vscode.window.activeTextEditor?.document.uri);
        }
    ));
    const completionProvider = new DriveCompletionProvider(context, projectDefinitionResolver);
    const hoverProvider = new DriveHoverProvider(
        context,
        projectDefinitionResolver,
        phaseSwitcherProvider
    );
    const completionAndHoverSelector: vscode.DocumentSelector = [
        { pattern: '**/*.yaml', scheme: 'file' },
        { pattern: '**/*.feature', scheme: 'file' }
    ];
    const featureAnnotationTags = new ProjectFeatureTagCatalog({
        loadSources: async (resource, token) => {
            const [standalone, library] = await Promise.all([
                standaloneFeatureService.ensureReady(), projectDefinitionIndex.ensureReady(resource, token)
            ]);
            const folder = resource && vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(resource.toString()));
            const root = folder && path.resolve(resolveScenarioScanRootFsPath(folder.uri));
            const authored = standalone.features.filter(feature => {
                if (!root) { return true; }
                const relative = path.relative(root, vscode.Uri.parse(feature.uri).fsPath);
                return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
            });
            return [...authored.map(feature => feature.uri), ...Array.from(library.files.values(), file => file.uri)];
        },
        readSource: async uri => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri))).toString('utf8'),
        getOpenSources: () => vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file')
            .map(document => ({ uri: document.uri.toString(), text: document.getText() }))
    });
    context.subscriptions.push(
        standaloneFeatureService.onDidRefresh(() => featureAnnotationTags.invalidate()),
        projectDefinitionIndex.onDidChangeSnapshot(() => featureAnnotationTags.invalidate())
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            completionAndHoverSelector,
            completionProvider,
            ' ', '.', ',', ':', ';', '(', ')', '"', "'", '$', '!', '[', '@',
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
        vscode.languages.registerDefinitionProvider(
            completionAndHoverSelector,
            definitionProvider
        )
    );
    const editorActionChanges = new vscode.EventEmitter<void>();
    const editorActionsEnabled = (uri: vscode.Uri) => vscode.workspace.getConfiguration('kotTestToolkit', uri).get<boolean>('editor.showActionButtons', false);
    const controlEditorLenses = (provider: vscode.CodeLensProvider) => controlledCodeLenses(provider, editorActionsEnabled, editorActionChanges.event);
    context.subscriptions.push(editorActionChanges, vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('kotTestToolkit.editor.showActionButtons')) { editorActionChanges.fire(); }
    }), vscode.commands.registerCommand('kotTestToolkit.toggleEditorActionButtons', async () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        const config = vscode.workspace.getConfiguration('kotTestToolkit', uri);
        const setting = config.inspect<boolean>('editor.showActionButtons');
        const target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
            : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await config.update('editor.showActionButtons', !config.get<boolean>('editor.showActionButtons', false), target);
    }));
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { pattern: '**/*.feature', scheme: 'file' },
            controlEditorLenses(new ExportScenarioMetadataCodeLensProvider(context.extensionUri))
        )
    );
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { pattern: '**/*.feature', scheme: 'file' },
            controlEditorLenses(new FeatureEditorCodeLensProvider(context.extensionUri))
        ),
        vscode.languages.registerCodeActionsProvider(
            completionAndHoverSelector,
            new FeatureStepTagCodeActionProvider(),
            { providedCodeActionKinds: FeatureStepTagCodeActionProvider.providedCodeActionKinds }
        ),
        vscode.languages.registerCompletionItemProvider(
            completionAndHoverSelector,
            new FeatureStepTagCompletionProvider(context.extensionUri, featureAnnotationTags),
            '@', '#', '['
        ),
        vscode.commands.registerCommand(FEATURE_EDITOR_COMMAND, async (target, options) => editFeatureStructureCommand(target, await getTranslator(context.extensionUri), options))
    );
    const scenarioCategoryCodeLensProvider = new ScenarioCategoryCodeLensProvider(context.extensionUri);
    context.subscriptions.push(
        scenarioCategoryCodeLensProvider,
        phaseSwitcherProvider.onDidUpdateScenarioCatalog(() => {
            scenarioCategoryCodeLensProvider.refresh();
            void updateActiveScenarioContext(vscode.window.activeTextEditor);
        }),
        vscode.languages.registerCodeLensProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            controlEditorLenses(scenarioCategoryCodeLensProvider)
        ),
        vscode.languages.registerCodeLensProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            controlEditorLenses(new ProcessEditorCodeLensProvider(context.extensionUri))
        ),
        vscode.languages.registerCodeLensProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            controlEditorLenses(new CompilerYamlBlockCodeLensProvider(context.extensionUri))
        ),
        vscode.commands.registerCommand('kotTestToolkit.addCompilerYamlBlock', target =>
            addCompilerYamlBlockCommand(context, target)
        )
    );
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider(
            [
                { pattern: '**/*.yaml', scheme: 'file' },
                { pattern: '**/*.feature', scheme: 'file' },
                { pattern: '**/*.bsl', scheme: 'file' }
            ],
            referenceProvider
        )
    );
    context.subscriptions.push(
        vscode.languages.registerDocumentDropEditProvider(
            { pattern: '**/*.{yaml,yml,feature}', scheme: 'file' },
            {
                async provideDocumentDropEdits(document, position, dataTransfer, token) {
                    const definitionItem = dataTransfer.get(STEP_LIBRARY_DEFINITION_DROP_MIME);
                    if (definitionItem) {
                        const definitionId = (await definitionItem.asString()).trim();
                        const view = await projectDefinitionResolver.getView(document.uri);
                        const definition = view.byId.get(definitionId);
                        if (!definition || token.isCancellationRequested) {
                            return undefined;
                        }
                        const snippet = buildStepLibraryDropSnippet(definition, document, position);
                        return snippet
                            ? new vscode.DocumentDropEdit(
                                new vscode.SnippetString(snippet),
                                vscode.l10n.t('Insert step'),
                                vscode.DocumentDropOrPasteEditKind.Text.append('kotLibraryStep')
                            )
                            : undefined;
                    }

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
                dropMimeTypes: [FAVORITE_SCENARIO_DROP_MIME, STEP_LIBRARY_DEFINITION_DROP_MIME],
                providedDropEditKinds: [
                    vscode.DocumentDropOrPasteEditKind.Text.append('kotFavoriteScenario'),
                    vscode.DocumentDropOrPasteEditKind.Text.append('kotLibraryStep')
                ]
            }
        )
    );

    const scenarioDiagnosticsProvider = new ScenarioDiagnosticsProvider(
        phaseSwitcherProvider,
        projectDefinitionResolver
    );
    context.subscriptions.push(
        scenarioDiagnosticsProvider,
        vscode.languages.registerCodeActionsProvider(
            [
                { pattern: '**/*.yaml', scheme: 'file' },
                { pattern: '**/*.feature', scheme: 'file' }
            ],
            scenarioDiagnosticsProvider,
            { providedCodeActionKinds: ScenarioDiagnosticsProvider.providedCodeActionKinds }
        )
    );
    const scenarioHeaderInlayHintsProvider = new ScenarioHeaderInlayHintsProvider();
    context.subscriptions.push(
        scenarioHeaderInlayHintsProvider,
        phaseSwitcherProvider.onDidUpdateScenarioCatalog(() => scenarioHeaderInlayHintsProvider.refresh()),
        vscode.languages.registerInlayHintsProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            controlledInlayHints(scenarioHeaderInlayHintsProvider, editorActionsEnabled, editorActionChanges.event)
        )
    );
    const scenarioSyntaxHighlightProvider = new ScenarioSyntaxHighlightProvider();
    context.subscriptions.push(scenarioSyntaxHighlightProvider);
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { pattern: '**/*.yaml', scheme: 'file' },
            scenarioSyntaxHighlightProvider,
            ScenarioSyntaxHighlightProvider.legend
        )
    );

    const kotDescriptionTextDecorationType = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('editorInfo.foreground')
    });
    context.subscriptions.push(kotDescriptionTextDecorationType);
    const scenarioPlainTextDecorationType = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('editor.foreground')
    });
    context.subscriptions.push(scenarioPlainTextDecorationType);
    const scenarioBracketParameterDecorationType = vscode.window.createTextEditorDecorationType({
        color: '#d19a66',
        dark: {
            color: '#e5c07b'
        },
        light: {
            color: '#9c6500'
        }
    });
    context.subscriptions.push(scenarioBracketParameterDecorationType);

    // Seed per-file session caches for currently open scenario documents.
    vscode.workspace.textDocuments.forEach(document => {
        if (!document.isUntitled && isScenarioYamlFile(document)) {
            setScenarioSnapshotAsSaved(document);
            void ensureScenarioYamlLanguage(document);
        }
    });
    updateKotDescriptionDecorationsForVisibleEditors(kotDescriptionTextDecorationType);
    updateScenarioPlainTextDecorationsForVisibleEditors(scenarioPlainTextDecorationType);
    updateScenarioBracketParameterDecorationsForVisibleEditors(scenarioBracketParameterDecorationType);

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (document.isUntitled || !isScenarioYamlFile(document)) {
            return;
        }

        void ensureScenarioYamlLanguage(document);
        setScenarioSnapshotAsSaved(document);
        updateKotDescriptionDecorationsForDocument(document, kotDescriptionTextDecorationType);
        updateScenarioPlainTextDecorationsForDocument(document, scenarioPlainTextDecorationType);
        updateScenarioBracketParameterDecorationsForDocument(document, scenarioBracketParameterDecorationType);
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
        updateScenarioPlainTextDecorationsForDocument(document, scenarioPlainTextDecorationType);
        updateScenarioBracketParameterDecorationsForDocument(document, scenarioBracketParameterDecorationType);
        const fileKey = document.uri.toString();
        const currentSnapshot = buildScenarioSaveSnapshot(document);
        const lastSavedSnapshot = lastSavedScenarioSnapshots.get(fileKey);
        scenarioDirtyFlagsByUri.set(fileKey, calculateScenarioDirtyFlags(currentSnapshot, lastSavedSnapshot));
        if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
            void updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    }));

    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
        for (const editor of vscode.window.visibleTextEditors) {
            void ensureScenarioYamlLanguage(editor.document);
        }
        updateKotDescriptionDecorationsForVisibleEditors(kotDescriptionTextDecorationType);
        updateScenarioPlainTextDecorationsForVisibleEditors(scenarioPlainTextDecorationType);
        updateScenarioBracketParameterDecorationsForVisibleEditors(scenarioBracketParameterDecorationType);
    }));

    let lastAutoQuotedSuggestKey: string | null = null;
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
        const editor = event.textEditor;
        if (vscode.window.activeTextEditor !== editor) {
            return;
        }

        if (event.selections.length !== 1 || !event.selections[0].isEmpty) {
            lastAutoQuotedSuggestKey = null;
            return;
        }

        const position = event.selections[0].active;
        if (!shouldAutoTriggerFormExplorerQuotedSuggest(editor.document, position)) {
            lastAutoQuotedSuggestKey = null;
            return;
        }

        const triggerKey = [
            editor.document.uri.toString(),
            editor.document.version,
            position.line,
            position.character
        ].join(':');
        if (lastAutoQuotedSuggestKey === triggerKey) {
            return;
        }
        lastAutoQuotedSuggestKey = triggerKey;

        setTimeout(() => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document.uri.toString() !== editor.document.uri.toString()) {
                return;
            }

            const activePosition = activeEditor.selection.active;
            const activeKey = [
                activeEditor.document.uri.toString(),
                activeEditor.document.version,
                activePosition.line,
                activePosition.character
            ].join(':');
            if (activeKey !== triggerKey) {
                return;
            }

            void vscode.commands.executeCommand('editor.action.triggerSuggest');
        }, 0);
    }));


    // --- Регистрация Команд ---
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.completion.advanceFormExplorerArgument',
        async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                return;
            }

            const beforeSelectionKey = activeEditor.selections
                .map(selection => [
                    selection.start.line,
                    selection.start.character,
                    selection.end.line,
                    selection.end.character
                ].join(':'))
                .join('|');

            try {
                await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
            } catch {
                return;
            }

            const updatedEditor = vscode.window.activeTextEditor;
            if (!updatedEditor || updatedEditor.document.uri.toString() !== activeEditor.document.uri.toString()) {
                return;
            }

            const afterSelectionKey = updatedEditor.selections
                .map(selection => [
                    selection.start.line,
                    selection.start.character,
                    selection.end.line,
                    selection.end.character
                ].join(':'))
                .join('|');
            if (afterSelectionKey === beforeSelectionKey) {
                return;
            }

            await vscode.commands.executeCommand('editor.action.triggerSuggest');
        }
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.openSubscenario', (editor, edit) => openSubscenarioHandler(editor, edit, projectDefinitionResolver)
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.generateScenarioDescriptionWithAi',
        editor => void handleGenerateScenarioDescriptionWithAi(editor)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.generateConfigurationDiffImpactReportWithAi',
        () => void handleGenerateConfigurationDiffImpactReport()
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.reviewChangedTestsWithAi',
        () => void handleReviewChangedTestsWithAi()
    ));
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.openNestedScenarioFromFeature',
        async (editor, edit) => {
            if (await phaseSwitcherProvider.openCompilerSourceFromFeatureEditor(editor)) { return; }
            await openNestedScenarioFromFeatureHandler(editor, edit, projectDefinitionResolver);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openScenarioByName',
        async (scenarioName: unknown) => {
            if (typeof scenarioName !== 'string') {
                return;
            }
            await openScenarioByNameHandler(scenarioName, projectDefinitionResolver);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openProjectDefinition',
        async (argument: unknown, resourceUriValue?: unknown) => {
            const definitionId = typeof argument === 'string'
                ? argument
                : argument && typeof argument === 'object' && 'definitionId' in argument
                    ? (argument as { definitionId?: unknown }).definitionId
                    : undefined;
            const resourceUri = typeof argument === 'object' && argument && 'resourceUri' in argument
                ? (argument as { resourceUri?: unknown }).resourceUri
                : resourceUriValue;
            const capturedLocation = typeof argument === 'object' && argument && 'location' in argument
                ? (argument as { location?: unknown }).location
                : undefined;
            if (typeof definitionId !== 'string') {
                return;
            }
            await openProjectDefinitionHandler(
                definitionId,
                typeof resourceUri === 'string' ? resourceUri : undefined,
                projectDefinitionResolver,
                capturedLocation
            );
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.editScenarioParameterDefaultValue',
        async (documentUriValue: unknown, parameterNameValue: unknown) => {
            if (typeof documentUriValue !== 'string' || typeof parameterNameValue !== 'string') {
                return;
            }

            const parameterName = parameterNameValue.trim();
            if (!parameterName) {
                return;
            }

            const t = await getTranslator(context.extensionUri);
            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(vscode.Uri.parse(documentUriValue));
            } catch {
                return;
            }

            if (!isScenarioYamlFile(document)) {
                return;
            }

            const definition = parseScenarioParameterDefinitions(document.getText()).get(parameterName);
            if (!definition) {
                vscode.window.showWarningMessage(t('Scenario parameter "{0}" was not found in the document.', parameterName));
                return;
            }

            if (!definition.valueRange) {
                vscode.window.showWarningMessage(t('Default value is not defined in the parameter block.'));
                return;
            }

            if (definition.type === 'table' || /^[|>]/u.test(document.getText().slice(definition.valueRange.startOffset, definition.valueRange.startOffset + 1))) {
                const editor = await vscode.window.showTextDocument(document, { preview: false });
                const range = new vscode.Range(document.positionAt(definition.valueRange.startOffset), document.positionAt(definition.valueRange.endOffset));
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range);
                return;
            }

            const nextValue = await vscode.window.showInputBox({
                title: t('Edit default value'),
                prompt: t('Enter default value for scenario parameter "{0}". You can use plain text, quoted text or [AnotherParameter].', parameterName),
                value: definition.rawDefaultValue ?? '',
                ignoreFocusOut: true
            });
            if (nextValue === undefined) {
                return;
            }

            const normalizedValue = nextValue.trim().length > 0
                ? normalizeScenarioCallParameterValue(nextValue, parameterName)
                : '""';
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(
                    document.positionAt(definition.valueRange.startOffset),
                    document.positionAt(definition.valueRange.endOffset)
                ),
                normalizedValue
            );

            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                return;
            }

            await vscode.window.showTextDocument(document, { preview: false });
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openRunScenarioLog',
        async (scenarioName: unknown, scenarioKey?: unknown) => {
            if (typeof scenarioName !== 'string') {
                return;
            }
            await phaseSwitcherProvider.openRunScenarioLogFromCommand(scenarioName, typeof scenarioKey === 'string' ? scenarioKey : undefined);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openFailedNestedScenarioFromRun',
        async (scenarioName: unknown, scenarioKey?: unknown) => {
            if (typeof scenarioName !== 'string') {
                return;
            }
            await phaseSwitcherProvider.openFailedNestedScenarioFromCommand(scenarioName, typeof scenarioKey === 'string' ? scenarioKey : undefined);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.createFeature', async () => {
            const { createFeature } = await import('./featureCreator.js');
            const uri = await createFeature(context);
            if (uri) { await standaloneFeatureService.refresh(); }
            return uri;
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.generateFeatureJson', async (target?: vscode.Uri) => {
            const uri = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
            if (!uri || uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.feature') { return; }
            const { generateFeatureJson } = await import('./featureCreator.js');
            const generated = await generateFeatureJson(context, uri);
            if (generated) {
                await standaloneFeatureService.refresh();
                const feature = standaloneFeatureService.find(uri.toString());
                if (feature) {
                    await standaloneFeatureService.setLaunchJson(feature.id, generated.fsPath);
                }
            }
            return generated;
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.runFeature', async (target?: vscode.Uri) => {
            const uri = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
            if (!uri) { return; }
            await phaseSwitcherProvider.runStandaloneFeature(uri.toString());
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.createProcess', async (seed?: unknown) => {
            const { handleCreateProcess } = await import('./processCreator.js');
            return handleCreateProcess(context, seed);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.addProcessSteps', async (target?: vscode.Uri | TestInfo) => {
            const { handleAddProcessSteps } = await import('./processCreator.js');
            await handleAddProcessSteps(context, target);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.editProcessSteps', async (target?: vscode.Uri | TestInfo) => {
            const { handleEditProcessSteps } = await import('./processCreator.js');
            await handleEditProcessSteps(context, target);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.renameProcessFromEditor', async (target?: vscode.Uri) => {
            const { changeProcessIdentityFromEditor } = await import('./processEditorCommands.js');
            await changeProcessIdentityFromEditor(context, 'name', target);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit._processSourceFilesChanged', (uris: vscode.Uri[]) => {
            phaseSwitcherProvider.notifyProcessSourceFilesChanged(uris);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeProcessCodeFromEditor', async (target?: vscode.Uri) => {
            const { changeProcessIdentityFromEditor } = await import('./processEditorCommands.js');
            await changeProcessIdentityFromEditor(context, 'code', target);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openProcessTestSettingsFromEditor', async (target?: vscode.Uri) => {
            const { openProcessTestSettingsFromEditor } = await import('./processEditorCommands.js');
            await openProcessTestSettingsFromEditor(context, target);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeProcessTestSettingsFromEditor', async (target?: vscode.Uri) => {
            const { changeProcessTestSettingsFromEditor } = await import('./processEditorCommands.js');
            await changeProcessTestSettingsFromEditor(context, target);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.createNestedScenario', async () => {
            const { handleCreateNestedScenario } = await loadScenarioCreator();
            let existingCategories: readonly string[] = [];
            try {
                existingCategories = collectNestedScenarioCategories((await projectDefinitionResolver.getView(
                    vscode.window.activeTextEditor?.document.uri
                )).all);
            } catch {
                // Creation remains available while the shared definition view is unavailable.
            }
            await handleCreateNestedScenario(context, { existingCategories: existingCategories });
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.createMainScenario', async (seed?: unknown) => {
            const { handleCreateMainScenario } = await loadScenarioCreator();
            await handleCreateMainScenario(context, seed);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.createExportScenario', async (seed?: unknown) => {
            const t = await getTranslator(context.extensionUri);
            await createExportScenarioCommand(seed, {
                index: projectDefinitionIndex,
                loadLibraryRoots: resourceUri => loadExportScenarioLibraryRoots(context, resourceUri),
                translate: t
            });
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        EXPORT_SCENARIO_METADATA_COMMAND, async (target?: unknown) => {
            const t = await getTranslator(context.extensionUri);
            await addExportScenarioMetadataCommand(target, {
                index: projectDefinitionIndex,
                translate: t
            });
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeScenarioGroup', async (uri?: vscode.Uri) => {
            try { await phaseSwitcherProvider.changeScenarioGroup(uri); }
            catch (error) {
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not change group: {0}',
                    error instanceof Error ? error.message : String(error)));
            }
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openProjectMetadata', async (uri?: vscode.Uri) => {
            const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!resource) { return; }
            try { await openProjectMetadata(resource); }
            catch (error) {
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not open project metadata: {0}',
                    error instanceof Error ? error.message : String(error)));
            }
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        SCENARIO_CATEGORY_COMMAND, async (target?: unknown) => {
            const t = await getTranslator(context.extensionUri);
            await setScenarioCategoryCommand(target, {
                resolver: projectDefinitionResolver,
                translate: t
            });
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.createUserStep', async (seed?: unknown) => {
            const t = await getTranslator(context.extensionUri);
            const { createUserStepCommand } = await loadUserStepCommands();
            try {
                await createUserStepCommand(seed, {
                    context,
                    index: projectDefinitionIndex,
                    loadLibraryRoots: resourceUri => loadUserStepLibraryRoots(context, resourceUri),
                    translate: t
                });
            } catch (error) {
                vscode.window.showErrorMessage(t('Could not create the user step: {0}', String(error)));
            }
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.buildUserStepLibrary', async (request?: unknown) => {
            const t = await getTranslator(context.extensionUri);
            const { buildUserStepLibraryCommand } = await loadUserStepCommands();
            await buildUserStepLibraryCommand(request, {
                context,
                index: projectDefinitionIndex,
                loadLibraryRoots: resourceUri => loadUserStepLibraryRoots(context, resourceUri),
                translate: t
            });
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.refreshPhaseSwitcher',
        async (options?: { refreshCache?: boolean }) => {
            const refreshCache = options?.refreshCache !== false;
            if (refreshCache) {
                await projectDefinitionIndex.reloadConfigurations();
                await projectDefinitionIndex.waitForIdle();
            }
            await phaseSwitcherProvider.refreshFromExternalStateChange({
                refreshCache
            });
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.manageTestNumbering', async () => {
            const { handleManageTestNumbering } = await import('./testNumbering.js');
            await handleManageTestNumbering(context);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.manageSystemFunctions', async () => {
            const { handleManageSystemFunctions } = await loadScenarioCreator();
            await handleManageSystemFunctions(context);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.manageEtalonBases', async () => {
            const { handleManageEtalonBases } = await loadScenarioCreator();
            await handleManageEtalonBases(context);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.managePlatforms', async () => {
            const { handleManagePlatforms } = await loadOneCPlatform();
            await handleManagePlatforms(context);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeScenarioSystemFunctionFromEditor',
        async () => {
            const { handleChangeScenarioSystemFunctionFromEditor } = await loadScenarioCreator();
            await handleChangeScenarioSystemFunctionFromEditor(context);
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeTestSettingsScenarioFromEditor',
        async () => {
            const { handleChangeTestSettingsScenarioFromEditor } = await loadScenarioCreator();
            await handleChangeTestSettingsScenarioFromEditor(context);
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeTestSettingsEtalonBaseFromEditor',
        async (target?: vscode.Uri) => {
            const { handleChangeTestSettingsEtalonBaseFromEditor } = await loadScenarioCreator();
            await handleChangeTestSettingsEtalonBaseFromEditor(context, target);
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.changeTestSettingsUserProfileFromEditor',
        async (target?: vscode.Uri) => {
            const { handleChangeTestSettingsUserProfileFromEditor } = await loadScenarioCreator();
            await handleChangeTestSettingsUserProfileFromEditor(context, target);
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.syncTestSettingsFromScenario',
        async () => {
            const { handleSyncTestSettingsFromScenario } = await loadScenarioCreator();
            await handleSyncTestSettingsFromScenario(context);
            await updateActiveScenarioContext(vscode.window.activeTextEditor);
        }
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
        'kotTestToolkit.findCurrentFileReferences',
        () => findCurrentFileReferencesHandler(
            projectDefinitionReferenceService,
            projectDefinitionResolver
        )
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
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(
        'kotTestToolkit.openCurrentScenarioFilesFolder', editor => openCurrentScenarioFilesFolderHandler(editor)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openBuildFolder', (folderPath: string) => {
            if (folderPath) {
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folderPath));
            }
        }
    ));


    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.enableDemoMode', () => {
            phaseSwitcherProvider.sendDemoModeToWebview();
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.setDemoStateForScenario', () => {
            void phaseSwitcherProvider.showDemoStatePickerForScenario();
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
    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.refreshCombinedRunJsonArtifacts', async () => {
            await phaseSwitcherProvider.refreshCombinedScenarioJsonArtifacts();
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
                const catalogs = await stepCatalogService.refresh(
                    vscode.window.activeTextEditor?.document.uri
                );
                progress.report({ increment: 100, message: t('Gherkin hints update completed.') });
                const selected = catalogs[0];
                if (selected) {
                    vscode.window.showInformationMessage(t(
                        'Steps library updated: version {0}, source {1}, {2} steps.',
                        selected.requestedVersion ?? selected.catalogVersion,
                        selected.source,
                        String(selected.steps.length)
                    ));
                }

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
                void ensureScenarioYamlLanguage(editor.document);
                updateKotDescriptionDecorationForEditor(editor, kotDescriptionTextDecorationType);
                updateScenarioPlainTextDecorationForEditor(editor, scenarioPlainTextDecorationType);
                updateScenarioBracketParameterDecorationForEditor(editor, scenarioBracketParameterDecorationType);
            }
        })
    );
    if (vscode.window.activeTextEditor) {
        void ensureScenarioYamlLanguage(vscode.window.activeTextEditor.document);
        foldSectionsInEditor(vscode.window.activeTextEditor);
        phaseSwitcherProvider.handleActiveEditorChanged(vscode.window.activeTextEditor);
        void updateActiveScenarioContext(vscode.window.activeTextEditor);
        updateKotDescriptionDecorationForEditor(vscode.window.activeTextEditor, kotDescriptionTextDecorationType);
        updateScenarioPlainTextDecorationForEditor(vscode.window.activeTextEditor, scenarioPlainTextDecorationType);
        updateScenarioBracketParameterDecorationForEditor(vscode.window.activeTextEditor, scenarioBracketParameterDecorationType);
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

        if (event.affectsConfiguration('kotTestToolkit.editor.useFeatureLanguageModeForScenarioYaml')) {
            scenarioSyntaxHighlightProvider.refresh();
            updateScenarioPlainTextDecorationsForVisibleEditors(scenarioPlainTextDecorationType);
            updateScenarioBracketParameterDecorationsForVisibleEditors(scenarioBracketParameterDecorationType);
        }

        if (
            event.affectsConfiguration('kotTestToolkit.platforms.catalog')
            || event.affectsConfiguration('kotTestToolkit.formExplorer.configurationSourceDirectory')
            || event.affectsConfiguration('kotTestToolkit.formExplorer.generatedArtifactsDirectory')
            || event.affectsConfiguration('kotTestToolkit.formExplorer.snapshotPath')
        ) {
            try {
                const { initializeFormExplorerRuntimeSidecars } = await loadFormExplorerBuilder();
                await initializeFormExplorerRuntimeSidecars();
                if (event.affectsConfiguration('kotTestToolkit.platforms.catalog')) {
                    const { ensureOneCPlatformsCatalogInitialized } = await loadOneCPlatform();
                    await ensureOneCPlatformsCatalogInitialized();
                }

            } catch (error) {
                console.warn('[Extension] Failed to react to 1C platform/Form Explorer configuration change.', error);
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
        'kotTestToolkit.openInfobaseManager',
        async () => {
            const panel = await loadInfobaseManagerPanel();
            await panel.open();
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openFormExplorer',
        async () => {
            const panel = await loadFormExplorerPanel();
            await panel.open();
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openFormExplorerForInfobase',
        async (options?: string | StartFormExplorerBridgeCommandOptions) => {
            const panel = await loadFormExplorerPanel();
            await panel.openAndStart(options);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.generateFormExplorerExtension',
        async () => {
            const { handleGenerateFormExplorerExtension } = await loadFormExplorerExtensionGenerator();
            await handleGenerateFormExplorerExtension(context);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.buildFormExplorerExtensionCfe',
        async (options?: BuildFormExplorerExtensionCommandOptions) => {
            const { handleBuildFormExplorerExtensionCfe } = await loadFormExplorerExtensionGenerator();
            await handleBuildFormExplorerExtensionCfe(context, options);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.installFormExplorerExtension',
        async (options?: InstallFormExplorerExtensionCommandOptions) => {
            const { handleInstallFormExplorerExtension } = await loadFormExplorerExtensionGenerator();
            await handleInstallFormExplorerExtension(context, options);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.startFormExplorerInfobase',
        async (options?: string | StartFormExplorerBridgeCommandOptions) => {
            const { handleStartFormExplorerBridge } = await loadFormExplorerBridgeGenerator();
            return await handleStartFormExplorerBridge(context, options);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.startFormExplorerBridge',
        async (options?: string | StartFormExplorerBridgeCommandOptions) => {
            const { handleStartFormExplorerBridge } = await loadFormExplorerBridgeGenerator();
            return await handleStartFormExplorerBridge(context, options);
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.openScenarioInVanessaManual',
        async () => {
            await phaseSwitcherProvider.openScenarioInVanessaManualFromCommandPalette();
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.trackScenarioRunByFeatureLog',
        async () => {
            await phaseSwitcherProvider.trackScenarioRunByActiveFeatureEditor();
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.switchTrackedScenarioRunForFeature',
        async () => {
            await phaseSwitcherProvider.switchTrackedRunByActiveFeatureEditor();
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.stopTrackedScenarioRunForFeature',
        async () => {
            await phaseSwitcherProvider.stopTrackedRunByActiveFeatureEditor();
        }
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
        'kotTestToolkit.trackScenarioRunFromOpenedLogFile',
        async () => {
            await phaseSwitcherProvider.trackScenarioRunByActiveLogEditor();
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
        'kotTestToolkit.openMainScenarioTestSettingsFromEditor',
        async () => {
            await phaseSwitcherProvider.openMainScenarioTestSettingsForActiveEditor();
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

        let changedCount = 0;
        let unchangedCount = 0;
        let failedCount = 0;
        let cancelled = false;
        const failedFiles: ScenarioRepairFailure[] = [];

        try {
            let scenarioCatalog = nestedEnabled
                ? await phaseSwitcherProvider.ensureFreshScenarioCatalog()
                : null;

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
                                    scenarioCatalog = phaseSwitcherProvider.getScenarioCatalog() || scenarioCatalog;
                                    await clearAndFillNestedScenarios(document, true, scenarioCatalog);
                                }

                                if (paramsEnabled && shouldRefillScenarioParametersSection(document.getText())) {
                                    await clearAndFillScenarioParameters(document, true);
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
                    const scenarioCatalog = await phaseSwitcherProvider.ensureFreshScenarioCatalog();

                    progress.report({ increment: 15, message: t('Filling nested scenarios...') });
                    if (await clearAndFillNestedScenarios(document!, true, scenarioCatalog)) {
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
    void import('./nativeProjectCatalogSettings.js').then(async ({ registerNativeProjectCatalogSettings }) => {
        context.subscriptions.push(await registerNativeProjectCatalogSettings(context, phaseSwitcherProvider));
    }).catch(error => {
        console.error('[SettingsProvider] Failed to initialize project catalog settings:', error);
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not initialize project catalog settings: {0}', String(error)));
    });

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
                processingFiles.add(fileKey);

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
                                const scenarioCatalog = phaseSwitcherProvider.getScenarioCatalog()
                                    || await phaseSwitcherProvider.ensureFreshScenarioCatalog();
                                const result = await clearAndFillNestedScenarios(document, true, scenarioCatalog);
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
            internallyTriggeredSaves.delete(fileKey);
            clearScenarioParameterSessionCache(document);
        })
    );

    projectDefinitionIndex.start();
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

function updateScenarioPlainTextDecorationForEditor(
    editor: vscode.TextEditor,
    decorationType: vscode.TextEditorDecorationType
): void {
    const document = editor.document;
    if (!isScenarioYamlFile(document)) {
        editor.setDecorations(decorationType, []);
        return;
    }

    const ranges = collectScenarioPlainTextRanges(document);
    editor.setDecorations(decorationType, ranges);
}

function updateScenarioPlainTextDecorationsForDocument(
    document: vscode.TextDocument,
    decorationType: vscode.TextEditorDecorationType
): void {
    const uriString = document.uri.toString();
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === uriString) {
            updateScenarioPlainTextDecorationForEditor(editor, decorationType);
        }
    }
}

function updateScenarioPlainTextDecorationsForVisibleEditors(
    decorationType: vscode.TextEditorDecorationType
): void {
    for (const editor of vscode.window.visibleTextEditors) {
        updateScenarioPlainTextDecorationForEditor(editor, decorationType);
    }
}

function updateScenarioBracketParameterDecorationForEditor(
    editor: vscode.TextEditor,
    decorationType: vscode.TextEditorDecorationType
): void {
    const document = editor.document;
    if (!isScenarioYamlFile(document)) {
        editor.setDecorations(decorationType, []);
        return;
    }

    const ranges = collectScenarioBracketParameterRanges(document);
    editor.setDecorations(decorationType, ranges);
}

function updateScenarioBracketParameterDecorationsForDocument(
    document: vscode.TextDocument,
    decorationType: vscode.TextEditorDecorationType
): void {
    const uriString = document.uri.toString();
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === uriString) {
            updateScenarioBracketParameterDecorationForEditor(editor, decorationType);
        }
    }
}

function updateScenarioBracketParameterDecorationsForVisibleEditors(
    decorationType: vscode.TextEditorDecorationType
): void {
    for (const editor of vscode.window.visibleTextEditors) {
        updateScenarioBracketParameterDecorationForEditor(editor, decorationType);
    }
}

async function foldSectionsInEditor(editor: vscode.TextEditor | undefined) {
    if (!editor || !vscode.workspace.getConfiguration('kotTestToolkit').get<boolean>('editor.autoCollapseOnOpen')) { return; }
    const document = editor.document;
    if (!/\.ya?ml$/iu.test(document.fileName) || (!isScenarioYamlFile(document) && !isProcessYamlFile(document))) { return; }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (document.isClosed || vscode.window.activeTextEditor?.document !== document) { return; }
    const selectionLines = scenarioDefaultFoldLines(document.getText());
    if (selectionLines.length) {
        await vscode.commands.executeCommand('editor.fold', { levels: 1, direction: 'down', selectionLines });
    }
}

/**
 * Функция деактивации расширения. Вызывается VS Code при выгрузке расширения.
 * Используется для освобождения ресурсов.
 */
export function deactivate() {
    console.log('kotTestToolkit extension deactivated.');
}
