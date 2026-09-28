import { createHash } from 'node:crypto';
import type {
    ProjectDefinition,
    ProjectDefinitionKind,
    ProjectDefinitionLocation,
    ProjectDefinitionView
} from './projectDefinition';
import { buildProjectDefinitionSnippetData } from './projectDefinitionSnippet';
import { alignGherkinTablesInText } from './gherkinTableUtils';
import type { TestInfo } from './types';

export type StepLibrarySourceGroup = 'builtIn' | 'user' | 'export' | 'nested' | 'main';
export type StepLibraryItemKind = ProjectDefinitionKind | 'mainScenario';

export interface StepLibraryParameter {
    readonly name: string;
    readonly defaultValue?: string;
}

export interface StepLibraryItem {
    readonly id: string;
    readonly definitionId: string;
    readonly familyId: string;
    readonly kind: StepLibraryItemKind;
    readonly sourceGroup: StepLibrarySourceGroup;
    readonly template: string;
    readonly templateDisplayText?: string;
    readonly displayText: string;
    readonly alternateDisplayText?: string;
    readonly language?: 'ru' | 'en';
    readonly description?: string;
    readonly scenarioCode?: string;
    readonly categoryPath: readonly string[];
    readonly parameters: readonly StepLibraryParameter[];
    readonly sourceLabel: string;
    readonly navigable: boolean;
    readonly insertable: boolean;
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
    nested: 3,
    main: 4
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
    const text = buildProjectDefinitionSnippetData(definition, {
        preferredText: preferredDisplayText(definition)
    }).displayText;
    return alignGherkinTablesInText(text, '\n');
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

function mainScenarioLocation(scenario: TestInfo): ProjectDefinitionLocation {
    const line = scenario.scenarioCodeLine ?? 0;
    const startCharacter = scenario.scenarioCodeLineStartCharacter ?? 0;
    const endCharacter = scenario.scenarioCodeLineEndCharacter ?? startCharacter;
    return Object.freeze({
        uri: scenario.yamlFileUri.toString(),
        range: Object.freeze({
            start: Object.freeze({ line, character: startCharacter }),
            end: Object.freeze({ line, character: endCharacter })
        })
    });
}

function isMainScenario(scenario: TestInfo): boolean {
    return typeof scenario.tabName === 'string' && scenario.tabName.trim().length > 0;
}

function mainScenarioItems(scenarios: readonly TestInfo[]): readonly StepLibraryItem[] {
    return scenarios.filter(isMainScenario).map(scenario => {
        const uri = scenario.yamlFileUri.toString();
        const definitionId = `mainScenario:${uri}`;
        const tabName = scenario.tabName!.trim();
        const relativePath = scenario.relativePath || scenario.name;
        const sourceLabel = `Main scenario (${relativePath})`;
        const scenarioCode = scenario.scenarioCode?.trim();
        const description = scenario.scenarioDescription?.trim();
        const capturedLocation = mainScenarioLocation(scenario);
        return Object.freeze({
            id: `mainScenario#${uri}`,
            definitionId,
            familyId: definitionId,
            kind: 'mainScenario' as const,
            sourceGroup: 'main' as const,
            template: scenario.name,
            displayText: scenario.name,
            ...(description ? { description } : {}),
            ...(scenarioCode ? { scenarioCode } : {}),
            categoryPath: Object.freeze([tabName]),
            parameters: Object.freeze([]),
            sourceLabel,
            navigable: true,
            insertable: false,
            capturedLocation,
            searchText: normalizeSearchText([
                scenario.name,
                description,
                scenarioCode,
                tabName,
                sourceLabel,
                relativePath
            ])
        });
    });
}

function mainScenarioIdentity(scenarios: readonly TestInfo[]): string | undefined {
    const signatures = scenarios.filter(isMainScenario).map(scenario => ({
        uri: scenario.yamlFileUri.toString(),
        name: scenario.name,
        code: scenario.scenarioCode ?? '',
        description: scenario.scenarioDescription ?? '',
        tabName: scenario.tabName?.trim() ?? '',
        relativePath: scenario.relativePath
    })).sort((left, right) => compareText(left.uri, right.uri));
    if (signatures.length === 0) {
        return undefined;
    }
    return createHash('sha256').update(JSON.stringify(signatures), 'utf8').digest('hex');
}

export function buildStepLibrarySnapshot(
    view: ProjectDefinitionView,
    scenarios: readonly TestInfo[] = []
): StepLibrarySnapshot {
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
        nested: 0,
        main: 0
    };
    const items: StepLibraryItem[] = view.all.map(definition => {
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
        const templateDisplayText = alignGherkinTablesInText(definition.template, '\n');
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
            definition.scenarioCode,
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
            ...(templateDisplayText !== definition.template ? { templateDisplayText } : {}),
            displayText: ownDisplayText,
            ...(alternateDisplayText ? { alternateDisplayText } : {}),
            ...(definition.language ? { language: definition.language } : {}),
            ...(definition.description ? { description: definition.description } : {}),
            ...(definition.scenarioCode ? { scenarioCode: definition.scenarioCode } : {}),
            categoryPath: definitionCategoryPath,
            parameters: definitionParameters,
            sourceLabel: definition.sourceLabel,
            navigable,
            insertable: true,
            ...(capturedLocation ? { capturedLocation } : {}),
            searchText
        });
    });
    const mainItems = mainScenarioItems(scenarios);
    counts.main = mainItems.length;
    items.push(...mainItems);
    items.sort((left, right) =>
        SOURCE_ORDER[left.sourceGroup] - SOURCE_ORDER[right.sourceGroup]
        || compareText(left.displayText.toLowerCase(), right.displayText.toLowerCase())
        || compareText(left.id, right.id)
    );

    const mainIdentity = mainScenarioIdentity(scenarios);
    return Object.freeze({
        viewIdentity: mainIdentity ? `${view.identity}\0main:${mainIdentity}` : view.identity,
        items: Object.freeze(items),
        counts: Object.freeze(counts)
    });
}
