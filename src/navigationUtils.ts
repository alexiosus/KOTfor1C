import * as vscode from 'vscode';
import { scanWorkspaceForScenarioCatalog } from './workspaceScanner';
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
