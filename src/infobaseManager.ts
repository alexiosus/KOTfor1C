import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getFormExplorerBuilderPaths } from './formExplorerBuilder';
import { getFormExplorerSnapshotPath } from './formExplorerPaths';
import { parseFormExplorerSnapshotText } from './formExplorerTypes';
import {
    discoverLauncherInfobases,
    registerInfobaseInLauncher,
    updateInfobaseInLauncher,
    unregisterInfobaseFromLauncher
} from './infobasePicker';
import { getTranslator, type Translator } from './localization';
import {
    buildFileInfobaseConnectionArgument,
    buildInfobaseConnectionArgument,
    coerceInfobaseConnection,
    describeInfobaseConnection,
    getFileInfobasePath,
    normalizeInfobaseConnectionIdentity,
    normalizeInfobaseReference,
    type OneCInfobaseConnection
} from './oneCInfobaseConnection';
import { resolveOneCDesignerExePath } from './oneCPlatform';
import { getSharedStartupInfobasePaths } from './startupInfobase';

const INFOBASE_MANAGER_OUTPUT_CHANNEL_NAME = 'KOT Infobase Manager';
const INFOBASE_MANAGER_METADATA_KEY = 'infobaseManager.metadataByPath';
const INFOBASE_MANAGER_MANUAL_ENTRIES_KEY = 'infobaseManager.manualEntries';
const RUN_VANESSA_CUSTOM_INFOBASE_KEY = 'runVanessa.customInfobaseByScenario';
const INFOBASE_MARKER_FILE_NAME = '1Cv8.1CD';

export type ManagedInfobaseKind = OneCInfobaseConnection['kind'];
export type ManagedInfobaseRole = 'startup' | 'vanessa' | 'formExplorer' | 'snapshot';
export type ManagedInfobaseSource = 'launcher' | 'runtime' | 'manual' | 'snapshot' | 'workspaceState';
export type ManagedInfobaseState = 'ready' | 'empty' | 'dirty' | 'missing';
export type ManagedInfobaseStateHint = Exclude<ManagedInfobaseState, 'missing'>;
export type ManagedInfobaseLogKind = 'file' | 'directory';
export type ManagedInfobaseStartupParametersMode = 'none' | 'inherit' | 'custom';

export interface ManagedInfobaseLogTarget {
    label: string;
    targetPath: string;
    kind: ManagedInfobaseLogKind;
    description: string;
    exists: boolean;
}

export interface ManagedInfobaseRecord {
    id: string;
    infobaseKind: ManagedInfobaseKind;
    infobasePath: string;
    locationLabel: string;
    displayName: string;
    launcherName: string | null;
    launcherRegistered: boolean;
    exists: boolean;
    markerExists: boolean;
    state: ManagedInfobaseState;
    roles: ManagedInfobaseRole[];
    sources: ManagedInfobaseSource[];
    lastLaunchAt: string | null;
    lastLaunchKind: string | null;
    lastSnapshotPath: string | null;
    lastSnapshotAt: string | null;
    lastRunLogPath: string | null;
    lastRunLogAt: string | null;
    startupParametersMode: ManagedInfobaseStartupParametersMode;
    startupParameters: string | null;
    logTargets: ManagedInfobaseLogTarget[];
}

export interface ManagedInfobaseSelectionOptions {
    allowBuildOnly?: boolean;
    allowCreateNew?: boolean;
    placeHolder?: string;
    preferredInfobasePath?: string | null;
    allowedKinds?: ManagedInfobaseKind[];
}

export interface PromptNewInfobaseTargetResult {
    infobasePath: string;
    launcherRegistrationName: string;
}

export interface ManagedInfobaseMetadataPatch {
    displayName?: string | null;
    lastLaunchAt?: string | null;
    lastLaunchKind?: string | null;
    lastSnapshotPath?: string | null;
    lastSnapshotAt?: string | null;
    lastRunLogPath?: string | null;
    lastRunLogAt?: string | null;
    startupParametersMode?: ManagedInfobaseStartupParametersMode | null;
    startupParameters?: string | null;
    addRoles?: ManagedInfobaseRole[];
    stateHint?: ManagedInfobaseStateHint | null;
}

interface StoredManagedInfobaseMetadata {
    infobasePath: string;
    displayName?: string;
    lastLaunchAt?: string;
    lastLaunchKind?: string;
    lastSnapshotPath?: string;
    lastSnapshotAt?: string;
    lastRunLogPath?: string;
    lastRunLogAt?: string;
    startupParametersMode?: ManagedInfobaseStartupParametersMode;
    startupParameters?: string;
    roles?: ManagedInfobaseRole[];
    stateHint?: ManagedInfobaseStateHint;
}

interface StoredManualInfobaseEntry {
    infobasePath: string;
    displayName?: string;
    addedAt?: string;
}

interface SnapshotObservation {
    infobasePath: string;
    displayName: string | null;
    snapshotPath: string;
    snapshotAt: string;
}

interface InfobaseAuthentication {
    username: string;
    password: string;
}

interface MutableManagedInfobaseRecord {
    id: string;
    infobaseKind: ManagedInfobaseKind;
    infobasePath: string;
    locationLabel: string;
    launcherName: string | null;
    launcherRegistered: boolean;
    displayNameHints: Set<string>;
    roles: Set<ManagedInfobaseRole>;
    sources: Set<ManagedInfobaseSource>;
    lastLaunchAt: string | null;
    lastLaunchKind: string | null;
    lastSnapshotPath: string | null;
    lastSnapshotAt: string | null;
    lastRunLogPath: string | null;
    lastRunLogAt: string | null;
    startupParametersMode: ManagedInfobaseStartupParametersMode;
    startupParameters: string | null;
    stateHint: ManagedInfobaseStateHint | null;
}

let outputChannel: vscode.OutputChannel | null = null;
const INFOBASE_AUTH_CACHE = new Map<string, InfobaseAuthentication>();

function getWorkspaceRootPath(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function getInfobaseManagerOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel(INFOBASE_MANAGER_OUTPUT_CHANNEL_NAME);
    }

    return outputChannel;
}

function normalizePathForCompare(rawPath: string): string {
    return normalizeInfobaseConnectionIdentity(rawPath);
}

function normalizeInfobaseReferenceValue(rawValue: string): string {
    return normalizeInfobaseReference(rawValue);
}

function getInfobaseKind(rawValue: string): ManagedInfobaseKind {
    return coerceInfobaseConnection(rawValue).kind;
}

function getInfobaseLocationLabel(rawValue: string): string {
    return describeInfobaseConnection(rawValue);
}

function getFileInfobaseDirectory(rawValue: string): string | null {
    return getFileInfobasePath(rawValue);
}

function isFileInfobaseReference(rawValue: string): boolean {
    return getInfobaseKind(rawValue) === 'file';
}

function getInfobaseDisplayNameFallback(rawValue: string): string {
    const fileInfobasePath = getFileInfobaseDirectory(rawValue);
    if (fileInfobasePath) {
        return path.basename(fileInfobasePath) || fileInfobasePath;
    }

    return getInfobaseLocationLabel(rawValue) || rawValue;
}

function getInfobaseFileStem(rawValue: string, displayName?: string | null): string {
    const preferredName = sanitizeDisplayName(displayName || '');
    const baseName = preferredName || getInfobaseDisplayNameFallback(rawValue) || 'infobase';
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_');
    return sanitized || 'infobase';
}

function getInfobaseDefaultArtifactDirectory(rawValue: string, workspaceRootPath: string): string {
    const fileInfobasePath = getFileInfobaseDirectory(rawValue);
    return fileInfobasePath
        ? path.dirname(fileInfobasePath)
        : workspaceRootPath;
}

function resolveWorkspaceRelativePath(rawPath: string, workspaceRootPath: string | null): string {
    const trimmedPath = rawPath.trim();
    if (!trimmedPath) {
        return trimmedPath;
    }

    if (path.isAbsolute(trimmedPath) || !workspaceRootPath) {
        return path.resolve(trimmedPath);
    }

    return path.resolve(workspaceRootPath, trimmedPath);
}

function compareTimestampIso(left: string | null, right: string | null): number {
    const leftValue = left ? Date.parse(left) : 0;
    const rightValue = right ? Date.parse(right) : 0;
    return leftValue - rightValue;
}

function keepLatestTimestamp(current: string | null, candidate: string | null): string | null {
    if (!candidate) {
        return current;
    }
    if (!current) {
        return candidate;
    }
    return compareTimestampIso(current, candidate) >= 0 ? current : candidate;
}

function isTruthyText(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.promises.access(targetPath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function directoryExists(targetPath: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(targetPath)).isDirectory();
    } catch {
        return false;
    }
}

async function readUtf8File(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf8');
}

async function ensureDirectory(directoryPath: string): Promise<void> {
    await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function copyDirectoryContents(
    sourcePath: string,
    destinationPath: string
): Promise<void> {
    await ensureDirectory(destinationPath);
    const entries = await fs.promises.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
        await fs.promises.cp(
            path.join(sourcePath, entry.name),
            path.join(destinationPath, entry.name),
            {
                recursive: true,
                force: false,
                errorOnExist: true
            }
        );
    }
}

async function getDirectoryEntryCount(directoryPath: string): Promise<number> {
    try {
        const entries = await fs.promises.readdir(directoryPath);
        return entries.length;
    } catch {
        return 0;
    }
}

