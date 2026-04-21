import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getTranslator } from './localization';
import {
    buildInfobaseConnectionArgument,
    coerceInfobaseConnection,
    describeInfobaseConnection,
    getFileInfobasePath,
    normalizeInfobaseReference
} from './oneCInfobaseConnection';
import {
    normalizeOneCClientExePath,
    resolveOneCPlatformForLaunch
} from './oneCPlatform';
import { getFormExplorerGeneratedArtifactsDirectory, getFormExplorerSnapshotPath } from './formExplorerPaths';
import {
    ensureSharedStartupInfobaseReady,
    getSharedStartupInfobasePaths
} from './startupInfobase';
import {
    getCachedInfobaseAuthentication,
    getManagedInfobasePreferredPlatformClientExePath,
    getManagedInfobaseStartupParameterArgs,
    pickManagedInfobasePath,
    promptAndCacheInfobaseAuthentication,
    updateManagedInfobaseMetadata
} from './infobaseManager';

// ─── constants ───────────────────────────────────────────────────────────────

const OUTPUT_CHANNEL_NAME = 'KOT Form Explorer Bridge';
const BRIDGE_CONFIG_FILE_NAME = 'bridge-config.json';
const BRIDGE_STATUS_FILE_NAME = 'bridge-status.txt';
const DEFAULT_BRIDGE_TEST_CLIENT_PORT = 1538;
const DEFAULT_BRIDGE_AUTO_INTERVAL_SECONDS = 3;

// ─── types ────────────────────────────────────────────────────────────────────

interface BridgeConfigJson {
    snapshotPath: string;
    requestFilePath: string;
    modeStatePath: string;
    statusFilePath: string;
    testClientPort: number;
    workingInfobaseConnection: string;
    autoIntervalSeconds: number;
}

export interface StartFormExplorerBridgeResult {
    status: 'started' | 'cancelled' | 'error';
    targetInfobasePath: string | null;
    error: string | null;
    workingProcessId: number | null;
    startupProcessId: number | null;
}

export interface StartFormExplorerBridgeCommandOptions {
    preferredInfobasePath?: string | null;
    oneCClientExePath?: string | null;
}

// ─── output channel ───────────────────────────────────────────────────────────

let outputChannel: vscode.OutputChannel | null = null;

