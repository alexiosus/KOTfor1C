import { projectFormat } from './projectFormat';
import { readLegacyMetadata } from './projectLegacyMetadata';
import { stringify } from 'yaml';
import type { PropertiesLibrarySupport } from './scenarioPropertiesLibrarySupport';
import type { FeaturePropertiesController } from './featurePropertiesController';
import type { Translator } from './localization';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ScenarioPropertiesSession, type ScenarioPropertiesDocument, type ScenarioPropertiesHost, type ScenarioPropertiesState } from './scenarioPropertiesSession';
import { findLinkedScenarioSettings, type ScenarioPropertiesSource } from './scenarioPropertiesBindings';
import { readScenarioProperties } from './scenarioPropertiesModel';
import { parseScenarioDescriptor } from './scenarioDescriptor';
import { createProjectLibraryStore, resolveProjectLibraryRoot, resolveProjectEntityIdentity, getCachedProjectLibrarySnapshot } from './projectLibraryMetadata';
import { getProjectEntityDisplayOrder } from './projectEntityDisplayOrder';
import { parseProjectMetadataSidecar, projectEntityKey } from './projectLibraryStore';
import { assertProjectMetadataSaved, persistProjectMetadata, projectLibraryEnvironment } from './projectLibraryIntegration';
import type { ScenarioYamlEditor } from './scenarioYamlEditor';
import { onDidChangeScenarioScanRoot } from './scenarioScanRoot';
import { isCompilerYamlFile } from './yamlValidator';
import { ScenarioPropertiesAttachments } from './scenarioPropertiesAttachments';
import type { ScenarioFilesService } from './scenarioFilesService';
import { onDidConvertScenarioFormat } from './spprScenarioFiles.js';

const protocol = require('../media/scenarioPropertiesProtocol.js') as {
    DEFAULT_LABELS: Record<string, string>;
    validateMessage(message: unknown): boolean;
};

export interface ScenarioPropertiesPanelOptions {
    onDisplayOrderChanged?(): Promise<void>;
    context?: vscode.ExtensionContext;
    translate?: Translator;
    runAction: ScenarioPropertiesHost['runAction'];
}
interface SettingsScope { root: string; recursive: boolean; owner: string }
export interface ScenarioPropertiesNativeHost extends ScenarioPropertiesHost {
    invalidateSettings(uri?: vscode.Uri, topology?: boolean): void;
    settingsScopes(source: ScenarioPropertiesDocument): SettingsScope[];
}
const excludedDirectories = new Set(['.git', '.kot', 'node_modules', 'out', 'dist', 'build', 'generated', '.generated', '.vscode-test', 'kot-runtime']);

