import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentStore } from '../src/agentStore';
import { AgentExecution, type AgentExecutionPorts, type AgentTestResult } from '../src/agentExecution';
import { AgentWorkspace, agentContains, agentHash } from '../src/agentWorkspace';
import { createTestLink } from './helpers/symlinks';
import { AgentRepairs } from '../src/agentRepair';
import { AgentInfobases, adaptVanessaClientLanguage } from '../src/agentInfobases';
import { renderAgentReport } from '../src/agentReport';
import { agentTools, validateAgentArguments } from '../src/agentTools';
import { mapAgentNativeLine, mapAgentNativeFailure } from '../src/agentNativeSources';
import { resolveVanessaStepLine } from '../src/vanessaControlFeature';
import { acquireAgentControl } from '../src/agentControl';
import { agentClientTemplate, agentLaunchLocale, agentProjectDirectory, prepareAgentProjectDirectory } from '../src/agentClient';
import type { VanessaSettingsReply } from '../src/vanessaControlSettings';

test('agent continuation enters the selected nested group without escaping an empty group', () => {
    const text = 'Feature: Recovery\nScenario: Test\n * Outer\n  # comment\n  * Nested\n   And I read saved data\n And I create another document\n * Empty\n  # no action\n And I create a payment\n';
    const source = { uri: 'file:///test.feature', filePath: '/test.feature', text, dirty: false, version: 0, line: 2 };
    assert.equal(resolveVanessaStepLine(source, 2, 'runFromLine'), 5);
    assert.equal(resolveVanessaStepLine(source, 5, 'runFromLine'), 5);
    assert.throws(() => resolveVanessaStepLine(source, 7, 'runFromLine'), /no executable steps/);
});

test('selected project context uses authored relative paths and confirms a revision-guarded manager change', async () => {
    const base = path.resolve('isolated', 'feature'); const target = path.resolve(base, 'files');
    assert.equal(agentProjectDirectory('{"projectpath":"files"}', base), target);
    assert.equal(agentProjectDirectory('{"КаталогПроекта":"files"}', base), target);
    assert.equal(agentProjectDirectory(undefined, base), base);
    assert.throws(() => agentProjectDirectory('{"projectpath":42}', base));
    let current = path.resolve('another-project'); let revision = 7; const writes: unknown[] = [];
    const reply = (): VanessaSettingsReply => ({ ok: true, revision, item: { key: 'КаталогПроекта', path: '', synonym: '', current, settable: true }, errors: [], warnings: [], ignored: [], out_of_scope: [], changed: [], applied: [] });
    const settings = { get: async () => reply(), set: async (key: string, value: string, expected: number, previous: string) => {
        assert.equal(key, 'КаталогПроекта'); assert.equal(expected, revision); assert.equal(previous, current);
        writes.push(value); current = value; revision++; return reply();
    } };
    assert.equal((await prepareAgentProjectDirectory(settings, target)).current, target);
    assert.equal((await prepareAgentProjectDirectory(settings, target)).changed, false);
    assert.deepEqual(writes, [target]);
    const ignoredWrite = { get: settings.get, set: async () => reply() };
    await assert.rejects(prepareAgentProjectDirectory(ignoredWrite, path.resolve('other')), /confirm/);
    await assert.rejects(prepareAgentProjectDirectory({ ...settings, set: async () => { throw new Error('stale revision'); } }, path.resolve('other')), /stale revision/);
});

async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-core-'));
    t.after(async () => { assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); });
    return { root, store: new AgentStore(path.join(root, 'operations')), workspace: new AgentWorkspace(root) };
}

