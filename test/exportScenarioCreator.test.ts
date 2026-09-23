import assert from 'node:assert/strict';
import test from 'node:test';
import {
    deriveExportScenarioDraft,
    planExportScenarioEdit,
    type ExportScenarioEditPlan,
    type ExportScenarioEditSource
} from '../src/exportScenarioCreator';

function source(text: string, version = 7): ExportScenarioEditSource {
    return {
        text,
        version,
        sourceUri: 'file:///workspace/libraries/exports.feature',
        workspaceFolderUri: 'file:///workspace',
        profileId: 'active',
        libraryRootUri: 'file:///workspace/libraries',
        sourceLabel: 'Project exports',
        defaultLanguage: 'en'
    };
}

function applyPlan(text: string, plan: ExportScenarioEditPlan): string {
    return [...plan.edits]
        .sort((left, right) => right.startOffset - left.startOffset)
        .reduce(
            (current, edit) => current.slice(0, edit.startOffset) + edit.newText + current.slice(edit.endOffset),
            text
        );
}

test('adds a scenario to an existing tagged feature and preserves its final newline', () => {
    const original = '# language: en\n@ExportScenarios\nFeature: Shared calls\n\n  Scenario: Existing call\n      Given ready\n';
    const plan = planExportScenarioEdit(source(original), {
        expectedVersion: 7,
        title: 'I open "Order"',
        parameterNames: ['Entity']
    });
    const result = applyPlan(original, plan);

    assert.equal(plan.documentVersion, 7);
    assert.match(result, /  Scenario: I open "Entity"\n      \n$/u);
    assert.equal(result.endsWith('\n'), true);
    assert.deepEqual(plan.cursor, { line: 8, character: 6 });
});

test('adds a confirmed feature export tag using the parser insertion metadata', () => {
    const original = '# language: en\nFeature: Shared calls\n\nScenario: Existing\n    Given ready';
    const plan = planExportScenarioEdit(source(original), {
        expectedVersion: 7,
        title: 'Another call',
        confirmAddExportTag: true
    });
    const result = applyPlan(original, plan);

    assert.equal(result.startsWith('# language: en\n@ExportScenarios\nFeature:'), true);
    assert.match(result, /\n\nScenario: Another call\n    $/u);
    assert.equal(result.endsWith('\n'), false);
});

test('refuses to change an existing feature without explicit export-tag confirmation', () => {
    const original = 'Feature: Shared calls\nScenario: Existing\n    Given ready\n';
    assert.throws(
        () => planExportScenarioEdit(source(original), { expectedVersion: 7, title: 'Another call' }),
        /export tag.*confirmation/iu
    );
});

test('creates complete English and Russian export features', () => {
    const english = planExportScenarioEdit(source('', 0), {
        expectedVersion: 0,
        createNewFile: true,
        language: 'en',
        featureTitle: 'Shared calls',
        title: 'I open "Entity"',
        parameterNames: ['Object']
    });
    const russian = planExportScenarioEdit({ ...source('', 0), defaultLanguage: 'ru' }, {
        expectedVersion: 0,
        createNewFile: true,
        language: 'ru',
        featureTitle: 'Общие вызовы',
        title: 'Я открываю "Объект"'
    });

    assert.equal(applyPlan('', english), [
        '# language: en',
        '@ExportScenarios',
        'Feature: Shared calls',
        '',
        'Scenario: I open "Object"',
        '    ',
        ''
    ].join('\n'));
    assert.equal(applyPlan('', russian), [
        '# language: ru',
        '@ExportScenarios',
        'Функциональность: Общие вызовы',
        '',
        'Сценарий: Я открываю "Объект"',
        '    ',
        ''
    ].join('\n'));
});

test('derives Quick Fix title and ordered parameter suggestions from an invocation', () => {
    assert.deepEqual(
        deriveExportScenarioDraft({ invocation: '  And I open "Sales order" as \'Administrator\'', language: 'en' }),
        {
            title: 'I open "Sales order" as \'Administrator\'',
            parameterSuggestions: ['Sales order', 'Administrator']
        }
    );
    assert.deepEqual(
        deriveExportScenarioDraft({ invocation: 'И я открываю "Заказ"', language: 'ru' }),
        { title: 'я открываю "Заказ"', parameterSuggestions: ['Заказ'] }
    );
});

test('rejects duplicate parameter names case-insensitively', () => {
    assert.throws(
        () => planExportScenarioEdit(source('', 0), {
            expectedVersion: 0,
            createNewFile: true,
            title: 'I compare "left" and "right"',
            parameterNames: ['Value', ' value ']
        }),
        /duplicate parameter name/iu
    );
});

test('preserves BOM, CRLF, existing indentation and missing final newline', () => {
    const original = '\uFEFF# language: ru\r\n@ExportScenarios\r\nФункциональность: Общие\r\n\r\n    Сценарий: Старый\r\n        Дано готово';
    const plan = planExportScenarioEdit({ ...source(original), defaultLanguage: 'ru' }, {
        expectedVersion: 7,
        title: 'Новый вызов'
    });
    const result = applyPlan(original, plan);

    assert.equal(result.startsWith('\uFEFF'), true);
    assert.equal(result.replace(/\r\n/gu, '').includes('\n'), false);
    assert.match(result, /\r\n\r\n    Сценарий: Новый вызов\r\n        $/u);
    assert.equal(result.endsWith('\r\n'), false);
});

test('rejects a plan against a concurrently changed document version', () => {
    assert.throws(
        () => planExportScenarioEdit(source('Feature: Calls', 8), {
            expectedVersion: 7,
            title: 'Call'
        }),
        /document changed/iu
    );
});
