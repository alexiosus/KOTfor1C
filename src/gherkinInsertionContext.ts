import type * as vscode from 'vscode';

export interface GherkinInsertionContext {
    readonly supported: boolean;
    readonly language: 'ru' | 'en';
    readonly fallbackKeyword: string;
    readonly typedKeyword: string;
    readonly indentation: string;
}

type InsertionDocument = Pick<
    vscode.TextDocument,
    'uri' | 'languageId' | 'lineAt' | 'getText'
>;

const STEP_KEYWORD_REGEX = /^(?:\s*)(?:\*\s*)?(and|but|then|when|given|if|и|тогда|когда|если|допустим|дано|к тому же|но)(?=\s|$)/i;
const FEATURE_SECTION_REGEX = /^(?:Feature|Функционал|Rule|Правило|Examples|Примеры)\s*:?/i;
const SCENARIO_SECTION_REGEX = /^(?:Scenario|Сценарий|Scenario Outline|Структура сценария|Background|Предыстория)\s*:/i;
const FEATURE_NON_STEP_REGEX = /^(?:Feature|Функционал|Rule|Правило|Scenario|Сценарий|Scenario Outline|Структура сценария|Background|Предыстория|Examples|Примеры|Scenarios|Сценарии)\s*:/i;
const YAML_SCENARIO_BLOCK_REGEX = /^(\s*)ТекстСценария\s*:\s*[|>][^\r\n]*$/i;
const LANGUAGE_TAG_REGEX = /^#language:\s*(en|ru)\b/i;

