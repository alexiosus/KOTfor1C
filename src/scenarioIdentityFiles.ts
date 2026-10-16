import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import { applyPreparedFileWrites, type PreparedFileWrite } from './preparedFileWrites';
import type { ScenarioIdentityChangeResult } from './scenarioPropertyIdentity';

interface IdentityFileChangeOptions {
    sourceUri: vscode.Uri;
    uid: string;
    oldCode: string;
    code: string;
    relatedUris: readonly vscode.Uri[];
    definitionUris: readonly vscode.Uri[];
    protectedDirectories: readonly string[];
    moveFiles?: boolean;
}
interface ResourceMove { oldUri: vscode.Uri; newUri: vscode.Uri }
interface Snapshot { directories: string[]; files: Map<string, Buffer> }

function within(file: string, directory: string): boolean {
    const relative = path.relative(directory, file);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function exists(file: string): Promise<boolean> {
    try { await fs.lstat(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; } throw error; }
}
async function snapshot(resources: readonly string[]): Promise<Snapshot> {
    const result: Snapshot = { directories: [], files: new Map() };
    const visit = async (file: string): Promise<void> => {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) { throw new Error(`Identity rename cannot move symbolic links: ${file}`); }
        if (stat.isDirectory()) {
            result.directories.push(file);
            for (const entry of (await fs.readdir(file)).sort()) { await visit(path.join(file, entry)); }
        } else if (stat.isFile()) { result.files.set(file, await fs.readFile(file)); }
        else { throw new Error(`Identity rename requires regular files: ${file}`); }
    };
    for (const resource of resources) { await visit(resource); }
    return result;
}

