import { createHash } from 'node:crypto';
import {
    normalizeProjectDefinitionTemplate,
    type ProjectDefinition,
    type ProjectDefinitionFileRecord,
    type ProjectDefinitionLocation,
    type ProjectDefinitionRange,
    type ProjectDefinitionSnapshot,
    type ProjectDefinitionWarning
} from './projectDefinition';

export interface ProjectDefinitionSnapshotInput {
    readonly configurationIdentity: string;
    readonly workspaceFolderUri: string;
    readonly profileId: string;
    readonly generation: number;
    readonly parserVersion: string;
    readonly files: readonly ProjectDefinitionFileRecord[];
    readonly warnings?: readonly ProjectDefinitionWarning[];
}

export interface ProjectDefinitionFileRemoval {
    readonly uri: string;
    readonly removed: true;
}

export type ProjectDefinitionFileUpdate = ProjectDefinitionFileRecord | ProjectDefinitionFileRemoval;

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
    readonly #values: Map<K, V>;

    constructor(entries: Iterable<readonly [K, V]>) {
        this.#values = new Map(entries);
        Object.freeze(this);
    }

    get size(): number {
        return this.#values.size;
    }

    get(key: K): V | undefined {
        return this.#values.get(key);
    }

    has(key: K): boolean {
        return this.#values.has(key);
    }

    entries(): MapIterator<[K, V]> {
        return this.#values.entries();
    }

    keys(): MapIterator<K> {
        return this.#values.keys();
    }

    values(): MapIterator<V> {
        return this.#values.values();
    }

    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
        for (const [key, value] of this.#values) {
            callbackfn.call(thisArg, value, key, this);
        }
    }

    [Symbol.iterator](): MapIterator<[K, V]> {
        return this.entries();
    }

    get [Symbol.toStringTag](): string {
        return 'ImmutableMap';
    }
}

interface SnapshotMetadata {
    readonly configurationWarnings: readonly ProjectDefinitionWarning[];
}

const snapshotMetadata = new WeakMap<ProjectDefinitionSnapshot, SnapshotMetadata>();
const frozenRecords = new WeakSet<ProjectDefinitionFileRecord>();

function immutableMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
    return new ImmutableMap(entries);
}

function freezeRange(value: ProjectDefinitionRange): ProjectDefinitionRange {
    return Object.freeze({
        start: Object.freeze({ ...value.start }),
        end: Object.freeze({ ...value.end })
    });
}

function freezeLocation(value: ProjectDefinitionLocation | undefined): ProjectDefinitionLocation | undefined {
    return value ? Object.freeze({ uri: value.uri, range: freezeRange(value.range) }) : undefined;
}

function freezeDefinition(value: ProjectDefinition): ProjectDefinition {
    return Object.freeze({
        ...value,
        parameters: Object.freeze(value.parameters.map(parameter => Object.freeze({ ...parameter }))),
        definitionLocation: freezeLocation(value.definitionLocation),
        implementationLocation: freezeLocation(value.implementationLocation)
    });
}

function freezeWarning(value: ProjectDefinitionWarning): ProjectDefinitionWarning {
    return Object.freeze({
        uri: value.uri,
        message: value.message,
        range: value.range ? freezeRange(value.range) : undefined
    });
}

function freezeRecord(value: ProjectDefinitionFileRecord): ProjectDefinitionFileRecord {
    if (frozenRecords.has(value)) {
        return value;
    }
    const record = Object.freeze({
        uri: value.uri,
        size: value.size,
        mtimeMs: value.mtimeMs,
        parserVersion: value.parserVersion,
        definitions: Object.freeze(value.definitions.map(freezeDefinition)),
        warnings: Object.freeze(value.warnings.map(freezeWarning))
    });
    frozenRecords.add(record);
    return record;
}

