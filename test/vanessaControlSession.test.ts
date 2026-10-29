import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { VanessaControlSession } from '../src/vanessaControlSession';
import { VanessaAuthoringError } from '../src/vanessaControlAuthoring';
import type { VanessaControlTransport } from '../src/vanessaControlTransport';
import { createProjectDefinitionView } from '../src/projectDefinition';
import { parseExportScenarios } from '../src/exportScenarioParser';
import { prepareVanessaResultSources } from '../src/vanessaControlStepSources';

const tools = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/tools.json', 'utf8')).tools;

test('in-flight requests expose a safe tool label until completion, without request arguments', async () => {
    const session = new VanessaControlSession(); let hold = false; let release!: () => void; let started!: () => void;
    const beginning = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const wire = fake(async () => { if (hold) { started(); await gate; } return state(); });
    await session.attach(wire, 'http://localhost:9876'); hold = true;
    const pending = session.refreshState(); await beginning;
    assert.equal((session.snapshot as any).request?.tool, 'get_vanessa_automation_state');
    release(); await pending; assert.equal((session.snapshot as any).request, undefined); await session.detach();
});
const state = (running = false) => ({ content: [{ type: 'text' as const, text: fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/state-running.ru.md', 'utf8').replace('Выполнение сценариев: да', `Выполнение сценариев: ${running ? 'да' : 'нет'}`) }] });
const capturedReply = (name: string) => ({ content: [{ type: 'text' as const, text: fs.readFileSync(`test/fixtures/vanessa-control/1.2.043.45/${name}`, 'utf8') }] });

for (const mode of ['runFromLine', 'runFeature'] as const) {
test(`${mode} reports the actual failed line and message when the remaining rows are Skipped and state is loaded-not-run`, async () => {
    const session = new VanessaControlSession(); let executed = false; let cursor = 26;
    const file = 'C:\\KOT\\failure-skipped.feature';
    const steps = [
        'And I save "Покупатель из feature" in "WorkshopCustomer" variable',
        'And I remember workshop message "Native source is ready"',
        'And In the command interface I select "Sales" "Customers"',
        'Then "Customers" window is opened', 'And I click the button named "Create"',
        'Then "Counterparty (create)" window is opened',
        'And I input "$WorkshopCustomer$" text in the field named "DescriptionFull"',
        'And I move to the next attribute', 'And I click the button named "FormWriteAndClose"',
        'And I wait "Counterparty (create)*" window closing in 10 seconds',
        'Then "Customers" window is opened', 'And I activate field named "Description" in "List" table',
        'And I go to line in "List" table', 'And I go to line in "List" table'
    ];
    const source = ['# language: en', 'Feature: Failure', 'Scenario: Failure', ...Array(22).fill(''), ...steps.map(step => '    ' + step)].join('\n');
    const library = '# language: en\n@ExportScenarios\nFeature: Library\nScenario: I remember workshop message "Message"\n  And I save "Message" in "WorkshopMessage" variable\n';
    const definitions = createProjectDefinitionView('exports', parseExportScenarios(library, {
        sourceUri: 'file:///KOT/library.feature', workspaceFolderUri: 'file:///KOT', profileId: '', libraryRootUri: 'file:///KOT', sourceLabel: 'Library', defaultLanguage: 'en'
    }).definitions);
    session.useResultSourceResolver(async (_file, text) => prepareVanessaResultSources(text, definitions, async () => library));
    const loaded = { content: [{ type: 'text' as const, text: 'В редактор был загружен фича файл, но ещё ни разу не запускался. Для получения подробной информации о загруженном файле нужно вызвать get_editor_state.\nИмя загруженного feature файла: ' + file }] };
    const wire = fake(async (name, args) => {
        if (name === 'get_vanessa_automation_state') { return loaded; }
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text: `# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** ${file}\n\n## Активный документ\n- Строка: ${cursor}\n\n### Содержимое\n\`\`\`gherkin\n${source}\n\`\`\`` }] }; }
        if (name === 'select_step') { cursor = Number(args.lineNumber); }
        if (name === 'run_scenario') { executed = true; return { content: [{ type: 'text', text: 'Выполнение сценариев закончено. БЫЛИ ОШИБКИ.' }] }; }
        if (name === 'get_test_results') { return executed ? { content: capturedReply('results-failed-skipped.live.ru.md').content.map(item => ({ ...item,
            text: item.text.replace(/ДопПараметрыПодключения:[ \t]*/u, 'ДопПараметрыПодключения: /P"private-test-password" ') })) } : { content: [{ type: 'text', text: 'No results' }] }; }
        return { content: [] };
    });
    await session.attach(wire, 'http://localhost:9876');
    await session.run(mode, file, mode === 'runFeature' ? 1 : 26, source);
    assert.equal(session.snapshot.execution?.status, 'failed');
    assert.equal(session.snapshot.execution?.currentLineNumber, 28);
    assert.equal(session.failure?.lineNumber, 28);
    assert.match(session.failure?.message ?? '', /Клиент тестирования не подключен/u);
    assert.equal(session.failure?.scenarioName, 'Подготовить заявку из раздельного исходника');
    assert.match(session.failure?.details ?? '', /Технические данные:\n\s+ЗаголовокАктивногоОкна/u);
    assert.doesNotMatch(session.failure?.details ?? '', /private-test-password/u);
    assert.match(session.failure?.details ?? '', /\/P\*\*\*/u);
    assert.equal(session.failure?.stepDescription, 'And In the command interface I select "Sales" "Customers"');
    assert.deepEqual(session.snapshot.execution?.steps?.slice(0, 4), [
        { lineNumber: 26, status: 'passed' }, { lineNumber: 27, status: 'passed' },
        { lineNumber: 28, status: 'failed' }, { lineNumber: 29, status: 'skipped' }
    ]);
    assert.equal(session.snapshot.execution?.steps?.filter(step => String(step.status) === 'skipped').length, 11);
    assert.equal(session.snapshot.status, 'ready'); await session.detach();
});
}

test('a rejected preparation tool reports its sanitized native error', async () => {
    const session = new VanessaControlSession();
    const wire = fake(async name => name === 'open_feature_file'
        ? { isError: true, content: [{ type: 'text', text: 'Cannot select exported group. Password="private"\nЗаголовок активного окна: private title' }] }
        : state());
    await session.attach(wire, 'http://localhost:9876');
    await assert.rejects(session.select('C:\\Tests\\sales.feature', 12), { message: 'Cannot select exported group. Password=***' });
    await session.detach();
});

test('a rejected authoring query does not invalidate the ready session or its confirmed execution', async () => {
    const session = new VanessaControlSession();
    const wire = fake(async name => name === 'execute_feature_step' ? { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] } : state());
    await session.attach(wire, 'http://localhost:9876'); await session.run('oneStep', 'C:\\own.feature', 4);
    const statuses: string[] = []; session.onDidChange(snapshot => statuses.push(snapshot.status));
    await assert.rejects(session.withAuthoringControl(async () => { throw new VanessaAuthoringError('Vanessa authoring was not confirmed.'); }));
    assert.equal(statuses.includes('unknown'), false);
    assert.equal(session.snapshot.execution?.status, 'passed'); await session.detach();
});

