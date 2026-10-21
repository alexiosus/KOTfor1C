import { execFile } from 'node:child_process';
import { normalizeVanessaControlEndpoint } from './vanessaControlProtocol';

export function parseLocalOneCListeningPorts(output: string): number[] {
    return [...new Set(output.split(/\r?\n/u).filter(line => /^\s*\d{1,5}\s*$/u.test(line)).map(Number)
        .filter(port => Number.isSafeInteger(port) && port > 0 && port <= 65535))].slice(0, 32);
}

/** Read only loopback listeners owned by 1C; no process command lines or credentials. */
export async function localOneCListeningPorts(): Promise<readonly number[]> {
    if (process.platform !== 'win32') { return []; }
    const script = "$kotProcessIds = @(Get-Process -Name 1cv8,1cv8c -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $kotProcessIds -contains $_.OwningProcess -and $_.LocalAddress -in @('127.0.0.1','::1') } | Select-Object -ExpandProperty LocalPort -Unique";
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024 },
            (error, stdout) => resolve(error ? [] : parseLocalOneCListeningPorts(stdout)));
    });
}

/** Discovery performs handshake/tools-list inspection only, never an execution tool. */
export async function discoverVanessaControlEndpoints(ports: {
    saved: readonly string[];
    ports: readonly number[];
    inspect(endpoint: string, signal: AbortSignal): Promise<boolean>;
}, signal: AbortSignal): Promise<readonly string[]> {
    const endpoints = new Set<string>();
    for (const value of ports.saved.slice(0, 10)) {
        try { endpoints.add(normalizeVanessaControlEndpoint(value)); } catch { /* Remote addresses require explicit selection. */ }
    }
    endpoints.add('http://127.0.0.1:9876/mcp');
    for (const port of ports.ports.slice(0, 32)) {
        if (Number.isSafeInteger(port) && port > 0 && port <= 65535) { endpoints.add(`http://127.0.0.1:${port}/mcp`); }
    }
    const candidates = [...endpoints]; const live = new Set<string>(); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
        while (next < candidates.length) {
            signal.throwIfAborted(); const endpoint = candidates[next++];
            try { if (await ports.inspect(endpoint, AbortSignal.any([signal, AbortSignal.timeout(2_000)]))) { live.add(endpoint); } }
            catch { /* Closed ports, unrelated MCP servers and stale entries are not choices. */ }
            signal.throwIfAborted();
        }
    }));
    signal.throwIfAborted();
    return Object.freeze(candidates.filter(endpoint => live.has(endpoint)));
}
