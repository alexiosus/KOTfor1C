import * as vscode from 'vscode';
import * as path from 'path'; 
import { v4 as uuidv4 } from 'uuid'; 

/**
 * Обработчик команды создания вложенного сценария.
 * Запрашивает имя, код, папку, создает папку с кодом и файл scen.yaml по шаблону.
 * @param context Контекст расширения для доступа к ресурсам (шаблонам).
 */
export async function handleCreateNestedScenario(context: vscode.ExtensionContext): Promise<void> {
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
        prompt: "Введите имя вложенного сценария",
        value: prefilledName, // Предзаполненное значение
        ignoreFocusOut: true,
        validateInput: value => value?.trim() ? null : "Имя не может быть пустым" // Проверка на пустоту
    });
    // Если пользователь нажал Escape или не ввел имя
    if (name === undefined) { console.log("[Cmd:createNestedScenario] Cancelled at name input."); return; }
    const trimmedName = name.trim();

    // 2. Запрос кода
    const code = await vscode.window.showInputBox({
        prompt: "Введите номерной код сценария (только цифры)",
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value?.trim();
            if (!trimmedValue) return "Код не может быть пустым";
            if (!/^\d+$/.test(trimmedValue)) return "Код должен содержать только цифры";
            return null; // Все в порядке
        }
    });
    if (code === undefined) { console.log("[Cmd:createNestedScenario] Cancelled at code input."); return; }
    const trimmedCode = code.trim();

    // 3. Определение пути по умолчанию для диалога выбора папки
    let defaultDialogUri: vscode.Uri | undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length) { // Проверяем, что воркспейс открыт
        const workspaceRootUri = workspaceFolders[0].uri;
        // Путь по умолчанию <workspaceRoot>/tests/RegressionTests/Yaml/Drive/
        const defaultSubPath = path.join('tests', 'RegressionTests', 'Yaml', 'Drive');
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
        openLabel: `Создать в папке '${trimmedCode}' здесь`, // Текст на кнопке подтверждения
        title: 'Выберите родительскую папку для вложенного сценария', // Заголовок окна
        defaultUri: defaultDialogUri // Начинаем с пути по умолчанию
    });
    // Если пользователь не выбрал папку
    if (!folderUris || folderUris.length === 0) { console.log("[Cmd:createNestedScenario] Cancelled at folder selection."); return; }
    const baseFolderUri = folderUris[0]; // Выбранная родительская папка

    // 5. Создание папок и файла
    const newUid = uuidv4();
    const scenarioFolderUri = vscode.Uri.joinPath(baseFolderUri, trimmedCode); // Итоговая папка: parent/code
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'scen.yaml'); // Шаблон
    const targetFileUri = vscode.Uri.joinPath(scenarioFolderUri, 'scen.yaml'); // Итоговый файл: parent/code/scen.yaml

    console.log(`[Cmd:createNestedScenario] Target folder: ${scenarioFolderUri.fsPath}`);
    // console.log(`[Cmd:createNestedScenario] Template path: ${templateUri.fsPath}`);

    try {
        // Создаем папку сценария (fs.createDirectory рекурсивна)
        await vscode.workspace.fs.createDirectory(scenarioFolderUri);

        // Читаем шаблон
        const templateBytes = await vscode.workspace.fs.readFile(templateUri);
        const templateContent = Buffer.from(templateBytes).toString('utf-8');

        // Заменяем плейсхолдеры
        const finalContent = templateContent
            .replace(/Name_Placeholder/g, trimmedName)
            .replace(/Code_Placeholder/g, trimmedCode)
            .replace(/UID_Placeholder/g, newUid);

        // Записываем новый файл
        await vscode.workspace.fs.writeFile(targetFileUri, Buffer.from(finalContent, 'utf-8'));

        console.log(`[Cmd:createNestedScenario] Success! Created: ${targetFileUri.fsPath}`);
        vscode.window.showInformationMessage(`Вложенный сценарий '${trimmedName}' (${trimmedCode}) успешно создан!`);

        // Открываем созданный файл в редакторе
        const doc = await vscode.workspace.openTextDocument(targetFileUri);
        await vscode.window.showTextDocument(doc);

    } catch (error: any) {
        console.error("[Cmd:createNestedScenario] Error:", error);
        vscode.window.showErrorMessage(`Ошибка при создании вложенного сценария: ${error.message || error}`);
    }
}


/**
 * Обработчик команды создания главного сценария.
 * Запрашивает имя, папку, создает папку с именем, файл scen.yaml и папку test с файлом name.yaml.
 * @param context Контекст расширения для доступа к ресурсам (шаблонам).
 */
