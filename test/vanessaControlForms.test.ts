import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parseVanessaFormTree, parseVanessaFormElement, VanessaRuntimeForms } from '../src/vanessaControlForms';

const reply = (text: string) => ({ content: [{ type: 'text', text }] });
// First-party names through the exact noncompact .45 formatter, not a live business snapshot.
const tree = '# Анализ текущей формы\n\n## Элементы формы\n```text\n' + [
    '- Own window [] {Тестируемое окно клиентского приложения} {Видимость:Да}',
    '-- Own form [] {Тестируемая форма} {Видимость:Да}',
    '--- Main [Main] {ТестируемаяГруппаФормы} {Видимость:Да}',
    '---- Description [Description] {ТестируемоеПолеФормы} {Видимость:Да}',
    '---- Hidden [Hidden] {ТестируемоеПолеФормы} {Видимость:Нет}',
    '--- Lines [Lines] {ТестируемаяТаблицаФормы} {Видимость:Да}',
    '---- Quantity [Quantity] {ТестируемоеПолеФормы} {Видимость:Да}',
    '--- Save [Save] {ТестируемаяКнопкаФормы} {Видимость:Да}'
].join('\n') + '\n```\n';
const details = '# Данные элемента формы\n\n## Основная информация\n- Имя: Description\n- Заголовок: Description\n- Вид: Поле ввода\n- Тип: Строка\n\n## Значение элемента формы\n- Значение: own value\n- Представление: own value\n\n## Состояние\n- Доступность: Да\n- Видимость: Да\n- ТолькоПросмотр: Нет';
const binding = { client: 'own-client-fingerprint', windowTitle: 'Own window', formName: 'ОбщаяФорма.Own.Form' };

test('noncompact tree preserves hierarchy, hidden fields and table columns without inventing values or states', () => {
    const form = parseVanessaFormTree(reply(tree), binding, '2026-10-19T00:00:00Z');
    assert.equal(form.form.name, binding.formName);
    assert.equal(form.elements[0].children[1].visible, false);
    assert.equal(form.elements[0].children[0].path, 'Form.Main.Description');
    assert.equal(form.elements[1].kind, 'table');
    assert.equal(form.elements[1].children[0].name, 'Quantity');
    assert.equal(form.elements[2].kind, 'button');
    assert.equal(form.elements[0].children[0].available, undefined);
    assert.equal(form.elements[0].children[0].valuePreview, undefined);
    assert.deepEqual(form.tables, [], 'UI rows are not database table data');
});

test('ambiguous, truncated, oversized or error replies are rejected without returning a partial tree', () => {
    for (const text of [tree.replace('---- Hidden', '------ Hidden'), tree.replace('[Hidden]', '[Description]'),
        tree.replace('{Видимость:Нет}', '{Видимость:?}'), tree.replace('```\n', '...truncated\n```\n'), tree + 'x'.repeat(1_000_001)]) {
        assert.throws(() => parseVanessaFormTree(reply(text), binding, ''), /form.*confirmed/iu);
    }
    assert.throws(() => parseVanessaFormTree({ ...reply(tree), isError: true }, binding, ''));
});

test('element details retain representations, explicit booleans and identity, rejecting duplicate fields', () => {
    const parsed = parseVanessaFormElement(reply(details), 'Description');
    assert.equal(parsed.valuePreview, 'own value'); assert.equal(parsed.readOnly, false); assert.equal(parsed.available, true);
    assert.throws(() => parseVanessaFormElement(reply(details), 'Other'));
    assert.throws(() => parseVanessaFormElement(reply(details + '\n- Доступность: Нет'), 'Description'));
});

test('table and multiline field values returned by Vanessa retain all lines and do not break details', () => {
    const value = '| Item | Qty |\n| Own | 1 |\n| Other | 2 |';
    const table = details.replace('- Значение: own value\n- Представление: own value', `- Значение: ${value}`)
        + '\n- Таблица в режиме редактирования: Нет';
    assert.equal(parseVanessaFormElement(reply(table), 'Description').valuePreview, value);
    assert.equal(parseVanessaFormElement(reply(details.replace('own value\n- Представление: own value', 'own value\nextra\n- Представление: line one\nline two')), 'Description').valuePreview, 'line one\nline two');
    assert.throws(() => parseVanessaFormElement(reply(table.replace('## Состояние', '## Unexpected')), 'Description'));
});

