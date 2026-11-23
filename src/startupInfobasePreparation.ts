import { existsSync, renameSync } from 'node:fs';

const pending = new Map<string, Promise<unknown>>();

/** Template/auth and MCP preparation share one lane per service base. */
export function serializeStartupInfobasePreparation<T>(base: string, work: () => Promise<T>): Promise<T> {
    const next = (pending.get(base) ?? Promise.resolve()).catch(() => undefined).then(work);
    pending.set(base, next);
    const cleanup = () => { if (pending.get(base) === next) { pending.delete(base); } };
    void next.then(cleanup, cleanup);
    return next;
}

/** Publish the restored database and its version marker together. */
export function replaceSharedStartupInfobase(current: string, restored: string, backup: string): void {
    const hadPrevious = existsSync(current);
    if (hadPrevious) { renameSync(current, backup); }
    try { renameSync(restored, current); }
    catch (error) {
        if (hadPrevious) {
            try { renameSync(backup, current); }
            catch (rollbackError) { throw new AggregateError([error, rollbackError], `The previous service infobase is available at ${backup}.`); }
        }
        throw error;
    }
}
