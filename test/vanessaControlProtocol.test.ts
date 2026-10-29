import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assessVanessaControlCapabilities, normalizeVanessaControlEndpoint, parseVanessaControlReply } from '../src/vanessaControlProtocol';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'test/fixtures/vanessa-control/1.2.043.45', name), 'utf8');
const tools = () => JSON.parse(fixture('tools.json')).tools;
const reply = (text: string) => ({ content: [{ type: 'text', text }] });

test('a captured failed run with skipped rows retains its source-bound failure', () => {
    const text = fixture('results-failed-skipped.live.ru.md');
    assert.deepEqual(parseVanessaControlReply('get_test_results', reply(text)), {
        kind: 'failureResult', featurePath: 'C:\\KOT\\failure-skipped.feature', lineNumber: 28
    });
    assert.equal(parseVanessaControlReply('get_test_results', reply(text.replace('## Шаги (14)', '## Шаги (15)'))).kind, 'unknown');
    assert.equal(parseVanessaControlReply('get_test_results', reply(text.replace('**Skipped**', '**Unrecognized**'))).kind, 'unknown');
});

test('diagnostic capabilities negotiate runtime syntax, search, environment and bounded logs independently', () => {
    const captured = tools(); const caps = assessVanessaControlCapabilities(captured);
    for (const name of ['environment', 'runtimeSyntax', 'runtimeSearch', 'managerLog', 'clientLog'] as const) { assert.equal(caps[name]?.supported, true); }
    const log = captured.find((tool: any) => tool.name === 'get_event_log_manager');
    log.inputSchema.required.push('output_file');
    assert.equal(assessVanessaControlCapabilities(captured).managerLog.supported, false);
    assert.equal(assessVanessaControlCapabilities(captured).clientLog.supported, true);
});

test('live state exposes recording independently from test execution', () => {
    const text = '# Состояние Vanessa Automation\n\n- Выполнение сценариев: нет\n- Клиент тестирования подключен: да\n- Включена запись действий пользователя: нет\n\n## Текущая фича\n\n## Текущий сценарий\n\n## Текущий шаг';
    const idle = parseVanessaControlReply('get_vanessa_automation_state', reply(text));
    assert.equal(idle.kind === 'state' && (idle as any).recording, false);
    const recording = parseVanessaControlReply('get_vanessa_automation_state', reply(text.replace('пользователя: нет', 'пользователя: да')));
    assert.equal(recording.kind === 'state' && (recording as any).recording, true);
});

test('a failed scenario can contain Markdown headings without hiding the authoritative idle state', () => {
    const text = fixture('state-unknown-step.live.ru.md').replace('- result: ', '- result: Failure\n## В окне есть сообщения пользователю:\n');
    assert.deepEqual(parseVanessaControlReply('get_vanessa_automation_state', reply(text)), {
        kind: 'state', state: 'idle', recording: false, featurePath: 'C:\\KOT\\unknown.feature', lineNumber: 4, stepStatus: 'failed'
    });
    assert.equal(parseVanessaControlReply('get_vanessa_automation_state', reply(text + '\n## Текущий шаг\n- lineNumber: 5')).kind, 'unknown');
});

test('single-step results include Pending and Failed errors without requiring full-run technical fields', () => {
    assert.deepEqual(parseVanessaControlReply('get_test_results', reply(fixture('result-unknown-step.live.ru.md'))), {
        kind: 'runtimeResult', status: 'failed', message: 'Не найдена процедура или функция для выполнения шага: And I save "test4value" in "test4var" variabl'
    });
    const pending = fixture('state-unknown-step.live.ru.md').replace('- status: Failed', '- status: Pending');
    assert.equal((parseVanessaControlReply('get_vanessa_automation_state', reply(pending)) as any).stepStatus, 'pending');
});

