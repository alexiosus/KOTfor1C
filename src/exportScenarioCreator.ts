import { parseExportScenarios, type ExportScenarioParseContext } from './exportScenarioParser';
import { getGherkinDefinitionKeywords, type ScenarioLanguage } from './gherkinDefinitionKeywords';

export interface ExportScenarioEditSource extends ExportScenarioParseContext {
    readonly text: string;
    readonly version: number;
}

export interface ExportScenarioEditRequest {
    readonly expectedVersion: number;
    readonly title: string;
    readonly parameterNames?: readonly string[];
    readonly confirmAddExportTag?: boolean;
    readonly createNewFile?: boolean;
    readonly language?: ScenarioLanguage;
    readonly featureTitle?: string;
    readonly eol?: '\n' | '\r\n';
    readonly includeBom?: boolean;
    readonly finalNewline?: boolean;
}

export interface ExportScenarioTextEdit {
    readonly startOffset: number;
    readonly endOffset: number;
    readonly newText: string;
}

export interface ExportScenarioEditPlan {
    readonly documentVersion: number;
    readonly edits: readonly ExportScenarioTextEdit[];
    readonly cursor: { readonly line: number; readonly character: number };
    readonly declarationRange: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
    };
}

export interface ExportScenarioCommandSeed {
    readonly invocation?: string;
    readonly language?: ScenarioLanguage;
    readonly documentUri?: string;
}

export interface ExportScenarioQuotedValue {
    readonly start: number;
    readonly end: number;
    readonly value: string;
}

function positionAtOffset(source: string, offset: number): { line: number; character: number } {
    let line = 0;
    let lineStart = 0;
    for (let index = 0; index < offset; index++) {
        if (source[index] === '\n') {
            line += 1;
            lineStart = index + 1;
        }
    }
    return { line, character: offset - lineStart };
}

