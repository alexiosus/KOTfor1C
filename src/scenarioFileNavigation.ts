import { kotWindow, assertKotPath } from './kotInteraction';
import * as vscode from 'vscode';
import path from 'node:path';
import type { StepLibrarySnapshotService } from './stepLibrarySnapshotService';
import type { StepLibraryItem } from './stepLibraryModel';
import type { ScenarioFilesService } from './scenarioFilesService';
import { collectScenarioFileReferences, fileReferenceAliases, fileReferencesOnLine, matchesFileReference, normalizeFileReference, type ScenarioFileReference } from './scenarioFileReferences';

const kotUi = kotWindow?.(vscode.window) ?? vscode.window;

interface Candidate { relativePath: string; label: string; owner: string; item?: StepLibraryItem; uri?: vscode.Uri }
interface LinkRequest extends ScenarioFileReference { source: string }
const supported = (uri: vscode.Uri) => uri.scheme === 'file' && /\.(?:ya?ml|feature)$/iu.test(uri.path);
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const exclude = '**/{.git,.svn,node_modules}/**';

/** Share the Library's attachment inventory and external opener; search globally only on explicit requests. */
export class ScenarioFileNavigation implements vscode.DocumentLinkProvider, vscode.Disposable {
    private workspaceFiles?: Promise<readonly Candidate[]>;
    private disposed = false;
    private readonly subscriptions: vscode.Disposable[] = [];
    constructor(private readonly snapshots: Pick<StepLibrarySnapshotService, 'ensureReady'>,
        private readonly files: Pick<ScenarioFilesService, 'resolveAttachmentUri'>) {
        const watcher = vscode.workspace.createFileSystemWatcher('**/{files,Файлы}/**/*', false, true, false);
        const invalidate = () => { this.workspaceFiles = undefined; };
        this.subscriptions.push(watcher, watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate), vscode.workspace.onDidChangeWorkspaceFolders(invalidate));
    }
    dispose(): void { this.disposed = true; this.workspaceFiles = undefined; this.subscriptions.forEach(item => item.dispose()); }
    private async inventory(resource: vscode.Uri): Promise<readonly Candidate[]> {
        const folder = vscode.workspace.getWorkspaceFolder(resource);
        this.workspaceFiles ??= Promise.resolve(vscode.workspace.findFiles('**/{files,Файлы}/**/*', exclude)).then(uris => uris.map(uri => {
            const normalized = uri.fsPath.replace(/\\/gu, '/'); const marker = /\/(?:files|Файлы)\//iu.exec(normalized)!;
            return { uri, relativePath: normalized.slice(marker.index + marker[0].length), label: uri.fsPath, owner: normalized.slice(0, marker.index) };
        })).catch(() => { this.workspaceFiles = undefined; return []; });
        const [snapshot, workspaceFiles] = await Promise.all([this.snapshots.ensureReady(folder?.uri ?? resource).catch(() => undefined), this.workspaceFiles]);
        const attachments = (snapshot?.items ?? []).flatMap(item => (item.attachmentPaths ?? []).map(relativePath => ({
            item, relativePath, label: `${item.displayText} — ${relativePath}`,
            owner: item.capturedLocation?.uri ? path.dirname(vscode.Uri.parse(item.capturedLocation.uri).fsPath) : ''
        })));
        return [...attachments, ...workspaceFiles];
    }
    private rank(candidate: Candidate, document: vscode.TextDocument): number {
        if (candidate.item?.compiledFeatureUri === document.uri.toString() || samePath(candidate.owner.replace(/\\/gu, '/'), path.dirname(document.uri.fsPath).replace(/\\/gu, '/'))) { return 0; }
        const called = candidate.item?.template;
        if (called && document.getText().split(/\r\n|\r|\n/u).some(line => line.trim().replace(/^(?:\*\s*)?(?:К тому же|Допустим|Затем|Пусть|Также|Given|When|Then|And|But|Дано|Когда|Тогда|И|Но|А)\s+/iu, '') === called)) { return 1; }
        const uri = candidate.uri ?? (candidate.item?.capturedLocation?.uri ? vscode.Uri.parse(candidate.item.capturedLocation.uri) : undefined);
        return uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ? 2 : 3;
    }
    private async direct(document: vscode.TextDocument, reference: string): Promise<Candidate[]> {
        const value = normalizeFileReference(reference); if (!value) { return []; }
        const directory = path.dirname(document.uri.fsPath);
        const paths = path.isAbsolute(value) ? [value] : [path.resolve(directory, 'files', value), path.resolve(directory, value),
            ...(vscode.workspace.getWorkspaceFolder(document.uri) ? [path.resolve(vscode.workspace.getWorkspaceFolder(document.uri)!.uri.fsPath, value)] : [])];
        const result: Candidate[] = [];
        for (const file of new Set(paths)) {
            const uri = vscode.Uri.file(file);
            if (await vscode.workspace.fs.stat(uri).then(stat => (stat.type & vscode.FileType.File) !== 0, () => false)) {
                result.push({ uri, label: file, owner: directory, relativePath: value });
                break;
            }
        }
        return result;
    }
    async provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentLink[]> {
        if (!supported(document.uri) || document.getText().length > 2_000_000) { return []; }
        const version = document.version;
        const references = collectScenarioFileReferences(document.getText(), /\.ya?ml$/iu.test(document.uri.path));
        if (!references.length || token.isCancellationRequested) { return []; }
        const inventory = await this.inventory(document.uri);
        const knownNames = new Set(inventory.flatMap(candidate => fileReferenceAliases(candidate.relativePath)));
        const links: vscode.DocumentLink[] = [];
        const matches = new Map<string, boolean>();
        for (const ref of references) {
            if (token.isCancellationRequested || this.disposed || document.version !== version) { return []; }
            let exists = matches.get(ref.text);
            if (exists === undefined) {
                const normalized = normalizeFileReference(ref.text)!;
                const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
                exists = knownNames.has(key) || key.startsWith('files/') && knownNames.has(key.slice(6));
                if (!exists && /\.[\p{L}][\p{L}\d_-]{0,15}$/u.test(ref.text)) { exists = (await this.direct(document, ref.text)).length > 0; }
                matches.set(ref.text, exists);
            }
            if (!exists) { continue; }
            const request: LinkRequest = { ...ref, source: document.uri.toString() };
            const target = vscode.Uri.parse(`command:kotTestToolkit.openFile?${encodeURIComponent(JSON.stringify([request]))}`);
            const link = new vscode.DocumentLink(new vscode.Range(ref.line, ref.start, ref.line, ref.end), target);
            link.tooltip = vscode.l10n.t('Open file in external application'); links.push(link);
        }
        return token.isCancellationRequested || document.version !== version || this.disposed ? [] : links;
    }
    private async resolve(candidate: Candidate): Promise<vscode.Uri | undefined> {
        const uri = candidate.uri ?? (candidate.item ? await this.files.resolveAttachmentUri(candidate.item, candidate.relativePath) as vscode.Uri | undefined : undefined);
        return uri?.scheme === 'file' && await vscode.workspace.fs.stat(uri).then(stat => (stat.type & vscode.FileType.File) !== 0, () => false) ? uri : undefined;
    }
    async find(document: vscode.TextDocument, references: readonly string[]): Promise<vscode.Uri | undefined> {
        const inventory = await this.inventory(document.uri);
        const known: Array<{ candidate: Candidate; rank: number }> = [];
        for (const reference of [...new Set(references)]) {
            const direct = await this.direct(document, reference);
            known.push(...direct.map(candidate => ({ candidate, rank: -1 })), ...inventory.filter(candidate => matchesFileReference(reference, candidate.relativePath)).map(candidate => ({ candidate, rank: this.rank(candidate, document) })));
        }
        const resolved = new Map<string, { uri: vscode.Uri; label: string; rank: number }>();
        for (const { candidate, rank } of known) {
            const uri = await this.resolve(candidate); if (!uri) { continue; }
            const key = process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();
            if (!resolved.has(key) || rank < resolved.get(key)!.rank) { resolved.set(key, { uri, label: candidate.label, rank }); }
        }
        if (!resolved.size) {
            for (const reference of [...new Set(references)]) {
                const value = normalizeFileReference(reference); if (!value || /[?*\[\]{}]/u.test(value)) { continue; }
                const name = path.posix.basename(value);
                const pattern = `**/${name}${path.posix.extname(name) ? '' : '.*'}`;
                const folder = vscode.workspace.getWorkspaceFolder(document.uri);
                for (const uri of await vscode.workspace.findFiles(folder ? new vscode.RelativePattern(folder, pattern) : pattern, exclude)) {
                    if (value.includes('/') && !samePath(uri.fsPath.replace(/\\/gu, '/').slice(-value.length - 1), '/' + value)) { continue; }
                    if (await this.resolve({ uri, label: uri.fsPath, relativePath: name, owner: '' })) { resolved.set(uri.toString(), { uri, label: uri.fsPath, rank: 4 }); }
                }
            }
        }
        if (!resolved.size) { void kotUi.showInformationMessage(vscode.l10n.t('No matching file was found. Place the cursor in a file name or select it.')); return; }
        const rank = Math.min(...[...resolved.values()].map(row => row.rank));
        const candidates = [...resolved.values()].filter(row => row.rank === rank).sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
        if (candidates.length === 1) { return candidates[0].uri; }
        return (await kotUi.showQuickPick(candidates.map(row => ({ ...row, label: path.basename(row.uri.fsPath), description: row.label, detail: row.uri.fsPath })),
            { title: vscode.l10n.t('Choose a file to open'), matchOnDescription: true, ignoreFocusOut: true }))?.uri;
    }
    async fromEditor(argument?: unknown): Promise<vscode.Uri | undefined> {
        if (argument && typeof argument === 'object' && 'source' in argument) {
            const ref = argument as LinkRequest;
            if (typeof ref.source !== 'string' || typeof ref.text !== 'string' || ![ref.line, ref.start, ref.end].every(value => Number.isSafeInteger(value) && value >= 0) || ref.start >= ref.end) { return; }
            const uri = vscode.Uri.parse(ref.source); if (!supported(uri)) { return; }
            const document = await vscode.workspace.openTextDocument(uri);
            if (ref.line >= document.lineCount || document.lineAt(ref.line).text.slice(ref.start, ref.end) !== ref.text) { return; }
            return this.find(document, [ref.text]);
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || !supported(editor.document.uri)) { return; }
        if (!editor.selection.isEmpty) { return this.find(editor.document, [editor.document.getText(editor.selection)]); }
        const line = editor.selection.active.line; const character = editor.selection.active.character;
        const references = fileReferencesOnLine(editor.document.lineAt(line).text, line);
        const selected = references.find(ref => character >= ref.start && character <= ref.end);
        return selected ? this.find(editor.document, [selected.text]) : undefined;
    }
}