test('configuration installation binds repaired hashes to checkpoint clones and rejects source/checkpoint drift', async t => {
    const { root, store, workspace } = await fixture(t); const source = path.join(root, 'cf'); await fs.mkdir(source);
    const file = path.join(source, 'Module.bsl'); await fs.writeFile(file, 'Return 1;');
    const repairs = new AgentRepairs(store, workspace, { policy: () => 'all', classify: async () => 'configuration', assertEditable() {}, changed: async () => {}, busy: () => false });
    const repair = await repairs.propose({ changes: [{ path: file, expectedSha256: agentHash('Return 1;'), text: 'Return 2;' }], reason: 'Restore the confirmed calculation after a controlled fault.', evidence: ['acceptance:expected-two'] });
    await repairs.apply(repair.id); let commands = 0; let race = false;
    const bases = new AgentInfobases(store, workspace, { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, provenance: async () => ({}), execute: async args => {
        commands++;
        if (args.includes('/DumpIB')) { await fs.writeFile(args[args.indexOf('/DumpIB') + 1], 'checkpoint bytes'); }
        if (race && args.includes('/LoadConfigFromFiles')) { await fs.writeFile(file, 'changed while Designer was running'); }
    } });
    const base = await bases.start({ action: 'create', requestKey: 'deployment-base' }); await bases.idle();
    assert.equal(await bases.configurationDeployment(base.id), undefined);
    const update = await bases.start({ action: 'update', environmentId: base.id, sourceKind: 'sources', source, repairId: repair.id, requestKey: 'deploy-repair' }); await bases.idle();
    assert.equal((await store.get(update.id)).status, 'completed');
    const installed = await bases.configurationDeployment(base.id);
    assert.equal(installed?.repairId, repair.id); assert.equal(installed?.files[0].sha256, agentHash('Return 2;'));
    const checkpoint = await bases.start({ action: 'checkpoint', environmentId: base.id, requestKey: 'deployment-checkpoint' }); await bases.idle();
    const dump = (await store.get(checkpoint.id)).result as { dt: string; sha256: string };
    assert.equal(dump.sha256, agentHash('checkpoint bytes'));
    const clone = await bases.start({ action: 'create', sourceKind: 'dt', source: dump.dt, stateRole: 'initial', requestKey: 'deployment-clone' }); await bases.idle();
    assert.deepEqual(await bases.configurationDeployment(clone.id), installed);
    await fs.appendFile(dump.dt, 'tampered'); const before = commands;
    const invalid = await bases.start({ action: 'create', sourceKind: 'dt', source: dump.dt, requestKey: 'changed-checkpoint' }); await bases.idle();
    assert.equal((await store.get(invalid.id)).status, 'failed'); assert.equal(commands, before);
    await fs.writeFile(file, 'uninstalled edit');
    const stale = await bases.start({ action: 'update', environmentId: base.id, sourceKind: 'sources', source, repairId: repair.id, requestKey: 'changed-source' }); await bases.idle();
    assert.equal((await store.get(stale.id)).status, 'failed'); assert.equal(commands, before);
    assert.ok(await bases.owned(base.id), 'a rejected preflight did not change the database');
    const unrelated = await bases.start({ action: 'update', environmentId: base.id, sourceKind: 'sources', source, requestKey: 'unbound-install' }); await bases.idle();
    assert.equal((await store.get(unrelated.id)).status, 'completed'); assert.equal(await bases.configurationDeployment(base.id), undefined);
    await fs.writeFile(file, 'Return 2;'); race = true;
    const raced = await bases.start({ action: 'update', environmentId: clone.id, sourceKind: 'sources', source, repairId: repair.id, requestKey: 'raced-install' }); await bases.idle();
    assert.equal((await store.get(raced.id)).status, 'failed');
    await assert.rejects(bases.owned(clone.id), /incomplete configuration update/);
});

test('regional launch repair preserves authentication and quoted command text, replaces only selected switches', () => {
    const result = agentLaunchLocale('/N"Administrator" /P"secret" /C "keep /Len text" /Lru /VL "ru_RU" /UC GodMode', 'en', 'en');
    assert.equal(result, '/N"Administrator" /P"secret" /C "keep /Len text"   /UC GodMode /Len /VLen');
    assert.equal(agentLaunchLocale('/L"ru" /VLen /L de', 'en'), '/VLen /Len');
    assert.equal(agentLaunchLocale('/LoadCfg data.cf /VLru', undefined, 'en_US'), '/LoadCfg data.cf /VLen_US');
    assert.throws(() => agentLaunchLocale('/L /UC GodMode', 'en'), /existing language/);
    assert.throws(() => agentLaunchLocale('/C "unfinished', 'en'), /quotes/);
    assert.throws(() => agentLaunchLocale('', 'en /Execute bad.epf'), /valid/);
});

