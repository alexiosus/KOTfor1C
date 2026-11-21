import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AgentMcpServer } from '../src/agentMcpServer';
import { AgentService } from '../src/agentService';
import { AgentStore } from '../src/agentStore';
import { AgentRepairs } from '../src/agentRepair';
import { AgentWorkspace } from '../src/agentWorkspace';
import { agentScenarioDescription, type AgentDescriptionPorts } from '../src/agentScenarioDescription';
import { ProjectLibraryStore, parseProjectMetadataSidecar } from '../src/projectLibraryStore';
import { resolveProjectEntityIdentity } from '../src/projectLibraryMetadata';
import { readLegacyMetadata } from '../src/projectLegacyMetadata';
import { PROJECT_FORMAT_TEXT, projectFormatFile } from '../src/projectFormat';

const uid = '11111111-1111-4111-8111-111111111111';
const source = `# Authored source\r\nТипФайла: "Сценарий"\r\nДанныеСценария:\r\n    UID: "${uid}"\r\n    Имя: "Purchase"\r\nKOTМетаданные:\r\n    Описание: "Old description"\r\n    Категория: "Purchases"\r\n    PhaseSwitcher:\r\n        Tab: "Purchases"\r\n        OrderOnTab: 7\r\nТекстСценария: |\r\n    And I check the total is 400\r\n`;

async function fixture(t: test.TestContext, modern = false) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-description-'));
    const directory = path.join(root, 'tests/purchase'); await fs.mkdir(directory, { recursive: true });
    if (modern) { await fs.mkdir(path.join(root, '.kot')); await fs.writeFile(projectFormatFile(root), PROJECT_FORMAT_TEXT); }
    const file = path.join(directory, 'scen.yaml'); await fs.writeFile(file, source);
    const workspace = new AgentWorkspace(root); const dirty = new Set<string>(); const changed: string[] = [];
    const ports: AgentDescriptionPorts = { workspaceRoots: [root], scanRoots: [path.join(root, 'tests')],
        assertEditable: files => { if (files.some(file => dirty.has(file))) { throw new Error('Save affected sources.'); } },
        replace: async (file, before, after) => { assert.equal(await fs.readFile(file, 'utf8'), before); await fs.writeFile(file, after); },
        changed: async files => { changed.push(...files); } };
    const call = (action: 'read' | 'set', target = file, update?: { description: string; expectedRevision: string }) => agentScenarioDescription(workspace, ports, action, target, update);
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    return { root, directory, file, workspace, ports, dirty, changed, call };
}

for (const modern of [false, true]) {
    test(`agent saves and clears a description using the existing ${modern ? 'v3 sidecar' : 'legacy inline'} format`, async t => {
        const h = await fixture(t, modern); const before = await h.call('read');
        assert.equal(before.description, 'Old description'); assert.equal(before.storage, modern ? 'sidecar' : 'inline');
        await assert.rejects(fs.stat(h.file + '.kot.yml'), { code: 'ENOENT' });
        const description = 'Назначение\n\nПроверяет покупку: сумма 400.\nОжидаемый результат: "Документ проведён".';
        const saved = await h.call('set', h.file, { description, expectedRevision: before.revision });
        assert.equal(saved.description, description); assert.equal(saved.saved, true); assert.notEqual(saved.revision, before.revision);
        const after = await fs.readFile(h.file, 'utf8');
        if (modern) {
            assert.equal(after, source, 'description updates must not rewrite scenario sources');
            const metadata = parseProjectMetadataSidecar(await fs.readFile(h.file + '.kot.yml', 'utf8'), h.file + '.kot.yml', h.root);
            assert.equal(metadata.metadata.description, description); assert.equal(metadata.metadata.category, 'Purchases');
            const snapshot = await new ProjectLibraryStore(h.root).readMetadata();
            assert.equal(snapshot.groups.find(group => group.id === metadata.metadata.groupId)?.name, 'Purchases');
        } else {
            assert.equal(readLegacyMetadata(after).values.description, description);
            assert.equal(after.slice(after.indexOf('ТекстСценария:')), source.slice(source.indexOf('ТекстСценария:')));
            assert.ok(!after.replace(/\r\n/gu, '').includes('\n'), 'retain CRLF');
            assert.equal(readLegacyMetadata(after).values.order, 7); assert.equal(readLegacyMetadata(after).group?.name, 'Purchases');
            await assert.rejects(fs.stat(h.file + '.kot.yml'), { code: 'ENOENT' });
        }
        await assert.rejects(h.call('set', h.file, { description: 'Stale agent output', expectedRevision: before.revision }), /changed/u);
        await h.call('set', h.file, { description: '', expectedRevision: saved.revision });
        assert.equal((await h.call('read')).description, '');
        assert.deepEqual(h.changed, [h.file, h.file]);
    });
}

