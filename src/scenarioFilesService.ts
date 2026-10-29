import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScenarioFileManifestEntry, ScenarioFileNode } from './scenarioFilesModel';
import {
    normalizeScenarioFileRelativePath,
    scenarioFileNodeId,
    scenarioFilesAvailable
} from './scenarioFilesModel';
import type { StepLibraryItem } from './stepLibraryModel';

export interface ScenarioFilesDisposable {
    dispose(): void;
}

export interface ScenarioFilesUri {
    toString(): string;
}

export interface ScenarioFilesDirectoryEntry {
    readonly name: string;
    readonly kind: 'directory' | 'file' | 'symbolicLink';
}

export interface ScenarioFilesWatcher extends ScenarioFilesDisposable {
    readonly onDidCreate: (
        listener: (uri: ScenarioFilesUri) => void
    ) => ScenarioFilesDisposable;
    readonly onDidChange: (
        listener: (uri: ScenarioFilesUri) => void
    ) => ScenarioFilesDisposable;
    readonly onDidDelete: (
        listener: (uri: ScenarioFilesUri) => void
    ) => ScenarioFilesDisposable;
}

export interface ScenarioFilesHost {
    readonly parseUri: (value: string) => ScenarioFilesUri;
    readonly dirname: (uri: ScenarioFilesUri) => ScenarioFilesUri;
    readonly joinPath: (
        base: ScenarioFilesUri,
        ...segments: readonly string[]
    ) => ScenarioFilesUri;
    readonly readDirectory: (
        uri: ScenarioFilesUri
    ) => PromiseLike<readonly ScenarioFilesDirectoryEntry[]>;
    readonly isFileNotFound: (error: unknown) => boolean;
    readonly openExternal: (uri: ScenarioFilesUri) => PromiseLike<boolean>;
    readonly openInEditor: (uri: ScenarioFilesUri) => PromiseLike<boolean>;
    readonly revealInOs: (uri: ScenarioFilesUri) => PromiseLike<void>;
    readonly confirmDelete: (relativePath: string) => PromiseLike<boolean>;
    readonly deleteFile: (uri: ScenarioFilesUri) => PromiseLike<void>;
    readonly promptRename?: (name: string) => PromiseLike<string | undefined>;
    readonly renameFile?: (from: ScenarioFilesUri, to: ScenarioFilesUri) => PromiseLike<void>;
    readonly createWatcher: (root: ScenarioFilesUri) => ScenarioFilesWatcher;
    readonly chooseConflict: (
        relativePath: string
    ) => PromiseLike<ScenarioFileConflictDecision>;
}

export interface ScenarioFileDeleteOptions {
    readonly recursive: false;
    readonly useTrash: boolean;
}

export async function deleteFileWithTrashFallback<T>(
    uri: T,
    deleteFile: (uri: T, options: ScenarioFileDeleteOptions) => PromiseLike<void>
): Promise<void> {
    try {
        await deleteFile(uri, { recursive: false, useTrash: true });
    } catch {
        // VS Code cannot move files to the OS trash on some shared/remote filesystems.
        // The caller has already shown a modal delete confirmation, so fall back to
        // direct removal instead of leaving the confirmed action non-functional.
        await deleteFile(uri, { recursive: false, useTrash: false });
    }
}

export interface ScenarioFilesInvalidation {
    readonly itemId: string;
    readonly rootUri: string;
    readonly changedUris: readonly string[];
}

export type ScenarioFileConflictDecision = 'replace' | 'copy' | 'skip';

export interface ScenarioFileDropPlanEntry {
    readonly clientPath: string;
    readonly destinationRelativePath: string;
    readonly transferId: string;
}

export interface ScenarioFileDropPlan {
    readonly files: readonly ScenarioFileDropPlanEntry[];
    readonly skipped: readonly string[];
}

class SimpleEmitter<T> implements ScenarioFilesDisposable {
    private readonly listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void): ScenarioFilesDisposable => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}

interface WatchSubscriber {
    readonly id: number;
    readonly itemId: string;
    readonly listener: (event: ScenarioFilesInvalidation) => void;
}

interface SharedWatch {
    readonly rootUri: string;
    readonly watcher: ScenarioFilesWatcher;
    readonly subscriptions: readonly ScenarioFilesDisposable[];
    readonly subscribers: Map<number, WatchSubscriber>;
    readonly changedUris: Set<string>;
    timer: ReturnType<typeof setTimeout> | undefined;
}

interface TransferState {
    readonly id: string;
    readonly clientPath: string;
    readonly destinationRelativePath: string;
    readonly destinationPath: string;
    readonly temporaryPath: string;
    readonly expectedSize: number;
    readonly replace: boolean;
    handle: FileHandle | undefined;
    offset: number;
    closed: boolean;
}

interface ValidatedManifestEntry {
    readonly clientPath: string;
    readonly destinationRelativePath: string;
    readonly kind: 'directory' | 'file';
    readonly size?: number;
}

