import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { findCompilerBuildParameter, getEffectiveCompilerLibraries } from './compilerBuildParameters';
import type {
    AdditionalVanessaParameter,
    YamlParameter
} from './yamlParametersManager';
import {
    applyAdditionalVanessaParameters,
    findObjectKeyByAlias,
    parseAdditionalParameterPointer,
    type JsonValue
} from './vanessaLaunchJson';

type PathApi = Pick<typeof path.posix, 'delimiter' | 'isAbsolute' | 'normalize' | 'resolve' | 'relative' | 'sep'>;

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
    alias: string,
    base: Record<string, JsonValue> = {}
): JsonValue | undefined {
    const transformed = applyAdditionalVanessaParameters(base, parameters);
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
    // SPPR uses | on every OS. Keep legacy platform lists when no pipe is present.
    return trimmed.split(trimmed.includes('|') ? '|' : delimiter).map(entry => entry.trim()).filter(Boolean);
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

/** Register an authored export for both the compiler and the effective Vanessa overlay. */
export function addProjectLibraryFolder(input: ProjectLibraryConfigurationInput, folder: string): {
    buildParameters: YamlParameter[]; additionalVanessaParameters: AdditionalVanessaParameter[];
} {
    const pathApi = input.pathApi ?? path;
    const target = pathApi.resolve(folder);
    const buildParameters = input.buildParameters.map(row => ({ ...row }));
    const additionalVanessaParameters = input.additionalVanessaParameters.map(row => ({ ...row }));
    const configuration = resolveProjectLibraryConfiguration(input);
    if (configuration.libraryRootPaths.some(root => {
        const relative = pathApi.relative(root, target);
        return !pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`);
    })) { return { buildParameters, additionalVanessaParameters }; }
    if (target.includes('|')) { throw new Error('Export library folder paths cannot contain |.'); }
    const relative = pathApi.relative(input.workspaceFolderPath, target);
    const compilerPath = !pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) ? relative || '.' : target;
    const existing = findCompilerBuildParameter(buildParameters, 'Libraries', 'VanessaLibraries');
    const value = [...getEffectiveCompilerLibraries(buildParameters), compilerPath].join('|');
    if (existing) { existing.value = value; } else { buildParameters.push({ key: 'Libraries', value }); }
    // A priority catalog replaces Libraries entirely. Update its winning row as well,
    // keeping the user's spelling, other catalogs and all unrelated parameters.
    let overrideIndex = -1;
    additionalVanessaParameters.forEach((row, index) => {
        const leaf = (parseAdditionalParameterPointer(row.key) ?? [row.key]).at(-1);
        if (row.overrideExisting && typeof leaf === 'string' && findObjectKeyByAlias({ КаталогиБиблиотек: [] }, leaf)) { overrideIndex = index; }
    });
    if (overrideIndex >= 0) {
        const catalogs = parsePathValues(getEffectiveAdditionalValue(input.additionalVanessaParameters, 'librarycatalogs',
            { КаталогиБиблиотек: getEffectiveCompilerLibraries(input.buildParameters) }), pathApi.delimiter);
        additionalVanessaParameters[overrideIndex] = { ...additionalVanessaParameters[overrideIndex], value: JSON.stringify([...catalogs, target]), valueKind: 'array' };
    }
    if (!resolveProjectLibraryConfiguration({ ...input, buildParameters, additionalVanessaParameters }).libraryRootPaths.includes(target)) {
        throw new Error('The library catalog override prevents registering the export folder. Review Additional Vanessa Automation parameters.');
    }
    return { buildParameters, additionalVanessaParameters };
}

export function resolveProjectLibraryConfiguration(
    input: ProjectLibraryConfigurationInput
): ProjectLibraryConfiguration {
    const pathApi = input.pathApi ?? path;
    const workspaceFolderPath = pathApi.normalize(input.workspaceFolderPath);
    const warnings = new Set<string>();

    const compilerLibraries = getEffectiveCompilerLibraries(input.buildParameters);
    // The compiler always emits this key, including its built-in Vanessa library.
    const libraryValues = parsePathValues(getEffectiveAdditionalValue(input.additionalVanessaParameters, 'librarycatalogs',
        { КаталогиБиблиотек: compilerLibraries }), pathApi.delimiter);

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
