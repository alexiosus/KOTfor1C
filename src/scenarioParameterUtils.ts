import { ScenarioYamlDocument } from './scenarioYamlDocument';
const PARAM_IDENTIFIER_REGEX = /^[A-Za-zА-Яа-яЁё0-9_-]+$/;
const BRACKET_PARAM_REGEX = /^\[[A-Za-zА-Яа-яЁё0-9_-]+\]$/;

export interface ScenarioParameterOffsetRange {
    startOffset: number;
    endOffset: number;
}

export interface ScenarioParameterDefinition {
    name: string;
    type: 'scalar' | 'table';
    outgoing: boolean;
    value: string;
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
    // Preserve newlines (including the block scalar's trailing newline) in the
    // catalog. Insertion leaves these defaults implicit or uses a local reference.
    if (/[\r\n]/u.test(rawValue ?? '')) { return `"${escapeDoubleQuotes(rawValue!)}"`; }
    const trimmed = (rawValue ?? '').trim();
    if (!trimmed) {
        return `"${escapeDoubleQuotes(fallbackName)}"`;
    }

    if (BRACKET_PARAM_REGEX.test(trimmed) || isQuotedValue(trimmed)) {
        return trimmed;
    }

    return `"${escapeDoubleQuotes(unwrapQuotedValue(trimmed))}"`;
}

export function parseScenarioParameterDefinitions(documentText: string, section = 'ПараметрыСценария'): Map<string, ScenarioParameterDefinition> {
    const definitions = new Map<string, ScenarioParameterDefinition>();
    const yaml = ScenarioYamlDocument.parse(documentText);
    const valueFields = yaml.findRecordFields(section, 'Значение');
    yaml.readRecords(section).forEach(record => {
        const rawName = record.fields.get('Имя');
        if (typeof rawName !== 'string' || !rawName) {
            return;
        }

        const parameterName = normalizeScenarioParameterName(rawName);
        if (!parameterName || !PARAM_IDENTIFIER_REGEX.test(parameterName) || definitions.has(parameterName)) {
            return;
        }

        const blockContent = documentText.slice(record.range.start, record.range.end);
        const rawValueInfo = extractFieldValueInfo(blockContent, 'Значение');
        const type = record.fields.get('ТипПараметра') === 'Таблица' ? 'table' : 'scalar';
        const decoded = record.fields.get('Значение');
        // Invalid YAML escapes such as \; are accepted by the legacy compiler;
        // its adapter returns the original quoted token in that case.
        const value = typeof decoded === 'string'
            ? decoded === rawValueInfo?.value ? unwrapQuotedValue(decoded) : decoded
            : decoded === null || decoded === undefined ? '' : String(decoded);
        const isBlock = /^[|>][\d+-]*(?:\s+#.*)?$/u.test(rawValueInfo?.value ?? '');
        const valueField = valueFields.find(field => field.pairRange.start >= record.range.start && field.pairRange.start < record.range.end);
        let blockEnd = valueField?.blockScalarContentRange?.end ?? record.range.end;
        // Leave the field separator in place if a block scalar is replaced by a scalar.
        if (documentText[blockEnd - 1] === '\n') { blockEnd -= documentText[blockEnd - 2] === '\r' ? 2 : 1; }
        definitions.set(parameterName, {
            name: parameterName,
            type,
            outgoing: /^(?:да|yes|true)$/iu.test(String(record.fields.get('ИсходящийПараметр') ?? '')),
            value,
            rawDefaultValue: isBlock ? value : rawValueInfo?.value ?? null,
            normalizedDefaultValue: type === 'table' ? value.trimEnd() : normalizeScenarioCallParameterValue(isBlock ? value : rawValueInfo?.value, parameterName),
            valueRange: rawValueInfo
                ? {
                    startOffset: record.range.start + rawValueInfo.valueRange.startOffset,
                    endOffset: isBlock ? blockEnd : record.range.start + rawValueInfo.valueRange.endOffset
                }
                : null
        });
    });

    return definitions;
}

/** YAML block defaults need literal rows; scalar defaults need YAML escaping. */
export function renderScenarioParameterDefault(value: string, type: string): string {
    if (type === 'Таблица') {
        return `|\n${value.trimEnd().split(/\r\n|\r|\n/u).map(line => `        ${line}`).join('\n')}`;
    }
    if (/[\r\n]/u.test(value)) {
        const normalized = value.replace(/\r\n|\r/gu, '\n');
        const rows = normalized.split('\n');
        if (normalized.endsWith('\n')) { rows.pop(); }
        // The external reader recognizes only the exact | marker. Existing
        // defaults are preserved from source during refill instead of rendered.
        return `|\n${rows.map(line => `        ${line}`).join('\n')}`;
    }
    return JSON.stringify(value);
}

export function splitCompilerParameterVariants(value: string): string[] {
    const values = [''];
    for (let index = 0; index < value.length; index++) {
        if (value[index] === '\\' && value[index + 1] === ';') { values[values.length - 1] += ';'; index++; }
        else if (value[index] === ';') { values.push(''); }
        else { values[values.length - 1] += value[index]; }
    }
    return values;
}

export function buildScenarioVariantPreview(documentText: string, limit = 8, settingsText?: string): {
    count: string; samples: Record<string, string>[]; truncated: boolean;
} {
    const definitions = settingsText ? parseScenarioParameterDefinitions(settingsText, 'ПараметрыТеста') : new Map<string, ScenarioParameterDefinition>();
    for (const [name, parameter] of parseScenarioParameterDefinitions(documentText)) {
        if (!definitions.has(name)) { definitions.set(name, parameter); }
    }
    const parameters = [...definitions.values()];
    const alternatives = parameters.map(parameter => parameter.type === 'table'
        ? [parameter.value] : splitCompilerParameterVariants(compilerScalarDefault(parameter)));
    const count = alternatives.reduce((total, values) => total * BigInt(values.length), 1n);
    const sampleCount = Number(count < BigInt(Math.max(0, limit)) ? count : BigInt(Math.max(0, limit)));
    const samples = Array.from({ length: sampleCount }, (_, index) => {
        let cursor = BigInt(index);
        const sample: Record<string, string> = {};
        for (let column = parameters.length - 1; column >= 0; column--) {
            sample[parameters[column].name] = alternatives[column][Number(cursor % BigInt(alternatives[column].length))];
            cursor /= BigInt(alternatives[column].length);
        }
        return sample;
    });
    return { count: count.toString(), samples, truncated: count > BigInt(sampleCount) };
}

function compilerScalarDefault(parameter: ScenarioParameterDefinition): string {
    const raw = parameter.rawDefaultValue?.trim();
    if (raw && isQuotedValue(raw)) {
        // ВернутьСпецСимволыYaml decodes these two escapes only; YAML's
        // \n, \t, Unicode escapes and doubled single quotes remain literal.
        return raw.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
    }
    return parameter.value;
}

export function parseScenarioParameterDefaults(documentText: string): Map<string, string> {
    const defaults = new Map<string, string>();
    parseScenarioParameterDefinitions(documentText).forEach((definition, name) => {
        defaults.set(name, definition.normalizedDefaultValue);
    });
    return defaults;
}

/** The compiler cannot encode physical newlines in an inline scalar assignment. */
export function isMultilineScalarDefault(value: string | undefined, type?: 'scalar' | 'table'): boolean {
    return type !== 'table' && /[\r\n]/u.test(value ?? '');
}
