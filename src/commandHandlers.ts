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
 */
export function insertNestedScenarioRefHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const snippet = new vscode.SnippetString(
        '- ВложенныеСценарии:\n' +
        '\tUIDВложенныйСценарий: "$1"\n' +
        '\tИмяСценария: "$2"\n$0' // Финальный стоп
    );
    textEditor.insertSnippet(snippet);
}

/**
 * Обработчик команды вставки параметра сценария.
 */
export function insertScenarioParamHandler(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    const snippet = new vscode.SnippetString(
        '- ПараметрыСценария:\n' +
        '\tНомерСтроки: "$1"\n' +
        '\tИмя: "$2"\n' +
        '\tЗначение: "$3"\n' +
        '\tТипПараметра: "${4|Строка,Число,Булево,Массив,Дата|}"\n' +
        '\tИсходящийПараметр: "${5|No,Yes|}"\n$0' // Финальный стоп
    );
    textEditor.insertSnippet(snippet);
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