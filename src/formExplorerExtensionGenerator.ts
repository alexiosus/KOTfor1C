import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    ensureFormExplorerBuilderInfobaseReady,
    getFormExplorerBuilderOutputChannel
} from './formExplorerBuilder';
import { getTranslator } from './localization';
import {
    getFormExplorerConfigurationSourceDirectory,
    getFormExplorerGeneratedArtifactsDirectory,
    getFormExplorerSnapshotPath
} from './formExplorerPaths';
import {
    getManagedInfobaseStartupParameterArgs,
    pickManagedInfobasePath,
    updateManagedInfobaseMetadata
} from './infobaseManager';
import {
    buildFileInfobaseConnectionArgument,
    buildInfobaseConnectionArgument,
    coerceInfobaseConnection,
    describeInfobaseConnection,
    getFileInfobasePath,
    normalizeInfobaseConnectionIdentity,
    normalizeInfobaseReference
} from './oneCInfobaseConnection';
import { resolveOneCDesignerExePath, resolveOneCIBCmdExePath } from './oneCPlatform';

interface BaseConfigurationInfo {
    name: string;
    synonym: string;
    version: string;
    compatibilityMode: string;
    xmlVersion: string;
    scriptVariant: string;
    internalInfoClassIds: string[];
    languages: BaseConfigurationLanguageInfo[];
    selectedLanguage: BaseConfigurationLanguageInfo;
    commandGroups: BaseConfigurationCommandGroupInfo[];
    selectedCommandGroup: BaseConfigurationCommandGroupInfo | null;
}

interface BaseConfigurationLanguageInfo {
    name: string;
    code: string;
}

interface BaseConfigurationCommandGroupInfo {
    name: string;
    category: string;
    uuid: string;
}

interface StaticManagedFormDescriptor {
    metadataPath: string;
    rootDirectoryName: string;
    objectType: string;
    objectName: string;
    formName: string;
    title: string;
    sourceXmlPath: string;
    sourceLayoutXmlPath: string;
    sourceObjectXmlPath: string | null;
    sourceModulePath: string | null;
}

interface FormExplorerScanResult {
    configuration: BaseConfigurationInfo;
    forms: StaticManagedFormDescriptor[];
}

interface GeneratedExtensionProject {
    extensionSourceDirectory: string;
    formsIndexPath: string;
    buildManifestPath: string;
    cfeOutputPath: string;
    cachedCfePath: string;
    cfeBuildStatePath: string;
    builderInfobaseDirectory: string;
    builderCacheStatePath: string;
    snapshotPath: string;
    settingsFilePath: string;
    modeFilePath: string;
    modeRequestFilePath: string;
    requestContextFilePath: string;
}

interface GeneratedObjectIds {
    configuration: string;
    configurationInternalInfoObjectIds: string[];
    language: string;
    subsystem: string;
    adapterModule: string;
    refreshCommand: string;
    settingsCommand: string;
    toggleModeCommand: string;
    settingsForm: string;
    hotkeyCommandIds: Record<string, string>;
}

interface GeneratedMetadataVersionEntry {
    metadataName: string;
    id: string;
    content: string;
}

interface GeneratedExtensionSourceFile {
    relativePath: string;
    content: string;
    metadataEntry?: GeneratedMetadataVersionEntry;
}

interface GeneratedManagedFormArtifacts {
    files: GeneratedExtensionSourceFile[];
    configurationChildObjects: string[];
    adoptedFormsCount: number;
    adoptedParentObjectsCount: number;
    patchedExistingCommandBarsCount: number;
    createdCommandBarsCount: number;
}

interface BuilderCacheState {
    configurationSourceDirectory: string;
    configurationXmlHash: string;
}

interface FormExplorerCfeBuildState {
    schemaVersion: number;
    buildFingerprint: string;
    cachedCfePath: string;
    generatedAt: string;
}

interface InfobaseAuthentication {
    username: string;
    password: string;
}

interface InfobaseExtensionProbeResult {
    installed: boolean;
    authentication: InfobaseAuthentication | null;
}

export interface StartFormExplorerInfobaseResult {
    status: 'started' | 'cancelled' | 'error';
    infobasePath: string | null;
    error: string | null;
}

type FormExplorerInstallMode = 'cfe' | 'direct' | 'target';

interface FormExplorerInstallModeQuickPickItem extends vscode.QuickPickItem {
    installMode: FormExplorerInstallMode;
}

interface FormExplorerStartActionQuickPickItem extends vscode.QuickPickItem {
    actionKey: 'start' | 'reinstall';
    installMode?: FormExplorerInstallMode;
}

interface FormExplorerStartActionSelection {
    actionKey: 'start' | 'reinstall';
    installMode?: FormExplorerInstallMode;
}

interface GenerateFormExplorerExtensionOptions {
    targetInfobasePath?: string | null;
    installMode?: FormExplorerInstallMode | null;
}

interface HotkeyPresetDefinition {
    key: string;
    shortcut: string;
    commandName: string;
}

const GENERATED_EXTENSION_NAME = 'KOTFormExplorerRuntime';
const GENERATED_EXTENSION_PREFIX = 'KOTFE';
const GENERATED_SUBSYSTEM_NAME = 'KOTFormExplorer';
const ADAPTER_MODULE_NAME = 'KOTFormExplorerAdapterClient';
const REFRESH_COMMAND_NAME = 'KOTFormExplorerRefresh';
const SETTINGS_COMMAND_NAME = 'KOTFormExplorerOpenSettings';
const TOGGLE_MODE_COMMAND_NAME = 'KOTFormExplorerToggleMode';
const SETTINGS_FORM_NAME = 'KOTFormExplorerSettings';
const DEFAULT_COMPATIBILITY_MODE = 'Version8_3_24';
const DEFAULT_SCRIPT_VARIANT = 'Russian';
const BUILDER_INFOBASE_DIRECTORY_NAME = 'builder-infobase';
const DEFAULT_SETTINGS_FILE_NAME = 'adapter-settings.json';
const DEFAULT_RUNTIME_STATE_FILE_NAME = 'adapter-runtime-state.json';
const DEFAULT_MODE_STATE_FILE_NAME = 'adapter-mode.txt';
const DEFAULT_MODE_REQUEST_FILE_NAME = 'adapter-mode-request.txt';
const DEFAULT_REQUEST_CONTEXT_FILE_NAME = 'adapter-request-context.json';
const DEFAULT_CFE_CACHE_FILE_NAME = 'KOTFormExplorerRuntime.cached.cfe';
const DEFAULT_CFE_BUILD_STATE_FILE_NAME = 'cfe-build-state.json';
const TARGET_INFOBASE_CONFIGURATION_EXPORT_DIRECTORY_NAME = 'target-infobase-config-source';
const IBCMD_TARGET_EXPORT_THREADS = 4;
const HOTKEY_PRESET_NONE_KEY = 'none';
const DEFAULT_HOTKEY_PRESET_KEY = 'ctrlShiftF12';
const DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS = 5;
const DEFAULT_MODE_REQUEST_POLL_INTERVAL_SECONDS = 1;
const FORM_EXPLORER_CFE_BUILD_STATE_SCHEMA_VERSION = 1;
const TOGGLE_MODE_SHORTCUT = 'Ctrl+Alt+F11';
const INFOBASE_AUTH_CACHE = new Map<string, InfobaseAuthentication>();
const HOTKEY_PRESETS: HotkeyPresetDefinition[] = [
    {
        key: 'ctrlShiftF12',
        shortcut: 'Ctrl+Shift+F12',
        commandName: 'KOTFormExplorerHotkeyCtrlShiftF12'
    },
    {
        key: 'ctrlAltF12',
        shortcut: 'Ctrl+Alt+F12',
        commandName: 'KOTFormExplorerHotkeyCtrlAltF12'
    },
    {
        key: 'altShiftF12',
        shortcut: 'Alt+Shift+F12',
        commandName: 'KOTFormExplorerHotkeyAltShiftF12'
    },
    {
        key: 'ctrlShiftF11',
        shortcut: 'Ctrl+Shift+F11',
        commandName: 'KOTFormExplorerHotkeyCtrlShiftF11'
    }
];
const DEFAULT_EXTENSION_CONFIGURATION_INTERNAL_INFO_CLASS_IDS = [
    '9cd510cd-abfc-11d4-9434-004095e12fc7',
    '9fcd25a0-4822-11d4-9414-008048da11f9',
    'e3687481-0a87-462c-a166-9f34594f9bba',
    '9de14907-ec23-4a07-96f0-85521cb6b53b',
    '51f2d5d8-ea4d-4064-8892-82951750031e',
    'e68182ea-4237-4383-967f-90c1e3370bc7'
];
const METADATA_OBJECT_KIND_BY_DIRECTORY = new Map<string, string>([
    ['AccountingRegisters', 'AccountingRegister'],
    ['AccumulationRegisters', 'AccumulationRegister'],
    ['BusinessProcesses', 'BusinessProcess'],
    ['CalculationRegisters', 'CalculationRegister'],
    ['Catalogs', 'Catalog'],
    ['ChartsOfAccounts', 'ChartOfAccounts'],
    ['ChartsOfCalculationTypes', 'ChartOfCalculationTypes'],
    ['ChartsOfCharacteristicTypes', 'ChartOfCharacteristicTypes'],
    ['CommonForms', 'CommonForm'],
    ['Constants', 'Constant'],
    ['DataProcessors', 'DataProcessor'],
    ['Documents', 'Document'],
    ['InformationRegisters', 'InformationRegister'],
    ['Reports', 'Report'],
    ['Tasks', 'Task']
]);

function stripBom(text: string): string {
    return text.replace(/^\uFEFF/, '');
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function escapeBslStringLiteral(text: string): string {
    return text.replace(/"/g, '""');
}

function extractFirstTagValue(xmlText: string, tagName: string): string {
    const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`).exec(xmlText);
    return match?.[1]?.trim() || '';
}

function extractFirstSynonymText(xmlText: string): string {
    const match = /<Synonym>[\s\S]*?<v8:content>([\s\S]*?)<\/v8:content>[\s\S]*?<\/Synonym>/.exec(xmlText);
    return match?.[1] ? decodeXmlEntities(match[1].trim()) : '';
}

function extractMetadataXmlVersion(xmlText: string): string {
    const match = /<MetaDataObject[\s\S]*?\bversion="([^"]+)"/.exec(xmlText);
    return match?.[1]?.trim() || '2.17';
}

function extractContainedObjectClassIds(xmlText: string): string[] {
    const matches = [...xmlText.matchAll(/<xr:ClassId>([^<]+)<\/xr:ClassId>/g)];
    return matches
        .map(match => (match[1] || '').trim())
        .filter(classId => classId.length > 0);
}

function extractChildTagValues(xmlText: string, tagName: string): string[] {
    const matches = [...xmlText.matchAll(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'g'))];
    return matches
        .map(match => (match[1] || '').trim())
        .filter(value => value.length > 0);
}

function pickPreferredLanguage(
    languages: BaseConfigurationLanguageInfo[],
    scriptVariant: string
): BaseConfigurationLanguageInfo {
    const normalizedVariant = (scriptVariant || '').trim().toLowerCase();
    const preferredCodes = normalizedVariant === 'english'
        ? ['en', 'ru']
        : ['ru', 'en'];

    for (const preferredCode of preferredCodes) {
        const matchingLanguage = languages.find(language => language.code.toLowerCase() === preferredCode);
        if (matchingLanguage) {
            return matchingLanguage;
        }
    }

    return languages[0] || {
        name: normalizedVariant === 'english' ? 'English' : 'Russian',
        code: normalizedVariant === 'english' ? 'en' : 'ru'
    };
}

function pickPreferredCommandGroup(commandGroups: BaseConfigurationCommandGroupInfo[]): BaseConfigurationCommandGroupInfo | null {
    const preferredNames = ['Organizer', 'Information', 'Settings'];
    for (const preferredName of preferredNames) {
        const matchingGroup = commandGroups.find(commandGroup => commandGroup.name === preferredName);
        if (matchingGroup) {
            return matchingGroup;
        }
    }

    return commandGroups.find(commandGroup => commandGroup.category === 'FormCommandBar')
        || commandGroups[0]
        || null;
}

function quoteForShell(value: string): string {
    if (process.platform === 'win32') {
        return `"${value.replace(/"/g, '""')}"`;
    }

    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function applyCommandTemplate(template: string, values: Record<string, string>): string {
    let command = template;
    for (const [key, value] of Object.entries(values)) {
        command = command.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }
    return command;
}

function hashText(text: string): string {
    return crypto.createHash('sha1').update(text).digest('hex');
}

async function hashFileContents(filePath: string): Promise<string> {
    const contents = await fs.promises.readFile(filePath);
    return crypto.createHash('sha256').update(contents).digest('hex');
}

function formatCommandForOutput(exePath: string, args: string[]): string {
    return [quoteForShell(exePath), ...args.map(arg => quoteForShell(arg))].join(' ');
}

function getOutputTail(text: string, maxLength: number = 4000): string {
    const normalized = text.trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return normalized.slice(-maxLength);
}

function appendInfobaseAuthenticationArgs(args: string[], authentication: InfobaseAuthentication | null): string[] {
    const username = (authentication?.username || '').trim();
    if (!username) {
        return [...args];
    }

    return [
        ...args,
        '/N',
        username,
        '/P',
        authentication?.password || ''
    ];
}

function isInfobaseAuthenticationError(message: string): boolean {
    const normalized = (message || '').toLowerCase();
    return normalized.includes('not authenticated')
        || normalized.includes('is not authenticated')
        || normalized.includes('не аутентифицирован')
        || normalized.includes('не аутентифицирован.')
        || normalized.includes('не аутентифицирована')
        || normalized.includes('не аутентифицировано')
        || normalized.includes('не прошел аутентификацию')
        || normalized.includes('пользователь информационной базы не аутентифицирован')
        || normalized.includes('аутентификац');
}

function isExtensionMissingInInfobaseError(message: string): boolean {
    const normalized = (message || '').toLowerCase();
    return (
        (normalized.includes('extension') && normalized.includes('not found'))
        || (normalized.includes('расширен') && (normalized.includes('не найден') || normalized.includes('не существ')))
        || (normalized.includes('конфигурац') && normalized.includes('расширен') && (normalized.includes('отсутств') || normalized.includes('не найден')))
    );
}

async function promptInfobaseAuthentication(
    t: Awaited<ReturnType<typeof getTranslator>>,
    initialAuthentication: InfobaseAuthentication | null,
    retryMode: boolean
): Promise<InfobaseAuthentication | undefined> {
    const defaultUsername = (initialAuthentication?.username || '').trim() || 'Administrator';
    const username = await vscode.window.showInputBox({
        title: retryMode
            ? t('Infobase authentication failed. Enter infobase login')
            : t('Enter infobase login'),
        placeHolder: t('Example: Administrator'),
        value: defaultUsername,
        ignoreFocusOut: true
    });
    if (username === undefined) {
        return undefined;
    }

    const password = await vscode.window.showInputBox({
        title: t('Enter infobase password'),
        placeHolder: t('Password can be empty'),
        value: initialAuthentication?.password || '',
        password: true,
        ignoreFocusOut: true
    });
    if (password === undefined) {
        return undefined;
    }

    return {
        username: username.trim() || 'Administrator',
        password
    };
}

async function showQuickPickWithDefaultSelection<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: {
        title: string;
        placeHolder: string;
        activeItem: T;
    }
): Promise<T | undefined> {
    return await new Promise<T | undefined>(resolve => {
        const quickPick = vscode.window.createQuickPick<T>();
        let settled = false;
        const finalize = (value: T | undefined, shouldHide: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            if (shouldHide) {
                quickPick.hide();
            }
            quickPick.dispose();
            resolve(value);
        };

        quickPick.title = options.title;
        quickPick.placeHolder = options.placeHolder;
        quickPick.ignoreFocusOut = true;
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.items = items.slice();
        quickPick.activeItems = [options.activeItem];
        quickPick.onDidAccept(() => {
            finalize(quickPick.selectedItems[0], true);
        });
        quickPick.onDidHide(() => finalize(undefined, false));
        quickPick.show();
    });
}

function getDirectInstallModeDetail(
    t: Awaited<ReturnType<typeof getTranslator>>,
): string {
    return t(
        'Fastest. Use only when the base matches the branch.'
    );
}

function getCfeInstallModeDetail(
    t: Awaited<ReturnType<typeof getTranslator>>
): string {
    return t(
        'Middle path. Uses the branch config and installs via .cfe.'
    );
}

function getTargetInfobaseInstallModeDetail(
    t: Awaited<ReturnType<typeof getTranslator>>
): string {
    return t(
        'Slowest. Exports the selected base config and builds from it.'
    );
}

async function pickFormExplorerInstallMode(
    t: Awaited<ReturnType<typeof getTranslator>>,
    _targetInfobasePath: string
): Promise<FormExplorerInstallMode | undefined> {
    const directItem: FormExplorerInstallModeQuickPickItem = {
        label: t('Direct (Recommended)'),
        description: t('Install directly'),
        detail: getDirectInstallModeDetail(t),
        installMode: 'direct'
    };
    const cfeItem: FormExplorerInstallModeQuickPickItem = {
        label: t('Via .cfe'),
        description: t('Build/install'),
        detail: getCfeInstallModeDetail(t),
        installMode: 'cfe'
    };
    const targetItem: FormExplorerInstallModeQuickPickItem = {
        label: t('From target infobase'),
        description: t('Export/build/install'),
        detail: getTargetInfobaseInstallModeDetail(t),
        installMode: 'target'
    };
    const selection = await showQuickPickWithDefaultSelection(
        [directItem, cfeItem, targetItem],
        {
            title: t('Choose how to install Form Explorer into the selected infobase'),
            placeHolder: t(
                'Direct is fastest, .cfe is the middle path, target infobase is slowest but most accurate.'
            ),
            activeItem: directItem
        }
    );

    return selection?.installMode;
}

async function pickStartInfobaseAction(
    t: Awaited<ReturnType<typeof getTranslator>>,
    _targetInfobasePath: string,
    extensionInstalled: boolean
): Promise<FormExplorerStartActionSelection | undefined> {
    const directItem: FormExplorerStartActionQuickPickItem = {
        label: t('Direct (Recommended)'),
        description: extensionInstalled
            ? t('Reinstall and start')
            : t('Install and start'),
        detail: getDirectInstallModeDetail(t),
        actionKey: 'reinstall',
        installMode: 'direct'
    };
    const cfeItem: FormExplorerStartActionQuickPickItem = {
        label: t('Via .cfe'),
        description: extensionInstalled
            ? t('Build/reinstall and start')
            : t('Build/install and start'),
        detail: getCfeInstallModeDetail(t),
        actionKey: 'reinstall',
        installMode: 'cfe'
    };
    const targetItem: FormExplorerStartActionQuickPickItem = {
        label: t('From target infobase'),
        description: extensionInstalled
            ? t('Export/build/reinstall/start')
            : t('Export/build/install/start'),
        detail: getTargetInfobaseInstallModeDetail(t),
        actionKey: 'reinstall',
        installMode: 'target'
    };
    const items: FormExplorerStartActionQuickPickItem[] = extensionInstalled
        ? [
            {
                label: t('Use installed extension'),
                description: t('Start as is'),
                detail: t('No reinstall. Use only if the installed adapter is already current.'),
                actionKey: 'start'
            },
            directItem,
            cfeItem,
            targetItem
        ]
        : [directItem, cfeItem, targetItem];
    const selection = await showQuickPickWithDefaultSelection(
        items,
        {
            title: t('Choose how to start the selected infobase'),
            placeHolder: t(
                'Direct is fastest, .cfe is the middle path, target infobase is slowest but most accurate.'
            ),
            activeItem: directItem
        }
    );
    if (!selection) {
        return undefined;
    }

    return selection.actionKey === 'start'
        ? { actionKey: 'start' }
        : { actionKey: 'reinstall', installMode: selection.installMode };
}

async function pickCfeOutputPath(
    generatedArtifactsDirectory: string,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<string | null> {
    const defaultUri = vscode.Uri.file(path.join(generatedArtifactsDirectory, 'KOTFormExplorerRuntime.cfe'));
    const outputUri = await vscode.window.showSaveDialog({
        title: t('Choose destination .cfe file'),
        defaultUri,
        filters: {
            [t('1C extension (*.cfe)')]: ['cfe']
        },
        saveLabel: t('Save .cfe')
    });
    if (!outputUri) {
        return null;
    }

    let outputPath = outputUri.fsPath;
    if (!outputPath.toLowerCase().endsWith('.cfe')) {
        outputPath += '.cfe';
    }
    return outputPath;
}

function randomUuid(): string {
    return crypto.randomUUID();
}

async function ensureDirectory(directoryPath: string): Promise<void> {
    await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function recreateDirectory(directoryPath: string): Promise<void> {
    await fs.promises.rm(directoryPath, { recursive: true, force: true });
    await ensureDirectory(directoryPath);
}

async function copyFileEnsuringDirectory(sourcePath: string, destinationPath: string): Promise<void> {
    await ensureDirectory(path.dirname(destinationPath));
    await fs.promises.copyFile(sourcePath, destinationPath);
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
    await ensureDirectory(path.dirname(filePath));
    await fs.promises.writeFile(filePath, content, 'utf8');
}

async function readUtf8File(filePath: string): Promise<string> {
    return stripBom(await fs.promises.readFile(filePath, 'utf8'));
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.promises.access(targetPath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
    if (!(await pathExists(filePath))) {
        return null;
    }

    try {
        return JSON.parse(await readUtf8File(filePath)) as T;
    } catch {
        return null;
    }
}

function buildMetaDataObjectOpenTag(xmlVersion: string): string {
    return `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">`;
}

function extractFirstTagBlock(xmlText: string, tagName: string): string | null {
    const pairedMatch = new RegExp(`<${tagName}(\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>`).exec(xmlText);
    if (pairedMatch) {
        return pairedMatch[0];
    }

    const selfClosingMatch = new RegExp(`<${tagName}(\\s[^>]*)?\\s*\\/>`).exec(xmlText);
    return selfClosingMatch?.[0] || null;
}

function findBalancedTagRange(
    xmlText: string,
    tagName: string,
    startIndex: number = 0
): { start: number; end: number; contentStart: number; contentEnd: number } | null {
    const openTagPattern = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'g');
    openTagPattern.lastIndex = startIndex;
    const openMatch = openTagPattern.exec(xmlText);
    if (!openMatch) {
        return null;
    }

    const matchPattern = new RegExp(`<${tagName}(\\s[^>]*)?\\s*\\/?>|<\\/${tagName}>`, 'g');
    matchPattern.lastIndex = openMatch.index;
    let depth = 0;

    for (;;) {
        const match = matchPattern.exec(xmlText);
        if (!match) {
            return null;
        }

        const token = match[0];
        if (token.startsWith(`</${tagName}`)) {
            depth -= 1;
            if (depth === 0) {
                return {
                    start: openMatch.index,
                    end: matchPattern.lastIndex,
                    contentStart: openMatch.index + openMatch[0].length,
                    contentEnd: match.index
                };
            }
            continue;
        }

        if (!token.endsWith('/>')) {
            depth += 1;
        }
    }
}

function findElementEnd(xmlText: string, tagName: string, startIndex: number): number {
    const range = findBalancedTagRange(xmlText, tagName, startIndex);
    return range?.end ?? startIndex;
}

function extractTopLevelXmlNodes(xmlText: string): string[] {
    const nodes: string[] = [];
    let cursor = 0;

    while (cursor < xmlText.length) {
        const nextOpen = xmlText.indexOf('<', cursor);
        if (nextOpen < 0) {
            break;
        }

        if (xmlText.startsWith('</', nextOpen)) {
            break;
        }

        const tagMatch = /^<([A-Za-z_][\w:.-]*)(\s[^>]*)?\s*(\/?)>/.exec(xmlText.slice(nextOpen));
        if (!tagMatch) {
            cursor = nextOpen + 1;
            continue;
        }

        const tagName = tagMatch[1];
        const isSelfClosing = tagMatch[3] === '/';
        if (isSelfClosing) {
            nodes.push(xmlText.slice(nextOpen, nextOpen + tagMatch[0].length));
            cursor = nextOpen + tagMatch[0].length;
            continue;
        }

        const nodeEnd = findElementEnd(xmlText, tagName, nextOpen);
        if (nodeEnd <= nextOpen) {
            break;
        }

        nodes.push(xmlText.slice(nextOpen, nodeEnd));
        cursor = nodeEnd;
    }

    return nodes;
}

function rebuildRootChildObjectsBlock(sourceObjectXml: string, adoptedFormNames: Set<string>): string {
    const childObjectsRange = findBalancedTagRange(sourceObjectXml, 'ChildObjects');
    if (!childObjectsRange) {
        return sourceObjectXml;
    }

    const directChildren = extractTopLevelXmlNodes(
        sourceObjectXml.slice(childObjectsRange.contentStart, childObjectsRange.contentEnd)
    );
    const keptChildren = directChildren.filter(node => {
        const trimmedNode = node.trim();
        const nodeTagMatch = /^<([A-Za-z_][\w:.-]*)\b/.exec(trimmedNode);
        const nodeTagName = nodeTagMatch?.[1] || '';
        if (nodeTagName === 'Command') {
            return false;
        }

        const simpleReferenceMatch = /^<([A-Za-z_][\w:.-]*)>([^<]+)<\/\1>$/.exec(trimmedNode);
        if (!simpleReferenceMatch) {
            return true;
        }

        if (simpleReferenceMatch[1] !== 'Form') {
            return false;
        }

        return adoptedFormNames.has(simpleReferenceMatch[2].trim());
    });
    const rebuiltChildObjectsBlock = keptChildren.length > 0
        ? `\t\t<ChildObjects>\n${keptChildren.map(node => indentXmlBlock(node.trim(), '\t\t\t')).join('\n')}\n\t\t</ChildObjects>`
        : '\t\t<ChildObjects/>';

    return `${sourceObjectXml.slice(0, childObjectsRange.start)}${rebuiltChildObjectsBlock}${sourceObjectXml.slice(childObjectsRange.end)}`;
}

function extractMetadataRootUuid(xmlText: string, rootTagName: string): string {
    const match = new RegExp(`<${rootTagName}\\s+uuid="([^"]+)"`).exec(xmlText);
    return match?.[1]?.trim() || randomUuid();
}

function indentXmlBlock(xmlText: string, indent: string): string {
    return xmlText
        .split('\n')
        .map(line => `${indent}${line}`)
        .join('\n');
}

function upsertObjectBelongingInPropertiesBlock(propertiesBlock: string): string {
    if (/<ObjectBelonging>[\s\S]*?<\/ObjectBelonging>/.test(propertiesBlock)) {
        return propertiesBlock.replace(/<ObjectBelonging>[\s\S]*?<\/ObjectBelonging>/, '<ObjectBelonging>Adopted</ObjectBelonging>');
    }

    const closingTagMatch = /([ \t]*)<\/Properties>/.exec(propertiesBlock);
    const closingIndent = closingTagMatch?.[1] ?? '\t\t';
    return propertiesBlock.replace(/([ \t]*)<\/Properties>/, `${closingIndent}\t<ObjectBelonging>Adopted</ObjectBelonging>\n$1</Properties>`);
}

function buildMinimalRootPropertiesBlock(sourceObjectXml: string): string {
    const sourcePropertiesBlock = extractFirstTagBlock(sourceObjectXml, 'Properties');
    if (!sourcePropertiesBlock) {
        return '\t\t<Properties>\n\t\t\t<Comment/>\n\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>\n\t\t</Properties>';
    }

    const nameBlock = extractFirstTagBlock(sourcePropertiesBlock, 'Name');
    if (!nameBlock) {
        throw new Error('Failed to extract Name from source metadata properties.');
    }

    const propertyTagsToPreserve = ['Comment', 'Hierarchical', 'UseStandardCommands'];
    const preservedBlocks = propertyTagsToPreserve
        .map(tagName => extractFirstTagBlock(sourcePropertiesBlock, tagName))
        .filter((block): block is string => Boolean(block));
    if (!preservedBlocks.some(block => block.startsWith('<Comment'))) {
        preservedBlocks.unshift('<Comment/>');
    }

    const propertyLines = [
        nameBlock,
        ...preservedBlocks,
        '<ObjectBelonging>Adopted</ObjectBelonging>'
    ];

    return `\t\t<Properties>\n${propertyLines.map(line => indentXmlBlock(line, '\t\t\t')).join('\n')}\n\t\t</Properties>`;
}

function buildAdoptedFormMetadataXml(sourceXml: string): string {
    return sourceXml.replace(
        /<Properties>[\s\S]*?<\/Properties>/,
        matched => upsertObjectBelongingInPropertiesBlock(matched)
    );
}

function buildAdoptedParentObjectXml(sourceObjectXml: string, adoptedFormNames: Set<string>): string {
    return rebuildRootChildObjectsBlock(
        sourceObjectXml.replace(
            /<Properties>[\s\S]*?<\/Properties>/,
            buildMinimalRootPropertiesBlock(sourceObjectXml)
        ),
        adoptedFormNames
    );
}

function buildRefreshButtonXml(buttonId: number, tooltipId: number): string {
    return `\t\t\t<Button name="KOTFormExplorerRefreshButton" id="${buttonId}">
\t\t\t\t<Type>CommandBarButton</Type>
\t\t\t\t<Representation>Text</Representation>
\t\t\t\t<CommandName>CommonCommand.${REFRESH_COMMAND_NAME}</CommandName>
\t\t\t\t<LocationInCommandBar>InAdditionalSubmenu</LocationInCommandBar>
\t\t\t\t<ExtendedTooltip name="KOTFormExplorerRefreshButtonExtendedTooltip" id="${tooltipId}"/>
\t\t\t</Button>`;
}

function getNextPositiveControlId(layoutXml: string): number {
    const ids = [...layoutXml.matchAll(/\bid="(-?\d+)"/g)]
        .map(match => Number(match[1]))
        .filter(value => Number.isFinite(value) && value >= 0);

    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

function injectRefreshButtonIntoFormLayout(layoutXml: string): {
    content: string;
    usedExistingCommandBar: boolean;
} {
    if (layoutXml.includes('name="KOTFormExplorerRefreshButton"')) {
        return {
            content: layoutXml,
            usedExistingCommandBar: true
        };
    }

    const buttonId = getNextPositiveControlId(layoutXml);
    const tooltipId = buttonId + 1;
    const buttonXml = buildRefreshButtonXml(buttonId, tooltipId);
    const autoCommandBarPattern = /<AutoCommandBar\b(?=[^>]*\bname="FormCommandBar")[\s\S]*?<\/AutoCommandBar>/;
    const autoCommandBarMatch = autoCommandBarPattern.exec(layoutXml);

    if (autoCommandBarMatch) {
        const originalCommandBar = autoCommandBarMatch[0];
        const updatedCommandBar = /<ChildItems>/.test(originalCommandBar)
            ? originalCommandBar.replace(/<ChildItems>/, `<ChildItems>\n${buttonXml}`)
            : originalCommandBar.replace(/<\/AutoCommandBar>/, `\t\t<ChildItems>\n${buttonXml}\n\t\t</ChildItems>\n\t</AutoCommandBar>`);

        return {
            content: layoutXml.replace(autoCommandBarPattern, updatedCommandBar),
            usedExistingCommandBar: true
        };
    }

    const commandBarXml = `\t<AutoCommandBar name="FormCommandBar" id="-1">
\t\t<Autofill>false</Autofill>
\t\t<ChildItems>
${buttonXml}
\t\t</ChildItems>
\t</AutoCommandBar>
`;
    const insertionTargets = ['<Events>', '<ChildItems>', '<Attributes>', '</Form>'];

    for (const target of insertionTargets) {
        if (layoutXml.includes(target)) {
            return {
                content: layoutXml.replace(target, `${commandBarXml}${target}`),
                usedExistingCommandBar: false
            };
        }
    }

    return {
        content: `${layoutXml.trimEnd()}\n${commandBarXml}`,
        usedExistingCommandBar: false
    };
}

async function getBuilderCacheState(configurationSourceDirectory: string): Promise<BuilderCacheState> {
    const configurationXmlPath = path.join(configurationSourceDirectory, 'Configuration.xml');
    const configurationXml = await readUtf8File(configurationXmlPath);
    return {
        configurationSourceDirectory: path.resolve(configurationSourceDirectory),
        configurationXmlHash: hashText(configurationXml)
    };
}

function isSameBuilderCacheState(expected: BuilderCacheState, actual: BuilderCacheState | null): boolean {
    return Boolean(
        actual
        && actual.configurationSourceDirectory === expected.configurationSourceDirectory
        && actual.configurationXmlHash === expected.configurationXmlHash
    );
}

async function collectFilesRecursively(rootDirectory: string): Promise<string[]> {
    const results: string[] = [];

    const walk = async (currentDirectory: string): Promise<void> => {
        const entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') {
                continue;
            }

            const absolutePath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                await walk(absolutePath);
                continue;
            }

            if (entry.isFile()) {
                results.push(absolutePath);
            }
        }
    };

    await walk(rootDirectory);
    return results.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

async function hashDirectoryContents(rootDirectory: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    hash.update(`root:${path.resolve(rootDirectory)}\n`);

    const files = await collectFilesRecursively(rootDirectory);
    for (const absolutePath of files) {
        const relativePath = path.relative(rootDirectory, absolutePath).split(path.sep).join('/');
        hash.update(`file:${relativePath}\n`);
        hash.update(await fs.promises.readFile(absolutePath));
        hash.update('\n');
    }

    return hash.digest('hex');
}

function tryParseFormExplorerInstallMode(value: unknown): FormExplorerInstallMode | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    if (normalized === 'direct' || normalized === 'directload' || normalized === 'direct-load') {
        return 'direct';
    }

    if (normalized === 'cfe') {
        return 'cfe';
    }

    if (
        normalized === 'target'
        || normalized === 'targetinfobase'
        || normalized === 'target-infobase'
        || normalized === 'targetexport'
        || normalized === 'target-export'
        || normalized === 'fromtarget'
        || normalized === 'from-target'
        || normalized === 'exact'
    ) {
        return 'target';
    }

    return null;
}

