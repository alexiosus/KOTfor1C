export type TestManagerStatusFilter = 'all' | 'built' | 'running';

export interface TestManagerStatusFilterChangeEvent {
    readonly mode: TestManagerStatusFilter;
}

export interface TestManagerStatusFilterStorage {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

interface DisposableLike {
    dispose(): void;
}

const STORAGE_KEY = 'testManager.statusFilter';

export function normalizeTestManagerStatusFilter(value: unknown): TestManagerStatusFilter {
    return value === 'built' || value === 'running' ? value : 'all';
}

export class TestManagerStatusFilterService implements DisposableLike {
    private mode: TestManagerStatusFilter;
    private transitionQueue: Promise<void> = Promise.resolve();
    private readonly listeners = new Set<(
        event: TestManagerStatusFilterChangeEvent
    ) => unknown>();

    public readonly onDidChangeMode = (
        listener: (event: TestManagerStatusFilterChangeEvent) => unknown
    ): DisposableLike => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    public constructor(private readonly storage: TestManagerStatusFilterStorage) {
        this.mode = normalizeTestManagerStatusFilter(storage.get<unknown>(STORAGE_KEY));
    }

    public getMode(): TestManagerStatusFilter {
        return this.mode;
    }

    public isActive(): boolean {
        return this.mode !== 'all';
    }

    public setMode(mode: TestManagerStatusFilter): Promise<void> {
        const nextMode = normalizeTestManagerStatusFilter(mode);
        const transition = this.transitionQueue.then(async () => {
            if (this.mode === nextMode) {
                return;
            }
            await this.storage.update(STORAGE_KEY, nextMode);
            this.mode = nextMode;
            const event = Object.freeze({ mode: nextMode });
            for (const listener of [...this.listeners]) {
                listener(event);
            }
        });
        this.transitionQueue = transition.catch(() => undefined);
        return transition;
    }

    public dispose(): void {
        this.listeners.clear();
    }
}