function documentPath(document: InsertionDocument): string {
    const uri = document.uri as vscode.Uri & { readonly path?: string; readonly fsPath?: string };
    return (uri.fsPath || uri.path || uri.toString()).split(/[?#]/u, 1)[0].toLowerCase();
}

function leadingWhitespace(value: string): string {
    return /^\s*/u.exec(value)?.[0] ?? '';
}

function typedKeyword(line: string, character: number): string {
    return STEP_KEYWORD_REGEX.exec(line.slice(0, character))?.[1] ?? '';
}

function keywordLanguage(keyword: string): 'ru' | 'en' | null {
    if (!keyword) {
        return null;
    }
    return /[А-Яа-яЁё]/u.test(keyword) ? 'ru' : 'en';
}

function explicitLanguage(lines: readonly string[]): 'ru' | 'en' | null {
    for (const rawLine of lines) {
        const match = rawLine.replace(/^\uFEFF/u, '').trim().match(LANGUAGE_TAG_REGEX);
        if (match?.[1]) {
            return match[1].toLowerCase() === 'ru' ? 'ru' : 'en';
        }
    }
    return null;
}

function nearbyLanguage(lines: readonly string[], positionLine: number): 'ru' | 'en' {
    for (let line = positionLine; line >= 0; line -= 1) {
        const keyword = STEP_KEYWORD_REGEX.exec(lines[line])?.[1] ?? '';
        const language = keywordLanguage(keyword);
        if (language) {
            return language;
        }
        if (/^(?:Функционал|Правило|Сценарий|Структура сценария|Предыстория)\b/iu.test(lines[line].trim())) {
            return 'ru';
        }
        if (/^(?:Feature|Rule|Scenario|Scenario Outline|Background)\b/iu.test(lines[line].trim())) {
            return 'en';
        }
    }
    return 'en';
}

function featureContext(
    lines: readonly string[],
    lineIndex: number
): { readonly supported: true; readonly indentation: string } | null {
    const currentLine = lines[lineIndex];
    const trimmed = currentLine.trim();
    if (
        trimmed.startsWith('#')
        || trimmed.startsWith('@')
        || trimmed.startsWith('|')
        || trimmed.startsWith('"""')
        || FEATURE_NON_STEP_REGEX.test(trimmed)
    ) {
        return null;
    }

    let scenarioLine = -1;
    for (let line = lineIndex; line >= 0; line -= 1) {
        const candidate = lines[line].trim();
        if (!candidate || candidate.startsWith('#') || candidate.startsWith('@')) {
            continue;
        }
        if (SCENARIO_SECTION_REGEX.test(candidate)) {
            scenarioLine = line;
            break;
        }
        if (FEATURE_SECTION_REGEX.test(candidate)) {
            return null;
        }
    }
    if (scenarioLine < 0) {
        return null;
    }

    let indentation = leadingWhitespace(currentLine);
    if (!trimmed && indentation.length === 0) {
        for (let line = lineIndex - 1; line > scenarioLine; line -= 1) {
            if (lines[line].trim()) {
                indentation = leadingWhitespace(lines[line]);
                break;
            }
        }
        if (!indentation) {
            indentation = `${leadingWhitespace(lines[scenarioLine])}    `;
        }
    }
    return { supported: true, indentation };
}

function yamlScenarioBlockContext(
    lines: readonly string[],
    lineIndex: number
): { readonly supported: true; readonly indentation: string } | null {
    let blockLine = -1;
    let headerIndent = '';
    for (let line = 0; line <= lineIndex; line += 1) {
        const match = lines[line].match(YAML_SCENARIO_BLOCK_REGEX);
        if (match) {
            blockLine = line;
            headerIndent = match[1];
        }
    }
    if (blockLine < 0 || lineIndex <= blockLine) {
        return null;
    }

    for (let line = blockLine + 1; line <= lineIndex; line += 1) {
        const value = lines[line];
        if (!value.trim()) {
            continue;
        }
        if (leadingWhitespace(value).length <= headerIndent.length) {
            return null;
        }
    }

    const currentLine = lines[lineIndex];
    let indentation = leadingWhitespace(currentLine);
    if (!currentLine.trim() && indentation.length <= headerIndent.length) {
        indentation = '';
        for (let line = lineIndex - 1; line > blockLine; line -= 1) {
            const candidate = lines[line];
            if (candidate.trim()) {
                indentation = leadingWhitespace(candidate);
                break;
            }
        }
        if (!indentation) {
            indentation = `${headerIndent}    `;
        }
    }
    return { supported: true, indentation };
}

function isScenarioYaml(text: string): boolean {
    return /^(?:\uFEFF)?\s*ТипФайла\s*:\s*(?:["']?Сценарий["']?)\s*$/imu.test(text);
}

export function getGherkinInsertionContext(
    document: InsertionDocument,
    position: vscode.Position
): GherkinInsertionContext | null {
    if (
        !Number.isInteger(position.line)
        || !Number.isInteger(position.character)
        || position.line < 0
        || position.character < 0
    ) {
        return null;
    }

    const text = document.getText();
    const lines = text.split(/\r\n|\r|\n/u);
    if (position.line >= lines.length || position.character > lines[position.line].length) {
        return null;
    }
    try {
        if (document.lineAt(position.line).text !== lines[position.line]) {
            return null;
        }
    } catch {
        return null;
    }

    const path = documentPath(document);
    const isFeature = path.endsWith('.feature');
    const isYaml = document.languageId === 'yaml' || path.endsWith('.yaml') || path.endsWith('.yml');
    let support: { readonly supported: true; readonly indentation: string } | null = null;
    if (isFeature) {
        support = featureContext(lines, position.line);
    } else if (isYaml && isScenarioYaml(text)) {
        support = yamlScenarioBlockContext(lines, position.line);
    }
    if (!support) {
        return null;
    }

    const currentKeyword = typedKeyword(lines[position.line], position.character);
    const language = explicitLanguage(lines)
        ?? keywordLanguage(currentKeyword)
        ?? nearbyLanguage(lines, position.line);
    return {
        supported: true,
        language,
        fallbackKeyword: language === 'ru' ? 'И' : 'And',
        typedKeyword: currentKeyword,
        indentation: support.indentation
    };
}
