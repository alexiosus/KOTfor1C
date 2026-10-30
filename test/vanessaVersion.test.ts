import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    extractVanessaVersionFromChangelog,
    getVanessaChangelogPath,
    normalizeVanessaVersion,
    resolveWorkspaceSettingPath
} from '../src/vanessaVersion';

test('extracts the first four-part version from BOM and CRLF changelog text', () => {
    assert.equal(
        extractVanessaVersionFromChangelog('\uFEFF# История\r\n\r\n## 1.2.043.28\r\n## 1.2.043.27'),
        '1.2.043.28'
    );
});

test('version normalization accepts a leading v and rejects partial or decorated versions', () => {
    assert.equal(normalizeVanessaVersion(' v1.2.043.28 '), '1.2.043.28');
    assert.equal(normalizeVanessaVersion('1.2.43'), null);
    assert.equal(normalizeVanessaVersion('release-1.2.043.28'), null);
});

test('changelog parser ignores inline references and three-part headings', () => {
    assert.equal(
        extractVanessaVersionFromChangelog('# История\nИсправлено в 1.2.043.28\n## 1.2.043\n'),
        null
    );
});

test('keeps Windows drive and UNC paths absolute under win32 rules', () => {
    assert.equal(
        resolveWorkspaceSettingPath(
            'C:\\tools\\vanessa\\vanessa-automation.epf',
            'C:\\project',
            path.win32
        ),
        'C:\\tools\\vanessa\\vanessa-automation.epf'
    );
    assert.equal(
        resolveWorkspaceSettingPath('\\\\server\\share\\vanessa.epf', 'C:\\project', path.win32),
        '\\\\server\\share\\vanessa.epf'
    );
});

test('resolves a relative EPF and changelog using one platform path implementation', () => {
    const epfPath = resolveWorkspaceSettingPath(
        'tools\\vanessa\\vanessa-automation.epf',
        'C:\\project',
        path.win32
    );
    assert.equal(epfPath, 'C:\\project\\tools\\vanessa\\vanessa-automation.epf');
    assert.equal(
        getVanessaChangelogPath(epfPath, path.win32),
        'C:\\project\\tools\\vanessa\\docs\\Changelog.md'
    );
});
