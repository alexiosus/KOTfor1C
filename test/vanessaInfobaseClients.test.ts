import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaInfobaseClients, reconcileVanessaClient, getVanessaInfobaseConnection, type VanessaInfobaseClientPorts } from '../src/vanessaInfobaseClients';
import { prepareVanessaClientProfile, type VanessaClientProfile, type VanessaRuntimeClients } from '../src/vanessaControlClients';
import type { VanessaDebugClient } from '../src/vanessaDebugClients';
const client: VanessaDebugClient = { id: 'own', name: 'Own', infobase: '/bases/own', username: 'Tester', password: 'private',
    synonym: '', clientType: 'Thin', computerName: 'localhost', port: 1538, additionalParameters: '/private-key' };
test('embedded remote credentials cannot be ignored when matching a passwordless default user', () => {
    const anonymous = { ...client, username: '', password: '', additionalParameters: '' };
    assert.equal(reconcileVanessaClient(anonymous, [{ ...profile(anonymous), connection: 'File="/bases/own";Usr="Other";Pwd="private";' }]).state, 'outdated');
});
function profile(saved = client, name = saved.name): VanessaClientProfile {
    const { fields } = prepareVanessaClientProfile(saved);
    return { name, synonym: fields.synonym, connection: fields.infobase_path, additionalParameters: fields.additional_parameters,
        clientType: fields.client_type, computerName: fields.computer_name, windowHandle: '', connected: false };
}
function setup(initial: readonly VanessaDebugClient[] = [client]) {
    let catalog = [...initial]; let live: VanessaClientProfile[] = []; let generation = 1; let ready = true;
    const writes: string[] = [];
    const runtime = { list: async () => live,
        apply: async (row: VanessaDebugClient, acknowledged: boolean, expected: VanessaClientProfile | null) => {
            assert.equal(acknowledged, true); writes.push('add:' + row.id);
            live = [...live.filter(value => value.name !== row.name), profile(row)];
            assert.ok(expected === null || typeof expected === 'object');
        },
        connect: async (name: string) => { writes.push('connect:' + name); live = live.map(value => ({ ...value, connected: value.name === name || value.connected })); },
        disconnect: async (name: string) => { writes.push('disconnect:' + name); live = live.map(value => ({ ...value, connected: value.name !== name && value.connected })); }
    } as unknown as VanessaRuntimeClients;
    const ports: VanessaInfobaseClientPorts = {
        connection: () => ({ generation, ready, busy: false, read: true, write: true, connect: true, disconnect: true }),
        store: { loadCatalog: async () => catalog, updateCatalog: async update => { catalog = [...update(catalog)]; } },
        run: async (work, expectedGeneration) => { assert.equal(expectedGeneration, generation); return work(runtime); }
    };
    return { service: new VanessaInfobaseClients(ports), ports, runtime, writes, catalog: () => catalog,
        live: (value: VanessaClientProfile[]) => { live = value; }, changeSession: () => { generation++; }, detached: () => { ready = false; } };
}

test('the base view includes live-only clients without persisting or exposing their credentials', async () => {
    const h = setup(); const extra = { ...profile({ ...client, name: 'Live' }), connected: true };
    h.live([profile(), extra]); await h.service.refresh();
    const rows = h.service.stateFor(client.infobase).rows; assert.equal(rows.length, 2); assert.equal(rows[1].remoteOnly, true);
    assert.equal(rows[1].username, 'Tester'); assert.ok(!JSON.stringify(rows).includes('private'));
    assert.equal(h.catalog().length, 1); await h.service.operate(client.infobase, [rows[1].id], 'disconnect');
    assert.deepEqual(h.writes, ['disconnect:Live']);
});

test('unchanged background client refreshes do not republish or flash the panel', async () => {
    const h = setup(); h.live([profile()]); await h.service.refresh(); let changes = 0;
    h.service.onDidChange(() => { changes++; }); await h.service.refresh(); await h.service.refresh(); assert.equal(changes, 0);
});

