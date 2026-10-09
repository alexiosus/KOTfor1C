import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenarioCatalog, type ScenarioCatalog, type ScenarioCatalogProvider } from '../src/scenarioCatalog';
import {
    ScenarioRelationshipService,
    type ScenarioRelationshipServiceDependencies,
    type ScenarioRelationshipState
} from '../src/scenarioRelationshipService';
import type { TestInfo } from '../src/types';
import type { ProjectDefinition, ProjectDefinitionView } from '../src/projectDefinition';

interface FakeUri {
    readonly scheme: string;
    readonly fsPath: string;
    toString(): string;
}

function uri(fsPath: string): FakeUri {
    return {
        scheme: 'file',
        fsPath,
        toString: () => `file://${fsPath}`
    };
}

function scenario(
    name: string,
    fsPath: string,
    options: { calls?: readonly string[]; phase?: string } = {}
): TestInfo {
    return {
        name,
        relativePath: fsPath.replace(/^\/repo\/?/u, ''),
        yamlFileUri: uri(fsPath) as TestInfo['yamlFileUri'],
        nestedScenarioNames: options.calls ? [...options.calls] : [],
        ...(options.phase ? { tabName: options.phase } : {})
    };
}

function createEvent<T>(): {
    event: ScenarioCatalogProvider['onDidUpdateScenarioCatalog'];
    fire(value: T): void;
} {
    const listeners = new Set<(value: T) => unknown>();
    return {
        event: ((listener: (value: T) => unknown) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        }) as ScenarioCatalogProvider['onDidUpdateScenarioCatalog'],
        fire(value: T): void {
            for (const listener of listeners) {
                listener(value);
            }
        }
    };
}

