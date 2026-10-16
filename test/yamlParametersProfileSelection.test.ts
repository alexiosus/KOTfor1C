import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import * as activeProfiles from '../src/activeYamlParametersProfile';
import * as defaults from '../src/yamlParameterDefaults';
import * as compilerParameters from '../src/compilerBuildParameters';
import * as compilerValueValidation from '../src/compilerBuildValueValidation';
import * as vanessaCatalog from '../src/vanessaParameterCatalog';

test('retrieves a frozen selected profile without changing active selection, secrets or scan root', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/yamlParametersManager.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const saved = JSON.stringify({ version: 4, activeProfileId: 'one', profiles: [
        { id: 'one', name: 'Current', buildParameters: [{ key: 'ScenarioFolder', value: 'tests' }], additionalVanessaParameters: [], globalVanessaVariables: [] },
        { id: 'two', name: 'Selected', buildParameters: [{ key: 'ScenarioFolder', value: 'other' }], additionalVanessaParameters: [{ key: 'Custom', value: '42', overrideExisting: true }], globalVanessaVariables: [{ key: 'Mode', value: 'QA', overrideExisting: false }] }
    ] });
    let writes = 0;
    let rootUpdates = 0;
    const context = { subscriptions: [], secrets: { get: async () => saved, store: async () => { writes++; } } };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject, exports: moduleObject.exports, console, Buffer,
        require: (specifier: string) => {
            if (specifier === 'vscode') { return { EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }, workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) } }; }
            if (specifier === './appContext') { return { getExtensionUri: () => ({ fsPath: '/extension' }) }; }
            if (specifier === './scenarioScanRoot') { return { updateScenarioScanRoot: async () => { rootUpdates++; }, getScenarioScanRootPath: () => 'tests/' }; }
            if (specifier === './etalonBases') { return { getDefaultModelDbSettingsValue: () => 'model.yaml' }; }
            if (specifier === './yamlParameterDefaults') { return defaults; }
            if (specifier === './compilerBuildParameters') { return compilerParameters; }
            if (specifier === './compilerBuildValueValidation') { return compilerValueValidation; }
            if (specifier === './activeYamlParametersProfile') { return activeProfiles; }
            if (specifier === './vanessaParameterCatalog.js') { return vanessaCatalog; }
            return require(specifier);
        }
    });
    const Manager = moduleObject.exports.YamlParametersManager as { getInstance(context: unknown): { loadProfileSnapshot(id: string): Promise<activeProfiles.ActiveYamlParametersProfile | undefined>; getProfilesSummary(): Promise<{ activeProfileId: string }> } };
    const manager = Manager.getInstance(context);
    assert.equal(typeof manager.loadProfileSnapshot, 'function');
    const profile = await manager.loadProfileSnapshot('two');
    assert.equal(profile?.name, 'Selected');
    assert.equal(profile?.buildParameters.find(item => item.key === 'ScenarioFolder')?.value, 'other');
    assert.equal(profile?.additionalVanessaParameters[0].value, '42');
    assert.equal(profile?.globalVanessaVariables[0].value, 'QA');
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(await manager.loadProfileSnapshot('missing'), undefined);
    assert.equal((await manager.getProfilesSummary()).activeProfileId, 'one');
    assert.equal(writes, 0);
    assert.equal(rootUpdates, 0);
});

test('profile picker opens immediately and selected tables update before the artifact rebuild completes', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/yamlParametersManager.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const profiles = [
        { id: 'one', name: 'Current', buildParameters: [{ key: 'ScenarioFolder', value: 'tests' }], additionalVanessaParameters: [], globalVanessaVariables: [] },
        { id: 'two', name: 'Selected', buildParameters: [{ key: 'ScenarioFolder', value: 'other' }], additionalVanessaParameters: [], globalVanessaVariables: [] }
    ];
    let saved = JSON.stringify({ version: 4, activeProfileId: 'one', profiles });
    let writes = 0; let pickerShown = false; let rebuilds = 0;
    let releaseRebuild = () => {};
    const rebuildGate = new Promise<void>(resolve => { releaseRebuild = resolve; });
    const messages: any[] = [];
    const context = { subscriptions: [], secrets: { get: async () => saved, store: async (_key: string, value: string) => { writes++; saved = value; } } };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject, exports: moduleObject.exports, console, Buffer,
        require: (specifier: string) => {
            if (specifier === 'vscode') { return {
                EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }, QuickPickItemKind: { Separator: -1 },
                env: { language: 'en' }, l10n: { t: (value: string) => value },
                workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
                window: { showQuickPick: async () => { pickerShown = true; return { action: 'select', profileId: 'two' }; } },
                commands: { executeCommand: async (command: string) => { if (command.endsWith('refreshCombinedRunJsonArtifacts')) { rebuilds++; await rebuildGate; } } }
            }; }
            if (specifier === './appContext') { return { getExtensionUri: () => ({ fsPath: '/extension' }) }; }
            if (specifier === './scenarioScanRoot') { return { updateScenarioScanRoot: async () => false, updateProcessScanRoot: async () => false, getScenarioScanRootPath: () => 'tests/' }; }
            if (specifier === './etalonBases') { return { getDefaultModelDbSettingsValue: () => 'model.yaml' }; }
            if (specifier === './yamlParameterDefaults') { return defaults; }
            if (specifier === './compilerBuildParameters') { return compilerParameters; }
            if (specifier === './compilerBuildValueValidation') { return compilerValueValidation; }
            if (specifier === './activeYamlParametersProfile') { return activeProfiles; }
            if (specifier === './vanessaParameterCatalog.js') { return vanessaCatalog; }
            return require(specifier);
        }
    });
    const Manager = moduleObject.exports.YamlParametersManager as any;
    const manager = Manager.getInstance(context);
    manager.syncYamlSourceDirectorySettingFromBuildParameters = async () => false;
    profiles[0].buildParameters[0].value = 'unsaved-edit';
    const operation = manager.manageProfiles({ webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } }, { activeProfileId: 'one', profiles });
    await new Promise(resolve => setImmediate(resolve));
    try {
        assert.equal(pickerShown, true, 'derived artifacts must not delay opening the native profile picker');
        assert.equal(messages.at(-1)?.activeProfileId, 'two', 'selected profile must render while artifact generation is pending');
        assert.equal(JSON.parse(saved).profiles[0].buildParameters.find((item: any) => item.key === 'ScenarioFolder').value, 'unsaved-edit');
        assert.equal(writes, 1, 'one profile transaction preserves edits and selection in one write');
        assert.equal(rebuilds, 1, 'the transaction generates combined artifacts once');
    } finally {
        releaseRebuild(); await operation;
    }
});

