import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mergeProjectMetadata, type MetadataChoices, type MetadataKind, type MetadataMerge } from './projectMetadataMerge';
import { projectGroupFile, projectHistoryFile } from './projectLibraryOrganization';
import { parse } from 'yaml';
const execute = promisify(execFile);
export async function metadataGit(root: string, args: readonly string[]): Promise<string> {
    return (await execute('git', ['--literal-pathspecs', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout;
}
export function metadataKind(relative: string): MetadataKind | undefined {
    if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
        || relative.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) { return undefined; }
    const local = relative.replace(/^.*\/(?=\.kot\/)/u, '');
    if (/^\.kot\/groups\/[^/]+\.yml$/u.test(local)) { return 'group'; }
    if (local === '.kot/property-catalogs.yml') { return 'catalogs'; }
    if (local === '.kot/test-numbering.yml') { return 'numbering'; }
    if (local === '.kot/imports.yml') { return 'imports'; }
    if (/^\.kot\/history\/[a-f0-9]{64}\.yml$/u.test(local)) { return 'history'; }
    if (/\.(?:ya?ml|feature)\.kot\.yml$/iu.test(relative) || /^\.kot\/metadata\/[^/]+\.yml$/u.test(local)) { return 'sidecar'; }
    return undefined;
}
async function safe(root: string, relative: string): Promise<string> {
    if (!metadataKind(relative)) { throw new Error('Unsupported KOT metadata path.'); }
    const file = path.resolve(root, relative);
    for (let current = file; current !== path.resolve(root); current = path.dirname(current)) {
        const stat = await fs.lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; });
        if (stat?.isSymbolicLink()) { throw new Error('KOT metadata cannot follow symbolic links.'); }
        if (current === file && stat && !stat.isFile()) { throw new Error('KOT metadata must be a regular file.'); }
    }
    return file;
}
async function read(file: string): Promise<string | undefined> {
    return fs.readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; });
}
async function stages(root: string, relative?: string): Promise<string> {
    return metadataGit(root, ['ls-files', '--unmerged', '--full-name', '-z', ...(relative ? ['--', relative] : [])]);
}
export async function listMetadataConflicts(root: string): Promise<string[]> {
    const records = (await stages(root)).split('\0').filter(Boolean);
    return [...new Set(records.map(record => record.slice(record.indexOf('\t') + 1)).filter(file => metadataKind(file)))].sort();
}
export interface MetadataResolution {
    readonly root: string; readonly relative: string; readonly original: string | undefined;
    readonly index: string; readonly merge: MetadataMerge;
}
function validateOwner(relative: string, text: string | undefined): void {
    if (text === undefined) { return; }
    const kind = metadataKind(relative); const value = parse(text);
    const root = relative.slice(0, relative.lastIndexOf('.kot/'));
    if (kind === 'group' && path.resolve(projectGroupFile(root || '.', value.id)) !== path.resolve(root || '.', relative.slice(root.length))) {
        throw new Error('Group identity does not match its metadata filename.');
    }
    if (kind === 'history' && path.resolve(projectHistoryFile(root || '.', value.key)) !== path.resolve(root || '.', relative.slice(root.length))) {
        throw new Error('History identity does not match its metadata filename.');
    }
}
/** Reconstruct Git's pristine conflict output before accepting a worktree with markers.
 * Saved partial resolutions are manual data, even if other hunks still contain markers. */
async function pristineConflict(texts: readonly (string | undefined)[], current: string): Promise<boolean> {
    const marker = /^<{7,}(?= |$)/mu.exec(current)?.[0];
    if (!marker || texts.some(text => text === undefined)) { return false; }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-metadata-merge-'));
    const normalize = (text: string) => text.replace(/\r\n/gu, '\n').replace(/^(<{7,}|>{7,}|\|{7,})(?: .*)?$/gmu, '$1');
    try {
        const files = ['base', 'ours', 'theirs'].map(name => path.join(directory, name));
        await Promise.all(files.map((file, index) => fs.writeFile(file, texts[index]!, 'utf8')));
        for (const style of [[], ['--diff3'], ['--zdiff3']]) {
            let output: string;
            try {
                output = (await execute('git', ['merge-file', '--stdout', ...style, '--marker-size', String(marker.length),
                    '-L', 'ours', '-L', 'base', '-L', 'theirs', files[1], files[0], files[2]], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout;
            } catch (error) {
                const failure = error as { code?: number; stdout?: string };
                if (typeof failure.code !== 'number' || failure.code < 1 || failure.code > 127 || typeof failure.stdout !== 'string') { continue; }
                output = failure.stdout;
            }
            if (normalize(output) === normalize(current)) { return true; }
        }
        return false;
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
export async function prepareMetadataResolution(root: string, relative: string, choices: MetadataChoices = {}): Promise<MetadataResolution> {
    const file = await safe(root, relative); const index = await stages(root, relative);
    if (!index) { throw new Error('Git index changed: this file no longer has unmerged stages.'); }
    const entries = index.split('\0').filter(Boolean).map(record => /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/u.exec(record));
    if (entries.some(entry => !entry || entry[1] !== '100644' && entry[1] !== '100755' || entry[4] !== relative)) { throw new Error('Unsupported Git conflict entries.'); }
    const texts = await Promise.all([1, 2, 3].map(async stage => entries.some(entry => entry![3] === String(stage))
        ? metadataGit(root, ['show', `:${stage}:${relative}`]) : undefined));
    const original = await read(file);
    if (original !== undefined && original !== texts[1] && original !== texts[2] && !await pristineConflict(texts, original)) {
        throw new Error('This file has manual changes. Preserve or stage your resolution before using the KOT resolver.');
    }
    const merge = mergeProjectMetadata(metadataKind(relative)!, texts[0], texts[1], texts[2], choices);
    if (!merge.conflicts.length) { validateOwner(relative, merge.text); }
    return { root, relative, index, original, merge };
}
/** Apply exactly the reviewed proposal; staging and committing remain explicit Git actions. */
export async function applyMetadataResolution(review: MetadataResolution, dirty: (file: string) => boolean): Promise<void> {
    if (review.merge.conflicts.length) { throw new Error('Resolve every field before applying.'); }
    const file = await safe(review.root, review.relative);
    const guard = async () => {
        await safe(review.root, review.relative);
        if (dirty(file)) { throw new Error('Save or cancel unsaved editor changes before applying.'); }
        if (await read(file) !== review.original || await stages(review.root, review.relative) !== review.index) { throw new Error('The file or Git index changed after review. Refresh and retry.'); }
    };
    await guard();
    if (review.merge.text === undefined) { if (review.original !== undefined) { await guard(); await fs.unlink(file); } return; }
    // Validate the concrete proposal again, including its physical identity.
    mergeProjectMetadata(metadataKind(review.relative)!, undefined, review.merge.text, review.merge.text);
    validateOwner(review.relative, review.merge.text);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, review.merge.text, { flag: 'wx' });
        await guard(); await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}
