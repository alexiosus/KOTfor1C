import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as vscode from 'vscode';
import {
    parseStandaloneFeatureSource,
    type StandaloneFeatureGroup,
    type StandaloneFeatureEntry,
    type StandaloneFeatureSnapshot
} from './standaloneFeatureModel';
import {
    ProjectLibraryStore,
    metadataFilePath,
    projectEntityKey,
    type ProjectEntityIdentity,
    type ProjectEntityMetadata
} from './projectLibraryStore';
import { resolveProjectEntityIdentity, resolveProjectLibraryRoot } from './projectLibraryMetadata';
import { ProjectGroupDisplayOrder } from './projectGroupDisplayOrder';

interface DisposableLike { dispose(): void; }

export interface StandaloneFeatureServiceDependencies {
    readonly getRoots: () => readonly string[];
    readonly getProjectRoot?: (sourcePath: string) => string;
    readonly assertProjectMetadataSaved?: (root: string) => void;
    readonly assertOrderingSourcesSaved?: (filePaths: readonly string[]) => void;
    readonly workspaceState: {
        get<T>(key: string, fallback?: T): T | undefined;
        update(key: string, value: unknown): PromiseLike<void>;
    };
    readonly watchRoot?: (root: string, listener: (filePath?: string) => void) => DisposableLike;
    readonly watchProjectMetadataRoot?: (root: string, listener: () => void) => DisposableLike;
    readonly watchFile?: (file: string, listener: () => void) => DisposableLike;
    readonly onDidChangeRoots?: (listener: () => void) => DisposableLike;
    readonly onDidRenameFiles?: (
        listener: (renames: readonly { oldPath: string; newPath: string }[]) => void
    ) => DisposableLike;
    readonly log?: (message: string) => void;
}

interface FeaturePlacement {
    readonly groupId: string;
    readonly order: number;
    readonly jsonPath?: string;
}

interface FeatureOrganization {
    readonly groups: StandaloneFeatureGroup[];
    readonly placements: Record<string, FeaturePlacement>;
}

type DiscoveredFeature = Omit<StandaloneFeatureEntry, 'groupId' | 'order'>;
const STATE_KEY = 'kotTestToolkit.standaloneFeatures';
const IGNORED_DIRECTORIES = new Set(['.git', '.kot', 'node_modules']);

function containsPath(root: string, value: string): boolean {
    const relative = path.relative(root, value);
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
        || left.localeCompare(right);
}

function normalizedPath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function filePath(value: string): string {
    return /^file:/iu.test(value) ? fileURLToPath(value) : path.resolve(value);
}

function canonicalFileUri(value: string): string {
    return pathToFileURL(normalizedPath(filePath(value))).toString();
}

function readOrganization(value: unknown): FeatureOrganization {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const groups: StandaloneFeatureGroup[] = [];
    for (const candidate of Array.isArray(source.groups) ? source.groups : []) {
        if (candidate && typeof candidate.id === 'string' && candidate.id
            && typeof candidate.name === 'string' && candidate.name.trim()
            && !groups.some(group => group.id === candidate.id)) {
            groups.push(Object.freeze({ id: candidate.id, name: candidate.name.trim() }));
        }
    }
    const placements: Record<string, FeaturePlacement> = Object.create(null);
    if (source.placements && typeof source.placements === 'object') {
        for (const [id, candidate] of Object.entries(source.placements)) {
            if (!/^file:/iu.test(id) || !candidate || typeof candidate !== 'object') { continue; }
            const entry = candidate as Record<string, unknown>;
            const groupId = typeof entry.groupId === 'string' && groups.some(group => group.id === entry.groupId)
                ? entry.groupId : '';
            const order = typeof entry.order === 'number' && Number.isFinite(entry.order) && entry.order >= 0
                ? Math.floor(entry.order) : 0;
            const jsonPath = typeof entry.jsonPath === 'string' && path.isAbsolute(entry.jsonPath)
                && path.extname(entry.jsonPath).toLocaleLowerCase() === '.json' ? entry.jsonPath : undefined;
            try { placements[canonicalFileUri(id)] = { groupId, order, ...(jsonPath ? { jsonPath } : {}) }; }
            catch { /* Ignore malformed file URIs from persisted state. */ }
        }
    }
    return { groups, placements };
}

