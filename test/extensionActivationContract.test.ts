import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');

test('activation does not eagerly provision 1C helper infobases', () => {
    assert.doesNotMatch(source, /warmUpSharedStartupInfobase/);
    assert.doesNotMatch(source, /warmUpFormExplorerBuilder/);
    assert.doesNotMatch(source, /ensureOneCClientPathConfigured/);
});
