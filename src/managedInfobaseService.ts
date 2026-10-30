import type * as vscode from 'vscode';
import type { ActiveYamlParametersProfile } from './activeYamlParametersProfile';
import { resolveActiveProfileInfobasePath } from './infobaseSidebarModel';
import type { ManagedInfobaseRecord } from './infobaseManager';
import { normalizeInfobaseConnectionIdentity } from './oneCInfobaseConnection';

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

export interface ManagedInfobaseSnapshot {
    readonly revision: number;
    readonly profileId: string;
    readonly profileName: string;
    readonly activeInfobaseIdentity: string | null;
    readonly infobases: readonly ManagedInfobaseRecord[];
}

export interface ManagedInfobaseServiceDependencies {
    readonly loadActiveProfile: () => Promise<ActiveYamlParametersProfile>;
    readonly onDidChangeActiveProfile: vscode.Event<unknown>;
    readonly workspaceRootPath: string | null;
    readonly collect: (
        activeProfileInfobasePath: string | null
    ) => Promise<readonly ManagedInfobaseRecord[]>;
}

function freezeRecord(record: ManagedInfobaseRecord): ManagedInfobaseRecord {
    return Object.freeze({
        ...record,
        roles: Object.freeze([...record.roles]),
        sources: Object.freeze([...record.sources]),
        logTargets: Object.freeze(record.logTargets.map(target => Object.freeze({ ...target })))
    });
}

export class ManagedInfobaseService implements vscode.Disposable {
    private readonly invalidationEmitter = new SimpleEmitter<void>();
    private readonly subscriptions: DisposableLike[] = [];
    private current: ManagedInfobaseSnapshot | null = null;
    private inFlight: Promise<ManagedInfobaseSnapshot> | null = null;
    private generation = 0;
    private revision = 0;

    public readonly onDidInvalidate = this.invalidationEmitter.event as vscode.Event<void>;

    constructor(private readonly dependencies: ManagedInfobaseServiceDependencies) {
        this.subscriptions.push(dependencies.onDidChangeActiveProfile(() => this.invalidate()));
    }

    public getCurrent(): ManagedInfobaseSnapshot | null {
        return this.current;
    }

    public ensureReady(): Promise<ManagedInfobaseSnapshot> {
        if (this.current) {
            return Promise.resolve(this.current);
        }
        if (this.inFlight) {
            return this.inFlight;
        }
        const generation = this.generation;
        const load = this.buildSnapshot().then(snapshot => {
            if (generation === this.generation) {
                this.revision += 1;
                const published = Object.freeze({ ...snapshot, revision: this.revision });
                this.current = published;
                return published;
            }
            return snapshot;
        }).finally(() => {
            if (this.inFlight === load) {
                this.inFlight = null;
            }
        });
        this.inFlight = load;
        return load;
    }

    public refresh(): Promise<ManagedInfobaseSnapshot> {
        this.invalidate();
        return this.ensureReady();
    }

    public dispose(): void {
        this.generation += 1;
        this.current = null;
        this.inFlight = null;
        for (const subscription of this.subscriptions.splice(0)) {
            subscription.dispose();
        }
        this.invalidationEmitter.dispose();
    }

    private invalidate(): void {
        this.generation += 1;
        this.current = null;
        this.inFlight = null;
        this.invalidationEmitter.fire();
    }

    private async buildSnapshot(): Promise<ManagedInfobaseSnapshot> {
        const profile = await this.dependencies.loadActiveProfile();
        const activeInfobasePath = resolveActiveProfileInfobasePath(
            profile,
            this.dependencies.workspaceRootPath
        );
        const records = await this.dependencies.collect(activeInfobasePath);
        return Object.freeze({
            revision: this.revision + 1,
            profileId: profile.id,
            profileName: profile.name,
            activeInfobaseIdentity: activeInfobasePath
                ? normalizeInfobaseConnectionIdentity(activeInfobasePath)
                : null,
            infobases: Object.freeze(records.map(freezeRecord))
        });
    }
}
