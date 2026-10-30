import { createHash, randomUUID } from 'node:crypto';
import { normalizeInfobaseConnectionIdentity, normalizeInfobaseReference } from './oneCInfobaseConnection';
import { getVanessaDebugClientAuthentication, type VanessaDebugClient, type VanessaDebugClientStore } from './vanessaDebugClients';
import { prepareVanessaClientProfile, sameVanessaClientProfile, VanessaClientControlError, type VanessaClientProfile, type VanessaRuntimeClients } from './vanessaControlClients';
import type { VanessaControlSnapshot } from './vanessaControlSession';

export interface VanessaInfobaseConnection {
    generation: number; ready: boolean; busy: boolean; read: boolean; write: boolean; connect: boolean; disconnect: boolean;
    connected?: boolean;
}
export function getVanessaInfobaseConnection(snapshot: Pick<VanessaControlSnapshot, 'generation' | 'status' | 'capabilities'>, busy: boolean): VanessaInfobaseConnection {
    const caps = snapshot.capabilities;
    // An unreadable execution state does not detach the MCP session or its clients.
    return { generation: snapshot.generation, ready: snapshot.status === 'ready',
        connected: !!caps && snapshot.status !== 'detached' && snapshot.status !== 'connecting', busy,
        read: !!caps?.clientProfilesRead.supported, write: !!caps?.clientProfilesWrite.supported,
        connect: !!caps?.clientConnect.supported, disconnect: !!caps?.clientDisconnect.supported };
}
export interface VanessaInfobaseClientPorts {
    connection(): VanessaInfobaseConnection;
    store: Pick<VanessaDebugClientStore, 'loadCatalog' | 'updateCatalog'>;
    run<T>(work: (runtime: VanessaRuntimeClients) => Promise<T>, generation: number): Promise<T>;
    autoAdd?(): boolean;
}
export type VanessaInfobaseClientFields = Pick<VanessaDebugClient, 'name' | 'username' | 'synonym' | 'clientType' | 'computerName' | 'port'>;
export type VanessaInfobaseClientEdit = VanessaInfobaseClientFields & Partial<Pick<VanessaDebugClient, 'password' | 'additionalParameters'>>;
export type VanessaInfobaseClientAction = 'add' | 'connect' | 'disconnect' | 'replace';
export type VanessaInfobaseClientState = 'local' | 'added' | 'connected' | 'outdated' | 'conflict' | 'unsupported' | 'unknown';
export interface VanessaInfobaseClientRow extends VanessaInfobaseClientFields {
    id: string; connected: boolean; hasPassword: boolean; hasAdditionalParameters: boolean; state: VanessaInfobaseClientState;
    remoteName?: string; replaceable: boolean; active: boolean; portUnsupported: boolean;
    remoteOnly?: boolean;
    remoteClientType?: string;
}
export interface VanessaInfobaseClientsView {
    connection: VanessaInfobaseConnection; rows: VanessaInfobaseClientRow[]; defaults: VanessaInfobaseClientFields;
    runtimeClients: Array<{ name: string; clientType: string }>;
    loading: boolean; pendingAction: string | null; error: string | null;
}
/** Host-only confirmation snapshot. Never serialize this private profile to a webview. */
export interface VanessaInfobaseReplacement { generation: number; profile: VanessaClientProfile }
export class VanessaInfobaseClientError extends Error {}
const error = (message: string) => new VanessaInfobaseClientError(message);
const sameBase = (left: string, right: string) => normalizeInfobaseConnectionIdentity(left) === normalizeInfobaseConnectionIdentity(right);
const fold = (value: string) => value.trim().toLocaleLowerCase();
interface ClientMatch { state: VanessaInfobaseClientState; profile?: VanessaClientProfile; replaceable?: boolean }
function clientLaunchSettings(connection: string, parameters: string) {
    const authentication = getVanessaDebugClientAuthentication({ infobase: connection, username: '', password: '' });
    const other: string[] = [];
    // Consume whole arguments so /N or /P inside another quoted value stays untouched.
    for (const token of parameters.match(/(?:[^\s"]+|"(?:[^"]|"")*")+/gu) ?? []) {
        const match = /^\/([NP])(?:"((?:[^"]|"")*)"|([^\s"]+))$/u.exec(token);
        if (!match) { other.push(token); continue; }
        const value = match[2] !== undefined ? match[2].replace(/""/gu, '"') : match[3];
        if (match[1] === 'N') { authentication.username = value; } else { authentication.password = value; }
    }
    return { username: authentication.username ?? '', password: authentication.password ?? '', additionalParameters: other.join(' ') };
}
function settingsMatch(client: VanessaDebugClient, row: VanessaClientProfile): boolean {
    const fields = prepareVanessaClientProfile(client).fields;
    const expected = clientLaunchSettings(fields.infobase_path, fields.additional_parameters);
    const actual = clientLaunchSettings(row.connection, row.additionalParameters);
    return sameBase(row.connection, client.infobase) && row.clientType === fields.client_type && fold(row.computerName) === fold(fields.computer_name) &&
        actual.username === expected.username && actual.password === expected.password &&
        actual.additionalParameters === expected.additionalParameters && row.synonym === fields.synonym;
}
/** Client name is the profile identity. Different names intentionally remain separate connections. */
export function reconcileVanessaClient(client: VanessaDebugClient, profiles: readonly VanessaClientProfile[]): ClientMatch {
    try { prepareVanessaClientProfile(client); } catch { return { state: 'unsupported' }; }
    const named = profiles.filter(row => fold(row.name) === fold(client.name));
    if (named.length > 1) { return { state: 'conflict' }; }
    const profile = named[0];
    if (profile) {
        if (!sameBase(profile.connection, client.infobase)) { return { state: 'conflict', profile, replaceable: !profile.connected }; }
        return { state: settingsMatch(client, profile) ? profile.connected ? 'connected' : 'added' : 'outdated', profile };
    }
    const names = [client.name, client.synonym].filter(Boolean).map(fold);
    const occupied = profiles.filter(row => [row.name, row.synonym].filter(Boolean).some(name => names.includes(fold(name))));
    return occupied.length ? { state: 'conflict' } : { state: 'local' };
}

