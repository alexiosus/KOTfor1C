import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    buildInfobaseConnectionArgument, normalizeInfobaseReference, parseInfobaseConnectionString
} from './oneCInfobaseConnection';
import { findObjectKeyByAlias, getVanessaParameterAliases, type JsonValue } from './vanessaLaunchJson';

export interface VanessaDebugClient {
    readonly id: string;
    readonly name: string;
    readonly infobase: string;
    readonly username: string;
    readonly password: string;
    readonly synonym: string;
    readonly clientType: string;
    readonly computerName: string;
    readonly port: number;
    readonly additionalParameters: string;
}

export interface VanessaDebugClientSelection {
    readonly mode: 'clients' | 'scenario';
    readonly clients: readonly VanessaDebugClient[];
}

interface DebugClientWorkspaceState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

interface DebugClientSecretStorage {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
}

type StoredDebugClient = Omit<VanessaDebugClient, 'password' | 'additionalParameters'>;
interface StoredDebugClientSelection {
    version: 1;
    mode: VanessaDebugClientSelection['mode'];
    clients: StoredDebugClient[];
    catalog?: StoredDebugClient[];
    secretsKey: string;
}
interface DebugClientSecrets {
    infobase: string;
    password: string;
    additionalParameters: string;
}

const STATE_KEY = 'kotTestToolkit.vanessaDebugClients.v1';
const storeWrites = new WeakMap<DebugClientWorkspaceState, Promise<unknown>>();

/** The workspace keeps connection identities; full strings and launch keys stay in SecretStorage. */
export class VanessaDebugClientStore {
    constructor(private readonly state: DebugClientWorkspaceState, private readonly secrets: DebugClientSecretStorage) {}

    public async load(): Promise<VanessaDebugClientSelection | undefined> {
        return (await this.serialize(() => this.read())).selection;
    }

    public async loadCatalog(): Promise<readonly VanessaDebugClient[]> { return (await this.serialize(() => this.read())).catalog; }

    private async read(): Promise<{ selection?: VanessaDebugClientSelection; catalog: VanessaDebugClient[] }> {
        const stored = this.state.get<StoredDebugClientSelection>(STATE_KEY);
        if (!stored) { return { catalog: [] }; }
        if (stored.version !== 1 || !['clients', 'scenario'].includes(stored.mode) || !Array.isArray(stored.clients) ||
            stored.catalog !== undefined && !Array.isArray(stored.catalog)) {
            throw new Error('Saved debug clients are invalid.');
        }
        const payload = await this.secrets.get(stored.secretsKey);
        if (payload === undefined) { throw new Error('Saved debug client credentials are unavailable in secure storage.'); }
        let secretClients: Record<string, DebugClientSecrets>;
        try { secretClients = JSON.parse(payload) as Record<string, DebugClientSecrets>; }
        catch { throw new Error('Saved debug client credentials are invalid.'); }
        if (!secretClients || typeof secretClients !== 'object' || Array.isArray(secretClients)) { throw new Error('Saved debug client credentials are invalid.'); }
        const catalog = (stored.catalog ?? stored.clients).map(saved => {
            const secure = saved && Object.hasOwn(secretClients, saved.id) ? secretClients[saved.id] : undefined;
            if (!secure || typeof secure.infobase !== 'string' || typeof secure.password !== 'string' || typeof secure.additionalParameters !== 'string') {
                throw new Error('Saved debug client credentials are invalid.');
            }
            return { ...saved, ...secure };
        });
        validateVanessaDebugClientSelection({ mode: 'scenario', clients: catalog });
        const clients = stored.clients.map(saved => {
            const actual = catalog.find(client => client.id === saved?.id);
            if (!actual) { throw new Error('Saved debug clients are invalid.'); }
            return actual;
        });
        const selection = { mode: stored.mode, clients };
        validateVanessaDebugClientSelection(selection);
        return { selection, catalog };
    }