function contains(root: string, file: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function isYaml(file: string): boolean { return /\.ya?ml$/i.test(file) && !/\.kot\.ya?ml$/i.test(file); }
function errorText(reason: unknown): string {
    return reason && typeof reason === 'object' && 'message' in reason ? String(reason.message) : String(reason);
}
function missing(reason: unknown): boolean {
    return !!reason && typeof reason === 'object' && 'code' in reason && ['ENOENT', 'FileNotFound'].includes(String(reason.code));
}

function settingsScopes(source: ScenarioPropertiesDocument): SettingsScope[] {
    const uri = vscode.Uri.parse(source.uri, true);
    if (uri.scheme !== 'file') { throw new Error('Test properties require a local scenario or process source.'); }
    const env = projectLibraryEnvironment();
    const owner = resolveProjectLibraryRoot(uri.fsPath, env.workspaceRoots, env.scanRoots);
    const recursive = [...new Set(env.scanRoots.map(root => path.resolve(root)))].filter(root =>
        contains(owner, root) && resolveProjectLibraryRoot(root, env.workspaceRoots, env.scanRoots) === owner);
    const scopes = recursive.filter(root => !recursive.some(parent => parent !== root && contains(parent, root)))
        .map(root => ({ root, recursive: true, owner }));
    const directory = path.dirname(uri.fsPath);
    // The sibling fallback is deliberately flat: a source in the project root
    // must not cause an inventory walk through the 1C configuration tree.
    if (!scopes.some(scope => contains(scope.root, directory))) {
        scopes.push({ root: directory, recursive: false, owner }, { root: path.join(directory, 'test'), recursive: false, owner });
    }
    return scopes;
}

function allowed(file: string, scope: SettingsScope): boolean {
    if (!(scope.recursive ? contains(scope.root, file) : path.dirname(file) === scope.root)) { return false; }
    if (path.relative(scope.owner, file).split(path.sep).some(segment => excludedDirectories.has(segment.toLowerCase()))) { return false; }
    const env = projectLibraryEnvironment();
    return resolveProjectLibraryRoot(file, env.workspaceRoots, env.scanRoots) === scope.owner;
}

async function withoutLinks(file: string, owner: string, directory = false): Promise<boolean> {
    if (!contains(owner, file)) { return false; }
    const segments = path.relative(owner, file).split(path.sep).filter(Boolean);
    let current = owner;
    for (let index = -1; index < segments.length; index++) {
        if (index >= 0) { current = path.join(current, segments[index]); }
        const stat = await fs.lstat(current).catch(reason => { if (missing(reason)) { return undefined; } throw reason; });
        if (!stat || stat.isSymbolicLink()) { return false; }
        const last = index === segments.length - 1;
        if (!(last && !directory ? stat.isFile() : stat.isDirectory())) { return false; }
    }
    return true;
}

/** Candidates are cached by ownership and roots; open documents overlay cached disk text. */
class SettingsInventory {
    private readonly inventories = new Map<string, { scopes: SettingsScope[]; values: Promise<Map<string, string>>; changed: Set<string> }>();

    invalidate(uri?: vscode.Uri, topology = true): void {
        for (const [key, inventory] of this.inventories) {
            if (uri && (uri.scheme !== 'file' || !inventory.scopes.some(scope =>
                contains(uri.fsPath, scope.root) || allowed(uri.fsPath, scope)))) { continue; }
            if (topology || !uri) { this.inventories.delete(key); }
            else { inventory.changed.add(uri.fsPath); }
        }
    }

    async list(source: ScenarioPropertiesDocument): Promise<ScenarioPropertiesSource[]> {
        const scopes = settingsScopes(source);
        const key = JSON.stringify(scopes);
        let inventory = this.inventories.get(key);
        if (!inventory) {
            inventory = { scopes, values: this.discover(scopes), changed: new Set() };
            this.inventories.set(key, inventory);
            inventory.values.catch(() => { if (this.inventories.get(key) === inventory) { this.inventories.delete(key); } });
        }
        const disk = await inventory.values;
        const changed = [...inventory.changed]; inventory.changed.clear();
        for (const file of changed) {
            if (!isYaml(file)) { continue; }
            if (!await withoutLinks(file, scopes[0].owner)) { disk.delete(file); continue; }
            try { disk.set(file, await fs.readFile(file, 'utf8')); }
            catch (reason) { if (missing(reason)) { disk.delete(file); } else { throw reason; } }
        }
        const values = new Map(disk);
        for (const document of vscode.workspace.textDocuments) {
            if (document.isClosed || !document.isDirty || document.uri.scheme !== 'file' || !isYaml(document.uri.fsPath)
                || !scopes.some(scope => allowed(document.uri.fsPath, scope))) { continue; }
            if (await withoutLinks(document.uri.fsPath, scopes[0].owner)) { values.set(document.uri.fsPath, document.getText()); }
        }
        return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([file, text]) => ({ uri: vscode.Uri.file(file).toString(), text }));
    }

    private async discover(scopes: SettingsScope[]): Promise<Map<string, string>> {
        const values = new Map<string, string>();
        const visited = new Set<string>();
        const walk = async (directory: string, scope: SettingsScope): Promise<void> => {
            if (visited.has(directory) || !contains(scope.owner, directory)) { return; }
            const env = projectLibraryEnvironment();
            if (resolveProjectLibraryRoot(directory, env.workspaceRoots, env.scanRoots) !== scope.owner
                || path.relative(scope.owner, directory).split(path.sep).some(segment => excludedDirectories.has(segment.toLowerCase()))) { return; }
            const stat = await fs.lstat(directory).catch(reason => { if (missing(reason)) { return undefined; } throw reason; });
            if (!stat?.isDirectory() || stat.isSymbolicLink()) { return; }
            visited.add(directory);
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const file = path.join(directory, entry.name);
                if (entry.isSymbolicLink()) { continue; }
                if (entry.isDirectory() && scope.recursive) { await walk(file, scope); }
                else if (entry.isFile() && isYaml(file) && allowed(file, scope)) {
                    try { values.set(file, await fs.readFile(file, 'utf8')); }
                    catch (reason) { if (!missing(reason)) { throw reason; } }
                }
            }
        };
        for (const scope of scopes) {
            if (await withoutLinks(scope.root, scope.owner, true)) { await walk(scope.root, scope); }
        }
        return values;
    }
}

