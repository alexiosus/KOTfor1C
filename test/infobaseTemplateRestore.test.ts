import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as connections from '../src/oneCInfobaseConnection';
import * as confirmations from '../src/infobaseDestructiveConfirmation';
import * as commandDisplay from '../src/processCommandDisplay';

function harness(options: { templateCancelled?: boolean; confirmed?: boolean; fileCancelled?: boolean } = {}) {
    const calls = { templateKinds: [] as string[], filePickers: 0, confirmations: [] as any[], commands: [] as string[][] };
    const state = new Map<string, any>();
    const translate = (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/gu, (_, i) => args[Number(i)] ?? '');
    const target = { infobasePath: 'Srvr="qa-server";Ref="sales";', displayName: 'Sales QA', roles: ['vanessa'], launcherName: null };
    const context = { workspaceState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
        update: async (key: string, value: unknown) => { state.set(key, value); } } };
    const module = { exports: {} as any };
    const ts = require('typescript') as typeof import('typescript');
    const runtime = Object.create(process);
    Object.defineProperty(runtime, 'platform', { value: 'win32' });
    const dependencies: Record<string, unknown> = {
        vscode: {
            ProgressLocation: { Notification: 1 },
            workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
            window: {
                showOpenDialog: async () => { calls.filePickers++; return options.fileCancelled ? undefined : [{ fsPath: '/backup/custom.dt' }]; },
                showWarningMessage: async (title: string, detail: unknown, confirm: string) => {
                    calls.confirmations.push({ title, detail, confirm });
                    return options.confirmed ? confirm : undefined;
                },
                withProgress: async (_options: unknown, run: () => unknown) => run(),
                createOutputChannel: () => ({ appendLine() {}, append() {} })
            }
        },
        './localization': { getTranslator: async () => translate },
        './oneCInfobaseConnection': connections,
        './infobaseDestructiveConfirmation': confirmations,
        './processCommandDisplay': commandDisplay,
        './oneCPlatform': {
            ensureOneCPlatformsCatalogInitialized: async () => [{ clientExePath: '/platform/1cv8c.exe' }],
            normalizeOneCClientExePath: (value: string) => value,
            resolveOneCDesignerExePath: () => '/platform/1cv8.exe'
        },
        './oneCInfobaseTemplatePicker.js': { pickInstalledInfobaseTemplate: async (kind: string) => {
            calls.templateKinds.push(kind);
            return options.templateCancelled ? undefined : { kind: 'demo', name: 'Demo', version: '1.2.3', filePath: '/templates/1.2.3/demo.dt' };
        } },
        'node:fs': { existsSync: () => true, promises: { mkdir: async () => undefined } },
        'node:child_process': { spawn: (_exe: string, args: string[]) => {
            calls.commands.push(Array.from(args));
            return { on: (event: string, listener: (code: number) => void) => {
                if (event === 'close') { queueMicrotask(() => listener(0)); }
            } };
        } }
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/infobaseManager.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, process: runtime, Buffer, console,
        require: (name: string) => dependencies[name] ?? (name.startsWith('node:') ? require(name) : {}) });
    return { calls, state, context, target,
        restore: (source?: string) => module.exports.restoreInfobaseFromDtInteractive(context, target, source) as Promise<void> };
}

test('restores the selected demo template into the existing infobase through the DT pipeline', async () => {
    const h = harness({ confirmed: true });
    await h.restore('template');
    assert.deepEqual(h.calls.templateKinds, ['demo']);
    assert.equal(h.calls.filePickers, 0);
    assert.equal(h.calls.confirmations.length, 1);
    const confirmation = h.calls.confirmations[0];
    assert.match(confirmation.title, /Sales QA/u);
    assert.ok(confirmation.detail.detail.includes(path.resolve('/templates/1.2.3/demo.dt')));
    assert.ok(confirmation.detail.detail.includes(h.target.infobasePath));
    assert.match(confirmation.detail.detail, /data and configuration will be replaced/u);
    assert.equal(h.calls.commands.length, 1);
    const command = h.calls.commands[0];
    assert.equal(command[0], 'DESIGNER');
    assert.equal(command[command.indexOf('/RestoreIB') + 1], path.resolve('/templates/1.2.3/demo.dt'));
    assert.equal(command[command.indexOf('/IBConnectionString') + 1], 'Srvr=qa-server;Ref=sales');
    assert.equal(command.includes('CREATEINFOBASE'), false);
    const metadata = h.state.get('infobaseManager.metadataByPath') as Record<string, { stateHint: string }>;
    assert.equal(Object.values(metadata)[0]?.stateHint, 'ready');
});

for (const options of [{ templateCancelled: true }, { confirmed: false }]) {
    test(`template restoration stops after ${options.templateCancelled ? 'template selection' : 'overwrite confirmation'} is cancelled`, async () => {
        const h = harness(options);
        await h.restore('template');
        assert.deepEqual(h.calls.templateKinds, ['demo']);
        assert.equal(h.calls.filePickers, 0);
        assert.equal(h.calls.confirmations.length, options.templateCancelled ? 0 : 1);
        assert.equal(h.calls.commands.length, 0);
        assert.equal(h.state.size, 0);
    });
}

test('Import DT continues to use the file picker and can be cancelled', async () => {
    const h = harness({ fileCancelled: true });
    await h.restore();
    assert.equal(h.calls.filePickers, 1);
    assert.equal(h.calls.templateKinds.length, 0);
    assert.equal(h.calls.confirmations.length, 0);
    assert.equal(h.calls.commands.length, 0);
});