async function computeFormExplorerCfeBuildFingerprint(
    context: vscode.ExtensionContext,
    configurationSourceDirectory: string,
    project: GeneratedExtensionProject,
    oneCDesignerExePath: string
): Promise<string> {
    const adapterBslPath = path.join(
        context.extensionUri.fsPath,
        'res',
        'formExplorer',
        'adapter',
        'KOTFormExplorerAdapterClient.bsl'
    );
    const hash = crypto.createHash('sha256');
    hash.update(`schema:${FORM_EXPLORER_CFE_BUILD_STATE_SCHEMA_VERSION}\n`);
    hash.update(`configuration:${await hashDirectoryContents(configurationSourceDirectory)}\n`);
    hash.update(`adapter:${await hashFileContents(adapterBslPath)}\n`);
    hash.update(`generator:${await hashFileContents(__filename)}\n`);

    const pathInputs = [
        path.resolve(configurationSourceDirectory),
        path.resolve(project.snapshotPath),
        path.resolve(project.settingsFilePath),
        path.resolve(project.modeFilePath),
        path.resolve(project.modeRequestFilePath),
        path.resolve(project.requestContextFilePath)
    ];
    for (const pathInput of pathInputs) {
        hash.update(`path:${pathInput}\n`);
    }

    const designerStat = await fs.promises.stat(oneCDesignerExePath);
    hash.update(
        `designer:${path.resolve(oneCDesignerExePath)}:${designerStat.size}:${designerStat.mtimeMs}\n`
    );

    return hash.digest('hex');
}

function isReusableFormExplorerCfeBuildState(
    state: FormExplorerCfeBuildState | null,
    expectedFingerprint: string,
    expectedCachedCfePath: string
): boolean {
    return Boolean(
        state
        && state.schemaVersion === FORM_EXPLORER_CFE_BUILD_STATE_SCHEMA_VERSION
        && state.buildFingerprint === expectedFingerprint
        && path.resolve(state.cachedCfePath) === path.resolve(expectedCachedCfePath)
    );
}

async function writeFormExplorerCfeBuildState(
    statePath: string,
    buildFingerprint: string,
    cachedCfePath: string
): Promise<void> {
    const state: FormExplorerCfeBuildState = {
        schemaVersion: FORM_EXPLORER_CFE_BUILD_STATE_SCHEMA_VERSION,
        buildFingerprint,
        cachedCfePath,
        generatedAt: new Date().toISOString()
    };
    await writeTextFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function parseBaseConfigurationInfo(configurationSourceDirectory: string): Promise<BaseConfigurationInfo> {
    const configurationXmlPath = path.join(configurationSourceDirectory, 'Configuration.xml');
    const configurationXml = await readUtf8File(configurationXmlPath);
    const configurationLanguageNames = extractChildTagValues(configurationXml, 'Language');
    const commandGroupsDirectory = path.join(configurationSourceDirectory, 'CommandGroups');
    const languages = (
        await Promise.all(configurationLanguageNames.map(async languageName => {
            const languageXmlPath = path.join(configurationSourceDirectory, 'Languages', `${languageName}.xml`);
            if (!(await pathExists(languageXmlPath))) {
                return {
                    name: languageName,
                    code: ''
                };
            }

            const languageXml = await readUtf8File(languageXmlPath);
            return {
                name: extractFirstTagValue(languageXml, 'Name') || languageName,
                code: extractFirstTagValue(languageXml, 'LanguageCode')
            };
        }))
    ).filter((language, index, items) => {
        if (!language.name) {
            return false;
        }

        return items.findIndex(candidate => candidate.name === language.name) === index;
    });
    const scriptVariant = extractFirstTagValue(configurationXml, 'ScriptVariant') || DEFAULT_SCRIPT_VARIANT;
    const commandGroups = await (async (): Promise<BaseConfigurationCommandGroupInfo[]> => {
        if (!(await pathExists(commandGroupsDirectory))) {
            return [];
        }

        const entries = await fs.promises.readdir(commandGroupsDirectory, { withFileTypes: true });
        const result: BaseConfigurationCommandGroupInfo[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml')) {
                continue;
            }

            const commandGroupXmlPath = path.join(commandGroupsDirectory, entry.name);
            const commandGroupXml = await readUtf8File(commandGroupXmlPath);
            result.push({
                name: extractFirstTagValue(commandGroupXml, 'Name') || path.basename(entry.name, '.xml'),
                category: extractFirstTagValue(commandGroupXml, 'Category'),
                uuid: extractMetadataRootUuid(commandGroupXml, 'CommandGroup')
            });
        }

        result.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
        return result;
    })();

    return {
        name: extractFirstTagValue(configurationXml, 'Name') || 'Configuration',
        synonym: extractFirstSynonymText(configurationXml),
        version: extractFirstTagValue(configurationXml, 'Version'),
        compatibilityMode: extractFirstTagValue(configurationXml, 'ConfigurationExtensionCompatibilityMode') || DEFAULT_COMPATIBILITY_MODE,
        xmlVersion: extractMetadataXmlVersion(configurationXml),
        scriptVariant,
        internalInfoClassIds: extractContainedObjectClassIds(configurationXml),
        languages,
        selectedLanguage: pickPreferredLanguage(languages, scriptVariant),
        commandGroups,
        selectedCommandGroup: pickPreferredCommandGroup(commandGroups)
    };
}

async function collectManagedForms(configurationSourceDirectory: string): Promise<StaticManagedFormDescriptor[]> {
    const allFiles = await collectFilesRecursively(configurationSourceDirectory);
    const result: StaticManagedFormDescriptor[] = [];

    for (const absolutePath of allFiles) {
        if (!absolutePath.toLowerCase().endsWith('.xml')) {
            continue;
        }

        const relativePath = path.relative(configurationSourceDirectory, absolutePath);
        const segments = relativePath.split(path.sep);
        if (segments.some(segment => segment === 'Ext')) {
            continue;
        }

        if (segments[0] === 'CommonForms' && segments.length === 2) {
            const objectXml = await readUtf8File(absolutePath);
            if (extractFirstTagValue(objectXml, 'FormType') !== 'Managed') {
                continue;
            }

            const formName = path.basename(segments[1], '.xml');
            const layoutPath = path.join(configurationSourceDirectory, 'CommonForms', formName, 'Ext', 'Form.xml');
            const modulePath = path.join(configurationSourceDirectory, 'CommonForms', formName, 'Ext', 'Form', 'Module.bsl');
            if (!(await pathExists(layoutPath))) {
                continue;
            }

            result.push({
                metadataPath: `CommonForm.${formName}`,
                rootDirectoryName: 'CommonForms',
                objectType: 'CommonForm',
                objectName: formName,
                formName,
                title: extractFirstSynonymText(objectXml),
                sourceXmlPath: absolutePath,
                sourceLayoutXmlPath: layoutPath,
                sourceObjectXmlPath: absolutePath,
                sourceModulePath: await pathExists(modulePath) ? modulePath : null
            });
            continue;
        }

        if (segments.length === 4 && segments[2] === 'Forms') {
            const objectKind = METADATA_OBJECT_KIND_BY_DIRECTORY.get(segments[0]);
            if (!objectKind) {
                continue;
            }

            const formXml = await readUtf8File(absolutePath);
            if (extractFirstTagValue(formXml, 'FormType') !== 'Managed') {
                continue;
            }

            const objectName = segments[1];
            const formName = path.basename(segments[3], '.xml');
            const layoutPath = path.join(configurationSourceDirectory, segments[0], objectName, 'Forms', formName, 'Ext', 'Form.xml');
            const modulePath = path.join(configurationSourceDirectory, segments[0], objectName, 'Forms', formName, 'Ext', 'Form', 'Module.bsl');
            const sourceObjectXmlPath = path.join(configurationSourceDirectory, segments[0], `${objectName}.xml`);
            if (!(await pathExists(layoutPath)) || !(await pathExists(sourceObjectXmlPath))) {
                continue;
            }

            result.push({
                metadataPath: `${objectKind}.${objectName}.Form.${formName}`,
                rootDirectoryName: segments[0],
                objectType: objectKind,
                objectName,
                formName,
                title: extractFirstSynonymText(formXml),
                sourceXmlPath: absolutePath,
                sourceLayoutXmlPath: layoutPath,
                sourceObjectXmlPath,
                sourceModulePath: await pathExists(modulePath) ? modulePath : null
            });
        }
    }

    result.sort((left, right) => left.metadataPath.localeCompare(right.metadataPath, undefined, { sensitivity: 'base' }));
    return result;
}

async function scanConfigurationSource(configurationSourceDirectory: string): Promise<FormExplorerScanResult> {
    const [configuration, forms] = await Promise.all([
        parseBaseConfigurationInfo(configurationSourceDirectory),
        collectManagedForms(configurationSourceDirectory)
    ]);

    return {
        configuration,
        forms
    };
}

function buildLanguageXml(
    xmlVersion: string,
    languageUuid: string,
    language: BaseConfigurationLanguageInfo
): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
	<Language uuid="${languageUuid}">
		<Properties>
			<Name>${escapeXml(language.name)}</Name>
			<Comment/>
			<ObjectBelonging>Adopted</ObjectBelonging>
			<LanguageCode>${escapeXml(language.code)}</LanguageCode>
		</Properties>
	</Language>
</MetaDataObject>
`;
}

function buildAdapterCommonModuleXml(
    xmlVersion: string,
    moduleUuid: string,
    language: BaseConfigurationLanguageInfo
): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
	<CommonModule uuid="${moduleUuid}">
		<Properties>
			<Name>${ADAPTER_MODULE_NAME}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>${escapeXml(language.code)}</v8:lang>
					<v8:content>KOT Form Explorer Adapter Client</v8:content>
				</v8:item>
			</Synonym>
			<Comment/>
			<Global>true</Global>
			<ClientManagedApplication>true</ClientManagedApplication>
			<Server>false</Server>
			<ExternalConnection>false</ExternalConnection>
			<ClientOrdinaryApplication>false</ClientOrdinaryApplication>
			<ServerCall>false</ServerCall>
			<Privileged>false</Privileged>
			<ReturnValuesReuse>DontUse</ReturnValuesReuse>
		</Properties>
	</CommonModule>
</MetaDataObject>
`;
}

function buildRefreshCommandXml(
    xmlVersion: string,
    commandUuid: string,
    configuration: BaseConfigurationInfo
): string {
    const title = getLocalizedText(
        configuration,
        'Обновить текущую форму для KOT Form Explorer',
        'Refresh current form for KOT Form Explorer'
    );

    return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
	<CommonCommand uuid="${commandUuid}">
		<Properties>
			<Name>${REFRESH_COMMAND_NAME}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(title)}</v8:content>
				</v8:item>
			</Synonym>
			<Comment/>
			<Group>ActionsPanelTools</Group>
			<Representation>Auto</Representation>
			<ToolTip/>
			<Picture/>
			<Shortcut/>
			<IncludeHelpInContents>false</IncludeHelpInContents>
			<CommandParameterType/>
			<ParameterUseMode>Single</ParameterUseMode>
			<ModifiesData>false</ModifiesData>
			<OnMainServerUnavalableBehavior>Auto</OnMainServerUnavalableBehavior>
		</Properties>
	</CommonCommand>
</MetaDataObject>
`;
}

function buildSubsystemXml(
    xmlVersion: string,
    subsystemUuid: string,
    configuration: BaseConfigurationInfo
): string {
    const explanation = getLocalizedText(
        configuration,
        'Точка входа runtime-функций KOT Form Explorer.',
        'Runtime entry point for KOT Form Explorer commands.'
    );

    return `<?xml version="1.0" encoding="UTF-8"?>
${buildMetaDataObjectOpenTag(xmlVersion)}
\t<Subsystem uuid="${subsystemUuid}">
\t\t<Properties>
\t\t\t<Name>${GENERATED_SUBSYSTEM_NAME}</Name>
\t\t\t<Synonym>
\t\t\t\t<v8:item>
\t\t\t\t\t<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
\t\t\t\t\t<v8:content>KOT Form Explorer</v8:content>
\t\t\t\t</v8:item>
\t\t\t</Synonym>
\t\t\t<Comment/>
\t\t\t<IncludeHelpInContents>true</IncludeHelpInContents>
\t\t\t<IncludeInCommandInterface>true</IncludeInCommandInterface>
\t\t\t<UseOneCommand>false</UseOneCommand>
\t\t\t<Explanation>
\t\t\t\t<v8:item>
\t\t\t\t\t<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
\t\t\t\t\t<v8:content>${escapeXml(explanation)}</v8:content>
\t\t\t\t</v8:item>
\t\t\t</Explanation>
\t\t\t<Picture/>
\t\t\t<Content>
\t\t\t\t<xr:Item xsi:type="xr:MDObjectRef">CommonCommand.${REFRESH_COMMAND_NAME}</xr:Item>
\t\t\t\t<xr:Item xsi:type="xr:MDObjectRef">CommonCommand.${SETTINGS_COMMAND_NAME}</xr:Item>
\t\t\t</Content>
\t\t</Properties>
\t\t<ChildObjects/>
\t</Subsystem>
</MetaDataObject>
`;
}

function buildSubsystemCommandInterfaceXml(xmlVersion: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
\t<CommandsVisibility>
\t\t<Command name="CommonCommand.${REFRESH_COMMAND_NAME}">
\t\t\t<Visibility>
\t\t\t\t<xr:Common>true</xr:Common>
\t\t\t</Visibility>
\t\t</Command>
\t\t<Command name="CommonCommand.${SETTINGS_COMMAND_NAME}">
\t\t\t<Visibility>
\t\t\t\t<xr:Common>true</xr:Common>
\t\t\t</Visibility>
\t\t</Command>
\t</CommandsVisibility>
\t<CommandsPlacement>
\t\t<Command name="CommonCommand.${REFRESH_COMMAND_NAME}">
\t\t\t<CommandGroup>ActionsPanelTools</CommandGroup>
\t\t\t<Placement>Auto</Placement>
\t\t</Command>
\t\t<Command name="CommonCommand.${SETTINGS_COMMAND_NAME}">
\t\t\t<CommandGroup>ActionsPanelTools</CommandGroup>
\t\t\t<Placement>Auto</Placement>
\t\t</Command>
\t</CommandsPlacement>
\t<CommandsOrder>
\t\t<Command name="CommonCommand.${REFRESH_COMMAND_NAME}">
\t\t\t<CommandGroup>ActionsPanelTools</CommandGroup>
\t\t</Command>
\t\t<Command name="CommonCommand.${SETTINGS_COMMAND_NAME}">
\t\t\t<CommandGroup>ActionsPanelTools</CommandGroup>
\t\t</Command>
\t</CommandsOrder>
\t<GroupsOrder>
\t\t<Group>NavigationPanelImportant</Group>
\t\t<Group>NavigationPanelOrdinary</Group>
\t\t<Group>NavigationPanelSeeAlso</Group>
\t\t<Group>ActionsPanelReports</Group>
\t\t<Group>ActionsPanelTools</Group>
\t</GroupsOrder>
</CommandInterface>
`;
}

function buildSettingsCommandXml(
    xmlVersion: string,
    commandUuid: string,
    configuration: BaseConfigurationInfo
): string {
    const title = getLocalizedText(
        configuration,
        'Настройки KOT Form Explorer',
        'KOT Form Explorer settings'
    );

    return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
	<CommonCommand uuid="${commandUuid}">
		<Properties>
			<Name>${SETTINGS_COMMAND_NAME}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(title)}</v8:content>
				</v8:item>
			</Synonym>
			<Comment/>
			<Group>ActionsPanelTools</Group>
			<Representation>Auto</Representation>
			<ToolTip/>
			<Picture/>
			<Shortcut/>
			<IncludeHelpInContents>false</IncludeHelpInContents>
			<CommandParameterType/>
			<ParameterUseMode>Single</ParameterUseMode>
			<ModifiesData>false</ModifiesData>
			<OnMainServerUnavalableBehavior>Auto</OnMainServerUnavalableBehavior>
		</Properties>
	</CommonCommand>
</MetaDataObject>
`;
}

function buildToggleModeCommandXml(
    xmlVersion: string,
    commandUuid: string,
    configuration: BaseConfigurationInfo
): string {
    const title = getLocalizedText(
        configuration,
        'Переключить режим автоснимка KOT Form Explorer',
        'Toggle KOT Form Explorer auto snapshot mode'
    );

    return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
	<CommonCommand uuid="${commandUuid}">
		<Properties>
			<Name>${TOGGLE_MODE_COMMAND_NAME}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(title)}</v8:content>
				</v8:item>
			</Synonym>
			<Comment/>
			<Group>ActionsPanelTools</Group>
			<Representation>Auto</Representation>
			<ToolTip/>
			<Picture/>
			<Shortcut>${escapeXml(TOGGLE_MODE_SHORTCUT)}</Shortcut>
			<IncludeHelpInContents>false</IncludeHelpInContents>
			<CommandParameterType/>
			<ParameterUseMode>Single</ParameterUseMode>
			<ModifiesData>false</ModifiesData>
			<OnMainServerUnavalableBehavior>Auto</OnMainServerUnavalableBehavior>
		</Properties>
	</CommonCommand>
</MetaDataObject>
`;
}

function buildHiddenHotkeyCommandXml(
    xmlVersion: string,
    commandUuid: string,
    configuration: BaseConfigurationInfo,
    preset: HotkeyPresetDefinition
): string {
    const title = getLocalizedText(
        configuration,
        `Горячая клавиша ${preset.shortcut} для KOT Form Explorer`,
        `KOT Form Explorer hotkey ${preset.shortcut}`
    );

    return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
	<CommonCommand uuid="${commandUuid}">
		<Properties>
			<Name>${preset.commandName}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(title)}</v8:content>
				</v8:item>
			</Synonym>
			<Comment/>
			<Group>ActionsPanelTools</Group>
			<Representation>Auto</Representation>
			<ToolTip/>
			<Picture/>
			<Shortcut>${escapeXml(preset.shortcut)}</Shortcut>
			<IncludeHelpInContents>false</IncludeHelpInContents>
			<CommandParameterType/>
			<ParameterUseMode>Single</ParameterUseMode>
			<ModifiesData>false</ModifiesData>
			<OnMainServerUnavalableBehavior>Auto</OnMainServerUnavalableBehavior>
		</Properties>
	</CommonCommand>
</MetaDataObject>
`;
}

function buildSettingsFormMetadataXml(
    xmlVersion: string,
    formUuid: string,
    configuration: BaseConfigurationInfo
): string {
    const title = getLocalizedText(
        configuration,
        'Настройки KOT Form Explorer',
        'KOT Form Explorer settings'
    );

    return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
	<CommonForm uuid="${formUuid}">
		<Properties>
			<Name>${SETTINGS_FORM_NAME}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(title)}</v8:content>
				</v8:item>
			</Synonym>
			<Comment/>
			<FormType>Managed</FormType>
			<IncludeHelpInContents>false</IncludeHelpInContents>
			<UsePurposes>
				<v8:Value xsi:type="app:ApplicationUsePurpose">PlatformApplication</v8:Value>
			</UsePurposes>
			<UseStandardCommands>false</UseStandardCommands>
			<ExtendedPresentation/>
			<Explanation/>
		</Properties>
	</CommonForm>
</MetaDataObject>
`;
}

function buildChoiceListItemsXml(
    configuration: BaseConfigurationInfo,
    options: Array<{ key: string; title: string }>
): string {
    return options.map(option => `\t\t\t\t\t\t<xr:Item>
\t\t\t\t\t\t\t<xr:Presentation/>
\t\t\t\t\t\t\t<xr:CheckState>0</xr:CheckState>
\t\t\t\t\t\t\t<xr:Value xsi:type="FormChoiceListDesTimeValue">
\t\t\t\t\t\t\t\t<Presentation>
\t\t\t\t\t\t\t\t\t<v8:item>
\t\t\t\t\t\t\t\t\t\t<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
\t\t\t\t\t\t\t\t\t\t<v8:content>${escapeXml(option.title)}</v8:content>
\t\t\t\t\t\t\t\t\t</v8:item>
\t\t\t\t\t\t\t\t</Presentation>
\t\t\t\t\t\t\t\t<Value xsi:type="xs:string">${escapeXml(option.key)}</Value>
\t\t\t\t\t\t\t</xr:Value>
\t\t\t\t\t\t</xr:Item>`).join('\n');
}

function buildSettingsFormLayoutXml(
    xmlVersion: string,
    configuration: BaseConfigurationInfo
): string {
    const title = getLocalizedText(
        configuration,
        'Настройки KOT Form Explorer',
        'KOT Form Explorer settings'
    );
    const snapshotTitle = getLocalizedText(configuration, 'Путь к snapshot', 'Snapshot path');
    const hotkeyTitle = getLocalizedText(configuration, 'Горячая клавиша', 'Hotkey preset');
    const autoSnapshotTitle = getLocalizedText(configuration, 'Автоснимок', 'Auto snapshot');
    const intervalTitle = getLocalizedText(configuration, 'Интервал', 'Interval');
    const secondsTitle = getLocalizedText(configuration, '(сек)', '(sec)');
    const saveTitle = getLocalizedText(configuration, 'Сохранить', 'Save');
    const saveAndCloseTitle = getLocalizedText(configuration, 'Сохранить и закрыть', 'Save and close');
    const choiceItemsXml = buildChoiceListItemsXml(configuration, getHotkeyPresetOptions(configuration));

    return `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" xmlns:dcssch="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${escapeXml(xmlVersion)}">
	<Title>
		<v8:item>
			<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
			<v8:content>${escapeXml(title)}</v8:content>
		</v8:item>
	</Title>
	<Width>86</Width>
	<Height>16</Height>
	<WindowOpeningMode>LockOwnerWindow</WindowOpeningMode>
	<AutoTitle>false</AutoTitle>
	<Customizable>false</Customizable>
	<CommandBarLocation>Bottom</CommandBarLocation>
	<AutoCommandBar name="FormCommandBar" id="-1">
		<HorizontalAlign>Right</HorizontalAlign>
		<Autofill>false</Autofill>
		<ChildItems>
			<Button name="SaveSettings" id="1">
				<Type>CommandBarButton</Type>
				<CommandName>Form.Command.SaveSettings</CommandName>
				<Title>
					<v8:item>
						<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
						<v8:content>${escapeXml(saveTitle)}</v8:content>
					</v8:item>
				</Title>
				<ExtendedTooltip name="SaveSettingsExtendedTooltip" id="2"/>
			</Button>
			<Button name="SaveSettingsAndClose" id="3">
				<Type>CommandBarButton</Type>
				<DefaultButton>true</DefaultButton>
				<DefaultItem>true</DefaultItem>
				<CommandName>Form.Command.SaveSettingsAndClose</CommandName>
				<Title>
					<v8:item>
						<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
						<v8:content>${escapeXml(saveAndCloseTitle)}</v8:content>
					</v8:item>
				</Title>
				<ExtendedTooltip name="SaveSettingsAndCloseExtendedTooltip" id="4"/>
			</Button>
			<Button name="CloseForm" id="5">
				<Type>CommandBarButton</Type>
				<CommandName>Form.StandardCommand.Close</CommandName>
				<ExtendedTooltip name="CloseFormExtendedTooltip" id="6"/>
			</Button>
		</ChildItems>
	</AutoCommandBar>
	<Events>
		<Event name="OnOpen">OnOpen</Event>
	</Events>
	<ChildItems>
		<UsualGroup name="SettingsGroup" id="10">
			<Group>Vertical</Group>
			<Behavior>Usual</Behavior>
			<Representation>NormalSeparation</Representation>
			<ShowTitle>false</ShowTitle>
			<ExtendedTooltip name="SettingsGroupExtendedTooltip" id="11"/>
			<ChildItems>
				<InputField name="SnapshotPath" id="12">
					<DataPath>SnapshotPath</DataPath>
					<Title>
						<v8:item>
							<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
							<v8:content>${escapeXml(snapshotTitle)}</v8:content>
						</v8:item>
					</Title>
					<ContextMenu name="SnapshotPathContextMenu" id="13"/>
					<ExtendedTooltip name="SnapshotPathExtendedTooltip" id="14"/>
				</InputField>
				<InputField name="HotkeyPreset" id="15">
					<DataPath>HotkeyPreset</DataPath>
					<Title>
						<v8:item>
							<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
							<v8:content>${escapeXml(hotkeyTitle)}</v8:content>
						</v8:item>
					</Title>
					<ListChoiceMode>true</ListChoiceMode>
					<ChoiceList>
${choiceItemsXml}
					</ChoiceList>
					<ContextMenu name="HotkeyPresetContextMenu" id="16"/>
					<ExtendedTooltip name="HotkeyPresetExtendedTooltip" id="17"/>
				</InputField>
				<CheckBoxField name="AutoSnapshotEnabled" id="18">
					<DataPath>AutoSnapshotEnabled</DataPath>
					<Title>
						<v8:item>
							<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
							<v8:content>${escapeXml(autoSnapshotTitle)}</v8:content>
						</v8:item>
					</Title>
					<TitleLocation>Right</TitleLocation>
					<CheckBoxType>Auto</CheckBoxType>
					<ContextMenu name="AutoSnapshotEnabledContextMenu" id="19"/>
					<ExtendedTooltip name="AutoSnapshotEnabledExtendedTooltip" id="20"/>
				</CheckBoxField>
				<UsualGroup name="IntervalGroup" id="21">
					<Group>Horizontal</Group>
					<Behavior>Usual</Behavior>
					<Representation>None</Representation>
					<ShowTitle>false</ShowTitle>
					<ExtendedTooltip name="IntervalGroupExtendedTooltip" id="22"/>
					<ChildItems>
						<InputField name="AutoSnapshotIntervalSeconds" id="23">
							<DataPath>AutoSnapshotIntervalSeconds</DataPath>
							<Title>
								<v8:item>
									<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
									<v8:content>${escapeXml(intervalTitle)}</v8:content>
								</v8:item>
							</Title>
							<SpinButton>true</SpinButton>
							<ContextMenu name="AutoSnapshotIntervalSecondsContextMenu" id="24"/>
							<ExtendedTooltip name="AutoSnapshotIntervalSecondsExtendedTooltip" id="25"/>
						</InputField>
						<LabelDecoration name="SecondsDecoration" id="26">
							<Title formatted="false">
								<v8:item>
									<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
									<v8:content>${escapeXml(secondsTitle)}</v8:content>
								</v8:item>
							</Title>
							<ContextMenu name="SecondsDecorationContextMenu" id="27"/>
							<ExtendedTooltip name="SecondsDecorationExtendedTooltip" id="28"/>
						</LabelDecoration>
					</ChildItems>
				</UsualGroup>
			</ChildItems>
		</UsualGroup>
	</ChildItems>
	<Attributes>
		<Attribute name="SnapshotPath" id="1">
			<Title>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(snapshotTitle)}</v8:content>
				</v8:item>
			</Title>
			<Type>
				<v8:Type>xs:string</v8:Type>
				<v8:StringQualifiers>
					<v8:Length>0</v8:Length>
					<v8:AllowedLength>Variable</v8:AllowedLength>
				</v8:StringQualifiers>
			</Type>
		</Attribute>
		<Attribute name="HotkeyPreset" id="2">
			<Title>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(hotkeyTitle)}</v8:content>
				</v8:item>
			</Title>
			<Type>
				<v8:Type>xs:string</v8:Type>
				<v8:StringQualifiers>
					<v8:Length>0</v8:Length>
					<v8:AllowedLength>Variable</v8:AllowedLength>
				</v8:StringQualifiers>
			</Type>
		</Attribute>
		<Attribute name="AutoSnapshotEnabled" id="3">
			<Title>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(autoSnapshotTitle)}</v8:content>
				</v8:item>
			</Title>
			<Type>
				<v8:Type>xs:boolean</v8:Type>
			</Type>
		</Attribute>
		<Attribute name="AutoSnapshotIntervalSeconds" id="4">
			<Title>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(intervalTitle)}</v8:content>
				</v8:item>
			</Title>
			<Type>
				<v8:Type>xs:decimal</v8:Type>
				<v8:NumberQualifiers>
					<v8:Digits>4</v8:Digits>
					<v8:FractionDigits>0</v8:FractionDigits>
					<v8:AllowedSign>Any</v8:AllowedSign>
				</v8:NumberQualifiers>
			</Type>
		</Attribute>
	</Attributes>
	<Commands>
		<Command name="SaveSettings" id="1">
			<Title>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(saveTitle)}</v8:content>
				</v8:item>
			</Title>
			<Action>SaveSettings</Action>
			<CurrentRowUse>DontUse</CurrentRowUse>
		</Command>
		<Command name="SaveSettingsAndClose" id="2">
			<Title>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>${escapeXml(saveAndCloseTitle)}</v8:content>
				</v8:item>
			</Title>
			<Action>SaveSettingsAndClose</Action>
			<CurrentRowUse>DontUse</CurrentRowUse>
		</Command>
	</Commands>
</Form>
`;
}

