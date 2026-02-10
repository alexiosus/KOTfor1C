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
import { normalizeScenarioParameterName } from './scenarioParameterUtils';
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
            const scenarioUri = await findFileByName(name, testCache);
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
    const config = vscode.workspace.getConfiguration('kotTestToolkit.paths');
    const fileWorkshopPath = config.get<string>('fileWorkshopExe');
    const t = await getTranslator(getExtensionUri());

    if (!fileWorkshopPath) {
        vscode.window.showErrorMessage(
            t("Path to '1C:Enterprise — File workshop' is not configured. Set it in `kotTestToolkit.paths.fileWorkshopExe`."),
            t('Open Settings')
        ).then(selection => {
            if (selection === t('Open Settings')) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.fileWorkshopExe');
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
                vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.fileWorkshopExe');
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
export async function openSubscenarioHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, phaseSwitcherProvider: PhaseSwitcherProvider) {
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
        
        // Use cached data for fast scenario lookup
        const testCache = phaseSwitcherProvider.getTestCache();
        const targetUri = await findFileByName(scenarioNameFromLine, testCache);
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
export async function insertNestedScenarioRefHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, phaseSwitcherProvider: PhaseSwitcherProvider) {
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
            const testCache = phaseSwitcherProvider.getTestCache();
            const targetFileUri = await findFileByName(scenarioNameFromSelection, testCache);

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
export async function insertScenarioParamHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const document = textEditor.document;
    
    // Проверяем, что это файл сценария YAML
    const { isScenarioYamlFile } = await import('./yamlValidator.js');
    if (!isScenarioYamlFile(document)) {
        const t = await getTranslator(getExtensionUri());
        vscode.window.showWarningMessage(t('This command is only available for scenario YAML files.'));
        return;
    }
    
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
export async function insertUidHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const document = textEditor.document;
    
    // Проверяем, что это файл сценария YAML
    const { isScenarioYamlFile } = await import('./yamlValidator.js');
    if (!isScenarioYamlFile(document)) {
        const t = await getTranslator(getExtensionUri());
        vscode.window.showWarningMessage(t('This command is only available for scenario YAML files.'));
        return;
    }
    
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
    
    // Проверяем, что это файл сценария YAML
    const { isScenarioYamlFile } = await import('./yamlValidator.js');
    if (!isScenarioYamlFile(document)) {
        const t = await getTranslator(getExtensionUri());
        vscode.window.showWarningMessage(t('This command is only available for scenario YAML files.'));
        return;
    }
    
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
export function parseCalledScenariosFromScriptBody(documentText: string): string[] {
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

export function shouldRefillNestedScenariosSection(documentText: string): boolean {
    const expected = parseCalledScenariosFromScriptBody(documentText);
    const existing = parseExistingNestedScenarios(documentText);
    if (expected.length !== existing.length) {
        return true;
    }

    for (let index = 0; index < expected.length; index++) {
        if (expected[index] !== existing[index]) {
            return true;
        }
    }

    return false;
}


/**
 * Обработчик команды проверки и заполнения вложенных сценариев.
 */
export async function checkAndFillNestedScenariosHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, phaseSwitcherProvider: PhaseSwitcherProvider) {
    const document = textEditor.document;
    
    // Проверяем, что это файл сценария YAML
    const { isScenarioYamlFile } = await import('./yamlValidator.js');
    if (!isScenarioYamlFile(document)) {
        const t = await getTranslator(getExtensionUri());
        vscode.window.showWarningMessage(t('This command is only available for scenario YAML files.'));
        return;
    }
    
    // Use the new clear-and-refill logic with cached data for performance
    await phaseSwitcherProvider.ensureFreshTestCache();
    const testCache = phaseSwitcherProvider.getTestCache();
    await clearAndFillNestedScenarios(textEditor.document, false, testCache);
}

/**
 * Извлекает имена параметров, используемых в теле сценария (внутри квадратных скобок).
 * Параметры могут содержать только буквы, цифры, подчеркивания (_) и дефисы (-).
 * @param documentText Полный текст документа.
 * @returns Массив уникальных имен используемых параметров.
 */
export function parseUsedParametersFromScriptBody(documentText: string): string[] {
    const usedParameters = new Set<string>();
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const exclusions = config.get<string[]>('editor.scenarioParameterExclusions', []) || [];
    const exclusionSet = new Set(
        exclusions
            .map(item => item.trim().replace(/^\[/, '').replace(/\]$/, ''))
            .filter(item => item.length > 0)
    );
    const scriptBodyRegex = /ТекстСценария:\s*\|?\s*([\s\S]*?)(?=\n[А-Яа-яЁёA-Za-z]+:|\n*$)/;
    const scriptBodyMatch = documentText.match(scriptBodyRegex);

    if (scriptBodyMatch && scriptBodyMatch[1]) {
        const scriptContent = scriptBodyMatch[1];
        // Регулярное выражение для поиска параметров вида [ИмяПараметра]
        // Параметры могут содержать только: буквы (A-Z, a-z, А-Я, а-я), цифры (0-9), подчеркивания (_) и дефисы (-)
        // Исключаются строки с точками, запятыми и другими специальными символами
        const paramRegex = /\[([A-Za-zА-Яа-яЁё0-9_-]+)\]/g;
        let match;
        while ((match = paramRegex.exec(scriptContent)) !== null) {
            const paramName = match[1].trim();
            // Дополнительная проверка: параметр не должен быть пустым
            if (paramName.length > 0 && !exclusionSet.has(paramName)) {
                usedParameters.add(paramName);
            }
        }
    }
    const result = Array.from(usedParameters);
    console.log(`[parseUsedParametersFromScriptBody] Found: ${result.join(', ')}`);
    return result;
}

export function shouldRefillScenarioParametersSection(documentText: string): boolean {
    const expected = parseUsedParametersFromScriptBody(documentText);
    const existing = parseDefinedScenarioParameters(documentText);
    if (expected.length !== existing.length) {
        return true;
    }

    for (let index = 0; index < expected.length; index++) {
        if (expected[index] !== existing[index]) {
            return true;
        }
    }

    return false;
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
    const document = textEditor.document;
    
    // Проверяем, что это файл сценария YAML
    const { isScenarioYamlFile } = await import('./yamlValidator.js');
    if (!isScenarioYamlFile(document)) {
        const t = await getTranslator(getExtensionUri());
        vscode.window.showWarningMessage(t('This command is only available for scenario YAML files.'));
        return;
    }
    
    // Use the new clear-and-refill logic
    await clearAndFillScenarioParameters(textEditor.document, false);
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
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const firstLaunchFolderPath = (config.get<string>('paths.firstLaunchFolder') || '').trim();
        if (!firstLaunchFolderPath) {
            vscode.window.showErrorMessage(
                t('FirstLaunch folder path is not specified in settings.'),
                t('Open Settings')
            ).then(selection => {
                if (selection === t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.firstLaunchFolder');
                }
            });
            return;
        }

        const firstLaunchFolderUri = path.isAbsolute(firstLaunchFolderPath)
            ? vscode.Uri.file(firstLaunchFolderPath)
            : vscode.Uri.joinPath(workspaceRoot, firstLaunchFolderPath);

        try {
            await vscode.workspace.fs.stat(firstLaunchFolderUri);
        } catch {
            vscode.window.showErrorMessage(
                t('FirstLaunch folder not found at path: {0}', firstLaunchFolderUri.fsPath),
                t('Open Settings')
            ).then(selection => {
                if (selection === t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.firstLaunchFolder');
                }
            });
            return;
        }

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
                        if (name.toLowerCase().endsWith('.xml')) {
                            let fileContent = Buffer.from(fileBytes).toString('utf-8');
                            const newFileContent = fileContent.replace(/version="[^"]*">/g, `version="${version}">`);
                            zipFolder.file(name, newFileContent);
                        } else {
                            zipFolder.file(name, fileBytes);
                        }
                    }
                }
            }

            await processDirectory(firstLaunchFolderUri, zip);

            // --- 3. Сохранение ZIP архива ---
            progress.report({ message: t('Creating archive...') });

            // Получаем параметры YAML для определения пути по умолчанию
            let defaultSaveFolder = workspaceRoot;
            try {
                const { YamlParametersManager } = await import('./yamlParametersManager.js');
                const yamlParametersManager = YamlParametersManager.getInstance(context);
                const parameters = await yamlParametersManager.loadParameters();
                
                const featureFolderParam = parameters.find(p => p.key === "FeatureFolder");
                const modelDBidParam = parameters.find(p => p.key === "ModelDBid");
                
                if (featureFolderParam && featureFolderParam.value) {
                    const featureFolderPath = featureFolderParam.value;
                    const modelDBid = modelDBidParam ? modelDBidParam.value : "";
                    
                    // Формируем путь с учетом ModelDBid
                    let targetPath = featureFolderPath;
                    if (modelDBid && modelDBid.trim() !== "") {
                        targetPath = path.join(featureFolderPath, modelDBid);
                    }
                    
                    // Проверяем, существует ли директория
                    try {
                        const targetUri = vscode.Uri.file(targetPath);
                        await vscode.workspace.fs.stat(targetUri);
                        defaultSaveFolder = targetUri;
                        console.log(`[Cmd:createFirstLaunchZip] Using FeatureFolder path: ${targetPath}`);
                    } catch (error) {
                        console.log(`[Cmd:createFirstLaunchZip] FeatureFolder path does not exist: ${targetPath}, using workspace root`);
                        defaultSaveFolder = workspaceRoot;
                    }
                } else {
                    console.log(`[Cmd:createFirstLaunchZip] FeatureFolder not found in parameters, using workspace root`);
                }
            } catch (error) {
                console.log(`[Cmd:createFirstLaunchZip] Error loading YAML parameters: ${error}, using workspace root`);
                defaultSaveFolder = workspaceRoot;
            }

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(defaultSaveFolder, 'first_launch.zip'),
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

/**
 * Clears and refills the NestedScenarios section with scenarios in order of their appearance in the script body.
 * @param document The text document to modify
 * @param silent If true, don't show progress notifications
 * @param testCache Optional test cache to use instead of file system searches
 * @returns Promise<boolean> true if changes were made
 */
export async function clearAndFillNestedScenarios(document: vscode.TextDocument, silent: boolean = false, testCache?: Map<string, TestInfo> | null): Promise<boolean> {
    const t = await getTranslator(getExtensionUri());
    
    const progressHandler = async (progress: any) => {
        console.log("[clearAndFillNestedScenarios] Starting...");
        const fullText = document.getText();

        if (!silent) progress.report({ increment: 20, message: t('Scanning for called scenarios...') });

        // Parse scenarios in order of appearance in script body
        const calledScenariosInOrder = parseCalledScenariosFromScriptBody(fullText);
        
        console.log(`[clearAndFillNestedScenarios] Found ${calledScenariosInOrder.length} scenarios in script body.`);

        if (!silent) progress.report({ increment: 40, message: t('Processing scenario files...') });

        const scenariosToAdd: { name: string; uid: string }[] = [];

        if (testCache) {
            // Use cached data for fast lookup
            console.log("[clearAndFillNestedScenarios] Using cached test data for scenario lookup");
            for (const calledName of calledScenariosInOrder) {
                const cachedTestInfo = testCache.get(calledName);
                if (cachedTestInfo) {
                    const uid = cachedTestInfo.uid || uuidv4();
                    scenariosToAdd.push({ name: calledName, uid: uid });
                    console.log(`[clearAndFillNestedScenarios] Found cached scenario "${calledName}" with UID: ${uid}`);
                } else {
                    console.log(`[clearAndFillNestedScenarios] Scenario "${calledName}" not found in cache, skipping`);
                }
            }
        } else {
            // Fallback to file system search (legacy behavior)
            console.log("[clearAndFillNestedScenarios] No cache available, falling back to file system search");
            for (const calledName of calledScenariosInOrder) {
                const targetFileUri = await findFileByName(calledName, null);
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
                        }
                    } catch (error) {
                        // Use generated UID if file reading fails
                    }
                    scenariosToAdd.push({ name: nameForBlock, uid: uid });
                }
            }
        }

        console.log(`[clearAndFillNestedScenarios] Found ${scenariosToAdd.length} valid scenarios to add.`);

        if (!silent) progress.report({ increment: 60, message: t('Clearing and refilling section...') });

        // Find the NestedScenarios section
        const nestedSectionHeaderRegex = /ВложенныеСценарии:/;
        const nestedMatch = fullText.match(nestedSectionHeaderRegex);

        if (!nestedMatch || nestedMatch.index === undefined) {
            console.log("[clearAndFillNestedScenarios] 'ВложенныеСценарии:' section not found. No changes made.");
            return false;
        }

        const sectionHeaderGlobalStartOffset = nestedMatch.index;
        const sectionHeaderLineText = nestedMatch[0];
        const afterHeaderOffset = sectionHeaderGlobalStartOffset + sectionHeaderLineText.length;

        // Find the end of the section
        const nextMajorKeyRegex = /\n(?![ \t])([А-Яа-яЁёA-Za-z]+:)/g;
        nextMajorKeyRegex.lastIndex = afterHeaderOffset;
        const nextMajorKeyMatchResult = nextMajorKeyRegex.exec(fullText);
        const sectionContentEndOffset = nextMajorKeyMatchResult ? nextMajorKeyMatchResult.index : fullText.length;

        // Clear the entire section content and rebuild it
        const baseIndentForNewItems = '    ';
        let itemsToInsertString = "";
        
        scenariosToAdd.forEach((scenario, index) => {
            if (index > 0) {
                itemsToInsertString += "\n";
            }
            itemsToInsertString += `${baseIndentForNewItems}- ВложенныеСценарии${index + 1}:\n`;
            itemsToInsertString += `${baseIndentForNewItems}    UIDВложенныйСценарий: "${scenario.uid.replace(/"/g, '\\"')}"\n`;
            itemsToInsertString += `${baseIndentForNewItems}    ИмяСценария: "${scenario.name.replace(/"/g, '\\"')}"`;
        });

        // Add final newline if there's a next section
        let finalTextToInsert: string;
        if (scenariosToAdd.length === 0) {
            finalTextToInsert = nextMajorKeyMatchResult && sectionContentEndOffset < fullText.length ? "\n" : "";
        } else {
            if (nextMajorKeyMatchResult && sectionContentEndOffset < fullText.length) {
                itemsToInsertString += "\n";
            }
            finalTextToInsert = "\n" + itemsToInsertString;
        }

        const currentSectionContent = fullText.substring(afterHeaderOffset, sectionContentEndOffset);
        if (currentSectionContent === finalTextToInsert) {
            console.log("[clearAndFillNestedScenarios] Section already up-to-date. No changes made.");
            return false;
        }

        // Apply the edit
        const edit = new vscode.WorkspaceEdit();
        const rangeToReplace = new vscode.Range(
            document.positionAt(afterHeaderOffset),
            document.positionAt(sectionContentEndOffset)
        );
        edit.replace(document.uri, rangeToReplace, finalTextToInsert);
        await vscode.workspace.applyEdit(edit);

        console.log(`[clearAndFillNestedScenarios] Cleared and refilled with ${scenariosToAdd.length} scenarios.`);
        return true;
    };

    if (silent) {
        return await progressHandler(null);
    } else {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('Filling nested scenarios...'),
            cancellable: false
        }, progressHandler);
    }
}

