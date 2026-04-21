import * as vscode from 'vscode';
import {
    buildAiEndpoint,
    ensureAiConnectionSettingsComplete,
    getAiConnectionSettings,
    requestTextFromAi,
    type AiConnectionSettings,
    type AiOutputLanguage
} from './aiClient';
import { normalizeGeneratedKotDescription, upsertKotScenarioDescription } from './kotMetadataDescription';
import { migrateLegacyPhaseSwitcherMetadata, parsePhaseSwitcherMetadata } from './phaseSwitcherMetadata';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';
import { isScenarioYamlFile } from './yamlValidator';

interface ScenarioAiSettings extends AiConnectionSettings {
    maxLineLength: number;
    systemPrompt: string;
}

interface DescriptionOutputFormat {
    checkedLabel: string;
    processLabel: string;
    parametersLabel: string;
    improvementLabel: string;
    languageInstructionLabel: string;
    missingValue: string;
}

interface ScenarioPromptBuildOptions {
    scenarioBodyCharLimit: number;
    includeNestedScenarioNames: boolean;
    nestedScenarioLimit: number;
}

interface ScenarioAnalysisContext {
    documentText: string;
    documentUri: vscode.Uri;
    scenarioHeaderSummary: string[];
    declaredParameters: Map<string, string>;
    parameterLines: string[];
    usedPlaceholderLines: string[];
    nestedScenarioNames: string[];
    scenarioBody: string;
    structureHints: string[];
    reportHints: string[];
    isStandaloneMainScenario: boolean;
    phaseSwitcherTabName?: string;
}

interface ScenarioBodyChunk {
    index: number;
    total: number;
    startLineNumber: number;
    endLineNumber: number;
    title: string;
    structureHints: string[];
    reportHints: string[];
    text: string;
}

interface ScenarioChunkSummary {
    index: number;
    title: string;
    purpose: string[];
    actions: string[];
    checks: string[];
    parameters: string[];
    reports: string[];
}

interface ScenarioFactSnapshot {
    checked: string[];
    process: string[];
    parameters: string[];
    critical: string[];
}

interface ScenarioCoverageGroup {
    label: string;
    anchors: string[];
    priority: 'required' | 'important';
}

type ScenarioSemanticKind =
    | 'setup'
    | 'profile_switch'
    | 'mode_switch'
    | 'balance_check'
    | 'document_flow'
    | 'register_check'
    | 'report_check'
    | 'tax_check'
    | 'currency_check'
    | 'generic_action'
    | 'generic_check';

interface ScenarioSemanticFact {
    kind: ScenarioSemanticKind;
    subject: string;
    raw: string;
    detail?: string;
}

const DEFAULT_SYSTEM_PROMPT = [
    'Ты помогаешь документировать YAML/BDD тесты KOT для 1С.',
    'Нужно вернуть только готовый текст для блока KOTМетаданные.Описание.',
    'Опиши, что именно проверяет тест, какой бизнес-процесс проходит, какие параметры и развилки в нем есть.',
    'Предпочитай содержательное, достаточно подробное описание вместо слишком короткого summary.',
    'Не выдумывай факты, которых нет в сценарии.',
    'Без markdown, без заголовков, без списков, без code fence.',
    'Следуй формату ответа, который будет указан в пользовательском сообщении.'
].join('\n');

const FACT_EXTRACTION_SYSTEM_PROMPT = [
    'Ты помогаешь разбирать длинные YAML/BDD тесты KOT для 1С.',
    'Нужно извлекать только факты из фрагмента сценария без домыслов.',
    'Не пиши итоговое описание целиком и не добавляй лишний текст.',
    'Строго следуй формату CHECKED/PROCESS/PARAMETERS/CRITICAL.'
].join('\n');

const CHUNK_SUMMARY_SYSTEM_PROMPT = [
    'Ты помогаешь разбирать длинные YAML/BDD тесты KOT для 1С.',
    'Нужно по каждому последовательному фрагменту сценария извлечь бизнес-смысл, ключевые действия, проверки, данные и отчеты.',
    'Не пересказывай каждое открытое окно и каждый клик.',
    'Строго следуй формату PURPOSE/ACTIONS/CHECKS/PARAMETERS/REPORTS.'
].join('\n');

function getScenarioAiSettings(scopeUri: vscode.Uri): ScenarioAiSettings {
    const config = vscode.workspace.getConfiguration('kotTestToolkit.ai', scopeUri);
    const connectionSettings = getAiConnectionSettings(scopeUri);
    const systemPrompt = config.get<string>('systemPrompt', '').trim();

    return {
        ...connectionSettings,
        maxLineLength: Math.max(40, config.get<number>('maxLineLength', 100)),
        systemPrompt: systemPrompt.length > 0 ? systemPrompt : DEFAULT_SYSTEM_PROMPT
    };
}

function getDescriptionOutputFormat(outputLanguage: AiOutputLanguage): DescriptionOutputFormat {
    if (outputLanguage === 'en') {
        return {
            checkedLabel: 'What is checked',
            processLabel: 'Process',
            parametersLabel: 'Parameters and branches',
            improvementLabel: 'What can be improved',
            languageInstructionLabel: 'English',
            missingValue: 'not specified'
        };
    }

    return {
        checkedLabel: 'Проверяется',
        processLabel: 'Процесс',
        parametersLabel: 'Параметры и развилки',
        improvementLabel: 'Что можно улучшить',
        languageInstructionLabel: 'русском',
        missingValue: 'не выделены'
    };
}

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeStructuredValue(rawValue: string): string {
    return rawValue
        .replace(/\r\n|\r/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
}

type StructuredSectionKey = 'checked' | 'process' | 'parameters' | 'improvement';

function splitStructuredSectionLine(
    line: string,
    sectionKey: StructuredSectionKey,
    outputLanguage: AiOutputLanguage
): string[] {
    const normalizedLine = line.trim();
    if (normalizedLine.length === 0) {
        return [];
    }

    if (/^[-*•]\s+/.test(normalizedLine)) {
        return [normalizedLine.replace(/^[-*•]\s+/, '').trim()];
    }

    const checkedStarters = outputLanguage === 'en'
        ? ['Checks', 'Coverage', 'Business branches', 'Validates', 'Includes', 'Confirms', 'Covers']
        : ['Проверки', 'Покрываемые', 'Сквозное', 'Корректность', 'Подтверждает', 'Включает', 'Охватывает', 'Самостоятельный'];
    const processStarters = outputLanguage === 'en'
        ? ['Setup', 'Preparation', 'Checks in mode', 'Temporary', 'Re-enabling', 'Block', 'Stage', 'Case']
        : ['подготовка', 'предусловия', 'проверки в режиме', 'временное', 'повторное', 'блок', 'этап', 'выполняется', 'запускается', 'формируется', 'создаются', 'оформляется', 'проводится', 'создается', 'поступает', 'case'];
    const parameterStarters = outputLanguage === 'en'
        ? ['Branch condition', 'Key business data', 'Control values', 'Important dates', 'Static data', 'Parameters']
        : ['Условие ветки', 'Ключевые', 'Контрольные', 'Важные', 'Логические', 'Статические', 'Основные'];
    const improvementStarters = outputLanguage === 'en'
        ? ['Split', 'Remove', 'Replace', 'Move', 'Separate']
        : ['Разделить', 'Убрать', 'Заменить', 'Вынести', 'Разнести'];

    const starters = sectionKey === 'checked'
        ? checkedStarters
        : sectionKey === 'process'
            ? processStarters
            : sectionKey === 'parameters'
                ? parameterStarters
                : improvementStarters;

    const escapeStarter = (value: string) => escapeRegexLiteral(value).replace(/\s+/g, '\\s+');
    const inlineSplitPattern = new RegExp(
        `\\s+(?=(?:${starters.map(escapeStarter).join('|')})\\b)`,
        outputLanguage === 'en' ? 'i' : 'iu'
    );

    const semicolonSplitPattern = sectionKey === 'process'
        ? /\s*;\s+(?=(?:переключение|проверки|создание|запуск|формирование|вызывается|выполняется|подключение|Checks|Switch|Create|Generate|Run)\b)/i
        : null;

    const parts = normalizedLine
        .split(inlineSplitPattern)
        .flatMap(part => semicolonSplitPattern ? part.split(semicolonSplitPattern) : [part])
        .map(part => sanitizeStructuredValue(part))
        .filter(Boolean);

    return parts.length > 0 ? parts : [sanitizeStructuredValue(normalizedLine)];
}

function normalizeStructuredSectionValue(
    rawValue: string,
    sectionKey: StructuredSectionKey,
    outputLanguage: AiOutputLanguage
): string {
    const normalized = rawValue
        .replace(/\r\n|\r/g, '\n')
        .replace(/([.!?;:])\s+[-*•]\s+/g, '$1\n- ')
        .replace(/([)])\s+[-*•]\s+/g, '$1\n- ')
        .trim();

    if (normalized.length === 0) {
        return '';
    }

    const lines = normalized
        .split('\n')
        .map(line => line.replace(/\t/g, '    ').replace(/\s+$/g, ''))
        .filter(line => line.trim().length > 0);

    const hasBullets = lines.some(line => /^\s*[-*•]\s+/.test(line));
    if (hasBullets) {
        const normalizedBulletLines: string[] = [];

        for (const line of lines) {
            if (/^\s*[-*•]\s+/.test(line)) {
                const indent = line.match(/^\s*/)?.[0] || '';
                const normalizedIndent = indent.length >= 2 ? '  ' : '';
                const value = line.replace(/^\s*[-*•]\s+/, '').trim();
                if (value.length > 0) {
                    normalizedBulletLines.push(`${normalizedIndent}- ${value}`);
                }
                continue;
            }

            const value = sanitizeStructuredValue(line);
            if (value.length === 0) {
                continue;
            }

            if (normalizedBulletLines.length > 0) {
                normalizedBulletLines[normalizedBulletLines.length - 1] = `${normalizedBulletLines[normalizedBulletLines.length - 1]} ${value}`;
            } else {
                normalizedBulletLines.push(value);
            }
        }

        return normalizedBulletLines.join('\n').trim();
    }

    const items = lines.flatMap(line => splitStructuredSectionLine(line.trim(), sectionKey, outputLanguage));

    const normalizedItems = dedupeOrdered(items.filter(Boolean), 12);
    if (normalizedItems.length <= 1) {
        return normalizedItems[0] || '';
    }

    return normalizedItems
        .map(line => `- ${line}`)
        .join('\n');
}

function trimTrailingSentence(value: string): string {
    return value.replace(/[.\s]+$/g, '').trim();
}

function normalizeImprovementValue(rawValue: string, outputLanguage: AiOutputLanguage): string {
    const normalized = sanitizeStructuredValue(rawValue);
    if (normalized.length === 0) {
        return '';
    }

    const genericNegativePatterns = outputLanguage === 'en'
        ? [
            /^(none|nothing|no improvements?)\.?$/i,
            /^no specific improvements?.*$/i,
            /^not required\.?$/i
        ]
        : [
            /^(нет|ничего)\.?$/i,
            /^улучшений нет\.?$/i,
            /^нет явных улучшений.*$/i,
            /^не требуется\.?$/i,
            /^улучшать нечего\.?$/i
        ];

    for (const pattern of genericNegativePatterns) {
        if (pattern.test(normalized)) {
            return '';
        }
    }

    const vaguePatterns = outputLanguage === 'en'
        ? [
            /^the test can be improved.*$/i,
            /^it can be improved.*$/i,
            /^add checks\.?$/i,
            /^clarify the business logic.*$/i,
            /^add scenarios? for no data.*$/i,
            /^add scenarios? for invalid input.*$/i,
            /^it is recommended to add.*$/i
        ]
        : [
            /^тест может быть улучшен.*$/i,
            /^можно улучшить тест.*$/i,
            /^добавить проверки\.?$/i,
            /^добавить больше проверок\.?$/i,
            /^дополнить разъяснени(?:ем|я).*$/i,
            /^рекомендуется добавить.*$/i,
            /^добавить проверк[ауи].*отсутстви.*данн.*$/i,
            /^добавить проверк[ауи].*ошибк.*ввода.*$/i,
            /^добавить дополнительн(?:ые|ых).*(?:сценар|ветк).*$/i
        ];

    for (const pattern of vaguePatterns) {
        if (pattern.test(normalized)) {
            return '';
        }
    }

    const prohibitedSubstrings = outputLanguage === 'en'
        ? [
            'clarify the business logic',
            'no data',
            'invalid input',
            'additional scenarios'
        ]
        : [
            'разъяснением бизнес-логики',
            'разъяснение бизнес-логики',
            'отсутствии данных',
            'отсутствие данных',
            'ошибке ввода',
            'ошибка ввода',
            'дополнительных сценариев'
        ];

    for (const fragment of prohibitedSubstrings) {
        if (normalized.toLowerCase().includes(fragment.toLowerCase())) {
            return '';
        }
    }

    return normalized;
}

function buildStructuredScenarioDescription(
    sections: {
        checked: string;
        process: string;
        parameters: string;
        improvement: string;
    },
    outputLanguage: AiOutputLanguage
): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    const checked = normalizeStructuredSectionValue(sections.checked, 'checked', outputLanguage);
    const process = normalizeStructuredSectionValue(sections.process, 'process', outputLanguage);
    const parameters = normalizeStructuredSectionValue(sections.parameters, 'parameters', outputLanguage);
    const normalizedImprovement = normalizeStructuredSectionValue(
        normalizeImprovementValue(sections.improvement, outputLanguage),
        'improvement',
        outputLanguage
    );

    const lines = [
        checked.startsWith('- ')
            ? `${format.checkedLabel}:\n${checked}`
            : `${format.checkedLabel}: ${checked || format.missingValue}`,
        '',
        process.startsWith('- ')
            ? `${format.processLabel}:\n${process}`
            : `${format.processLabel}: ${process || format.missingValue}`,
        '',
        parameters.startsWith('- ')
            ? `${format.parametersLabel}:\n${parameters}`
            : `${format.parametersLabel}: ${parameters || format.missingValue}`
    ];

    if (normalizedImprovement.length > 0) {
        lines.push('');
        lines.push(
            normalizedImprovement.startsWith('- ')
                ? `(${format.improvementLabel}:\n${normalizedImprovement})`
                : `(${format.improvementLabel}: ${normalizedImprovement})`
        );
    }

    return lines.join('\n');
}

function tryNormalizeStructuredScenarioDescription(rawValue: string, outputLanguage: AiOutputLanguage): string {
    const normalized = normalizeGeneratedKotDescription(rawValue);
    const format = getDescriptionOutputFormat(outputLanguage);
    const sectionPatterns: Array<{
        key: 'checked' | 'process' | 'parameters' | 'improvement';
        regex: RegExp;
    }> = [
        {
            key: 'checked',
            regex: new RegExp(`^(?:[-*•]\\s*)?${escapeRegexLiteral(format.checkedLabel)}:\\s*(.*)$`, 'i')
        },
        {
            key: 'process',
            regex: new RegExp(`^(?:[-*•]\\s*)?${escapeRegexLiteral(format.processLabel)}:\\s*(.*)$`, 'i')
        },
        {
            key: 'parameters',
            regex: new RegExp(`^(?:[-*•]\\s*)?${escapeRegexLiteral(format.parametersLabel)}:\\s*(.*)$`, 'i')
        },
        {
            key: 'improvement',
            regex: new RegExp(`^(?:[-*•]\\s*)?\\(?${escapeRegexLiteral(format.improvementLabel)}:\\s*(.*?)\\)?$`, 'i')
        }
    ];

    const sectionLines: Record<'checked' | 'process' | 'parameters' | 'improvement', string[]> = {
        checked: [],
        process: [],
        parameters: [],
        improvement: []
    };

    let currentSection: keyof typeof sectionLines | null = null;

    for (const rawLine of normalized.split('\n')) {
        const trimmedLine = rawLine.trim();
        if (trimmedLine.length === 0) {
            continue;
        }

        let matchedSection: keyof typeof sectionLines | null = null;
        let matchedValue = '';

        for (const sectionPattern of sectionPatterns) {
            const match = trimmedLine.match(sectionPattern.regex);
            if (!match) {
                continue;
            }

            matchedSection = sectionPattern.key;
            matchedValue = match[1] || '';
            break;
        }

        if (matchedSection) {
            currentSection = matchedSection;
            if (matchedValue.trim().length > 0) {
                sectionLines[matchedSection].push(matchedValue.trim());
            }
            continue;
        }

        if (currentSection) {
            sectionLines[currentSection].push(trimmedLine);
        }
    }

    const checked = normalizeStructuredSectionValue(sectionLines.checked.join('\n'), 'checked', outputLanguage);
    const process = normalizeStructuredSectionValue(sectionLines.process.join('\n'), 'process', outputLanguage);
    const parameters = normalizeStructuredSectionValue(sectionLines.parameters.join('\n'), 'parameters', outputLanguage);
    const improvement = normalizeImprovementValue(sectionLines.improvement.join(' '), outputLanguage);

    if (checked || process || parameters || improvement) {
        return buildStructuredScenarioDescription({
            checked,
            process,
            parameters,
            improvement
        }, outputLanguage);
    }

    return normalized;
}

function buildFallbackScenarioDescription(rawValue: string, outputLanguage: AiOutputLanguage): string {
    const normalized = normalizeGeneratedKotDescription(rawValue);
    if (normalized.length === 0) {
        return '';
    }

    const format = getDescriptionOutputFormat(outputLanguage);
    const lines = normalized
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return '';
    }

    const combined = lines.join(' ');
    const improvementMatch = combined.match(/\(([^()]{6,})\)\s*$/);
    const improvement = normalizeImprovementValue(improvementMatch?.[1] || '', outputLanguage);
    const bodyText = improvementMatch
        ? trimTrailingSentence(combined.slice(0, improvementMatch.index).trim())
        : combined;

    const sentences = bodyText
        .split(/(?<=[.!?])\s+/)
        .map(sentence => sanitizeStructuredValue(sentence))
        .filter(Boolean);

    const checked = sentences.slice(0, 2).join(' ') || bodyText || format.missingValue;
    const process = sentences.slice(2).join(' ') || bodyText || format.missingValue;
    const parameters = bodyText || format.missingValue;

    return buildStructuredScenarioDescription({
        checked,
        process,
        parameters,
        improvement
    }, outputLanguage);
}

function extractTopLevelSection(documentText: string, sectionName: string): string {
    const sectionRegex = new RegExp(
        `${escapeRegexLiteral(sectionName)}:\\s*(?:\\|[-+0-9]*)?\\s*([\\s\\S]*?)(?=\\n(?![ \\t])[А-Яа-яЁёA-Za-z]+:|\\n*$)`
    );
    const match = sectionRegex.exec(documentText);
    return match?.[1]?.trim() || '';
}

function extractScenarioHeaderSummary(documentText: string): string[] {
    const lines: string[] = [];
    const fieldPatterns: Array<{ label: string; regex: RegExp }> = [
        { label: 'Имя', regex: /^\s*Имя:\s*"([^"]+)"/m },
        { label: 'Код', regex: /^\s*Код:\s*"([^"]+)"/m },
        { label: 'Проект', regex: /^\s*Проект:\s*"([^"]+)"/m },
        { label: 'ФункцияСистемы', regex: /^\s*ФункцияСистемы:\s*"([^"]+)"/m }
    ];

    for (const fieldPattern of fieldPatterns) {
        const match = documentText.match(fieldPattern.regex);
        if (match?.[1]) {
            lines.push(`- ${fieldPattern.label}: ${match[1].trim()}`);
        }
    }

    return lines;
}

function extractNestedScenarioNames(documentText: string, limit: number): string[] {
    const sectionContent = extractTopLevelSection(documentText, 'ВложенныеСценарии');
    if (!sectionContent) {
        return [];
    }

    const matches = Array.from(sectionContent.matchAll(/^\s*ИмяСценария:\s*"([^"]+)"/gm));
    return matches
        .map(match => match[1]?.trim() || '')
        .filter(Boolean)
        .slice(0, Math.max(0, limit));
}

function isScenarioCommentHeadingLine(line: string): boolean {
    const trimmedLine = line.trim();
    if (!/^#{1,6}\s*\S/.test(trimmedLine) || /^#language:/i.test(trimmedLine)) {
        return false;
    }

    const normalized = normalizeScenarioCommentHeading(trimmedLine);
    if (isScenarioDecorativeHeadingValue(normalized)) {
        return false;
    }

    return !/^[\p{L}\p{N}_.$-]+\s*=/u.test(normalized)
        && !/^(?:And|When|Then|Given|But|If|ElseIf|Else|EndIf)\b/i.test(normalized);
}

function normalizeScenarioCommentHeading(line: string): string {
    return line.trim().replace(/^#{1,6}\s*/, '').trim();
}

function isScenarioDecorativeHeadingValue(value: string): boolean {
    const normalized = sanitizeStructuredValue(value).replace(/\s+/g, '');
    return normalized.length > 0 && /^[-=*_~.]{4,}$/.test(normalized);
}

function isScenarioIgnoredCommentLine(line: string): boolean {
    const trimmedLine = line.trim();
    return trimmedLine.startsWith('#')
        && !/^#language:/i.test(trimmedLine)
        && !isScenarioCommentHeadingLine(trimmedLine);
}

function extractScenarioStructureHints(text: string, limit: number): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const rawLine of text.split(/\r\n|\r|\n/)) {
        if (!isScenarioCommentHeadingLine(rawLine)) {
            continue;
        }

        const normalized = normalizeScenarioCommentHeading(rawLine);
        const key = normalized.toLowerCase();
        if (!normalized || seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(normalized);
        if (result.length >= Math.max(0, limit)) {
            break;
        }
    }

    return result;
}

