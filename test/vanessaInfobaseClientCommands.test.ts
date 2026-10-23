import assert from 'node:assert/strict';
import test from 'node:test';
import { handleVanessaInfobaseClientMessage } from '../src/vanessaInfobaseClientCommands';
import type { VanessaInfobaseClients } from '../src/vanessaInfobaseClients';
function setup() {
    const calls: unknown[] = [];
    const service = { saveClient: async (...args: unknown[]) => { calls.push(['save', ...args]); },
        setSecret: async (...args: unknown[]) => { calls.push(['secret', ...args]); }, readSecret: async () => 'private',
        operate: async (...args: unknown[]) => { calls.push(['operate', ...args]); }, removeClient: async () => {}, refresh: async () => {},
        captureReplacement: () => ({ generation: 1, profile: { name: 'Remote' } }),
        stateFor: () => ({ rows: [{ id: 'own', name: 'Own', replaceable: true, remoteName: 'Remote' }], connection: { ready: true } }) } as unknown as VanessaInfobaseClients;
    return { service, calls, ui: { input: async (_options: { value: string; password: boolean }) => undefined as string | undefined,
        confirmReplace: async (_local: string, _remote: string) => false, connectManager: async () => {} } };
}
test('canceled secure-field dialogs do not replace credentials and no secret enters a webview message', async () => {
    const h = setup();
    assert.equal(await handleVanessaInfobaseClientMessage(h.service, '/own', { command: 'clientSecret', clientId: 'own', secret: 'password' }, h.ui), true);
    assert.deepEqual(h.calls, []);
    h.ui.input = async options => { assert.equal(options.password, true); assert.equal(options.value, 'private'); return ''; };
    await handleVanessaInfobaseClientMessage(h.service, '/own', { command: 'clientSecret', clientId: 'own', secret: 'password' }, h.ui);
    assert.deepEqual(h.calls, [['secret', '/own', 'own', 'password', '']]);
});
test('replacement requires a concrete confirmation and keeps the confirmed remote name bound to the action', async () => {
    const h = setup(); const raw = { command: 'clientOperate', action: 'replace', clientIds: ['own'] };
    await handleVanessaInfobaseClientMessage(h.service, '/own', raw, h.ui); assert.deepEqual(h.calls, []);
    h.ui.confirmReplace = async (local, remote) => { assert.equal(local, 'Own'); assert.equal(remote, 'Remote'); return true; };
    await handleVanessaInfobaseClientMessage(h.service, '/own', raw, h.ui);
    assert.deepEqual(h.calls, [['operate', '/own', ['own'], 'replace', { generation: 1, profile: { name: 'Remote' } }]]);
});
test('invalid selection IDs and credentials embedded in ordinary editor fields are rejected before mutation', async () => {
    const h = setup();
    for (const raw of [{ command: 'clientOperate', action: 'connect', clientIds: [null] },
        { command: 'clientSave', fields: { name: 'Own', infobase: '/injected' } },
        { command: 'clientSecret', clientId: 'own', secret: 'infobase' }]) {
        await assert.rejects(handleVanessaInfobaseClientMessage(h.service, '/own', raw, h.ui));
    }
    assert.deepEqual(h.calls, []);
});
