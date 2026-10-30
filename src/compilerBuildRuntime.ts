import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeBuildParameterKey, type CompilerBuildParameter } from './compilerBuildParameters';
import { normalizeCompilerProcessFeatureLanguage } from './compilerProcessFeatureLanguage';

export interface CompilerBuildJob {
    index: number;
    total: number;
    directory: string;
    outputPath: string;
    parametersPath: string;
    resultPath: string;
    logPath: string;
    errorPath: string;
    inventoryPath: string;
    junitPath: string;
    parameters: CompilerBuildParameter[];
}

export function compilerBuildPathsOverlap(left: string, right: string, pathApi: Pick<typeof path, 'resolve' | 'sep'> = path, caseInsensitive = process.platform === 'win32'): boolean {
    const normalize = (value: string) => caseInsensitive ? pathApi.resolve(value).toLowerCase() : pathApi.resolve(value);
    const a = normalize(left); const b = normalize(right);
    const prefix = (value: string) => value.endsWith(pathApi.sep) ? value : value + pathApi.sep;
    return a === b || a.startsWith(prefix(b)) || b.startsWith(prefix(a));
}

export function planCompilerBuildJobs(parameters: readonly CompilerBuildParameter[], runtimeRoot: string, outputRoot: string): CompilerBuildJob[] {
    const values = new Map(parameters.map(item => [normalizeBuildParameterKey(item.key), item.value]));
    const totalValue = values.get('threadtotal') || values.get('threadscount') || '1';
    const total = Number(totalValue);
    if (!Number.isSafeInteger(total) || total < 1) { throw new Error('ThreadsCount/ThreadTotal must be a positive integer.'); }
    const explicitIndex = values.get('threadindex');
    const explicitNumber = values.get('threadnumber');
    const requested = explicitIndex?.trim() ? Number(explicitIndex) : explicitNumber?.trim() ? Number(explicitNumber) + 1 : undefined;
    if (requested !== undefined && !Number.isSafeInteger(requested)) { throw new Error('ThreadIndex/ThreadNumber must be an integer.'); }
    const indices = requested === undefined ? Array.from({ length: total }, (_, index) => index + 1) : [Math.min(total, Math.max(1, requested))];
    const managed = new Set(['featurefolder', 'resultfile', 'logfile', 'errorfolder', 'compilefile', 'junitfile', 'threadscount', 'threadtotal', 'threadnumber', 'threadindex']);
    return indices.map(index => {
        const directory = path.join(runtimeRoot, 'compiler-parts', String(index));
        const job: CompilerBuildJob = {
            index, total, directory,
            outputPath: path.join(directory, 'artifacts'),
            parametersPath: path.join(directory, 'yaml_parameters.json'),
            resultPath: path.join(directory, 'yaml_build_result.txt'),
            logPath: path.join(directory, 'yaml_build_log.txt'),
            errorPath: path.join(directory, 'BuildErrors'),
            inventoryPath: path.join(directory, 'compile.txt'),
            junitPath: path.join(directory, 'junit_compile.xml'),
            parameters: []
        };
        if (compilerBuildPathsOverlap(outputRoot, job.directory)) { throw new Error('Build output overlaps a compiler worker directory.'); }
        job.parameters = [
            ...parameters.filter(item => !managed.has(normalizeBuildParameterKey(item.key))),
            { key: 'FeatureFolder', value: job.outputPath },
            { key: 'ResultFile', value: job.resultPath },
            { key: 'LogFile', value: job.logPath },
            { key: 'ErrorFolder', value: job.errorPath + path.sep },
            { key: 'CompileFile', value: job.inventoryPath },
            { key: 'JUnitFile', value: job.junitPath },
            { key: 'ThreadTotal', value: String(total) },
            { key: 'ThreadIndex', value: String(index) }
        ];
        return job;
    });
}

