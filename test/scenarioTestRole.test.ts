import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { convertScenarioTestRole } from '../src/scenarioTestRole';

async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-test-role-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, 'tests', 'own', 'meta.yaml');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "own"\n');
    const settingsPaths = [path.join(root, 'tests', 'a.yaml'), path.join(root, 'tests', 'b.yaml')];
    for (const [index, file] of settingsPaths.entries()) { await fs.writeFile(file, `ТипФайла: "НастройкаТеста"\nДанныеТеста:\n    UIDСценария: "own"\n    Код: "${index}"\n`); }
    return { root, sourcePath, settingsPaths, uid: 'own', kind: 'scenario' as const, assertCurrent: async () => {} };
}

test('role conversion archives all launch settings reversibly without changing source identity or content', async t => {
    const f = await fixture(t); const before = await fs.readFile(f.sourcePath, 'utf8');
    assert.equal(await convertScenarioTestRole({ ...f, targetMain: false }), 'archived');
    for (const file of f.settingsPaths) { await assert.rejects(fs.access(file)); }
    assert.equal(await fs.readFile(f.sourcePath, 'utf8'), before);
    assert.equal(await convertScenarioTestRole({ ...f, settingsPaths: [], targetMain: true }), 'restored');
    for (const file of f.settingsPaths) { assert.match(await fs.readFile(file, 'utf8'), /UIDСценария: "own"/u); }
    assert.equal(await fs.readFile(f.sourcePath, 'utf8'), before);
});

test('promotion without archived settings requests the creation wizard and existing main tests remain unchanged', async t => {
    const f = await fixture(t);
    assert.equal(await convertScenarioTestRole({ ...f, targetMain: true }), 'unchanged');
    assert.equal(await convertScenarioTestRole({ ...f, settingsPaths: [], targetMain: true }), 'needsSettings');
});

test('restore collisions preserve both the archive and authored destination', async t => {
    const f = await fixture(t); await convertScenarioTestRole({ ...f, targetMain: false });
    await fs.writeFile(f.settingsPaths[1], 'external edit');
    await assert.rejects(convertScenarioTestRole({ ...f, settingsPaths: [], targetMain: true }), /exist|collision/iu);
    assert.equal(await fs.readFile(f.settingsPaths[1], 'utf8'), 'external edit');
    await assert.rejects(fs.access(f.settingsPaths[0]));
    await fs.unlink(f.settingsPaths[1]);
    assert.equal(await convertScenarioTestRole({ ...f, settingsPaths: [], targetMain: true }), 'restored');
});

test('a changed source aborts demotion and restores already moved settings', async t => {
    const f = await fixture(t); let checks = 0;
    await assert.rejects(convertScenarioTestRole({ ...f, targetMain: false, assertCurrent: async () => {
        if (++checks === 3) { throw new Error('source changed'); }
    } }), /changed/u);
    for (const file of f.settingsPaths) { assert.match(await fs.readFile(file, 'utf8'), /UIDСценария/u); }
});

test('Parallels EINVAL links allow reversible main and nested role conversion', async t => {
    const f = await fixture(t);
    const before = await Promise.all([f.sourcePath, ...f.settingsPaths].map(file => fs.readFile(file)));
    t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' }); });
    assert.equal(await convertScenarioTestRole({ ...f, targetMain: false }), 'archived');
    for (const file of f.settingsPaths) { await assert.rejects(fs.access(file), { code: 'ENOENT' }); }
    assert.equal(await convertScenarioTestRole({ ...f, settingsPaths: [], targetMain: true }), 'restored');
    assert.deepEqual(await Promise.all([f.sourcePath, ...f.settingsPaths].map(file => fs.readFile(file))), before);
    await assert.rejects(fs.access(path.join(f.root, '.kot', 'launch-settings', 'scenario-own')), { code: 'ENOENT' });
});

test('Parallels role conversion restores settings when a later move is aborted', async t => {
    const f = await fixture(t); let checks = 0;
    const before = await Promise.all(f.settingsPaths.map(file => fs.readFile(file)));
    t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' }); });
    await assert.rejects(convertScenarioTestRole({ ...f, targetMain: false, assertCurrent: async () => {
        if (++checks === 3) { throw new Error('source changed'); }
    } }), /source changed/u);
    assert.deepEqual(await Promise.all(f.settingsPaths.map(file => fs.readFile(file))), before);
    await assert.rejects(fs.access(path.join(f.root, '.kot', 'launch-settings', 'scenario-own')), { code: 'ENOENT' });
});

test('copy fallback does not overwrite a concurrently created settings archive', async t => {
    const f = await fixture(t); const before = await fs.readFile(f.settingsPaths[0]);
    t.mock.method(fs, 'link', async (_from: string, to: string) => {
        await fs.writeFile(to, 'external settings', { flag: 'wx' });
        throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' });
    });
    await assert.rejects(convertScenarioTestRole({ ...f, targetMain: false }), { code: 'EEXIST' });
    assert.deepEqual(await fs.readFile(f.settingsPaths[0]), before);
    assert.equal(await fs.readFile(path.join(f.root, '.kot', 'launch-settings', 'scenario-own', '0.settings.disabled'), 'utf8'), 'external settings');
});

test('copy fallback removes its destination if the original settings cannot be removed', async t => {
    const f = await fixture(t); const before = await fs.readFile(f.settingsPaths[0]); const unlink = fs.unlink;
    t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' }); });
    t.mock.method(fs, 'unlink', async (file: Parameters<typeof fs.unlink>[0]) => {
        if (file === f.settingsPaths[0]) { throw Object.assign(new Error('settings locked'), { code: 'EBUSY' }); }
        return unlink(file);
    });
    await assert.rejects(convertScenarioTestRole({ ...f, targetMain: false }), { code: 'EBUSY' });
    assert.deepEqual(await fs.readFile(f.settingsPaths[0]), before);
    await assert.rejects(fs.access(path.join(f.root, '.kot', 'launch-settings', 'scenario-own')), { code: 'ENOENT' });
});
