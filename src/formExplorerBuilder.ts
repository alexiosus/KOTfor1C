import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getTranslator } from './localization';
import {
    getFormExplorerConfigurationSourceDirectory,
    getFormExplorerExtensionOutputPath,
    getFormExplorerGeneratedArtifactsDirectory,
    getFormExplorerSnapshotPath
} from './formExplorerPaths';
import { resolveOneCDesignerExePath } from './oneCPlatform';

const OUTPUT_CHANNEL_NAME = 'KOT Form Explorer Build';
const BUILDER_INFOBASE_DIRECTORY_NAME = 'builder-infobase';
const DEFAULT_SETTINGS_FILE_NAME = 'adapter-settings.json';
const DEFAULT_MODE_STATE_FILE_NAME = 'adapter-mode.txt';
const DEFAULT_MODE_REQUEST_FILE_NAME = 'adapter-mode-request.txt';
const DEFAULT_HOTKEY_PRESET_KEY = 'ctrlShiftF12';
const DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS = 5;

interface BuilderCacheState {
    configurationSourceDirectory: string;
    configurationXmlHash: string;
}

export interface FormExplorerBuilderPaths {
    configurationSourceDirectory: string;
    generatedArtifactsDirectory: string;
    snapshotPath: string | null;
    extensionOutputPath: string | null;
    builderInfobaseDirectory: string;
    builderCacheStatePath: string;
    settingsFilePath: string;
    modeFilePath: string;
    modeRequestFilePath: string;
    logsDirectory: string;
}

export interface EnsureFormExplorerBuilderResult {
    builderInfobaseDirectory: string;
    reusedExistingBuilder: boolean;
    createdOrRebuiltBuilder: boolean;
}

let outputChannel: vscode.OutputChannel | null = null;
const activeEnsureOperations = new Map<string, Promise<EnsureFormExplorerBuilderResult>>();

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }

    return outputChannel;
}