function sanitizeDisplayName(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeStartupParameters(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.replace(/[\r\n]+/g, ' ').trim();
    return normalized || null;
}

function normalizeStartupParametersMode(
    value: string | null | undefined,
    startupParameters?: string | null
): ManagedInfobaseStartupParametersMode {
    if (value === 'none' || value === 'inherit' || value === 'custom') {
        return value;
    }

    return sanitizeStartupParameters(startupParameters) ? 'custom' : 'none';
}

function splitCommandLineArguments(rawValue: string | null | undefined): string[] {
    const source = sanitizeStartupParameters(rawValue);
    if (!source) {
        return [];
    }

    const result: string[] = [];
    let current = '';
    let quote: '"' | '\'' | null = null;

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];

        if (char === '\\' && quote && index + 1 < source.length) {
            current += source[index + 1];
            index += 1;
            continue;
        }

        if ((char === '"' || char === '\'') && (!quote || quote === char)) {
            quote = quote === char ? null : char;
            continue;
        }

        if (!quote && /\s/.test(char)) {
            if (current) {
                result.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current) {
        result.push(current);
    }

    return result;
}

function stripDialogSuppressionArgs(args: string[]): string[] {
    return args.filter(arg => {
        const normalized = arg.trim().toLowerCase();
        return normalized !== '/disablestartupdialogs' && normalized !== '/disablestartupmessages';
    });
}

function getStoredMetadataMap(context: vscode.ExtensionContext): Record<string, StoredManagedInfobaseMetadata> {
    return context.workspaceState.get<Record<string, StoredManagedInfobaseMetadata>>(INFOBASE_MANAGER_METADATA_KEY, {});
}

async function saveStoredMetadataMap(
    context: vscode.ExtensionContext,
    value: Record<string, StoredManagedInfobaseMetadata>
): Promise<void> {
    await context.workspaceState.update(INFOBASE_MANAGER_METADATA_KEY, value);
}

function getStoredManualEntries(context: vscode.ExtensionContext): StoredManualInfobaseEntry[] {
    const rawEntries = context.workspaceState.get<StoredManualInfobaseEntry[]>(INFOBASE_MANAGER_MANUAL_ENTRIES_KEY, []);
    return Array.isArray(rawEntries)
        ? rawEntries.filter(entry => isTruthyText(entry?.infobasePath))
        : [];
}

async function saveStoredManualEntries(
    context: vscode.ExtensionContext,
    entries: StoredManualInfobaseEntry[]
): Promise<void> {
    await context.workspaceState.update(INFOBASE_MANAGER_MANUAL_ENTRIES_KEY, entries);
}

async function saveRunVanessaCustomInfobaseMap(
    context: vscode.ExtensionContext,
    value: Record<string, string>
): Promise<void> {
    await context.workspaceState.update(RUN_VANESSA_CUSTOM_INFOBASE_KEY, value);
}

function getStoredManagedInfobaseMetadata(
    context: vscode.ExtensionContext,
    infobasePath: string
): StoredManagedInfobaseMetadata | null {
    const trimmedPath = infobasePath.trim();
    if (!trimmedPath) {
        return null;
    }

    const metadataMap = getStoredMetadataMap(context);
    return metadataMap[normalizePathForCompare(trimmedPath)] || null;
}

function getConfiguredGlobalStartupParameters(): string | null {
    return sanitizeStartupParameters(
        vscode.workspace.getConfiguration('kotTestToolkit').get<string>('startupParams.parameters')
        || ''
    );
}

export function getManagedInfobaseStartupParameters(
    context: vscode.ExtensionContext,
    infobasePath: string
): string | null {
    const storedMetadata = getStoredManagedInfobaseMetadata(context, infobasePath);
    const mode = normalizeStartupParametersMode(
        storedMetadata?.startupParametersMode,
        storedMetadata?.startupParameters
    );
    if (mode === 'inherit') {
        return getConfiguredGlobalStartupParameters();
    }
    if (mode === 'custom') {
        return sanitizeStartupParameters(storedMetadata?.startupParameters);
    }
    return null;
}

export function getManagedInfobaseStartupParametersMode(
    context: vscode.ExtensionContext,
    infobasePath: string
): ManagedInfobaseStartupParametersMode {
    const storedMetadata = getStoredManagedInfobaseMetadata(context, infobasePath);
    return normalizeStartupParametersMode(
        storedMetadata?.startupParametersMode,
        storedMetadata?.startupParameters
    );
}

export function getManagedInfobaseStartupParameterArgs(
    context: vscode.ExtensionContext,
    infobasePath: string,
    options?: { allowDialogSuppression?: boolean }
): string[] {
    const startupArgs = splitCommandLineArguments(getManagedInfobaseStartupParameters(context, infobasePath));
    return options?.allowDialogSuppression === false
        ? stripDialogSuppressionArgs(startupArgs)
        : startupArgs;
}

async function removeManagedInfobaseMetadata(
    context: vscode.ExtensionContext,
    infobasePath: string
): Promise<void> {
    const metadataMap = getStoredMetadataMap(context);
    const metadataKey = normalizePathForCompare(infobasePath);
    if (!(metadataKey in metadataMap)) {
        return;
    }

    delete metadataMap[metadataKey];
    await saveStoredMetadataMap(context, metadataMap);
}

function mergeMetadataEntries(
    currentEntry: StoredManagedInfobaseMetadata | null,
    nextEntry: StoredManagedInfobaseMetadata
): StoredManagedInfobaseMetadata {
    const mergedEntry: StoredManagedInfobaseMetadata = {
        ...(currentEntry || {}),
        ...nextEntry
    };

    mergedEntry.roles = mergeRoles(currentEntry?.roles, nextEntry.roles || []);
    mergedEntry.lastLaunchAt = keepLatestTimestamp(currentEntry?.lastLaunchAt || null, nextEntry.lastLaunchAt || null) || undefined;
    mergedEntry.lastSnapshotAt = keepLatestTimestamp(currentEntry?.lastSnapshotAt || null, nextEntry.lastSnapshotAt || null) || undefined;
    mergedEntry.lastRunLogAt = keepLatestTimestamp(currentEntry?.lastRunLogAt || null, nextEntry.lastRunLogAt || null) || undefined;
    mergedEntry.startupParametersMode = normalizeStartupParametersMode(
        nextEntry.startupParametersMode || currentEntry?.startupParametersMode || null,
        nextEntry.startupParameters || currentEntry?.startupParameters || null
    );
    mergedEntry.startupParameters = sanitizeStartupParameters(nextEntry.startupParameters)
        || sanitizeStartupParameters(currentEntry?.startupParameters)
        || undefined;
    return mergedEntry;
}

async function moveManagedInfobaseReferences(
    context: vscode.ExtensionContext,
    currentInfobasePath: string,
    nextInfobasePath: string
): Promise<void> {
    const resolvedCurrentPath = normalizeInfobaseReferenceValue(currentInfobasePath);
    const resolvedNextPath = normalizeInfobaseReferenceValue(nextInfobasePath);
    const currentKey = normalizePathForCompare(resolvedCurrentPath);
    const nextKey = normalizePathForCompare(resolvedNextPath);
    if (currentKey === nextKey) {
        return;
    }

    const metadataMap = getStoredMetadataMap(context);
    const currentMetadata = metadataMap[currentKey] || null;
    const nextMetadata = metadataMap[nextKey] || null;
    if (currentMetadata) {
        delete metadataMap[currentKey];
        metadataMap[nextKey] = mergeMetadataEntries(nextMetadata, {
            ...currentMetadata,
            infobasePath: resolvedNextPath
        });
        await saveStoredMetadataMap(context, metadataMap);
    }

    const manualEntries = getStoredManualEntries(context);
    let manualEntriesChanged = false;
    const nextManualEntries = manualEntries.map(entry => {
        if (normalizePathForCompare(entry.infobasePath) !== currentKey) {
            return entry;
        }

        manualEntriesChanged = true;
        return {
            ...entry,
            infobasePath: resolvedNextPath
        };
    });
    if (manualEntriesChanged) {
        await saveStoredManualEntries(context, nextManualEntries);
    }

    const customInfobaseMap = getRunVanessaCustomInfobaseMap(context);
    let customInfobaseMapChanged = false;
    for (const [scenarioName, configuredPath] of Object.entries(customInfobaseMap)) {
        if (normalizePathForCompare(configuredPath) !== currentKey) {
            continue;
        }

        customInfobaseMap[scenarioName] = resolvedNextPath;
        customInfobaseMapChanged = true;
    }
    if (customInfobaseMapChanged) {
        await saveRunVanessaCustomInfobaseMap(context, customInfobaseMap);
    }

    const cachedAuthentication = INFOBASE_AUTH_CACHE.get(currentKey);
    if (cachedAuthentication) {
        INFOBASE_AUTH_CACHE.set(nextKey, cachedAuthentication);
        INFOBASE_AUTH_CACHE.delete(currentKey);
    }
}

async function purgeManagedInfobaseReferences(
    context: vscode.ExtensionContext,
    infobasePath: string
): Promise<void> {
    await removeManagedInfobaseMetadata(context, infobasePath);
    await forgetManualInfobase(context, infobasePath);

    const customInfobaseMap = getRunVanessaCustomInfobaseMap(context);
    let customInfobaseMapChanged = false;
    const normalizedTargetPath = normalizePathForCompare(infobasePath);
    for (const [scenarioName, configuredPath] of Object.entries(customInfobaseMap)) {
        if (normalizePathForCompare(configuredPath) !== normalizedTargetPath) {
            continue;
        }

        delete customInfobaseMap[scenarioName];
        customInfobaseMapChanged = true;
    }
    if (customInfobaseMapChanged) {
        await saveRunVanessaCustomInfobaseMap(context, customInfobaseMap);
    }

    INFOBASE_AUTH_CACHE.delete(normalizedTargetPath);
}

function getRunVanessaCustomInfobaseMap(context: vscode.ExtensionContext): Record<string, string> {
    return context.workspaceState.get<Record<string, string>>(RUN_VANESSA_CUSTOM_INFOBASE_KEY, {});
}

function mergeRoles(
    existingRoles: ManagedInfobaseRole[] | undefined,
    additionalRoles: readonly ManagedInfobaseRole[]
): ManagedInfobaseRole[] {
    const roleSet = new Set<ManagedInfobaseRole>(existingRoles || []);
    for (const role of additionalRoles) {
        roleSet.add(role);
    }

    const order: ManagedInfobaseRole[] = ['startup', 'vanessa', 'formExplorer', 'snapshot'];
    return order.filter(role => roleSet.has(role));
}

export async function rememberManualInfobase(
    context: vscode.ExtensionContext,
    infobasePath: string,
    displayName?: string | null
): Promise<void> {
    const trimmedPath = infobasePath.trim();
    if (!trimmedPath) {
        return;
    }

    const normalizedPath = normalizeInfobaseReferenceValue(trimmedPath);
    const manualEntries = getStoredManualEntries(context);
    const normalizedKey = normalizePathForCompare(normalizedPath);
    const existingEntryIndex = manualEntries.findIndex(entry =>
        normalizePathForCompare(entry.infobasePath) === normalizedKey
    );

    const nextEntry: StoredManualInfobaseEntry = {
        infobasePath: normalizedPath,
        displayName: isTruthyText(displayName) ? sanitizeDisplayName(displayName) : undefined,
        addedAt: new Date().toISOString()
    };

    if (existingEntryIndex >= 0) {
        manualEntries[existingEntryIndex] = {
            ...manualEntries[existingEntryIndex],
            ...nextEntry
        };
    } else {
        manualEntries.push(nextEntry);
    }

    await saveStoredManualEntries(context, manualEntries);
}

async function updateManualInfobaseDisplayNameIfPresent(
    context: vscode.ExtensionContext,
    infobasePath: string,
    displayName?: string | null
): Promise<void> {
    const normalizedPath = normalizeInfobaseReferenceValue(infobasePath.trim());
    const manualEntries = getStoredManualEntries(context);
    const normalizedKey = normalizePathForCompare(normalizedPath);
    const existingEntryIndex = manualEntries.findIndex(entry =>
        normalizePathForCompare(entry.infobasePath) === normalizedKey
    );
    if (existingEntryIndex < 0) {
        return;
    }

    manualEntries[existingEntryIndex] = {
        ...manualEntries[existingEntryIndex],
        displayName: isTruthyText(displayName) ? sanitizeDisplayName(displayName) : undefined
    };
    await saveStoredManualEntries(context, manualEntries);
}

export async function forgetManualInfobase(
    context: vscode.ExtensionContext,
    infobasePath: string
): Promise<void> {
    const normalizedKey = normalizePathForCompare(infobasePath);
    const manualEntries = getStoredManualEntries(context)
        .filter(entry => normalizePathForCompare(entry.infobasePath) !== normalizedKey);
    await saveStoredManualEntries(context, manualEntries);
}

export async function forgetManagedInfobase(
    context: vscode.ExtensionContext,
    infobasePath: string
): Promise<void> {
    await purgeManagedInfobaseReferences(context, infobasePath);
    INFOBASE_AUTH_CACHE.delete(normalizePathForCompare(infobasePath));
}

export async function updateManagedInfobaseMetadata(
    context: vscode.ExtensionContext,
    infobasePath: string,
    patch: ManagedInfobaseMetadataPatch
): Promise<void> {
    const trimmedPath = infobasePath.trim();
    if (!trimmedPath) {
        return;
    }

    const resolvedPath = normalizeInfobaseReferenceValue(trimmedPath);
    const metadataMap = getStoredMetadataMap(context);
    const metadataKey = normalizePathForCompare(resolvedPath);
    const currentEntry = metadataMap[metadataKey] || { infobasePath: resolvedPath };
    const nextEntry: StoredManagedInfobaseMetadata = {
        ...currentEntry,
        infobasePath: resolvedPath
    };

    if (patch.displayName !== undefined) {
        if (isTruthyText(patch.displayName)) {
            nextEntry.displayName = sanitizeDisplayName(patch.displayName);
        } else {
            delete nextEntry.displayName;
        }
    }

    if (patch.lastLaunchAt !== undefined) {
        if (isTruthyText(patch.lastLaunchAt)) {
            nextEntry.lastLaunchAt = patch.lastLaunchAt;
        } else {
            delete nextEntry.lastLaunchAt;
        }
    }

    if (patch.lastLaunchKind !== undefined) {
        if (isTruthyText(patch.lastLaunchKind)) {
            nextEntry.lastLaunchKind = patch.lastLaunchKind;
        } else {
            delete nextEntry.lastLaunchKind;
        }
    }

    if (patch.lastSnapshotPath !== undefined) {
        if (isTruthyText(patch.lastSnapshotPath)) {
            nextEntry.lastSnapshotPath = path.resolve(patch.lastSnapshotPath);
        } else {
            delete nextEntry.lastSnapshotPath;
        }
    }

    if (patch.lastSnapshotAt !== undefined) {
        if (isTruthyText(patch.lastSnapshotAt)) {
            nextEntry.lastSnapshotAt = patch.lastSnapshotAt;
        } else {
            delete nextEntry.lastSnapshotAt;
        }
    }

    if (patch.lastRunLogPath !== undefined) {
        if (isTruthyText(patch.lastRunLogPath)) {
            nextEntry.lastRunLogPath = path.resolve(patch.lastRunLogPath);
        } else {
            delete nextEntry.lastRunLogPath;
        }
    }

    if (patch.lastRunLogAt !== undefined) {
        if (isTruthyText(patch.lastRunLogAt)) {
            nextEntry.lastRunLogAt = patch.lastRunLogAt;
        } else {
            delete nextEntry.lastRunLogAt;
        }
    }

    if (patch.startupParametersMode !== undefined) {
        if (patch.startupParametersMode) {
            nextEntry.startupParametersMode = patch.startupParametersMode;
        } else {
            delete nextEntry.startupParametersMode;
        }
    }

    if (patch.startupParameters !== undefined) {
        const normalizedStartupParameters = sanitizeStartupParameters(patch.startupParameters);
        if (normalizedStartupParameters) {
            nextEntry.startupParameters = normalizedStartupParameters;
        } else {
            delete nextEntry.startupParameters;
        }
    }

    nextEntry.startupParametersMode = normalizeStartupParametersMode(
        nextEntry.startupParametersMode,
        nextEntry.startupParameters
    );

    if (patch.addRoles && patch.addRoles.length > 0) {
        nextEntry.roles = mergeRoles(nextEntry.roles, patch.addRoles);
    }

    if (patch.stateHint !== undefined) {
        if (patch.stateHint) {
            nextEntry.stateHint = patch.stateHint;
        } else {
            delete nextEntry.stateHint;
        }
    }

    metadataMap[metadataKey] = nextEntry;
    await saveStoredMetadataMap(context, metadataMap);
}

async function collectSnapshotObservations(): Promise<SnapshotObservation[]> {
    const configuredSnapshotPath = getFormExplorerSnapshotPath();
    if (!configuredSnapshotPath) {
        return [];
    }

    const normalizedConfiguredPath = path.resolve(configuredSnapshotPath);
    const candidatePaths = new Set<string>([normalizedConfiguredPath]);
    const configuredDirectory = path.dirname(normalizedConfiguredPath);
    const configuredFileName = path.basename(normalizedConfiguredPath);
    const configuredPrefix = `${configuredFileName}.`;

    try {
        const directoryEntries = await fs.promises.readdir(configuredDirectory, { withFileTypes: true });
        for (const entry of directoryEntries) {
            if (!entry.isFile()) {
                continue;
            }

            if (entry.name !== configuredFileName && !entry.name.startsWith(configuredPrefix)) {
                continue;
            }

            candidatePaths.add(path.join(configuredDirectory, entry.name));
        }
    } catch {
        // Ignore missing snapshot directory and only use explicit configured path.
    }

    const observations: SnapshotObservation[] = [];
    for (const candidatePath of candidatePaths) {
        try {
            const [rawText, stat] = await Promise.all([
                readUtf8File(candidatePath),
                fs.promises.stat(candidatePath)
            ]);
            const parsedSnapshot = parseFormExplorerSnapshotText(rawText);
            const snapshotSourceInfobase = typeof parsedSnapshot.source?.infobase === 'string'
                ? parsedSnapshot.source.infobase.trim()
                : '';
            if (!snapshotSourceInfobase) {
                continue;
            }

            observations.push({
                infobasePath: normalizeInfobaseReferenceValue(snapshotSourceInfobase),
                displayName: typeof parsedSnapshot.source?.infobaseName === 'string' && parsedSnapshot.source.infobaseName.trim()
                    ? parsedSnapshot.source.infobaseName.trim()
                    : null,
                snapshotPath: path.resolve(candidatePath),
                snapshotAt: stat.mtime.toISOString()
            });
        } catch {
            // Ignore unreadable or invalid snapshots.
        }
    }

    return observations;
}

function getVanessaRuntimeDirectory(): string | null {
    const workspaceRootPath = getWorkspaceRootPath();
    const configuredPath = (
        vscode.workspace.getConfiguration('kotTestToolkit.runVanessa').get<string>('runtimeDirectory')
        || '.vscode/kot-runtime/vanessa'
    ).trim();
    if (!configuredPath) {
        return null;
    }

    return resolveWorkspaceRelativePath(configuredPath, workspaceRootPath);
}

function getManagedInfobaseStateOrder(state: ManagedInfobaseState): number {
    const order: ManagedInfobaseState[] = ['ready', 'empty', 'dirty', 'missing'];
    const index = order.indexOf(state);
    return index >= 0 ? index : order.length;
}

function sortManagedInfobaseRoles(roles: Iterable<ManagedInfobaseRole>): ManagedInfobaseRole[] {
    const order: ManagedInfobaseRole[] = ['startup', 'vanessa', 'formExplorer', 'snapshot'];
    const roleSet = new Set<ManagedInfobaseRole>(roles);
    return order.filter(role => roleSet.has(role));
}

function sortManagedInfobaseSources(sources: Iterable<ManagedInfobaseSource>): ManagedInfobaseSource[] {
    const order: ManagedInfobaseSource[] = ['launcher', 'runtime', 'manual', 'snapshot', 'workspaceState'];
    const sourceSet = new Set<ManagedInfobaseSource>(sources);
    return order.filter(source => sourceSet.has(source));
}

function getExistingDisplayNameHint(hints: Set<string>): string | null {
    for (const hint of hints) {
        const normalizedHint = sanitizeDisplayName(hint);
        if (normalizedHint) {
            return normalizedHint;
        }
    }
    return null;
}

async function buildManagedInfobaseLogTargets(
    infobaseKind: ManagedInfobaseKind,
    infobasePath: string,
    roles: ReadonlySet<ManagedInfobaseRole>,
    lastSnapshotPath: string | null,
    lastRunLogPath: string | null
): Promise<ManagedInfobaseLogTarget[]> {
    const result: ManagedInfobaseLogTarget[] = [];
    const seenTargets = new Set<string>();

    const addTarget = async (
        label: string,
        targetPath: string | null,
        kind: ManagedInfobaseLogKind,
        description: string
    ): Promise<void> => {
        if (!targetPath) {
            return;
        }

        const resolvedTargetPath = path.resolve(targetPath);
        const normalizedKey = `${kind}:${normalizePathForCompare(resolvedTargetPath)}`;
        if (seenTargets.has(normalizedKey)) {
            return;
        }

        seenTargets.add(normalizedKey);
        result.push({
            label,
            targetPath: resolvedTargetPath,
            kind,
            description,
            exists: await pathExists(resolvedTargetPath)
        });
    };

    await addTarget('Latest run log', lastRunLogPath, 'file', 'Latest Vanessa or manager operation log linked to this infobase.');
    await addTarget('Latest snapshot', lastSnapshotPath, 'file', 'Latest Form Explorer snapshot linked to this infobase.');

    const startupPaths = getSharedStartupInfobasePaths();
    if (infobaseKind === 'file'
        && startupPaths
        && normalizePathForCompare(startupPaths.infobaseDirectory) === normalizePathForCompare(infobasePath)) {
        await addTarget('Startup infobase logs', startupPaths.logsDirectory, 'directory', 'Shared startup infobase logs.');
    }

    const builderPaths = getFormExplorerBuilderPaths();
    if (infobaseKind === 'file'
        && builderPaths
        && normalizePathForCompare(builderPaths.builderInfobaseDirectory) === normalizePathForCompare(infobasePath)) {
        await addTarget('Form Explorer build logs', builderPaths.logsDirectory, 'directory', 'Form Explorer builder logs.');
    }

    if (roles.has('vanessa')) {
        const runtimeDirectory = getVanessaRuntimeDirectory();
        if (runtimeDirectory) {
            await addTarget(
                'Vanessa infobase setup logs',
                path.join(runtimeDirectory, 'infobase-setup-logs'),
                'directory',
                'Logs of create/restore/update operations for Vanessa target infobases.'
            );
            await addTarget(
                'Vanessa runtime directory',
                runtimeDirectory,
                'directory',
                'Vanessa runtime directory with run logs and auxiliary files.'
            );
        }
    }

    return result;
}

export async function collectManagedInfobases(
    context: vscode.ExtensionContext
): Promise<ManagedInfobaseRecord[]> {
    const metadataMap = getStoredMetadataMap(context);
    const manualEntries = getStoredManualEntries(context);
    const launcherEntries = await discoverLauncherInfobases();
    const snapshotObservations = await collectSnapshotObservations();
    const records = new Map<string, MutableManagedInfobaseRecord>();

    const observeInfobase = (infobasePath: string, options?: {
        displayNameHint?: string | null;
        launcherName?: string | null;
        launcherRegistered?: boolean;
        addRoles?: ManagedInfobaseRole[];
        addSources?: ManagedInfobaseSource[];
        lastLaunchAt?: string | null;
        lastLaunchKind?: string | null;
        lastSnapshotPath?: string | null;
        lastSnapshotAt?: string | null;
        lastRunLogPath?: string | null;
        lastRunLogAt?: string | null;
        startupParametersMode?: ManagedInfobaseStartupParametersMode | null;
        startupParameters?: string | null;
        stateHint?: ManagedInfobaseStateHint | null;
    }): void => {
        const trimmedPath = infobasePath.trim();
        if (!trimmedPath) {
            return;
        }

        const normalizedReference = normalizeInfobaseReferenceValue(trimmedPath);
        const recordKey = normalizePathForCompare(normalizedReference);
        let record = records.get(recordKey);
        if (!record) {
            record = {
                id: recordKey,
                infobaseKind: getInfobaseKind(normalizedReference),
                infobasePath: normalizedReference,
                locationLabel: getInfobaseLocationLabel(normalizedReference),
                launcherName: null,
                launcherRegistered: false,
                displayNameHints: new Set<string>(),
                roles: new Set<ManagedInfobaseRole>(),
                sources: new Set<ManagedInfobaseSource>(),
                lastLaunchAt: null,
                lastLaunchKind: null,
                lastSnapshotPath: null,
                lastSnapshotAt: null,
                lastRunLogPath: null,
                lastRunLogAt: null,
                startupParametersMode: 'none',
                startupParameters: null,
                stateHint: null
            };
            records.set(recordKey, record);
        }

        if (isTruthyText(options?.displayNameHint)) {
            record.displayNameHints.add(sanitizeDisplayName(options.displayNameHint));
        }

        if (isTruthyText(options?.launcherName)) {
            record.launcherName = sanitizeDisplayName(options.launcherName);
        }

        if (options?.launcherRegistered) {
            record.launcherRegistered = true;
        }

        for (const role of options?.addRoles || []) {
            record.roles.add(role);
        }

        for (const source of options?.addSources || []) {
            record.sources.add(source);
        }

        if (options?.lastLaunchAt) {
            const shouldReplaceLastLaunch = !record.lastLaunchAt || compareTimestampIso(record.lastLaunchAt, options.lastLaunchAt) < 0;
            if (shouldReplaceLastLaunch) {
                record.lastLaunchAt = options.lastLaunchAt;
                record.lastLaunchKind = options.lastLaunchKind || record.lastLaunchKind;
            }
        }

        if (options?.lastSnapshotAt) {
            const shouldReplaceSnapshot = !record.lastSnapshotAt || compareTimestampIso(record.lastSnapshotAt, options.lastSnapshotAt) < 0;
            if (shouldReplaceSnapshot) {
                record.lastSnapshotAt = options.lastSnapshotAt;
                record.lastSnapshotPath = options.lastSnapshotPath ? path.resolve(options.lastSnapshotPath) : record.lastSnapshotPath;
            }
        }

        if (options?.lastRunLogAt) {
            const shouldReplaceRunLog = !record.lastRunLogAt || compareTimestampIso(record.lastRunLogAt, options.lastRunLogAt) < 0;
            if (shouldReplaceRunLog) {
                record.lastRunLogAt = options.lastRunLogAt;
                record.lastRunLogPath = options.lastRunLogPath ? path.resolve(options.lastRunLogPath) : record.lastRunLogPath;
            }
        }

        if (options?.startupParameters) {
            record.startupParameters = sanitizeStartupParameters(options.startupParameters) || record.startupParameters;
        }

        if (options?.startupParametersMode) {
            record.startupParametersMode = normalizeStartupParametersMode(
                options.startupParametersMode,
                options.startupParameters || record.startupParameters
            );
        }

        if (options?.stateHint) {
            record.stateHint = options.stateHint;
        }
    };

    for (const launcherEntry of launcherEntries) {
        observeInfobase(launcherEntry.infobasePath, {
            displayNameHint: launcherEntry.name,
            launcherName: launcherEntry.name,
            launcherRegistered: true,
            addSources: ['launcher']
        });
    }

    const startupPaths = getSharedStartupInfobasePaths();
    if (startupPaths) {
        observeInfobase(startupPaths.infobaseDirectory, {
            displayNameHint: 'Shared startup infobase',
            addSources: ['runtime'],
            addRoles: ['startup']
        });
    }

    const builderPaths = getFormExplorerBuilderPaths();
    if (builderPaths) {
        observeInfobase(builderPaths.builderInfobaseDirectory, {
            displayNameHint: 'Form Explorer builder infobase',
            addSources: ['runtime'],
            addRoles: ['formExplorer']
        });
    }

    const vanessaRuntimeDirectory = getVanessaRuntimeDirectory();
    if (vanessaRuntimeDirectory) {
        const runtimeInfobasesDirectory = path.join(vanessaRuntimeDirectory, 'infobases');
        try {
            const entries = await fs.promises.readdir(runtimeInfobasesDirectory, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }

                const infobasePath = path.join(runtimeInfobasesDirectory, entry.name);
                observeInfobase(infobasePath, {
                    displayNameHint: entry.name,
                    addSources: ['runtime'],
                    addRoles: ['vanessa']
                });
            }
        } catch {
            // Ignore missing runtime infobases directory.
        }
    }

    for (const manualEntry of manualEntries) {
        observeInfobase(manualEntry.infobasePath, {
            displayNameHint: manualEntry.displayName || getInfobaseDisplayNameFallback(manualEntry.infobasePath),
            addSources: ['manual']
        });
    }

    for (const configuredInfobasePath of Object.values(getRunVanessaCustomInfobaseMap(context))) {
        if (!isTruthyText(configuredInfobasePath)) {
            continue;
        }

        observeInfobase(configuredInfobasePath, {
            displayNameHint: getInfobaseDisplayNameFallback(configuredInfobasePath),
            addSources: ['workspaceState'],
            addRoles: ['vanessa']
        });
    }

    for (const snapshotObservation of snapshotObservations) {
        observeInfobase(snapshotObservation.infobasePath, {
            displayNameHint: snapshotObservation.displayName,
            addSources: ['snapshot'],
            addRoles: ['snapshot', 'formExplorer'],
            lastSnapshotPath: snapshotObservation.snapshotPath,
            lastSnapshotAt: snapshotObservation.snapshotAt
        });
    }

    for (const metadata of Object.values(metadataMap)) {
        if (!isTruthyText(metadata?.infobasePath)) {
            continue;
        }

        observeInfobase(metadata.infobasePath, {
            displayNameHint: metadata.displayName,
            addSources: ['workspaceState'],
            addRoles: metadata.roles || [],
            lastLaunchAt: metadata.lastLaunchAt || null,
            lastLaunchKind: metadata.lastLaunchKind || null,
            lastSnapshotPath: metadata.lastSnapshotPath || null,
            lastSnapshotAt: metadata.lastSnapshotAt || null,
            lastRunLogPath: metadata.lastRunLogPath || null,
            lastRunLogAt: metadata.lastRunLogAt || null,
            startupParametersMode: normalizeStartupParametersMode(
                metadata.startupParametersMode || null,
                metadata.startupParameters || null
            ),
            startupParameters: metadata.startupParameters || null,
            stateHint: metadata.stateHint || null
        });
    }

    const finalizedRecords: ManagedInfobaseRecord[] = [];
    for (const record of records.values()) {
        const fileInfobasePath = getFileInfobaseDirectory(record.infobasePath);
        const exists = fileInfobasePath
            ? await directoryExists(fileInfobasePath)
            : true;
        const markerExists = fileInfobasePath
            ? exists && await pathExists(path.join(fileInfobasePath, INFOBASE_MARKER_FILE_NAME))
            : false;
        let state: ManagedInfobaseState;
        if (record.infobaseKind !== 'file') {
            state = record.stateHint || 'ready';
        } else if (!exists) {
            state = 'missing';
        } else if (markerExists) {
            state = record.stateHint || 'ready';
        } else {
            state = (await getDirectoryEntryCount(fileInfobasePath!)) === 0 ? 'empty' : 'dirty';
        }

        const displayName = record.launcherName
            || getExistingDisplayNameHint(record.displayNameHints)
            || record.locationLabel
            || record.infobasePath;
        const roles = sortManagedInfobaseRoles(record.roles);
        const logTargets = await buildManagedInfobaseLogTargets(
            record.infobaseKind,
            record.infobasePath,
            record.roles,
            record.lastSnapshotPath,
            record.lastRunLogPath
        );

        finalizedRecords.push({
            id: record.id,
            infobaseKind: record.infobaseKind,
            infobasePath: record.infobasePath,
            locationLabel: record.locationLabel,
            displayName,
            launcherName: record.launcherName,
            launcherRegistered: record.launcherRegistered,
            exists,
            markerExists,
            state,
            roles,
            sources: sortManagedInfobaseSources(record.sources),
            lastLaunchAt: record.lastLaunchAt,
            lastLaunchKind: record.lastLaunchKind,
            lastSnapshotPath: record.lastSnapshotPath,
            lastSnapshotAt: record.lastSnapshotAt,
            lastRunLogPath: record.lastRunLogPath,
            lastRunLogAt: record.lastRunLogAt,
            startupParametersMode: record.startupParametersMode,
            startupParameters: record.startupParameters,
            logTargets
        });
    }

    finalizedRecords.sort((left, right) => {
        const lastActivityLeft = keepLatestTimestamp(
            keepLatestTimestamp(left.lastLaunchAt, left.lastSnapshotAt),
            left.lastRunLogAt
        );
        const lastActivityRight = keepLatestTimestamp(
            keepLatestTimestamp(right.lastLaunchAt, right.lastSnapshotAt),
            right.lastRunLogAt
        );
        const byActivity = compareTimestampIso(lastActivityRight, lastActivityLeft);
        if (byActivity !== 0) {
            return byActivity;
        }

        const byState = getManagedInfobaseStateOrder(left.state) - getManagedInfobaseStateOrder(right.state);
        if (byState !== 0) {
            return byState;
        }

        const byName = left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
        if (byName !== 0) {
            return byName;
        }

        return left.infobasePath.localeCompare(right.infobasePath, undefined, { sensitivity: 'base' });
    });

    return finalizedRecords;
}

