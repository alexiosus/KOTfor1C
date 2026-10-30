import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import * as debugClients from '../src/vanessaDebugClients';
import * as debugConfiguration from '../src/vanessaDebugClientConfiguration';
import * as vanessaLaunchJson from '../src/vanessaLaunchJson';
import * as vanessaControlLaunch from '../src/vanessaControlLaunch';
import * as infobaseConnection from '../src/oneCInfobaseConnection';
import * as standaloneFeatureLaunch from '../src/standaloneFeatureLaunch';
import * as directProcessLaunch from '../src/directProcessLaunch';
import * as processCommandDisplay from '../src/processCommandDisplay';

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-saved-debug-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executable = path.join(root, '1cv8'); const epf = path.join(root, 'vanessa.epf');
    fs.writeFileSync(executable, 'client'); fs.writeFileSync(epf, 'epf');
    const state = new Map<string, unknown>(); const secrets = new Map<string, string>();
    const context = {
        workspaceState: { get: <T>(key: string) => state.get(key) as T | undefined, update: async (key: string, value: unknown) => { state.set(key, value); } },
        secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } }
    };
    const store = new debugClients.VanessaDebugClientStore(context.workspaceState, context.secrets);
    const notices: string[] = []; const output: string[] = []; const launched: Array<{ args: string[]; onExit?: () => void }> = [];
    const processHost = { spawn: (..._args: unknown[]): unknown => assert.fail('Do not run 1C in tests') };
    let platformSelections = 0; let startupPreparations = 0;
    const vscode = {
        ProgressLocation: { Notification: 15 },
        EventEmitter: class {}, Uri: { file: (value: string) => ({ fsPath: value, scheme: 'file', toString: () => `file://${value}` }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: root } }],
            getConfiguration: () => ({ get: (key: string) => key === 'runVanessa.vanessaEpfPath' ? epf : undefined })
        },
        window: {
            withProgress: async (_options: unknown, work: () => Promise<unknown>) => work(),
            showQuickPick: async () => undefined,
            showInputBox: async () => assert.fail('A saved debug set must not prompt for credentials'),
            showErrorMessage: async (message: string) => { notices.push(message); },
            showInformationMessage: async (message: string) => { notices.push(message); },
            showWarningMessage: async (_message: string, ..._options: unknown[]): Promise<string | undefined> => undefined
        }
    };
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/phaseSwitcher.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const module = { exports: {} as any };
    vm.runInNewContext(compiled, {
        module, exports: module.exports, Buffer, console, process, setImmediate, setTimeout, clearTimeout, setInterval, clearInterval,
        require: (name: string) => {
            if (name === 'vscode') { return vscode; }
            if (name === 'child_process') { return processHost; }
            if (['fs', 'path', 'os', 'node:crypto'].includes(name)) { return require(name); }
            if (name === './vanessaDebugClients') { return debugClients; }
            if (name === './vanessaDebugClientConfiguration.js') { return debugConfiguration; }
            if (name === './vanessaLaunchJson') { return vanessaLaunchJson; }
            if (name === './vanessaControlLaunch') { return vanessaControlLaunch; }
            if (name === './oneCInfobaseConnection') { return infobaseConnection; }
            if (name === './standaloneFeatureLaunch') { return standaloneFeatureLaunch; }
            if (name === './directProcessLaunch') { return directProcessLaunch; }
            if (name === './processCommandDisplay') { return processCommandDisplay; }
            if (name === './deferredLoader') { return { createDeferredLoader: (factory: unknown) => factory }; }
            if (name === './oneCPlatform.js') { return { resolveOneCPlatformForLaunch: async () => { platformSelections++; return { clientExePath: executable }; } }; }
            if (name === './startupInfobase.js') { return { ensureSharedStartupInfobaseMcpReady: async () => undefined }; }
            if (name === './infobaseManager.js') { return { updateManagedInfobaseMetadata: async () => undefined }; }
            return {};
        }
    });
    const provider = Object.create(module.exports.PhaseSwitcherProvider.prototype) as any;
    provider._context = context;
    provider._isBuildInProgress = false;
    provider._standaloneFeatureArtifacts = new Map();
    provider.t = (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/gu, (_, index) => String(args[Number(index)]));
    provider.resolveVanessaRuntimeDirectory = () => path.join(root, 'runtime');
    provider.ensureSharedStartupInfobaseReady = async () => { startupPreparations++; return { infobaseDirectory: '/bases/manager', authentication: {} }; };
    provider.resolvePathFromWorkspaceSetting = (value: string) => value;
    provider.loadVanessaLaunchOverlayParameters = async () => ({ additionalParameters: [], globalVariables: [] });
    provider.buildStartupParams = () => [];
    provider.getRunOutputChannel = () => ({ clear() {}, show() {} });
    provider.shouldShowVanessaOutputPanel = () => false;
    provider.outputInfo = (_channel: unknown, message: string) => output.push(message);
    provider.outputAdvanced = (_channel: unknown, message: string) => output.push(message);
    provider.outputError = (_channel: unknown, message: string) => output.push(message);
    provider.resolveVanessaLogPathFromJson = () => undefined;
    provider.prepareVanessaLaunchContext = async () => assert.fail('Manual debug must not prepare the test infobase');
    provider.execute1CProcessDetached = async (_exe: string, args: string[], _cwd: string, _title: string, _output: unknown, onExit?: () => void) => { launched.push({ args, onExit }); };
    const saved: debugClients.VanessaDebugClientSelection = {
        mode: 'clients', clients: [
            { id: 'one', name: 'TestClient', infobase: '/bases/sales', username: 'admin', password: 'password-one', synonym: '', clientType: 'Thin', computerName: 'localhost', port: 1538, additionalParameters: '/P"extra-secret"' },
            { id: 'two', name: 'Warehouse', infobase: 'Srvr="server";Ref="warehouse";Pwd="embedded-secret";', username: '', password: '', synonym: '', clientType: 'Thin', computerName: 'localhost', port: 1539, additionalParameters: '' }
        ]
    };
    const runtimePath = () => {
        const value = launched.at(-1)?.args.find(argument => argument.includes('VAParams='))?.match(/VAParams=([^;]+)/u)?.[1];
        assert.ok(value); return value;
    };
    return { root, provider, store, saved, launched, notices, output, state, secrets, runtimePath,
        processHost, window: vscode.window, realDetached: module.exports.PhaseSwitcherProvider.prototype.execute1CProcessDetached.bind(provider),
        preparations: () => ({ platformSelections, startupPreparations }) };
}