test('optional automatic transfer adds only absent saved profiles and never connects or replaces', async () => {
    const h = setup(); h.ports.autoAdd = () => true; await h.service.refresh();
    assert.deepEqual(h.writes, ['add:own']); await h.service.refresh(); assert.deepEqual(h.writes, ['add:own']);
    h.live([{ ...profile(), connection: 'File="/foreign/base";' }]); await h.service.refresh(); assert.deepEqual(h.writes, ['add:own']);
});

test('automatic transfer observes an external rename before deciding which profiles are absent', async () => {
    const h = setup(); h.ports.autoAdd = () => true; h.live([profile()]); await h.service.refresh();
    h.live([profile(client, 'Renamed')]); await h.service.refresh(); assert.equal(h.catalog()[0].name, 'Renamed'); assert.deepEqual(h.writes, []);
});

test('rejected automatic addition preserves live inventory and waits for an explicit retry', async () => {
    const h = setup(); h.ports.autoAdd = () => true; h.live([{ ...profile(client, 'Live'), clientType: 'Толстый', connected: true }]);
    let attempts = 0; h.runtime.apply = async () => { attempts++; throw new Error('rejected'); };
    await h.service.refresh(); let row = h.service.stateFor(client.infobase).rows.find(row => row.remoteOnly);
    assert.equal(row?.clientType, 'Thick'); assert.equal(row?.connected, true); assert.equal(attempts, 1);
    await h.service.refresh(); assert.equal(attempts, 1); await h.service.refresh(true); assert.equal(attempts, 2);
    row = h.service.stateFor(client.infobase).rows.find(row => row.remoteOnly); assert.ok(row);
});

test('profile names identify separate Vanessa rows even when connection settings are identical', () => {
    assert.equal(reconcileVanessaClient({ ...client, name: 'Second' }, [profile()]).state, 'local');
});

test('editing a same-base named profile is a pending update that Connect applies', async () => {
    const h = setup(); h.live([profile()]); await h.service.refresh();
    await h.service.saveClient('/bases/own', 'own', { ...client, username: 'Changed' });
    assert.equal(h.service.stateFor('/bases/own').rows[0].state, 'outdated');
    await h.service.operate('/bases/own', ['own'], 'connect');
    assert.deepEqual(h.writes, ['add:own', 'connect:Own']);
});

test('observed external renames update the saved name instead of displaying contradictory names', async () => {
    const h = setup(); h.live([profile()]); await h.service.refresh();
    h.live([profile(client, 'Renamed')]); await h.service.refresh();
    assert.equal(h.service.stateFor('/bases/own').rows[0].name, 'Renamed');
    assert.equal(h.catalog()[0].name, 'Renamed');
});

test('a changed remote base between preflight and action is never accepted as the new expected profile', async () => {
    for (const action of ['connect', 'disconnect'] as const) {
        const h = setup(); h.live([{ ...profile(), connected: action === 'disconnect' }]); await h.service.refresh();
        let reads = 0;
        h.runtime.list = async () => [{ ...profile(), connected: action === 'disconnect', connection: ++reads === 1 ? profile().connection : 'File="/foreign/base";' }];
        await assert.rejects(h.service.operate('/bases/own', ['own'], action), /profile changed/u);
        assert.deepEqual(h.writes, []);
    }
});

test('foreign conflicting names never mark the saved base running, while actual remote base is identified', async () => {
    const h = setup(); h.live([{ ...profile(), connection: 'File="/foreign/base";', connected: true }]); await h.service.refresh();
    const own = h.service.stateFor('/bases/own'); assert.equal(own.rows[0].connected, false); assert.equal(own.rows[0].active, false);
    assert.deepEqual(own.runtimeClients, []);
    assert.deepEqual(h.service.stateFor('/foreign/base').runtimeClients, [{ name: 'Own', clientType: profile().clientType }]);
});

test('confirmed connected clients remain visible while the same MCP session is busy executing', async () => {
    const h = setup(); h.live([{ ...profile(), connected: true }]); await h.service.refresh();
    const initial = h.ports.connection(); h.ports.connection = () => ({ ...initial, ready: false, connected: true, busy: true });
    h.service.connectionChanged(); assert.equal(h.service.stateFor('/bases/own').rows[0].connected, true);
});