test('an existing sidecar retains grouping/category and protects a user description edited after the agent read', async t => {
    const h = await fixture(t, true); const store = new ProjectLibraryStore(h.root);
    const identity = resolveProjectEntityIdentity(h.file, h.root, 'scenario', uid);
    await store.setMetadata(identity, { description: 'Shared description', category: 'User category', groupId: '' });
    const before = await h.call('read'); assert.equal(before.description, 'Shared description');
    await store.setMetadata(identity, { description: 'User edit' });
    await assert.rejects(h.call('set', h.file, { description: 'Agent edit', expectedRevision: before.revision }), /changed/u);
    const current = await h.call('read');
    await h.call('set', h.file, { description: 'New description', expectedRevision: current.revision });
    const sidecar = parseProjectMetadataSidecar(await fs.readFile(h.file + '.kot.yml', 'utf8'), h.file + '.kot.yml', h.root);
    assert.equal(sidecar.metadata.category, 'User category'); assert.equal(sidecar.metadata.groupId, '');
});

test('metadata precondition runs inside the project write queue', async t => {
    const h = await fixture(t, true); const store = new ProjectLibraryStore(h.root);
    const identity = resolveProjectEntityIdentity(h.file, h.root, 'scenario', uid);
    const user = store.setMetadata(identity, { description: 'User edit' });
    const stale = store.setMetadata(identity, { description: 'Stale agent edit' }, current => { assert.equal(current?.description, 'Old description', 'Description changed'); });
    await user; await assert.rejects(stale, /Description changed/u);
    assert.equal((await h.call('read')).description, 'User edit');
});

test('dirty sidecars block description writes without touching the source', async t => {
    const h = await fixture(t, true); const before = await h.call('read'); h.dirty.add(h.file + '.kot.yml');
    await assert.rejects(h.call('set', h.file, { description: 'Agent text', expectedRevision: before.revision }), /Save/u);
    assert.equal(await fs.readFile(h.file, 'utf8'), source); await assert.rejects(fs.stat(h.file + '.kot.yml'), { code: 'ENOENT' });
});

test('native script resolves to metadata and its changes invalidate the description revision', async t => {
    const h = await fixture(t, true); const metadata = path.join(h.directory, 'meta.yaml'); const script = path.join(h.directory, 'scen.feature');
    await fs.rename(h.file, metadata); await fs.writeFile(script, 'And I check the total is 400\n');
    const before = await h.call('read', script); assert.equal(before.path, metadata); assert.equal(before.sources.length, 2);
    await fs.appendFile(script, 'And I check tax is 60\n');
    await assert.rejects(h.call('set', script, { description: 'Outdated description', expectedRevision: before.revision }), /changed/u);
    const current = await h.call('read', metadata);
    await h.call('set', script, { description: 'Проверяет сумму и налог.', expectedRevision: current.revision });
    assert.equal(await fs.readFile(metadata, 'utf8'), source);
    assert.equal(await fs.readFile(script, 'utf8'), 'And I check the total is 400\nAnd I check tax is 60\n');
    assert.equal((await h.call('read', script)).description, 'Проверяет сумму и налог.');
});