function extractScenarioReportHints(text: string, limit: number): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const filteredText = text
        .split(/\r\n|\r|\n/)
        .filter(line => !isScenarioIgnoredCommentLine(line))
        .join('\n');
    const patterns = [
        /"([^"]*report[^"]*)" window is opened/ig,
        /"([^"]*statement[^"]*)" window is opened/ig,
        /spreadsheet document is equal to "([^"]+)"/ig,
        /PrintForm\s*=\s*'([^']+)'/ig,
        /I create Accounts payable or receivable aging report \(([^)]+)\)/ig
    ];

    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(filteredText)) !== null) {
            const normalized = sanitizeStructuredValue(match[1] || '');
            const key = normalized.toLowerCase();
            if (!normalized || seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push(normalized);
            if (result.length >= Math.max(0, limit)) {
                return result;
            }
        }
    }

    return result;
}

function suggestScenarioChunkTitle(chunkText: string, chunkIndex: number): {
    title: string;
    structureHints: string[];
    reportHints: string[];
} {
    const structureHints = extractScenarioStructureHints(chunkText, 3);
    const reportHints = extractScenarioReportHints(chunkText, 5);
    const title = structureHints.length > 0
        ? structureHints.slice(0, 2).join(' / ')
        : `Block ${chunkIndex}`;

    return {
        title,
        structureHints,
        reportHints
    };
}

function collectScenarioPlaceholderLines(
    documentText: string,
    declaredParameters: Map<string, string>
): string[] {
    const placeholderNames = new Set<string>();
    const placeholderRegex = /\[([A-Za-zА-Яа-яЁё0-9_-]+)\]/g;
    let placeholderMatch: RegExpExecArray | null;
    while ((placeholderMatch = placeholderRegex.exec(documentText)) !== null) {
        if (placeholderMatch[1]) {
            placeholderNames.add(placeholderMatch[1]);
        }
    }

    if (placeholderNames.size === 0) {
        return [];
    }

    return Array.from(placeholderNames.values()).map(name => {
        const declaredValue = declaredParameters.get(name);
        return declaredValue
            ? `- [${name}] -> параметр сценария, объявлен в ПараметрыСценария, значение по умолчанию ${declaredValue}`
            : `- [${name}] -> используется как параметр/placeholder в тексте сценария`;
    });
}

function buildScenarioAnalysisContext(
    documentText: string,
    documentUri: vscode.Uri
): ScenarioAnalysisContext {
    const declaredParameters = parseScenarioParameterDefaults(documentText);
    const phaseSwitcherMetadata = parsePhaseSwitcherMetadata(documentText);

    return {
        documentText,
        documentUri,
        scenarioHeaderSummary: extractScenarioHeaderSummary(documentText),
        declaredParameters,
        parameterLines: declaredParameters.size > 0
            ? Array.from(declaredParameters.entries()).map(([name, value]) => `- ${name} = ${value}`)
            : [],
        usedPlaceholderLines: collectScenarioPlaceholderLines(documentText, declaredParameters),
        nestedScenarioNames: extractNestedScenarioNames(documentText, 20),
        scenarioBody: extractTopLevelSection(documentText, 'ТекстСценария'),
        structureHints: extractScenarioStructureHints(extractTopLevelSection(documentText, 'ТекстСценария'), 12),
        reportHints: extractScenarioReportHints(extractTopLevelSection(documentText, 'ТекстСценария'), 12),
        isStandaloneMainScenario: phaseSwitcherMetadata.hasTab,
        phaseSwitcherTabName: phaseSwitcherMetadata.tabName
    };
}

function normalizeScenarioBodyLines(bodyText: string): string[] {
    return bodyText
        .split(/\r\n|\r|\n/)
        .map(line => line.replace(/\t/g, '    ').trimEnd())
        .filter(line => !isScenarioIgnoredCommentLine(line))
        .filter(line => line.trim().length > 0)
        .map(line => line.length > 180 ? `${line.slice(0, 177)}...` : line);
}

function normalizeScenarioBodyChunkLines(bodyText: string): string[] {
    const normalizedLines: string[] = [];
    let previousWasBlank = true;

    for (const rawLine of bodyText.split(/\r\n|\r|\n/)) {
        const normalizedLine = rawLine.replace(/\t/g, '    ').trim();
        if (isScenarioIgnoredCommentLine(normalizedLine)) {
            continue;
        }

        if (normalizedLine.length === 0) {
            if (!previousWasBlank) {
                normalizedLines.push('');
            }
            previousWasBlank = true;
            continue;
        }

        previousWasBlank = false;
        normalizedLines.push(
            normalizedLine.length > 260
                ? `${normalizedLine.slice(0, 257)}...`
                : normalizedLine
        );
    }

    while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1].trim().length === 0) {
        normalizedLines.pop();
    }

    return normalizedLines;
}

function isScenarioChunkBoundaryLine(line: string): boolean {
    return line.trim().length === 0 || isScenarioCommentHeadingLine(line);
}

function buildScenarioBodyChunks(
    bodyText: string,
    maxChars: number,
    overlapLineCount: number
): ScenarioBodyChunk[] {
    const lines = normalizeScenarioBodyChunkLines(bodyText);
    if (lines.length === 0) {
        return [];
    }

    const chunks: Array<Omit<ScenarioBodyChunk, 'total'>> = [];
    let startIndex = 0;

    while (startIndex < lines.length) {
        while (startIndex < lines.length && lines[startIndex].trim().length === 0) {
            startIndex++;
        }
        if (startIndex >= lines.length) {
            break;
        }

        let endIndex = startIndex;
        let currentLength = 0;

        while (endIndex < lines.length) {
            const line = lines[endIndex];
            const nextLength = currentLength === 0 ? line.length : currentLength + 1 + line.length;
            if (endIndex > startIndex && nextLength > maxChars) {
                let preferredBoundaryIndex = -1;
                const minScanIndex = Math.max(startIndex + 2, endIndex - 24);
                for (let scanIndex = endIndex - 1; scanIndex >= minScanIndex; scanIndex--) {
                    if (isScenarioChunkBoundaryLine(lines[scanIndex])) {
                        preferredBoundaryIndex = scanIndex;
                        break;
                    }
                }

                if (preferredBoundaryIndex !== -1) {
                    endIndex = preferredBoundaryIndex;
                }
                break;
            }

            currentLength = nextLength;
            endIndex++;
        }

        if (endIndex === startIndex) {
            endIndex = startIndex + 1;
        }

        let chunkEndIndex = endIndex;
        while (chunkEndIndex > startIndex && lines[chunkEndIndex - 1].trim().length === 0) {
            chunkEndIndex--;
        }
        if (chunkEndIndex === startIndex) {
            chunkEndIndex = endIndex;
        }

        chunks.push({
            index: chunks.length + 1,
            startLineNumber: startIndex + 1,
            endLineNumber: chunkEndIndex,
            title: '',
            structureHints: [],
            reportHints: [],
            text: lines.slice(startIndex, chunkEndIndex).join('\n')
        });

        if (endIndex >= lines.length) {
            break;
        }

        startIndex = Math.max(endIndex - overlapLineCount, startIndex + 1);
    }

    const total = chunks.length;
    return chunks.map(chunk => {
        const suggested = suggestScenarioChunkTitle(chunk.text, chunk.index);
        return {
            ...chunk,
            total,
            title: suggested.title,
            structureHints: suggested.structureHints,
            reportHints: suggested.reportHints
        };
    });
}

function trimScenarioLogicalLines(lines: string[]): string[] {
    let startIndex = 0;
    let endIndex = lines.length;

    while (startIndex < endIndex && lines[startIndex].trim().length === 0) {
        startIndex++;
    }
    while (endIndex > startIndex && lines[endIndex - 1].trim().length === 0) {
        endIndex--;
    }

    return lines.slice(startIndex, endIndex);
}

function buildScenarioLogicalBlocks(
    bodyText: string,
    maxChars: number
): ScenarioBodyChunk[] {
    const lines = normalizeScenarioBodyChunkLines(bodyText);
    if (lines.length === 0) {
        return [];
    }

    const rawBlocks: Array<{
        title: string;
        startLineNumber: number;
        lines: string[];
    }> = [];
    let currentTitle = 'Подготовка';
    let currentStartLineNumber = 1;
    let currentLines: string[] = [];
    let hasExplicitHeadings = false;

    const flushCurrentBlock = (): void => {
        const trimmedLines = trimScenarioLogicalLines(currentLines);
        if (trimmedLines.length === 0) {
            return;
        }

        rawBlocks.push({
            title: currentTitle,
            startLineNumber: currentStartLineNumber,
            lines: trimmedLines
        });
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!isScenarioCommentHeadingLine(line)) {
            currentLines.push(line);
            continue;
        }

        hasExplicitHeadings = true;
        const headingTitle = normalizeScenarioCommentHeading(line);
        if (trimScenarioLogicalLines(currentLines).length > 0) {
            flushCurrentBlock();
            currentLines = [];
            currentTitle = headingTitle;
            currentStartLineNumber = index + 2;
            continue;
        }

        currentTitle = currentTitle === 'Подготовка'
            ? headingTitle
            : `${currentTitle} / ${headingTitle}`;
        currentStartLineNumber = Math.min(currentStartLineNumber, index + 1);
    }

    flushCurrentBlock();

    if (!hasExplicitHeadings || rawBlocks.length < 2) {
        return buildScenarioBodyChunks(bodyText, maxChars, 12);
    }

    const blocks: Array<Omit<ScenarioBodyChunk, 'total'>> = [];
    for (const rawBlock of rawBlocks) {
        const blockText = rawBlock.lines.join('\n');
        if (blockText.length <= maxChars) {
            blocks.push({
                index: blocks.length + 1,
                startLineNumber: rawBlock.startLineNumber,
                endLineNumber: rawBlock.startLineNumber + rawBlock.lines.length - 1,
                title: rawBlock.title,
                structureHints: [],
                reportHints: [],
                text: blockText
            });
            continue;
        }

        const splitBlocks = buildScenarioBodyChunks(blockText, maxChars, 0);
        for (const splitBlock of splitBlocks) {
            blocks.push({
                index: blocks.length + 1,
                startLineNumber: rawBlock.startLineNumber + splitBlock.startLineNumber - 1,
                endLineNumber: rawBlock.startLineNumber + splitBlock.endLineNumber - 1,
                title: rawBlock.title,
                structureHints: [],
                reportHints: [],
                text: splitBlock.text
            });
        }
    }

    const total = blocks.length;
    return blocks.map(block => {
        const suggested = suggestScenarioChunkTitle(block.text, block.index);
        const title = /^Block \d+$/i.test(suggested.title)
            ? block.title
            : `${block.title} / ${suggested.title}`;

        return {
            ...block,
            total,
            title,
            structureHints: suggested.structureHints,
            reportHints: suggested.reportHints
        };
    });
}

function dedupeOrdered(values: string[], maxItems = 24): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const value of values) {
        const normalized = sanitizeStructuredValue(
            value
                .replace(/^[-*•]\s*/, '')
                .replace(/^\d+[.)]\s*/, '')
        );
        if (!normalized || normalized === '-') {
            continue;
        }

        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(normalized);
        if (result.length >= maxItems) {
            break;
        }
    }

    return result;
}

function splitFactValues(rawValue: string): string[] {
    const normalized = sanitizeStructuredValue(rawValue);
    if (normalized.length === 0 || normalized === '-') {
        return [];
    }

    const parts = normalized.includes('||')
        ? normalized.split(/\s*\|\|\s*/g)
        : normalized.split(/\s*(?:;|•)\s*/g);

    return dedupeOrdered(parts);
}

function parseScenarioChunkSummary(rawValue: string, chunk: ScenarioBodyChunk): ScenarioChunkSummary {
    const sectionValues: Record<'purpose' | 'actions' | 'checks' | 'parameters' | 'reports', string[]> = {
        purpose: [],
        actions: [],
        checks: [],
        parameters: [],
        reports: []
    };
    const labelToKey: Record<string, keyof typeof sectionValues> = {
        PURPOSE: 'purpose',
        ACTIONS: 'actions',
        CHECKS: 'checks',
        PARAMETERS: 'parameters',
        REPORTS: 'reports'
    };

    let currentSection: keyof typeof sectionValues | null = null;
    for (const rawLine of rawValue.split(/\r\n|\r|\n/)) {
        const trimmedLine = rawLine.trim();
        if (trimmedLine.length === 0) {
            continue;
        }

        const match = trimmedLine.match(/^(PURPOSE|ACTIONS|CHECKS|PARAMETERS|REPORTS):\s*(.*)$/i);
        if (match) {
            currentSection = labelToKey[match[1].toUpperCase()];
            sectionValues[currentSection].push(match[2] || '');
            continue;
        }

        if (currentSection) {
            sectionValues[currentSection].push(trimmedLine);
        }
    }

    return {
        index: chunk.index,
        title: chunk.title,
        purpose: splitFactValues(sectionValues.purpose.join(' || ')),
        actions: splitFactValues(sectionValues.actions.join(' || ')),
        checks: splitFactValues(sectionValues.checks.join(' || ')),
        parameters: splitFactValues(sectionValues.parameters.join(' || ')),
        reports: splitFactValues(sectionValues.reports.join(' || '))
    };
}

function isScenarioChunkSummaryEmpty(summary: ScenarioChunkSummary): boolean {
    return summary.purpose.length === 0
        && summary.actions.length === 0
        && summary.checks.length === 0
        && summary.parameters.length === 0
        && summary.reports.length === 0;
}

function formatScenarioChunkSummaryLine(label: string, values: string[]): string {
    return `${label}: ${values.length > 0 ? values.join(' || ') : '-'}`;
}

function getScenarioChunkSummaryDisplayTitle(summary: ScenarioChunkSummary): string {
    const normalizedTitle = sanitizeStructuredValue(summary.title);
    if (normalizedTitle.length > 0 && !/^Block \d+$/i.test(normalizedTitle)) {
        return normalizedTitle;
    }

    return sanitizeStructuredValue(
        summary.reports[0]
        || summary.actions[0]
        || summary.checks[0]
        || summary.purpose[0]
        || 'Scenario segment'
    );
}

function buildScenarioChunkSummaryDigest(chunkSummaries: ScenarioChunkSummary[]): string[] {
    return chunkSummaries.flatMap(summary => [
        `### ${getScenarioChunkSummaryDisplayTitle(summary)}`,
        formatScenarioChunkSummaryLine('PURPOSE', summary.purpose),
        formatScenarioChunkSummaryLine('ACTIONS', summary.actions),
        formatScenarioChunkSummaryLine('CHECKS', summary.checks),
        formatScenarioChunkSummaryLine('PARAMETERS', summary.parameters),
        formatScenarioChunkSummaryLine('REPORTS', summary.reports)
    ]);
}

function buildScenarioCoveragePriorityHints(chunkSummaries: ScenarioChunkSummary[]): string[] {
    if (chunkSummaries.length === 0) {
        return [];
    }

    const lateChunkStartIndex = Math.max(0, Math.floor(chunkSummaries.length * 0.55));
    const lateChunkSummaries = chunkSummaries.slice(lateChunkStartIndex);

    return dedupeOrdered([
        ...lateChunkSummaries.map(summary => summary.title),
        ...lateChunkSummaries.flatMap(summary => summary.purpose),
        ...lateChunkSummaries.flatMap(summary => summary.actions),
        ...lateChunkSummaries.flatMap(summary => summary.checks),
        ...chunkSummaries.flatMap(summary => summary.reports)
    ], 18).map(value => `- ${value}`);
}

function isScenarioCriticalConsistencyFact(value: string): boolean {
    const normalized = sanitizeStructuredValue(value);
    if (normalized.length === 0) {
        return false;
    }

    return /\d/.test(normalized)
        || /template|print\s*form|drill-?down|report|отчет|шаблон/i.test(normalized)
        || /payment|receipt|amount|sum|partial|manual|update|change|filter|clear/i.test(normalized)
        || /оплат|платеж|сумм|частич|вручн|измен|очист|фильтр/i.test(normalized);
}

function buildScenarioCriticalConsistencyHints(chunkSummaries: ScenarioChunkSummary[]): string[] {
    if (chunkSummaries.length === 0) {
        return [];
    }

    return dedupeOrdered([
        ...chunkSummaries.flatMap(summary => summary.checks.filter(isScenarioCriticalConsistencyFact)),
        ...chunkSummaries.flatMap(summary => summary.parameters.filter(isScenarioCriticalConsistencyFact)),
        ...chunkSummaries.flatMap(summary => summary.actions.filter(isScenarioCriticalConsistencyFact)),
        ...chunkSummaries.flatMap(summary => summary.reports)
    ], 18).map(value => `- ${value}`);
}

function extractScenarioCanonicalTermsFromValue(rawValue: string): string[] {
    const terms: string[] = [];
    const normalized = rawValue.replace(/\r\n|\r/g, '\n');

    for (const match of normalized.matchAll(/"([^"\n]{2,120})"/g)) {
        terms.push(match[1]);
    }

    for (const match of normalized.matchAll(/'([^'\n]{2,120})'/g)) {
        terms.push(match[1]);
    }

    for (const match of normalized.matchAll(/\b\d{6,}_[A-Za-z0-9_]+\b/g)) {
        terms.push(match[0]);
    }

    for (const match of normalized.matchAll(/\b(?:[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,7})\b/g)) {
        terms.push(match[0]);
    }

    return dedupeOrdered(terms, 20);
}

function buildScenarioCanonicalTermHints(
    context: ScenarioAnalysisContext,
    chunkSummaries: ScenarioChunkSummary[]
): string[] {
    const rawValues = [
        ...context.reportHints,
        ...context.structureHints,
        ...context.nestedScenarioNames,
        ...chunkSummaries.flatMap(summary => [
            summary.title,
            ...summary.purpose,
            ...summary.actions,
            ...summary.checks,
            ...summary.parameters,
            ...summary.reports
        ])
    ];

    return dedupeOrdered(
        rawValues.flatMap(extractScenarioCanonicalTermsFromValue),
        24
    ).map(value => `- ${value}`);
}