function normalizedUri(value: string): string {
    return value
        .trim()
        .replace(/\\/gu, '/')
        .replace(/^file:\/\/\/([A-Z]):\//u, (_match, drive: string) => `file:///${drive.toLowerCase()}:/`)
        .toLocaleLowerCase();
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right);
}

function compareRecords(left: ProjectDefinitionFileRecord, right: ProjectDefinitionFileRecord): number {
    return compareText(normalizedUri(left.uri), normalizedUri(right.uri))
        || compareText(left.uri, right.uri)
        || left.mtimeMs - right.mtimeMs
        || left.size - right.size;
}

function definitionLine(value: ProjectDefinition): number {
    return value.definitionLocation?.range.start.line
        ?? value.implementationLocation?.range.start.line
        ?? Number.MAX_SAFE_INTEGER;
}

function definitionCharacter(value: ProjectDefinition): number {
    return value.definitionLocation?.range.start.character
        ?? value.implementationLocation?.range.start.character
        ?? Number.MAX_SAFE_INTEGER;
}

function compareDefinitions(left: ProjectDefinition, right: ProjectDefinition): number {
    return definitionLine(left) - definitionLine(right)
        || definitionCharacter(left) - definitionCharacter(right)
        || compareText(left.id, right.id);
}

function warningKey(value: ProjectDefinitionWarning): string {
    const start = value.range?.start;
    const end = value.range?.end;
    return [
        normalizedUri(value.uri ?? ''),
        value.message,
        start?.line ?? '',
        start?.character ?? '',
        end?.line ?? '',
        end?.character ?? ''
    ].join('\0');
}

function deduplicateWarnings(values: readonly ProjectDefinitionWarning[]): readonly ProjectDefinitionWarning[] {
    const unique = new Map<string, ProjectDefinitionWarning>();
    for (const warning of values) {
        const key = warningKey(warning);
        if (!unique.has(key)) {
            unique.set(key, freezeWarning(warning));
        }
    }
    return Object.freeze([...unique.values()].sort((left, right) =>
        compareText(normalizedUri(left.uri ?? ''), normalizedUri(right.uri ?? ''))
        || compareText(left.message, right.message)
        || (left.range?.start.line ?? -1) - (right.range?.start.line ?? -1)
        || (left.range?.start.character ?? -1) - (right.range?.start.character ?? -1)
    ));
}

function recordFingerprint(value: ProjectDefinitionFileRecord): string {
    return JSON.stringify({
        uri: normalizedUri(value.uri),
        size: value.size,
        mtimeMs: value.mtimeMs,
        parserVersion: value.parserVersion,
        definitions: value.definitions.map(definition => ({
            id: definition.id,
            template: definition.normalizedTemplate,
            kind: definition.kind,
            range: definition.definitionLocation?.range
        })),
        warnings: value.warnings.map(warningKey)
    });
}