export function validateNewInfobasePath(t: Translator, targetPath: string): string | null {
    const trimmedPath = targetPath.trim();
    if (!trimmedPath) {
        return t('Infobase path cannot be empty.');
    }

    const resolvedPath = path.resolve(trimmedPath);
    const parentDirectory = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDirectory)) {
        return t('Parent directory does not exist: {0}', parentDirectory);
    }

    if (fs.existsSync(resolvedPath)) {
        const stat = fs.statSync(resolvedPath);
        if (!stat.isDirectory()) {
            return t('Target infobase path must be a directory: {0}', resolvedPath);
        }
        if (fs.existsSync(path.join(resolvedPath, INFOBASE_MARKER_FILE_NAME))) {
            return t('Infobase already exists at path: {0}', resolvedPath);
        }
        if (fs.readdirSync(resolvedPath).length > 0) {
            return t('Directory for new infobase must be empty: {0}', resolvedPath);
        }
    }

    return null;
}

export async function promptNewInfobaseTarget(
    context: vscode.ExtensionContext,
    t: Translator,
    options?: {
        defaultName?: string;
        defaultDirectoryPath?: string | null;
        chooseFolderTitle?: string;
        launcherNameTitle?: string;
    }
): Promise<PromptNewInfobaseTargetResult | null> {
    const workspaceRootPath = getWorkspaceRootPath() || process.cwd();
    const dialogPathCandidates = [
        options?.defaultDirectoryPath || '',
        workspaceRootPath
    ].filter(Boolean);
    const initialDirectory = dialogPathCandidates.find(candidate => {
        if (!candidate) {
            return false;
        }
        try {
            return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
        } catch {
            return false;
        }
    }) || workspaceRootPath;

    const chooseAnotherFolderLabel = t('Choose another folder');
    let currentDefaultUri = vscode.Uri.file(initialDirectory);

    while (true) {
        const pickedFolder = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: options?.chooseFolderTitle || t('Choose folder for new infobase'),
            openLabel: t('Use this folder'),
            defaultUri: currentDefaultUri
        });
        if (!pickedFolder || pickedFolder.length === 0) {
            return null;
        }

        const selectedInfobasePath = path.resolve(pickedFolder[0].fsPath);
        const validationError = validateNewInfobasePath(t, selectedInfobasePath);
        if (!validationError) {
            const launcherName = await vscode.window.showInputBox({
                title: options?.launcherNameTitle || t('Enter name for new infobase in 1C launcher'),
                value: sanitizeDisplayName(options?.defaultName || path.basename(selectedInfobasePath) || 'KOT Infobase'),
                ignoreFocusOut: true,
                validateInput: value => value.trim()
                    ? null
                    : t('Infobase launcher name cannot be empty.')
            });
            if (launcherName === undefined) {
                return null;
            }

            return {
                infobasePath: selectedInfobasePath,
                launcherRegistrationName: sanitizeDisplayName(launcherName)
            };
        }

        currentDefaultUri = vscode.Uri.file(selectedInfobasePath);
        const choice = await vscode.window.showErrorMessage(validationError, chooseAnotherFolderLabel);
        if (choice !== chooseAnotherFolderLabel) {
            return null;
        }
    }
}

