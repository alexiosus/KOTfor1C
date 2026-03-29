import * as http from 'node:http';
import * as https from 'node:https';
import * as vscode from 'vscode';
import { normalizeGeneratedKotDescription, upsertKotScenarioDescription } from './kotMetadataDescription';
import { migrateLegacyPhaseSwitcherMetadata } from './phaseSwitcherMetadata';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';
import { isScenarioYamlFile } from './yamlValidator';

type AiApiFormat = 'responses' | 'chatCompletions';

interface ScenarioAiSettings {
    apiFormat: AiApiFormat;
    baseUrl: string;
    apiKey: string;
    model: string;
    outputLanguage: 'ru' | 'en';
    maxLineLength: number;
    timeoutMs: number;
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

const DEFAULT_SYSTEM_PROMPT = [
    'Ты помогаешь документировать YAML/BDD тесты KOT для 1С.',
    'Нужно вернуть только готовый текст для блока KOTМетаданные.Описание.',
    'Опиши, что именно проверяет тест, какой бизнес-процесс проходит, какие параметры и развилки в нем есть.',
    'Предпочитай содержательное, достаточно подробное описание вместо слишком короткого summary.',
    'Не выдумывай факты, которых нет в сценарии.',
    'Без markdown, без заголовков, без списков, без code fence.',
    'Следуй формату ответа, который будет указан в пользовательском сообщении.'
].join('\n');

function getScenarioAiSettings(scopeUri: vscode.Uri): ScenarioAiSettings {
    const config = vscode.workspace.getConfiguration('kotTestToolkit.ai', scopeUri);
    const timeoutSeconds = Math.max(5, config.get<number>('timeoutSeconds', 120));
    const apiFormat = config.get<AiApiFormat>('apiFormat', 'chatCompletions');
    const systemPrompt = config.get<string>('systemPrompt', '').trim();

    return {
        apiFormat,
        baseUrl: config.get<string>('baseUrl', 'http://localhost:1234/v1').trim(),
        apiKey: config.get<string>('apiKey', '').trim(),
        model: config.get<string>('model', '').trim(),
        outputLanguage: config.get<'ru' | 'en'>('outputLanguage', 'ru'),
        maxLineLength: Math.max(40, config.get<number>('maxLineLength', 100)),
        timeoutMs: timeoutSeconds * 1000,
        systemPrompt: systemPrompt.length > 0 ? systemPrompt : DEFAULT_SYSTEM_PROMPT
    };
}

function buildEndpoint(baseUrl: string, apiFormat: AiApiFormat): string {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    return apiFormat === 'chatCompletions'
        ? `${normalizedBaseUrl}/chat/completions`
        : `${normalizedBaseUrl}/responses`;
}

function getDescriptionOutputFormat(outputLanguage: 'ru' | 'en'): DescriptionOutputFormat {
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
        .replace(/^\(+/, '')
        .replace(/\)+$/, '')
        .trim();
}

function trimTrailingSentence(value: string): string {
    return value.replace(/[.\s]+$/g, '').trim();
}

function normalizeImprovementValue(rawValue: string, outputLanguage: 'ru' | 'en'): string {
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
    outputLanguage: 'ru' | 'en'
): string {
    const format = getDescriptionOutputFormat(outputLanguage);

    const lines = [
        `${format.checkedLabel}: ${sections.checked || format.missingValue}`,
        '',
        `${format.processLabel}: ${sections.process || format.missingValue}`,
        '',
        `${format.parametersLabel}: ${sections.parameters || format.missingValue}`
    ];

    const normalizedImprovement = normalizeImprovementValue(sections.improvement, outputLanguage);
    if (normalizedImprovement.length > 0) {
        lines.push('');
        lines.push(`(${format.improvementLabel}: ${normalizedImprovement})`);
    }

    return lines.join('\n');
}

function tryNormalizeStructuredScenarioDescription(rawValue: string, outputLanguage: 'ru' | 'en'): string {
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

    const checked = sanitizeStructuredValue(sectionLines.checked.join(' '));
    const process = sanitizeStructuredValue(sectionLines.process.join(' '));
    const parameters = sanitizeStructuredValue(sectionLines.parameters.join(' '));
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

function buildFallbackScenarioDescription(rawValue: string, outputLanguage: 'ru' | 'en'): string {
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

function normalizeScenarioBodyLines(bodyText: string): string[] {
    return bodyText
        .split(/\r\n|\r|\n/)
        .map(line => line.replace(/\t/g, '    ').trimEnd())
        .filter(line => line.trim().length > 0)
        .map(line => line.length > 180 ? `${line.slice(0, 177)}...` : line);
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
    outputLanguage: 'ru' | 'en',
    options: ScenarioPromptBuildOptions
): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    const declaredParameters = parseScenarioParameterDefaults(documentText);
    const scenarioHeaderSummary = extractScenarioHeaderSummary(documentText);
    const nestedScenarioNames = options.includeNestedScenarioNames
        ? extractNestedScenarioNames(documentText, options.nestedScenarioLimit)
        : [];
    const scenarioBody = buildCompactedScenarioBody(
        extractTopLevelSection(documentText, 'ТекстСценария'),
        options.scenarioBodyCharLimit
    );
    const placeholderNames = new Set<string>();
    const placeholderRegex = /\[([A-Za-zА-Яа-яЁё0-9_-]+)\]/g;
    let placeholderMatch: RegExpExecArray | null;
    while ((placeholderMatch = placeholderRegex.exec(documentText)) !== null) {
        if (placeholderMatch[1]) {
            placeholderNames.add(placeholderMatch[1]);
        }
    }

    const parameterLines = declaredParameters.size > 0
        ? Array.from(declaredParameters.entries()).map(([name, value]) => `- ${name} = ${value}`)
        : [];
    const usedPlaceholderLines = placeholderNames.size > 0
        ? Array.from(placeholderNames.values()).map(name => {
            const declaredValue = declaredParameters.get(name);
            return declaredValue
                ? `- [${name}] -> параметр сценария, объявлен в ПараметрыСценария, значение по умолчанию ${declaredValue}`
                : `- [${name}] -> используется как параметр/placeholder в тексте сценария`
        })
        : [];
    const isParameterizedScenario = declaredParameters.size > 0 || placeholderNames.size > 0;

    return [
        'Проанализируй текущий YAML-сценарий KOT для 1С и составь описание для блока KOTМетаданные.Описание.',
        'Важно про параметры сценария:',
        '- Конструкции вида [ИмяПараметра] в тексте шагов, заголовках окон, именах отчетов, полях и сообщениях являются параметрами сценария, а не буквальным текстом.',
        '- Такие конструкции подставляются из блока ПараметрыСценария или из параметров вызова сценария.',
        '- Если внутри названия окна или отчета есть [Параметр], не считай квадратные скобки частью реального названия. Нужно описывать сам объект проверки и отдельно учитывать, что его вариант зависит от параметра.',
        ...(isParameterizedScenario ? [
            '- Этот сценарий выглядит параметризованным/универсальным.',
            '- Для такого сценария не предлагай в улучшениях отдельные ветки "нет данных", "ошибка ввода" или иные варианты, которые могут быть реализованы в вызывающих сценариях через параметры.',
            '- Не предлагай "дополнить разъяснением бизнес-логики": описание, которое ты генерируешь, уже и есть разъяснение.'
        ] : []),
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
        '- Внутри секции можно использовать несколько предложений.',
        '- Не используй markdown, списки, заголовки и code fence.',
        '- Не пиши "Описание:".',
        '- Не выдумывай факты, которых нет в сценарии.',
        '- Не делай текст чрезмерно кратким; лучше чуть подробнее, но по фактам.',
        '- Отражай не только happy path, но и условия, проверки и переходы, если они есть в сценарии.',
        '- Если улучшение получается только общим и расплывчатым, не пиши секцию улучшения вообще.',
        '',
        'Краткое резюме заголовка сценария:',
        ...(scenarioHeaderSummary.length > 0 ? scenarioHeaderSummary : ['- ключевые поля заголовка не выделены']),
        '',
        'Объявленные параметры сценария:',
        ...(parameterLines.length > 0 ? parameterLines : ['- параметры в блоке ПараметрыСценария не обнаружены']),
        '',
        'Используемые placeholder-параметры в тексте сценария:',
        ...(usedPlaceholderLines.length > 0 ? usedPlaceholderLines : ['- placeholder-параметры вида [Param] в тексте не обнаружены']),
        '',
        ...(options.includeNestedScenarioNames ? [
            'Используемые вложенные сценарии:',
            ...(nestedScenarioNames.length > 0 ? nestedScenarioNames.map(name => `- ${name}`) : ['- вложенные сценарии не обнаружены']),
            ''
        ] : []),
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

function extractErrorMessage(responseBody: unknown, fallbackMessage: string): string {
    if (typeof responseBody !== 'object' || responseBody === null) {
        return fallbackMessage;
    }

    const errorRecord = (responseBody as Record<string, unknown>).error;
    if (typeof errorRecord !== 'object' || errorRecord === null) {
        return fallbackMessage;
    }

    const message = (errorRecord as Record<string, unknown>).message;
    return typeof message === 'string' && message.trim().length > 0
        ? message.trim()
        : fallbackMessage;
}

function extractResponseText(responseBody: unknown, apiFormat: AiApiFormat): string {
    if (typeof responseBody !== 'object' || responseBody === null) {
        return '';
    }

    const payload = responseBody as Record<string, unknown>;
    if (apiFormat === 'responses') {
        if (typeof payload.output_text === 'string' && payload.output_text.trim().length > 0) {
            return payload.output_text;
        }

        const outputItems = Array.isArray(payload.output) ? payload.output : [];
        const textParts: string[] = [];
        for (const item of outputItems) {
            if (typeof item !== 'object' || item === null) {
                continue;
            }

            const contentParts = Array.isArray((item as Record<string, unknown>).content)
                ? (item as Record<string, unknown>).content as unknown[]
                : [];

            for (const contentPart of contentParts) {
                if (typeof contentPart !== 'object' || contentPart === null) {
                    continue;
                }

                const typedPart = contentPart as Record<string, unknown>;
                if (
                    (typedPart.type === 'output_text' || typedPart.type === 'text') &&
                    typeof typedPart.text === 'string'
                ) {
                    textParts.push(typedPart.text);
                }
            }
        }

        return textParts.join('\n').trim();
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    if (typeof choice !== 'object' || choice === null) {
        return '';
    }

    const message = (choice as Record<string, unknown>).message;
    if (typeof message !== 'object' || message === null) {
        return '';
    }

    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .map(part => {
            if (typeof part === 'string') {
                return part;
            }
            if (typeof part !== 'object' || part === null) {
                return '';
            }
            const typedPart = part as Record<string, unknown>;
            return typeof typedPart.text === 'string' ? typedPart.text : '';
        })
        .join('\n')
        .trim();
}

function buildRetryPrompt(basePrompt: string, outputLanguage: 'ru' | 'en'): string {
    const format = getDescriptionOutputFormat(outputLanguage);
    return [
        basePrompt,
        '',
        'Важно: предыдущий ответ оказался пустым или не соответствовал формату.',
        'Повтори ответ и верни только итоговое описание.',
        'Нельзя оставлять ответ пустым.',
        'Если в сценарии мало деталей, все равно заполни все 4 секции по имеющимся фактам без выдумывания.',
        `Строгий формат: ${format.checkedLabel}: ..., ${format.processLabel}: ..., ${format.parametersLabel}: ..., (${format.improvementLabel}: ...)`
    ].join('\n');
}

async function requestScenarioDescriptionFromAi(
    endpoint: string,
    settings: ScenarioAiSettings,
    prompt: string
): Promise<string> {
    const payload = settings.apiFormat === 'chatCompletions'
        ? {
            model: settings.model,
            messages: [
                {
                    role: 'system',
                    content: settings.systemPrompt
                },
                {
                    role: 'user',
                    content: prompt
                }
            ]
        }
        : {
            model: settings.model,
            instructions: settings.systemPrompt,
            input: prompt
        };

    const responseBody = await postJson<unknown>(endpoint, settings.apiKey, payload, settings.timeoutMs);
    const rawResponseText = extractResponseText(responseBody, settings.apiFormat);
    const structuredResponse = tryNormalizeStructuredScenarioDescription(rawResponseText, settings.outputLanguage);
    if (structuredResponse.length > 0) {
        return structuredResponse;
    }

    return buildFallbackScenarioDescription(rawResponseText, settings.outputLanguage);
}

function postJson<TResponse>(
    urlString: string,
    apiKey: string,
    payload: unknown,
    timeoutMs: number
): Promise<TResponse> {
    return new Promise((resolve, reject) => {
        let url: URL;
        try {
            url = new URL(urlString);
        } catch {
            reject(new Error(vscode.l10n.t('Invalid AI base URL: {0}', urlString)));
            return;
        }

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            reject(new Error(vscode.l10n.t('AI base URL must use http or https: {0}', urlString)));
            return;
        }

        const requestBody = JSON.stringify(payload);
        const requestImpl = url.protocol === 'https:' ? https.request : http.request;

        const request = requestImpl({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port.length > 0 ? Number(url.port) : undefined,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestBody),
                'Content-Type': 'application/json',
                'User-Agent': 'KOTTestToolkit'
            }
        }, response => {
            const chunks: Buffer[] = [];

            response.on('data', chunk => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            response.on('end', () => {
                const responseText = Buffer.concat(chunks).toString('utf8');
                let parsedBody: unknown = null;

                if (responseText.trim().length > 0) {
                    try {
                        parsedBody = JSON.parse(responseText);
                    } catch {
                        parsedBody = responseText;
                    }
                }

                const statusCode = response.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    reject(new Error(vscode.l10n.t(
                        'AI request failed with status {0}: {1}',
                        String(statusCode),
                        extractErrorMessage(parsedBody, responseText || vscode.l10n.t('Empty response body'))
                    )));
                    return;
                }

                resolve(parsedBody as TResponse);
            });
        });

        request.on('error', error => {
            reject(error);
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(vscode.l10n.t('AI request timed out after {0} seconds.', String(Math.round(timeoutMs / 1000)))));
        });

        request.write(requestBody);
        request.end();
    });
}

async function generateScenarioDescription(document: vscode.TextDocument): Promise<string> {
    const settings = getScenarioAiSettings(document.uri);
    const missingSettings: string[] = [];

    if (settings.baseUrl.length === 0) {
        missingSettings.push('baseUrl');
    }
    if (settings.apiKey.length === 0) {
        missingSettings.push('apiKey');
    }
    if (settings.model.length === 0) {
        missingSettings.push('model');
    }

    if (missingSettings.length > 0) {
        throw new Error(vscode.l10n.t(
            'AI settings are incomplete. Fill in: {0}.',
            missingSettings.join(', ')
        ));
    }

    const endpoint = buildEndpoint(settings.baseUrl, settings.apiFormat);
    const documentText = document.getText();
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
            return standardAttempt;
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

    return compactAttempt;
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
