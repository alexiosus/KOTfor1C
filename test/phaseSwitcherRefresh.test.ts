import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as compilerArtifacts from '../src/compilerArtifacts';
import * as runtimeIdentity from '../src/scenarioRuntimeIdentity';
import * as compilerBuildParameters from '../src/compilerBuildParameters';
import { managedVanessaCommandParts } from '../src/vanessaControlLaunch';
import { applyVanessaManualDebugOverlay } from '../src/vanessaDebugClients';
import { ScenarioDirectoryIndex } from '../src/scenarioCatalog';
import { ScenarioRelationshipIndex } from '../src/scenarioRelationshipIndex';
import { findExportScenarioBuildCallers } from '../src/scenarioBuildDependencies';
import { createProjectDefinitionView } from '../src/projectDefinition';
import * as vanessaLaunchJson from '../src/vanessaLaunchJson';

function loadPhaseSwitcherProvider(workspaceUri: object, dependencies: Record<string, unknown> = {}): { prototype: object } {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const moduleObject = { exports: {} as Record<string, unknown> };
    const vscode = {
        EventEmitter: class {},
        workspace: { workspaceFolders: [{ uri: workspaceUri }], getWorkspaceFolder: () => ({ uri: workspaceUri }) },
        window: { activeTextEditor: undefined }
    };

    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (Object.hasOwn(dependencies, specifier)) { return dependencies[specifier]; }
            if (specifier === 'vscode') {
                return vscode;
            }
            if (specifier === 'fs') {
                return fs;
            }
            if (specifier === 'path') {
                return path;
            }
            if (specifier === 'os') {
                return os;
            }
            if (specifier === 'node:crypto') { return require(specifier); }
            if (specifier === './compilerArtifacts') { return compilerArtifacts; }
            if (specifier === './scenarioRuntimeIdentity') { return runtimeIdentity; }
            if (specifier === './deferredLoader') {
                return { createDeferredLoader: (factory: () => Promise<unknown>) => factory };
            }
            return {};
        },
        Buffer,
        console,
        process,
        setImmediate,
        setInterval,
        setTimeout,
        clearInterval,
        clearTimeout
    });

    return moduleObject.exports.PhaseSwitcherProvider as { prototype: object };
}

test('Test Manager requires linked launch settings independently of old groups and process kind', () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    assert.equal(provider.isMainScenario({ name: 'Old group only', tabName: 'Smoke', hasTestSettings: false }), false);
    assert.equal(provider.isMainScenario({ name: 'Nested process', kind: 'process', tabName: 'Smoke', hasTestSettings: false }), false);
    assert.equal(provider.isMainScenario({ name: 'Ungrouped main', hasTestSettings: true }), true);
});

test('saving a native nested script marks its compiled callers stale while leaving unrelated tests current', async () => {
    const root = { scheme: 'file', fsPath: '/workspace', toString: () => 'file:///workspace' };
    const Provider = loadPhaseSwitcherProvider(root, { './scenarioCatalog': { ScenarioDirectoryIndex },
        './scenarioRelationshipIndex': { ScenarioRelationshipIndex }, './workspaceScanner': { resolveScanDirFsPath: () => '/workspace/tests' },
        './scenarioBuildDependencies': { findExportScenarioBuildCallers } });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
    const nested = { name: 'Nested', yamlFileUri: uri('/workspace/tests/nested/meta.yaml') };
    const main = { name: 'Main', yamlFileUri: uri('/workspace/tests/main/scen.yaml'), nestedScenarioNames: ['Nested'] };
    const unrelated = { name: 'Other', yamlFileUri: uri('/workspace/tests/other/scen.yaml') };
    const catalog = { all: [nested, main, unrelated], byUri: new Map([nested, main, unrelated].map(info => [info.yamlFileUri.toString(), info])),
        byName: new Map([nested, main, unrelated].map(info => [info.name, [info]])) };
    Object.assign(provider, { getScanDirAbsolutePath: () => '/workspace/tests', isInCompilerScanRoots: (file: string) => file.startsWith('/workspace/tests/'),
        getScenarioCatalog: () => catalog, normalizeFsPathForComparison: (file: string) => file,
        _scenarioBuildArtifacts: new Map([main, unrelated].map(info => [info.yamlFileUri.toString(), {
            scenarioKey: info.yamlFileUri.toString(), scenarioName: info.name, sourceUri: info.yamlFileUri }])),
        _staleBuiltScenarioNames: new Set(), _scenarioExecutionStates: new Map(),
        getSharedArtifactKeys: (key: string) => [key], sendRunArtifactsStateToWebview() {} });
    const script = uri('/workspace/tests/nested/scen.feature');
    assert.equal(provider.shouldTrackUriForScenarioChange(script), true);
    await provider.handleScenarioSourceSaved({ uri: script });
    assert.deepEqual([...provider._staleBuiltScenarioNames], [main.yamlFileUri.toString()]);
    assert.equal(provider.shouldTrackUriForScenarioChange(uri('/outside/scen.feature')), false);
    // Libraries may be outside compiler roots and remain referenced at runtime.
    provider._staleBuiltScenarioNames.clear();
    const exported = uri('/workspace/libraries/export.feature');
    provider.setDefinitionReferenceServices({ resolver: { getView: async () => createProjectDefinitionView('export', [{
        id: 'export', kind: 'exportScenario', template: 'Export', normalizedTemplate: 'export', parameters: [], sourceLabel: 'export',
        definitionLocation: { uri: exported.toString(), range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }
    }]) }, references: { findReferencesForDefinitions: async () => new Map([['export', [{ uri: script }]]]) } });
    await provider.handleScenarioSourceSaved({ uri: exported });
    assert.deepEqual([...provider._staleBuiltScenarioNames], [main.yamlFileUri.toString()]);
});

