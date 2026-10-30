import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as clients from '../src/vanessaControlClients';
import * as workflow from '../src/vanessaControlClientWorkflow';
import * as savedClients from '../src/vanessaDebugClients';
import { configureVanessaDebugClientSelection } from '../src/vanessaDebugClientConfiguration';

function harness(choices: Array<string | undefined>, openCatalog?: (path?: string) => Promise<void>) {
    const picks: string[] = []; const operations: string[] = []; const information: string[] = []; const errors: string[] = [];
    let command!: () => Promise<void>;
    const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
    const runtime = {
        list: async () => { operations.push('list'); return [{ name: 'TestClient', connected: false, clientType: 'Thin', computerName: 'localhost' }]; },
        connect: async () => { operations.push('connect'); },
        apply: async () => { operations.push('apply'); }
    };
    const window = {
        showQuickPick: async (items: Array<{ id?: string; action?: string }>, options: { title: string }) => {
            picks.push(options.title);
            const next = choices.shift();
            if (next === undefined) { return undefined; }
            const picked = items.find(item => (item.id ?? item.action) === next);
            assert.ok(picked, `Unavailable action ${next}`);
            return picked;
        },
        showInputBox: async () => 'TestClient',
        showInformationMessage: (message: string) => { information.push(message); return new Promise<undefined>(() => {}); },
        showErrorMessage: (message: string) => { errors.push(message); return new Promise<undefined>(() => {}); },
        withProgress: async (_options: unknown, work: () => Promise<unknown>) => work()
    };
    const session = {
        snapshot: { generation: 1, status: 'ready', capabilities: {
            clientProfilesRead: { supported: true }, clientProfilesWrite: { supported: true }, clientConnect: { supported: true },
            clientDisconnect: { supported: true }, clientClose: { supported: true }
        } },
        withTestClientControl: async (work: (value: typeof runtime) => Promise<unknown>) => work(runtime)
    };
    const configure = async () => {
        await configureVanessaDebugClientSelection(undefined, {
            pick: async (title, items) => window.showQuickPick([...items], { title }) as Promise<typeof items[number] | undefined>,
            input: async () => window.showInputBox(), folder: async () => undefined, managedInfobase: async () => undefined
        }, message => message);
    };
    const module = { exports: {} as { registerVanessaClientCommands: (context: unknown, session: unknown, configure: () => Promise<void>, openCatalog?: (path?: string) => Promise<void>) => void } };
    const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlClientCommands.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => {
        if (name === 'vscode') {
            return { window, l10n: { t: (message: string) => message }, ProgressLocation: { Notification: 15 }, commands: {
                registerCommand: (name: string, registered: () => Promise<void>) => { commands.set(name, registered); command = registered; return { dispose() {} }; }
            } };
        }
        if (name.endsWith('DebugClients')) { return savedClients; }
        if (name.endsWith('ClientWorkflow')) { return workflow; }
        if (name.endsWith('ControlClients')) { return clients; }
        throw new Error(`Unexpected dependency ${name}`);
    } });
    module.exports.registerVanessaClientCommands({ subscriptions: [], workspaceState: { get: () => undefined }, secrets: {} }, session, configure, openCatalog);
    return { run: () => command(), commands, choices, picks, operations, information, errors, runtime, window };
}

test('modern Test clients opens the per-base editor and remains reusable after an opening failure', async () => {
    const bases: Array<string | undefined> = []; let fail = true;
    const h = harness([], async base => { if (fail) { fail = false; throw new Error('private failure'); } bases.push(base); });
    const open = h.commands.get('kotTestToolkit.vanessaControl.clients')!;
    await open('/bases/own'); await open('/bases/own');
    assert.deepEqual(bases, ['/bases/own']); assert.deepEqual(h.picks, []); assert.deepEqual(h.operations, []);
    assert.deepEqual(h.errors, ['Could not open Vanessa test clients.']);
    assert.ok(h.commands.has('kotTestToolkit.vanessaControl.legacyClients'));
});

test('cancelling saved client setup before choosing an infobase closes the workflow and allows reopening', async () => {
    const h = harness(['configure', 'add', undefined]);
    await h.run();
    assert.deepEqual(h.picks, ['Vanessa test clients', 'Vanessa debug clients', 'Debug client infobase']);
    h.choices.push(undefined); await h.run();
    assert.equal(h.picks.at(-1), 'Vanessa test clients');
    assert.equal(h.picks.length, 4);
    assert.deepEqual(h.operations, []);
});

test('a passive success notification does not keep the test clients command locked', async () => {
    const h = harness(['live', '0', 'connect']);
    let completed = false;
    void h.run().then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(h.operations, ['list', 'connect']);
    assert.equal(h.information.length, 1);
    assert.equal(completed, true, 'a notification must not own the command lock');
    assert.deepEqual(h.picks, ['Vanessa test clients', 'Live test clients', 'Test client actions']);
    h.choices.push(undefined); await h.run();
    assert.equal(h.picks.length, 4);
    assert.deepEqual(h.operations, ['list', 'connect']);
});

test('a failed client connection can reopen the menu while its error notification remains visible', async () => {
    const h = harness(['live', '0', 'connect']);
    h.runtime.connect = async () => { h.operations.push('connect'); throw new clients.VanessaClientControlError('The Vanessa client operation was not confirmed.'); };
    await h.run();
    assert.equal(h.errors.length, 1);
    h.choices.push(undefined); await h.run();
    assert.deepEqual(h.picks, ['Vanessa test clients', 'Live test clients', 'Test client actions', 'Vanessa test clients']);
    assert.deepEqual(h.operations, ['list', 'connect']);
});

test('reentry during a client mutation cannot open a second picker or queue another mutation', async () => {
    const h = harness(['live', '0', 'connect']);
    let release!: () => void; let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entering = new Promise<void>(resolve => { entered = resolve; });
    h.runtime.connect = async () => { h.operations.push('connect'); entered(); await pending; };
    const first = h.run(); await entering;
    await h.run();
    assert.equal(h.picks.length, 3);
    assert.deepEqual(h.operations, ['list', 'connect']);
    release();
    let completed = false; void first.then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, true);
    h.choices.push(undefined); await h.run();
    assert.equal(h.picks.length, 4);
    assert.deepEqual(h.operations, ['list', 'connect']);
});

test('a pending picker stays exclusive until cancellation and the next command opens a fresh menu', async () => {
    const h = harness([undefined]);
    const pick = h.window.showQuickPick;
    let release!: () => void; let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entering = new Promise<void>(resolve => { entered = resolve; });
    h.window.showQuickPick = async (_items, options) => { h.picks.push(options.title); entered(); await pending; return undefined; };
    const first = h.run(); await entering;
    await h.run();
    assert.deepEqual(h.picks, ['Vanessa test clients']);
    release(); await first;
    h.window.showQuickPick = pick; await h.run();
    assert.deepEqual(h.picks, ['Vanessa test clients', 'Vanessa test clients']);
    assert.deepEqual(h.operations, []);
});
