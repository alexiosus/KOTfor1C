import * as vscode from 'vscode';
import { getTranslator } from './localization';
import { getExtensionUri } from './appContext';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { findFileByName, findScenarioReferences } from './navigationUtils';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { TestInfo } from './types';
import JSZip = require('jszip');

/**
 * Общая функция для поиска файла по выделенному тексту в редакторе.
 * Реализует "умный" поиск: сначала в приоритетных директориях, затем глобально.
 * @param textEditor Активный текстовый редактор.
 * @param phaseSwitcherProvider Провайдер панели для доступа к кешу тестов.
 * @param specificExtension Если указано, поиск будет в первую очередь нацелен на это расширение.
 * @returns Promise с Uri найденного файла или null.
 */
async function findFileFromText(
    textEditor: vscode.TextEditor,
    phaseSwitcherProvider: PhaseSwitcherProvider,
    specificExtension?: string
): Promise<vscode.Uri | null> {
    const selection = textEditor.selection;
    const t = await getTranslator(getExtensionUri());
    if (selection.isEmpty) {
        vscode.window.showInformationMessage(t('Select a file name to search.'));
        return null;
    }

    const fileNameRaw = textEditor.document.getText(selection).trim().replace(/["']/g, '');
    if (!fileNameRaw) return null;

    const hasExtension = path.extname(fileNameRaw) !== '';
    const potentialFileNames = new Set<string>([fileNameRaw]);

    // Если ищем конкретное расширение и его нет в выделении, добавляем его
    if (specificExtension && !hasExtension) {
        potentialFileNames.add(`${fileNameRaw}${specificExtension}`);
    } 
    // Если расширение есть, также ищем файл без него (на случай, если это часть имени)
    else if (hasExtension) {
        potentialFileNames.add(path.basename(fileNameRaw, path.extname(fileNameRaw)));
    }

    console.log(`[Cmd:findFileFromText] Searching for: ${Array.from(potentialFileNames).join(' or ')}`);

    const searchPaths = new Set<string>();

    // Приоритет №1: Папка 'files' рядом с текущим файлом
    const currentFileDir = path.dirname(textEditor.document.uri.fsPath);
    searchPaths.add(path.join(currentFileDir, 'files'));

    // Приоритет №2: Папки 'files' из вложенных сценариев
    const testCache = phaseSwitcherProvider.getTestCache();
    const documentText = textEditor.document.getText();
    if (testCache) {
        const callRegex = /^\s*(?:And|И)\s+(.+)/gm;
        let match;
        while ((match = callRegex.exec(documentText)) !== null) {
            const scenarioName = match[1].trim();
            const testInfo = testCache.get(scenarioName);
            if (testInfo) {
                const scenarioDir = path.dirname(testInfo.yamlFileUri.fsPath);
                searchPaths.add(path.join(scenarioDir, 'files'));
            }
        }
    }
    console.log(`[Cmd:findFileFromText] Priority search paths:`, Array.from(searchPaths));

    // Единый поиск по приоритетным путям
    for (const dir of searchPaths) {
        for (const name of potentialFileNames) {
            const fullPath = path.join(dir, name);
            try {
                await fs.promises.access(fullPath, fs.constants.F_OK);
                console.log(`[Cmd:findFileFromText] Found file in priority path: ${fullPath}`);
                return vscode.Uri.file(fullPath);
            } catch (error) {
                // Файл не найден, продолжаем
            }
        }
    }

    // Поиск файла сценария по имени (только для имен без расширения)
    for (const name of potentialFileNames) {
        if (path.extname(name) === '') {
            const scenarioUri = await findFileByName(name);
            if (scenarioUri) {
                console.log(`[Cmd:findFileFromText] Found scenario file: ${scenarioUri.fsPath}`);
                return scenarioUri;
            }
        }
    }

    // Запасной вариант: Глобальный поиск по всем потенциальным именам в папке tests
    console.log(`[Cmd:findFileFromText] File not in priority paths. Starting global search in 'tests' folder...`);
    const globPattern = `tests/**/{${Array.from(potentialFileNames).map(n => n.replace(/[\[\]\{\}]/g, '?')).join(',')}}`;
    const foundFiles = await vscode.workspace.findFiles(globPattern, '**/node_modules/**', 1);

    if (foundFiles.length > 0) {
        console.log(`[Cmd:findFileFromText] Found file via global search: ${foundFiles[0].fsPath}`);
        return foundFiles[0];
    }

    // Если ничего не найдено, а расширения не было, делаем последний глобальный поиск по имени файла с любым расширением в папке tests
    if (!hasExtension) {
        console.log(`[Cmd:findFileFromText] Final attempt: global search for 'tests/**/${fileNameRaw}.*'`);
        const finalGlobPattern = `tests/**/${fileNameRaw}.*`;
        const finalFound = await vscode.workspace.findFiles(finalGlobPattern, '**/node_modules/**', 1);
        if (finalFound.length > 0) {
            console.log(`[Cmd:findFileFromText] Found file via final global search: ${finalFound[0].fsPath}`);
            return finalFound[0];
        }
    }

    vscode.window.showInformationMessage(t('File "{0}" not found in the project.', fileNameRaw));
    return null;
}


/**
 * Открывает указанный файл с помощью '1С:Предприятие — работа с файлами'.
 * @param filePath Абсолютный путь к MXL файлу.
 */
async function openMxlWithFileWorkshop(filePath: string) {
    console.log(`[Cmd:openMxl] Attempting to open: ${filePath}`);
    const config = vscode.workspace.getConfiguration('1cDriveHelper.paths');
    const fileWorkshopPath = config.get<string>('fileWorkshopExe');
    const t = await getTranslator(getExtensionUri());

    if (!fileWorkshopPath) {
        vscode.window.showErrorMessage(
            t("Path to '1C:Enterprise — File workshop' is not configured. Set it in `1cDriveHelper.paths.fileWorkshopExe`."),
            t('Open Settings')
        ).then(selection => {
            if (selection === t('Open Settings')) {
                vscode.commands.executeCommand('workbench.action.openSettings', '1cDriveHelper.paths.fileWorkshopExe');
            }
        });
        return;
    }

    if (!fs.existsSync(fileWorkshopPath)) {
        vscode.window.showErrorMessage(
            t(`Executable for '1C:Enterprise — work with files' not found at path: {0}`, fileWorkshopPath),
            t('Open Settings')
        ).then(selection => {
            if (selection === t('Open Settings')) {
                vscode.commands.executeCommand('workbench.action.openSettings', '1cDriveHelper.paths.fileWorkshopExe');
            }
        });
        return;
    }

    const command = `"${fileWorkshopPath}" "${filePath}"`;
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`[Cmd:openMxl] Exec error: ${error}`);
            vscode.window.showErrorMessage(t('Error opening MXL file: {0}', error.message));
            return;
        }
        if (stderr) {
            console.error(`[Cmd:openMxl] Stderr: ${stderr}`);
        }
        console.log(`[Cmd:openMxl] Successfully executed: ${command}`);
    });
}

/**
 * Обработчик команды открытия MXL из проводника VS Code.
 * @param uri URI выбранного файла.
 */
export function openMxlFileFromExplorerHandler(uri: vscode.Uri) {
    if (uri && uri.fsPath) {
        openMxlWithFileWorkshop(uri.fsPath);
    } else {
        console.warn('[Cmd:openMxlFromExplorer] Command triggered without a valid URI.');
    }
}

/**
 * Обработчик команды открытия MXL из текстового редактора.
 * @param textEditor Активный текстовый редактор.
 * @param edit Объект для редактирования.
 * @param phaseSwitcherProvider Провайдер панели для доступа к кешу тестов.
 */