test('general Debug applies a saved multi-client set and removes its private parameters after process exit', async t => {
    const f = fixture(t); await f.store.save(f.saved);
    await f.provider.openVanessaStandaloneDebug();
    assert.equal(f.launched.length, 1);
    const runtimePath = f.runtimePath();
    const json = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    assert.equal(json.ExecuteScenarios, false);
    assert.equal(json.CloseSystemOnComplete, false);
    assert.deepEqual(json.TestClient.datatestclients.map((client: any) => [client.Name, client.PortTestClient]), [['TestClient', 1538], ['Warehouse', 1539]]);
    assert.equal(json.TestClient.datatestclients[0].PathToInfobase, 'File="/bases/sales";');
    assert.ok(json.TestClient.datatestclients[0].AddItionalParameters.includes('/P"password-one"'));
    assert.equal(json.TestClient.datatestclients[1].PathToInfobase, 'Srvr="server";Ref="warehouse";');
    assert.equal(json.TestClient.datatestclients[1].AddItionalParameters, '/N"" /P"embedded-secret"');
    for (const secret of ['password-one', 'embedded-secret', 'extra-secret']) {
        assert.equal(JSON.stringify(f.output).includes(secret), false);
        assert.equal(JSON.stringify(f.notices).includes(secret), false);
        assert.equal(JSON.stringify([...f.state.values()]).includes(secret), false);
    }
    await f.launched[0].onExit?.();
    // The real callback schedules asynchronous cleanup; await the provider's remaining release too.
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let attempt = 0; fs.existsSync(runtimePath) && attempt < 10; attempt++) { await new Promise<void>(resolve => setTimeout(resolve, 5)); }
    assert.equal(fs.existsSync(runtimePath), false);
});

