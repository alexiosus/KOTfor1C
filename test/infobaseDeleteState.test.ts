import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as connections from '../src/oneCInfobaseConnection';

const storageKey = 'runVanessa.customInfobaseByScenario';
for (const version2 of [false, true]) {
    test(`Edit → Delete cleans scenario infobase references in ${version2 ? 'v2' : 'legacy'} storage`, async () => {
        const target = path.resolve('/tmp/kot-missing-infobase-fixture');
        const other = path.resolve('/tmp/kot-other-infobase-fixture');
        const paths = { removed: target, retained: other, invalid: undefined };
        const state = new Map<string, unknown>([[storageKey, version2 ? { version: 2, byKey: paths } : paths]]);
        const unregistered: string[] = [];
        const module = { exports: {} as any };
        const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
        const vscode = {
            ProgressLocation: { Notification: 1 },
            window: {
                showQuickPick: async (items: any[]) => items.find(item => item.actionKey === 'delete'),
                showWarningMessage: async (_message: string, _options: unknown, action: string) => action,
                withProgress: async (_options: unknown, work: any) => work({ report() {} })
            }
        };
        vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/infobaseManager.ts', 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText, { module, exports: module.exports, console, process, Buffer,
            require: (name: string) => {
                if (name === 'vscode') { return vscode; }
                if (name === './oneCInfobaseConnection') { return connections; }
                if (name === './localization') { return { getTranslator: async () => (message: string) => message }; }
                if (name === './infobasePicker') { return { unregisterInfobaseFromLauncher: async (value: string) => unregistered.push(value) }; }
                if (name === 'node:fs') { return { promises: { rm: () => assert.fail('Missing infobase must not delete files') } }; }
                if (name.startsWith('node:')) { return require(name); }
                return {};
            }
        });
        const context = { workspaceState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
            update: async (key: string, value: unknown) => { state.set(key, value); } } };
        await module.exports.editInfobaseInteractive(context, {
            infobasePath: target, infobaseKind: 'file', displayName: 'Fixture', exists: false, markerExists: false
        });
        assert.deepEqual(unregistered, [target]);
        assert.deepEqual(JSON.parse(JSON.stringify(state.get(storageKey))), version2 ? { version: 2, byKey: { retained: other } } : { retained: other });
    });
}
