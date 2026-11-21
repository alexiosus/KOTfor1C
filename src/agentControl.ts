/** Wait only for a local lease. Once its callback starts, an action is never replayed. */
export async function acquireAgentControl<T>(acquire: (entered: () => void) => Promise<T>, running: () => boolean, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let entered = false;
        try { return await acquire(() => { entered = true; }); }
        catch (error) {
            if (entered || !(error instanceof Error) || error.message !== 'Vanessa is busy. Stop or wait for the current operation.'
                || running() || Date.now() >= deadline) { throw error; }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
}
