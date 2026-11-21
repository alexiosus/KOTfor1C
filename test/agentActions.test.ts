import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AgentActions, type AgentActionPorts } from '../src/agentActions';
import { AgentStore } from '../src/agentStore';
import { AgentWorkspace, agentContains } from '../src/agentWorkspace';
import { AgentService, type AgentServicePorts } from '../src/agentService';
import { AgentMcpServer } from '../src/agentMcpServer';
import { kotWindow, withKotInteraction, assertKotPath, type KotInteraction, type KotAnswer } from '../src/kotInteraction';

const descriptor = { id: 'scenario.create', domain: 'scenario', description: 'Native creation', mutates: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-actions-'));
    t.after(async () => { assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); });
    return { root, store: new AgentStore(path.join(root, 'operations')), workspace: new AgentWorkspace(root) };
}
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    let latest: T | undefined;
    for (let attempt = 0; attempt < 400; attempt++) { latest = await read(); if (accept(latest)) { return latest; } await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('Timed out waiting for action state: ' + JSON.stringify(latest)?.slice(0, 4000));
}
function ports(invoke: AgentActionPorts['invoke']): AgentActionPorts {
    return { list: () => [descriptor], invoke, token: signal => signal, resolvePath: async value => value };
}
const native = { showInputBox: async (_options: unknown): Promise<string | undefined> => 'desktop',
    showQuickPick: async (_items: unknown[], _options?: unknown): Promise<unknown> => undefined,
    showWarningMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
    showErrorMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
    showOpenDialog: async (_options: unknown): Promise<unknown> => undefined,
    withProgress: async (_options: unknown, work: (progress: { report(value: unknown): void }, token: unknown) => Promise<unknown>) => work({ report() {} }, {}) };

test('native interactions stay scoped, retain validation and map real items while excluding separators', async () => {
    const window = kotWindow(native); const first = { label: 'First', payload: 42 }; let validations = 0;
    const answers: KotAnswer[] = [{ text: 'wrong' }, { text: 'valid' }, { choices: ['0'] }, { paths: ['safe'] }];
    const host: KotInteraction = { token: {}, notify() {}, progress() {}, resolvePath: async file => { assert.equal(file, 'safe'); return { file }; },
        ask: async (question, validate) => {
            if (question.kind === 'input') { await assert.rejects(validate!(answers.shift()!), /Invalid value/); }
            if (question.kind === 'pick') { assert.equal(question.options!.length, 1); }
            if (question.password) { assert.equal(question.value, undefined); }
            const answer = answers.shift()!; await validate?.(answer); return answer;
        } };
    await withKotInteraction(host, async () => {
        assert.equal(await window.showInputBox({ password: true, value: 'stored secret', validateInput: (value: string) => { validations++; return value === 'valid' ? undefined : 'Invalid value'; } }), 'valid');
        assert.equal(await window.showQuickPick([{ label: 'Header', kind: -1 }, first]), first);
        assert.deepEqual(await window.showOpenDialog({ canSelectFiles: true }), [{ file: 'safe' }]);
        assert.equal(await native.showInputBox({}), 'desktop');
    });
    assert.equal(await window.showInputBox({}), 'desktop'); assert.equal(validations, 2);
    await assertKotPath('/native/desktop/path');
    await withKotInteraction(host, async () => assert.rejects(assertKotPath('outside'), /strictly equal/));
});