test('generated feature Properties waits for source catalog before restoring artifact identities', async () => {
    const root = { fsPath: '/workspace' };
    const source = { toString: () => 'file:///workspace/process.yaml' };
    const Provider = loadPhaseSwitcherProvider(root, { vscode: { EventEmitter: class {},
        workspace: { getWorkspaceFolder: () => ({ uri: root }) }, Uri: { parse: (uri: string) => uri } } });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    let ready = false;
    provider._scenarioBuildArtifacts = new Map();
    provider.ensureFreshScenarioCatalog = async () => { ready = true; };
    provider.restoreScenarioBuildArtifactsFromDiskIfNeeded = async () => {
        if (ready) { provider._scenarioBuildArtifacts.set('process', { featurePath: '/workspace/own.feature', sourceUri: source }); }
    };
    provider.normalizeFilePathForComparison = (value: string) => value.toLowerCase();
    assert.equal(await provider.findSourceForCompiledFeature({ fsPath: '/workspace/own.feature' }), source.toString());
});

test('managed Test Manager run keeps authored settings and reports the confirmed MCP outcome', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-managed-test-'));
    try {
        const feature = path.join(root, 'own.feature'); const json = path.join(root, 'own.json');
        fs.writeFileSync(feature, 'Feature: own\nScenario: own\n    And Delay 1\n'); fs.writeFileSync(json, '{"ownSetting":true}');
        const Provider = loadPhaseSwitcherProvider({ fsPath: root });
        const provider = Object.create(Provider.prototype) as Record<string, any>;
        const artifact = { scenarioKey: 'own', scenarioName: 'Own', featurePath: feature, jsonPath: json };
        provider.getScenarioBuildArtifact = () => artifact;
        let launched = 0;
        provider.runScenarioInVanessaBuiltIn = async (...args: any[]) => { assert.deepEqual(JSON.parse(JSON.stringify(args[4])), { mcpPort: 9877 }); launched++; return 'started'; };
        provider.attachVanessaManagedRunner(async (request: any) => {
            assert.equal(request.filePath, feature); assert.equal(request.sourceText, fs.readFileSync(feature, 'utf8')); assert.ok(request.isCurrent());
            assert.match(request.configurationKey, /^[a-f0-9]{64}$/u);
            assert.equal(await request.launch(9877), true);
            fs.writeFileSync(json, '{"ownSetting":false}'); assert.equal(request.isCurrent(), false, 'changed launch settings invalidate the pending request');
            return 'failed';
        });
        assert.equal(await provider.runScenarioInVanessaManaged('Own', 'feature', feature, artifact), 'failed');
        assert.equal(launched, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Test Manager uses MCP by default while an explicit process setting keeps the compatibility launch', async () => {
    for (const configured of [undefined, 'process']) {
        let managed = 0; let processLaunch = 0;
        const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' }, { vscode: { EventEmitter: class {},
            workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }], getConfiguration: () => ({ get: (key: string, fallback?: unknown) => key === 'runVanessa.executionMode' ? configured ?? fallback : fallback }) },
            window: { showInformationMessage() {}, showErrorMessage() {} } } });
        const provider = Object.create(Provider.prototype) as Record<string, any>;
        const artifact = { scenarioKey: 'own', scenarioName: 'Own', featurePath: '/workspace/own.feature' };
        Object.assign(provider, { _staleBuiltScenarioNames: new Set(), _scenarioLastLaunchContexts: new Map(), t: (key: string) => key,
            isScenarioRunInProgress: () => false, pruneScenarioBuildArtifactsByCache() {}, getScenarioBuildArtifact: () => artifact,
            resolveScenarioLaunchTarget: () => ({ targetPath: artifact.featurePath, targetKind: 'feature' }), getRunOutputChannel: () => ({ clear() {}, show() {} }),
            setScenarioExecutionState() {}, outputInfo() {}, outputError() {},
            runScenarioInVanessaManaged: async () => { managed++; return 'passed'; },
            runScenarioInVanessaBuiltIn: async () => { processLaunch++; return 'started'; } });
        await provider.runScenarioInVanessa('Own', 'own');
        assert.equal(managed, configured ? 0 : 1); assert.equal(processLaunch, configured ? 1 : 0);
    }
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(manifest.contributes.configuration.find((section: any) => section.properties?.['kotTestToolkit.runVanessa.executionMode']).properties['kotTestToolkit.runVanessa.executionMode'].default, 'mcp');
});

test('Run from a compiled feature resolves its YAML source before launching', async () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const source = { toString: () => 'file:///workspace/scen.yaml' };
    const generated = { fsPath: '/workspace/generated.feature', toString: () => 'file:///workspace/generated.feature' };
    const scenario = { name: 'Own', yamlFileUri: source };
    const calls: unknown[] = [];
    provider.findSourceForCompiledFeature = async (uri: unknown) => { assert.equal(uri, generated); return source; };
    provider.restoreScenarioBuildArtifactsFromDiskIfNeeded = async () => undefined;
    provider.resolveScenarioRuntimeOperationTarget = async (target: unknown) => { calls.push(target); return scenario; };
    provider.runScenarioInVanessa = async (...args: unknown[]) => { calls.push(args); };
    await provider.runTestFromSource(generated);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ uri: 'file:///workspace/scen.yaml' }, ['Own', 'file:///workspace/scen.yaml']]);
});