test('control waits for a local lease but never replays an entered action or waits on another test run', async () => {
    const busy = () => new Error('Vanessa is busy. Stop or wait for the current operation.'); let attempts = 0;
    assert.equal(await acquireAgentControl(async entered => { if (++attempts === 1) { throw busy(); } entered(); return 'ready'; }, () => false), 'ready');
    assert.equal(attempts, 2); attempts = 0;
    await assert.rejects(acquireAgentControl(async entered => { attempts++; entered(); throw busy(); }, () => false), /busy/);
    assert.equal(attempts, 1);
    await assert.rejects(acquireAgentControl(async () => { throw busy(); }, () => true), /busy/);
});

test('the authored client template preserves its test profile name and local credentials without retaining the original base', () => {
    const result = agentClientTemplate(JSON.stringify({ КлиентыТестирования: [{ Имя: 'Administrator', ПутьКИнфобазе: 'File="C:/original";',
        ДопПараметры: '/N"Administrator" /P"" /UC GodMode', ТипКлиента: 'Тонкий', ИмяКомпьютера: 'localhost' }] }));
    assert.deepEqual(result, { name: 'Administrator', synonym: 'Administrator', username: 'Administrator', password: '', additionalParameters: '/UC GodMode', computerName: 'localhost', clientType: 'Thin' });
    assert.equal(agentClientTemplate('{}'), undefined);
    assert.throws(() => agentClientTemplate('{"TestClient":{"datatestclients":[{},{}]}}'), /multiple or ambiguous/);
    assert.throws(() => agentClientTemplate('{"datatestclients":[{"Name":"Remote","ComputerName":"other-computer"}]}'), /local/);
});
function ports(run: AgentExecutionPorts['run']): AgentExecutionPorts {
    return { tests: async () => [{ id: 'a', name: 'A', source: 'a.feature' }, { id: 'b', name: 'B', source: 'b.feature' }], run,
        cancel: async () => {}, evidence: async () => ({ failure: 'expected 10, got 20' }), revision: async () => ({ commit: 'abc', diff: 'saved' }) };
}

test('agent run stops on the first failure and retains unexecuted tests and evidence', async t => {
    const { store } = await fixture(t); const calls: string[] = [];
    const executor = new AgentExecution(store, ports(async testCase => { calls.push(testCase.id); return { status: 'failed' }; }));
    const started = await executor.start({ tests: ['a', 'b'], stopOnFailure: true, requestKey: 'first', mode: 'full' });
    await executor.idle(); const result = await store.get(started.id);
    assert.deepEqual(calls, ['a']); assert.equal(result.status, 'failed'); assert.equal(result.artifacts.length, 2);
    assert.deepEqual((result.result as { remaining: string[] }).remaining, ['b']);
    assert.match(renderAgentReport(result), /remaining/); assert.match(renderAgentReport(result), /failed/);
});

test('request key prevents duplicate execution while the original run is active', async t => {
    const { store } = await fixture(t); let finish!: (value: AgentTestResult) => void; let count = 0;
    const executor = new AgentExecution(store, ports(async () => { count++; return new Promise(resolve => { finish = resolve; }); }));
    const request = { tests: ['a'], stopOnFailure: true, requestKey: 'same' };
    const first = await executor.start(request); const repeated = await executor.start(request);
    assert.equal(first.id, repeated.id);
    while (!finish) { await new Promise(resolve => setImmediate(resolve)); }
    finish({ status: 'passed' }); await executor.idle(); assert.equal(count, 1);
    await assert.rejects(executor.start({ ...request, tests: ['b'] }), /different request/);
});

