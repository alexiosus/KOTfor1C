import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ScenarioRelationshipPresentationService,
    type ScenarioRelationshipSurface
} from '../src/scenarioRelationshipPresentation';

class EventHub<T> {
    private readonly listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }
}

function createHarness(values: Record<string, boolean> = {}) {
    const changes = new EventHub<{ affectsConfiguration(section: string): boolean }>();
    const updates: Array<{ key: string; value: unknown; target: unknown }> = [];
    const service = new ScenarioRelationshipPresentationService({
        getConfiguration: () => ({
            get: <T>(key: string, fallback?: T): T => (values[key] as T | undefined) ?? fallback!,
            update: async (key: string, value: unknown, target?: unknown) => {
                values[key] = value === true;
                updates.push({ key, value, target });
            }
        }),
        workspaceConfigurationTarget: 'workspace',
        onDidChangeConfiguration: changes.event
    });
    return { service, changes, updates, values };
}

test('keeps Test Manager and Library relationship modes independent', async () => {
    const harness = createHarness({
        'phaseSwitcher.highlightAffectedMainScenarios': true,
        'phaseSwitcher.filterRelatedScenarios': false,
        'stepLibrary.highlightScenarioRelationships': false,
        'stepLibrary.filterRelatedScenarios': true
    });

    assert.deepEqual(harness.service.getMode('testManager'), { highlight: true, filter: false });
    assert.deepEqual(harness.service.getMode('stepLibrary'), { highlight: false, filter: true });
    assert.equal(harness.service.isActive('testManager'), true);
    assert.equal(harness.service.isActive('stepLibrary'), true);

    await harness.service.setMode('testManager', { highlight: false, filter: false });

    assert.deepEqual(harness.service.getMode('testManager'), { highlight: false, filter: false });
    assert.deepEqual(harness.service.getMode('stepLibrary'), { highlight: false, filter: true });
    assert.deepEqual(harness.updates, [
        { key: 'phaseSwitcher.highlightAffectedMainScenarios', value: false, target: 'workspace' },
        { key: 'phaseSwitcher.filterRelatedScenarios', value: false, target: 'workspace' }
    ]);
});

test('emits only for the panel whose relationship settings changed', () => {
    const harness = createHarness();
    const surfaces: ScenarioRelationshipSurface[] = [];
    harness.service.onDidChangeMode(event => surfaces.push(event.surface));

    harness.changes.fire({
        affectsConfiguration: section => section === 'kotTestToolkit.stepLibrary.filterRelatedScenarios'
    });
    harness.changes.fire({
        affectsConfiguration: section => section === 'kotTestToolkit.editor.unrelated'
    });

    assert.deepEqual(surfaces, ['stepLibrary']);
});

test('toggles one Library relationship option immediately and restores it from configuration', async () => {
    const values = {
        'stepLibrary.highlightScenarioRelationships': true,
        'stepLibrary.filterRelatedScenarios': false
    };
    const harness = createHarness(values);

    await harness.service.toggleMode('stepLibrary', 'filter');

    assert.deepEqual(harness.updates, [{
        key: 'stepLibrary.filterRelatedScenarios',
        value: true,
        target: 'workspace'
    }]);
    assert.deepEqual(harness.service.getMode('stepLibrary'), { highlight: true, filter: true });

    const restored = createHarness(values);
    assert.deepEqual(restored.service.getMode('stepLibrary'), { highlight: true, filter: true });
});

test('re-reads snapshot configuration so a second menu click disables the filter', async () => {
    const changes = new EventHub<{ affectsConfiguration(section: string): boolean }>();
    const values: Record<string, boolean> = {
        'stepLibrary.highlightScenarioRelationships': true,
        'stepLibrary.filterRelatedScenarios': false
    };
    const updates: boolean[] = [];
    const getConfiguration = () => {
        const snapshot = { ...values };
        return {
            get: <T>(key: string, fallback?: T): T => (snapshot[key] as T | undefined) ?? fallback!,
            update: async (key: string, value: unknown) => {
                values[key] = value === true;
                updates.push(value === true);
                changes.fire({
                    affectsConfiguration: section => section === `kotTestToolkit.${key}`
                });
            }
        };
    };
    const dependencies = {
        getConfiguration,
        workspaceConfigurationTarget: 'workspace',
        onDidChangeConfiguration: changes.event
    };
    const service = new ScenarioRelationshipPresentationService(dependencies);
    const publishedFilterStates: boolean[] = [];
    service.onDidChangeMode(event => {
        if (event.surface === 'stepLibrary') {
            publishedFilterStates.push(event.mode.filter);
        }
    });

    await service.toggleMode('stepLibrary', 'filter');
    await service.toggleMode('stepLibrary', 'filter');

    assert.deepEqual(updates, [true, false]);
    assert.deepEqual(publishedFilterStates, [true, false]);
    assert.equal(service.getMode('stepLibrary').filter, false);
});