test('feature Run routes a source with no compiled owner to the standalone launch path', async () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' }); const provider = Object.create(Provider.prototype) as Record<string, any>;
    const uri = { fsPath: '/workspace/own.feature', toString: () => 'file:///workspace/own.feature' }; let called = false;
    provider.findSourceForCompiledFeature = async () => undefined;
    provider.resolveScenarioRuntimeOperationTarget = async () => undefined;
    provider.runStandaloneFeature = async (id: string) => { assert.equal(id, uri.toString()); called = true; };
    await provider.runTestFromSource(uri); assert.equal(called, true);
});

test('MCP full/from-line tracking tails the bound session log and finalizes after the last read', async () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' }); const p = Object.create(Provider.prototype) as Record<string, any>;
    const calls: unknown[] = []; const artifact = { scenarioKey: 'own', scenarioName: 'Own', featurePath: '/workspace/own.feature', jsonPath: '/workspace/own.json' };
    Object.assign(p, { _scenarioBuildArtifacts: new Map([['own', artifact]]), _mcpFeatureRuns: new Set(),
        _externalTrackedRunsByScenario: new Map(), _activeTrackedRunKeyByScenario: new Map([['own', 'previous']]), stopLiveRunLogWatcher() {},
        normalizeFilePathForComparison: (value: string) => value, resolveVanessaLogPathFromJson: () => '/workspace/run.log',
        startFeatureStepTracker: (...args: unknown[]) => calls.push(args), pollFeatureStepTracker: async () => { calls.push('tail'); },
        finalizeRunningFeatureStepHighlight: () => calls.push('complete'), stopFeatureStepTracker: () => calls.push('stop'), clearRunningFeatureStepHighlight() {} });
    await p.trackVanessaFeatureRun('/workspace/other.feature')(true); assert.deepEqual(calls, []);
    const finish = p.trackVanessaFeatureRun(artifact.featurePath, '/workspace/run.log'); assert.equal(p._mcpFeatureRuns.has('own'), true);
    assert.equal(p._activeTrackedRunKeyByScenario.has('own'), false, 'an external watcher must not replace MCP progress');
    await finish(true); assert.deepEqual(calls, [['own', 'Own', '/workspace/run.log', artifact.featurePath], 'tail', 'complete', 'stop']);
});

test('Run from YAML Properties restores disk artifacts before launching after a restart', async () => {
    const root = { fsPath: '/workspace' };
    const Provider = loadPhaseSwitcherProvider(root);
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const source = { scheme: 'file', fsPath: '/workspace/scen.yaml', toString: () => 'file:///workspace/scen.yaml' };
    let restored = false;
    provider.resolveScenarioRuntimeOperationTarget = async () => ({ name: 'Own', yamlFileUri: source });
    provider.restoreScenarioBuildArtifactsFromDiskIfNeeded = async (uri: unknown) => { assert.equal(uri, root); restored = true; };
    provider.runScenarioInVanessa = async () => { assert.equal(restored, true, 'the run must see artifacts already on disk'); };
    await provider.runTestFromSource(source);
});

test('MCP tracks an uncatalogued feature in the same session and retains whole-feature mode for the final log read', async () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' }, { vscode: { EventEmitter: class {},
        Uri: { file: (file: string) => ({ toString: () => `file://${file}` }) } } });
    const provider = Object.create(Provider.prototype) as Record<string, any>; const seen: unknown[][] = [];
    Object.assign(provider, { _scenarioBuildArtifacts: new Map(), _standaloneFeatureArtifacts: new Map(), _mcpFeatureRuns: new Set(),
        _externalTrackedRunsByScenario: new Map(), _activeTrackedRunKeyByScenario: new Map(), stopLiveRunLogWatcher() {},
        normalizeFilePathForComparison: (file: string) => file, startFeatureStepTracker: (...args: unknown[]) => { seen.push(args); },
        pollFeatureStepTracker: async (key: string) => { assert.equal(provider._mcpFeatureRuns.has(key), true); },
        finalizeRunningFeatureStepHighlight() {}, clearRunningFeatureStepHighlight() {}, stopFeatureStepTracker() {} });
    const finish = provider.trackVanessaFeatureRun('/workspace/new.feature', '/session.log');
    assert.equal(seen[0][2], '/session.log'); assert.equal(seen[0][3], '/workspace/new.feature');
    await finish(true); assert.equal(provider._mcpFeatureRuns.size, 0);
});