interface ResourceRoot {
    readonly uri: ScenarioFilesUri;
    readonly compiledFeatureUri?: string;
}

const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_BASE64_CHARACTERS = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const OPERATING_SYSTEM_METADATA_NAMES = new Set(['.ds_store', 'thumbs.db']);

function compareName(left: string, right: string): number {
    const folded = left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase());
    return folded || left.localeCompare(right);
}

export class ScenarioFilesService implements ScenarioFilesDisposable {
    private readonly invalidationEmitter = new SimpleEmitter<ScenarioFilesInvalidation>();
    private readonly watches = new Map<string, SharedWatch>();
    private readonly transfers = new Map<string, TransferState>();
    private readonly attachmentPathLoads = new Map<string, Promise<readonly string[]>>();
    private readonly attachmentIndexWatches = new Map<string, ScenarioFilesDisposable>();
    private nextSubscriberId = 1;
    private disposed = false;

    readonly onDidInvalidate = this.invalidationEmitter.event;

    constructor(private readonly host: ScenarioFilesHost) {}

    async listChildren(
        item: StepLibraryItem,
        relativeDirectory: string
    ): Promise<readonly ScenarioFileNode[]> {
        const normalizedDirectory = this.requireRelativePath(relativeDirectory);
        const children = await Promise.all((await this.resourceRoots(item)).map(root =>
            this.listChildrenFromRoot(root.uri, normalizedDirectory, item.id, root.compiledFeatureUri)));
        const merged = new Map<string, ScenarioFileNode>();
        for (const node of children.flat()) {
            if (!merged.has(node.name)) { merged.set(node.name, node); }
        }
        return Object.freeze([...merged.values()].sort((left, right) =>
            (left.kind === right.kind ? 0 : left.kind === 'directory' ? -1 : 1) || compareName(left.name, right.name)));
    }

    async listAttachmentPaths(item: StepLibraryItem): Promise<readonly string[]> {
        if (this.disposed) {
            return Object.freeze([]);
        }
        const roots = new Map<string, ResourceRoot>();
        if (item.kind === 'nestedScenario' || item.kind === 'mainScenario' || item.kind === 'process') {
            if (/^file:/iu.test(item.capturedLocation?.uri ?? '')) {
                const definition = this.host.parseUri(item.capturedLocation!.uri);
                const root = this.host.joinPath(this.host.dirname(definition), 'files');
                roots.set(root.toString(), { uri: root });
            }
            if ((item.kind === 'mainScenario' || item.kind === 'process') && scenarioFilesAvailable(item)) {
                for (const root of await this.resourceRoots(item)) { roots.set(this.rootCacheKey(root), root); }
            }
        }
        const paths = await Promise.all([...roots.values()].map(root => this.attachmentPathsForRoot(root, item.id)));
        return Object.freeze([...new Set(paths.flat())].sort(compareName));
    }

    private attachmentPathsForRoot(root: ResourceRoot, itemId: string): Promise<readonly string[]> {
        const key = this.rootCacheKey(root);
        const current = this.attachmentPathLoads.get(key);
        if (current) {
            return current;
        }
        if (!this.attachmentIndexWatches.has(key)) {
            this.attachmentIndexWatches.set(key, this.watchRoot(root.uri, itemId, () => undefined));
        }
        const load = this.collectAttachmentPaths(root, itemId).catch(error => {
            if (this.attachmentPathLoads.get(key) === load) {
                this.attachmentPathLoads.delete(key);
            }
            throw error;
        });
        this.attachmentPathLoads.set(key, load);
        return load;
    }

    private async collectAttachmentPaths(root: ResourceRoot, itemId: string): Promise<readonly string[]> {
        const directories = [''];
        const paths: string[] = [];
        while (directories.length > 0) {
            const children = await this.listChildrenFromRoot(root.uri, directories.pop()!, itemId, root.compiledFeatureUri);
            for (const child of children) {
                if (child.kind === 'directory') {
                    directories.push(child.relativePath);
                } else {
                    paths.push(child.relativePath);
                }
            }
        }
        return Object.freeze(paths.sort(compareName));
    }

