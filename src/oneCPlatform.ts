import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getTranslator, type Translator } from './localization';

const WINDOWS_1C_INSTALL_ROOTS = [
    'C:\\Program Files\\1cv8',
    'C:\\Program Files (x86)\\1cv8'
];

const PLATFORMS_CONFIG_KEY = 'platforms.catalog';
const PROMPT_FOR_LAUNCHES_CONFIG_KEY = 'platforms.promptForLaunches';

export interface ConfiguredOneCPlatform {
    name: string;
    clientExePath: string;
}

interface RawConfiguredOneCPlatform {
    name?: string;
    clientExePath?: string;
    path?: string;
}

interface PlatformManagerQuickPickItem extends vscode.QuickPickItem {
    entryKind: 'platform' | 'add';
    clientExePath?: string;
}

export interface ResolveOneCPlatformForLaunchOptions {
    promptUser?: boolean;
    forcePicker?: boolean;
    placeHolder?: string;
    title?: string;
}

function compareVersionSegments(left: string, right: string): number {
    const leftSegments = left.split(/[^\d]+/).filter(Boolean).map(Number);
    const rightSegments = right.split(/[^\d]+/).filter(Boolean).map(Number);
    const maxLength = Math.max(leftSegments.length, rightSegments.length);
    for (let index = 0; index < maxLength; index += 1) {
        const leftValue = leftSegments[index] || 0;
        const rightValue = rightSegments[index] || 0;
        if (leftValue !== rightValue) {
            return leftValue - rightValue;
        }
    }

    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function isExistingFile(targetPath: string): boolean {
    try {
        return fs.statSync(targetPath).isFile();
    } catch {
        return false;
    }
}

function normalizePathForCompare(targetPath: string): string {
    const normalized = path.normalize(targetPath.trim());
    return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
}

function getConfigurationTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}

function extractPlatformVersionFromClientPath(clientExePath: string): string | null {
    const normalizedPath = clientExePath.trim();
    if (!normalizedPath) {
        return null;
    }

    const platformDirectory = path.basename(path.dirname(path.dirname(normalizedPath)));
    return /^\d+(?:\.\d+)+$/.test(platformDirectory)
        ? platformDirectory
        : null;
}

function buildDetectedPlatformName(clientExePath: string): string {
    const version = extractPlatformVersionFromClientPath(clientExePath);
    return version
        ? `1C:Enterprise ${version}`
        : path.basename(clientExePath.trim() || '1cv8c.exe');
}

function normalizeConfiguredPlatformEntry(
    entry: RawConfiguredOneCPlatform | ConfiguredOneCPlatform
): ConfiguredOneCPlatform | null {
    const clientExePathSource = typeof entry.clientExePath === 'string'
        ? entry.clientExePath
        : (typeof entry.path === 'string' ? entry.path : '');
    const clientExePath = normalizeOneCClientExePath(clientExePathSource);
    if (!clientExePath) {
        return null;
    }

    const normalizedName = typeof entry.name === 'string'
        ? entry.name.trim()
        : '';

    return {
        name: normalizedName || buildDetectedPlatformName(clientExePath),
        clientExePath
    };
}

function dedupePlatforms(platforms: ConfiguredOneCPlatform[]): ConfiguredOneCPlatform[] {
    const uniquePlatforms = new Map<string, ConfiguredOneCPlatform>();
    for (const platform of platforms) {
        const normalizedPlatform = normalizeConfiguredPlatformEntry(platform);
        if (!normalizedPlatform) {
            continue;
        }

        const pathKey = normalizePathForCompare(normalizedPlatform.clientExePath);
        if (!uniquePlatforms.has(pathKey)) {
            uniquePlatforms.set(pathKey, normalizedPlatform);
        }
    }

    return Array.from(uniquePlatforms.values());
}

function findPlatformIndexByPath(platforms: ConfiguredOneCPlatform[], clientExePath: string): number {
    const lookupKey = normalizePathForCompare(clientExePath);
    return platforms.findIndex(platform => normalizePathForCompare(platform.clientExePath) === lookupKey);
}