function normalizeScenarioCoverageText(rawValue: string): string {
    return sanitizeStructuredValue(rawValue)
        .toLowerCase()
        .replace(/[`"'«»„“”]/g, ' ')
        .replace(/[(){}\[\],;:!?./\\|-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isScenarioCoverageAnchorUseful(rawValue: string): boolean {
    const normalized = sanitizeStructuredValue(rawValue);
    if (normalized.length < 4) {
        return false;
    }

    if (!/[\p{L}\p{N}]/u.test(normalized)) {
        return false;
    }

    return !/^(?:подготовка|preconditions for testcases|company|date|comment|operation|pattern|documentamount|process|parameters|checks|reports|actions|purpose)$/iu.test(normalized);
}

function extractScenarioCoveragePhrase(rawValue: string): string {
    return sanitizeStructuredValue(
        rawValue
            .replace(/\[[^\]]*]/g, '')
            .replace(/^(?:I\s+)?create\s+/i, '')
            .replace(/^Post\s+/i, '')
            .replace(/^Generate report\s+/i, '')
            .replace(/^Wait for\s+/i, '')
            .replace(/^List became equal:\s*/i, '')
            .replace(/^List contains lines:\s*/i, '')
            .replace(/^PaymentDetails(?:OtherSettlements)? became equal(?: by template)?:\s*/i, '')
    );
}

function stripScenarioFactPreview(rawValue: string): string {
    return sanitizeStructuredValue(
        extractScenarioCoveragePhrase(rawValue).replace(/\s+\[[^\]]*]$/, '')
    );
}

function stripScenarioLeadingVerb(rawValue: string): string {
    const normalized = stripScenarioFactPreview(rawValue);
    const patterns = [
        /^(?:I\s+)?initialize\s+/i,
        /^(?:I\s+)?save\s+/i,
        /^(?:I\s+)?get\s+/i,
        /^(?:I\s+)?connect\s+/i,
        /^(?:I\s+)?create\s+/i,
        /^(?:I\s+)?fill\s+/i,
        /^(?:I\s+)?check\s+/i,
        /^(?:I\s+)?click\s+/i,
        /^Generate report\s+/i,
        /^Post\s+/i,
        /^Wait for\s+/i
    ];

    for (const pattern of patterns) {
        if (pattern.test(normalized)) {
            return sanitizeStructuredValue(normalized.replace(pattern, ''));
        }
    }

    return normalized;
}

function humanizeScenarioSubjectValue(rawValue: string, outputLanguage: AiOutputLanguage): string {
    const normalized = sanitizeStructuredValue(rawValue);
    if (normalized.length === 0) {
        return '';
    }

    const replacements: Array<{
        pattern: RegExp;
        ru: string;
        en: string;
    }> = [
        {
            pattern: /^TestClient connections$/i,
            ru: 'подключений TestClient',
            en: 'TestClient connections'
        },
        {
            pattern: /^key parameters from pipeline and initialize main variables$/i,
            ru: 'ключевых параметров pipeline и основных переменных',
            en: 'key pipeline parameters and main variables'
        },
        {
            pattern: /^main constant values$/i,
            ru: 'основных констант',
            en: 'main constant values'
        },
        {
            pattern: /^contract$/i,
            ru: 'договор',
            en: 'contract'
        },
        {
            pattern: /^counterparty bank account$/i,
            ru: 'банковский счет контрагента',
            en: 'counterparty bank account'
        },
        {
            pattern: /^purchase order and change tax category$/i,
            ru: 'заказ поставщику и изменение налоговой категории',
            en: 'purchase order and tax category update'
        },
        {
            pattern: /^supplier invoice on purchase order basis$/i,
            ru: 'счет поставщика на основании заказа',
            en: 'supplier invoice based on purchase order'
        },
        {
            pattern: /^multicurrency cash account$/i,
            ru: 'мультивалютный счет денежных средств',
            en: 'multicurrency cash account'
        },
        {
            pattern: /^entries in AccountingRegister$/i,
            ru: 'записи в AccountingRegister',
            en: 'entries in AccountingRegister'
        },
        {
            pattern: /^Overdraft limit in bank documents$/i,
            ru: 'лимит овердрафта в банковских документах',
            en: 'Overdraft limit in bank documents'
        },
        {
            pattern: /^Reverse charge for Landed costs documents \((.+)\)$/i,
            ru: 'Reverse charge для документов Landed costs ($1)',
            en: 'Reverse charge for Landed costs documents ($1)'
        },
        {
            pattern: /^that Other - Accounts payable Register is saved for Reverse charge VAT \((.+)\)$/i,
            ru: 'сохранение регистра Other - Accounts payable для Reverse charge VAT ($1)',
            en: 'saving Other - Accounts payable Register for Reverse charge VAT ($1)'
        },
        {
            pattern: /^currency exchange rates in Foreign currency exchange document \((.+)\)$/i,
            ru: 'курсов валют в документе Foreign currency exchange ($1)',
            en: 'exchange rates in Foreign currency exchange document ($1)'
        },
        {
            pattern: /^exchange rates$/i,
            ru: 'курсов валют',
            en: 'exchange rates'
        },
        {
            pattern: /^application of exchange rates in Foreign currency exchange$/i,
            ru: 'применения курсов валют в документе Foreign currency exchange',
            en: 'application of exchange rates in Foreign currency exchange'
        }
    ];

    for (const replacement of replacements) {
        if (!replacement.pattern.test(normalized)) {
            continue;
        }

        return outputLanguage === 'en'
            ? normalized.replace(replacement.pattern, replacement.en)
            : normalized.replace(replacement.pattern, replacement.ru);
    }

    return normalized;
}

function humanizeScenarioBusinessFact(rawValue: string, outputLanguage: AiOutputLanguage): string {
    const normalized = stripScenarioFactPreview(rawValue);
    if (normalized.length === 0) {
        return '';
    }

    const replacements: Array<{
        pattern: RegExp;
        ru: string;
        en: string;
    }> = [
        {
            pattern: /^I connect "([^"]+)" profile of TestClient$/i,
            ru: 'подключение профиля TestClient "$1"',
            en: 'connect TestClient profile "$1"'
        },
        {
            pattern: /^Generate report "([^"]+)"$/i,
            ru: 'формирование отчета "$1"',
            en: 'generate report "$1"'
        },
        {
            pattern: /^Generate report$/i,
            ru: 'формирование отчета',
            en: 'generate report'
        },
        {
            pattern: /^I check entries in AccountingRegister$/i,
            ru: 'проверка записей в AccountingRegister',
            en: 'check entries in AccountingRegister'
        },
        {
            pattern: /^I check Overdraft limit in bank documents$/i,
            ru: 'проверка лимита овердрафта в банковских документах',
            en: 'check Overdraft limit in bank documents'
        },
        {
            pattern: /^I check Reverse charge for Landed costs documents \((.+)\)$/i,
            ru: 'проверка Reverse charge для документов Landed costs ($1)',
            en: 'check Reverse charge for Landed costs documents ($1)'
        },
        {
            pattern: /^I check that Other - Accounts payable Register is saved for Reverse charge VAT \((.+)\)$/i,
            ru: 'проверка сохранения регистра Other - Accounts payable для Reverse charge VAT ($1)',
            en: 'check that Other - Accounts payable Register is saved for Reverse charge VAT ($1)'
        },
        {
            pattern: /^I check currency exchange rates in Foreign currency exchange document \((.+)\)$/i,
            ru: 'проверка курсов валют в документе Foreign currency exchange ($1)',
            en: 'check currency exchange rates in Foreign currency exchange document ($1)'
        },
        {
            pattern: /^Post "([^"]+)"$/i,
            ru: 'проведение "$1"',
            en: 'post "$1"'
        },
        {
            pattern: /^Post document$/i,
            ru: 'проведение документа',
            en: 'post document'
        },
        {
            pattern: /^Wait for (.+) fill$/i,
            ru: 'ожидание заполнения $1',
            en: 'wait for $1 fill'
        },
        {
            pattern: /^I turn off (.+)$/i,
            ru: 'отключение $1',
            en: 'turn off $1'
        },
        {
            pattern: /^I turn on (.+)$/i,
            ru: 'включение $1',
            en: 'turn on $1'
        },
        {
            pattern: /^I change (.+)$/i,
            ru: 'изменение $1',
            en: 'change $1'
        },
        {
            pattern: /^I del$/i,
            ru: 'очистка ранее созданных документов и данных',
            en: 'clean up previously created documents and data'
        },
        {
            pattern: /^I initialize (.+)$/i,
            ru: 'инициализация ' + humanizeScenarioSubjectValue('$1', 'ru'),
            en: 'initialize $1'
        },
        {
            pattern: /^I save (.+)$/i,
            ru: 'сохранение ' + humanizeScenarioSubjectValue('$1', 'ru'),
            en: 'save $1'
        },
        {
            pattern: /^I get (.+)$/i,
            ru: 'получение ' + humanizeScenarioSubjectValue('$1', 'ru'),
            en: 'get $1'
        },
        {
            pattern: /^I create (.+)$/i,
            ru: 'создание ' + humanizeScenarioSubjectValue('$1', 'ru'),
            en: 'create $1'
        },
        {
            pattern: /^I fill (.+)$/i,
            ru: 'заполнение ' + humanizeScenarioSubjectValue('$1', 'ru'),
            en: 'fill $1'
        },
        {
            pattern: /^I check (.+)$/i,
            ru: 'проверка ' + humanizeScenarioSubjectValue('$1', 'ru'),
            en: 'check $1'
        },
        {
            pattern: /^I click (.+)$/i,
            ru: 'переход через ' + humanizeScenarioSubjectValue('$1', 'ru'),
            en: 'navigate via $1'
        },
        {
            pattern: /^I connect (.+)$/i,
            ru: 'подключение ' + humanizeScenarioSubjectValue('$1', 'ru'),
            en: 'connect $1'
        }
    ];

    for (const replacement of replacements) {
        if (!replacement.pattern.test(normalized)) {
            continue;
        }

        if (outputLanguage === 'en') {
            return normalized.replace(replacement.pattern, replacement.en);
        }

        const match = normalized.match(replacement.pattern);
        if (match) {
            let resolved = replacement.ru;
            for (let index = 1; index < match.length; index++) {
                resolved = resolved.replace(`$${index}`, humanizeScenarioSubjectValue(match[index] || '', 'ru'));
            }
            return sanitizeStructuredValue(resolved);
        }
    }

    return outputLanguage === 'en'
        ? normalized
        : humanizeScenarioSubjectValue(normalized, outputLanguage);
}

function extractScenarioSemanticFactsFromValue(
    rawValue: string,
    sourceKind: 'title' | 'action' | 'check' | 'report'
): ScenarioSemanticFact[] {
    const normalized = stripScenarioFactPreview(rawValue);
    if (normalized.length === 0 || normalized === '-') {
        return [];
    }

    const facts: ScenarioSemanticFact[] = [];

    const profileMatch = normalized.match(/^I connect "([^"]+)" profile of TestClient$/i);
    if (profileMatch) {
        facts.push({
            kind: 'profile_switch',
            subject: profileMatch[1],
            raw: rawValue
        });
        return facts;
    }

    if (sourceKind === 'title' && (/^turn\s+(?:on|off)\b/i.test(normalized) || /\s=\s(?:TRUE|FALSE)\b/i.test(normalized))) {
        facts.push({
            kind: 'mode_switch',
            subject: normalized,
            raw: rawValue
        });
    }

    if (/^I initialize\b|^I save\b|^I get\b/i.test(normalized)) {
        facts.push({
            kind: 'setup',
            subject: stripScenarioLeadingVerb(normalized),
            raw: rawValue
        });
        return facts;
    }

    const balanceMatch = normalized.match(/^I check independence (Bank|Cash) balance from Prevent negative balance option \((.+?)\)(?:\s*\((.+)\))?$/i);
    if (balanceMatch) {
        const detailSuffix = sanitizeStructuredValue(balanceMatch[3] || '');
        facts.push({
            kind: 'balance_check',
            subject: sanitizeStructuredValue(
                detailSuffix.length > 0
                    ? `${balanceMatch[2] || ''} (${detailSuffix})`
                    : (balanceMatch[2] || '')
            ),
            detail: balanceMatch[1]?.toLowerCase(),
            raw: rawValue
        });
        return facts;
    }

    if (sourceKind === 'report' || /(?:^Generate report\b|template\b|drill-?down\b|print\s*form\b|spreadsheet document\b|\breport\b|\bstatement\b)/i.test(normalized)) {
        facts.push({
            kind: 'report_check',
            subject: stripScenarioLeadingVerb(normalized),
            raw: rawValue
        });
    }

    if (/\bregister\b/i.test(normalized)) {
        facts.push({
            kind: 'register_check',
            subject: stripScenarioLeadingVerb(normalized),
            raw: rawValue
        });
    }

    if (/\breverse charge\b|\bvat\b|\btax\b/i.test(normalized)) {
        facts.push({
            kind: 'tax_check',
            subject: stripScenarioLeadingVerb(normalized),
            raw: rawValue
        });
    }

    if (/\bexchange rates?\b|\bcurrency exchange\b|\bforeign currency exchange\b|\bmulticurrency\b/i.test(normalized)) {
        facts.push({
            kind: 'currency_check',
            subject: stripScenarioLeadingVerb(normalized),
            raw: rawValue
        });
    }

    if (/^(?:I\s+)?(?:create|fill)\b/i.test(normalized) || /^Post\b/i.test(normalized)) {
        facts.push({
            kind: 'document_flow',
            subject: stripScenarioLeadingVerb(normalized),
            raw: rawValue
        });
    }

    if (sourceKind === 'check' || /^I check\b/i.test(normalized)) {
        facts.push({
            kind: 'generic_check',
            subject: stripScenarioLeadingVerb(normalized),
            raw: rawValue
        });
    }

    if (sourceKind === 'action') {
        facts.push({
            kind: 'generic_action',
            subject: stripScenarioLeadingVerb(normalized),
            raw: rawValue
        });
    }

    return facts;
}

function dedupeScenarioSemanticFacts(facts: ScenarioSemanticFact[]): ScenarioSemanticFact[] {
    const result: ScenarioSemanticFact[] = [];
    const seen = new Set<string>();

    for (const fact of facts) {
        const key = [
            fact.kind,
            sanitizeStructuredValue(fact.subject).toLowerCase(),
            sanitizeStructuredValue(fact.detail || '').toLowerCase()
        ].join('::');
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(fact);
    }

    return result;
}

function collectScenarioSemanticFacts(summary: Pick<ScenarioChunkSummary, 'title' | 'actions' | 'checks' | 'reports'>): ScenarioSemanticFact[] {
    return dedupeScenarioSemanticFacts([
        ...extractScenarioSemanticFactsFromValue(summary.title, 'title'),
        ...summary.actions.flatMap(value => extractScenarioSemanticFactsFromValue(value, 'action')),
        ...summary.checks.flatMap(value => extractScenarioSemanticFactsFromValue(value, 'check')),
        ...summary.reports.flatMap(value => extractScenarioSemanticFactsFromValue(value, 'report'))
    ]);
}

function collectScenarioSemanticSubjects(
    facts: ScenarioSemanticFact[],
    kinds: ScenarioSemanticKind[],
    limit: number,
    outputLanguage: AiOutputLanguage,
    detailFilter?: (fact: ScenarioSemanticFact) => boolean
): string[] {
    return dedupeOrdered(
        facts
            .filter(fact => kinds.includes(fact.kind))
            .filter(fact => !detailFilter || detailFilter(fact))
            .map(fact => humanizeScenarioSubjectValue(fact.subject, outputLanguage))
            .filter(isScenarioCoverageAnchorUseful),
        limit
    );
}

function collectScenarioSemanticLabels(
    facts: ScenarioSemanticFact[],
    kinds: ScenarioSemanticKind[],
    limit: number,
    outputLanguage: AiOutputLanguage,
    detailFilter?: (fact: ScenarioSemanticFact) => boolean
): string[] {
    return dedupeOrdered(
        facts
            .filter(fact => kinds.includes(fact.kind))
            .filter(fact => !detailFilter || detailFilter(fact))
            .map(fact => humanizeScenarioBusinessFact(fact.raw, outputLanguage))
            .filter(isScenarioCoverageAnchorUseful),
        limit
    );
}

function collectScenarioSemanticFocusKinds(facts: ScenarioSemanticFact[]): ScenarioSemanticKind[] {
    const priority: ScenarioSemanticKind[] = [
        'setup',
        'profile_switch',
        'mode_switch',
        'balance_check',
        'document_flow',
        'register_check',
        'report_check',
        'tax_check',
        'currency_check',
        'generic_action',
        'generic_check'
    ];
    const kinds = new Set(facts.map(fact => fact.kind));
    return priority.filter(kind => kinds.has(kind));
}

function groupScenarioChunkSummariesByStage(
    chunkSummaries: ScenarioChunkSummary[],
    outputLanguage: AiOutputLanguage
): Array<{
    title: string;
    actions: string[];
    checks: string[];
    reports: string[];
    parameters: string[];
}> {
    const groupedSummaries = new Map<string, {
        title: string;
        actions: string[];
        checks: string[];
        reports: string[];
        parameters: string[];
    }>();
    const stageOrder: string[] = [];

    for (const summary of chunkSummaries) {
        const stageTitle = summarizeScenarioProcessStageTitle(summary.title, outputLanguage) || sanitizeStructuredValue(summary.title);
        if (!groupedSummaries.has(stageTitle)) {
            groupedSummaries.set(stageTitle, {
                title: stageTitle,
                actions: [],
                checks: [],
                reports: [],
                parameters: []
            });
            stageOrder.push(stageTitle);
        }

        const existing = groupedSummaries.get(stageTitle)!;
        existing.actions.push(...summary.actions);
        existing.checks.push(...summary.checks);
        existing.reports.push(...summary.reports);
        existing.parameters.push(...summary.parameters);
    }

    return stageOrder
        .map(title => groupedSummaries.get(title))
        .filter((value): value is NonNullable<typeof value> => Boolean(value));
}

function splitScenarioTitlePath(title: string): string[] {
    return title
        .split('/')
        .map(value => sanitizeStructuredValue(value))
        .filter(Boolean)
        .filter(value => !isScenarioDecorativeHeadingValue(value));
}

function humanizeScenarioHeadingFragment(rawValue: string, outputLanguage: AiOutputLanguage): string {
    const normalized = sanitizeStructuredValue(rawValue);
    if (normalized.length === 0 || /^Block \d+$/i.test(normalized) || isScenarioDecorativeHeadingValue(normalized)) {
        return '';
    }

    const replacements: Array<{
        pattern: RegExp;
        ru: string;
        en: string;
    }> = [
        {
            pattern: /^Preconditions for testcases$/i,
            ru: 'подготовка и предусловия',
            en: 'preconditions'
        },
        {
            pattern: /^Create production chain and test interface$/i,
            ru: 'создание производственной цепочки и проверка интерфейса',
            en: 'create the production chain and verify the interface'
        },
        {
            pattern: /^Create batches for components$/i,
            ru: 'создание партий для компонентов',
            en: 'create component batches'
        },
        {
            pattern: /^Turn (?:the )?option of (.+)$/i,
            ru: 'включение $1',
            en: 'enable $1'
        },
        {
            pattern: /^Turn off (.+)$/i,
            ru: 'отключение $1',
            en: 'disable $1'
        },
        {
            pattern: /^Turn on (.+)$/i,
            ru: 'включение $1',
            en: 'enable $1'
        },
        {
            pattern: /^Change option to (.+)$/i,
            ru: 'смена режима на $1',
            en: 'change the mode to $1'
        },
        {
            pattern: /^Check that (.+)$/i,
            ru: 'проверка, что $1',
            en: 'verify that $1'
        },
        {
            pattern: /^Create (.+)$/i,
            ru: 'создание $1',
            en: 'create $1'
        },
        {
            pattern: /^Creating (.+)$/i,
            ru: 'создание $1',
            en: 'create $1'
        },
        {
            pattern: /^Checking (.+)$/i,
            ru: 'проверка $1',
            en: 'check $1'
        },
        {
            pattern: /^Receiving the half of the debt$/i,
            ru: 'получение первой половины оплаты',
            en: 'receive the first half of the debt'
        },
        {
            pattern: /^Receiving the another half of debt$/i,
            ru: 'получение второй половины оплаты',
            en: 'receive the second half of the debt'
        },
        {
            pattern: /^Decrease of (.+)$/i,
            ru: 'уменьшение $1',
            en: 'decrease $1'
        },
        {
            pattern: /^Unpost and delete(?: (.+))?$/i,
            ru: 'снятие проведения и удаление$1',
            en: 'unpost and delete$1'
        },
        {
            pattern: /^Transferred from (.+)$/i,
            ru: 'перенесенный кейс из $1',
            en: 'transferred from $1'
        },
        {
            pattern: /^(.+?) workflow scenario$/i,
            ru: 'сценарий: $1',
            en: 'workflow scenario: $1'
        },
        {
            pattern: /^For (.+)$/i,
            ru: 'для блока $1',
            en: 'for $1'
        }
    ];

    for (const replacement of replacements) {
        const match = normalized.match(replacement.pattern);
        if (!match) {
            continue;
        }

        if (outputLanguage === 'en') {
            return sanitizeStructuredValue(normalized.replace(replacement.pattern, replacement.en));
        }

        let resolved = replacement.ru;
        for (let index = 1; index < match.length; index++) {
            const replacementValue = sanitizeStructuredValue(match[index] || '');
            const suffix = replacementValue.length > 0 ? ` ${replacementValue}` : '';
            resolved = resolved.replace(`$${index}`, suffix);
        }
        return sanitizeStructuredValue(resolved);
    }

    if (looksLikeScenarioReportName(normalized)) {
        return outputLanguage === 'en'
            ? `check "${normalized}"`
            : `проверка "${normalized}"`;
    }

    if (/^[A-Z][A-Za-z0-9 .,&()/-]{1,80}$/.test(normalized)) {
        return outputLanguage === 'en'
            ? `"${normalized}"`
            : `этап "${normalized}"`;
    }

    return normalized;
}

function summarizeScenarioProcessStageTitle(title: string, outputLanguage: AiOutputLanguage): string {
    const normalized = sanitizeStructuredValue(title);
    if (normalized.length === 0 || /^Block \d+$/i.test(normalized)) {
        return '';
    }

    if (/^подготовка$/i.test(normalized)) {
        return outputLanguage === 'en'
            ? 'environment preparation'
            : 'подготовка окружения';
    }

    if (/^US\s+\d+/i.test(normalized)) {
        return outputLanguage === 'en'
            ? `block "${normalized}"`
            : `блок "${normalized}"`;
    }

    const turnOffMatch = normalized.match(/^Turn off\s+(.+)$/i);
    if (turnOffMatch) {
        return outputLanguage === 'en'
            ? `temporary disabling of ${turnOffMatch[1]}`
            : `временное отключение ${turnOffMatch[1]}`;
    }

    const turnOnMatch = normalized.match(/^Turn on\s+(.+)$/i);
    if (turnOnMatch) {
        return outputLanguage === 'en'
            ? `re-enabling ${turnOnMatch[1]}`
            : `повторное включение ${turnOnMatch[1]}`;
    }

    if (/\s=\s(?:TRUE|FALSE)\b/i.test(normalized)) {
        return outputLanguage === 'en'
            ? `checks in mode "${normalized}"`
            : `проверки в режиме "${normalized}"`;
    }

    const pathParts = splitScenarioTitlePath(normalized);
    const casePart = pathParts.find(value => /^Case\s+\d+$/i.test(value));
    const nonCaseParts = pathParts.filter(value => !/^Case\s+\d+$/i.test(value));
    if (casePart) {
        const caseNumber = casePart.match(/\d+/)?.[0] || '';
        const humanizedTitle = dedupeOrdered(
            nonCaseParts
                .map(value => humanizeScenarioHeadingFragment(value, outputLanguage))
                .filter(Boolean),
            4
        ).join(outputLanguage === 'en' ? ' -> ' : ' -> ');
        return outputLanguage === 'en'
            ? `Case ${caseNumber}: ${humanizedTitle || casePart}`
            : `Кейс ${caseNumber}: ${humanizedTitle || casePart}`;
    }

    if (pathParts.length > 1) {
        const humanizedParts = dedupeOrdered(
            pathParts
                .map(value => humanizeScenarioHeadingFragment(value, outputLanguage))
                .filter(Boolean),
            4
        );
        return humanizedParts.join(outputLanguage === 'en' ? ' -> ' : ' -> ');
    }

    return humanizeScenarioHeadingFragment(normalized, outputLanguage) || normalized;
}

function buildSequentialScenarioStageSummaries(
    chunkSummaries: ScenarioChunkSummary[],
    outputLanguage: AiOutputLanguage
): Array<{
    title: string;
    actions: string[];
    checks: string[];
    reports: string[];
    parameters: string[];
}> {
    const sequentialSummaries: Array<{
        title: string;
        actions: string[];
        checks: string[];
        reports: string[];
        parameters: string[];
    }> = [];

    for (const summary of chunkSummaries) {
        const stageTitle = summarizeScenarioProcessStageTitle(summary.title, outputLanguage) || sanitizeStructuredValue(summary.title);
        const lastSummary = sequentialSummaries[sequentialSummaries.length - 1];
        if (lastSummary && lastSummary.title === stageTitle) {
            lastSummary.actions.push(...summary.actions);
            lastSummary.checks.push(...summary.checks);
            lastSummary.reports.push(...summary.reports);
            lastSummary.parameters.push(...summary.parameters);
            continue;
        }

        sequentialSummaries.push({
            title: stageTitle,
            actions: [...summary.actions],
            checks: [...summary.checks],
            reports: [...summary.reports],
            parameters: [...summary.parameters]
        });
    }

    return sequentialSummaries;
}

function selectScenarioHeadTailItems(values: string[], headCount: number, tailCount: number, maxItems: number): string[] {
    if (values.length <= maxItems) {
        return values;
    }

    const head = values.slice(0, Math.min(headCount, maxItems));
    const remainingSlots = Math.max(0, maxItems - head.length);
    const tail = values.slice(-Math.min(tailCount, remainingSlots));

    return dedupeOrdered([
        ...head,
        ...tail
    ], maxItems);
}

function scoreScenarioStageSummaryForDescription(
    summary: {
        title: string;
        actions: string[];
        checks: string[];
        reports: string[];
        parameters: string[];
    },
    index: number,
    total: number
): number {
    const combinedText = [
        summary.title,
        ...summary.actions,
        ...summary.checks,
        ...summary.reports,
        ...summary.parameters
    ].join(' ');

    let score = 0;
    if (index === 0 || index === total - 1) {
        score += 2;
    }
    if (summary.reports.length > 0) {
        score += 4;
    }
    if (summary.checks.some(value => /user message|not present|present on the form|became equal|contains lines|template|allocation/i.test(value))) {
        score += 3;
    }
    if (summary.parameters.some(value => {
        const signalKind = classifyScenarioParameterSignal(value);
        return signalKind === 'mode' || signalKind === 'branch' || signalKind === 'control';
    })) {
        score += 2;
    }
    if (summary.actions.some(isScenarioStrongCoverageSignal) || summary.checks.some(isScenarioStrongCoverageSignal)) {
        score += 2;
    }
    if (/delete|unpost|manual|always|never|cleanup|batch|allocation|misallocation/i.test(combinedText)) {
        score += 2;
    }

    return score;
}

function selectScenarioStageSummariesForProcess(
    stageSummaries: Array<{
        title: string;
        actions: string[];
        checks: string[];
        reports: string[];
        parameters: string[];
    }>,
    maxItems: number
): Array<{
    title: string;
    actions: string[];
    checks: string[];
    reports: string[];
    parameters: string[];
}> {
    if (stageSummaries.length <= maxItems) {
        return stageSummaries;
    }

    const scored = stageSummaries.map((summary, index) => ({
        summary,
        index,
        score: scoreScenarioStageSummaryForDescription(summary, index, stageSummaries.length)
    }));
    const selectedIndexes = new Set<number>([
        0,
        stageSummaries.length - 1
    ]);
    const headReserve = Math.min(2, stageSummaries.length);
    const tailReserve = Math.min(2, stageSummaries.length);

    for (let index = 0; index < headReserve; index++) {
        selectedIndexes.add(index);
    }
    for (let index = stageSummaries.length - tailReserve; index < stageSummaries.length; index++) {
        if (index >= 0) {
            selectedIndexes.add(index);
        }
    }

    const byPriority = scored
        .slice()
        .sort((left, right) => right.score - left.score || left.index - right.index);

    for (const item of byPriority) {
        if (selectedIndexes.size >= maxItems) {
            break;
        }
        selectedIndexes.add(item.index);
    }

    return stageSummaries.filter((_, index) => selectedIndexes.has(index));
}

function buildScenarioProcessStageFragments(
    facts: ScenarioSemanticFact[],
    outputLanguage: AiOutputLanguage
): string[] {
    const fragments: string[] = [];
    const setupLabels = collectScenarioSemanticLabels(facts, ['setup'], 4, outputLanguage);
    const profileSubjects = collectScenarioSemanticSubjects(facts, ['profile_switch'], 3, outputLanguage);
    const balanceSubjects = collectScenarioSemanticSubjects(facts, ['balance_check'], 8, outputLanguage);
    const documentSubjects = collectScenarioSemanticSubjects(facts, ['document_flow'], 5, outputLanguage);
    const registerSubjects = collectScenarioSemanticSubjects(facts, ['register_check'], 4, outputLanguage);
    const taxSubjects = collectScenarioSemanticSubjects(facts, ['tax_check'], 4, outputLanguage);
    const currencySubjects = collectScenarioSemanticSubjects(facts, ['currency_check'], 4, outputLanguage);
    const reportSubjects = collectScenarioSemanticSubjects(facts, ['report_check'], 4, outputLanguage);
    const genericChecks = collectScenarioSemanticLabels(facts, ['generic_check'], 3, outputLanguage);

    if (setupLabels.length > 0) {
        fragments.push(setupLabels.join(', '));
    }
    if (profileSubjects.length > 0) {
        fragments.push(outputLanguage === 'en'
            ? `profile changes: ${profileSubjects.map(value => `"${value}"`).join(', ')}`
            : `переключение профилей TestClient: ${profileSubjects.map(value => `"${value}"`).join(', ')}`);
    }
    if (balanceSubjects.length > 0) {
        fragments.push(outputLanguage === 'en'
            ? `balance-related checks for documents (${balanceSubjects.join(', ')})`
            : `проверки поведения остатков для документов (${balanceSubjects.join(', ')})`);
    }
    if (documentSubjects.length > 0) {
        fragments.push(outputLanguage === 'en'
            ? `document and object flow: ${documentSubjects.join(', ')}`
            : `создание и заполнение объектов и документов: ${documentSubjects.join(', ')}`);
    }
    if (registerSubjects.length > 0) {
        fragments.push(outputLanguage === 'en'
            ? `register checks: ${registerSubjects.join(', ')}`
            : `проверки регистров и учетных движений: ${registerSubjects.join(', ')}`);
    }
    if (taxSubjects.length > 0) {
        fragments.push(outputLanguage === 'en'
            ? `tax checks: ${taxSubjects.join(', ')}`
            : `налоговые проверки: ${taxSubjects.join(', ')}`);
    }
    if (currencySubjects.length > 0) {
        fragments.push(outputLanguage === 'en'
            ? `currency operations and rate checks: ${currencySubjects.join(', ')}`
            : `операции с валютой и проверка курсов: ${currencySubjects.join(', ')}`);
    }
    if (reportSubjects.length > 0) {
        fragments.push(outputLanguage === 'en'
            ? `report and template checks: ${reportSubjects.join(', ')}`
            : `проверки отчетов и шаблонов: ${reportSubjects.join(', ')}`);
    }
    if (genericChecks.length > 0) {
        fragments.push(outputLanguage === 'en'
            ? `additional checks: ${genericChecks.join(', ')}`
            : `дополнительные проверки: ${genericChecks.join(', ')}`);
    }

    return dedupeOrdered(fragments, 6);
}

function buildDeterministicImprovementItems(
    context: ScenarioAnalysisContext,
    chunkSummaries: ScenarioChunkSummary[],
    outputLanguage: AiOutputLanguage
): string[] {
    const items: string[] = [];
    const semanticFacts = chunkSummaries.flatMap(collectScenarioSemanticFacts);
    const significantKinds = new Set(
        semanticFacts
            .map(fact => fact.kind)
            .filter(kind => ['balance_check', 'document_flow', 'register_check', 'tax_check', 'currency_check', 'report_check'].includes(kind))
    );
    const commentedLines = context.scenarioBody
        .split(/\r\n|\r|\n/)
        .map(line => line.trim())
        .filter(isScenarioIgnoredCommentLine);
    const delayCount = Array.from(context.scenarioBody.matchAll(/\bDelay\s+\d+\b/gi)).length;

    if (significantKinds.size >= 4) {
        items.push(outputLanguage === 'en'
            ? 'Split the scenario into narrower flows so that balance checks, document processing, tax checks, reports, and currency logic can fail independently.'
            : 'Разделить сценарий на более узкие потоки, чтобы проверки остатков, документы, налоги, отчеты и валютные операции падали независимо друг от друга.');
    }

    if (commentedLines.some(line => /^#\s*(?:And|When|Then|Given|But)\b/i.test(line))) {
        items.push(outputLanguage === 'en'
            ? 'Clean up commented-out scenario steps or move them into separate active tests to avoid dead code in the scenario.'
            : 'Убрать закомментированные шаги сценария или вынести их в отдельные активные тесты, чтобы в файле не оставался мертвый код.');
    }

    if (delayCount > 0) {
        items.push(outputLanguage === 'en'
            ? 'Replace hard Delay steps with waits for specific business events or UI state to reduce flakiness.'
            : 'Заменить жесткие Delay на ожидание конкретных бизнес-событий или состояний интерфейса, чтобы снизить нестабильность теста.');
    }

    return dedupeOrdered(items, 2);
}

function buildDeterministicProcessItems(
    chunkSummaries: ScenarioChunkSummary[],
    outputLanguage: AiOutputLanguage
): string[] {
    const items: string[] = [];
    const stageSummaries = selectScenarioStageSummariesForProcess(
        buildSequentialScenarioStageSummaries(chunkSummaries, outputLanguage),
        12
    );

    for (const summary of stageSummaries) {
        const stageFacts = dedupeScenarioSemanticFacts([
            ...summary.actions.flatMap(value => extractScenarioSemanticFactsFromValue(value, 'action')),
            ...summary.checks.flatMap(value => extractScenarioSemanticFactsFromValue(value, 'check')),
            ...summary.reports.flatMap(value => extractScenarioSemanticFactsFromValue(value, 'report'))
        ]);
        const stageFragments = buildScenarioProcessStageFragments(stageFacts, outputLanguage);
        const businessSignals = compactScenarioParameterAssignments(
            summary.parameters.filter(value => classifyScenarioParameterSignal(value) === 'business'),
            4
        );
        const modeSignals = compactScenarioParameterAssignments(
            summary.parameters.filter(value => classifyScenarioParameterSignal(value) === 'mode'),
            3
        );
        const dateSignals = compactScenarioParameterAssignments(
            summary.parameters.filter(value => classifyScenarioParameterSignal(value) === 'date'),
            3
        );
        const controlSignals = compactScenarioParameterAssignments(
            summary.parameters.filter(value => classifyScenarioParameterSignal(value) === 'control'),
            3
        );
        const stageDetails = dedupeOrdered([
            ...(businessSignals.length > 0
                ? [
                    outputLanguage === 'en'
                        ? `Key data: ${businessSignals.join(', ')}`
                        : `Ключевые данные: ${businessSignals.join(', ')}`
                ]
                : []),
            ...(modeSignals.length > 0
                ? [
                    outputLanguage === 'en'
                        ? `Modes and statuses: ${modeSignals.join(', ')}`
                        : `Режимы и статусы: ${modeSignals.join(', ')}`
                ]
                : []),
            ...(dateSignals.length > 0
                ? [
                    outputLanguage === 'en'
                        ? `Important dates: ${dateSignals.join(', ')}`
                        : `Важные даты: ${dateSignals.join(', ')}`
                ]
                : []),
            ...(controlSignals.length > 0
                ? [
                    outputLanguage === 'en'
                        ? `Control values: ${controlSignals.join(', ')}`
                        : `Контрольные значения: ${controlSignals.join(', ')}`
                ]
                : [])
        ], 4);
        const stageTitle = summary.title;

        if (stageFragments.length === 0) {
            const stageSignals = dedupeOrdered([
                ...summary.actions,
                ...summary.checks.filter(isScenarioStrongCoverageSignal),
                ...summary.reports
            ].map(value => humanizeScenarioBusinessFact(value, outputLanguage)).filter(isScenarioCoverageAnchorUseful), 4);

            if (stageSignals.length === 0) {
                if (stageTitle.length > 0) {
                    items.push(`- ${stageTitle}`);
                }
                continue;
            }

            if (stageTitle.length > 0) {
                items.push([
                    `- ${stageTitle}`,
                    ...stageSignals.map(value => `  - ${value}`),
                    ...stageDetails.map(value => `  - ${value}`)
                ].join('\n'));
            } else {
                items.push(...stageSignals.map(value => `- ${value}`));
            }
            continue;
        }

        if (stageTitle.length > 0) {
            items.push([
                `- ${stageTitle}`,
                ...stageFragments.map(value => `  - ${value}`),
                ...stageDetails.map(value => `  - ${value}`)
            ].join('\n'));
        } else {
            items.push(...stageFragments.map(value => `- ${value}`));
        }
    }

    return items;
}

function buildDeterministicCheckedItems(
    chunkSummaries: ScenarioChunkSummary[],
    reportSignals: string[],
    outputLanguage: AiOutputLanguage
): string[] {
    const facts = chunkSummaries.flatMap(collectScenarioSemanticFacts);
    const items: string[] = [];
    const stageCoverageSignals = dedupeOrdered(
        buildSequentialScenarioStageSummaries(chunkSummaries, outputLanguage)
            .map(summary => summary.title)
            .filter(value => value.length > 0)
            .filter(value => !/^подготовка окружения$/i.test(value))
            .filter(value => !/^environment preparation$/i.test(value)),
        5
    );
    const balanceSubjects = collectScenarioSemanticSubjects(facts, ['balance_check'], 8, outputLanguage);
    const documentSubjects = collectScenarioSemanticSubjects(facts, ['document_flow'], 5, outputLanguage);
    const registerSubjects = collectScenarioSemanticSubjects(facts, ['register_check'], 4, outputLanguage);
    const taxSubjects = collectScenarioSemanticSubjects(facts, ['tax_check'], 4, outputLanguage);
    const currencySubjects = collectScenarioSemanticSubjects(facts, ['currency_check'], 4, outputLanguage);
    const genericChecks = collectScenarioSemanticLabels(facts, ['generic_check'], 4, outputLanguage);
    const checkHighlights = selectScenarioHeadTailItems(
        dedupeOrdered(
            chunkSummaries.flatMap(summary => summary.checks)
                .filter(value => /user message|not present|present on the form|template|became equal|contains lines|allocation/i.test(value))
                .map(value => humanizeScenarioParameterOrBranch(value, outputLanguage)),
            10
        ),
        2,
        3,
        5
    );

    if (stageCoverageSignals.length > 0) {
        items.push(outputLanguage === 'en'
            ? `Business flow coverage: ${selectScenarioHeadTailItems(stageCoverageSignals, 2, 3, 5).join(', ')}`
            : `Покрываемые бизнес-блоки сценария: ${selectScenarioHeadTailItems(stageCoverageSignals, 2, 3, 5).join(', ')}`);
    }
    if (checkHighlights.length > 0) {
        items.push(outputLanguage === 'en'
            ? `Critical control points: ${checkHighlights.join(', ')}`
            : `Ключевые контрольные точки: ${checkHighlights.join(', ')}`);
    }
    if (balanceSubjects.length > 0) {
        items.push(outputLanguage === 'en'
            ? `Balance-related behavior checks for documents: ${balanceSubjects.join(', ')}`
            : `Проверки поведения остатков и проведения документов: ${balanceSubjects.join(', ')}`);
    }
    if (documentSubjects.length > 0) {
        items.push(outputLanguage === 'en'
            ? `End-to-end processing of key objects and documents: ${documentSubjects.join(', ')}`
            : `Сквозное оформление ключевых объектов и документов: ${documentSubjects.join(', ')}`);
    }
    if (registerSubjects.length > 0) {
        items.push(outputLanguage === 'en'
            ? `Register and accounting movement checks: ${registerSubjects.join(', ')}`
            : `Проверки регистров и учетных движений: ${registerSubjects.join(', ')}`);
    }
    if (taxSubjects.length > 0) {
        items.push(outputLanguage === 'en'
            ? `Tax logic and special tax mode checks: ${taxSubjects.join(', ')}`
            : `Проверки налоговой логики и специальных налоговых режимов: ${taxSubjects.join(', ')}`);
    }
    if (currencySubjects.length > 0) {
        items.push(outputLanguage === 'en'
            ? `Currency operations and exchange rate checks: ${currencySubjects.join(', ')}`
            : `Проверки валютных операций и применения курсов: ${currencySubjects.join(', ')}`);
    }
    if (reportSignals.length > 0) {
        items.push(outputLanguage === 'en'
            ? `Reports, templates, and print forms: ${selectScenarioHeadTailItems(reportSignals, 2, 3, 5).join(', ')}`
            : `Отчеты, шаблоны и печатные формы: ${selectScenarioHeadTailItems(reportSignals, 2, 3, 5).join(', ')}`);
    }

    if (items.length > 0) {
        return dedupeOrdered(items, 8);
    }

    return genericChecks;
}

function isScenarioBranchSignal(rawValue: string): boolean {
    const normalized = sanitizeStructuredValue(rawValue);
    return /^Else branch$/i.test(normalized)
        || /variable is (?:equal|not equal) to/i.test(normalized)
        || (/\$[^$]+\$/i.test(normalized)
            && /(?:=|<>|!=|>=|<=|>|<)/.test(normalized));
}

function isScenarioModeSignal(rawValue: string): boolean {
    const normalized = sanitizeStructuredValue(rawValue);
    return /\s=\s(?:TRUE|FALSE)\b/i.test(normalized)
        || /\b(?:Track[A-Za-z]+|Status|Option|Mode)\b\s*=\s*(?:Yes|No|Always|Never|Manual|Automatic|Completed|In progress)/i.test(normalized);
}

function classifyScenarioParameterSignal(rawValue: string): 'branch' | 'mode' | 'business' | 'control' | 'date' | 'generic' {
    const normalized = sanitizeStructuredValue(rawValue);
    if (normalized.length === 0) {
        return 'generic';
    }

    if (isScenarioBranchSignal(normalized)) {
        return 'branch';
    }

    const parsed = parseScenarioAssignmentFact(normalized);
    const key = parsed?.baseKey.toLowerCase() || '';

    if (isScenarioModeSignal(normalized)
        || /(mode|option|status|track|checkbox|radio|visible)/.test(key)
        || /\b(?:manual|always|never|completed|in progress|yes|no)\b/i.test(parsed?.value || '')) {
        return 'mode';
    }
    if (/date|period|from|to/.test(key) || isScenarioDateLikeValue(parsed?.value || normalized)) {
        return 'date';
    }
    if (/amount|price|discount|tax|vat|print|template|report|list|rate|area|message|allocation|quantity/.test(key)) {
        return 'control';
    }
    if (/company|customer|counterparty|supplier|contract|currency|account|iban|swift|warehouse|project|department|role|type|provision|item|description|product|operation|process|line|activity|batch|number/.test(key)) {
        return 'business';
    }

    return 'generic';
}

function humanizeScenarioParameterOrBranch(rawValue: string, outputLanguage: AiOutputLanguage): string {
    const normalized = sanitizeStructuredValue(rawValue);
    if (normalized.length === 0) {
        return '';
    }

    if (/\s\/\s/.test(normalized)) {
        if (/Sales invoice/i.test(normalized) && /Receipts from customers/i.test(normalized)) {
            return outputLanguage === 'en'
                ? 'Control of payment breakdown line linked to the Sales invoice and Receipts from customers.'
                : 'Контроль строки расшифровки платежа по исходному Sales invoice и статье Receipts from customers.';
        }

        if (/Bad debt provision/i.test(normalized) && /Provision - Income/i.test(normalized)) {
            return outputLanguage === 'en'
                ? 'Control of the reserve decrease line for Bad debt provision with operation Provision - Income.'
                : 'Контроль строки уменьшения резерва Bad debt provision с операцией Provision - Income.';
        }

        if (/Bad debt provision/i.test(normalized) && /Expenses - Provision/i.test(normalized)) {
            return outputLanguage === 'en'
                ? 'Control of the reserve accrual line for Bad debt provision with operation Expenses - Provision.'
                : 'Контроль строки начисления резерва Bad debt provision с операцией Expenses - Provision.';
        }

        if (/Miscellaneous payables and receivables - Income/i.test(normalized)) {
            return outputLanguage === 'en'
                ? 'Control of the dividend accrual line for operation Miscellaneous payables and receivables - Income.'
                : 'Контроль строки начисления дивидендов по операции Miscellaneous payables and receivables - Income.';
        }

        if (/Waterfall Fund, ABC computers, EUR/i.test(normalized)) {
            return outputLanguage === 'en'
                ? 'Control of the dividend payment line for contract Waterfall Fund, ABC computers, EUR.'
                : 'Контроль строки оплаты дивидендов по договору Waterfall Fund, ABC computers, EUR.';
        }
    }

    const variableEqualsMatch = normalized.match(/^"([^"]+)" variable is equal to "([^"]+)"$/i);
    if (variableEqualsMatch) {
        return outputLanguage === 'en'
            ? `Branch: run when ${variableEqualsMatch[1]} = ${variableEqualsMatch[2]}`
            : `Ветка: выполнять, если ${variableEqualsMatch[1]} = ${variableEqualsMatch[2]}`;
    }

    const variableNotEqualsMatch = normalized.match(/^"([^"]+)" variable is not equal to "([^"]+)"$/i);
    if (variableNotEqualsMatch) {
        return outputLanguage === 'en'
            ? `Branch: run when ${variableNotEqualsMatch[1]} != ${variableNotEqualsMatch[2]}`
            : `Ветка: выполнять, если ${variableNotEqualsMatch[1]} != ${variableNotEqualsMatch[2]}`;
    }

    if (/^Else branch$/i.test(normalized)) {
        return outputLanguage === 'en'
            ? 'Branch: else path'
            : 'Ветка: путь Else';
    }

    if (isScenarioBranchSignal(normalized)) {
        return outputLanguage === 'en'
            ? `Branch condition: ${normalized}`
            : `Условие ветки: ${normalized}`;
    }

    if (isScenarioModeSignal(normalized)) {
        return outputLanguage === 'en'
            ? `Mode: ${normalized}`
            : `Режим: ${normalized}`;
    }

    return normalized;
}

function buildDeterministicParameterItems(
    chunkSummaries: ScenarioChunkSummary[],
    outputLanguage: AiOutputLanguage
): string[] {
    const stageSummaries = buildSequentialScenarioStageSummaries(chunkSummaries, outputLanguage);
    const parameterValues = chunkSummaries.flatMap(summary => summary.parameters);
    const checkValues = chunkSummaries.flatMap(summary => summary.checks.filter(value =>
        /TaxType|AmountBasisDocument|DocumentAmount|PrintList|PrintForm/i.test(value)
    ));
    const branchSignals = dedupeOrdered(parameterValues.filter(value => classifyScenarioParameterSignal(value) === 'branch'), 6);
    const modeSignals = compactScenarioParameterAssignments(
        parameterValues.filter(value => classifyScenarioParameterSignal(value) === 'mode'),
        6
    );
    const businessSignals = compactScenarioParameterAssignments(
        parameterValues.filter(value => classifyScenarioParameterSignal(value) === 'business'),
        8
    );
    const controlSignals = compactScenarioParameterAssignments(
        [
            ...parameterValues.filter(value => classifyScenarioParameterSignal(value) === 'control'),
            ...checkValues
        ],
        8
    );
    const dateSignals = compactScenarioParameterAssignments(
        parameterValues.filter(value => classifyScenarioParameterSignal(value) === 'date'),
        6
    );
    const orderedModeStages = dedupeOrdered(
        stageSummaries
            .filter(summary => summary.parameters.some(value => classifyScenarioParameterSignal(value) === 'mode'))
            .map(summary => {
                const modeDetails = compactScenarioParameterAssignments(
                    summary.parameters.filter(value => classifyScenarioParameterSignal(value) === 'mode'),
                    3
                );
                if (modeDetails.length === 0) {
                    return summary.title;
                }

                return `${summary.title}: ${modeDetails.join(', ')}`;
            })
            .filter(Boolean),
        8
    );

    const branchItems = branchSignals
        .map(value => humanizeScenarioParameterOrBranch(value, outputLanguage));

    const items = dedupeOrdered([
        ...branchItems,
        ...(orderedModeStages.length > 0
            ? [
                outputLanguage === 'en'
                    ? `Sequential mode and option changes: ${selectScenarioHeadTailItems(orderedModeStages, 2, 3, 5).join(' -> ')}`
                    : `Последовательные смены режимов и опций: ${selectScenarioHeadTailItems(orderedModeStages, 2, 3, 5).join(' -> ')}`
            ]
            : []),
        ...(modeSignals.length > 0
            ? [
                outputLanguage === 'en'
                    ? `Modes, options, and statuses: ${selectScenarioHeadTailItems(modeSignals, 2, 3, 5).join(', ')}`
                    : `Режимы, опции и статусы: ${selectScenarioHeadTailItems(modeSignals, 2, 3, 5).join(', ')}`
            ]
            : []),
        ...(businessSignals.length > 0
            ? [
                outputLanguage === 'en'
                    ? `Key business inputs and requisites: ${selectScenarioHeadTailItems(businessSignals, 2, 3, 5).join(', ')}`
                    : `Ключевые бизнес-данные и реквизиты: ${selectScenarioHeadTailItems(businessSignals, 2, 3, 5).join(', ')}`
            ]
            : []),
        ...(controlSignals.length > 0
            ? [
                outputLanguage === 'en'
                    ? `Control values and verification artifacts: ${selectScenarioHeadTailItems(controlSignals, 2, 3, 5).join(', ')}`
                    : `Контрольные значения и артефакты сверки: ${selectScenarioHeadTailItems(controlSignals, 2, 3, 5).join(', ')}`
            ]
            : []),
        ...(dateSignals.length > 0
            ? [
                outputLanguage === 'en'
                    ? `Important dates and periods: ${selectScenarioHeadTailItems(dateSignals, 2, 3, 5).join(', ')}`
                    : `Важные даты и периоды: ${selectScenarioHeadTailItems(dateSignals, 2, 3, 5).join(', ')}`
            ]
            : [])
    ], 8);

    if (items.length > 0) {
        return items;
    }

    return [
        ...branchSignals,
        ...modeSignals,
        ...businessSignals,
        ...controlSignals,
        ...dateSignals
    ]
        .map(value => humanizeScenarioParameterOrBranch(value, outputLanguage))
        .slice(0, 6);
}

function extractScenarioCoverageAnchors(summary: ScenarioChunkSummary): string[] {
    const titleParts = splitScenarioTitlePath(summary.title)
        .map(value => value.replace(/^Case\s+\d+\s*$/i, '').trim())
        .filter(Boolean);
    const phraseCandidates = [
        ...titleParts,
        ...summary.purpose.map(extractScenarioCoveragePhrase),
        ...summary.actions.map(extractScenarioCoveragePhrase),
        ...summary.checks.map(extractScenarioCoveragePhrase),
        ...summary.parameters.map(extractScenarioCoveragePhrase),
        ...summary.reports.map(extractScenarioCoveragePhrase)
    ];
    const canonicalTerms = [
        ...titleParts,
        ...summary.purpose.flatMap(extractScenarioCanonicalTermsFromValue),
        ...summary.actions.flatMap(extractScenarioCanonicalTermsFromValue),
        ...summary.checks.flatMap(extractScenarioCanonicalTermsFromValue),
        ...summary.parameters.flatMap(extractScenarioCanonicalTermsFromValue),
        ...summary.reports.flatMap(extractScenarioCanonicalTermsFromValue)
    ];

    return dedupeOrdered([
        ...phraseCandidates.filter(isScenarioCoverageAnchorUseful),
        ...canonicalTerms.filter(isScenarioCoverageAnchorUseful)
    ], 10);
}

function isScenarioStrongCoverageSignal(rawValue: string): boolean {
    const normalized = sanitizeStructuredValue(rawValue);
    if (normalized.length === 0) {
        return false;
    }

    return /template|print\s*form|drill-?down|statement|report|000\d+_/i.test(normalized)
        || /^(?:I\s+)?(?:create|check|turn on|turn off|change|post|generate|delete|unpost)\b/i.test(normalized)
        || /table became equal|contains lines|user message|not present|became equal/i.test(normalized)
        || /\b(?:batch|production|wip|invoice|order|receipt|settlement|contract|register|document|batches)\b/i.test(normalized);
}

function buildScenarioCoverageGroups(chunkSummaries: ScenarioChunkSummary[]): ScenarioCoverageGroup[] {
    if (chunkSummaries.length === 0) {
        return [];
    }

    const lateChunkStartIndex = Math.max(0, Math.floor(chunkSummaries.length * 0.55));
    const groups: ScenarioCoverageGroup[] = [];

    for (let index = 0; index < chunkSummaries.length; index++) {
        const summary = chunkSummaries[index];
        const titleAnchors = splitScenarioTitlePath(summary.title)
            .filter(isScenarioCoverageAnchorUseful);
        const hasReportSignals = summary.reports.length > 0 || /report|statement|drill-?down|template|шаблон|отчет/i.test([
            summary.title,
            ...summary.checks,
            ...summary.parameters
        ].join(' '));
        const isCaseBlock = /(?:^|\/)\s*Case\s+\d+/i.test(summary.title);
        const strongSignals = dedupeOrdered([
            ...summary.actions.filter(isScenarioStrongCoverageSignal),
            ...summary.checks.filter(isScenarioStrongCoverageSignal),
            ...summary.reports.filter(isScenarioStrongCoverageSignal)
        ], 4);
        const isLateImportantBlock = index >= lateChunkStartIndex && (
            hasReportSignals
            || strongSignals.length > 0
            || titleAnchors.length > 0
            || summary.parameters.some(value => classifyScenarioParameterSignal(value) === 'branch' || classifyScenarioParameterSignal(value) === 'mode')
        );

        if (!isCaseBlock && !hasReportSignals && !isLateImportantBlock && strongSignals.length === 0 && titleAnchors.length === 0) {
            continue;
        }

        const anchors = dedupeOrdered([
            ...extractScenarioCoverageAnchors(summary),
            ...strongSignals.flatMap(signal => [
                extractScenarioCoveragePhrase(signal),
                ...extractScenarioCanonicalTermsFromValue(signal)
            ]),
            ...titleAnchors
        ].filter(isScenarioCoverageAnchorUseful), 10);
        if (anchors.length === 0) {
            continue;
        }

        groups.push({
            label: summary.title,
            anchors,
            priority: hasReportSignals || isCaseBlock
                ? 'required'
                : isLateImportantBlock
                    ? 'important'
                    : 'important'
        });
    }

    return groups;
}

function findMissingScenarioCoverageGroups(
    description: string,
    chunkSummaries: ScenarioChunkSummary[]
): ScenarioCoverageGroup[] {
    const normalizedDescription = normalizeScenarioCoverageText(description);
    if (normalizedDescription.length === 0) {
        return buildScenarioCoverageGroups(chunkSummaries);
    }

    return buildScenarioCoverageGroups(chunkSummaries).filter(group => !group.anchors.some(anchor => {
        const normalizedAnchor = normalizeScenarioCoverageText(anchor);
        return normalizedAnchor.length >= 4 && normalizedDescription.includes(normalizedAnchor);
    }));
}

function isScenarioCoverageAcceptable(
    missingGroups: ScenarioCoverageGroup[],
    chunkSummaries: ScenarioChunkSummary[]
): boolean {
    const allGroups = buildScenarioCoverageGroups(chunkSummaries);
    const requiredMissingCount = missingGroups.filter(group => group.priority === 'required').length;
    if (requiredMissingCount > 0) {
        return false;
    }

    const importantGroupsCount = allGroups.filter(group => group.priority === 'important').length;
    if (importantGroupsCount === 0) {
        return true;
    }

    const importantMissingCount = missingGroups.filter(group => group.priority === 'important').length;
    const allowedImportantMisses = importantGroupsCount <= 2
        ? 0
        : Math.max(1, Math.floor(importantGroupsCount * 0.25));

    return importantMissingCount <= allowedImportantMisses;
}

function buildDeterministicScenarioDescriptionFromChunks(
    context: ScenarioAnalysisContext,
    chunkSummaries: ScenarioChunkSummary[],
    outputLanguage: AiOutputLanguage
): string {
    const caseTitles = dedupeOrdered(chunkSummaries
        .map(summary => summary.title)
        .filter(title => /(?:^|\/)\s*Case\s+\d+/i.test(title))
        .map(title => title.split('/').map(value => sanitizeStructuredValue(value)).filter(Boolean).slice(-1)[0] || title), 6);
    const reportSignals = dedupeOrdered(
        chunkSummaries.flatMap(summary => summary.reports)
            .filter(value => /report|statement|template|drill-?down|000\d+_/i.test(value)),
        8
    );
    const processStages = buildDeterministicProcessItems(chunkSummaries, outputLanguage);
    const parameterSignals = buildDeterministicParameterItems(chunkSummaries, outputLanguage);
    const checkedItems = dedupeOrdered([
        ...(caseTitles.length > 0
            ? [
                outputLanguage === 'en'
                    ? `Business branches covered: ${caseTitles.join(', ')}`
                    : `Покрываемые бизнес-ветки: ${caseTitles.join(', ')}`
            ]
            : []),
        ...buildDeterministicCheckedItems(chunkSummaries, reportSignals, outputLanguage)
    ], 8);
    const processItems = processStages;
    const parameterItems = dedupeOrdered(parameterSignals, 10);
    const improvementItems = buildDeterministicImprovementItems(context, chunkSummaries, outputLanguage);

    return buildStructuredScenarioDescription({
        checked: checkedItems.join('\n'),
        process: processItems.join('\n'),
        parameters: parameterItems.join('\n'),
        improvement: improvementItems.join('\n')
    }, outputLanguage);
}

function stripScenarioStepKeyword(line: string): string {
    return line
        .trim()
        .replace(/^(?:And|When|Then|Given|But|Но|Если|Иначе|Тогда|Когда|Допустим|И)\s+/i, '')
        .trim();
}

function normalizeScenarioWindowName(value: string): string {
    return sanitizeStructuredValue(
        value
            .replace(/\s+\*+/g, '')
            .replace(/\s+\(create\)/ig, '')
            .replace(/\s+dated\s+\*.*$/i, '')
    );
}

function looksLikeScenarioReportName(value: string): boolean {
    return /report|statement|aging/i.test(value);
}

function isScenarioHighSignalParameterKey(key: string, value: string): boolean {
    return /(Date|Amount|Company|Customer|Counterparty|Contract|Currency|Operation|Provision|Item|Business|Comment|Description|PrintForm|ReportType|Companies|Counterparties|AgingPeriod|Subsystem|Project|Department|GLExpenseAccount|LegalName|CounterpartyRole|CounterpartyType|ContractDescription|Option|Status|Track|Batch|Mode|Number|ProductName|Process)/i.test(key)
        || /\d{1,3}(?:[,\s]\d{3})|\d{4}|EUR|%/.test(value);
}

function collectScenarioParameterAssignmentLines(
    lines: string[],
    startIndex: number
): {
    assignments: string[];
    nextIndex: number;
} {
    const assignments: string[] = [];
    let nextIndex = startIndex;

    for (let index = startIndex + 1; index < lines.length; index++) {
        const trimmedLine = lines[index].trim();
        const match = trimmedLine.match(/^([A-Za-zА-Яа-яЁё0-9_]+)\s*=\s*'(.*)'$/);
        if (!match) {
            break;
        }

        if (isScenarioHighSignalParameterKey(match[1], match[2] || '')) {
            assignments.push(`${match[1]} = ${match[2] || ''}`);
        }
        nextIndex = index;
    }

    return {
        assignments,
        nextIndex
    };
}

function parseScenarioAssignmentFact(rawValue: string): { key: string; value: string; baseKey: string; } | null {
    const match = sanitizeStructuredValue(rawValue).match(/^([A-Za-zА-Яа-яЁё0-9_ .()/-]+?)\s*=\s*(.+)$/);
    if (!match) {
        return null;
    }

    const normalizedKey = sanitizeStructuredValue(match[1])
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return {
        key: normalizedKey,
        value: match[2],
        baseKey: normalizedKey.replace(/\d+$/, '')
    };
}

function isScenarioDateLikeValue(rawValue: string): boolean {
    const normalized = sanitizeStructuredValue(rawValue);
    return /\b\d{1,2}\/\s*\d{1,2}\/\d{4}\b/.test(normalized)
        || /\b\d{4}-\d{2}-\d{2}\b/.test(normalized)
        || /\b(?:AM|PM)\b/i.test(normalized);
}

function compactScenarioParameterAssignments(assignments: string[], maxItems = 8): string[] {
    const passthroughValues = dedupeOrdered(assignments.filter(value => !parseScenarioAssignmentFact(value)), 12);
    const parsedAssignments = assignments
        .map(parseScenarioAssignmentFact)
        .filter((value): value is { key: string; value: string; baseKey: string; } => Boolean(value));
    if (parsedAssignments.length === 0) {
        return dedupeOrdered(assignments, maxItems);
    }

    const groupedAssignments = new Map<string, Array<{ key: string; value: string; baseKey: string; }>>();
    for (const assignment of parsedAssignments) {
        const groupKey = assignment.baseKey.length > 0 ? assignment.baseKey : assignment.key;
        const bucket = groupedAssignments.get(groupKey) || [];
        bucket.push(assignment);
        groupedAssignments.set(groupKey, bucket);
    }

    const compacted: string[] = [];
    for (const [, groupAssignments] of groupedAssignments) {
        const uniqueValues = dedupeOrdered(groupAssignments.map(value => value.value), 12);
        const displayKey = groupAssignments[0].baseKey || groupAssignments[0].key;

        if (uniqueValues.length >= 3 && uniqueValues.every(isScenarioDateLikeValue)) {
            compacted.push(`${displayKey}: ${uniqueValues[0]} .. ${uniqueValues[uniqueValues.length - 1]} (${uniqueValues.length} values)`);
            continue;
        }

        if (uniqueValues.length >= 3) {
            compacted.push(`${displayKey}: ${uniqueValues.slice(0, 3).join(', ')}${uniqueValues.length > 3 ? ', ...' : ''}`);
            continue;
        }

        if (uniqueValues.length === 2 && groupAssignments.every(value => value.baseKey === displayKey)) {
            compacted.push(`${displayKey}: ${uniqueValues.join(', ')}`);
            continue;
        }

        compacted.push(...groupAssignments.map(value => `${value.key} = ${value.value}`));
    }

    return dedupeOrdered([
        ...passthroughValues,
        ...compacted
    ], maxItems);
}

function summarizeScenarioParameterAssignments(assignments: string[], maxItems = 4): string {
    return compactScenarioParameterAssignments(assignments, maxItems).join(', ');
}

function isScenarioInterestingFieldName(fieldName: string, value: string): boolean {
    return /(Date|Amount|Payment|Company|Customer|Counterparty|Contract|Operation|Provision|Item|Business|Comment|Description|Pattern|Filter|Income|Expense|Document|Message|Price|VAT|Status|Track|Batch|Lifecycle|Process|Option|Radio)/i.test(fieldName)
        || /\d{1,3}(?:[,\s]\d{3})|\d{4}|EUR|%/.test(value);
}

function extractScenarioFieldAssignments(line: string): string[] {
    const patterns: RegExp[] = [
        /input "([^"]*)" text in the field named "([^"]+)"/i,
        /input "([^"]*)" text in the field named "([^"]+)" of "([^"]+)" table/i,
        /select "([^"]+)" exact value from the drop-down list named "([^"]+)"/i,
        /select "([^"]+)" exact value from "([^"]+)" drop-down list/i,
        /select from the drop-down list named "([^"]+)" by "([^"]+)" string/i,
        /select from "([^"]+)" drop-down list by "([^"]+)" string/i,
        /save the value of the field named "([^"]+)" as "([^"]+)"/i,
        /change the radio button named "([^"]+)" value to "([^"]+)"/i,
        /change "([^"]+)" radio button value to "([^"]+)"/i,
        /change the checkbox named "([^"]+)" value to "([^"]+)"/i,
        /change "([^"]+)" checkbox value to "([^"]+)"/i
    ];

    for (const pattern of patterns) {
        const match = line.match(pattern);
        if (!match) {
            continue;
        }

        if (pattern.source.includes('save the value of the field')
            || pattern.source.includes('change the radio button named')
            || pattern.source.includes('change "')
            || pattern.source.includes('change the checkbox named')) {
            const fieldName = match[1] || '';
            const value = match[2] || '';
            return isScenarioInterestingFieldName(fieldName, value)
                ? [`${fieldName} = ${value}`]
                : [];
        }

        if (pattern.source.includes('select from the drop-down list named')) {
            const fieldName = match[1] || '';
            const value = match[2] || '';
            return isScenarioInterestingFieldName(fieldName, value)
                ? [`${fieldName} = ${value}`]
                : [];
        }

        if (pattern.source.includes('select from "')) {
            const fieldName = match[1] || '';
            const value = match[2] || '';
            return isScenarioInterestingFieldName(fieldName, value)
                ? [`${fieldName} = ${value}`]
                : [];
        }

        if (pattern.source.includes('exact value from "')) {
            const value = match[1] || '';
            const fieldName = match[2] || '';
            return isScenarioInterestingFieldName(fieldName, value)
                ? [`${fieldName} = ${value}`]
                : [];
        }

        if (pattern.source.includes('exact value from the drop-down list named')) {
            const value = match[1] || '';
            const fieldName = match[2] || '';
            return isScenarioInterestingFieldName(fieldName, value)
                ? [`${fieldName} = ${value}`]
                : [];
        }

        const value = match[1] || '';
        const fieldName = match[2] || '';
        const tableName = match[3];
        if (!isScenarioInterestingFieldName(fieldName, value)) {
            return [];
        }

        return tableName
            ? [`${fieldName} (${tableName}) = ${value}`]
            : [`${fieldName} = ${value}`];
    }

    return [];
}

function isScenarioLowSignalUiStep(stepText: string): boolean {
    return /^(?:I click\b|I input\b|I select\b|I move\b|I go to\b|I activate\b|I finish\b|I wait\b|I remove\b|I set checkbox\b|I set\b|I close\b|I double-click\b|I choose\b|I save number\b|I save the value\b)/i.test(stepText);
}

function extractScenarioHighLevelStepFact(line: string): {
    kind: 'action' | 'check';
    fact: string;
} | null {
    const stepText = stripScenarioStepKeyword(line);
    if (!/^I\b/i.test(stepText) || isScenarioLowSignalUiStep(stepText)) {
        return null;
    }

    const normalized = sanitizeStructuredValue(stepText);
    if (normalized.length === 0) {
        return null;
    }

    if (/^I check\b/i.test(normalized)
        || /\bregister\b|\blimit\b|\brates\b|\breverse charge\b|\breport\b|\bstatement\b|\boverdraft\b/i.test(normalized)) {
        return {
            kind: 'check',
            fact: normalized
        };
    }

    return {
        kind: 'action',
        fact: normalized
    };
}

function collectScenarioTableRows(
    lines: string[],
    startIndex: number
): {
    rows: string[];
    nextIndex: number;
} {
    const rows: string[] = [];
    let nextIndex = startIndex;

    for (let index = startIndex + 1; index < lines.length; index++) {
        const trimmedLine = lines[index].trim();
        if (!trimmedLine.startsWith('|')) {
            break;
        }

        rows.push(trimmedLine);
        nextIndex = index;
    }

    return {
        rows,
        nextIndex
    };
}

function summarizeScenarioTableRows(rows: string[]): string {
    if (rows.length === 0) {
        return '';
    }

    const parsedRows = rows
        .map(row => row.split('|').map(cell => cell.trim()).filter(Boolean))
        .filter(cells => cells.length > 0);
    const dataRows = parsedRows.length > 1 ? parsedRows.slice(1, 3) : parsedRows.slice(0, 1);
    const rowPreviews = dataRows
        .map(cells => cells.filter(Boolean).slice(0, 4).join(' / '))
        .filter(Boolean);

    return sanitizeStructuredValue(rowPreviews.join(' ; '));
}

function summarizeScenarioTableAssertion(
    tableName: string,
    assertionKind: string,
    rows: string[]
): string {
    const preview = summarizeScenarioTableRows(rows);
    const normalizedTableName = sanitizeStructuredValue(tableName);
    if (preview.length === 0) {
        return `${normalizedTableName} ${assertionKind}`;
    }

    return `${normalizedTableName} ${assertionKind}: ${preview}`;
}

function buildDeterministicScenarioPurposeFacts(
    title: string,
    actions: string[],
    checks: string[],
    reports: string[]
): string[] {
    const facts: string[] = [];
    if (title.length > 0 && !/^Block \d+$/i.test(title)) {
        facts.push(title);
    }
    if (reports.length > 0) {
        facts.push(`Report focus: ${reports.slice(0, 2).join(', ')}`);
    }
    if (actions.length > 0) {
        facts.push(actions[0]);
    }
    if (checks.length > 0) {
        facts.push(checks[0]);
    }

    return dedupeOrdered(facts, 3);
}

function buildDeterministicScenarioChunkSummary(chunk: ScenarioBodyChunk): ScenarioChunkSummary {
    const actions: string[] = [];
    const checks: string[] = [];
    const parameters: string[] = [];
    const reports: string[] = [];
    const lines = chunk.text.split('\n');
    let currentWindowName = '';

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const trimmedLine = lines[lineIndex].trim();
        if (trimmedLine.length === 0 || isScenarioCommentHeadingLine(trimmedLine)) {
            continue;
        }

        const windowMatch = trimmedLine.match(/^(?:Then|And)\s+"([^"]+)" window is opened/i);
        if (windowMatch) {
            currentWindowName = normalizeScenarioWindowName(windowMatch[1] || '');
            if (looksLikeScenarioReportName(currentWindowName)) {
                reports.push(currentWindowName);
            }
            continue;
        }

        if (/^(If|ElseIf)\b/i.test(trimmedLine)) {
            parameters.push(stripScenarioStepKeyword(trimmedLine).replace(/\s+Then$/i, ''));
            continue;
        }
        if (/^Else$/i.test(stripScenarioStepKeyword(trimmedLine))) {
            parameters.push('Else branch');
            continue;
        }

        const tableAssertionMatch = trimmedLine.match(/^(?:And|Then|But)\s+"([^"]+)" table (became equal(?: by template)?|contains lines)/i);
        if (tableAssertionMatch) {
            const tableRows = collectScenarioTableRows(lines, lineIndex);
            checks.push(summarizeScenarioTableAssertion(
                tableAssertionMatch[1] || '',
                sanitizeStructuredValue(tableAssertionMatch[2] || ''),
                tableRows.rows
            ));
            lineIndex = tableRows.nextIndex;
            continue;
        }

        const spreadsheetTemplateMatch = trimmedLine.match(/^(?:And|Then|But)\s+"([^"]+)" spreadsheet document is equal to "([^"]+)"/i);
        if (spreadsheetTemplateMatch) {
            checks.push(`${spreadsheetTemplateMatch[1]} template ${spreadsheetTemplateMatch[2]}`);
            reports.push(spreadsheetTemplateMatch[2]);
            continue;
        }

        const formAttributeMatch = trimmedLine.match(/form attribute named "([^"]+)" became equal to "([^"]*)"/i);
        if (formAttributeMatch) {
            checks.push(`${formAttributeMatch[1]} = ${formAttributeMatch[2]}`);
            continue;
        }

        const fieldPresenceMatch = trimmedLine.match(/field "([^"]+)" is (not present|present) on the form/i);
        if (fieldPresenceMatch) {
            checks.push(`${fieldPresenceMatch[1]} ${fieldPresenceMatch[2]}`);
            continue;
        }

        const userMessageMatch = trimmedLine.match(/wait that in user messages the ['"](.+?)['"] substring will appear/i);
        if (userMessageMatch) {
            checks.push(`User message: ${sanitizeStructuredValue(userMessageMatch[1] || '')}`);
            continue;
        }

        const generateReportMatch = trimmedLine.match(/GenerateReport/i);
        if (generateReportMatch) {
            actions.push(currentWindowName.length > 0
                ? `Generate report "${currentWindowName}"`
                : 'Generate report');
            if (currentWindowName.length > 0) {
                reports.push(currentWindowName);
            }
            continue;
        }

        const postButtonMatch = trimmedLine.match(/I click "Post" button/i);
        if (postButtonMatch) {
            actions.push(currentWindowName.length > 0
                ? `Post "${currentWindowName}"`
                : 'Post document');
            continue;
        }

        const reportWaitMatch = trimmedLine.match(/wait for "([^"]+)" spreadsheet document filling/i);
        if (reportWaitMatch) {
            actions.push(`Wait for ${reportWaitMatch[1]} fill`);
            continue;
        }

        const highLevelStepFact = extractScenarioHighLevelStepFact(trimmedLine);
        if (highLevelStepFact) {
            const parameterAssignments = collectScenarioParameterAssignmentLines(lines, lineIndex);
            const assignmentPreview = summarizeScenarioParameterAssignments(parameterAssignments.assignments);
            const stepFact = (
                assignmentPreview.length > 0
                    ? `${highLevelStepFact.fact} [${assignmentPreview}]`
                    : highLevelStepFact.fact
            );
            if (highLevelStepFact.kind === 'check') {
                checks.push(stepFact);
            } else {
                actions.push(stepFact);
            }
            parameters.push(...parameterAssignments.assignments);
            if (/report|statement|aging/i.test(stepFact)) {
                reports.push(highLevelStepFact.fact);
            }
            lineIndex = parameterAssignments.nextIndex;
            continue;
        }

        const fieldAssignments = extractScenarioFieldAssignments(trimmedLine);
        if (fieldAssignments.length > 0) {
            parameters.push(...fieldAssignments);
            continue;
        }

        const parameterAssignmentMatch = trimmedLine.match(/^([A-Za-zА-Яа-яЁё0-9_]+)\s*=\s*'(.*)'$/);
        if (parameterAssignmentMatch && isScenarioHighSignalParameterKey(parameterAssignmentMatch[1], parameterAssignmentMatch[2] || '')) {
            const parameterFact = `${parameterAssignmentMatch[1]} = ${parameterAssignmentMatch[2] || ''}`;
            parameters.push(parameterFact);
            if (/PrintForm/i.test(parameterAssignmentMatch[1])) {
                reports.push(parameterAssignmentMatch[2] || '');
            }
            continue;
        }
    }

    const normalizedActions = dedupeOrdered(actions, 8);
    const normalizedChecks = dedupeOrdered(checks, 8);
    const normalizedParameters = compactScenarioParameterAssignments(parameters, 12);
    const normalizedReports = dedupeOrdered(reports, 8);

    return {
        index: chunk.index,
        title: chunk.title,
        purpose: buildDeterministicScenarioPurposeFacts(chunk.title, normalizedActions, normalizedChecks, normalizedReports),
        actions: normalizedActions,
        checks: normalizedChecks,
        parameters: normalizedParameters,
        reports: normalizedReports
    };
}

function buildDeterministicScenarioChunkSummaries(bodyText: string): ScenarioChunkSummary[] {
    return buildScenarioLogicalBlocks(bodyText, 3600)
        .map(buildDeterministicScenarioChunkSummary)
        .filter(summary => !isScenarioChunkSummaryEmpty(summary));
}

function extractScenarioNameFromDocument(documentText: string): string {
    return documentText.match(/^\s*Имя:\s*"([^"]+)"/m)?.[1]?.trim() || '';
}

function isScenarioParameterizedUtilityScenario(context: ScenarioAnalysisContext): boolean {
    const branchCount = Array.from(context.scenarioBody.matchAll(/^\s*If\b/igm)).length;
    const loopCount = Array.from(context.scenarioBody.matchAll(/\bDo While\b/ig)).length;
    return !context.isStandaloneMainScenario
        && context.declaredParameters.size >= 6
        && (branchCount >= 2 || loopCount >= 1 || context.nestedScenarioNames.length > 0);
}

function extractScenarioPrimaryCreateWindowName(bodyText: string): string {
    for (const rawLine of bodyText.split(/\r\n|\r|\n/)) {
        const trimmedLine = rawLine.trim();
        const match = trimmedLine.match(/^(?:Then|And)\s+"([^"]+)" window is opened/i);
        if (!match?.[1]) {
            continue;
        }

        if (!/\(create\)/i.test(match[1])) {
            continue;
        }

        return normalizeScenarioWindowName(match[1]);
    }

    return '';
}

function collectScenarioNestedScenarioInvocations(context: ScenarioAnalysisContext): string[] {
    if (context.nestedScenarioNames.length === 0) {
        return [];
    }

    const result: string[] = [];
    const seen = new Set<string>();
    const normalizedNestedNames = context.nestedScenarioNames
        .map(name => sanitizeStructuredValue(name))
        .filter(Boolean);

    for (const rawLine of context.scenarioBody.split(/\r\n|\r|\n/)) {
        const stepText = sanitizeStructuredValue(stripScenarioStepKeyword(rawLine));
        if (stepText.length === 0) {
            continue;
        }

        for (const nestedScenarioName of normalizedNestedNames) {
            if (stepText.toLowerCase().startsWith(nestedScenarioName.toLowerCase())) {
                const key = nestedScenarioName.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(nestedScenarioName);
                }
            }
        }
    }

    return result;
}

function collectScenarioBranchConditionsFromBody(bodyText: string): string[] {
    const result: string[] = [];
    for (const rawLine of bodyText.split(/\r\n|\r|\n/)) {
        const trimmedLine = rawLine.trim();
        if (!/^(If|ElseIf)\b/i.test(trimmedLine)) {
            continue;
        }

        result.push(stripScenarioStepKeyword(trimmedLine).replace(/\s+Then$/i, ''));
    }

    return dedupeOrdered(result, 12);
}

function collectScenarioLoopSignalsFromBody(bodyText: string): string[] {
    const result: string[] = [];
    for (const rawLine of bodyText.split(/\r\n|\r|\n/)) {
        const trimmedLine = rawLine.trim();
        if (/^Do While\b/i.test(trimmedLine)) {
            result.push(sanitizeStructuredValue(trimmedLine));
        }
    }

    return dedupeOrdered(result, 6);
}

function buildDeterministicParameterizedUtilityScenarioDescription(
    context: ScenarioAnalysisContext,
    outputLanguage: AiOutputLanguage
): string {
    const scenarioName = extractScenarioNameFromDocument(context.documentText) || 'Scenario';
    const fullSummary = buildDeterministicScenarioChunkSummary({
        index: 1,
        total: 1,
        startLineNumber: 1,
        endLineNumber: context.scenarioBody.split(/\r\n|\r|\n/).length,
        title: scenarioName,
        structureHints: [],
        reportHints: [],
        text: context.scenarioBody
    });
    const targetObjectName = extractScenarioPrimaryCreateWindowName(context.scenarioBody);
    const nestedInvocations = collectScenarioNestedScenarioInvocations(context);
    const branchConditions = collectScenarioBranchConditionsFromBody(context.scenarioBody);
    const loopSignals = collectScenarioLoopSignalsFromBody(context.scenarioBody);
    const declaredParameterNames = selectScenarioHeadTailItems(
        Array.from(context.declaredParameters.keys()).map(name => `[${name}]`),
        6,
        4,
        10
    );
    const businessSignals = compactScenarioParameterAssignments(
        fullSummary.parameters.filter(value => classifyScenarioParameterSignal(value) === 'business'),
        8
    );
    const modeSignals = compactScenarioParameterAssignments(
        fullSummary.parameters.filter(value => classifyScenarioParameterSignal(value) === 'mode'),
        6
    );
    const dateSignals = compactScenarioParameterAssignments(
        fullSummary.parameters.filter(value => classifyScenarioParameterSignal(value) === 'date'),
        6
    );
    const finalChecks = selectScenarioHeadTailItems(
        dedupeOrdered(
            fullSummary.checks.filter(value => /contains lines|became equal|present on the form|not present|template/i.test(value))
                .map(value => humanizeScenarioParameterOrBranch(value, outputLanguage)),
            8
        ),
        2,
        3,
        5
    );
    const improvementItems = buildDeterministicImprovementItems(context, [fullSummary], outputLanguage);

    const checkedItems = dedupeOrdered([
        targetObjectName.length > 0
            ? (outputLanguage === 'en'
                ? `Reusable parameterized scenario for creating and filling "${targetObjectName}".`
                : `Переиспользуемый параметризованный сценарий для создания и заполнения "${targetObjectName}".`)
            : (outputLanguage === 'en'
                ? `Reusable parameterized scenario "${scenarioName}" for filling a target object or form.`
                : `Переиспользуемый параметризованный сценарий "${scenarioName}" для заполнения целевого объекта или формы.`),
        nestedInvocations.length > 0
            ? (outputLanguage === 'en'
                ? `It covers invocation of nested helper scenarios: ${nestedInvocations.join(', ')}.`
                : `Он покрывает вызов вложенных helper-сценариев: ${nestedInvocations.join(', ')}.`)
            : '',
        branchConditions.length > 0
            ? (outputLanguage === 'en'
                ? `It verifies alternative branches controlled by input parameters and conditional checks.`
                : `Он покрывает альтернативные ветки, которые управляются входными параметрами и условными проверками.`)
            : '',
        finalChecks.length > 0
            ? (outputLanguage === 'en'
                ? `The result is confirmed by final checks: ${finalChecks.join(', ')}`
                : `Результат подтверждается финальными проверками: ${finalChecks.join(', ')}`)
            : ''
    ].filter(Boolean), 4);

    const processItems = dedupeOrdered([
        outputLanguage === 'en'
            ? 'Prepares incoming placeholders, converts grouped string parameters into arrays, and saves intermediate service variables for further steps.'
            : 'Подготавливает входные placeholder-параметры, преобразует групповые строковые параметры в массивы и сохраняет промежуточные служебные переменные для дальнейших шагов.',
        targetObjectName.length > 0
            ? (outputLanguage === 'en'
                ? `Opens the target area, selects the base object, and creates "${targetObjectName}" with common header fields.`
                : `Открывает нужный раздел, выбирает базовый объект и создает "${targetObjectName}" с заполнением общих реквизитов.`)
            : '',
        businessSignals.length > 0
            ? (outputLanguage === 'en'
                ? `Common business data is filled from parameters such as ${selectScenarioHeadTailItems(businessSignals, 3, 3, 6).join(', ')}.`
                : `Общие бизнес-данные заполняются из параметров, например: ${selectScenarioHeadTailItems(businessSignals, 3, 3, 6).join(', ')}.`)
            : '',
        branchConditions.some(value => /AdvancedBom/i.test(value))
            ? (outputLanguage === 'en'
                ? 'Depending on the advanced/non-advanced branch, the scenario either enables extended settings and fills additional rules or follows the regular path for operations and components.'
                : 'В зависимости от ветки advanced/non-advanced сценарий либо включает расширенные настройки и заполняет дополнительные правила, либо идет по обычному пути заполнения операций и компонентов.')
            : '',
        loopSignals.length > 0
            ? (outputLanguage === 'en'
                ? 'For iterative parts, it processes repeated values through loops and sequentially fills rows or operations.'
                : 'Для повторяющихся частей он обрабатывает наборы значений в циклах и последовательно заполняет строки или операции.')
            : '',
        nestedInvocations.length > 0
            ? (outputLanguage === 'en'
                ? `Nested scenarios are used for specialized filling steps: ${nestedInvocations.join(', ')}.`
                : `Для специализированного заполнения используются вложенные сценарии: ${nestedInvocations.join(', ')}.`)
            : '',
        modeSignals.length > 0
            ? (outputLanguage === 'en'
                ? `Before saving, the scenario also sets final modes and statuses: ${selectScenarioHeadTailItems(modeSignals, 2, 3, 5).join(', ')}.`
                : `Перед сохранением сценарий также устанавливает итоговые режимы и статусы: ${selectScenarioHeadTailItems(modeSignals, 2, 3, 5).join(', ')}.`)
            : '',
        finalChecks.length > 0
            ? (outputLanguage === 'en'
                ? 'At the end it writes the object, closes the forms, and verifies that the created result is visible in the list.'
                : 'В конце он записывает объект, закрывает формы и проверяет, что созданный результат появился в списке.')
            : ''
    ].filter(Boolean), 8);

    const parameterItems = dedupeOrdered([
        declaredParameterNames.length > 0
            ? (outputLanguage === 'en'
                ? `Main input parameters: ${declaredParameterNames.join(', ')}`
                : `Основные входные параметры: ${declaredParameterNames.join(', ')}`)
            : '',
        branchConditions.length > 0
            ? (outputLanguage === 'en'
                ? `Logical branches: ${selectScenarioHeadTailItems(branchConditions.map(value => humanizeScenarioParameterOrBranch(value, outputLanguage)), 4, 4, 8).join('; ')}`
                : `Логические ветки: ${selectScenarioHeadTailItems(branchConditions.map(value => humanizeScenarioParameterOrBranch(value, outputLanguage)), 4, 4, 8).join('; ')}`)
            : '',
        loopSignals.length > 0
            ? (outputLanguage === 'en'
                ? 'The scenario contains loops for repeated processing of parameter arrays and row-by-row filling.'
                : 'Сценарий содержит циклы для повторной обработки массивов параметров и построчного заполнения.')
            : '',
        dateSignals.length > 0
            ? (outputLanguage === 'en'
                ? `Important dates and periods: ${selectScenarioHeadTailItems(dateSignals, 2, 3, 5).join(', ')}`
                : `Важные даты и периоды: ${selectScenarioHeadTailItems(dateSignals, 2, 3, 5).join(', ')}`)
            : '',
        modeSignals.length > 0
            ? (outputLanguage === 'en'
                ? `Modes and statuses: ${selectScenarioHeadTailItems(modeSignals, 2, 3, 5).join(', ')}`
                : `Режимы и статусы: ${selectScenarioHeadTailItems(modeSignals, 2, 3, 5).join(', ')}`)
            : ''
    ].filter(Boolean), 6);

    return buildStructuredScenarioDescription({
        checked: checkedItems.join('\n'),
        process: processItems.join('\n'),
        parameters: parameterItems.join('\n'),
        improvement: improvementItems.join('\n')
    }, outputLanguage);
}

function parseScenarioFactSnapshot(rawValue: string): ScenarioFactSnapshot {
    const sectionValues: Record<'checked' | 'process' | 'parameters' | 'critical', string[]> = {
        checked: [],
        process: [],
        parameters: [],
        critical: []
    };
    const labelToKey: Record<string, keyof typeof sectionValues> = {
        CHECKED: 'checked',
        PROCESS: 'process',
        PARAMETERS: 'parameters',
        CRITICAL: 'critical'
    };

    let currentSection: keyof typeof sectionValues | null = null;
    for (const rawLine of rawValue.split(/\r\n|\r|\n/)) {
        const trimmedLine = rawLine.trim();
        if (trimmedLine.length === 0) {
            continue;
        }

        const match = trimmedLine.match(/^(CHECKED|PROCESS|PARAMETERS|CRITICAL):\s*(.*)$/i);
        if (match) {
            currentSection = labelToKey[match[1].toUpperCase()];
            sectionValues[currentSection].push(match[2] || '');
            continue;
        }

        if (currentSection) {
            sectionValues[currentSection].push(trimmedLine);
        }
    }

    return {
        checked: splitFactValues(sectionValues.checked.join(' || ')),
        process: splitFactValues(sectionValues.process.join(' || ')),
        parameters: splitFactValues(sectionValues.parameters.join(' || ')),
        critical: splitFactValues(sectionValues.critical.join(' || '))
    };
}

function isScenarioFactSnapshotEmpty(snapshot: ScenarioFactSnapshot): boolean {
    return snapshot.checked.length === 0
        && snapshot.process.length === 0
        && snapshot.parameters.length === 0
        && snapshot.critical.length === 0;
}

function mergeScenarioFactSnapshots(snapshots: ScenarioFactSnapshot[]): ScenarioFactSnapshot {
    return {
        checked: dedupeOrdered(snapshots.flatMap(snapshot => snapshot.checked)),
        process: dedupeOrdered(snapshots.flatMap(snapshot => snapshot.process)),
        parameters: dedupeOrdered(snapshots.flatMap(snapshot => snapshot.parameters)),
        critical: dedupeOrdered(snapshots.flatMap(snapshot => snapshot.critical))
    };
}

function formatScenarioFactLine(label: string, values: string[]): string {
    return `${label}: ${values.length > 0 ? values.join(' || ') : '-'}`;
}

function buildScenarioChunkSummaryPrompt(
    context: ScenarioAnalysisContext,
    chunk: ScenarioBodyChunk
): string {
    return [
        'Проанализируй последовательный фрагмент YAML-сценария KOT для 1С.',
        'Нужно выделить бизнес-смысл именно этого фрагмента, чтобы потом собрать полное описание длинного сценария без потери концовки.',
        'Классификация сценария:',
        `- StandaloneMainScenario: ${context.isStandaloneMainScenario ? 'yes' : 'no'}`,
        ...(context.isStandaloneMainScenario
            ? [
                '- Это служебный признак классификации сценария.',
                '- Не упоминай в пользовательском описании технические метаданные вроде PhaseSwitcher.Tab или StandaloneMainScenario.',
                '- Даже если внутри есть параметры или placeholder-ы, не считай сценарий универсальным и не советуй повышать универсальность параметров.'
            ]
            : []),
        '',
        'Верни ровно 5 строк без markdown и без дополнительных комментариев:',
        'PURPOSE: факт 1 || факт 2',
        'ACTIONS: факт 1 || факт 2 || факт 3',
        'CHECKS: факт 1 || факт 2 || факт 3',
        'PARAMETERS: факт 1 || факт 2 || факт 3',
        'REPORTS: факт 1 || факт 2',
        'Правила:',
        '- PURPOSE: коротко опиши смысл и роль фрагмента в общем сценарии.',
        '- ACTIONS: укажи ключевые бизнес-действия, документы, оплаты, корректировки, создания объектов, а не каждый клик.',
        '- CHECKS: укажи, что именно подтверждается или сверяется в этом фрагменте.',
        '- PARAMETERS: только данные, условия, суммы, даты, развилки и важные входные значения; не перечисляй все реквизиты подряд.',
        '- REPORTS: укажи проверки отчетов, spreadsheet templates, drill-down, print forms и связанные сверки; если отчетов нет, поставь "-".',
        '- Не трать место на рутинные строки вида "window is opened" или "I click button", если это не критично для смысла проверки.',
        '- Не выдумывай факты, которых нет в этом фрагменте.',
        '- Обязательно учти и конец фрагмента, а не только его начало.',
        '',
        'Краткое резюме шапки сценария:',
        ...(context.scenarioHeaderSummary.length > 0 ? context.scenarioHeaderSummary : ['- ключевые поля заголовка не выделены']),
        '',
        'Крупные смысловые маркеры всего сценария:',
        ...(context.structureHints.length > 0 ? context.structureHints.slice(0, 10).map(value => `- ${value}`) : ['- явные маркеры сценария не выделены']),
        '',
        'Отчеты и шаблоны, встречающиеся в сценарии:',
        ...(context.reportHints.length > 0 ? context.reportHints.slice(0, 10).map(value => `- ${value}`) : ['- явные отчеты и шаблоны не выделены']),
        '',
        `Фрагмент ${chunk.index}/${chunk.total}: ${chunk.title}`,
        `Строки ${chunk.startLineNumber}-${chunk.endLineNumber}`,
        ...(chunk.structureHints.length > 0 ? ['', 'Маркеры внутри фрагмента:', ...chunk.structureHints.map(value => `- ${value}`)] : []),
        ...(chunk.reportHints.length > 0 ? ['', 'Отчетные сигналы внутри фрагмента:', ...chunk.reportHints.map(value => `- ${value}`)] : []),
        '',
        'Текст фрагмента:',
        '```gherkin',
        chunk.text || '[пустой фрагмент]',
        '```'
    ].join('\n');
}

function buildScenarioChunkSummaryRetryPrompt(basePrompt: string): string {
    return [
        basePrompt,
        '',
        'Важно: предыдущий ответ не удалось разобрать.',
        'Повтори ответ и верни только 5 строк PURPOSE/ACTIONS/CHECKS/PARAMETERS/REPORTS.',
        'Если по какой-то секции фактов нет, поставь "-".'
    ].join('\n');
}

async function requestScenarioChunkSummaryFromAi(
    endpoint: string,
    settings: ScenarioAiSettings,
    context: ScenarioAnalysisContext,
    chunk: ScenarioBodyChunk
): Promise<ScenarioChunkSummary> {
    const prompt = buildScenarioChunkSummaryPrompt(context, chunk);
    const firstAttemptRaw = await requestTextFromAi(
        endpoint,
        settings,
        CHUNK_SUMMARY_SYSTEM_PROMPT,
        prompt
    );
    const firstAttempt = parseScenarioChunkSummary(firstAttemptRaw, chunk);
    if (!isScenarioChunkSummaryEmpty(firstAttempt)) {
        return firstAttempt;
    }

    const retryRaw = await requestTextFromAi(
        endpoint,
        settings,
        CHUNK_SUMMARY_SYSTEM_PROMPT,
        buildScenarioChunkSummaryRetryPrompt(prompt)
    );
    return parseScenarioChunkSummary(retryRaw, chunk);
}

function buildScenarioSynthesisPromptFromChunks(
    context: ScenarioAnalysisContext,
    chunkSummaries: ScenarioChunkSummary[],
    outputLanguage: AiOutputLanguage
): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    const isLongScenario = chunkSummaries.length >= 4 || context.scenarioBody.length > 9000;
    const coverageHints = buildScenarioCoveragePriorityHints(chunkSummaries);
    const consistencyHints = buildScenarioCriticalConsistencyHints(chunkSummaries);
    const canonicalTermHints = buildScenarioCanonicalTermHints(context, chunkSummaries);
    const checkedInstruction = isLongScenario
        ? '<3-6 предложений о том, что именно проверяет сценарий, какие бизнес-результаты и отчеты он подтверждает, и какие отдельные ветки/кейсы охватывает>'
        : '<2-3 достаточно подробных предложения о сути проверки, ожиданиях, бизнес-смысле теста и конкретном объекте проверки>';
    const processInstruction = isLongScenario
        ? '<5-10 предложений о полном ходе сценария от начала до конца, включая поздние блоки и финальные проверки>'
        : '<3-5 предложений о ходе сценария: подготовка, действия пользователя/системы, ключевые этапы и итог>';
    const parametersInstruction = isLongScenario
        ? '<3-6 предложений о важных данных, суммах, датах, условиях, развилках и шаблонах проверок; без перечисления всех реквизитов подряд>'
        : '<2-4 предложения о параметрах, данных, ветках, условиях, проверках и возможных развилках; если их нет, напиши "' + format.missingValue + '">';

    return [
        'На основе последовательной карты сценария составь итоговое описание для блока KOTМетаданные.Описание.',
        'Карта ниже построена напрямую из YAML шагов, параметров, проверок и отчетных сверок. Она важнее любых догадок модели.',
        'Ниже приведена карта всех последовательных фрагментов сценария от начала до конца. Описание обязано покрывать весь сценарий, а не только первые фрагменты.',
        'Если в поздних фрагментах появляются новые бизнес-кейсы, повторные операции, отчеты, print forms или итоговые сверки, их обязательно нужно отразить.',
        'Не пересказывай механически каждое окно и каждый клик. Переводи UI-механику в бизнес-смысл и проверяемый результат.',
        'Если сценарий содержит несколько независимых частей, опиши каждую хотя бы на уровне бизнес-цели и результата.',
        'Если есть проверки отчетов, spreadsheet templates, drill-down или print forms, обязательно упомяни это в секции проверки.',
        'Каждая секция должна начинаться с новой строки. Не склеивай Проверяется, Процесс и Параметры и развилки в один абзац.',
        'Внутри каждой секции используй короткие пункты с префиксом "- ", а не длинную простыню текста.',
        'В итоговом тексте не упоминай служебные технические метаданные PhaseSwitcher.Tab, StandaloneMainScenario, KOT, YAML.',
        'Оставляй на английском только реальные названия документов, отчетов, операций, команд и шаблонов. Обычные фразы и действия пиши естественным русским языком.',
        'Нельзя вставлять сырые Gherkin-строки и команды вроде "I create ...", "I check ...", "List became equal:", "PaymentDetails became equal", "Generate report". Пересказывай их человеческим языком.',
        'В секции "Процесс" можно использовать под-пункты "  - " для дат, сумм и ключевых реквизитов, если это улучшает читаемость.',
        'Если подряд идут однотипные проверки для разных документов, сгруппируй их в один осмысленный пункт вместо повторения одной и той же фразы.',
        'Правила классификации сценария:',
        `- StandaloneMainScenario: ${context.isStandaloneMainScenario ? 'yes' : 'no'}`,
        ...(context.isStandaloneMainScenario
            ? [
                '- Это служебный признак классификации сценария.',
                '- Не упоминай его в итоговом пользовательском тексте.',
                '- Не называй его универсальным и не советуй повышать универсальность параметров.'
            ]
            : []),
        '',
        'Верни ответ в 3 обязательных секциях и, только если есть конкретное полезное замечание по сценарию, добавь 4-ю секцию:',
        `${format.checkedLabel}: ${checkedInstruction}`,
        `${format.processLabel}: ${processInstruction}`,
        `${format.parametersLabel}: ${parametersInstruction}`,
        `(${format.improvementLabel}: <1-2 содержательных предложения, только если замечание конкретное и привязано к сценарию>)`,
        '',
        'Правила:',
        '- Не добавляй никаких других секций.',
        '- Не используй markdown-заголовки, нумерованные списки и code fence.',
        '- Не выдумывай факты, которых нет в карте сценария.',
        '- Если улучшение получается только общим и расплывчатым, не пиши секцию улучшения вообще.',
        '- Каждая секция начинается с отдельной строки в формате "Метка:", а далее идут короткие пункты с префиксом "- ".',
        '- Нельзя писать "Проверяется: ... Процесс: ..." в одной строке.',
        '- Не ссылайся на номера блоков, чанков или фрагментов. Пересказывай сценарий человеческим языком.',
        '- Не подменяй точные названия документов, операций, отчетов и шаблонов более общими словами.',
        '- Не переинтерпретируй суммы, проценты и даты. Если сумма сначала автозаполняется одной величиной, а потом меняется вручную, это нужно описывать как последовательность, а не как одну усредненную сумму.',
        '- Если в карте есть точное имя в кавычках, имя отчета, операции, документа, команды или template id, сохраняй его дословно, без перевода и без замены на близкий русский синоним.',
        '- В секции "Параметры и развилки" обязательно поднимай логические ветки If / ElseIf / Else выше простых дат и статических реквизитов.',
        '- Если в сценарии есть закомментированные шаги, Delay или несколько слабо связанных бизнес-блоков, можно дать конкретную рекомендацию в секции улучшения.',
        '- В обычных фразах избегай рунглиша: английскими оставляй только реальные названия сущностей, документов, отчетов и шаблонов.',
        '',
        'Краткое резюме шапки сценария:',
        ...(context.scenarioHeaderSummary.length > 0 ? context.scenarioHeaderSummary : ['- ключевые поля заголовка не выделены']),
        '',
        'Крупные смысловые маркеры всего сценария:',
        ...(context.structureHints.length > 0 ? context.structureHints.map(value => `- ${value}`) : ['- явные маркеры сценария не выделены']),
        '',
        'Отчеты и шаблоны, встречающиеся в сценарии:',
        ...(context.reportHints.length > 0 ? context.reportHints.map(value => `- ${value}`) : ['- явные отчеты и шаблоны не выделены']),
        '',
        'Поздние и отчетные сигналы, которые нельзя потерять в итоговом описании:',
        ...(coverageHints.length > 0 ? coverageHints : ['- дополнительные сигналы не выделены']),
        '',
        'Факты, которые нельзя исказить при пересказе:',
        ...(consistencyHints.length > 0 ? consistencyHints : ['- отдельные критичные факты не выделены']),
        '',
        'Названия и идентификаторы, которые нужно сохранять дословно:',
        ...(canonicalTermHints.length > 0 ? canonicalTermHints : ['- отдельные канонические названия не выделены']),
        '',
        'Последовательная карта сценария:',
        ...buildScenarioChunkSummaryDigest(chunkSummaries)
    ].join('\n');
}