function buildExtensionConfigurationXml(
    configuration: BaseConfigurationInfo,
    xmlVersion: string,
    ids: GeneratedObjectIds,
    additionalChildObjects: string[]
): string {
    const internalInfoClassIds = configuration.internalInfoClassIds.length > 0
        ? configuration.internalInfoClassIds
        : DEFAULT_EXTENSION_CONFIGURATION_INTERNAL_INFO_CLASS_IDS;
    const internalInfo = ids.configurationInternalInfoObjectIds
        .map((objectId, index) => `\t\t\t<xr:ContainedObject>
\t\t\t\t<xr:ClassId>${internalInfoClassIds[index]}</xr:ClassId>
\t\t\t\t<xr:ObjectId>${objectId}</xr:ObjectId>
\t\t\t</xr:ContainedObject>`)
        .join('\n');
    const childObjects = [
        `<Language>${escapeXml(configuration.selectedLanguage.name)}</Language>`,
        `<Subsystem>${GENERATED_SUBSYSTEM_NAME}</Subsystem>`,
        `<CommonModule>${ADAPTER_MODULE_NAME}</CommonModule>`,
        `<CommonCommand>${REFRESH_COMMAND_NAME}</CommonCommand>`,
        `<CommonCommand>${SETTINGS_COMMAND_NAME}</CommonCommand>`,
        `<CommonCommand>${TOGGLE_MODE_COMMAND_NAME}</CommonCommand>`,
        `<CommonForm>${SETTINGS_FORM_NAME}</CommonForm>`,
        ...HOTKEY_PRESETS.map(preset => `<CommonCommand>${preset.commandName}</CommonCommand>`),
        ...additionalChildObjects
    ].join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
${buildMetaDataObjectOpenTag(xmlVersion)}
	<Configuration uuid="${ids.configuration}">
		<InternalInfo>
${internalInfo}
		</InternalInfo>
		<Properties>
			<Name>${GENERATED_EXTENSION_NAME}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>${escapeXml(configuration.selectedLanguage.code)}</v8:lang>
					<v8:content>KOT Form Explorer Runtime</v8:content>
				</v8:item>
			</Synonym>
			<Comment/>
			<ConfigurationExtensionPurpose>AddOn</ConfigurationExtensionPurpose>
			<ObjectBelonging>Adopted</ObjectBelonging>
			<KeepMappingToExtendedConfigurationObjectsByIDs>true</KeepMappingToExtendedConfigurationObjectsByIDs>
			<NamePrefix>${GENERATED_EXTENSION_PREFIX}</NamePrefix>
			<ConfigurationExtensionCompatibilityMode>${escapeXml(configuration.compatibilityMode || DEFAULT_COMPATIBILITY_MODE)}</ConfigurationExtensionCompatibilityMode>
			<DefaultRunMode>ManagedApplication</DefaultRunMode>
			<UsePurposes>
				<v8:Value xsi:type="app:ApplicationUsePurpose">PlatformApplication</v8:Value>
			</UsePurposes>
			<ScriptVariant>${escapeXml(configuration.scriptVariant || DEFAULT_SCRIPT_VARIANT)}</ScriptVariant>
			<Vendor>KOT for 1C</Vendor>
			<Version>${escapeXml(configuration.version)}</Version>
			<BriefInformation/>
			<DetailedInformation/>
			<Copyright/>
			<VendorInformationAddress/>
			<ConfigurationInformationAddress/>
		</Properties>
		<ChildObjects>
${indentXmlBlock(childObjects, '\t\t\t')}
		</ChildObjects>
	</Configuration>
</MetaDataObject>
`;
}

function buildSettingsCommandModuleTextRussian(): string {
    return `&НаКлиенте
Процедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)

    ОткрытьФорму("CommonForm.${SETTINGS_FORM_NAME}");
    KOTFormExplorer_ApplyAutoSnapshotSettings(Ложь);

КонецПроцедуры
`;
}

function buildSettingsCommandModuleTextEnglish(): string {
    return `&AtClient
Procedure CommandProcessing(CommandParameter, ExecutionParameters)

    OpenForm("CommonForm.${SETTINGS_FORM_NAME}");
    KOTFormExplorer_ApplyAutoSnapshotSettings(False);

EndProcedure
`;
}

function buildSettingsCommandModuleText(configuration: BaseConfigurationInfo): string {
    if (isEnglishScriptVariant(configuration.scriptVariant)) {
        return buildSettingsCommandModuleTextEnglish();
    }

    return buildSettingsCommandModuleTextRussian();
}

function buildToggleModeCommandModuleTextRussian(): string {
    return `&НаКлиенте
Процедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)

    KOTFormExplorer_ToggleSnapshotMode();

КонецПроцедуры
`;
}

function buildToggleModeCommandModuleTextEnglish(): string {
    return `&AtClient
Procedure CommandProcessing(CommandParameter, ExecutionParameters)

    KOTFormExplorer_ToggleSnapshotMode();

EndProcedure
`;
}

function buildToggleModeCommandModuleText(configuration: BaseConfigurationInfo): string {
    if (isEnglishScriptVariant(configuration.scriptVariant)) {
        return buildToggleModeCommandModuleTextEnglish();
    }

    return buildToggleModeCommandModuleTextRussian();
}

function buildVisibleRefreshCommandModuleTextRussian(): string {
    return `&НаКлиенте
Процедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)

    KOTFormExplorer_RunManualRefresh(ПараметрыВыполненияКоманды);

КонецПроцедуры
`;
}

function buildVisibleRefreshCommandModuleTextEnglish(): string {
    return `&AtClient
Procedure CommandProcessing(CommandParameter, ExecutionParameters)

    KOTFormExplorer_RunManualRefresh(ExecutionParameters);

EndProcedure
`;
}

function buildVisibleRefreshCommandModuleText(configuration: BaseConfigurationInfo): string {
    if (isEnglishScriptVariant(configuration.scriptVariant)) {
        return buildVisibleRefreshCommandModuleTextEnglish();
    }

    return buildVisibleRefreshCommandModuleTextRussian();
}

function buildHiddenHotkeyCommandModuleTextRussian(preset: HotkeyPresetDefinition): string {
    return `&НаКлиенте
Процедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)

    KOTFormExplorer_HandleHotkeyRefresh("${escapeBslStringLiteral(preset.key)}", ПараметрыВыполненияКоманды);

КонецПроцедуры
`;
}

function buildHiddenHotkeyCommandModuleTextEnglish(preset: HotkeyPresetDefinition): string {
    return `&AtClient
Procedure CommandProcessing(CommandParameter, ExecutionParameters)

    KOTFormExplorer_HandleHotkeyRefresh("${escapeBslStringLiteral(preset.key)}", ExecutionParameters);

EndProcedure
`;
}

function buildHiddenHotkeyCommandModuleText(
    configuration: BaseConfigurationInfo,
    preset: HotkeyPresetDefinition
): string {
    if (isEnglishScriptVariant(configuration.scriptVariant)) {
        return buildHiddenHotkeyCommandModuleTextEnglish(preset);
    }

    return buildHiddenHotkeyCommandModuleTextRussian(preset);
}

function buildSettingsFormModuleTextRussian(): string {
    return `&НаКлиенте
Процедура OnOpen(Отказ)

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    SnapshotPath = KOTFormExplorer_GetStringSetting(Настройки, "snapshotPath", "");
    HotkeyPreset = KOTFormExplorer_GetStringSetting(Настройки, "hotkeyPreset", "${DEFAULT_HOTKEY_PRESET_KEY}");
    AutoSnapshotEnabled = KOTFormExplorer_GetBooleanSetting(Настройки, "autoSnapshotEnabled", Ложь);
    AutoSnapshotIntervalSeconds = KOTFormExplorer_GetNumberSetting(Настройки, "autoSnapshotIntervalSeconds", ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS});

КонецПроцедуры


&НаКлиенте
Процедура SaveSettings(Команда)

    Настройки = Новый Структура;
    Настройки.Вставить("snapshotPath", SnapshotPath);
    Настройки.Вставить("hotkeyPreset", HotkeyPreset);
    Настройки.Вставить("autoSnapshotEnabled", AutoSnapshotEnabled);
    Настройки.Вставить("autoSnapshotIntervalSeconds", AutoSnapshotIntervalSeconds);

    KOTFormExplorer_SaveAdapterSettings(Настройки);
    KOTFormExplorer_ApplyAutoSnapshotSettings(Истина);

КонецПроцедуры


&НаКлиенте
Процедура SaveSettingsAndClose(Команда)

    SaveSettings(Команда);
    Закрыть();

КонецПроцедуры
`;
}

function buildSettingsFormModuleTextEnglish(): string {
    return `&AtClient
Procedure OnOpen(Cancel)

    Settings = KOTFormExplorer_ReadAdapterSettings();
    SnapshotPath = KOTFormExplorer_GetStringSetting(Settings, "snapshotPath", "");
    HotkeyPreset = KOTFormExplorer_GetStringSetting(Settings, "hotkeyPreset", "${DEFAULT_HOTKEY_PRESET_KEY}");
    AutoSnapshotEnabled = KOTFormExplorer_GetBooleanSetting(Settings, "autoSnapshotEnabled", False);
    AutoSnapshotIntervalSeconds = KOTFormExplorer_GetNumberSetting(Settings, "autoSnapshotIntervalSeconds", ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS});

EndProcedure


&AtClient
Procedure SaveSettings(Command)

    Settings = New Structure;
    Settings.Insert("snapshotPath", SnapshotPath);
    Settings.Insert("hotkeyPreset", HotkeyPreset);
    Settings.Insert("autoSnapshotEnabled", AutoSnapshotEnabled);
    Settings.Insert("autoSnapshotIntervalSeconds", AutoSnapshotIntervalSeconds);

    KOTFormExplorer_SaveAdapterSettings(Settings);
    KOTFormExplorer_ApplyAutoSnapshotSettings(True);

EndProcedure


&AtClient
Procedure SaveSettingsAndClose(Command)

    SaveSettings(Command);
    Close();

EndProcedure
`;
}

function buildSettingsFormModuleText(configuration: BaseConfigurationInfo): string {
    if (isEnglishScriptVariant(configuration.scriptVariant)) {
        return buildSettingsFormModuleTextEnglish();
    }

    return buildSettingsFormModuleTextRussian();
}

function buildManagedApplicationModuleTextRussian(): string {
    return `&После("ПриНачалеРаботыСистемы")
Процедура KOTFormExplorer_ПриНачалеРаботыСистемы()

    Попытка
        KOTFormExplorer_InitializeSessionMode();
    Исключение
    КонецПопытки;

КонецПроцедуры
`;
}

function buildManagedApplicationModuleTextEnglish(): string {
    return `&After("OnStart")
Procedure KOTFormExplorer_OnStart()

    Try
        KOTFormExplorer_InitializeSessionMode();
    Except
    EndTry;

EndProcedure
`;
}

function buildManagedApplicationModuleText(configuration: BaseConfigurationInfo): string {
    if (isEnglishScriptVariant(configuration.scriptVariant)) {
        return buildManagedApplicationModuleTextEnglish();
    }

    return buildManagedApplicationModuleTextRussian();
}

function buildAdapterStateHeaderTextRussian(): string {
    return '';
}

function buildAdapterStateHeaderTextEnglish(): string {
    return '';
}

function buildAdapterSupportTextRussian(
    snapshotPath: string,
    settingsPath: string,
    configurationSourceDirectory: string
): string {
    const escapedSnapshotPath = escapeBslStringLiteral(snapshotPath);
    const escapedSettingsPath = escapeBslStringLiteral(settingsPath);
    const escapedStatePath = escapeBslStringLiteral(path.join(path.dirname(settingsPath), DEFAULT_RUNTIME_STATE_FILE_NAME));
    const escapedModePath = escapeBslStringLiteral(path.join(path.dirname(settingsPath), DEFAULT_MODE_STATE_FILE_NAME));
    const escapedModeRequestPath = escapeBslStringLiteral(path.join(path.dirname(settingsPath), DEFAULT_MODE_REQUEST_FILE_NAME));
    const escapedRequestContextPath = escapeBslStringLiteral(path.join(path.dirname(settingsPath), DEFAULT_REQUEST_CONTEXT_FILE_NAME));
    const escapedConfigurationSourceDirectory = escapeBslStringLiteral(configurationSourceDirectory);

    return `

Функция KOTFormExplorer_CreateDefaultSettings() Экспорт

    Настройки = Новый Структура;
    Настройки.Вставить("snapshotPath", "${escapedSnapshotPath}");
    Настройки.Вставить("hotkeyPreset", "${DEFAULT_HOTKEY_PRESET_KEY}");
    Настройки.Вставить("autoSnapshotEnabled", Ложь);
    Настройки.Вставить("autoSnapshotIntervalSeconds", ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS});

    Возврат Настройки;

КонецФункции


Функция KOTFormExplorer_GetStringSetting(Настройки, ИмяНастройки, ЗначениеПоУмолчанию = "") Экспорт

    Возврат ЗначениеВСтроку(ПолучитьПараметр(Настройки, ИмяНастройки, ЗначениеПоУмолчанию));

КонецФункции


Функция KOTFormExplorer_GetBooleanSetting(Настройки, ИмяНастройки, ЗначениеПоУмолчанию = Ложь) Экспорт

    Значение = ПолучитьПараметр(Настройки, ИмяНастройки, ЗначениеПоУмолчанию);

    Попытка
        Если ТипЗнч(Значение) = Тип("Булево") Тогда
            Возврат Значение;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Возврат ЗначениеПоУмолчанию;

КонецФункции


Функция KOTFormExplorer_GetNumberSetting(Настройки, ИмяНастройки, ЗначениеПоУмолчанию = 0) Экспорт

    Значение = ПолучитьПараметр(Настройки, ИмяНастройки, ЗначениеПоУмолчанию);

    Попытка
        Если Значение = Неопределено Тогда
            Возврат ЗначениеПоУмолчанию;
        КонецЕсли;

        Если Значение < 1 Тогда
            Возврат ЗначениеПоУмолчанию;
        КонецЕсли;

        Возврат Значение;
    Исключение
        Возврат ЗначениеПоУмолчанию;
    КонецПопытки;

КонецФункции


Функция KOTFormExplorer_NormalizeSettings(Настройки)

    Результат = KOTFormExplorer_CreateDefaultSettings();
    Если Настройки = Неопределено Тогда
        Возврат Результат;
    КонецЕсли;

    Результат.Вставить("snapshotPath",
        KOTFormExplorer_GetStringSetting(Настройки, "snapshotPath", KOTFormExplorer_GetStringSetting(Результат, "snapshotPath", "")));
    Результат.Вставить("hotkeyPreset",
        KOTFormExplorer_GetStringSetting(Настройки, "hotkeyPreset", KOTFormExplorer_GetStringSetting(Результат, "hotkeyPreset", "${DEFAULT_HOTKEY_PRESET_KEY}")));
    Результат.Вставить("autoSnapshotEnabled",
        KOTFormExplorer_GetBooleanSetting(Настройки, "autoSnapshotEnabled", Ложь));
    Результат.Вставить("autoSnapshotIntervalSeconds",
        KOTFormExplorer_GetNumberSetting(Настройки, "autoSnapshotIntervalSeconds", ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS}));

    Возврат Результат;

КонецФункции


Функция KOTFormExplorer_ReadAdapterSettings() Экспорт

    НастройкиПоУмолчанию = KOTFormExplorer_CreateDefaultSettings();

    Попытка
        ТекстДокумент = Новый ТекстовыйДокумент;
        ТекстДокумент.Прочитать("${escapedSettingsPath}", КодировкаТекста.UTF8);
        ТекстJSON = ТекстДокумент.ПолучитьТекст();

        Если ЭтоПустаяСтрока(СокрЛП(ТекстJSON)) Тогда
            Возврат НастройкиПоУмолчанию;
        КонецЕсли;

        ЧтениеJSON = Новый ЧтениеJSON;
        ЧтениеJSON.УстановитьСтроку(ТекстJSON);
        Настройки = ПрочитатьJSON(ЧтениеJSON);
        ЧтениеJSON.Закрыть();

        Возврат KOTFormExplorer_NormalizeSettings(Настройки);
    Исключение
        Возврат НастройкиПоУмолчанию;
    КонецПопытки;

КонецФункции


Процедура KOTFormExplorer_SaveAdapterSettings(Настройки) Экспорт

    НормализованныеНастройки = KOTFormExplorer_NormalizeSettings(Настройки);
    KOTFormExplorer_WriteTextFile("${escapedSettingsPath}", ПреобразоватьВJSONСтроку(НормализованныеНастройки));
    KOTFormExplorer_SyncModeState(НормализованныеНастройки);

КонецПроцедуры


Функция KOTFormExplorer_GetModeCode(Настройки) Экспорт

    Если KOTFormExplorer_GetBooleanSetting(Настройки, "autoSnapshotEnabled", Ложь) Тогда
        Возврат "auto";
    КонецЕсли;

    Возврат "manual";

КонецФункции


Процедура KOTFormExplorer_WriteModeState(КодРежима) Экспорт

    KOTFormExplorer_WriteTextFile("${escapedModePath}", ЗначениеВСтроку(КодРежима));

КонецПроцедуры


Процедура KOTFormExplorer_SyncModeState(Настройки = Неопределено) Экспорт

    ЛокальныеНастройки = Настройки;
    Если ЛокальныеНастройки = Неопределено Тогда
        ЛокальныеНастройки = KOTFormExplorer_ReadAdapterSettings();
    КонецЕсли;

    KOTFormExplorer_WriteModeState(KOTFormExplorer_GetModeCode(ЛокальныеНастройки));

КонецПроцедуры


Процедура KOTFormExplorer_InitializeSessionMode() Экспорт

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    Настройки.Вставить("autoSnapshotEnabled", Ложь);
    KOTFormExplorer_SaveAdapterSettings(Настройки);
    KOTFormExplorer_ClearModeRequest();
    KOTFormExplorer_ApplyAutoSnapshotSettings(Истина);

КонецПроцедуры


Функция KOTFormExplorer_NormalizeModeCode(Значение) Экспорт

    КодРежима = НРег(СокрЛП(ЗначениеВСтроку(Значение)));
    Если КодРежима = "auto" Или КодРежима = "1" Или КодРежима = "true" Тогда
        Возврат "auto";
    КонецЕсли;

    Если КодРежима = "manual" Или КодРежима = "0" Или КодРежима = "false" Тогда
        Возврат "manual";
    КонецЕсли;

    Если КодРежима = "refresh" Или КодРежима = "snapshot" Тогда
        Возврат "refresh";
    КонецЕсли;

    Если КодРежима = "table" Или КодРежима = "tables" Тогда
        Возврат "table";
    КонецЕсли;

    Если КодРежима = "locator" Или КодРежима = "locate" Тогда
        Возврат "locator";
    КонецЕсли;

    Возврат "";

КонецФункции


Функция KOTFormExplorer_ReadModeRequestCode() Экспорт

    Попытка
        ТекстДокумент = Новый ТекстовыйДокумент;
        ТекстДокумент.Прочитать("${escapedModeRequestPath}", КодировкаТекста.UTF8);
        Возврат KOTFormExplorer_NormalizeModeCode(ТекстДокумент.ПолучитьТекст());
    Исключение
        Возврат "";
    КонецПопытки;

КонецФункции


Процедура KOTFormExplorer_ClearModeRequest() Экспорт

    KOTFormExplorer_WriteTextFile("${escapedModeRequestPath}", "");

КонецПроцедуры


Функция KOTFormExplorer_ReadRequestContext() Экспорт

    Попытка
        ТекстДокумент = Новый ТекстовыйДокумент;
        ТекстДокумент.Прочитать("${escapedRequestContextPath}", КодировкаТекста.UTF8);
        ТекстJSON = ТекстДокумент.ПолучитьТекст();

        Если ЭтоПустаяСтрока(СокрЛП(ТекстJSON)) Тогда
            Возврат Новый Структура;
        КонецЕсли;

        ЧтениеJSON = Новый ЧтениеJSON;
        ЧтениеJSON.УстановитьСтроку(ТекстJSON);
        Контекст = ПрочитатьJSON(ЧтениеJSON);
        ЧтениеJSON.Закрыть();

        Если Контекст = Неопределено Тогда
            Возврат Новый Структура;
        КонецЕсли;

        Возврат Контекст;
    Исключение
        Возврат Новый Структура;
    КонецПопытки;

КонецФункции


Функция KOTFormExplorer_CreateDefaultRuntimeState()

    Состояние = Новый Структура;
    Состояние.Вставить("snapshotPath", "");
    Состояние.Вставить("quickSignature", "");
    Состояние.Вставить("sessionToken", "");
    Состояние.Вставить("locatorActive", Ложь);
    Состояние.Вставить("locatorBaseSignature", "");

    Возврат Состояние;

КонецФункции


Функция KOTFormExplorer_ReadRuntimeState()

    СостояниеПоУмолчанию = KOTFormExplorer_CreateDefaultRuntimeState();

    Попытка
        ТекстДокумент = Новый ТекстовыйДокумент;
        ТекстДокумент.Прочитать("${escapedStatePath}", КодировкаТекста.UTF8);
        ТекстJSON = ТекстДокумент.ПолучитьТекст();

        Если ЭтоПустаяСтрока(СокрЛП(ТекстJSON)) Тогда
            Возврат СостояниеПоУмолчанию;
        КонецЕсли;

        ЧтениеJSON = Новый ЧтениеJSON;
        ЧтениеJSON.УстановитьСтроку(ТекстJSON);
        Состояние = ПрочитатьJSON(ЧтениеJSON);
        ЧтениеJSON.Закрыть();

        Если Состояние = Неопределено Тогда
            Возврат СостояниеПоУмолчанию;
        КонецЕсли;

        Возврат Состояние;
    Исключение
        Возврат СостояниеПоУмолчанию;
    КонецПопытки;

КонецФункции


Процедура KOTFormExplorer_SaveRuntimeState(ПутьКСнимку, БыстраяСигнатура, ТокенСеанса = "", ЛокаторАктивен = Неопределено, БазоваяСигнатураЛокатора = Неопределено)

    ПредыдущееСостояние = KOTFormExplorer_ReadRuntimeState();
    Состояние = KOTFormExplorer_CreateDefaultRuntimeState();
    Состояние.Вставить("snapshotPath", ЗначениеВСтроку(ПутьКСнимку));
    Состояние.Вставить("quickSignature", ЗначениеВСтроку(БыстраяСигнатура));
    Состояние.Вставить("sessionToken", ЗначениеВСтроку(ТокенСеанса));

    Если ЛокаторАктивен = Неопределено Тогда
        Состояние.Вставить("locatorActive", KOTFormExplorer_GetBooleanSetting(ПредыдущееСостояние, "locatorActive", Ложь));
    Иначе
        Состояние.Вставить("locatorActive", ЛокаторАктивен);
    КонецЕсли;

    Если БазоваяСигнатураЛокатора = Неопределено Тогда
        Состояние.Вставить("locatorBaseSignature", KOTFormExplorer_GetStringSetting(ПредыдущееСостояние, "locatorBaseSignature", ""));
    Иначе
        Состояние.Вставить("locatorBaseSignature", ЗначениеВСтроку(БазоваяСигнатураЛокатора));
    КонецЕсли;

    KOTFormExplorer_WriteTextFile("${escapedStatePath}", ПреобразоватьВJSONСтроку(Состояние));

КонецПроцедуры


Функция KOTFormExplorer_ReadSnapshotObject(ПутьКСнимку)

    Попытка
        ТекстДокумент = Новый ТекстовыйДокумент;
        ТекстДокумент.Прочитать(ПутьКСнимку, КодировкаТекста.UTF8);
        ТекстJSON = ТекстДокумент.ПолучитьТекст();

        Если ЭтоПустаяСтрока(СокрЛП(ТекстJSON)) Тогда
            Возврат Неопределено;
        КонецЕсли;

        ЧтениеJSON = Новый ЧтениеJSON;
        ЧтениеJSON.УстановитьСтроку(ТекстJSON);
        Снимок = ПрочитатьJSON(ЧтениеJSON);
        ЧтениеJSON.Закрыть();

        Возврат Снимок;
    Исключение
        Возврат Неопределено;
    КонецПопытки;

КонецФункции


Функция KOTFormExplorer_CollectElementTableDataIndex(ПлоскиеЭлементы)

    Индекс = Новый Соответствие;
    Если ПлоскиеЭлементы = Неопределено Тогда
        Возврат Индекс;
    КонецЕсли;

    Для Каждого ОписаниеЭлемента Из ПлоскиеЭлементы Цикл
        ПутьЭлемента = ПолучитьСтрокуИзСтруктуры(ОписаниеЭлемента, "path");
        ТабличныеДанные = ПолучитьПараметр(ОписаниеЭлемента, "tableData");
        Если ЭтоПустаяСтрока(ПутьЭлемента) Или ТабличныеДанные = Неопределено Тогда
            Продолжить;
        КонецЕсли;

        Индекс.Вставить(ПутьЭлемента, ТабличныеДанные);
    КонецЦикла;

    Возврат Индекс;

КонецФункции


Процедура KOTFormExplorer_ApplyTableDataToSnapshotElements(Элементы, ТабличныеДанныеПоПути)

    Если Элементы = Неопределено Или ТабличныеДанныеПоПути = Неопределено Тогда
        Возврат;
    КонецЕсли;

    Для Каждого ОписаниеЭлемента Из Элементы Цикл
        ПутьЭлемента = ПолучитьСтрокуИзСтруктуры(ОписаниеЭлемента, "path");
        Если Не ЭтоПустаяСтрока(ПутьЭлемента) И ИндексСодержитКлюч(ТабличныеДанныеПоПути, ПутьЭлемента) Тогда
            ОписаниеЭлемента.Вставить("tableData", ТабличныеДанныеПоПути.Получить(ПутьЭлемента));
        КонецЕсли;

        ДочерниеЭлементы = ПолучитьПараметр(ОписаниеЭлемента, "children");
        Если ДочерниеЭлементы <> Неопределено Тогда
            KOTFormExplorer_ApplyTableDataToSnapshotElements(ДочерниеЭлементы, ТабличныеДанныеПоПути);
        КонецЕсли;
    КонецЦикла;

КонецПроцедуры


