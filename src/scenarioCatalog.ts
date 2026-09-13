import type { TestInfo } from './types';

export interface ScenarioCatalog {
    readonly all: readonly TestInfo[];
    readonly byName: ReadonlyMap<string, readonly TestInfo[]>;
    readonly byUri: ReadonlyMap<string, TestInfo>;
    readonly primaryByName: ReadonlyMap<string, TestInfo>;
}

export type ScenarioResolution =
    | { kind: 'missing'; name: string }
    | { kind: 'unique'; name: string; scenario: TestInfo }
    | { kind: 'ambiguous'; name: string; scenarios: readonly TestInfo[] };

function compareDefinitions(left: TestInfo, right: TestInfo): number {
    const leftPath = left.relativePath.replace(/\\/g, '/');
    const rightPath = right.relativePath.replace(/\\/g, '/');
    return leftPath.localeCompare(rightPath, undefined, { sensitivity: 'base' })
        || left.yamlFileUri.toString().localeCompare(right.yamlFileUri.toString());
}

export function buildScenarioCatalog(scenarios: readonly TestInfo[]): ScenarioCatalog {
    const all = scenarios
        .filter(item => item.name.length > 0)
        .slice()
        .sort(compareDefinitions);
    const byName = new Map<string, TestInfo[]>();
    const byUri = new Map<string, TestInfo>();

    for (const scenario of all) {
        byUri.set(scenario.yamlFileUri.toString(), scenario);
        const bucket = byName.get(scenario.name) || [];
        bucket.push(scenario);
        byName.set(scenario.name, bucket);
    }

    const primaryByName = new Map<string, TestInfo>();
    for (const [name, definitions] of byName) {
        primaryByName.set(name, definitions[0]);
    }

    return { all, byName, byUri, primaryByName };
}

export function resolveScenarioByName(catalog: ScenarioCatalog, name: string): ScenarioResolution {
    const scenarios = catalog.byName.get(name) || [];
    if (scenarios.length === 0) {
        return { kind: 'missing', name };
    }

    return scenarios.length === 1
        ? { kind: 'unique', name, scenario: scenarios[0] }
        : { kind: 'ambiguous', name, scenarios };
}

export function upsertScenarioInCatalog(catalog: ScenarioCatalog, scenario: TestInfo): ScenarioCatalog {
    const uriKey = scenario.yamlFileUri.toString();
    return buildScenarioCatalog([
        ...catalog.all.filter(item => item.yamlFileUri.toString() !== uriKey),
        scenario
    ]);
}

export function removeScenarioFromCatalogByUri(catalog: ScenarioCatalog, uriKey: string): ScenarioCatalog {
    return buildScenarioCatalog(catalog.all.filter(item => item.yamlFileUri.toString() !== uriKey));
}