test('form reads are bound to client, window and session before publication and details', async () => {
    let current = true; let stamp = binding; const calls: unknown[] = [];
    const forms = new VanessaRuntimeForms({ isCurrent: () => current, identity: async () => stamp,
        request: async (name, args) => { calls.push({ name, args }); return reply(name === 'get_form_analysis' ? tree : details); } });
    const snapshot = await forms.read();
    assert.deepEqual(calls[0], { name: 'get_form_analysis', args: { format: 'elements', compact: false, only_visible: false } });
    const changed = await forms.element(snapshot, 'Form.Main.Description');
    assert.equal(changed.elements[0].children[0].valuePreview, 'own value');
    stamp = { ...binding, client: 'other' };
    await assert.rejects(forms.element(snapshot, 'Form.Main.Description'), /changed/iu);
    assert.equal(calls.length, 2, 'no detail read against a different client');
    current = false; await assert.rejects(forms.read(), /changed/iu);
});

test('a client/window change during a request discards its response', async () => {
    let stamp = binding;
    const forms = new VanessaRuntimeForms({ identity: async () => stamp, request: async () => { stamp = { ...binding, windowTitle: 'Other' }; return reply(tree); } });
    await assert.rejects(forms.read(), /changed/iu);
});

test('noncompact captions can contain literal brackets and braces; field identity comes from the trailing formatter fields', () => {
    const form = parseVanessaFormTree(reply(tree.replace('---- Description [Description]', '---- Evaluate {} and [own] [Description]')), binding, 'now');
    assert.equal(form.elements[0].children[0].title, 'Evaluate {} and [own]');
    assert.equal(form.elements[0].children[0].name, 'Description');
});

test('actual .45 form state uses lowercase Russian booleans beside an English value representation', () => {
    const result = parseVanessaFormElement(reply(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/form-element.live.ru.md', 'utf8')), 'ГенерироватьУФ');
    assert.equal(result.available, true); assert.equal(result.visible, true); assert.equal(result.readOnly, false);
    assert.equal(result.valuePreview, 'Yes');
});

test('background refresh checks form identity without rescanning its tree, while a different window reads a fresh tree', async () => {
    let identity = binding; let requests = 0;
    const forms = new VanessaRuntimeForms({ identity: async () => identity, request: async () => { requests++; return reply(tree); } });
    const first = await forms.read(); assert.equal(requests, 1);
    const refresh = () => (forms as VanessaRuntimeForms & { refresh(snapshot: typeof first): Promise<typeof first> }).refresh(first);
    assert.equal(await refresh(), first); assert.equal(requests, 1, 'a 1C form analysis can block the test client for seconds');
    identity = { ...binding, windowTitle: 'Another own form' };
    const second = await refresh(); assert.notEqual(second, first); assert.equal(second.form.windowTitle, identity.windowTitle); assert.equal(requests, 2);
});
test('window selection uses internal client windows, rejects duplicate or wildcard titles, and confirms the selected window', async () => {
    let identity = binding; const mutations: string[] = [];
    const forms = new VanessaRuntimeForms({ identity: async () => identity, request: async (tool, args) => {
        if (tool === 'get_window_list_testclient') { return reply('В клиенте тестирования найдено 2 окон:\n   -Own window\n   -Other window\n\n## Окна клиента тестирования с точки зрения ОС (для снятия скриншотов) найдено 1:\n   -OS caption'); }
        if (tool === 'window_management') { assert.equal(args.action, 'activate'); mutations.push(String(args.window_title)); identity = { ...binding, windowTitle: String(args.window_title) }; return reply('activated'); }
        return reply(tree);
    } });
    const windows = await forms.windows(); assert.deepEqual(windows.titles, ['Own window', 'Other window']);
    assert.equal((await forms.activateWindow(windows, 'Other window')).form.windowTitle, 'Other window');
    await assert.rejects(forms.activateWindow(windows, '*window')); assert.deepEqual(mutations, ['Other window']);
    identity = { ...identity, client: 'other' }; await assert.rejects(forms.activateWindow(windows, 'Own window')); assert.deepEqual(mutations, ['Other window']);
});
test('a window change between activation confirmation and the full form read cannot publish another window', async () => {
    let activated = false; let reads = 0;
    const forms = new VanessaRuntimeForms({ identity: async () => ({ ...binding, windowTitle: activated && ++reads > 1 ? 'Unexpected window' : 'Other window' }),
        request: async tool => {
            if (tool === 'get_window_list_testclient') { return reply('В клиенте тестирования найдено 1 окон:\n   -Other window'); }
            if (tool === 'window_management') { activated = true; return reply('activated'); }
            return reply(tree);
        } });
    const windows = await forms.windows(); await assert.rejects(forms.activateWindow(windows, 'Other window'), /changed/iu);
});
