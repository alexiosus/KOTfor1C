import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    collectTreeWithConcurrencyLimit,
    ConcurrencyCancelledError,
    runWithConcurrencyLimit
} from './boundedConcurrency';
import { parseUserStepSource } from './bslStepSourceParser';
import { parseExportScenarios } from './exportScenarioParser';
import type {
    ProjectDefinitionFileRecord,
    ProjectDefinitionSnapshot,
    ProjectDefinitionWarning
} from './projectDefinition';
import { buildProjectDefinitionSnapshot } from './projectDefinitionIndex';

export interface ProjectDefinitionIndexConfiguration {
    readonly identity: string;
    readonly workspaceFolderPath: string;
    readonly workspaceFolderUri: string;
    readonly profileId: string;
    readonly libraryRootPaths: readonly string[];
    readonly warnings: readonly string[];
}

export interface ProjectDefinitionDirectoryEntry {
    readonly name: string;
    readonly type: 'file' | 'directory';
}

export interface ProjectDefinitionFileStat {
    readonly size: number;
    readonly mtimeMs: number;
}

export interface ProjectDefinitionFileSystem {
    readDirectory(directoryPath: string): Promise<readonly ProjectDefinitionDirectoryEntry[]>;
    stat(filePath: string): Promise<ProjectDefinitionFileStat>;
    readFile(filePath: string): Promise<string>;
    realpath(filePath: string): Promise<string>;
}

export interface ProjectDefinitionCacheStore {
    load(
        configurationIdentity: string,
        parserVersion: string
    ): Promise<readonly ProjectDefinitionFileRecord[] | null>;
    save(
        configurationIdentity: string,
        parserVersion: string,
        records: readonly ProjectDefinitionFileRecord[]
    ): Promise<void>;
}

export interface ProjectDefinitionWatcherCallbacks {
    readonly create: (filePath: string) => void;
    readonly change: (filePath: string) => void;
    readonly delete: (filePath: string) => void;
}

export interface DisposableLike {
    dispose(): void;
}

export interface CancellationTokenLike {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested?: (listener: () => void) => DisposableLike;
}

export interface ProjectDefinitionSnapshotChangeEvent {
    readonly previous: ProjectDefinitionSnapshot | null;
    readonly current: ProjectDefinitionSnapshot;
    readonly reason: 'cache' | 'scan' | 'watch';
}

export interface ProjectDefinitionIndexProvider {
    getSnapshot(resource?: { toString(): string } | string): ProjectDefinitionSnapshot | null;
    ensureReady(
        resource?: { toString(): string } | string,
        token?: CancellationTokenLike
    ): Promise<ProjectDefinitionSnapshot>;
    readonly onDidChangeSnapshot: (
        listener: (event: ProjectDefinitionSnapshotChangeEvent) => void
    ) => DisposableLike;
}

export interface ProjectDefinitionIndexServiceOptions {
    readonly parserVersion: string;
    readonly fileSystem: ProjectDefinitionFileSystem;
    readonly cache?: ProjectDefinitionCacheStore;
    readonly cacheFactory?: (configuration: ProjectDefinitionIndexConfiguration) => ProjectDefinitionCacheStore;
    readonly watch?: (
        rootPath: string,
        callbacks: ProjectDefinitionWatcherCallbacks
    ) => DisposableLike;
    readonly loadConfigurations?: () => Promise<readonly ProjectDefinitionIndexConfiguration[]>;
    readonly watchConfigurations?: (
        listener: () => void
    ) => DisposableLike | Promise<DisposableLike>;
    readonly directoryConcurrency?: number;
    readonly readConcurrency?: number;
    readonly yieldEvery?: number;
    readonly yieldControl?: () => Promise<void>;
    readonly log?: (message: string) => void;
}

interface CancellationFlag {
    cancelled: boolean;
}

interface DiscoveredSource {
    readonly filePath: string;
    readonly rootPath: string;
}

interface WatchedSource extends DiscoveredSource {
    readonly aliasPaths: readonly string[];
}

interface EnumerationResult {
    readonly sources: readonly DiscoveredSource[];
    readonly epfPaths: readonly string[];
    readonly warnings: readonly ProjectDefinitionWarning[];
}

