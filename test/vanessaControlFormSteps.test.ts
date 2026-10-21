import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaRuntimeForms, type VanessaFormPorts } from '../src/vanessaControlForms';
import * as api from '../src/vanessaControlFormSteps';
import type { FormExplorerSnapshot } from '../src/formExplorerTypes';
const reply = (text: string) => ({ content: [{ type: 'text', text }] });
const identity = { client: 'own', windowTitle: 'Own form', formName: 'Catalog.Own.Form' };
const field = { path: 'Form.Name', name: 'Name', kind: 'field', type: 'ТестируемоеПолеФормы', visible: true, children: [] };
function setup() {
    let value = 'First'; let other = 'One'; let current = true; let ownIdentity = identity;
    const calls: { tool: string; args: Readonly<Record<string, unknown>> }[] = [];
    const ports: VanessaFormPorts = { identity: async () => ownIdentity, isCurrent: () => current,
        request: async (tool, args) => {
            calls.push({ tool, args });
            if (tool === 'manage_form_elements') { return reply('Элемент шапки успешно активизирован.'); }
            if (tool === 'get_form_element_data') { return reply(`# Данные элемента формы\n\n## Основная информация\n- Имя: ${args.element_name}\n- Заголовок: Name\n\n## Значение элемента формы\n- Значение: ${value}\n\n## Состояние\n- Видимость: Да\n- Доступность: Да`); }
            const checks = `## Gherkin-состояние формы\n\`\`\`gherkin\nThen Name is "${value}"\nAnd Other is "${other}"\n\`\`\``;
            return reply('# Анализ текущей формы\n\n' + checks + (args.format === 'full' ? `\n\n## Часто используемые шаги для текущего элемента\n\`\`\`gherkin\nAnd input "${value}" in Name\n\`\`\`` : ''));
        } };
    const snapshot = { schemaVersion: 1, generatedAt: 'initial', source: { adapter: 'MCP', sessionId: JSON.stringify(Object.values(identity)) },
        form: { name: identity.formName, title: identity.windowTitle }, elements: [field], tables: [], attributes: [], commands: [], notes: [] } as FormExplorerSnapshot;
    return { forms: new VanessaRuntimeForms(ports), ports, snapshot, cache: new api.VanessaFormStepCache(), calls,
        value: (next: string) => { value = next; }, other: (next: string) => { other = next; },
        stale: () => { current = false; }, identity: (next: typeof identity) => { ownIdentity = next; } };
}
test('native suggestions focus the unique field and reuse only after a fresh equal form-state check', async () => {
    const h = setup();
    const first = await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
    assert.equal(first.text, 'And input "First" in Name'); assert.equal(first.cached, false);
    assert.equal(first.snapshot.form.activeElementPath, field.path);
    assert.deepEqual(h.calls[0], { tool: 'manage_form_elements', args: { action: 'activate_header_element', element_name: 'Name' } });
    const next = await h.forms.steps(first.snapshot, field.path, h.cache, 'en');
    assert.equal(next.cached, true); assert.equal(next.text, first.text);
    assert.equal(h.calls.filter(call => call.tool === 'get_form_analysis' && call.args.format === 'full').length, 1);
    assert.equal(h.calls.filter(call => call.tool === 'get_form_analysis' && call.args.format === 'gherkin').length, 1);
});

test('A→B→A activates the selected control but does not repeat full analysis for unchanged A', async () => {
    const h = setup(); const secondField = { ...field, name: 'Code', path: 'Form.Code' };
    h.snapshot.elements.push(secondField);
    const first = await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
    const second = await h.forms.steps(first.snapshot, secondField.path, h.cache, 'en');
    const returned = await h.forms.steps(second.snapshot, field.path, h.cache, 'en');
    assert.equal(returned.cached, true); assert.equal(returned.text, first.text);
    assert.equal(h.calls.filter(call => call.tool === 'get_form_analysis' && call.args.format === 'full').length, 2);
    assert.equal(h.calls.filter(call => call.tool === 'manage_form_elements').length, 3, 'focus still follows the selected element');
});

test('cached preview is only available for matching form, language and known selected-element data', async () => {
    const h = setup(); const result = await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
    assert.equal(h.cache.preview(result.snapshot, field.path, 'en'), result.text);
    assert.equal(h.cache.preview(result.snapshot, field.path, 'ru'), undefined);
    const changed = { ...result.snapshot, elements: result.snapshot.elements.map(row => ({ ...row, valuePreview: 'Changed' })) };
    assert.equal(h.cache.preview(changed, field.path, 'en'), undefined);
    assert.equal(h.cache.preview({ ...result.snapshot, source: { ...result.snapshot.source, sessionId: 'other' } }, field.path, 'en'), undefined);
    h.cache.clear(); assert.equal(h.cache.preview(result.snapshot, field.path, 'en'), undefined);
});
test('native suggestions accept the messages footer emitted after the closing fence by Vanessa .45', async () => {
    for (const footer of ['В окне <Own form> нет сообщений пользователю.', 'Обнаружены сообщения пользователю:\nOwn information message']) {
        const h = setup(); const request = h.ports.request;
        h.ports.request = async (tool, args) => {
            const result = await request(tool, args);
            return tool === 'get_form_analysis' && args.format === 'full'
                ? reply(result.content[0].text + '\n' + footer) : result;
        };
        const first = await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
        assert.equal(first.text, 'And input "First" in Name');
        assert.equal(first.text.includes(footer), false);
        assert.equal((await h.forms.steps(first.snapshot, field.path, h.cache, 'en')).cached, true);
    }
});

