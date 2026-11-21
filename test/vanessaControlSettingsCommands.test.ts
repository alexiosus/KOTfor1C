import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { VanessaRuntimeSettings } from '../src/vanessaControlSettings';
import type { VanessaSettingsProfileSource } from '../src/vanessaControlSettingsCommands';

function harness(action: string, options: { cancel?: boolean; changeSession?: boolean; previewError?: boolean; legacy?: boolean; readOnly?: boolean } = {}) {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const reports: unknown[] = []; const errors: string[] = []; const commands: unknown[][] = []; const menus: any[][] = [];
    let confirms = 0; let fileDialogs = 0;
    const snapshot = { generation: 1, capabilities: { settingsRead: { supported: !options.legacy }, settingsWrite: { supported: !options.readOnly } } };
    const settings = new VanessaRuntimeSettings(async (tool, args) => {
        calls.push({ tool, args });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: !options.previewError || !args.dry_run,
            revision: args.dry_run ? 8 : 7, errors: options.previewError && args.dry_run ? ['Unsupported value'] : [], warnings: [],
            out_of_scope: ['GlobalVars'], ignored: [], changed: [], applied: [], dry_run: args.dry_run }) }] };
    });
    let run!: (source?: VanessaSettingsProfileSource) => Promise<void>;
    const vscode = {
        l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/gu, (_, index) => String(args[Number(index)])) },
        workspace: {
            openTextDocument: async () => { assert.fail('Settings reports must not open JSON documents'); },
            fs: { readFile: async () => Buffer.from('{"filtertags":["Smoke"]}') }
        },
        window: {
            showTextDocument: async () => {},
            showQuickPick: async (items: any[]) => { menus.push(items); return items.find(item => item.action === action); },
            showOpenDialog: async () => { fileDialogs++; return [{ fsPath: path.resolve('project/params/VAParams.json') }]; },
            showInformationMessage: async (_message: string, modal?: { modal: boolean }, apply?: string, cancel?: string) => {
                if (modal) { confirms++; assert.equal(modal.modal, false, 'the report must stay readable before confirmation'); assert.equal(cancel, 'Cancel'); if (options.changeSession) { snapshot.generation++; } }
                return options.cancel ? undefined : apply;
            },
            showErrorMessage: (message: string) => { errors.push(message); }
        },
        commands: {
            registerCommand: (_name: string, handler: typeof run) => { run = handler; return { dispose() {} }; },
            executeCommand: async (...args: unknown[]) => { commands.push(args); }
        }
    };
    const module = { exports: {} as any };
    const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlSettingsCommands.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, TextDecoder, require: (name: string) => {
            if (name === './kotInteraction') { return nativeInteraction; }
        if (name === 'vscode') { return vscode; }
        if (name === './vanessaControlSettingsReport') { return { VanessaSettingsReport: class {
            show(report: any) { reports.push(report); }
            async confirm(report: any, _items: unknown, current: () => boolean) {
                this.show(report);
                if (!report.ok || report.errors.length || !current()) { return false; }
                confirms++; if (options.changeSession) { snapshot.generation++; }
                return !options.cancel && current();
            }
            unconfirmed() {} dispose() {}
        } }; }
        return require(name);
    } });
    module.exports.registerVanessaSettingsCommands({ subscriptions: [] }, { snapshot,
        withSettingsControl: (work: (settings: VanessaRuntimeSettings) => Promise<unknown>, current: () => boolean) => {
            assert.ok(current()); return work(settings);
        } }, async () => true);
    return { run, calls, reports, errors, menus, commands, confirms: () => confirms, fileDialogs: () => fileDialogs };
}

const profile: VanessaSettingsProfileSource = {
    profileName: 'Selected profile', basePath: path.resolve('project'),
    parameters: '{"useaddin":false,"filtertags":["Smoke"],"CustomText":"0012"}'
};

test('Additional tab applies its captured profile parameters using the project root and confirmed preview revision', async () => {
    const h = harness('applyProfile'); await h.run(profile);
    const writes = h.calls.filter(call => call.tool === 'manage_va_settings');
    assert.equal(h.fileDialogs(), 0); assert.equal(h.confirms(), 1); assert.equal(h.reports.length, 2); assert.deepEqual(h.errors, []);
    assert.deepEqual(writes.map(call => [call.args.parameters_json, call.args.base_path, call.args.expected_revision, call.args.dry_run]), [
        [profile.parameters, profile.basePath, 7, true], [profile.parameters, profile.basePath, 8, false]
    ]);
    assert.ok(h.menus[0].some(item => item.label.includes('Selected profile')));
});

for (const options of [{ cancel: true }, { changeSession: true }, { previewError: true }]) {
    test(`profile apply does not write after canceled, stale or rejected preview: ${JSON.stringify(options)}`, async () => {
        const h = harness('applyProfile', options); await h.run(profile);
        assert.equal(h.calls.filter(call => call.tool === 'manage_va_settings').length, 1);
        assert.equal(h.calls.at(-1)?.args.dry_run, true);
    });
}

test('VAParams file apply keeps the file directory as its relative path base', async () => {
    const h = harness('apply'); await h.run(profile);
    assert.equal(h.fileDialogs(), 1);
    const writes = h.calls.filter(call => call.tool === 'manage_va_settings');
    assert.equal(writes.length, 2);
    assert.equal(writes[0].args.base_path, path.resolve('project/params'));
    assert.deepEqual(JSON.parse(String(writes[0].args.parameters_json)), { filtertags: ['Smoke'] });
});

test('returning to launch parameters opens the Additional tab without reading or changing the session', async () => {
    const h = harness('profile'); await h.run();
    assert.deepEqual(h.commands, [['kotTestToolkit.openYamlParametersManager', 'additional']]);
    assert.deepEqual(h.calls, []);
});

test('legacy and read-only Vanessa sessions do not offer unsupported profile application', async () => {
    const old = harness('applyProfile', { legacy: true }); await old.run(profile);
    assert.deepEqual(old.calls, []); assert.equal(old.menus.length, 0);
    const readOnly = harness('applyProfile', { readOnly: true }); await readOnly.run(profile);
    assert.ok(!readOnly.menus[0].some(item => item.action === 'applyProfile' || item.action === 'apply'));
    assert.deepEqual(readOnly.calls, []);
});
