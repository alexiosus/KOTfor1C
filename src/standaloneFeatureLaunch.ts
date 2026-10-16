import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ActiveYamlParametersProfile } from './activeYamlParametersProfile';
import { buildFileInfobaseConnectionArgument, parseInfobaseConnectionString } from './oneCInfobaseConnection';
import {
    findCompilerBuildParameter,
    getCompilerBuildParameterValue,
    getEffectiveCompilerLibraries,
    getEffectiveLaunchInfobase,
    getEffectiveVanessaFolder,
    isInfobaseConnectionString,
    normalizeBuildParameterKey
} from './compilerBuildParameters';
import {
    applyAdditionalVanessaParameters,
    applyGlobalVanessaVariables,
    findObjectKeyByAlias,
    getVanessaParameterAliases,
    type JsonValue
} from './vanessaLaunchJson';

export interface StandaloneFeatureLaunchOptions {
    readonly featurePath: string;
    readonly workspaceRootPath: string;
    readonly runtimeDirectory?: string;
    readonly baseJson?: JsonValue;
}

function objectJson(value: JsonValue): Record<string, JsonValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Vanessa launch JSON must be an object.');
    }
    return value;
}

export function parseStandaloneFeatureLaunchJson(text: string): Record<string, JsonValue> {
    return objectJson(JSON.parse(text.replace(/^\uFEFF/u, '')) as JsonValue);
}

const FEATURE_SELECTOR_ALIASES = new Set(['FeaturesToRun', 'СписокФичДляВыполнения'].map(key => key.toLowerCase()));
const FEATURE_PATH_ALIASES = new Set(getVanessaParameterAliases('featurepath').map(key => key.toLowerCase()));
const LAUNCH_SECTION_ALIASES = new Set([
    ...getVanessaParameterAliases('RunningScripts'), 'MainSettings', 'ОсновныеНастройки'
].map(key => key.toLowerCase()));

/** Apply to a runtime copy after all overlays. Business variables/custom objects stay untouched. */
export function targetStandaloneFeatureLaunchJson(source: JsonValue, featurePath: string): Record<string, JsonValue> {
    if (!featurePath.trim() || !/\.feature$/iu.test(featurePath)) {
        throw new Error('A non-empty .feature file path is required.');
    }
    const root = objectJson(structuredClone(source));
    const constrain = (section: Record<string, JsonValue>): void => {
        for (const [key, value] of Object.entries(section)) {
            const normalized = key.trim().toLowerCase();
            if (FEATURE_PATH_ALIASES.has(normalized)) {
                section[key] = featurePath;
            } else if (FEATURE_SELECTOR_ALIASES.has(normalized)) {
                section[key] = Array.isArray(value) ? [featurePath] : featurePath;
            } else if (LAUNCH_SECTION_ALIASES.has(normalized) && value && typeof value === 'object' && !Array.isArray(value)) {
                constrain(value);
            }
        }
    };
    constrain(root);
    if (!findObjectKeyByAlias(root, 'featurepath')) {
        root.featurepath = featurePath;
    }
    return root;
}

