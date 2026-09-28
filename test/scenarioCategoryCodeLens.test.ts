import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isScenarioCategoryCommandTarget,
    validateScenarioCategoryValue
} from '../src/scenarioCategory';

test('accepts only complete scenario category command targets', () => {
    assert.equal(isScenarioCategoryCommandTarget({
        documentUri: 'file:///scenario.yaml',
        documentVersion: 7
    }), true);
    assert.equal(isScenarioCategoryCommandTarget({
        documentUri: '',
        documentVersion: 7
    }), false);
    assert.equal(isScenarioCategoryCommandTarget({
        documentUri: 'file:///scenario.yaml',
        documentVersion: 1.5
    }), false);
    assert.equal(isScenarioCategoryCommandTarget({
        documentUri: 'file:///scenario.yaml',
        documentVersion: 7,
        uri: 'file:///attacker.yaml'
    }), true);
});

test('validates non-empty single-line categories', () => {
    const t = (message: string) => `T:${message}`;

    assert.equal(validateScenarioCategoryValue('Sales.Orders', t), undefined);
    assert.equal(
        validateScenarioCategoryValue('   ', t),
        'T:Scenario category must not be empty.'
    );
    assert.equal(
        validateScenarioCategoryValue('Sales\nOrders', t),
        'T:Scenario category must fit on a single line.'
    );
});