    private async listChildrenFromRoot(
        root: ScenarioFilesUri,
        normalizedDirectory: string,
        itemId: string,
        compiledFeatureUri?: string
    ): Promise<readonly ScenarioFileNode[]> {
        if (!await this.existingResourcePathIsSafe(root, normalizedDirectory)) {
            return Object.freeze([]);
        }
        const directory = this.resourceUri(root, normalizedDirectory);
        let entries: readonly ScenarioFilesDirectoryEntry[];
        try {
            entries = await this.host.readDirectory(directory);
        } catch (error) {
            if (this.host.isFileNotFound(error)) {
                return Object.freeze([]);
            }
            throw error;
        }
        const parentDepth = normalizedDirectory
            ? normalizedDirectory.split('/').length
            : 0;
        const excluded = compiledFeatureUri && !normalizedDirectory
            ? await this.compiledSiblingArtifacts(root, compiledFeatureUri, entries) : new Set<string>();
        return Object.freeze(entries
            .filter(entry => (
                entry.kind === 'directory' || entry.kind === 'file'
            ) && !this.isHiddenResourceArtifact(entry.name)
                && !excluded.has(entry.name.normalize('NFC').toLowerCase()))
            .sort((left, right) => {
                const kindDifference = left.kind === right.kind
                    ? 0
                    : left.kind === 'directory' ? -1 : 1;
                return kindDifference || compareName(left.name, right.name);
            })
            .map(entry => {
                const relativePath = normalizedDirectory
                    ? `${normalizedDirectory}/${entry.name}`
                    : entry.name;
                const kind = entry.kind === 'directory' ? 'directory' : 'file';
                return Object.freeze({
                    id: scenarioFileNodeId(itemId, kind, relativePath),
                    kind,
                    itemId,
                    name: entry.name,
                    relativePath,
                    depth: parentDepth + 1,
                    expandable: kind === 'directory'
                });
            }));
    }

    async openExternal(item: StepLibraryItem, relativePath: string): Promise<boolean> {
        try {
            const normalized = this.requireRelativePath(relativePath);
            if (!normalized) {
                return false;
            }
            const root = await this.resourceRootForPath(item, normalized);
            if (!await this.existingResourcePathIsSafe(root, normalized)) {
                return false;
            }
            return await this.host.openExternal(this.resourceUri(root, normalized));
        } catch {
            return false;
        }
    }

    async openCompiledFeature(item: StepLibraryItem): Promise<boolean> {
        try {
            const featureUri = item.compiledFeatureUri?.trim();
            if ((item.kind !== 'mainScenario' && item.kind !== 'process') || !featureUri || !/^file:/iu.test(featureUri)) {
                return false;
            }
            const parsed = this.host.parseUri(featureUri);
            const stat = await this.tryLstat(fileURLToPath(parsed.toString()));
            if (!stat?.isFile() || stat.isSymbolicLink()) {
                return false;
            }
            return await this.host.openInEditor(parsed);
        } catch {
            return false;
        }
    }

    async revealInOs(item: StepLibraryItem, relativePath: string): Promise<boolean> {
        try {
            const normalized = this.requireRelativePath(relativePath);
            const root = await this.resourceRootForPath(item, normalized);
            if (!await this.existingResourcePathIsSafe(root, normalized)) {
                return false;
            }
            await this.host.revealInOs(this.resourceUri(root, normalized));
            return true;
        } catch {
            return false;
        }
    }

    async deleteFile(
        item: StepLibraryItem,
        relativePath: string,
        stillCurrent?: () => boolean
    ): Promise<'deleted' | 'cancelled'> {
        if (this.disposed) {
            throw new Error('Scenario files service is disposed.');
        }
        const normalized = this.requireRelativePath(relativePath);
        if (!normalized) {
            throw new Error('A scenario attachment file path is required.');
        }
        const root = await this.resourceRootForPath(item, normalized);
        const rootPath = fileURLToPath(root.toString());
        const rootStat = await this.tryLstat(rootPath);
        if (!rootStat) {
            throw new Error('Scenario files root does not exist.');
        }
        if (rootStat.isSymbolicLink()) {
            throw new Error('Scenario files root cannot be a symbolic link.');
        }
        if (!rootStat.isDirectory()) {
            throw new Error('A non-directory blocks the scenario files root.');
        }

        const rootRealPath = await fs.realpath(rootPath);
        let currentPath = rootPath;
        const segments = normalized.split('/');
        for (let index = 0; index < segments.length; index += 1) {
            currentPath = path.join(currentPath, segments[index]);
            const stat = await this.tryLstat(currentPath);
            if (!stat) {
                throw new Error(`Scenario attachment ${normalized} does not exist.`);
            }
            if (stat.isSymbolicLink()) {
                throw new Error('Scenario attachment paths cannot contain a symbolic link.');
            }
            const isLeaf = index === segments.length - 1;
            if (!isLeaf && !stat.isDirectory()) {
                throw new Error('A non-directory blocks the scenario attachment path.');
            }
            if (isLeaf && !stat.isFile()) {
                throw new Error('Only a regular scenario attachment file can be deleted.');
            }
        }

        const targetRealPath = await fs.realpath(currentPath);
        if (!this.pathIsWithin(rootRealPath, targetRealPath)) {
            throw new Error('Scenario files path escapes through a symbolic link.');
        }
        if (!await this.host.confirmDelete(normalized)) {
            return 'cancelled';
        }
        if (stillCurrent && !stillCurrent()) { throw new Error('The selected source changed. Retry the attachment action.'); }
        await this.host.deleteFile(this.resourceUri(root, normalized));
        return 'deleted';
    }

