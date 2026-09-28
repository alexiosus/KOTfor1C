export type ScenarioLanguage = 'en' | 'ru';

export interface GherkinDefinitionKeywords {
    readonly feature: readonly string[];
    readonly scenario: readonly string[];
    readonly outline: readonly string[];
    readonly background: readonly string[];
    readonly examples: readonly string[];
    readonly steps: readonly string[];
}

const DEFINITION_KEYWORDS: Record<ScenarioLanguage, GherkinDefinitionKeywords> = {
    en: {
        feature: ['Feature'],
        scenario: ['Scenario'],
        outline: ['Scenario Outline', 'Scenario Template'],
        background: ['Background'],
        examples: ['Examples', 'Scenarios'],
        steps: ['Given', 'When', 'Then', 'And', 'But', 'If']
    },
    ru: {
        feature: ['Функциональность', 'Функционал', 'Функция'],
        scenario: ['Сценарий'],
        outline: ['Структура сценария', 'Шаблон сценария'],
        background: ['Предыстория', 'Контекст'],
        examples: ['Примеры', 'Сценарии'],
        steps: ['Допустим', 'Дано', 'Когда', 'Тогда', 'И', 'Но', 'Если', 'К тому же']
    }
};

export function getGherkinDefinitionKeywords(language: ScenarioLanguage): GherkinDefinitionKeywords {
    return DEFINITION_KEYWORDS[language];
}
