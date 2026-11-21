import { kotWindow } from './kotInteraction';
import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { VanessaControlSession } from './vanessaControlSession';
import { readMxlOpeningResult } from './mxlOpening';
import { resolveSharedStartupPlatform } from './sharedStartupPlatform';
import { ensureSharedStartupInfobaseReady, getSharedStartupInfobasePaths } from './startupInfobase';
import { buildFileInfobaseConnectionArgument } from './oneCInfobaseConnection';
import { redactVanessaDiagnosticText } from './vanessaControlRedaction';

const kotUi = kotWindow?.(vscode.window) ?? vscode.window;

function launch(executable: string, args: readonly string[]): Promise<{ exit: () => { code: number | null; signal: string | null } | undefined }> {
    return new Promise((resolve, reject) => {
        // These applications display the requested document and must have a visible window.
        const child = spawn(executable, [...args], { shell: false, windowsHide: false, stdio: 'ignore' });
        let exit: { code: number | null; signal: string | null } | undefined;
        child.once('exit', (code, signal) => { exit = { code, signal }; });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve({ exit: () => exit }); });
    });
}

async function openingFailure(logPath: string, message: string): Promise<Error> {
    const log = await fs.readFile(logPath).catch(() => undefined);
    const text = log ? log.toString(log[0] === 0xff && log[1] === 0xfe ? 'utf16le' : 'utf8') : '';
    const details = redactVanessaDiagnosticText(text).replace(/^\uFEFF/u, '').trim().slice(-4000);
    return new Error([message, details, vscode.l10n.t('1C launch log: {0}', logPath)].filter(Boolean).join('\n'));
}

/** The same MXL preference is used by scenario links, Library attachments and Explorer. */
export function createScenarioFileOpener(context: vscode.ExtensionContext, session: Pick<VanessaControlSession, 'snapshot' | 'openMxlFile'>): (uri: vscode.Uri) => Promise<boolean> {
    return async uri => {
        if (uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.mxl') { return vscode.env.openExternal(uri); }
        if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust the workspace before opening MXL files with 1C.')); }
        const resource = vscode.workspace.getWorkspaceFolder(uri) ? uri : vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        const config = vscode.workspace.getConfiguration('kotTestToolkit', resource);
        if (config.get('files.mxlOpeningMode', 'fileWorkshop') === 'fileWorkshop') {
            const executable = config.get<string>('paths.fileWorkshopExe', '').trim();
            if (!executable || !await fs.stat(executable).then(stat => stat.isFile(), () => false)) {
                throw new Error(vscode.l10n.t('Select the File Workshop executable in KOT settings or choose the 1C platform for MXL files.'));
            }
            await launch(executable, [uri.fsPath]); return true;
        }
        if (process.platform !== 'win32') { throw new Error(vscode.l10n.t('Opening MXL files through the 1C platform currently requires Windows.')); }
        return kotUi.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Opening MXL in 1C…') }, async progress => {
            const paths = getSharedStartupInfobasePaths();
            if (!paths) { throw new Error(vscode.l10n.t('Open a workspace folder first.')); }
            const directory = path.join(paths.rootDirectory, 'mxl'); await fs.mkdir(directory, { recursive: true });
            const requestDirectory = await fs.mkdtemp(path.join(directory, 'open-'));
            const resultPath = path.join(requestDirectory, 'result.json');
            if (session.snapshot.capabilities?.mxlOpen?.supported) {
                await session.openMxlFile(uri.fsPath, resultPath);
                return true;
            }
            const clientExePath = (await resolveSharedStartupPlatform((message, ...args) => vscode.l10n.t(message, ...args)))?.clientExePath;
            if (!clientExePath) { return false; }
            progress.report({ message: session.snapshot.capabilities
                ? vscode.l10n.t('Vanessa cannot open MXL through its API; using the KOT service infobase…')
                : vscode.l10n.t('Preparing the KOT service infobase…') });
            const base = await ensureSharedStartupInfobaseReady(context, clientExePath, { showProgressNotification: false });
            const requestPath = path.join(requestDirectory, 'request.json');
            await fs.writeFile(requestPath, JSON.stringify({ filePath: uri.fsPath, resultPath }), 'utf8');
            const viewer = vscode.Uri.joinPath(context.extensionUri, 'res', 'mxl', 'KOTMxlViewer.epf').fsPath;
            const logPath = path.join(requestDirectory, 'launch.log');
            progress.report({ message: vscode.l10n.t('Opening MXL in the KOT service infobase…') });
            const application = await launch(clientExePath, ['ENTERPRISE', '/IBConnectionString', buildFileInfobaseConnectionArgument(base.infobaseDirectory, { trailingSemicolon: true }),
                ...(base.authentication ? ['/N', base.authentication.username, '/P', base.authentication.password] : []),
                '/Execute', viewer, '/C', `KOTMxlViewer=${requestPath}`, '/DisableStartupMessages', '/Out', logPath]);
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
                const result = await fs.readFile(resultPath, 'utf8').catch(() => undefined);
                if (result !== undefined) { readMxlOpeningResult(result); return true; }
                const exit = application.exit();
                if (exit) { throw await openingFailure(logPath, vscode.l10n.t('1C closed before opening the MXL file (exit: {0}).', String(exit.code ?? exit.signal ?? 'unknown'))); }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            throw await openingFailure(logPath, vscode.l10n.t('1C did not confirm opening the MXL file. Check the service infobase window.'));
        });
    };
}
