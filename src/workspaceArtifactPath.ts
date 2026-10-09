import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { collectTreeWithConcurrencyLimit } from './boundedConcurrency';

const LEGACY_SCENARIO_ARTIFACT_MANIFEST_FILE = '.kot-build-manifest.json';

export interface ScenarioArtifactPaths {
    readonly featurePaths: string[];
    readonly jsonPaths: string[];
}

interface ScenarioArtifactPath {
    readonly kind: 'feature' | 'json';
    readonly filePath: string;
}

/**
 * Finds compiled scenario artifacts directly on disk.
 *
 * VS Code workspace search can exclude hidden runtime folders such as
 * `.vscode/kot-runtime`, especially when artifacts were written by another
 * host. A direct, bounded traversal keeps refresh independent of editor search
 * exclusions while avoiding attachment files that are not needed here.
 */
export async function collectScenarioArtifactPaths(rootPath: string): Promise<ScenarioArtifactPaths> {
    const artifacts = await collectTreeWithConcurrencyLimit<string, ScenarioArtifactPath>(
        rootPath,
        16,
        async directoryPath => {
            let entries: import('node:fs').Dirent[];
            try {
                entries = await fs.readdir(directoryPath, { withFileTypes: true });
            } catch {
                return { children: [], values: [] };
            }

            const children: string[] = [];
            const values: ScenarioArtifactPath[] = [];
            for (const entry of entries) {
                const entryPath = path.join(directoryPath, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'node_modules' && entry.name !== '.git') {
                        children.push(entryPath);
                    }
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }
                if (entry.name === LEGACY_SCENARIO_ARTIFACT_MANIFEST_FILE) {
                    continue;
                }
                const extension = path.extname(entry.name).toLowerCase();
                if (extension === '.feature') {
                    values.push({ kind: 'feature', filePath: entryPath });
                } else if (extension === '.json') {
                    values.push({ kind: 'json', filePath: entryPath });
                }
            }
            return { children, values };
        }
    );

    const comparePaths = (left: string, right: string): number => left.localeCompare(right, undefined, {
        sensitivity: 'base'
    });
    return {
        featurePaths: artifacts
            .filter(artifact => artifact.kind === 'feature')
            .map(artifact => artifact.filePath)
            .sort(comparePaths),
        jsonPaths: artifacts
            .filter(artifact => artifact.kind === 'json')
            .map(artifact => artifact.filePath)
            .sort(comparePaths)
    };
}

function stripWrappingQuotes(value: string): string {
    const trimmed = String(value ?? '').trim();
    if (trimmed.length >= 2 && (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    )) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function isWindowsAbsolute(value: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(value)
        || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}

/**
 * Resolves a build-artifact folder owned by the current workspace.
 *
 * A shared workspace may be compiled by Windows (for example in Parallels)
 * while the extension is running on macOS. In that case yaml_parameters.json
 * contains a Windows absolute path even though the same files are available
 * below the current host workspace root. The workspace-name anchor lets us
 * map only that safe, workspace-owned suffix without guessing unrelated paths.
 */
export function resolveWorkspaceOwnedPath(
    workspaceRootPath: string,
    configuredPath: string,
    platform: NodeJS.Platform = process.platform
): string | null {
    const rawPath = stripWrappingQuotes(configuredPath);
    if (!rawPath) {
        return null;
    }

    if (platform === 'win32') {
        return path.win32.normalize(path.win32.isAbsolute(rawPath)
            ? rawPath
            : path.win32.join(workspaceRootPath, rawPath));
    }

    if (isWindowsAbsolute(rawPath)) {
        const workspaceName = path.posix.basename(path.posix.normalize(workspaceRootPath));
        const segments = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
        let workspaceIndex = -1;
        for (let index = segments.length - 1; index >= 0; index -= 1) {
            if (segments[index].toLowerCase() === workspaceName.toLowerCase()) {
                workspaceIndex = index;
                break;
            }
        }
        if (workspaceIndex < 0) {
            return null;
        }
        const resolved = path.posix.resolve(workspaceRootPath, ...segments.slice(workspaceIndex + 1));
        const relative = path.posix.relative(path.posix.resolve(workspaceRootPath), resolved);
        if (relative.startsWith('..') || path.posix.isAbsolute(relative)) {
            return null;
        }
        return resolved;
    }

    if (path.posix.isAbsolute(rawPath)) {
        return path.posix.normalize(rawPath);
    }
    return path.posix.normalize(path.posix.join(
        workspaceRootPath,
        rawPath.replace(/\\/g, '/')
    ));
}
