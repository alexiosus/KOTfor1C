import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'node:crypto';
import { getExtensionUri } from './appContext';
import { updateScenarioScanRoot, updateProcessScanRoot, getScenarioScanRootPath } from './scenarioScanRoot';
import { getDefaultModelDbSettingsValue } from './etalonBases';
import { applyCompilerProfileDefaults, getDefaultAdditionalVanessaParameters } from './yamlParameterDefaults';
import type { AdditionalParameterValueKind } from './vanessaLaunchJson';
import { collectCompilerBuildValueIssues, getCompilerBuildValueHint, type CompilerBuildValueHint } from './compilerBuildValueValidation';
import {
    compilerCreatesLaunchJson,
    getCompilerBuildParameterValue,
    getEffectiveLaunchInfobase,
    getEffectiveVanessaFolder,
    importCompilerBuildParameters,
    isTruthyCompilerParameter,
    normalizeBuildParameterKey,
    normalizeCompilerBuildParameters,
    normalizeCompilerParameterRows,
    normalizeVanessaFolderValue,
    serializeCompilerBuildParameters
} from './compilerBuildParameters';
import {
    createActiveYamlParametersProfileSnapshot,
    getActiveYamlParametersProfileChange,
    type ActiveYamlParametersProfile,
    type ActiveYamlParametersProfileChangeEvent
} from './activeYamlParametersProfile';

export type {
    ActiveYamlParametersProfile,
    ActiveYamlParametersProfileChangeEvent
} from './activeYamlParametersProfile';

// Legacy shared profiles remain available for explicit import only.
const YAML_PARAMETERS_KEY = 'kotTestToolkit.yamlParameters';

export interface YamlParameter {
    key: string;
    value: string;
}

export interface AdditionalVanessaParameter {
    key: string;
    value: string;
    overrideExisting: boolean;
    valueKind?: AdditionalParameterValueKind;
}

export interface GlobalVanessaVariable {
    key: string;
    value: string;
    overrideExisting: boolean;
}

export interface YamlParametersProfileSummary {
    id: string;
    name: string;
}

export interface YamlParametersProfilesSummary {
    activeProfileId: string;
    profiles: YamlParametersProfileSummary[];
}

interface BuildParameterDefinition extends Partial<CompilerBuildValueHint> {
    key: string;
    description: string;
    fixed?: boolean;
}

interface YamlParametersProfile {
    id: string;
    name: string;
    buildParameters: YamlParameter[];
    additionalVanessaParameters: AdditionalVanessaParameter[];
    globalVanessaVariables: GlobalVanessaVariable[];
}

interface YamlParametersState {
    activeProfileId: string;
    profiles: YamlParametersProfile[];
}

interface YamlParametersStorageV5 {
    version: 5;
    activeProfileId: string;
    profiles: YamlParametersProfile[];
}

interface ProfileQuickPickItem extends vscode.QuickPickItem {
    action: 'select' | 'create' | 'duplicate' | 'rename' | 'delete' | 'importLegacy';
    profileId?: string;
}

const DEFAULT_YAML_PARAMETERS_PROFILE_ID = 'default';
const DEFAULT_YAML_PARAMETERS_PROFILE_NAME = 'Default';

export class YamlParametersManager {
    private static instance: YamlParametersManager;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    private _langOverride: 'System' | 'English' | 'Русский' = 'System';
    private _ruBundle: Record<string, string> | null = null;
    private parametersSaveQueue: Promise<void> = Promise.resolve();
    private vanessaCatalogRevision = 0;
    private readonly storageKey: string;
    private readonly projectRoot: string | undefined;
    private projectSeed: Promise<string | undefined> | undefined;
    private readonly activeProfileChangeEmitter = new vscode.EventEmitter<ActiveYamlParametersProfileChangeEvent>();
    public readonly onDidChangeActiveProfile = this.activeProfileChangeEmitter.event;

