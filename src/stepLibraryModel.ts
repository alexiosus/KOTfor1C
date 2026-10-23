import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
    ProjectDefinition,
    ProjectDefinitionKind,
    ProjectDefinitionLocation,
    ProjectDefinitionView
} from './projectDefinition';
import { buildProjectDefinitionSnippetData } from './projectDefinitionSnippet';
import { alignGherkinTablesInText } from './gherkinTableUtils';
import { getScenarioRuntimeKey } from './scenarioRuntimeIdentity';
import { scenarioFilesAvailable } from './scenarioFilesModel';
import type { ProcessStepReference, TestInfo } from './types';
import type { StandaloneFeatureGroup, StandaloneFeatureSnapshot } from './standaloneFeatureModel';
import type { ProjectGroup } from './projectLibraryStore';

export type StepLibrarySourceGroup = 'builtIn' | 'user' | 'export' | 'nested' | 'main' | 'process' | 'standalone';
export type StepLibraryItemKind = ProjectDefinitionKind | 'mainScenario' | 'process' | 'standaloneFeature';

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
    readonly hasScenarioFiles?: true;
    readonly compiledFeatureUri?: string;
    readonly scenarioFilesRootUri?: string;
    readonly sourceScenarioFilesRootUri?: string;
    readonly attachmentPaths?: readonly string[];
    readonly scenarioKey?: string;
    readonly processUri?: string;
    readonly processUid?: string;
    readonly processSteps?: readonly Readonly<ProcessStepReference>[];
    readonly processStepsSignature?: string;
    readonly featureId?: string;
    readonly groupId?: string;
    readonly order?: number;
    readonly groupOrder?: number;
    readonly scenarioGroupKey?: string;
    readonly standaloneGroupKey?: string;
    readonly jsonPath?: string;
    readonly searchText: string;
}

export interface CompiledScenarioResources {
    readonly featureUri: string;
    readonly filesRootUri: string;
}

export interface StepLibrarySnapshot {
    readonly viewIdentity: string;
    readonly items: readonly StepLibraryItem[];
    readonly counts: Readonly<Record<Exclude<StepLibrarySourceGroup, 'standalone' | 'process'>, number> & { standalone?: number; process?: number }>;
    readonly standaloneGroups?: readonly StandaloneFeatureGroup[];
    readonly scenarioGroups?: readonly ProjectGroup[];
}