test('an equivalent artifact refresh does not invalidate an approved stale managed run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-managed-refresh-'));
    try {
        const feature = path.join(root, 'own.feature'); const json = path.join(root, 'own.json');
        fs.writeFileSync(feature, 'Feature: Own\nScenario: Own\n    And Delay 1\n'); fs.writeFileSync(json, '{"Own":true}');
        const Provider = loadPhaseSwitcherProvider({ fsPath: root });
        const provider = Object.create(Provider.prototype) as Record<string, any>;
        const artifact = { scenarioKey: 'own', scenarioName: 'Own', featurePath: feature, jsonPath: json };
        let current = artifact;
        provider.getScenarioBuildArtifact = () => current;
        provider.attachVanessaManagedRunner(async (request: any) => {
            current = { ...artifact };
            assert.ok(request.isCurrent(), 'artifact discovery can recreate identical records without changing the approved files');
            current = { ...artifact, featurePath: path.join(root, 'other.feature') };
            assert.equal(request.isCurrent(), false, 'a retargeted artifact must not execute');
            return 'cancelled';
        });
        assert.equal(await provider.runScenarioInVanessaManaged('Own', 'feature', feature, artifact), 'cancelled');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('managed full launch reuses normal infobase preparation and keeps the authored client JSON without auto-execution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-managed-launch-'));
    try {
        const platform = path.join(root, '1c.exe'); const epf = path.join(root, 'va.epf'); const json = path.join(root, 'own.json');
        for (const file of [platform, epf]) { fs.writeFileSync(file, ''); }
        const authored = { ExecuteScenarios: true, CloseSystemOnComplete: true, Custom: 'keep', TestClient: { datatestclients: [{ Name: 'OwnClient' }] } };
        fs.writeFileSync(json, JSON.stringify(authored));
        let provisioned = 0; let prepared = 0; let command: string[] = []; let runtime: unknown;
        const Provider = loadPhaseSwitcherProvider({ fsPath: root }, {
            vscode: { EventEmitter: class {}, ProgressLocation: { Notification: 1 }, workspace: { workspaceFolders: [{ uri: { fsPath: root } }],
                getConfiguration: () => ({ get: () => epf }) }, window: { withProgress: async (_options: unknown, work: () => Promise<unknown>) => work() } },
            './oneCPlatform.js': { resolveOneCPlatformForLaunch: async () => ({ clientExePath: platform }), resolveOneCDesignerExePath: () => platform },
            './startupInfobase.js': { ensureSharedStartupInfobaseMcpReady: async () => { provisioned++; } },
            './infobaseManager.js': { updateManagedInfobaseMetadata: async () => undefined },
            './vanessaControlLaunch': { managedVanessaCommandParts }
        });
        const provider = Object.create(Provider.prototype) as Record<string, any>;
        provider.t = (value: string) => value; provider._context = {};
        provider.resolvePathFromWorkspaceSetting = (value: string) => value;
        provider.ensureSharedStartupInfobaseReady = async () => ({ infobaseDirectory: path.join(root, 'service') });
        provider.prepareVanessaLaunchContext = async () => { prepared++; return { startupInfobasePath: path.join(root, 'service'), scenarioInfobasePath: path.join(root, 'client'), vaParamsJsonPath: json, jsonWasPatched: false }; };
        provider.resolveVanessaDebugClientsForLaunch = () => { throw new Error('Saved Debug clients must not replace authored clients'); };
        provider.writeVanessaManualDebugJson = async (value: any, selected: any) => { runtime = applyVanessaManualDebugOverlay(value, selected); return path.join(root, 'runtime.json'); };
        provider.buildStartupParams = () => ['ENTERPRISE']; provider.getRunOutputChannel = () => ({});
        provider.outputInfo = provider.outputAdvanced = () => undefined;
        provider.resolveVanessaLogPathFromJson = () => undefined;
        provider.execute1CProcess = () => { throw new Error('MCP must not wait for the manager to close'); };
        provider.execute1CProcessDetached = async (_file: string, args: string[]) => { command = args; };
        const result = await provider.runScenarioInVanessaBuiltIn('Own', 'feature', 'own.feature', { scenarioKey: 'own', jsonPath: json }, { mcpPort: 9877 });
        assert.equal(result, 'started'); assert.equal(prepared, 1); assert.equal(provisioned, 1);
        const params = command[command.indexOf('/C') + 1];
        assert.match(params, /runMcp;mcpPort=9877;/u); assert.match(params, /UseEditor/u); assert.doesNotMatch(params, /StartFeaturePlayer|QuitSystemOnComplete=true/u);
        assert.deepEqual(runtime, { ...authored, ExecuteScenarios: false, CloseSystemOnComplete: false });
        assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), authored);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compiler control capture follows the current profile, complete source folders and Test Manager selection', async () => {
    const workspace = { fsPath: '/workspace', toString: () => 'file:///workspace' };
    let captured: any;
    const profile = { id: 'default', name: 'Default', buildParameters: [
        { key: 'ScenarioFolder', value: 'scenarios' }, { key: 'ProcessFolder', value: '/processes' },
        { key: 'ModelDbSettings', value: 'model.yml' }],
        additionalVanessaParameters: [{ key: 'custom', value: 'fixture-secret', valueKind: undefined }], globalVanessaVariables: [] };
    let active = profile;
    const Provider = loadPhaseSwitcherProvider(workspace, {
        vscode: { EventEmitter: class {}, workspace: { getConfiguration: () => ({ get: () => false }) } },
        './compilerBuildParameters': compilerBuildParameters,
        './compilerBuildManifestStore': { captureCompilerBuildInputs: async (request: unknown) => { captured = request; return request; } },
        './yamlParametersManager.js': { YamlParametersManager: { getInstance: () => ({ loadActiveProfileSnapshot: async () => active }) } }
    });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    provider.getProjectPaths = () => ({ buildScenarioBddEpf: { fsPath: '/tools/compiler.epf' } });
    provider.getMainScenarioSelectionSnapshotForBuild = async () => ({ enabledKeys: ['z', 'a'], disabledKeys: ['b'] });
    await provider.captureCompilerControlInputs(workspace);
    assert.deepEqual([...captured.sourceRoots], ['/workspace/scenarios', '/processes']);
    assert.equal(captured.modelDbSettingsPath, '/workspace/model.yml'); assert.equal(captured.compilerPath, '/tools/compiler.epf');
    assert.deepEqual([...captured.configuration.enabledKeys], ['a', 'z']);
    assert.deepEqual([...captured.configuration.disabledKeys], ['b']);
    assert.equal(captured.configuration.profile.additionalVanessaParameters[0].value, 'fixture-secret');
    assert.equal(Object.hasOwn(captured.configuration.profile.additionalVanessaParameters[0], 'valueKind'), false);
    active = { ...profile, id: 'other' };
    await provider.captureCompilerControlInputs(workspace);
    assert.equal(captured.configuration.profile.id, 'other', 'the final comparison reloads the active profile');
});

