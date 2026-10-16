import { randomUUID } from 'node:crypto';
import { describeInfobaseConnection, parseInfobaseConnectionString } from './oneCInfobaseConnection';
import {
    VanessaDebugClientStore, validateVanessaDebugClientSelection,
    type VanessaDebugClient, type VanessaDebugClientSelection
} from './vanessaDebugClients';

type Translator = (message: string, ...args: string[]) => string;
export interface DebugClientConfigurationItem {
    readonly action: string;
    readonly label: string;
    readonly description?: string;
}
export interface DebugClientInput {
    readonly title: string;
    readonly value?: string;
    readonly password?: boolean;
    readonly prompt?: string;
    readonly validate?: (value: string) => string | undefined;
}
export interface DebugClientConfigurationUi {
    pick(title: string, items: readonly DebugClientConfigurationItem[]): Promise<DebugClientConfigurationItem | undefined>;
    input(options: DebugClientInput): Promise<string | undefined>;
    folder(current?: string): Promise<string | undefined>;
    managedInfobase(current?: string): Promise<string | undefined>;
}

/** A missing selection opens setup once. An explicit cancel must never mean use default launch settings. */
export async function resolveVanessaDebugClientSelection(
    store: VanessaDebugClientStore,
    configure: (initial?: VanessaDebugClientSelection) => Promise<VanessaDebugClientSelection | null>
): Promise<VanessaDebugClientSelection | null> {
    const saved = await store.load();
    if (saved) { return saved; }
    const configured = await configure();
    if (configured) { await store.save(configured); }
    return configured;
}

async function editClient(
    previous: VanessaDebugClient | undefined, clients: readonly VanessaDebugClient[],
    ui: DebugClientConfigurationUi, t: Translator, suggestedName: string
): Promise<VanessaDebugClient | null> {
    const name = await ui.input({
        title: t('Debug client profile name'), value: previous?.name ?? suggestedName,
        prompt: t('Use the profile name expected by the scenario steps, for example TestClient.'),
        validate: value => !value.trim() ? t('Client profile name cannot be empty.')
            : clients.some(client => client.id !== previous?.id && client.name.toLowerCase() === value.trim().toLowerCase())
                ? t('Client profile names must be unique.') : undefined
    });
    if (name === undefined) { return null; }
    const source = await ui.pick(t('Debug client infobase'), [
        ...(previous ? [{ action: 'keep', label: t('Keep current infobase'), description: describeInfobaseConnection(previous.infobase) }] : []),
        { action: 'managed', label: t('From Infobase Manager') },
        { action: 'folder', label: t('Choose file infobase folder') },
        { action: 'server', label: t('Enter server connection string') }
    ]);
    if (!source) { return null; }
    let infobase: string | undefined;
    if (source.action === 'keep') { infobase = previous?.infobase; }
    else if (source.action === 'managed') { infobase = await ui.managedInfobase(previous?.infobase); }
    else if (source.action === 'folder') { infobase = await ui.folder(previous?.infobase); }
    else {
        infobase = await ui.input({
            title: t('Server infobase connection string'), value: previous && parseInfobaseConnectionString(previous.infobase)?.kind === 'server' ? previous.infobase : '',
            password: true, prompt: t('Enter Srvr="server";Ref="infobase";. Credentials in this string are kept in secure storage.'),
            validate: value => parseInfobaseConnectionString(value)?.kind === 'server' ? undefined : t('Enter a valid server infobase connection string.')
        });
    }
    if (!infobase) { return null; }
    const username = await ui.input({ title: t('Debug client user (optional)'), value: previous?.username ?? '' });
    if (username === undefined) { return null; }
    const password = await ui.input({ title: t('Debug client password (optional)'), value: previous?.password ?? '', password: true });
    if (password === undefined) { return null; }
    const additionalParameters = await ui.input({
        title: t('Additional client launch keys (optional)'), value: previous?.additionalParameters ?? '', password: true,
        prompt: t('Optional 1C client keys, for example /NoSplash /Lru. Saved securely with this client.')
    });
    if (additionalParameters === undefined) { return null; }
    const occupiedPorts = new Set(clients.filter(client => client.computerName === 'localhost').map(client => client.port));
    let port = 1538;
    while (occupiedPorts.has(port)) { port++; }
    return {
        id: previous?.id ?? randomUUID(), name: name.trim(), infobase, username: username.trim(), password,
        synonym: previous?.synonym ?? '', clientType: previous?.clientType ?? 'Thin',
        computerName: previous?.computerName ?? 'localhost', port: previous?.port ?? port,
        additionalParameters
    };
}

