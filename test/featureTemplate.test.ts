import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFeatureTemplate, validateFeatureTitle } from '../src/featureTemplate';

test('creates the supplied English feature structure with independent feature and scenario titles', () => {
    const text = renderFeatureTemplate({ language: 'en', featureTitle: 'Order validation', scenarioTitle: 'Create order' });
    assert.match(text, /^\uFEFF?#language: en\n\n@tree\n\nFunctionality: Order validation/u);
    assert.match(text, /As <Role>\nI want <functional description>\nTo <business effect>/u);
    assert.match(text, /Background:\n\tGiven I launch TestClient opening script or connect the existing one/u);
    assert.match(text, /Scenario: Create order\n$/u);
});

test('creates the supplied Russian feature structure and optional documented draft tag', () => {
    const text = renderFeatureTemplate({ language: 'ru', featureTitle: 'Проверка заказа', scenarioTitle: 'Создать заказ', tags: ['Draft'] });
    assert.match(text, /^\uFEFF?#language: ru\n\n@tree\n@Draft\n\nФункционал: Проверка заказа/u);
    assert.match(text, /Как <Роль> я хочу\n<описание функционала>/u);
    assert.match(text, /Контекст:\n\tДано Я запускаю сценарий открытия TestClient или подключаю уже существующий/u);
    assert.match(text, /Сценарий: Создать заказ\n$/u);
});

test('renders custom placeholders without interpreting title replacement characters and preserves BOM/CRLF', () => {
    const template = '\uFEFF# language: {{language}}\r\n@tree\r\nFeature: {{featureTitle}}\r\n\r\nScenario: {{scenarioTitle}}\r\n\tGiven ready\r\n';
    const text = renderFeatureTemplate({ language: 'en', featureTitle: '$& {Order}', scenarioTitle: '$` validation', template });
    assert.equal(text, '\uFEFF# language: en\r\n@tree\r\nFeature: $& {Order}\r\n\r\nScenario: $` validation\r\n\tGiven ready\r\n');
});

test('accepts the original Vanessa title placeholders in custom templates', () => {
    const text = renderFeatureTemplate({ language: 'ru', featureTitle: 'Фича', scenarioTitle: 'Сценарий', template: '#language: ru\nФункционал: <описание фичи>\nСценарий: <описание сценария>\n' });
    assert.equal(text, '#language: ru\nФункционал: Фича\nСценарий: Сценарий\n');
});

test('keeps placeholder-looking text supplied in titles literal', () => {
    const text = renderFeatureTemplate({ language: 'en', featureTitle: '{{scenarioTitle}}', scenarioTitle: 'Ready' });
    assert.match(text, /Functionality: \{\{scenarioTitle\}\}/u);
    assert.match(text, /Scenario: Ready/u);
});

for (const [language, featureKeyword, scenarioKeyword, examplesKeyword] of [
    ['en', 'Feature', 'Scenario Outline', 'Examples'],
    ['en', 'Business Need', 'Scenario Template', 'Scenarios'],
    ['ru', 'Функционал', 'Структура сценария', 'Примеры'],
    ['ru', 'Функция', 'Шаблон сценария', 'Примеры']
] as const) {
    test(`accepts a custom ${language} ${scenarioKeyword} template and retains its examples`, () => {
        const template = `#language: {{language}}\n${featureKeyword}: {{featureTitle}}\n\n@Smoke\n${scenarioKeyword}: {{scenarioTitle}}\n    ${language === 'ru' ? 'Дано' : 'Given'} value <value>\n\n${examplesKeyword}:\n    | value |\n    | first |\n`;
        const text = renderFeatureTemplate({ language, featureTitle: 'Feature title', scenarioTitle: 'Scenario title', template });
        assert.equal(text, template
            .replace('{{language}}', language)
            .replace('{{featureTitle}}', 'Feature title')
            .replace('{{scenarioTitle}}', 'Scenario title'));
    });
}

test('adds a feature tag even when the same tag appears on a scenario and keeps a leading BOM', () => {
    const text = renderFeatureTemplate({ language: 'en', featureTitle: 'Order', scenarioTitle: 'Ready', tags: ['Draft'], template: '\uFEFFFeature: {{featureTitle}}\n\n@Draft\nScenario: {{scenarioTitle}}\n' });
    assert.equal(text, '\uFEFF@Draft\nFeature: Order\n\n@Draft\nScenario: Ready\n');
});

test('refuses unsafe titles, unsupported placeholders and custom templates without actual title declarations', () => {
    assert.ok(validateFeatureTitle(' '));
    assert.ok(validateFeatureTitle('Title\nScenario: injected'));
    assert.ok(validateFeatureTitle('Title\u0000'));
    assert.equal(validateFeatureTitle('Orders: approval'), undefined);
    assert.throws(() => renderFeatureTemplate({ language: 'en', featureTitle: 'Order', scenarioTitle: 'Ready', template: '#language: en\nFeature: {{featureTitle}}\nScenario: {{missing}}' }), /placeholder/iu);
    assert.throws(() => renderFeatureTemplate({ language: 'en', featureTitle: 'Order', scenarioTitle: 'Ready', template: '#language: en\n# {{featureTitle}} {{scenarioTitle}}\nFeature: Fixed\nScenario: Fixed' }), /title.*declaration/iu);
    assert.throws(() => renderFeatureTemplate({ language: 'en', featureTitle: 'Order', scenarioTitle: 'Ready', tags: ['bad\n@ExportScenarios'] }), /tag/iu);
});

test('accepts punctuation in feature tags and detects tags sharing a line', () => {
    const text = renderFeatureTemplate({ language: 'en', featureTitle: 'Order', scenarioTitle: 'Ready', tags: ['team.sales', '@issue=123', 'priority:high'], template: '#language: en\n@tree @team.sales\nFeature: {{featureTitle}}\nScenario: {{scenarioTitle}}\n' });
    assert.equal(text, '#language: en\n@tree @team.sales\n@issue=123\n@priority:high\nFeature: Order\nScenario: Ready\n');
});
