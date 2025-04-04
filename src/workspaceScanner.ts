import * as vscode from 'vscode';
import * as path from 'path';
import { TestInfo } from './types';

// Путь для сканирования (относительно корня воркспейса)
export const SCAN_DIR_RELATIVE_PATH = "tests/RegressionTests/Yaml/Drive";
// Паттерн для поиска файлов сценариев внутри SCAN_DIR_RELATIVE_PATH
// Используем scen.yaml, т.к. он содержит метаданные
export const SCAN_GLOB_PATTERN = '**/scen.yaml';

/**
 * Сканирует директорию воркспейса на наличие файлов сценариев,
 * парсит их для извлечения метаданных и возвращает Map.
 * @param workspaceRootUri URI корневой папки воркспейса.
 * @param token Токен отмены.
 * @returns Promise с Map<string, TestInfo> или null в случае ошибки.
 */
export async function scanWorkspaceForTests(workspaceRootUri: vscode.Uri, token?: vscode.CancellationToken): Promise<Map<string, TestInfo> | null> {
    console.log("[scanWorkspaceForTests] Starting scan..."); // Оставим лог начала сканирования
    const discoveredTests = new Map<string, TestInfo>();
    const scanDirUri = vscode.Uri.joinPath(workspaceRootUri, SCAN_DIR_RELATIVE_PATH);
    console.log(`[scanWorkspaceForTests] Scanning directory: ${scanDirUri.fsPath} for pattern ${SCAN_GLOB_PATTERN}`);

    try {
        const relativePattern = new vscode.RelativePattern(scanDirUri, SCAN_GLOB_PATTERN);
        const potentialFiles = await vscode.workspace.findFiles(relativePattern, '**/node_modules/**');
        console.log(`[scanWorkspaceForTests] Found ${potentialFiles.length} potential files.`);

        for (const fileUri of potentialFiles) {
            if (token?.isCancellationRequested) { break; }

            try {
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                const fileContent = Buffer.from(fileContentBytes).toString('utf-8');
                const lines = fileContent.split('\n');

                let name: string | null = null;
                let tabName: string | null = null;
                let defaultState: boolean = false;
                let order: number = Infinity;
                let tabMarkerFound = false;

                for (const line of lines) {
                    if (name === null) {
                        const nameMatch = line.match(/^\s*Имя:\s*\"(.+?)\"\s*$/);
                        if (nameMatch) name = nameMatch[1];
                    }
                    const markerMatch = line.match(/^\s*#\s*PhaseSwitcher_(\w+):\s*(.*)/);
                    if (markerMatch) {
                        const key = markerMatch[1];
                        const value = markerMatch[2].trim();
                        switch (key) {
                            case 'Tab': if (value) { tabName = value; tabMarkerFound = true; } break;
                            case 'Default': defaultState = value.toLowerCase() === 'true'; break;
                            case 'OrderOnTab': const pOrder = parseInt(value, 10); if (!isNaN(pOrder)) order = pOrder; break;
                        }
                    }
                }

                if (name && tabMarkerFound && tabName) {
                    const parentDirFsPath = path.dirname(fileUri.fsPath);
                    const scanDirFsPath = scanDirUri.fsPath;
                    let relativePath = '';
                    if (parentDirFsPath.startsWith(scanDirFsPath)) {
                         relativePath = path.relative(scanDirFsPath, parentDirFsPath).replace(/\\/g, '/');
                    } else {
                         relativePath = vscode.workspace.asRelativePath(parentDirFsPath, false);
                         console.warn(`[scanWorkspaceForTests] File path ${relativePath} might be incorrect relative to scan dir`);
                    }
                    if (discoveredTests.has(name)) {
                         console.warn(`[scanWorkspaceForTests] Duplicate test name "${name}". Overwriting with ${fileUri.fsPath}`);
                    }
                    discoveredTests.set(name, { name, tabName, defaultState, order, yamlFileUri: fileUri, relativePath });
                }
            } catch (readErr: any) {
                 console.error(`[scanWorkspaceForTests] Error reading/parsing ${fileUri.fsPath}: ${readErr.message || readErr}`);
            }
        }
    } catch (findErr: any) {
        console.error(`[scanWorkspaceForTests] Error finding files: ${findErr.message || findErr}`);
        vscode.window.showErrorMessage("Ошибка при поиске файлов сценариев.");
        return null; // Возвращаем null при ошибке поиска
    }

    console.log(`[scanWorkspaceForTests] Scan finished. Added ${discoveredTests.size} tests.`);
    return discoveredTests;
}