import { kotWindow } from './kotInteraction';
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { decideSharedStartupInfobaseAction } from './startupInfobasePolicy';
import { replaceSharedStartupInfobase, serializeStartupInfobasePreparation } from './startupInfobasePreparation';
import { getTranslator } from './localization';
import { buildFileInfobaseConnectionArgument } from './oneCInfobaseConnection';
import { resolveOneCDesignerExePath } from './oneCPlatform';
import { runningOneCInfobasePlatform } from './oneCInfobasePlatform';
import { formatProcessCommandForDisplay } from './processCommandDisplay';
import { McpComponentProvisioner, VANESSA_MCP_COMPONENT, buildMcpExtensionInstallArgs, recordBundledMcpComponents } from './vanessaControlProvisioning';
import { parseMcpPermissionsReport } from './vanessaControlPermissions';
import { acquireMcpComponent } from './vanessaControlComponentCache';

const kotUi = kotWindow?.(vscode.window) ?? vscode.window;

const OUTPUT_CHANNEL_NAME = 'KOT Startup Infobase';
const STARTUP_INFOBASE_ROOT_RELATIVE_PATH = path.join('.vscode', 'kot-runtime', 'startup-infobase');
const STARTUP_INFOBASE_DIRECTORY_NAME = 'ib';
const STARTUP_INFOBASE_LOGS_DIRECTORY_NAME = 'logs';
const STARTUP_INFOBASE_MARKER_FILE_NAME = '1Cv8.1CD';
const STARTUP_INFOBASE_AUTH_STATE_FILE_NAME = 'template-state.json';
const STARTUP_INFOBASE_SERVICE_USER_NAME = 'KOTStartupService';
const STARTUP_INFOBASE_TEMPLATE_SERVICE_USER_PASSWORD = '';
const STARTUP_INFOBASE_AUTH_STATE_SCHEMA_VERSION = 2;
const STARTUP_INFOBASE_TEMPLATE_DT_RELATIVE_PATH = path.join('tools', 'startup-infobase', 'KOTStartupTemplate.dt');
const STARTUP_HELPER_NAME = 'KOTMcpPermissions';
const STARTUP_HELPER_TIMEOUT_MS = 30_000;
const VANESSA_WINDOW_EXTENSION = { name: 'KOTVanessaWindow', version: '1.0.1' };

export interface SharedStartupInfobaseAuthentication {
    username: string;
    password: string;
}

export interface SharedStartupInfobasePaths {
    rootDirectory: string;
    infobaseDirectory: string;
    logsDirectory: string;
    markerFilePath: string;
    authStateFilePath: string;
}

interface SharedStartupInfobaseAuthState {
    schemaVersion: number;
    infobaseDirectory: string;
    username: string;
    password: string;
    configuredAt: string;
    provisioningMethod: 'templateDt';
    templateDtDescriptor: string;
    extensionVersion?: string;
}

export interface EnsureSharedStartupInfobaseResult {
    infobaseDirectory: string;
    reusedExistingInfobase: boolean;
    createdInfobase: boolean;
    authentication: SharedStartupInfobaseAuthentication | null;
}

let outputChannel: vscode.OutputChannel | null = null;
const activeEnsureOperations = new Map<string, Promise<EnsureSharedStartupInfobaseResult>>();
const activeMcpEnsureOperations = new Map<string, Promise<void>>();

