import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMap, parseDocument } from 'yaml';

export interface ProjectSystemFunction { name: string; uid: string }
export interface ProjectPropertyCatalogs {
    projects: string[];
    reportLevel1: string[];
    reportLevel2: string[];
    categories: string[];
    responsibles: string[];
    systemFunctions?: ProjectSystemFunction[];
}
export type ProjectPropertyCatalogKey = Exclude<keyof ProjectPropertyCatalogs, 'systemFunctions'>;
export interface ProjectPropertyCatalogStoreOptions {
    beforeWrite?: () => void | Promise<void>;
}
const keys: readonly ProjectPropertyCatalogKey[] = ['projects', 'reportLevel1', 'reportLevel2', 'categories', 'responsibles'];
const queues = new Map<string, Promise<unknown>>();

export function validatePropertyCatalogName(value: string): string {
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/u.test(value)) { throw new Error('Catalog name must be a nonempty single-line string.'); }
    return value.trim();
}

/** Serialize all writers to a physical file, including separate store instances. */
export function serializePropertyCatalogWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(file);
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    queues.set(key, tail);
    void tail.finally(() => { if (queues.get(key) === tail) { queues.delete(key); } });
    return result;
}

export async function readPropertyCatalogFile(file: string): Promise<string | undefined> {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
}

/** Atomic replacement with an optimistic guard against edits made outside this process. */
export async function writePropertyCatalogFile(file: string, text: string, expected: string | undefined, beforeWrite?: () => void | Promise<void>): Promise<void> {
    await beforeWrite?.();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
        await beforeWrite?.();
        if (await readPropertyCatalogFile(file) !== expected) { throw new Error('Property catalog write conflict: the file changed. Refresh and retry.'); }
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}

function parseCatalogs(text: string | undefined): { catalogs: ProjectPropertyCatalogs; document: ReturnType<typeof parseDocument> } {
    const document = parseDocument(text ?? 'version: 1\n');
    if (document.errors.length || !isMap(document.contents)) { throw new Error('Invalid or ambiguous property catalog YAML.'); }
    const data = document.toJS() as Record<string, unknown>;
    if (data.version !== 1) { throw new Error('Unsupported property catalog version.'); }
    if (Object.keys(data).some(key => key !== 'version' && key !== 'systemFunctions' && !keys.includes(key as ProjectPropertyCatalogKey))) { throw new Error('Unsupported property catalog field.'); }
    const catalogs: ProjectPropertyCatalogs = { projects: [], reportLevel1: [], reportLevel2: [], categories: [], responsibles: [] };
    for (const key of keys) {
        const values = data[key] ?? [];
        if (!Array.isArray(values)) { throw new Error(`Property catalog ${key} must contain an array of names.`); }
        const normalized = values.map(value => validatePropertyCatalogName(value));
        if (new Set(normalized.map(value => value.toLocaleLowerCase())).size !== normalized.length) { throw new Error(`Duplicate names in property catalog ${key}.`); }
        catalogs[key] = normalized;
    }
    if (Object.hasOwn(data, 'systemFunctions')) { catalogs.systemFunctions = validateSystemFunctions(data.systemFunctions); }
    return { catalogs, document };
}

function validateSystemFunctions(value: unknown): ProjectSystemFunction[] {
    if (!Array.isArray(value)) { throw new Error('System functions must contain an array of name/UID pairs.'); }
    const functions = value.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.uid !== 'string'
            || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(entry.uid.trim())) { throw new Error('System function UID must be a valid GUID.'); }
        return { name: validatePropertyCatalogName(entry.name), uid: entry.uid.trim().toLocaleLowerCase() };
    });
    if (new Set(functions.map(entry => entry.uid)).size !== functions.length) { throw new Error('Ambiguous duplicate system function UID in project catalog.'); }
    return functions;
}

