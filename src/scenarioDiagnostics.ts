import * as vscode from 'vscode';
import * as path from 'path';
import { DriveHoverProvider } from './hoverProvider';
import { PhaseSwitcherProvider } from './phaseSwitcher';
import { TestInfo } from './types';
import { isScenarioYamlFile } from './yamlValidator';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';
import { getScenarioCallKeyword, getScenarioLanguageForDocument } from './gherkinLanguage';
import { parseBlockKeyword } from './blockKeywordParser';
import { getScenarioScanRootPath } from './scenarioScanRoot';
import { resolveScenarioByName, type ScenarioCatalog } from './scenarioCatalog';
import {
    createDocumentValidationCancellation,
    getScenarioValidationOptions,
    type ScenarioValidationOptions as ValidationOptions
} from './scenarioValidationPolicy';
import { calculateLevenshteinSimilarity } from './stringSimilarity';

const DIAGNOSTIC_SOURCE = 'KOT for 1C';
const CODE_UNCLOSED_IF = 'kotTestToolkit.unclosedIf';
const CODE_UNCLOSED_DO = 'kotTestToolkit.unclosedDo';
const CODE_UNCLOSED_TRY = 'kotTestToolkit.unclosedTry';
const CODE_UNCLOSED_QUOTE = 'kotTestToolkit.unclosedQuote';
const CODE_UNKNOWN_STEP = 'kotTestToolkit.unknownStep';
const CODE_UNKNOWN_SCENARIO = 'kotTestToolkit.unknownScenario';
const CODE_AMBIGUOUS_SCENARIO = 'kotTestToolkit.ambiguousScenario';
const CODE_EXTRA_SCENARIO_PARAM = 'kotTestToolkit.extraScenarioParameter';
const CODE_MISSING_SCENARIO_PARAM = 'kotTestToolkit.missingScenarioParameter';
const CODE_MISSING_QUOTES = 'kotTestToolkit.missingQuotes';
const CODE_INCOMPLETE_BLOCK = 'kotTestToolkit.incompleteBlock';
const CODE_DEFAULT_DESCRIPTION = 'kotTestToolkit.defaultDescription';
const CODE_DUPLICATE_SCENARIO_CODE = 'kotTestToolkit.duplicateScenarioCode';
const LOCAL_DEPENDENCY_SCAN_MAX_FILES = 120;

interface WorkspaceDiagnosticsScanOptions {
    refreshCache?: boolean;
}

const FULL_VALIDATION_OPTIONS = getScenarioValidationOptions('full');
const GLOBAL_VALIDATION_OPTIONS = getScenarioValidationOptions('global');
const CHANGE_VALIDATION_OPTIONS = getScenarioValidationOptions('change');
const SAVE_VALIDATION_OPTIONS = getScenarioValidationOptions('save');
const RELATED_VALIDATION_OPTIONS = getScenarioValidationOptions('related');

const GLOBAL_SCAN_YIELD_EVERY = 20;
const LOCAL_DEPENDENCY_SCAN_YIELD_EVERY = 10;

interface ScenarioBodyRange {
    startLine: number;
    endLine: number;
}

interface ScenarioCallParameter {
    line: number;
    name: string;
    value: string;
}

interface ScenarioCallBlock {
    line: number;
    keyword: string;
    name: string;
    parameters: ScenarioCallParameter[];
}

interface MissingParameterInsertion {
    position: vscode.Position;
    text: string;
}

interface DiagnosticMessages {
    fixAll: string;
    unknownStep: string;
    unknownScenario: string;
    ambiguousScenario: string;
    maybeDidYouMeanHeader: string;
    extraScenarioParameter: string;
    missingScenarioParameters: string;
    paramValueShouldBeQuoted: string;
    sectionIncomplete: string;
    unmatchedIf: string;
    extraEndIf: string;
    unmatchedDo: string;
    extraEndDo: string;
    unmatchedTry: string;
    extraEndTry: string;
    unmatchedQuote: string;
    missingQuotesLikely: string;
    defaultDescription: string;
    duplicateScenarioCode: string;
}

function buildMessages(): DiagnosticMessages {
    return {
        fixAll: vscode.l10n.t('KOT - Fix scenario issues'),
        unknownStep: vscode.l10n.t('Unknown Gherkin step.'),
        unknownScenario: vscode.l10n.t('Unknown nested scenario call.'),
        ambiguousScenario: vscode.l10n.t('Scenario name resolves to multiple files:'),
        maybeDidYouMeanHeader: vscode.l10n.t('Maybe you meant:'),
        extraScenarioParameter: vscode.l10n.t('Extra parameter for called scenario: {0}.'),
        missingScenarioParameters: vscode.l10n.t('Missing parameters for called scenario:'),
        paramValueShouldBeQuoted: vscode.l10n.t('Parameter value should be in quotes or square brackets ([Parameter]).'),
        sectionIncomplete: vscode.l10n.t('Section is incomplete and can be auto-filled.'),
        unmatchedIf: vscode.l10n.t('If block is not closed with EndIf.'),
        extraEndIf: vscode.l10n.t('EndIf without matching If.'),
        unmatchedDo: vscode.l10n.t('Do block is not closed with EndDo.'),
        extraEndDo: vscode.l10n.t('EndDo without matching Do.'),
        unmatchedTry: vscode.l10n.t('Try block is not closed with EndTry.'),
        extraEndTry: vscode.l10n.t('EndTry without matching Try.'),
        unmatchedQuote: vscode.l10n.t('Unclosed double quote in line.'),
        missingQuotesLikely: vscode.l10n.t('Likely missing quotes in step/call arguments.'),
        defaultDescription: vscode.l10n.t('Scenario description is empty.'),
        duplicateScenarioCode: vscode.l10n.t('Duplicate scenario code "{0}" found in other scenarios:')
    };
}

function getLineDiagnosticRange(document: vscode.TextDocument, line: number): vscode.Range {
    const lineText = document.lineAt(line);
    const startCharacter = lineText.firstNonWhitespaceCharacterIndex;
    const endCharacter = lineText.range.end.character;
    return new vscode.Range(line, startCharacter, line, endCharacter);
}

function createDiagnostic(
    document: vscode.TextDocument,
    line: number,
    message: string,
    severity: vscode.DiagnosticSeverity,
    code: string
): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(
        getLineDiagnosticRange(document, line),
        message,
        severity
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = code;
    return diagnostic;
}

