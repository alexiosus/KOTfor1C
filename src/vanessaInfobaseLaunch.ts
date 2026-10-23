import type { VanessaInfobaseClients } from './vanessaInfobaseClients';

export interface VanessaInfobaseLaunchPorts {
    clients: Pick<VanessaInfobaseClients, 'refresh' | 'stateFor' | 'operate'>;
    pick(rows: readonly { id: string; name: string; username: string }[]): Promise<string | undefined>;
    connectManager(): Promise<void>;
    configure(infobase: string): Promise<void>;
}
/** A launch always targets an explicit saved profile; selection alone starts no process. */
export async function connectInfobaseClient(infobase: string, ports: VanessaInfobaseLaunchPorts): Promise<boolean> {
    await ports.clients.refresh();
    const rows = ports.clients.stateFor(infobase).rows;
    if (!rows.length) { await ports.configure(infobase); return false; }
    const selected = await ports.pick(rows.map(({ id, name, username }) => ({ id, name, username })));
    if (!selected) { return false; }
    if (selected === 'configure') { await ports.configure(infobase); return false; }
    if (!rows.some(row => row.id === selected)) { return false; }
    await ports.connectManager(); await ports.clients.refresh();
    if (!ports.clients.stateFor(infobase).connection.ready) { return false; }
    await ports.clients.operate(infobase, [selected], 'connect');
    return true;
}
