import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { decideSharedStartupInfobaseAction } from '../src/startupInfobasePolicy';
import { replaceSharedStartupInfobase } from '../src/startupInfobasePreparation';

test('reuses an existing legacy Windows startup infobase without deleting locked files', () => {
    assert.deepEqual(decideSharedStartupInfobaseAction({
        markerExists: true,
        forceRecreate: false,
        platform: 'win32',
        hasStoredAuthentication: false,
        templateDescriptorMatches: false
    }), {
        action: 'reuse',
        authentication: 'none',
        reason: 'legacy'
    });
});

test('does not silently recreate an existing startup infobase when its template changed', () => {
    assert.deepEqual(decideSharedStartupInfobaseAction({
        markerExists: true,
        forceRecreate: false,
        platform: 'win32',
        hasStoredAuthentication: true,
        templateDescriptorMatches: false
    }), {
        action: 'reuse',
        authentication: 'stored',
        reason: 'templateChanged'
    });
});

test('can force a rebuild and creates a missing startup infobase', () => {
    assert.equal(decideSharedStartupInfobaseAction({
        markerExists: true,
        forceRecreate: true,
        platform: 'win32',
        hasStoredAuthentication: true,
        templateDescriptorMatches: true
    }).action, 'recreate');
    assert.equal(decideSharedStartupInfobaseAction({
        markerExists: false,
        forceRecreate: false,
        platform: 'win32',
        hasStoredAuthentication: false,
        templateDescriptorMatches: false
    }).action, 'create');
});

test('recreates an existing Windows service base for a different extension version', () => {
    const input = { markerExists: true, forceRecreate: false, platform: 'win32' as const,
        hasStoredAuthentication: true, templateDescriptorMatches: true };
    assert.deepEqual(decideSharedStartupInfobaseAction({ ...input, extensionVersionChanged: true }), {
        action: 'recreate', authentication: 'none', reason: 'extensionChanged'
    });
    assert.equal(decideSharedStartupInfobaseAction({ ...input, extensionVersionChanged: false }).action, 'reuse');
    assert.equal(decideSharedStartupInfobaseAction({ ...input, platform: 'linux', extensionVersionChanged: true }).action, 'reuse');
});

test('replacing the service base keeps the customized predecessor and rolls back a failed publication', t => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'kot-service-replace-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const current = path.join(root, 'ib');
    const restored = path.join(root, 'prepared');
    const backup = path.join(root, 'backup');
    const marker = '1Cv8.1CD';
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(current, marker), 'local modifications');
    assert.throws(() => replaceSharedStartupInfobase(current, restored, backup));
    assert.equal(fs.readFileSync(path.join(current, marker), 'utf8'), 'local modifications');
    assert.equal(fs.existsSync(backup), false);

    fs.mkdirSync(restored);
    fs.writeFileSync(path.join(restored, marker), 'clean template');
    fs.writeFileSync(path.join(restored, 'template-state.json'), '{"extensionVersion":"3.1.1"}');
    replaceSharedStartupInfobase(current, restored, backup);
    assert.equal(fs.readFileSync(path.join(current, marker), 'utf8'), 'clean template');
    assert.equal(fs.readFileSync(path.join(current, 'template-state.json'), 'utf8'), '{"extensionVersion":"3.1.1"}');
    assert.equal(fs.readFileSync(path.join(backup, marker), 'utf8'), 'local modifications');
});