test('a passed probe is explicitly distinct from full verification', async t => {
    const { store } = await fixture(t); const executor = new AgentExecution(store, ports(async () => ({ status: 'passed' })));
    const first = await executor.start({ tests: ['a'], stopOnFailure: true, requestKey: 'probe', mode: 'step', line: 9 });
    await executor.idle(); assert.equal((await store.get(first.id)).status, 'passed');
    assert.equal(((await store.get(first.id)).result as { fullVerification: boolean }).fullVerification, false);
});

test('host restart marks interrupted execution unknown without replaying it', async t => {
    const { store } = await fixture(t); const { record } = await store.create('run', { tests: ['a'] });
    await store.update(record.id, value => { value.status = 'running'; });
    await new AgentStore(store.directory).recover(); const recovered = await store.get(record.id);
    assert.equal(recovered.status, 'unknown'); assert.equal(recovered.events[0].kind, 'host_restarted');
});

test('cancellation belongs only to the active run and preserves a confirmed stop', async t => {
    const { store } = await fixture(t); let stopped!: () => void;
    const executor = new AgentExecution(store, ports(async (_test, signal) => new Promise(resolve => {
        stopped = () => resolve({ status: 'stopped' }); signal.addEventListener('abort', stopped, { once: true });
    })));
    const record = await executor.start({ tests: ['a'], stopOnFailure: true, requestKey: 'stop' });
    while (!stopped) { await new Promise(resolve => setImmediate(resolve)); }
    await assert.rejects(executor.cancel('another'), /does not own/);
    await executor.cancel(record.id); await executor.idle(); assert.equal((await store.get(record.id)).status, 'stopped');
});

test('repair refuses stale sources and does not overwrite a user edit', async t => {
    const { root, store, workspace } = await fixture(t); const file = path.join(root, 'test.feature'); const original = 'When I click "Old"';
    await fs.writeFile(file, original);
    const repairs = new AgentRepairs(store, workspace, { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false });
    const repair = await repairs.propose({ changes: [{ path: file, expectedSha256: agentHash(original), text: 'When I click "New"' }], reason: 'The real form element was renamed.', evidence: ['form:old-new'] });
    assert.equal(repair.status, 'awaiting_agent'); await fs.writeFile(file, 'User changes');
    await assert.rejects(repairs.apply(repair.id), /Source changed/); assert.equal(await fs.readFile(file, 'utf8'), 'User changes');
});

test('assertion and table edits require user review even under automatic configuration policy', async t => {
    const { root, store, workspace } = await fixture(t); const file = path.join(root, 'test.feature'); const before = 'Then the table contains\n | total | 10 |';
    await fs.writeFile(file, before);
    const repairs = new AgentRepairs(store, workspace, { policy: () => 'all', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false });
    const repair = await repairs.propose({ changes: [{ path: file, expectedSha256: agentHash(before), text: before.replace('10', '20') }], reason: 'The table expectation needs investigation.', evidence: ['run:failure'] });
    assert.equal(repair.status, 'awaiting_approval'); await assert.rejects(repairs.apply(repair.id), /requires approval/);
    await repairs.approve(repair.id, false); assert.equal((await store.get(repair.id)).status, 'cancelled');
});

test('a permitted action repair preserves before/after evidence and remains unverified', async t => {
    const { root, store, workspace } = await fixture(t); const file = path.join(root, 'test.feature'); const before = 'When I click "Old"\nThen total is 10'; await fs.writeFile(file, before);
    const repairs = new AgentRepairs(store, workspace, { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false });
    const repair = await repairs.propose({ changes: [{ path: file, expectedSha256: agentHash(before), text: before.replace('Old', 'New') }], reason: 'A confirmed form rename changed this control.', evidence: ['form:rename'] });
    const applied = await repairs.apply(repair.id); assert.equal(applied.status, 'completed'); assert.equal((applied.result as { verified: boolean }).verified, false);
    assert.equal(applied.artifacts.length, 2); assert.match(await fs.readFile(file, 'utf8'), /New/);
});