test('explicit diagnostics share the session lock, honor cancellation and never expose log text in shared state', async () => {
    const session = new VanessaControlSession(); let reading = false;
    const wire = fake(async name => name === 'get_environment_data' ? { content: [{ type: 'text', text: 'Own environment\nPwd=private' }] } : state());
    await session.attach(wire, 'http://localhost:9876');
    const report = await session.withDiagnosticControl(async diagnostics => {
        reading = true; await assert.rejects(session.run('oneStep', 'C:\\own.feature', 4), /busy/u);
        return diagnostics.collect();
    });
    assert.equal(reading, true); assert.ok(!JSON.stringify(report).includes('private')); assert.ok(!JSON.stringify(session.snapshot).includes('Own environment'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(session.withDiagnosticControl(d => d.collect({}, controller.signal)));
    await session.detach();
});
test('cancelling a diagnostic read does not erase a previously confirmed step result', async () => {
    const session = new VanessaControlSession();
    const wire = fake(async name => name === 'execute_feature_step' ? { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] } : state());
    await session.attach(wire, 'http://localhost:9876'); await session.run('oneStep', 'C:\\own.feature', 4);
    assert.equal(session.snapshot.execution?.status, 'passed');
    const cancellation = new AbortController(); cancellation.abort();
    await assert.rejects(session.withDiagnosticControl(d => d.collect({}, cancellation.signal)));
    assert.equal(session.snapshot.execution?.status, 'passed'); await session.detach();
});
test('a failed form window read preserves a previously confirmed execution result', async () => {
    const session = new VanessaControlSession();
    const wire = fake(async (name, args) => {
        if (name === 'execute_feature_step') { return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
        if (name === 'manage_test_client_profiles') { return capturedReply('clients-connected.live.ru.md'); }
        if (name === 'get_active_window_data') { return { content: [{ type: 'text', text: args?.type === 'form_name' ? 'OwnForm' : 'Own' }] }; }
        if (name === 'get_window_list_testclient') { return { isError: true, content: [{ type: 'text', text: 'Unavailable' }] }; }
        return state();
    });
    await session.attach(wire, 'http://localhost:9876'); await session.run('oneStep', 'C:\\own.feature', 4);
    assert.equal(session.snapshot.execution?.status, 'passed');
    await assert.rejects(session.withFormControl(forms => forms.windows()));
    assert.equal(session.snapshot.execution?.status, 'passed'); await session.detach();
});

test('F11 terminal confirmation never reuses a state observation requested before execution', async () => {
    let hold = false; let release!: () => void; let entered!: () => void;
    const beginning = new Promise<void>(resolve => { entered = resolve; });
    const passed = () => ({ content: [{ type: 'text', text: state().content[0].text.replace('status: Running', 'status: Success') }] });
    const session = new VanessaControlSession();
    const wire = fake(async name => {
        if (name === 'get_vanessa_automation_state' && hold) {
            hold = false; entered();
            return new Promise(resolve => { release = () => resolve({ content: [{ type: 'text', text: state().content[0].text.replace('status: Running', 'status: Failed') }] }); });
        }
        if (name === 'execute_feature_step') { setImmediate(release); return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
        if (name === 'get_test_results') { return { content: [{ type: 'text', text: 'No results' }] }; }
        return passed();
    });
    await session.attach(wire, 'http://localhost:9876'); hold = true;
    const polling = session.refreshState(); await beginning;
    await session.run('oneStep', 'C:\\Tests\\sales.feature', 12); await polling;
    assert.equal(session.snapshot.execution?.status, 'passed'); await session.detach();
});

for (const mode of ['runFromLine', 'runFeature'] as const) {
test(`${mode} rejects feature bytes replaced during preparation and executes only verified loaded content`, async () => {
    const expected = '# language: en\nFeature: Own\nScenario: Own\nAnd Delay 0\n';
    for (const changed of [true, false]) {
        let artifact = expected; let invoked: Record<string, unknown> | undefined; let cursor = 4;
        const session = new VanessaControlSession();
        const wire = fake(async (name, args) => {
            if (name === 'get_test_results') { if (changed) { artifact = expected.replace('Delay 0', 'Dangerous replacement'); } return { content: [{ type: 'text', text: 'No results' }] }; }
            if (name === 'get_editor_state') { return { content: [{ type: 'text', text: `# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\own.feature\n\n## Активный документ\n- Строка: ${cursor}\n\n### Содержимое\n\`\`\`gherkin\n${artifact}\n\`\`\`` }] }; }
            if (name === 'select_step') { cursor = Number(args.lineNumber); }
            if (name === 'run_scenario') { invoked = args; }
            return state();
        });
        await session.attach(wire, 'http://localhost:9876');
        if (changed) { await assert.rejects(session.run(mode, 'C:\\own.feature', 4, expected)); assert.equal(invoked, undefined); }
        else { await session.run(mode, 'C:\\own.feature', 4, expected); assert.equal(invoked?.mode, mode === 'runFeature' ? 'reloadAndRun' : 'reloadAndRunFromLine'); assert.equal(invoked?.filePath, 'C:\\own.feature'); }
        await session.detach();
    }
});
}
test('runFromLine refuses a different or dirty Vanessa tab selected during preparation', async () => {
    const source = '# language: en\nFeature: Own\nScenario: Own\nAnd Delay 0\n';
    for (const variant of ['other', 'dirty'] as const) {
        let selected = false; let executed = false;
        const session = new VanessaControlSession();
        const wire = fake(async (name) => {
            if (name === 'get_editor_state') {
                const file = selected && variant === 'other' ? 'C:\\other.feature' : 'C:\\own.feature';
                return { content: [{ type: 'text', text: '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** ' + file +
                    (selected && variant === 'dirty' ? ' *(изменена)*' : '') + '\n\n## Активный документ\n- Строка: 4\n\n### Содержимое\n```gherkin\n' + source + '\n```' }] };
            }
            if (name === 'select_step') { selected = true; }
            if (name === 'run_scenario') { executed = true; }
            return state();
        });
        await session.attach(wire, 'http://localhost:9876');
        await assert.rejects(session.run('runFromLine', 'C:\\own.feature', 4, source));
        assert.equal(executed, false);
        await session.detach();
    }
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fake(call?: VanessaControlTransport['callTool']): VanessaControlTransport & { calls: string[]; closes: number } {
    const instance = { calls: [] as string[], closes: 0, initialize: async () => ({ name: 'Vanessa', version: 'test' }),
        listTools: async () => tools, callTool: async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
            instance.calls.push(name); return call ? call(name, args, signal) : state();
        }, dispose: async () => { instance.closes++; } };
    return instance;
}

test('a live .45 success acknowledgement cannot override an unknown step marked Failed in runtime state', async () => {
    let executed = false;
    const session = new VanessaControlSession();
    const wire = fake(async name => {
        if (name === 'execute_feature_step') { executed = true; return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
        if (name === 'get_test_results') { return executed ? capturedReply('result-unknown-step.live.ru.md') : { content: [{ type: 'text', text: 'No results' }] }; }
        return executed ? capturedReply('state-unknown-step.live.ru.md') : state();
    });
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\KOT\\unknown.feature', 4);
    assert.equal(session.snapshot.execution?.status, 'failed');
    assert.equal(session.snapshot.execution?.nextLineNumber, undefined);
    assert.match(session.failure?.message ?? '', /Не найдена процедура/u);
    assert.ok(!JSON.stringify(session.snapshot).includes('test4value'), 'error detail stays out of public shared state');
    await session.detach(); assert.equal(session.failure, undefined);
});

test('a tool error cannot erase a failure confirmed by fresh runtime evidence or prevent the next command', async () => {
    let executed = false;
    const session = new VanessaControlSession();
    const wire = fake(async name => {
        if (name === 'execute_feature_step') { executed = true; return { isError: true, content: [{ type: 'text', text: 'Step execution failed' }] }; }
        if (name === 'get_test_results') { return executed ? capturedReply('result-unknown-step.live.ru.md') : { content: [{ type: 'text', text: 'No results' }] }; }
        return executed ? capturedReply('state-unknown-step.live.ru.md') : state();
    });
    await session.attach(wire, 'http://localhost:9876');
    await assert.rejects(session.run('oneStep', 'C:\\KOT\\unknown.feature', 4));
    assert.equal(session.snapshot.execution?.status, 'failed');
    assert.match(session.failure?.message ?? '', /Не найдена процедура/u);
    assert.equal(session.snapshot.status, 'ready');
    assert.equal(session.busy, false);
    await session.select('C:\\KOT\\unknown.feature', 5);
    await session.detach();
});

test('a state transport failure preserves source-bound changed failure history and remains visibly unavailable', async () => {
    let executed = false;
    const session = new VanessaControlSession();
    const wire = fake(async name => {
        if (name === 'execute_feature_step') { executed = true; return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
        if (name === 'get_test_results') { return executed ? capturedReply('results-failed.live.ru.md') : { content: [{ type: 'text', text: 'No results' }] }; }
        if (executed) { throw new Error('Password=transport-secret'); }
        return state();
    });
    await session.attach(wire, 'http://localhost:9876');
    await assert.rejects(session.run('oneStep', 'C:\\KOT\\acceptance\\safe.feature', 4), error => !String(error).includes('transport-secret'));
    assert.equal(session.snapshot.execution?.status, 'failed');
    assert.equal(session.snapshot.status, 'unknown');
    assert.equal(session.snapshot.error, 'request');
    assert.equal(session.busy, false);
    assert.match(session.failure?.message ?? '', /KOT acceptance failure/u);
    assert.ok(!JSON.stringify(session.snapshot).includes('KOT acceptance failure'));
    await assert.rejects(session.select('C:\\KOT\\acceptance\\safe.feature', 5), /Refresh/u);
    await session.attach(fake(), 'http://localhost:9876');
    assert.equal(session.snapshot.status, 'ready');
    await session.detach();
});

test('changed source-bound failure history keeps the actual failed line when state is unavailable', async () => {
    let executed = false;
    const session = new VanessaControlSession();
    const history = capturedReply('results-failed.live.ru.md');
    history.content[0].text = history.content[0].text.replace('НомерСтрокиФичи: 4', 'НомерСтрокиФичи: 6');
    const wire = fake(async name => {
        if (name === 'run_scenario') { executed = true; return { content: [{ type: 'text', text: 'Own failure' }] }; }
        if (name === 'get_test_results') { return executed ? history : { content: [{ type: 'text', text: 'No results' }] }; }
        if (executed) { throw new Error('offline'); }
        return state();
    });
    await session.attach(wire, 'http://localhost:9876');
    await assert.rejects(session.run('runFromLine', 'C:\\KOT\\acceptance\\safe.feature', 4));
    assert.equal(session.snapshot.execution?.status, 'failed');
    assert.equal(session.snapshot.execution?.currentLineNumber, 6);
    assert.equal(session.failure?.lineNumber, 6);
    assert.equal(session.snapshot.status, 'unknown');
    await session.detach();
});

test('advertised form tools are attachment scoped and arguments are validated before execution', async () => {
    const session = new VanessaControlSession();
    assert.deepEqual(session.formTools, []);
    const advertised = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/tools.live.json', 'utf8')).tools;
    const raw = { content: [{ type: 'text', text: 'Own business form value' }] };
    const wire = fake(async name => name === 'get_form_element_data' ? raw : state());
    wire.listTools = async () => advertised;
    await session.attach(wire, 'http://localhost:9876');
    assert.ok(session.formTools.some(tool => tool.name === 'get_form_element_data'));
    await assert.rejects(session.runFormTool('run_scenario', { mode: 'all' }));
    await assert.rejects(session.runFormTool('get_form_element_data', {}));
    await assert.rejects(session.runFormTool('get_form_element_data', { element_name: 42 }));
    assert.equal(wire.calls.includes('get_form_element_data'), false);
    assert.equal(await session.runFormTool('get_form_element_data', { element_name: 'Own' }), raw);
    assert.ok(!JSON.stringify(session.snapshot).includes('Own business form value'));
    await session.detach();
    assert.deepEqual(session.formTools, []);
    await assert.rejects(session.runFormTool('get_form_element_data', { element_name: 'Own' }));
});

test('explicit form tools share the mutation lock, preserve execution on failure and ignore old attachment replies', async () => {
    const advertised = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/tools.live.json', 'utf8')).tools;
    const session = new VanessaControlSession();
    let blocked = false; let rejectTransport = false;
    const response = deferred<{ content: { type: 'text'; text: string }[] }>();
    const wire = fake(async name => {
        if (name === 'execute_feature_step') { return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
        if (name === 'get_form_element_data') {
            if (rejectTransport) { throw new Error('Password=private-transport-value'); }
            if (blocked) { return response.promise; }
            return { isError: true, content: [{ type: 'text', text: 'Own form tool error' }] };
        }
        return state();
    });
    wire.listTools = async () => advertised;
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\own.feature', 4);
    const error = await session.runFormTool('get_form_element_data', { element_name: 'Own' });
    assert.equal((error as { isError?: boolean }).isError, true);
    assert.equal(session.snapshot.execution?.status, 'passed');
    rejectTransport = true;
    await assert.rejects(session.runFormTool('get_form_element_data', { element_name: 'Own' }), error => !String(error).includes('private-transport-value'));
    assert.equal(session.snapshot.execution?.status, 'passed');
    rejectTransport = false; blocked = true;
    const pending = session.runFormTool('get_form_element_data', { element_name: 'Own' });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(session.run('oneStep', 'C:\\own.feature', 4), /busy/u);
    await session.attach(fake(), 'http://localhost:9876');
    response.resolve({ content: [{ type: 'text', text: 'Old form value' }] });
    await assert.rejects(pending);
    assert.equal(session.snapshot.status, 'ready');
    assert.equal(session.snapshot.execution, undefined);
    await session.detach();
});

test('a confirmed failed step retains its safe command error when result history has no description', async () => {
    let executed = false;
    const session = new VanessaControlSession();
    const wire = fake(async name => {
        if (name === 'execute_feature_step') { executed = true; return { content: [{ type: 'text', text: 'Own failed assertion. Password="private"\nExpected value missing\nЗаголовок активного окна: Private business title' }] }; }
        if (name === 'get_test_results') { return { content: [{ type: 'text', text: 'No results' }] }; }
        return executed ? capturedReply('state-unknown-step.live.ru.md') : state();
    });
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\KOT\\unknown.feature', 4);
    assert.equal(session.snapshot.execution?.status, 'failed');
    assert.equal(session.failure?.message, 'Own failed assertion. Password=***\nExpected value missing');
    assert.ok(!JSON.stringify(session.snapshot).includes('Expected value missing'));
    await session.detach();
});

test('state replies containing a failure Markdown section allow refresh and reattach after a failed step', async () => {
    let executed = false;
    const failed = capturedReply('state-unknown-step.live.ru.md');
    failed.content[0].text = failed.content[0].text.replace('- result: ', '- result: Failure\n## В окне есть сообщения пользователю:\n');
    const wire = fake(async name => {
        if (name === 'execute_feature_step') { executed = true; return { content: [{ type: 'text', text: 'Own failure' }] }; }
        if (name === 'get_test_results') { return executed ? capturedReply('result-unknown-step.live.ru.md') : { content: [{ type: 'text', text: 'No results' }] }; }
        return executed ? failed : state();
    });
    const session = new VanessaControlSession();
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\KOT\\unknown.feature', 4);
    assert.equal(session.snapshot.status, 'ready');
    assert.equal(session.snapshot.execution?.status, 'failed');
    await session.refreshState();
    assert.equal(session.snapshot.status, 'ready');
    await session.attach(fake(async () => failed), 'http://localhost:9876');
    assert.equal(session.snapshot.status, 'ready');
    await session.detach();
});

test('F11 reuses the active matching saved feature without an expensive reopen', async () => {
    const source = '# language: en\nFeature: Safe\nScenario: Safe\n    And Delay 1\n';
    const wire = fake(async name => {
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text: '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\own.feature\n\n## Активный документ\n- Строка: 4\n\n### Содержимое\n```gherkin\n' + source + '\n```' }] }; }
        if (name === 'execute_feature_step') { return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
        if (name === 'manage_breakpoints') { return { content: [{ type: 'text', text: '# Точки останова\n\nТочек останова нет.' }] }; }
        return state();
    });
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\own.feature', 4, source);
    assert.equal(session.snapshot.execution?.status, 'passed');
    assert.equal(session.executionMatchesSource('C:\\own.feature', source), true);
    assert.equal(session.executionMatchesSource('C:\\own.feature', source + '# changed'), false);
    assert.equal(session.executionMatchesSource('C:\\other.feature', source), false);
    assert.equal(wire.calls.filter(name => name === 'open_feature_file').length, 0);
    assert.ok(wire.calls.indexOf('get_editor_state') < wire.calls.indexOf('execute_feature_step'));
});

test('F11 keeps the exact active Vanessa path so drive-letter casing cannot create another editor tab', async () => {
    const source = '# language: en\nFeature: Safe\nScenario: Safe\n    And Delay 1\n';
    const sent: string[] = [];
    const wire = fake(async (name, args) => {
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text:
            '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** c:\\Tests\\safe.feature\n\n## Активный документ\n- Строка: 4\n\n### Содержимое\n```gherkin\n' + source + '\n```' }] }; }
        if (name === 'manage_breakpoints') { return { content: [{ type: 'text', text: '# Точки останова\n\nТочек останова нет.' }] }; }
        if (name === 'execute_feature_step') {
            sent.push(String(args.filePath)); return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] };
        }
        return state();
    });
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\Tests\\safe.feature', 4, source);
    assert.deepEqual(sent, ['c:\\Tests\\safe.feature']);
    assert.equal(session.snapshot.execution?.filePath, 'C:\\Tests\\safe.feature', 'local decorations still use the local source identity');
    await session.detach();
});

