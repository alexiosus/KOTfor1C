import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadPhaseSwitcherProvider(workspaceUri: object): { prototype: object } {
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
