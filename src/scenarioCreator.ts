import * as vscode from 'vscode';
import { getTranslator } from './localization';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { YamlParametersManager } from './yamlParametersManager';
import { scanWorkspaceForTests } from './workspaceScanner';

type ScenarioLanguage = 'en' | 'ru';
type ScenarioIndex = {
    names: Set<string>;
    codes: Set<string>;
};

type ScenarioIndexCacheEntry = {
    workspaceRoot: string;
    loadedAt: number;
    index: ScenarioIndex;
};

const SCENARIO_INDEX_CACHE_TTL_MS = 60_000;
let scenarioIndexCache: ScenarioIndexCacheEntry | null = null;

const DRIVE_MAIN_SCENARIO_BLOCK = [
    '    And I set "Administrator" synonym to the current TestClient',
    '',
    '    And I initialize TestClient connections',
    '',
    '    And I save key parameters from pipeline and initialize main variables',
    '',
    '    And I click Infobase was transferred button',
    '',
    '    And I get main constant values',
    '',
    '    # Include scenarios here',
    '',
    '    And I close TestClient main window'
].join('\n');

function normalizeScenarioName(name: string): string {
    return name.trim().toLocaleLowerCase();
}

function normalizeScenarioCode(code: string): string {
    return code.trim().toLocaleLowerCase();
}

function createEmptyScenarioIndex(): ScenarioIndex {
    return {
        names: new Set<string>(),
        codes: new Set<string>()
    };
}

