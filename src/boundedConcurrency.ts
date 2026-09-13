export async function mapWithConcurrencyLimit<T, TResult>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError('Concurrency must be a positive integer.');
    }

    const results = new Array<TResult>(items.length);
    let nextIndex = 0;
    let failed = false;
    let firstError: unknown;

    const runWorker = async (): Promise<void> => {
        while (!failed) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) {
                return;
            }

            try {
                results[index] = await mapper(items[index], index);
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