/**
 * Represents a parameter block from ScenarioParameters section.
 */
interface ExistingScenarioParameterData {
    value: string;
    type: string;
    outgoing: string;
}

const scenarioParameterSessionCache = new Map<string, Map<string, ExistingScenarioParameterData>>();

function cloneScenarioParameterDataMap(
    source: Map<string, ExistingScenarioParameterData>
): Map<string, ExistingScenarioParameterData> {
    const cloned = new Map<string, ExistingScenarioParameterData>();
    source.forEach((value, key) => {
        cloned.set(key, { ...value });
    });
    return cloned;
}

function mergeScenarioParameterDataMaps(
    base: Map<string, ExistingScenarioParameterData>,
    override: Map<string, ExistingScenarioParameterData>
): Map<string, ExistingScenarioParameterData> {
    const result = cloneScenarioParameterDataMap(base);
    override.forEach((value, key) => {
        result.set(key, { ...value });
    });
    return result;
}

function updateScenarioParameterSessionCache(
    document: vscode.TextDocument,
    data: Map<string, ExistingScenarioParameterData>
): Map<string, ExistingScenarioParameterData> {
    const key = document.uri.toString();
    const cached = scenarioParameterSessionCache.get(key) ?? new Map<string, ExistingScenarioParameterData>();
    const merged = mergeScenarioParameterDataMaps(cached, data);
    scenarioParameterSessionCache.set(key, merged);
    return merged;
}