function getWorkspaceRootUri(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function getKnownScenarioIndex(): Promise<ScenarioIndex> {
    const workspaceRootUri = getWorkspaceRootUri();
    if (!workspaceRootUri) {
        return createEmptyScenarioIndex();
    }

    const workspaceRoot = workspaceRootUri.toString();
    const now = Date.now();
    if (
        scenarioIndexCache &&
        scenarioIndexCache.workspaceRoot === workspaceRoot &&
        now - scenarioIndexCache.loadedAt < SCENARIO_INDEX_CACHE_TTL_MS
    ) {
        return scenarioIndexCache.index;
    }

    const discoveredTests = await scanWorkspaceForTests(workspaceRootUri);
    const index = createEmptyScenarioIndex();
    if (discoveredTests) {
        for (const [scenarioName, testInfo] of discoveredTests.entries()) {
            index.names.add(normalizeScenarioName(scenarioName));
            if (typeof testInfo?.name === 'string' && testInfo.name.trim().length > 0) {
                index.names.add(normalizeScenarioName(testInfo.name));
            }
            if (typeof testInfo?.scenarioCode === 'string' && testInfo.scenarioCode.trim().length > 0) {
                index.codes.add(normalizeScenarioCode(testInfo.scenarioCode));
            }
        }
    }

    scenarioIndexCache = {
        workspaceRoot,
        loadedAt: now,
        index
    };
    return index;
}

function rememberScenarioInIndex(scenarioName: string, scenarioCode?: string): void {
    const workspaceRootUri = getWorkspaceRootUri();
    if (!workspaceRootUri) {
        return;
    }

    const workspaceRoot = workspaceRootUri.toString();
    const normalizedName = normalizeScenarioName(scenarioName);
    const normalizedCode = (scenarioCode || '').trim()
        ? normalizeScenarioCode(scenarioCode || '')
        : undefined;

    if (!scenarioIndexCache || scenarioIndexCache.workspaceRoot !== workspaceRoot) {
        const nextIndex = createEmptyScenarioIndex();
        nextIndex.names.add(normalizedName);
        if (normalizedCode) {
            nextIndex.codes.add(normalizedCode);
        }
        scenarioIndexCache = {
            workspaceRoot,
            loadedAt: Date.now(),
            index: nextIndex
        };
        return;
    }

    scenarioIndexCache.index.names.add(normalizedName);
    if (normalizedCode) {
        scenarioIndexCache.index.codes.add(normalizedCode);
    }
    scenarioIndexCache.loadedAt = Date.now();
}

function getNewScenarioLanguage(config: vscode.WorkspaceConfiguration): ScenarioLanguage {
    const configured = config.get<string>('editor.newScenarioLanguage', 'en');
    return configured === 'ru' ? 'ru' : 'en';
}

function applyScenarioLanguage(templateContent: string, language: ScenarioLanguage): string {
    return templateContent.replace(/#language:\s*(en|ru)\b/g, `#language: ${language}`);
}

function applyMainScenarioDriveBlock(templateContent: string, includeDriveBlock: boolean): string {
    const block = includeDriveBlock ? DRIVE_MAIN_SCENARIO_BLOCK : '';
    return templateContent.replace('    DriveMainScenarioBlock_Placeholder', block);
}

async function maybeAutoAddScenarioToFavorites(
    config: vscode.WorkspaceConfiguration,
    scenarioUri: vscode.Uri
): Promise<void> {
    const shouldAutoAdd = config.get<boolean>('phaseSwitcher.autoAddNewScenariosToFavorites', true);
    if (!shouldAutoAdd) {
        return;
    }
    const added = await vscode.commands.executeCommand<boolean>('kotTestToolkit._addScenarioFavoriteByUri', scenarioUri);
    if (added) {
        return;
    }

    await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
    await vscode.commands.executeCommand<boolean>('kotTestToolkit._addScenarioFavoriteByUri', scenarioUri);
}

/**
 * Обработчик команды создания вложенного сценария.
 * Запрашивает имя, код, папку, создает папку с кодом, файл scen.yaml и папку files.
 * @param context Контекст расширения для доступа к ресурсам (шаблонам).
 */
export async function handleCreateNestedScenario(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const newScenarioLanguage = getNewScenarioLanguage(config);
    const knownScenarioIndex = await getKnownScenarioIndex();
    const knownScenarioNames = knownScenarioIndex.names;
    const knownScenarioCodes = knownScenarioIndex.codes;
    console.log("[Cmd:createNestedScenario] Starting...");
    let prefilledName = '';
    const editor = vscode.window.activeTextEditor;
    // Попытка предзаполнить имя из активного редактора
    if (editor) {
        try {
            const position = editor.selection.active;
            const line = editor.document.lineAt(position.line);
            const lineMatch = line.text.match(/^\s*And\s+(.*)/);
            if (lineMatch && lineMatch[1]) {
                prefilledName = lineMatch[1].trim();
            }
        } catch (e) {
            console.warn("[Cmd:createNestedScenario] Could not get prefilled name from editor:", e);
        }
    }

    // 1. Запрос имени
    const name = await vscode.window.showInputBox({
        prompt: t('Enter nested scenario name'),
        value: prefilledName,
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value?.trim();
            if (!trimmedValue) {
                return t('Name cannot be empty');
            }
            if (knownScenarioNames.has(normalizeScenarioName(trimmedValue))) {
                return t('Scenario name "{0}" already exists.', trimmedValue);
            }
            return null;
        }
    });
    // Если пользователь нажал Escape или не ввел имя
    if (name === undefined) { console.log("[Cmd:createNestedScenario] Cancelled at name input."); return; }
    const trimmedName = name.trim();
    if (knownScenarioNames.has(normalizeScenarioName(trimmedName))) {
        vscode.window.showErrorMessage(t('Scenario name "{0}" already exists.', trimmedName));
        return;
    }

    // 2. Запрос кода
    const code = await vscode.window.showInputBox({
        prompt: t('Enter scenario numeric code (digits only)'),
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value?.trim();
            if (!trimmedValue) return t('Code cannot be empty');
            if (!/^\d+$/.test(trimmedValue)) return t('Code must contain digits only');
            if (knownScenarioCodes.has(normalizeScenarioCode(trimmedValue))) {
                return t('Scenario code "{0}" already exists.', trimmedValue);
            }
            return null;
        }
    });
    if (code === undefined) { console.log("[Cmd:createNestedScenario] Cancelled at code input."); return; }
    const trimmedCode = code.trim();
    if (knownScenarioCodes.has(normalizeScenarioCode(trimmedCode))) {
        vscode.window.showErrorMessage(t('Scenario code "{0}" already exists.', trimmedCode));
        return;
    }

    // 3. Определение пути по умолчанию для диалога выбора папки
    let defaultDialogUri: vscode.Uri | undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length) { // Проверяем, что воркспейс открыт
        const workspaceRootUri = workspaceFolders[0].uri;
        // Путь по умолчанию из настроек
        const defaultSubPath = config.get<string>('paths.yamlSourceDirectory') || 'tests/RegressionTests/yaml';
        try {
            defaultDialogUri = vscode.Uri.joinPath(workspaceRootUri, defaultSubPath);
            // console.log(`[Cmd:createNestedScenario] Default dialog path set to: ${defaultDialogUri.fsPath}`);
        } catch (error) {
            console.error(`[Cmd:createNestedScenario] Error constructing default path URI: ${error}`);
            defaultDialogUri = workspaceRootUri; // Откат к корню при ошибке
        }
    }

    // 4. Запрос пути для создания сценария (родительской папки)
    const folderUris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true, // Разрешаем выбор только папок
        canSelectMany: false, // Только одну папку
        openLabel: t('Create folder "{0}" here', trimmedCode),
        title: t('Select parent folder for nested scenario'),
        defaultUri: defaultDialogUri // Начинаем с пути по умолчанию
    });
    // Если пользователь не выбрал папку
    if (!folderUris || folderUris.length === 0) { console.log("[Cmd:createNestedScenario] Cancelled at folder selection."); return; }
    const baseFolderUri = folderUris[0]; // Выбранная родительская папка

    // 5. Создание папок и файла
    const newUid = uuidv4();
    const scenarioFolderUri = vscode.Uri.joinPath(baseFolderUri, trimmedCode); // Итоговая папка: parent/code
    const filesFolderUri = vscode.Uri.joinPath(scenarioFolderUri, 'files'); // Папка для файлов
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'scen.yaml'); // Шаблон
    const targetFileUri = vscode.Uri.joinPath(scenarioFolderUri, 'scen.yaml'); // Итоговый файл: parent/code/scen.yaml

    console.log(`[Cmd:createNestedScenario] Target folder: ${scenarioFolderUri.fsPath}`);
    // console.log(`[Cmd:createNestedScenario] Template path: ${templateUri.fsPath}`);

    try {
        // Создаем папку сценария (fs.createDirectory рекурсивна)
        await vscode.workspace.fs.createDirectory(scenarioFolderUri);
        // Создаем пустую папку files
        await vscode.workspace.fs.createDirectory(filesFolderUri);

        // Читаем шаблон
        const templateBytes = await vscode.workspace.fs.readFile(templateUri);
        const templateContent = Buffer.from(templateBytes).toString('utf-8');

        // Заменяем плейсхолдеры
        const finalContent = applyScenarioLanguage(templateContent
            .replace(/Name_Placeholder/g, trimmedName)
            .replace(/Code_Placeholder/g, trimmedCode)
            .replace(/UID_Placeholder/g, newUid), newScenarioLanguage);

        // Записываем новый файл
        await vscode.workspace.fs.writeFile(targetFileUri, Buffer.from(finalContent, 'utf-8'));
        rememberScenarioInIndex(trimmedName, trimmedCode);

        console.log(`[Cmd:createNestedScenario] Success! Created: ${targetFileUri.fsPath}`);
        vscode.window.showInformationMessage(t('Nested scenario "{0}" ({1}) has been created successfully!', trimmedName, trimmedCode));

        // Открываем созданный файл в редакторе
        const doc = await vscode.workspace.openTextDocument(targetFileUri);
        await vscode.window.showTextDocument(doc);

        // Обновляем Test Manager
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
        await maybeAutoAddScenarioToFavorites(config, targetFileUri);

    } catch (error: any) {
        console.error("[Cmd:createNestedScenario] Error:", error);
        vscode.window.showErrorMessage(t('Error creating nested scenario: {0}', error.message || String(error)));
    }
}


