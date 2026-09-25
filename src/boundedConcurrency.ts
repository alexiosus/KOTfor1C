export class ConcurrencyCancelledError extends Error {
    constructor() {
        super('Concurrent operation was cancelled.');
        this.name = 'ConcurrencyCancelledError';
    }
}

export interface ConcurrencyRunOptions {
    readonly shouldCancel?: () => boolean;
    readonly yieldEvery?: number;
    readonly yieldControl?: () => Promise<void>;
}

export async function runWithConcurrencyLimit<T, TResult>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<TResult>,
    options: ConcurrencyRunOptions = {}
): Promise<TResult[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError('Concurrency must be a positive integer.');
    }

    const results = new Array<TResult>(items.length);
    let nextIndex = 0;
    let failed = false;
    let firstError: unknown;
    let completed = 0;
    const yieldEvery = options.yieldEvery ?? 0;
    const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setImmediate(resolve)));

    const runWorker = async (): Promise<void> => {
        while (!failed) {
            if (options.shouldCancel?.()) {
                failed = true;
                firstError = new ConcurrencyCancelledError();
                return;
            }
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) {
                return;
            }

            try {
                results[index] = await mapper(items[index], index);
                completed += 1;
                if (yieldEvery > 0 && completed % yieldEvery === 0) {
                    await yieldControl();
                }
            } catch (error) {
                if (!failed) {
                    failed = true;
                    firstError = error;
                }
            }
        }
    };

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    if (failed) {
        throw firstError;
    }

    return results;
}

export async function mapWithConcurrencyLimit<T, TResult>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
    return runWithConcurrencyLimit(items, concurrency, mapper);
}

export async function collectTreeWithConcurrencyLimit<TNode, TValue>(
    root: TNode,
    concurrency: number,
    visit: (node: TNode) => Promise<{ children: readonly TNode[]; values: readonly TValue[] }>,
    shouldCancel: () => boolean = () => false
): Promise<TValue[]> {
    const values: TValue[] = [];
    let level: readonly TNode[] = [root];

    while (level.length > 0 && !shouldCancel()) {
        const visited = await mapWithConcurrencyLimit(level, concurrency, node =>
            shouldCancel()
                ? Promise.resolve({ children: [], values: [] })
                : visit(node)
        );
        const nextLevel: TNode[] = [];
        for (const result of visited) {
            values.push(...result.values);
            nextLevel.push(...result.children);
        }
        level = nextLevel;
    }

    return values;
}