function buildScenarioValidationPromptFromChunks(
    draftDescription: string,
    context: ScenarioAnalysisContext,
    chunkSummaries: ScenarioChunkSummary[],
    outputLanguage: AiOutputLanguage
): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    const coverageHints = buildScenarioCoveragePriorityHints(chunkSummaries);
    const consistencyHints = buildScenarioCriticalConsistencyHints(chunkSummaries);
    const canonicalTermHints = buildScenarioCanonicalTermHints(context, chunkSummaries);

    return [
        'Проверь черновик описания сценария и исправь его, если он теряет части сценария, особенно поздние фрагменты.',
        'Карта ниже построена напрямую из YAML шагов, параметров, проверок и отчетных сверок. Она важнее любых догадок модели.',
        'Описание считается некорректным, если оно:',
        '- покрывает только начало сценария и пропускает хвост;',
        '- игнорирует отдельные бизнес-кейсы, отчеты, drill-down, print forms или итоговые сверки;',
        '- превращается в список открытых окон вместо бизнес-описания;',
        '- выдумывает детали, которых нет в карте сценария;',
        '- склеивает Проверяется, Процесс и Параметры и развилки в одну строку;',
        '- заменяет точные названия документов, операций, отчетов и шаблонов общими словами;',
        '- сливает несколько разных сумм, дат или шагов в один усредненный факт;',
        '- ссылается на номера блоков или чанков вместо нормального пересказа;',
        '- переводит или подменяет канонические имена, которые в карте нужно оставить дословно.',
        '- перечисляет однотипные проверки копипастой вместо обобщения по группе документов;',
        '- теряет реальные If / ElseIf / Else развилки и подменяет их статическими реквизитами;',
        '- упоминает технические метаданные вроде PhaseSwitcher.Tab или StandaloneMainScenario в пользовательском тексте;',
        '- оставляет рунглиш в обычных фразах, где английским должно оставаться только имя реальной сущности;',
        '- вставляет сырые Gherkin-команды и служебные проверки вроде "I create ...", "I check ...", "List became equal:", "PaymentDetails became equal", "Generate report";',
        ...(context.isStandaloneMainScenario
            ? [
                '- Это служебно классифицируемый самостоятельный сценарий.',
                '- Не называй его универсальным и не советуй повышать универсальность параметров.'
            ]
            : []),
        '',
        `Строгий формат: каждая секция с новой строки, например "${format.checkedLabel}:" и далее пункты с "- "; затем "${format.processLabel}:" с пунктами; затем "${format.parametersLabel}:" с пунктами; при необходимости "${format.improvementLabel}:" с пунктами.`,
        '',
        'Особенно проверь, что в итоге не потерялись эти поздние и отчетные сигналы:',
        ...(coverageHints.length > 0 ? coverageHints : ['- дополнительные сигналы не выделены']),
        '',
        'Особенно проверь, что не искажены эти точные факты:',
        ...(consistencyHints.length > 0 ? consistencyHints : ['- отдельные критичные факты не выделены']),
        '',
        'Эти названия и идентификаторы нужно оставить дословно:',
        ...(canonicalTermHints.length > 0 ? canonicalTermHints : ['- отдельные канонические названия не выделены']),
        '',
        'Карта сценария, которую нужно покрыть полностью:',
        ...buildScenarioChunkSummaryDigest(chunkSummaries),
        '',
        'Черновик описания:',
        draftDescription
    ].join('\n');
}

