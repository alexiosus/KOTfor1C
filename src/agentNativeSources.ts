import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { findCompilerSourceLocation, parseCompilerSourceMap } from './compilerArtifacts';
import { sameProjectDefinitionSource } from './projectDefinition';
import { isExecutableFeatureLine } from './vanessaControlFeature';
import type { CompilerControlMappingContext, CompilerControlFeatureLocation } from './vanessaControlSourceMapping';

export interface AgentNativeSource { readonly metadataUri: string; readonly metadata: string; readonly scriptUri: string; readonly script: string }
const identities = new WeakMap<AgentNativeSource, { metadata: string; uid: string }>();
const identity = (source: AgentNativeSource) => {
    const cached = identities.get(source); if (cached?.metadata === source.metadata) { return cached.uid; }
    const field = ScenarioYamlDocument.parse(source.metadata).findField('ДанныеСценария', 'UID');
    const uid = field && !field.ambiguous && typeof field.value === 'string' ? field.value.trim().toLowerCase() : '';
    identities.set(source, { metadata: source.metadata, uid }); return uid;
};
const executable = (text: string, line: number) => isExecutableFeatureLine({ uri: 'file:///runtime.feature', filePath: '/runtime.feature', text, dirty: false, version: 0, line: line - 1 }, line - 1);
// Native scen.feature contains only the scenario body, without a Feature header.
const executableNative = (text: string, line: number) => executable('Feature: Native\nScenario: Native\n' + text, line + 2);

/** Native scripts are the exact SPPR body: STR body lines map directly to script lines. */
export function mapAgentNativeLine(context: Pick<CompilerControlMappingContext, 'artifacts'>, sources: readonly AgentNativeSource[], uri: string, lineIndex: number): readonly CompilerControlFeatureLocation[] {
    const source = sources.find(item => sameProjectDefinitionSource(item.scriptUri, uri));
    if (!source || !Number.isSafeInteger(lineIndex) || lineIndex < 0 || !executableNative(source.script, lineIndex + 1)) { return []; }
    const uid = identity(source);
    if (!uid || sources.filter(item => identity(item) === uid).length !== 1) { return []; }
    const found = new Map<string, CompilerControlFeatureLocation>();
    for (const artifact of context.artifacts) {
        for (const entry of parseCompilerSourceMap(artifact.sourceMapContent)?.entries ?? []) {
            if (entry.scenarioUid.toLowerCase() === uid && entry.sourceBodyLineNumber === lineIndex + 1 && executable(artifact.featureContent, entry.featureLineNumber)) {
                const location = { worker: artifact.worker, feature: artifact.feature, lineNumber: entry.featureLineNumber }; found.set(JSON.stringify(location), location);
            }
        }
    }
    return [...found.values()].sort((left, right) => left.worker - right.worker || left.feature.localeCompare(right.feature) || left.lineNumber - right.lineNumber);
}

export function mapAgentNativeFailure(context: Pick<CompilerControlMappingContext, 'artifacts'>, sources: readonly AgentNativeSource[], worker: number, feature: string, line: number) {
    const artifact = context.artifacts.find(item => item.worker === worker && item.feature === feature);
    const entry = artifact && findCompilerSourceLocation(parseCompilerSourceMap(artifact.sourceMapContent), line);
    if (!entry) { return { kind: 'unmapped' as const }; }
    const matches = sources.filter(item => identity(item) === entry.scenarioUid.toLowerCase());
    if (matches.length !== 1 || !executableNative(matches[0].script, entry.sourceBodyLineNumber)) { return { kind: 'unmapped' as const }; }
    return { kind: 'unique' as const, location: { uri: matches[0].scriptUri, lineIndex: entry.sourceBodyLineNumber - 1 } };
}
