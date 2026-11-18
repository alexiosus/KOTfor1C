import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseVanessaClientProfiles, prepareVanessaClientProfile, VanessaRuntimeClients, VanessaClientControlError, formatVanessaClientError } from '../src/vanessaControlClients';
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

test('live .47 profiles accept both Russian spellings of connected and disconnected', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'test/fixtures/vanessa-control/1.2.043.47/clients-disconnected.live.ru.md'), 'utf8');
    for (const [status, connected] of [['❌ не подключён', false], ['❌ не подключен', false], ['✅ подключён', true], ['✅ подключен', true]] as const) {
        const profiles = parseVanessaClientProfiles(reply(source.replace('❌ не подключён', status)));
        assert.equal(profiles.length, 1);
        assert.equal(profiles[0].connected, connected, status);
        assert.equal(profiles[0].port, 1538);
        assert.equal(profiles[0].pid, 0);
    }
    for (const status of ['подключён', '✅ подключён?', '❌ не подключён (возможно)', '⏳ подключается']) {
        assert.throws(() => parseVanessaClientProfiles(reply(source.replace('❌ не подключён', status))), /profile list/u);
    }
});

test('profile tables tolerate reordered fields, added metadata and changed Markdown decoration', async () => {
    const source = (await fs.readFile('test/fixtures/vanessa-control/1.2.043.47/clients-disconnected.live.ru.md', 'utf8')).replace(/\r\n/gu, '\n');
    const changed = source.replace(/^(?:\|[^\n]+\|\n)+/mu, table => {
        const rows = table.trim().split('\n');
        return [rows[0], '| :--- | ---: |', ...rows.slice(2).reverse().map(row => row.replace(/^\| ([^|]+) \|/u, '|   $1   |')),
            '| Версия клиента | 8.3.27 |', '| Источник профиля | Локальный |', ''].join('\n');
    }) + '\n## Подсказка\nНовый поясняющий текст Vanessa.\n';
    assert.notEqual(changed, source);
    assert.deepEqual(parseVanessaClientProfiles(reply(changed)), parseVanessaClientProfiles(reply(source)));
    for (const text of [source.replace('| PID |', '| Неизвестный PID |'), source.replace('| Статус |', '| Имя |'),
        source.replace('| Порт | 1538 |', '| Порт | 65536 |'), source.replace('| PID | 0 |', '| PID | 0 |\n| PID | 1 |')]) {
        assert.throws(() => parseVanessaClientProfiles(reply(text)), /profile list/u);
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
    await assert.rejects(unchanged.connect(client.name), error => error instanceof VanessaClientControlError && /did not connect/u.test(error.message) && error.details === 'connected successfully');
});

test('applying a profile verifies equivalent spaced authentication without reporting a false failure', async () => {
    let applied = false;
    const runtime = new VanessaRuntimeClients({ request: async operation => {
        if (operation === 'list') { return applied ? list([{ extra: '/N "KOT" /P "test password" /NoSplash' }]) : reply(empty); }
        applied = true; return reply('applied');
    } });
    await runtime.apply(client, true);
});

test('connection failures preserve the sanitized Vanessa response separately from the translated summary', async () => {
    const license = 'Your license SMUA has expired. Pay extension fees, then refresh your license data.';
    for (const failure of [reply(license), { ...reply('Ошибка подключения\n' + license + '\n/P"test password"\nRejected value: test password'), isError: true },
        { ...reply(JSON.stringify({ error: { message: license }, password: 'test password' })), isError: true }]) {
        const runtime = new VanessaRuntimeClients({ request: async operation => operation === 'list' ? list() : failure });
        await assert.rejects(runtime.connect(client.name), error => {
            assert.ok(error instanceof VanessaClientControlError);
            assert.ok(error.details?.includes(license));
            assert.ok(!error.details?.includes('test password'));
            const formatted = formatVanessaClientError(error, () => 'Локализованная ошибка');
            assert.ok(formatted.startsWith('Локализованная ошибка\n\n'));
            assert.ok(formatted.includes(license));
            return true;
        });
    }
});

test('catalog operations reject profiles replaced between preview and mutation', async () => {
    const expected = parseVanessaClientProfiles(list())[0]; let writes = 0;
    const runtime = new VanessaRuntimeClients({ request: async operation => {
        if (operation === 'list') { return list([{ connection: 'File="C:\\Different";' }]); }
        writes++; return reply('unexpected mutation');
    } });
    await assert.rejects(runtime.apply(client, true, expected), /changed|Refresh/u);
    await assert.rejects(runtime.apply(client, true, null), /appeared|Refresh/u);
    await assert.rejects(runtime.connect(client.name, expected), /changed|Refresh/u);
    assert.equal(writes, 0);
});

test('close confirms its profile and status plus disconnected state, independently of help text', async () => {
    const closed = reply('# Клиент тестирования закрыт\n\n- Профиль: KOT fixture\n- Статус: закрыт успешно\n\n## Следующие шаги\n- Используйте `manage_test_client` с `action: connect` для повторного подключения');
    for (const response of [closed, reply(closed.content[0].text.split('\n## ')[0]),
        reply(closed.content[0].text.replace('## Следующие шаги', '## Новый раздел').replace('для повторного подключения', 'для открытия клиента'))]) {
        let connected = true;
        const runtime = new VanessaRuntimeClients({ request: async operation => {
            if (operation === 'list') { return reply(list([{ connected }]).content[0].text.replace('| PID | 0 |', '| PID | 314 |')); }
            connected = false; return response;
        } });
        await runtime.close(client.name);
    }
    for (const response of [reply('success'), { ...closed, isError: true },
        reply(closed.content[0].text.replace('Профиль: KOT fixture', 'Профиль: Other')),
        reply(closed.content[0].text.replace('- Статус: закрыт успешно', '- Статус: закрыт успешно\n- Статус: ошибка')),
        reply(closed.content[0].text.replace('- Профиль: KOT fixture', '- Профиль: KOT fixture\n- Профиль: Other'))]) {
        const runtime = new VanessaRuntimeClients({ request: async operation => operation === 'list' ? list() : response });
        await assert.rejects(runtime.close(client.name), /not confirmed/u);
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