function arePlatformsEqual(left: ConfiguredOneCPlatform[], right: ConfiguredOneCPlatform[]): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((platform, index) => {
        const rightPlatform = right[index];
        return !!rightPlatform
            && platform.name === rightPlatform.name
            && normalizePathForCompare(platform.clientExePath) === normalizePathForCompare(rightPlatform.clientExePath);
    });
}

function createConfiguredPlatform(clientExePath: string, name?: string): ConfiguredOneCPlatform {
    const platform = normalizeConfiguredPlatformEntry({ name, clientExePath });
    if (!platform) {
        throw new Error('1C platform path cannot be empty.');
    }

    return platform;
}

function mergeDetectedPlatforms(
    existingPlatforms: readonly ConfiguredOneCPlatform[],
    detectedPlatforms: readonly ConfiguredOneCPlatform[]
): ConfiguredOneCPlatform[] {
    const mergedPlatforms = [...existingPlatforms];
    for (const detectedPlatform of detectedPlatforms) {
        if (findPlatformIndexByPath(mergedPlatforms, detectedPlatform.clientExePath) !== -1) {
            continue;
        }

        mergedPlatforms.push(detectedPlatform);
    }

    return mergedPlatforms;
}

function movePlatformToFront(platforms: ConfiguredOneCPlatform[], index: number): ConfiguredOneCPlatform[] {
    const targetPlatform = platforms[index];
    if (!targetPlatform) {
        return platforms;
    }

    return [
        targetPlatform,
        ...platforms.filter((_, currentIndex) => currentIndex !== index)
    ];
}

function getConfiguredOneCPlatformsFromCatalog(
    config: vscode.WorkspaceConfiguration
): ConfiguredOneCPlatform[] {
    const configuredPlatforms = config.get<Array<RawConfiguredOneCPlatform>>(PLATFORMS_CONFIG_KEY) || [];
    return dedupePlatforms(configuredPlatforms);
}

function showPlatformConfigurationError(t: Translator, message: string): void {
    const managePlatformsAction = t('Manage platforms');
    const openSettingsAction = t('Open Settings');

    void vscode.window.showErrorMessage(
        message,
        managePlatformsAction,
        openSettingsAction
    ).then(selection => {
        if (selection === managePlatformsAction) {
            void vscode.commands.executeCommand('kotTestToolkit.managePlatforms');
            return;
        }

        if (selection === openSettingsAction) {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'kotTestToolkit.platforms.catalog');
        }
    });
}

function listWindowsPlatformCandidates(): string[] {
    const candidates: string[] = [];

    for (const installRoot of WINDOWS_1C_INSTALL_ROOTS) {
        if (!fs.existsSync(installRoot)) {
            continue;
        }

        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(installRoot, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const clientExePath = path.join(installRoot, entry.name, 'bin', '1cv8c.exe');
            if (isExistingFile(clientExePath)) {
                candidates.push(clientExePath);
            }
        }
    }

    return candidates.sort((leftPath, rightPath) => {
        const leftVersion = path.basename(path.dirname(path.dirname(leftPath)));
        const rightVersion = path.basename(path.dirname(path.dirname(rightPath)));
        return compareVersionSegments(rightVersion, leftVersion);
    });
}

async function promptForRequiredString(
    prompt: string,
    value: string,
    validationMessage: string,
    placeHolder?: string
): Promise<string | undefined> {
    const result = await vscode.window.showInputBox({
        prompt,
        value,
        placeHolder,
        ignoreFocusOut: true,
        validateInput: currentValue => currentValue?.trim() ? null : validationMessage
    });

    return result === undefined ? undefined : result.trim();
}

async function promptForPlatformName(
    t: Translator,
    initialValue: string
): Promise<string | undefined> {
    return promptForRequiredString(
        t('Enter 1C platform name'),
        initialValue,
        t('1C platform name cannot be empty')
    );
}

async function promptForPlatformClientPath(
    t: Translator,
    initialValue: string
): Promise<string | undefined> {
    const pathValue = await promptForRequiredString(
        t('Enter path to 1cv8c.exe'),
        initialValue,
        t('Path to 1cv8c.exe cannot be empty'),
        t('For example, C:\\Program Files\\1cv8\\8.3.25.1234\\bin\\1cv8c.exe')
    );

    return pathValue === undefined
        ? undefined
        : normalizeOneCClientExePath(pathValue);
}