test('variables capabilities gate read and string writes independently using the actual action schema', () => {
    const captured = JSON.parse(fixture('tools.live.json')).tools;
    let capabilities = assessVanessaControlCapabilities(captured);
    assert.equal(capabilities.variablesRead.supported, true);
    assert.equal(capabilities.variablesWrite.supported, true);
    const variable = captured.find((tool: any) => tool.name === 'manage_variables');
    variable.inputSchema.properties.action.enum = ['get'];
    capabilities = assessVanessaControlCapabilities(captured);
    assert.equal(capabilities.variablesRead.supported, true);
    assert.equal(capabilities.variablesWrite.supported, false);
    variable.inputSchema.properties.action.enum = ['get', 'set', 'delete'];
    variable.inputSchema.properties.value.type = 'number';
    assert.equal(assessVanessaControlCapabilities(captured).variablesWrite.supported, false);
});

test('client capabilities distinguish read, write, connection and close schemas; unsupported required port disables writes', () => {
    const captured = JSON.parse(fixture('tools.live.json')).tools;
    const capabilities = assessVanessaControlCapabilities(captured);
    assert.equal(capabilities.clientProfilesRead.supported, true);
    assert.equal(capabilities.clientProfilesWrite.supported, true);
    assert.equal(capabilities.clientConnect.supported, true);
    assert.equal(capabilities.clientDisconnect.supported, true);
    assert.equal(capabilities.clientClose.supported, true);
    captured.find((tool: any) => tool.name === 'manage_test_client_profiles').inputSchema.required.push('port');
    const changed = assessVanessaControlCapabilities(captured);
    assert.equal(changed.clientProfilesWrite.supported, false);
    assert.equal(changed.clientProfilesRead.supported, false);
    assert.equal(changed.clientConnect.supported, true);
});

test('the verified live .45 endpoint exposes the control tools and an idle state', () => {
    const live = assessVanessaControlCapabilities(JSON.parse(fixture('tools.live.json')).tools);
    assert.ok(Object.values(live).every(capability => capability.supported));
    assert.deepEqual(parseVanessaControlReply('get_vanessa_automation_state', reply(fixture('state-idle.live.ru.md'))),
        { kind: 'state', state: 'idle', recording: false });
});

test('control capabilities require compatible tools and reject changed types and unknown required arguments', () => {
    const original = assessVanessaControlCapabilities(tools());
    assert.equal(original.runFromLine.supported, true);
    assert.equal(original.oneStep.supported, true);
    assert.equal(original.breakpoints.supported, true);
    assert.equal(assessVanessaControlCapabilities([]).stop.supported, false);
    const changed = tools();
    changed.find((tool: any) => tool.name === 'execute_feature_step').inputSchema.properties.lineNumber.type = 'string';
    changed.find((tool: any) => tool.name === 'run_scenario').inputSchema.required.push('unknownArgument');
    const result = assessVanessaControlCapabilities(changed);
    assert.equal(result.oneStep.supported, false);
    assert.equal(result.runFromLine.supported, false);
    assert.equal(result.stop.supported, true);
    assert.equal(assessVanessaControlCapabilities([...tools(), tools()[0]]).state.supported, false);
});

test('a mode explicitly excluded by the server cannot be offered as a supported operation', () => {
    const changed = tools();
    changed.find((tool: any) => tool.name === 'run_scenario').inputSchema.properties.mode.enum = ['all'];
    assert.equal(assessVanessaControlCapabilities(changed).runFromLine.supported, false);
});

test('literal restrictions cannot enable a different run mode or destructive-only breakpoint tool', () => {
    const changed = tools();
    changed.find((tool: any) => tool.name === 'run_scenario').inputSchema.properties.mode.const = 'all';
    changed.find((tool: any) => tool.name === 'manage_breakpoints').inputSchema.properties.action.enum = ['remove_all'];
    assert.equal(assessVanessaControlCapabilities(changed).runFromLine.supported, false);
    assert.equal(assessVanessaControlCapabilities(changed).breakpoints.supported, false);
    changed.find((tool: any) => tool.name === 'manage_breakpoints').inputSchema.properties.action.enum = ['list', 'toggle'];
    assert.equal(assessVanessaControlCapabilities(changed).breakpoints.supported, true);
    changed.find((tool: any) => tool.name === 'run_scenario').inputSchema.properties.mode.const = 'reloadAndRunFromLine';
    assert.equal(assessVanessaControlCapabilities(changed).runFromLine.supported, true);
    changed.find((tool: any) => tool.name === 'run_scenario').inputSchema.allOf = [{ not: {} }];
    assert.equal(assessVanessaControlCapabilities(changed).runFromLine.supported, false);
});

