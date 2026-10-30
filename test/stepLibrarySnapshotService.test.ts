import assert from 'node:assert/strict';
import test from 'node:test';
import { StepLibrarySnapshotService } from '../src/stepLibrarySnapshotService';
import type { ProjectDefinitionView } from '../src/projectDefinition';
import type { ScenarioCatalog } from '../src/scenarioCatalog';
import type { TestInfo } from '../src/types';
import type { ProjectGroup } from '../src/projectLibraryStore';
import { StepLibrarySidebarIndex } from '../src/stepLibrarySidebarModel';

interface Disposable {
    dispose(): void;
}

class EventHub<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void): Disposable => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }
}

function view(identity: string): ProjectDefinitionView {
    return {
        identity,
        all: [],
        byId: new Map(),
        byNormalizedTemplate: new Map()
    };
}

function emptyCatalog(): ScenarioCatalog {
    return {
        all: [],
        byName: new Map(),
        byUri: new Map(),
        primaryByName: new Map()
    };
}

function mainScenarioCatalog(): ScenarioCatalog {
    const uri = {
        scheme: 'file',
        fsPath: '/workspace/004_Production/scen.yaml',
        toString: () => 'file:///workspace/004_Production/scen.yaml'
    } as TestInfo['yamlFileUri'];
    const scenario: TestInfo = {
        name: '004_Production',
        tabName: 'Production',
        relativePath: 'Production/004_Production',
        yamlFileUri: uri
    };
    return {
        all: [scenario],
        byName: new Map([[scenario.name, [scenario]]]),
        byUri: new Map([[uri.toString(), scenario]]),
        primaryByName: new Map([[scenario.name, scenario]])
    };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

test('shared snapshots search authored attachments without a build and refresh after file invalidation', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    const attachmentChanges = new EventHub<unknown>();
    let attachmentPaths: readonly string[] = ['Fixtures/Данные.MXL'];
    const service = new StepLibrarySnapshotService({
        resolver: { ensureReady: async () => view('stable'), onDidChangeView: resolverChanges.event },
        scenarios: { getScenarioCatalog: () => mainScenarioCatalog(), onDidUpdateScenarioCatalog: scenarioChanges.event }
    });
    service.attachScenarioFilesService({
        listAttachmentPaths: async () => attachmentPaths,
        onDidInvalidate: attachmentChanges.event
    });
    const first = await service.ensureReady();
    assert.deepEqual(first.items[0].attachmentPaths, ['Fixtures/Данные.MXL']);
    assert.equal(StepLibrarySidebarIndex.fromSnapshot(first, 'en').search('данные.mxl')[0]?.itemId, first.items[0].id);
    const protocol = require('../media/stepLibraryProtocol.js') as { searchItems(items: unknown[], query: string): Array<{ id: string }> };
    assert.equal(protocol.searchItems([...first.items], 'данные.mxl')[0]?.id, first.items[0].id);
    const oldId = first.items[0].id;
    attachmentPaths = ['Replacement.csv'];
    attachmentChanges.fire({});
    const second = await service.ensureReady();
    assert.notEqual(first.viewIdentity, second.viewIdentity);
    assert.equal(second.items[0].id, oldId);
    assert.equal(StepLibrarySidebarIndex.fromSnapshot(second, 'en').search('данные.mxl').length, 0);
    assert.equal(StepLibrarySidebarIndex.fromSnapshot(second, 'en').search('replacement.csv')[0]?.itemId, oldId);
    service.dispose();
});

test('project-group changes invalidate snapshots without requiring any scenario or definition identity change', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    const catalog = mainScenarioCatalog();
    let groups: readonly ProjectGroup[] = [{ id: 'production', name: 'Production', sections: ['main'], order: 0 }];
    const service = new StepLibrarySnapshotService({
        resolver: { ensureReady: async () => view('stable-definitions'), onDidChangeView: resolverChanges.event },
        scenarios: {
            getScenarioCatalog: () => catalog, onDidUpdateScenarioCatalog: scenarioChanges.event,
            getProjectScenarioGroups: async () => groups
        }
    });
    const first = await service.ensureReady();
    assert.deepEqual(first.scenarioGroups, groups);
    groups = [...groups, { id: 'empty-processes', name: 'Future processes', sections: ['process'], order: 1 }];
    scenarioChanges.fire(catalog);
    const second = await service.ensureReady();
    assert.notEqual(second.viewIdentity, first.viewIdentity);
    assert.equal(second.items[0].id, first.items[0].id);
    assert.equal(second.items[0].scenarioKey, first.items[0].scenarioKey);
    assert.deepEqual(second.scenarioGroups, groups);
    service.dispose();
});

