import assert from 'node:assert/strict';
import test from 'node:test';
import { translatorFor } from './helpers/localization';

test('KOT Russian overrides English VS Code, including placeholders and missing-message fallback', async () => {
    const t = await translatorFor('Русский');
    assert.equal(t('Test properties'), 'Свойства теста');
    assert.equal(t('Library'), 'Библиотека');
    assert.equal(t('Failed to open definition: {0}', 'details'), 'Не удалось открыть определение: details');
    assert.equal(t('Unknown {0}', 'value'), 'Unknown value');
});

test('KOT English overrides Russian VS Code and System follows the VS Code language', async () => {
    assert.equal((await translatorFor('English', 'ru'))('Library'), 'Library');
    assert.equal((await translatorFor('System', 'ru'))('Library'), 'Библиотека');
    assert.equal((await translatorFor('System', 'en'))('Library'), 'Library');
});
