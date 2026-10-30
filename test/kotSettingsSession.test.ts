import assert from 'node:assert/strict';
import test from 'node:test';
import { SettingsDraftSession, type ConfigurationLayers, type SettingsAdapter } from '../src/kotSettingsSession';
import { portableSettingPath } from '../src/kotSettingsPaths';

function fixture() {
    const values = new Map<string, ConfigurationLayers>();
    values.set('second:buttons', { defaultValue: false, globalValue: true, workspaceValue: false, workspaceFolderValue: true });
    const writes: unknown[] = [];
    const adapter: SettingsAdapter = {
        inspect: (key, folder) => values.get(`${folder}:${key}`) ?? {},
        update: async (key, value, scope, folder) => {
            writes.push([key, value, scope, folder]);
            const layers = values.get(`${folder}:${key}`) ?? {};
            values.set(`${folder}:${key}`, { ...layers, [scope === 'user' ? 'globalValue' : scope === 'workspace' ? 'workspaceValue' : 'workspaceFolderValue']: value });
        }
    };
    const definitions = [
        { key: 'buttons', type: 'boolean', default: false },
        { key: 'delay', type: 'number', default: 1, minimum: 0, maximum: 60 },
        { key: 'checks', type: 'array', default: [], uniqueItems: true, items: { type: 'string', enum: ['unknownStep', 'missingParameter'] } },
        { key: 'secret', type: 'string', default: '', secret: true }
    ];
    return { session: new SettingsDraftSession(definitions, adapter), adapter, values, writes };
}

test('reset removes only the selected folder override and reveals the workspace value', async () => {
    const f = fixture(); const before = f.session.snapshot('second', 'folder').find(row => row.key === 'buttons')!;
    assert.equal(before.value, true);
    assert.equal(before.inheritedValue, false);
    await f.session.apply([{ key: 'buttons', folder: 'second', scope: 'folder', token: before.token, reset: true }]);
    assert.deepEqual(f.writes, [['buttons', undefined, 'folder', 'second']]);
    const after = f.session.snapshot('second', 'folder').find(row => row.key === 'buttons')!;
    assert.equal(after.value, false); assert.equal(after.source, 'workspace');
});

test('validates the complete batch before writing and rejects unknown codes, types and out-of-range values', async () => {
    const f = fixture(); const rows = f.session.snapshot('second', 'folder');
    const change = (key: string, value: unknown) => ({ key, value, folder: 'second', scope: 'folder' as const, token: rows.find(row => row.key === key)!.token });
    for (const invalid of [change('checks', ['madeUp']), change('delay', -1), change('delay', 61), change('buttons', 'true'), change('checks', ['unknownStep', 'unknownStep'])]) {
        await assert.rejects(f.session.apply([change('buttons', false), invalid]));
        assert.equal(f.writes.length, 0);
    }
    await assert.rejects(f.session.apply([{ ...change('buttons', false), key: '__proto__' }]));
});

test('a change in another scope conflicts instead of overwriting an old draft', async () => {
    const f = fixture(); const row = f.session.snapshot('second', 'folder')[0];
    f.values.get('second:buttons')!.globalValue = false;
    await assert.rejects(f.session.apply([{ key: row.key, value: false, folder: 'second', scope: 'folder', token: row.token }]), /changed/i);
    assert.equal(f.writes.length, 0);
});

test('partial update failure reports applied keys and retry cannot replay an already applied baseline', async () => {
    const f = fixture(); const update = f.adapter.update;
    f.adapter.update = async (...args) => { if (args[0] === 'delay') { throw new Error('read only'); } await update(...args); };
    const rows = f.session.snapshot('second', 'folder');
    const changes = ['buttons', 'delay'].map(key => ({ key, value: key === 'buttons' ? false : 2, folder: 'second', scope: 'folder' as const, token: rows.find(row => row.key === key)!.token }));
    await assert.rejects(f.session.apply(changes), error => {
        assert.deepEqual((error as { applied: unknown }).applied, ['second:folder:buttons']); return true;
    });
    assert.equal(f.writes.length, 1);
    await assert.rejects(f.session.apply(changes), /changed/i);
    assert.equal(f.writes.length, 1);
});

test('secret values never appear in the settings snapshot', () => {
    const f = fixture(); f.values.set('second:secret', { globalValue: 'do-not-send-to-webview' });
    const row = f.session.snapshot('second', 'user').find(row => row.key === 'secret')!;
    assert.equal(row.value, ''); assert.equal(row.configured, true);
    assert.ok(!JSON.stringify(row).includes('do-not-send'));
});

test('picker paths use the chosen project root, respect Windows boundaries and keep external machine paths absolute', () => {
    assert.equal(portableSettingPath('C:\\Work\\Second', 'c:\\work\\Second\\libraries', 'relative', 'folder', 'win32'), 'libraries');
    assert.equal(portableSettingPath('C:\\Work\\Second', 'C:\\Work\\Second-copy\\lib', 'relative', 'folder', 'win32'), 'C:\\Work\\Second-copy\\lib');
    assert.equal(portableSettingPath('C:\\Work\\Second', 'D:\\Vanessa\\va.epf', 'relative', 'folder', 'win32'), 'D:\\Vanessa\\va.epf');
    assert.equal(portableSettingPath('/second', '/second/lib', 'relative', 'user'), '/second/lib');
    assert.throws(() => portableSettingPath('/second', '/first/compiler.epf', 'project', 'folder'), /inside/i);
    assert.equal(portableSettingPath('/second', '/second', 'relative', 'folder'), '.');
});

test('a batch may change two scopes of the same setting without conflicting with its own first write', async () => {
    const f = fixture(); const token = f.session.snapshot('second', 'folder')[0].token;
    await f.session.apply([{ key: 'buttons', folder: 'second', scope: 'user', token, value: false }, { key: 'buttons', folder: 'second', scope: 'folder', token, reset: true }]);
    assert.deepEqual(f.writes, [['buttons', false, 'user', 'second'], ['buttons', undefined, 'folder', 'second']]);
});