Функция KOTFormExplorer_UpdateSnapshotTables(ПараметрыВыполненияКоманды = Неопределено, Origin = "") Экспорт

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    БазовыйПутьКСнимку = KOTFormExplorer_GetStringSetting(Настройки, "snapshotPath", "${escapedSnapshotPath}");
    Если ЭтоПустаяСтрока(СокрЛП(БазовыйПутьКСнимку)) Тогда
        Возврат Ложь;
    КонецЕсли;

    Форма = KOTFormExplorer_DetectCurrentManagedForm(ПараметрыВыполненияКоманды);
    Если Форма = Неопределено Тогда
        Возврат Ложь;
    КонецЕсли;

    ПутьМетаданных = KOTFormExplorer_DetectFormMetadataPath(Форма);
    Если ПутьМетаданных = "CommonForm.${SETTINGS_FORM_NAME}" Тогда
        Возврат Ложь;
    КонецЕсли;

    ЗаголовокОкна = KOTFormExplorer_DetectFormWindowTitle(Форма, ПараметрыВыполненияКоманды);
    БыстраяСигнатура = KOTFormExplorer_BuildQuickSignature(Форма, ПараметрыВыполненияКоманды, ПутьМетаданных, ЗаголовокОкна);
    КонтекстИсточника = KOTFormExplorer_BuildSourceContext(Origin);
    ПутьКСнимку = KOTFormExplorer_ResolveSessionSnapshotPath(БазовыйПутьКСнимку);
    ТокенСеанса = KOTFormExplorer_GetSessionSnapshotToken();
    КонтекстЗапроса = KOTFormExplorer_ReadRequestContext();
    ПредпочтительныйПутьЭлемента = KOTFormExplorer_GetStringSetting(КонтекстЗапроса, "elementPath", "");

    ПлоскиеЭлементы = СобратьПлоскийСписокЭлементов(
        Форма,
        Ложь,
        ПредпочтительныйПутьЭлемента,
        Ложь,
        ""
    );
    АтрибутыФормы = СобратьАтрибутыФормы(Форма, ПлоскиеЭлементы);
    ТаблицыФормы = СобратьТабличныеИсточникиФормы(Форма, ПлоскиеЭлементы, АтрибутыФормы);

    Снимок = KOTFormExplorer_ReadSnapshotObject(ПутьКСнимку);
    Если Снимок = Неопределено Тогда
        Возврат KOTFormExplorer_WriteCurrentFormSnapshot(ПараметрыВыполненияКоманды, Origin, Ложь, Истина);
    КонецЕсли;

    Снимок.Вставить("generatedAt", ЗначениеВСтроку(ТекущаяДата()));
    Снимок.Вставить("source", КонтекстИсточника);
    Снимок.Вставить("tables", ТаблицыФормы);

    ОписаниеФормы = ПолучитьПараметр(Снимок, "form");
    Если ОписаниеФормы = Неопределено Тогда
        ОписаниеФормы = Новый Структура;
        Снимок.Вставить("form", ОписаниеФормы);
    КонецЕсли;
    ОписаниеФормы.Вставить("title", ЗаголовокОкна);
    ОписаниеФормы.Вставить("windowTitle", ЗаголовокОкна);
    ОписаниеФормы.Вставить("metadataPath", ПутьМетаданных);
    ОписаниеФормы.Вставить("activeElementPath", ПолучитьПутьАктивногоЭлемента(Форма, ПлоскиеЭлементы));

    ЭлементыСнимка = ПолучитьПараметр(Снимок, "elements");
    Если ЭлементыСнимка <> Неопределено Тогда
        KOTFormExplorer_ApplyTableDataToSnapshotElements(
            ЭлементыСнимка,
            KOTFormExplorer_CollectElementTableDataIndex(ПлоскиеЭлементы)
        );
    КонецЕсли;

    KOTFormExplorer_WriteTextFile(ПутьКСнимку, ПреобразоватьВJSONСтроку(Снимок));
    KOTFormExplorer_SaveRuntimeState(ПутьКСнимку, БыстраяСигнатура, ТокенСеанса);

    Возврат Истина;

КонецФункции


Функция KOTFormExplorer_BuildQuickSignature(Форма, ПараметрыВыполненияКоманды, ПутьМетаданных, ЗаголовокОкна)

    ТекущийЭлемент = ПолучитьТекущийЭлементФормы(Форма);
    ПутьАктивногоЭлемента = "";
    ПутьДанныхАктивногоЭлемента = "";
    ЗначениеАктивногоЭлемента = "";

    Если ТекущийЭлемент <> Неопределено Тогда
        ПутьАктивногоЭлемента = ПолучитьПутьЭлемента(ТекущийЭлемент);
        ПутьДанныхАктивногоЭлемента = ОпределитьПутьДанныхЭлемента(Форма, ТекущийЭлемент, ПолучитьПутьДанныхЭлемента(ТекущийЭлемент));
        ЗначениеАктивногоЭлемента = ПолучитьПредставлениеЗначенияЭлемента(Форма, ТекущийЭлемент, ПутьДанныхАктивногоЭлемента);
    КонецЕсли;

    Возврат ЗначениеВСтроку(ПутьМетаданных)
        + "|" + ЗначениеВСтроку(ЗаголовокОкна)
        + "|" + ЗначениеВСтроку(ПутьАктивногоЭлемента)
        + "|" + ЗначениеВСтроку(ЗначениеАктивногоЭлемента);

КонецФункции


Функция KOTFormExplorer_GetSessionSnapshotToken() Экспорт

    Состояние = KOTFormExplorer_ReadRuntimeState();
    ТокенСеанса = KOTFormExplorer_GetStringSetting(Состояние, "sessionToken", "");
    Если Не ЭтоПустаяСтрока(СокрЛП(ТокенСеанса)) Тогда
        Возврат ТокенСеанса;
    КонецЕсли;

    Попытка
        ТокенСеанса = СтрЗаменить(ЗначениеВСтроку(Новый УникальныйИдентификатор), "-", "");
    Исключение
        ТокенСеанса = Формат(ТекущаяДата(), "ДФ=yyyyMMddHHmmss");
    КонецПопытки;

    KOTFormExplorer_SaveRuntimeState(
        KOTFormExplorer_GetStringSetting(Состояние, "snapshotPath", ""),
        KOTFormExplorer_GetStringSetting(Состояние, "quickSignature", ""),
        ТокенСеанса
    );

    Возврат ЗначениеВСтроку(ТокенСеанса);

КонецФункции


Функция KOTFormExplorer_ResolveSessionSnapshotPath(БазовыйПутьКСнимку) Экспорт

    Если ЭтоПустаяСтрока(СокрЛП(ЗначениеВСтроку(БазовыйПутьКСнимку))) Тогда
        Возврат "";
    КонецЕсли;

    ТокенСеанса = KOTFormExplorer_GetSessionSnapshotToken();
    Если ЭтоПустаяСтрока(СокрЛП(ТокенСеанса)) Тогда
        Возврат ЗначениеВСтроку(БазовыйПутьКСнимку);
    КонецЕсли;

    Возврат ЗначениеВСтроку(БазовыйПутьКСнимку) + "." + ТокенСеанса + ".json";

КонецФункции


Процедура KOTFormExplorer_RunManualRefresh(ПараметрыВыполненияКоманды = Неопределено) Экспорт

    KOTFormExplorer_WriteCurrentFormSnapshot(ПараметрыВыполненияКоманды, "CommonCommand.${REFRESH_COMMAND_NAME}", Ложь, Ложь);
    KOTFormExplorer_ApplyAutoSnapshotSettings(Ложь);

КонецПроцедуры


Процедура KOTFormExplorer_RunTableRefresh(ПараметрыВыполненияКоманды = Неопределено) Экспорт

    KOTFormExplorer_UpdateSnapshotTables(ПараметрыВыполненияКоманды, "VSCode.TableRefresh");
    KOTFormExplorer_ApplyAutoSnapshotSettings(Ложь);

КонецПроцедуры


Процедура KOTFormExplorer_RunLocatorRefresh(ПараметрыВыполненияКоманды = Неопределено) Экспорт

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    Настройки.Вставить("autoSnapshotEnabled", Истина);
    KOTFormExplorer_SaveAdapterSettings(Настройки);

    Состояние = KOTFormExplorer_ReadRuntimeState();
    БазоваяСигнатура = KOTFormExplorer_GetStringSetting(Состояние, "quickSignature", "");

    Если ЭтоПустаяСтрока(СокрЛП(БазоваяСигнатура)) Тогда
        Форма = KOTFormExplorer_DetectCurrentManagedForm(ПараметрыВыполненияКоманды);
        Если Форма <> Неопределено Тогда
            БазоваяСигнатура = KOTFormExplorer_BuildQuickSignature(
                Форма,
                ПараметрыВыполненияКоманды,
                KOTFormExplorer_DetectFormMetadataPath(Форма),
                KOTFormExplorer_DetectFormWindowTitle(Форма, ПараметрыВыполненияКоманды)
            );
        КонецЕсли;
    КонецЕсли;

    KOTFormExplorer_SaveRuntimeState(
        KOTFormExplorer_GetStringSetting(Состояние, "snapshotPath", ""),
        KOTFormExplorer_GetStringSetting(Состояние, "quickSignature", ""),
        KOTFormExplorer_GetStringSetting(Состояние, "sessionToken", ""),
        Истина,
        БазоваяСигнатура
    );
    KOTFormExplorer_ApplyAutoSnapshotSettings(Истина);

КонецПроцедуры


Процедура KOTFormExplorer_ApplyLocatorStateAfterSnapshot(Настройки) Экспорт

    Состояние = KOTFormExplorer_ReadRuntimeState();
    Если Не KOTFormExplorer_GetBooleanSetting(Состояние, "locatorActive", Ложь) Тогда
        Возврат;
    КонецЕсли;

    БазоваяСигнатура = KOTFormExplorer_GetStringSetting(Состояние, "locatorBaseSignature", "");
    ТекущаяСигнатура = KOTFormExplorer_GetStringSetting(Состояние, "quickSignature", "");

    Если ЭтоПустаяСтрока(СокрЛП(БазоваяСигнатура)) Тогда
        KOTFormExplorer_SaveRuntimeState(
            KOTFormExplorer_GetStringSetting(Состояние, "snapshotPath", ""),
            ТекущаяСигнатура,
            KOTFormExplorer_GetStringSetting(Состояние, "sessionToken", ""),
            Истина,
            ТекущаяСигнатура
        );
        Возврат;
    КонецЕсли;

    Если БазоваяСигнатура = ТекущаяСигнатура Тогда
        Возврат;
    КонецЕсли;

    Настройки.Вставить("autoSnapshotEnabled", Ложь);
    KOTFormExplorer_SaveAdapterSettings(Настройки);
    KOTFormExplorer_SaveRuntimeState(
        KOTFormExplorer_GetStringSetting(Состояние, "snapshotPath", ""),
        ТекущаяСигнатура,
        KOTFormExplorer_GetStringSetting(Состояние, "sessionToken", ""),
        Ложь,
        ""
    );

КонецПроцедуры


Процедура KOTFormExplorer_HandleHotkeyRefresh(КодПресета, ПараметрыВыполненияКоманды = Неопределено) Экспорт

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    Если KOTFormExplorer_GetStringSetting(Настройки, "hotkeyPreset", "${DEFAULT_HOTKEY_PRESET_KEY}") <> ЗначениеВСтроку(КодПресета) Тогда
        Возврат;
    КонецЕсли;

    KOTFormExplorer_WriteCurrentFormSnapshot(ПараметрыВыполненияКоманды, "Hotkey." + ЗначениеВСтроку(КодПресета), Ложь, Ложь);
    KOTFormExplorer_ApplyAutoSnapshotSettings(Ложь);

КонецПроцедуры


Процедура KOTFormExplorer_StopAutoSnapshot() Экспорт

    Попытка
        ОтключитьОбработчикОжидания("KOTFormExplorer_AutoSnapshotIdleHandler");
    Исключение
    КонецПопытки;

КонецПроцедуры


Процедура KOTFormExplorer_StopModeRequestPolling() Экспорт

    Попытка
        ОтключитьОбработчикОжидания("KOTFormExplorer_ModeRequestIdleHandler");
    Исключение
    КонецПопытки;

КонецПроцедуры


Процедура KOTFormExplorer_ApplyModeRequestPolling(Принудительно = Ложь) Экспорт

    KOTFormExplorer_StopModeRequestPolling();
    ПодключитьОбработчикОжидания("KOTFormExplorer_ModeRequestIdleHandler", ${DEFAULT_MODE_REQUEST_POLL_INTERVAL_SECONDS}, Истина);

КонецПроцедуры


Процедура KOTFormExplorer_ApplyPendingModeRequest() Экспорт

    КодРежима = KOTFormExplorer_ReadModeRequestCode();
    Если ЭтоПустаяСтрока(КодРежима) Тогда
        Возврат;
    КонецЕсли;

    KOTFormExplorer_ClearModeRequest();

    Если КодРежима = "refresh" Тогда
        KOTFormExplorer_RunManualRefresh();
        Возврат;
    КонецЕсли;

    Если КодРежима = "table" Тогда
        KOTFormExplorer_RunTableRefresh();
        Возврат;
    КонецЕсли;

    Если КодРежима = "locator" Тогда
        KOTFormExplorer_RunLocatorRefresh();
        Возврат;
    КонецЕсли;

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    ТекущийРежим = KOTFormExplorer_GetModeCode(Настройки);
    Если КодРежима = ТекущийРежим Тогда
        KOTFormExplorer_SyncModeState(Настройки);
        Возврат;
    КонецЕсли;

    Настройки.Вставить("autoSnapshotEnabled", КодРежима = "auto");
    KOTFormExplorer_SaveAdapterSettings(Настройки);
    KOTFormExplorer_ApplyAutoSnapshotSettings(Истина);

КонецПроцедуры


Процедура KOTFormExplorer_ModeRequestIdleHandler() Экспорт

    KOTFormExplorer_ApplyPendingModeRequest();
    KOTFormExplorer_ApplyModeRequestPolling(Истина);

КонецПроцедуры


Процедура KOTFormExplorer_ApplyAutoSnapshotSettings(Принудительно = Ложь) Экспорт

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    KOTFormExplorer_SyncModeState(Настройки);
    KOTFormExplorer_ApplyModeRequestPolling(Принудительно);
    Если Не KOTFormExplorer_GetBooleanSetting(Настройки, "autoSnapshotEnabled", Ложь) Тогда
        KOTFormExplorer_StopAutoSnapshot();
        Возврат;
    КонецЕсли;

    Интервал = KOTFormExplorer_GetNumberSetting(Настройки, "autoSnapshotIntervalSeconds", ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS});
    Если Интервал < 1 Тогда
        Интервал = ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS};
    КонецЕсли;

    KOTFormExplorer_StopAutoSnapshot();
    ПодключитьОбработчикОжидания("KOTFormExplorer_AutoSnapshotIdleHandler", Интервал, Истина);

КонецПроцедуры


Процедура KOTFormExplorer_AutoSnapshotIdleHandler() Экспорт

    KOTFormExplorer_ApplyPendingModeRequest();
    Настройки = KOTFormExplorer_ReadAdapterSettings();
    Если Не KOTFormExplorer_GetBooleanSetting(Настройки, "autoSnapshotEnabled", Ложь) Тогда
        KOTFormExplorer_ApplyAutoSnapshotSettings(Истина);
        Возврат;
    КонецЕсли;

    KOTFormExplorer_WriteCurrentFormSnapshot(Неопределено, "AutoSnapshot", Истина);
    KOTFormExplorer_ApplyLocatorStateAfterSnapshot(Настройки);
    KOTFormExplorer_ApplyAutoSnapshotSettings(Истина);

КонецПроцедуры


Процедура KOTFormExplorer_ToggleSnapshotMode() Экспорт

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    НовоеЗначение = Не KOTFormExplorer_GetBooleanSetting(Настройки, "autoSnapshotEnabled", Ложь);
    Настройки.Вставить("autoSnapshotEnabled", НовоеЗначение);
    KOTFormExplorer_SaveAdapterSettings(Настройки);
    KOTFormExplorer_ApplyAutoSnapshotSettings(Истина);

КонецПроцедуры


Функция KOTFormExplorer_WriteCurrentFormSnapshot(
    ПараметрыВыполненияКоманды = Неопределено,
    Origin = "",
    ИспользоватьБыструюПроверку = Ложь,
    ВключатьТаблицы = Неопределено
) Экспорт

    Настройки = KOTFormExplorer_ReadAdapterSettings();
    БазовыйПутьКСнимку = KOTFormExplorer_GetStringSetting(Настройки, "snapshotPath", "${escapedSnapshotPath}");
    Если ЭтоПустаяСтрока(СокрЛП(БазовыйПутьКСнимку)) Тогда
        Возврат Ложь;
    КонецЕсли;

    Форма = KOTFormExplorer_DetectCurrentManagedForm(ПараметрыВыполненияКоманды);
    Если Форма = Неопределено Тогда
        Возврат Ложь;
    КонецЕсли;

    ПутьМетаданных = KOTFormExplorer_DetectFormMetadataPath(Форма);
    Если ПутьМетаданных = "CommonForm.${SETTINGS_FORM_NAME}" Тогда
        Возврат Ложь;
    КонецЕсли;

    ЗаголовокОкна = KOTFormExplorer_DetectFormWindowTitle(Форма, ПараметрыВыполненияКоманды);
    БыстраяСигнатура = KOTFormExplorer_BuildQuickSignature(Форма, ПараметрыВыполненияКоманды, ПутьМетаданных, ЗаголовокОкна);
    КонтекстИсточника = KOTFormExplorer_BuildSourceContext(Origin);
    ПутьКСнимку = KOTFormExplorer_ResolveSessionSnapshotPath(БазовыйПутьКСнимку);
    ТокенСеанса = KOTFormExplorer_GetSessionSnapshotToken();

    Если ИспользоватьБыструюПроверку Тогда
        Состояние = KOTFormExplorer_ReadRuntimeState();
        Если KOTFormExplorer_GetStringSetting(Состояние, "snapshotPath", "") = ЗначениеВСтроку(ПутьКСнимку)
            И KOTFormExplorer_GetStringSetting(Состояние, "quickSignature", "") = БыстраяСигнатура
            И KOTFormExplorer_GetStringSetting(Состояние, "sessionToken", "") = ЗначениеВСтроку(ТокенСеанса) Тогда
            Возврат Истина;
        КонецЕсли;
    КонецЕсли;

    ПутьТекущегоЭлемента = ПолучитьПутьЭлемента(ПолучитьТекущийЭлементФормы(Форма));
    РежимВключенияТаблиц = Не ИспользоватьБыструюПроверку;
    Если ВключатьТаблицы <> Неопределено Тогда
        РежимВключенияТаблиц = ВключатьТаблицы;
    КонецЕсли;

    ПараметрыСнимка = Новый Структура;
    ПараметрыСнимка.Вставить("MetadataPath", ПутьМетаданных);
    ПараметрыСнимка.Вставить("WindowTitle", ЗаголовокОкна);
    ПараметрыСнимка.Вставить("Source", КонтекстИсточника);
    ПараметрыСнимка.Вставить("IncludeTables", РежимВключенияТаблиц);
    ПараметрыСнимка.Вставить("IncludeElementTableData", РежимВключенияТаблиц);
    ПараметрыСнимка.Вставить("IncludeElementValues", Не ИспользоватьБыструюПроверку);
    Если ИспользоватьБыструюПроверку Тогда
        ПараметрыСнимка.Вставить(
            "PreferElementPathForTableData",
            ПутьТекущегоЭлемента
        );
        ПараметрыСнимка.Вставить(
            "PreferElementPathForValue",
            ПутьТекущегоЭлемента
        );
    КонецЕсли;

    Снимок = СформироватьСнимокФормы(Форма, ПараметрыСнимка);
    ТекстJSON = ПреобразоватьВJSONСтроку(Снимок);

    KOTFormExplorer_WriteTextFile(ПутьКСнимку, ТекстJSON);
    KOTFormExplorer_SaveRuntimeState(ПутьКСнимку, БыстраяСигнатура, ТокенСеанса);

    Возврат Истина;

КонецФункции


Функция KOTFormExplorer_DetectCurrentManagedForm(ПараметрыВыполненияКоманды = Неопределено) Экспорт

    Если ПараметрыВыполненияКоманды <> Неопределено Тогда
        Попытка
            Если ТипЗнч(ПараметрыВыполненияКоманды.Источник) = Тип("УправляемаяФорма") Тогда
                Возврат ПараметрыВыполненияКоманды.Источник;
            КонецЕсли;
        Исключение
        КонецПопытки;

        Попытка
            Если ПараметрыВыполненияКоманды.Окно <> Неопределено
                И ПараметрыВыполненияКоманды.Окно.Содержимое.Количество() > 0 Тогда

                ВозможнаяФорма = ПараметрыВыполненияКоманды.Окно.Содержимое[0];
                Если ТипЗнч(ВозможнаяФорма) = Тип("УправляемаяФорма") Тогда
                    Возврат ВозможнаяФорма;
                КонецЕсли;
            КонецЕсли;
        Исключение
        КонецПопытки;
    КонецЕсли;

    Форма = KOTFormExplorer_ExtractManagedFormFromWindow(АктивноеОкно());
    Если Форма <> Неопределено Тогда
        Возврат Форма;
    КонецЕсли;

    Попытка
        Для Каждого ОкноПриложения Из ПолучитьОкна() Цикл
            Форма = KOTFormExplorer_ExtractManagedFormFromWindow(ОкноПриложения);
            Если Форма <> Неопределено Тогда
                Возврат Форма;
            КонецЕсли;
        КонецЦикла;
    Исключение
    КонецПопытки;

    Возврат Неопределено;

КонецФункции


Функция KOTFormExplorer_ExtractManagedFormFromWindow(ОкноПриложения)

    Если ОкноПриложения = Неопределено Тогда
        Возврат Неопределено;
    КонецЕсли;

    СодержимоеОкна = Неопределено;
    Попытка
        СодержимоеОкна = ОкноПриложения.Содержимое;
    Исключение
    КонецПопытки;

    Если СодержимоеОкна = Неопределено Тогда
        Попытка
            СодержимоеОкна = ОкноПриложения.ПолучитьСодержимое();
        Исключение
        КонецПопытки;
    КонецЕсли;

    Если СодержимоеОкна = Неопределено Тогда
        Возврат Неопределено;
    КонецЕсли;

    Для Каждого ЭлементОкна Из СодержимоеОкна Цикл
        Попытка
            Если ТипЗнч(ЭлементОкна) = Тип("УправляемаяФорма") Тогда
                Возврат ЭлементОкна;
            КонецЕсли;
        Исключение
        КонецПопытки;
    КонецЦикла;

    Возврат Неопределено;

КонецФункции


Функция KOTFormExplorer_DetectFormMetadataPath(Форма) Экспорт

    Попытка
        МетаданныеФормы = Форма.Метаданные();
        Если МетаданныеФормы <> Неопределено Тогда
            Попытка
                Возврат МетаданныеФормы.ПолноеИмя();
            Исключение
            КонецПопытки;

            Возврат Строка(МетаданныеФормы);
        КонецЕсли;
    Исключение
    КонецПопытки;

    Попытка
        Возврат Строка(Форма.ИмяФормы);
    Исключение
    КонецПопытки;

    Возврат "";

КонецФункции


Функция KOTFormExplorer_DetectFormWindowTitle(Форма, ПараметрыВыполненияКоманды = Неопределено) Экспорт

    Попытка
        Если ПараметрыВыполненияКоманды <> Неопределено
            И ПараметрыВыполненияКоманды.Окно <> Неопределено Тогда
            Попытка
                Возврат ПараметрыВыполненияКоманды.Окно.Заголовок;
            Исключение
            КонецПопытки;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Попытка
        Если Форма <> Неопределено И Форма.Окно <> Неопределено Тогда
            Попытка
                Возврат Форма.Окно.Заголовок;
            Исключение
            КонецПопытки;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Попытка
        Если АктивноеОкно() <> Неопределено Тогда
            Попытка
                Возврат АктивноеОкно().Заголовок;
            Исключение
            КонецПопытки;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Возврат "";

КонецФункции


Функция KOTFormExplorer_TryEvaluateExpression(Выражение, ЗначениеПоУмолчанию = "")

    Попытка
        Возврат Вычислить(Выражение);
    Исключение
        Возврат ЗначениеПоУмолчанию;
    КонецПопытки;

КонецФункции


Функция KOTFormExplorer_DetectInfobaseMarker() Экспорт

    Кандидаты = Новый Массив;
    Кандидаты.Добавить(KOTFormExplorer_TryEvaluateExpression("ИнформационнаяБаза()", ""));
    Кандидаты.Добавить(KOTFormExplorer_TryEvaluateExpression("Infobase()", ""));
    Кандидаты.Добавить(KOTFormExplorer_TryEvaluateExpression("InfobaseConnectionString()", ""));

    Для Каждого Кандидат Из Кандидаты Цикл
        СтрокаКандидата = СокрЛП(ЗначениеВСтроку(Кандидат));
        Если Не ЭтоПустаяСтрока(СтрокаКандидата) Тогда
            Возврат СтрокаКандидата;
        КонецЕсли;
    КонецЦикла;

    Возврат "";

КонецФункции


Функция KOTFormExplorer_BuildSourceContext(Origin = "") Экспорт

    Источник = Новый Структура;
    Источник.Вставить("adapter", "KOT Form Explorer Runtime");
    Источник.Вставить("origin", ЗначениеВСтроку(Origin));
    Источник.Вставить("infobase", KOTFormExplorer_DetectInfobaseMarker());
    Источник.Вставить("sessionId", KOTFormExplorer_GetSessionSnapshotToken());
    Источник.Вставить("configurationSourceDirectory", "${escapedConfigurationSourceDirectory}");

    Возврат Источник;

КонецФункции


Функция KOTFormExplorer_TryWriteTextFile(ПутьКФайлу, Текст)

    ИмяВременногоФайла = ПолучитьИмяВременногоФайла("json");
    Успешно = Ложь;

    Попытка
        ТекстДокумент = Новый ТекстовыйДокумент;
        ТекстДокумент.УстановитьТекст(Текст);
        ТекстДокумент.Записать(ИмяВременногоФайла, КодировкаТекста.UTF8);
        КопироватьФайл(ИмяВременногоФайла, ПутьКФайлу);
        Успешно = Истина;
    Исключение
    КонецПопытки;

    Попытка
        УдалитьФайлы(ИмяВременногоФайла);
    Исключение
    КонецПопытки;

    Возврат Успешно;

КонецФункции


Функция KOTFormExplorer_GetConfigurationExtensionsCollection()

    Попытка
        Возврат Вычислить("ConfigurationExtensions.Get()");
    Исключение
    КонецПопытки;

    Попытка
        Возврат Вычислить("РасширенияКонфигурации.Получить()");
    Исключение
    КонецПопытки;

    Возврат Неопределено;

КонецФункции


Функция KOTFormExplorer_TryDisableOwnSafeMode()

    Расширения = KOTFormExplorer_GetConfigurationExtensionsCollection();
    Если Расширения = Неопределено Тогда
        Возврат Ложь;
    КонецЕсли;

    Для Каждого Расширение Из Расширения Цикл
        ИмяРасширения = "";
        Попытка
            ИмяРасширения = НРег(СокрЛП(ЗначениеВСтроку(Расширение.Name)));
        Исключение
        КонецПопытки;

        Если ИмяРасширения <> НРег("${GENERATED_EXTENSION_NAME}") Тогда
            Продолжить;
        КонецЕсли;

        ЕстьИзменения = Ложь;

        Попытка
            Если Расширение.SafeMode Тогда
                Расширение.SafeMode = Ложь;
                ЕстьИзменения = Истина;
            КонецЕсли;
        Исключение
        КонецПопытки;

        Попытка
            Если Расширение.UnsafeActionProtection Тогда
                Расширение.UnsafeActionProtection = Ложь;
                ЕстьИзменения = Истина;
            КонецЕсли;
        Исключение
        КонецПопытки;

        Если ЕстьИзменения Тогда
            Попытка
                Расширение.Write();
            Исключение
                Возврат Ложь;
            КонецПопытки;
        КонецЕсли;

        Возврат Истина;
    КонецЦикла;

    Возврат Ложь;

КонецФункции


Процедура KOTFormExplorer_WriteTextFile(ПутьКФайлу, Текст)

    Если ЭтоПустаяСтрока(СокрЛП(ПутьКФайлу)) Тогда
        Возврат;
    КонецЕсли;

    Попытка
        Если KOTFormExplorer_TryWriteTextFile(ПутьКФайлу, Текст) Тогда
            Возврат;
        КонецЕсли;
    Исключение
        Возврат;
    КонецПопытки;

    Попытка
        Если KOTFormExplorer_TryDisableOwnSafeMode() Тогда
            KOTFormExplorer_TryWriteTextFile(ПутьКФайлу, Текст);
        КонецЕсли;
    Исключение
    КонецПопытки;

КонецПроцедуры
`;
}

function buildAdapterSupportTextEnglish(
    snapshotPath: string,
    settingsPath: string,
    configurationSourceDirectory: string
): string {
    const escapedSnapshotPath = escapeBslStringLiteral(snapshotPath);
    const escapedSettingsPath = escapeBslStringLiteral(settingsPath);
    const escapedStatePath = escapeBslStringLiteral(path.join(path.dirname(settingsPath), DEFAULT_RUNTIME_STATE_FILE_NAME));
    const escapedModePath = escapeBslStringLiteral(path.join(path.dirname(settingsPath), DEFAULT_MODE_STATE_FILE_NAME));
    const escapedModeRequestPath = escapeBslStringLiteral(path.join(path.dirname(settingsPath), DEFAULT_MODE_REQUEST_FILE_NAME));
    const escapedRequestContextPath = escapeBslStringLiteral(path.join(path.dirname(settingsPath), DEFAULT_REQUEST_CONTEXT_FILE_NAME));
    const escapedConfigurationSourceDirectory = escapeBslStringLiteral(configurationSourceDirectory);

    return `

Function KOTFormExplorer_CreateDefaultSettings() Export

    Settings = New Structure;
    Settings.Insert("snapshotPath", "${escapedSnapshotPath}");
    Settings.Insert("hotkeyPreset", "${DEFAULT_HOTKEY_PRESET_KEY}");
    Settings.Insert("autoSnapshotEnabled", False);
    Settings.Insert("autoSnapshotIntervalSeconds", ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS});

    Return Settings;

EndFunction


Function KOTFormExplorer_GetStringSetting(Settings, SettingName, DefaultValue = "") Export

    Return ЗначениеВСтроку(ПолучитьПараметр(Settings, SettingName, DefaultValue));

EndFunction


Function KOTFormExplorer_GetBooleanSetting(Settings, SettingName, DefaultValue = False) Export

    Value = ПолучитьПараметр(Settings, SettingName, DefaultValue);

    Try
        If TypeOf(Value) = Type("Boolean") Then
            Return Value;
        EndIf;
    Except
    EndTry;

    Return DefaultValue;

EndFunction


Function KOTFormExplorer_GetNumberSetting(Settings, SettingName, DefaultValue = 0) Export

    Value = ПолучитьПараметр(Settings, SettingName, DefaultValue);

    Try
        If Value = Undefined Then
            Return DefaultValue;
        EndIf;

        If Value < 1 Then
            Return DefaultValue;
        EndIf;

        Return Value;
    Except
        Return DefaultValue;
    EndTry;

EndFunction


Function KOTFormExplorer_NormalizeSettings(Settings)

    ResultSettings = KOTFormExplorer_CreateDefaultSettings();
    If Settings = Undefined Then
        Return ResultSettings;
    EndIf;

    ResultSettings.Insert("snapshotPath",
        KOTFormExplorer_GetStringSetting(Settings, "snapshotPath", KOTFormExplorer_GetStringSetting(ResultSettings, "snapshotPath", "")));
    ResultSettings.Insert("hotkeyPreset",
        KOTFormExplorer_GetStringSetting(Settings, "hotkeyPreset", KOTFormExplorer_GetStringSetting(ResultSettings, "hotkeyPreset", "${DEFAULT_HOTKEY_PRESET_KEY}")));
    ResultSettings.Insert("autoSnapshotEnabled",
        KOTFormExplorer_GetBooleanSetting(Settings, "autoSnapshotEnabled", False));
    ResultSettings.Insert("autoSnapshotIntervalSeconds",
        KOTFormExplorer_GetNumberSetting(Settings, "autoSnapshotIntervalSeconds", ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS}));

    Return ResultSettings;

