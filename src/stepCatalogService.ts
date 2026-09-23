import * as path from 'node:path';
import type * as vscode from 'vscode';
import { parseLegacyStepsHtml } from './legacyStepCatalog';
import {
    ResolvedStepCatalog,
    sha256Hex
} from './stepCatalog';
import {
    StepCatalogStorage,
    VersionedCatalogResult,
    VersionedStepCatalogClient
} from './stepCatalogClient';
import { fetchHttpsBytes } from './stepCatalogHttp';
import {
    extractVanessaVersionFromChangelog,
    getVanessaChangelogPath,
    normalizeVanessaVersion,
    PathOperations,
    resolveWorkspaceSettingPath
} from './vanessaVersion';

const CUSTOM_HTML_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_CATALOG_INDEX_URL =
    'https://raw.githubusercontent.com/alexiosus/KOTfor1C/step-catalogs/index.json';

export interface WorkspaceStepCatalogFolder {
    readonly uri: string;
    readonly fsPath: string;
}

export interface WorkspaceStepCatalogConfiguration {
    readonly vanessaVersion: string;
    readonly vanessaEpfPath: string;
    readonly catalogIndexUrl: string;
    readonly externalUrl: string;
}

export interface WorkspaceStepCatalogFileStat {
    readonly mtime: number;
    readonly size: number;
}

export interface WorkspaceStepCatalogChangeEvent {
    readonly workspaceFolderUri?: string;
    readonly oldIdentity?: string;
    readonly newIdentity: string;
}

export interface WorkspaceStepCatalogDependencies {
    readonly pathOperations: PathOperations;
    getWorkspaceFolder(documentUri?: string): WorkspaceStepCatalogFolder | undefined;
    getWorkspaceFolders(): readonly WorkspaceStepCatalogFolder[];
    getConfiguration(workspaceFolderUri?: string): WorkspaceStepCatalogConfiguration;
    statFile(filePath: string): Promise<WorkspaceStepCatalogFileStat | null>;
    readTextFile(filePath: string): Promise<string>;
    readBundledHtml(): Promise<string>;
    readCustomHtml(url: string): Promise<string>;
    getCachedExactCatalog(
        indexUrl: string,
        version: string
    ): Promise<VersionedCatalogResult | null>;
    getExactCatalog(
        indexUrl: string,
        version: string,
        signal?: AbortSignal
    ): Promise<VersionedCatalogResult | null>;
    refreshExactCatalog(
        indexUrl: string,
        version: string,
        signal?: AbortSignal
    ): Promise<VersionedCatalogResult | null>;
    warn(message: string, error?: unknown): void;
}

interface VersionResolution {
    readonly version?: string;
    readonly fingerprint: string;
}

interface FolderCatalogState {
    readonly selectionKey: string;
    readonly generation: number;
    catalog: ResolvedStepCatalog;
}

type CatalogListener = (event: WorkspaceStepCatalogChangeEvent) => void;

function resolveVersionedCatalog(
    result: VersionedCatalogResult,
    requestedVersion: string
): ResolvedStepCatalog {
    return {
        identity: `versioned:${result.digest}`,
        requestedVersion,
        catalogVersion: result.catalog.vanessaVersion,
        source: result.source,
        steps: result.catalog.steps
    };
}

function resolveLegacyCatalog(
    html: string,
    source: 'custom-html' | 'bundled-html',
    requestedVersion?: string
): ResolvedStepCatalog {
    return {
        identity: `${source}:${sha256Hex(html)}`,
        requestedVersion,
        catalogVersion: 'legacy-html',
        source,
        steps: parseLegacyStepsHtml(html)
    };
}

export class WorkspaceStepCatalogCoordinator {
    private readonly listeners = new Set<CatalogListener>();
    private readonly states = new Map<string, FolderCatalogState>();
    private readonly generationByFolder = new Map<string, number>();
    private readonly versionByFingerprint = new Map<string, string | null>();
    private readonly exactCatalogs = new Map<string, ResolvedStepCatalog>();
    private readonly exactLookups = new Map<string, Promise<VersionedCatalogResult | null>>();
    private readonly backgroundTasks = new Set<Promise<void>>();
    private readonly catalogLoads = new Map<string, Promise<ResolvedStepCatalog>>();
    private readonly customFallbacks = new Map<string, Promise<ResolvedStepCatalog | null>>();
    private bundledFallback: Promise<ResolvedStepCatalog> | undefined;

