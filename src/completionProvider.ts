import * as vscode from 'vscode';
import { parse } from 'node-html-parser';
import { getStepsHtml, forceRefreshSteps as forceRefreshStepsCore } from './stepsFetcher';
import { TestInfo } from './types';
import { getTranslator } from './localization';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';
import { ScenarioLanguage, getScenarioCallKeyword, getScenarioLanguageForDocument } from './gherkinLanguage';
import { YamlParametersManager } from './yamlParametersManager';
import { getBlockClosingKeyword, parseBlockKeyword } from './blockKeywordParser';
import { normalizeMultilineStepInsertText } from './gherkinTableUtils';
import { loadLiveFormExplorerSnapshot } from './formExplorerLiveSnapshot';
import {
    FormExplorerElementInfo,
    FormExplorerSnapshot,
} from './formExplorerTypes';

const VARIABLE_REFERENCE_PREFIX_REGEX = /^[A-Za-zА-Яа-яЁё0-9_]*$/;
const SCENARIO_BRACKET_PARAMETER_PREFIX_REGEX = /(^|[^\\])\[([A-Za-zА-Яа-яЁё0-9_-]*)$/;
const STEP_TEMPLATE_PLACEHOLDER_REGEX = /%(\d+)\s+([^"'\r\n]+)/g;
const SEMANTIC_STEP_PREFIX = '!';
const FORM_EXPLORER_INITIAL_SUGGEST_COMMAND = 'editor.action.triggerSuggest';
const FORM_EXPLORER_ADVANCE_ARGUMENT_COMMAND = 'kotTestToolkit.completion.advanceFormExplorerArgument';
const GHERKIN_KEYWORD_PREFIX_REGEX = /^(?:\*\s*)?(?:and|but|then|when|given|if|и|тогда|когда|если|допустим|к тому же|но)\s+/i;
const OPTIONAL_GHERKIN_PREFIX_FRAGMENT = String.raw`(?:(?:\*\s*)?(?:And|But|Then|When|Given|If|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?`;
const VARIABLE_ASSIGNMENT_VERB_FRAGMENT = String.raw`(?:save|store|remember|read|create|determine|define|generate|wait|execute|put|retrieve|get|copy|запоминаю|сохраняю|читаю|создаю|определяю|генерирую|ожидаю|выполняю|вставляю|получаю|копирую)`;
const OPTIONAL_TRAILING_ANNOTATION_FRAGMENT = String.raw`(?:\s+\([^)]*\))?\s*$`;
const SEMANTIC_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
    ['нажать', 'нажатие', 'нажатия', 'нажат', 'кликнуть', 'клик', 'щелкнуть', 'щелчок', 'click', 'clicking', 'press', 'pressing', 'tap'],
    ['кнопка', 'button'],
    ['окно', 'форма', 'window', 'form'],
    ['поле', 'реквизит', 'атрибут', 'field', 'attribute'],
    ['ввести', 'ввод', 'input', 'enter', 'type'],
    ['проверить', 'проверка', 'check', 'verify', 'assert'],
    ['открыть', 'открывается', 'open', 'opened'],
    ['закрыть', 'закрывается', 'close', 'closed'],
    ['выбрать', 'выбор', 'select', 'choose', 'pick'],
    ['таблица', 'список', 'table', 'list', 'grid'],
    ['команда', 'действие', 'command', 'action'],
    ['перейти', 'открыть', 'go', 'move', 'navigate'],
    ['сохранить', 'запомнить', 'save', 'store', 'remember'],
    ['значение', 'параметр', 'value', 'parameter', 'argument']
];
const SAVE_VARIABLE_STEP_REGEX_EN_VALUE_TO = /^\s*(?:(?:\*\s*)?(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?I\s+save\s+(.+?)\s+value\s+to\s+(?:"([^"]+)"|'([^']+)')\s+variable(?:\s+globally)?\s*$/i;
const SAVE_VARIABLE_STEP_REGEX_RU_VALUE_TO = /^\s*(?:(?:\*\s*)?(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?Я\s+запоминаю\s+в\s+переменную\s+(?:"([^"]+)"|'([^']+)')\s+значение\s+(.+?)\s*$/i;
const EXECUTE_AND_PUT_TO_VARIABLE_REGEX = /^\s*(?:(?:\*\s*)?(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?(?:I\s+execute\s+code\s+and\s+put\s+to\s+varible|Я\s+выполняю\s+код\s+и\s+вставляю\s+в\s+переменную)\s+(?:"([^"]+)"|'([^']+)')\s+(?:"([^"]+)"|'([^']+)')\s*$/i;
const VARIABLE_ASSIGNMENT_TO_THE_VARIABLE_REGEX = new RegExp(
    String.raw`^\s*${OPTIONAL_GHERKIN_PREFIX_FRAGMENT}.*\b${VARIABLE_ASSIGNMENT_VERB_FRAGMENT}\s+(.+?)\s+(?:to|into|in)\s+the\s+variable\s+(?:"([^"]+)"|'([^']+)')(?:\s+UI\s+Automation)?${OPTIONAL_TRAILING_ANNOTATION_FRAGMENT}`,
    'i'
);
const VARIABLE_ASSIGNMENT_TO_VARIABLE_REGEX = new RegExp(
    String.raw`^\s*${OPTIONAL_GHERKIN_PREFIX_FRAGMENT}.*\b${VARIABLE_ASSIGNMENT_VERB_FRAGMENT}\s+(.+?)\s*(?:to|in)\s+(?:the\s+)?(?:"([^"]+)"|'([^']+)')\s+variable(?:\s+globally)?${OPTIONAL_TRAILING_ANNOTATION_FRAGMENT}`,
    'i'
);
const VARIABLE_ASSIGNMENT_FIND_OR_CREATE_REGEX = new RegExp(
    String.raw`^\s*${OPTIONAL_GHERKIN_PREFIX_FRAGMENT}(?:I\s+find\s+or\s+create|И\s+я\s+нахожу\s+или\s+создаю)\s+(.+?)\s+(?:named|с\s+именем)\s+(?:"([^"]+)"|'([^']+)')(?:\s+.+?)?${OPTIONAL_TRAILING_ANNOTATION_FRAGMENT}`,
    'i'
);
const VARIABLE_ASSIGNMENT_COPY_REGEX = new RegExp(
    String.raw`^\s*${OPTIONAL_GHERKIN_PREFIX_FRAGMENT}(?:I\s+copy\s+the\s+variable|И\s+я\s+копирую\s+переменную)\s+(?:"([^"]+)"|'([^']+)')\s+(?:to|в)\s+(?:"([^"]+)"|'([^']+)')${OPTIONAL_TRAILING_ANNOTATION_FRAGMENT}`,
    'i'
);
const VARIABLE_ASSIGNMENT_AS_REGEX = new RegExp(
    String.raw`^\s*${OPTIONAL_GHERKIN_PREFIX_FRAGMENT}.*\b${VARIABLE_ASSIGNMENT_VERB_FRAGMENT}\s+(.+?)\s+(?:as|как)\s+(?:"([^"]+)"|'([^']+)')(?:\s+variable(?:\s+of\s+[^()]*)?)?(?:\s+(?:globally|глобально))?${OPTIONAL_TRAILING_ANNOTATION_FRAGMENT}`,
    'i'
);
const VARIABLE_ASSIGNMENT_INTO_RU_REGEX = new RegExp(
    String.raw`^\s*${OPTIONAL_GHERKIN_PREFIX_FRAGMENT}.*\b${VARIABLE_ASSIGNMENT_VERB_FRAGMENT}\s+(.+?)\s+в\s+переменную\s+(?:"([^"]+)"|'([^']+)')(?:\s+глобально)?(?:\s+UI\s+Automation)?${OPTIONAL_TRAILING_ANNOTATION_FRAGMENT}`,
    'i'
);
const VARIABLE_ASSIGNMENT_IN_SHORT_RU_REGEX = new RegExp(
    String.raw`^\s*${OPTIONAL_GHERKIN_PREFIX_FRAGMENT}.*\b${VARIABLE_ASSIGNMENT_VERB_FRAGMENT}\s+(.+?)\s+в\s+(?:"([^"]+)"|'([^']+)')${OPTIONAL_TRAILING_ANNOTATION_FRAGMENT}`,
    'i'
);

export type VariableCompletionMode = 'all' | 'globalOnly';
export type VariableCompletionSource = 'saved' | 'global';

export interface VariableReferenceContext {
    startCharacter: number;
    typedPrefix: string;
    mode: VariableCompletionMode;
}

export interface ScenarioBracketParameterContext {
    startCharacter: number;
    typedPrefix: string;
}

interface QuotedTextReferenceContext {
    value: string;
    beforeQuote: string;
    afterQuote: string;
    argumentIndex: number;
}

interface QuotedTextCompletionContext {
    startCharacter: number;
    endCharacter: number;
    typedPrefix: string;
    quoteCharacter: '"' | "'";
    argumentIndex: number;
    quotedValuesBefore: string[];
    quotedValuesAfter: string[];
    otherQuotedReferences: QuotedTextReferenceContext[];
    linePrefixBeforeQuote: string;
}

interface StepTemplateSnippetData {
    displayText: string;
    snippetText: string;
    hasPlaceholders: boolean;
}

interface FormExplorerElementCompletionCandidate {
    path: string;
    name: string;
    title: string;
    kind: string;
    valuePreview: string;
    boundAttributePath: string;
}

interface FormExplorerTableCompletionCandidate {
    path: string;
    name: string;
    title: string;
    columns: string[];
    rows: string[][];
}

export interface SavedVariableDefinition {
    name: string;
    value: string;
    source: VariableCompletionSource;
}

export interface VariableReferenceToken {
    name: string;
    source: VariableCompletionSource;
    startCharacter: number;
    endCharacter: number;
}

interface SavedVariableStepPattern {
    regex: RegExp;
    createDefinition: (match: RegExpMatchArray, source: VariableCompletionSource) => SavedVariableDefinition | null;
}

export function parseVariableReferenceContext(linePrefix: string): VariableReferenceContext | null {
    const match = linePrefix.match(/(\${1,2})([A-Za-zА-Яа-яЁё0-9_]*)$/);
    if (!match) {
        return null;
    }

    const prefixWithDollars = match[0];
    const dollarPrefix = match[1];
    const typedPrefix = match[2];
    const startCharacter = linePrefix.length - prefixWithDollars.length;

    if (startCharacter > 0 && linePrefix[startCharacter - 1] === '$') {
        return null;
    }

    if (!VARIABLE_REFERENCE_PREFIX_REGEX.test(typedPrefix)) {
        return null;
    }

    return {
        startCharacter,
        typedPrefix,
        mode: dollarPrefix === '$$' ? 'globalOnly' : 'all'
    };
}

export function parseScenarioBracketParameterContext(linePrefix: string): ScenarioBracketParameterContext | null {
    const match = linePrefix.match(SCENARIO_BRACKET_PARAMETER_PREFIX_REGEX);
    if (!match) {
        return null;
    }

    const typedPrefix = match[2] || '';
    const startCharacter = linePrefix.length - typedPrefix.length - 1;
    if (startCharacter < 0 || linePrefix[startCharacter] !== '[') {
        return null;
    }

    return {
        startCharacter,
        typedPrefix
    };
}

function escapeStepSnippetText(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\$/g, '\\$')
        .replace(/\}/g, '\\}');
}

function buildStepTemplateSnippetData(stepText: string): StepTemplateSnippetData {
    if (!stepText) {
        return {
            displayText: '',
            snippetText: '',
            hasPlaceholders: false
        };
    }

    let displayText = '';
    let snippetText = '';
    let lastIndex = 0;
    let hasPlaceholders = false;
    STEP_TEMPLATE_PLACEHOLDER_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = STEP_TEMPLATE_PLACEHOLDER_REGEX.exec(stepText)) !== null) {
        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;
        const placeholderIndex = Number.parseInt(match[1], 10);
        if (!Number.isFinite(placeholderIndex) || placeholderIndex <= 0) {
            continue;
        }

        const staticText = stepText.slice(lastIndex, matchStart);
        displayText += staticText;
        snippetText += escapeStepSnippetText(staticText);
        snippetText += `\${${placeholderIndex}}`;
        hasPlaceholders = true;
        lastIndex = matchEnd;
    }

    const trailingText = stepText.slice(lastIndex);
    displayText += trailingText;
    snippetText += escapeStepSnippetText(trailingText);

    return {
        displayText,
        snippetText,
        hasPlaceholders
    };
}

function parseQuotedTextCompletionContext(
    lineText: string,
    character: number
): QuotedTextCompletionContext | null {
    const safeCharacter = Math.max(0, Math.min(character, lineText.length));
    const quotedSegments: Array<{
        startCharacter: number;
        endCharacter: number;
        quoteCharacter: '"' | "'";
        value: string;
        beforeQuote: string;
        afterQuote: string;
    }> = [];

    let activeQuote: '"' | "'" | null = null;
    let activeQuoteStart = -1;
    for (let index = 0; index < lineText.length; index++) {
        const symbol = lineText[index];
        if (symbol !== '"' && symbol !== '\'') {
            continue;
        }

        if (!activeQuote) {
            activeQuote = symbol;
            activeQuoteStart = index;
            continue;
        }

        if (symbol !== activeQuote || activeQuoteStart < 0) {
            continue;
        }

        quotedSegments.push({
            startCharacter: activeQuoteStart,
            endCharacter: index,
            quoteCharacter: activeQuote,
            value: lineText.slice(activeQuoteStart + 1, index),
            beforeQuote: lineText.slice(0, activeQuoteStart),
            afterQuote: lineText.slice(index + 1)
        });
        activeQuote = null;
        activeQuoteStart = -1;
    }

    if (activeQuote && activeQuoteStart >= 0) {
        quotedSegments.push({
            startCharacter: activeQuoteStart,
            endCharacter: lineText.length,
            quoteCharacter: activeQuote,
            value: lineText.slice(activeQuoteStart + 1),
            beforeQuote: lineText.slice(0, activeQuoteStart),
            afterQuote: ''
        });
    }

    const activeSegmentIndex = quotedSegments.findIndex(segment =>
        safeCharacter >= segment.startCharacter + 1 && safeCharacter <= segment.endCharacter
    );
    if (activeSegmentIndex < 0) {
        return null;
    }

    const activeSegment = quotedSegments[activeSegmentIndex];
    const typedPrefixEndCharacter = Math.min(safeCharacter, activeSegment.endCharacter);
    const quotedValuesBefore = quotedSegments
        .slice(0, activeSegmentIndex)
        .map(segment => segment.value);
    const quotedValuesAfter = quotedSegments
        .slice(activeSegmentIndex + 1)
        .map(segment => segment.value);
    const otherQuotedReferences = quotedSegments
        .map((segment, index) => ({
            value: segment.value,
            beforeQuote: segment.beforeQuote,
            afterQuote: segment.afterQuote,
            argumentIndex: index
        }))
        .filter(reference => reference.argumentIndex !== activeSegmentIndex);

    return {
        startCharacter: activeSegment.startCharacter + 1,
        endCharacter: activeSegment.endCharacter,
        typedPrefix: lineText.slice(activeSegment.startCharacter + 1, typedPrefixEndCharacter),
        quoteCharacter: activeSegment.quoteCharacter,
        argumentIndex: activeSegmentIndex,
        quotedValuesBefore,
        quotedValuesAfter,
        otherQuotedReferences,
        linePrefixBeforeQuote: activeSegment.beforeQuote
    };
}

export function buildVariableReferenceText(
    variableName: string,
    source: VariableCompletionSource
): string {
    return source === 'global'
        ? `$$${variableName}$$`
        : `$${variableName}$`;
}

export function findVariableReferenceAtPosition(
    lineText: string,
    character: number
): VariableReferenceToken | null {
    const variableRegex = /\$\$([A-Za-zА-Яа-яЁё0-9_]+)\$\$|\$([A-Za-zА-Яа-яЁё0-9_]+)\$/g;
    let match: RegExpExecArray | null;

    while ((match = variableRegex.exec(lineText)) !== null) {
        const fullMatch = match[0];
        const isGlobal = fullMatch.startsWith('$$');
        const variableName = match[1] || match[2];
        if (!variableName) {
            continue;
        }

        const startCharacter = match.index;
        const endCharacter = startCharacter + fullMatch.length;
        if (character < startCharacter || character > endCharacter) {
            continue;
        }

        return {
            name: variableName,
            source: isGlobal ? 'global' : 'saved',
            startCharacter,
            endCharacter
        };
    }

    return null;
}

function getFirstTrimmedMatch(match: RegExpMatchArray, indices: number[]): string {
    for (const index of indices) {
        const value = match[index];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return '';
}

function inferSavedVariableSourceFromLine(lineText: string): VariableCompletionSource {
    return /\b(?:globally|глобально)\b/i.test(lineText) ? 'global' : 'saved';
}

function createSavedVariableDefinition(
    variableName: string,
    value: string,
    source: VariableCompletionSource
): SavedVariableDefinition | null {
    const normalizedName = variableName.trim();
    if (!normalizedName) {
        return null;
    }

    return {
        name: normalizedName,
        value: value.trim(),
        source
    };
}

const SAVED_VARIABLE_STEP_PATTERNS: SavedVariableStepPattern[] = [
    {
        regex: SAVE_VARIABLE_STEP_REGEX_EN_VALUE_TO,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [2, 3]),
            getFirstTrimmedMatch(match, [1]),
            source
        )
    },
    {
        regex: SAVE_VARIABLE_STEP_REGEX_RU_VALUE_TO,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [1, 2]),
            getFirstTrimmedMatch(match, [3]),
            source
        )
    },
    {
        regex: EXECUTE_AND_PUT_TO_VARIABLE_REGEX,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [3, 4]),
            getFirstTrimmedMatch(match, [1, 2]),
            source
        )
    },
    {
        regex: VARIABLE_ASSIGNMENT_FIND_OR_CREATE_REGEX,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [2, 3]),
            getFirstTrimmedMatch(match, [1]),
            source
        )
    },
    {
        regex: VARIABLE_ASSIGNMENT_COPY_REGEX,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [3, 4]),
            getFirstTrimmedMatch(match, [1, 2]),
            source
        )
    },
    {
        regex: VARIABLE_ASSIGNMENT_TO_THE_VARIABLE_REGEX,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [2, 3]),
            getFirstTrimmedMatch(match, [1]),
            source
        )
    },
    {
        regex: VARIABLE_ASSIGNMENT_TO_VARIABLE_REGEX,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [2, 3]),
            getFirstTrimmedMatch(match, [1]),
            source
        )
    },
    {
        regex: VARIABLE_ASSIGNMENT_AS_REGEX,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [2, 3]),
            getFirstTrimmedMatch(match, [1]),
            source
        )
    },
    {
        regex: VARIABLE_ASSIGNMENT_INTO_RU_REGEX,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [2, 3]),
            getFirstTrimmedMatch(match, [1]),
            source
        )
    },
    {
        regex: VARIABLE_ASSIGNMENT_IN_SHORT_RU_REGEX,
        createDefinition: (match, source) => createSavedVariableDefinition(
            getFirstTrimmedMatch(match, [2, 3]),
            getFirstTrimmedMatch(match, [1]),
            source
        )
    }
];

