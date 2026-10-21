import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseVanessaClientProfiles, prepareVanessaClientProfile, VanessaRuntimeClients } from '../src/vanessaControlClients';
import type { VanessaDebugClient } from '../src/vanessaDebugClients';

const client: VanessaDebugClient = { id: 'own', name: 'KOT fixture', infobase: 'File="C:\\KOT fixture";Usr="embedded";Pwd="secret";',
    username: 'KOT', password: 'test password', additionalParameters: '/NoSplash', synonym: 'KOT alias', clientType: 'Thin', computerName: 'localhost', port: 1539 };
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const empty = '# Список профилей клиентов тестирования\n\nПрофили не настроены. Добавьте профиль на вкладке \'Клиенты тестирования\' в настройках VA.';
const list = (rows: Array<{ name?: string; connected?: boolean; connection?: string; extra?: string; synonym?: string }> = [{}]) => reply(
    '# Список профилей клиентов тестирования\n\nНайдено профилей: ' + rows.length + '\n\n' + rows.map(row =>
        `## Профиль: ${row.name ?? client.name}\n\n| Свойство | Значение |\n|----------|----------|\n| Имя | ${row.name ?? client.name} |\n` +
        `| Синоним | ${row.synonym ?? client.synonym} |\n| Строка подключения | ${row.connection ?? 'File="C:\\KOT fixture";'} |\n` +
        `| Дополнительные параметры | ${row.extra ?? '/N"KOT" /P"test password" /NoSplash'} |\n| Тип клиента | Тонкий |\n` +
        `| Имя компьютера | localhost |\n| Дескриптор окна | 0 |\n| PID | 0 |\n| Статус | ${row.connected ? '✅ подключен' : '❌ не подключен'} |\n`).join('\n'));

test('profile lists retain live fields in memory, with strict counts, identities and status', () => {
    assert.deepEqual(parseVanessaClientProfiles(reply(empty)), []);
    const profiles = parseVanessaClientProfiles(list([{}, { name: 'Second', connected: true, synonym: 'Second alias' }]));
    assert.equal(profiles.length, 2); assert.equal(profiles[0].name, client.name);
    assert.equal(profiles[0].connected, false); assert.equal(profiles[1].connected, true);
    for (const invalid of [list([{}, {}]), reply(list().content[0].text.replace('Найдено профилей: 1', 'Найдено профилей: 2')),
        reply(list().content[0].text.replace('❌ не подключен', 'maybe')), list([{ connection: 'file|broken' }]),
        { ...list(), isError: true }, reply('Unknown formatter')]) {
        assert.throws(() => parseVanessaClientProfiles(invalid), /profile list/u);
    }
});

test('runtime profile fields reuse the Debug connection/authentication serialization and disclose unsupported port', () => {
    const prepared = prepareVanessaClientProfile(client);
    assert.equal(prepared.fields.infobase_path, 'File="C:\\KOT fixture";');
    assert.equal(prepared.fields.additional_parameters, '/N"KOT" /P"test password" /NoSplash');
    assert.equal(prepared.fields.client_type, 'Тонкий');
    assert.deepEqual(prepared.unsupportedFields, ['port']);
    assert.equal(client.port, 1539); assert.ok(!Object.hasOwn(prepared.fields, 'port'));
});

test('applying a saved profile requires explicit port acknowledgement and verifies every supported field after one write', async () => {
    const calls: string[] = []; let rows = reply(empty);
    const runtime = new VanessaRuntimeClients({ request: async (action, fields) => {
        calls.push(action);
        if (action === 'list') { return rows; }
        assert.equal(action, 'add'); assert.equal(fields?.name, client.name); rows = list(); return reply('accepted');
    } });
    await assert.rejects(runtime.apply(client, false), /port/u); assert.deepEqual(calls, []);
    assert.deepEqual(await runtime.apply(client, true), { applied: true, unsupportedFields: ['port'] });
    assert.deepEqual(calls, ['list', 'add', 'list']);
});

