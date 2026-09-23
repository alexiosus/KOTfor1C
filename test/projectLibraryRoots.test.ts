import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectLibraryConfiguration } from '../src/projectLibraryRoots';

test('prefers effective Vanessa librarycatalogs over build fallbacks', () => {
    const result = resolveProjectLibraryConfiguration({
        workspaceFolderPath: 'C:\\repo',
        workspaceFolderUri: 'file:///C:/repo',
        profileId: 'active',
        buildParameters: [
            { key: 'Libraries', value: '#Libraries\\fallback' },
            { key: 'VanessaLibraries', value: '#Libraries\\last-resort' }
        ],
        additionalVanessaParameters: [{
            key: 'librarycatalogs',
            value: '["#Libraries\\\\one", "#Libraries\\\\two"]',
            overrideExisting: true
        }],
        pathApi: path.win32
    });

    assert.deepEqual(result.libraryRootPaths, ['C:\\repo\\one', 'C:\\repo\\two']);
});

test('applies alias and override semantics before resolving library roots', () => {
    const result = resolveProjectLibraryConfiguration({
        workspaceFolderPath: '/repo',
        profileId: 'active',
        buildParameters: [],
        additionalVanessaParameters: [
            { key: 'КаталогиБиблиотек', value: '/libraries/first', overrideExisting: false },
            { key: 'librarycatalogs', value: '/libraries/ignored', overrideExisting: false },
            { key: 'librarycatalogs', value: '/libraries/final', overrideExisting: true }
        ],
        pathApi: path.posix
    });

    assert.deepEqual(result.libraryRootPaths, ['/libraries/final']);
});

test('falls back from Libraries to VanessaLibraries only when the earlier value is empty', () => {
    const libraries = resolveProjectLibraryConfiguration({
        workspaceFolderPath: '/repo',
        profileId: 'active',
        buildParameters: [
            { key: 'Libraries', value: 'libraries/one:libraries/two' },
            { key: 'VanessaLibraries', value: 'libraries/three' }
        ],
        additionalVanessaParameters: [],
        pathApi: path.posix
    });
    const vanessaLibraries = resolveProjectLibraryConfiguration({
        workspaceFolderPath: '/repo',
        profileId: 'active',
        buildParameters: [
            { key: 'Libraries', value: '  ' },
            { key: 'VanessaLibraries', value: 'libraries/three' }
        ],
        additionalVanessaParameters: [],
        pathApi: path.posix
    });

    assert.deepEqual(libraries.libraryRootPaths, ['/repo/libraries/one', '/repo/libraries/two']);
    assert.deepEqual(vanessaLibraries.libraryRootPaths, ['/repo/libraries/three']);
});

test('keeps Windows drive and UNC roots absolute and removes duplicates case-insensitively', () => {
    const result = resolveProjectLibraryConfiguration({
        workspaceFolderPath: 'C:\\repo',
        profileId: 'active',
        buildParameters: [{
            key: 'Libraries',
            value: 'C:\\Libraries;\\\\server\\share\\steps;c:\\libraries'
        }],
        additionalVanessaParameters: [],
        pathApi: path.win32
    });

    assert.deepEqual(result.libraryRootPaths, ['C:\\Libraries', '\\\\server\\share\\steps']);
});

test('resolves project tokens per owning workspace and excludes unresolved tokens', () => {
    const first = resolveProjectLibraryConfiguration({
        workspaceFolderPath: '/work/first',
        profileId: 'profile-a',
        buildParameters: [{
            key: 'Libraries',
            value: '["#SourcesPath/libs", "#Libraries/shared", "#Unknown/missing"]'
        }],
        additionalVanessaParameters: [],
        pathApi: path.posix
    });
    const second = resolveProjectLibraryConfiguration({
        workspaceFolderPath: '/work/second',
        profileId: 'profile-a',
        buildParameters: [{ key: 'Libraries', value: '#Libraries/shared' }],
        additionalVanessaParameters: [],
        pathApi: path.posix
    });

    assert.deepEqual(first.libraryRootPaths, ['/work/first/libs', '/work/first/shared']);
    assert.deepEqual(second.libraryRootPaths, ['/work/second/shared']);
    assert.equal(first.warnings.length, 1);
    assert.match(first.warnings[0], /#Unknown\/missing/);
    assert.notEqual(first.identity, second.identity);
});

test('resolves feature folders and ordered Vanessa installation aliases', () => {
    const result = resolveProjectLibraryConfiguration({
        workspaceFolderPath: 'C:\\repo',
        profileId: 'active',
        buildParameters: [
            { key: 'FeatureFolder', value: '#SourcesPath\\features' },
            { key: 'VanessaFolder', value: 'tools\\vanessa' },
            { key: 'VanessaDir', value: 'C:\\shared\\vanessa' },
            { key: 'VanessaPath', value: '\\\\server\\tools\\vanessa-automation.epf' }
        ],
        additionalVanessaParameters: [],
        pathApi: path.win32
    });

    assert.deepEqual(result.featureFolderPaths, ['C:\\repo\\features']);
    assert.deepEqual(result.vanessaInstallationCandidates, [
        'C:\\repo\\tools\\vanessa',
        'C:\\shared\\vanessa',
        '\\\\server\\tools\\vanessa-automation.epf'
    ]);
});

test('deduplicates warnings and configuration identity is stable', () => {
    const input = {
        workspaceFolderPath: '/repo',
        profileId: 'active',
        buildParameters: [{ key: 'Libraries', value: '#Missing/a:#Missing/a' }],
        additionalVanessaParameters: [],
        pathApi: path.posix
    };

    const first = resolveProjectLibraryConfiguration(input);
    const second = resolveProjectLibraryConfiguration(input);

    assert.equal(first.warnings.length, 1);
    assert.equal(first.identity, second.identity);
});
