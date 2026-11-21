import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as launch from '../src/vanessaLaunchJson';

async function editor(fail = false) {
    let receive!: (message: unknown) => Promise<void>;
    const commands: Array<{ name: string; source: any }> = []; const messages: any[] = [];
    let creates = 0; let reveals = 0;
    const panel = { reveal: () => { reveals++; }, onDidDispose() {}, webview: {
        html: '', postMessage: async (message: unknown) => { messages.push(message); },
        onDidReceiveMessage: (handler: typeof receive) => { receive = handler; }
    } };
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/yamlParametersManager.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => {
            if (name === './kotInteraction') { return nativeInteraction; }
        if (name === 'vscode') { return { ViewColumn: { One: 1 }, Uri: { joinPath: () => ({}) },
            window: { createWebviewPanel: () => { creates++; return panel; }, showErrorMessage() {} },
            commands: { executeCommand: async (name: string, source: unknown) => { commands.push({ name, source }); if (fail) { throw new Error('Unavailable'); } } } }; }
        if (name === './vanessaLaunchJson.js') { return launch; }
        if (name === 'path' || name === 'fs') { return require(name); }
        return {};
    } });
    const manager = Object.create(module.exports.YamlParametersManager.prototype);
    manager.loadLocalizationBundleIfNeeded = async () => {};
    manager.loadParametersState = async () => ({ activeProfileId: 'saved', profiles: [] });
    manager.getActiveProfileFromState = () => ({ buildParameters: [], additionalVanessaParameters: [], globalVanessaVariables: [] });
    manager.getWebviewContent = async () => '<main>Current editor</main>';
    manager.getWorkspaceRootPath = () => path.resolve('project'); manager.t = (text: string) => text;
    await manager.openYamlParametersPanel('additional');
    return { manager, panel, commands, messages, receive: (message: unknown) => receive(message), creates: () => creates, reveals: () => reveals };
}

test('the parameters editor sends current typed Additional rows to the session menu without exporting a temporary file', async () => {
    const h = await editor();
    const rows = [
        { key: 'useaddin', value: 'false', valueKind: 'boolean', overrideExisting: false },
        { key: 'filtertags', value: '["Smoke"]', valueKind: 'array', overrideExisting: false },
        { key: 'Custom.Code', value: '0012', valueKind: 'string', overrideExisting: false }
    ];
    await h.receive({ command: 'openVanessaSessionSettings', profileName: 'Currently selected', additionalVanessaParameters: rows });
    assert.equal(h.commands.length, 1); assert.equal(h.commands[0].name, 'kotTestToolkit.vanessaControl.settings');
    assert.equal(h.commands[0].source.profileName, 'Currently selected');
    assert.equal(h.commands[0].source.basePath, path.resolve('project'));
    assert.deepEqual(JSON.parse(h.commands[0].source.parameters), { useaddin: false, filtertags: ['Smoke'], Custom: { Code: '0012' } });
    assert.equal(rows[0].overrideExisting, false, 'session preview must not rewrite profile priority flags');
    assert.equal(h.messages.at(-1).command, 'vanessaSessionSettingsClosed');
});

test('return navigation reuses the existing editor and selects its Additional tab', async () => {
    const h = await editor(); await h.manager.openYamlParametersPanel('additional');
    assert.equal(h.creates(), 1); assert.equal(h.reveals(), 1);
    assert.equal(h.panel.webview.html, '<main>Current editor</main>');
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), { command: 'selectTab', tab: 'additional' });
});

test('a failed session operation releases the editor action for retry', async () => {
    const h = await editor(true);
    await h.receive({ command: 'openVanessaSessionSettings', additionalVanessaParameters: [] });
    assert.equal(h.messages.at(-1).command, 'vanessaSessionSettingsClosed');
});
