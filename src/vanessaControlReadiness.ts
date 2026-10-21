import { setTimeout as delay } from 'node:timers/promises';

/** Wait only for transport readiness; cancellation never closes the external 1C process. */
export async function awaitVanessaControlReady(connect: () => Promise<void>, signal: AbortSignal, options: { timeoutMs?: number; retryMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
        signal.throwIfAborted();
        try {
            await connect();
            signal.throwIfAborted();
            return;
        } catch {
            signal.throwIfAborted();
        }
        await delay(Math.min(options.retryMs ?? 750, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
    signal.throwIfAborted();
    throw new Error('Vanessa MCP did not become ready. Check the 1C window for component or extension messages, then attach again.');
}
