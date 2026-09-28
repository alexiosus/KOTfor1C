import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import type {
    ProjectDefinition,
    ProjectDefinitionKind,
    ProjectDefinitionView
} from '../src/projectDefinition';
import { buildScenarioCatalog, type ScenarioCatalog } from '../src/scenarioCatalog';
import { ScenarioRelationshipService } from '../src/scenarioRelationshipService';
import { StepLibrarySnapshotService } from '../src/stepLibrarySnapshotService';
import { ManagedInfobaseService } from '../src/managedInfobaseService';
import { buildStepLibrarySnapshot } from '../src/stepLibraryModel';

interface SearchItem {
    readonly id: string;
    readonly sourceGroup: 'builtIn' | 'user' | 'export' | 'nested' | 'main';
    readonly displayText: string;
    readonly template: string;
    readonly searchText: string;
    readonly categoryPath: readonly string[];
    readonly language?: 'ru' | 'en';
}

interface StepLibraryProtocol {
    prepareItems(items: readonly SearchItem[]): readonly SearchItem[];
    searchItems(
        items: readonly SearchItem[],
        query: string,
        options?: { readonly limit?: number }
    ): readonly SearchItem[];
    buildCategoryTree(items: readonly SearchItem[]): readonly unknown[];
}

const definitionKinds: readonly ProjectDefinitionKind[] = [
    'builtInStep',
    'userStep',
    'exportScenario',
    'nestedScenario'
];

function largeView(size: number): ProjectDefinitionView {
    const definitions: ProjectDefinition[] = Array.from({ length: size }, (_, index) => {
        const kind = definitionKinds[index % definitionKinds.length];
        const template = `Step ${index} opens form section ${index % 25}`;
        return {
            id: `performance:${index}`,
            ...(kind === 'builtInStep' ? { familyId: `family:${index}` } : {}),
            kind,
            template,
            normalizedTemplate: template.toLowerCase(),
            parameters: [{ name: `Value${index}`, index: 0, source: 'quoted' }],
            sourceLabel: `Performance source ${index % 8}`,
            description: `Prepared-view fixture definition ${index}`,
            ...(kind === 'builtInStep'
                ? {
                    language: index % 2 === 0 ? 'en' as const : 'ru' as const,
                    categoryPath: ['Performance', `Group ${index % 25}`]
                }
                : { category: `Performance.Group ${index % 25}` })
        };
    });
    return {
        identity: `performance:${size}`,
        all: definitions,
        byId: new Map(definitions.map(definition => [definition.id, definition])),
        byNormalizedTemplate: new Map()
    };
}

function measure<T>(operation: () => T): { readonly value: T; readonly durationMs: number } {
    const startedAt = performance.now();
    const value = operation();
    return { value, durationMs: performance.now() - startedAt };
}