/** Codes own dedicated code-named folders; display names and custom variants do not own paths. */
export async function prepareScenarioIdentityFileChanges(options: IdentityFileChangeOptions): Promise<{
    result: ScenarioIdentityChangeResult;
    apply(writes: readonly PreparedFileWrite<vscode.Uri>[]): Promise<void>;
}> {
    const { sourceUri, oldCode, code } = options;
    const moveFiles = options.moveFiles !== false;
    if (moveFiles && (!code || ['.git', '.kot', 'node_modules'].includes(code.toLowerCase()) || /[\x00-\x1f/\\:*?"<>|]/u.test(code) || /[. ]$/u.test(code)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(code))) {
        throw new Error('Enter a valid filename code.');
    }
    const directory = path.dirname(sourceUri.fsPath);
    let directoryMove: ResourceMove | undefined;
    let dedicatedSnapshot: Snapshot | undefined;
    const protectedDirectory = options.protectedDirectories.some(root => path.resolve(root) === path.resolve(directory));
    const canonicalSource = /^(?:scen|scenario|process)\.ya?ml$/iu.test(path.basename(sourceUri.fsPath));
    const hasCompanionDirectory = moveFiles && canonicalSource && (await Promise.all(['test', 'files'].map(async name => {
        const stat = await fs.lstat(path.join(directory, name)).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error;
        });
        return stat?.isDirectory() && !stat.isSymbolicLink();
    }))).some(Boolean);
    if (moveFiles && oldCode && (path.basename(directory) === oldCode || hasCompanionDirectory) && !protectedDirectory
        && !['.git', '.kot', 'test', 'files'].includes(path.basename(directory).toLowerCase())
        && options.definitionUris.filter(uri => within(uri.fsPath, directory)).length === 1) {
        const tree = await snapshot([directory]);
        const independent = tree.directories.some(file => ['.git', '.kot'].includes(path.basename(file).toLowerCase())) || [...tree.files].some(([file, bytes]) => {
            if (/\.feature$/iu.test(file)) { return true; }
            if (file === sourceUri.fsPath || !/\.ya?ml$/iu.test(file) || file.endsWith('.kot.yml')) { return false; }
            const yaml = ScenarioYamlDocument.parse(bytes.toString('utf8'));
            const type = String(yaml.findFieldAtPath(['ТипФайла'])?.value ?? '').trim().toLowerCase();
            return type === 'сценарий' || type === 'процесс'
                || ['настройкатеста', 'настройкапроцесса'].includes(type)
                && String(yaml.readScalar('ДанныеТеста', type === 'настройкапроцесса' ? 'UIDПроцесса' : 'UIDСценария') ?? '').trim().toLowerCase() !== options.uid.toLowerCase();
        });
        if (!independent) {
            directoryMove = { oldUri: vscode.Uri.file(directory), newUri: vscode.Uri.file(path.join(path.dirname(directory), code)) };
            dedicatedSnapshot = tree;
        }
    }
    const moves: ResourceMove[] = [];
    for (const uri of moveFiles ? new Map([sourceUri, ...options.relatedUris].map(uri => [uri.toString(), uri])).values() : []) {
        const extension = path.extname(uri.fsPath);
        const basename = path.basename(uri.fsPath, extension);
        if (!oldCode || basename !== oldCode && (!directoryMove || basename !== path.basename(directory))) { continue; }
        if (uri.toString() !== sourceUri.toString()) {
            const yaml = ScenarioYamlDocument.parse(await fs.readFile(uri.fsPath, 'utf8'));
            if (String(yaml.readScalar('ДанныеТеста', 'Код') ?? '').trim() !== oldCode) { continue; }
        }
        const newUri = vscode.Uri.file(path.join(path.dirname(uri.fsPath), `${code}${extension}`));
        if (uri.toString() === newUri.toString()) { continue; }
        moves.push({ oldUri: uri, newUri });
        if (await exists(`${uri.fsPath}.kot.yml`)) {
            moves.push({ oldUri: vscode.Uri.file(`${uri.fsPath}.kot.yml`), newUri: vscode.Uri.file(`${newUri.fsPath}.kot.yml`) });
        }
    }
    if (directoryMove && directoryMove.oldUri.toString() !== directoryMove.newUri.toString()) { moves.push(directoryMove); }
    for (const move of moves) {
        if (await exists(move.newUri.fsPath)) { throw new Error(`Rename target already exists: ${move.newUri.fsPath}`); }
    }
    const resources = directoryMove ? [directory, ...moves.filter(move => !within(move.oldUri.fsPath, directory)).map(move => move.oldUri.fsPath)]
        : moves.map(move => move.oldUri.fsPath);
    const outside = directoryMove ? await snapshot(resources.filter(resource => resource !== directory)) : undefined;
    const before = dedicatedSnapshot && outside ? {
        directories: [...dedicatedSnapshot.directories, ...outside.directories],
        files: new Map([...dedicatedSnapshot.files, ...outside.files])
    } : await snapshot(resources);
    const opened = vscode.workspace.textDocuments.filter(document => !document.isClosed
        && resources.some(resource => within(document.uri.fsPath, resource))).map(document => ({ document, version: document.version }));
    const assertSaved = () => {
        if (vscode.workspace.textDocuments.some(document => document.isDirty
            && resources.some(resource => within(document.uri.fsPath, resource)))) { throw new Error('Save modified files before changing identity.'); }
    };
    const check = async (writes: readonly PreparedFileWrite<vscode.Uri>[] = []) => {
        assertSaved();
        const current = await snapshot(resources);
        const expected = new Map(writes.map(write => [write.key.fsPath, write.after]));
        if (current.directories.join('\0') !== before.directories.join('\0') || current.files.size !== before.files.size
            || [...before.files].some(([file, bytes]) => !current.files.get(file)?.equals(expected.has(file) ? Buffer.from(expected.get(file)!, 'utf8') : bytes))) {
            throw new Error('The source files changed while changing identity. Refresh and retry.');
        }
        for (const { document, version } of opened) {
            const disk = current.files.get(document.uri.fsPath);
            if (document.isClosed || !disk || !nativeDocumentTextMatchesFileText(document.getText(), disk.toString('utf8'))
                || !expected.has(document.uri.fsPath) && document.version !== version) {
                throw new Error('The source documents changed while changing identity. Refresh and retry.');
            }
        }
        for (const move of moves) {
            if (await exists(move.newUri.fsPath)) { throw new Error(`Rename target already exists: ${move.newUri.fsPath}`); }
        }
        assertSaved();
    };
    assertSaved();
    let finalSource = sourceUri;
    for (const move of moves) {
        if (within(finalSource.fsPath, move.oldUri.fsPath)) { finalSource = vscode.Uri.file(path.join(move.newUri.fsPath, path.relative(move.oldUri.fsPath, finalSource.fsPath))); }
    }
    const result = { sourceUri: finalSource.toString(), uriMoves: moves.map(move => ({ oldUri: move.oldUri.toString(), newUri: move.newUri.toString() })) };
    const checkWrites = async (writes: readonly PreparedFileWrite<vscode.Uri>[], field: 'before' | 'after') => {
        for (const write of writes) {
            const document = vscode.workspace.textDocuments.find(document => !document.isClosed && document.uri.toString() === write.key.toString());
            if (document?.isDirty) { throw new Error('Save modified files before changing identity.'); }
            const disk = await fs.readFile(write.key.fsPath, 'utf8');
            if (disk !== write[field] || document && !nativeDocumentTextMatchesFileText(document.getText(), disk)) {
                throw new Error('The source files changed while changing identity. Refresh and retry.');
            }
        }
    };
    return { result, apply: async writes => {
        await check();
        await checkWrites(writes, 'before');
        let written = false;
        try {
            await applyPreparedFileWrites(writes, async (uri, text) => { await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8')); });
            written = true;
            // Resource edits must use the reloaded native models, including BOM-stripped editors.
            const matches = () => writes.every(write => {
                const document = vscode.workspace.textDocuments.find(document => !document.isClosed && document.uri.toString() === write.key.toString());
                return !document || !document.isDirty && nativeDocumentTextMatchesFileText(document.getText(), write.after);
            });
            for (let attempt = 0; !matches() && attempt < 100; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); }
            if (!matches()) { throw new Error('The YAML editor has not reloaded. Reopen YAML before editing identity again.'); }
            await check(writes);
            await checkWrites(writes, 'after');
            if (moves.length) {
                const edit = new vscode.WorkspaceEdit();
                for (const move of moves) { edit.renameFile(move.oldUri, move.newUri, { overwrite: false, ignoreIfExists: false }); }
                if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Could not rename identity files.'); }
            }
        } catch (error) {
            const rollbackErrors: unknown[] = [];
            for (const move of [...moves].reverse()) {
                try {
                    if (!await exists(move.oldUri.fsPath) && await exists(move.newUri.fsPath)) {
                        const edit = new vscode.WorkspaceEdit(); edit.renameFile(move.newUri, move.oldUri, { overwrite: false, ignoreIfExists: false });
                        if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Could not restore identity files.'); }
                    }
                } catch (rollbackError) { rollbackErrors.push(rollbackError); }
            }
            if (written && !rollbackErrors.length) {
                for (const write of [...writes].reverse()) {
                    try {
                        const current = await fs.readFile(write.key.fsPath, 'utf8');
                        if (current !== write.after && current !== write.before) { throw new Error(`External change preserved during rollback: ${write.key.fsPath}`); }
                        if (current === write.after) { await vscode.workspace.fs.writeFile(write.key, Buffer.from(write.before, 'utf8')); }
                    }
                    catch (rollbackError) { rollbackErrors.push(rollbackError); }
                }
            }
            if (rollbackErrors.length) { throw new AggregateError([error, ...rollbackErrors], 'Identity rename rollback was incomplete'); }
            throw error;
        }
    } };
}
