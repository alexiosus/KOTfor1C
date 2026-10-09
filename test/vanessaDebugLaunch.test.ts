import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

test('debug launch uses the built JSON without opening the auto-run infobase preparation flow', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-debug-launch-'));
    const executablePath = path.join(tempDirectory, '1cv8.exe');
    const epfPath = path.join(tempDirectory, 'vanessa.epf');
    const jsonPath = path.join(tempDirectory, 'launch.json');
    fs.writeFileSync(executablePath, 'client');
    fs.writeFileSync(epfPath, 'epf');
    fs.writeFileSync(jsonPath, JSON.stringify({ LaunchDBFolder: tempDirectory }));
    let designerResolutionCalls = 0;

    const vscode = {
        EventEmitter: class {},
        Uri: { file: (value: string) => ({ fsPath: value, scheme: 'file', toString: () => `file://${value}` }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: tempDirectory } }],
            getConfiguration: () => ({
                get: (key: string) => key === 'runVanessa.vanessaEpfPath' ? epfPath : undefined
            })
        },
        window: {
            showErrorMessage: () => Promise.resolve(undefined),
            showWarningMessage: () => Promise.resolve(undefined)
        }
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
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
            if (specifier === 'child_process') {
                return {};
            }
            if (specifier === './deferredLoader') {
                return { createDeferredLoader: (factory: () => Promise<unknown>) => factory };
            }
            if (specifier === './oneCPlatform.js') {
                return {
                    resolveOneCPlatformForLaunch: async () => ({ clientExePath: executablePath }),
                    resolveOneCDesignerExePath: () => {
                        designerResolutionCalls += 1;
                        return executablePath;
                    }
                };
            }
            if (specifier === './infobaseManager.js') {
                return { updateManagedInfobaseMetadata: async () => undefined };
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

    const Provider = moduleObject.exports.PhaseSwitcherProvider as { prototype: object };
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    let preparationCalls = 0;
    let detachedArguments: string[] | undefined;
    provider._context = {};
    provider.t = (message: string) => message;
    provider.ensureSharedStartupInfobaseReady = async () => ({
        infobaseDirectory: tempDirectory,
        authentication: {}
    });
    provider.resolvePathFromWorkspaceSetting = (value: string) => value;
    provider.prepareVanessaLaunchContext = async () => {
        preparationCalls += 1;
        return {
            startupInfobasePath: tempDirectory,
            scenarioInfobasePath: tempDirectory,
            vaParamsJsonPath: jsonPath,
            jsonWasPatched: false
        };
    };
    provider.buildStartupParams = () => [];
    provider.getRunOutputChannel = () => ({ clear: () => undefined, show: () => undefined });
    provider.shouldShowVanessaOutputPanel = () => false;
    provider.outputInfo = () => undefined;
    provider.outputAdvanced = () => undefined;
    provider.resolveVanessaLogPathFromJson = () => undefined;
    provider.execute1CProcessDetached = async (_executable: string, args: string[]) => {
        detachedArguments = args;
    };

    try {
        const result = await provider.runScenarioInVanessaBuiltIn(
            'Debug scenario',
            'json',
            jsonPath,
            {
                scenarioKey: 'file:///scenario/scen.yaml',
                scenarioName: 'Debug scenario',
                sourceUri: vscode.Uri.file('/scenario/scen.yaml'),
                jsonPath,
                builtAt: Date.now()
            },
            { manualDebug: true }
        );

        assert.equal(result, 'started');
        assert.equal(designerResolutionCalls, 0);
        assert.equal(preparationCalls, 0);
        assert.ok(detachedArguments?.includes('/C'));
        assert.ok(detachedArguments?.some(argument => argument.includes(`VAParams=${jsonPath}`)));
        assert.ok(detachedArguments?.some(argument => argument.includes('UseEditor')));
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('top-level debug opens standalone Vanessa without selecting a built scenario', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const vscode = {
        EventEmitter: class {},
        window: {
            showQuickPick: async (items: Array<{ value: string }>) => items.find(item => item.value === 'debug')
        }
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return vscode;
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

    const Provider = moduleObject.exports.PhaseSwitcherProvider as { prototype: object };
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    let standaloneLaunches = 0;
    let scenarioSelections = 0;
    provider.t = (message: string) => message;
    provider.openVanessaStandaloneDebug = async () => {
        standaloneLaunches += 1;
    };
    provider.openScenarioInVanessaManualFromCommandPalette = async () => {
        scenarioSelections += 1;
    };

    await provider.openVanessaFromSidebar();

    assert.equal(standaloneLaunches, 1);
    assert.equal(scenarioSelections, 0);
});

test('automated launch removes the stale log before arming tracking and starting Vanessa', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-run-log-order-'));
    const executablePath = path.join(tempDirectory, '1cv8.exe');
    const epfPath = path.join(tempDirectory, 'vanessa.epf');
    const jsonPath = path.join(tempDirectory, 'launch.json');
    const runLogPath = path.join(tempDirectory, 'scenario.log');
    fs.writeFileSync(executablePath, 'client');
    fs.writeFileSync(epfPath, 'epf');
    fs.writeFileSync(jsonPath, JSON.stringify({ ScenarioLogFile: runLogPath }));
    const events: string[] = [];
    const vscode = {
        EventEmitter: class {},
        Uri: { file: (value: string) => ({ fsPath: value, scheme: 'file', toString: () => `file://${value}` }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: tempDirectory } }],
            getConfiguration: () => ({
                get: (key: string) => key === 'runVanessa.vanessaEpfPath' ? epfPath : undefined
            })
        },
        window: {
            showErrorMessage: () => Promise.resolve(undefined),
            showWarningMessage: () => Promise.resolve(undefined)
        }
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
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
            if (specifier === 'child_process') {
                return {};
            }
            if (specifier === './deferredLoader') {
                return { createDeferredLoader: (factory: () => Promise<unknown>) => factory };
            }
            if (specifier === './oneCPlatform.js') {
                return {
                    resolveOneCPlatformForLaunch: async () => ({ clientExePath: executablePath }),
                    resolveOneCDesignerExePath: () => executablePath
                };
            }
            if (specifier === './infobaseManager.js') {
                return { updateManagedInfobaseMetadata: async () => undefined };
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

    const Provider = moduleObject.exports.PhaseSwitcherProvider as { prototype: object };
    const provider = Object.create(Provider.prototype) as Record<string, any>;
    provider._context = {};
    provider.t = (message: string) => message;
    provider.ensureSharedStartupInfobaseReady = async () => ({
        infobaseDirectory: tempDirectory,
        authentication: {}
    });
    provider.resolvePathFromWorkspaceSetting = (value: string) => value;
    provider.prepareVanessaLaunchContext = async () => ({
        startupInfobasePath: tempDirectory,
        scenarioInfobasePath: tempDirectory,
        vaParamsJsonPath: jsonPath,
        jsonWasPatched: false
    });
    provider.buildStartupParams = () => [];
    provider.getRunOutputChannel = () => ({ clear: () => undefined, show: () => undefined });
    provider.shouldShowVanessaOutputPanel = () => false;
    provider.outputInfo = () => undefined;
    provider.outputAdvanced = () => undefined;
    provider.resolveVanessaLogPathFromJson = () => runLogPath;
    provider.cleanupVanessaRunLogFileBeforeRun = () => events.push('cleanup-log');
    provider.cleanupVanessaStatusFileBeforeRun = () => events.push('cleanup-status');
    provider.attachRunLogToRunningScenario = () => events.push('attach-tracker');
    provider.execute1CProcess = async () => { events.push('execute'); };
    provider.validateVanessaRunLogFromJson = () => ({ ok: true });

    try {
        const result = await provider.runScenarioInVanessaBuiltIn(
            'Scenario',
            'json',
            jsonPath,
            {
                scenarioKey: 'file:///scenario/scen.yaml',
                scenarioName: 'Scenario',
                sourceUri: vscode.Uri.file('/scenario/scen.yaml'),
                jsonPath,
                builtAt: Date.now()
            }
        );

        assert.equal(result, 'started');
        assert.deepEqual(events, ['cleanup-log', 'cleanup-status', 'attach-tracker', 'execute']);
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
