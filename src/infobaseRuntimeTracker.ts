import { normalizeInfobaseConnectionIdentity } from './oneCInfobaseConnection';

export interface TrackedInfobaseProcess {
    readonly pid?: number;
    once(event: 'exit' | 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
}

export interface InfobaseRuntimeTrackerLike {
    readonly onDidChange: (
        listener: (runningIdentities: ReadonlySet<string>) => void
    ) => { dispose(): void };
    runningIdentities(): ReadonlySet<string>;
}

export class InfobaseRuntimeTracker implements InfobaseRuntimeTrackerLike {
    private readonly processIdentities = new Map<number, string>();
    private readonly identityProcessIds = new Map<string, Set<number>>();
    private readonly listeners = new Set<(runningIdentities: ReadonlySet<string>) => void>();

    public readonly onDidChange = (
        listener: (runningIdentities: ReadonlySet<string>) => void
    ): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    public runningIdentities(): ReadonlySet<string> {
        return new Set(this.identityProcessIds.keys());
    }

    public track(infobasePath: string, process: TrackedInfobaseProcess): void {
        const pid = process.pid;
        if (!Number.isInteger(pid) || (pid ?? 0) <= 0) {
            return;
        }
        const identity = normalizeInfobaseConnectionIdentity(infobasePath);
        this.remove(pid!);
        this.processIdentities.set(pid!, identity);
        const processIds = this.identityProcessIds.get(identity) ?? new Set<number>();
        processIds.add(pid!);
        this.identityProcessIds.set(identity, processIds);
        let finished = false;
        const finish = (): void => {
            if (finished) {
                return;
            }
            finished = true;
            this.remove(pid!);
            this.fire();
        };
        process.once('exit', finish);
        process.once('error', finish);
        process.once('close', finish);
        this.fire();
    }

    private remove(pid: number): void {
        const identity = this.processIdentities.get(pid);
        if (!identity) {
            return;
        }
        this.processIdentities.delete(pid);
        const processIds = this.identityProcessIds.get(identity);
        processIds?.delete(pid);
        if (!processIds || processIds.size === 0) {
            this.identityProcessIds.delete(identity);
        }
    }

    private fire(): void {
        const identities = this.runningIdentities();
        for (const listener of [...this.listeners]) {
            listener(identities);
        }
    }
}

export const managedInfobaseRuntimeTracker = new InfobaseRuntimeTracker();