function buildScenarioChunkAnalysisPrompt(
    context: ScenarioAnalysisContext,
    chunk: ScenarioBodyChunk
): string {
    return [
        'Проанализируй фрагмент YAML-сценария KOT для 1С.',
        'Нужно извлечь только факты из этого фрагмента, чтобы затем собрать полное описание длинного сценария.',
        'Классификация сценария:',
        `- StandaloneMainScenario: ${context.isStandaloneMainScenario ? 'yes' : 'no'}`,
        ...(context.isStandaloneMainScenario
            ? [
                '- Это служебный признак классификации сценария.',
                '- Не упоминай его потом в пользовательском описании.',
                '- Даже если внутри есть параметры или placeholder-ы, не считай его универсальным сценарием и не делай выводов, что ему нужна большая универсальность.'
            ]
            : [
                '- Если во фрагменте есть параметры, placeholder-ы, условия или варианты поведения, зафиксируй их как факты сценария.'
            ]),
        '',
        'Верни ровно 4 строки без markdown и без дополнительных комментариев:',
        'CHECKED: факт 1 || факт 2 || факт 3',
        'PROCESS: факт 1 || факт 2 || факт 3',
        'PARAMETERS: факт 1 || факт 2 || факт 3',
        'CRITICAL: факт 1 || факт 2 || факт 3',
        'Правила:',
        '- Каждый факт короткий и конкретный.',
        '- Если по секции фактов нет, поставь "-".',
        '- Не выдумывай факты, которых нет в этом фрагменте.',
        '- Упоминай конкретные документы, формы, команды, отчеты, параметры, проверки, условия If/Else, циклы, сообщения и конечные ожидания, если они явно есть.',
        '- В PARAMETERS выноси входные данные, placeholder-параметры, условия, альтернативные ветки, проверки ошибок и режимы выполнения.',
        '- Если в фрагменте подряд идут однотипные проверки для нескольких документов, зафиксируй и общий паттерн, и набор документов.',
        '- В CRITICAL выноси детали, которые легко потерять при пересказе: важные названия объектов, ключевые переходы, отрицательные проверки, финальные результаты.',
        '',
        'Краткое резюме шапки сценария:',
        ...(context.scenarioHeaderSummary.length > 0 ? context.scenarioHeaderSummary : ['- ключевые поля заголовка не выделены']),
        '',
        `Фрагмент ${chunk.index}/${chunk.total}, строки ${chunk.startLineNumber}-${chunk.endLineNumber}:`,
        '```gherkin',
        chunk.text || '[пустой фрагмент]',
        '```'
    ].join('\n');
}

