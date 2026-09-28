import type * as vscode from 'vscode';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { ScenarioCatalogProvider } from './scenarioCatalog';
import {
    buildStepLibrarySnapshot,
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
    readonly resolver: Pick<ProjectDefinitionResolver, 'ensureReady' | 'onDidChangeView'>;
    readonly scenarios: Pick<
        ScenarioCatalogProvider,
        'getScenarioCatalog' | 'onDidUpdateScenarioCatalog'
    >;
}

export class StepLibrarySnapshotService implements vscode.Disposable {
    private readonly invalidationEmitter = new SimpleEmitter<void>();
    private readonly disposables: DisposableLike[] = [];
    private readonly snapshots = new Map<string, StepLibrarySnapshot>();
    private readonly inFlight = new Map<string, Promise<StepLibrarySnapshot>>();
    private generation = 0;

    public readonly onDidInvalidate = this.invalidationEmitter.event as vscode.Event<void>;

    constructor(private readonly dependencies: StepLibrarySnapshotServiceDependencies) {
        this.disposables.push(
            dependencies.resolver.onDidChangeView(() => this.invalidate()),
            dependencies.scenarios.onDidUpdateScenarioCatalog(() => this.invalidate())
        );
    }

    public getCurrent(resource?: vscode.Uri): StepLibrarySnapshot | null {
        return this.snapshots.get(this.cacheKey(resource)) ?? null;
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
        return buildStepLibrarySnapshot(view, scenarios);
    }
}