/**
 * Обработчик команды создания главного сценария.
 * Запрашивает имя, папку, создает папку с именем, файл scen.yaml, папку test с файлом name.yaml и папку files.
 * @param context Контекст расширения для доступа к ресурсам (шаблонам).
 */
export async function handleCreateMainScenario(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const newScenarioLanguage = getNewScenarioLanguage(config);
    const includeDriveBlock = config.get<boolean>('assembleScript.showDriveFeatures', false);
    const knownScenarioIndex = await getKnownScenarioIndex();
    const knownScenarioNames = knownScenarioIndex.names;
    const knownScenarioCodes = knownScenarioIndex.codes;
    console.log("[Cmd:createMainScenario] Starting...");
    // 1. Запрос имени
    const name = await vscode.window.showInputBox({
        prompt: t('Enter main scenario name (folder name)'),
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value?.trim();
            if (!trimmedValue) return t('Name cannot be empty');
            if (/[/\\:*\?"<>|]/.test(trimmedValue)) return t('Name contains invalid characters');
            if (knownScenarioNames.has(normalizeScenarioName(trimmedValue))) {
                return t('Scenario name "{0}" already exists.', trimmedValue);
            }
            if (knownScenarioCodes.has(normalizeScenarioCode(trimmedValue))) {
                return t('Scenario code "{0}" already exists.', trimmedValue);
            }
            return null;
        }
    });
    if (name === undefined) { console.log("[Cmd:createMainScenario] Cancelled at name input."); return; }
    const trimmedName = name.trim();
    if (knownScenarioNames.has(normalizeScenarioName(trimmedName))) {
        vscode.window.showErrorMessage(t('Scenario name "{0}" already exists.', trimmedName));
        return;
    }
    if (knownScenarioCodes.has(normalizeScenarioCode(trimmedName))) {
        vscode.window.showErrorMessage(t('Scenario code "{0}" already exists.', trimmedName));
        return;
    }

    // 2. Запрос имени вкладки/фазы
    const tabName = await vscode.window.showInputBox({
        prompt: t('Enter group name'),
        placeHolder: t('For example, "Sales tests 1" or "New Group"'),
        ignoreFocusOut: true,
        validateInput: value => value?.trim() ? null : t('Group name cannot be empty (required for display)')
    });
    if (tabName === undefined) { console.log("[Cmd:createMainScenario] Cancelled at tab name input."); return; }
    const trimmedTabName = tabName.trim();

    // 3. Запрос порядка сортировки (необязательно)
    const orderStr = await vscode.window.showInputBox({
        prompt: t('Enter order within the group'),
        placeHolder: t('Optional'),
        ignoreFocusOut: true,
        validateInput: value => (!value || /^\d+$/.test(value.trim())) ? null : t('Must be an integer or empty')
    });
    // Если пользователь нажал Esc, orderStr будет undefined. Если ввел и стер - пустая строка.
    if (orderStr === undefined) { console.log("[Cmd:createMainScenario] Cancelled at order input."); return; }
    // Сохраняем как строку (или пустую строку) для замены плейсхолдера
    const orderForTemplate = orderStr?.trim() || ""; // Если пусто, плейсхолдер заменится на пустую строку

    // 4. Запрос состояния по умолчанию (QuickPick)
    const defaultStatePick = await vscode.window.showQuickPick(['true', 'false'], {
        placeHolder: t('Default state in Test Manager (optional)'),
        canPickMany: false,
        ignoreFocusOut: true,
        title: t('Checkbox enabled by default?')
    });
    // Если пользователь нажал Esc, defaultStatePick будет undefined. Считаем это как 'true'.
    const defaultStateStr = defaultStatePick || 'true'; // Строка 'true' или 'false'


    // 2. Определение пути по умолчанию для диалога выбора папки
    let defaultDialogUri: vscode.Uri | undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length) {
        const workspaceRootUri = workspaceFolders[0].uri;
        const defaultSubPath = path.join('tests', 'RegressionTests', 'Yaml', 'Drive', 'Parent scenarios');
         try {
            defaultDialogUri = vscode.Uri.joinPath(workspaceRootUri, defaultSubPath);
            // console.log(`[Cmd:createMainScenario] Default dialog path set to: ${defaultDialogUri.fsPath}`);
        } catch (error) {
            console.error(`[Cmd:createMainScenario] Error constructing default path URI: ${error}`);
            defaultDialogUri = workspaceRootUri; // Откат к корню
        }
    }

    // 3. Запрос пути для создания (родительской папки)
    const folderUris = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: t('Create folder "{0}" here', trimmedName),
        title: t('Select parent folder for main scenario'),
        defaultUri: defaultDialogUri
    });
    if (!folderUris || folderUris.length === 0) { console.log("[Cmd:createMainScenario] Cancelled at folder selection."); return; }
    const baseFolderUri = folderUris[0];

    // 4. Подготовка путей и UID
    const mainUid = uuidv4();
    const testRandomUid = uuidv4();
    const scenarioFolderUri = vscode.Uri.joinPath(baseFolderUri, trimmedName); // parent/ScenarioName
    const testFolderUri = vscode.Uri.joinPath(scenarioFolderUri, 'test'); // parent/ScenarioName/test
    const filesFolderUri = vscode.Uri.joinPath(scenarioFolderUri, 'files'); // parent/ScenarioName/files
    const testTemplateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'test.yaml'); // Шаблон теста
    const mainTemplateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'main.yaml'); // Шаблон основного файла
    const testTargetFileUri = vscode.Uri.joinPath(testFolderUri, `${trimmedName}.yaml`);
    const mainTargetFileUri = vscode.Uri.joinPath(scenarioFolderUri, 'scen.yaml');

    console.log(`[Cmd:createMainScenario] Target folder: ${scenarioFolderUri.fsPath}`);
    // console.log(`[Cmd:createMainScenario] Test template: ${testTemplateUri.fsPath}`);
    // console.log(`[Cmd:createMainScenario] Main template: ${mainTemplateUri.fsPath}`);

    try {
        // Создаем папку сценария и вложенные папки test и files (рекурсивно)
        await vscode.workspace.fs.createDirectory(testFolderUri);
        await vscode.workspace.fs.createDirectory(filesFolderUri);

        // --- Получаем ModelDBid из менеджера параметров ---
        const yamlParametersManager = YamlParametersManager.getInstance(context);
        const parameters = await yamlParametersManager.loadParameters();
        const modelDBidParam = parameters.find(p => p.key === "ModelDBid");
        const modelDBid = modelDBidParam ? modelDBidParam.value : "EtalonDrive"; // Значение по умолчанию, если не найдено

        // --- Создаем тестовый файл ---
        const testTemplateBytes = await vscode.workspace.fs.readFile(testTemplateUri);
        const testTemplateContent = Buffer.from(testTemplateBytes).toString('utf-8');
        const testFinalContent = testTemplateContent
            .replace(/Name_Placeholder/g, trimmedName)
            .replace(/UID_Placeholder/g, mainUid) 
            .replace(/Random_UID/g, testRandomUid)
            .replace(/ModelDBib_Placeholder/g, `${modelDBid}`); 
        await vscode.workspace.fs.writeFile(testTargetFileUri, Buffer.from(testFinalContent, 'utf-8'));
        console.log(`[Cmd:createMainScenario] Created test file: ${testTargetFileUri.fsPath} with ModelDBid: ${modelDBid}`);


        // --- Создаем основной файл сценария ---
        const mainTemplateBytes = await vscode.workspace.fs.readFile(mainTemplateUri);
        const mainTemplateContent = Buffer.from(mainTemplateBytes).toString('utf-8');
        // В главном шаблоне Code_Placeholder заменяется на имя сценария
        const mainFinalContent = applyMainScenarioDriveBlock(applyScenarioLanguage(mainTemplateContent
            .replace(/Name_Placeholder/g, trimmedName)
            .replace(/Code_Placeholder/g, trimmedName) 
            .replace(/UID_Placeholder/g, mainUid)
            .replace(/Phase_Placeholder/g, trimmedTabName)
            .replace(/Default_Placeholder/g, defaultStateStr)
            .replace(/Order_Placeholder/g, orderForTemplate), newScenarioLanguage), includeDriveBlock);
        await vscode.workspace.fs.writeFile(mainTargetFileUri, Buffer.from(mainFinalContent, 'utf-8'));
        rememberScenarioInIndex(trimmedName, trimmedName);
        console.log(`[Cmd:createMainScenario] Created main scenario file: ${mainTargetFileUri.fsPath}`);

        vscode.window.showInformationMessage(t('Main scenario "{0}" has been created successfully!', trimmedName));
        // Открываем основной созданный файл
        const doc = await vscode.workspace.openTextDocument(mainTargetFileUri);
        await vscode.window.showTextDocument(doc);

        // Обновляем Test Manager
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
        await maybeAutoAddScenarioToFavorites(config, mainTargetFileUri);

    } catch (error: any) {
        console.error("[Cmd:createMainScenario] Error:", error);
        vscode.window.showErrorMessage(t('Error creating main scenario: {0}', error.message || String(error)));
    }
}
