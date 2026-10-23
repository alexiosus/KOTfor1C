import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';

export interface CallableFileChange { path: string; before?: string; after?: string }
const active = new Set<string>();
async function absent(file: string): Promise<void> {
    try { await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
    throw new Error(`Conversion destination already exists: ${file}`);
}
async function current(change: CallableFileChange): Promise<void> {
    if (change.before === undefined) { return absent(change.path); }
    if (!(await fs.lstat(change.path)).isFile() || await fs.readFile(change.path, 'utf8') !== change.before) {
        throw new Error(`Source changed during conversion: ${change.path}`);
    }
}
async function linkOrCopyExclusive(from: string, to: string): Promise<void> {
    try { await fs.link(from, to); }
    catch (error) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
        await fs.copyFile(from, to, constants.COPYFILE_EXCL);
    }
}

/** Stage outputs first; links or exclusive copies preserve concurrent writers, including during rollback. */
export async function applyCallableFileConversion(changes: readonly CallableFileChange[], assertSaved: () => Promise<void>): Promise<void> {
    const keys = changes.map(change => path.resolve(change.path));
    if (new Set(keys).size !== keys.length || keys.some(key => active.has(key))) { throw new Error('Overlapping scenario conversion. Please retry.'); }
    keys.forEach(key => active.add(key));
    const staged = new Map<string, string>(); const backups = new Map<string, string>(); const installed = new Map<string, string>();
    const directories: string[] = [];
    const ensureDirectory = async (directory: string): Promise<void> => {
        try { if (!(await fs.lstat(directory)).isDirectory()) { throw new Error(`Destination parent must be a regular directory: ${directory}`); } return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        await ensureDirectory(path.dirname(directory));
        try { await fs.mkdir(directory); directories.push(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } await ensureDirectory(directory); }
    };
    let committed = false;
    try {
        await assertSaved();
        for (const change of changes) {
            await current(change);
            if (change.after !== undefined && change.after !== change.before) {
                await ensureDirectory(path.dirname(change.path));
                const temporary = path.join(path.dirname(change.path), `.kot-callable-${randomUUID()}.new`);
                await fs.writeFile(temporary, change.after, { flag: 'wx' }); staged.set(change.path, temporary);
            }
        }
        await assertSaved();
        for (const change of changes) { await current(change); }
        for (const change of changes) {
            if (change.after === change.before) { continue; }
            if (change.before !== undefined) {
                const backup = path.join(path.dirname(change.path), `.kot-callable-${randomUUID()}.backup`);
                await linkOrCopyExclusive(change.path, backup); backups.set(change.path, backup); await fs.unlink(change.path);
            }
            const temporary = staged.get(change.path);
            if (temporary) { await linkOrCopyExclusive(temporary, change.path); installed.set(change.path, change.after!); }
            await assertSaved();
        }
        for (const change of changes) { await current({ path: change.path, before: change.after }); }
        committed = true;
    } catch (error) {
        const failures: unknown[] = [];
        for (const [file, expected] of [...installed].reverse()) {
            try {
                if (await fs.readFile(file, 'utf8') !== expected) { throw new Error(`Destination changed; recovery backup retained for ${file}`); }
                await fs.unlink(file);
            } catch (reason) { failures.push(reason); }
        }
        for (const [file, backup] of [...backups].reverse()) {
            try { await linkOrCopyExclusive(backup, file); await fs.unlink(backup); backups.delete(file); }
            catch (reason) { failures.push(new Error(`Recovery copy retained at ${backup}`, { cause: reason })); }
        }
        if (failures.length) { throw new AggregateError([error, ...failures], `Conversion failed. Recovery copies: ${[...backups.values()].join(', ')}`, { cause: error }); }
        throw error;
    } finally {
        // Cleanup only our known temporary files. Never remove unrelated/concurrently created paths.
        try {
            for (const file of staged.values()) { await fs.unlink(file); }
            if (committed) { for (const file of backups.values()) { await fs.unlink(file); } }
            else { for (const directory of [...directories].reverse()) { await fs.rmdir(directory).catch(() => undefined); } }
        } finally { keys.forEach(key => active.delete(key)); }
    }
}