/** All form mutations remain ordinary native document edits, including adjacent metadata. */
export function createScenarioPropertiesHost(options: ScenarioPropertiesPanelOptions): ScenarioPropertiesNativeHost {
    const inventory = new SettingsInventory();
    const document = async (uri: string): Promise<vscode.TextDocument> => vscode.workspace.textDocuments
        .find(value => value.uri.toString() === uri && !value.isClosed) ?? await vscode.workspace.openTextDocument(vscode.Uri.parse(uri, true));
    const readDocument = async (uri: string): Promise<ScenarioPropertiesDocument> => {
        const value = await document(uri);
        const paired = /(?:^|[\\/])meta\.yaml$/u.test(value.fileName)
            ? await (await import('./spprScenarioFiles.js')).resolveScenarioSourceUris(value.uri) : undefined;
        const script = paired?.format === 'native' ? await document(paired.scriptUri.toString()) : undefined;
        return { uri: value.uri.toString(), text: value.getText(), version: value.version, dirty: value.isDirty || !!script?.isDirty,
            ...(script ? { scriptText: script.getText(), scriptUri: script.uri.toString() } : {}) };
    };
    const displayTarget = (source: ScenarioPropertiesDocument) => {
        const uri = vscode.Uri.parse(source.uri, true);
        const env = projectLibraryEnvironment();
        const root = resolveProjectLibraryRoot(uri.fsPath, env.workspaceRoots, env.scanRoots);
        const descriptor = parseScenarioDescriptor(source.text);
        const kind = descriptor.kind === 'process' ? 'process' : 'scenario';
        const identity = resolveProjectEntityIdentity(uri.fsPath, root, kind, descriptor.uid);
        return { root, identity, section: kind === 'process' ? 'process' as const : 'main' as const };
    };
    const readMetadata = async (source: ScenarioPropertiesDocument): Promise<ScenarioPropertiesDocument | undefined> => {
        const sourceUri = vscode.Uri.parse(source.uri, true);
        if (sourceUri.scheme !== 'file') { throw new Error('Project metadata requires a local source file.'); }
        const environment = projectLibraryEnvironment();
        const owner = resolveProjectLibraryRoot(sourceUri.fsPath, environment.workspaceRoots, environment.scanRoots);
        if (projectFormat(owner).kind !== 'v3') { return { ...source, text: stringify({ metadata: readLegacyMetadata(source.text).values }), scriptText: undefined, scriptUri: undefined }; }
        const uri = vscode.Uri.file(sourceUri.fsPath + '.kot.yml');
        const opened = vscode.workspace.textDocuments.some(value => value.uri.toString() === uri.toString() && !value.isClosed);
        if (!opened) {
            try { await fs.access(uri.fsPath); } catch (reason) { if (missing(reason)) { return undefined; } throw reason; }
        }
        const value = await readDocument(uri.toString());
        const env = projectLibraryEnvironment();
        const root = resolveProjectLibraryRoot(sourceUri.fsPath, env.workspaceRoots, env.scanRoots);
        const sidecar = parseProjectMetadataSidecar(value.text, uri.fsPath, root);
        const descriptor = parseScenarioDescriptor(source.text);
        const kind = descriptor.kind === 'process' ? 'process' : 'scenario';
        if (sidecar.identity.kind !== kind || (sidecar.identity.uid ?? '').toLowerCase() !== (descriptor.uid ?? '').trim().toLowerCase()) {
            throw new Error('Project metadata identity does not match the selected source kind and UID. Open KOT metadata to resolve it.');
        }
        return value;
    };
    return {
        ...(options.context ? { loadCatalogs: async (source: ScenarioPropertiesDocument, candidates: ScenarioPropertiesSource[], settings?: ScenarioPropertiesSource,
            parseCandidate?: Parameters<NonNullable<ScenarioPropertiesHost['loadCatalogs']>>[3]) => {
            const { loadScenarioPropertiesCatalogs } = await import('./scenarioPropertiesCatalogs.js');
            return loadScenarioPropertiesCatalogs(options.context!, source, candidates, settings, parseCandidate);
        } } : {}),
        presentation: source => {
            const config = vscode.workspace.getConfiguration('kotTestToolkit', vscode.Uri.parse(source.uri, true));
            return {
                autoFill: { parameters: config.get<boolean>('editor.autoFillScenarioParametersOnSave', true) !== false, nested: config.get<boolean>('editor.autoFillNestedScenariosOnSave', true) !== false },
                systemFunctions: [], // The shared catalog is loaded by loadCatalogs; settings only seed migration.
                suggestions: Object.fromEntries([['Проект', 'project'], ['УровеньОтчета1', 'reportLevel1'], ['УровеньОтчета2', 'mainReportLevel2'], ['ПрофильПользователя', 'userProfile']]
                    .map(([field, setting]) => [field, [config.get<string>(`newScenarioDefaults.${setting}`, '')].filter(Boolean)]))
            };
        },
        readDocument,
        replaceDocument: async (before, text) => {
            const current = await document(before.uri);
            if (current.version !== before.version || current.getText() !== before.text) { return false; }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(before.text.length)), text);
            return vscode.workspace.applyEdit(edit);
        },
        saveDocument: async uri => {
            const current = await document(uri);
            if (current.uri.scheme === 'file') { await vscode.workspace.fs.stat(current.uri); }
            return current.save();
        },
        listSettings: source => inventory.list(source),
        listInitialSettings: async source => {
            const sourceUri = vscode.Uri.parse(source.uri, true);
            const scopes = settingsScopes(source);
            const directory = path.dirname(sourceUri.fsPath);
            const owner = scopes[0].owner;
            const values = await Promise.all([directory, path.join(directory, 'test')].map(async local => {
                if (!await withoutLinks(local, owner, true)) { return []; }
                const names = await fs.readdir(local, { withFileTypes: true });
                return Promise.all(names.filter(entry => entry.isFile() && isYaml(entry.name)).map(async entry => {
                    const file = path.join(local, entry.name);
                    if (file === sourceUri.fsPath || !scopes.some(scope => allowed(file, scope)) || !await withoutLinks(file, owner)) { return undefined; }
                    const uri = vscode.Uri.file(file).toString();
                    const opened = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri && !document.isClosed);
                    return { uri, text: opened?.getText() ?? await fs.readFile(file, 'utf8') };
                }));
            }));
            return values.flat().filter((value): value is ScenarioPropertiesSource => !!value);
        },
        loadGroups: async source => {
            const uri = vscode.Uri.parse(source.uri, true);
            const env = projectLibraryEnvironment();
            const root = resolveProjectLibraryRoot(uri.fsPath, env.workspaceRoots, env.scanRoots);
            const descriptor = parseScenarioDescriptor(source.text);
            const kind = descriptor.kind === 'process' ? 'process' : 'scenario';
            const groups = projectFormat(root).kind !== 'v3'
                ? getCachedProjectLibrarySnapshot(root)?.groups ?? (readLegacyMetadata(source.text).group ? [{ ...readLegacyMetadata(source.text).group!, sections: [kind === 'process' ? 'process' : 'main'] }] : [])
                : await createProjectLibraryStore(root, env.workspaceRoots, env.scanRoots).readGroups();
            return groups.filter(group => group.sections.includes(kind === 'process' ? 'process' : 'main'))
                .map(group => ({ id: group.id, name: group.name }));
        },
        readDisplayOrder: async (source, groupId) => {
            const target = displayTarget(source);
            if (projectFormat(target.root).kind !== 'v3') { return readLegacyMetadata(source.text).values.order ?? null; }
            const raw = await readMetadata(source);
            const fallback = raw ? parseProjectMetadataSidecar(raw.text, vscode.Uri.parse(raw.uri, true).fsPath, target.root).metadata.order : undefined;
            return getProjectEntityDisplayOrder().rank(target.root, target.section, groupId, projectEntityKey(target.identity), fallback) ?? null;
        },
        setDisplayOrder: async (source, groupId, value) => {
            const target = displayTarget(source);
            const snapshot = getCachedProjectLibrarySnapshot(target.root);
            const initial = Object.entries(snapshot?.metadata ?? {}).filter(([key, metadata]) => (metadata.groupId ?? '') === groupId
                && snapshot?.identities[key]?.kind === target.identity.kind).map(([key, metadata]) => ({ key, order: metadata.order ?? null }));
            await getProjectEntityDisplayOrder().set(target.root, target.section, groupId, projectEntityKey(target.identity), value, initial);
            await options.onDisplayOrderChanged?.();
        },
        editProjectMetadata: async (source, patch) => {
            const target = displayTarget(source);
            if (projectFormat(target.root).kind === 'v3') { return false; }
            return persistProjectMetadata(await document(source.uri), patch);
        },
        readMetadata,
        ensureMetadata: async source => {
            const existing = await readMetadata(source);
            if (existing) { return existing; }
            if (!await persistProjectMetadata(await document(source.uri), {})) { throw new Error('Could not create project metadata for this source.'); }
            const created = await readMetadata(source);
            if (!created) { throw new Error('Project metadata was not created.'); }
            return created;
        },
        runAction: async (...args) => {
            const result = await options.runAction(...args);
            if (args[0] === 'convertRole' || args[0] === 'createSettings') { inventory.invalidate(); }
            return result;
        },
        invalidateSettings: (uri, topology) => inventory.invalidate(uri, topology),
        settingsScopes
    };
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** A reusable right-hand webview backed by one serialized document session. */
export const SCENARIO_PROPERTIES_VIEW = 'kotTestToolkit.scenarioProperties';