async function ensureDirectory(directoryPath: string): Promise<void> {
    await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function recreateDirectory(directoryPath: string): Promise<void> {
    await fs.promises.rm(directoryPath, { recursive: true, force: true });
    await ensureDirectory(directoryPath);
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

async function readUtf8File(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf8');
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

async function hashFileContents(filePath: string): Promise<string> {
    const contents = await fs.promises.readFile(filePath);
    return crypto.createHash('sha256').update(contents).digest('hex');
}

async function getBuilderCacheState(configurationSourceDirectory: string): Promise<BuilderCacheState> {
    return {
        configurationSourceDirectory,
        configurationXmlHash: await hashFileContents(path.join(configurationSourceDirectory, 'Configuration.xml'))
    };
}

function isSameBuilderCacheState(expected: BuilderCacheState, actual: BuilderCacheState | null): boolean {
    if (!actual) {
        return false;
    }

    return expected.configurationSourceDirectory === actual.configurationSourceDirectory
        && expected.configurationXmlHash === actual.configurationXmlHash;
}

function formatCommandForOutput(exePath: string, args: string[]): string {
    return [exePath, ...args]
        .map(part => `"${part}"`)
        .join(' ');
}

function getOutputTail(output: string, maxLength: number = 4000): string {
    if (!output) {
        return '';
    }

    return output.length <= maxLength ? output.trim() : output.slice(-maxLength).trim();
}

async function run1CCommand(
    exePath: string,
    args: string[],
    cwd: string,
    stepTitle: string,
    outFilePath: string,
    channel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    const effectiveArgs = [...args, '/Out', outFilePath];
    channel.appendLine(t('Form Explorer build step: {0}', stepTitle));
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
                    // Ignore log read failures and fall back to process output.
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

async function initializeAdapterRuntimeFiles(pathsInfo: FormExplorerBuilderPaths): Promise<void> {
    const { settingsFilePath, modeFilePath, modeRequestFilePath, snapshotPath } = pathsInfo;

    if (!(await pathExists(settingsFilePath))) {
        await writeTextFile(settingsFilePath, `${JSON.stringify({
            snapshotPath: snapshotPath || '',
            hotkeyPreset: DEFAULT_HOTKEY_PRESET_KEY,
            autoSnapshotEnabled: false,
            autoSnapshotIntervalSeconds: DEFAULT_AUTO_SNAPSHOT_INTERVAL_SECONDS
        }, null, 2)}\n`);
    }

    if (!(await pathExists(modeFilePath))) {
        await writeTextFile(modeFilePath, 'manual\n');
    }

    if (!(await pathExists(modeRequestFilePath))) {
        await writeTextFile(modeRequestFilePath, '\n');
    }
}

export function getFormExplorerBuilderPaths(): FormExplorerBuilderPaths | null {
    const configurationSourceDirectory = getFormExplorerConfigurationSourceDirectory();
    const generatedArtifactsDirectory = getFormExplorerGeneratedArtifactsDirectory();
    if (!configurationSourceDirectory || !generatedArtifactsDirectory) {
        return null;
    }

    return {
        configurationSourceDirectory,
        generatedArtifactsDirectory,
        snapshotPath: getFormExplorerSnapshotPath(),
        extensionOutputPath: getFormExplorerExtensionOutputPath(),
        builderInfobaseDirectory: path.join(generatedArtifactsDirectory, BUILDER_INFOBASE_DIRECTORY_NAME),
        builderCacheStatePath: path.join(generatedArtifactsDirectory, 'builder-base-state.json'),
        settingsFilePath: path.join(generatedArtifactsDirectory, DEFAULT_SETTINGS_FILE_NAME),
        modeFilePath: path.join(generatedArtifactsDirectory, DEFAULT_MODE_STATE_FILE_NAME),
        modeRequestFilePath: path.join(generatedArtifactsDirectory, DEFAULT_MODE_REQUEST_FILE_NAME),
        logsDirectory: path.join(generatedArtifactsDirectory, 'build-logs')
    };
}

export async function initializeFormExplorerRuntimeSidecars(): Promise<void> {
    const builderPaths = getFormExplorerBuilderPaths();
    if (!builderPaths) {
        return;
    }

    await ensureDirectory(builderPaths.generatedArtifactsDirectory);
    await initializeAdapterRuntimeFiles(builderPaths);
}

export async function shouldPrepareFormExplorerBuilderInfobase(): Promise<boolean> {
    const builderPaths = getFormExplorerBuilderPaths();
    if (!builderPaths) {
        return false;
    }

    const configurationXmlPath = path.join(builderPaths.configurationSourceDirectory, 'Configuration.xml');
    if (!(await pathExists(configurationXmlPath))) {
        return false;
    }

    const expectedState = await getBuilderCacheState(builderPaths.configurationSourceDirectory);
    const actualState = await readJsonFile<BuilderCacheState>(builderPaths.builderCacheStatePath);
    return !(await pathExists(builderPaths.builderInfobaseDirectory))
        || !isSameBuilderCacheState(expectedState, actualState);
}

async function ensureBuilderInfobaseCore(
    context: vscode.ExtensionContext,
    builderPaths: FormExplorerBuilderPaths,
    oneCClientExePath: string,
    forceRebuild: boolean,
    channel: vscode.OutputChannel
): Promise<EnsureFormExplorerBuilderResult> {
    const t = await getTranslator(context.extensionUri);
    const designerExePath = resolveOneCDesignerExePath(oneCClientExePath);
    const configurationXmlPath = path.join(builderPaths.configurationSourceDirectory, 'Configuration.xml');

    if (!(await pathExists(oneCClientExePath))) {
        throw new Error(t('1C:Enterprise client file not found at path: {0}', oneCClientExePath));
    }

    if (!(await pathExists(designerExePath))) {
        throw new Error(t('1C:Enterprise Designer file not found at path: {0}', designerExePath));
    }

    if (!(await pathExists(configurationXmlPath))) {
        throw new Error(t('Could not find Configuration.xml in {0}.', builderPaths.configurationSourceDirectory));
    }

    await ensureDirectory(builderPaths.generatedArtifactsDirectory);
    await initializeAdapterRuntimeFiles(builderPaths);

    const expectedState = await getBuilderCacheState(builderPaths.configurationSourceDirectory);
    const actualState = await readJsonFile<BuilderCacheState>(builderPaths.builderCacheStatePath);
    const canReuseBuilder = !forceRebuild
        && (await pathExists(builderPaths.builderInfobaseDirectory))
        && isSameBuilderCacheState(expectedState, actualState);

    if (canReuseBuilder) {
        channel.appendLine(t('Reusing cached builder infobase.'));
        return {
            builderInfobaseDirectory: builderPaths.builderInfobaseDirectory,
            reusedExistingBuilder: true,
            createdOrRebuiltBuilder: false
        };
    }

    channel.appendLine(forceRebuild
        ? t('Rebuilding cached builder infobase after cache failure.')
        : t('Building cached builder infobase.'));

    await recreateDirectory(builderPaths.logsDirectory);
    await fs.promises.rm(builderPaths.builderCacheStatePath, { force: true });
    await recreateDirectory(builderPaths.builderInfobaseDirectory);

    await run1CCommand(
        designerExePath,
        ['CREATEINFOBASE', `File=${builderPaths.builderInfobaseDirectory}`],
        builderPaths.generatedArtifactsDirectory,
        t('Create builder infobase'),
        path.join(builderPaths.logsDirectory, '01-create-builder-infobase.log'),
        channel,
        t
    );

    await run1CCommand(
        designerExePath,
        [
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            `File=${builderPaths.builderInfobaseDirectory}`,
            '/LoadConfigFromFiles',
            builderPaths.configurationSourceDirectory,
            '/UpdateDBCfg'
        ],
        builderPaths.generatedArtifactsDirectory,
        t('Load base configuration into builder infobase'),
        path.join(builderPaths.logsDirectory, '02-load-base-configuration.log'),
        channel,
        t
    );

    await writeTextFile(builderPaths.builderCacheStatePath, `${JSON.stringify(expectedState, null, 2)}\n`);
    return {
        builderInfobaseDirectory: builderPaths.builderInfobaseDirectory,
        reusedExistingBuilder: false,
        createdOrRebuiltBuilder: true
    };
}

export async function ensureFormExplorerBuilderInfobaseReady(
    context: vscode.ExtensionContext,
    oneCClientExePath: string,
    options?: {
        showOutputPanel?: boolean;
        showProgressNotification?: boolean;
        progressTitle?: string;
        forceRebuild?: boolean;
    }
): Promise<EnsureFormExplorerBuilderResult> {
    const builderPaths = getFormExplorerBuilderPaths();
    const t = await getTranslator(context.extensionUri);
    if (!builderPaths) {
        throw new Error(
            t('Form Explorer configuration source directory is not configured. Set kotTestToolkit.formExplorer.configurationSourceDirectory.')
        );
    }

    const operationKey = `${builderPaths.builderInfobaseDirectory}:${builderPaths.configurationSourceDirectory}`;
    const existingOperation = activeEnsureOperations.get(operationKey);
    if (existingOperation) {
        return existingOperation;
    }

    const channel = getOutputChannel();
    if (options?.showOutputPanel) {
        channel.show(true);
    }

    const operation = (async () => {
        const execute = () => ensureBuilderInfobaseCore(
            context,
            builderPaths,
            oneCClientExePath,
            options?.forceRebuild === true,
            channel
        );

        if (!options?.showProgressNotification) {
            return execute();
        }

        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: options.progressTitle || t('Preparing KOT Form Explorer builder infobase...'),
                cancellable: false
            },
            async () => execute()
        );
    })();

    activeEnsureOperations.set(operationKey, operation);
    try {
        return await operation;
    } finally {
        activeEnsureOperations.delete(operationKey);
    }
}

export function getFormExplorerBuilderOutputChannel(): vscode.OutputChannel {
    return getOutputChannel();
}