    public constructor(private readonly dependencies: WorkspaceStepCatalogDependencies) {}

    public onDidChangeCatalog(listener: CatalogListener): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    public async getCatalog(documentUri?: string): Promise<ResolvedStepCatalog> {
        const folder = this.dependencies.getWorkspaceFolder(documentUri);
        const folderKey = folder?.uri ?? '<no-workspace-folder>';
        const existingLoad = this.catalogLoads.get(folderKey);
        if (existingLoad) {
            return existingLoad;
        }

        let trackedLoad!: Promise<ResolvedStepCatalog>;
        trackedLoad = this.resolveCatalog(folder, folderKey).finally(() => {
            if (this.catalogLoads.get(folderKey) === trackedLoad) {
                this.catalogLoads.delete(folderKey);
            }
        });
        this.catalogLoads.set(folderKey, trackedLoad);
        return trackedLoad;
    }

    private async resolveCatalog(
        folder: WorkspaceStepCatalogFolder | undefined,
        folderKey: string
    ): Promise<ResolvedStepCatalog> {
        const configuration = this.dependencies.getConfiguration(folder?.uri);
        const versionResolution = await this.resolveVersion(folder, configuration);
        const indexUrl = configuration.catalogIndexUrl.trim() || DEFAULT_CATALOG_INDEX_URL;
        const selectionKey = [
            versionResolution.fingerprint,
            indexUrl,
            configuration.externalUrl.trim()
        ].join('\0');
        const existing = this.states.get(folderKey);
        if (existing?.selectionKey === selectionKey) {
            return existing.catalog;
        }

        const generation = this.nextGeneration(folderKey);
        const requestedVersion = versionResolution.version;
        if (requestedVersion) {
            const exactKey = this.exactKey(indexUrl, requestedVersion);
            const reusable = this.exactCatalogs.get(exactKey);
            if (reusable) {
                const catalog = { ...reusable, requestedVersion };
                this.states.set(folderKey, { selectionKey, generation, catalog });
                return catalog;
            }

            const cached = await this.dependencies.getCachedExactCatalog(indexUrl, requestedVersion);
            if (cached && this.isCurrentGeneration(folderKey, generation)) {
                const catalog = resolveVersionedCatalog(cached, requestedVersion);
                this.exactCatalogs.set(exactKey, catalog);
                this.states.set(folderKey, { selectionKey, generation, catalog });
                return catalog;
            }
        }

        const fallback = await this.getBundledFallback(requestedVersion);
        if (!this.isCurrentGeneration(folderKey, generation)) {
            return this.states.get(folderKey)?.catalog ?? fallback;
        }
        this.states.set(folderKey, { selectionKey, generation, catalog: fallback });

        if (configuration.externalUrl.trim()) {
            this.startCustomFallbackLookup({
                folderKey,
                workspaceFolderUri: folder?.uri,
                selectionKey,
                generation,
                externalUrl: configuration.externalUrl,
                requestedVersion
            });
        }

        if (requestedVersion) {
            this.startExactLookup({
                folderKey,
                workspaceFolderUri: folder?.uri,
                selectionKey,
                generation,
                indexUrl,
                requestedVersion
            });
        }
        return fallback;
    }