export async function openMxlFileFromTextHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, phaseSwitcherProvider: PhaseSwitcherProvider) {
    const t = await getTranslator(getExtensionUri());
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Searching for files...'),
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 25, message: t('Opening MXL file...') });
        
        const fileUri = await findFileFromText(textEditor, phaseSwitcherProvider, '.mxl');
        if (fileUri) {
            if (path.extname(fileUri.fsPath).toLowerCase() === '.mxl') {
                await openMxlWithFileWorkshop(fileUri.fsPath);
                progress.report({ increment: 100, message: t('MXL file opened successfully.') });
            } else {
                vscode.window.showWarningMessage(t('Found file is not an MXL file: {0}', fileUri.fsPath));
            }
        } else {
            vscode.window.showInformationMessage(t('File not found.'));
        }
    });
}

/**
 * Обработчик команды "Показать файл в проводнике VS Code".
 * @param textEditor Активный текстовый редактор.
 * @param edit Объект для редактирования.
 * @param phaseSwitcherProvider Провайдер панели для доступа к кешу тестов.
 */
export async function revealFileInExplorerHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, phaseSwitcherProvider: PhaseSwitcherProvider) {
    const t = await getTranslator(getExtensionUri());
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Searching for files...'),
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 25, message: t('Revealing file in explorer...') });
        
        const fileUri = await findFileFromText(textEditor, phaseSwitcherProvider);
        if (fileUri) {
            await vscode.commands.executeCommand('revealInExplorer', fileUri);
            progress.report({ increment: 100, message: t('File revealed in explorer.') });
        } else {
            vscode.window.showInformationMessage(t('File not found.'));
        }
    });
}

/**
 * Обработчик команды "Открыть в проводнике".
 * @param textEditor Активный текстовый редактор.
 * @param edit Объект для редактирования.
 * @param phaseSwitcherProvider Провайдер панели для доступа к кешу тестов.
 */
export async function revealFileInOSHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, phaseSwitcherProvider: PhaseSwitcherProvider) {
    const t = await getTranslator(getExtensionUri());
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Searching for files...'),
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 25, message: t('Opening file in OS...') });
        
        const fileUri = await findFileFromText(textEditor, phaseSwitcherProvider);
        if (fileUri) {
            await vscode.commands.executeCommand('revealFileInOS', fileUri);
            progress.report({ increment: 100, message: t('File opened in OS.') });
        } else {
            vscode.window.showInformationMessage(t('File not found.'));
        }
    });
}


/**
 * Обработчик команды открытия вложенного сценария.
 * Ищет файл сценария по имени и открывает его в редакторе.
 */
export async function openSubscenarioHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const t = await getTranslator(getExtensionUri());
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Searching for scenario files...'),
        cancellable: false
    }, async (progress) => {
        const document = textEditor.document;
        const position = textEditor.selection.active;
        const line = document.lineAt(position.line);
        const lineMatch = line.text.match(/^(\s*)(?:And|Then|When|И|Когда|Тогда)\s+(.*)/i);
        
        if (!lineMatch) { 
            return; 
        }
        
        const scenarioNameFromLine = lineMatch[2].trim();
        if (!scenarioNameFromLine) { 
            return; 
        }
        
        const keywordAndSpaceLength = lineMatch[0].length - lineMatch[2].length - lineMatch[1].length; 
        const startChar = lineMatch[1].length + keywordAndSpaceLength;
        const endChar = startChar + scenarioNameFromLine.length;
        const range = new vscode.Range(position.line, startChar, position.line, endChar);

        if (!range.contains(position) && !range.isEmpty) { 
            if (!(range.end.isEqual(position) && textEditor.selection.isEmpty)) {
                return;
            }
        }

        console.log(`[Cmd:openSubscenario] Request for: "${scenarioNameFromLine}"`);
        
        progress.report({ increment: 25, message: t('Opening scenario file...') });
        
        const targetUri = await findFileByName(scenarioNameFromLine);
        if (targetUri && targetUri.fsPath !== document.uri.fsPath) {
            console.log(`[Cmd:openSubscenario] Target found: ${targetUri.fsPath}. Opening...`);
            try {
                const docToOpen = await vscode.workspace.openTextDocument(targetUri);
                await vscode.window.showTextDocument(docToOpen, { preview: false, preserveFocus: false });
                progress.report({ increment: 100, message: t('Scenario file opened successfully.') });
            } catch (error: any) { 
                console.error(`[Cmd:openSubscenario] Error opening ${targetUri.fsPath}:`, error); 
                vscode.window.showErrorMessage(t('Failed to open file: {0}', error.message || error)); 
            }
        } else { 
            console.log("[Cmd:openSubscenario] Target not found."); 
            vscode.window.showInformationMessage(t('File for "{0}" not found.', scenarioNameFromLine)); 
        }
    });
}

/**
 * Обработчик команды поиска ссылок на текущий сценарий.
 */
export async function findCurrentFileReferencesHandler() {
    const t = await getTranslator(getExtensionUri());
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Searching for scenario references...'),
        cancellable: false
    }, async (progress) => {
        console.log("[Cmd:findCurrentFileReferences] Triggered.");
        const editor = vscode.window.activeTextEditor;
        if (!editor) { 
            vscode.window.showWarningMessage(t('No active editor.')); 
            return; 
        }
        
        const document = editor.document;
        // if (document.languageId !== 'yaml') { vscode.window.showWarningMessage("Команда работает только для YAML."); return; }

        let targetName: string | undefined;
        const lineCount = document.lineCount;
        const nameRegex = /^\s*Имя:\s*\"(.+?)\"\s*$/;
        for (let i = 0; i < lineCount; i++) {
            const line = document.lineAt(i); 
            const nameMatch = line.text.match(nameRegex);
            if (nameMatch) { 
                targetName = nameMatch[1]; 
                break; 
            }
        }
        
        if (!targetName) { 
            vscode.window.showInformationMessage(t('Could not find "Name: \"...\"" in the current file.')); 
            return; 
        }

        progress.report({ increment: 50, message: t('Searching for references to "{0}"...', targetName) });

        console.log(`[Cmd:findCurrentFileReferences] Calling findScenarioReferences for "${targetName}"...`);
        const locations = await findScenarioReferences(targetName); // Вызов из navigationUtils
        if (!locations?.length) { 
            vscode.window.showInformationMessage(t('References to "{0}" not found.', targetName)); 
            return; 
        }

        progress.report({ increment: 75, message: t('Found {0} references', locations.length.toString()) });

        // Формируем QuickPickItems
        const quickPickItems: (vscode.QuickPickItem & { location: vscode.Location })[] = await Promise.all(
            locations.map(async loc => {
               let description = ''; 
               try { 
                   const doc = await vscode.workspace.openTextDocument(loc.uri); 
                   description = doc.lineAt(loc.range.start.line).text.trim(); 
               } catch { 
                   description = 'N/A'; 
               }
               return { 
                   label: `$(file-code) ${path.basename(loc.uri.fsPath)}:${loc.range.start.line + 1}`, 
                   description, 
                   detail: loc.uri.fsPath, 
                   location: loc 
               };
           })
        );
        
        progress.report({ increment: 100, message: t('Select reference to open') });
        
        const pickedItem = await vscode.window.showQuickPick(quickPickItems, { 
            matchOnDescription: true, 
            matchOnDetail: true, 
            placeHolder: t('References to "{0}":', targetName) 
        });
        
        if (pickedItem) {
            try {
                const doc = await vscode.workspace.openTextDocument(pickedItem.location.uri);
                await vscode.window.showTextDocument(doc, { selection: pickedItem.location.range, preview: false });
            } catch (err) { 
                console.error(`[Cmd:findCurrentFileReferences] Error opening picked location:`, err); 
                vscode.window.showErrorMessage(t('Failed to open location.')); 
            }
        }
    });
}

/**
 * Обработчик команды вставки ссылки на вложенный сценарий.
 * Вставляет в конец блока "ВложенныеСценарии:" без пустых строк между элементами.
 * Если выделена строка вида "And ИмяСценария", пытается заполнить UID и Имя из найденного сценария.
 */