test('coalesces concurrent snapshot loads and reuses the resource cache', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    const pending = deferred<ProjectDefinitionView>();
    let calls = 0;
    const service = new StepLibrarySnapshotService({
        resolver: {
            ensureReady: async () => {
                calls += 1;
                return pending.promise;
            },
            onDidChangeView: resolverChanges.event
        },
        scenarios: {
            getScenarioCatalog: emptyCatalog,
            onDidUpdateScenarioCatalog: scenarioChanges.event
        }
    });
    const resource = { toString: () => 'file:///workspace/test.feature' } as never;

    const first = service.ensureReady(resource);
    const second = service.ensureReady(resource);
    assert.equal(calls, 1);
    pending.resolve(view('view:one'));

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    assert.equal(firstSnapshot, secondSnapshot);
    assert.equal(await service.ensureReady(resource), firstSnapshot);
    assert.equal(service.getCurrent(resource), firstSnapshot);
    assert.equal(calls, 1);
    service.dispose();
});

test('resolver and scenario changes invalidate lazily without rebuilding', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    let calls = 0;
    const service = new StepLibrarySnapshotService({
        resolver: {
            ensureReady: async () => view(`view:${++calls}`),
            onDidChangeView: resolverChanges.event
        },
        scenarios: {
            getScenarioCatalog: emptyCatalog,
            onDidUpdateScenarioCatalog: scenarioChanges.event
        }
    });
    let invalidations = 0;
    service.onDidInvalidate(() => {
        invalidations += 1;
    });

    await service.ensureReady();
    resolverChanges.fire({});
    assert.equal(calls, 1);
    assert.equal(service.getCurrent(), null);
    assert.equal(invalidations, 1);

    await service.ensureReady();
    scenarioChanges.fire(emptyCatalog());
    assert.equal(calls, 2);
    assert.equal(service.getCurrent(), null);
    assert.equal(invalidations, 2);
    service.dispose();
});

test('an invalidated in-flight generation is not published into the cache', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    const first = deferred<ProjectDefinitionView>();
    let calls = 0;
    const service = new StepLibrarySnapshotService({
        resolver: {
            ensureReady: async () => {
                calls += 1;
                return calls === 1 ? first.promise : view('view:new');
            },
            onDidChangeView: resolverChanges.event
        },
        scenarios: {
            getScenarioCatalog: emptyCatalog,
            onDidUpdateScenarioCatalog: scenarioChanges.event
        }
    });

    const staleLoad = service.ensureReady();
    service.invalidate();
    first.resolve(view('view:stale'));
    assert.equal((await staleLoad).viewIdentity, 'view:stale');
    assert.equal(service.getCurrent(), null);
    assert.equal((await service.ensureReady()).viewIdentity, 'view:new');
    service.dispose();
});

test('compiled artifact changes enrich and invalidate main scenario snapshots', async () => {
    const resolverChanges = new EventHub<unknown>();
    const scenarioChanges = new EventHub<ScenarioCatalog | null>();
    const artifactChanges = new EventHub<void>();
    const scenarioKey = 'file:///workspace/004_Production/scen.yaml';
    let compiled = new Map<string, { featureUri: string; filesRootUri: string }>();
    const service = new StepLibrarySnapshotService({
        resolver: {
            ensureReady: async () => view('view:compiled'),
            onDidChangeView: resolverChanges.event
        },
        scenarios: {
            getScenarioCatalog: mainScenarioCatalog,
            onDidUpdateScenarioCatalog: scenarioChanges.event,
            getCompiledScenarioResources: async () => compiled,
            onDidChangeScenarioArtifacts: artifactChanges.event
        }
    } as ConstructorParameters<typeof StepLibrarySnapshotService>[0]);

    assert.equal((await service.ensureReady()).items[0]?.hasScenarioFiles, true);

    compiled = new Map([[scenarioKey, {
        featureUri: 'file:///build/004_Production.feature',
        filesRootUri: 'file:///build/004_Production/%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B'
    }]]);
    artifactChanges.fire();
    const item = (await service.ensureReady()).items[0];

    assert.equal(item?.compiledFeatureUri, 'file:///build/004_Production.feature');
    assert.equal(item?.hasScenarioFiles, true);
    service.dispose();
});
