import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Translator } from './localization';

export interface LauncherInfobaseInfo {
    name: string;
    infobasePath: string;
    sourceFilePath: string;
}

export interface RegisterLauncherInfobaseResult {
    status: 'added' | 'alreadyExists' | 'unsupported';
    registeredName: string | null;
    sourceFilePath: string | null;
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

function splitV8iSections(content: string): string[] {
    return content
        .replace(/^\uFEFF/, '')
        .split(/\r?\n(?=\[)/g)
        .filter(section => section.trim().length > 0);
}

function parseV8iInfobaseEntries(content: string, sourceFilePath: string): LauncherInfobaseInfo[] {
    const entries: LauncherInfobaseInfo[] = [];
    const sections = splitV8iSections(content);

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

function parseNumericSettingFromSection(sectionBlock: string, key: string): number | null {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'im').exec(sectionBlock);
    if (!match?.[1]) {
        return null;
    }

    const parsed = Number(match[1].trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
}

function computeNextLauncherOrder(content: string): number {
    const sections = splitV8iSections(content);
    let maxOrder = 0;
    for (const section of sections) {
        const orderInList = parseNumericSettingFromSection(section, 'OrderInList');
        const orderInTree = parseNumericSettingFromSection(section, 'OrderInTree');
        const sectionMax = Math.max(orderInList ?? 0, orderInTree ?? 0);
        if (sectionMax > maxOrder) {
            maxOrder = sectionMax;
        }
    }

    if (maxOrder <= 0) {
        return 16384;
    }

    return Math.ceil(maxOrder / 256) * 256 + 256;
}

function buildLauncherInfobaseSection(sectionName: string, infobasePath: string, order: number, newline: string): string {
    const serializedConnection = path.resolve(infobasePath).replace(/"/g, '""');
    const normalizedOrder = Number.isFinite(order) && order > 0
        ? Math.floor(order)
        : 16384;

    return [
        `[${sectionName}]`,
        `Connect=File="${serializedConnection}";`,
        `ID=${randomUUID()}`,
        `OrderInList=${normalizedOrder}`,
        'Folder=/',
        `OrderInTree=${normalizedOrder}`,
        'External=0',
        'ClientConnectionSpeed=Normal',
        'App=Auto',
        'WA=1',
        'Version=8.3',
        'DisableLocalSpeechToText=0'
    ].join(newline);
}

function detectPreferredNewline(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function bufferEndsWithNewline(buffer: Buffer): boolean {
    if (buffer.length === 0) {
        return false;
    }
    return buffer[buffer.length - 1] === 0x0a;
}

function getLauncherInfobaseFileCandidates(): string[] {
    if (process.platform !== 'win32') {
        return [];
    }

    const roamingCandidates = [
        process.env.APPDATA || '',
        process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '',
        path.join(os.homedir(), 'AppData', 'Roaming')
    ].map(candidate => candidate.trim()).filter(candidate => candidate.length > 0);
    const dedupedRoamingCandidates = Array.from(new Set(roamingCandidates.map(candidate => path.resolve(candidate))));

    const candidateFiles: string[] = [];
    for (const roamingPath of dedupedRoamingCandidates) {
        candidateFiles.push(path.join(roamingPath, '1C', '1CEStart', 'ibases.v8i'));
        candidateFiles.push(path.join(roamingPath, '1C', '1cv8', 'ibases.v8i'));
    }

    return Array.from(new Set(candidateFiles.map(candidate => path.resolve(candidate))));
}

function normalizeInfobasePathForCompare(rawPath: string): string {
    const normalized = path.resolve(rawPath.trim());
    return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
}

function collectV8iSectionNames(content: string): string[] {
    return content
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map(line => {
            const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
            return match?.[1]?.trim() || '';
        })
        .filter(name => name.length > 0);
}

function buildUniqueLauncherInfobaseName(preferredName: string, existingNames: Iterable<string>): string {
    const trimmedPreferredName = preferredName
        .replace(/[\r\n]+/g, ' ')
        .replace(/[\[\]]+/g, ' ')
        .trim();
    const baseName = trimmedPreferredName || 'KOT Infobase';
    const usedNames = new Set<string>();
    for (const existingName of existingNames) {
        const normalized = existingName.trim().toLowerCase();
        if (normalized) {
            usedNames.add(normalized);
        }
    }

    if (!usedNames.has(baseName.toLowerCase())) {
        return baseName;
    }

    let suffix = 2;
    while (true) {
        const candidate = `${baseName} (${suffix})`;
        if (!usedNames.has(candidate.toLowerCase())) {
            return candidate;
        }
        suffix += 1;
    }
}

export async function discoverLauncherInfobases(): Promise<LauncherInfobaseInfo[]> {
    const candidateFiles = getLauncherInfobaseFileCandidates();
    if (candidateFiles.length === 0) {
        return [];
    }
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
            const key = normalizeInfobasePathForCompare(entry.infobasePath);
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

export async function resolveLauncherInfobaseNameByPath(infobasePath: string): Promise<string | null> {
    const trimmedPath = infobasePath.trim();
    if (!trimmedPath) {
        return null;
    }

    const normalizedTargetPath = normalizeInfobasePathForCompare(trimmedPath);
    const entries = await discoverLauncherInfobases();
    const matchedEntry = entries.find(entry => normalizeInfobasePathForCompare(entry.infobasePath) === normalizedTargetPath);
    return matchedEntry?.name || null;
}

export async function registerInfobaseInLauncher(
    infobasePath: string,
    preferredName: string
): Promise<RegisterLauncherInfobaseResult> {
    const candidateFiles = getLauncherInfobaseFileCandidates();
    if (candidateFiles.length === 0) {
        return {
            status: 'unsupported',
            registeredName: null,
            sourceFilePath: null
        };
    }

    const normalizedTargetPath = normalizeInfobasePathForCompare(infobasePath);
    const existingEntries = await discoverLauncherInfobases();
    const existingEntry = existingEntries.find(entry => normalizeInfobasePathForCompare(entry.infobasePath) === normalizedTargetPath);
    const preferredExistingName = existingEntry?.name?.trim() || preferredName;
    let firstTouchedFilePath: string | null = existingEntry?.sourceFilePath || null;
    let registeredName: string | null = existingEntry?.name || null;
    let updatedFilesCount = 0;

    for (const candidateFilePath of candidateFiles) {
        await fs.promises.mkdir(path.dirname(candidateFilePath), { recursive: true });

        let existingBuffer = Buffer.alloc(0);
        let existingContent = '';
        try {
            existingBuffer = await fs.promises.readFile(candidateFilePath);
            existingContent = existingBuffer.toString('utf8');
        } catch {
            existingBuffer = Buffer.alloc(0);
            existingContent = '';
        }

        const fileEntries = parseV8iInfobaseEntries(existingContent, candidateFilePath);
        const alreadyPresentInThisFile = fileEntries.some(entry =>
            normalizeInfobasePathForCompare(entry.infobasePath) === normalizedTargetPath
        );
        if (alreadyPresentInThisFile) {
            if (!firstTouchedFilePath) {
                firstTouchedFilePath = candidateFilePath;
            }
            continue;
        }

        const sectionName = buildUniqueLauncherInfobaseName(preferredExistingName, collectV8iSectionNames(existingContent));
        const newline = detectPreferredNewline(existingContent);
        const sectionText = buildLauncherInfobaseSection(
            sectionName,
            infobasePath,
            computeNextLauncherOrder(existingContent),
            newline
        );
        const appendText = existingBuffer.length > 0
            ? `${bufferEndsWithNewline(existingBuffer) ? newline : `${newline}${newline}`}${sectionText}${newline}`
            : `${sectionText}${newline}`;
        await fs.promises.writeFile(candidateFilePath, Buffer.concat([
            existingBuffer,
            Buffer.from(appendText, 'utf8')
        ]));

        updatedFilesCount += 1;
        if (!firstTouchedFilePath) {
            firstTouchedFilePath = candidateFilePath;
        }
        if (!registeredName) {
            registeredName = sectionName;
        }
    }

    return {
        status: updatedFilesCount > 0 ? 'added' : 'alreadyExists',
        registeredName: registeredName || preferredExistingName || null,
        sourceFilePath: firstTouchedFilePath
    };
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
