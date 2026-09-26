import type { Translator } from './localization';
import type {
    ProjectDefinition,
    ProjectDefinitionRange
} from './projectDefinition';
import { parseScenarioDescriptor } from './scenarioDescriptor';
import {
    updateScenarioCategoryInMetadataContent,
    type ScenarioYamlContentMutation
} from './scenarioYamlMutations';
import { ScenarioYamlDocument } from './scenarioYamlDocument';

export const SCENARIO_CATEGORY_COMMAND = 'kotTestToolkit.setScenarioCategory';

export interface ScenarioCategoryCommandTarget {
    readonly documentUri: string;
    readonly documentVersion: number;
}

export interface ScenarioCategoryAction {
    readonly title: string;
    readonly command: typeof SCENARIO_CATEGORY_COMMAND;
    readonly range: ProjectDefinitionRange;
    readonly target: ScenarioCategoryCommandTarget;
}

type Translate = (message: string, ...args: string[]) => string;

function offsetPosition(source: string, offset: number): { line: number; character: number } {
    const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    let line = 0;
    for (let index = source.indexOf('\n'); index >= 0 && index < offset; index = source.indexOf('\n', index + 1)) {
        line += 1;
    }
    return { line, character: offset - lineStart };
}

export function collectNestedScenarioCategories(
    definitions: readonly Pick<ProjectDefinition, 'kind' | 'category'>[]
): readonly string[] {
    const unique = new Map<string, string>();
    for (const definition of definitions) {
        if (definition.kind !== 'nestedScenario') {
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

export function buildScenarioCategoryAction(
    source: string,
    documentUri: string,
    documentVersion: number,
    translate: Translate = message => message
): ScenarioCategoryAction | null {
    try {
        const document = ScenarioYamlDocument.parse(source);
        document.requireValidForEdit();
        const metadata = document.findFieldAtPath(['KOTМетаданные']);
        if (!metadata || metadata.ambiguous || metadata.valueKind !== 'mapping') {
            return null;
        }
        if (parseScenarioDescriptor(source).phaseSwitcher.hasTab) {
            return null;
        }
        const category = document.findField('KOTМетаданные', 'Категория');
        if (category && (category.ambiguous || category.valueKind !== 'scalar')) {
            return null;
        }
        return Object.freeze({
            title: translate(category ? 'Change category' : '+ Category'),
            command: SCENARIO_CATEGORY_COMMAND,
            range: Object.freeze({
                start: Object.freeze(offsetPosition(source, metadata.lineStart)),
                end: Object.freeze(offsetPosition(source, metadata.lineEnd))
            }),
            target: Object.freeze({ documentUri, documentVersion })
        });
    } catch {
        return null;
    }
}

export function applyScenarioCategoryToTemplate(
    template: string,
    category: string | undefined
): ScenarioYamlContentMutation {
    const normalized = category?.trim();
    return normalized
        ? updateScenarioCategoryInMetadataContent(template, normalized)
        : { changed: false, content: template };
}

export function isScenarioCategoryCommandTarget(
    value: unknown
): value is ScenarioCategoryCommandTarget {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<ScenarioCategoryCommandTarget>;
    return typeof candidate.documentUri === 'string'
        && candidate.documentUri.trim().length > 0
        && Number.isInteger(candidate.documentVersion)
        && Number(candidate.documentVersion) >= 0;
}

export function validateScenarioCategoryValue(
    value: string,
    translate: Translator
): string | undefined {
    if (!value.trim()) {
        return translate('Scenario category must not be empty.');
    }
    return /[\r\n]/u.test(value)
        ? translate('Scenario category must fit on a single line.')
        : undefined;
}
