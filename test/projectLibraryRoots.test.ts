import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { addProjectLibraryFolder, resolveProjectLibraryConfiguration } from '../src/projectLibraryRoots';

test('registers an export folder in compiler Libraries without changing other profile settings', () => {
    const input = { workspaceFolderPath: '/repo', profileId: 'active',
        buildParameters: [{ key: 'Libraries', value: '' }, { key: 'ScenarioFolder', value: 'tests' }], additionalVanessaParameters: [] };
    const updated = addProjectLibraryFolder(input, '/repo/tests/nested');
    assert.equal(updated.buildParameters[0].value, 'tests/nested');
    assert.deepEqual(updated.buildParameters[1], input.buildParameters[1]);
    assert.deepEqual(resolveProjectLibraryConfiguration({ ...input, ...updated }).libraryRootPaths, ['/repo/tests/nested']);
    assert.equal(input.buildParameters[0].value, '');
    assert.deepEqual(addProjectLibraryFolder({ ...input, ...updated }, '/repo/tests/nested/child'), updated);
});

test('library registration preserves aliases and effective Additional priority on both platforms', () => {
    for (const pathApi of [path.posix, path.win32]) {
        const root = pathApi === path.win32 ? 'C:\\repo' : '/repo'; const target = pathApi.join(root, 'exports');
        for (const key of ['librarycatalogs', 'КаталогиБиблиотек', '/librarycatalogs']) {
            const input = { workspaceFolderPath: root, profileId: 'active', pathApi,
                buildParameters: [{ key: 'VanessaLibraries', value: 'shared' }],
                additionalVanessaParameters: [{ key, value: '["additional"]', overrideExisting: true }, { key: 'Custom', value: 'keep', overrideExisting: true }] };
            const updated = addProjectLibraryFolder(input, target);
            assert.deepEqual(resolveProjectLibraryConfiguration({ ...input, ...updated }).libraryRootPaths, [pathApi.join(root, 'additional'), target]);
            assert.equal(updated.buildParameters[0].key, 'VanessaLibraries');
            assert.equal(updated.buildParameters[0].value, `shared|exports`);
            assert.equal(updated.additionalVanessaParameters[0].key, key);
            assert.deepEqual(updated.additionalVanessaParameters[1], input.additionalVanessaParameters[1]);
        }
    }
});

test('empty priority library override gains the export folder; inactive overrides stay unchanged', () => {
    for (const overrideExisting of [false, true]) {
        const input = { workspaceFolderPath: '/repo', profileId: 'active', buildParameters: [],
            additionalVanessaParameters: [{ key: 'librarycatalogs', value: '[]', overrideExisting }] };
        const updated = addProjectLibraryFolder(input, '/repo/exports');
        assert.deepEqual(resolveProjectLibraryConfiguration({ ...input, ...updated }).libraryRootPaths, ['/repo/exports']);
        if (!overrideExisting) { assert.deepEqual(updated.additionalVanessaParameters, input.additionalVanessaParameters); }
    }
});

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

test('resolves compiler pipe-separated Libraries on both platforms without splitting drive letters', () => {
    for (const pathApi of [path.posix, path.win32]) {
        const result = resolveProjectLibraryConfiguration({
            workspaceFolderPath: pathApi === path.win32 ? 'C:\\repo' : '/repo', profileId: 'active',
            buildParameters: [{ key: 'Libraries', value: pathApi === path.win32 ? 'C:\\Steps|D:\\Exports' : 'steps|exports' }],
            additionalVanessaParameters: [], pathApi
        });
        assert.deepEqual(result.libraryRootPaths, pathApi === path.win32 ? ['C:\\Steps', 'D:\\Exports'] : ['/repo/steps', '/repo/exports']);
    }
});

test('an explicitly empty Libraries suppresses VanessaLibraries like the compiler does', () => {
    const result = resolveProjectLibraryConfiguration({ workspaceFolderPath: '/repo', profileId: 'active',
        buildParameters: [{ key: 'VanessaLibraries', value: 'old' }, { key: 'Libraries', value: '' }],
        additionalVanessaParameters: [] });
    assert.deepEqual(result.libraryRootPaths, []);
});

test('a colon in a single POSIX library folder remains part of its name', () => {
    const result = resolveProjectLibraryConfiguration({ workspaceFolderPath: '/repo', profileId: 'active',
        buildParameters: [{ key: 'Libraries', value: 'steps:shared' }], additionalVanessaParameters: [], pathApi: path.posix });
    assert.deepEqual(result.libraryRootPaths, ['/repo/steps:shared']);
});

test('Additional cannot replace the automatic compiler library catalog without priority even if Libraries was removed', () => {
    const result = resolveProjectLibraryConfiguration({ workspaceFolderPath: '/repo', profileId: 'active', buildParameters: [],
        additionalVanessaParameters: [{ key: 'librarycatalogs', value: '["ignored"]', overrideExisting: false }] });
    assert.deepEqual(result.libraryRootPaths, []);
});

test('Additional library catalogs respect priority against the SPPR library list, including an empty override', () => {
    const input = { workspaceFolderPath: '/repo', profileId: 'active',
        buildParameters: [{ key: 'Libraries', value: 'steps|exports' }] };
    const withoutPriority = resolveProjectLibraryConfiguration({ ...input,
        additionalVanessaParameters: [{ key: 'librarycatalogs', value: '["ignored"]', overrideExisting: false }] });
    assert.deepEqual(withoutPriority.libraryRootPaths, ['/repo/steps', '/repo/exports']);
    const emptyOverride = resolveProjectLibraryConfiguration({ ...input,
        additionalVanessaParameters: [{ key: 'librarycatalogs', value: '[]', overrideExisting: true }] });
    assert.deepEqual(emptyOverride.libraryRootPaths, []);
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

test('Libraries takes priority over VanessaLibraries including an explicitly empty value', () => {
    const libraries = resolveProjectLibraryConfiguration({
        workspaceFolderPath: '/repo',
        profileId: 'active',
        buildParameters: [
            { key: 'Libraries', value: 'libraries/one|libraries/two' },
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
    assert.deepEqual(vanessaLibraries.libraryRootPaths, []);
});

test('keeps Windows drive and UNC roots absolute and removes duplicates case-insensitively', () => {
    const result = resolveProjectLibraryConfiguration({
        workspaceFolderPath: 'C:\\repo',
        profileId: 'active',
        buildParameters: [{
            key: 'Libraries',
            value: 'C:\\Libraries|\\\\server\\share\\steps|c:\\libraries'
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
            value: '#SourcesPath/libs|#Libraries/shared|#Unknown/missing'
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
        buildParameters: [{ key: 'Libraries', value: '#Missing/a|#Missing/a' }],
        additionalVanessaParameters: [],
        pathApi: path.posix
    };

    const first = resolveProjectLibraryConfiguration(input);
    const second = resolveProjectLibraryConfiguration(input);

    assert.equal(first.warnings.length, 1);
    assert.equal(first.identity, second.identity);
});
