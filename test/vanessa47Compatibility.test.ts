import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { assessVanessaControlCapabilities, parseVanessaControlReply } from '../src/vanessaControlProtocol';
import { VanessaControlSession } from '../src/vanessaControlSession';
import type { VanessaControlTransport } from '../src/vanessaControlTransport';
import { VanessaRuntimeAuthoring } from '../src/vanessaControlAuthoring';
import { parseVanessaClientProfiles } from '../src/vanessaControlClients';
import { mapVanessaStepResults } from '../src/vanessaControlStepResults';
import { VanessaRuntimeSettings } from '../src/vanessaControlSettings';

const tools47 = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.47/tools.json', 'utf8')).tools;
const tools45 = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/tools.json', 'utf8')).tools;
const liveTools47 = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.47/tools.live.json', 'utf8')).tools;
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const json = (value: unknown) => text(JSON.stringify(value));
const status = (recording: boolean, id?: number) => '# Результат записи действий пользователя\n\n' +
    `- Запись идёт: ${recording ? 'Да' : 'Нет'}\n- Есть завершённый результат: ${id === undefined ? 'Нет' : 'Да'}\n` +
    (id === undefined ? '' : `- Идентификатор захвата: ${id}\n`);

test('VA .47 capabilities are negotiated individually while .45 keeps its existing operations', () => {
    const modern = assessVanessaControlCapabilities(tools47); const legacy = assessVanessaControlCapabilities(tools45);
    for (const key of ['stateJson', 'resultsJson', 'elementSteps', 'activeFormElement', 'recordingResult', 'settingsRead', 'settingsWrite', 'settingsPreserveCi', 'clientProfilePort'] as const) {
        assert.equal(modern[key].supported, true, key); assert.equal(legacy[key].supported, false, key);
    }
    for (const key of ['state', 'editor', 'oneStep', 'recording', 'clientProfilesRead'] as const) { assert.equal(legacy[key].supported, true, key); }
    const changed = structuredClone(tools47);
    changed.find((row: any) => row.name === 'get_form_element_steps').inputSchema.required.push('future_context');
    assert.equal(assessVanessaControlCapabilities(changed).elementSteps.supported, false);
    assert.equal(assessVanessaControlCapabilities(changed).stateJson.supported, true);
    assert.equal(assessVanessaControlCapabilities(liveTools47).settingsPreserveCi.supported, true);
    delete changed.find((row: any) => row.name === 'manage_va_settings').inputSchema.properties.preserve_ci_flags;
    assert.equal(assessVanessaControlCapabilities(changed).settingsPreserveCi.supported, false);
    assert.equal(assessVanessaControlCapabilities(changed).settingsWrite.supported, true);
});

test('compatible optional API additions preserve capabilities and structured state', () => {
    const extended = structuredClone(tools47);
    const tool = extended.find((row: any) => row.name === 'get_form_element_steps');
    tool.inputSchema.properties.future_option = { type: 'string' };
    tool.inputSchema.properties.mode.enum = ['suggestions', 'checks', 'future-mode'];
    assert.deepEqual(assessVanessaControlCapabilities(extended), assessVanessaControlCapabilities(tools47));
    const state = { schemaVersion: '1.1', ok: true, isRunning: false,
        currentFeature: { fullPath: 'C:/Own/test.feature' }, currentStep: { lineNumber: 4, status: 'success' } };
    assert.deepEqual(parseVanessaControlReply('get_vanessa_automation_state', json({ ...state,
        future_metadata: { message: 'New presentation', status: 'unrelated' },
        currentStep: { ...state.currentStep, future_property: [1, 2] } })), parseVanessaControlReply('get_vanessa_automation_state', json(state)));
});

