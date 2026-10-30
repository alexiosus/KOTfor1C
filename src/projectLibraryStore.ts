import { projectFormat, assertProjectFormat3, assertProjectFormatUnchanged, type ProjectFormat } from './projectFormat';
import { assertProjectTransitionBranch } from './projectFormatTransition';
import fs from 'node:fs/promises';
import { getProjectEntityDisplayOrder, type ProjectEntityDisplayOrder } from './projectEntityDisplayOrder';
import { readProjectOrganization, planProjectOrganizationWrites, projectDeletionHistoryWrite, type ProjectOrganization } from './projectLibraryOrganization';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { isProjectSetupPending } from './projectSetupGate';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { removeMigratedKotMetadata } from './projectLegacyMetadataCleanup';
import { collectTreeWithConcurrencyLimit, mapWithConcurrencyLimit } from './boundedConcurrency';

export type ProjectSection = 'main' | 'process' | 'standalone';
export type ProjectLegacyImportScope = 'scenario' | 'standalone';
export interface ProjectGroup {
    readonly id: string;
    readonly name: string;
    readonly sections: readonly ProjectSection[];
    readonly order: number;
}
export interface ProjectEntityIdentity {
    readonly kind: 'scenario' | 'process' | 'feature';
    readonly relativePath: string;
    readonly uid?: string;
}
export interface ProjectEntityMetadata {
    readonly groupId?: string;
    readonly order?: number;
    readonly description?: string;
    readonly category?: string;
}
export type ProjectEntityMetadataPatch = {
    readonly [Field in keyof ProjectEntityMetadata]?: ProjectEntityMetadata[Field] | null;
};
export interface ProjectEntityOrderState {
    readonly key: string;
    readonly order: number | null;
}
export interface ProjectLibrarySnapshot {
    readonly groups: readonly ProjectGroup[];
    readonly metadata: Readonly<Record<string, ProjectEntityMetadata>>;
    readonly identities: Readonly<Record<string, ProjectEntityIdentity>>;
    readonly legacyImports: readonly ProjectLegacyImportScope[];
    /** Derived from live sidecars and per-object deletion history; never persisted as a shared list. */
    readonly knownScenarioKeys?: readonly string[];
}
export interface ProjectLibraryImport {
    readonly groups: readonly ProjectGroup[];
    readonly entities: readonly { readonly identity: ProjectEntityIdentity; readonly metadata: ProjectEntityMetadata }[];
}
export class ProjectLibraryStoreError extends Error {
    constructor(readonly filePath: string, message: string) {
        super(`${message}: ${filePath}`);
        this.name = 'ProjectLibraryStoreError';
    }
}
interface MetadataDocument {
    readonly version: 1 | 2;
    readonly identity: ProjectEntityIdentity;
    readonly metadata: ProjectEntityMetadata;
}
interface LoadedLibrary {
    organization: ProjectOrganization;
    groups: ProjectGroup[];
    legacyImports: ProjectLegacyImportScope[];
    records: Map<string, MetadataDocument>;
    recordPaths: Map<string, string>;
    originals: Map<string, string | undefined>;
    knownScenarioKeys: Set<string>;
}
interface PendingWrite {
    readonly filePath: string;
    readonly text: string | undefined;
}
export interface ProjectFileProgress { readonly label: string; readonly completed?: number; readonly total?: number }
export interface ProjectLibraryStoreOptions {
    readonly displayOrder?: ProjectEntityDisplayOrder;
    readonly onProgress?: (progress: ProjectFileProgress) => void;
    /** Legacy-block snapshots from the source scan. Missing entries are already known to be clean. */
    readonly sourceTexts?: ReadonlyMap<string, string>;
    readonly canCleanSource?: (filePath: string) => boolean;
    readonly beforeWrite?: (paths: readonly string[]) => void;
    readonly sourceIdentities?: readonly ProjectEntityIdentity[];
    readonly discoveryRoots?: readonly string[];
    readonly excludedRoots?: readonly string[];
    readonly onWarning?: (message: string) => void;
}

