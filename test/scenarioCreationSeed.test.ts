import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMainScenarioGroupSeed } from '../src/scenarioCreationSeed';

test('accepts a trimmed group name from Test Manager and rejects unrelated command data', () => {
    assert.equal(resolveMainScenarioGroupSeed({ groupName: '  Production 2  ' }), 'Production 2');
    assert.equal(resolveMainScenarioGroupSeed({ groupName: '' }), undefined);
    assert.equal(resolveMainScenarioGroupSeed({ groupName: 42 }), undefined);
    assert.equal(resolveMainScenarioGroupSeed('Production 2'), undefined);
});