test('standalone feature changes only description and rejects scenario/tag injection', async t => {
    const h = await fixture(t); const feature = path.join(h.directory, 'purchase.feature');
    const suffix = '# Keep this comment\r\n\r\n@smoke\r\nScenario: Purchase\r\n Then total is 400\r\n';
    await fs.writeFile(feature, '\uFEFF# language: en\r\nFeature: Purchase\r\nOld description\r\n' + suffix);
    const before = await h.call('read', feature); assert.equal(before.description, 'Old description');
    for (const description of ['Scenario: Injected\n Then fail', '@skip', '# Invisible Markdown heading']) {
        await assert.rejects(h.call('set', feature, { description, expectedRevision: before.revision }));
    }
    const saved = await h.call('set', feature, { description: 'Checks purchase totals.\nExpected total: 400.', expectedRevision: before.revision });
    assert.equal(saved.description, 'Checks purchase totals.\nExpected total: 400.'); assert.equal(saved.storage, 'feature');
    assert.ok((await fs.readFile(feature, 'utf8')).endsWith(suffix));
    await assert.rejects(fs.stat(feature + '.kot.yml'), { code: 'ENOENT' });
});

test('dirty sources, source edits and unrelated YAML cannot be overwritten', async t => {
    const h = await fixture(t); const before = await h.call('read');
    h.dirty.add(h.file);
    await assert.rejects(h.call('set', h.file, { description: 'Agent edit', expectedRevision: before.revision }), /Save/u);
    h.dirty.clear(); await fs.appendFile(h.file, '# User edit\r\n');
    await assert.rejects(h.call('set', h.file, { description: 'Agent edit', expectedRevision: before.revision }), /changed/u);
    const unrelated = path.join(h.directory, 'settings.yaml'); await fs.writeFile(unrelated, 'name: Other\n');
    await assert.rejects(h.call('read', unrelated), /not a scenario/u);
    await assert.rejects(h.call('read', path.join(h.root, '..', 'outside.yaml')));
});

for (const modern of [false, true]) {
    test(`scenario creation includes a saved description without invalidating ${modern ? 'v3' : 'legacy'} repair source fingerprints`, async t => {
        const h = await fixture(t, modern); const file = path.join(h.root, 'tests/generated/scen.yaml');
        const description = 'Purpose: checks a purchase.\nPrerequisites: supplier and item.\nActions: create and post.\nExpected: total is 400.';
        const generated = source.replace(uid, '22222222-2222-4222-8222-222222222222');
        const contents = modern ? generated.slice(0, generated.indexOf('KOTМетаданные:')) + generated.slice(generated.indexOf('ТекстСценария:'))
            : generated.replace('Описание: "Old description"', 'Описание: ' + JSON.stringify(description));
        const store = new AgentStore(path.join(h.root, 'operations'));
        const repairs = new AgentRepairs(store, h.workspace, { policy: () => 'tests', classify: async () => 'test',
            assertEditable() {}, changed: async () => {}, busy: () => false });
        const proposal = await repairs.propose({ changes: [{ path: file, expectedSha256: null, text: contents }], reason: 'Create the requested purchase scenario and its description.', evidence: ['user: acceptance criteria'] });
        await repairs.apply(proposal.id);
        const before = await h.call('read', file);
        await h.call('set', file, { description, expectedRevision: before.revision });
        assert.equal((await h.call('read', file)).description, description);
        assert.equal(await fs.readFile(file, 'utf8'), contents, 'description saving must preserve the source fingerprint recorded by the applied repair');
        assert.equal((await store.get(proposal.id)).status, 'completed');
    });
}