interface FolderCoordinator {
    readonly configuration: ProjectDefinitionIndexConfiguration;
    readonly generation: number;
    readonly cancellation: CancellationFlag;
    readonly watchers: DisposableLike[];
    readonly cache: ProjectDefinitionCacheStore | undefined;
    snapshot: ProjectDefinitionSnapshot | null;
    job: Promise<void> | null;
    enumerationWarnings: readonly ProjectDefinitionWarning[];
    sourcePaths: Set<string>;
    epfPaths: Set<string>;
}

class SimpleEmitter<T> implements DisposableLike {
    readonly #listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void): DisposableLike => {
        this.#listeners.add(listener);
        return { dispose: () => this.#listeners.delete(listener) };
    };

    fire(event: T): void {
        for (const listener of [...this.#listeners]) {
            listener(event);
        }
    }

    dispose(): void {
        this.#listeners.clear();
    }
}

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

function normalizedPath(value: string): string {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function isSourcePath(value: string): boolean {
    const extension = path.extname(value).toLocaleLowerCase();
    return extension === '.feature' || extension === '.bsl';
}

function isEpfPath(value: string): boolean {
    return path.extname(value).toLocaleLowerCase() === '.epf'
        && normalizedPath(value).split(path.sep).some(part => part.toLocaleLowerCase() === 'step_definitions');
}

function warning(message: string, uri?: string): ProjectDefinitionWarning {
    return Object.freeze({ message, uri });
}

function fileUri(filePath: string): string {
    return pathToFileURL(path.resolve(filePath)).toString();
}

function routingUri(value: string): string {
    const isWindowsFileUri = /^file:\/\/\/[a-z](?::|%3a)\//iu.test(value);
    return process.platform === 'win32' || isWindowsFileUri
        ? value.toLocaleLowerCase()
        : value;
}

function routingPrefixLength(value: string, prefix: string): number {
    const comparableValue = routingUri(value);
    const comparablePrefix = routingUri(prefix);
    return comparableValue === comparablePrefix
        || comparableValue.startsWith(
            comparablePrefix.endsWith('/') ? comparablePrefix : `${comparablePrefix}/`
        )
        ? comparablePrefix.length
        : -1;
}

function physicalPathPrefixLength(value: string, prefix: string): number {
    const relative = path.relative(prefix, value);
    const matches = relative === ''
        || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    return matches ? normalizedPath(prefix).length : -1;
}

function sourceLabel(extension: string, rootPath: string): string {
    const rootName = path.basename(rootPath) || rootPath;
    return extension === '.feature'
        ? `Project exports (${rootName})`
        : `User steps (${rootName})`;
}

function sameFileIdentity(
    record: ProjectDefinitionFileRecord,
    uri: string,
    stat: ProjectDefinitionFileStat,
    parserVersion: string
): boolean {
    return record.uri === uri
        && record.size === stat.size
        && record.mtimeMs === stat.mtimeMs
        && record.parserVersion === parserVersion;
}

function relativePathWithin(rootPath: string, filePath: string): string | null {
    const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
    if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        return null;
    }
    return relative;
}

function sourceLibraryNames(sourcePaths: Iterable<string>): Set<string> {
    const names = new Set<string>();
    for (const sourcePath of sourcePaths) {
        const parts = normalizedPath(sourcePath).split(path.sep);
        const marker = parts.findIndex(part => part.toLocaleLowerCase() === 'step_definitions-src');
        if (marker >= 0 && parts[marker + 1]) {
            names.add(parts[marker + 1].toLocaleLowerCase());
        }
    }
    return names;
}

function binaryOnlyWarning(
    sourcePaths: Iterable<string>,
    epfPaths: Iterable<string>
): ProjectDefinitionWarning | null {
    const sourceNames = sourceLibraryNames(sourcePaths);
    const binaryNames = new Set<string>();
    for (const epfPath of epfPaths) {
        binaryNames.add(path.basename(epfPath, path.extname(epfPath)).toLocaleLowerCase());
    }
    const binaryOnlyCount = [...binaryNames].filter(name => !sourceNames.has(name)).length;
    return binaryOnlyCount > 0
        ? warning(
            `${binaryOnlyCount} binary-only EPF user-step ${binaryOnlyCount === 1 ? 'library was' : 'libraries were'} not indexed. Add source under step_definitions-src to enable project definitions.`
        )
        : null;
}

export class ProjectDefinitionIndexService implements ProjectDefinitionIndexProvider, DisposableLike {
    readonly #options: ProjectDefinitionIndexServiceOptions;
    readonly #coordinators = new Map<string, FolderCoordinator>();
    readonly #jobs = new Set<Promise<unknown>>();
    readonly #emitter = new SimpleEmitter<ProjectDefinitionSnapshotChangeEvent>();
    #generation = 0;
    #configurationLoadGeneration = 0;
    #configurationWatchStarted = false;
    #configurationSubscription: DisposableLike | null = null;
    #disposed = false;

