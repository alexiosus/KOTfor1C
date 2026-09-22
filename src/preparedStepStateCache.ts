export class PreparedStepStateCache<T> {
    private readonly values = new Map<string, T>();

    public constructor(private readonly maxEntries = 8) {
        if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
            throw new Error('Prepared step state cache capacity must be a positive integer.');
        }
    }

    public getOrCreate(identity: string, factory: () => T): T {
        const existing = this.values.get(identity);
        if (existing !== undefined) {
            this.values.delete(identity);
            this.values.set(identity, existing);
            return existing;
        }

        const value = factory();
        this.values.set(identity, value);
        if (this.values.size > this.maxEntries) {
            const oldestIdentity = this.values.keys().next().value;
            if (typeof oldestIdentity === 'string') {
                this.values.delete(oldestIdentity);
            }
        }
        return value;
    }

    public delete(identity: string): void {
        this.values.delete(identity);
    }

    public clear(): void {
        this.values.clear();
    }
}
