import { createHash } from 'node:crypto';
import { findCompilerSourceLocation, parseCompilerSourceMap } from './compilerArtifacts';
import { fingerprintCompilerBuildArtifact, parseCompilerBuildManifest, verifyCompilerBuildManifest, type CompilerBuildInputFingerprint, type CompilerBuildManifest } from './compilerBuildManifest';
import { getCompilerScenarioBody, scanCompilerLines } from './scenarioCompilerSyntax';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { isExecutableFeatureLine } from './vanessaControlFeature';

export interface CompilerControlArtifact {
    readonly worker: number; readonly feature: string; readonly sourceMap: string;
    readonly featureContent: string; readonly sourceMapContent: string;
}
export interface CompilerControlMappingContext {
    readonly inputs: CompilerBuildInputFingerprint;
    readonly manifest: CompilerBuildManifest | undefined;
    readonly artifacts: readonly CompilerControlArtifact[];
    readonly sources: readonly { readonly uri: string; readonly text: string }[];
}
export interface CompilerControlFeatureLocation { readonly worker: number; readonly feature: string; readonly lineNumber: number }
export interface CompilerControlYamlLocation { readonly uri: string; readonly lineIndex: number }
type StaleMapping = { readonly kind: 'stale'; readonly reason: 'missing' | 'inputsChanged' | 'artifactsChanged' | 'sourceChanged' };
export type CompilerControlMapping<T> = StaleMapping | { readonly kind: 'unmapped' } | { readonly kind: 'unique'; readonly location: T }
    | { readonly kind: 'ambiguous'; readonly locations: readonly T[] };
const unmapped = Object.freeze({ kind: 'unmapped' as const });
interface SourceDetails { readonly uri: string; readonly text: string; readonly uid: string; readonly body: NonNullable<ReturnType<typeof getCompilerScenarioBody>> }
const prepared = new WeakMap<CompilerControlMappingContext, { readonly invalid: StaleMapping | undefined;
    readonly sources: readonly SourceDetails[]; readonly maps: ReadonlyMap<CompilerControlArtifact, ReturnType<typeof parseCompilerSourceMap>> }>();

/** Index captured bytes once. Filesystem freshness must still be re-captured before a new command. */
export function prepareCompilerControlMappingContext<T extends CompilerControlMappingContext>(context: T): T {
    const captured = Object.freeze({ ...context,
        inputs: Object.freeze({ ...context.inputs, files: Object.freeze(context.inputs.files.map(file => Object.freeze({ uri: file.uri, sha256: file.sha256 }))) }),
        manifest: context.manifest ? parseCompilerBuildManifest(JSON.stringify(context.manifest)) : undefined,
        sources: Object.freeze(context.sources.map(source => Object.freeze({ uri: source.uri, text: source.text }))),
        artifacts: Object.freeze(context.artifacts.map(item => Object.freeze({ worker: item.worker, feature: item.feature, sourceMap: item.sourceMap,
            featureContent: item.featureContent, sourceMapContent: item.sourceMapContent })))
    }) as T;
    const invalid = stale(captured);
    prepared.set(captured, { invalid, sources: invalid ? [] : sourceDetails(captured),
        maps: new Map(captured.artifacts.map(item => [item, parseCompilerSourceMap(item.sourceMapContent)])) });
    return captured;
}

function sourceMap(context: CompilerControlMappingContext, artifact: CompilerControlArtifact) {
    const cached = prepared.get(context);
    return cached ? cached.maps.get(artifact) ?? null : parseCompilerSourceMap(artifact.sourceMapContent);
}

