import { projectFormat, assertProjectFormat3, projectGitWatchRoots } from './projectFormat';
import { editLegacyMetadata, legacyScenarioGroupId } from './projectLegacyMetadata';
import path from 'node:path';
import * as vscode from 'vscode';
import { parseTestInfoFromScenarioSource } from './scenarioDescriptor';
import { applyCachedProjectScenarioMetadata, createProjectLibraryStore, hasCachedProjectScenarioMetadata, loadProjectScenarioMetadata, registerProjectScenarioMetadata, cacheLegacyScenario, getCachedProjectLibrarySnapshot, clearProjectLibrarySnapshot, resolveProjectEntityIdentity, resolveProjectLibraryRoot, writeProjectScenarioMetadata } from './projectLibraryMetadata';
import { waitForProjectLibraryIdle, type ProjectEntityMetadataPatch } from './projectLibraryStore';
import type { TestInfo } from './types';
import type { CreatedProjectScenarioMetadata } from './projectLibraryMetadata';
import { setProjectSourceCleanupGuard } from './projectLibraryMetadata';

export function projectLibraryEnvironment(): { workspaceRoots: string[]; scanRoots: string[] } {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) { return { workspaceRoots: [], scanRoots: [] }; }
    const { resolveScenarioScanRootFsPath, resolveProcessScanRootFsPath } = require('./scenarioScanRoot') as typeof import('./scenarioScanRoot');
    return { workspaceRoots: folders.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
        scanRoots: [...new Set(folders.flatMap(folder => [resolveScenarioScanRootFsPath(folder.uri), resolveProcessScanRootFsPath(folder.uri)]))] };
}

export function assertProjectMetadataSaved(root: string): void {
    const metadataRoot = path.join(path.resolve(root), '.kot');
    const dirty = (vscode.workspace.textDocuments ?? []).some(document => {
        if (!document.isDirty || document.uri.scheme !== 'file') { return false; }
        const inside = (directory: string) => {
            const relative = path.relative(directory, document.uri.fsPath);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        };
        return inside(metadataRoot) || (document.uri.fsPath.toLowerCase().endsWith('.kot.yml') && inside(path.resolve(root)));
    });
    if (dirty) { throw new Error(vscode.l10n.t('Save project metadata before changing the library.')); }
}

export function assertProjectOrderingSourcesSaved(filePaths: readonly string[]): void {
    const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    const affected = new Set(filePaths.map(normalize));
    if ((vscode.workspace.textDocuments ?? []).some(document => document.isDirty && document.uri.scheme === 'file'
        && affected.has(normalize(document.uri.fsPath)))) {
        throw new Error(vscode.l10n.t('Save changed test sources before changing the library order.'));
    }
}

export function rawProjectScenario(document: Pick<vscode.TextDocument, 'uri' | 'getText'>): TestInfo | null {
    return parseTestInfoFromScenarioSource(document.getText(), document.uri, path.dirname(document.uri.fsPath));
}

export function projectedProjectScenario(document: Pick<vscode.TextDocument, 'uri' | 'getText'>): TestInfo | null {
    const info = rawProjectScenario(document);
    if (!info) { return null; }
    const env = projectLibraryEnvironment();
    return applyCachedProjectScenarioMetadata(info, env.workspaceRoots, env.scanRoots);
}

export function hasProjectMetadata(document: Pick<vscode.TextDocument, 'uri' | 'getText'>): boolean {
    const info = rawProjectScenario(document);
    if (!info) { return false; }
    const env = projectLibraryEnvironment();
    return hasCachedProjectScenarioMetadata(info, env.workspaceRoots, env.scanRoots);
}

