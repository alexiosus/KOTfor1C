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
        EventEmitter: class {}, Uri: { file: (value: string) => ({ fsPath: value, scheme: 'file', toString: () => `file://${value}` }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: root } }],
            getConfiguration: () => ({ get: (key: string) => key === 'runVanessa.vanessaEpfPath' ? epf : undefined })
        },
        window: {
            showQuickPick: async () => undefined,
            showInputBox: async () => assert.fail('A saved debug set must not prompt for credentials'),
            showErrorMessage: async (message: string) => { notices.push(message); },
            showInformationMessage: async (message: string) => { notices.push(message); }
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
            if (name === './oneCInfobaseConnection') { return infobaseConnection; }
            if (name === './standaloneFeatureLaunch') { return standaloneFeatureLaunch; }
            if (name === './directProcessLaunch') { return directProcessLaunch; }
            if (name === './processCommandDisplay') { return processCommandDisplay; }
            if (name === './deferredLoader') { return { createDeferredLoader: (factory: unknown) => factory }; }
            if (name === './oneCPlatform.js') { return { resolveOneCPlatformForLaunch: async () => { platformSelections++; return { clientExePath: executable }; } }; }
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
        processHost, realDetached: module.exports.PhaseSwitcherProvider.prototype.execute1CProcessDetached.bind(provider),
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
