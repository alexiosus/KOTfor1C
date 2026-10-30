import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as activeProfiles from '../src/activeYamlParametersProfile';
import * as defaults from '../src/yamlParameterDefaults';
import * as compilerParameters from '../src/compilerBuildParameters';
import * as compilerValueValidation from '../src/compilerBuildValueValidation';
import * as libraries from '../src/projectLibraryRoots';

function harness(empty = false) {
    let stored: string | undefined = empty ? undefined : JSON.stringify({ version: 5, activeProfileId: 'one', profiles: [
        { id: 'one', name: 'Current', buildParameters: [{ key: 'Libraries', value: '' }],
            additionalVanessaParameters: [{ key: 'librarycatalogs', value: '[]', overrideExisting: true }], globalVanessaVariables: [] },
        { id: 'two', name: 'Other', buildParameters: [], additionalVanessaParameters: [], globalVanessaVariables: [] }
    ] });
    const initial = stored; const events: unknown[] = []; let writes = 0;
    const context = { subscriptions: [], secrets: { get: async () => stored,
        store: async (_key: string, value: string) => { stored = value; writes++; }, delete: async () => { stored = undefined; writes++; } } };
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    const dependencies: Record<string, unknown> = {
        vscode: { EventEmitter: class { event = () => ({ dispose() {} }); fire(value: unknown) { events.push(value); } },
            workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) }, l10n: { t: (text: string) => text } },
        './appContext': { getExtensionUri: () => ({ fsPath: '/extension' }) },
        './scenarioScanRoot': { getScenarioScanRootPath: () => 'tests/' },
        './etalonBases': { getDefaultModelDbSettingsValue: () => 'model.yaml' }, './yamlParameterDefaults': defaults,
        './compilerBuildParameters': compilerParameters, './compilerBuildValueValidation': compilerValueValidation,
        './activeYamlParametersProfile': activeProfiles, './projectLibraryRoots.js': libraries
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/yamlParametersManager.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, Buffer, console, require: (name: string) => dependencies[name] ?? require(name) });
    return { manager: module.exports.YamlParametersManager.getInstance(context), initial, events, writes: () => writes,
        saved: () => stored, replace: (value: string) => { stored = value; } };
}

test('export conversion persists effective library settings and notifies only after files succeed', async () => {
    const h = harness(); const before = await h.manager.loadActiveProfileSnapshot();
    assert.equal(await h.manager.withProjectLibraryFolder('one', '/repo', '/repo/exports', async () => {
        const profile = await h.manager.loadActiveProfileSnapshot();
        assert.deepEqual(libraries.resolveProjectLibraryConfiguration({ workspaceFolderPath: '/repo', profileId: profile.id, ...profile }).libraryRootPaths, ['/repo/exports']);
        assert.equal(h.events.length, 0); return 'converted';
    }), 'converted');
    assert.equal(h.events.length, 1);
    const stored = JSON.parse(h.saved()!);
    assert.equal(stored.activeProfileId, before.id);
    assert.equal(stored.profiles[1].name, 'Other');
    const writes = h.writes();
    await h.manager.withProjectLibraryFolder('one', '/repo', '/repo/exports/child', async () => {});
    assert.equal(h.writes(), writes, 'already indexed descendants do not rewrite the profile');
});

test('failed file conversion restores the exact original profile, including absent storage', async () => {
    for (const empty of [false, true]) {
        const h = harness(empty); const profile = await h.manager.loadActiveProfileSnapshot();
        await assert.rejects(h.manager.withProjectLibraryFolder(profile.id, '/repo', '/repo/exports', async () => { throw new Error('file collision'); }), /file collision/u);
        assert.equal(h.saved(), h.initial);
        assert.equal(h.events.length, 0);
    }
});

test('changed profile selection cancels conversion before writing files or settings', async () => {
    const h = harness(); let ran = false;
    await assert.rejects(h.manager.withProjectLibraryFolder('two', '/repo', '/repo/exports', async () => { ran = true; }), /active build profile changed/u);
    assert.equal(ran, false); assert.equal(h.writes(), 0); assert.equal(h.saved(), h.initial);
});

test('failed conversion preserves an externally changed profile instead of overwriting it on rollback', async () => {
    const h = harness(); const external = JSON.stringify({ external: 'new settings' });
    await assert.rejects(h.manager.withProjectLibraryFolder('one', '/repo', '/repo/exports', async () => {
        h.replace(external); throw new Error('file conflict');
    }), /current settings were preserved/u);
    assert.equal(h.saved(), external); assert.equal(h.events.length, 0);
});
