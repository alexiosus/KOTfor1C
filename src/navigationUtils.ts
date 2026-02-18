import * as vscode from 'vscode';
import * as path from 'path'; // Используется для path.basename в логах или QuickPick

/**
 * Асинхронно ищет первый YAML файл в папке tests,
 * содержащий строку 'Имя: "searchText"'.
 * @param searchText Текст имени для поиска (значение из кавычек).
 * @returns Promise с Uri найденного файла или null.
 */
export async function findFileByName(searchText: string, testCache?: Map<string, import('./types').TestInfo> | null): Promise<vscode.Uri | null> {
    // Try cache-based lookup first for performance
    if (testCache) {
        const cachedTestInfo = testCache.get(searchText);
        if (cachedTestInfo) {
            console.log(`[findFileByName] Cache hit for "${searchText}": ${cachedTestInfo.yamlFileUri.fsPath}`);
            return cachedTestInfo.yamlFileUri;
        }
        console.log(`[findFileByName] Cache miss for "${searchText}", falling back to file system search`);
    } else {
        console.log(`[findFileByName] No cache available for "${searchText}", using file system search`);
    }

    // Fallback to original file system search
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        console.warn("[findFileByName] Рабочая область не открыта.");
        return null;
    }
    // Ищем во всех YAML файлах в папке tests
    const globPattern = 'tests/**/*.yaml';
    const excludePattern = '**/node_modules/**'; // Стандартное исключение

    try {
        const fileUris = await vscode.workspace.findFiles(globPattern, excludePattern);
        // console.log(`[findFileByName] Found ${fileUris.length} potential YAML files to check for "${searchText}".`);

        for (const fileUri of fileUris) {
            try {
                const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                const content = Buffer.from(contentBytes).toString('utf-8');
                // Ищем строку Имя: "..." с точным совпадением имени
                const nameMatch = content.match(/Имя:\s*\"(.+?)\"/); // Находим первое вхождение
                if (nameMatch && nameMatch[1] === searchText) {
                     console.log(`[findFileByName] Match found for "${searchText}": ${fileUri.fsPath}`);
                    return fileUri; // Возвращаем URI первого найденного файла
                }
            } catch (readError: any) {
                 // Игнорируем ошибки чтения отдельных файлов
                 // console.error(`[findFileByName] Error reading ${fileUri.fsPath}: ${readError.message}`);
            }
        }
    } catch (findError: any) {
         console.error(`[findFileByName] Error during vscode.workspace.findFiles: ${findError.message || findError}`);
    }

    console.log(`[findFileByName] No file found containing 'Имя: "${searchText}"'`);
    return null; // Файл не найден
}

/**
 * Асинхронно ищет все вызовы вложенного сценария во всех YAML файлах в папке tests.
 * Поддерживаются ключевые слова: And, И, Допустим.
 * @param targetName Имя сценария для поиска ссылок (значение из поля "Имя:").
 * @param token Токен отмены операции (опционально).
 * @returns Promise с массивом найденных местоположений (vscode.Location).
 */
export async function findScenarioReferences(targetName: string, token?: vscode.CancellationToken): Promise<vscode.Location[]> {
    console.log(`[findScenarioReferences] Searching for nested scenario references: "${targetName}"...`);
    const locations: vscode.Location[] = [];
    const searchPattern = 'tests/**/*.yaml';
    const excludePattern = '**/node_modules/**';

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        console.warn("[findScenarioReferences] Рабочая область не открыта.");
        return locations; // Возвращаем пустой массив
    }

    try {
        const potentialFiles = await vscode.workspace.findFiles(searchPattern, excludePattern);
        console.log(`[findScenarioReferences] Found ${potentialFiles.length} potential files to search within.`);

        // Экранируем специальные символы Regex в targetName на всякий случай
        const escapedTargetName = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Ищем строку вида "<отступ><ключевое слово><пробелы><имя сценария>".
        // \s*$ позволяет наличие пробелов в конце строки, но ничего другого.
        const usageRegex = new RegExp(`^(\\s*)(And|И|Допустим)(\\s+)(${escapedTargetName})\\s*$`, 'i');

        for (const fileUri of potentialFiles) {
            if (token?.isCancellationRequested) {
                 console.log("[findScenarioReferences] Search cancelled by token.");
                 break;
            }
            try {
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                const fileContent = Buffer.from(fileContentBytes).toString('utf-8');
                const lines = fileContent.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    const currentLineText = lines[i];
                    const usageMatch = currentLineText.match(usageRegex);

                    if (usageMatch) {
                        const leadingSpaces = usageMatch[1].length;
                        const keyword = usageMatch[2];
                        const spacesAfterKeyword = usageMatch[3];
                        const nameInLine = usageMatch[4];
                        const startChar = leadingSpaces + keyword.length + spacesAfterKeyword.length;
                        const endChar = startChar + nameInLine.length;

                        const usageRange = new vscode.Range(i, startChar, i, endChar);
                        locations.push(new vscode.Location(fileUri, usageRange));
                        // console.log(`[findScenarioReferences] Found reference in ${fileUri.fsPath} at line ${i + 1}`);
                    }
                }
            } catch (readErr: any) {
                 // console.error(`[findScenarioReferences] Error reading ${fileUri.fsPath}: ${readErr.message}`);
            }
        }
    } catch (findErr: any) {
         console.error(`[findScenarioReferences] Error during vscode.workspace.findFiles: ${findErr.message || findErr}`);
    }

    console.log(`[findScenarioReferences] Found ${locations.length} reference locations for "${targetName}".`);
    return locations; // Возвращаем массив найденных Location
}
