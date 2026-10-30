import {
    resolveScenarioByName,
    type ScenarioCatalog,
    type ScenarioResolution
} from './scenarioCatalog';

export interface ScenarioTarget {
    name: string;
    uri?: string;
}

export function resolveScenarioTarget(
    catalog: ScenarioCatalog,
    target: ScenarioTarget
): ScenarioResolution {
    const name = target.name.trim();
    if (!target.uri) {
        return resolveScenarioByName(catalog, name);
    }

    const scenario = catalog.byUri.get(target.uri);
    return scenario?.name === name
        ? { kind: 'unique', name, scenario }
        : { kind: 'missing', name };
}

export function resolveScenarioRenameTarget(
    catalog: ScenarioCatalog,
    target: ScenarioTarget
): ScenarioResolution {
    const resolution = resolveScenarioTarget(catalog, target);
    if (resolution.kind !== 'unique') {
        return resolution;
    }

    const scenarios = catalog.byName.get(resolution.name) || [];
    return scenarios.length === 1
        ? resolution
        : { kind: 'ambiguous', name: resolution.name, scenarios };
}
