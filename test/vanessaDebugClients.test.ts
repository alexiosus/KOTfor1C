import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    applyVanessaManualDebugOverlay, VanessaDebugClientStore, writeVanessaDebugRuntimeJson,
    type VanessaDebugClient, type VanessaDebugClientSelection
} from '../src/vanessaDebugClients';

const client = (overrides: Partial<VanessaDebugClient> = {}): VanessaDebugClient => ({
    id: 'first', name: 'TestClient', infobase: '/bases/sales', username: '', password: '',
    synonym: '', clientType: 'Thin', computerName: 'localhost', port: 1538, additionalParameters: '', ...overrides
});

function storageFixture() {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const stateStorage = {
        get: <T>(key: string) => state.get(key) as T | undefined,
        update: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); }
    };
    const secretStorage = {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); }
    };
    return { state, secrets, stateStorage, secretStorage, store: new VanessaDebugClientStore(stateStorage, secretStorage) };
}

test('saved multi-client set survives a new store without persisting passwords or extra launch keys in workspace state', async () => {
    const f = storageFixture();
    const selection: VanessaDebugClientSelection = { mode: 'clients', clients: [
        client({ infobase: 'Srvr="localhost";Ref="sales";Usr="admin";Pwd="connection-secret";', username: 'admin', password: 'auth-secret', additionalParameters: '/P"extra-secret" /Debug' }),
        client({ id: 'second', name: 'Warehouse', infobase: 'File="/bases/warehouse";Pwd="file-secret";UserInfo="userinfo-secret";', port: 1539 })
    ] };
    await f.store.save(selection);
    const persisted = JSON.stringify([...f.state.values()]);
    for (const secret of ['connection-secret', 'auth-secret', 'file-secret', 'userinfo-secret', 'extra-secret', '/Debug']) {
        assert.equal(persisted.includes(secret), false);
    }
    assert.ok(persisted.includes('Warehouse'));
    assert.ok(persisted.includes('sales'));
    const restarted = new VanessaDebugClientStore(f.stateStorage, f.secretStorage);
    assert.deepEqual(await restarted.load(), selection);
    await restarted.save({ ...selection, mode: 'scenario' });
    assert.deepEqual(await restarted.load(), { ...selection, mode: 'scenario' });
    assert.equal(f.secrets.size, 1, 'replacing a set must remove its obsolete secret entry');
});

test('failed workspace state commit leaves the previous client set and its credentials reusable', async () => {
    const f = storageFixture();
    const previous: VanessaDebugClientSelection = { mode: 'clients', clients: [client({ password: 'old' })] };
    await f.store.save(previous);
    const failing = new VanessaDebugClientStore({ ...f.stateStorage, update: async () => { throw new Error('disk'); } }, f.secretStorage);
    await assert.rejects(failing.save({ mode: 'clients', clients: [client({ password: 'new' })] }));
    assert.deepEqual(await f.store.load(), previous);
    assert.equal(f.secrets.size, 1);
});

test('missing secure payload fails closed instead of silently dropping authentication', async () => {
    const f = storageFixture();
    await f.store.save({ mode: 'clients', clients: [client({ password: 'required' })] });
    f.secrets.clear();
    await assert.rejects(f.store.load(), /secure|credentials/iu);
});

