import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import {
    buildAiEndpoint,
    ensureAiConnectionSettingsComplete,
    getAiConnectionSettings,
    requestTextFromAi,
    type AiOutputLanguage
} from './aiClient';
import { getFormExplorerConfigurationSourceDirectory } from './formExplorerPaths';

const execFileAsync = promisify(execFile);
const GIT_EXEC_MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_CONFIGURATION_DIFF_SYSTEM_PROMPT = [
    'Ты выступаешь как опытный тест-аналитик и ревьюер изменений конфигурации 1С.',
    'На вход приходит diff файловой выгрузки конфигурации относительно главной ветки и необязательный текст UserStory.',
    'Нужно подготовить практический markdown-отчет для тестировщика, который редко читает код конфигурации.',
    'Главный фокус: что поменяется для пользователя, какие сценарии нужно прогнать, какие данные и роли подготовить, и где возможны регрессии.',
    'Если передан UserStory, используй его как контекст намерения задачи при анализе изменений.',
    'Пиши простым человеческим языком и переводи технические изменения в конкретные действия тестировщика.',
    'Если вывод нельзя сделать уверенно, явно помечай его как гипотезу или вероятное влияние.',
    'Не пересказывай весь diff и не выдумывай факты, которых нет в изменениях.'
].join('\n');

interface ChangedFileEntry {
    status: string;
    path: string;
    configurationRelativePath: string;
    oldPath?: string;
    descriptor: string;
    score: number;
}

interface UntrackedFileEntry {
    path: string;
    configurationRelativePath: string;
    descriptor: string;
    score: number;
    excerpt: string;
}

interface DiffPatch {
    path: string;
    text: string;
    score: number;
    index: number;
}

export interface ConfigurationDiffContext {
    repositoryRootPath: string;
    configurationSourceDirectory: string;
    configurationSourceDirectoryRelativePath: string;
    currentBranch: string;
    baseRef: string;
    mergeBase: string;
    changedFiles: ChangedFileEntry[];
    untrackedFiles: UntrackedFileEntry[];
    trackedDiffText: string;
}

type TestingScopeType =
    | 'configuration'
    | 'document'
    | 'catalog'
    | 'informationRegister'
    | 'accumulationRegister'
    | 'report'
    | 'dataProcessor'
    | 'commonModule'
    | 'commonForm'
    | 'role'
    | 'subsystem'
    | 'commonCommand'
    | 'commandGroup'
    | 'language'
    | 'enumeration'
    | 'constant'
    | 'businessProcess'
    | 'task'
    | 'session'
    | 'chartOfAccounts'
    | 'chartOfCharacteristicTypes'
    | 'chartOfCalculationTypes'
    | 'other';

type ChangeFacet =
    | 'ui'
    | 'logic'
    | 'data'
    | 'rights'
    | 'navigation'
    | 'localization'
    | 'reporting'
    | 'metadata'
    | 'integration';

interface ConfigurationPathAnalysis {
    normalizedPath: string;
    rootName: string;
    objectName: string | null;
    formName: string | null;
    scopeKey: string;
    scopeType: TestingScopeType;
    changeFacets: ChangeFacet[];
}

interface TestingFocusAreaDraft {
    key: string;
    scopeType: TestingScopeType;
    filePaths: Set<string>;
    descriptors: Set<string>;
    formNames: Set<string>;
    formTitles: Set<string>;
    changeFacets: Set<ChangeFacet>;
    score: number;
    title: string;
}

interface TestingFocusArea {
    title: string;
    filePaths: string[];
    descriptors: string[];
    testerMeaning: string;
    checkFirst: string[];
    runScenarios: string[];
    dataAndRoles: string[];
    nearbyRisks: string[];
    score: number;
}

interface GeneratedConfigurationDiffImpactReport {
    reportBody: string;
    outputLanguage: AiOutputLanguage;
    testingFocusAreas: TestingFocusArea[];
}

interface ConfigurationDiffReportStorageContext {
    repositoryRootPath: string;
    configurationSourceDirectory: string;
    currentBranch: string;
    reportsDirectoryUri: vscode.Uri;
    reportUri: vscode.Uri;
}

export interface ConfigurationDiffImpactReportState {
    available: boolean;
    branchName: string | null;
    reportUri: vscode.Uri | null;
    hasSavedReport: boolean;
}

export interface GenerateConfigurationDiffImpactReportResult {
    branchName: string;
    reportUri: vscode.Uri | null;
    hasChanges: boolean;
}

class SettingsActionError extends Error {
    constructor(message: string, public readonly settingsQuery?: string) {
        super(message);
    }
}

