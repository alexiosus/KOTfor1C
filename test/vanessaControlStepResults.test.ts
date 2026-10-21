import assert from 'node:assert/strict';
import test from 'node:test';
import { mapVanessaStepResults } from '../src/vanessaControlStepResults';
const reply = (steps: string) => ({ content: [{ type: 'text', text: '# Результаты тестов\n\n- Статус: Success\n\n## Шаги (2)\n' + steps }] });
test('completed runtime rows map to unique executable source lines, not a guessed interval', () => {
    const source = '# language: en\nFeature: Own\nScenario: Own\n  And Delay 99\n  And Delay 0\n  And own text\n    """\n    And literal\n    """\n';
    assert.deepEqual(mapVanessaStepResults(reply('1. And Delay 0 → **Success** (1 мс)\n2. And own text → **Failed** (2 мс)'), source, 5),
        [{ lineNumber: 5, status: 'passed' }, { lineNumber: 6, status: 'failed' }]);
    assert.deepEqual(mapVanessaStepResults(reply('1. And literal → **Success**\n2. And Delay 99 → **Success**'), source, 5), []);
});
test('ambiguous identical steps and unrecognized result formatting never create successful line marks', () => {
    const source = '# language: en\nFeature: Own\nScenario: Own\n  And Delay 0\n  And Delay 0\n';
    assert.deepEqual(mapVanessaStepResults(reply('1. And Delay 0 → **Success**\n2. And Delay 0 → **Success**'), source, 1), []);
    assert.deepEqual(mapVanessaStepResults({ isError: true, ...reply('') }, source, 1), []);
    assert.deepEqual(mapVanessaStepResults(reply('1. And Delay 0 → **Success**'), source, 1), []);
});