EndFunction


Function KOTFormExplorer_ReadAdapterSettings() Export

    DefaultSettings = KOTFormExplorer_CreateDefaultSettings();

    Try
        TextDocument = New TextDocument;
        TextDocument.Read("${escapedSettingsPath}", TextEncoding.UTF8);
        JSONText = TextDocument.GetText();

        If IsBlankString(TrimAll(JSONText)) Then
            Return DefaultSettings;
        EndIf;

        JSONReader = New JSONReader;
        JSONReader.SetString(JSONText);
        Settings = ReadJSON(JSONReader);
        JSONReader.Close();

        Return KOTFormExplorer_NormalizeSettings(Settings);
    Except
        Return DefaultSettings;
    EndTry;

EndFunction


Procedure KOTFormExplorer_SaveAdapterSettings(Settings) Export

    NormalizedSettings = KOTFormExplorer_NormalizeSettings(Settings);
    KOTFormExplorer_WriteTextFile("${escapedSettingsPath}", ПреобразоватьВJSONСтроку(NormalizedSettings));
    KOTFormExplorer_SyncModeState(NormalizedSettings);

EndProcedure


Function KOTFormExplorer_GetModeCode(Settings) Export

    If KOTFormExplorer_GetBooleanSetting(Settings, "autoSnapshotEnabled", False) Then
        Return "auto";
    EndIf;

    Return "manual";

EndFunction


Procedure KOTFormExplorer_WriteModeState(ModeCode) Export

    KOTFormExplorer_WriteTextFile("${escapedModePath}", ЗначениеВСтроку(ModeCode));

EndProcedure


Procedure KOTFormExplorer_SyncModeState(Settings = Undefined) Export

    LocalSettings = Settings;
    If LocalSettings = Undefined Then
        LocalSettings = KOTFormExplorer_ReadAdapterSettings();
    EndIf;

    KOTFormExplorer_WriteModeState(KOTFormExplorer_GetModeCode(LocalSettings));

EndProcedure


Procedure KOTFormExplorer_InitializeSessionMode() Export

    Settings = KOTFormExplorer_ReadAdapterSettings();
    Settings.Insert("autoSnapshotEnabled", False);
    KOTFormExplorer_SaveAdapterSettings(Settings);
    KOTFormExplorer_ClearModeRequest();
    KOTFormExplorer_ApplyAutoSnapshotSettings(True);

EndProcedure


Function KOTFormExplorer_NormalizeModeCode(Value) Export

    ModeCode = Lower(TrimAll(ЗначениеВСтроку(Value)));
    If ModeCode = "auto" Or ModeCode = "1" Or ModeCode = "true" Then
        Return "auto";
    EndIf;

    If ModeCode = "manual" Or ModeCode = "0" Or ModeCode = "false" Then
        Return "manual";
    EndIf;

    If ModeCode = "refresh" Or ModeCode = "snapshot" Then
        Return "refresh";
    EndIf;

    If ModeCode = "table" Or ModeCode = "tables" Then
        Return "table";
    EndIf;

    If ModeCode = "locator" Or ModeCode = "locate" Then
        Return "locator";
    EndIf;

    Return "";

EndFunction


Function KOTFormExplorer_ReadModeRequestCode() Export

    Try
        TextDocument = New TextDocument;
        TextDocument.Read("${escapedModeRequestPath}", TextEncoding.UTF8);
        Return KOTFormExplorer_NormalizeModeCode(TextDocument.GetText());
    Except
        Return "";
    EndTry;

EndFunction


Procedure KOTFormExplorer_ClearModeRequest() Export

    KOTFormExplorer_WriteTextFile("${escapedModeRequestPath}", "");

EndProcedure


Function KOTFormExplorer_ReadRequestContext() Export

    Try
        TextDocument = New TextDocument;
        TextDocument.Read("${escapedRequestContextPath}", TextEncoding.UTF8);
        JSONText = TextDocument.GetText();

        If IsBlankString(TrimAll(JSONText)) Then
            Return New Structure;
        EndIf;

        JSONReader = New JSONReader;
        JSONReader.SetString(JSONText);
        Context = ReadJSON(JSONReader);
        JSONReader.Close();

        If Context = Undefined Then
            Return New Structure;
        EndIf;

        Return Context;
    Except
        Return New Structure;
    EndTry;

EndFunction


Function KOTFormExplorer_CreateDefaultRuntimeState()

    State = New Structure;
    State.Insert("snapshotPath", "");
    State.Insert("quickSignature", "");
    State.Insert("sessionToken", "");
    State.Insert("locatorActive", False);
    State.Insert("locatorBaseSignature", "");

    Return State;

EndFunction


Function KOTFormExplorer_ReadRuntimeState()

    DefaultState = KOTFormExplorer_CreateDefaultRuntimeState();

    Try
        TextDocument = New TextDocument;
        TextDocument.Read("${escapedStatePath}", TextEncoding.UTF8);
        JSONText = TextDocument.GetText();

        If IsBlankString(TrimAll(JSONText)) Then
            Return DefaultState;
        EndIf;

        JSONReader = New JSONReader;
        JSONReader.SetString(JSONText);
        State = ReadJSON(JSONReader);
        JSONReader.Close();

        If State = Undefined Then
            Return DefaultState;
        EndIf;

        Return State;
    Except
        Return DefaultState;
    EndTry;

EndFunction


Procedure KOTFormExplorer_SaveRuntimeState(SnapshotPath, QuickSignature, SessionToken = "", LocatorActive = Undefined, LocatorBaseSignature = Undefined)

    PreviousState = KOTFormExplorer_ReadRuntimeState();
    State = KOTFormExplorer_CreateDefaultRuntimeState();
    State.Insert("snapshotPath", ЗначениеВСтроку(SnapshotPath));
    State.Insert("quickSignature", ЗначениеВСтроку(QuickSignature));
    State.Insert("sessionToken", ЗначениеВСтроку(SessionToken));

    If LocatorActive = Undefined Then
        State.Insert("locatorActive", KOTFormExplorer_GetBooleanSetting(PreviousState, "locatorActive", False));
    Else
        State.Insert("locatorActive", LocatorActive);
    EndIf;

    If LocatorBaseSignature = Undefined Then
        State.Insert("locatorBaseSignature", KOTFormExplorer_GetStringSetting(PreviousState, "locatorBaseSignature", ""));
    Else
        State.Insert("locatorBaseSignature", ЗначениеВСтроку(LocatorBaseSignature));
    EndIf;

    KOTFormExplorer_WriteTextFile("${escapedStatePath}", ПреобразоватьВJSONСтроку(State));

EndProcedure


Function KOTFormExplorer_ReadSnapshotObject(SnapshotPath)

    Try
        TextDocument = New TextDocument;
        TextDocument.Read(SnapshotPath, TextEncoding.UTF8);
        JSONText = TextDocument.GetText();

        If IsBlankString(TrimAll(JSONText)) Then
            Return Undefined;
        EndIf;

        JSONReader = New JSONReader;
        JSONReader.SetString(JSONText);
        Snapshot = ReadJSON(JSONReader);
        JSONReader.Close();

        Return Snapshot;
    Except
        Return Undefined;
    EndTry;

EndFunction


Function KOTFormExplorer_CollectElementTableDataIndex(FlatElements)

    Index = New Map;
    If FlatElements = Undefined Then
        Return Index;
    EndIf;

    For Each ElementDescription In FlatElements Do
        ElementPath = ПолучитьСтрокуИзСтруктуры(ElementDescription, "path");
        TableData = ПолучитьПараметр(ElementDescription, "tableData");
        If IsBlankString(TrimAll(ElementPath)) Or TableData = Undefined Then
            Continue;
        EndIf;

        Index.Insert(ElementPath, TableData);
    EndDo;

    Return Index;

EndFunction


Procedure KOTFormExplorer_ApplyTableDataToSnapshotElements(Elements, TableDataByPath)

    If Elements = Undefined Or TableDataByPath = Undefined Then
        Return;
    EndIf;

    For Each ElementDescription In Elements Do
        ElementPath = ПолучитьСтрокуИзСтруктуры(ElementDescription, "path");
        If Not IsBlankString(TrimAll(ElementPath)) And ИндексСодержитКлюч(TableDataByPath, ElementPath) Then
            ElementDescription.Insert("tableData", TableDataByPath.Get(ElementPath));
        EndIf;

        ChildElements = ПолучитьПараметр(ElementDescription, "children");
        If ChildElements <> Undefined Then
            KOTFormExplorer_ApplyTableDataToSnapshotElements(ChildElements, TableDataByPath);
        EndIf;
    EndDo;

EndProcedure


Function KOTFormExplorer_UpdateSnapshotTables(ExecutionParameters = Undefined, Origin = "") Export

    Settings = KOTFormExplorer_ReadAdapterSettings();
    BaseSnapshotPath = KOTFormExplorer_GetStringSetting(Settings, "snapshotPath", "${escapedSnapshotPath}");
    If IsBlankString(TrimAll(BaseSnapshotPath)) Then
        Return False;
    EndIf;

    Form = KOTFormExplorer_DetectCurrentManagedForm(ExecutionParameters);
    If Form = Undefined Then
        Return False;
    EndIf;

    MetadataPath = KOTFormExplorer_DetectFormMetadataPath(Form);
    If MetadataPath = "CommonForm.${SETTINGS_FORM_NAME}" Then
        Return False;
    EndIf;

    WindowTitle = KOTFormExplorer_DetectFormWindowTitle(Form, ExecutionParameters);
    QuickSignature = KOTFormExplorer_BuildQuickSignature(Form, ExecutionParameters, MetadataPath, WindowTitle);
    SourceContext = KOTFormExplorer_BuildSourceContext(Origin);
    SnapshotPath = KOTFormExplorer_ResolveSessionSnapshotPath(BaseSnapshotPath);
    SessionToken = KOTFormExplorer_GetSessionSnapshotToken();
    RequestContext = KOTFormExplorer_ReadRequestContext();
    PreferredElementPath = KOTFormExplorer_GetStringSetting(RequestContext, "elementPath", "");

    FlatElements = СобратьПлоскийСписокЭлементов(
        Form,
        False,
        PreferredElementPath,
        False,
        ""
    );
    FormAttributes = СобратьАтрибутыФормы(Form, FlatElements);
    FormTables = СобратьТабличныеИсточникиФормы(Form, FlatElements, FormAttributes);

    Snapshot = KOTFormExplorer_ReadSnapshotObject(SnapshotPath);
    If Snapshot = Undefined Then
        Return KOTFormExplorer_WriteCurrentFormSnapshot(ExecutionParameters, Origin, False, True);
    EndIf;

    Snapshot.Insert("generatedAt", ЗначениеВСтроку(CurrentDate()));
    Snapshot.Insert("source", SourceContext);
    Snapshot.Insert("tables", FormTables);

    FormDescription = ПолучитьПараметр(Snapshot, "form");
    If FormDescription = Undefined Then
        FormDescription = New Structure;
        Snapshot.Insert("form", FormDescription);
    EndIf;
    FormDescription.Insert("title", WindowTitle);
    FormDescription.Insert("windowTitle", WindowTitle);
    FormDescription.Insert("metadataPath", MetadataPath);
    FormDescription.Insert("activeElementPath", ПолучитьПутьАктивногоЭлемента(Form, FlatElements));

    SnapshotElements = ПолучитьПараметр(Snapshot, "elements");
    If SnapshotElements <> Undefined Then
        KOTFormExplorer_ApplyTableDataToSnapshotElements(
            SnapshotElements,
            KOTFormExplorer_CollectElementTableDataIndex(FlatElements)
        );
    EndIf;

    KOTFormExplorer_WriteTextFile(SnapshotPath, ПреобразоватьВJSONСтроку(Snapshot));
    KOTFormExplorer_SaveRuntimeState(SnapshotPath, QuickSignature, SessionToken);

    Return True;

EndFunction


Function KOTFormExplorer_BuildQuickSignature(Form, ExecutionParameters, MetadataPath, WindowTitle)

    CurrentItem = ПолучитьТекущийЭлементФормы(Form);
    ActiveElementPath = "";
    ActiveDataPath = "";
    ActiveValue = "";

    If CurrentItem <> Undefined Then
        ActiveElementPath = ПолучитьПутьЭлемента(CurrentItem);
        ActiveDataPath = ОпределитьПутьДанныхЭлемента(Form, CurrentItem, ПолучитьПутьДанныхЭлемента(CurrentItem));
        ActiveValue = ПолучитьПредставлениеЗначенияЭлемента(Form, CurrentItem, ActiveDataPath);
    EndIf;

    Return ЗначениеВСтроку(MetadataPath)
        + "|" + ЗначениеВСтроку(WindowTitle)
        + "|" + ЗначениеВСтроку(ActiveElementPath)
        + "|" + ЗначениеВСтроку(ActiveValue);

EndFunction


Function KOTFormExplorer_GetSessionSnapshotToken() Export

    State = KOTFormExplorer_ReadRuntimeState();
    SessionToken = KOTFormExplorer_GetStringSetting(State, "sessionToken", "");
    If Not IsBlankString(TrimAll(SessionToken)) Then
        Return SessionToken;
    EndIf;

    Try
        SessionToken = StrReplace(ЗначениеВСтроку(New UUID), "-", "");
    Except
        SessionToken = Format(CurrentDate(), "DF=yyyyMMddHHmmss");
    EndTry;

    KOTFormExplorer_SaveRuntimeState(
        KOTFormExplorer_GetStringSetting(State, "snapshotPath", ""),
        KOTFormExplorer_GetStringSetting(State, "quickSignature", ""),
        SessionToken
    );

    Return ЗначениеВСтроку(SessionToken);

EndFunction


Function KOTFormExplorer_ResolveSessionSnapshotPath(BaseSnapshotPath) Export

    If IsBlankString(TrimAll(ЗначениеВСтроку(BaseSnapshotPath))) Then
        Return "";
    EndIf;

    SessionToken = KOTFormExplorer_GetSessionSnapshotToken();
    If IsBlankString(TrimAll(SessionToken)) Then
        Return ЗначениеВСтроку(BaseSnapshotPath);
    EndIf;

    Return ЗначениеВСтроку(BaseSnapshotPath) + "." + SessionToken + ".json";

EndFunction


Procedure KOTFormExplorer_RunManualRefresh(ExecutionParameters = Undefined) Export

    KOTFormExplorer_WriteCurrentFormSnapshot(ExecutionParameters, "CommonCommand.${REFRESH_COMMAND_NAME}", False, False);
    KOTFormExplorer_ApplyAutoSnapshotSettings(False);

EndProcedure


Procedure KOTFormExplorer_RunTableRefresh(ExecutionParameters = Undefined) Export

    KOTFormExplorer_UpdateSnapshotTables(ExecutionParameters, "VSCode.TableRefresh");
    KOTFormExplorer_ApplyAutoSnapshotSettings(False);

EndProcedure


Procedure KOTFormExplorer_RunLocatorRefresh(ExecutionParameters = Undefined) Export

    Settings = KOTFormExplorer_ReadAdapterSettings();
    Settings.Insert("autoSnapshotEnabled", True);
    KOTFormExplorer_SaveAdapterSettings(Settings);

    State = KOTFormExplorer_ReadRuntimeState();
    BaseSignature = KOTFormExplorer_GetStringSetting(State, "quickSignature", "");

    If IsBlankString(TrimAll(BaseSignature)) Then
        Form = KOTFormExplorer_DetectCurrentManagedForm(ExecutionParameters);
        If Form <> Undefined Then
            BaseSignature = KOTFormExplorer_BuildQuickSignature(
                Form,
                ExecutionParameters,
                KOTFormExplorer_DetectFormMetadataPath(Form),
                KOTFormExplorer_DetectFormWindowTitle(Form, ExecutionParameters)
            );
        EndIf;
    EndIf;

    KOTFormExplorer_SaveRuntimeState(
        KOTFormExplorer_GetStringSetting(State, "snapshotPath", ""),
        KOTFormExplorer_GetStringSetting(State, "quickSignature", ""),
        KOTFormExplorer_GetStringSetting(State, "sessionToken", ""),
        True,
        BaseSignature
    );
    KOTFormExplorer_ApplyAutoSnapshotSettings(True);

EndProcedure


Procedure KOTFormExplorer_ApplyLocatorStateAfterSnapshot(Settings) Export

    State = KOTFormExplorer_ReadRuntimeState();
    If Not KOTFormExplorer_GetBooleanSetting(State, "locatorActive", False) Then
        Return;
    EndIf;

    BaseSignature = KOTFormExplorer_GetStringSetting(State, "locatorBaseSignature", "");
    CurrentSignature = KOTFormExplorer_GetStringSetting(State, "quickSignature", "");

    If IsBlankString(TrimAll(BaseSignature)) Then
        KOTFormExplorer_SaveRuntimeState(
            KOTFormExplorer_GetStringSetting(State, "snapshotPath", ""),
            CurrentSignature,
            KOTFormExplorer_GetStringSetting(State, "sessionToken", ""),
            True,
            CurrentSignature
        );
        Return;
    EndIf;

    If BaseSignature = CurrentSignature Then
        Return;
    EndIf;

    Settings.Insert("autoSnapshotEnabled", False);
    KOTFormExplorer_SaveAdapterSettings(Settings);
    KOTFormExplorer_SaveRuntimeState(
        KOTFormExplorer_GetStringSetting(State, "snapshotPath", ""),
        CurrentSignature,
        KOTFormExplorer_GetStringSetting(State, "sessionToken", ""),
        False,
        ""
    );

EndProcedure


Procedure KOTFormExplorer_HandleHotkeyRefresh(PresetKey, ExecutionParameters = Undefined) Export

    Settings = KOTFormExplorer_ReadAdapterSettings();
    If KOTFormExplorer_GetStringSetting(Settings, "hotkeyPreset", "${DEFAULT_HOTKEY_PRESET_KEY}") <> ЗначениеВСтроку(PresetKey) Then
        Return;
    EndIf;

    KOTFormExplorer_WriteCurrentFormSnapshot(ExecutionParameters, "Hotkey." + ЗначениеВСтроку(PresetKey), False, False);
    KOTFormExplorer_ApplyAutoSnapshotSettings(False);

EndProcedure


Procedure KOTFormExplorer_StopAutoSnapshot() Export

    Try
        DetachIdleHandler("KOTFormExplorer_AutoSnapshotIdleHandler");
    Except
    EndTry;

EndProcedure


Procedure KOTFormExplorer_StopModeRequestPolling() Export

    Try
        DetachIdleHandler("KOTFormExplorer_ModeRequestIdleHandler");
    Except
    EndTry;

EndProcedure


Procedure KOTFormExplorer_ApplyModeRequestPolling(Force = False) Export

    KOTFormExplorer_StopModeRequestPolling();
    AttachIdleHandler("KOTFormExplorer_ModeRequestIdleHandler", ${DEFAULT_MODE_REQUEST_POLL_INTERVAL_SECONDS}, True);

EndProcedure


Procedure KOTFormExplorer_ApplyPendingModeRequest() Export

    ModeCode = KOTFormExplorer_ReadModeRequestCode();
    If IsBlankString(ModeCode) Then
        Return;
    EndIf;

    KOTFormExplorer_ClearModeRequest();

    If ModeCode = "refresh" Then
        KOTFormExplorer_RunManualRefresh();
        Return;
    EndIf;

    If ModeCode = "table" Then
        KOTFormExplorer_RunTableRefresh();
        Return;
    EndIf;

    If ModeCode = "locator" Then
        KOTFormExplorer_RunLocatorRefresh();
        Return;
    EndIf;

    Settings = KOTFormExplorer_ReadAdapterSettings();
    CurrentMode = KOTFormExplorer_GetModeCode(Settings);
    If ModeCode = CurrentMode Then
        KOTFormExplorer_SyncModeState(Settings);
        Return;
    EndIf;

    Settings.Insert("autoSnapshotEnabled", ModeCode = "auto");
    KOTFormExplorer_SaveAdapterSettings(Settings);
    KOTFormExplorer_ApplyAutoSnapshotSettings(True);

EndProcedure


Procedure KOTFormExplorer_ModeRequestIdleHandler() Export

    KOTFormExplorer_ApplyPendingModeRequest();
    KOTFormExplorer_ApplyModeRequestPolling(True);

EndProcedure


Procedure KOTFormExplorer_ApplyAutoSnapshotSettings(Force = False) Export

    Settings = KOTFormExplorer_ReadAdapterSettings();
    KOTFormExplorer_SyncModeState(Settings);
    KOTFormExplorer_ApplyModeRequestPolling(Force);
    If Not KOTFormExplorer_GetBooleanSetting(Settings, "autoSnapshotEnabled", False) Then
        KOTFormExplorer_StopAutoSnapshot();
        Return;
    EndIf;

    Interval = KOTFormExplorer_GetNumberSetting(Settings, "autoSnapshotIntervalSeconds", ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS});
    If Interval < 1 Then
        Interval = ${DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS};
    EndIf;

    KOTFormExplorer_StopAutoSnapshot();
    AttachIdleHandler("KOTFormExplorer_AutoSnapshotIdleHandler", Interval, True);

EndProcedure


Procedure KOTFormExplorer_AutoSnapshotIdleHandler() Export

    KOTFormExplorer_ApplyPendingModeRequest();
    Settings = KOTFormExplorer_ReadAdapterSettings();
    If Not KOTFormExplorer_GetBooleanSetting(Settings, "autoSnapshotEnabled", False) Then
        KOTFormExplorer_ApplyAutoSnapshotSettings(True);
        Return;
    EndIf;

    KOTFormExplorer_WriteCurrentFormSnapshot(Undefined, "AutoSnapshot", True);
    KOTFormExplorer_ApplyLocatorStateAfterSnapshot(Settings);
    KOTFormExplorer_ApplyAutoSnapshotSettings(True);

EndProcedure


Procedure KOTFormExplorer_ToggleSnapshotMode() Export

    Settings = KOTFormExplorer_ReadAdapterSettings();
    NewValue = Not KOTFormExplorer_GetBooleanSetting(Settings, "autoSnapshotEnabled", False);
    Settings.Insert("autoSnapshotEnabled", NewValue);
    KOTFormExplorer_SaveAdapterSettings(Settings);
    KOTFormExplorer_ApplyAutoSnapshotSettings(True);

EndProcedure


Function KOTFormExplorer_WriteCurrentFormSnapshot(
    ExecutionParameters = Undefined,
    Origin = "",
    UseQuickCheck = False,
    IncludeTables = Undefined
) Export

    Settings = KOTFormExplorer_ReadAdapterSettings();
    BaseSnapshotPath = KOTFormExplorer_GetStringSetting(Settings, "snapshotPath", "${escapedSnapshotPath}");
    If IsBlankString(TrimAll(BaseSnapshotPath)) Then
        Return False;
    EndIf;

    Form = KOTFormExplorer_DetectCurrentManagedForm(ExecutionParameters);
    If Form = Undefined Then
        Return False;
    EndIf;

    MetadataPath = KOTFormExplorer_DetectFormMetadataPath(Form);
    If MetadataPath = "CommonForm.${SETTINGS_FORM_NAME}" Then
        Return False;
    EndIf;

    WindowTitle = KOTFormExplorer_DetectFormWindowTitle(Form, ExecutionParameters);
    QuickSignature = KOTFormExplorer_BuildQuickSignature(Form, ExecutionParameters, MetadataPath, WindowTitle);
    SourceContext = KOTFormExplorer_BuildSourceContext(Origin);
    SnapshotPath = KOTFormExplorer_ResolveSessionSnapshotPath(BaseSnapshotPath);
    SessionToken = KOTFormExplorer_GetSessionSnapshotToken();

    If UseQuickCheck Then
        State = KOTFormExplorer_ReadRuntimeState();
        If KOTFormExplorer_GetStringSetting(State, "snapshotPath", "") = ЗначениеВСтроку(SnapshotPath)
            And KOTFormExplorer_GetStringSetting(State, "quickSignature", "") = QuickSignature
            And KOTFormExplorer_GetStringSetting(State, "sessionToken", "") = ЗначениеВСтроку(SessionToken) Then
            Return True;
        EndIf;
    EndIf;

    CurrentElementPath = ПолучитьПутьЭлемента(ПолучитьТекущийЭлементФормы(Form));
    EffectiveIncludeTables = Not UseQuickCheck;
    If IncludeTables <> Undefined Then
        EffectiveIncludeTables = IncludeTables;
    EndIf;

    SnapshotParameters = New Structure;
    SnapshotParameters.Insert("MetadataPath", MetadataPath);
    SnapshotParameters.Insert("WindowTitle", WindowTitle);
    SnapshotParameters.Insert("Source", SourceContext);
    SnapshotParameters.Insert("IncludeTables", EffectiveIncludeTables);
    SnapshotParameters.Insert("IncludeElementTableData", EffectiveIncludeTables);
    SnapshotParameters.Insert("IncludeElementValues", Not UseQuickCheck);
    If UseQuickCheck Then
        SnapshotParameters.Insert(
            "PreferElementPathForTableData",
            CurrentElementPath
        );
        SnapshotParameters.Insert(
            "PreferElementPathForValue",
            CurrentElementPath
        );
    EndIf;

    Snapshot = СформироватьСнимокФормы(Form, SnapshotParameters);
    JSONText = ПреобразоватьВJSONСтроку(Snapshot);

    KOTFormExplorer_WriteTextFile(SnapshotPath, JSONText);
    KOTFormExplorer_SaveRuntimeState(SnapshotPath, QuickSignature, SessionToken);

    Return True;

EndFunction


Function KOTFormExplorer_DetectCurrentManagedForm(ExecutionParameters = Undefined) Export

    If ExecutionParameters <> Undefined Then
        Try
            If TypeOf(ExecutionParameters.Source) = Type("ManagedForm") Then
                Return ExecutionParameters.Source;
            EndIf;
        Except
        EndTry;

        Try
            If ExecutionParameters.Window <> Undefined
                And ExecutionParameters.Window.Content.Count() > 0 Then

                PossibleForm = ExecutionParameters.Window.Content[0];
                If TypeOf(PossibleForm) = Type("ManagedForm") Then
                    Return PossibleForm;
                EndIf;
            EndIf;
        Except
        EndTry;
    EndIf;

    Form = KOTFormExplorer_ExtractManagedFormFromWindow(ActiveWindow());
    If Form <> Undefined Then
        Return Form;
    EndIf;

    Try
        For Each ApplicationWindow In GetWindows() Do
            Form = KOTFormExplorer_ExtractManagedFormFromWindow(ApplicationWindow);
            If Form <> Undefined Then
                Return Form;
            EndIf;
        EndDo;
    Except
    EndTry;

    Return Undefined;

EndFunction


Function KOTFormExplorer_ExtractManagedFormFromWindow(ApplicationWindow)

    If ApplicationWindow = Undefined Then
        Return Undefined;
    EndIf;

    WindowContent = Undefined;
    Try
        WindowContent = ApplicationWindow.Content;
    Except
    EndTry;

    If WindowContent = Undefined Then
        Try
            WindowContent = ApplicationWindow.GetContent();
        Except
        EndTry;
    EndIf;

    If WindowContent = Undefined Then
        Return Undefined;
    EndIf;

    For Each WindowItem In WindowContent Do
        Try
            If TypeOf(WindowItem) = Type("ManagedForm") Then
                Return WindowItem;
            EndIf;
        Except
        EndTry;
    EndDo;

    Return Undefined;

EndFunction


Function KOTFormExplorer_DetectFormMetadataPath(Form) Export

    Try
        FormMetadata = Form.Metadata();
        If FormMetadata <> Undefined Then
            Try
                Return FormMetadata.FullName();
            Except
            EndTry;

            Return String(FormMetadata);
        EndIf;
    Except
    EndTry;

    Try
        Return String(Form.FormName);
    Except
    EndTry;

    Return "";

EndFunction


Function KOTFormExplorer_DetectFormWindowTitle(Form, ExecutionParameters = Undefined) Export

    Try
        If ExecutionParameters <> Undefined
            And ExecutionParameters.Window <> Undefined Then
            Try
                Return ExecutionParameters.Window.Caption;
            Except
            EndTry;
            Try
                Return ExecutionParameters.Window.Title;
            Except
            EndTry;
        EndIf;
    Except
    EndTry;

    Try
        If Form <> Undefined And Form.Window <> Undefined Then
            Try
                Return Form.Window.Caption;
            Except
            EndTry;
            Try
                Return Form.Window.Title;
            Except
            EndTry;
        EndIf;
    Except
    EndTry;

    Try
        If ActiveWindow() <> Undefined Then
            Try
                Return ActiveWindow().Caption;
            Except
            EndTry;
            Try
                Return ActiveWindow().Title;
            Except
            EndTry;
        EndIf;
    Except
    EndTry;

    Return "";

EndFunction


Function KOTFormExplorer_TryEvaluateExpression(ExpressionText, DefaultValue = "")

    Try
        Return Eval(ExpressionText);
    Except
        Return DefaultValue;
    EndTry;

EndFunction


Function KOTFormExplorer_DetectInfobaseMarker() Export

    Candidates = New Array;
    Candidates.Add(KOTFormExplorer_TryEvaluateExpression("ИнформационнаяБаза()", ""));
    Candidates.Add(KOTFormExplorer_TryEvaluateExpression("Infobase()", ""));
    Candidates.Add(KOTFormExplorer_TryEvaluateExpression("InfobaseConnectionString()", ""));

    For Each Candidate In Candidates Do
        CandidateText = TrimAll(ЗначениеВСтроку(Candidate));
        If Not IsBlankString(CandidateText) Then
            Return CandidateText;
        EndIf;
    EndDo;

    Return "";

EndFunction


