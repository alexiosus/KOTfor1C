import { createHash } from 'node:crypto';

export interface CompilerBuildFileFingerprint { readonly uri: string; readonly sha256: string }
export interface CompilerBuildInputFingerprint {
    readonly configurationHash: string;
    readonly files: readonly CompilerBuildFileFingerprint[];
    readonly digest: string;
}
export interface CompilerBuildArtifactFingerprint {
    readonly worker: number;
    /** Paths are relative to the final merged output root, including its worker namespace. */
    readonly feature: string;
    readonly sourceMap: string;
    readonly featureHash: string;
    readonly sourceMapHash: string;
}
export interface CompilerBuildManifest {
    readonly schemaVersion: 1;
    readonly inputs: CompilerBuildInputFingerprint;
    readonly artifacts: readonly CompilerBuildArtifactFingerprint[];
}

type Bytes = string | Uint8Array;
const hash = (value: Bytes) => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Object key order is irrelevant; array order (including ordered parameters) is retained. */
function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { return JSON.stringify(value); }
    if (Array.isArray(value)) { return '[' + value.map(canonicalJson).join(',') + ']'; }
    if (record(value) && Object.getPrototypeOf(value) === Object.prototype) {
        return '{' + Object.keys(value).sort(compare).map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
    }
    throw new Error('Compiler fingerprint configuration must contain JSON values.');
}

function inputFingerprint(configurationHash: string, files: readonly CompilerBuildFileFingerprint[]): CompilerBuildInputFingerprint {
    if (!isHash(configurationHash) || !files.length || files.some(file => !file.uri.trim() || !isHash(file.sha256))) { throw new Error('Invalid compiler input fingerprint.'); }
    if (new Set(files.map(file => file.uri)).size !== files.length) { throw new Error('Duplicate compiler input identity.'); }
    const sorted = Object.freeze(files.map(file => Object.freeze({ uri: file.uri, sha256: file.sha256 })).sort((a, b) => compare(a.uri, b.uri)));
    return Object.freeze({ configurationHash, files: sorted, digest: hash(canonicalJson({ configurationHash, files: sorted })) });
}

/** The caller supplies the complete dependency inventory, captured before compilation. No raw settings are retained. */
export function fingerprintCompilerBuildInputs(files: readonly { readonly uri: string; readonly content: Bytes }[], configuration: unknown): CompilerBuildInputFingerprint {
    return inputFingerprint(hash(canonicalJson(configuration)), files.map(file => ({ uri: file.uri, sha256: hash(file.content) })));
}

function safeArtifactPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !/[\\\u0000:]/u.test(value) &&
        value.split('/').every(part => !!part && part !== '.' && part !== '..');
}
function validArtifact(value: unknown): value is CompilerBuildArtifactFingerprint {
    return record(value) && Number.isSafeInteger(value.worker) && Number(value.worker) > 0 && safeArtifactPath(value.feature) &&
        /\.feature$/iu.test(value.feature) && safeArtifactPath(value.sourceMap) && /\.str$/iu.test(value.sourceMap) &&
        isHash(value.featureHash) && isHash(value.sourceMapHash);
}
function artifactsFingerprint(artifacts: readonly CompilerBuildArtifactFingerprint[]): readonly CompilerBuildArtifactFingerprint[] {
    if (artifacts.some(item => !validArtifact(item))) { throw new Error('Invalid compiler artifact path or fingerprint.'); }
    const paths = artifacts.flatMap(item => [item.feature, item.sourceMap]);
    if (new Set(paths).size !== paths.length) { throw new Error('Duplicate compiler artifact path.'); }
    return Object.freeze(artifacts.map(item => Object.freeze({ worker: item.worker, feature: item.feature, sourceMap: item.sourceMap,
        featureHash: item.featureHash, sourceMapHash: item.sourceMapHash })).sort((a, b) => compare(a.feature, b.feature)));
}
export function fingerprintCompilerBuildArtifact(worker: number, feature: string, featureContent: Bytes, sourceMap: string, sourceMapContent: Bytes): CompilerBuildArtifactFingerprint {
    return artifactsFingerprint([{ worker, feature, sourceMap, featureHash: hash(featureContent), sourceMapHash: hash(sourceMapContent) }])[0];
}

/** Publish only after successful merge/postprocessing and a second comparison of the original inputs. */
export function createCompilerBuildManifest(options: {
    before: CompilerBuildInputFingerprint; after: CompilerBuildInputFingerprint;
    artifacts: readonly CompilerBuildArtifactFingerprint[]; successful: boolean;
}): CompilerBuildManifest | undefined {
    if (!options.successful || options.before.digest !== options.after.digest || !options.artifacts.length) { return undefined; }
    const inputs = inputFingerprint(options.before.configurationHash, options.before.files);
    if (inputs.digest !== options.before.digest) { return undefined; }
    return Object.freeze({ schemaVersion: 1, inputs, artifacts: artifactsFingerprint(options.artifacts) });
}

/** Existing .str files and unknown/partial manifest versions never establish freshness. */
export function parseCompilerBuildManifest(text: string): CompilerBuildManifest | undefined {
    try {
        const value: unknown = JSON.parse(text);
        if (!record(value) || value.schemaVersion !== 1 || !record(value.inputs) || !isHash(value.inputs.configurationHash) ||
            !isHash(value.inputs.digest) || !Array.isArray(value.inputs.files) || !Array.isArray(value.artifacts) || !value.artifacts.length) { return undefined; }
        const files = value.inputs.files;
        if (files.some(file => !record(file) || typeof file.uri !== 'string' || !isHash(file.sha256))) { return undefined; }
        const inputs = inputFingerprint(value.inputs.configurationHash, files as CompilerBuildFileFingerprint[]);
        if (inputs.digest !== value.inputs.digest) { return undefined; }
        return Object.freeze({ schemaVersion: 1, inputs, artifacts: artifactsFingerprint(value.artifacts) });
    } catch { return undefined; }
}

export function verifyCompilerBuildManifest(manifest: CompilerBuildManifest | undefined, current: CompilerBuildInputFingerprint,
    artifacts: readonly CompilerBuildArtifactFingerprint[]): 'fresh' | 'missing' | 'inputsChanged' | 'artifactsChanged' {
    if (!manifest) { return 'missing'; }
    if (manifest.inputs.digest !== current.digest) { return 'inputsChanged'; }
    try {
        return JSON.stringify(artifactsFingerprint(artifacts)) === JSON.stringify(manifest.artifacts) ? 'fresh' : 'artifactsChanged';
    } catch { return 'artifactsChanged'; }
}
