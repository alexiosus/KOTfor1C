import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as compilerArtifacts from '../src/compilerArtifacts';
import * as runtimeIdentity from '../src/scenarioRuntimeIdentity';

function loadPhaseSwitcherProvider(workspaceUri: object, dependencies: Record<string, unknown> = {}): { prototype: object } {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const moduleObject = { exports: {} as Record<string, unknown> };
    const vscode = {
        EventEmitter: class {},
        workspace: { workspaceFolders: [{ uri: workspaceUri }] },
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