    public async save(selection: VanessaDebugClientSelection): Promise<void> {
        validateVanessaDebugClientSelection(selection);
        const chosen = structuredClone(selection);
        await this.serialize(async () => {
            const before = await this.read(); const catalog = new Map(before.catalog.map(client => [client.id, client]));
            for (const client of chosen.clients) { catalog.set(client.id, client); }
            await this.persist(chosen, [...catalog.values()]);
        });
    }

    public async saveCatalog(clients: readonly VanessaDebugClient[]): Promise<void> {
        const catalog = structuredClone(clients);
        await this.updateCatalog(() => catalog);
    }

    /** Explicit recovery only, after the host confirms replacing ALL unavailable local catalog entries. */
    public async replaceUnavailableCatalog(selection: VanessaDebugClientSelection): Promise<void> {
        validateVanessaDebugClientSelection(selection); const selected = structuredClone(selection);
        await this.serialize(async () => {
            try { await this.read(); }
            catch { await this.persist(selected, selected.clients); return; }
            throw new Error('The saved client catalog is available again. Reload it before editing.');
        });
    }

    /** The mutation reads the latest catalog inside the shared write lock, including other store instances. */
    public async updateCatalog(update: (clients: readonly VanessaDebugClient[]) => readonly VanessaDebugClient[]): Promise<void> {
        await this.serialize(async () => {
            const before = await this.read(); const catalog = update(before.catalog);
            validateVanessaDebugClientSelection({ mode: 'scenario', clients: catalog });
            const byId = new Map(catalog.map(client => [client.id, client]));
            const clients = (before.selection?.clients ?? []).flatMap(client => {
                const updated = byId.get(client.id); return updated ? [updated] : [];
            });
            const mode = before.selection?.mode === 'clients' && clients.length ? 'clients' : 'scenario';
            await this.persist({ mode, clients }, catalog);
        });
    }

    private serialize<T>(work: () => Promise<T>): Promise<T> {
        const operation = (storeWrites.get(this.state) ?? Promise.resolve()).catch(() => undefined).then(work);
        storeWrites.set(this.state, operation);
        const clear = () => { if (storeWrites.get(this.state) === operation) { storeWrites.delete(this.state); } };
        void operation.then(clear, clear); return operation;
    }

    private async persist(selection: VanessaDebugClientSelection, catalog: readonly VanessaDebugClient[]): Promise<void> {
        validateVanessaDebugClientSelection({ mode: 'scenario', clients: catalog });
        const previous = this.state.get<StoredDebugClientSelection>(STATE_KEY);
        const secretsKey = `${STATE_KEY}.${randomUUID()}`;
        const secretClients: Record<string, DebugClientSecrets> = Object.create(null) as Record<string, DebugClientSecrets>;
        const storedCatalog = catalog.map(client => {
            const { password, additionalParameters, infobase } = client;
            secretClients[client.id] = { password, additionalParameters, infobase };
            return {
                id: client.id, name: client.name, username: client.username, synonym: client.synonym,
                clientType: client.clientType, computerName: client.computerName, port: client.port,
                infobase: normalizeInfobaseReference(infobase)
            };
        });
        await this.secrets.store(secretsKey, JSON.stringify(secretClients));
        try {
            const ids = selection.clients.map(client => client.id);
            const clients = ids.map(id => storedCatalog.find(client => client.id === id)!);
            await this.state.update(STATE_KEY, { version: 1, mode: selection.mode, clients, catalog: storedCatalog, secretsKey });
        } catch (error) {
            await Promise.resolve(this.secrets.delete(secretsKey)).catch(() => undefined);
            throw error;
        }
        if (previous?.secretsKey) {
            await Promise.resolve(this.secrets.delete(previous.secretsKey)).catch(() => undefined);
        }
    }
}

