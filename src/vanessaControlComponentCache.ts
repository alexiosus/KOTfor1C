import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Download only the pinned artifact and verify before making it visible to the installer. */
export async function acquireMcpComponent(cacheRoot: string,
    component: { version: string; sha256: string; url: string }, fetcher: typeof fetch = globalThis.fetch): Promise<string> {
    const directory = path.join(cacheRoot, 'vanessa-mcp', component.sha256);
    const target = path.join(directory, 'client_mcp.cfe');
    const hash = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
    try { if (hash(await fs.readFile(target)) === component.sha256) { return target; } } catch { /* Cache miss. */ }
    const response = await fetcher(component.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) { throw new Error('Could not download the official Vanessa MCP component.'); }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > 32 * 1024 * 1024) { throw new Error('Vanessa MCP component exceeds the download limit.'); }
        chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (hash(data) !== component.sha256) { throw new Error('Vanessa MCP component checksum mismatch. Installation was cancelled.'); }
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, data, { flag: 'wx' }); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
    return target;
}
