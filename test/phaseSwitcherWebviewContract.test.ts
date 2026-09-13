import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'phaseSwitcher.js'), 'utf8');

test('scenario rows carry the descriptor URI into destructive command messages', () => {
    assert.match(source, /data-uri="\$\{escapedFileUriAttr\}"/);
    assert.match(source, /command: 'openScenario',\s*name,\s*uri/);
    assert.match(source, /command: 'renameScenario', name, uri/);
    assert.match(source, /command: 'deleteMainScenario', name, uri/);
});

test('test settings command carries the exact scenario URI', () => {
    assert.match(source, /command: 'openMainScenarioTestSettings', name, uri/);
});
