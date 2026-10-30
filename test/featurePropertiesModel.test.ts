import assert from 'node:assert/strict';
import test from 'node:test';
import { readFeatureProperties, planFeaturePropertiesEdit } from '../src/featurePropertiesModel';
const source = (text: string, version = 4) => ({ uri: 'file:///tests/demo.feature', text, version });
const apply = (value: ReturnType<typeof source>, field: 'title' | 'description' | 'tags', text: string) => {
    const edit = planFeaturePropertiesEdit(value, { uri: value.uri, version: value.version, field, value: text });
    return value.text.slice(0, edit.start) + edit.text + value.text.slice(edit.end);
};
test('feature properties read RU/EN structure without docstring headers', () => {
    const parsed = readFeatureProperties(source('\uFEFF#language: en\r\n@tree @Smoke\r\nFeature: Order\r\n  As a buyer\r\n# keep\r\n\r\n@Fast\r\nScenario: Ready\r\n    Given ready\r\n    """\r\n    Scenario: fake\r\n    """\r\n'));
    assert.equal(parsed.title, 'Order'); assert.equal(parsed.description, '  As a buyer');
    assert.deepEqual(parsed.tags, ['@tree', '@Smoke']); assert.equal(parsed.scenarios.length, 1);
    assert.equal(parsed.scenarios[0].title, 'Ready'); assert.ok(parsed.actions.some(action => action.kind === 'variables'));
    assert.equal(readFeatureProperties(source('Функционал: Заказ\nСценарий: Готово\n')).language, 'ru');
});
test('native field edits preserve BOM, CRLF, comments and scenario tags', () => {
    const original = source('\uFEFFFeature: Old\r\n  Description\r\n# keep\r\n\r\n@Fast\r\nScenario: Ready\r\n');
    assert.match(apply(original, 'title', 'New'), /^\uFEFFFeature: New\r\n/u);
    const result = apply(original, 'description', '  Updated\n  Next');
    assert.match(result, /Updated\r\n  Next\r\n# keep\r\n/u); assert.match(result, /@Fast\r\nScenario/u);
    const tagged = apply(original, 'tags', '@Smoke @Fast'); assert.match(tagged, /^\uFEFF@Smoke @Fast\r\nFeature: Old/u);
    const existing = source('@Old\n# keep\nFeature: Old\nScenario: One\n');
    assert.equal(apply(existing, 'tags', '@New'), '@New\n# keep\nFeature: Old\nScenario: One\n');
});
test('rejects stale targets and invalid structure or field injection', () => {
    const value = source('Feature: Old\nScenario: One\n');
    assert.throws(() => planFeaturePropertiesEdit(value, { uri: value.uri, version: 3, field: 'title', value: 'New' }), /changed/iu);
    assert.throws(() => apply(value, 'title', 'New\nScenario: fake'), /single line/iu);
    assert.throws(() => apply(value, 'description', 'Scenario: injected'), /section/iu);
    assert.throws(() => apply(value, 'tags', '@New\nScenario: bad'), /tag/iu);
    assert.throws(() => readFeatureProperties(source('nothing')), /feature/iu);
});

test('feature aliases open in English and descriptions cannot introduce supported section aliases', () => {
    for (const title of ['Ability', 'Business Need', 'Functionality']) { assert.equal(readFeatureProperties(source(`${title}: Test\nScenario: Ready\n`)).language, 'en'); }
    const value = source('Функционал: Тест\nСценарий: Готово\n');
    for (const description of ['Шаблон сценария: Новая проверка', 'Предыстория:\nДано условие', 'Scenarios:', 'Гиперссылки:']) {
        assert.throws(() => apply(value, 'description', description), /section/iu, description);
    }
});
