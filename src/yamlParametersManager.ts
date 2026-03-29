import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getExtensionUri } from './appContext';
import { updateScenarioScanRoot } from './scenarioScanRoot';
import { getDefaultModelDbSettingsValue } from './etalonBases';

// Ключ для хранения параметров в SecretStorage
const YAML_PARAMETERS_KEY = 'kotTestToolkit.yamlParameters';

export interface YamlParameter {
    key: string;
    value: string;
}

export interface AdditionalVanessaParameter {
    key: string;
    value: string;
    overrideExisting: boolean;
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

interface BuildParameterDefinition {
    key: string;
    description: string;
    fixed?: boolean;
    valueKind?: 'boolean';
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

interface YamlParametersStorageV4 {
    version: 4;
    activeProfileId: string;
    profiles: YamlParametersProfile[];
}

interface ProfileQuickPickItem extends vscode.QuickPickItem {
    action: 'select' | 'create' | 'duplicate' | 'rename' | 'delete';
    profileId?: string;
}

const LAUNCH_INFOBASE_PARAMETER_ALIASES = [
    'LaunchDBFolder',
    'TestClientDBPath',
    'InfobasePath',
    'TestClientDB'
] as const;
const DEFAULT_YAML_PARAMETERS_PROFILE_ID = 'default';
const DEFAULT_YAML_PARAMETERS_PROFILE_NAME = 'Default';

export class YamlParametersManager {
    private static instance: YamlParametersManager;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    private _langOverride: 'System' | 'English' | 'Русский' = 'System';
    private _ruBundle: Record<string, string> | null = null;

    private constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._extensionUri = getExtensionUri();
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
     * Получает параметры по умолчанию из примера
     */
    public getDefaultParameters(): YamlParameter[] {
        // Получаем BuildPath из настроек
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const buildPath = config.get<string>('runtime.directory') || '.vscode/kot-runtime';
        return [
            { key: 'ScenarioFolder', value: 'tests/' },
            { key: 'FeatureFolder', value: path.join(buildPath, 'tests') },
            { key: 'VanessaFolder', value: this.getDefaultVanessaFolderValue() },
            { key: 'ModelDBSettings', value: getDefaultModelDbSettingsValue() },
            { key: 'AuthCompile', value: 'False' },
            { key: 'LaunchDBFolder', value: path.join(buildPath, 'launch-infobase') }
        ];
    }

    private normalizeVanessaFolderValue(rawValue: string): string {
        const trimmedValue = String(rawValue ?? '').trim();
        if (!trimmedValue) {
            return '';
        }

        const withoutTrailingSeparators = trimmedValue.replace(/[\\/]+$/, '');
        if (!withoutTrailingSeparators) {
            return trimmedValue;
        }

        const basename = path.basename(withoutTrailingSeparators);
        if (/\.epf$/i.test(basename)) {
            return path.dirname(withoutTrailingSeparators);
        }

        return withoutTrailingSeparators;
    }

    private getDefaultVanessaFolderValue(): string {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const configuredVanessaEpfPath = (config.get<string>('runVanessa.vanessaEpfPath') || '').trim();
        return this.normalizeVanessaFolderValue(configuredVanessaEpfPath);
    }

    private normalizeBuildParameterKey(key: string): string {
        return String(key).trim().toLowerCase().replace(/[_\-\s]/g, '');
    }

