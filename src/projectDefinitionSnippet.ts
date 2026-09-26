import type { ProjectDefinition } from './projectDefinition';

const STEP_TEMPLATE_PLACEHOLDER_REGEX = /%(\d+)\s+([^"'\r\n]+)/g;
const GHERKIN_KEYWORD_CAPTURE_REGEX = /^(?:\*\s*)?(and|but|then|when|given|if|и|тогда|когда|если|допустим|к тому же|но)\s+/i;

export interface ProjectDefinitionSnippetData {
    readonly displayText: string;
    readonly snippetText: string;
    readonly hasPlaceholders: boolean;
}

export interface ProjectDefinitionInsertionOptions {
    readonly preferredText?: string;
    readonly typedKeyword?: string;
    readonly fallbackKeyword: string;
    readonly indentation?: string;
    readonly language: 'ru' | 'en';
    readonly parameterDefaults?: Readonly<Record<string, string>>;
}

export function buildCallableDefinitionText(
    preferredText: string,
    typedKeyword: string,
    fallbackKeyword: string
): string {
    const normalizedText = preferredText.trim();
    const match = GHERKIN_KEYWORD_CAPTURE_REGEX.exec(normalizedText);
    const body = match ? normalizedText.slice(match[0].length) : normalizedText;
    const keyword = typedKeyword.trim() || match?.[1] || fallbackKeyword;
    return body ? `${keyword} ${body}` : keyword;
}

function escapeStepSnippetText(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\$/g, '\\$')
        .replace(/\}/g, '\\}');
}

function buildStepTemplateSnippetData(stepText: string): ProjectDefinitionSnippetData {
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

function escapeSnippetPlaceholderDefault(value: string): string {
    return escapeStepSnippetText(value);
}

export function buildProjectDefinitionSnippetData(
    definition: ProjectDefinition,
    options: Pick<ProjectDefinitionInsertionOptions, 'preferredText'> = {}
): ProjectDefinitionSnippetData {
    const preferredText = options.preferredText ?? definition.template;
    const catalogSnippet = buildStepTemplateSnippetData(preferredText);
    if (catalogSnippet.hasPlaceholders || definition.parameters.length === 0) {
        return catalogSnippet;
    }

    const replacements: Array<{ start: number; end: number; index: number; name: string }> = [];
    let quoteSearchStart = 0;
    for (const parameter of [...definition.parameters].sort((left, right) => left.index - right.index)) {
        if (parameter.source === 'outline') {
            const marker = `<${parameter.name}>`;
            const start = preferredText.indexOf(marker);
            if (start >= 0) {
                replacements.push({
                    start,
                    end: start + marker.length,
                    index: parameter.index + 1,
                    name: parameter.name
                });
            }
            continue;
        }

        let opening = -1;
        let closing = -1;
        for (let index = quoteSearchStart; index < preferredText.length; index++) {
            const quote = preferredText[index];
            if (quote !== '"' && quote !== "'") {
                continue;
            }
            const end = preferredText.indexOf(quote, index + 1);
            if (end >= 0) {
                opening = index;
                closing = end;
                quoteSearchStart = end + 1;
            }
            break;
        }
        if (opening >= 0 && closing > opening) {
            replacements.push({
                start: opening + 1,
                end: closing,
                index: parameter.index + 1,
                name: parameter.name
            });
        }
    }

    if (replacements.length === 0) {
        return catalogSnippet;
    }
    replacements.sort((left, right) => left.start - right.start);
    let snippetText = '';
    let cursor = 0;
    for (const replacement of replacements) {
        snippetText += escapeStepSnippetText(preferredText.slice(cursor, replacement.start));
        snippetText += `\${${replacement.index}:${escapeSnippetPlaceholderDefault(replacement.name)}}`;
        cursor = replacement.end;
    }
    snippetText += escapeStepSnippetText(preferredText.slice(cursor));
    return {
        displayText: preferredText,
        snippetText,
        hasPlaceholders: true
    };
}

export function buildProjectDefinitionInsertion(
    definition: ProjectDefinition,
    options: ProjectDefinitionInsertionOptions
): ProjectDefinitionSnippetData {
    const preferredText = options.preferredText
        ?? definition.usageExample
        ?? definition.template;
    const callableText = buildCallableDefinitionText(
        preferredText,
        options.typedKeyword ?? '',
        options.fallbackKeyword
    );
    if (definition.kind !== 'nestedScenario') {
        return buildProjectDefinitionSnippetData(definition, { preferredText: callableText });
    }

    if (definition.parameters.length === 0) {
        return buildProjectDefinitionSnippetData(definition, { preferredText: callableText });
    }

    const ordered = [...definition.parameters].sort((left, right) => left.index - right.index);
    const maxNameLength = ordered.reduce((maximum, parameter) =>
        Math.max(maximum, parameter.name.length), 0);
    let displayText = callableText;
    let snippetText = escapeStepSnippetText(callableText);
    ordered.forEach((parameter, index) => {
        const defaultValue = parameter.defaultValue
            ?? options.parameterDefaults?.[parameter.name]
            ?? `"${parameter.name}"`;
        const prefix = `\n    ${parameter.name.padEnd(maxNameLength, ' ')} = `;
        displayText += `${prefix}${defaultValue}`;
        snippetText += `${escapeStepSnippetText(prefix)}\${${index + 1}:${escapeSnippetPlaceholderDefault(defaultValue)}}`;
    });
    return {
        displayText,
        snippetText,
        hasPlaceholders: true
    };
}
