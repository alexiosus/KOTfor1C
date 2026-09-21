import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cleaner = join(__dirname, '../../tools/cleanTestOutput.cjs');

test('cleans stale compiled tests without removing the extension bundle', () => {
    const project = mkdtempSync(join(tmpdir(), 'kot-clean-tests-'));
    const testOutput = join(project, 'out', 'test');
    const extensionBundle = join(dirname(testOutput), 'extension.js');

    try {
        mkdirSync(testOutput, { recursive: true });
        writeFileSync(join(testOutput, 'obsolete.test.js'), 'stale test');
        writeFileSync(extensionBundle, 'extension bundle');

        const result = spawnSync(process.execPath, [cleaner], {
            cwd: project,
            encoding: 'utf8'
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(testOutput), false);
        assert.equal(existsSync(extensionBundle), true);
    } finally {
        rmSync(project, { recursive: true, force: true });
    }
});

test('succeeds when compiled tests do not exist yet', () => {
    const project = mkdtempSync(join(tmpdir(), 'kot-clean-tests-'));

    try {
        const result = spawnSync(process.execPath, [cleaner], {
            cwd: project,
            encoding: 'utf8'
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(join(project, 'out', 'test')), false);
    } finally {
        rmSync(project, { recursive: true, force: true });
    }
});
