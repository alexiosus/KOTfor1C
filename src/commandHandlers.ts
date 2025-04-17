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
    const lineMatch = line.text.match(/^(\s*)And\s+(.*)/);
    if (!lineMatch) { return; }
    const searchText = lineMatch[2].trim();
    if (!searchText) { return; }
    const leadingWhitespace = lineMatch[1].length;
    const startChar = leadingWhitespace + 4;
    const endChar = startChar + lineMatch[2].length;
    const range = new vscode.Range(position.line, startChar, position.line, endChar);
    if (!range.contains(position)) { return; }
    console.log(`[Cmd:openSubscenario] Request for: "${searchText}"`);
    const targetUri = await findFileByName(searchText); // Вызов из navigationUtils
    if (targetUri && targetUri.fsPath !== document.uri.fsPath) {
         console.log(`[Cmd:openSubscenario] Target found: ${targetUri.fsPath}. Opening...`);
         try {
             const docToOpen = await vscode.workspace.openTextDocument(targetUri);
             await vscode.window.showTextDocument(docToOpen, { preview: false, preserveFocus: false });
         } catch (error: any) { console.error(`[Cmd:openSubscenario] Error opening ${targetUri.fsPath}:`, error); vscode.window.showErrorMessage(`Не удалось открыть файл: ${error.message || error}`); }
     } else if (targetUri) { console.log("[Cmd:openSubscenario] Target is current file."); }
       else { console.log("[Cmd:openSubscenario] Target not found."); vscode.window.showInformationMessage(`Файл для "${searchText}" не найден.`); }
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
 */
export function insertNestedScenarioRefHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const document = textEditor.document;
    const text = document.getText();
    
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
                
                // Создаем сниппет с тем же отступом, что и предыдущий элемент, но без пустой строки
                snippet = new vscode.SnippetString(
                    `${indent}- ВложенныеСценарии:\n` +
                    `${indent}    UIDВложенныйСценарий: "$1"\n` +
                    `${indent}    ИмяСценария: "$2"\n$0`
                );
                
                // Проверяем, нет ли пустой строки перед местом вставки
                const currentText = document.getText(new vscode.Range(document.positionAt(offset - 2), document.positionAt(offset)));
                if (currentText === '\n\n') {
                    // Если перед местом вставки пустая строка, меняем сниппет, убирая лишний перенос
                    snippet = new vscode.SnippetString(
                        `${indent}- ВложенныеСценарии:\n` +
                        `${indent}    UIDВложенныйСценарий: "$1"\n` +
                        `${indent}    ИмяСценария: "$2"\n$0`
                    );
                }
            } else {
                // Если не удалось найти элементы, добавляем в начало секции
                insertPosition = document.positionAt(sectionStartIndex + nestedMatch[0].length);
                snippet = new vscode.SnippetString(
                    '\n    - ВложенныеСценарии:\n' +
                    '        UIDВложенныйСценарий: "$1"\n' +
                    '        ИмяСценария: "$2"\n$0'
                );
            }
        } else {
            // Если элементов нет, вставляем первый с отступом
            insertPosition = document.positionAt(sectionStartIndex + nestedMatch[0].length);
            snippet = new vscode.SnippetString(
                '\n    - ВложенныеСценарии:\n' +
                '        UIDВложенныйСценарий: "$1"\n' +
                '        ИмяСценария: "$2"$0'
            );
        }
        
        // Вставляем сниппет в найденную позицию
        textEditor.insertSnippet(snippet, insertPosition);
    } else {
        // Если блок не найден, вставляем в текущую позицию как раньше
        const snippet = new vscode.SnippetString(
            '- ВложенныеСценарии:\n' +
            '\tUIDВложенныйСценарий: "$1"\n' +
            '\tИмяСценария: "$2"\n$0'
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
                    '        ИсходящийПараметр: "\${5|No,Yes|}"\n$0'
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
                '        ИсходящийПараметр: "\${5|No,Yes|}"$0'
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
        }).then(success => { if (!success) { vscode.window.showErrorMessage("Не удалось вставить UID."); } });
    } catch (error: any) { vscode.window.showErrorMessage(`Ошибка при генерации UID: ${error.message || error}`); }
}