function lineAt(source: string, lineNumber: number): string {
    let start = 0;
    let line = 0;
    while (line < lineNumber && start < source.length) {
        const newline = source.indexOf('\n', start);
        if (newline < 0) {
            return '';
        }
        start = newline + 1;
        line += 1;
    }
    const newline = source.indexOf('\n', start);
    const raw = source.slice(start, newline < 0 ? source.length : newline);
    return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

function leadingWhitespace(value: string): string {
    let end = 0;
    while (end < value.length && (value[end] === ' ' || value[end] === '\t')) {
        end += 1;
    }
    return value.slice(0, end);
}

export function extractExportScenarioQuotedValues(value: string): readonly ExportScenarioQuotedValue[] {
    const result: ExportScenarioQuotedValue[] = [];
    for (let index = 0; index < value.length; index++) {
        const quote = value[index];
        if (quote !== '"' && quote !== "'") {
            continue;
        }
        let end = index + 1;
        while (end < value.length) {
            if (value[end] === quote && value[end - 1] !== '\\') {
                break;
            }
            end += 1;
        }
        if (end >= value.length) {
            break;
        }
        result.push({ start: index + 1, end, value: value.slice(index + 1, end) });
        index = end;
    }
    return result;
}

export function suggestedExportScenarioParameterName(value: string, index: number): string {
    return value.trim().replace(/^%\d+\s*/u, '') || `Parameter${index + 1}`;
}

function parameterizedTitle(title: string, parameterNames?: readonly string[]): string {
    const values = extractExportScenarioQuotedValues(title);
    if (!parameterNames) {
        return title;
    }
    if (parameterNames.length !== values.length) {
        throw new Error(`Expected ${values.length} parameter names, received ${parameterNames.length}.`);
    }
    const normalized = parameterNames.map(suggestedExportScenarioParameterName);
    const seen = new Set<string>();
    for (const name of normalized) {
        const key = name.toLocaleLowerCase();
        if (seen.has(key)) {
            throw new Error(`Duplicate parameter name: ${name}.`);
        }
        seen.add(key);
    }
    let result = title;
    for (let index = values.length - 1; index >= 0; index--) {
        const value = values[index];
        result = result.slice(0, value.start) + normalized[index] + result.slice(value.end);
    }
    return result;
}

function applyEdits(source: string, edits: readonly ExportScenarioTextEdit[]): string {
    return [...edits]
        .sort((left, right) => right.startOffset - left.startOffset)
        .reduce(
            (current, edit) => current.slice(0, edit.startOffset) + edit.newText + current.slice(edit.endOffset),
            source
        );
}

function frozenPlan(
    documentVersion: number,
    edits: readonly ExportScenarioTextEdit[],
    result: string,
    titleStart: number,
    titleLength: number,
    cursorOffset: number
): ExportScenarioEditPlan {
    return Object.freeze({
        documentVersion,
        edits: Object.freeze(edits.map(edit => Object.freeze(edit))),
        cursor: Object.freeze(positionAtOffset(result, cursorOffset)),
        declarationRange: Object.freeze({
            start: Object.freeze(positionAtOffset(result, titleStart)),
            end: Object.freeze(positionAtOffset(result, titleStart + titleLength))
        })
    });
}

export function deriveExportScenarioDraft(seed: ExportScenarioCommandSeed): {
    readonly title: string;
    readonly parameterSuggestions: readonly string[];
} {
    const language = seed.language ?? 'ru';
    let title = (seed.invocation ?? '').trim();
    if (title.startsWith('*')) {
        title = title.slice(1).trimStart();
    }
    const keywords = [...getGherkinDefinitionKeywords(language).steps]
        .sort((left, right) => right.length - left.length);
    const lower = title.toLocaleLowerCase();
    const keyword = keywords.find(candidate => {
        const normalized = candidate.toLocaleLowerCase();
        return lower === normalized || lower.startsWith(`${normalized} `);
    });
    if (keyword) {
        title = title.slice(keyword.length).trimStart();
    }
    return Object.freeze({
        title,
        parameterSuggestions: Object.freeze(extractExportScenarioQuotedValues(title)
            .map((value, index) => suggestedExportScenarioParameterName(value.value, index)))
    });
}

export function planExportScenarioEdit(
    source: ExportScenarioEditSource,
    request: ExportScenarioEditRequest
): ExportScenarioEditPlan {
    if (source.version !== request.expectedVersion) {
        throw new Error('The document changed while the exported scenario was being created. Please retry.');
    }
    const title = parameterizedTitle(request.title.trim(), request.parameterNames);
    if (!title) {
        throw new Error('Export scenario title must not be empty.');
    }
    const parsed = parseExportScenarios(source.text, source);

    if (request.createNewFile) {
        if (source.text.length > 0) {
            throw new Error('A new export feature can only be planned for an empty file.');
        }
        const language = request.language ?? source.defaultLanguage;
        const keywords = getGherkinDefinitionKeywords(language);
        const eol = request.eol ?? '\n';
        const bom = request.includeBom ? '\uFEFF' : '';
        const finalNewline = request.finalNewline !== false;
        const featureTitle = request.featureTitle?.trim()
            || (language === 'ru' ? 'Экспортные сценарии' : 'Export scenarios');
        const scenarioKeyword = keywords.scenario[0];
        const preamble = [
            `${bom}# language: ${language}`,
            '@ExportScenarios',
            `${keywords.feature[0]}: ${featureTitle}`,
            ''
        ].join(eol) + eol;
        const scenarioLine = `${scenarioKeyword}: ${title}`;
        const bodyIndent = '    ';
        const newText = preamble + scenarioLine + eol + bodyIndent + (finalNewline ? eol : '');
        const titleStart = preamble.length + scenarioKeyword.length + 2;
        const cursorOffset = preamble.length + scenarioLine.length + eol.length + bodyIndent.length;
        const edits = [{ startOffset: 0, endOffset: 0, newText }];
        return frozenPlan(source.version, edits, newText, titleStart, title.length, cursorOffset);
    }

    if (!parsed.feature) {
        throw new Error('The selected file does not contain a Feature declaration.');
    }
    if (!parsed.feature.hasExportTag && request.confirmAddExportTag !== true) {
        throw new Error('Adding @ExportScenarios to this feature requires explicit export tag confirmation.');
    }

    const scenarioKeyword = getGherkinDefinitionKeywords(parsed.language).scenario[0];
    const scenarioIndent = parsed.scenarios.length > 0
        ? leadingWhitespace(lineAt(source.text, parsed.scenarios[0].declarationRange.start.line))
        : `${leadingWhitespace(lineAt(source.text, parsed.feature.declarationRange.start.line))}    `;
    const bodyIndent = `${scenarioIndent}    `;
    const prefix = parsed.insertion.endsWithEol ? parsed.eol : parsed.eol + parsed.eol;
    const scenarioLine = `${scenarioIndent}${scenarioKeyword}: ${title}`;
    const insertionText = prefix
        + scenarioLine
        + parsed.eol
        + bodyIndent
        + (parsed.insertion.endsWithEol ? parsed.eol : '');
    const edits: ExportScenarioTextEdit[] = [];
    if (!parsed.feature.hasExportTag) {
        edits.push({
            startOffset: parsed.feature.tagInsertion.offset,
            endOffset: parsed.feature.tagInsertion.offset,
            newText: `@ExportScenarios${parsed.eol}`
        });
    }
    edits.push({
        startOffset: parsed.insertion.offset,
        endOffset: parsed.insertion.offset,
        newText: insertionText
    });

    const result = applyEdits(source.text, edits);
    const precedingEditLength = edits
        .filter(edit => edit.startOffset <= parsed.insertion.offset && edit !== edits[edits.length - 1])
        .reduce((total, edit) => total + edit.newText.length - (edit.endOffset - edit.startOffset), 0);
    const insertedAt = parsed.insertion.offset + precedingEditLength;
    const titleStart = insertedAt + prefix.length + scenarioIndent.length + scenarioKeyword.length + 2;
    const cursorOffset = insertedAt + prefix.length + scenarioLine.length + parsed.eol.length + bodyIndent.length;
    return frozenPlan(source.version, edits, result, titleStart, title.length, cursorOffset);
}
