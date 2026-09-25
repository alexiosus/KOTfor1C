import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    type ExportScenarioEditSource,
    type ExportScenarioMetadataKind
} from './exportScenarioCreator';
import { parseExportScenarios } from './exportScenarioParser';
import type { ScenarioLanguage } from './gherkinDefinitionKeywords';
import type { ProjectDefinitionKind, ProjectDefinitionRange } from './projectDefinition';

export const EXPORT_SCENARIO_METADATA_COMMAND = 'kotTestToolkit.addExportScenarioMetadata';

export interface ExportScenarioMetadataCommandTarget {
    readonly documentUri: string;
    readonly documentVersion: number;
    readonly scenarioStart: { readonly line: number; readonly character: number };
    readonly kind: ExportScenarioMetadataKind;
}

export interface ExportScenarioMetadataAction {
    readonly title: string;
    readonly command: typeof EXPORT_SCENARIO_METADATA_COMMAND;
    readonly range: ProjectDefinitionRange;
    readonly target: ExportScenarioMetadataCommandTarget;
}

type Translate = (message: string, ...args: string[]) => string;
type CategorizedDefinition = {
    readonly kind: ProjectDefinitionKind;
    readonly category?: string;
    readonly definitionLocation?: { readonly uri: string };
};

const ACTION_TITLES: Readonly<Record<ExportScenarioMetadataKind, string>> = {
    category: '+ Category',
    description: '+ Description',
    usageExample: '+ Usage example'
};

const METADATA_KINDS: readonly ExportScenarioMetadataKind[] = [
    'category',
    'description',
    'usageExample'
];

export function buildExportScenarioMetadataActions(
    source: ExportScenarioEditSource,
    translate: Translate = message => message
): readonly ExportScenarioMetadataAction[] {
    const parsed = parseExportScenarios(source.text, source);
    const actions: ExportScenarioMetadataAction[] = [];
    for (const scenario of parsed.scenarios) {
        if (!scenario.exported) {
            continue;
        }
        for (const kind of METADATA_KINDS) {
            if (scenario.metadata[kind] !== undefined) {
                continue;
            }
            actions.push(Object.freeze({
                title: translate(ACTION_TITLES[kind]),
                command: EXPORT_SCENARIO_METADATA_COMMAND,
                range: scenario.titleRange,
                target: Object.freeze({
                    documentUri: source.sourceUri,
                    documentVersion: source.version,
                    scenarioStart: Object.freeze({ ...scenario.declarationRange.start }),
                    kind
                })
            }));
        }
    }
    return Object.freeze(actions);
}

export function collectExportScenarioCategories(
    definitions: readonly CategorizedDefinition[]
): readonly string[] {
    const unique = new Map<string, string>();
    for (const definition of definitions) {
        if (definition.kind !== 'exportScenario') {
            continue;
        }
        const category = definition.category?.trim();
        if (!category) {
            continue;
        }
        const key = category.toLocaleLowerCase();
        if (!unique.has(key)) {
            unique.set(key, category);
        }
    }
    return Object.freeze([...unique.values()].sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right)
    ));
}

export function collectAvailableExportScenarioCategories(
    indexedDefinitions: readonly CategorizedDefinition[],
    currentDocumentDefinitions: readonly CategorizedDefinition[],
    currentDocumentUri: string
): readonly string[] {
    const otherDocuments = indexedDefinitions.filter(definition =>
        definition.definitionLocation?.uri !== currentDocumentUri
    );
    return collectExportScenarioCategories([...otherDocuments, ...currentDocumentDefinitions]);
}

export async function canonicalizeExportScenarioDocumentUri(
    filePath: string,
    fallbackUri: string,
    realpath: (value: string) => Promise<string>
): Promise<string> {
    try {
        return pathToFileURL(path.resolve(await realpath(filePath))).toString();
    } catch {
        return fallbackUri;
    }
}

export function getExportScenarioMetadataInputDefault(
    kind: ExportScenarioMetadataKind,
    scenarioTitle: string,
    language: ScenarioLanguage
): string {
    return kind === 'usageExample'
        ? `${language === 'ru' ? 'И' : 'And'} ${scenarioTitle}`
        : '';
}
