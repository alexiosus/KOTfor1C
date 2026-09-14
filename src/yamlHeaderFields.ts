import type * as vscode from 'vscode';
import { ScenarioYamlDocument } from './scenarioYamlDocument';

export interface ScenarioHeaderFieldLines {
    fileTypeLine: number | null;
    nameLine: number | null;
    codeLine: number | null;
    systemFunctionLine: number | null;
    systemFunctionUidLine: number | null;
    kotDescriptionLine: number | null;
}

export interface TestSettingsFieldLines {
    codeLine: number | null;
    nameLine: number | null;
    scenarioUidLine: number | null;
    scenarioNameLine: number | null;
    etalonBaseNameLine: number | null;
    userProfileLine: number | null;
    modelDbIdLine: number | null;
}

function lineNumberAtOffset(source: string, offset: number): number {
    let lineNumber = 0;
    let newlineOffset = source.indexOf('\n');
    while (newlineOffset !== -1 && newlineOffset < offset) {
        lineNumber += 1;
        newlineOffset = source.indexOf('\n', newlineOffset + 1);
    }
    return lineNumber;
}

function findFieldLine(
    source: string,
    yamlDocument: ScenarioYamlDocument,
    sectionName: string,
    fieldName: string
): number | null {
    const field = yamlDocument.findField(sectionName, fieldName);
    return field ? lineNumberAtOffset(source, field.lineStart) : null;
}

export function buildYamlHeaderFieldLine(existingLine: string, fieldName: string, value: string): string {
    const indentMatch = existingLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const escapedValue = String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
    return `${indent}${fieldName}: "${escapedValue}"`;
}

export function findScenarioHeaderFieldLines(document: vscode.TextDocument): ScenarioHeaderFieldLines {
    const source = document.getText();
    const yamlDocument = ScenarioYamlDocument.parse(source);
    const fileType = yamlDocument.findSection('ТипФайла');
    return {
        fileTypeLine: fileType ? lineNumberAtOffset(source, fileType.pairRange.start) : null,
        nameLine: findFieldLine(source, yamlDocument, 'ДанныеСценария', 'Имя'),
        codeLine: findFieldLine(source, yamlDocument, 'ДанныеСценария', 'Код'),
        systemFunctionLine: findFieldLine(source, yamlDocument, 'ДанныеСценария', 'ФункцияСистемы'),
        systemFunctionUidLine: findFieldLine(source, yamlDocument, 'ДанныеСценария', 'UIDФункцияСистемы'),
        kotDescriptionLine: findFieldLine(source, yamlDocument, 'KOTМетаданные', 'Описание')
    };
}

export function findTestSettingsFieldLines(document: vscode.TextDocument): TestSettingsFieldLines {
    const source = document.getText();
    const yamlDocument = ScenarioYamlDocument.parse(source);
    return {
        codeLine: findFieldLine(source, yamlDocument, 'ДанныеТеста', 'Код'),
        nameLine: findFieldLine(source, yamlDocument, 'ДанныеТеста', 'Имя'),
        scenarioUidLine: findFieldLine(source, yamlDocument, 'ДанныеТеста', 'UIDСценария'),
        scenarioNameLine: findFieldLine(source, yamlDocument, 'ДанныеТеста', 'СценарийНаименование'),
        etalonBaseNameLine: findFieldLine(source, yamlDocument, 'ДанныеТеста', 'ЭталоннаяБазаИмя'),
        userProfileLine: findFieldLine(source, yamlDocument, 'ДанныеТеста', 'ПрофильПользователя'),
        modelDbIdLine: findFieldLine(source, yamlDocument, 'ДанныеТеста', 'ИдентификаторБазы')
    };
}

export function parseYamlSectionFieldValues(
    text: string,
    sectionName: string,
    fieldNames: string[]
): Record<string, string> {
    const result = Object.fromEntries(fieldNames.map(fieldName => [fieldName, ''])) as Record<string, string>;
    const yamlDocument = ScenarioYamlDocument.parse(text);
    for (const fieldName of fieldNames) {
        const value = yamlDocument.readScalar(sectionName, fieldName);
        if (value !== undefined) {
            result[fieldName] = value;
        }
    }

    return result;
}