export async function insertNestedScenarioRefHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const document = textEditor.document;
    const text = document.getText();

    let uidValue = "$1"; // Плейсхолдер для UID по умолчанию
    let nameValue = "$2"; // Плейсхолдер для Имени по умолчанию
    let finalCursor = "$0"; // Позиция курсора после вставки по умолчанию

    const selection = textEditor.selection;
    if (selection && !selection.isEmpty) {
        const selectedText = document.getText(selection).trim();
        const scenarioCallMatch = selectedText.match(/^\s*(?:And|И|Допустим)\s+(.+)/i);

        if (scenarioCallMatch && scenarioCallMatch[1]) {
            const scenarioNameFromSelection = scenarioCallMatch[1].trim();
            console.log(`[Cmd:insertNestedScenarioRef] Selected text matches, trying to find scenario: "${scenarioNameFromSelection}"`);
            const targetFileUri = await findFileByName(scenarioNameFromSelection);

            if (targetFileUri) {
                console.log(`[Cmd:insertNestedScenarioRef] Found target file: ${targetFileUri.fsPath}`);
                try {
                    const fileContentBytes = await vscode.workspace.fs.readFile(targetFileUri);
                    const fileContent = Buffer.from(fileContentBytes).toString('utf-8');
                    const dataScenarioBlockRegex = /ДанныеСценария:\s*([\s\S]*?)(?=\n[А-Яа-яЁёA-Za-z]+:|\n*$)/;
                    const dataScenarioBlockMatch = fileContent.match(dataScenarioBlockRegex);

                    if (dataScenarioBlockMatch && dataScenarioBlockMatch[1]) {
                        const blockContent = dataScenarioBlockMatch[1];
                        const uidMatch = blockContent.match(/^\s*UID:\s*"([^"]+)"/m);
                        const nameFileMatch = blockContent.match(/^\s*Имя:\s*"([^"]+)"/m);

                        if (uidMatch && uidMatch[1] && nameFileMatch && nameFileMatch[1]) {
                            uidValue = uidMatch[1].replace(/\$/g, '\\$').replace(/\}/g, '\\}').replace(/"/g, '\\"');
                            nameValue = nameFileMatch[1].replace(/\$/g, '\\$').replace(/\}/g, '\\}').replace(/"/g, '\\"');
                            finalCursor = "";
                            console.log(`[Cmd:insertNestedScenarioRef] Extracted UID: "${uidValue}", Name: "${nameValue}"`);
                        } else {
                            console.log(`[Cmd:insertNestedScenarioRef] Could not extract UID or Name from target file for "${scenarioNameFromSelection}".`);
                        }
                    } else {
                         console.log(`[Cmd:insertNestedScenarioRef] 'ДанныеСценария:' block not found in target file for "${scenarioNameFromSelection}".`);
                    }
                } catch (error: any) {
                    console.error(`[Cmd:insertNestedScenarioRef] Error reading/parsing target file ${targetFileUri.fsPath}:`, error);
                }
            } else {
                console.log(`[Cmd:insertNestedScenarioRef] Target file not found for "${scenarioNameFromSelection}".`);
            }
        } else {
             console.log(`[Cmd:insertNestedScenarioRef] Selected text "${selectedText}" does not match scenario call pattern.`);
        }
    } else {
        console.log("[Cmd:insertNestedScenarioRef] No selection or selection is empty.");
    }
    
    // Ищем блок ВложенныеСценарии:
    const nestedSectionRegex = /ВложенныеСценарии:/;
    const nestedMatch = text.match(nestedSectionRegex);
    
    if (nestedMatch && nestedMatch.index !== undefined) {
        const sectionStartIndex = nestedMatch.index;
        
        // Находим следующую основную секцию после "ВложенныеСценарии:"
        const nextSectionRegex = /\n[А-Яа-я]+:/g;
        let nextSectionMatch;
        let insertIndex = text.length; // По умолчанию - конец файла
        
        nextSectionRegex.lastIndex = sectionStartIndex;
        while ((nextSectionMatch = nextSectionRegex.exec(text)) !== null) {
            const matchedLine = nextSectionMatch[0];
            // Проверяем, это не вложенная секция (без отступов)
            if (matchedLine.match(/^\n[А-Яа-я]+:/) && !matchedLine.match(/^\n\s+[А-Яа-я]+:/)) {
                insertIndex = nextSectionMatch.index;
                break;
            }
        }
        
        // Проверяем, есть ли уже элементы в секции
        const sectionText = text.substring(sectionStartIndex, insertIndex);
        const hasItems = sectionText.includes('- ВложенныеСценарии');
        
        // Определяем позицию для вставки
        let insertPosition;
        let snippet;
        
        if (hasItems) {
            // Ищем последний блок элемента в секции
            const lines = sectionText.split('\n');
            
            // Находим все строки, начинающиеся с "- ВложенныеСценарии"
            const itemStartLines = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].match(/\s+- ВложенныеСценарии/)) {
                    itemStartLines.push(i);
                }
            }
            
            if (itemStartLines.length > 0) {
                const lastItemStartLineIndex = itemStartLines[itemStartLines.length - 1];
                const indentMatch = lines[lastItemStartLineIndex].match(/^(\s+)/);
                const indent = indentMatch ? indentMatch[1] : '    ';
                
                let lastElementEndLineIndex = lastItemStartLineIndex;
                
                for (let i = lastItemStartLineIndex + 1; i < lines.length; i++) {
                    const line = lines[i];
                    
                    if (line.trim() === '') {
                        continue;
                    }
                    
                    const indentMatch = line.match(/^\s+/);
                    if (indentMatch && indentMatch[0].length > indent.length) {
                        lastElementEndLineIndex = i;
                    } 
                    else {
                        break;
                    }
                }
                
                // Вычисляем позицию конца последнего элемента
                let offset = sectionStartIndex;
                for (let i = 0; i <= lastElementEndLineIndex; i++) {
                    offset += lines[i].length + 1; // +1 за \n
                }
                
                insertPosition = document.positionAt(offset);
                
                // Используем новые uidValue, nameValue, finalCursor
                // Создаем сниппет с тем же отступом, что и предыдущий элемент, но без пустой строки
                snippet = new vscode.SnippetString(
                    `${indent}- ВложенныеСценарии:\n` +
                    `${indent}    UIDВложенныйСценарий: "${uidValue}"\n` +
                    `${indent}    ИмяСценария: "${nameValue}"\n${finalCursor}`
                );
                
                // Проверяем, нет ли пустой строки перед местом вставки
                const currentText = document.getText(new vscode.Range(document.positionAt(offset - 2), document.positionAt(offset)));
                if (currentText === '\n\n') {
                    // Если перед местом вставки пустая строка, меняем сниппет, убирая лишний перенос
                    snippet = new vscode.SnippetString(
                        `${indent}- ВложенныеСценарии:\n` +
                        `${indent}    UIDВложенныйСценарий: "${uidValue}"\n` +
                        `${indent}    ИмяСценария: "${nameValue}"\n${finalCursor}`
                    );
                }
            } else {
                // Если не удалось найти элементы, добавляем в начало секции
                insertPosition = document.positionAt(sectionStartIndex + nestedMatch[0].length);
                snippet = new vscode.SnippetString(
                    '\n    - ВложенныеСценарии:\n' +
                    '        UIDВложенныйСценарий: "' + uidValue + '"\n' +
                    '        ИмяСценария: "' + nameValue + '"\n' + finalCursor
                );
            }
        } else {
            // Если элементов нет, вставляем первый с отступом
            insertPosition = document.positionAt(sectionStartIndex + nestedMatch[0].length);
            snippet = new vscode.SnippetString(
                '\n    - ВложенныеСценарии:\n' +
                '        UIDВложенныйСценарий: "' + uidValue + '"\n' +
                '        ИмяСценария: "' + nameValue + '"' + finalCursor 
            );
        }
        
        // Вставляем сниппет в найденную позицию
        textEditor.insertSnippet(snippet, insertPosition);
    } else {
        // Если блок не найден, вставляем в текущую позицию как раньше
        const snippet = new vscode.SnippetString(
            '- ВложенныеСценарии:\n' +
            '\tUIDВложенныйСценарий: "${uidValue}"\n' +
            '\tИмяСценария: "${nameValue}"\n${finalCursor}'
        );
        textEditor.insertSnippet(snippet);
    }
}