test('workspace resolves real paths, rejects outside/private paths and ignores missing optional roots', async t => {
    const { root } = await fixture(t); await fs.writeFile(path.join(root, 'ok.txt'), 'ok');
    const workspace = new AgentWorkspace(root, () => [path.join(root, 'missing')]);
    assert.equal((await workspace.read('ok.txt')).text, 'ok');
    await assert.rejects(workspace.resolve('../outside.txt', true), /outside/);
    await assert.rejects(workspace.resolve('.git/config'), /Private/);
});

test('workspace grants only the native-approved path for its current session and supports missing configured destinations', async t => {
    const { root } = await fixture(t);
    const destination = path.join(path.dirname(root), path.basename(root) + '-destination');
    const prompted: string[] = []; let allow = false;
    const workspace = new AgentWorkspace(root, () => [], async file => { prompted.push(file); return allow; });
    await assert.rejects(workspace.resolve(destination, true), /outside/);
    allow = true;
    assert.equal(await workspace.resolve(destination, true), destination);
    assert.equal(await workspace.resolve(path.join(destination, 'nested', '1Cv8.1CD'), true), path.join(destination, 'nested', '1Cv8.1CD'));
    assert.equal(prompted.length, 2);
    allow = false;
    await assert.rejects(workspace.resolve(destination + '-sibling', true), /outside/);
    await assert.rejects(workspace.resolve(path.join(destination, '.ssh', 'key'), true), /Private/);
    assert.equal(prompted.length, 3);
    await assert.rejects(new AgentWorkspace(root).resolve(destination, true), /outside/);
    assert.equal(await new AgentWorkspace(root, () => [destination]).resolve(path.join(destination, '1Cv8.1CD'), true), path.join(destination, '1Cv8.1CD'));
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('workspace rechecks the actual target after native access approval', async t => {
    const { root } = await fixture(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-access-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const original = path.join(outside, 'original'); const other = path.join(outside, 'other'); const link = path.join(outside, 'link');
    await fs.mkdir(original); await fs.mkdir(other);
    if (!await createTestLink(t, original, link)) { return; }
    const workspace = new AgentWorkspace(root, () => [], async () => {
        await fs.unlink(link); await fs.symlink(other, link, process.platform === 'win32' ? 'junction' : 'dir'); return true;
    });
    await assert.rejects(workspace.resolve(path.join(link, 'new-base'), true), /changed while access/);
    await assert.rejects(new AgentWorkspace(root).resolve(other), /outside/);
});

test('environment preparation uses a fresh owned directory and records snapshot limitations', async t => {
    const { root, store, workspace } = await fixture(t); const source = path.join(root, 'initial.dt'); await fs.writeFile(source, 'DT');
    const commands: string[][] = [];
    const environments = new AgentInfobases(store, workspace, { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, provenance: async () => ({ platform: 'test' }), execute: async args => {
        commands.push([...args]); const dump = args.indexOf('/DumpIB'); if (dump >= 0) { await fs.writeFile(args[dump + 1], 'checkpoint'); }
    } });
    const created = await environments.start({ action: 'create', sourceKind: 'dt', source, requestKey: 'base' }); await environments.idle();
    const base = await environments.owned(created.id); assert.ok(agentContains(await fs.realpath(store.directory), base)); assert.equal(commands[0][0], 'CREATEINFOBASE');
    assert.ok(commands[1].includes('/RestoreIB')); assert.equal(((await store.get(created.id)).result as { sessionRestored: boolean }).sessionRestored, false);
    const checkpoint = await environments.start({ action: 'checkpoint', environmentId: created.id, requestKey: 'checkpoint' }); await environments.idle();
    assert.equal((await store.get(checkpoint.id)).status, 'completed');
    await assert.rejects(environments.owned(checkpoint.id), /not ready/);
});

test('tool input validation rejects unknown fields and malformed nested changes', () => {
    assert.equal(new Set(agentTools.map(tool => tool.name)).size, agentTools.length);
    const tool = agentTools.find(item => item.name === 'kot_repair_propose')!;
    assert.throws(() => validateAgentArguments(tool.inputSchema, { changes: [{ path: 'x', expectedSha256: null, text: 'x', command: 'unexpected' }], reason: 'x', evidence: [] }));
    assert.throws(() => validateAgentArguments(agentTools[0].inputSchema, { limit: -1 }));
    assert.throws(() => validateAgentArguments(agentTools[0].inputSchema, { limit: 1, extra: true }));
});

test('failed environment preparation retains the actual platform log as an artifact', async t => {
    const { store, workspace } = await fixture(t);
    const environments = new AgentInfobases(store, workspace, { register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle: () => true, provenance: async () => ({}), execute: async (args, log) => {
        assert.match(args[1], /^File=/u); assert.ok(!args[1].includes('\\"'));
        await fs.writeFile(log, 'Platform rejected the configuration version'); throw new Error('Platform exited with code 1');
    } });
    const operation = await environments.start({ action: 'create', requestKey: 'failed-create' }); await environments.idle();
    const record = await store.get(operation.id); assert.equal(record.status, 'failed');
    const log = record.artifacts.find(artifact => artifact.name === '1c-output.log'); assert.ok(log);
    assert.match(await fs.readFile(log.file, 'utf8'), /configuration version/);
});

test('client tooling changes only the borrowed language reference and rejects unsafe names', async t => {
    const { root } = await fixture(t); const directory = path.join(root, 'extension');
    await fs.mkdir(path.join(directory, 'Languages'), { recursive: true });
    await fs.writeFile(path.join(directory, 'Configuration.xml'), '<Configuration><Language>Русский</Language><Version>1.43</Version></Configuration>');
    await fs.writeFile(path.join(directory, 'Languages', 'Русский.xml'), '<Language uuid="original"><Properties><Name>Русский</Name><LanguageCode>ru</LanguageCode></Properties></Language>');
    await fs.writeFile(path.join(directory, 'ConfigDumpInfo.xml'), '<Metadata name="Language.Русский"/>');
    await assert.rejects(adaptVanessaClientLanguage(directory, '../outside'));
    await adaptVanessaClientLanguage(directory, 'Russian');
    assert.equal(await fs.readFile(path.join(directory, 'Configuration.xml'), 'utf8'), '<Configuration><Language>Russian</Language><Version>1.43</Version></Configuration>');
    assert.equal(await fs.readFile(path.join(directory, 'Languages', 'Russian.xml'), 'utf8'), '<Language uuid="original"><Properties><Name>Russian</Name><LanguageCode>ru</LanguageCode></Properties></Language>');
    assert.equal(await fs.readFile(path.join(directory, 'ConfigDumpInfo.xml'), 'utf8'), '<Metadata name="Language.Russian"/>');
    await assert.rejects(fs.stat(path.join(directory, 'Languages', 'Русский.xml')));
});

test('client tooling rejects an arbitrary CFE before invoking Designer and never accepts an unowned base', async t => {
    const {root,store,workspace}=await fixture(t);let commands=0;
    const environments=new AgentInfobases(store,workspace,{register: async () => ({ status: 'added', registeredName: 'KOT test', sourceFilePath: 'ibases.v8i' }), idle:()=>true,provenance:async()=>({}),execute:async()=>{commands++;}});
    const base=await environments.start({action:'create',requestKey:'tooling-base'});await environments.idle();
    const source=path.join(root,'untrusted.cfe');await fs.writeFile(source,'not the pinned official extension');
    const install=await environments.start({action:'prepare_tools',environmentId:base.id,source,requestKey:'tooling-install'});await environments.idle();
    const record=await store.get(install.id);assert.equal(record.status,'failed');assert.match((record.result as {error:string}).error,/SHA-256/);
    assert.equal(commands,1,'only CREATEINFOBASE ran; no unverified extension may be installed');
    assert.ok(await environments.owned(base.id), 'a rejected CFE did not mutate or invalidate the base');
    await store.event(install.id, 'tools_install_started', {});
    await assert.rejects(environments.owned(base.id), /incomplete configuration update/);
    const outside=await environments.start({action:'prepare_tools',environmentId:'missing',source,requestKey:'tooling-unowned'});await environments.idle();
    assert.equal((await store.get(outside.id)).status,'failed');assert.equal(commands,1);
});

test('large logs are scanned in bounded pages without losing the full-file fingerprint', async t => {
    const { root, workspace } = await fixture(t); const file = path.join(root, 'large.log');
    const content = Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 120), Buffer.from('\r\nneedle\r\nlast')]); await fs.writeFile(file, content);
    const result = await workspace.read(file, 2, 1); assert.equal(result.text, 'needle'); assert.equal(result.sha256, agentHash(content)); assert.equal(result.nextLine, 3);
    const matches = await workspace.search(file, 'needle'); assert.equal(matches.total, 1); assert.equal(matches.matches[0].line, 2);
});

