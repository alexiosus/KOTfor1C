import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import * as defaults from '../src/yamlParameterDefaults';
import * as parameters from '../src/compilerBuildParameters';

function harness(initial: Record<string, string> = {}) {
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.readFileSync('src/scenarioScanRoot.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const state = new Map(Object.entries(initial));
    const context = { workspaceState: { get: (key: string, fallback: string) => state.get(key) ?? fallback,
        update: async (key: string, value: string) => { state.set(key, value); } } };
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, require: (name: string) => {
        if (name === 'vscode') { return { EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
            workspace: { getConfiguration: () => ({ get: () => undefined }) } }; }
        if (name === './yamlParameterDefaults') { return defaults; }
        if (name === './compilerBuildParameters') { return parameters; }
        return require(name);
    } });
    const api = module.exports as { initializeScenarioScanRoot(context: unknown, rows?: readonly parameters.CompilerBuildParameter[]): string;
        getScenarioScanRootPath(): string; getProcessScanRootPath(): string };
    return { api, context, state };
}

test('startup roots follow the active profile before discovery rather than stale cached roots', () => {
    const { api, context, state } = harness({ 'kotTestToolkit.scenarioScanRoot': 'old', 'kotTestToolkit.processScanRoot': 'old-processes' });
    api.initializeScenarioScanRoot(context, [{ key: 'ScenarioFolder', value: 'current/scenarios' }, { key: 'ProcessFolder', value: 'current/processes' }]);
    assert.equal(api.getScenarioScanRootPath(), 'current/scenarios');
    assert.equal(api.getProcessScanRootPath(), 'current/processes');
    assert.equal(state.get('kotTestToolkit.scenarioScanRoot'), 'current/scenarios');
});

test('startup TestFolder overrides both roots and absent ProcessFolder inherits scenarios', () => {
    const { api, context } = harness({ 'kotTestToolkit.processScanRoot': 'stale' });
    api.initializeScenarioScanRoot(context, [{ key: 'ScenarioFolder', value: 'scenarios' }]);
    assert.equal(api.getProcessScanRootPath(), 'scenarios');
    api.initializeScenarioScanRoot(context, [{ key: 'ScenarioFolder', value: 'ignored' }, { key: 'ProcessFolder', value: 'ignored' }, { key: 'TestFolder', value: 'shared' }]);
    assert.equal(api.getScenarioScanRootPath(), 'shared');
    assert.equal(api.getProcessScanRootPath(), 'shared');
});

test('fresh discovery uses the same default tests root as a new compiler profile', () => {
    const { api, context } = harness();
    assert.equal(api.initializeScenarioScanRoot(context), 'tests/');
    assert.equal(api.getProcessScanRootPath(), 'tests/');
});
