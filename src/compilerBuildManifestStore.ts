import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
    createCompilerBuildManifest, fingerprintCompilerBuildArtifact, fingerprintCompilerBuildInputs, parseCompilerBuildManifest,
    type CompilerBuildArtifactFingerprint, type CompilerBuildInputFingerprint, type CompilerBuildManifest
} from './compilerBuildManifest';

export const COMPILER_BUILD_MANIFEST_NAME = '.kot-build-manifest.json';
export interface CompilerBuildCaptureRequest {
    readonly sourceRoots: readonly string[];
    readonly compilerPath: string;
    readonly modelDbSettingsPath?: string;
    readonly configuration: unknown;
    /** Keep VS Code URI identity (not Node URL drive escaping) when running in the extension host. */
    readonly uriForPath?: (filePath: string) => string;
}
export interface CompilerBuildCapturedInputs {
    readonly inputs: CompilerBuildInputFingerprint;
    readonly sources: readonly { readonly uri: string; readonly text: string }[];
}
export interface CompilerBuildArtifactContent {
    readonly worker: number; readonly feature: string; readonly sourceMap: string;
    readonly featureContent: string; readonly sourceMapContent: string;
}

async function regularFile(file: string): Promise<Buffer> {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) { throw new Error('Symbolic links cannot certify compiler inputs or artifacts.'); }
    if (!stat.isFile()) { throw new Error('Expected a regular compiler file.'); }
    return fs.readFile(file);
}

/** Match the compiler's recursive *.yaml inventory, including hidden folders, without editor models. */
async function collectFiles(root: string, accept: (file: string) => boolean, found: Set<string>): Promise<void> {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink()) { throw new Error('Symbolic links cannot certify compiler inputs or artifacts.'); }
    if (!stat.isDirectory()) { throw new Error('Expected a compiler directory.'); }
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name);
        if (entry.isSymbolicLink()) { throw new Error('Symbolic links cannot certify compiler inputs or artifacts.'); }
        if (entry.isDirectory()) { await collectFiles(file, accept, found); }
        else if (entry.isFile() && accept(file)) { found.add(file); }
    }
}

async function mapFiles<T>(files: readonly string[], read: (file: string) => Promise<T>): Promise<T[]> {
    const values: T[] = new Array(files.length); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
        while (cursor < files.length) { const index = cursor++; values[index] = await read(files[index]); }
    }));
    return values;
}