export function validateVanessaDebugClientSelection(selection: VanessaDebugClientSelection): void {
    if (selection.mode === 'clients' && selection.clients.length === 0) { throw new Error('A debug client set must have at least one client.'); }
    const names = new Set<string>();
    const ids = new Set<string>();
    const ports = new Set<string>();
    for (const client of selection.clients) {
        const name = client.name.trim().toLowerCase();
        const connection = parseInfobaseConnectionString(client.infobase);
        if (!connection && /(?:^|;)\s*(?:File|Srvr|Ref|Usr|Pwd|Password)\s*=/iu.test(client.infobase)) {
            throw new Error('The debug client connection string is incomplete.');
        }
        if (!name || names.has(name) || !client.id || ids.has(client.id) || !client.infobase.trim() || connection?.kind === 'web') {
            throw new Error('Debug client names and connections must be valid and unique.');
        }
        const portIdentity = `${client.computerName.trim().toLowerCase()}:${client.port}`;
        if (!Number.isInteger(client.port) || client.port < 1 || client.port > 65535 || ports.has(portIdentity)) {
            throw new Error('Debug clients must use distinct valid ports on each computer.');
        }
        names.add(name); ids.add(client.id); ports.add(portIdentity);
    }
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function aliases(key: string): Set<string> {
    return new Set(getVanessaParameterAliases(key).map(alias => alias.toLowerCase()));
}

const RUN_SECTION_KEYS = new Set([
    ...getVanessaParameterAliases('RunningScripts'), ...getVanessaParameterAliases('TestClient'), 'MainSettings', 'ОсновныеНастройки'
].map(key => key.toLowerCase()));
const SAFETY_KEYS = new Set([
    ...getVanessaParameterAliases('ExecuteScenarios'), ...getVanessaParameterAliases('CloseSystemOnComplete'),
    ...getVanessaParameterAliases('CloseTestClientAfterScenarioRun')
].map(key => key.toLowerCase()));

function debugSettingContainers(root: Record<string, JsonValue>): Record<string, JsonValue>[] {
    const containers = [root];
    for (const [key, value] of Object.entries(root)) {
        const section = object(value);
        if (section && RUN_SECTION_KEYS.has(key.trim().toLowerCase())) {
            containers.push(...debugSettingContainers(section));
        }
    }
    return containers;
}

function quoteConnectionValue(value: string): string { return `"${value.replace(/"/gu, '""')}"`; }

function clientConnection(client: VanessaDebugClient): string {
    const parsed = parseInfobaseConnectionString(client.infobase);
    // Vanessa converts these fields to /F or /S and also treats the file value as a directory.
    // Its parser does not accept authentication properties in PathToInfobase.
    if (parsed?.kind === 'server') { return `Srvr=${quoteConnectionValue(parsed.server)};Ref=${quoteConnectionValue(parsed.ref)};`; }
    return buildInfobaseConnectionArgument(parsed ?? client.infobase, {
        trailingSemicolon: true, forceQuotedFilePath: true
    });
}

export function getVanessaDebugClientAuthentication(client: Pick<VanessaDebugClient, 'infobase' | 'username' | 'password'>): { username?: string; password?: string } {
    let username: string | undefined; let password: string | undefined;
    if (client.username || client.password) { username = client.username; password = client.password; }
    else if (parseInfobaseConnectionString(client.infobase)) {
        // Consume whole quoted properties so semicolons and doubled quotes in passwords stay intact.
        const properties = /(?:^|;)\s*([^;=\s]+)\s*=\s*(?:"((?:[^"]|"")*)"|([^;]*))/gu;
        for (const match of client.infobase.matchAll(properties)) {
            const key = match[1].toLowerCase();
            const value = match[2] !== undefined ? match[2].replace(/""/gu, '"') : match[3].trim();
            if (['usr', 'user', 'username'].includes(key)) { username = value; }
            if (['pwd', 'password'].includes(key)) { password = value; }
        }
    }
    return { username, password };
}

function clientLaunchParameters(client: VanessaDebugClient): string {
    const { username, password } = getVanessaDebugClientAuthentication(client);
    const authentication = username !== undefined || password !== undefined
        ? `/N${quoteConnectionValue(username ?? '')} /P${quoteConnectionValue(password ?? '')}` : '';
    return [authentication, client.additionalParameters].filter(value => !!value.trim()).join(' ');
}

