import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface FormExplorerResolvedPaths {
    workspaceRootPath: string | null;
    snapshotPath: string | null;
    configurationSourceDirectory: string | null;
    generatedArtifactsDirectory: string | null;
}

type FormExplorerPathSettingKey =
    | 'snapshotPath'
    | 'configurationSourceDirectory'
    | 'generatedArtifactsDirectory';

function getWorkspaceRootPath(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function normalizeConfiguredPath(rawPath: string): string {
    if (rawPath.startsWith('~/')) {
        return path.join(os.homedir(), rawPath.slice(2));
    }

    return rawPath;
}

export function resolveFormExplorerPathSetting(settingKey: FormExplorerPathSettingKey): string | null {
    const rawValue = (
        vscode.workspace.getConfiguration('kotTestToolkit.formExplorer').get<string>(settingKey)
        || ''
    ).trim();

    if (!rawValue) {
        return null;
    }

    const normalizedPath = normalizeConfiguredPath(rawValue);
    if (path.isAbsolute(normalizedPath)) {
        return normalizedPath;
    }

    const workspaceRootPath = getWorkspaceRootPath();
    if (workspaceRootPath) {
        return path.resolve(workspaceRootPath, normalizedPath);
    }

    return path.resolve(process.cwd(), normalizedPath);
}

export function getFormExplorerResolvedPaths(): FormExplorerResolvedPaths {
    return {
        workspaceRootPath: getWorkspaceRootPath(),
        snapshotPath: resolveFormExplorerPathSetting('snapshotPath'),
        configurationSourceDirectory: resolveFormExplorerPathSetting('configurationSourceDirectory'),
        generatedArtifactsDirectory: resolveFormExplorerPathSetting('generatedArtifactsDirectory')
    };
}

export function getFormExplorerSnapshotPath(): string | null {
    return resolveFormExplorerPathSetting('snapshotPath');
}

export function getFormExplorerConfigurationSourceDirectory(): string | null {
    return resolveFormExplorerPathSetting('configurationSourceDirectory');
}

export function getFormExplorerGeneratedArtifactsDirectory(): string | null {
    return resolveFormExplorerPathSetting('generatedArtifactsDirectory');
}
