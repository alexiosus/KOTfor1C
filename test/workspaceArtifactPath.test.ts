import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    collectScenarioArtifactPaths,
    resolveWorkspaceOwnedPath
} from '../src/workspaceArtifactPath';

const LEGACY_SCENARIO_ARTIFACT_MANIFEST_FILE = '.kot-build-manifest.json';

test('maps a foreign Windows artifact folder back into the current macOS workspace', () => {
    assert.equal(
        resolveWorkspaceOwnedPath(
            '/Users/alexeremeev/Development/1cDrive',
            'c:\\Mac\\Home\\Development\\1cDrive\\.vscode\\kot-runtime\\tests',
            'darwin'
        ),
        '/Users/alexeremeev/Development/1cDrive/.vscode/kot-runtime/tests'
    );
});

test('keeps native absolute and workspace-relative artifact folders unchanged', () => {
    assert.equal(
        resolveWorkspaceOwnedPath('/workspace/project', '/tmp/artifacts', 'darwin'),
        '/tmp/artifacts'
    );
    assert.equal(
        resolveWorkspaceOwnedPath('/workspace/project', '.vscode/kot-runtime/tests', 'darwin'),
        '/workspace/project/.vscode/kot-runtime/tests'
    );
});

test('does not guess a foreign path that does not contain the current workspace name', () => {
    assert.equal(
        resolveWorkspaceOwnedPath(
            '/Users/alexeremeev/Development/1cDrive',
            'c:\\BuildAgent\\other-project\\artifacts',
            'darwin'
        ),
        null
    );
});

test('collects feature and json artifacts from hidden runtime directories without workspace search', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-artifacts-'));
    try {
        const artifactRoot = path.join(root, '.vscode', 'kot-runtime', 'tests', 'EtalonDrive');
        await fs.mkdir(path.join(artifactRoot, 'scenario', 'Files'), { recursive: true });
        await Promise.all([
            fs.writeFile(path.join(artifactRoot, 'BOM_status_stability.feature'), ''),
            fs.writeFile(path.join(artifactRoot, 'BOM_status_stability.json'), '{}'),
            fs.writeFile(path.join(artifactRoot, LEGACY_SCENARIO_ARTIFACT_MANIFEST_FILE), '{}'),
            fs.writeFile(path.join(artifactRoot, 'scenario', 'Files', 'BOM_List.mxl'), ''),
            fs.writeFile(path.join(artifactRoot, 'notes.txt'), '')
        ]);

        const result = await collectScenarioArtifactPaths(path.join(root, '.vscode', 'kot-runtime', 'tests'));

        assert.deepEqual(result.featurePaths, [
            path.join(artifactRoot, 'BOM_status_stability.feature')
        ]);
        assert.deepEqual(result.jsonPaths, [
            path.join(artifactRoot, 'BOM_status_stability.json')
        ]);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