export async function handleCreateMainScenario(context: vscode.ExtensionContext): Promise<void> {
    console.log("[Cmd:createMainScenario] Starting...");
    // 1. Запрос имени
    const name = await vscode.window.showInputBox({
        prompt: "Введите имя главного сценария (будет именем папки)",
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value?.trim();
            if (!trimmedValue) return "Имя не может быть пустым";
            // TODO: Добавить проверку на недопустимые символы в имени файла/папки (/, \\, :, *, ?, ", <, >, |)
            if (/[/\\:*\?"<>|]/.test(trimmedValue)) return "Имя содержит недопустимые символы";
            return null;
        }
    });
    if (name === undefined) { console.log("[Cmd:createMainScenario] Cancelled at name input."); return; }
    const trimmedName = name.trim();

    // 2. Запрос имени вкладки/фазы
    const tabName = await vscode.window.showInputBox({
        prompt: "Введите название фазы",
        placeHolder: "Например, 'Sales tests 1' или 'Новая Фаза'",
        ignoreFocusOut: true,
        validateInput: value => value?.trim() ? null : "Имя фазы не может быть пустым (нужно для отображения)"
    });
    if (tabName === undefined) { console.log("[Cmd:createMainScenario] Cancelled at tab name input."); return; }
    const trimmedTabName = tabName.trim();

    // 3. Запрос порядка сортировки (необязательно)
    const orderStr = await vscode.window.showInputBox({
        prompt: "Введите порядок внутри фазы",
        placeHolder: "Необязательно",
        ignoreFocusOut: true,
        validateInput: value => (!value || /^\d+$/.test(value.trim())) ? null : "Должно быть целым числом или пустым"
    });
    // Если пользователь нажал Esc, orderStr будет undefined. Если ввел и стер - пустая строка.
    if (orderStr === undefined) { console.log("[Cmd:createMainScenario] Cancelled at order input."); return; }
    // Сохраняем как строку (или пустую строку) для замены плейсхолдера
    const orderForTemplate = orderStr?.trim() || ""; // Если пусто, плейсхолдер заменится на пустую строку

    // 4. Запрос состояния по умолчанию (QuickPick)
    const defaultStatePick = await vscode.window.showQuickPick(['true', 'false'], {
        placeHolder: 'Состояние по умолчанию в Phase Switcher (необязательно)',
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Чекбокс будет включен по умолчанию?"
    });
    // Если пользователь нажал Esc, defaultStatePick будет undefined. Считаем это как 'true'.
    const defaultStateStr = defaultStatePick || 'true'; // Строка 'true' или 'false'


    // 2. Определение пути по умолчанию для диалога выбора папки
    let defaultDialogUri: vscode.Uri | undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length) {
        const workspaceRootUri = workspaceFolders[0].uri;
        // Путь по умолчанию <workspaceRoot>/tests/RegressionTests/Yaml/Drive/Parent scenarios
        // Убедитесь, что этот путь имеет смысл для вашего проекта
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
        openLabel: `Создать папку '${trimmedName}' здесь`,
        title: 'Выберите родительскую папку для главного сценария',
        defaultUri: defaultDialogUri
    });
    if (!folderUris || folderUris.length === 0) { console.log("[Cmd:createMainScenario] Cancelled at folder selection."); return; }
    const baseFolderUri = folderUris[0];

    // 4. Подготовка путей и UID
    const mainUid = uuidv4();
    const testRandomUid = uuidv4();
    const scenarioFolderUri = vscode.Uri.joinPath(baseFolderUri, trimmedName); // parent/ScenarioName
    const testFolderUri = vscode.Uri.joinPath(scenarioFolderUri, 'test'); // parent/ScenarioName/test
    const testTemplateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'test.yaml'); // Шаблон теста
    const mainTemplateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'main.yaml'); // Шаблон основного файла
    const testTargetFileUri = vscode.Uri.joinPath(testFolderUri, `${trimmedName}.yaml`);
    const mainTargetFileUri = vscode.Uri.joinPath(scenarioFolderUri, 'scen.yaml');

    console.log(`[Cmd:createMainScenario] Target folder: ${scenarioFolderUri.fsPath}`);
    // console.log(`[Cmd:createMainScenario] Test template: ${testTemplateUri.fsPath}`);
    // console.log(`[Cmd:createMainScenario] Main template: ${mainTemplateUri.fsPath}`);

    try {
        // Создаем папку сценария и вложенную папку test (рекурсивно)
        await vscode.workspace.fs.createDirectory(testFolderUri);

        // --- Создаем тестовый файл ---
        const testTemplateBytes = await vscode.workspace.fs.readFile(testTemplateUri);
        const testTemplateContent = Buffer.from(testTemplateBytes).toString('utf-8');
        const testFinalContent = testTemplateContent
            .replace(/Name_Placeholder/g, trimmedName)
            .replace(/UID_Placeholder/g, mainUid) 
            .replace(/Random_UID/g, testRandomUid);
        await vscode.workspace.fs.writeFile(testTargetFileUri, Buffer.from(testFinalContent, 'utf-8'));
        console.log(`[Cmd:createMainScenario] Created test file: ${testTargetFileUri.fsPath}`);

        // --- Создаем основной файл сценария ---
        const mainTemplateBytes = await vscode.workspace.fs.readFile(mainTemplateUri);
        const mainTemplateContent = Buffer.from(mainTemplateBytes).toString('utf-8');
        // В главном шаблоне Code_Placeholder заменяется на имя сценария
        const mainFinalContent = mainTemplateContent
            .replace(/Name_Placeholder/g, trimmedName)
            .replace(/Code_Placeholder/g, trimmedName) // Замена кода на имя
            .replace(/UID_Placeholder/g, mainUid)
            .replace(/Phase_Placeholder/g, trimmedTabName)
            .replace(/Default_Placeholder/g, defaultStateStr)
            .replace(/Order_Placeholder/g, orderForTemplate);
        await vscode.workspace.fs.writeFile(mainTargetFileUri, Buffer.from(mainFinalContent, 'utf-8'));
        console.log(`[Cmd:createMainScenario] Created main scenario file: ${mainTargetFileUri.fsPath}`);

        vscode.window.showInformationMessage(`Главный сценарий '${trimmedName}' успешно создан!`);
        // Открываем основной созданный файл
        const doc = await vscode.workspace.openTextDocument(mainTargetFileUri);
        await vscode.window.showTextDocument(doc);

    } catch (error: any) {
        console.error("[Cmd:createMainScenario] Error:", error);
        vscode.window.showErrorMessage(`Ошибка при создании главного сценария: ${error.message || error}`);
    }
}