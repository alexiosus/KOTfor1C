import * as vscode from 'vscode';
import * as path from 'path'; // Используется для path.basename в логах или QuickPick
import { findScenarioDescriptorUris, findYamlFilesUnderScanDir, readTextFileFast } from './workspaceScanner';
import { findScenarioReference } from './scenarioReferenceMatcher';

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
    try {
        const workspaceRootUri = workspaceFolders[0].uri;
        const fileUris = await findScenarioDescriptorUris(workspaceRootUri);
        // console.log(`[findFileByName] Found ${fileUris.length} potential YAML files to check for "${searchText}".`);

        for (const fileUri of fileUris) {
            try {
                const content = await readTextFileFast(fileUri);
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
 * Поддерживаются английские и русские ключевые слова шагов Gherkin.
 * @param targetName Имя сценария для поиска ссылок (значение из поля "Имя:").
 * @param token Токен отмены операции (опционально).
 * @returns Promise с массивом найденных местоположений (vscode.Location).
 */
export async function findScenarioReferences(targetName: string, token?: vscode.CancellationToken): Promise<vscode.Location[]> {
    console.log(`[findScenarioReferences] Searching for nested scenario references: "${targetName}"...`);
    const locations: vscode.Location[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        console.warn("[findScenarioReferences] Рабочая область не открыта.");
        return locations; // Возвращаем пустой массив
    }

    try {
        const workspaceRootUri = workspaceFolders[0].uri;
        const potentialFiles = await findYamlFilesUnderScanDir(workspaceRootUri, token);
        console.log(`[findScenarioReferences] Found ${potentialFiles.length} potential files to search within.`);

        for (const fileUri of potentialFiles) {
            if (token?.isCancellationRequested) {
                 console.log("[findScenarioReferences] Search cancelled by token.");
                 break;
            }
            try {
                const fileContent = await readTextFileFast(fileUri);
                const lines = fileContent.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    const currentLineText = lines[i];
                    const usageMatch = findScenarioReference(currentLineText, targetName);

                    if (usageMatch) {
                        const startChar = usageMatch.start;
                        const endChar = startChar + usageMatch.length;

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
