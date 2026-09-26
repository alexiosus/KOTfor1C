import type {
    ProjectDefinition,
    ProjectDefinitionKind,
    ProjectDefinitionLocation,
    ProjectDefinitionView
} from './projectDefinition';
import { buildProjectDefinitionSnippetData } from './projectDefinitionSnippet';

export type StepLibrarySourceGroup = 'builtIn' | 'user' | 'export' | 'nested';

export interface StepLibraryParameter {
    readonly name: string;
    readonly defaultValue?: string;
}

export interface StepLibraryItem {
    readonly id: string;
    readonly definitionId: string;
    readonly familyId: string;
    readonly kind: ProjectDefinitionKind;
    readonly sourceGroup: StepLibrarySourceGroup;
    readonly template: string;
    readonly displayText: string;
    readonly alternateDisplayText?: string;
    readonly language?: 'ru' | 'en';
    readonly description?: string;
    readonly categoryPath: readonly string[];
    readonly parameters: readonly StepLibraryParameter[];
    readonly sourceLabel: string;
    readonly navigable: boolean;
    readonly capturedLocation?: ProjectDefinitionLocation;
    readonly searchText: string;
}

export interface StepLibrarySnapshot {
    readonly viewIdentity: string;
    readonly items: readonly StepLibraryItem[];
    readonly counts: Readonly<Record<StepLibrarySourceGroup, number>>;
}

const SOURCE_ORDER: Readonly<Record<StepLibrarySourceGroup, number>> = Object.freeze({
    builtIn: 0,
    user: 1,
    export: 2,
    nested: 3
});

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sourceGroup(kind: ProjectDefinitionKind): StepLibrarySourceGroup {
    switch (kind) {
        case 'builtInStep': return 'builtIn';
        case 'userStep': return 'user';
        case 'exportScenario': return 'export';
        case 'nestedScenario': return 'nested';
    }
}

function preferredDisplayText(definition: ProjectDefinition): string {
    return definition.kind === 'exportScenario'
        ? definition.usageExample ?? definition.template
        : definition.template;
}

function displayText(definition: ProjectDefinition): string {
    return buildProjectDefinitionSnippetData(definition, {
        preferredText: preferredDisplayText(definition)
    }).displayText;
}

function categoryPath(definition: ProjectDefinition): readonly string[] {
    if (definition.kind === 'builtInStep') {
        return Object.freeze([...(definition.categoryPath ?? [])]);
    }
    return Object.freeze((definition.category ?? '')
        .split('.')
        .map(segment => segment.trim())
        .filter(Boolean));
}

function parameters(definition: ProjectDefinition): readonly StepLibraryParameter[] {
    return Object.freeze([...definition.parameters]
        .sort((left, right) => left.index - right.index)
        .map(parameter => Object.freeze({
            name: parameter.name,
            ...(parameter.defaultValue !== undefined
                ? { defaultValue: parameter.defaultValue }
                : {})
        })));
}

function cloneLocation(location: ProjectDefinitionLocation): ProjectDefinitionLocation {
    return Object.freeze({
        uri: location.uri,
        range: Object.freeze({
            start: Object.freeze({ ...location.range.start }),
            end: Object.freeze({ ...location.range.end })
        })
    });
}

function normalizeSearchText(values: readonly (string | undefined)[]): string {
    return values
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .normalize('NFC')
        .toLowerCase()
        .replace(/\s+/gu, ' ')
        .trim();
}

function presentationId(definition: ProjectDefinition): string {
    return `${definition.id}#${definition.language ?? 'authored'}`;
}

export function buildStepLibrarySnapshot(view: ProjectDefinitionView): StepLibrarySnapshot {
    const builtInsByFamily = new Map<string, ProjectDefinition[]>();
    for (const definition of view.all) {
        if (definition.kind !== 'builtInStep') {
            continue;
        }
        const familyId = definition.familyId ?? definition.id;
        const family = builtInsByFamily.get(familyId) ?? [];
        family.push(definition);
        builtInsByFamily.set(familyId, family);
    }

    const counts: Record<StepLibrarySourceGroup, number> = {
        builtIn: 0,
        user: 0,
        export: 0,
        nested: 0
    };
    const items = view.all.map(definition => {
        const group = sourceGroup(definition.kind);
        counts[group] += 1;
        const ownDisplayText = displayText(definition);
        const familyId = definition.familyId ?? definition.id;
        const alternate = definition.kind === 'builtInStep'
            ? builtInsByFamily.get(familyId)?.find(candidate =>
                candidate.id !== definition.id && candidate.language !== definition.language
            )
            : undefined;
        const alternateDisplayText = alternate ? displayText(alternate) : undefined;
        const definitionCategoryPath = categoryPath(definition);
        const definitionParameters = parameters(definition);
        const navigable = definition.kind !== 'builtInStep'
            && definition.definitionLocation !== undefined;
        const capturedLocation = navigable && definition.definitionLocation
            ? cloneLocation(definition.definitionLocation)
            : undefined;
        const searchText = normalizeSearchText([
            ownDisplayText,
            alternateDisplayText,
            definition.template,
            definition.description,
            ...definitionCategoryPath,
            definition.sourceLabel,
            ...definitionParameters.flatMap(parameter => [parameter.name, parameter.defaultValue])
        ]);
        return Object.freeze({
            id: presentationId(definition),
            definitionId: definition.id,
            familyId,
            kind: definition.kind,
            sourceGroup: group,
            template: definition.template,
            displayText: ownDisplayText,
            ...(alternateDisplayText ? { alternateDisplayText } : {}),
            ...(definition.language ? { language: definition.language } : {}),
            ...(definition.description ? { description: definition.description } : {}),
            categoryPath: definitionCategoryPath,
            parameters: definitionParameters,
            sourceLabel: definition.sourceLabel,
            navigable,
            ...(capturedLocation ? { capturedLocation } : {}),
            searchText
        });
    }).sort((left, right) =>
        SOURCE_ORDER[left.sourceGroup] - SOURCE_ORDER[right.sourceGroup]
        || compareText(left.displayText.toLowerCase(), right.displayText.toLowerCase())
        || compareText(left.id, right.id)
    );

    return Object.freeze({
        viewIdentity: view.identity,
        items: Object.freeze(items),
        counts: Object.freeze(counts)
    });
}