function buildScenarioChunkRetryPrompt(basePrompt: string): string {
    return [
        basePrompt,
        '',
        'Важно: предыдущий ответ не удалось разобрать.',
        'Повтори ответ и верни только 4 строки CHECKED/PROCESS/PARAMETERS/CRITICAL.',
        'Если фактов мало, оставь секцию со значением "-".'
    ].join('\n');
}

async function requestScenarioFactSnapshotFromAi(
    endpoint: string,
    settings: ScenarioAiSettings,
    prompt: string
): Promise<ScenarioFactSnapshot> {
    const firstAttemptRaw = await requestTextFromAi(
        endpoint,
        settings,
        FACT_EXTRACTION_SYSTEM_PROMPT,
        prompt
    );
    const firstAttempt = parseScenarioFactSnapshot(firstAttemptRaw);
    if (!isScenarioFactSnapshotEmpty(firstAttempt)) {
        return firstAttempt;
    }

    const retryRaw = await requestTextFromAi(
        endpoint,
        settings,
        FACT_EXTRACTION_SYSTEM_PROMPT,
        buildScenarioChunkRetryPrompt(prompt)
    );
    return parseScenarioFactSnapshot(retryRaw);
}

function buildScenarioFactDigest(snapshot: ScenarioFactSnapshot): string[] {
    return [
        formatScenarioFactLine('CHECKED', snapshot.checked),
        formatScenarioFactLine('PROCESS', snapshot.process),
        formatScenarioFactLine('PARAMETERS', snapshot.parameters),
        formatScenarioFactLine('CRITICAL', snapshot.critical)
    ];
}

