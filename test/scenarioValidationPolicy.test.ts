import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createDocumentValidationCancellation,
    getScenarioValidationOptions
} from '../src/scenarioValidationPolicy';

test('editing validates steps without calculating expensive suggestions', () => {
    assert.deepEqual(getScenarioValidationOptions('change'), {
        includeSuggestions: false,
        includeStepChecks: true,
        includeStepSuggestions: false,
        includeScenarioSuggestions: false
    });
});

test('opening and saving retain step and scenario suggestions', () => {
    assert.deepEqual(getScenarioValidationOptions('save'), {
        includeSuggestions: false,
        includeStepChecks: true,
        includeStepSuggestions: true,
        includeScenarioSuggestions: true
    });
});

test('document validation cancellation observes version changes and request cancellation', () => {
    const document = { version: 7 };
    const cancellation = { isCancellationRequested: false };
    const shouldCancel = createDocumentValidationCancellation(document, cancellation);

    assert.equal(shouldCancel(), false);
    cancellation.isCancellationRequested = true;
    assert.equal(shouldCancel(), true);

    cancellation.isCancellationRequested = false;
    document.version = 8;
    assert.equal(shouldCancel(), true);
});