function resolveLaunchPath(raw: string, workspaceRoot: string): string {
    const value = raw.trim().replace(/^(["'])(.*)\1$/u, '$2')
        .replace(/\$\{workspaceFolder\}/gu, workspaceRoot);
    if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
        return value;
    }
    return path.resolve(workspaceRoot, value.replace(/[\\/]/gu, path.sep));
}

const BOOLEAN_FIELDS: ReadonlyArray<readonly [string, string]> = [
    ['SafeStepsExecution', 'safeexecutionofsteps'], ['CaptureScreen', 'onerrorscreenshot'],
    ['UseScreenshotComponent', 'useaddinforscreencapture'], ['UseExternalComponent', 'useaddin'],
    ['AllureReport', 'allurecreatereport'], ['JUnitReport', 'junitcreatereport'],
    ['CucumberReport', 'cucumbercreatereport'], ['SpprReport', 'ModelingCreateReport']
];
const NUMBER_FIELDS: ReadonlyArray<readonly [string, string]> = [
    ['PauseOnWindowsOpening', 'pauseonwindowopening'], ['WaitWindowTime', 'timetofindwindow'],
    ['NumberOfAttempts', 'numberofattemptstoperformanaction'], ['TimeoutForAsyncSteps', 'timeoutforasynchronoussteps'],
    ['TimeoutTestClientStart', 'testclienttimeout']
];
const PATH_FIELDS: ReadonlyArray<readonly [readonly string[], string]> = [
    [['AllureFolder', 'AllurePath'], 'allurepath'], [['JUnitFolder', 'JUnitPath'], 'junitpath'],
    [['CucumberFolder'], 'cucumberreportpath'], [['SpprReportFolder'], 'modelingreportpath'],
    [['BDDLogFolder'], 'texterrorslogname'], [['ScreenshotsFolder', 'ScreenshotsPath'], 'outputscreenshot'],
    [['ScenarioLogFile'], 'textlogname'], [['ScenarioOutFile'], 'logpath']
];

function parseBoolean(value: string, key: string): boolean {
    if (/^(?:true|1|yes|да|истина)$/iu.test(value)) { return true; }
    if (/^(?:false|0|no|нет|ложь)$/iu.test(value)) { return false; }
    throw new Error(`Invalid boolean build parameter ${key}: ${value}.`);
}

function parseNumber(value: string, key: string): number {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new Error(`Invalid numeric build parameter ${key}: ${value}.`);
    }
    return number;
}

function launchSettingContainers(root: Record<string, JsonValue>): Record<string, JsonValue>[] {
    const sectionAliases = new Set([
        ...LAUNCH_SECTION_ALIASES, ...getVanessaParameterAliases('TestClient').map(key => key.toLowerCase()),
        'allurereport', 'junitreport', 'cucumberreport', 'screenshots', 'скриншоты'
    ]);
    return [root, ...Object.entries(root)
        .filter(([key, value]) => sectionAliases.has(key.toLowerCase()) && value && typeof value === 'object' && !Array.isArray(value))
        .map(([, value]) => value as Record<string, JsonValue>)];
}

function selectedClient(root: Record<string, JsonValue>): Record<string, JsonValue> {
    let container = launchSettingContainers(root).find(section => findObjectKeyByAlias(section, 'datatestclients'));
    if (!container) {
        const sectionKey = findObjectKeyByAlias(root, 'TestClient') ?? 'TestClient';
        const value = root[sectionKey];
        container = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        root[sectionKey] = container;
    }
    const clientsKey = findObjectKeyByAlias(container, 'datatestclients') ?? 'datatestclients';
    const collection = container[clientsKey];
    const clients = Array.isArray(collection) ? collection : [];
    container[clientsKey] = clients;
    const client = clients[0];
    if (client && typeof client === 'object' && !Array.isArray(client)) {
        return client;
    }
    const created: Record<string, JsonValue> = {};
    clients[0] = created;
    return created;
}

/** Fills the runtime client after an infobase choice when authored settings had no connection. */
export function ensureStandaloneFeatureTestClientInfobase(source: JsonValue, infobasePath: string): Record<string, JsonValue> {
    if (!infobasePath.trim()) {
        throw new Error('A non-empty infobase path is required.');
    }
    const root = objectJson(structuredClone(source));
    const client = selectedClient(root);
    const defaults: Record<string, JsonValue> = {
        Name: 'TestClient', Synonym: '', ClientType: 'Thin',
        AddItionalParameters: '', ComputerName: 'localhost', PortTestClient: 1538
    };
    for (const [key, value] of Object.entries(defaults)) {
        const existingKey = findObjectKeyByAlias(client, key);
        const existingValue = existingKey ? client[existingKey] : undefined;
        if (existingValue === undefined || existingValue === null || (typeof existingValue === 'string' && !existingValue.trim())) {
            client[existingKey ?? key] = value;
        }
    }
    const connectionKey = findObjectKeyByAlias(client, 'PathToInfobase') ?? 'PathToInfobase';
    const existingConnection = client[connectionKey];
    if (typeof existingConnection !== 'string' || !existingConnection.trim()) {
        client[connectionKey] = parseInfobaseConnectionString(infobasePath)
            ? infobasePath.trim()
            : buildFileInfobaseConnectionArgument(infobasePath, { trailingSemicolon: true, forceQuotedFilePath: true });
    }
    return root;
}

/** Only known launch fields are translated; SPPR compilation parameters are excluded. */
export function buildStandaloneFeatureLaunchJson(
    profile: ActiveYamlParametersProfile,
    options: StandaloneFeatureLaunchOptions
): Record<string, JsonValue> {
    let root = objectJson(structuredClone(options.baseJson ?? {}));
    const get = (...keys: readonly string[]): string => getCompilerBuildParameterValue(profile.buildParameters, ...keys).trim();
    const set = (key: string, value: JsonValue): void => {
        const container = launchSettingContainers(root).find(section => findObjectKeyByAlias(section, key)) ?? root;
        container[findObjectKeyByAlias(container, key) ?? key] = value;
    };
    const workspaceRoot = options.workspaceRootPath;
    const runtimeRoot = resolveLaunchPath(options.runtimeDirectory ?? '.vscode/kot-runtime', workspaceRoot);
    const identity = createHash('sha256').update(options.featurePath).digest('hex').slice(0, 12);
    const logRoot = path.join(runtimeRoot, 'standalone-features', identity);
    const defaults: Record<string, JsonValue> = {
        projectpath: workspaceRoot, ExecuteScenarios: true, CloseSystemOnComplete: true,
        createlogs: true, logpath: path.join(logRoot, 'status.txt'),
        logtotext: true, textlogname: path.join(logRoot, 'execution.log')
    };
    for (const [key, value] of Object.entries(defaults)) {
        if (!launchSettingContainers(root).some(section => findObjectKeyByAlias(section, key))) { root[key] = value; }
    }
    for (const [key, target] of BOOLEAN_FIELDS) {
        const value = get(key);
        if (value) { set(target, parseBoolean(value, key)); }
    }
    for (const [key, target] of NUMBER_FIELDS) {
        const value = get(key);
        if (value) { set(target, parseNumber(value, key)); }
    }
    for (const [keys, target] of PATH_FIELDS) {
        const value = get(...keys);
        if (value) { set(target, resolveLaunchPath(value, workspaceRoot)); }
    }
    const vanessaFolder = getEffectiveVanessaFolder(profile.buildParameters);
    let resolvedVanessaFolder = '';
    if (vanessaFolder) {
        resolvedVanessaFolder = resolveLaunchPath(vanessaFolder, workspaceRoot);
        set('instrpath', resolvedVanessaFolder);
    }
    if (resolvedVanessaFolder || findCompilerBuildParameter(profile.buildParameters, 'Libraries', 'VanessaLibraries')) {
        const isWindowsPath = (value: string): boolean => path.win32.isAbsolute(value) && !path.posix.isAbsolute(value);
        const builtin = resolvedVanessaFolder
            ? (isWindowsPath(resolvedVanessaFolder) ? path.win32 : path).join(resolvedVanessaFolder, 'features', 'Libraries')
            : '';
        const catalogs = [builtin, ...getEffectiveCompilerLibraries(profile.buildParameters)
            .map(value => resolveLaunchPath(value, workspaceRoot))].filter(Boolean);
        const seen = new Set<string>();
        set('librarycatalogs', catalogs.filter(value => {
            const normalized = (isWindowsPath(value) ? path.win32 : path).normalize(value).replace(/[\\/]+$/, '');
            const identity = isWindowsPath(value) ? normalized.toLowerCase() : normalized;
            if (seen.has(identity)) { return false; }
            seen.add(identity);
            return true;
        }));
    }
    const launchParameters = profile.buildParameters.map(parameter =>
        ['launchdbfolder', 'testclientdbpath'].includes(normalizeBuildParameterKey(parameter.key))
            && parameter.value.trim() && !isInfobaseConnectionString(parameter.value)
            ? { ...parameter, value: resolveLaunchPath(parameter.value, workspaceRoot) } : parameter);
    const infobase = getEffectiveLaunchInfobase(launchParameters, workspaceRoot);
    if (infobase) {
        const client = selectedClient(root);
        const defaults: Record<string, JsonValue> = {
            Name: profile.name, Synonym: '', ClientType: get('TestClientType') || 'Thin',
            AddItionalParameters: '', ComputerName: 'localhost', PortTestClient: 1538
        };
        for (const [key, value] of Object.entries(defaults)) {
            if (!findObjectKeyByAlias(client, key)) { client[key] = value; }
        }
        client[findObjectKeyByAlias(client, 'PathToInfobase') ?? 'PathToInfobase'] = infobase;
        for (const [sourceKey, targetKey] of [['TestClientType', 'ClientType'], ['ExtraParams', 'AddItionalParameters'], ['TestClientPort', 'PortTestClient']]) {
            const value = sourceKey === 'ExtraParams'
                ? getCompilerBuildParameterValue(profile.buildParameters, sourceKey) : get(sourceKey);
            if (value) {
                client[findObjectKeyByAlias(client, targetKey) ?? targetKey] = sourceKey === 'TestClientPort' ? parseNumber(value, sourceKey) : value;
            }
        }
    }
    root = objectJson(applyAdditionalVanessaParameters(root, profile.additionalVanessaParameters).value);
    root = objectJson(applyGlobalVanessaVariables(root, profile.globalVanessaVariables).value);
    return targetStandaloneFeatureLaunchJson(root, options.featurePath);
}