export function clearScenarioParameterSessionCache(documentOrUri: vscode.TextDocument | vscode.Uri): void {
    const key = documentOrUri instanceof vscode.Uri
        ? documentOrUri.toString()
        : documentOrUri.uri.toString();
    scenarioParameterSessionCache.delete(key);
}

/**
 * Parses existing parameter values and attributes from the ScenarioParameters section.
 * @param documentText The full document text
 * @returns Map of parameter names to their data
 */
function parseExistingParameterData(documentText: string): Map<string, ExistingScenarioParameterData> {
    const existingData = new Map<string, ExistingScenarioParameterData>();
    
    const PARAM_SECTION_KEY = "ПараметрыСценария";
    const PARAM_SECTION_HEADER = `${PARAM_SECTION_KEY}:`;
    
    // Find the ScenarioParameters section
    const sectionHeaderRegex = new RegExp(`^${PARAM_SECTION_HEADER}`, "m");
    const sectionMatch = documentText.match(sectionHeaderRegex);
    
    if (!sectionMatch || sectionMatch.index === undefined) {
        return existingData;
    }
    
    const afterHeaderOffset = sectionMatch.index + sectionMatch[0].length;
    
    // Find the end of the section
    const nextMajorKeyRegex = /\n(?![ \t])([А-Яа-яЁёA-Za-z]+:)/g;
    nextMajorKeyRegex.lastIndex = afterHeaderOffset;
    const nextMajorKeyMatchResult = nextMajorKeyRegex.exec(documentText);
    const sectionContentEndOffset = nextMajorKeyMatchResult ? nextMajorKeyMatchResult.index : documentText.length;
    
    const sectionContent = documentText.substring(afterHeaderOffset, sectionContentEndOffset);
    
    const parseFieldValue = (blockContent: string, fieldName: string): string | null => {
        const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fieldRegex = new RegExp(`^\\s*${escapedFieldName}:\\s*(.+?)\\s*$`, 'm');
        const fieldMatch = blockContent.match(fieldRegex);
        if (!fieldMatch?.[1]) {
            return null;
        }

        const raw = fieldMatch[1].trim();
        if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\'')))) {
            return raw.slice(1, -1);
        }
        return raw;
    };

    // Parse each parameter block
    const paramBlockRegex = new RegExp(`^\\s*-\\s*${PARAM_SECTION_KEY}\\d*:\\s*$`, "gm");
    let match;
    
    while ((match = paramBlockRegex.exec(sectionContent)) !== null) {
        const blockStartOffset = match.index + match[0].length;
        
        // Find the end of this parameter block (next parameter or end of section)
        paramBlockRegex.lastIndex = blockStartOffset;
        const nextParamMatch = paramBlockRegex.exec(sectionContent);
        const blockEndOffset = nextParamMatch ? nextParamMatch.index : sectionContent.length;
        
        const blockContent = sectionContent.substring(blockStartOffset, blockEndOffset);
        
        // Extract parameter fields
        const parsedName = parseFieldValue(blockContent, 'Имя');
        const parsedValue = parseFieldValue(blockContent, 'Значение');
        const parsedType = parseFieldValue(blockContent, 'ТипПараметра');
        const parsedOutgoing = parseFieldValue(blockContent, 'ИсходящийПараметр');

        const paramName = parsedName ? normalizeScenarioParameterName(parsedName) : '';

        if (paramName && parsedValue !== null && !existingData.has(paramName)) {
            existingData.set(paramName, {
                value: parsedValue,
                type: parsedType || "Строка",
                outgoing: parsedOutgoing || "No"
            });
            console.log(`[parseExistingParameterData] Found existing data for "${paramName}"`);
        }
        
        // Reset regex position to continue searching
        paramBlockRegex.lastIndex = blockStartOffset;
    }
    
    return existingData;
}