function normalizePathSeparators(value: string): string {
    return value.replace(/\\/g, '/');
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function toConfigurationRelativePath(repositoryRelativePath: string, configurationSourceDirectoryRelativePath: string): string {
    const normalizedRepositoryPath = normalizePathSeparators(repositoryRelativePath).replace(/^\/+/, '');
    const normalizedConfigurationPath = normalizePathSeparators(configurationSourceDirectoryRelativePath)
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

    if (!normalizedConfigurationPath) {
        return normalizedRepositoryPath;
    }

    if (normalizedRepositoryPath === normalizedConfigurationPath) {
        return '';
    }

    const prefix = `${normalizedConfigurationPath}/`;
    return normalizedRepositoryPath.startsWith(prefix)
        ? normalizedRepositoryPath.slice(prefix.length)
        : normalizedRepositoryPath;
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function extractFirstTagValue(xmlText: string, tagName: string): string {
    const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`).exec(xmlText);
    return match?.[1]?.trim() || '';
}

function extractFirstSynonymText(xmlText: string): string {
    const match = /<Synonym>[\s\S]*?<v8:content>([\s\S]*?)<\/v8:content>[\s\S]*?<\/Synonym>/.exec(xmlText);
    return match?.[1] ? decodeXmlEntities(match[1].trim()) : '';
}

function pushUnique(target: string[], values: string[]): void {
    for (const value of values) {
        if (value.length > 0 && !target.includes(value)) {
            target.push(value);
        }
    }
}

function formatGitError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const execError = error as Error & {
        stderr?: string;
        stdout?: string;
        code?: string | number;
    };
    const stderr = typeof execError.stderr === 'string' ? execError.stderr.trim() : '';
    const stdout = typeof execError.stdout === 'string' ? execError.stdout.trim() : '';
    const details = stderr || stdout || execError.message;
    const code = execError.code !== undefined ? ` (${String(execError.code)})` : '';
    return `${details}${code}`.trim();
}

function hashString(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function sanitizeBranchNameForReportFile(branchName: string): string {
    const sanitized = branchName
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    const fallback = sanitized.length > 0 ? sanitized : 'branch';
    return `${fallback}--${hashString(branchName)}.md`;
}

export function resolveRuntimeRootUri(anchorPath: string): vscode.Uri {
    const anchorUri = vscode.Uri.file(anchorPath);
    const workspaceFolderUri = vscode.workspace.getWorkspaceFolder(anchorUri)?.uri;
    const settingsScopeUri = workspaceFolderUri ?? anchorUri;
    const runtimeDirectory = (
        vscode.workspace.getConfiguration('kotTestToolkit', settingsScopeUri).get<string>('runtime.directory')
        || ''
    ).trim();

    if (runtimeDirectory && path.isAbsolute(runtimeDirectory)) {
        return vscode.Uri.file(runtimeDirectory);
    }

    return vscode.Uri.joinPath(settingsScopeUri, runtimeDirectory || '.vscode/kot-runtime');
}

async function resolveConfiguredConfigurationSourceDirectory(): Promise<string> {
    const configurationSourceDirectory = getFormExplorerConfigurationSourceDirectory();
    if (!configurationSourceDirectory || !fs.existsSync(configurationSourceDirectory)) {
        throw new SettingsActionError(
            vscode.l10n.t(
                'Configuration source directory is not configured or not found. Set kotTestToolkit.formExplorer.configurationSourceDirectory.'
            ),
            'kotTestToolkit.formExplorer.configurationSourceDirectory'
        );
    }

    const configurationDirectoryStats = await fs.promises.stat(configurationSourceDirectory);
    if (!configurationDirectoryStats.isDirectory()) {
        throw new SettingsActionError(
            vscode.l10n.t(
                'Configuration source directory is not configured or not found. Set kotTestToolkit.formExplorer.configurationSourceDirectory.'
            ),
            'kotTestToolkit.formExplorer.configurationSourceDirectory'
        );
    }

    return configurationSourceDirectory;
}

async function doesUriExist(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function deleteUriIfExists(uri: vscode.Uri): Promise<void> {
    if (!(await doesUriExist(uri))) {
        return;
    }

    await vscode.workspace.fs.delete(uri, { useTrash: false });
}

async function openConfigurationDiffReportUri(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}

async function execGit(
    repositoryRootPath: string,
    args: string[],
    allowFailure = false
): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd: repositoryRootPath,
            maxBuffer: GIT_EXEC_MAX_BUFFER
        });
        return stdout.trimEnd();
    } catch (error) {
        if (allowFailure) {
            return null;
        }

        throw new Error(vscode.l10n.t('Git command failed: {0}', formatGitError(error)));
    }
}

async function resolveRepositoryRoot(configurationSourceDirectory: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
            cwd: configurationSourceDirectory,
            maxBuffer: 1024 * 1024
        });
        return stdout.trim();
    } catch (error) {
        throw new Error(vscode.l10n.t('Git command failed: {0}', formatGitError(error)));
    }
}

async function resolveMainBranchRef(repositoryRootPath: string): Promise<string> {
    const originHeadRef = await execGit(
        repositoryRootPath,
        ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
        true
    );
    if (originHeadRef) {
        const normalizedRef = originHeadRef.trim();
        if (normalizedRef.startsWith('refs/remotes/')) {
            return normalizedRef.slice('refs/remotes/'.length);
        }
    }

    const candidates = ['origin/main', 'origin/master', 'main', 'master'];
    for (const candidate of candidates) {
        const resolved = await execGit(
            repositoryRootPath,
            ['rev-parse', '--verify', '--quiet', candidate],
            true
        );
        if (resolved) {
            return candidate;
        }
    }

    throw new Error(vscode.l10n.t(
        'Could not determine the main branch ref. Expected one of origin/main, origin/master, main or master.'
    ));
}

async function resolveCurrentBranchName(repositoryRootPath: string): Promise<string> {
    const branchName = await execGit(
        repositoryRootPath,
        ['branch', '--show-current'],
        true
    );
    return branchName?.trim() || 'HEAD';
}

async function resolveMergeBase(repositoryRootPath: string, baseRef: string): Promise<string> {
    const mergeBase = await execGit(repositoryRootPath, ['merge-base', 'HEAD', baseRef], true);
    if (mergeBase?.trim()) {
        return mergeBase.trim();
    }

    return baseRef;
}

function describeConfigurationPath(relativePath: string): string {
    const normalizedPath = normalizePathSeparators(relativePath);
    if (normalizedPath === 'Configuration.xml') {
        return 'root configuration metadata';
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    const rootName = segments[0] || normalizedPath;
    const objectName = segments[1] || '';
    const fallbackByRoot: Record<string, string> = {
        Catalogs: 'catalog',
        Documents: 'document',
        InformationRegisters: 'information register',
        AccumulationRegisters: 'accumulation register',
        BusinessProcesses: 'business process',
        Tasks: 'task',
        CommonModules: 'common module',
        CommonForms: 'common form',
        CommonCommands: 'common command',
        Roles: 'role',
        CommandGroups: 'command group',
        Enumerations: 'enumeration',
        Reports: 'report',
        DataProcessors: 'data processor',
        ChartsOfAccounts: 'chart of accounts',
        ChartsOfCharacteristicTypes: 'chart of characteristic types',
        ChartsOfCalculationTypes: 'chart of calculation types',
        Constants: 'constant',
        Sessions: 'session setting',
        Languages: 'language resource',
        Subsystems: 'subsystem'
    };

    const objectLabel = objectName
        ? `${fallbackByRoot[rootName] || rootName.slice(0, -1) || rootName} "${objectName}"`
        : (fallbackByRoot[rootName] || rootName);

    if (/\/Ext\/ObjectModule\.bsl$/i.test(normalizedPath)) {
        return `${objectLabel}, object module`;
    }
    if (/\/Ext\/ManagerModule\.bsl$/i.test(normalizedPath)) {
        return `${objectLabel}, manager module`;
    }
    if (/\/Ext\/Module\.bsl$/i.test(normalizedPath)) {
        return `${objectLabel}, module code`;
    }
    if (/\/Ext\/Form\.xml$/i.test(normalizedPath)) {
        const formsIndex = segments.indexOf('Forms');
        const formName = formsIndex >= 0 ? segments[formsIndex + 1] : objectName;
        return formName
            ? `${objectLabel}, form "${formName}"`
            : `${objectLabel}, form`;
    }
    if (/\.bsl$/i.test(normalizedPath)) {
        return `${objectLabel}, BSL code`;
    }
    if (/\.xml$/i.test(normalizedPath)) {
        return `${objectLabel}, metadata XML`;
    }

    return objectLabel;
}

function scoreConfigurationPath(relativePath: string): number {
    const normalizedPath = normalizePathSeparators(relativePath);
    let score = 1;

    if (/\/Ext\/ObjectModule\.bsl$/i.test(normalizedPath)) {
        score += 10;
    } else if (/\/Ext\/ManagerModule\.bsl$/i.test(normalizedPath)) {
        score += 9;
    } else if (/\/Ext\/Module\.bsl$/i.test(normalizedPath)) {
        score += 8;
    } else if (/\/Ext\/Form\.xml$/i.test(normalizedPath)) {
        score += 8;
    } else if (/Configuration\.xml$/i.test(normalizedPath)) {
        score += 7;
    } else if (/\.bsl$/i.test(normalizedPath)) {
        score += 7;
    } else if (/\.xml$/i.test(normalizedPath)) {
        score += 4;
    }

    if (/\/Forms\//i.test(normalizedPath) || /^CommonForms\//i.test(normalizedPath)) {
        score += 3;
    }
    if (/^Roles\//i.test(normalizedPath) || /^Subsystems\//i.test(normalizedPath)) {
        score += 2;
    }

    return score;
}

function getTestingScopeType(rootName: string): TestingScopeType {
    const mapping: Record<string, TestingScopeType> = {
        Configuration: 'configuration',
        Documents: 'document',
        Catalogs: 'catalog',
        InformationRegisters: 'informationRegister',
        AccumulationRegisters: 'accumulationRegister',
        Reports: 'report',
        DataProcessors: 'dataProcessor',
        CommonModules: 'commonModule',
        CommonForms: 'commonForm',
        Roles: 'role',
        Subsystems: 'subsystem',
        CommonCommands: 'commonCommand',
        CommandGroups: 'commandGroup',
        Languages: 'language',
        Enumerations: 'enumeration',
        Constants: 'constant',
        BusinessProcesses: 'businessProcess',
        Tasks: 'task',
        Sessions: 'session',
        ChartsOfAccounts: 'chartOfAccounts',
        ChartsOfCharacteristicTypes: 'chartOfCharacteristicTypes',
        ChartsOfCalculationTypes: 'chartOfCalculationTypes'
    };

    return mapping[rootName] || 'other';
}

function analyzeConfigurationPath(relativePath: string): ConfigurationPathAnalysis {
    const normalizedPath = normalizePathSeparators(relativePath).replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath === 'Configuration.xml') {
        return {
            normalizedPath: normalizedPath || 'Configuration.xml',
            rootName: 'Configuration',
            objectName: null,
            formName: null,
            scopeKey: 'Configuration',
            scopeType: 'configuration',
            changeFacets: ['metadata', 'navigation']
        };
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    const rootName = segments[0] || 'Configuration';
    const scopeType = getTestingScopeType(rootName);
    let objectName: string | null = null;
    let formName: string | null = null;

    if (scopeType === 'commonForm') {
        objectName = segments[1] ? path.basename(segments[1], '.xml') : null;
    } else if (segments.length >= 2) {
        objectName = path.basename(segments[1], '.xml') || null;
    }

    if (scopeType !== 'commonForm' && segments[2] === 'Forms' && segments[3]) {
        formName = path.basename(segments[3], '.xml');
    }

    const changeFacets = new Set<ChangeFacet>();
    if (
        /\/Forms\/[^/]+\.xml$/i.test(normalizedPath)
        || /\/Ext\/Form\.xml$/i.test(normalizedPath)
        || /\/Ext\/Form\/Module\.bsl$/i.test(normalizedPath)
        || scopeType === 'commonForm'
    ) {
        changeFacets.add('ui');
    }
    if (
        /\/Ext\/ObjectModule\.bsl$/i.test(normalizedPath)
        || /\/Ext\/ManagerModule\.bsl$/i.test(normalizedPath)
        || /\/Ext\/Module\.bsl$/i.test(normalizedPath)
        || scopeType === 'commonModule'
    ) {
        changeFacets.add('logic');
    }
    if (scopeType === 'role') {
        changeFacets.add('rights');
    }
    if (scopeType === 'subsystem' || scopeType === 'commonCommand' || scopeType === 'commandGroup' || scopeType === 'configuration') {
        changeFacets.add('navigation');
    }
    if (scopeType === 'language') {
        changeFacets.add('localization');
    }
    if (scopeType === 'report') {
        changeFacets.add('reporting');
    }
    if (
        scopeType === 'informationRegister'
        || scopeType === 'accumulationRegister'
        || scopeType === 'chartOfAccounts'
        || scopeType === 'chartOfCharacteristicTypes'
        || scopeType === 'chartOfCalculationTypes'
    ) {
        changeFacets.add('data');
    }
    if (
        scopeType === 'commonModule'
        || /Integration/i.test(normalizedPath)
        || /Exchange/i.test(normalizedPath)
    ) {
        changeFacets.add('integration');
    }
    if (normalizedPath.toLowerCase().endsWith('.xml')) {
        changeFacets.add('metadata');
    }
    if (changeFacets.size === 0) {
        changeFacets.add('logic');
    }

    return {
        normalizedPath,
        rootName,
        objectName,
        formName,
        scopeKey: objectName ? `${rootName}:${objectName}` : normalizedPath,
        scopeType,
        changeFacets: Array.from(changeFacets)
    };
}

function getScopeLabel(scopeType: TestingScopeType, outputLanguage: AiOutputLanguage): string {
    if (outputLanguage === 'en') {
        const englishLabels: Record<TestingScopeType, string> = {
            configuration: 'Configuration',
            document: 'Document',
            catalog: 'Catalog',
            informationRegister: 'Information register',
            accumulationRegister: 'Accumulation register',
            report: 'Report',
            dataProcessor: 'Data processor',
            commonModule: 'Common module',
            commonForm: 'Common form',
            role: 'Role',
            subsystem: 'Subsystem',
            commonCommand: 'Common command',
            commandGroup: 'Command group',
            language: 'Language',
            enumeration: 'Enumeration',
            constant: 'Constant',
            businessProcess: 'Business process',
            task: 'Task',
            session: 'Session setting',
            chartOfAccounts: 'Chart of accounts',
            chartOfCharacteristicTypes: 'Chart of characteristic types',
            chartOfCalculationTypes: 'Chart of calculation types',
            other: 'Configuration object'
        };

        return englishLabels[scopeType];
    }

    const russianLabels: Record<TestingScopeType, string> = {
        configuration: 'Конфигурация',
        document: 'Документ',
        catalog: 'Справочник',
        informationRegister: 'Регистр сведений',
        accumulationRegister: 'Регистр накопления',
        report: 'Отчет',
        dataProcessor: 'Обработка',
        commonModule: 'Общий модуль',
        commonForm: 'Общая форма',
        role: 'Роль',
        subsystem: 'Подсистема',
        commonCommand: 'Общая команда',
        commandGroup: 'Группа команд',
        language: 'Язык',
        enumeration: 'Перечисление',
        constant: 'Константа',
        businessProcess: 'Бизнес-процесс',
        task: 'Задача',
        session: 'Настройка сеанса',
        chartOfAccounts: 'План счетов',
        chartOfCharacteristicTypes: 'План видов характеристик',
        chartOfCalculationTypes: 'План видов расчета',
        other: 'Объект конфигурации'
    };

    return russianLabels[scopeType];
}

async function readTextFileCached(
    filePath: string,
    fileTextCache: Map<string, Promise<string | null>>
): Promise<string | null> {
    const cached = fileTextCache.get(filePath);
    if (cached) {
        return cached;
    }

    const nextValue = fs.promises.readFile(filePath, 'utf8')
        .then(text => text)
        .catch(() => null);
    fileTextCache.set(filePath, nextValue);
    return nextValue;
}

async function resolveMetadataDisplayName(
    absolutePath: string | null,
    fallbackName: string,
    fileTextCache: Map<string, Promise<string | null>>
): Promise<string> {
    if (!absolutePath) {
        return fallbackName;
    }

    const xmlText = await readTextFileCached(absolutePath, fileTextCache);
    if (!xmlText) {
        return fallbackName;
    }

    return extractFirstSynonymText(xmlText)
        || extractFirstTagValue(xmlText, 'Name')
        || fallbackName;
}

function getMetadataObjectXmlPath(configurationSourceDirectory: string, analysis: ConfigurationPathAnalysis): string | null {
    if (analysis.scopeType === 'configuration') {
        return path.join(configurationSourceDirectory, 'Configuration.xml');
    }

    if (!analysis.objectName) {
        return null;
    }

    if (analysis.scopeType === 'commonForm') {
        return path.join(configurationSourceDirectory, 'CommonForms', `${analysis.objectName}.xml`);
    }

    return path.join(configurationSourceDirectory, analysis.rootName, `${analysis.objectName}.xml`);
}

function getMetadataFormXmlPath(configurationSourceDirectory: string, analysis: ConfigurationPathAnalysis): string | null {
    if (!analysis.formName || !analysis.objectName || analysis.scopeType === 'commonForm') {
        return null;
    }

    return path.join(
        configurationSourceDirectory,
        analysis.rootName,
        analysis.objectName,
        'Forms',
        `${analysis.formName}.xml`
    );
}

async function buildTestingFocusAreas(
    context: ConfigurationDiffContext,
    outputLanguage: AiOutputLanguage
): Promise<TestingFocusArea[]> {
    const drafts = new Map<string, TestingFocusAreaDraft>();
    const fileTextCache = new Map<string, Promise<string | null>>();
    const sourceEntries: Array<{ path: string; configurationRelativePath: string; descriptor: string; score: number; }> = [
        ...context.changedFiles.map(entry => ({
            path: entry.path,
            configurationRelativePath: entry.configurationRelativePath,
            descriptor: entry.descriptor,
            score: entry.score
        })),
        ...context.untrackedFiles.map(entry => ({
            path: entry.path,
            configurationRelativePath: entry.configurationRelativePath,
            descriptor: entry.descriptor,
            score: entry.score
        }))
    ];

    for (const sourceEntry of sourceEntries) {
        const analysis = analyzeConfigurationPath(sourceEntry.configurationRelativePath);
        const objectDisplayName = await resolveMetadataDisplayName(
            getMetadataObjectXmlPath(context.configurationSourceDirectory, analysis),
            analysis.objectName || getScopeLabel(analysis.scopeType, outputLanguage),
            fileTextCache
        );
        const formDisplayName = analysis.formName
            ? await resolveMetadataDisplayName(
                getMetadataFormXmlPath(context.configurationSourceDirectory, analysis),
                analysis.formName,
                fileTextCache
            )
            : '';
        const title = analysis.scopeType === 'configuration'
            ? `${getScopeLabel(analysis.scopeType, outputLanguage)} "${objectDisplayName}"`
            : analysis.objectName
                ? `${getScopeLabel(analysis.scopeType, outputLanguage)} "${objectDisplayName || analysis.objectName}"`
                : `${getScopeLabel(analysis.scopeType, outputLanguage)} "${sourceEntry.configurationRelativePath}"`;

        let draft = drafts.get(analysis.scopeKey);
        if (!draft) {
            draft = {
                key: analysis.scopeKey,
                scopeType: analysis.scopeType,
                filePaths: new Set<string>(),
                descriptors: new Set<string>(),
                formNames: new Set<string>(),
                formTitles: new Set<string>(),
                changeFacets: new Set<ChangeFacet>(),
                score: 0,
                title
            };
            drafts.set(analysis.scopeKey, draft);
        }

        draft.filePaths.add(sourceEntry.path);
        draft.descriptors.add(sourceEntry.descriptor);
        draft.score = Math.max(draft.score, sourceEntry.score);
        analysis.changeFacets.forEach(facet => draft?.changeFacets.add(facet));
        if (analysis.formName) {
            draft.formNames.add(analysis.formName);
        }
        if (formDisplayName.length > 0) {
            draft.formTitles.add(formDisplayName);
        }
    }

    return Array.from(drafts.values())
        .map(draft => finalizeTestingFocusArea(draft, outputLanguage))
        .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
}

function finalizeTestingFocusArea(
    draft: TestingFocusAreaDraft,
    outputLanguage: AiOutputLanguage
): TestingFocusArea {
    return outputLanguage === 'en'
        ? finalizeTestingFocusAreaEnglish(draft)
        : finalizeTestingFocusAreaRussian(draft);
}

function finalizeTestingFocusAreaRussian(draft: TestingFocusAreaDraft): TestingFocusArea {
    const facets = draft.changeFacets;
    const changedForms = Array.from(draft.formTitles.values());
    const descriptors = Array.from(draft.descriptors.values());
    const checkFirst: string[] = [];
    const runScenarios: string[] = [];
    const dataAndRoles: string[] = [];
    const nearbyRisks: string[] = [];
    let testerMeaning = 'Похоже, меняется пользовательское поведение этого объекта. Стоит пройти типовой сценарий, проверить сообщения об ошибках и убедиться, что рядом ничего не поехало.';

    switch (draft.scopeType) {
        case 'document':
            testerMeaning = facets.has('ui') && facets.has('logic')
                ? 'Похоже, меняется и экранная форма документа, и его рабочая логика. Для тестировщика это значит: нужно проверить не только то, что видно на форме, но и итог после записи, проведения и повторного открытия документа.'
                : facets.has('ui')
                    ? 'Похоже, меняется форма документа. Для пользователя это обычно проявляется в полях, кнопках, командах, автозаполнении и реакции формы на действия.'
                    : 'Похоже, меняются правила работы документа. Пользователь чаще всего заметит это при создании, записи, проведении, отмене проведения или повторном открытии документа.';
            pushUnique(checkFirst, [
                'Открыть документ и пройти основной сценарий создания или редактирования без ошибок.',
                facets.has('ui') ? 'Проверить ключевые поля, кнопки, команды и автоподстановки на форме.' : '',
                facets.has('logic') ? 'Записать документ, а если это рабочий сценарий, провести, перепровести и отменить проведение.' : ''
            ]);
            pushUnique(runScenarios, [
                'Прогнать happy path с типовыми данными.',
                'Прогнать сценарий с некорректными или неполными данными и проверить, что отказ понятный для пользователя.',
                'Проверить повторное открытие уже записанного документа и типовой сценарий исправления.'
            ]);
            pushUnique(dataAndRoles, [
                'Подготовить пользователя с обычной рабочей ролью.',
                'Нужны данные, при которых документ можно успешно провести, и отдельный набор, где система должна корректно отказать.'
            ]);
            pushUnique(nearbyRisks, [
                'Могут затронуться движения по регистрам, отчеты, печатные формы и связанные документы.',
                'Если документ участвует в цепочке бизнес-процесса, стоит прогнать соседние шаги до и после него.'
            ]);
            break;
        case 'catalog':
            testerMeaning = facets.has('ui') && facets.has('logic')
                ? 'Похоже, меняется и форма, и логика справочника. Это может проявиться при создании, редактировании, поиске и выборе элемента в других документах.'
                : facets.has('ui')
                    ? 'Похоже, меняется форма справочника. Пользователь заметит это в списке, карточке элемента, кнопках и доступных действиях.'
                    : 'Похоже, меняются правила работы справочника. Это может проявиться при записи элемента, проверках заполнения и использовании справочника в других сценариях.';
            pushUnique(checkFirst, [
                'Открыть список и карточку элемента, проверить основные поля и команды.',
                'Создать новый элемент, записать его и отредактировать существующий.',
                'Проверить выбор этого справочника в зависимом документе или форме.'
            ]);
            pushUnique(runScenarios, [
                'Прогнать сценарий с созданием элемента.',
                'Проверить поиск, фильтрацию и повторный выбор ранее созданного элемента.',
                'Проверить сообщения пользователю на обязательных полях.'
            ]);
            pushUnique(dataAndRoles, [
                'Подготовить данные для создания нового элемента и пользователя с обычными правами редактирования.',
                'Если справочник используется в других разделах, нужен сценарий, где его выбирают из документа или обработки.'
            ]);
            pushUnique(nearbyRisks, [
                'Могут затронуться документы, отчеты и обработки, которые используют этот справочник.',
                'Если менялась форма списка, стоит проверить массовые действия и быстрый поиск.'
            ]);
            break;
        case 'report':
            testerMeaning = 'Похоже, меняется отчет: его форма, параметры или результат построения. Для тестировщика это прежде всего проверка того, что отчет открывается, строится и показывает ожидаемые данные.';
            pushUnique(checkFirst, [
                'Открыть отчет и проверить, что форма параметров и команды работают без ошибок.',
                'Построить отчет на типовых данных.',
                'Построить отчет на пустых или граничных данных и проверить понятное поведение.'
            ]);
            pushUnique(runScenarios, [
                'Проверить основные фильтры, варианты настроек и пересчет итогов.',
                'Если есть расшифровки, drill-down или печать, пройти их отдельно.',
                'Сравнить результат с ожидаемыми контрольными значениями.'
            ]);
            pushUnique(dataAndRoles, [
                'Нужны данные, на которых отчет не пустой, и данные, на которых он должен быть пустым.',
                'Подготовить пользователя, который обычно работает с этим отчетом.'
            ]);
            pushUnique(nearbyRisks, [
                'Могут затронуться дашборды, регламентные проверки и сценарии, где этот отчет используется как контрольный источник.',
                'Если отчет зависит от движений документов, стоит прогнать и формирующие документы.'
            ]);
            break;
        case 'dataProcessor':
            testerMeaning = 'Похоже, меняется обработка. Пользовательский риск здесь в том, что основной запуск, параметры или итоговый результат обработки могут работать иначе.';
            pushUnique(checkFirst, [
                'Открыть обработку и пройти основной сценарий использования.',
                'Проверить главную команду или кнопку запуска.',
                'Проверить сообщения об ошибках, если не хватает входных данных.'
            ]);
            pushUnique(runScenarios, [
                'Прогнать основной happy path.',
                'Прогнать сценарий повторного запуска и сценарий с неполными данными.',
                'Если обработка что-то изменяет массово, проверить результат на нескольких объектах.'
            ]);
            pushUnique(dataAndRoles, [
                'Подготовить пользователя с обычной ролью и данные для типового запуска.',
                'Если обработка влияет на документы или регистры, нужны контрольные данные до и после запуска.'
            ]);
            pushUnique(nearbyRisks, [
                'Могут затронуться объекты, которые обработка изменяет или создает.',
                'Если обработка запускается по расписанию или из другого раздела, стоит проверить и этот путь.'
            ]);
            break;
        case 'commonModule':
            testerMeaning = 'Есть изменение в общем модуле. Для тестировщика это знак, что может поменяться не одна конкретная форма, а общий механизм, который используется в нескольких сценариях.';
            pushUnique(checkFirst, [
                'Определить 2-3 основных пользовательских сценария, которые используют этот общий механизм, и прогнать их руками.',
                'Проверить не только happy path, но и понятную реакцию системы на ошибочные или неполные данные.'
            ]);
            pushUnique(runScenarios, [
                'Пройти самые частые пользовательские маршруты, где ожидается эта логика.',
                'Проверить повторное выполнение, отмену действия и сценарий с отказом.'
            ]);
            pushUnique(dataAndRoles, [
                'Нужны типовые входные данные и хотя бы один пограничный набор.',
                'Если модуль связан с правами или интеграцией, подготовить пользователя с ограниченными правами и сценарий внешнего обмена.'
            ]);
            pushUnique(nearbyRisks, [
                'Риск широкий: могут задеться сразу несколько разделов, документов или обработок.',
                'Если после изменения падают разные сценарии, общий модуль стоит проверять одним из первых.'
            ]);
            break;
        case 'commonForm':
            testerMeaning = 'Похоже, меняется общая форма. Для пользователя это обычно видно в окне, которое используется в нескольких местах системы.';
            pushUnique(checkFirst, [
                'Открыть форму из всех типовых точек входа, откуда ей реально пользуются.',
                'Проверить кнопки, поля, доступность команд и отсутствие ошибок при закрытии/подтверждении.'
            ]);
            pushUnique(runScenarios, [
                'Пройти основной сценарий на форме.',
                'Проверить сценарий отмены, повторного открытия и работы с уже заполненными данными.'
            ]);
            pushUnique(dataAndRoles, [
                'Подготовить пользователя, который реально использует эту форму в работе.',
                'Если форма зависит от предварительного выбора объекта, нужен сценарий с корректным и некорректным контекстом.'
            ]);
            pushUnique(nearbyRisks, [
                'Если форма общая, она может использоваться сразу в нескольких разделах.',
                'Стоит проверить не один вход в форму, а все основные точки запуска.'
            ]);
            break;
        case 'role':
            testerMeaning = 'Похоже, меняются права доступа. Для тестировщика это прежде всего проверка того, что нужные пользователи по-прежнему видят свои разделы и могут выполнять ожидаемые действия, а лишние права не открылись.';
            pushUnique(checkFirst, [
                'Войти минимум под двумя пользователями: у кого доступ должен быть, и у кого доступа быть не должно.',
                'Проверить открытие разделов, форм, документов и доступность команд записи/проведения/изменения.'
            ]);
            pushUnique(runScenarios, [
                'Прогнать сценарий разрешенного действия.',
                'Прогнать сценарий, где система должна отказать по правам.',
                'Проверить, что пользователь не видит лишние команды и данные.'
            ]);
            pushUnique(dataAndRoles, [
                'Нужны тестовые пользователи с разными ролями и понятным ожидаемым уровнем доступа.',
                'Если роли завязаны на подразделение, организацию или область данных, нужен набор данных для каждой такой ветки.'
            ]);
            pushUnique(nearbyRisks, [
                'Могут неожиданно измениться видимость разделов, команд, реквизитов и даже результаты отчетов.',
                'После изменений в правах стоит сделать короткий смоук по ключевым разделам под основными ролями.'
            ]);
            break;
        case 'informationRegister':
        case 'accumulationRegister':
        case 'chartOfAccounts':
        case 'chartOfCharacteristicTypes':
        case 'chartOfCalculationTypes':
            testerMeaning = 'Похоже, меняются данные или расчеты, которые пользователь замечает не напрямую в коде, а по итоговому поведению документов, отчетов и остатков.';
            pushUnique(checkFirst, [
                'Прогнать пользовательский сценарий, который пишет данные в этот механизм, и проверить итоговый результат.',
                'Сверить суммы, остатки, статусы или записи до и после действия.'
            ]);
            pushUnique(runScenarios, [
                'Проверить типовой сценарий записи данных.',
                'Проверить отмену, повторное выполнение и сценарий исправления уже записанных данных.',
                'Прогнать связанные отчеты или расшифровки.'
            ]);
            pushUnique(dataAndRoles, [
                'Нужны контрольные данные, на которых легко увидеть изменение результата.',
                'Желательно подготовить ожидаемые значения заранее, чтобы сравнение было не на глаз.'
            ]);
            pushUnique(nearbyRisks, [
                'Могут задеться документы-источники, отчеты и контрольные проверки, которые используют эти данные.',
                'Если расчет менялся, стоит проверить не только текущий шаг, но и итоговые отчеты.'
            ]);
            break;
        case 'subsystem':
        case 'commonCommand':
        case 'commandGroup':
        case 'configuration':
            testerMeaning = 'Похоже, меняются разделы, команды, состав подсистемы или общая навигация. Для пользователя это может выглядеть как другие пункты меню, доступность команд или новый порядок входа в сценарий.';
            pushUnique(checkFirst, [
                'Открыть ключевые разделы и проверить, что команды видны там, где их ждут пользователи.',
                'Проверить запуск форм и обработок из меню, панелей и команд.'
            ]);
            pushUnique(runScenarios, [
                'Прогнать короткий смоук по основным пользовательским разделам.',
                'Проверить сценарий перехода из раздела в форму, документ или обработку.'
            ]);
            pushUnique(dataAndRoles, [
                'Подготовить пользователя с обычной рабочей ролью.',
                'Если команды видны не всем, нужен еще пользователь с ограниченными правами.'
            ]);
            pushUnique(nearbyRisks, [
                'Пользователи могут не найти прежнюю точку входа даже если сама логика не сломалась.',
                'После таких изменений полезен короткий смоук по всей навигации раздела.'
            ]);
            break;
        case 'language':
            testerMeaning = 'Похоже, меняются тексты интерфейса. Для тестировщика это история про подписи, сообщения, команды и локализацию, а не про бизнес-логику как таковую.';
            pushUnique(checkFirst, [
                'Проверить подписи на форме, названия команд и текст пользовательских сообщений.',
                'Если продукт работает на нескольких языках, сравнить оба варианта.'
            ]);
            pushUnique(runScenarios, [
                'Прогнать сценарий, где система показывает типовые ошибки или предупреждения.',
                'Проверить длинные подписи, переносы и обрезание текста в интерфейсе.'
            ]);
            pushUnique(dataAndRoles, [
                'Нужен сценарий, в котором система гарантированно показывает все важные сообщения.',
                'Если используются разные языки интерфейса, подготовить окружение для каждого языка.'
            ]);
            pushUnique(nearbyRisks, [
                'Могут поехать автотесты, завязанные на текст кнопок, заголовков и сообщений.',
                'Пользовательские инструкции и документация тоже могут потребовать обновления.'
            ]);
            break;
        default:
            testerMeaning = 'Похоже, меняется поведение объекта конфигурации. Без привязки к коду это повод пройти типовой пользовательский маршрут, проверить ошибочные ветки и посмотреть, не задело ли соседние сценарии.';
            pushUnique(checkFirst, [
                'Пройти основной пользовательский сценарий, где этот объект используется.',
                'Проверить сообщения об ошибках и повторное выполнение.'
            ]);
            pushUnique(runScenarios, [
                'Прогнать happy path и одну негативную ветку.',
                'Проверить соседний сценарий, который использует тот же объект.'
            ]);
            pushUnique(dataAndRoles, [
                'Нужны типовые данные и пользователь с обычной рабочей ролью.',
                'Если поведение зависит от прав или состояния данных, подготовить отдельный сценарий для каждого случая.'
            ]);
            pushUnique(nearbyRisks, [
                'Могут задеться соседние документы, формы, отчеты или обработки, которые используют этот объект.'
            ]);
            break;
    }

    if (changedForms.length > 0) {
        nearbyRisks.unshift(`Отдельно проверить формы: ${changedForms.join(', ')}.`);
    }
    if (descriptors.length > 0) {
        nearbyRisks.push(`Технически затронутые зоны: ${descriptors.join('; ')}.`);
    }

    return {
        title: draft.title,
        filePaths: Array.from(draft.filePaths.values()).sort(),
        descriptors,
        testerMeaning,
        checkFirst,
        runScenarios,
        dataAndRoles,
        nearbyRisks,
        score: draft.score
    };
}

function finalizeTestingFocusAreaEnglish(draft: TestingFocusAreaDraft): TestingFocusArea {
    const descriptors = Array.from(draft.descriptors.values());
    const changedForms = Array.from(draft.formTitles.values());
    const checkFirst: string[] = [];
    const runScenarios: string[] = [];
    const dataAndRoles: string[] = [];
    const nearbyRisks: string[] = [];
    let testerMeaning = 'This change may alter user-visible behavior. Run the main user path, validate errors, and verify that nearby scenarios still behave correctly.';

    switch (draft.scopeType) {
        case 'document':
            testerMeaning = 'This looks like a document change. Test not only what the user sees on the form, but also save/post/reopen behavior and the business result after the action.';
            pushUnique(checkFirst, [
                'Open the document and complete the main create/edit flow without errors.',
                'Save the document and, when relevant, post, repost, and cancel posting.',
                'Check the main fields, buttons, commands, and validation messages.'
            ]);
            pushUnique(runScenarios, [
                'Run the happy path with normal data.',
                'Run a negative path with incomplete or invalid data.',
                'Reopen an existing document and verify an edit scenario.'
            ]);
            pushUnique(dataAndRoles, [
                'Prepare a standard working user and data that should pass.',
                'Also prepare data that should fail in a controlled way.'
            ]);
            pushUnique(nearbyRisks, [
                'Neighboring reports, printed forms, register movements, and linked documents may be affected.'
            ]);
            break;
        case 'catalog':
            testerMeaning = 'This looks like a catalog change. Test list/card behavior, create/edit flows, and any place where users select this catalog from another object.';
            pushUnique(checkFirst, [
                'Open the list and card form, then create and edit an item.',
                'Verify search, selection, and required-field validation.'
            ]);
            pushUnique(runScenarios, [
                'Run the happy path for creating an item.',
                'Use the catalog from a dependent document or form.'
            ]);
            pushUnique(dataAndRoles, [
                'Prepare a normal user and data for a new and an existing item.'
            ]);
            pushUnique(nearbyRisks, [
                'Dependent documents, reports, and processors may be affected.'
            ]);
            break;
        case 'report':
            testerMeaning = 'This looks like a report change. For testers, that usually means checking the parameter form, report build result, totals, and behavior on empty data.';
            pushUnique(checkFirst, [
                'Open the report and build it with normal data.',
                'Repeat the build with empty or edge-case data.',
                'Verify filters, totals, and key commands.'
            ]);
            pushUnique(runScenarios, [
                'Run the main report scenario.',
                'If drill-down, print, or export exists, verify them separately.'
            ]);
            pushUnique(dataAndRoles, [
                'Prepare both non-empty and empty datasets and a normal reporting user.'
            ]);
            pushUnique(nearbyRisks, [
                'Dashboards and downstream checks that rely on this report may be affected.'
            ]);
            break;
        case 'role':
            testerMeaning = 'This looks like an access-rights change. Test what users can see, open, create, edit, post, and what they must no longer be allowed to do.';
            pushUnique(checkFirst, [
                'Sign in as a user who should have access and a user who should not.',
                'Verify visibility of sections, forms, commands, and data.',
                'Check both allowed and denied actions.'
            ]);
            pushUnique(runScenarios, [
                'Run one positive permission scenario and one negative scenario.',
                'Verify that no extra commands or data became visible.'
            ]);
            pushUnique(dataAndRoles, [
                'Prepare test users with different roles and clearly expected access levels.'
            ]);
            pushUnique(nearbyRisks, [
                'Section visibility, command visibility, and even report results may change unexpectedly.'
            ]);
            break;
        default:
            testerMeaning = 'This change should be explained to testers in product language: run the main user flow, check one negative branch, and verify nearby scenarios that use the same object or mechanism.';
            pushUnique(checkFirst, [
                'Run the main user scenario that uses this object.',
                'Check a negative or edge-case branch.'
            ]);
            pushUnique(runScenarios, [
                'Run the happy path and one nearby scenario that depends on the same logic.'
            ]);
            pushUnique(dataAndRoles, [
                'Prepare normal data and a standard user role.'
            ]);
            pushUnique(nearbyRisks, [
                'Neighboring forms, documents, reports, or processors may be affected.'
            ]);
            break;
    }

    if (changedForms.length > 0) {
        nearbyRisks.unshift(`Pay special attention to forms: ${changedForms.join(', ')}.`);
    }
    if (descriptors.length > 0) {
        nearbyRisks.push(`Technical areas touched: ${descriptors.join('; ')}.`);
    }

    return {
        title: draft.title,
        filePaths: Array.from(draft.filePaths.values()).sort(),
        descriptors,
        testerMeaning,
        checkFirst,
        runScenarios,
        dataAndRoles,
        nearbyRisks,
        score: draft.score
    };
}

function buildTestingFocusAreasMarkdown(
    testingFocusAreas: TestingFocusArea[],
    outputLanguage: AiOutputLanguage,
    limit: number
): string {
    const selectedAreas = testingFocusAreas.slice(0, Math.max(0, limit));
    if (selectedAreas.length === 0) {
        return outputLanguage === 'en'
            ? '## Auto testing hints\n\nNo focused testing hints were generated.'
            : '## Автоматические подсказки для тестировщика\n\nНет подготовленных подсказок по зонам тестирования.';
    }

    const lines: string[] = [
        outputLanguage === 'en'
            ? '## Auto testing hints'
            : '## Автоматические подсказки для тестировщика',
        '',
        outputLanguage === 'en'
            ? 'This block is generated before the LLM report and translates file changes into product-level testing hints.'
            : 'Этот блок собран автоматически до ответа LLM и переводит изменения файлов в понятные подсказки для тестировщика.',
        ''
    ];

    for (const area of selectedAreas) {
        lines.push(`### ${area.title}`);
        lines.push('');
        lines.push(outputLanguage === 'en' ? 'What this means:' : 'Что это значит:');
        lines.push(`- ${area.testerMeaning}`);
        lines.push('');
        lines.push(outputLanguage === 'en' ? 'Check first:' : 'Сначала проверьте:');
        area.checkFirst.forEach(item => lines.push(`- ${item}`));
        lines.push('');
        lines.push(outputLanguage === 'en' ? 'Run these scenarios:' : 'Какие сценарии прогнать:');
        area.runScenarios.forEach(item => lines.push(`- ${item}`));
        lines.push('');
        lines.push(outputLanguage === 'en' ? 'Prepare data and roles:' : 'Какие данные и роли подготовить:');
        area.dataAndRoles.forEach(item => lines.push(`- ${item}`));
        lines.push('');
        lines.push(outputLanguage === 'en' ? 'Watch nearby areas:' : 'Что может задеть рядом:');
        area.nearbyRisks.forEach(item => lines.push(`- ${item}`));
        lines.push('');
        lines.push(outputLanguage === 'en' ? 'Touched files:' : 'Затронутые файлы:');
        area.filePaths.slice(0, 6).forEach(filePath => lines.push(`- \`${filePath}\``));
        if (area.filePaths.length > 6) {
            lines.push(outputLanguage === 'en'
                ? `- ... and ${area.filePaths.length - 6} more files`
                : `- ... и еще ${area.filePaths.length - 6} файлов`);
        }
        lines.push('');
    }

    return lines.join('\n').trim();
}

function parseChangedFiles(
    nameStatusOutput: string,
    configurationSourceDirectoryRelativePath: string
): ChangedFileEntry[] {
    const result: ChangedFileEntry[] = [];

    for (const rawLine of nameStatusOutput.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        const parts = line.split('\t');
        if (parts.length < 2) {
            continue;
        }

        const statusToken = parts[0];
        const status = statusToken.charAt(0) || statusToken;
        if ((status === 'R' || status === 'C') && parts.length >= 3) {
            const nextPath = parts[2];
            const configurationRelativePath = toConfigurationRelativePath(nextPath, configurationSourceDirectoryRelativePath);
            result.push({
                status,
                path: nextPath,
                configurationRelativePath,
                oldPath: parts[1],
                descriptor: describeConfigurationPath(configurationRelativePath),
                score: scoreConfigurationPath(configurationRelativePath)
            });
            continue;
        }

        const nextPath = parts[1];
        const configurationRelativePath = toConfigurationRelativePath(nextPath, configurationSourceDirectoryRelativePath);
        result.push({
            status,
            path: nextPath,
            configurationRelativePath,
            descriptor: describeConfigurationPath(configurationRelativePath),
            score: scoreConfigurationPath(configurationRelativePath)
        });
    }

    return result;
}

function parseUntrackedFiles(statusOutput: string): string[] {
    const result: string[] = [];
    for (const rawLine of statusOutput.split('\n')) {
        if (!rawLine.startsWith('?? ')) {
            continue;
        }

        const relativePath = rawLine.slice(3).trim();
        if (relativePath.length > 0) {
            result.push(relativePath);
        }
    }

    return result;
}

function truncateText(value: string, maxChars: number, marker: string): string {
    if (value.length <= maxChars) {
        return value;
    }

    return `${value.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

async function collectUntrackedFiles(
    repositoryRootPath: string,
    relativePaths: string[],
    configurationSourceDirectoryRelativePath: string
): Promise<UntrackedFileEntry[]> {
    const rankedPaths = relativePaths
        .map(relativePath => ({
            relativePath,
            configurationRelativePath: toConfigurationRelativePath(relativePath, configurationSourceDirectoryRelativePath),
            score: scoreConfigurationPath(toConfigurationRelativePath(relativePath, configurationSourceDirectoryRelativePath))
        }))
        .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
        .slice(0, 20);

    const result: UntrackedFileEntry[] = [];
    for (const entry of rankedPaths) {
        const absolutePath = path.join(repositoryRootPath, entry.relativePath);
        let excerpt = '[failed to read file]';
        try {
            const fileContent = await fs.promises.readFile(absolutePath, 'utf8');
            excerpt = truncateText(fileContent, 2500, '\n... [file truncated] ...');
        } catch {
            // Ignore read errors and keep a diagnostic placeholder.
        }

        result.push({
            path: entry.relativePath,
            configurationRelativePath: entry.configurationRelativePath,
            descriptor: describeConfigurationPath(entry.configurationRelativePath),
            score: entry.score,
            excerpt
        });
    }

    return result;
}

function splitDiffIntoPatches(rawDiff: string): DiffPatch[] {
    const lines = rawDiff.split('\n');
    const patches: DiffPatch[] = [];
    let currentLines: string[] = [];
    let currentPath = '';
    let currentIndex = 0;

    const flushCurrentPatch = (): void => {
        if (currentLines.length === 0) {
            return;
        }

        const patchText = currentLines.join('\n').trim();
        if (!patchText) {
            currentLines = [];
            currentPath = '';
            return;
        }

        patches.push({
            path: currentPath,
            text: patchText,
            score: scoreConfigurationPath(currentPath),
            index: currentIndex++
        });
        currentLines = [];
        currentPath = '';
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            flushCurrentPatch();
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            currentPath = match?.[2] || match?.[1] || '';
            currentLines.push(line);
            continue;
        }

        if (currentLines.length > 0) {
            currentLines.push(line);
        }
    }

    flushCurrentPatch();
    return patches;
}

function compactPatchText(patch: DiffPatch): string {
    const perPatchLimit = patch.score >= 11
        ? 3600
        : patch.score >= 8
            ? 2200
            : 1200;
    if (patch.text.length <= perPatchLimit) {
        return patch.text;
    }

    const lines = patch.text.split('\n');
    const selectedLines: string[] = [];
    let currentLength = 0;
    for (const line of lines) {
        const important = line.startsWith('diff --git ')
            || line.startsWith('index ')
            || line.startsWith('--- ')
            || line.startsWith('+++ ')
            || line.startsWith('rename ')
            || line.startsWith('new file mode ')
            || line.startsWith('deleted file mode ')
            || line.startsWith('similarity index ')
            || line.startsWith('@@ ')
            || line.startsWith('+')
            || line.startsWith('-');
        if (!important) {
            continue;
        }

        const nextLength = currentLength === 0 ? line.length : currentLength + 1 + line.length;
        if (nextLength > perPatchLimit - 28) {
            break;
        }

        selectedLines.push(line);
        currentLength = nextLength;
    }

    selectedLines.push('... [patch trimmed] ...');
    return selectedLines.join('\n');
}

function compactTrackedDiff(rawDiff: string, maxChars: number): string {
    if (rawDiff.length <= maxChars) {
        return rawDiff.trim();
    }

    const patches = splitDiffIntoPatches(rawDiff);
    if (patches.length === 0) {
        return truncateText(rawDiff.trim(), maxChars, '\n... [diff trimmed] ...');
    }

    const rankedPatches = [...patches]
        .sort((left, right) => right.score - left.score || left.index - right.index);
    const selectedIndices = new Set<number>();
    const compactedByIndex = new Map<number, string>();
    let totalLength = 0;

    for (const patch of rankedPatches) {
        const compactedText = compactPatchText(patch);
        const nextLength = totalLength === 0 ? compactedText.length : totalLength + 2 + compactedText.length;
        if (nextLength > maxChars - 24) {
            continue;
        }

        selectedIndices.add(patch.index);
        compactedByIndex.set(patch.index, compactedText);
        totalLength = nextLength;
    }

    if (selectedIndices.size === 0) {
        return truncateText(rawDiff.trim(), maxChars, '\n... [diff trimmed] ...');
    }

    const compactedChunks = patches
        .filter(patch => selectedIndices.has(patch.index))
        .map(patch => compactedByIndex.get(patch.index) || patch.text);

    return `${compactedChunks.join('\n\n')}\n... [diff trimmed] ...`;
}

export async function buildConfigurationDiffContext(): Promise<ConfigurationDiffContext> {
    const configurationSourceDirectory = await resolveConfiguredConfigurationSourceDirectory();
    const repositoryRootPath = await resolveRepositoryRoot(configurationSourceDirectory);
    if (!isPathInside(repositoryRootPath, configurationSourceDirectory)) {
        throw new Error(vscode.l10n.t(
            'Configuration source directory "{0}" is outside the git repository "{1}".',
            configurationSourceDirectory,
            repositoryRootPath
        ));
    }

    const configurationSourceDirectoryRelativePath = normalizePathSeparators(
        path.relative(repositoryRootPath, configurationSourceDirectory)
    );
    const baseRef = await resolveMainBranchRef(repositoryRootPath);
    const mergeBase = await resolveMergeBase(repositoryRootPath, baseRef);
    const currentBranch = await resolveCurrentBranchName(repositoryRootPath);
    const trackedDiffText = await execGit(
        repositoryRootPath,
        ['diff', '--find-renames', '--find-copies', '--unified=0', mergeBase, '--', configurationSourceDirectoryRelativePath]
    ) || '';
    const changedFiles = parseChangedFiles(
        await execGit(
            repositoryRootPath,
            ['diff', '--name-status', '--find-renames', '--find-copies', mergeBase, '--', configurationSourceDirectoryRelativePath]
        ) || '',
        configurationSourceDirectoryRelativePath
    );
    const untrackedRelativePaths = parseUntrackedFiles(
        await execGit(
            repositoryRootPath,
            ['status', '--porcelain=1', '--untracked-files=all', '--', configurationSourceDirectoryRelativePath]
        ) || ''
    );
    const untrackedFiles = await collectUntrackedFiles(
        repositoryRootPath,
        untrackedRelativePaths,
        configurationSourceDirectoryRelativePath
    );

    return {
        repositoryRootPath,
        configurationSourceDirectory,
        configurationSourceDirectoryRelativePath,
        currentBranch,
        baseRef,
        mergeBase,
        changedFiles,
        untrackedFiles,
        trackedDiffText
    };
}

async function resolveConfigurationDiffReportStorageContext(): Promise<ConfigurationDiffReportStorageContext> {
    const configurationSourceDirectory = await resolveConfiguredConfigurationSourceDirectory();
    const repositoryRootPath = await resolveRepositoryRoot(configurationSourceDirectory);
    if (!isPathInside(repositoryRootPath, configurationSourceDirectory)) {
        throw new Error(vscode.l10n.t(
            'Configuration source directory "{0}" is outside the git repository "{1}".',
            configurationSourceDirectory,
            repositoryRootPath
        ));
    }

    const currentBranch = await resolveCurrentBranchName(repositoryRootPath);
    const runtimeRootUri = resolveRuntimeRootUri(repositoryRootPath);
    const reportsDirectoryUri = vscode.Uri.joinPath(runtimeRootUri, 'configuration-diff-ai-reports');
    const reportUri = vscode.Uri.joinPath(
        reportsDirectoryUri,
        sanitizeBranchNameForReportFile(currentBranch)
    );

    return {
        repositoryRootPath,
        configurationSourceDirectory,
        currentBranch,
        reportsDirectoryUri,
        reportUri
    };
}

function formatChangedFileLine(entry: ChangedFileEntry): string {
    const renamePart = entry.oldPath
        ? `\`${entry.oldPath}\` -> \`${entry.path}\``
        : `\`${entry.path}\``;
    return `- [${entry.status}] ${renamePart} - ${entry.descriptor}`;
}

function formatUntrackedFileLine(entry: UntrackedFileEntry): string {
    return `- [U] \`${entry.path}\` - ${entry.descriptor}`;
}

function buildConfigurationDiffPrompt(
    context: ConfigurationDiffContext,
    testingFocusAreas: TestingFocusArea[],
    outputLanguage: AiOutputLanguage,
    userStoryText: string,
    options: {
        diffCharLimit: number;
        changedFileLimit: number;
        includeUntrackedContents: boolean;
        testingFocusAreaLimit: number;
    }
): string {
    const changedFileLines = context.changedFiles
        .slice()
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, options.changedFileLimit)
        .map(formatChangedFileLine);
    const remainingChangedFileCount = Math.max(0, context.changedFiles.length - changedFileLines.length);
    const untrackedFileLines = context.untrackedFiles.map(formatUntrackedFileLine);
    const compactedDiff = compactTrackedDiff(context.trackedDiffText, options.diffCharLimit);
    const mergeBaseShort = context.mergeBase.slice(0, 12);
    const testingHintsMarkdown = buildTestingFocusAreasMarkdown(
        testingFocusAreas,
        outputLanguage,
        options.testingFocusAreaLimit
    );
    const normalizedUserStory = userStoryText.trim();

    if (outputLanguage === 'en') {
        return [
            'Analyze the 1C configuration source diff versus the main branch and prepare a detailed markdown report for testers.',
            'Write in plain product language. Assume the reader is a tester who rarely opens 1C configuration code and wants to understand what to do in the product UI.',
            'Rules:',
            '- Use only the diff, file paths and metadata from this prompt.',
            '- If a UserStory is provided, use it as the intent context when analyzing the changes.',
            '- Separate confident conclusions from hypotheses.',
            '- Refer to concrete file paths in every bullet using backticks.',
            '- Focus on user-visible behavior, regression risk, UI impact, business logic, access rights, data preparation, and nearby scenarios that should be retested.',
            '- Prefer phrases like "check opening the form", "create the document", "post the document", "run the report", "sign in under a restricted role".',
            '- Avoid unexplained code jargon. If you mention a technical object, immediately explain what it means for a tester.',
            '- Do not retell the entire diff.',
            '',
            'Return these sections in markdown:',
            '## What this means for the tester',
            '## What to check first manually',
            '## Which user scenarios to run',
            '## Which data and roles to prepare',
            '## What nearby functionality may break',
            '## Where the conclusion is uncertain',
            '',
            'Repository context:',
            `- Current branch: ${context.currentBranch}`,
            `- Main branch ref: ${context.baseRef}`,
            `- Merge base: ${mergeBaseShort}`,
            `- Configuration directory: ${context.configurationSourceDirectoryRelativePath}`,
            `- Tracked changed files: ${context.changedFiles.length}`,
            `- Untracked files: ${context.untrackedFiles.length}`,
            '',
            `UserStory: ${normalizedUserStory.length > 0 ? 'provided' : 'not provided'}`,
            ...(normalizedUserStory.length > 0
                ? [
                    '```text',
                    truncateText(normalizedUserStory, 4000, '\n... [UserStory truncated] ...'),
                    '```'
                ]
                : []),
            '',
            'Changed files:',
            ...(changedFileLines.length > 0 ? changedFileLines : ['- no tracked changed files']),
            ...(remainingChangedFileCount > 0 ? [`- ... and ${remainingChangedFileCount} more tracked files`] : []),
            ...(untrackedFileLines.length > 0 ? ['', 'Untracked new files:', ...untrackedFileLines] : []),
            '',
            'Tracked diff excerpt:',
            '```diff',
            compactedDiff || '[no tracked diff lines]',
            '```',
            '',
            'Auto-generated testing hints:',
            testingHintsMarkdown,
            ...(options.includeUntrackedContents && context.untrackedFiles.length > 0
                ? [
                    '',
                    'Untracked file excerpts:',
                    ...context.untrackedFiles.map(entry => [
                        `### ${entry.path}`,
                        '```text',
                        entry.excerpt || '[empty file]',
                        '```'
                    ].join('\n'))
                ]
                : [])
        ].join('\n');
    }

    return [
        'Проанализируй diff файловой выгрузки конфигурации 1С относительно главной ветки и подготовь подробный markdown-отчет именно для тестировщика.',
        'Пиши простым пользовательским языком. Представь, что читатель редко открывает код конфигурации и хочет понять, что ему делать в продукте: какие сценарии прогнать, какие роли взять и где ждать сюрпризы.',
        'Правила:',
        '- Делай выводы только по diff, путям файлов и метаданным из этого prompt.',
        '- Если передан UserStory, используй его как контекст намерения задачи при анализе изменений.',
        '- Отдельно помечай уверенные выводы и гипотезы.',
        '- В каждом пункте ссылайся на конкретные пути файлов в backticks.',
        '- Фокусируйся на пользовательском поведении, рисках регрессии, UI-эффекте, бизнес-логике, правах, подготовке данных и соседних сценариях, которые стоит перепроверить.',
        '- Предпочитай формулировки вроде "открыть форму", "создать документ", "провести документ", "сформировать отчет", "зайти под ограниченной ролью".',
        '- Избегай непоясненного технического жаргона. Если упоминаешь технический объект, сразу переводи это в понятное действие для тестировщика.',
        '- Не пересказывай весь diff.',
        '',
        'Верни разделы в markdown:',
        '## Что это значит для тестировщика',
        '## Что проверить руками в первую очередь',
        '## Какие пользовательские сценарии прогнать',
        '## Какие данные и роли подготовить',
        '## Что может зацепить рядом',
        '## Где вывод не до конца уверенный',
        '',
        'Контекст репозитория:',
        `- Текущая ветка: ${context.currentBranch}`,
        `- Главная ветка: ${context.baseRef}`,
        `- Merge base: ${mergeBaseShort}`,
        `- Каталог конфигурации: ${context.configurationSourceDirectoryRelativePath}`,
        `- Измененных tracked-файлов: ${context.changedFiles.length}`,
        `- Untracked-файлов: ${context.untrackedFiles.length}`,
        '',
        `UserStory: ${normalizedUserStory.length > 0 ? 'передан' : 'не передан'}`,
        ...(normalizedUserStory.length > 0
            ? [
                '```text',
                truncateText(normalizedUserStory, 4000, '\n... [UserStory truncated] ...'),
                '```'
            ]
            : []),
        '',
        'Измененные файлы:',
        ...(changedFileLines.length > 0 ? changedFileLines : ['- tracked-изменения не найдены']),
        ...(remainingChangedFileCount > 0 ? [`- ... и еще ${remainingChangedFileCount} tracked-файлов`] : []),
        ...(untrackedFileLines.length > 0 ? ['', 'Новые untracked-файлы:', ...untrackedFileLines] : []),
        '',
        'Фрагмент tracked diff:',
        '```diff',
        compactedDiff || '[tracked diff отсутствует]',
        '```',
        '',
        'Автоматически подготовленные подсказки по зонам тестирования:',
        testingHintsMarkdown,
        ...(options.includeUntrackedContents && context.untrackedFiles.length > 0
            ? [
                '',
                'Фрагменты новых untracked-файлов:',
                ...context.untrackedFiles.map(entry => [
                    `### ${entry.path}`,
                    '```text',
                    entry.excerpt || '[пустой файл]',
                    '```'
                ].join('\n'))
            ]
            : [])
    ].join('\n');
}