Function KOTFormExplorer_BuildSourceContext(Origin = "") Export

    Source = New Structure;
    Source.Insert("adapter", "KOT Form Explorer Runtime");
    Source.Insert("origin", ЗначениеВСтроку(Origin));
    Source.Insert("infobase", KOTFormExplorer_DetectInfobaseMarker());
    Source.Insert("sessionId", KOTFormExplorer_GetSessionSnapshotToken());
    Source.Insert("configurationSourceDirectory", "${escapedConfigurationSourceDirectory}");

    Return Source;

EndFunction


Function KOTFormExplorer_TryWriteTextFile(FilePath, Text)

    TempFileName = GetTempFileName("json");
    IsSuccessful = False;

    Try
        TextDocument = New TextDocument;
        TextDocument.SetText(Text);
        TextDocument.Write(TempFileName, TextEncoding.UTF8);
        CopyFile(TempFileName, FilePath);
        IsSuccessful = True;
    Except
    EndTry;

    Try
        DeleteFiles(TempFileName);
    Except
    EndTry;

    Return IsSuccessful;

EndFunction


Function KOTFormExplorer_GetConfigurationExtensionsCollection()

    Try
        Return Eval("ConfigurationExtensions.Get()");
    Except
    EndTry;

    Try
        Return Eval("РасширенияКонфигурации.Получить()");
    Except
    EndTry;

    Return Undefined;

EndFunction


Function KOTFormExplorer_TryDisableOwnSafeMode()

    Extensions = KOTFormExplorer_GetConfigurationExtensionsCollection();
    If Extensions = Undefined Then
        Return False;
    EndIf;

    For Each ExtensionItem In Extensions Do
        ExtensionName = "";
        Try
            ExtensionName = Lower(TrimAll(ЗначениеВСтроку(ExtensionItem.Name)));
        Except
        EndTry;

        If ExtensionName <> Lower("${GENERATED_EXTENSION_NAME}") Then
            Continue;
        EndIf;

        HasChanges = False;

        Try
            If ExtensionItem.SafeMode Then
                ExtensionItem.SafeMode = False;
                HasChanges = True;
            EndIf;
        Except
        EndTry;

        Try
            If ExtensionItem.UnsafeActionProtection Then
                ExtensionItem.UnsafeActionProtection = False;
                HasChanges = True;
            EndIf;
        Except
        EndTry;

        If HasChanges Then
            Try
                ExtensionItem.Write();
            Except
                Return False;
            EndTry;
        EndIf;

        Return True;
    EndDo;

    Return False;

EndFunction


Procedure KOTFormExplorer_WriteTextFile(FilePath, Text)

    If IsBlankString(TrimAll(FilePath)) Then
        Return;
    EndIf;

    Try
        If KOTFormExplorer_TryWriteTextFile(FilePath, Text) Then
            Return;
        EndIf;
    Except
        Return;
    EndTry;

    Try
        If KOTFormExplorer_TryDisableOwnSafeMode() Then
            KOTFormExplorer_TryWriteTextFile(FilePath, Text);
        EndIf;
    Except
    EndTry;

EndProcedure
`;
}

function injectModuleContent(source: string, headerText: string, supportText: string, openTag: string, closeTag: string): string {
    const withHeader = headerText.trim().length > 0
        ? source.replace(openTag, `${openTag}\n\n${headerText}`)
        : source;
    return withHeader.replace(new RegExp(`\\n${escapeRegExp(closeTag)}\\s*$`), `${supportText}\n${closeTag}`);
}

function isEnglishScriptVariant(scriptVariant: string): boolean {
    return (scriptVariant || '').trim().toLowerCase() === 'english';
}

function getLocalizedText(
    configuration: BaseConfigurationInfo,
    russianText: string,
    englishText: string
): string {
    return isEnglishScriptVariant(configuration.scriptVariant) ? englishText : russianText;
}

function getHotkeyPresetOptions(configuration: BaseConfigurationInfo): Array<{ key: string; title: string }> {
    return [
        {
            key: HOTKEY_PRESET_NONE_KEY,
            title: getLocalizedText(configuration, 'Отключено', 'Disabled')
        },
        ...HOTKEY_PRESETS.map(preset => ({
            key: preset.key,
            title: preset.shortcut
        }))
    ];
}

function buildCommandModuleTextRussian(snapshotPath: string, configurationSourceDirectory: string): string {
    const escapedSnapshotPath = escapeBslStringLiteral(snapshotPath);
    const escapedConfigurationSourceDirectory = escapeBslStringLiteral(configurationSourceDirectory);

    return `&НаКлиенте
Процедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)

    Форма = ОпределитьТекущуюУправляемуюФорму(ПараметрыВыполненияКоманды);
    Если Форма = Неопределено Тогда
        Сообщить("KOT Form Explorer: не удалось определить текущую управляемую форму.");
        Возврат;
    КонецЕсли;

    ПараметрыСнимка = Новый Структура;
    ПараметрыСнимка.Вставить("MetadataPath", ОпределитьПутьМетаданныхФормы(Форма));
    ПараметрыСнимка.Вставить("WindowTitle", ОпределитьЗаголовокОкнаФормы(Форма, ПараметрыВыполненияКоманды));
    ПараметрыСнимка.Вставить("Source", СформироватьКонтекстИсточника());

    KOTFormExplorerAdapterClient.ЗаписатьСнимокФормыВФайл(
        Форма,
        "${escapedSnapshotPath}",
        ПараметрыСнимка);

КонецПроцедуры


&НаКлиенте
Функция ОпределитьТекущуюУправляемуюФорму(ПараметрыВыполненияКоманды)

    Если ПараметрыВыполненияКоманды = Неопределено Тогда
        Возврат Неопределено;
    КонецЕсли;

    Попытка
        Если ТипЗнч(ПараметрыВыполненияКоманды.Источник) = Тип("УправляемаяФорма") Тогда
            Возврат ПараметрыВыполненияКоманды.Источник;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Попытка
        Если ПараметрыВыполненияКоманды.Окно <> Неопределено
            И ПараметрыВыполненияКоманды.Окно.Содержимое.Количество() > 0 Тогда

            ВозможнаяФорма = ПараметрыВыполненияКоманды.Окно.Содержимое[0];
            Если ТипЗнч(ВозможнаяФорма) = Тип("УправляемаяФорма") Тогда
                Возврат ВозможнаяФорма;
            КонецЕсли;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Форма = ИзвлечьУправляемуюФормуИзОкна(АктивноеОкно());
    Если Форма <> Неопределено Тогда
        Возврат Форма;
    КонецЕсли;

    Попытка
        Для Каждого ОкноПриложения Из ПолучитьОкна() Цикл
            Форма = ИзвлечьУправляемуюФормуИзОкна(ОкноПриложения);
            Если Форма <> Неопределено Тогда
                Возврат Форма;
            КонецЕсли;
        КонецЦикла;
    Исключение
    КонецПопытки;

    Возврат Неопределено;

КонецФункции


&НаКлиенте
Функция ИзвлечьУправляемуюФормуИзОкна(ОкноПриложения)

    Если ОкноПриложения = Неопределено Тогда
        Возврат Неопределено;
    КонецЕсли;

    СодержимоеОкна = Неопределено;
    Попытка
        СодержимоеОкна = ОкноПриложения.Содержимое;
    Исключение
    КонецПопытки;

    Если СодержимоеОкна = Неопределено Тогда
        Попытка
            СодержимоеОкна = ОкноПриложения.ПолучитьСодержимое();
        Исключение
        КонецПопытки;
    КонецЕсли;

    Если СодержимоеОкна = Неопределено Тогда
        Возврат Неопределено;
    КонецЕсли;

    Для Каждого ЭлементОкна Из СодержимоеОкна Цикл
        Попытка
            Если ТипЗнч(ЭлементОкна) = Тип("УправляемаяФорма") Тогда
                Возврат ЭлементОкна;
            КонецЕсли;
        Исключение
        КонецПопытки;
    КонецЦикла;

    Возврат Неопределено;

КонецФункции


&НаКлиенте
Функция ОпределитьПутьМетаданныхФормы(Форма)

    Попытка
        МетаданныеФормы = Форма.Метаданные();
        Если МетаданныеФормы <> Неопределено Тогда
            Попытка
                Возврат МетаданныеФормы.ПолноеИмя();
            Исключение
            КонецПопытки;

            Возврат Строка(МетаданныеФормы);
        КонецЕсли;
    Исключение
    КонецПопытки;

    Попытка
        Возврат Строка(Форма.ИмяФормы);
    Исключение
    КонецПопытки;

    Возврат "";

КонецФункции


&НаКлиенте
Функция ОпределитьЗаголовокОкнаФормы(Форма, ПараметрыВыполненияКоманды)

    Попытка
        Если ПараметрыВыполненияКоманды <> Неопределено
            И ПараметрыВыполненияКоманды.Окно <> Неопределено Тогда
            Попытка
                Возврат ПараметрыВыполненияКоманды.Окно.Заголовок;
            Исключение
            КонецПопытки;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Попытка
        Если Форма <> Неопределено И Форма.Окно <> Неопределено Тогда
            Попытка
                Возврат Форма.Окно.Заголовок;
            Исключение
            КонецПопытки;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Попытка
        Если АктивноеОкно() <> Неопределено Тогда
            Попытка
                Возврат АктивноеОкно().Заголовок;
            Исключение
            КонецПопытки;
        КонецЕсли;
    Исключение
    КонецПопытки;

    Возврат "";

КонецФункции


&НаКлиенте
Функция СформироватьКонтекстИсточника()

    Источник = Новый Структура;
    Источник.Вставить("adapter", "KOT Form Explorer Runtime");
    Источник.Вставить("origin", "CommonCommand.${REFRESH_COMMAND_NAME}");
    Источник.Вставить("configurationSourceDirectory", "${escapedConfigurationSourceDirectory}");

    Возврат Источник;

КонецФункции
`;
}

function buildCommandModuleTextEnglish(snapshotPath: string, configurationSourceDirectory: string): string {
    const escapedSnapshotPath = escapeBslStringLiteral(snapshotPath);
    const escapedConfigurationSourceDirectory = escapeBslStringLiteral(configurationSourceDirectory);

    return `&AtClient
Procedure CommandProcessing(CommandParameter, ExecutionParameters)

    Form = DetectCurrentManagedForm(ExecutionParameters);
    If Form = Undefined Then
        Return;
    EndIf;

    SnapshotParameters = New Structure;
    SnapshotParameters.Insert("MetadataPath", DetectFormMetadataPath(Form));
    SnapshotParameters.Insert("WindowTitle", DetectFormWindowTitle(Form, ExecutionParameters));
    SnapshotParameters.Insert("Source", BuildSourceContext());

    KOTFormExplorerAdapterClient.ЗаписатьСнимокФормыВФайл(
        Form,
        "${escapedSnapshotPath}",
        SnapshotParameters);

EndProcedure


&AtClient
Function DetectCurrentManagedForm(ExecutionParameters)

    If ExecutionParameters = Undefined Then
        Return Undefined;
    EndIf;

    Try
        If TypeOf(ExecutionParameters.Source) = Type("ManagedForm") Then
            Return ExecutionParameters.Source;
        EndIf;
    Except
    EndTry;

    Try
        If ExecutionParameters.Window <> Undefined
            And ExecutionParameters.Window.Content.Count() > 0 Then

            PossibleForm = ExecutionParameters.Window.Content[0];
            If TypeOf(PossibleForm) = Type("ManagedForm") Then
                Return PossibleForm;
            EndIf;
        EndIf;
    Except
    EndTry;

    Form = ExtractManagedFormFromWindow(ActiveWindow());
    If Form <> Undefined Then
        Return Form;
    EndIf;

    Try
        For Each ApplicationWindow In GetWindows() Do
            Form = ExtractManagedFormFromWindow(ApplicationWindow);
            If Form <> Undefined Then
                Return Form;
            EndIf;
        EndDo;
    Except
    EndTry;

    Return Undefined;

EndFunction


&AtClient
Function ExtractManagedFormFromWindow(ApplicationWindow)

    If ApplicationWindow = Undefined Then
        Return Undefined;
    EndIf;

    WindowContent = Undefined;
    Try
        WindowContent = ApplicationWindow.Content;
    Except
    EndTry;

    If WindowContent = Undefined Then
        Try
            WindowContent = ApplicationWindow.GetContent();
        Except
        EndTry;
    EndIf;

    If WindowContent = Undefined Then
        Return Undefined;
    EndIf;

    For Each WindowItem In WindowContent Do
        Try
            If TypeOf(WindowItem) = Type("ManagedForm") Then
                Return WindowItem;
            EndIf;
        Except
        EndTry;
    EndDo;

    Return Undefined;

EndFunction


&AtClient
Function DetectFormMetadataPath(Form)

    Try
        FormMetadata = Form.Metadata();
        If FormMetadata <> Undefined Then
            Try
                Return FormMetadata.FullName();
            Except
            EndTry;

            Return String(FormMetadata);
        EndIf;
    Except
    EndTry;

    Try
        Return String(Form.FormName);
    Except
    EndTry;

    Return "";

EndFunction


&AtClient
Function DetectFormWindowTitle(Form, ExecutionParameters)

    Try
        If ExecutionParameters <> Undefined
            And ExecutionParameters.Window <> Undefined Then
            Try
                Return ExecutionParameters.Window.Caption;
            Except
            EndTry;
            Try
                Return ExecutionParameters.Window.Title;
            Except
            EndTry;
        EndIf;
    Except
    EndTry;

    Try
        If Form <> Undefined And Form.Window <> Undefined Then
            Try
                Return Form.Window.Caption;
            Except
            EndTry;
            Try
                Return Form.Window.Title;
            Except
            EndTry;
        EndIf;
    Except
    EndTry;

    Try
        If ActiveWindow() <> Undefined Then
            Try
                Return ActiveWindow().Caption;
            Except
            EndTry;
            Try
                Return ActiveWindow().Title;
            Except
            EndTry;
        EndIf;
    Except
    EndTry;

    Return "";

EndFunction


&AtClient
Function BuildSourceContext()

    Source = New Structure;
    Source.Insert("adapter", "KOT Form Explorer Runtime");
    Source.Insert("origin", "CommonCommand.${REFRESH_COMMAND_NAME}");
    Source.Insert("configurationSourceDirectory", "${escapedConfigurationSourceDirectory}");

    Return Source;

EndFunction
`;
}

function buildCommandModuleText(
    snapshotPath: string,
    configurationSourceDirectory: string,
    configuration: BaseConfigurationInfo
): string {
    if (isEnglishScriptVariant(configuration.scriptVariant)) {
        return buildCommandModuleTextEnglish(snapshotPath, configurationSourceDirectory);
    }

    return buildCommandModuleTextRussian(snapshotPath, configurationSourceDirectory);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceBslWholeWord(source: string, from: string, to: string): string {
    return source.replace(
        new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(from)}(?![\\p{L}\\p{N}_])`, 'gu'),
        to
    );
}

function translateRussianBslToEnglish(source: string): string {
    const exactReplacements: Array<[string, string]> = [
        ['#Если Клиент Тогда', '#If Client Then'],
        ['#КонецЕсли', '#EndIf'],
        ['&НаКлиенте', '&AtClient'],
        ['"УправляемаяФорма"', '"ManagedForm"'],
        ['"Булево"', '"Boolean"'],
        ['"Строка"', '"String"'],
        ['"Заголовок"', '"Title"'],
        ['"ИмяФормы"', '"FormName"'],
        ['"Имя"', '"Name"'],
        ['"ТекущийЭлемент"', '"CurrentItem"'],
        ['"Элементы"', '"Items"'],
        ['"Родитель"', '"Parent"'],
        ['"Подсказка"', '"ToolTip"'],
        ['"ПодсказкаВвода"', '"InputHint"'],
        ['"Вид"', '"View"'],
        ['"Видимость"', '"Visible"'],
        ['"Доступность"', '"Available"'],
        ['"ТолькоПросмотр"', '"ReadOnly"'],
        ['"Команды"', '"Commands"'],
        ['"ПутьКДанным"', '"DataPath"'],
        ['"Данные"', '"Data"'],
        ['"ТекущиеДанные"', '"CurrentData"'],
        ['"Тип"', '"Type"'],
        ['"ЦелевойОбъект.ПолучитьРеквизиты()"', '"ЦелевойОбъект.GetAttributes()"'],
        ['КодировкаТекста.UTF8', 'TextEncoding.UTF8']
    ];

    const wholeWordReplacements: Array<[string, string]> = [
        ['ИначеЕсли', 'ElsIf'],
        ['КонецПроцедуры', 'EndProcedure'],
        ['КонецФункции', 'EndFunction'],
        ['КонецПопытки', 'EndTry'],
        ['КонецЦикла', 'EndDo'],
        ['КонецЕсли', 'EndIf'],
        ['Процедура', 'Procedure'],
        ['Функция', 'Function'],
        ['Экспорт', 'Export'],
        ['Попытка', 'Try'],
        ['Исключение', 'Except'],
        ['Возврат', 'Return'],
        ['Тогда', 'Then'],
        ['Иначе', 'Else'],
        ['Если', 'If'],
        ['Для', 'For'],
        ['Каждого', 'Each'],
        ['Из', 'In'],
        ['Цикл', 'Do'],
        ['Неопределено', 'Undefined'],
        ['Истина', 'True'],
        ['Ложь', 'False'],
        ['Новый', 'New'],
        ['Не', 'Not'],
        ['Или', 'Or'],
        ['И', 'And'],
        ['ТипЗнч', 'TypeOf'],
        ['Тип', 'Type'],
        ['Строка', 'String'],
        ['ТекущаяДата', 'CurrentDate'],
        ['Формат', 'Format'],
        ['Заголовок', 'Title'],
        ['ИмяФормы', 'FormName'],
        ['Имя', 'Name'],
        ['ТекущийЭлемент', 'CurrentItem'],
        ['Элементы', 'Items'],
        ['Родитель', 'Parent'],
        ['Подсказка', 'ToolTip'],
        ['ПодсказкаВвода', 'InputHint'],
        ['Вид', 'View'],
        ['Видимость', 'Visible'],
        ['Доступность', 'Available'],
        ['ТолькоПросмотр', 'ReadOnly'],
        ['Команды', 'Commands'],
        ['ПутьКДанным', 'DataPath'],
        ['Данные', 'Data'],
        ['ТекущиеДанные', 'CurrentData'],
        ['ПолучитьРеквизиты', 'GetAttributes'],
        ['СокрЛП', 'TrimAll'],
        ['СтрРазделить', 'StrSplit'],
        ['АктивноеОкно', 'ActiveWindow'],
        ['ПолучитьОкна', 'GetWindows'],
        ['ПолучитьСодержимое', 'GetContent'],
        ['Содержимое', 'Content'],
        ['ПолучитьИмяВременногоФайла', 'GetTempFileName'],
        ['КопироватьФайл', 'CopyFile'],
        ['УдалитьФайлы', 'DeleteFiles'],
        ['Вычислить', 'Eval'],
        ['ЗаписатьJSON', 'WriteJSON'],
        ['Структура', 'Structure'],
        ['Массив', 'Array'],
        ['Соответствие', 'Map'],
        ['ТекстовыйДокумент', 'TextDocument'],
        ['ЗаписьJSON', 'JSONWriter'],
        ['Свойство', 'Property'],
        ['Вставить', 'Insert'],
        ['Добавить', 'Add'],
        ['Получить', 'Get'],
        ['Количество', 'Count'],
        ['УстановитьТекст', 'SetText'],
        ['Записать', 'Write'],
        ['УстановитьСтроку', 'SetString'],
        ['Закрыть', 'Close']
    ];

    let result = source;
    for (const [from, to] of exactReplacements) {
        result = result.split(from).join(to);
    }

    result = result.split('Для Каждого').join('For Each');

    for (const [from, to] of wholeWordReplacements) {
        result = replaceBslWholeWord(result, from, to);
    }

    return result;
}

function buildAdapterModuleText(
    configuration: BaseConfigurationInfo,
    russianSource: string
): string {
    if (isEnglishScriptVariant(configuration.scriptVariant)) {
        return translateRussianBslToEnglish(russianSource);
    }

    return russianSource;
}

function buildReadmeText(project: GeneratedExtensionProject, scanResult: FormExplorerScanResult): string {
    return `# KOT Form Explorer Runtime

Generated at: ${new Date().toISOString()}

Base configuration:
- Name: ${scanResult.configuration.name}
- Version: ${scanResult.configuration.version || 'n/a'}
- Script variant: ${scanResult.configuration.scriptVariant || DEFAULT_SCRIPT_VARIANT}
- Selected language: ${scanResult.configuration.selectedLanguage.name} (${scanResult.configuration.selectedLanguage.code || 'n/a'})
- Managed forms indexed: ${scanResult.forms.length}

Artifacts:
- Extension source tree: ${project.extensionSourceDirectory}
- Managed forms index: ${project.formsIndexPath}
- Build manifest: ${project.buildManifestPath}
- Builder infobase: ${project.builderInfobaseDirectory}
- Builder cache state: ${project.builderCacheStatePath}
- Adapter settings file: ${project.settingsFilePath}
- Adapter mode state file: ${project.modeFilePath}
- Adapter mode request file: ${project.modeRequestFilePath}
- Cached .cfe path: ${project.cachedCfePath}
- CFE build state: ${project.cfeBuildStatePath}
- Expected .cfe output: ${project.cfeOutputPath}

Windows built-in build:

- If \`kotTestToolkit.formExplorer.extensionBuildCommandTemplate\` is empty and
  \`kotTestToolkit.paths.oneCEnterpriseExe\` points to \`1cv8c.exe\`, KOT derives the sibling
  designer executable and builds the \`.cfe\` automatically using a cached file infobase inside
  the generated artifacts directory.
- The generated runtime extension is lightweight: it does not adopt application forms.
- Runtime refresh is exposed through the \`KOT Form Explorer\` subsystem and uses best-effort
  active-window detection.
- Built-in \`.cfe\` exports are cached by a fingerprint of the effective Form Explorer build inputs.
- Adapter settings are stored locally next to generated artifacts and can enable auto snapshot
  with a configurable interval and predefined shortcut presets.
- Runtime mode (\`manual\` / \`auto\`) is mirrored to a dedicated mode file so the VS Code panel can
  show the live adapter mode without parsing 1C data.
- Target install mode can either load the generated extension directly into a matching infobase,
  build/install through a cached \`.cfe\`, or first export the selected infobase configuration and
  then build the extension from that exact export.
- Auto snapshot is optimized to avoid rebuilding the full JSON when form focus and the active
  element value have not changed since the last timer tick.

Optional external build template example:

\`\`\`text
oscript ./tools/form-explorer/build-cfe.os --onec \${oneCExePathQuoted} --base-config-dir \${configurationSourceDirQuoted} --extension-src \${extensionSourceDirQuoted} --out \${cfePathQuoted} --work-dir \${generatedArtifactsDirQuoted}
\`\`\`

Configure \`kotTestToolkit.formExplorer.extensionBuildCommandTemplate\` only if you want to override
the built-in builder with your own toolchain.
`;
}

interface GeneratedAdapterSettingsFile {
    snapshotPath: string;
    hotkeyPreset: string;
    autoSnapshotEnabled: boolean;
    autoSnapshotIntervalSeconds: number;
}

function normalizeGeneratedAdapterSettings(
    rawValue: unknown,
    snapshotPath: string
): GeneratedAdapterSettingsFile {
    const source = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
        ? rawValue as Record<string, unknown>
        : {};
    const hotkeyPreset = typeof source.hotkeyPreset === 'string'
        && (source.hotkeyPreset === HOTKEY_PRESET_NONE_KEY || HOTKEY_PRESETS.some(preset => preset.key === source.hotkeyPreset))
        ? source.hotkeyPreset
        : DEFAULT_HOTKEY_PRESET_KEY;
    const interval = typeof source.autoSnapshotIntervalSeconds === 'number'
        && Number.isFinite(source.autoSnapshotIntervalSeconds)
        && source.autoSnapshotIntervalSeconds >= 1
        ? Math.floor(source.autoSnapshotIntervalSeconds)
        : DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS;

    return {
        snapshotPath: typeof source.snapshotPath === 'string' && source.snapshotPath.trim()
            ? source.snapshotPath.trim()
            : snapshotPath,
        hotkeyPreset,
        autoSnapshotEnabled: typeof source.autoSnapshotEnabled === 'boolean'
            ? source.autoSnapshotEnabled
            : false,
        autoSnapshotIntervalSeconds: interval
    };
}

async function initializeAdapterRuntimeFiles(
    settingsFilePath: string,
    modeFilePath: string,
    modeRequestFilePath: string,
    snapshotPath: string
): Promise<void> {
    let rawSettings: unknown = undefined;
    if (await pathExists(settingsFilePath)) {
        try {
            rawSettings = JSON.parse(await readUtf8File(settingsFilePath));
        } catch {
            rawSettings = undefined;
        }
    }

    const normalizedSettings = normalizeGeneratedAdapterSettings(rawSettings, snapshotPath);
    await writeTextFile(settingsFilePath, `${JSON.stringify(normalizedSettings, null, 2)}\n`);
    await writeTextFile(modeFilePath, `${normalizedSettings.autoSnapshotEnabled ? 'auto' : 'manual'}\n`);
    await writeTextFile(modeRequestFilePath, '');
    await writeTextFile(path.join(path.dirname(settingsFilePath), DEFAULT_REQUEST_CONTEXT_FILE_NAME), '{}\n');
}

async function generateManagedFormArtifacts(
    scanResult: FormExplorerScanResult,
    extensionSourceDirectory: string
): Promise<GeneratedManagedFormArtifacts> {
    const files: GeneratedExtensionSourceFile[] = [];
    const configurationChildObjects = new Set<string>();
    const parentObjectForms = new Map<string, {
        rootDirectoryName: string;
        objectType: string;
        objectName: string;
        sourceObjectXmlPath: string;
        formNames: Set<string>;
    }>();

    let patchedExistingCommandBarsCount = 0;
    let createdCommandBarsCount = 0;

    for (const form of scanResult.forms) {
        const adoptedFormMetadataXml = buildAdoptedFormMetadataXml(await readUtf8File(form.sourceXmlPath));
        const patchedLayoutResult = injectRefreshButtonIntoFormLayout(await readUtf8File(form.sourceLayoutXmlPath));
        if (patchedLayoutResult.usedExistingCommandBar) {
            patchedExistingCommandBarsCount += 1;
        } else {
            createdCommandBarsCount += 1;
        }

        const formMetadataRelativePath = form.rootDirectoryName === 'CommonForms'
            ? path.join('CommonForms', `${form.formName}.xml`)
            : path.join(form.rootDirectoryName, form.objectName, 'Forms', `${form.formName}.xml`);
        const formLayoutRelativePath = form.rootDirectoryName === 'CommonForms'
            ? path.join('CommonForms', form.formName, 'Ext', 'Form.xml')
            : path.join(form.rootDirectoryName, form.objectName, 'Forms', form.formName, 'Ext', 'Form.xml');

        files.push({
            relativePath: formMetadataRelativePath,
            content: adoptedFormMetadataXml,
            metadataEntry: {
                metadataName: form.metadataPath,
                id: randomUuid(),
                content: adoptedFormMetadataXml
            }
        });
        files.push({
            relativePath: formLayoutRelativePath,
            content: patchedLayoutResult.content,
            metadataEntry: {
                metadataName: `${form.metadataPath}.Form`,
                id: randomUuid(),
                content: patchedLayoutResult.content
            }
        });

        if (form.rootDirectoryName === 'CommonForms') {
            configurationChildObjects.add(`<CommonForm>${escapeXml(form.formName)}</CommonForm>`);
            continue;
        }

        if (!form.sourceObjectXmlPath) {
            throw new Error(`Missing source object XML path for ${form.metadataPath}.`);
        }

        const parentKey = `${form.objectType}:${form.objectName}`;
        const currentGroup = parentObjectForms.get(parentKey) || {
            rootDirectoryName: form.rootDirectoryName,
            objectType: form.objectType,
            objectName: form.objectName,
            sourceObjectXmlPath: form.sourceObjectXmlPath,
            formNames: new Set<string>()
        };
        currentGroup.formNames.add(form.formName);
        parentObjectForms.set(parentKey, currentGroup);
    }

    for (const group of parentObjectForms.values()) {
        const adoptedParentXml = buildAdoptedParentObjectXml(
            await readUtf8File(group.sourceObjectXmlPath),
            group.formNames
        );
        files.push({
            relativePath: path.join(group.rootDirectoryName, `${group.objectName}.xml`),
            content: adoptedParentXml,
            metadataEntry: {
                metadataName: `${group.objectType}.${group.objectName}`,
                id: randomUuid(),
                content: adoptedParentXml
            }
        });
        configurationChildObjects.add(`<${group.objectType}>${escapeXml(group.objectName)}</${group.objectType}>`);
    }

    return {
        files,
        configurationChildObjects: [...configurationChildObjects].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
        adoptedFormsCount: scanResult.forms.length,
        adoptedParentObjectsCount: parentObjectForms.size,
        patchedExistingCommandBarsCount,
        createdCommandBarsCount
    };
}

function buildConfigDumpInfoXml(
    xmlVersion: string,
    metadataEntries: GeneratedMetadataVersionEntry[]
): string {
    const lines: string[] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" format="Hierarchical" version="${escapeXml(xmlVersion)}">`,
        '\t<ConfigVersions>',
        ...metadataEntries.map(entry => `\t\t<Metadata name="${escapeXml(entry.metadataName)}" id="${entry.id}" configVersion="${hashText(entry.content)}"/>`),
        '\t</ConfigVersions>',
        '</ConfigDumpInfo>',
        ''
    ];
    return lines.join('\n');
}

