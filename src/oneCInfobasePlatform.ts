import { execFile } from 'node:child_process';
import path from 'node:path';

export class OneCInfobasePlatformError extends Error {
    constructor(readonly reason: 'unavailable' | 'conflict') { super(`Cannot determine the infobase platform: ${reason}`); }
}

/** Parse only sanitized process metadata; command lines and credentials never leave PowerShell. */
export function parseRunningOneCInfobasePlatform(output: string, infobaseDirectory: string): string | undefined {
    const identity = (value: string) => path.win32.normalize(value).replace(/[\\/]+$/u, '').toLowerCase();
    let records: unknown;
    try { records = JSON.parse(output.replace(/^\uFEFF/u, '').trim()); }
    catch { throw new OneCInfobasePlatformError('unavailable'); }
    if (!Array.isArray(records)) { throw new OneCInfobasePlatformError('unavailable'); }
    const executables: string[] = [];
    for (const record of records) {
        if (!record || typeof record.infobaseDirectory !== 'string') { throw new OneCInfobasePlatformError('unavailable'); }
        if (identity(record.infobaseDirectory) !== identity(infobaseDirectory)) { continue; }
        if (typeof record.executablePath !== 'string' || !path.win32.isAbsolute(record.executablePath)
            || !/^1cv8c?\.exe$/iu.test(path.win32.basename(record.executablePath))) { throw new OneCInfobasePlatformError('unavailable'); }
        executables.push(path.win32.normalize(record.executablePath));
    }
    if (new Set(executables.map(exe => identity(path.win32.dirname(exe)))).size > 1) { throw new OneCInfobasePlatformError('conflict'); }
    return executables.find(exe => path.win32.basename(exe).toLowerCase() === '1cv8c.exe') ?? executables[0];
}

/** Windows command-line quoting must be decoded before checking /F or /IBConnectionString. */
export const runningOneCInfobasePlatformScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Split-KotProcessArguments([string]$kotCommand) {
    $kotWord = [Text.StringBuilder]::new()
    $kotQuoted = $false
    $kotStarted = $false
    for ($kotIndex = 0; $kotIndex -lt $kotCommand.Length; $kotIndex++) {
        $kotChar = $kotCommand[$kotIndex]
        if ($kotChar -eq '\') {
            $kotSlashes = 0
            while ($kotIndex -lt $kotCommand.Length -and $kotCommand[$kotIndex] -eq '\') { $kotSlashes++; $kotIndex++ }
            if ($kotIndex -lt $kotCommand.Length -and $kotCommand[$kotIndex] -eq '"') {
                [void]$kotWord.Append('\', [int][Math]::Floor($kotSlashes / 2))
                if ($kotSlashes % 2) { [void]$kotWord.Append('"') } else { $kotQuoted = -not $kotQuoted }
            } else { [void]$kotWord.Append('\', $kotSlashes); $kotIndex-- }
            $kotStarted = $true
        } elseif ($kotChar -eq '"') {
            if ($kotQuoted -and $kotIndex + 1 -lt $kotCommand.Length -and $kotCommand[$kotIndex + 1] -eq '"') {
                [void]$kotWord.Append('"'); $kotIndex++
            } else { $kotQuoted = -not $kotQuoted }
            $kotStarted = $true
        } elseif ([char]::IsWhiteSpace($kotChar) -and -not $kotQuoted) {
            if ($kotStarted) { $kotWord.ToString(); [void]$kotWord.Clear(); $kotStarted = $false }
        } else { [void]$kotWord.Append($kotChar); $kotStarted = $true }
    }
    if ($kotStarted) { $kotWord.ToString() }
}
$kotResults = [Collections.Generic.List[object]]::new()
foreach ($kotProcess in @(Get-CimInstance Win32_Process -Filter "Name = '1cv8.exe' OR Name = '1cv8c.exe'" -ErrorAction Stop)) {
    if (-not $kotProcess.CommandLine) { continue }
    $kotArgv = @(Split-KotProcessArguments $kotProcess.CommandLine)
    $kotDirectory = $null
    for ($kotIndex = 1; $kotIndex -lt $kotArgv.Count; $kotIndex++) {
        $kotArgument = $kotArgv[$kotIndex]
        if ($kotArgument -match '^/F(.*)$') {
            if ($Matches[1]) { $kotDirectory = $Matches[1] }
            elseif ($kotIndex + 1 -lt $kotArgv.Count) { $kotIndex++; $kotDirectory = $kotArgv[$kotIndex] }
        } elseif ($kotArgument -ieq '/IBConnectionString' -and $kotIndex + 1 -lt $kotArgv.Count) {
            $kotIndex++
            if ($kotArgv[$kotIndex] -match '(?:^|;)\s*File\s*=\s*(?:"((?:[^"]|"")*)"|([^;]+))') {
                if ($Matches[1]) { $kotDirectory = $Matches[1].Replace('""', '"') } else { $kotDirectory = $Matches[2].Trim() }
            }
        } elseif ($kotArgument -in @('/C', '/N', '/P', '/Execute', '/Out', '/S', '/WS', '/IBName')) {
            $kotIndex++
        }
    }
    if ($kotDirectory) { $kotResults.Add(@{ infobaseDirectory = $kotDirectory; executablePath = $kotProcess.ExecutablePath }) }
}
ConvertTo-Json -InputObject @($kotResults.ToArray()) -Compress
`;

/** Observe all local 1C sessions, including those started outside this extension host. */
export async function runningOneCInfobasePlatform(infobaseDirectory: string): Promise<string | undefined> {
    if (process.platform !== 'win32') { return undefined; }
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', runningOneCInfobasePlatformScript],
            { windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
                if (error) { reject(new OneCInfobasePlatformError('unavailable')); return; }
                try { resolve(parseRunningOneCInfobasePlatform(stdout, infobaseDirectory)); } catch (failure) { reject(failure); }
            });
    });
}
