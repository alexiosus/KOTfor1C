import * as vscode from 'vscode';

export type ScenarioLanguage = 'en' | 'ru';
type CanonicalStepKeyword = 'and' | 'given' | 'when' | 'then' | 'but';

const CANONICAL_KEYWORDS_EN: Record<CanonicalStepKeyword, string> = {
    and: 'And',
    given: 'Given',
    when: 'When',
    then: 'Then',
    but: 'But'
};

const CANONICAL_KEYWORDS_RU: Record<CanonicalStepKeyword, string> = {
    and: 'И',
    given: 'Допустим',
    when: 'Когда',
    then: 'Тогда',
    but: 'Но'
};

const KEYWORD_TO_CANONICAL: Array<{ regex: RegExp; canonical: CanonicalStepKeyword }> = [
    { regex: /^(?:and|и|к тому же)$/i, canonical: 'and' },
    { regex: /^(?:given|допустим|дано)$/i, canonical: 'given' },
    { regex: /^(?:when|когда|если)$/i, canonical: 'when' },
    { regex: /^(?:then|тогда)$/i, canonical: 'then' },
    { regex: /^(?:but|но)$/i, canonical: 'but' }
];

const STEP_KEYWORD_REGEX = /^(\s*)(And|Then|When|Given|But|Но|Тогда|Когда|Если|И|К тому же|Допустим|Дано)\s+(.*)$/i;

function toConfiguredLanguage(value: string | undefined): ScenarioLanguage {
    return value === 'ru' ? 'ru' : 'en';
}

const LANGUAGE_TAG_REGEX = /^#language:\s*(en|ru)\b/i;

function toCanonicalStepKeyword(rawKeyword: string): CanonicalStepKeyword | null {
    for (const entry of KEYWORD_TO_CANONICAL) {
        if (entry.regex.test(rawKeyword.trim())) {
            return entry.canonical;
        }
    }
    return null;
}

export function getConfiguredScenarioLanguage(config?: vscode.WorkspaceConfiguration): ScenarioLanguage {
    const configuration = config ?? vscode.workspace.getConfiguration('kotTestToolkit');
    const configured = configuration.get<string>('editor.newScenarioLanguage', 'en');
    return toConfiguredLanguage(configured);
}

export function getScenarioLanguageFromDocumentTag(document: vscode.TextDocument): ScenarioLanguage | null {
    const linesToInspect = Math.min(document.lineCount, 5000);
    for (let i = 0; i < linesToInspect; i++) {
        const rawLine = document.lineAt(i).text;
        const trimmedLine = rawLine.replace(/^\uFEFF/, '').trim();
        if (!trimmedLine) {
            continue;
        }

        const match = trimmedLine.match(LANGUAGE_TAG_REGEX);
        if (match?.[1]) {
            return toConfiguredLanguage(match[1].toLowerCase());
        }
    }

    return null;
}

export function getScenarioLanguageForDocument(
    document: vscode.TextDocument,
    config?: vscode.WorkspaceConfiguration
): ScenarioLanguage {
    return getScenarioLanguageFromDocumentTag(document) ?? getConfiguredScenarioLanguage(config);
}

export function getScenarioCallKeyword(language: ScenarioLanguage): string {
    return language === 'ru' ? CANONICAL_KEYWORDS_RU.and : CANONICAL_KEYWORDS_EN.and;
}

export function applyPreferredStepKeyword(text: string, language: ScenarioLanguage): string {
    const match = text.match(STEP_KEYWORD_REGEX);
    if (!match) {
        return text;
    }

    const canonical = toCanonicalStepKeyword(match[2]);
    if (!canonical) {
        return text;
    }

    const preferredKeyword = language === 'ru'
        ? CANONICAL_KEYWORDS_RU[canonical]
        : CANONICAL_KEYWORDS_EN[canonical];

    return `${match[1]}${preferredKeyword} ${match[3]}`;
}
