import * as path from 'path';
import type * as vscode from 'vscode';
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

export interface ScenarioCatalogProvider {
    getScenarioCatalog(): ScenarioCatalog | null;
    ensureFreshScenarioCatalog(): Promise<ScenarioCatalog>;
    readonly onDidUpdateScenarioCatalog: vscode.Event<ScenarioCatalog | null>;
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

function decodeUriComponentSafely(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function windowsPathComparisonKey(value: string): string {
    const normalized = path.win32
        .normalize(value.replace(/^\/(?=[A-Za-z]:[\\/])/, ''))
        .replace(/\\/g, '/')
        .toLowerCase();
    return `windows-file:${normalized}`;
}

function serializedScenarioUriComparisonKey(value: string): string {
    const decoded = decodeUriComponentSafely(value.trim()).replace(/\\/g, '/');
    const drivePath = /^file:\/+([A-Za-z]:\/.*)$/i.exec(decoded);
    if (drivePath) {
        return windowsPathComparisonKey(drivePath[1]);
    }

    const uncPath = /^file:\/\/([^/]+\/.*)$/i.exec(decoded);
    if (uncPath) {
        return windowsPathComparisonKey(`//${uncPath[1]}`);
    }

    return `uri:${value.trim()}`;
}

function scenarioUriComparisonKey(uri: TestInfo['yamlFileUri']): string {
    const serializedKey = serializedScenarioUriComparisonKey(uri.toString());
    if (serializedKey.startsWith('windows-file:')) {
        return serializedKey;
    }

    const fsPath = uri.fsPath || '';
    if (
        uri.scheme === 'file'
        && (
            /^[A-Za-z]:[\\/]/.test(fsPath)
            || /^\\\\/.test(fsPath)
            || /^\/\//.test(fsPath)
        )
    ) {
        return windowsPathComparisonKey(fsPath);
    }

    return serializedKey;
}

class ScenarioUriLookup implements ReadonlyMap<string, TestInfo> {
    private readonly exact = new Map<string, TestInfo>();
    private readonly byComparisonKey = new Map<string, TestInfo>();

    public readonly [Symbol.toStringTag] = 'ScenarioUriLookup';

    constructor(scenarios: readonly TestInfo[]) {
        for (const scenario of scenarios) {
            this.exact.set(scenario.yamlFileUri.toString(), scenario);
            this.byComparisonKey.set(scenarioUriComparisonKey(scenario.yamlFileUri), scenario);
        }
    }

    public get size(): number {
        return this.exact.size;
    }

    public get(key: string): TestInfo | undefined {
        return this.exact.get(key)
            ?? this.byComparisonKey.get(serializedScenarioUriComparisonKey(key));
    }

    public has(key: string): boolean {
        return this.get(key) !== undefined;
    }

    public entries(): MapIterator<[string, TestInfo]> {
        return this.exact.entries();
    }

    public keys(): MapIterator<string> {
        return this.exact.keys();
    }

    public values(): MapIterator<TestInfo> {
        return this.exact.values();
    }

    public forEach(
        callbackfn: (value: TestInfo, key: string, map: ReadonlyMap<string, TestInfo>) => void,
        thisArg?: unknown
    ): void {
        this.exact.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
    }

    public [Symbol.iterator](): MapIterator<[string, TestInfo]> {
        return this.entries();
    }
}

export function buildScenarioCatalog(scenarios: readonly TestInfo[]): ScenarioCatalog {
    const uniqueByUri = new Map<string, TestInfo>();
    for (const scenario of scenarios) {
        if (!scenario.name.length) {
            continue;
        }

        const comparisonKey = scenarioUriComparisonKey(scenario.yamlFileUri);
        if (!uniqueByUri.has(comparisonKey)) {
            uniqueByUri.set(comparisonKey, scenario);
        }
    }

    const all = [...uniqueByUri.values()].sort(compareDefinitions);
    const byName = new Map<string, TestInfo[]>();
    const byUri = new ScenarioUriLookup(all);

    for (const scenario of all) {
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
    const comparisonKey = scenarioUriComparisonKey(scenario.yamlFileUri);
    const existing = catalog.all.find(item => scenarioUriComparisonKey(item.yamlFileUri) === comparisonKey);
    const replacement = existing
        && existing.yamlFileUri.toString() !== scenario.yamlFileUri.toString()
        ? { ...scenario, yamlFileUri: existing.yamlFileUri }
        : scenario;
    return buildScenarioCatalog([
        ...catalog.all.filter(item => scenarioUriComparisonKey(item.yamlFileUri) !== comparisonKey),
        replacement
    ]);
}

export function removeScenarioFromCatalogByUri(catalog: ScenarioCatalog, uriKey: string): ScenarioCatalog {
    const comparisonKey = serializedScenarioUriComparisonKey(uriKey);
    return buildScenarioCatalog(
        catalog.all.filter(item => scenarioUriComparisonKey(item.yamlFileUri) !== comparisonKey)
    );
}
