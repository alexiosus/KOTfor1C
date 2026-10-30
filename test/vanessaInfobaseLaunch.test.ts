import assert from 'node:assert/strict';
import test from 'node:test';
import { connectInfobaseClient, type VanessaInfobaseLaunchPorts } from '../src/vanessaInfobaseLaunch';
test('base launch uses the chosen saved profile, and cancel/configure never connects', async () => {
    const calls: unknown[] = []; let selection: string | undefined;
    const ports = { clients: { refresh: async () => {}, stateFor: () => ({ connection: { ready: true }, rows: [{ id: 'first', name: 'First', username: 'A' }, { id: 'second', name: 'Second', username: 'B' }] }),
        operate: async (...args: unknown[]) => { calls.push(args); } },
    pick: async () => selection, connectManager: async () => { calls.push('manager'); }, configure: async (base: string) => { calls.push('configure:' + base); } } as unknown as VanessaInfobaseLaunchPorts;
    assert.equal(await connectInfobaseClient('/base', ports), false); assert.deepEqual(calls, []);
    selection = 'configure'; await connectInfobaseClient('/base', ports); assert.deepEqual(calls, ['configure:/base']); calls.length = 0;
    selection = 'second'; assert.equal(await connectInfobaseClient('/base', ports), true);
    assert.deepEqual(calls, ['manager', ['/base', ['second'], 'connect']]);
});
