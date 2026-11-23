export class VanessaControlBusyError extends Error {
    constructor() { super('Vanessa is busy. Stop or wait for the current operation.'); }
}

/** Wait only for a local lease. Once its callback starts, an action is never replayed. */
export async function acquireVanessaControl<T>(acquire: (entered: () => void) => Promise<T>, cannotWait: () => boolean, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let entered = false;
        try { return await acquire(() => { entered = true; }); }
        catch (error) {
            if (entered || !(error instanceof VanessaControlBusyError) || cannotWait() || Date.now() >= deadline) { throw error; }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
}