export class StandaloneFeatureService implements vscode.Disposable {
    private static readonly instances = new WeakMap<vscode.ExtensionContext, StandaloneFeatureService>();
    private readonly listeners = new Set<(snapshot: StandaloneFeatureSnapshot) => void>();
    private readonly refreshListeners = new Set<(snapshot: StandaloneFeatureSnapshot) => void>();
    private readonly disposables: DisposableLike[] = [];
    private readonly watches = new Map<string, DisposableLike>();
    private readonly metadataWatches = new Map<string, DisposableLike>();
    private readonly jsonWatches = new Map<string, DisposableLike>();
    private readonly organization: FeatureOrganization;
    private readonly legacyOrganization: FeatureOrganization;
    private readonly groupRoots = new Map<string, Set<string>>();
    private readonly sharedOrders = new Map<string, number | null>();
    private projectRoots: readonly string[] = [];
    private discovered: readonly DiscoveredFeature[] = [];
    private snapshot: StandaloneFeatureSnapshot = Object.freeze({
        features: Object.freeze([]), groups: Object.freeze([]), revision: 0
    });
    private compiledPaths = new Set<string>();
    private generation = 0;
    private dirty = true;
    private disposed = false;
    private inFlight: Promise<StandaloneFeatureSnapshot> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private metadataTimer: ReturnType<typeof setTimeout> | undefined;
    private mutations: Promise<void> = Promise.resolve();

    readonly onDidChange = (listener: (snapshot: StandaloneFeatureSnapshot) => void): DisposableLike => {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    };

    /** Includes source-only edits, which do not change the catalog metadata. */
    readonly onDidRefresh = (listener: (snapshot: StandaloneFeatureSnapshot) => void): DisposableLike => {
        this.refreshListeners.add(listener);
        return { dispose: () => { this.refreshListeners.delete(listener); } };
    };

    constructor(private readonly dependencies: StandaloneFeatureServiceDependencies) {
        this.organization = readOrganization(dependencies.workspaceState.get(STATE_KEY));
        this.legacyOrganization = readOrganization(dependencies.workspaceState.get(STATE_KEY));
        if (dependencies.onDidChangeRoots) {
            this.disposables.push(dependencies.onDidChangeRoots(() => this.invalidate()));
        }
        if (dependencies.onDidRenameFiles) {
            this.disposables.push(dependencies.onDidRenameFiles(renames => {
                void this.handleRenames(renames).catch(error => this.log(error));
            }));
        }
    }