export function extractSavedVariableFromStepLine(lineText: string): SavedVariableDefinition | null {
    const source = inferSavedVariableSourceFromLine(lineText);

    for (const pattern of SAVED_VARIABLE_STEP_PATTERNS) {
        const match = lineText.match(pattern.regex);
        if (!match) {
            continue;
        }

        const definition = pattern.createDefinition(match, source);
        if (definition) {
            return definition;
        }
    }

    return null;
}

export function buildVariableValuePreview(value: string, maxLength: number = 60): string {
    if (!value) {
        return '…';
    }
    const singleLine = value.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxLength) {
        return singleLine;
    }
    return `${singleLine.slice(0, maxLength - 1)}…`;
}

export function formatVariableValueForDisplay(
    value: string,
    source: VariableCompletionSource
): string {
    if (source !== 'global') {
        return value;
    }

    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) {
        return value;
    }

    const isAlreadyQuoted =
        (trimmed.startsWith('\'') && trimmed.endsWith('\'')) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'));
    if (isAlreadyQuoted) {
        return value;
    }

    if (!value.includes('\'')) {
        return `'${value}'`;
    }

    if (!value.includes('"')) {
        return `"${value}"`;
    }

    return `'${value.replace(/'/g, '\'\'')}'`;
}

function normalizeSemanticSynonymToken(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/ё/g, 'е');
}

function buildSemanticSynonymIndex(
    groups: ReadonlyArray<ReadonlyArray<string>>
): Map<string, string[]> {
    const index = new Map<string, Set<string>>();

    groups.forEach(group => {
        const normalizedGroup = Array.from(new Set(
            group
                .map(token => normalizeSemanticSynonymToken(token))
                .filter(token => token.length >= 2)
        ));
        if (normalizedGroup.length < 2) {
            return;
        }

        normalizedGroup.forEach(token => {
            const bucket = index.get(token) || new Set<string>();
            normalizedGroup.forEach(value => bucket.add(value));
            index.set(token, bucket);
        });
    });

    const result = new Map<string, string[]>();
    index.forEach((values, key) => {
        result.set(key, Array.from(values.values()));
    });
    return result;
}

const SEMANTIC_SYNONYM_INDEX = buildSemanticSynonymIndex(SEMANTIC_SYNONYM_GROUPS);

interface SemanticStepEntry {
    item: vscode.CompletionItem;
    itemText: string;
    stepSearchText: string;
    descriptionSearchText: string;
    tokens: string[];
    tokenSet: Set<string>;
    semanticNorm: number;
    language: ScenarioLanguage;
}