/**
 * Clears and refills the ScenarioParameters section with parameters in order of their appearance in the script body.
 * Preserves existing custom parameter values.
 * @param document The text document to modify
 * @param silent If true, don't show progress notifications
 * @returns Promise<boolean> true if changes were made
 */
export async function clearAndFillScenarioParameters(document: vscode.TextDocument, silent: boolean = false): Promise<boolean> {
    const t = await getTranslator(getExtensionUri());
    
    const progressHandler = async (progress: any) => {
        console.log("[clearAndFillScenarioParameters] Starting...");
        const fullText = document.getText();

        if (!silent) progress.report({ increment: 20, message: t('Scanning for used parameters...') });

        // Parse parameters in order of appearance in script body
        const usedParametersInOrder = parseUsedParametersFromScriptBody(fullText);

        console.log(`[clearAndFillScenarioParameters] Found ${usedParametersInOrder.length} parameters in script body.`);

        // Parse existing parameter values to preserve user customizations
        const existingData = parseExistingParameterData(fullText);
        const mergedData = updateScenarioParameterSessionCache(document, existingData);
        console.log(`[clearAndFillScenarioParameters] Found ${existingData.size} existing parameter blocks with attributes.`);
        console.log(`[clearAndFillScenarioParameters] Session cache has ${mergedData.size} parameter blocks.`);

        if (!silent) progress.report({ increment: 60, message: t('Clearing and refilling section...') });

        const PARAM_SECTION_KEY = "ПараметрыСценария";
        const PARAM_SECTION_HEADER = `${PARAM_SECTION_KEY}:`;

        // Find the ScenarioParameters section
        const sectionHeaderRegex = new RegExp(`^${PARAM_SECTION_HEADER}`, "m");
        const sectionMatch = fullText.match(sectionHeaderRegex);

        if (!sectionMatch || sectionMatch.index === undefined) {
            console.log("[clearAndFillScenarioParameters] 'ПараметрыСценария:' section not found. No changes made.");
            return false;
        }

        const sectionHeaderGlobalStartOffset = sectionMatch.index;
        const sectionHeaderLineText = sectionMatch[0];
        const afterHeaderOffset = sectionHeaderGlobalStartOffset + sectionHeaderLineText.length;

        // Find the end of the section
        const nextMajorKeyRegex = /\n(?![ \t])([А-Яа-яЁёA-Za-z]+:)/g;
        nextMajorKeyRegex.lastIndex = afterHeaderOffset;
        const nextMajorKeyMatchResult = nextMajorKeyRegex.exec(fullText);
        const sectionContentEndOffset = nextMajorKeyMatchResult ? nextMajorKeyMatchResult.index : fullText.length;

        // Clear the entire section content and rebuild it
        const baseIndentForNewItems = '    ';
        let itemsToInsertString = "";

        usedParametersInOrder.forEach((paramName, index) => {
            if (index > 0) {
                itemsToInsertString += "\n";
            }
            itemsToInsertString += `${baseIndentForNewItems}- ${PARAM_SECTION_KEY}${index + 1}:\n`;
            itemsToInsertString += `${baseIndentForNewItems}    НомерСтроки: "${index + 1}"\n`;
            itemsToInsertString += `${baseIndentForNewItems}    Имя: "${paramName.replace(/"/g, '\\"')}"\n`;
            
            const existingParamData = mergedData.get(paramName);
            const paramValue = existingParamData?.value ?? paramName;
            const paramType = existingParamData?.type ?? "Строка";
            const paramOutgoing = existingParamData?.outgoing ?? "No";
            itemsToInsertString += `${baseIndentForNewItems}    Значение: "${paramValue.replace(/"/g, '\\"')}"\n`;
            
            itemsToInsertString += `${baseIndentForNewItems}    ТипПараметра: "${paramType.replace(/"/g, '\\"')}"\n`;
            itemsToInsertString += `${baseIndentForNewItems}    ИсходящийПараметр: "${paramOutgoing.replace(/"/g, '\\"')}"`;
        });

        // Handle empty vs non-empty sections differently
        let finalTextToInsert: string;
        if (usedParametersInOrder.length === 0) {
            // Empty section: no content, but preserve newline before next section if needed
            finalTextToInsert = nextMajorKeyMatchResult && sectionContentEndOffset < fullText.length ? "\n" : "";
        } else {
            // Non-empty section: add leading newline and trailing newline if needed
            if (nextMajorKeyMatchResult && sectionContentEndOffset < fullText.length) {
                itemsToInsertString += "\n";
            }
            finalTextToInsert = "\n" + itemsToInsertString;
        }

        const currentSectionContent = fullText.substring(afterHeaderOffset, sectionContentEndOffset);
        if (currentSectionContent === finalTextToInsert) {
            console.log("[clearAndFillScenarioParameters] Section already up-to-date. No changes made.");
            return false;
        }

        // Apply the edit
        const edit = new vscode.WorkspaceEdit();
        const rangeToReplace = new vscode.Range(
            document.positionAt(afterHeaderOffset),
            document.positionAt(sectionContentEndOffset)
        );
        edit.replace(document.uri, rangeToReplace, finalTextToInsert);
        await vscode.workspace.applyEdit(edit);

        const refreshedSessionData = cloneScenarioParameterDataMap(mergedData);
        usedParametersInOrder.forEach(paramName => {
            if (!refreshedSessionData.has(paramName)) {
                refreshedSessionData.set(paramName, {
                    value: paramName,
                    type: "Строка",
                    outgoing: "No"
                });
            }
        });
        scenarioParameterSessionCache.set(document.uri.toString(), refreshedSessionData);

        console.log(`[clearAndFillScenarioParameters] Cleared and refilled with ${usedParametersInOrder.length} parameters, preserved ${mergedData.size} cached blocks.`);
        return true;
    };

    if (silent) {
        return await progressHandler(null);
    } else {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('Filling scenario parameters...'),
            cancellable: false
        }, progressHandler);
    }
}