class EventHub<T> {
    private readonly listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function emptyScenarioCatalog(): ScenarioCatalog {
    return {
        all: [],
        byName: new Map(),
        byUri: new Map(),
        primaryByName: new Map()
    };
}

test('prepared visual-library view keeps 2200 definitions on the client hot path', t => {
    const protocol = require(path.join(
        process.cwd(),
        'media',
        'stepLibraryProtocol.js'
    )) as StepLibraryProtocol;
    let resolverCalls = 0;
    let fileSystemCalls = 0;
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
        fileSystemCalls += 1;
        return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;

    try {
        const resolvePreparedView = (): ProjectDefinitionView => {
            resolverCalls += 1;
            return largeView(2_200);
        };
        const snapshotResult = measure(() => buildStepLibrarySnapshot(resolvePreparedView()));
        const preparationResult = measure(() => protocol.prepareItems(
            snapshotResult.value.items as readonly SearchItem[]
        ));
        const items = preparationResult.value;
        const searches = [
            measure(() => protocol.searchItems(items, items[100].displayText)),
            measure(() => protocol.searchItems(items, 'Step 10')),
            measure(() => protocol.searchItems(items, 'step form sec')),
            measure(() => protocol.searchItems(items, 'opens form section 17'))
        ];
        const firstBatch = measure(() => {
            protocol.buildCategoryTree(items);
            return protocol.searchItems(items, '', { limit: 100 });
        });

        assert.equal(snapshotResult.value.items.length, 2_200);
        assert.equal(resolverCalls, 1, 'one prepared view is resolved per generation');
        assert.equal(fileSystemCalls, 0, 'snapshot and client queries perform no filesystem I/O');
        assert.ok(searches.every(result => result.value.length > 0));
        assert.ok(firstBatch.value.length <= 100);
        assert.equal(resolverCalls, 1, 'query changes do not return to the resolver');

        t.diagnostic([
            `prepared view ${snapshotResult.durationMs.toFixed(2)} ms`,
            `client normalization ${preparationResult.durationMs.toFixed(2)} ms`,
            `search exact/prefix/token/substring ${searches
                .map(result => result.durationMs.toFixed(2))
                .join('/')} ms`,
            `first 100-row render model ${firstBatch.durationMs.toFixed(2)} ms`
        ].join('; '));
    } finally {
        fs.readFileSync = originalReadFileSync;
    }
});

test('active-editor relationship updates use the published catalog without scans or path lookup', () => {
    const catalogChanges = new EventHub<ScenarioCatalog | null>();
    const configurationChanges = new EventHub<unknown>();
    const nestedUri = {
        scheme: 'file',
        fsPath: '/workspace/Nested/scen.yaml',
        toString: () => 'file:///workspace/Nested/scen.yaml'
    };
    const catalog = buildScenarioCatalog([{
        name: 'Nested',
        relativePath: 'Nested/scen.yaml',
        yamlFileUri: nestedUri
    } as never]);
    let resolverCalls = 0;
    let pathLookups = 0;
    const service = new ScenarioRelationshipService({
        catalogProvider: {
            getScenarioCatalog: () => catalog,
            ensureFreshScenarioCatalog: async () => {
                resolverCalls += 1;
                return catalog;
            },
            onDidUpdateScenarioCatalog: catalogChanges.event as never
        },
        configuration: {
            get: <T>(_key: string, fallback?: T) => fallback,
            update: async () => undefined
        },
        workspaceConfigurationTarget: 'workspace',
        onDidChangeConfiguration: configurationChanges.event as never,
        getScanRootPaths: () => {
            pathLookups += 1;
            return { scanRootPath: '/workspace', canonicalScanRootPath: '/workspace' };
        }
    });

    service.handleActiveEditorChanged(nestedUri as never);

    assert.equal(resolverCalls, 0);
    assert.equal(pathLookups, 0);
    assert.deepEqual(service.getState().currentScenarioKeys, [nestedUri.toString()]);
    service.dispose();
});

test('two Step Library consumers share one in-flight resolver generation', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    const pendingView = deferred<ProjectDefinitionView>();
    let resolverCalls = 0;
    const service = new StepLibrarySnapshotService({
        resolver: {
            ensureReady: async () => {
                resolverCalls += 1;
                return pendingView.promise;
            },
            onDidChangeView: resolverChanges.event as never
        },
        scenarios: {
            getScenarioCatalog: emptyScenarioCatalog,
            onDidUpdateScenarioCatalog: scenarioChanges.event as never
        }
    });

    const compactView = service.ensureReady();
    const fullView = service.ensureReady();
    assert.equal(resolverCalls, 1);
    pendingView.resolve({ ...largeView(0), identity: 'shared-generation' });

    const [compactSnapshot, fullSnapshot] = await Promise.all([compactView, fullView]);
    assert.strictEqual(compactSnapshot, fullSnapshot);
    assert.equal(resolverCalls, 1);
    service.dispose();
});

test('two infobase consumers share one in-flight collector generation', async () => {
    const profileChanges = new EventHub<unknown>();
    const pendingRecords = deferred<readonly never[]>();
    let collectorCalls = 0;
    const service = new ManagedInfobaseService({
        loadActiveProfile: async () => ({
            id: 'active',
            name: 'Active',
            buildParameters: [],
            additionalVanessaParameters: [],
            globalVanessaVariables: []
        }),
        onDidChangeActiveProfile: profileChanges.event as never,
        workspaceRootPath: '/workspace',
        collect: async () => {
            collectorCalls += 1;
            return pendingRecords.promise;
        }
    });

    const compactView = service.ensureReady();
    const fullView = service.ensureReady();
    await Promise.resolve();
    assert.equal(collectorCalls, 1);
    pendingRecords.resolve([]);

    const [compactSnapshot, fullSnapshot] = await Promise.all([compactView, fullView]);
    assert.strictEqual(compactSnapshot, fullSnapshot);
    assert.equal(collectorCalls, 1);
    service.dispose();
});
