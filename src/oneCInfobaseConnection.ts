import * as path from 'node:path';

export type OneCInfobaseConnection =
    | {
        kind: 'file';
        filePath: string;
    }
    | {
        kind: 'server';
        server: string;
        ref: string;
    };

function quoteConnectionValue(value: string): string {
    const escapedValue = value.replace(/"/g, '""');
    return /[\s;"]/.test(value)
        ? `"${escapedValue}"`
        : escapedValue;
}

function normalizeServerPart(value: string): string {
    return value
        .replace(/""/g, '"')
        .trim();
}

export function parseInfobaseConnectionString(value: string): OneCInfobaseConnection | null {
    const source = value.trim();
    if (!source) {
        return null;
    }

    const fileMatch = source.match(/(?:^|;)\s*File\s*=\s*("((?:[^"]|"")*)"|([^;]+))/i);
    if (fileMatch) {
        const rawPath = (fileMatch[2] || fileMatch[3] || '').trim();
        if (!rawPath) {
            return null;
        }

        return {
            kind: 'file',
            filePath: path.resolve(rawPath.replace(/""/g, '"'))
        };
    }

    const serverMatch = source.match(/(?:^|;)\s*Srvr\s*=\s*("((?:[^"]|"")*)"|([^;]+))/i);
    const refMatch = source.match(/(?:^|;)\s*Ref\s*=\s*("((?:[^"]|"")*)"|([^;]+))/i);
    if (!serverMatch || !refMatch) {
        return null;
    }

    const server = normalizeServerPart(serverMatch[2] || serverMatch[3] || '');
    const ref = normalizeServerPart(refMatch[2] || refMatch[3] || '');
    if (!server || !ref) {
        return null;
    }

    return {
        kind: 'server',
        server,
        ref
    };
}

export function coerceInfobaseConnection(value: string | OneCInfobaseConnection): OneCInfobaseConnection {
    if (typeof value !== 'string') {
        return value.kind === 'file'
            ? {
                kind: 'file',
                filePath: path.resolve(value.filePath.trim())
            }
            : {
                kind: 'server',
                server: value.server.trim(),
                ref: value.ref.trim()
            };
    }

    const parsed = parseInfobaseConnectionString(value);
    if (parsed) {
        return parsed;
    }

    return {
        kind: 'file',
        filePath: path.resolve(value.trim())
    };
}

export function isServerInfobaseConnection(value: string | OneCInfobaseConnection): boolean {
    return coerceInfobaseConnection(value).kind === 'server';
}

export function getFileInfobasePath(value: string | OneCInfobaseConnection): string | null {
    const connection = coerceInfobaseConnection(value);
    return connection.kind === 'file'
        ? connection.filePath
        : null;
}

export function buildInfobaseConnectionArgument(
    value: string | OneCInfobaseConnection,
    options?: {
        trailingSemicolon?: boolean;
    }
): string {
    const connection = coerceInfobaseConnection(value);
    const suffix = options?.trailingSemicolon ? ';' : '';

    if (connection.kind === 'file') {
        return `File=${quoteConnectionValue(connection.filePath)}${suffix}`;
    }

    return `Srvr=${quoteConnectionValue(connection.server)};Ref=${quoteConnectionValue(connection.ref)}${suffix}`;
}

export function buildFileInfobaseConnectionArgument(
    infobasePath: string,
    options?: {
        trailingSemicolon?: boolean;
    }
): string {
    return buildInfobaseConnectionArgument({
        kind: 'file',
        filePath: infobasePath
    }, options);
}

export function buildServerInfobaseConnectionArgument(
    server: string,
    ref: string,
    options?: {
        trailingSemicolon?: boolean;
    }
): string {
    return buildInfobaseConnectionArgument({
        kind: 'server',
        server,
        ref
    }, options);
}

export function normalizeInfobaseConnectionIdentity(value: string | OneCInfobaseConnection): string {
    const connection = coerceInfobaseConnection(value);
    if (connection.kind === 'file') {
        const normalizedPath = path.resolve(connection.filePath.trim());
        return process.platform === 'win32'
            ? normalizedPath.toLowerCase()
            : normalizedPath;
    }

    const normalizedServer = connection.server.trim().toLowerCase();
    const normalizedRef = connection.ref.trim().toLowerCase();
    return `srvr=${normalizedServer};ref=${normalizedRef}`;
}

export function normalizeInfobaseReference(value: string): string {
    const connection = coerceInfobaseConnection(value);
    return connection.kind === 'file'
        ? connection.filePath
        : buildInfobaseConnectionArgument(connection, { trailingSemicolon: true });
}

export function describeInfobaseConnection(value: string | OneCInfobaseConnection): string {
    const connection = coerceInfobaseConnection(value);
    return connection.kind === 'file'
        ? connection.filePath
        : `${connection.server}/${connection.ref}`;
}