test('endpoint defaults to loopback and requires explicit remote selection without credentials in the URL', () => {
    assert.equal(normalizeVanessaControlEndpoint('http://127.0.0.1:9876'), 'http://127.0.0.1:9876/mcp');
    assert.equal(normalizeVanessaControlEndpoint('http://[::1]:9876/mcp'), 'http://[::1]:9876/mcp');
    assert.throws(() => normalizeVanessaControlEndpoint('http://windows-host:9876/mcp'));
    assert.equal(normalizeVanessaControlEndpoint('http://windows-host:9876/mcp', true), 'http://windows-host:9876/mcp');
    for (const value of ['file:///tmp/mcp', 'http://user:secret@localhost:9876/mcp', 'http://localhost:9876/mcp?token=secret', 'http://localhost:9876/mcp#secret']) {
        assert.throws(() => normalizeVanessaControlEndpoint(value, true), error => !String(error).includes('secret'));
    }
});

test('only the verified state format establishes running or idle and never a passed result', () => {
    assert.deepEqual(parseVanessaControlReply('get_vanessa_automation_state', reply(fixture('state-running.ru.md'))), {
        kind: 'state', state: 'running', featurePath: 'C:\\Tests\\sales.feature', lineNumber: 12, stepStatus: 'running'
    });
    const idle = fixture('state-running.ru.md').replace('Выполнение сценариев: да', 'Выполнение сценариев: нет');
    assert.equal((parseVanessaControlReply('get_vanessa_automation_state', reply(idle)) as any).state, 'idle');
    for (const text of ['Test passed', '# Состояние Vanessa Automation\n- Arbitrary field: нет', 'Выполнение сценариев: нет']) {
        assert.equal(parseVanessaControlReply('get_vanessa_automation_state', reply(text)).kind, 'unknown');
    }
    assert.equal(parseVanessaControlReply('run_scenario', reply('# Успешно')).kind, 'unknown');
    assert.equal(parseVanessaControlReply('stop_scenario', reply('Остановка запрошена')).kind, 'unknown');
    assert.equal(parseVanessaControlReply('get_test_results', reply('All tests passed')).kind, 'unknown');
    assert.equal(parseVanessaControlReply('get_vanessa_automation_state', { ...reply(idle), isError: true }).kind, 'toolError');
});

test('truncated, duplicated, or unrelated Markdown cannot establish execution state', () => {
    const valid = fixture('state-running.ru.md');
    for (const text of [
        '# Состояние Vanessa Automation\n\n- Выполнение сценариев: нет',
        '# Состояние Vanessa Automation\n\n## Диагностика\n- Выполнение сценариев: нет',
        valid.replace('- Выполнение сценариев: да', '').replace('## Текущая фича', '## Текущая фича\n- Выполнение сценариев: нет'),
        valid + '\n## Текущий шаг\n- lineNumber: 55'
    ]) {
        assert.equal(parseVanessaControlReply('get_vanessa_automation_state', reply(text)).kind, 'unknown');
    }
});

test('breakpoint lists require matching count and valid one-based lines without swallowing other sections', () => {
    assert.deepEqual(parseVanessaControlReply('manage_breakpoints', reply(fixture('breakpoints.ru.md'))), { kind: 'breakpoints', lines: [4, 12] });
    assert.deepEqual(parseVanessaControlReply('manage_breakpoints', reply('# Точки останова\n\nТочек останова нет.\n\n## Открытые файлы\n- 123')), { kind: 'breakpoints', lines: [] });
    assert.deepEqual(parseVanessaControlReply('manage_breakpoints', reply(fixture('breakpoints-empty.live.ru.md'))), { kind: 'breakpoints', lines: [] });
    for (const hint of ['Загрузите фичи (`load_features`) и откройте сценарий для работы с точками останова.',
        'Редактор не доступен. Загрузите фичи (`load_features`) для инициализации.']) {
        assert.deepEqual(parseVanessaControlReply('manage_breakpoints', reply(`# Точки останова\n\nТочек останова нет.\n\n${hint}\n\n## Как добавить\n- help`)), { kind: 'breakpointsUnavailable' });
    }
    for (const text of ['# Точки останова\nКоличество: 2\n- 4', '# Точки останова\nКоличество: 1\n- 0', '# Точки останова\nКоличество: 2\n- 4\n- 4']) {
        assert.equal(parseVanessaControlReply('manage_breakpoints', reply(text)).kind, 'unknown');
    }
});

