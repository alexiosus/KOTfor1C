import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import { portableSettingPath } from '../src/kotSettingsPaths';

function harness(mode: 'install' | 'cancel' | 'pending' = 'install', project = process.cwd()) {
    let installSignal: AbortSignal | undefined; let selectedPage = 0;
    const calls: unknown[][] = []; const messages: any[] = []; let trusted = true;
    const root = fs.realpathSync(project);
    const folder = { uri: { fsPath: root, scheme: 'file', toString: () => 'file:///project' } };
    const release = { tag: '1.2.043.47', version: '1.2.043.47', size: 32 * 1024 * 1024 };
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/kotWorkspacePanel.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, process, AbortController, require: (name: string) => {
            if (name === './kotInteraction') { return nativeInteraction; }
        if (name === 'vscode') { return { CancellationTokenSource: class { token = {}; cancel() {} dispose() {} }, ProgressLocation: { Notification: 1 },
            workspace: { get isTrusted() { return trusted; }, workspaceFolders: [folder] }, window: {
                withProgress: async (_options: unknown, work: Function) => work({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
                showQuickPick: async (choices: any[]) => mode === 'cancel' ? undefined : ++selectedPage === 1 ? choices.at(-1) : choices[0]
            } }; }
        if (name === './kotSettingsPaths') { return { portableSettingPath }; }
        if (name === './vanessaReleaseDownload.js') { return {
            listVanessaReleasePage: async (page: number) => { calls.push(['page', page]); return { releases: [release], more: page === 1 }; },
            installVanessaRelease: async (project: string, selected: unknown, options: { signal: AbortSignal; progress(value: unknown): void }) => {
                calls.push(['install', project, selected]); installSignal = options.signal;
                options.progress({ phase: 'download', completed: 10, total: 100 });
                if (mode === 'pending') { await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
                return path.join(project, 'tools/vanessa/1.2.043.47/vanessa-automation.epf');
            }
        }; }
        return name.startsWith('node:') ? require(name) : {};
    } });
    const panel = Object.create(module.exports.KotWorkspacePanel.prototype);
    panel.model = { strings: {} }; panel.selectedFolder = 'file:///project';
    panel.panel = { webview: { postMessage: async (message: unknown) => { messages.push(message); } } };
    return { panel, calls, messages, root, signal: () => installSignal, trust: (value: boolean) => { trusted = value; },
        download: () => panel.dispatch({ id: 'download', type: 'downloadVanessa', folder: 'file:///project' }),
        cancel: (id: string) => panel.dispatch({ id: 'cancel', type: 'cancelVanessaDownload', value: id }) };
}

test('the wizard selects official releases, pages backwards and returns a relative EPF path with scoped progress', async () => {
    const h = harness(); const result = await h.download();
    assert.deepEqual(h.calls.filter(call => call[0] === 'page'), [['page', 1], ['page', 2]]);
    assert.equal(h.calls.find(call => call[0] === 'install')?.[1], h.root);
    assert.equal(result.path, 'tools/vanessa/1.2.043.47/vanessa-automation.epf');
    assert.ok(h.messages.some(message => message.type === 'vanessaDownloadProgress' && message.id === 'download' && message.folder === 'file:///project' && message.total === 100));
    assert.equal(h.panel.vanessaDownload, undefined);
});

test('cancelling selection or a download releases the wizard action; another request cannot cancel it', async () => {
    const cancelled = harness('cancel'); assert.equal(await cancelled.download(), undefined);
    assert.ok(!cancelled.calls.some(call => call[0] === 'install'));
    const h = harness('pending'); const operation = h.download();
    while (!h.signal()) { await new Promise(resolve => setImmediate(resolve)); }
    await h.cancel('another'); assert.equal(h.signal()!.aborted, false);
    await assert.rejects(h.download(), /already in progress/u);
    await h.cancel('download'); assert.equal(await operation, undefined);
    assert.equal(h.signal()!.aborted, true); assert.equal(h.panel.vanessaDownload, undefined);
});

test('an untrusted workspace cannot start a release lookup or install', async () => {
    const h = harness(); h.trust(false);
    await assert.rejects(h.download(), /Trust the workspace/u); assert.deepEqual(h.calls, []);
});

test('the wizard suggests the existing Features directory beside an EPF using a portable path, including external distributions', async () => {
    const temporary = await fs.promises.realpath(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temporary, 'kot-setup-libraries-'));
    assert.equal(path.dirname(root), temporary);
    try {
        const project = path.join(root, 'project'); fs.mkdirSync(project);
        const h = harness('install', project);
        const suggest = (value: unknown) => h.panel.dispatch({ id: 'library', type: 'suggestVanessaLibrary', folder: 'file:///project', value });
        for (const directory of [path.join(project, 'tools', 'vanessa'), path.join(root, 'external')]) {
            fs.mkdirSync(directory, { recursive: true });
            const epf = path.join(directory, 'vanessa.epf'); fs.writeFileSync(epf, 'epf');
            assert.equal(await suggest(epf), undefined);
            fs.writeFileSync(path.join(directory, 'Features'), 'not a directory');
            assert.equal(await suggest(epf), undefined); fs.unlinkSync(path.join(directory, 'Features'));
            fs.mkdirSync(path.join(directory, 'features'));
            assert.equal(await suggest(epf), portableSettingPath(h.root, path.join(directory, 'features'), 'relative', 'folder'));
        }
        assert.equal(await suggest('tools/vanessa/vanessa.epf'), 'tools/vanessa/features');
        assert.equal(await suggest('tools/vanessa/missing.epf'), undefined);
        assert.equal(await suggest('tools/vanessa/features'), undefined);
        for (const invalid of [undefined, {}, 'bad\0path', 'a'.repeat(4097)]) { await assert.rejects(suggest(invalid), /Invalid setup path/u); }
        assert.deepEqual(h.calls, []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
