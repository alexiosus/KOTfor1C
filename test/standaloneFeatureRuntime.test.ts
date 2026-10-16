import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { compiledScenarioResourcesFromFeaturePath } from '../src/scenarioFilesModel';
import * as standaloneFeatureLaunch from '../src/standaloneFeatureLaunch';
import * as vanessaLaunchJson from '../src/vanessaLaunchJson';
import * as vanessaRunLog from '../src/vanessaRunLog';
import * as oneCInfobaseConnection from '../src/oneCInfobaseConnection';
import * as fileTailReader from '../src/fileTailReader';

function loadProvider(): { prototype: object } {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return {
                    EventEmitter: class {},
                    workspace: { getWorkspaceFolder: () => undefined, workspaceFolders: [] },
                    Uri: { parse: (uri: string) => ({ scheme: 'file', fsPath: fileURLToPath(uri), toString: () => uri }) }
                };
            }
            if (specifier === 'fs') { return fs; }
            if (specifier === 'path') { return path; }
            if (specifier === 'os') { return os; }
            if (specifier === 'node:crypto') { return require('node:crypto'); }
            if (specifier === './deferredLoader') {
                return { createDeferredLoader: (factory: () => Promise<unknown>) => factory };
            }
            if (specifier === './scenarioFilesModel') {
                return { compiledScenarioResourcesFromFeaturePath };
            }
            if (specifier === './standaloneFeatureLaunch') { return standaloneFeatureLaunch; }
            if (specifier === './vanessaLaunchJson') { return vanessaLaunchJson; }
            if (specifier === './vanessaRunLog') { return vanessaRunLog; }
            if (specifier === './oneCInfobaseConnection') { return oneCInfobaseConnection; }
            if (specifier === './fileTailReader') { return fileTailReader; }
            return {};
        },
        Buffer, console, process, setImmediate, setInterval, setTimeout, clearInterval, clearTimeout
    });
    return moduleObject.exports.PhaseSwitcherProvider as { prototype: object };
}

function providerWithFeatures(): Record<string, any> {
    const provider = Object.create(loadProvider().prototype) as Record<string, any>;
    provider._scenarioBuildArtifacts = new Map();
    provider._standaloneFeatureArtifacts = new Map([
        ['file:///tests/one/login.feature', {
            scenarioKey: 'file:///tests/one/login.feature', scenarioName: 'login', featurePath: '/tests/one/login.feature'
        }],
        ['file:///tests/two/login.feature', {
            scenarioKey: 'file:///tests/two/login.feature', scenarioName: 'login', featurePath: '/tests/two/login.feature'
        }]
    ]);
    provider._scenarioExecutionStates = new Map();
    provider._scenarioLastLaunchContexts = new Map();
    provider._standaloneFeatureRuntimeJsonPaths = new Set();
    provider._staleBuiltScenarioNames = new Set();
    provider.getScenarioCatalog = () => null;
    return provider;
}

test('standalone feature runtime resolves URI identity without main scenarios and distinguishes equal filenames', () => {
    const provider = providerWithFeatures();
    assert.equal(provider.resolveRuntimeKeyForScenario('login', 'file:///tests/two/login.feature'), 'file:///tests/two/login.feature');
    assert.equal(provider.getScenarioBuildArtifact('login', 'file:///tests/one/login.feature')?.featurePath, '/tests/one/login.feature');
    assert.equal(provider.getScenarioBuildArtifact('login', 'file:///tests/two/login.feature')?.featurePath, '/tests/two/login.feature');
    assert.equal(provider.getScenarioBuildArtifact('login'), undefined);
});

test('standalone action callbacks navigate and run the canonical feature independently of main scenario names', async () => {
    const provider = providerWithFeatures();
    const id = 'file:///tests/two/login.feature';
    provider._standaloneFeatureService = { find: (key: string) => key === id ? { id, name: 'login' } : undefined };
    const calls: unknown[][] = [];
    provider.runStandaloneFeature = async (...args: unknown[]) => { calls.push(['run', ...args]); };
    provider.openRunScenarioLog = async (...args: unknown[]) => { calls.push(['log', ...args]); };
    provider.openLiveRunLog = async (...args: unknown[]) => { calls.push(['watch', ...args]); };
    provider.openScenarioRunStepInFeature = async (...args: unknown[]) => { calls.push(['step', ...args]); };
    assert.equal(typeof provider.getStandaloneFeatureControllerOptions, 'function');
    const actions = provider.getStandaloneFeatureControllerOptions();
    await actions.run(id);
    await actions.openLog(id);
    await actions.watchLog(id);
    await actions.openRunStep(id);
    await actions.openRunStep('file:///tests/missing.feature');
    assert.deepEqual(calls, [
        ['run', id], ['log', 'login', id], ['watch', 'login', id], ['step', 'login', id]
    ]);
});

