import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import * as activeProfiles from '../src/activeYamlParametersProfile';
import * as defaults from '../src/yamlParameterDefaults';
import * as compilerParameters from '../src/compilerBuildParameters';
import * as compilerValueValidation from '../src/compilerBuildValueValidation';

interface Parameter { key: string; value: string }
interface TestManager {
    getDefaultParameters(): Parameter[];
    loadProfileSnapshot(id: string): Promise<activeProfiles.ActiveYamlParametersProfile | undefined>;
    createYamlParametersFile(target: string, parameters: Parameter[]): Promise<void>;
}

function createManager(buildParameters: unknown[], showDriveFeatures = false, configuration: Record<string, unknown> = {}, version = 4): TestManager {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/yamlParametersManager.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const saved = JSON.stringify({ version, activeProfileId: 'synthetic', profiles: [{
        id: 'synthetic', name: 'Synthetic fixture', buildParameters,
        additionalVanessaParameters: [], globalVanessaVariables: []
    }] });
    const context = { subscriptions: [], secrets: { get: async () => saved, store: async () => {} } };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject, exports: moduleObject.exports, console: { ...console, error() {} }, Buffer, process,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return { EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
                    workspace: { workspaceFolders: [{ uri: { fsPath: '/project' } }], getConfiguration: () => ({
                        get: (key: string, fallback?: unknown) => key === 'assembleScript.showDriveFeatures' ? showDriveFeatures : configuration[key] ?? fallback
                    }) }, l10n: { t: (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)] ?? '') } };
            }
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
    return (moduleObject.exports.YamlParametersManager as { getInstance(context: unknown): TestManager }).getInstance(context);
}

const launchParameters: Parameter[] = [
    { key: 'ScenarioFolder', value: 'tests' }, { key: 'FeatureFolder', value: 'features' },
    { key: 'VanessaFolder', value: 'tools/vanessa' }, { key: 'LaunchDBFolder', value: 'bases/qa' },
    { key: 'AuthCompile', value: 'False' }
];

test('default compiler profile enables launch and diagnostic artifacts in the configured runtime directory', () => {
    const rows = createManager([], false, { 'runtime.directory': 'artifacts/kot' }).getDefaultParameters();
    const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
    assert.equal(values.ExternalMode, 'True');
    assert.equal(values.CreateJson, 'True');
    assert.equal(values.CreateJUnit, 'True');
    assert.equal(values.CreateModellingXML, 'True');
    assert.equal(values.AuthCompile, 'False');
    assert.equal(values.Libraries, '');
    assert.equal(values.AllureFolder, path.join('artifacts/kot', 'reports', 'allure'));
    assert.equal(values.JUnitFolder, path.join('artifacts/kot', 'reports', 'junit'));
    assert.equal(values.BDDLogFolder, path.join('artifacts/kot', 'logs', 'errors'));
    assert.equal(values.ScreenshotsFolder, path.join('artifacts/kot', 'screenshots'));
    assert.equal('SplitFeatureFiles' in values, false);
});

test('existing profiles gain missing diagnostic defaults without overwriting explicit values or report aliases', async () => {
    const profile = await createManager([...launchParameters,
        { key: 'CreateJson', value: false }, { key: 'CreateJUnit', value: '' },
        { key: 'CreateModellingXML', value: false }, { key: 'AllurePath', value: 'custom/allure' },
        { key: 'JUnitPath', value: 'custom/junit' }, { key: 'ScreenshotsPath', value: '' },
        { key: 'BDDLogFolder', value: 'custom/errors' }, { key: 'VanessaLibraries', value: 'custom/lib' }
    ]).loadProfileSnapshot('synthetic');
    const values = Object.fromEntries(profile!.buildParameters.map(row => [row.key, row.value]));
    assert.equal(values.ExternalMode, 'True');
    assert.equal(values.CreateJson, 'false');
    assert.equal(values.CreateJUnit, '');
    assert.equal(values.CreateModellingXML, 'false');
    assert.equal(values.AllurePath, 'custom/allure');
    assert.equal('AllureFolder' in values, false);
    assert.equal('JUnitFolder' in values, false);
    assert.equal('ScreenshotsFolder' in values, false);
    assert.equal(values.BDDLogFolder, 'custom/errors');
    assert.equal('Libraries' in values, false);
});

test('upgraded profiles retain intentionally removed optional rows instead of adding defaults on every load', async () => {
    const profile = await createManager(launchParameters, false, {}, 5).loadProfileSnapshot('synthetic');
    assert.equal(profile!.buildParameters.some(row => row.key === 'CreateModellingXML'), false);
    assert.equal(profile!.buildParameters.some(row => row.key === 'Libraries'), false);
    assert.equal(profile!.buildParameters.some(row => row.key === 'AllureFolder'), false);
});

