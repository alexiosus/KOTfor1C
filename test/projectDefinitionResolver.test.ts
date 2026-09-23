import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';
import type { TestInfo } from '../src/types';
import type { ResolvedStepCatalog } from '../src/stepCatalog';
import { buildScenarioCatalog, type ScenarioCatalog } from '../src/scenarioCatalog';
import type {
    ProjectDefinition,
    ProjectDefinitionSnapshot
} from '../src/projectDefinition';
import { buildProjectDefinitionSnapshot } from '../src/projectDefinitionIndex';
import {
    ProjectDefinitionResolver,
    type ProjectDefinitionViewChangeEvent
} from '../src/projectDefinitionResolver';

class EventHub<T> {
    readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

function uri(value: string): vscode.Uri {
    return { toString: () => value } as vscode.Uri;
}

function scenario(name: string, target: string, relativePath: string, parameters: string[] = []): TestInfo {
    return {
        name,
        yamlFileUri: uri(target),
        relativePath,
        scenarioDescription: `Description of ${name}`,
        parameters
    };
}

function localDefinition(
    id: string,
    kind: 'userStep' | 'exportScenario',
    template: string,
    sourceUri: string
): ProjectDefinition {
    return {
        id,
        kind,
        template,
        normalizedTemplate: template,
        parameters: [],
        sourceLabel: kind === 'userStep' ? 'User steps (Library)' : 'Project exports (Library)',
        workspaceFolderUri: 'file:///workspace-a',
        profileId: 'active',
        libraryRootUri: 'file:///workspace-a/lib',
        definitionLocation: {
            uri: sourceUri,
            range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: template.length }
            }
        }
    };
}

function localSnapshot(definitions: readonly ProjectDefinition[]): ProjectDefinitionSnapshot {
    return buildProjectDefinitionSnapshot({
        configurationIdentity: 'local-configuration',
        workspaceFolderUri: 'file:///workspace-a',
        profileId: 'active',
        generation: 1,
        parserVersion: 'parser-v1',
        files: definitions.map((definition, index) => ({
            uri: definition.definitionLocation?.uri ?? `file:///source-${index}`,
            size: 10,
            mtimeMs: index + 1,
            parserVersion: 'parser-v1',
            definitions: [definition],
            warnings: []
        }))
    });
}

function catalog(identity: string, pattern: string): ResolvedStepCatalog {
    return {
        identity,
        catalogVersion: identity,
        source: 'bundled-html',
        steps: [{
            id: `${identity}-step`,
            ru: { pattern, description: `RU ${pattern}` },
            en: { pattern: `And ${pattern}`, description: `EN ${pattern}` }
        }]
    };
}

function createHarness(options: {
    local?: ProjectDefinitionSnapshot | null;
    scenarios?: ScenarioCatalog;
    catalogs?: ReadonlyMap<string, ResolvedStepCatalog>;
} = {}) {
    let local = options.local ?? null;
    let scenarios = options.scenarios ?? buildScenarioCatalog([]);
    const localEvents = new EventHub<{
        current: ProjectDefinitionSnapshot;
        previous: ProjectDefinitionSnapshot | null;
        reason: 'scan';
    }>();
    const scenarioEvents = new EventHub<ScenarioCatalog | null>();
    const catalogEvents = new EventHub<{
        workspaceFolderUri?: vscode.Uri;
        oldIdentity?: string;
        newIdentity: string;
    }>();
    const defaultCatalog = catalog('default-catalog', 'И встроенный шаг');
    const catalogs = options.catalogs ?? new Map([['default', defaultCatalog]]);

    const resolver = new ProjectDefinitionResolver({
        local: {
            getSnapshot: () => local,
            ensureReady: async () => {
                if (!local) {
                    throw new Error('not ready');
                }
                return local;
            },
            onDidChangeSnapshot: localEvents.event
        },
        scenarios: {
            getScenarioCatalog: () => scenarios,
            ensureFreshScenarioCatalog: async () => scenarios,
            onDidUpdateScenarioCatalog: scenarioEvents.event
        },
        steps: {
            getCatalog: async resource => {
                const key = resource?.toString().includes('workspace-b') ? 'b' : 'a';
                return catalogs.get(key) ?? catalogs.get('default') ?? defaultCatalog;
            },
            onDidChangeCatalog: catalogEvents.event
        }
    });

    return {
        resolver,
        localEvents,
        scenarioEvents,
        catalogEvents,
        setLocal(value: ProjectDefinitionSnapshot) {
            const previous = local;
            local = value;
            localEvents.fire({ current: value, previous, reason: 'scan' });
        },
        setScenarios(value: ScenarioCatalog) {
            scenarios = value;
            scenarioEvents.fire(value);
        }
    };
}