    public async refresh(documentUri?: string): Promise<readonly ResolvedStepCatalog[]> {
        const selected = documentUri
            ? [this.dependencies.getWorkspaceFolder(documentUri)]
            : this.dependencies.getWorkspaceFolders();
        const folders = selected.length > 0 ? selected : [undefined];
        const refreshes = new Map<string, Promise<VersionedCatalogResult | null>>();

        return Promise.all(folders.map(async folder => {
            const folderKey = folder?.uri ?? '<no-workspace-folder>';
            const oldIdentity = this.states.get(folderKey)?.catalog.identity;
            const generation = this.nextGeneration(folderKey);
            this.catalogLoads.delete(folderKey);
            this.states.delete(folderKey);
            const configuration = this.dependencies.getConfiguration(folder?.uri);
            const resolution = await this.resolveVersion(folder, configuration, true);
            const indexUrl = configuration.catalogIndexUrl.trim() || DEFAULT_CATALOG_INDEX_URL;
            const selectionKey = [
                resolution.fingerprint,
                indexUrl,
                configuration.externalUrl.trim()
            ].join('\0');

            let catalog: ResolvedStepCatalog;
            if (resolution.version) {
                const exactKey = this.exactKey(indexUrl, resolution.version);
                let refreshPromise = refreshes.get(exactKey);
                if (!refreshPromise) {
                    refreshPromise = this.dependencies.refreshExactCatalog(indexUrl, resolution.version);
                    refreshes.set(exactKey, refreshPromise);
                }
                const result = await refreshPromise.catch(error => {
                    this.dependencies.warn('Failed to refresh the Vanessa step catalog.', error);
                    return null;
                });
                if (result) {
                    catalog = resolveVersionedCatalog(result, resolution.version);
                    this.exactCatalogs.set(exactKey, catalog);
                } else {
                    catalog = await this.getFallback(configuration.externalUrl, resolution.version);
                }
            } else {
                catalog = await this.getFallback(configuration.externalUrl);
            }

            if (this.isCurrentGeneration(folderKey, generation)) {
                this.states.set(folderKey, { selectionKey, generation, catalog });
                this.emitIfChanged(folder?.uri, oldIdentity, catalog.identity);
            }
            return catalog;
        }));
    }

    public invalidateConfiguration(workspaceFolderUri?: string): void {
        if (workspaceFolderUri) {
            this.invalidateFolder(workspaceFolderUri);
        } else {
            for (const folderKey of this.states.keys()) {
                this.invalidateFolder(folderKey);
            }
            for (const folderKey of this.generationByFolder.keys()) {
                this.nextGeneration(folderKey);
            }
            this.states.clear();
            this.catalogLoads.clear();
        }
        this.versionByFingerprint.clear();
        this.exactLookups.clear();
        this.customFallbacks.clear();
    }

    public async whenIdle(): Promise<void> {
        while (this.backgroundTasks.size > 0) {
            await Promise.allSettled([...this.backgroundTasks]);
        }
    }

    private invalidateFolder(folderKey: string): void {
        this.nextGeneration(folderKey);
        this.catalogLoads.delete(folderKey);
        this.states.delete(folderKey);
    }

    private nextGeneration(folderKey: string): number {
        const generation = (this.generationByFolder.get(folderKey) ?? 0) + 1;
        this.generationByFolder.set(folderKey, generation);
        return generation;
    }

    private isCurrentGeneration(folderKey: string, generation: number): boolean {
        return this.generationByFolder.get(folderKey) === generation;
    }

    private exactKey(indexUrl: string, version: string): string {
        return `${indexUrl}\0${version}`;
    }

    private async resolveVersion(
        folder: WorkspaceStepCatalogFolder | undefined,
        configuration: WorkspaceStepCatalogConfiguration,
        bypassCache = false
    ): Promise<VersionResolution> {
        const rawOverride = configuration.vanessaVersion.trim();
        if (rawOverride) {
            const version = normalizeVanessaVersion(rawOverride);
            if (!version) {
                this.dependencies.warn(
                    `Ignoring malformed Vanessa version override: ${rawOverride}`
                );
            }
            return {
                version: version ?? undefined,
                fingerprint: `override:${rawOverride}`
            };
        }
        if (!folder || !configuration.vanessaEpfPath.trim()) {
            return { fingerprint: `unknown:${folder?.uri ?? ''}` };
        }

        const epfPath = resolveWorkspaceSettingPath(
            configuration.vanessaEpfPath,
            folder.fsPath,
            this.dependencies.pathOperations
        );
        const changelogPath = getVanessaChangelogPath(epfPath, this.dependencies.pathOperations);
        const stat = await this.dependencies.statFile(changelogPath);
        if (!stat) {
            return { fingerprint: `missing:${folder.uri}:${epfPath}` };
        }
        const fingerprint = [
            folder.uri,
            epfPath,
            String(stat.mtime),
            String(stat.size)
        ].join('\0');
        if (!bypassCache && this.versionByFingerprint.has(fingerprint)) {
            return {
                version: this.versionByFingerprint.get(fingerprint) ?? undefined,
                fingerprint
            };
        }

        let version: string | null = null;
        try {
            version = extractVanessaVersionFromChangelog(
                await this.dependencies.readTextFile(changelogPath)
            );
        } catch (error) {
            this.dependencies.warn(`Failed to read Vanessa changelog: ${changelogPath}`, error);
        }
        this.versionByFingerprint.set(fingerprint, version);
        return { version: version ?? undefined, fingerprint };
    }