function getOutputTail(output: string, maxLength: number = 4000): string {
    const normalizedOutput = output.trim();
    if (!normalizedOutput) {
        return '';
    }

    return normalizedOutput.length <= maxLength
        ? normalizedOutput
        : normalizedOutput.slice(-maxLength);
}

function formatCommandForOutput(exePath: string, args: string[]): string {
    return [exePath, ...args]
        .map(part => `"${part}"`)
        .join(' ');
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

async function promptInfobaseAuthentication(
    t: Translator,
    initialAuthentication: InfobaseAuthentication | null,
    retryMode: boolean
): Promise<InfobaseAuthentication | undefined> {
    const username = await vscode.window.showInputBox({
        title: retryMode
            ? t('Infobase authentication failed. Enter infobase login')
            : t('Enter infobase login'),
        placeHolder: t('Example: Administrator'),
        value: (initialAuthentication?.username || '').trim() || 'Administrator',
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

async function resolveConfiguredOneCDesignerExePath(
    t: Translator
): Promise<string> {
    if (process.platform !== 'win32') {
        throw new Error(t('1C Designer operations are supported only on Windows.'));
    }

    const configuredClientPath = (
        vscode.workspace.getConfiguration('kotTestToolkit').get<string>('paths.oneCEnterpriseExe')
        || ''
    ).trim();
    if (!configuredClientPath) {
        throw new Error(t('Path to 1C:Enterprise client (1cv8c.exe) is not specified in settings.'));
    }
    if (!fs.existsSync(configuredClientPath)) {
        throw new Error(t('1C:Enterprise client file not found at path: {0}', configuredClientPath));
    }

    const designerPath = resolveOneCDesignerExePath(configuredClientPath);
    if (!designerPath || !fs.existsSync(designerPath)) {
        throw new Error(t('1C Designer executable was not found next to client path: {0}', configuredClientPath));
    }

    return designerPath;
}

async function resolveConfiguredOneCClientExePath(
    t: Translator
): Promise<string> {
    if (process.platform !== 'win32') {
        throw new Error(t('1C client launch is supported only on Windows.'));
    }

    const configuredClientPath = (
        vscode.workspace.getConfiguration('kotTestToolkit').get<string>('paths.oneCEnterpriseExe')
        || ''
    ).trim();
    if (!configuredClientPath) {
        throw new Error(t('Path to 1C:Enterprise client (1cv8c.exe) is not specified in settings.'));
    }
    if (!fs.existsSync(configuredClientPath)) {
        throw new Error(t('1C:Enterprise client file not found at path: {0}', configuredClientPath));
    }

    return configuredClientPath;
}

async function runOneCCommand(
    exePath: string,
    args: string[],
    cwd: string,
    stepTitle: string,
    outFilePath: string,
    channel: vscode.OutputChannel,
    t: Translator
): Promise<void> {
    const effectiveArgs = [...args, '/Out', outFilePath];
    channel.appendLine(t('Infobase step: {0}', stepTitle));
    channel.appendLine(t('Resolved 1C command: {0}', formatCommandForOutput(exePath, effectiveArgs)));

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
            channel.append(chunk);
        });

        child.stderr?.on('data', data => {
            const chunk = data.toString();
            stderr += chunk;
            channel.append(chunk);
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
                    // Ignore designer log read failures.
                }
            }

            reject(new Error(
                t(
                    '1C command for "{0}" exited with code {1}. Output tail: {2}',
                    stepTitle,
                    String(code ?? 'unknown'),
                    getOutputTail(`${stderr}\n${stdout}\n${designerLog}`) || t('<empty output>')
                )
            ));
        });
    });
}