    async renameFile(item: StepLibraryItem, relativePath: string, stillCurrent?: () => boolean): Promise<'renamed' | 'cancelled'> {
        if (this.disposed) { throw new Error('Scenario files service is disposed.'); }
        const normalized = this.requireRelativePath(relativePath);
        if (!normalized) { throw new Error('A scenario attachment file path is required.'); }
        const root = await this.resourceRootForPath(item, normalized);
        const rootPath = fileURLToPath(root.toString());
        const validateSource = async () => {
            const rootStat = await fs.lstat(rootPath);
            if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) { throw new Error('Scenario files root must be a regular directory without symbolic links.'); }
            let current = rootPath;
            const segments = normalized.split('/');
            for (const [index, segment] of segments.entries()) {
                current = path.join(current, segment);
                const stat = await fs.lstat(current);
                if (stat.isSymbolicLink()) { throw new Error('Scenario attachment paths cannot contain a symbolic link.'); }
                if (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory()) { throw new Error('Only a regular scenario attachment file can be renamed.'); }
            }
        };
        await validateSource();
        const name = await this.host.promptRename?.(path.posix.basename(normalized));
        if (name === undefined) { return 'cancelled'; }
        const trimmed = name.trim();
        if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/:*?"<>|\x00-\x1f]/u.test(trimmed) || /[. ]$/u.test(trimmed)) {
            throw new Error('Enter a valid attachment file name without a path.');
        }
        if (stillCurrent && !stillCurrent()) { throw new Error('The selected source changed. Retry the attachment action.'); }
        await validateSource();
        if (trimmed === path.posix.basename(normalized)) { return 'cancelled'; }
        const parent = path.posix.dirname(normalized);
        const destination = parent === '.' ? trimmed : `${parent}/${trimmed}`;
        await this.assertCompiledSiblingPath(item, root, destination);
        const from = this.resourceUri(root, normalized); const to = this.resourceUri(root, destination);
        if (await this.tryLstat(fileURLToPath(to.toString()))) { throw new Error('An attachment with this name already exists.'); }
        if (this.host.renameFile) { await this.host.renameFile(from, to); }
        else {
            await fs.link(fileURLToPath(from.toString()), fileURLToPath(to.toString()));
            try { await fs.unlink(fileURLToPath(from.toString())); }
            catch (reason) { await fs.unlink(fileURLToPath(to.toString())); throw reason; }
        }
        this.clearRootCache(root.toString());
        this.scheduleInvalidation(root.toString(), from); this.scheduleInvalidation(root.toString(), to);
        return 'renamed';
    }

    async prepareDrop(
        item: StepLibraryItem,
        targetDirectory: string,
        entries: readonly ScenarioFileManifestEntry[],
        stillCurrent?: () => boolean
    ): Promise<ScenarioFileDropPlan> {
        if (this.disposed) {
            throw new Error('Scenario files service is disposed.');
        }
        const assertCurrent = () => {
            if (stillCurrent && !stillCurrent()) { throw new Error('The selected source changed. Retry the attachment action.'); }
        };
        assertCurrent();
        const normalizedTarget = this.requireRelativePath(targetDirectory);
        const rootUri = await this.resourceRootForPath(item, normalizedTarget);
        const rootPath = fileURLToPath(rootUri.toString());
        const validated = this.validateManifest(normalizedTarget, entries);
        for (const entry of validated) { await this.assertCompiledSiblingPath(item, rootUri, entry.destinationRelativePath); }
        const existingRoot = await this.tryLstat(rootPath);
        if (existingRoot?.isSymbolicLink()) {
            throw new Error('Scenario files root cannot be a symbolic link.');
        }
        if (existingRoot && !existingRoot.isDirectory()) {
            throw new Error('A non-directory blocks the scenario files root.');
        }
        assertCurrent();
        await fs.mkdir(rootPath, { recursive: true });
        const rootRealPath = await fs.realpath(rootPath);
        const plannedTransferIds: string[] = [];
        const plannedFiles: ScenarioFileDropPlanEntry[] = [];
        const skipped: string[] = [];
        try {
            const directories = validated
                .filter(entry => entry.kind === 'directory')
                .sort((left, right) => {
                    const depth = left.destinationRelativePath.split('/').length
                        - right.destinationRelativePath.split('/').length;
                    return depth || compareName(left.destinationRelativePath, right.destinationRelativePath);
                });
            for (const directory of directories) {
                const destination = path.join(
                    rootPath,
                    ...directory.destinationRelativePath.split('/')
                );
                await this.assertSafeDirectoryChain(
                    rootPath,
                    rootRealPath,
                    directory.destinationRelativePath
                );
                const stat = await this.tryLstat(destination);
                if (stat && !stat.isDirectory() && !stat.isSymbolicLink()) {
                    throw new Error(`A file blocks directory ${directory.destinationRelativePath}.`);
                }
                assertCurrent();
                await fs.mkdir(destination, { recursive: true });
            }

            for (const entry of validated.filter(candidate => candidate.kind === 'file')) {
                const parentRelativePath = path.posix.dirname(entry.destinationRelativePath);
                const normalizedParent = parentRelativePath === '.' ? '' : parentRelativePath;
                await this.assertSafeDirectoryChain(rootPath, rootRealPath, normalizedParent);
                const parentPath = normalizedParent
                    ? path.join(rootPath, ...normalizedParent.split('/'))
                    : rootPath;
                assertCurrent();
                await fs.mkdir(parentPath, { recursive: true });

                let destinationRelativePath = entry.destinationRelativePath;
                let destinationPath = path.join(rootPath, ...destinationRelativePath.split('/'));
                let replace = false;
                const existing = await this.tryLstat(destinationPath);
                if (existing) {
                    await this.assertExistingLeafSafe(rootRealPath, destinationPath);
                    if (existing.isDirectory()) {
                        throw new Error(`A directory blocks file ${destinationRelativePath}.`);
                    }
                    const decision = await this.host.chooseConflict(destinationRelativePath);
                    assertCurrent();
                    if (decision === 'skip') {
                        skipped.push(entry.clientPath);
                        continue;
                    }
                    if (decision === 'copy') {
                        destinationRelativePath = await this.availableCopyPath(
                            rootPath,
                            destinationRelativePath
                        );
                        destinationPath = path.join(
                            rootPath,
                            ...destinationRelativePath.split('/')
                        );
                    } else {
                        replace = true;
                    }
                }

                assertCurrent();
                const transferId = randomUUID();
                const temporaryPath = path.join(
                    path.dirname(destinationPath),
                    `.${path.basename(destinationPath)}.${transferId}.kot-upload`
                );
                const state: TransferState = {
                    id: transferId,
                    clientPath: entry.clientPath,
                    destinationRelativePath,
                    destinationPath,
                    temporaryPath,
                    expectedSize: entry.size!,
                    replace,
                    handle: undefined,
                    offset: 0,
                    closed: false
                };
                this.transfers.set(transferId, state);
                plannedTransferIds.push(transferId);
                plannedFiles.push(Object.freeze({
                    clientPath: entry.clientPath,
                    destinationRelativePath,
                    transferId
                }));
            }
        } catch (error) {
            await Promise.all(plannedTransferIds.map(id => this.cancelTransfer(id)));
            throw error;
        }
        return Object.freeze({
            files: Object.freeze(plannedFiles),
            skipped: Object.freeze(skipped)
        });
    }

    async appendTransferChunk(
        transferId: string,
        offset: number,
        base64: string
    ): Promise<number> {
        const transfer = this.transfers.get(transferId);
        if (!transfer) {
            throw new Error('Unknown scenario file transfer.');
        }
        try {
            if (offset !== transfer.offset) {
                throw new Error(`Unexpected transfer offset ${offset}; expected ${transfer.offset}.`);
            }
            if (
                !base64
                || base64.length > MAX_BASE64_CHARACTERS
                || !BASE64_PATTERN.test(base64)
            ) {
                throw new Error('Invalid scenario file transfer chunk.');
            }
            const bytes = Buffer.from(base64, 'base64');
            if (bytes.length > MAX_CHUNK_BYTES) {
                throw new Error('Scenario file transfer chunk is too large.');
            }
            if (transfer.offset + bytes.length > transfer.expectedSize) {
                throw new Error('Scenario file transfer exceeds its declared size.');
            }
            let written = 0;
            const handle = await this.ensureTransferHandle(transfer);
            while (written < bytes.length) {
                const result = await handle.write(
                    bytes,
                    written,
                    bytes.length - written,
                    transfer.offset + written
                );
                if (result.bytesWritten <= 0) {
                    throw new Error('Scenario file transfer made no write progress.');
                }
                written += result.bytesWritten;
            }
            transfer.offset += bytes.length;
            return transfer.offset;
        } catch (error) {
            await this.cleanupTransfer(transfer);
            throw error;
        }
    }

    async completeTransfer(transferId: string): Promise<void> {
        const transfer = this.transfers.get(transferId);
        if (!transfer) {
            throw new Error('Unknown scenario file transfer.');
        }
        this.transfers.delete(transferId);
        if (transfer.offset !== transfer.expectedSize) {
            await this.cleanupTransfer(transfer, false);
            throw new Error('Scenario file transfer is incomplete.');
        }
        try {
            await this.ensureTransferHandle(transfer);
            await this.closeTransfer(transfer);
            if (transfer.replace) {
                await this.publishReplacement(transfer);
            } else {
                await fs.link(transfer.temporaryPath, transfer.destinationPath);
                await fs.unlink(transfer.temporaryPath);
            }
        } catch (error) {
            await fs.unlink(transfer.temporaryPath).catch(() => undefined);
            throw error;
        }
    }

    async cancelTransfer(transferId: string): Promise<void> {
        const transfer = this.transfers.get(transferId);
        if (!transfer) {
            return;
        }
        await this.cleanupTransfer(transfer);
    }

    watch(
        item: StepLibraryItem,
        listener: (event: ScenarioFilesInvalidation) => void
    ): ScenarioFilesDisposable {
        if (this.disposed) {
            return { dispose: () => undefined };
        }
        const root = this.resourceRoot(item);
        const watches = [this.watchRoot(root, item.id, listener)];
        const sibling = this.compiledSiblingRoot(item);
        if (sibling && sibling.toString() !== root.toString()) { watches.push(this.watchRoot(sibling, item.id, listener)); }
        if (item.sourceScenarioFilesRootUri && item.sourceScenarioFilesRootUri !== root.toString()) {
            watches.push(this.watchRoot(this.host.parseUri(item.sourceScenarioFilesRootUri), item.id, listener));
        }
        return { dispose: () => watches.forEach(watch => watch.dispose()) };
    }

    private watchRoot(
        root: ScenarioFilesUri,
        itemId: string,
        listener: (event: ScenarioFilesInvalidation) => void
    ): ScenarioFilesDisposable {
        const key = root.toString();
        let shared = this.watches.get(key);
        if (!shared) {
            const watcher = this.host.createWatcher(root);
            shared = {
                rootUri: key,
                watcher,
                subscriptions: Object.freeze([
                    watcher.onDidCreate(uri => this.scheduleInvalidation(key, uri)),
                    watcher.onDidChange(uri => this.scheduleInvalidation(key, uri)),
                    watcher.onDidDelete(uri => this.scheduleInvalidation(key, uri))
                ]),
                subscribers: new Map(),
                changedUris: new Set(),
                timer: undefined
            };
            this.watches.set(key, shared);
        }
        const subscriberId = this.nextSubscriberId++;
        shared.subscribers.set(subscriberId, {
            id: subscriberId,
            itemId,
            listener
        });
        let active = true;
        return {
            dispose: () => {
                if (!active) {
                    return;
                }
                active = false;
                const current = this.watches.get(key);
                current?.subscribers.delete(subscriberId);
                if (current && current.subscribers.size === 0) {
                    this.disposeWatch(key, current);
                }
            }
        };
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.attachmentPathLoads.clear();
        this.attachmentIndexWatches.clear();
        for (const [key, watch] of [...this.watches]) {
            this.disposeWatch(key, watch);
        }
        for (const transfer of [...this.transfers.values()]) {
            void this.cleanupTransfer(transfer);
        }
        this.invalidationEmitter.dispose();
    }

    private resourceRoot(item: StepLibraryItem): ScenarioFilesUri {
        if ((item.kind === 'mainScenario' || item.kind === 'process') && (item.sourceGroup === 'main' || item.sourceGroup === 'process')) {
            if (!scenarioFilesAvailable(item) || !item.scenarioFilesRootUri) {
                throw new Error('Scenario files require a local compiled attachments root.');
            }
            return this.host.parseUri(item.scenarioFilesRootUri);
        }
        if (item.kind !== 'nestedScenario' || item.sourceGroup !== 'nested') {
            throw new Error('Scenario files are available only for a nested scenario.');
        }
        if (!scenarioFilesAvailable(item) || !item.capturedLocation) {
            throw new Error('Scenario files require a local scenario definition.');
        }
        const definition = this.host.parseUri(item.capturedLocation.uri);
        return this.host.joinPath(this.host.dirname(definition), 'files');
    }

    private compiledSiblingRoot(item: StepLibraryItem): ScenarioFilesUri | undefined {
        if ((item.kind !== 'mainScenario' && item.kind !== 'process') || !/^file:/iu.test(item.compiledFeatureUri ?? '')
            || item.scenarioFilesRootUri === item.sourceScenarioFilesRootUri) { return undefined; }
        return this.host.dirname(this.host.parseUri(item.compiledFeatureUri!));
    }

    private async resourceRoots(item: StepLibraryItem): Promise<readonly ResourceRoot[]> {
        const primary = this.resourceRoot(item);
        const sibling = this.compiledSiblingRoot(item);
        if (!sibling) { return [{ uri: primary }]; }
        const feature = await this.tryLstat(fileURLToPath(item.compiledFeatureUri!));
        if (!feature?.isFile() || feature.isSymbolicLink()) { return [{ uri: primary }]; }
        const flat = { uri: sibling, compiledFeatureUri: item.compiledFeatureUri };
        return primary.toString() === sibling.toString() ? [flat] : [{ uri: primary }, flat];
    }

    private async compiledSiblingArtifacts(root: ScenarioFilesUri, featureUri: string, entries: readonly ScenarioFilesDirectoryEntry[]): Promise<Set<string>> {
        const names = new Set(['compile.txt', 'yaml_parameters.json', 'yaml_build_log.txt', '.kot-build-manifest.json']);
        const featureName = path.basename(fileURLToPath(featureUri));
        const stems = new Set([featureName.slice(0, -'.feature'.length), ...entries
            .filter(entry => entry.kind === 'file' && /\.feature$/iu.test(entry.name))
            .map(entry => entry.name.slice(0, -'.feature'.length))]);
        for (const stem of stems) {
            for (const suffix of ['.feature', '.str', '.json', '.combined.json']) { names.add((stem + suffix).normalize('NFC').toLowerCase()); }
            // The conventional per-feature container is already projected through its Файлы root.
            const legacy = await this.tryLstat(fileURLToPath(this.host.joinPath(root, stem, 'Файлы').toString()));
            if (legacy?.isDirectory()) { names.add(stem.normalize('NFC').toLowerCase()); }
        }
        return names;
    }

    private async assertCompiledSiblingPath(item: StepLibraryItem, root: ScenarioFilesUri, relativePath: string): Promise<void> {
        if (!relativePath || this.compiledSiblingRoot(item)?.toString() !== root.toString()) { return; }
        const first = relativePath.split('/')[0].normalize('NFC').toLowerCase();
        const entries = await this.host.readDirectory(root);
        if (/\.feature$/u.test(first) || (await this.compiledSiblingArtifacts(root, item.compiledFeatureUri!, entries)).has(first)) {
            throw new Error('Invalid scenario files path.');
        }
    }

    private async resourceRootForPath(item: StepLibraryItem, relativePath: string): Promise<ScenarioFilesUri> {
        for (const root of await this.resourceRoots(item)) {
            if (await this.existingResourcePathIsSafe(root.uri, relativePath)) {
                await this.assertCompiledSiblingPath(item, root.uri, relativePath);
                return root.uri;
            }
        }
        return this.resourceRoot(item);
    }

    private rootCacheKey(root: ResourceRoot): string {
        // Features sharing an output folder share the same flat attachment inventory.
        return root.uri.toString() + (root.compiledFeatureUri ? '\0compiled' : '');
    }

    private clearRootCache(rootUri: string): void {
        for (const key of this.attachmentPathLoads.keys()) {
            if (key === rootUri || key.startsWith(rootUri + '\0')) { this.attachmentPathLoads.delete(key); }
        }
    }

    private requireRelativePath(value: string): string {
        const normalized = normalizeScenarioFileRelativePath(value);
        if (normalized === null) {
            throw new Error('Invalid scenario files path.');
        }
        return normalized;
    }

    private resourceUri(root: ScenarioFilesUri, relativePath: string): ScenarioFilesUri {
        return relativePath
            ? this.host.joinPath(root, ...relativePath.split('/'))
            : root;
    }

    private isHiddenResourceArtifact(name: string): boolean {
        return name.endsWith('.kot-upload')
            || name.endsWith('.kot-backup')
            || OPERATING_SYSTEM_METADATA_NAMES.has(name.toLocaleLowerCase());
    }

    private async existingResourcePathIsSafe(
        root: ScenarioFilesUri,
        relativePath: string
    ): Promise<boolean> {
        const rootPath = fileURLToPath(root.toString());
        const rootStat = await this.tryLstat(rootPath);
        if (!rootStat) {
            return false;
        }
        if (rootStat.isSymbolicLink()) {
            throw new Error('Scenario files root cannot be a symbolic link.');
        }
        if (!rootStat.isDirectory()) {
            throw new Error('A non-directory blocks the scenario files root.');
        }
        const rootRealPath = await fs.realpath(rootPath);
        const targetPath = relativePath
            ? path.join(rootPath, ...relativePath.split('/'))
            : rootPath;
        if (!await this.tryLstat(targetPath)) {
            return false;
        }
        const targetRealPath = await fs.realpath(targetPath);
        if (!this.pathIsWithin(rootRealPath, targetRealPath)) {
            throw new Error('Scenario files path escapes through a symbolic link.');
        }
        return true;
    }

    private validateManifest(
        targetDirectory: string,
        entries: readonly ScenarioFileManifestEntry[]
    ): readonly ValidatedManifestEntry[] {
        const seen = new Set<string>();
        return Object.freeze(entries.map(entry => {
            const clientPath = normalizeScenarioFileRelativePath(entry.clientPath);
            if (clientPath === null || !clientPath) {
                throw new Error('Invalid scenario files path.');
            }
            if (seen.has(clientPath)) {
                throw new Error(`Duplicate scenario files path ${clientPath}.`);
            }
            seen.add(clientPath);
            const destinationRelativePath = targetDirectory
                ? `${targetDirectory}/${clientPath}`
                : clientPath;
            const normalizedDestination = normalizeScenarioFileRelativePath(destinationRelativePath);
            if (normalizedDestination === null || !normalizedDestination) {
                throw new Error('Invalid scenario files path.');
            }
            if (entry.kind === 'file' && (
                !Number.isSafeInteger(entry.size)
                || entry.size === undefined
                || entry.size < 0
            )) {
                throw new Error(`Invalid declared size for ${clientPath}.`);
            }
            return Object.freeze({
                clientPath,
                destinationRelativePath: normalizedDestination,
                kind: entry.kind,
                ...(entry.kind === 'file' ? { size: entry.size } : {})
            });
        }));
    }

    private async tryLstat(targetPath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
        try {
            return await fs.lstat(targetPath);
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    private pathIsWithin(rootPath: string, candidatePath: string): boolean {
        const relative = path.relative(rootPath, candidatePath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    private async assertSafeDirectoryChain(
        rootPath: string,
        rootRealPath: string,
        relativeDirectory: string
    ): Promise<void> {
        let current = rootPath;
        for (const segment of relativeDirectory ? relativeDirectory.split('/') : []) {
            current = path.join(current, segment);
            const stat = await this.tryLstat(current);
            if (!stat) {
                return;
            }
            if (stat.isSymbolicLink()) {
                const realPath = await fs.realpath(current);
                if (!this.pathIsWithin(rootRealPath, realPath)) {
                    throw new Error('Scenario files path escapes through a symbolic link.');
                }
                const targetStat = await fs.stat(current);
                if (!targetStat.isDirectory()) {
                    throw new Error('A non-directory blocks a scenario files path.');
                }
                continue;
            }
            if (!stat.isDirectory()) {
                throw new Error('A non-directory blocks a scenario files path.');
            }
        }
    }

    private async assertExistingLeafSafe(rootRealPath: string, destinationPath: string): Promise<void> {
        const stat = await fs.lstat(destinationPath);
        if (!stat.isSymbolicLink()) {
            return;
        }
        const realPath = await fs.realpath(destinationPath);
        if (!this.pathIsWithin(rootRealPath, realPath)) {
            throw new Error('Scenario files path escapes through a symbolic link.');
        }
    }

    private async availableCopyPath(rootPath: string, relativePath: string): Promise<string> {
        const parsed = path.posix.parse(relativePath);
        for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
            const name = `${parsed.name} (${index})${parsed.ext}`;
            const candidate = parsed.dir ? `${parsed.dir}/${name}` : name;
            const candidatePath = path.join(rootPath, ...candidate.split('/'));
            if (!await this.tryLstat(candidatePath)) {
                return candidate;
            }
        }
        throw new Error(`Could not choose a copy name for ${relativePath}.`);
    }

    private async closeTransfer(transfer: TransferState): Promise<void> {
        if (transfer.closed) {
            return;
        }
        transfer.closed = true;
        await transfer.handle?.close();
    }

    private async ensureTransferHandle(transfer: TransferState): Promise<FileHandle> {
        if (!transfer.handle) {
            transfer.handle = await fs.open(transfer.temporaryPath, 'wx');
        }
        return transfer.handle;
    }

    private async cleanupTransfer(transfer: TransferState, removeFromMap = true): Promise<void> {
        if (removeFromMap) {
            this.transfers.delete(transfer.id);
        }
        await this.closeTransfer(transfer).catch(() => undefined);
        await fs.unlink(transfer.temporaryPath).catch(() => undefined);
    }

    private async publishReplacement(transfer: TransferState): Promise<void> {
        const existing = await this.tryLstat(transfer.destinationPath);
        if (!existing) {
            await fs.rename(transfer.temporaryPath, transfer.destinationPath);
            return;
        }
        const backupPath = `${transfer.destinationPath}.${randomUUID()}.kot-backup`;
        await fs.rename(transfer.destinationPath, backupPath);
        try {
            await fs.rename(transfer.temporaryPath, transfer.destinationPath);
        } catch (error) {
            await fs.rename(backupPath, transfer.destinationPath).catch(() => undefined);
            throw error;
        }
        await fs.unlink(backupPath).catch(() => undefined);
    }

    private scheduleInvalidation(key: string, changedUri: ScenarioFilesUri): void {
        const shared = this.watches.get(key);
        if (!shared) {
            return;
        }
        this.clearRootCache(key);
        shared.changedUris.add(changedUri.toString());
        if (shared.timer !== undefined) {
            return;
        }
        shared.timer = setTimeout(() => {
            shared.timer = undefined;
            const changedUris = Object.freeze([...shared.changedUris]);
            shared.changedUris.clear();
            const uniqueEvents = new Map<string, ScenarioFilesInvalidation>();
            for (const subscriber of [...shared.subscribers.values()]) {
                const event = Object.freeze({
                    itemId: subscriber.itemId,
                    rootUri: shared.rootUri,
                    changedUris
                });
                subscriber.listener(event);
                uniqueEvents.set(subscriber.itemId, event);
            }
            for (const event of uniqueEvents.values()) {
                this.invalidationEmitter.fire(event);
            }
        }, 100);
    }

    private disposeWatch(key: string, shared: SharedWatch): void {
        if (shared.timer !== undefined) {
            clearTimeout(shared.timer);
        }
        for (const subscription of shared.subscriptions) {
            subscription.dispose();
        }
        shared.watcher.dispose();
        shared.subscribers.clear();
        this.watches.delete(key);
    }
}
