import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectCompilerModelDbStatus } from '../src/compilerModelDbStatus';
import { stringifyEtalonBasesYaml, getDefaultModelDbSettingsValue } from '../src/etalonBases';

test('model DB default follows a customized runtime directory', () => {
    assert.equal(getDefaultModelDbSettingsValue('artifacts/kot'), path.join('artifacts/kot', 'bases.yaml'));
});

test('model DB health distinguishes blank, missing, invalid, empty and usable files without returning credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-model-db-health-'));
    const parameters = [{ key: 'ModelDBSettings', value: 'bases.yaml' }];
    try {
        assert.equal((await inspectCompilerModelDbStatus([{ key: 'ModelDBSettings', value: '' }], root)).state, 'unconfigured');
        assert.equal((await inspectCompilerModelDbStatus(parameters, root)).state, 'missing');
        await fs.writeFile(path.join(root, 'bases.yaml'), 'Пароль: [unterminated-secret');
        const invalid = await inspectCompilerModelDbStatus(parameters, root);
        assert.equal(invalid.state, 'invalid');
        assert.equal(JSON.stringify(invalid).includes('secret'), false);
        await fs.writeFile(path.join(root, 'bases.yaml'), 'ЭталонныеБД:\n');
        assert.equal((await inspectCompilerModelDbStatus(parameters, root)).state, 'empty');
        await fs.writeFile(path.join(root, 'bases.yaml'), stringifyEtalonBasesYaml([
            { name: 'Demo', databaseId: 'demo', dtFilePath: '', userProfiles: [{ profileName: 'Administrator', login: 'private-login', password: 'private-secret' }] }
        ]));
        const healthy = await inspectCompilerModelDbStatus(parameters, root);
        assert.equal(healthy.state, 'ready');
        assert.equal(healthy.baseCount, 1);
        assert.equal(healthy.profileCount, 1);
        assert.equal(JSON.stringify(healthy).includes('private-'), false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('model DB health reports missing selected base and bases without profiles', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-model-db-selection-'));
    const parameters = [{ key: 'ModelDBSettings', value: 'bases.yaml' }];
    try {
        await fs.writeFile(path.join(root, 'bases.yaml'), stringifyEtalonBasesYaml([
            { name: 'Empty', databaseId: 'empty', dtFilePath: '', userProfiles: [] }
        ]));
        const noProfiles = await inspectCompilerModelDbStatus(parameters, root);
        assert.equal(noProfiles.state, 'noProfiles');
        assert.equal(noProfiles.basesWithoutProfiles, 1);
        const missing = await inspectCompilerModelDbStatus([...parameters, { key: 'ModelDBid', value: 'missing' }], root);
        assert.equal(missing.state, 'selectedBaseMissing');
        await fs.writeFile(path.join(root, 'bases.yaml'), 'Unrelated: true');
        assert.equal((await inspectCompilerModelDbStatus(parameters, root)).state, 'invalid');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