test('a full feature run reloads the whole file instead of skipping its preparation from a step', async () => {
    const session = new VanessaControlSession();
    const wire = fake(async (name, args) => {
        if (name === 'run_scenario') {
            assert.deepEqual(args, { filePath: 'C:\\own.feature', mode: 'reloadAndRun' });
            return { content: [{ type: 'text', text: '## Результат выполнения сценариев: все сценарии выполнены успешно\n\nИмя сценария: Safe\nРезультат прохождения сценария: Success\n' }] };
        }
        return state();
    });
    await session.attach(wire, 'http://localhost:9876');
    await session.run('runFeature', 'C:\\own.feature', 1);
    assert.equal(session.snapshot.execution?.status, 'passed');
});

test('continue requires a freshly confirmed breakpoint stop, never a detached, failed or idle session', async () => {
    const session = new VanessaControlSession();
    await session.attach(fake(), 'http://localhost:9876');
    await assert.rejects(session.run('resume', 'C:\\own.feature', 4), /confirmed breakpoint/u);
});

test('runtime variables use the session lock, exclude values from shared state and reject old-session results', async () => {
    const text = { content: [{ type: 'text' as const, text: '# Переменные контекста\n\n## Контекст ($var$)\n- `Secret` = own private value\n\n## Сохраняемый контекст ($$var$$)' }] };
    const pending = deferred<typeof text>();
    const wire = fake(async (name, args) => {
        if (name === 'manage_variables') { assert.deepEqual(args, { action: 'get' }); return pending.promise; }
        return state();
    });
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    const operation = session.withVariableControl(variables => variables.list());
    const rejected = assert.rejects(operation);
    await assert.rejects(session.run('oneStep', 'C:\\own.feature', 4), /busy/u);
    await session.detach(); await session.attach(fake(), 'http://localhost:9999');
    pending.resolve(text); await rejected;
    assert.equal(session.snapshot.error, undefined);
    assert.ok(!JSON.stringify(session.snapshot).includes('own private value'));
    const ready = fake(async name => name === 'manage_variables' ? text : state());
    await session.attach(ready, 'http://localhost:9876');
    assert.equal((await session.withVariableControl(variables => variables.list()))[0].representation, 'own private value');
    assert.ok(!JSON.stringify(session.snapshot).includes('own private value'));
});

