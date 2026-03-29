import * as vscode from 'vscode';

function isYamlFileDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'yaml' || document.fileName.toLowerCase().endsWith('.yaml');
}

function matchesFileType(content: string, typeName: string): boolean {
    const escapedTypeName = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`ТипФайла:\\s*["']${escapedTypeName}["']`),
        new RegExp(`ТипФайла:\\s*${escapedTypeName}`),
        new RegExp(`типфайла:\\s*["']${escapedTypeName.toLowerCase()}["']`),
        new RegExp(`типфайла:\\s*${escapedTypeName.toLowerCase()}`)
    ];

    return patterns.some(pattern => pattern.test(content));
}

/**
 * Проверяет, является ли YAML файл сценарием (содержит строку "ТипФайла: Сценарий")
 */
export function isScenarioYamlFile(document: vscode.TextDocument): boolean {
    if (!isYamlFileDocument(document)) {
        return false;
    }

    return matchesFileType(document.getText(), 'Сценарий');
}

/**
 * Проверяет, является ли URI файлом сценария YAML
 */
export async function isScenarioYamlUri(uri: vscode.Uri): Promise<boolean> {
    try {
        if (!uri.fsPath.toLowerCase().endsWith('.yaml')) {
            return false;
        }

        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        return matchesFileType(content, 'Сценарий');
    } catch (error) {
        console.warn(`[YamlValidator] Error checking file ${uri.fsPath}:`, error);
        return false;
    }
}

export function isTestSettingsYamlFile(document: vscode.TextDocument): boolean {
    if (!isYamlFileDocument(document)) {
        return false;
    }

    return matchesFileType(document.getText(), 'НастройкаТеста');
}

export async function isTestSettingsYamlUri(uri: vscode.Uri): Promise<boolean> {
    try {
        if (!uri.fsPath.toLowerCase().endsWith('.yaml')) {
            return false;
        }

        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        return matchesFileType(content, 'НастройкаТеста');
    } catch (error) {
        console.warn(`[YamlValidator] Error checking file ${uri.fsPath}:`, error);
        return false;
    }
}