export async function runCompilerBuildJobs<T>(jobs: readonly T[], execute: (job: T, signal: AbortSignal) => Promise<void>, cancel: () => void | Promise<void>, concurrency = 2): Promise<void> {
    const controller = new AbortController();
    let cursor = 0;
    let failure: unknown;
    let failed = false;
    const worker = async () => {
        while (!failed && cursor < jobs.length) {
            const job = jobs[cursor++];
            try { await execute(job, controller.signal); }
            catch (error) {
                if (!failed) {
                    failed = true;
                    failure = error;
                    controller.abort(error);
                    try { await cancel(); } catch { /* Preserve the worker failure. */ }
                }
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(jobs.length, Math.max(1, Math.floor(concurrency))) }, worker));
    if (failed) { throw failure; }
}

function retargetJson(value: unknown, from: string, to: string): unknown {
    if (typeof value === 'string') {
        const normalized = value.replace(/\\/gu, '/');
        const prefix = from.replace(/\\/gu, '/').replace(/\/$/u, '');
        if (normalized === prefix || normalized.startsWith(prefix + '/')) { return to + normalized.slice(prefix.length).split('/').join(path.sep); }
        return value;
    }
    if (Array.isArray(value)) { return value.map(item => retargetJson(item, from, to)); }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, retargetJson(item, from, to)]));
    }
    return value;
}

/** Keep worker namespaces, so equal filenames cannot replace another part's output. */
export async function mergeCompilerBuildOutputs(jobs: readonly CompilerBuildJob[], outputRoot: string): Promise<void> {
    const output = path.resolve(outputRoot);
    if (output === path.parse(output).root || jobs.some(job => compilerBuildPathsOverlap(job.directory, output))) {
        throw new Error('Build output must be separate from the worker runtime.');
    }
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    const scenarios = new Set<string>();
    const processes = new Set<string>();
    for (const job of jobs) {
        const destination = jobs.length > 1 ? path.join(output, `part-${job.index}`) : output;
        const copy = async (directory: string, target: string, attachments = false): Promise<void> => {
            await fs.mkdir(target, { recursive: true });
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const source = path.join(directory, entry.name);
                const file = path.join(target, entry.name);
                if (entry.isDirectory()) { await copy(source, file, attachments || ['files', 'файлы'].includes(entry.name.normalize('NFC').toLowerCase())); }
                else if (entry.isFile()) {
                    if (!attachments && /\.json$/iu.test(entry.name)) {
                        const text = await fs.readFile(source, 'utf8');
                        try { await fs.writeFile(file, JSON.stringify(retargetJson(JSON.parse(text), job.outputPath, destination), null, 2)); }
                        catch (error) { if (error instanceof SyntaxError) { await fs.copyFile(source, file); } else { throw error; } }
                    } else if (!attachments && /\.feature$/iu.test(entry.name)) {
                        const original = await fs.readFile(source, 'utf8');
                        const updated = normalizeCompilerProcessFeatureLanguage(original);
                        if (updated === original) { await fs.copyFile(source, file); }
                        else { await fs.writeFile(file, updated); }
                    } else { await fs.copyFile(source, file); }
                }
            }
        };
        await copy(job.outputPath, destination);
        for (const file of [job.inventoryPath, path.join(job.outputPath, 'compile.txt')]) {
            try {
                const inventory = JSON.parse(await fs.readFile(file, 'utf8')) as { scenario_tests?: unknown[]; process_tests?: unknown[] };
                for (const code of inventory.scenario_tests || []) { if (typeof code === 'string') { scenarios.add(code); } }
                for (const code of inventory.process_tests || []) { if (typeof code === 'string') { processes.add(code); } }
            } catch { /* An optional inventory must not invalidate successfully compiled features. */ }
        }
    }
    await fs.writeFile(path.join(output, 'compile.txt'), JSON.stringify({ scenario_tests: [...scenarios], process_tests: [...processes] }, null, 2));
}
