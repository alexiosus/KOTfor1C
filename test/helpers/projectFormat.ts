import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { PROJECT_FORMAT_TEXT, projectFormatFile } from '../../src/projectFormat';
/** Explicit opt-in for fixtures that exercise the KOT 3 layout. */
export async function v3Fixture(directory: string | Promise<string>): Promise<string> {
    const root = await directory; await fs.mkdir(path.join(root, '.kot'), { recursive: true });
    await fs.writeFile(projectFormatFile(root), PROJECT_FORMAT_TEXT); return root;
}
export function v3FixtureSync(root: string): string {
    syncFs.mkdirSync(path.join(root,'.kot'),{recursive:true});
    syncFs.writeFileSync(projectFormatFile(root),PROJECT_FORMAT_TEXT);return root;
}