test('client operations share the mutation lock, ignore old-session replies and never publish profile secrets', async () => {
    const pending = deferred<{ content: Array<{ type: 'text'; text: string }> }>();
    const empty = { content: [{ type: 'text' as const, text: '# Список профилей клиентов тестирования\n\nПрофили не настроены. Добавьте профиль на вкладке \'Клиенты тестирования\' в настройках VA.' }] };
    const wire = fake(name => name === 'manage_test_client_profiles' ? pending.promise : Promise.resolve(state()));
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    const operation = session.withTestClientControl(clients => clients.list());
    const rejected = assert.rejects(operation);
    await assert.rejects(session.run('oneStep', 'C:\\own.feature', 4), /busy/u);
    await session.detach(); await session.attach(fake(), 'http://localhost:9999');
    pending.resolve(empty); await rejected;
    assert.equal(session.snapshot.endpoint, 'http://localhost:9999/mcp');
    assert.equal(session.snapshot.error, undefined);
    assert.ok(!JSON.stringify(session.snapshot).includes('Профиль'));
});

test('saved source content is checked before a breakpoint mutation or manual step, without leaking it into state', async () => {
    const saved = '# language: en\nFeature: Safe\nScenario: Safe\n    And Delay 1\n';
    for (const action of ['oneStep', 'breakpoint'] as const) {
        for (const variant of ['same', 'changed', 'missing', 'dirty'] as const) {
            let mutations = 0;
            const wire = fake(async (name, args) => {
                if (name === 'get_vanessa_automation_state') { return state(); }
                if (name === 'get_editor_state') {
                    assert.equal(args.includeContent, true);
                    return { content: [{ type: 'text', text: '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\test.feature' +
                        (variant === 'dirty' ? ' *(изменена)*' : '') + '\n\n## Активный документ\n- Строка: 4' +
                        (variant === 'missing' ? '' : '\n\n### Содержимое\n```gherkin\n' + (variant === 'changed' ? saved.replace('Delay 1', 'Delay 9') : saved) + '\n```') }] };
                }
                if (name === 'execute_feature_step') { mutations++; return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
                if (name === 'manage_breakpoints' && args.action === 'toggle') { mutations++; }
                return { content: [{ type: 'text', text: '# Точки останова\n\nТочек останова нет.' }] };
            });
            const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
            const act = () => action === 'oneStep' ? session.run('oneStep', 'C:\\test.feature', 4, saved.replace(/\n/gu, '\r\n'))
                : session.synchronizeBreakpoints('C:\\test.feature', undefined, () => true, saved);
            if (variant === 'same') { await act(); assert.equal(mutations, action === 'oneStep' ? 1 : 0); }
            else { await assert.rejects(act(), /differs from the saved source/u); assert.equal(mutations, 0); }
            assert.ok(!JSON.stringify(session.snapshot).includes('Feature: Safe'));
        }
    }
});

test('switching the source during an awaited preparation query prevents the subsequent execution', async () => {
    const pending = deferred<ReturnType<typeof state>>(); let current = true;
    const wire = fake(name => name === 'get_test_results' ? pending.promise : Promise.resolve(state()));
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    const run = session.run('oneStep', 'C:\\test.feature', 4, undefined, () => current);
    const rejected = assert.rejects(run);
    while (!wire.calls.includes('get_test_results')) { await new Promise(resolve => setImmediate(resolve)); }
    current = false; pending.resolve(state()); await rejected;
    assert.ok(!wire.calls.includes('execute_feature_step'));
});

test('a local tab switch after reload preserves captured foreign breakpoints and prevents execution', async () => {
    const session = new VanessaControlSession(); let points = [10]; let cursor = 4; let current = true;
    const wire = fake(async (name, args) => {
        if (name === 'get_vanessa_automation_state') { return state(); }
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text:
            `# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\test.feature\n\n## Активный документ\n- Строка: ${cursor}` }] }; }
        if (name === 'load_features') { points = []; current = false; }
        if (name === 'select_step') { cursor = Number(args.lineNumber); }
        if (name === 'manage_breakpoints') {
            if (args.action === 'toggle') { const line = Number(args.line); points = points.includes(line) ? points.filter(value => value !== line) : [...points, line]; }
            return { content: [{ type: 'text', text: points.length ? `# Точки останова\n\nКоличество: ${points.length}\n${points.map(line => `- ${line}`).join('\n')}` : '# Точки останова\n\nТочек останова нет.' }] };
        }
        return { content: [{ type: 'text', text: '' }] };
    });
    await session.attach(wire, 'http://localhost:9876');
    await session.synchronizeBreakpoints('C:\\test.feature', [14]);
    await assert.rejects(session.run('runFromLine', 'C:\\test.feature', 4, undefined, () => current));
    assert.deepEqual(points, [10, 14]); assert.deepEqual(session.snapshot.breakpoints?.ownedLines, [14]);
    assert.ok(!wire.calls.includes('run_scenario'));
});