test('temporary state and inventory failures during a run retain confirmed clients until disconnect or replacement', async () => {
    const h = setup();
    h.live([{ ...profile(), connected: true }, { ...profile(client, 'Remote'), connected: true }]);
    await h.service.refresh();
    const capabilities = { clientProfilesRead: { supported: true }, clientProfilesWrite: { supported: true },
        clientConnect: { supported: true }, clientDisconnect: { supported: true } };
    let status = 'unknown'; let generation = 1;
    h.ports.connection = () => getVanessaInfobaseConnection({ generation, status, capabilities } as any, true);
    h.service.connectionChanged();
    assert.deepEqual(h.service.stateFor(client.infobase).runtimeClients.map(row => row.name), ['Own', 'Remote']);
    status = 'ready';
    h.ports.connection = () => getVanessaInfobaseConnection({ generation, status, capabilities } as any, false);
    h.runtime.list = async () => { throw new Error('Temporary MCP failure'); };
    await h.service.refresh();
    assert.equal(h.service.stateFor(client.infobase).rows.filter(row => row.connected).length, 2);
    h.runtime.list = async () => [{ ...profile(), connected: false }];
    await h.service.refresh();
    assert.deepEqual(h.service.stateFor(client.infobase).runtimeClients, []);
    h.live([{ ...profile(), connected: true }]); h.runtime.list = async () => [{ ...profile(), connected: true }];
    await h.service.refresh();
    generation++;
    h.service.connectionChanged();
    assert.deepEqual(h.service.stateFor(client.infobase).runtimeClients, []);
    await h.service.refresh();
    status = 'detached'; h.service.connectionChanged();
    assert.deepEqual(h.service.stateFor(client.infobase).runtimeClients, []);
    h.service.dispose();
});

test('rename observation cannot overwrite a concurrent local name or user edit', async () => {
    const h = setup(); h.live([profile()]); await h.service.refresh(); h.live([profile(client, 'External rename')]);
    h.ports.run = async work => {
        await h.ports.store.updateCatalog(rows => rows.map(row => ({ ...row, name: 'Manual edit', username: 'Other' })));
        return work(h.runtime);
    };
    await h.service.refresh();
    assert.equal(h.catalog()[0].name, 'Manual edit'); assert.equal(h.catalog()[0].username, 'Other');
});

test('inline connection details are returned only for the requested editor and saved securely', async () => {
    const h = setup(); await h.service.refresh();
    const draft = await h.service.editorFor('/bases/own', 'own');
    assert.equal(draft.password, 'private'); assert.equal(draft.additionalParameters, '/private-key');
    await h.service.saveClient('/bases/own', 'own', { ...draft, password: 'changed', additionalParameters: '/Lru' });
    assert.equal(h.catalog()[0].password, 'changed');
    assert.ok(!JSON.stringify(h.service.stateFor('/bases/own')).includes('changed'));
});
test('replacement confirmation is bound to the actual profile and session, not only its name', async () => {
    const h = setup(); h.live([profile({ ...client, infobase: '/foreign/before' })]); await h.service.refresh();
    const confirmed = h.service.captureReplacement('/bases/own', 'own');
    h.live([profile({ ...client, infobase: '/foreign/changed' })]);
    await assert.rejects(h.service.operate('/bases/own', ['own'], 'replace', confirmed), /replacement target changed/u);
    assert.deepEqual(h.writes, []);
});

test('different named clients can be added with identical connection settings', async () => {
    const h = setup([client, { ...client, id: 'second', name: 'Second', port: 1539 }]); await h.service.refresh();
    await h.service.operate('/bases/own', ['own', 'second'], 'add');
    assert.deepEqual(h.writes, ['add:own', 'add:second']);
    assert.deepEqual(h.service.stateFor('/bases/own').rows.map(row => row.state), ['added', 'added']);
});