    private createDefaultProfile(
        id: string = DEFAULT_YAML_PARAMETERS_PROFILE_ID,
        name: string = DEFAULT_YAML_PARAMETERS_PROFILE_NAME
    ): YamlParametersProfile {
        return {
            id,
            name,
            buildParameters: this.normalizeBuildParametersForUi(this.getDefaultParameters()),
            additionalVanessaParameters: [],
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

    private normalizeProfile(raw: unknown, fallbackIndex: number): YamlParametersProfile | null {
        if (!raw || typeof raw !== 'object') {
            return null;
        }

        const source = raw as Partial<YamlParametersProfile>;
        const buildParameters = this.normalizeParameters(source.buildParameters);
        return {
            id: this.normalizeProfileId(source.id, fallbackIndex),
            name: this.normalizeProfileName(source.name, fallbackIndex),
            buildParameters: this.normalizeBuildParametersForUi(
                buildParameters.length > 0 ? buildParameters : this.getDefaultParameters()
            ),
            additionalVanessaParameters: this.normalizeAdditionalVanessaParameters(source.additionalVanessaParameters),
            globalVanessaVariables: this.normalizeGlobalVanessaVariables(source.globalVanessaVariables)
        };
    }

    private normalizeProfiles(
        rawProfiles: unknown,
        fallbackProfile?: YamlParametersProfile
    ): YamlParametersProfile[] {
        const normalizedProfiles = Array.isArray(rawProfiles)
            ? rawProfiles
                .map((item, index) => this.normalizeProfile(item, index))
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
        const launchInfobaseDescription = t('Target infobase used for Vanessa launch. Use either a file infobase folder like `C:\\Bases\\Demo` or a full connection string such as `File="C:\\Bases\\Demo";` / `Srvr="server";Ref="base";`. KOT may temporarily replace this path at launch when you choose another infobase.');
        const definitions: BuildParameterDefinition[] = [
            { key: 'ScenarioFolder', description: t('Root folder with YAML scenarios used by SPPR build. KOT also synchronizes this value with the YAML scan root.'), fixed: true },
            { key: 'FeatureFolder', description: t('Output folder where SPPR writes built feature/json artifacts.'), fixed: true },
            { key: 'VanessaFolder', description: t('Path to the Vanessa Automation directory. By default, KOT derives it from Run Vanessa: Vanessa Epf Path.'), fixed: true },
            { key: 'ModelDBSettings', description: t('Path to the model DB settings YAML with etalon database definitions and user credentials. Needed for automatic TestClient profile resolution; required when AuthCompile=true.'), fixed: true },
            { key: 'AuthCompile', description: t('Enables strict validation that SPPR can resolve TestClient authorization data from ModelDBSettings. It does not provide credentials by itself.'), fixed: true },
            { key: 'LaunchDBFolder', description: launchInfobaseDescription, fixed: true },
            { key: 'TestClientDBPath', description: launchInfobaseDescription, fixed: true },
            { key: 'InfobasePath', description: launchInfobaseDescription, fixed: true },
            { key: 'TestClientDB', description: launchInfobaseDescription, fixed: true },
            { key: 'ProcessFolder', description: t('Separate root folder for process YAML files if they are stored outside ScenarioFolder.') },
            { key: 'ModelDBid', description: t('Identifier of the model database used to filter or route build artifacts.') },
            { key: 'CompileFile', description: t('Custom path to compile.txt written by the SPPR processing.') },
            { key: 'CreateJson', description: t('Controls whether SPPR creates per-test JSON launch files.') },
            { key: 'CreateJUnit', description: t('Controls whether SPPR creates a JUnit report.') },
            { key: 'JUnitPath', description: t('Folder where the JUnit report will be written.') },
            { key: 'JUnitFile', description: t('Explicit file path for the JUnit report.') },
            { key: 'LogFile', description: t('Path to the SPPR processing log file.') },
            { key: 'ResultFile', description: t('Path to the SPPR processing result code file.') },
            { key: 'ErrorFolder', description: t('Folder where SPPR writes detailed build errors.') },
            { key: 'ScenarioLogFile', description: t('Path to Vanessa progress log for scenario execution.') },
            { key: 'ScenarioOutFile', description: t('Path to Vanessa status/result file for scenario execution.') },
            { key: 'BDDLogFolder', description: t('Folder for Vanessa Automation error logs.') },
            { key: 'ScreenshotsFolder', description: t('Folder where screenshots are stored.') },
            { key: 'VanessaDir', description: t('Alternative key for the Vanessa Automation directory.') },
            { key: 'VanessaPath', description: t('Alternative key for the Vanessa Automation directory or EPF path.') },
            { key: 'Libraries', description: t('Path to Vanessa feature libraries used during launch.') },
            { key: 'VanessaLibraries', description: t('Alternative key for Vanessa feature libraries path.') },
            { key: 'JUnitFolder', description: t('Folder used for JUnit output or related build reports.') },
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
            { key: 'TestClientPort', description: t('Port used to launch the test client.') },
            { key: 'DebugMode', description: t('Enables SPPR debug mode.') },
            { key: 'PauseOnWindowsOpening', description: t('Pause in seconds when opening windows during automation.') },
            { key: 'AllureReport', description: t('Enables Allure report generation.') },
            { key: 'SafeStepsExecution', description: t('Enables safe execution mode for Vanessa steps.') },
            { key: 'JUnitReport', description: t('Enables JUnit report generation.') },
            { key: 'CucumberReport', description: t('Enables Cucumber report generation.') },
            { key: 'SpprReport', description: t('Enables SPPR-format report generation.') },
            { key: 'ExtraParams', description: t('Additional startup parameters passed to the test client.') },
            { key: 'WaitWindowTime', description: t('Timeout for waiting for windows during automation.') },
            { key: 'NumberOfAttempts', description: t('Number of retry attempts for actions.') },
            { key: 'TimeoutForAsyncSteps', description: t('Timeout for asynchronous steps.') },
            { key: 'TimeoutTestClientStart', description: t('Timeout for starting the 1C test client.') },
            { key: 'ErrorAddInfo', description: t('Additional error text appended to build errors.') },
            { key: 'AddImportantInfo', description: t('Additional reproduction information inserted into build errors.') },
            { key: 'DetectionTime', description: t('Custom detection time for SPPR error output.') },
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
            { key: 'ThreadsCount', description: t('Number of build threads used by SPPR.') },
            { key: 'ThreadNumber', description: t('Zero-based or one-based current thread number depending on pipeline usage.') },
            { key: 'ThreadTotal', description: t('Alternative key for total number of build threads.') },
            { key: 'ThreadIndex', description: t('Alternative key for the current build thread index.') },
            { key: 'ExternalMode', description: t('Enables external mode for the SPPR processing.') },
            { key: 'CreateModellingXml', description: t('Enables creation of SPPR modelling XML error output.') },
            { key: 'FilterTags', description: t('Include only tests/scenarios matching the specified tags.') },
            { key: 'ExceptionTags', description: t('Exclude tests/scenarios matching the specified tags.') },
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
            'CreateJson', 'FilterTags', 'ExceptionTags', 'TestFolder', 'ScenarioFolder', 'ProcessFolder',
            'FeatureFolder', 'ModelDBid', 'ModelDBSettings', 'AuthCompile', 'LaunchDBFolder',
            'VanessaDir', 'VanessaFolder', 'VanessaPath', 'AllurePath', 'AllureFolder', 'JUnitFolder',
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

        const booleanKeys = new Set([
            'authcompile',
            'createjson',
            'createjunit',
            'capturescreen',
            'usescreenshotcomponent',
            'useexternalcomponent',
            'pidinformation',
            'debugmode',
            'allurereport',
            'safestepsexecution',
            'junitreport',
            'cucumberreport',
            'spprreport',
            'externalmode',
            'createmodellingxml',
            'severalscenariosinonefile',
            'scenariofilterhaspriority',
            'splitfeaturefiles'
        ]);

        definitions.forEach(definition => {
            if (booleanKeys.has(this.normalizeBuildParameterKey(definition.key))) {
                definition.valueKind = 'boolean';
            }
        });

        return definitions;
    }

    private normalizeBuildParametersForUi(parameters: YamlParameter[]): YamlParameter[] {
        const scenarioFolderValue = this.getBuildParameterValue(parameters, 'ScenarioFolder', 'TestFolder');
        const featureFolderValue = this.getBuildParameterValue(parameters, 'FeatureFolder');
        const hasExplicitVanessaFolder = this.hasBuildParameterKey(parameters, 'VanessaFolder', 'VanessaDir', 'VanessaPath');
        const vanessaFolderValue = hasExplicitVanessaFolder
            ? this.normalizeVanessaFolderValue(this.getBuildParameterValue(parameters, 'VanessaFolder', 'VanessaDir', 'VanessaPath'))
            : this.getDefaultVanessaFolderValue();
        const authCompileValue = this.getBuildParameterValue(parameters, 'AuthCompile') || 'False';
        const modelDbSettingsValue = this.getBuildParameterValue(parameters, 'ModelDBSettings') || getDefaultModelDbSettingsValue();
        const launchInfobaseParameter = this.findBuildParameter(parameters, ...LAUNCH_INFOBASE_PARAMETER_ALIASES);
        const launchInfobaseKey = launchInfobaseParameter?.key?.trim() || 'LaunchDBFolder';
        const launchInfobaseValue = String(launchInfobaseParameter?.value || '');
        const showDriveSpecificParameters = this.shouldShowDriveSpecificBuildParameters();
        const fixedNormalizedKeys = new Set([
            'scenariofolder',
            'testfolder',
            'featurefolder',
            'vanessafolder',
            'vanessadir',
            'vanessapath',
            'authcompile',
            'modeldbsettings',
            ...LAUNCH_INFOBASE_PARAMETER_ALIASES.map(alias => this.normalizeBuildParameterKey(alias))
        ]);
        const result: YamlParameter[] = [
            { key: 'ScenarioFolder', value: scenarioFolderValue },
            { key: 'FeatureFolder', value: featureFolderValue },
            { key: 'VanessaFolder', value: vanessaFolderValue },
            { key: 'ModelDBSettings', value: modelDbSettingsValue },
            { key: 'AuthCompile', value: authCompileValue },
            { key: launchInfobaseKey, value: launchInfobaseValue }
        ];

        for (const parameter of parameters) {
            const normalizedKey = this.normalizeBuildParameterKey(parameter.key);
            if (fixedNormalizedKeys.has(normalizedKey)) {
                continue;
            }
            if (normalizedKey === 'uc') {
                continue;
            }
            if (!showDriveSpecificParameters && normalizedKey === 'splitfeaturefiles') {
                continue;
            }
            result.push(parameter);
        }

        return result;
    }

    private getBuildParameterValue(parameters: YamlParameter[], ...aliases: string[]): string {
        const normalizedAliases = aliases.map(alias => this.normalizeBuildParameterKey(alias));
        for (const parameter of parameters) {
            const normalizedKey = this.normalizeBuildParameterKey(parameter.key);
            if (!normalizedAliases.includes(normalizedKey)) {
                continue;
            }
            const value = String(parameter.value ?? '').trim();
            if (value) {
                return value;
            }
        }
        return '';
    }

    private findBuildParameter(parameters: YamlParameter[], ...aliases: string[]): YamlParameter | null {
        const normalizedAliases = new Set(aliases.map(alias => this.normalizeBuildParameterKey(alias)));
        let firstMatch: YamlParameter | null = null;
        for (const parameter of parameters) {
            if (!normalizedAliases.has(this.normalizeBuildParameterKey(parameter.key))) {
                continue;
            }

            if (!firstMatch) {
                firstMatch = parameter;
            }

            if (String(parameter.value ?? '').trim()) {
                return parameter;
            }
        }
        return firstMatch;
    }

    private hasBuildParameterKey(parameters: YamlParameter[], ...aliases: string[]): boolean {
        const normalizedAliases = new Set(aliases.map(alias => this.normalizeBuildParameterKey(alias)));
        return parameters.some(parameter => normalizedAliases.has(this.normalizeBuildParameterKey(parameter.key)));
    }

    private isTruthyBuildParameterValue(value: string): boolean {
        const normalized = String(value ?? '').trim().toLowerCase();
        return normalized === 'true' || normalized === 'истина';
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

    private validateBuildParameters(parameters: YamlParameter[]): string[] {
        const errors: string[] = [];
        const scenarioFolder = this.getBuildParameterValue(parameters, 'ScenarioFolder', 'TestFolder');
        const featureFolder = this.getBuildParameterValue(parameters, 'FeatureFolder');
        const vanessaFolder = this.normalizeVanessaFolderValue(
            this.getBuildParameterValue(parameters, 'VanessaFolder', 'VanessaDir', 'VanessaPath')
        );
        const authCompile = this.isTruthyBuildParameterValue(this.getBuildParameterValue(parameters, 'AuthCompile'));
        const modelDbSettings = this.getBuildParameterValue(parameters, 'ModelDBSettings');
        const launchInfobasePath = this.getBuildParameterValue(parameters, ...LAUNCH_INFOBASE_PARAMETER_ALIASES);

        if (!scenarioFolder) {
            errors.push(this.t('ScenarioFolder or TestFolder is required for SPPR build.'));
        }

        if (!featureFolder) {
            errors.push(this.t('FeatureFolder is required for SPPR build.'));
        }

        if (!vanessaFolder) {
            errors.push(this.t('VanessaFolder is required for SPPR build.'));
        }

        if (authCompile && !modelDbSettings) {
            errors.push(this.t('ModelDBSettings is required when AuthCompile=true.'));
        }

        if (!launchInfobasePath) {
            errors.push(this.t('LaunchDBFolder, TestClientDBPath, InfobasePath or TestClientDB is required for Vanessa launch.'));
        }

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
        const scenarioFolder = this.getBuildParameterValue(parameters, 'ScenarioFolder', 'TestFolder');
        if (!scenarioFolder) {
            return false;
        }

        return updateScenarioScanRoot(this._context, scenarioFolder);
    }

    /**
     * Нормализует список параметров
     */
    private normalizeParameters(raw: unknown): YamlParameter[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const result: YamlParameter[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const key = String((item as { key?: unknown }).key || '').trim();
            const value = String((item as { value?: unknown }).value || '');
            if (!key) {
                continue;
            }
            result.push({ key, value });
        }

        return result;
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
        if (value === undefined || value === null) {
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

    private flattenAdditionalParametersFromJson(
        value: unknown,
        currentPath: string,
        result: AdditionalVanessaParameter[]
    ): void {
        if (Array.isArray(value)) {
            if (value.length === 0) {
                if (currentPath) {
                    result.push({
                        key: currentPath,
                        value: '[]',
                        overrideExisting: false
                    });
                }
                return;
            }

            value.forEach((item, index) => {
                const nextPath = currentPath ? `${currentPath}[${index}]` : `[${index}]`;
                this.flattenAdditionalParametersFromJson(item, nextPath, result);
            });
            return;
        }

        if (value && typeof value === 'object') {
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length === 0) {
                if (currentPath) {
                    result.push({
                        key: currentPath,
                        value: '{}',
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
                const nextPath = currentPath ? `${currentPath}.${key}` : key;
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
        try {
            const saved = await this._context.secrets.get(YAML_PARAMETERS_KEY);
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
                            legacyBuild.length > 0 ? legacyBuild : this.getDefaultParameters()
                        )
                    }]
                };
            }

            if (parsed && typeof parsed === 'object') {
                const payload = parsed as Partial<YamlParametersStorageV4> & {
                    buildParameters?: unknown;
                    additionalVanessaParameters?: unknown;
                    globalVanessaVariables?: unknown;
                };

                if (Array.isArray(payload.profiles)) {
                    const profiles = this.normalizeProfiles(payload.profiles);
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
                            buildParameters.length > 0 ? buildParameters : this.getDefaultParameters()
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
        const normalizedProfiles = this.normalizeProfiles(state.profiles);
        const activeProfileId = normalizedProfiles.some(profile => profile.id === state.activeProfileId)
            ? state.activeProfileId
            : normalizedProfiles[0].id;
        const payload: YamlParametersStorageV4 = {
            version: 4,
            activeProfileId,
            profiles: normalizedProfiles
        };
        await this._context.secrets.store(YAML_PARAMETERS_KEY, JSON.stringify(payload));
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

            // Создаем объект из параметров
            const yamlParams: Record<string, string> = {};
            parameters.forEach(param => {
                let value = param.value;

                // Проверяем, является ли значение путем
                if (this.isPath(param.value)) {
                    // Это путь - обрабатываем соответственно
                    if (this.isAbsolutePath(param.value)) {
                        // Это абсолютный путь, оставляем как есть
                        value = param.value;
                    } else if (param.value.startsWith('./') || param.value.startsWith('../')) {
                        // Это относительный путь от текущей директории, оставляем как есть
                        value = param.value;
                    } else if (param.value.startsWith('~/')) {
                        // Это путь от домашней директории, оставляем как есть
                        value = param.value;
                    } else {
                        // Это относительный путь к корню проекта, преобразуем в абсолютный
                        value = path.resolve(workspaceRoot, param.value);
                    }
                } else {
                    // Это не путь (например, TRUE, FALSE, GodMode), оставляем как есть
                    value = param.value;
                }

                yamlParams[param.key] = value;
            });

            // Создаем директорию если не существует
            const targetDir = path.dirname(targetPath);
            await fs.promises.mkdir(targetDir, { recursive: true });

            // Записываем файл с правильным форматированием путей
            const jsonContent = this.formatYamlParametersJson(yamlParams);
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
     * Форматирует JSON для yaml_parameters.json с правильными слешами
     */
    private formatYamlParametersJson(yamlParams: Record<string, string>): string {
        // Используем стандартный JSON.stringify, но заменяем двойные слеши на одинарные
        let jsonContent = JSON.stringify(yamlParams, null, 2);

        // Заменяем двойные обратные слеши на прямые слеши (только в путях, не в кавычках)
        jsonContent = jsonContent.replace(/\\\\/g, '/');

        return jsonContent;
    }

    /**
     * Проверяет, является ли строка путем к файлу/папке
     */
    private isPath(value: string): boolean {
        // Пустая строка или очень короткая строка - не путь
        if (!value || value.length < 2) {
            return false;
        }

        // Содержит расширение файла - скорее всего путь
        if (/\.[a-zA-Z0-9]{1,10}$/.test(value)) {
            return true;
        }

        // Содержит слэши или обратные слэши - скорее всего путь
        if (value.includes('/') || value.includes('\\')) {
            return true;
        }

        // Начинается с ~ (домашняя директория) - путь
        if (value.startsWith('~')) {
            return true;
        }

        // Простые строки без слэшей и расширений - не пути
        // Например: TRUE, FALSE, GodMode, EtalonDrive
        if (/^[a-zA-Z0-9_-]+$/.test(value)) {
            return false;
        }

        // Строки с параметрами (содержат = и ;) - не пути
        // Например: Srvr="#ServerName";Ref="#InfobaseName"
        if (value.includes('=') && value.includes(';')) {
            return false;
        }

        // Строки с кавычками и параметрами - не пути
        // Например: "Srvr=\"#ServerName\";Ref=\"#InfobaseName\""
        if (value.includes('"') && (value.includes('=') || value.includes(';'))) {
            return false;
        }

        // Содержит двоеточие (но не в начале) - скорее всего путь
        if (value.includes(':') && !value.startsWith(':')) {
            return true;
        }

        // Содержит # (но не в кавычках и не как часть параметра) - может быть путь
        if (value.includes('#')) {
            // Если это просто # без других признаков пути - не путь
            if (value === '#' || value.startsWith('#') && !value.includes('/') && !value.includes('\\')) {
                return false;
            }
            // Если содержит # и слэши - путь
            if (value.includes('/') || value.includes('\\')) {
                return true;
            }
            // По умолчанию для строк с # считаем, что это не путь
            return false;
        }

        // По умолчанию считаем, что это не путь
        return false;
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
            'Build Scenario Parameters Manager',
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

        // Обработка сообщений от webview
        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
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
                                    ? this.t('Saved, but required fields are still missing: {0}', result.validationErrors.join(' '))
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
                                    ? this.t('Saved, but required fields are still missing: {0}', result.validationErrors.join(' '))
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
                                title: this.t('Save Build Scenario Parameters File'),
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
                                kind: 'error',
                                message: this.t('Auto-save failed: {0}', String(error))
                            });
                        }
                        break;
                    case 'loadBuildFromJson':
                        try {
                            const uris = await vscode.window.showOpenDialog({
                                title: this.t('Load Build Scenario Parameters from JSON'),
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
                                const buildParameters: YamlParameter[] = Object.entries(jsonData).map(([key, value]) => ({
                                    key: String(key),
                                    value: String(value)
                                }));

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
                                    this.t('Loaded {0} parameters from {1}', globalVariables.length.toString(), path.basename(filePath))
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
        savedAt: string
    ): Promise<boolean> {
        const activeProfile = this.getActiveProfileFromState(state);
        const validationErrors = this.validateBuildParameters(activeProfile.buildParameters);
        const scanRootChanged = await this.syncYamlSourceDirectorySettingFromBuildParameters(activeProfile.buildParameters);
        await vscode.commands.executeCommand('kotTestToolkit.refreshCombinedRunJsonArtifacts');

        await panel.webview.postMessage({
            command: 'profilesStateUpdated',
            activeProfileId: state.activeProfileId,
            profiles: state.profiles,
            savedAt,
            kind: validationErrors.length > 0 ? 'warning' : 'saved',
            message: validationErrors.length > 0
                ? this.t('Saved, but required fields are still missing: {0}', validationErrors.join(' '))
                : scanRootChanged
                    ? this.t('Saved. YAML scan root synchronized from ScenarioFolder.')
                    : this.t('Saved')
        });

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
        await this.saveParametersState(state);
        const initialSavedAt = new Date().toISOString();
        await this.postProfilesStateUpdated(panel, state, initialSavedAt);

        const activeProfile = this.getActiveProfileFromState(state);
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

        const selection = await vscode.window.showQuickPick(items, {
            title: this.t('Manage profiles'),
            placeHolder: this.t('Select active profile or manage profiles'),
            ignoreFocusOut: true
        });

        if (!selection) {
            return;
        }

        switch (selection.action) {
            case 'select': {
                if (!selection.profileId || selection.profileId === state.activeProfileId) {
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
                    return;
                }
                const confirmation = await vscode.window.showWarningMessage(
                    this.t('Delete profile "{0}"?', activeProfile.name),
                    { modal: true },
                    this.t('Delete profile')
                );
                if (confirmation !== this.t('Delete profile')) {
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

        await this.saveParametersState(state);
        const scanRootChanged = await this.postProfilesStateUpdated(panel, state, new Date().toISOString());
        if (!scanRootChanged) {
            await this.notifyPhaseSwitcherStateChanged();
        }
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

            // Nonce для CSP
            const nonce = this.getNonce();

            // Определяем язык интерфейса
            const langOverride = this._langOverride;
            const effectiveLang = langOverride === 'System' ? (vscode.env.language || 'English') : langOverride;
            const localeHtmlLang = effectiveLang.split('-')[0];

            // Создаем объект переводов
            const loc = {
                title: this.t('Build Scenario Parameters Manager'),
                buildSectionTitle: this.t('SPPR build parameters'),
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
                additionalSectionDescription: this.t('Use this section for VAParams keys not supported by SPPR processing (for example, gherkinlanguage).'),
                globalVarsSectionTitle: this.t('Global variables'),
                globalVarsSectionDescription: this.t('Scenario-level custom GlobalVars merged into VAParams JSON.'),
                pathHint: this.t('You can use relative paths from project root or full paths.'),
                sectionsHint: this.t('• SPPR tab: parameters for СборкаТекстовСценариев. Processing uses them to build yaml_parameters.json and Vanessa settings JSON, but not all VAParams keys are supported.\n• Additional tab: use for unsupported VAParams keys. You can import your own Vanessa settings JSON here.\n• Global variables tab: user GlobalVars that are merged into VAParams at launch time.\n• VAParams: runtime JSON settings for Vanessa Automation scenario launch.\n• Priority: if the same key exists in SPPR and Additional tabs, SPPR value wins by default. To override it, enable \"Override existing value\" in Additional tab.'),
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
                value: this.t('Value'),
                priority: this.t('Priority'),
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
                buildMoreActionsLabel: this.t('Build actions'),
                additionalMoreActionsLabel: this.t('Additional actions'),
                globalVarsMoreActionsLabel: this.t('GlobalVars actions'),
                searchByParameterName: this.t('Search by parameter name'),
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
                loc.overrideExistingValue
            );
            const globalVariablesRows = this.renderAdditionalParametersRows(
                globalVanessaVariables,
                loc.parameterNamePlaceholder,
                loc.parameterValuePlaceholder,
                loc.removeParameter,
                loc.overrideExistingValue
            );

            // Заменяем технические плейсхолдеры как в PhaseSwitcher
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            htmlContent = htmlContent.replace('${stylesUri}', stylesUri.toString());
            htmlContent = htmlContent.replace('${scriptUri}', scriptUri.toString());
            htmlContent = htmlContent.replace('${codiconsUri}', codiconsUri.toString());
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webview.cspSource);
            htmlContent = htmlContent.replace('${buildParametersRows}', buildParametersRows);
            htmlContent = htmlContent.replace('${additionalParametersRows}', additionalParametersRows);
            htmlContent = htmlContent.replace('${globalVariablesRows}', globalVariablesRows);
            htmlContent = htmlContent.replace(
                '${buildParameterSuggestionOptions}',
                this.getKnownBuildParameterKeys()
                    .map(key => `<option value="${this.escapeHtml(key)}"></option>`)
                    .join('')
            );
            htmlContent = htmlContent.replace('${buildParameterDefinitionsJson}', JSON.stringify(this.getBuildParameterDefinitions()));
            htmlContent = htmlContent.replace('${fixedBuildParameterKeysJson}', JSON.stringify(this.getFixedBuildParameterKeys()));
            htmlContent = htmlContent.replace('${buildParametersJson}', JSON.stringify(buildParameters));
            htmlContent = htmlContent.replace('${additionalParametersJson}', JSON.stringify(additionalVanessaParameters));
            htmlContent = htmlContent.replace('${globalVanessaVariablesJson}', JSON.stringify(globalVanessaVariables));
            htmlContent = htmlContent.replace('${defaultBuildParametersJson}', JSON.stringify(this.getDefaultParameters()));
            htmlContent = htmlContent.replace('${profilesJson}', JSON.stringify(profiles));
            htmlContent = htmlContent.replace('${activeProfileIdJson}', JSON.stringify(activeProfileId));

            // Заменяем переводы
            htmlContent = htmlContent.replace('${localeHtmlLang}', localeHtmlLang);
            for (const [k, v] of Object.entries(loc)) {
                htmlContent = htmlContent.replace(new RegExp(`\\$\\{loc\\.${k}\\}`, 'g'), v);
            }

            return htmlContent;
        } catch (error) {
            console.error('[YamlParametersManager] Error loading HTML template:', error);
            return `<body><h1>Error loading Build Scenario Parameters Manager</h1><p>${error}</p></body>`;
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
        overrideTitle: string
    ): string {
        return parameters.map((param, index) => `
                <tr data-index="${index}">
                    <td>
                        <input type="text" class="param-key" value="${this.escapeHtml(param.key)}" placeholder="${this.escapeHtml(keyPlaceholder)}">
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
