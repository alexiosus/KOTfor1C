import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
    ProjectDefinition,
    ProjectDefinitionFileRecord,
    ProjectDefinitionLocation,
    ProjectDefinitionWarning
} from './projectDefinition';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'cache.json';

interface ProjectDefinitionCachePayload {
    readonly schemaVersion: number;
    readonly configurationIdentity: string;
    readonly parserVersion: string;
    readonly records: readonly ProjectDefinitionFileRecord[];
}

export interface ProjectDefinitionCacheLocationInput {
    readonly storagePath?: string;
    readonly globalStoragePath: string;
    readonly workspaceFolderUri: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): boolean {
    return isObject(value)
        && Number.isInteger(value.line)
        && (value.line as number) >= 0
        && Number.isInteger(value.character)
        && (value.character as number) >= 0;
}

function isRange(value: unknown): boolean {
    return isObject(value) && isPosition(value.start) && isPosition(value.end);
}

function isLocation(value: unknown): value is ProjectDefinitionLocation {
    return isObject(value) && typeof value.uri === 'string' && isRange(value.range);
}

function isWarning(value: unknown): value is ProjectDefinitionWarning {
    return isObject(value)
        && typeof value.message === 'string'
        && (value.uri === undefined || typeof value.uri === 'string')
        && (value.range === undefined || isRange(value.range));
}

function isDefinition(value: unknown): value is ProjectDefinition {
    if (!isObject(value)) {
        return false;
    }
    const kinds = new Set(['builtInStep', 'userStep', 'exportScenario', 'nestedScenario']);
    if (
        typeof value.id !== 'string'
        || typeof value.kind !== 'string'
        || !kinds.has(value.kind)
        || typeof value.template !== 'string'
        || typeof value.normalizedTemplate !== 'string'
        || typeof value.sourceLabel !== 'string'
        || !Array.isArray(value.parameters)
    ) {
        return false;
    }
    const parametersAreValid = value.parameters.every(parameter =>
        isObject(parameter)
        && typeof parameter.name === 'string'
        && Number.isInteger(parameter.index)
        && ['quoted', 'outline', 'snippet'].includes(parameter.source as string)
    );
    return parametersAreValid
        && (value.language === undefined || value.language === 'ru' || value.language === 'en')
        && (value.description === undefined || typeof value.description === 'string')
        && (value.category === undefined || typeof value.category === 'string')
        && (value.workspaceFolderUri === undefined || typeof value.workspaceFolderUri === 'string')
        && (value.profileId === undefined || typeof value.profileId === 'string')
        && (value.libraryRootUri === undefined || typeof value.libraryRootUri === 'string')
        && (value.definitionLocation === undefined || isLocation(value.definitionLocation))
        && (value.implementationLocation === undefined || isLocation(value.implementationLocation));
}

function isFileRecord(value: unknown): value is ProjectDefinitionFileRecord {
    return isObject(value)
        && typeof value.uri === 'string'
        && typeof value.size === 'number'
        && Number.isFinite(value.size)
        && value.size >= 0
        && typeof value.mtimeMs === 'number'
        && Number.isFinite(value.mtimeMs)
        && typeof value.parserVersion === 'string'
        && Array.isArray(value.definitions)
        && value.definitions.every(isDefinition)
        && Array.isArray(value.warnings)
        && value.warnings.every(isWarning);
}

export function parseProjectDefinitionCache(
    source: string,
    configurationIdentity: string,
    parserVersion: string
): readonly ProjectDefinitionFileRecord[] | null {
    try {
        const parsed = JSON.parse(source) as unknown;
        if (
            !isObject(parsed)
            || parsed.schemaVersion !== CACHE_SCHEMA_VERSION
            || parsed.configurationIdentity !== configurationIdentity
            || parsed.parserVersion !== parserVersion
            || !Array.isArray(parsed.records)
            || !parsed.records.every(isFileRecord)
        ) {
            return null;
        }
        return parsed.records;
    } catch {
        return null;
    }
}

export function resolveProjectDefinitionCacheDirectory(
    input: ProjectDefinitionCacheLocationInput
): string {
    if (input.storagePath) {
        return path.join(input.storagePath, 'project-definitions');
    }
    const workspaceHash = createHash('sha256')
        .update(input.workspaceFolderUri, 'utf8')
        .digest('hex')
        .slice(0, 24);
    return path.join(input.globalStoragePath, 'project-definitions', workspaceHash);
}

export class ProjectDefinitionCache {
    readonly #filePath: string;

    constructor(readonly directoryPath: string) {
        this.#filePath = path.join(directoryPath, CACHE_FILE_NAME);
    }

    async load(
        configurationIdentity: string,
        parserVersion: string
    ): Promise<readonly ProjectDefinitionFileRecord[] | null> {
        try {
            const source = await fs.readFile(this.#filePath, 'utf8');
            return parseProjectDefinitionCache(source, configurationIdentity, parserVersion);
        } catch {
            return null;
        }
    }

    async save(
        configurationIdentity: string,
        parserVersion: string,
        records: readonly ProjectDefinitionFileRecord[]
    ): Promise<void> {
        const payload: ProjectDefinitionCachePayload = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            configurationIdentity,
            parserVersion,
            records
        };
        await fs.mkdir(this.directoryPath, { recursive: true });
        const temporaryPath = path.join(
            this.directoryPath,
            `${CACHE_FILE_NAME}.tmp-${process.pid}-${Date.now()}`
        );
        try {
            await fs.writeFile(temporaryPath, JSON.stringify(payload), 'utf8');
            await fs.rename(temporaryPath, this.#filePath);
        } catch (error) {
            await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}