/**
 * Обработчик команды вставки параметра сценария.
 * Вставляет в конец блока "ПараметрыСценария:" без пустых строк между элементами.
 */
export function insertScenarioParamHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const document = textEditor.document;
    const text = document.getText();
    
    // Ищем блок ПараметрыСценария:
    const paramsRegex = /ПараметрыСценария:/;
    const paramsMatch = text.match(paramsRegex);
    
    if (paramsMatch && paramsMatch.index !== undefined) {
        const sectionStartIndex = paramsMatch.index;
        
        // Находим следующую основную секцию после "ПараметрыСценария:"
        const nextSectionRegex = /\n[А-Яа-я]+:/g;
        let nextSectionMatch;
        let insertIndex = text.length; // По умолчанию - конец файла
        
        nextSectionRegex.lastIndex = sectionStartIndex;
        while ((nextSectionMatch = nextSectionRegex.exec(text)) !== null) {
            const matchedLine = nextSectionMatch[0];
            // Проверяем, это не вложенная секция (без отступов)
            if (matchedLine.match(/^\n[А-Яа-я]+:/) && !matchedLine.match(/^\n\s+[А-Яа-я]+:/)) {
                insertIndex = nextSectionMatch.index;
                break;
            }
        }
        
        // Проверяем, есть ли уже элементы в секции
        const sectionText = text.substring(sectionStartIndex, insertIndex);
        const hasItems = sectionText.includes('- ПараметрыСценария');
        
        // Определяем позицию для вставки
        let insertPosition;
        let snippet;
        
        if (hasItems) {
            // Ищем последний блок элемента в секции
            const lines = sectionText.split('\n');
            
            // Находим все строки, начинающиеся с "- ПараметрыСценария"
            const itemStartLines = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].match(/\s+- ПараметрыСценария/)) {
                    itemStartLines.push(i);
                }
            }
            
            if (itemStartLines.length > 0) {
                const lastItemStartLineIndex = itemStartLines[itemStartLines.length - 1];
                const indentMatch = lines[lastItemStartLineIndex].match(/^(\s+)/);
                const indent = indentMatch ? indentMatch[1] : '    ';
                
                // Определяем конец последнего элемента
                // Ищем последнюю строку, относящуюся к последнему элементу
                let lastElementEndLineIndex = lastItemStartLineIndex;
                
                for (let i = lastItemStartLineIndex + 1; i < lines.length; i++) {
                    const line = lines[i];
                    
                    if (line.trim() === '') {
                        continue;
                    }
                    
                    const indentMatch = line.match(/^\s+/);
                    if (indentMatch && indentMatch[0].length > indent.length) {
                        lastElementEndLineIndex = i;
                    } 
                    else {
                        break;
                    }
                }
                
                // Вычисляем позицию конца последнего элемента
                let offset = sectionStartIndex;
                for (let i = 0; i <= lastElementEndLineIndex; i++) {
                    offset += lines[i].length + 1; // +1 за \n
                }
                
                insertPosition = document.positionAt(offset);
                
                // Проверяем, нет ли пустой строки перед местом вставки
                const currentText = document.getText(new vscode.Range(document.positionAt(offset - 2), document.positionAt(offset)));
                if (currentText === '\n\n') {
                    // Если перед местом вставки пустая строка, меняем сниппет, убирая лишний перенос
                    snippet = new vscode.SnippetString(
                        `${indent}- ПараметрыСценария:\n` +
                        `${indent}    НомерСтроки: "$1"\n` +
                        `${indent}    Имя: "$2"\n` +
                        `${indent}    Значение: "$3"\n` +
                        `${indent}    ТипПараметра: "\${4|Строка,Число,Булево,Массив,Дата|}"\n` +
                        `${indent}    ИсходящийПараметр: "\${5|No,Yes|}"\n$0`
                    );
                } else {
                    // Обычная вставка с переносом строки
                    snippet = new vscode.SnippetString(
                        `${indent}- ПараметрыСценария:\n` +
                        `${indent}    НомерСтроки: "$1"\n` +
                        `${indent}    Имя: "$2"\n` +
                        `${indent}    Значение: "$3"\n` +
                        `${indent}    ТипПараметра: "\${4|Строка,Число,Булево,Массив,Дата|}"\n` +
                        `${indent}    ИсходящийПараметр: "\${5|No,Yes|}"\n$0`
                    );
                }
            } else {
                // Если не удалось найти элементы, добавляем в начало секции
                insertPosition = document.positionAt(sectionStartIndex + paramsMatch[0].length);
                snippet = new vscode.SnippetString(
                    '\n    - ПараметрыСценария:\n' +
                    '        НомерСтроки: "$1"\n' +
                    '        Имя: "$2"\n' +
                    '        Значение: "$3"\n' +
                    '        ТипПараметра: "\${4|Строка,Число,Булево,Массив,Дата|}"\n' +
                    '        ИсходящийПараметр: "\${5|No,Yes}"$0'
                );
            }
        } else {
            // Если элементов нет, вставляем первый с отступом
            insertPosition = document.positionAt(sectionStartIndex + paramsMatch[0].length);
            snippet = new vscode.SnippetString(
                '\n    - ПараметрыСценария:\n' +
                '        НомерСтроки: "$1"\n' +
                '        Имя: "$2"\n' +
                '        Значение: "$3"\n' +
                '        ТипПараметра: "\${4|Строка,Число,Булево,Массив,Дата|}"\n' +
                '        ИсходящийПараметр: "\${5|No,Yes}"$0'
            );
        }
        
        // Вставляем сниппет в найденную позицию
        textEditor.insertSnippet(snippet, insertPosition);
    } else {
        // Если блок не найден, вставляем в текущую позицию как раньше
        const snippet = new vscode.SnippetString(
            '- ПараметрыСценария:\n' +
            '\tНомерСтроки: "$1"\n' +
            '\tИмя: "$2"\n' +
            '\tЗначение: "$3"\n' +
            '\tТипПараметра: "\${4\\|Строка,Число,Булево,Массив,Дата}"\n' +
            '\tИсходящийПараметр: "\${5\\|No,Yes}"\n$0'
        );
        textEditor.insertSnippet(snippet);
    }
}
/**
 * Обработчик команды вставки нового UID.
 */
export function insertUidHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    try {
        const newUid = uuidv4();
        textEditor.edit(editBuilder => {
            textEditor.selections.forEach(selection => {
                editBuilder.replace(selection, newUid);
            });
        }).then(success => { if (!success) { const p = getTranslator(getExtensionUri()); Promise.resolve(p).then(tt => vscode.window.showErrorMessage(tt('Failed to insert UID.'))); } });
    } catch (error: any) { const p = getTranslator(getExtensionUri()); Promise.resolve(p).then(tt => vscode.window.showErrorMessage(tt('Error generating UID: {0}', error.message || String(error)))); }
}

/**
 * Обработчик команды замены табов на пробелы в YAML файлах.
 */
export async function replaceTabsWithSpacesYamlHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const document = textEditor.document;
    const fullText = document.getText();
    // Используем глобальный флаг 'g' для замены всех вхождений
    const newText = fullText.replace(/\t/g, '    '); 

    // Если текст изменился, применяем правки
    if (newText !== fullText) {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(fullText.length)
        );
        // Применяем изменения ко всему документу
        await textEditor.edit(editBuilder => {
            editBuilder.replace(fullRange, newText);
        });
        const t2 = await getTranslator(getExtensionUri());
        vscode.window.showInformationMessage(t2('Tabs replaced with 4 spaces.'));
    } else {
        const t2 = await getTranslator(getExtensionUri());
        vscode.window.showInformationMessage(t2('No tabs found in the document.'));
    }
}