test('actions preserve questions on invalid answers, execute once and never persist password input', async t => {
    const { store } = await fixture(t); const window = kotWindow(native); let calls = 0;
    const actions = new AgentActions(store, ports(async () => {
        calls++;
        const value = await window.showInputBox({ password: true, value: 'old-password', validateInput: (value: string) => value.length < 5 ? 'Too short' : undefined });
        await window.withProgress({}, async progress => { progress.report({ message: 'Using ' + value }); return undefined; });
        await window.showWarningMessage('Confirm native target', { modal: true, detail: 'Native confirmation details' }, 'Apply');
        return { saved: true, diagnostic: value, properties: [{ key: 'Password', value: 'another-stored-secret' }],
            settings: [{ key: 'kotTestToolkit.example', configured: true, token: 'a'.repeat(64), value: true }] };
    }));
    t.after(() => actions.dispose());
    const started = await actions.start(descriptor.id, {}, 'one');
    await until(() => store.get(started.id), value => value.status === 'awaiting_agent');
    const q = actions.question(started.id); assert.equal(q.password, true); assert.equal(q.value, undefined);
    await assert.rejects(actions.start('arbitrary.command', {}, 'bad'), /Unknown action/);
    await assert.rejects(actions.start(descriptor.id, { unexpected: true }, 'bad'), /arguments/);
    assert.equal((await actions.start(descriptor.id, {}, 'one')).id, started.id);
    await assert.rejects(actions.answer(started.id, q.id, { text: 'x' }, 'invalid'), /Too short/);
    assert.equal(actions.question(started.id).id, q.id);
    await actions.answer(started.id, q.id, { text: 'private-test-password' }, 'password');
    await actions.answer(started.id, q.id, { text: 'private-test-password' }, 'password');
    await until(() => { try { return actions.question(started.id); } catch { return undefined; } }, value => value?.kind === 'message');
    const confirm = actions.question(started.id);
    assert.equal(confirm.modal, true); assert.match(confirm.message as string, /Native confirmation details/);
    await assert.rejects(actions.answer(started.id, q.id, { choices: ['0'] }, 'stale'), /Question changed/);
    await actions.answer(started.id, confirm.id, { choices: ['0'] }, 'confirm');
    const record = await until(() => store.get(started.id), value => value.status === 'completed');
    assert.equal(calls, 1); assert.equal(actions.busy, false);
    assert.match(JSON.stringify(record.result), /redacted/);
    assert.ok(JSON.stringify(record.result).includes('a'.repeat(64)), 'Settings revision tokens must stay usable.');
    for (const operation of await store.list()) { assert.doesNotMatch(JSON.stringify(await store.get(operation.id)), /private-test-password|old-password|another-stored-secret/); }
    assert.equal((await actions.start(descriptor.id, {}, 'one')).status, 'completed');
});

test('native error notifications fail the action, token failures release ownership and large results use artifacts', async t => {
    const { store } = await fixture(t); const window = kotWindow(native);
    let failToken = true; let mode = 'error';
    const actions = new AgentActions(store, { ...ports(async () => {
        if (mode === 'error') { void window.showErrorMessage('Native command refused the write'); return undefined; }
        return { entries: 'x'.repeat(65000) };
    }), token: () => { if (failToken) { throw new Error('token unavailable'); } return {}; } });
    t.after(() => actions.dispose());
    const first = await actions.start(descriptor.id, {}, 'bad-token');
    await until(() => store.get(first.id), value => value.status === 'failed'); assert.equal(actions.busy, false);
    failToken = false;
    const second = await actions.start(descriptor.id, {}, 'native-error');
    await until(() => store.get(second.id), value => value.status === 'failed');
    mode = 'large'; const third = await actions.start(descriptor.id, {}, 'large');
    const record = await until(() => store.get(third.id), value => value.status === 'completed' || value.status === 'failed');
    assert.equal(record.status, 'completed', JSON.stringify(record.result));
    assert.equal(record.artifacts.length, 1); assert.match(record.artifacts[0].name, /action-result/);
    assert.ok(JSON.stringify(record.result).length < 1000);
});

test('cancellation, shutdown and restart leave no replayable live question', async t => {
    const { store } = await fixture(t); const window = kotWindow(native);
    const actions = new AgentActions(store, ports(async () => window.showInputBox({}))); t.after(() => actions.dispose());
    const first = await actions.start(descriptor.id, {}, 'cancel'); await until(() => store.get(first.id), value => value.status === 'awaiting_agent');
    await actions.cancel(first.id); await until(() => store.get(first.id), value => value.status === 'cancelled');
    const second = await actions.start(descriptor.id, {}, 'stop'); await until(() => store.get(second.id), value => value.status === 'awaiting_agent');
    await actions.dispose(); assert.equal((await store.get(second.id)).status, 'cancelled');
    const interrupted = await store.create('incident', { action: 'kot_action' }); await store.update(interrupted.record.id, value => { value.status = 'awaiting_agent'; });
    await store.recover(); assert.equal((await store.get(interrupted.record.id)).status, 'unknown');
});

