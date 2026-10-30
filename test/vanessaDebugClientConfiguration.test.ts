import assert from 'node:assert/strict';
import test from 'node:test';
import {
    configureVanessaDebugClientSelection, resolveVanessaDebugClientSelection,
    type DebugClientConfigurationUi, type DebugClientConfigurationItem
} from '../src/vanessaDebugClientConfiguration';
import { VanessaDebugClientStore, type VanessaDebugClientSelection } from '../src/vanessaDebugClients';

function fixture(actions: Array<string | undefined>, inputs: Array<string | undefined>) {
    const state = new Map<string, unknown>(); const secrets = new Map<string, string>();
    const store = new VanessaDebugClientStore({
        get: <T>(key: string) => state.get(key) as T | undefined,
        update: async (key, value) => { state.set(key, value); }
    }, {
        get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); },
        delete: async key => { secrets.delete(key); }
    });
    const protectedInputs: string[] = []; const prompts: string[] = [];
    const ui: DebugClientConfigurationUi = {
        pick: async (title, items) => {
            prompts.push(title);
            const action = actions.shift();
            if (action === undefined) { return undefined; }
            const item = items.find(item => item.action === action);
            assert.ok(item, `Unavailable action: ${action}`);
            return item;
        },
        input: async options => {
            const value = inputs.shift();
            if (options.password) { protectedInputs.push(options.title); }
            if (value !== undefined && options.validate) { assert.equal(options.validate(value), undefined); }
            return value;
        },
        folder: async () => '/bases/client',
        managedInfobase: async () => '/bases/managed'
    };
    const translate = (message: string, ...args: unknown[]) => message.replace(/\{(\d+)\}/gu, (_, index) => String(args[Number(index)]));
    const edit = (selection?: VanessaDebugClientSelection) => configureVanessaDebugClientSelection(selection, ui, translate);
    return { store, state, secrets, ui, edit, protectedInputs, prompts };
}

test('first configuration saves several named clients and later debug launches reuse them without UI prompts', async () => {
    const f = fixture(['add', 'managed', 'add', 'folder', 'save'], ['TestClient', 'admin', 'one-secret', '', 'Warehouse', 'warehouse', 'two-secret', '']);
    const selection = await resolveVanessaDebugClientSelection(f.store, f.edit);
    assert.equal(selection?.mode, 'clients');
    assert.deepEqual(selection?.clients.map(client => [client.name, client.infobase, client.port]), [
        ['TestClient', '/bases/managed', 1538], ['Warehouse', '/bases/client', 1539]
    ]);
    assert.equal(f.protectedInputs.length, 4);
    const promptCount = f.prompts.length;
    const reused = await resolveVanessaDebugClientSelection(f.store, () => assert.fail('Repeated setup dialog'));
    assert.deepEqual(reused, selection);
    assert.equal(f.prompts.length, promptCount);
    assert.equal(JSON.stringify([...f.state.values()]).includes('one-secret'), false);
});

test('cancel during the first client wizard aborts launch setup and persists nothing', async () => {
    const f = fixture(['add', 'managed'], ['TestClient', undefined]);
    assert.equal(await resolveVanessaDebugClientSelection(f.store, f.edit), null);
    assert.equal(f.state.size, 0);
    assert.equal(f.secrets.size, 0);
});

test('the basic client wizard accepts optional custom launch keys and persists them in secure storage', async () => {
    const f = fixture(['add', 'managed', 'save'], ['TestClient', 'admin', '', '/NoSplash /C"custom-value"']);
    const saved = await resolveVanessaDebugClientSelection(f.store, f.edit);
    assert.equal(saved?.clients[0].additionalParameters, '/NoSplash /C"custom-value"');
    assert.equal((await f.store.load())?.clients[0].additionalParameters, '/NoSplash /C"custom-value"');
    assert.equal(JSON.stringify([...f.state.values()]).includes('custom-value'), false);
});