async function generateExtensionProjectFiles(
    context: vscode.ExtensionContext,
    scanResult: FormExplorerScanResult,
    configurationSourceDirectory: string,
    generatedArtifactsDirectory: string,
    snapshotPath: string,
    cfeOutputPath: string
): Promise<GeneratedExtensionProject> {
    const extensionSourceDirectory = path.join(generatedArtifactsDirectory, 'extension-src');
    const formsIndexPath = path.join(generatedArtifactsDirectory, 'forms-index.json');
    const buildManifestPath = path.join(generatedArtifactsDirectory, 'build-manifest.json');
    const builderInfobaseDirectory = path.join(generatedArtifactsDirectory, BUILDER_INFOBASE_DIRECTORY_NAME);
    const builderCacheStatePath = path.join(generatedArtifactsDirectory, 'builder-base-state.json');
    const cachedCfePath = path.join(generatedArtifactsDirectory, DEFAULT_CFE_CACHE_FILE_NAME);
    const cfeBuildStatePath = path.join(generatedArtifactsDirectory, DEFAULT_CFE_BUILD_STATE_FILE_NAME);
    const settingsFilePath = path.join(generatedArtifactsDirectory, DEFAULT_SETTINGS_FILE_NAME);
    const modeFilePath = path.join(generatedArtifactsDirectory, DEFAULT_MODE_STATE_FILE_NAME);
    const modeRequestFilePath = path.join(generatedArtifactsDirectory, DEFAULT_MODE_REQUEST_FILE_NAME);
    const requestContextFilePath = path.join(generatedArtifactsDirectory, DEFAULT_REQUEST_CONTEXT_FILE_NAME);

    await recreateDirectory(extensionSourceDirectory);

    const ids: GeneratedObjectIds = {
        configuration: randomUuid(),
        configurationInternalInfoObjectIds: (
            scanResult.configuration.internalInfoClassIds.length > 0
                ? scanResult.configuration.internalInfoClassIds
                : DEFAULT_EXTENSION_CONFIGURATION_INTERNAL_INFO_CLASS_IDS
        ).map(() => randomUuid()),
        language: randomUuid(),
        subsystem: randomUuid(),
        adapterModule: randomUuid(),
        refreshCommand: randomUuid(),
        settingsCommand: randomUuid(),
        toggleModeCommand: randomUuid(),
        settingsForm: randomUuid(),
        hotkeyCommandIds: Object.fromEntries(
            HOTKEY_PRESETS.map(preset => [preset.key, randomUuid()])
        )
    };

    const adapterBslPath = path.join(context.extensionUri.fsPath, 'res', 'formExplorer', 'adapter', 'KOTFormExplorerAdapterClient.bsl');
    const adapterStateHeader = isEnglishScriptVariant(scanResult.configuration.scriptVariant)
        ? buildAdapterStateHeaderTextEnglish()
        : buildAdapterStateHeaderTextRussian();
    const adapterSupportText = isEnglishScriptVariant(scanResult.configuration.scriptVariant)
        ? buildAdapterSupportTextEnglish(snapshotPath, settingsFilePath, configurationSourceDirectory)
        : buildAdapterSupportTextRussian(snapshotPath, settingsFilePath, configurationSourceDirectory);
    const adapterCommonModuleBsl = buildAdapterModuleText(
        scanResult.configuration,
        injectModuleContent(
            await readUtf8File(adapterBslPath),
            adapterStateHeader,
            adapterSupportText,
            '#Если Клиент Тогда',
            '#КонецЕсли'
        )
    );
    const languageXml = buildLanguageXml(
        scanResult.configuration.xmlVersion,
        ids.language,
        scanResult.configuration.selectedLanguage
    );
    const adapterCommonModuleXml = buildAdapterCommonModuleXml(
        scanResult.configuration.xmlVersion,
        ids.adapterModule,
        scanResult.configuration.selectedLanguage
    );
    const subsystemXml = buildSubsystemXml(
        scanResult.configuration.xmlVersion,
        ids.subsystem,
        scanResult.configuration
    );
    const subsystemCommandInterfaceXml = buildSubsystemCommandInterfaceXml(scanResult.configuration.xmlVersion);
    const refreshCommandXml = buildRefreshCommandXml(
        scanResult.configuration.xmlVersion,
        ids.refreshCommand,
        scanResult.configuration
    );
    const settingsCommandXml = buildSettingsCommandXml(
        scanResult.configuration.xmlVersion,
        ids.settingsCommand,
        scanResult.configuration
    );
    const toggleModeCommandXml = buildToggleModeCommandXml(
        scanResult.configuration.xmlVersion,
        ids.toggleModeCommand,
        scanResult.configuration
    );
    const settingsFormXml = buildSettingsFormMetadataXml(
        scanResult.configuration.xmlVersion,
        ids.settingsForm,
        scanResult.configuration
    );
    const settingsFormLayoutXml = buildSettingsFormLayoutXml(
        scanResult.configuration.xmlVersion,
        scanResult.configuration
    );
    const managedApplicationModuleBsl = buildManagedApplicationModuleText(
        scanResult.configuration
    );
    const refreshCommandBsl = buildVisibleRefreshCommandModuleText(
        scanResult.configuration
    );
    const settingsCommandBsl = buildSettingsCommandModuleText(
        scanResult.configuration
    );
    const toggleModeCommandBsl = buildToggleModeCommandModuleText(
        scanResult.configuration
    );
    const settingsFormModuleBsl = buildSettingsFormModuleText(
        scanResult.configuration
    );
    const configurationXml = buildExtensionConfigurationXml(
        scanResult.configuration,
        scanResult.configuration.xmlVersion,
        ids,
        []
    );
    const metadataEntries: GeneratedMetadataVersionEntry[] = [
        {
            metadataName: `Configuration.${GENERATED_EXTENSION_NAME}`,
            id: ids.configuration,
            content: configurationXml
        },
        {
            metadataName: `Configuration.${GENERATED_EXTENSION_NAME}.ManagedApplicationModule`,
            id: `${ids.configurationInternalInfoObjectIds[0]}.6`,
            content: managedApplicationModuleBsl
        },
        {
            metadataName: `Language.${scanResult.configuration.selectedLanguage.name}`,
            id: ids.language,
            content: languageXml
        },
        {
            metadataName: `Subsystem.${GENERATED_SUBSYSTEM_NAME}`,
            id: ids.subsystem,
            content: subsystemXml
        },
        {
            metadataName: `Subsystem.${GENERATED_SUBSYSTEM_NAME}.CommandInterface`,
            id: `${ids.subsystem}.0`,
            content: subsystemCommandInterfaceXml
        },
        {
            metadataName: `CommonModule.${ADAPTER_MODULE_NAME}`,
            id: ids.adapterModule,
            content: adapterCommonModuleXml
        },
        {
            metadataName: `CommonModule.${ADAPTER_MODULE_NAME}.Module`,
            id: `${ids.adapterModule}.0`,
            content: adapterCommonModuleBsl
        },
        {
            metadataName: `CommonCommand.${REFRESH_COMMAND_NAME}`,
            id: ids.refreshCommand,
            content: refreshCommandXml
        },
        {
            metadataName: `CommonCommand.${REFRESH_COMMAND_NAME}.CommandModule`,
            id: `${ids.refreshCommand}.2`,
            content: refreshCommandBsl
        },
        {
            metadataName: `CommonCommand.${SETTINGS_COMMAND_NAME}`,
            id: ids.settingsCommand,
            content: settingsCommandXml
        },
        {
            metadataName: `CommonCommand.${SETTINGS_COMMAND_NAME}.CommandModule`,
            id: `${ids.settingsCommand}.2`,
            content: settingsCommandBsl
        },
        {
            metadataName: `CommonCommand.${TOGGLE_MODE_COMMAND_NAME}`,
            id: ids.toggleModeCommand,
            content: toggleModeCommandXml
        },
        {
            metadataName: `CommonCommand.${TOGGLE_MODE_COMMAND_NAME}.CommandModule`,
            id: `${ids.toggleModeCommand}.2`,
            content: toggleModeCommandBsl
        },
        {
            metadataName: `CommonForm.${SETTINGS_FORM_NAME}`,
            id: ids.settingsForm,
            content: settingsFormXml
        },
        {
            metadataName: `CommonForm.${SETTINGS_FORM_NAME}.Form`,
            id: `${ids.settingsForm}.0`,
            content: settingsFormLayoutXml
        },
        {
            metadataName: `CommonForm.${SETTINGS_FORM_NAME}.Module`,
            id: `${ids.settingsForm}.1`,
            content: settingsFormModuleBsl
        }
    ];
    for (const preset of HOTKEY_PRESETS) {
        const commandId = ids.hotkeyCommandIds[preset.key];
        const commandXml = buildHiddenHotkeyCommandXml(
            scanResult.configuration.xmlVersion,
            commandId,
            scanResult.configuration,
            preset
        );
        const commandBsl = buildHiddenHotkeyCommandModuleText(
            scanResult.configuration,
            preset
        );
        metadataEntries.push(
            {
                metadataName: `CommonCommand.${preset.commandName}`,
                id: commandId,
                content: commandXml
            },
            {
                metadataName: `CommonCommand.${preset.commandName}.CommandModule`,
                id: `${commandId}.2`,
                content: commandBsl
            }
        );
    }

    await writeTextFile(path.join(extensionSourceDirectory, 'Configuration.xml'), configurationXml);
    await writeTextFile(
        path.join(extensionSourceDirectory, 'Ext', 'ManagedApplicationModule.bsl'),
        managedApplicationModuleBsl
    );
    await writeTextFile(
        path.join(extensionSourceDirectory, 'Languages', `${scanResult.configuration.selectedLanguage.name}.xml`),
        languageXml
    );
    await writeTextFile(path.join(extensionSourceDirectory, 'Subsystems', `${GENERATED_SUBSYSTEM_NAME}.xml`), subsystemXml);
    await writeTextFile(
        path.join(extensionSourceDirectory, 'Subsystems', GENERATED_SUBSYSTEM_NAME, 'Ext', 'CommandInterface.xml'),
        subsystemCommandInterfaceXml
    );
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonModules', `${ADAPTER_MODULE_NAME}.xml`), adapterCommonModuleXml);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonModules', ADAPTER_MODULE_NAME, 'Ext', 'Module.bsl'), adapterCommonModuleBsl);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonCommands', `${REFRESH_COMMAND_NAME}.xml`), refreshCommandXml);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonCommands', REFRESH_COMMAND_NAME, 'Ext', 'CommandModule.bsl'), refreshCommandBsl);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonCommands', `${SETTINGS_COMMAND_NAME}.xml`), settingsCommandXml);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonCommands', SETTINGS_COMMAND_NAME, 'Ext', 'CommandModule.bsl'), settingsCommandBsl);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonCommands', `${TOGGLE_MODE_COMMAND_NAME}.xml`), toggleModeCommandXml);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonCommands', TOGGLE_MODE_COMMAND_NAME, 'Ext', 'CommandModule.bsl'), toggleModeCommandBsl);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonForms', `${SETTINGS_FORM_NAME}.xml`), settingsFormXml);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonForms', SETTINGS_FORM_NAME, 'Ext', 'Form.xml'), settingsFormLayoutXml);
    await writeTextFile(path.join(extensionSourceDirectory, 'CommonForms', SETTINGS_FORM_NAME, 'Ext', 'Form', 'Module.bsl'), settingsFormModuleBsl);
    for (const preset of HOTKEY_PRESETS) {
        const commandId = ids.hotkeyCommandIds[preset.key];
        const commandXml = buildHiddenHotkeyCommandXml(
            scanResult.configuration.xmlVersion,
            commandId,
            scanResult.configuration,
            preset
        );
        const commandBsl = buildHiddenHotkeyCommandModuleText(
            scanResult.configuration,
            preset
        );
        await writeTextFile(path.join(extensionSourceDirectory, 'CommonCommands', `${preset.commandName}.xml`), commandXml);
        await writeTextFile(path.join(extensionSourceDirectory, 'CommonCommands', preset.commandName, 'Ext', 'CommandModule.bsl'), commandBsl);
    }

    const configDumpInfoXml = buildConfigDumpInfoXml(scanResult.configuration.xmlVersion, metadataEntries);
    await writeTextFile(path.join(extensionSourceDirectory, 'ConfigDumpInfo.xml'), configDumpInfoXml);
    await initializeAdapterRuntimeFiles(settingsFilePath, modeFilePath, modeRequestFilePath, snapshotPath);

    const project: GeneratedExtensionProject = {
        extensionSourceDirectory,
        formsIndexPath,
        buildManifestPath,
        cfeOutputPath,
        cachedCfePath,
        cfeBuildStatePath,
        builderInfobaseDirectory,
        builderCacheStatePath,
        snapshotPath,
        settingsFilePath,
        modeFilePath,
        modeRequestFilePath,
        requestContextFilePath
    };

    const formsIndex = {
        generatedAt: new Date().toISOString(),
        configuration: {
            name: scanResult.configuration.name,
            synonym: scanResult.configuration.synonym,
            version: scanResult.configuration.version,
            compatibilityMode: scanResult.configuration.compatibilityMode,
            scriptVariant: scanResult.configuration.scriptVariant,
            selectedLanguage: scanResult.configuration.selectedLanguage,
            selectedCommandGroup: scanResult.configuration.selectedCommandGroup,
            sourceDirectory: configurationSourceDirectory
        },
        managedForms: scanResult.forms
    };

    const buildManifest = {
        generatedAt: new Date().toISOString(),
        project,
        runtimeStrategy: 'lightweight-subsystem-entry-point',
        placeholders: {
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
            configurationSourceDir: configurationSourceDirectory,
            generatedArtifactsDir: generatedArtifactsDirectory,
            extensionSourceDir: extensionSourceDirectory,
            cfePath: cfeOutputPath,
            cachedCfePath,
            oneCExePath: vscode.workspace.getConfiguration('kotTestToolkit').get<string>('paths.oneCEnterpriseExe') || '',
            snapshotPath,
            settingsFilePath,
            modeFilePath,
            modeRequestFilePath,
            requestContextFilePath,
            cfeBuildStatePath
        },
        builtInWindowsBuilder: {
            builderInfobaseDirectory,
            builderCacheStatePath
        },
        notes: [
            'If extensionBuildCommandTemplate is empty, KOT will try the built-in Windows 1C builder.',
            'A custom extensionBuildCommandTemplate overrides the built-in builder.'
        ]
    };

    await writeTextFile(formsIndexPath, `${JSON.stringify(formsIndex, null, 2)}\n`);
    await writeTextFile(buildManifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`);
    await writeTextFile(path.join(generatedArtifactsDirectory, 'README.md'), buildReadmeText(project, scanResult));

    return project;
}

async function runBuildCommand(
    commandTemplate: string,
    project: GeneratedExtensionProject,
    configurationSourceDirectory: string,
    generatedArtifactsDirectory: string,
    snapshotPath: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const oneCExePath = (vscode.workspace.getConfiguration('kotTestToolkit').get<string>('paths.oneCEnterpriseExe') || '').trim();
    const command = applyCommandTemplate(commandTemplate, {
        workspaceRoot,
        workspaceRootQuoted: quoteForShell(workspaceRoot),
        configurationSourceDir: configurationSourceDirectory,
        configurationSourceDirQuoted: quoteForShell(configurationSourceDirectory),
        generatedArtifactsDir: generatedArtifactsDirectory,
        generatedArtifactsDirQuoted: quoteForShell(generatedArtifactsDirectory),
        extensionSourceDir: project.extensionSourceDirectory,
        extensionSourceDirQuoted: quoteForShell(project.extensionSourceDirectory),
        cfePath: project.cfeOutputPath,
        cfePathQuoted: quoteForShell(project.cfeOutputPath),
        oneCExePath,
        oneCExePathQuoted: quoteForShell(oneCExePath),
        snapshotPath,
        snapshotPathQuoted: quoteForShell(snapshotPath)
    });

    outputChannel.appendLine(t('Running Form Explorer build command...'));
    outputChannel.appendLine(t('Resolved Form Explorer build command: {0}', command));

    await new Promise<void>((resolve, reject) => {
        const child = cp.spawn(command, [], {
            cwd: workspaceRoot,
            shell: true,
            windowsHide: true
        });

        child.stdout?.on('data', data => {
            outputChannel.append(data.toString());
        });

        child.stderr?.on('data', data => {
            outputChannel.append(data.toString());
        });

        child.on('error', error => reject(error));
        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(t('Form Explorer build command exited with code {0}.', String(code ?? 'unknown'))));
        });
    });
}

async function run1CCommand(
    exePath: string,
    args: string[],
    cwd: string,
    stepTitle: string,
    outFilePath: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const effectiveArgs = [...args, '/Out', outFilePath];
    outputChannel.appendLine(t('Form Explorer build step: {0}', stepTitle));
    outputChannel.appendLine(t('Resolved 1C command: {0}', formatCommandForOutput(exePath, effectiveArgs)));

    await new Promise<void>((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        const child = cp.spawn(exePath, effectiveArgs, {
            cwd,
            shell: false,
            windowsHide: true
        });

        child.stdout?.on('data', data => {
            const chunk = data.toString();
            stdout += chunk;
            outputChannel.append(chunk);
        });

        child.stderr?.on('data', data => {
            const chunk = data.toString();
            stderr += chunk;
            outputChannel.append(chunk);
        });

        child.on('error', error => reject(error));
        child.on('close', async code => {
            if (code === 0) {
                resolve();
                return;
            }

            let designerLog = '';
            if (await pathExists(outFilePath)) {
                try {
                    designerLog = await readUtf8File(outFilePath);
                } catch {
                    // Ignore unreadable designer log and fall back to stdout/stderr.
                }
            }

            const details = getOutputTail(`${stderr}\n${stdout}\n${designerLog}`) || t('<empty output>');
            reject(new Error(t('1C command for "{0}" exited with code {1}. Output tail: {2}', stepTitle, String(code ?? 'unknown'), details)));
        });
    });
}

async function runProcessCommand(
    exePath: string,
    args: string[],
    cwd: string,
    stepTitle: string,
    outFilePath: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    outputChannel.appendLine(t('Form Explorer build step: {0}', stepTitle));
    outputChannel.appendLine(t('Resolved command: {0}', formatCommandForOutput(exePath, args)));

    await new Promise<void>((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        const child = cp.spawn(exePath, args, {
            cwd,
            shell: false,
            windowsHide: true
        });

        child.stdout?.on('data', data => {
            const chunk = data.toString();
            stdout += chunk;
            outputChannel.append(chunk);
        });

        child.stderr?.on('data', data => {
            const chunk = data.toString();
            stderr += chunk;
            outputChannel.append(chunk);
        });

        child.on('error', error => reject(error));
        child.on('close', async code => {
            const combinedOutput = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`;
            try {
                await ensureDirectory(path.dirname(outFilePath));
                await fs.promises.writeFile(outFilePath, combinedOutput, 'utf8');
            } catch {
                // Ignore log write failures and surface the process result instead.
            }

            if (code === 0) {
                resolve();
                return;
            }

            const details = getOutputTail(combinedOutput) || t('<empty output>');
            reject(new Error(t('Command for "{0}" exited with code {1}. Output tail: {2}', stepTitle, String(code ?? 'unknown'), details)));
        });
    });
}

async function runBuiltInWindowsExtensionExport(
    oneCExePath: string,
    project: GeneratedExtensionProject,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    await run1CCommand(
        oneCExePath,
        [
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            buildFileInfobaseConnectionArgument(project.builderInfobaseDirectory),
            '/LoadConfigFromFiles',
            project.extensionSourceDirectory,
            '-Extension',
            GENERATED_EXTENSION_NAME,
            '/UpdateDBCfg'
        ],
        generatedArtifactsDirectory,
        t('Load generated Form Explorer extension into builder infobase'),
        path.join(logsDirectory, '03-load-generated-extension.log'),
        outputChannel,
        t
    );

    await run1CCommand(
        oneCExePath,
        [
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            buildFileInfobaseConnectionArgument(project.builderInfobaseDirectory),
            '/DumpCfg',
            project.cfeOutputPath,
            '-Extension',
            GENERATED_EXTENSION_NAME
        ],
        generatedArtifactsDirectory,
        t('Dump Form Explorer extension to .cfe'),
        path.join(logsDirectory, '04-dump-generated-extension.log'),
        outputChannel,
        t
    );
}

async function runBuiltInWindowsInstallToInfobase(
    oneCExePath: string,
    project: GeneratedExtensionProject,
    targetInfobasePath: string,
    authentication: InfobaseAuthentication | null,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const installArgs = appendInfobaseAuthenticationArgs(
        [
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            buildInfobaseConnectionArgument(targetInfobasePath),
            '/LoadCfg',
            project.cfeOutputPath,
            '-Extension',
            GENERATED_EXTENSION_NAME,
            '/UpdateDBCfg'
        ],
        authentication
    );

    await run1CCommand(
        oneCExePath,
        installArgs,
        generatedArtifactsDirectory,
        t('Install Form Explorer extension into target infobase'),
        path.join(logsDirectory, '05-install-extension-into-target-infobase.log'),
        outputChannel,
        t
    );
}

async function runBuiltInWindowsDirectInstallToInfobase(
    oneCExePath: string,
    project: GeneratedExtensionProject,
    targetInfobasePath: string,
    authentication: InfobaseAuthentication | null,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const installArgs = appendInfobaseAuthenticationArgs(
        [
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            buildInfobaseConnectionArgument(targetInfobasePath),
            '/LoadConfigFromFiles',
            project.extensionSourceDirectory,
            '-Extension',
            GENERATED_EXTENSION_NAME,
            '/UpdateDBCfg'
        ],
        authentication
    );

    await run1CCommand(
        oneCExePath,
        installArgs,
        generatedArtifactsDirectory,
        t('Install Form Explorer extension into target infobase'),
        path.join(logsDirectory, '05-direct-install-extension-into-target-infobase.log'),
        outputChannel,
        t
    );
}

async function runBuiltInWindowsDumpConfigurationFromInfobase(
    oneCExePath: string,
    targetInfobasePath: string,
    exportDirectory: string,
    authentication: InfobaseAuthentication | null,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    await recreateDirectory(exportDirectory);
    const dumpArgs = appendInfobaseAuthenticationArgs(
        [
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            buildInfobaseConnectionArgument(targetInfobasePath),
            '/DumpConfigToFiles',
            exportDirectory,
            '-Format',
            'Hierarchical'
        ],
        authentication
    );

    await run1CCommand(
        oneCExePath,
        dumpArgs,
        generatedArtifactsDirectory,
        t('Export target infobase configuration to files'),
        path.join(logsDirectory, '03-dump-target-infobase-configuration.log'),
        outputChannel,
        t
    );
}

async function runBuiltInWindowsDumpConfigurationFromFileInfobaseUsingIBCmd(
    ibcmdExePath: string,
    targetInfobaseFilePath: string,
    exportDirectory: string,
    authentication: InfobaseAuthentication | null,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    await recreateDirectory(exportDirectory);
    const dumpArgs = [
        'infobase',
        'config',
        'export',
        `--threads=${IBCMD_TARGET_EXPORT_THREADS}`,
        `--db-path=${targetInfobaseFilePath}`,
        ...((authentication?.username || '').trim()
            ? [
                `--user=${authentication!.username}`,
                `--password=${authentication!.password || ''}`
            ]
            : []),
        exportDirectory
    ];

    await runProcessCommand(
        ibcmdExePath,
        dumpArgs,
        generatedArtifactsDirectory,
        t('Export target infobase configuration to files via ibcmd'),
        path.join(logsDirectory, '03-dump-target-infobase-configuration-ibcmd.log'),
        outputChannel,
        t
    );
}

async function runBuiltInWindowsProbeExtensionInInfobase(
    oneCExePath: string,
    targetInfobasePath: string,
    authentication: InfobaseAuthentication | null,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<boolean> {
    const probeOutputPath = path.join(
        generatedArtifactsDirectory,
        `${GENERATED_EXTENSION_NAME}.probe.${Date.now()}.${Math.random().toString(16).slice(2)}.cfe`
    );
    const probeArgs = appendInfobaseAuthenticationArgs(
        [
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            buildInfobaseConnectionArgument(targetInfobasePath),
            '/DumpCfg',
            probeOutputPath,
            '-Extension',
            GENERATED_EXTENSION_NAME
        ],
        authentication
    );

    try {
        await run1CCommand(
            oneCExePath,
            probeArgs,
            generatedArtifactsDirectory,
            t('Check Form Explorer extension in target infobase'),
            path.join(logsDirectory, '04-check-extension-in-target-infobase.log'),
            outputChannel,
            t
        );
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isExtensionMissingInInfobaseError(message)) {
            return false;
        }
        throw error;
    } finally {
        try {
            await fs.promises.rm(probeOutputPath, { force: true });
        } catch {
            // Ignore probe cleanup errors.
        }
    }
}

async function probeExtensionInstalledInInfobaseWithAuthRetry(
    oneCExePath: string,
    targetInfobasePath: string,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<InfobaseExtensionProbeResult> {
    const authCacheKey = normalizeInfobaseConnectionIdentity(targetInfobasePath);
    let authentication: InfobaseAuthentication | null = INFOBASE_AUTH_CACHE.get(authCacheKey) || null;

    for (;;) {
        try {
            const installed = await runBuiltInWindowsProbeExtensionInInfobase(
                oneCExePath,
                targetInfobasePath,
                authentication,
                generatedArtifactsDirectory,
                logsDirectory,
                outputChannel,
                t
            );
            if (authentication) {
                INFOBASE_AUTH_CACHE.set(authCacheKey, authentication);
            } else {
                INFOBASE_AUTH_CACHE.delete(authCacheKey);
            }
            return {
                installed,
                authentication
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isInfobaseAuthenticationError(message)) {
                throw error;
            }

            outputChannel.appendLine(t('Infobase authentication is required to check installed extension. Requesting credentials.'));
            INFOBASE_AUTH_CACHE.delete(authCacheKey);
            const providedAuthentication = await promptInfobaseAuthentication(t, authentication, authentication !== null);
            if (!providedAuthentication) {
                throw new Error(
                    t('Extension check in target infobase was cancelled because infobase authentication credentials were not provided.')
                );
            }

            authentication = providedAuthentication;
            outputChannel.appendLine(
                t('Retrying extension check in infobase using user "{0}".', authentication.username)
            );
        }
    }
}

async function runBuiltInWindowsDumpConfigurationFromInfobaseWithAuthRetry(
    oneCExePath: string,
    targetInfobasePath: string,
    exportDirectory: string,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const authCacheKey = normalizeInfobaseConnectionIdentity(targetInfobasePath);
    let authentication: InfobaseAuthentication | null = INFOBASE_AUTH_CACHE.get(authCacheKey) || null;

    for (;;) {
        try {
            await runBuiltInWindowsDumpConfigurationFromInfobase(
                oneCExePath,
                targetInfobasePath,
                exportDirectory,
                authentication,
                generatedArtifactsDirectory,
                logsDirectory,
                outputChannel,
                t
            );
            if (authentication) {
                INFOBASE_AUTH_CACHE.set(authCacheKey, authentication);
            } else {
                INFOBASE_AUTH_CACHE.delete(authCacheKey);
            }
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isInfobaseAuthenticationError(message)) {
                throw error;
            }

            outputChannel.appendLine(
                t('Infobase authentication is required to export the current configuration. Requesting credentials.')
            );
            INFOBASE_AUTH_CACHE.delete(authCacheKey);
            const providedAuthentication = await promptInfobaseAuthentication(t, authentication, authentication !== null);
            if (!providedAuthentication) {
                throw new Error(
                    t('Export from target infobase was cancelled because infobase authentication credentials were not provided.')
                );
            }

            authentication = providedAuthentication;
            outputChannel.appendLine(
                t('Retrying target configuration export using user "{0}".', authentication.username)
            );
        }
    }
}

async function runBuiltInWindowsDumpConfigurationFromFileInfobaseUsingIBCmdWithAuthRetry(
    ibcmdExePath: string,
    targetInfobasePath: string,
    targetInfobaseFilePath: string,
    exportDirectory: string,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const authCacheKey = normalizeInfobaseConnectionIdentity(targetInfobasePath);
    let authentication: InfobaseAuthentication | null = INFOBASE_AUTH_CACHE.get(authCacheKey) || null;

    for (;;) {
        try {
            await runBuiltInWindowsDumpConfigurationFromFileInfobaseUsingIBCmd(
                ibcmdExePath,
                targetInfobaseFilePath,
                exportDirectory,
                authentication,
                generatedArtifactsDirectory,
                logsDirectory,
                outputChannel,
                t
            );
            if (authentication) {
                INFOBASE_AUTH_CACHE.set(authCacheKey, authentication);
            } else {
                INFOBASE_AUTH_CACHE.delete(authCacheKey);
            }
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isInfobaseAuthenticationError(message)) {
                throw error;
            }

            outputChannel.appendLine(
                t('Infobase authentication is required to export the current configuration. Requesting credentials.')
            );
            INFOBASE_AUTH_CACHE.delete(authCacheKey);
            const providedAuthentication = await promptInfobaseAuthentication(t, authentication, authentication !== null);
            if (!providedAuthentication) {
                throw new Error(
                    t('Export from target infobase was cancelled because infobase authentication credentials were not provided.')
                );
            }

            authentication = providedAuthentication;
            outputChannel.appendLine(
                t('Retrying target configuration export using user "{0}".', authentication.username)
            );
        }
    }
}

async function runBuiltInWindowsInstallToInfobaseWithAuthRetry(
    oneCExePath: string,
    project: GeneratedExtensionProject,
    targetInfobasePath: string,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const authCacheKey = normalizeInfobaseConnectionIdentity(targetInfobasePath);
    let authentication: InfobaseAuthentication | null = INFOBASE_AUTH_CACHE.get(authCacheKey) || null;

    for (;;) {
        try {
            await runBuiltInWindowsInstallToInfobase(
                oneCExePath,
                project,
                targetInfobasePath,
                authentication,
                generatedArtifactsDirectory,
                logsDirectory,
                outputChannel,
                t
            );
            if (authentication) {
                INFOBASE_AUTH_CACHE.set(authCacheKey, authentication);
            } else {
                INFOBASE_AUTH_CACHE.delete(authCacheKey);
            }
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isInfobaseAuthenticationError(message)) {
                throw error;
            }

            outputChannel.appendLine(t('Infobase authentication is required for extension install. Requesting credentials.'));
            INFOBASE_AUTH_CACHE.delete(authCacheKey);
            const providedAuthentication = await promptInfobaseAuthentication(t, authentication, authentication !== null);
            if (!providedAuthentication) {
                throw new Error(
                    t('Install into target infobase was cancelled because infobase authentication credentials were not provided.')
                );
            }

            authentication = providedAuthentication;
            outputChannel.appendLine(
                t('Retrying extension install into infobase using user "{0}".', authentication.username)
            );
        }
    }
}

