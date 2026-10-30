import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parseVanessaVariables, VanessaRuntimeVariables } from '../src/vanessaControlVariables';

const reply = (text: string) => ({ content: [{ type: 'text', text }] });
const listing = '# Переменные контекста\n\n## Контекст ($var$)\n- `Same` = 42\n\n## Сохраняемый контекст ($$var$$)\n- `Same` = да';

test('captured live .45 runtime context is readable while the test client is disconnected', () => {
    const captured = fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/variables.live.ru.md', 'utf8');
    assert.deepEqual(parseVanessaVariables(reply(captured)), [{ scope: 'local', name: 'KOTProbe', representation: '1' }]);
});

test('runtime variables preserve scope and textual representations without inventing types', () => {
    assert.deepEqual(parseVanessaVariables(reply(listing)), [
        { scope: 'local', name: 'Same', representation: '42' },
        { scope: 'global', name: 'Same', representation: 'да' }
    ]);
    assert.deepEqual(parseVanessaVariables(reply('# Переменные контекста\n\n## Контекст ($var$)\n\n## Сохраняемый контекст ($$var$$)\nПеременных нет.')), []);
    assert.deepEqual(parseVanessaVariables(reply('# Переменные контекста\n\nПеременных нет.')), [], 'an uninitialized context is a known empty formatter response');
    for (const text of [listing + '\nother text', listing + '\n- `Same` = duplicate', listing.replace('## Контекст ($var$)', '## Unknown'),
        listing.replace('42', 'value\nwith a new line'), '# Переменные контекста']) {
        assert.throws(() => parseVanessaVariables(reply(text)));
    }
    assert.throws(() => parseVanessaVariables({ ...reply(listing), isError: true }));
});

test('set sends only a string with explicit scope and verifies the observed value', async () => {
    const requests: unknown[] = []; let value = '42';
    const vars = new VanessaRuntimeVariables({ request: async args => {
        requests.push(args);
        if (args.action === 'get') { return reply(listing.replace('42', value)); }
        value = args.value as string; return reply('# Переменная установлена\n\n- Имя: Same\n- Значение: new');
    } });
    await vars.set('local', 'Same', 'new', '42');
    assert.deepEqual(requests, [{ action: 'get' }, { action: 'set', name: 'Same', value: 'new', is_global: false }, { action: 'get' }]);
    await assert.rejects(vars.set('local', 'Same', true as unknown as string, 'new'));
    assert.equal(requests.length, 3, 'invalid type is refused before any MCP request');
    await assert.rejects(vars.set('local', 'Same', 'new\nline', 'new'));
});

test('stale edits and create collisions never overwrite runtime values', async () => {
    const requests: unknown[] = [];
    const vars = new VanessaRuntimeVariables({ request: async args => { requests.push(args); return reply(listing); } });
    await assert.rejects(vars.set('local', 'Same', 'replacement', 'old'), /changed/u);
    await assert.rejects(vars.set('global', 'Same', 'replacement', undefined), /changed/u);
    assert.deepEqual(requests, [{ action: 'get' }, { action: 'get' }]);
});

test('global deletion is explicitly unavailable; local deletion verifies absence in the same scope', async () => {
    const requests: unknown[] = []; let removed = false;
    const vars = new VanessaRuntimeVariables({ request: async args => {
        requests.push(args);
        if (args.action === 'delete') { removed = true; return reply('# Переменная удалена\n\n- Имя: Same'); }
        return reply(removed ? listing.replace('- `Same` = 42', '') : listing);
    } });
    await assert.rejects(vars.delete('global', 'Same', 'да'), /global/u); assert.equal(requests.length, 0);
    await vars.delete('local', 'Same', '42');
    assert.deepEqual(requests, [{ action: 'get' }, { action: 'delete', name: 'Same', is_global: false }, { action: 'get' }]);
});

test('partial results, old-session responses and raw failures are never reported as applied or echoed', async () => {
    let count = 0;
    const partial = new VanessaRuntimeVariables({ request: async args => { count++; return args.action === 'get' ? reply(listing) : reply('Success'); } });
    await assert.rejects(partial.set('global', 'Same', 'new', 'да'), /not confirmed/u); assert.equal(count, 3);
    let current = true;
    const stale = new VanessaRuntimeVariables({ isCurrent: () => current, request: async () => { current = false; return reply(listing); } });
    await assert.rejects(stale.list(), /session changed/u);
    const failed = new VanessaRuntimeVariables({ request: async () => { throw new Error('secret runtime value'); } });
    await assert.rejects(failed.list(), error => !String(error).includes('secret runtime value'));
});