test('profile response keeps edits typed while the picker was open and leaves them pending for autosave', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'media/yamlParameters.js'), 'utf8');
    const start = script.indexOf('    function applyProfilesResponse(');
    const end = script.indexOf('    function manageProfiles(', start);
    assert.ok(start >= 0 && end > start, 'the profile transaction must merge its response with later edits');
    const base = { id: 'one', name: 'Current', buildParameters: [{ key: 'ScenarioFolder', value: 'before' }], additionalVanessaParameters: [], globalVanessaVariables: [] };
    const current = { ...base, buildParameters: [{ key: 'ScenarioFolder', value: 'typed-during-picker' }] };
    const context: any = {
        pendingProfileRequest: { id: 'switch-1', profiles: [base] }, profiles: [], activeProfileId: 'one',
        getCurrentState: () => ({ activeProfileId: 'one', profiles: [current] })
    };
    const apply = vm.runInNewContext(`${script.slice(start, end)}\napplyProfilesResponse`, context);
    assert.equal(apply({ requestId: 'switch-1', activeProfileId: 'two', profiles: [base, { ...base, id: 'two', name: 'Selected' }] }), true);
    assert.equal(context.activeProfileId, 'two');
    assert.equal(context.profiles[0].buildParameters[0].value, 'typed-during-picker');
    assert.equal(context.profiles[1].name, 'Selected');
    assert.equal(context.pendingProfileRequest, null);
});

test('a profile selection cannot be overwritten by an earlier autosave finishing late', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/yamlParametersManager.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const profiles = ['one', 'two'].map(id => ({ id, name: id, buildParameters: [], additionalVanessaParameters: [], globalVanessaVariables: [] }));
    let saved = JSON.stringify({ version: 4, activeProfileId: 'one', profiles });
    let storesStarted = 0; let releaseFirstStore = () => {};
    const gate = new Promise<void>(resolve => { releaseFirstStore = resolve; });
    const context = { subscriptions: [], secrets: { get: async () => saved, store: async (_key: string, value: string) => { if (++storesStarted === 1) { await gate; } saved = value; } } };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject, exports: moduleObject.exports, console, Buffer,
        require: (specifier: string) => {
            if (specifier === 'vscode') { return { EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }, workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) } }; }
            if (specifier === './appContext') { return { getExtensionUri: () => ({ fsPath: '/extension' }) }; }
            if (specifier === './scenarioScanRoot') { return { updateScenarioScanRoot: async () => false, getScenarioScanRootPath: () => 'tests/' }; }
            if (specifier === './etalonBases') { return { getDefaultModelDbSettingsValue: () => 'model.yaml' }; }
            if (specifier === './yamlParameterDefaults') { return defaults; }
            if (specifier === './compilerBuildParameters') { return compilerParameters; }
            if (specifier === './compilerBuildValueValidation') { return compilerValueValidation; }
            if (specifier === './activeYamlParametersProfile') { return activeProfiles; }
            return require(specifier);
        }
    });
    const Manager = moduleObject.exports.YamlParametersManager as any;
    const manager = Manager.getInstance(context);
    const earlierAutosave = manager.saveParametersState({ activeProfileId: 'one', profiles });
    const profileSelection = manager.saveParametersState({ activeProfileId: 'two', profiles });
    await new Promise(resolve => setImmediate(resolve));
    releaseFirstStore(); await Promise.all([earlierAutosave, profileSelection]);
    assert.equal(JSON.parse(saved).activeProfileId, 'two');
});
