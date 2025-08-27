import * as vscode from 'vscode';

/**
 * Проверяет, является ли YAML файл сценарием (содержит строку "ТипФайла: Сценарий")
 */
export function isScenarioYamlFile(document: vscode.TextDocument): boolean {
    // Проверяем, что это YAML файл
    if (document.languageId !== 'yaml' && !document.fileName.toLowerCase().endsWith('.yaml')) {
        return false;
    }

    const content = document.getText();
    
    // Ищем строку "ТипФайла: Сценарий" (с учетом различных вариантов кавычек и пробелов)
    const scenarioPatterns = [
        /ТипФайла:\s*["']Сценарий["']/,
        /ТипФайла:\s*Сценарий/,
        /типфайла:\s*["']сценарий["']/,
        /типфайла:\s*сценарий/
    ];

    return scenarioPatterns.some(pattern => pattern.test(content));
}

/**
 * Проверяет, является ли URI файлом сценария YAML
 */
export async function isScenarioYamlUri(uri: vscode.Uri): Promise<boolean> {
    try {
        // Проверяем расширение файла
        if (!uri.fsPath.toLowerCase().endsWith('.yaml')) {
            return false;
        }

        // Читаем содержимое файла
        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        
        // Ищем строку "ТипФайла: Сценарий"
        const scenarioPatterns = [
            /ТипФайла:\s*["']Сценарий["']/,
            /ТипФайла:\s*Сценарий/,
            /типфайла:\s*["']сценарий["']/,
            /типфайла:\s*сценарий/
        ];

        return scenarioPatterns.some(pattern => pattern.test(content));
    } catch (error) {
        console.warn(`[YamlValidator] Error checking file ${uri.fsPath}:`, error);
        return false;
    }
}
