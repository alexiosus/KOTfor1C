import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScenarioParameterDefaults } from '../src/scenarioParameterUtils';

test('parses a default value from a KOT scenario parameter block', () => {
    const documentText = [
        'ТипФайла: "Сценарий"',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: "Customer"',
        '        Значение: "Default customer"',
        'ТекстСценария: |',
        '    Given I open the application'
    ].join('\n');

    const defaults = parseScenarioParameterDefaults(documentText);

    assert.equal(defaults.get('Customer'), '"Default customer"');
});