export class DriveCompletionProvider implements vscode.CompletionItemProvider {
    private gherkinCompletionItems: vscode.CompletionItem[] = [];
    private semanticStepEntries: SemanticStepEntry[] = [];
    private semanticIdfByTerm = new Map<string, number>();
    private semanticPostingsByTerm = new Map<string, number[]>();
    private semanticTermsByPrefix = new Map<string, string[]>();
    private semanticVectorScoreCache = new Map<string, Map<number, number>>();
    private gherkinItemLanguageByItem = new WeakMap<vscode.CompletionItem, ScenarioLanguage>();
    private scenarioCompletionItems: vscode.CompletionItem[] = [];
    private scenarioParametersByName: Map<string, string[]> = new Map();
    private calledScenarioDefaultsByName: Map<string, Map<string, string>> = new Map();
    private scenarioDefaultsByDocument = new Map<string, { version: number; defaults: Map<string, string> }>();
    private isLoadingGherkin: boolean = false;
    private loadingGherkinPromise: Promise<void> | null = null;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(document => {
                this.scenarioDefaultsByDocument.delete(document.uri.toString());
            })
        );
        this.loadGherkinCompletionItems().catch(async err => {
            const t = await getTranslator(context.extensionUri);
            vscode.window.showErrorMessage(t('Error initializing Gherkin autocompletion: {0}', err.message));
        });
        console.log("[DriveCompletionProvider] Initialized. Scenario completions will be updated externally.");
    }

    // Метод для принудительного обновления шагов Gherkin
    public async refreshSteps(): Promise<void> {
        console.log("[DriveCompletionProvider] Refreshing Gherkin steps triggered...");
        this.gherkinCompletionItems = [];
        this.semanticStepEntries = [];
        this.semanticIdfByTerm.clear();
        this.semanticPostingsByTerm.clear();
        this.semanticTermsByPrefix.clear();
        this.semanticVectorScoreCache.clear();
        this.gherkinItemLanguageByItem = new WeakMap<vscode.CompletionItem, ScenarioLanguage>();
        this.loadingGherkinPromise = null;
        this.isLoadingGherkin = false;
        try {
            // Вызываем основную логику обновления из stepsFetcher
            const htmlContent = await forceRefreshStepsCore(this.context);
            this.parseAndStoreGherkinCompletions(htmlContent);
            console.log("[DriveCompletionProvider] Gherkin steps refreshed and re-parsed successfully.");
        } catch (error: any) {
            console.error(`[DriveCompletionProvider] Failed to refresh Gherkin steps: ${error.message}`);
            // Если принудительное обновление не удалось, пытаемся загрузить хоть что-то
            // чтобы расширение не осталось без автодополнения
            await this.loadGherkinCompletionItems();
        }
    }

    // Метод для обновления списка автодополнений сценариев
    public updateScenarioCompletions(scenarios: Map<string, TestInfo> | null): void {
        this.scenarioCompletionItems = []; // Очищаем перед заполнением
        this.scenarioParametersByName.clear();
        this.calledScenarioDefaultsByName.clear();
        if (!scenarios || scenarios.size === 0) {
            console.log("[DriveCompletionProvider] No scenarios provided for completion items.");
            return;
        }

        scenarios.forEach((scenarioInfo, scenarioName) => {
            // Метка, которую увидит пользователь в списке автодополнения
            const item = new vscode.CompletionItem(scenarioName, vscode.CompletionItemKind.Function);
            const scenarioDescription = (scenarioInfo.scenarioDescription || '').trim();

            item.detail = vscode.l10n.t('Nested scenario (1C)');
            if (scenarioDescription) {
                const firstLine = scenarioDescription.split(/\r\n|\r|\n/)[0].trim();
                if (firstLine) {
                    item.detail = `${item.detail} - ${firstLine}`;
                }
            }
            const itemDocumentation = new vscode.MarkdownString();
            itemDocumentation.appendMarkdown(vscode.l10n.t('Call scenario "{0}".', scenarioName));
            if (scenarioDescription) {
                itemDocumentation.appendMarkdown(`\n\n**${vscode.l10n.t('Description')}:**\n\n`);
                this.appendCompactMultilineText(itemDocumentation, scenarioDescription);
            }
            item.documentation = itemDocumentation;
            // Текст, по которому будет происходить фильтрация при вводе пользователя
            // (без "And ", чтобы можно было просто начать печатать имя сценария)
            item.filterText = scenarioName;

            item.insertText = scenarioName;

            const scenarioParameters = (scenarioInfo.parameters || [])
                .map(param => param.trim())
                .filter(Boolean);
            if (scenarioParameters.length > 0) {
                this.scenarioParametersByName.set(scenarioName, scenarioParameters);
            }

            if (scenarioInfo.parameterDefaults) {
                const defaultsMap = new Map<string, string>();
                Object.entries(scenarioInfo.parameterDefaults).forEach(([paramName, defaultValue]) => {
                    const normalizedParamName = paramName.trim();
                    if (normalizedParamName && typeof defaultValue === 'string') {
                        defaultsMap.set(normalizedParamName, defaultValue);
                    }
                });
                if (defaultsMap.size > 0) {
                    this.calledScenarioDefaultsByName.set(scenarioName, defaultsMap);
                }
            }
            // Приоритет ниже, чем у шагов Gherkin (начинающихся с "0"), сортировка по имени сценария
            // sortText будет формироваться в provideCompletionItems на основе оценки совпадения
            // item.sortText = "1" + scenarioName;

            this.scenarioCompletionItems.push(item);
        });
        console.log(`[DriveCompletionProvider] Updated with ${this.scenarioCompletionItems.length} scenario completions.`);
    }


    private parseAndStoreGherkinCompletions(htmlContent: string): void {
        this.gherkinCompletionItems = []; // Очищаем перед заполнением
        this.semanticStepEntries = [];
        this.semanticIdfByTerm.clear();
        this.semanticPostingsByTerm.clear();
        this.semanticTermsByPrefix.clear();
        this.semanticVectorScoreCache.clear();
        this.gherkinItemLanguageByItem = new WeakMap<vscode.CompletionItem, ScenarioLanguage>();
        if (!htmlContent) {
            console.warn("[DriveCompletionProvider] HTML content is null or empty for Gherkin steps.");
            return;
        }
        const root = parse(htmlContent);
        const rows = root.querySelectorAll('tr');

        rows.forEach(row => {
            const rowClass = row.classNames;
            // Проверяем, что класс строки начинается с 'R' (предполагая, что это строки с шагами)
            if (!rowClass || !rowClass.startsWith('R')) {
                return; // Пропускаем строки заголовков или другие нерелевантные
            }

            const cells = row.querySelectorAll('td');
            // Убедимся, что есть хотя бы 4 ячейки для русского шага
            if (cells.length >= 4) {
                // Структура: колонки 1-2 русские, колонки 3-4 английские
                const russianStepText = cells[0].textContent.trim();
                const russianStepDescription = cells[1].textContent.trim();

                // Получаем английские варианты, если они есть (колонки 3-4)
                const stepText = cells.length >= 4 ? this.normalizeLineBreaks(cells[2].textContent.trim()) : '';
                const stepDescription = cells.length >= 4 ? this.normalizeLineBreaks(cells[3].textContent.trim()) : '';
                const russianSnippet = buildStepTemplateSnippetData(russianStepText);
                const englishSnippet = buildStepTemplateSnippetData(stepText);

                // Создаем элемент автодополнения для русского шага (если он есть)
                if (russianStepText) {
                    const russianItem = new vscode.CompletionItem(russianSnippet.displayText, vscode.CompletionItemKind.Snippet);

                    // Создаем документацию: русское описание + оба варианта шагов
                    const russianDoc = new vscode.MarkdownString();
                    russianDoc.appendMarkdown(`**Описание:**\n\n${russianStepDescription}\n\n`);
                    russianDoc.appendMarkdown(`\`${russianSnippet.displayText}\``);
                    if (stepText) {
                        russianDoc.appendMarkdown(`\n\n\`${englishSnippet.displayText}\``);
                    }

                    russianItem.documentation = russianDoc;
                    russianItem.detail = "Gherkin Step (1C) - Russian";
                    russianItem.insertText = russianSnippet.hasPlaceholders
                        ? new vscode.SnippetString(russianSnippet.snippetText)
                        : russianSnippet.displayText;
                    russianItem.filterText = `${russianSnippet.displayText} ${russianStepText}`;
                    this.gherkinItemLanguageByItem.set(russianItem, 'ru');
                    this.gherkinCompletionItems.push(russianItem);
                    this.semanticStepEntries.push(this.createSemanticStepEntry(
                        russianItem,
                        russianSnippet.displayText,
                        russianStepDescription,
                        [englishSnippet.displayText, stepDescription, russianStepText],
                        'ru'
                    ));
                }

                // Создаем элемент автодополнения для английского шага (если он есть)
                if (stepText) {
                    const item = new vscode.CompletionItem(englishSnippet.displayText, vscode.CompletionItemKind.Snippet);

                    // Создаем документацию: английское описание + оба варианта шагов
                    const englishDoc = new vscode.MarkdownString();
                    englishDoc.appendMarkdown(`**Description:**\n\n${stepDescription}\n\n`);
                    englishDoc.appendMarkdown(`\`${englishSnippet.displayText}\``);
                    if (russianStepText) {
                        englishDoc.appendMarkdown(`\n\n\`${russianSnippet.displayText}\``);
                    }

                    item.documentation = englishDoc;
                    item.detail = "Gherkin Step (1C) - English";
                    item.insertText = englishSnippet.hasPlaceholders
                        ? new vscode.SnippetString(englishSnippet.snippetText)
                        : englishSnippet.displayText;
                    item.filterText = `${englishSnippet.displayText} ${stepText}`;
                    this.gherkinItemLanguageByItem.set(item, 'en');
                    this.gherkinCompletionItems.push(item);
                    this.semanticStepEntries.push(this.createSemanticStepEntry(
                        item,
                        englishSnippet.displayText,
                        stepDescription,
                        [russianSnippet.displayText, russianStepDescription, stepText],
                        'en'
                    ));
                }
            }
        });
        this.rebuildSemanticVectorIndex();
        console.log(`[DriveCompletionProvider] Parsed and stored ${this.gherkinCompletionItems.length} Gherkin completion items and ${this.semanticStepEntries.length} semantic entries.`);
    }

    private loadGherkinCompletionItems(): Promise<void> {
        // Если загрузка уже идет, возвращаем существующий промис
        if (this.isLoadingGherkin && this.loadingGherkinPromise) {
            return this.loadingGherkinPromise;
        }
        // Если элементы уже загружены и нет активной загрузки, просто возвращаем
        if (this.gherkinCompletionItems.length > 0 && !this.isLoadingGherkin) {
            return Promise.resolve();
        }

        this.isLoadingGherkin = true;
        console.log("[DriveCompletionProvider] Starting to load Gherkin completion items...");

        // Используем getStepsHtml из stepsFetcher
        this.loadingGherkinPromise = getStepsHtml(this.context)
            .then(htmlContent => {
                this.parseAndStoreGherkinCompletions(htmlContent);
            })
            .catch(async error => {
                console.error(`[DriveCompletionProvider] Ошибка загрузки или парсинга steps.htm: ${error.message}`);
                const t = await getTranslator(this.context.extensionUri);
                vscode.window.showErrorMessage(t('Failed to load Gherkin steps for autocompletion: {0}', error.message));
                this.gherkinCompletionItems = []; // Убедимся, что список пуст в случае ошибки
                this.semanticStepEntries = [];
                this.semanticIdfByTerm.clear();
                this.semanticPostingsByTerm.clear();
                this.semanticTermsByPrefix.clear();
                this.semanticVectorScoreCache.clear();
                this.gherkinItemLanguageByItem = new WeakMap<vscode.CompletionItem, ScenarioLanguage>();
            })
            .finally(() => {
                this.isLoadingGherkin = false;
                // Не обнуляем loadingPromise здесь, чтобы повторные быстрые вызовы во время первой загрузки
                // все еще могли использовать его. Он будет сброшен принудительно при refreshSteps
                // или если gherkinCompletionItems пуст при следующем вызове loadGherkinCompletionItems.
                console.log("[DriveCompletionProvider] Finished Gherkin loading attempt.");
            });

        return this.loadingGherkinPromise;
    }

    /**
     * Основной метод, предоставляющий автодополнение
     */
    public async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {

        console.log("[DriveCompletionProvider:provideCompletionItems] Triggered.");

        const isFeatureDocument = this.isFeatureDocument(document);
        let isSupportedDocument = isFeatureDocument;
        if (!isSupportedDocument) {
            const { isScenarioYamlFile } = await import('./yamlValidator.js');
            isSupportedDocument = isScenarioYamlFile(document);
        }
        if (!isSupportedDocument) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Unsupported document type. Returning empty.");
            return [];
        }

        // Предоставляем автодополнение только в блоках текста сценария
        if (!this.isInScenarioTextBlock(document, position)) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Not in scenario text block. Returning empty.");
            return [];
        }

        // Получаем текст текущей строки до позиции курсора
        const lineText = document.lineAt(position.line).text;
        const linePrefix = lineText.substring(0, position.character); // Текст строки до курсора

        const variableReferenceContext = this.getVariableReferenceContext(linePrefix);
        if (variableReferenceContext) {
            return await this.buildSavedVariableCompletionList(document, position, variableReferenceContext);
        }

        const scenarioBracketParameterContext = !isFeatureDocument
            ? this.getScenarioBracketParameterContext(linePrefix)
            : null;
        if (scenarioBracketParameterContext) {
            return this.buildScenarioParameterCompletionList(document, position, scenarioBracketParameterContext);
        }

        const quotedTextCompletionContext = parseQuotedTextCompletionContext(lineText, position.character);
        if (quotedTextCompletionContext) {
            const formExplorerQuotedCompletionList = await this.buildFormExplorerQuotedArgumentCompletionList(
                lineText,
                position,
                quotedTextCompletionContext
            );
            if (formExplorerQuotedCompletionList) {
                return formExplorerQuotedCompletionList;
            }
            // When cursor is inside a quote in an already-completed step (text follows the closing
            // quote), don't offer gherkin step suggestions — they would corrupt the existing step.
            const closingQuoteIndex = quotedTextCompletionContext.endCharacter;
            if (
                closingQuoteIndex < lineText.length
                && lineText.slice(closingQuoteIndex + 1).trim().length > 0
            ) {
                return new vscode.CompletionList([], false);
            }
        }

        // Если элементы Gherkin еще не загружены или идет загрузка, дождемся ее завершения
        if (this.isLoadingGherkin && this.loadingGherkinPromise) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Waiting for Gherkin load to complete...");
            await this.loadingGherkinPromise;
        } else if (this.gherkinCompletionItems.length === 0 && !this.isLoadingGherkin) {
            // Если загрузка Gherkin не идет, но элементов нет, попробуем загрузить
            console.log("[DriveCompletionProvider:provideCompletionItems] Gherkin items not loaded, attempting to load now...");
            await this.loadGherkinCompletionItems();
        }

        // Создаем список автодополнения
        const completionList = new vscode.CompletionList();

        // Ищем отступы и ключевые слова в начале строки (регистронезависимо)
        const lineStartPattern = /^(\s*)(?:\*\s*)?(and|but|then|when|given|if|и|тогда|когда|если|допустим|к тому же|но)?\s*/i;
        const lineStartMatch = linePrefix.match(lineStartPattern);

        if (!lineStartMatch) {
            // Этого не должно произойти, если isInScenarioTextBlock вернуло true и строка не пустая,
            // но на всякий случай.
            console.log("[DriveCompletionProvider:provideCompletionItems] Line prefix does not match Gherkin start pattern. Returning empty.");
            return completionList;
        }

        const indentation = lineStartMatch[1] || ''; // Отступы в начале строки
        const keywordInLine = (lineStartMatch[2] || '').toLowerCase(); // Найденное ключевое слово Gherkin (или пусто, если его нет)
        const gherkinPrefixInLine = lineStartMatch[0]; // Полный префикс с отступом и ключевым словом, например "    And "

        // Текст, который пользователь ввел ПОСЛЕ отступов (и возможно, ключевого слова Gherkin)
        const userTextAfterIndentation = linePrefix.substring(indentation.length);
        // Текст, который пользователь ввел ПОСЛЕ ключевого слова (если оно было)
        const userTextAfterKeyword = linePrefix.substring(gherkinPrefixInLine.length);
        const rawTextToMatch = keywordInLine ? userTextAfterKeyword : userTextAfterIndentation;
        const textToMatchAgainst = rawTextToMatch.replace(/^\*\s*/, '');
        const scenarioLanguage = getScenarioLanguageForDocument(document);
        const scenarioCallKeyword = getScenarioCallKeyword(scenarioLanguage);
        const semanticQuery = this.extractSemanticStepQuery(textToMatchAgainst);
        if (semanticQuery !== null) {
            return this.buildSemanticStepCompletionList(
                position,
                indentation,
                semanticQuery,
                textToMatchAgainst,
                scenarioLanguage
            );
        }

        console.log(`[DriveCompletionProvider:provideCompletionItems] Indent: '${indentation}', KeywordInLine: '${keywordInLine}', UserTextAfterKeyword: '${userTextAfterKeyword}', UserTextAfterIndentation: '${userTextAfterIndentation}'`);

        // Добавляем Gherkin шаги
        this.gherkinCompletionItems.forEach(baseItem => {
            const itemFullText = typeof baseItem.label === 'string' ? baseItem.label : baseItem.label.label; // Полный текст элемента автодополнения

            // Извлекаем ключевое слово из самого шага Gherkin, если оно там есть
            const itemStartPatternGherkin = /^(And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
            const itemKeywordMatch = itemFullText.match(itemStartPatternGherkin);
            const itemKeywordFromStep = itemKeywordMatch ? itemKeywordMatch[0].trim().toLowerCase() : ''; // Ключевое слово из элемента
            const itemTextAfterKeywordInItem = itemKeywordMatch ? itemFullText.substring(itemKeywordMatch[0].length) : itemFullText; // Текст элемента после ключевого слова

            // Фильтруем по совпадению ключевого слова, если оно есть в строке пользователя
            // Если в строке пользователя нет ключевого слова, то itemKeywordFromStep должен быть пустым (или мы должны предлагать все типы шагов)
            // Для простоты: если пользователь ввел ключевое слово, оно должно совпадать с ключевым словом шага.
            // Если пользователь не ввел ключевое слово, предлагаем все шаги, но matching будет по тексту после ключевого слова шага.
            if (keywordInLine && itemKeywordFromStep && keywordInLine !== itemKeywordFromStep) {
                return;
            }

            // Текст для нечеткого сопоставления:
            // Если пользователь ввел ключевое слово, сопоставляем то, что после него.
            // Если не ввел, сопоставляем весь введенный текст после отступа с текстом шага после его ключевого слова.
            const itemTextForMatching = itemTextAfterKeywordInItem;

            const matchResult = this.fuzzyMatch(itemTextForMatching, textToMatchAgainst);
            if (matchResult.matched) {
                const completionItem = new vscode.CompletionItem(itemFullText, baseItem.kind);
                completionItem.documentation = baseItem.documentation;
                completionItem.detail = baseItem.detail;

                // Заменяем всю строку, начиная с отступа
                const replacementRange = new vscode.Range(
                    position.line,
                    indentation.length, // Начало текста после отступа
                    position.line,
                    position.character // Заменяем только то, что пользователь ввел после отступа
                );
                completionItem.range = replacementRange;
                const itemLanguage = this.getStepLanguageForItem(baseItem);
                completionItem.insertText = this.buildStepCompletionInsertText(
                    itemFullText,
                    indentation,
                    itemLanguage,
                    baseItem.insertText
                );
                if (completionItem.insertText instanceof vscode.SnippetString) {
                    completionItem.command = {
                        title: vscode.l10n.t('Suggest'),
                        command: FORM_EXPLORER_INITIAL_SUGGEST_COMMAND
                    };
                }
                // Сортировка по релевантности
                const languageBucket = itemLanguage && itemLanguage !== scenarioLanguage ? '1' : '0';
                completionItem.sortText = `0${languageBucket}${(1 - matchResult.score).toFixed(3)}${itemFullText}`;
                completionList.items.push(completionItem);
            }
        });

        // Добавляем вызовы сценариев
        // Текст, который пользователь ввел после отступа, очищенный от возможного "And " в начале
        const textForScenarioFuzzyMatch = userTextAfterIndentation.replace(/^(And|И|Допустим)\s+/i, '');
        const scenarioParameterDefaults = this.getScenarioParameterDefaults(document);
        console.log(`[DriveCompletionProvider:provideCompletionItems] Text for scenario fuzzy match: '${textForScenarioFuzzyMatch}' (based on userTextAfterIndentation: '${userTextAfterIndentation}')`);

        if (!isFeatureDocument) {
            this.scenarioCompletionItems.forEach(baseScenarioItem => {
                const scenarioName = baseScenarioItem.filterText || (typeof baseScenarioItem.label === 'string'
                    ? baseScenarioItem.label
                    : baseScenarioItem.label.label);
                if (!scenarioName) {
                    return;
                }

                // baseScenarioItem.filterText это "ИмяСценария"
                const matchResult = this.fuzzyMatch(scenarioName, textForScenarioFuzzyMatch);

                if (matchResult.matched) {
                    const completionItem = new vscode.CompletionItem(`${scenarioCallKeyword} ${scenarioName}`, baseScenarioItem.kind);
                    completionItem.filterText = scenarioName; // filterText = "ИмяСценария"
                    completionItem.documentation = baseScenarioItem.documentation;
                    completionItem.detail = baseScenarioItem.detail;
                    const {
                        baseIndent: scenarioCallBaseIndent,
                        firstLinePrefix: scenarioCallFirstLinePrefix,
                        replacementStartCharacter: scenarioCallReplacementStart
                    } = this.resolveScenarioCallInsertIndent(document, position);

                    // Диапазон для замены: от начала пользовательского ввода (после отступа) до текущей позиции курсора.
                    const replacementRange = new vscode.Range(
                        position.line,
                        scenarioCallReplacementStart,
                        position.line,
                        position.character
                    );
                    completionItem.range = replacementRange;

                    completionItem.insertText = this.buildScenarioCallInsertText(
                        scenarioName,
                        scenarioCallBaseIndent,
                        scenarioCallFirstLinePrefix,
                        scenarioParameterDefaults,
                        scenarioCallKeyword
                    );

                    completionItem.sortText = "1" + (1 - matchResult.score).toFixed(3) + scenarioName; // Используем toFixed(3)
                    console.log(`[Scenario Autocomplete] Label: "${completionItem.label}", Scenario Name: ${scenarioName}, Input: "${textForScenarioFuzzyMatch}", Score: ${matchResult.score.toFixed(3)}, SortText: ${completionItem.sortText}`);
                    completionList.items.push(completionItem);
                }
            });
        }

        console.log(`[DriveCompletionProvider:provideCompletionItems] Total Gherkin items: ${this.gherkinCompletionItems.length}, Total Scenario items: ${this.scenarioCompletionItems.length}, Proposed items: ${completionList.items.length}`);
        return completionList;
    }

    private resolveScenarioCallInsertIndent(
        document: vscode.TextDocument,
        position: vscode.Position
    ): { baseIndent: string; firstLinePrefix: string; replacementStartCharacter: number } {
        const defaultIndent = '    ';
        const currentLineText = document.lineAt(position.line).text;
        const cursorCharacter = Math.max(0, Math.min(position.character, currentLineText.length));
        const beforeCursorText = currentLineText.slice(0, cursorCharacter);
        const currentLineLeadingIndent = currentLineText.match(/^\s*/)?.[0] ?? '';
        const lineHasContent = currentLineText.trim().length > 0;

        if (lineHasContent) {
            return {
                baseIndent: currentLineLeadingIndent,
                firstLinePrefix: '',
                replacementStartCharacter: currentLineLeadingIndent.length
            };
        }

        if (/^\s+$/.test(beforeCursorText)) {
            return {
                baseIndent: beforeCursorText,
                firstLinePrefix: '',
                replacementStartCharacter: beforeCursorText.length
            };
        }

        for (let line = position.line - 1; line >= 0; line--) {
            const text = document.lineAt(line).text;
            if (text.trim().length === 0) {
                continue;
            }

            const indent = text.match(/^\s*/)?.[0] ?? '';
            return {
                baseIndent: indent,
                firstLinePrefix: indent,
                replacementStartCharacter: 0
            };
        }

        return {
            baseIndent: defaultIndent,
            firstLinePrefix: defaultIndent,
            replacementStartCharacter: 0
        };
    }

    private getVariableReferenceContext(
        linePrefix: string
    ): VariableReferenceContext | null {
        return parseVariableReferenceContext(linePrefix);
    }

    private getScenarioBracketParameterContext(
        linePrefix: string
    ): ScenarioBracketParameterContext | null {
        return parseScenarioBracketParameterContext(linePrefix);
    }

    private buildScenarioParameterCompletionList(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: ScenarioBracketParameterContext
    ): vscode.CompletionList {
        const completionList = new vscode.CompletionList<vscode.CompletionItem>([], false);
        const scenarioParameters = Array.from(this.getScenarioParameterDefaults(document).entries());
        if (scenarioParameters.length === 0) {
            return completionList;
        }
        const lineText = document.lineAt(position.line).text;
        const replacementEndCharacter = this.resolveScenarioBracketParameterReplacementEndCharacter(
            lineText,
            position.character
        );

        const typedPrefixLower = context.typedPrefix.toLocaleLowerCase();
        const candidates = scenarioParameters
            .map(([name, defaultValue], index) => ({
                name,
                defaultValue,
                index,
                matchResult: this.fuzzyMatch(name, context.typedPrefix)
            }))
            .filter(candidate => candidate.matchResult.matched)
            .sort((left, right) => {
                const leftStartsWithPrefix = typedPrefixLower.length > 0 && left.name.toLocaleLowerCase().startsWith(typedPrefixLower) ? 0 : 1;
                const rightStartsWithPrefix = typedPrefixLower.length > 0 && right.name.toLocaleLowerCase().startsWith(typedPrefixLower) ? 0 : 1;
                return leftStartsWithPrefix - rightStartsWithPrefix
                    || right.matchResult.score - left.matchResult.score
                    || left.index - right.index;
            });

        candidates.forEach(candidate => {
            const insertedValue = `[${candidate.name}]`;
            const preview = buildVariableValuePreview(candidate.defaultValue);
            const completionItem = new vscode.CompletionItem({
                label: insertedValue,
                description: preview
            }, vscode.CompletionItemKind.Variable);

            completionItem.detail = vscode.l10n.t('Scenario parameter');
            completionItem.documentation = this.buildScenarioParameterCompletionDocumentation(
                candidate.name,
                candidate.defaultValue
            );
            completionItem.insertText = insertedValue;
            completionItem.filterText = `${candidate.name} ${insertedValue}`;
            completionItem.sortText = `${(1 - candidate.matchResult.score).toFixed(4)}_${candidate.index.toString().padStart(3, '0')}`;
            completionItem.range = new vscode.Range(
                position.line,
                context.startCharacter,
                position.line,
                replacementEndCharacter
            );
            completionList.items.push(completionItem);
        });

        return completionList;
    }

    private resolveScenarioBracketParameterReplacementEndCharacter(
        lineText: string,
        cursorCharacter: number
    ): number {
        if (cursorCharacter < lineText.length && lineText[cursorCharacter] === ']') {
            return cursorCharacter + 1;
        }

        return cursorCharacter;
    }

    private normalizeFormExplorerLookupValue(value: string | undefined): string {
        return String(value || '')
            .trim()
            .toLocaleLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[\s._-]+/g, '');
    }

    private normalizeFormExplorerValueLookupValue(value: string | undefined): string {
        return String(value || '')
            .trim()
            .toLocaleLowerCase()
            .replace(/ё/g, 'е')
            .replace(/\s+/g, ' ');
    }

    private collectFormExplorerElementCompletionCandidates(
        snapshot: FormExplorerSnapshot
    ): FormExplorerElementCompletionCandidate[] {
        const result: FormExplorerElementCompletionCandidate[] = [];
        const appendCandidates = (elements: FormExplorerElementInfo[]): void => {
            for (const element of elements) {
                result.push({
                    path: element.path || '',
                    name: (element.name || '').trim(),
                    title: (element.title || element.synonym || '').trim(),
                    kind: (element.kind || element.type || '').trim(),
                    valuePreview: (element.valuePreview || '').trim(),
                    boundAttributePath: (element.boundAttributePath || '').trim()
                });
                appendCandidates(element.children || []);
            }
        };

        appendCandidates(snapshot.elements || []);
        return result.filter(candidate => Boolean(candidate.path || candidate.name || candidate.title));
    }

    private collectFormExplorerTableCompletionCandidates(
        snapshot: FormExplorerSnapshot
    ): FormExplorerTableCompletionCandidate[] {
        return (snapshot.tables || []).map(table => ({
            path: (table.path || table.elementPath || '').trim(),
            name: (table.name || '').trim(),
            title: (table.title || '').trim(),
            columns: Array.isArray(table.tableData?.columns)
                ? table.tableData.columns.map(column => String(column || '').trim())
                : [],
            rows: Array.isArray(table.tableData?.rows)
                ? table.tableData.rows.map(row => Array.isArray(row) ? row.map(cell => String(cell || '').trim()) : [])
                : []
        })).filter(candidate => Boolean(candidate.path || candidate.name || candidate.title));
    }

    private isFormExplorerTableLikeLine(lineText: string): boolean {
        return /\b(table|таблиц|grid|spreadsheet\s+document|табличн(?:ый|ого)?\s+документ)\b/i.test(lineText);
    }

    private isFormExplorerFieldLikeLine(lineText: string): boolean {
        return /(field|поле|attribute|атрибут|реквизит|checkbox|флаг|radio\s*button|переключател|drop-?down|dropdown|выпадающ|html\s+(?:document\s+)?field|form\s+item\s+addition|дополнени(?:е|я)\s+формы|spreadsheet\s+document|табличн(?:ый|ого)?\s+документ)/i.test(lineText);
    }

    private isFormExplorerButtonLikeLine(lineText: string): boolean {
        return /\b(button|кнопк|hyperlink|link|гиперссыл|submenu|подменю)\b/i.test(lineText);
    }

    private isFormExplorerElementLikeLine(lineText: string): boolean {
        return /(element|элемент|group|групп|field|поле|attribute|атрибут|реквизит|checkbox|флаг|radio\s*button|переключател|html\s+document|form\s+item\s+addition|дополнени(?:е|я)\s+формы|spreadsheet\s+document|табличн(?:ый|ого)?\s+документ)/i.test(lineText);
    }

    private isFormExplorerValueLikeLine(lineText: string): boolean {
        return /(значени|value|equal|equals|became|имеет|стал|равен|равна|template|шаблон|contains|contain|header|tooltip|displayed|filled|exists?|available|unavailable|read.?only|appearance|появлен|ввожу|input|enter|text|текст|жду|wait|select|выбираю)/i.test(lineText);
    }

    private isFormExplorerVariableNameSlot(linePrefixBeforeQuote: string): boolean {
        return /(как|as|переменн(?:ую|ой|ая|ые)?|variable)\s*$/i.test(linePrefixBeforeQuote);
    }

    private isWindowOrFormReferenceQuotedContext(beforeQuote: string, afterQuote: string): boolean {
        // Explicit "named"/"titled": "window named "X"", "форма с именем "X""
        if (/(window|form|окно|форм(?:а|у|е|ой)?)\s+(?:with\s+(?:title|name)|named|titled|с\s+(?:именем|заголовком|наименованием))\s*$/i.test(beforeQuote)) {
            return true;
        }
        // Keyword directly before the quote: "close the "X" window" → "окно """, "форма """
        if (/(window|form|окно|форм(?:а|у|е|ой)?)\s*$/i.test(beforeQuote)) {
            return true;
        }
        // Keyword starts the afterQuote: "" window is opened", "" форма открылась"
        // Use negative lookahead instead of \b so Cyrillic boundaries work correctly.
        if (/^\s*(window|form|окно|форм(?:а|у|е|ой)?)(?![а-яА-ЯёЁa-zA-Z0-9])/i.test(afterQuote)) {
            return true;
        }
        return false;
    }

    private isMatchingFormExplorerTableCandidate(
        candidate: FormExplorerTableCompletionCandidate,
        rawReference: string
    ): boolean {
        const normalizedReference = this.normalizeFormExplorerLookupValue(rawReference);
        if (!normalizedReference) {
            return false;
        }

        return [candidate.title, candidate.name, candidate.path]
            .some(value => this.normalizeFormExplorerLookupValue(value) === normalizedReference);
    }

    private findMatchingFormExplorerElementCandidateFromReferences(
        candidates: FormExplorerElementCompletionCandidate[],
        rawReferences: string[]
    ): FormExplorerElementCompletionCandidate | null {
        for (let index = rawReferences.length - 1; index >= 0; index -= 1) {
            const rawReference = rawReferences[index];
            const matchedCandidate = this.findMatchingFormExplorerElementCandidate(candidates, rawReference);
            if (matchedCandidate) {
                return matchedCandidate;
            }
        }

        return null;
    }

    private findMatchingFormExplorerTableCandidateFromReferences(
        candidates: FormExplorerTableCompletionCandidate[],
        rawReferences: string[]
    ): FormExplorerTableCompletionCandidate | null {
        for (let index = rawReferences.length - 1; index >= 0; index -= 1) {
            const rawReference = rawReferences[index];
            const matchedCandidate = this.findMatchingFormExplorerTableCandidate(candidates, rawReference);
            if (matchedCandidate) {
                return matchedCandidate;
            }
        }

        return null;
    }

    private findMatchingFormExplorerTableColumn(
        tableCandidate: FormExplorerTableCompletionCandidate,
        rawColumnReference: string
    ): string | null {
        const normalizedReference = this.normalizeFormExplorerLookupValue(rawColumnReference);
        if (!normalizedReference || tableCandidate.columns.length === 0) {
            return null;
        }

        const exactColumn = tableCandidate.columns.find(column =>
            this.normalizeFormExplorerLookupValue(column) === normalizedReference
        );
        if (exactColumn) {
            return exactColumn;
        }

        return tableCandidate.columns.find(column =>
            this.normalizeFormExplorerLookupValue(column).includes(normalizedReference)
        ) || null;
    }

    private findMatchingFormExplorerTableColumnFromReferences(
        tableCandidate: FormExplorerTableCompletionCandidate,
        rawReferences: string[]
    ): string | null {
        for (let index = rawReferences.length - 1; index >= 0; index -= 1) {
            const rawReference = rawReferences[index];
            if (this.isMatchingFormExplorerTableCandidate(tableCandidate, rawReference)) {
                continue;
            }

            const matchedColumn = this.findMatchingFormExplorerTableColumn(tableCandidate, rawReference);
            if (matchedColumn) {
                return matchedColumn;
            }
        }

        return null;
    }

    private getFormExplorerQuotedArgumentSurroundings(
        lineText: string,
        context: QuotedTextCompletionContext
    ): { beforeQuote: string; afterQuote: string; combined: string } {
        const afterQuote = context.endCharacter < lineText.length && lineText[context.endCharacter] === context.quoteCharacter
            ? lineText.slice(context.endCharacter + 1)
            : lineText.slice(context.endCharacter);
        const beforeQuote = context.linePrefixBeforeQuote;
        return {
            beforeQuote,
            afterQuote,
            combined: `${beforeQuote} ${afterQuote}`
        };
    }

    private isFormExplorerRelevantQuotedContext(
        beforeQuote: string,
        afterQuote: string
    ): boolean {
        const combined = `${beforeQuote} ${afterQuote}`;
        return this.isFormExplorerTableLikeLine(combined)
            || this.isFormExplorerFieldLikeLine(combined)
            || this.isFormExplorerButtonLikeLine(combined)
            || this.isFormExplorerElementLikeLine(combined)
            || this.isWindowOrFormReferenceQuotedContext(beforeQuote, afterQuote);
    }

    private isNamedFieldReferenceQuotedContext(beforeQuote: string): boolean {
        return /(field|поле|attribute|атрибут|реквизит|element|элемент(?:\s+формы)?|checkbox|флаг|group|групп|drop-?down(?:\s+list)?|выпадающ(?:ий)?\s+список|html\s+(?:document\s+)?field|form\s+item\s+addition|дополнени(?:е|я)\s+формы)\s+(?:with\s+name|named|с\s+именем)\s*$/i.test(beforeQuote);
    }

    private isNamedButtonReferenceQuotedContext(beforeQuote: string): boolean {
        return /(button|кнопк(?:а|у|и|е|ой)?|hyperlink|гиперссылк(?:а|у|и|е|ой)?|submenu|подменю)\s+(?:with\s+name|named|с\s+именем)\s*$/i.test(beforeQuote);
    }

    private isTableReferenceQuotedContext(
        beforeQuote: string,
        afterQuote: string
    ): boolean {
        return /(в\s+таблице|таблица(?:\s+формы)?(?:\s+с\s+именем)?|form\s+table(?:\s+named)?|table\s+named)\s*$/i.test(beforeQuote)
            || /^\s*table\b/i.test(afterQuote);
    }

    private isButtonReferenceQuotedContext(
        beforeQuote: string,
        afterQuote: string
    ): boolean {
        if (this.isNamedFieldReferenceQuotedContext(beforeQuote)) {
            return false;
        }

        return this.isNamedButtonReferenceQuotedContext(beforeQuote)
            || /^\s*(button|кнопк|hyperlink|link|гиперссыл|submenu|подменю)\b/i.test(afterQuote);
    }

    private isFieldReferenceQuotedContext(
        beforeQuote: string,
        afterQuote: string
    ): boolean {
        if (this.isTableReferenceQuotedContext(beforeQuote, afterQuote) || this.isNamedButtonReferenceQuotedContext(beforeQuote)) {
            return false;
        }

        return this.isNamedFieldReferenceQuotedContext(beforeQuote)
            || /(field|поле|attribute|атрибут|реквизит|element|элемент(?:\s+формы)?|checkbox|флаг|group|групп|drop-?down(?:\s+list)?|выпадающ(?:ий)?\s+список|html\s+(?:document\s+)?field|form\s+item\s+addition|дополнени(?:е|я)\s+формы)\s*$/i.test(beforeQuote)
            || /^\s*(field|поле|attribute|атрибут|реквизит|form\s+attribute|form\s+element|элемент(?:\s+формы)?|checkbox|флаг|group|групп|html\s+(?:document\s+)?field|form\s+item\s+addition|дополнени(?:е|я)\s+формы)\b/i.test(afterQuote);
    }

    private isElementReferenceQuotedContext(
        beforeQuote: string,
        afterQuote: string
    ): boolean {
        if (this.isTableReferenceQuotedContext(beforeQuote, afterQuote) || this.isButtonReferenceQuotedContext(beforeQuote, afterQuote)) {
            return false;
        }

        return /(element|элемент|attribute|атрибут|form\s+attribute|form\s+element|элемент(?:\s+формы)?|group|групп)\s*$/i.test(beforeQuote)
            || /^\s*(element|элемент|attribute|атрибут|form\s+attribute|form\s+element|элемент(?:\s+формы)?|group|групп)\b/i.test(afterQuote);
    }

    private isValueReferenceQuotedContext(
        beforeQuote: string,
        afterQuote: string
    ): boolean {
        const beforeTail = beforeQuote.slice(-120);
        return /(equal(?:s| to)?|became(?:\s+equal(?:\s+to)?)?|имеет\s+значение|стал(?:а|о|и)?\s+рав(?:ен|на|но|ны)|рав(?:ен|на|но|ны)|жду\s+значени|wait(?:ing)?(?:\s+for)?\s+.*value|input(?:\s+text)?|ввожу(?:\s+текст)?|text|текст|template|шаблон|contains?|contain|tooltip|header|appearance|появлен|\bby\s*$)/i.test(beforeTail)
            || /^\s*(value|значени|text|текст|template|шаблон)\b/i.test(afterQuote);
    }

    private isTableLikeFormExplorerCandidate(candidate: FormExplorerElementCompletionCandidate): boolean {
        return /(table|таблиц|dynamiclist|динамическийспис)/i.test(candidate.kind);
    }

    private isFieldLikeFormExplorerCandidate(candidate: FormExplorerElementCompletionCandidate): boolean {
        return /(field|поле)/i.test(candidate.kind)
            || Boolean(candidate.boundAttributePath);
    }

    private isButtonLikeFormExplorerCandidate(candidate: FormExplorerElementCompletionCandidate): boolean {
        return /(button|кнопк|hyperlink|гиперссыл)/i.test(candidate.kind);
    }

    private findMatchingFormExplorerElementCandidate(
        candidates: FormExplorerElementCompletionCandidate[],
        rawReference: string
    ): FormExplorerElementCompletionCandidate | null {
        const normalizedReference = this.normalizeFormExplorerLookupValue(rawReference);
        if (!normalizedReference) {
            return null;
        }

        const exactCandidate = candidates.find(candidate =>
            [
                candidate.title,
                candidate.name,
                candidate.path,
                candidate.boundAttributePath
            ].some(value => this.normalizeFormExplorerLookupValue(value) === normalizedReference)
        );
        if (exactCandidate) {
            return exactCandidate;
        }

        return candidates.find(candidate =>
            [
                candidate.title,
                candidate.name,
                candidate.path,
                candidate.boundAttributePath
            ].some(value => this.normalizeFormExplorerLookupValue(value).includes(normalizedReference))
        ) || null;
    }

    private findMatchingFormExplorerTableCandidate(
        candidates: FormExplorerTableCompletionCandidate[],
        rawReference: string
    ): FormExplorerTableCompletionCandidate | null {
        const normalizedReference = this.normalizeFormExplorerLookupValue(rawReference);
        if (!normalizedReference) {
            return null;
        }

        const exactCandidate = candidates.find(candidate =>
            [candidate.title, candidate.name, candidate.path]
                .some(value => this.normalizeFormExplorerLookupValue(value) === normalizedReference)
        );
        if (exactCandidate) {
            return exactCandidate;
        }

        return candidates.find(candidate =>
            [candidate.title, candidate.name, candidate.path]
                .some(value => this.normalizeFormExplorerLookupValue(value).includes(normalizedReference))
        ) || null;
    }

    private buildFormExplorerElementValueCandidates(
        snapshot: FormExplorerSnapshot,
        elementCandidate: FormExplorerElementCompletionCandidate
    ): string[] {
        const values = new Set<string>();
        if (elementCandidate.valuePreview) {
            values.add(elementCandidate.valuePreview);
        }

        if (elementCandidate.boundAttributePath) {
            const linkedAttribute = snapshot.attributes.find(attribute =>
                this.normalizeFormExplorerLookupValue(attribute.path) === this.normalizeFormExplorerLookupValue(elementCandidate.boundAttributePath)
            );
            if (linkedAttribute?.valuePreview?.trim()) {
                values.add(linkedAttribute.valuePreview.trim());
            }
        }

        return Array.from(values.values());
    }

    private doesFormExplorerValueMatchReference(
        candidateValue: string,
        rawReference: string
    ): boolean {
        const normalizedCandidate = this.normalizeFormExplorerValueLookupValue(candidateValue);
        const normalizedReference = this.normalizeFormExplorerValueLookupValue(rawReference);
        if (!normalizedCandidate || !normalizedReference) {
            return false;
        }

        return normalizedCandidate === normalizedReference || normalizedCandidate.includes(normalizedReference);
    }

    private filterFormExplorerElementCandidatesByValueReferences(
        snapshot: FormExplorerSnapshot,
        candidates: FormExplorerElementCompletionCandidate[],
        rawReferences: string[]
    ): FormExplorerElementCompletionCandidate[] {
        const meaningfulReferences = rawReferences
            .map(reference => String(reference || '').trim())
            .filter(Boolean);
        if (meaningfulReferences.length === 0 || candidates.length === 0) {
            return candidates;
        }

        const filteredCandidates = candidates.filter(candidate => {
            const candidateValues = this.buildFormExplorerElementValueCandidates(snapshot, candidate);
            if (candidateValues.length === 0) {
                return false;
            }

            return meaningfulReferences.some(reference =>
                candidateValues.some(candidateValue => this.doesFormExplorerValueMatchReference(candidateValue, reference))
            );
        });

        return filteredCandidates.length > 0 ? filteredCandidates : candidates;
    }

    private collectFormExplorerCurrentValueCandidates(
        snapshot: FormExplorerSnapshot
    ): string[] {
        const values = new Set<string>();
        const appendValue = (value: string | undefined): void => {
            const normalizedValue = String(value || '').trim();
            if (normalizedValue) {
                values.add(normalizedValue);
            }
        };

        const appendElementValues = (elements: FormExplorerElementInfo[]): void => {
            for (const element of elements) {
                appendValue(element.valuePreview);
                appendElementValues(element.children || []);
            }
        };

        appendElementValues(snapshot.elements || []);
        for (const attribute of snapshot.attributes || []) {
            appendValue(attribute.valuePreview);
        }

        return Array.from(values.values());
    }

    private filterFormExplorerTableColumnsByValueReferences(
        tableCandidate: FormExplorerTableCompletionCandidate,
        rawReferences: string[]
    ): string[] {
        const meaningfulReferences = rawReferences
            .map(reference => String(reference || '').trim())
            .filter(Boolean);
        if (meaningfulReferences.length === 0 || tableCandidate.columns.length === 0) {
            return tableCandidate.columns;
        }

        const matchingColumns = tableCandidate.columns.filter(column => {
            const columnValues = this.buildFormExplorerTableColumnValueCandidates(tableCandidate, column);
            return meaningfulReferences.some(reference =>
                columnValues.some(candidateValue => this.doesFormExplorerValueMatchReference(candidateValue, reference))
            );
        });

        return matchingColumns.length > 0 ? matchingColumns : tableCandidate.columns;
    }

    private buildFormExplorerTableColumnValueCandidates(
        tableCandidate: FormExplorerTableCompletionCandidate,
        rawColumnReference: string
    ): string[] {
        const normalizedReference = this.normalizeFormExplorerLookupValue(rawColumnReference);
        if (!normalizedReference || tableCandidate.columns.length === 0) {
            return [];
        }

        let matchedColumnIndex = tableCandidate.columns.findIndex(column =>
            this.normalizeFormExplorerLookupValue(column) === normalizedReference
        );
        if (matchedColumnIndex < 0) {
            matchedColumnIndex = tableCandidate.columns.findIndex(column =>
                this.normalizeFormExplorerLookupValue(column).includes(normalizedReference)
            );
        }
        if (matchedColumnIndex < 0) {
            return [];
        }

        const uniqueValues = new Set<string>();
        for (const row of tableCandidate.rows) {
            const cellValue = String(row[matchedColumnIndex] || '').trim();
            if (cellValue) {
                uniqueValues.add(cellValue);
            }
        }

        return Array.from(uniqueValues.values());
    }

    private buildFormExplorerSimpleValueCompletionList(
        position: vscode.Position,
        context: QuotedTextCompletionContext,
        values: string[],
        detail: string,
        itemKind: vscode.CompletionItemKind
    ): vscode.CompletionList | null {
        const uniqueValues = Array.from(new Set(
            values
                .map(value => String(value || '').trim())
                .filter(Boolean)
        ));
        if (uniqueValues.length === 0) {
            return null;
        }

        const candidates = uniqueValues
            .map((value, index) => ({
                value,
                index,
                matchResult: this.fuzzyMatch(value, context.typedPrefix)
            }))
            .filter(candidate => candidate.matchResult.matched)
            .sort((left, right) => right.matchResult.score - left.matchResult.score || left.index - right.index);

        if (candidates.length === 0) {
            return null;
        }

        const completionList = new vscode.CompletionList<vscode.CompletionItem>([], false);
        candidates.forEach(candidate => {
            const completionItem = new vscode.CompletionItem({
                label: candidate.value,
                description: detail
            }, itemKind);
            completionItem.insertText = candidate.value;
            completionItem.sortText = `${(1 - candidate.matchResult.score).toFixed(4)}_${candidate.index.toString().padStart(3, '0')}`;
            completionItem.range = new vscode.Range(
                position.line,
                context.startCharacter,
                position.line,
                context.endCharacter
            );
            completionItem.command = {
                title: vscode.l10n.t('Continue with next argument'),
                command: FORM_EXPLORER_ADVANCE_ARGUMENT_COMMAND
            };
            completionList.items.push(completionItem);
        });

        return completionList;
    }

    private buildFormExplorerElementReferenceCompletionList(
        position: vscode.Position,
        context: QuotedTextCompletionContext,
        candidates: FormExplorerElementCompletionCandidate[],
        preferTechnicalName: boolean,
        detailLabel: string
    ): vscode.CompletionList | null {
        const typedPrefixLower = context.typedPrefix.toLocaleLowerCase();
        const filteredCandidates = candidates
            .map((candidate, index) => {
                const insertedValue = (preferTechnicalName ? candidate.name : candidate.title) || candidate.name || candidate.title;
                return {
                    candidate,
                    insertedValue,
                    index,
                    matchResult: this.fuzzyMatch(
                        [
                            insertedValue,
                            candidate.title,
                            candidate.name,
                            candidate.path,
                            candidate.boundAttributePath,
                            candidate.valuePreview
                        ].filter(Boolean).join(' '),
                        context.typedPrefix
                    )
                };
            })
            .filter(candidate => candidate.insertedValue && candidate.matchResult.matched)
            .sort((left, right) => {
                const leftStartsWithPrefix = typedPrefixLower.length > 0
                    && left.insertedValue.toLocaleLowerCase().startsWith(typedPrefixLower) ? 0 : 1;
                const rightStartsWithPrefix = typedPrefixLower.length > 0
                    && right.insertedValue.toLocaleLowerCase().startsWith(typedPrefixLower) ? 0 : 1;
                return leftStartsWithPrefix - rightStartsWithPrefix
                    || right.matchResult.score - left.matchResult.score
                    || left.index - right.index;
            });

        if (filteredCandidates.length === 0) {
            return null;
        }

        const completionList = new vscode.CompletionList<vscode.CompletionItem>([], false);
        filteredCandidates.forEach(candidate => {
            const completionItem = new vscode.CompletionItem({
                label: candidate.insertedValue,
                description: buildVariableValuePreview(candidate.candidate.valuePreview || '')
            }, vscode.CompletionItemKind.Field);
            completionItem.detail = `${detailLabel}${candidate.candidate.name && candidate.candidate.name !== candidate.insertedValue ? ` • ${candidate.candidate.name}` : ''}`;
            completionItem.insertText = candidate.insertedValue;
            completionItem.filterText = [
                candidate.insertedValue,
                candidate.candidate.title,
                candidate.candidate.name,
                candidate.candidate.path,
                candidate.candidate.boundAttributePath
            ].filter(Boolean).join(' ');
            completionItem.sortText = `${(1 - candidate.matchResult.score).toFixed(4)}_${candidate.index.toString().padStart(3, '0')}`;
            completionItem.range = new vscode.Range(
                position.line,
                context.startCharacter,
                position.line,
                context.endCharacter
            );
            completionItem.command = {
                title: vscode.l10n.t('Continue with next argument'),
                command: FORM_EXPLORER_ADVANCE_ARGUMENT_COMMAND
            };

            const documentation = new vscode.MarkdownString();
            documentation.appendMarkdown(`**${detailLabel}:** \`${candidate.insertedValue}\`\n\n`);
            if (candidate.candidate.title && candidate.candidate.title !== candidate.insertedValue) {
                documentation.appendMarkdown(`**${vscode.l10n.t('Title')}:** ${candidate.candidate.title}\n\n`);
            }
            if (candidate.candidate.name && candidate.candidate.name !== candidate.insertedValue) {
                documentation.appendMarkdown(`**${vscode.l10n.t('Name')}:** ${candidate.candidate.name}\n\n`);
            }
            if (candidate.candidate.boundAttributePath) {
                documentation.appendMarkdown(`**${vscode.l10n.t('Bound attribute')}:** \`${candidate.candidate.boundAttributePath}\`\n\n`);
            }
            if (candidate.candidate.valuePreview) {
                this.appendVariableValueMarkdown(documentation, vscode.l10n.t('Value'), candidate.candidate.valuePreview);
            }
            completionItem.documentation = documentation;
            completionList.items.push(completionItem);
        });

        return completionList;
    }

    private buildFormExplorerTableReferenceCompletionList(
        position: vscode.Position,
        context: QuotedTextCompletionContext,
        candidates: FormExplorerTableCompletionCandidate[]
    ): vscode.CompletionList | null {
        const typedPrefixLower = context.typedPrefix.toLocaleLowerCase();
        const filteredCandidates = candidates
            .map((candidate, index) => {
                const insertedValue = candidate.title || candidate.name || candidate.path;
                return {
                    candidate,
                    insertedValue,
                    index,
                    matchResult: this.fuzzyMatch(
                        [candidate.title, candidate.name, candidate.path].filter(Boolean).join(' '),
                        context.typedPrefix
                    )
                };
            })
            .filter(candidate => candidate.insertedValue && candidate.matchResult.matched)
            .sort((left, right) => {
                const leftStartsWithPrefix = typedPrefixLower.length > 0
                    && left.insertedValue.toLocaleLowerCase().startsWith(typedPrefixLower) ? 0 : 1;
                const rightStartsWithPrefix = typedPrefixLower.length > 0
                    && right.insertedValue.toLocaleLowerCase().startsWith(typedPrefixLower) ? 0 : 1;
                return leftStartsWithPrefix - rightStartsWithPrefix
                    || right.matchResult.score - left.matchResult.score
                    || left.index - right.index;
            });

        if (filteredCandidates.length === 0) {
            return null;
        }

        const completionList = new vscode.CompletionList<vscode.CompletionItem>([], false);
        filteredCandidates.forEach(candidate => {
            const completionItem = new vscode.CompletionItem({
                label: candidate.insertedValue,
                description: `${candidate.candidate.columns.length}`
            }, vscode.CompletionItemKind.Struct);
            completionItem.detail = vscode.l10n.t('Form table');
            completionItem.insertText = candidate.insertedValue;
            completionItem.filterText = [candidate.candidate.title, candidate.candidate.name, candidate.candidate.path]
                .filter(Boolean)
                .join(' ');
            completionItem.sortText = `${(1 - candidate.matchResult.score).toFixed(4)}_${candidate.index.toString().padStart(3, '0')}`;
            completionItem.range = new vscode.Range(
                position.line,
                context.startCharacter,
                position.line,
                context.endCharacter
            );
            completionItem.command = {
                title: vscode.l10n.t('Continue with next argument'),
                command: FORM_EXPLORER_ADVANCE_ARGUMENT_COMMAND
            };
            completionList.items.push(completionItem);
        });

        return completionList;
    }

    private async buildFormExplorerQuotedArgumentCompletionList(
        lineText: string,
        position: vscode.Position,
        context: QuotedTextCompletionContext
    ): Promise<vscode.CompletionList | null> {
        const liveSnapshot = await loadLiveFormExplorerSnapshot();
        if (!liveSnapshot) {
            return null;
        }

        const snapshot = liveSnapshot.snapshot;
        const { beforeQuote, afterQuote, combined } = this.getFormExplorerQuotedArgumentSurroundings(lineText, context);
        if (!this.isFormExplorerRelevantQuotedContext(beforeQuote, afterQuote)) {
            return null;
        }

        const preferTechnicalName = /(с именем|with name|named)\s*$/i.test(beforeQuote);
        const elementCandidates = this.collectFormExplorerElementCompletionCandidates(snapshot);
        const tableCandidates = this.collectFormExplorerTableCompletionCandidates(snapshot);
        const nonTableElementCandidates = elementCandidates.filter(candidate => !this.isTableLikeFormExplorerCandidate(candidate));
        const allOtherQuotedValues = context.otherQuotedReferences
            .map(reference => String(reference.value || '').trim())
            .filter(Boolean);
        const otherTableReferenceValues = context.otherQuotedReferences
            .filter(reference => this.isTableReferenceQuotedContext(reference.beforeQuote, reference.afterQuote))
            .map(reference => String(reference.value || '').trim())
            .filter(Boolean);
        const otherFieldReferenceValues = context.otherQuotedReferences
            .filter(reference => this.isFieldReferenceQuotedContext(reference.beforeQuote, reference.afterQuote))
            .map(reference => String(reference.value || '').trim())
            .filter(Boolean);
        const otherElementReferenceValues = context.otherQuotedReferences
            .filter(reference =>
                this.isFieldReferenceQuotedContext(reference.beforeQuote, reference.afterQuote)
                || this.isElementReferenceQuotedContext(reference.beforeQuote, reference.afterQuote)
                || this.isButtonReferenceQuotedContext(reference.beforeQuote, reference.afterQuote)
            )
            .map(reference => String(reference.value || '').trim())
            .filter(Boolean);
        const otherValueReferenceValues = context.otherQuotedReferences
            .filter(reference =>
                !this.isFormExplorerVariableNameSlot(reference.beforeQuote)
                && this.isValueReferenceQuotedContext(reference.beforeQuote, reference.afterQuote)
            )
            .map(reference => String(reference.value || '').trim())
            .filter(Boolean);
        const referencedTableCandidate = this.findMatchingFormExplorerTableCandidateFromReferences(
            tableCandidates,
            otherTableReferenceValues.length > 0
                ? otherTableReferenceValues
                : allOtherQuotedValues
        );
        const referencedElementCandidate = this.findMatchingFormExplorerElementCandidateFromReferences(
            nonTableElementCandidates,
            otherElementReferenceValues.length > 0
                ? otherElementReferenceValues
                : allOtherQuotedValues
        );

        if (this.isTableReferenceQuotedContext(beforeQuote, afterQuote)) {
            return this.buildFormExplorerTableReferenceCompletionList(position, context, tableCandidates);
        }

        if (
            referencedTableCandidate
            && this.isFormExplorerTableLikeLine(combined)
            && this.isFieldReferenceQuotedContext(beforeQuote, afterQuote)
        ) {
            return this.buildFormExplorerSimpleValueCompletionList(
                position,
                context,
                this.filterFormExplorerTableColumnsByValueReferences(referencedTableCandidate, otherValueReferenceValues),
                vscode.l10n.t('Table column'),
                vscode.CompletionItemKind.Field
            );
        }

        if (
            !this.isFormExplorerVariableNameSlot(beforeQuote)
            && !this.isNamedFieldReferenceQuotedContext(beforeQuote)
            && !this.isNamedButtonReferenceQuotedContext(beforeQuote)
            && this.isValueReferenceQuotedContext(beforeQuote, afterQuote)
        ) {
            if (referencedTableCandidate) {
                const matchedColumn = this.findMatchingFormExplorerTableColumnFromReferences(
                    referencedTableCandidate,
                    otherFieldReferenceValues.length > 0
                        ? otherFieldReferenceValues
                        : allOtherQuotedValues
                );
                if (matchedColumn) {
                    const columnValues = this.buildFormExplorerTableColumnValueCandidates(
                        referencedTableCandidate,
                        matchedColumn
                    );
                    const tableValueCompletionList = this.buildFormExplorerSimpleValueCompletionList(
                        position,
                        context,
                        columnValues,
                        vscode.l10n.t('Table value'),
                        vscode.CompletionItemKind.Value
                    );
                    if (tableValueCompletionList) {
                        return tableValueCompletionList;
                    }
                }
            }

            if (referencedElementCandidate) {
                const elementValueCompletionList = this.buildFormExplorerSimpleValueCompletionList(
                    position,
                    context,
                    this.buildFormExplorerElementValueCandidates(snapshot, referencedElementCandidate),
                    vscode.l10n.t('Current form value'),
                    vscode.CompletionItemKind.Value
                );
                if (elementValueCompletionList) {
                    return elementValueCompletionList;
                }
            }

            return this.buildFormExplorerSimpleValueCompletionList(
                position,
                context,
                this.collectFormExplorerCurrentValueCandidates(snapshot),
                vscode.l10n.t('Current form value'),
                vscode.CompletionItemKind.Value
            );
        }

        if (this.isWindowOrFormReferenceQuotedContext(beforeQuote, afterQuote)) {
            const formTitles = [
                snapshot.form?.title,
                snapshot.form?.windowTitle,
                snapshot.form?.name
            ].filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
            return this.buildFormExplorerSimpleValueCompletionList(
                position,
                context,
                formTitles,
                vscode.l10n.t('Form'),
                vscode.CompletionItemKind.Module
            ) ?? new vscode.CompletionList([], false);
        }

        if (this.isButtonReferenceQuotedContext(beforeQuote, afterQuote)) {
            return this.buildFormExplorerElementReferenceCompletionList(
                position,
                context,
                elementCandidates.filter(candidate => this.isButtonLikeFormExplorerCandidate(candidate)),
                preferTechnicalName,
                vscode.l10n.t('Form button')
            );
        }

        if (this.isFieldReferenceQuotedContext(beforeQuote, afterQuote)) {
            if (referencedTableCandidate && this.isFormExplorerTableLikeLine(combined)) {
                const tableColumnCompletionList = this.buildFormExplorerSimpleValueCompletionList(
                    position,
                    context,
                    this.filterFormExplorerTableColumnsByValueReferences(referencedTableCandidate, otherValueReferenceValues),
                    vscode.l10n.t('Table column'),
                    vscode.CompletionItemKind.Field
                );
                if (tableColumnCompletionList) {
                    return tableColumnCompletionList;
                }
            }

            return this.buildFormExplorerElementReferenceCompletionList(
                position,
                context,
                this.filterFormExplorerElementCandidatesByValueReferences(
                    snapshot,
                    nonTableElementCandidates.filter(candidate => this.isFieldLikeFormExplorerCandidate(candidate)),
                    otherValueReferenceValues
                ),
                preferTechnicalName,
                vscode.l10n.t('Form field')
            );
        }

        if (this.isElementReferenceQuotedContext(beforeQuote, afterQuote)) {
            return this.buildFormExplorerElementReferenceCompletionList(
                position,
                context,
                this.filterFormExplorerElementCandidatesByValueReferences(
                    snapshot,
                    nonTableElementCandidates,
                    otherValueReferenceValues
                ),
                preferTechnicalName,
                vscode.l10n.t('Form element')
            );
        }

        if (context.argumentIndex === 0) {
            if (this.isFormExplorerTableLikeLine(combined)) {
                return this.buildFormExplorerTableReferenceCompletionList(position, context, tableCandidates);
            }

            if (this.isFormExplorerButtonLikeLine(combined) && !this.isFormExplorerFieldLikeLine(combined)) {
                return this.buildFormExplorerElementReferenceCompletionList(
                    position,
                    context,
                    elementCandidates.filter(candidate => this.isButtonLikeFormExplorerCandidate(candidate)),
                    preferTechnicalName,
                    vscode.l10n.t('Form button')
                );
            }

            if (this.isFormExplorerFieldLikeLine(combined)) {
                return this.buildFormExplorerElementReferenceCompletionList(
                    position,
                    context,
                    this.filterFormExplorerElementCandidatesByValueReferences(
                        snapshot,
                        nonTableElementCandidates.filter(candidate => this.isFieldLikeFormExplorerCandidate(candidate)),
                        otherValueReferenceValues
                    ),
                    preferTechnicalName,
                    vscode.l10n.t('Form field')
                );
            }

            return this.buildFormExplorerElementReferenceCompletionList(
                position,
                context,
                this.filterFormExplorerElementCandidatesByValueReferences(
                    snapshot,
                    nonTableElementCandidates,
                    otherValueReferenceValues
                ),
                preferTechnicalName,
                vscode.l10n.t('Form element')
            );
        }

        // Fallback for non-first arguments: suggest values for the referenced element,
        // or all current form values when the step context is field/element-like.
        if (this.isFormExplorerFieldLikeLine(combined) || this.isFormExplorerElementLikeLine(combined)) {
            if (referencedElementCandidate) {
                const elementValueCompletionList = this.buildFormExplorerSimpleValueCompletionList(
                    position,
                    context,
                    this.buildFormExplorerElementValueCandidates(snapshot, referencedElementCandidate),
                    vscode.l10n.t('Current form value'),
                    vscode.CompletionItemKind.Value
                );
                if (elementValueCompletionList) {
                    return elementValueCompletionList;
                }
            }

            return this.buildFormExplorerSimpleValueCompletionList(
                position,
                context,
                this.collectFormExplorerCurrentValueCandidates(snapshot),
                vscode.l10n.t('Current form value'),
                vscode.CompletionItemKind.Value
            );
        }

        return null;
    }

    private async buildSavedVariableCompletionList(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: VariableReferenceContext
    ): Promise<vscode.CompletionList> {
        const completionList = new vscode.CompletionList<vscode.CompletionItem>([], false);
        const scenarioLocalVariables = this.collectScenarioVariableDefinitionsBeforeLine(document, position.line, 'saved');
        const scenarioGlobalVariables = this.collectScenarioVariableDefinitionsBeforeLine(document, position.line, 'global');
        const managerGlobalVariables = await this.collectGlobalVariableDefinitions();
        const globalVariables = this.mergeVariableDefinitions(scenarioGlobalVariables, managerGlobalVariables);
        const allVariables = context.mode === 'globalOnly'
            ? globalVariables
            : this.mergeVariableDefinitions(
                this.mergeVariableDefinitions(scenarioLocalVariables, scenarioGlobalVariables),
                globalVariables
            );

        if (allVariables.length === 0) {
            return completionList;
        }

        const typedPrefixLower = context.typedPrefix.toLocaleLowerCase();
        const filteredVariables = allVariables.filter(variable => {
            if (!typedPrefixLower) {
                return true;
            }

            const normalizedName = variable.name.toLocaleLowerCase();
            return normalizedName.startsWith(typedPrefixLower) || normalizedName.includes(typedPrefixLower);
        });

        if (filteredVariables.length === 0) {
            return completionList;
        }

        filteredVariables.forEach((variable, index) => {
            const variableName = variable.name;
            const variableReference = buildVariableReferenceText(variableName, variable.source);
            const completionItem = new vscode.CompletionItem(variableName, vscode.CompletionItemKind.Variable);
            const displayValue = formatVariableValueForDisplay(variable.value, variable.source);
            const preview = buildVariableValuePreview(displayValue);
            completionItem.detail = variable.source === 'global'
                ? vscode.l10n.t('Global variable')
                : vscode.l10n.t('Saved variable');
            completionItem.insertText = variableReference;
            completionItem.filterText = `${variableReference} ${variableName}`;
            completionItem.documentation = this.buildVariableCompletionDocumentation(variable, variableReference, displayValue);
            completionItem.label = {
                label: variableName,
                detail: `  ${variableReference}`,
                description: preview
            };
            completionItem.sortText = `${index.toString().padStart(3, '0')}_${variableName.toLocaleLowerCase()}`;
            completionItem.range = new vscode.Range(
                position.line,
                context.startCharacter,
                position.line,
                position.character
            );
            completionList.items.push(completionItem);
        });

        return completionList;
    }

    private collectScenarioVariableDefinitionsBeforeLine(
        document: vscode.TextDocument,
        lineExclusive: number,
        sourceFilter?: VariableCompletionSource
    ): SavedVariableDefinition[] {
        const variables: SavedVariableDefinition[] = [];
        const seen = new Set<string>();

        for (let line = lineExclusive - 1; line >= 0; line--) {
            const lineText = document.lineAt(line).text;
            const variable = extractSavedVariableFromStepLine(lineText);
            if (!variable) {
                continue;
            }

            if (sourceFilter && variable.source !== sourceFilter) {
                continue;
            }

            const normalized = `${variable.source}:${variable.name.toLocaleLowerCase()}`;
            if (seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            variables.push(variable);
        }

        return variables;
    }

    private async collectGlobalVariableDefinitions(): Promise<SavedVariableDefinition[]> {
        try {
            const manager = YamlParametersManager.getInstance(this.context);
            const globalVariables = await manager.loadGlobalVanessaVariables();
            return globalVariables
                .map(variable => ({
                    name: (variable.key || '').trim(),
                    value: typeof variable.value === 'string' ? variable.value : String(variable.value ?? ''),
                    source: 'global' as const
                }))
                .filter(variable => variable.name.length > 0);
        } catch (error) {
            console.warn('[DriveCompletionProvider] Failed to load GlobalVars for variable completion:', error);
            return [];
        }
    }

    private mergeVariableDefinitions(
        firstVariables: SavedVariableDefinition[],
        secondVariables: SavedVariableDefinition[]
    ): SavedVariableDefinition[] {
        const merged: SavedVariableDefinition[] = [];
        const seen = new Set<string>();

        firstVariables.forEach(variable => {
            const normalized = `${variable.source}:${variable.name.toLocaleLowerCase()}`;
            if (seen.has(normalized)) {
                return;
            }
            seen.add(normalized);
            merged.push(variable);
        });

        secondVariables.forEach(variable => {
            const normalized = `${variable.source}:${variable.name.toLocaleLowerCase()}`;
            if (seen.has(normalized)) {
                return;
            }
            seen.add(normalized);
            merged.push(variable);
        });

        return merged;
    }

    private buildVariableCompletionDocumentation(
        variable: SavedVariableDefinition,
        variableReference: string,
        displayValue: string
    ): vscode.MarkdownString {
        const content = new vscode.MarkdownString();
        const title = variable.source === 'global'
            ? vscode.l10n.t('Global variable')
            : vscode.l10n.t('Saved variable');
        const value = displayValue || ' ';

        content.appendMarkdown(`**${title}:** \`${variableReference}\`\n\n`);
        this.appendVariableValueMarkdown(content, vscode.l10n.t('Value'), value);
        return content;
    }

    private buildScenarioParameterCompletionDocumentation(
        parameterName: string,
        defaultValue: string
    ): vscode.MarkdownString {
        const content = new vscode.MarkdownString();
        content.appendMarkdown(`**${vscode.l10n.t('Scenario parameter')}:** \`[${parameterName}]\`\n\n`);
        this.appendVariableValueMarkdown(content, vscode.l10n.t('Parameter value'), defaultValue);
        return content;
    }

    private appendVariableValueMarkdown(
        markdown: vscode.MarkdownString,
        label: string,
        value: string
    ): void {
        if (!value.includes('\n') && !value.includes('\r')) {
            markdown.appendMarkdown(`**${label}:** \`${value}\``);
            return;
        }

        markdown.appendMarkdown(`**${label}:**\n\n`);
        markdown.appendCodeblock(value);
    }

    private createSemanticStepEntry(
        item: vscode.CompletionItem,
        stepText: string,
        primaryDescription: string,
        relatedTexts: string[] = [],
        language: ScenarioLanguage = 'en'
    ): SemanticStepEntry {
        const normalizedStepText = this.normalizeSemanticSearchText(stepText);
        const normalizedDescriptionText = this.normalizeSemanticSearchText(
            [primaryDescription, ...relatedTexts].filter(Boolean).join(' ')
        );
        const tokens = Array.from(new Set(
            this.extractSemanticSearchTokens(`${normalizedStepText} ${normalizedDescriptionText}`)
        ));

        return {
            item,
            itemText: stepText,
            stepSearchText: normalizedStepText,
            descriptionSearchText: normalizedDescriptionText,
            tokens,
            tokenSet: new Set(tokens),
            semanticNorm: 0,
            language
        };
    }

    private getStepLanguageForItem(item: vscode.CompletionItem): ScenarioLanguage | null {
        return this.gherkinItemLanguageByItem.get(item) || null;
    }

    private buildStepCompletionInsertText(
        stepText: string,
        _indentation: string,
        language: ScenarioLanguage | null,
        baseInsertText?: string | vscode.SnippetString
    ): string | vscode.SnippetString {
        const resolvedInsertText = this.cloneCompletionInsertText(baseInsertText, stepText);
        const isAlreadySnippet = resolvedInsertText instanceof vscode.SnippetString;
        const normalizedInsertText = normalizeMultilineStepInsertText(
            isAlreadySnippet
                ? resolvedInsertText.value
                : resolvedInsertText
        );
        const templateSnippet = buildStepTemplateSnippetData(normalizedInsertText);

        // When base insert text was already a SnippetString (has ${N} tab stops from %N conversion),
        // but buildStepTemplateSnippetData finds no %N-style placeholders (they're already ${N}),
        // preserve the original snippet syntax rather than returning plain text.
        const hasAnyPlaceholders = templateSnippet.hasPlaceholders || isAlreadySnippet;
        const normalizedSnippetText = templateSnippet.hasPlaceholders
            ? templateSnippet.snippetText
            : isAlreadySnippet
                ? normalizedInsertText
                : escapeStepSnippetText(templateSnippet.displayText);

        const openingBlockKeyword = parseBlockKeyword(normalizedInsertText);
        const closingKeyword = getBlockClosingKeyword(
            openingBlockKeyword,
            language ?? this.inferStepLanguageFromText(stepText)
        );
        if (!closingKeyword) {
            return hasAnyPlaceholders
                ? new vscode.SnippetString(normalizedSnippetText)
                : templateSnippet.displayText;
        }

        // VS Code keeps the base indentation of the insertion line for snippet newlines,
        // so only the relative block indent should be added here.
        const innerIndent = '    ';
        return new vscode.SnippetString(
            `${normalizedSnippetText}\n${innerIndent}$0\n${this.escapeSnippetText(closingKeyword)}`
        );
    }

    private cloneCompletionInsertText(
        insertText: string | vscode.SnippetString | undefined,
        fallbackText: string
    ): string | vscode.SnippetString {
        if (insertText instanceof vscode.SnippetString) {
            return new vscode.SnippetString(insertText.value);
        }

        if (typeof insertText === 'string') {
            return insertText;
        }

        return fallbackText;
    }

    private inferStepLanguageFromText(stepText: string): ScenarioLanguage {
        return /[А-Яа-яЁё]/.test(stepText) ? 'ru' : 'en';
    }

    private rebuildSemanticVectorIndex(): void {
        this.semanticIdfByTerm.clear();
        this.semanticPostingsByTerm.clear();
        this.semanticTermsByPrefix.clear();
        this.semanticVectorScoreCache.clear();

        const totalDocuments = this.semanticStepEntries.length;
        if (totalDocuments === 0) {
            return;
        }

        const documentFrequencyByTerm = new Map<string, number>();
        this.semanticStepEntries.forEach(entry => {
            const uniqueTerms = new Set(entry.tokens);
            uniqueTerms.forEach(term => {
                documentFrequencyByTerm.set(term, (documentFrequencyByTerm.get(term) || 0) + 1);
            });
        });

        documentFrequencyByTerm.forEach((documentFrequency, term) => {
            const idf = Math.log((1 + totalDocuments) / (1 + documentFrequency)) + 1;
            this.semanticIdfByTerm.set(term, idf);
        });

        const prefixBuckets = new Map<string, Set<string>>();
        this.semanticIdfByTerm.forEach((_idf, term) => {
            const maxPrefixLength = Math.min(6, term.length);
            for (let prefixLength = 2; prefixLength <= maxPrefixLength; prefixLength++) {
                const prefix = term.slice(0, prefixLength);
                const bucket = prefixBuckets.get(prefix) || new Set<string>();
                bucket.add(term);
                prefixBuckets.set(prefix, bucket);
            }
        });
        prefixBuckets.forEach((bucket, prefix) => {
            this.semanticTermsByPrefix.set(prefix, Array.from(bucket.values()));
        });

        this.semanticStepEntries.forEach((entry, entryIndex) => {
            const uniqueTerms = new Set(entry.tokens);
            let normSquared = 0;

            uniqueTerms.forEach(term => {
                const idf = this.semanticIdfByTerm.get(term);
                if (!idf) {
                    return;
                }

                normSquared += idf * idf;

                const postings = this.semanticPostingsByTerm.get(term) || [];
                postings.push(entryIndex);
                this.semanticPostingsByTerm.set(term, postings);
            });

            entry.semanticNorm = normSquared > 0 ? Math.sqrt(normSquared) : 0;
        });
    }

    private normalizeSemanticSearchText(text: string): string {
        return text
            .replace(/\r\n|\r/g, '\n')
            .replace(/"%\d+\s+[^"]*"|'%\d+\s+[^']*'/g, ' ')
            .replace(/\[[^\]]+\]/g, ' ')
            .replace(/[_:;,.!?(){}[\]"'`~@#$%^&*+=\\/|-]/g, ' ')
            .replace(GHERKIN_KEYWORD_PREFIX_REGEX, '')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/ё/g, 'е')
            .toLocaleLowerCase();
    }

    private stemSemanticToken(token: string): string {
        let stem = token.toLocaleLowerCase().replace(/ё/g, 'е');
        if (stem.length < 4) {
            return stem;
        }

        // Lightweight EN stemming.
        const englishSuffixes = ['ings', 'ing', 'edly', 'ed', 'ies', 'es', 's'];
        for (const suffix of englishSuffixes) {
            if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) {
                stem = stem.slice(0, -suffix.length);
                break;
            }
        }

        // Lightweight RU stemming for frequent inflection endings.
        const russianLongSuffixes = [
            'иями', 'ями', 'ами', 'ого', 'ему', 'ому', 'ыми', 'ими', 'ого', 'его',
            'аться', 'яться', 'иться', 'ться', 'ется', 'ится', 'лась', 'лись', 'лся'
        ];
        for (const suffix of russianLongSuffixes) {
            if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) {
                stem = stem.slice(0, -suffix.length);
                return stem;
            }
        }

        const russianShortSuffixes = [
            'ов', 'ев', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях',
            'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
            'ых', 'их', 'ую', 'юю', 'а', 'я', 'ы', 'и', 'о', 'е', 'у', 'ю'
        ];
        for (const suffix of russianShortSuffixes) {
            if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) {
                stem = stem.slice(0, -suffix.length);
                break;
            }
        }

        return stem;
    }

    private extractSemanticSearchTokens(text: string): string[] {
        const tokens = this.normalizeSemanticSearchText(text)
            .split(/\s+/)
            .map(token => token.trim())
            .filter(token => token.length >= 2);

        const result = new Set<string>();
        for (const token of tokens) {
            result.add(token);
            const stem = this.stemSemanticToken(token);
            if (stem && stem.length >= 2) {
                result.add(stem);
            }
            this.appendSemanticSynonyms(result, token);
            if (stem && stem.length >= 2) {
                this.appendSemanticSynonyms(result, stem);
            }
        }

        return Array.from(result.values());
    }

    private appendSemanticSynonyms(target: Set<string>, token: string): void {
        const normalizedToken = normalizeSemanticSynonymToken(token);
        if (!normalizedToken || normalizedToken.length < 2) {
            return;
        }

        const synonyms = SEMANTIC_SYNONYM_INDEX.get(normalizedToken);
        if (!synonyms || synonyms.length === 0) {
            return;
        }

        synonyms.forEach(value => {
            if (!value || value.length < 2) {
                return;
            }
            target.add(value);
            const stem = this.stemSemanticToken(value);
            if (stem && stem.length >= 2) {
                target.add(stem);
            }
        });
    }

    private extractSemanticStepQuery(input: string): string | null {
        const trimmed = input.trimStart();
        if (!trimmed.startsWith(SEMANTIC_STEP_PREFIX)) {
            return null;
        }
        return trimmed.substring(SEMANTIC_STEP_PREFIX.length).trim();
    }

    private calculateSemanticVectorScores(queryTokens: string[]): Map<number, number> {
        const cacheKey = queryTokens.join(' ');
        const cached = this.semanticVectorScoreCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const scoresByEntry = new Map<number, number>();
        if (queryTokens.length === 0 || this.semanticStepEntries.length === 0 || this.semanticIdfByTerm.size === 0) {
            return scoresByEntry;
        }

        const weightedQueryTerms = new Map<string, number>();
        const uniqueQueryTerms = Array.from(new Set(queryTokens));

        uniqueQueryTerms.forEach(term => {
            if (!term || term.length < 2) {
                return;
            }

            const hasExactTerm = this.semanticIdfByTerm.has(term);
            if (this.semanticIdfByTerm.has(term)) {
                weightedQueryTerms.set(term, Math.max(weightedQueryTerms.get(term) || 0, 1));
            }

            if (term.length >= 3) {
                const prefixKey = term.slice(0, Math.min(6, term.length));
                const prefixCandidates = this.semanticTermsByPrefix.get(prefixKey) || [];
                let added = 0;
                for (const candidate of prefixCandidates) {
                    if (!candidate.startsWith(term) || candidate === term) {
                        continue;
                    }
                    const expansionWeight = hasExactTerm ? 0.35 : 0.6;
                    weightedQueryTerms.set(candidate, Math.max(weightedQueryTerms.get(candidate) || 0, expansionWeight));
                    added++;
                    if (added >= 24) {
                        break;
                    }
                }
            }
        });

        if (weightedQueryTerms.size === 0) {
            return scoresByEntry;
        }

        let queryNormSquared = 0;
        weightedQueryTerms.forEach((queryWeight, term) => {
            const idf = this.semanticIdfByTerm.get(term) || 0;
            if (idf <= 0 || queryWeight <= 0) {
                return;
            }

            const queryTermWeight = queryWeight * idf;
            queryNormSquared += queryTermWeight * queryTermWeight;

            const dotContribution = queryTermWeight * idf;
            const postings = this.semanticPostingsByTerm.get(term) || [];
            for (const entryIndex of postings) {
                scoresByEntry.set(entryIndex, (scoresByEntry.get(entryIndex) || 0) + dotContribution);
            }
        });

        if (queryNormSquared <= 0) {
            return new Map<number, number>();
        }

        const queryNorm = Math.sqrt(queryNormSquared);
        const cosineScores = new Map<number, number>();

        scoresByEntry.forEach((dotProduct, entryIndex) => {
            const entryNorm = this.semanticStepEntries[entryIndex]?.semanticNorm || 0;
            if (entryNorm <= 0) {
                return;
            }
            const cosineScore = dotProduct / (queryNorm * entryNorm);
            if (cosineScore > 0) {
                cosineScores.set(entryIndex, Math.min(1, cosineScore));
            }
        });

        this.semanticVectorScoreCache.set(cacheKey, cosineScores);
        if (this.semanticVectorScoreCache.size > 300) {
            const firstKey = this.semanticVectorScoreCache.keys().next().value;
            if (typeof firstKey === 'string') {
                this.semanticVectorScoreCache.delete(firstKey);
            }
        }

        return cosineScores;
    }

    private getSemanticStepScore(
        entry: SemanticStepEntry,
        normalizedQuery: string,
        queryTokens: string[],
        vectorScore: number
    ): number {
        if (!normalizedQuery) {
            return 0.2;
        }

        const stepMatch = this.fuzzyMatch(entry.stepSearchText, normalizedQuery);
        const descriptionMatch = this.fuzzyMatch(entry.descriptionSearchText, normalizedQuery);
        const bestFuzzy = Math.max(stepMatch.score, descriptionMatch.score * 1.15);

        let tokenScore = 0;
        if (queryTokens.length > 0 && entry.tokenSet.size > 0) {
            const uniqueQueryTerms = new Set(queryTokens.filter(term => term.length >= 2));
            const matchableQueryTerms = new Set<string>();
            uniqueQueryTerms.forEach(term => {
                if (entry.tokenSet.has(term) || this.semanticIdfByTerm.has(term)) {
                    matchableQueryTerms.add(term);
                    return;
                }

                if (term.length < 3) {
                    return;
                }
                const prefixKey = term.slice(0, Math.min(6, term.length));
                const prefixCandidates = this.semanticTermsByPrefix.get(prefixKey) || [];
                if (prefixCandidates.some(candidate => candidate.startsWith(term) && candidate !== term)) {
                    matchableQueryTerms.add(term);
                }
            });

            const denominator = matchableQueryTerms.size > 0 ? matchableQueryTerms.size : uniqueQueryTerms.size;
            let matchedTokens = 0;
            uniqueQueryTerms.forEach(term => {
                if (entry.tokenSet.has(term)) {
                    matchedTokens++;
                }
            });
            tokenScore = denominator > 0 ? matchedTokens / denominator : 0;
        }

        const containsPhrase =
            entry.stepSearchText.includes(normalizedQuery) ||
            entry.descriptionSearchText.includes(normalizedQuery);

        let score = bestFuzzy * 0.4 + tokenScore * 0.35 + vectorScore * 0.75;
        if (containsPhrase) {
            score += 0.1;
        }

        return Math.min(1, score);
    }

    private buildSemanticStepCompletionList(
        position: vscode.Position,
        indentation: string,
        semanticQuery: string,
        typedSemanticInput: string,
        preferredLanguage: ScenarioLanguage
    ): vscode.CompletionList {
        // Re-query semantic results as user types so relevance does not depend on
        // whether a trailing space/trigger character was entered.
        const completionList = new vscode.CompletionList<vscode.CompletionItem>([], true);
        if (this.semanticStepEntries.length === 0) {
            return completionList;
        }

        const normalizedQuery = this.normalizeSemanticSearchText(semanticQuery);
        const queryTokens = this.extractSemanticSearchTokens(normalizedQuery);
        const vectorScores = this.calculateSemanticVectorScores(queryTokens);
        const rawFilterKey = (typedSemanticInput || '').trim();
        const normalizedFilterKey = this.normalizeSemanticSearchText(rawFilterKey);

        const candidateIndices = new Set<number>();
        if (!normalizedQuery) {
            for (let index = 0; index < Math.min(60, this.semanticStepEntries.length); index++) {
                candidateIndices.add(index);
            }
        } else {
            vectorScores.forEach((_score, entryIndex) => {
                candidateIndices.add(entryIndex);
            });

            if (candidateIndices.size === 0) {
                this.semanticStepEntries.forEach((entry, entryIndex) => {
                    if (entry.stepSearchText.includes(normalizedQuery) || entry.descriptionSearchText.includes(normalizedQuery)) {
                        candidateIndices.add(entryIndex);
                    }
                });
            }

            if (candidateIndices.size === 0) {
                for (let index = 0; index < Math.min(120, this.semanticStepEntries.length); index++) {
                    candidateIndices.add(index);
                }
            }
        }

        const ranked = Array.from(candidateIndices.values())
            .map(entryIndex => {
                const entry = this.semanticStepEntries[entryIndex];
                return {
                    entryIndex,
                    entry,
                    languageBucket: entry.language === preferredLanguage ? 0 : 1,
                    score: this.getSemanticStepScore(
                        entry,
                        normalizedQuery,
                        queryTokens,
                        vectorScores.get(entryIndex) || 0
                    )
                };
            })
            .filter(item => item.languageBucket === 0)
            .filter(item => normalizedQuery.length === 0 || item.score >= 0.2)
            .sort((left, right) => {
                return right.score - left.score;
            })
            .slice(0, 20);

        ranked.forEach((result, index) => {
            const baseItem = result.entry.item;
            const itemFullText = result.entry.itemText;
            const completionItem = new vscode.CompletionItem(itemFullText, baseItem.kind);
            completionItem.documentation = baseItem.documentation;
            completionItem.detail = baseItem.detail
                ? `${baseItem.detail} · ${vscode.l10n.t('semantic match')}`
                : vscode.l10n.t('semantic match');

            const replacementRange = new vscode.Range(
                position.line,
                indentation.length,
                position.line,
                position.character
            );
            completionItem.range = replacementRange;
            completionItem.insertText = this.buildStepCompletionInsertText(
                itemFullText,
                indentation,
                result.entry.language,
                baseItem.insertText
            );
            if (completionItem.insertText instanceof vscode.SnippetString) {
                completionItem.command = {
                    title: vscode.l10n.t('Suggest'),
                    command: FORM_EXPLORER_INITIAL_SUGGEST_COMMAND
                };
            }
            completionItem.filterText = [
                rawFilterKey,
                normalizedFilterKey,
                normalizedQuery,
                result.entry.stepSearchText,
                result.entry.descriptionSearchText,
                itemFullText
            ].filter(Boolean).join(' ');
            completionItem.sortText = `0${result.languageBucket}${(1 - result.score).toFixed(4)}_${index.toString().padStart(2, '0')}`;
            completionList.items.push(completionItem);
        });

        return completionList;
    }

    /**
     * Выполняет нечеткое сопоставление шаблона и введенного текста
     * @param pattern Шаблон для сравнения
     * @param input Введенный пользователем текст
     * @returns Объект с флагом соответствия и оценкой совпадения (0-1)
     */
    private fuzzyMatch(pattern: string, input: string): { matched: boolean, score: number } {
        const patternLower = pattern.toLowerCase();
        const inputLower = input.toLowerCase();

        if (!inputLower) {
            return { matched: true, score: 0.1 };
        }

        // 1. Точное совпадение начала строки
        if (patternLower.startsWith(inputLower)) {
            // Чем длиннее совпадение относительно общей длины шаблона, тем выше оценка
            return { matched: true, score: 0.8 + (inputLower.length / patternLower.length) * 0.2 }; // Score 0.8 to 1.0
        }

        // 2. Ввод является подстрокой шаблона (не обязательно с начала)
        if (patternLower.includes(inputLower)) {
            const startIndex = patternLower.indexOf(inputLower);
            // Оценка выше, если подстрока длиннее и ближе к началу
            return { matched: true, score: 0.6 + (inputLower.length / patternLower.length) * 0.1 - (startIndex / patternLower.length) * 0.1 }; // Score ~0.5 to ~0.7
        }

        // 3. Сопоставление по словам
        const patternWords = patternLower.split(/\s+/).filter(w => w.length > 0);
        const inputWords = inputLower.split(/\s+/).filter(w => w.length > 0);

        if (inputWords.length === 0) { // Если ввод есть, но не разделяется на слова (например, одно слово без пробелов)
             for (const pWord of patternWords) {
                 if (pWord.startsWith(inputLower)) return {matched: true, score: 0.55}; // Если одно из слов шаблона начинается с введенного текста
             }
             return { matched: false, score: 0 }; // Если одиночное слово ввода не найдено как начало ни одного слова шаблона
        }

        let matchedWordCount = 0;
        let firstMatchInPatternIndex = -1;
        let lastMatchInPatternIndex = -1;
        let orderMaintained = true;
        let currentPatternWordIndex = -1;

        for (let i = 0; i < inputWords.length; i++) {
            const inputWord = inputWords[i];
            let foundThisWord = false;
            for (let j = currentPatternWordIndex + 1; j < patternWords.length; j++) {
                const patternWord = patternWords[j];
                if (patternWord.startsWith(inputWord)) {
                    matchedWordCount++;
                    if (firstMatchInPatternIndex === -1) firstMatchInPatternIndex = j;
                    lastMatchInPatternIndex = j;
                    currentPatternWordIndex = j; // Для проверки порядка
                    foundThisWord = true;
                    break;
                }
            }
            if (!foundThisWord && i > 0) { // Если не первое слово ввода не найдено, порядок нарушен
                orderMaintained = false;
            }
        }

        if (matchedWordCount > 0) {
            const matchRatio = matchedWordCount / inputWords.length; // Насколько полно совпали слова ввода
            let score = 0.3 + (matchRatio * 0.2); // Базовая оценка за совпадение слов (0.3 до 0.5)

            if (orderMaintained && matchedWordCount === inputWords.length) {
                score += 0.1; // Бонус за полный порядок
                if (firstMatchInPatternIndex === 0) {
                    score += 0.05; // Небольшой бонус, если совпадение началось с первого слова шаблона
                }
            }
            // Учитываем "плотность" совпавших слов в шаблоне
            if (lastMatchInPatternIndex !== -1 && firstMatchInPatternIndex !== -1 && matchedWordCount > 1) {
                const spread = lastMatchInPatternIndex - firstMatchInPatternIndex + 1;
                score += (matchedWordCount / spread) * 0.05; // Бонус за "кучность"
            }

            return { matched: true, score: Math.min(score, 0.65) }; // Ограничиваем максимальную оценку для этого типа совпадения
        }

        return { matched: false, score: 0 };
    }

    /**
     * Проверяет, находится ли позиция в блоке текста сценария
     */
    private isInScenarioTextBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
        if (this.isFeatureDocument(document)) {
            return this.isInFeatureScenarioBlock(document, position.line);
        }

        // Простая проверка: работаем только с YAML файлами
        if (document.fileName.toLowerCase().endsWith('.yaml')) {
            // Ищем "ТекстСценария:" до текущей позиции курсора
            const textUpToPosition = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const scenarioBlockStartRegex = /ТекстСценария:\s*\|?\s*(\r\n|\r|\n)/m; // 'm' для многострочного поиска
            let lastScenarioBlockStartOffset = -1;
            let match;

            // Находим последнее вхождение "ТекстСценария:" перед курсором
            const globalRegex = new RegExp(scenarioBlockStartRegex.source, 'gm');
            while((match = globalRegex.exec(textUpToPosition)) !== null) {
                lastScenarioBlockStartOffset = match.index + match[0].length; // Запоминаем позицию ПОСЛЕ найденного блока
            }

            if (lastScenarioBlockStartOffset === -1) {
                // console.log("[isInScenarioTextBlock] 'ТекстСценария:' not found before cursor.");
                return false; // Блок "ТекстСценария:" не найден перед курсором
            }

            // Теперь проверяем, не вышли ли мы из этого блока в другую секцию YAML
            // Берем текст от начала последнего найденного блока "ТекстСценария:" до текущей позиции курсора
            const textAfterLastBlockStart = textUpToPosition.substring(lastScenarioBlockStartOffset);

            // Ищем строки, которые начинаются без отступа (или с меньшим отступом, чем ожидается для шагов)
            // и содержат двоеточие, что указывает на новую секцию YAML.
            // Шаги Gherkin обычно имеют отступ (например, 4 пробела или 1 таб).
            // Секции YAML верхнего уровня (ДанныеСценария, ПараметрыСценария, ВложенныеСценарии) обычно начинаются без отступа или с меньшим.
            const linesInBlock = textAfterLastBlockStart.split(/\r\n|\r|\n/);
            for (const line of linesInBlock) {
                const trimmedLine = line.trim();
                if (trimmedLine === "") continue; // Пропускаем пустые строки
                if (trimmedLine.startsWith("#")) continue; // Пропускаем комментарии

                // Если строка не начинается с пробела (или таба) и содержит ':' и это не строка продолжения многострочного текста (|)
                // Это эвристика для определения новой секции YAML
                if (!line.startsWith(" ") && !line.startsWith("\t") && trimmedLine.includes(":") && !trimmedLine.startsWith("|")) {
                    // console.log(`[isInScenarioTextBlock] New YAML section found: '${trimmedLine}'. Exiting block.`);
                    return false; // Нашли новую секцию YAML, значит мы уже не в "ТекстСценария:"
                }
            }
            // console.log("[isInScenarioTextBlock] Cursor is within 'ТекстСценария:' block.");
            return true; // Если новых секций не найдено, считаем, что мы в блоке
        }
        return false;
    }

    private isFeatureDocument(document: vscode.TextDocument): boolean {
        return document.fileName.toLowerCase().endsWith('.feature');
    }

    private isInFeatureScenarioBlock(document: vscode.TextDocument, lineIndex: number): boolean {
        const currentLine = document.lineAt(lineIndex).text.trim();
        if (currentLine.startsWith('#')) {
            return false;
        }
        if (currentLine.startsWith('@') || currentLine.startsWith('|') || currentLine.startsWith('"""')) {
            return false;
        }
        if (/^(?:Feature|Функционал|Rule|Правило|Scenario|Сценарий|Scenario Outline|Структура сценария|Examples|Примеры|Scenarios|Сценарии)\s*:/i.test(currentLine)) {
            return false;
        }

        for (let line = lineIndex; line >= 0; line--) {
            const trimmed = document.lineAt(line).text.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) {
                continue;
            }

            if (/^(?:Scenario|Сценарий|Scenario Outline|Структура сценария|Background|Предыстория)\s*:/i.test(trimmed)) {
                return true;
            }

            if (/^(?:Feature|Функционал|Rule|Правило|Examples|Примеры)\s*:?/i.test(trimmed)) {
                return false;
            }
        }

        return false;
    }

    /**
     * Нормализует переносы строк, удаляя лишние пустые строки
     */
    private normalizeLineBreaks(text: string): string {
        return text.replace(/\n\s*\n/g, '\n').trim();
    }

    private appendCompactMultilineText(markdown: vscode.MarkdownString, text: string): void {
        const normalized = text.replace(/\r\n|\r/g, '\n').trim();
        if (!normalized) {
            return;
        }

        const collapsedLines: string[] = [];
        let previousWasBlank = false;
        for (const rawLine of normalized.split('\n')) {
            const line = rawLine.replace(/\s+$/g, '');
            const isBlank = line.trim().length === 0;
            if (isBlank) {
                if (!previousWasBlank) {
                    collapsedLines.push('');
                }
                previousWasBlank = true;
                continue;
            }

            collapsedLines.push(line);
            previousWasBlank = false;
        }

        while (collapsedLines.length > 0 && collapsedLines[0] === '') {
            collapsedLines.shift();
        }
        while (collapsedLines.length > 0 && collapsedLines[collapsedLines.length - 1] === '') {
            collapsedLines.pop();
        }

        collapsedLines.forEach((line, index) => {
            if (line === '') {
                markdown.appendMarkdown('\n');
                return;
            }

            markdown.appendText(line);
            if (index < collapsedLines.length - 1) {
                markdown.appendMarkdown('  \n');
            }
        });
    }

    private getScenarioParameterDefaults(document: vscode.TextDocument): Map<string, string> {
        const key = document.uri.toString();
        const cached = this.scenarioDefaultsByDocument.get(key);
        if (cached && cached.version === document.version) {
            return cached.defaults;
        }

        const defaults = parseScenarioParameterDefaults(document.getText());
        this.scenarioDefaultsByDocument.set(key, {
            version: document.version,
            defaults
        });
        return defaults;
    }

    private buildScenarioCallInsertText(
        scenarioName: string,
        lineIndent: string,
        firstLinePrefix: string,
        defaults: Map<string, string>,
        scenarioCallKeyword: string
    ): string | vscode.SnippetString {
        if (!scenarioName) {
            return `${firstLinePrefix}${scenarioCallKeyword} `;
        }

        const params = this.scenarioParametersByName.get(scenarioName) || [];
        if (params.length === 0) {
            return `${firstLinePrefix}${scenarioCallKeyword} ${scenarioName}`;
        }

        const maxParamLength = params.reduce((max, param) => Math.max(max, param.length), 0);
        const paramIndent = firstLinePrefix.length > 0 ? `${lineIndent}    ` : '    ';
        let snippetText = `${firstLinePrefix}${scenarioCallKeyword} ${scenarioName}`;
        let paramIndex = 1;

        params.forEach(paramName => {
            const alignedName = paramName.padEnd(maxParamLength, ' ');
            const calledScenarioDefaults = this.calledScenarioDefaultsByName.get(scenarioName);
            const defaultValue = calledScenarioDefaults?.get(paramName) ?? defaults.get(paramName) ?? `"${paramName}"`;
            const escapedDefault = this.escapeSnippetDefaultValue(defaultValue);
            snippetText += `\n${paramIndent}${alignedName} = \${${paramIndex++}:${escapedDefault}}`;
        });

        return new vscode.SnippetString(snippetText);
    }

    private escapeSnippetText(value: string): string {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/\$/g, '\\$')
            .replace(/\}/g, '\\}');
    }

    private escapeSnippetDefaultValue(value: string): string {
        return this.escapeSnippetText(value);
    }
}
