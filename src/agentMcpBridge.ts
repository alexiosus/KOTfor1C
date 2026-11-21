import * as fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Credentials are read locally; the agent configuration contains only a file path. */
export async function runAgentMcpBridge(connectionFile: string, input: Readable, output: Writable): Promise<void> {
    let session: string | undefined; let protocol: string | undefined; let identity: string | undefined;
    let activeEndpoint: string | undefined;
    const pending = new Set<Promise<void>>();
    const lines = createInterface({ input, crlfDelay: Infinity });
    const dispatch = async (line: string) => {
        let message: { id?: string | number; method?: string; params?: Record<string, unknown> } | undefined;
        try {
            if (Buffer.byteLength(line) > 4 * 1024 * 1024) { throw new Error('MCP request exceeds the size limit.'); }
            message = JSON.parse(line);
            if (!message || Array.isArray(message)) { throw new Error('Invalid MCP message.'); }
            const connection = JSON.parse(await fs.readFile(connectionFile, 'utf8')) as { schemaVersion: number; url: string; token: string };
            const endpoint = new URL(connection.url);
            if (connection.schemaVersion !== 1 || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
                || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/u.test(connection.token)) { throw new Error('Invalid local KOT connection file.'); }
            if (identity && identity !== connection.token && message.method !== 'initialize') { throw new Error('KOT restarted. Reconnect this MCP server.'); }
            identity = connection.token;
            activeEndpoint = endpoint.href;
            const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: {
                Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                ...(session ? { 'Mcp-Session-Id': session } : {}), ...(protocol ? { 'MCP-Protocol-Version': protocol } : {})
            }, body: line });
            if (!response.ok) { throw new Error(`KOT MCP returned HTTP ${response.status}. Reconnect if the server restarted.`); }
            if (response.status === 202) { return; }
            const result = await response.json() as { result?: { protocolVersion?: string } };
            if (message.method === 'initialize') { session = response.headers.get('mcp-session-id') ?? undefined; protocol = result.result?.protocolVersion; }
            output.write(JSON.stringify(result) + '\n');
        } catch (error) {
            if (message?.id !== undefined) { output.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000,
                message: error instanceof Error ? error.message : 'KOT bridge failed' } }) + '\n'); }
        }
    };
    for await (const line of lines) {
        if (!line.trim()) { continue; }
        // Initialization and its notification must be ordered before ordinary calls.
        if (!session || line.includes('"notifications/initialized"')) { await dispatch(line); }
        else { const work = dispatch(line).finally(() => { pending.delete(work); }); pending.add(work); }
    }
    await Promise.all(pending);
    if (session && activeEndpoint && identity) {
        await fetch(activeEndpoint, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { Authorization: 'Bearer ' + identity, 'Mcp-Session-Id': session } }).catch(() => undefined);
    }
}
