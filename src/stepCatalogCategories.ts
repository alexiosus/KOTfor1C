import type { StaticBslStepRegistration } from './bslStepSourceParser';
import {
    normalizeProjectDefinitionTemplate,
    type ProjectDefinition,
    type ProjectDefinitionParameter
} from './projectDefinition';
import { compileProjectDefinitionMatcher } from './projectDefinitionMatcher';
import {
    normalizeStepCatalogText,
    type BuiltInStepDefinition,
    type StepCategoryPath
} from './stepCatalog';

export interface StepCategoryTranslationInput {
    readonly ru?: string;
    readonly en?: string;
}

export interface StepCategoryEnrichmentReport {
    readonly categorizedStepCount: number;
    readonly uncategorizedStepCount: number;
    readonly unmatchedRegistrationCount: number;
    readonly conflictingCategoryMappings: readonly string[];
    readonly untranslatableCategorySegments: readonly string[];
}

export interface StepCategoryEnrichmentInput {
    readonly steps: readonly BuiltInStepDefinition[];
    readonly categoryTranslations: readonly StepCategoryTranslationInput[];
    readonly registrations: readonly Pick<StaticBslStepRegistration, 'template' | 'category'>[];
}

export interface StepCategoryEnrichmentResult {
    readonly steps: readonly BuiltInStepDefinition[];
    readonly report: StepCategoryEnrichmentReport;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function splitCategoryPath(value: string | undefined): readonly string[] {
    if (!value) {
        return [];
    }
    return value
        .split('.')
        .map(segment => normalizeStepCatalogText(segment))
        .filter(Boolean);
}

function categoryKey(path: readonly string[]): string {
    return JSON.stringify(path);
}

function templateParameters(template: string): readonly ProjectDefinitionParameter[] {
    const invocationLine = template.split(/\r\n|\r|\n/u, 1)[0] ?? template;
    return Object.freeze(Array.from(
        invocationLine.matchAll(/(["'])\s*%\d+\s+([^"']*?)\s*\1/gu)
    ).map((match, index) => Object.freeze({
        name: match[2]?.trim() || `Parameter${index + 1}`,
        index,
        source: 'quoted' as const
    })));
}

function matcherDefinition(step: BuiltInStepDefinition): ProjectDefinition | null {
    if (!step.ru) {
        return null;
    }
    return Object.freeze({
        id: step.id,
        kind: 'builtInStep',
        template: step.ru.pattern,
        normalizedTemplate: normalizeProjectDefinitionTemplate(step.ru.pattern),
        language: 'ru',
        parameters: templateParameters(step.ru.pattern),
        description: step.ru.description || undefined,
        sourceLabel: 'Vanessa catalog'
    });
}

function buildRegistrationTemplateResolver(steps: readonly BuiltInStepDefinition[]): (
    template: string
) => string | null {
    const exact = new Set(steps.flatMap(step =>
        step.ru ? [normalizeStepCatalogText(step.ru.pattern)] : []
    ));
    const matchers = steps.flatMap(step => {
        const definition = matcherDefinition(step);
        return definition ? [{
            template: normalizeStepCatalogText(definition.template),
            matcher: compileProjectDefinitionMatcher(definition)
        }] : [];
    });
    return template => {
        const normalized = normalizeStepCatalogText(template);
        if (exact.has(normalized)) {
            return normalized;
        }
        const invocationLine = template.split(/\r\n|\r|\n/u, 1)[0] ?? template;
        const candidates = new Set(matchers.flatMap(item =>
            item.matcher.match(invocationLine) ? [item.template] : []
        ));
        return candidates.size === 1 ? [...candidates][0] : null;
    };
}

function buildTranslations(
    translations: readonly StepCategoryTranslationInput[]
): ReadonlyMap<string, ReadonlySet<string>> {
    const values = new Map<string, Set<string>>();
    for (const translation of translations) {
        const russian = splitCategoryPath(translation.ru);
        const english = splitCategoryPath(translation.en);
        for (let index = 0; index < russian.length; index++) {
            const englishSegment = english[index];
            if (!englishSegment) {
                continue;
            }
            const candidates = values.get(russian[index]) ?? new Set<string>();
            candidates.add(englishSegment);
            values.set(russian[index], candidates);
        }
    }
    return values;
}

function localizedCategoryPath(
    russian: readonly string[],
    translations: ReadonlyMap<string, ReadonlySet<string>>,
    untranslatable: Set<string>
): StepCategoryPath {
    const english: string[] = [];
    let fullyTranslated = true;
    for (const segment of russian) {
        const candidates = translations.get(segment);
        if (!candidates || candidates.size !== 1) {
            untranslatable.add(segment);
            fullyTranslated = false;
            continue;
        }
        english.push([...candidates][0]);
    }
    return {
        ru: Object.freeze([...russian]),
        ...(fullyTranslated ? { en: Object.freeze(english) } : {})
    };
}

export function enrichStepCatalogCategories(
    input: StepCategoryEnrichmentInput
): StepCategoryEnrichmentResult {
    const resolveRegistrationTemplate = buildRegistrationTemplateResolver(input.steps);
    const mappings = new Map<string, Map<string, readonly string[]>>();
    let unmatchedRegistrationCount = 0;

    for (const registration of input.registrations) {
        const path = splitCategoryPath(registration.category);
        if (path.length === 0) {
            continue;
        }
        const template = resolveRegistrationTemplate(registration.template);
        if (!template) {
            unmatchedRegistrationCount += 1;
            continue;
        }
        const categories = mappings.get(template) ?? new Map<string, readonly string[]>();
        categories.set(categoryKey(path), path);
        mappings.set(template, categories);
    }

    const conflicting = new Set<string>();
    const translations = buildTranslations(input.categoryTranslations);
    const untranslatable = new Set<string>();
    const steps = input.steps.map(step => {
        if (!step.ru) {
            return step;
        }
        const template = normalizeStepCatalogText(step.ru.pattern);
        const categories = mappings.get(template);
        if (!categories || categories.size === 0) {
            return step;
        }
        if (categories.size > 1) {
            conflicting.add(template);
            return Object.freeze({ ...step, categoryPath: undefined });
        }
        const russian = categories.values().next().value as readonly string[];
        return Object.freeze({
            ...step,
            categoryPath: localizedCategoryPath(russian, translations, untranslatable)
        });
    });
    const categorizedStepCount = steps.filter(step =>
        Boolean(step.categoryPath?.ru?.length || step.categoryPath?.en?.length)
    ).length;

    return Object.freeze({
        steps: Object.freeze(steps),
        report: Object.freeze({
            categorizedStepCount,
            uncategorizedStepCount: steps.length - categorizedStepCount,
            unmatchedRegistrationCount,
            conflictingCategoryMappings: Object.freeze([...conflicting].sort(compareText)),
            untranslatableCategorySegments: Object.freeze([...untranslatable].sort(compareText))
        })
    });
}
