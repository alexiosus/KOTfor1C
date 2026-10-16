import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { decodeTemplateText, discoverInfobaseTemplates, parseTemplateLocations, type InfobaseTemplate } from './oneCInfobaseTemplates';
import type { Translator } from './localization';

async function templateRoots(): Promise<string[]> {
    const configured = vscode.workspace.getConfiguration('kotTestToolkit').get<string[]>('infobaseManager.templateDirectories', []);
    const roaming = [...new Set([process.env.APPDATA, process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData/Roaming') : undefined,
        path.join(os.homedir(), 'AppData/Roaming')].filter((value): value is string => !!value))];
    const locations = await Promise.all(roaming.map(async root => {
        const config = await fs.readFile(path.join(root, '1C/1CEStart/1CEStart.cfg')).catch(() => undefined);
        return [...(config ? parseTemplateLocations(decodeTemplateText(config)) : []), path.join(root, '1C/1cv8/tmplts')];
    }));
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    return [...new Set([...configured, ...locations.flat()].filter(value => value.trim()).map(value =>
        path.isAbsolute(value) || path.win32.isAbsolute(value) ? value : path.resolve(workspace, value)))];
}

export async function pickInstalledInfobaseTemplate(kind: InfobaseTemplate['kind'], t: Translator): Promise<InfobaseTemplate | undefined> {
    const roots = await templateRoots();
    while (true) {
        const templates = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Reading installed 1C templates...') },
            () => discoverInfobaseTemplates(roots));
        const items = templates.filter(template => template.kind === kind).map(template => ({ label: template.name,
            description: template.version, detail: template.filePath, template }));
        const picked = await vscode.window.showQuickPick([...items,
            { label: `$(folder-opened) ${t('Choose template directory…')}`, description: '', detail: t('Choose a tmplts directory containing installed 1cv8.mft manifests.'), template: undefined }],
        { title: t(kind === 'demo' ? 'Demo infobase template' : 'Configuration template'), matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
        if (!picked) { return undefined; }
        if (picked.template) { return picked.template; }
        const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: t('Choose template directory…'), openLabel: t('Select folder') });
        if (!folders?.length) { return undefined; }
        const directory = folders[0].fsPath;
        if (!roots.includes(directory)) { roots.unshift(directory); }
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const saved = config.get<string[]>('infobaseManager.templateDirectories', []);
        if (!saved.includes(directory)) {
            const scope = config.inspect<string[]>('infobaseManager.templateDirectories');
            const target = scope?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
                : scope?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            await config.update('infobaseManager.templateDirectories', [...saved, directory], target);
        }
    }
}