export async function captureCompilerBuildInputs(request: CompilerBuildCaptureRequest): Promise<CompilerBuildCapturedInputs> {
    const roots = [...new Set(request.sourceRoots.map(root => path.resolve(root)))].sort();
    if (!roots.length) { throw new Error('Compiler source folders are required.'); }
    const sourcePaths = new Set<string>();
    for (const root of roots) { await collectFiles(root, file => /\.yaml$/iu.test(file), sourcePaths); }
    const files = new Set(sourcePaths); files.add(path.resolve(request.compilerPath));
    const modelPath = request.modelDbSettingsPath ? path.resolve(request.modelDbSettingsPath) : undefined;
    if (modelPath) {
        try { await fs.lstat(modelPath); files.add(modelPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    }
    const contents = await mapFiles([...files].sort(), async file => ({ file, uri: request.uriForPath?.(file) ?? pathToFileURL(file).href, content: await regularFile(file) }));
    return Object.freeze({
        inputs: fingerprintCompilerBuildInputs(contents, { configuration: request.configuration, sourceRoots: roots,
            compilerPath: path.resolve(request.compilerPath), modelDbSettingsPath: modelPath ?? null }),
        sources: Object.freeze(contents.filter(item => sourcePaths.has(item.file)).map(item => Object.freeze({ uri: item.uri, text: item.content.toString('utf8') })))
    });
}

export async function invalidateCompilerBuildManifest(outputRoot: string): Promise<void> {
    await fs.rm(path.join(outputRoot, COMPILER_BUILD_MANIFEST_NAME), { force: true });
}

export async function readCompilerBuildManifest(outputRoot: string): Promise<CompilerBuildManifest | undefined> {
    try { return parseCompilerBuildManifest((await regularFile(path.join(outputRoot, COMPILER_BUILD_MANIFEST_NAME))).toString('utf8')); }
    catch { return undefined; }
}

/** Validate every path component: a manifest must not follow a subsequently substituted directory link. */
async function readArtifact(outputRoot: string, relative: string): Promise<Buffer> {
    const parts = relative.split('/'); let directory = outputRoot;
    for (const part of parts.slice(0, -1)) {
        directory = path.join(directory, part); const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink()) { throw new Error('Symbolic links cannot certify compiler artifacts.'); }
        if (!stat.isDirectory()) { throw new Error('Expected a compiler artifact directory.'); }
    }
    return regularFile(path.join(outputRoot, ...parts));
}

export async function readCompilerBuildManifestArtifacts(outputRoot: string, manifest: CompilerBuildManifest): Promise<{
    readonly fingerprints: readonly CompilerBuildArtifactFingerprint[]; readonly contents: readonly CompilerBuildArtifactContent[];
}> {
    const stat = await fs.lstat(outputRoot);
    if (stat.isSymbolicLink()) { throw new Error('Symbolic links cannot certify compiler artifacts.'); }
    const items = await mapFiles(manifest.artifacts.map((_, index) => String(index)), async index => {
        const item = manifest.artifacts[Number(index)];
        // Also validate callers supplying an in-memory manifest rather than the strict disk parser.
        fingerprintCompilerBuildArtifact(item.worker, item.feature, '', item.sourceMap, '');
        const feature = await readArtifact(outputRoot, item.feature); const sourceMap = await readArtifact(outputRoot, item.sourceMap);
        return { fingerprint: fingerprintCompilerBuildArtifact(item.worker, item.feature, feature, item.sourceMap, sourceMap),
            content: Object.freeze({ worker: item.worker, feature: item.feature, sourceMap: item.sourceMap,
                featureContent: feature.toString('utf8'), sourceMapContent: sourceMap.toString('utf8') }) };
    });
    return Object.freeze({ fingerprints: Object.freeze(items.map(item => item.fingerprint)), contents: Object.freeze(items.map(item => item.content)) });
}

/** Call after successful final postprocessing AND restoration of temporarily moved compiler inputs. */
export async function publishCompilerBuildManifest(outputRoot: string, options: {
    readonly before: CompilerBuildInputFingerprint; readonly after: CompilerBuildInputFingerprint;
    readonly workers: readonly { readonly worker: number; readonly prefix: string }[]; readonly successful: boolean;
}): Promise<CompilerBuildManifest | undefined> {
    await invalidateCompilerBuildManifest(outputRoot);
    if (!options.successful || options.before.digest !== options.after.digest) { return undefined; }
    if (!options.workers.length || new Set(options.workers.map(item => item.worker)).size !== options.workers.length) { throw new Error('Invalid compiler worker namespaces.'); }
    for (const item of options.workers) {
        const prefix = item.prefix ? item.prefix + '/' : '';
        fingerprintCompilerBuildArtifact(item.worker, prefix + 'check.feature', '', prefix + 'check.str', '');
    }
    const files = new Set<string>(); await collectFiles(outputRoot, file => /\.feature$/iu.test(file), files);
    const artifacts = await mapFiles([...files].sort(), async file => {
        const feature = path.relative(outputRoot, file).split(path.sep).join('/');
        const workers = options.workers.filter(item => !item.prefix || feature.startsWith(item.prefix + '/'));
        if (workers.length !== 1) { throw new Error('Compiler artifact has an ambiguous worker namespace.'); }
        const sourceMap = feature.replace(/\.feature$/iu, '.str');
        return fingerprintCompilerBuildArtifact(workers[0].worker, feature, await regularFile(file), sourceMap, await readArtifact(outputRoot, sourceMap));
    });
    const manifest = createCompilerBuildManifest({ ...options, artifacts });
    if (!manifest) { return undefined; }
    const temporary = path.join(outputRoot, COMPILER_BUILD_MANIFEST_NAME + '.' + randomUUID() + '.tmp');
    try {
        await fs.writeFile(temporary, JSON.stringify(manifest) + '\n', { flag: 'wx' });
        await fs.rename(temporary, path.join(outputRoot, COMPILER_BUILD_MANIFEST_NAME));
    } finally { await fs.rm(temporary, { force: true }); }
    return manifest;
}
