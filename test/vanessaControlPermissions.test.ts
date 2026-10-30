import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMcpPermissionsReport } from '../src/vanessaControlPermissions';

const valid = { name: 'client_mcp', version: '0.6.6', safeMode: false, unsafeActionProtection: true, active: true };
test('only an explicit verified report for the pinned active extension satisfies MCP preparation', () => {
    assert.deepEqual(parseMcpPermissionsReport(JSON.stringify(valid)), valid);
    for (const report of [{}, { ...valid, safeMode: true }, { ...valid, name: 'other' },
        { ...valid, version: '0.6.5' }, { ...valid, active: false }, { ...valid, error: 'failed' },
        { ...valid, unsafeActionProtection: undefined }, { ...valid, safeMode: 'false' }]) {
        assert.throws(() => parseMcpPermissionsReport(JSON.stringify(report)));
    }
    assert.throws(() => parseMcpPermissionsReport('not JSON'));
});
