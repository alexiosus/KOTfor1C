import * as vscode from 'vscode';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { findFileByName, findScenarioReferences } from './navigationUtils';

/**
 * Обработчик команды перехода к вложенному сценарию.
 */
export async function openSubscenarioHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const document = textEditor.document;
    const position = textEditor.selection.active;
    const line = document.lineAt(position.line);
    const lineMatch = line.text.match(/^(\s*)(?:And|When|Then|И)\s+(.*)/i);
    if (!lineMatch) { return; }
    const scenarioNameFromLine = lineMatch[2].trim();
    if (!scenarioNameFromLine) { return; }
    
    // Определяем диапазон только для имени сценария для проверки позиции курсора
    const keywordAndSpaceLength = lineMatch[0].length - lineMatch[2].length - lineMatch[1].length; // Длина "And " или "И " и т.д.
    const startChar = lineMatch[1].length + keywordAndSpaceLength;
    const endChar = startChar + scenarioNameFromLine.length;
    const range = new vscode.Range(position.line, startChar, position.line, endChar);

    if (!range.contains(position) && !range.isEmpty) { // Если курсор не внутри имени сценария (и диапазон не пустой)
        // Если выделение пустое и курсор сразу после имени, тоже считаем валидным
        if (!(range.end.isEqual(position) && textEditor.selection.isEmpty)) {
            return;
        }
    }

    console.log(`[Cmd:openSubscenario] Request for: "${scenarioNameFromLine}"`);
    const targetUri = await findFileByName(scenarioNameFromLine);
    if (targetUri && targetUri.fsPath !== document.uri.fsPath) {
         console.log(`[Cmd:openSubscenario] Target found: ${targetUri.fsPath}. Opening...`);
         try {
             const docToOpen = await vscode.workspace.openTextDocument(targetUri);
             await vscode.window.showTextDocument(docToOpen, { preview: false, preserveFocus: false });
         } catch (error: any) { console.error(`[Cmd:openSubscenario] Error opening ${targetUri.fsPath}:`, error); vscode.window.showErrorMessage(`Не удалось открыть файл: ${error.message || error}`); }
     } else if (targetUri) { console.log("[Cmd:openSubscenario] Target is current file."); }
       else { console.log("[Cmd:openSubscenario] Target not found."); vscode.window.showInformationMessage(`Файл для "${scenarioNameFromLine}" не найден.`); }
}

/**
 * Обработчик команды поиска ссылок на текущий сценарий.
 */
export async function findCurrentFileReferencesHandler() {
    console.log("[Cmd:findCurrentFileReferences] Triggered.");
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage("Нет активного редактора."); return; }
    const document = editor.document;
    // if (document.languageId !== 'yaml') { vscode.window.showWarningMessage("Команда работает только для YAML."); return; }

    let targetName: string | undefined;
    const lineCount = document.lineCount;
    const nameRegex = /^\s*Имя:\s*\"(.+?)\"\s*$/;
    for (let i = 0; i < lineCount; i++) {
        const line = document.lineAt(i); const nameMatch = line.text.match(nameRegex);
        if (nameMatch) { targetName = nameMatch[1]; break; }
    }
    if (!targetName) { vscode.window.showInformationMessage("Не удалось найти 'Имя: \"...\"' в текущем файле."); return; }

    console.log(`[Cmd:findCurrentFileReferences] Calling findScenarioReferences for "${targetName}"...`);
    const locations = await findScenarioReferences(targetName); // Вызов из navigationUtils
    if (!locations?.length) { vscode.window.showInformationMessage(`Ссылки на "${targetName}" не найдены.`); return; }

    // Формируем QuickPickItems
    const quickPickItems: (vscode.QuickPickItem & { location: vscode.Location })[] = await Promise.all(
        locations.map(async loc => {
           let description = ''; try { const doc = await vscode.workspace.openTextDocument(loc.uri); description = doc.lineAt(loc.range.start.line).text.trim(); } catch { description = 'N/A'; }
           return { label: `$(file-code) ${path.basename(loc.uri.fsPath)}:${loc.range.start.line + 1}`, description, detail: loc.uri.fsPath, location: loc };
       })
    );
    const pickedItem = await vscode.window.showQuickPick(quickPickItems, { matchOnDescription: true, matchOnDetail: true, placeHolder: `Ссылки на "${targetName}":` });
    if (pickedItem) {
        try {
            const doc = await vscode.workspace.openTextDocument(pickedItem.location.uri);
            await vscode.window.showTextDocument(doc, { selection: pickedItem.location.range, preview: false });
        } catch (err) { console.error(`[Cmd:findCurrentFileReferences] Error opening picked location:`, err); vscode.window.showErrorMessage("Не удалось открыть местоположение."); }
    }
}

