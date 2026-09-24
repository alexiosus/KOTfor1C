import { createHash } from 'node:crypto';

export type ProjectDefinitionKind =
    | 'builtInStep'
    | 'userStep'
    | 'exportScenario'
    | 'nestedScenario';

export interface ProjectDefinitionPosition {
    readonly line: number;
    readonly character: number;
}

export interface ProjectDefinitionRange {
    readonly start: ProjectDefinitionPosition;
    readonly end: ProjectDefinitionPosition;
}

export interface ProjectDefinitionLocation {
    readonly uri: string;
    readonly range: ProjectDefinitionRange;
}

export interface ProjectDefinitionParameter {
    readonly name: string;
    readonly index: number;
    readonly source: 'quoted' | 'outline' | 'snippet';
    readonly defaultValue?: string;
}

export interface ProjectDefinition {
    readonly id: string;
    readonly kind: ProjectDefinitionKind;
    readonly template: string;
    readonly normalizedTemplate: string;
    readonly language?: 'ru' | 'en';
    readonly parameters: readonly ProjectDefinitionParameter[];
    readonly description?: string;
    readonly category?: string;
    readonly usageExample?: string;
    readonly sourceLabel: string;
    readonly workspaceFolderUri?: string;
    readonly profileId?: string;
    readonly libraryRootUri?: string;
    readonly definitionLocation?: ProjectDefinitionLocation;
    readonly implementationLocation?: ProjectDefinitionLocation;
}

export interface ProjectDefinitionWarning {
    readonly uri?: string;
    readonly message: string;
    readonly range?: ProjectDefinitionRange;
}

export interface ProjectDefinitionFileRecord {
    readonly uri: string;
    readonly size: number;
    readonly mtimeMs: number;
    readonly parserVersion: string;
    readonly definitions: readonly ProjectDefinition[];
    readonly warnings: readonly ProjectDefinitionWarning[];
}

export interface ProjectDefinitionSnapshot {
    readonly identity: string;
    readonly configurationIdentity: string;
    readonly parserVersion: string;
    readonly workspaceFolderUri: string;
    readonly profileId: string;
    readonly generation: number;
    readonly definitions: readonly ProjectDefinition[];
    readonly files: ReadonlyMap<string, ProjectDefinitionFileRecord>;
    readonly warnings: readonly ProjectDefinitionWarning[];
    readonly byId: ReadonlyMap<string, ProjectDefinition>;
    readonly byNormalizedTemplate: ReadonlyMap<string, readonly ProjectDefinition[]>;
    readonly bySourceUri: ReadonlyMap<string, readonly ProjectDefinition[]>;
}

export interface ProjectDefinitionView {
    readonly identity: string;
    readonly all: readonly ProjectDefinition[];
    readonly byId: ReadonlyMap<string, ProjectDefinition>;
    readonly byNormalizedTemplate: ReadonlyMap<string, readonly ProjectDefinition[]>;
}

export interface ProjectDefinitionMatch {
    readonly definition: ProjectDefinition;
    readonly invocationRange: { readonly start: number; readonly end: number };
    readonly arguments: readonly {
        readonly parameter: ProjectDefinitionParameter;
        readonly value: string;
        readonly start: number;
        readonly end: number;
    }[];
}

export type ProjectDefinitionResolution =
    | { readonly kind: 'missing'; readonly invocation: string }
    | { readonly kind: 'unique'; readonly match: ProjectDefinitionMatch }
    | { readonly kind: 'ambiguous'; readonly matches: readonly ProjectDefinitionMatch[] };

export interface LocalDefinitionIdentityInput {
    readonly kind: Exclude<ProjectDefinitionKind, 'builtInStep'>;
    readonly sourceUri: string;
    readonly range: ProjectDefinitionRange;
    readonly signature: string;
}

export function normalizeProjectDefinitionTemplate(value: string): string {
    return value
        .replace(/\r\n?/g, '\n')
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizeDefinitionUri(value: string): string {
    let normalized = value.trim().replace(/\\/g, '/');
    normalized = normalized.replace(/^file:\/{2}([A-Za-z]:\/)/i, 'file:///$1');
    normalized = normalized.replace(/^file:\/{4,}([A-Za-z]:\/)/i, 'file:///$1');
    return normalized.replace(/^file:\/\/\/([A-Z]):\//, (_match, drive: string) =>
        `file:///${drive.toLowerCase()}:/`
    );
}

export function createLocalDefinitionId(input: LocalDefinitionIdentityInput): string {
    const normalizedSignature = normalizeProjectDefinitionTemplate(input.signature);
    const identity = [
        input.kind,
        normalizeDefinitionUri(input.sourceUri),
        input.range.start.line,
        input.range.start.character,
        input.range.end.line,
        input.range.end.character,
        normalizedSignature
    ].join('\0');
    return `${input.kind}:${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

export function createProjectDefinitionView(
    identity: string,
    definitions: readonly ProjectDefinition[]
): ProjectDefinitionView {
    const all = Object.freeze(Array.from(definitions));
    const byId = new Map<string, ProjectDefinition>();
    const mutableByTemplate = new Map<string, ProjectDefinition[]>();

    for (const definition of all) {
        byId.set(definition.id, definition);
        const key = definition.normalizedTemplate || normalizeProjectDefinitionTemplate(definition.template);
        const bucket = mutableByTemplate.get(key) ?? [];
        bucket.push(definition);
        mutableByTemplate.set(key, bucket);
    }

    const byNormalizedTemplate = new Map<string, readonly ProjectDefinition[]>();
    for (const [key, bucket] of mutableByTemplate) {
        byNormalizedTemplate.set(key, Object.freeze(bucket.slice()));
    }

    return Object.freeze({ identity, all, byId, byNormalizedTemplate });
}
