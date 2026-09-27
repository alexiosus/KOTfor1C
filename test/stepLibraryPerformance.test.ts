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
import { buildStepLibrarySnapshot } from '../src/stepLibraryModel';

interface SearchItem {
    readonly id: string;
    readonly sourceGroup: 'builtIn' | 'user' | 'export' | 'nested';
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