async function runBuiltInWindowsDirectInstallToInfobaseWithAuthRetry(
    oneCExePath: string,
    project: GeneratedExtensionProject,
    targetInfobasePath: string,
    generatedArtifactsDirectory: string,
    logsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const authCacheKey = normalizeInfobaseConnectionIdentity(targetInfobasePath);
    let authentication: InfobaseAuthentication | null = INFOBASE_AUTH_CACHE.get(authCacheKey) || null;

    for (;;) {
        try {
            await runBuiltInWindowsDirectInstallToInfobase(
                oneCExePath,
                project,
                targetInfobasePath,
                authentication,
                generatedArtifactsDirectory,
                logsDirectory,
                outputChannel,
                t
            );
            if (authentication) {
                INFOBASE_AUTH_CACHE.set(authCacheKey, authentication);
            } else {
                INFOBASE_AUTH_CACHE.delete(authCacheKey);
            }
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isInfobaseAuthenticationError(message)) {
                throw error;
            }

            outputChannel.appendLine(t('Infobase authentication is required for extension install. Requesting credentials.'));
            INFOBASE_AUTH_CACHE.delete(authCacheKey);
            const providedAuthentication = await promptInfobaseAuthentication(t, authentication, authentication !== null);
            if (!providedAuthentication) {
                throw new Error(
                    t('Install into target infobase was cancelled because infobase authentication credentials were not provided.')
                );
            }

            authentication = providedAuthentication;
            outputChannel.appendLine(
                t('Retrying extension install into infobase using user "{0}".', authentication.username)
            );
        }
    }
}

async function resolveConfiguredOneCClientExePath(
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<string> {
    const oneCClientExePath = (vscode.workspace.getConfiguration('kotTestToolkit').get<string>('paths.oneCEnterpriseExe') || '').trim();

    if (!oneCClientExePath) {
        const action = t('Open Settings');
        vscode.window.showErrorMessage(
            t('Path to 1C:Enterprise client (1cv8c.exe) is not specified in settings.'),
            action
        ).then(selection => {
            if (selection === action) {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
            }
        });
        const error = new Error(t('Path to 1C:Enterprise client (1cv8c.exe) is not specified in settings.')) as Error & { alreadyShownToUser?: boolean };
        error.alreadyShownToUser = true;
        throw error;
    }

    if (!(await pathExists(oneCClientExePath))) {
        const action = t('Open Settings');
        vscode.window.showErrorMessage(
            t('1C:Enterprise client file not found at path: {0}', oneCClientExePath),
            action
        ).then(selection => {
            if (selection === action) {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
            }
        });
        const error = new Error(t('1C:Enterprise client file not found at path: {0}', oneCClientExePath)) as Error & { alreadyShownToUser?: boolean };
        error.alreadyShownToUser = true;
        throw error;
    }

    return oneCClientExePath;
}

async function resolveConfiguredOneCDesignerExePath(
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<string> {
    const oneCClientExePath = await resolveConfiguredOneCClientExePath(t);
    const oneCDesignerExePath = resolveOneCDesignerExePath(oneCClientExePath);

    if (!(await pathExists(oneCDesignerExePath))) {
        const action = t('Open Settings');
        vscode.window.showErrorMessage(
            t('1C:Enterprise Designer file not found at path: {0}', oneCDesignerExePath),
            action
        ).then(selection => {
            if (selection === action) {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.paths.oneCEnterpriseExe');
            }
        });
        const error = new Error(t('1C:Enterprise Designer file not found at path: {0}', oneCDesignerExePath)) as Error & { alreadyShownToUser?: boolean };
        error.alreadyShownToUser = true;
        throw error;
    }

    return oneCDesignerExePath;
}

async function tryResolveConfiguredOneCIBCmdExePath(): Promise<string | null> {
    const oneCClientExePath = (vscode.workspace.getConfiguration('kotTestToolkit').get<string>('paths.oneCEnterpriseExe') || '').trim();
    if (!oneCClientExePath) {
        return null;
    }

    const ibcmdExePath = resolveOneCIBCmdExePath(oneCClientExePath);
    return (await pathExists(ibcmdExePath))
        ? ibcmdExePath
        : null;
}

async function writeFormExplorerModeRequest(
    modeRequestCode: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const generatedArtifactsDirectory = getFormExplorerGeneratedArtifactsDirectory();
    if (!generatedArtifactsDirectory) {
        outputChannel.appendLine(
            t('Skipping mode request "{0}": Form Explorer generated artifacts directory is not configured.', modeRequestCode)
        );
        return;
    }

    const modeRequestPath = path.join(generatedArtifactsDirectory, DEFAULT_MODE_REQUEST_FILE_NAME);
    await ensureDirectory(path.dirname(modeRequestPath));
    await fs.promises.writeFile(modeRequestPath, `${modeRequestCode}\n`, 'utf8');
    outputChannel.appendLine(t('Wrote Form Explorer mode request: {0}', modeRequestCode));
}

async function launchInfobaseClientDetached(
    oneCClientExePath: string,
    targetInfobasePath: string,
    authentication: InfobaseAuthentication | null,
    startupArgs: string[],
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const launchArgs = appendInfobaseAuthenticationArgs(
        [
            'ENTERPRISE',
            '/IBConnectionString',
            buildInfobaseConnectionArgument(targetInfobasePath, { trailingSemicolon: true }),
            ...(authentication
                ? ['/DisableStartupDialogs', '/DisableStartupMessages', ...startupArgs]
                : startupArgs)
        ],
        authentication
    );
    const workspaceRootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    outputChannel.appendLine(t('Launching 1C:Enterprise client for infobase: {0}', targetInfobasePath));
    outputChannel.appendLine(t('Resolved 1C command: {0}', formatCommandForOutput(oneCClientExePath, launchArgs)));

    await new Promise<void>((resolve, reject) => {
        try {
            const child = cp.spawn(oneCClientExePath, launchArgs, {
                cwd: workspaceRootPath,
                shell: false,
                windowsHide: false,
                detached: true,
                stdio: 'ignore'
            });
            child.on('error', error => reject(error));
            child.unref();
            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

async function runBuiltInWindowsBuild(
    context: vscode.ExtensionContext,
    project: GeneratedExtensionProject,
    configurationSourceDirectory: string,
    generatedArtifactsDirectory: string,
    outputChannel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<string> {
    const oneCClientExePath = (vscode.workspace.getConfiguration('kotTestToolkit').get<string>('paths.oneCEnterpriseExe') || '').trim();
    const oneCDesignerExePath = await resolveConfiguredOneCDesignerExePath(t);
    const logsDirectory = path.join(generatedArtifactsDirectory, 'build-logs');
    const buildFingerprint = await computeFormExplorerCfeBuildFingerprint(
        context,
        configurationSourceDirectory,
        project,
        oneCDesignerExePath
    );
    const cachedBuildState = await readJsonFile<FormExplorerCfeBuildState>(project.cfeBuildStatePath);

    await ensureDirectory(generatedArtifactsDirectory);
    await ensureDirectory(path.dirname(project.cfeOutputPath));

    if (
        isReusableFormExplorerCfeBuildState(cachedBuildState, buildFingerprint, project.cachedCfePath)
        && (await pathExists(project.cachedCfePath))
    ) {
        outputChannel.appendLine(t('Reusing cached Form Explorer .cfe.'));
        if (path.resolve(project.cachedCfePath) !== path.resolve(project.cfeOutputPath)) {
            await copyFileEnsuringDirectory(project.cachedCfePath, project.cfeOutputPath);
        }
        return oneCDesignerExePath;
    }

    await fs.promises.rm(project.cfeOutputPath, { force: true });

    const ensureResult = await ensureFormExplorerBuilderInfobaseReady(
        context,
        oneCClientExePath,
        {
            showOutputPanel: false,
            showProgressNotification: false
        }
    );
    await recreateDirectory(logsDirectory);

    try {
        await runBuiltInWindowsExtensionExport(
            oneCDesignerExePath,
            project,
            generatedArtifactsDirectory,
            logsDirectory,
            outputChannel,
            t
        );
    } catch (error) {
        if (!ensureResult.reusedExistingBuilder) {
            throw error;
        }

        outputChannel.appendLine(t('Cached builder infobase failed during extension build. Rebuilding cache and retrying once.'));
        await recreateDirectory(logsDirectory);
        await ensureFormExplorerBuilderInfobaseReady(
            context,
            oneCClientExePath,
            {
                showOutputPanel: false,
                showProgressNotification: false,
                forceRebuild: true
            }
        );

        await runBuiltInWindowsExtensionExport(
            oneCDesignerExePath,
            project,
            generatedArtifactsDirectory,
            logsDirectory,
            outputChannel,
            t
        );
    }

    if (path.resolve(project.cachedCfePath) !== path.resolve(project.cfeOutputPath)) {
        await copyFileEnsuringDirectory(project.cfeOutputPath, project.cachedCfePath);
    }
    await writeFormExplorerCfeBuildState(project.cfeBuildStatePath, buildFingerprint, project.cachedCfePath);

    return oneCDesignerExePath;
}

type FormExplorerExtensionRunMode = 'build' | 'install';

async function handleGenerateFormExplorerExtensionCore(
    context: vscode.ExtensionContext,
    runMode: FormExplorerExtensionRunMode,
    options?: GenerateFormExplorerExtensionOptions
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const configuredConfigurationSourceDirectory = getFormExplorerConfigurationSourceDirectory();
    const generatedArtifactsDirectory = getFormExplorerGeneratedArtifactsDirectory();
    const snapshotPath = getFormExplorerSnapshotPath();
    const buildCommandTemplate = (
        vscode.workspace.getConfiguration('kotTestToolkit.formExplorer').get<string>('extensionBuildCommandTemplate')
        || ''
    ).trim();
    const showOutputPanel = vscode.workspace.getConfiguration('kotTestToolkit.formExplorer').get<boolean>('showOutputPanel', false);

    if (!generatedArtifactsDirectory) {
        const action = t('Open Settings');
        vscode.window.showErrorMessage(
            t('Form Explorer generated artifacts directory is not configured. Set kotTestToolkit.formExplorer.generatedArtifactsDirectory.'),
            action
        ).then(selection => {
            if (selection === action) {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.formExplorer.generatedArtifactsDirectory');
            }
        });
        return;
    }

    if (!snapshotPath) {
        const action = t('Open Settings');
        vscode.window.showErrorMessage(
            t('Form Explorer snapshot path is not configured. Set kotTestToolkit.formExplorer.snapshotPath.'),
            action
        ).then(selection => {
            if (selection === action) {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.formExplorer.snapshotPath');
            }
        });
        return;
    }

    const cfeOutputPath = runMode === 'install'
        ? path.join(generatedArtifactsDirectory, 'KOTFormExplorerRuntime.install.tmp.cfe')
        : await pickCfeOutputPath(generatedArtifactsDirectory, t);
    if (!cfeOutputPath) {
        return;
    }

    const preselectedTargetInfobasePathRaw = (options?.targetInfobasePath || '').trim();
    const hasPreselectedTargetInfobasePath = Boolean(preselectedTargetInfobasePathRaw);
    const preselectedTargetInfobasePath = hasPreselectedTargetInfobasePath
        ? normalizeInfobaseReference(preselectedTargetInfobasePathRaw)
        : '';
    const targetInfobasePath = runMode === 'install'
        ? (hasPreselectedTargetInfobasePath
            ? preselectedTargetInfobasePath
            : await pickManagedInfobasePath(context, t, {
                allowBuildOnly: false,
                allowCreateNew: false,
                allowedKinds: ['file', 'server'],
                placeHolder: t('Choose target infobase for extension install')
            }))
        : null;
    if (runMode === 'install' && targetInfobasePath === undefined) {
        return;
    }
    const targetInfobaseFilePath = targetInfobasePath
        ? getFileInfobasePath(targetInfobasePath)
        : null;
    const requestedInstallMode = tryParseFormExplorerInstallMode(options?.installMode);
    const effectiveInstallMode = runMode === 'install' && targetInfobasePath
        ? (requestedInstallMode || await pickFormExplorerInstallMode(t, targetInfobasePath))
        : null;
    if (runMode === 'install' && targetInfobasePath && !effectiveInstallMode) {
        return;
    }

    const requiresConfiguredConfigurationSourceDirectory = runMode === 'build'
        || effectiveInstallMode !== 'target';
    if (requiresConfiguredConfigurationSourceDirectory && !configuredConfigurationSourceDirectory) {
        const action = t('Open Settings');
        vscode.window.showErrorMessage(
            t('Form Explorer configuration source directory is not configured. Set kotTestToolkit.formExplorer.configurationSourceDirectory.'),
            action
        ).then(selection => {
            if (selection === action) {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.formExplorer.configurationSourceDirectory');
            }
        });
        return;
    }

    if (requiresConfiguredConfigurationSourceDirectory && configuredConfigurationSourceDirectory) {
        const configurationXmlPath = path.join(configuredConfigurationSourceDirectory, 'Configuration.xml');
        if (!(await pathExists(configurationXmlPath))) {
            vscode.window.showErrorMessage(
                t('Could not find Configuration.xml in {0}.', configuredConfigurationSourceDirectory)
            );
            return;
        }
    }

    const outputChannel = getFormExplorerBuilderOutputChannel();
    outputChannel.clear();
    if (showOutputPanel) {
        outputChannel.show(true);
    }

    try {
        let builtProject: GeneratedExtensionProject | null = null;
        let buildExecuted = false;
        let installExecuted = false;
        let installedInfobasePath: string | null = null;
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: runMode === 'install'
                    ? t('Building and installing KOT Form Explorer beta extension...')
                    : t('Building KOT Form Explorer beta extension...'),
                cancellable: false
            },
            async progress => {
                const shouldUseTargetInfobaseExport = Boolean(targetInfobasePath) && effectiveInstallMode === 'target';
                const shouldDirectInstallIntoTarget = Boolean(targetInfobasePath)
                    && (effectiveInstallMode === 'direct' || effectiveInstallMode === 'target');
                let effectiveConfigurationSourceDirectory = configuredConfigurationSourceDirectory || '';
                let oneCDesignerExePath: string | null = null;

                if (shouldUseTargetInfobaseExport) {
                    if (!targetInfobasePath) {
                        throw new Error(t('Target infobase path is not specified.'));
                    }

                    if (process.platform !== 'win32') {
                        throw new Error(
                            t('Automatic install into selected infobase is supported only on Windows where 1C Designer is available.')
                        );
                    }

                    const targetConfigurationExportDirectory = path.join(
                        generatedArtifactsDirectory,
                        TARGET_INFOBASE_CONFIGURATION_EXPORT_DIRECTORY_NAME
                    );
                    const logsDirectory = path.join(generatedArtifactsDirectory, 'build-logs');
                    await ensureDirectory(logsDirectory);

                    progress.report({ message: t('Exporting target infobase configuration to files...') });
                    outputChannel.appendLine(
                        t('Using target infobase export mode for Form Explorer target infobase.')
                    );
                    outputChannel.appendLine(
                        t('Exporting current target infobase configuration from: {0}', targetInfobasePath)
                    );
                    let exportedWithIBCmd = false;
                    if (targetInfobaseFilePath) {
                        const ibcmdExePath = await tryResolveConfiguredOneCIBCmdExePath();
                        if (ibcmdExePath) {
                            outputChannel.appendLine(
                                t('Trying ibcmd export for file infobase: {0}', targetInfobaseFilePath)
                            );
                            try {
                                await runBuiltInWindowsDumpConfigurationFromFileInfobaseUsingIBCmdWithAuthRetry(
                                    ibcmdExePath,
                                    targetInfobasePath,
                                    targetInfobaseFilePath,
                                    targetConfigurationExportDirectory,
                                    generatedArtifactsDirectory,
                                    logsDirectory,
                                    outputChannel,
                                    t
                                );
                                exportedWithIBCmd = true;
                            } catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                outputChannel.appendLine(
                                    t('ibcmd export failed. Falling back to 1C Designer export. Details: {0}', message)
                                );
                            }
                        } else {
                            outputChannel.appendLine(
                                t('ibcmd.exe was not found next to the configured 1C platform binaries. Falling back to 1C Designer export.')
                            );
                        }
                    }
                    if (!exportedWithIBCmd) {
                        oneCDesignerExePath = await resolveConfiguredOneCDesignerExePath(t);
                        await runBuiltInWindowsDumpConfigurationFromInfobaseWithAuthRetry(
                            oneCDesignerExePath,
                            targetInfobasePath,
                            targetConfigurationExportDirectory,
                            generatedArtifactsDirectory,
                            logsDirectory,
                            outputChannel,
                            t
                        );
                    }
                    effectiveConfigurationSourceDirectory = targetConfigurationExportDirectory;
                }

                const effectiveConfigurationXmlPath = path.join(effectiveConfigurationSourceDirectory, 'Configuration.xml');
                if (!(await pathExists(effectiveConfigurationXmlPath))) {
                    throw new Error(
                        t('Could not find Configuration.xml in {0}.', effectiveConfigurationSourceDirectory)
                    );
                }

                progress.report({ message: t('Scanning configuration forms...') });
                outputChannel.appendLine(t('Scanning 1C configuration forms in {0}...', effectiveConfigurationSourceDirectory));
                const scanResult = await scanConfigurationSource(effectiveConfigurationSourceDirectory);
                outputChannel.appendLine(t('Discovered {0} managed forms.', String(scanResult.forms.length)));

                progress.report({ message: t('Generating extension project...') });
                outputChannel.appendLine(t('Generating Form Explorer extension project...'));
                const project = await generateExtensionProjectFiles(
                    context,
                    scanResult,
                    effectiveConfigurationSourceDirectory,
                    generatedArtifactsDirectory,
                    snapshotPath,
                    cfeOutputPath
                );
                builtProject = project;

                outputChannel.appendLine(t('Form Explorer extension project generated at: {0}', project.extensionSourceDirectory));
                outputChannel.appendLine(t('Managed forms index written to: {0}', project.formsIndexPath));
                if (effectiveInstallMode) {
                    outputChannel.appendLine(t('Selected Form Explorer install mode: {0}', effectiveInstallMode));
                }

                if (buildCommandTemplate && !shouldDirectInstallIntoTarget) {
                    progress.report({ message: t('Running external .cfe build...') });
                    await runBuildCommand(
                        buildCommandTemplate,
                        project,
                        effectiveConfigurationSourceDirectory,
                        generatedArtifactsDirectory,
                        snapshotPath,
                        outputChannel,
                        t
                    );
                    buildExecuted = true;
                    oneCDesignerExePath = targetInfobasePath
                        ? await resolveConfiguredOneCDesignerExePath(t)
                        : null;
                }

                if (!buildExecuted && !shouldDirectInstallIntoTarget && process.platform !== 'win32') {
                    const openSettingsAction = t('Open Settings');
                    const revealAction = t('Reveal Output');
                    vscode.window.showInformationMessage(
                        t('Form Explorer extension project was generated. Configure kotTestToolkit.formExplorer.extensionBuildCommandTemplate if you need an external builder.'),
                        openSettingsAction,
                        revealAction
                    ).then(selection => {
                        if (selection === openSettingsAction) {
                            void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.formExplorer.extensionBuildCommandTemplate');
                        } else if (selection === revealAction) {
                            outputChannel.show(true);
                        }
                    });
                    return;
                }

                if (!buildExecuted && !shouldDirectInstallIntoTarget) {
                    progress.report({ message: t('Building .cfe...') });
                    outputChannel.appendLine(t('Using built-in Windows 1C builder for Form Explorer .cfe.'));
                    oneCDesignerExePath = await runBuiltInWindowsBuild(
                        context,
                        project,
                        effectiveConfigurationSourceDirectory,
                        generatedArtifactsDirectory,
                        outputChannel,
                        t
                    );
                    buildExecuted = true;
                }

                if (targetInfobasePath) {
                    if (targetInfobaseFilePath && !(await pathExists(targetInfobaseFilePath))) {
                        throw new Error(t('Target infobase path does not exist: {0}', targetInfobasePath));
                    }

                    if (process.platform !== 'win32') {
                        throw new Error(
                            t('Automatic install into selected infobase is supported only on Windows where 1C Designer is available.')
                        );
                    }

                    if (!oneCDesignerExePath) {
                        oneCDesignerExePath = await resolveConfiguredOneCDesignerExePath(t);
                    }

                    progress.report({
                        message: shouldDirectInstallIntoTarget
                            ? t('Installing generated extension directly into selected infobase...')
                            : t('Installing .cfe into selected infobase...')
                    });
                    outputChannel.appendLine(t('Installing Form Explorer extension into infobase: {0}', targetInfobasePath));
                    const logsDirectory = path.join(generatedArtifactsDirectory, 'build-logs');
                    await ensureDirectory(logsDirectory);
                    if (effectiveInstallMode === 'direct') {
                        outputChannel.appendLine(t('Using direct install mode for Form Explorer target infobase.'));
                    } else if (effectiveInstallMode === 'target') {
                        outputChannel.appendLine(
                            t('Using target infobase export mode for Form Explorer target infobase.')
                        );
                    }
                    const installProbeResult = await probeExtensionInstalledInInfobaseWithAuthRetry(
                        oneCDesignerExePath,
                        targetInfobasePath,
                        generatedArtifactsDirectory,
                        logsDirectory,
                        outputChannel,
                        t
                    );
                    outputChannel.appendLine(
                        installProbeResult.installed
                            ? t('Detected existing Form Explorer extension in target infobase. Reinstalling.')
                            : t('Form Explorer extension was not found in target infobase. Performing initial install.')
                    );
                    if (shouldDirectInstallIntoTarget) {
                        await runBuiltInWindowsDirectInstallToInfobaseWithAuthRetry(
                            oneCDesignerExePath,
                            project,
                            targetInfobasePath,
                            generatedArtifactsDirectory,
                            logsDirectory,
                            outputChannel,
                            t
                        );
                    } else {
                        await runBuiltInWindowsInstallToInfobaseWithAuthRetry(
                            oneCDesignerExePath,
                            project,
                            targetInfobasePath,
                            generatedArtifactsDirectory,
                            logsDirectory,
                            outputChannel,
                            t
                        );
                    }
                    installExecuted = true;
                    installedInfobasePath = targetInfobasePath;
                }
            }
        );

        if (!builtProject || (!buildExecuted && !installExecuted)) {
            return;
        }

        if (installExecuted && installedInfobasePath) {
            await updateManagedInfobaseMetadata(context, installedInfobasePath, {
                displayName: describeInfobaseConnection(installedInfobasePath),
                addRoles: ['formExplorer'],
                stateHint: 'ready'
            });
        }

        if (buildExecuted && await pathExists(builtProject.cfeOutputPath)) {
            outputChannel.appendLine(t('Form Explorer .cfe build completed: {0}', builtProject.cfeOutputPath));
            if (installExecuted && installedInfobasePath) {
                outputChannel.appendLine(t('Form Explorer extension installed into infobase: {0}', installedInfobasePath));
            }
            const openOutputAction = t('Open Output');
            const completionMessage = installExecuted && installedInfobasePath
                ? t('Form Explorer extension installed into infobase: {0}', installedInfobasePath)
                : t('Form Explorer .cfe build completed: {0}', builtProject.cfeOutputPath);
            if (installExecuted) {
                vscode.window.showInformationMessage(
                    completionMessage,
                    openOutputAction
                ).then(selection => {
                    if (selection === openOutputAction) {
                        outputChannel.show(true);
                    }
                });
            } else {
                const revealAction = t('Reveal in OS');
                vscode.window.showInformationMessage(
                    completionMessage,
                    revealAction,
                    openOutputAction
                ).then(selection => {
                    if (selection === revealAction) {
                        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(builtProject!.cfeOutputPath));
                    } else if (selection === openOutputAction) {
                        outputChannel.show(true);
                    }
                });
            }
        } else if (installExecuted && installedInfobasePath) {
            outputChannel.appendLine(t('Form Explorer extension installed into infobase: {0}', installedInfobasePath));
            const openOutputAction = t('Open Output');
            vscode.window.showInformationMessage(
                t('Form Explorer extension installed into infobase: {0}', installedInfobasePath),
                openOutputAction
            ).then(selection => {
                if (selection === openOutputAction) {
                    outputChannel.show(true);
                }
            });
        } else {
            outputChannel.appendLine(t('Build finished, but the expected .cfe file was not found: {0}', builtProject.cfeOutputPath));
            vscode.window.showWarningMessage(
                t('Build finished, but the expected .cfe file was not found: {0}', builtProject.cfeOutputPath)
            );
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(t('Form Explorer extension generation failed: {0}', message));
        if (!(error instanceof Error && 'alreadyShownToUser' in error && (error as Error & { alreadyShownToUser?: boolean }).alreadyShownToUser)) {
            vscode.window.showErrorMessage(t('Form Explorer extension generation failed: {0}', message));
        }
    }
}

export async function handleGenerateFormExplorerExtension(context: vscode.ExtensionContext): Promise<void> {
    await handleGenerateFormExplorerExtensionCore(context, 'build');
}

export async function handleBuildFormExplorerExtensionCfe(context: vscode.ExtensionContext): Promise<void> {
    await handleGenerateFormExplorerExtensionCore(context, 'build');
}

export async function handleInstallFormExplorerExtension(context: vscode.ExtensionContext): Promise<void> {
    await handleGenerateFormExplorerExtensionCore(context, 'install');
}

export async function handleStartFormExplorerInfobase(
    context: vscode.ExtensionContext,
    preferredInfobasePath?: string
): Promise<StartFormExplorerInfobaseResult> {
    const t = await getTranslator(context.extensionUri);
    if (process.platform !== 'win32') {
        vscode.window.showErrorMessage(
            t('Starting target infobase is supported only on Windows where 1C client is available.')
        );
        return {
            status: 'error',
            infobasePath: null,
            error: t('Starting target infobase is supported only on Windows where 1C client is available.')
        };
    }

    const configuredPreferredInfobasePath = typeof preferredInfobasePath === 'string' && preferredInfobasePath.trim()
        ? normalizeInfobaseReference(preferredInfobasePath.trim())
        : null;
    const generatedArtifactsDirectory = getFormExplorerGeneratedArtifactsDirectory();
    const workspaceRootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const runtimeDirectory = generatedArtifactsDirectory || path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'form-explorer');
    const logsDirectory = path.join(runtimeDirectory, 'build-logs');
    const outputChannel = getFormExplorerBuilderOutputChannel();
    if (vscode.workspace.getConfiguration('kotTestToolkit.formExplorer').get<boolean>('showOutputPanel', false)) {
        outputChannel.show(true);
    }

    try {
        const oneCClientExePath = await resolveConfiguredOneCClientExePath(t);
        const oneCDesignerExePath = await resolveConfiguredOneCDesignerExePath(t);
        let selectedTargetInfobasePath = configuredPreferredInfobasePath;
        if (!selectedTargetInfobasePath) {
            selectedTargetInfobasePath = await pickManagedInfobasePath(context, t, {
                allowBuildOnly: false,
                allowCreateNew: false,
                allowedKinds: ['file', 'server'],
                placeHolder: t('Choose target infobase to start with Form Explorer'),
                preferredInfobasePath: null
            });
            if (selectedTargetInfobasePath === undefined || !selectedTargetInfobasePath) {
                return {
                    status: 'cancelled',
                    infobasePath: null,
                    error: null
                };
            };
        }

        const targetInfobasePath = normalizeInfobaseReference(selectedTargetInfobasePath);
        if (coerceInfobaseConnection(targetInfobasePath).kind === 'web') {
            throw new Error(t('Form Explorer is not supported for web infobases.'));
        }
        const targetInfobaseFilePath = getFileInfobasePath(targetInfobasePath);
        if (targetInfobaseFilePath && !(await pathExists(targetInfobaseFilePath))) {
            throw new Error(t('Target infobase path does not exist: {0}', targetInfobasePath));
        }

        await ensureDirectory(runtimeDirectory);
        await ensureDirectory(logsDirectory);

        let probeResult = await probeExtensionInstalledInInfobaseWithAuthRetry(
            oneCDesignerExePath,
            targetInfobasePath,
            runtimeDirectory,
            logsDirectory,
            outputChannel,
            t
        );
        const extensionWasInstalled = probeResult.installed;
        const startAction = await pickStartInfobaseAction(t, targetInfobasePath, probeResult.installed);
        if (!startAction) {
            return {
                status: 'cancelled',
                infobasePath: targetInfobasePath,
                error: null
            };
        }

        if (startAction.actionKey === 'reinstall') {
            await handleGenerateFormExplorerExtensionCore(context, 'install', {
                targetInfobasePath,
                installMode: startAction.installMode || null
            });
            probeResult = await probeExtensionInstalledInInfobaseWithAuthRetry(
                oneCDesignerExePath,
                targetInfobasePath,
                runtimeDirectory,
                logsDirectory,
                outputChannel,
                t
            );
            if (!probeResult.installed) {
                throw new Error(
                    extensionWasInstalled
                        ? t('Form Explorer extension is still not installed in target infobase after reinstall attempt: {0}', targetInfobasePath)
                        : t('Form Explorer extension is still not installed in target infobase after install attempt: {0}', targetInfobasePath)
                );
            }
        }

        await writeFormExplorerModeRequest('refresh', outputChannel, t);
        const startupArgs = getManagedInfobaseStartupParameterArgs(context, targetInfobasePath, {
            allowDialogSuppression: probeResult.authentication !== null
        });
        await launchInfobaseClientDetached(
            oneCClientExePath,
            targetInfobasePath,
            probeResult.authentication,
            startupArgs,
            outputChannel,
            t
        );

        vscode.window.showInformationMessage(
            t('1C infobase launch started: {0}', describeInfobaseConnection(targetInfobasePath))
        );
        await updateManagedInfobaseMetadata(context, targetInfobasePath, {
            displayName: describeInfobaseConnection(targetInfobasePath),
            addRoles: ['formExplorer'],
            lastLaunchAt: new Date().toISOString(),
            lastLaunchKind: 'formExplorer',
            stateHint: 'ready'
        });
        return {
            status: 'started',
            infobasePath: targetInfobasePath,
            error: null
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(t('Failed to start target infobase for Form Explorer: {0}', message));
        if (!(error instanceof Error && 'alreadyShownToUser' in error && (error as Error & { alreadyShownToUser?: boolean }).alreadyShownToUser)) {
            vscode.window.showErrorMessage(t('Failed to start target infobase for Form Explorer: {0}', message));
        }
        return {
            status: 'error',
            infobasePath: typeof preferredInfobasePath === 'string' && preferredInfobasePath.trim()
                ? normalizeInfobaseReference(preferredInfobasePath.trim())
                : null,
            error: t('Failed to start target infobase for Form Explorer: {0}', message)
        };
    }
}
