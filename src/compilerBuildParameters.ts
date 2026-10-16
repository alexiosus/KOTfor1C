import path from 'node:path';

export interface CompilerBuildParameter {
    key: string;
    value: string;
}

export interface CompilerParameterDefaults {
    defaultVanessaFolder?: string;
    defaultModelDbSettings?: string;
}

export function normalizeBuildParameterKey(key: string): string {
    return String(key).trim().toLowerCase().replace(/[_\-\s]/g, '');
}

const directoryKeys = new Set([
    'testfolder', 'scenariofolder', 'processfolder', 'featurefolder', 'modeldbsettings',
    'compilefile', 'junitpath', 'junitfile', 'logfile', 'resultfile', 'errorfolder',
    'scenariologfile', 'scenariooutfile', 'bddlogfolder', 'screenshotsfolder',
    'vanessadir', 'vanessafolder', 'vanessapath', 'junitfolder', 'allurepath',
    'allurefolder', 'cucumberfolder', 'spprreportfolder', 'screenshotspath'
]);
const libraryKeys = new Set(['libraries', 'vanessalibraries']);
const folderRoleAliases = ['LaunchDBFolder', 'TestClientDBPath'];
const connectionRoleAliases = ['TestClientDB', 'InfobasePath'];
const vanessaAliases = ['VanessaPath', 'VanessaFolder', 'VanessaDir'];