test('real MCP runs a native wizard, rechecks policy before answering and blocks concurrent runtime calls', async t => {
    const { workspace, store } = await fixture(t); let policy: 'tests' | 'read-only' = 'tests'; const window = kotWindow(native); let writes = 0;
    const configuration: AgentServicePorts = {
        trusted: () => true, canExecute: () => true, tests: async () => [], run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}),
        definitions: async () => [], runtime: () => ({}), client: async () => [], form: async () => ({}), screenshot: async () => Buffer.alloc(0), variables: async () => [], build: async () => ({}),
        repair: { policy: () => policy, classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false },
        infobases: { register: async () => ({ status: 'added', registeredName: 'Test', sourceFilePath: 'ibases.v8i' }), idle: () => true, execute: async () => {}, provenance: async () => ({}) },
        actions: ports(async () => { const name = await window.showInputBox({}); if (name) { writes++; } return { name }; })
    };
    const service = new AgentService(workspace, store, configuration); const server = new AgentMcpServer({ trusted: () => true, call: (name, args) => service.call(name, args) });
    const endpoint = await server.start(); const client = new Client({ name: 'native-actions', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    t.after(async () => { await client.close(); await server.close(); await service.dispose(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: 'Bearer ' + endpoint.token } } }));
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    assert.ok((await call('kot_actions')).structuredContent);
    const started = (await call('kot_action_start', { action: descriptor.id, requestKey: 'mcp' })).structuredContent as { id: string };
    await until(() => store.get(started.id), value => value.status === 'awaiting_agent');
    const question = (await call('kot_action_question', { id: started.id })).structuredContent as { id: string };
    assert.equal((await call('kot_client', { action: 'list' })).isError, true);
    policy = 'read-only';
    assert.equal((await call('kot_action_answer', { id: started.id, questionId: question.id, answer: { text: 'Named' }, requestKey: 'blocked' })).isError, true); assert.equal(writes, 0);
    policy = 'tests';
    assert.equal((await call('kot_action_answer', { id: started.id, questionId: question.id, answer: { text: 'Named' }, requestKey: 'allowed' })).isError, undefined);
    await until(() => store.get(started.id), value => value.status === 'completed'); assert.equal(writes, 1);
});

test('interrupt controls can stop a busy runtime while execution, trust and repair policies still apply', async t => {
    const { workspace, store } = await fixture(t); let executable = true; let trusted = true; let policy: 'tests' | 'read-only' = 'tests'; let stopped = 0;
    const stop = { ...descriptor, id: 'debug.stop', interrupts: true, execution: true };
    const service = new AgentService(workspace, store, {
        trusted: () => trusted, canExecute: () => executable, tests: async () => [], run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}),
        definitions: async () => [], runtime: () => ({}), client: async () => [], form: async () => ({}), screenshot: async () => Buffer.alloc(0), variables: async () => [], build: async () => ({}),
        repair: { policy: () => policy, classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => true },
        infobases: { register: async () => ({ status: 'added', registeredName: 'Test', sourceFilePath: 'ibases.v8i' }), idle: () => true, execute: async () => {}, provenance: async () => ({}) },
        actions: { ...ports(async () => { stopped++; }), list: () => [descriptor, stop] }
    }); t.after(() => service.dispose());
    await assert.rejects(service.call('kot_action_start', { action: descriptor.id, requestKey: 'normal' }), /active operation/);
    const started = (await service.call('kot_action_start', { action: stop.id, requestKey: 'stop' })).structuredContent as { id: string };
    await until(() => store.get(started.id), value => value.status === 'completed'); assert.equal(stopped, 1);
    executable = false;
    await assert.rejects(service.call('kot_action_start', { action: stop.id, requestKey: 'disabled' }), /disabled/);
    executable = true; policy = 'read-only';
    await assert.rejects(service.call('kot_action_start', { action: stop.id, requestKey: 'read-only' }), /read-only/);
    policy = 'tests'; trusted = false;
    await assert.rejects(service.call('kot_action_start', { action: stop.id, requestKey: 'untrusted' }), /Trust/);
    assert.equal(stopped, 1);
});