test('attach negotiates capabilities and reads state without running or modifying the remote session; detach does not stop it', async () => {
    const wire = fake(); const session = new VanessaControlSession();
    await session.attach(wire, 'http://127.0.0.1:9876/mcp');
    assert.equal(session.snapshot.status, 'ready');
    assert.equal(session.snapshot.capabilities?.oneStep.supported, true);
    assert.deepEqual(wire.calls, ['get_vanessa_automation_state']);
    await session.detach();
    assert.equal(session.snapshot.status, 'detached');
    assert.equal(wire.closes, 1);
    assert.deepEqual(wire.calls, ['get_vanessa_automation_state']);
});

test('reconnect ignores a late state reply from an old generation', async () => {
    const late = deferred<ReturnType<typeof state>>();
    const old = fake(() => late.promise); const current = fake(); const session = new VanessaControlSession();
    const connecting = session.attach(old, 'http://127.0.0.1:9876/mcp');
    while (!old.calls.length) { await new Promise(r => setImmediate(r)); }
    await session.attach(current, 'http://127.0.0.1:9877/mcp');
    late.resolve(state(true)); await connecting.catch(() => undefined);
    assert.equal(session.snapshot.endpoint, 'http://127.0.0.1:9877/mcp');
    assert.equal(session.snapshot.status, 'ready');
});

test('a reconnect waiting for old transport disposal cannot overwrite a newer attachment', async () => {
    const closing = deferred<void>(); const old = fake(); const a = fake(); const b = fake();
    const session = new VanessaControlSession(); await session.attach(old, 'http://localhost:9000');
    old.dispose = () => closing.promise;
    const slow = session.attach(a, 'http://localhost:9001');
    const rejected = assert.rejects(slow, /session changed/i);
    await session.attach(b, 'http://localhost:9002');
    closing.resolve(); await rejected;
    assert.equal(session.snapshot.endpoint, 'http://localhost:9002/mcp');
    assert.equal(session.snapshot.status, 'ready');
    assert.deepEqual(a.calls, []);
});

test('Stop and state bypass an active run, and selection/mutations cannot overwrite its MCP task identity', async () => {
    const run = deferred<ReturnType<typeof state>>(); const wire = fake(name => name === 'run_scenario' ? run.promise : Promise.resolve(state()));
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    const executing = session.run('runFromLine', 'C:\\Tests\\sales.feature', 12);
    await new Promise(r => setImmediate(r));
    await assert.rejects(session.select('C:\\Tests\\sales.feature', 14), /busy/i);
    await assert.rejects(session.synchronizeBreakpoints('C:\\Tests\\sales.feature', [14]), /busy/i);
    await session.refreshState();
    assert.equal(session.snapshot.status, 'running', 'an early idle snapshot must not release the run lock');
    await session.stop();
    assert.ok(wire.calls.includes('stop_scenario'));
    assert.equal(session.snapshot.status, 'stopping');
    run.resolve(state()); await executing;
    assert.equal(session.snapshot.status, 'ready');
});

test('unknown state and remote tool failures never become a successful run; raw server errors are not exposed', async () => {
    let fail = false; const wire = fake(async name => {
        if (fail) { throw new Error('Pwd=secret-business-value'); }
        return name === 'get_vanessa_automation_state' ? { content: [{ type: 'text', text: 'new format' }] } : { isError: true, content: [] };
    });
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    assert.equal(session.snapshot.status, 'unknown');
    await assert.rejects(session.run('oneStep', 'C:\\test.feature', 4));
    assert.notEqual(session.snapshot.status, 'ready');
    fail = true;
    await assert.rejects(session.refreshState(), error => !String(error).includes('secret-business-value'));
    assert.ok(!JSON.stringify(session.snapshot).includes('secret-business-value'));
});

test('external running state blocks local execution and all lines must be positive integers', async () => {
    const session = new VanessaControlSession(); const wire = fake(async () => state(true));
    await session.attach(wire, 'http://localhost:9876');
    await assert.rejects(session.run('oneStep', 'C:\\test.feature', 4), /busy/i);
    for (const line of [0, -1, 1.5, NaN]) { await assert.rejects(session.select('C:\\test.feature', line)); }
    assert.equal(wire.calls.length, 1);
});

test('a failed initial state request clears capabilities and observations after disposing the connection', async () => {
    const wire = fake(async () => { throw new Error('offline'); });
    const session = new VanessaControlSession();
    await assert.rejects(session.attach(wire, 'http://localhost:9876'));
    assert.equal(wire.closes, 1);
    assert.equal(session.snapshot.capabilities, undefined);
    assert.equal(session.snapshot.observed, undefined);
    await assert.rejects(session.refreshState(), /unavailable/i);
});

test('one-step result and progress belong to their generation and do not turn generic acknowledgements into pass', async () => {
    const session = new VanessaControlSession();
    const wire = fake();
    let reply = 'Execution completed';
    wire.callTool = async (name, _args, _signal, progress) => {
        if (name === 'execute_feature_step') {
            progress?.({ completed: 1, total: 2 });
            assert.deepEqual(session.snapshot.execution?.progress, { completed: 1, total: 2 });
            return { content: [{ type: 'text', text: reply }] };
        }
        return state();
    };
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\other.feature', 5);
    assert.equal(session.snapshot.execution?.status, 'unknown');
    reply = 'Шаг в строке фича файла успешно выполнен';
    await session.run('oneStep', 'C:\\other.feature', 5);
    assert.equal(session.snapshot.execution?.status, 'passed');
    await session.detach(); assert.equal(session.snapshot.execution, undefined);
});

test('failed and stopped steps require matching remote file and line, never an unrelated old state', async () => {
    let reply = state();
    const wire = fake(async name => {
        if (name === 'get_vanessa_automation_state') { return reply; }
        reply = state(true); await session.refreshState();
        reply = { content: [{ type: 'text', text: state().content[0].text.replace('status: Running', 'status: Failed') }] };
        return { content: [{ type: 'text', text: 'done' }] };
    });
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    reply = { content: [{ type: 'text', text: state().content[0].text.replace('status: Running', 'status: Failed') }] };
    await session.run('oneStep', 'C:\\other.feature', 12);
    assert.equal(session.snapshot.execution?.status, 'unknown');
    await session.run('oneStep', 'C:\\Tests\\sales.feature', 12);
    assert.equal(session.snapshot.execution?.status, 'failed');
});