test('an incompatible profile response leaves other negotiated operations usable', async () => {
    const wire: VanessaControlTransport = {
        initialize: async () => ({ name: 'VA', version: 'future' }), listTools: async () => tools47,
        callTool: async name => {
            if (name === 'manage_test_client_profiles') { return text('Changed profile contract'); }
            if (name === 'user_actions_recording') { return text(status(false)); }
            if (name === 'get_va_settings') { return json({ ok: true, revision: 3, items: [], errors: [], warnings: [], ignored: [], out_of_scope: [], changed: [], applied: [] }); }
            return json({ schemaVersion: '1.1', ok: true, isRunning: false });
        }, dispose: async () => undefined
    };
    const session = new VanessaControlSession();
    try {
        await session.attach(wire, 'http://localhost:9876');
        await assert.rejects(session.withTestClientControl(clients => clients.list()), /profile list/u);
        assert.equal(session.snapshot.status, 'ready');
        assert.equal((await session.withSettingsControl(settings => settings.list())).revision, 3);
    } finally { await session.detach(); }
});

test('VA .47 connects before any feature has been run using its JSON state contract', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const wire: VanessaControlTransport = {
        initialize: async () => ({ name: 'VA', version: '1.2.043.47' }), listTools: async () => tools47,
        callTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'user_actions_recording') { return text(status(false)); }
            return json({ schemaVersion: '1.1', ok: true, isRunning: false, stateAvailable: false,
                currentFeature: null, currentScenario: null, currentStep: null });
        }, dispose: async () => undefined
    };
    const session = new VanessaControlSession();
    await session.attach(wire, 'http://localhost:9876');
    assert.equal(session.snapshot.status, 'ready');
    assert.deepEqual(calls[0], { name: 'get_vanessa_automation_state', args: { format: 'json' } });
    assert.equal(session.snapshot.observed?.recording, false);
    await session.detach();
});

test('the live .47 tools/list supports captured operations but does not advertise text-step MXL opening', () => {
    for (const [name, capability] of Object.entries(assessVanessaControlCapabilities(liveTools47))) {
        assert.equal(capability.supported, name !== 'mxlOpen', name);
    }
    const reply = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.47/state.before-run.live.json', 'utf8'));
    assert.deepEqual(parseVanessaControlReply('get_vanessa_automation_state', reply), { kind: 'state', state: 'idle' });
});

test('element checks pass the selected column owner and reject a changed form', async () => {
    const requests: Record<string, unknown>[] = []; let identity = 'own'; let change = false;
    const authoring = new VanessaRuntimeAuthoring({ generation: 1, isCurrent: () => true, client: async () => 'client',
        formIdentity: async () => identity, request: async (_tool, args) => {
            requests.push(args); if (change) { identity = 'other'; }
            return text('## Шаги\n```gherkin\nAnd I check\n```\n');
        } });
    assert.equal(await authoring.elementSteps('checks', 'ItemsDescription', 'Items'), 'And I check');
    assert.deepEqual(requests[0], { mode: 'checks', element_name: 'ItemsDescription', table_name: 'Items' });
    change = true;
    await assert.rejects(authoring.elementSteps('checks', 'ItemsDescription', 'Items'));
});

test('structured results require a completed result and preserve Markdown-like error text as data', () => {
    const result = { schemaVersion: '1.1', ok: true, isRunning: false, isComplete: true, status: 'failed',
        steps: [{ status: 'failed', lineNumber: 3, name: 'And I fail' }], error: { message: 'Failed\n## User supplied heading' } };
    assert.deepEqual(parseVanessaControlReply('get_test_results', json(result)), {
        kind: 'runtimeResult', status: 'failed', message: 'Failed\n## User supplied heading'
    });
    assert.equal(parseVanessaControlReply('get_test_results', json({ ...result, isComplete: false })).kind, 'unknown');
    assert.equal(parseVanessaControlReply('get_test_results', json({ ...result, schemaVersion: '2' })).kind, 'unknown');
    assert.equal(parseVanessaControlReply('get_test_results', json({ ...result, status: 'success' })).kind, 'unknown');
});

