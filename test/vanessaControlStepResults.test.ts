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

test('skipped rows do not discard the successful and failed rows of the same run', () => {
    const source = '# language: en\nFeature: Own\nScenario: Own\n  And Delay 0\n  And own assertion\n  And later step\n';
    const result = { content: [{ type: 'text', text: '# Результаты тестов\n\n- Статус: Failed\n\n## Шаги (3)\n' +
        '1. And Delay 0 → **Success** (1 мс)\n2. And own assertion → **Failed** (2 мс)\n   - Ошибка: Assertion failed\n3. And later step → **Skipped** (0 мс)\n   - Ошибка: Пропущен' }] };
    assert.deepEqual(mapVanessaStepResults(result, source, 4), [
        { lineNumber: 4, status: 'passed' }, { lineNumber: 5, status: 'failed' }, { lineNumber: 6, status: 'skipped' }
    ]);
});

test('an exported call is passed only after all of its expanded steps passed', () => {
    const source = '# language: en\nFeature: Own\nScenario: Own\n  And reusable "value"\n  And later\n';
    const expanded = [
        { lineNumber: 4, text: 'And save "value"' }, { lineNumber: 4, text: 'And verify "value"' },
        { lineNumber: 5, text: 'And later' }
    ];
    assert.deepEqual(mapVanessaStepResults(reply('1. And save "value" → **Success**\n2. And verify "value" → **Success**'), source, 1, undefined, expanded),
        [{ lineNumber: 4, status: 'passed' }]);
    assert.deepEqual(mapVanessaStepResults(reply('1. And save "value" → **Success**\n2. And later → **Success**'), source, 1, undefined, expanded),
        [{ lineNumber: 5, status: 'passed' }]);
    assert.deepEqual(mapVanessaStepResults(reply('1. And save "value" → **Success**\n2. And verify "value" → **Failed**'), source, 1, undefined, expanded),
        [{ lineNumber: 4, status: 'failed' }]);
});
test('ordered repeated steps are mapped only when their alignment is unique', () => {
    const source = '# language: en\nFeature: Own\nScenario: Own\n  And Delay 0\n  And Delay 0\n';
    assert.deepEqual(mapVanessaStepResults(reply('1. And Delay 0 → **Success**\n2. And Delay 0 → **Success**'), source, 1), [{ lineNumber: 4, status: 'passed' }, { lineNumber: 5, status: 'passed' }]);
    assert.deepEqual(mapVanessaStepResults({ content: [{ type: 'text', text: '# Результаты тестов\n\n## Шаги (1)\n1. And Delay 0 → **Success**' }] }, source), []);
    assert.deepEqual(mapVanessaStepResults({ isError: true, ...reply('') }, source, 1), []);
    assert.deepEqual(mapVanessaStepResults(reply('1. And Delay 0 → **Success**'), source, 1), []);
});

test('the complete result sequence identifies one variant when idle state omits its scenario name', () => {
    const lines = ['# language: en', 'Feature: Own', 'Background:', '  And connect'];
    const variant = (name: string, tail: string) => {
        lines.push('Scenario: ' + name); const expected: number[] = [];
        for (let group = 0; group < 2; group++) {
            lines.push('  *And nested');
            for (let step = 0; step < 2; step++) { lines.push('    And Delay 1'); expected.push(lines.length); }
        }
        lines.push('  And Delay "' + tail + '"'); expected.push(lines.length); return expected;
    };
    variant('Own Wait=1;', '1'); const second = variant('Own Wait=2;', '2');
    const result = { content: [{ type: 'text', text: '# Результаты тестов\n\n## Шаги (6)\n' +
        ['And connect', ...Array(4).fill('And Delay 1'), 'And Delay "2"'].map((step, index) => `${index + 1}. ${step} → **Success**`).join('\n') }] };
    assert.deepEqual(mapVanessaStepResults(result, lines.join('\n')), [4, ...second].map(lineNumber => ({ lineNumber, status: 'passed' })));
    assert.deepEqual(mapVanessaStepResults(result, lines.join('\n'), 14), [4, ...second].map(lineNumber => ({ lineNumber, status: 'passed' })));
});