function getScenarioBodyRange(document: vscode.TextDocument): ScenarioBodyRange | null {
    let startLine = -1;
    for (let i = 0; i < document.lineCount; i++) {
        if (/^\s*ТекстСценария:\s*\|?\s*$/.test(document.lineAt(i).text)) {
            startLine = i + 1;
            break;
        }
    }
    if (startLine === -1) {
        return null;
    }

    let endLine = document.lineCount - 1;
    for (let i = startLine; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        if (/^(?!\s|#)[А-Яа-яЁёA-Za-z0-9_]+:\s*/.test(text)) {
            endLine = i - 1;
            break;
        }
    }

    if (endLine < startLine) {
        endLine = startLine;
    }
    return { startLine, endLine };
}

function parseScenarioCallBlocks(document: vscode.TextDocument, bodyRange: ScenarioBodyRange): ScenarioCallBlock[] {
    const blocks: ScenarioCallBlock[] = [];
    const callRegex = /^(\s*)(And|И|Допустим)\s+(.+)$/i;
    const assignmentRegex = /^(\s*)([A-Za-zА-Яа-яЁё0-9_-]+)\s*=\s*(.*)$/;

    for (let i = bodyRange.startLine; i <= bodyRange.endLine; i++) {
        const text = document.lineAt(i).text;
        const callMatch = text.match(callRegex);
        if (!callMatch) {
            continue;
        }

        const name = callMatch[3].trim();
        if (!name || name.includes('"')) {
            continue;
        }

        const block: ScenarioCallBlock = {
            line: i,
            keyword: callMatch[2],
            name,
            parameters: []
        };

        let j = i + 1;
        while (j <= bodyRange.endLine) {
            const nextLine = document.lineAt(j).text;
            const trimmed = nextLine.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                break;
            }

            const assignmentMatch = nextLine.match(assignmentRegex);
            if (!assignmentMatch) {
                break;
            }

            block.parameters.push({
                line: j,
                name: assignmentMatch[2],
                value: assignmentMatch[3]
            });
            j++;
        }

        blocks.push(block);
        if (j > i + 1) {
            i = j - 1;
        }
    }

    return blocks;
}

function getScenarioCallBlockByLine(
    document: vscode.TextDocument,
    line: number
): ScenarioCallBlock | null {
    const bodyRange = getScenarioBodyRange(document);
    if (!bodyRange) {
        return null;
    }

    const blocks = parseScenarioCallBlocks(document, bodyRange);
    return blocks.find(block => block.line === line) || null;
}

function parseNestedSectionNames(documentText: string): Set<string> {
    const names = new Set<string>();
    const sectionRegex = /ВложенныеСценарии:\s*([\s\S]*?)(?=\n(?![ \t])[А-Яа-яЁёA-Za-z]+:|\n*$)/;
    const match = sectionRegex.exec(documentText);
    if (!match || !match[1]) {
        return names;
    }

    const nameRegex = /^\s*ИмяСценария:\s*"([^"]+)"/gm;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRegex.exec(match[1])) !== null) {
        names.add(nameMatch[1]);
    }
    return names;
}

function parseDefinedScenarioParameters(documentText: string): Set<string> {
    const names = new Set<string>();
    const sectionRegex = /ПараметрыСценария:\s*([\s\S]*?)(?=\n(?![ \t])[А-Яа-яЁёA-Za-z]+:|\n*$)/;
    const match = sectionRegex.exec(documentText);
    if (!match || !match[1]) {
        return names;
    }

    const nameRegex = /^\s*Имя:\s*"([^"]+)"/gm;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRegex.exec(match[1])) !== null) {
        names.add(nameMatch[1]);
    }
    return names;
}

interface KotDescriptionState {
    line: number;
    isDefault: boolean;
}

function parseInlineYamlScalar(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (!trimmed) {
        return '';
    }

    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    }

    if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
        return trimmed.slice(1, -1).replace(/''/g, '\'');
    }

    return trimmed;
}

function getNormalizedIndent(lineText: string): number {
    const normalized = lineText.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
    return /^\s*/.exec(normalized)?.[0].length ?? 0;
}

function getKotDescriptionState(document: vscode.TextDocument): KotDescriptionState | null {
    let metadataStartLine = -1;
    for (let line = 0; line < document.lineCount; line++) {
        const lineText = document.lineAt(line).text;
        if (lineText.trim() === 'KOTМетаданные:' && /^\s*/.exec(lineText)?.[0].length === 0) {
            metadataStartLine = line;
            break;
        }
    }
    if (metadataStartLine === -1) {
        return null;
    }

    let metadataEndLine = document.lineCount;
    for (let line = metadataStartLine + 1; line < document.lineCount; line++) {
        const lineText = document.lineAt(line).text;
        if (/^(?!\s|#)[А-Яа-яЁёA-Za-z0-9_]+:\s*/.test(lineText)) {
            metadataEndLine = line;
            break;
        }
    }

    for (let line = metadataStartLine + 1; line < metadataEndLine; line++) {
        const lineText = document.lineAt(line).text;
        const trimmed = lineText.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const match = trimmed.match(/^Описание:\s*(.*)$/);
        if (!match) {
            continue;
        }

        const rawValue = (match[1] || '').trim();
        const descriptionIndent = getNormalizedIndent(lineText);
        const descriptionContentIndent = descriptionIndent + 4;

        if (rawValue.startsWith('|') || rawValue.startsWith('>')) {
            let hasNonEmptyContent = false;
            for (let bodyLine = line + 1; bodyLine < metadataEndLine; bodyLine++) {
                const bodyText = document.lineAt(bodyLine).text;
                const bodyTrimmed = bodyText.trim();
                const bodyIndent = getNormalizedIndent(bodyText);

                if (bodyTrimmed.length > 0 && bodyIndent <= descriptionIndent) {
                    break;
                }
                if (bodyTrimmed.length > 0 && bodyIndent < descriptionContentIndent) {
                    break;
                }
                if (bodyTrimmed.length === 0) {
                    continue;
                }

                const normalizedBodyText = bodyText.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
                const content = normalizedBodyText
                    .slice(Math.min(normalizedBodyText.length, descriptionContentIndent))
                    .trim();
                if (content.length > 0 && content !== '-') {
                    hasNonEmptyContent = true;
                    break;
                }
            }

            return {
                line,
                isDefault: !hasNonEmptyContent
            };
        }

        const inlineValue = parseInlineYamlScalar(rawValue);
        return {
            line,
            isDefault: inlineValue.trim().length === 0
        };
    }

    return null;
}

function parseScenarioNameFromDocument(document: vscode.TextDocument): string | null {
    const nameRegex = /^\s*Имя:\s*"([^"]+)"/;
    for (let line = 0; line < document.lineCount; line++) {
        const match = document.lineAt(line).text.match(nameRegex);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    return null;
}

function parseUsedParametersFromScenarioText(
    document: vscode.TextDocument,
    bodyRange: ScenarioBodyRange
): Set<string> {
    const used = new Set<string>();

    const regex = /(?<!\\)\[([A-Za-zА-Яа-яЁё0-9_-]+)(?<!\\)\]/g;
    for (let i = bodyRange.startLine; i <= bodyRange.endLine; i++) {
        const text = document.lineAt(i).text;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const name = match[1].trim();
            if (name) {
                used.add(name);
            }
        }
    }
    return used;
}

function getScenarioCallNames(blocks: ScenarioCallBlock[]): Set<string> {
    const names = new Set<string>();
    blocks.forEach(block => names.add(block.name));
    return names;
}