/** Only called for a managed MCP launch, after normal service-IB preparation. */
export async function ensureSharedStartupInfobaseMcpReady(context: vscode.ExtensionContext,
    clientExePath: string, base: EnsureSharedStartupInfobaseResult): Promise<void> {
    if (process.platform !== 'win32') { throw new Error('Managed Vanessa MCP launch currently requires Windows. Attach works on other systems.'); }
    const startupPaths = getSharedStartupInfobasePaths();
    if (!startupPaths || path.resolve(base.infobaseDirectory) !== path.resolve(startupPaths.infobaseDirectory)) {
        throw new Error('Automatic MCP preparation is limited to the KOT service infobase.');
    }
    const key = startupPaths.infobaseDirectory;
    const existing = activeMcpEnsureOperations.get(key);
    if (existing) { return existing; }
    const statePath = path.join(key, '.kot-mcp-components.json');
    const t = await getTranslator(context.extensionUri);
    const concurrent = activeMcpEnsureOperations.get(key);
    if (concurrent) { return concurrent; }
    const isBusy = () => new Promise<boolean>((resolve, reject) => {
        // Return only a boolean, never command lines (which can contain credentials).
        const script = "$ErrorActionPreference='Stop'; $base=$env:KOT_MCP_SERVICE_IB.Replace('/','\\').TrimEnd('\\'); "
            + "$pattern='(?i)(?:^|[=;\\s\"])'+[regex]::Escape($base)+'(?=$|[;\\s\"])'; "
            + "$busy=@(Get-CimInstance Win32_Process -Filter \"Name LIKE '1cv8%'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/','\\') -match $pattern }).Count -gt 0; "
            + 'if($busy){Write-Output busy}else{Write-Output idle}';
        cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, timeout: 15_000, env: { ...process.env, KOT_MCP_SERVICE_IB: key } }, (error, stdout) => {
                if (error || !['busy', 'idle'].includes(stdout.trim())) { reject(new Error('Could not check active service infobase sessions.')); }
                else { resolve(stdout.trim() === 'busy'); }
            });
    });
    const installer = new McpComponentProvisioner({
        readInstalledHash: async () => {
            const state = await readJsonFile<{ schemaVersion?: number; safeMode?: boolean; sha256?: string }>(statePath);
            return state?.schemaVersion === 2 && state.safeMode === false ? state.sha256 : undefined;
        },
        isBusy,
        acquireArtifact: () => acquireMcpComponent(context.globalStorageUri.fsPath, VANESSA_MCP_COMPONENT),
        install: async (_base, artifact) => {
            const designer = resolveOneCDesignerExePath(clientExePath);
            if (!designer) { throw new Error('1C Designer is required to prepare Vanessa MCP.'); }
            const logPath = path.join(startupPaths.logsDirectory, '03-install-mcp-extension.log');
            await fs.promises.rm(logPath, { force: true });
            await run1CCommand(designer, buildMcpExtensionInstallArgs(key, artifact, base.authentication),
                startupPaths.rootDirectory, t('Install Vanessa MCP in the service infobase'), logPath,
                getSharedStartupInfobaseOutputChannel(), t);
            const helperDirectory = path.join(startupPaths.rootDirectory, 'mcp-preparation');
            await ensureDirectory(helperDirectory);
            const helperPath = path.join(helperDirectory, 'permissions.epf');
            const reportPath = path.join(helperDirectory, 'permissions.json');
            // The devkit parses every /C key. Put the helper payload in a valid key's value.
            if (/[;|\r\n]/u.test(reportPath)) { throw new Error('The service infobase path contains unsupported MCP preparation delimiters.'); }
            const source = vscode.Uri.joinPath(context.extensionUri, 'tools', 'startup-infobase', 'mcp-permissions', 'KOTMcpPermissions.xml').fsPath;
            const auth = base.authentication ? ['/N', base.authentication.username, '/P', base.authentication.password] : [];
            const common = ['/DisableStartupDialogs', '/DisableStartupMessages', '/IBConnectionString', buildFileInfobaseConnectionArgument(key), ...auth];
            await fs.promises.rm(helperPath, { force: true });
            await run1CCommand(designer, ['DESIGNER', ...common, '/LoadExternalDataProcessorOrReportFromFiles', source, helperPath],
                startupPaths.rootDirectory, t('Prepare Vanessa MCP settings helper'), path.join(startupPaths.logsDirectory, '04-build-mcp-helper.log'),
                getSharedStartupInfobaseOutputChannel(), t);
            await fs.promises.rm(reportPath, { force: true });
            await run1CCommand(clientExePath, ['ENTERPRISE', ...common, '/Execute', helperPath, '/C', `KOTMcpPreparation=KOTMcpConfigure|${reportPath}`],
                startupPaths.rootDirectory, t('Configure Vanessa MCP in the service infobase'), path.join(startupPaths.logsDirectory, '05-configure-mcp.log'),
                getSharedStartupInfobaseOutputChannel(), t);
            parseMcpPermissionsReport(await readUtf8File(reportPath));
        },
        writeInstalledHash: async (_base, sha256) => writeJsonFile(statePath,
            { schemaVersion: 2, safeMode: false, version: VANESSA_MCP_COMPONENT.version, sha256 })
    });
    const operation = serializeStartupInfobasePreparation(key, async () => {
        await installer.ensure(key);
        const windowStatePath = path.join(key, '.kot-vanessa-window.json');
        const windowExtension = await readJsonFile<{ version?: string }>(windowStatePath);
        if (windowExtension?.version === VANESSA_WINDOW_EXTENSION.version) { return; }
        const channel = getSharedStartupInfobaseOutputChannel();
        try {
            if (await isBusy()) { return; }
            const designer = resolveOneCDesignerExePath(clientExePath);
            if (!designer) { throw new Error('1C Designer is required to install the Vanessa window extension.'); }
            const source = vscode.Uri.joinPath(context.extensionUri, 'tools', 'startup-infobase', 'vanessa-window').fsPath;
            const auth = base.authentication ? ['/N', base.authentication.username, '/P', base.authentication.password] : [];
            await run1CCommand(designer, ['DESIGNER', '/DisableStartupDialogs', '/DisableStartupMessages',
                '/IBConnectionString', buildFileInfobaseConnectionArgument(key), ...auth,
                '/LoadConfigFromFiles', source, '-Extension', VANESSA_WINDOW_EXTENSION.name, '/UpdateDBCfg'],
                startupPaths.rootDirectory, t('Install Vanessa window extension'), path.join(startupPaths.logsDirectory, '06-vanessa-window.log'),
                channel, t, STARTUP_HELPER_TIMEOUT_MS);
            await writeJsonFile(windowStatePath, VANESSA_WINDOW_EXTENSION);
        } catch (error) {
            // Caption installation is optional and must not disable an otherwise working manager.
            channel.appendLine(t('Could not prepare the Vanessa window title: {0}', String(error)));
        }
    });
    activeMcpEnsureOperations.set(key, operation);
    try { await operation; } finally { if (activeMcpEnsureOperations.get(key) === operation) { activeMcpEnsureOperations.delete(key); } }
}

