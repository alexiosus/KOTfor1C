import assert from 'node:assert/strict';
import test from 'node:test';

import { decideSharedStartupInfobaseAction } from '../src/startupInfobasePolicy';

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

test('only recreates an existing startup infobase after an explicit force request', () => {
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