function buildMissingParameterInsertion(
    document: vscode.TextDocument,
    callBlock: ScenarioCallBlock,
    missingParameters: string[],
    calledScenarioDefaults: Record<string, string> | undefined,
    localScenarioParameterDefaults: Map<string, string>
): MissingParameterInsertion | null {
    if (!missingParameters.length) {
        return null;
    }

    const callLineText = document.lineAt(callBlock.line).text;
    const callIndent = callLineText.match(/^(\s*)/)?.[1] || '';
    const defaultParamIndent = `${callIndent}    `;

    const firstParamIndent = callBlock.parameters.length > 0
        ? (document.lineAt(callBlock.parameters[0].line).text.match(/^(\s*)/)?.[1] || '')
        : '';
    const existingParamIndent = firstParamIndent.length > callIndent.length
        ? firstParamIndent
        : defaultParamIndent;

    const allNames = [...callBlock.parameters.map(param => param.name), ...missingParameters];
    const maxNameLength = allNames.reduce((max, name) => Math.max(max, name.length), 0);

    const lines = missingParameters.map(paramName => {
        const defaultValue =
            calledScenarioDefaults?.[paramName] ??
            localScenarioParameterDefaults.get(paramName) ??
            `"${paramName}"`;
        return `${existingParamIndent}${paramName.padEnd(maxNameLength, ' ')} = ${defaultValue}`;
    });

    const insertionLine = callBlock.parameters.length > 0
        ? callBlock.parameters[callBlock.parameters.length - 1].line
        : callBlock.line;

    const insertionPosition = document.lineAt(insertionLine).range.end;

    return {
        position: insertionPosition,
        text: `\n${lines.join('\n')}`
    };
}

function findClosestStrings(input: string, candidates: string[], max: number): string[] {
    const normalizedInput = input.trim().toLowerCase();
    if (!normalizedInput) {
        return [];
    }

    return candidates
        .map(candidate => {
            const normalizedCandidate = candidate.toLowerCase();
            const score = calculateLevenshteinSimilarity(normalizedInput, normalizedCandidate);
            return { candidate, score };
        })
        .filter(item => item.score >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, max))
        .map(item => item.candidate);
}

function getStringSimilarity(input: string, candidate: string): number {
    const normalizedInput = input.trim().toLowerCase();
    const normalizedCandidate = candidate.trim().toLowerCase();
    if (!normalizedInput || !normalizedCandidate) {
        return 0;
    }
    return calculateLevenshteinSimilarity(normalizedInput, normalizedCandidate);
}

function containsQuotedPlaceholderTemplate(text: string): boolean {
    return /"%\d+\s+[^"]*"|'%\d+\s+[^']*'/.test(text);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMissingQuotesMatcher(suggestion: string): RegExp | null {
    const placeholderRegex = /"%\d+\s+[^"]*"|'%\d+\s+[^']*'/g;
    let lastIndex = 0;
    let placeholdersCount = 0;
    let pattern = '^';
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(suggestion)) !== null) {
        const chunk = suggestion.slice(lastIndex, match.index);
        pattern += escapeRegExp(chunk);
        // Accept both quoted and unquoted argument forms.
        pattern += '(?:"([^"]+)"|\'([^\']+)\'|([^"\'\\r\\n]+?))';
        lastIndex = match.index + match[0].length;
        placeholdersCount++;
    }

    if (placeholdersCount === 0) {
        return null;
    }

    pattern += escapeRegExp(suggestion.slice(lastIndex));
    pattern += '$';
    return new RegExp(pattern, 'i');
}

function looksLikeMissingQuotes(line: string, suggestions: string[]): boolean {
    if (line.includes('"') || line.includes("'")) {
        return false;
    }

    const hasPlainSuggestions = suggestions.some(suggestion => !containsQuotedPlaceholderTemplate(suggestion));
    if (hasPlainSuggestions) {
        return false;
    }

    const trimmedLine = line.trim();
    for (const suggestion of suggestions) {
        const matcher = buildMissingQuotesMatcher(suggestion);
        if (!matcher) {
            continue;
        }

        const match = matcher.exec(trimmedLine);
        if (!match) {
            continue;
        }

        // Captures are grouped per placeholder:
        // 1) double-quoted value, 2) single-quoted value, 3) unquoted value.
        for (let groupIndex = 3; groupIndex < match.length; groupIndex += 3) {
            if ((match[groupIndex] || '').trim().length > 0) {
                return true;
            }
        }
    }

    return false;
}

function looksLikePotentialGherkinStep(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) {
        return false;
    }

    // Placeholders/quoted literals are much more common for step texts than for nested scenario names.
    if (/(\[[^\]]+\]|"[^"]*"|'[^']*')/.test(trimmed)) {
        return true;
    }

    // Common leading words for natural-language Gherkin steps.
    if (/^(I|Я|in|the|a|an|on|at|with|without|from|to|if|when|then|given|но|тогда|когда|если)\b/i.test(trimmed)) {
        return true;
    }

    // Common short imperative-style steps with numeric argument, e.g. "Delay 1".
    // Treating them as step-like prevents false "Unknown nested scenario call" in lightweight validation mode.
    if (/^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_-]*\s+\d+(?:[.,]\d+)?$/i.test(trimmed)) {
        return true;
    }

    return false;
}

function isQuotedValue(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
        return false;
    }
    return (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    );
}

function isBracketParameterValue(value: string): boolean {
    const trimmed = value.trim();
    return /^\[[A-Za-zА-Яа-яЁё0-9_-]+\]$/.test(trimmed);
}

function isValidScenarioParameterValue(value: string): boolean {
    return isQuotedValue(value) || isBracketParameterValue(value);
}

function extractQuotedLiterals(line: string): string[] {
    const literals: string[] = [];
    const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\[[A-Za-zА-Яа-яЁё0-9_-]+\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
        literals.push(match[0]);
    }
    return literals;
}

function extractNumericCandidates(line: string): string[] {
    const sanitized = line
        .replace(/^\s*(And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i, '')
        .replace(/"[^"]*"|'[^']*'|\[[^\]]+\]/g, ' ');
    const candidates = sanitized.match(/\b\d+(?:[.,]\d+)?\b/g);
    return candidates ? [...candidates] : [];
}

function applyStepSuggestionWithOriginalValues(originalLine: string, suggestion: string): string {
    const literals = extractQuotedLiterals(originalLine);
    const numericCandidates = extractNumericCandidates(originalLine);
    let literalIndex = 0;
    let numericIndex = 0;

    return suggestion.replace(/"%\d+\s+[^"]*"|'%\d+\s+[^']*'/g, (placeholder) => {
        if (literalIndex < literals.length) {
            return literals[literalIndex++];
        }
        if (numericIndex < numericCandidates.length) {
            const quote = placeholder.startsWith('\'') ? '\'' : '"';
            const value = numericCandidates[numericIndex++];
            return `${quote}${value}${quote}`;
        }
        return placeholder;
    });
}

function formatSuggestionListSuffix(messages: DiagnosticMessages, suggestions: string[]): string {
    if (!suggestions.length) {
        return '';
    }
    return `\n${messages.maybeDidYouMeanHeader}\n- ${suggestions.join('\n- ')}\n`;
}

function formatMultilineListMessage(header: string, items: string[]): string {
    if (!items.length) {
        return header;
    }
    return `${header}\n- ${items.join('\n- ')}\n`;
}

function normalizeScenarioCode(value: string | undefined): string {
    return (value || '').trim();
}

function shouldIgnoreScenarioCodeForDuplicateCheck(value: string): boolean {
    if (!value) {
        return true;
    }

    // Ignore obvious template placeholders.
    return /^Code_Placeholder$/i.test(value);
}