interface ScenarioTextRange {
    startOffset: number;
    endOffset: number;
    content: string;
    eol: string;
}

function getScenarioTextRange(fullText: string): ScenarioTextRange | null {
    const scenarioBlockStartRegex = /ТекстСценария:\s*\|?\s*(\r\n|\r|\n)/m;
    const startMatch = scenarioBlockStartRegex.exec(fullText);
    if (!startMatch || startMatch.index === undefined) {
        return null;
    }

    const startOffset = startMatch.index + startMatch[0].length;
    const nextMajorKeyRegex = /\n(?![ \t])([А-Яа-яЁёA-Za-z]+:)/g;
    nextMajorKeyRegex.lastIndex = startOffset;
    const nextMajorKeyMatchResult = nextMajorKeyRegex.exec(fullText);
    const endOffset = nextMajorKeyMatchResult ? nextMajorKeyMatchResult.index : fullText.length;
    const content = fullText.substring(startOffset, endOffset);

    const eol = fullText.includes('\r\n') ? '\r\n' : '\n';
    return { startOffset, endOffset, content, eol };
}

async function replaceDocumentRange(
    document: vscode.TextDocument,
    startOffset: number,
    endOffset: number,
    replacement: string
): Promise<boolean> {
    const current = document.getText(new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)));
    if (current === replacement) {
        return false;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)),
        replacement
    );
    return await vscode.workspace.applyEdit(edit);
}

