const PARAM_SECTION_REGEX = /ПараметрыСценария:\s*([\s\S]*?)(?=\n(?![ \t])[А-Яа-яЁёA-Za-z]+:|\n*$)/;
const PARAM_BLOCK_REGEX = /^[ \t]*-[ \t]*ПараметрыСценария\d*:[ \t]*$/gm;
const PARAM_IDENTIFIER_REGEX = /^[A-Za-zА-Яа-яЁё0-9_-]+$/;
const BRACKET_PARAM_REGEX = /^\[[A-Za-zА-Яа-яЁё0-9_-]+\]$/;

export interface ScenarioParameterOffsetRange {
    startOffset: number;
    endOffset: number;
}

export interface ScenarioParameterDefinition {
    name: string;
    rawDefaultValue: string | null;
    normalizedDefaultValue: string;
    valueRange: ScenarioParameterOffsetRange | null;
}

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

function getScenarioParametersSectionInfo(documentText: string): { content: string; startOffset: number } | null {
    const match = PARAM_SECTION_REGEX.exec(documentText);
    if (!match || typeof match.index !== 'number') {
        return null;
    }

    const content = match[1] ?? '';
    const fullMatch = match[0] ?? '';
    return {
        content,
        startOffset: match.index + fullMatch.length - content.length
    };
}

function extractFieldValueInfo(
    blockContent: string,
    fieldName: string
): { value: string; valueRange: ScenarioParameterOffsetRange } | null {
    const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fieldRegex = new RegExp(`^([ \\t]*${escapedFieldName}:[ \\t]*)([^\\r\\n]*?)([ \\t]*)$`, 'm');
    const match = fieldRegex.exec(blockContent);
    if (!match) {
        return null;
    }

    const valueStartOffset = match.index + match[1].length;
    const valueEndOffset = valueStartOffset + match[2].length;

    return {
        value: match[2].trim(),
        valueRange: {
            startOffset: valueStartOffset,
            endOffset: valueEndOffset
        }
    };
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

export function parseScenarioParameterDefinitions(documentText: string): Map<string, ScenarioParameterDefinition> {
    const definitions = new Map<string, ScenarioParameterDefinition>();
    const sectionInfo = getScenarioParametersSectionInfo(documentText);
    if (!sectionInfo) {
        return definitions;
    }

    const sectionContent = sectionInfo.content;
    const blockRegex = new RegExp(PARAM_BLOCK_REGEX.source, PARAM_BLOCK_REGEX.flags);
    const blockMatches = Array.from(sectionContent.matchAll(blockRegex));

    blockMatches.forEach((match, index) => {
        const blockStartOffset = (match.index ?? 0) + match[0].length;
        const blockEndOffset = index + 1 < blockMatches.length
            ? (blockMatches[index + 1].index ?? sectionContent.length)
            : sectionContent.length;
        const blockContent = sectionContent.substring(blockStartOffset, blockEndOffset);
        const rawName = extractRawFieldValue(blockContent, 'Имя');
        if (!rawName) {
            return;
        }

        const parameterName = normalizeScenarioParameterName(rawName);
        if (!parameterName || !PARAM_IDENTIFIER_REGEX.test(parameterName) || definitions.has(parameterName)) {
            return;
        }

        const rawValueInfo = extractFieldValueInfo(blockContent, 'Значение');
        definitions.set(parameterName, {
            name: parameterName,
            rawDefaultValue: rawValueInfo?.value ?? null,
            normalizedDefaultValue: normalizeScenarioCallParameterValue(rawValueInfo?.value, parameterName),
            valueRange: rawValueInfo
                ? {
                    startOffset: sectionInfo.startOffset + blockStartOffset + rawValueInfo.valueRange.startOffset,
                    endOffset: sectionInfo.startOffset + blockStartOffset + rawValueInfo.valueRange.endOffset
                }
                : null
        });
    });

    return definitions;
}

export function parseScenarioParameterDefaults(documentText: string): Map<string, string> {
    const defaults = new Map<string, string>();
    parseScenarioParameterDefinitions(documentText).forEach((definition, name) => {
        defaults.set(name, definition.normalizedDefaultValue);
    });
    return defaults;
}