test('only verified one-step completion confirms pass, and step status comes from a complete state snapshot', () => {
    assert.deepEqual(parseVanessaControlReply('execute_feature_step', reply('Шаг в строке фича файла успешно выполнен')), { kind: 'stepResult', status: 'passed' });
    assert.equal(parseVanessaControlReply('execute_feature_step', reply('Execution complete')).kind, 'unknown');
    const confirmed = fixture('state-running.ru.md').replace('status: Running', 'status: Success');
    assert.equal((parseVanessaControlReply('get_vanessa_automation_state', reply(confirmed)) as any).stepStatus, 'passed');
    const failed = confirmed.replace('status: Success', 'status: Failed');
    assert.equal((parseVanessaControlReply('get_vanessa_automation_state', reply(failed)) as any).stepStatus, 'failed');
});

test('the exact live editor-loaded response is ready for selection but never a passed execution', () => {
    const loaded = fixture('state-loaded.live.ru.md');
    assert.deepEqual(parseVanessaControlReply('get_vanessa_automation_state', reply(loaded)), {
        kind: 'state', state: 'idle', featurePath: 'C:\\KOT\\acceptance\\safe.feature'
    });
    for (const text of [loaded.split('\n')[0], loaded.replace('ещё ни разу не запускался', 'выполняется'), loaded + '\nextra']) {
        assert.equal(parseVanessaControlReply('get_vanessa_automation_state', reply(text)).kind, 'unknown');
    }
});

test('a run passes only with complete scenario outcomes, never its success heading alone', () => {
    const complete = fixture('run-passed.live.ru.md').trim();
    assert.deepEqual(parseVanessaControlReply('run_scenario', reply(complete)), { kind: 'runResult', status: 'passed', scenarioCount: 1 });
    assert.equal(parseVanessaControlReply('run_scenario', reply(fixture('run-stopped.live.ru.md'))).kind, 'unknown', 'the actual breakpoint response also has a success heading');
    for (const text of [complete.split('\n\n')[0], complete.replace('Success', 'Running'), complete + '\nТекст ошибки: failure',
        complete.replace('Результат прохождения сценария: Success', '')]) {
        assert.equal(parseVanessaControlReply('run_scenario', reply(text)).kind, 'unknown');
    }
});

test('failure history requires complete format and identifies the exact source without exposing the error text', () => {
    assert.deepEqual(parseVanessaControlReply('get_test_results', reply(fixture('results-failed.live.ru.md'))), {
        kind: 'failureResult', featurePath: 'C:\\KOT\\acceptance\\safe.feature', lineNumber: 4
    });
    const failure = '# Результаты тестов\n\n- Статус: Failed\n- Ошибка: secret-business-value\n\nТехнические данные:\n        НомерСтрокиФичи: 4\n        ПолныйПутьКФиче: C:\\KOT\\safe.feature\n\n## Шаги (1)\n1. Тогда я вызываю исключение "secret-business-value" → **Failed** (435 мс)\n   - Ошибка: secret-business-value';
    assert.deepEqual(parseVanessaControlReply('get_test_results', reply(failure)), {
        kind: 'failureResult', featurePath: 'C:\\KOT\\safe.feature', lineNumber: 4
    });
    for (const text of [failure.replace('- Статус: Failed', '- Статус: не указано'), failure.replace('## Шаги (1)', '## Шаги (2)'),
        failure.replace('НомерСтрокиФичи: 4', 'НомерСтрокиФичи: 0'), failure + '\n## Шаги (1)\n1. duplicate → **Failed**']) {
        assert.equal(parseVanessaControlReply('get_test_results', reply(text)).kind, 'unknown');
    }
});