/** Set the service user's language before starting a new Vanessa session. */
export async function setSharedVanessaInterfaceLanguage(context: vscode.ExtensionContext, clientExePath: string,
    base: EnsureSharedStartupInfobaseResult, language: 'ru' | 'en'): Promise<void> {
    const startupPaths = getSharedStartupInfobasePaths();
    if (!startupPaths || path.resolve(base.infobaseDirectory) !== path.resolve(startupPaths.infobaseDirectory)
        || base.authentication?.username !== STARTUP_INFOBASE_SERVICE_USER_NAME) {
        throw new Error('A KOT service infobase and user are required to prepare Vanessa startup.');
    }
    const { authentication } = base;
    const designer = resolveOneCDesignerExePath(clientExePath);
    if (!designer) { throw new Error('1C Designer is required to prepare Vanessa startup.'); }
    const t = await getTranslator(context.extensionUri);
    const channel = getSharedStartupInfobaseOutputChannel();
    const root = path.join(startupPaths.rootDirectory, 'mcp-preparation');
    const source = vscode.Uri.joinPath(context.extensionUri, 'tools', 'startup-infobase', 'mcp-permissions', `${STARTUP_HELPER_NAME}.xml`).fsPath;
    const formRoot = path.join(path.dirname(source), STARTUP_HELPER_NAME, 'Forms');
    const sourceFiles = [source, path.join(formRoot, 'Settings.xml'), path.join(formRoot, 'Settings', 'Ext', 'Form.xml'),
        path.join(formRoot, 'Settings', 'Ext', 'Form', 'Module.bsl')];
    const contents = await Promise.all(sourceFiles.map(file => fs.promises.readFile(file)));
    const sourceHash = createHash('sha256').update(designer).update(Buffer.concat(contents)).digest('hex').slice(0, 16);
    const helperPath = path.join(root, `startup-${sourceHash}.epf`);
    const common = ['/DisableStartupDialogs', '/DisableStartupMessages', '/IBConnectionString',
        buildFileInfobaseConnectionArgument(base.infobaseDirectory), '/N', authentication.username, '/P', authentication.password];

    await serializeStartupInfobasePreparation(base.infobaseDirectory, async () => {
        await ensureDirectory(root);
        const work = await fs.promises.mkdtemp(path.join(root, 'startup-'));
        try {
            const reportPath = path.join(work, 'language.json');
            if (/[;|\r\n]/u.test(reportPath)) { throw new Error('The service infobase path contains unsupported startup delimiters.'); }
            if (!await pathExists(helperPath)) {
                const temporaryEpf = path.join(work, 'startup.epf');
                await run1CCommand(designer, ['DESIGNER', ...common, '/LoadExternalDataProcessorOrReportFromFiles', source, temporaryEpf],
                    root, t('Build Vanessa startup helper'), path.join(work, 'build.log'), channel, t, STARTUP_HELPER_TIMEOUT_MS);
                await fs.promises.rename(temporaryEpf, helperPath);
            }
            await run1CCommand(clientExePath, ['ENTERPRISE', ...common, '/Execute', helperPath, '/C', `KOTMcpPreparation=KOTSetLanguage|${language}|${reportPath}`],
                root, t('Set Vanessa interface language'), path.join(work, 'language.log'), channel, t, STARTUP_HELPER_TIMEOUT_MS);
            const report = JSON.parse((await readUtf8File(reportPath)).replace(/^\uFEFF/u, '')) as { language?: string; error?: string };
            if (report.language !== language) {
                throw new Error(report.error || t('Could not set the Vanessa interface language to {0}.', language));
            }
        } finally {
            await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
        }
    });
}

export function getSharedStartupInfobaseOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }

    return outputChannel;
}

function getOutputTail(output: string, maxLength: number = 4000): string {
    if (!output) {
        return '';
    }

    return output.length <= maxLength ? output.trim() : output.slice(-maxLength).trim();
}

async function ensureDirectory(directoryPath: string): Promise<void> {
    await fs.promises.mkdir(directoryPath, { recursive: true });
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
    try {
        return JSON.parse(await readUtf8File(filePath)) as T;
    } catch {
        return null;
    }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await ensureDirectory(path.dirname(filePath));
    await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function run1CCommand(
    exePath: string,
    args: string[],
    cwd: string,
    stepTitle: string,
    outFilePath: string,
    channel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>,
    timeout?: number
): Promise<void> {
    const effectiveArgs = [...args, '/Out', outFilePath];
    channel.appendLine(t('Startup infobase step: {0}', stepTitle));
    channel.appendLine(t('Resolved 1C command: {0}', formatProcessCommandForDisplay(exePath, effectiveArgs)));

    await new Promise<void>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const child = cp.spawn(exePath, effectiveArgs, {
            cwd,
            shell: false,
            windowsHide: true,
            timeout
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
                    // Ignore unreadable designer log and fall back to stdout/stderr.
                }
            }

            const details = getOutputTail(`${stderr}\n${stdout}\n${designerLog}`) || t('<empty output>');
            reject(new Error(t('1C command for "{0}" exited with code {1}. Output tail: {2}', stepTitle, String(code ?? 'unknown'), details)));
        });
    });
}

function buildSharedStartupInfobaseAuthenticationState(
    startupPaths: SharedStartupInfobasePaths,
    authentication: SharedStartupInfobaseAuthentication
): Omit<SharedStartupInfobaseAuthState, 'provisioningMethod' | 'templateDtDescriptor'> {
    return {
        schemaVersion: STARTUP_INFOBASE_AUTH_STATE_SCHEMA_VERSION,
        infobaseDirectory: path.resolve(startupPaths.infobaseDirectory),
        username: authentication.username,
        password: authentication.password,
        configuredAt: new Date().toISOString()
    };
}