function snapshotIdentity(
    input: Pick<ProjectDefinitionSnapshotInput, 'configurationIdentity' | 'parserVersion' | 'workspaceFolderUri' | 'profileId'>,
    records: readonly ProjectDefinitionFileRecord[],
    warnings: readonly ProjectDefinitionWarning[]
): string {
    const hash = createHash('sha256');
    hash.update(input.configurationIdentity, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(input.parserVersion, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(normalizedUri(input.workspaceFolderUri), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(input.profileId, 'utf8');
    for (const record of records) {
        hash.update('\0', 'utf8');
        hash.update(recordFingerprint(record), 'utf8');
    }
    for (const warning of warnings) {
        hash.update('\0warning\0', 'utf8');
        hash.update(warningKey(warning), 'utf8');
    }
    return `project-definitions:${hash.digest('hex')}`;
}

function selectDeterministicRecords(
    values: readonly ProjectDefinitionFileRecord[]
): readonly ProjectDefinitionFileRecord[] {
    const sorted = values.map(freezeRecord).sort((left, right) =>
        compareRecords(left, right) || compareText(recordFingerprint(left), recordFingerprint(right))
    );
    const selected = new Map<string, ProjectDefinitionFileRecord>();
    for (const record of sorted) {
        selected.set(normalizedUri(record.uri), record);
    }
    return Object.freeze([...selected.values()].sort(compareRecords));
}

export function buildProjectDefinitionSnapshot(
    input: ProjectDefinitionSnapshotInput
): ProjectDefinitionSnapshot {
    const records = selectDeterministicRecords(input.files);
    const files = immutableMap(records.map(record => [record.uri, record] as const));
    const definitions: ProjectDefinition[] = [];
    const bySourceEntries: Array<readonly [string, readonly ProjectDefinition[]]> = [];

    for (const record of records) {
        const ordered = Object.freeze([...record.definitions].sort(compareDefinitions));
        definitions.push(...ordered);
        bySourceEntries.push([record.uri, ordered]);
    }
    const frozenDefinitions = Object.freeze(definitions);
    const byIdEntries: Array<readonly [string, ProjectDefinition]> = [];
    const byTemplate = new Map<string, ProjectDefinition[]>();
    for (const definition of frozenDefinitions) {
        byIdEntries.push([definition.id, definition]);
        const key = definition.normalizedTemplate
            || normalizeProjectDefinitionTemplate(definition.template);
        const bucket = byTemplate.get(key) ?? [];
        bucket.push(definition);
        byTemplate.set(key, bucket);
    }
    const templateEntries: Array<readonly [string, readonly ProjectDefinition[]]> = [];
    for (const [key, bucket] of byTemplate) {
        templateEntries.push([key, Object.freeze(bucket)]);
    }

    const configurationWarnings = deduplicateWarnings(input.warnings ?? []);
    const warnings = deduplicateWarnings([
        ...configurationWarnings,
        ...records.flatMap(record => record.warnings)
    ]);
    const snapshot: ProjectDefinitionSnapshot = Object.freeze({
        identity: snapshotIdentity(input, records, warnings),
        configurationIdentity: input.configurationIdentity,
        parserVersion: input.parserVersion,
        workspaceFolderUri: input.workspaceFolderUri,
        profileId: input.profileId,
        generation: input.generation,
        definitions: frozenDefinitions,
        files,
        warnings,
        byId: immutableMap(byIdEntries),
        byNormalizedTemplate: immutableMap(templateEntries),
        bySourceUri: immutableMap(bySourceEntries)
    });
    snapshotMetadata.set(snapshot, { configurationWarnings });
    return snapshot;
}

function isRemoval(value: ProjectDefinitionFileUpdate): value is ProjectDefinitionFileRemoval {
    return 'removed' in value && value.removed;
}

function recordsHaveSameCacheIdentity(
    left: ProjectDefinitionFileRecord,
    right: ProjectDefinitionFileRecord
): boolean {
    return normalizedUri(left.uri) === normalizedUri(right.uri)
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.parserVersion === right.parserVersion;
}

export function updateProjectDefinitionSnapshot(
    previous: ProjectDefinitionSnapshot,
    fileResult: ProjectDefinitionFileUpdate
): ProjectDefinitionSnapshot {
    const records = new Map<string, ProjectDefinitionFileRecord>();
    for (const record of previous.files.values()) {
        records.set(normalizedUri(record.uri), record);
    }
    const key = normalizedUri(fileResult.uri);
    if (isRemoval(fileResult)) {
        records.delete(key);
    } else {
        const existing = records.get(key);
        records.set(key, existing && recordsHaveSameCacheIdentity(existing, fileResult)
            ? existing
            : freezeRecord(fileResult));
    }

    return buildProjectDefinitionSnapshot({
        configurationIdentity: previous.configurationIdentity,
        workspaceFolderUri: previous.workspaceFolderUri,
        profileId: previous.profileId,
        generation: previous.generation + 1,
        parserVersion: previous.parserVersion,
        files: [...records.values()],
        warnings: snapshotMetadata.get(previous)?.configurationWarnings ?? []
    });
}
