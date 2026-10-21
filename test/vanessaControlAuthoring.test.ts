import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaRuntimeAuthoring, renderVanessaInsertion, type VanessaAuthoringPorts } from '../src/vanessaControlAuthoring';
const reply = (text: string) => ({ content: [{ type: 'text', text }] });
function setup() {
    let recording = false; let client = 'own'; let current = true; let form = 'own-form'; const calls: string[] = [];
    const ports: VanessaAuthoringPorts = { generation: 1, isCurrent: () => current, client: async () => client, formIdentity: async () => form,
        request: async (name, args) => {
            calls.push(name);
            if (name === 'get_vanessa_automation_state') { return reply(`- Включена запись действий пользователя: ${recording ? 'Да' : 'Нет'}`); }
            if (name === 'user_actions_recording') { recording = args.action === 'start'; return reply(recording ? '# Запись действий начата\n\n- Статус: запись включена' : '# Запись действий остановлена\n\n- Статус: запись выключена\n\n## Записанные шаги (Turbo Gherkin)\n```gherkin\nAnd own step\n```'); }
            return reply('# Анализ текущей формы\n\n## Gherkin-состояние формы\n```gherkin\nThen own form\n```\n\n## Элементы формы\nНет данных.\n\n## Часто используемые шаги для текущего элемента\n```gherkin\nAnd own field\n```');
        } };
    return { ports, runtime: new VanessaRuntimeAuthoring(ports), calls, record: (v: boolean) => { recording = v; }, client: (v: string) => { client = v; }, current: (v: boolean) => { current = v; }, form: (v: string) => { form = v; } };
}
test('recording confirms start/stop state and returns only the generated Turbo Gherkin', async () => {
    const own = setup(); const token = await own.runtime.start(); assert.equal(await own.runtime.stop(token), 'And own step');
    assert.equal(own.calls.filter(name => name === 'user_actions_recording').length, 2);
});
test('an external stop preserves its remote generated text without a destructive second Stop in Vanessa .45', async () => {
    const own = setup(); const token = await own.runtime.start(); own.record(false);
    const before = own.calls.filter(name => name === 'user_actions_recording').length;
    assert.equal(await own.runtime.stop(token), null);
    assert.equal(own.calls.filter(name => name === 'user_actions_recording').length, before, 'do not stop the recorder a second time');
    assert.ok(await own.runtime.start(), 'the next capture is available immediately');
});
test('recorded steps preserve the common first-line indent until insertion removes it from every line', async () => {
    const own = setup(); const invoke = own.ports.request;
    own.ports.request = async (name, args) => { const result = await invoke(name, args); return name === 'user_actions_recording' && args.action === 'stop'
        ? reply('# Запись действий остановлена\n\n- Статус: запись выключена\n\n## Записанные шаги (Turbo Gherkin)\n```gherkin\n    И первый шаг\n    И второй шаг\n      | A | B |\n```') : result; };
    const text = await own.runtime.stop(await own.runtime.start());
    assert.equal(renderVanessaInsertion(text!, '  ', 'en'), '  И первый шаг\n  И второй шаг\n    | A | B |\n');
});
test('an existing recording, different client or stale session cannot be started or stopped on behalf of another capture', async () => {
    const own = setup(); own.record(true); await assert.rejects(own.runtime.start()); assert.ok(!own.calls.includes('user_actions_recording'));
    own.record(false); const token = await own.runtime.start(); const count = own.calls.length;
    own.client('other'); await assert.rejects(own.runtime.stop(token)); assert.equal(own.calls.length, count);
    own.current(false); await assert.rejects(own.runtime.stop(token));
});
test('Vanessa form checks and current client element suggestions remain distinct and reject a changed window', async () => {
    const own = setup(); assert.equal(await own.runtime.formSteps('checks'), 'Then own form'); assert.equal(await own.runtime.formSteps('suggestions'), 'And own field');
    const invoke = own.ports.request; own.ports.request = async (...args) => { const result = await invoke(...args); own.form('changed'); return result; };
    await assert.rejects(own.runtime.formSteps('checks'));
});
test('unknown and error responses never become generated steps or a successful recording', async () => {
    const own = setup(); own.ports.request = async () => ({ ...reply('private error'), isError: true });
    await assert.rejects(own.runtime.start(), error => !String(error).includes('private'));
});
test('a new .45 feature starts recording through an idempotent stop, preserving previous text without running a step', async () => {
    const own = setup(); const invoke = own.ports.request; const actions: string[] = [];
    own.ports.request = async (name, args) => {
        if (name === 'get_vanessa_automation_state') { return reply('В редактор был загружен фича файл, но ещё ни разу не запускался. Для получения подробной информации о загруженном файле нужно вызвать get_editor_state.\nИмя загруженного feature файла: own.feature'); }
        actions.push(String(args.action)); return invoke(name, args);
    };
    const token = await own.runtime.start();
    assert.deepEqual(actions, ['stop', 'start']);
    assert.equal(token.previousSteps, 'And own step');
    assert.equal(await own.runtime.stop(token), 'And own step');
    assert.deepEqual(actions, ['stop', 'start', 'stop']);
});
test('an unreadable recording response never resets a recorder and a failed reset never starts one', async () => {
    for (const badState of [true, false]) {
        const own = setup(); const actions: string[] = [];
        own.ports.request = async (name, args) => {
            if (name === 'get_vanessa_automation_state') { return reply(badState ? 'unknown format' : 'В редактор был загружен фича файл, но ещё ни разу не запускался.\nИмя загруженного feature файла: own.feature'); }
            actions.push(String(args.action)); return { ...reply('failure with private value'), isError: true };
        };
        await assert.rejects(own.runtime.start());
        assert.deepEqual(actions, badState ? [] : ['stop']);
    }
});
test('generated text survives a state-read failure after a confirmed stop, during reset or an active capture', async () => {
    for (const reset of [true, false]) {
        const own = setup(); const invoke = own.ports.request; let stopped = false; let token;
        if (!reset) { token = await own.runtime.start(); }
        own.ports.request = async (name, args) => {
            if (name === 'get_vanessa_automation_state') {
                if (stopped) { throw new Error('state unavailable'); }
                if (reset) { return reply('В редактор был загружен фича файл, но ещё ни разу не запускался.'); }
            }
            const result = await invoke(name, args);
            if (name === 'user_actions_recording' && args.action === 'stop') { stopped = true; }
            return result;
        };
        await assert.rejects(reset ? own.runtime.start() : own.runtime.stop(token!), (error: any) =>
            error.uncertain && error.token?.previousSteps === 'And own step');
    }
});
test('native current-element suggestions allow the separate messages footer returned by Vanessa .45', async () => {
    const own = setup();
    own.ports.request = async () => reply('# Анализ текущей формы\n\n## Часто используемые шаги для текущего элемента\n```gherkin\nИ я нажимаю на кнопку \'Own\'\n\n```\nВ окне <Own> нет сообщений пользователю.');
    assert.equal(await own.runtime.formSteps('suggestions'), 'И я нажимаю на кнопку \'Own\'');
});
test('recorded payload keeps its language, relative indentation, table values and docstrings while adapting line endings', () => {
    assert.equal(renderVanessaInsertion('And step\n  | A | B |\nAnd text\n  """\n  And literal\n  """', '    ', 'ru', '\r\n'),
        '    And step\r\n      | A | B |\r\n    And text\r\n      """\r\n      And literal\r\n      """\r\n');
});
test('backtick docstrings and a different delimiter inside a docstring remain literal during insertion', () => {
    for (const text of ['And text\n  ```\n  And literal\n  ```', 'And text\n  """\n  \'\'\'\n  And literal\n  """']) {
        const result = renderVanessaInsertion(text, '', 'ru');
        assert.match(result, /^And text\n/u); assert.ok(result.includes('  And literal\n'));
    }
});

test('insertion rejects changed document identity/version/content and preserves the authored source otherwise', async () => {
    const api = await import('../src/vanessaControlAuthoring');
    const prepare = (api as any).prepareVanessaDraftInsertion;
    assert.equal(typeof prepare, 'function');
    const source = { uri: 'file:///own.yaml', version: 1, text: 'ТекстСценария: |\n    \n', offset: 16, length: 4, indentation: '    ', language: 'en', eol: '\n' };
    const edit = prepare(source, source, 'And step'); assert.equal(edit.text, '    And step\n');
    for (const changed of [{ ...source, uri: 'file:///other.yaml' }, { ...source, version: 2 }, { ...source, text: source.text + '# changed' }]) { assert.throws(() => prepare(source, changed, 'And step')); }
});