test('selected names and synonyms share one namespace and are preflighted before writes', async () => {
    const first = { ...client, synonym: 'Shared' };
    for (const second of [{ ...client, id: 'second', name: 'Shared', username: 'Other', port: 1539 },
        { ...client, id: 'second', name: 'Second', synonym: 'shared', username: 'Other', port: 1539 }]) {
        const h = setup([first, second]); await h.service.refresh();
        await assert.rejects(h.service.operate('/bases/own', ['own', 'second'], 'connect'), /names or synonyms/u);
        assert.deepEqual(h.writes, []);
    }
});
test('catalog state is per-base and never contains passwords or extra launch keys', async () => {
    const h = setup([client, { ...client, id: 'other', name: 'Other', infobase: '/bases/other', port: 1539 }]);
    await h.service.refresh(); const view = h.service.stateFor('/bases/own');
    assert.equal(view.rows.length, 1); assert.equal(view.rows[0].username, 'Tester'); assert.equal(view.rows[0].hasPassword, true);
    assert.equal(JSON.stringify(view).includes('private'), false); assert.equal(view.rows[0].state, 'local');
});
test('reconciliation uses names and flags changed settings without merging alternate profiles', () => {
    assert.equal(reconcileVanessaClient(client, [profile(client, 'Alias')]).state, 'local');
    assert.equal(reconcileVanessaClient(client, [{ ...profile(), connection: 'File="/foreign";' }]).state, 'conflict');
    assert.equal(reconcileVanessaClient(client, [profile(client, 'Alias'), profile(client, 'Alias 2')]).state, 'local');
    assert.equal(!!reconcileVanessaClient(client, [profile(), profile(client, 'Alias')]).replaceable, false);
    assert.equal(reconcileVanessaClient(client, [{ ...profile(), additionalParameters: '/N"Tester" /P"changed"' }]).state, 'outdated');
});
test('connect adds missing selected clients, reuses existing clients and skips already connected profiles', async () => {
    const h = setup(); await h.service.refresh();
    await h.service.operate('/bases/own', ['own'], 'connect');
    assert.deepEqual(h.writes, ['add:own', 'connect:Own']);
    assert.equal(h.service.stateFor('/bases/own').rows[0].state, 'connected');
    await h.service.operate('/bases/own', ['own'], 'connect'); assert.equal(h.writes.length, 2);
});
test('all selected conflicts are checked before writing any profile', async () => {
    const second = { ...client, id: 'second', name: 'Second', port: 1539 };
    const h = setup([client, second]); h.live([{ ...profile(second), connection: 'File="/foreign";' }]);
    await h.service.refresh();
    await assert.rejects(h.service.operate('/bases/own', ['own', 'second'], 'connect'));
    assert.deepEqual(h.writes, []);
});
test('local edits and deletion never connect or change a remote profile; stale row IDs reject', async () => {
    const h = setup(); await h.service.refresh();
    await h.service.saveClient('/bases/own', 'own', { ...client, username: 'Changed' });
    await h.service.setSecret('/bases/own', 'own', 'password', 'changed-private');
    assert.equal(h.catalog()[0].password, 'changed-private'); assert.deepEqual(h.writes, []);
    await h.service.removeClient('/bases/own', 'own'); assert.deepEqual(h.catalog(), []);
    await assert.rejects(h.service.operate('/bases/own', ['own'], 'connect')); assert.deepEqual(h.writes, []);
});
test('a changed session rejects an in-flight profile list instead of applying to the new manager', async () => {
    const h = setup(); await h.service.refresh();
    h.ports.run = async work => { h.changeSession(); return work(h.runtime); };
    await assert.rejects(h.service.operate('/bases/own', ['own'], 'connect')); assert.deepEqual(h.writes, []);
});
test('partial connection failure refreshes actual profile states and exposes no raw private errors', async () => {
    const h = setup(); await h.service.refresh();
    h.runtime.connect = async () => { throw new Error('private password leaked by transport'); };
    await assert.rejects(h.service.operate('/bases/own', ['own'], 'connect'), /not confirmed/u);
    const state = h.service.stateFor('/bases/own'); assert.equal(state.rows[0].state, 'added');
    assert.equal(JSON.stringify(state).includes('private'), false);
});
test('disconnect refuses multiple connected clients before touching the current client', async () => {
    const h = setup(); h.live([{ ...profile(), connected: true }, { ...profile(client, 'Another'), connected: true }]);
    await h.service.refresh(); await assert.rejects(h.service.operate('/bases/own', ['own'], 'disconnect'));
    assert.deepEqual(h.writes, []);
});

