import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseKotWorkspaceRequest } from '../src/kotWorkspaceProtocol';

test('sidebar resource links open the fixed repository and the installed extension changelog', async () => {
    const opened: unknown[] = []; const commands: unknown[][] = [];
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/kotWorkspacePanel.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, process, require: (name: string) => {
        if (name === 'vscode') { return { Uri: { parse: (uri: string) => uri, joinPath: (base: string, file: string) => `${base}/${file}` },
            workspace: { fs: { stat: async (uri: string) => { if (!uri.endsWith('/changelog.md')) { throw new Error('Not found'); } return {}; } } },
            env: { openExternal: async (uri: unknown) => { opened.push(uri); return true; } },
            commands: { executeCommand: async (...args: unknown[]) => { commands.push(args); } } }; }
        return name.startsWith('node:') ? require(name) : {};
    } });
    const panel = Object.create(module.exports.KotWorkspacePanel.prototype);
    panel.context = { extensionUri: 'installed-extension' };
    for (const type of ['openRepository', 'openChangelog', 'openFileWorkshopDownload']) {
        await panel.dispatch(parseKotWorkspaceRequest({ id: '1', type, value: 'https://untrusted.invalid/CHANGELOG.md' }, []));
    }
    assert.deepEqual(opened, ['https://github.com/alexiosus/KOTfor1C', 'https://v8.1c.ru/static/1s-predpriyatie-rabota-s-faylami/']);
    assert.deepEqual(commands, [['markdown.showPreview', 'installed-extension/changelog.md']]);
});
