import fs from 'node:fs/promises';
import type { TestContext } from 'node:test';

export async function createTestLink(t: Pick<TestContext, 'skip'>, target: string, link: string): Promise<boolean> {
    const directory = await fs.stat(target).then(info => info.isDirectory(), error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; }
        throw error;
    });
    try {
        await fs.symlink(target, link, directory ? process.platform === 'win32' ? 'junction' : 'dir' : 'file');
        return true;
    } catch (error) {
        if (!directory && process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
            t.skip('File symlinks require Windows Developer Mode or SeCreateSymbolicLinkPrivilege.');
            return false;
        }
        throw error;
    }
}
