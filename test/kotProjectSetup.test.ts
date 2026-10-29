import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { parseTestSettingsTarget } from '../src/scenarioDescriptor';
import { inspectSetupProject, applySetupFiles, planNewProject, suggestSetupRoots, validateSetupSourceRoot, assertPrimarySetupFolder, selectSetupExample } from '../src/kotProjectSetup';
import { deferProjectSetup, completeProjectSetup, isProjectSetupPending } from '../src/projectSetupGate';

async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-setup-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    async function put(relative: string, text: string) { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
    return { root, put };
}

test('setup discovery reads pairs once, separates export libraries and excludes generated and symlink trees without writing', async t => {
    const f = await fixture(t);
    await f.put('tests/native/meta.yaml', 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: abc\n');
    await f.put('tests/native/scen.feature', '#language: en\nAnd Delay 1\n');
    await f.put('tests/plain.json', '{"ЯзыкГенератораGherkin":"en"}');
    await f.put('tests/plain.feature', '#language: en\nFeature: Smoke\nScenario: One\n    And Delay 1\n');
    await f.put('libraries/steps.feature', '#language: en\n@ExportScenarios\nFeature: Library\nScenario: Shared\n    And Delay 1\n');
    await f.put('.vscode/kot-runtime/generated.feature', 'Feature: Generated\n');
    await f.put('node_modules/ignored.feature', 'Feature: Ignore\n');
    await fs.symlink(path.join(f.root, 'tests'), path.join(f.root, 'alias'), 'dir');
    const before = await fs.readdir(path.join(f.root, 'tests/native'));
    const result = await inspectSetupProject(f.root);
    assert.equal(result.sppr.length, 1); assert.equal(result.features.length, 1); assert.equal(result.libraries.length, 1);
    assert.equal(result.launchJson.length, 1);
    assert.equal(result.sppr[0], 'tests/native/meta.yaml');
    assert.equal(selectSetupExample(result, 'sppr'), 'tests/native/scen.feature');
    assert.equal(selectSetupExample(result, 'vanessa'), 'tests/plain.feature');
    assert.deepEqual(await fs.readdir(path.join(f.root, 'tests/native')), before);
    assert.equal(result.truncated, false);
});

test('cancelled inspection stops before creating any project data', async t => {
    const f = await fixture(t);
    await assert.rejects(inspectSetupProject(f.root, { cancelled: () => true }), /cancel/i);
    assert.deepEqual(await fs.readdir(f.root), []);
});

test('inspection reaches deeply nested test sources without spending its file budget on configuration files', async t => {
    const f = await fixture(t);
    for (let index = 0; index < 20; index++) { await f.put(`cf/Catalogs/Item${index}/Ext/Module.bsl`, '// configuration source'); }
    const scenario = `tests/${Array.from({ length: 15 }, (_, index) => `group${index}`).join('/')}/scen.yaml`;
    await f.put(scenario, 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: deep-scenario\n');
    const result = await inspectSetupProject(f.root, { maxFiles: 1 });
    assert.equal(result.truncated, false);
    assert.deepEqual(result.sppr, [scenario]);
});

test('inspection skips nested 1C configuration exports but keeps tests beside a workspace-root configuration', async t => {
    const f = await fixture(t);
    const configuration = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Configuration/></MetaDataObject>';
    await f.put('Configuration.xml', configuration);
    await f.put('cf/Configuration.xml', configuration);
    await f.put('cf/CommonTemplates/Example/Template.feature', 'Feature: Configuration attachment\n');
    await f.put('tests/smoke.feature', 'Feature: Project test\n');
    const result = await inspectSetupProject(f.root, { maxFiles: 1 });
    assert.equal(result.truncated, false);
    assert.deepEqual(result.features, ['tests/smoke.feature']);
});

test('inspection still reports an incomplete scan when actual candidate files exceed its budget', async t => {
    const f = await fixture(t);
    await f.put('tests/one.feature', 'Feature: One\n');
    await f.put('tests/two.feature', 'Feature: Two\n');
    const partial = await inspectSetupProject(f.root, { maxFiles: 1 });
    assert.equal(partial.truncated, true);
    assert.equal(partial.features.length, 1);
    const complete = await inspectSetupProject(f.root, { maxFiles: 2 });
    assert.equal(complete.truncated, false);
    assert.deepEqual(complete.features, ['tests/one.feature', 'tests/two.feature']);
    assert.notEqual(partial.token, complete.token);
});

test('inspection fingerprint detects changed test sources without tracking unrelated configuration edits', async t => {
    const f = await fixture(t);
    await f.put('cf/Catalogs/Item.xml', '<Catalog/>');
    await f.put('tests/smoke.feature', 'Feature: Smoke\n');
    const initial = await inspectSetupProject(f.root);
    await f.put('cf/Catalogs/Item.xml', '<Catalog changed="true"/>');
    assert.equal((await inspectSetupProject(f.root)).token, initial.token);
    await f.put('tests/smoke.feature', 'Feature: Changed\n');
    assert.notEqual((await inspectSetupProject(f.root)).token, initial.token);
});

test('new project plan is explicit and cannot overwrite existing or newly edited files', async t => {
    const f = await fixture(t); const plan = planNewProject('vanessa', 'en', 'native');
    assert.ok(plan.some(file => file.path === 'tests/first.feature'));
    await applySetupFiles(f.root, plan);
    const first = await fs.readFile(path.join(f.root, 'tests/first.feature'), 'utf8');
    await assert.rejects(applySetupFiles(f.root, plan), /exist|changed/i);
    assert.equal(await fs.readFile(path.join(f.root, 'tests/first.feature'), 'utf8'), first);
    await assert.rejects(applySetupFiles(f.root, [{ path: '../outside.txt', text: 'no' }]), /outside/i);
});

test('a deferred project is isolated from sibling roots and explicit completion releases only that project', async t => {
    const f = await fixture(t); const other = path.join(f.root, 'other');
    deferProjectSetup(f.root); deferProjectSetup(other);
    assert.equal(isProjectSetupPending(path.join(f.root, 'tests')), true);
    completeProjectSetup(other);
    assert.equal(isProjectSetupPending(other), false); assert.equal(isProjectSetupPending(f.root), true);
    completeProjectSetup(f.root); assert.equal(isProjectSetupPending(f.root), false);
});

test('new SPPR project creates a launch setting linked to its scenario UID', () => {
    const files = planNewProject('sppr', 'en', 'native');
    const metadata = parse(files.find(file => file.path.endsWith('meta.yaml'))!.text);
    const setting = parseTestSettingsTarget(files.find(file => file.path.includes('/test/'))!.text);
    assert.equal(setting?.kind, 'scenario'); assert.equal(setting?.uid, metadata.ДанныеСценария.UID);
    assert.equal(metadata.ПараметрыСценария[0].ПараметрыСценария1.Имя, 'Customer');
    const child = parse(files.find(file => file.path.includes('prepare-customer/') && file.path.endsWith('meta.yaml'))!.text);
    assert.equal(metadata.ВложенныеСценарии[0].ВложенныеСценарии1.UIDВложенныйСценарий, child.ДанныеСценария.UID);
    assert.match(files.find(file => file.path === 'tests/first-scenario/scen.feature')!.text, /Customer = "\[Customer\]"/);
});

test('existing Vanessa sources suggest their actual folder and reject an unrelated selected root', async t => {
    const f = await fixture(t); await f.put('features/smoke.feature', 'Feature: Smoke\nScenario: One\n    And Delay 1\n');
    const inspection = await inspectSetupProject(f.root);
    assert.equal(suggestSetupRoots(inspection, 'vanessa').sources, 'features');
    assert.throws(() => validateSetupSourceRoot(inspection, 'vanessa', 'tests'), /does not contain/i);
    assert.doesNotThrow(() => validateSetupSourceRoot(inspection, 'vanessa', 'features'));
});

test('wizard cannot activate a global build profile from a secondary workspace folder', () => {
    assert.throws(() => assertPrimarySetupFolder('second', 'first'), /own window/i);
    assert.doesNotThrow(() => assertPrimarySetupFolder('first', 'first'));
});