test('editor selection is read from the single active saved tab and its own line section', () => {
    const editor = '# Состояние редактора\n\n## Открытые вкладки\nКоличество: 2\n\n- memory:welcome\n- **→** C:\\KOT\\safe.feature\n\n## Активный документ\n- Строка: 11\n\n### Выбранный сценарий: Safe\n\n## Ошибки в редакторе\nКоличество: 0';
    assert.deepEqual(parseVanessaControlReply('get_editor_state', reply(editor)), { kind: 'editor', featurePath: 'C:\\KOT\\safe.feature', lineNumber: 11, dirty: false });
    assert.deepEqual(parseVanessaControlReply('get_editor_state', reply(editor.replace('safe.feature', 'safe.feature *(изменена)*'))),
        { kind: 'editor', featurePath: 'C:\\KOT\\safe.feature', lineNumber: 11, dirty: true });
    for (const text of [editor.replace('Количество: 2', 'Количество: 3'), editor.replace('- memory:welcome', '- **→** C:\\other.feature'),
        editor.replace('- Строка: 11', '- Строка: 0'), editor + '\n## Активный документ\n- Строка: 2']) {
        assert.equal(parseVanessaControlReply('get_editor_state', reply(text)).kind, 'unknown');
    }
});

test('editor content is exact, optional, and requires an independently compatible includeContent schema', () => {
    const editor = fixture('editor-content.live.ru.md');
    assert.deepEqual(parseVanessaControlReply('get_editor_state', reply(editor)), { kind: 'editor',
        featurePath: 'C:\\KOT\\acceptance\\kot-breakpoints.feature', lineNumber: 5, dirty: false,
        content: '# language: en\nFeature: KOT breakpoints\nScenario: Safe\n    And Delay 1\n    And Delay 1\n    And Delay 1\n' });
    assert.deepEqual(parseVanessaControlReply('get_editor_state', reply(editor.replace(/\n/gu, '\r\n'))), parseVanessaControlReply('get_editor_state', reply(editor)));
    const restricted = tools(); restricted.find((tool: any) => tool.name === 'get_editor_state').inputSchema.properties.includeContent.enum = [false];
    const capabilities = assessVanessaControlCapabilities(restricted);
    assert.equal(capabilities.editor.supported, true); assert.equal(capabilities.editorContent.supported, false);
    assert.equal(parseVanessaControlReply('get_editor_state', reply(editor.replace('```gherkin', '```unknown'))).kind, 'unknown');
});

 test('form capabilities require exact noncompact tree, hidden-state, window and element contracts', () => {
    const captured = JSON.parse(fixture('tools.live.json')).tools;
    let caps = assessVanessaControlCapabilities(captured) as any;
    assert.equal(caps.formTree.supported, true); assert.equal(caps.formWindow.supported, true); assert.equal(caps.formElement.supported, true);
    captured.find((tool: any) => tool.name === 'get_form_analysis').inputSchema.properties.compact.const = true;
    captured.find((tool: any) => tool.name === 'get_active_window_data').inputSchema.properties.type.enum = ['navigation_link'];
    caps = assessVanessaControlCapabilities(captured);
    assert.equal(caps.formTree.supported, false); assert.equal(caps.formWindow.supported, false); assert.equal(caps.formElement.supported, true);
});

test('recording and form generation require their own confirmed argument schemas', () => {
    const captured = JSON.parse(fixture('tools.live.json')).tools;
    const flags = assessVanessaControlCapabilities(captured) as any;
    assert.equal(flags.recording?.supported, true); assert.equal(flags.formChecks?.supported, true); assert.equal(flags.formSuggestions?.supported, true);
    const recording = captured.find((tool: any) => tool.name === 'user_actions_recording'); recording.inputSchema.properties.action.enum = ['start'];
    assert.equal((assessVanessaControlCapabilities(captured) as any).recording.supported, false);
});
