import assert from 'node:assert/strict';
import test from 'node:test';
import { manageVanessaClients, type VanessaClientManagerPorts } from '../src/vanessaControlClientWorkflow';
import type { VanessaRuntimeClients, VanessaClientProfile } from '../src/vanessaControlClients';
import type { VanessaDebugClient } from '../src/vanessaDebugClients';

const saved: VanessaDebugClient = { id: 'first', name: 'KOT client', infobase: 'File="C:\\own";Pwd="embedded-secret";', username: 'KOT',
    password: 'client-secret', additionalParameters: '/P"key-secret"', synonym: '', clientType: 'Thin', computerName: 'localhost', port: 1540 };
const live: VanessaClientProfile = { name: saved.name, synonym: '', connection: saved.infobase, additionalParameters: saved.additionalParameters,
    clientType: 'Тонкий', computerName: 'localhost', windowHandle: '0', pid: 0, connected: false };
function fixture(actions: Array<string | undefined>) {
    let generation = 1; const calls: string[] = []; const visible: unknown[] = [];
    const clients = { list: async () => { calls.push('list'); return [live]; },
        apply: async (client: VanessaDebugClient, acknowledged: boolean) => { calls.push(`apply:${client.id}:${acknowledged}`); },
        connect: async (name: string) => { calls.push(`connect:${name}`); },
        disconnect: async (name: string) => { calls.push(`disconnect:${name}`); }, close: async (name: string) => { calls.push(`close:${name}`); }
    } as unknown as VanessaRuntimeClients;
    const ports: VanessaClientManagerPorts = {
        snapshot: () => ({ generation, ready: true, read: true, write: true, connect: true, disconnect: true, close: true }),
        loadSaved: async () => ({ mode: 'scenario', clients: [saved] }),
        configureSaved: async () => { calls.push('configure'); },
        run: async (work, expected) => { assert.equal(expected, generation); return work(clients); },
        ui: { pick: async (title, items) => {
            visible.push({ title, items }); const id = actions.shift();
            if (id === undefined) { return undefined; }
            assert.ok(items.some(item => item.id === id), `Unavailable action ${id}`); return id;
        }, acknowledgePort: async () => true, info: async message => { visible.push(message); } }
    };
    return { ports, calls, visible, changeSession: () => { generation++; } };
}

test('client manager uses the saved Debug set without exposing connection strings or launch keys in pickers', async () => {
    const f = fixture(['apply', 'first', undefined]);
    await manageVanessaClients(f.ports);
    assert.deepEqual(f.calls, ['apply:first:true']);
    for (const secret of ['embedded-secret', 'client-secret', 'key-secret', 'C:\\own']) { assert.ok(!JSON.stringify(f.visible).includes(secret)); }
});

test('cancel before applying does not send a client operation, including the unsupported-port choice', async () => {
    for (const actions of [[undefined], ['apply', undefined], ['apply', 'first', undefined]]) {
        const f = fixture(actions); f.ports.ui.acknowledgePort = async () => false;
        await manageVanessaClients(f.ports); assert.deepEqual(f.calls, []);
    }
});

test('a session change while choosing a saved connection refuses the operation', async () => {
    const f = fixture(['apply', 'first']);
    f.ports.ui.acknowledgePort = async () => { f.changeSession(); return true; };
    await assert.rejects(manageVanessaClients(f.ports), /session changed/u); assert.deepEqual(f.calls, []);
});

test('live actions use explicit profile selection, and unsupported capabilities are not offered', async () => {
    const f = fixture(['live', '0', 'connect', undefined]);
    await manageVanessaClients(f.ports); assert.deepEqual(f.calls, ['list', `connect:${saved.name}`]);
    const unsupported = fixture(['configure', undefined]);
    unsupported.ports.snapshot = () => ({ generation: 1, ready: false, read: false, write: false, connect: false, disconnect: false, close: false });
    await manageVanessaClients(unsupported.ports); assert.deepEqual(unsupported.calls, ['configure']);
    assert.ok(!JSON.stringify(unsupported.visible).includes('"id":"apply"'));
});

test('stale live selections never execute against another session', async () => {
    const f = fixture(['live', '0', 'connect']); const pick = f.ports.ui.pick;
    f.ports.ui.pick = async (title, items) => { const id = await pick(title, items); if (id === 'connect') { f.changeSession(); } return id; };
    await assert.rejects(manageVanessaClients(f.ports), /session changed/u); assert.deepEqual(f.calls, ['list']);
});
