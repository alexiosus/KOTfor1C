import { VanessaClientControlError, type VanessaRuntimeClients } from './vanessaControlClients';
import type { VanessaDebugClientSelection } from './vanessaDebugClients';

interface ClientManagerItem { readonly id: string; readonly label: string; readonly description?: string }
interface ClientManagerSnapshot {
    readonly generation: number;
    readonly ready: boolean;
    readonly read: boolean;
    readonly write: boolean;
    readonly connect: boolean;
    readonly disconnect: boolean;
    readonly close: boolean;
}
export interface VanessaClientManagerPorts {
    snapshot(): ClientManagerSnapshot;
    loadSaved(): Promise<VanessaDebugClientSelection | undefined>;
    configureSaved(): Promise<void>;
    run<T>(work: (clients: VanessaRuntimeClients) => Promise<T>, generation: number): Promise<T>;
    ui: {
        pick(title: string, items: readonly ClientManagerItem[]): Promise<string | undefined>;
        acknowledgePort(name: string, port: number): Promise<boolean>;
        info(message: string): Promise<void>;
    };
}

/** One explicit interaction; native UI receives identities/status only, never connection strings or launch keys. */
export async function manageVanessaClients(ports: VanessaClientManagerPorts): Promise<void> {
    const state = ports.snapshot();
    const current = () => {
        const now = ports.snapshot();
        if (now.generation !== state.generation || !now.ready) {
            throw new VanessaClientControlError('The Vanessa session changed. Refresh the client list.');
        }
    };
    const action = await ports.ui.pick('Vanessa test clients', [
        { id: 'configure', label: 'Edit saved connections and templates…' },
        ...(state.ready && state.read && state.write ? [{ id: 'apply', label: 'Apply saved connection to Vanessa…' }] : []),
        ...(state.ready && state.read ? [{ id: 'live', label: 'Live test clients…' }] : [])
    ]);
    if (!action) { return; }
    if (action === 'configure') { await ports.configureSaved(); return; }
    current();
    if (action === 'apply' && state.read && state.write) {
        const selection = await ports.loadSaved(); current();
        if (!selection?.clients.length) { await ports.ui.info('No saved connections. Edit saved connections first.'); return; }
        const id = await ports.ui.pick('Apply saved connection', selection.clients.map(client => ({
            id: client.id, label: client.name, description: `${client.clientType} • ${client.computerName}:${client.port}`
        })));
        if (id === undefined) { return; }
        const client = selection.clients.find(value => value.id === id);
        if (!client) { return; }
        if (!await ports.ui.acknowledgePort(client.name, client.port)) { return; }
        current();
        await ports.run(clients => clients.apply(client, true), state.generation);
        await ports.ui.info('Supported connection fields applied and verified. The saved port was not applied.');
    } else if (action === 'live' && state.read) {
        const profiles = await ports.run(clients => clients.list(), state.generation); current();
        if (!profiles.length) { await ports.ui.info('No client profiles in this Vanessa session.'); return; }
        const id = await ports.ui.pick('Live test clients', profiles.map((profile, index) => ({
            id: String(index), label: `${profile.connected ? '$(plug)' : '$(debug-disconnect)'} ${profile.name}`,
            description: `${profile.clientType} • ${profile.computerName}`
        })));
        if (id === undefined) { return; }
        const selected = profiles[Number(id)];
        if (!selected || !/^\d+$/u.test(id)) { return; }
        current();
        const operation = await ports.ui.pick('Test client actions', [
            ...(!selected.connected && state.connect ? [{ id: 'connect', label: 'Connect test client' }] : []),
            ...(selected.connected && state.disconnect ? [{ id: 'disconnect', label: 'Disconnect test client' }] : []),
            ...(selected.connected && state.close ? [{ id: 'close', label: 'Close test client' }] : [])
        ]);
        if (operation === undefined) { return; }
        current();
        if (operation === 'connect' && state.connect || operation === 'disconnect' && state.disconnect || operation === 'close' && state.close) {
            await ports.run(clients => clients[operation](selected.name), state.generation);
            await ports.ui.info('Test client state verified.');
        }
    }
}
