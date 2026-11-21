import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DirectProcessCancellationToken, DirectProcessResult } from './directProcessLaunch';
import { redactVanessaDiagnosticText } from './vanessaControlRedaction';

export const SPPR_COMPILER_NAME = 'СборкаТекстовСценариев';
export type SpprExportPhase = 'reading' | 'converting' | 'preparing' | 'building';
export interface SpprExportCommand { executable: string; args: string[] }
export interface SpprCompilerExportRequest {
    source: SpprExportCommand;
    destination: string;
    jobsDirectory: string;
    converterScript: string;
    powershell: string;
}
export interface SpprCompilerExportDependencies {
    run(command: SpprExportCommand, cwd: string, token: DirectProcessCancellationToken): Promise<DirectProcessResult>;
    prepareBuild(): Promise<SpprExportCommand>;
    progress(phase: SpprExportPhase): void;
}
export class SpprCompilerExportError extends Error {
    constructor(readonly phase: SpprExportPhase, details: string) { super(details); }
}
function checkCancellation(token: DirectProcessCancellationToken): void {
    if (token.isCancellationRequested) { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); }
}
async function logText(file: string): Promise<string> {
    const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0));
    return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '').trim();
}

/** Read the source configuration only. EPF assembly takes place in the separate KOT service IB. */
export async function exportSpprCompiler(request: SpprCompilerExportRequest, dependencies: SpprCompilerExportDependencies,
    token: DirectProcessCancellationToken): Promise<string> {
    checkCancellation(token);
    await fs.mkdir(request.jobsDirectory, { recursive: true });
    const job = await fs.mkdtemp(path.join(request.jobsDirectory, 'export-'));
    let pending: string | undefined;
    const run = async (command: SpprExportCommand, phase: SpprExportPhase, log?: string) => {
        checkCancellation(token);
        const result = await dependencies.run(command, job, token);
        if (result.cancelled) { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); }
        checkCancellation(token);
        if (result.exitCode !== 0) {
            throw new SpprCompilerExportError(phase, redactVanessaDiagnosticText([
                log ? await logText(log) : '', result.stderr, result.stdout
            ].filter(Boolean).join('\n')).slice(-6000) || `1C/process exit code: ${result.exitCode}`);
        }
    };
    try {
        const source = path.join(job, 'source'); const external = path.join(job, 'external');
        const list = path.join(job, 'objects.txt'); const manifest = path.join(job, 'manifest.json');
        await fs.mkdir(source); await fs.mkdir(external);
        const rootObject = `DataProcessor.${SPPR_COMPILER_NAME}`;
        const dump = async (objects: string[], pass: number) => {
            await fs.writeFile(list, '\uFEFF' + objects.join('\r\n') + '\r\n', 'utf8');
            const log = path.join(job, `dump-${pass}.log`);
            await run({ executable: request.source.executable, args: [...request.source.args,
                '/DumpConfigToFiles', source, '-listFile', list, '-ignoreUnresolvedReferences',
                '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', log] }, 'reading', log);
        };
        const convert = (mode: 'Inspect' | 'Convert') => run({ executable: request.powershell,
            args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', request.converterScript,
                '-Mode', mode, '-SourceDirectory', source, '-ExternalDirectory', external, '-Manifest', manifest, '-Name', SPPR_COMPILER_NAME] }, 'converting');
        dependencies.progress('reading');
        await dump([rootObject], 1);
        await convert('Inspect');
        const children: unknown = JSON.parse((await fs.readFile(manifest, 'utf8')).replace(/^\uFEFF/u, ''));
        if (!Array.isArray(children) || children.length > 100 || children.some(item => typeof item !== 'string'
            || !item.startsWith(rootObject + '.') || !/^DataProcessor\.[\p{L}\p{N}_]+\.(Form|Template)\.[\p{L}\p{N}_]+$/u.test(item))) {
            throw new SpprCompilerExportError('reading', 'Invalid compiler metadata child list');
        }
        if (children.length) { await dump([rootObject, ...children as string[]], 2); }
        dependencies.progress('converting'); await convert('Convert');
        checkCancellation(token);
        dependencies.progress('preparing'); const build = await dependencies.prepareBuild(); checkCancellation(token);
        dependencies.progress('building');
        const compiled = path.join(job, 'BuildScenarioBDD.epf'); const log = path.join(job, 'build.log');
        await run({ executable: build.executable, args: [...build.args, '/LoadExternalDataProcessorOrReportFromFiles',
            path.join(external, `${SPPR_COMPILER_NAME}.xml`), compiled, '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', log] }, 'building', log);
        if (!await fs.stat(compiled).then(stat => stat.isFile() && stat.size > 0, () => false)) {
            throw new SpprCompilerExportError('building', '1C did not create the compiler EPF');
        }
        checkCancellation(token);
        await fs.mkdir(path.dirname(request.destination), { recursive: true });
        pending = path.join(path.dirname(request.destination), `.kot-compiler-${randomUUID()}.epf`);
        await fs.copyFile(compiled, pending); checkCancellation(token);
        await fs.rename(pending, request.destination); pending = undefined;
        return request.destination;
    } finally {
        if (pending) { await fs.rm(pending, { force: true }).catch(() => undefined); }
        // mkdtemp returned this job under our own runtime directory; never remove a user-supplied directory.
        if (path.dirname(path.resolve(job)) === path.resolve(request.jobsDirectory) && path.basename(job).startsWith('export-')) {
            await fs.rm(job, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