export function getFormExplorerBridgeOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return outputChannel;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function ensureDirectory(directoryPath: string): Promise<void> {
    await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
    await ensureDirectory(path.dirname(filePath));
    await fs.promises.writeFile(filePath, content, 'utf8');
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.promises.access(targetPath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function formatCommandForOutput(exePath: string, args: string[]): string {
    return [exePath, ...args].map(p => `"${p}"`).join(' ');
}

// ─── bridge config JSON ───────────────────────────────────────────────────────

async function writeBridgeConfigJson(configPath: string, config: BridgeConfigJson): Promise<void> {
    await writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

// ─── process launch helpers ───────────────────────────────────────────────────

async function launchInfobaseDetached(
    clientExePath: string,
    infobasePath: string,
    auth: { username: string; password: string } | null,
    extraArgs: string[],
    channel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<number | null> {
    const connectionArg = buildInfobaseConnectionArgument(infobasePath, { trailingSemicolon: true });
    const authArgs = auth ? ['/N', auth.username, '/P', auth.password] : [];
    const args = [
        'ENTERPRISE',
        '/IBConnectionString',
        connectionArg,
        ...authArgs,
        ...extraArgs
    ];

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    channel.appendLine(t('Launching 1C:Enterprise client for infobase: {0}', describeInfobaseConnection(infobasePath)));
    channel.appendLine(t('Resolved 1C command: {0}', formatCommandForOutput(clientExePath, args)));

    return await new Promise<number | null>((resolve, reject) => {
        try {
            const child = cp.spawn(clientExePath, args, {
                cwd: workspaceRoot,
                shell: false,
                windowsHide: false,
                detached: true,
                stdio: 'ignore'
            });
            child.on('error', error => reject(error));
            child.unref();
            resolve(typeof child.pid === 'number' && child.pid > 0 ? child.pid : null);
        } catch (error) {
            reject(error);
        }
    });
}

// ─── main entry point ────────────────────────────────────────────────────────

export async function handleStartFormExplorerBridge(
    context: vscode.ExtensionContext,
    options?: string | StartFormExplorerBridgeCommandOptions
): Promise<StartFormExplorerBridgeResult> {
    const t = await getTranslator(context.extensionUri);

    if (process.platform !== 'win32') {
        vscode.window.showErrorMessage(
            t('Form Explorer Bridge is supported only on Windows where 1C client is available.')
        );
        return { status: 'error', targetInfobasePath: null, error: t('Form Explorer Bridge is supported only on Windows.'), workingProcessId: null, startupProcessId: null };
    }

    const commandOptions = typeof options === 'string'
        ? { preferredInfobasePath: options }
        : (options || {});

    const configuredPreferredInfobasePath = typeof commandOptions.preferredInfobasePath === 'string' && commandOptions.preferredInfobasePath.trim()
        ? normalizeInfobaseReference(commandOptions.preferredInfobasePath.trim())
        : null;

    const generatedArtifactsDirectory = getFormExplorerGeneratedArtifactsDirectory();
    const workspaceRootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const runtimeDirectory = generatedArtifactsDirectory || path.join(workspaceRootPath, '.vscode', 'kot-runtime', 'form-explorer');
    const bridgeWorkDirectory = path.join(runtimeDirectory, 'bridge');

    const channel = getFormExplorerBridgeOutputChannel();
    if (vscode.workspace.getConfiguration('kotTestToolkit.formExplorer').get<boolean>('showOutputPanel', false)) {
        channel.show(true);
    }

    try {
        // ── 1. pick target infobase ─────────────────────────────────────────
        let selectedTargetInfobasePath = configuredPreferredInfobasePath;
        if (!selectedTargetInfobasePath) {
            const pickedPath = await pickManagedInfobasePath(context, t, {
                allowBuildOnly: false,
                allowCreateNew: false,
                allowedKinds: ['file', 'server'],
                placeHolder: t('Choose target infobase to start with Form Explorer Bridge'),
                preferredInfobasePath: null
            });
            selectedTargetInfobasePath = pickedPath ?? null;
            if (!selectedTargetInfobasePath) {
                return { status: 'cancelled', targetInfobasePath: null, error: null, workingProcessId: null, startupProcessId: null };
            }
        }

        const targetInfobasePath = normalizeInfobaseReference(selectedTargetInfobasePath);
        if (coerceInfobaseConnection(targetInfobasePath).kind === 'web') {
            throw new Error(t('Form Explorer Bridge is not supported for web infobases.'));
        }
        const targetInfobaseFilePath = getFileInfobasePath(targetInfobasePath);
        if (targetInfobaseFilePath && !(await pathExists(targetInfobaseFilePath))) {
            throw new Error(t('Target infobase path does not exist: {0}', targetInfobasePath));
        }

        // ── 2. resolve 1C client ────────────────────────────────────────────
        const preferredClientExePath = normalizeOneCClientExePath(
            commandOptions.oneCClientExePath
            || getManagedInfobasePreferredPlatformClientExePath(context, targetInfobasePath)
            || ''
        );
        let oneCClientExePath = preferredClientExePath;
        if (!oneCClientExePath) {
            const selectedPlatform = await resolveOneCPlatformForLaunch(t, {
                placeHolder: t('Select 1C platform for Form Explorer Bridge')
            });
            if (!selectedPlatform) {
                return { status: 'cancelled', targetInfobasePath, error: null, workingProcessId: null, startupProcessId: null };
            }
            oneCClientExePath = selectedPlatform.clientExePath;
        }

        if (!(await pathExists(oneCClientExePath))) {
            throw new Error(t('1C:Enterprise client file not found at path: {0}', oneCClientExePath));
        }

        // ── 3. resolve snapshot path ────────────────────────────────────────
        const snapshotPath = getFormExplorerSnapshotPath();
        if (!snapshotPath) {
            throw new Error(t('Form Explorer snapshot path is not configured. Set kotTestToolkit.formExplorer.snapshotPath.'));
        }
        const resolvedSnapshotPath = path.resolve(snapshotPath);

        // ── 4. resolve bridge paths ─────────────────────────────────────────
        const testClientPort = vscode.workspace
            .getConfiguration('kotTestToolkit.formExplorer.bridge')
            .get<number>('testClientPort', DEFAULT_BRIDGE_TEST_CLIENT_PORT);
        const requestFilePath = path.join(runtimeDirectory, 'adapter-mode-request.txt');
        const statusFilePath = path.join(bridgeWorkDirectory, BRIDGE_STATUS_FILE_NAME);
        const configJsonPath = path.join(bridgeWorkDirectory, BRIDGE_CONFIG_FILE_NAME);

        // ── 5. ensure startup infobase is ready ─────────────────────────────
        channel.appendLine(t('Preparing shared startup infobase...'));
        const startupResult = await ensureSharedStartupInfobaseReady(context, oneCClientExePath, {
            showOutputPanel: false,
            showProgressNotification: false,
            forceRecreate: false
        });
        const startupPaths = getSharedStartupInfobasePaths();
        if (!startupPaths) {
            throw new Error(t('Startup infobase paths are not configured. Open a workspace folder first.'));
        }

        // ── 6. write bridge config JSON ─────────────────────────────────────
        await ensureDirectory(bridgeWorkDirectory);
        const bridgeConfig: BridgeConfigJson = {
            snapshotPath: resolvedSnapshotPath,
            requestFilePath,
            modeStatePath: path.join(runtimeDirectory, 'adapter-mode.txt'),
            statusFilePath,
            testClientPort,
            workingInfobaseConnection: buildInfobaseConnectionArgument(targetInfobasePath),
            autoIntervalSeconds: DEFAULT_BRIDGE_AUTO_INTERVAL_SECONDS
        };
        channel.appendLine(t('Writing bridge config to: {0}', configJsonPath));
        await writeBridgeConfigJson(configJsonPath, bridgeConfig);

        // ── 7. resolve EPF path ─────────────────────────────────────────────
        const epfPath = path.join(context.extensionUri.fsPath, 'res', 'formExplorer', 'bridge', 'KOTFormExplorerBridge.epf');
        if (!(await pathExists(epfPath))) {
            throw new Error(t('Form Explorer Bridge EPF not found at: {0}', epfPath));
        }

        // ── 8. resolve working IB credentials ──────────────────────────────
        let workingIbAuth = getCachedInfobaseAuthentication(targetInfobasePath);
        if (!workingIbAuth) {
            const prompted = await promptAndCacheInfobaseAuthentication(t, targetInfobasePath);
            if (prompted === undefined) {
                return { status: 'cancelled', targetInfobasePath, error: null, workingProcessId: null, startupProcessId: null };
            }
            workingIbAuth = prompted ?? null;
        }

        // ── 9. launch target infobase with /TestClient PORT ──────────────────
        channel.appendLine(t('Launching target infobase with /TestClient {0}...', String(testClientPort)));
        const targetStartupArgs = getManagedInfobaseStartupParameterArgs(context, targetInfobasePath, {
            allowDialogSuppression: true
        });
        const workingProcessId = await launchInfobaseDetached(
            oneCClientExePath,
            targetInfobasePath,
            workingIbAuth,
            [...targetStartupArgs, '/TestClient', String(testClientPort)],
            channel,
            t
        );

        // ── 10. launch startup infobase with /TestManager + /Execute EPF ────
        channel.appendLine(t('Launching startup infobase with /TestManager...'));
        const startupProcessId = await launchInfobaseDetached(
            oneCClientExePath,
            startupPaths.infobaseDirectory,
            startupResult.authentication,
            ['/DisableStartupDialogs', '/DisableStartupMessages', '/TestManager', '/Execute', epfPath, '/C', configJsonPath],
            channel,
            t
        );

        // ── 11. done ─────────────────────────────────────────────────────────
        vscode.window.showInformationMessage(
            t('Form Explorer Bridge started for: {0}', describeInfobaseConnection(targetInfobasePath))
        );
        await updateManagedInfobaseMetadata(context, targetInfobasePath, {
            displayName: describeInfobaseConnection(targetInfobasePath),
            addRoles: ['formExplorer'],
            lastLaunchAt: new Date().toISOString(),
            lastLaunchKind: 'formExplorer',
            preferredPlatformClientExePath: oneCClientExePath,
            stateHint: 'ready'
        });

        return {
            status: 'started',
            targetInfobasePath,
            error: null,
            workingProcessId,
            startupProcessId
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        channel.appendLine(t('Failed to start Form Explorer Bridge: {0}', message));
        if (!(error instanceof Error && 'alreadyShownToUser' in error && (error as Error & { alreadyShownToUser?: boolean }).alreadyShownToUser)) {
            vscode.window.showErrorMessage(t('Failed to start Form Explorer Bridge: {0}', message));
        }
        return {
            status: 'error',
            targetInfobasePath: configuredPreferredInfobasePath,
            error: message,
            workingProcessId: null,
            startupProcessId: null
        };
    }
}
