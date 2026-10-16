import { getGherkinDefinitionKeywords, type ScenarioLanguage } from './gherkinDefinitionKeywords';
import { normalizeFeatureTags } from './featureTags';

export interface FeatureTemplateOptions {
    readonly language: ScenarioLanguage;
    readonly featureTitle: string;
    readonly scenarioTitle: string;
    readonly template?: string;
    readonly tags?: readonly string[];
}

const DEFAULT_FEATURE_TEMPLATES: Record<ScenarioLanguage, string> = {
    en: '\uFEFF#language: en\n\n@tree\n\nFunctionality: {{featureTitle}}\n\nAs <Role>\nI want <functional description>\nTo <business effect>\n\nBackground:\n\tGiven I launch TestClient opening script or connect the existing one\n\nScenario: {{scenarioTitle}}\n',
    ru: '\uFEFF#language: ru\n\n@tree\n\nФункционал: {{featureTitle}}\n\nКак <Роль> я хочу\n<описание функционала> \nчтобы <бизнес-эффект>   \n\nКонтекст:\n\tДано Я запускаю сценарий открытия TestClient или подключаю уже существующий\n\nСценарий: {{scenarioTitle}}\n'
};

const FEATURE_TITLE_PLACEHOLDERS = ['{{featureTitle}}', '<description features>', '<описание фичи>'];
const SCENARIO_TITLE_PLACEHOLDERS = ['{{scenarioTitle}}', '<description of the scenario>', '<описание сценария>'];
function declarationPattern(keywords: readonly string[]): RegExp {
    const alternatives = keywords.map(keyword => keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
    return new RegExp(`^\\s*(?:${alternatives})\\s*:\\s*(.+)$`, 'imu');
}

const enKeywords = getGherkinDefinitionKeywords('en');
const ruKeywords = getGherkinDefinitionKeywords('ru');
const FEATURE_DECLARATION = declarationPattern([...enKeywords.feature, ...ruKeywords.feature, 'Свойство']);
const SCENARIO_DECLARATION = declarationPattern([
    ...enKeywords.outline, ...enKeywords.scenario, ...ruKeywords.outline, ...ruKeywords.scenario
]);

export function validateFeatureTitle(title: string): string | undefined {
    if (!title.trim()) {
        return 'Title must not be empty.';
    }
    if (/[\u0000-\u001F\u007F\u2028\u2029]/u.test(title)) {
        return 'Title must fit on a single line without control characters.';
    }
    return undefined;
}

function validateTemplate(template: string): void {
    for (const placeholder of template.match(/\{\{[^{}]+\}\}/gu) ?? []) {
        if (![...FEATURE_TITLE_PLACEHOLDERS, ...SCENARIO_TITLE_PLACEHOLDERS, '{{language}}'].includes(placeholder)) {
            throw new Error(`Unsupported feature template placeholder: ${placeholder}.`);
        }
    }
    const featureDeclaration = template.match(FEATURE_DECLARATION)?.[1] ?? '';
    const scenarioDeclaration = template.match(SCENARIO_DECLARATION)?.[1] ?? '';
    if (!FEATURE_TITLE_PLACEHOLDERS.some(token => featureDeclaration.includes(token))
        || !SCENARIO_TITLE_PLACEHOLDERS.some(token => scenarioDeclaration.includes(token))) {
        throw new Error('Custom feature template must contain a feature title and scenario title placeholder in their title declarations.');
    }
}

export function renderFeatureTemplate(options: FeatureTemplateOptions): string {
    for (const title of [options.featureTitle, options.scenarioTitle]) {
        const error = validateFeatureTitle(title);
        if (error) {
            throw new Error(error);
        }
    }
    let template = options.template ?? DEFAULT_FEATURE_TEMPLATES[options.language];
    validateTemplate(template);
    const replacements = new Map<string, string>([
        ...FEATURE_TITLE_PLACEHOLDERS.map(token => [token, options.featureTitle.trim()] as const),
        ...SCENARIO_TITLE_PLACEHOLDERS.map(token => [token, options.scenarioTitle.trim()] as const),
        ['{{language}}', options.language]
    ]);
    const placeholderPattern = /\{\{(?:featureTitle|scenarioTitle|language)\}\}|<description features>|<description of the scenario>|<описание фичи>|<описание сценария>/gu;
    template = template.replace(placeholderPattern, token => replacements.get(token) ?? token);
    const tags = normalizeFeatureTags(options.tags ?? []);
    if (tags.length > 0) {
        const eol = template.includes('\r\n') ? '\r\n' : '\n';
        const bom = template.startsWith('\uFEFF') ? '\uFEFF' : '';
        const body = template.slice(bom.length);
        const prefix = body.slice(0, body.match(FEATURE_DECLARATION)?.index ?? 0);
        const existing = new Set(prefix.split(/\r?\n/u).filter(line => /^\s*@/u.test(line)).flatMap(line => line.match(/@[^\s@]+/gu) ?? []));
        const missing = tags.filter(tag => !existing.has(`@${tag}`));
        template = bom + body.replace(FEATURE_DECLARATION, declaration => `${missing.map(tag => `@${tag}`).join(eol)}${missing.length > 0 ? eol : ''}${declaration}`);
    }
    return template;
}
