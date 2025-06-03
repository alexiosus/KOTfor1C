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
    const lineMatch = line.text.match(/^(\s*)(?:And|Then|When|И|Когда|Тогда)\s+(.*)/i);
    if (!lineMatch) { return; }
    const scenarioNameFromLine = lineMatch[2].trim();
    if (!scenarioNameFromLine) { return; }
    
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
        vscode.window.showInformationMessage('Табы заменены на 4 пробела.');
    } else {
        vscode.window.showInformationMessage('Табы не найдены в документе.');
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
        const callRegex = /^\s*(?:And|И|Допустим)\s+([^\s"'(][^"'(]*?)(?:\s*\(.*|\s*$)/i; // Более точное регулярное выражение

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
    console.log("[Cmd:checkAndFillNestedScenarios] Starting...");
    const document = textEditor.document;
    const fullText = document.getText();

    const existingNestedScenarios = parseExistingNestedScenarios(fullText);
    const calledScenariosInBody = parseCalledScenariosFromScriptBody(fullText);

    const scenariosToAdd: { name: string; uid: string }[] = [];

    for (const calledName of calledScenariosInBody) {
        if (!existingNestedScenarios.includes(calledName)) {
            let uid = uuidv4(); // Генерируем новый UID по умолчанию
            let nameForBlock = calledName; // Используем имя из вызова по умолчанию

            const targetFileUri = await findFileByName(calledName);
            if (targetFileUri) {
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
                        if (nameFileMatch && nameFileMatch[1]) {
                            // nameForBlock = nameFileMatch[1]; // Используем имя из файла, если оно найдено
                        }
                         console.log(`[Cmd:checkAndFillNestedScenarios] Found details for "${calledName}": UID=${uid}, NameInFile=${nameFileMatch ? nameFileMatch[1] : 'N/A'}`);
                    }
                } catch (error) {
                    console.error(`[Cmd:checkAndFillNestedScenarios] Error reading/parsing target file for "${calledName}":`, error);
                }
            }
            scenariosToAdd.push({ name: nameForBlock, uid: uid });
        }
    }

    if (scenariosToAdd.length === 0) {
        vscode.window.showInformationMessage("Все вызываемые сценарии уже присутствуют в секции 'ВложенныеСценарии'.");
        console.log("[Cmd:checkAndFillNestedScenarios] No scenarios to add.");
        return;
    }

    // Логика вставки (адаптирована из insertNestedScenarioRefHandler)
    const nestedSectionRegex = /ВложенныеСценарии:/;
    const nestedMatch = fullText.match(nestedSectionRegex);
    let insertPosition: vscode.Position;
    let baseIndent = '    '; // Отступ по умолчанию для элементов списка
    let initialOffset = 0; // Смещение от начала документа до начала секции "ВложенныеСценарии:"
    let needsInitialNewline = false; // Нужен ли перенос строки перед первым новым элементом

    if (nestedMatch && nestedMatch.index !== undefined) {
        initialOffset = nestedMatch.index + nestedMatch[0].length;
        
        const sectionEndRegex = /\n[А-Яа-яЁёA-Za-z]+:|\n*$/g; // Ищем следующую секцию или конец файла
        sectionEndRegex.lastIndex = initialOffset;
        const nextSectionMatch = sectionEndRegex.exec(fullText);
        const sectionEndOffset = nextSectionMatch ? nestedMatch.index + nestedMatch[0].length + nextSectionMatch.index : fullText.length;
        
        const sectionContent = fullText.substring(initialOffset, sectionEndOffset);
        const lines = sectionContent.split('\n');
        
        let lastItemEndLineIndex = -1;
        let lastItemIndent = '';

        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (line.match(/^\s*- ВложенныеСценарии:/)) { // Нашли начало последнего элемента
                const indentMatch = line.match(/^(\s*)/);
                lastItemIndent = indentMatch ? indentMatch[0] : baseIndent;
                
                // Ищем конец этого элемента
                for (let j = i + 1; j < lines.length; j++) {
                    const subLine = lines[j];
                    const subIndentMatch = subLine.match(/^(\s*)/);
                    if (subLine.trim() === '' || (subIndentMatch && subIndentMatch[0].length > lastItemIndent.length)) {
                        lastItemEndLineIndex = j;
                    } else {
                        break;
                    }
                }
                if (lastItemEndLineIndex === -1) lastItemEndLineIndex = i; // Если элемент однострочный
                break;
            }
        }

        if (lastItemEndLineIndex !== -1) {
            // Вставка после последнего существующего элемента
            let currentOffset = initialOffset;
            for (let i = 0; i <= lastItemEndLineIndex; i++) {
                currentOffset += lines[i].length + 1; // +1 за \n
            }
            insertPosition = document.positionAt(currentOffset -1); // -1 чтобы быть на той же строке или перед \n
            baseIndent = lastItemIndent;
            needsInitialNewline = true; // Нужен перенос строки перед первым новым элементом
        } else {
            // Секция "ВложенныеСценарии:" есть, но она пуста
            insertPosition = document.positionAt(initialOffset);
            needsInitialNewline = true; // Нужен перенос строки
        }
    } else {
        // Секция "ВложенныеСценарии:" не найдена, добавляем ее в конец файла (или перед ТекстСценария, если он есть)
        const textScriptRegex = /\nТекстСценария:/;
        const textScriptMatch = fullText.match(textScriptRegex);
        let endPositionOffset = fullText.length;
        if (textScriptMatch && textScriptMatch.index !== undefined) {
            endPositionOffset = textScriptMatch.index;
        }
        insertPosition = document.positionAt(endPositionOffset);
        
        const textToInsert = (endPositionOffset < fullText.length ? '\n' : (fullText.endsWith('\n\n') ? '' : (fullText.endsWith('\n') ? '\n' : '\n\n'))) +
                             'ВложенныеСценарии:';
        
        await textEditor.edit(editBuilder => {
            editBuilder.insert(insertPosition, textToInsert);
        });
        // Обновляем позицию вставки и initialOffset после добавления секции
        initialOffset = insertPosition.character + textToInsert.length;
        insertPosition = document.positionAt(initialOffset);
        needsInitialNewline = true;
    }
    
    // Формируем текст для вставки
    let textToInsert = "";
    scenariosToAdd.forEach((scenario, index) => {
        if (index === 0 && needsInitialNewline) {
            textToInsert += '\n';
        } else if (index > 0) {
            textToInsert += '\n'; // Перенос строки между элементами
        }
        textToInsert += `${baseIndent}- ВложенныеСценарии:\n`;
        textToInsert += `${baseIndent}    UIDВложенныйСценарий: "${scenario.uid.replace(/"/g, '\\"')}"\n`; // Экранируем кавычки в UID
        textToInsert += `${baseIndent}    ИмяСценария: "${scenario.name.replace(/"/g, '\\"')}"`; // Экранируем кавычки в имени
    });


    if (textToInsert) {
        // Проверяем, нужно ли добавить перенос строки в конце, если это последняя секция
        const isLastSection = !fullText.substring(insertPosition.character + textToInsert.length).includes('\n');
        if (isLastSection && !textToInsert.endsWith('\n')) {
            // textToInsert += '\n'; // Не добавляем, если это конец файла и нет других секций
        }


        const finalInsertPosition = insertPosition; // Сохраняем позицию перед edit
        await textEditor.edit(editBuilder => {
            editBuilder.insert(finalInsertPosition, textToInsert);
        });
        vscode.window.showInformationMessage(`Добавлено ${scenariosToAdd.length} вложенных сценариев.`);
        console.log(`[Cmd:checkAndFillNestedScenarios] Added ${scenariosToAdd.length} scenarios.`);
    }
}