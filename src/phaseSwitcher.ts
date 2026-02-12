import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs'; 
import * as os from 'os';
import { scanWorkspaceForTests, getScanDirRelativePath } from './workspaceScanner';
import { TestInfo } from './types';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';
import { parsePhaseSwitcherMetadata } from './phaseSwitcherMetadata';
import { parseKotScenarioDescription } from './kotMetadataDescription';

// --- Вспомогательная функция для Nonce ---
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

interface CompletionMarker {
    filePath: string; 
    successContent?: string; 
    checkIntervalMs?: number; 
    timeoutMs?: number; 
}

interface Execute1CProcessOptions {
    completionMarker?: CompletionMarker;
    trackAsBuildProcess?: boolean;
}

class BuildCancelledError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BuildCancelledError';
    }
}

interface ScenarioBuildArtifact {
    scenarioName: string;
    sourceUri: vscode.Uri;
    featurePath?: string;
    jsonPath?: string;
    builtAt: number;
}

interface ScenarioRunState {
    featurePath?: string;
    jsonPath?: string;
    stale: boolean;
    runStatus: 'idle' | 'running' | 'passed' | 'failed';
    runMessage?: string;
    runUpdatedAt?: number;
    hasRunLog: boolean;
}

interface ScenarioExecutionState {
    status: 'running' | 'passed' | 'failed';
    updatedAt: number;
    message?: string;
    runLogPath?: string;
}

interface ScenarioLaunchContext {
    targetKind: 'feature' | 'json';
    targetPath: string;
    launchMode: 'builtIn' | 'template';
    updatedAt: number;
}

interface VanessaInfobaseCandidate {
    pointer: Array<string | number>;
    value: string;
    extractedPath: string;
    isConnectionString: boolean;
}

interface JsonStringPointerCandidate {
    pointer: Array<string | number>;
    key: string;
    value: string;
}

interface VanessaLaunchContext {
    startupInfobasePath: string;
    scenarioInfobasePath: string;
    vaParamsJsonPath: string;
    jsonWasPatched: boolean;
}

type VanessaInfobaseSource = 'jsonOrSettings' | 'lastCustom' | 'newCustom';

interface AdditionalLaunchVanessaParameter {
    key: string;
    value: string;
    overrideExisting: boolean;
}

interface VanessaLaunchOverlayParameters {
    additionalParameters: AdditionalLaunchVanessaParameter[];
    globalVariables: AdditionalLaunchVanessaParameter[];
}

const VANESSA_PARAM_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
    ['ВерсияVA', 'VersionVA'],
    ['КаталогФич', 'featurepath'],
    ['КаталогПроекта', 'projectpath'],
    ['КаталогиБиблиотек', 'librarycatalogs'],
    ['СписокТеговИсключение', 'ignoretags'],
    ['СписокТеговОтбор', 'filtertags'],
    ['СписокСценариевДляВыполнения', 'scenariofilter'],
    ['ЯзыкГенератораGherkin', 'gherkinlanguage'],
    ['ДобавлятьПриНакликиванииМетаИнформацию', 'addmetainformationclicking'],
    ['ИскатьЭлементыФормыПоИмени', 'searchformelementsbyname'],
    ['ПоказыватьОкноОстановкиЗаписиДействийПользователя', 'ShowWindowToStopRecordingUserActions'],
    ['ИспользоватьКомпонентуVanessaExt', 'useaddin'],
    ['ИспользоватьПарсерGherkinИзКомпонентыVanessaExt', 'usethegherkinparserfromthevanessaextaddin'],
    ['ПоискФайловСПомощьюКомпонентыVanessaExt', 'SearchingForFilesUsingTheVanessaExtComponent'],
    ['ЗавершатьРаботуЕслиНеПолучилосьВыполнитьТихуюУстановкуКомпоненты', 'QuitIfSilentInstallationAddinFails'],
    ['КаталогИнструментов', 'instrpath'],
    ['КаталогВременныхФайлов', 'TemporaryFilesDirectory'],
    ['ЗапускатьКлиентТестированияСМаксимизированнымОкном', 'runtestclientwithmaximizedwindow'],
    ['МодальноеОкноПриЗапускеТестКлиентаЭтоОшибка', 'modalwindowwhenstartingtestclientiserror'],
    ['ВыполнятьПопыткуПереподключенияЕслиПроцессТестКлиентаНеНайден', 'starttestclientsessionagainonconnectionifitsprocessisnotfound'],
    ['ЗакрыватьКлиентТестированияПринудительно', 'forceclosetestclient'],
    ['ТаймаутПередПринудительнымЗакрытиемТестКлиента', 'timeoutbeforeforciblyclosingtestclient'],
    ['ПутьКadb', 'PathToadb'],
    ['ДелатьЛогВыполненияСценариевВЖР', 'logtogr'],
    ['ЗвуковоеОповещениеПриОкончанииВыполненияСценария', 'soundnotificationwhenscriptends'],
    ['ВыполнятьШагиАсинхронно', 'makestepsasync'],
    ['ИнтервалВыполненияШагаЗаданныйПользователем', 'SpacingStepSpecifiedUser'],
    ['ОстановкаПриВозникновенииОшибки', 'stoponerror'],
    ['ПоказыватьНомерСтрокиДереваПриВозникновенииОшибки', 'showrownumberonerror'],
    ['ПриравниватьPendingКFailed', 'pendingequalfailed'],
    ['БезопасноеВыполнениеШагов', 'safeexecutionofsteps'],
    ['ТаймаутДляАсинхронныхШагов', 'timeoutforasynchronoussteps'],
    ['КоличествоСекундПоискаОкна', 'timetofindwindow'],
    ['КоличествоПопытокВыполненияДействия', 'numberofattemptstoperformanaction'],
    ['ТаймаутЗапуска1С', 'testclienttimeout'],
    ['ПаузаПриОткрытииОкна', 'pauseonwindowopening'],
    ['ВыгружатьСтатусВыполненияСценариевВФайл', 'createlogs'],
    ['ПутьКФайлуДляВыгрузкиСтатусаВыполненияСценариев', 'logpath'],
    ['ИмяТекущейСборки', 'NameCurrentBuild'],
    ['ЗагрузкаФичПриОткрытии', 'DownloadFeaturesOpen'],
    ['ДелатьЛогВыполненияСценариевВТекстовыйФайл', 'logtotext'],
    ['ВыводитьЛогВКонсоль', 'outputloginconsole'],
    ['ВыводитьВЛогВыполнениеШагов', 'logstepstotext'],
    ['ПодробныйЛогВыполненияСценариев', 'fulllog'],
    ['ИмяФайлаЛогВыполненияСценариев', 'textlogname'],
    ['ДелатьОтчетВФорматеАллюр', 'allurecreatereport'],
    ['КаталогВыгрузкиAllure', 'allurepath'],
    ['КаталогВыгрузкиAllureБазовый', 'allurepathbase'],
    ['ПодставлятьВОтчетеAllureЗначенияПеременных', 'setvariablevaluesinstepsallurereport'],
    ['ДанныеАллюрМеток', 'DataAllureMarks'],
    ['ДелатьОтчетВФорматеjUnit', 'junitcreatereport'],
    ['КаталогВыгрузкиjUnit', 'junitpath'],
    ['СкриншотыjUnit', 'junitscreenshots'],
    ['ДелатьОтчетВФорматеСППР', 'ModelingCreateReport'],
    ['КаталогВыгрузкиСППР', 'modelingreportpath'],
    ['ИмяКонфигурацииСППР', 'ModelingConfigurationName'],
    ['ВерсияКонфигурацииСППР', 'ModelingConfigurationVersion'],
    ['ДелатьОтчетВФорматеCucumberJson', 'cucumbercreatereport'],
    ['КаталогВыгрузкиCucumberJson', 'cucumberreportpath'],
    ['ДелатьЛогОшибокВТекстовыйФайл', 'logerrorstotext'],
    ['СобиратьДанныеОСостоянииАктивнойФормыПриОшибке', 'getactiveformdataonerror'],
    ['СобиратьДанныеОСостоянииВсехФормПриОшибке', 'getallformsdataonerror'],
    ['СобиратьДанныеОЗначенияхПеременных', 'CollectDataOnVariableValues'],
    ['ДелатьСкриншотПриВозникновенииОшибки', 'onerrorscreenshot'],
    ['СниматьСкриншотКаждогоОкна1С', 'onerrorscreenshoteverywindow'],
    ['ИспользоватьВнешнююКомпонентуДляСкриншотов', 'useaddinforscreencapture'],
    ['СпособСнятияСкриншотовВнешнейКомпонентой', 'screencaptureaddinmethod'],
    ['КаталогВыгрузкиСкриншотов', 'outputscreenshot'],
    ['ИмяКаталогаЛогОшибок', 'texterrorslogname'],
    ['ОткрыватьНачальнуюСтраницуПриЗапуске', 'OpenStartPageAtStartup'],
    ['ВыполнитьСценарии', 'ExecuteScenarios', 'RunScenarios'],
    ['ЗавершитьРаботуСистемы', 'CloseSystemOnComplete', 'QuitSystemOnComplete'],
    ['ЗакрытьTestClientПослеЗапускаСценариев', 'CloseTestClientAfterScenarioRun', 'CloseTestClient', 'closetestclient'],
    ['ПутьКИнфобазе', 'PathToInfobase'],
    ['ВыполнениеСценариев', 'RunningScripts'],
    ['КлиентТестирования', 'TestClient'],
    ['КлиентыТестирования', 'ДанныеКлиентовТестирования', 'datatestclients'],
    ['ПортЗапускаТестКлиента', 'PortTestClient'],
    ['ДопПараметры', 'AddItionalParameters'],
    ['ТипКлиента', 'ClientType'],
    ['ИмяКомпьютера', 'ComputerName'],
    ['Имя', 'Name'],
    ['Синоним', 'Synonym']
];

const VANESSA_PARAM_ALIAS_INDEX = (() => {
    const index = new Map<string, Set<string>>();
    for (const group of VANESSA_PARAM_ALIAS_GROUPS) {
        const normalizedGroup = Array.from(new Set(group
            .map(key => key.trim())
            .filter(key => key.length > 0)));
        if (normalizedGroup.length < 2) {
            continue;
        }
        const normalizedLookup = normalizedGroup.map(key => key.toLowerCase());
        for (const lookupKey of normalizedLookup) {
            const bucket = index.get(lookupKey) ?? new Set<string>();
            normalizedGroup.forEach(key => bucket.add(key));
            index.set(lookupKey, bucket);
        }
    }
    return index;
})();


/**
 * Провайдер для Webview в боковой панели, управляющий переключением тестов и сборкой.
 */
