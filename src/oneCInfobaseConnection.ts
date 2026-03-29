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
    }
    | {
        kind: 'web';
        url: string;
    };

function quoteConnectionValue(value: string, forceQuotes = false): string {
    const escapedValue = value.replace(/"/g, '""');
    return forceQuotes || /[\s;"]/.test(value)
        ? `"${escapedValue}"`
        : escapedValue;
}

function normalizeServerPart(value: string): string {
    return value
        .replace(/""/g, '"')
        .trim();
}

function normalizeWebPart(value: string): string {
    return value
        .replace(/""/g, '"')
        .trim();
}

export function isWindowsAbsolutePath(value: string): boolean {
    const trimmedValue = String(value ?? '').trim();
    return /^[a-zA-Z]:[\\/]/.test(trimmedValue)
        || /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(trimmedValue);
}

export function isHostAccessibleFileInfobasePath(value: string): boolean {
    return process.platform === 'win32' || !isWindowsAbsolutePath(value);
}

function normalizeFileInfobasePath(value: string): string {
    const trimmedValue = String(value ?? '')
        .replace(/""/g, '"')
        .trim();
    if (!trimmedValue) {
        return '';
    }

    if (isWindowsAbsolutePath(trimmedValue)) {
        return path.win32.normalize(trimmedValue);
    }

    if (path.posix.isAbsolute(trimmedValue)) {
        return path.posix.normalize(trimmedValue);
    }

    return path.resolve(trimmedValue);
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
            filePath: normalizeFileInfobasePath(rawPath)
        };
    }

    const webMatch = source.match(/(?:^|;)\s*ws\s*=\s*("((?:[^"]|"")*)"|([^;]+))/i);
    if (webMatch) {
        const url = normalizeWebPart(webMatch[2] || webMatch[3] || '');
        if (!url) {
            return null;
        }

        return {
            kind: 'web',
            url
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
                filePath: normalizeFileInfobasePath(value.filePath)
            }
            : value.kind === 'server'
                ? {
                kind: 'server',
                server: value.server.trim(),
                ref: value.ref.trim()
            }
                : {
                    kind: 'web',
                    url: value.url.trim()
                };
    }

    const parsed = parseInfobaseConnectionString(value);
    if (parsed) {
        return parsed;
    }

    return {
        kind: 'file',
        filePath: normalizeFileInfobasePath(value)
    };
}

export function isServerInfobaseConnection(value: string | OneCInfobaseConnection): boolean {
    return coerceInfobaseConnection(value).kind === 'server';
}

export function isWebInfobaseConnection(value: string | OneCInfobaseConnection): boolean {
    return coerceInfobaseConnection(value).kind === 'web';
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
        forceQuotedFilePath?: boolean;
    }
): string {
    const connection = coerceInfobaseConnection(value);
    const suffix = options?.trailingSemicolon ? ';' : '';

    if (connection.kind === 'file') {
        return `File=${quoteConnectionValue(connection.filePath, options?.forceQuotedFilePath === true)}${suffix}`;
    }

    if (connection.kind === 'server') {
        return `Srvr=${quoteConnectionValue(connection.server)};Ref=${quoteConnectionValue(connection.ref)}${suffix}`;
    }

    return `ws=${quoteConnectionValue(connection.url)}${suffix}`;
}

export function buildFileInfobaseConnectionArgument(
    infobasePath: string,
    options?: {
        trailingSemicolon?: boolean;
        forceQuotedFilePath?: boolean;
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
        const normalizedPath = normalizeFileInfobasePath(connection.filePath);
        return process.platform === 'win32' || isWindowsAbsolutePath(normalizedPath)
            ? normalizedPath.toLowerCase()
            : normalizedPath;
    }

    if (connection.kind === 'server') {
        const normalizedServer = connection.server.trim().toLowerCase();
        const normalizedRef = connection.ref.trim().toLowerCase();
        return `srvr=${normalizedServer};ref=${normalizedRef}`;
    }

    return `ws=${connection.url.trim()}`;
}

export function normalizeInfobaseReference(value: string): string {
    const connection = coerceInfobaseConnection(value);
    return connection.kind === 'file'
        ? connection.filePath
        : buildInfobaseConnectionArgument(connection, { trailingSemicolon: true });
}

export function describeInfobaseConnection(value: string | OneCInfobaseConnection): string {
    const connection = coerceInfobaseConnection(value);
    if (connection.kind === 'file') {
        return connection.filePath;
    }

    if (connection.kind === 'server') {
        return `${connection.server}/${connection.ref}`;
    }

    return connection.url;
}
