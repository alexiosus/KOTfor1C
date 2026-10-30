import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

interface AvailabilityHarness {
    provider: Record<string, any>;
    contextValues: Array<{ key: string; value: unknown }>;
    statPaths: string[];
}

function loadAvailabilityHarness(options: {
    driveFeaturesEnabled: boolean;
    firstLaunchFolder: string;
    folderExists: boolean;
    workspaceRoot?: string;
}): AvailabilityHarness {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'phaseSwitcher.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const moduleObject = { exports: {} as Record<string, unknown> };
    const contextValues: Array<{ key: string; value: unknown }> = [];
    const statPaths: string[] = [];
    const workspaceRoot = options.workspaceRoot ?? '/workspace';
    const makeUri = (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` });
    const vscode = {
        EventEmitter: class {},
        Uri: {
            file: (value: string) => makeUri(value),
            joinPath: (base: { fsPath: string }, value: string) => makeUri(path.join(base.fsPath, value))
        },
        commands: {
            executeCommand: async (_command: string, key: string, value: unknown) => {
                contextValues.push({ key, value });
            }
        },
        workspace: {
            workspaceFolders: options.workspaceRoot === '' ? [] : [{ uri: makeUri(workspaceRoot) }],
            getConfiguration: () => ({
                get: (key: string, fallback?: unknown) => {
                    if (key === 'assembleScript.showDriveFeatures') {
                        return options.driveFeaturesEnabled;
                    }
                    if (key === 'paths.firstLaunchFolder') {
                        return options.firstLaunchFolder;
                    }
                    return fallback;
                }
            }),
            fs: {
                stat: async (uri: { fsPath: string }) => {
                    statPaths.push(uri.fsPath);
                    if (!options.folderExists) {
                        throw new Error('missing');
                    }
                    return { type: 2 };
                }
            }
        },
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

    const Provider = moduleObject.exports.PhaseSwitcherProvider as { prototype: object };
    return {
        provider: Object.create(Provider.prototype) as Record<string, any>,
        contextValues,
        statPaths
    };
}

test('First Launch archive availability requires Drive features and an existing configured folder', async () => {
    for (const fixture of [
        { driveFeaturesEnabled: false, firstLaunchFolder: 'first-launch', folderExists: true, expected: false },
        { driveFeaturesEnabled: true, firstLaunchFolder: '   ', folderExists: true, expected: false },
        { driveFeaturesEnabled: true, firstLaunchFolder: 'first-launch', folderExists: false, expected: false },
        { driveFeaturesEnabled: true, firstLaunchFolder: 'first-launch', folderExists: true, expected: true }
    ]) {
        const harness = loadAvailabilityHarness(fixture);
        assert.equal(
            typeof harness.provider.refreshFirstLaunchArchiveAvailabilityContext,
            'function'
        );

        const available = await harness.provider.refreshFirstLaunchArchiveAvailabilityContext();

        assert.equal(available, fixture.expected);
        assert.deepEqual(harness.contextValues, [{
            key: 'kotTestToolkit.firstLaunchArchiveAvailable',
            value: fixture.expected
        }]);
    }
});

test('First Launch archive availability resolves a relative folder against the workspace', async () => {
    const harness = loadAvailabilityHarness({
        driveFeaturesEnabled: true,
        firstLaunchFolder: 'fixtures/first-launch',
        folderExists: true
    });
    assert.equal(typeof harness.provider.refreshFirstLaunchArchiveAvailabilityContext, 'function');

    await harness.provider.refreshFirstLaunchArchiveAvailabilityContext();

    assert.deepEqual(harness.statPaths, [path.join('/workspace', 'fixtures/first-launch')]);
});