test('Test Manager attachment search indexes source files for unbuilt scenarios under their stable keys', async () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const scenarios = ['first', 'second'].map(folder => ({
        name: 'Duplicate', tabName: 'Smoke', relativePath: folder,
        yamlFileUri: { toString: () => `file:///workspace/${folder}/scen.yaml` }
    }));
    provider.getMainScenariosFromCatalog = () => scenarios;
    provider.compiledScenarioFileItem = () => null;
    provider._scenarioFilesService = {
        listAttachmentPaths: async (item: { capturedLocation?: { uri: string } }) => {
            if (item.capturedLocation?.uri === 'file:///workspace/first/scen.yaml') { return ['Fixtures/Input.xlsx']; }
            if (item.capturedLocation?.uri === 'file:///workspace/second/scen.yaml') { return ['Other.csv']; }
            return [];
        }
    };
    const result = await provider.buildScenarioAttachmentSearchPaths();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        'file:///workspace/first/scen.yaml': ['Fixtures/Input.xlsx'],
        'file:///workspace/second/scen.yaml': ['Other.csv']
    });
});

test('Test Manager shows its catalog before waiting for runtime artifacts or attachment indexing', async () => {
    const workspace = { fsPath: '/workspace', toString: () => 'file:///workspace' };
    const Provider = loadPhaseSwitcherProvider(workspace, {
        vscode: { EventEmitter: class {}, workspace: { workspaceFolders: [{ uri: workspace }], getConfiguration: () => ({ get: () => false }) }, window: {} },
        './yamlParametersManager.js': { YamlParametersManager: { getInstance: () => ({ getProfilesSummary: async () => [] }) } }
    });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const messages: Array<Record<string, any>> = [];
    const scenario = { name: 'Ready', yamlFileUri: { toString: () => 'file:///workspace/scen.yaml' } };
    const webview = { postMessage: (message: Record<string, unknown>) => { messages.push(message); return Promise.resolve(true); } };
    let release!: () => void;
    const slowWork = new Promise<void>(resolve => { release = resolve; });
    Object.assign(provider, {
        _view: { webview }, _context: {}, _projectLibraryGroups: [],
        t: (key: string) => key, getScenarioCatalog: () => ({ all: [scenario] }),
        isAffectedMainScenarioHighlightEnabled: () => false, isRelatedScenarioFilterEnabled: () => false,
        getProjectScenarioGroups: async () => [], getMainScenariosFromCatalog: () => [scenario],
        getMainScenarioSelectionStates: async () => ({}), _groupAndSortTestData: () => ({ Smoke: [scenario] }),
        pruneScenarioBuildArtifactsByCache() {}, buildRunArtifactsState: () => ({}),
        handleActiveEditorChanged() {}, isAdvancedOutputLoggingEnabled: () => false,
        restoreScenarioBuildArtifactsFromDiskIfNeeded: () => slowWork,
        buildScenarioAttachmentSearchPaths: async () => { await slowWork; return {}; },
        _standaloneFeatureService: { ensureReady: async () => { await slowWork; return {}; } },
        syncStandaloneFeatureArtifacts() {}, sendRunArtifactsStateToWebview() {},
        synchronizeFavoriteEntriesWithCache: async () => undefined, refreshActiveScenarioFavoriteContext() {}
    });
    const initial = provider._sendInitialState(webview);
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(messages.some(message => message.command === 'loadInitialState'), 'slow optional indexing must not hold the scenario list behind Scanning files');
        assert.ok(messages.some(message => message.command === 'updateStatus' && message.enableControls === true));
        assert.ok(!messages.some(message => message.command === 'updateStatus' && message.text === 'Scanning files...'), 'metadata-only refresh must not announce or disable controls for a scan');
    } finally { release(); await initial; }
});

test('run artifact notifications skip identical snapshots but resend changes and a new webview', () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' });
    const provider = Object.create(Provider.prototype) as Record<string, any>; const sent: any[] = [];
    let status = 'running'; let published = 0;
    provider.publishScenarioArtifactChanges = () => { published++; };
    provider.buildRunArtifactsState = () => ({ test: { status, featurePath: '/tests/test.feature' } });
    provider._view = { webview: { postMessage: (message: unknown) => sent.push(message) } };
    provider.sendRunArtifactsStateToWebview(); provider.sendRunArtifactsStateToWebview();
    assert.equal(sent.length, 1); assert.equal(published, 2);
    status = 'passed'; provider.sendRunArtifactsStateToWebview(); assert.equal(sent.length, 2);
    provider._view = { webview: { postMessage: (message: unknown) => sent.push(message) } };
    provider.sendRunArtifactsStateToWebview(); assert.equal(sent.length, 3);
});

test('Test Manager ignores an older attachment-search response after a newer invalidation', async () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const sent: unknown[] = [];
    provider._view = { webview: { postMessage: async (message: unknown) => sent.push(message) } };
    provider._scenarioAttachmentSearchGeneration = 0;
    let resolveOld!: (value: unknown) => void;
    let calls = 0;
    provider.buildScenarioAttachmentSearchPaths = () => ++calls === 1
        ? new Promise(resolve => { resolveOld = resolve; })
        : Promise.resolve({ second: ['Newest.csv'] });
    const old = provider.sendScenarioAttachmentSearchPathsToWebview();
    await provider.sendScenarioAttachmentSearchPathsToWebview();
    resolveOld({ first: ['Stale.csv'] });
    await old;
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
        command: 'updateScenarioAttachmentSearchPaths', attachmentPathsByScenario: { second: ['Newest.csv'] }
    }]);
});

