export interface PathOperations {
    isAbsolute(value: string): boolean;
    join(...parts: string[]): string;
    dirname(value: string): string;
    normalize(value: string): string;
}

export interface VanessaVersionCacheKey {
    readonly workspaceFolderUri: string;
    readonly epfPath: string;
    readonly override: string;
    readonly changelogMtime: number;
    readonly changelogSize: number;
}

export function normalizeVanessaVersion(value: string): string | null {
    const normalized = value.trim().replace(/^v/i, '');
    return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

export function extractVanessaVersionFromChangelog(source: string): string | null {
    for (const line of source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
        const match = line.match(/^\s*##\s+v?(\d+\.\d+\.\d+\.\d+)\s*$/i);
        if (match) {
            return match[1];
        }
    }
    return null;
}

export function resolveWorkspaceSettingPath(
    rawPath: string,
    workspaceRootPath: string,
    pathOperations: PathOperations
): string {
    const configuredPath = rawPath.trim();
    return pathOperations.normalize(
        pathOperations.isAbsolute(configuredPath)
            ? configuredPath
            : pathOperations.join(workspaceRootPath, configuredPath)
    );
}

export function getVanessaChangelogPath(
    vanessaEpfPath: string,
    pathOperations: PathOperations
): string {
    return pathOperations.join(
        pathOperations.dirname(pathOperations.normalize(vanessaEpfPath)),
        'docs',
        'Changelog.md'
    );
}