function buildPlatformManagerQuickPickItems(
    t: Translator,
    platforms: readonly ConfiguredOneCPlatform[]
): PlatformManagerQuickPickItem[] {
    return [
        ...platforms.map((platform, index) => {
            const detailParts: string[] = [];
            if (index === 0) {
                detailParts.push(t('Default'));
            }
            if (!fs.existsSync(platform.clientExePath)) {
                detailParts.push(t('Client executable not found on disk.'));
            }

            return {
                label: platform.name,
                description: platform.clientExePath,
                detail: detailParts.join(' • ') || undefined,
                entryKind: 'platform' as const,
                clientExePath: platform.clientExePath
            };
        }),
        {
            label: t('Add platform'),
            detail: t('Create a new 1C platform entry'),
            entryKind: 'add' as const
        }
    ];
}

async function showPlatformManagerQuickPick(
    t: Translator,
    platforms: readonly ConfiguredOneCPlatform[]
): Promise<PlatformManagerQuickPickItem | 'rescan' | undefined> {
    return await new Promise<PlatformManagerQuickPickItem | 'rescan' | undefined>(resolve => {
        const quickPick = vscode.window.createQuickPick<PlatformManagerQuickPickItem>();
        const refreshButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('refresh'),
            tooltip: t('Rescan installed platforms')
        };
        let settled = false;

        const finalize = (value: PlatformManagerQuickPickItem | 'rescan' | undefined, shouldHide: boolean) => {
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

        quickPick.title = t('1C platforms');
        quickPick.placeHolder = t('Manage available 1C platforms');
        quickPick.ignoreFocusOut = true;
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.items = buildPlatformManagerQuickPickItems(t, platforms);
        quickPick.buttons = [refreshButton];
        quickPick.onDidAccept(() => finalize(quickPick.selectedItems[0], true));
        quickPick.onDidTriggerButton(button => {
            if (button === refreshButton) {
                finalize('rescan', true);
            }
        });
        quickPick.onDidHide(() => finalize(undefined, false));
        quickPick.show();
    });
}

async function rescanInstalledPlatforms(
    t: Translator,
    existingPlatforms: readonly ConfiguredOneCPlatform[]
): Promise<ConfiguredOneCPlatform[]> {
    const detectedPlatforms = await detectInstalledOneCPlatforms();
    if (detectedPlatforms.length === 0) {
        void vscode.window.showInformationMessage(t('No installed 1C platforms were found in standard locations.'));
        return [...existingPlatforms];
    }

    const mergedPlatforms = mergeDetectedPlatforms(existingPlatforms, detectedPlatforms);
    if (arePlatformsEqual(mergedPlatforms, [...existingPlatforms])) {
        void vscode.window.showInformationMessage(t('Platform rescan finished. No new platforms were added.'));
        return [...existingPlatforms];
    }

    const savedPlatforms = await saveConfiguredOneCPlatforms(mergedPlatforms);
    const addedPlatformsCount = Math.max(savedPlatforms.length - existingPlatforms.length, 0);
    void vscode.window.showInformationMessage(
        t('Platform rescan finished. Added {0} new platform(s).', String(addedPlatformsCount))
    );
    return savedPlatforms;
}

export function normalizeOneCClientExePath(oneCConfiguredPath: string): string {
    const trimmedPath = oneCConfiguredPath.trim();
    if (!trimmedPath) {
        return '';
    }

    const lowerFileName = path.basename(trimmedPath).toLowerCase();
    if (lowerFileName === '1cv8.exe') {
        const siblingClientPath = path.join(path.dirname(trimmedPath), '1cv8c.exe');
        if (fs.existsSync(siblingClientPath)) {
            return siblingClientPath;
        }
    }

    return trimmedPath;
}