test('Connect managed Vanessa does not ask for or apply the legacy saved Debug clients', async t => {
    const f = fixture(t); await f.store.save(f.saved);
    f.provider.resolveVanessaDebugClientsForLaunch = () => assert.fail('Connect must not configure or apply saved Debug clients');
    assert.equal(await f.provider.openVanessaManagedControl(9876), true);
    const json = JSON.parse(fs.readFileSync(f.runtimePath(), 'utf8'));
    assert.equal(json.ExecuteScenarios, false); assert.equal(json.TestClient, undefined);
});

test('re-entered clients recover missing secrets only after explicit whole-catalog replacement confirmation', async t => {
    const f = fixture(t); await f.store.save(f.saved); f.secrets.clear();
    const original = JSON.stringify([...f.state]);
    const entered = { mode: 'clients', clients: [f.saved.clients[0]] };
    f.provider.editVanessaDebugClients = async () => entered;
    await f.provider.configureVanessaDebugClients();
    assert.equal(JSON.stringify([...f.state]), original, 'cancel must preserve unavailable local identities');
    f.window.showWarningMessage = async (_message, ...options) => options.includes('Replace unavailable saved catalog') ? 'Replace unavailable saved catalog' : undefined;
    await f.provider.configureVanessaDebugClients();
    assert.deepEqual(await f.store.load(), entered);
    assert.equal((await f.store.loadCatalog()).length, 1);
    assert.deepEqual(f.launched, []);
});

test('standalone feature Debug targets the authored feature in a runtime copy and retains the original custom JSON', async t => {
    const f = fixture(t); await f.store.save(f.saved);
    const jsonPath = path.join(f.root, 'custom standalone params.json');
    const featurePath = path.join(f.root, 'login.feature');
    const original = '\uFEFF' + JSON.stringify({ featurepath: '/other/features', FeaturesToRun: ['other.feature'],
        ВыполнитьСценарии: true, ЗавершитьРаботуСистемы: true,
        КлиентТестирования: { ДанныеКлиентовТестирования: [{ Имя: 'TestClient', ПутьКИнфобазе: 'old', Custom: 7 }] },
        GlobalVars: { featurepath: 'business value' } });
    fs.writeFileSync(jsonPath, original);
    const artifact = { scenarioKey: 'file:///login.feature', scenarioName: 'login', jsonPath, featurePath, sourceUri: { fsPath: featurePath } };
    f.provider._standaloneFeatureArtifacts.set(artifact.scenarioKey, artifact);
    const result = await f.provider.runScenarioInVanessaBuiltIn('login', 'feature', featurePath, artifact, { manualDebug: true });
    assert.equal(result, 'started');
    const runtime = JSON.parse(fs.readFileSync(f.runtimePath(), 'utf8'));
    assert.equal(runtime.featurepath, featurePath);
    assert.deepEqual(runtime.FeaturesToRun, [featurePath]);
    assert.equal(runtime.ВыполнитьСценарии, false);
    assert.equal(runtime.ЗавершитьРаботуСистемы, false);
    assert.equal(runtime.КлиентТестирования.ДанныеКлиентовТестирования[0].Custom, 7);
    assert.equal(runtime.GlobalVars.featurepath, 'business value');
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), original);
    assert.equal(artifact.jsonPath, jsonPath);
    assert.equal(JSON.stringify(f.output).includes('password-one'), false);
});

test('cancelling first-time debug setup prevents both general and built-test process preparation and launch', async t => {
    const f = fixture(t);
    await f.provider.openVanessaStandaloneDebug();
    const result = await f.provider.runScenarioInVanessaBuiltIn('test', 'json', '/launch.json', { scenarioKey: 'test', jsonPath: '/launch.json' }, { manualDebug: true });
    assert.equal(result, 'aborted');
    assert.equal(f.launched.length, 0);
    assert.deepEqual(f.preparations(), { platformSelections: 0, startupPreparations: 0 });
    assert.equal(f.state.size, 0);
});

