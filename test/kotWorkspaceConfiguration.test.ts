import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as settings from '../src/kotSettingsSession';

function fixture(multiRoot = false, workspaceFile = multiRoot, afterUpdate?: (layers: settings.ConfigurationLayers) => void) {
    const folder = { uri: { toString: () => 'file:///project' } };
    const layers: settings.ConfigurationLayers = { defaultValue: 'en', globalValue: 'ru', workspaceValue: 'en' };
    const targets: number[] = [];
    const host = { ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }, workspace: {
        workspaceFolders: multiRoot ? [folder, { uri: { toString: () => 'file:///second' } }] : [folder],
        workspaceFile: workspaceFile ? {} : undefined, isTrusted: true,
        // VS Code exposes the same single-folder settings file through both layers.
        getConfiguration: () => ({ inspect: () => ({ ...layers, workspaceFolderValue: !multiRoot && !workspaceFile ? layers.workspaceValue : layers.workspaceFolderValue }), update: async (_key: string, value: unknown, target: number) => {
            targets.push(target); layers[target === 1 ? 'globalValue' : target === 2 ? 'workspaceValue' : 'workspaceFolderValue'] = value;
            afterUpdate?.(layers);
        } })
    } };
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/kotWorkspaceConfiguration.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => name === 'vscode' ? host : settings });
    const api = module.exports as { createWorkspaceSettingsSession(model: unknown): settings.SettingsDraftSession };
    return { session: api.createWorkspaceSettingsSession({ settings: [{ key: 'kotTestToolkit.language', type: 'string', configScope: 'resource' }] }), layers, targets };
}

for (const scope of ['workspace', 'folder'] as const) {
    test(`single-folder ${scope} saves and resets the actual workspace layer without a false conflict`, async () => {
        const f = fixture(); const row = () => f.session.snapshot('file:///project', scope)[0];
        assert.equal(row().value, 'en'); assert.equal(row().explicit, true);
        await f.session.apply([{ key: row().key, scope, folder: 'file:///project', token: row().token, value: 'ru' }]);
        assert.equal(row().value, 'ru'); assert.equal(f.layers.workspaceValue, 'ru');
        await f.session.apply([{ key: row().key, scope, folder: 'file:///project', token: row().token, reset: true }]);
        assert.equal(row().value, 'ru'); assert.equal(row().explicit, false); assert.equal(row().source, 'user');
        assert.deepEqual(f.targets, [2, 2]);
    });
}

test('multi-root folder settings retain their own layer and inherit the workspace after reset', async () => {
    const f = fixture(true); const row = () => f.session.snapshot('file:///project', 'folder')[0];
    await f.session.apply([{ key: row().key, scope: 'folder', folder: 'file:///project', token: row().token, value: 'ru' }]);
    assert.equal(f.layers.workspaceValue, 'en'); assert.equal(row().value, 'ru');
    await f.session.apply([{ key: row().key, scope: 'folder', folder: 'file:///project', token: row().token, reset: true }]);
    assert.equal(row().value, 'en'); assert.deepEqual(f.targets, [3, 3]);
});

test('a code-workspace with one folder retains distinct workspace and folder settings', async () => {
    const f = fixture(false, true); const row = () => f.session.snapshot('file:///project', 'folder')[0];
    await f.session.apply([{ key: row().key, scope: 'folder', folder: 'file:///project', token: row().token, value: 'ru' }]);
    assert.equal(f.layers.workspaceValue, 'en');
    assert.equal(f.layers.workspaceFolderValue, 'ru');
    await f.session.apply([{ key: row().key, scope: 'folder', folder: 'file:///project', token: row().token, reset: true }]);
    assert.equal(row().value, 'en');
    assert.deepEqual(f.targets, [3, 3]);
});

test('single-folder scope normalization still rejects a real external change before saving', async () => {
    const f = fixture(); const row = f.session.snapshot('file:///project', 'folder')[0];
    f.layers.globalValue = 'en';
    await assert.rejects(f.session.apply([{ key: row.key, scope: 'folder', folder: 'file:///project', token: row.token, value: 'ru' }]), /changed outside/);
    assert.deepEqual(f.targets, []);
});

test('single-folder scope normalization still detects a concurrent external User change during saving', async () => {
    const f = fixture(false, false, layers => { layers.globalValue = 'external'; });
    const row = f.session.snapshot('file:///project', 'folder')[0];
    await assert.rejects(f.session.apply([{ key: row.key, scope: 'folder', folder: 'file:///project', token: row.token, value: 'ru' }]), error => {
        assert.match((error as settings.SettingsApplyError).message, /changed outside/);
        assert.deepEqual((error as settings.SettingsApplyError).applied, ['file:///project:folder:kotTestToolkit.language']);
        return true;
    });
});
