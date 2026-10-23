import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { InfobaseRuntimeTracker } from '../src/infobaseRuntimeTracker';
import * as commandDisplay from '../src/processCommandDisplay';

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