test('new process descriptions use process metadata without altering its steps', async t => {
    const h = await fixture(t, true); const process = path.join(h.directory, 'process.yaml');
    const content = 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "22222222-2222-4222-8222-222222222222"\n    Имя: Purchases\nШагиПроцесса: []\n';
    await fs.writeFile(process, content); const before = await h.call('read', process);
    await h.call('set', process, { description: 'Runs the purchase checks.', expectedRevision: before.revision });
    const metadata = parseProjectMetadataSidecar(await fs.readFile(process + '.kot.yml', 'utf8'), process + '.kot.yml', h.root);
    assert.equal(metadata.identity.kind, 'process'); assert.equal(metadata.metadata.description, 'Runs the purchase checks.');
    assert.equal(await fs.readFile(process, 'utf8'), content);
});

test('real MCP discovers and saves scenario descriptions with audit, idempotency and read-only enforcement', async t => {
    const h = await fixture(t, true); let policy: 'read-only' | 'tests' = 'tests'; let busy = false; let writes = 0;
    const store = new AgentStore(path.join(h.root, 'operations'));
    const service = new AgentService(h.workspace, store, {
        trusted: () => true, canExecute: () => false,
        tests: async () => [], run: async () => ({ status: 'passed' }), cancel: async () => {}, evidence: async () => ({}), revision: async () => ({}),
        definitions: async () => [], runtime: () => ({}), client: async () => [], form: async () => ({}), screenshot: async () => Buffer.alloc(0), variables: async () => [], build: async () => ({}),
        repair: { policy: () => policy, classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => busy },
        infobases: { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, execute: async () => {}, provenance: async () => ({}) },
        scenarioDescription: (action, file, update) => { if (action === 'set') { writes++; } return h.call(action, file, update); }
    });
    const server = new AgentMcpServer({ trusted: () => true, call: (name, args) => service.call(name, args) });
    const endpoint = await server.start(); const client = new Client({ name: 'description-acceptance', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    t.after(async () => { await client.close(); await server.close(); await service.dispose(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: 'Bearer ' + endpoint.token } } }));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'kot_scenario_description'));
    const before = (await client.callTool({ name: 'kot_scenario_description', arguments: { action: 'read', path: h.file } })).structuredContent!;
    const args = { action: 'set', path: h.file, description: 'Проверяет сумму покупки и ожидаемый результат.', expectedRevision: before.revision, requestKey: 'save-description' };
    const saved = await client.callTool({ name: 'kot_scenario_description', arguments: args }); assert.ok(!saved.isError);
    const result = JSON.parse(saved.structuredContent!.preview as string); assert.equal(result.saved, true); assert.equal(result.description, args.description);
    assert.deepEqual((await client.callTool({ name: 'kot_scenario_description', arguments: args })).structuredContent, saved.structuredContent);
    assert.equal(writes, 1);
    const record = await store.get(saved.structuredContent!.operationId as string);
    assert.equal(record.status, 'completed'); assert.ok(record.artifacts.some(artifact => artifact.name === 'scenario_description.json'));
    assert.equal((await client.callTool({ name: 'kot_scenario_description', arguments: { ...args, description: 'Different request' } })).isError, true);
    for (const invalid of [{ action: 'set', path: h.file }, { ...args, requestKey: undefined }, { ...args, description: '\0' }, { ...args, extra: true }]) {
        assert.equal((await client.callTool({ name: 'kot_scenario_description', arguments: invalid })).isError, true);
    }
    busy = true;
    assert.equal((await client.callTool({ name: 'kot_scenario_description', arguments: { ...args, requestKey: 'busy' } })).isError, true);
    busy = false; policy = 'read-only';
    assert.equal((await client.callTool({ name: 'kot_scenario_description', arguments: { ...args, requestKey: 'read-only' } })).isError, true);
    assert.ok(!(await client.callTool({ name: 'kot_scenario_description', arguments: { action: 'read', path: h.file } })).isError);
    assert.equal(writes, 1); assert.equal((await h.call('read')).description, args.description);
});
