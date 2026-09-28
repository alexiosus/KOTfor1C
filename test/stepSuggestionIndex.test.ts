import assert from 'node:assert/strict';
import test from 'node:test';
import {
    StepSuggestionIndex,
    normalizeStepSuggestionText
} from '../src/stepSuggestionIndex';
import {
    calculateLevenshteinSimilarity,
    levenshteinDistance
} from '../src/stringSimilarity';

test('linear-space Levenshtein keeps the existing similarity result', () => {
    assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
    assert.equal(calculateLevenshteinSimilarity('kitten', 'sitting'), 4 / 7);
    assert.equal(calculateLevenshteinSimilarity('same', 'same'), 1);
    assert.equal(calculateLevenshteinSimilarity('', 'value'), 0);
});

test('step suggestion index normalizes source definitions once and keeps both languages', async () => {
    const index = new StepSuggestionIndex([
        {
            firstLine: 'Given I open "%1 file"',
            russianFirstLine: 'Допустим я открываю "%1 файл"'
        },
        { firstLine: 'When I close the application' }
    ]);

    assert.equal(normalizeStepSuggestionText('Given I open "report.epf"'), 'i open');
    assert.deepEqual(await index.getSuggestions('When I open "report.epf"', 2), [
        'Given I open "%1 file"'
    ]);
    assert.deepEqual(await index.getSuggestions('Когда я открываю "отчет.epf"', 2), [
        'Допустим я открываю "%1 файл"'
    ]);
});

test('step suggestion search yields in chunks and caches completed queries', async () => {
    let yieldCount = 0;
    const index = new StepSuggestionIndex(
        Array.from({ length: 6 }, (_, index) => ({ firstLine: `Given candidate ${index}` })),
        {
            yieldEvery: 2,
            yieldControl: async () => {
                yieldCount += 1;
            }
        }
    );

    const first = await index.getSuggestions('Given unrelated text', 3);
    const yieldsAfterFirstSearch = yieldCount;
    const second = await index.getSuggestions('Given unrelated text', 3);

    assert.ok(yieldsAfterFirstSearch >= 2);
    assert.equal(yieldCount, yieldsAfterFirstSearch);
    assert.deepEqual(second, first);
    assert.notEqual(second, first);
});

test('step suggestion search stops after a stale validation is cancelled', async () => {
    let cancelled = false;
    let yieldCount = 0;
    const index = new StepSuggestionIndex(
        Array.from({ length: 20 }, (_, index) => ({ firstLine: `Given candidate ${index}` })),
        {
            yieldEvery: 2,
            yieldControl: async () => {
                yieldCount += 1;
                cancelled = true;
            }
        }
    );

    const suggestions = await index.getSuggestions('Given unknown text', 3, () => cancelled);

    assert.deepEqual(suggestions, []);
    assert.equal(yieldCount, 1);
});

test('step suggestion ranking remains stable for equal scores', async () => {
    const index = new StepSuggestionIndex([
        { firstLine: 'Given abc' },
        { firstLine: 'Given abd' },
        { firstLine: 'Given xyz' }
    ]);

    assert.deepEqual(await index.getSuggestions('Given abe', 2), [
        'Given abc',
        'Given abd'
    ]);
});
