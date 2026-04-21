import * as vscode from 'vscode';
import { parseBlockKeyword } from './blockKeywordParser';
import { isScenarioYamlFile } from './yamlValidator';

const semanticTokenTypes = [
    'gherkinComment',
    'gherkinFeatureKeyword',
    'gherkinFeatureTitle',
    'gherkinScenarioKeyword',
    'gherkinScenarioTitle',
    'gherkinStepKeyword',
    'gherkinString',
    'gherkinTag',
    'gherkinPlaceholder',
    'gherkinBracketParameter',
    'gherkinTable'
] as const;

const semanticTokensLegend = new vscode.SemanticTokensLegend([...semanticTokenTypes]);

const tokenTypeIndexes = new Map<typeof semanticTokenTypes[number], number>(
    semanticTokenTypes.map((tokenType, index) => [tokenType, index])
);

const scenarioTextHeaderRegex = /^(\s*)ТекстСценария:\s*\|?[-+0-9]*\s*$/;
const topLevelYamlKeyRegex = /^\s*[А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z0-9_]*:/;
const commentLineRegex = /^(\s*)#.*$/;
const featureKeywordRegex = /^(\s*)(Feature|Функционал|Функция|Функциональность|Свойство)\s*:(.*)$/i;
const scenarioElementRegex = /^(\s*)(Rule|Правило|Background|Контекст|Scenario Outline|Scenario Template|Scenario|Сценарий|Examples|Примеры|Example|Пример|Scenarios|Сценарии)\s*:(.*)$/i;
const stepKeywordRegex = /^(\s*)(\*\s*)?(And|Then|When|Given|But|If|ElseIf|Else|EndIf|Do|EndDo|Try|Except|EndTry|Но|Тогда|Когда|Если|ИначеЕсли|Иначе|КонецЕсли|Цикл|КонецЦикла|Попытка|Исключение|КонецПопытки|И|К тому же|Допустим|Дано)(?=\s|$)/i;
const nestedParamAssignmentRegex = /^(\s*)([A-Za-zА-Яа-яЁё0-9_-]+)(\s*)=(?=\s|$)/;
const tagRegex = /@[^\s@|#]+/g;
const placeholderRegex = /<[^<>\s]+>/g;
const bracketParameterRegex = /\[[^\[\]\r\n]+\]/g;
const doubleQuotedArgumentRegex = /"(?:[^"\\]|\\.)*"/g;
const singleQuotedArgumentRegex = /'(?:[^'\\]|\\.)*'/g;
const docStringDelimiterRegex = /^(\s*)("""|```)(.*)$/;

interface LineSpan {
    start: number;
    end: number;
}

function isScenarioHighlightingEnabled(document: vscode.TextDocument): boolean {
    return vscode.workspace
        .getConfiguration('kotTestToolkit', document.uri)
        .get<boolean>('editor.useFeatureLanguageModeForScenarioYaml', true);
}

function pushToken(
    builder: vscode.SemanticTokensBuilder,
    line: number,
    char: number,
    length: number,
    tokenType: typeof semanticTokenTypes[number]
): void {
    if (length <= 0) {
        return;
    }

    const tokenTypeIndex = tokenTypeIndexes.get(tokenType);
    if (tokenTypeIndex === undefined) {
        return;
    }

    builder.push(line, char, length, tokenTypeIndex, 0);
}

function pushRegexMatches(
    builder: vscode.SemanticTokensBuilder,
    lineIndex: number,
    lineText: string,
    regex: RegExp,
    tokenType: typeof semanticTokenTypes[number]
): void {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(lineText)) !== null) {
        if (!match[0]) {
            break;
        }

        pushToken(builder, lineIndex, match.index, match[0].length, tokenType);
    }
}

function collectRegexSpans(lineText: string, regex: RegExp): LineSpan[] {
    const spans: LineSpan[] = [];
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(lineText)) !== null) {
        if (!match[0]) {
            break;
        }

        spans.push({
            start: match.index,
            end: match.index + match[0].length
        });
    }
    return spans;
}

function mergeLineSpans(spans: LineSpan[]): LineSpan[] {
    if (spans.length === 0) {
        return [];
    }

    const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: LineSpan[] = [sorted[0]];

    for (let index = 1; index < sorted.length; index++) {
        const current = sorted[index];
        const last = merged[merged.length - 1];
        if (current.start <= last.end) {
            last.end = Math.max(last.end, current.end);
            continue;
        }
        merged.push(current);
    }

    return merged;
}

function findBlockKeywordRange(lineText: string, blockKeyword: NonNullable<ReturnType<typeof parseBlockKeyword>>): { start: number; length: number } | null {
    const keywordPatterns: Record<NonNullable<ReturnType<typeof parseBlockKeyword>>, RegExp> = {
        If: /\b(?:If|Если)\b/i,
        ElseIf: /\b(?:ElseIf|ИначеЕсли)\b/i,
        Else: /\b(?:Else|Иначе)\b/i,
        EndIf: /\b(?:EndIf|КонецЕсли)\b/i,
        Do: /\b(?:Do|Цикл)\b/i,
        EndDo: /\b(?:EndDo|КонецЦикла)\b/i,
        Try: /\b(?:Try|Попытка)\b/i,
        Except: /\b(?:Except|Исключение)\b/i,
        EndTry: /\b(?:EndTry|КонецПопытки)\b/i
    };

    const match = lineText.match(keywordPatterns[blockKeyword]);
    if (!match || match.index === undefined) {
        return null;
    }

    return {
        start: match.index,
        length: match[0].length
    };
}

export class ScenarioSyntaxHighlightProvider implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
    public static readonly legend = semanticTokensLegend;

    private readonly semanticTokensChangedEmitter = new vscode.EventEmitter<void>();

    public readonly onDidChangeSemanticTokens = this.semanticTokensChangedEmitter.event;

    public refresh(): void {
        this.semanticTokensChangedEmitter.fire();
    }

    public dispose(): void {
        this.semanticTokensChangedEmitter.dispose();
    }

    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
        if (
            document.languageId !== 'yaml'
            || !isScenarioYamlFile(document)
            || !isScenarioHighlightingEnabled(document)
        ) {
            return new vscode.SemanticTokens(new Uint32Array());
        }

        const builder = new vscode.SemanticTokensBuilder(ScenarioSyntaxHighlightProvider.legend);
        let insideScenarioText = false;
        let scenarioHeaderIndent = 0;
        let docStringDelimiter: string | null = null;

        for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
            const lineText = document.lineAt(lineIndex).text;

            if (!insideScenarioText) {
                const headerMatch = lineText.match(scenarioTextHeaderRegex);
                if (headerMatch) {
                    insideScenarioText = true;
                    scenarioHeaderIndent = headerMatch[1]?.length ?? 0;
                }
                continue;
            }

            const trimmed = lineText.trim();
            const currentIndent = (lineText.match(/^[ \t]*/)?.[0].length) ?? 0;
            if (!docStringDelimiter && currentIndent <= scenarioHeaderIndent && topLevelYamlKeyRegex.test(lineText)) {
                insideScenarioText = false;
                const headerMatch = lineText.match(scenarioTextHeaderRegex);
                if (headerMatch) {
                    insideScenarioText = true;
                    scenarioHeaderIndent = headerMatch[1]?.length ?? 0;
                }
                continue;
            }

            if (!trimmed) {
                continue;
            }

            const docStringMatch = lineText.match(docStringDelimiterRegex);
            if (docStringDelimiter) {
                pushToken(builder, lineIndex, currentIndent, lineText.length - currentIndent, 'gherkinString');
                if (docStringMatch?.[2] === docStringDelimiter) {
                    docStringDelimiter = null;
                }
                continue;
            }

            if (docStringMatch) {
                pushToken(builder, lineIndex, currentIndent, lineText.length - currentIndent, 'gherkinString');
                docStringDelimiter = docStringMatch[2];
                continue;
            }

            const commentMatch = lineText.match(commentLineRegex);
            if (commentMatch) {
                pushToken(builder, lineIndex, commentMatch[1].length, lineText.length - commentMatch[1].length, 'gherkinComment');
                continue;
            }

            pushRegexMatches(builder, lineIndex, lineText, tagRegex, 'gherkinTag');
            pushRegexMatches(builder, lineIndex, lineText, doubleQuotedArgumentRegex, 'gherkinString');
            pushRegexMatches(builder, lineIndex, lineText, singleQuotedArgumentRegex, 'gherkinString');
            pushRegexMatches(builder, lineIndex, lineText, bracketParameterRegex, 'gherkinBracketParameter');
            pushRegexMatches(builder, lineIndex, lineText, placeholderRegex, 'gherkinPlaceholder');

            const featureMatch = lineText.match(featureKeywordRegex);
            if (featureMatch) {
                const keywordStart = featureMatch[1].length;
                const keywordText = featureMatch[2];
                const title = featureMatch[3];
                pushToken(builder, lineIndex, keywordStart, keywordText.length, 'gherkinFeatureKeyword');

                const colonIndex = lineText.indexOf(':', keywordStart + keywordText.length);
                if (colonIndex >= 0) {
                    const titleStart = colonIndex + 1;
                    const leadingTitleWhitespace = title.match(/^\s*/)?.[0].length ?? 0;
                    const titleLength = title.length - leadingTitleWhitespace;
                    if (titleLength > 0) {
                        pushToken(builder, lineIndex, titleStart + leadingTitleWhitespace, titleLength, 'gherkinFeatureTitle');
                    }
                }
            }

            const scenarioElementMatch = lineText.match(scenarioElementRegex);
            if (scenarioElementMatch) {
                const keywordStart = scenarioElementMatch[1].length;
                const keywordText = scenarioElementMatch[2];
                const title = scenarioElementMatch[3];
                pushToken(builder, lineIndex, keywordStart, keywordText.length, 'gherkinScenarioKeyword');

                const colonIndex = lineText.indexOf(':', keywordStart + keywordText.length);
                if (colonIndex >= 0) {
                    const titleStart = colonIndex + 1;
                    const leadingTitleWhitespace = title.match(/^\s*/)?.[0].length ?? 0;
                    const titleLength = title.length - leadingTitleWhitespace;
                    if (titleLength > 0) {
                        pushToken(builder, lineIndex, titleStart + leadingTitleWhitespace, titleLength, 'gherkinScenarioTitle');
                    }
                }
            }

            const stepMatch = lineText.match(stepKeywordRegex);
            if (stepMatch) {
                const indentLength = stepMatch[1].length;
                const starPrefix = stepMatch[2] ?? '';
                const keyword = stepMatch[3];
                const keywordStart = indentLength + starPrefix.length;
                pushToken(builder, lineIndex, keywordStart, keyword.length, 'gherkinStepKeyword');
            }

            const blockKeyword = parseBlockKeyword(lineText);
            if (blockKeyword) {
                const blockKeywordRange = findBlockKeywordRange(lineText, blockKeyword);
                if (blockKeywordRange) {
                    pushToken(builder, lineIndex, blockKeywordRange.start, blockKeywordRange.length, 'gherkinStepKeyword');
                }
            }

            const assignmentMatch = lineText.match(nestedParamAssignmentRegex);
            if (assignmentMatch) {
                const parameterStart = assignmentMatch[1].length;
                const parameterName = assignmentMatch[2];
                pushToken(builder, lineIndex, parameterStart, parameterName.length, 'gherkinBracketParameter');
            }

            if (trimmed.startsWith('|')) {
                pushToken(builder, lineIndex, currentIndent, lineText.length - currentIndent, 'gherkinTable');
            }
        }

        return builder.build();
    }
}

export function collectScenarioPlainTextRanges(document: vscode.TextDocument): vscode.Range[] {
    if (
        document.languageId !== 'yaml'
        || !isScenarioYamlFile(document)
        || !isScenarioHighlightingEnabled(document)
    ) {
        return [];
    }

    const ranges: vscode.Range[] = [];
    let insideScenarioText = false;
    let scenarioHeaderIndent = 0;
    let docStringDelimiter: string | null = null;

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
        const lineText = document.lineAt(lineIndex).text;

        if (!insideScenarioText) {
            const headerMatch = lineText.match(scenarioTextHeaderRegex);
            if (headerMatch) {
                insideScenarioText = true;
                scenarioHeaderIndent = headerMatch[1]?.length ?? 0;
            }
            continue;
        }

        const trimmed = lineText.trim();
        const currentIndent = (lineText.match(/^[ \t]*/)?.[0].length) ?? 0;
        if (!docStringDelimiter && currentIndent <= scenarioHeaderIndent && topLevelYamlKeyRegex.test(lineText)) {
            insideScenarioText = false;
            const headerMatch = lineText.match(scenarioTextHeaderRegex);
            if (headerMatch) {
                insideScenarioText = true;
                scenarioHeaderIndent = headerMatch[1]?.length ?? 0;
            }
            continue;
        }

        if (!trimmed) {
            continue;
        }

        const docStringMatch = lineText.match(docStringDelimiterRegex);
        if (docStringDelimiter) {
            if (docStringMatch?.[2] === docStringDelimiter) {
                docStringDelimiter = null;
            }
            continue;
        }

        if (docStringMatch) {
            docStringDelimiter = docStringMatch[2];
            continue;
        }

        if (
            commentLineRegex.test(lineText)
            || featureKeywordRegex.test(lineText)
            || scenarioElementRegex.test(lineText)
            || trimmed.startsWith('|')
        ) {
            continue;
        }

        const excludedSpans: LineSpan[] = [
            ...collectRegexSpans(lineText, tagRegex),
            ...collectRegexSpans(lineText, doubleQuotedArgumentRegex),
            ...collectRegexSpans(lineText, singleQuotedArgumentRegex),
            ...collectRegexSpans(lineText, bracketParameterRegex),
            ...collectRegexSpans(lineText, placeholderRegex)
        ];

        const stepMatch = lineText.match(stepKeywordRegex);
        if (stepMatch) {
            const keywordStart = stepMatch[1].length + (stepMatch[2]?.length ?? 0);
            excludedSpans.push({
                start: keywordStart,
                end: keywordStart + stepMatch[3].length
            });
        }

        const blockKeyword = parseBlockKeyword(lineText);
        if (blockKeyword) {
            const blockKeywordRange = findBlockKeywordRange(lineText, blockKeyword);
            if (blockKeywordRange) {
                excludedSpans.push({
                    start: blockKeywordRange.start,
                    end: blockKeywordRange.start + blockKeywordRange.length
                });
            }
        }

        const assignmentMatch = lineText.match(nestedParamAssignmentRegex);
        if (assignmentMatch) {
            const parameterStart = assignmentMatch[1].length;
            excludedSpans.push({
                start: parameterStart,
                end: parameterStart + assignmentMatch[2].length
            });
        }

        const mergedExcludedSpans = mergeLineSpans(excludedSpans);
        let segmentStart = currentIndent;
        for (const span of mergedExcludedSpans) {
            if (span.start > segmentStart) {
                const segmentText = lineText.slice(segmentStart, span.start);
                if (segmentText.trim().length > 0) {
                    ranges.push(
                        new vscode.Range(
                            new vscode.Position(lineIndex, segmentStart),
                            new vscode.Position(lineIndex, span.start)
                        )
                    );
                }
            }
            segmentStart = Math.max(segmentStart, span.end);
        }

        if (segmentStart < lineText.length) {
            const segmentText = lineText.slice(segmentStart);
            if (segmentText.trim().length > 0) {
                ranges.push(
                    new vscode.Range(
                        new vscode.Position(lineIndex, segmentStart),
                        new vscode.Position(lineIndex, lineText.length)
                    )
                );
            }
        }
    }

    return ranges;
}

export function collectScenarioBracketParameterRanges(document: vscode.TextDocument): vscode.Range[] {
    if (
        document.languageId !== 'yaml'
        || !isScenarioYamlFile(document)
        || !isScenarioHighlightingEnabled(document)
    ) {
        return [];
    }

    const ranges: vscode.Range[] = [];
    let insideScenarioText = false;
    let scenarioHeaderIndent = 0;
    let docStringDelimiter: string | null = null;

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
        const lineText = document.lineAt(lineIndex).text;

        if (!insideScenarioText) {
            const headerMatch = lineText.match(scenarioTextHeaderRegex);
            if (headerMatch) {
                insideScenarioText = true;
                scenarioHeaderIndent = headerMatch[1]?.length ?? 0;
            }
            continue;
        }

        const trimmed = lineText.trim();
        const currentIndent = (lineText.match(/^[ \t]*/)?.[0].length) ?? 0;
        if (!docStringDelimiter && currentIndent <= scenarioHeaderIndent && topLevelYamlKeyRegex.test(lineText)) {
            insideScenarioText = false;
            const headerMatch = lineText.match(scenarioTextHeaderRegex);
            if (headerMatch) {
                insideScenarioText = true;
                scenarioHeaderIndent = headerMatch[1]?.length ?? 0;
            }
            continue;
        }

        if (!trimmed) {
            continue;
        }

        const docStringMatch = lineText.match(docStringDelimiterRegex);
        if (docStringDelimiter) {
            if (docStringMatch?.[2] === docStringDelimiter) {
                docStringDelimiter = null;
            }
            continue;
        }

        if (docStringMatch) {
            docStringDelimiter = docStringMatch[2];
            continue;
        }

        const spans = collectRegexSpans(lineText, bracketParameterRegex);
        for (const span of spans) {
            ranges.push(
                new vscode.Range(
                    new vscode.Position(lineIndex, span.start),
                    new vscode.Position(lineIndex, span.end)
                )
            );
        }
    }

    return ranges;
}