async function writePayload(manager: TestManager, parameters: Parameter[]): Promise<Record<string, string>> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-compiler-profile-'));
    try {
        const target = path.join(root, 'params.json');
        await manager.createYamlParametersFile(target, parameters);
        return JSON.parse(fs.readFileSync(target, 'utf8'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('compiler JSON preserves metadata, connection strings and command arguments containing separators', async () => {
    const strings = {
        RepoPath: 'https://example.invalid/repo.git', ConfigurationVersion: '1.0.1',
        Branch: 'feature/abc', DetectionTime: '2026-10-11T12:30:00',
        ExtraParams: '/N"Test User" /P"synthetic\\token"', Custom: 'some\\literal/with.a.dot',
        LaunchDBFolder: 'File="C:\\Bases\\QA";', InfobasePath: 'Srvr="server";Ref="QA";'
    };
    const parameters = [...launchParameters.filter(item => !(item.key in strings)),
        ...Object.entries(strings).map(([key, value]) => ({ key, value }))];
    const payload = await writePayload(createManager([]), parameters);
    for (const [key, value] of Object.entries(strings)) {
        assert.equal(payload[key], value, key);
    }
});

test('compiler JSON resolves directory parameters even when they contain no separator', async () => {
    const payload = await writePayload(createManager([]), launchParameters);
    assert.equal(payload.ScenarioFolder, '/project/tests');
    assert.equal(payload.FeatureFolder, '/project/features');
});

test('stored profiles preserve both launch connection roles', async () => {
    const manager = createManager([...launchParameters,
        { key: 'InfobasePath', value: 'Srvr="server";Ref="QA";' }]);
    const profile = await manager.loadProfileSnapshot('synthetic');
    assert.equal(profile?.buildParameters.find(item => item.key === 'LaunchDBFolder')?.value, 'bases/qa');
    assert.equal(profile?.buildParameters.find(item => item.key === 'InfobasePath')?.value, 'Srvr="server";Ref="QA";');
});

test('launch aliases use compiler priority rather than parameter row order', async () => {
    const manager = createManager([
        { key: 'TestClientDBPath', value: 'lower-folder' }, { key: 'LaunchDBFolder', value: 'higher-folder' },
        { key: 'InfobasePath', value: 'Srvr="low";Ref="QA";' }, { key: 'TestClientDB', value: 'Srvr="high";Ref="QA";' }
    ]);
    const profile = await manager.loadProfileSnapshot('synthetic');
    assert.equal(profile?.buildParameters.find(item => item.key === 'LaunchDBFolder')?.value, 'higher-folder');
    assert.equal(profile?.buildParameters.find(item => item.key === 'TestClientDB')?.value, 'Srvr="high";Ref="QA";');
});

test('VanessaPath overrides VanessaFolder on import and normalizes a Windows EPF to its directory', async () => {
    const manager = createManager([
        { key: 'VanessaDir', value: 'old-dir' }, { key: 'VanessaFolder', value: 'old-folder' },
        { key: 'VanessaPath', value: 'C:\\Tools\\Vanessa\\vanessa.epf' }
    ]);
    const profile = await manager.loadProfileSnapshot('synthetic');
    assert.equal(profile?.buildParameters.find(item => item.key === 'VanessaFolder')?.value, 'C:\\Tools\\Vanessa');
});

test('false and zero values survive imported profile normalization', async () => {
    const manager = createManager([...launchParameters,
        { key: 'CreateJson', value: false }, { key: 'ThreadNumber', value: 0 }
    ]);
    const profile = await manager.loadProfileSnapshot('synthetic');
    assert.equal(profile?.buildParameters.find(item => item.key === 'CreateJson')?.value, 'false');
    assert.equal(profile?.buildParameters.find(item => item.key === 'ThreadNumber')?.value, '0');
});

test('TestFolder wins over both scenario and process roots independent of import order', async () => {
    const manager = createManager([
        { key: 'ScenarioFolder', value: 'scenario-only' }, { key: 'ProcessFolder', value: 'process-only' },
        { key: 'TestFolder', value: 'all-tests' }
    ]);
    const profile = await manager.loadProfileSnapshot('synthetic');
    assert.equal(profile?.buildParameters.find(item => item.key === 'ScenarioFolder')?.value, 'all-tests');
    assert.equal(profile?.buildParameters.find(item => item.key === 'ProcessFolder')?.value, 'all-tests');
});

test('explicitly blank model settings survive profile reload', async () => {
    const manager = createManager([...launchParameters, { key: 'ModelDBSettings', value: '' }]);
    const profile = await manager.loadProfileSnapshot('synthetic');
    assert.equal(profile?.buildParameters.find(item => item.key === 'ModelDBSettings')?.value, '');
});

test('stored arrays of libraries are imported with the compiler list separator', async () => {
    const manager = createManager([...launchParameters, { key: 'VanessaLibraries', value: ['lib/one', 'lib/two'] }]);
    const profile = await manager.loadProfileSnapshot('synthetic');
    assert.equal(profile?.buildParameters.find(item => item.key === 'VanessaLibraries')?.value, 'lib/one|lib/two');
    assert.equal(profile?.buildParameters.some(item => item.key === 'Libraries'), false);
});

test('Drive values survive profile reload while stock payloads omit them', async () => {
    const parameters = [...launchParameters, { key: 'SplitFeatureFiles', value: 'True' }];
    const manager = createManager(parameters, false);
    const profile = await manager.loadProfileSnapshot('synthetic');
    assert.equal(profile?.buildParameters.find(item => item.key === 'SplitFeatureFiles')?.value, 'True');
    const payload = await writePayload(manager, parameters);
    assert.equal('SplitFeatureFiles' in payload, false);
    assert.equal((await writePayload(createManager(parameters, true), parameters)).SplitFeatureFiles, 'True');
});

test('feature-only builds do not demand Vanessa or a launch infobase', async () => {
    const parameters = [
        { key: 'ScenarioFolder', value: 'tests' }, { key: 'FeatureFolder', value: 'features' },
        { key: 'ModelDBSettings', value: '' }, { key: 'AuthCompile', value: 'False' }, { key: 'CreateJson', value: 'False' }
    ];
    const payload = await writePayload(createManager([]), parameters);
    assert.equal(payload.CreateJson, 'False');
    assert.equal(payload.ModelDBSettings, '');
});

test('manager rejects invalid DetectionTime before exporting any compiler JSON', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-compiler-invalid-date-'));
    try {
        const manager = createManager(launchParameters);
        const target = path.join(root, 'params.json');
        await assert.rejects(manager.createYamlParametersFile(target, [...launchParameters, { key: 'DetectionTime', value: '2026-02-29T12:30:00' }]), /DetectionTime must be a complete XML date and time/u);
        assert.equal(fs.existsSync(target), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('autosave reports invalid typed draft values while preserving their exact contents', async () => {
    const manager = createManager(launchParameters) as TestManager & {
        persistManagerStateFromMessage(message: unknown, options: unknown): Promise<{ validationErrors: string[]; buildParameters: Parameter[] }>;
    };
    const result = await manager.persistManagerStateFromMessage({ parameters: [...launchParameters, { key: 'DetectionTime', value: 'synthetic-sensitive-draft' }] }, { validateBeforeSave: true, syncScanRoot: false, refreshCombinedArtifacts: false });
    assert.ok(result.validationErrors.some(message => message.includes('DetectionTime must be a complete XML date and time')));
    assert.ok(result.validationErrors.every(message => !message.includes('synthetic-sensitive-draft')));
    assert.equal(result.buildParameters.find(item => item.key === 'DetectionTime')?.value, 'synthetic-sensitive-draft');
});

test('manager definitions expose numeric bounds and verified Boolean DebugMode', () => {
    const manager = createManager(launchParameters) as TestManager & { getBuildParameterDefinitions(): Array<{ key: string; valueKind?: string; min?: number; max?: number; step?: number | string }> };
    const definitions = manager.getBuildParameterDefinitions();
    const port = definitions.find(item => item.key === 'TestClientPort');
    assert.equal(port?.valueKind, 'number'); assert.equal(port?.min, 1); assert.equal(port?.max, 65535); assert.equal(port?.step, 1);
    assert.equal(definitions.find(item => item.key === 'WaitWindowTime')?.step, 'any');
    assert.equal(definitions.find(item => item.key === 'DebugMode')?.valueKind, 'boolean');
    assert.equal(definitions.find(item => item.key === 'DetectionTime')?.valueKind, 'xmlDateTime');
});

test('public manager preflight validates required fields and typed values from a readonly snapshot', () => {
    const manager = createManager(launchParameters) as TestManager & { validateCompilerBuildParameters(parameters: readonly Parameter[]): readonly string[] };
    const parameters = Object.freeze([{ key: 'CreateJson', value: 'False' }, { key: 'TestClientPort', value: '65536' }, { key: 'DetectionTime', value: '0001-02-29T00:00:00' }]);
    const errors = manager.validateCompilerBuildParameters(parameters);
    assert.equal(errors.length, 4);
    assert.ok(errors.some(message => message.includes('ScenarioFolder'))); assert.ok(errors.some(message => message.includes('FeatureFolder')));
    assert.ok(errors.some(message => message.includes('TestClientPort must be an integer'))); assert.ok(errors.some(message => message.includes('DetectionTime must be a complete XML date and time')));
    assert.equal(parameters[1].value, '65536'); assert.equal(parameters[2].value, '0001-02-29T00:00:00');
});
