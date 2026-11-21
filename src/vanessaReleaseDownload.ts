import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import JSZip = require('jszip');

const repository = 'Pr-Mex/vanessa-automation';
const maxArchiveBytes = 128 * 1024 * 1024;
const maxExtractedBytes = 512 * 1024 * 1024;
const markerName = '.kot-vanessa-release.json';
export interface VanessaRelease {
    readonly version: string; readonly tag: string; readonly assetId: number;
    readonly url: string; readonly size: number; readonly sha256?: string;
}
export interface VanessaDownloadProgress { phase: 'download' | 'verify' | 'extract' | 'license'; completed?: number; total?: number }
const versionPattern = /^v?(\d+(?:\.\d+){2,3})$/u;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export function parseVanessaReleases(data: unknown): VanessaRelease[] {
    if (!Array.isArray(data)) { throw new Error('Could not read the official Vanessa releases.'); }
    return data.flatMap(value => {
        if (!value || typeof value !== 'object' || value.draft || value.prerelease || typeof value.tag_name !== 'string') { return []; }
        const version = versionPattern.exec(value.tag_name)?.[1];
        if (!version || !Array.isArray(value.assets)) { return []; }
        const filename = `vanessa-automation.${version}.zip`;
        const asset = value.assets.find((item: any) => item?.name === filename && item.state === 'uploaded');
        const url = `https://github.com/${repository}/releases/download/${value.tag_name}/${filename}`;
        if (!asset || asset.browser_download_url !== url || !Number.isSafeInteger(asset.id) || asset.id <= 0
            || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxArchiveBytes) { return []; }
        const digest = typeof asset.digest === 'string' ? /^sha256:([a-f\d]{64})$/iu.exec(asset.digest)?.[1].toLowerCase() : undefined;
        if (asset.digest && !digest) { return []; }
        return [{ version, tag: value.tag_name, assetId: asset.id, url, size: asset.size, ...(digest ? { sha256: digest } : {}) }];
    });
}

async function responseBytes(response: Response, maximum: number, signal: AbortSignal, progress?: (completed: number) => void): Promise<Buffer> {
    if (!response.ok || !response.body) {
        if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0') { throw new Error('GitHub request limit reached. Try again later or select an existing Vanessa distribution.'); }
        throw new Error('Could not download from the official Vanessa repository. Check the connection or select an existing distribution.');
    }
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            signal.throwIfAborted(); size += chunk.byteLength;
            if (size > maximum) { throw new Error('The Vanessa download exceeds the size limit.'); }
            chunks.push(chunk); progress?.(size);
        }
    } finally { if (signal.aborted) { await response.body.cancel().catch(() => undefined); } }
    signal.throwIfAborted(); return Buffer.concat(chunks);
}

export async function listVanessaReleasePage(page: number, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<{ releases: VanessaRelease[]; more: boolean }> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 20) { throw new Error('Invalid Vanessa release page.'); }
    const combined = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
        { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KOTfor1C' }, redirect: 'error', signal: combined });
    const data: unknown = JSON.parse((await responseBytes(response, 8 * 1024 * 1024, combined)).toString('utf8'));
    return { releases: parseVanessaReleases(data), more: Array.isArray(data) && data.length === 100 && page < 20 };
}

