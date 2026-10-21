const pending = new Map<string, Promise<unknown>>();

/** Template/auth and MCP preparation share one lane per service base. */
export function serializeStartupInfobasePreparation<T>(base: string, work: () => Promise<T>): Promise<T> {
    const next = (pending.get(base) ?? Promise.resolve()).catch(() => undefined).then(work);
    pending.set(base, next);
    const cleanup = () => { if (pending.get(base) === next) { pending.delete(base); } };
    void next.then(cleanup, cleanup);
    return next;
}
