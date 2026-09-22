import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TestInfo } from './types';
import { getScenarioScanRootPath, resolveScenarioScanRootFsPath } from './scenarioScanRoot';
import { buildScenarioCatalog, type ScenarioCatalog } from './scenarioCatalog';
import { collectTreeWithConcurrencyLimit, mapWithConcurrencyLimit } from './boundedConcurrency';
import { parseTestInfoFromScenarioSource } from './scenarioDescriptor';

const SCENARIO_READ_CONCURRENCY = 32;
const SCENARIO_DIRECTORY_CONCURRENCY = 16;

interface ScenarioScanMetrics {
    readonly readLatenciesMs: number[];
    pathTotalMs: number;
    parseTotalMs: number;
    fallbackAttempts: number;
}

function percentileMs(values: readonly number[], percentile: number): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    return Math.round(sorted[Math.ceil(sorted.length * percentile) - 1]);
}

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

export async function readTextFileFast(uri: vscode.Uri, metrics?: ScenarioScanMetrics): Promise<string> {
    if (uri.fsPath) {
        try {
            return await fs.promises.readFile(uri.fsPath, 'utf-8');
        } catch {
            // Fallback to VS Code file system provider below.
        }
    }

    if (metrics) {
        metrics.fallbackAttempts += 1;
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

function computeRelativeScenarioPath(
    fileUri: vscode.Uri,
    scanDirUri: vscode.Uri,
    fromEnumeratedScan = false
): string {
    const parentDirFsPath = path.dirname(fileUri.fsPath);
    const relativePath = path.relative(scanDirUri.fsPath, parentDirFsPath);
    const lexicallyInside = relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath);
    if ((fromEnumeratedScan && lexicallyInside) || isPathInside(scanDirUri.fsPath, parentDirFsPath)) {
        return relativePath.replace(/\\/g, '/');
    }
    return vscode.workspace.asRelativePath(parentDirFsPath, false);
}

async function readScenarioDefinitions(
    potentialFiles: readonly vscode.Uri[],
    scanDirUri: vscode.Uri,
    token?: vscode.CancellationToken,
    metrics?: ScenarioScanMetrics,
    fromEnumeratedScan = false
): Promise<TestInfo[]> {
    const definitions: TestInfo[] = [];
    try {
        for (const fileUri of potentialFiles) {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            try {
                const readStartedAt = performance.now();
                const source = await readTextFileFast(fileUri, metrics);
                metrics?.readLatenciesMs.push(performance.now() - readStartedAt);
                const pathStartedAt = performance.now();
                const relativePath = computeRelativeScenarioPath(fileUri, scanDirUri, fromEnumeratedScan);
                if (metrics) {
                    metrics.pathTotalMs += performance.now() - pathStartedAt;
                }
                const parseStartedAt = performance.now();
                const testInfo = parseTestInfoFromScenarioSource(
                    source,
                    fileUri,
                    relativePath
                );
                if (metrics) {
                    metrics.parseTotalMs += performance.now() - parseStartedAt;
                }
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
    token?: vscode.CancellationToken,
    metrics?: ScenarioScanMetrics
): Promise<TestInfo | null> {
    return (await readScenarioDefinitions([fileUri], scanRootUri, token, metrics))[0] || null;
}

export async function scanWorkspaceForScenarioCatalog(
    workspaceRootUri: vscode.Uri,
    token?: vscode.CancellationToken
): Promise<ScenarioCatalog> {
    const startedAt = Date.now();
    const scanDirUri = vscode.Uri.file(resolveScanDirFsPath(workspaceRootUri));
    const potentialFiles = await findScenarioDescriptorUris(workspaceRootUri, token);
    const enumerationMs = Date.now() - startedAt;
    const metrics: ScenarioScanMetrics = {
        readLatenciesMs: [], pathTotalMs: 0, parseTotalMs: 0, fallbackAttempts: 0
    };
    const parsedDefinitions = await mapWithConcurrencyLimit(
        potentialFiles,
        SCENARIO_READ_CONCURRENCY,
        // These paths came from readdir beneath scanDirUri; symlink entries are not traversed.
        async fileUri => (await readScenarioDefinitions([fileUri], scanDirUri, token, metrics, true))[0] || null
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
        + `(directories ${enumerationMs} ms, read/parse ${readAndParseMs} ms; `
        + `read p50 ${percentileMs(metrics.readLatenciesMs, 0.5)} ms, `
        + `p95 ${percentileMs(metrics.readLatenciesMs, 0.95)} ms, `
        + `path ${Math.round(metrics.pathTotalMs)} ms, `
        + `parse ${Math.round(metrics.parseTotalMs)} ms, `
        + `fallback attempts ${metrics.fallbackAttempts}).`
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