    readonly onDidChangeSnapshot = this.#emitter.event;

    constructor(options: ProjectDefinitionIndexServiceOptions) {
        this.#options = options;
    }

    start(): void {
        if (
            this.#disposed
            || this.#configurationWatchStarted
            || !this.#options.loadConfigurations
        ) {
            return;
        }
        this.#configurationWatchStarted = true;
        if (this.#options.watchConfigurations) {
            this.#track((async () => {
                try {
                    const subscription = await this.#options.watchConfigurations?.(() => {
                        void this.reloadConfigurations();
                    });
                    if (subscription) {
                        if (this.#disposed) {
                            subscription.dispose();
                            return;
                        }
                        this.#configurationSubscription = subscription;
                    }
                } finally {
                    if (!this.#disposed) {
                        await this.reloadConfigurations();
                    }
                }
            })());
            return;
        }
        void this.reloadConfigurations();
    }

    reloadConfigurations(): Promise<void> {
        if (this.#disposed || !this.#options.loadConfigurations) {
            return Promise.resolve();
        }
        const generation = ++this.#configurationLoadGeneration;
        return this.#track((async () => {
            const configurations = await this.#options.loadConfigurations?.() ?? [];
            if (!this.#disposed && generation === this.#configurationLoadGeneration) {
                this.setProfiles(configurations);
            }
        })());
    }

    setProfiles(configurations: readonly ProjectDefinitionIndexConfiguration[]): void {
        const incoming = new Set(configurations.map(item => item.workspaceFolderUri));
        for (const [key, coordinator] of this.#coordinators) {
            if (!incoming.has(key)) {
                this.#cancelCoordinator(coordinator);
                this.#coordinators.delete(key);
            }
        }
        for (const configuration of configurations) {
            this.startProfile(configuration);
        }
    }

    startProfile(configuration: ProjectDefinitionIndexConfiguration): void {
        if (this.#disposed) {
            return;
        }
        const previous = this.#coordinators.get(configuration.workspaceFolderUri);
        if (previous) {
            this.#cancelCoordinator(previous);
        }
        const coordinator: FolderCoordinator = {
            configuration,
            generation: ++this.#generation,
            cancellation: { cancelled: false },
            watchers: [],
            cache: this.#options.cacheFactory?.(configuration) ?? this.#options.cache,
            snapshot: null,
            job: null,
            enumerationWarnings: [],
            sourcePaths: new Set(),
            epfPaths: new Set()
        };
        this.#coordinators.set(configuration.workspaceFolderUri, coordinator);
        this.#createWatchers(coordinator);
        coordinator.job = this.#track(this.#scan(coordinator));
    }

    getSnapshot(resource?: { toString(): string } | string): ProjectDefinitionSnapshot | null {
        return this.#coordinatorFor(resource)?.snapshot ?? null;
    }

    async ensureReady(
        resource?: { toString(): string } | string,
        token?: CancellationTokenLike
    ): Promise<ProjectDefinitionSnapshot> {
        this.#throwIfCancellationRequested(token);
        let coordinator = this.#coordinatorFor(resource);
        if (!coordinator && resource) {
            const value = typeof resource === 'string' ? resource : resource.toString();
            coordinator = await this.#awaitCancellation(
                this.#coordinatorForPhysicalResource(value, token),
                token
            );
        }
        if (!coordinator) {
            throw new Error('No project definition configuration is available for this resource.');
        }
        this.#throwIfCancellationRequested(token);
        if (coordinator.job) {
            await this.#awaitCancellation(coordinator.job, token);
        }
        const current = this.#coordinators.get(coordinator.configuration.workspaceFolderUri);
        if (!current?.snapshot) {
            throw new Error('Project definition indexing did not produce a snapshot.');
        }
        return current.snapshot;
    }

    async waitForIdle(): Promise<void> {
        while (this.#jobs.size > 0) {
            await Promise.allSettled([...this.#jobs]);
        }
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#configurationLoadGeneration += 1;
        this.#configurationSubscription?.dispose();
        this.#configurationSubscription = null;
        for (const coordinator of this.#coordinators.values()) {
            this.#cancelCoordinator(coordinator);
        }
        this.#coordinators.clear();
        this.#emitter.dispose();
    }

    #track<T>(promise: Promise<T>): Promise<T> {
        const tracked = promise.finally(() => this.#jobs.delete(tracked));
        this.#jobs.add(tracked);
        void tracked.catch(error => {
            if (!(error instanceof ConcurrencyCancelledError)) {
                this.#options.log?.(`Project definition background task failed: ${String(error)}`);
            }
        });
        return tracked;
    }

    #coordinatorFor(resource?: { toString(): string } | string): FolderCoordinator | undefined {
        if (!resource) {
            return this.#coordinators.values().next().value;
        }
        const value = typeof resource === 'string' ? resource : resource.toString();
        const findBestMatch = (
            prefixesFor: (item: FolderCoordinator) => readonly string[]
        ): FolderCoordinator | undefined => [...this.#coordinators.values()]
            .map(item => {
                const prefixes = prefixesFor(item);
                const matchLength = prefixes.reduce((longest, prefix) => {
                    return Math.max(longest, routingPrefixLength(value, prefix));
                }, -1);
                return { item, matchLength };
            })
            .filter(candidate => candidate.matchLength >= 0)
            .sort((left, right) => right.matchLength - left.matchLength)[0]?.item;

        return findBestMatch(item => [item.configuration.workspaceFolderUri])
            ?? findBestMatch(item => item.configuration.libraryRootPaths.map(fileUri));
    }

    async #coordinatorForPhysicalResource(
        resourceUri: string,
        token?: CancellationTokenLike
    ): Promise<FolderCoordinator | undefined> {
        let resourcePath: string;
        try {
            this.#throwIfCancellationRequested(token);
            resourcePath = await this.#options.fileSystem.realpath(fileURLToPath(resourceUri));
            this.#throwIfCancellationRequested(token);
        } catch {
            this.#throwIfCancellationRequested(token);
            return undefined;
        }

        const findBestMatch = async (
            pathsFor: (item: FolderCoordinator) => readonly string[]
        ): Promise<FolderCoordinator | undefined> => {
            const candidates: Array<{ item: FolderCoordinator; matchLength: number }> = [];
            for (const item of this.#coordinators.values()) {
                this.#throwIfCancellationRequested(token);
                let matchLength = -1;
                for (const candidatePath of pathsFor(item)) {
                    try {
                        this.#throwIfCancellationRequested(token);
                        const physicalPath = await this.#options.fileSystem.realpath(candidatePath);
                        this.#throwIfCancellationRequested(token);
                        matchLength = Math.max(
                            matchLength,
                            physicalPathPrefixLength(resourcePath, physicalPath)
                        );
                    } catch {
                        this.#throwIfCancellationRequested(token);
                        // An unavailable root cannot own the requested resource.
                    }
                }
                if (matchLength >= 0) {
                    candidates.push({ item, matchLength });
                }
            }
            return candidates.sort((left, right) => right.matchLength - left.matchLength)[0]?.item;
        };

        return await findBestMatch(item => [item.configuration.workspaceFolderPath])
            ?? await findBestMatch(item => item.configuration.libraryRootPaths);
    }

    #throwIfCancellationRequested(token?: CancellationTokenLike): void {
        if (token?.isCancellationRequested) {
            throw new ConcurrencyCancelledError();
        }
    }

    #cacheRecords(snapshot: ProjectDefinitionSnapshot | null): readonly ProjectDefinitionFileRecord[] {
        return snapshot ? [...snapshot.files.values()] : [];
    }

    #isCurrent(coordinator: FolderCoordinator): boolean {
        return !this.#disposed
            && !coordinator.cancellation.cancelled
            && this.#coordinators.get(coordinator.configuration.workspaceFolderUri) === coordinator;
    }

    #publish(
        coordinator: FolderCoordinator,
        snapshot: ProjectDefinitionSnapshot,
        reason: ProjectDefinitionSnapshotChangeEvent['reason']
    ): void {
        if (!this.#isCurrent(coordinator)) {
            return;
        }
        const previous = coordinator.snapshot;
        coordinator.snapshot = snapshot;
        if (previous?.identity !== snapshot.identity || previous.generation !== snapshot.generation) {
            this.#emitter.fire({ previous, current: snapshot, reason });
        }
    }

    #cancelCoordinator(coordinator: FolderCoordinator): void {
        coordinator.cancellation.cancelled = true;
        for (const watcher of coordinator.watchers.splice(0)) {
            watcher.dispose();
        }
    }

    #createWatchers(coordinator: FolderCoordinator): void {
        if (!this.#options.watch) {
            return;
        }
        for (const root of coordinator.configuration.libraryRootPaths) {
            const watcher = this.#options.watch(root, {
                create: filePath => this.#watchFile(coordinator, 'create', filePath),
                change: filePath => this.#watchFile(coordinator, 'change', filePath),
                delete: filePath => this.#watchFile(coordinator, 'delete', filePath)
            });
            coordinator.watchers.push(watcher);
        }
    }

    #watchFile(
        coordinator: FolderCoordinator,
        change: 'create' | 'change' | 'delete',
        filePath: string
    ): void {
        if (!this.#isCurrent(coordinator)) {
            return;
        }
        if (isEpfPath(filePath)) {
            if (change === 'delete') {
                coordinator.epfPaths.delete(normalizedPath(filePath));
            } else {
                coordinator.epfPaths.add(normalizedPath(filePath));
            }
            this.#publishInventoryOnly(coordinator);
            return;
        }
        if (!isSourcePath(filePath)) {
            return;
        }
        const previousJob = coordinator.job;
        const job = (async () => {
            if (previousJob) {
                await previousJob.catch(() => undefined);
            }
            if (!this.#isCurrent(coordinator)) {
                return;
            }
            if (change === 'delete') {
                await this.#removeWatchedFile(coordinator, filePath);
            } else {
                await this.#updateWatchedFile(coordinator, filePath);
            }
        })();
        coordinator.job = this.#track(job);
    }

    async #scan(coordinator: FolderCoordinator): Promise<void> {
        try {
            const cachedRecords = await coordinator.cache?.load(
                coordinator.configuration.identity,
                this.#options.parserVersion
            ) ?? [];
            if (!this.#isCurrent(coordinator)) {
                return;
            }
            if (cachedRecords.length > 0) {
                this.#publish(coordinator, this.#buildSnapshot(coordinator, cachedRecords, []), 'cache');
            }

            const enumeration = await this.#enumerate(coordinator);
            if (!this.#isCurrent(coordinator)) {
                return;
            }
            coordinator.enumerationWarnings = enumeration.warnings;
            coordinator.sourcePaths = new Set(enumeration.sources.map(item => normalizedPath(item.filePath)));
            coordinator.epfPaths = new Set(enumeration.epfPaths.map(normalizedPath));
            const cachedByUri = new Map(cachedRecords.map(record => [record.uri, record]));
            const records = await runWithConcurrencyLimit(
                enumeration.sources,
                this.#options.readConcurrency ?? 8,
                source => this.#readSourceRecord(coordinator, source, cachedByUri),
                {
                    shouldCancel: () => !this.#isCurrent(coordinator),
                    yieldEvery: this.#options.yieldEvery ?? 32,
                    yieldControl: this.#options.yieldControl
                }
            );
            if (!this.#isCurrent(coordinator)) {
                return;
            }
            const snapshot = this.#buildSnapshot(coordinator, records, enumeration.warnings);
            this.#publish(coordinator, snapshot, 'scan');
            await coordinator.cache?.save(
                coordinator.configuration.identity,
                this.#options.parserVersion,
                records
            );
        } catch (error) {
            if (!(error instanceof ConcurrencyCancelledError) && this.#isCurrent(coordinator)) {
                this.#options.log?.(`Project definition scan failed: ${String(error)}`);
                const fallback = this.#buildSnapshot(
                    coordinator,
                    this.#cacheRecords(coordinator.snapshot),
                    [warning(`Project definition scan failed: ${String(error)}`)]
                );
                this.#publish(coordinator, fallback, 'scan');
            }
        }
    }

    async #enumerate(coordinator: FolderCoordinator): Promise<EnumerationResult> {
        const sources: DiscoveredSource[] = [];
        const epfPaths: string[] = [];
        const warnings: ProjectDefinitionWarning[] = [];
        const seenRoots = new Set<string>();
        const seenSources = new Set<string>();
        const seenEpfs = new Set<string>();

        for (const configuredRoot of coordinator.configuration.libraryRootPaths) {
            if (!this.#isCurrent(coordinator)) {
                throw new ConcurrencyCancelledError();
            }
            let root: string;
            try {
                root = await this.#options.fileSystem.realpath(configuredRoot);
            } catch (error) {
                warnings.push(warning(`Cannot resolve project library root ${configuredRoot}: ${String(error)}`));
                continue;
            }
            const rootKey = normalizedPath(root);
            if (seenRoots.has(rootKey)) {
                continue;
            }
            seenRoots.add(rootKey);
            const found = await collectTreeWithConcurrencyLimit(
                root,
                this.#options.directoryConcurrency ?? 8,
                async directory => {
                    try {
                        const entries = await this.#options.fileSystem.readDirectory(directory);
                        const children: string[] = [];
                        const values: string[] = [];
                        for (const entry of entries) {
                            if (entry.type === 'directory') {
                                if (!IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase())) {
                                    children.push(path.join(directory, entry.name));
                                }
                            } else {
                                const filePath = path.join(directory, entry.name);
                                if (isSourcePath(filePath) || isEpfPath(filePath)) {
                                    values.push(filePath);
                                }
                            }
                        }
                        return { children, values };
                    } catch (error) {
                        warnings.push(warning(`Cannot read project library directory ${directory}: ${String(error)}`));
                        return { children: [], values: [] };
                    }
                },
                () => !this.#isCurrent(coordinator)
            );
            for (const discoveredPath of found) {
                let physicalPath = discoveredPath;
                try {
                    physicalPath = await this.#options.fileSystem.realpath(discoveredPath);
                } catch {
                    // A later stat/read produces a file-scoped warning.
                }
                const key = normalizedPath(physicalPath);
                if (isSourcePath(physicalPath) && !seenSources.has(key)) {
                    seenSources.add(key);
                    sources.push({ filePath: physicalPath, rootPath: root });
                } else if (isEpfPath(physicalPath) && !seenEpfs.has(key)) {
                    seenEpfs.add(key);
                    epfPaths.push(physicalPath);
                }
            }
        }

        sources.sort((left, right) => normalizedPath(left.filePath).localeCompare(normalizedPath(right.filePath)));
        epfPaths.sort((left, right) => normalizedPath(left).localeCompare(normalizedPath(right)));
        return { sources, epfPaths, warnings };
    }

    async #readSourceRecord(
        coordinator: FolderCoordinator,
        source: DiscoveredSource,
        cachedByUri: ReadonlyMap<string, ProjectDefinitionFileRecord>
    ): Promise<ProjectDefinitionFileRecord> {
        const uri = fileUri(source.filePath);
        let stat: ProjectDefinitionFileStat;
        try {
            stat = await this.#options.fileSystem.stat(source.filePath);
        } catch (error) {
            return this.#errorRecord(uri, `Cannot stat project definition source: ${String(error)}`);
        }
        const cached = cachedByUri.get(uri);
        if (cached && sameFileIdentity(cached, uri, stat, this.#options.parserVersion)) {
            return cached;
        }
        try {
            const content = await this.#options.fileSystem.readFile(source.filePath);
            const extension = path.extname(source.filePath).toLocaleLowerCase();
            const commonContext = {
                sourceUri: uri,
                workspaceFolderUri: coordinator.configuration.workspaceFolderUri,
                profileId: coordinator.configuration.profileId,
                libraryRootUri: fileUri(source.rootPath),
                sourceLabel: sourceLabel(extension, source.rootPath)
            };
            const parsed = extension === '.feature'
                ? parseExportScenarios(content, { ...commonContext, defaultLanguage: 'en' })
                : parseUserStepSource(content, commonContext);
            return Object.freeze({
                uri,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                parserVersion: this.#options.parserVersion,
                definitions: parsed.definitions,
                warnings: parsed.warnings
            });
        } catch (error) {
            return Object.freeze({
                ...this.#errorRecord(uri, `Cannot read or parse project definition source: ${String(error)}`),
                size: stat.size,
                mtimeMs: stat.mtimeMs
            });
        }
    }

    #errorRecord(uri: string, message: string): ProjectDefinitionFileRecord {
        return Object.freeze({
            uri,
            size: 0,
            mtimeMs: 0,
            parserVersion: this.#options.parserVersion,
            definitions: Object.freeze([]),
            warnings: Object.freeze([warning(message, uri)])
        });
    }

    #snapshotWarnings(
        coordinator: FolderCoordinator,
        enumerationWarnings: readonly ProjectDefinitionWarning[]
    ): readonly ProjectDefinitionWarning[] {
        const result: ProjectDefinitionWarning[] = [
            ...coordinator.configuration.warnings.map(message => warning(message)),
            ...enumerationWarnings
        ];
        const binary = binaryOnlyWarning(coordinator.sourcePaths, coordinator.epfPaths);
        if (binary) {
            result.push(binary);
        }
        return result;
    }

    #buildSnapshot(
        coordinator: FolderCoordinator,
        records: readonly ProjectDefinitionFileRecord[],
        enumerationWarnings: readonly ProjectDefinitionWarning[]
    ): ProjectDefinitionSnapshot {
        return buildProjectDefinitionSnapshot({
            configurationIdentity: coordinator.configuration.identity,
            workspaceFolderUri: coordinator.configuration.workspaceFolderUri,
            profileId: coordinator.configuration.profileId,
            generation: coordinator.snapshot?.generation ?? coordinator.generation,
            parserVersion: this.#options.parserVersion,
            files: records,
            warnings: this.#snapshotWarnings(coordinator, enumerationWarnings)
        });
    }

    async #updateWatchedFile(coordinator: FolderCoordinator, filePath: string): Promise<void> {
        if (!this.#isCurrent(coordinator) || !coordinator.snapshot) {
            return;
        }
        const source = await this.#resolveWatchedSource(coordinator, filePath);
        if (!source) {
            return;
        }
        const record = await this.#readSourceRecord(
            coordinator,
            source,
            new Map()
        );
        if (!this.#isCurrent(coordinator) || !coordinator.snapshot) {
            return;
        }
        for (const aliasPath of source.aliasPaths) {
            coordinator.sourcePaths.delete(normalizedPath(aliasPath));
        }
        coordinator.sourcePaths.add(normalizedPath(source.filePath));
        const records = new Map([...coordinator.snapshot.files.values()].map(item => [item.uri, item]));
        for (const aliasPath of source.aliasPaths) {
            records.delete(fileUri(aliasPath));
        }
        records.set(record.uri, record);
        const snapshot = buildProjectDefinitionSnapshot({
            configurationIdentity: coordinator.configuration.identity,
            workspaceFolderUri: coordinator.configuration.workspaceFolderUri,
            profileId: coordinator.configuration.profileId,
            generation: coordinator.snapshot.generation + 1,
            parserVersion: this.#options.parserVersion,
            files: [...records.values()],
            warnings: this.#snapshotWarnings(coordinator, coordinator.enumerationWarnings)
        });
        this.#publish(coordinator, snapshot, 'watch');
        await coordinator.cache?.save(
            coordinator.configuration.identity,
            this.#options.parserVersion,
            [...snapshot.files.values()]
        );
    }

    async #removeWatchedFile(coordinator: FolderCoordinator, filePath: string): Promise<void> {
        if (!this.#isCurrent(coordinator) || !coordinator.snapshot) {
            return;
        }
        const source = await this.#resolveWatchedSource(coordinator, filePath);
        if (!source) {
            return;
        }
        const deletedUris = new Set(source.aliasPaths.map(fileUri));
        for (const aliasPath of source.aliasPaths) {
            coordinator.sourcePaths.delete(normalizedPath(aliasPath));
        }
        const records = [...coordinator.snapshot.files.values()].filter(record => !deletedUris.has(record.uri));
        const snapshot = buildProjectDefinitionSnapshot({
            configurationIdentity: coordinator.configuration.identity,
            workspaceFolderUri: coordinator.configuration.workspaceFolderUri,
            profileId: coordinator.configuration.profileId,
            generation: coordinator.snapshot.generation + 1,
            parserVersion: this.#options.parserVersion,
            files: records,
            warnings: this.#snapshotWarnings(coordinator, coordinator.enumerationWarnings)
        });
        this.#publish(coordinator, snapshot, 'watch');
        await coordinator.cache?.save(
            coordinator.configuration.identity,
            this.#options.parserVersion,
            records
        );
    }

    async #resolveWatchedSource(
        coordinator: FolderCoordinator,
        filePath: string
    ): Promise<WatchedSource | null> {
        const eventPath = path.resolve(filePath);
        let physicalFilePath = eventPath;
        try {
            physicalFilePath = await this.#options.fileSystem.realpath(eventPath);
        } catch {
            // Deleted files are resolved below from the still-existing library root.
        }

        for (const configuredRoot of coordinator.configuration.libraryRootPaths) {
            const configuredRootPath = path.resolve(configuredRoot);
            let physicalRootPath = configuredRootPath;
            try {
                physicalRootPath = await this.#options.fileSystem.realpath(configuredRootPath);
            } catch {
                // The configured spelling remains usable when the root cannot be canonicalized.
            }

            const relativePath = relativePathWithin(configuredRootPath, eventPath)
                ?? relativePathWithin(physicalRootPath, physicalFilePath)
                ?? relativePathWithin(physicalRootPath, eventPath)
                ?? relativePathWithin(configuredRootPath, physicalFilePath);
            if (relativePath === null) {
                continue;
            }

            const derivedPhysicalPath = path.resolve(physicalRootPath, relativePath);
            const resolvedFilePath = relativePathWithin(physicalRootPath, physicalFilePath) !== null
                ? physicalFilePath
                : derivedPhysicalPath;
            return {
                filePath: resolvedFilePath,
                rootPath: physicalRootPath,
                aliasPaths: Object.freeze(Array.from(new Set([
                    eventPath,
                    physicalFilePath,
                    path.resolve(configuredRootPath, relativePath),
                    derivedPhysicalPath
                ])))
            };
        }
        return null;
    }

    #publishInventoryOnly(coordinator: FolderCoordinator): void {
        if (!coordinator.snapshot) {
            return;
        }
        const snapshot = buildProjectDefinitionSnapshot({
            configurationIdentity: coordinator.configuration.identity,
            workspaceFolderUri: coordinator.configuration.workspaceFolderUri,
            profileId: coordinator.configuration.profileId,
            generation: coordinator.snapshot.generation + 1,
            parserVersion: this.#options.parserVersion,
            files: [...coordinator.snapshot.files.values()],
            warnings: this.#snapshotWarnings(coordinator, coordinator.enumerationWarnings)
        });
        this.#publish(coordinator, snapshot, 'watch');
    }

    async #awaitCancellation<T>(promise: Promise<T>, token?: CancellationTokenLike): Promise<T> {
        if (!token?.onCancellationRequested) {
            return promise;
        }
        return new Promise<T>((resolve, reject) => {
            const subscription = token.onCancellationRequested?.(() => {
                subscription?.dispose();
                reject(new ConcurrencyCancelledError());
            });
            promise.then(
                value => {
                    subscription?.dispose();
                    resolve(value);
                },
                error => {
                    subscription?.dispose();
                    reject(error);
                }
            );
        });
    }
}