function isValidSharedStartupInfobaseAuthState(
    startupPaths: SharedStartupInfobasePaths,
    state: SharedStartupInfobaseAuthState | null
): state is SharedStartupInfobaseAuthState {
    if (!state) {
        return false;
    }

    return state.schemaVersion === STARTUP_INFOBASE_AUTH_STATE_SCHEMA_VERSION
        && typeof state.infobaseDirectory === 'string'
        && path.resolve(state.infobaseDirectory) === path.resolve(startupPaths.infobaseDirectory)
        && state.provisioningMethod === 'templateDt'
        && typeof state.username === 'string'
        && state.username.trim().length > 0
        && typeof state.password === 'string'
        && typeof state.templateDtDescriptor === 'string'
        && state.templateDtDescriptor.trim().length > 0;
}

function getTemplateSharedStartupInfobaseAuthentication(): SharedStartupInfobaseAuthentication {
    return {
        username: STARTUP_INFOBASE_SERVICE_USER_NAME,
        password: STARTUP_INFOBASE_TEMPLATE_SERVICE_USER_PASSWORD
    };
}

function getStartupInfobaseTemplateDtPath(context: vscode.ExtensionContext): string {
    return path.join(context.extensionUri.fsPath, STARTUP_INFOBASE_TEMPLATE_DT_RELATIVE_PATH);
}

async function resolveStartupInfobaseTemplateDtInfo(
    context: vscode.ExtensionContext
): Promise<{ templatePath: string; descriptor: string } | null> {
    const templatePath = getStartupInfobaseTemplateDtPath(context);
    try {
        const stat = await fs.promises.stat(templatePath);
        if (!stat.isFile()) {
            return null;
        }

        return {
            templatePath,
            descriptor: `${templatePath}::${stat.size}::${stat.mtimeMs}`
        };
    } catch {
        return null;
    }
}

async function restoreSharedStartupInfobaseFromTemplateDt(
    startupPaths: SharedStartupInfobasePaths,
    templatePath: string,
    designerExePath: string,
    channel: vscode.OutputChannel,
    t: Awaited<ReturnType<typeof getTranslator>>
): Promise<void> {
    channel.appendLine(t('Using startup infobase template DT: {0}', templatePath));

    await run1CCommand(
        designerExePath,
        [
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            buildFileInfobaseConnectionArgument(startupPaths.infobaseDirectory, { trailingSemicolon: true }),
            '/RestoreIB',
            templatePath
        ],
        startupPaths.rootDirectory,
        t('Restore shared startup infobase from template DT'),
        path.join(startupPaths.logsDirectory, '02-restore-startup-infobase-template.log'),
        channel,
        t
    );
}

export function getSharedStartupInfobasePaths(): SharedStartupInfobasePaths | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return null;
    }

    const rootDirectory = path.join(workspaceFolder.uri.fsPath, STARTUP_INFOBASE_ROOT_RELATIVE_PATH);
    const infobaseDirectory = path.join(rootDirectory, STARTUP_INFOBASE_DIRECTORY_NAME);
    return {
        rootDirectory,
        infobaseDirectory,
        logsDirectory: path.join(rootDirectory, STARTUP_INFOBASE_LOGS_DIRECTORY_NAME),
        markerFilePath: path.join(infobaseDirectory, STARTUP_INFOBASE_MARKER_FILE_NAME),
        authStateFilePath: path.join(infobaseDirectory, STARTUP_INFOBASE_AUTH_STATE_FILE_NAME)
    };
}

export async function shouldPrepareSharedStartupInfobase(): Promise<boolean> {
    const startupPaths = getSharedStartupInfobasePaths();
    if (!startupPaths) {
        return false;
    }

    return !(await pathExists(startupPaths.markerFilePath));
}