async function bootstrapProjectMetadata(info: TestInfo, env: ReturnType<typeof projectLibraryEnvironment>): Promise<void> {
    const root = resolveProjectLibraryRoot(info.yamlFileUri.fsPath, env.workspaceRoots, env.scanRoots);
    assertProjectMetadataSaved(root);
    const identity = resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid);
    await createProjectLibraryStore(root, env.workspaceRoots, env.scanRoots, assertProjectMetadataSaved, [identity]).seedLegacyEntity(identity, {
        ...(Number.isFinite(info.order) ? { order: info.order } : {}),
        description: info.scenarioDescription ?? '', category: info.scenarioCategory ?? ''
    }, info.tabName ? { name: info.tabName, section: info.kind === 'process' ? 'process' : 'main' } : undefined);
}

export async function persistProjectMetadata(document: Pick<vscode.TextDocument, 'uri' | 'getText'>, patch: ProjectEntityMetadataPatch): Promise<boolean> {
    const info = rawProjectScenario(document);
    if (!info || document.uri.scheme !== 'file') { return false; }
    const env = projectLibraryEnvironment();
    if (!env.workspaceRoots.length && !env.scanRoots.length) { return false; }
    const root = resolveProjectLibraryRoot(document.uri.fsPath, env.workspaceRoots, env.scanRoots);
    const format = projectFormat(root);
    if (format.kind === 'invalid') { throw new Error(format.error); }
    if (format.kind !== 'v3') {
        const before = document.getText(); const current = await vscode.workspace.openTextDocument(document.uri);
        if (current.getText() !== before) { throw new Error('The source changed. Refresh and retry the metadata edit.'); }
        const groups = getCachedProjectLibrarySnapshot(root)?.groups ?? [];
        const text = editLegacyMetadata(before, patch, groups);
        if (text !== before) {
            const edit = new vscode.WorkspaceEdit(); edit.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(before.length)), text);
            if (projectFormat(root).kind === 'v3' || current.getText() !== before) { throw new Error('The project format or source changed. Refresh and retry.'); }
            if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Could not update legacy KOT metadata.'); }
        }
        const updated = rawProjectScenario(current);
        if (updated) { cacheLegacyScenario(updated, env.workspaceRoots, env.scanRoots, current.getText()); }
        return true;
    }
    await bootstrapProjectMetadata(info, env);
    await writeProjectScenarioMetadata(info, patch, env.workspaceRoots, env.scanRoots, assertProjectMetadataSaved);
    return true;
}

export async function registerCreatedProjectScenario(uri: vscode.Uri, source: string, metadata?: CreatedProjectScenarioMetadata): Promise<void> {
    const info = parseTestInfoFromScenarioSource(source, uri, path.dirname(uri.fsPath));
    if (!info) { return; }
    const env = projectLibraryEnvironment();
    if (env.workspaceRoots.length || env.scanRoots.length) {
        const root = resolveProjectLibraryRoot(uri.fsPath, env.workspaceRoots, env.scanRoots);
        const format = projectFormat(root);
        if (format.kind === 'invalid') { throw new Error(format.error); }
        if (format.kind !== 'v3') {
            const name = metadata?.groupName ?? info.tabName;
            const groups = name ? [{ id: legacyScenarioGroupId(name), name }] : [];
            const text = editLegacyMetadata(source, { groupId: groups[0]?.id ?? '', description: info.scenarioDescription ?? '', category: metadata?.category ?? info.scenarioCategory ?? '', ...(Number.isFinite(metadata?.order ?? info.order) ? { order: metadata?.order ?? info.order } : {}) }, groups);
            if(projectFormat(root).kind==='v3'){throw new Error('The project format changed. Retry scenario creation.');}
            await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
            const updated = parseTestInfoFromScenarioSource(text, uri, path.dirname(uri.fsPath));
            if(updated){cacheLegacyScenario(updated,env.workspaceRoots,env.scanRoots,text);}
            return;
        }
        assertProjectMetadataSaved(root);
        await registerProjectScenarioMetadata(info, env.workspaceRoots, env.scanRoots, assertProjectMetadataSaved, metadata);
    }
}

