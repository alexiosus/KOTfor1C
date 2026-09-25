import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProcessCommandForDisplay } from '../src/processCommandDisplay';

test('redacts a 1C password argument without changing surrounding arguments', () => {
    assert.equal(
        formatProcessCommandForDisplay('1cv8.exe', ['/N', 'Administrator', '/P', 'top-secret', '/Out', 'run.log']),
        '"1cv8.exe" "/N" "Administrator" "/P" "***" "/Out" "run.log"'
    );
});

test('redacts inline password and token arguments', () => {
    const displayed = formatProcessCommandForDisplay('runner', [
        '--password=secret',
        '--api-key',
        'key-value',
        '--token=token-value'
    ]);

    assert.equal(displayed, '"runner" "--password=***" "--api-key" "***" "--token=***"');
    assert.doesNotMatch(displayed, /secret|key-value|token-value/);
});