test('standalone run status is published even with an empty main scenario catalog', () => {
    const provider = providerWithFeatures();
    provider._externalTrackedRunsByScenario = new Map();
    provider.getScenarioDisplayedRunState = (key: string) => ({
        status: key.includes('/two/') ? 'failed' : 'passed', source: 'internal', updatedAt: 100
    });
    provider.getTrackedRunCountForScenario = () => 0;
    provider.isScenarioRunInProgress = () => false;
    provider.getScenarioProgress = () => undefined;
    const state = provider.buildRunArtifactsState();
    assert.equal(state['file:///tests/one/login.feature']?.runStatus, 'passed');
    assert.equal(state['file:///tests/two/login.feature']?.runStatus, 'failed');
});

test('pruning removed main artifacts preserves independent feature execution state', () => {
    const provider = providerWithFeatures();
    provider._scenarioBuildArtifacts.set('file:///tests/removed/scen.yaml', { scenarioName: 'removed' });
    provider._scenarioExecutionStates.set('file:///tests/one/login.feature', { scenarioName: 'login', status: 'passed' });
    provider._scenarioExecutionStates.set('file:///tests/removed/scen.yaml', { scenarioName: 'removed', status: 'passed' });
    provider.stopAllFeatureStepTrackers = () => undefined;
    provider.stopAllTrackedRunLogWatchers = () => undefined;
    provider.disposeAllLiveRunLogWatchers = () => undefined;
    provider.clearFailedFeatureStepHighlight = () => undefined;
    provider.stopFeatureStepTracker = () => undefined;
    provider.clearTrackedRunLogWatchersForScenario = () => undefined;
    provider.pruneScenarioBuildArtifactsByCache();
    assert.equal(provider._scenarioExecutionStates.get('file:///tests/one/login.feature')?.status, 'passed');
    assert.equal(provider._scenarioExecutionStates.has('file:///tests/removed/scen.yaml'), false);
});

test('feature catalog refresh preserves launch copies and run state for an unchanged feature', () => {
    const provider = providerWithFeatures();
    const id = 'file:///tests/one/login.feature';
    provider._standaloneFeatureArtifacts.get(id).jsonPath = '/tests/one/login.json';
    provider._standaloneFeatureArtifacts.get(id).combinedJsonPath = '/runtime/login_123.json';
    provider._scenarioExecutionStates.set(id, { scenarioName: 'login', status: 'passed' });
    provider.clearFailedFeatureStepHighlight = () => undefined;
    provider.stopFeatureStepTracker = () => undefined;
    provider.clearTrackedRunLogWatchersForScenario = () => undefined;
    provider.stopLiveRunLogWatcher = () => undefined;
    assert.equal(typeof provider.syncStandaloneFeatureArtifacts, 'function');
    provider.syncStandaloneFeatureArtifacts({
        features: [{ id, uri: id, name: 'login', title: 'Log in', jsonPath: '/tests/one/login.json' }], groups: [], revision: 1
    });
    assert.equal(provider.getScenarioBuildArtifact('login', id)?.combinedJsonPath, '/runtime/login_123.json');
    assert.equal(provider._scenarioExecutionStates.get(id)?.status, 'passed');
    assert.equal(provider._standaloneFeatureArtifacts.has('file:///tests/two/login.feature'), false);
});