test('event history appends separately and recovers a truncated final write', async t => {
    const { store } = await fixture(t); const { record } = await store.create('incident', {});
    await store.update(record.id, value => { value.status = 'awaiting_agent'; });
    for (let index = 0; index < 20; index++) { await store.event(record.id, 'progress', { index }); }
    const directory = path.join(store.directory, record.id);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'operation.json'), 'utf8')).events.length, 0);
    await fs.appendFile(path.join(directory, 'events.ndjson'), '{"time":"unfinished');
    await store.recover(); await store.event(record.id, 'finding', { text: 'recovered' });
    const recovered = await store.get(record.id); assert.equal(recovered.events.length, 21); assert.equal(recovered.events[20].kind, 'finding');
});

test('operation publication survives transient file locks without exposing a partial record', async t => {
    const { root } = await fixture(t); const directory = path.join(root, 'locked-operations');
    const errors = ['EPERM', 'EACCES', 'EBUSY']; let locked = false; let attempts = 0;
    const store = new AgentStore(directory, async (temporary, destination) => {
        if (locked && attempts < errors.length) {
            assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).status, 'queued');
            throw Object.assign(new Error('Temporary file lock'), { code: errors[attempts++] });
        }
        await fs.rename(temporary, destination);
    });
    const { record } = await store.create('incident', { title: 'durable' }); locked = true;
    await store.update(record.id, value => { value.status = 'completed'; });
    assert.equal(attempts, 3); assert.equal((await store.get(record.id)).status, 'completed');
    assert.deepEqual((await store.get(record.id)).request, { title: 'durable' });
    assert.deepEqual(await fs.readdir(path.join(directory, record.id)), ['operation.json']);
});