function buildScenarioSynthesisPrompt(
    context: ScenarioAnalysisContext,
    facts: ScenarioFactSnapshot,
    outputLanguage: AiOutputLanguage
): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    const hasDeclaredOrUsedParameters = context.parameterLines.length > 0 || context.usedPlaceholderLines.length > 0;

    return [
        'На основе уже собранных фактов составь итоговое описание для блока KOTМетаданные.Описание.',
        'Факты ниже считаются опорной выжимкой по полному сценарию.',
        'Правила классификации сценария:',
        `- StandaloneMainScenario: ${context.isStandaloneMainScenario ? 'yes' : 'no'}`,
        ...(context.isStandaloneMainScenario
            ? [
                '- Это служебный признак классификации сценария.',
                '- Не упоминай его в итоговом пользовательском тексте.',
                '- Даже если в нем есть параметры и placeholder-ы, не называй сценарий универсальным.',
                '- Не советуй делать параметры более универсальными, переиспользуемыми или абстрактными.'
            ]
            : hasDeclaredOrUsedParameters
                ? [
                    '- В сценарии есть параметры и placeholder-ы. Учитывай их как источник вариативности.'
                ]
                : []),
        '',
        'Верни ответ в 3 обязательных секциях и, только если есть конкретное полезное замечание по сценарию, добавь 4-ю секцию:',
        `${format.checkedLabel}: <2-3 достаточно подробных предложения о сути проверки, ожиданиях, бизнес-смысле теста и конкретном объекте проверки>`,
        `${format.processLabel}: <3-5 предложений о ходе сценария: подготовка, действия пользователя/системы, ключевые этапы и итог>`,
        `${format.parametersLabel}: <2-4 предложения о параметрах, данных, ветках, условиях, проверках и возможных развилках; если их нет, напиши "${format.missingValue}">`,
        `(${format.improvementLabel}: <1-2 содержательных предложения, только если замечание конкретное и привязано к сценарию>)`,
        '',
        'Правила:',
        '- Не добавляй никаких других секций.',
        '- Внутри каждой секции используй короткие пункты с префиксом "- ", а не длинные абзацы.',
        '- Не используй markdown-заголовки, нумерованные списки и code fence.',
        '- Не выдумывай факты, которых нет в сводке.',
        '- Не делай текст чрезмерно кратким.',
        '- Если улучшение получается только общим и расплывчатым, не пиши секцию улучшения вообще.',
        '- Если в фактах есть проверки, условия, циклы, развилки или негативные ветки, отрази их в описании.',
        '- Каждая секция начинается с отдельной строки в формате "Метка:", а далее идут короткие пункты с префиксом "- ".',
        '- В обычных фразах избегай рунглиша: английскими оставляй только реальные названия сущностей, документов, отчетов и шаблонов.',
        '- Нельзя вставлять сырые Gherkin-строки и команды вроде "I create ...", "I check ...", "List became equal:", "PaymentDetails became equal", "Generate report".',
        '- В секции "Процесс" можно использовать под-пункты "  - " для ключевых дат, сумм и реквизитов.',
        '',
        'Краткое резюме шапки сценария:',
        ...(context.scenarioHeaderSummary.length > 0 ? context.scenarioHeaderSummary : ['- ключевые поля заголовка не выделены']),
        '',
        `Путь файла: ${context.documentUri.fsPath}`,
        '',
        'Сводка фактов по сценарию:',
        ...buildScenarioFactDigest(facts)
    ].join('\n');
}

function buildScenarioValidationPrompt(
    draftDescription: string,
    context: ScenarioAnalysisContext,
    facts: ScenarioFactSnapshot,
    outputLanguage: AiOutputLanguage
): string {
    const format = getDescriptionOutputFormat(outputLanguage);

    return [
        'Проверь черновик описания сценария и исправь его, если он теряет важные детали, выдумывает лишнее или нарушает ограничения.',
        'Сводка фактов и классификация сценария ниже важнее черновика.',
        'Что нужно проверить:',
        '- Все ключевые проверки, этапы процесса, параметры, условия и развилки должны соответствовать сводке фактов.',
        '- Если в черновике есть домыслы, убери их.',
        '- Если в фактах есть существенные детали, которые потерялись, верни их в итоговый текст.',
        ...(context.isStandaloneMainScenario
            ? [
                '- Это служебно классифицируемый самостоятельный сценарий.',
                '- Не упоминай этот технический факт в пользовательском тексте.',
                '- Не называй его универсальным и не советуй делать параметры более универсальными.'
            ]
            : []),
        '- Сохрани тот же формат ответа и не добавляй лишние секции.',
        '- Внутри каждой секции используй короткие пункты с префиксом "- ".',
        '- В обычных фразах не оставляй рунглиш, если это не имя реальной сущности.',
        '- Не оставляй сырые Gherkin-команды и служебные проверки в итоговом тексте.',
        '',
        `Строгий формат: "${format.checkedLabel}:" и далее пункты с "- "; затем "${format.processLabel}:" с пунктами; затем "${format.parametersLabel}:" с пунктами; при необходимости "${format.improvementLabel}:" с пунктами.`,
        '',
        'Классификация сценария:',
        `- StandaloneMainScenario: ${context.isStandaloneMainScenario ? 'yes' : 'no'}`,
        '',
        'Сводка фактов по сценарию:',
        ...buildScenarioFactDigest(facts),
        '',
        'Черновик описания:',
        draftDescription
    ].join('\n');
}

