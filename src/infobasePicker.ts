import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Translator } from './localization';

interface LauncherInfobaseInfo {
    name: string;
    infobasePath: string;
    sourceFilePath: string;
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

function parseInfobasePathFromConnectionString(value: string): string | null {
    const match = value.match(/File\s*=\s*("([^"]+)"|([^;]+))/i);
    if (!match) {
        return null;
    }

    const extractedPath = (match[2] || match[3] || '').trim();
    if (!extractedPath) {
        return null;
    }

    return extractedPath.replace(/[\\/]+$/, '');
}

function parseV8iInfobaseEntries(content: string, sourceFilePath: string): LauncherInfobaseInfo[] {
    const entries: LauncherInfobaseInfo[] = [];
    const sections = content
        .replace(/^\uFEFF/, '')
        .split(/\r?\n(?=\[)/g);

    for (const sectionBlock of sections) {
        const headerMatch = sectionBlock.match(/^\s*\[([^\]]+)\]/m);
        if (!headerMatch) {
            continue;
        }

        const sectionName = headerMatch[1].trim();
        if (!sectionName) {
            continue;
        }

        const connectMatch = sectionBlock.match(/^\s*Connect\s*=\s*(.+)$/im);
        if (!connectMatch) {
            continue;
        }

        const connectionString = connectMatch[1].trim();
        const infobasePath = parseInfobasePathFromConnectionString(connectionString);
        if (!infobasePath) {
            continue;
        }

        entries.push({
            name: sectionName,
            infobasePath,
            sourceFilePath
        });
    }

    return entries;
}

async function discoverLauncherInfobases(): Promise<LauncherInfobaseInfo[]> {
    if (process.platform !== 'win32') {
        return [];
    }

    const appDataPath = process.env.APPDATA || '';
    if (!appDataPath) {
        return [];
    }

    const candidateFiles = [
        path.join(appDataPath, '1C', '1CEStart', 'ibases.v8i'),
        path.join(appDataPath, '1C', '1cv8', 'ibases.v8i')
    ];
    const dedupe = new Map<string, LauncherInfobaseInfo>();

    for (const candidateFilePath of candidateFiles) {
        if (!(await pathExists(candidateFilePath))) {
            continue;
        }

        let content = '';
        try {
            content = await readUtf8File(candidateFilePath);
        } catch {
            continue;
        }

        for (const entry of parseV8iInfobaseEntries(content, candidateFilePath)) {
            const key = path.resolve(entry.infobasePath).toLowerCase();
            if (!dedupe.has(key)) {
                dedupe.set(key, {
                    ...entry,
                    infobasePath: path.resolve(entry.infobasePath)
                });
            }
        }
    }

    const entries = Array.from(dedupe.values());
    entries.sort((left, right) => {
        const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        if (byName !== 0) {
            return byName;
        }
        return left.infobasePath.localeCompare(right.infobasePath, undefined, { sensitivity: 'base' });
    });
    return entries;
}

export async function pickTargetInfobasePath(
    t: Translator,
    options?: { allowBuildOnly?: boolean; placeHolder?: string; preferredInfobasePath?: string | null }
): Promise<string | null | undefined> {
    const launcherEntries = await discoverLauncherInfobases();
    const allowBuildOnly = options?.allowBuildOnly !== false;
    const preferredInfobasePath = (options?.preferredInfobasePath || '').trim();
    const quickPickItems: Array<vscode.QuickPickItem & { kindKey: 'none' | 'manual' | 'launcher'; infobasePath?: string }> = [
        {
            label: t('Enter infobase path manually'),
            detail: t('Specify a File-based infobase directory path.'),
            kindKey: 'manual'
        },
        ...launcherEntries.map(entry => ({
            label: entry.name,
            description: entry.infobasePath,
            detail: t('From launcher: {0}', entry.sourceFilePath),
            kindKey: 'launcher' as const,
            infobasePath: entry.infobasePath
        }))
    ];
    if (preferredInfobasePath && fs.existsSync(preferredInfobasePath)) {
        quickPickItems.unshift({
            label: t('Use selected snapshot infobase'),
            description: preferredInfobasePath,
            detail: t('Use infobase parsed from selected snapshot'),
            kindKey: 'launcher',
            infobasePath: preferredInfobasePath
        });
    }
    if (allowBuildOnly) {
        quickPickItems.unshift({
            label: t('Build only (do not install to infobase)'),
            detail: t('Generate .cfe and stop after build.'),
            kindKey: 'none'
        });
    }

    const selection = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: options?.placeHolder || t('Choose target infobase for immediate extension install'),
        ignoreFocusOut: true
    });
    if (!selection) {
        return undefined;
    }

    if (selection.kindKey === 'none') {
        return null;
    }

    if (selection.kindKey === 'launcher' && selection.infobasePath) {
        return selection.infobasePath;
    }

    const manualPath = await vscode.window.showInputBox({
        title: t('Enter target infobase path'),
        placeHolder: t('Example: C:\\\\Bases\\\\SalesBase'),
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmed = value.trim();
            if (!trimmed) {
                return t('Infobase path cannot be empty.');
            }
            if (!fs.existsSync(trimmed)) {
                return t('Path does not exist: {0}', trimmed);
            }
            return null;
        }
    });
    if (!manualPath) {
        return undefined;
    }

    return path.resolve(manualPath.trim());
}