test('composes all four definition kinds and preserves localized built-in variants', async () => {
    const local = localSnapshot([
        localDefinition('user', 'userStep', 'И пользовательский шаг', 'file:///workspace-a/UserSteps.bsl'),
        localDefinition('export', 'exportScenario', 'Экспортный сценарий', 'file:///workspace-a/exports.feature')
    ]);
    const scenarios = buildScenarioCatalog([
        scenario('Вложенный сценарий', 'file:///workspace-a/nested/scen.yaml', 'nested', ['Пользователь'])
    ]);
    const { resolver } = createHarness({ local, scenarios });

    const view = await resolver.getView(uri('file:///workspace-a/test.feature'));

    assert.deepEqual(new Set(view.all.map(item => item.kind)), new Set([
        'builtInStep',
        'userStep',
        'exportScenario',
        'nestedScenario'
    ]));
    assert.equal(view.all.filter(item => item.kind === 'builtInStep').length, 2);
    assert.equal(view.all.find(item => item.kind === 'nestedScenario')?.definitionLocation?.uri,
        'file:///workspace-a/nested/scen.yaml');
    assert.deepEqual(
        view.all.find(item => item.kind === 'nestedScenario')?.parameters.map(item => item.name),
        ['Пользователь']
    );
});

test('uses resource-specific built-in catalogs while local definitions are unavailable', async () => {
    const catalogs = new Map([
        ['a', catalog('catalog-a', 'A-only')],
        ['b', catalog('catalog-b', 'B-only')]
    ]);
    const { resolver } = createHarness({ catalogs, local: null });

    const first = await resolver.getView(uri('file:///workspace-a/test.feature'));
    const second = await resolver.getView(uri('file:///workspace-b/test.feature'));

    assert.equal(first.all.some(item => item.template.includes('A-only')), true);
    assert.equal(second.all.some(item => item.template.includes('B-only')), true);
    assert.equal(first.all.some(item => item.kind === 'userStep'), false);
    assert.notEqual(first.identity, second.identity);
});

test('retains nested duplicates and reports project versus built-in ambiguity', async () => {
    const duplicateTemplate = 'И общий шаг';
    const catalogs = new Map([['a', catalog('catalog-a', duplicateTemplate)]]);
    const local = localSnapshot([
        localDefinition('local-duplicate', 'userStep', duplicateTemplate, 'file:///workspace-a/UserSteps.bsl')
    ]);
    const scenarios = buildScenarioCatalog([
        scenario('Duplicate nested', 'file:///workspace-a/one/scen.yaml', 'one'),
        scenario('Duplicate nested', 'file:///workspace-a/two/scen.yaml', 'two')
    ]);
    const { resolver } = createHarness({ catalogs, local, scenarios });
    const view = await resolver.getView(uri('file:///workspace-a/test.feature'));

    assert.equal(view.all.filter(item => item.kind === 'nestedScenario').length, 2);
    const resolution = await resolver.resolve(
        uri('file:///workspace-a/test.feature'),
        duplicateTemplate
    );
    assert.equal(resolution.kind, 'ambiguous');
    if (resolution.kind === 'ambiguous') {
        assert.deepEqual(new Set(resolution.matches.map(item => item.definition.kind)), new Set([
            'builtInStep',
            'userStep'
        ]));
    }
});

test('produces deterministic origin labels and identities for reordered nested catalogs', async () => {
    const one = scenario('One', 'file:///workspace-a/one/scen.yaml', 'one');
    const two = scenario('Two', 'file:///workspace-a/two/scen.yaml', 'two');
    const first = createHarness({ scenarios: buildScenarioCatalog([two, one]) });
    const second = createHarness({ scenarios: buildScenarioCatalog([one, two]) });

    const left = await first.resolver.getView(uri('file:///workspace-a/test.feature'));
    const right = await second.resolver.getView(uri('file:///workspace-a/test.feature'));

    assert.equal(left.identity, right.identity);
    assert.deepEqual(
        left.all.filter(item => item.kind === 'nestedScenario').map(item => item.sourceLabel),
        ['Nested scenario (one)', 'Nested scenario (two)']
    );
    assert.equal(left.all.some(item => item.sourceLabel.includes('Vanessa')), true);
});

test('emits view invalidation and rebuilds after a local snapshot change', async () => {
    const initial = localSnapshot([
        localDefinition('one', 'userStep', 'И первый', 'file:///workspace-a/one.bsl')
    ]);
    const next = localSnapshot([
        localDefinition('two', 'userStep', 'И второй', 'file:///workspace-a/two.bsl')
    ]);
    const harness = createHarness({ local: initial });
    const changes: ProjectDefinitionViewChangeEvent[] = [];
    harness.resolver.onDidChangeView(event => changes.push(event));
    await harness.resolver.getView(uri('file:///workspace-a/test.feature'));

    harness.setLocal(next);
    const view = await harness.resolver.getView(uri('file:///workspace-a/test.feature'));

    assert.equal(changes.at(-1)?.reason, 'local');
    assert.equal(changes.at(-1)?.workspaceFolderUri, 'file:///workspace-a');
    assert.equal(view.all.some(item => item.id === 'two'), true);
    assert.equal(view.all.some(item => item.id === 'one'), false);
});