test('using scenario parameters is remembered and disables the saved override without losing the client set', async () => {
    const f = fixture(['add', 'folder', 'save', 'scenario'], ['TestClient', '', 'secret', '']);
    const saved = await resolveVanessaDebugClientSelection(f.store, f.edit);
    assert.ok(saved);
    const disabled = await f.edit(saved);
    assert.ok(disabled);
    assert.equal(disabled.mode, 'scenario');
    assert.equal(disabled.clients[0].password, 'secret');
    await f.store.save(disabled);
    assert.equal((await resolveVanessaDebugClientSelection(f.store, () => assert.fail('Unrequested setup')))?.mode, 'scenario');
});

test('custom server connections and advanced launch keys are entered in protected inputs', async () => {
    const f = fixture(['add', 'server', 'advanced:first', 'extra', 'done', 'save'], [
        'TestClient', 'Srvr="server";Ref="base";Pwd="embedded-secret";', '', '', '', '/P"extra-secret"'
    ]);
    // Stable client IDs are independent of labels. Select the generated client by item role.
    const originalPick = f.ui.pick;
    f.ui.pick = async (title, items) => {
        const advanced = items.find(item => item.action.startsWith('advanced:'));
        if (advanced) {
            return originalPick(title, items.map(item => item === advanced ? { ...item, action: 'advanced:first' } : item))
                .then(item => item?.action === 'advanced:first' ? advanced : item);
        }
        return originalPick(title, items);
    };
    const saved = await resolveVanessaDebugClientSelection(f.store, f.edit);
    assert.equal(saved?.clients[0].additionalParameters, '/P"extra-secret"');
    assert.equal(f.protectedInputs.length, 4);
    const persisted = JSON.stringify([...f.state.values()]);
    assert.equal(persisted.includes('embedded-secret'), false);
    assert.equal(persisted.includes('extra-secret'), false);
});

test('cancel while changing saved clients preserves the previous set and credentials', async () => {
    const f = fixture(['add', 'folder', 'save', 'add', 'folder'], ['TestClient', '', 'old', '', 'Second', '', undefined]);
    const original = await resolveVanessaDebugClientSelection(f.store, f.edit);
    assert.ok(original);
    assert.equal(await f.edit(original), null);
    assert.deepEqual(await f.store.load(), original);
});

test('saved clients can be used as connection templates without sharing identities, synonyms or ports', async () => {
    const initial: VanessaDebugClientSelection = { mode: 'clients', clients: [{ id: 'first', name: 'KOT', infobase: '/bases/template',
        username: 'admin', password: 'original-secret', additionalParameters: '/NoSplash', synonym: 'original-alias', clientType: 'Thin', computerName: 'localhost', port: 1538 }] };
    const f = fixture(['copy:first', 'keep', 'save'], ['KOT copy', 'other-user', 'copy-secret', '/NoSplash']);
    const result = await f.edit(initial);
    assert.equal(result?.clients.length, 2);
    assert.deepEqual(result?.clients[0], initial.clients[0]);
    const copy = result!.clients[1];
    assert.notEqual(copy.id, initial.clients[0].id); assert.equal(copy.port, 1539); assert.equal(copy.synonym, '');
    assert.equal(copy.infobase, '/bases/template'); assert.equal(copy.username, 'other-user'); assert.equal(copy.password, 'copy-secret');
    assert.equal(initial.clients.length, 1); assert.equal(initial.clients[0].password, 'original-secret');
});

test('cancelling a connection template copy leaves the saved selection unchanged', async () => {
    const f = fixture(['add', 'folder', 'save'], ['TestClient', '', 'secret', '']);
    const initial = await resolveVanessaDebugClientSelection(f.store, f.edit); assert.ok(initial);
    const cancel = fixture([`copy:${initial.clients[0].id}`], [undefined]);
    assert.equal(await cancel.edit(initial), null); assert.deepEqual(await f.store.load(), initial);
});