test('manual debug overlay merges same-name Russian profiles, preserves field case and extra fields, and replaces the selected set', () => {
    const source = {
        ВыполнениеСценариев: { вЫпОлНиТьСценарии: true, ЗавершитьРаботуСистемы: true },
        КлиентТестирования: { ДанныеКлиентовТестирования: [
            { иМя: 'TestClient', пУтьКИнфобазе: 'old', ДопПараметры: 'old-password', CustomClientOption: 42 },
            { Имя: 'Unselected', ПутьКИнфобазе: 'old-second' }
        ] },
        GlobalVars: { ExecuteScenarios: 'business value', CloseSystemOnComplete: 'business value' }
    };
    const before = JSON.stringify(source);
    const result = applyVanessaManualDebugOverlay(source, { mode: 'clients', clients: [
        client({ username: 'admin', password: 's;"ecret' }),
        client({ id: 'second', name: 'Warehouse', port: 1539 })
    ] });
    assert.equal(JSON.stringify(source), before);
    const root = result as any;
    assert.equal(root.ВыполнениеСценариев.вЫпОлНиТьСценарии, false);
    assert.equal(root.ВыполнениеСценариев.ЗавершитьРаботуСистемы, false);
    const clients = root.КлиентТестирования.ДанныеКлиентовТестирования;
    assert.equal(clients.length, 2);
    assert.equal(clients[0].иМя, 'TestClient');
    assert.equal(clients[0].CustomClientOption, 42);
    assert.equal(clients[0].пУтьКИнфобазе, 'File="/bases/sales";');
    assert.equal(clients[0].ДопПараметры, '/N"admin" /P"s;""ecret"');
    assert.equal(clients[1].Имя, 'Warehouse');
    assert.equal(clients[1].ПортЗапускаТестКлиента, 1539);
    assert.equal(root.GlobalVars.ExecuteScenarios, 'business value');
});

test('a Windows file debug client keeps credentials out of the path Vanessa checks for existence', () => {
    const root = applyVanessaManualDebugOverlay({}, { mode: 'clients', clients: [
        client({ infobase: 'C:\\Mac\\Home\\Documents\\1C\\19999_SSL', username: 'Administrator' })
    ] }) as any;
    const selected = root.TestClient.datatestclients[0];
    assert.equal(selected.PathToInfobase, 'File="C:\\Mac\\Home\\Documents\\1C\\19999_SSL";');
    assert.equal(selected.AddItionalParameters, '/N"Administrator" /P""');
});

test('embedded server credentials move to launch keys with connection quoting decoded and unrelated keys retained', () => {
    const root = applyVanessaManualDebugOverlay({}, { mode: 'clients', clients: [
        client({ infobase: 'Srvr="server:1541";Ref="sales";Usr="Test User";Pwd="semi;""quoted""";', additionalParameters: '/NoSplash /Lru' })
    ] }) as any;
    const selected = root.TestClient.datatestclients[0];
    assert.equal(selected.PathToInfobase, 'Srvr="server:1541";Ref="sales";');
    assert.equal(selected.AddItionalParameters, '/N"Test User" /P"semi;""quoted""" /NoSplash /Lru');
});

test('explicit debug user fields override embedded credentials without changing the saved selection', () => {
    const selected = client({ infobase: 'File="/bases/sales";Usr="old";Pwd="old-password";', username: 'new', password: 'new-password' });
    const before = JSON.stringify(selected);
    const root = applyVanessaManualDebugOverlay({}, { mode: 'clients', clients: [selected] }) as any;
    assert.equal(root.TestClient.datatestclients[0].PathToInfobase, 'File="/bases/sales";');
    assert.equal(root.TestClient.datatestclients[0].AddItionalParameters, '/N"new" /P"new-password"');
    assert.equal(JSON.stringify(selected), before);
});

test('manual debug protects all RU/EN run aliases while scenario parameters retain the authored client data', () => {
    const source = {
        ExecuteScenarios: true, ВыполнитьСценарии: true, RunScenarios: true,
        CloseSystemOnComplete: true, ЗавершитьРаботуСистемы: true, QuitSystemOnComplete: true,
        RunningScripts: { RUNSCENARIOS: true, closeSystemOnComplete: true },
        TestClient: { datatestclients: [{ Name: 'Authored', PathToInfobase: '/old' }], CloseTestClient: true }
    };
    const result = applyVanessaManualDebugOverlay(source, { mode: 'scenario', clients: [] }) as any;
    for (const key of ['ExecuteScenarios', 'ВыполнитьСценарии', 'RunScenarios', 'CloseSystemOnComplete', 'ЗавершитьРаботуСистемы', 'QuitSystemOnComplete']) {
        assert.equal(result[key], false);
    }
    assert.equal(result.RunningScripts.RUNSCENARIOS, false);
    assert.equal(result.RunningScripts.closeSystemOnComplete, false);
    assert.equal(result.TestClient.CloseTestClient, false);
    assert.deepEqual(result.TestClient.datatestclients, source.TestClient.datatestclients);
});