test('malformed authored debug JSON aborts safely without logging its secret contents or launching the original', async t => {
    const f = fixture(t); await f.store.save(f.saved);
    const jsonPath = path.join(f.root, 'broken.json'); fs.writeFileSync(jsonPath, '{"Pwd":"secret-source",broken');
    const result = await f.provider.runScenarioInVanessaBuiltIn('broken', 'json', jsonPath, { scenarioKey: 'broken', jsonPath }, { manualDebug: true });
    assert.equal(result, 'aborted'); assert.equal(f.launched.length, 0);
    assert.equal(JSON.stringify(f.notices).includes('secret-source'), false);
    assert.equal(JSON.stringify(f.output).includes('secret-source'), false);
});

test('spawn failure removes newly created secret-bearing debug parameters', async t => {
    const f = fixture(t); await f.store.save(f.saved);
    let runtimePath: string | undefined;
    f.provider.execute1CProcessDetached = async (_exe: string, args: string[]) => {
        runtimePath = args.find(argument => argument.includes('VAParams='))?.match(/VAParams=([^;]+)/u)?.[1];
        throw new Error('spawn failed');
    };
    await f.provider.openVanessaStandaloneDebug();
    assert.ok(runtimePath); assert.equal(fs.existsSync(runtimePath), false);
});

test('detached launcher waits for spawn and its real exit listener removes the runtime parameters', async t => {
    const f = fixture(t); await f.store.save(f.saved);
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    let unreferenced = false;
    child.unref = () => { unreferenced = true; };
    f.processHost.spawn = () => {
        setImmediate(() => child.emit('spawn'));
        return child;
    };
    f.provider.execute1CProcessDetached = f.realDetached;
    await f.provider.openVanessaStandaloneDebug();
    assert.equal(unreferenced, true);
    const runtimePath = [...f.provider._vanessaDebugRuntimeFiles.keys()][0] as string;
    assert.ok(fs.existsSync(runtimePath));
    child.emit('exit', 0);
    for (let attempt = 0; fs.existsSync(runtimePath) && attempt < 10; attempt++) { await new Promise<void>(resolve => setTimeout(resolve, 5)); }
    assert.equal(fs.existsSync(runtimePath), false);
});

test('manual/control launch carries the active Additional Vanessa generator language into its private VAParams', async t => {
    const f = fixture(t); await f.store.save(f.saved);
    f.provider.loadVanessaLaunchOverlayParameters = async () => ({ additionalParameters: [{ key: 'gherkinlanguage', value: 'en', valueKind: 'string', overrideExisting: true }], globalVariables: [] });
    await f.provider.openVanessaStandaloneDebug();
    const json = JSON.parse(fs.readFileSync(f.runtimePath(), 'utf8'));
    assert.equal(json.gherkinlanguage, 'en'); assert.equal(json.Lang, 'en');
    assert.ok(f.launched[0].args.some((arg: string) => arg.includes('VAParams=')));
});

test('built feature control JSON applies the active profile language and defaults without changing authored JSON', async t => {
    const f = fixture(t); await f.store.save(f.saved);
    const jsonPath = path.join(f.root, 'params.json');
    const original = JSON.stringify({ Lang: 'ru', gherkinlanguage: 'ru', GlobalVars: { existing: 'kept' } });
    fs.writeFileSync(jsonPath, original);
    f.provider.loadVanessaLaunchOverlayParameters = async () => ({
        additionalParameters: [{ key: 'gherkinlanguage', value: 'en', valueKind: 'string', overrideExisting: true }],
        globalVariables: []
    });
    const launch = await f.provider.createVanessaDebugLaunchContext(jsonPath, '/bases/manager', f.root, f.saved);
    const json = JSON.parse(fs.readFileSync(launch.vaParamsJsonPath, 'utf8'));
    assert.equal(json.gherkinlanguage, 'en'); assert.equal(json.Lang, 'en');
    assert.deepEqual(json.GlobalVars, { existing: 'kept' });
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), original);
    const fallback = await f.provider.writeVanessaManualDebugJson({}, { mode: 'scenario', clients: [] }, 'managed-play', f.root);
    const defaults = JSON.parse(fs.readFileSync(fallback, 'utf8'));
    assert.equal(defaults.Lang, 'en'); assert.equal(defaults.gherkinlanguage, 'en');
});