export async function ensureSharedStartupInfobaseReady(
    context: vscode.ExtensionContext,
    oneCClientExePath: string,
    options?: {
        showOutputPanel?: boolean;
        showProgressNotification?: boolean;
        progressTitle?: string;
        forceRecreate?: boolean;
    }
): Promise<EnsureSharedStartupInfobaseResult> {
    const t = await getTranslator(context.extensionUri);
    const startupPaths = getSharedStartupInfobasePaths();
    if (!startupPaths) {
        throw new Error(t('Startup infobase paths are not configured. Open a workspace folder first.'));
    }

    const trimmedClientPath = oneCClientExePath.trim();
    if (!trimmedClientPath) {
        throw new Error(t('Path to 1C:Enterprise client (1cv8c.exe) is not specified in settings.'));
    }
    if (!fs.existsSync(trimmedClientPath)) {
        throw new Error(t('1C:Enterprise client file not found at path: {0}', trimmedClientPath));
    }

    const output = getSharedStartupInfobaseOutputChannel();
    if (options?.showOutputPanel) {
        output.show(true);
    }

    const ensureKey = startupPaths.infobaseDirectory;
    const existingOperation = activeEnsureOperations.get(ensureKey);
    if (existingOperation) {
        return existingOperation;
    }

    const performEnsure = async (): Promise<EnsureSharedStartupInfobaseResult> => {
        const designerExePath = resolveOneCDesignerExePath(trimmedClientPath);
        if (!designerExePath || !fs.existsSync(designerExePath)) {
            throw new Error(t('1C Designer executable was not found next to client path: {0}', trimmedClientPath));
        }

        await ensureDirectory(startupPaths.rootDirectory);
        await ensureDirectory(startupPaths.logsDirectory);

        const legacyAuthPath = path.join(startupPaths.rootDirectory, STARTUP_INFOBASE_AUTH_STATE_FILE_NAME);
        const readAuthState = () => readJsonFile<SharedStartupInfobaseAuthState>(startupPaths.authStateFilePath);
        const storedAuthState = process.platform === 'win32'
            ? (await readAuthState()) ?? await readJsonFile<SharedStartupInfobaseAuthState>(legacyAuthPath)
            : null;
        const storedAuthentication = isValidSharedStartupInfobaseAuthState(startupPaths, storedAuthState)
            ? {
                username: storedAuthState.username,
                password: storedAuthState.password
            }
            : null;
        const templateDtInfo = process.platform === 'win32'
            ? await resolveStartupInfobaseTemplateDtInfo(context)
            : null;
        const markerExists = await pathExists(startupPaths.markerFilePath);
        const version: unknown = context.extension?.packageJSON.version;
        const extensionVersion = typeof version === 'string' && version.trim() ? version : undefined;
        const templateDescriptorMatches = storedAuthState?.provisioningMethod !== 'templateDt'
            || (!!templateDtInfo && storedAuthState.templateDtDescriptor === templateDtInfo.descriptor);
        const decision = decideSharedStartupInfobaseAction({
            markerExists,
            forceRecreate: options?.forceRecreate === true,
            platform: process.platform,
            hasStoredAuthentication: storedAuthentication !== null,
            templateDescriptorMatches,
            extensionVersionChanged: !!extensionVersion && (!storedAuthentication || storedAuthState?.extensionVersion !== extensionVersion)
        });

        const reuse = (authentication: SharedStartupInfobaseAuthentication | null): EnsureSharedStartupInfobaseResult => ({
            infobaseDirectory: startupPaths.infobaseDirectory,
            reusedExistingInfobase: true,
            createdInfobase: false,
            authentication
        });

        if (decision.action === 'reuse') {
            if (decision.reason === 'current') {
                output.appendLine(t('Reusing shared startup infobase from template DT.'));
            } else if (decision.reason === 'templateChanged') {
                output.appendLine(t('Stored startup infobase template DT changed. Reusing the existing infobase until it is explicitly recreated.'));
            } else {
                output.appendLine(t('Reusing existing legacy shared startup infobase without service credentials.'));
            }
            return reuse(decision.authentication === 'stored' ? storedAuthentication : null);
        }

        const canReplace = async () => {
            if (process.platform !== 'win32' || !await pathExists(startupPaths.markerFilePath)) { return true; }
            const idle = await runningOneCInfobasePlatform(startupPaths.infobaseDirectory).then(session => !session, () => false);
            if (idle) { return true; }
            const message = t('The service infobase will be recreated when no 1C sessions are using it.');
            if (options?.forceRecreate) { throw new Error(message); }
            output.appendLine(message);
            return false;
        };
        if (!await canReplace()) { return reuse(storedAuthentication); }

        const recreateReason = decision.action === 'recreate'
            ? t('Recreating shared startup infobase.')
            : t('Creating shared startup infobase.');
        output.appendLine(recreateReason);

        if (process.platform === 'win32' && !templateDtInfo) {
            throw new Error(
                t(
                    'Startup infobase template DT was not found inside the extension: {0}',
                    getStartupInfobaseTemplateDtPath(context)
                )
            );
        }

        const work = await fs.promises.mkdtemp(path.join(startupPaths.rootDirectory, 'prepare-'));
        const restored = path.join(work, STARTUP_INFOBASE_DIRECTORY_NAME);
        let backupRoot: string | undefined;
        const authentication = templateDtInfo ? getTemplateSharedStartupInfobaseAuthentication() : null;
        try {
            await ensureDirectory(restored);
            await run1CCommand(designerExePath,
                ['CREATEINFOBASE', buildFileInfobaseConnectionArgument(restored, { trailingSemicolon: true })],
                startupPaths.rootDirectory, t('Create shared startup infobase'), path.join(startupPaths.logsDirectory, '01-create-startup-infobase.log'), output, t);
            if (templateDtInfo && authentication) {
                await restoreSharedStartupInfobaseFromTemplateDt({ ...startupPaths, infobaseDirectory: restored },
                    templateDtInfo.templatePath, designerExePath, output, t);
                await recordBundledMcpComponents(templateDtInfo.templatePath, restored);
                await writeJsonFile(path.join(restored, STARTUP_INFOBASE_AUTH_STATE_FILE_NAME), {
                    ...buildSharedStartupInfobaseAuthenticationState(startupPaths, authentication),
                    provisioningMethod: 'templateDt',
                    templateDtDescriptor: templateDtInfo.descriptor,
                    extensionVersion
                } satisfies SharedStartupInfobaseAuthState);
            }
            if (!await pathExists(path.join(restored, STARTUP_INFOBASE_MARKER_FILE_NAME))) {
                throw new Error(t('The restored service infobase could not be found.'));
            }
            const current = await readAuthState();
            if (extensionVersion && !options?.forceRecreate && isValidSharedStartupInfobaseAuthState(startupPaths, current)
                && current.extensionVersion === extensionVersion && await pathExists(startupPaths.markerFilePath)) {
                return reuse({ username: current.username, password: current.password });
            }
            const backups = path.join(startupPaths.rootDirectory, 'backups');
            await ensureDirectory(backups);
            backupRoot = await fs.promises.mkdtemp(path.join(backups, `${Date.now()}-`));
            const backup = path.join(backupRoot, STARTUP_INFOBASE_DIRECTORY_NAME);
            // Earlier versions stored the service account separately from the database.
            if (!current && storedAuthState && await pathExists(legacyAuthPath)) {
                await fs.promises.copyFile(legacyAuthPath, path.join(backupRoot, STARTUP_INFOBASE_AUTH_STATE_FILE_NAME));
            }
            if (!await canReplace()) { return reuse(storedAuthentication); }
            replaceSharedStartupInfobase(startupPaths.infobaseDirectory, restored, backup);
            if (fs.existsSync(backup)) {
                const message = t('Previous service infobase saved at {0}.', backup);
                output.appendLine(message);
                const open = t('Open backup folder');
                void Promise.resolve(kotUi.showInformationMessage(message, open)).then(choice => {
                    if (choice === open) { return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(backup)); }
                    return undefined;
                }).catch(() => undefined);
            }
        } finally {
            await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
            if (backupRoot && !fs.existsSync(path.join(backupRoot, STARTUP_INFOBASE_DIRECTORY_NAME))) {
                await fs.promises.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
            }
        }

        return {
            infobaseDirectory: startupPaths.infobaseDirectory,
            reusedExistingInfobase: false,
            createdInfobase: true,
            authentication
        };
    };

    const prepare = () => serializeStartupInfobasePreparation(ensureKey, performEnsure);
    const operation = Promise.resolve(options?.showProgressNotification === false
        ? prepare()
        : kotUi.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: options?.progressTitle || t('Preparing shared startup infobase...'),
                cancellable: false
            },
            async () => prepare()
        ));

    activeEnsureOperations.set(ensureKey, operation);
    try {
        return await operation;
    } finally {
        activeEnsureOperations.delete(ensureKey);
    }
}