test('English Vanessa logs and statuses use distinct runtime copies without editing authored JSON', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-feature-launch-'));
    try {
        const provider = providerWithFeatures();
        provider.resolveVanessaRuntimeDirectory = () => path.join(root, 'runtime');
        const original = '\uFEFF' + JSON.stringify({
            featurepath: '/tests', FeaturesToRun: ['other.feature'],
            logtotext: true, textlogname: 'original.log', createlogs: true, logpath: 'original.status',
            GlobalVars: { featurepath: 'business value', textlogname: 'business log', logpath: 'business path' },
            Custom: { LogFile: 'custom data' }
        });
        const sourceJson = path.join(root, 'launch.json');
        fs.writeFileSync(sourceJson, original);
        const artifact = (id: string) => ({
            scenarioKey: id, scenarioName: 'login', sourceUri: { fsPath: fileURLToPath(id) },
            featurePath: fileURLToPath(id), jsonPath: sourceJson
        });
        const one = await provider.prepareStandaloneFeatureLaunchJson(artifact('file:///tests/one/login.feature'));
        const two = await provider.prepareStandaloneFeatureLaunchJson(artifact('file:///tests/two/login.feature'));
        const oneJson = JSON.parse(fs.readFileSync(one, 'utf8'));
        const twoJson = JSON.parse(fs.readFileSync(two, 'utf8'));
        assert.equal(fs.readFileSync(sourceJson, 'utf8'), original);
        assert.equal(oneJson.featurepath, '/tests/one/login.feature');
        assert.equal(twoJson.featurepath, '/tests/two/login.feature');
        assert.notEqual(oneJson.textlogname, twoJson.textlogname);
        assert.notEqual(oneJson.logpath, twoJson.logpath);
        assert.equal(oneJson.GlobalVars.featurepath, 'business value');
        assert.equal(oneJson.GlobalVars.textlogname, 'business log');
        assert.equal(oneJson.GlobalVars.logpath, 'business path');
        assert.equal(oneJson.Custom.LogFile, 'custom data');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('selected infobase reaches TestClient when independent launch JSON has no connection settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-feature-infobase-'));
    try {
        const provider = providerWithFeatures();
        const id = 'file:///tests/one/login.feature';
        const jsonPath = path.join(root, 'launch.json');
        const authored = JSON.stringify({ featurepath: '/tests/one/login.feature', Custom: { value: 7 } });
        fs.writeFileSync(jsonPath, authored);
        provider.t = (value: string) => value;
        provider.promptVanessaInfobasePreparationPlan = async () => ({ targetInfobasePath: '/bases/selected' });
        provider.prepareTargetInfobaseForVanessa = async () => undefined;
        provider.saveScenarioCustomInfobasePath = async () => undefined;
        provider.getRunOutputChannel = () => ({});
        const launch = await provider.prepareVanessaLaunchContext(id, 'login', jsonPath, '/bases/startup', root, '/1c');
        assert.equal(launch.jsonWasPatched, true);
        const runtime = JSON.parse(fs.readFileSync(launch.vaParamsJsonPath, 'utf8'));
        assert.equal(provider.collectVanessaInfobaseCandidates(runtime)[0].extractedPath, '/bases/selected');
        assert.equal(runtime.Custom.value, 7);
        assert.equal(fs.readFileSync(jsonPath, 'utf8'), authored);
        fs.rmSync(launch.vaParamsJsonPath, { force: true });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('compiled exclusions use only associated artifacts and update during the build lifecycle', async () => {
    const provider = providerWithFeatures();
    let excluded: readonly string[] | undefined;
    provider._standaloneFeatureService = { setCompiledFeaturePaths: (paths: readonly string[]) => { excluded = paths; } };
    provider.clearCompiledScenarioExecutionStates = () => undefined;
    await provider.updateScenarioBuildArtifacts([{ fsPath: '/tests/authored.feature' }], { fsPath: '/tests' });
    assert.ok(excluded);
    assert.equal(excluded.length, 0);
});

test('auto-detected feature logs retain standalone URI identity even without a YAML catalog', () => {
    const provider = providerWithFeatures();
    const id = 'file:///tests/one/login.feature';
    provider.parseTrackingSessionFromLogFile = () => ({
        session: { sessionKey: id, featurePath: '/tests/one/login.feature' },
        scenarioFromLog: 'Successful authentication', featurePathFromLog: '/tests/one/login.feature'
    });
    const result = provider.resolveScenarioForAutoDetectedVanessaLog('/runtime/login.log');
    assert.equal(result.scenarioKey, id);
    assert.equal(result.expectedScenarioName, undefined);
});

test('standalone progress follows scenarios whose titles differ from the feature filename', () => {
    const provider = providerWithFeatures();
    const id = 'file:///tests/one/login.feature';
    const tracker = {
        scenarioKey: id, scenarioName: 'login', currentScenarioNameFromLog: 'Successful authentication',
        featurePathFromLog: '/tests/one/login.feature', currentFeaturePathFromLog: '/tests/one/login.feature',
        featureLineVisitCounts: new Map()
    };
    provider.resolveReadableFeaturePathForTracking = () => '/tests/one/login.feature';
    provider.isRunLogStepCompatibleWithFeature = () => true;
    provider.areFeaturePathsEquivalentForTracking = (left: string, right: string) => left === right;
    provider.isTrackedRunSelectedForScenario = () => false;
    let line = 0;
    provider.setRunningFeatureStepHighlight = (_id: string, _name: string, _path: string, nextLine: number) => { line = nextLine; };
    provider.applyFeatureStepSyncLogLine(tracker, 'FeatureLineNumber: 17');
    assert.equal(line, 17);
});

test('standalone failure highlights the failed scenario even when a later scenario passes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-feature-failure-'));
    try {
        const provider = providerWithFeatures();
        const id = 'file:///tests/one/login.feature';
        const logPath = path.join(root, 'run.log');
        fs.writeFileSync(logPath, [
            'Feature: /tests/one/login.feature', 'Scenario: Declined login',
            '(8). Step: Then login succeeds', 'Step (Then login succeeds) failed',
            'Authentication failed', 'ErrorFileJson: /tmp/failure.json',
            'Scenario: Existing session', '(15). Step: Then session opens', 'PASSED: 1', 'FAILED: 1'
        ].join('\n'));
        provider._liveFeatureStepTrackers = new Map();
        provider._runningFeatureStepHighlights = new Map([[id, { featurePath: '/tests/one/login.feature', featureLineNumber: 15 }]]);
        provider.getFeatureProgressInfo = () => undefined;
        let highlight: any[] | undefined;
        provider.setFailedFeatureStepHighlight = (...args: any[]) => { highlight = args; };
        provider.captureFailedStepHighlight(id, 'login', logPath);
        assert.ok(highlight);
        assert.equal(highlight[3], 8);
        assert.equal(highlight[4].failureSummary, 'Step (Then login succeeds) failed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('selected infobase preserves business connection strings in independent JSON', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-feature-connection-'));
    try {
        const provider = providerWithFeatures();
        const jsonPath = path.join(root, 'launch.json');
        fs.writeFileSync(jsonPath, JSON.stringify({
            GlobalVars: { ReportingConnection: 'File="/reporting";' },
            TestClient: { datatestclients: [{ PathToInfobase: 'File="/test";' }] }
        }));
        provider.t = (value: string) => value;
        let defaultBase = '';
        provider.promptVanessaInfobasePreparationPlan = async (_id: string, _name: string, _root: string, initial: string) => {
            defaultBase = initial;
            return { targetInfobasePath: '/selected' };
        };
        provider.prepareTargetInfobaseForVanessa = async () => undefined;
        provider.saveScenarioCustomInfobasePath = async () => undefined;
        provider.getRunOutputChannel = () => ({});
        const launch = await provider.prepareVanessaLaunchContext('file:///tests/one/login.feature', 'login', jsonPath, '/startup', root, '/1c');
        assert.equal(defaultBase, '/test');
        const runtime = JSON.parse(fs.readFileSync(launch.vaParamsJsonPath, 'utf8'));
        assert.equal(runtime.GlobalVars.ReportingConnection, 'File="/reporting";');
        assert.equal(runtime.TestClient.datatestclients[0].PathToInfobase, 'File="/selected";');
        fs.rmSync(launch.vaParamsJsonPath, { force: true });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tracked standalone runs retain the failed coordinate when later scenarios pass', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-feature-tracked-'));
    try {
        const provider = providerWithFeatures();
        const id = 'file:///tests/one/login.feature';
        const logPath = path.join(root, 'run.log');
        fs.writeFileSync(logPath, [
            'Feature: /tests/one/login.feature', 'Scenario: Declined login',
            '(8). Step: Then login succeeds', 'Step (Then login succeeds) failed', 'ErrorFileJson: /tmp/failure.json',
            'Scenario: Existing session', '(15). Step: Then session opens', 'PASSED: 1', 'FAILED: 1', ''
        ].join('\n'));
        const tracker = {
            runLogPath: logPath, runLogKey: logPath, scenarioKey: id, scenarioName: 'login',
            lastLength: 0, startOffset: 0, pendingTail: '', status: 'running', isPolling: false,
            featureLineVisitCounts: new Map(), latestFeatureLineNumber: 15
        };
        provider.getTrackedRunsMapForScenario = () => new Map([[logPath, tracker]]);
        provider.getFeatureProgressInfo = () => undefined;
        provider.applyTrackedRunStepSyncLogLine = () => undefined;
        provider.getActiveTrackedRunForScenario = () => undefined;
        provider.stopTrackedRunLogWatcherPolling = () => undefined;
        provider.sendRunArtifactsStateToWebview = () => undefined;
        await provider.pollTrackedRunLogWatcher(id, logPath);
        assert.equal(tracker.status, 'failed');
        assert.equal(tracker.latestFeatureLineNumber, 8);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