async function runInfobaseDesignerCommandWithAuthRetry(
    t: Translator,
    designerExePath: string,
    infobasePath: string,
    args: string[],
    cwd: string,
    stepTitle: string,
    outFilePath: string,
    channel: vscode.OutputChannel
): Promise<void> {
    const authCacheKey = normalizePathForCompare(infobasePath);
    let authentication = INFOBASE_AUTH_CACHE.get(authCacheKey) || null;

    for (;;) {
        try {
            await runOneCCommand(
                designerExePath,
                appendInfobaseAuthenticationArgs(args, authentication),
                cwd,
                stepTitle,
                outFilePath,
                channel,
                t
            );
            if (authentication) {
                INFOBASE_AUTH_CACHE.set(authCacheKey, authentication);
            } else {
                INFOBASE_AUTH_CACHE.delete(authCacheKey);
            }
            return;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isInfobaseAuthenticationError(message)) {
                throw error;
            }

            INFOBASE_AUTH_CACHE.delete(authCacheKey);
            channel.appendLine(t('Infobase authentication is required for this operation. Requesting credentials.'));
            const providedAuthentication = await promptInfobaseAuthentication(t, authentication, authentication !== null);
            if (!providedAuthentication) {
                throw new Error(t('Operation was cancelled because infobase authentication credentials were not provided.'));
            }

            authentication = providedAuthentication;
            channel.appendLine(t('Retrying infobase operation using user "{0}".', authentication.username));
        }
    }
}

async function launchOneCDetached(
    exePath: string,
    args: string[],
    channel: vscode.OutputChannel,
    t: Translator,
    infobasePath: string
): Promise<void> {
    const workspaceRootPath = getWorkspaceRootPath() || process.cwd();
    channel.appendLine(t('Launching 1C process for infobase: {0}', infobasePath));
    channel.appendLine(t('Resolved 1C command: {0}', formatCommandForOutput(exePath, args)));

    await new Promise<void>((resolve, reject) => {
        try {
            const child = cp.spawn(exePath, args, {
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

async function clearInfobaseDirectoryContents(infobasePath: string): Promise<void> {
    const entries = await fs.promises.readdir(infobasePath, { withFileTypes: true });
    for (const entry of entries) {
        await fs.promises.rm(path.join(infobasePath, entry.name), { recursive: true, force: true });
    }
}

async function moveDirectoryWithFallback(
    sourcePath: string,
    destinationPath: string
): Promise<void> {
    try {
        await fs.promises.rename(sourcePath, destinationPath);
        return;
    } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error
            ? String((error as NodeJS.ErrnoException).code || '')
            : '';
        if (code !== 'EXDEV') {
            throw error;
        }
    }

    await fs.promises.cp(sourcePath, destinationPath, {
        recursive: true,
        force: false,
        errorOnExist: true
    });
    await fs.promises.rm(sourcePath, { recursive: true, force: true });
}

function validateInfobaseMoveTarget(
    t: Translator,
    currentInfobasePath: string,
    nextInfobasePath: string
): string | null {
    const resolvedCurrentPath = path.resolve(currentInfobasePath);
    const resolvedNextPath = path.resolve(nextInfobasePath);
    if (normalizePathForCompare(resolvedCurrentPath) === normalizePathForCompare(resolvedNextPath)) {
        return t('Choose a different target directory for the infobase.');
    }

    const targetParentDirectory = path.dirname(resolvedNextPath);
    if (!fs.existsSync(targetParentDirectory)) {
        return t('Parent directory does not exist: {0}', targetParentDirectory);
    }

    if (fs.existsSync(resolvedNextPath)) {
        return t('Target directory already exists: {0}', resolvedNextPath);
    }

    return null;
}

function validateExistingInfobaseReassignmentTarget(
    t: Translator,
    currentInfobasePath: string,
    nextInfobasePath: string
): string | null {
    const resolvedCurrentPath = path.resolve(currentInfobasePath);
    const resolvedNextPath = path.resolve(nextInfobasePath);
    if (normalizePathForCompare(resolvedCurrentPath) === normalizePathForCompare(resolvedNextPath)) {
        return t('Choose a different target directory for the infobase.');
    }

    if (!fs.existsSync(resolvedNextPath)) {
        return t('Target infobase path does not exist: {0}', resolvedNextPath);
    }

    const targetStat = fs.statSync(resolvedNextPath);
    if (!targetStat.isDirectory()) {
        return t('Target infobase path must be a directory: {0}', resolvedNextPath);
    }

    if (!fs.existsSync(path.join(resolvedNextPath, INFOBASE_MARKER_FILE_NAME))) {
        return t('Selected directory does not look like a ready file infobase: {0}', resolvedNextPath);
    }

    return null;
}

async function assertInfobaseNotBusy(
    infobasePath: string,
    t: Translator
): Promise<void> {
    const fileInfobasePath = getFileInfobaseDirectory(infobasePath);
    if (!fileInfobasePath) {
        return;
    }

    const markerPath = path.join(fileInfobasePath, INFOBASE_MARKER_FILE_NAME);
    if (!(await pathExists(markerPath))) {
        return;
    }

    const probePath = `${markerPath}.kot-busy-check`;
    let movedMarker = false;
    try {
        await fs.promises.rename(markerPath, probePath);
        movedMarker = true;
    } catch {
        throw new Error(t('Infobase appears to be in use and cannot be modified right now: {0}', fileInfobasePath));
    } finally {
        if (movedMarker) {
            try {
                await fs.promises.rename(probePath, markerPath);
            } catch {
                // Best-effort rollback.
            }
        }
    }
}

function assertFileInfobaseRecord(
    t: Translator,
    infobase: ManagedInfobaseRecord,
    operationTitle: string
): string {
    const fileInfobasePath = getFileInfobaseDirectory(infobase.infobasePath);
    if (fileInfobasePath) {
        return fileInfobasePath;
    }

    throw new Error(t('"{0}" is available only for file-based infobases.', operationTitle));
}

function assertNonWebInfobaseReference(
    t: Translator,
    infobasePath: string,
    operationTitle: string
): void {
    if (getInfobaseKind(infobasePath) === 'web') {
        throw new Error(t('"{0}" is not supported for web infobases.', operationTitle));
    }
}

function assertNonWebInfobaseRecord(
    t: Translator,
    infobase: ManagedInfobaseRecord,
    operationTitle: string
): void {
    assertNonWebInfobaseReference(t, infobase.infobasePath, operationTitle);
}

export async function createInfobaseWithLauncherRegistration(
    context: vscode.ExtensionContext,
    infobasePath: string,
    launcherRegistrationName: string,
    options?: { addRoles?: ManagedInfobaseRole[]; progressTitle?: string; }
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const workspaceRootPath = getWorkspaceRootPath() || process.cwd();
    const designerExePath = await resolveConfiguredOneCDesignerExePath(t);
    const output = getInfobaseManagerOutputChannel();
    const logsDirectory = path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'infobase-manager', 'logs');
    await ensureDirectory(logsDirectory);
    await ensureDirectory(path.dirname(infobasePath));

    const safeBaseName = path.basename(infobasePath).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'infobase';
    const logPath = path.join(logsDirectory, `${Date.now()}-${safeBaseName}-create.log`);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: options?.progressTitle || t('Creating infobase...'),
            cancellable: false
        },
        async progress => {
            progress.report({ message: t('Creating file infobase...') });
            await ensureDirectory(infobasePath);
            await runOneCCommand(
                designerExePath,
                ['CREATEINFOBASE', buildFileInfobaseConnectionArgument(infobasePath, { trailingSemicolon: true })],
                workspaceRootPath,
                t('Create infobase'),
                logPath,
                output,
                t
            );
            progress.report({ message: t('Registering infobase in 1C launcher...') });
            await registerInfobaseInLauncher(infobasePath, launcherRegistrationName);
        }
    );

    await rememberManualInfobase(context, infobasePath, launcherRegistrationName);
    await updateManagedInfobaseMetadata(context, infobasePath, {
        displayName: launcherRegistrationName,
        addRoles: options?.addRoles || [],
        stateHint: 'empty'
    });
}

export async function createInfobaseInteractive(
    context: vscode.ExtensionContext,
    options?: { defaultName?: string; defaultDirectoryPath?: string | null; addRoles?: ManagedInfobaseRole[]; }
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    const creationTarget = await promptNewInfobaseTarget(context, t, {
        defaultName: options?.defaultName,
        defaultDirectoryPath: options?.defaultDirectoryPath || null
    });
    if (!creationTarget) {
        return null;
    }

    await createInfobaseWithLauncherRegistration(
        context,
        creationTarget.infobasePath,
        creationTarget.launcherRegistrationName,
        {
            addRoles: options?.addRoles || []
        }
    );

    return creationTarget.infobasePath;
}

function getManagedInfobaseStateHint(record: ManagedInfobaseRecord): ManagedInfobaseStateHint | null {
    if (record.state === 'ready' || record.state === 'empty' || record.state === 'dirty') {
        return record.state;
    }

    return null;
}

export async function copyInfobaseInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    const fileInfobasePath = assertFileInfobaseRecord(t, infobase, t('Copy infobase'));
    if (!infobase.exists) {
        throw new Error(t('Infobase directory does not exist and cannot be copied: {0}', fileInfobasePath));
    }

    const sourceDisplayName = sanitizeDisplayName(
        infobase.launcherName
        || infobase.displayName
        || getInfobaseDisplayNameFallback(fileInfobasePath)
        || 'KOT Infobase'
    );
    const copyTarget = await promptNewInfobaseTarget(context, t, {
        defaultName: t('Copy of {0}', sourceDisplayName),
        defaultDirectoryPath: path.dirname(fileInfobasePath),
        chooseFolderTitle: t('Choose folder for copied infobase'),
        launcherNameTitle: t('Enter name for copied infobase in 1C launcher')
    });
    if (!copyTarget) {
        return null;
    }

    await assertInfobaseNotBusy(fileInfobasePath, t);
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Copying infobase...'),
            cancellable: false
        },
        async progress => {
            progress.report({ message: t('Copying infobase files...') });
            await ensureDirectory(path.dirname(copyTarget.infobasePath));
            await copyDirectoryContents(fileInfobasePath, copyTarget.infobasePath);

            progress.report({ message: t('Registering copied infobase in 1C launcher...') });
            await registerInfobaseInLauncher(copyTarget.infobasePath, copyTarget.launcherRegistrationName);
        }
    );

    await rememberManualInfobase(context, copyTarget.infobasePath, copyTarget.launcherRegistrationName);
    await updateManagedInfobaseMetadata(context, copyTarget.infobasePath, {
        displayName: copyTarget.launcherRegistrationName,
        startupParametersMode: infobase.startupParametersMode,
        startupParameters: infobase.startupParameters,
        stateHint: getManagedInfobaseStateHint(infobase)
    });

    return copyTarget.infobasePath;
}