test('a profile disappearing before connect is an error rather than a successful empty operation', async () => {
    const h = setup(); await h.service.refresh();
    h.runtime.apply = async () => ({ applied: true, unsupportedFields: ['port'] as const });
    await assert.rejects(h.service.operate('/bases/own', ['own'], 'connect'), /changed|Refresh/u);
    assert.deepEqual(h.writes, []);
});


test('Save to KOT imports an observed live profile with authentication without mutating Vanessa', async () => {
    const h = setup(); h.live([profile(), profile({ ...client, name: 'Live', username: 'Other', password: 'secret', additionalParameters: '/DisableStartupMessages' })]);
    await h.service.refresh(); const row = h.service.stateFor(client.infobase).rows.find(value => value.remoteOnly)!;
    await h.service.saveRemoteClient(client.infobase, row.id);
    const saved = h.catalog().find(value => value.name === 'Live')!;
    assert.ok(saved); assert.equal(saved.username, 'Other'); assert.equal(saved.password, 'secret');
    assert.match(saved.additionalParameters, /DisableStartupMessages/u); assert.notEqual(saved.port, client.port);
    assert.deepEqual(h.writes, []); assert.equal(h.service.stateFor(client.infobase).rows.some(value => value.remoteOnly), false);
});

test('Save to KOT allocates a free port on the observed client computer', async () => {
    const saved = { ...client, computerName: 'test-host' }; const h = setup([saved]);
    h.live([profile(saved), profile({ ...saved, name: 'Live on host' })]); await h.service.refresh();
    const row = h.service.stateFor(client.infobase).rows.find(value => value.remoteOnly)!;
    await h.service.saveRemoteClient(client.infobase, row.id);
    assert.equal(h.catalog().find(value => value.name === 'Live on host')?.port, 1539);
});

test('Save to KOT preserves synchronized status for equivalent authentication spellings', async () => {
    for (const live of [
        { ...profile({ ...client, name: 'Live', password: '', additionalParameters: '' }), additionalParameters: '/N"Tester"', connected: true },
        { ...profile({ ...client, name: 'Live', additionalParameters: '/DisableStartupMessages' }), additionalParameters: '/DisableStartupMessages /P"private" /N"Tester"' },
        { ...profile({ ...client, name: 'Live', additionalParameters: '' }), connection: 'File="/bases/own";Usr="Tester";Pwd="private";', additionalParameters: '' },
        { ...profile({ ...client, name: 'Live', additionalParameters: '/C"text /Ninside"' }), additionalParameters: '/C"text /Ninside" /N"Tester" /P"private"' }
    ]) {
        const h = setup([]); h.live([live]); await h.service.refresh();
        await h.service.saveRemoteClient(client.infobase, h.service.stateFor(client.infobase).rows[0].id);
        const row = h.service.stateFor(client.infobase).rows[0];
        assert.equal(row.state, live.connected ? 'connected' : 'added');
        assert.equal(row.remoteOnly, undefined); assert.deepEqual(h.writes, []);
    }
});

test('equivalent authentication does not hide changed passwords or other launch keys', () => {
    const saved = { ...client, additionalParameters: '/DisableStartupMessages' };
    const remote = { ...profile(saved), additionalParameters: '/DisableStartupMessages /N"Tester" /P"private"' };
    assert.equal(reconcileVanessaClient(saved, [remote]).state, 'added');
    assert.equal(reconcileVanessaClient(saved, [{ ...remote, additionalParameters: '/DisableStartupMessages /N"Tester" /P"changed"' }]).state, 'outdated');
    assert.equal(reconcileVanessaClient(saved, [{ ...remote, additionalParameters: '/N"Tester" /P"private"' }]).state, 'outdated');
});
