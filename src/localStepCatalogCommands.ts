import { kotWindow } from './kotInteraction';
import * as vscode from 'vscode';
import path from 'node:path';
import { findLocalStepCategoryEpfs, generateLocalStepCatalog, localStepCatalogNeedsUpgrade, type LocalStepCatalogProgress } from './localStepCatalog';
import { withLocalStepTemplate } from './localStepCatalogDump';
import { buildDirectSpawnCommand, runDirectProcess } from './directProcessLaunch';
import { extractVanessaVersionFromChangelog, normalizeVanessaVersion } from './vanessaVersion';
import type { StepCatalogService } from './stepCatalogService';

const kotUi = kotWindow?.(vscode.window) ?? vscode.window;

/** No pickers: offline mode uses the configured distribution and the default installed platform. */
export async function generateConfiguredLocalStepCatalog(resource: vscode.Uri, onProgress?: (value: LocalStepCatalogProgress) => void): Promise<string> {
    const folder = vscode.workspace.getWorkspaceFolder(resource);
    if (!folder || !vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust the workspace before applying project changes.')); }
    const config = vscode.workspace.getConfiguration('kotTestToolkit', folder.uri);
    const epf = config.get<string>('runVanessa.vanessaEpfPath', 'tools/vanessa/vanessa-automation.epf');
    const root = path.dirname(path.resolve(folder.uri.fsPath, epf));
    const requestedVersion = config.get<string>('steps.vanessaVersion', '');
    let version = normalizeVanessaVersion(requestedVersion);
    if (!version) {
        try { version = extractVanessaVersionFromChangelog(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, 'docs', 'Changelog.md'))))); } catch { /* Report the missing local version below. */ }
    }
    if (!version) { throw new Error(vscode.l10n.t('Could not detect the local Vanessa version. Set the step catalog version in KOT settings.')); }
    const configured = config.get<string>('steps.localCatalogPath', '').trim();
    const destination = vscode.Uri.file(path.resolve(folder.uri.fsPath, configured || path.join('.kot', 'step-catalogs', `${version}.json`)));
    if (await vscode.workspace.fs.stat(destination).then(() => true, () => false)
        && !localStepCatalogNeedsUpgrade(new TextDecoder().decode(await vscode.workspace.fs.readFile(destination)))) { return destination.fsPath; }
    const hasSources = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, 'locales', 'Steps', 'Templates', 'en', 'Ext', 'Template.xml'))).then(() => true, () => false);
    const sourceEpfs = await findLocalStepCategoryEpfs(root);
    let executable: string | undefined;
    if (!hasSources || sourceEpfs.length) {
        if (!hasSources) { await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, 'locales', 'Steps.epf'))); }
        const { getConfiguredOneCPlatforms, detectInstalledOneCPlatforms, resolveOneCDesignerExePath } = await import('./oneCPlatform.js');
        const platform = getConfiguredOneCPlatforms(config)[0] ?? (await detectInstalledOneCPlatforms())[0];
        if (!platform) { throw new Error(vscode.l10n.t('No 1C platforms are configured. Configure them in settings or open the platform manager.')); }
        executable = resolveOneCDesignerExePath(platform.clientExePath);
    }
    const catalog = await kotUi.withProgress({ title: vscode.l10n.t('Generating the local Vanessa step catalog…'), location: vscode.ProgressLocation.Notification }, async (progress, token) => {
        const generate = (template?: string, sources?: string) => generateLocalStepCatalog(root, version!, undefined, hasSources ? undefined : template, sources ? [sources] : []);
        return !executable ? generate() : withLocalStepTemplate(hasSources ? undefined : path.join(root, 'locales', 'Steps.epf'), executable,
            (args, cwd) => runDirectProcess(buildDirectSpawnCommand(executable!, args), { cwd, token }), token, generate, sourceEpfs,
            (completed, total) => {
                progress.report({ message: vscode.l10n.t('Reading step categories: {0}/{1}', completed, total), increment: 100 / total });
                onProgress?.({ phase: 'exporting', completed, total });
            });
    });
    if (!catalog) { throw new Error(vscode.l10n.t('Local step catalog generation was cancelled.')); }
    const latest = vscode.workspace.getConfiguration('kotTestToolkit', folder.uri);
    if (latest.get<string>('steps.catalogMode', 'online') !== 'offline' || latest.get('runVanessa.vanessaEpfPath', 'tools/vanessa/vanessa-automation.epf') !== epf || latest.get('steps.localCatalogPath', '').trim() !== configured || latest.get('steps.vanessaVersion', '') !== requestedVersion) {
        throw new Error(vscode.l10n.t('Catalog settings changed during generation.'));
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination.fsPath)));
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(JSON.stringify(catalog, null, 2) + '\n'));
    return destination.fsPath;
}