function createHarness(
    initialCatalog: ScenarioCatalog,
    projectDefinitions?: {
        readonly view: ProjectDefinitionView;
        readonly references: ReadonlyMap<string, readonly { uri: FakeUri }[]>;
    },
    resolveAdditionalScenarioKeysForUri?: (uri: FakeUri) => readonly string[]
): {
    service: ScenarioRelationshipService;
    replaceCatalog(catalog: ScenarioCatalog): void;
    fireConfigurationChanged(): void;
    setConfigurationEnabled(enabled: boolean): void;
    ensureCalls(): number;
    updates: Array<{ key: string; value: unknown; target: unknown }>;
} {
    let catalog = initialCatalog;
    let ensureCallCount = 0;
    let enabled = true;
    const catalogEvent = createEvent<ScenarioCatalog | null>();
    const configurationEvent = createEvent<unknown>();
    const updates: Array<{ key: string; value: unknown; target: unknown }> = [];
    const getConfiguration = () => {
        const snapshot = enabled;
        return {
            get: <T>(_key: string, defaultValue?: T): T => (snapshot as T) ?? defaultValue!,
            update: async (key: string, value: unknown, target?: unknown): Promise<void> => {
                updates.push({ key, value, target });
                enabled = value === true;
            }
        };
    };
    const provider: ScenarioCatalogProvider = {
        getScenarioCatalog: () => catalog,
        ensureFreshScenarioCatalog: async () => {
            ensureCallCount += 1;
            return catalog;
        },
        onDidUpdateScenarioCatalog: catalogEvent.event
    };
    const dependencies: ScenarioRelationshipServiceDependencies = {
        catalogProvider: provider,
        getConfiguration,
        workspaceConfigurationTarget: 'workspace',
        onDidChangeConfiguration: configurationEvent.event,
        getScanRootPaths: () => ({
            scanRootPath: '/repo',
            canonicalScanRootPath: '/repo'
        }),
        ...(resolveAdditionalScenarioKeysForUri ? {
            resolveAdditionalScenarioKeysForUri: value => resolveAdditionalScenarioKeysForUri(value as FakeUri)
        } : {}),
        ...(projectDefinitions ? {
            projectDefinitions: {
                getView: async () => projectDefinitions.view,
                findReferencesForDefinitions: async (definitionIds: readonly string[]) => new Map(
                    definitionIds.map(id => [id, projectDefinitions.references.get(id) ?? []])
                ),
                createUri: (value: string) => uri(value.replace(/^file:\/\//u, '')) as TestInfo['yamlFileUri']
            }
        } : {})
    };

    return {
        service: new ScenarioRelationshipService(dependencies),
        replaceCatalog(nextCatalog: ScenarioCatalog): void {
            catalog = nextCatalog;
            catalogEvent.fire(nextCatalog);
        },
        fireConfigurationChanged(): void {
            configurationEvent.fire(undefined);
        },
        setConfigurationEnabled(nextEnabled: boolean): void {
            enabled = nextEnabled;
        },
        ensureCalls: () => ensureCallCount,
        updates
    };
}

function relationshipCatalog(phase = 'Accounting'): ScenarioCatalog {
    return buildScenarioCatalog([
        scenario('Main', '/repo/Main/scen.yaml', { calls: ['Nested'], phase }),
        scenario('Nested', '/repo/Nested/scen.yaml')
    ]);
}

test('projects the cached catalog for the active editor without forcing a scan', () => {
    const harness = createHarness(relationshipCatalog());
    const states: ScenarioRelationshipState[] = [];
    harness.service.onDidChangeState(state => states.push(state));

    harness.service.handleActiveEditorChanged(uri('/repo/Nested/scen.yaml') as TestInfo['yamlFileUri']);

    assert.equal(harness.ensureCalls(), 0);
    assert.equal(states.length, 1);
    assert.equal(states[0].currentLabel, 'Nested');
    assert.deepEqual(states[0].currentScenarioKeys, ['file:///repo/Nested/scen.yaml']);
    assert.deepEqual(states[0].affectedMainScenarioKeys, ['file:///repo/Main/scen.yaml']);
    assert.deepEqual(states[0].relationships, [{
        scenarioKey: 'file:///repo/Main/scen.yaml',
        incomingDistance: 1
    }]);
});

test('uses the directory index only as a fallback for auxiliary scenario files', () => {
    const harness = createHarness(relationshipCatalog());

    harness.service.handleActiveEditorChanged(
        uri('/repo/Nested/features/generated.feature') as TestInfo['yamlFileUri']
    );

    assert.deepEqual(
        harness.service.getState().currentScenarioKeys,
        ['file:///repo/Nested/scen.yaml']
    );
    assert.equal(harness.service.getState().currentLabel, 'Nested');
});

test('treats a compiled feature URI as an alias of its main scenario', () => {
    const mainKey = 'file:///repo/Main/scen.yaml';
    const harness = createHarness(
        relationshipCatalog(),
        undefined,
        activeUri => activeUri.fsPath === '/runtime/Main.feature' ? [mainKey] : []
    );

    harness.service.handleActiveEditorChanged(
        uri('/runtime/Main.feature') as TestInfo['yamlFileUri']
    );

    assert.deepEqual(harness.service.getState().currentScenarioKeys, [mainKey]);
    assert.deepEqual(harness.service.getState().relationships, [{
        scenarioKey: 'file:///repo/Nested/scen.yaml',
        outgoingDistance: 1
    }]);
    assert.equal(harness.service.getState().currentLabel, 'Main');
});

test('does not emit twice for the same URI and unchanged relationship state', () => {
    const harness = createHarness(relationshipCatalog());
    let eventCount = 0;
    harness.service.onDidChangeState(() => {
        eventCount += 1;
    });
    const activeUri = uri('/repo/Nested/scen.yaml') as TestInfo['yamlFileUri'];

    harness.service.handleActiveEditorChanged(activeUri);
    harness.service.handleActiveEditorChanged(activeUri);

    assert.equal(eventCount, 1);
});

test('catalog replacement rebuilds the projection and increments its revision', () => {
    const harness = createHarness(relationshipCatalog());
    harness.service.handleActiveEditorChanged(
        uri('/repo/Nested/scen.yaml') as TestInfo['yamlFileUri']
    );
    const previousRevision = harness.service.getState().revision;

    harness.replaceCatalog(relationshipCatalog('Sales'));

    assert.ok(harness.service.getState().revision > previousRevision);
    assert.deepEqual(harness.service.getState().affectedPhaseNames, ['Sales']);
});

test('disabling Test Manager highlighting retains the shared relationship projection', async () => {
    const harness = createHarness(relationshipCatalog());
    harness.service.handleActiveEditorChanged(
        uri('/repo/Nested/scen.yaml') as TestInfo['yamlFileUri']
    );

    await harness.service.setEnabled(false);

    assert.equal(harness.service.getState().enabled, false);
    assert.equal(harness.service.getState().currentLabel, 'Nested');
    assert.deepEqual(harness.service.getState().currentScenarioKeys, ['file:///repo/Nested/scen.yaml']);
    assert.deepEqual(harness.service.getState().relationships, [{
        scenarioKey: 'file:///repo/Main/scen.yaml',
        incomingDistance: 1
    }]);
    assert.deepEqual(harness.service.getState().affectedMainScenarioKeys, ['file:///repo/Main/scen.yaml']);
    assert.deepEqual(harness.service.getState().affectedPhaseNames, ['Accounting']);
    assert.deepEqual(harness.updates, [{
        key: 'phaseSwitcher.highlightAffectedMainScenarios',
        value: false,
        target: 'workspace'
    }]);
});

test('connects export definitions to calling scenarios in both directions', async () => {
    const exportDefinition: ProjectDefinition = {
        id: 'export:shared-login',
        kind: 'exportScenario',
        template: 'And use shared login',
        normalizedTemplate: 'And use shared login',
        parameters: [],
        sourceLabel: 'Project exports',
        definitionLocation: {
            uri: 'file:///library/exports.feature',
            range: {
                start: { line: 3, character: 0 },
                end: { line: 3, character: 24 }
            }
        }
    };
    const view: ProjectDefinitionView = {
        identity: 'project-definitions:one',
        all: [exportDefinition],
        byId: new Map([[exportDefinition.id, exportDefinition]]),
        byNormalizedTemplate: new Map([[exportDefinition.normalizedTemplate, [exportDefinition]]])
    };
    const catalog = buildScenarioCatalog([
        scenario('Main', '/repo/Main/scen.yaml', { calls: ['Nested'], phase: 'Accounting' }),
        scenario('Nested', '/repo/Nested/scen.yaml')
    ]);
    const harness = createHarness(catalog, {
        view,
        references: new Map([[exportDefinition.id, [{ uri: uri('/repo/Nested/scen.yaml') }]]])
    });

    harness.service.handleActiveEditorChanged(uri('/library/exports.feature') as TestInfo['yamlFileUri']);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.deepEqual(harness.service.getState().currentDefinitionIds, [exportDefinition.id]);
    assert.deepEqual(harness.service.getState().relationships, [
        { scenarioKey: 'file:///repo/Nested/scen.yaml', incomingDistance: 1 },
        { scenarioKey: 'file:///repo/Main/scen.yaml', incomingDistance: 2 }
    ]);
    assert.deepEqual(harness.service.getState().affectedMainScenarioKeys, ['file:///repo/Main/scen.yaml']);

    harness.service.handleActiveEditorChanged(uri('/repo/Nested/scen.yaml') as TestInfo['yamlFileUri']);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.deepEqual(harness.service.getState().currentScenarioKeys, ['file:///repo/Nested/scen.yaml']);
    assert.deepEqual(harness.service.getState().definitionRelationships, [{
        definitionId: exportDefinition.id,
        outgoingDistance: 1
    }]);
});

test('configuration events synchronize externally changed toggle state', () => {
    const harness = createHarness(relationshipCatalog());
    harness.service.handleActiveEditorChanged(
        uri('/repo/Nested/scen.yaml') as TestInfo['yamlFileUri']
    );

    void harness.service.setEnabled(false);
    harness.fireConfigurationChanged();

    assert.equal(harness.service.getState().enabled, false);
});

test('configuration events re-read a fresh snapshot for Test Manager highlighting', () => {
    const harness = createHarness(relationshipCatalog());

    harness.setConfigurationEnabled(false);
    harness.fireConfigurationChanged();
    assert.equal(harness.service.getState().enabled, false);

    harness.setConfigurationEnabled(true);
    harness.fireConfigurationChanged();
    assert.equal(harness.service.getState().enabled, true);
});