test('confirmed idle Broken after Stop cancels only the pending run request and releases its lock', async () => {
    const session = new VanessaControlSession();
    let reply = state(); let runSignal: AbortSignal | undefined;
    const wire = fake(async (name, _args, signal) => {
        if (name === 'run_scenario') {
            runSignal = signal;
            return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        }
        return reply;
    });
    await session.attach(wire, 'http://localhost:9876');
    const executing = session.run('runFromLine', 'C:\\Tests\\sales.feature', 12);
    await new Promise(r => setImmediate(r));
    await session.stop();
    assert.equal(runSignal?.aborted, false, 'the Stop acknowledgement alone cannot release execution');
    reply = state(true); await session.refreshState();
    reply = { content: [{ type: 'text', text: state().content[0].text.replace('status: Running', 'status: Broken') }] };
    await session.refreshState();
    assert.equal(runSignal?.aborted, true, 'confirmed remote stop must cancel the otherwise unanswered MCP run');
    await executing;
    assert.equal(session.snapshot.status, 'ready');
    assert.equal(session.snapshot.execution?.status, 'stopped');
    assert.equal(session.snapshot.error, undefined);
    assert.equal(wire.closes, 0, 'state and Stop must keep their shared connection');
    await session.refreshState();
    await session.select('C:\\Tests\\sales.feature', 14);
});

test('short failures are reconciled against source-bound history, while unrelated history remains unknown', async () => {
    const history = fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/results-failed.live.ru.md', 'utf8');
    let recorded = ''; let iteration = 0;
    const session = new VanessaControlSession();
    const wire = fake(async name => {
        if (name === 'get_vanessa_automation_state') { return state(); }
        if (name === 'get_test_results') { return { content: [{ type: 'text', text: recorded }] }; }
        recorded = history.replace('439 мс', `${439 + iteration++} мс`);
        return { content: [{ type: 'text', text: 'KOT acceptance failure' }] };
    });
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\KOT\\acceptance\\safe.feature', 4);
    assert.equal(session.snapshot.execution?.status, 'failed');
    await session.run('oneStep', 'C:\\KOT\\acceptance\\safe.feature', 5);
    assert.equal(session.snapshot.execution?.status, 'unknown');
    await session.run('oneStep', 'C:\\other.feature', 4);
    assert.equal(session.snapshot.execution?.status, 'unknown');
    assert.ok(!JSON.stringify(session.snapshot).includes('KOT acceptance failure'));
});

test('unchanged history from a previous failure cannot decide the outcome of an unconfirmed new command', async () => {
    const history = fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/results-failed.live.ru.md', 'utf8');
    const session = new VanessaControlSession();
    await session.attach(fake(async name => name === 'get_vanessa_automation_state' ? state()
        : { content: [{ type: 'text', text: name === 'get_test_results' ? history : 'could not start' }] }), 'http://localhost:9876');
    await session.run('oneStep', 'C:\\KOT\\acceptance\\safe.feature', 4);
    assert.equal(session.snapshot.execution?.status, 'unknown');
});

test('only a passed single step may propose the next selection from the matching saved remote editor', async () => {
    let editor = '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\test.feature\n\n## Активный документ\n- Строка: 8';
    const session = new VanessaControlSession();
    const wire = fake(async name => name === 'get_vanessa_automation_state' ? state() : { content: [{ type: 'text', text:
        name === 'get_editor_state' ? editor : name === 'execute_feature_step' ? 'Шаг в строке фича файла успешно выполнен' : '' }] });
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\test.feature', 5);
    assert.equal(session.snapshot.execution?.nextLineNumber, 8, 'control flow comes from Vanessa rather than line + 1');
    editor = editor.replace('C:\\test.feature', 'C:\\other.feature');
    await session.run('oneStep', 'C:\\test.feature', 5);
    assert.equal(session.snapshot.execution?.nextLineNumber, undefined);
    editor = editor.replace('other.feature', 'test.feature *(изменена)*');
    await session.run('oneStep', 'C:\\test.feature', 5);
    assert.equal(session.snapshot.execution?.nextLineNumber, undefined);
});

test('breakpoint commands verify the remote editor and publish confirmed points with attachment-scoped ownership', async () => {
    const session = new VanessaControlSession(); let points = [4];
    const source = '# language: en\nFeature: Safe\nScenario: Safe\n' + '    And Delay 1\n'.repeat(10);
    const wire = fake(async (name, args) => {
        if (name === 'get_vanessa_automation_state') { return state(); }
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text:
            '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\test.feature\n\n## Активный документ\n- Строка: 8' + (args.includeContent ? '\n\n### Содержимое\n```gherkin\n' + source + '\n```' : '') }] }; }
        if (name === 'manage_breakpoints' && args.action === 'toggle') {
            const line = Number(args.line); points = points.includes(line) ? points.filter(value => value !== line) : [...points, line];
            return { content: [] };
        }
        return { content: [{ type: 'text', text: `# Точки останова\n\nКоличество: ${points.length}\n${points.map(line => `- ${line}`).join('\n')}` }] };
    });
    await session.attach(wire, 'http://localhost:9876');
    assert.deepEqual(await session.synchronizeBreakpoints('C:\\test.feature'), [4]);
    await session.synchronizeBreakpoints('C:\\test.feature', [4, 8], undefined, source);
    assert.deepEqual(session.snapshot.breakpoints, { filePath: 'C:\\test.feature', lines: [4, 8], ownedLines: [8] });
    assert.deepEqual(session.ownedBreakpointsForSource('C:\\test.feature', source), [8]);
    assert.deepEqual(session.ownedBreakpointsForSource('C:\\test.feature', source + '# changed'), []);
    assert.deepEqual(session.ownedBreakpointsForSource('C:\\other.feature', source), []);
    await session.synchronizeBreakpoints('C:\\test.feature', []);
    assert.deepEqual(session.snapshot.breakpoints?.lines, [4]);
    await session.detach(); assert.equal(session.snapshot.breakpoints, undefined);
    assert.deepEqual(session.ownedBreakpointsForSource('C:\\test.feature', source), []);
});

test('an unconfirmed breakpoint reports the specific failure and preserves the preceding execution', async () => {
    const session = new VanessaControlSession(); let toggles = 0;
    const wire = fake(async (name, args) => {
        if (name === 'get_vanessa_automation_state') { return state(); }
        if (name === 'execute_feature_step') { return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text:
            '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\test.feature\n\n## Активный документ\n- Строка: 8' }] }; }
        if (name === 'manage_breakpoints' && args.action === 'toggle') {
            toggles++; return { content: [{ type: 'text', text: '# Брейкпоинт переключён\n\n- Строка: 8' }] };
        }
        return { content: [{ type: 'text', text: '# Точки останова\n\nТочек останова нет.' }] };
    });
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\test.feature', 8);
    const previous = session.snapshot.execution; const statuses: string[] = [];
    session.onDidChange(snapshot => statuses.push(snapshot.status));
    await assert.rejects(session.synchronizeBreakpoints('C:\\test.feature', [8]), {
        message: 'Vanessa did not confirm the breakpoint change. The MCP list still shows the previous state. Check the breakpoint in Vanessa before retrying.'
    });
    assert.equal(toggles, 1);
    assert.equal(session.snapshot.breakpoints, undefined);
    assert.equal(statuses.includes('unknown'), false);
    assert.deepEqual(session.snapshot.execution, previous);
    assert.equal(session.snapshot.status, 'ready');
    await session.detach();
});