const mutationQueues = new Map<string, Promise<void>>();
/** File watchers wait for one settled snapshot rather than queue a reload for each migration batch. */
export async function waitForProjectLibraryIdle(): Promise<void> {
    while (mutationQueues.size) { await Promise.all([...mutationQueues.values()]); }
}
const sections: readonly ProjectSection[] = ['main', 'process', 'standalone'];
const importScopes: readonly ProjectLegacyImportScope[] = ['scenario', 'standalone'];
const metadataFields = ['groupId', 'order', 'description', 'category'] as const;

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${label} must be an object`); }
    return value as Record<string, unknown>;
}
function allowedFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
    const unsupported = Object.keys(value).find(key => !fields.includes(key));
    if (unsupported) { throw new Error(`Unsupported ${label} field ${unsupported}`); }
}
function textField(value: unknown, label: string, allowEmpty = false): string {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.includes('\0')) {
        throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a nonempty'} string`);
    }
    return value;
}
function portableIdentity(value: unknown): ProjectEntityIdentity {
    const source = record(value, 'identity');
    allowedFields(source, ['kind', 'relativePath', 'uid'], 'identity');
    if (!['scenario', 'process', 'feature'].includes(String(source.kind))) { throw new Error('Unsupported entity kind'); }
    const relativePath = textField(source.relativePath, 'relativePath').replace(/\\/g, '/');
    if (relativePath.startsWith('/') || /^[a-z]:/i.test(relativePath) || relativePath.split('/').some(part => part === '..' || part === '.' || !part)) {
        throw new Error('Entity path must be relative without traversal');
    }
    const uid = source.uid === undefined ? undefined : textField(source.uid, 'uid').trim().toLowerCase();
    if (source.kind === 'feature' && uid) { throw new Error('Feature metadata cannot contain a scenario UID'); }
    return { kind: source.kind as ProjectEntityIdentity['kind'], relativePath, ...(uid ? { uid } : {}) };
}
/** Runtime file URIs stay local; these keys remain identical in a different checkout. */
export function projectEntityKey(identity: ProjectEntityIdentity): string {
    const normalized = portableIdentity(identity);
    if (normalized.kind !== 'feature' && normalized.uid) { return `uid:${normalized.uid}`; }
    return `${normalized.kind}:${normalized.relativePath}`;
}
function scenarioLedgerKey(value: unknown): string {
    const key = textField(value, 'known scenario key');
    if (key.startsWith('uid:')) {
        if (projectEntityKey({ kind: 'scenario', uid: key.slice(4), relativePath: 'scenario.yaml' }) === key) { return key; }
    } else {
        const match = /^(scenario|process):(.+)$/u.exec(key);
        if (match && projectEntityKey({ kind: match[1] as 'scenario' | 'process', relativePath: match[2] }) === key) { return key; }
    }
    throw new Error('Known scenario keys must use a normalized scenario/process identity');
}
export function metadataFilePath(rootPath: string, identity: ProjectEntityIdentity): string {
    const normalized = portableIdentity(identity);
    validateSourceExtension(normalized);
    return `${path.join(path.resolve(rootPath), normalized.relativePath)}.kot.yml`;
}
function validateSourceExtension(identity: ProjectEntityIdentity): void {
    if (!(identity.kind === 'feature' ? /\.feature$/i : /\.ya?ml$/i).test(identity.relativePath)) {
        throw new Error('Metadata kind does not match its source filename extension');
    }
}
function relativeSourcePath(filePath: string, rootPath: string): string {
    const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
    if (!relative.endsWith('.kot.yml') || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Metadata must be an adjacent .kot.yml file inside its project root');
    }
    return relative.slice(0, -'.kot.yml'.length).split(path.sep).join('/');
}
/** Read portable metadata after a folder move using its current physical owner filename. */
export function parseProjectMetadataSidecar(text: string, filePath: string, rootPath: string): { identity: ProjectEntityIdentity; metadata: ProjectEntityMetadata } {
    try {
        const source = parseYaml(text, filePath);
        allowedFields(source, ['version', 'identity', 'metadata'], 'metadata document');
        if (source.version !== 1 && source.version !== 2) { throw new Error('Unsupported project metadata version'); }
        const identitySource = record(source.identity, 'identity');
        allowedFields(identitySource, source.version === 1 ? ['kind', 'uid', 'relativePath'] : ['kind', 'uid'], 'identity');
        // Validate old stored paths, but never use them to override the physical owner.
        if (source.version === 1) { portableIdentity(identitySource); }
        const identity = portableIdentity({ ...identitySource, relativePath: relativeSourcePath(filePath, rootPath) });
        validateSourceExtension(identity);
        if (identity.kind === 'feature' && identity.uid) { throw new Error('Feature metadata cannot contain a scenario UID'); }
        return { identity, metadata: metadata(source.metadata) };
    } catch (error) {
        if (error instanceof ProjectLibraryStoreError) { throw error; }
        throw new ProjectLibraryStoreError(filePath, `Invalid project metadata (${error instanceof Error ? error.message : String(error)})`);
    }
}
function metadata(value: unknown): ProjectEntityMetadata {
    const source = record(value, 'metadata');
    allowedFields(source, metadataFields, 'metadata');
    const result: { groupId?: string; order?: number; description?: string; category?: string } = {};
    for (const field of ['groupId', 'description', 'category'] as const) {
        if (source[field] !== undefined) { result[field] = textField(source[field], field, true); }
    }
    if (source.order !== undefined) {
        if (typeof source.order !== 'number' || !Number.isFinite(source.order) || source.order < 0) { throw new Error('order must be a finite nonnegative number'); }
        result.order = source.order;
    }
    return result;
}
function group(value: unknown): ProjectGroup {
    const source = record(value, 'group');
    allowedFields(source, ['id', 'name', 'sections', 'order'], 'group');
    const id = textField(source.id, 'group id');
    const name = textField(source.name, 'group name').trim();
    if (!Array.isArray(source.sections) || source.sections.length === 0 || source.sections.some(section => !sections.includes(section)) || new Set(source.sections).size !== source.sections.length) {
        throw new Error('Group sections must contain distinct supported sections');
    }
    if (source.sections.includes('standalone') && source.sections.length > 1) { throw new Error('Standalone groups cannot mix scenario sections'); }
    if (typeof source.order !== 'number' || !Number.isFinite(source.order) || source.order < 0) { throw new Error('Group order must be a finite nonnegative number'); }
    return { id, name, sections: sections.filter(section => (source.sections as unknown[]).includes(section)), order: source.order };
}
export function validateProjectGroup(value: unknown): ProjectGroup { return group(value); }
function sameGroupFamily(candidate: ProjectGroup, requestedSections: readonly ProjectSection[]): boolean {
    return candidate.sections.includes('standalone') === requestedSections.includes('standalone');
}
function parseYaml(text: string, filePath: string): Record<string, unknown> {
    try {
        const document = parseDocument(text, { uniqueKeys: true });
        if (document.errors.length > 0 || document.warnings.length > 0) { throw new Error([...document.errors, ...document.warnings].map(error => error.message).join('; ')); }
        return record(document.toJS({ maxAliasCount: 100 }), 'document');
    } catch (error) {
        throw new ProjectLibraryStoreError(filePath, `Invalid project YAML (${error instanceof Error ? error.message : String(error)})`);
    }
}
async function readOptional(filePath: string): Promise<string | undefined> {
    try { return await fs.readFile(filePath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
}

/** Git-shareable library objects. All consumers for a root use the same write queue. */
export class ProjectLibraryStore {
    readonly rootPath: string;
    private readonly groupsPath: string;
    private readonly metadataDirectory: string;
    private operationFormat: ProjectFormat | undefined;

    constructor(rootPath: string, private readonly options: ProjectLibraryStoreOptions = {}) {
        this.rootPath = path.resolve(rootPath);
        this.groupsPath = path.join(this.rootPath, '.kot', 'groups');
        this.metadataDirectory = path.join(this.rootPath, '.kot', 'metadata');
    }
    metadataFilePath(identity: ProjectEntityIdentity): string { return metadataFilePath(this.rootPath, identity); }
    private displayOrder(): ProjectEntityDisplayOrder { return this.options.displayOrder ?? getProjectEntityDisplayOrder(); }
    private entitySection(identity: ProjectEntityIdentity): ProjectSection {
        return identity.kind === 'feature' ? 'standalone' : identity.kind === 'process' ? 'process' : 'main';
    }
    private displayedMetadata(key: string, document: MetadataDocument): ProjectEntityMetadata {
        const { order: fallback, ...shared } = document.metadata;
        const order = this.displayOrder().rank(this.rootPath, this.entitySection(document.identity), document.metadata.groupId ?? '', key, fallback);
        return { ...shared, ...(order === undefined ? {} : { order }) };
    }

    private async serial<T>(operation: () => Promise<T>): Promise<T> {
        const expected = projectFormat(this.rootPath);
        const key = await fs.realpath(this.rootPath).catch(() => this.rootPath);
        const previous = mutationQueues.get(key) ?? Promise.resolve();
        const result = previous.then(async () => {
            assertProjectTransitionBranch(this.rootPath);
            assertProjectFormatUnchanged(this.rootPath, expected);
            this.operationFormat = expected;
            try { return await operation(); }
            finally { this.operationFormat = undefined; }
        });
        const tail = result.then(() => undefined, () => undefined);
        mutationQueues.set(key, tail);
        try { return await result; }
        finally { if (mutationQueues.get(key) === tail) { mutationQueues.delete(key); } }
    }
    private metadataPath(key: string): string {
        return path.join(this.metadataDirectory, `${createHash('sha256').update(key).digest('hex')}.yml`);
    }
    private excludedPath(filePath: string): boolean {
        return (this.options.excludedRoots ?? []).some(root => {
            const excluded = path.resolve(this.rootPath, root);
            return filePath === excluded || filePath.startsWith(`${excluded}${path.sep}`);
        });
    }
    private async discover(): Promise<{ sidecars: string[]; sources: string[] }> {
        const result: { sidecars: string[]; sources: string[] } = { sidecars: [], sources: [] };
        const visited = new Set<string>();
        const excluded = new Set(['.git', '.kot', 'node_modules', 'out', 'dist', '.vscode-test', 'kot-runtime']);
        const visit = async (directory: string) => {
            const empty = { children: [] as string[], values: [] as Array<{ filePath: string; sidecar: boolean }> };
            const relative = path.relative(this.rootPath, directory);
            if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) { return empty; }
            if (this.excludedPath(directory)) { return empty; }
            if (relative.split(path.sep).some(segment => excluded.has(segment.toLowerCase())) || visited.has(directory)) { return empty; }
            try { await this.safePath(directory); }
            catch (error) { if (error instanceof ProjectLibraryStoreError) { return empty; } throw error; }
            visited.add(directory);
            const stat = await fs.lstat(directory).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error;
            });
            if (!stat?.isDirectory() || stat.isSymbolicLink()) { return empty; }
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const filePath = path.join(directory, entry.name);
                if (entry.isDirectory()) { empty.children.push(filePath); }
                else if (entry.isFile()) {
                    if (entry.name.endsWith('.kot.yml')) { empty.values.push({ filePath, sidecar: true }); }
                    else if (/\.(ya?ml|feature)$/i.test(entry.name)) { empty.values.push({ filePath, sidecar: false }); }
                }
            }
            return empty;
        };
        for (const root of this.options.discoveryRoots ?? [this.rootPath]) {
            const files = await collectTreeWithConcurrencyLimit(path.resolve(this.rootPath, root), 16, visit);
            for (const file of files) { (file.sidecar ? result.sidecars : result.sources).push(file.filePath); }
        }
        return result;
    }
    private async sourceIdentity(filePath: string, originals?: Map<string, string | undefined>): Promise<ProjectEntityIdentity | undefined> {
        if (this.excludedPath(filePath)) { return undefined; }
        await this.safePath(filePath);
        const stat = await fs.lstat(filePath).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error;
        });
        if (!stat?.isFile() || stat.isSymbolicLink()) { return undefined; }
        const relativePath = path.relative(this.rootPath, filePath).split(path.sep).join('/');
        const sourceText = await readOptional(filePath);
        if (sourceText === undefined) { return undefined; }
        originals?.set(filePath, sourceText);
        if (/\.feature$/i.test(filePath)) { return portableIdentity({ kind: 'feature', relativePath }); }
        if (!/\.ya?ml$/i.test(filePath)) { return undefined; }
        const yaml = ScenarioYamlDocument.parse(sourceText);
        const scenario = yaml.findSection('ДанныеСценария');
        const process = yaml.findSection('ДанныеПроцесса');
        if (!!scenario === !!process) { return undefined; }
        const uid = yaml.findField(process ? 'ДанныеПроцесса' : 'ДанныеСценария', 'UID');
        if (uid?.ambiguous) { throw new ProjectLibraryStoreError(filePath, 'Ambiguous source UID'); }
        return portableIdentity({ kind: process ? 'process' : 'scenario', relativePath,
            ...(typeof uid?.value === 'string' && uid.value.trim() ? { uid: uid.value.trim() } : {}) });
    }
    private async safePath(filePath: string): Promise<void> {
        await this.safePaths([filePath]);
    }
    private async safePaths(filePaths: readonly string[]): Promise<void> {
        const paths = new Set<string>();
        for (const filePath of filePaths) {
            const relative = path.relative(this.rootPath, path.resolve(filePath));
            if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
                throw new ProjectLibraryStoreError(filePath, 'Project object must be inside its project root');
            }
            let current = this.rootPath;
            for (const part of relative.split(path.sep)) { current = path.join(current, part); paths.add(current); }
        }
        await mapWithConcurrencyLimit([...paths], 32, async current => {
            const stat = await fs.lstat(current).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error;
            });
            if (stat?.isSymbolicLink()) { throw new ProjectLibraryStoreError(current, 'Project metadata cannot follow symlinks'); }
        });
    }
    private async load(discoverSources = true, cleanSources = discoverSources): Promise<LoadedLibrary> {
        const format = projectFormat(this.rootPath);
        const unsafeLegacyGroups = path.join(this.rootPath, '.kot', 'groups.yaml');
        if (format.kind === 'v3' && await readOptional(unsafeLegacyGroups) !== undefined) {
            throw new ProjectLibraryStoreError(unsafeLegacyGroups, 'Project library files must use .yml so the scenario compiler does not read them');
        }
        let organization: ProjectOrganization;
        const originals = new Map<string, string | undefined>();
        try { organization = await readProjectOrganization(this.rootPath, { originals, guard: file => this.safePath(file),
            parseGroup: group, parseKey: scenarioLedgerKey }); }
        catch (error) { return this.invalid(this.groupsPath, error); }
        const loaded: LoadedLibrary = { organization, groups: organization.groups, legacyImports: organization.legacyImports,
            records: new Map(), recordPaths: new Map(), originals,
            knownScenarioKeys: new Set(organization.knownKeys) };
        if (format.kind !== 'v3') { return loaded; }
        await this.safePath(this.metadataDirectory);
        const entries = await fs.readdir(this.metadataDirectory, { withFileTypes: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
            throw error;
        });
        const centralRecords = new Map<string, { document: MetadataDocument; filePath: string }>();
        for (const entry of entries) {
            if (!/\.ya?ml$/i.test(entry.name)) { continue; }
            const filePath = path.join(this.metadataDirectory, entry.name);
            try {
                if (!entry.isFile()) { throw new Error('Metadata must be a regular file'); }
                const original = await readOptional(filePath);
                if (original === undefined) { throw new Error('Metadata changed while reading'); }
                loaded.originals.set(filePath, original);
                const source = parseYaml(original, filePath);
                allowedFields(source, ['version', 'identity', 'metadata'], 'metadata document');
                if (source.version !== 1) { throw new Error('Unsupported project metadata version'); }
                const identity = portableIdentity(source.identity);
                validateSourceExtension(identity);
                const key = projectEntityKey(identity);
                if (filePath !== this.metadataPath(key)) { throw new Error('Metadata filename does not match its entity identity'); }
                if (centralRecords.has(key)) { throw new Error('Duplicate metadata identity'); }
                centralRecords.set(key, { document: { version: 1, identity, metadata: metadata(source.metadata) }, filePath });
            } catch (error) { this.invalid(filePath, error); }
        }
        const discovery = discoverSources ? await this.discover() : { sidecars: [], sources: [] };
        const adjacentPaths = new Set(discovery.sidecars);
        for (const identity of [...(this.options.sourceIdentities ?? []), ...[...centralRecords.values()].map(value => value.document.identity)]) {
            const filePath = this.metadataFilePath(identity);
            if (this.excludedPath(filePath)) { continue; }
            adjacentPaths.add(filePath);
        }
        await this.safePaths([...adjacentPaths]);
        const discoveredSidecars = new Set(discovery.sidecars);
        const documents = await mapWithConcurrencyLimit([...adjacentPaths], 32, async filePath => {
            const original = await readOptional(filePath);
            if (original === undefined) {
                if (discoveredSidecars.has(filePath)) { throw new ProjectLibraryStoreError(filePath, 'Metadata changed while reading'); }
                return undefined;
            }
            return { filePath, original, document: parseProjectMetadataSidecar(original, filePath, this.rootPath) };
        });
        for (const entry of documents) {
            if (!entry) { continue; }
            const { filePath, original, document } = entry;
            loaded.originals.set(filePath, original);
            const key = projectEntityKey(document.identity);
            if (loaded.records.has(key)) {
                throw new ProjectLibraryStoreError(filePath, `Duplicate metadata UID or identity; also found at ${loaded.recordPaths.get(key)}`);
            }
            loaded.records.set(key, { version: 2, ...document });
            loaded.recordPaths.set(key, filePath);
        }
        const migrations: PendingWrite[] = [];
        if (centralRecords.size > 0) {
            const sourcePaths = new Set(discovery.sources);
            for (const identity of this.options.sourceIdentities ?? []) { sourcePaths.add(path.join(this.rootPath, portableIdentity(identity).relativePath)); }
            for (const { document } of centralRecords.values()) { sourcePaths.add(path.join(this.rootPath, document.identity.relativePath)); }
            const sourceOriginals = new Map<string, string | undefined>();
            const identities = (await mapWithConcurrencyLimit([...sourcePaths], 16, filePath => this.sourceIdentity(filePath, sourceOriginals)))
                .filter((identity): identity is ProjectEntityIdentity => !!identity);
            for (const [key, { document, filePath }] of centralRecords) {
                const matches = identities.filter(identity => projectEntityKey(identity) === key);
                if (matches.length > 1) {
                    throw new ProjectLibraryStoreError(filePath, `Ambiguous duplicate source UID: ${matches.map(identity => identity.relativePath).join('; ')}`);
                }
                const identity = matches[0];
                if (!identity) {
                    this.options.onWarning?.(`Cannot locate source ${document.identity.relativePath}; central project metadata remains at ${filePath}`);
                    if (!loaded.records.has(key)) { loaded.records.set(key, document); loaded.recordPaths.set(key, filePath); }
                    continue;
                }
                if (identity.kind !== document.identity.kind) { throw new ProjectLibraryStoreError(filePath, 'Central metadata kind does not match its source identity'); }
                const sourcePath = path.join(this.rootPath, identity.relativePath);
                loaded.originals.set(sourcePath, sourceOriginals.get(sourcePath));
                const adjacent = loaded.records.get(key);
                if (adjacent && (adjacent.identity.kind !== identity.kind || adjacent.identity.relativePath !== identity.relativePath)) {
                    throw new ProjectLibraryStoreError(loaded.recordPaths.get(key)!, 'Adjacent metadata identity does not match the active central source');
                }
                const destination = metadataFilePath(this.rootPath, identity);
                const destinationText = await readOptional(destination);
                if (!adjacent && destinationText !== undefined) {
                    throw new ProjectLibraryStoreError(destination, 'Conflicting adjacent metadata identity; central metadata was preserved');
                }
                if (!adjacent) {
                    const moved: MetadataDocument = { version: 2, identity, metadata: document.metadata };
                    loaded.records.set(key, moved); loaded.recordPaths.set(key, destination);
                    loaded.originals.set(destination, undefined);
                    migrations.push(this.recordWrite(loaded, key, moved));
                }
                migrations.push({ filePath, text: undefined });
            }
        }
        for (const [key, document] of loaded.records) {
            if (document.identity.kind !== 'feature') { loaded.knownScenarioKeys.add(key); }
        }
        migrations.push(...planProjectOrganizationWrites(organization, loaded.groups, loaded.legacyImports));
        if (cleanSources) {
            for (const filePath of loaded.recordPaths.values()) {
                if (this.options.sourceTexts && !this.options.sourceTexts.has(filePath.slice(0, -'.kot.yml'.length))) { continue; }
                if (this.options.canCleanSource?.(filePath.slice(0, -'.kot.yml'.length)) === false) { continue; }
                if (filePath.endsWith('.kot.yml') && !migrations.some(write => write.filePath === filePath)) {
                    migrations.push({ filePath, text: loaded.originals.get(filePath) });
                }
            }
        }
        if (!isProjectSetupPending(this.rootPath)) { await this.commit(loaded, migrations); }
        return loaded;
    }
    private invalid(filePath: string, error: unknown): never {
        if (error instanceof ProjectLibraryStoreError) { throw error; }
        throw new ProjectLibraryStoreError(filePath, `Invalid project object (${error instanceof Error ? error.message : String(error)})`);
    }
    private snapshot(loaded: LoadedLibrary): ProjectLibrarySnapshot {
        return {
            groups: [...loaded.groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
            metadata: Object.fromEntries([...loaded.records].map(([key, value]) => [key, this.displayedMetadata(key, value)])),
            identities: Object.fromEntries([...loaded.records].map(([key, value]) => [key, value.identity])),
            legacyImports: loaded.legacyImports,
            knownScenarioKeys: [...loaded.knownScenarioKeys].sort()
        };
    }
    read(): Promise<ProjectLibrarySnapshot> { return this.serial(async () => this.snapshot(await this.load())); }
    /** Group choices do not require entity discovery, migration or the mutation queue. */
    async readGroups(): Promise<ProjectGroup[]> {
        try {
            const organization = await readProjectOrganization(this.rootPath, { originals: new Map(), guard: file => this.safePath(file),
                parseGroup: group, parseKey: scenarioLedgerKey, groupsOnly: true });
            return organization.groups.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        } catch (error) { return this.invalid(this.groupsPath, error); }
    }
    /** Reload known adjacent objects without rediscovering or parsing the source corpus. */
    readMetadata(): Promise<ProjectLibrarySnapshot> { return this.serial(async () => this.snapshot(await this.load(false))); }
    /** The scanner has already supplied all source identities and legacy-block snapshots. */
    readKnownSources(): Promise<ProjectLibrarySnapshot> { return this.serial(async () => this.snapshot(await this.load(false, true))); }
    private groupsWrites(loaded: LoadedLibrary): PendingWrite[] {
        const writes = planProjectOrganizationWrites(loaded.organization, loaded.groups, loaded.legacyImports);
        return writes;
    }
    private recordWrite(loaded: LoadedLibrary, key: string, document: MetadataDocument | undefined, preserveLocation = false): PendingWrite {
        const oldPath = loaded.recordPaths.get(key);
        const filePath = document === undefined || preserveLocation ? oldPath ?? this.metadataPath(key) : this.metadataFilePath(document.identity);
        if (document === undefined) { return { filePath, text: undefined }; }
        for (const [existingKey, existingPath] of loaded.recordPaths) {
            if (existingPath === filePath && existingKey !== key) { throw new ProjectLibraryStoreError(filePath, 'Metadata filename already belongs to a different entity identity'); }
        }
        const central = filePath === this.metadataPath(key);
        return { filePath, text: stringify(central ? { ...document, version: 1 } : {
            version: 2, identity: { kind: document.identity.kind, ...(document.identity.uid ? { uid: document.identity.uid } : {}) }, metadata: document.metadata
        }) };
    }
    private replacementWrites(loaded: LoadedLibrary, key: string, document: MetadataDocument): PendingWrite[] {
        const write = this.recordWrite(loaded, key, document);
        const oldPath = loaded.recordPaths.get(key);
        return oldPath && oldPath !== write.filePath ? [write, { filePath: oldPath, text: undefined }] : [write];
    }
    private async commit(loaded: LoadedLibrary, writes: readonly PendingWrite[], cleanSources = true): Promise<void> {
        const cleanup = await mapWithConcurrencyLimit(cleanSources ? writes.filter(write => write.filePath.endsWith('.kot.yml') && write.text !== undefined) : [], 16, async write => {
            const filePath = write.filePath.slice(0, -'.kot.yml'.length);
            if (!/\.ya?ml$/iu.test(filePath) || this.options.canCleanSource?.(filePath) === false) { return undefined; }
            if (this.options.sourceTexts && !this.options.sourceTexts.has(filePath)) { return undefined; }
            await this.safePath(filePath);
            const source = loaded.originals.get(filePath) ?? this.options.sourceTexts?.get(filePath) ?? await readOptional(filePath);
            if (source === undefined || !/^KOTМетаданные\s*:/mu.test(source)) { return undefined; }
            const sidecar = parseProjectMetadataSidecar(write.text!, write.filePath, this.rootPath);
            const yaml = ScenarioYamlDocument.parse(source);
            const uid = yaml.findField(sidecar.identity.kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеСценария', 'UID');
            if (uid?.ambiguous || (sidecar.identity.uid && String(uid?.value ?? '').toLowerCase() !== sidecar.identity.uid.toLowerCase())) { return undefined; }
            const text = removeMigratedKotMetadata(source);
            if (text === source) { return undefined; }
            if (!loaded.originals.has(filePath)) { loaded.originals.set(filePath, source); }
            return { filePath, text };
        });
        const uniqueWrites = new Map<string, PendingWrite>();
        for (const write of [...writes, ...cleanup.filter((write): write is NonNullable<typeof write> => !!write)]) {
            const previous = uniqueWrites.get(write.filePath);
            if (previous && previous.text !== write.text) { throw new ProjectLibraryStoreError(write.filePath, 'Conflicting writes for the same project metadata filename'); }
            uniqueWrites.set(write.filePath, write);
        }
        const changed = [...uniqueWrites.values()].filter(write => write.text !== loaded.originals.get(write.filePath));
        if (changed.length === 0) { return; }
        const formatToken = this.operationFormat?.token;
        assertProjectTransitionBranch(this.rootPath);
        if (!this.operationFormat) { throw new Error('Project metadata operation has no format baseline'); }
        assertProjectFormatUnchanged(this.rootPath, this.operationFormat);
        assertProjectFormat3(this.rootPath, formatToken);
        this.options.beforeWrite?.(changed.map(write => write.filePath));
        const prepared: { write: PendingWrite; temporary?: string }[] = [];
        const applied: PendingWrite[] = [];
        const originals = new Map(loaded.originals);
        const guard = async () => {
            assertProjectTransitionBranch(this.rootPath);
            assertProjectFormat3(this.rootPath, formatToken);
            if (cleanup.some(write => write && this.options.canCleanSource?.(write.filePath) === false)) {
                throw new ProjectLibraryStoreError(this.rootPath, 'Source changed in an editor during metadata migration');
            }
            this.options.beforeWrite?.(changed.map(write => write.filePath));
            await mapWithConcurrencyLimit([...loaded.originals], 32, async ([filePath, original]) => {
                if (await readOptional(filePath) !== original) { throw new ProjectLibraryStoreError(filePath, 'Project library write conflict; reload current objects'); }
            });
            await this.safePaths(changed.map(write => write.filePath));
            await mapWithConcurrencyLimit(changed, 32, async write => {
                if (!loaded.originals.has(write.filePath) && await readOptional(write.filePath) !== undefined) { throw new ProjectLibraryStoreError(write.filePath, 'Project library write conflict; object was created externally'); }
            });
        };
        try {
            let preparedCount = 0;
            this.options.onProgress?.({ label: 'Preparing project metadata…', completed: 0, total: changed.length });
            assertProjectFormat3(this.rootPath, formatToken);
            await this.safePaths(changed.map(write => write.filePath));
            await mapWithConcurrencyLimit(changed, 16, async write => {
                if (this.excludedPath(write.filePath)) { throw new ProjectLibraryStoreError(write.filePath, 'Project metadata belongs to another nested project root'); }
                await fs.mkdir(path.dirname(write.filePath), { recursive: true });
                if (write.text === undefined) { prepared.push({ write }); }
                else {
                    const temporary = `${write.filePath}.${randomUUID()}.tmp`;
                    prepared.push({ write, temporary });
                    await fs.writeFile(temporary, write.text, { encoding: 'utf8', flag: 'wx' });
                }
                this.options.onProgress?.({ label: 'Preparing project metadata…', completed: ++preparedCount, total: changed.length });
            });
            this.options.onProgress?.({ label: 'Checking project metadata before writing…' });
            await guard();
            this.options.onProgress?.({ label: 'Writing project metadata…', completed: 0, total: changed.length });
            const cleanupPaths = new Set(cleanup.filter((write): write is NonNullable<typeof write> => !!write).map(write => write.filePath));
            // Persist sidecars before removing old objects, and only then clean their source blocks.
            for (const stage of [prepared.filter(item => item.temporary && !cleanupPaths.has(item.write.filePath)),
                prepared.filter(item => !item.temporary), prepared.filter(item => cleanupPaths.has(item.write.filePath))]) {
                await this.safePaths(stage.map(item => item.write.filePath));
                await mapWithConcurrencyLimit(stage, 16, async ({ write, temporary }) => {
                    assertProjectTransitionBranch(this.rootPath);
                    assertProjectFormat3(this.rootPath, formatToken);
                    if (temporary) { await fs.rename(temporary, write.filePath); }
                    else { await fs.unlink(write.filePath); }
                    applied.push(write);
                    loaded.originals.set(write.filePath, write.text);
                    this.options.onProgress?.({ label: 'Writing project metadata…', completed: applied.length, total: changed.length });
                });
            }
        } catch (error) {
            const failures: unknown[] = [];
            this.options.onProgress?.({ label: 'Restoring project metadata after an error…', completed: 0, total: applied.length });
            let restored = 0;
            for (const write of applied.reverse()) {
                try {
                    assertProjectTransitionBranch(this.rootPath);
                    assertProjectFormat3(this.rootPath, formatToken);
                    await this.safePath(write.filePath);
                    if (await readOptional(write.filePath) !== write.text) {
                        throw new ProjectLibraryStoreError(write.filePath, 'Cannot restore metadata changed externally during the failed write');
                    }
                    const original = originals.get(write.filePath);
                    if (original === undefined) { await fs.rm(write.filePath, { force: true }); }
                    else {
                        const temporary = `${write.filePath}.${randomUUID()}.tmp`;
                        try {
                            await fs.writeFile(temporary, original, { encoding: 'utf8', flag: 'wx' });
                            await fs.rename(temporary, write.filePath);
                        } finally { await fs.rm(temporary, { force: true }); }
                    }
                    loaded.originals.set(write.filePath, original);
                    this.options.onProgress?.({ label: 'Restoring project metadata after an error…', completed: ++restored, total: applied.length });
                } catch (failure) { failures.push(failure); }
            }
            if (failures.length) { throw new AggregateError([error, ...failures], 'Project metadata write failed and some objects could not be restored'); }
            throw error;
        } finally {
            await Promise.all(prepared.filter(item => item.temporary).map(item => fs.rm(item.temporary!, { force: true })));
        }
    }
    ensureGroup(name: string, section: ProjectSection, preferredId?: string): Promise<ProjectGroup> {
        return this.serial(async () => {
            const normalizedName = textField(name, 'group name').trim();
            if (!sections.includes(section)) { throw new Error('Unsupported group section'); }
            const loaded = await this.load();
            const existing = loaded.groups.find(item => item.name === normalizedName && sameGroupFamily(item, [section]));
            if (existing) {
                if (existing.sections.includes(section)) { return existing; }
                const updated = { ...existing, sections: sections.filter(value => value === section || existing.sections.includes(value)) };
                loaded.groups = loaded.groups.map(item => item.id === existing.id ? updated : item);
                await this.commit(loaded, this.groupsWrites(loaded));
                return updated;
            }
            const id = preferredId ? textField(preferredId, 'group id') : randomUUID();
            if (loaded.groups.some(item => item.id === id)) { throw new Error('Group ID already exists'); }
            const created: ProjectGroup = { id, name: normalizedName, sections: [section], order: Math.max(-1, ...loaded.groups.map(item => item.order)) + 1 };
            loaded.groups.push(created);
            await this.commit(loaded, this.groupsWrites(loaded));
            return created;
        });
    }
    renameGroup(id: string, name: string): Promise<ProjectGroup> {
        return this.serial(async () => {
            const loaded = await this.load();
            const existing = loaded.groups.find(item => item.id === id);
            if (!existing) { throw new Error('Project group no longer exists'); }
            const normalizedName = textField(name, 'group name').trim();
            if (loaded.groups.some(item => item.id !== id && item.name === normalizedName && sameGroupFamily(item, existing.sections))) { throw new Error('A group with this name already exists'); }
            const updated = { ...existing, name: normalizedName };
            loaded.groups = loaded.groups.map(item => item.id === id ? updated : item);
            await this.commit(loaded, this.groupsWrites(loaded));
            return updated;
        });
    }
    deleteGroup(id: string): Promise<void> {
        return this.serial(async () => {
            const loaded = await this.load();
            if (!loaded.groups.some(item => item.id === id)) { return; }
            loaded.groups = loaded.groups.filter(item => item.id !== id);
            const writes = this.groupsWrites(loaded);
            for (const [key, document] of loaded.records) {
                if (document.metadata.groupId === id) { writes.push(this.recordWrite(loaded, key, { ...document, metadata: { ...document.metadata, groupId: '' } }, true)); }
            }
            await this.commit(loaded, writes);
        });
    }
    setMetadata(identity: ProjectEntityIdentity, patch: ProjectEntityMetadataPatch): Promise<void> {
        return this.serial(async () => {
            const normalizedIdentity = portableIdentity(identity);
            const key = projectEntityKey(normalizedIdentity);
            const supplied = record(patch, 'metadata patch');
            allowedFields(supplied, metadataFields, 'metadata patch');
            const loaded = await this.load();
            const actualSource = await this.sourceIdentity(path.join(this.rootPath, normalizedIdentity.relativePath), loaded.originals);
            if (actualSource && (actualSource.kind !== normalizedIdentity.kind || actualSource.uid !== normalizedIdentity.uid)) {
                throw new ProjectLibraryStoreError(this.metadataFilePath(normalizedIdentity), 'Metadata identity does not match its source UID or kind');
            }
            const existing = loaded.records.get(key);
            const merged: Record<string, unknown> = { ...existing?.metadata };
            for (const [field, value] of Object.entries(supplied)) {
                if (field === 'order') { continue; }
                if (value === null) { delete merged[field]; }
                else if (value !== undefined) { merged[field] = value; }
            }
            const validated = metadata(merged);
            if (validated.groupId && !loaded.groups.some(item => item.id === validated.groupId)) { throw new Error('Project metadata references a missing group'); }
            const hasOrder = supplied.order !== undefined;
            if (hasOrder && supplied.order !== null && (typeof supplied.order !== 'number' || !Number.isFinite(supplied.order) || supplied.order < 0)) {
                throw new Error('Display order must be a finite nonnegative number.');
            }
            const hasSharedPatch = Object.entries(supplied).some(([field, value]) => field !== 'order' && value !== undefined);
            const writes = (hasSharedPatch || !hasOrder) && (!existing || JSON.stringify(existing.metadata) !== JSON.stringify(validated)
                || JSON.stringify(existing.identity) !== JSON.stringify(normalizedIdentity))
                ? this.replacementWrites(loaded, key, { version: 2, identity: normalizedIdentity, metadata: validated }) : [];
            if (writes.length && normalizedIdentity.kind !== 'feature') {
                loaded.knownScenarioKeys.add(key);
            }
            const display = this.displayOrder(); const section = this.entitySection(normalizedIdentity);
            const before = display.capture(this.rootPath, section);
            if (hasOrder) {
                const initial = [...loaded.records].filter(([, value]) => this.entitySection(value.identity) === section
                    && (value.metadata.groupId ?? '') === (validated.groupId ?? ''))
                    .map(([memberKey, value]) => ({ key: memberKey, order: display.rank(this.rootPath, section, validated.groupId ?? '', memberKey, value.metadata.order) ?? null }));
                await display.set(this.rootPath, section, validated.groupId ?? '', key, supplied.order as number | null, initial);
            }
            try { await this.commit(loaded, writes); }
            catch (error) { if (hasOrder) { await display.restore(this.rootPath, section, before); } throw error; }
        });
    }
    /** Shared membership changes one record; all display positions are personal workspace state. */
    moveEntity(section: ProjectSection, identity: ProjectEntityIdentity, groupId: string, beforeKey: string | undefined,
        expectedSource: readonly ProjectEntityOrderState[], expectedDestination: readonly ProjectEntityOrderState[]): Promise<ProjectLibrarySnapshot> {
        return this.serial(async () => {
            const normalized = portableIdentity(identity);
            const requiredKind = section === 'standalone' ? 'feature' : section === 'process' ? 'process' : section === 'main' ? 'scenario' : undefined;
            if (!requiredKind || normalized.kind !== requiredKind) { throw new Error('The ordering target belongs to a different section.'); }
            const loaded = await this.load(this.options.sourceIdentities === undefined);
            const key = projectEntityKey(normalized);
            if (requiredKind === 'feature') {
                for (const candidate of this.options.sourceIdentities ?? []) {
                    const portable = portableIdentity(candidate);
                    const candidateKey = projectEntityKey(portable);
                    if (portable.kind === 'feature' && !loaded.records.has(candidateKey)) {
                        const owner = await this.sourceIdentity(path.join(this.rootPath, portable.relativePath), loaded.originals);
                        if (!owner || projectEntityKey(owner) !== candidateKey) { throw new Error('A feature source no longer exists.'); }
                        loaded.records.set(candidateKey, { version: 2, identity: portable, metadata: {} });
                    }
                }
            }
            const source = loaded.records.get(key);
            const actual = await this.sourceIdentity(path.join(this.rootPath, normalized.relativePath), loaded.originals);
            if (!source || !actual || projectEntityKey(actual) !== key || actual.kind !== normalized.kind
                || source.identity.relativePath !== normalized.relativePath || (requiredKind !== 'feature' && !Object.hasOwn(source.metadata, 'groupId'))) {
                throw new Error('The source changed or no longer belongs to this project group.');
            }
            const sourceGroupId = source.metadata.groupId ?? '';
            if (typeof groupId !== 'string' || (groupId && !loaded.groups.some(group => group.id === groupId && group.sections.includes(section)))) {
                throw new Error('The ordering group no longer exists in this project section.');
            }
            const validate = (expected: readonly ProjectEntityOrderState[], owner: string): string[] => {
                const members = [...loaded.records].filter(([, value]) => value.identity.kind === requiredKind
                    && (requiredKind === 'feature' || Object.hasOwn(value.metadata, 'groupId')) && (value.metadata.groupId ?? '') === owner);
                if (!Array.isArray(expected) || expected.length !== members.length
                    || new Set(expected.map(value => value?.key)).size !== expected.length) {
                    throw new Error('The group contents changed. Refresh the panel and try again.');
                }
                const memberMap = new Map(members);
                for (const value of expected) {
                    const document = value && memberMap.get(value.key);
                    if (!document || value.order !== (this.displayOrder().rank(this.rootPath, section, owner, value.key, document.metadata.order) ?? null)) {
                        throw new Error('The group contents changed. Refresh the panel and try again.');
                    }
                }
                return expected.map(value => value.key);
            };
            const sourceKeys = validate(expectedSource, sourceGroupId);
            const targetKeys = validate(expectedDestination, groupId);
            if (!sourceKeys.includes(key) || (beforeKey !== undefined && !targetKeys.includes(beforeKey))) {
                throw new Error('The ordering item no longer belongs to its target group.');
            }
            if (beforeKey === key) { return this.snapshot(loaded); }
            const display = this.displayOrder(); const before = display.capture(this.rootPath, section);
            await display.move(this.rootPath, section, sourceGroupId, groupId, key, beforeKey, sourceKeys, targetKeys);
            const writes: PendingWrite[] = [];
            if (sourceGroupId !== groupId) {
                const updated = { ...source, metadata: { ...source.metadata, groupId } };
                writes.push(this.recordWrite(loaded, key, updated, loaded.recordPaths.has(key)));
                loaded.records.set(key, updated);
            }
            try { await this.commit(loaded, writes, false); }
            catch (error) { await display.restore(this.rootPath, section, before); throw error; }
            return this.snapshot(loaded);
        });
    }
    deleteMetadata(identity: ProjectEntityIdentity): Promise<void> {
        return this.serial(async () => {
            const normalizedIdentity = portableIdentity(identity);
            const key = projectEntityKey(normalizedIdentity);
            const loaded = await this.load();
            const writes: PendingWrite[] = [];
            if (normalizedIdentity.kind !== 'feature') { loaded.knownScenarioKeys.add(key); writes.push(...projectDeletionHistoryWrite(loaded.organization, key)); }
            if (loaded.records.has(key)) { writes.push(this.recordWrite(loaded, key, undefined)); }
            await this.commit(loaded, writes);
        });
    }
    /** Explicit filesystem renames may replace metadata retained for a deleted destination file. */
    remapEntity(oldIdentity: ProjectEntityIdentity, newIdentity: ProjectEntityIdentity, overwriteTarget = false): Promise<void> {
        return this.serial(async () => {
            const oldKey = projectEntityKey(oldIdentity);
            const normalizedIdentity = portableIdentity(newIdentity);
            const newKey = projectEntityKey(normalizedIdentity);
            const loaded = await this.load();
            const oldRecord = loaded.records.get(oldKey);
            if (!oldRecord) {
                await this.displayOrder().remap(this.rootPath, this.entitySection(oldIdentity), oldKey, newKey);
                return;
            }
            const existing = loaded.records.get(newKey);
            const writes = this.replacementWrites(loaded, newKey, { version: 2, identity: normalizedIdentity,
                metadata: overwriteTarget ? oldRecord.metadata : existing?.metadata ?? oldRecord.metadata });
            const oldPath = loaded.recordPaths.get(oldKey);
            if (oldPath && !writes.some(write => write.filePath === oldPath)) { writes.push({ filePath: oldPath, text: undefined }); }
            if (oldRecord.identity.kind !== 'feature') { loaded.knownScenarioKeys.add(oldKey); }
            if (normalizedIdentity.kind !== 'feature') { loaded.knownScenarioKeys.add(newKey); }
            if (oldRecord.identity.kind !== 'feature' && oldKey !== newKey) { writes.push(...projectDeletionHistoryWrite(loaded.organization, oldKey)); }
            const display = this.displayOrder(); const section = this.entitySection(oldRecord.identity);
            const previous = display.capture(this.rootPath, section);
            await display.remap(this.rootPath, section, oldKey, newKey);
            try { await this.commit(loaded, writes); }
            catch (reason) { await display.restore(this.rootPath, section, previous); throw reason; }
        });
    }
    /** Seeds a single legacy editor document without marking the rest of the project as migrated. */
    seedLegacyEntity(identity: ProjectEntityIdentity, legacyMetadata: ProjectEntityMetadata,
        groupSeed?: { readonly name: string; readonly section: ProjectSection }): Promise<void> {
        return this.seedLegacyEntities([{ identity, metadata: legacyMetadata, groupSeed }]).then(() => undefined);
    }
    /** Seed newly discovered definitions together instead of reloading the project for each item. */
    seedLegacyEntities(entities: readonly { identity: ProjectEntityIdentity; metadata: ProjectEntityMetadata;
        groupSeed?: { readonly name: string; readonly section: ProjectSection } }[]): Promise<ProjectLibrarySnapshot> {
        return this.serial(async () => {
            const loaded = await this.load(this.options.sourceTexts === undefined);
            const writes: PendingWrite[] = [];
            let groupsChanged = false;
            for (const { identity, metadata: legacyMetadata, groupSeed } of entities) {
                const normalizedIdentity = portableIdentity(identity);
                const key = projectEntityKey(normalizedIdentity);
                if (loaded.records.has(key) || loaded.knownScenarioKeys.has(key)) { continue; }
                let seededMetadata = metadata(legacyMetadata);
                if (groupSeed) {
                    const name = textField(groupSeed.name, 'group name').trim();
                    const section = groupSeed.section;
                    if (!sections.includes(section)) { throw new Error('Unsupported group section'); }
                    const existing = loaded.groups.find(item => item.name === name && sameGroupFamily(item, [section]));
                    let seededGroup: ProjectGroup;
                    if (existing) {
                        seededGroup = { ...existing, sections: sections.filter(value => value === section || existing.sections.includes(value)) };
                        loaded.groups = loaded.groups.map(item => item.id === existing.id ? seededGroup : item);
                    } else {
                        seededGroup = { id: randomUUID(), name, sections: [section],
                            order: Math.max(-1, ...loaded.groups.map(item => item.order)) + 1 };
                        loaded.groups.push(seededGroup);
                    }
                    seededMetadata = { ...seededMetadata, groupId: seededGroup.id };
                }
                if (seededMetadata.groupId && !loaded.groups.some(item => item.id === seededMetadata.groupId)) {
                    throw new Error('Legacy metadata references a missing group');
                }
                writes.push(this.recordWrite(loaded, key, { version: 2, identity: normalizedIdentity, metadata: seededMetadata }));
                loaded.records.set(key, { version: 2, identity: normalizedIdentity, metadata: seededMetadata });
                if (normalizedIdentity.kind !== 'feature') { loaded.knownScenarioKeys.add(key); }
                groupsChanged ||= !!groupSeed;
            }
            if (groupsChanged) { writes.push(...this.groupsWrites(loaded)); }
            await this.commit(loaded, writes);
            return this.snapshot(loaded);
        });
    }
    importLegacy(input: ProjectLibraryImport, scope: ProjectLegacyImportScope = 'scenario'): Promise<ProjectLibrarySnapshot> {
        return this.serial(async () => {
            if (!importScopes.includes(scope)) { throw new Error('Unsupported legacy import scope'); }
            const importedKeys = new Map<string, ProjectEntityIdentity>();
            for (const entity of input.entities) {
                const identity = portableIdentity(entity.identity);
                const key = projectEntityKey(identity);
                const previous = importedKeys.get(key);
                if (previous && (previous.relativePath !== identity.relativePath || previous.kind !== identity.kind)) {
                    throw new Error(`Duplicate project entity UID: ${previous.relativePath}; ${identity.relativePath}`);
                }
                importedKeys.set(key, identity);
            }
            const loaded = await this.load(this.options.sourceTexts === undefined);
            if (loaded.legacyImports.includes(scope)) { return this.snapshot(loaded); }
            const groupIds = new Map<string, string>();
            for (const importedValue of input.groups) {
                const imported = group(importedValue);
                const existing = loaded.groups.find(item => item.id === imported.id) ?? loaded.groups.find(item => item.name === imported.name && sameGroupFamily(item, imported.sections));
                if (existing) {
                    groupIds.set(imported.id, existing.id);
                    if (sameGroupFamily(existing, imported.sections)) {
                        const updated = { ...existing, sections: sections.filter(value => existing.sections.includes(value)
                            || imported.sections.includes(value)) };
                        loaded.groups = loaded.groups.map(item => item.id === existing.id ? updated : item);
                    }
                }
                else { loaded.groups.push(imported); groupIds.set(imported.id, imported.id); }
            }
            const writes: PendingWrite[] = [];
            for (const imported of input.entities) {
                const identity = portableIdentity(imported.identity);
                const key = projectEntityKey(identity);
                if (loaded.records.has(key) || loaded.knownScenarioKeys.has(key)) { continue; }
                const importedMetadata = metadata(imported.metadata);
                const groupId = importedMetadata.groupId ? groupIds.get(importedMetadata.groupId) ?? importedMetadata.groupId : importedMetadata.groupId;
                if (groupId && !loaded.groups.some(item => item.id === groupId)) { throw new Error('Legacy metadata references a missing group'); }
                const document: MetadataDocument = { version: 2, identity, metadata: { ...importedMetadata, ...(groupId !== undefined ? { groupId } : {}) } };
                loaded.records.set(key, document);
                if (identity.kind !== 'feature') { loaded.knownScenarioKeys.add(key); }
                writes.push(this.recordWrite(loaded, key, document));
            }
            loaded.legacyImports = importScopes.filter(value => value === scope || loaded.legacyImports.includes(value));
            writes.push(...this.groupsWrites(loaded));
            await this.commit(loaded, writes);
            return this.snapshot(loaded);
        });
    }
}