export class PhaseSwitcherProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'kotTestToolkit.phaseSwitcherView';
    private static readonly runVanessaCustomInfobaseCacheKey = 'runVanessa.customInfobaseByScenario';
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;

    private _testCache: Map<string, TestInfo> | null = null;
    private _isScanning: boolean = false;
    private _cacheDirty: boolean = false;
    private _cacheRefreshPromise: Promise<void> | null = null;
    private _cacheRefreshTimer: NodeJS.Timeout | null = null;
    private _isBuildInProgress: boolean = false;
    private _buildCancellationRequested: boolean = false;
    private _activeBuildProcesses: Set<cp.ChildProcess> = new Set();
    private _scenarioBuildArtifacts: Map<string, ScenarioBuildArtifact> = new Map();
    private _staleBuiltScenarioNames: Set<string> = new Set();
    private _scenarioExecutionStates: Map<string, ScenarioExecutionState> = new Map();
    private _scenarioLastLaunchContexts: Map<string, ScenarioLaunchContext> = new Map();
    private _startupArtifactsRestoreAttempted: boolean = false;
    private _outputChannel: vscode.OutputChannel | undefined;
    private _langOverride: 'System' | 'English' | 'Русский' = 'System';
    private _ruBundle: Record<string, string> | null = null;
    
    // Этот промис будет хранить состояние первоначального сканирования.
    // Он создается один раз при вызове initializeTestCache.
    public initializationPromise: Promise<void> | null = null;

    // Событие, которое будет генерироваться после обновления _testCache
    private _onDidUpdateTestCache: vscode.EventEmitter<Map<string, TestInfo> | null> = new vscode.EventEmitter<Map<string, TestInfo> | null>();
    public readonly onDidUpdateTestCache: vscode.Event<Map<string, TestInfo> | null> = this._onDidUpdateTestCache.event;

    /**
     * Публичный геттер для доступа к кешу тестов.
     */
    public getTestCache(): Map<string, TestInfo> | null {
        return this._testCache;
    }

    /**
     * Обеспечивает актуальность кеша перед операциями, чувствительными к свежим данным.
     */
    public async ensureFreshTestCache(): Promise<void> {
        await this.initializeTestCache();
        if (this._cacheDirty || this._testCache === null) {
            await this.refreshTestCacheFromDisk('ensureFreshTestCache');
        }
    }

    private getScanDirAbsolutePath(): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }
        const workspaceRootPath = workspaceFolders[0].uri.fsPath;
        return path.resolve(path.join(workspaceRootPath, getScanDirRelativePath()));
    }

    private isPathInside(parentPath: string, candidatePath: string): boolean {
        const normalizedParent = path.resolve(parentPath);
        const normalizedCandidate = path.resolve(candidatePath);
        const parentForCompare = process.platform === 'win32'
            ? normalizedParent.toLowerCase()
            : normalizedParent;
        const candidateForCompare = process.platform === 'win32'
            ? normalizedCandidate.toLowerCase()
            : normalizedCandidate;

        if (parentForCompare === candidateForCompare) {
            return true;
        }
        return candidateForCompare.startsWith(`${parentForCompare}${path.sep}`);
    }

    private areUrisEqual(left: vscode.Uri, right: vscode.Uri): boolean {
        if (left.scheme === 'file' && right.scheme === 'file') {
            const leftPath = path.resolve(left.fsPath);
            const rightPath = path.resolve(right.fsPath);
            if (process.platform === 'win32') {
                return leftPath.toLowerCase() === rightPath.toLowerCase();
            }
            return leftPath === rightPath;
        }
        return left.toString() === right.toString();
    }

    private shouldTrackUriForCache(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') {
            return false;
        }

        const normalizedScanDirPath = this.getScanDirAbsolutePath();
        if (!normalizedScanDirPath) {
            return false;
        }
        const normalizedUriPath = path.resolve(uri.fsPath);

        if (!this.isPathInside(normalizedScanDirPath, normalizedUriPath)) {
            return false;
        }

        const lowerPath = normalizedUriPath.toLowerCase();
        const baseName = path.basename(lowerPath);
        if (baseName === 'scen.yaml' || baseName === 'scen.yml') {
            return true;
        }

        // Folder create/rename/delete events may come without file extension.
        return path.extname(lowerPath) === '';
    }

    private shouldTrackUriForScenarioChange(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') {
            return false;
        }
        const scanDir = this.getScanDirAbsolutePath();
        if (!scanDir) {
            return false;
        }

        const normalizedUriPath = path.resolve(uri.fsPath);
        if (!this.isPathInside(scanDir, normalizedUriPath)) {
            return false;
        }

        const baseName = path.basename(normalizedUriPath).toLowerCase();
        return baseName === 'scen.yaml'
            || baseName === 'scen.yml'
            || baseName === 'test'
            || baseName === 'test.feature';
    }

    private parseNestedScenarioNamesFromText(documentText: string): string[] {
        const names: string[] = [];
        const sectionRegex = /ВложенныеСценарии:\s*([\s\S]*?)(?=\n(?![ \t])[А-Яа-яЁёA-Za-z]+:|\n*$)/;
        const match = sectionRegex.exec(documentText);
        if (!match || !match[1]) {
            return names;
        }

        const nameRegex = /^\s*ИмяСценария:\s*"([^"]+)"/gm;
        let nameMatch: RegExpExecArray | null;
        while ((nameMatch = nameRegex.exec(match[1])) !== null) {
            const name = nameMatch[1].trim();
            if (name.length > 0) {
                names.push(name);
            }
        }

        return names;
    }

    private extractScenarioHeaderFields(documentText: string): {
        name: string | null;
        uid: string | null;
        scenarioCode: string | null;
        scenarioCodeLine: number | null;
        scenarioCodeLineStartCharacter: number | null;
        scenarioCodeLineEndCharacter: number | null;
    } {
        let name: string | null = null;
        let uid: string | null = null;
        let scenarioCode: string | null = null;
        let scenarioCodeLine: number | null = null;
        let scenarioCodeLineStartCharacter: number | null = null;
        let scenarioCodeLineEndCharacter: number | null = null;
        const lines = documentText.split(/\r\n|\r|\n/);

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            if (!name) {
                const nameMatch = line.match(/^\s*Имя:\s*"(.+?)"\s*$/);
                if (nameMatch?.[1]) {
                    name = nameMatch[1].trim();
                }
            }

            if (!uid) {
                const uidMatch = line.match(/^\s*UID:\s*"(.+?)"\s*$/);
                if (uidMatch?.[1]) {
                    uid = uidMatch[1].trim();
                }
            }

            if (!scenarioCode) {
                const codeMatch = line.match(/^\s*Код:\s*"(.+?)"\s*$/);
                if (codeMatch?.[1]) {
                    scenarioCode = codeMatch[1].trim();
                    scenarioCodeLine = lineIndex;
                    scenarioCodeLineStartCharacter = Math.max(0, line.search(/\S|$/));
                    scenarioCodeLineEndCharacter = line.length;
                }
            }

            if (name && uid && scenarioCode) {
                break;
            }
        }

        return {
            name,
            uid,
            scenarioCode,
            scenarioCodeLine,
            scenarioCodeLineStartCharacter,
            scenarioCodeLineEndCharacter
        };
    }

    private computeRelativePathForScenarioFile(fileUri: vscode.Uri): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return path.dirname(fileUri.fsPath);
        }

        const workspaceRootPath = workspaceFolders[0].uri.fsPath;
        const scanDirPath = path.join(workspaceRootPath, getScanDirRelativePath());
        const parentDirPath = path.dirname(fileUri.fsPath);

        if (parentDirPath.startsWith(scanDirPath)) {
            return path.relative(scanDirPath, parentDirPath).replace(/\\/g, '/');
        }

        return vscode.workspace.asRelativePath(parentDirPath, false);
    }

    private buildTestInfoFromDocument(document: vscode.TextDocument): TestInfo | null {
        const documentText = document.getText();
        const {
            name,
            uid,
            scenarioCode,
            scenarioCodeLine,
            scenarioCodeLineStartCharacter,
            scenarioCodeLineEndCharacter
        } = this.extractScenarioHeaderFields(documentText);
        if (!name) {
            return null;
        }

        const nestedScenarioNames = this.parseNestedScenarioNamesFromText(documentText);
        const defaultsMap = parseScenarioParameterDefaults(documentText);
        const phaseSwitcherMetadata = parsePhaseSwitcherMetadata(documentText);
        const scenarioDescription = parseKotScenarioDescription(documentText);
        const parameters = defaultsMap.size > 0 ? Array.from(defaultsMap.keys()) : undefined;
        const parameterDefaults = defaultsMap.size > 0 ? Object.fromEntries(defaultsMap.entries()) : undefined;

        const testInfo: TestInfo = {
            name,
            yamlFileUri: document.uri,
            relativePath: this.computeRelativePathForScenarioFile(document.uri),
            parameters,
            parameterDefaults,
            nestedScenarioNames: nestedScenarioNames.length > 0 ? [...new Set(nestedScenarioNames)] : undefined,
            uid: uid || undefined,
            scenarioDescription: scenarioDescription || undefined,
            scenarioCode: scenarioCode || undefined,
            scenarioCodeLine: scenarioCodeLine ?? undefined,
            scenarioCodeLineStartCharacter: scenarioCodeLineStartCharacter ?? undefined,
            scenarioCodeLineEndCharacter: scenarioCodeLineEndCharacter ?? undefined
        };

        if (phaseSwitcherMetadata.hasTab) {
            testInfo.tabName = phaseSwitcherMetadata.tabName;
            testInfo.defaultState = phaseSwitcherMetadata.defaultState !== undefined ? phaseSwitcherMetadata.defaultState : false;
            testInfo.order = phaseSwitcherMetadata.order !== undefined ? phaseSwitcherMetadata.order : Infinity;
        }

        return testInfo;
    }

    private areStringArraysEqual(left?: string[], right?: string[]): boolean {
        if (!left?.length && !right?.length) {
            return true;
        }
        if (!left || !right || left.length !== right.length) {
            return false;
        }
        return left.every((item, index) => item === right[index]);
    }

    private areDefaultsEqual(
        left?: Record<string, string>,
        right?: Record<string, string>
    ): boolean {
        const leftEntries = Object.entries(left || {});
        const rightEntries = Object.entries(right || {});
        if (leftEntries.length !== rightEntries.length) {
            return false;
        }

        const rightMap = new Map(rightEntries);
        for (const [key, value] of leftEntries) {
            if (rightMap.get(key) !== value) {
                return false;
            }
        }
        return true;
    }

    private isSameTestInfo(left: TestInfo, right: TestInfo): boolean {
        return (
            left.name === right.name &&
            left.yamlFileUri.toString() === right.yamlFileUri.toString() &&
            left.relativePath === right.relativePath &&
            (left.uid || '') === (right.uid || '') &&
            (left.scenarioDescription || '') === (right.scenarioDescription || '') &&
            (left.scenarioCode || '') === (right.scenarioCode || '') &&
            (left.scenarioCodeLine ?? -1) === (right.scenarioCodeLine ?? -1) &&
            (left.scenarioCodeLineStartCharacter ?? -1) === (right.scenarioCodeLineStartCharacter ?? -1) &&
            (left.scenarioCodeLineEndCharacter ?? -1) === (right.scenarioCodeLineEndCharacter ?? -1) &&
            this.areStringArraysEqual(left.parameters, right.parameters) &&
            this.areDefaultsEqual(left.parameterDefaults, right.parameterDefaults) &&
            this.areStringArraysEqual(left.nestedScenarioNames, right.nestedScenarioNames) &&
            left.tabName === right.tabName &&
            left.defaultState === right.defaultState &&
            left.order === right.order
        );
    }

    public upsertScenarioCacheEntryFromDocument(document: vscode.TextDocument): boolean {
        if (!this.shouldTrackUriForCache(document.uri)) {
            return false;
        }

        try {
            const updatedInfo = this.buildTestInfoFromDocument(document);
            if (!this._testCache) {
                this._testCache = new Map<string, TestInfo>();
            }

            const uriKey = document.uri.toString();
            let changed = false;

            for (const [cachedName, cachedInfo] of this._testCache) {
                if (cachedInfo.yamlFileUri.toString() === uriKey && (!updatedInfo || cachedName !== updatedInfo.name)) {
                    this._testCache.delete(cachedName);
                    changed = true;
                }
            }

            if (updatedInfo) {
                const existing = this._testCache.get(updatedInfo.name);
                if (!existing || !this.isSameTestInfo(existing, updatedInfo)) {
                    this._testCache.set(updatedInfo.name, updatedInfo);
                    changed = true;
                }
            }

            if (changed) {
                this._onDidUpdateTestCache.fire(this._testCache);
            }

            return true;
        } catch (error) {
            console.error('[PhaseSwitcherProvider] Failed to incrementally update scenario cache entry:', error);
            return false;
        }
    }

    private markCacheDirtyAndScheduleRefresh(reason: string, immediate: boolean = false): void {
        this._cacheDirty = true;
        if (this._cacheRefreshTimer) {
            clearTimeout(this._cacheRefreshTimer);
            this._cacheRefreshTimer = null;
        }

        const delay = immediate ? 0 : 500;
        this._cacheRefreshTimer = setTimeout(() => {
            this.refreshTestCacheFromDisk(reason).catch(error => {
                console.error('[PhaseSwitcherProvider] Scheduled cache refresh failed:', error);
            });
        }, delay);
    }

    private async refreshTestCacheFromDisk(reason: string): Promise<void> {
        if (this._cacheRefreshPromise) {
            await this._cacheRefreshPromise;
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this._testCache = null;
            this._cacheDirty = false;
            this._onDidUpdateTestCache.fire(this._testCache);
            return;
        }

        const workspaceRootUri = workspaceFolders[0].uri;
        console.log(`[PhaseSwitcherProvider] Refreshing test cache from disk. Reason: ${reason}`);

        this._cacheRefreshPromise = (async () => {
            this._isScanning = true;
            try {
                this._testCache = await scanWorkspaceForTests(workspaceRootUri);
                this._cacheDirty = false;
                this._onDidUpdateTestCache.fire(this._testCache);
                console.log(`[PhaseSwitcherProvider] Cache refreshed. Total scenarios: ${this._testCache?.size || 0}`);
            } catch (scanError) {
                console.error('[PhaseSwitcherProvider] Error during cache refresh:', scanError);
            } finally {
                this._isScanning = false;
                this._cacheRefreshPromise = null;
            }
        })();

        await this._cacheRefreshPromise;
    }

    /**
     * Инициализирует кеш тестов. Этот метод теперь идемпотентный:
     * он выполняет сканирование только один раз и возвращает один и тот же промис
     * при последующих вызовах.
     */
    public initializeTestCache(): Promise<void> {
        if (this.initializationPromise) {
            console.log("[PhaseSwitcherProvider:initializeTestCache] Initialization already started or completed.");
            return this.initializationPromise;
        }

        console.log("[PhaseSwitcherProvider:initializeTestCache] Starting initial cache load...");
        // Создаем и сохраняем промис. IIFE (Immediately Invoked Function Expression)
        // немедленно запускает асинхронную операцию.
        this.initializationPromise = (async () => {
            if (this._isScanning) {
                // Эта проверка на всякий случай, с новой логикой она не должна срабатывать.
                console.log("[PhaseSwitcherProvider:initializeTestCache] Scan was already in progress.");
                return;
            }

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                console.log("[PhaseSwitcherProvider:initializeTestCache] No workspace folder, skipping cache initialization.");
                this._testCache = null;
                this._cacheDirty = false;
                this._onDidUpdateTestCache.fire(this._testCache);
                return;
            }

            const workspaceRootUri = workspaceFolders[0].uri;
            this._isScanning = true;
            try {
                this._testCache = await scanWorkspaceForTests(workspaceRootUri);
                this._cacheDirty = false;
                console.log(`[PhaseSwitcherProvider:initializeTestCache] Initial cache loaded with ${this._testCache?.size || 0} scenarios`);
                this._onDidUpdateTestCache.fire(this._testCache);
            } catch (scanError: any) {
                console.error("[PhaseSwitcherProvider:initializeTestCache] Error during initial scan:", scanError);
                this._testCache = null;
                this._cacheDirty = true;
                this._onDidUpdateTestCache.fire(this._testCache);
            } finally {
                this._isScanning = false;
                console.log("[PhaseSwitcherProvider:initializeTestCache] Initial scan finished.");
            }
        })();

        return this.initializationPromise;
    }


    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        console.log("[PhaseSwitcherProvider] Initialized.");
        this._outputChannel = vscode.window.createOutputChannel("KOT Test Assembly", { log: true });


        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('kotTestToolkit.assembleScript.buildPath')) {
                this._startupArtifactsRestoreAttempted = false;
                this._scenarioBuildArtifacts.clear();
                this._staleBuiltScenarioNames.clear();
                this._scenarioExecutionStates.clear();
                this._scenarioLastLaunchContexts.clear();
            }
            // Configuration changes will trigger panel refresh when needed
                if (this._view && this._view.visible) {
                console.log("[PhaseSwitcherProvider] Configuration changed, refreshing panel...");
                    this._sendInitialState(this._view.webview);
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
            const shouldTrackCache = this.shouldTrackUriForCache(document.uri);
            const shouldTrackScenarioChange = this.shouldTrackUriForScenarioChange(document.uri);
            if (!shouldTrackCache && !shouldTrackScenarioChange) {
                return;
            }

            const affectedScenarioNamesBeforeSave = shouldTrackScenarioChange
                ? this.getScenarioNamesRelatedToUri(document.uri)
                : [];

            if (shouldTrackCache) {
                const updatedIncrementally = this.upsertScenarioCacheEntryFromDocument(document);
                if (!updatedIncrementally) {
                    this.markCacheDirtyAndScheduleRefresh(`save:${path.basename(document.uri.fsPath)}`);
                }
            }

            const affectedScenarioNamesAfterSave = shouldTrackScenarioChange
                ? this.getScenarioNamesRelatedToUri(document.uri)
                : [];
            const affectedScenarioNames = new Set<string>([
                ...affectedScenarioNamesBeforeSave,
                ...affectedScenarioNamesAfterSave
            ]);

            if (shouldTrackScenarioChange) {
                for (const artifactScenarioName of this.getScenarioNamesByArtifactSourceUri(document.uri)) {
                    affectedScenarioNames.add(artifactScenarioName);
                }
            }

            if (shouldTrackCache) {
                for (const artifact of this._scenarioBuildArtifacts.values()) {
                    if (this.areUrisEqual(artifact.sourceUri, document.uri)) {
                        affectedScenarioNames.add(artifact.scenarioName);
                    }
                }
            }

            if (affectedScenarioNames.size > 0) {
                this.markBuiltArtifactsAsStale(affectedScenarioNames);
                this.sendRunArtifactsStateToWebview();
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidCreateFiles(event => {
            if (event.files.some(uri => this.shouldTrackUriForCache(uri))) {
                this.markCacheDirtyAndScheduleRefresh('createFiles');
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidDeleteFiles(event => {
            if (event.files.some(uri => this.shouldTrackUriForCache(uri))) {
                this.markCacheDirtyAndScheduleRefresh('deleteFiles');
            }

            const deletedUris = new Set(event.files.map(uri => uri.toString()));
            if (deletedUris.size > 0 && this._scenarioBuildArtifacts.size > 0) {
                let changed = false;
                for (const [scenarioName, artifact] of this._scenarioBuildArtifacts) {
                    if (deletedUris.has(artifact.sourceUri.toString())) {
                        this._scenarioBuildArtifacts.delete(scenarioName);
                        this._staleBuiltScenarioNames.delete(scenarioName);
                        this._scenarioExecutionStates.delete(scenarioName);
                        changed = true;
                    }
                }
                if (changed) {
                    this.sendRunArtifactsStateToWebview();
                }
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidRenameFiles(event => {
            const affectsCache = event.files.some(({ oldUri, newUri }) =>
                this.shouldTrackUriForCache(oldUri) || this.shouldTrackUriForCache(newUri)
            );
            if (affectsCache) {
                this.markCacheDirtyAndScheduleRefresh('renameFiles');
            }
        }));

        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this._testCache = null;
            this._cacheDirty = true;
            this.initializationPromise = null;
            this._startupArtifactsRestoreAttempted = false;
            this._scenarioBuildArtifacts.clear();
            this._staleBuiltScenarioNames.clear();
            this._scenarioExecutionStates.clear();
            this._scenarioLastLaunchContexts.clear();
            this.markCacheDirtyAndScheduleRefresh('workspaceFoldersChanged', true);
            this.sendRunArtifactsStateToWebview();
        }));

        context.subscriptions.push({
            dispose: () => {
                if (this._cacheRefreshTimer) {
                    clearTimeout(this._cacheRefreshTimer);
                    this._cacheRefreshTimer = null;
                }
            }
        });
    }

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
                console.warn('[PhaseSwitcherProvider] Failed to load RU bundle:', e);
                this._ruBundle = null;
            }
                } else {
            this._ruBundle = null;
        }
    }

    private formatPlaceholders(template: string, args: string[]): string {
        return template.replace(/\{(\d+)\}/g, (m, idx) => {
            const i = Number(idx);
            return i >= 0 && i < args.length ? args[i] : m;
        });
    }

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

    private getOutputChannel(): vscode.OutputChannel {
        if (!this._outputChannel) {
            this._outputChannel = vscode.window.createOutputChannel("KOT Test Assembly", { log: true });
        }
        return this._outputChannel;
    }

    private isAdvancedOutputLoggingEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('kotTestToolkit')
            .get<boolean>('output.advancedLogging', false);
    }

    private getOutputTimestamp(): string {
        return new Date().toLocaleTimeString(undefined, { hour12: false });
    }

    private outputInfo(outputChannel: vscode.OutputChannel, message: string): void {
        outputChannel.appendLine(`[${this.getOutputTimestamp()}] ${message}`);
    }

    private outputAdvanced(outputChannel: vscode.OutputChannel, message: string): void {
        if (!this.isAdvancedOutputLoggingEnabled()) {
            return;
        }
        outputChannel.appendLine(`[${this.getOutputTimestamp()}] [advanced] ${message}`);
    }

    private outputError(
        outputChannel: vscode.OutputChannel,
        message: string,
        error?: unknown
    ): void {
        outputChannel.appendLine(`[${this.getOutputTimestamp()}] ${message}`);
        if (error && this.isAdvancedOutputLoggingEnabled()) {
            const details = error instanceof Error
                ? (error.stack || error.message)
                : String(error);
            if (details.trim()) {
                outputChannel.appendLine(details.trim());
            }
        }
    }

    private appendProcessOutputTail(
        outputChannel: vscode.OutputChannel,
        processName: string,
        stdoutData: string,
        stderrData: string
    ): void {
        if (!this.isAdvancedOutputLoggingEnabled()) {
            return;
        }

        const combined = [stderrData, stdoutData]
            .filter(chunk => chunk && chunk.trim().length > 0)
            .join('\n')
            .trim();
        if (!combined) {
            return;
        }

        const lines = combined.split(/\r\n|\r|\n/).filter(Boolean);
        const tail = lines.slice(Math.max(0, lines.length - 40)).join('\n');
        if (!tail.trim()) {
            return;
        }

        this.outputAdvanced(outputChannel, this.t('Process output tail for {0}:', processName));
        outputChannel.appendLine(tail);
    }

    private appendScenarioRunLogReference(
        outputChannel: vscode.OutputChannel,
        scenarioName: string,
        runLogPath?: string
    ): void {
        const normalizedPath = runLogPath?.trim();
        if (!normalizedPath) {
            return;
        }
        const absoluteLogPath = path.resolve(normalizedPath);
        this.outputInfo(outputChannel, this.t('Run log for "{0}": {1}', scenarioName, absoluteLogPath));
    }

    private isBuildCancelledError(error: unknown): error is BuildCancelledError {
        if (error instanceof BuildCancelledError) {
            return true;
        }
        return error instanceof Error && error.name === 'BuildCancelledError';
    }

    private throwIfBuildCancellationRequested(): void {
        if (this._buildCancellationRequested) {
            throw new BuildCancelledError(this.t('Build was cancelled by user.'));
        }
    }

    private async terminateChildProcessTree(
        child: cp.ChildProcess,
        outputChannel: vscode.OutputChannel
    ): Promise<void> {
        const pid = child.pid;
        if (!pid || pid <= 0) {
            return;
        }

        try {
            if (process.platform === 'win32') {
                await new Promise<void>((resolve, reject) => {
                    const killer = cp.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
                        windowsHide: true,
                        shell: false
                    });
                    let stderrText = '';
                    killer.stderr?.on('data', data => {
                        stderrText += data.toString();
                    });
                    killer.on('error', reject);
                    killer.on('close', code => {
                        if (code === 0) {
                            resolve();
                            return;
                        }
                        reject(new Error(stderrText.trim() || `taskkill exited with code ${String(code)}`));
                    });
                });
            } else {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch (error: any) {
                    if (error?.code !== 'ESRCH') {
                        throw error;
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 350));

                if (child.exitCode === null && child.signalCode === null) {
                    try {
                        process.kill(pid, 'SIGKILL');
                    } catch (error: any) {
                        if (error?.code !== 'ESRCH') {
                            throw error;
                        }
                    }
                }
            }

            this.outputAdvanced(outputChannel, this.t('Requested termination for build process PID {0}.', String(pid)));
        } catch (error: any) {
            this.outputAdvanced(
                outputChannel,
                this.t('Failed to terminate build process PID {0}: {1}', String(pid), error?.message || String(error))
            );
        }
    }

    private async requestBuildCancellation(): Promise<void> {
        if (!this._isBuildInProgress) {
            vscode.window.showInformationMessage(this.t('No build is currently running.'));
            return;
        }

        if (this._buildCancellationRequested) {
            this.outputInfo(this.getOutputChannel(), this.t('Build cancellation is already in progress.'));
            return;
        }

        this._buildCancellationRequested = true;
        const outputChannel = this.getOutputChannel();
        this.outputInfo(outputChannel, this.t('Build cancellation requested. Stopping started 1C processes...'));

        if (this._view?.webview) {
            this._view.webview.postMessage({
                command: 'updateStatus',
                text: this.t('Cancelling build...'),
                enableControls: false,
                target: 'assemble',
                refreshButtonEnabled: false
            });
        }

        const activeProcesses = Array.from(this._activeBuildProcesses);
        if (activeProcesses.length === 0) {
            this.outputAdvanced(outputChannel, this.t('No active build processes were found at cancellation time.'));
            return;
        }

        await Promise.allSettled(activeProcesses.map(child => this.terminateChildProcessTree(child, outputChannel)));
    }

    /**
     * Публичный метод для принудительного обновления данных панели.
     * Может быть вызван извне, например, после создания нового сценария.
     */
    public async refreshPanelData() {
        if (this._view && this._view.webview && this._view.visible) {
            console.log("[PhaseSwitcherProvider] Refreshing panel data programmatically...");
            this._testCache = null;
            this._cacheDirty = true;
            await this._sendInitialState(this._view.webview);
        } else {
            console.log("[PhaseSwitcherProvider] Panel not visible or not resolved, cannot refresh programmatically yet. Will refresh on next resolve/show.");
            // Можно установить флаг, чтобы _sendInitialState вызвался при следующем resolveWebviewView или onDidChangeVisibility
            this._cacheDirty = true;
        }
    }

    public async openScenarioInVanessaManualFromCommandPalette(): Promise<void> {
        if (this._isBuildInProgress) {
            vscode.window.showWarningMessage(this.t('Please wait for the current build to finish.'));
            return;
        }

        this.pruneScenarioBuildArtifactsByCache();
        if (this._scenarioBuildArtifacts.size === 0) {
            vscode.window.showWarningMessage(
                this.t('No build artifacts found. Build tests first in current session.')
            );
            return;
        }

        const scenarios = Array.from(this._scenarioBuildArtifacts.keys());
        scenarios.sort((a, b) => {
            const statusA = this._scenarioExecutionStates.get(a)?.status || 'idle';
            const statusB = this._scenarioExecutionStates.get(b)?.status || 'idle';
            const failedA = statusA === 'failed' ? 1 : 0;
            const failedB = statusB === 'failed' ? 1 : 0;
            if (failedA !== failedB) {
                return failedB - failedA;
            }
            return a.localeCompare(b);
        });

        const quickPickItems = scenarios.map(name => {
            const executionState = this._scenarioExecutionStates.get(name);
            const status = executionState?.status || 'idle';
            const stale = this._staleBuiltScenarioNames.has(name);
            const artifact = this._scenarioBuildArtifacts.get(name);
            const modes = [
                artifact?.featurePath ? 'feature' : '',
                artifact?.jsonPath ? 'json' : ''
            ].filter(Boolean).join('/');
            const statusText = status === 'failed'
                ? this.t('Last run failed')
                : (status === 'passed'
                    ? this.t('Last run passed')
                    : (status === 'running'
                        ? this.t('Run in progress')
                        : this.t('Ready to run')));
            const staleSuffix = stale ? ` • ${this.t('Build is stale')}` : '';
            return {
                label: name,
                description: `${statusText}${staleSuffix}`,
                detail: modes ? this.t('Artifacts: {0}', modes) : undefined
            };
        });

        const picked = await vscode.window.showQuickPick(quickPickItems, {
            title: this.t('Open scenario in Vanessa (manual debug)'),
            placeHolder: this.t('Select scenario for Vanessa manual debug session.'),
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true
        });
        if (!picked) {
            return;
        }

        await this.openScenarioInVanessaManual(picked.label);
    }

    private async pickScenarioForVanessaRun(): Promise<void> {
        if (this._isBuildInProgress) {
            vscode.window.showWarningMessage(this.t('Please wait for the current build to finish.'));
            return;
        }

        this.pruneScenarioBuildArtifactsByCache();
        if (this._scenarioBuildArtifacts.size === 0) {
            vscode.window.showWarningMessage(
                this.t('No build artifacts found. Build tests first in current session.')
            );
            return;
        }

        const scenarios = Array.from(this._scenarioBuildArtifacts.keys());
        scenarios.sort((a, b) => {
            const statusA = this._scenarioExecutionStates.get(a)?.status || 'idle';
            const statusB = this._scenarioExecutionStates.get(b)?.status || 'idle';
            const failedA = statusA === 'failed' ? 1 : 0;
            const failedB = statusB === 'failed' ? 1 : 0;
            if (failedA !== failedB) {
                return failedB - failedA;
            }
            return a.localeCompare(b);
        });

        const quickPickItems = scenarios.map(name => {
            const executionState = this._scenarioExecutionStates.get(name);
            const status = executionState?.status || 'idle';
            const stale = this._staleBuiltScenarioNames.has(name);
            const artifact = this._scenarioBuildArtifacts.get(name);
            const modes = [
                artifact?.featurePath ? 'feature' : '',
                artifact?.jsonPath ? 'json' : ''
            ].filter(Boolean).join('/');
            const statusText = status === 'failed'
                ? this.t('Last run failed')
                : (status === 'passed'
                    ? this.t('Last run passed')
                    : (status === 'running'
                        ? this.t('Run in progress')
                        : this.t('Ready to run')));
            const staleSuffix = stale ? ` • ${this.t('Build is stale')}` : '';
            return {
                label: name,
                description: `${statusText}${staleSuffix}`,
                detail: modes ? this.t('Artifacts: {0}', modes) : undefined
            };
        });

        const picked = await vscode.window.showQuickPick(quickPickItems, {
            title: this.t('Run scenario in Vanessa'),
            placeHolder: this.t('Select scenario for Vanessa run session.'),
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true
        });
        if (!picked) {
            return;
        }

        await this.runScenarioInVanessa(picked.label);
    }

    private async openVanessaStandaloneDebug(): Promise<void> {
        if (this._isBuildInProgress) {
            vscode.window.showWarningMessage(this.t('Please wait for the current build to finish.'));
            return;
        }

        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage(this.t('Project folder must be opened.'));
            return;
        }

        const workspaceRootPath = workspaceFolder.uri.fsPath;
        const oneCPath = (config.get<string>('paths.oneCEnterpriseExe') || '').trim();
        if (!oneCPath) {
            vscode.window.showErrorMessage(
                this.t('Path to 1C:Enterprise (1cv8.exe) is not specified in settings.'),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
                }
            });
            return;
        }
        if (!fs.existsSync(oneCPath)) {
            vscode.window.showErrorMessage(
                this.t('1C:Enterprise file (1cv8.exe) not found at path: {0}', oneCPath),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
                }
            });
            return;
        }

        const emptyIbPath = (config.get<string>('paths.emptyInfobase') || '').trim();
        if (!emptyIbPath) {
            vscode.window.showErrorMessage(
                this.t('Path to empty infobase is not specified in settings.'),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.emptyInfobase');
                }
            });
            return;
        }
        if (!fs.existsSync(emptyIbPath)) {
            vscode.window.showErrorMessage(
                this.t('Empty infobase directory not found at path: {0}', emptyIbPath),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.emptyInfobase');
                }
            });
            return;
        }

        const vanessaEpfSetting = (config.get<string>('runVanessa.vanessaEpfPath') || '').trim();
        if (!vanessaEpfSetting) {
            vscode.window.showErrorMessage(
                this.t('Path to Vanessa Automation EPF is not specified in settings.'),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.runVanessa.vanessaEpfPath');
                }
            });
            return;
        }
        const vanessaEpfPath = this.resolvePathFromWorkspaceSetting(vanessaEpfSetting, workspaceRootPath);
        if (!fs.existsSync(vanessaEpfPath)) {
            vscode.window.showErrorMessage(
                this.t('Vanessa Automation EPF file not found at path: {0}', vanessaEpfPath),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.runVanessa.vanessaEpfPath');
                }
            });
            return;
        }

        const unsafeProtectionConfigured = await this.ensureUnsafeActionProtectionConfiguredForVanessa(oneCPath, emptyIbPath);
        if (!unsafeProtectionConfigured) {
            return;
        }

        const launchOverlay = await this.loadVanessaLaunchOverlayParameters();
        const launchJson: Record<string, unknown> = {};
        if (launchOverlay.additionalParameters.length > 0) {
            this.applyAdditionalVanessaParameters(launchJson, launchOverlay.additionalParameters);
        }
        if (launchOverlay.globalVariables.length > 0) {
            this.applyGlobalVanessaVariables(launchJson, launchOverlay.globalVariables);
        }

        const tempDir = path.join(os.tmpdir(), 'kot-test-toolkit', 'vanessa');
        await fs.promises.mkdir(tempDir, { recursive: true });
        const launchJsonPath = path.join(tempDir, `standalone_debug_${Date.now()}.json`);
        await fs.promises.writeFile(launchJsonPath, JSON.stringify(launchJson, null, 2), 'utf8');

        const vaCommandParts = [
            'ShowMainForm',
            'QuietInstallVanessaExt',
            `VAParams=${launchJsonPath}`,
            'WithoutSendingStatistics',
            'UseEditor'
        ];
        const vaCommand = `${vaCommandParts.join(';')};`;
        const args = [
            ...this.buildStartupParams(emptyIbPath),
            '/Execute',
            `"${vanessaEpfPath}"`,
            `/C"${vaCommand}"`,
            '/TESTMANAGER'
        ];

        const outputChannel = this.getOutputChannel();
        outputChannel.show(true);
        this.outputInfo(outputChannel, this.t('Opening Vanessa Automation standalone debug session...'));
        this.outputAdvanced(outputChannel, this.t('Vanessa EPF path: {0}', vanessaEpfPath));
        this.outputAdvanced(outputChannel, this.t('Vanessa JSON run settings: {0}', launchJsonPath));
        this.outputAdvanced(outputChannel, this.t('Using startup infobase path for this run: {0}', emptyIbPath));

        try {
            await this.execute1CProcessDetached(
                oneCPath,
                args,
                workspaceRootPath,
                'Vanessa Automation Manual (standalone)'
            );
            vscode.window.showInformationMessage(this.t('Vanessa standalone debug session started.'));
            this.outputInfo(outputChannel, this.t('Vanessa standalone debug session started.'));
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputError(
                outputChannel,
                this.t('Failed to open Vanessa standalone debug session: {0}', errorMessage),
                error
            );
            vscode.window.showErrorMessage(
                this.t('Failed to open Vanessa standalone debug session: {0}', errorMessage)
            );
        }
    }


    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        context: vscode.WebviewViewResolveContext,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _token: vscode.CancellationToken,
    ) {
        console.log("[PhaseSwitcherProvider] Resolving webview view...");
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'node_modules')
            ]
        };
        // Ждем завершения промиса первоначальной инициализации.
        // Если он еще не был создан, это не страшно (будет null).
        // Если он уже выполняется, мы дождемся его завершения.
        if (this.initializationPromise) {
            console.log("[PhaseSwitcherProvider] Waiting for initial test cache to be ready...");
            await this.initializationPromise;
            console.log("[PhaseSwitcherProvider] Initial test cache is ready.");
        }

        await this.loadLocalizationBundleIfNeeded();
        const nonce = getNonce();
        const styleUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.css'));
        const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.js'));
        const htmlTemplateUri = vscode.Uri.joinPath(this._extensionUri, 'media', 'phaseSwitcher.html');
        const codiconsUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicon.css'));

        try {
            const htmlBytes = await vscode.workspace.fs.readFile(htmlTemplateUri);
            let htmlContent = Buffer.from(htmlBytes).toString('utf-8');
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            htmlContent = htmlContent.replace('${stylesUri}', styleUri.toString());
            htmlContent = htmlContent.replace('${scriptUri}', scriptUri.toString());
            htmlContent = htmlContent.replace('${codiconsUri}', codiconsUri.toString());
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webviewView.webview.cspSource);

            const langOverride = this._langOverride;
            const effectiveLang = langOverride === 'System' ? (vscode.env.language || 'English') : langOverride;
            const localeHtmlLang = effectiveLang.split('-')[0];
            const extDisplayName = this.t('KOT for 1C');
            const loc = {
                phaseSwitcherTitle: this.t('Phase Switcher'),
                openSettingsTitle: this.t('Open extension settings'),
                createScenarioTitle: this.t('Create scenario'),
                createMainScenario: this.t('Main scenario'),
                createNestedScenario: this.t('Nested scenario'),
                refreshTitle: this.t('Refresh from disk'),
                collapseExpandAllTitle: this.t('Collapse/Expand all phases'),
                toggleAllCheckboxesTitle: this.t('Toggle all checkboxes'),
                loadingPhasesAndTests: this.t('Loading phases and tests...'),
                defaults: this.t('Defaults'),
                apply: this.t('Apply'),
                statusInit: this.t('Status: Initializing...'),
                assemblyTitle: this.t('Assembly'),
                accountingMode: this.t('Accounting mode'),
                createFirstLaunchZipTitle: this.t('Create FirstLaunch archive'),
                buildFL: this.t('Build FL'),
                buildTests: this.t('Build tests'),
                cancelBuild: this.t('Cancel build'),
                cancelBuildTitle: this.t('Cancel running build'),
                recordGLSelectTitle: this.t('Record GL Accounts (0=No, 1=Yes, 2=Templates)'),
                collapsePhaseTitle: this.t('Collapse phase'),
                expandPhaseTitle: this.t('Expand phase'),
                toggleAllInPhaseTitle: this.t('Toggle all tests in this phase'),
                noTestsInPhase: this.t('No tests in this phase.'),
                noPhasesToDisplay: this.t('No phases to display.'),
                checkboxDataError: this.t('Checkbox data error'),
                readyToWork: this.t('Ready to work.'),
                errorLoadingTests: this.t('Error loading tests.'),
                expandAllPhasesTitle: this.t('Expand all phases'),
                collapseAllPhasesTitle: this.t('Collapse all phases'),
                phaseSwitcherDisabled: this.t('Phase Switcher is disabled in settings.'),
                errorWithDetails: this.t('Error: {0}', '{0}'),
                openScenarioFileTitle: this.t('Open scenario file {0}', '{0}'),
                runVanessaTopTitle: this.t('Run scenario in Vanessa'),
                runScenarioFeatureTitle: this.t('Run scenario in Vanessa Automation by feature: {0}', '{0}'),
                runScenarioJsonTitle: this.t('Run scenario in Vanessa Automation by json: {0}', '{0}'),
                runScenarioStaleSuffix: this.t('Build is stale'),
                runScenarioRunningSuffix: this.t('Run in progress'),
                runScenarioPassedSuffix: this.t('Last run passed'),
                runScenarioFailedSuffix: this.t('Last run failed'),
                runScenarioNoArtifacts: this.t('No build artifacts found. Build tests first in current session.'),
                runScenarioLogTitle: this.t('Open run log for scenario: {0}', '{0}'),
                runScenarioModeTitle: this.t('Choose launch mode'),
                runScenarioModeAutomatic: this.t('Run test (auto close)'),
                runScenarioModeManual: this.t('Open for debugging (keep Vanessa open)'),
                runScenarioModeHint: this.t('Click to choose mode: auto run closes Vanessa after execution; debug mode opens scenario for interactive debugging.'),
                runScenarioModeAutomaticHint: this.t('Runs scenario with StartFeaturePlayer and waits for completion.'),
                runScenarioModeManualHint: this.t('Opens Vanessa for interactive debugging without scenario selection.'),
                runScenarioModeOpenFeature: this.t('Open feature in editor'),
                runScenarioModeOpenFeatureHint: this.t('Opens built feature file for this scenario in editor.'),
                runScenarioNoFeatureArtifact: this.t('Feature artifact is not available for this scenario.'),
                statusLoadingShort: this.t('Loading...'),
                statusRequestingData: this.t('Requesting data...'),
                statusApplyingPhaseChanges: this.t('Applying phase changes...'),
                statusStartingAssembly: this.t('Starting assembly...'),
                statusBuildingInProgress: this.t('Building tests in progress...'),
                statusCancellingBuild: this.t('Cancelling build...'),
                pendingNoChanges: this.t('No pending changes.'),
                pendingTotalChanged: this.t('Total changed: {0}'),
                pendingEnabled: this.t('Enabled: {0}'),
                pendingDisabled: this.t('Disabled: {0}'),
                pendingPressApply: this.t('Press "Apply"'),
                openYamlParametersManagerTitle: this.t('Open Build Scenario Parameters Manager'),
                yamlParameters: this.t('Build Scenario Parameters')
            };

            htmlContent = htmlContent.replace('${localeHtmlLang}', localeHtmlLang);
            htmlContent = htmlContent.replace('${extDisplayName}', extDisplayName);
            for (const [k, v] of Object.entries(loc)) {
                htmlContent = htmlContent.replace(new RegExp(`\\$\\{loc\\.${k}\\}`, 'g'), v);
            }
            htmlContent = htmlContent.replace('${webviewLoc}', JSON.stringify(loc));
            webviewView.webview.html = htmlContent;
            console.log("[PhaseSwitcherProvider] HTML content set from template.");
        } catch (err: any) {
            console.error('[PhaseSwitcher] Error loading interface:', err);
            webviewView.webview.html = `<body>${this.t('Error loading interface: {0}', err.message || err)}</body>`;
        }

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'applyChanges':
                    if (!message.data || typeof message.data !== 'object') {
                        vscode.window.showErrorMessage(this.t('Error: Invalid data received for application.'));
                        this._view?.webview.postMessage({ command: 'updateStatus', text: this.t('Error: invalid data.'), enableControls: true });
                        return;
                    }
                    await this._handleApplyChanges(message.data);
                    return;
                case 'getInitialState': 
                    await this._sendInitialState(webviewView.webview);
                    return;
                case 'refreshData': 
                    this._testCache = null;
                    this._cacheDirty = true;
                    await this._sendInitialState(webviewView.webview);
                    return;
                case 'scanWorkspaceDiagnostics':
                    await vscode.commands.executeCommand('kotTestToolkit.scanWorkspaceDiagnostics');
                    return;
                case 'log':
                    console.log(message.text);
                    return;
                case 'runAssembleScript':
                    const params = message.params || {};
                    const recordGL = typeof params.recordGL === 'string' ? params.recordGL : 'No';
                    await this._handleRunAssembleScriptTypeScript(recordGL);
                    return;
                case 'cancelAssembleScript':
                    await this.requestBuildCancellation();
                    return;
                case 'openScenario':
                    if (message.name && this._testCache) {
                        const testInfo = this._testCache.get(message.name);
                        if (testInfo && testInfo.yamlFileUri) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(testInfo.yamlFileUri);
                                await vscode.window.showTextDocument(doc, { preview: false });
                            } catch (error: any) {
                                console.error(`[PhaseSwitcherProvider] Error opening scenario file: ${error.message || error}`);
                                vscode.window.showErrorMessage(this.t('Failed to open scenario file: {0}', error.message || error));
                            }
                        } else {
                            vscode.window.showWarningMessage(this.t('Scenario "{0}" not found or its path is not defined.', message.name));
                        }
                    }
                    return;
                case 'runScenarioInVanessa':
                    if (typeof message.name === 'string' && message.name.trim().length > 0) {
                        await this.runScenarioInVanessa(message.name.trim());
                    }
                    return;
                case 'openRunScenarioLog':
                    if (typeof message.name === 'string' && message.name.trim().length > 0) {
                        await this.openRunScenarioLog(message.name.trim());
                    }
                    return;
                case 'openScenarioFeatureInEditor':
                    if (typeof message.name === 'string' && message.name.trim().length > 0) {
                        await this.openScenarioFeatureInEditor(message.name.trim());
                    }
                    return;
                case 'runScenarioViaPicker':
                    if (message.mode === 'debug') {
                        await this.openVanessaStandaloneDebug();
                    } else {
                        await this.pickScenarioForVanessaRun();
                    }
                    return;
                case 'openScenarioInVanessaManual':
                    if (typeof message.name === 'string' && message.name.trim().length > 0) {
                        await this.openScenarioInVanessaManual(message.name.trim());
                    }
                    return;
                case 'openSettings':
                    console.log("[PhaseSwitcherProvider] Opening extension settings...");
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit');
                    return;
                case 'createMainScenario':
                    console.log("[PhaseSwitcherProvider] Received createMainScenario command from webview.");
                    vscode.commands.executeCommand('kotTestToolkit.createMainScenario');
                    return;
                case 'createNestedScenario':
                    console.log("[PhaseSwitcherProvider] Received createNestedScenario command from webview.");
                    vscode.commands.executeCommand('kotTestToolkit.createNestedScenario');
                    return;
                case 'createFirstLaunchZip':
                    console.log("[PhaseSwitcherProvider] Received createFirstLaunchZip command from webview.");
                    vscode.commands.executeCommand('kotTestToolkit.createFirstLaunchZip');
                    return;
                case 'openYamlParametersManager':
                    console.log("[PhaseSwitcherProvider] Received openYamlParametersManager command from webview.");
                    vscode.commands.executeCommand('kotTestToolkit.openYamlParametersManager');
                    return;
            }
        }, undefined, this._context.subscriptions);

        // Добавляем обработчик изменения видимости
        webviewView.onDidChangeVisibility(async () => {
            if (webviewView.visible) {
                console.log("[PhaseSwitcherProvider] View became visible. Refreshing state.");
                await this._sendInitialState(webviewView.webview);
            }
        }, null, this._context.subscriptions);


        webviewView.onDidDispose(() => {
            console.log("[PhaseSwitcherProvider] View disposed.");
            this._view = undefined;
        }, null, this._context.subscriptions);

        // Первоначальная загрузка данных при первом разрешении
        if (webviewView.visible) {
            await this._sendInitialState(webviewView.webview);
        }

        console.log("[PhaseSwitcherProvider] Webview resolved successfully.");
    }

    private async _sendInitialState(webview: vscode.Webview) {
        console.log("[PhaseSwitcherProvider:_sendInitialState] Preparing and sending initial state...");
        webview.postMessage({ command: 'updateStatus', text: this.t('Scanning files...'), enableControls: false, refreshButtonEnabled: false });

        // Panels are always enabled now
        const switcherEnabled = true;
        const assemblerEnabled = true;
        const driveFeaturesEnabled = vscode.workspace
            .getConfiguration('kotTestToolkit')
            .get<boolean>('assembleScript.showDriveFeatures', false);

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage(this.t('Please open a project folder.'));
            webview.postMessage({ command: 'loadInitialState', error: this.t('Project folder is not open') });
            webview.postMessage({ command: 'updateStatus', text: this.t('Error: Project folder is not open'), refreshButtonEnabled: true });
            this._testCache = null; 
            this._onDidUpdateTestCache.fire(this._testCache); // Уведомляем об отсутствии данных
            return;
        }
        const workspaceRootUri = workspaceFolders[0].uri;

        // Check if first launch folder exists (independent of test cache)
        const projectPaths = this.getProjectPaths(workspaceRootUri);
        let firstLaunchFolderExists = false;
        if (projectPaths.firstLaunchFolder) {
            try {
                await vscode.workspace.fs.stat(projectPaths.firstLaunchFolder);
                firstLaunchFolderExists = true;
            } catch {
                // Folder doesn't exist
                firstLaunchFolderExists = false;
            }
        }

        // Use existing cache if available, otherwise scan (or refresh stale cache)
        if (this._testCache === null || this._cacheDirty) {
            const reason = this._testCache === null
                ? "cache is empty"
                : "cache marked as dirty";
            console.log(`[PhaseSwitcherProvider:_sendInitialState] Refreshing cache because ${reason}.`);
            try {
                await this.refreshTestCacheFromDisk('_sendInitialState');
            } catch (scanError: any) {
                console.error("[PhaseSwitcherProvider:_sendInitialState] Error during cache refresh:", scanError);
                vscode.window.showErrorMessage(this.t('Error scanning scenario files: {0}', scanError.message || scanError));
                this._testCache = null;
            }
        } else {
            console.log(`[PhaseSwitcherProvider:_sendInitialState] Using existing cache with ${this._testCache.size} scenarios`);
        }

        await this.restoreScenarioBuildArtifactsFromDiskIfNeeded(workspaceRootUri);

        let states: { [key: string]: 'checked' | 'unchecked' | 'disabled' } = {};
        let status = this.t('Scan error or no tests found');
        let tabDataForUI: { [tabName: string]: TestInfo[] } = {}; // Данные только для UI Phase Switcher
        let checkedCount = 0;
        let testsForPhaseSwitcherCount = 0;


        if (this._testCache) {
            status = this.t('Checking test state...');
            webview.postMessage({ command: 'updateStatus', text: status, refreshButtonEnabled: false });

            const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, getScanDirRelativePath());
            const baseOffDirUri = projectPaths.disabledTestsDirectory;

            const testsForPhaseSwitcherProcessing: TestInfo[] = [];
            this._testCache.forEach(info => {
                // Для Phase Switcher UI используем только тесты, у которых есть tabName
                if (info.tabName && typeof info.tabName === 'string' && info.tabName.trim() !== "") {
                    testsForPhaseSwitcherProcessing.push(info);
                }
            });
            testsForPhaseSwitcherCount = testsForPhaseSwitcherProcessing.length;


            await Promise.all(testsForPhaseSwitcherProcessing.map(async (info) => {
                const onPathTestDir = vscode.Uri.joinPath(baseOnDirUri, info.relativePath, 'test');
                const offPathTestDir = vscode.Uri.joinPath(baseOffDirUri, info.relativePath, 'test');
                let stateResult: 'checked' | 'unchecked' | 'disabled' = 'disabled';

                try { await vscode.workspace.fs.stat(onPathTestDir); stateResult = 'checked'; }
                catch { try { await vscode.workspace.fs.stat(offPathTestDir); stateResult = 'unchecked'; } catch { /* stateResult remains 'disabled' */ } }

                states[info.name] = stateResult;
                if (stateResult === 'checked') {
                    checkedCount++;
                }
            }));
            
            // Группируем и сортируем данные только для тех тестов, что идут в UI
            tabDataForUI = this._groupAndSortTestData(new Map(testsForPhaseSwitcherProcessing.map(info => [info.name, info])));


            status = this.t('State loaded: \n{0} / {1} enabled', String(checkedCount), String(testsForPhaseSwitcherCount));
        } else {
            status = this.t('No tests found or scan error.');
        }

        console.log(`[PhaseSwitcherProvider:_sendInitialState] State check complete. Status: ${status}`);
        this.pruneScenarioBuildArtifactsByCache();
        const runArtifacts = this.buildRunArtifactsState();

        webview.postMessage({
            command: 'loadInitialState',
            tabData: tabDataForUI, // Передаем отфильтрованные и сгруппированные данные для UI
            states: states,
            runArtifacts,
            settings: {
                assemblerEnabled: assemblerEnabled,
                switcherEnabled: switcherEnabled,
                driveFeaturesEnabled: driveFeaturesEnabled,
                firstLaunchFolderExists: firstLaunchFolderExists,
                buildInProgress: this._isBuildInProgress
            },
            error: !this._testCache ? status : undefined // Ошибка, если _testCache пуст
        });
        // Always enable refresh button, but only enable other controls if there are tests and no build is running
        const hasTests = !!this._testCache && testsForPhaseSwitcherCount > 0;
        if (this._isBuildInProgress) {
            webview.postMessage({
                command: 'updateStatus',
                text: this.t('Building tests in progress...'),
                enableControls: false,
                refreshButtonEnabled: false,
                target: 'main'
            });
            webview.postMessage({
                command: 'updateStatus',
                text: this.t('Building tests in progress...'),
                enableControls: false,
                refreshButtonEnabled: false,
                target: 'assemble'
            });
        } else {
            webview.postMessage({ command: 'updateStatus', text: status, enableControls: hasTests });
        }
        
        // Explicitly enable refresh button if there are no tests
        if (!hasTests && !this._isBuildInProgress) {
            webview.postMessage({ command: 'setRefreshButtonState', enabled: true });
        }
        
        // Генерируем событие с ПОЛНЫМ кэшем для других компонентов (например, CompletionProvider)
        this._onDidUpdateTestCache.fire(this._testCache);
    }

    /**
     * Builds 1C:Enterprise startup parameters based on configuration settings
     */
    private buildStartupParams(emptyIbPath: string): string[] {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const startupParameters = config.get<string>('startupParams.parameters') || '/L en /DisableStartupMessages /DisableStartupDialogs';

        const params = [
            "ENTERPRISE",
            `/IBConnectionString`, `"File=${emptyIbPath};"`
        ];

        // Add custom startup parameters (split by space and filter empty strings)
        if (startupParameters.trim()) {
            const customParams = startupParameters.trim().split(/\s+/).filter(p => p.length > 0);
            params.push(...customParams);
            console.log(`[PhaseSwitcherProvider] ${this.t('Using startup parameters: {0}', startupParameters.trim())}`);
        } else {
            console.log(`[PhaseSwitcherProvider] ${this.t('Using default startup parameters')}`);
        }

        return params;
    }

    /**
     * Gets project structure paths from configuration
     */
    private getProjectPaths(workspaceRootUri: vscode.Uri) {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const firstLaunchFolderSetting = (config.get<string>('paths.firstLaunchFolder') || '').trim();
        const firstLaunchFolder = firstLaunchFolderSetting.length > 0
            ? (path.isAbsolute(firstLaunchFolderSetting)
                ? vscode.Uri.file(firstLaunchFolderSetting)
                : vscode.Uri.joinPath(workspaceRootUri, firstLaunchFolderSetting))
            : null;

        return {
            buildScenarioBddEpf: vscode.Uri.joinPath(workspaceRootUri, config.get<string>('paths.buildScenarioBddEpf') || 'build/BuildScenarioBDD.epf'),
            yamlSourceDirectory: path.join(workspaceRootUri.fsPath, config.get<string>('paths.yamlSourceDirectory') || 'tests/RegressionTests/yaml'),
            disabledTestsDirectory: vscode.Uri.joinPath(workspaceRootUri, config.get<string>('paths.disabledTestsDirectory') || 'RegressionTests_Disabled/Yaml/Drive'),
            firstLaunchFolder,
            etalonDriveDirectory: 'tests'
        };
    }

    private resolveBuildPathUri(workspaceRootUri: vscode.Uri): vscode.Uri {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const buildPathSetting = (config.get<string>('assembleScript.buildPath') || '').trim();

        if (buildPathSetting && path.isAbsolute(buildPathSetting)) {
            return vscode.Uri.file(buildPathSetting);
        }

        const relativeBuildPath = buildPathSetting || '.vscode/1cdrive_build';
        return vscode.Uri.joinPath(workspaceRootUri, relativeBuildPath);
    }

    private async restoreScenarioBuildArtifactsFromDiskIfNeeded(workspaceRootUri: vscode.Uri): Promise<void> {
        if (this._startupArtifactsRestoreAttempted) {
            return;
        }
        if (this._scenarioBuildArtifacts.size > 0) {
            return;
        }
        if (!this._testCache || this._testCache.size === 0) {
            return;
        }
        this._startupArtifactsRestoreAttempted = true;

        const buildRootUri = this.resolveBuildPathUri(workspaceRootUri);
        try {
            await vscode.workspace.fs.stat(buildRootUri);
        } catch {
            return;
        }

        let featureFiles: vscode.Uri[] = [];
        try {
            const featurePattern = new vscode.RelativePattern(buildRootUri, '**/*.feature');
            featureFiles = await vscode.workspace.findFiles(featurePattern, '**/node_modules/**');
        } catch (error) {
            console.warn('[PhaseSwitcherProvider] Failed to discover feature artifacts during startup restore:', error);
            return;
        }

        if (featureFiles.length === 0) {
            return;
        }

        await this.updateScenarioBuildArtifacts(featureFiles, buildRootUri);
        if (this._scenarioBuildArtifacts.size === 0) {
            return;
        }

        this._staleBuiltScenarioNames = new Set(this._scenarioBuildArtifacts.keys());
        this._scenarioExecutionStates.clear();
        this._scenarioLastLaunchContexts.clear();
    }

    /**
     * Builds СборкаТекстовСценариев /C command with custom parameters and ErrorFolder
     */
    private buildBuildScenarioBddCommand(jsonParamsPath: string, resultFilePath: string, logFilePath: string, errorFolderPath: string): string {
        // Ensure ErrorFolder path ends with a slash
        const errorFolderWithSlash = errorFolderPath.endsWith(path.sep) ? errorFolderPath : errorFolderPath + path.sep;

        const command = `СобратьСценарии;JsonParams=${jsonParamsPath};ResultFile=${resultFilePath};LogFile=${logFilePath};ErrorFolder=${errorFolderWithSlash}`;

        return `/C"${command}"`;
    }

    /**
     * Ensures BuildErrors folder exists and is empty
     */
    private async prepareBuildErrorsFolder(buildPathUri: vscode.Uri, outputChannel: vscode.OutputChannel): Promise<vscode.Uri> {
        const buildErrorsPathUri = vscode.Uri.joinPath(buildPathUri, 'BuildErrors');
        
        try {
            // Try to stat the directory to see if it exists
            await vscode.workspace.fs.stat(buildErrorsPathUri);
            
            // Directory exists, clear its contents
            this.outputAdvanced(outputChannel, this.t('Clearing BuildErrors folder: {0}', buildErrorsPathUri.fsPath));
            const existingFiles = await vscode.workspace.fs.readDirectory(buildErrorsPathUri);
            for (const [name, type] of existingFiles) {
                const itemUri = vscode.Uri.joinPath(buildErrorsPathUri, name);
                if (type === vscode.FileType.File) {
                    await vscode.workspace.fs.delete(itemUri);
                } else if (type === vscode.FileType.Directory) {
                    await vscode.workspace.fs.delete(itemUri, { recursive: true });
                }
            }
        } catch (error: any) {
            if (error.code === 'FileNotFound' || error.code === 'ENOENT') {
                // Directory doesn't exist, create it
                this.outputAdvanced(outputChannel, this.t('Creating BuildErrors folder: {0}', buildErrorsPathUri.fsPath));
                await vscode.workspace.fs.createDirectory(buildErrorsPathUri);
            } else {
                throw error;
            }
        }
        
        return buildErrorsPathUri;
    }

    /**
     * Checks BuildErrors folder for error files and notifies user if errors are found
     * @returns true if errors were found, false if build was successful
     */
    private async checkBuildErrors(buildErrorsPathUri: vscode.Uri, outputChannel: vscode.OutputChannel): Promise<{hasErrors: boolean, junitFileUri?: vscode.Uri, errorCount?: number}> {
        try {
            const errorFiles = await vscode.workspace.fs.readDirectory(buildErrorsPathUri);
            
            if (errorFiles.length === 0) {
                return {hasErrors: false}; // No errors found
            }

            // outputChannel.appendLine(this.t('Build errors detected: {0} error files found', errorFiles.length.toString()));

            // Look for JUnit XML files specifically
            const junitFiles = errorFiles.filter(([name, type]) => 
                type === vscode.FileType.File && name.toLowerCase().includes('junit') && name.toLowerCase().endsWith('.xml')
            );

            if (junitFiles.length > 0) {
                // Parse the first JUnit file to check if there are actual failures
                const junitFileName = junitFiles[0][0];
                const junitFileUri = vscode.Uri.joinPath(buildErrorsPathUri, junitFileName);
                
                // Read and check the XML content first
                const junitContent = Buffer.from(await vscode.workspace.fs.readFile(junitFileUri)).toString('utf-8');
                
                // Check if there are any actual failures in the XML
                const testsuiteMatch = junitContent.match(/<testsuites[^>]*failures="(\d+)"[^>]*>/);
                const totalFailures = testsuiteMatch ? parseInt(testsuiteMatch[1], 10) : 0;
                
                if (totalFailures === 0) {
                    // No actual failures, just an empty XML file
                    return {hasErrors: false};
                }
                
                // There are real failures, parse them
                const errorCount = await this.parseAndShowJunitErrors(junitFileUri, outputChannel, false); // Don't show notification here
                return {hasErrors: true, junitFileUri, errorCount}; // Return status, file path, and error count
            } else {
                // Show generic error message for non-JUnit files
                const fileNames = errorFiles.map(([name]) => name).join(', ');
                const errorMessage = this.t('Build failed with errors. Check error files in BuildErrors folder: {0}', fileNames);
                
                vscode.window.showErrorMessage(errorMessage, this.t('Open BuildErrors Folder')).then(selection => {
                    if (selection === this.t('Open BuildErrors Folder')) {
                        vscode.commands.executeCommand('revealFileInOS', buildErrorsPathUri);
                    }
                });
                return {hasErrors: true}; // Errors found but no JUnit file
            }

        } catch (error: any) {
            this.outputError(outputChannel, this.t('Error checking build errors: {0}', error.message || error), error);
            return {hasErrors: false}; // Assume no errors if we can't check
        }
    }

    /**
     * Parses JUnit XML file and shows detailed error information
     */
    private async parseAndShowJunitErrors(junitFileUri: vscode.Uri, outputChannel: vscode.OutputChannel, showNotification: boolean = true): Promise<number> {
        try {
            const junitContent = Buffer.from(await vscode.workspace.fs.readFile(junitFileUri)).toString('utf-8');
            
            // Simple XML parsing to extract failure information
            const failureMatches = junitContent.match(/<failure[^>]*message="([^"]*)"[^>]*>(.*?)<\/failure>/gs);
            
            if (!failureMatches || failureMatches.length === 0) {
                this.outputAdvanced(outputChannel, this.t('No detailed error information found in JUnit file.'));
                return 0;
            }

            // Extract failed test names and scenario codes
            const failedTests: {testName: string, scenarioCode: string}[] = [];
            const testsuiteMatches = junitContent.match(/<testsuite[^>]*name="([^"]*)"[^>]*failures="[1-9]\d*"[^>]*>/g);
            
            if (testsuiteMatches) {
                for (const testsuiteMatch of testsuiteMatches) {
                    // Extract test name and remove "Компиляция настройки сценария" prefix
                    const nameMatch = testsuiteMatch.match(/name="(?:Компиляция настройки сценария )?([^"]*)"/);
                    if (!nameMatch) continue;
                    
                    const testName = nameMatch[1];
                    
                    // Find the failure element within this testsuite to extract scenario code and error
                    const testsuiteStartIndex = junitContent.indexOf(testsuiteMatch);
                    const testsuiteEndIndex = junitContent.indexOf('</testsuite>', testsuiteStartIndex);
                    const testsuiteContent = junitContent.substring(testsuiteStartIndex, testsuiteEndIndex);
                    
                    // Extract failure message from this specific testsuite
                    const failureMatch = testsuiteContent.match(/<failure[^>]*message="([^"]*)"[^>]*>/);
                    if (failureMatch) {
                        const message = failureMatch[1];
                        
                        // Extract scenario code (Код: <Item>) - look for the last occurrence
                        let scenarioCode = '';
                        const codeMatches = message.match(/Код:\s*&lt;([^&]*)&gt;/g);
                        if (codeMatches && codeMatches.length > 0) {
                            const lastCodeMatch = codeMatches[codeMatches.length - 1].match(/Код:\s*&lt;([^&]*)&gt;/);
                            if (lastCodeMatch) {
                                scenarioCode = lastCodeMatch[1];
                            }
                        }
                        
                        // No need to extract detailed error message - user can check XML file for details
                        
                        failedTests.push({
                            testName,
                            scenarioCode
                        });
                    } else {
                        // Fallback if no detailed failure message found
                        failedTests.push({
                            testName,
                            scenarioCode: ''
                        });
                    }
                }
            }

            if (failedTests.length > 0) {
                this.outputInfo(outputChannel, this.t('Build failed with {0} compilation error(s):', failedTests.length.toString()));
                failedTests.forEach((failedTest, index) => {
                    const scenarioInfo = failedTest.scenarioCode ? ` - Scenario ${failedTest.scenarioCode}` : '';
                outputChannel.appendLine(`${index + 1}. ${failedTest.testName}${scenarioInfo}`);
                });
                
                if (showNotification) {
                    vscode.window.showErrorMessage(
                        this.t('Build failed with {0} compilation errors. Open error file for details.', failedTests.length.toString()),
                        this.t('Open Error File'),
                        this.t('Show Output')
                    ).then(selection => {
                        if (selection === this.t('Open Error File')) {
                            vscode.commands.executeCommand('vscode.open', junitFileUri);
                        } else if (selection === this.t('Show Output')) {
                            outputChannel.show();
                        }
                    });
                }
                
                return failedTests.length;
            }
            
            // If no failed tests found, return 0
            return 0;

        } catch (error: any) {
            this.outputError(outputChannel, this.t('Error parsing JUnit file: {0}', error.message || error), error);
            return 0;
        }
    }

    private async openBuiltFeatureFiles(featureFiles: vscode.Uri[]): Promise<void> {
        if (!featureFiles.length) {
            return;
        }

        if (featureFiles.length === 1) {
            const doc = await vscode.workspace.openTextDocument(featureFiles[0]);
            await vscode.window.showTextDocument(doc, { preview: false });
            return;
        }

        let first = true;
        for (const featureFile of featureFiles) {
            const doc = await vscode.workspace.openTextDocument(featureFile);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: !first });
            first = false;
        }
    }

    private async _handleRunAssembleScriptTypeScript(recordGLValue: string): Promise<void> {
        const methodStartLog = "[PhaseSwitcherProvider:_handleRunAssembleScriptTypeScript]";
        console.log(`${methodStartLog} Starting with RecordGL=${recordGLValue}`);
        const outputChannel = this.getOutputChannel();
        outputChannel.clear();
        
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const showOutputPanel = config.get<boolean>('assembleScript.showOutputPanel');

        if (showOutputPanel) {
            outputChannel.show(true);
        }

        const webview = this._view?.webview;
        if (!webview) {
            console.error(`${methodStartLog} Cannot run script, view is not available.`);
            vscode.window.showErrorMessage(this.t('Failed to run assembly: Panel is not active.'));
            return;
        }

        const sendStatus = (text: string, enableControls: boolean = false, target: 'main' | 'assemble' = 'assemble', refreshButtonEnabled?: boolean) => {
            if (this._view?.webview) {
                this._view.webview.postMessage({ 
                    command: 'updateStatus', 
                    text: text, 
                    enableControls: enableControls, 
                    target: target,
                    refreshButtonEnabled: refreshButtonEnabled 
                });
            } else {
                console.warn(`${methodStartLog} Cannot send status, view is not available. Status: ${text}`);
            }
        };
        
        this._isBuildInProgress = true;
        this._buildCancellationRequested = false;
        this._activeBuildProcesses.clear();
        if (this._view?.webview) {
            this._view.webview.postMessage({ command: 'buildStateChanged', inProgress: true });
        }
        sendStatus(this.t('Building tests in progress...'), false, 'assemble', false);

        try {
            await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: this.t('Building .feature files'),
            cancellable: true
        }, async (progress, token) => {
            token.onCancellationRequested(() => {
                void this.requestBuildCancellation();
            });
            const ensureBuildNotCancelled = () => this.throwIfBuildCancellationRequested();
            let featureFileDirUri: vscode.Uri; // Объявляем здесь, чтобы была доступна в конце
            try {
                progress.report({ increment: 0, message: this.t('Preparing...') });
                this.outputInfo(outputChannel, this.t('Starting build process...'));
                ensureBuildNotCancelled();

                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders?.length) {
                    throw new Error(this.t('Project folder must be opened.'));
                }
                const workspaceRootUri = workspaceFolders[0].uri;
                const workspaceRootPath = workspaceRootUri.fsPath;

                const oneCPath_raw = config.get<string>('paths.oneCEnterpriseExe');
                if (!oneCPath_raw) {
                    sendStatus(this.t('Build error.'), true, 'assemble', true);
                    vscode.window.showErrorMessage(
                        this.t('Path to 1C:Enterprise (1cv8.exe) is not specified in settings.'),
                        this.t('Open Settings')
                    ).then(selection => {
                        if (selection === this.t('Open Settings')) {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
                        }
                    });
                    return;
                }
                if (!fs.existsSync(oneCPath_raw)) {
                    sendStatus(this.t('Build error.'), true, 'assemble', true);
                    vscode.window.showErrorMessage(
                        this.t('1C:Enterprise file (1cv8.exe) not found at path: {0}', oneCPath_raw),
                        this.t('Open Settings')
                    ).then(selection => {
                        if (selection === this.t('Open Settings')) {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
                        }
                    });
                    return;
                }
                const oneCExePath = oneCPath_raw;

                const emptyIbPath_raw = config.get<string>('paths.emptyInfobase');
                if (!emptyIbPath_raw) {
                    sendStatus(this.t('Build error.'), true, 'assemble', true);
                    vscode.window.showErrorMessage(
                        this.t('Path to empty infobase is not specified in settings.'),
                        this.t('Open Settings')
                    ).then(selection => {
                        if (selection === this.t('Open Settings')) {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.emptyInfobase');
                        }
                    });
                    return;
                }
                if (!fs.existsSync(emptyIbPath_raw)) {
                    sendStatus(this.t('Build error.'), true, 'assemble', true);
                    vscode.window.showErrorMessage(
                        this.t('Empty infobase directory not found at path: {0}', emptyIbPath_raw),
                        this.t('Open Settings')
                    ).then(selection => {
                        if (selection === this.t('Open Settings')) {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.emptyInfobase');
                        }
                    });
                    return;
                }
                
                const absoluteBuildPathUri = this.resolveBuildPathUri(workspaceRootUri);
                const absoluteBuildPath = absoluteBuildPathUri.fsPath;
                
                await vscode.workspace.fs.createDirectory(absoluteBuildPathUri);
                this.outputAdvanced(outputChannel, this.t('Build directory ensured: {0}', absoluteBuildPath));

                progress.report({ increment: 10, message: this.t('Preparing parameters...') });
                const localSettingsPath = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_parameters.json');
                
                // Генерируем yaml_parameters.json из сохранённых параметров через Build Scenario Parameters Manager
                const { YamlParametersManager } = await import('./yamlParametersManager.js');
                const yamlParametersManager = YamlParametersManager.getInstance(this._context);
                await yamlParametersManager.createYamlParametersFile(localSettingsPath.fsPath);
                
                this.outputAdvanced(outputChannel, this.t('yaml_parameters.json generated at {0}', localSettingsPath.fsPath));

                // Получаем пути проекта
                const projectPaths = this.getProjectPaths(workspaceRootUri);

                progress.report({ increment: 40, message: this.t('Building YAML in feature...') });
                this.outputInfo(outputChannel, this.t('Building YAML files to feature file...'));
                const yamlBuildLogFileUri = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_build_log.txt');
                const yamlBuildResultFileUri = vscode.Uri.joinPath(absoluteBuildPathUri, 'yaml_build_result.txt');
                const buildScenarioBddEpfPath = projectPaths.buildScenarioBddEpf.fsPath;

                // Prepare BuildErrors folder (create if missing, clear if exists)
                const buildErrorsPathUri = await this.prepareBuildErrorsFolder(absoluteBuildPathUri, outputChannel);

                const yamlBuildParams = [
                    ...this.buildStartupParams(emptyIbPath_raw),
                    `/Execute`, `"${buildScenarioBddEpfPath}"`,
                    this.buildBuildScenarioBddCommand(localSettingsPath.fsPath, yamlBuildResultFileUri.fsPath, yamlBuildLogFileUri.fsPath, buildErrorsPathUri.fsPath)
                ];
                ensureBuildNotCancelled();
                // BuildScenarioBdd rewrites output artifacts, so stale run buttons must be removed immediately.
                this.clearScenarioRunArtifactsAndNotify();
                await this.execute1CProcess(oneCExePath, yamlBuildParams, workspaceRootPath, "СборкаТекстовСценариев.epf", {
                    trackAsBuildProcess: true,
                    completionMarker: { filePath: yamlBuildResultFileUri.fsPath, successContent: "0", timeoutMs: 600000 }
                });
                ensureBuildNotCancelled();
                
                try {
                    const buildResultContent = Buffer.from(await vscode.workspace.fs.readFile(yamlBuildResultFileUri)).toString('utf-8');
                    if (!buildResultContent.includes("0")) { 
                        const buildLogContent = Buffer.from(await vscode.workspace.fs.readFile(yamlBuildLogFileUri)).toString('utf-8');
                this.outputAdvanced(outputChannel, "СборкаТекстовСценариев Error Log:");
                if (this.isAdvancedOutputLoggingEnabled()) {
                    outputChannel.appendLine(buildLogContent);
                }
                        throw new Error(this.t('YAML build error. See log: {0}', yamlBuildLogFileUri.fsPath));
                    }
                } catch (e: any) {
                     if (e.code === 'FileNotFound') throw new Error(this.t('Build result file {0} not found after waiting.', yamlBuildResultFileUri.fsPath));
                     throw e; 
                }
                this.outputInfo(outputChannel, this.t('YAML build successful.'));

                progress.report({ increment: 70, message: this.t('Writing parameters...') });
                const vanessaErrorLogsDir = vscode.Uri.joinPath(absoluteBuildPathUri, "vanessa_error_logs");
                await vscode.workspace.fs.createDirectory(vanessaErrorLogsDir);

                this.outputInfo(outputChannel, this.t('Writing parameters from pipeline into tests...'));
                
                // Получаем ModelDBid из параметров YAML для определения правильного пути к сценариям
                const parameters = await yamlParametersManager.loadParameters();
                const modelDBidParam = parameters.find(p => p.key === "ModelDBid");
                const modelDBid = modelDBidParam ? modelDBidParam.value : "EtalonDrive"; // Значение по умолчанию
                
                // Определяем путь к сценариям с учетом ModelDBid
                // Если ModelDBid указан и не пустой, добавляем его к пути
                const etalonDrivePath = modelDBid && modelDBid.trim() !== ""
                    ? path.join(projectPaths.etalonDriveDirectory, modelDBid)
                    : projectPaths.etalonDriveDirectory;
                
                this.outputAdvanced(outputChannel, this.t('Using ModelDBid: {0}, etalonDrivePath: {1}', modelDBid, etalonDrivePath));
                
                featureFileDirUri = vscode.Uri.joinPath(absoluteBuildPathUri, etalonDrivePath);
                const featureFilesPattern = new vscode.RelativePattern(featureFileDirUri, '**/*.feature');
                const featureFiles = await vscode.workspace.findFiles(featureFilesPattern);
                
                this.outputAdvanced(outputChannel, this.t('Feature files directory: {0}', featureFileDirUri.fsPath));
                this.outputInfo(outputChannel, this.t('Found {0} feature file(s):', featureFiles.length.toString()));
                if (this.isAdvancedOutputLoggingEnabled()) {
                    const featureNames = featureFiles.map(fileUri => path.basename(fileUri.fsPath));
                    const maxVisibleNames = 10;
                    featureNames.slice(0, maxVisibleNames).forEach((fileName, index) => {
                        outputChannel.appendLine(`${index + 1}. ${fileName}`);
                    });
                    if (featureNames.length > maxVisibleNames) {
                        outputChannel.appendLine(this.t('... and {0} more', String(featureNames.length - maxVisibleNames)));
                    }
                }

                ensureBuildNotCancelled();
                await this.updateScenarioBuildArtifacts(featureFiles, absoluteBuildPathUri);
                await this.ensureUniqueVanessaRuntimePathsForArtifacts(outputChannel, workspaceRootPath);
                this.sendRunArtifactsStateToWebview();



                if (featureFiles.length > 0) {
                    const azureProjectName = process.env.SYSTEM_TEAM_PROJECT || ''; 

                    for (const fileUri of featureFiles) {
                        ensureBuildNotCancelled();
                        let fileContent = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf-8');
                        fileContent = fileContent.replace(/RecordGLAccountsParameterFromPipeline/g, recordGLValue);
                        fileContent = fileContent.replace(/AzureProjectNameParameterFromPipeline/g, azureProjectName);
                        fileContent = fileContent.replace(/DriveTradeParameterFromPipeline/g, 'No');
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fileContent, 'utf-8'));
                    }
                }
                
                progress.report({ increment: 90, message: this.t('Correcting files...') });
                ensureBuildNotCancelled();
                // outputChannel.appendLine(this.t('Starting Administrator replacement processing...'));
                const companyTestFeaturePath = vscode.Uri.joinPath(featureFileDirUri, '001_Company_tests.feature');
                // outputChannel.appendLine(this.t('Target file path: {0}', companyTestFeaturePath.fsPath));
                
                try {
                    await vscode.workspace.fs.stat(companyTestFeaturePath);
                    this.outputAdvanced(outputChannel, this.t('  ✓ File found, removing "Administrator"...'));
                    
                    const companyTestContentBytes = await vscode.workspace.fs.readFile(companyTestFeaturePath);
                    let companyTestContent = Buffer.from(companyTestContentBytes).toString('utf-8');

                    const originalContent = companyTestContent;
                    companyTestContent = companyTestContent.replace(/using "Administrator"/g, 'using ""');
                    
                    if (originalContent !== companyTestContent) {
                        await vscode.workspace.fs.writeFile(companyTestFeaturePath, Buffer.from(companyTestContent, 'utf-8'));
                        // outputChannel.appendLine(this.t('  ✓ Administrator replacement completed successfully'));
                    } else {
                        // outputChannel.appendLine(this.t('  - No "Administrator" found in file, no changes needed'));
                    }

                } catch (error: any) {
                    if (error.code === 'FileNotFound') {
                        // outputChannel.appendLine(this.t('  ✗ File not found: {0}', companyTestFeaturePath.fsPath));
                    } else {
                        // outputChannel.appendLine(this.t('--- WARNING: Error applying correction to {0}: {1} ---', companyTestFeaturePath.fsPath, error.message || error));
                    }
                }

                progress.report({ increment: 95, message: this.t('Checking for build errors...') });
                ensureBuildNotCancelled();
 
                // Log built scenarios
                if (featureFiles.length > 0) {
                    this.outputInfo(outputChannel, this.t('Successfully built {0} scenario(s):', featureFiles.length.toString()));
                    featureFiles.forEach((fileUri, index) => {
                        const fileName = path.basename(fileUri.fsPath, '.feature');
                        if (index < 10) {
                            outputChannel.appendLine(`${index + 1}. ${fileName}`);
                        }
                    });
                    if (featureFiles.length > 10) {
                        outputChannel.appendLine(this.t('... and {0} more', String(featureFiles.length - 10)));
                    }
                } else {
                    this.outputInfo(outputChannel, this.t('No scenarios were built.'));
                }
                
                // Check for build errors after showing successes
                const buildResult = await this.checkBuildErrors(buildErrorsPathUri, outputChannel);
                const hasErrors = buildResult.hasErrors;
                const junitFileUri = buildResult.junitFileUri;
                const errorCount = buildResult.errorCount || 0;
                
                progress.report({ increment: 100, message: this.t('Completed!') });
                ensureBuildNotCancelled();
                
                const scenariosBuilt = featureFiles.length > 0;
                const openFeatureButtonLabel = featureFiles.length === 1
                    ? this.t('Open feature file')
                    : this.t('Open feature files');
                
                if (hasErrors && scenariosBuilt) {
                    // Has errors but some scenarios were built
                    this.outputInfo(outputChannel, this.t('Build process completed with errors, but {0} scenario(s) were built.', featureFiles.length.toString()));
                    if (junitFileUri) {
                        this.outputAdvanced(outputChannel, this.t('For more details, check {0}', junitFileUri.fsPath));
                    }
                    sendStatus(this.t('Build completed with errors.'), true, 'assemble', true);
                    
                    // Prepare buttons based on whether JUnit file is available
                    const buttons = [openFeatureButtonLabel, this.t('Open folder'), this.t('Show Output')];
                    if (junitFileUri) {
                        buttons.push(this.t('Open Error File'));
                    }
                    
                    vscode.window.showWarningMessage(
                        this.t('Build completed: {0} successful, {1} errors.', featureFiles.length.toString(), errorCount.toString()),
                        ...buttons
                    ).then(selection => {
                        if (selection === openFeatureButtonLabel) {
                            this.openBuiltFeatureFiles(featureFiles).catch(error => {
                                console.error('[PhaseSwitcherProvider] Failed to open feature files:', error);
                            });
                        } else if (selection === this.t('Open folder')) {
                            vscode.commands.executeCommand('kotTestToolkit.openBuildFolder', featureFileDirUri.fsPath);
                        } else if (selection === this.t('Show Output')) {
                            outputChannel.show();
                        } else if (selection === this.t('Open Error File') && junitFileUri) {
                            vscode.commands.executeCommand('vscode.open', junitFileUri);
                        }
                    });
                } else if (hasErrors && !scenariosBuilt) {
                    // Has errors and no scenarios built
                    this.outputInfo(outputChannel, this.t('Build process failed - no scenarios were built.'));
                    if (junitFileUri) {
                        this.outputAdvanced(outputChannel, this.t('For more details, check {0}', junitFileUri.fsPath));
                    }
                    sendStatus(this.t('Build failed - no scenarios built.'), true, 'assemble', true);
                    
                    // Show single simplified notification for complete failure
                    const buttons = [this.t('Show Output')];
                    if (junitFileUri) {
                        buttons.push(this.t('Open Error File'));
                    }
                    
                    vscode.window.showErrorMessage(
                        this.t('Build failed: {0} errors.', errorCount.toString()),
                        ...buttons
                    ).then(selection => {
                        if (selection === this.t('Show Output')) {
                            outputChannel.show();
                        } else if (selection === this.t('Open Error File') && junitFileUri) {
                            vscode.commands.executeCommand('vscode.open', junitFileUri);
                        }
                    });
                } else if (!hasErrors && scenariosBuilt) {
                    // No errors and scenarios built - perfect success
                    this.outputInfo(outputChannel, this.t('Build process completed successfully with {0} scenario(s).', featureFiles.length.toString()));
                    sendStatus(this.t('Tests successfully built.'), true, 'assemble', true); 
                vscode.window.showInformationMessage(
                        this.t('Build completed: {0} successful.', featureFiles.length.toString()),
                        openFeatureButtonLabel,
                        this.t('Open folder')
                ).then(selection => {
                        if (selection === openFeatureButtonLabel) {
                            this.openBuiltFeatureFiles(featureFiles).catch(error => {
                                console.error('[PhaseSwitcherProvider] Failed to open feature files:', error);
                            });
                        } else if (selection === this.t('Open folder')) {
                        vscode.commands.executeCommand('kotTestToolkit.openBuildFolder', featureFileDirUri.fsPath);
                    }
                });
                } else {
                    // No errors but no scenarios built either (strange case)
                    this.outputInfo(outputChannel, this.t('Build process completed but no scenarios were found.'));
                    sendStatus(this.t('Build completed - no scenarios found.'), true, 'assemble', true);
                    vscode.window.showWarningMessage(this.t('Build completed but no scenarios were found.'));
                }

            } catch (error: any) {
                if (this.isBuildCancelledError(error)) {
                    this.outputInfo(outputChannel, this.t('Build cancelled.'));
                    sendStatus(this.t('Build cancelled.'), true, 'assemble', true);
                    vscode.window.showInformationMessage(this.t('Build cancelled by user.'));
                    return;
                }

                console.error(`${methodStartLog} Error:`, error);
                const errorMessage = error.message || String(error);
                this.outputError(outputChannel, this.t('Build error: {0}', errorMessage), error);

                const logFileMatch = errorMessage.match(/См\. лог:\s*(.*)/);
                if (logFileMatch && logFileMatch[1]) {
                    const logFilePath = logFileMatch[1].trim();
                    vscode.window.showErrorMessage(this.t('Build error.'), this.t('Open log'))
                        .then(selection => {
                            if (selection === this.t('Open log')) {
                                vscode.workspace.openTextDocument(vscode.Uri.file(logFilePath)).then(doc => {
                                    vscode.window.showTextDocument(doc);
                                });
                            }
                        });
                } else {
                    vscode.window.showErrorMessage(this.t('Build error: {0}. See Output.', errorMessage));
                }
                
                sendStatus(this.t('Build error.'), true, 'assemble', true); 
            }
        });
        } finally {
            this._isBuildInProgress = false;
            this._buildCancellationRequested = false;
            this._activeBuildProcesses.clear();
            if (this._view?.webview) {
                this._view.webview.postMessage({ command: 'buildStateChanged', inProgress: false });
            }
        }
    }

    private async execute1CProcess( 
        exePath: string, 
        args: string[], 
        cwd: string, 
        processName: string,
        options?: Execute1CProcessOptions
    ): Promise<void> {
        const outputChannel = this.getOutputChannel();
        const completionMarker = options?.completionMarker;
        const trackAsBuildProcess = options?.trackAsBuildProcess === true;

        if (trackAsBuildProcess) {
            this.throwIfBuildCancellationRequested();
        }
        
        if (process.platform === 'darwin' && completionMarker && completionMarker.filePath) {
            try {
                await vscode.workspace.fs.delete(vscode.Uri.file(completionMarker.filePath), { useTrash: false });
                this.outputAdvanced(outputChannel, `Deleted previous marker file (if existed): ${completionMarker.filePath}`);
            } catch (e: any) {
                if (e.code === 'FileNotFound') {
                    this.outputAdvanced(outputChannel, `No previous marker file to delete: ${completionMarker.filePath}`);
                } else {
                    this.outputAdvanced(outputChannel, `Warning: Could not delete marker file ${completionMarker.filePath}: ${e.message}`);
                }
            }
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let pollInterval: NodeJS.Timeout | undefined;

            const finishResolve = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (pollInterval) {
                    clearInterval(pollInterval);
                }
                resolve();
            };
            const finishReject = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (pollInterval) {
                    clearInterval(pollInterval);
                }
                reject(error);
            };

            this.outputInfo(outputChannel, this.t('Launching process: {0}', processName));
            this.outputAdvanced(outputChannel, `Executing 1C process: ${processName} with args: ${args.join(' ')}`);
            const command = exePath.includes(' ') && !exePath.startsWith('"') ? `"${exePath}"` : exePath;
            
            const child = cp.spawn(command, args, {
                cwd: cwd,
                shell: true, 
                windowsHide: true
            });
            if (trackAsBuildProcess) {
                this._activeBuildProcesses.add(child);
            }

            let stdoutData = '';
            let stderrData = '';

            child.stdout?.on('data', (data) => { 
                stdoutData += data.toString();
            });
            child.stderr?.on('data', (data) => { 
                stderrData += data.toString();
            });

            child.on('error', (error) => {
                if (trackAsBuildProcess) {
                    this._activeBuildProcesses.delete(child);
                }
                if (trackAsBuildProcess && this._buildCancellationRequested) {
                    finishReject(new BuildCancelledError(this.t('Build was cancelled by user.')));
                    return;
                }
                this.outputError(outputChannel, this.t('Error starting process {0}: {1}', processName, error.message), error);
                finishReject(new Error(this.t('Error starting process {0}: {1}', processName, error.message)));
            });

            const handleClose = (code: number | null) => {
                if (trackAsBuildProcess) {
                    this._activeBuildProcesses.delete(child);
                }
                if (trackAsBuildProcess && this._buildCancellationRequested) {
                    finishReject(new BuildCancelledError(this.t('Build was cancelled by user.')));
                    return;
                }
                this.outputAdvanced(outputChannel, `1C Process ${processName} (launcher) finished with exit code ${code}`);
                const isAcceptedCode = code === 0 || (process.platform === 'darwin' && code === 255);
                if (!isAcceptedCode) {
                    this.appendProcessOutputTail(outputChannel, processName, stdoutData, stderrData);
                    const stderrText = stderrData.trim();
                    const stdoutText = stdoutData.trim();
                    const details = stderrText || stdoutText || this.t('<empty output>');
                    finishReject(new Error(this.t('Process {0} (launcher) finished with code {1}. stderr: {2}', processName, String(code), details)));
                } else {
                    finishResolve();
                }
            };

            if (process.platform === 'darwin' && completionMarker) {
                this.outputAdvanced(outputChannel, `macOS detected. Will poll for completion marker: ${completionMarker.filePath}`);
                const startTime = Date.now();
                const timeoutMs = completionMarker.timeoutMs || 180000; 
                const checkIntervalMs = completionMarker.checkIntervalMs || 2000; 

                const checkCompletion = async () => {
                    if (trackAsBuildProcess && this._buildCancellationRequested) {
                        if (trackAsBuildProcess) {
                            this._activeBuildProcesses.delete(child);
                        }
                        finishReject(new BuildCancelledError(this.t('Build was cancelled by user.')));
                        return;
                    }

                    if (Date.now() - startTime > timeoutMs) {
                        this.outputError(outputChannel, this.t('Timeout waiting for process {0} completion by marker {1}', processName, completionMarker.filePath));
                        finishReject(new Error(this.t('Timeout waiting for process {0} completion by marker {1}', processName, completionMarker.filePath)));
                        return;
                    }

                    try {
                        await vscode.workspace.fs.stat(vscode.Uri.file(completionMarker.filePath!));
                        
                        if (completionMarker.successContent) {
                            const content = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(completionMarker.filePath!))).toString('utf-8');
                            if (content.includes(completionMarker.successContent)) {
                                if (trackAsBuildProcess) {
                                    this._activeBuildProcesses.delete(child);
                                }
                                finishResolve();
                            }
                        } else {
                            if (trackAsBuildProcess) {
                                this._activeBuildProcesses.delete(child);
                            }
                            finishResolve();
                        }
                    } catch (e: any) {
                        if (e.code !== 'FileNotFound') {
                            this.outputAdvanced(outputChannel, `Error checking marker file ${completionMarker.filePath}: ${e.message}. Continuing polling.`);
                        }
                    }
                };
                child.on('close', (code) => {
                    if (trackAsBuildProcess) {
                        this._activeBuildProcesses.delete(child);
                    }
                    this.outputAdvanced(outputChannel, `1C Launcher ${processName} exited with code ${code}. Polling for completion continues...`);
                });
                pollInterval = setInterval(checkCompletion, checkIntervalMs);
                checkCompletion(); 

            } else {
                child.on('close', handleClose);
            }
        });
    }

    private async execute1CProcessDetached(
        exePath: string,
        args: string[],
        cwd: string,
        processName: string
    ): Promise<void> {
        const outputChannel = this.getOutputChannel();
        this.outputInfo(outputChannel, this.t('Launching process: {0}', processName));
        this.outputAdvanced(outputChannel, `Executing detached 1C process: ${processName} with args: ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            try {
                const command = exePath.includes(' ') && !exePath.startsWith('"') ? `"${exePath}"` : exePath;
                const child = cp.spawn(command, args, {
                    cwd,
                    shell: true,
                    windowsHide: false,
                    detached: true,
                    stdio: 'ignore'
                });

                child.on('error', (error) => {
                    this.outputError(outputChannel, this.t('Error starting process {0}: {1}', processName, error.message), error);
                    reject(new Error(this.t('Error starting process {0}: {1}', processName, error.message)));
                });

                child.unref();
                this.outputAdvanced(outputChannel, `Detached process ${processName} started successfully.`);
                resolve();
            } catch (error: any) {
                reject(new Error(this.t('Error starting process {0}: {1}', processName, error?.message || String(error))));
            }
        });
    }

    /**
     * Группирует и сортирует данные тестов для отображения в Phase Switcher.
     * Использует только тесты, у которых есть tabName.
     */
    private _groupAndSortTestData(testCacheForUI: Map<string, TestInfo>): { [tabName: string]: TestInfo[] } {
        const grouped: { [tabName: string]: TestInfo[] } = {};
        if (!testCacheForUI) {
            return grouped;
        }

        for (const info of testCacheForUI.values()) {
            // Убедимся, что tabName существует и является строкой для группировки
            if (info.tabName && typeof info.tabName === 'string' && info.tabName.trim() !== "") {
                let finalUriString = '';
                if (info.yamlFileUri && typeof info.yamlFileUri.toString === 'function') {
                    finalUriString = info.yamlFileUri.toString();
                }
                const infoWithUriString = { ...info, yamlFileUriString: finalUriString };

                if (!grouped[info.tabName]) { grouped[info.tabName] = []; }
                grouped[info.tabName].push(infoWithUriString);
            }
        }

        for (const tabName in grouped) {
            grouped[tabName].sort((a, b) => {
                const orderA = a.order !== undefined ? a.order : Infinity;
                const orderB = b.order !== undefined ? b.order : Infinity;
                if (orderA !== orderB) {
                    return orderA - orderB;
                }
                return a.name.localeCompare(b.name);
            });
        }
        return grouped;
    }

    private getScenarioNamesByUri(uri: vscode.Uri): string[] {
        if (!this._testCache || this._testCache.size === 0) {
            return [];
        }

        const scenarioNames: string[] = [];
        for (const [scenarioName, testInfo] of this._testCache.entries()) {
            if (this.areUrisEqual(testInfo.yamlFileUri, uri)) {
                scenarioNames.push(scenarioName);
            }
        }
        return scenarioNames;
    }

    private getScenarioNamesRelatedToUri(uri: vscode.Uri): string[] {
        const names = new Set<string>(this.getScenarioNamesByUri(uri));
        if (!this._testCache || this._testCache.size === 0 || uri.scheme !== 'file') {
            return Array.from(names);
        }

        const scanDir = this.getScanDirAbsolutePath();
        if (!scanDir) {
            return Array.from(names);
        }

        const normalizedUriPath = path.resolve(uri.fsPath);
        for (const [scenarioName, info] of this._testCache.entries()) {
            const scenarioDir = path.resolve(path.join(scanDir, info.relativePath || ''));
            if (this.isPathInside(scenarioDir, normalizedUriPath)) {
                names.add(scenarioName);
            }
        }

        return Array.from(names);
    }

    private getScenarioNamesByArtifactSourceUri(uri: vscode.Uri): string[] {
        if (uri.scheme !== 'file' || this._scenarioBuildArtifacts.size === 0) {
            return [];
        }

        const normalizedUriPath = path.resolve(uri.fsPath);
        const names = new Set<string>();
        for (const [scenarioName, artifact] of this._scenarioBuildArtifacts.entries()) {
            if (artifact.sourceUri.scheme !== 'file') {
                continue;
            }

            const sourcePath = path.resolve(artifact.sourceUri.fsPath);
            const scenarioDir = path.dirname(sourcePath);
            if (normalizedUriPath === sourcePath || this.isPathInside(scenarioDir, normalizedUriPath)) {
                names.add(scenarioName);
            }
        }

        return Array.from(names);
    }

    private pruneScenarioBuildArtifactsByCache(): void {
        if (!this._scenarioBuildArtifacts.size) {
            return;
        }

        if (!this._testCache || this._testCache.size === 0) {
            this._scenarioBuildArtifacts.clear();
            this._staleBuiltScenarioNames.clear();
            this._scenarioExecutionStates.clear();
            this._scenarioLastLaunchContexts.clear();
            return;
        }

        for (const [scenarioName] of this._scenarioBuildArtifacts) {
            const scenarioInfo = this._testCache.get(scenarioName);
            if (!scenarioInfo) {
                this._scenarioBuildArtifacts.delete(scenarioName);
                this._staleBuiltScenarioNames.delete(scenarioName);
                this._scenarioExecutionStates.delete(scenarioName);
                this._scenarioLastLaunchContexts.delete(scenarioName);
                continue;
            }

            const artifact = this._scenarioBuildArtifacts.get(scenarioName);
            if (artifact) {
                artifact.sourceUri = scenarioInfo.yamlFileUri;
            }
        }
    }

    private buildCallersByCalleeFromCache(): Map<string, Set<string>> {
        const result = new Map<string, Set<string>>();
        if (!this._testCache) {
            return result;
        }

        for (const [callerName, testInfo] of this._testCache.entries()) {
            const calledScenarios = testInfo.nestedScenarioNames || [];
            for (const calledScenarioRaw of calledScenarios) {
                const calledScenario = calledScenarioRaw.trim();
                if (!calledScenario) {
                    continue;
                }
                const callers = result.get(calledScenario) || new Set<string>();
                callers.add(callerName);
                result.set(calledScenario, callers);
            }
        }
        return result;
    }

    private markBuiltArtifactsAsStale(changedScenarioNames: Iterable<string>): void {
        if (!this._scenarioBuildArtifacts.size) {
            return;
        }

        const callersByCallee = this.buildCallersByCalleeFromCache();
        const queue: string[] = [];
        const visited = new Set<string>();

        for (const scenarioName of changedScenarioNames) {
            const normalized = scenarioName.trim();
            if (!normalized) {
                continue;
            }
            queue.push(normalized);
        }

        while (queue.length > 0) {
            const scenarioName = queue.shift()!;
            if (visited.has(scenarioName)) {
                continue;
            }
            visited.add(scenarioName);

            if (this._scenarioBuildArtifacts.has(scenarioName)) {
                this._staleBuiltScenarioNames.add(scenarioName);
                const executionState = this._scenarioExecutionStates.get(scenarioName);
                if (executionState && executionState.status !== 'running' && executionState.status !== 'failed') {
                    this._scenarioExecutionStates.delete(scenarioName);
                }
            }

            const callers = callersByCallee.get(scenarioName);
            if (!callers) {
                continue;
            }
            for (const callerName of callers) {
                if (!visited.has(callerName)) {
                    queue.push(callerName);
                }
            }
        }
    }

    private setScenarioExecutionState(
        scenarioName: string,
        status: 'idle' | 'running' | 'passed' | 'failed',
        message?: string,
        runLogPath?: string
    ): void {
        if (status === 'idle') {
            if (this._scenarioExecutionStates.delete(scenarioName)) {
                this.sendRunArtifactsStateToWebview();
            }
            return;
        }

        this._scenarioExecutionStates.set(scenarioName, {
            status,
            updatedAt: Date.now(),
            message: message && message.trim().length > 0 ? message.trim() : undefined,
            runLogPath: runLogPath && runLogPath.trim().length > 0 ? runLogPath.trim() : undefined
        });
        this.sendRunArtifactsStateToWebview();
    }

    private isScenarioRunInProgress(scenarioName: string): boolean {
        return this._scenarioExecutionStates.get(scenarioName)?.status === 'running';
    }

    private buildRunArtifactsState(): Record<string, ScenarioRunState> {
        const state: Record<string, ScenarioRunState> = {};
        this.pruneScenarioBuildArtifactsByCache();

        for (const [scenarioName, artifact] of this._scenarioBuildArtifacts.entries()) {
            const executionState = this._scenarioExecutionStates.get(scenarioName);
            const rawRunStatus = executionState?.status || 'idle';
            const isStale = this._staleBuiltScenarioNames.has(scenarioName);
            const runStatus = isStale && rawRunStatus === 'failed'
                ? 'idle'
                : rawRunStatus;
            const runLogPath = executionState?.runLogPath?.trim();
            state[scenarioName] = {
                featurePath: artifact.featurePath,
                jsonPath: artifact.jsonPath,
                stale: isStale,
                runStatus,
                runMessage: executionState?.message,
                runUpdatedAt: executionState?.updatedAt,
                hasRunLog: rawRunStatus === 'failed'
                    && Boolean(runLogPath)
                    && fs.existsSync(runLogPath!)
            };
        }

        return state;
    }

    private getRunVanessaLaunchMode(): 'feature' | 'json' {
        return 'json';
    }

    private getCustomInfobasePathByScenarioMap(): Record<string, string> {
        return this._context.workspaceState.get<Record<string, string>>(
            PhaseSwitcherProvider.runVanessaCustomInfobaseCacheKey,
            {}
        );
    }

    private getScenarioCustomInfobasePath(scenarioName: string): string | undefined {
        const map = this.getCustomInfobasePathByScenarioMap();
        const value = map[scenarioName];
        if (!value || typeof value !== 'string') {
            return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    private async saveScenarioCustomInfobasePath(scenarioName: string, infobasePath: string): Promise<void> {
        const trimmedName = scenarioName.trim();
        const trimmedPath = infobasePath.trim();
        if (!trimmedName || !trimmedPath) {
            return;
        }
        const map = this.getCustomInfobasePathByScenarioMap();
        map[trimmedName] = trimmedPath;
        await this._context.workspaceState.update(PhaseSwitcherProvider.runVanessaCustomInfobaseCacheKey, map);
    }

    private resolveScenarioLaunchTarget(
        scenarioName: string,
        artifact: ScenarioBuildArtifact,
        preferredKind?: 'feature' | 'json',
        showWarnings: boolean = true
    ): { targetKind: 'feature' | 'json'; targetPath: string } | null {
        const primaryKind = preferredKind || this.getRunVanessaLaunchMode();
        let targetKind: 'feature' | 'json' = primaryKind;
        let targetPath = primaryKind === 'json' ? artifact.jsonPath : artifact.featurePath;

        if (!targetPath) {
            if (primaryKind === 'json' && artifact.featurePath) {
                targetKind = 'feature';
                targetPath = artifact.featurePath;
                if (showWarnings) {
                    vscode.window.showWarningMessage(
                        this.t('JSON artifact for "{0}" was not found. Falling back to feature file.', scenarioName)
                    );
                }
            } else if (primaryKind === 'feature' && artifact.jsonPath) {
                targetKind = 'json';
                targetPath = artifact.jsonPath;
                if (showWarnings) {
                    vscode.window.showWarningMessage(
                        this.t('Feature artifact for "{0}" was not found. Falling back to json file.', scenarioName)
                    );
                }
            }
        }

        if (!targetPath) {
            if (showWarnings) {
                vscode.window.showWarningMessage(this.t('No launchable artifact found for scenario "{0}".', scenarioName));
            }
            return null;
        }

        return {
            targetKind,
            targetPath
        };
    }

    private sendRunArtifactsStateToWebview(): void {
        if (!this._view?.webview) {
            return;
        }

        this._view.webview.postMessage({
            command: 'updateRunArtifactsState',
            runArtifacts: this.buildRunArtifactsState()
        });
    }

    private clearScenarioRunArtifactsAndNotify(): void {
        this._scenarioBuildArtifacts.clear();
        this._staleBuiltScenarioNames.clear();
        this._scenarioExecutionStates.clear();
        this._scenarioLastLaunchContexts.clear();
        this.sendRunArtifactsStateToWebview();
    }

    private normalizeScenarioLookupKey(value: string): string {
        return value
            .toLowerCase()
            .replace(/\.(feature|json)$/i, '')
            .replace(/[\s_-]+/g, '')
            .replace(/[^a-z0-9а-яё]/gi, '');
    }

    private tryResolveScenarioByName(
        candidate: string,
        exactNamesByLowercase: Map<string, string>,
        normalizedNames: Map<string, string[]>
    ): string | null {
        const trimmed = candidate.trim();
        if (!trimmed) {
            return null;
        }

        const exact = exactNamesByLowercase.get(trimmed.toLowerCase());
        if (exact) {
            return exact;
        }

        const normalizedKey = this.normalizeScenarioLookupKey(trimmed);
        if (!normalizedKey) {
            return null;
        }
        const normalizedMatches = normalizedNames.get(normalizedKey);
        if (normalizedMatches && normalizedMatches.length === 1) {
            return normalizedMatches[0];
        }

        return null;
    }

    private async extractFeatureTitleCandidate(featureFileUri: vscode.Uri): Promise<string | null> {
        try {
            const content = Buffer.from(await vscode.workspace.fs.readFile(featureFileUri)).toString('utf-8');
            const lines = content.split(/\r\n|\r|\n/).slice(0, 64);
            for (const line of lines) {
                const match = line.match(/^\s*(?:Feature|Функционал)\s*:\s*(.+?)\s*$/i);
                if (match?.[1]) {
                    return match[1].trim();
                }
            }
        } catch (error) {
            console.warn(`[PhaseSwitcherProvider] Failed to parse feature title from ${featureFileUri.fsPath}:`, error);
        }
        return null;
    }

    private async resolveScenarioNameForFeatureArtifact(
        featureFileUri: vscode.Uri,
        exactNamesByLowercase: Map<string, string>,
        normalizedNames: Map<string, string[]>
    ): Promise<string | null> {
        const baseName = path.basename(featureFileUri.fsPath, path.extname(featureFileUri.fsPath));
        const resolvedByName = this.tryResolveScenarioByName(baseName, exactNamesByLowercase, normalizedNames);
        if (resolvedByName) {
            return resolvedByName;
        }

        const featureTitle = await this.extractFeatureTitleCandidate(featureFileUri);
        if (!featureTitle) {
            return null;
        }

        return this.tryResolveScenarioByName(featureTitle, exactNamesByLowercase, normalizedNames);
    }

    private async updateScenarioBuildArtifacts(featureFiles: vscode.Uri[], buildRootUri: vscode.Uri): Promise<void> {
        const staleScenarioNamesBeforeBuild = new Set<string>(this._staleBuiltScenarioNames);
        this.pruneScenarioBuildArtifactsByCache();
        if (!this._testCache || this._testCache.size === 0) {
            this._scenarioBuildArtifacts.clear();
            this._staleBuiltScenarioNames.clear();
            this._scenarioExecutionStates.clear();
            this._scenarioLastLaunchContexts.clear();
            return;
        }
        if (featureFiles.length === 0) {
            this._scenarioBuildArtifacts.clear();
            this._staleBuiltScenarioNames.clear();
            this._scenarioExecutionStates.clear();
            this._scenarioLastLaunchContexts.clear();
            return;
        }

        const exactNamesByLowercase = new Map<string, string>();
        const normalizedNames = new Map<string, string[]>();
        for (const scenarioName of this._testCache.keys()) {
            const lower = scenarioName.toLowerCase();
            if (!exactNamesByLowercase.has(lower)) {
                exactNamesByLowercase.set(lower, scenarioName);
            }

            const normalized = this.normalizeScenarioLookupKey(scenarioName);
            if (!normalized) {
                continue;
            }
            const bucket = normalizedNames.get(normalized) || [];
            bucket.push(scenarioName);
            normalizedNames.set(normalized, bucket);
        }

        const nextArtifacts = new Map<string, ScenarioBuildArtifact>();
        const featureBaseToScenario = new Map<string, string>();
        const builtAt = Date.now();

        for (const featureFileUri of featureFiles) {
            const scenarioName = await this.resolveScenarioNameForFeatureArtifact(
                featureFileUri,
                exactNamesByLowercase,
                normalizedNames
            );

            if (!scenarioName) {
                continue;
            }

            const scenarioInfo = this._testCache.get(scenarioName);
            if (!scenarioInfo) {
                continue;
            }

            const existingArtifact = nextArtifacts.get(scenarioName) || {
                scenarioName,
                sourceUri: scenarioInfo.yamlFileUri,
                builtAt
            };
            existingArtifact.featurePath = featureFileUri.fsPath;
            nextArtifacts.set(scenarioName, existingArtifact);
            featureBaseToScenario.set(path.basename(featureFileUri.fsPath, '.feature').toLowerCase(), scenarioName);
        }

        let jsonFiles: vscode.Uri[] = [];
        try {
            const jsonPattern = new vscode.RelativePattern(buildRootUri, '**/*.json');
            jsonFiles = await vscode.workspace.findFiles(jsonPattern, '**/node_modules/**');
        } catch (error) {
            console.warn('[PhaseSwitcherProvider] Failed to discover json artifacts:', error);
        }

        for (const jsonFileUri of jsonFiles) {
            const jsonFileName = path.basename(jsonFileUri.fsPath, '.json');
            if (jsonFileName.toLowerCase() === 'yaml_parameters') {
                continue;
            }

            let scenarioName = featureBaseToScenario.get(jsonFileName.toLowerCase()) || null;
            if (!scenarioName) {
                scenarioName = this.tryResolveScenarioByName(jsonFileName, exactNamesByLowercase, normalizedNames);
            }
            if (!scenarioName) {
                continue;
            }

            const scenarioInfo = this._testCache.get(scenarioName);
            if (!scenarioInfo) {
                continue;
            }

            const existingArtifact = nextArtifacts.get(scenarioName) || {
                scenarioName,
                sourceUri: scenarioInfo.yamlFileUri,
                builtAt
            };
            existingArtifact.jsonPath = jsonFileUri.fsPath;
            nextArtifacts.set(scenarioName, existingArtifact);
        }

        this._scenarioBuildArtifacts = nextArtifacts;
        // Rebuilt stale scenarios should return to neutral run state (play icon).
        // This mirrors the behavior already used for previously passed scenarios.
        for (const scenarioName of staleScenarioNamesBeforeBuild) {
            if (nextArtifacts.has(scenarioName) && this._scenarioExecutionStates.get(scenarioName)?.status !== 'running') {
                this._scenarioExecutionStates.delete(scenarioName);
            }
        }
        for (const scenarioName of Array.from(this._scenarioExecutionStates.keys())) {
            if (!nextArtifacts.has(scenarioName)) {
                this._scenarioExecutionStates.delete(scenarioName);
            }
        }
        for (const scenarioName of Array.from(this._scenarioLastLaunchContexts.keys())) {
            if (!nextArtifacts.has(scenarioName)) {
                this._scenarioLastLaunchContexts.delete(scenarioName);
            }
        }
        this._staleBuiltScenarioNames.clear();
    }

    private quoteForShell(value: string): string {
        if (process.platform === 'win32') {
            return `"${value.replace(/"/g, '""')}"`;
        }
        return `'${value.replace(/'/g, `'\\''`)}'`;
    }

    private applyCommandTemplate(template: string, values: Record<string, string>): string {
        let command = template;
        for (const [key, value] of Object.entries(values)) {
            const placeholder = new RegExp(`\\$\\{${key}\\}`, 'g');
            command = command.replace(placeholder, value);
        }
        return command;
    }

    private getRunVanessaCheckUnsafeActionProtection(): boolean {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        return config.get<boolean>('runVanessa.checkUnsafeActionProtection', true);
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private escapePosixBasicRegExp(value: string): string {
        // conf.cfg uses POSIX BRE for DisableUnsafeActionProtection.
        // Escape only metacharacters that are special in BRE.
        return value.replace(/([.\\[\]*^$])/g, '\\$1');
    }

    private buildDisableUnsafeActionProtectionPattern(emptyIbPath: string): string {
        const normalizedPath = path.resolve(emptyIbPath).replace(/[\\/]+$/, '');
        const pathSegments = normalizedPath
            .split(/[\\/]+/)
            .filter(segment => segment.length > 0)
            .map(segment => this.escapePosixBasicRegExp(segment));

        if (pathSegments.length === 0) {
            return '.*';
        }

        const pathPattern = pathSegments.join('.*');
        // IMPORTANT: ';' is a delimiter between patterns in DisableUnsafeActionProtection,
        // so it must not be part of an individual regex pattern.
        // Use POSIX BRE-compatible syntax only (no non-capturing groups / '?' quantifier).
        return `.*File[ \t]*=[ \t]*["']*${pathPattern}.*`;
    }

    private buildUnsafeProtectionConnectionCandidates(emptyIbPath: string): string[] {
        const candidates = new Set<string>();
        const addPathVariants = (value: string, quoted: boolean, terminated: boolean) => {
            const pathValue = quoted ? `"${value}"` : value;
            const suffix = terminated ? ';' : '';
            candidates.add(`File=${pathValue}${suffix}`);
        };
        const addPath = (rawPath: string) => {
            const normalized = rawPath.replace(/[\\/]+$/, '');
            if (!normalized) {
                return;
            }

            const slashVariants = [
                normalized,
                normalized.replace(/\\/g, '/'),
                normalized.replace(/\//g, '\\')
            ];
            for (const variant of slashVariants) {
                addPathVariants(variant, false, true);
                addPathVariants(variant, false, false);
                addPathVariants(variant, true, true);
                addPathVariants(variant, true, false);
            }
        };

        addPath(emptyIbPath.trim());
        addPath(path.resolve(emptyIbPath.trim()));

        return Array.from(candidates);
    }

    private splitDisableUnsafeActionProtectionPatterns(rawValue: string): string[] {
        return rawValue
            .split(';')
            .map(item => item.trim())
            .filter(item => item.length > 0);
    }

    private normalizeUnsafePatternText(value: string): string {
        return value.replace(/\s+/g, '').trim();
    }

    private isLikelyPosixBrePattern(pattern: string): boolean {
        const compact = pattern.trim();
        if (!compact) {
            return false;
        }
        // Reject common PCRE/JS-only constructs that 1C POSIX BRE does not support.
        if (compact.includes('(?:') || compact.includes('(?=') || compact.includes('(?!') || compact.includes('(?<')) {
            return false;
        }
        return true;
    }

    private isPathSegmentBoundaryChar(char: string | undefined): boolean {
        if (!char) {
            return true;
        }
        return !/[0-9a-zа-яё_-]/i.test(char);
    }

    private findSegmentIndexWithBoundaries(haystack: string, segment: string, fromIndex: number): number {
        let index = haystack.indexOf(segment, fromIndex);
        while (index !== -1) {
            const previousChar = index > 0 ? haystack[index - 1] : undefined;
            const nextIndex = index + segment.length;
            const nextChar = nextIndex < haystack.length ? haystack[nextIndex] : undefined;
            if (this.isPathSegmentBoundaryChar(previousChar) && this.isPathSegmentBoundaryChar(nextChar)) {
                return index;
            }
            index = haystack.indexOf(segment, index + 1);
        }
        return -1;
    }

    private hasPathSegmentsInOrder(rawText: string, normalizedPath: string): boolean {
        const segments = normalizedPath
            .split(/[\\/]+/)
            .map(segment => segment.trim().toLowerCase())
            .filter(segment => segment.length > 0);
        if (segments.length === 0) {
            return false;
        }

        const haystack = rawText.toLowerCase();
        let index = 0;
        for (const segment of segments) {
            const foundIndex = this.findSegmentIndexWithBoundaries(haystack, segment, index);
            if (foundIndex === -1) {
                return false;
            }
            index = foundIndex + segment.length;
        }
        return true;
    }

    private hasDisableUnsafeActionProtectionForConnection(
        confText: string,
        connectionCandidates: string[],
        emptyIbPath: string,
        expectedPattern: string
    ): boolean {
        const lines = confText.split(/\r\n|\r|\n/);
        const paramValues: string[] = [];
        const normalizedEmptyIbPath = path.resolve(emptyIbPath).replace(/[\\/]+$/, '');
        const normalizedExpectedPattern = this.normalizeUnsafePatternText(expectedPattern);

        for (const line of lines) {
            const trimmed = line.replace(/^\uFEFF/, '').trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
                continue;
            }

            const match = trimmed.match(/^DisableUnsafeActionProtection\s*=\s*(.*)$/i);
            if (!match) {
                continue;
            }
            paramValues.push(match[1] || '');
        }

        if (paramValues.length === 0) {
            return false;
        }

        for (const rawValue of paramValues) {
            const patterns = this.splitDisableUnsafeActionProtectionPatterns(rawValue);
            if (rawValue.trim().length > 0) {
                patterns.push(rawValue.trim());
            }
            for (const pattern of patterns) {
                if (!this.isLikelyPosixBrePattern(pattern)) {
                    continue;
                }
                if (normalizedExpectedPattern && this.normalizeUnsafePatternText(pattern) === normalizedExpectedPattern) {
                    return true;
                }

                for (const candidate of connectionCandidates) {
                    try {
                        const regex = new RegExp(pattern, 'i');
                        if (regex.test(candidate)) {
                            return true;
                        }
                    } catch {
                        if (candidate.includes(pattern)) {
                            return true;
                        }
                    }
                }

                // Fallback: treat parameter as configured if path segments of EmptyInfobase
                // are present in order (works for escaped regex variants and literal paths).
                if (normalizedEmptyIbPath && this.hasPathSegmentsInOrder(pattern, normalizedEmptyIbPath)) {
                    return true;
                }
            }
        }

        return false;
    }

    private patchDisableUnsafeActionProtectionConf(
        confText: string,
        patternToAdd: string
    ): { changed: boolean; content: string } {
        const normalizedConfText = confText.replace(/^\uFEFF/, '');
        const lineEnding = normalizedConfText.includes('\r\n') ? '\r\n' : '\n';
        const lines = normalizedConfText.length > 0 ? normalizedConfText.split(/\r\n|\r|\n/) : [];
        const paramLineIndex = lines.findIndex(line =>
            /^\s*DisableUnsafeActionProtection\s*=/.test(line.trim())
        );

        if (paramLineIndex === -1) {
            if (lines.length > 0 && lines[lines.length - 1].trim().length > 0) {
                lines.push('');
            }
            lines.push(`DisableUnsafeActionProtection=${patternToAdd}`);
            return { changed: true, content: lines.join(lineEnding) };
        }

        const line = lines[paramLineIndex];
        const match = line.match(/^(\s*DisableUnsafeActionProtection\s*=\s*)(.*)$/i);
        const prefix = match ? match[1] : 'DisableUnsafeActionProtection=';
        const rawValue = match ? (match[2] || '') : '';
        const patterns = this.splitDisableUnsafeActionProtectionPatterns(rawValue);
        if (patterns.includes(patternToAdd)) {
            return { changed: false, content: normalizedConfText };
        }

        const nextValue = rawValue.trim().length > 0
            ? `${rawValue.trim()};${patternToAdd}`
            : patternToAdd;
        lines[paramLineIndex] = `${prefix}${nextValue}`;
        return { changed: true, content: lines.join(lineEnding) };
    }

    private resolveConfCfgCandidates(oneCPath: string): string[] {
        const candidates: string[] = [];
        const seen = new Set<string>();
        const add = (candidatePath: string) => {
            const normalized = path.normalize(candidatePath);
            if (seen.has(normalized)) {
                return;
            }
            seen.add(normalized);
            candidates.push(normalized);
        };

        const oneCDir = path.dirname(oneCPath);
        add(path.join(oneCDir, 'conf', 'conf.cfg'));
        add(path.join(oneCDir, '..', 'conf', 'conf.cfg'));

        if (process.platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA;
            const programFiles = process.env.PROGRAMFILES;
            const programFilesX86 = process.env['PROGRAMFILES(X86)'];
            if (localAppData) {
                add(path.join(localAppData, '1C', '1cv8', 'conf', 'conf.cfg'));
            }
            if (programFiles) {
                add(path.join(programFiles, '1cv8', 'conf', 'conf.cfg'));
            }
            if (programFilesX86) {
                add(path.join(programFilesX86, '1cv8', 'conf', 'conf.cfg'));
            }
        }

        const queue = [...candidates];
        while (queue.length > 0) {
            const confCfgPath = queue.shift()!;
            if (!fs.existsSync(confCfgPath)) {
                continue;
            }

            let text = '';
            try {
                text = fs.readFileSync(confCfgPath, 'utf8');
            } catch {
                continue;
            }

            const lines = text.split(/\r\n|\r|\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
                    continue;
                }

                const match = trimmed.match(/^ConfLocation\s*=\s*(.*)$/i);
                if (!match) {
                    continue;
                }

                const rawValue = (match[1] || '').trim().replace(/^["']|["']$/g, '');
                if (!rawValue) {
                    continue;
                }

                const resolvedBasePath = path.isAbsolute(rawValue)
                    ? rawValue
                    : path.resolve(path.dirname(confCfgPath), rawValue);
                const resolvedConfCfgPath = path.extname(resolvedBasePath).toLowerCase() === '.cfg'
                    ? resolvedBasePath
                    : path.join(resolvedBasePath, 'conf.cfg');

                const normalized = path.normalize(resolvedConfCfgPath);
                if (!seen.has(normalized)) {
                    add(normalized);
                    queue.push(normalized);
                }
            }
        }

        return candidates;
    }

    private async ensureUnsafeActionProtectionConfiguredForVanessa(
        oneCPath: string,
        emptyIbPath: string
    ): Promise<boolean> {
        if (process.platform !== 'win32' || !this.getRunVanessaCheckUnsafeActionProtection()) {
            return true;
        }

        const confCandidates = this.resolveConfCfgCandidates(oneCPath);
        const existingConfFiles = confCandidates.filter(candidate => fs.existsSync(candidate));
        const checkedPaths = confCandidates.slice(0, 8).join(', ');
        const connectionCandidates = this.buildUnsafeProtectionConnectionCandidates(emptyIbPath);
        const expectedPattern = this.buildDisableUnsafeActionProtectionPattern(emptyIbPath);

        for (const confPath of existingConfFiles) {
            try {
                const confText = fs.readFileSync(confPath, 'utf8');
                if (this.hasDisableUnsafeActionProtectionForConnection(confText, connectionCandidates, emptyIbPath, expectedPattern)) {
                    return true;
                }
            } catch {
                // Ignore unreadable conf file and continue with next candidate.
            }
        }

        const runAnyway = this.t('Run anyway');
        const openAndPatch = this.t('Open and patch');

        if (existingConfFiles.length === 0) {
            const openSettingsAction = this.t('Open Settings');
            const selection = await vscode.window.showWarningMessage(
                this.t('conf.cfg was not found near 1C:Enterprise installation. Check DisableUnsafeActionProtection manually.'),
                {
                    modal: true,
                    detail: checkedPaths
                        ? this.t('Checked conf.cfg paths: {0}', checkedPaths)
                        : undefined
                },
                openSettingsAction,
                runAnyway
            );

            if (selection === openSettingsAction) {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
                return false;
            }
            return selection === runAnyway;
        }

        const selectedAction = await vscode.window.showWarningMessage(
            this.t('DisableUnsafeActionProtection not found for current EmptyInfobase in conf.cfg. Vanessa may show repeated security prompts.'),
            {
                modal: true,
                detail: this.t('Checked conf.cfg paths: {0}', checkedPaths)
            },
            openAndPatch,
            runAnyway
        );

        if (selectedAction === runAnyway) {
            return true;
        }
        if (selectedAction !== openAndPatch) {
            return false;
        }

        const targetConfPath = existingConfFiles[0];
        const patternToAdd = expectedPattern;
        try {
            const targetUri = vscode.Uri.file(targetConfPath);
            const document = await vscode.workspace.openTextDocument(targetUri);
            const originalContent = document.getText();
            const patchResult = this.patchDisableUnsafeActionProtectionConf(originalContent, patternToAdd);
            if (patchResult.changed) {
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                edit.replace(targetUri, fullRange, patchResult.content);
                await vscode.workspace.applyEdit(edit);
            }

            await vscode.window.showTextDocument(document, { preview: false });
            vscode.window.showInformationMessage(
                this.t('DisableUnsafeActionProtection entry prepared in conf.cfg. Save file with administrator rights and rerun Vanessa.')
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(this.t('Failed to update conf.cfg: {0}', error?.message || String(error)));
        }

        return false;
    }

    private resolvePathFromWorkspaceSetting(rawPath: string, workspaceRootPath: string): string {
        if (path.isAbsolute(rawPath)) {
            return rawPath;
        }
        return path.join(workspaceRootPath, rawPath);
    }

    private parseInfobasePathFromConnectionString(value: string): string | null {
        const match = value.match(/File\s*=\s*("([^"]+)"|([^;]+))/i);
        if (!match) {
            return null;
        }
        const extracted = (match[2] || match[3] || '').trim();
        return extracted.replace(/[\\/]+$/, '');
    }

    private getJsonValueAtPointer(root: any, pointer: Array<string | number>): any {
        let current = root;
        for (const segment of pointer) {
            if (current === null || current === undefined) {
                return undefined;
            }
            current = current[segment as any];
        }
        return current;
    }

    private setJsonValueAtPointer(root: any, pointer: Array<string | number>, value: any): void {
        if (pointer.length === 0) {
            return;
        }

        let current = root;
        for (let index = 0; index < pointer.length - 1; index++) {
            const segment = pointer[index];
            if (current === null || current === undefined) {
                return;
            }
            current = current[segment as any];
        }

        const lastSegment = pointer[pointer.length - 1];
        if (current !== null && current !== undefined) {
            current[lastSegment as any] = value;
        }
    }

    private collectVanessaInfobaseCandidates(
        node: any,
        pointer: Array<string | number> = [],
        result: VanessaInfobaseCandidate[] = []
    ): VanessaInfobaseCandidate[] {
        if (Array.isArray(node)) {
            node.forEach((item, index) => {
                this.collectVanessaInfobaseCandidates(item, [...pointer, index], result);
            });
            return result;
        }

        if (!node || typeof node !== 'object') {
            return result;
        }

        for (const [key, value] of Object.entries(node)) {
            const nextPointer = [...pointer, key];
            if (typeof value === 'string') {
                const connectionPath = this.parseInfobasePathFromConnectionString(value);
                if (connectionPath) {
                    result.push({
                        pointer: nextPointer,
                        value,
                        extractedPath: connectionPath,
                        isConnectionString: true
                    });
                } else {
                    const keyLower = key.toLowerCase();
                    const isPathLikeKey =
                        keyLower.includes('infobase') ||
                        keyLower.includes('dbfolder') ||
                        keyLower.includes('launchdbfolder');
                    if (isPathLikeKey && /[\\/]/.test(value)) {
                        const normalized = value.trim().replace(/[\\/]+$/, '');
                        if (normalized) {
                            result.push({
                                pointer: nextPointer,
                                value,
                                extractedPath: normalized,
                                isConnectionString: false
                            });
                        }
                    }
                }
            } else if (value && typeof value === 'object') {
                this.collectVanessaInfobaseCandidates(value, nextPointer, result);
            }
        }

        return result;
    }

    private patchConnectionStringFilePath(rawValue: string, nextPath: string): string {
        return rawValue.replace(
            /(File\s*=\s*)("([^"]+)"|([^;]+))/i,
            (_full, prefix, captured) => {
                const quoted = String(captured || '').trim().startsWith('"');
                return `${prefix}${quoted ? `"${nextPath}"` : nextPath}`;
            }
        );
    }

    private parseAdditionalParameterPointer(rawKey: string): Array<string | number> | null {
        const key = rawKey.trim();
        if (!key) {
            return null;
        }

        if (!key.includes('.') && !key.includes('[')) {
            return [key];
        }

        const pointer: Array<string | number> = [];
        for (const rawSegment of key.split('.')) {
            const segment = rawSegment.trim();
            if (!segment) {
                return null;
            }

            const matcher = /([^[\]]+)|\[(\d+)\]/g;
            let cursor = 0;
            let hasMatch = false;
            let match: RegExpExecArray | null;
            while ((match = matcher.exec(segment)) !== null) {
                if (match.index !== cursor) {
                    return null;
                }

                hasMatch = true;
                if (match[1] !== undefined) {
                    const prop = match[1].trim();
                    if (!prop) {
                        return null;
                    }
                    pointer.push(prop);
                } else {
                    pointer.push(Number(match[2]));
                }

                cursor = matcher.lastIndex;
            }

            if (!hasMatch || cursor !== segment.length) {
                return null;
            }
        }

        return pointer.length > 0 ? pointer : null;
    }

    private getAdditionalParamAliasCandidates(rawKey: string): string[] {
        const key = rawKey.trim();
        if (!key) {
            return [];
        }

        const normalized = key.toLowerCase();
        const fromIndex = VANESSA_PARAM_ALIAS_INDEX.get(normalized);
        if (!fromIndex || fromIndex.size === 0) {
            return [key];
        }

        return Array.from(new Set([key, ...Array.from(fromIndex)]));
    }

    private findObjectKeyByAlias(container: unknown, rawKey: string): string | null {
        if (!container || typeof container !== 'object' || Array.isArray(container)) {
            return null;
        }

        const objectContainer = container as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(objectContainer, rawKey)) {
            return rawKey;
        }

        const normalizedInput = rawKey.trim().toLowerCase();
        if (!normalizedInput) {
            return null;
        }

        for (const key of Object.keys(objectContainer)) {
            if (key.trim().toLowerCase() === normalizedInput) {
                return key;
            }
        }

        const aliases = this.getAdditionalParamAliasCandidates(rawKey)
            .map(alias => alias.trim().toLowerCase())
            .filter(alias => alias.length > 0);
        if (!aliases.length) {
            return null;
        }
        const aliasSet = new Set(aliases);

        for (const key of Object.keys(objectContainer)) {
            if (aliasSet.has(key.trim().toLowerCase())) {
                return key;
            }
        }

        return null;
    }

    private resolveExistingPointerByAliases(root: unknown, pointer: Array<string | number>): Array<string | number> | null {
        let current = root as any;
        const resolved: Array<string | number> = [];

        for (const segment of pointer) {
            if (typeof segment === 'number') {
                if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
                    return null;
                }
                resolved.push(segment);
                current = current[segment];
                continue;
            }

            const resolvedKey = this.findObjectKeyByAlias(current, segment);
            if (!resolvedKey) {
                return null;
            }

            resolved.push(resolvedKey);
            current = current[resolvedKey as any];
        }

        return resolved;
    }

    private resolveRootPointerByLeafAlias(root: unknown, pointer: Array<string | number>): Array<string | number> | null {
        if (!root || typeof root !== 'object' || Array.isArray(root) || pointer.length < 2) {
            return null;
        }
        if (pointer.some(segment => typeof segment === 'number')) {
            return null;
        }

        const leaf = pointer[pointer.length - 1];
        if (typeof leaf !== 'string') {
            return null;
        }

        const resolvedRootKey = this.findObjectKeyByAlias(root, leaf);
        if (!resolvedRootKey) {
            return null;
        }

        return [resolvedRootKey];
    }

    private hasJsonValueAtPointer(root: any, pointer: Array<string | number>): boolean {
        let current = root;
        for (const segment of pointer) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return false;
            }
            if (!Object.prototype.hasOwnProperty.call(current, segment as any)) {
                return false;
            }
            current = current[segment as any];
        }
        return true;
    }

    private hasRootSpprTestClientsKey(root: unknown): boolean {
        if (!root || typeof root !== 'object' || Array.isArray(root)) {
            return false;
        }
        return Object.keys(root as Record<string, unknown>).some(key => key.trim().toLowerCase() === 'клиентытестирования');
    }

    private shouldSkipAdditionalParamForSpprClients(
        root: unknown,
        pointer: Array<string | number>
    ): boolean {
        if (!this.hasRootSpprTestClientsKey(root)) {
            return false;
        }

        const stringSegments = pointer
            .filter((segment): segment is string => typeof segment === 'string')
            .map(segment => segment.trim().toLowerCase())
            .filter(segment => segment.length > 0);
        if (!stringSegments.length) {
            return false;
        }

        const touchesClientsCollection = stringSegments.some(segment =>
            segment === 'datatestclients'
            || segment === 'клиентытестирования'
            || segment === 'данныеклиентовтестирования'
        );
        if (!touchesClientsCollection) {
            return false;
        }

        if (pointer.length === 1 && typeof pointer[0] === 'string') {
            return false;
        }

        return true;
    }

    private ensureJsonPointerContainers(root: any, pointer: Array<string | number>): boolean {
        if (!root || typeof root !== 'object' || pointer.length === 0) {
            return false;
        }

        let current = root;
        for (let index = 0; index < pointer.length - 1; index++) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return false;
            }

            const segment = pointer[index];
            const nextSegment = pointer[index + 1];
            const currentValue = current[segment as any];
            if (currentValue === null || currentValue === undefined || typeof currentValue !== 'object') {
                current[segment as any] = typeof nextSegment === 'number' ? [] : {};
            }
            current = current[segment as any];
        }

        return current !== null && current !== undefined && typeof current === 'object';
    }

    private parseAdditionalParameterValue(rawValue: string, hasExisting: boolean, existingValue: unknown): unknown {
        const source = String(rawValue ?? '');
        const trimmed = source.trim();

        const tryParseJson = (): { ok: boolean; value: unknown } => {
            try {
                return { ok: true, value: JSON.parse(trimmed) };
            } catch {
                return { ok: false, value: source };
            }
        };

        if (hasExisting) {
            if (typeof existingValue === 'string') {
                return source;
            }
            if (typeof existingValue === 'number') {
                const parsedNumber = Number(trimmed);
                return Number.isFinite(parsedNumber) ? parsedNumber : source;
            }
            if (typeof existingValue === 'boolean') {
                if (/^true$/i.test(trimmed)) {
                    return true;
                }
                if (/^false$/i.test(trimmed)) {
                    return false;
                }
                return source;
            }
            if (existingValue === null || typeof existingValue === 'object') {
                const parsed = tryParseJson();
                return parsed.ok ? parsed.value : source;
            }
            return source;
        }

        if (!trimmed) {
            return source;
        }

        const shouldTryJsonParse =
            trimmed.startsWith('{') ||
            trimmed.startsWith('[') ||
            trimmed === 'true' ||
            trimmed === 'false' ||
            trimmed === 'null' ||
            /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed);
        if (!shouldTryJsonParse) {
            return source;
        }

        const parsed = tryParseJson();
        return parsed.ok ? parsed.value : source;
    }

    private areJsonValuesEqual(left: unknown, right: unknown): boolean {
        if (left === right) {
            return true;
        }

        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
            return false;
        }

        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch {
            return false;
        }
    }

    private applyAdditionalVanessaParameters(root: any, params: AdditionalLaunchVanessaParameter[]): number {
        if (!root || typeof root !== 'object' || Array.isArray(root)) {
            return 0;
        }

        let changed = 0;
        for (const param of params) {
            const key = (param.key || '').trim();
            if (!key) {
                continue;
            }

            const parsedPointer = this.parseAdditionalParameterPointer(key) ?? [key];
            if (this.shouldSkipAdditionalParamForSpprClients(root, parsedPointer)) {
                continue;
            }
            const existingPointer =
                this.resolveExistingPointerByAliases(root, parsedPointer)
                ?? this.resolveRootPointerByLeafAlias(root, parsedPointer);
            const pointer = existingPointer ?? parsedPointer;
            const hasExisting = this.hasJsonValueAtPointer(root, pointer);
            if (hasExisting && !param.overrideExisting) {
                continue;
            }

            if (!this.ensureJsonPointerContainers(root, pointer)) {
                continue;
            }

            const existingValue = hasExisting ? this.getJsonValueAtPointer(root, pointer) : undefined;
            const nextValue = this.parseAdditionalParameterValue(
                String(param.value ?? ''),
                hasExisting,
                existingValue
            );
            const currentValue = this.getJsonValueAtPointer(root, pointer);
            if (!this.areJsonValuesEqual(currentValue, nextValue)) {
                this.setJsonValueAtPointer(root, pointer, nextValue);
                changed++;
            }
        }
        return changed;
    }

    private async loadVanessaLaunchOverlayParameters(): Promise<VanessaLaunchOverlayParameters> {
        try {
            const { YamlParametersManager } = await import('./yamlParametersManager.js');
            const manager = YamlParametersManager.getInstance(this._context);
            const normalize = (params: Array<{ key: string; value: string; overrideExisting?: boolean }>): AdditionalLaunchVanessaParameter[] => params
                .map(item => ({
                    key: String(item.key || '').trim(),
                    value: String(item.value ?? ''),
                    overrideExisting: Boolean((item as any).overrideExisting)
                }))
                .filter(item => item.key.length > 0);

            const additionalParameters = normalize(await manager.loadAdditionalVanessaParameters());
            const globalVariables = normalize(await manager.loadGlobalVanessaVariables());
            return { additionalParameters, globalVariables };
        } catch (error) {
            console.warn('[PhaseSwitcherProvider] Failed to load additional Vanessa parameters:', error);
            return { additionalParameters: [], globalVariables: [] };
        }
    }

    private getGlobalVarsRootAliases(): string[] {
        return ['GlobalVars', 'ГлобальныеПеременные', 'globalvariables', 'global_vars'];
    }

    private resolveGlobalVarsContainer(root: unknown): { key: string; value: Record<string, unknown> } | null {
        if (!root || typeof root !== 'object' || Array.isArray(root)) {
            return null;
        }

        const rootObj = root as Record<string, unknown>;
        for (const alias of this.getGlobalVarsRootAliases()) {
            const foundKey = this.findObjectKeyByAlias(rootObj, alias);
            if (!foundKey) {
                continue;
            }

            const currentValue = rootObj[foundKey];
            if (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)) {
                return { key: foundKey, value: currentValue as Record<string, unknown> };
            }

            const replacement: Record<string, unknown> = {};
            rootObj[foundKey] = replacement;
            return { key: foundKey, value: replacement };
        }

        const defaultKey = 'GlobalVars';
        const created: Record<string, unknown> = {};
        rootObj[defaultKey] = created;
        return { key: defaultKey, value: created };
    }

    private applyGlobalVanessaVariables(root: any, variables: AdditionalLaunchVanessaParameter[]): number {
        if (!root || typeof root !== 'object' || Array.isArray(root)) {
            return 0;
        }
        if (!Array.isArray(variables) || variables.length === 0) {
            return 0;
        }

        const containerInfo = this.resolveGlobalVarsContainer(root);
        if (!containerInfo) {
            return 0;
        }
        const container = containerInfo.value;
        let changed = 0;

        for (const variable of variables) {
            const key = (variable.key || '').trim();
            if (!key) {
                continue;
            }

            const resolvedKey = this.findObjectKeyByAlias(container, key) ?? key;
            const hasExisting = Object.prototype.hasOwnProperty.call(container, resolvedKey);
            if (hasExisting && !variable.overrideExisting) {
                continue;
            }

            const existingValue = hasExisting ? container[resolvedKey] : undefined;
            const nextValue = this.parseAdditionalParameterValue(
                String(variable.value ?? ''),
                hasExisting,
                existingValue
            );
            if (!this.areJsonValuesEqual(existingValue, nextValue)) {
                container[resolvedKey] = nextValue;
                changed++;
            }
        }

        return changed;
    }

    private getVanessaStatusFileKeySet(): Set<string> {
        return new Set([
            'scenariooutfile',
            'vanessastatusfile',
            'statusfile',
            'путькфайлудлявыгрузкистатусавыполнениясценариев',
            'путькфайлудлявыгрузкистатусавыполнениясценария'
        ]);
    }

    private getVanessaLogFileKeySet(): Set<string> {
        return new Set([
            'scenariologfile',
            'vanessalogfile',
            'logfile',
            'имяфайлалогвыполнениясценариев',
            'имяфайлалогвыполнениясценария',
            'имяфайлалогавыполнениясценариев',
            'имяфайлалогавыполнениясценария',
            'путькфайлулогавыполнениясценариев'
        ]);
    }

    private collectStringPointersByKeySet(
        node: any,
        keySet: Set<string>,
        pointer: Array<string | number> = [],
        result: JsonStringPointerCandidate[] = []
    ): JsonStringPointerCandidate[] {
        if (Array.isArray(node)) {
            node.forEach((item, index) => {
                this.collectStringPointersByKeySet(item, keySet, [...pointer, index], result);
            });
            return result;
        }

        if (!node || typeof node !== 'object') {
            return result;
        }

        for (const [key, value] of Object.entries(node)) {
            const nextPointer = [...pointer, key];
            if (typeof value === 'string' && keySet.has(key.toLowerCase())) {
                result.push({
                    pointer: nextPointer,
                    key,
                    value
                });
            }
            if (value && typeof value === 'object') {
                this.collectStringPointersByKeySet(value, keySet, nextPointer, result);
            }
        }

        return result;
    }

    private toPortablePath(value: string): string {
        return value.replace(/\\/g, '/');
    }

    private resolveVanessaRuntimeDirectory(workspaceRootPath: string, jsonPath?: string): string {
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const configuredRuntimeDir = (config.get<string>('runVanessa.runtimeDirectory') || '').trim();
        if (configuredRuntimeDir.length > 0) {
            return path.resolve(this.resolvePathFromWorkspaceSetting(configuredRuntimeDir, workspaceRootPath));
        }

        if (workspaceRootPath.trim().length > 0) {
            return path.resolve(path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'vanessa'));
        }

        if (jsonPath && jsonPath.trim().length > 0) {
            return path.resolve(path.join(path.dirname(jsonPath), '_vanessa_runtime'));
        }

        return path.resolve(path.join(process.cwd(), '.vscode', 'kot-runtime', 'vanessa'));
    }

    private async ensureUniqueVanessaRuntimePathsInJson(
        jsonPath: string,
        scenarioName: string,
        workspaceRootPath: string
    ): Promise<boolean> {
        let parsedJson: any;
        let rawText = '';
        try {
            rawText = await fs.promises.readFile(jsonPath, 'utf8');
            parsedJson = JSON.parse(rawText);
        } catch {
            return false;
        }

        const statusPointers = this.collectStringPointersByKeySet(parsedJson, this.getVanessaStatusFileKeySet());
        const logPointers = this.collectStringPointersByKeySet(parsedJson, this.getVanessaLogFileKeySet());
        if (statusPointers.length === 0 && logPointers.length === 0) {
            return false;
        }

        const rawBaseName = path.basename(jsonPath, '.json') || scenarioName || 'scenario';
        const safeBaseName = rawBaseName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'scenario';
        const runtimeDir = this.resolveVanessaRuntimeDirectory(workspaceRootPath, jsonPath);
        await fs.promises.mkdir(runtimeDir, { recursive: true });

        const logPath = this.toPortablePath(path.join(runtimeDir, `${safeBaseName}.log`));
        const statusPath = this.toPortablePath(path.join(runtimeDir, `${safeBaseName}.status.log`));

        let changed = false;
        for (const candidate of logPointers) {
            const current = this.getJsonValueAtPointer(parsedJson, candidate.pointer);
            if (typeof current === 'string' && current !== logPath) {
                this.setJsonValueAtPointer(parsedJson, candidate.pointer, logPath);
                changed = true;
            }
        }
        for (const candidate of statusPointers) {
            const current = this.getJsonValueAtPointer(parsedJson, candidate.pointer);
            if (typeof current === 'string' && current !== statusPath) {
                this.setJsonValueAtPointer(parsedJson, candidate.pointer, statusPath);
                changed = true;
            }
        }

        if (!changed) {
            return false;
        }

        await fs.promises.writeFile(jsonPath, JSON.stringify(parsedJson, null, 4), 'utf8');
        return true;
    }

    private async ensureUniqueVanessaRuntimePathsForArtifacts(
        outputChannel: vscode.OutputChannel,
        workspaceRootPath: string
    ): Promise<void> {
        let updatedCount = 0;
        for (const [scenarioName, artifact] of this._scenarioBuildArtifacts.entries()) {
            const jsonPath = artifact.jsonPath;
            if (!jsonPath || !fs.existsSync(jsonPath)) {
                continue;
            }

            try {
                const changed = await this.ensureUniqueVanessaRuntimePathsInJson(jsonPath, scenarioName, workspaceRootPath);
                if (changed) {
                    updatedCount++;
                    this.outputAdvanced(outputChannel, this.t('Patched Vanessa runtime paths in JSON: {0}', jsonPath));
                }
            } catch (error: any) {
                this.outputAdvanced(outputChannel, this.t('Failed to patch Vanessa runtime paths in JSON {0}: {1}', jsonPath, error?.message || String(error)));
            }
        }

        if (updatedCount > 0) {
            this.outputInfo(outputChannel, this.t('Updated Vanessa runtime log/status paths for {0} JSON artifact(s).', String(updatedCount)));
        }
    }

    private cleanupVanessaStatusFileBeforeRun(
        jsonPath: string,
        workspaceRootPath: string,
        outputChannel: vscode.OutputChannel
    ): void {
        let parsedJson: any;
        try {
            parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
            return;
        }

        const statusFileRaw = this.findFirstStringByKeySet(parsedJson, this.getVanessaStatusFileKeySet());
        if (!statusFileRaw) {
            return;
        }

        const statusPath = this.resolveVanessaAuxPath(statusFileRaw, workspaceRootPath, jsonPath);
        if (!fs.existsSync(statusPath)) {
            return;
        }

        try {
            fs.unlinkSync(statusPath);
            this.outputAdvanced(outputChannel, this.t('Deleted previous Vanessa status file: {0}', statusPath));
        } catch (error: any) {
            this.outputAdvanced(outputChannel, this.t('Failed to delete previous Vanessa status file {0}: {1}', statusPath, error?.message || String(error)));
        }
    }

    private cleanupVanessaRunLogFileBeforeRun(
        jsonPath: string,
        workspaceRootPath: string,
        outputChannel: vscode.OutputChannel
    ): void {
        let parsedJson: any;
        try {
            parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
            return;
        }

        const logFileRaw = this.findFirstStringByKeySet(parsedJson, this.getVanessaLogFileKeySet());
        if (!logFileRaw) {
            return;
        }

        const logPath = this.resolveVanessaAuxPath(logFileRaw, workspaceRootPath, jsonPath);
        if (!fs.existsSync(logPath)) {
            return;
        }

        try {
            fs.unlinkSync(logPath);
            this.outputAdvanced(outputChannel, this.t('Deleted previous Vanessa run log file: {0}', logPath));
        } catch (error: any) {
            this.outputAdvanced(outputChannel, this.t('Failed to delete previous Vanessa run log file {0}: {1}', logPath, error?.message || String(error)));
        }
    }

    private findFirstStringByKeySet(node: any, keySet: Set<string>): string | null {
        if (!node || typeof node !== 'object') {
            return null;
        }

        if (Array.isArray(node)) {
            for (const item of node) {
                const found = this.findFirstStringByKeySet(item, keySet);
                if (found) {
                    return found;
                }
            }
            return null;
        }

        for (const [key, value] of Object.entries(node)) {
            if (typeof value === 'string' && keySet.has(key.toLowerCase())) {
                const trimmed = value.trim();
                if (trimmed) {
                    return trimmed;
                }
            }
            if (value && typeof value === 'object') {
                const found = this.findFirstStringByKeySet(value, keySet);
                if (found) {
                    return found;
                }
            }
        }
        return null;
    }

    private resolveVanessaAuxPath(rawPath: string, workspaceRootPath: string, jsonPath: string): string {
        if (path.isAbsolute(rawPath)) {
            return path.normalize(rawPath);
        }

        const jsonDirCandidate = path.resolve(path.dirname(jsonPath), rawPath);
        const workspaceCandidate = path.resolve(workspaceRootPath, rawPath);
        if (fs.existsSync(jsonDirCandidate) || !fs.existsSync(workspaceCandidate)) {
            return jsonDirCandidate;
        }
        return workspaceCandidate;
    }

    private resolveVanessaLogPathFromJson(
        jsonPath: string,
        workspaceRootPath: string
    ): string | undefined {
        let parsedJson: any;
        try {
            parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
            return undefined;
        }

        const logFileRaw = this.findFirstStringByKeySet(parsedJson, this.getVanessaLogFileKeySet());
        if (!logFileRaw) {
            return undefined;
        }

        return this.resolveVanessaAuxPath(logFileRaw, workspaceRootPath, jsonPath);
    }

    private validateVanessaStatusFromJson(
        jsonPath: string,
        workspaceRootPath: string,
        outputChannel: vscode.OutputChannel
    ): { ok: true } | { ok: false; message: string } {
        let parsedJson: any;
        try {
            parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
            return { ok: true };
        }

        const statusFileRaw = this.findFirstStringByKeySet(
            parsedJson,
            this.getVanessaStatusFileKeySet()
        );
        if (!statusFileRaw) {
            return { ok: true };
        }

        const statusPath = this.resolveVanessaAuxPath(statusFileRaw, workspaceRootPath, jsonPath);
        if (!fs.existsSync(statusPath)) {
            return {
                ok: false,
                message: this.t('Vanessa status file not found at path: {0}', statusPath)
            };
        }

        let statusContent = '';
        try {
            statusContent = fs.readFileSync(statusPath, 'utf8');
        } catch {
            return {
                ok: false,
                message: this.t('Failed to read Vanessa status file at path: {0}', statusPath)
            };
        }

        const statusCode = (statusContent.match(/\d+/)?.[0] || '').trim();
        if (statusCode === '0') {
            return { ok: true };
        }

        const logFileRaw = this.findFirstStringByKeySet(
            parsedJson,
            this.getVanessaLogFileKeySet()
        );
        if (logFileRaw) {
            const logPath = this.resolveVanessaAuxPath(logFileRaw, workspaceRootPath, jsonPath);
            if (fs.existsSync(logPath)) {
                try {
                    const logLines = fs.readFileSync(logPath, 'utf8').split(/\r\n|\r|\n/);
                    const tail = logLines.slice(Math.max(0, logLines.length - 30)).join('\n');
                    if (tail.trim().length > 0) {
                        this.outputAdvanced(outputChannel, this.t('Last Vanessa log lines from {0}:', logPath));
                        if (this.isAdvancedOutputLoggingEnabled()) {
                            outputChannel.appendLine(tail);
                        }
                    }
                } catch {
                    // Ignore log read errors.
                }
            }
        }

        return {
            ok: false,
            message: this.t('Vanessa status file indicates test failure: {0}', statusPath)
        };
    }

    private async prepareVanessaLaunchContext(
        scenarioName: string,
        jsonLaunchPath: string,
        configuredEmptyIbPath: string,
        workspaceRootPath: string
    ): Promise<VanessaLaunchContext | null> {
        let rawJson = '';
        let parsedJson: any = null;
        try {
            rawJson = fs.readFileSync(jsonLaunchPath, 'utf8');
            parsedJson = JSON.parse(rawJson);
        } catch {
            // Ignore parse/read issues and fallback to configured path.
        }

        const candidates = parsedJson
            ? this.collectVanessaInfobaseCandidates(parsedJson)
            : [];
        const launchOverlay = await this.loadVanessaLaunchOverlayParameters();
        const additionalVanessaParams = launchOverlay.additionalParameters;
        const globalVanessaVariables = launchOverlay.globalVariables;
        const jsonDefaultInfobase = candidates.length > 0
            ? candidates[0].extractedPath
            : '';
        const defaultScenarioInfobase = jsonDefaultInfobase || configuredEmptyIbPath;

        const lastCustomInfobase = this.getScenarioCustomInfobasePath(scenarioName);
        const quickPickItems: Array<vscode.QuickPickItem & { source: VanessaInfobaseSource }> = [];

        quickPickItems.push({
            label: this.t('Use path from JSON/settings'),
            description: defaultScenarioInfobase,
            detail: jsonDefaultInfobase
                ? this.t('Path extracted from scenario JSON.')
                : this.t('JSON path was not detected. Fallback to settings path.'),
            source: 'jsonOrSettings'
        });

        if (lastCustomInfobase) {
            quickPickItems.push({
                label: this.t('Use last custom path'),
                description: lastCustomInfobase,
                detail: this.t('Last custom value saved for this scenario.'),
                source: 'lastCustom'
            });
        }

        quickPickItems.push({
            label: this.t('Enter new custom path'),
            description: this.t('Specify another infobase path for this scenario.'),
            source: 'newCustom'
        });

        const selection = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: this.t('Choose infobase source for Vanessa run of "{0}".', scenarioName),
            ignoreFocusOut: true
        });
        if (!selection) {
            return null;
        }

        let selectedSource: VanessaInfobaseSource = selection.source;
        let chosenScenarioInfobasePath = defaultScenarioInfobase;

        if (selectedSource === 'lastCustom') {
            if (!lastCustomInfobase) {
                vscode.window.showWarningMessage(
                    this.t('Last custom path for scenario "{0}" was not found. Choose another option.', scenarioName)
                );
                return null;
            }
            chosenScenarioInfobasePath = lastCustomInfobase;
            if (!fs.existsSync(chosenScenarioInfobasePath)) {
                const chooseNew = this.t('Enter new custom path');
                const pathAction = await vscode.window.showWarningMessage(
                    this.t('Saved custom path does not exist: {0}', chosenScenarioInfobasePath),
                    chooseNew
                );
                if (pathAction !== chooseNew) {
                    return null;
                }
                selectedSource = 'newCustom';
            }
        }

        if (selectedSource === 'newCustom') {
            const customPath = await vscode.window.showInputBox({
                title: this.t('Enter infobase path for this run'),
                value: lastCustomInfobase || defaultScenarioInfobase,
                ignoreFocusOut: true,
                validateInput: value => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                        return this.t('Infobase path cannot be empty.');
                    }
                    if (!fs.existsSync(trimmed)) {
                        return this.t('Path does not exist: {0}', trimmed);
                    }
                    return null;
                }
            });
            if (!customPath) {
                return null;
            }
            chosenScenarioInfobasePath = customPath.trim();
            await this.saveScenarioCustomInfobasePath(scenarioName, chosenScenarioInfobasePath);
        }

        const shouldPatchInfobase = selectedSource !== 'jsonOrSettings' || chosenScenarioInfobasePath !== jsonDefaultInfobase;
        const shouldPatchAdditionalParams = additionalVanessaParams.length > 0;
        const shouldPatchGlobalVars = globalVanessaVariables.length > 0;

        if (!shouldPatchInfobase && !shouldPatchAdditionalParams && !shouldPatchGlobalVars) {
            return {
                startupInfobasePath: configuredEmptyIbPath,
                scenarioInfobasePath: chosenScenarioInfobasePath,
                vaParamsJsonPath: jsonLaunchPath,
                jsonWasPatched: false
            };
        }

        if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
            if (shouldPatchInfobase && selectedSource !== 'jsonOrSettings') {
                vscode.window.showWarningMessage(
                    this.t('Could not detect target infobase field in JSON. Selected custom path will be saved, but JSON is used as-is for launch.')
                );
            }
            if (shouldPatchAdditionalParams) {
                vscode.window.showWarningMessage(
                    this.t('Could not apply additional Vanessa parameters because launch JSON could not be parsed.')
                );
            }
            if (shouldPatchGlobalVars) {
                vscode.window.showWarningMessage(
                    this.t('Could not apply GlobalVars because launch JSON could not be parsed.')
                );
            }
            return {
                startupInfobasePath: configuredEmptyIbPath,
                scenarioInfobasePath: chosenScenarioInfobasePath,
                vaParamsJsonPath: jsonLaunchPath,
                jsonWasPatched: false
            };
        }

        const patchedJson = JSON.parse(rawJson);
        let infobaseChanged = false;
        if (shouldPatchInfobase) {
            if (!candidates.length) {
                if (selectedSource !== 'jsonOrSettings') {
                    vscode.window.showWarningMessage(
                        this.t('Could not detect target infobase field in JSON. Selected custom path will be saved, but JSON is used as-is for launch.')
                    );
                }
            } else {
                for (const candidate of candidates) {
                    const currentValue = this.getJsonValueAtPointer(patchedJson, candidate.pointer);
                    if (typeof currentValue !== 'string') {
                        continue;
                    }

                    const nextValue = candidate.isConnectionString
                        ? this.patchConnectionStringFilePath(currentValue, chosenScenarioInfobasePath)
                        : chosenScenarioInfobasePath;
                    if (nextValue !== currentValue) {
                        this.setJsonValueAtPointer(patchedJson, candidate.pointer, nextValue);
                        infobaseChanged = true;
                    }
                }
            }
        }

        const additionalChanged = shouldPatchAdditionalParams
            ? this.applyAdditionalVanessaParameters(patchedJson, additionalVanessaParams) > 0
            : false;
        const globalVarsChanged = shouldPatchGlobalVars
            ? this.applyGlobalVanessaVariables(patchedJson, globalVanessaVariables) > 0
            : false;

        if (!infobaseChanged && !additionalChanged && !globalVarsChanged) {
            return {
                startupInfobasePath: configuredEmptyIbPath,
                scenarioInfobasePath: chosenScenarioInfobasePath,
                vaParamsJsonPath: jsonLaunchPath,
                jsonWasPatched: false
            };
        }

        const tempDir = path.join(os.tmpdir(), 'kot-test-toolkit', 'vanessa');
        await fs.promises.mkdir(tempDir, { recursive: true });
        const safeScenarioName = scenarioName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'scenario';
        const tempJsonPath = path.join(tempDir, `${safeScenarioName}_${Date.now()}.json`);
        await fs.promises.writeFile(tempJsonPath, JSON.stringify(patchedJson, null, 2), 'utf8');

        return {
            startupInfobasePath: configuredEmptyIbPath,
            scenarioInfobasePath: chosenScenarioInfobasePath,
            vaParamsJsonPath: tempJsonPath,
            jsonWasPatched: true
        };
    }

    private async runScenarioInVanessaBuiltIn(
        scenarioName: string,
        targetKind: 'feature' | 'json',
        targetPath: string,
        artifact: ScenarioBuildArtifact,
        options?: {
            manualDebug?: boolean;
        }
    ): Promise<'started' | 'skipped' | 'aborted'> {
        const manualDebug = !!options?.manualDebug;
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage(this.t('Project folder must be opened.'));
            return 'skipped';
        }

        const workspaceRootPath = workspaceFolder.uri.fsPath;
        const oneCPath = (config.get<string>('paths.oneCEnterpriseExe') || '').trim();
        if (!oneCPath) {
            vscode.window.showErrorMessage(
                this.t('Path to 1C:Enterprise (1cv8.exe) is not specified in settings.'),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
                }
            });
            return 'skipped';
        }
        if (!fs.existsSync(oneCPath)) {
            vscode.window.showErrorMessage(
                this.t('1C:Enterprise file (1cv8.exe) not found at path: {0}', oneCPath),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
                }
            });
            return 'skipped';
        }

        const configuredEmptyIbPath = (config.get<string>('paths.emptyInfobase') || '').trim();
        if (!configuredEmptyIbPath) {
            vscode.window.showErrorMessage(
                this.t('Path to empty infobase is not specified in settings.'),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.emptyInfobase');
                }
            });
            return 'skipped';
        }
        if (!fs.existsSync(configuredEmptyIbPath)) {
            vscode.window.showErrorMessage(
                this.t('Empty infobase directory not found at path: {0}', configuredEmptyIbPath),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.emptyInfobase');
                }
            });
            return 'skipped';
        }

        const vanessaEpfSetting = (config.get<string>('runVanessa.vanessaEpfPath') || '').trim();
        if (!vanessaEpfSetting) {
            vscode.window.showErrorMessage(
                this.t('Path to Vanessa Automation EPF is not specified in settings.'),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.runVanessa.vanessaEpfPath');
                }
            });
            return 'skipped';
        }
        const vanessaEpfPath = this.resolvePathFromWorkspaceSetting(vanessaEpfSetting, workspaceRootPath);
        if (!fs.existsSync(vanessaEpfPath)) {
            vscode.window.showErrorMessage(
                this.t('Vanessa Automation EPF file not found at path: {0}', vanessaEpfPath),
                this.t('Open Settings')
            ).then(selection => {
                if (selection === this.t('Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.runVanessa.vanessaEpfPath');
                }
            });
            return 'skipped';
        }

        const jsonLaunchPath = artifact.jsonPath
            || (targetKind === 'json' ? targetPath : '');
        if (!jsonLaunchPath) {
            vscode.window.showWarningMessage(
                this.t('Built-in Vanessa launcher requires JSON artifact for "{0}". Switch launch mode to json or set command template.', scenarioName)
            );
            return 'skipped';
        }
        if (!fs.existsSync(jsonLaunchPath)) {
            vscode.window.showWarningMessage(
                this.t('JSON launch file not found at path: {0}', jsonLaunchPath)
            );
            return 'skipped';
        }

        const launchContext = await this.prepareVanessaLaunchContext(
            scenarioName,
            jsonLaunchPath,
            configuredEmptyIbPath,
            workspaceRootPath
        );
        if (!launchContext) {
            return 'aborted';
        }

        const emptyIbPath = launchContext.startupInfobasePath;
        const scenarioInfobasePath = launchContext.scenarioInfobasePath;
        const launchJsonPath = launchContext.vaParamsJsonPath;
        const unsafeProtectionConfigured = await this.ensureUnsafeActionProtectionConfiguredForVanessa(oneCPath, emptyIbPath);
        if (!unsafeProtectionConfigured) {
            return 'aborted';
        }

        const vaCommandParts = [
            'ShowMainForm',
            'QuietInstallVanessaExt',
            `VAParams=${launchJsonPath}`,
            'WithoutSendingStatistics'
        ];
        if (manualDebug) {
            vaCommandParts.push('UseEditor');
        } else {
            vaCommandParts.unshift('StartFeaturePlayer');
            // Force close behavior for automated runs, regardless of JSON language/aliases.
            vaCommandParts.push(
                'RunScenarios=true',
                'ExecuteScenarios=true',
                'QuitSystemOnComplete=true',
                'CloseSystemOnComplete=true',
                'CloseTestClientAfterScenarioRun=true',
                'CloseTestClient=true'
            );
        }
        const vaCommand = `${vaCommandParts.join(';')};`;
        const args = [
            ...this.buildStartupParams(emptyIbPath),
            '/Execute',
            `"${vanessaEpfPath}"`,
            `/C"${vaCommand}"`,
            '/TESTMANAGER'
        ];

        const outputChannel = this.getOutputChannel();
        outputChannel.show(true);
        const outputTitle = manualDebug
            ? this.t('Opening Vanessa Automation manual debug session for "{0}"...', scenarioName)
            : this.t('Starting Vanessa Automation launch for "{0}" via built-in runner...', scenarioName);
        this.outputInfo(outputChannel, outputTitle);
        this.outputAdvanced(outputChannel, this.t('Vanessa EPF path: {0}', vanessaEpfPath));
        this.outputAdvanced(outputChannel, this.t('Vanessa JSON run settings: {0}', launchJsonPath));
        this.outputAdvanced(outputChannel, this.t('Requested artifact mode: {0}', targetKind));
        this.outputAdvanced(outputChannel, this.t('Requested artifact path: {0}', targetPath));
        this.outputAdvanced(outputChannel, this.t('Using startup infobase path for this run: {0}', emptyIbPath));
        this.outputAdvanced(outputChannel, this.t('Using scenario infobase path for this run: {0}', scenarioInfobasePath));
        if (!manualDebug) {
            this.cleanupVanessaRunLogFileBeforeRun(launchJsonPath, workspaceRootPath, outputChannel);
            this.cleanupVanessaStatusFileBeforeRun(launchJsonPath, workspaceRootPath, outputChannel);
        }

        try {
            if (manualDebug) {
                await this.execute1CProcessDetached(
                    oneCPath,
                    args,
                    workspaceRootPath,
                    `Vanessa Automation Manual (${scenarioName})`
                );
            } else {
                await this.execute1CProcess(
                    oneCPath,
                    args,
                    workspaceRootPath,
                    `Vanessa Automation (${scenarioName})`
                );

                const statusResult = this.validateVanessaStatusFromJson(launchJsonPath, workspaceRootPath, outputChannel);
                if (!statusResult.ok) {
                    throw new Error(statusResult.message);
                }
            }
        } finally {
            if (launchContext.jsonWasPatched && !manualDebug) {
                try {
                    await fs.promises.unlink(launchJsonPath);
                } catch {
                    // Ignore cleanup errors for temporary launch json.
                }
            }
        }
        return 'started';
    }

    private async prepareLaunchJsonWithAdditionalVanessaParams(
        scenarioName: string,
        jsonLaunchPath: string
    ): Promise<{ jsonPath: string; jsonWasPatched: boolean }> {
        if (!jsonLaunchPath || !fs.existsSync(jsonLaunchPath)) {
            return { jsonPath: jsonLaunchPath, jsonWasPatched: false };
        }

        const launchOverlay = await this.loadVanessaLaunchOverlayParameters();
        const additionalVanessaParams = launchOverlay.additionalParameters;
        const globalVanessaVariables = launchOverlay.globalVariables;
        if (additionalVanessaParams.length === 0 && globalVanessaVariables.length === 0) {
            return { jsonPath: jsonLaunchPath, jsonWasPatched: false };
        }
        const parseFailureMessage = additionalVanessaParams.length > 0
            ? this.t('Could not apply additional Vanessa parameters because launch JSON could not be parsed.')
            : this.t('Could not apply GlobalVars because launch JSON could not be parsed.');

        let rawJson = '';
        let parsedJson: any;
        try {
            rawJson = fs.readFileSync(jsonLaunchPath, 'utf8');
            parsedJson = JSON.parse(rawJson);
        } catch {
            vscode.window.showWarningMessage(parseFailureMessage);
            return { jsonPath: jsonLaunchPath, jsonWasPatched: false };
        }

        if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
            vscode.window.showWarningMessage(parseFailureMessage);
            return { jsonPath: jsonLaunchPath, jsonWasPatched: false };
        }

        const patchedJson = JSON.parse(rawJson);
        const additionalChanged = additionalVanessaParams.length > 0
            ? this.applyAdditionalVanessaParameters(patchedJson, additionalVanessaParams) > 0
            : false;
        const globalVarsChanged = globalVanessaVariables.length > 0
            ? this.applyGlobalVanessaVariables(patchedJson, globalVanessaVariables) > 0
            : false;
        if (!additionalChanged && !globalVarsChanged) {
            return { jsonPath: jsonLaunchPath, jsonWasPatched: false };
        }

        const tempDir = path.join(os.tmpdir(), 'kot-test-toolkit', 'vanessa');
        await fs.promises.mkdir(tempDir, { recursive: true });
        const safeScenarioName = scenarioName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'scenario';
        const tempJsonPath = path.join(tempDir, `${safeScenarioName}_${Date.now()}_extra.json`);
        await fs.promises.writeFile(tempJsonPath, JSON.stringify(patchedJson, null, 2), 'utf8');

        return { jsonPath: tempJsonPath, jsonWasPatched: true };
    }

    private async openScenarioInVanessaManual(scenarioName: string): Promise<void> {
        if (this._isBuildInProgress) {
            vscode.window.showWarningMessage(this.t('Please wait for the current build to finish.'));
            return;
        }

        if (this.isScenarioRunInProgress(scenarioName)) {
            vscode.window.showWarningMessage(this.t('Scenario "{0}" is already running.', scenarioName));
            return;
        }

        this.pruneScenarioBuildArtifactsByCache();
        const artifact = this._scenarioBuildArtifacts.get(scenarioName);
        if (!artifact || (!artifact.featurePath && !artifact.jsonPath)) {
            vscode.window.showWarningMessage(this.t('No build artifacts found for scenario "{0}". Build tests first.', scenarioName));
            return;
        }

        const lastLaunchContext = this._scenarioLastLaunchContexts.get(scenarioName);
        const launchTarget = this.resolveScenarioLaunchTarget(
            scenarioName,
            artifact,
            lastLaunchContext?.targetKind,
            true
        );
        if (!launchTarget) {
            return;
        }

        if (this._staleBuiltScenarioNames.has(scenarioName)) {
            const continueOpen = this.t('Open anyway');
            const selection = await vscode.window.showWarningMessage(
                this.t('Artifacts for "{0}" may be outdated because related scenarios changed after build.', scenarioName),
                { modal: true },
                continueOpen
            );
            if (selection !== continueOpen) {
                return;
            }
        }

        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const commandTemplate = (config.get<string>('runVanessa.commandTemplate') || '').trim();
        if (commandTemplate) {
            vscode.window.showInformationMessage(
                this.t('Manual debug open uses built-in Vanessa launcher and ignores runVanessa.commandTemplate.')
            );
        }

        try {
            const launchStatus = await this.runScenarioInVanessaBuiltIn(
                scenarioName,
                launchTarget.targetKind,
                launchTarget.targetPath,
                artifact,
                { manualDebug: true }
            );
            if (launchStatus === 'started') {
                vscode.window.showInformationMessage(
                    this.t('Vanessa manual debug session started for scenario "{0}".', scenarioName)
                );
                const outputChannel = this.getOutputChannel();
                this.outputInfo(outputChannel, this.t('Vanessa manual debug session started for scenario "{0}".', scenarioName));
            } else if (launchStatus === 'skipped') {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(launchTarget.targetPath));
                vscode.window.showInformationMessage(
                    this.t('Built-in launch was skipped. Opened {0} artifact for "{1}".', launchTarget.targetKind, scenarioName)
                );
            }
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            const outputChannel = this.getOutputChannel();
            this.outputError(
                outputChannel,
                this.t('Failed to open Vanessa manual debug session for "{0}": {1}', scenarioName, errorMessage),
                error
            );
            vscode.window.showErrorMessage(
                this.t('Failed to open Vanessa manual debug session for "{0}": {1}', scenarioName, errorMessage)
            );
        }
    }

    private async openRunScenarioLog(scenarioName: string): Promise<void> {
        const runState = this._scenarioExecutionStates.get(scenarioName);
        if (!runState || runState.status !== 'failed') {
            vscode.window.showInformationMessage(
                this.t('No failure log is available yet for scenario "{0}".', scenarioName)
            );
            return;
        }

        const runLogPath = runState.runLogPath?.trim();
        if (!runLogPath) {
            vscode.window.showWarningMessage(
                this.t('Run log path is not available for scenario "{0}".', scenarioName)
            );
            return;
        }

        if (!fs.existsSync(runLogPath)) {
            vscode.window.showWarningMessage(
                this.t('Run log file not found at path: {0}', runLogPath)
            );
            return;
        }

        const logUri = vscode.Uri.file(runLogPath);
        try {
            const document = await vscode.workspace.openTextDocument(logUri);
            await vscode.window.showTextDocument(document, { preview: false });

            const outputChannel = this.getOutputChannel();
            this.outputInfo(outputChannel, this.t('Opened run log for scenario "{0}".', scenarioName));
        } catch (error: any) {
            vscode.window.showErrorMessage(
                this.t('Failed to open run log file "{0}": {1}', runLogPath, error?.message || String(error))
            );
        }
    }

    private async openScenarioFeatureInEditor(scenarioName: string): Promise<void> {
        this.pruneScenarioBuildArtifactsByCache();

        const artifact = this._scenarioBuildArtifacts.get(scenarioName);
        const featurePath = artifact?.featurePath?.trim();
        if (!featurePath) {
            vscode.window.showWarningMessage(
                this.t('Feature artifact is not available for scenario "{0}". Build tests first.', scenarioName)
            );
            return;
        }

        if (!fs.existsSync(featurePath)) {
            vscode.window.showWarningMessage(
                this.t('Feature file not found at path: {0}', featurePath)
            );
            return;
        }

        try {
            const featureUri = vscode.Uri.file(featurePath);
            const document = await vscode.workspace.openTextDocument(featureUri);
            await vscode.window.showTextDocument(document, { preview: false });
        } catch (error: any) {
            vscode.window.showErrorMessage(
                this.t('Failed to open feature file "{0}": {1}', featurePath, error?.message || String(error))
            );
        }
    }

    private async runScenarioInVanessa(scenarioName: string): Promise<void> {
        if (this._isBuildInProgress) {
            vscode.window.showWarningMessage(this.t('Please wait for the current build to finish.'));
            return;
        }

        if (this.isScenarioRunInProgress(scenarioName)) {
            vscode.window.showWarningMessage(this.t('Scenario "{0}" is already running.', scenarioName));
            return;
        }

        this.pruneScenarioBuildArtifactsByCache();
        const artifact = this._scenarioBuildArtifacts.get(scenarioName);
        if (!artifact || (!artifact.featurePath && !artifact.jsonPath)) {
            vscode.window.showWarningMessage(this.t('No build artifacts found for scenario "{0}". Build tests first.', scenarioName));
            return;
        }

        const launchTarget = this.resolveScenarioLaunchTarget(scenarioName, artifact, undefined, true);
        if (!launchTarget) {
            return;
        }
        const targetPath = launchTarget.targetPath;
        const targetKind = launchTarget.targetKind;

        if (this._staleBuiltScenarioNames.has(scenarioName)) {
            const continueRun = this.t('Run anyway');
            const selection = await vscode.window.showWarningMessage(
                this.t('Artifacts for "{0}" may be outdated because related scenarios changed after build.', scenarioName),
                { modal: true },
                continueRun
            );
            if (selection !== continueRun) {
                return;
            }
        }

        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const commandTemplate = (config.get<string>('runVanessa.commandTemplate') || '').trim();
        const workspaceRootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const featurePath = artifact.featurePath || '';
        const jsonPath = artifact.jsonPath || '';
        const outputChannel = this.getOutputChannel();
        const launchModeUsed: 'builtIn' | 'template' = commandTemplate ? 'template' : 'builtIn';
        const runLogPath = jsonPath && fs.existsSync(jsonPath)
            ? this.resolveVanessaLogPathFromJson(jsonPath, workspaceRootPath)
            : undefined;

        this._scenarioLastLaunchContexts.set(scenarioName, {
            targetKind,
            targetPath,
            launchMode: launchModeUsed,
            updatedAt: Date.now()
        });
        this.setScenarioExecutionState(scenarioName, 'running', this.t('Run in progress'), runLogPath);
        outputChannel.show(true);

        if (!commandTemplate) {
            try {
                const launchStatus = await this.runScenarioInVanessaBuiltIn(scenarioName, targetKind, targetPath, artifact);
                if (launchStatus === 'started') {
                    this.setScenarioExecutionState(scenarioName, 'passed', this.t('Last run passed'), runLogPath);
                    this.outputInfo(outputChannel, this.t('Scenario run finished successfully: "{0}"', scenarioName));
                    vscode.window.showInformationMessage(
                        this.t('Vanessa launch completed for scenario "{0}".', scenarioName)
                    );
                } else if (launchStatus === 'skipped') {
                    this.setScenarioExecutionState(scenarioName, 'idle');
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetPath));
                    vscode.window.showInformationMessage(
                        this.t('Built-in launch was skipped. Opened {0} artifact for "{1}".', targetKind, scenarioName)
                    );
                } else {
                    this.setScenarioExecutionState(scenarioName, 'idle');
                }
            } catch (error: any) {
                const errorMessage = error?.message || String(error);
                this.setScenarioExecutionState(scenarioName, 'failed', errorMessage, runLogPath);
                this.outputError(outputChannel, this.t('Scenario run failed: "{0}" -> {1}', scenarioName, errorMessage), error);
                this.appendScenarioRunLogReference(outputChannel, scenarioName, runLogPath);
                vscode.window.showErrorMessage(this.t('Failed to launch Vanessa for "{0}": {1}', scenarioName, error.message || error));
            }
            return;
        }

        const templateJsonContext = await this.prepareLaunchJsonWithAdditionalVanessaParams(
            scenarioName,
            jsonPath
        );
        const jsonPathForTemplate = templateJsonContext.jsonPath || jsonPath;
        const command = this.applyCommandTemplate(commandTemplate, {
            scenarioName,
            scenarioNameQuoted: this.quoteForShell(scenarioName),
            featurePath,
            featurePathQuoted: featurePath ? this.quoteForShell(featurePath) : '',
            jsonPath: jsonPathForTemplate,
            jsonPathQuoted: jsonPathForTemplate ? this.quoteForShell(jsonPathForTemplate) : '',
            workspaceRoot: workspaceRootPath,
            workspaceRootQuoted: this.quoteForShell(workspaceRootPath)
        });

        this.outputInfo(outputChannel, this.t('Starting Vanessa Automation launch for "{0}"...', scenarioName));
        this.outputAdvanced(outputChannel, this.t('Resolved launch command: {0}', command));
        if (jsonPathForTemplate && fs.existsSync(jsonPathForTemplate)) {
            this.cleanupVanessaRunLogFileBeforeRun(jsonPathForTemplate, workspaceRootPath, outputChannel);
            this.cleanupVanessaStatusFileBeforeRun(jsonPathForTemplate, workspaceRootPath, outputChannel);
        }

        let templateStdoutData = '';
        let templateStderrData = '';
        try {
            await new Promise<void>((resolve, reject) => {
                const child = cp.spawn(command, [], {
                    cwd: workspaceRootPath,
                    shell: true,
                    windowsHide: true
                });

                child.stdout?.on('data', data => {
                    templateStdoutData += data.toString();
                });
                child.stderr?.on('data', data => {
                    templateStderrData += data.toString();
                });

                child.on('error', error => {
                    reject(error);
                });
                child.on('close', code => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(this.t('Launch command exited with code {0}.', String(code))));
                    }
                });
            });

            this.setScenarioExecutionState(scenarioName, 'passed', this.t('Last run passed'), runLogPath);
            this.outputInfo(outputChannel, this.t('Scenario run finished successfully: "{0}"', scenarioName));
            vscode.window.showInformationMessage(
                this.t('Vanessa launch completed for scenario "{0}".', scenarioName)
            );
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.setScenarioExecutionState(scenarioName, 'failed', errorMessage, runLogPath);
            this.appendProcessOutputTail(outputChannel, `Vanessa template launch (${scenarioName})`, templateStdoutData, templateStderrData);
            this.outputError(outputChannel, this.t('Vanessa launch failed: {0}', errorMessage), error);
            this.outputError(outputChannel, this.t('Scenario run failed: "{0}" -> {1}', scenarioName, errorMessage));
            this.appendScenarioRunLogReference(outputChannel, scenarioName, runLogPath);
            vscode.window.showErrorMessage(this.t('Failed to launch Vanessa for "{0}": {1}', scenarioName, error.message || error));
        } finally {
            if (templateJsonContext.jsonWasPatched && jsonPathForTemplate) {
                try {
                    await fs.promises.unlink(jsonPathForTemplate);
                } catch {
                    // Ignore cleanup errors for temporary launch json.
                }
            }
        }
    }

    private async _handleApplyChanges(states: { [testName: string]: boolean }) {
        console.log("[PhaseSwitcherProvider:_handleApplyChanges] Starting...");
        if (!this._view || !this._testCache) { 
            console.warn("[PhaseSwitcherProvider:_handleApplyChanges] View or testCache is not available.");
            return; 
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) { 
            console.warn("[PhaseSwitcherProvider:_handleApplyChanges] No workspace folder open.");
            return; 
        }
        const workspaceRootUri = workspaceFolders[0].uri;

        const baseOnDirUri = vscode.Uri.joinPath(workspaceRootUri, getScanDirRelativePath());
        const projectPaths = this.getProjectPaths(workspaceRootUri);
        const baseOffDirUri = projectPaths.disabledTestsDirectory;
        


        if (this._view.webview) {
            this._view.webview.postMessage({ command: 'updateStatus', text: this.t('Applying changes...'), enableControls: false, refreshButtonEnabled: false });
        } else {
            console.warn("[PhaseSwitcherProvider:_handleApplyChanges] Cannot send status, webview is not available.");
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: this.t('Applying phase changes...'),
            cancellable: false
        }, async (progress) => {
            let stats = { enabled: 0, disabled: 0, skipped: 0, error: 0 };
            const total = Object.keys(states).length;
            const increment = total > 0 ? 100 / total : 0;

            for (const [name, shouldBeEnabled] of Object.entries(states)) {
                progress.report({ increment: increment , message: this.t('Processing {0}...', name) });

                const info = this._testCache!.get(name);
                // Применяем изменения только для тестов, которые имеют tabName (т.е. управляются через Phase Switcher)
                if (!info || !info.tabName) { 
                    // console.log(`[PhaseSwitcherProvider-v6:_handleApplyChanges] Skipping "${name}" as it's not part of Phase Switcher UI (no tabName).`);
                    stats.skipped++; 
                    continue; 
                }

                const onPathTestDir = vscode.Uri.joinPath(baseOnDirUri, info.relativePath, 'test');
                const offPathTestDir = vscode.Uri.joinPath(baseOffDirUri, info.relativePath, 'test');
                const targetOffDirParent = vscode.Uri.joinPath(baseOffDirUri, info.relativePath);

                let currentState: 'enabled' | 'disabled' | 'missing' = 'missing';
                try { await vscode.workspace.fs.stat(onPathTestDir); currentState = 'enabled'; }
                catch { try { await vscode.workspace.fs.stat(offPathTestDir); currentState = 'disabled'; } catch { /* missing */ } }

                try {
                    if (shouldBeEnabled && currentState === 'disabled') {
                        await vscode.workspace.fs.rename(offPathTestDir, onPathTestDir, { overwrite: true });
                        stats.enabled++;
                    } else if (!shouldBeEnabled && currentState === 'enabled') {
                        try { await vscode.workspace.fs.createDirectory(targetOffDirParent); }
                        catch (dirErr: any) {
                            if (dirErr.code !== 'EEXIST' && dirErr.code !== 'FileExists') {
                                throw dirErr;
                            }
                        }
                        await vscode.workspace.fs.rename(onPathTestDir, offPathTestDir, { overwrite: true });
                        stats.disabled++;
                    } else {
                        stats.skipped++;
                    }
                } catch (moveError: any) {
                    console.error(`[PhaseSwitcherProvider] Error moving test "${name}":`, moveError);
                    vscode.window.showErrorMessage(this.t('Error moving "{0}": {1}', name, moveError.message || moveError));
                    stats.error++;
                }
            }

            const resultMessage = this.t('Enabled: {0}, Disabled: {1}, Skipped: {2}, Errors: {3}', 
                String(stats.enabled), String(stats.disabled), String(stats.skipped), String(stats.error));
            if (stats.error > 0) { vscode.window.showWarningMessage(this.t('Changes applied with errors! {0}', resultMessage)); }
            else if (stats.enabled > 0 || stats.disabled > 0) { vscode.window.showInformationMessage(this.t('Phase changes successfully applied! {0}', resultMessage)); }
            else { vscode.window.showInformationMessage(this.t('Phase changes: nothing to apply. {0}', resultMessage)); }

            if (this._view?.webview) {
                console.log("[PhaseSwitcherProvider] Refreshing state after apply...");
                // _sendInitialState вызовет _onDidUpdateTestCache с полным списком
                await this._sendInitialState(this._view.webview); 
            } else {
                console.warn("[PhaseSwitcherProvider] Cannot refresh state after apply, view is not available.");
            }
        });
    }
}
