import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { InfobaseRuntimeTracker } from '../src/infobaseRuntimeTracker';
import * as commandDisplay from '../src/processCommandDisplay';
import * as connections from '../src/oneCInfobaseConnection';
import path from 'node:path';

test('detached launches track the mode from the first 1C argument', async () => {
    const tracker = new InfobaseRuntimeTracker();
    const children: EventEmitter[] = [];
    const ts = require('typescript') as typeof import('typescript');
    const module = { exports: {} as any };
    const source = ts.transpileModule(fs.readFileSync('src/infobaseManager.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const dependencies: Record<string, unknown> = {
        vscode: { workspace: { workspaceFolders: [] } },
        './infobaseRuntimeTracker': { managedInfobaseRuntimeTracker: tracker },
        './processCommandDisplay': commandDisplay,
        'node:child_process': { spawn: () => {
            const child = Object.assign(new EventEmitter(), { pid: 401 + children.length, unref() {} });
            children.push(child);
            return child;
        } }
    };
    vm.runInNewContext(source + '\nmodule.exports.launchOneCDetached = launchOneCDetached;', {
        module, exports: module.exports, process, console, Buffer,
        require: (name: string) => dependencies[name] ?? (name.startsWith('node:') ? require(name) : {})
    });
    const launch = (args: string[]) => module.exports.launchOneCDetached('/platform/1cv8', args,
        { appendLine() {} }, (message: string) => message, '/workspace/demo') as Promise<void>;

    await launch(['ENTERPRISE']);
    await launch(['DESIGNER']);
    await launch(['/N', 'ENTERPRISE']);
    assert.deepEqual(tracker.runningModes('/workspace/demo'), ['enterprise', 'designer']);
    children[0].emit('exit', 0);
    assert.deepEqual(tracker.runningModes('/workspace/demo'), ['designer']);
    children[1].emit('exit', 0);
    assert.deepEqual(tracker.runningModes('/workspace/demo'), []);
    assert.equal(tracker.runningIdentities().size, 1);
    children[2].emit('exit', 0);
    assert.equal(tracker.runningIdentities().size, 0);
});

test('manager launches of the shared service IB use the shared policy even with an explicit platform or forced picker', async () => {
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    const service = path.resolve('artifacts/service-test-ib'); const active = { name: 'running', clientExePath: '/platform/active/1cv8c.exe' };
    let resolutions = 0; let catalogs = 0;
    const dependencies: Record<string, unknown> = {
        './oneCInfobaseConnection': connections,
        './startupInfobase': { getSharedStartupInfobasePaths: () => ({ infobaseDirectory: service }) },
        './sharedStartupPlatform': { resolveSharedStartupPlatform: async () => { resolutions++; return active; } },
        './oneCPlatform': { normalizeOneCClientExePath: (exe: string) => exe, ensureOneCPlatformsCatalogInitialized: async () => { catalogs++; return []; } }
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/infobaseManager.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText + '\nmodule.exports.resolveManagedInfobaseLaunchPlatform = resolveManagedInfobaseLaunchPlatform; module.exports.maintenancePlatform = getManagedInfobaseConfiguredPlatformClientExePath;', {
        module, exports: module.exports, process, console, Buffer,
        require: (name: string) => dependencies[name] ?? (name.startsWith('node:') ? require(name) : {})
    });
    const resolve = module.exports.resolveManagedInfobaseLaunchPlatform;
    const selected = await resolve({}, service, (text: string) => text, 'Choose', { forcePlatformPicker: true, preferredOneCClientExePath: '/platform/other/1cv8c.exe' });
    assert.equal(selected.platform, active); assert.equal(selected.persistSelection, false);
    assert.equal(resolutions, 1); assert.equal(catalogs, 0);
    const ordinary = await resolve({}, path.resolve('artifacts/ordinary-test-ib'), (text: string) => text, 'Choose', { preferredOneCClientExePath: '/platform/other/1cv8c.exe' });
    assert.equal(ordinary.platform.clientExePath, '/platform/other/1cv8c.exe');
    assert.equal(resolutions, 1); assert.equal(catalogs, 1);
    const maintenance = await module.exports.maintenancePlatform({}, service, (text: string) => text);
    assert.equal(maintenance, active.clientExePath); assert.equal(resolutions, 2); assert.equal(catalogs, 1);
});
