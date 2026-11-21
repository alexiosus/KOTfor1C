import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID, createHash } from 'node:crypto';
import { agentContains } from './agentWorkspace';

export interface AgentArchiveFile { readonly path: string; readonly size: number; readonly sha256: string }
interface ZipEntry { name: string; size: number; compressed: number; offset: number; method: number; flags: number; crc: number; directory: boolean }
export interface AgentArchiveLimits { readonly entries?: number; readonly bytes?: number; readonly centralBytes?: number }
const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) { value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; }
    return value >>> 0;
});
const safeNumber = (value: bigint) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) { throw new Error('ZIP offset exceeds the supported range.'); }
    return Number(value);
};
export function agentArchiveName(value: string): string {
    const name = value.replace(/\\/gu, '/');
    if (!name || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || /[:\u0000-\u001f]/u.test(part)
        || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
        throw new Error('Unsafe archive entry.');
    }
    return name;
}

/** ZIP/ZIP64 extraction streams DT files. Paths, sizes, CRC and link types are checked. */
export async function extractAgentArchive(archive: string, parent: string, limits: AgentArchiveLimits = {}): Promise<{ directory: string; files: AgentArchiveFile[] }> {
    const handle = await fs.open(archive, 'r');
    let ownedDirectory: string | undefined;
    const read = async (offset: number, count: number) => {
        const buffer = Buffer.alloc(count); const { bytesRead } = await handle.read(buffer, 0, count, offset);
        if (bytesRead !== count) { throw new Error('Truncated ZIP archive.'); } return buffer;
    };
    try {
        const stat = await handle.stat();
        if (stat.size < 22) { throw new Error('Invalid ZIP archive.'); }
        const tailOffset = Math.max(0, stat.size - 65557); const tail = await read(tailOffset, stat.size - tailOffset);
        let end = -1;
        for (let index = tail.length - 22; index >= 0; index--) {
            if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
        }
        if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) { throw new Error('Invalid or multi-disk ZIP archive.'); }
        let count = tail.readUInt16LE(end + 10); let centralSize = tail.readUInt32LE(end + 12); let centralOffset = tail.readUInt32LE(end + 16);
        if (count === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
            const locator = await read(tailOffset + end - 20, 20);
            if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) { throw new Error('Invalid ZIP64 locator.'); }
            const zip64 = await read(safeNumber(locator.readBigUInt64LE(8)), 56);
            if (zip64.readUInt32LE(0) !== 0x06064b50 || zip64.readUInt32LE(16) || zip64.readUInt32LE(20)) { throw new Error('Invalid ZIP64 directory.'); }
            count = safeNumber(zip64.readBigUInt64LE(32)); centralSize = safeNumber(zip64.readBigUInt64LE(40)); centralOffset = safeNumber(zip64.readBigUInt64LE(48));
        }
        if (count > (limits.entries ?? 20_000) || centralSize > (limits.centralBytes ?? 16 * 1024 * 1024)
            || centralOffset + centralSize > tailOffset + end) { throw new Error('ZIP directory exceeds the import limits.'); }
        const central = await read(centralOffset, centralSize); const entries: ZipEntry[] = []; const names = new Set<string>();
        let cursor = 0; let total = 0;
        for (let index = 0; index < count; index++) {
            if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) { throw new Error('Invalid ZIP entry.'); }
            const nameLength = central.readUInt16LE(cursor + 28); const extraLength = central.readUInt16LE(cursor + 30); const commentLength = central.readUInt16LE(cursor + 32);
            const next = cursor + 46 + nameLength + extraLength + commentLength;
            if (next > central.length) { throw new Error('Truncated ZIP directory.'); }
            const flags = central.readUInt16LE(cursor + 8); const method = central.readUInt16LE(cursor + 10);
            const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength);
            if (!(flags & 0x800) && rawName.some(byte => byte >= 128)) { throw new Error('Archive file names must use UTF-8.'); }
            const name = agentArchiveName(rawName.toString('utf8')); const key = name.replace(/\/$/u, '').toLowerCase();
            if (names.has(key)) { throw new Error('Duplicate archive entry.'); } names.add(key);
            const attributes = central.readUInt32LE(cursor + 38); const mode = attributes >>> 16 & 0xf000;
            if (mode && mode !== 0x8000 && mode !== 0x4000 || flags & 1 || ![0, 8].includes(method)) { throw new Error('Archive links, encrypted files or this compression method are unsupported.'); }
            let size = central.readUInt32LE(cursor + 24); let compressed = central.readUInt32LE(cursor + 20); let offset = central.readUInt32LE(cursor + 42);
            if ([size, compressed, offset].includes(0xffffffff)) {
                const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
                let found = false;
                for (let position = 0; position + 4 <= extra.length;) {
                    const length = extra.readUInt16LE(position + 2);
                    if (position + 4 + length > extra.length) { throw new Error('Invalid ZIP64 extra field.'); }
                    if (extra.readUInt16LE(position) === 1) {
                        let field = position + 4; const value = () => { if (field + 8 > position + 4 + length) { throw new Error('Truncated ZIP64 field.'); } const result = safeNumber(extra.readBigUInt64LE(field)); field += 8; return result; };
                        if (size === 0xffffffff) { size = value(); } if (compressed === 0xffffffff) { compressed = value(); } if (offset === 0xffffffff) { offset = value(); }
                        found = true; break;
                    }
                    position += 4 + length;
                }
                if (!found) { throw new Error('Missing ZIP64 sizes.'); }
            }
            total += size;
            if (total > (limits.bytes ?? 64 * 1024 ** 3) || offset + compressed > centralOffset) { throw new Error('Archive exceeds the import limits.'); }
            entries.push({ name, flags, method, size, compressed, offset, directory: name.endsWith('/'), crc: central.readUInt32LE(cursor + 16) }); cursor = next;
        }
        if (cursor !== central.length) { throw new Error('Unexpected ZIP directory data.'); }
        // Reject file/directory collisions before creating any destination.
        const regularFiles = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name.toLowerCase()));
        for (const entry of entries) {
            let parentName = path.posix.dirname(entry.name.replace(/\/$/u, ''));
            while (parentName !== '.') {
                if (regularFiles.has(parentName.toLowerCase())) { throw new Error('Archive path collision.'); }
                parentName = path.posix.dirname(parentName);
            }
        }
        await fs.mkdir(parent, { recursive: true }); const directory = path.resolve(parent, randomUUID());
        if (!agentContains(parent, directory)) { throw new Error('Invalid import destination.'); }
        await fs.mkdir(directory); ownedDirectory = directory; const files: AgentArchiveFile[] = [];
        for (const entry of entries) {
            const destination = path.resolve(directory, ...entry.name.split('/'));
            if (!agentContains(directory, destination)) { throw new Error('Invalid import destination.'); }
            if (entry.directory) { await fs.mkdir(destination, { recursive: true }); continue; }
            const header = await read(entry.offset, 30);
            if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== entry.method || header.readUInt16LE(6) !== entry.flags) { throw new Error('ZIP local header mismatch.'); }
            const localNameLength = header.readUInt16LE(26); const localName = await read(entry.offset + 30, localNameLength);
            if (localName.toString('utf8').replace(/\\/gu, '/') !== entry.name) { throw new Error('ZIP local name mismatch.'); }
            const start = entry.offset + 30 + localNameLength + header.readUInt16LE(28);
            if (start + entry.compressed > centralOffset) { throw new Error('ZIP payload exceeds the data region.'); }
            await fs.mkdir(path.dirname(destination), { recursive: true }); let written = 0; let crc = 0xffffffff; const hash = createHash('sha256');
            const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
                written += chunk.length;
                if (written > entry.size) { callback(new Error('ZIP payload exceeds its declared size.')); return; }
                hash.update(chunk); for (const byte of chunk) { crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; } callback(null, chunk);
            } });
            if (entry.compressed === 0) { await fs.writeFile(destination, Buffer.alloc(0), { flag: 'wx' }); }
            else {
                const source = createReadStream(archive, { start, end: start + entry.compressed - 1 });
                if (entry.method === 8) { await pipeline(source, createInflateRaw(), verify, createWriteStream(destination, { flags: 'wx' })); }
                else { await pipeline(source, verify, createWriteStream(destination, { flags: 'wx' })); }
            }
            if (written !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) { throw new Error('ZIP checksum or size mismatch.'); }
            files.push({ path: entry.name, size: written, sha256: hash.digest('hex') });
        }
        return { directory, files };
    } catch (error) {
        if (ownedDirectory && agentContains(parent, ownedDirectory) && path.resolve(parent) !== ownedDirectory) { await fs.rm(ownedDirectory, { recursive: true, force: true }); }
        throw error;
    } finally { await handle.close(); }
}
