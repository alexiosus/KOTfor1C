import * as vscode from 'vscode';
import { findYamlFilesUnderScanDir, readTextFileFast, scanWorkspaceForScenarioCatalog } from './workspaceScanner';
import { findScenarioReference } from './scenarioReferenceMatcher';
import { resolveScenarioByName, type ScenarioCatalog } from './scenarioCatalog';
import type { TestInfo } from './types';

/**
 * Разрешает имя сценария через каталог и предлагает выбрать файл при дублировании.
 * @param searchText Текст имени для поиска (значение из кавычек).
 * @returns URI выбранного определения либо null, если оно не найдено или выбор отменён.
 */
async function pickScenarioDefinition(
    name: string,
    definitions: readonly TestInfo[]
): Promise<TestInfo | undefined> {
    const picked = await vscode.window.showQuickPick(
        definitions.map(scenario => ({
            label: scenario.relativePath || scenario.name,
            description: scenario.scenarioCode || scenario.uid,
            detail: scenario.yamlFileUri.fsPath,
            scenario
        })),
        {
            title: vscode.l10n.t('Multiple scenarios named "{0}"', name),
            ignoreFocusOut: true
        }
    );
    return picked?.scenario;
}

export async function findFileByName(
    searchText: string,
    scenarioCatalog?: ScenarioCatalog | null
): Promise<vscode.Uri | null> {
    let catalog = scenarioCatalog || null;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!catalog && (!workspaceFolders || workspaceFolders.length === 0)) {
        console.warn("[findFileByName] Рабочая область не открыта.");
        return null;
    }

    try {
        if (!catalog) {
            catalog = await scanWorkspaceForScenarioCatalog(workspaceFolders![0].uri);
        }

        const resolution = resolveScenarioByName(catalog, searchText);
        if (resolution.kind === 'unique') {
            return resolution.scenario.yamlFileUri;
        }
        if (resolution.kind === 'ambiguous') {
            return (await pickScenarioDefinition(searchText, resolution.scenarios))?.yamlFileUri || null;
        }
    } catch (error: any) {
        console.error(`[findFileByName] Error while resolving scenario: ${error.message || error}`);
    }

    console.log(`[findFileByName] No scenario definition found for "${searchText}".`);
    return null;
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