test('scenario rename moves adjacent metadata before publishing the refreshed catalog', async () => {
    const from = { fsPath: '/workspace/tests/old/scen.yaml', toString: () => 'file:///workspace/tests/old/scen.yaml' };
    const to = { fsPath: '/workspace/tests/new/scen.yaml', toString: () => 'file:///workspace/tests/new/scen.yaml' };
    const info = { name: 'Sales', uid: 'sales', yamlFileUri: from };
    const calls: string[] = [];
    const guard = () => undefined;
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' }, {
        './projectLibraryIntegration': {
            projectLibraryEnvironment: () => ({ workspaceRoots: ['/workspace'], scanRoots: ['/workspace/tests'] }),
            assertProjectMetadataSaved: guard
        },
        './projectLibraryMetadata': { remapProjectScenarioMetadata: async (previous: unknown, next: { yamlFileUri: unknown }, roots: string[], scans: string[], beforeWrite: unknown) => {
            assert.equal(previous, info);
            assert.equal(next.yamlFileUri, to);
            assert.equal(JSON.stringify(roots), '["/workspace"]');
            assert.equal(JSON.stringify(scans), '["/workspace/tests"]');
            assert.equal(beforeWrite, guard);
            calls.push('metadata');
        } }
    });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    provider.getScenarioCatalog = () => ({ all: [info] });
    provider.remapUriAfterRename = () => to;
    provider.areUrisEqual = (left: typeof from, right: typeof from) => left.toString() === right.toString();
    provider.shouldTrackUriForCache = () => true;
    provider.captureMainScenarioSelectionStatesForRename = () => ({});
    provider.captureScenarioCustomInfobasePathsForRename = () => ({});
    provider.updateScenarioCacheEntriesForRenames = async () => {
        calls.push('catalog');
        provider.getScenarioCatalog = () => undefined;
        return true;
    };
    await provider.handleScenarioFilesRenamed([{ oldUri: from, newUri: to }]);
    assert.deepEqual(calls, ['metadata', 'catalog']);
});



test('Library scenario and group rename use the selected target without requiring an active editor', async () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const calls: unknown[] = [];
    const scenario = { name: 'Selected', yamlFileUri: { toString: () => 'file:///selected/scen.yaml' }, tabName: 'Smoke' };
    provider.resolveScenarioOperationTarget = async () => scenario;
    provider.isMainScenario = () => false;
    provider.changeNestedScenarioName = async (target: unknown) => calls.push(['nested', target]);
    provider.renameScenario = async (target: unknown) => calls.push(['main', target]);
    provider.renameGroup = async (name: string) => calls.push(['group', name]);
    const target = { name: 'Selected', uri: 'file:///selected/scen.yaml' };
    await provider.renameScenarioTarget(target);
    provider.isMainScenario = () => true;
    await provider.renameScenarioTarget(target);
    assert.equal(await provider.renameMainScenarioGroup(target, 'Smoke'), true);
    assert.equal(await provider.renameMainScenarioGroup(target, 'Old group'), false);
    assert.equal(JSON.stringify(calls), JSON.stringify([['nested', target], ['main', target], ['group', 'Smoke']]));
});

test('manual Test Manager refresh rescans catalog and compiled artifacts by default', async () => {
    const workspaceUri = { fsPath: '/workspace', toString: () => 'file:///workspace' };
    const Provider = loadPhaseSwitcherProvider(workspaceUri);
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const calls: string[] = [];
    const webview = {};

    provider._view = { visible: true, webview };
    provider.invalidateScenarioCatalog = (clear: boolean) => calls.push(`invalidate:${String(clear)}`);
    provider.ensureFreshScenarioCatalog = async () => calls.push('catalog');
    provider.refreshScenarioBuildArtifactsFromDisk = async (uri: object) => {
        assert.equal(uri, workspaceUri);
        calls.push('artifacts');
    };
    provider.handleActiveEditorChanged = () => calls.push('editor');
    provider._sendInitialState = async (target: object) => {
        assert.equal(target, webview);
        calls.push('publish');
    };

    await provider.refreshFromExternalStateChange();

    assert.deepEqual(calls, [
        'invalidate:true',
        'catalog',
        'artifacts',
        'editor',
        'publish'
    ]);
});

test('conversion refresh marks transitive callers stale using the old graph and current artifact keys', async () => {
    const workspaceUri = { fsPath: '/workspace', toString: () => 'file:///workspace' };
    const Provider = loadPhaseSwitcherProvider(workspaceUri);
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const source = { scheme: 'file', fsPath: '/workspace/nested/scen.yaml' };
    const oldKey = 'file:///workspace/main/scen.yaml'; const newKey = 'file:///workspace/main/meta.yaml';
    const main = { scenarioKey: oldKey, scenarioName: 'Main', featurePath: '/build/main.feature' };
    const unrelated = { scenarioKey: 'other', scenarioName: 'Other', featurePath: '/build/other.feature' };
    provider._scenarioBuildArtifacts = new Map([[oldKey, main], ['other', unrelated]]);
    provider._staleBuiltScenarioNames = new Set();
    provider._scenarioExecutionStates = new Map([[newKey, { status: 'passed' }], ['other', { status: 'passed' }]]);
    let reloaded = false; let published: string[] = [];
    provider.getScenarioNamesRelatedToUri = (uri: unknown) => uri === source && !reloaded ? ['Nested'] : [];
    provider.getScenarioNamesByArtifactSourceUri = () => [];
    provider.buildCallersByCalleeFromCache = () => reloaded ? new Map() : new Map([['Nested', new Set(['Middle'])], ['Middle', new Set(['Main'])]]);
    provider.invalidateScenarioCatalog = () => {};
    provider.ensureFreshScenarioCatalog = async () => { reloaded = true; };
    provider.refreshScenarioBuildArtifactsFromDisk = async () => {
        provider._scenarioBuildArtifacts = new Map([[newKey, { ...main, scenarioKey: newKey }], ['other', unrelated]]);
    };
    provider.sendRunArtifactsStateToWebview = () => { published = [...provider._staleBuiltScenarioNames]; };
    provider.handleActiveEditorChanged = () => {};
    await provider.refreshFromExternalStateChange({ refreshCache: true, changedSourceUris: [source] });
    assert.deepEqual([...provider._staleBuiltScenarioNames], [newKey]);
    assert.deepEqual(published, [newKey]);
    assert.equal(provider._scenarioExecutionStates.has(newKey), false);
    assert.equal(provider._scenarioExecutionStates.get('other').status, 'passed');
});

