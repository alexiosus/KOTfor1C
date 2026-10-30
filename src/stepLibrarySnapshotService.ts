import type * as vscode from 'vscode';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { ScenarioCatalogProvider } from './scenarioCatalog';
import type { StandaloneFeatureService } from './standaloneFeatureService';
import type { ProjectGroup } from './projectLibraryStore';
import { createHash } from 'node:crypto';
import type { ScenarioFilesService } from './scenarioFilesService';
import {
    buildStepLibrarySnapshot,
    type CompiledScenarioResources,
    type StepLibrarySnapshot
} from './stepLibraryModel';

interface DisposableLike {
    dispose(): void;
}

class SimpleEmitter<T> implements DisposableLike {
    private readonly listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void): DisposableLike => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}

export interface StepLibrarySnapshotServiceDependencies {
    readonly standaloneFeatures?: Pick<StandaloneFeatureService, 'ensureReady' | 'onDidChange'>;
    readonly resolver: Pick<ProjectDefinitionResolver, 'ensureReady' | 'onDidChangeView'>;
    readonly scenarios: Pick<
        ScenarioCatalogProvider,
        'getScenarioCatalog' | 'onDidUpdateScenarioCatalog'
    > & {
        readonly getCompiledScenarioResources?: (
            resource?: vscode.Uri
        ) => Promise<ReadonlyMap<string, CompiledScenarioResources>>;
        readonly onDidChangeScenarioArtifacts?: vscode.Event<void>;
        readonly getProjectScenarioGroups?: () => Promise<readonly ProjectGroup[]>;
    };
}

export class StepLibrarySnapshotService implements vscode.Disposable {
    private readonly invalidationEmitter = new SimpleEmitter<void>();
    private readonly disposables: DisposableLike[] = [];
    private readonly snapshots = new Map<string, StepLibrarySnapshot>();
    private readonly inFlight = new Map<string, Promise<StepLibrarySnapshot>>();
    private generation = 0;
    private scenarioFilesService?: Pick<ScenarioFilesService, 'listAttachmentPaths' | 'onDidInvalidate'>;
    private scenarioFilesSubscription?: DisposableLike;

    public readonly onDidInvalidate = this.invalidationEmitter.event as vscode.Event<void>;

    constructor(private readonly dependencies: StepLibrarySnapshotServiceDependencies) {
        this.disposables.push(
            dependencies.resolver.onDidChangeView(() => this.invalidate()),
            dependencies.scenarios.onDidUpdateScenarioCatalog(() => this.invalidate())
        );
        if (dependencies.scenarios.onDidChangeScenarioArtifacts) {
            this.disposables.push(
                dependencies.scenarios.onDidChangeScenarioArtifacts(() => this.invalidate())
            );
        }
        if (dependencies.standaloneFeatures) {
            this.disposables.push(dependencies.standaloneFeatures.onDidChange(() => this.invalidate()));
        }
    }

    public getCurrent(resource?: vscode.Uri): StepLibrarySnapshot | null {
        return this.snapshots.get(this.cacheKey(resource)) ?? null;
    }

    public attachScenarioFilesService(service: NonNullable<StepLibrarySnapshotService['scenarioFilesService']>): void {
        this.scenarioFilesSubscription?.dispose();
        this.scenarioFilesService = service;
        this.scenarioFilesSubscription = service.onDidInvalidate(() => this.invalidate());
        this.invalidate();
    }

    public ensureReady(resource?: vscode.Uri): Promise<StepLibrarySnapshot> {
        const key = this.cacheKey(resource);
        const current = this.snapshots.get(key);
        if (current) {
            return Promise.resolve(current);
        }
        const activeLoad = this.inFlight.get(key);
        if (activeLoad) {
            return activeLoad;
        }

        const loadGeneration = this.generation;
        const load = this.buildSnapshot(resource).then(snapshot => {
            if (loadGeneration === this.generation) {
                this.snapshots.set(key, snapshot);
            }
            return snapshot;
        }).finally(() => {
            if (this.inFlight.get(key) === load) {
                this.inFlight.delete(key);
            }
        });
        this.inFlight.set(key, load);
        return load;
    }

    public invalidate(): void {
        this.generation += 1;
        this.snapshots.clear();
        this.inFlight.clear();
        this.invalidationEmitter.fire();
    }

    public dispose(): void {
        this.generation += 1;
        this.snapshots.clear();
        this.inFlight.clear();
        this.scenarioFilesSubscription?.dispose();
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        this.invalidationEmitter.dispose();
    }

    private cacheKey(resource?: vscode.Uri): string {
        return resource?.toString() ?? '\0workspace';
    }

    private async buildSnapshot(resource?: vscode.Uri): Promise<StepLibrarySnapshot> {
        const view = await this.dependencies.resolver.ensureReady(resource);
        const scenarios = this.dependencies.scenarios.getScenarioCatalog()?.all ?? [];
        const compiledResources = await this.dependencies.scenarios.getCompiledScenarioResources?.(resource)
            ?? new Map<string, CompiledScenarioResources>();
        const standalone = await this.dependencies.standaloneFeatures?.ensureReady();
        const scenarioGroups = await this.dependencies.scenarios.getProjectScenarioGroups?.();
        const snapshot = buildStepLibrarySnapshot(view, scenarios, compiledResources, standalone, scenarioGroups);
        if (!this.scenarioFilesService) {
            return snapshot;
        }
        const items = await Promise.all(snapshot.items.map(async item => {
            if (item.kind !== 'nestedScenario' && item.kind !== 'mainScenario' && item.kind !== 'process') {
                return item;
            }
            const attachmentPaths = await this.scenarioFilesService!.listAttachmentPaths(item).catch(() => Object.freeze([]));
            return Object.freeze({
                ...item,
                attachmentPaths,
                searchText: [item.searchText, ...attachmentPaths].join(' ').normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim()
            });
        }));
        const attachmentIdentity = createHash('sha256').update(JSON.stringify(items.map(item => [item.id, item.attachmentPaths ?? []])), 'utf8').digest('hex');
        return Object.freeze({ ...snapshot, viewIdentity: `${snapshot.viewIdentity}\0attachments:${attachmentIdentity}`, items: Object.freeze(items) });
    }
}