test('partial/unknown application is not success and is never retried; connected profiles cannot be overwritten', async () => {
    let writes = 0;
    const partial = new VanessaRuntimeClients({ request: async action => {
        if (action !== 'list') { writes++; return reply('success'); }
        return writes ? list([{ extra: 'not applied' }]) : reply(empty);
    } });
    await assert.rejects(partial.apply(client, true), /not confirmed/u); assert.equal(writes, 1);
    const connected = new VanessaRuntimeClients({ request: async action => { assert.equal(action, 'list'); return list([{ connected: true }]); } });
    await assert.rejects(connected.apply(client, true), /Disconnect/u);
});

test('cancelled or changed-session operations stop before mutation and tool errors do not expose credentials', async () => {
    let current = true; const calls: string[] = [];
    const stale = new VanessaRuntimeClients({ isCurrent: () => current, request: async action => {
        calls.push(action); current = false; return reply(empty);
    } });
    await assert.rejects(stale.apply(client, true), /session changed/u); assert.deepEqual(calls, ['list']);
    const failed = new VanessaRuntimeClients({ request: async () => { throw new Error('remote password test password'); } });
    await assert.rejects(failed.list(), error => error instanceof Error && error.message === 'The Vanessa client operation was not confirmed.');
});

test('connect/disconnect/close confirm profile state instead of trusting success prose', async () => {
    for (const action of ['connect', 'disconnect', 'close'] as const) {
        let connected = action !== 'connect'; let writes = 0;
        const runtime = new VanessaRuntimeClients({ request: async operation => {
            if (operation === 'list') { return list([{ connected }]); }
            assert.equal(operation, action); writes++; connected = action === 'connect';
            return reply(action === 'close' ? '# Клиент тестирования закрыт\n\n- Профиль: KOT fixture\n- Статус: закрыт успешно\n\n## Следующие шаги\n- Используйте `manage_test_client` с `action: connect` для повторного подключения' : 'anything');
        } });
        await runtime[action](client.name); assert.equal(writes, 1);
    }
    const unchanged = new VanessaRuntimeClients({ request: async operation => operation === 'list' ? list() : reply('connected successfully') });
    await assert.rejects(unchanged.connect(client.name), /not confirmed/u);
});

test('close confirms the exact upstream completion reply and disconnected state, because Vanessa retains the old PID', async () => {
    const closed = reply('# Клиент тестирования закрыт\n\n- Профиль: KOT fixture\n- Статус: закрыт успешно\n\n## Следующие шаги\n- Используйте `manage_test_client` с `action: connect` для повторного подключения');
    for (const valid of [true, false]) {
        let connected = true;
        const runtime = new VanessaRuntimeClients({ request: async operation => {
            if (operation === 'list') { return reply(list([{ connected }]).content[0].text.replace('| PID | 0 |', '| PID | 314 |')); }
            connected = false; return valid ? closed : reply('success');
        } });
        if (valid) { await runtime.close(client.name); }
        else { await assert.rejects(runtime.close(client.name), /not confirmed/u); }
    }
});


test('the captured .45 client table is parsed without assuming synthetic-only spacing or values', async () => {
    const text = await fs.readFile(path.resolve('test/fixtures/vanessa-control/1.2.043.45/clients.live.ru.md'), 'utf8');
    const profiles = parseVanessaClientProfiles(reply(text));
    assert.deepEqual(profiles.map(profile => [profile.name, profile.connected]), [['Этот клиент', false], ['TestClient', false]]);
});


test('live connected profiles parse localized integer PIDs and reject decimals or inconsistent grouping', async () => {
    const text = await fs.readFile(path.resolve('test/fixtures/vanessa-control/1.2.043.45/clients-connected.live.ru.md'), 'utf8');
    const selected = parseVanessaClientProfiles(reply(text)).find(profile => profile.name === 'KOT owned first');
    assert.equal(selected?.connected, true); assert.equal(selected?.pid, 18124);
    for (const grouped of ['18 124', '18\u00a0124', '18\u202f124']) {
        assert.equal(parseVanessaClientProfiles(reply(text.replace('18,124', grouped)))[2].pid, 18124);
    }
    for (const invalid of ['18,12', '18.124', '18,124 001', '1,23,456']) {
        assert.throws(() => parseVanessaClientProfiles(reply(text.replace('18,124', invalid))), /profile list/u);
    }
});
