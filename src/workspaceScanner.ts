import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TestInfo } from './types';
import { getScenarioScanRootPath, resolveScenarioScanRootFsPath } from './scenarioScanRoot';
import { buildScenarioCatalog, type ScenarioCatalog } from './scenarioCatalog';
import { collectTreeWithConcurrencyLimit, mapWithConcurrencyLimit } from './boundedConcurrency';
import { parseTestInfoFromScenarioSource } from './scenarioDescriptor';

const SCENARIO_READ_CONCURRENCY = 16;
const SCENARIO_DIRECTORY_CONCURRENCY = 16;

function buildWorkspaceUriFromFsPath(workspaceRootUri: vscode.Uri, targetFsPath: string): vscode.Uri {
    if (workspaceRootUri.scheme === 'file') {
        return vscode.Uri.file(targetFsPath);
    }

    const relativePath = path.relative(workspaceRootUri.fsPath, targetFsPath);
    if (!relativePath || relativePath === '.') {
        return workspaceRootUri;
    }
    const segments = relativePath.split(path.sep).filter(Boolean);
    return vscode.Uri.joinPath(workspaceRootUri, ...segments);
}

function normalizeFsPathForComparison(targetFsPath: string): string {
    const resolvedPath = path.resolve(targetFsPath);
    try {
        const realpathNative = fs.realpathSync.native;
        const canonicalPath = typeof realpathNative === 'function'
            ? realpathNative(resolvedPath)
            : fs.realpathSync(resolvedPath);
        return process.platform === 'win32'
            ? canonicalPath.toLowerCase()
            : canonicalPath;
    } catch {
        return process.platform === 'win32'
            ? resolvedPath.toLowerCase()
            : resolvedPath;
    }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
    const normalizedParent = normalizeFsPathForComparison(parentPath);
    const normalizedCandidate = normalizeFsPathForComparison(candidatePath);
    if (normalizedParent === normalizedCandidate) {
        return true;
    }
    return normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

async function collectFilesFromScanDirectory(
    workspaceRootUri: vscode.Uri,
    fileMatcher: (fileName: string) => boolean,
    token?: vscode.CancellationToken
): Promise<vscode.Uri[]> {
    const scanDirFsPath = resolveScenarioScanRootFsPath(workspaceRootUri);

    try {
        const stat = await fs.promises.stat(scanDirFsPath);
        if (!stat.isDirectory()) {
            return [];
        }
    } catch {
        return [];
    }

    const filePaths = await collectTreeWithConcurrencyLimit(
        scanDirFsPath,
        SCENARIO_DIRECTORY_CONCURRENCY,
        async currentDirFsPath => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(currentDirFsPath, { withFileTypes: true });
            } catch {
                return { children: [], values: [] };
            }

            const children: string[] = [];
            const values: string[] = [];
            for (const entry of entries) {
                if (token?.isCancellationRequested) {
                    break;
                }

                const entryName = entry.name;
                const entryFsPath = path.join(currentDirFsPath, entryName);

                if (entry.isDirectory()) {
                    if (entryName !== 'node_modules' && entryName !== '.git') {
                        children.push(entryFsPath);
                    }
                    continue;
                }

                if (entry.isFile() && fileMatcher(entryName)) {
                    values.push(entryFsPath);
                }
            }
            return { children, values };
        },
        () => token?.isCancellationRequested ?? false
    );

    const results = filePaths.map(filePath => buildWorkspaceUriFromFsPath(workspaceRootUri, filePath));
    results.sort((left, right) => left.fsPath.localeCompare(right.fsPath, undefined, { sensitivity: 'base' }));
    return results;
}

export async function readTextFileFast(uri: vscode.Uri): Promise<string> {
    if (uri.fsPath) {
        try {
            return await fs.promises.readFile(uri.fsPath, 'utf-8');
        } catch {
            // Fallback to VS Code file system provider below.
        }
    }

    const fileContentBytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(fileContentBytes).toString('utf-8');
}