export class ScenarioDiagnosticsProvider implements vscode.CodeActionProvider, vscode.Disposable {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('kotTestToolkit');
    private readonly duplicateCodeDiagnostics = vscode.languages.createDiagnosticCollection('kotTestToolkitDuplicateCodes');
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly validationTimers = new Map<string, NodeJS.Timeout>();
    private readonly relatedValidationTimers = new Map<string, NodeJS.Timeout>();
    private dependencyGraphSource: ScenarioCatalog | null = null;
    private readonly scenarioNameByUri = new Map<string, string>();
    private readonly scenarioUrisByName = new Map<string, vscode.Uri[]>();
    private readonly callersByCalleeName = new Map<string, Set<string>>();
    private workspaceScanPromise: Promise<void> | null = null;
    private readonly messages = buildMessages();

    constructor(
        private readonly phaseSwitcherProvider: PhaseSwitcherProvider,
        private readonly hoverProvider: DriveHoverProvider
    ) {
        this.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(document => {
                const activeDocument = vscode.window.activeTextEditor?.document;
                if (!activeDocument || activeDocument.uri.toString() !== document.uri.toString()) {
                    return;
                }
                this.scheduleValidation(document, 120, SAVE_VALIDATION_OPTIONS);
            }),
            vscode.workspace.onDidChangeTextDocument(event => this.scheduleValidation(event.document, 450, CHANGE_VALIDATION_OPTIONS)),
            vscode.workspace.onDidSaveTextDocument(document => {
                this.scheduleValidation(document, 50, SAVE_VALIDATION_OPTIONS);
                this.scheduleRelatedValidation(document);
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                const document = editor?.document;
                if (!document) {
                    return;
                }
                this.scheduleValidation(document, 120, SAVE_VALIDATION_OPTIONS);
                this.scheduleRelatedValidation(document);
            }),
            vscode.workspace.onDidDeleteFiles(event => {
                this.resetDependencyGraph();
                event.files.forEach(uri => {
                    this.diagnostics.delete(uri);
                    this.duplicateCodeDiagnostics.delete(uri);
                });
            }),
            vscode.workspace.onDidRenameFiles(event => {
                this.resetDependencyGraph();
                event.files.forEach(({ oldUri }) => {
                    this.diagnostics.delete(oldUri);
                    this.duplicateCodeDiagnostics.delete(oldUri);
                });
            }),
            this.phaseSwitcherProvider.onDidUpdateScenarioCatalog(() => {
                this.resetDependencyGraph();
                this.rebuildDuplicateScenarioCodeDiagnosticsFromCache();
                const activeDocument = vscode.window.activeTextEditor?.document;
                if (activeDocument) {
                    this.scheduleValidation(activeDocument, 150, CHANGE_VALIDATION_OPTIONS);
                }
            })
        );