function stringifyParameterValue(key: string, value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (Array.isArray(value) && libraryKeys.has(normalizeBuildParameterKey(key))) {
        return value.map(item => String(item ?? '')).join('|');
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

/** Accepts stored/UI rows without losing false, zero or library arrays. */
export function normalizeCompilerParameterRows(raw: unknown): CompilerBuildParameter[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const result: CompilerBuildParameter[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const source = item as { key?: unknown; value?: unknown };
        const key = String(source.key ?? '').trim();
        if (key) {
            result.push({ key, value: stringifyParameterValue(key, source.value) });
        }
    }
    return result;
}

/** Imports a compiler JSON object into editable string rows. */
export function importCompilerBuildParameters(jsonData: unknown): CompilerBuildParameter[] | null {
    if (!jsonData || typeof jsonData !== 'object' || Array.isArray(jsonData)) {
        return null;
    }
    return normalizeCompilerParameterRows(Object.entries(jsonData).map(([key, value]) => ({ key, value })));
}

/** Aliases are ordered by the compiler's precedence, including explicit blanks. */
export function findCompilerBuildParameter(
    parameters: readonly CompilerBuildParameter[], ...aliases: string[]
): CompilerBuildParameter | undefined {
    for (const alias of aliases) {
        const key = normalizeBuildParameterKey(alias);
        for (let index = parameters.length - 1; index >= 0; index--) {
            if (normalizeBuildParameterKey(parameters[index].key) === key) {
                return parameters[index];
            }
        }
    }
    return undefined;
}

export function getCompilerBuildParameterValue(
    parameters: readonly CompilerBuildParameter[], ...aliases: string[]
): string {
    return findCompilerBuildParameter(parameters, ...aliases)?.value ?? '';
}

export function normalizeVanessaFolderValue(rawValue: string): string {
    const trimmedValue = String(rawValue ?? '').trim();
    const withoutTrailingSeparators = trimmedValue.replace(/[\\/]+$/, '') || trimmedValue;
    if (/\.epf$/i.test(withoutTrailingSeparators)) {
        return (withoutTrailingSeparators.includes('\\') ? path.win32 : path).dirname(withoutTrailingSeparators);
    }
    return withoutTrailingSeparators;
}

export function getEffectiveVanessaFolder(parameters: readonly CompilerBuildParameter[]): string {
    return normalizeVanessaFolderValue(getCompilerBuildParameterValue(parameters, ...vanessaAliases));
}

/** Canonicalizes absorbed aliases while preserving separate launch connection roles. */
export function normalizeCompilerBuildParameters(
    parameters: readonly CompilerBuildParameter[], defaults: CompilerParameterDefaults = {}
): CompilerBuildParameter[] {
    const rows = normalizeCompilerParameterRows(parameters);
    const testFolder = findCompilerBuildParameter(rows, 'TestFolder');
    const vanessa = findCompilerBuildParameter(rows, ...vanessaAliases);
    const modelSettings = findCompilerBuildParameter(rows, 'ModelDBSettings');
    const launchFolder = findCompilerBuildParameter(rows, ...folderRoleAliases);
    const launchConnection = findCompilerBuildParameter(rows, ...connectionRoleAliases);
    const result: CompilerBuildParameter[] = [
        { key: 'ScenarioFolder', value: testFolder?.value ?? getCompilerBuildParameterValue(rows, 'ScenarioFolder') },
        { key: 'FeatureFolder', value: getCompilerBuildParameterValue(rows, 'FeatureFolder') },
        { key: 'VanessaFolder', value: normalizeVanessaFolderValue(vanessa?.value ?? defaults.defaultVanessaFolder ?? '') },
        { key: 'ModelDBSettings', value: modelSettings?.value ?? defaults.defaultModelDbSettings ?? '' },
        { key: 'AuthCompile', value: getCompilerBuildParameterValue(rows, 'AuthCompile') || 'False' }
    ];
    if (launchFolder) {
        result.push({ ...launchFolder });
    } else if (!launchConnection) {
        result.push({ key: 'LaunchDBFolder', value: '' });
    }
    if (launchConnection) {
        result.push({ ...launchConnection });
    }
    if (testFolder) {
        result.push({ key: 'ProcessFolder', value: testFolder.value });
    } else if (!findCompilerBuildParameter(rows, 'ProcessFolder')) {
        result.push({ key: 'ProcessFolder', value: getCompilerBuildParameterValue(rows, 'ScenarioFolder') });
    }
    const absorbed = new Set([
        'scenariofolder', 'testfolder', 'featurefolder', 'modeldbsettings', 'authcompile',
        ...folderRoleAliases.map(normalizeBuildParameterKey), ...connectionRoleAliases.map(normalizeBuildParameterKey),
        ...vanessaAliases.map(normalizeBuildParameterKey), ...(testFolder ? ['processfolder'] : [])
    ]);
    for (const row of rows) {
        if (!absorbed.has(normalizeBuildParameterKey(row.key))) {
            result.push({ ...row });
        }
    }
    return result;
}

export function isInfobaseConnectionString(value: string): boolean {
    return /(?:file|srvr)\s*=/i.test(value);
}

/** Explicit path fields resolve against the workspace; absolute Windows paths remain intact. */
export function resolveCompilerPath(value: string, workspaceRoot: string): string {
    const trimmedValue = value.trim();
    if (!trimmedValue || path.isAbsolute(trimmedValue) || path.win32.isAbsolute(trimmedValue) || /^~[\\/]/.test(trimmedValue)) {
        return value;
    }
    return path.resolve(workspaceRoot, trimmedValue);
}

export function getEffectiveLaunchInfobase(parameters: readonly CompilerBuildParameter[], workspaceRoot?: string): string {
    const connection = getCompilerBuildParameterValue(parameters, ...connectionRoleAliases);
    if (connection.trim()) {
        return connection;
    }
    const folder = getCompilerBuildParameterValue(parameters, ...folderRoleAliases);
    if (!folder.trim() || isInfobaseConnectionString(folder)) {
        return folder;
    }
    const folderPath = workspaceRoot ? resolveCompilerPath(folder, workspaceRoot) : folder;
    return `File="${folderPath}";`;
}

/** Additional directories only: the compiler and launcher each supply their built-in library. */
export function getEffectiveCompilerLibraries(parameters: readonly CompilerBuildParameter[], workspaceRoot?: string): string[] {
    const value = getCompilerBuildParameterValue(parameters, 'Libraries', 'VanessaLibraries');
    return value.split('|').map(item => item.trim()).filter(Boolean)
        .map(item => workspaceRoot ? resolveCompilerPath(item, workspaceRoot) : item);
}

export function isTruthyCompilerParameter(value: string): boolean {
    return ['true', 'истина'].includes(String(value ?? '').trim().toLowerCase());
}

export function compilerCreatesLaunchJson(parameters: readonly CompilerBuildParameter[]): boolean {
    const value = findCompilerBuildParameter(parameters, 'CreateJson');
    return value ? isTruthyCompilerParameter(value.value) : true;
}

export function serializeCompilerBuildParameters(
    parameters: readonly CompilerBuildParameter[], workspaceRoot: string,
    options: { showDriveFeatures?: boolean } = {}
): Record<string, string> {
    const payload: Record<string, string> = {};
    for (const parameter of normalizeCompilerParameterRows(parameters)) {
        const key = normalizeBuildParameterKey(parameter.key);
        if (key === 'splitfeaturefiles' && !options.showDriveFeatures) {
            continue;
        }
        let value = parameter.value;
        if (libraryKeys.has(key)) {
            value = value.split('|').map(item => resolveCompilerPath(item, workspaceRoot)).join('|');
        } else if (directoryKeys.has(key)
            || (folderRoleAliases.some(alias => normalizeBuildParameterKey(alias) === key) && !isInfobaseConnectionString(value))) {
            value = resolveCompilerPath(value, workspaceRoot);
        }
        Object.defineProperty(payload, parameter.key, { value, enumerable: true, writable: true, configurable: true });
    }
    return payload;
}
