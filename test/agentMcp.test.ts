import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AgentMcpServer } from '../src/agentMcpServer';
import { runAgentMcpBridge } from '../src/agentMcpBridge';
import { AgentService, agentPublicRecord, compactAgentSteps } from '../src/agentService';
import { AgentWorkspace, agentContains } from '../src/agentWorkspace';
import { AgentStore } from '../src/agentStore';
import { agentHash } from '../src/agentWorkspace';
import type { AgentConfigurationDeployment } from '../src/agentInfobases';

for (const mismatch of ['none', 'run', 'feature', 'incomplete', 'source', 'acknowledgement'] as const) {
test(`unknown run reconciliation requires its complete matching evidence: ${mismatch}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-reconcile-'));
    const store = new AgentStore(path.join(root, 'operations')); let file = path.join(root, 'test.feature'); const text = 'Feature: Own';
    await fs.writeFile(file, text); file = await fs.realpath(file); let reads = 0; const runId = '4e77a1a5-8f8f-413b-b3a7-608d1dccc245';
    const json = (data: object) => ({ content: [{ type: 'text', text: JSON.stringify({ schemaVersion: '1.1', ok: true, ...data }) }] });
    const service = new AgentService(new AgentWorkspace(root), store, {
        trusted: () => true, canExecute: () => true, tests: async () => [], run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}),
        definitions: async () => [], runtime: () => ({}), client: async () => [], form: async () => ({}), screenshot: async () => Buffer.alloc(0), variables: async () => [], build: async () => ({}),
        repair: { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false }, infobases: { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, execute: async () => {}, provenance: async () => ({}) },
        reconcileRun: async () => { reads++; return {
            state: json({ runId, isRunning: false, currentFeature: { fullPath: file } }),
            results: json({ runId: mismatch === 'run' ? 'foreign' : runId, isRunning: false, isComplete: mismatch !== 'incomplete', status: 'success',
                featurePath: mismatch === 'feature' ? file + '.other.feature' : file, steps: [{ lineNumber: 4, status: 'success' }] })
        }; }
    });
    t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const { record } = await store.create('run', { mode: 'full', tests: [{ id: 'test', name: 'Own', source: file }] });
    await store.update(record.id, value => { value.status = 'unknown'; value.result = { baselineRestored: true, error: mismatch === 'acknowledgement' ? 'Started' :
        '## Результат выполнения сценариев: все сценарии выполнены успешно\nИдентификатор прогона: ' + runId + '\n\nИмя сценария: Own\nРезультат прохождения сценария: Success' }; });
    await store.event(record.id, 'execution_source', { path: file, sha256: agentHash(text) });
    if (mismatch === 'source') { await fs.writeFile(file, text + ' changed'); }
    if (mismatch !== 'none') {
        await assert.rejects(service.call('kot_run_reconcile', { id: record.id }));
        assert.equal((await store.get(record.id)).status, 'unknown');
    } else {
        const reply = await service.call('kot_run_reconcile', { id: record.id });
        assert.equal(reply.structuredContent!.status, 'passed');
        assert.equal((reply.structuredContent!.result as any).baselineRestored, true);
        assert.ok((await store.get(record.id)).artifacts.some(artifact => artifact.name === 'result-before-reconciliation.json'));
        assert.equal((await store.get(record.id)).events.filter(event => event.kind === 'test_finished').length, 1);
        await service.call('kot_run_reconcile', { id: record.id }); assert.equal(reads, 1);
    }
});
}

test('long execution steps are bounded in runtime and operation replies without mutating stored evidence', () => {
    const steps = Array.from({ length: 6000 }, (_, index) => ({ lineNumber: index + 1, status: 'passed' }));
    const result = { details: { execution: { steps } } };
    const runtime = compactAgentSteps(result);
    assert.equal(runtime.details.execution.steps.length, 20);
    assert.equal((runtime.details.execution as any).stepCount, 6000);
    assert.equal((runtime.details.execution as any).stepsTruncated, true);
    const record = { schemaVersion: 1 as const, id: 'test', kind: 'run' as const, status: 'passed' as const, createdAt: '', updatedAt: '', request: {},
        events: [{ time: '', kind: 'test_finished', data: result }], artifacts: [], result };
    const response = agentPublicRecord(record);
    assert.ok(JSON.stringify(response).length < 4000);
    assert.equal(steps.length, 6000);
    assert.equal(record.events[0].data.details.execution.steps.length, 6000);
});

test('real MCP client discovers tools/workflows and receives structured results and tool errors', async () => {
    const server = new AgentMcpServer({ trusted: () => true, call: async (name, args) => {
        if (name === 'kot_runtime') { return { content: [{ type: 'text', text: 'ready' }], structuredContent: { ready: true, args } }; }
        throw new Error('Expected tool failure');
    } });
    const endpoint = await server.start(); const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: 'Bearer ' + endpoint.token } } }));
        const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'kot_run_start'));
        assert.deepEqual((await client.callTool({ name: 'kot_runtime', arguments: {} })).structuredContent, { ready: true, args: {} });
        assert.equal((await client.callTool({ name: 'kot_project', arguments: {} })).isError, true);
        const prompts = await client.listPrompts(); assert.ok(prompts.prompts.some(prompt => prompt.name === 'kot_story'));
        assert.ok(prompts.prompts.every(prompt => (prompt.description?.length ?? 0) < 200), 'Discovery must not inject every full workflow into the client context.');
        assert.ok(prompts.prompts.some(prompt => prompt.name === 'kot_resume'));
        assert.ok((await client.getPrompt({ name: 'kot_resume' })).messages.length);
        assert.ok((await client.getPrompt({ name: 'kot_investigate' })).messages.length);
    } finally { await client.close(); await server.close(); }
});

test('MCP endpoint rejects missing credentials, foreign origins and untrusted workspaces', async () => {
    let trusted = true; const server = new AgentMcpServer({ trusted: () => trusted, call: async () => ({ content: [] }) }); const endpoint = await server.start();
    try {
        assert.equal((await fetch(endpoint.url, { method: 'POST', body: '{}' })).status, 401);
        const headers = { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' };
        assert.equal((await fetch(endpoint.url, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
        trusted = false; assert.equal((await fetch(endpoint.url, { method: 'POST', headers, body: '{}' })).status, 403);
    } finally { await server.close(); }
});

test('stdio bridge forwards an initialized MCP session without emitting credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-bridge-'));
    const server = new AgentMcpServer({ trusted: () => true, call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
    const endpoint = await server.start(); const connection = path.join(root, 'connection.json'); await fs.writeFile(connection, JSON.stringify({ schemaVersion: 1, ...endpoint }));
    const input = new PassThrough(); const output = new PassThrough(); let text = ''; output.on('data', data => { text += data.toString(); });
    const bridge = runAgentMcpBridge(connection, input, output);
    try {
        input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
        while (!text.includes('"id":1')) { await new Promise(resolve => setTimeout(resolve, 10)); }
        input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n'); input.end();
        await bridge;
        const replies = text.trim().split('\n').map(line => JSON.parse(line)); assert.equal(replies.length, 2); assert.equal(replies[1].id, 2);
        assert.ok(replies[1].result.tools.some((tool: { name: string }) => tool.name === 'kot_ci_import')); assert.ok(!text.includes(endpoint.token));
    } finally { input.end(); await server.close(); assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); }
});

test('story findings and confirmed executions remain distinct in saved reports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-service-')); const store = new AgentStore(path.join(root, 'operations'));
    const service = new AgentService(new AgentWorkspace(root), store, {
        trusted: () => true, canExecute: () => true, tests: async () => [{ id: 'test', name: 'Example', source: 'example.feature' }],
        run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}), definitions: async () => [],
        runtime: () => ({ ready: true }), client: async () => [], form: async () => ({ value: 10 }), screenshot: async () => Buffer.from('png'), variables: async () => [], build: async () => ({ compiled: true }),
        repair: { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false },
        infobases: { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), execute: async () => {}, idle: () => true, provenance: async () => ({}) }
    });
    try {
        const workflows = await service.call('kot_workflow', {});
        assert.ok((workflows.structuredContent!.workflows as string[]).includes('resume'));
        const resume = await service.call('kot_workflow', { name: 'resume' });
        assert.equal(resume.structuredContent!.instructions, service.workflows().resume);
        await assert.rejects(service.call('kot_workflow', { name: 'invented' }));
        const created = await service.call('kot_task_create', { kind: 'story', title: 'Price calculation', story: 'Total must be 10', criteria: ['Total is 10'], requestKey: 'story' });
        const id = created.structuredContent!.id;
        await assert.rejects(service.call('kot_task_record', { id, kind: 'check', text: 'Total', outcome: 'observed_pass', evidence: [] }), /evidence/);
        await service.call('kot_task_record', { id, kind: 'check', text: 'Total', expected: '10', outcome: 'proposed', evidence: ['story:1'] });
        const repair = await store.create('repair', { operationId: id, reason: 'Confirmed control rename', changes: [], evidence: ['form:rename'] });
        await store.update(repair.record.id, value => { value.status = 'completed'; value.result = { verified: false }; });
        await service.call('kot_task_complete', { id, assessment: 'Plan prepared; execution is pending.' });
        const report = await service.call('kot_report', { id }); const markdown = report.structuredContent!.markdown as string;
        assert.match(markdown, /Confirmed control rename/); assert.match(markdown, /"verified": false/);
        assert.match(markdown, /No confirmed test executions/); assert.match(markdown, /agent_assessment/); assert.match(markdown, /proposed/);
    } finally { await service.dispose(); assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); }
});

test('repair confirmation requires latest full success, initial state and exact source snapshots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-proof-')); const store = new AgentStore(path.join(root, 'operations'));
    const file = path.join(root, 'test.feature'); const changed = 'When I click "New"'; await fs.writeFile(file, changed);
    let classification: 'test' | 'configuration' = 'test';
    const service = new AgentService(new AgentWorkspace(root), store, {
        trusted: () => true, canExecute: () => true, tests: async () => [], run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}),
        definitions: async () => [], runtime: () => ({}), client: async () => [], form: async () => ({}), screenshot: async () => Buffer.alloc(0), variables: async () => [], build: async () => ({}),
        repair: { policy: () => 'tests', classify: async () => classification, assertEditable() {}, changed: async () => {}, busy: () => false }, infobases: { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, execute: async () => {}, provenance: async () => ({}) }
    });
    try {
        const { record: repair } = await store.create('repair', { changes: [{ path: await fs.realpath(file), expectedSha256: 'old', text: changed }], reason: 'Control renamed', evidence: [] });
        await store.update(repair.id, value => { value.status = 'completed'; value.result = { verified: false }; });
        const verify = async (status: 'passed' | 'failed', fullVerification: boolean, baselineRestored: boolean, sha256: string, configurationDeployment?: AgentConfigurationDeployment) => {
            const { record: run } = await store.create('run', { tests: ['test'], mode: fullVerification ? 'full' : 'step', environmentId: 'owned-environment', configurationDeployment });
            await store.update(run.id, value => { value.status = status; value.result = { fullVerification, baselineRestored, complete: true }; });
            await store.artifact(run.id, 'source-revision.json', JSON.stringify({ files: [{ path: await fs.realpath(file), sha256 }] }));
            await store.event(repair.id, 'verification', { runId: run.id });
            const result = await service.call('kot_operation', { id: repair.id });
            return { verified: (result.structuredContent!.result as { verified: boolean }).verified, run: run.id };
        };
        assert.equal((await verify('passed', false, true, agentHash(changed))).verified, false);
        assert.equal((await verify('passed', true, false, agentHash(changed))).verified, false);
        assert.equal((await verify('passed', true, true, 'different')).verified, false);
        assert.equal((await verify('passed', true, true, agentHash(changed))).verified, true);
        classification = 'configuration';
        assert.equal((await verify('passed', true, true, agentHash(changed))).verified, false, 'the repaired working tree is not evidence that the database was updated');
        const installed = { operationId: 'installation', repairId: repair.id, files: [{ path: await fs.realpath(file), sha256: agentHash(changed) }] };
        assert.equal((await verify('passed', true, true, 'not-in-git', installed)).verified, true);
        assert.equal((await verify('passed', true, true, agentHash(changed), { ...installed, repairId: 'another-repair' })).verified, false);
        assert.equal((await verify('passed', true, true, agentHash(changed), { ...installed, files: [{ path: file, sha256: 'uninstalled' }] })).verified, false);
        const failed = await verify('failed', true, true, agentHash(changed)); assert.equal(failed.verified, false);
        const report = await service.call('kot_report', { id: repair.id }); assert.match(report.structuredContent!.markdown as string, new RegExp(failed.run));
    } finally { await service.dispose(); assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); }
});

test('an initial environment is consumed by a run while retries of the same request remain idempotent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-baseline-')); const store = new AgentStore(path.join(root, 'operations'));
    const service = new AgentService(new AgentWorkspace(root), store, {
        trusted: () => true, canExecute: () => true, tests: async () => [{ id: 'test', name: 'test', source: 'test.feature' }],
        run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}), definitions: async () => [], runtime: () => ({}),
        client: async () => [], form: async () => ({}), screenshot: async () => Buffer.alloc(0), variables: async () => [], build: async () => ({}),
        repair: { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false }, infobases: { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, execute: async () => {}, provenance: async () => ({}) }
    });
    try {
        const environment = await service.infobases.start({ action: 'create', sourceKind: 'empty', requestKey: 'empty' }); await service.infobases.idle();
        const args = { tests: ['test'], requestKey: 'first-run', environmentId: environment.id };
        const first = await service.call('kot_run_start', args); await service.execution.idle();
        const duplicate = await service.call('kot_run_start', args); assert.equal(duplicate.structuredContent!.id, first.structuredContent!.id);
        const firstResult = await store.get(first.structuredContent!.id as string); assert.equal((firstResult.result as { baselineRestored: boolean }).baselineRestored, true);
        const second = await service.call('kot_run_start', { ...args, requestKey: 'second-run' }); await service.execution.idle();
        assert.equal(((await store.get(second.structuredContent!.id as string)).result as { baselineRestored: boolean }).baselineRestored, false);
    } finally { await service.dispose(); assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); }
});

test('mutating UI interactions are idempotent and an unconfirmed action is never retried automatically', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-interaction-')); const store = new AgentStore(path.join(root, 'operations')); let calls = 0; let fail = false;
    const service = new AgentService(new AgentWorkspace(root), store, {
        trusted: () => true, canExecute: () => true, tests: async () => [], run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}),
        definitions: async () => [], runtime: () => ({}), client: async () => [], form: async () => { calls++; if (fail) { throw new Error('Connection interrupted'); } return { isError: false, content: [{ type: 'text', text: 'Clicked' }] }; },
        screenshot: async () => Buffer.alloc(0), variables: async () => [], build: async () => ({}),
        repair: { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false }, infobases: { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, execute: async () => {}, provenance: async () => ({}) }
    });
    try {
        const args = { name: 'execute_form_actions', arguments: { action: 'click' }, requestKey: 'click-1' };
        const first = await service.call('kot_form_call', args); const repeat = await service.call('kot_form_call', args);
        assert.equal(first.structuredContent!.operationId, repeat.structuredContent!.operationId); assert.equal(calls, 1);
        await assert.rejects(service.call('kot_form_call', { ...args, taskId: 'missing', requestKey: 'missing-task' })); assert.equal(calls, 1);
        fail = true; await assert.rejects(service.call('kot_form_call', { ...args, requestKey: 'click-2' }), /interrupted/);
        await assert.rejects(service.call('kot_form_call', { ...args, requestKey: 'click-2' }), /unconfirmed/); assert.equal(calls, 2);
    } finally { await service.dispose(); assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); }
});

test('launch settings changes require execution permission, a revision and an idempotent request', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-locale-'));
    let allowed = true; let changes = 0;
    const service = new AgentService(new AgentWorkspace(root), new AgentStore(path.join(root,'operations')), {
        trusted: () => true, canExecute: () => allowed, tests: async () => [], run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}),
        definitions: async () => [], runtime: () => ({}), client: async () => [], form: async () => ({}), screenshot: async () => Buffer.alloc(0), variables: async () => [], build: async () => ({}),
        launchSettings: async (action, update) => { if (action === 'read') { return {revision:'current'}; }
            assert.equal(update.expectedRevision, 'current'); changes++; return { verified:false, rebuildRequired:true }; },
        repair: { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false }, infobases: { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, execute: async () => {}, provenance: async () => ({}) }
    });
    try {
        assert.equal((await service.call('kot_launch_settings', { action:'read' })).structuredContent?.revision, 'current');
        const args = { action:'set', interfaceLanguage:'en', locale:'en', expectedRevision:'current', requestKey:'locale-1' };
        const first = await service.call('kot_launch_settings', args);
        assert.equal((await service.call('kot_launch_settings',args)).structuredContent?.operationId, first.structuredContent?.operationId);
        assert.equal(changes,1);
        await assert.rejects(service.call('kot_launch_settings',{action:'set',locale:'en',requestKey:'missing'}),/revision/);
        allowed=false; await assert.rejects(service.call('kot_launch_settings',{...args,requestKey:'disabled'}),/disabled/);
        assert.equal(changes,1);
    } finally { await service.dispose(); assert.ok(agentContains(os.tmpdir(),root)); await fs.rm(root,{recursive:true,force:true}); }
});
