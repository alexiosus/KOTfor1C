import assert from 'node:assert/strict';
import test from 'node:test';
import { findScenarioReference } from '../src/scenarioReferenceMatcher';

const keywords = [
    'And',
    'Given',
    'When',
    'Then',
    'But',
    'If',
    'К тому же',
    'Но',
    'Тогда',
    'Когда',
    'Если',
    'И',
    'Допустим'
] as const;

test('matches scenario references after every supported Gherkin keyword', () => {
    const targetName = 'Open form (v2.0) [admin]?';

    for (const keyword of keywords) {
        const line = `    ${keyword} ${targetName}   `;
        const match = findScenarioReference(line, targetName);

        assert.deepEqual(match, {
            start: line.indexOf(targetName),
            length: targetName.length
        }, keyword);
    }
});

test('supports the optional Gherkin bullet before a keyword', () => {
    const targetName = 'Проверка формы';
    const line = `  * Тогда ${targetName}`;

    assert.deepEqual(findScenarioReference(line, targetName), {
        start: line.indexOf(targetName),
        length: targetName.length
    });
});

test('does not treat a longer step or an inline comment as an exact scenario reference', () => {
    assert.equal(findScenarioReference('Given Target scenario with extra text', 'Target scenario'), null);
    assert.equal(findScenarioReference('Given Target scenario # comment', 'Target scenario'), null);
});