export async function detectInstalledOneCPlatforms(): Promise<ConfiguredOneCPlatform[]> {
    if (process.platform !== 'win32') {
        return [];
    }

    return listWindowsPlatformCandidates().map(clientExePath => createConfiguredPlatform(clientExePath));
}

export async function detectInstalledOneCClientExePath(): Promise<string | null> {
    const candidates = await detectInstalledOneCPlatforms();
    return candidates[0]?.clientExePath || null;
}

export function getConfiguredOneCPlatforms(
    config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('kotTestToolkit')
): ConfiguredOneCPlatform[] {
    return getConfiguredOneCPlatformsFromCatalog(config);
}

export async function saveConfiguredOneCPlatforms(
    platforms: ConfiguredOneCPlatform[]
): Promise<ConfiguredOneCPlatform[]> {
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const target = getConfigurationTarget();
    const normalizedPlatforms = dedupePlatforms(platforms);
    const currentCatalogPlatforms = getConfiguredOneCPlatformsFromCatalog(config);

    if (!arePlatformsEqual(currentCatalogPlatforms, normalizedPlatforms)) {
        await config.update(
            PLATFORMS_CONFIG_KEY,
            normalizedPlatforms.map(platform => ({
                name: platform.name,
                clientExePath: platform.clientExePath
            })),
            target
        );
    }

    return normalizedPlatforms;
}

export async function ensureOneCPlatformsCatalogInitialized(): Promise<ConfiguredOneCPlatform[]> {
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const catalogPlatforms = getConfiguredOneCPlatformsFromCatalog(config);

    if (catalogPlatforms.length > 0) {
        return catalogPlatforms;
    }

    const nextPlatforms = await detectInstalledOneCPlatforms();
    if (nextPlatforms.length === 0) {
        return [];
    }

    return saveConfiguredOneCPlatforms(nextPlatforms);
}

export async function resolveOneCPlatformForLaunch(
    t: Translator,
    options?: ResolveOneCPlatformForLaunchOptions
): Promise<ConfiguredOneCPlatform | null> {
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const configuredPlatforms = await ensureOneCPlatformsCatalogInitialized();
    if (configuredPlatforms.length === 0) {
        showPlatformConfigurationError(
            t,
            t('No 1C platforms are configured. Configure them in settings or open the platform manager.')
        );
        return null;
    }

    const shouldPromptUser = options?.forcePicker
        || (options?.promptUser ?? config.get<boolean>(PROMPT_FOR_LAUNCHES_CONFIG_KEY, true));
    if (!shouldPromptUser || configuredPlatforms.length === 1) {
        return configuredPlatforms[0];
    }

    const pickedPlatform = await vscode.window.showQuickPick(
        configuredPlatforms.map((platform, index) => {
            const detailParts: string[] = [];
            if (index === 0) {
                detailParts.push(t('Default'));
            }
            if (!fs.existsSync(platform.clientExePath)) {
                detailParts.push(t('Client executable not found on disk.'));
            }

            return {
                label: platform.name,
                description: platform.clientExePath,
                detail: detailParts.join(' • ') || undefined,
                platform
            };
        }),
        {
            title: options?.title || t('1C platform'),
            placeHolder: options?.placeHolder || t('Select 1C platform'),
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true
        }
    );

    return pickedPlatform?.platform || null;
}