function containsStandaloneScenarioUniversalizationAdvice(
    improvementText: string,
    outputLanguage: AiOutputLanguage
): boolean {
    if (!improvementText) {
        return false;
    }

    const patterns = outputLanguage === 'en'
        ? [
            /universal/i,
            /parameteriz/i,
            /make .* parameter/i,
            /generaliz/i,
            /reusab/i
        ]
        : [
            /универсальн/i,
            /параметриз/i,
            /обобщ/i,
            /переиспользуем/i,
            /сделать .* параметр/i
        ];

    return patterns.some(pattern => pattern.test(improvementText));
}

function enforceStandaloneMainScenarioConstraints(
    description: string,
    outputLanguage: AiOutputLanguage,
    isStandaloneMainScenario: boolean
): string {
    if (!isStandaloneMainScenario) {
        return description;
    }

    const normalized = tryNormalizeStructuredScenarioDescription(description, outputLanguage)
        || buildFallbackScenarioDescription(description, outputLanguage);
    if (normalized.length === 0) {
        return normalized;
    }

    const format = getDescriptionOutputFormat(outputLanguage);
    const lines = normalized.split('\n');
    const resultLines: string[] = [];
    const improvementPattern = new RegExp(
        `^(?:[-*•]\\s*)?\\(?${escapeRegexLiteral(format.improvementLabel)}:\\s*(.*?)\\)?$`,
        'i'
    );
    const standaloneTechnicalLinePattern = outputLanguage === 'en'
        ? /(?:PhaseSwitcher\.Tab|StandaloneMainScenario|standalone main scenario)/i
        : /(?:PhaseSwitcher\.Tab|StandaloneMainScenario|самостоятельн(?:ый|ая|ое|ого|ому|ым|ом)\s+главн(?:ый|ая|ое|ого|ому|ым|ом)\s+сценари)/iu;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (standaloneTechnicalLinePattern.test(trimmedLine)) {
            continue;
        }

        const improvementMatch = trimmedLine.match(improvementPattern);
        if (improvementMatch) {
            const improvementValue = sanitizeStructuredValue(improvementMatch[1] || '');
            if (containsStandaloneScenarioUniversalizationAdvice(improvementValue, outputLanguage)) {
                continue;
            }
        }

        resultLines.push(line);
    }

    return resultLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hasRawScenarioLogStyleLeak(description: string): boolean {
    const normalized = normalizeGeneratedKotDescription(description);
    if (normalized.length === 0) {
        return false;
    }

    const rawPatterns = [
        /\bI create\b/i,
        /\bI check\b/i,
        /\bI fill\b/i,
        /\bI connect\b/i,
        /\bGenerate report\b/i,
        /\bList became equal:/i,
        /\bList contains lines:/i,
        /\b(?:PaymentDetails|PaymentDetailsOtherSettlements)\s+became equal/i,
        /\bReportSpreadsheetDocument template\b/i,
        /\b(?:Creating a|Receiving the|Checking the|Transferred from)\b/i
    ];

    const hits = rawPatterns.filter(pattern => pattern.test(normalized)).length;
    const slashRowHits = (normalized.match(/\b\d+\s*\/\s*[^/\n]{2,}\s*\/\s*[^/\n]{2,}/g) || []).length;
    return hits >= 2 || slashRowHits >= 2;
}

function extractScenarioImprovementSection(description: string, outputLanguage: AiOutputLanguage): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    const match = normalizeGeneratedKotDescription(description).match(
        new RegExp(`\\(?${escapeRegexLiteral(format.improvementLabel)}:[\\s\\S]*$`, 'i')
    );
    return match?.[0]?.trim() || '';
}

function ensureScenarioImprovementSection(
    description: string,
    fallbackDescription: string,
    outputLanguage: AiOutputLanguage
): string {
    const currentImprovement = extractScenarioImprovementSection(description, outputLanguage);
    if (currentImprovement.length > 0) {
        return description;
    }

    const fallbackImprovement = extractScenarioImprovementSection(fallbackDescription, outputLanguage);
    if (fallbackImprovement.length === 0) {
        return description;
    }

    return `${description.trim()}\n\n${fallbackImprovement}`;
}

async function generateScenarioDescriptionIteratively(
    context: ScenarioAnalysisContext,
    endpoint: string,
    settings: ScenarioAiSettings
): Promise<string> {
    if (isScenarioParameterizedUtilityScenario(context)) {
        return enforceStandaloneMainScenarioConstraints(
            buildDeterministicParameterizedUtilityScenarioDescription(context, settings.outputLanguage),
            settings.outputLanguage,
            context.isStandaloneMainScenario
        );
    }

    let chunkSummaries = buildDeterministicScenarioChunkSummaries(context.scenarioBody);
    if (chunkSummaries.length < 2 || chunkSummaries.every(isScenarioChunkSummaryEmpty)) {
        const chunks = buildScenarioBodyChunks(context.scenarioBody, 4200, 12);
        if (chunks.length < 2) {
            return '';
        }

        chunkSummaries = [];
        for (const chunk of chunks) {
            chunkSummaries.push(await requestScenarioChunkSummaryFromAi(
                endpoint,
                settings,
                context,
                chunk
            ));
        }

        if (chunkSummaries.every(isScenarioChunkSummaryEmpty)) {
            return '';
        }
    }

    const deterministicFallback = enforceStandaloneMainScenarioConstraints(
        buildDeterministicScenarioDescriptionFromChunks(
            context,
            chunkSummaries,
            settings.outputLanguage
        ),
        settings.outputLanguage,
        context.isStandaloneMainScenario
    );
    const synthesizedDescription = await requestScenarioDescriptionFromAi(
        endpoint,
        settings,
        buildScenarioSynthesisPromptFromChunks(context, chunkSummaries, settings.outputLanguage)
    );
    if (synthesizedDescription.length === 0) {
        return '';
    }

    const validatedDescription = await requestScenarioDescriptionFromAi(
        endpoint,
        settings,
        buildScenarioValidationPromptFromChunks(
            synthesizedDescription,
            context,
            chunkSummaries,
            settings.outputLanguage
        )
    );

    const candidateDescriptions = [
        validatedDescription,
        synthesizedDescription
    ]
        .filter(value => value.length > 0)
        .map(value => enforceStandaloneMainScenarioConstraints(
            value,
            settings.outputLanguage,
            context.isStandaloneMainScenario
        ))
        .map(value => ensureScenarioImprovementSection(
            value,
            deterministicFallback,
            settings.outputLanguage
        ));

    for (const candidateDescription of candidateDescriptions) {
        if (hasRawScenarioLogStyleLeak(candidateDescription)) {
            continue;
        }
        const missingCoverageGroups = findMissingScenarioCoverageGroups(candidateDescription, chunkSummaries);
        if (isScenarioCoverageAcceptable(missingCoverageGroups, chunkSummaries)) {
            return candidateDescription;
        }
    }

    return deterministicFallback;
}

function buildCompactedScenarioBody(bodyText: string, maxChars: number): string {
    const lines = normalizeScenarioBodyLines(bodyText);
    if (lines.length === 0) {
        return '';
    }

    const fullText = lines.join('\n');
    if (fullText.length <= maxChars) {
        return fullText;
    }

    const headLines = lines.slice(0, 18);
    const tailLines = lines.slice(-10);
    const priorityLines = lines.filter(line =>
        /\[[A-Za-zА-Яа-яЁё0-9_-]+\]/.test(line)
        || /^\s*(If|Else|Then|When|Given|And|Но|Если|Иначе|Тогда|Когда|Допустим|И|Попытка|Исключение)\b/i.test(line)
    );

    const selected: string[] = [];
    const seen = new Set<string>();
    const tryAddLine = (line: string): void => {
        const normalizedLine = line.trim();
        if (!normalizedLine || seen.has(normalizedLine)) {
            return;
        }
        seen.add(normalizedLine);
        selected.push(line);
    };

    headLines.forEach(tryAddLine);
    priorityLines.forEach(tryAddLine);
    tailLines.forEach(tryAddLine);

    const compacted: string[] = [];
    let currentLength = 0;
    for (const line of selected) {
        const nextLength = currentLength === 0 ? line.length : currentLength + 1 + line.length;
        if (nextLength > maxChars) {
            break;
        }
        compacted.push(line);
        currentLength = nextLength;
    }

    if (compacted.length === 0) {
        return fullText.slice(0, Math.max(0, maxChars - 20)).trimEnd();
    }

    if (compacted.length < selected.length || compacted.join('\n').length < fullText.length) {
        compacted.push('... [context trimmed for model limit] ...');
    }

    return compacted.join('\n');
}

function buildScenarioAnalysisPrompt(
    documentText: string,
    documentUri: vscode.Uri,
    outputLanguage: AiOutputLanguage,
    options: ScenarioPromptBuildOptions
): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    const phaseSwitcherMetadata = parsePhaseSwitcherMetadata(documentText);
    const scenarioHeaderSummary = extractScenarioHeaderSummary(documentText);
    const scenarioBody = buildCompactedScenarioBody(
        extractTopLevelSection(documentText, 'ТекстСценария'),
        options.scenarioBodyCharLimit
    );
    const structureHints = extractScenarioStructureHints(
        extractTopLevelSection(documentText, 'ТекстСценария'),
        10
    );
    const reportHints = extractScenarioReportHints(
        extractTopLevelSection(documentText, 'ТекстСценария'),
        10
    );
    const hasDeclaredOrUsedParameters = declaredParameters.size > 0 || usedPlaceholderLines.length > 0;
    const isStandaloneMainScenario = phaseSwitcherMetadata.hasTab;
    const isParameterizedScenario = !isStandaloneMainScenario && hasDeclaredOrUsedParameters;

    return [
        'Проанализируй текущий YAML-сценарий KOT для 1С и составь описание для блока KOTМетаданные.Описание.',
        'Важно про тип сценария:',
        `- StandaloneMainScenario: ${isStandaloneMainScenario ? 'yes' : 'no'}`,
        ...(isStandaloneMainScenario ? [
            '- Это служебный признак классификации сценария.',
            '- Не упоминай в итоговом пользовательском тексте технические метаданные вроде PhaseSwitcher.Tab или StandaloneMainScenario.',
            '- Даже если внутри есть параметры или placeholder-ы, не считай его универсальным сценарием.',
            '- Не предлагай делать параметры более универсальными, переиспользуемыми или абстрактными.'
        ] : []),
        'Важно про параметры сценария:',
        '- Конструкции вида [ИмяПараметра] в тексте шагов, заголовках окон, именах отчетов, полях и сообщениях являются параметрами сценария, а не буквальным текстом.',
        '- Если внутри названия окна или отчета есть [Параметр], не считай квадратные скобки частью реального названия. Нужно описывать сам объект проверки и отдельно учитывать, что его вариант зависит от параметра.',
        'Фокус:',
        '1. Что в тесте проверяется, какие правила или ожидания он подтверждает.',
        '1.1. В секции проверки обязательно назови конкретный объект проверки: отчет, документ, форму, обработку, бизнес-операцию или иной конкретный артефакт из сценария. Не пиши абстрактно "тест проверяет настройки/параметры".',
        '2. Какой бизнес-процесс проходит пользователь и что происходит по основным шагам сценария.',
        '3. Какие есть параметры, входные данные, условия, альтернативные ветки, циклы, проверки и переходы.',
        '4. Какие есть спорные места и что можно улучшить в тесте.',
        `5. Итоговое описание верни на ${format.languageInstructionLabel} языке.`,
        '',
        'Верни ответ в 3 обязательных секциях и, только если есть конкретное полезное замечание по сценарию, добавь 4-ю секцию:',
        `${format.checkedLabel}: <2-3 достаточно подробных предложения о сути проверки, ожиданиях, бизнес-смысле теста и конкретном объекте проверки>`,
        `${format.processLabel}: <3-5 предложений о ходе сценария: подготовка, действия пользователя/системы, ключевые этапы и итог>`,
        `${format.parametersLabel}: <2-4 предложения о параметрах, данных, ветках, условиях, проверках и возможных развилках; если их нет, напиши "${format.missingValue}">`,
        `(${format.improvementLabel}: <1-2 содержательных предложения, только если замечание конкретное и привязано к сценарию>)`,
        '',
        'Правила:',
        '- Не добавляй никаких других секций.',
        '- Внутри секции используй короткие пункты с префиксом "- ", а не длинные абзацы.',
        '- Не используй markdown-заголовки, нумерованные списки и code fence.',
        '- Не пиши "Описание:".',
        '- Не выдумывай факты, которых нет в сценарии.',
        '- Не делай текст чрезмерно кратким; лучше чуть подробнее, но по фактам.',
        '- Если сценарий длинный, обязательно охвати его от начала до конца, включая поздние проверки и завершающие блоки.',
        '- Не превращай описание в список открытых окон и нажатых кнопок. Описывай бизнес-действия и проверяемые результаты.',
        '- Если в сценарии есть проверки отчетов, spreadsheet templates, drill-down или print forms, обязательно отрази это в секции проверки.',
        '- Отражай не только happy path, но и условия, проверки и переходы, если они есть в сценарии.',
        '- Если улучшение получается только общим и расплывчатым, не пиши секцию улучшения вообще.',
        '- Каждая секция должна начинаться с новой строки в формате "Метка:", а дальше идти короткими пунктами с "- ".',
        '- Нельзя склеивать Проверяется, Процесс и Параметры и развилки в один абзац.',
        '- Если подряд идут однотипные проверки для разных документов, сгруппируй их в один обобщенный пункт, а не перечисляй копипастой.',
        '- В блоке "Параметры и развилки" отдельно поднимай If / ElseIf / Else как логические ветки. Не теряй их среди статических реквизитов.',
        '- Не ссылайся на номера блоков, чанков или фрагментов. Пересказывай сценарий человеческим языком.',
        '- Не подменяй точные названия документов, операций, отчетов и шаблонов более общими словами.',
        '- Не переинтерпретируй суммы, проценты и даты. Если сумма сначала автозаполняется одной величиной, а потом меняется вручную, это нужно описывать как последовательность.',
        '- Если в сценарии есть закомментированные шаги или Delay, можно добавить конкретный совет в секции улучшения.',
        '- В обычных фразах не оставляй рунглиш: английский допустим только для реальных имен документов, отчетов, операций, шаблонов и прочих сущностей.',
        '- Нельзя вставлять сырые Gherkin-строки и команды вроде "I create ...", "I check ...", "List became equal:", "PaymentDetails became equal", "Generate report".',
        '- В секции "Процесс" допускаются под-пункты "  - " для ключевых дат, сумм и параметров, если так текст читается лучше.',
        '',
        'Крупные смысловые маркеры сценария:',
        ...(structureHints.length > 0 ? structureHints.map(value => `- ${value}`) : ['- явные маркеры сценария не выделены']),
        '',
        'Отчеты и шаблоны, встречающиеся в сценарии:',
        ...(reportHints.length > 0 ? reportHints.map(value => `- ${value}`) : ['- явные отчеты и шаблоны не выделены']),
        '',
        'Краткое резюме заголовка сценария:',
        ...(scenarioHeaderSummary.length > 0 ? scenarioHeaderSummary : ['- ключевые поля заголовка не выделены']),
        '',
        `Путь файла: ${documentUri.fsPath}`,
        '',
        'ТекстСценария (сжатый контекст для модели):',
        '```gherkin',
        scenarioBody || '[пустой текст сценария]',
        '```'
    ].join('\n');
}

function isContextLengthError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('context length')
        || message.includes('maximum context length')
        || message.includes('prompt is too long')
        || message.includes('number of tokens to keep')
        || message.includes('input is too long');
}

function buildRetryPrompt(basePrompt: string, outputLanguage: AiOutputLanguage): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    return [
        basePrompt,
        '',
        'Важно: предыдущий ответ оказался пустым или не соответствовал формату.',
        'Повтори ответ и верни только итоговое описание.',
        'Нельзя оставлять ответ пустым.',
        'Если в сценарии мало деталей, все равно заполни все 4 секции по имеющимся фактам без выдумывания.',
        'Каждая секция должна начинаться с новой строки.',
        'Внутри каждой секции используй короткие пункты с префиксом "- ".',
        'Не ссылайся на номера блоков и не склеивай разные суммы или даты в один усредненный факт.',
        `Строгий формат: "${format.checkedLabel}:" и далее пункты с "- "; затем "${format.processLabel}:" с пунктами; затем "${format.parametersLabel}:" с пунктами; при необходимости "${format.improvementLabel}:" с пунктами.`
    ].join('\n');
}

async function requestScenarioDescriptionFromAi(
    endpoint: string,
    settings: ScenarioAiSettings,
    prompt: string
): Promise<string> {
    const rawResponseText = await requestTextFromAi(endpoint, settings, settings.systemPrompt, prompt);
    const structuredResponse = tryNormalizeStructuredScenarioDescription(rawResponseText, settings.outputLanguage);
    if (structuredResponse.length > 0) {
        return structuredResponse;
    }

    return buildFallbackScenarioDescription(rawResponseText, settings.outputLanguage);
}

async function generateScenarioDescription(document: vscode.TextDocument): Promise<string> {
    const settings = getScenarioAiSettings(document.uri);
    ensureAiConnectionSettingsComplete(settings);
    const endpoint = buildAiEndpoint(settings.baseUrl, settings.apiFormat, settings.apiVersion || undefined);
    const documentText = document.getText();
    const analysisContext = buildScenarioAnalysisContext(documentText, document.uri);

    try {
        const iterativeAttempt = await generateScenarioDescriptionIteratively(
            analysisContext,
            endpoint,
            settings
        );
        if (iterativeAttempt.length > 0) {
            return iterativeAttempt;
        }
    } catch (error) {
        console.warn('[scenarioAiDescription] Iterative description generation failed, falling back to direct prompt:', error);
    }

    const standardPrompt = buildScenarioAnalysisPrompt(documentText, document.uri, settings.outputLanguage, {
        scenarioBodyCharLimit: 6000,
        includeNestedScenarioNames: true,
        nestedScenarioLimit: 20
    });
    const compactPrompt = buildScenarioAnalysisPrompt(documentText, document.uri, settings.outputLanguage, {
        scenarioBodyCharLimit: 2500,
        includeNestedScenarioNames: false,
        nestedScenarioLimit: 0
    });

    const generateWithPrompt = async (prompt: string): Promise<string> => {
        const firstAttempt = await requestScenarioDescriptionFromAi(endpoint, settings, prompt);
        if (firstAttempt.length > 0) {
            return firstAttempt;
        }

        return requestScenarioDescriptionFromAi(
            endpoint,
            settings,
            buildRetryPrompt(prompt, settings.outputLanguage)
        );
    };

    try {
        const standardAttempt = await generateWithPrompt(standardPrompt);
        if (standardAttempt.length > 0) {
            return enforceStandaloneMainScenarioConstraints(
                standardAttempt,
                settings.outputLanguage,
                analysisContext.isStandaloneMainScenario
            );
        }
    } catch (error) {
        if (!isContextLengthError(error)) {
            throw error;
        }
    }

    const compactAttempt = await generateWithPrompt(compactPrompt);
    if (compactAttempt.length === 0) {
        throw new Error(vscode.l10n.t('LLM returned an empty description.'));
    }

    return enforceStandaloneMainScenarioConstraints(
        compactAttempt,
        settings.outputLanguage,
        analysisContext.isStandaloneMainScenario
    );
}

function buildFullDocumentRange(document: vscode.TextDocument): vscode.Range {
    const lastLine = document.lineAt(document.lineCount - 1);
    return new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length);
}

export async function handleGenerateScenarioDescriptionWithAi(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || !isScenarioYamlFile(editor.document)) {
        vscode.window.showInformationMessage(vscode.l10n.t('Open a scenario YAML file to generate an AI description.'));
        return;
    }

    const document = editor.document;
    const initialVersion = document.version;
    const openSettings = vscode.l10n.t('Open settings');

    try {
        const generatedDescription = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Generating scenario description with AI...'),
            cancellable: false
        }, () => generateScenarioDescription(document));

        const currentDocument = vscode.workspace.textDocuments.find(
            textDocument => textDocument.uri.toString() === document.uri.toString()
        ) ?? await vscode.workspace.openTextDocument(document.uri);

        if (currentDocument.version !== initialVersion) {
            vscode.window.showWarningMessage(vscode.l10n.t(
                'The scenario file changed while AI description was being generated. Nothing was applied.'
            ));
            return;
        }

        const ensuredMetadata = migrateLegacyPhaseSwitcherMetadata(currentDocument.getText(), {
            migrateLegacyPhaseSwitcherTags: false
        });
        const updatedText = upsertKotScenarioDescription(
            ensuredMetadata.content,
            generatedDescription,
            getScenarioAiSettings(currentDocument.uri).maxLineLength
        );

        if (updatedText === currentDocument.getText()) {
            vscode.window.showInformationMessage(vscode.l10n.t('AI description is already up to date.'));
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(currentDocument.uri, buildFullDocumentRange(currentDocument), updatedText);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            throw new Error(vscode.l10n.t('Failed to write AI-generated description into the document.'));
        }

        vscode.window.showInformationMessage(vscode.l10n.t('Scenario description was generated with AI.'));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const selection = await vscode.window.showErrorMessage(
            vscode.l10n.t('Failed to generate scenario description with AI: {0}', message),
            openSettings
        );
        if (selection === openSettings) {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.ai');
        }
    }
}
