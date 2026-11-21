import { kotWindow } from './kotInteraction';
import * as vscode from 'vscode';
import path from 'node:path';
import { buildDirectSpawnCommand, runDirectProcess } from './directProcessLaunch';
import { getTranslator } from './localization';
import { getCachedInfobaseAuthentication, getManagedInfobasePreferredPlatformClientExePath, isInfobaseAuthenticationError,
    pickManagedInfobasePath, promptAndCacheInfobaseAuthentication } from './infobaseManager';
import { buildInfobaseConnectionArgument, getFileInfobasePath } from './oneCInfobaseConnection';
import { runningOneCInfobasePlatform } from './oneCInfobasePlatform';
import { resolveOneCDesignerExePath, resolveOneCPlatformForLaunch } from './oneCPlatform';
import { resolveSharedStartupPlatform } from './sharedStartupPlatform';
import { ensureSharedStartupInfobaseReady } from './startupInfobase';
import { portableSettingPath } from './kotSettingsPaths';
import { exportSpprCompiler, SpprCompilerExportError } from './spprCompilerExport';
import { redactVanessaDiagnosticText } from './vanessaControlRedaction';

const kotUi = kotWindow?.(vscode.window) ?? vscode.window;

let exporting = false;
const authenticationArgs = (auth: { username: string; password: string } | null) => auth?.username ? ['/N', auth.username, '/P', auth.password] : [];

/** Returns a path for the caller's draft; only the palette command writes the project setting. */
export async function exportSpprCompilerFromInfobase(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder,
    defaultPath?: string): Promise<string | undefined> {
    const t = await getTranslator(context.extensionUri);
    if (!vscode.workspace.isTrusted) { throw new Error(t('Trust the workspace before applying project changes.')); }
    if (process.platform !== 'win32') { throw new Error(t('1C Designer operations are supported only on Windows.')); }
    if (exporting) { throw new Error(t('SPPR compiler export is already in progress.')); }
    exporting = true;
    try {
        const source = await pickManagedInfobasePath(context, t, { allowBuildOnly: false, allowCreateNew: false,
            allowedKinds: ['file', 'server'], placeHolder: t('Select the SPPR infobase containing the compiler') });
        if (!source) { return; }
        const configured = vscode.workspace.getConfiguration('kotTestToolkit', folder.uri).get<string>('paths.buildScenarioBddEpf', 'build/BuildScenarioBDD.epf');
        const destination = await kotUi.showSaveDialog({ title: t('Save the SPPR compiler'), filters: { EPF: ['epf'] },
            defaultUri: vscode.Uri.file(path.resolve(folder.uri.fsPath, defaultPath?.trim() || configured)) });
        if (!destination) { return; }
        if (path.extname(destination.fsPath).toLowerCase() !== '.epf') { throw new Error(t('Select an .epf file for the SPPR compiler.')); }
        const portable = portableSettingPath(folder.uri.fsPath, destination.fsPath, 'project', 'folder');
        const result = await kotUi.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
            title: t('Exporting the SPPR compiler…') }, async (progress, token) => {
            const file = getFileInfobasePath(source);
            const running = file ? await runningOneCInfobasePlatform(file) : undefined;
            const platform = running || getManagedInfobasePreferredPlatformClientExePath(context, source)
                || (await resolveOneCPlatformForLaunch(t, { promptUser: false }))?.clientExePath;
            if (!platform || token.isCancellationRequested) { return; }
            let authentication = getCachedInfobaseAuthentication(source);
            const phases = { reading: t('Reading the compiler from SPPR…'), converting: t('Preparing the external compiler…'),
                preparing: t('Preparing the KOT service infobase…'), building: t('Building the compiler EPF…') };
            for (;;) {
                try {
                    return await exportSpprCompiler({ source: { executable: resolveOneCDesignerExePath(platform),
                        args: ['DESIGNER', '/IBConnectionString', buildInfobaseConnectionArgument(source), ...authenticationArgs(authentication)] },
                        destination: destination.fsPath, jobsDirectory: path.join(folder.uri.fsPath, '.vscode', 'kot-runtime', 'sppr-export'),
                        converterScript: vscode.Uri.joinPath(context.extensionUri, 'tools', 'sppr-compiler', 'convert.ps1').fsPath,
                        powershell: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }, {
                        run: (command, cwd, cancellation) => runDirectProcess(buildDirectSpawnCommand(command.executable, command.args), { cwd, token: cancellation }),
                        progress: phase => progress.report({ message: phases[phase] }),
                        prepareBuild: async () => {
                            const shared = await resolveSharedStartupPlatform(t);
                            if (!shared || token.isCancellationRequested) { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); }
                            const base = await ensureSharedStartupInfobaseReady(context, shared.clientExePath, { showProgressNotification: false });
                            return { executable: resolveOneCDesignerExePath(shared.clientExePath), args: ['DESIGNER', '/IBConnectionString',
                                buildInfobaseConnectionArgument(base.infobaseDirectory), ...authenticationArgs(base.authentication)] };
                        }
                    }, token);
                } catch (error) {
                    if (error instanceof SpprCompilerExportError && error.phase === 'reading' && isInfobaseAuthenticationError(error.message)) {
                        if (token.isCancellationRequested) { return; }
                        const provided = await promptAndCacheInfobaseAuthentication(t, source);
                        if (provided === undefined || token.isCancellationRequested) { return; }
                        authentication = provided; continue;
                    }
                    throw error;
                }
            }
        });
        return result ? portable : undefined;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') { return; }
        throw new Error(t('Could not export the SPPR compiler: {0}', redactVanessaDiagnosticText(error instanceof Error ? error.message : String(error))));
    } finally { exporting = false; }
}

export function registerSpprCompilerExportCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('kotTestToolkit.exportSpprCompiler', async () => {
        // The compiler setting and build profile apply to the window's primary project.
        const folder = vscode.workspace.workspaceFolders?.[0];
        const t = await getTranslator(context.extensionUri);
        try {
            if (!folder) { throw new Error(t('Open a workspace folder first.')); }
            const exported = await exportSpprCompilerFromInfobase(context, folder);
            if (!exported) { return; }
            await vscode.workspace.getConfiguration('kotTestToolkit', folder.uri).update('paths.buildScenarioBddEpf', exported, vscode.ConfigurationTarget.Workspace);
            void kotUi.showInformationMessage(t('SPPR compiler exported: {0}', exported));
            return exported;
        } catch (error) { void kotUi.showErrorMessage(error instanceof Error ? error.message : String(error)); }
    }));
}