test('JSON results distinguish repeated equal steps by verified source line and reject another file', () => {
    const source = 'Feature: Test\nScenario: Test\n  And I wait\n  And I wait\n';
    const reply = json({ schemaVersion: '1.1', ok: true, isRunning: false, isComplete: true, featurePath: 'C:/Own/test.feature',
        steps: [{ id: 'a', lineNumber: 3, name: 'And I wait', status: 'success' }, { id: 'b', lineNumber: 4, name: 'And I wait', status: 'failed' }] });
    assert.deepEqual(mapVanessaStepResults(reply, source, 1, undefined, undefined, 'C:/Own/test.feature'), [{ lineNumber: 3, status: 'passed' }, { lineNumber: 4, status: 'failed' }]);
    assert.deepEqual(mapVanessaStepResults(reply, source, 1, undefined, undefined, 'C:/Other/test.feature'), []);
    assert.deepEqual(mapVanessaStepResults(reply, source.replaceAll('I wait', 'I changed'), 1, undefined, undefined, 'C:/Own/test.feature'), []);
});

test('client profiles accept the .47 port row and footer and keep parsing .45', () => {
    const legacy = fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/clients.live.ru.md', 'utf8');
    const modern = legacy.replaceAll('| Дескриптор окна |', '| Порт | 1540 |\n| Дескриптор окна |') + '\nПорт 0 или 1 означает автоматический выбор при запуске нового тонкого, толстого или обычного клиента.\n';
    assert.equal(parseVanessaClientProfiles(text(legacy))[0].port, undefined);
    assert.equal(parseVanessaClientProfiles(text(modern))[0].port, 1540);
    assert.throws(() => parseVanessaClientProfiles(text(modern.replaceAll('1540', '65536'))));
});

test('an externally stopped .47 recording is read once by capture id without another Stop', async () => {
    const calls: Record<string, unknown>[] = [];
    const authoring = new VanessaRuntimeAuthoring({ generation: 1, supportsRecordingResult: true, isCurrent: () => true,
        client: async () => 'own-client', formIdentity: async () => 'own-form', request: async (_name, args) => {
            calls.push(args);
            return text(status(false, 12) + (args.action === 'get_result' ? '\n## Записанные шаги (Turbo Gherkin)\n```gherkin\nAnd I wait\n```\n' : ''));
        } });
    assert.equal(await authoring.stop({ generation: 1, client: 'own-client', previousCaptureId: 11 }), 'And I wait');
    assert.deepEqual(calls, [{ action: 'status' }, { action: 'get_result', capture_id: 12 }]);
    await assert.rejects(authoring.stop({ generation: 1, client: 'own-client', previousCaptureId: 12 }));
});

test('settings apply sends an explicit preview, relative path base and optimistic revision', async () => {
    const calls: Record<string, unknown>[] = [];
    const settings = new VanessaRuntimeSettings(async (_name, args) => {
        calls.push(args); return json({ ok: true, revision: 3, errors: [], warnings: [], ignored: [], out_of_scope: ['GlobalVars'], changed: [], applied: [], dry_run: args.dry_run });
    });
    const parameters = '{"gherkinlanguage":"en","GlobalVars":{}}';
    assert.deepEqual((await settings.apply(parameters, 'C:/Own', 3, true)).out_of_scope, ['GlobalVars']);
    assert.deepEqual(calls[0], { action: 'apply', parameters_json: parameters, base_path: 'C:/Own', expected_revision: 3, dry_run: true, format: 'json' });
    await assert.rejects(settings.apply('[]', 'C:/Own', 3, false));
    assert.equal(calls.length, 1);
});

test('reading an externally completed capture does not stop a newer active recording', async () => {
    const calls: Record<string, unknown>[] = [];
    const authoring = new VanessaRuntimeAuthoring({ generation: 1, supportsRecordingResult: true, isCurrent: () => true,
        client: async () => 'own-client', formIdentity: async () => 'own-form', request: async (_tool, args) => {
            calls.push(args); return text(status(true, 12) + (args.action === 'get_result' ? '\n## Записанные шаги (Turbo Gherkin)\n```gherkin\nAnd I wait\n```\n' : ''));
        } });
    assert.equal(await authoring.stop({ generation: 1, client: 'own-client', previousCaptureId: 11 }), 'And I wait');
    assert.equal(calls.some(row => row.action === 'stop'), false);
});