test('artifact refresh avoids hash evaluation and build-root watcher is debounced', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const refreshSource = source.slice(
        source.indexOf('    private async performScenarioBuildArtifactsRefresh('),
        source.indexOf('    private async restoreScenarioBuildArtifactsFromDiskIfNeeded(')
    );
    assert.match(refreshSource, /rearmScenarioArtifactBuildRootWatcher\(buildRootUri\)/u);
    assert.doesNotMatch(refreshSource, /evaluateScenarioArtifactFreshness/u);
    assert.match(source, /setTimeout\(\(\) => \{[\s\S]*?refreshScenarioBuildArtifactsFromDisk/u);
    assert.doesNotMatch(source, /SCENARIO_ARTIFACT_MANIFEST_FILE/u);
});

test('artifact watcher ignores derived combined JSON while retaining real compiler inputs and attachments', () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const uri = (file: string, scheme = 'file') => ({ fsPath: file, scheme });
    for (const file of ['/build/own.combined.json', '/build/OWN.COMBINED.JSON', '/build/Файлы/own.combined.json']) {
        assert.equal(provider.isRelevantScenarioArtifactWatchUri(uri(file)), false, file);
    }
    for (const file of ['/build/own.json', '/build/own.feature', '/build/Файлы/fixture.txt']) {
        assert.equal(provider.isRelevantScenarioArtifactWatchUri(uri(file)), true, file);
    }
    assert.equal(provider.isRelevantScenarioArtifactWatchUri(uri('/build/own.json', 'untitled')), false);
});