    private constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._extensionUri = getExtensionUri();
        // VS Code restarts the host when the first root changes. Use that root's URI
        // so opening the same project via a .code-workspace keeps its profiles.
        const folder = vscode.workspace.workspaceFolders?.[0];
        this.projectRoot = folder?.uri.fsPath;
        const identity = folder?.uri.toString() ?? 'empty-window';
        this.storageKey = `${YAML_PARAMETERS_KEY}.project.${createHash('sha256').update(identity).digest('hex')}`;
        context.subscriptions.push(this.activeProfileChangeEmitter);
    }

    /**
     * Загружает настройки локализации
     */
    private async loadLocalizationBundleIfNeeded(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('kotTestToolkit.localization');
        const override = (cfg.get<string>('languageOverride') as 'System' | 'English' | 'Русский') || 'System';
        this._langOverride = override;
        if (override === 'Русский') {
            try {
                const ruUri = vscode.Uri.joinPath(this._extensionUri, 'l10n', 'bundle.l10n.ru.json');
                const bytes = await vscode.workspace.fs.readFile(ruUri);
                this._ruBundle = JSON.parse(Buffer.from(bytes).toString('utf-8')) as Record<string, string>;
            } catch (e) {
                console.warn('[YamlParametersManager] Failed to load RU bundle:', e);
                this._ruBundle = null;
            }
        } else {
            this._ruBundle = null;
        }
    }

    /**
     * Форматирует плейсхолдеры в строке
     */
    private formatPlaceholders(template: string, args: string[]): string {
        return template.replace(/\{(\d+)\}/g, (m, idx) => {
            const i = Number(idx);
            return i >= 0 && i < args.length ? args[i] : m;
        });
    }

    /**
     * Метод для перевода строк
     */
    private t(message: string, ...args: string[]): string {
        if (this._langOverride === 'System') {
            return vscode.l10n.t(message, ...args);
        }
        if (this._langOverride === 'Русский') {
            const translated = (this._ruBundle && this._ruBundle[message]) || message;
            return args.length ? this.formatPlaceholders(translated, args) : translated;
        }
        // en override: return default English and format placeholders
        return args.length ? this.formatPlaceholders(message, args) : message;
    }

    public static getInstance(context: vscode.ExtensionContext): YamlParametersManager {
        if (!YamlParametersManager.instance) {
            YamlParametersManager.instance = new YamlParametersManager(context);
        }
        return YamlParametersManager.instance;
    }

    /**
     * Defaults for compiler, launch and diagnostic artifacts.
     */
    public getDefaultParameters(): YamlParameter[] {
        // Получаем BuildPath из настроек
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const buildPath = config.get<string>('runtime.directory') || '.vscode/kot-runtime';
        return applyCompilerProfileDefaults([
            { key: 'ScenarioFolder', value: getScenarioScanRootPath() },
            { key: 'FeatureFolder', value: path.join(buildPath, 'tests') },
            { key: 'VanessaFolder', value: this.getDefaultVanessaFolderValue() },
            { key: 'ModelDBSettings', value: getDefaultModelDbSettingsValue(buildPath) },
            { key: 'AuthCompile', value: 'False' },
            { key: 'LaunchDBFolder', value: path.join(buildPath, 'launch-infobase') }
        ], buildPath);
    }

    private normalizeVanessaFolderValue(rawValue: string): string {
        return normalizeVanessaFolderValue(rawValue);
    }

    private getDefaultVanessaFolderValue(): string {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const configuredVanessaEpfPath = (config.get<string>('runVanessa.vanessaEpfPath') || '').trim();
        return this.normalizeVanessaFolderValue(configuredVanessaEpfPath);
    }

    private normalizeBuildParameterKey(key: string): string {
        return normalizeBuildParameterKey(key);
    }

    private createDefaultProfile(
        id: string = DEFAULT_YAML_PARAMETERS_PROFILE_ID,
        name: string = DEFAULT_YAML_PARAMETERS_PROFILE_NAME
    ): YamlParametersProfile {
        return {
            id,
            name,
            buildParameters: this.normalizeBuildParametersForUi(this.getDefaultParameters()),
            additionalVanessaParameters: getDefaultAdditionalVanessaParameters(),
            globalVanessaVariables: []
        };
    }

    private createGeneratedProfileId(existingProfiles: readonly YamlParametersProfile[]): string {
        const existingIds = new Set(existingProfiles.map(profile => profile.id));
        let candidate = '';
        do {
            candidate = `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        } while (existingIds.has(candidate));
        return candidate;
    }

    private cloneProfile(profile: YamlParametersProfile, overrides: Partial<YamlParametersProfile>): YamlParametersProfile {
        return {
            id: overrides.id ?? profile.id,
            name: overrides.name ?? profile.name,
            buildParameters: this.normalizeBuildParametersForUi(
                (overrides.buildParameters ?? profile.buildParameters).map(item => ({ ...item }))
            ),
            additionalVanessaParameters: this.normalizeAdditionalVanessaParameters(
                (overrides.additionalVanessaParameters ?? profile.additionalVanessaParameters).map(item => ({ ...item }))
            ),
            globalVanessaVariables: this.normalizeGlobalVanessaVariables(
                (overrides.globalVanessaVariables ?? profile.globalVanessaVariables).map(item => ({ ...item }))
            )
        };
    }

    private normalizeProfileId(rawId: unknown, fallbackIndex: number): string {
        const normalized = String(rawId ?? '').trim();
        return normalized || `profile-${fallbackIndex + 1}`;
    }

    private normalizeProfileName(rawName: unknown, fallbackIndex: number): string {
        const normalized = String(rawName ?? '').trim();
        if (normalized) {
            return normalized;
        }

        return fallbackIndex === 0
            ? DEFAULT_YAML_PARAMETERS_PROFILE_NAME
            : this.t('Profile {0}', String(fallbackIndex + 1));
    }

    private normalizeProfile(raw: unknown, fallbackIndex: number, upgradeDefaults: boolean): YamlParametersProfile | null {
        if (!raw || typeof raw !== 'object') {
            return null;
        }

        const source = raw as Partial<YamlParametersProfile>;
        const buildParameters = this.normalizeParameters(source.buildParameters);
        return {
            id: this.normalizeProfileId(source.id, fallbackIndex),
            name: this.normalizeProfileName(source.name, fallbackIndex),
            buildParameters: this.normalizeBuildParametersForUi(
                buildParameters.length > 0 ? buildParameters : this.getDefaultParameters(), upgradeDefaults
            ),
            additionalVanessaParameters: this.normalizeAdditionalVanessaParameters(source.additionalVanessaParameters),
            globalVanessaVariables: this.normalizeGlobalVanessaVariables(source.globalVanessaVariables)
        };
    }

    private normalizeProfiles(
        rawProfiles: unknown,
        fallbackProfile?: YamlParametersProfile,
        upgradeDefaults = false
    ): YamlParametersProfile[] {
        const normalizedProfiles = Array.isArray(rawProfiles)
            ? rawProfiles
                .map((item, index) => this.normalizeProfile(item, index, upgradeDefaults))
                .filter((item): item is YamlParametersProfile => item !== null)
            : [];

        const dedupedProfiles: YamlParametersProfile[] = [];
        const ids = new Set<string>();
        for (const profile of normalizedProfiles) {
            let profileId = profile.id;
            if (ids.has(profileId)) {
                let duplicateIndex = 2;
                while (ids.has(`${profileId}-${duplicateIndex}`)) {
                    duplicateIndex++;
                }
                profileId = `${profileId}-${duplicateIndex}`;
            }
            ids.add(profileId);
            dedupedProfiles.push({ ...profile, id: profileId });
        }

        if (dedupedProfiles.length > 0) {
            return dedupedProfiles;
        }

        return [fallbackProfile ?? this.createDefaultProfile()];
    }

    private getActiveProfileFromState(state: YamlParametersState): YamlParametersProfile {
        const activeProfile = state.profiles.find(profile => profile.id === state.activeProfileId);
        return activeProfile ?? state.profiles[0] ?? this.createDefaultProfile();
    }

    private shouldShowDriveSpecificBuildParameters(): boolean {
        return vscode.workspace
            .getConfiguration('kotTestToolkit')
            .get<boolean>('assembleScript.showDriveFeatures', false);
    }

    private getBuildParameterDefinitions(): BuildParameterDefinition[] {
        const t = this.t.bind(this);
        const genericDescription = t('Additional SPPR parameter passed to СборкаТекстовСценариев.');
        const showDriveSpecificParameters = this.shouldShowDriveSpecificBuildParameters();
        const launchFolderDescription = t('File infobase folder or full connection string used for Vanessa launch. InfobasePath and TestClientDB take priority over this folder. KOT may replace the target when you select another infobase.');
        const launchConnectionDescription = t('Full connection string used for Vanessa launch, such as `File="C:\\Bases\\Demo";` or `Srvr="server";Ref="base";`. Takes priority over LaunchDBFolder and TestClientDBPath. TestClientDB overrides InfobasePath.');
        const definitions: BuildParameterDefinition[] = [
            { key: 'ScenarioFolder', description: t('Root folder with YAML scenarios used by SPPR build. KOT also synchronizes this value with the YAML scan root.'), fixed: true },
            { key: 'FeatureFolder', description: t('Output folder where SPPR writes built feature/json artifacts.'), fixed: true },
            { key: 'VanessaFolder', description: t('Path to the Vanessa Automation directory. By default, KOT derives it from Run Vanessa: Vanessa Epf Path.'), fixed: true },
            { key: 'ModelDBSettings', description: t('Path to the model DB settings YAML with etalon database definitions and user credentials. Needed for automatic TestClient profile resolution; required when AuthCompile=true.'), fixed: true },
            { key: 'AuthCompile', description: t('Enables strict validation that SPPR can resolve TestClient authorization data from ModelDBSettings. It does not provide credentials by itself.'), fixed: true },
            { key: 'LaunchDBFolder', description: launchFolderDescription, fixed: true },
            { key: 'TestClientDBPath', description: launchFolderDescription, fixed: true },
            { key: 'InfobasePath', description: launchConnectionDescription },
            { key: 'TestClientDB', description: launchConnectionDescription },
            { key: 'ProcessFolder', description: t('Separate root folder for process YAML files if they are stored outside ScenarioFolder.') },
            { key: 'ModelDBid', description: t('Identifier of the model database used to filter or route build artifacts.') },
            { key: 'CompileFile', description: t('Custom path to compile.txt written by the SPPR processing.') },
            { key: 'CreateJson', description: t('Controls whether SPPR creates per-test JSON launch files.') },
            { key: 'CreateJUnit', description: t('Controls whether the compiler creates a JUnit report for compilation.') },
            { key: 'JUnitPath', description: t('Folder for junit_compile.xml; also supplies the Vanessa execution JUnit folder unless JUnitFolder overrides it.') },
            { key: 'JUnitFile', description: t('Explicit file path for the compilation JUnit report. Does not set the Vanessa execution report folder.') },
            { key: 'LogFile', description: t('Compiler log path. KOT manages this value during Test Manager builds.') },
            { key: 'ResultFile', description: t('Compiler result code path. KOT manages this value during Test Manager builds.') },
            { key: 'ErrorFolder', description: t('Compiler error folder. KOT manages this value during Test Manager builds.') },
            { key: 'ScenarioLogFile', description: t('Path to Vanessa progress log for scenario execution.') },
            { key: 'ScenarioOutFile', description: t('Path to Vanessa status/result file for scenario execution.') },
            { key: 'BDDLogFolder', description: t('Folder for Vanessa Automation error logs.') },
            { key: 'ScreenshotsFolder', description: t('Folder where screenshots are stored.') },
            { key: 'Libraries', description: t('Additional Vanessa library folders separated by |. Overrides VanessaLibraries. The built-in library is added automatically.') },
            { key: 'VanessaLibraries', description: t('Additional Vanessa library folders separated by |. Libraries takes priority when both are present.') },
            { key: 'JUnitFolder', description: t('Folder for Vanessa execution JUnit reports. Overrides the execution folder set by JUnitPath.') },
            { key: 'AllurePath', description: t('Path for Allure report artifacts.') },
            { key: 'AllureFolder', description: t('Alternative folder for Allure report artifacts.') },
            { key: 'CucumberFolder', description: t('Folder for Cucumber-style reports.') },
            { key: 'SpprReportFolder', description: t('Folder for SPPR-format reports.') },
            { key: 'CaptureScreen', description: t('Enables screenshot capture during scenario execution.') },
            { key: 'ScreenshotCaptureCommand', description: t('External command used to capture screenshots.') },
            { key: 'ScreenshotsPath', description: t('Alternative key for screenshots output folder.') },
            { key: 'UseScreenshotComponent', description: t('Enables screenshot capture through the 1C component.') },
            { key: 'UseExternalComponent', description: t('Enables usage of the 1C external component.') },
            { key: 'PidInformation', description: t('Enables collection of OS process information.') },
            { key: 'TestClientType', description: t('Type of test client that should be launched.') },
            { key: 'TestClientPort', description: t('TestClient TCP port from 1 to 65535. Leave empty to use 48000.') },
            { key: 'DebugMode', description: t('Vanessa debug behavior: stop on errors and leave the test client and system open after execution.') },
            { key: 'PauseOnWindowsOpening', description: t('Pause when opening windows, in seconds. Use a finite nonnegative number; empty keeps the compiler default.') },
            { key: 'AllureReport', description: t('Enables Allure report generation.') },
            { key: 'SafeStepsExecution', description: t('Enables safe execution mode for Vanessa steps.') },
            { key: 'JUnitReport', description: t('Enables Vanessa execution JUnit reports. Compilation reports are controlled by CreateJUnit.') },
            { key: 'CucumberReport', description: t('Enables Cucumber report generation.') },
            { key: 'SpprReport', description: t('Enables SPPR-format report generation.') },
            { key: 'ExtraParams', description: t('Additional startup parameters passed to the test client.') },
            { key: 'WaitWindowTime', description: t('Maximum wait for a window, in seconds. Use a finite nonnegative number; empty keeps the compiler default.') },
            { key: 'NumberOfAttempts', description: t('Number of attempts for an action. Use a positive integer; empty keeps the compiler default.') },
            { key: 'TimeoutForAsyncSteps', description: t('Timeout for asynchronous steps, in seconds. Use a finite nonnegative number; empty keeps the compiler default.') },
            { key: 'TimeoutTestClientStart', description: t('Timeout for starting the 1C test client, in seconds. Use a finite nonnegative number; empty keeps the compiler default.') },
            { key: 'ErrorAddInfo', description: t('Additional error text appended to build errors.') },
            { key: 'AddImportantInfo', description: t('Additional reproduction information inserted into build errors.') },
            { key: 'DetectionTime', description: t('Detection time for SPPR error output in XML dateTime format: YYYY-MM-DDTHH:mm:ss, optionally with Z or a timezone offset. Empty keeps the compiler default.') },
            { key: 'RepoPath', description: t('Repository URL included into SPPR error output.') },
            { key: 'Branch', description: t('Repository branch included into SPPR error output.') },
            { key: 'PipelineId', description: t('Pipeline identifier included into SPPR error output.') },
            { key: 'ConfigurationName', description: t('Configuration name included into reports and errors.') },
            { key: 'ConfigurationVersion', description: t('Configuration version included into reports and errors.') },
            { key: 'Responsible', description: t('Responsible person included into SPPR error output.') },
            { key: 'UltimateResponsible', description: t('Alternative key for the final responsible person in error output.') },
            { key: 'ScenarioSettingsFilter', description: t('Filter build by scenario settings codes.') },
            { key: 'UIDScenarioSettingsFilter', description: t('Filter build by scenario settings UIDs.') },
            { key: 'ScenarioFilterHasPriority', description: t('Prioritize ScenarioFilter over other filters.') },
            { key: 'ProcessSettingsFilter', description: t('Filter build by process settings codes.') },
            { key: 'ProcessFilter', description: t('Filter build by process codes.') },
            { key: 'ThreadsCount', description: t('Number of compilation partitions. Test Manager builds each partition in its own output folder and merges the results.') },
            { key: 'ThreadNumber', description: t('Zero-based compilation partition number: 0 is the first partition. ThreadIndex takes priority.') },
            { key: 'ThreadTotal', description: t('Number of compilation partitions. Overrides ThreadsCount.') },
            { key: 'ThreadIndex', description: t('One-based compilation partition index: 1 is the first partition. Overrides ThreadNumber.') },
            { key: 'ExternalMode', description: t('Enables external mode for the SPPR processing.') },
            { key: 'CreateModellingXml', description: t('Enables creation of SPPR modelling XML error output.') },
            { key: 'FilterTags', description: t('Include only tests/scenarios matching the specified tags.') },
            { key: 'ExceptionTags', description: t('Exclude matching tags from main-scenario settings. The supplied compiler ignores this option for processes.') },
            { key: 'SeveralScenariosInOneFile', description: t('Enables grouping of several scenarios into one feature file when SPPR allows it.') }
        ];

        if (showDriveSpecificParameters) {
            definitions.push({
                key: 'SplitFeatureFiles',
                description: t('Stores each built test in a separate subfolder with its own files directory.')
            });
        }

        const keys = [
            'ExternalMode', 'ErrorFolder', 'CreateModellingXml', 'CreateJUnit', 'JUnitPath', 'JUnitFile',
            'CreateJson', 'FilterTags', 'ExceptionTags', 'ScenarioFolder', 'ProcessFolder',
            'FeatureFolder', 'ModelDBid', 'ModelDBSettings', 'AuthCompile', 'LaunchDBFolder',
            'VanessaFolder', 'AllurePath', 'AllureFolder', 'JUnitFolder',
            'SpprReportFolder', 'CucumberFolder', 'VanessaLibraries', 'Libraries', 'ScenarioLogFile',
            'BDDLogFolder', 'ScenarioOutFile', 'CaptureScreen', 'ScreenshotCaptureCommand', 'ScreenshotsPath',
            'ScreenshotsFolder', 'UseScreenshotComponent', 'UseExternalComponent', 'PidInformation', 'ResultFile',
            'LogFile', 'TestClientType', 'TestClientPort', 'DebugMode',
            'PauseOnWindowsOpening', 'AllureReport', 'SafeStepsExecution', 'JUnitReport', 'CucumberReport',
            'SpprReport', 'ExtraParams', 'WaitWindowTime', 'NumberOfAttempts', 'TimeoutForAsyncSteps',
            'TimeoutTestClientStart', 'ErrorAddInfo', 'AddImportantInfo', 'DetectionTime', 'RepoPath',
            'Branch', 'PipelineId', 'ConfigurationName', 'ConfigurationVersion', 'Responsible',
            'SeveralScenariosInOneFile', 'UltimateResponsible', 'ScenarioSettingsFilter',
            'UIDScenarioSettingsFilter', 'ScenarioFilterHasPriority',
            'ProcessSettingsFilter', 'ProcessFilter', 'CompileFile', 'ThreadsCount', 'ThreadNumber',
            'ThreadTotal', 'ThreadIndex'
        ];

        if (showDriveSpecificParameters) {
            keys.push('SplitFeatureFiles');
        }

        const existing = new Set(definitions.map(item => this.normalizeBuildParameterKey(item.key)));
        for (const key of keys) {
            if (existing.has(this.normalizeBuildParameterKey(key))) {
                continue;
            }
            definitions.push({ key, description: genericDescription });
        }

        definitions.forEach(definition => {
            const hint = getCompilerBuildValueHint(definition.key);
            if (hint) { Object.assign(definition, hint); }
        });

        return definitions;
    }

    private normalizeBuildParametersForUi(parameters: YamlParameter[], upgradeDefaults = false): YamlParameter[] {
        const runtimeDirectory = vscode.workspace.getConfiguration('kotTestToolkit').get<string>('runtime.directory') || '.vscode/kot-runtime';
        const normalized = normalizeCompilerBuildParameters(parameters, {
            defaultVanessaFolder: this.getDefaultVanessaFolderValue(),
            defaultModelDbSettings: getDefaultModelDbSettingsValue(runtimeDirectory)
        });
        return upgradeDefaults ? applyCompilerProfileDefaults(normalized, runtimeDirectory) : normalized;
    }

    private getBuildParameterValue(parameters: YamlParameter[], ...aliases: string[]): string {
        return getCompilerBuildParameterValue(parameters, ...aliases).trim();
    }

    private getWorkspaceRootPath(): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }
        return workspaceFolders[0].uri.fsPath;
    }

    private isSameOrNestedPath(candidatePath: string, basePath: string): boolean {
        const normalize = (value: string) => {
            const resolved = path.resolve(value);
            return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        };

        const candidate = normalize(candidatePath);
        const base = normalize(basePath);
        if (candidate === base) {
            return true;
        }

        const relative = path.relative(base, candidate);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    private resolveFeatureFolderPath(workspaceRootPath: string, parameters: YamlParameter[]): string | null {
        const rawFeatureFolder = this.getBuildParameterValue(parameters, 'FeatureFolder');
        if (!rawFeatureFolder) {
            return null;
        }

        return path.normalize(
            path.isAbsolute(rawFeatureFolder)
                ? rawFeatureFolder
                : path.join(workspaceRootPath, rawFeatureFolder)
        );
    }

    private resolveRuntimeRootPath(workspaceRootPath: string, parameters: YamlParameter[]): string {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const runtimeDirectory = (config.get<string>('runtime.directory') || '').trim();
        const configuredRuntimePath = path.normalize(
            runtimeDirectory && path.isAbsolute(runtimeDirectory)
                ? runtimeDirectory
                : path.join(workspaceRootPath, runtimeDirectory || '.vscode/kot-runtime')
        );
        const featureFolderPath = this.resolveFeatureFolderPath(workspaceRootPath, parameters);
        if (!featureFolderPath) {
            return configuredRuntimePath;
        }

        if (this.isSameOrNestedPath(configuredRuntimePath, featureFolderPath)) {
            return path.join(
                path.dirname(featureFolderPath),
                `${path.basename(featureFolderPath)}.kot-runtime`
            );
        }

        return configuredRuntimePath;
    }

    /** Preflight validation available before preparing or starting the compiler infobase. */
    public validateCompilerBuildParameters(parameters: readonly YamlParameter[]): readonly string[] {
        return this.validateBuildParameters([...parameters]);
    }

    private validateBuildParameters(parameters: YamlParameter[]): string[] {
        const errors: string[] = [];
        const scenarioFolder = this.getBuildParameterValue(parameters, 'TestFolder', 'ScenarioFolder');
        const featureFolder = this.getBuildParameterValue(parameters, 'FeatureFolder');
        const vanessaFolder = getEffectiveVanessaFolder(parameters);
        const authCompile = isTruthyCompilerParameter(this.getBuildParameterValue(parameters, 'AuthCompile'));
        const modelDbSettings = this.getBuildParameterValue(parameters, 'ModelDBSettings');
        const createsLaunchJson = compilerCreatesLaunchJson(parameters);
        const launchInfobasePath = getEffectiveLaunchInfobase(parameters);

        if (!scenarioFolder) {
            errors.push(this.t('ScenarioFolder or TestFolder is required for SPPR build.'));
        }
        if (!featureFolder) {
            errors.push(this.t('FeatureFolder is required for SPPR build.'));
        }
        if (createsLaunchJson && !vanessaFolder) {
            errors.push(this.t('VanessaFolder is required when CreateJson=true.'));
        }
        if (authCompile && !modelDbSettings) {
            errors.push(this.t('ModelDBSettings is required when AuthCompile=true.'));
        }
        if (createsLaunchJson && !launchInfobasePath.trim()) {
            errors.push(this.t('LaunchDBFolder, TestClientDBPath, InfobasePath or TestClientDB is required for Vanessa launch.'));
        }
        const serialized = this.shouldShowDriveSpecificBuildParameters() ? parameters
            : parameters.filter(parameter => normalizeBuildParameterKey(parameter.key) !== 'splitfeaturefiles');
        for (const issue of collectCompilerBuildValueIssues(serialized)) { errors.push(this.t(issue.message, issue.parameter)); }
        return errors;
    }

    private getKnownBuildParameterKeys(): string[] {
        return this.getBuildParameterDefinitions().map(definition => definition.key);
    }

    private getFixedBuildParameterKeys(): string[] {
        return this.getBuildParameterDefinitions()
            .filter(definition => definition.fixed)
            .map(definition => definition.key);
    }

    private async syncYamlSourceDirectorySettingFromBuildParameters(parameters: YamlParameter[]): Promise<boolean> {
        const scenarioFolder = this.getBuildParameterValue(parameters, 'TestFolder', 'ScenarioFolder');
        if (!scenarioFolder) {
            return false;
        }

        const scenarioChanged = await updateScenarioScanRoot(this._context, scenarioFolder);
        const processFolder = this.getBuildParameterValue(parameters, 'TestFolder', 'ProcessFolder');
        const processChanged = await updateProcessScanRoot(this._context, processFolder);
        return scenarioChanged || processChanged;
    }

    /**
     * Нормализует список параметров
     */
    private normalizeParameters(raw: unknown): YamlParameter[] {
        return normalizeCompilerParameterRows(raw);
    }

    /**
     * Нормализует список дополнительных параметров Vanessa
     */
    private normalizeAdditionalVanessaParameters(raw: unknown): AdditionalVanessaParameter[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const result: AdditionalVanessaParameter[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const key = String((item as { key?: unknown }).key || '').trim();
            const rawValue = (item as { value?: unknown }).value;
            const value = this.stringifyAnyJsonValue(rawValue);
            if (!key) {
                continue;
            }
            const overrideExisting = Boolean(
                (item as { overrideExisting?: unknown }).overrideExisting
                ?? (item as { priority?: unknown }).priority
            );
            const declaredKind = (item as { valueKind?: unknown }).valueKind;
            const valueKind = typeof declaredKind === 'string' && ['string', 'number', 'boolean', 'array', 'object', 'null'].includes(declaredKind)
                ? declaredKind as AdditionalParameterValueKind : typeof rawValue !== 'string' && rawValue !== undefined ? this.jsonValueKind(rawValue) : undefined;
            result.push({ key, value, overrideExisting, ...(valueKind ? { valueKind } : {}) });
        }

        return result;
    }

    /**
     * Нормализует список пользовательских GlobalVars
     */
    private normalizeGlobalVanessaVariables(raw: unknown): GlobalVanessaVariable[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const result: GlobalVanessaVariable[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const key = String((item as { key?: unknown }).key || '').trim();
            const value = String((item as { value?: unknown }).value || '');
            if (!key) {
                continue;
            }
            const overrideExisting = Boolean(
                (item as { overrideExisting?: unknown }).overrideExisting
                ?? (item as { priority?: unknown }).priority
            );
            result.push({ key, value, overrideExisting });
        }

        return result;
    }

    private stringifyAnyJsonValue(value: unknown): string {
        if (value === null) { return 'null'; }
        if (value === undefined) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
            return String(value);
        }
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    private jsonValueKind(value: unknown): AdditionalParameterValueKind {
        return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value as AdditionalParameterValueKind;
    }

    private flattenAdditionalParametersFromJson(
        value: unknown,
        currentPath: string,
        result: AdditionalVanessaParameter[]
    ): void {
        if (Array.isArray(value)) {
            if (currentPath) { result.push({ key: currentPath, value: this.stringifyAnyJsonValue(value), overrideExisting: false, valueKind: 'array' }); }
            return;
        }

        if (value && typeof value === 'object') {
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length === 0) {
                if (currentPath) {
                    result.push({
                        key: currentPath,
                        value: '{}',
                        valueKind: 'object',
                        overrideExisting: false
                    });
                }
                return;
            }

            entries.forEach(([rawKey, item]) => {
                const key = rawKey.trim();
                if (!key) {
                    return;
                }
                const escape = (part: string) => part.replace(/~/g, '~0').replace(/\//g, '~1');
                const nextPath = currentPath.startsWith('/') ? `${currentPath}/${escape(key)}`
                    : /[.\[\]/~]/u.test(key) ? `/${[...(currentPath ? currentPath.split('.') : []), key].map(escape).join('/')}`
                        : currentPath ? `${currentPath}.${key}` : key;
                this.flattenAdditionalParametersFromJson(item, nextPath, result);
            });
            return;
        }

        if (!currentPath) {
            return;
        }

        result.push({
            key: currentPath,
            value: this.stringifyAnyJsonValue(value),
            valueKind: this.jsonValueKind(value),
            overrideExisting: false
        });
    }

    private parseJsonText(jsonText: string): unknown {
        const normalized = jsonText.replace(/^\uFEFF/, '');
        return JSON.parse(normalized);
    }

    private parseAdditionalParametersFromJsonData(jsonData: unknown): AdditionalVanessaParameter[] | null {
        if (Array.isArray(jsonData)) {
            return this.normalizeAdditionalVanessaParameters(jsonData);
        }

        if (!jsonData || typeof jsonData !== 'object') {
            return null;
        }

        const maybeContainer = jsonData as { additionalVanessaParameters?: unknown };
        if (Array.isArray(maybeContainer.additionalVanessaParameters)) {
            return this.normalizeAdditionalVanessaParameters(maybeContainer.additionalVanessaParameters);
        }

        const additional: AdditionalVanessaParameter[] = [];
        this.flattenAdditionalParametersFromJson(jsonData, '', additional);
        return this.normalizeAdditionalVanessaParameters(additional);
    }

    private parseGlobalVarsFromJsonData(jsonData: unknown): GlobalVanessaVariable[] | null {
        if (Array.isArray(jsonData)) {
            return this.normalizeGlobalVanessaVariables(jsonData);
        }

        if (!jsonData || typeof jsonData !== 'object') {
            return null;
        }

        const asObject = jsonData as Record<string, unknown>;
        const directContainer = Object.keys(asObject).find(
            key => key.trim().toLowerCase() === 'globalvars' || key.trim().toLowerCase() === 'глобальныепеременные'
        );
        if (directContainer) {
            const varsNode = asObject[directContainer];
            if (!varsNode || typeof varsNode !== 'object' || Array.isArray(varsNode)) {
                return [];
            }
            return this.normalizeGlobalVanessaVariables(
                Object.entries(varsNode as Record<string, unknown>).map(([key, value]) => ({
                    key,
                    value: this.stringifyAnyJsonValue(value),
                    overrideExisting: false
                }))
            );
        }

        const maybeContainer = jsonData as { globalVanessaVariables?: unknown };
        if (Array.isArray(maybeContainer.globalVanessaVariables)) {
            return this.normalizeGlobalVanessaVariables(maybeContainer.globalVanessaVariables);
        }

        return this.normalizeGlobalVanessaVariables(
            Object.entries(asObject).map(([key, value]) => ({
                key,
                value: this.stringifyAnyJsonValue(value),
                overrideExisting: false
            }))
        );
    }

    private getDefaultState(): YamlParametersState {
        return {
            activeProfileId: DEFAULT_YAML_PARAMETERS_PROFILE_ID,
            profiles: [this.createDefaultProfile()]
        };
    }

    private async loadParametersState(): Promise<YamlParametersState> {
        const saved = await this._context.secrets.get(this.storageKey);
        return this.parseParametersState(saved ?? await this.loadProjectSeed());
    }

    private loadProjectSeed(): Promise<string | undefined> {
        this.projectSeed ??= (async () => {
            if (!this.projectRoot) { return undefined; }
            const file = path.join(this.projectRoot, '.kot', 'parameter-profiles.json');
            try {
                const saved = await fs.promises.readFile(file, 'utf8');
                const payload = JSON.parse(saved) as Partial<YamlParametersStorageV5>;
                if (payload?.version !== 5 || !Array.isArray(payload.profiles) || !payload.profiles.length ||
                    !payload.profiles.every(profile => profile && typeof profile.id === 'string' && typeof profile.name === 'string' &&
                        Array.isArray(profile.buildParameters) && Array.isArray(profile.additionalVanessaParameters) && Array.isArray(profile.globalVanessaVariables)) ||
                    !payload.profiles.some(profile => profile.id === payload.activeProfileId)) {
                    throw new Error('Expected a v5 profile collection with an active profile.');
                }
                return saved;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    void vscode.window.showWarningMessage(this.t('Could not load initial project profiles from {0}: {1}', file, String(error)));
                }
                return undefined;
            }
        })();
        return this.projectSeed;
    }

    private parseParametersState(saved: string | undefined): YamlParametersState {
        try {
            if (!saved) {
                return this.getDefaultState();
            }

            const parsed = JSON.parse(saved) as unknown;
            // Legacy format: plain array of build parameters.
            if (Array.isArray(parsed)) {
                const legacyBuild = this.normalizeParameters(parsed);
                const defaultProfile = this.createDefaultProfile();
                return {
                    activeProfileId: defaultProfile.id,
                    profiles: [{
                        ...defaultProfile,
                        buildParameters: this.normalizeBuildParametersForUi(
                            legacyBuild.length > 0 ? legacyBuild : this.getDefaultParameters(), true
                        )
                    }]
                };
            }

            if (parsed && typeof parsed === 'object') {
                const payload = parsed as Partial<Omit<YamlParametersStorageV5, 'version'>> & {
                    version?: number;
                    buildParameters?: unknown;
                    additionalVanessaParameters?: unknown;
                    globalVanessaVariables?: unknown;
                };

                if (Array.isArray(payload.profiles)) {
                    const profiles = this.normalizeProfiles(payload.profiles, undefined, (payload.version ?? 0) < 5);
                    const activeProfileId = String(payload.activeProfileId || '').trim();
                    const resolvedActiveProfileId = profiles.some(profile => profile.id === activeProfileId)
                        ? activeProfileId
                        : profiles[0].id;
                    return {
                        activeProfileId: resolvedActiveProfileId,
                        profiles
                    };
                }

                // v3 payload with a single parameter set.
                const buildParameters = this.normalizeParameters(payload.buildParameters);
                const defaultProfile = this.createDefaultProfile();
                return {
                    activeProfileId: defaultProfile.id,
                    profiles: [{
                        ...defaultProfile,
                        buildParameters: this.normalizeBuildParametersForUi(
                            buildParameters.length > 0 ? buildParameters : this.getDefaultParameters(), true
                        ),
                        additionalVanessaParameters: this.normalizeAdditionalVanessaParameters(payload.additionalVanessaParameters),
                        globalVanessaVariables: this.normalizeGlobalVanessaVariables(payload.globalVanessaVariables)
                    }]
                };
            }
        } catch (error) {
            console.error('Error loading build scenario parameters:', error);
        }

        return this.getDefaultState();
    }

    private async saveParametersState(state: YamlParametersState): Promise<void> {
        // Preserve request order when an autosave and a profile selection overlap.
        const save = this.parametersSaveQueue.then(async () => {
            const previousState = await this.loadParametersState();
            const normalizedProfiles = this.normalizeProfiles(state.profiles);
            const activeProfileId = normalizedProfiles.some(profile => profile.id === state.activeProfileId)
                ? state.activeProfileId
                : normalizedProfiles[0].id;
            const payload: YamlParametersStorageV5 = {
                version: 5,
                activeProfileId,
                profiles: normalizedProfiles
            };
            await this._context.secrets.store(this.storageKey, JSON.stringify(payload));

            const change = getActiveYamlParametersProfileChange(previousState, {
                activeProfileId,
                profiles: normalizedProfiles
            });
            if (change) {
                this.activeProfileChangeEmitter.fire(change);
            }
        });
        this.parametersSaveQueue = save.catch(() => undefined);
        await save;
    }

    /**
     * Загружает сохраненные build-параметры или возвращает параметры по умолчанию
     */
    public async loadParameters(): Promise<YamlParameter[]> {
        const state = await this.loadParametersState();
        return this.getActiveProfileFromState(state).buildParameters;
    }

    /**
     * Загружает дополнительные Vanessa-параметры
     */
    public async loadAdditionalVanessaParameters(): Promise<AdditionalVanessaParameter[]> {
        const state = await this.loadParametersState();
        return this.getActiveProfileFromState(state).additionalVanessaParameters;
    }

    /**
     * Загружает пользовательские GlobalVars
     */
    public async loadGlobalVanessaVariables(): Promise<GlobalVanessaVariable[]> {
        const state = await this.loadParametersState();
        return this.getActiveProfileFromState(state).globalVanessaVariables;
    }

    public async loadActiveProfileSnapshot(): Promise<ActiveYamlParametersProfile> {
        return createActiveYamlParametersProfileSnapshot(await this.loadParametersState());
    }

    /** Keep library registration and file conversion together; failed conversions restore the profile. */
    public async withProjectLibraryFolder<T>(profileId: string, workspaceFolderPath: string, folder: string, operation: () => Promise<T>): Promise<T> {
        const transaction = this.parametersSaveQueue.then(async () => {
            const { addProjectLibraryFolder } = await import('./projectLibraryRoots.js');
            const original = await this._context.secrets.get(this.storageKey);
            const state = await this.loadParametersState();
            const profile = this.getActiveProfileFromState(state);
            if (profile.id !== profileId) { throw new Error(vscode.l10n.t('The active build profile changed. Retry the conversion.')); }
            const updated = { ...profile, ...addProjectLibraryFolder({ workspaceFolderPath, profileId,
                buildParameters: profile.buildParameters, additionalVanessaParameters: profile.additionalVanessaParameters }, folder) };
            if (JSON.stringify(updated) === JSON.stringify(profile)) { return operation(); }
            const next = { activeProfileId: state.activeProfileId, profiles: state.profiles.map(item => item.id === profileId ? updated : item) };
            const payload = JSON.stringify({ version: 5, ...next });
            if (await this._context.secrets.get(this.storageKey) !== original) { throw new Error(vscode.l10n.t('The active build profile changed. Retry the conversion.')); }
            await this._context.secrets.store(this.storageKey, payload);
            let result: T;
            try { result = await operation(); }
            catch (error) {
                try {
                    if (await this._context.secrets.get(this.storageKey) !== payload) {
                        throw new Error(vscode.l10n.t('The build profile changed externally; its current settings were preserved.'));
                    }
                    if (original === undefined) { await this._context.secrets.delete(this.storageKey); }
                    else { await this._context.secrets.store(this.storageKey, original); }
                } catch (recoveryError) { throw new AggregateError([error, recoveryError], `${String(error)}; ${String(recoveryError)}`, { cause: error }); }
                throw error;
            }
            const change = getActiveYamlParametersProfileChange(state, next);
            if (change) { this.activeProfileChangeEmitter.fire(change); }
            return result;
        });
        this.parametersSaveQueue = transaction.then(() => undefined, () => undefined);
        return transaction;
    }

    /** Reads a saved profile without changing the active profile or scan root. */
    public async loadProfileSnapshot(profileId: string): Promise<ActiveYamlParametersProfile | undefined> {
        const state = await this.loadParametersState();
        const selectedId = profileId.trim();
        if (!state.profiles.some(profile => profile.id === selectedId)) {
            return undefined;
        }
        return createActiveYamlParametersProfileSnapshot({ ...state, activeProfileId: selectedId });
    }

    /** Copy a legacy shared profile into this project without modifying the original. */
    public async importLegacyProfile(profileId: string): Promise<boolean> {
        const transaction = this.parametersSaveQueue.then(async () => {
            const saved = await this._context.secrets.get(YAML_PARAMETERS_KEY);
            if (!saved) { return false; }
            const source = this.parseParametersState(saved).profiles.find(profile => profile.id === profileId);
            if (!source) { return false; }
            const state = await this.loadParametersState();
            const profile = this.cloneProfile(source, { id: this.createGeneratedProfileId(state.profiles) });
            const next = { activeProfileId: profile.id, profiles: [...state.profiles, profile] };
            await this._context.secrets.store(this.storageKey, JSON.stringify({ version: 5, ...next }));
            const change = getActiveYamlParametersProfileChange(state, next);
            if (change) { this.activeProfileChangeEmitter.fire(change); }
            return true;
        });
        this.parametersSaveQueue = transaction.then(() => undefined, () => undefined);
        return transaction;
    }

    /** New setup profiles start clean; explicit duplication copies existing values. */
    public async createSetupProfile(name: string, buildParameters: readonly YamlParameter[]): Promise<string> {
        const transaction = this.parametersSaveQueue.then(async () => {
            const original = await this._context.secrets.get(this.storageKey);
            const state = await this.loadParametersState();
            const id = this.createGeneratedProfileId(state.profiles);
            const profile: YamlParametersProfile = { ...this.createDefaultProfile(id, name.trim() || 'KOT'),
                buildParameters: this.normalizeBuildParametersForUi(this.normalizeParameters([...buildParameters])) };
            if (await this._context.secrets.get(this.storageKey) !== original) { throw new Error(vscode.l10n.t('The active build profile changed. Retry the conversion.')); }
            const next = { activeProfileId: id, profiles: this.normalizeProfiles([...state.profiles, profile]) };
            await this._context.secrets.store(this.storageKey, JSON.stringify({ version: 5, ...next }));
            const change = getActiveYamlParametersProfileChange(state, next);
            if (change) { this.activeProfileChangeEmitter.fire(change); }
            return { id, parameters: profile.buildParameters };
        });
        this.parametersSaveQueue = transaction.then(() => undefined, () => undefined);
        const result = await transaction;
        await this.syncYamlSourceDirectorySettingFromBuildParameters(result.parameters);
        return result.id;
    }

    public async getProfilesSummary(): Promise<YamlParametersProfilesSummary> {
        const state = await this.loadParametersState();
        const activeProfile = this.getActiveProfileFromState(state);
        return {
            activeProfileId: activeProfile.id,
            profiles: state.profiles.map(profile => ({
                id: profile.id,
                name: profile.name
            }))
        };
    }

    public async setActiveProfile(profileId: string): Promise<boolean> {
        const normalizedProfileId = String(profileId).trim();
        if (!normalizedProfileId) {
            return false;
        }

        const state = await this.loadParametersState();
        const currentActiveProfile = this.getActiveProfileFromState(state);
        if (currentActiveProfile.id === normalizedProfileId) {
            return false;
        }

        const requestedProfile = state.profiles.find(profile => profile.id === normalizedProfileId);
        if (!requestedProfile) {
            return false;
        }

        const nextState: YamlParametersState = {
            ...state,
            activeProfileId: requestedProfile.id
        };
        await this.saveParametersState(nextState);
        await this.syncYamlSourceDirectorySettingFromBuildParameters(requestedProfile.buildParameters);
        await vscode.commands.executeCommand('kotTestToolkit.refreshCombinedRunJsonArtifacts');
        return true;
    }

    /**
     * Сохраняет build-параметры в SecretStorage (совместимость со старым API)
     */
    public async saveParameters(parameters: YamlParameter[]): Promise<void> {
        try {
            const state = await this.loadParametersState();
            const activeProfile = this.getActiveProfileFromState(state);
            await this.saveParametersState({
                activeProfileId: activeProfile.id,
                profiles: state.profiles.map(profile => profile.id === activeProfile.id
                    ? {
                        ...profile,
                        buildParameters: this.normalizeBuildParametersForUi(this.normalizeParameters(parameters))
                    }
                    : profile)
            });
        } catch (error) {
            console.error('Error saving build scenario parameters:', error);
            throw error;
        }
    }

    /**
     * Сохраняет обе секции параметров
     */
    public async saveAllParameters(
        buildParameters: YamlParameter[],
        additionalVanessaParameters: AdditionalVanessaParameter[],
        globalVanessaVariables: GlobalVanessaVariable[]
    ): Promise<void> {
        try {
            const state = await this.loadParametersState();
            const activeProfile = this.getActiveProfileFromState(state);
            await this.saveParametersState({
                activeProfileId: activeProfile.id,
                profiles: state.profiles.map(profile => profile.id === activeProfile.id
                    ? {
                        ...profile,
                        buildParameters: this.normalizeBuildParametersForUi(this.normalizeParameters(buildParameters)),
                        additionalVanessaParameters: this.normalizeAdditionalVanessaParameters(additionalVanessaParameters),
                        globalVanessaVariables: this.normalizeGlobalVanessaVariables(globalVanessaVariables)
                    }
                    : profile)
            });
        } catch (error) {
            console.error('Error saving build scenario parameters:', error);
            throw error;
        }
    }

    /**
     * Создает JSON файл для дополнительных параметров Vanessa
     */
    public async createAdditionalVanessaParametersFile(targetPath: string, parameters: AdditionalVanessaParameter[]): Promise<void> {
        const { applyAdditionalVanessaParameters } = await import('./vanessaLaunchJson.js');
        const payload = applyAdditionalVanessaParameters({}, parameters.map(param => ({ ...param, overrideExisting: true }))).value;

        const targetDir = path.dirname(targetPath);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const jsonContent = JSON.stringify(payload, null, 2);
        await fs.promises.writeFile(targetPath, jsonContent, 'utf8');
    }

    /**
     * Создает JSON файл для пользовательских GlobalVars
     */
    public async createGlobalVanessaVariablesFile(targetPath: string, parameters: GlobalVanessaVariable[]): Promise<void> {
        const payload: Record<string, string> = {};
        parameters.forEach(param => {
            if (!param.key.trim()) {
                return;
            }
            payload[param.key.trim()] = param.value;
        });

        const targetDir = path.dirname(targetPath);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const jsonContent = JSON.stringify(payload, null, 2);
        await fs.promises.writeFile(targetPath, jsonContent, 'utf8');
    }

    /**
     * Создает файл yaml_parameters.json из сохранённых build-параметров
     */
    public async createYamlParametersFile(targetPath: string): Promise<void>;
    public async createYamlParametersFile(targetPath: string, parameters: YamlParameter[]): Promise<void>;
    public async createYamlParametersFile(targetPath: string, parameters?: YamlParameter[]): Promise<void> {
        // Если параметры не переданы, загружаем из storage
        if (!parameters) {
            parameters = await this.loadParameters();
        }
        try {
            const validationErrors = this.validateBuildParameters(parameters);
            if (validationErrors.length > 0) {
                throw new Error(this.t('SPPR build parameters are incomplete: {0}', validationErrors.join(' ')));
            }

            // Получаем путь к корню проекта
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder is open');
            }
            const workspaceRoot = workspaceFolders[0].uri.fsPath;

            const yamlParams = serializeCompilerBuildParameters(parameters, workspaceRoot, {
                showDriveFeatures: this.shouldShowDriveSpecificBuildParameters()
            });

            // Создаем директорию если не существует
            const targetDir = path.dirname(targetPath);
            await fs.promises.mkdir(targetDir, { recursive: true });

            // Записываем файл с правильным форматированием путей
            const jsonContent = JSON.stringify(yamlParams, null, 2);
            await fs.promises.writeFile(targetPath, jsonContent, 'utf8');
        } catch (error) {
            console.error('Error creating build scenario parameters file:', error);
            throw error;
        }
    }

    public async openGeneratedYamlParametersFile(parameters: YamlParameter[]): Promise<void> {
        const workspaceRootPath = this.getWorkspaceRootPath();
        if (!workspaceRootPath) {
            throw new Error(this.t('No workspace folder is open'));
        }

        const normalizedParameters = this.normalizeBuildParametersForUi(this.normalizeParameters(parameters));
        const runtimeRootPath = this.resolveRuntimeRootPath(workspaceRootPath, normalizedParameters);
        const targetPath = path.join(runtimeRootPath, 'yaml_parameters.json');
        await this.createYamlParametersFile(targetPath, normalizedParameters);

        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
        await vscode.window.showTextDocument(document, { preview: false });
    }

    /**
     * Проверяет, является ли путь абсолютным или относительным
     */
    public isAbsolutePath(pathStr: string): boolean {
        // Используем стандартную функцию Node.js для определения абсолютного пути
        return path.isAbsolute(pathStr);
    }

    /**
     * Преобразует относительный путь в абсолютный относительно корня проекта
     */
    public resolvePath(relativePath: string, workspaceRoot: string): string {
        if (this.isAbsolutePath(relativePath)) {
            return relativePath;
        }
        if (relativePath.startsWith('./') || relativePath.startsWith('../')) {
            // Это относительный путь от текущей директории, оставляем как есть
            return relativePath;
        }
        if (relativePath.startsWith('~/')) {
            // Это путь от домашней директории, оставляем как есть
            return relativePath;
        }
        // Это относительный путь к корню проекта, преобразуем в абсолютный
        return path.resolve(workspaceRoot, relativePath);
    }

    /**
     * Открывает панель управления YAML параметрами
     */
    public async openYamlParametersPanel(): Promise<void> {
        await this.loadLocalizationBundleIfNeeded();

        const panel = vscode.window.createWebviewPanel(
            'yamlParametersPanel',
            this.t('Compilation and run parameters'),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this._extensionUri, 'media')
                ]
            }
        );

        const state = await this.loadParametersState();
        const activeProfile = this.getActiveProfileFromState(state);
        const html = await this.getWebviewContent(
            panel.webview,
            activeProfile.buildParameters,
            activeProfile.additionalVanessaParameters,
            activeProfile.globalVanessaVariables,
            state.activeProfileId,
            state.profiles
        );
        panel.webview.html = html;

        let watchedModelDbFile = '';
        let modelDbWatcher: vscode.FileSystemWatcher | undefined;
        const watchModelDbFile = (file: string) => {
            if (file === watchedModelDbFile) { return; }
            modelDbWatcher?.dispose();
            watchedModelDbFile = file;
            if (!file) { modelDbWatcher = undefined; return; }
            modelDbWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
            const changed = () => { void panel.webview.postMessage({ command: 'refreshModelDbSettings' }); };
            modelDbWatcher.onDidChange(changed); modelDbWatcher.onDidCreate(changed); modelDbWatcher.onDidDelete(changed);
        };
        panel.onDidDispose(() => modelDbWatcher?.dispose());

        // Обработка сообщений от webview
        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'inspectModelDbSettings': {
                        const parameters = this.normalizeParameters(message.parameters);
                        const root = this.getWorkspaceRootPath();
                        const configured = getCompilerBuildParameterValue(parameters, 'ModelDBSettings').trim();
                        const foreignPath = process.platform !== 'win32' && path.win32.isAbsolute(configured) && !path.isAbsolute(configured);
                        const file = root && configured && !foreignPath ? path.resolve(root, configured) : '';
                        watchModelDbFile(file);
                        const { inspectCompilerModelDbStatus } = await import('./compilerModelDbStatus.js');
                        const status = await inspectCompilerModelDbStatus(parameters, root);
                        const descriptions = {
                            unconfigured: 'ModelDBSettings is empty. Select a catalog to resolve infobases and user profiles.',
                            inaccessible: 'ModelDBSettings cannot be read on this computer.',
                            missing: 'ModelDBSettings file does not exist. Create it with the reference infobases manager or select an existing catalog.',
                            invalid: 'ModelDBSettings is not a valid reference infobases YAML catalog.',
                            empty: 'ModelDBSettings contains no infobases. Add an infobase in the reference infobases manager.',
                            selectedBaseMissing: 'ModelDBid was not found in ModelDBSettings.',
                            noProfiles: 'ModelDBSettings: {0} infobases, {1} user profiles. Some selected infobases have no user profiles.',
                            ready: 'ModelDBSettings: {0} infobases, {1} user profiles.'
                        };
                        await panel.webview.postMessage({ command: 'modelDbSettingsStatus', requestId: message.requestId,
                            activeProfileId: message.activeProfileId, state: status.state,
                            message: this.t(descriptions[status.state], String(status.baseCount), String(status.profileCount)) });
                        break;
                    }
                    case 'selectAdditionalParameter':
                        await this.selectAdditionalParameter(panel, message.keys);
                        break;
                    case 'saveParameters':
                        try {
                            const result = await this.persistManagerStateFromMessage(message, {
                                validateBeforeSave: true,
                                syncScanRoot: true,
                                refreshCombinedArtifacts: true
                            });
                            const savedAt = new Date().toISOString();
                            await panel.webview.postMessage({
                                command: 'saveStatus',
                                kind: result.validationErrors.length > 0 ? 'warning' : 'saved',
                                savedAt,
                                message: result.validationErrors.length > 0
                                    ? this.t('Saved, but build parameters need attention: {0}', result.validationErrors.join(' '))
                                    : result.scanRootChanged
                                        ? this.t('Saved. YAML scan root synchronized from ScenarioFolder.')
                                        : this.t('Saved')
                            });
                        } catch (error) {
                            await panel.webview.postMessage({
                                command: 'saveStatus',
                                kind: 'error',
                                message: this.t('Auto-save failed: {0}', String(error))
                            });
                            vscode.window.showErrorMessage(this.t('Error saving parameters: {0}', String(error)));
                        }
                        break;
                    case 'autoSaveParameters':
                        try {
                            const result = await this.persistManagerStateFromMessage(message, {
                                validateBeforeSave: true,
                                syncScanRoot: true,
                                refreshCombinedArtifacts: true
                            });
                            const savedAt = new Date().toISOString();
                            await panel.webview.postMessage({
                                command: 'saveStatus',
                                kind: result.validationErrors.length > 0 ? 'warning' : 'saved',
                                savedAt,
                                message: result.validationErrors.length > 0
                                    ? this.t('Saved, but build parameters need attention: {0}', result.validationErrors.join(' '))
                                    : result.scanRootChanged
                                        ? this.t('Saved. YAML scan root synchronized from ScenarioFolder.')
                                        : this.t('Saved')
                            });
                        } catch (error) {
                            console.warn('[YamlParametersManager] Auto-save failed:', error);
                            await panel.webview.postMessage({
                                command: 'saveStatus',
                                kind: 'error',
                                message: this.t('Auto-save failed: {0}', String(error))
                            });
                        }
                        break;
                    case 'createYamlFile':
                        try {
                            const workspaceFolders = vscode.workspace.workspaceFolders;
                            if (!workspaceFolders || workspaceFolders.length === 0) {
                                vscode.window.showErrorMessage(this.t('No workspace folder is open'));
                                return;
                            }

                            // Предлагаем выбрать место для сохранения
                            const uri = await vscode.window.showSaveDialog({
                                title: this.t('Save SPPR compilation parameters File'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                defaultUri: vscode.Uri.file('yaml_parameters.json')
                            });

                            if (uri) {
                                const buildParameters = this.normalizeParameters(message.buildParameters ?? message.parameters);
                                await this.createYamlParametersFile(uri.fsPath, buildParameters);

                                // Показываем уведомление с кнопками
                                const action = await vscode.window.showInformationMessage(
                                    this.t('Build scenario parameters file created at: {0}', uri.fsPath),
                                    this.t('Open File'),
                                    this.t('Open Folder')
                                );

                                if (action === this.t('Open File')) {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    await vscode.window.showTextDocument(doc);
                                } else if (action === this.t('Open Folder')) {
                                    // Открываем папку с выделенным файлом
                                    vscode.commands.executeCommand('revealFileInOS', uri);
                                }
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error creating JSON file: {0}', String(error)));
                        }
                        break;
                    case 'openGeneratedYamlParametersFile':
                        try {
                            const buildParameters = this.normalizeBuildParametersForUi(
                                this.normalizeParameters(message.buildParameters ?? message.parameters)
                            );
                            await this.openGeneratedYamlParametersFile(buildParameters);
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error opening generated yaml_parameters.json: {0}', String(error)));
                        }
                        break;
                    case 'manageProfiles':
                        try {
                            await this.manageProfiles(panel, message);
                        } catch (error) {
                            console.warn('[YamlParametersManager] Failed to manage profiles:', error);
                            await panel.webview.postMessage({
                                command: 'saveStatus',
                                requestId: message.requestId,
                                kind: 'error',
                                message: this.t('Auto-save failed: {0}', String(error))
                            });
                        }
                        break;
                    case 'loadBuildFromJson':
                        try {
                            const uris = await vscode.window.showOpenDialog({
                                title: this.t('Load SPPR compilation parameters from JSON'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                canSelectMany: false
                            });

                            if (uris && uris.length > 0) {
                                const filePath = uris[0].fsPath;
                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                const jsonData = this.parseJsonText(fileContent);

                                // Проверяем, что это объект с ключ-значение
                                if (typeof jsonData === 'object' && jsonData !== null && !Array.isArray(jsonData)) {
                                    const buildParameters = importCompilerBuildParameters(jsonData) ?? [];

                                    // Отправляем новые параметры в webview
                                    panel.webview.postMessage({
                                        command: 'loadBuildParameters',
                                        buildParameters: this.normalizeBuildParametersForUi(buildParameters)
                                    });

                                    vscode.window.showInformationMessage(this.t('Loaded {0} parameters from {1}', buildParameters.length.toString(), path.basename(filePath)));
                                } else {
                                    vscode.window.showErrorMessage(this.t('Invalid JSON format. Expected key-value object.'));
                                }
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error loading JSON file: {0}', String(error)));
                        }
                        break;
                    case 'createAdditionalJsonFile':
                        try {
                            const uri = await vscode.window.showSaveDialog({
                                title: this.t('Save Additional Vanessa Parameters File'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                defaultUri: vscode.Uri.file('vanessa_additional_parameters.json')
                            });

                            if (uri) {
                                const additionalParameters = this.normalizeAdditionalVanessaParameters(message.additionalVanessaParameters);
                                await this.createAdditionalVanessaParametersFile(uri.fsPath, additionalParameters);

                                const action = await vscode.window.showInformationMessage(
                                    this.t('Additional Vanessa parameters file created at: {0}', uri.fsPath),
                                    this.t('Open File'),
                                    this.t('Open Folder')
                                );

                                if (action === this.t('Open File')) {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    await vscode.window.showTextDocument(doc);
                                } else if (action === this.t('Open Folder')) {
                                    vscode.commands.executeCommand('revealFileInOS', uri);
                                }
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error creating JSON file: {0}', String(error)));
                        }
                        break;
                    case 'loadAdditionalFromJson':
                        try {
                            const uris = await vscode.window.showOpenDialog({
                                title: this.t('Load Additional Vanessa Parameters from JSON'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                canSelectMany: false
                            });

                            if (uris && uris.length > 0) {
                                const filePath = uris[0].fsPath;
                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                const jsonData = this.parseJsonText(fileContent);
                                const additionalParameters = this.parseAdditionalParametersFromJsonData(jsonData);
                                if (!additionalParameters) {
                                    vscode.window.showErrorMessage(this.t('Invalid JSON format. Expected key-value object.'));
                                    return;
                                }

                                panel.webview.postMessage({
                                    command: 'loadAdditionalParameters',
                                    additionalParameters
                                });

                                vscode.window.showInformationMessage(
                                    this.t('Loaded {0} parameters from {1}', additionalParameters.length.toString(), path.basename(filePath))
                                );
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error loading JSON file: {0}', String(error)));
                        }
                        break;
                    case 'createGlobalVarsJsonFile':
                        try {
                            const uri = await vscode.window.showSaveDialog({
                                title: this.t('Save Global Variables File'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                defaultUri: vscode.Uri.file('vanessa_global_vars.json')
                            });

                            if (uri) {
                                const globalVariables = this.normalizeGlobalVanessaVariables(message.globalVanessaVariables);
                                await this.createGlobalVanessaVariablesFile(uri.fsPath, globalVariables);

                                const action = await vscode.window.showInformationMessage(
                                    this.t('Global variables file created at: {0}', uri.fsPath),
                                    this.t('Open File'),
                                    this.t('Open Folder')
                                );

                                if (action === this.t('Open File')) {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    await vscode.window.showTextDocument(doc);
                                } else if (action === this.t('Open Folder')) {
                                    vscode.commands.executeCommand('revealFileInOS', uri);
                                }
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error creating JSON file: {0}', String(error)));
                        }
                        break;
                    case 'loadGlobalVarsFromJson':
                        try {
                            const uris = await vscode.window.showOpenDialog({
                                title: this.t('Load Global Variables from JSON'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                canSelectMany: false
                            });

                            if (uris && uris.length > 0) {
                                const filePath = uris[0].fsPath;
                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                const jsonData = this.parseJsonText(fileContent);
                                const globalVariables = this.parseGlobalVarsFromJsonData(jsonData);
                                if (!globalVariables) {
                                    vscode.window.showErrorMessage(this.t('Invalid JSON format. Expected key-value object.'));
                                    return;
                                }

                                panel.webview.postMessage({
                                    command: 'loadGlobalVanessaVariables',
                                    globalVanessaVariables: globalVariables
                                });

                                vscode.window.showInformationMessage(
                                    this.t('Loaded {0} global variables from {1}', globalVariables.length.toString(), path.basename(filePath))
                                );
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error loading JSON file: {0}', String(error)));
                        }
                        break;
                }
            }
        );
    }

    private async selectAdditionalParameter(panel: vscode.WebviewPanel, keys: unknown): Promise<void> {
        try {
            const { loadVanessaParameterCatalogSnapshot, createVanessaParameterFieldDefinitions } = await import('./vanessaParameterCatalog.js');
            const { getVanessaParameterAliases } = await import('./vanessaLaunchJson.js');
            const current = Array.isArray(keys) ? keys.filter((key: unknown): key is string => typeof key === 'string') : [];
            const same = (key: string) => current.some((old: string) => getVanessaParameterAliases(key).some(alias => alias.toLocaleLowerCase() === old.trim().toLocaleLowerCase()));
            const profile = await this.loadActiveProfileSnapshot();
            const snapshot = await loadVanessaParameterCatalogSnapshot(this.getVanessaCatalogFolder(profile.buildParameters), this.getWorkspaceRootPath());
            const catalog = snapshot.definitions;
            const selected = await vscode.window.showQuickPick([
                { label: `$(add) ${this.t('Custom parameter…')}`, definition: undefined },
                ...catalog.filter(entry => !same(entry.key) && !entry.aliases.some(same)).map(definition => ({ label: definition.key,
                    description: definition.aliases.join(', '), detail: definition.description, definition }))
            ], { title: this.t('Additional Vanessa Automation parameters'), matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
            if (!selected) { return; }
            const key = selected.definition?.key ?? await vscode.window.showInputBox({
                title: this.t('Custom parameter…'), prompt: this.t('Parameter name or nested JSON path'), ignoreFocusOut: true,
                validateInput: value => !value.trim() ? this.t('Name cannot be empty') : same(value.trim()) ? this.t('This parameter is already added.') : undefined
            });
            if (key?.trim()) { await panel.webview.postMessage({ command: 'appendAdditionalParameter', activeProfileId: profile.id,
                catalogStatus: this.vanessaCatalogStatus(snapshot), definitions: createVanessaParameterFieldDefinitions(catalog, snapshot.authoritative), parameter: {
                key: key.trim(), value: selected.definition?.value ?? '', overrideExisting: false,
                ...(selected.definition && selected.definition.valueKind !== 'unknown' ? { valueKind: selected.definition.valueKind } : {})
            } }); }
        } catch (error) { vscode.window.showErrorMessage(this.t('Could not load Vanessa parameters: {0}', String(error))); }
    }

    private getVanessaCatalogFolder(parameters: readonly YamlParameter[]): string {
        let folder = getEffectiveVanessaFolder(parameters) || this.getDefaultVanessaFolderValue();
        const root = this.getWorkspaceRootPath();
        if (root) { folder = folder.replace(/\$\{workspaceFolder\}|^#SourcesPath(?=$|[\\/])/gi, root); }
        if (!folder || this.isAbsolutePath(folder) || path.win32.isAbsolute(folder)) { return folder; }
        return root ? path.resolve(root, folder) : folder;
    }

    private vanessaCatalogStatus(snapshot: { authoritative: boolean; version?: string; source?: string }): string {
        if (snapshot.source === 'documentation') {
            return snapshot.version ? this.t('Vanessa documentation: {0}', snapshot.version) : this.t('Catalog from selected Vanessa documentation');
        }
        return snapshot.authoritative ? snapshot.version ? this.t('Vanessa sources: {0}', snapshot.version) : this.t('Catalog from selected Vanessa sources')
            : this.t('Built-in parameter catalog');
    }

    private async refreshVanessaParameterDefinitions(panel: vscode.WebviewPanel, profile: YamlParametersProfile, revision: number): Promise<void> {
        const { loadVanessaParameterCatalogSnapshot, createVanessaParameterFieldDefinitions } = await import('./vanessaParameterCatalog.js');
        const snapshot = await loadVanessaParameterCatalogSnapshot(this.getVanessaCatalogFolder(profile.buildParameters), this.getWorkspaceRootPath());
        await panel.webview.postMessage({ command: 'vanessaParameterDefinitionsUpdated', activeProfileId: profile.id, revision,
            catalogStatus: this.vanessaCatalogStatus(snapshot), definitions: createVanessaParameterFieldDefinitions(snapshot.definitions, snapshot.authoritative) });
    }

    private async persistManagerStateFromMessage(
        message: {
            profiles?: unknown;
            activeProfileId?: unknown;
            buildParameters?: unknown;
            parameters?: unknown;
            additionalVanessaParameters?: unknown;
            globalVanessaVariables?: unknown;
        },
        options: {
            validateBeforeSave: boolean;
            syncScanRoot: boolean;
            refreshCombinedArtifacts: boolean;
        }
    ): Promise<{ buildParameters: YamlParameter[]; validationErrors: string[]; scanRootChanged: boolean; state: YamlParametersState }> {
        const currentStoredState = await this.loadParametersState();
        const state = this.normalizeStateFromMessage(message, currentStoredState);
        const activeProfile = this.getActiveProfileFromState(state);
        const buildParameters = activeProfile.buildParameters;
        const validationErrors = options.validateBeforeSave
            ? this.validateBuildParameters(buildParameters)
            : [];
        await this.saveParametersState(state);

        const scanRootChanged = options.syncScanRoot
            ? await this.syncYamlSourceDirectorySettingFromBuildParameters(buildParameters)
            : false;

        if (options.refreshCombinedArtifacts) {
            await vscode.commands.executeCommand('kotTestToolkit.refreshCombinedRunJsonArtifacts');
        }

        return {
            buildParameters,
            validationErrors,
            scanRootChanged,
            state
        };
    }

    private normalizeStateFromMessage(
        message: {
            profiles?: unknown;
            activeProfileId?: unknown;
            buildParameters?: unknown;
            parameters?: unknown;
            additionalVanessaParameters?: unknown;
            globalVanessaVariables?: unknown;
        },
        fallbackState: YamlParametersState
    ): YamlParametersState {
        if (Array.isArray(message.profiles)) {
            const profiles = this.normalizeProfiles(message.profiles, this.getActiveProfileFromState(fallbackState));
            const activeProfileId = String(message.activeProfileId ?? '').trim();
            return {
                activeProfileId: profiles.some(profile => profile.id === activeProfileId)
                    ? activeProfileId
                    : profiles[0].id,
                profiles
            };
        }

        const buildParameters = this.normalizeBuildParametersForUi(
            this.normalizeParameters(message.buildParameters ?? message.parameters)
        );
        const additionalVanessaParameters = this.normalizeAdditionalVanessaParameters(message.additionalVanessaParameters);
        const globalVanessaVariables = this.normalizeGlobalVanessaVariables(message.globalVanessaVariables);
        const activeProfile = this.getActiveProfileFromState(fallbackState);

        return {
            activeProfileId: activeProfile.id,
            profiles: fallbackState.profiles.map(profile => profile.id === activeProfile.id
                ? {
                    ...profile,
                    buildParameters,
                    additionalVanessaParameters,
                    globalVanessaVariables
                }
                : profile)
        };
    }

    private async postProfilesStateUpdated(
        panel: vscode.WebviewPanel,
        state: YamlParametersState,
        savedAt: string,
        requestId?: string
    ): Promise<boolean> {
        const activeProfile = this.getActiveProfileFromState(state);
        const validationErrors = this.validateBuildParameters(activeProfile.buildParameters);
        const catalogRevision = ++this.vanessaCatalogRevision;
        // Publish the saved profile before refreshing derived files and the Test Manager.
        await panel.webview.postMessage({
            command: 'profilesStateUpdated',
            catalogRevision,
            requestId,
            activeProfileId: state.activeProfileId,
            profiles: state.profiles,
            savedAt,
            kind: validationErrors.length > 0 ? 'warning' : 'saved',
            message: validationErrors.length > 0
                ? this.t('Saved, but build parameters need attention: {0}', validationErrors.join(' '))
                : this.t('Saved')
        });

        void this.refreshVanessaParameterDefinitions(panel, activeProfile, catalogRevision).catch(error => {
            console.warn('[YamlParametersManager] Could not refresh the selected Vanessa catalog:', error);
        });

        const scanRootChanged = await this.syncYamlSourceDirectorySettingFromBuildParameters(activeProfile.buildParameters);
        await vscode.commands.executeCommand('kotTestToolkit.refreshCombinedRunJsonArtifacts');
        return scanRootChanged;
    }

    private async notifyPhaseSwitcherStateChanged(): Promise<void> {
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcher');
    }

    private async promptProfileName(
        title: string,
        initialValue: string,
        prompt: string
    ): Promise<string | undefined> {
        return vscode.window.showInputBox({
            title,
            prompt,
            value: initialValue,
            ignoreFocusOut: true,
            validateInput: value => String(value || '').trim() ? undefined : this.t('Profile name cannot be empty')
        });
    }

    private async manageProfiles(
        panel: vscode.WebviewPanel,
        message: {
            requestId?: unknown;
            profiles?: unknown;
            activeProfileId?: unknown;
            buildParameters?: unknown;
            parameters?: unknown;
            additionalVanessaParameters?: unknown;
            globalVanessaVariables?: unknown;
        }
    ): Promise<void> {
        const currentStoredState = await this.loadParametersState();
        let state = this.normalizeStateFromMessage(message, currentStoredState);
        const persistSelection = async () => {
            await this.saveParametersState(state);
            const scanRootChanged = await this.postProfilesStateUpdated(
                panel, state, new Date().toISOString(), String(message.requestId || '')
            );
            if (!scanRootChanged) { await this.notifyPhaseSwitcherStateChanged(); }
        };

        const activeProfile = this.getActiveProfileFromState(state);
        const legacySaved = await this._context.secrets.get(YAML_PARAMETERS_KEY);
        const legacyProfiles = legacySaved ? this.parseParametersState(legacySaved).profiles : [];
        const items: ProfileQuickPickItem[] = [
            { label: this.t('Profiles'), kind: vscode.QuickPickItemKind.Separator, action: 'select' },
            ...state.profiles.map(profile => ({
                label: profile.name,
                description: profile.id === state.activeProfileId ? this.t('Current') : undefined,
                action: 'select' as const,
                profileId: profile.id
            })),
            { label: this.t('Actions'), kind: vscode.QuickPickItemKind.Separator, action: 'create' },
            {
                label: this.t('New profile'),
                description: this.t('Create and activate a new profile'),
                action: 'create'
            },
            {
                label: this.t('Duplicate profile'),
                description: activeProfile.name,
                action: 'duplicate'
            },
            {
                label: this.t('Rename profile'),
                description: activeProfile.name,
                action: 'rename'
            },
            {
                label: this.t('Delete profile'),
                description: activeProfile.name,
                action: 'delete'
            }
        ];
        if (legacyProfiles.length) {
            items.push({ label: this.t('Import previous shared profile'),
                description: this.t('Copy into this project; keep the original unchanged'), action: 'importLegacy' });
        }

        const selection = await vscode.window.showQuickPick(items, {
            title: this.t('Manage profiles'),
            placeHolder: this.t('Select active profile or manage profiles'),
            ignoreFocusOut: true
        });

        if (!selection) {
            await persistSelection();
            return;
        }

        switch (selection.action) {
            case 'importLegacy': {
                const legacy = await vscode.window.showQuickPick(legacyProfiles.map(profile => ({ label: profile.name, profileId: profile.id })), {
                    title: this.t('Import previous shared profile'),
                    placeHolder: this.t('Choose a shared profile to copy into this project'), ignoreFocusOut: true
                });
                if (legacy) {
                    // Preserve edits made before opening the picker, then import into that state.
                    await this.saveParametersState(state);
                    await this.importLegacyProfile(legacy.profileId);
                    state = await this.loadParametersState();
                }
                break;
            }
            case 'select': {
                if (!selection.profileId || selection.profileId === state.activeProfileId) {
                    await persistSelection();
                    return;
                }
                state = {
                    ...state,
                    activeProfileId: selection.profileId
                };
                break;
            }
            case 'create': {
                const profileName = await this.promptProfileName(
                    this.t('Create profile'),
                    '',
                    this.t('Profile name')
                );
                if (!profileName) {
                    await persistSelection();
                    return;
                }
                const nextProfile = this.createDefaultProfile(
                    this.createGeneratedProfileId(state.profiles),
                    profileName.trim()
                );
                state = {
                    activeProfileId: nextProfile.id,
                    profiles: [...state.profiles, nextProfile]
                };
                break;
            }
            case 'duplicate': {
                const duplicatedName = await this.promptProfileName(
                    this.t('Duplicate profile'),
                    this.t('{0} copy', activeProfile.name),
                    this.t('Profile name')
                );
                if (!duplicatedName) {
                    await persistSelection();
                    return;
                }
                const duplicatedProfile = this.cloneProfile(activeProfile, {
                    id: this.createGeneratedProfileId(state.profiles),
                    name: duplicatedName.trim()
                });
                state = {
                    activeProfileId: duplicatedProfile.id,
                    profiles: [...state.profiles, duplicatedProfile]
                };
                break;
            }
            case 'rename': {
                const renamedValue = await this.promptProfileName(
                    this.t('Rename profile'),
                    activeProfile.name,
                    this.t('Profile name')
                );
                if (!renamedValue) {
                    await persistSelection();
                    return;
                }
                state = {
                    ...state,
                    profiles: state.profiles.map(profile => profile.id === activeProfile.id
                        ? { ...profile, name: renamedValue.trim() }
                        : profile)
                };
                break;
            }
            case 'delete': {
                if (state.profiles.length <= 1) {
                    void vscode.window.showWarningMessage(this.t('At least one profile must remain.'));
                    await persistSelection();
                    return;
                }
                const confirmation = await vscode.window.showWarningMessage(
                    this.t('Delete profile "{0}"?', activeProfile.name),
                    { modal: true },
                    this.t('Delete profile')
                );
                if (confirmation !== this.t('Delete profile')) {
                    await persistSelection();
                    return;
                }
                const activeIndex = state.profiles.findIndex(profile => profile.id === activeProfile.id);
                const remainingProfiles = state.profiles.filter(profile => profile.id !== activeProfile.id);
                const fallbackProfile = remainingProfiles[Math.max(0, activeIndex - 1)] || remainingProfiles[0];
                state = {
                    activeProfileId: fallbackProfile.id,
                    profiles: remainingProfiles
                };
                break;
            }
        }

        await persistSelection();
    }

    /**
     * Генерирует HTML содержимое для webview из шаблона
     */
    private async getWebviewContent(
        webview: vscode.Webview,
        buildParameters: YamlParameter[],
        additionalVanessaParameters: AdditionalVanessaParameter[],
        globalVanessaVariables: GlobalVanessaVariable[],
        activeProfileId: string,
        profiles: YamlParametersProfile[]
    ): Promise<string> {
        try {
            // URIs для ресурсов
            const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicon.css'));
            const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'yamlParameters.css'));
            const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'yamlParameters.js'));
            const textScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'kotWebviewText.js'));
            const splitScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'kotWebviewSplit.js'));
            const buildParameterStateScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'yamlBuildParameterState.js'));
            const { loadVanessaParameterCatalogSnapshot, createVanessaParameterFieldDefinitions } = await import('./vanessaParameterCatalog.js');
            const vanessaCatalog = await loadVanessaParameterCatalogSnapshot(this.getVanessaCatalogFolder(buildParameters), this.getWorkspaceRootPath());
            const vanessaParameterDefinitions = createVanessaParameterFieldDefinitions(vanessaCatalog.definitions, vanessaCatalog.authoritative);

            // Nonce для CSP
            const nonce = this.getNonce();

            // Определяем язык интерфейса
            const langOverride = this._langOverride;
            const effectiveLang = langOverride === 'System' ? (vscode.env.language || 'English') : langOverride;
            const localeHtmlLang = effectiveLang.split('-')[0];

            // Создаем объект переводов
            const loc = {
                title: this.t('Compilation and run parameters'),
                projectProfiles: this.escapeHtml(this.projectRoot
                    ? this.t('Profiles for project: {0}', vscode.workspace.workspaceFolders?.[0]?.name || path.basename(this.projectRoot))
                    : this.t('Profiles for this empty window')),
                buildSectionTitle: this.t('SPPR build parameters'),
                resizePanels: this.t('Resize panels'),
                buildSectionDescription: this.t('Parameters saved into yaml_parameters.json for СборкаТекстовСценариев processing.'),
                buildModelDbWarning: this.t('ModelDBSettings is empty. SPPR can still build with AuthCompile=False, but it will not resolve TestClient logins/passwords by profile automatically.'),
                buildModelDbWarningStrict: this.t('ModelDBSettings is empty. SPPR cannot validate or resolve TestClient credentials while AuthCompile=True, so Apply/export is blocked until you fill it.'),
                buildParameterCatalogTitle: this.t('SPPR parameter catalog'),
                buildParameterCatalogDescription: this.t('Select a supported SPPR parameter and add it as a separate row. Fixed rows stay at the top.'),
                buildParameterSelectLabel: this.t('Supported parameter'),
                addCustomBuildParameter: this.t('Add custom parameter'),
                fixedBuildParameterHint: this.t('This parameter is fixed and cannot be removed.'),
                resetBuildParameterValue: this.t('Reset value to default'),
                noMatchingBuildParameters: this.t('No parameters found'),
                genericBuildParameterDescription: this.t('Additional SPPR parameter passed to СборкаТекстовСценариев.'),
                customBuildParameterDescription: this.t('User parameter added manually and passed to SPPR processing.'),
                additionalSectionTitle: this.t('Additional Vanessa Automation parameters'),
                additionalSectionDescription: this.t('Vanessa Automation settings, using the same keys as VAParams.json: generator language, libraries, reports, and more. KOT adds them to the launch JSON. Import settings exported from Vanessa here.'),
                globalVarsSectionTitle: this.t('Global variables'),
                globalVarsSectionDescription: this.t('Initial global variable values ($$Name$$) passed through GlobalVars in the launch JSON. View and edit current values in Vanessa variables.'),
                pathHint: this.t('You can use relative paths from project root or full paths.'),
                sectionsHint: this.t('• SPPR tab: parameters for СборкаТекстовСценариев. Processing uses them to build yaml_parameters.json and Vanessa settings JSON, but not all VAParams keys are supported.\n• Additional tab: Vanessa Automation settings, using the same keys as VAParams.json. Import settings exported from Vanessa here; KOT merges them into the launch JSON.\n• Global variables tab: initial global variable values ($$Name$$), added to GlobalVars in the launch JSON. Current values are in Vanessa variables.\n• VAParams: runtime JSON settings for Vanessa Automation scenario launch.\n• Priority: if the same key exists in SPPR and Additional tabs, SPPR value wins by default. To override it, enable \"Override existing value\" in Additional tab.'),
                addBuildParameter: this.t('Add build parameter'),
                addAdditionalParameter: this.t('Add additional parameter'),
                addGlobalVariable: this.t('Add global variable'),
                resetDefaults: this.t('Reset build defaults'),
                openGeneratedYamlParameters: this.t('Preview SPPR JSON'),
                clearAdditionalParameters: this.t('Clear additional parameters'),
                clearGlobalVariables: this.t('Clear global variables'),
                profile: this.t('Profile'),
                selectProfile: this.t('Select profile'),
                addProfile: this.t('New profile'),
                duplicateProfile: this.t('Duplicate profile'),
                duplicateProfileTitle: this.t('Duplicate profile'),
                duplicateProfileDefaultName: this.t('{0} copy'),
                renameProfile: this.t('Rename profile'),
                deleteProfile: this.t('Delete profile'),
                profileActionsLabel: this.t('Profile actions'),
                profileNamePrompt: this.t('Profile name'),
                createProfileTitle: this.t('Create profile'),
                renameProfileTitle: this.t('Rename profile'),
                deleteProfileConfirmation: this.t('Delete profile "{0}"?'),
                deleteProfileBlocked: this.t('At least one profile must remain.'),
                updatedAt: this.t('Updated at'),
                neverSaved: this.t('n/a'),
                cancel: this.t('Cancel'),
                ok: this.t('OK'),
                autosaveEnabled: this.t('Auto-save'),
                saving: this.t('Saving...'),
                saved: this.t('Saved'),
                savedWithIssues: this.t('Saved with issues'),
                autosaveError: this.t('Auto-save error'),
                parameter: this.t('Parameter'),
                variable: this.t('Variable'),
                value: this.t('Value'),
                priority: this.t('Priority'),
                priorityDescription: this.t('When enabled, this value replaces an existing value in the generated Vanessa JSON. Otherwise, it is added only when the key is absent.'),
                overrideExistingValue: this.t('Override existing value'),
                actions: this.t('Actions'),
                createFile: this.t('Save file'),
                saveAdditionalFile: this.t('Save additional file'),
                loadFromJson: this.t('Load from JSON'),
                loadAdditionalFromJson: this.t('Import VAParams/JSON'),
                saveGlobalVarsFile: this.t('Save global variables file'),
                loadGlobalVarsFromJson: this.t('Import GlobalVars/JSON'),
                moreActions: this.t('More actions'),
                help: this.t('Help'),
                moreInfoOnITS: this.t('More information about SPPR СборкаТекстовСценариев parameters on ITS'),
                moreInfoOnVanessa: this.t('More information about Vanessa Automation JSON parameters'),
                parameterNamePlaceholder: this.t('Parameter name'),
                parameterValuePlaceholder: this.t('Parameter value'),
                removeParameter: this.t('Remove parameter'),
                variableNamePlaceholder: this.t('Variable name'),
                variableValuePlaceholder: this.t('Variable value'),
                removeVariable: this.t('Remove variable'),
                buildMoreActionsLabel: this.t('Build actions'),
                additionalMoreActionsLabel: this.t('Additional actions'),
                globalVarsMoreActionsLabel: this.t('GlobalVars actions'),
                searchByParameterName: this.t('Search by parameter name'),
                customVanessaParameterDescription: this.t('Custom parameter passed to Vanessa Automation.'),
                expectedBoolean: this.t('Choose true or false.'), expectedNumber: this.t('Enter a finite number.'),
                expectedArray: this.t('Enter a JSON array.'), expectedObject: this.t('Enter a JSON object.'),
                expectedString: this.t('Enter a string.'),
                unsupportedVanessaParameter: this.t('This parameter is absent from the selected Vanessa sources. Check version compatibility.'),
                clearSearch: this.t('Clear search')
            };

            // Загружаем HTML шаблон
            const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'yamlParameters.html');
            let htmlContent = Buffer.from(await vscode.workspace.fs.readFile(htmlPath)).toString('utf-8');

            const buildParametersRows = this.renderParametersRows(buildParameters, loc.parameterNamePlaceholder, loc.parameterValuePlaceholder, loc.removeParameter);
            const additionalParametersRows = this.renderAdditionalParametersRows(
                additionalVanessaParameters,
                loc.parameterNamePlaceholder,
                loc.parameterValuePlaceholder,
                loc.removeParameter,
                loc.priorityDescription,
                true
            );
            const globalVariablesRows = this.renderAdditionalParametersRows(
                globalVanessaVariables,
                loc.variableNamePlaceholder,
                loc.variableValuePlaceholder,
                loc.removeVariable,
                loc.priorityDescription
            );

            // Заменяем технические плейсхолдеры как в PhaseSwitcher
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            htmlContent = htmlContent.replace('${stylesUri}', stylesUri.toString());
            htmlContent = htmlContent.replace(
                /<script\b[^>]*src="\$\{scriptUri\}"[^>]*><\/script>/,
                `<script nonce="${nonce}" src="${textScriptUri}"></script>\n    <script nonce="${nonce}" src="${splitScriptUri}"></script>\n    <script nonce="${nonce}" src="${buildParameterStateScriptUri}"></script>\n    <script nonce="${nonce}" src="${scriptUri}"></script>`
            );
            htmlContent = htmlContent.replace('${codiconsUri}', codiconsUri.toString());
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webview.cspSource);
            htmlContent = htmlContent.replace('${buildParametersRows}', () => buildParametersRows);
            htmlContent = htmlContent.replace('${additionalParametersRows}', () => additionalParametersRows);
            htmlContent = htmlContent.replace('${globalVariablesRows}', () => globalVariablesRows);
            htmlContent = htmlContent.replace(
                '${buildParameterSuggestionOptions}',
                this.getKnownBuildParameterKeys()
                    .map(key => `<option value="${this.escapeHtml(key)}"></option>`)
                    .join('')
            );
            const scriptData: Record<string, unknown> = {
                buildParameterDefinitionsJson: this.getBuildParameterDefinitions(),
                vanessaParameterDefinitionsJson: vanessaParameterDefinitions,
                vanessaCatalogStatusJson: this.vanessaCatalogStatus(vanessaCatalog),
                fixedBuildParameterKeysJson: this.getFixedBuildParameterKeys(),
                buildParametersJson: buildParameters, additionalParametersJson: additionalVanessaParameters,
                globalVanessaVariablesJson: globalVanessaVariables, defaultBuildParametersJson: this.getDefaultParameters(),
                profilesJson: profiles, activeProfileIdJson: activeProfileId
            };
            for (const [key, value] of Object.entries(scriptData)) {
                htmlContent = htmlContent.replace(`\${${key}}`, () => JSON.stringify(value).replace(/</g, '\\u003c'));
            }

            // Заменяем переводы
            htmlContent = htmlContent.replace('${localeHtmlLang}', localeHtmlLang);
            for (const [k, v] of Object.entries(loc)) {
                htmlContent = htmlContent.replace(new RegExp(`\\$\\{loc\\.${k}\\}`, 'g'), () => v);
            }

            return htmlContent;
        } catch (error) {
            console.error('[YamlParametersManager] Error loading HTML template:', error);
            return `<body><h1>${this.escapeHtml(this.t('Compilation and run parameters'))}</h1><p>${this.escapeHtml(this.t('Error opening Compilation and run parameters: {0}', String(error)))}</p></body>`;
        }
    }

    private renderParametersRows(parameters: YamlParameter[], keyPlaceholder: string, valuePlaceholder: string, removeTitle: string): string {
        return parameters.map((param, index) => `
                <tr data-index="${index}">
                    <td>
                        <input type="text" class="param-key" list="buildParameterSuggestions" value="${this.escapeHtml(param.key)}" placeholder="${this.escapeHtml(keyPlaceholder)}">
                    </td>
                    <td>
                        <input type="text" class="param-value" value="${this.escapeHtml(param.value)}" placeholder="${this.escapeHtml(valuePlaceholder)}">
                    </td>
                    <td>
                        <button class="button-with-icon remove-row-btn" title="${this.escapeHtml(removeTitle)}">
                            <span class="codicon codicon-trash"></span>
                        </button>
                    </td>
                </tr>
            `).join('');
    }

    private renderAdditionalParametersRows(
        parameters: AdditionalVanessaParameter[],
        keyPlaceholder: string,
        valuePlaceholder: string,
        removeTitle: string,
        overrideTitle: string,
        lockNames = false
    ): string {
        return parameters.map((param, index) => `
                <tr data-index="${index}">
                    <td>
                        <input type="text" class="param-key" ${lockNames ? 'readonly' : ''} value="${this.escapeHtml(param.key)}" placeholder="${this.escapeHtml(keyPlaceholder)}">
                    </td>
                    <td>
                        <input type="text" class="param-value" value="${this.escapeHtml(param.value)}" placeholder="${this.escapeHtml(valuePlaceholder)}">
                    </td>
                    <td class="param-priority-cell">
                        <input type="checkbox" class="param-override" ${param.overrideExisting ? 'checked' : ''} title="${this.escapeHtml(overrideTitle)}">
                    </td>
                    <td>
                        <button class="button-with-icon remove-row-btn" title="${this.escapeHtml(removeTitle)}">
                            <span class="codicon codicon-trash"></span>
                        </button>
                    </td>
                </tr>
            `).join('');
    }

    /**
     * Генерирует nonce для CSP
     */
    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * Экранирует HTML символы
     */
    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