test('a native block must have its own complete fence and a unique heading', () => {
    const heading = '## Часто используемые шаги для текущего элемента';
    for (const text of [heading + '\nAnd no fence', heading + '\n```gherkin\nAnd unfinished',
        heading + '\n```gherkin\nAnd no closing newline```',
        heading + '\n```gherkin\nAnd first\n```\n' + heading + '\n```gherkin\nAnd second\n```']) {
        assert.equal(api.formStepSection(text, heading), undefined);
    }
});
test('a changed selected value or another reported form value invalidates native suggestions', async () => {
    const h = setup(); await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
    h.value('Second'); const updated = await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
    assert.equal(updated.cached, false); assert.equal(updated.text, 'And input "Second" in Name');
    h.other('Two'); assert.equal((await h.forms.steps(h.snapshot, field.path, h.cache, 'en')).cached, false);
    assert.equal(h.calls.filter(call => call.tool === 'get_form_analysis' && call.args.format === 'full').length, 3);
});
test('selection invalidation during full analysis prevents caching or further form calls', async () => {
    const h = setup(); const request = h.ports.request;
    h.ports.request = async (tool, args) => { const result = await request(tool, args); if (tool === 'get_form_analysis') { h.stale(); } return result; };
    await assert.rejects(h.forms.steps(h.snapshot, field.path, h.cache, 'en'));
    assert.equal(h.calls.at(-1)?.tool, 'get_form_analysis'); assert.equal(h.cache.size, 0);
});
test('hidden, ambiguous and non-focusable group nodes never cause an activation or analysis', async () => {
    for (const mode of ['hidden', 'duplicate', 'group']) {
        const h = setup(); h.snapshot.elements = mode === 'duplicate' ? [field, { ...field, path: 'Form.Other.Name' }]
            : [{ ...field, ...(mode === 'hidden' ? { visible: false } : { kind: 'group' }) }];
        await assert.rejects(h.forms.steps(h.snapshot, field.path, h.cache, 'en')); assert.equal(h.calls.length, 0);
    }
});
test('table columns use activate_column with the technical table and column names', async () => {
    const h = setup(); const path = 'Form.Items.Item';
    h.snapshot.elements = [{ path: 'Form.Items', name: 'Items', kind: 'table', children: [{ ...field, path, name: 'Item' }] }];
    await h.forms.steps(h.snapshot, path, h.cache, 'en');
    assert.deepEqual(h.calls[0], { tool: 'manage_form_elements', args: { action: 'activate_column', table_name: 'Items', value: 'Item' } });
});

test('language, form structure and session identity separate cached suggestions', async () => {
    const h = setup(); await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
    assert.equal((await h.forms.steps(h.snapshot, field.path, h.cache, 'ru')).cached, false);
    h.snapshot.elements.push({ ...field, name: 'Extra', path: 'Form.Extra' });
    assert.equal((await h.forms.steps(h.snapshot, field.path, h.cache, 'ru')).cached, false);
    h.identity({ ...identity, client: 'another' });
    await assert.rejects(h.forms.steps(h.snapshot, field.path, h.cache, 'ru'), /changed/u);
    h.snapshot.source!.sessionId = JSON.stringify(['another', identity.windowTitle, identity.formName]);
    assert.equal((await h.forms.steps(h.snapshot, field.path, h.cache, 'ru')).cached, false);
});
test('missing or ambiguous form state never qualifies for cache reuse', async () => {
    for (const state of ['', '## Gherkin-состояние формы\n```gherkin\n```', '## Gherkin-состояние формы\n```gherkin\nA\n```\n## Gherkin-состояние формы\n```gherkin\nB\n```']) {
        const h = setup(); const request = h.ports.request;
        h.ports.request = (tool, args) => tool === 'get_form_analysis'
            ? Promise.resolve(reply('# Анализ текущей формы\n\n' + state + '\n\n## Часто используемые шаги для текущего элемента\n```gherkin\nAnd current\n```')) : request(tool, args);
        await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
        const next = await h.forms.steps(h.snapshot, field.path, h.cache, 'en');
        assert.equal(next.cached, false); assert.equal(h.cache.size, 0);
    }
});
test('an activation error cannot be replaced with a click or publish previous native steps', async () => {
    const h = setup(); const request = h.ports.request;
    h.ports.request = (tool, args) => tool === 'manage_form_elements' ? Promise.resolve({ isError: true, content: [{ type: 'text', text: 'Cannot focus' }] }) : request(tool, args);
    await assert.rejects(h.forms.steps(h.snapshot, field.path, h.cache, 'en'));
    assert.equal(h.calls.length, 0); assert.equal(h.cache.size, 0);
});
test('native-step cache is bounded, cleared on context change and does not persist oversized output', () => {
    const cache = new api.VanessaFormStepCache(); cache.enter('first');
    for (let i = 0; i < 80; i++) { cache.set(String(i), { text: 'And ' + i, state: 'state', element: 'field' }); }
    assert.equal(cache.size, 64); assert.equal(cache.get('0'), undefined);
    cache.set('large', { text: 'a'.repeat(200_001), state: 'state', element: 'field' }); assert.equal(cache.get('large'), undefined);
    cache.enter('other'); assert.equal(cache.size, 0);
});
