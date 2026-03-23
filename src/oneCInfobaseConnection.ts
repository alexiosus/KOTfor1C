import * as path from 'node:path';

export function buildFileInfobaseConnectionArgument(
    infobasePath: string,
    options?: {
        trailingSemicolon?: boolean;
    }
): string {
    const trimmedPath = infobasePath.trim();
    const resolvedPath = trimmedPath
        ? path.resolve(trimmedPath)
        : '';
    const escapedPath = resolvedPath.replace(/"/g, '""');
    const needsQuoting = /[\s;"]/.test(resolvedPath);
    const serializedPath = needsQuoting
        ? `"${escapedPath}"`
        : escapedPath;
    return `File=${serializedPath}${options?.trailingSemicolon ? ';' : ''}`;
}