/** Create only project-owned folders; existing distributions are never overwritten. */
async function installParent(project: string): Promise<string> {
    const root = await fs.realpath(project); let parent = root;
    for (const segment of ['tools', 'vanessa']) {
        const candidate = path.join(parent, segment);
        try { await fs.mkdir(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
        parent = await fs.realpath(candidate);
        if (!inside(root, parent) || !(await fs.stat(parent)).isDirectory()) { throw new Error('The Vanessa destination must stay inside the project folder.'); }
    }
    return parent;
}

function safeArchiveName(entry: JSZip.JSZipObject): string {
    const name = entry.unsafeOriginalName ?? entry.name;
    const pieces = name.replace(/\/$/u, '').split('/');
    if (!name || name.includes('\\') || name.includes('\0') || pieces.some(piece => !piece || piece === '.' || piece === '..' || /[:*?"<>|]/u.test(piece)
        || /[. ]$/u.test(piece) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(piece))) {
        throw new Error('The Vanessa archive contains an unsafe path.');
    }
    const permissions = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : parseInt(entry.unixPermissions ?? '0', 8);
    if ((permissions & 0o170000) === 0o120000) { throw new Error('The Vanessa archive contains a symbolic link.'); }
    return entry.name;
}

export async function installVanessaRelease(project: string, release: VanessaRelease, options: {
    signal: AbortSignal; progress?(value: VanessaDownloadProgress): void; fetch?: typeof fetch;
}): Promise<string> {
    const version = versionPattern.exec(release.tag)?.[1];
    if (!version || version !== release.version || release.url !== `https://github.com/${repository}/releases/download/${release.tag}/vanessa-automation.${version}.zip`
        || !Number.isSafeInteger(release.size) || release.size <= 0 || release.size > maxArchiveBytes
        || release.sha256 && !/^[a-f\d]{64}$/u.test(release.sha256)) { throw new Error('Invalid official Vanessa release.'); }
    const signal = options.signal; signal.throwIfAborted();
    const parent = await installParent(project); const target = path.join(parent, version);
    const coreFiles = ['vanessa-automation.epf', 'locales/Steps.epf', 'docs/Changelog.md'];
    try {
        const existing = await fs.lstat(target);
        if (!existing.isDirectory() || existing.isSymbolicLink()) { throw new Error('occupied'); }
        const marker = JSON.parse(await fs.readFile(path.join(target, markerName), 'utf8'));
        if (marker.assetId !== release.assetId || marker.tag !== release.tag || marker.archiveSha256 !== release.sha256) { throw new Error('different release'); }
        const licenseName = (await fs.readdir(target)).find(file => /^licen[cs]e(?:\.(?:txt|md))?$/iu.test(file));
        if (!licenseName) { throw new Error('missing license'); }
        for (const file of [...coreFiles, licenseName]) {
            const stat = await fs.lstat(path.join(target, file));
            if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('changed distribution'); }
            if (hash(await fs.readFile(path.join(target, file))) !== marker.files?.[file]) { throw new Error('changed distribution'); }
        }
        signal.throwIfAborted(); return path.join(target, coreFiles[0]);
    } catch (error) {
        if (signal.aborted) { signal.throwIfAborted(); }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || await fs.lstat(target).then(() => true, () => false)) {
            throw new Error('The Vanessa version folder already exists and will not be overwritten. Select its EPF with Browse or choose another version.');
        }
    }
    const stage = path.join(parent, `.download-${randomUUID()}`);
    await fs.mkdir(stage);
    const fetcher = options.fetch ?? globalThis.fetch;
    try {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
        options.progress?.({ phase: 'download', completed: 0, total: release.size });
        const response = await fetcher(release.url, { signal: combined, redirect: 'follow' });
        const bytes = await responseBytes(response, release.size, combined, completed => options.progress?.({ phase: 'download', completed, total: release.size }));
        if (bytes.length !== release.size) { throw new Error('The Vanessa download is incomplete. Please try again.'); }
        options.progress?.({ phase: 'verify' });
        if (release.sha256 && hash(bytes) !== release.sha256) { throw new Error('The Vanessa archive checksum does not match the official release.'); }
        signal.throwIfAborted();
        const archive = await JSZip.loadAsync(bytes);
        const entries = Object.values(archive.files);
        if (entries.length > 20_000) { throw new Error('The Vanessa archive exceeds the extraction limit.'); }
        for (const entry of entries) { safeArchiveName(entry); }
        const epfs = entries.filter(entry => !entry.dir && /(?:^|\/)vanessa-automation\.epf$/iu.test(entry.name));
        if (epfs.length !== 1) { throw new Error('The full Vanessa distribution could not be found in the archive.'); }
        const prefix = epfs[0].name.slice(0, -'vanessa-automation.epf'.length);
        const files = entries.filter(entry => !entry.dir && entry.name.startsWith(prefix));
        const installed = new Set<string>(); let extracted = 0; let completed = 0;
        for (const entry of files) {
            signal.throwIfAborted();
            const relative = entry.name.slice(prefix.length); const key = relative.toLowerCase();
            const destination = path.resolve(stage, relative);
            if (!inside(stage, destination) || installed.has(key) || key === markerName) { throw new Error('The Vanessa archive contains an unsafe path.'); }
            installed.add(key); await fs.mkdir(path.dirname(destination), { recursive: true });
            const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
                extracted += chunk.length;
                callback(extracted > maxExtractedBytes ? new Error('The Vanessa archive exceeds the extraction limit.') : undefined, chunk);
            } });
            await pipeline(entry.nodeStream(), counter, createWriteStream(destination, { flags: 'wx' }), { signal });
            if (++completed % 100 === 0 || completed === files.length) { options.progress?.({ phase: 'extract', completed, total: files.length }); }
        }
        for (const file of coreFiles) {
            if (!(await fs.stat(path.join(stage, file)).catch(() => undefined))?.size) { throw new Error('The full Vanessa distribution could not be found in the archive.'); }
        }
        // Some official release ZIPs omit the main license. Retain the exact tagged notice too.
        if (!files.some(entry => /^licen[cs]e(?:\.(?:txt|md))?$/iu.test(entry.name.slice(prefix.length)))) {
            options.progress?.({ phase: 'license' });
            const license = await fetcher(`https://raw.githubusercontent.com/${repository}/${release.tag}/LICENSE`, { signal: combined, redirect: 'error' });
            await fs.writeFile(path.join(stage, 'LICENSE'), await responseBytes(license, 256 * 1024, combined), { flag: 'wx' });
        }
        const coreHashes: Record<string, string> = {};
        const licenseName = (await fs.readdir(stage)).find(file => /^licen[cs]e(?:\.(?:txt|md))?$/iu.test(file))!;
        for (const file of [...coreFiles, licenseName]) { coreHashes[file] = hash(await fs.readFile(path.join(stage, file))); }
        await fs.writeFile(path.join(stage, markerName), JSON.stringify({ tag: release.tag, assetId: release.assetId, archiveSha256: release.sha256, files: coreHashes }), { flag: 'wx' });
        signal.throwIfAborted();
        if (await fs.lstat(target).then(() => true, () => false)) { throw new Error('The Vanessa destination was created during download. Existing files were preserved.'); }
        await fs.rename(stage, target);
        return path.join(target, coreFiles[0]);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