export async function exportInfobaseToDtInteractive(
    context: vscode.ExtensionContext,
    infobasePath: string
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    assertNonWebInfobaseReference(t, infobasePath, t('Export DT'));
    const designerExePath = await resolveConfiguredOneCDesignerExePath(t);
    const workspaceRootPath = getWorkspaceRootPath() || process.cwd();
    const output = getInfobaseManagerOutputChannel();
    const defaultUri = vscode.Uri.file(path.join(
        getInfobaseDefaultArtifactDirectory(infobasePath, workspaceRootPath),
        `${getInfobaseFileStem(infobasePath)}.dt`
    ));
    const selectedTarget = await vscode.window.showSaveDialog({
        title: t('Choose target DT file'),
        saveLabel: t('Export DT'),
        defaultUri,
        filters: {
            [t('1C DT files (*.dt)')]: ['dt']
        }
    });
    if (!selectedTarget) {
        return null;
    }

    const targetDtPath = path.resolve(selectedTarget.fsPath);
    const logsDirectory = path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'infobase-manager', 'logs');
    await ensureDirectory(logsDirectory);
    const logPath = path.join(
        logsDirectory,
        `${Date.now()}-${getInfobaseFileStem(infobasePath)}-dump-dt.log`
    );
    const designerArgs = [
        'DESIGNER',
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/IBConnectionString',
        buildInfobaseConnectionArgument(infobasePath),
        '/DumpIB',
        targetDtPath
    ];

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Exporting infobase to DT...'),
            cancellable: false
        },
        async () => {
            await runInfobaseDesignerCommandWithAuthRetry(
                t,
                designerExePath,
                infobasePath,
                designerArgs,
                workspaceRootPath,
                t('Export infobase to DT'),
                logPath,
                output
            );
        }
    );

    return targetDtPath;
}

export async function exportInfobaseConfigurationToCfInteractive(
    context: vscode.ExtensionContext,
    infobasePath: string
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    assertNonWebInfobaseReference(t, infobasePath, t('Save CF'));
    const designerExePath = await resolveConfiguredOneCDesignerExePath(t);
    const workspaceRootPath = getWorkspaceRootPath() || process.cwd();
    const output = getInfobaseManagerOutputChannel();
    const defaultUri = vscode.Uri.file(path.join(
        getInfobaseDefaultArtifactDirectory(infobasePath, workspaceRootPath),
        `${getInfobaseFileStem(infobasePath)}.cf`
    ));
    const selectedTarget = await vscode.window.showSaveDialog({
        title: t('Choose target CF file'),
        saveLabel: t('Save CF'),
        defaultUri,
        filters: {
            [t('1C configuration files (*.cf)')]: ['cf']
        }
    });
    if (!selectedTarget) {
        return null;
    }

    const targetCfPath = path.resolve(selectedTarget.fsPath);
    const logsDirectory = path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'infobase-manager', 'logs');
    await ensureDirectory(logsDirectory);
    const logPath = path.join(
        logsDirectory,
        `${Date.now()}-${getInfobaseFileStem(infobasePath)}-dump-cfg.log`
    );
    const designerArgs = [
        'DESIGNER',
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/IBConnectionString',
        buildInfobaseConnectionArgument(infobasePath),
        '/DumpCfg',
        targetCfPath
    ];

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Saving infobase configuration to CF...'),
            cancellable: false
        },
        async () => {
            await runInfobaseDesignerCommandWithAuthRetry(
                t,
                designerExePath,
                infobasePath,
                designerArgs,
                workspaceRootPath,
                t('Save infobase configuration to CF'),
                logPath,
                output
            );
        }
    );

    return targetCfPath;
}

export async function recreateInfobaseInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const fileInfobasePath = assertFileInfobaseRecord(t, infobase, t('Recreate infobase'));
    const confirmation = await vscode.window.showWarningMessage(
        t('Recreate infobase "{0}" and delete all current files?', infobase.displayName),
        { modal: true },
        t('Recreate')
    );
    if (confirmation !== t('Recreate')) {
        return;
    }

    const backupMode = await vscode.window.showQuickPick(
        [
            {
                label: t('No backup DT'),
                detail: t('Delete infobase contents without exporting a backup DT first.'),
                modeKey: 'skip' as const
            },
            {
                label: t('Backup to DT before recreate'),
                detail: t('Export a DT backup before deleting infobase contents.'),
                modeKey: 'backup' as const
            }
        ],
        {
            title: t('Backup infobase "{0}" before recreate?', infobase.displayName),
            ignoreFocusOut: true
        }
    );
    if (!backupMode) {
        return;
    }

    const tBackupPath = backupMode.modeKey === 'backup'
        ? await exportInfobaseToDtInteractive(context, infobase.infobasePath)
        : null;
    if (backupMode.modeKey === 'backup' && !tBackupPath) {
        return;
    }

    await assertInfobaseNotBusy(fileInfobasePath, t);

    const designerExePath = await resolveConfiguredOneCDesignerExePath(t);
    const workspaceRootPath = getWorkspaceRootPath() || process.cwd();
    const output = getInfobaseManagerOutputChannel();
    const logsDirectory = path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'infobase-manager', 'logs');
    await ensureDirectory(logsDirectory);
    const safeBaseName = getInfobaseFileStem(fileInfobasePath, infobase.displayName);
    const recreateLogPath = path.join(logsDirectory, `${Date.now()}-${safeBaseName}-recreate.log`);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Recreating infobase...'),
            cancellable: false
        },
        async progress => {
            progress.report({ message: t('Deleting existing infobase files...') });
            await clearInfobaseDirectoryContents(fileInfobasePath);

            progress.report({ message: t('Creating fresh infobase...') });
            await ensureDirectory(fileInfobasePath);
            await runOneCCommand(
                designerExePath,
                ['CREATEINFOBASE', buildFileInfobaseConnectionArgument(fileInfobasePath, { trailingSemicolon: true })],
                workspaceRootPath,
                t('Create infobase'),
                recreateLogPath,
                output,
                t
            );

            if (infobase.launcherName) {
                progress.report({ message: t('Refreshing infobase registration in 1C launcher...') });
                await registerInfobaseInLauncher(fileInfobasePath, infobase.launcherName);
            }
        }
    );

    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        displayName: infobase.launcherName || infobase.displayName,
        addRoles: infobase.roles,
        stateHint: 'empty'
    });
}

export async function restoreInfobaseFromDtInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    assertNonWebInfobaseRecord(t, infobase, t('Restore from DT'));
    const selectedFile = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: t('Choose DT file'),
        openLabel: t('Restore DT'),
        filters: {
            [t('1C DT files (*.dt)')]: ['dt']
        }
    });
    if (!selectedFile || selectedFile.length === 0) {
        return;
    }

    await assertInfobaseNotBusy(infobase.infobasePath, t);
    const designerExePath = await resolveConfiguredOneCDesignerExePath(t);
    const workspaceRootPath = getWorkspaceRootPath() || process.cwd();
    const output = getInfobaseManagerOutputChannel();
    const logsDirectory = path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'infobase-manager', 'logs');
    await ensureDirectory(logsDirectory);
    const logPath = path.join(
        logsDirectory,
        `${Date.now()}-${getInfobaseFileStem(infobase.infobasePath, infobase.displayName)}-restore-dt.log`
    );
    const designerArgs = [
        'DESIGNER',
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/IBConnectionString',
        buildInfobaseConnectionArgument(infobase.infobasePath),
        '/RestoreIB',
        path.resolve(selectedFile[0].fsPath)
    ];

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Restoring infobase from DT...'),
            cancellable: false
        },
        async () => {
            await runInfobaseDesignerCommandWithAuthRetry(
                t,
                designerExePath,
                infobase.infobasePath,
                designerArgs,
                workspaceRootPath,
                t('Restore infobase from DT'),
                logPath,
                output
            );
        }
    );

    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        displayName: infobase.launcherName || infobase.displayName,
        addRoles: infobase.roles,
        stateHint: 'ready'
    });
}

export async function updateInfobaseConfigurationInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    assertNonWebInfobaseRecord(t, infobase, t('Update configuration'));
    const workspaceRootPath = getWorkspaceRootPath() || process.cwd();
    const configuredSourceDirectoryRaw = (
        vscode.workspace.getConfiguration('kotTestToolkit').get<string>('formExplorer.configurationSourceDirectory')
        || ''
    ).trim();
    const configuredSourceDirectory = configuredSourceDirectoryRaw
        ? resolveWorkspaceRelativePath(configuredSourceDirectoryRaw, workspaceRootPath)
        : '';

    const selection = await vscode.window.showQuickPick(
        [
            {
                label: t('Update from configured source directory'),
                description: configuredSourceDirectory || t('Configuration source directory is not configured.'),
                detail: t('Load configuration from the directory set in Form Explorer settings and update DB configuration.'),
                modeKey: 'sourceDirectory' as const
            },
            {
                label: t('Update from .cf file'),
                description: infobase.locationLabel,
                detail: t('Choose a custom .cf file and load it into the infobase.'),
                modeKey: 'cfFile' as const
            }
        ],
        {
            title: t('Update configuration for "{0}"', infobase.displayName),
            ignoreFocusOut: true
        }
    );
    if (!selection) {
        return;
    }

    let commandArgs: string[] | null = null;
    let logSuffix = 'update-cfg';
    if (selection.modeKey === 'sourceDirectory') {
        if (!configuredSourceDirectory || !(await directoryExists(configuredSourceDirectory))) {
            throw new Error(
                t('Form Explorer configuration source directory is not configured or not found. Set kotTestToolkit.formExplorer.configurationSourceDirectory.')
            );
        }
        commandArgs = [
            '/LoadConfigFromFiles',
            configuredSourceDirectory,
            '/UpdateDBCfg'
        ];
        logSuffix = 'update-from-source';
    } else {
        const selectedCfFile = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: t('Choose CF file'),
            openLabel: t('Load CF'),
            filters: {
                [t('1C configuration files (*.cf)')]: ['cf']
            }
        });
        if (!selectedCfFile || selectedCfFile.length === 0) {
            return;
        }

        commandArgs = [
            '/LoadCfg',
            path.resolve(selectedCfFile[0].fsPath),
            '/UpdateDBCfg'
        ];
        logSuffix = 'update-from-cf';
    }

    await assertInfobaseNotBusy(infobase.infobasePath, t);
    const designerExePath = await resolveConfiguredOneCDesignerExePath(t);
    const output = getInfobaseManagerOutputChannel();
    const logsDirectory = path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'infobase-manager', 'logs');
    await ensureDirectory(logsDirectory);
    const logPath = path.join(
        logsDirectory,
        `${Date.now()}-${getInfobaseFileStem(infobase.infobasePath, infobase.displayName)}-${logSuffix}.log`
    );
    const designerArgs = [
        'DESIGNER',
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/IBConnectionString',
        buildInfobaseConnectionArgument(infobase.infobasePath),
        ...commandArgs
    ];

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Updating infobase configuration...'),
            cancellable: false
        },
        async () => {
            await runInfobaseDesignerCommandWithAuthRetry(
                t,
                designerExePath,
                infobase.infobasePath,
                designerArgs,
                workspaceRootPath,
                t('Update infobase configuration'),
                logPath,
                output
            );
        }
    );

    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        displayName: infobase.launcherName || infobase.displayName,
        addRoles: infobase.roles,
        stateHint: 'ready'
    });
}

export async function renameInfobaseInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    const nextDisplayName = await vscode.window.showInputBox({
        title: t('Rename infobase'),
        value: infobase.launcherName || infobase.displayName || getInfobaseDisplayNameFallback(infobase.infobasePath) || 'KOT Infobase',
        ignoreFocusOut: true,
        validateInput: value => value.trim()
            ? null
            : t('Infobase name cannot be empty.')
    });
    if (nextDisplayName === undefined) {
        return null;
    }

    const normalizedDisplayName = sanitizeDisplayName(nextDisplayName);
    if (!normalizedDisplayName) {
        return null;
    }

    if (normalizedDisplayName === (infobase.launcherName || infobase.displayName)) {
        return normalizedDisplayName;
    }

    if (infobase.launcherRegistered) {
        const updateResult = await updateInfobaseInLauncher(infobase.infobasePath, {
            preferredName: normalizedDisplayName
        });
        if (updateResult.status === 'notFound') {
            await registerInfobaseInLauncher(infobase.infobasePath, normalizedDisplayName);
        }
    }

    await updateManualInfobaseDisplayNameIfPresent(context, infobase.infobasePath, normalizedDisplayName);
    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        displayName: normalizedDisplayName
    });
    return normalizedDisplayName;
}

export async function configureInfobaseStartupParametersInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    const globalStartupParameters = getConfiguredGlobalStartupParameters();
    const currentStartupParametersMode = infobase.startupParametersMode;
    const selectedMode = await vscode.window.showQuickPick(
        [
            {
                label: t('Do not use launch keys'),
                detail: currentStartupParametersMode === 'none'
                    ? t('Launch this infobase without additional startup parameters.')
                    : t('Clear per-base launch keys and do not apply workspace defaults.'),
                modeKey: 'none' as const
            },
            {
                label: t('Set custom launch keys'),
                detail: infobase.startupParameters || t('No launch keys are configured yet.'),
                modeKey: 'custom' as const
            },
            {
                label: t('Use workspace default launch keys'),
                detail: globalStartupParameters || t('Workspace-level launch keys are empty.'),
                modeKey: 'inherit' as const
            }
        ],
        {
            title: t('Launch keys for "{0}"', infobase.displayName),
            ignoreFocusOut: true
        }
    );
    if (!selectedMode) {
        return null;
    }

    if (selectedMode.modeKey === 'none') {
        await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
            startupParametersMode: 'none',
            startupParameters: null
        });
        return null;
    }

    if (selectedMode.modeKey === 'inherit') {
        await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
            startupParametersMode: 'inherit',
            startupParameters: null
        });
        return null;
    }

    const startupParameters = await vscode.window.showInputBox({
        title: t('Enter launch keys for "{0}"', infobase.displayName),
        value: infobase.startupParameters || globalStartupParameters || '',
        placeHolder: t('Example: /L ru /RunModeOrdinaryApplication'),
        ignoreFocusOut: true
    });
    if (startupParameters === undefined) {
        return null;
    }

    const normalizedStartupParameters = sanitizeStartupParameters(startupParameters);
    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        startupParametersMode: normalizedStartupParameters ? 'custom' : 'none',
        startupParameters: normalizedStartupParameters
    });
    return normalizedStartupParameters;
}

export async function moveInfobaseInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    const fileInfobasePath = assertFileInfobaseRecord(t, infobase, t('Move or rename infobase folder'));
    if (!infobase.exists) {
        throw new Error(t('Infobase directory does not exist and cannot be moved: {0}', fileInfobasePath));
    }

    const selectedParentDirectory = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: t('Choose target parent folder for infobase'),
        openLabel: t('Use this folder'),
        defaultUri: vscode.Uri.file(path.dirname(fileInfobasePath))
    });
    if (!selectedParentDirectory || selectedParentDirectory.length === 0) {
        return null;
    }

    const targetParentDirectory = path.resolve(selectedParentDirectory[0].fsPath);
    const targetFolderName = await vscode.window.showInputBox({
        title: t('Enter target folder name'),
        value: path.basename(fileInfobasePath),
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value.trim();
            if (!trimmedValue) {
                return t('Infobase folder name cannot be empty.');
            }
            return validateInfobaseMoveTarget(
                t,
                fileInfobasePath,
                path.join(targetParentDirectory, trimmedValue)
            );
        }
    });
    if (targetFolderName === undefined) {
        return null;
    }

    const nextInfobasePath = path.resolve(targetParentDirectory, targetFolderName.trim());
    const validationError = validateInfobaseMoveTarget(t, fileInfobasePath, nextInfobasePath);
    if (validationError) {
        throw new Error(validationError);
    }

    await assertInfobaseNotBusy(fileInfobasePath, t);
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Moving infobase...'),
            cancellable: false
        },
        async progress => {
            progress.report({ message: t('Moving infobase files...') });
            await ensureDirectory(path.dirname(nextInfobasePath));
            await moveDirectoryWithFallback(fileInfobasePath, nextInfobasePath);

            progress.report({ message: t('Updating infobase references...') });
            if (infobase.launcherRegistered || infobase.launcherName) {
                const launcherUpdate = await updateInfobaseInLauncher(fileInfobasePath, {
                    nextInfobasePath,
                    preferredName: infobase.launcherName || infobase.displayName
                });
                if (launcherUpdate.status === 'notFound' && infobase.launcherName) {
                    await registerInfobaseInLauncher(nextInfobasePath, infobase.launcherName);
                }
            }
        }
    );

    await moveManagedInfobaseReferences(context, fileInfobasePath, nextInfobasePath);
    await updateManagedInfobaseMetadata(context, nextInfobasePath, {
        displayName: infobase.launcherName || infobase.displayName,
        startupParametersMode: infobase.startupParametersMode,
        startupParameters: infobase.startupParameters,
        addRoles: infobase.roles,
        stateHint: infobase.markerExists
            ? 'ready'
            : (infobase.state === 'empty' ? 'empty' : 'dirty')
    });

    return nextInfobasePath;
}

export async function reassignInfobasePathInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    const fileInfobasePath = assertFileInfobaseRecord(t, infobase, t('Reassign infobase folder'));
    const selectedDirectory = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: t('Choose existing infobase folder to assign'),
        openLabel: t('Use this folder'),
        defaultUri: vscode.Uri.file(path.dirname(fileInfobasePath))
    });
    if (!selectedDirectory || selectedDirectory.length === 0) {
        return null;
    }

    const nextInfobasePath = path.resolve(selectedDirectory[0].fsPath);
    const validationError = validateExistingInfobaseReassignmentTarget(t, fileInfobasePath, nextInfobasePath);
    if (validationError) {
        throw new Error(validationError);
    }

    if (infobase.launcherRegistered || infobase.launcherName) {
        const launcherUpdate = await updateInfobaseInLauncher(fileInfobasePath, {
            nextInfobasePath,
            preferredName: infobase.launcherName || infobase.displayName
        });
        if (launcherUpdate.status === 'notFound' && infobase.launcherName) {
            await registerInfobaseInLauncher(nextInfobasePath, infobase.launcherName);
        }
    }

    await moveManagedInfobaseReferences(context, fileInfobasePath, nextInfobasePath);
    await updateManagedInfobaseMetadata(context, nextInfobasePath, {
        displayName: infobase.launcherName || infobase.displayName,
        startupParametersMode: infobase.startupParametersMode,
        startupParameters: infobase.startupParameters,
        addRoles: infobase.roles,
        stateHint: 'ready'
    });

    return nextInfobasePath;
}