test('English profiles are merged by name and every client receives its own connection and port', () => {
    const result = applyVanessaManualDebugOverlay({ TESTCLIENT: { DATATESTCLIENTS: [{ NAME: 'testclient', PathtoInfobase: 'old', Custom: 'preserved' }] } }, {
        mode: 'clients', clients: [client(), client({ id: 'second', name: 'Other', infobase: 'Srvr="server";Ref="base";', port: 1539 })]
    }) as any;
    assert.equal(result.TESTCLIENT.DATATESTCLIENTS[0].Custom, 'preserved');
    assert.equal(result.TESTCLIENT.DATATESTCLIENTS[0].NAME, 'TestClient');
    assert.equal(result.TESTCLIENT.DATATESTCLIENTS[1].Name, 'Other');
    assert.equal(result.TESTCLIENT.DATATESTCLIENTS[1].PathToInfobase, 'Srvr="server";Ref="base";');
    assert.equal(result.TESTCLIENT.DATATESTCLIENTS[1].PortTestClient, 1539);
});

test('client overlays update every duplicate RU/EN alias so Vanessa cannot retain an old connection or password', () => {
    const source = { TestClient: { datatestclients: [{
        Name: 'TestClient', Имя: 'TestClient', PathToInfobase: '/old-en', ПутьКИнфобазе: '/old-ru',
        AddItionalParameters: '/Pold-en', ДопПараметры: '/Pold-ru'
    }] } };
    const result = applyVanessaManualDebugOverlay(source, { mode: 'clients', clients: [client()] }) as any;
    const selected = result.TestClient.datatestclients[0];
    assert.equal(selected.PathToInfobase, 'File="/bases/sales";');
    assert.equal(selected.ПутьКИнфобазе, 'File="/bases/sales";');
    assert.equal(selected.AddItionalParameters, '');
    assert.equal(selected.ДопПараметры, '');
});

test('malformed connection strings cannot be persisted as plaintext file paths', async () => {
    const f = storageFixture();
    await assert.rejects(f.store.save({ mode: 'clients', clients: [client({ infobase: 'Srvr="server";Pwd="secret";' })] }));
    assert.equal(f.state.size, 0);
    assert.equal(f.secrets.size, 0);
});

test('runtime JSON uses an ignored private directory and atomic private file, leaves source bytes unchanged, and cleans up', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-debug-params-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, 'custom launch settings.json');
    const original = '\uFEFF' + JSON.stringify({ ExecuteScenarios: true });
    fs.writeFileSync(sourcePath, original);
    const content = applyVanessaManualDebugOverlay({ ExecuteScenarios: true }, { mode: 'clients', clients: [client({ password: 'private' })] });
    const runtime = await writeVanessaDebugRuntimeJson(path.join(root, 'runtime'), 'a custom debug name', content);
    assert.notEqual(runtime.path, sourcePath);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
    assert.equal(JSON.parse(fs.readFileSync(runtime.path, 'utf8')).ExecuteScenarios, false);
    assert.equal(fs.statSync(runtime.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(runtime.path)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.dirname(runtime.path)), ['VAParams.json']);
    assert.equal(fs.readFileSync(path.join(root, 'runtime', 'debug-params', '.gitignore'), 'utf8').trim(), '*');
    await runtime.dispose();
    assert.equal(fs.existsSync(runtime.path), false);
});
