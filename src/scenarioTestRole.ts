import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertProjectFormat3, assertProjectFormatUnchanged, projectFormat } from './projectFormat';
import { assertProjectTransitionBranch } from './projectFormatTransition';

interface RoleRequest {
    root: string; sourcePath: string; uid: string; kind: 'scenario' | 'process'; targetMain: boolean;
    settingsPaths: readonly string[]; assertCurrent(paths?: readonly string[]): Promise<void>;
}
interface Archive { version: 1; uid: string; kind: string; sourceFolder: string; files: Array<{ path: string; archive: string; hash: string }> }
const active = new Set<string>();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function inside(root: string, file: string): string {
    const relative = path.relative(root, path.resolve(file));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) { throw new Error('The settings path is outside the source project.'); }
    return relative.replace(/\\/gu, '/');
}
async function moveExclusive(from: string, to: string): Promise<void> {
    try { await fs.link(from, to); }
    catch (error) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
        await fs.copyFile(from, to, constants.COPYFILE_EXCL);
    }
    try { await fs.unlink(from); } catch (error) { await fs.unlink(to); throw error; }
}

/** Role changes move only linked launch settings; descriptors and their references retain their identity. */
export async function convertScenarioTestRole(request: RoleRequest): Promise<'unchanged' | 'archived' | 'restored' | 'needsSettings'> {
    const root = path.resolve(request.root);
    const expectedFormat=projectFormat(root);
    const assertFormat=()=>{assertProjectTransitionBranch(root);assertProjectFormat3(root,expectedFormat.token);assertProjectFormatUnchanged(root,expectedFormat);};
    assertFormat();
    if (!/^[\w-]+$/u.test(request.uid)) { throw new Error('The source UID is invalid.'); }
    const folder = path.join(root, '.kot', 'launch-settings', `${request.kind}-${request.uid.toLowerCase()}`);
    if (active.has(folder)) { throw new Error('A role conversion is already in progress.'); }
    active.add(folder);
    const moved: Array<{ from: string; to: string }> = [];
    let createdArchive = false;
    try {
        await request.assertCurrent();
        assertFormat();
        const realRoot = await fs.realpath(root);
        inside(realRoot, await fs.realpath(request.sourcePath));
        const sourceFolder = inside(root, path.dirname(request.sourcePath));
        const sourceBytes = await fs.readFile(request.sourcePath);
        let guardedPaths = request.settingsPaths;
        const current = async () => {
            await request.assertCurrent(guardedPaths);
            assertFormat();
            if (!(await fs.readFile(request.sourcePath)).equals(sourceBytes)) { throw new Error('The source changed during role conversion.'); }
            assertFormat();
        };
        if (request.targetMain && request.settingsPaths.length) { return 'unchanged'; }
        if (!request.targetMain && !request.settingsPaths.length) { return 'unchanged'; }
        if (!request.targetMain) {
            const files = await Promise.all([...new Set(request.settingsPaths)].map(async (file, index) => {
                inside(realRoot, await fs.realpath(file));
                return { path: inside(root, file), archive: `${index}.settings.disabled`, hash: digest(await fs.readFile(file)) };
            }));
            await fs.mkdir(path.dirname(folder), { recursive: true });
            inside(realRoot, await fs.realpath(path.dirname(folder)));
            await fs.mkdir(folder); createdArchive = true;
            for (const file of files) {
                const from = path.join(root, file.path); const to = path.join(folder, file.archive);
                await current();
                if (digest(await fs.readFile(from)) !== file.hash) { throw new Error('Launch settings changed during role conversion.'); }
                assertFormat();
                await moveExclusive(from, to); moved.push({ from, to });
            }
            await current();
            await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ version: 1, uid: request.uid, kind: request.kind, sourceFolder, files } satisfies Archive, null, 2), { flag: 'wx' });
            return 'archived';
        }
        let archive: Archive;
        try { archive = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')) as Archive; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 'needsSettings'; } throw error; }
        if (archive.version !== 1 || archive.uid !== request.uid || archive.kind !== request.kind || archive.sourceFolder !== sourceFolder || !Array.isArray(archive.files)) {
            throw new Error('The archived settings do not belong to this source.');
        }
        inside(realRoot, await fs.realpath(folder));
        guardedPaths = archive.files.map(file => path.resolve(root, file.path));
        for (const file of archive.files) {
            const from = path.resolve(folder, file.archive); const to = path.resolve(root, file.path);
            inside(folder, from); inside(root, to);
            if (digest(await fs.readFile(from)) !== file.hash) { throw new Error('The archived settings changed.'); }
            try { await fs.lstat(to); throw new Error('A settings restore destination already exists.'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        }
        for (const file of archive.files) {
            const from = path.resolve(folder, file.archive); const to = path.resolve(root, file.path);
            await fs.mkdir(path.dirname(to), { recursive: true });
            inside(realRoot, await fs.realpath(path.dirname(to)));
            await current(); await moveExclusive(from, to); moved.push({ from, to });
        }
        await current();
        await fs.unlink(path.join(folder, 'manifest.json'));
        // Preserve unrelated files if someone added anything to the archive directory.
        await fs.rmdir(folder).catch(() => {});
        return 'restored';
    } catch (error) {
        const failures: unknown[] = [];
        for (const move of moved.reverse()) { try { assertFormat();await moveExclusive(move.to, move.from); } catch (failure) { failures.push(failure); } }
        if (createdArchive && !failures.length) { assertFormat();await fs.rmdir(folder).catch(() => {}); }
        if (failures.length) { throw new AggregateError([error, ...failures], `Role conversion rollback was incomplete. Preserved settings: ${folder}`); }
        throw error;
    } finally { active.delete(folder); }
}
