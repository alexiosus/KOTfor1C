import * as path from 'path';
import type { TestInfo } from './types';

type PathApi = Pick<typeof path, 'dirname' | 'isAbsolute' | 'relative' | 'resolve' | 'sep'>;

interface ScenarioDirectoryDefinition {
    name: string;
    filePath: string;
}

interface IndexedScenarioName {
    name: string;
    order: number;
}

export class ScenarioDirectoryIndex {
    private readonly namesByDirectory = new Map<string, IndexedScenarioName[]>();

    constructor(
        definitions: readonly ScenarioDirectoryDefinition[],
        scanRootPath: string,
        canonicalScanRootPath: string,
        private readonly pathApi: PathApi = path,
        private readonly caseInsensitive: boolean = process.platform === 'win32'
    ) {
        const resolvedScanRoot = pathApi.resolve(scanRootPath);
        const resolvedCanonicalRoot = pathApi.resolve(canonicalScanRootPath);

        definitions.forEach((definition, order) => {
            const scenarioDirectory = pathApi.dirname(definition.filePath);
            const relativeDirectory = pathApi.relative(resolvedScanRoot, scenarioDirectory);
            if (
                relativeDirectory === '..'
                || relativeDirectory.startsWith(`..${pathApi.sep}`)
                || pathApi.isAbsolute(relativeDirectory)
            ) {
                return;
            }

            const rawKey = this.normalize(scenarioDirectory);
            const canonicalKey = this.normalize(pathApi.resolve(resolvedCanonicalRoot, relativeDirectory));
            this.add(rawKey, definition.name, order);
            if (canonicalKey !== rawKey) {
                this.add(canonicalKey, definition.name, order);
            }
        });
    }

    public getRelatedScenarioNames(targetPath: string): string[] {
        const matchingNames = new Map<string, number>();
        let directory = this.normalize(targetPath);

        while (true) {
            for (const entry of this.namesByDirectory.get(directory) || []) {
                const previousOrder = matchingNames.get(entry.name);
                if (previousOrder === undefined || entry.order < previousOrder) {
                    matchingNames.set(entry.name, entry.order);
                }
            }

            const parent = this.pathApi.dirname(directory);
            if (parent === directory) {
                break;
            }
            directory = parent;
        }

        return [...matchingNames]
            .sort((left, right) => left[1] - right[1])
            .map(([name]) => name);
    }

    private normalize(targetPath: string): string {
        const resolved = this.pathApi.resolve(targetPath);
        return this.caseInsensitive ? resolved.toLowerCase() : resolved;
    }

    private add(directory: string, name: string, order: number): void {
        const entries = this.namesByDirectory.get(directory) || [];
        entries.push({ name, order });
        this.namesByDirectory.set(directory, entries);
    }
}

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