test('an incompletely saved repair proposal cannot be applied', async t => {
    const { root, workspace } = await fixture(t);
    const store = new AgentStore(path.join(root, 'incomplete-proposal'), async (temporary, destination) => {
        const pending = JSON.parse(await fs.readFile(temporary, 'utf8'));
        if (pending.artifacts.length) { throw Object.assign(new Error('Artifact metadata could not be saved'), { code: 'ENOSPC' }); }
        await fs.rename(temporary, destination);
    });
    const repairs = new AgentRepairs(store, workspace, { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false });
    const file = path.join(root, 'new.feature');
    await assert.rejects(repairs.propose({ changes: [{ path: file, expectedSha256: null, text: 'Feature: New\n' }],
        reason: 'A complete proposal needs durable before and after evidence.', evidence: ['user: test generation'] }), { code: 'ENOSPC' });
    const [proposal] = await store.list(); assert.equal(proposal.status, 'queued');
    await assert.rejects(repairs.apply(proposal.id), /not ready/);
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

for (const code of ['ENOSPC', 'EBUSY']) {
test(`failed publication preserves the previous operation and leaves the queue usable: ${code}`, async t => {
    const { root } = await fixture(t); const directory = path.join(root, 'failed-publication'); let fail = false; let attempts = 0;
    const store = new AgentStore(directory, async (temporary, destination) => {
        if (fail) { attempts++; throw Object.assign(new Error('Publish failed'), { code }); }
        await fs.rename(temporary, destination);
    });
    const { record } = await store.create('incident', { title: 'keep' }); fail = true;
    await assert.rejects(store.update(record.id, value => { value.status = 'completed'; }), { code });
    assert.equal(attempts, code === 'EBUSY' ? 6 : 1);
    assert.equal((await store.get(record.id)).status, 'queued');
    assert.deepEqual(await fs.readdir(path.join(directory, record.id)), ['operation.json']);
    fail = false; await store.update(record.id, value => { value.status = 'awaiting_agent'; });
    assert.equal((await store.get(record.id)).status, 'awaiting_agent');
});
}

test('localized edits repair long sources and preserve unrelated data and line endings', async t => {
    const { root, store, workspace } = await fixture(t); const file = path.join(root, 'long.feature');
    const before = '# context\r\n'.repeat(100000) + 'When I click "Old"\r\nThen total is 10\r\n'; await fs.writeFile(file, before);
    const repairs = new AgentRepairs(store, workspace, { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false });
    const repair = await repairs.propose({ changes: [{ path: file, expectedSha256: agentHash(before), edits: [{ search: 'When I click "Old"', replace: 'When I click "New"' }] }],
        reason: 'The current form confirms this renamed control.', evidence: ['form:rename'] });
    await repairs.apply(repair.id); assert.equal(await fs.readFile(file, 'utf8'), before.replace('"Old"', '"New"'));
});

test('new generated test folders are created only when the permitted repair is applied', async t => {
    const { root, store, workspace } = await fixture(t); const file = path.join(root, 'new', 'nested', 'example.feature');
    const repairs = new AgentRepairs(store, workspace, { policy: () => 'tests', classify: async () => 'test', assertEditable() {}, changed: async () => {}, busy: () => false });
    const repair = await repairs.propose({ changes: [{ path: file, expectedSha256: null, text: 'Feature: New\nScenario: Example\n Then total is 10\n' }],
        reason: 'The accepted story requires this additional test.', evidence: ['story:acceptance'] });
    await assert.rejects(fs.stat(path.dirname(file)), { code: 'ENOENT' }); await repairs.apply(repair.id); assert.match(await fs.readFile(file, 'utf8'), /Then total/);
});

test('native script mapping preserves repeated invocations and maps the deepest failure to the script', () => {
    const uid = '4d14f7bd-9dd4-4dfb-8019-02b3f114fd9b';
    const native = { metadataUri: 'file:///project/test/meta.yaml', scriptUri: 'file:///project/test/scen.feature',
        metadata: `ТипФайла: Сценарий\nДанныеСценария:\n    UID: ${uid}\n`, script: 'And I click "Save"\n' };
    const featureContent = 'Feature: Example\nScenario: Test\n And I click "Save"\n And I click "Save"\n';
    const context = { artifacts: [{ worker: 1, feature: 'test.feature', sourceMap: 'test.str', featureContent,
        sourceMapContent: JSON.stringify({ ДанныеСценария: [3, 4].map(line => ({ UIDСценария: uid, СтрокаЛин: line, СтрокаОриг: 1, УровеньВложенности: 1 })) }) }] };
    assert.deepEqual(mapAgentNativeLine(context, [native], native.scriptUri, 0), [{ worker: 1, feature: 'test.feature', lineNumber: 3 }, { worker: 1, feature: 'test.feature', lineNumber: 4 }]);
    assert.deepEqual(mapAgentNativeFailure(context, [native], 1, 'test.feature', 4), { kind: 'unique', location: { uri: native.scriptUri, lineIndex: 0 } });
    assert.deepEqual(mapAgentNativeLine(context, [native, { ...native, metadataUri: 'file:///other/meta.yaml', scriptUri: 'file:///other/scen.feature' }], native.scriptUri, 0), []);
});
