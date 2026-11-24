import { execFile } from 'node:child_process';
import { normalizeVanessaControlEndpoint } from './vanessaControlProtocol';

export interface LocalOneCListener {
    readonly host: '127.0.0.1' | '::1';
    readonly port: number;
    readonly pid: number;
    readonly title: string;
}

export function parseLocalOneCListeners(output: string): LocalOneCListener[] {
    try {
        const data: unknown = JSON.parse(output);
        if (!Array.isArray(data)) { return []; }
        return data.flatMap((row: Partial<LocalOneCListener> | null) => {
            if (!row || (row.host !== '127.0.0.1' && row.host !== '::1') || typeof row.port !== 'number' ||
                !Number.isInteger(row.port) || row.port < 1 || row.port > 65535 || typeof row.pid !== 'number' ||
                !Number.isSafeInteger(row.pid) || row.pid < 1 || typeof row.title !== 'string') { return []; }
            return [{ host: row.host, port: row.port, pid: row.pid, title: row.title.replace(/[\r\n]/gu, ' ').trim().slice(0, 200) }];
        }).slice(0, 64);
    } catch { return []; }
}

function loopbackEndpoint(endpoint: string): { host: string; port: number } | undefined {
    try {
        const url = new URL(normalizeVanessaControlEndpoint(endpoint));
        return { host: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
    } catch { return undefined; }
}

export function localOneCListener(endpoint: string, listeners: readonly LocalOneCListener[]): LocalOneCListener | undefined {
    const address = loopbackEndpoint(endpoint);
    if (!address) { return undefined; }
    const matches = listeners.filter(listener => listener.port === address.port && (address.host === 'localhost' || listener.host === address.host));
    return matches.length && matches.every(listener => listener.pid === matches[0].pid) ? matches[0] : undefined;
}

/** Read only loopback listeners owned by 1C; no process command lines or credentials. */
export async function localOneCListeners(): Promise<readonly LocalOneCListener[]> {
    if (process.platform !== 'win32') { return []; }
    const script = `
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $kotManagers = @{}
        Get-Process -Name 1cv8,1cv8c -ErrorAction SilentlyContinue | ForEach-Object { $kotManagers[[int]$_.Id] = $_ }
        if ($kotManagers.Count -eq 0) { '[]'; return }
        $kotListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $kotManagers.ContainsKey([int]$_.OwningProcess) -and $_.LocalAddress -in @('127.0.0.1','::1') } |
            Select-Object -First 64 | ForEach-Object {
                @{
                    host = $_.LocalAddress
                    port = [int]$_.LocalPort
                    pid = [int]$_.OwningProcess
                    title = [string]$kotManagers[[int]$_.OwningProcess].MainWindowTitle
                }
            })
        ConvertTo-Json -InputObject $kotListeners -Compress
    `.trim();
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
            (error, stdout) => resolve(error ? [] : parseLocalOneCListeners(stdout)));
    });
}

export function canShowLocalVanessaWindow(endpoint: string): boolean {
    return process.platform === 'win32' && !!loopbackEndpoint(endpoint);
}

export async function showLocalVanessaWindow(endpoint: string): Promise<boolean> {
    const address = loopbackEndpoint(endpoint);
    if (process.platform !== 'win32' || !address) { return false; }
    const addresses = address.host === 'localhost' ? "'127.0.0.1','::1'" : `'${address.host}'`;
    // Resolve the listening process again at click time, never focus a cached PID or match a shared window title.
    const script = `
        $kotListeners = @(Get-NetTCPConnection -State Listen -LocalPort ${address.port} -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -in @(${addresses}) } | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($kotListeners.Count -ne 1) { return }
        $kotManager = Get-Process -Id $kotListeners[0] -ErrorAction SilentlyContinue
        if ($kotManager.ProcessName -in @('1cv8','1cv8c') -and $kotManager.MainWindowHandle -ne 0) {
            (New-Object -ComObject WScript.Shell).AppActivate([int]$kotManager.Id)
        }
    `.trim();
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5_000, maxBuffer: 1024 },
            (error, stdout) => resolve(!error && stdout.trim().toLowerCase() === 'true'));
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