    static getInstance(context: vscode.ExtensionContext): StandaloneFeatureService {
        const existing = this.instances.get(context);
        if (existing && !existing.disposed) { return existing; }
        const api = require('vscode') as typeof vscode;
        const scanRoot = require('./scenarioScanRoot') as typeof import('./scenarioScanRoot');
        const service = new StandaloneFeatureService({
            workspaceState: context.workspaceState,
            getRoots: () => {
                const configured = scanRoot.getScenarioScanRootPath();
                if (path.isAbsolute(configured)) { return [configured]; }
                return (api.workspace.workspaceFolders ?? []).map(folder =>
                    scanRoot.resolveScenarioScanRootFsPath(folder.uri)
                );
            },
            getProjectRoot: sourcePath => {
                const workspaceRoots = (api.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
                const configured = scanRoot.getScenarioScanRootPath();
                const scanRoots = path.isAbsolute(configured) ? [configured]
                    : (api.workspace.workspaceFolders ?? []).map(folder => scanRoot.resolveScenarioScanRootFsPath(folder.uri));
                return resolveProjectLibraryRoot(sourcePath, workspaceRoots, scanRoots);
            },
            assertProjectMetadataSaved: root => {
                const integration = require('./projectLibraryIntegration') as typeof import('./projectLibraryIntegration');
                integration.assertProjectMetadataSaved(root);
            },
            assertOrderingSourcesSaved: files => {
                const integration = require('./projectLibraryIntegration') as typeof import('./projectLibraryIntegration');
                integration.assertProjectOrderingSourcesSaved(files);
            },
            watchRoot: (root, listener) => {
                const watchers = [
                    api.workspace.createFileSystemWatcher(new api.RelativePattern(api.Uri.file(root), '**/*')),
                    api.workspace.createFileSystemWatcher(new api.RelativePattern(api.Uri.file(path.dirname(root)), path.basename(root)))
                ];
                const subscriptions = watchers.flatMap(watcher => [
                    watcher.onDidCreate(uri => listener(uri.fsPath)), watcher.onDidChange(uri => listener(uri.fsPath)), watcher.onDidDelete(uri => listener(uri.fsPath))
                ]);
                return { dispose: () => {
                    for (const disposable of [...subscriptions, ...watchers]) { disposable.dispose(); }
                } };
            },
            watchFile: (file, listener) => {
                const watcher = api.workspace.createFileSystemWatcher(
                    new api.RelativePattern(api.Uri.file(path.dirname(file)), path.basename(file))
                );
                const subscriptions = [watcher.onDidCreate(listener), watcher.onDidChange(listener), watcher.onDidDelete(listener)];
                return { dispose: () => { for (const disposable of [...subscriptions, watcher]) { disposable.dispose(); } } };
            },
            watchProjectMetadataRoot: (root, listener) => {
                const watcher = api.workspace.createFileSystemWatcher(
                    new api.RelativePattern(api.Uri.file(root), '**/*.kot.yml')
                );
                const subscriptions = [watcher.onDidCreate(listener), watcher.onDidChange(listener), watcher.onDidDelete(listener)];
                return { dispose: () => { for (const disposable of [...subscriptions, watcher]) { disposable.dispose(); } } };
            },
            onDidChangeRoots: listener => {
                const subscriptions = [
                    scanRoot.onDidChangeScenarioScanRoot(listener),
                    api.workspace.onDidChangeWorkspaceFolders(listener)
                ];
                return { dispose: () => { for (const subscription of subscriptions) { subscription.dispose(); } } };
            },
            onDidRenameFiles: listener => api.workspace.onDidRenameFiles(event => {
                listener(event.files.filter(file => file.oldUri.scheme === 'file' && file.newUri.scheme === 'file')
                    .map(file => ({ oldPath: file.oldUri.fsPath, newPath: file.newUri.fsPath })));
            }),
            log: message => console.warn(`[Standalone features] ${message}`)
        });
        this.instances.set(context, service);
        context.subscriptions.push(service);
        return service;
    }

    getSnapshot(): StandaloneFeatureSnapshot { return this.snapshot; }

    ensureReady(): Promise<StandaloneFeatureSnapshot> {
        if (this.disposed) { return Promise.reject(new Error('Standalone feature catalog is disposed.')); }
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        if (this.inFlight) { return this.inFlight; }
        if (!this.dirty) { return Promise.resolve(this.snapshot); }
        const load = this.scanUntilCurrent().finally(() => {
            if (this.inFlight === load) { this.inFlight = undefined; }
        });
        this.inFlight = load;
        return load;
    }

    refresh(): Promise<StandaloneFeatureSnapshot> {
        this.generation += 1;
        this.dirty = true;
        return this.ensureReady();
    }

    async refreshProjectMetadata(): Promise<StandaloneFeatureSnapshot> {
        await this.ensureReady();
        const generation = this.generation;
        await this.readProjectOrganization(this.projectRoots, true);
        if (generation !== this.generation) { return this.refreshProjectMetadata(); }
        for (const feature of this.discovered) {
            if (!this.organization.placements[feature.id]) {
                this.organization.placements[feature.id] = { groupId: '', order: this.nextOrder('') };
            }
        }
        this.publish(false);
        return this.snapshot;
    }

    setCompiledFeaturePaths(paths: readonly string[]): void {
        const next = new Set<string>();
        for (const value of paths) {
            try { if (value.trim()) { next.add(normalizedPath(filePath(value))); } }
            catch { /* Ignore invalid artifact paths. */ }
        }
        if (next.size === this.compiledPaths.size && [...next].every(value => this.compiledPaths.has(value))) { return; }
        this.compiledPaths = next;
        this.invalidate();
    }

    find(id: string): StandaloneFeatureEntry | undefined {
        try {
            const canonical = canonicalFileUri(id);
            return this.snapshot.features.find(feature => feature.id === canonical);
        } catch { return undefined; }
    }

    createGroup(name: string): Promise<StandaloneFeatureGroup> {
        return this.mutate(async () => {
            await this.ensureReady();
            const root = this.projectRoots[0];
            if (!root) { throw new Error('A project test root is required to create a feature group.'); }
            const group = await this.writableStore(root).ensureGroup(this.requireName(name), 'standalone');
            await this.refresh();
            return Object.freeze({ id: group.id, name: group.name });
        });
    }

    renameGroup(id: string, name: string): Promise<void> {
        return this.mutate(async () => {
            await this.ensureReady();
            this.requireGroup(id);
            this.assertSharedWritesAllowed(this.groupRoots.get(id) ?? []);
            for (const root of this.groupRoots.get(id) ?? []) {
                await this.writableStore(root).renameGroup(id, this.requireName(name));
            }
            await this.refresh();
        });
    }

    deleteGroup(id: string): Promise<void> {
        return this.mutate(async () => {
            await this.ensureReady();
            this.requireGroup(id);
            const returned = [...this.orderedPlacementIds(''), ...this.orderedPlacementIds(id)];
            this.assertSharedWritesAllowed([...(this.groupRoots.get(id) ?? []),
                ...returned.map(featureId => this.projectRoot(fileURLToPath(featureId)))]);
            for (const root of this.groupRoots.get(id) ?? []) { await this.writableStore(root).deleteGroup(id); }
            for (const [order, featureId] of returned.entries()) {
                this.organization.placements[featureId] = { ...this.organization.placements[featureId], groupId: '', order };
                await this.writePlacement(featureId);
            }
            await this.refresh();
        });
    }

    moveGroupDisplay(projectRoot: string, id: string, beforeId: string | undefined, expectedIds: readonly string[], revision: number): Promise<void> {
        return this.mutate(async () => {
            await this.ensureReady();
            if (revision !== this.snapshot.revision || !this.groupRoots.get(id)?.has(projectRoot)) {
                throw new Error('The feature groups changed. Refresh the panel and try again.');
            }
            const groups = (await this.store(projectRoot).readMetadata()).groups;
            await new ProjectGroupDisplayOrder(this.dependencies.workspaceState).move(projectRoot, 'standalone', groups, id, beforeId, expectedIds);
            await this.refreshProjectMetadata();
        });
    }

    moveFeature(id: string, groupId: string, beforeId?: string, drop?: { readonly revision: number; readonly projectRoot: string }): Promise<void> {
        return this.mutate(async () => {
            await this.ensureReady();
            const feature = this.requireFeature(id);
            id = feature.id;
            if (drop) {
                const root = this.projectRoot(fileURLToPath(id));
                if (drop.revision !== this.snapshot.revision || root !== drop.projectRoot
                    || (groupId && !this.groupRoots.get(groupId)?.has(root))) { throw new Error('The feature ordering target changed or belongs to another project.'); }
                if (beforeId && this.projectRoot(fileURLToPath(this.requireFeature(beforeId).id)) !== root) {
                    throw new Error('The feature ordering target belongs to another project.');
                }
                const expected = (owner: string) => this.orderedPlacementIds(owner).filter(featureId => this.projectRoot(fileURLToPath(featureId)) === root)
                    .map(featureId => ({ key: projectEntityKey(this.identity(featureId, root)), order: this.sharedOrders.get(featureId) ?? null }));
                const beforeKey = beforeId ? projectEntityKey(this.identity(this.requireFeature(beforeId).id, root)) : undefined;
                const affected = [...new Set([...this.orderedPlacementIds(feature.groupId), ...this.orderedPlacementIds(groupId)])]
                    .filter(featureId => this.projectRoot(fileURLToPath(featureId)) === root).map(featureId => fileURLToPath(featureId));
                await this.store(root, () => this.dependencies.assertOrderingSourcesSaved?.(affected)).moveEntity('standalone', this.identity(id, root), groupId, beforeKey,
                    expected(feature.groupId), expected(groupId));
                await this.refreshProjectMetadata();
                return;
            }
            if (groupId) {
                this.requireGroup(groupId);
                const group = await this.currentGroup(groupId);
                const targetRoot = this.projectRoot(fileURLToPath(id));
                const existing = (await this.store(targetRoot).readMetadata()).groups.find(candidate => candidate.id === groupId
                    && candidate.sections.includes('standalone'));
                if (!existing) {
                    groupId = (await this.writableStore(targetRoot).ensureGroup(group.name, 'standalone', group.id)).id;
                }
            }
            if (beforeId) {
                const before = this.requireFeature(beforeId);
                beforeId = before.id;
                if (before.groupId !== groupId) { throw new Error('The ordering target belongs to a different group.'); }
                if (this.projectRoot(fileURLToPath(beforeId)) !== this.projectRoot(fileURLToPath(id))) {
                    throw new Error('The feature ordering target belongs to another project.');
                }
                if (beforeId === id) { return; }
            }
            const root = this.projectRoot(fileURLToPath(id));
            const expected = (owner: string) => this.orderedPlacementIds(owner).filter(featureId => this.projectRoot(fileURLToPath(featureId)) === root)
                .map(featureId => ({ key: projectEntityKey(this.identity(featureId, root)), order: this.sharedOrders.get(featureId) ?? null }));
            const beforeKey = beforeId ? projectEntityKey(this.identity(beforeId, root)) : undefined;
            const affected = [...new Set([...this.orderedPlacementIds(feature.groupId), ...this.orderedPlacementIds(groupId)])]
                .filter(featureId => this.projectRoot(fileURLToPath(featureId)) === root).map(featureId => fileURLToPath(featureId));
            await this.store(root, () => this.dependencies.assertOrderingSourcesSaved?.(affected)).moveEntity('standalone', this.identity(id, root), groupId, beforeKey,
                expected(feature.groupId), expected(groupId));
            await this.refreshProjectMetadata();
        });
    }

    setLaunchJson(id: string, jsonPath: string): Promise<void> {
        return this.mutate(async () => {
            await this.ensureReady();
            id = this.requireFeature(id).id;
            if (!jsonPath || !path.isAbsolute(jsonPath) || !await this.isJsonFile(jsonPath)) {
                throw new Error('Choose an existing JSON file using its absolute path.');
            }
            const normalized = path.resolve(jsonPath);
            this.organization.placements[id] = { ...this.organization.placements[id], jsonPath: normalized };
            await this.persist();
            await this.refresh();
        });
    }

    dispose(): void {
        this.disposed = true;
        this.generation += 1;
        if (this.timer) { clearTimeout(this.timer); }
        if (this.metadataTimer) { clearTimeout(this.metadataTimer); }
        for (const disposable of [...this.disposables, ...this.watches.values(), ...this.metadataWatches.values(), ...this.jsonWatches.values()]) { disposable.dispose(); }
        this.watches.clear();
        this.metadataWatches.clear();
        this.jsonWatches.clear();
        this.listeners.clear();
        this.refreshListeners.clear();
    }

    private invalidate(): void {
        if (this.disposed) { return; }
        this.generation += 1;
        this.dirty = true;
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.ensureReady().catch(error => this.log(error));
            }, 75);
        }
    }

    private metadataChanged(): void {
        if (this.disposed || this.metadataTimer) { return; }
        this.metadataTimer = setTimeout(() => {
            this.metadataTimer = undefined;
            void this.refreshProjectMetadata().catch(error => this.log(error));
        }, 75);
    }

    private async scanUntilCurrent(): Promise<StandaloneFeatureSnapshot> {
        while (this.dirty && !this.disposed) {
            const generation = this.generation;
            const roots = [...new Set(this.dependencies.getRoots().filter(Boolean).map(root => path.resolve(root)))];
            const projectRoots = [...new Set(roots.map(root => this.projectRoot(root)))];
            this.updateWatches([...roots, ...projectRoots.map(root => path.join(root, '.kot'))]);
            this.updateMetadataWatches(projectRoots);
            this.updateJsonWatches(roots);
            const exclusions = new Set(this.compiledPaths);
            for (const compiled of this.compiledPaths) {
                try { exclusions.add(normalizedPath(await fs.realpath(compiled))); }
                catch { /* Artifacts may not exist yet. */ }
            }
            const found = new Map<string, DiscoveredFeature>();
            for (const root of roots) { await this.scanDirectory(root, root, exclusions, found); }
            if (this.disposed) { break; }
            if (generation !== this.generation) { continue; }
            this.discovered = [...found.values()].sort((left, right) =>
                compareText(left.relativePath, right.relativePath) || compareText(left.id, right.id)
            );
            await this.readProjectOrganization(projectRoots);
            let addedPlacements = false;
            for (const feature of this.discovered) {
                if (!this.organization.placements[feature.id]) {
                    this.organization.placements[feature.id] = { groupId: '', order: this.nextOrder('') };
                    addedPlacements = true;
                }
            }
            if (addedPlacements || this.snapshot.revision === 0) { await this.persist(); }
            if (generation !== this.generation) { continue; }
            this.dirty = false;
            this.publish();
        }
        return this.snapshot;
    }

    private async scanDirectory(
        root: string,
        directory: string,
        exclusions: ReadonlySet<string>,
        found: Map<string, DiscoveredFeature>
    ): Promise<void> {
        let entries;
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) { this.log(error); return; }
        for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
            if (this.disposed || entry.isSymbolicLink()) { continue; }
            const sourcePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase())
                    && this.projectRoot(sourcePath) === this.projectRoot(root)) {
                    await this.scanDirectory(root, sourcePath, exclusions, found);
                }
                continue;
            }
            if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== '.feature') { continue; }
            try {
                if (exclusions.has(normalizedPath(sourcePath))
                    || exclusions.has(normalizedPath(await fs.realpath(sourcePath)))) { continue; }
                const id = canonicalFileUri(sourcePath);
                if (found.has(id)) { continue; }
                const name = path.basename(entry.name, path.extname(entry.name));
                const metadata = parseStandaloneFeatureSource(await fs.readFile(sourcePath, 'utf8'), name);
                if (metadata.exportOnly) { continue; }
                const selected = this.organization.placements[id]?.jsonPath;
                const adjacent = path.join(directory, `${name}.json`);
                const jsonPath = selected && await this.isJsonFile(selected)
                    ? selected : await this.isJsonFile(adjacent) ? adjacent : undefined;
                found.set(id, {
                    id, uri: id, name, title: metadata.title, language: metadata.language,
                    relativePath: path.relative(root, sourcePath).split(path.sep).join('/'),
                    ...(jsonPath ? { jsonPath } : {})
                });
            } catch (error) { this.log(error); }
        }
    }

    private updateWatches(roots: readonly string[]): void {
        for (const [root, watch] of this.watches) {
            if (!roots.includes(root)) { watch.dispose(); this.watches.delete(root); }
        }
        if (this.dependencies.watchRoot) {
            for (const root of roots) {
                if (!this.watches.has(root)) {
                    this.watches.set(root, this.dependencies.watchRoot(root, filePath => {
                        if (filePath?.endsWith('.tmp')) { return; }
                        if (filePath && (filePath.endsWith('.kot.yml') || (filePath.split(path.sep).includes('.kot') && /\.ya?ml$/iu.test(filePath)))) {
                            this.metadataChanged();
                        } else { this.invalidate(); }
                    }));
                }
            }
        }
    }

    private updateMetadataWatches(roots: readonly string[]): void {
        for (const [root, watch] of this.metadataWatches) {
            if (!roots.includes(root)) { watch.dispose(); this.metadataWatches.delete(root); }
        }
        if (this.dependencies.watchProjectMetadataRoot) {
            for (const root of roots) {
                if (!this.metadataWatches.has(root)) {
                    this.metadataWatches.set(root, this.dependencies.watchProjectMetadataRoot(root, () => this.metadataChanged()));
                }
            }
        }
    }

    private publish(sourceRefresh = true): void {
        const groupKey = (id: string, root?: string) => JSON.stringify([root ?? '', id]);
        const groupOrder = new Map([[groupKey(''), 0], ...this.organization.groups.map((group, index) => [groupKey(group.id, group.projectRoot), index + 1] as const)]);
        const features = this.discovered.map(feature => {
            const placement = this.organization.placements[feature.id];
            return Object.freeze({ ...feature, groupId: placement.groupId, order: placement.order });
        }).sort((left, right) =>
            (groupOrder.get(groupKey(left.groupId, this.groupRoots.get(left.groupId)?.size === 1 ? undefined : this.projectRoot(fileURLToPath(left.id)))) ?? 0)
                - (groupOrder.get(groupKey(right.groupId, this.groupRoots.get(right.groupId)?.size === 1 ? undefined : this.projectRoot(fileURLToPath(right.id)))) ?? 0)
            || left.order - right.order || compareText(left.id, right.id)
        );
        const groups = this.organization.groups.slice();
        const ordering = { groupRoots: Object.fromEntries([...this.groupRoots].map(([id, roots]) => [id, [...roots]])),
            featureRoots: Object.fromEntries(this.discovered.map(feature => [feature.id, this.projectRoot(fileURLToPath(feature.id))])) };
        if (JSON.stringify([features, groups, ordering]) !== JSON.stringify([this.snapshot.features, this.snapshot.groups, this.snapshot.ordering])
            || this.snapshot.revision === 0) {
            this.snapshot = Object.freeze({
                features: Object.freeze(features), groups: Object.freeze(groups), ordering, revision: this.snapshot.revision + 1
            });
            for (const listener of [...this.listeners]) { listener(this.snapshot); }
        }
        if (sourceRefresh) { for (const listener of [...this.refreshListeners]) { listener(this.snapshot); } }
    }

    private updateJsonWatches(roots: readonly string[]): void {
        const files = new Set(Object.values(this.organization.placements)
            .flatMap(placement => placement.jsonPath ? [placement.jsonPath] : [])
            .filter(file => !roots.some(root => {
                const relative = path.relative(root, file);
                return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
            })));
        for (const [file, watcher] of this.jsonWatches) {
            if (!files.has(file)) { watcher.dispose(); this.jsonWatches.delete(file); }
        }
        if (this.dependencies.watchFile) {
            for (const file of files) {
                if (!this.jsonWatches.has(file)) {
                    this.jsonWatches.set(file, this.dependencies.watchFile(file, () => this.invalidate()));
                }
            }
        }
    }

    private orderedPlacementIds(groupId: string): string[] {
        return Object.keys(this.organization.placements)
            .filter(id => {
                if (this.organization.placements[id].groupId !== groupId) { return false; }
                try { return this.projectRoots.includes(this.projectRoot(fileURLToPath(id))); }
                catch { return false; }
            })
            .sort((left, right) => this.organization.placements[left].order - this.organization.placements[right].order
                || compareText(left, right));
    }

    private nextOrder(groupId: string): number {
        return Math.max(-1, ...Object.values(this.organization.placements)
            .filter(placement => placement.groupId === groupId).map(placement => placement.order)) + 1;
    }

    private requireName(value: string): string {
        const name = value.trim();
        if (!name) { throw new Error('A group name is required.'); }
        return name;
    }

    private requireGroup(id: string): number {
        const index = this.organization.groups.findIndex(group => group.id === id);
        if (index < 0) { throw new Error('The feature group no longer exists.'); }
        return index;
    }

    private requireFeature(id: string): StandaloneFeatureEntry {
        const feature = this.find(id);
        if (!feature) { throw new Error('The feature file no longer exists in the catalog.'); }
        return feature;
    }

    private projectRoot(sourcePath: string): string {
        const configured = this.dependencies.getProjectRoot?.(sourcePath);
        if (configured) { return path.resolve(configured); }
        return resolveProjectLibraryRoot(sourcePath, [], this.dependencies.getRoots());
    }

    private store(root: string, beforeWrite?: () => void): ProjectLibraryStore {
        const projectRoots = [...new Set(this.dependencies.getRoots().map(scanRoot => this.projectRoot(path.resolve(scanRoot))))];
        return new ProjectLibraryStore(root, {
            // Scenario source cleanup belongs to the scenario scan, which knows dirty editors and source snapshots.
            canCleanSource: () => false,
            beforeWrite: () => { this.assertSharedWritesAllowed([root]); beforeWrite?.(); },
            discoveryRoots: this.dependencies.getRoots().filter(scanRoot => this.projectRoot(path.resolve(scanRoot)) === root),
            excludedRoots: projectRoots.filter(projectRoot => projectRoot !== root && containsPath(root, projectRoot)),
            sourceIdentities: this.discovered.filter(feature => this.projectRoot(fileURLToPath(feature.id)) === root)
                .map(feature => this.identity(feature.id, root)),
            onWarning: message => this.dependencies.log?.(message)
        });
    }

    private assertSharedWritesAllowed(roots: Iterable<string>): void {
        for (const root of new Set(roots)) { this.dependencies.assertProjectMetadataSaved?.(root); }
    }

    private writableStore(root: string): ProjectLibraryStore {
        this.assertSharedWritesAllowed([root]);
        return this.store(root);
    }

    private identity(id: string, root = this.projectRoot(fileURLToPath(id))): ProjectEntityIdentity {
        return resolveProjectEntityIdentity(fileURLToPath(id), root, 'feature');
    }

    private async writePlacement(id: string): Promise<void> {
        const root = this.projectRoot(fileURLToPath(id));
        const placement = this.organization.placements[id];
        await this.writableStore(root).setMetadata(this.identity(id, root), {
            groupId: placement.groupId, order: placement.order
        });
    }

    private async currentGroup(id: string): Promise<StandaloneFeatureGroup> {
        for (const root of this.groupRoots.get(id) ?? []) {
            const group = (await this.store(root).read()).groups.find(candidate => candidate.id === id
                && candidate.sections.includes('standalone'));
            if (group) { return group; }
        }
        throw new Error('The feature group no longer exists.');
    }

    private async readProjectOrganization(roots: readonly string[], metadataOnly = false): Promise<void> {
        const groups: StandaloneFeatureGroup[] = [];
        const placements: Record<string, FeaturePlacement> = Object.create(null);
        const localJsonPaths = new Map(Object.entries(this.organization.placements)
            .flatMap(([id, placement]) => placement.jsonPath ? [[id, placement.jsonPath] as const] : []));
        const groupRoots = new Map<string, Set<string>>();
        const sharedOrders = new Map<string, number | null>();
        const existingRoots: string[] = [];
        for (const root of roots) {
            try { if (!(await fs.stat(root)).isDirectory()) { continue; } }
            catch (error) { this.log(error); continue; }
            existingRoots.push(root);
            const store = this.store(root);
            let snapshot = await (metadataOnly ? store.readMetadata() : store.read());
            if (!metadataOnly && !snapshot.legacyImports.includes('standalone')) {
                const legacyIds = new Set(this.discovered.filter(feature => this.projectRoot(fileURLToPath(feature.id)) === root)
                    .map(feature => feature.id));
                for (const id of Object.keys(this.legacyOrganization.placements)) {
                    const sourcePath = fileURLToPath(id);
                    if (this.projectRoot(sourcePath) === root && !this.compiledPaths.has(normalizedPath(sourcePath))) { legacyIds.add(id); }
                }
                const legacyGroups = this.legacyOrganization.groups.filter(group => root === roots[0]
                    || [...legacyIds].some(id => this.legacyOrganization.placements[id]?.groupId === group.id));
                await this.writableStore(root).importLegacy({
                    groups: legacyGroups.map((group, order) => ({ ...group, sections: ['standalone'], order })),
                    entities: [...legacyIds].map(id => {
                        const placement = this.legacyOrganization.placements[id];
                        return { identity: this.identity(id, root), metadata: placement
                            ? { groupId: placement.groupId, order: placement.order } : {} };
                    })
                }, 'standalone');
                snapshot = await store.read();
            }
            for (const group of new ProjectGroupDisplayOrder(this.dependencies.workspaceState).ordered(root, 'standalone', snapshot.groups)) {
                const owners = groupRoots.get(group.id) ?? new Set<string>();
                if (owners.size > 0) {
                    const previousRoot = [...owners][0];
                    const previousIndex = groups.findIndex(candidate => candidate.id === group.id && !candidate.projectRoot);
                    if (previousIndex >= 0) { groups[previousIndex] = Object.freeze({ ...groups[previousIndex], projectRoot: previousRoot }); }
                    groups.push(Object.freeze({ id: group.id, name: group.name, projectRoot: root }));
                } else { groups.push(Object.freeze({ id: group.id, name: group.name })); }
                owners.add(root);
                groupRoots.set(group.id, owners);
            }
            for (const [key, identity] of Object.entries(snapshot.identities).sort((left, right) =>
                compareText(left[1].relativePath, right[1].relativePath) || compareText(left[0], right[0]))) {
                if (identity.kind !== 'feature') { continue; }
                const id = canonicalFileUri(path.join(root, identity.relativePath));
                const metadata: ProjectEntityMetadata = snapshot.metadata[key] ?? {};
                sharedOrders.set(id, metadata.order ?? null);
                const groupId = metadata.groupId && snapshot.groups.some(group => group.id === metadata.groupId
                    && group.sections.includes('standalone')) ? metadata.groupId : '';
                const jsonPath = localJsonPaths.get(id);
                placements[id] = { groupId, order: metadata.order ?? this.nextDefaultOrder(placements, groupId),
                    ...(jsonPath ? { jsonPath } : {}) };
            }
        }
        for (const [id, jsonPath] of localJsonPaths) {
            if (!placements[id]) { placements[id] = { groupId: '', order: this.nextDefaultOrder(placements, ''), jsonPath }; }
        }
        this.projectRoots = existingRoots;
        this.groupRoots.clear();
        for (const [id, owners] of groupRoots) { this.groupRoots.set(id, owners); }
        this.sharedOrders.clear();
        for (const [id, order] of sharedOrders) { this.sharedOrders.set(id, order); }
        this.organization.groups.splice(0, this.organization.groups.length, ...groups);
        for (const id of Object.keys(this.organization.placements)) { delete this.organization.placements[id]; }
        Object.assign(this.organization.placements, placements);
    }

    private nextDefaultOrder(placements: Readonly<Record<string, FeaturePlacement>>, groupId: string): number {
        return Math.max(-1, ...Object.values(placements).filter(placement => placement.groupId === groupId)
            .map(placement => placement.order)) + 1;
    }

    private async isJsonFile(jsonPath: string): Promise<boolean> {
        if (path.extname(jsonPath).toLocaleLowerCase() !== '.json') { return false; }
        try { return (await fs.stat(jsonPath)).isFile(); } catch { return false; }
    }

    private persist(): PromiseLike<void> {
        const placements: Record<string, { jsonPath: string }> = Object.create(null);
        for (const [id, placement] of Object.entries(this.organization.placements)) {
            if (placement.jsonPath) { placements[id] = { jsonPath: placement.jsonPath }; }
        }
        return this.dependencies.workspaceState.update(STATE_KEY, { placements });
    }

    private mutate<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutations.then(operation);
        this.mutations = result.then(() => {}, () => {});
        return result;
    }

    private handleRenames(renames: readonly { oldPath: string; newPath: string }[]): Promise<void> {
        return this.mutate(async () => {
            this.generation += 1;
            this.dirty = true;
            const remap = (sourcePath: string): string => {
                for (const rename of renames) {
                    const relative = path.relative(rename.oldPath, sourcePath);
                    if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
                        return path.join(rename.newPath, relative);
                    }
                }
                return sourcePath;
            };
            const placements: Record<string, FeaturePlacement> = Object.create(null);
            const movedPlacements: Record<string, FeaturePlacement> = Object.create(null);
            for (const [id, placement] of Object.entries(this.organization.placements)) {
                let targetId: string;
                try {
                    targetId = canonicalFileUri(remap(fileURLToPath(id)));
                } catch { placements[id] = placement; continue; }
                if (targetId !== id) {
                    const oldRoot = this.projectRoot(fileURLToPath(id));
                    const newRoot = this.projectRoot(fileURLToPath(targetId));
                    const oldSidecar = metadataFilePath(oldRoot, this.identity(id, oldRoot));
                    const newSidecar = metadataFilePath(newRoot, this.identity(targetId, newRoot));
                    await this.remapPlacement(id, targetId, normalizedPath(remap(oldSidecar)) === normalizedPath(newSidecar));
                }
                (targetId === id ? placements : movedPlacements)[targetId] = {
                    ...placement, ...(placement.jsonPath ? { jsonPath: remap(placement.jsonPath) } : {})
                };
            }
            Object.assign(placements, movedPlacements);
            for (const id of Object.keys(this.organization.placements)) { delete this.organization.placements[id]; }
            Object.assign(this.organization.placements, placements);
            await this.persist();
            await this.refresh();
        });
    }

    private async remapPlacement(oldId: string, newId: string, sidecarMoved: boolean): Promise<void> {
        const oldRoot = this.projectRoot(fileURLToPath(oldId));
        const newRoot = this.projectRoot(fileURLToPath(newId));
        const oldIdentity = this.identity(oldId, oldRoot);
        // A directory move already carries the sidecar. Its physical filename is authoritative.
        if (oldRoot === newRoot && sidecarMoved) { return; }
        this.assertSharedWritesAllowed([oldRoot, newRoot]);
        if (oldRoot === newRoot) {
            await this.writableStore(oldRoot).remapEntity(oldIdentity, this.identity(newId, newRoot), true);
            return;
        }
        const oldSnapshot = await this.store(oldRoot).read();
        const metadata = oldSnapshot.metadata[projectEntityKey(oldIdentity)]
            ?? (sidecarMoved ? (await this.store(newRoot).read()).metadata[projectEntityKey(this.identity(newId, newRoot))] : undefined);
        if (!metadata) { return; }
        const group = oldSnapshot.groups.find(candidate => candidate.id === metadata.groupId
            && candidate.sections.includes('standalone'));
        const destinationGroupId = group
            ? (await this.writableStore(newRoot).ensureGroup(group.name, 'standalone', group.id)).id : '';
        await this.writableStore(newRoot).setMetadata(this.identity(newId, newRoot), {
            groupId: destinationGroupId, order: metadata.order ?? null,
            description: metadata.description ?? null, category: metadata.category ?? null
        });
        await this.writableStore(oldRoot).deleteMetadata(oldIdentity);
    }

    private log(error: unknown): void {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code !== 'ENOENT') { this.dependencies.log?.(String(error)); }
    }
}
