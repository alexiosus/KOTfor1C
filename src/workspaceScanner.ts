import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestInfo } from './types';
import { getTranslator } from './localization';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';

// Function to get the scan directory path from configuration
export function getScanDirRelativePath(): string {
    const config = vscode.workspace.getConfiguration('1cDriveHelper');
    return config.get<string>('paths.yamlSourceDirectory') || 'tests/RegressionTests/yaml';
}

// Паттерн для поиска файлов сценариев внутри SCAN_DIR_RELATIVE_PATH
// Используем scen.yaml, т.к. он содержит метаданные
export const SCAN_GLOB_PATTERN = '**/scen.yaml';

function parseNestedScenarioNamesFromText(documentText: string): string[] {
    const names: string[] = [];
    const sectionRegex = /ВложенныеСценарии:\s*([\s\S]*?)(?=\n(?![ \t])[А-Яа-яЁёA-Za-z]+:|\n*$)/;
    const match = sectionRegex.exec(documentText);
    if (!match || !match[1]) {
        return names;
    }

    const nameRegex = /^\s*ИмяСценария:\s*"([^"]+)"/gm;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRegex.exec(match[1])) !== null) {
        const name = nameMatch[1].trim();
        if (name.length > 0) {
            names.push(name);
        }
    }

    return names;
}

/**
 * Сканирует директорию воркспейса на наличие файлов сценариев,
 * парсит их для извлечения метаданных и возвращает Map.
 * Теперь собирает все сценарии, у которых есть Имя, а не только те, что с PhaseSwitcher маркерами.
 * @param workspaceRootUri URI корневой папки воркспейса.
 * @param token Токен отмены.
 * @returns Promise с Map<string, TestInfo> или null в случае ошибки.
 */