const SOURCE_ORDER: Readonly<Record<StepLibrarySourceGroup, number>> = Object.freeze({
    builtIn: 0,
    user: 1,
    export: 2,
    nested: 3,
    main: 4,
    process: 5,
    standalone: 6
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
    return scenario.kind === 'process' || (scenario.hasTestSettings ?? !!scenario.tabName?.trim());
}

export function getProcessStepsSignature(uid: string | undefined, steps: readonly ProcessStepReference[]): string {
    return createHash('sha256').update(JSON.stringify([uid ?? '', steps.map(step => [
        step.uid ?? '', step.name ?? '', step.type, step.scenarioUid ?? '', step.scenarioName ?? '',
        step.scenarioCode ?? '', step.processUid ?? '', step.processName ?? ''
    ])]), 'utf8').digest('hex');
}

function mainScenarioItems(
    scenarios: readonly TestInfo[],
    compiledResources: ReadonlyMap<string, CompiledScenarioResources>,
    scenarioGroups?: readonly ProjectGroup[]
): readonly StepLibraryItem[] {
    return scenarios.filter(isMainScenario).map(scenario => {
        const uri = scenario.yamlFileUri.toString();
        const definitionId = `mainScenario:${uri}`;
        const tabName = scenario.tabName?.trim() || 'Processes';
        const declaredGroup = scenarioGroups?.filter(group => {
            if (group.name !== tabName || !group.sections.includes(scenario.kind === 'process' ? 'process' : 'main')) { return false; }
            const root = (group as import('./projectGroupDisplayOrder').ProjectDisplayGroup).projectRoot;
            if (!root) { return true; }
            const relative = path.relative(root, scenario.yamlFileUri.fsPath);
            return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
        }).sort((left, right) => {
            const rootLength = (group: typeof left) => (group as import('./projectGroupDisplayOrder').ProjectDisplayGroup).projectRoot?.length ?? 0;
            return rootLength(right) - rootLength(left);
        })[0];
        const relativePath = scenario.relativePath || scenario.name;
        const sourceLabel = `${scenario.kind === 'process' ? 'Process' : 'Main scenario'} (${relativePath})`;
        const scenarioCode = (scenario.kind === 'process' ? scenario.processCode : scenario.scenarioCode)?.trim();
        const description = scenario.scenarioDescription?.trim();
        const capturedLocation = mainScenarioLocation(scenario);
        const scenarioKey = getScenarioRuntimeKey(scenario);
        const resources = compiledResources.get(scenarioKey);
        return Object.freeze({
            id: `mainScenario#${uri}`,
            definitionId,
            familyId: definitionId,
            kind: scenario.kind === 'process' ? 'process' as const : 'mainScenario' as const,
            sourceGroup: scenario.kind === 'process' ? 'process' as const : 'main' as const,
            template: scenario.name,
            displayText: scenario.name,
            ...(description ? { description } : {}),
            ...(scenarioCode ? { scenarioCode } : {}),
            categoryPath: Object.freeze([tabName]),
            ...(Number.isFinite(scenario.order) ? { order: scenario.order } : {}),
            ...(declaredGroup ? { groupOrder: (declaredGroup as import('./projectGroupDisplayOrder').ProjectDisplayGroup)
                .displayOrders?.[scenario.kind === 'process' ? 'process' : 'main'] ?? declaredGroup.order,
                ...((declaredGroup as import('./projectGroupDisplayOrder').ProjectDisplayGroup).key
                    ? { scenarioGroupKey: (declaredGroup as import('./projectGroupDisplayOrder').ProjectDisplayGroup).key } : {}) } : {}),
            parameters: Object.freeze([]),
            sourceLabel,
            navigable: true,
            insertable: false,
            capturedLocation,
            ...(/^file:/iu.test(uri) ? {
                hasScenarioFiles: true as const,
                sourceScenarioFilesRootUri: new URL('./files', uri).toString(),
                scenarioFilesRootUri: new URL('./files', uri).toString()
            } : {}),
            ...(resources ? {
                hasScenarioFiles: true as const,
                compiledFeatureUri: resources.featureUri,
                scenarioFilesRootUri: resources.filesRootUri
            } : {}),
            scenarioKey,
            ...(scenario.kind === 'process' ? {
                processUri: uri,
                ...(scenario.uid ? { processUid: scenario.uid } : {}),
                processSteps: Object.freeze((scenario.processSteps ?? []).map(step => Object.freeze({ ...step }))),
                processStepsSignature: getProcessStepsSignature(scenario.uid, scenario.processSteps ?? [])
            } : {}),
            searchText: normalizeSearchText([
                scenario.name,
                description,
                scenarioCode,
                tabName,
                sourceLabel,
                relativePath,
                ...(scenario.processSteps ?? []).flatMap(step => [step.name, step.scenarioName, step.processName])
            ])
        });
    });
}

function scenarioKeyForLocation(
    location: ProjectDefinitionLocation | undefined,
    scenarios: readonly TestInfo[]
): string | undefined {
    if (!location) {
        return undefined;
    }
    const candidates = scenarios.filter(scenario => scenario.yamlFileUri.toString() === location.uri);
    if (candidates.length === 0) {
        return undefined;
    }
    const line = location.range.start.line;
    candidates.sort((left, right) => {
        const leftDistance = Math.abs((left.scenarioCodeLine ?? 0) - line);
        const rightDistance = Math.abs((right.scenarioCodeLine ?? 0) - line);
        return leftDistance - rightDistance
            || getScenarioRuntimeKey(left).localeCompare(getScenarioRuntimeKey(right));
    });
    return getScenarioRuntimeKey(candidates[0]);
}

function mainScenarioIdentity(
    scenarios: readonly TestInfo[],
    compiledResources: ReadonlyMap<string, CompiledScenarioResources>
): string | undefined {
    const signatures = scenarios.filter(isMainScenario).map(scenario => ({
        uri: scenario.yamlFileUri.toString(),
        name: scenario.name,
        code: scenario.scenarioCode ?? '',
        description: scenario.scenarioDescription ?? '',
        tabName: scenario.tabName?.trim() ?? '',
        hasTestSettings: scenario.hasTestSettings,
        order: Number.isFinite(scenario.order) ? scenario.order : null,
        relativePath: scenario.relativePath,
        ...(scenario.kind === 'process' ? { kind: scenario.kind, uid: scenario.uid, processCode: scenario.processCode, processSteps: scenario.processSteps } : {}),
        compiledResources: compiledResources.get(getScenarioRuntimeKey(scenario)) ?? null
    })).sort((left, right) => compareText(left.uri, right.uri));
    if (signatures.length === 0) {
        return undefined;
    }
    return createHash('sha256').update(JSON.stringify(signatures), 'utf8').digest('hex');
}

export function buildStepLibrarySnapshot(
    view: ProjectDefinitionView,
    scenarios: readonly TestInfo[] = [],
    compiledResources: ReadonlyMap<string, CompiledScenarioResources> = new Map(),
    standalone?: StandaloneFeatureSnapshot,
    scenarioGroups?: readonly ProjectGroup[]
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

    const counts: Record<Exclude<StepLibrarySourceGroup, 'standalone'>, number> & { standalone?: number } = {
        builtIn: 0,
        user: 0,
        export: 0,
        nested: 0,
        main: 0,
        process: 0
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
        const scenarioKey = definition.kind === 'nestedScenario'
            ? scenarioKeyForLocation(capturedLocation, scenarios)
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
        const id = presentationId(definition);
        const itemSupportsScenarioFiles = scenarioFilesAvailable({
            id,
            kind: definition.kind,
            sourceGroup: group,
            capturedLocation
        });
        return Object.freeze({
            id,
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
            ...(itemSupportsScenarioFiles ? { hasScenarioFiles: true as const } : {}),
            ...(scenarioKey ? { scenarioKey } : {}),
            searchText
        });
    });
    const declaredScenarioGroups = scenarioGroups?.filter(group => group.sections.some(section => section === 'main' || section === 'process'))
        .map(group => Object.freeze({ ...group, sections: Object.freeze([...group.sections]) }))
        .sort((left, right) => left.order - right.order || compareText(left.name, right.name) || compareText(left.id, right.id));
    const mainItems = mainScenarioItems(scenarios, compiledResources, declaredScenarioGroups);
    counts.main = mainItems.filter(item => item.sourceGroup === 'main').length;
    counts.process = mainItems.filter(item => item.sourceGroup === 'process').length;
    items.push(...mainItems);
    if (standalone) {
        for (const feature of standalone.features) {
            const definitionId = `standaloneFeature:${feature.id}`;
            const groupIndex = standalone.groups.findIndex(group => group.id === feature.groupId
                && (!group.projectRoot || standalone.ordering?.featureRoots[feature.id] === group.projectRoot));
            const group = standalone.groups[groupIndex];
            const groupName = group?.name;
            items.push(Object.freeze({
                id: `standaloneFeature#${feature.id}`,
                definitionId, familyId: definitionId,
                kind: 'standaloneFeature', sourceGroup: 'standalone',
                featureId: feature.id, scenarioKey: feature.id, groupId: feature.groupId, order: feature.order,
                groupOrder: feature.groupId ? groupIndex + 1 : 0,
                ...(group?.projectRoot ? { standaloneGroupKey: JSON.stringify([group.projectRoot, group.id]) } : {}),
                ...(feature.jsonPath ? { jsonPath: feature.jsonPath } : {}),
                template: feature.name, displayText: feature.title || feature.name,
                description: feature.relativePath,
                categoryPath: Object.freeze(groupName ? [groupName] : []),
                parameters: Object.freeze([]), language: feature.language,
                sourceLabel: feature.relativePath,
                navigable: true, insertable: false,
                capturedLocation: cloneLocation({ uri: feature.uri, range: {
                    start: { line: 0, character: 0 }, end: { line: 0, character: 0 }
                } }),
                searchText: normalizeSearchText([feature.title, feature.name, feature.relativePath, groupName, feature.jsonPath])
            }));
        }
        counts.standalone = standalone.features.length;
    }
    items.sort((left, right) =>
        SOURCE_ORDER[left.sourceGroup] - SOURCE_ORDER[right.sourceGroup]
        || (left.sourceGroup === 'standalone' && right.sourceGroup === 'standalone'
            ? (left.groupOrder ?? 0) - (right.groupOrder ?? 0) || (left.order ?? 0) - (right.order ?? 0) : 0)
        || compareText(left.displayText.toLowerCase(), right.displayText.toLowerCase())
        || compareText(left.id, right.id)
    );

    const mainIdentity = mainScenarioIdentity(scenarios, compiledResources);
    const standaloneIdentity = standalone ? createHash('sha256')
        .update(JSON.stringify(standalone), 'utf8').digest('hex') : undefined;
    const scenarioGroupsIdentity = declaredScenarioGroups ? createHash('sha256')
        .update(JSON.stringify(declaredScenarioGroups), 'utf8').digest('hex') : undefined;
    return Object.freeze({
        viewIdentity: `${view.identity}${mainIdentity ? `\0main:${mainIdentity}` : ''}${standaloneIdentity ? `\0standalone:${standaloneIdentity}` : ''}${scenarioGroupsIdentity ? `\0groups:${scenarioGroupsIdentity}` : ''}`,
        items: Object.freeze(items),
        counts: Object.freeze(counts),
        ...(standalone ? { standaloneGroups: Object.freeze(standalone.groups.map(group => Object.freeze({ ...group }))) } : {}),
        ...(declaredScenarioGroups ? { scenarioGroups: Object.freeze(declaredScenarioGroups) } : {})
    });
}
