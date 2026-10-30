import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, visit } from 'yaml';

export type ProjectFormat = { kind: 'legacy'; token: string | undefined } | { kind: 'v3'; token: string } | { kind: 'invalid'; token: string | undefined; error: string };
let translateFormatMessage = (message: string): string => message;
export function setProjectFormatTranslator(translate: (message: string) => string): void { translateFormatMessage=translate; }
export const PROJECT_FORMAT_TEXT = 'version: 3\n';
export function projectFormatFile(root: string): string { return path.join(path.resolve(root), '.kot', 'project.yml'); }
const readOptional = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
export function projectGitWatchRoots(root: string): string[] {
    const entry=path.join(path.resolve(root),'.git');
    const directive=/^gitdir:\s*(.+)\s*$/mu.exec(readOptional(entry));
    const directory=directive?path.resolve(root,directive[1].trim()):entry;
    const common=readOptional(path.join(directory,'commondir')).trim();
    return [...new Set([directory,...(common?[path.resolve(directory,common)]:[])])];
}
export function projectBranchIdentity(root: string): string {
    const directories=projectGitWatchRoots(root);const head=readOptional(path.join(directories[0],'HEAD')).trim();
    const candidate=head.startsWith('ref: refs/')?head.slice(5):undefined;
    const reference=candidate && !candidate.includes('\\') && candidate.split('/').every(part=>part && part!=='.' && part!=='..') ? candidate : undefined;
    return head ? [head,...directories.map(directory=>reference?readOptional(path.join(directory,reference))||readOptional(path.join(directory,'packed-refs')):'')].join('\0') : '';
}
function tokenFor(root: string,text?:string):string|undefined { const branch=projectBranchIdentity(root);return text===undefined?(branch?`branch:${branch}`:undefined):`${text}\0${branch}`; }
/** Read on demand, including before writes: window state must never grant a branch permission. */
export function projectFormat(root: string): ProjectFormat {
    let text: string | undefined;
    try {
        for (const file of [path.join(path.resolve(root), '.kot'), projectFormatFile(root)]) {
            try { if (fs.lstatSync(file).isSymbolicLink()) { return { kind: 'invalid', token: undefined, error: 'Project format cannot follow symbolic links.' }; } }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        }
        try { text = fs.readFileSync(projectFormatFile(root), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { kind: 'legacy', token: tokenFor(root) }; } throw error; }
        const document = parseDocument(text, { uniqueKeys: true }); let alias = false;
        visit(document, { Alias: () => { alias = true; } });
        const value: unknown = document.toJS({ maxAliasCount: 0 });
        if (document.errors.length || document.warnings.length || alias || !value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).length !== 1 || (value as Record<string, unknown>).version !== 3) {
            return { kind: 'invalid', token: text, error: 'Unsupported or conflicted project format marker.' };
        }
        return { kind: 'v3', token: tokenFor(root,text)! };
    } catch (error) { return { kind: 'invalid', token: text, error: error instanceof Error ? error.message : String(error) }; }
}
export function assertProjectFormat3(root: string, expectedToken?: string): void {
    const format = projectFormat(root);
    if (format.kind !== 'v3' || expectedToken !== undefined && format.token !== expectedToken) {
        throw new Error(translateFormatMessage('This branch has not enabled the KOT 3 project format. Use project setup for an explicit transition after preparing CI.'));
    }
}
/** Used by filesystem conversion entry points without a VS Code workspace dependency. */
export function projectFormatRoot(file: string): string {
    let current = path.resolve(file); if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) { current = path.dirname(current); }
    const initial = current;
    while (true) {
        if (fs.existsSync(path.join(current, '.kot')) || fs.existsSync(path.join(current, '.git'))) { return current; }
        const parent = path.dirname(current); if (parent === current) { return initial; } current = parent;
    }
}
export function permitsNativeScenario(file: string): boolean { return projectFormat(projectFormatRoot(file)).kind === 'v3'; }

export function assertProjectFormatUnchanged(root: string, expected: ProjectFormat): void {
    const current=projectFormat(root);if(current.kind==='invalid'||current.kind!==expected.kind||current.token!==expected.token){throw new Error(translateFormatMessage('The project format changed. Review and retry the operation.'));}
}
export function assertProjectBranchUnchanged(root: string, expected: string): void {
    if (projectBranchIdentity(root) !== expected) { throw new Error(translateFormatMessage('The project format changed. Review and retry the operation.')); }
}