async function advancedClient(
    initial: VanessaDebugClient, clients: readonly VanessaDebugClient[], ui: DebugClientConfigurationUi, t: Translator
): Promise<VanessaDebugClient | null> {
    let draft = initial;
    while (true) {
        const picked = await ui.pick(t('Advanced debug client settings: {0}', draft.name), [
            { action: 'type', label: t('Client type'), description: draft.clientType },
            { action: 'computer', label: t('Computer name'), description: draft.computerName },
            { action: 'port', label: t('Test client port'), description: String(draft.port) },
            { action: 'synonym', label: t('Client synonym'), description: draft.synonym },
            { action: 'extra', label: t('Additional client launch keys'), description: t('Stored securely') },
            { action: 'done', label: t('Done') }
        ]);
        if (!picked) { return null; }
        if (picked.action === 'done') { return draft; }
        if (picked.action === 'type') {
            const type = await ui.pick(t('Client type'), [
                { action: 'Thin', label: t('Thin client') }, { action: 'Thick', label: t('Thick client') }
            ]);
            if (!type) { return null; }
            draft = { ...draft, clientType: type.action };
        } else {
            const key = picked.action === 'computer' ? 'computerName'
                : picked.action === 'port' ? 'port' : picked.action === 'synonym' ? 'synonym' : 'additionalParameters';
            const value = await ui.input({
                title: picked.label, value: String(draft[key]), password: key === 'additionalParameters',
                validate: value => {
                    if (key === 'computerName' && !value.trim()) { return t('Computer name cannot be empty.'); }
                    if (key !== 'port') { return undefined; }
                    const port = Number(value);
                    if (!Number.isInteger(port) || port < 1 || port > 65535) { return t('Enter a port from 1 to 65535.'); }
                    if (clients.some(client => client.id !== draft.id && client.computerName.toLowerCase() === draft.computerName.toLowerCase() && client.port === port)) {
                        return t('Debug clients on the same computer must use different ports.');
                    }
                    return undefined;
                }
            });
            if (value === undefined) { return null; }
            draft = { ...draft, [key]: key === 'port' ? Number(value) : value };
        }
    }
}

/** Editing uses a draft. Only Save or Use scenario parameters commits a result. */
export async function configureVanessaDebugClientSelection(
    initial: VanessaDebugClientSelection | undefined, ui: DebugClientConfigurationUi, t: Translator,
    suggestedName = 'TestClient'
): Promise<VanessaDebugClientSelection | null> {
    let clients = [...(initial?.clients ?? [])];
    while (true) {
        const items: DebugClientConfigurationItem[] = [
            ...(clients.length ? [{ action: 'save', label: t('Save and use debug clients'), description: t('{0} clients', String(clients.length)) }] : []),
            { action: 'add', label: t('Add debug client') },
            ...clients.flatMap(client => [
                { action: `edit:${client.id}`, label: t('Edit client: {0}', client.name), description: describeInfobaseConnection(client.infobase) },
                { action: `advanced:${client.id}`, label: t('Advanced settings: {0}', client.name), description: `${client.clientType} • ${client.computerName}:${client.port}` },
                { action: `remove:${client.id}`, label: t('Remove client: {0}', client.name) }
            ]),
            { action: 'scenario', label: t('Use scenario parameters'), description: t('Disable the saved client override for debug launches.') }
        ];
        const picked = await ui.pick(t('Vanessa debug clients'), items);
        if (!picked) { return null; }
        if (picked.action === 'scenario') { return { mode: 'scenario', clients }; }
        if (picked.action === 'save') {
            const selection: VanessaDebugClientSelection = { mode: 'clients', clients };
            validateVanessaDebugClientSelection(selection);
            return selection;
        }
        const [action, id] = picked.action.split(':');
        if (action === 'remove') { clients = clients.filter(client => client.id !== id); continue; }
        const previous = clients.find(client => client.id === id);
        const edited = action === 'advanced' && previous
            ? await advancedClient(previous, clients, ui, t)
            : await editClient(previous, clients, ui, t, clients.length === 0 ? suggestedName : `TestClient${clients.length + 1}`);
        if (!edited) { return null; }
        clients = previous ? clients.map(client => client.id === edited.id ? edited : client) : [...clients, edited];
    }
}
