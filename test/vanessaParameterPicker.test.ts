import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as launch from '../src/vanessaLaunchJson';
import * as compiler from '../src/compilerBuildParameters';
import { VANESSA_PARAMETER_CATALOG } from '../src/vanessaParameterCatalog.generated';
import { getDefaultAdditionalVanessaParameters } from '../src/yamlParameterDefaults';
import { createVanessaParameterFieldDefinitions } from '../src/vanessaParameterCatalog';

test('native parameter picker supports searchable source keys, alias deduplication, custom paths and cancellation', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const module = { exports: {} as any }; const messages: any[] = [];
    let mode = 'known'; let requestedFolder = '';
    const host = { workspace: {}, window: {
        showQuickPick: async (items: any[], options: any) => {
            assert.equal(options.matchOnDescription, true); assert.equal(options.matchOnDetail, true);
            assert.equal(items.some(item => item.label === 'ИспользоватьКомпонентуVanessaExt'), false);
            if (mode === 'cancel') { return undefined; }
            return mode === 'custom' ? items[0] : items.find(item => item.label === 'ПоказыватьПомощникПриПервомЗапуске');
        },
        showInputBox: async (options: any) => {
            assert.ok(options.validateInput('useaddin')); assert.ok(options.validateInput(''));
            assert.equal(options.validateInput('Custom.Nested'), undefined); return 'Custom.Nested';
        },
        showErrorMessage: (message: string) => assert.fail(message)
    } };
    const dependencies: Record<string, unknown> = { vscode: host, path, './compilerBuildParameters': compiler,
        './vanessaLaunchJson.js': launch, './vanessaParameterCatalog.js': { createVanessaParameterFieldDefinitions, loadVanessaParameterCatalogSnapshot: async (folder: string) => {
            requestedFolder = folder; return { definitions: VANESSA_PARAMETER_CATALOG, authoritative: false };
        } } };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/yamlParametersManager.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, console, require: (name: string) => dependencies[name] ?? {} });
    const manager = Object.create(module.exports.YamlParametersManager.prototype);
    manager.t = (message: string) => message;
    manager.loadActiveProfileSnapshot = async () => ({ buildParameters: [{ key: 'VanessaFolder', value: '/tools/vanessa' }] });
    const panel = { webview: { postMessage: async (message: unknown) => messages.push(message) } };
    await manager.selectAdditionalParameter(panel, ['useaddin']);
    assert.equal(requestedFolder, '/tools/vanessa');
    assert.equal(messages[0].parameter.key, 'ПоказыватьПомощникПриПервомЗапуске');
    mode = 'custom'; await manager.selectAdditionalParameter(panel, ['useaddin']);
    assert.equal(messages[1].parameter.key, 'Custom.Nested');
    mode = 'cancel'; await manager.selectAdditionalParameter(panel, ['useaddin']);
    assert.equal(messages.length, 2);
});

test('new profile defaults take effect over compiler defaults and user edits to those rows remain effective', () => {
    const rows = getDefaultAdditionalVanessaParameters();
    const initial = { useaddin: false, usethegherkinparserfromthevanessaextaddin: false, SearchingForFilesUsingTheVanessaExtComponent: false,
        ПоказыватьПомощникПриПервомЗапуске: true };
    assert.deepEqual(launch.applyAdditionalVanessaParameters(initial, rows).value, {
        useaddin: true, usethegherkinparserfromthevanessaextaddin: true, SearchingForFilesUsingTheVanessaExtComponent: true,
        ПоказыватьПомощникПриПервомЗапуске: false
    });
    rows[0].value = 'false';
    assert.equal((launch.applyAdditionalVanessaParameters(initial, rows).value as any).useaddin, false);
});