    private async getFallback(
        externalUrl: string,
        requestedVersion?: string
    ): Promise<ResolvedStepCatalog> {
        const normalizedExternalUrl = externalUrl.trim();
        if (normalizedExternalUrl) {
            const custom = await this.getCustomFallback(normalizedExternalUrl);
            if (custom) {
                return { ...custom, requestedVersion };
            }
        }

        return this.getBundledFallback(requestedVersion);
    }

    private getCustomFallback(externalUrl: string): Promise<ResolvedStepCatalog | null> {
        let customPromise = this.customFallbacks.get(externalUrl);
        if (!customPromise) {
            customPromise = this.dependencies.readCustomHtml(externalUrl)
                .then(html => resolveLegacyCatalog(html, 'custom-html'))
                .catch(error => {
                    this.dependencies.warn('Failed to load custom legacy steps HTML.', error);
                    return null;
                });
            this.customFallbacks.set(externalUrl, customPromise);
        }
        return customPromise;
    }

    private async getBundledFallback(requestedVersion?: string): Promise<ResolvedStepCatalog> {
        if (!this.bundledFallback) {
            this.bundledFallback = this.dependencies.readBundledHtml()
                .then(html => resolveLegacyCatalog(html, 'bundled-html'));
        }
        return { ...(await this.bundledFallback), requestedVersion };
    }

    private startCustomFallbackLookup(input: {
        readonly folderKey: string;
        readonly workspaceFolderUri?: string;
        readonly selectionKey: string;
        readonly generation: number;
        readonly externalUrl: string;
        readonly requestedVersion?: string;
    }): void {
        let task!: Promise<void>;
        task = this.getCustomFallback(input.externalUrl.trim()).then(result => {
            if (!result) {
                return;
            }
            const state = this.states.get(input.folderKey);
            if (
                !this.isCurrentGeneration(input.folderKey, input.generation)
                || state?.selectionKey !== input.selectionKey
                || state.catalog.source !== 'bundled-html'
            ) {
                return;
            }
            const catalog = { ...result, requestedVersion: input.requestedVersion };
            const oldIdentity = state.catalog.identity;
            state.catalog = catalog;
            this.emitIfChanged(input.workspaceFolderUri, oldIdentity, catalog.identity);
        }).finally(() => {
            this.backgroundTasks.delete(task);
        });
        this.backgroundTasks.add(task);
    }

    private startExactLookup(input: {
        readonly folderKey: string;
        readonly workspaceFolderUri?: string;
        readonly selectionKey: string;
        readonly generation: number;
        readonly indexUrl: string;
        readonly requestedVersion: string;
    }): void {
        const exactKey = this.exactKey(input.indexUrl, input.requestedVersion);
        let lookup = this.exactLookups.get(exactKey);
        if (!lookup) {
            lookup = this.dependencies.getExactCatalog(input.indexUrl, input.requestedVersion);
            this.exactLookups.set(exactKey, lookup);
        }

        let task!: Promise<void>;
        task = lookup.then(result => {
            if (!result) {
                return;
            }
            const catalog = resolveVersionedCatalog(result, input.requestedVersion);
            this.exactCatalogs.set(exactKey, catalog);
            const state = this.states.get(input.folderKey);
            if (
                !this.isCurrentGeneration(input.folderKey, input.generation)
                || state?.selectionKey !== input.selectionKey
            ) {
                return;
            }
            const oldIdentity = state.catalog.identity;
            state.catalog = catalog;
            this.emitIfChanged(input.workspaceFolderUri, oldIdentity, catalog.identity);
        }).catch(error => {
            this.dependencies.warn('Failed to load the exact Vanessa step catalog.', error);
        }).finally(() => {
            this.backgroundTasks.delete(task);
        });
        this.backgroundTasks.add(task);
    }