export function registerLocalStepCatalogCommands(context: vscode.ExtensionContext, catalogs: StepCatalogService): void {
    let working = false;
    context.subscriptions.push(vscode.commands.registerCommand('kotTestToolkit.generateLocalStepCatalog', async (requestedResource?: unknown) => {
        if (working) { return; } working = true;
        try {
            const resource = requestedResource instanceof vscode.Uri ? requestedResource : vscode.window.activeTextEditor?.document.uri;
            const workspace = resource ? vscode.workspace.getWorkspaceFolder(resource) : vscode.workspace.workspaceFolders?.[0];
            if (!workspace) { throw new Error(vscode.l10n.t('Open a workspace folder first.')); }
            const config = vscode.workspace.getConfiguration('kotTestToolkit', workspace.uri);
            const epf = config.get<string>('runVanessa.vanessaEpfPath', 'tools/vanessa/vanessa-automation.epf');
            const folders = await kotUi.showOpenDialog({ title: vscode.l10n.t('Select the local Vanessa distribution folder'),
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(path.dirname(path.resolve(workspace.uri.fsPath, epf))) });
            if (!folders?.[0]) { return; }
            const root = folders[0].fsPath;
            let detected: string | null = null;
            try { detected = extractVanessaVersionFromChangelog(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, 'docs', 'Changelog.md'))))); } catch { /* Ask for a version for source-only distributions. */ }
            const version = await kotUi.showInputBox({ title: vscode.l10n.t('Vanessa version for the local step catalog'),
                value: detected ?? config.get<string>('steps.vanessaVersion', ''), ignoreFocusOut: true,
                validateInput: value => normalizeVanessaVersion(value) ? undefined : vscode.l10n.t('Enter a four-component Vanessa version.') });
            if (version === undefined) { return; }
            const templatePath = path.join(root, 'locales', 'Steps', 'Templates', 'en', 'Ext', 'Template.xml');
            const hasSources = await vscode.workspace.fs.stat(vscode.Uri.file(templatePath)).then(() => true, () => false);
            const sourceEpfs = await findLocalStepCategoryEpfs(root);
            let executable: string | undefined;
            if (!hasSources || sourceEpfs.length) {
                if (!hasSources) { await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, 'locales', 'Steps.epf'))); }
                const { resolveOneCDesignerExePath, resolveOneCPlatformForLaunch } = await import('./oneCPlatform.js');
                const platform = await resolveOneCPlatformForLaunch((message, ...args) => vscode.l10n.t(message, ...args));
                if (!platform) { return; }
                executable = resolveOneCDesignerExePath(platform.clientExePath);
            }
            const catalog = await kotUi.withProgress({ title: vscode.l10n.t('Generating the local Vanessa step catalog…'),
                location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
                const controller = new AbortController(); const disposable = token.onCancellationRequested(() => controller.abort());
                if (token.isCancellationRequested) { controller.abort(); }
                const generate = (template?: string, sources?: string) => generateLocalStepCatalog(root, normalizeVanessaVersion(version)!, controller.signal, hasSources ? undefined : template, sources ? [sources] : []);
                try {
                    return !executable ? await generate() : await withLocalStepTemplate(hasSources ? undefined : path.join(root, 'locales', 'Steps.epf'), executable,
                        (args, cwd) => runDirectProcess(buildDirectSpawnCommand(executable!, args), { cwd, token }), token, generate, sourceEpfs,
                        (completed, total) => progress.report({ message: vscode.l10n.t('Reading step categories: {0}/{1}', completed, total), increment: 100 / total }));
                }
                finally { disposable.dispose(); }
            });
            if (!catalog) { return; }
            const destination = await kotUi.showSaveDialog({ title: vscode.l10n.t('Save the local Vanessa step catalog'),
                defaultUri: vscode.Uri.joinPath(workspace.uri, '.kot', 'step-catalogs', `${catalog.vanessaVersion}.json`), filters: { JSON: ['json'] } });
            if (!destination) { return; }
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination.fsPath)));
            await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(JSON.stringify(catalog, null, 2) + '\n'));
            await config.update('steps.localCatalogPath', destination.fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
            await config.update('steps.catalogMode', 'offline', vscode.ConfigurationTarget.WorkspaceFolder);
            if (config.get<string>('steps.vanessaVersion', '').trim()) { await config.update('steps.vanessaVersion', catalog.vanessaVersion, vscode.ConfigurationTarget.WorkspaceFolder); }
            await catalogs.refresh(resource ?? workspace.uri);
            void kotUi.showInformationMessage(vscode.l10n.t('Local Vanessa catalog generated: {0} steps. Offline catalog enabled for this workspace.', catalog.steps.length));
            return destination.fsPath;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') { return; }
            void kotUi.showErrorMessage(vscode.l10n.t('Could not generate the local catalog. Select a Vanessa distribution containing locales/Steps.epf or its XML sources. {0}', error instanceof Error ? error.message : ''));
        } finally { working = false; }
    }));
}