        this.rebuildDuplicateScenarioCodeDiagnosticsFromCache();
        const activeDocument = vscode.window.activeTextEditor?.document;
        if (activeDocument) {
            this.scheduleValidation(activeDocument, 0, CHANGE_VALIDATION_OPTIONS);
            this.scheduleRelatedValidation(activeDocument, 350);
        }
    }

    public async scanWorkspaceDiagnostics(options: WorkspaceDiagnosticsScanOptions = {}): Promise<void> {
        if (this.workspaceScanPromise) {
            await this.workspaceScanPromise;
            return;
        }

        const refreshCache = options.refreshCache ?? true;
        this.workspaceScanPromise = this.runWorkspaceDiagnosticsScan(refreshCache).finally(() => {
            this.workspaceScanPromise = null;
        });

        await this.workspaceScanPromise;
    }

    public dispose(): void {
        for (const timer of this.validationTimers.values()) {
            clearTimeout(timer);
        }
        this.validationTimers.clear();
        for (const timer of this.relatedValidationTimers.values()) {
            clearTimeout(timer);
        }
        this.relatedValidationTimers.clear();
        this.resetDependencyGraph();
        this.diagnostics.dispose();
        this.duplicateCodeDiagnostics.dispose();
        this.subscriptions.forEach(subscription => subscription.dispose());
    }

    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    public async provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[]> {
        if (!isScenarioYamlFile(document)) {
            return [];
        }

        const shouldCancel = createDocumentValidationCancellation(document, token);

        const actions: vscode.CodeAction[] = [];
        const localScenarioParameterDefaults = parseScenarioParameterDefaults(document.getText());
        const scenarioLanguage = getScenarioLanguageForDocument(document);
        const scenarioCallKeyword = getScenarioCallKeyword(scenarioLanguage);
        const hasFixableDiagnostic = context.diagnostics.some(diagnostic =>
            diagnostic.source === DIAGNOSTIC_SOURCE &&
            typeof diagnostic.code === 'string' &&
            [
                CODE_UNKNOWN_STEP,
                CODE_UNKNOWN_SCENARIO,
                CODE_EXTRA_SCENARIO_PARAM,
                CODE_MISSING_SCENARIO_PARAM,
                CODE_MISSING_QUOTES,
                CODE_INCOMPLETE_BLOCK,
                CODE_UNCLOSED_IF,
                CODE_UNCLOSED_DO,
                CODE_UNCLOSED_TRY,
                CODE_UNCLOSED_QUOTE
            ].includes(diagnostic.code)
        );

        if (hasFixableDiagnostic) {
            const fixAllAction = new vscode.CodeAction(this.messages.fixAll, vscode.CodeActionKind.QuickFix);
            fixAllAction.command = {
                command: 'kotTestToolkit.fixScenarioIssues',
                title: this.messages.fixAll,
                arguments: [document.uri]
            };
            actions.push(fixAllAction);
        }

        for (const diagnostic of context.diagnostics) {
            if (shouldCancel()) {
                return [];
            }
            if (diagnostic.source !== DIAGNOSTIC_SOURCE || typeof diagnostic.code !== 'string') {
                continue;
            }

            if (diagnostic.code === CODE_UNKNOWN_STEP) {
                const lineText = document.lineAt(diagnostic.range.start.line).text.trim();
                const suggestions = await this.hoverProvider.getStepSuggestions(
                    document.uri,
                    lineText,
                    3,
                    shouldCancel
                );
                if (shouldCancel()) {
                    return [];
                }
                const indent = document.lineAt(diagnostic.range.start.line).text.match(/^\s*/)?.[0] || '';
                const replacementVariants = new Set<string>();
                for (const suggestion of suggestions) {
                    replacementVariants.add(
                        applyStepSuggestionWithOriginalValues(lineText, suggestion)
                    );
                }
                for (const replacementLine of replacementVariants) {
                    const action = new vscode.CodeAction(
                        vscode.l10n.t('Replace with: {0}', replacementLine),
                        vscode.CodeActionKind.QuickFix
                    );
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(
                        document.uri,
                        document.lineAt(diagnostic.range.start.line).range,
                        `${indent}${replacementLine}`
                    );
                    action.diagnostics = [diagnostic];
                    actions.push(action);
                }
            }

            if (diagnostic.code === CODE_UNKNOWN_SCENARIO) {
                const lineText = document.lineAt(diagnostic.range.start.line).text;
                const match = lineText.match(/^(\s*)(And|И|Допустим)\s+(.+)$/i);
                if (!match) {
                    continue;
                }
                const indent = match[1];
                const unknownName = match[3].trim();
                const catalog = this.phaseSwitcherProvider.getScenarioCatalog();
                const suggestions = findClosestStrings(unknownName, Array.from(catalog?.byName.keys() || []), 3);
                for (const suggestion of suggestions) {
                    const action = new vscode.CodeAction(
                        vscode.l10n.t('Replace with: {0}', suggestion),
                        vscode.CodeActionKind.QuickFix
                    );
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(
                        document.uri,
                        document.lineAt(diagnostic.range.start.line).range,
                        `${indent}${scenarioCallKeyword} ${suggestion}`
                    );
                    action.diagnostics = [diagnostic];
                    actions.push(action);
                }
            }

            if (diagnostic.code === CODE_MISSING_SCENARIO_PARAM) {
                const callBlock = getScenarioCallBlockByLine(document, diagnostic.range.start.line);
                if (!callBlock) {
                    continue;
                }

                const catalog = this.phaseSwitcherProvider.getScenarioCatalog();
                const resolution = catalog ? resolveScenarioByName(catalog, callBlock.name) : null;
                const scenarioInfo = resolution?.kind === 'unique' ? resolution.scenario : null;
                if (!scenarioInfo?.parameters || scenarioInfo.parameters.length === 0) {
                    continue;
                }

                const expectedParams = new Set(scenarioInfo.parameters.map(param => param.trim()).filter(Boolean));
                const actualParams = new Set(callBlock.parameters.map(param => param.name));
                const missingParams = Array.from(expectedParams).filter(param => !actualParams.has(param));
                if (missingParams.length === 0) {
                    continue;
                }

                const insertion = buildMissingParameterInsertion(
                    document,
                    callBlock,
                    missingParams,
                    scenarioInfo.parameterDefaults,
                    localScenarioParameterDefaults
                );
                if (!insertion) {
                    continue;
                }

                const addAllAction = new vscode.CodeAction(
                    vscode.l10n.t('Add missing parameters: {0}', missingParams.join(', ')),
                    vscode.CodeActionKind.QuickFix
                );
                addAllAction.edit = new vscode.WorkspaceEdit();
                addAllAction.edit.insert(document.uri, insertion.position, insertion.text);
                addAllAction.diagnostics = [diagnostic];
                actions.push(addAllAction);

                for (const missingParam of missingParams) {
                    const singleInsertion = buildMissingParameterInsertion(
                        document,
                        callBlock,
                        [missingParam],
                        scenarioInfo.parameterDefaults,
                        localScenarioParameterDefaults
                    );
                    if (!singleInsertion) {
                        continue;
                    }

                    const addSingleAction = new vscode.CodeAction(
                        vscode.l10n.t('Add parameter: {0}', missingParam),
                        vscode.CodeActionKind.QuickFix
                    );
                    addSingleAction.edit = new vscode.WorkspaceEdit();
                    addSingleAction.edit.insert(document.uri, singleInsertion.position, singleInsertion.text);
                    addSingleAction.diagnostics = [diagnostic];
                    actions.push(addSingleAction);
                }
            }
        }

        return shouldCancel() ? [] : actions;
    }

    private scheduleValidation(
        document: vscode.TextDocument,
        delayMs: number = 350,
        options: ValidationOptions = FULL_VALIDATION_OPTIONS
    ): void {
        if (!document || document.isUntitled) {
            return;
        }
        const key = document.uri.toString();
        const existing = this.validationTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.validationTimers.delete(key);
            this.validateDocument(
                document,
                options,
                createDocumentValidationCancellation(document)
            ).catch(error => {
                console.error('[ScenarioDiagnostics] Validation failed:', error);
            });
        }, delayMs);
        this.validationTimers.set(key, timer);
    }

    private scheduleRelatedValidation(document: vscode.TextDocument, delayMs: number = 700): void {
        if (!document || document.isUntitled || document.uri.scheme !== 'file') {
            return;
        }
        if (!this.isRelatedParentValidationEnabled()) {
            return;
        }

        const key = `${document.uri.toString()}:related`;
        const existing = this.relatedValidationTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.relatedValidationTimers.delete(key);
            this.validateRelatedDocuments(document, RELATED_VALIDATION_OPTIONS).catch(error => {
                console.error('[ScenarioDiagnostics] Related validation failed:', error);
            });
        }, delayMs);
        this.relatedValidationTimers.set(key, timer);
    }

    private isRelatedParentValidationEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        return config.get<boolean>('editor.checkRelatedParentScenarios', true);
    }

    private rebuildDuplicateScenarioCodeDiagnosticsFromCache(): void {
        const catalog = this.phaseSwitcherProvider.getScenarioCatalog();
        this.duplicateCodeDiagnostics.clear();
        if (!catalog || catalog.all.length === 0) {
            return;
        }

        const scenariosByCode = new Map<string, TestInfo[]>();
        for (const testInfo of catalog.all) {
            const scenarioCode = normalizeScenarioCode(testInfo.scenarioCode);
            if (shouldIgnoreScenarioCodeForDuplicateCheck(scenarioCode)) {
                continue;
            }

            const bucket = scenariosByCode.get(scenarioCode) || [];
            bucket.push(testInfo);
            scenariosByCode.set(scenarioCode, bucket);
        }

        const diagnosticsByUri = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
        for (const [scenarioCode, scenarios] of scenariosByCode.entries()) {
            if (scenarios.length < 2) {
                continue;
            }

            for (const scenario of scenarios) {
                const others = scenarios
                    .filter(item => item.yamlFileUri.toString() !== scenario.yamlFileUri.toString())
                    .map(item => `${item.name} — ${item.relativePath || item.yamlFileUri.fsPath}`)
                    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));

                if (others.length === 0) {
                    continue;
                }

                const line = Math.max(0, scenario.scenarioCodeLine ?? 0);
                const endCharacter = Math.max(
                    1,
                    scenario.scenarioCodeLineEndCharacter
                        ?? ((scenario.scenarioCodeLineStartCharacter ?? 0) + 1)
                );
                const duplicateDiagnostic = new vscode.Diagnostic(
                    new vscode.Range(line, 4, line, endCharacter),
                    formatMultilineListMessage(
                        this.messages.duplicateScenarioCode.replace('{0}', scenarioCode),
                        others
                    ),
                    vscode.DiagnosticSeverity.Warning
                );
                duplicateDiagnostic.source = DIAGNOSTIC_SOURCE;
                duplicateDiagnostic.code = CODE_DUPLICATE_SCENARIO_CODE;

                const uriKey = scenario.yamlFileUri.toString();
                const entry = diagnosticsByUri.get(uriKey) || { uri: scenario.yamlFileUri, diagnostics: [] };
                entry.diagnostics.push(duplicateDiagnostic);
                diagnosticsByUri.set(uriKey, entry);
            }
        }

        for (const { uri, diagnostics } of diagnosticsByUri.values()) {
            this.duplicateCodeDiagnostics.set(uri, diagnostics);
        }
    }

    private resetDependencyGraph(): void {
        this.dependencyGraphSource = null;
        this.scenarioNameByUri.clear();
        this.scenarioUrisByName.clear();
        this.callersByCalleeName.clear();
    }

    private rebuildDependencyGraphFromCacheIfNeeded(): void {
        const catalog = this.phaseSwitcherProvider.getScenarioCatalog();
        if (catalog === this.dependencyGraphSource) {
            return;
        }

        this.resetDependencyGraph();
        this.dependencyGraphSource = catalog;
        if (!catalog) {
            return;
        }

        for (const testInfo of catalog.all) {
            const normalizedName = testInfo.name.trim();
            if (!normalizedName) {
                continue;
            }

            this.scenarioNameByUri.set(testInfo.yamlFileUri.toString(), normalizedName);
            const uris = this.scenarioUrisByName.get(normalizedName) || [];
            uris.push(testInfo.yamlFileUri);
            this.scenarioUrisByName.set(normalizedName, uris);
        }

        for (const testInfo of catalog.all) {
            const callerName = testInfo.name.trim();
            if (!callerName) {
                continue;
            }

            const calledNames = testInfo.nestedScenarioNames || [];
            for (const calledNameRaw of calledNames) {
                const calledName = calledNameRaw.trim();
                if (!calledName) {
                    continue;
                }

                if (resolveScenarioByName(catalog, calledName).kind !== 'unique') {
                    continue;
                }

                const callers = this.callersByCalleeName.get(calledName) || new Set<string>();
                callers.add(callerName);
                this.callersByCalleeName.set(calledName, callers);
            }
        }
    }

    private resolveScenarioName(document: vscode.TextDocument): string | null {
        const parsedName = parseScenarioNameFromDocument(document);
        if (parsedName) {
            return parsedName;
        }
        return this.scenarioNameByUri.get(document.uri.toString()) || null;
    }

    private getRelatedScenarioUris(sourceDocument: vscode.TextDocument, maxFiles: number): vscode.Uri[] {
        if (sourceDocument.uri.scheme !== 'file' || maxFiles <= 0) {
            return [];
        }

        this.rebuildDependencyGraphFromCacheIfNeeded();
        const sourceScenarioName = this.resolveScenarioName(sourceDocument);
        if (!sourceScenarioName) {
            return [];
        }

        const sourceUriKey = sourceDocument.uri.toString();
        const relatedUris = new Map<string, vscode.Uri>();
        const queue: string[] = [sourceScenarioName];
        const visitedScenarioNames = new Set<string>(queue);

        while (queue.length > 0 && relatedUris.size < maxFiles) {
            const currentScenarioName = queue.shift()!;
            const callerNames = this.callersByCalleeName.get(currentScenarioName);
            if (!callerNames || callerNames.size === 0) {
                continue;
            }

            for (const callerName of callerNames) {
                if (relatedUris.size >= maxFiles) {
                    break;
                }
                if (!visitedScenarioNames.has(callerName)) {
                    visitedScenarioNames.add(callerName);
                    queue.push(callerName);
                }

                for (const callerUri of this.scenarioUrisByName.get(callerName) || []) {
                    const callerUriKey = callerUri.toString();
                    if (callerUriKey === sourceUriKey) {
                        continue;
                    }

                    relatedUris.set(callerUriKey, callerUri);
                    if (relatedUris.size >= maxFiles) {
                        break;
                    }
                }
            }
        }

        return Array.from(relatedUris.values()).sort((left, right) =>
            left.fsPath.localeCompare(right.fsPath, undefined, { sensitivity: 'base' })
        );
    }

    private async validateRelatedDocuments(
        sourceDocument: vscode.TextDocument,
        options: ValidationOptions = RELATED_VALIDATION_OPTIONS
    ): Promise<void> {
        const relatedUris = this.getRelatedScenarioUris(sourceDocument, LOCAL_DEPENDENCY_SCAN_MAX_FILES);
        for (let index = 0; index < relatedUris.length; index++) {
            const uri = relatedUris[index];
            try {
                const document = await vscode.workspace.openTextDocument(uri);
                await this.validateDocument(
                    document,
                    options,
                    createDocumentValidationCancellation(document)
                );
            } catch (error) {
                console.error(`[ScenarioDiagnostics] Failed to validate related scenario ${uri.fsPath}:`, error);
            }

            if ((index + 1) % LOCAL_DEPENDENCY_SCAN_YIELD_EVERY === 0) {
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        }
    }

    private async runWorkspaceDiagnosticsScan(refreshCache: boolean): Promise<void> {
        const workspaceScenarioUris = await this.getWorkspaceScenarioUris(refreshCache);
        if (workspaceScenarioUris.length === 0) {
            return;
        }

        const scopeUriSet = new Set(workspaceScenarioUris.map(uri => uri.toString()));
        this.diagnostics.forEach((uri, _diagnostics) => {
            if (uri.scheme === 'file' && !scopeUriSet.has(uri.toString())) {
                this.diagnostics.delete(uri);
            }
        });

        for (let index = 0; index < workspaceScenarioUris.length; index++) {
            const uri = workspaceScenarioUris[index];
            try {
                const document = await vscode.workspace.openTextDocument(uri);
                await this.validateDocument(
                    document,
                    GLOBAL_VALIDATION_OPTIONS,
                    createDocumentValidationCancellation(document)
                );
            } catch (error) {
                console.error(`[ScenarioDiagnostics] Failed to validate ${uri.fsPath}:`, error);
            }

            if ((index + 1) % GLOBAL_SCAN_YIELD_EVERY === 0) {
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        }
    }

    private async getWorkspaceScenarioUris(refreshCache: boolean): Promise<vscode.Uri[]> {
        let catalog: ScenarioCatalog | null = null;
        try {
            if (refreshCache) {
                catalog = await this.phaseSwitcherProvider.ensureFreshScenarioCatalog();
            } else {
                catalog = this.phaseSwitcherProvider.getScenarioCatalog()
                    || await this.phaseSwitcherProvider.ensureFreshScenarioCatalog();
            }
        } catch (error) {
            console.error('[ScenarioDiagnostics] Failed to prepare scenario cache for workspace scan:', error);
        }

        const cachedUris = catalog?.all.map(testInfo => testInfo.yamlFileUri) || [];
        if (cachedUris.length > 0) {
            return this.mergeWithOpenScenarioDocuments(cachedUris);
        }

        const discoveredUris = await this.scanScenarioUrisFromConfiguredDirectory();
        return this.mergeWithOpenScenarioDocuments(discoveredUris);
    }

    private async scanScenarioUrisFromConfiguredDirectory(): Promise<vscode.Uri[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }

        const configuredScanDirectory = getScenarioScanRootPath().trim();
        const scanDirectoryPath = path.isAbsolute(configuredScanDirectory)
            ? configuredScanDirectory
            : path.join(workspaceFolder.uri.fsPath, configuredScanDirectory);
        const scanDirectoryUri = vscode.Uri.file(scanDirectoryPath);

        let candidateUris: vscode.Uri[] = [];
        try {
            const yamlPattern = new vscode.RelativePattern(scanDirectoryUri, '**/*.yaml');
            candidateUris = await vscode.workspace.findFiles(yamlPattern, '**/node_modules/**');
        } catch (error) {
            console.error('[ScenarioDiagnostics] Failed to enumerate YAML files for workspace diagnostics scan:', error);
            return [];
        }

        const scenarioUris: vscode.Uri[] = [];
        for (const uri of candidateUris) {
            try {
                const document = await vscode.workspace.openTextDocument(uri);
                if (isScenarioYamlFile(document)) {
                    scenarioUris.push(uri);
                }
            } catch (error) {
                console.error(`[ScenarioDiagnostics] Failed to inspect file ${uri.fsPath}:`, error);
            }
        }
        return scenarioUris;
    }

    private mergeWithOpenScenarioDocuments(uris: vscode.Uri[]): vscode.Uri[] {
        const uniqueUris = new Map<string, vscode.Uri>();
        for (const uri of uris) {
            uniqueUris.set(uri.toString(), uri);
        }

        for (const document of vscode.workspace.textDocuments) {
            if (document.isUntitled || document.uri.scheme !== 'file') {
                continue;
            }
            if (isScenarioYamlFile(document)) {
                uniqueUris.set(document.uri.toString(), document.uri);
            }
        }

        return Array.from(uniqueUris.values()).sort((left, right) =>
            left.fsPath.localeCompare(right.fsPath, undefined, { sensitivity: 'base' })
        );
    }

    private async validateDocument(
        document: vscode.TextDocument,
        options: ValidationOptions = FULL_VALIDATION_OPTIONS,
        shouldCancel: () => boolean = () => false
    ): Promise<void> {
        if (shouldCancel()) {
            return;
        }
        if (!isScenarioYamlFile(document)) {
            this.diagnostics.delete(document.uri);
            return;
        }

        const bodyRange = getScenarioBodyRange(document);
        if (!bodyRange) {
            this.diagnostics.delete(document.uri);
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];
        const documentText = document.getText();
        const configuredLanguage = getScenarioLanguageForDocument(document);
        let scenarioCatalog: ScenarioCatalog | null = null;
        try {
            scenarioCatalog = await this.phaseSwitcherProvider.ensureFreshScenarioCatalog();
        } catch (error) {
            console.error('[ScenarioDiagnostics] Failed to load scenario catalog for validation:', error);
        }
        if (shouldCancel()) {
            return;
        }
        const hasScenarioCache = (scenarioCatalog?.byName.size || 0) > 0;
        const scenarioCallBlocks = parseScenarioCallBlocks(document, bodyRange);
        const validatedScenarioCallBlocks: ScenarioCallBlock[] = [];
        const scenarioCallLineSet = new Set<number>();
        const scenarioParamLineSet = new Set<number>();

        // If/EndIf, Do/EndDo, Try/EndTry + quotes checks
        const ifStack: number[] = [];
        const doStack: number[] = [];
        const tryStack: number[] = [];
        for (let line = bodyRange.startLine; line <= bodyRange.endLine; line++) {
            if (shouldCancel()) {
                return;
            }
            const text = document.lineAt(line).text;
            const blockKeyword = parseBlockKeyword(text);

            if (blockKeyword === 'EndIf') {
                if (ifStack.length === 0) {
                    diagnostics.push(createDiagnostic(document, line, this.messages.extraEndIf, vscode.DiagnosticSeverity.Error, CODE_UNCLOSED_IF));
                } else {
                    ifStack.pop();
                }
            }
            if (blockKeyword === 'If') {
                ifStack.push(line);
            }

            if (blockKeyword === 'EndDo') {
                if (doStack.length === 0) {
                    diagnostics.push(createDiagnostic(document, line, this.messages.extraEndDo, vscode.DiagnosticSeverity.Error, CODE_UNCLOSED_DO));
                } else {
                    doStack.pop();
                }
            }
            if (blockKeyword === 'Do') {
                doStack.push(line);
            }

            if (blockKeyword === 'EndTry') {
                if (tryStack.length === 0) {
                    diagnostics.push(createDiagnostic(document, line, this.messages.extraEndTry, vscode.DiagnosticSeverity.Error, CODE_UNCLOSED_TRY));
                } else {
                    tryStack.pop();
                }
            }
            if (blockKeyword === 'Try') {
                tryStack.push(line);
            }

            const quotes = text.match(/(?<!\\)"/g);
            if (quotes && quotes.length % 2 !== 0) {
                diagnostics.push(createDiagnostic(document, line, this.messages.unmatchedQuote, vscode.DiagnosticSeverity.Error, CODE_UNCLOSED_QUOTE));
            }
        }

        ifStack.forEach(line => {
            diagnostics.push(createDiagnostic(document, line, this.messages.unmatchedIf, vscode.DiagnosticSeverity.Error, CODE_UNCLOSED_IF));
        });
        doStack.forEach(line => {
            diagnostics.push(createDiagnostic(document, line, this.messages.unmatchedDo, vscode.DiagnosticSeverity.Error, CODE_UNCLOSED_DO));
        });
        tryStack.forEach(line => {
            diagnostics.push(createDiagnostic(document, line, this.messages.unmatchedTry, vscode.DiagnosticSeverity.Error, CODE_UNCLOSED_TRY));
        });

        // Scenario calls checks
        for (const block of scenarioCallBlocks) {
            const resolution = scenarioCatalog
                ? resolveScenarioByName(scenarioCatalog, block.name)
                : { kind: 'missing' as const, name: block.name };
            if (resolution.kind === 'ambiguous') {
                validatedScenarioCallBlocks.push(block);
                scenarioCallLineSet.add(block.line);
                block.parameters.forEach(param => scenarioParamLineSet.add(param.line));
                const diagnostic = createDiagnostic(
                    document,
                    block.line,
                    formatMultilineListMessage(
                        this.messages.ambiguousScenario,
                        resolution.scenarios.map(item => item.relativePath || item.yamlFileUri.fsPath)
                    ),
                    vscode.DiagnosticSeverity.Error,
                    CODE_AMBIGUOUS_SCENARIO
                );
                diagnostic.relatedInformation = resolution.scenarios.map(item => new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(item.yamlFileUri, new vscode.Position(0, 0)),
                    item.relativePath || item.yamlFileUri.fsPath
                ));
                diagnostics.push(diagnostic);
                continue;
            }
            const scenarioInfo = resolution.kind === 'unique' ? resolution.scenario : undefined;
            const lineText = document.lineAt(block.line).text.trim();
            const includeScenarioSuggestions = options.includeScenarioSuggestions ?? options.includeSuggestions;
            const includeStepSuggestions = options.includeStepSuggestions ?? options.includeSuggestions;
            const scenarioSuggestions = (!scenarioInfo && hasScenarioCache && includeScenarioSuggestions)
                ? findClosestStrings(block.name, Array.from(scenarioCatalog?.byName.keys() || []), 3)
                : [];
            const hasStrongScenarioNameMatch = scenarioSuggestions.length > 0
                && getStringSimilarity(block.name, scenarioSuggestions[0]) >= 0.85;

            // Disambiguate step-like "And ..." lines to avoid false "unknown nested scenario" diagnostics.
            if (!scenarioInfo && block.parameters.length === 0 && !hasStrongScenarioNameMatch) {
                const stepLikeSyntax = looksLikePotentialGherkinStep(block.name);

                if (options.includeStepChecks || stepLikeSyntax) {
                    const isKnownStep = await this.hoverProvider.isKnownStepLine(
                        document.uri,
                        lineText
                    );
                    if (isKnownStep) {
                        continue;
                    }
                }

                if (options.includeStepChecks && includeStepSuggestions) {
                    const stepHints = await this.hoverProvider.getStepSuggestions(
                        document.uri,
                        lineText,
                        1,
                        shouldCancel
                    );
                    if (shouldCancel()) {
                        return;
                    }
                    if (stepHints.length > 0) {
                        continue;
                    }
                } else if (stepLikeSyntax) {
                    // Lightweight pass without full step validation:
                    // if it looks like a step and isn't known, emit step diagnostic instead of unknown scenario.
                    if (!includeStepSuggestions) {
                        continue;
                    }
                    const stepHints = await this.hoverProvider.getStepSuggestions(
                        document.uri,
                        lineText,
                        3,
                        shouldCancel
                    );
                    if (shouldCancel()) {
                        return;
                    }
                    const likelyMissingQuotes = looksLikeMissingQuotes(lineText, stepHints);
                    const suggestions = stepHints.map(suggestion => applyStepSuggestionWithOriginalValues(lineText, suggestion));
                    const suffix = formatSuggestionListSuffix(this.messages, suggestions);

                    diagnostics.push(createDiagnostic(
                        document,
                        block.line,
                        likelyMissingQuotes
                            ? `${this.messages.missingQuotesLikely}${suffix}`
                            : `${this.messages.unknownStep}${suffix}`,
                        likelyMissingQuotes ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
                        CODE_UNKNOWN_STEP
                    ));
                    continue;
                }
            }

            const likelyStepPrefix = /^(Я|I|When|Then|Given|Если|Когда|Тогда|Но)\b/i.test(block.name);
            const isScenarioCall = !!scenarioInfo || block.parameters.length > 0 || !likelyStepPrefix || hasStrongScenarioNameMatch;
            if (!isScenarioCall) {
                continue;
            }

            validatedScenarioCallBlocks.push(block);
            scenarioCallLineSet.add(block.line);
            block.parameters.forEach(param => scenarioParamLineSet.add(param.line));

            if (!scenarioInfo) {
                if (!hasScenarioCache) {
                    for (const param of block.parameters) {
                        const trimmedValue = param.value.trim();
                        if (trimmedValue.length > 0 && !isValidScenarioParameterValue(trimmedValue)) {
                            diagnostics.push(createDiagnostic(
                                document,
                                param.line,
                                this.messages.paramValueShouldBeQuoted,
                                vscode.DiagnosticSeverity.Warning,
                                CODE_MISSING_QUOTES
                            ));
                        }
                    }
                    continue;
                }

                const suffix = formatSuggestionListSuffix(this.messages, scenarioSuggestions);
                diagnostics.push(createDiagnostic(
                    document,
                    block.line,
                    `${this.messages.unknownScenario}${suffix}`,
                    vscode.DiagnosticSeverity.Error,
                    CODE_UNKNOWN_SCENARIO
                ));
                continue;
            }

            const expectedParams = new Set((scenarioInfo.parameters || []).map(item => item.trim()).filter(Boolean));
            const actualParams = new Set(block.parameters.map(param => param.name));

            for (const param of block.parameters) {
                if (!expectedParams.has(param.name)) {
                    diagnostics.push(createDiagnostic(
                        document,
                        param.line,
                        this.messages.extraScenarioParameter.replace('{0}', param.name),
                        vscode.DiagnosticSeverity.Error,
                        CODE_EXTRA_SCENARIO_PARAM
                    ));
                }

                const trimmedValue = param.value.trim();
                if (trimmedValue.length > 0 && !isValidScenarioParameterValue(trimmedValue)) {
                    diagnostics.push(createDiagnostic(
                        document,
                        param.line,
                        this.messages.paramValueShouldBeQuoted,
                        vscode.DiagnosticSeverity.Warning,
                        CODE_MISSING_QUOTES
                    ));
                }
            }

            if (expectedParams.size > 0) {
                const missing = Array.from(expectedParams).filter(paramName => !actualParams.has(paramName));
                if (missing.length > 0) {
                    diagnostics.push(createDiagnostic(
                        document,
                        block.line,
                        formatMultilineListMessage(this.messages.missingScenarioParameters, missing),
                        vscode.DiagnosticSeverity.Warning,
                        CODE_MISSING_SCENARIO_PARAM
                    ));
                }
            }
        }

        // Unknown steps checks
        if (options.includeStepChecks) {
            const gherkinStepRegex = /^\s*(And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\b/i;
            for (let line = bodyRange.startLine; line <= bodyRange.endLine; line++) {
                if (shouldCancel()) {
                    return;
                }
                if (scenarioCallLineSet.has(line) || scenarioParamLineSet.has(line)) {
                    continue;
                }

                const rawText = document.lineAt(line).text;
                const trimmed = rawText.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed.startsWith('"""')) {
                    continue;
                }
                if (!gherkinStepRegex.test(trimmed)) {
                    continue;
                }

                const isKnown = await this.hoverProvider.isKnownStepLine(document.uri, trimmed);
                if (isKnown) {
                    continue;
                }

                const shouldIncludeStepSuggestions = options.includeStepSuggestions ?? options.includeSuggestions;
                const rawSuggestions = shouldIncludeStepSuggestions
                    ? await this.hoverProvider.getStepSuggestions(
                        document.uri,
                        trimmed,
                        3,
                        shouldCancel
                    )
                    : [];
                if (shouldCancel()) {
                    return;
                }
                const likelyMissingQuotes = shouldIncludeStepSuggestions && looksLikeMissingQuotes(trimmed, rawSuggestions);
                const suggestions = rawSuggestions.map(suggestion => applyStepSuggestionWithOriginalValues(trimmed, suggestion));
                const suffix = formatSuggestionListSuffix(this.messages, suggestions);

                diagnostics.push(createDiagnostic(
                    document,
                    line,
                    likelyMissingQuotes
                        ? `${this.messages.missingQuotesLikely}${suffix}`
                        : `${this.messages.unknownStep}${suffix}`,
                    likelyMissingQuotes ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
                    CODE_UNKNOWN_STEP
                ));
            }
        }

        // Incomplete sections checks
        const nestedFromCalls = getScenarioCallNames(validatedScenarioCallBlocks);
        const nestedFromSection = parseNestedSectionNames(documentText);
        const missingNested = Array.from(nestedFromCalls).filter(name => !nestedFromSection.has(name));
        if (hasScenarioCache && missingNested.length > 0) {
            const line = Math.max(0, bodyRange.startLine - 1);
            diagnostics.push(createDiagnostic(
                document,
                line,
                `${this.messages.sectionIncomplete} ${vscode.l10n.t('Missing NestedScenarios entries: {0}', missingNested.join(', '))}`,
                vscode.DiagnosticSeverity.Warning,
                CODE_INCOMPLETE_BLOCK
            ));
        }

        const usedParams = parseUsedParametersFromScenarioText(document, bodyRange);
        const definedParams = parseDefinedScenarioParameters(documentText);
        const missingDefinedParams = Array.from(usedParams).filter(name => !definedParams.has(name));
        if (missingDefinedParams.length > 0) {
            const line = Math.max(0, bodyRange.startLine - 1);
            diagnostics.push(createDiagnostic(
                document,
                line,
                `${this.messages.sectionIncomplete} ${vscode.l10n.t('Missing ScenarioParameters entries: {0}', missingDefinedParams.join(', '))}`,
                vscode.DiagnosticSeverity.Warning,
                CODE_INCOMPLETE_BLOCK
            ));
        }

        const kotDescriptionState = getKotDescriptionState(document);
        if (kotDescriptionState && kotDescriptionState.isDefault) {
            diagnostics.push(createDiagnostic(
                document,
                kotDescriptionState.line,
                this.messages.defaultDescription,
                vscode.DiagnosticSeverity.Warning,
                CODE_DEFAULT_DESCRIPTION
            ));
        }

        if (!shouldCancel()) {
            this.diagnostics.set(document.uri, diagnostics);
        }
    }
}