    private emitIfChanged(
        workspaceFolderUri: string | undefined,
        oldIdentity: string | undefined,
        newIdentity: string
    ): void {
        if (oldIdentity === newIdentity) {
            return;
        }
        const event = { workspaceFolderUri, oldIdentity, newIdentity };
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

export interface StepCatalogChangeEvent {
    readonly workspaceFolderUri?: vscode.Uri;
    readonly oldIdentity?: string;
    readonly newIdentity: string;
}

export interface StepCatalogProvider {
    getCatalog(documentUri?: vscode.Uri): Promise<ResolvedStepCatalog>;
    refresh(documentUri?: vscode.Uri): Promise<readonly ResolvedStepCatalog[]>;
    readonly onDidChangeCatalog: vscode.Event<StepCatalogChangeEvent>;
}

type VscodeApi = typeof import('vscode');

class VscodeStepCatalogStorage implements StepCatalogStorage {
    public constructor(
        private readonly vscodeApi: VscodeApi,
        private readonly storageRoot: vscode.Uri
    ) {}

    public async read(relativePath: string): Promise<Uint8Array | null> {
        try {
            return await this.vscodeApi.workspace.fs.readFile(this.resolve(relativePath));
        } catch {
            return null;
        }
    }

    public async writeAtomic(relativePath: string, bytes: Uint8Array): Promise<void> {
        const segments = relativePath.split('/');
        const fileName = segments.pop();
        if (!fileName) {
            throw new Error('Step catalog cache path must end with a file name.');
        }
        const directory = this.vscodeApi.Uri.joinPath(this.storageRoot, ...segments);
        const target = this.vscodeApi.Uri.joinPath(directory, fileName);
        const temporary = this.vscodeApi.Uri.joinPath(
            directory,
            `.${fileName}.${process.pid}.${Date.now()}.tmp`
        );
        await this.vscodeApi.workspace.fs.createDirectory(directory);
        try {
            await this.vscodeApi.workspace.fs.writeFile(temporary, bytes);
            await this.vscodeApi.workspace.fs.rename(temporary, target, { overwrite: true });
        } catch (error) {
            try {
                await this.vscodeApi.workspace.fs.delete(temporary);
            } catch {
                // The temporary file may not have been created.
            }
            throw error;
        }
    }

    private resolve(relativePath: string): vscode.Uri {
        return this.vscodeApi.Uri.joinPath(this.storageRoot, ...relativePath.split('/'));
    }
}

export class StepCatalogService implements StepCatalogProvider, vscode.Disposable {
    public readonly onDidChangeCatalog: vscode.Event<StepCatalogChangeEvent>;
    private readonly coordinator: WorkspaceStepCatalogCoordinator;
    private readonly emitter: vscode.EventEmitter<StepCatalogChangeEvent>;
    private readonly disposables: vscode.Disposable[] = [];

    public constructor(
        context: vscode.ExtensionContext,
        private readonly vscodeApi: VscodeApi
    ) {
        const storage = new VscodeStepCatalogStorage(vscodeApi, context.globalStorageUri);
        const client = new VersionedStepCatalogClient(storage, { get: fetchHttpsBytes });
        const decoder = new TextDecoder('utf-8', { fatal: true });

        this.emitter = new vscodeApi.EventEmitter<StepCatalogChangeEvent>();
        this.onDidChangeCatalog = this.emitter.event;
        this.coordinator = new WorkspaceStepCatalogCoordinator({
            pathOperations: path,
            getWorkspaceFolder: documentUri => {
                const document = documentUri
                    ? vscodeApi.Uri.parse(documentUri)
                    : vscodeApi.window.activeTextEditor?.document.uri;
                const folder = document
                    ? vscodeApi.workspace.getWorkspaceFolder(document)
                    : vscodeApi.workspace.workspaceFolders?.[0];
                return folder ? { uri: folder.uri.toString(), fsPath: folder.uri.fsPath } : undefined;
            },
            getWorkspaceFolders: () => (vscodeApi.workspace.workspaceFolders ?? []).map(folder => ({
                uri: folder.uri.toString(),
                fsPath: folder.uri.fsPath
            })),
            getConfiguration: workspaceFolderUri => {
                const scope = workspaceFolderUri
                    ? vscodeApi.Uri.parse(workspaceFolderUri)
                    : undefined;
                const configuration = vscodeApi.workspace.getConfiguration('kotTestToolkit', scope);
                return {
                    vanessaVersion: configuration.get<string>('steps.vanessaVersion', ''),
                    vanessaEpfPath: configuration.get<string>(
                        'runVanessa.vanessaEpfPath',
                        'tools/vanessa/vanessa-automation.epf'
                    ),
                    catalogIndexUrl: configuration.get<string>(
                        'steps.catalogIndexUrl',
                        DEFAULT_CATALOG_INDEX_URL
                    ),
                    externalUrl: configuration.get<string>('steps.externalUrl', '')
                };
            },
            statFile: async filePath => {
                try {
                    const stat = await vscodeApi.workspace.fs.stat(vscodeApi.Uri.file(filePath));
                    return { mtime: stat.mtime, size: stat.size };
                } catch {
                    return null;
                }
            },
            readTextFile: async filePath => decoder.decode(
                await vscodeApi.workspace.fs.readFile(vscodeApi.Uri.file(filePath))
            ),
            readBundledHtml: async () => decoder.decode(await vscodeApi.workspace.fs.readFile(
                vscodeApi.Uri.joinPath(context.extensionUri, 'res', 'steps.htm')
            )),
            readCustomHtml: async url => decoder.decode((await fetchHttpsBytes(new URL(url), {
                maxBytes: CUSTOM_HTML_MAX_BYTES
            })).body),
            getCachedExactCatalog: (indexUrl, version) =>
                client.getCachedExactCatalog(indexUrl, version),
            getExactCatalog: (indexUrl, version, signal) =>
                client.getExactCatalog(indexUrl, version, signal),
            refreshExactCatalog: (indexUrl, version, signal) =>
                client.refreshExactCatalog(indexUrl, version, signal),
            warn: (message, error) => console.warn(`[StepCatalogService] ${message}`, error ?? '')
        });

        this.disposables.push(this.coordinator.onDidChangeCatalog(event => {
            this.emitter.fire({
                workspaceFolderUri: event.workspaceFolderUri
                    ? vscodeApi.Uri.parse(event.workspaceFolderUri)
                    : undefined,
                oldIdentity: event.oldIdentity,
                newIdentity: event.newIdentity
            });
        }));
        this.disposables.push(vscodeApi.workspace.onDidChangeConfiguration(event => {
            if ([
                'kotTestToolkit.steps.vanessaVersion',
                'kotTestToolkit.steps.catalogIndexUrl',
                'kotTestToolkit.steps.externalUrl',
                'kotTestToolkit.runVanessa.vanessaEpfPath'
            ].some(section => event.affectsConfiguration(section))) {
                this.coordinator.invalidateConfiguration();
            }
        }));
        this.disposables.push(vscodeApi.workspace.onDidChangeWorkspaceFolders(() => {
            this.coordinator.invalidateConfiguration();
        }));
    }

    public getCatalog(documentUri?: vscode.Uri): Promise<ResolvedStepCatalog> {
        return this.coordinator.getCatalog(documentUri?.toString());
    }

    public refresh(documentUri?: vscode.Uri): Promise<readonly ResolvedStepCatalog[]> {
        return this.coordinator.refresh(documentUri?.toString());
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.emitter.dispose();
    }
}
