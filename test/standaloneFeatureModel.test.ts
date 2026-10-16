import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStandaloneFeatureSource } from '../src/standaloneFeatureModel';

test('detects BOM, Russian aliases and English declarations without a directive', () => {
    assert.deepEqual(parseStandaloneFeatureSource('\uFEFF# language: ru\nФункция: Проверка заказа\nСценарий: Заказ', 'order'), {
        title: 'Проверка заказа', language: 'ru', exportOnly: false
    });
    assert.deepEqual(parseStandaloneFeatureSource('Feature: Order checkout\nScenario: Checkout', 'order'), {
        title: 'Order checkout', language: 'en', exportOnly: false
    });
    assert.equal(parseStandaloneFeatureSource('# unfinished test', 'draft').title, 'draft');
});

test('excludes export-only declarations while retaining mixed authored tests', () => {
    const samples = [
        { source: '@ExportScenarios\nFeature: Library\nScenario: Shared login', exportOnly: true },
        { source: 'Feature: Library\n@exportscenarios\nScenario: Shared login', exportOnly: true },
        { source: '@ExportScenarios\nФункциональность: Пустая библиотека', exportOnly: true },
        { source: 'Feature: Mixed\n@ExportScenarios\nScenario: Shared login\n Given ready\nScenario: Checkout', exportOnly: false },
        { source: 'Feature: Authored\nScenario: Checkout\n Given payload\n """\n @ExportScenarios\n Scenario: fake declaration\n """', exportOnly: false }
    ];
    for (const sample of samples) {
        assert.equal(parseStandaloneFeatureSource(sample.source, 'test').exportOnly, sample.exportOnly);
    }
});

test('does not infer English from feature-shaped text in a Russian docstring', () => {
    const source = 'Функциональность: Проверка текста\nСценарий: Текст\n Дано сообщение\n """\n Feature: Embedded example\n """';
    assert.deepEqual(parseStandaloneFeatureSource(source, 'text'), {
        title: 'Проверка текста', language: 'ru', exportOnly: false
    });
});

test('recognizes the feature declarations in the supplied Vanessa ru and en templates', () => {
    assert.deepEqual(parseStandaloneFeatureSource('\uFEFF# language: en\n@tree\nFunctionality: Customer checkout\nScenario: Checkout', 'checkout'), {
        title: 'Customer checkout', language: 'en', exportOnly: false
    });
    assert.deepEqual(parseStandaloneFeatureSource('\uFEFF# language: ru\n@tree\nФункционал: Заказ клиента\nСценарий: Заказ', 'checkout'), {
        title: 'Заказ клиента', language: 'ru', exportOnly: false
    });
});
