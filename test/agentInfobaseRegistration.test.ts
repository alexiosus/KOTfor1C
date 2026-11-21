import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { AgentInfobases } from '../src/agentInfobases';
import { AgentStore } from '../src/agentStore';
import { AgentWorkspace } from '../src/agentWorkspace';
import * as connections from '../src/oneCInfobaseConnection';
import type { RegisterLauncherInfobaseResult } from '../src/infobasePicker';

async function fixture(t: test.TestContext) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-launcher-')));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const roaming = path.join(root, 'AppData', 'Roaming');
    const runtime = Object.create(process);
    Object.defineProperties(runtime, { platform: { value: 'win32' }, env: { value: { APPDATA: roaming, USERPROFILE: root } } });
    const module = { exports: {} as { registerInfobaseInLauncher(file: string, name: string): Promise<RegisterLauncherInfobaseResult> } };
    const dependencies: Record<string, unknown> = {
        vscode: {}, './oneCInfobaseConnection': connections, 'node:os': { homedir: () => root }
    };
    vm.runInNewContext(ts.transpileModule(readFileSync('src/infobasePicker.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, process: runtime, Buffer,
        require: (name: string) => name === './kotInteraction' ? nativeInteraction : (name in dependencies ? dependencies[name] : require(name)) });
    return { root, store: new AgentStore(path.join(root, 'operations')), workspace: new AgentWorkspace(root),
        register: module.exports.registerInfobaseInLauncher,
        launcher: path.join(roaming, '1C', '1CEStart', 'ibases.v8i') };
}

test('restored agent bases are registered in the real V8I format and retry preserves existing entries without duplicates', async t => {
    const h = await fixture(t);
    const previous = '\uFEFF[Existing]\r\nConnect=File="C:\\Existing";\r\nID=existing-id\r\n';
    await fs.mkdir(path.dirname(h.launcher), { recursive: true }); await fs.writeFile(h.launcher, previous);
    const source = path.join(h.root, 'initial.dt'); await fs.writeFile(source, 'DT');
    const calls: string[] = [];
    const bases = new AgentInfobases(h.store, h.workspace, { idle: () => true, provenance: async () => ({}),
        execute: async args => { calls.push(args[0]); },
        register: async (file, name) => { calls.push('register'); return h.register(file, name); } });
    const created = await bases.start({ action: 'create', sourceKind: 'dt', source, requestKey: 'create' }); await bases.idle();
    const base = await bases.owned(created.id);
    const operation = await h.store.get(created.id);
    const result = operation.result as { launcher: RegisterLauncherInfobaseResult };
    assert.deepEqual(calls, ['CREATEINFOBASE', 'DESIGNER', 'register']);
    assert.equal(result.launcher.status, 'added');
    assert.equal(result.launcher.registeredName, `KOT Agent ${path.basename(h.root)} ${created.id.slice(0, 8)}`);
    const content = await fs.readFile(h.launcher, 'utf8');
    assert.ok(content.startsWith(previous), 'existing entries and BOM must survive registration');
    assert.ok(content.includes(connections.buildFileInfobaseConnectionArgument(base, { trailingSemicolon: true })));
    assert.equal(operation.events.filter(event => event.kind === 'launcher_registration').length, 1);
    const retried = await bases.start({ action: 'register', environmentId: created.id, requestKey: 'register' }); await bases.idle();
    assert.equal((await h.store.get(retried.id)).status, 'completed');
    assert.equal(((await h.store.get(created.id)).result as typeof result).launcher.status, 'alreadyExists');
    assert.equal(await fs.readFile(h.launcher, 'utf8'), content);
    assert.deepEqual(calls, ['CREATEINFOBASE', 'DESIGNER', 'register', 'register']);
    await bases.start({ action: 'register', environmentId: created.id, requestKey: 'register' }); await bases.idle();
    assert.equal(calls.length, 4, 'the same request key must not perform registration again');
});

test('a launcher failure leaves the prepared base usable and can be repaired without another restore', async t => {
    const h = await fixture(t); let commands = 0; let unavailable = true;
    const bases = new AgentInfobases(h.store, h.workspace, { idle: () => true, provenance: async () => ({}),
        execute: async () => { commands++; }, register: async (file, name) => {
            if (unavailable) { throw new Error('Launcher list is read-only'); }
            return h.register(file, name);
        } });
    const created = await bases.start({ action: 'create', requestKey: 'create' }); await bases.idle();
    assert.ok(await bases.owned(created.id));
    assert.equal((await h.store.get(created.id)).status, 'completed');
    const result = (await h.store.get(created.id)).result as { launcher: unknown };
    assert.deepEqual(result.launcher, { status: 'failed', error: 'Launcher list is read-only' });
    const refused = await bases.start({ action: 'register', environmentId: created.id, requestKey: 'refused' }); await bases.idle();
    assert.equal((await h.store.get(refused.id)).status, 'failed');
    unavailable = false;
    const repaired = await bases.start({ action: 'register', environmentId: created.id, requestKey: 'retry' }); await bases.idle();
    assert.equal((await h.store.get(repaired.id)).status, 'completed');
    assert.equal(((await h.store.get(created.id)).result as { launcher: RegisterLauncherInfobaseResult }).launcher.status, 'added');
    assert.equal(commands, 1);
});