test('managed runtime language overlay preserves the already prepared test infobase and feature target', async t => {
    const f = fixture(t);
    f.provider.loadVanessaLaunchOverlayParameters = async () => ({ additionalParameters: [
        { key: '/TestClient/datatestclients/0/PathToInfobase', value: 'File="/profile-original-base";', valueKind: 'string', overrideExisting: true },
        { key: 'featurepath', value: '/profile-original.feature', valueKind: 'string', overrideExisting: true },
        { key: '/gherkinlanguage', value: 'en', valueKind: 'string', overrideExisting: true }
    ], globalVariables: [{ key: 'Prepared', value: 'false', overrideExisting: true }] });
    const prepared = { TestClient: { datatestclients: [{ PathToInfobase: 'File="/chosen-prepared-base";' }] },
        featurepath: '/chosen.feature', GlobalVars: { Prepared: true } };
    const runtime = await f.provider.writeVanessaManualDebugJson(prepared, { mode: 'scenario', clients: [] }, 'managed', f.root);
    const json = JSON.parse(fs.readFileSync(runtime, 'utf8'));
    assert.equal(json.TestClient.datatestclients[0].PathToInfobase, 'File="/chosen-prepared-base";');
    assert.equal(json.featurepath, '/chosen.feature'); assert.deepEqual(json.GlobalVars, { Prepared: true });
    assert.equal(json.gherkinlanguage, 'en'); assert.equal(json.Lang, 'en');
});

test('MCP runtime uses native library file search before VanessaExt is connected without changing the source or ordinary Debug', async t => {
    const f = fixture(t);
    const original = { useaddin: true, SearchingForFilesUsingTheVanessaExtComponent: true, logtotext: false, logstepstotext: false };
    const managed = await f.provider.writeVanessaManualDebugJson(original, { mode: 'scenario', clients: [] }, 'mcp', f.root, 9876);
    const json = JSON.parse(fs.readFileSync(managed, 'utf8'));
    assert.equal(json.SearchingForFilesUsingTheVanessaExtComponent, false); assert.equal(json.useaddin, true);
    assert.equal(typeof json.ИмяФайлаЛогВыполненияСценариев, 'string');
    assert.ok(path.isAbsolute(json.ИмяФайлаЛогВыполненияСценариев));
    assert.ok(json.ИмяФайлаЛогВыполненияСценариев.startsWith(f.root));
    assert.equal(json.ИмяФайлаЛогВыполненияСценариев, path.join(f.root, 'runtime', 'logs', 'vanessa-mcp-9876.log').replace(/\\/gu, '/'));
    const second = await f.provider.writeVanessaManualDebugJson({}, { mode: 'scenario', clients: [] }, 'other-feature', f.root, 9876);
    assert.equal(JSON.parse(fs.readFileSync(second, 'utf8')).ИмяФайлаЛогВыполненияСценариев, json.ИмяФайлаЛогВыполненияСценариев);
    assert.equal(json.logtotext, true);
    assert.equal(original.logtotext, false);
    assert.equal(json.logstepstotext, true);
    assert.equal(original.logstepstotext, false);
    assert.equal(original.ИмяФайлаЛогВыполненияСценариев, undefined);
    assert.equal(original.SearchingForFilesUsingTheVanessaExtComponent, true);
    const debug = await f.provider.writeVanessaManualDebugJson(original, { mode: 'scenario', clients: [] }, 'debug', f.root);
    const debugJson = JSON.parse(fs.readFileSync(debug, 'utf8'));
    assert.equal(debugJson.SearchingForFilesUsingTheVanessaExtComponent, true);
    assert.equal(debugJson.logtotext, false);
    assert.equal(debugJson.logstepstotext, false);
});

test('Reload Window preserves a detached MCP manager startup JSON for log recovery and cleans ordinary debug copies', async t => {
    const f = fixture(t);
    const managed = await f.provider.writeVanessaManualDebugJson({}, { mode: 'scenario', clients: [] }, 'managed', f.root, 9876);
    const debug = await f.provider.writeVanessaManualDebugJson({}, { mode: 'scenario', clients: [] }, 'debug', f.root);
    f.provider._managedVanessaLogsByPort = new Map([[9876, { jsonPath: managed, logPath: '/session.log' }]]);
    await f.provider.disposeVanessaDebugRuntimeFiles();
    assert.equal(fs.existsSync(managed), true); assert.equal(fs.existsSync(debug), false);
});