/** Check captured bytes at command time, never from a recurring UI state poll. */
function stale(context: CompilerControlMappingContext): StaleMapping | undefined {
    const cached = prepared.get(context); if (cached) { return cached.invalid; }
    try {
        const state = verifyCompilerBuildManifest(context.manifest, context.inputs, context.artifacts.map(item =>
            fingerprintCompilerBuildArtifact(item.worker, item.feature, item.featureContent, item.sourceMap, item.sourceMapContent)));
        if (state !== 'fresh') { return { kind: 'stale', reason: state }; }
    } catch { return { kind: 'stale', reason: 'artifactsChanged' }; }
    const fingerprints = new Map(context.inputs.files.map(file => [file.uri, file.sha256]));
    if (new Set(context.sources.map(source => source.uri)).size !== context.sources.length || context.sources.some(source =>
        fingerprints.get(source.uri) !== createHash('sha256').update(source.text).digest('hex'))) { return { kind: 'stale', reason: 'sourceChanged' }; }
    return undefined;
}
function sourceDetails(context: CompilerControlMappingContext): readonly SourceDetails[] {
    const cached = prepared.get(context); if (cached) { return cached.sources; }
    return context.sources.flatMap(source => {
        const field = ScenarioYamlDocument.parse(source.text).findField('ДанныеСценария', 'UID');
        const body = getCompilerScenarioBody(source.text);
        if (!field || field.ambiguous || typeof field.value !== 'string' || !field.value.trim() || !body) { return []; }
        return [{ ...source, uid: field.value.trim().toLowerCase(), body }];
    });
}
function executable(artifact: CompilerControlArtifact, lineNumber: number): boolean {
    return Number.isSafeInteger(lineNumber) && lineNumber > 0 && isExecutableFeatureLine({ uri: 'file:///' + artifact.feature,
        filePath: artifact.feature, text: artifact.featureContent, dirty: false, version: 0, line: lineNumber - 1 }, lineNumber - 1);
}
function result<T>(locations: readonly T[]): CompilerControlMapping<T> {
    if (!locations.length) { return unmapped; }
    const frozen = Object.freeze(locations.map(location => Object.freeze(location)));
    return frozen.length === 1 ? { kind: 'unique', location: frozen[0] } : { kind: 'ambiguous', locations: frozen };
}

/** Preserve every invocation/variant; choosing the first occurrence would execute an arbitrary call. */
export function mapYamlLineToFeatures(context: CompilerControlMappingContext, uri: string, lineIndex: number): CompilerControlMapping<CompilerControlFeatureLocation> {
    const invalid = stale(context); if (invalid) { return invalid; }
    if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) { return unmapped; }
    const sources = sourceDetails(context);
    const source = sources.find(item => item.uri === uri);
    if (!source || sources.filter(item => item.uid === source.uid).length !== 1) { return unmapped; }
    const offset = lineIndex - source.body.startLine;
    if (offset < 0 || offset >= source.body.lines.length || !source.body.lines[offset].trim() || scanCompilerLines(source.body.lines)[offset].kind !== 'code') { return unmapped; }
    const locations = new Map<string, CompilerControlFeatureLocation>();
    for (const artifact of context.artifacts) {
        const map = sourceMap(context, artifact);
        for (const entry of map?.entries ?? []) {
            if (entry.scenarioUid.toLowerCase() === source.uid && entry.sourceBodyLineNumber === offset + 1 && executable(artifact, entry.featureLineNumber)) {
                const location = { worker: artifact.worker, feature: artifact.feature, lineNumber: entry.featureLineNumber };
                locations.set(JSON.stringify(location), location);
            }
        }
    }
    return result([...locations.values()].sort((a, b) => a.worker - b.worker || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0) || a.lineNumber - b.lineNumber));
}

/** Runtime lines map to the deepest exact source; line numbers in source bodies are one-based. */
export function mapFeatureLineToYaml(context: CompilerControlMappingContext, worker: number, feature: string,
    lineNumber: number): CompilerControlMapping<CompilerControlYamlLocation> {
    const invalid = stale(context); if (invalid) { return invalid; }
    const artifact = context.artifacts.find(item => item.worker === worker && item.feature === feature);
    if (!artifact || !executable(artifact, lineNumber)) { return unmapped; }
    const entry = findCompilerSourceLocation(sourceMap(context, artifact), lineNumber);
    if (!entry) { return unmapped; }
    const sources = sourceDetails(context).filter(source => source.uid === entry.scenarioUid.toLowerCase());
    if (sources.length !== 1) { return unmapped; }
    const source = sources[0];
    const offset = entry.sourceBodyLineNumber - 1;
    if (offset < 0 || offset >= source.body.lines.length || !source.body.lines[offset].trim() || scanCompilerLines(source.body.lines)[offset].kind !== 'code') { return unmapped; }
    return result([{ uri: source.uri, lineIndex: source.body.startLine + offset }]);
}
