import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';
import { getGherkinDocumentFormat, getGherkinInsertionContext } from '../src/gherkinInsertionContext';
import { buildStepLibraryDropSnippet } from '../src/stepLibraryActions';

function position(line: number, character: number): vscode.Position {
    return { line, character } as vscode.Position;
}

function document(
    path: string,
    languageId: string,
    text: string
): Pick<vscode.TextDocument, 'uri' | 'languageId' | 'lineAt' | 'getText'> {
    const lines = text.split(/\r\n|\r|\n/u);
    return {
        uri: {
            path,
            fsPath: path,
            toString: () => `file://${path}`
        } as vscode.Uri,
        languageId,
        lineAt: ((line: number) => {
            if (!Number.isInteger(line) || line < 0 || line >= lines.length) {
                throw new RangeError('stale line');
            }
            return { text: lines[line] } as vscode.TextLine;
        }) as vscode.TextDocument['lineAt'],
        getText: (() => text) as vscode.TextDocument['getText']
    };
}

test('returns English feature context with typed keyword and indentation', () => {
    const feature = document('/repo/example.feature', 'gherkin', [
        '#language: en',
        'Feature: Demo',
        '  Scenario: Search',
        '    When I type'
    ].join('\n'));

    assert.deepEqual(getGherkinInsertionContext(feature, position(3, 12)), {
        supported: true,
        language: 'en',
        fallbackKeyword: 'And',
        typedKeyword: 'When',
        indentation: '    '
    });
});

test('Functionality declarations prevent inserting steps in the new feature header and description', () => {
    const feature = document('/repo/example.feature', 'gherkin', [
        'Feature: Previous', 'Scenario: Previous test', '    And ready',
        'Functionality: Checkout', 'As a customer', 'Scenario: Pay', '    '
    ].join('\n'));
    assert.equal(getGherkinInsertionContext(feature, position(3, 8)), null);
    assert.equal(getGherkinInsertionContext(feature, position(4, 8)), null);
    assert.equal(getGherkinInsertionContext(feature, position(6, 4))?.language, 'en');
});

test('infers Russian feature context from nearby steps and preserves blank-line indentation', () => {
    const feature = document('/repo/example.feature', 'gherkin', [
        'Функционал: Демо',
        '    Сценарий: Поиск',
        '        Допустим открыта форма',
        '        '
    ].join('\n'));

    assert.deepEqual(getGherkinInsertionContext(feature, position(3, 8)), {
        supported: true,
        language: 'ru',
        fallbackKeyword: 'И',
        typedKeyword: '',
        indentation: '        '
    });
});

test('accepts only the YAML scenario block scalar and infers its content indentation', () => {
    const yaml = document('/repo/example.yaml', 'yaml', [
        'ТипФайла: Сценарий',
        'KOTМетаданные:',
        '  Категория: Smoke',
        'ТекстСценария: |',
        '    Тогда открылась форма',
        '',
        'ПараметрыСценария:',
        '  Имя: Значение'
    ].join('\n'));

    assert.equal(getGherkinInsertionContext(yaml, position(2, 4)), null);
    assert.deepEqual(getGherkinInsertionContext(yaml, position(5, 0)), {
        supported: true,
        language: 'ru',
        fallbackKeyword: 'И',
        typedKeyword: '',
        indentation: '    '
    });
    assert.equal(getGherkinInsertionContext(yaml, position(6, 0)), null);
});

test('uses an explicit language tag and a typed YAML keyword', () => {
    const yaml = document('/repo/example.yaml', 'yaml', [
        '#language: en',
        'ТипФайла: Сценарий',
        'ТекстСценария: |-',
        '  Then ready'
    ].join('\n'));

    assert.deepEqual(getGherkinInsertionContext(yaml, position(3, 8)), {
        supported: true,
        language: 'en',
        fallbackKeyword: 'And',
        typedKeyword: 'Then',
        indentation: '  '
    });
});

test('rejects feature metadata, unsupported documents, and non-scenario YAML', () => {
    const feature = document('/repo/example.feature', 'gherkin', [
        'Feature: Demo',
        '@tag',
        'Scenario: Search'
    ].join('\n'));
    const yaml = document('/repo/example.yaml', 'yaml', [
        'ТипФайла: НастройкаТеста',
        'ТекстСценария: |',
        '    Then invalid'
    ].join('\n'));
    const text = document('/repo/example.txt', 'plaintext', 'Scenario: Search\n  Then invalid');

    assert.equal(getGherkinInsertionContext(feature, position(0, 4)), null);
    assert.equal(getGherkinInsertionContext(feature, position(1, 4)), null);
    assert.equal(getGherkinInsertionContext(yaml, position(2, 8)), null);
    assert.equal(getGherkinInsertionContext(text, position(1, 8)), null);
});

test('rejects stale positions and positions beyond the current line', () => {
    const feature = document('/repo/example.feature', 'gherkin', [
        'Feature: Demo',
        'Scenario: Search',
        '  Then ready'
    ].join('\n'));

    assert.equal(getGherkinInsertionContext(feature, position(-1, 0)), null);
    assert.equal(getGherkinInsertionContext(feature, position(20, 0)), null);
    assert.equal(getGherkinInsertionContext(feature, position(2, 40)), null);
});

test('validates both ends of a multiline selection independently', () => {
    const feature = document('/repo/example.feature', 'gherkin', [
        'Feature: Demo',
        'Scenario: Search',
        '  When first',
        '  Then second'
    ].join('\n'));

    const start = getGherkinInsertionContext(feature, position(2, 2));
    const end = getGherkinInsertionContext(feature, position(3, 4));
    assert.equal(start?.supported, true);
    assert.equal(end?.supported, true);
    assert.equal(start?.indentation, '  ');
    assert.equal(end?.indentation, '  ');
});

test('does not insert library steps into a Vanessa Variables section', () => {
    const feature = document('/repo/example.feature', 'feature', 'Feature: Demo\nBackground:\n    Given ready\nVariables:\n    Amount = "1"\n');
    assert.equal(getGherkinInsertionContext(feature, position(3, 0)), null);
    assert.equal(getGherkinInsertionContext(feature, position(4, 4)), null);
});

test('does not treat declarations inside a multiline Variables value as step insertion context', () => {
    const feature = document('/repo/example.feature', 'feature', 'Feature: Demo\nVariables:\n    Payload =\n    """\n    Scenario: sample text\n    ordinary payload\n    """\n    Another = "v"\nScenario: Real\n    Given ready');
    assert.equal(getGherkinInsertionContext(feature, position(5, 4)), null);
    assert.equal(getGherkinInsertionContext(feature, position(7, 4)), null);
    assert.equal(getGherkinInsertionContext(feature, position(9, 4))?.supported, true);
});
