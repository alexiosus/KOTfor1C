import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenarioCatalog, type ScenarioCatalog, type ScenarioCatalogProvider } from '../src/scenarioCatalog';
import {
    ScenarioRelationshipService,
    type ScenarioRelationshipServiceDependencies,
    type ScenarioRelationshipState
} from '../src/scenarioRelationshipService';
import type { TestInfo } from '../src/types';

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

function createHarness(initialCatalog: ScenarioCatalog): {
    service: ScenarioRelationshipService;
    replaceCatalog(catalog: ScenarioCatalog): void;
    fireConfigurationChanged(): void;
    ensureCalls(): number;
    updates: Array<{ key: string; value: unknown; target: unknown }>;
} {
    let catalog = initialCatalog;
    let ensureCallCount = 0;
    let enabled = true;
    const catalogEvent = createEvent<ScenarioCatalog | null>();
    const configurationEvent = createEvent<unknown>();
    const updates: Array<{ key: string; value: unknown; target: unknown }> = [];
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
        configuration: {
            get: <T>(_key: string, defaultValue?: T): T => (enabled as T) ?? defaultValue!,
            update: async (key: string, value: unknown, target?: unknown): Promise<void> => {
                updates.push({ key, value, target });
                enabled = value === true;
            }
        },
        workspaceConfigurationTarget: 'workspace',
        onDidChangeConfiguration: configurationEvent.event,
        getScanRootPaths: () => ({
            scanRootPath: '/repo',
            canonicalScanRootPath: '/repo'
        })
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

test('disabled state retains current identity but clears relationship projection', async () => {
    const harness = createHarness(relationshipCatalog());
    harness.service.handleActiveEditorChanged(
        uri('/repo/Nested/scen.yaml') as TestInfo['yamlFileUri']
    );

    await harness.service.setEnabled(false);

    assert.equal(harness.service.getState().enabled, false);
    assert.equal(harness.service.getState().currentLabel, 'Nested');
    assert.deepEqual(harness.service.getState().currentScenarioKeys, ['file:///repo/Nested/scen.yaml']);
    assert.deepEqual(harness.service.getState().relationships, []);
    assert.deepEqual(harness.service.getState().affectedMainScenarioKeys, []);
    assert.deepEqual(harness.service.getState().affectedPhaseNames, []);
    assert.deepEqual(harness.updates, [{
        key: 'phaseSwitcher.highlightAffectedMainScenarios',
        value: false,
        target: 'workspace'
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
