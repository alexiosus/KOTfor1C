import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertProjectBranchUnchanged, assertProjectFormat3, assertProjectFormatUnchanged, projectBranchIdentity, projectFormat, projectFormatFile, PROJECT_FORMAT_TEXT, type ProjectFormat } from './projectFormat';

const git = promisify(execFile);
const transitionBranches = new Map<string, string>();
type MarkerStamp = { dev: number; ino: number; mtimeMs: number; ctimeMs: number };

/** Work resumed after checkout must not adopt the new branch as its write baseline. */
export function assertProjectTransitionBranch(root: string): void {
    const expected = transitionBranches.get(path.resolve(root));
    if (expected !== undefined) { assertProjectBranchUnchanged(root, expected); }
}

async function revokeOwnedMarker(root: string, branch: string, owned: MarkerStamp): Promise<void> {
    const file = projectFormatFile(root);
    const unchanged = async () => {
        const stat = await fs.lstat(file).catch(() => undefined);
        return stat && !stat.isSymbolicLink() && stat.dev === owned.dev && stat.ino === owned.ino
            && stat.mtimeMs === owned.mtimeMs && stat.ctimeMs === owned.ctimeMs
            && await fs.readFile(file, 'utf8').catch(() => undefined) === PROJECT_FORMAT_TEXT;
    };
    if (!await unchanged()) { return; }
    const currentBranch = projectBranchIdentity(root);
    if (currentBranch !== branch) {
        // Checkout can retain an identical file. Preserve a marker tracked by the new
        // branch; remove only our untracked creation, with a stable Git answer.
        try {
            const { stdout } = await git('git', ['-C', root, 'ls-tree', '-z', 'HEAD', '--', '.kot/project.yml']);
            if (stdout || projectBranchIdentity(root) !== currentBranch) { return; }
        } catch { return; }
    }
    if (projectBranchIdentity(root) === currentBranch && await unchanged()) { await fs.unlink(file); }
}

/** Called only after an explicit reviewed opt-in. Rollback never revokes another branch's marker. */
export async function transitionProjectFormat3<T>(root: string, expected: ProjectFormat, work: () => Promise<T>): Promise<T> {
    root = path.resolve(root);
    assertProjectTransitionBranch(root);
    assertProjectFormatUnchanged(root, expected);
    const branch = projectBranchIdentity(root);
    const previous = transitionBranches.get(root);
    transitionBranches.set(root, branch);
    let owned: MarkerStamp | undefined;
    try {
        if (expected.kind === 'legacy') {
            const directory = path.join(root, '.kot');
            await fs.mkdir(directory, { recursive: true });
            if ((await fs.lstat(directory)).isSymbolicLink()) { throw new Error('Project format cannot follow symbolic links.'); }
            assertProjectFormatUnchanged(root, expected);
            const handle = await fs.open(projectFormatFile(root), 'wx');
            try {
                await handle.writeFile(PROJECT_FORMAT_TEXT, 'utf8');
                owned = await handle.stat();
            } finally { await handle.close(); }
        }
        assertProjectTransitionBranch(root);
        assertProjectFormat3(root);
        const enabled = projectFormat(root);
        const result = await work();
        assertProjectTransitionBranch(root);
        assertProjectFormatUnchanged(root, enabled);
        return result;
    } catch (error) {
        if (owned) { await revokeOwnedMarker(root, branch, owned); }
        throw error;
    } finally {
        if (previous === undefined) { transitionBranches.delete(root); }
        else { transitionBranches.set(root, previous); }
    }
}
