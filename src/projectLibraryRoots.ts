import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
    AdditionalVanessaParameter,
    YamlParameter
} from './yamlParametersManager';
import {
    applyAdditionalVanessaParameters,
    findObjectKeyByAlias,
    type JsonValue
} from './vanessaLaunchJson';

type PathApi = Pick<typeof path.posix, 'delimiter' | 'isAbsolute' | 'normalize' | 'resolve' | 'sep'>;

export interface ProjectLibraryConfigurationInput {
    readonly workspaceFolderPath: string;
    readonly workspaceFolderUri?: string;
    readonly profileId: string;
    readonly buildParameters: readonly YamlParameter[];
    readonly additionalVanessaParameters: readonly AdditionalVanessaParameter[];
    readonly pathApi?: PathApi;
}

export interface ProjectLibraryConfiguration {
    readonly identity: string;
    readonly workspaceFolderPath: string;
    readonly workspaceFolderUri?: string;
    readonly profileId: string;
    readonly libraryRootPaths: readonly string[];
    readonly featureFolderPaths: readonly string[];
    readonly vanessaInstallationCandidates: readonly string[];
    readonly warnings: readonly string[];
}

const PROJECT_TOKEN = /^#(?:SourcesPath|Libraries)(?=$|[\\/])/i;
const UNRESOLVED_TOKEN = /(?:^|[\\/])#[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_-]*(?=$|[\\/])/u;

function findBuildParameter(
    parameters: readonly YamlParameter[],
    aliases: readonly string[]
): string {
    const normalizedAliases = new Set(aliases.map(alias => alias.toLocaleLowerCase()));
    return parameters.find(parameter => normalizedAliases.has(parameter.key.trim().toLocaleLowerCase()))?.value ?? '';
}

function getEffectiveAdditionalValue(
    parameters: readonly AdditionalVanessaParameter[],
    alias: string
): JsonValue | undefined {
    const transformed = applyAdditionalVanessaParameters({}, parameters);
    if (!transformed.value || typeof transformed.value !== 'object' || Array.isArray(transformed.value)) {
        return undefined;
    }
    const container = transformed.value as Record<string, JsonValue>;
    const key = findObjectKeyByAlias(container, alias);
    return key ? container[key] : undefined;
}

function parsePathValues(value: JsonValue | undefined, delimiter: string): string[] {
    if (Array.isArray(value)) {
        return value
            .filter((entry): entry is string => typeof entry === 'string')
            .map(entry => entry.trim())
            .filter(Boolean);
    }
    if (typeof value !== 'string') {
        return [];
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return [];
    }
    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (Array.isArray(parsed)) {
                return parsed
                    .filter((entry): entry is string => typeof entry === 'string')
                    .map(entry => entry.trim())
                    .filter(Boolean);
            }
        } catch {
            // Treat malformed JSON-looking values as scalar path lists.
        }
    }
    return trimmed.split(delimiter).map(entry => entry.trim()).filter(Boolean);
}

function stripOuterQuotes(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1).trim();
        }
    }
    return value;
}

function resolvePathValue(
    rawValue: string,
    workspaceFolderPath: string,
    pathApi: PathApi
): { path?: string; warning?: string } {
    let value = stripOuterQuotes(rawValue.trim());
    if (!value) {
        return {};
    }

    if (PROJECT_TOKEN.test(value)) {
        value = workspaceFolderPath + value.replace(PROJECT_TOKEN, '');
    }
    if (UNRESOLVED_TOKEN.test(value)) {
        return { warning: `Project definition path contains an unresolved token: ${rawValue}` };
    }

    const resolved = pathApi.isAbsolute(value)
        ? pathApi.normalize(value)
        : pathApi.resolve(workspaceFolderPath, value);
    return { path: resolved };
}

function resolvePaths(
    values: readonly string[],
    workspaceFolderPath: string,
    pathApi: PathApi,
    warnings: Set<string>
): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const caseInsensitive = pathApi.sep === '\\';

    for (const value of values) {
        const resolved = resolvePathValue(value, workspaceFolderPath, pathApi);
        if (resolved.warning) {
            warnings.add(resolved.warning);
            continue;
        }
        if (!resolved.path) {
            continue;
        }
        const key = caseInsensitive ? resolved.path.toLocaleLowerCase() : resolved.path;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(resolved.path);
        }
    }
    return result;
}

function freezeStrings(values: readonly string[]): readonly string[] {
    return Object.freeze(Array.from(values));
}

export function resolveProjectLibraryConfiguration(
    input: ProjectLibraryConfigurationInput
): ProjectLibraryConfiguration {
    const pathApi = input.pathApi ?? path;
    const workspaceFolderPath = pathApi.normalize(input.workspaceFolderPath);
    const warnings = new Set<string>();

    const effectiveLibraries = parsePathValues(
        getEffectiveAdditionalValue(input.additionalVanessaParameters, 'librarycatalogs'),
        pathApi.delimiter
    );
    const librariesFallback = parsePathValues(
        findBuildParameter(input.buildParameters, ['Libraries']),
        pathApi.delimiter
    );
    const vanessaLibrariesFallback = parsePathValues(
        findBuildParameter(input.buildParameters, ['VanessaLibraries']),
        pathApi.delimiter
    );
    const libraryValues = effectiveLibraries.length > 0
        ? effectiveLibraries
        : librariesFallback.length > 0
            ? librariesFallback
            : vanessaLibrariesFallback;

    const effectiveFeatureFolders = parsePathValues(
        getEffectiveAdditionalValue(input.additionalVanessaParameters, 'featurepath'),
        pathApi.delimiter
    );
    const featureFolderValues = effectiveFeatureFolders.length > 0
        ? effectiveFeatureFolders
        : parsePathValues(findBuildParameter(input.buildParameters, ['FeatureFolder']), pathApi.delimiter);

    const vanessaValues = ['VanessaFolder', 'VanessaDir', 'VanessaPath']
        .flatMap(alias => parsePathValues(findBuildParameter(input.buildParameters, [alias]), pathApi.delimiter));

    const libraryRootPaths = resolvePaths(libraryValues, workspaceFolderPath, pathApi, warnings);
    const featureFolderPaths = resolvePaths(featureFolderValues, workspaceFolderPath, pathApi, warnings);
    const vanessaInstallationCandidates = resolvePaths(vanessaValues, workspaceFolderPath, pathApi, warnings);
    const warningList = Array.from(warnings);
    const identityPayload = JSON.stringify({
        workspaceFolder: input.workspaceFolderUri ?? workspaceFolderPath,
        profileId: input.profileId,
        libraryRootPaths,
        featureFolderPaths,
        vanessaInstallationCandidates
    });
    const identity = `project-libraries:${createHash('sha256').update(identityPayload, 'utf8').digest('hex')}`;

    return Object.freeze({
        identity,
        workspaceFolderPath,
        workspaceFolderUri: input.workspaceFolderUri,
        profileId: input.profileId,
        libraryRootPaths: freezeStrings(libraryRootPaths),
        featureFolderPaths: freezeStrings(featureFolderPaths),
        vanessaInstallationCandidates: freezeStrings(vanessaInstallationCandidates),
        warnings: freezeStrings(warningList)
    });
}
