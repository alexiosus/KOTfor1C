export interface PreparedFileWrite<T> {
    key: T;
    before: string;
    after: string;
}

export async function applyPreparedFileWrites<T>(
    writes: readonly PreparedFileWrite<T>[],
    write: (key: T, content: string) => Promise<void>
): Promise<number> {
    const attempted: PreparedFileWrite<T>[] = [];
    try {
        for (const item of writes) {
            if (item.before === item.after) {
                continue;
            }
            attempted.push(item);
            await write(item.key, item.after);
        }
        return attempted.length;
    } catch (originalError) {
        const rollbackErrors: unknown[] = [];
        for (const item of attempted.reverse()) {
            try {
                await write(item.key, item.before);
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        if (rollbackErrors.length > 0) {
            throw new AggregateError(
                [originalError, ...rollbackErrors],
                'Prepared file write failed and rollback was incomplete'
            );
        }
        throw originalError;
    }
}
