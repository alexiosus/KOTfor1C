import fs from 'node:fs/promises';
import fsSync from 'node:fs';

export interface FileTailReadResult {
    content: Buffer;
    currentLength: number;
    wasTruncated: boolean;
}

const inFlightTailReads = new Map<string, Promise<FileTailReadResult | null>>();

export function isTransientFileReadError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'EBUSY' || code === 'EACCES' || code === 'EPERM';
}

async function readFileTailUnshared(
    filePath: string,
    previousLength: number
): Promise<FileTailReadResult | null> {
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(filePath, 'r');
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }

    try {
        const stat = await handle.stat();
        const normalizedPreviousLength = Number.isFinite(previousLength)
            ? Math.max(0, Math.floor(previousLength))
            : 0;
        const wasTruncated = stat.size < normalizedPreviousLength;
        const startOffset = wasTruncated ? 0 : normalizedPreviousLength;
        const byteCount = Math.max(0, stat.size - startOffset);
        const content = Buffer.allocUnsafe(byteCount);
        let bytesReadTotal = 0;

        while (bytesReadTotal < byteCount) {
            const { bytesRead } = await handle.read(
                content,
                bytesReadTotal,
                byteCount - bytesReadTotal,
                startOffset + bytesReadTotal
            );
            if (bytesRead === 0) {
                break;
            }
            bytesReadTotal += bytesRead;
        }

        return {
            content: content.subarray(0, bytesReadTotal),
            currentLength: startOffset + bytesReadTotal,
            wasTruncated
        };
    } finally {
        await handle.close();
    }
}

export function readFileTail(
    filePath: string,
    previousLength: number
): Promise<FileTailReadResult | null> {
    const normalizedPreviousLength = Number.isFinite(previousLength)
        ? Math.max(0, Math.floor(previousLength))
        : 0;
    const key = `${pathForReadKey(filePath)}\0${normalizedPreviousLength}`;
    const inFlight = inFlightTailReads.get(key);
    if (inFlight) {
        return inFlight;
    }

    let trackedRead: Promise<FileTailReadResult | null>;
    trackedRead = readFileTailUnshared(filePath, normalizedPreviousLength)
        .catch(error => {
            if (isTransientFileReadError(error)) {
                return null;
            }
            throw error;
        })
        .finally(() => {
            if (inFlightTailReads.get(key) === trackedRead) {
                inFlightTailReads.delete(key);
            }
        });
    inFlightTailReads.set(key, trackedRead);
    return trackedRead;
}

function pathForReadKey(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

export function readFileTailSync(
    filePath: string,
    previousLength: number
): FileTailReadResult | null {
    let fileDescriptor: number;
    try {
        fileDescriptor = fsSync.openSync(filePath, 'r');
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }

    try {
        const stat = fsSync.fstatSync(fileDescriptor);
        const normalizedPreviousLength = Number.isFinite(previousLength)
            ? Math.max(0, Math.floor(previousLength))
            : 0;
        const wasTruncated = stat.size < normalizedPreviousLength;
        const startOffset = wasTruncated ? 0 : normalizedPreviousLength;
        const byteCount = Math.max(0, stat.size - startOffset);
        const content = Buffer.allocUnsafe(byteCount);
        let bytesReadTotal = 0;

        while (bytesReadTotal < byteCount) {
            const bytesRead = fsSync.readSync(
                fileDescriptor,
                content,
                bytesReadTotal,
                byteCount - bytesReadTotal,
                startOffset + bytesReadTotal
            );
            if (bytesRead === 0) {
                break;
            }
            bytesReadTotal += bytesRead;
        }

        return {
            content: content.subarray(0, bytesReadTotal),
            currentLength: startOffset + bytesReadTotal,
            wasTruncated
        };
    } finally {
        fsSync.closeSync(fileDescriptor);
    }
}