test('an unavailable Monaco editor cannot confirm an empty breakpoint list or allow a toggle', async () => {
    const session = new VanessaControlSession();
    const wire = fake(async name => name === 'get_vanessa_automation_state' ? state() : { content: [{ type: 'text', text:
        name === 'get_editor_state' ? '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\test.feature\n\n## Активный документ\n- Строка: 8'
            : '# Точки останова\n\nТочек останова нет.\n\nРедактор не доступен. Загрузите фичи (`load_features`) для инициализации.' }] });
    await session.attach(wire, 'http://localhost:9876');
    await assert.rejects(session.synchronizeBreakpoints('C:\\test.feature', [8]), /Vanessa Editor is not ready/u);
    assert.equal(session.snapshot.breakpoints, undefined);
    assert.equal(wire.calls.filter(name => name === 'manage_breakpoints').length, 1);
});

function singleStepBreakpoints() {
    const session = new VanessaControlSession();
    const source = '# language: en\nFeature: Safe\nScenario: Safe\n' + '    And Delay 1\n'.repeat(10);
    const h = { session, source, points: [4], toggles: [] as number[], current: true,
        activeFile: 'C:\\test.feature', failStep: false, switchLocal: false, switchRemote: false, failRestore: false, executed: false, erasePoints: true };
    const wire = fake(async (name, args) => {
        if (name === 'get_vanessa_automation_state') { return state(); }
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text:
            `# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** ${h.activeFile}\n\n## Активный документ\n- Строка: 6` +
            (args.includeContent ? '\n\n### Содержимое\n```gherkin\n' + source + '\n```' : '') }] }; }
        if (name === 'manage_breakpoints') {
            if (args.action === 'toggle') {
                const line = Number(args.line); h.toggles.push(line);
                if (!h.executed || !h.failRestore) { h.points = h.points.includes(line) ? h.points.filter(value => value !== line) : [...h.points, line]; }
            }
            return { content: [{ type: 'text', text: h.points.length ? `# Точки останова\n\nКоличество: ${h.points.length}\n${h.points.map(line => `- ${line}`).join('\n')}` : '# Точки останова\n\nТочек останова нет.' }] };
        }
        if (name === 'execute_feature_step') {
            h.executed = true;
            if (h.erasePoints) { h.points = []; } // .45 reloads the feature as part of this tool.
            if (h.switchLocal) { h.current = false; }
            if (h.switchRemote) { h.activeFile = 'C:\\other.feature'; }
            if (h.failStep) { throw new Error('Step request failed after reload'); }
            return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] };
        }
        return { content: [] };
    });
    return { ...h, wire, data: h };
}

for (const outcome of ['passed', 'request failed', 'local tab changed'] as const) {
test(`F11 restores owned and foreign breakpoints after its internal reload when ${outcome}`, async () => {
    const { session, source, wire, data } = singleStepBreakpoints();
    await session.attach(wire, 'http://localhost:9876');
    await session.synchronizeBreakpoints('C:\\test.feature', [8], undefined, source);
    data.failStep = outcome === 'request failed'; data.switchLocal = outcome === 'local tab changed';
    const run = session.run('oneStep', 'C:\\test.feature', 5, source, () => data.current);
    if (data.failStep) { await assert.rejects(run); } else { await run; }
    assert.deepEqual(data.points, [4, 8], 'the step reload must not erase either owner\'s points');
    assert.deepEqual(session.snapshot.breakpoints, { filePath: 'C:\\test.feature', lines: [4, 8], ownedLines: [8] });
    assert.deepEqual(session.ownedBreakpointsForSource('C:\\test.feature', source), [8]);
    await session.synchronizeBreakpoints('C:\\test.feature', [], undefined, source);
    assert.deepEqual(data.points, [4], 'restored native points must not become KOT-owned');
    await session.detach();
});
}

test('F11 also preserves native Vanessa breakpoints before any KOT breakpoint command', async () => {
    const { session, source, wire, data } = singleStepBreakpoints();
    await session.attach(wire, 'http://localhost:9876');
    await session.run('oneStep', 'C:\\test.feature', 5, source);
    assert.deepEqual(data.points, [4]);
    assert.deepEqual(session.snapshot.breakpoints?.ownedLines, []);
    await session.detach();
});

test('F11 does not toggle points that the runtime kept after the step', async () => {
    const { session, source, wire, data } = singleStepBreakpoints(); data.erasePoints = false;
    await session.attach(wire, 'http://localhost:9876');
    await session.synchronizeBreakpoints('C:\\test.feature', [8], undefined, source);
    await session.run('oneStep', 'C:\\test.feature', 5, source);
    await session.run('oneStep', 'C:\\test.feature', 6, source);
    assert.deepEqual(data.toggles, [8], 'do not remove/re-add points that are already present');
    assert.deepEqual(data.points, [4, 8]);
    await session.detach();
});

for (const reason of ['unconfirmed restoration', 'remote tab changed'] as const) {
test(`F11 clears obsolete local markers when ${reason}`, async () => {
    const { session, source, wire, data } = singleStepBreakpoints();
    await session.attach(wire, 'http://localhost:9876');
    await session.synchronizeBreakpoints('C:\\test.feature', [8], undefined, source);
    data.failRestore = reason === 'unconfirmed restoration'; data.switchRemote = reason === 'remote tab changed';
    await assert.rejects(session.run('oneStep', 'C:\\test.feature', 5, source));
    assert.equal(session.snapshot.breakpoints, undefined, 'do not retain confirmed-looking gutter points after the reload');
    assert.deepEqual(data.points, []);
    if (data.switchRemote) { assert.deepEqual(data.toggles, [8], 'do not restore into a different remote editor'); }
    await session.detach();
});
}

for (const mode of ['runFromLine', 'runFeature'] as const) {
test(`${mode} preserves breakpoints and a partial stop cannot be passed`, async () => {
    const session = new VanessaControlSession(); let points = [10]; let cursor = 12; let reply = state(); let observeRunning = true;
    let continuing = false;
    let source = '# language: en\nFeature: Safe\nScenario: Safe\n' + '    And Delay 1\n'.repeat(14);
    const wire = fake(async (name, args) => {
        if (name === 'get_vanessa_automation_state') { return reply; }
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text:
            `# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\Tests\\sales.feature\n\n## Активный документ\n- Строка: ${cursor}` + (args.includeContent ? '\n\n### Содержимое\n```gherkin\n' + source + '\n```' : '') }] }; }
        if (name === 'load_features') { points = []; }
        if (name === 'select_step') { cursor = Number(args.lineNumber); }
        if (name === 'manage_breakpoints') {
            if (args.action === 'toggle') { const line = Number(args.line); points = points.includes(line) ? points.filter(value => value !== line) : [...points, line]; }
            return { content: [{ type: 'text', text: points.length ? `# Точки останова\n\nКоличество: ${points.length}\n${points.map(line => `- ${line}`).join('\n')}` : '# Точки останова\n\nТочек останова нет.' }] };
        }
        if (name === 'run_scenario') {
            assert.equal(args.mode, continuing || mode === 'runFromLine' ? 'fromCurrentStep' : 'all'); assert.deepEqual(points, [10, 14]);
            if (continuing) { return { content: [{ type: 'text', text: '## Результат выполнения сценариев: все сценарии выполнены успешно\n\nИмя сценария: Safe\nРезультат прохождения сценария: Success\n' }] }; }
            if (observeRunning) { reply = state(true); await session.refreshState(); }
            cursor = 14; reply = { content: [{ type: 'text', text: state().content[0].text.replace('lineNumber: 12', 'lineNumber: 14').replace('- status: Running', '') }] };
            return { content: [{ type: 'text', text: '## Результат выполнения сценариев: все сценарии выполнены успешно\n\nИмя сценария: Safe\nИмя сценария: Safe' }] };
        }
        return { content: [] };
    });
    await session.attach(wire, 'http://localhost:9876');
    await session.synchronizeBreakpoints('C:\\Tests\\sales.feature', [10, 14]);
    await session.run(mode, 'C:\\Tests\\sales.feature', mode === 'runFeature' ? 1 : 12, source);
    assert.ok(wire.calls.includes('load_features'));
    assert.equal(session.snapshot.execution?.status, 'stopped');
    assert.equal(session.snapshot.execution?.stopReason, 'breakpoint');
    assert.equal(session.snapshot.execution?.currentLineNumber, 14);
    assert.deepEqual(session.snapshot.breakpoints?.ownedLines, [14]);
    source += '# externally saved in both editors\n';
    await assert.rejects(session.run('resume', 'C:\\Tests\\sales.feature', 14, source), /source.*changed/u);
    source = source.replace('# externally saved in both editors\n', '');
    const reloads = wire.calls.filter(name => name === 'load_features' || name === 'open_feature_file').length;
    continuing = true;
    await session.run('resume', 'C:\\Tests\\sales.feature', 14, source);
    assert.equal(session.snapshot.execution?.status, 'passed');
    assert.equal(wire.calls.filter(name => name === 'load_features' || name === 'open_feature_file').length, reloads, 'continue does not reload the feature or reset runtime context');
    continuing = false;
    observeRunning = false;
    await session.run(mode, 'C:\\Tests\\sales.feature', mode === 'runFeature' ? 1 : 12);
    assert.equal(session.snapshot.execution?.status, 'unknown', 'an old idle point without evidence of this run is not a confirmed new stop');
    await session.synchronizeBreakpoints('C:\\Tests\\sales.feature', []);
    assert.deepEqual(points, [10], 'restored foreign points are still not owned');
});
}