function buildRetryPrompt(basePrompt: string, outputLanguage: AiOutputLanguage): string {
    return outputLanguage === 'en'
        ? [
            basePrompt,
            '',
            'Important: the previous answer was empty or too weak.',
            'Repeat the analysis and return only the final markdown report.',
            'Do not leave any section empty. Keep the language tester-friendly and product-oriented. If the behavior impact is uncertain, say so explicitly.'
        ].join('\n')
        : [
            basePrompt,
            '',
            'Важно: предыдущий ответ оказался пустым или слишком слабым.',
            'Повтори анализ и верни только итоговый markdown-отчет.',
            'Не оставляй разделы пустыми. Пиши человеческим языком для тестировщика, а не для разработчика. Если влияние на поведение неочевидно, так и напиши.'
        ].join('\n');
}

function isContextLengthError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('context length')
        || message.includes('maximum context length')
        || message.includes('prompt is too long')
        || message.includes('number of tokens to keep')
        || message.includes('input is too long');
}

async function generateConfigurationDiffImpactReport(
    context: ConfigurationDiffContext,
    userStoryText: string
): Promise<GeneratedConfigurationDiffImpactReport> {
    const settings = getAiConnectionSettings(vscode.Uri.file(context.configurationSourceDirectory));
    try {
        ensureAiConnectionSettingsComplete(settings);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SettingsActionError(message, 'kotTestToolkit.ai');
    }

    const testingFocusAreas = await buildTestingFocusAreas(context, settings.outputLanguage);
    const endpoint = buildAiEndpoint(settings.baseUrl, settings.apiFormat, settings.apiVersion || undefined);
    const standardPrompt = buildConfigurationDiffPrompt(context, testingFocusAreas, settings.outputLanguage, userStoryText, {
        diffCharLimit: 24000,
        changedFileLimit: 80,
        includeUntrackedContents: true,
        testingFocusAreaLimit: 10
    });
    const compactPrompt = buildConfigurationDiffPrompt(context, testingFocusAreas, settings.outputLanguage, userStoryText, {
        diffCharLimit: 12000,
        changedFileLimit: 40,
        includeUntrackedContents: false,
        testingFocusAreaLimit: 6
    });

    const requestReport = async (prompt: string): Promise<string> => {
        const firstAttempt = (await requestTextFromAi(
            endpoint,
            settings,
            DEFAULT_CONFIGURATION_DIFF_SYSTEM_PROMPT,
            prompt
        )).trim();
        if (firstAttempt.length > 0) {
            return firstAttempt;
        }

        return (await requestTextFromAi(
            endpoint,
            settings,
            DEFAULT_CONFIGURATION_DIFF_SYSTEM_PROMPT,
            buildRetryPrompt(prompt, settings.outputLanguage)
        )).trim();
    };

    try {
        const standardAttempt = await requestReport(standardPrompt);
        if (standardAttempt.length > 0) {
            return {
                reportBody: standardAttempt,
                outputLanguage: settings.outputLanguage,
                testingFocusAreas
            };
        }
    } catch (error) {
        if (!isContextLengthError(error)) {
            throw error;
        }
    }

    const compactAttempt = await requestReport(compactPrompt);
    if (compactAttempt.length === 0) {
        throw new Error(settings.outputLanguage === 'en'
            ? 'LLM returned an empty report.'
            : 'LLM вернула пустой отчет.');
    }

    return {
        reportBody: compactAttempt,
        outputLanguage: settings.outputLanguage,
        testingFocusAreas
    };
}