/** Only launch sections are edited; global variables and unrelated custom objects are business data. */
export function applyVanessaManualDebugOverlay(source: JsonValue, selection: VanessaDebugClientSelection): Record<string, JsonValue> {
    const root = object(structuredClone(source));
    if (!root) { throw new Error('Vanessa launch JSON must be an object.'); }
    validateVanessaDebugClientSelection(selection);
    const containers = debugSettingContainers(root);
    for (const section of containers) {
        for (const key of Object.keys(section)) {
            if (SAFETY_KEYS.has(key.trim().toLowerCase())) { section[key] = false; }
        }
    }
    root[findObjectKeyByAlias(root, 'ExecuteScenarios') ?? 'ExecuteScenarios'] = false;
    root[findObjectKeyByAlias(root, 'CloseSystemOnComplete') ?? 'CloseSystemOnComplete'] = false;
    if (selection.mode === 'scenario') { return root; }

    const clientListKeys = aliases('datatestclients');
    let targets = containers.flatMap(container => Object.keys(container)
        .filter(key => clientListKeys.has(key.trim().toLowerCase()))
        .map(key => ({ container, key })));
    if (targets.length === 0) {
        const sectionKey = findObjectKeyByAlias(root, 'TestClient') ?? 'TestClient';
        const section = object(root[sectionKey]) ?? {};
        root[sectionKey] = section;
        const russian = /[а-я]/iu.test(sectionKey);
        targets = [{ container: section, key: russian ? 'ДанныеКлиентовТестирования' : 'datatestclients' }];
    }
    for (const { container, key } of targets) {
        const existing = container[key];
        const authored = Array.isArray(existing) ? existing.map(object).filter((entry): entry is Record<string, JsonValue> => !!entry) : [];
        const russian = /[а-я]/iu.test(key);
        container[key] = selection.clients.map(client => {
            const previous = authored.find(entry => {
                const nameKey = findObjectKeyByAlias(entry, 'Name');
                return nameKey && String(entry[nameKey]).trim().toLowerCase() === client.name.trim().toLowerCase();
            });
            const entry: Record<string, JsonValue> = { ...previous };
            const values: Array<[string, JsonValue]> = [
                ['Name', client.name], ['Synonym', client.synonym], ['PathToInfobase', clientConnection(client)],
                ['ClientType', client.clientType], ['AddItionalParameters', clientLaunchParameters(client)],
                ['ComputerName', client.computerName], ['PortTestClient', client.port]
            ];
            for (const [field, value] of values) {
                const russianKey = getVanessaParameterAliases(field).find(alias => /[а-я]/iu.test(alias));
                const fieldAliases = aliases(field);
                const existingKeys = Object.keys(entry).filter(key => fieldAliases.has(key.trim().toLowerCase()));
                for (const key of existingKeys.length ? existingKeys : [russian ? russianKey ?? field : field]) {
                    entry[key] = value;
                }
            }
            return entry;
        });
    }
    return root;
}

export interface VanessaDebugRuntimeJson {
    readonly path: string;
    dispose(): Promise<void>;
}

/** A private, ignored runtime copy survives until the detached 1C process exits. */
export async function writeVanessaDebugRuntimeJson(runtimeRoot: string, name: string, content: JsonValue): Promise<VanessaDebugRuntimeJson> {
    const directory = path.join(runtimeRoot, 'debug-params');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await fs.writeFile(path.join(directory, '.gitignore'), '*\n', { mode: 0o600 });
    const safeName = name.replace(/[^a-zA-Z0-9_-]+/gu, '_').slice(0, 48) || 'debug';
    const sessionDirectory = await fs.mkdtemp(path.join(directory, `${safeName}_`));
    await fs.chmod(sessionDirectory, 0o700);
    const temporaryPath = path.join(sessionDirectory, 'VAParams.json.tmp');
    const runtimePath = path.join(sessionDirectory, 'VAParams.json');
    try {
        await fs.writeFile(temporaryPath, JSON.stringify(content, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporaryPath, runtimePath);
    } catch (error) {
        await fs.rm(sessionDirectory, { recursive: true, force: true });
        throw error;
    }
    return { path: runtimePath, dispose: () => fs.rm(sessionDirectory, { recursive: true, force: true }) };
}