export async function loadSingleProjectScenario(info: TestInfo): Promise<TestInfo> {
    const env = projectLibraryEnvironment();
    if (!env.workspaceRoots.length && !env.scanRoots.length) { return info; }
    return (await loadProjectScenarioMetadata([info], env.workspaceRoots, env.scanRoots, false, assertProjectMetadataSaved))[0];
}

export async function openProjectMetadata(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const info = rawProjectScenario(document);
    if (!info) { return; }
    const env = projectLibraryEnvironment();
    const root = resolveProjectLibraryRoot(uri.fsPath, env.workspaceRoots, env.scanRoots);
    const identity = resolveProjectEntityIdentity(uri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid);
    const store = createProjectLibraryStore(root, env.workspaceRoots, env.scanRoots, assertProjectMetadataSaved, [identity]);
    assertProjectFormat3(root);
    await bootstrapProjectMetadata(info, env);
    await store.setMetadata(identity, {});
    await loadSingleProjectScenario(info);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(store.metadataFilePath(identity))));
}

export function watchProjectLibrary(context: vscode.ExtensionContext, changed: (formatChanged?: boolean) => void | Promise<void>): void {
    setProjectSourceCleanupGuard(filePath => !(vscode.workspace.textDocuments ?? []).some(document => document.isDirty
        && document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === path.resolve(filePath)));
    if (typeof vscode.workspace.createFileSystemWatcher !== 'function') { return; }
    let watchers: vscode.Disposable[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let formatRefresh = false;
    let refreshing = false; let revision = 0; let disposed = false;
    const refresh = () => {
        revision++;
        if (timer) { clearTimeout(timer); }
        if (refreshing || disposed) { return; }
        timer = setTimeout(() => {
            timer = undefined; refreshing = true;
            void (async () => {
                let consumed = revision;
                try {
                    await waitForProjectLibraryIdle();
                    consumed = revision;
                    if (!disposed) { const full=formatRefresh;formatRefresh=false;await changed(full); }
                } finally {
                    refreshing = false;
                    if (!disposed && revision !== consumed) { refresh(); }
                }
            })().catch(error => console.error('[ProjectLibrary] Metadata refresh failed:', error));
        }, 100);
    };
    const setup = () => {
        for (const watcher of watchers) { watcher.dispose(); }
        const env = projectLibraryEnvironment();
        const roots = new Set([...env.workspaceRoots, ...env.scanRoots.map(root => resolveProjectLibraryRoot(root, env.workspaceRoots, env.scanRoots))]);
        const branchChanged = () => { clearProjectLibrarySnapshot(); formatRefresh=true; refresh(); };
        watchers = [...roots].flatMap(root => {
            return ['.kot/**/*.{yaml,yml}', '**/*.kot.yml'].flatMap(pattern => {
                const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), pattern));
                const change=(uri?: vscode.Uri) => { if(uri?.fsPath.replace(/\\/gu,'/').endsWith('/.kot/project.yml')){branchChanged();}else{refresh();} };
                return [watcher, watcher.onDidCreate(change), watcher.onDidChange(change), watcher.onDidDelete(change)];
            }).concat(projectGitWatchRoots(root).flatMap(directory=>['HEAD','index','packed-refs','refs/heads/**'].flatMap(pattern=>{
                const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(directory),pattern));
                return [watcher,watcher.onDidCreate(branchChanged),watcher.onDidChange(branchChanged),watcher.onDidDelete(branchChanged)];
            })));
        });
    };
    setup();
    context.subscriptions.push({ dispose: () => { disposed = true; if (timer) { clearTimeout(timer); } for (const watcher of watchers) { watcher.dispose(); } } });
    if (vscode.workspace.onDidChangeWorkspaceFolders) { context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(setup)); }
    // The same event covers both scenario and process roots.
    context.subscriptions.push(require('./scenarioScanRoot').onDidChangeScenarioScanRoot(setup));
}