function buildFinalMarkdownReport(
    context: ConfigurationDiffContext,
    generatedReport: GeneratedConfigurationDiffImpactReport,
    userStoryText: string
): string {
    const mergeBaseShort = context.mergeBase.slice(0, 12);
    const autoTestingHints = buildTestingFocusAreasMarkdown(
        generatedReport.testingFocusAreas,
        generatedReport.outputLanguage,
        8
    );
    const title = generatedReport.outputLanguage === 'en'
        ? '# AI testing report for configuration diff'
        : '# AI-отчет для тестирования по diff конфигурации';
    const appendixTitle = generatedReport.outputLanguage === 'en'
        ? '## Appendix: auto-generated testing hints'
        : '## Приложение: автоматические подсказки';
    const userStorySectionTitle = generatedReport.outputLanguage === 'en'
        ? '## UserStory context'
        : '## Контекст UserStory';
    const normalizedUserStory = userStoryText.trim();
    const userStoryState = normalizedUserStory.length > 0
        ? (generatedReport.outputLanguage === 'en' ? 'provided' : 'передан')
        : (generatedReport.outputLanguage === 'en' ? 'not provided' : 'не передан');

    return [
        title,
        '',
        `- Generated: ${new Date().toLocaleString()}`,
        `- Branch: \`${context.currentBranch}\``,
        `- Main ref: \`${context.baseRef}\``,
        `- Merge base: \`${mergeBaseShort}\``,
        `- Repository root: \`${context.repositoryRootPath}\``,
        `- Configuration directory: \`${context.configurationSourceDirectoryRelativePath}\``,
        `- Tracked changed files: ${context.changedFiles.length}`,
        `- Untracked files: ${context.untrackedFiles.length}`,
        `- UserStory: ${userStoryState}`,
        '',
        ...(normalizedUserStory.length > 0
            ? [
                userStorySectionTitle,
                '',
                '```text',
                truncateText(normalizedUserStory, 4000, '\n... [UserStory truncated] ...'),
                '```',
                ''
            ]
            : []),
        generatedReport.reportBody.trim(),
        '',
        '---',
        '',
        appendixTitle,
        '',
        autoTestingHints
    ].join('\n');
}