export class ScenarioPropertiesPanel implements vscode.WebviewViewProvider, vscode.Disposable {
    private readonly host: ScenarioPropertiesNativeHost;
    private readonly session: ScenarioPropertiesSession;
    private readonly t: Translator;
    private readonly labels: Record<string, string>;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly panelDisposables: vscode.Disposable[] = [];
    private watchers: vscode.Disposable[] = [];
    private watchIdentity = '';
    private panel?: vscode.WebviewView;
    private attachments?: ScenarioPropertiesAttachments;
    private tail: Promise<unknown> = Promise.resolve();
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private pendingMessages = 0;
    private unavailable?: string;
    private disposed = false;
    private followedEditorUri?: string;
    private library?: PropertiesLibrarySupport;
    private feature?: FeaturePropertiesController;
    private get currentSourceUri(): string | undefined { return this.feature?.currentSourceUri ?? this.session.currentSourceUri; }
    private get pinned(): boolean { return this.feature?.currentSourceUri ? this.feature.pinned : this.session.pinned; }

    constructor(private readonly context: vscode.ExtensionContext, private readonly textEditor: ScenarioYamlEditor, options: ScenarioPropertiesPanelOptions) {
        this.t = options.translate ?? ((message, ...args) => vscode.l10n.t(message, ...args));
        this.labels = Object.fromEntries(Object.entries(protocol.DEFAULT_LABELS).map(([key, value]) => [key, this.t(value)]));
        this.host = createScenarioPropertiesHost({ ...options, context });
        this.session = new ScenarioPropertiesSession(this.host, () => {
            void this.queue(async () => { if (this.pendingMessages === 0) { await this.post(); } });
        });
        this.disposables.push(
            vscode.window.registerWebviewViewProvider(SCENARIO_PROPERTIES_VIEW, this, { webviewOptions: { retainContextWhenHidden: true } }),
            onDidConvertScenarioFormat(result => {
                void this.queue(async () => {
                    const current = this.session.currentSourceUri;
                    if (!current || !result.uriMoves.some(move => move.oldUri === current)) { return; }
                    try {
                        await this.session.remapFiles(result.uriMoves);
                        this.unavailable = undefined;
                        this.followedEditorUri = undefined;
                        this.host.invalidateSettings();
                        this.configureWatchers(await this.host.readDocument(this.session.currentSourceUri!));
                        await this.post();
                    } catch (reason) { await this.post(errorText(reason)); }
                });
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => this.handleActiveEditor(editor)),
            vscode.window.onDidChangeVisibleTextEditors(() => this.handleActiveEditor(vscode.window.activeTextEditor)),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.uri.scheme === 'file' && (/\.(?:ya?ml|feature)$/iu.test(event.document.uri.fsPath) || event.document.uri.toString() === this.feature?.currentSourceUri)) { this.scheduleRefresh(); }
            }),
            vscode.workspace.onDidSaveTextDocument(document => {
                this.host.invalidateSettings(document.uri, false); this.scheduleRefresh();
            }),
            vscode.workspace.onDidCreateFiles(event => {
                for (const uri of event.files) { this.host.invalidateSettings(uri, true); }
                this.scheduleRefresh();
            }),
            vscode.workspace.onDidDeleteFiles(event => {
                for (const uri of event.files) { this.fileEvent(uri, 'delete'); }
            }),
            vscode.workspace.onDidRenameFiles(event => {
                this.host.invalidateSettings();
                return this.queue(async () => {
                    const current = this.currentSourceUri;
                    if (!current || !this.panel) { return; }
                    if (this.feature?.currentSourceUri) {
                        let next = current;
                        for (const move of event.files) {
                            const before = move.oldUri.toString().replace(/\/$/u, '');
                            if (next === before || next.startsWith(before + '/')) { next = move.newUri.toString().replace(/\/$/u, '') + next.slice(before.length); }
                        }
                        try { await this.feature.remap(next); this.unavailable = undefined; await this.post(); }
                        catch (reason) { this.unavailable = errorText(reason); await this.post(this.unavailable); }
                        return;
                    }
                    try {
                        await this.session.remapFiles(event.files.map(item => ({ oldUri: item.oldUri.toString(), newUri: item.newUri.toString() })));
                        this.unavailable = undefined;
                        const next = this.session.currentSourceUri!;
                        this.configureWatchers(await this.host.readDocument(next));
                        if (next !== current) { await this.textEditor.open(vscode.Uri.parse(next, true)); }
                        await this.post(); this.scheduleRefresh();
                    } catch (reason) { await this.post(errorText(reason)); }
                });
            }),
            onDidChangeScenarioScanRoot(() => this.rootsChanged()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.rootsChanged()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('kotTestToolkit')) { this.rootsChanged(); }
                if (event.affectsConfiguration('kotTestToolkit.editor.autoOpenTestProperties')) {
                    void this.handleActiveEditor(vscode.window.activeTextEditor);
                }
            })
        );
        if (vscode.window.tabGroups?.onDidChangeTabs) {
            this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(() => this.handleActiveEditor(vscode.window.activeTextEditor)));
        }
        context.subscriptions.push(this);
        void this.handleActiveEditor(vscode.window.activeTextEditor);
    }

    open(source?: vscode.Uri): Promise<void> {
        return this.queue(async () => {
            try {
                const active = vscode.window.activeTextEditor?.document.uri;
                const target = source ?? active ?? (this.currentSourceUri ? vscode.Uri.parse(this.currentSourceUri, true) : undefined);
                if (!target) { throw new Error('Choose a scenario or process source.'); }
                if (!this.panel) { this.host.invalidateSettings(); }
                await this.bind(target, true);
                if (this.disposed) { return; }
                await this.ensurePanel();
                const panel = this.panel;
                if (!panel || this.disposed) { return; }
                panel.show(true);
                await this.post();
            } catch (reason) {
                if (this.disposed) { return; }
                await this.ensurePanel();
                await this.post(errorText(reason));
                void vscode.window.showErrorMessage(this.t(errorText(reason)));
            }
        });
    }

    attachLibrarySupport(support: PropertiesLibrarySupport): void {
        this.library = support;
        this.feature = support.createFeatureController(this.host);
        this.disposables.push(support.onDidChange(() => this.scheduleRefresh()));
        void this.handleActiveEditor(vscode.window.activeTextEditor);
    }

    private configureFeatureWatcher(source: vscode.Uri): void {
        if (this.watchIdentity === source.toString()) { return; }
        this.clearWatchers(); this.watchIdentity = source.toString();
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(source.fsPath)), path.basename(source.fsPath)));
        this.watchers.push(watcher, watcher.onDidChange(uri => this.fileEvent(uri, 'change')),
            watcher.onDidDelete(uri => this.fileEvent(uri, 'delete')), watcher.onDidCreate(uri => this.fileEvent(uri, 'create')));
    }

    attachScenarioFilesService(service: ScenarioFilesService): void {
        this.attachments?.dispose();
        this.attachments = new ScenarioPropertiesAttachments(service, {
            currentSourceUri: () => this.panel && !this.unavailable ? this.session.currentSourceUri : undefined,
            validateSource: async uri => {
                if (uri !== this.session.currentSourceUri || !this.panel || this.unavailable) { return false; }
                const source = await this.host.readDocument(uri); const model = readScenarioProperties(source.text);
                return model.kind === 'scenario' || model.kind === 'process';
            },
            chooseFiles: async sourceUri => (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true,
                defaultUri: vscode.Uri.file(path.dirname(vscode.Uri.parse(sourceUri, true).fsPath)), openLabel: this.t('Add files') }))?.map(uri => uri.toString()),
            insertFileName: async (name, stillCurrent) => {
                const editor = vscode.window.activeTextEditor;
                if (!editor || !stillCurrent()) { return false; }
                const selection = editor.selection; const version = editor.document.version;
                const target = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
                if (target.document !== editor.document || target.document.version !== version || !stillCurrent()) { return false; }
                return target.edit(edit => edit.replace(selection, name));
            },
            postMessage: async message => {
                if (this.panel && !this.disposed) {
                    await this.panel.webview.postMessage({ ...message, ...(typeof message.error === 'string' ? { error: this.t(message.error) } : {}) });
                }
            }
        });
        this.attachments.bindSource(this.panel ? this.session.currentSourceUri : undefined);
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.attachments?.dispose();
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.clearWatchers();
        this.disposables.forEach(value => value.dispose());
        this.panelDisposables.forEach(value => value.dispose());
        this.panel = undefined;
    }

    private queue(operation: () => Promise<void>): Promise<void> {
        const result = this.tail.then(async () => { if (!this.disposed) { await operation(); } });
        this.tail = result.catch(() => undefined);
        return result;
    }

    private isActiveVisibleEditor(editor: vscode.TextEditor): boolean {
        return !editor.document.isClosed && vscode.window.activeTextEditor === editor
            && vscode.window.visibleTextEditors.includes(editor);
    }

    private handleActiveEditor(editor: vscode.TextEditor | undefined): Promise<void> {
        return this.queue(async () => {
            const input = vscode.window.tabGroups?.activeTabGroup.activeTab?.input;
            if (this.panel && !this.pinned && typeof vscode.TabInputWebview === 'function' && input instanceof vscode.TabInputWebview) {
                if (this.currentSourceUri || this.unavailable) {
                    this.unavailable = undefined; this.followedEditorUri = undefined; this.clearWatchers(); this.feature?.clear(); await this.session.clear(); await this.post();
                }
                return;
            }
            if (!editor || !this.isActiveVisibleEditor(editor)) { return; }
            await this.follow(editor);
            if (!this.isActiveVisibleEditor(editor) || this.panel?.visible) { return; }
            const document = editor.document;
            if (document.uri.scheme !== 'file' || document.isUntitled
                || !/\.(?:ya?ml|feature)$/iu.test(document.uri.fsPath)
                || (!/\.feature$/iu.test(document.uri.fsPath) && !isCompilerYamlFile(document) && !/\.ya?ml\.kot\.yml$/iu.test(document.uri.fsPath))
                || vscode.workspace.getConfiguration('kotTestToolkit', document.uri).get<boolean>('editor.autoOpenTestProperties', true) === false) { return; }
            try {
                await this.ensurePanel();
                if (!this.isActiveVisibleEditor(editor)) { await this.follow(vscode.window.activeTextEditor); return; }
                await this.follow(editor);
                this.panel?.show(true);
                if (this.pendingMessages === 0) { await this.post(); }
            } catch (reason) { console.error('[ScenarioProperties] Could not open the default properties view:', reason); }
        });
    }

    private async bind(source: vscode.Uri, openText: boolean, complete = false): Promise<void> {
        this.followedEditorUri = undefined;
        const paired = /(?:^|[\\/])(?:meta\.yaml|scen\.feature)$/u.test(source.fsPath) ? await (await import('./spprScenarioFiles.js')).resolveScenarioSourceUris(source) : undefined;
        if (paired?.format === 'native') { source = paired.metadataUri; }
        if (/\.feature$/iu.test(source.fsPath)) {
            if (!this.library || !this.feature) { throw new Error('Feature properties are still initializing. Retry shortly.'); }
            const original = await this.library.sourceForGenerated(source);
            if (original) { await this.bind(original, false, complete); return; }
            if (/(?:^|[\\/])kot-runtime[\\/]tests[\\/]/iu.test(source.fsPath)) { throw new Error('The generated feature source is unavailable. Open its YAML source.'); }
            await this.session.clear(); this.clearWatchers(); this.unavailable = undefined;
            await this.feature.open(source.toString());
            this.configureFeatureWatcher(source);
            if (openText) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), { preview: false }); }
            return;
        }
        this.feature?.clear();
        const document = await this.host.readDocument(source.toString());
        const model = readScenarioProperties(document.text);
        if (model.kind !== 'scenario' && model.kind !== 'process') { throw new Error('Choose a scenario or process source.'); }
        this.unavailable = undefined;
        this.configureWatchers(document);
        let loadError: unknown;
        try { await this.session.open(source.toString(), !complete); } catch (reason) { loadError = reason; }
        if (this.disposed) { return; }
        if (openText) { await this.textEditor.open(paired?.format === 'native' ? paired.scriptUri : source); }
        if (loadError) { throw loadError; }
    }

    private async follow(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!this.panel || this.pinned || !editor) { return; }
        let source = editor.document.uri;
        if (source.toString() === this.currentSourceUri || source.toString() === this.followedEditorUri) { return; }
        this.followedEditorUri = undefined;
        if (source.scheme === 'file' && /\.feature$/iu.test(source.fsPath)) {
            try { await this.bind(source, false); this.followedEditorUri = source.toString(); await this.post(); }
            catch (reason) { this.feature?.clear(); await this.session.clear(); this.clearWatchers(); await this.post(errorText(reason)); }
            return;
        }
        this.feature?.clear();
        if (source.scheme !== 'file' || !/\.ya?ml$/iu.test(source.fsPath)) {
            this.clearWatchers(); await this.session.clear(); await this.post(); return;
        }
        let activeSettings: string | undefined;
        try {
            if (/\.kot\.ya?ml$/iu.test(source.fsPath)) {
                source = source.with({ path: source.path.replace(/\.kot\.ya?ml$/iu, '') });
                if (!isYaml(source.fsPath)) { await this.session.clear(); await this.post(); return; }
            }
            const document = await this.host.readDocument(source.toString());
            const model = readScenarioProperties(document.text);
            if (model.kind === 'test' || model.kind === 'processTest') {
                activeSettings = source.toString();
                const bound = this.session.getState();
                if (bound.source && bound.settings.some(setting => setting.uri === activeSettings)) {
                    const original = await this.host.readDocument(bound.source.uri);
                    if (findLinkedScenarioSettings(original, [document]).length === 1) {
                        await this.session.handle({ command: 'action', action: 'selectSettings', value: activeSettings });
                        await this.post(); return;
                    }
                }
                const uid = model.header.find(field => field.key === (model.kind === 'test' ? 'UIDСценария' : 'UIDПроцесса'))?.value.trim().toLowerCase();
                const candidates = await this.host.listSettings(document);
                const linked = candidates.filter(candidate => {
                    try {
                        const candidateModel = readScenarioProperties(candidate.text);
                        if (candidateModel.kind !== 'scenario' && candidateModel.kind !== 'process') { return false; }
                        const descriptor = parseScenarioDescriptor(candidate.text);
                        return !!uid && (descriptor.kind === 'process') === (model.kind === 'processTest')
                            && descriptor.uid?.trim().toLowerCase() === uid;
                    } catch { return false; }
                });
                if (linked.length !== 1) { throw new Error('The active settings source is missing or ambiguous.'); }
                source = vscode.Uri.parse(linked[0].uri, true);
            } else if (model.kind !== 'scenario' && model.kind !== 'process') {
                await this.session.clear(); await this.post(); return;
            }
            await this.bind(source, false, !!activeSettings);
            if (activeSettings) { await this.session.handle({ command: 'action', action: 'selectSettings', value: activeSettings }); }
            await this.post();
        } catch (reason) {
            this.clearWatchers(); await this.session.clear(); await this.post(errorText(reason));
        }
    }

    private async ensurePanel(): Promise<void> {
        if (!this.panel && !this.disposed) {
            await vscode.commands.executeCommand(`${SCENARIO_PROPERTIES_VIEW}.focus`, { preserveFocus: true });
        }
    }

    async resolveWebviewView(panel: vscode.WebviewView): Promise<void> {
        if (this.disposed) { return; }
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        this.panelDisposables.splice(0).forEach(value => value.dispose());
        this.panel = panel;
        panel.title = this.labels.title;
        panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
        this.panelDisposables.push(
            panel.webview.onDidReceiveMessage(value => {
                if (this.attachments?.isMessage(value)) { return this.attachments.handle(value); }
                const queuedAction = !(value && typeof value === 'object' && 'command' in value && value.command === 'ready');
                if (queuedAction) { this.pendingMessages++; }
                return this.queue(async () => {
                    try { await this.receive(value); } finally { if (queuedAction) { this.pendingMessages--; } }
                });
            }),
            panel.onDidDispose(() => {
                if (this.panel !== panel) { return; }
                this.panel = undefined;
                this.attachments?.bindSource(undefined);
                this.clearWatchers();
                this.panelDisposables.splice(0).forEach(value => value.dispose());
            }),
            panel.onDidChangeVisibility(() => {
                if (panel.visible) { void this.queue(async () => { await this.follow(vscode.window.activeTextEditor); await this.post(); }); }
            })
        );
        const nonce = randomBytes(16).toString('hex');
        const resource = (name: string) => escapeHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString());
        const values: Record<string, string> = { nonce, cspSource: escapeHtml(panel.webview.cspSource),
            codiconsUri: resource('codicon.css'), styleUri: resource('scenarioProperties.css'),
            featureScriptUri: resource('featureProperties.js'), protocolUri: resource('scenarioPropertiesProtocol.js'), filesProtocolUri: resource('scenarioFilesProtocol.js'), scriptUri: resource('scenarioProperties.js') };
        const html = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'scenarioProperties.html'))).toString('utf8');
        if (this.disposed || this.panel !== panel) { return; }
        panel.webview.html = html.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? '')
            .replace('<title>Test properties</title>', `<title>${escapeHtml(this.labels.title)}</title>`);
        try { await this.session.refresh(true); await this.post(this.unavailable); }
        catch (reason) { await this.post(errorText(reason)); }
        void this.queue(() => this.follow(vscode.window.activeTextEditor));
    }

    private async receive(value: unknown): Promise<void> {
        let error: string | undefined;
        if (value && typeof value === 'object' && 'command' in value && value.command === 'featureAction') {
            try {
                if (!this.feature?.currentSourceUri || this.unavailable && !('action' in value && value.action === 'pin')) { throw new Error(this.unavailable ?? 'The feature changed. Refresh the form and retry.'); }
                await this.feature.handle(value);
                if ('action' in value && value.action === 'pin' && !this.pinned) { this.unavailable = undefined; await this.follow(vscode.window.activeTextEditor); }
            } catch (reason) { error = errorText(reason); }
            await this.post(error, true); return;
        }
        try {
            if (!protocol.validateMessage(value)) { throw new Error('Invalid test properties message. Refresh the form and retry.'); }
            const action = value as { command: string; action?: string; documentUri?: string };
            if (action.command === 'ready') { await this.post(); return; }
            if (this.unavailable && !(action.command === 'action' && ['pin', 'openSource'].includes(action.action ?? ''))) {
                throw new Error(this.unavailable);
            }
            if (this.feature?.currentSourceUri) { throw new Error('The source changed. Refresh the form and retry.'); }
            if (action.command === 'action' && action.action === 'convertCallable') {
                const message = value as { documentUri: string; documentVersion: number };
                if (message.documentUri !== this.session.currentSourceUri || (await this.host.readDocument(message.documentUri)).version !== message.documentVersion) {
                    throw new Error('The source changed. Refresh the properties and retry the action.');
                }
                const result = await vscode.commands.executeCommand<{ sourceUri: string }>('kotTestToolkit.convertCallableScenario', vscode.Uri.parse(message.documentUri));
                if (result) { this.unavailable = undefined; await this.bind(vscode.Uri.parse(result.sourceUri), false); }
            } else if (action.command === 'action' && action.action === 'favorite') {
                if (!this.library || !this.session.currentSourceUri || action.documentUri !== this.session.currentSourceUri) { throw new Error('Select a test to change its favorite state.'); }
                await this.library.toggleFavorite(this.session.currentSourceUri);
            } else {
                const previousSource = this.session.currentSourceUri;
                const state = await this.session.handle(value);
                if (!state.mutationError && state.source && state.source.uri !== previousSource && state.uriMoves?.length) {
                    // The converter/rename deleted the old source intentionally. Its watcher can
                    // arrive before the successful action returns the replacement identity.
                    this.unavailable = undefined;
                    this.configureWatchers(await this.host.readDocument(state.source.uri));
                }
            }
            if (action.command === 'action' && action.action === 'pin' && !this.pinned) {
                await this.follow(vscode.window.activeTextEditor);
            }
        } catch (reason) { error = errorText(reason); }
        // The client serializes edits against these acknowledgements; an error
        // still needs state so its pending queue can settle without losing input.
        await this.post(error ?? this.unavailable, true);
    }

    private async post(error?: string, acknowledgement = false): Promise<void> {
        const panel = this.panel;
        if (!panel || this.disposed || !acknowledgement && this.pendingMessages > 0) { return; }
        if (this.feature?.state) {
            const state = this.feature.state;
            const actions = (values: typeof state.model.actions) => values.map(action => ({ ...action, title: this.t(action.title) }));
            const message = error ?? state.error;
            await panel.webview.postMessage({ command: 'featureState', acknowledgement, state: { ...state,
                model: { ...state.model, actions: actions(state.model.actions),
                    scenarios: state.model.scenarios.map(scenario => ({ ...scenario, actions: actions(scenario.actions) })) },
                ...(message ? { error: this.t(message) } : {}), labels: this.labels } });
            this.attachments?.bindSource(undefined); return;
        }
        let state = this.session.getState();
        const uri = this.session.currentSourceUri;
        if (uri && state.source?.uri !== uri) {
            try {
                const document = await this.host.readDocument(uri);
                state = { ...state, source: { uri, version: document.version, model: readScenarioProperties(document.text) },
                    settings: [], selectedSettingsUri: null, metadata: null, groups: [], dirty: document.dirty, canCreateSettings: false };
            } catch { /* Preserve the last readable state and its source link. */ }
        }
        const message = error ?? state.error;
        const outgoing: ScenarioPropertiesState = { ...state, ...(message ? { error: this.t(message), ...(error && acknowledgement ? { mutationError: true } : {}) } : {}) };
        if (this.panel === panel && !this.disposed) {
            await panel.webview.postMessage({ command: 'state', acknowledgement, state: { ...outgoing, ...(state.source && this.library ? this.library.favorite(state.source.uri) : {}), labels: this.labels } });
            this.attachments?.bindSource(state.source && !this.unavailable ? state.source.uri : undefined);
        }
    }

    private rootsChanged(): void {
        this.host.invalidateSettings();
        this.clearWatchers();
        this.scheduleRefresh();
    }

    private scheduleRefresh(): void {
        if (!this.panel || this.disposed) { return; }
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.queue(async () => {
                if (this.pendingMessages > 0) { return; }
                if (this.unavailable) { await this.post(this.unavailable); return; }
                try {
                    if (this.feature?.currentSourceUri) { await this.feature.refresh(); this.configureFeatureWatcher(vscode.Uri.parse(this.feature.currentSourceUri, true)); if (this.pendingMessages === 0) { await this.post(); } return; }
                    await this.session.refresh(true);
                    if (this.session.currentSourceUri) { this.configureWatchers(await this.host.readDocument(this.session.currentSourceUri)); }
                    // A refresh is not an edit acknowledgement. A message may
                    // arrive during asynchronous reads and must receive its own
                    // response before the client releases the next queued edit.
                    if (this.pendingMessages === 0) { await this.post(); }
                } catch (reason) { if (this.pendingMessages === 0) { await this.post(errorText(reason)); } }
            });
        }, 80);
    }

    private fileEvent(uri: vscode.Uri, kind: 'change' | 'create' | 'delete'): void {
        if (uri.scheme !== 'file') { return; }
        this.host.invalidateSettings(uri, kind !== 'change');
        const current = this.currentSourceUri;
        if (kind === 'delete' && current) {
            const source = vscode.Uri.parse(current, true);
            if (source.fsPath === uri.fsPath || contains(uri.fsPath, source.fsPath)) {
                this.unavailable = 'The source scenario or process was deleted. Open another source; your unsaved documents remain available.';
                this.attachments?.bindSource(undefined);
            }
        }
        this.scheduleRefresh();
    }

    private clearWatchers(): void {
        this.watchers.splice(0).forEach(value => value.dispose());
        this.watchIdentity = '';
    }

    private configureWatchers(source: ScenarioPropertiesDocument): void {
        const scopes = this.host.settingsScopes(source);
        const identity = JSON.stringify(scopes);
        if (identity === this.watchIdentity) { return; }
        this.clearWatchers(); this.watchIdentity = identity;
        const definitions = scopes.map(scope => ({ root: scope.root, pattern: scope.recursive ? '**/*.{yaml,yml}' : '*.{yaml,yml}', git: false }));
        const owner = scopes[0]?.owner;
        if (owner) {
            definitions.push({ root: owner, pattern: '.kot/**/*.{yaml,yml}', git: false },
                { root: owner, pattern: '.git/{HEAD,index,refs/**}', git: true });
        }
        for (const definition of definitions) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(definition.root), definition.pattern));
            const changed = (uri: vscode.Uri, kind: 'change' | 'create' | 'delete') => {
                if (definition.git) { this.host.invalidateSettings(); this.scheduleRefresh(); }
                else { this.fileEvent(uri, kind); }
            };
            this.watchers.push(watcher, watcher.onDidChange(uri => changed(uri, 'change')),
                watcher.onDidCreate(uri => changed(uri, 'create')), watcher.onDidDelete(uri => changed(uri, 'delete')));
        }
    }
}
