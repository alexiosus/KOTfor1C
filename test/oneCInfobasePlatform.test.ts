import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { OneCInfobasePlatformError, parseRunningOneCInfobasePlatform, runningOneCInfobasePlatformScript } from '../src/oneCInfobasePlatform';

const base = 'C:\\KOT\\Служебная база\\ib';
const bin = 'C:\\Program Files\\1cv8\\8.5.1.1522\\bin';
const record = (directory = base, executablePath = bin + '\\1cv8c.exe') => ({ infobaseDirectory: directory, executablePath });

test('the running platform belongs to the exact service IB and is independent of catalog order', () => {
    assert.equal(parseRunningOneCInfobasePlatform(JSON.stringify([record(base + '-other', 'C:\\1cv8.exe'), record(base.toLowerCase() + '\\')]), base), bin + '\\1cv8c.exe');
    assert.equal(parseRunningOneCInfobasePlatform(JSON.stringify([record(base + '-other')]), base), undefined);
    assert.equal(parseRunningOneCInfobasePlatform('[]', base), undefined);
    assert.equal(parseRunningOneCInfobasePlatform(JSON.stringify([record(base, bin + '\\1cv8.exe'), record()]), base), bin + '\\1cv8c.exe');
});

test('conflicting platforms and unreadable executable metadata never become the default platform', () => {
    assert.throws(() => parseRunningOneCInfobasePlatform(JSON.stringify([record(), record(base, 'C:\\1cv8\\8.3.24\\bin\\1cv8c.exe')]), base), (error: unknown) => error instanceof OneCInfobasePlatformError && error.reason === 'conflict');
    for (const value of ['null', '{}', '', '[{}]', JSON.stringify([record(base, '')]), JSON.stringify([record(base, 'relative\\1cv8.exe')])]) {
        assert.throws(() => parseRunningOneCInfobasePlatform(value, base), (error: unknown) => error instanceof OneCInfobasePlatformError && error.reason === 'unavailable');
    }
});

test('Windows observation recognizes /F and quoted connection strings without returning credentials or matching /C payloads', { skip: process.platform !== 'win32' }, async () => {
    const processes = [
        { ExecutablePath: bin + '\\1cv8c.exe', CommandLine: `"${bin}\\1cv8c.exe" ENTERPRISE /F "${base}" /P "private-password"` },
        { ExecutablePath: bin + '\\1cv8.exe', CommandLine: `"${bin}\\1cv8.exe" DESIGNER /IBConnectionString "File=\\"${base}\\";Usr=Service;Pwd=private-password;"` },
        { ExecutablePath: bin + '\\1cv8c.exe', CommandLine: `"${bin}\\1cv8c.exe" ENTERPRISE /f"${base}\\\\" /C "ignored"` },
        { ExecutablePath: bin + '\\1cv8c.exe', CommandLine: `"${bin}\\1cv8c.exe" ENTERPRISE /F C:\\different /C "/F ${base}"` },
        { ExecutablePath: bin + '\\1cv8c.exe', CommandLine: `"${bin}\\1cv8c.exe" ENTERPRISE /IBConnectionString "Srvr=server;Ref=base;Pwd=private-password;"` }
    ];
    const encoded = Buffer.from(JSON.stringify(processes), 'utf8').toString('base64');
    const fakeCim = `function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) $kotFakeProcesses = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; foreach ($kotFakeProcess in $kotFakeProcesses) { $kotFakeProcess } }\n`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', fakeCim + runningOneCInfobasePlatformScript], { windowsHide: true, timeout: 10000 });
    const records = JSON.parse(stdout);
    assert.equal(records.length, 4, JSON.stringify(records)); assert.equal(records[0].infobaseDirectory, base); assert.equal(records[1].infobaseDirectory, base);
    assert.equal(records[2].infobaseDirectory, base + '\\'); assert.equal(records[3].infobaseDirectory, 'C:\\different');
    assert.ok(!stdout.includes('private-password')); assert.ok(!stdout.includes('CommandLine'));
    assert.equal(parseRunningOneCInfobasePlatform(stdout, base), bin + '\\1cv8c.exe');
});