/** Per-workspace shared catalog and live profiles. Automatic addition is optional and never connects or replaces profiles. */
export class VanessaInfobaseClients {
    private catalog: readonly VanessaDebugClient[] = [];
    private live: readonly VanessaClientProfile[] | undefined;
    private liveGeneration: number | undefined;
    private refreshing: Promise<void> | undefined;
    private pendingAction: string | null = null;
    private lastError: string | null = null;
    private disposed = false;
    private observed: VanessaInfobaseConnection | undefined;
    private readonly failedAutoAdds = new Set<string>();
    private readonly listeners = new Set<() => void>();
    constructor(private readonly ports: VanessaInfobaseClientPorts) {}
    onDidChange(listener: () => void) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
    private changed() { for (const listener of this.listeners) { listener(); } }
    dispose() { this.disposed = true; this.catalog = []; this.live = undefined; this.listeners.clear(); }
    connectionChanged(): void {
        const state = this.ports.connection(); const before = this.observed; this.observed = state;
        if (state.generation !== this.liveGeneration || !(state.connected ?? state.ready)) { this.live = undefined; }
        if (JSON.stringify({ ...before, busy: false }) !== JSON.stringify({ ...state, busy: false })) { this.changed(); }
        if (state.ready && state.read && (!before?.ready || before.generation !== state.generation)) { void this.refresh(); }
    }
    stateFor(infobase: string): VanessaInfobaseClientsView {
        const connection = this.ports.connection();
        const profiles = (connection.connected ?? connection.ready) && this.liveGeneration === connection.generation ? this.live : undefined;
        const active = profiles?.filter(profile => profile.connected);
        const rows: VanessaInfobaseClientRow[] = this.catalog.filter(client => sameBase(client.infobase, infobase)).map(client => {
            const authentication = getVanessaDebugClientAuthentication(client);
            const match: ClientMatch = profiles ? reconcileVanessaClient(client, profiles) : { state: 'unknown' };
            return { id: client.id, name: client.name, username: authentication.username ?? '', synonym: client.synonym,
                clientType: client.clientType, computerName: client.computerName, port: client.port,
                hasPassword: !!authentication.password, hasAdditionalParameters: !!client.additionalParameters,
                connected: ['added', 'connected', 'outdated'].includes(match.state) && !!match.profile?.connected, state: match.state, remoteName: match.profile?.name, replaceable: !!match.replaceable,
                active: ['added', 'connected', 'outdated'].includes(match.state) && active?.length === 1 && active[0] === match.profile, portUnsupported: true };
        });
        const suffix = (infobase.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? '').replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 64);
        const stem = 'TestClient' + (suffix ? '_' + suffix : ''); let name = stem; let index = 2; let port = 1538;
        while (this.catalog.some(row => fold(row.name) === fold(name))) { name = stem + '_' + index++; }
        while (port < 65535 && this.catalog.some(row => fold(row.computerName) === 'localhost' && row.port === port)) { port++; }
        for (const profile of profiles ?? []) {
            if (!sameBase(profile.connection, infobase) || rows.some(row => fold(row.name) === fold(profile.name))) { continue; }
            const user = /(?:^|\s)\/N(?:"((?:[^"\n]|"")*)"|([^\s]+))/u.exec(profile.additionalParameters);
            rows.push({ id: `live:${connection.generation}:${createHash('sha256').update(profile.name).digest('hex')}`, name: profile.name, username: user?.[1]?.replace(/""/gu, '"') ?? user?.[2] ?? '',
                synonym: profile.synonym, clientType: /^(?:Thick|Толстый)$/iu.test(profile.clientType) ? 'Thick' : 'Thin', remoteClientType: profile.clientType, computerName: profile.computerName, port: 0,
                remoteOnly: true, connected: profile.connected, hasPassword: false, hasAdditionalParameters: false,
                state: profile.connected ? 'connected' : 'added', replaceable: false, active: active?.length === 1 && active[0] === profile, portUnsupported: true });
        }
        const defaults = { name, username: '', synonym: '', clientType: 'Thin', computerName: 'localhost', port };
        const runtimeClients = (profiles ?? []).filter(row => row.connected && sameBase(row.connection, infobase)).map(row => ({ name: row.name, clientType: row.clientType }));
        return { connection, rows, defaults, runtimeClients, loading: !!this.refreshing, pendingAction: this.pendingAction, error: this.lastError };
    }
    async refresh(retryAutomaticAdds = false): Promise<void> {
        if (retryAutomaticAdds) { this.failedAutoAdds.clear(); }
        if (this.disposed || this.pendingAction) { return; }
        if (this.refreshing) { return this.refreshing; }
        const state = this.ports.connection();
        const before = JSON.stringify([this.catalog, this.live, this.lastError]);
        const operation = (async () => {
            try {
                let autoError: string | null = null;
                let catalog: readonly VanessaDebugClient[];
                try { catalog = await this.ports.store.loadCatalog(); }
                catch { throw error('Saved client credentials are unavailable. Use Connection settings → Saved Debug launch clients to re-enter them or explicitly replace the unavailable catalog.'); }
                if (this.disposed) { return; } this.catalog = catalog;
                if (state.ready && state.read && !state.busy) {
                    const profiles = await this.ports.run(async runtime => {
                        let current = await runtime.list();
                        await this.adoptObservedRenames(current, state.generation);
                        if (this.ports.autoAdd?.() && state.write) {
                            for (const client of this.catalog) {
                                if (reconcileVanessaClient(client, current).state !== 'local') { continue; }
                                const key = JSON.stringify([state.generation, client]);
                                if (this.failedAutoAdds.has(key)) { continue; }
                                if (this.disposed || this.ports.connection().generation !== state.generation) { throw error('The Vanessa session changed. Refresh the client list.'); }
                                const latest = (await this.ports.store.loadCatalog()).find(row => row.id === client.id);
                                if (JSON.stringify(latest) !== JSON.stringify(client)) { continue; }
                                try { await runtime.apply(client, true, null); current = await runtime.list(); }
                                catch (cause) {
                                    this.failedAutoAdds.add(key); autoError = this.safeError(cause);
                                    try { current = await runtime.list(); } catch { /* Preserve the last confirmed inventory. */ }
                                    break;
                                }
                            }
                        }
                        return current;
                    }, state.generation);
                    if (!this.disposed && this.ports.connection().generation === state.generation && this.ports.connection().ready) {
                        this.live = profiles; this.liveGeneration = state.generation;
                    }
                }
                this.lastError = autoError;
            } catch (cause) {
                const current = this.ports.connection();
                if (current.generation !== this.liveGeneration || !(current.connected ?? current.ready)) {
                    this.live = undefined; this.liveGeneration = undefined;
                }
                this.lastError = this.safeError(cause);
            }
        })();
        this.refreshing = operation;
        try { await operation; } finally { if (this.refreshing === operation) { this.refreshing = undefined; } if (before !== JSON.stringify([this.catalog, this.live, this.lastError])) { this.changed(); } }
    }
    async saveClient(infobase: string, id: string | undefined, input: VanessaInfobaseClientEdit): Promise<void> {
        const fields = this.fields(input);
        for (const value of [input.password, input.additionalParameters]) { if (value !== undefined && (typeof value !== 'string' || value.length > 65536 || value.includes('\u0000'))) { throw error('The saved client field is invalid.'); } }
        await this.mutate('save', async () => this.ports.store.updateCatalog(catalog => {
            const previous = id ? this.requireClient(catalog, infobase, id) : undefined;
            const authentication = previous ? getVanessaDebugClientAuthentication(previous) : {};
            const updated = { ...previous, id: previous?.id ?? randomUUID(), infobase: normalizeInfobaseReference(infobase),
                password: input.password ?? authentication.password ?? '', additionalParameters: input.additionalParameters ?? previous?.additionalParameters ?? '', ...fields };
            if (catalog.some(row => row.id !== updated.id && (fold(row.name) === fold(updated.name) ||
                fold(row.computerName) === fold(updated.computerName) && row.port === updated.port))) {
                throw error('Choose a distinct client name and port for this computer.');
            }
            return previous ? catalog.map(row => row.id === previous.id ? updated : row) : [...catalog, updated];
        }));
    }
    async saveRemoteClient(infobase: string, id: string): Promise<void> {
        const view = this.stateFor(infobase);
        const row = view.rows.find(value => value.id === id && value.remoteOnly);
        const observed = this.live?.find(value => value.name === row?.name && sameBase(value.connection, infobase));
        if (!row || !observed || !view.connection.ready || !view.connection.read) { throw error('The Vanessa session changed. Refresh the client list.'); }
        const generation = view.connection.generation;
        await this.ports.run(async runtime => {
            const current = (await runtime.list()).find(value => value.name === observed.name);
            if (!current || !sameVanessaClientProfile(current, observed)) { throw error('The Vanessa profile changed. Refresh the client list.'); }
        }, generation);
        if (this.ports.connection().generation !== generation || !this.ports.connection().ready) { throw error('The Vanessa session changed. Refresh the client list.'); }
        if (!/^(?:Thin|Thick|Тонкий|Толстый)$/iu.test(observed.clientType)) { throw error('This Vanessa client type cannot be saved in KOT.'); }
        const { username, password, additionalParameters } = clientLaunchSettings(observed.connection, observed.additionalParameters);
        let port = 1538;
        while (port < 65535 && this.catalog.some(value => fold(value.computerName) === fold(observed.computerName) && value.port === port)) { port++; }
        await this.saveClient(infobase, undefined, { ...view.defaults, port, name: observed.name, synonym: observed.synonym,
            clientType: row.clientType, computerName: observed.computerName, username, password, additionalParameters });
    }
    async editorFor(infobase: string, id: string): Promise<VanessaInfobaseClientEdit> {
        const row = this.requireClient(await this.ports.store.loadCatalog(), infobase, id);
        const authentication = getVanessaDebugClientAuthentication(row);
        return { name: row.name, username: authentication.username ?? '', synonym: row.synonym, clientType: row.clientType,
            computerName: row.computerName, port: row.port, password: authentication.password ?? '', additionalParameters: row.additionalParameters };
    }
    private async adoptObservedRenames(profiles: readonly VanessaClientProfile[], generation: number): Promise<void> {
        if (!this.live || this.liveGeneration !== generation) { return; }
        const renames = new Map<string, { name: string; before: VanessaDebugClient }>();
        for (const client of this.catalog) {
            if (profiles.some(row => fold(row.name) === fold(client.name))) { continue; }
            const before = this.live.find(row => fold(row.name) === fold(client.name));
            if (!before || !settingsMatch(client, before)) { continue; }
            const candidates = profiles.filter(row => !this.live!.some(old => fold(old.name) === fold(row.name)) &&
                !this.catalog.some(saved => fold(saved.name) === fold(row.name)) && sameVanessaClientProfile({ ...row, name: before.name }, before));
            if (candidates.length === 1) { renames.set(client.id, { name: candidates[0].name, before: client }); }
        }
        if (!renames.size) { return; }
        await this.ports.store.updateCatalog(rows => {
            if (this.disposed || this.ports.connection().generation !== generation || !this.ports.connection().ready) { throw error('The Vanessa session changed. Refresh the client list.'); }
            return rows.map(row => {
                const rename = renames.get(row.id);
                return rename && JSON.stringify(row) === JSON.stringify(rename.before) && !rows.some(other => other.id !== row.id && fold(other.name) === fold(rename.name))
                    ? { ...row, name: rename.name } : row;
            });
        });
        this.catalog = await this.ports.store.loadCatalog();
    }
    async removeClient(infobase: string, id: string): Promise<void> {
        await this.mutate('remove', async () => this.ports.store.updateCatalog(catalog => {
            this.requireClient(catalog, infobase, id); return catalog.filter(row => row.id !== id);
        }));
    }
    async readSecret(infobase: string, id: string, key: 'password' | 'additionalParameters'): Promise<string> {
        const row = this.requireClient(await this.ports.store.loadCatalog(), infobase, id);
        return key === 'password' ? getVanessaDebugClientAuthentication(row).password ?? '' : row.additionalParameters;
    }
    async setSecret(infobase: string, id: string, key: 'password' | 'additionalParameters', value: string): Promise<void> {
        if (!['password', 'additionalParameters'].includes(key) || typeof value !== 'string' || value.length > 65_536 || value.includes('\u0000')) { throw error('The saved client field is invalid.'); }
        await this.mutate('save', async () => this.ports.store.updateCatalog(catalog => {
            const row = this.requireClient(catalog, infobase, id); const authentication = getVanessaDebugClientAuthentication(row);
            const updated = { ...row, infobase: normalizeInfobaseReference(row.infobase), username: authentication.username ?? '', password: authentication.password ?? '', [key]: value };
            return catalog.map(client => client.id === id ? updated : client);
        }));
    }
    captureReplacement(infobase: string, id: string): VanessaInfobaseReplacement {
        const state = this.ports.connection();
        const client = this.requireClient(this.catalog, infobase, id);
        const match = this.live && this.liveGeneration === state.generation ? reconcileVanessaClient(client, this.live) : undefined;
        if (!state.ready || !match?.replaceable || !match.profile) { throw error('Refresh the client list before replacing this profile.'); }
        return { generation: state.generation, profile: { ...match.profile } };
    }
    async operate(infobase: string, ids: readonly string[], action: VanessaInfobaseClientAction, expectedReplacement?: VanessaInfobaseReplacement): Promise<void> {
        if (!['add', 'connect', 'disconnect', 'replace'].includes(action) || !Array.isArray(ids) || !ids.length || ids.length > 512 || new Set(ids).size !== ids.length) { throw error('Select saved clients first.'); }
        await this.mutate(action, async () => {
            const state = this.ports.connection();
            if (!state.ready || !state.read || state.busy || (action === 'connect' && !state.connect) || (action === 'disconnect' && !state.disconnect)) { throw error('Connect to a ready Vanessa session before updating clients.'); }
            const liveIds = ids.filter(id => id.startsWith('live:'));
            if (liveIds.length) {
                if (ids.length !== 1 || !['connect', 'disconnect'].includes(action)) { throw error('The saved client field is invalid.'); }
                const row = this.stateFor(infobase).rows.find(row => row.id === liveIds[0] && row.remoteOnly);
                const profile = row && this.live?.find(profile => fold(profile.name) === fold(row.name) && sameBase(profile.connection, infobase));
                if (!profile) { throw error('The Vanessa session changed. Refresh the client list.'); }
                await this.ports.run(async runtime => {
                    const latest = (await runtime.list()).find(row => fold(row.name) === fold(profile.name));
                    if (!latest || !sameVanessaClientProfile(latest, profile)) { throw error('The replacement target changed. Refresh the client list.'); }
                    if (action === 'connect') { await runtime.connect(profile.name, profile); } else { await runtime.disconnect(profile.name, profile); }
                }, state.generation);
                return;
            }
            const catalog = await this.ports.store.loadCatalog(); const selected = ids.map(id => this.requireClient(catalog, infobase, id));
            const current = () => { if (this.disposed || this.ports.connection().generation !== state.generation || !this.ports.connection().ready) { throw error('The Vanessa session changed. Refresh the client list.'); } };
            await this.ports.run(async runtime => {
                current(); let profiles = await runtime.list(); current();
                const matches = selected.map(client => ({ client, match: reconcileVanessaClient(client, profiles) }));
                if (action === 'replace' && (matches.length !== 1 || !expectedReplacement || expectedReplacement.generation !== state.generation ||
                    !matches[0].match.profile || !sameVanessaClientProfile(matches[0].match.profile, expectedReplacement.profile))) { throw error('The replacement target changed. Refresh the client list.'); }
                for (const { match } of matches) {
                    if (match.state === 'unsupported' || match.state === 'conflict' && !(action === 'replace' && match.replaceable)) { throw error('A selected client conflicts with a Vanessa profile. Resolve the conflict before applying the selection.'); }
                    if (((match.state === 'local' || match.state === 'outdated') && action !== 'disconnect' || action === 'replace') && !state.write) { throw error('This Vanessa session cannot add or edit client profiles.'); }
                }
                if (action === 'add' || action === 'connect') {
                    const names = new Set<string>();
                    for (const client of selected) {
                        for (const name of new Set([client.name, client.synonym].filter(Boolean).map(fold))) {
                            if (names.has(name)) { throw error('Selected client names or synonyms overlap. Choose distinct names before applying them together.'); }
                            names.add(name);
                        }
                    }
                }
                if (action === 'disconnect' && matches.some(({ match }) => match.state === 'connected') && profiles.filter(row => row.connected).length !== 1) { throw error('This Vanessa version can disconnect only its single confirmed current client.'); }
                for (const { client, match } of matches) {
                    current(); let target = match.profile; let applied = false; const approved = target;
                    if (action === 'replace') {
                        if (!match.replaceable || !target || target.connected) { throw error('Disconnect and refresh this profile before replacing it.'); }
                        await runtime.apply({ ...client, name: target.name }, true, target); applied = true;
                    } else if (match.state === 'local' && action !== 'disconnect') { await runtime.apply(client, true, null); applied = true; }
                    else if (match.state === 'outdated' && action !== 'disconnect') {
                        if (target?.connected) { throw error('Disconnect this client before changing its connection.'); }
                        await runtime.apply(client, true, target); applied = true;
                    }
                    current(); profiles = await runtime.list(); current();
                    const fresh = reconcileVanessaClient(client, profiles);
                    if (action === 'disconnect' && match.state === 'local') { continue; }
                    if (!fresh.profile || !['added', 'connected'].includes(fresh.state) && !(action === 'disconnect' && fresh.state === 'outdated') ||
                        !applied && approved && !sameVanessaClientProfile(approved, fresh.profile)) {
                        throw error('The Vanessa client profile changed. Refresh the client list.');
                    }
                    target = fresh.profile;
                    if (action === 'connect' && target && !target.connected) { await runtime.connect(target.name, target); }
                    else if (action === 'disconnect' && target?.connected) { await runtime.disconnect(target.name, target); }
                }
                current(); this.live = await runtime.list(); current(); this.liveGeneration = state.generation;
            }, state.generation);
        });
    }
    private requireClient(catalog: readonly VanessaDebugClient[], infobase: string, id: string): VanessaDebugClient {
        const row = catalog.find(client => client.id === id && sameBase(client.infobase, infobase));
        if (!row) { throw error('This saved client no longer belongs to the selected infobase. Refresh the list.'); } return row;
    }
    private fields(input: VanessaInfobaseClientFields): VanessaInfobaseClientFields {
        const text = (value: unknown, required = false) => {
            if (typeof value !== 'string' || value.length > 512 || /[\r\n\u0000|]/u.test(value) || required && !value.trim()) { throw error('The saved client field is invalid.'); }
            return value.trim();
        };
        if (!input || !['Thin', 'Thick'].includes(input.clientType) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) { throw error('Choose a supported client type and a valid port.'); }
        return { name: text(input.name, true), username: text(input.username), synonym: text(input.synonym),
            clientType: input.clientType, computerName: text(input.computerName, true), port: input.port };
    }
    private safeError(cause: unknown): string {
        return cause instanceof VanessaInfobaseClientError || cause instanceof VanessaClientControlError ? cause.message : 'The Vanessa client operation was not confirmed. Refresh the client list.';
    }
    private async mutate(action: string, work: () => Promise<void>): Promise<void> {
        if (this.pendingAction || this.disposed) { throw error('A client operation is already in progress.'); }
        await this.refreshing;
        if (this.pendingAction || this.disposed) { throw error('A client operation is already in progress.'); }
        this.pendingAction = action; this.lastError = null; this.changed(); let failure: string | undefined;
        try { await work(); }
        catch (cause) { failure = this.safeError(cause); throw error(failure); }
        finally { this.pendingAction = null; await this.refresh(); if (failure) { this.lastError = failure; } this.changed(); }
    }
}