test('form reads refuse missing/ambiguous clients without exposing connections', async () => {
    const session = new VanessaControlSession();
    const liveTools = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/tools.live.json', 'utf8')).tools;
    const wire = fake(async name => {
        if (name === 'manage_test_client_profiles') { return capturedReply('clients.live.ru.md'); }
        return state();
    });
    wire.listTools = async () => liveTools;
    await session.attach(wire, 'http://localhost:9876');
    await assert.rejects(session.withFormControl(forms => forms.read()), /one connected test client/iu);
    assert.ok(!JSON.stringify(session.snapshot).includes('Строка подключения'));
    await session.detach();
});

test('command-time reload synchronizes an edited saved feature while retaining foreign breakpoints', async () => {
    const saved = '# language: en\nFeature: Safe\nScenario: Safe\n    And Delay 0\n';
    for (const action of ['oneStep', 'breakpoint'] as const) {
        let remote = saved.replace('Delay 0', 'Delay 1'); let points = [8]; let reloads = 0;
        const wire = fake(async (name, args) => {
            if (name === 'get_editor_state') { return { content: [{ type: 'text', text: '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\test.feature\n\n## Активный документ\n- Строка: 4\n\n### Содержимое\n```gherkin\n' + remote + '\n```' }] }; }
            if (name === 'open_feature_file') { remote = saved; reloads++; points = []; return { content: [{ type: 'text', text: 'opened' }] }; }
            if (name === 'manage_breakpoints') {
                if (args.action === 'toggle') { points = points.includes(Number(args.line)) ? points.filter(n => n !== args.line) : [...points, Number(args.line)]; }
                return { content: [{ type: 'text', text: '# Точки останова\n\n' + (points.length ? 'Количество: ' + points.length + '\n' + points.map(n => '- ' + n).join('\n') : 'Точек останова нет.') }] };
            }
            if (name === 'execute_feature_step') { return { content: [{ type: 'text', text: 'Шаг в строке фича файла успешно выполнен' }] }; }
            return state();
        });
        const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
        if (action === 'oneStep') { await session.run('oneStep', 'C:\\test.feature', 4, saved); }
        else { await session.synchronizeBreakpoints('C:\\test.feature', [4], () => true, saved); }
        assert.equal(reloads, 1); assert.ok(points.includes(8));
        assert.deepEqual(session.ownedBreakpointsForSource('C:\\test.feature', saved), action === 'breakpoint' ? [4] : []);
        await session.detach();
    }
});

test('run from a step publishes confirmed completed line results without marking skipped lines', async () => {
    const saved = '# language: en\nFeature: Safe\nScenario: Safe\n    And Delay 99\n    And Delay 0\n    And Delay 1\n';
    let ran = false; let cursor = 5;
    const wire = fake(async (name, args) => {
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text: '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\test.feature\n\n## Активный документ\n- Строка: ' + cursor + '\n\n### Содержимое\n```gherkin\n' + saved + '\n```' }] }; }
        if (name === 'select_step') { cursor = Number(args.lineNumber); }
        if (name === 'run_scenario') { ran = true; cursor = 6; return capturedReply('run-passed.live.ru.md'); }
        if (name === 'get_test_results') { return { content: [{ type: 'text', text: ran ? '# Результаты тестов\n\n- Статус: Success\n\n## Шаги (2)\n1. And Delay 0 → **Success**\n2. And Delay 1 → **Success**' : 'No results' }] }; }
        return state();
    });
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876');
    await session.run('runFromLine', 'C:\\test.feature', 5, saved);
    assert.equal(session.snapshot.execution?.status, 'passed');
    assert.deepEqual((session.snapshot.execution as any).steps, [{ lineNumber: 5, status: 'passed' }, { lineNumber: 6, status: 'passed' }]);
    assert.equal(session.snapshot.status, 'ready'); await session.detach();
});

test('a poll issued before a run cannot add an old passed line to the new run history', async () => {
    let hold = false; let release!: () => void; let entered!: () => void;
    const beginning = new Promise<void>(resolve => { entered = resolve; });
    const fresh = () => ({ content: [{ type: 'text', text: state().content[0].text.replace('lineNumber: 12', 'lineNumber: 4').replace('status: Running', 'status: Failed') }] });
    const wire = fake(async name => {
        if (name === 'get_vanessa_automation_state' && hold) {
            hold = false; entered(); return new Promise(resolve => { release = () => resolve({ content: [{ type: 'text', text: state().content[0].text.replace('status: Running','status: Success') }] }); });
        }
        if (name === 'run_scenario') { setImmediate(release); return { content: [{ type: 'text', text: 'Run failed' }] }; }
        if (name === 'get_test_results') { return { content: [{ type: 'text', text: 'No results' }] }; }
        return fresh();
    });
    const session = new VanessaControlSession(); await session.attach(wire, 'http://localhost:9876'); hold = true;
    const polling = session.refreshState(); await beginning;
    await session.run('runFromLine', 'C:\\Tests\\sales.feature', 4); await polling;
    assert.equal(session.snapshot.execution?.status, 'failed');
    assert.ok(!session.snapshot.execution?.steps?.some(step => step.lineNumber === 12)); await session.detach();
});

test('a remote tab switch during stale-source breakpoint capture aborts before reloading any feature', async () => {
    const saved = '# language: en\nFeature: Own\nScenario: Own\nAnd Delay 0\n'; let other = false; let opened = 0;
    const wire = fake(async (name, args) => {
        if (name === 'get_editor_state') { return { content: [{ type: 'text', text: '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** C:\\' + (other ? 'other' : 'own') + '.feature\n\n## Активный документ\n- Строка: 4\n\n### Содержимое\n```gherkin\n' + saved.replace('Delay 0','Delay 1') + '\n```' }] }; }
        if (name === 'manage_breakpoints' && args.action === 'list') { other = true; return { content: [{ type: 'text', text: '# Точки останова\n\nКоличество: 1\n- 9' }] }; }
        if (name === 'open_feature_file') { opened++; other = false; }
        return state();
    });
    const session = new VanessaControlSession(); await session.attach(wire,'http://localhost:9876');
    await assert.rejects(session.synchronizeBreakpoints('C:\\own.feature',[4],()=>true,saved));
    assert.equal(opened,0); await session.detach();
});