export async function findScenarioDescriptorUris(
    workspaceRootUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<vscode.Uri[]> {
    return collectFilesFromScanDirectory(workspaceRootUri, fileName => fileName.toLowerCase() === 'scen.yaml', token);
}

export async function findYamlFilesUnderScanDir(
    workspaceRootUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<vscode.Uri[]> {
    return collectFilesFromScanDirectory(workspaceRootUri, fileName => fileName.toLowerCase().endsWith('.yaml'), token);
}

// Function to get the configured scan directory path from configuration.
// The value may be either relative to the workspace root or absolute.
export function getConfiguredScanDirPath(): string {
    return getScenarioScanRootPath();
}

// Backward-compatible alias retained for existing callers.
export function getScanDirRelativePath(): string {
    return getConfiguredScanDirPath();
}

export function resolveScanDirFsPath(workspaceRootUri: vscode.Uri): string {
    return resolveScenarioScanRootFsPath(workspaceRootUri);
}

// Паттерн для поиска файлов сценариев внутри SCAN_DIR_RELATIVE_PATH
// Используем scen.yaml, т.к. он содержит метаданные
export const SCAN_GLOB_PATTERN = '**/scen.yaml';

function computeRelativeScenarioPath(fileUri: vscode.Uri, scanDirUri: vscode.Uri): string {
    const parentDirFsPath = path.dirname(fileUri.fsPath);
    if (isPathInside(scanDirUri.fsPath, parentDirFsPath)) {
        return path.relative(scanDirUri.fsPath, parentDirFsPath).replace(/\\/g, '/');
    }
    return vscode.workspace.asRelativePath(parentDirFsPath, false);
}

async function readScenarioDefinitions(
    potentialFiles: readonly vscode.Uri[],
    scanDirUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<TestInfo[]> {
    const definitions: TestInfo[] = [];
    try {
        for (const fileUri of potentialFiles) {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            try {
                const source = await readTextFileFast(fileUri);
                const testInfo = parseTestInfoFromScenarioSource(
                    source,
                    fileUri,
                    computeRelativeScenarioPath(fileUri, scanDirUri)
                );
                if (testInfo) {
                    definitions.push(testInfo);
                }
            } catch {
                // A malformed or transiently unavailable descriptor is skipped like before.
            }
        }
    } catch (error) {
        if (error instanceof vscode.CancellationError) {
            throw error;
        }
        console.error('[WorkspaceScanner] Error scanning workspace:', error);
        vscode.window.showErrorMessage(vscode.l10n.t('Error searching for scenario files.'));
        return [];
    }

    return definitions;
}

export async function readScenarioInfo(
    fileUri: vscode.Uri,
    scanRootUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<TestInfo | null> {
    return (await readScenarioDefinitions([fileUri], scanRootUri, token))[0] || null;
}

export async function scanWorkspaceForScenarioCatalog(
    workspaceRootUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<ScenarioCatalog> {
    const startedAt = Date.now();
    const scanDirUri = vscode.Uri.file(resolveScanDirFsPath(workspaceRootUri));
    const potentialFiles = await findScenarioDescriptorUris(workspaceRootUri, token);
    const enumerationMs = Date.now() - startedAt;
    const parsedDefinitions = await mapWithConcurrencyLimit(
        potentialFiles,
        SCENARIO_READ_CONCURRENCY,
        fileUri => readScenarioInfo(fileUri, scanDirUri, token)
    );
    const readAndParseMs = Date.now() - startedAt - enumerationMs;
    if (token?.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
    const definitions = parsedDefinitions.filter((item): item is TestInfo => item !== null);
    const catalog = buildScenarioCatalog(definitions);
    const duplicateNames = [...catalog.byName.values()].filter(items => items.length > 1).length;

    console.log(
        `[WorkspaceScanner] Scanned ${catalog.all.length} definitions, ${catalog.byName.size} names, `
        + `${duplicateNames} duplicate names in ${Date.now() - startedAt} ms `
        + `(directories ${enumerationMs} ms, read/parse ${readAndParseMs} ms).`
    );
    return catalog;
}

export async function scanWorkspaceForTests(
    workspaceRootUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<Map<string, TestInfo> | null> {
    const catalog = await scanWorkspaceForScenarioCatalog(workspaceRootUri, token);
    return new Map(catalog.primaryByName);
}