export function registerScenarioFileNavigation(context: vscode.ExtensionContext, snapshots: Pick<StepLibrarySnapshotService, 'ensureReady'>, files: Pick<ScenarioFilesService, 'resolveAttachmentUri'>,
    openExternal: (uri: vscode.Uri) => PromiseLike<boolean> = uri => vscode.env.openExternal(uri)): void {
    const navigation = new ScenarioFileNavigation(snapshots, files);
    const run = (action: 'open' | 'reveal' | 'os', argument?: unknown) => Promise.resolve().then(async () => {
        const uri = await navigation.fromEditor(argument); if (!uri) { return; }
        await assertKotPath(uri.fsPath);
        if (action === 'open') {
            await openExternal(uri);
        } else { await vscode.commands.executeCommand(action === 'reveal' ? 'revealInExplorer' : 'revealFileInOS', uri); }
    }).catch(error => { void kotUi.showErrorMessage(vscode.l10n.t('Could not open the file: {0}', error instanceof Error ? error.message : String(error))); });
    context.subscriptions.push(navigation,
        vscode.languages.registerDocumentLinkProvider([{ scheme: 'file', pattern: '**/*.feature' }, { scheme: 'file', pattern: '**/*.yaml' }, { scheme: 'file', pattern: '**/*.yml' }], navigation),
        vscode.commands.registerCommand('kotTestToolkit.openFile', argument => run('open', argument)),
        vscode.commands.registerCommand('kotTestToolkit.openMxlFile', argument => run('open', argument)),
        vscode.commands.registerCommand('kotTestToolkit.editorMenu.openMxlFile', argument => run('open', argument)),
        vscode.commands.registerCommand('kotTestToolkit.revealFileInExplorer', () => run('reveal')),
        vscode.commands.registerCommand('kotTestToolkit.revealFileInOS', () => run('os')));
}
