import * as vscode from 'vscode';

export interface ScenarioHeaderFieldLines {
    fileTypeLine: number | null;
    nameLine: number | null;
    codeLine: number | null;
    systemFunctionLine: number | null;
    systemFunctionUidLine: number | null;
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

function normalizeYamlIndent(line: string): string {
    return line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
}

function getYamlIndent(line: string): number {
    const normalized = normalizeYamlIndent(line);
    const match = normalized.match(/^(\s*)/);
    return match ? match[1].length : 0;
}

function isIgnorableYamlLine(line: string): boolean {
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    return trimmed.length === 0 || trimmed.startsWith('#');
}

function isYamlKeyLine(trimmedNoBom: string): boolean {
    return /^[^:#][^:]*:\s*(.*)$/.test(trimmedNoBom);
}

function findYamlSectionStart(lines: string[], sectionName: string): number {
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmedNoBom = line.replace(/^\uFEFF/, '').trim();
        if (getYamlIndent(line) === 0 && trimmedNoBom === `${sectionName}:`) {
            return index;
        }
    }

    return -1;
}

function findYamlSectionEnd(lines: string[], startIndex: number, startIndent: number): number {
    for (let index = startIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (isIgnorableYamlLine(line)) {
            continue;
        }

        const indent = getYamlIndent(line);
        const trimmedNoBom = line.replace(/^\uFEFF/, '').trim();
        if (indent <= startIndent && isYamlKeyLine(trimmedNoBom)) {
            return index;
        }
    }

    return lines.length;
}

function parseYamlScalar(rawValue: string): string {
    const trimmed = String(rawValue ?? '').trim();
    if (!trimmed) {
        return '';
    }

    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        const quote = trimmed[0];
        const inner = trimmed.slice(1, -1);
        if (quote === '"') {
            return inner
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
        }
        return inner;
    }

    return trimmed;
}

function findFieldLine(
    lines: string[],
    sectionStart: number,
    sectionEnd: number,
    sectionIndent: number,
    fieldName: string
): number | null {
    const regex = new RegExp(`^\\s*${fieldName}:\\s*.+$`);
    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
        const line = lines[index];
        if (isIgnorableYamlLine(line)) {
            continue;
        }
        if (getYamlIndent(line) <= sectionIndent) {
            continue;
        }
        if (regex.test(line)) {
            return index;
        }
    }

    return null;
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
    const lines = Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
    const fileTypeLine = lines.findIndex(line => getYamlIndent(line) === 0 && /^\s*ТипФайла:\s*.+$/.test(line));
    const sectionStart = findYamlSectionStart(lines, 'ДанныеСценария');
    if (sectionStart === -1) {
        return { fileTypeLine: fileTypeLine >= 0 ? fileTypeLine : null, nameLine: null, codeLine: null, systemFunctionLine: null, systemFunctionUidLine: null };
    }

    const sectionIndent = getYamlIndent(lines[sectionStart]);
    const sectionEnd = findYamlSectionEnd(lines, sectionStart, sectionIndent);
    return {
        fileTypeLine: fileTypeLine >= 0 ? fileTypeLine : null,
        nameLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'Имя'),
        codeLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'Код'),
        systemFunctionLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'ФункцияСистемы'),
        systemFunctionUidLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'UIDФункцияСистемы')
    };
}

export function findTestSettingsFieldLines(document: vscode.TextDocument): TestSettingsFieldLines {
    const lines = Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
    const sectionStart = findYamlSectionStart(lines, 'ДанныеТеста');
    if (sectionStart === -1) {
        return {
            codeLine: null,
            nameLine: null,
            scenarioUidLine: null,
            scenarioNameLine: null,
            etalonBaseNameLine: null,
            userProfileLine: null,
            modelDbIdLine: null
        };
    }

    const sectionIndent = getYamlIndent(lines[sectionStart]);
    const sectionEnd = findYamlSectionEnd(lines, sectionStart, sectionIndent);
    return {
        codeLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'Код'),
        nameLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'Имя'),
        scenarioUidLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'UIDСценария'),
        scenarioNameLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'СценарийНаименование'),
        etalonBaseNameLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'ЭталоннаяБазаИмя'),
        userProfileLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'ПрофильПользователя'),
        modelDbIdLine: findFieldLine(lines, sectionStart, sectionEnd, sectionIndent, 'ИдентификаторБазы')
    };
}

export function parseYamlSectionFieldValues(
    text: string,
    sectionName: string,
    fieldNames: string[]
): Record<string, string> {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const sectionStart = findYamlSectionStart(lines, sectionName);
    const result = Object.fromEntries(fieldNames.map(fieldName => [fieldName, ''])) as Record<string, string>;

    if (sectionStart === -1) {
        return result;
    }

    const sectionIndent = getYamlIndent(lines[sectionStart]);
    const sectionEnd = findYamlSectionEnd(lines, sectionStart, sectionIndent);
    const remainingFields = new Set(fieldNames);

    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
        const line = lines[index];
        if (isIgnorableYamlLine(line) || getYamlIndent(line) <= sectionIndent) {
            continue;
        }

        for (const fieldName of Array.from(remainingFields)) {
            const match = line.match(new RegExp(`^\\s*${fieldName}:\\s*(.*)$`));
            if (!match) {
                continue;
            }

            result[fieldName] = parseYamlScalar(match[1] || '');
            remainingFields.delete(fieldName);
            break;
        }

        if (remainingFields.size === 0) {
            break;
        }
    }

    return result;
}