export async function getConfigurationDiffImpactReportState(): Promise<ConfigurationDiffImpactReportState> {
    try {
        const storageContext = await resolveConfigurationDiffReportStorageContext();
        return {
            available: true,
            branchName: storageContext.currentBranch,
            reportUri: storageContext.reportUri,
            hasSavedReport: await doesUriExist(storageContext.reportUri)
        };
    } catch {
        return {
            available: false,
            branchName: null,
            reportUri: null,
            hasSavedReport: false
        };
    }
}

export async function openSavedConfigurationDiffImpactReport(): Promise<boolean> {
    const reportState = await getConfigurationDiffImpactReportState();
    if (!reportState.reportUri || !reportState.hasSavedReport) {
        return false;
    }

    await openConfigurationDiffReportUri(reportState.reportUri);
    return true;
}

export async function handleGenerateConfigurationDiffImpactReport(): Promise<GenerateConfigurationDiffImpactReportResult> {
    const openSettings = vscode.l10n.t('Open settings');

    try {
        const diffContext = await buildConfigurationDiffContext();
        const runtimeRootUri = resolveRuntimeRootUri(diffContext.repositoryRootPath);
        const reportsDirectoryUri = vscode.Uri.joinPath(runtimeRootUri, 'configuration-diff-ai-reports');
        const storageContext: ConfigurationDiffReportStorageContext = {
            repositoryRootPath: diffContext.repositoryRootPath,
            configurationSourceDirectory: diffContext.configurationSourceDirectory,
            currentBranch: diffContext.currentBranch,
            reportsDirectoryUri,
            reportUri: vscode.Uri.joinPath(reportsDirectoryUri, sanitizeBranchNameForReportFile(diffContext.currentBranch))
        };

        if (diffContext.changedFiles.length === 0 && diffContext.untrackedFiles.length === 0) {
            await deleteUriIfExists(storageContext.reportUri);
            vscode.window.showInformationMessage(vscode.l10n.t(
                'No configuration changes relative to {0} were found in {1}.',
                diffContext.baseRef,
                diffContext.configurationSourceDirectoryRelativePath
            ));
            return {
                branchName: diffContext.currentBranch,
                reportUri: null,
                hasChanges: false
            };
        }

        const userStoryText = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Paste UserStory text to provide context for the configuration diff report. Leave empty to skip.'),
            placeHolder: vscode.l10n.t('UserStory text (optional)'),
            ignoreFocusOut: true,
            value: ''
        });
        if (userStoryText === undefined) {
            return {
                branchName: diffContext.currentBranch,
                reportUri: null,
                hasChanges: false
            };
        }

        const generatedReport = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Generating AI report for configuration diff...'),
            cancellable: false
        }, () => generateConfigurationDiffImpactReport(diffContext, userStoryText.trim()));

        const reportMarkdown = buildFinalMarkdownReport(diffContext, generatedReport, userStoryText.trim());
        await vscode.workspace.fs.createDirectory(storageContext.reportsDirectoryUri);
        await vscode.workspace.fs.writeFile(
            storageContext.reportUri,
            Buffer.from(reportMarkdown, 'utf8')
        );

        const openReportAction = vscode.l10n.t('Open report');
        const selection = await vscode.window.showInformationMessage(
            vscode.l10n.t(
                'Configuration diff impact report was generated with AI and saved for branch "{0}".',
                diffContext.currentBranch
            ),
            openReportAction
        );
        if (selection === openReportAction) {
            await openConfigurationDiffReportUri(storageContext.reportUri);
        }

        return {
            branchName: diffContext.currentBranch,
            reportUri: storageContext.reportUri,
            hasChanges: true
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SettingsActionError && error.settingsQuery) {
            const selection = await vscode.window.showErrorMessage(message, openSettings);
            if (selection === openSettings) {
                void vscode.commands.executeCommand('workbench.action.openSettings', error.settingsQuery);
            }
            return {
                branchName: '',
                reportUri: null,
                hasChanges: false
            };
        }

        const selection = await vscode.window.showErrorMessage(
            vscode.l10n.t('Failed to generate configuration diff report with AI: {0}', message),
            openSettings
        );
        if (selection === openSettings) {
            const settingsQuery = error instanceof SettingsActionError && error.settingsQuery
                ? error.settingsQuery
                : 'kotTestToolkit.formExplorer.configurationSourceDirectory';
            void vscode.commands.executeCommand('workbench.action.openSettings', settingsQuery);
        }

        return {
            branchName: '',
            reportUri: null,
            hasChanges: false
        };
    }
}