/** Project catalogs are portable; system functions retain their stock compiler identities. */
export class ProjectPropertyCatalogStore {
    readonly filePath: string;
    private readonly root: string;
    constructor(root: string, private readonly options: ProjectPropertyCatalogStoreOptions = {}) {
        this.root = path.resolve(root);
        this.filePath = path.join(this.root, '.kot', 'property-catalogs.yml');
    }
    private async safePath(): Promise<void> {
        // A .kot symlink would silently write another project's catalog.
        for (const file of [path.join(this.root, '.kot'), this.filePath]) {
            try { if ((await fs.lstat(file)).isSymbolicLink()) { throw new Error('Property catalogs cannot use a symbolic link.'); } }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        }
    }
    async read(): Promise<ProjectPropertyCatalogs> {
        await this.safePath();
        return parseCatalogs(await readPropertyCatalogFile(this.filePath)).catalogs;
    }
    /** Append values found in saved scenarios, retaining curated entries and their identities. */
    async mergeDetected(values: Partial<ProjectPropertyCatalogs>): Promise<void> {
        return serializePropertyCatalogWrite(this.filePath, async () => {
            await this.safePath(); const original = await readPropertyCatalogFile(this.filePath);
            const { catalogs, document } = parseCatalogs(original);
            let changed = false;
            for (const key of keys) {
                const updated = [...catalogs[key]];
                for (const raw of values[key] ?? []) {
                    const name = validatePropertyCatalogName(raw);
                    if (!updated.some(old => old.toLocaleLowerCase() === name.toLocaleLowerCase())) { updated.push(name); }
                }
                if (updated.length !== catalogs[key].length) { document.set(key, updated); changed = true; }
            }
            const functions = [...catalogs.systemFunctions ?? []];
            for (const entry of validateSystemFunctions(values.systemFunctions ?? [])) {
                if (!functions.some(old => old.uid === entry.uid || old.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())) { functions.push(entry); }
            }
            if (functions.length !== (catalogs.systemFunctions?.length ?? 0)) { document.set('systemFunctions', functions); changed = true; }
            if (!changed) { return; }
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => {
                await this.safePath(); await this.options.beforeWrite?.();
            });
        });
    }
    async ensureSystemFunctions(legacy: readonly ProjectSystemFunction[]): Promise<ProjectSystemFunction[]> {
        return serializePropertyCatalogWrite(this.filePath, async () => {
            await this.safePath(); const original = await readPropertyCatalogFile(this.filePath);
            const { catalogs, document } = parseCatalogs(original);
            if (catalogs.systemFunctions !== undefined) { return catalogs.systemFunctions; }
            const functions = validateSystemFunctions(legacy); document.set('systemFunctions', functions);
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => {
                await this.safePath(); await this.options.beforeWrite?.();
            });
            return functions;
        });
    }
    async addSystemFunction(name: string, uid: string = randomUUID()): Promise<ProjectSystemFunction> {
        const entry = validateSystemFunctions([{ name, uid }])[0];
        return serializePropertyCatalogWrite(this.filePath, async () => {
            await this.safePath(); const original = await readPropertyCatalogFile(this.filePath);
            const { catalogs, document } = parseCatalogs(original); const functions = catalogs.systemFunctions ?? [];
            if (functions.some(value => value.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())) { throw new Error('A system function with this name already exists.'); }
            const updated = validateSystemFunctions([...functions, entry]); document.set('systemFunctions', updated);
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => {
                await this.safePath(); await this.options.beforeWrite?.();
            });
            return entry;
        });
    }
    async replaceSystemFunctions(entries: readonly ProjectSystemFunction[], expected: readonly ProjectSystemFunction[] | undefined): Promise<void> {
        const updated = validateSystemFunctions(entries); const before = expected === undefined ? undefined : validateSystemFunctions(expected);
        return serializePropertyCatalogWrite(this.filePath, async () => {
            await this.safePath(); const original = await readPropertyCatalogFile(this.filePath);
            const { catalogs, document } = parseCatalogs(original);
            if (JSON.stringify(catalogs.systemFunctions) !== JSON.stringify(before)) { throw new Error('System function catalog changed. Refresh and retry.'); }
            document.set('systemFunctions', updated);
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => {
                await this.safePath(); await this.options.beforeWrite?.();
            });
        });
    }
    async replace(key: ProjectPropertyCatalogKey, values: readonly string[], expected: readonly string[]): Promise<void> {
        if (!keys.includes(key)) { throw new Error('Unknown property catalog.'); }
        const updated = values.map(value => validatePropertyCatalogName(value));
        if (new Set(updated.map(value => value.toLocaleLowerCase())).size !== updated.length) { throw new Error('Duplicate names in property catalog.'); }
        return serializePropertyCatalogWrite(this.filePath, async () => {
            await this.safePath(); const original = await readPropertyCatalogFile(this.filePath);
            const { catalogs, document } = parseCatalogs(original);
            if (JSON.stringify(catalogs[key]) !== JSON.stringify(expected)) { throw new Error('Project catalog changed. Refresh and retry.'); }
            document.set(key, updated);
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => {
                await this.safePath(); await this.options.beforeWrite?.();
            });
        });
    }
    async add(key: ProjectPropertyCatalogKey, value: string): Promise<string> {
        const name = validatePropertyCatalogName(value);
        if (!keys.includes(key)) { return Promise.reject(new Error('Unknown property catalog.')); }
        return serializePropertyCatalogWrite(this.filePath, async () => {
            await this.safePath();
            const original = await readPropertyCatalogFile(this.filePath);
            const { catalogs, document } = parseCatalogs(original);
            const existing = catalogs[key].find(value => value.toLocaleLowerCase() === name.toLocaleLowerCase());
            if (existing) { return existing; }
            document.set(key, [...catalogs[key], name]);
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => {
                await this.safePath(); await this.options.beforeWrite?.();
            });
            return name;
        });
    }
}
