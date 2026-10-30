import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeVanessaControlEndpoint } from './vanessaControlProtocol';

export type VanessaControlTransportErrorCode = 'timeout' | 'cancelled' | 'disconnected' | 'notConnected' | 'failed';
export class VanessaControlTransportError extends Error {
    constructor(public readonly code: VanessaControlTransportErrorCode) {
        // SDK/server exceptions may contain endpoint credentials or business values.
        super(`Vanessa MCP request ${code}.`);
        this.name = 'VanessaControlTransportError';
    }
}

export interface VanessaControlTransport {
    initialize(endpoint: string, signal?: AbortSignal): Promise<{ name: string; version: string }>;
    listTools(signal?: AbortSignal): Promise<readonly Tool[]>;
    callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, onProgress?: (value: VanessaControlProgress) => void): Promise<CallToolResult>;
    dispose(): Promise<void>;
}

export interface VanessaControlProgress { readonly completed: number; readonly total?: number }

interface Connection { readonly client: Client; readonly lifetime: AbortController; ready: boolean }
export interface VanessaControlHttpTransportOptions {
    readonly timeoutMs?: number;
    readonly initializeTimeoutMs?: number;
    readonly allowRemote?: boolean;
    readonly bearerToken?: string;
    readonly fetch?: typeof fetch;
}

/** One MCP connection. Session-level mutation serialization belongs above this transport. */
export class VanessaControlHttpTransport implements VanessaControlTransport {
    private connection?: Connection;
    private generation = 0;
    private readonly requestScope = new AsyncLocalStorage<AbortSignal>();
    private readonly timeoutMs: number;

    constructor(private readonly options: VanessaControlHttpTransportOptions = {}) {
        this.timeoutMs = options.timeoutMs ?? 30_000;
        if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) { throw new Error('A positive MCP timeout is required.'); }
    }

    async initialize(endpoint: string, signal?: AbortSignal): Promise<{ name: string; version: string }> {
        const url = normalizeVanessaControlEndpoint(endpoint, this.options.allowRemote);
        const closing = this.dispose();
        const generation = this.generation;
        await closing;
        if (this.generation !== generation) { throw new VanessaControlTransportError('disconnected'); }
        const client = new Client({ name: 'kot-test-toolkit', version: '3.0.0' }, {
            versionNegotiation: { mode: 'legacy' }, listMaxPages: 64
        });
        const connection: Connection = { client, lifetime: new AbortController(), ready: false };
        this.connection = connection;
        client.onclose = () => {
            connection.lifetime.abort('disconnected');
            if (this.connection === connection) { this.connection = undefined; }
        };
        const fetcher = this.options.fetch ?? globalThis.fetch;
        const wire = new StreamableHTTPClientTransport(new URL(url), {
            fetch: (input, init) => {
                // Legacy MCP cancellation does not abort the SDK's per-POST HTTP stream.
                // Scope requests only: shared GET and cancellation notifications stay alive.
                const scoped = this.requestScope.getStore();
                const message = init?.method === 'POST' && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
                const signal = scoped && message && Object.hasOwn(message, 'id')
                    ? AbortSignal.any([scoped, ...(init?.signal ? [init.signal] : [])]) : init?.signal;
                return fetcher(input, { ...init, signal, redirect: 'error' });
            },
            requestInit: this.options.bearerToken ? { headers: { Authorization: `Bearer ${this.options.bearerToken}` } } : undefined,
            reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1_000, initialReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 }
        });
        try {
            const timeout = this.options.initializeTimeoutMs ?? this.timeoutMs;
            await this.request(connection, signal, combined => client.connect(wire, { signal: combined, timeout }), timeout);
            const server = client.getServerVersion();
            if (!server) { throw new VanessaControlTransportError('failed'); }
            connection.ready = true;
            return { name: server.name, version: server.version };
        } catch (error) {
            if (this.connection === connection) { await this.dispose(); }
            throw error;
        }
    }

    async listTools(signal?: AbortSignal): Promise<readonly Tool[]> {
        const connection = this.requireConnection();
        const timeout = Math.min(this.timeoutMs, 10_000);
        return this.request(connection, signal, async combined => {
            // The pinned SDK aggregates pagination with listMaxPages as a hard bound.
            const result = await connection.client.listTools(undefined, { signal: combined, timeout, cacheMode: 'refresh' });
            return result.tools;
        }, timeout);
    }

    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, onProgress?: (value: VanessaControlProgress) => void): Promise<CallToolResult> {
        const connection = this.requireConnection();
        const timeout = ['run_scenario', 'execute_feature_step'].includes(name) ? this.timeoutMs
            : ['manage_test_client', 'close_test_client', 'get_form_analysis'].includes(name) ? Math.min(this.timeoutMs, 120_000) : Math.min(this.timeoutMs, 30_000);
        return this.request(connection, signal, combined => connection.client.callTool({ name, arguments: args },
            { signal: combined, timeout, onprogress: onProgress ? value => {
                if (combined.aborted || this.connection !== connection || !Number.isFinite(value.progress) || value.progress < 0) { return; }
                onProgress(Object.freeze({ completed: value.progress,
                    ...(typeof value.total === 'number' && Number.isFinite(value.total) && value.total >= value.progress ? { total: value.total } : {}) }));
            } : undefined }), timeout);
    }

    async dispose(): Promise<void> {
        const connection = this.connection;
        this.connection = undefined;
        this.generation++;
        if (connection) {
            connection.lifetime.abort('disconnected');
            await connection.client.close().catch(() => undefined);
        }
    }

    private requireConnection(): Connection {
        if (!this.connection?.ready) { throw new VanessaControlTransportError('notConnected'); }
        return this.connection;
    }

    private async request<T>(connection: Connection, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
        const controller = new AbortController();
        const cancel = () => controller.abort('cancelled');
        const disconnect = () => controller.abort('disconnected');
        signal?.addEventListener('abort', cancel, { once: true });
        connection.lifetime.signal.addEventListener('abort', disconnect, { once: true });
        if (signal?.aborted) { cancel(); }
        if (connection.lifetime.signal.aborted) { disconnect(); }
        const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
        let rejectAborted: () => void = () => undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectAborted = () => reject(new VanessaControlTransportError(controller.signal.reason));
            controller.signal.addEventListener('abort', rejectAborted, { once: true });
            if (controller.signal.aborted) { rejectAborted(); }
        });
        try {
            const result = await Promise.race([aborted, Promise.resolve().then(() => {
                if (controller.signal.aborted) { throw new VanessaControlTransportError(controller.signal.reason); }
                return this.requestScope.run(controller.signal, () => work(controller.signal));
            })]);
            if (this.connection !== connection) { throw new VanessaControlTransportError('disconnected'); }
            return result;
        } catch (error) {
            if (error instanceof VanessaControlTransportError) { throw error; }
            if (controller.signal.aborted) { throw new VanessaControlTransportError(controller.signal.reason); }
            throw new VanessaControlTransportError('failed');
        } finally {
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', rejectAborted);
            signal?.removeEventListener('abort', cancel);
            connection.lifetime.signal.removeEventListener('abort', disconnect);
        }
    }
}