/**
 * Извлекает имена сценариев из секции "ВложенныеСценарии".
 * @param documentText Полный текст документа.
 * @returns Массив имен вложенных сценариев.
 */
function parseExistingNestedScenarios(documentText: string): string[] {
    const existingScenarios: string[] = [];
    const nestedSectionRegex = /ВложенныеСценарии:\s*([\s\S]*?)(?=\n[А-Яа-яЁёA-Za-z]+:|\n*$)/;
    const nestedMatch = documentText.match(nestedSectionRegex);

    if (nestedMatch && nestedMatch[1]) {
        const sectionContent = nestedMatch[1];
        const nameRegex = /^\s*ИмяСценария:\s*"([^"]+)"/gm; // gm для глобального поиска по нескольким строкам
        let match;
        while ((match = nameRegex.exec(sectionContent)) !== null) {
            existingScenarios.push(match[1]);
        }
    }
    console.log(`[parseExistingNestedScenarios] Found: ${existingScenarios.join(', ')}`);
    return existingScenarios;
}

/**
 * Извлекает имена сценариев, вызываемых в "ТекстСценария".
 * @param documentText Полный текст документа.
 * @returns Массив имен вызываемых сценариев.
 */
function parseCalledScenariosFromScriptBody(documentText: string): string[] {
    const calledScenarios = new Set<string>(); // Используем Set для автоматического удаления дубликатов
    const scriptBodyRegex = /ТекстСценария:\s*\|?\s*([\s\S]*?)(?=\n[А-Яа-яЁёA-Za-z]+:|\n*$)/;
    const scriptBodyMatch = documentText.match(scriptBodyRegex);

    if (scriptBodyMatch && scriptBodyMatch[1]) {
        const scriptContent = scriptBodyMatch[1];
        const lines = scriptContent.split('\n');
        const callRegex = /^(?!.*")\s*(?:And|И)\s+(.+)/i;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('#') || trimmedLine === '') continue; // Пропускаем комментарии и пустые строки

            const match = trimmedLine.match(callRegex);
            if (match && match[1]) {
                // Убираем возможные параметры в скобках или строки в кавычках в конце
                let scenarioName = match[1].trim();
                // Дополнительная очистка, если имя содержит параметры внутри себя без явных скобок (менее вероятно, но на всякий случай)
                // Это эвристика, может потребоваться более сложный парсер для сложных случаев
                const paramsMatch = scenarioName.match(/^(.*?)\s*<<.+>>\s*$/); // Удаление параметров типа <<...>>
                if (paramsMatch && paramsMatch[1]) {
                    scenarioName = paramsMatch[1].trim();
                }
                
                // Проверяем, что это не стандартный Gherkin шаг, который может случайно совпасть
                // Эвристика: если имя содержит кавычки или состоит из нескольких слов с пробелами,
                // и не является вызовом известного сложного шага, то это, скорее всего, имя сценария.
                // Простые шаги типа "Я нажимаю кнопку" не должны сюда попадать.
                // Имена сценариев обычно более описательны.
                if (scenarioName.includes(' ') || scenarioName.length > 20 || !/^(Я|I|Затем|Потом|Если|When|Then|Given)\s/i.test(scenarioName)) {
                     // Проверка, чтобы не добавлять строки, которые являются параметрами многострочного шага
                    if (!/^\s*\|/.test(line) && !/^\s*"""/.test(line)) {
                        calledScenarios.add(scenarioName);
                    }
                }
            }
        }
    }
    const result = Array.from(calledScenarios);
    console.log(`[parseCalledScenariosFromScriptBody] Found: ${result.join(', ')}`);
    return result;
}


/**
 * Обработчик команды проверки и заполнения вложенных сценариев.
 */
export async function checkAndFillNestedScenariosHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const t = await getTranslator(getExtensionUri());
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Filling nested scenarios...'),
        cancellable: false
    }, async (progress) => {
        console.log("[Cmd:checkAndFillNestedScenarios] Starting...");
        const document = textEditor.document;
        const fullText = document.getText();

        progress.report({ increment: 20, message: t('Scanning for called scenarios...') });

        const existingNestedScenarios = parseExistingNestedScenarios(fullText);
        const calledScenariosInBody = parseCalledScenariosFromScriptBody(fullText);

        const scenariosToAdd: { name: string; uid: string }[] = [];

        progress.report({ increment: 40, message: t('Processing scenario files...') });

        for (const calledName of calledScenariosInBody) {
            if (!existingNestedScenarios.includes(calledName)) {
                const targetFileUri = await findFileByName(calledName);
                if (targetFileUri) {
                    let uid = uuidv4();
                    let nameForBlock = calledName;
                    try {
                        const fileContentBytes = await vscode.workspace.fs.readFile(targetFileUri);
                        const fileContent = Buffer.from(fileContentBytes).toString('utf-8');
                        const dataScenarioBlockRegex = /ДанныеСценария:\s*([\s\S]*?)(?=\n[А-Яа-яЁёA-Za-z]+:|\n*$)/;
                        const dataScenarioBlockMatch = fileContent.match(dataScenarioBlockRegex);

                        if (dataScenarioBlockMatch && dataScenarioBlockMatch[1]) {
                            const blockContent = dataScenarioBlockMatch[1];
                            const uidMatch = blockContent.match(/^\s*UID:\s*"([^"]+)"/m);
                            const nameFileMatch = blockContent.match(/^\s*Имя:\s*"([^"]+)"/m);

                            if (uidMatch && uidMatch[1]) {
                                uid = uidMatch[1];
                            }
                            // console.log(`[Cmd:checkAndFillNestedScenarios] Found details for "${calledName}": UID=${uid}, NameInFile=${nameFileMatch ? nameFileMatch[1] : 'N/A'}`);
                        } else {
                            // console.log(`[Cmd:checkAndFillNestedScenarios] 'ДанныеСценария:' block not found in target file for "${calledName}". Using generated UID.`);
                        }
                    } catch (error) {
                        // console.error(`[Cmd:checkAndFillNestedScenarios] Error reading/parsing target file for "${calledName}":`, error, ". Using generated UID.");
                    }
                    scenariosToAdd.push({ name: nameForBlock, uid: uid });
                } else {
                    // console.log(`[Cmd:checkAndFillNestedScenarios] Scenario file not found for "${calledName}". It will not be added to 'ВложенныеСценарии'.`);
                }
            }
        }

        if (scenariosToAdd.length === 0) {
            vscode.window.showInformationMessage(t('All called scenarios are already present in the "NestedScenarios" section.'));
            console.log("[Cmd:checkAndFillNestedScenarios] No scenarios to add.");
            return;
        }

        progress.report({ increment: 60, message: t('Adding nested scenarios to file...') });

        const nestedSectionHeaderRegex = /ВложенныеСценарии:/;
        const nestedMatch = fullText.match(nestedSectionHeaderRegex);

        if (!nestedMatch || nestedMatch.index === undefined) {
            vscode.window.showInformationMessage(t('Section "NestedScenarios:" not found. New scenarios will not be added.'));
            console.log("[Cmd:checkAndFillNestedScenarios] 'ВложенныеСценарии:' section not found.");
            return;
        }

        const sectionHeaderGlobalStartOffset = nestedMatch.index;
        const sectionHeaderLineText = nestedMatch[0];
        const afterHeaderOffset = sectionHeaderGlobalStartOffset + sectionHeaderLineText.length;

        const nextMajorKeyRegex = /\n(?![ \t])([А-Яа-яЁёA-Za-z]+:)/g;
        nextMajorKeyRegex.lastIndex = afterHeaderOffset;
        const nextMajorKeyMatchResult = nextMajorKeyRegex.exec(fullText);
        const sectionContentEndOffset = nextMajorKeyMatchResult ? nextMajorKeyMatchResult.index : fullText.length;

        const rawSectionContent = fullText.substring(afterHeaderOffset, sectionContentEndOffset);

        let effectiveInsertPosition: vscode.Position;
        let baseIndentForNewItems = '    ';
        let newItemsBlockPrefix = "";

        let foundExistingItems = false;
        let lastItemBlockEndGlobalOffset = -1;
        let maxExistingItemNumber = 0;

        // Используем contentLinesForParsing для определения существующих элементов и их отступов
        // Начальный listItemsAreaStartRelativeOffset нужен, чтобы правильно считать смещения внутри rawSectionContent
        const listItemsAreaStartRelativeOffset = rawSectionContent.startsWith('\n') ? 1 : 0;
        const contentLinesForParsing = rawSectionContent.substring(listItemsAreaStartRelativeOffset).split('\n');
    
    // Regex to find the start of an item, allowing for optional numbering
    const itemStartRegex = /^(\s*)- ВложенныеСценарии(\d*):/;

    if (rawSectionContent.trim() !== "") {
        let currentItemBaseIndent = '';
        for (let i = 0; i < contentLinesForParsing.length; i++) {
            const lineText = contentLinesForParsing[i];
            // Проверяем, что строка не пустая перед матчингом, чтобы избежать ложных срабатываний на пустых строках в contentLinesForParsing
            if (lineText.trim() === "") continue;

            const itemStartMatch = lineText.match(itemStartRegex);
            if (itemStartMatch) {
                foundExistingItems = true;
                currentItemBaseIndent = itemStartMatch[1];
                baseIndentForNewItems = currentItemBaseIndent;

                if (itemStartMatch[2]) { // If digits are present (group 2 of regex)
                    const num = parseInt(itemStartMatch[2], 10);
                    if (num > maxExistingItemNumber) {
                        maxExistingItemNumber = num;
                    }
                }
                
                let currentItemLastLineIndex = i;

                for (let j = i + 1; j < contentLinesForParsing.length; j++) {
                    const subLineText = contentLinesForParsing[j];
                    if (subLineText.trim() === "" || subLineText.match(itemStartRegex)) {
                        break;
                    }
                    const subIndentMatch = subLineText.match(/^(\s*)/);
                    if (subIndentMatch && subIndentMatch[0].length > currentItemBaseIndent.length) {
                        currentItemLastLineIndex = j;
                    } else {
                        break;
                    }
                }

                let currentItemBlockEndRelativeOffset = listItemsAreaStartRelativeOffset;
                for (let k = 0; k <= currentItemLastLineIndex; k++) {
                    currentItemBlockEndRelativeOffset += contentLinesForParsing[k].length;
                    if (k < contentLinesForParsing.length - 1 || 
                        (k === contentLinesForParsing.length - 1 && rawSectionContent.substring(listItemsAreaStartRelativeOffset).endsWith('\n'))) {
                        currentItemBlockEndRelativeOffset++;
                    }
                }
                lastItemBlockEndGlobalOffset = afterHeaderOffset + currentItemBlockEndRelativeOffset;
                i = currentItemLastLineIndex;
            }
        }
    }

    if (foundExistingItems && lastItemBlockEndGlobalOffset !== -1) {
        effectiveInsertPosition = document.positionAt(lastItemBlockEndGlobalOffset);
        newItemsBlockPrefix = ""; // Вставляем сразу после последнего элемента, без доп. префикса
    } else {
        // Секция пуста или содержит только комментарии/пустые строки после заголовка
        effectiveInsertPosition = document.positionAt(afterHeaderOffset);
        baseIndentForNewItems = '    '; // Отступ по умолчанию для первого элемента
        newItemsBlockPrefix = "\n";    // Всегда начинаем с новой строки
    }

    let itemsToInsertString = "";
    scenariosToAdd.forEach((scenario, index) => {
        if (index > 0) { // Для второго и последующих элементов в добавляемом блоке
            itemsToInsertString += "\n"; // Перенос строки между элементами
        }
        itemsToInsertString += `${baseIndentForNewItems}- ВложенныеСценарии${maxExistingItemNumber + index + 1}:\n`;
        itemsToInsertString += `${baseIndentForNewItems}    UIDВложенныйСценарий: "${scenario.uid.replace(/"/g, '\\"')}"\n`;
        itemsToInsertString += `${baseIndentForNewItems}    ИмяСценария: "${scenario.name.replace(/"/g, '\\"')}"`;

        if (index === scenariosToAdd.length - 1) { // Если это последний элемент в добавляемом блоке
            if (nextMajorKeyMatchResult && sectionContentEndOffset < fullText.length) {
                // Если есть следующая основная секция, добавляем перенос строки после нашего последнего элемента
                itemsToInsertString += "\n";
            }
        }
    });

    const finalTextToInsert = newItemsBlockPrefix + itemsToInsertString;

    if (finalTextToInsert.trim() !== "" || (newItemsBlockPrefix === "\n" && itemsToInsertString.trim() === "")) {
        if (!foundExistingItems && rawSectionContent.trim() === "" && rawSectionContent.length > 0 && newItemsBlockPrefix === "\n") {
             const rangeToReplace = new vscode.Range(
                document.positionAt(afterHeaderOffset),
                document.positionAt(afterHeaderOffset + rawSectionContent.length)
            );
            await textEditor.edit(editBuilder => {
                editBuilder.replace(rangeToReplace, finalTextToInsert);
            });

        } else {
            await textEditor.edit(editBuilder => {
                editBuilder.insert(effectiveInsertPosition, finalTextToInsert);
            });
        }

        vscode.window.showInformationMessage(t('Added {0} nested scenarios.', String(scenariosToAdd.length)));
        console.log(`[Cmd:checkAndFillNestedScenarios] Added ${scenariosToAdd.length} scenarios. InsertPos Char: ${effectiveInsertPosition.character}, Line: ${effectiveInsertPosition.line}. Prefix: '${newItemsBlockPrefix.replace(/\n/g, "\\n")}'`);
    } else {
        console.log("[Cmd:checkAndFillNestedScenarios] Calculated text to insert was empty or whitespace.");
    }
});
}

/**
 * Извлекает имена параметров, используемых в теле сценария (внутри квадратных скобок).
 * @param documentText Полный текст документа.
 * @returns Массив уникальных имен используемых параметров.
 */
function parseUsedParametersFromScriptBody(documentText: string): string[] {
    const usedParameters = new Set<string>();
    const scriptBodyRegex = /ТекстСценария:\s*\|?\s*([\s\S]*?)(?=\n[А-Яа-яЁёA-Za-z]+:|\n*$)/;
    const scriptBodyMatch = documentText.match(scriptBodyRegex);

    if (scriptBodyMatch && scriptBodyMatch[1]) {
        const scriptContent = scriptBodyMatch[1];
        // Регулярное выражение для поиска параметров вида [ИмяПараметра]
        // Оно ищет текст внутри квадратных скобок, исключая сами скобки.
        // [^\[\]]+ означает "один или более символов, которые не являются '[' или ']'"
        const paramRegex = /\[([^\[\]]+)\]/g;
        let match;
        while ((match = paramRegex.exec(scriptContent)) !== null) {
            // match[1] содержит текст внутри скобок
            usedParameters.add(match[1].trim());
        }
    }
    const result = Array.from(usedParameters);
    console.log(`[parseUsedParametersFromScriptBody] Found: ${result.join(', ')}`);
    return result;
}

/**
 * Извлекает имена параметров, определенных в секции "ПараметрыСценария".
 * @param documentText Полный текст документа.
 * @returns Массив имен определенных параметров.
 */
function parseDefinedScenarioParameters(documentText: string): string[] {
    const definedParameters: string[] = [];
    const paramsSectionRegex = /ПараметрыСценария:\s*([\s\S]*?)(?=\n[А-Яа-яЁёA-Za-z]+:|\n*$)/;
    const paramsMatch = documentText.match(paramsSectionRegex);

    if (paramsMatch && paramsMatch[1]) {
        const sectionContent = paramsMatch[1];
        // Ищем строки вида 'Имя: "ИмяПараметра"'
        const nameRegex = /^\s*Имя:\s*"([^"]+)"/gm;
        let match;
        while ((match = nameRegex.exec(sectionContent)) !== null) {
            definedParameters.push(match[1]);
        }
    }
    console.log(`[parseDefinedScenarioParameters] Found: ${definedParameters.join(', ')}`);
    return definedParameters;
}


/**
 * Обработчик команды проверки и заполнения параметров сценария.
 */
export async function checkAndFillScenarioParametersHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const t = await getTranslator(getExtensionUri());
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Filling scenario parameters...'),
        cancellable: false
    }, async (progress) => {
        console.log("[Cmd:checkAndFillScenarioParameters] Starting...");
        const document = textEditor.document;
        let fullText = document.getText(); 

        progress.report({ increment: 20, message: t('Scanning for used parameters...') });

        const usedParametersInBody = parseUsedParametersFromScriptBody(fullText);
        const definedParametersInSection = parseDefinedScenarioParameters(fullText);

        const parametersToAdd: string[] = [];
        for (const usedParam of usedParametersInBody) {
            if (!definedParametersInSection.includes(usedParam)) {
                parametersToAdd.push(usedParam);
            }
        }

        if (parametersToAdd.length === 0) {
            vscode.window.showInformationMessage(t('All used parameters are already defined in the "ScenarioParameters" section.'));
            console.log("[Cmd:checkAndFillScenarioParameters] No parameters to add.");
            return;
        }

        progress.report({ increment: 60, message: t('Adding parameters to file...') });

        const PARAM_SECTION_KEY = "ПараметрыСценария"; 
        const PARAM_SECTION_HEADER = `${PARAM_SECTION_KEY}:`;
        const PARAM_ITEM_EXISTING_REGEX_STR = `^(\\s*)-\\s*${PARAM_SECTION_KEY}(\\d*)?:`;


        let effectiveInsertPosition: vscode.Position;
        let baseIndentForNewItems = "    ";
        let newItemsBlockPrefix = "";
        let foundExistingItems = false;
        let rangeToReplaceForEmptySection: vscode.Range | null = null;
        let nextMajorKeyMatchResultAfterSection: RegExpExecArray | null = null;
        let maxExistingParamItemNumber = 0;


        const sectionHeaderRegex = new RegExp(`^${PARAM_SECTION_HEADER}`, "m");
        const sectionMatch = fullText.match(sectionHeaderRegex);

        if (sectionMatch && sectionMatch.index !== undefined) {
            // SECTION EXISTS
            const sectionHeaderGlobalStartOffset = sectionMatch.index;
            const sectionHeaderLineText = sectionMatch[0];
            const afterHeaderOffset = sectionHeaderGlobalStartOffset + sectionHeaderLineText.length;

            const nextMajorKeyRegex = /\n(?![ \t])([А-Яа-яЁёA-Za-z]+:)/g;
            nextMajorKeyRegex.lastIndex = afterHeaderOffset;
            nextMajorKeyMatchResultAfterSection = nextMajorKeyRegex.exec(fullText);
            const sectionContentEndOffset = nextMajorKeyMatchResultAfterSection ? nextMajorKeyMatchResultAfterSection.index : fullText.length;
            const rawSectionContent = fullText.substring(afterHeaderOffset, sectionContentEndOffset);

            let lastItemBlockEndGlobalOffset = -1;
            const listItemsAreaStartRelativeOffset = rawSectionContent.startsWith('\n') ? 1 : 0;
            const contentLinesForParsing = rawSectionContent.substring(listItemsAreaStartRelativeOffset).split('\n');

            if (rawSectionContent.trim() !== "") {
                let currentItemBaseIndent = '';
                const itemStartRegex = new RegExp(PARAM_ITEM_EXISTING_REGEX_STR.replace("(\\d*)?", "(\\d*)")); // Ensure capturing group for digits

                for (let i = 0; i < contentLinesForParsing.length; i++) {
                    const lineText = contentLinesForParsing[i];
                    if (lineText.trim() === "") continue;

                    const itemStartMatch = lineText.match(itemStartRegex);
                    if (itemStartMatch) {
                        foundExistingItems = true;
                        currentItemBaseIndent = itemStartMatch[1];
                        baseIndentForNewItems = currentItemBaseIndent;

                        if (itemStartMatch[2]) {
                            const num = parseInt(itemStartMatch[2], 10);
                            if (num > maxExistingParamItemNumber) {
                                maxExistingParamItemNumber = num;
                            }
                        }

                        let currentItemLastLineIndex = i;
                        for (let j = i + 1; j < contentLinesForParsing.length; j++) {
                            const subLineText = contentLinesForParsing[j];
                            if (subLineText.trim() === "" || subLineText.match(itemStartRegex)) {
                                break;
                            }
                            const subIndentMatch = subLineText.match(/^(\s*)/);
                            if (subIndentMatch && subIndentMatch[0].length > currentItemBaseIndent.length) {
                                currentItemLastLineIndex = j;
                            } else {
                                break;
                            }
                        }

                        let currentItemBlockEndRelativeOffset = listItemsAreaStartRelativeOffset;
                        for (let k = 0; k <= currentItemLastLineIndex; k++) {
                            currentItemBlockEndRelativeOffset += contentLinesForParsing[k].length;
                            if (k < contentLinesForParsing.length - 1 || (k === contentLinesForParsing.length - 1 && rawSectionContent.substring(listItemsAreaStartRelativeOffset).endsWith('\n'))) {
                                currentItemBlockEndRelativeOffset++;
                            }
                        }
                        lastItemBlockEndGlobalOffset = afterHeaderOffset + currentItemBlockEndRelativeOffset;
                        i = currentItemLastLineIndex;
                    }
                }
            }

            if (foundExistingItems && lastItemBlockEndGlobalOffset !== -1) {
                effectiveInsertPosition = document.positionAt(lastItemBlockEndGlobalOffset);
                newItemsBlockPrefix = "";
            } else {
                effectiveInsertPosition = document.positionAt(afterHeaderOffset);
                baseIndentForNewItems = '    ';
                newItemsBlockPrefix = "\n";
                if (rawSectionContent.trim() === "" && rawSectionContent.length > 0) {
                    rangeToReplaceForEmptySection = new vscode.Range(
                        document.positionAt(afterHeaderOffset),
                        document.positionAt(afterHeaderOffset + rawSectionContent.length)
                    );
                }
            }

            let itemsToInsertString = "";
            parametersToAdd.forEach((paramName, index) => {
                if (index > 0) {
                    itemsToInsertString += "\n";
                }
                itemsToInsertString += `${baseIndentForNewItems}- ${PARAM_SECTION_KEY}${maxExistingParamItemNumber + index + 1}:\n`;
                itemsToInsertString += `${baseIndentForNewItems}    НомерСтроки: "${maxExistingParamItemNumber + index + 1}"\n`; 
                itemsToInsertString += `${baseIndentForNewItems}    Имя: "${paramName.replace(/"/g, '\\"')}"\n`;
                itemsToInsertString += `${baseIndentForNewItems}    Значение: "${paramName.replace(/"/g, '\\"')}"\n`;
                itemsToInsertString += `${baseIndentForNewItems}    ТипПараметра: "Строка"\n`;
                itemsToInsertString += `${baseIndentForNewItems}    ИсходящийПараметр: "No"`;

                if (index === parametersToAdd.length - 1) {
                    if (nextMajorKeyMatchResultAfterSection && sectionContentEndOffset < fullText.length) {
                        itemsToInsertString += "\n";
                    }
                }
            });

            const finalTextToInsert = newItemsBlockPrefix + itemsToInsertString;

            if (finalTextToInsert.trim() !== "" || (newItemsBlockPrefix === "\n" && itemsToInsertString.trim() === "")) {
                 if (rangeToReplaceForEmptySection) {
                    await textEditor.edit(editBuilder => {
                        editBuilder.replace(rangeToReplaceForEmptySection!, finalTextToInsert);
                    });
                } else {
                    await textEditor.edit(editBuilder => {
                        editBuilder.insert(effectiveInsertPosition, finalTextToInsert);
                    });
                }
            }
        } else {
            // SECTION DOES NOT EXIST
            baseIndentForNewItems = "    ";
            maxExistingParamItemNumber = 0;

            let newSectionTargetInsertionOffset = fullText.length;
            const knownSectionsToInsertBefore = ["ВложенныеСценарии:", "ТекстСценария:"];
            for (const nextSec of knownSectionsToInsertBefore) {
                const regex = new RegExp(`^${nextSec}`, "m");
                const match = fullText.match(regex);
                if (match && match.index !== undefined) {
                    if (match.index < newSectionTargetInsertionOffset) {
                        newSectionTargetInsertionOffset = match.index;
                    }
                }
            }
            
            const posForHeader = document.positionAt(newSectionTargetInsertionOffset);
            let headerStringToInsert = "";

            if (newSectionTargetInsertionOffset === 0) {
                headerStringToInsert = `${PARAM_SECTION_HEADER}\n`;
            } else if (newSectionTargetInsertionOffset === fullText.length) {
                if (fullText.endsWith("\n\n")) headerStringToInsert = `${PARAM_SECTION_HEADER}\n`;
                else if (fullText.endsWith("\n")) headerStringToInsert = `\n${PARAM_SECTION_HEADER}\n`;
                else headerStringToInsert = `\n\n${PARAM_SECTION_HEADER}\n`;
            } else {
                const lineNumberOfHeaderTarget = posForHeader.line;
                if (lineNumberOfHeaderTarget === 0) {
                     headerStringToInsert = `${PARAM_SECTION_HEADER}\n`;
                } else {
                    const lineBeforeHeaderTarget = document.lineAt(lineNumberOfHeaderTarget - 1);
                    if (lineBeforeHeaderTarget.isEmptyOrWhitespace) {
                        headerStringToInsert = `\n${PARAM_SECTION_HEADER}\n`;
                    } else {
                        headerStringToInsert = `\n\n${PARAM_SECTION_HEADER}\n`;
                    }
                }
            }

            let itemsToInsertString = "";
            parametersToAdd.forEach((paramName, index) => {
                if (index > 0) itemsToInsertString += "\n";
                itemsToInsertString += `${baseIndentForNewItems}- ${PARAM_SECTION_KEY}${maxExistingParamItemNumber + index + 1}:\n`;
                itemsToInsertString += `${baseIndentForNewItems}    НомерСтроки: "${maxExistingParamItemNumber + index + 1}"\n`; 
                itemsToInsertString += `${baseIndentForNewItems}    Имя: "${paramName.replace(/"/g, '\\"')}"\n`;
                itemsToInsertString += `${baseIndentForNewItems}    Значение: "${paramName.replace(/"/g, '\\"')}"\n`;
                itemsToInsertString += `${baseIndentForNewItems}    ТипПараметра: "Строка"\n`;
                itemsToInsertString += `${baseIndentForNewItems}    ИсходящийПараметр: "No"`;
            });
            
            if (newSectionTargetInsertionOffset < fullText.length && itemsToInsertString.length > 0) {
                if (!itemsToInsertString.endsWith("\n")) {
                     itemsToInsertString += "\n";
                }
            }

            const fullSectionToInsert = headerStringToInsert + itemsToInsertString;

            if (fullSectionToInsert.trim() !== "") {
                await textEditor.edit(editBuilder => {
                    editBuilder.insert(posForHeader, fullSectionToInsert);
                });
            }
        }

        vscode.window.showInformationMessage(t('Added {0} scenario parameters.', String(parametersToAdd.length)));
        console.log(`[Cmd:checkAndFillScenarioParameters] Added ${parametersToAdd.length} parameters.`);
    });
}


/**
 * Обработчик команды создания архива FirstLaunch.zip.
 * @param context Контекст расширения.
 */
export async function handleCreateFirstLaunchZip(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(getExtensionUri());
    console.log("[Cmd:createFirstLaunchZip] Starting...");

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage(t('Workspace is not open.'));
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri;

    try {
        // --- 1. Чтение версии из Configuration.xml ---
        const configXmlUri = vscode.Uri.joinPath(workspaceRoot, 'cf', 'Configuration.xml');
        let version = '';
        try {
            const xmlContentBytes = await vscode.workspace.fs.readFile(configXmlUri);
            const xmlContent = Buffer.from(xmlContentBytes).toString('utf-8');
            const versionMatch = xmlContent.match(/<Version>([^<]+)<\/Version>/);
            if (!versionMatch || !versionMatch[1]) {
                vscode.window.showErrorMessage(t('Could not find <Version> tag in cf/Configuration.xml.'));
                return;
            }
            version = versionMatch[1];
            console.log(`[Cmd:createFirstLaunchZip] Found version: ${version}`);
        } catch (error) {
            vscode.window.showErrorMessage(t('Could not read cf/Configuration.xml file.'));
            return;
        }

        // --- 2. Рекурсивный обход папки и замена версии ---
        const zip = new JSZip();
        const firstLaunchFolderUri = vscode.Uri.joinPath(workspaceRoot, 'first_launch');

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('Building FirstLaunch.zip'),
            cancellable: false
        }, async (progress) => {
            progress.report({ message: t('Reading files...') });
            
            async function processDirectory(dirUri: vscode.Uri, zipFolder: JSZip) {
                const entries = await vscode.workspace.fs.readDirectory(dirUri);
                for (const [name, type] of entries) {
                    const fullUri = vscode.Uri.joinPath(dirUri, name);
                    if (type === vscode.FileType.Directory) {
                        const subFolder = zipFolder.folder(name);
                        if(subFolder) {
                            await processDirectory(fullUri, subFolder);
                        }
                    } else if (type === vscode.FileType.File) {
                        const fileBytes = await vscode.workspace.fs.readFile(fullUri);
                        let fileContent = Buffer.from(fileBytes).toString('utf-8');
                        
                        const newFileContent = fileContent.replace(/version="[^"]*">/g, `version="${version}">`);
                        
                        zipFolder.file(name, newFileContent);
                    }
                }
            }

            await processDirectory(firstLaunchFolderUri, zip);

            // --- 3. Сохранение ZIP архива ---
            progress.report({ message: t('Creating archive...') });

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(workspaceRoot, 'FirstLaunch.zip'),
                filters: {
                    'Zip archives': ['zip']
                },
                title: t('Save FirstLaunch.zip')
            });

            if (saveUri) {
                const zipContent = await zip.generateAsync({ type: "nodebuffer" });
                await vscode.workspace.fs.writeFile(saveUri, zipContent);
                console.log(`[Cmd:createFirstLaunchZip] Archive saved to ${saveUri.fsPath}`);

                // Показываем уведомление с кнопкой
                vscode.window.showInformationMessage(
                    t('FirstLaunch.zip archive successfully saved'),
                    t('Open directory')
                ).then(selection => {
                    if (selection === t('Open directory')) {
                        // Открыть системный проводник и выделить файл
                        vscode.commands.executeCommand('revealFileInOS', saveUri);
                    }
                });
            } else {
                console.log("[Cmd:createFirstLaunchZip] Save dialog cancelled.");
                vscode.window.showInformationMessage(t('Archive saving cancelled.'));
            }
        });

    } catch (error: any) {
        console.error("[Cmd:createFirstLaunchZip] Error:", error);
        vscode.window.showErrorMessage(t('Error creating FirstLaunch.zip: {0}', error.message || error));
    }
}