function alignNestedScenarioCallParametersInText(scriptText: string, eol: string): string {
    const lines = scriptText.split(/\r\n|\r|\n/);
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
        const callLine = lines[i];
        const callMatch = callLine.match(/^(\s*)(?:And|И|Допустим)\s+(.+)$/i);
        if (!callMatch) {
            continue;
        }

        const scenarioNameCandidate = callMatch[2].trim();
        if (!scenarioNameCandidate || scenarioNameCandidate.includes('"')) {
            continue;
        }

        const callIndentLength = callMatch[1].length;
        const params: { lineIndex: number; indent: string; name: string; value: string }[] = [];
        let j = i + 1;

        while (j < lines.length) {
            const currentLine = lines[j];
            const trimmed = currentLine.trim();

            if (trimmed === '' || trimmed.startsWith('#')) {
                break;
            }

            const assignmentMatch = currentLine.match(/^(\s+)([A-Za-zА-Яа-яЁё0-9_-]+)\s*=\s*(.*)$/);
            if (!assignmentMatch) {
                break;
            }

            if (assignmentMatch[1].length <= callIndentLength) {
                break;
            }

            params.push({
                lineIndex: j,
                indent: assignmentMatch[1],
                name: assignmentMatch[2],
                value: assignmentMatch[3].replace(/^\s+/, '')
            });
            j++;
        }

        if (params.length > 1) {
            const maxNameLength = Math.max(...params.map(param => param.name.length));
            for (const param of params) {
                const alignedLine = `${param.indent}${param.name.padEnd(maxNameLength, ' ')} = ${param.value}`;
                if (lines[param.lineIndex] !== alignedLine) {
                    lines[param.lineIndex] = alignedLine;
                    changed = true;
                }
            }
        }

        if (j > i + 1) {
            i = j - 1;
        }
    }

    if (!changed) {
        return scriptText;
    }

    return lines.join(eol);
}