/**
 * Обработчик команды вставки ссылки на вложенный сценарий.
 * Вставляет в конец блока "ВложенныеСценарии:" без пустых строк между элементами.
 * Если выделена строка вида "And ИмяСценария", пытается заполнить UID и Имя из найденного сценария.
 */
export async function insertNestedScenarioRefHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const document = textEditor.document;
    const text = document.getText();

    let uidToInsert = "$1"; // Плейсхолдер для UID
    let nameToInsert = "$2"; // Плейсхолдер для Имени

    const selection = textEditor.selection;
    // Проверяем, есть ли выделение и не пустое ли оно
    if (selection && !selection.isEmpty) {
        const selectedText = document.getText(selection).trim();
        // Ищем совпадение с вызовом сценария (And/И/Допустим ИмяСценария)
        const scenarioCallMatch = selectedText.match(/^\s*(?:And|И|Допустим)\s+(.+)/i);

        if (scenarioCallMatch && scenarioCallMatch[1]) {
            const scenarioNameFromSelection = scenarioCallMatch[1].trim();
            console.log(`[Cmd:insertNestedScenarioRef] Selected text matches, trying to find scenario: "${scenarioNameFromSelection}"`);

            const targetFileUri = await findFileByName(scenarioNameFromSelection);

            if (targetFileUri) {
                console.log(`[Cmd:insertNestedScenarioRef] Found target file for selected scenario: ${targetFileUri.fsPath}`);
                try {
                    const fileContentBytes = await vscode.workspace.fs.readFile(targetFileUri);
                    const fileContent = Buffer.from(fileContentBytes).toString('utf-8');

                    // Ищем блок ДанныеСценария
                    const dataScenarioBlockRegex = /ДанныеСценария:\s*([\s\S]*?)(?=\n[А-Яа-яЁёA-Za-z]+:|\n*$)/;
                    const dataScenarioBlockMatch = fileContent.match(dataScenarioBlockRegex);

                    if (dataScenarioBlockMatch && dataScenarioBlockMatch[1]) {
                        const blockContent = dataScenarioBlockMatch[1];
                        // Ищем UID и Имя внутри блока
                        const uidMatch = blockContent.match(/^\s*UID:\s*"([^"]+)"/m);
                        const nameFileMatch = blockContent.match(/^\s*Имя:\s*"([^"]+)"/m);

                        let extractedUidFromFile: string | undefined;
                        let extractedNameFromFile: string | undefined;

                        if (uidMatch && uidMatch[1]) {
                            extractedUidFromFile = uidMatch[1];
                        }
                        if (nameFileMatch && nameFileMatch[1]) {
                            extractedNameFromFile = nameFileMatch[1];
                        }

                        if (extractedUidFromFile && extractedNameFromFile) {
                            // Используем извлеченные данные, экранируя специальные символы для сниппета
                            uidToInsert = extractedUidFromFile.replace(/\$/g, '\\$').replace(/\}/g, '\\}').replace(/"/g, '\\"');
                            nameToInsert = extractedNameFromFile.replace(/\$/g, '\\$').replace(/\}/g, '\\}').replace(/"/g, '\\"');
                            console.log(`[Cmd:insertNestedScenarioRef] Extracted UID: "${uidToInsert}", Name: "${nameToInsert}" from target file.`);
                        } else {
                            console.log(`[Cmd:insertNestedScenarioRef] Could not extract UID or Name from target file content for "${scenarioNameFromSelection}".`);
                        }
                    } else {
                         console.log(`[Cmd:insertNestedScenarioRef] 'ДанныеСценария:' block not found or empty in target file for "${scenarioNameFromSelection}".`);
                    }
                } catch (error: any) {
                    console.error(`[Cmd:insertNestedScenarioRef] Error reading or parsing target file ${targetFileUri.fsPath}:`, error);
                }
            } else {
                console.log(`[Cmd:insertNestedScenarioRef] Target file not found for selected scenario name: "${scenarioNameFromSelection}". Inserting with placeholders.`);
            }
        } else {
            console.log(`[Cmd:insertNestedScenarioRef] Selected text "${selectedText}" does not match scenario call pattern. Inserting with placeholders.`);
        }
    } else {
        console.log("[Cmd:insertNestedScenarioRef] No selection or selection is empty. Inserting with placeholders.");
    }
    
    // Ищем блок ВложенныеСценарии:
    const nestedSectionRegex = /^ВложенныеСценарии:/m; // /m для многострочного поиска, ^ для начала строки
    const nestedMatch = text.match(nestedSectionRegex);
    
    let insertPosition: vscode.Position;
    let snippet: vscode.SnippetString;
    let indent = '    '; // Отступ по умолчанию

    if (nestedMatch && nestedMatch.index !== undefined) {
        const sectionStartOffset = nestedMatch.index;
        const sectionStartLine = document.positionAt(sectionStartOffset).line;
        
        // Определяем отступ самой секции "ВложенныеСценарии:"
        const sectionLineText = document.lineAt(sectionStartLine).text;
        const sectionIndentMatch = sectionLineText.match(/^(\s*)ВложенныеСценарии:/);
        const baseSectionIndent = sectionIndentMatch ? sectionIndentMatch[1] : "";
        indent = baseSectionIndent + '    '; // Отступ для элементов списка

        // Находим конец секции "ВложенныеСценарии:"
        // Ищем следующую основную секцию или конец файла
        let endOfSectionOffset = text.length;
        const nextMajorSectionRegex = new RegExp(`^(${baseSectionIndent}[А-Яа-яЁёA-Za-z]+:)`, "gm");
        nextMajorSectionRegex.lastIndex = sectionStartOffset + nestedMatch[0].length; // Начинаем поиск после "ВложенныеСценарии:"
        
        const nextMatch = nextMajorSectionRegex.exec(text);
        if (nextMatch) {
            endOfSectionOffset = nextMatch.index;
        }

        const sectionContent = text.substring(sectionStartOffset + nestedMatch[0].length, endOfSectionOffset);
        const lines = sectionContent.split('\n');
        
        let lastItemEndOffset = -1;
        const itemStartRegex = new RegExp(`^${indent.replace(/\s/g, "\\s")}- ВложенныеСценарии:`);

        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].trim() !== "") { // Находим последнюю непустую строку в секции
                // Проверяем, является ли эта строка началом элемента списка или его частью
                if (lines[i].match(itemStartRegex) || lines[i].startsWith(indent + '  ')) { // '  ' для полей внутри элемента
                    // Нашли конец последнего элемента
                    let currentOffset = sectionStartOffset + nestedMatch[0].length;
                    for (let j = 0; j <= i; j++) {
                        currentOffset += lines[j].length + 1; // +1 за \n
                    }
                    lastItemEndOffset = currentOffset;
                    break;
                }
            }
        }

        if (lastItemEndOffset !== -1) {
            // Вставляем после последнего элемента
            insertPosition = document.positionAt(lastItemEndOffset);
            // Убедимся, что вставляем с новой строки, если последняя строка не пустая
            const lineAtInsert = document.lineAt(insertPosition.line);
            if (lineAtInsert.text.substring(insertPosition.character).trim() !== "" || lineAtInsert.text.trim() !== "") {
                 snippet = new vscode.SnippetString(
                    `\n${indent}- ВложенныеСценарии:\n` +
                    `${indent}    UIDВложенныйСценарий: "${uidToInsert}"\n` +
                    `${indent}    ИмяСценария: "${nameToInsert}"$0`
                );
            } else {
                 snippet = new vscode.SnippetString(
                    `${indent}- ВложенныеСценарии:\n` +
                    `${indent}    UIDВложенныйСценарий: "${uidToInsert}"\n` +
                    `${indent}    ИмяСценария: "${nameToInsert}"$0`
                );
            }
        } else {
            // Секция "ВложенныеСценарии:" есть, но она пуста или содержит только пустые строки/комментарии
            // Вставляем как первый элемент
            let firstContentLineOffset = sectionStartOffset + nestedMatch[0].length;
            // Пропускаем пустые строки после "ВложенныеСценарии:"
            for (const line of lines) {
                if (line.trim() === "") {
                    firstContentLineOffset += line.length + 1;
                } else {
                    break;
                }
            }
            insertPosition = document.positionAt(firstContentLineOffset);
             snippet = new vscode.SnippetString(
                `\n${indent}- ВложенныеСценарии:\n` + // Начинаем с новой строки
                `${indent}    UIDВложенныйСценарий: "${uidToInsert}"\n` +
                `${indent}    ИмяСценария: "${nameToInsert}"$0`
            );
        }
        
        // Вставляем сниппет в найденную позицию
        textEditor.insertSnippet(snippet, insertPosition);
    } else {
        // Если блок "ВложенныеСценарии:" не найден, вставляем в текущую позицию курсора (старое поведение)
        // Определяем отступ текущей строки
        const currentLine = textEditor.document.lineAt(textEditor.selection.active.line);
        const currentLineIndentMatch = currentLine.text.match(/^(\s*)/);
        const currentIndent = currentLineIndentMatch ? currentLineIndentMatch[1] : "";
        indent = currentIndent; // Используем отступ текущей строки

        snippet = new vscode.SnippetString(
            `${indent}- ВложенныеСценарии:\n` +
            `${indent}\tUIDВложенныйСценарий: "${uidToInsert}"\n` + // Используем \t для вложенности относительно текущего отступа
            `${indent}\tИмяСценария: "${nameToInsert}"$0`
        );
        textEditor.insertSnippet(snippet); // Вставка в текущую позицию курсора
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
    const paramsRegex = /ПараметрыСценария:/m;
    const paramsMatch = text.match(paramsRegex);
    
    let insertPosition: vscode.Position;
    let snippet: vscode.SnippetString;
    let indent = '    ';

    if (paramsMatch && paramsMatch.index !== undefined) {
        const sectionStartOffset = paramsMatch.index;
        const sectionStartLine = document.positionAt(sectionStartOffset).line;

        const sectionLineText = document.lineAt(sectionStartLine).text;
        const sectionIndentMatch = sectionLineText.match(/^(\s*)ПараметрыСценария:/);
        const baseSectionIndent = sectionIndentMatch ? sectionIndentMatch[1] : "";
        indent = baseSectionIndent + '    '; // Отступ для элементов списка "- ПараметрыСценария"

        let endOfSectionOffset = text.length;
        const nextMajorSectionRegex = new RegExp(`^(${baseSectionIndent}[А-Яа-яЁёA-Za-z]+:)`, "gm");
        nextMajorSectionRegex.lastIndex = sectionStartOffset + paramsMatch[0].length;
        
        const nextMatch = nextMajorSectionRegex.exec(text);
        if (nextMatch) {
            endOfSectionOffset = nextMatch.index;
        }

        const sectionContent = text.substring(sectionStartOffset + paramsMatch[0].length, endOfSectionOffset);
        const lines = sectionContent.split('\n');
        
        let lastItemEndOffset = -1;
        // Регулярное выражение для поиска начала элемента списка параметров
        const itemStartRegex = new RegExp(`^${indent.replace(/\s/g, "\\s")}- ПараметрыСценария`);

        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].trim() !== "") { 
                if (lines[i].match(itemStartRegex) || lines[i].startsWith(indent + '  ')) {
                    let currentOffset = sectionStartOffset + paramsMatch[0].length;
                    for (let j = 0; j <= i; j++) {
                        currentOffset += lines[j].length + 1;
                    }
                    lastItemEndOffset = currentOffset;
                    break;
                }
            }
        }

        if (lastItemEndOffset !== -1) {
            insertPosition = document.positionAt(lastItemEndOffset);
            const lineAtInsert = document.lineAt(insertPosition.line);
             if (lineAtInsert.text.substring(insertPosition.character).trim() !== "" || lineAtInsert.text.trim() !== "") {
                snippet = new vscode.SnippetString(
                    `\n${indent}- ПараметрыСценария:\n` +
                    `${indent}    НомерСтроки: "$1"\n` +
                    `${indent}    Имя: "$2"\n` +
                    `${indent}    Значение: "$3"\n` +
                    `${indent}    ТипПараметра: "\${4|Строка,Число,Булево,Массив,Дата|}"\n` +
                    `${indent}    ИсходящийПараметр: "\${5|No,Yes|}"$0`
                );
            } else {
                 snippet = new vscode.SnippetString(
                    `${indent}- ПараметрыСценария:\n` +
                    `${indent}    НомерСтроки: "$1"\n` +
                    `${indent}    Имя: "$2"\n` +
                    `${indent}    Значение: "$3"\n` +
                    `${indent}    ТипПараметра: "\${4|Строка,Число,Булево,Массив,Дата|}"\n` +
                    `${indent}    ИсходящийПараметр: "\${5|No,Yes|}"$0`
                );
            }
        } else {
            let firstContentLineOffset = sectionStartOffset + paramsMatch[0].length;
            for (const line of lines) {
                if (line.trim() === "") {
                    firstContentLineOffset += line.length + 1;
                } else {
                    break;
                }
            }
            insertPosition = document.positionAt(firstContentLineOffset);
            snippet = new vscode.SnippetString(
                `\n${indent}- ПараметрыСценария:\n` +
                `${indent}    НомерСтроки: "$1"\n` +
                `${indent}    Имя: "$2"\n` +
                `${indent}    Значение: "$3"\n` +
                `${indent}    ТипПараметра: "\${4|Строка,Число,Булево,Массив,Дата|}"\n` +
                `${indent}    ИсходящийПараметр: "\${5|No,Yes|}"$0`
            );
        }
        textEditor.insertSnippet(snippet, insertPosition);
    } else {
        const currentLine = textEditor.document.lineAt(textEditor.selection.active.line);
        const currentLineIndentMatch = currentLine.text.match(/^(\s*)/);
        const currentIndent = currentLineIndentMatch ? currentLineIndentMatch[1] : "";
        indent = currentIndent;

        snippet = new vscode.SnippetString(
            `${indent}- ПараметрыСценария:\n` +
            `${indent}\tНомерСтроки: "$1"\n` +
            `${indent}\tИмя: "$2"\n` +
            `${indent}\tЗначение: "$3"\n` +
            `${indent}\tТипПараметра: "\${4|Строка,Число,Булево,Массив,Дата|}"\n` +
            `${indent}\tИсходящийПараметр: "\${5|No,Yes|}"$0`
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
        }).then(success => { if (!success) { vscode.window.showErrorMessage("Не удалось вставить UID."); } });
    } catch (error: any) { vscode.window.showErrorMessage(`Ошибка при генерации UID: ${error.message || error}`); }
}