export async function deleteInfobaseInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const fileInfobasePath = assertFileInfobaseRecord(t, infobase, t('Delete infobase'));
    const confirmation = await vscode.window.showWarningMessage(
        t('Delete infobase "{0}" completely (files and launcher registration)?', infobase.displayName),
        { modal: true },
        t('Delete infobase')
    );
    if (confirmation !== t('Delete infobase')) {
        return;
    }

    let backupDtPath: string | null = null;
    if (infobase.exists && infobase.markerExists) {
        const backupMode = await vscode.window.showQuickPick(
            [
                {
                    label: t('Delete without DT backup'),
                    detail: t('Remove the infobase files immediately.'),
                    modeKey: 'skip' as const
                },
                {
                    label: t('Export DT backup before delete'),
                    detail: t('Create a DT backup first, then delete the infobase.'),
                    modeKey: 'backup' as const
                }
            ],
            {
                title: t('Backup infobase "{0}" before delete?', infobase.displayName),
                ignoreFocusOut: true
            }
        );
        if (!backupMode) {
            return;
        }
        if (backupMode.modeKey === 'backup') {
            backupDtPath = await exportInfobaseToDtInteractive(context, fileInfobasePath);
            if (!backupDtPath) {
                return;
            }
        }
    }

    if (infobase.exists) {
        await assertInfobaseNotBusy(fileInfobasePath, t);
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Deleting infobase...'),
            cancellable: false
        },
        async progress => {
            progress.report({ message: t('Removing infobase from 1C launcher...') });
            await unregisterInfobaseFromLauncher(infobase.infobasePath);

            if (infobase.exists) {
                progress.report({ message: t('Deleting infobase files...') });
                await fs.promises.rm(fileInfobasePath, { recursive: true, force: true });
            }
        }
    );

    await purgeManagedInfobaseReferences(context, fileInfobasePath);
    if (backupDtPath) {
        vscode.window.showInformationMessage(t('DT backup created before delete: {0}', backupDtPath));
    }
}

export async function editInfobaseInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<string | null> {
    const t = await getTranslator(context.extensionUri);
    const selectionItems: Array<{
        label: string;
        detail: string;
        actionKey: 'rename' | 'move' | 'reassign' | 'startupParameters' | 'delete';
    }> = [
            {
                label: t('Rename infobase'),
                detail: t('Change the display name and update launcher registration if present.'),
                actionKey: 'rename' as const
            },
            {
                label: t('Edit launch keys'),
                detail: t('Set custom 1C startup parameters for this infobase or switch back to workspace defaults.'),
                actionKey: 'startupParameters' as const
            }
        ];
    if (infobase.infobaseKind === 'file') {
        selectionItems.push(
            {
                label: t('Move or rename infobase folder'),
                detail: t('Move the file infobase directory and update launcher/manual references.'),
                actionKey: 'move'
            },
            {
                label: t('Reassign infobase folder'),
                detail: t('Keep the item, but point it to another existing file infobase directory.'),
                actionKey: 'reassign'
            },
            {
                label: t('Delete infobase'),
                detail: t('Delete files and remove the infobase from 1C launcher.'),
                actionKey: 'delete'
            }
        );
    }
    const selection = await vscode.window.showQuickPick(
        selectionItems,
        {
            title: t('Edit "{0}"', infobase.displayName),
            ignoreFocusOut: true
        }
    );
    if (!selection) {
        return null;
    }

    switch (selection.actionKey) {
        case 'rename':
            await renameInfobaseInteractive(context, infobase);
            return infobase.infobasePath;
        case 'move':
            return await moveInfobaseInteractive(context, infobase);
        case 'reassign':
            return await reassignInfobasePathInteractive(context, infobase);
        case 'startupParameters':
            await configureInfobaseStartupParametersInteractive(context, infobase);
            return infobase.infobasePath;
        case 'delete':
            await deleteInfobaseInteractive(context, infobase);
            return null;
        default:
            return infobase.infobasePath;
    }
}

export async function addInfobaseToLauncherInteractive(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const launcherName = await vscode.window.showInputBox({
        title: t('Enter infobase name for 1C launcher'),
        value: infobase.launcherName || infobase.displayName || getInfobaseDisplayNameFallback(infobase.infobasePath) || 'KOT Infobase',
        ignoreFocusOut: true,
        validateInput: value => value.trim()
            ? null
            : t('Infobase launcher name cannot be empty.')
    });
    if (launcherName === undefined) {
        return;
    }

    await registerInfobaseInLauncher(infobase.infobasePath, launcherName.trim());
    await rememberManualInfobase(context, infobase.infobasePath, launcherName.trim());
    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        displayName: launcherName.trim()
    });
}

export async function removeInfobaseFromLauncherInteractive(
    infobase: ManagedInfobaseRecord,
    context: vscode.ExtensionContext
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const confirmation = await vscode.window.showWarningMessage(
        t('Remove "{0}" from 1C launcher?', infobase.displayName),
        { modal: true },
        t('Remove from launcher')
    );
    if (confirmation !== t('Remove from launcher')) {
        return;
    }

    await unregisterInfobaseFromLauncher(infobase.infobasePath);
    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        displayName: infobase.displayName
    });
}

export async function openInfobaseInEnterprise(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const clientExePath = await resolveConfiguredOneCClientExePath(t);
    const output = getInfobaseManagerOutputChannel();
    const startupArgs = getManagedInfobaseStartupParameterArgs(context, infobase.infobasePath, {
        allowDialogSuppression: false
    });
    await launchOneCDetached(
        clientExePath,
        [
            'ENTERPRISE',
            '/IBConnectionString',
            buildInfobaseConnectionArgument(infobase.infobasePath, { trailingSemicolon: true }),
            ...startupArgs
        ],
        output,
        t,
        infobase.infobasePath
    );
    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        displayName: infobase.launcherName || infobase.displayName,
        lastLaunchAt: new Date().toISOString(),
        lastLaunchKind: 'enterprise'
    });
}

export async function openInfobaseInDesigner(
    context: vscode.ExtensionContext,
    infobase: ManagedInfobaseRecord
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    assertNonWebInfobaseRecord(t, infobase, t('Open in Designer'));
    const designerExePath = await resolveConfiguredOneCDesignerExePath(t);
    const output = getInfobaseManagerOutputChannel();
    await launchOneCDetached(
        designerExePath,
        [
            'DESIGNER',
            '/IBConnectionString',
            buildInfobaseConnectionArgument(infobase.infobasePath, { trailingSemicolon: true })
        ],
        output,
        t,
        infobase.infobasePath
    );
    await updateManagedInfobaseMetadata(context, infobase.infobasePath, {
        displayName: infobase.launcherName || infobase.displayName,
        lastLaunchAt: new Date().toISOString(),
        lastLaunchKind: 'designer'
    });
}

export async function revealInfobaseInOs(infobase: ManagedInfobaseRecord): Promise<void> {
    const fileInfobasePath = getFileInfobaseDirectory(infobase.infobasePath);
    if (!fileInfobasePath) {
        throw new Error('Open folder is available only for file-based infobases.');
    }

    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fileInfobasePath));
}

export async function showInfobaseLogsInteractive(
    infobase: ManagedInfobaseRecord
): Promise<void> {
    if (infobase.logTargets.length === 0) {
        throw new Error('No log targets are known for this infobase yet.');
    }

    const selectedTarget = await vscode.window.showQuickPick(
        infobase.logTargets.map(target => ({
            label: target.label,
            description: target.targetPath,
            detail: target.description,
            target
        })),
        {
            title: `Logs for "${infobase.displayName}"`,
            ignoreFocusOut: true
        }
    );
    if (!selectedTarget) {
        return;
    }

    if (selectedTarget.target.kind === 'file' && selectedTarget.target.exists) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selectedTarget.target.targetPath));
        await vscode.window.showTextDocument(document, { preview: false });
        return;
    }

    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(selectedTarget.target.targetPath));
}

export async function pickManagedInfobasePath(
    context: vscode.ExtensionContext,
    t: Translator,
    options?: ManagedInfobaseSelectionOptions
): Promise<string | null | undefined> {
    const allowBuildOnly = options?.allowBuildOnly !== false;
    const allowCreateNew = options?.allowCreateNew === true;
    const preferredInfobasePath = (options?.preferredInfobasePath || '').trim();
    const allowedKinds = new Set<ManagedInfobaseKind>(
        (options?.allowedKinds && options.allowedKinds.length > 0)
            ? options.allowedKinds
            : ['file', 'server', 'web']
    );
    const allowsFileInfobases = allowedKinds.has('file');
    const records = (await collectManagedInfobases(context))
        .filter(record => allowedKinds.has(record.infobaseKind));

    const quickPickItems: Array<vscode.QuickPickItem & {
        actionKey: 'none' | 'manual' | 'managed' | 'create' | 'manager';
        infobasePath?: string;
    }> = [];

    if (allowBuildOnly) {
        quickPickItems.push({
            label: t('Build only (do not install to infobase)'),
            detail: t('Generate .cfe and stop after build.'),
            actionKey: 'none'
        });
    }

    quickPickItems.push({
        label: t('Open Infobase Manager'),
        detail: t('Manage infobases, launcher registration, DT restore/export, and configuration updates in one panel.'),
        actionKey: 'manager'
    });

    if (allowCreateNew && allowsFileInfobases) {
        quickPickItems.push({
            label: t('Create new infobase'),
            detail: t('Choose a folder, create a new file infobase, and register it in the 1C launcher.'),
            actionKey: 'create'
        });
    }

    if (allowsFileInfobases) {
        quickPickItems.push({
            label: t('Choose infobase folder manually'),
            detail: t('Select an existing file infobase directory from disk.'),
            actionKey: 'manual'
        });
    }

    if (
        preferredInfobasePath
        && allowedKinds.has(getInfobaseKind(preferredInfobasePath))
        && (!isFileInfobaseReference(preferredInfobasePath) || fs.existsSync(preferredInfobasePath))
    ) {
        quickPickItems.push({
            label: t('Use selected snapshot infobase'),
            description: getInfobaseLocationLabel(preferredInfobasePath),
            detail: t('Use infobase parsed from selected snapshot'),
            actionKey: 'managed',
            infobasePath: normalizeInfobaseReferenceValue(preferredInfobasePath)
        });
    }

    for (const record of records) {
        const rolesSummary = record.roles.length > 0
            ? record.roles.join(', ')
            : t('no roles');
        const sourcesSummary = record.sources.length > 0
            ? record.sources.join(', ')
            : t('unknown source');
        quickPickItems.push({
            label: record.displayName,
            description: record.locationLabel,
            detail: `${t('Kind')}: ${record.infobaseKind} | ${t('Roles')}: ${rolesSummary} | ${t('Sources')}: ${sourcesSummary} | ${t('State')}: ${record.state}`,
            actionKey: 'managed',
            infobasePath: record.infobasePath
        });
    }

    const selection = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: options?.placeHolder || t('Choose target infobase'),
        ignoreFocusOut: true
    });
    if (!selection) {
        return undefined;
    }

    if (selection.actionKey === 'none') {
        return null;
    }

    if (selection.actionKey === 'manager') {
        await vscode.commands.executeCommand('kotTestToolkit.openInfobaseManager');
        return undefined;
    }

    if (selection.actionKey === 'create') {
        return createInfobaseInteractive(context);
    }

    if (selection.actionKey === 'managed' && selection.infobasePath) {
        return selection.infobasePath;
    }

    const selectedDirectory = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: t('Choose infobase folder'),
        openLabel: t('Use this folder')
    });
    if (!selectedDirectory || selectedDirectory.length === 0) {
        return undefined;
    }

    const selectedInfobasePath = path.resolve(selectedDirectory[0].fsPath);
    await rememberManualInfobase(context, selectedInfobasePath, null);
    return selectedInfobasePath;
}