function alignGherkinTablesInText(scriptText: string, eol: string): string {
    const lines = scriptText.split(/\r\n|\r|\n/);
    let changed = false;

    const tableRowRegex = /^(\s*)\|(.*)\|\s*$/;

    let i = 0;
    while (i < lines.length) {
        const firstMatch = lines[i].match(tableRowRegex);
        if (!firstMatch) {
            i++;
            continue;
        }

        const tableRows: { lineIndex: number; indent: string; cells: string[] }[] = [];
        let j = i;

        while (j < lines.length) {
            const rowMatch = lines[j].match(tableRowRegex);
            if (!rowMatch) {
                break;
            }

            const cells = rowMatch[2].split('|').map(cell => cell.trim());
            tableRows.push({
                lineIndex: j,
                indent: rowMatch[1],
                cells
            });
            j++;
        }

        if (tableRows.length > 0) {
            const maxColumns = Math.max(...tableRows.map(row => row.cells.length));
            const columnWidths = Array.from({ length: maxColumns }, () => 0);

            for (const row of tableRows) {
                for (let col = 0; col < maxColumns; col++) {
                    const cellValue = row.cells[col] || '';
                    columnWidths[col] = Math.max(columnWidths[col], cellValue.length);
                }
            }

            for (const row of tableRows) {
                const paddedCells: string[] = [];
                for (let col = 0; col < maxColumns; col++) {
                    const value = row.cells[col] || '';
                    paddedCells.push(value.padEnd(columnWidths[col], ' '));
                }
                const alignedRow = `${row.indent}| ${paddedCells.join(' | ')} |`;
                if (lines[row.lineIndex] !== alignedRow) {
                    lines[row.lineIndex] = alignedRow;
                    changed = true;
                }
            }
        }

        i = j;
    }

    if (!changed) {
        return scriptText;
    }

    return lines.join(eol);
}