export async function scanWorkspaceForTests(workspaceRootUri: vscode.Uri, token?: vscode.CancellationToken): Promise<Map<string, TestInfo> | null> {
    console.log("[scanWorkspaceForTests] Starting scan...");
    const discoveredTests = new Map<string, TestInfo>();
    const scanDirRelativePath = getScanDirRelativePath();
    const scanDirUri = vscode.Uri.joinPath(workspaceRootUri, scanDirRelativePath);
    console.log(`[scanWorkspaceForTests] Scanning directory: ${scanDirUri.fsPath} for pattern ${SCAN_GLOB_PATTERN}`);

    try {
        const relativePattern = new vscode.RelativePattern(scanDirUri, SCAN_GLOB_PATTERN);
        const potentialFiles = await vscode.workspace.findFiles(relativePattern, '**/node_modules/**', undefined, token);
        console.log(`[scanWorkspaceForTests] Found ${potentialFiles.length} potential files.`);

        for (const fileUri of potentialFiles) {
            if (token?.isCancellationRequested) { 
                console.log("[scanWorkspaceForTests] Scan cancelled.");
                break; 
            }

            try {
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                const fileContent = Buffer.from(fileContentBytes).toString('utf-8');
                const lines = fileContent.split('\n');
                const nestedScenarioNames = parseNestedScenarioNamesFromText(fileContent);
                const parsedParameterDefaults = parseScenarioParameterDefaults(fileContent);

                let name: string | null = null;
                let uid: string | null = null;
                let parsedTabName: string | undefined = undefined;
                let parsedDefaultState: boolean | undefined = undefined;
                let parsedOrder: number | undefined = undefined;
                let tabMarkerFound = false; // Флаг, что маркер # PhaseSwitcher_Tab был найден (даже если значение пустое)
                
                let parametersList: string[] = []; 
                let inParametersMainSection = false; 
                let parametersMainSectionIndent = -1; 

                let inParameterListItem = false; // Находимся ли мы внутри элемента списка параметров (начинающегося с "-")
                let parameterListItemIndent = -1; // Отступ строки, начинающей элемент списка ("- ")

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    // Нормализуем отступы в начале строки для консистентного анализа
                    const normalizedLineStart = line.replace(/^\t+/, tabs => '    '.repeat(tabs.length)); 
                    const currentLineIndent = (normalizedLineStart.match(/^(\s*)/) || [""])[0].length;

                    // Извлечение имени сценария
                    if (name === null) { 
                        const nameMatch = line.match(/^\s*Имя:\s*\"(.+?)\"\s*$/);
                        if (nameMatch && nameMatch[1]) {
                            name = nameMatch[1];
                        }
                    }

                    // Извлечение UID сценария
                    if (uid === null) {
                        const uidMatch = line.match(/^\s*UID:\s*\"(.+?)\"\s*$/);
                        if (uidMatch && uidMatch[1]) {
                            uid = uidMatch[1];
                        }
                    }

                    // Извлечение метаданных для PhaseSwitcher
                    const markerMatch = line.match(/^\s*#\s*PhaseSwitcher_(\w+):\s*(.*)/);
                    if (markerMatch) {
                        const key = markerMatch[1];
                        const value = markerMatch[2].trim();
                        switch (key) {
                            case 'Tab': 
                                parsedTabName = value || undefined; // Сохраняем undefined, если значение пустое
                                tabMarkerFound = true; // Отмечаем, что маркер был найден
                                break;
                            case 'Default': 
                                parsedDefaultState = value.toLowerCase() === 'true'; 
                                break;
                            case 'OrderOnTab': 
                                const pOrder = parseInt(value, 10); 
                                if (!isNaN(pOrder)) parsedOrder = pOrder; 
                                break;
                        }
                    }

                    // Логика для секции ПараметрыСценария
                    if (!inParametersMainSection && trimmedLine.startsWith("ПараметрыСценария:")) {
                        inParametersMainSection = true;
                        parametersMainSectionIndent = currentLineIndent;
                        parametersList = []; 
                        inParameterListItem = false; 
                        parameterListItemIndent = -1;
                        // console.log(`[scanner] Entered 'ПараметрыСценария' section in ${path.basename(fileUri.fsPath)} for scenario: ${name || 'Unknown'}. Indent: ${parametersMainSectionIndent}`);
                        continue; 
                    }

                    if (inParametersMainSection) {
                        // Проверка выхода из главной секции ПараметрыСценария
                        if (currentLineIndent <= parametersMainSectionIndent && 
                            trimmedLine !== "" && 
                            !trimmedLine.startsWith("#") && 
                            !trimmedLine.startsWith("ПараметрыСценария:") && 
                            trimmedLine.includes(":") &&
                            (trimmedLine.startsWith("ВложенныеСценарии:") || trimmedLine.startsWith("ТекстСценария:"))
                            ) {
                            // console.log(`[scanner] Exiting 'ПараметрыСценария' section in ${path.basename(fileUri.fsPath)} for scenario ${name || 'Unknown'} due to line: "${trimmedLine.substring(0,30)}..."`);
                            inParametersMainSection = false;
                        }
                    }

                    if (inParametersMainSection) {
                        // Внутри главной секции "ПараметрыСценария:"
                        // Ищем начало элемента списка параметров (строка, начинающаяся с "- ")
                        if (trimmedLine.startsWith("-") && currentLineIndent > parametersMainSectionIndent) {
                            // Проверяем, что это действительно начало блока параметра, а не просто дефис в значении
                            const afterDash = trimmedLine.substring(trimmedLine.indexOf("-") + 1).trim();
                            if (afterDash.startsWith("ПараметрыСценария") || afterDash.match(/^[A-Za-z0-9_А-Яа-я]+Сценария\d*:/)) { // Учитываем ПараметрыСценария1, ПараметрыСценария2
                                inParameterListItem = true;
                                // Отступ самого элемента списка (дефиса)
                                parameterListItemIndent = (normalizedLineStart.match(/^(\s*)-/)?.[1] || "").length; 
                                // console.log(`[scanner] Found parameter list item in ${path.basename(fileUri.fsPath)} for scenario ${name || 'Unknown'}. Item indent: ${parameterListItemIndent}. Line: "${trimmedLine.substring(0,40)}"`);
                                // Ключ самого элемента списка (например, "ПараметрыСценария1:") может быть на этой же строке или на следующей
                                const listItemKeyMatch = trimmedLine.match(/^-\s*([A-Za-z0-9_А-Яа-я]+Сценария\d*):/);
                                if (listItemKeyMatch) {
                                    // console.log(`[scanner] List item key: ${listItemKeyMatch[1]}`);
                                }
                                // Не continue, так как поля параметра могут быть на той же строке с большим отступом или на следующих
                            }
                        }
                        
                        if (inParameterListItem) {
                             // Поля "Имя:", "Значение:" и т.д. должны иметь больший отступ, чем сам элемент списка (дефис)
                            if (currentLineIndent > parameterListItemIndent) {
                                const paramNameMatch = trimmedLine.match(/^Имя:\s*\"(.+?)\"\s*$/);
                                if (paramNameMatch && paramNameMatch[1]) {
                                    parametersList.push(paramNameMatch[1]);
                                    // console.log(`[scanner] Found param name: "${paramNameMatch[1]}" in ${path.basename(fileUri.fsPath)} for scenario ${name || 'Unknown'}. Current params: [${parametersList.join(', ')}]`);
                                }
                            } else if (trimmedLine !== "" && !trimmedLine.startsWith("#") && currentLineIndent <= parameterListItemIndent) {
                                // Если отступ стал меньше или равен отступу элемента списка,
                                // и это не пустая строка/комментарий, значит, текущий элемент списка параметров закончился.
                                // console.log(`[scanner] Exiting parameter list item (due to indent) in ${path.basename(fileUri.fsPath)} for scenario ${name || 'Unknown'} from line: "${trimmedLine.substring(0,30)}..." (indent ${currentLineIndent} <= ${parameterListItemIndent})`);
                                inParameterListItem = false;
                                parameterListItemIndent = -1;
                                // Если эта строка - новый элемент списка, она будет обработана на следующей итерации
                                if (trimmedLine.startsWith("-") && currentLineIndent > parametersMainSectionIndent) {
                                     const afterDashCheck = trimmedLine.substring(trimmedLine.indexOf("-") + 1).trim();
                                     if (afterDashCheck.startsWith("ПараметрыСценария") || afterDashCheck.match(/^[A-Za-z0-9_А-Яа-я]+Сценария\d*:/)) {
                                        inParameterListItem = true;
                                        parameterListItemIndent = (normalizedLineStart.match(/^(\s*)-/)?.[1] || "").length;
                                        // console.log(`[scanner] Found new parameter list item '${trimmedLine.split(':')[0]}' immediately after previous one. Item indent: ${parameterListItemIndent}`);
                                        // continue; // Пропускаем обработку этой же строки как поля параметра
                                     }
                                }
                            }
                        }
                    }
                } // end for (const line of lines)

                // Добавляем сценарий, если у него есть имя.
                // Информация для PhaseSwitcher (tabName, defaultState, order) добавляется, только если был найден маркер # PhaseSwitcher_Tab
                if (name) {
                    if (discoveredTests.has(name)) {
                        //  console.warn(`[scanWorkspaceForTests] Duplicate test name "${name}". Overwriting with ${fileUri.fsPath}`);
                    }
                    const parentDirFsPath = path.dirname(fileUri.fsPath);
                    const scanDirFsPath = scanDirUri.fsPath;
                    let relativePathValue = '';
                    if (parentDirFsPath.startsWith(scanDirFsPath)) {
                         relativePathValue = path.relative(scanDirFsPath, parentDirFsPath).replace(/\\/g, '/');
                    } else {
                         relativePathValue = vscode.workspace.asRelativePath(parentDirFsPath, false);
                        //  console.warn(`[scanWorkspaceForTests] File path ${relativePathValue} for scenario "${name}" might be incorrect relative to scan dir ${scanDirFsPath}`);
                    }
                    
                    const uniqueParameters = parsedParameterDefaults.size > 0
                        ? Array.from(parsedParameterDefaults.keys())
                        : (parametersList.length > 0 ? [...new Set(parametersList)] : undefined);
                    const uniqueNestedScenarioNames = nestedScenarioNames.length > 0
                        ? [...new Set(nestedScenarioNames)]
                        : undefined;
                    const parameterDefaults = parsedParameterDefaults.size > 0
                        ? Object.fromEntries(parsedParameterDefaults.entries())
                        : undefined;

                    const testInfo: TestInfo = { 
                        name, 
                        yamlFileUri: fileUri, 
                        relativePath: relativePathValue,
                        parameters: uniqueParameters,
                        parameterDefaults,
                        nestedScenarioNames: uniqueNestedScenarioNames,
                        uid: uid || undefined
                    };

                    if (tabMarkerFound) { // Добавляем данные для PhaseSwitcher только если маркер был
                        testInfo.tabName = parsedTabName; // Может быть undefined, если значение маркера пустое
                        testInfo.defaultState = parsedDefaultState !== undefined ? parsedDefaultState : false; // По умолчанию false, если не указано
                        testInfo.order = parsedOrder !== undefined ? parsedOrder : Infinity; // По умолчанию Infinity, если не указано
                    }
                    
                    discoveredTests.set(name, testInfo);

                    const logParams = uniqueParameters ? `Parameters: [${uniqueParameters.join(', ')}]` : "(No parameters found)";
                    const logTab = testInfo.tabName ? `Tab: ${testInfo.tabName}` : "(No tab for PhaseSwitcher)";
                    // console.log(`[scanWorkspaceForTests] ADDED Scenario: ${name}, ${logTab}, ${logParams}, File: ${path.basename(fileUri.fsPath)}`);

                } else {
                    // console.log(`[scanWorkspaceForTests] SKIPPED file (missing name): ${fileUri.fsPath}.`);
                }
            } catch (readErr: any) {
                //  console.error(`[scanWorkspaceForTests] Error reading/parsing ${fileUri.fsPath}: ${readErr.message || readErr}`);
            }
        } // end for (const fileUri of potentialFiles)
    } catch (error) {
        console.error('[WorkspaceScanner] Error scanning workspace:', error);
        vscode.window.showErrorMessage(vscode.l10n.t('Error searching for scenario files.'));
        return new Map();
    }

    console.log(`[scanWorkspaceForTests] Scan finished. Total discovered tests: ${discoveredTests.size}.`);
    return discoveredTests;
}
