import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const execute = promisify(execFile);
export const agentHash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
export async function agentFileHash(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) { hash.update(chunk); }
    return hash.digest('hex');
}
export function agentContains(root: string, file: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function realPath(file: string, create: boolean): Promise<string> {
    try { return await fs.realpath(file); }
    catch (error) { if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    let parent = path.dirname(file); const suffix = [path.basename(file)];
    for (;;) {
        try { return path.join(await fs.realpath(parent), ...suffix); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(parent) === parent) { throw error; }
            suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
        }
    }
}

/** Resolve real paths, including the parent of a new file, before granting access. */
export class AgentWorkspace {
    private readonly sessionRoots = new Set<string>();
    constructor(readonly root: string, private readonly allowedRoots: () => readonly string[] = () => [],
        private readonly requestAccess?: (file: string) => Promise<boolean>) {}
    async resolve(input: string, create = false): Promise<string> {
        if (!input || /[\u0000\r\n]/u.test(input)) { throw new Error('Invalid workspace path.'); }
        const file = path.resolve(this.root, /^file:/iu.test(input) ? fileURLToPath(input) : input);
        if (file.split(/[\\/]/u).some(part => ['.git', '.aws', '.ssh'].includes(part.toLowerCase()))) {
            throw new Error('Private repository and credential files are not exposed.');
        }
        const resolved = await realPath(file, create);
        if (resolved.split(/[\\/]/u).some(part => ['.git', '.aws', '.ssh'].includes(part.toLowerCase()))
            || path.basename(resolved) === 'connection.json' && path.basename(path.dirname(resolved)) === 'agent') { throw new Error('Private files are not exposed.'); }
        const roots = await Promise.all([this.root, ...this.allowedRoots()].map(async root => {
            try { return await realPath(path.resolve(this.root, root), create); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
        }));
        if (![...roots, ...this.sessionRoots].some(root => root && agentContains(root, resolved))) {
            if (!this.requestAccess || !await this.requestAccess(resolved)) { throw new Error('Path is outside the configured agent roots.'); }
            if (await realPath(file, create) !== resolved) { throw new Error('Path changed while access was being approved. Retry with the intended path.'); }
            this.sessionRoots.add(resolved);
        }
        return resolved;
    }
    private async scan(input: string, onLine: (line: string, number: number) => void) {
        const file = await this.resolve(input);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 512 * 1024 * 1024 || /\.(?:dt|cf|cfe|epf|png|zip|1cd)$/iu.test(file)) {
            throw new Error('Use a text source or log smaller than 512 MiB. Binary artifacts stay on the local machine.');
        }
        const hash = createHash('sha256'); const decoder = new StringDecoder('utf8'); let current = ''; let total = 0; let previousCr = false; let trimmed = false;
        const append = (value: string) => { if (current.length + value.length > 8192) { trimmed = true; } current = (current + value).slice(0, 8192); };
        const consume = (inputText: string) => {
            if (inputText.includes('\u0000')) { throw new Error('Binary content cannot be read as source.'); }
            let value = inputText;
            if (previousCr && value.startsWith('\n')) { value = value.slice(1); }
            previousCr = value.endsWith('\r'); let offset = 0;
            for (const match of value.matchAll(/\r\n|\r|\n/gu)) {
                append(value.slice(offset, match.index)); onLine(current, ++total); current = ''; offset = match.index + match[0].length;
            }
            append(value.slice(offset));
        };
        for await (const chunk of createReadStream(file)) { hash.update(chunk); consume(decoder.write(chunk as Buffer)); }
        consume(decoder.end()); onLine(current, ++total);
        const after = await fs.stat(file);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) { throw new Error('Source changed while reading. Read it again.'); }
        return { path: file, sha256: hash.digest('hex'), totalLines: total, lineTruncated: trimmed };
    }
    async read(input: string, startLine = 1, count = 160) {
        const lines: string[] = []; let characters = 0; let full = false;
        const result = await this.scan(input, (line, number) => {
            if (number < startLine || number >= startLine + count || full) { return; }
            if (characters + line.length + 1 > 30000 && lines.length) { full = true; return; }
            lines.push(line); characters += line.length + 1;
        });
        const nextLine = startLine + lines.length;
        return { ...result, startLine, text: lines.join('\n'), nextLine: nextLine <= result.totalLines ? nextLine : undefined };
    }
    async search(input: string, query: string, limit = 50) {
        const matches: Array<{ line: number; text: string }> = []; let total = 0;
        const result = await this.scan(input, (line, number) => {
            if (line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) { total++; if (matches.length < limit) { matches.push({ line: number, text: line.slice(0, 1000) }); } }
        });
        return { ...result, total, matches };
    }
    async git(args: readonly string[]): Promise<string> {
        const { stdout } = await execute('git', [...args], { cwd: this.root, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
        return stdout.trimEnd();
    }
    async revision() {
        try {
            const [commit, branch, status, diff, changed, untracked, repositoryRoot] = await Promise.all([
                this.git(['rev-parse', 'HEAD']), this.git(['branch', '--show-current']), this.git(['status', '--short']),
                this.git(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.']).catch(() => null), this.git(['diff', '--name-only', '-z', 'HEAD']),
                this.git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z']), this.git(['rev-parse', '--show-toplevel'])
            ]);
            const names = [...new Set([...changed.split('\u0000'), ...untracked.split('\u0000')])].filter(file => /\.(?:bsl|xml|yaml|yml|feature|json)$/iu.test(file)).slice(0, 5000);
            const files: Array<{ path: string; sha256: string | null }> = []; let next = 0;
            await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
                while (next < names.length) {
                    const name = names[next++];
                    try { const file = await this.resolve(path.resolve(repositoryRoot, name)); files.push({ path: file, sha256: (await this.scan(file, () => {})).sha256 }); }
                    catch { files.push({ path: path.resolve(repositoryRoot, name), sha256: null }); }
                }
            }));
            return { commit, branch, status, diff, files };
        } catch { return { commit: null, branch: null, status: null, diff: null, files: [] }; }
    }
}