/**
 * Aligns nested scenario parameter assignments in ТекстСценария block.
 * @param document The text document to modify
 * @returns Promise<boolean> true if changes were made
 */
export async function alignNestedScenarioCallParameters(document: vscode.TextDocument): Promise<boolean> {
    const fullText = document.getText();
    const scenarioTextRange = getScenarioTextRange(fullText);
    if (!scenarioTextRange) {
        return false;
    }

    const aligned = alignNestedScenarioCallParametersInText(scenarioTextRange.content, scenarioTextRange.eol);
    return await replaceDocumentRange(document, scenarioTextRange.startOffset, scenarioTextRange.endOffset, aligned);
}

/**
 * Aligns Gherkin table columns in ТекстСценария block.
 * @param document The text document to modify
 * @returns Promise<boolean> true if changes were made
 */
export async function alignGherkinTables(document: vscode.TextDocument): Promise<boolean> {
    const fullText = document.getText();
    const scenarioTextRange = getScenarioTextRange(fullText);
    if (!scenarioTextRange) {
        return false;
    }

    const aligned = alignGherkinTablesInText(scenarioTextRange.content, scenarioTextRange.eol);
    return await replaceDocumentRange(document, scenarioTextRange.startOffset, scenarioTextRange.endOffset, aligned);
}

/**
 * Обработчик команды открытия панели управления YAML параметрами
 */
export async function handleOpenYamlParametersManager(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(getExtensionUri());
    try {
        const { YamlParametersManager } = await import('./yamlParametersManager.js');
        const manager = YamlParametersManager.getInstance(context);
        await manager.openYamlParametersPanel();
    } catch (error) {
        console.error('[Cmd:openYamlParametersManager] Error:', error);
        vscode.window.showErrorMessage(t('Error opening Build Scenario Parameters Manager: {0}', String(error)));
    }
}
