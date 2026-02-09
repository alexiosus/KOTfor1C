const PARAM_SECTION_REGEX = /ПараметрыСценария:\s*([\s\S]*?)(?=\n(?![ \t])[А-Яа-яЁёA-Za-z]+:|\n*$)/;
const PARAM_BLOCK_REGEX = /^\s*-\s*ПараметрыСценария\d*:\s*$/gm;
const PARAM_IDENTIFIER_REGEX = /^[A-Za-zА-Яа-яЁё0-9_-]+$/;
const BRACKET_PARAM_REGEX = /^\[[A-Za-zА-Яа-яЁё0-9_-]+\]$/;

function isQuotedValue(value: string): boolean {
    return (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith('\'') && value.endsWith('\''))
    );
}

function unwrapQuotedValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && isQuotedValue(trimmed)) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function extractRawFieldValue(blockContent: string, fieldName: string): string | null {
    const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fieldRegex = new RegExp(`^\\s*${escapedFieldName}:\\s*(.+?)\\s*$`, 'm');
    const match = blockContent.match(fieldRegex);
    return match?.[1]?.trim() ?? null;
}

function getScenarioParametersSection(documentText: string): string | null {
    const match = PARAM_SECTION_REGEX.exec(documentText);
    return match?.[1] ?? null;
}

function escapeDoubleQuotes(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function normalizeScenarioParameterName(value: string): string {
    const unquoted = unwrapQuotedValue(value).trim();
    const withoutBrackets = unquoted.replace(/^\[/, '').replace(/\]$/, '').trim();
    return withoutBrackets;
}

export function extractScenarioParameterNameFromText(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }

    const bracketMatch = trimmed.match(/\[([A-Za-zА-Яа-яЁё0-9_-]+)\]/);
    if (bracketMatch?.[1]) {
        return bracketMatch[1];
    }

    const normalized = normalizeScenarioParameterName(trimmed);
    if (!PARAM_IDENTIFIER_REGEX.test(normalized)) {
        return '';
    }
    return normalized;
}

export function normalizeScenarioCallParameterValue(rawValue: string | undefined, fallbackName: string): string {
    const trimmed = (rawValue ?? '').trim();
    if (!trimmed) {
        return `"${escapeDoubleQuotes(fallbackName)}"`;
    }

    if (BRACKET_PARAM_REGEX.test(trimmed) || isQuotedValue(trimmed)) {
        return trimmed;
    }

    return `"${escapeDoubleQuotes(unwrapQuotedValue(trimmed))}"`;
}

export function parseScenarioParameterDefaults(documentText: string): Map<string, string> {
    const defaults = new Map<string, string>();
    const sectionContent = getScenarioParametersSection(documentText);
    if (!sectionContent) {
        return defaults;
    }

    PARAM_BLOCK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PARAM_BLOCK_REGEX.exec(sectionContent)) !== null) {
        const blockStartOffset = match.index + match[0].length;
        PARAM_BLOCK_REGEX.lastIndex = blockStartOffset;
        const nextMatch = PARAM_BLOCK_REGEX.exec(sectionContent);
        const blockEndOffset = nextMatch ? nextMatch.index : sectionContent.length;

        const blockContent = sectionContent.substring(blockStartOffset, blockEndOffset);
        const rawName = extractRawFieldValue(blockContent, 'Имя');
        if (!rawName) {
            PARAM_BLOCK_REGEX.lastIndex = blockStartOffset;
            continue;
        }

        const parameterName = normalizeScenarioParameterName(rawName);
        if (!parameterName || !PARAM_IDENTIFIER_REGEX.test(parameterName) || defaults.has(parameterName)) {
            PARAM_BLOCK_REGEX.lastIndex = blockStartOffset;
            continue;
        }

        const rawValue = extractRawFieldValue(blockContent, 'Значение');
        defaults.set(parameterName, normalizeScenarioCallParameterValue(rawValue, parameterName));
        PARAM_BLOCK_REGEX.lastIndex = blockStartOffset;
    }

    return defaults;
}