test('a requested DT base name reaches the launcher and survives registration retry without another restore', async t => {
    const h = await fixture(t); const source = path.join(h.root, 'initial.dt'); await fs.writeFile(source, 'DT');
    let commands = 0; let unavailable = true; const names: string[] = [];
    const bases = new AgentInfobases(h.store, h.workspace, { idle: () => true, provenance: async () => ({}),
        execute: async () => { commands++; }, register: async (file, name) => {
            names.push(name); if (unavailable) { throw new Error('Launcher temporarily unavailable'); } return h.register(file, name);
        } });
    const created = await bases.start({ action: 'create', sourceKind: 'dt', source, name: 'KOT-test-ib', requestKey: 'named' }); await bases.idle();
    assert.equal((await h.store.get(created.id)).status, 'completed');
    unavailable = false;
    const retried = await bases.start({ action: 'register', environmentId: created.id, requestKey: 'retry-name' }); await bases.idle();
    assert.equal((await h.store.get(retried.id)).status, 'completed');
    assert.deepEqual(names, ['KOT-test-ib', 'KOT-test-ib']); assert.equal(commands, 2);
    assert.ok((await fs.readFile(h.launcher, 'utf8')).includes('[KOT-test-ib]'));
    assert.equal(((await h.store.get(created.id)).result as { launcher: RegisterLauncherInfobaseResult }).launcher.registeredName, 'KOT-test-ib');
    await bases.start({ action: 'register', environmentId: created.id, requestKey: 'retry-name' }); await bases.idle(); assert.equal(names.length, 2);
    await assert.rejects(bases.start({ action: 'create', sourceKind: 'dt', source, name: 'Different name', requestKey: 'named' }), /different request/u);
});

test('named creation preserves an existing launcher entry and reports the collision suffix', async t => {
    const h = await fixture(t); await fs.mkdir(path.dirname(h.launcher), { recursive: true });
    const previous = '[KOT-test-ib]\r\nConnect=File="C:\\Existing";\r\nID=existing-id\r\n'; await fs.writeFile(h.launcher, previous);
    const bases = new AgentInfobases(h.store, h.workspace, { idle: () => true, provenance: async () => ({}), execute: async () => {}, register: h.register });
    const created = await bases.start({ action: 'create', name: 'KOT-test-ib', requestKey: 'collision' }); await bases.idle();
    const launcher = ((await h.store.get(created.id)).result as { launcher: RegisterLauncherInfobaseResult }).launcher;
    assert.ok(launcher.registeredName?.startsWith('KOT-test-ib')); assert.notEqual(launcher.registeredName, 'KOT-test-ib');
    assert.ok((await fs.readFile(h.launcher, 'utf8')).startsWith(previous));
});

test('invalid launcher names are rejected before creating a base or changing the launcher', async t => {
    const h = await fixture(t); let commands = 0;
    const bases = new AgentInfobases(h.store, h.workspace, { idle: () => true, provenance: async () => ({}), execute: async () => { commands++; }, register: h.register });
    for (const name of ['', ' ', 'bad\nConnect=File="x";', '[section]', 'x'.repeat(201), 'bad\0name']) {
        await assert.rejects(bases.start({ action: 'create', name, requestKey: 'bad' }), /launcher name/u);
    }
    await assert.rejects(bases.start({ action: 'checkpoint', environmentId: 'base', name: 'Ignored', requestKey: 'bad-action' }), /launcher name/u);
    assert.equal(commands, 0); assert.deepEqual(await h.store.list(), []); await assert.rejects(fs.stat(h.launcher), { code: 'ENOENT' });
});

for (const failedCommand of ['CREATEINFOBASE', 'DESIGNER']) {
    test(`failed ${failedCommand} does not publish a broken base in the launcher`, async t => {
        const h = await fixture(t); const source = path.join(h.root, 'initial.dt'); await fs.writeFile(source, 'DT');
        let registered = false;
        const bases = new AgentInfobases(h.store, h.workspace, { idle: () => true, provenance: async () => ({}),
            execute: async args => { if (args[0] === failedCommand) { throw new Error('Preparation failed'); } },
            register: async (file, name) => { registered = true; return h.register(file, name); } });
        const operation = await bases.start({ action: 'create', sourceKind: 'dt', source, requestKey: 'failed' }); await bases.idle();
        assert.equal((await h.store.get(operation.id)).status, 'failed'); assert.equal(registered, false);
        await assert.rejects(fs.stat(h.launcher), { code: 'ENOENT' });
    });
}

test('previously created environments can register, but arbitrary operation IDs cannot', async t => {
    const h = await fixture(t); let commands = 0;
    const bases = new AgentInfobases(h.store, h.workspace, { idle: () => true, provenance: async () => ({}),
        execute: async () => { commands++; }, register: h.register });
    const legacy = await h.store.create('environment', { action: 'create' });
    const base = path.join(h.store.directory, legacy.record.id, 'infobase'); await fs.mkdir(base);
    await h.store.update(legacy.record.id, record => { record.status = 'completed'; record.result = { infobase: base, sessionRestored: false }; });
    const registered = await bases.start({ action: 'register', environmentId: legacy.record.id, requestKey: 'legacy' }); await bases.idle();
    assert.equal((await h.store.get(registered.id)).status, 'completed');
    const content = await fs.readFile(h.launcher, 'utf8');
    const rejected = await bases.start({ action: 'register', environmentId: registered.id, requestKey: 'unowned' }); await bases.idle();
    assert.equal((await h.store.get(rejected.id)).status, 'failed');
    assert.equal(await fs.readFile(h.launcher, 'utf8'), content); assert.equal(commands, 0);
    await assert.rejects(bases.start({ action: 'register', requestKey: 'missing-environment' }), /agent-owned/u);
});
