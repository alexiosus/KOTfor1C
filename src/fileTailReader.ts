import fs from 'node:fs/promises';

export interface FileTailReadResult {
    content: Buffer;
    currentLength: number;
    wasTruncated: boolean;
}

export async function readFileTail(
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