test('combined launch JSON is written once with final runtime paths and is untouched on an identical refresh', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-combined-refresh-'));
    try {
        const writes: string[] = [];
        const trackedFs = { ...fs, promises: { ...fs.promises, writeFile: async (...args: Parameters<typeof fs.promises.writeFile>) => {
            writes.push(String(args[0]));
            return fs.promises.writeFile(...args);
        } } };
        const Provider = loadPhaseSwitcherProvider({ fsPath: root }, { fs: trackedFs, './vanessaLaunchJson': vanessaLaunchJson });
        const provider = Object.create(Provider.prototype) as Record<string, any>;
        provider.loadVanessaLaunchOverlayParameters = async () => ({ additionalParameters: [], globalVariables: [] });
        provider.resolveVanessaRuntimeDirectory = () => path.join(root, 'runtime');
        for (const [name, source] of [
            ['runtime', '{"TextLogName":"old.log","LogPath":"old.status.log","ownSetting":true}'],
            ['plain', '{"ownSetting":true}'],
            ['invalid', 'not valid JSON']
        ]) {
            const sourcePath = path.join(root, `${name}.json`);
            fs.writeFileSync(sourcePath, source);
            const combined = await provider.createCombinedScenarioJsonArtifact(name, sourcePath, root);
            assert.equal(writes.filter(file => file === combined).length, 1, 'publish the final payload in a single write');
            const content = fs.readFileSync(combined, 'utf8');
            if (name === 'runtime') {
                const parsed = JSON.parse(content);
                assert.equal(parsed.TextLogName, path.join(root, 'runtime', 'runtime.combined.log').replace(/\\/gu, '/'));
                assert.equal(parsed.LogPath, path.join(root, 'runtime', 'runtime.combined.status.log').replace(/\\/gu, '/'));
            }
            const timestamp = new Date('2000-01-01T00:00:00Z');
            fs.utimesSync(combined, timestamp, timestamp);
            await provider.createCombinedScenarioJsonArtifact(name, sourcePath, root);
            assert.equal(writes.filter(file => file === combined).length, 1, 'identical final bytes must not create another watcher event');
            assert.equal(fs.statSync(combined).mtimeMs, timestamp.getTime());
            assert.equal(fs.readFileSync(combined, 'utf8'), content);
            fs.writeFileSync(sourcePath, '{"ownSetting":false}');
            await provider.createCombinedScenarioJsonArtifact(name, sourcePath, root);
            assert.equal(writes.filter(file => file === combined).length, 2, 'changed source JSON is still applied');
            assert.equal(JSON.parse(fs.readFileSync(combined, 'utf8')).ownSetting, false);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('artifact integration rescans external artifacts without pre-build hashing', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const associationSource = source.slice(
        source.indexOf('    private async updateScenarioBuildArtifacts('),
        source.indexOf('    private quoteForShell(')
    );
    const buildSource = source.slice(
        source.indexOf('    private async _handleRunAssembleScriptTypeScript('),
        source.indexOf('    private async execute1CProcess(')
    );

    assert.doesNotMatch(
        associationSource,
        /const scenarioNamesForAssociation = enabledKeyByName\s*\?/u
    );
    assert.doesNotMatch(source, /createFileSystemWatcher\('\*\*\/\*\.\{yaml,yml,feature\}'\)/u);
    assert.doesNotMatch(buildSource, /captureScenarioArtifactBuildInputs/u);
    assert.doesNotMatch(buildSource, /recordSuccessfulScenarioArtifactBuild/u);
    assert.doesNotMatch(source, /scenarioArtifactFreshness/u);
});

test('an unchanged disk rescan preserves stale state until the compiled artifact changes', async () => {
    const workspaceUri = { fsPath: '/workspace', toString: () => 'file:///workspace' };
    const Provider = loadPhaseSwitcherProvider(workspaceUri);
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-stale-rescan-'));
    const featurePath = path.join(root, 'Scenario A.feature');
    fs.writeFileSync(featurePath, 'Feature: Scenario A\n');

    try {
        const scenarioKey = 'file:///workspace/ScenarioA/scen.yaml';
        const sourceUri = {
            scheme: 'file',
            fsPath: '/workspace/ScenarioA/scen.yaml',
            toString: () => scenarioKey
        };
        const scenario = { name: 'Scenario A', yamlFileUri: sourceUri };
        const catalog = {
            all: [scenario],
            byName: new Map([['Scenario A', [scenario]]]),
            byUri: new Map([[scenarioKey, scenario]])
        };
        provider._scenarioBuildArtifacts = new Map([[scenarioKey, {
            scenarioKey,
            scenarioName: 'Scenario A',
            sourceUri,
            featurePath,
            builtAt: Date.now() + 60_000
        }]]);
        provider._staleBuiltScenarioNames = new Set([scenarioKey]);
        provider._scenarioExecutionStates = new Map();
        provider._scenarioLastLaunchContexts = new Map();
        provider.getScenarioCatalog = () => catalog;
        provider.stopAllFeatureStepTrackers = () => undefined;
        provider.clearFeatureStepHighlightsForScenarios = () => undefined;
        provider.clearFailedFeatureStepHighlight = () => undefined;
        provider.clearTrackedRunLogWatchersForScenario = () => undefined;

        await provider.updateScenarioBuildArtifacts(
            [{ scheme: 'file', fsPath: featurePath }],
            { scheme: 'file', fsPath: root },
            { 'Scenario A': scenarioKey },
            []
        );

        assert.equal(provider._staleBuiltScenarioNames.has(scenarioKey), true);

        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(featurePath, future, future);
        await provider.updateScenarioBuildArtifacts(
            [{ scheme: 'file', fsPath: featurePath }],
            { scheme: 'file', fsPath: root },
            { 'Scenario A': scenarioKey },
            []
        );

        assert.equal(provider._staleBuiltScenarioNames.has(scenarioKey), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('artifacts restored after extension restart are stale until rebuilt', async () => {
    const workspaceUri = { fsPath: '/workspace', toString: () => 'file:///workspace' };
    const Provider = loadPhaseSwitcherProvider(workspaceUri);
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const scenarioKey = 'file:///workspace/ScenarioA/scen.yaml';

    provider._startupArtifactsRestoreAttempted = false;
    provider._scenarioBuildArtifacts = new Map();
    provider._staleBuiltScenarioNames = new Set();
    provider._scenarioExecutionStates = new Map([['old-run', { status: 'passed' }]]);
    provider._scenarioLastLaunchContexts = new Map([['old-run', {}]]);
    provider.refreshScenarioBuildArtifactsFromDisk = async () => {
        provider._scenarioBuildArtifacts.set(scenarioKey, {
            scenarioKey,
            scenarioName: 'Scenario A'
        });
    };
    provider.stopAllFeatureStepTrackers = () => undefined;

    await provider.restoreScenarioBuildArtifactsFromDiskIfNeeded(workspaceUri);

    assert.deepEqual([...provider._staleBuiltScenarioNames], [scenarioKey]);
    assert.equal(provider._scenarioExecutionStates.size, 0);
    assert.equal(provider._scenarioLastLaunchContexts.size, 0);
});

test('MCP tracking follows the connected manager log instead of a different artifact launch log', async () => {
    const Provider = loadPhaseSwitcherProvider({ fsPath: '/workspace' });
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    const seen: unknown[][] = [];
    Object.assign(provider, { _scenarioBuildArtifacts: new Map([['own', { scenarioKey: 'own', scenarioName: 'Own', featurePath: '/workspace/own.feature', jsonPath: '/artifact.json' }]]),
        _standaloneFeatureArtifacts: new Map(), _mcpFeatureRuns: new Set(),
        _externalTrackedRunsByScenario: new Map(), _activeTrackedRunKeyByScenario: new Map(), stopLiveRunLogWatcher() {},
        normalizeFilePathForComparison: (file: string) => file, resolveVanessaLogPathFromJson: () => '/wrong-artifact.log',
        startFeatureStepTracker: (...args: unknown[]) => { seen.push(args); }, pollFeatureStepTracker: async () => {},
        finalizeRunningFeatureStepHighlight() {}, clearRunningFeatureStepHighlight() {}, stopFeatureStepTracker() {} });
    const finish = provider.trackVanessaFeatureRun('/workspace/own.feature', '/connected-manager.log');
    assert.equal(seen[0][2], '/connected-manager.log'); await finish(true);
    seen.length = 0; await provider.trackVanessaFeatureRun('/workspace/own.feature')(true);
    assert.equal(seen.length, 0, 'an unverified artifact JSON must not substitute for the current manager log');
});
