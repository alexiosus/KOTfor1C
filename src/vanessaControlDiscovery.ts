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

export interface LocalOneCLaunchParameters { readonly parametersPath: string; readonly startedAt: number }

export function parseLocalOneCLaunchParameters(output: string): LocalOneCLaunchParameters | undefined {
    try {
        const value = JSON.parse(output.trim()) as Partial<LocalOneCLaunchParameters>;
        if (typeof value.parametersPath === 'string' && value.parametersPath.length < 32768 && /\.json$/iu.test(value.parametersPath)
            && typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) && value.startedAt > 0) {
            return { parametersPath: value.parametersPath, startedAt: value.startedAt };
        }
    } catch { /* Missing or unavailable process information is not a verified association. */ }
    return undefined;
}

/** Return only the VAParams filename and process creation time, never command lines/authentication. */
export async function localOneCLaunchParameters(endpoint: string): Promise<LocalOneCLaunchParameters | undefined> {
    let address: URL;
    try { address = new URL(normalizeVanessaControlEndpoint(endpoint, true)); } catch { return undefined; }
    if (process.platform !== 'win32' || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) { return undefined; }
    const port = Number(address.port || (address.protocol === 'https:' ? 443 : 80));
    const script = `$kotOwners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') } | Select-Object -ExpandProperty OwningProcess -Unique); if ($kotOwners.Count -ne 1) { return }; $kotManager = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $kotOwners[0]) -ErrorAction SilentlyContinue; if ($kotManager.Name -notin @('1cv8.exe','1cv8c.exe')) { return }; if ($kotManager.CommandLine -match '(?i)(?:^|[;\"])VAParams=([^;]+);') { @{ parametersPath = $Matches[1].Trim('\"'); startedAt = ([DateTimeOffset]$kotManager.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`;
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
            (error, stdout) => resolve(error ? undefined : parseLocalOneCLaunchParameters(stdout)));
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