export async function handleManagePlatforms(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    let platforms = await ensureOneCPlatformsCatalogInitialized();

    while (true) {
        const pickedItem = await showPlatformManagerQuickPick(t, platforms);

        if (!pickedItem) {
            return;
        }

        if (pickedItem === 'rescan') {
            platforms = await rescanInstalledPlatforms(t, platforms);
            continue;
        }

        if (pickedItem.entryKind === 'add') {
            const clientExePath = await promptForPlatformClientPath(t, '');
            if (clientExePath === undefined) {
                continue;
            }

            if (findPlatformIndexByPath(platforms, clientExePath) !== -1) {
                vscode.window.showErrorMessage(t('1C platform with client path "{0}" already exists.', clientExePath));
                continue;
            }

            const defaultName = buildDetectedPlatformName(clientExePath);
            const name = await promptForPlatformName(t, defaultName);
            if (name === undefined) {
                continue;
            }

            platforms = await saveConfiguredOneCPlatforms([
                ...platforms,
                createConfiguredPlatform(clientExePath, name)
            ]);
            continue;
        }

        const currentIndex = findPlatformIndexByPath(platforms, pickedItem.clientExePath);
        if (currentIndex === -1) {
            continue;
        }

        const currentPlatform = platforms[currentIndex];
        const action = await vscode.window.showQuickPick(
            [
                {
                    label: t('Set as default'),
                    detail: t('Move this platform to the first position in the list.'),
                    action: 'makeDefault' as const
                },
                {
                    label: t('Edit name'),
                    detail: t('Change the display name of this 1C platform.'),
                    action: 'editName' as const
                },
                {
                    label: t('Edit path'),
                    detail: t('Change the path to 1cv8c.exe for this 1C platform.'),
                    action: 'editPath' as const
                },
                {
                    label: t('Delete'),
                    detail: t('Remove this 1C platform from the list.'),
                    action: 'delete' as const
                }
            ],
            {
                title: t('1C platforms'),
                placeHolder: t('Choose action for 1C platform "{0}"', currentPlatform.name),
                ignoreFocusOut: true
            }
        );

        if (!action) {
            continue;
        }

        if (action.action === 'makeDefault') {
            if (currentIndex > 0) {
                platforms = await saveConfiguredOneCPlatforms(movePlatformToFront(platforms, currentIndex));
            }
            continue;
        }

        if (action.action === 'editName') {
            const updatedName = await promptForPlatformName(t, currentPlatform.name);
            if (updatedName === undefined) {
                continue;
            }

            platforms = await saveConfiguredOneCPlatforms(platforms.map((platform, index) =>
                index === currentIndex
                    ? { ...platform, name: updatedName }
                    : platform
            ));
            continue;
        }

        if (action.action === 'editPath') {
            const updatedClientPath = await promptForPlatformClientPath(t, currentPlatform.clientExePath);
            if (updatedClientPath === undefined) {
                continue;
            }

            const duplicateIndex = findPlatformIndexByPath(platforms, updatedClientPath);
            if (duplicateIndex !== -1 && duplicateIndex !== currentIndex) {
                vscode.window.showErrorMessage(t('1C platform with client path "{0}" already exists.', updatedClientPath));
                continue;
            }

            const currentAutoName = buildDetectedPlatformName(currentPlatform.clientExePath);
            const nextAutoName = buildDetectedPlatformName(updatedClientPath);
            const nextName = currentPlatform.name === currentAutoName
                ? nextAutoName
                : currentPlatform.name;

            platforms = await saveConfiguredOneCPlatforms(platforms.map((platform, index) =>
                index === currentIndex
                    ? { name: nextName, clientExePath: updatedClientPath }
                    : platform
            ));
            continue;
        }

        if (platforms.length === 1) {
            vscode.window.showWarningMessage(t('At least one 1C platform must remain in the list.'));
            continue;
        }

        platforms = await saveConfiguredOneCPlatforms(platforms.filter((_, index) => index !== currentIndex));
    }
}

export function resolveOneCDesignerExePath(oneCClientExePath: string): string {
    const trimmedPath = oneCClientExePath.trim();
    if (!trimmedPath) {
        return trimmedPath;
    }

    const fileName = path.basename(trimmedPath).toLowerCase();
    if (fileName === '1cv8.exe') {
        return trimmedPath;
    }

    if (fileName === '1cv8c.exe') {
        return path.join(path.dirname(trimmedPath), '1cv8.exe');
    }

    return path.join(path.dirname(trimmedPath), '1cv8.exe');
}

export function resolveOneCIBCmdExePath(oneCClientExePath: string): string {
    const trimmedPath = oneCClientExePath.trim();
    if (!trimmedPath) {
        return trimmedPath;
    }

    return path.join(path.dirname(trimmedPath), process.platform === 'win32' ? 'ibcmd.exe' : 'ibcmd');
}

export function resolveOneCClientExePath(oneCConfiguredPath: string): string {
    return normalizeOneCClientExePath(oneCConfiguredPath);
}
