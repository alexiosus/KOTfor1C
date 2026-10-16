import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import * as messages from '../src/scenarioFilesWebviewProtocol';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
function harness() {
    const file = path.join(process.cwd(), 'src/scenarioPropertiesAttachments.ts');
    assert.ok(fs.existsSync(file), 'Properties must have a native attachments controller.');
    const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
        { module, exports: module.exports, require: (name: string) => name === './scenarioFilesWebviewProtocol' ? messages : require(name), Buffer, URL, console });
    let current: string | undefined = 'file:///project/scen.yaml';
    const posted: any[] = []; const opened: any[] = []; const chunks: any[] = []; const cancelled: string[] = []; const completed: string[] = [];
    let item: any; let invalidated: (() => void) | undefined;
    const service = {
        listAttachmentPaths: async (value: any) => { item = value; return ['Fixtures/Data.csv']; },
        watch: (_item: any, callback: () => void) => { invalidated = callback; return { dispose() {} }; },
        openExternal: async (...args: any[]) => { opened.push(args); return true; }, revealInOs: async () => true, deleteFile: async () => 'deleted',
        renameFile: async (_item: any, relativePath: string, stillCurrent: () => boolean) => { assert.equal(stillCurrent(), true); opened.push(['rename', relativePath]); return 'renamed'; },
        prepareDrop: async (_item: any, _target: string, entries: any[], stillCurrent: () => boolean) => {
            assert.equal(stillCurrent(), true); return { files: entries.filter(entry => entry.kind === 'file').map(entry => ({ ...entry, transferId: 'upload-1', destinationRelativePath: entry.clientPath })), skipped: [] };
        },
        appendTransferChunk: async (...args: any[]) => { chunks.push(args); return args[1] + Buffer.from(args[2], 'base64').length; },
        completeTransfer: async (id: string) => { completed.push(id); }, cancelTransfer: async (id: string) => { cancelled.push(id); }
    };
    const inserted: string[] = []; const nativeHost = {
        currentSourceUri: () => current, validateSource: async (uri: string) => uri === current,
        postMessage: async (value: any) => { posted.push(value); },
        insertFileName: async (value: string) => { inserted.push(value); return true; },
        chooseFiles: async (_uri: string): Promise<readonly string[] | undefined> => undefined
    };
    const controller = new module.exports.ScenarioPropertiesAttachments(service, nativeHost);
    const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
    return { controller, service, nativeHost, inserted, posted, opened, chunks, cancelled, completed, settle,
        get item() { return item; }, setSource: (uri?: string) => { current = uri; controller.bindSource(uri); }, invalidate: () => invalidated?.() };
}

test('Properties files use the authored source folder and refresh on attachment changes', async () => {
    const h = harness(); h.setSource('file:///project/scen.yaml'); await h.settle();
    assert.equal(h.item.kind, 'nestedScenario'); assert.equal(h.item.capturedLocation.uri, 'file:///project/scen.yaml');
    assert.deepEqual(Array.from(h.posted.at(-1).paths), ['Fixtures/Data.csv']); assert.equal(h.posted.at(-1).rootUri, 'file:///project/files');
    const count = h.posted.length; h.invalidate(); await h.settle(); assert.ok(h.posted.length > count); h.controller.dispose();
});

test('Properties attachment rename uses the bound test and refreshes its file inventory', async () => {
    const h = harness(); h.setSource('file:///project/scen.yaml'); await h.settle();
    const before = h.posted.length;
    await h.controller.handle({ command: 'renameScenarioFile', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///project/scen.yaml', relativePath: 'Fixtures/Data.csv' });
    assert.deepEqual(h.opened, [['rename', 'Fixtures/Data.csv']]);
    assert.ok(h.posted.length > before);
    await h.controller.handle({ command: 'renameScenarioFile', sourceUri: 'file:///foreign/scen.yaml', itemId: 'file:///project/scen.yaml', relativePath: 'Fixtures/Data.csv' });
    assert.equal(h.opened.length, 1); h.controller.dispose();
});

test('Properties attachment actions reject a foreign source or item identity', async () => {
    const h = harness(); h.setSource('file:///project/scen.yaml'); await h.settle();
    await h.controller.handle({ command: 'openScenarioFile', sourceUri: 'file:///foreign/scen.yaml', itemId: 'file:///foreign/scen.yaml', relativePath: 'Data.csv' });
    await h.controller.handle({ command: 'openScenarioFile', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///foreign/scen.yaml', relativePath: 'Data.csv' });
    assert.equal(h.opened.length, 0);
    await h.controller.handle({ command: 'openScenarioFile', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///project/scen.yaml', relativePath: 'Fixtures/Data.csv' });
    assert.equal(h.opened.length, 1); assert.equal(h.opened[0][1], 'Fixtures/Data.csv'); h.controller.dispose();
});

test('switching test cancels owned uploads and refuses stale chunks', async () => {
    const h = harness(); h.setSource('file:///project/scen.yaml'); await h.settle();
    await h.controller.handle({ command: 'prepareScenarioFileDrop', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///project/scen.yaml', dropId: 'drop-1', targetRelativePath: '', entries: [{ clientPath: 'Data.csv', kind: 'file', size: 3 }] });
    assert.equal(h.posted.at(-1).command, 'scenarioFileDropPrepared');
    h.setSource('file:///next/process.yaml'); await h.settle();
    await h.controller.handle({ command: 'appendScenarioFileChunk', sourceUri: 'file:///project/scen.yaml', transferId: 'upload-1', offset: 0, base64: 'YWJj' });
    assert.ok(h.cancelled.includes('upload-1')); assert.equal(h.chunks.length, 0); assert.equal(h.completed.length, 0); h.controller.dispose();
});

test('Explorer URI drops stream local files through the attachment service', async t => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-properties-uri-drop-')); t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'Data.csv'); await fsp.writeFile(file, 'abc');
    const h = harness(); h.setSource('file:///project/scen.yaml'); await h.settle();
    await h.controller.handle({ command: 'addScenarioFilesFromUris', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///project/scen.yaml', uris: [pathToFileURL(file).toString()] });
    assert.equal(h.completed.length, 1); assert.equal(Buffer.from(h.chunks[0][2], 'base64').toString(), 'abc'); h.controller.dispose();
});

test('Explorer URI drops reject symlinks and non-file URLs without allocating transfers', async t => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-properties-uri-drop-')); t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'Data.csv'); const link = path.join(directory, 'link.csv'); await fsp.writeFile(file, 'abc'); await fsp.symlink(file, link);
    const h = harness(); h.setSource('file:///project/scen.yaml'); await h.settle();
    for (const uri of [pathToFileURL(link).toString(), 'https://example.com/data.csv']) {
        await h.controller.handle({ command: 'addScenarioFilesFromUris', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///project/scen.yaml', uris: [uri] });
    }
    assert.equal(h.completed.length, 0); assert.equal(h.chunks.length, 0); h.controller.dispose();
});

test('explicit filename insertion uses a known attachment basename and ignores forged paths', async () => {
    const h = harness(); h.setSource('file:///project/scen.yaml'); await h.settle();
    await h.controller.handle({ command: 'insertScenarioFileName', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///project/scen.yaml', relativePath: 'Fixtures/Data.csv' });
    assert.deepEqual(h.inserted, ['Data.csv']);
    await h.controller.handle({ command: 'insertScenarioFileName', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///project/scen.yaml', relativePath: '../forged.csv' });
    assert.deepEqual(h.inserted, ['Data.csv']); h.controller.dispose();
});

test('native file selection is cancelled when the selected test changes during the dialog', async () => {
    const h = harness(); h.setSource('file:///project/scen.yaml'); await h.settle();
    h.nativeHost.chooseFiles = async () => { h.setSource('file:///next/scen.yaml'); return ['file:///tmp/Data.csv']; };
    await h.controller.handle({ command: 'chooseScenarioFiles', sourceUri: 'file:///project/scen.yaml', itemId: 'file:///project/scen.yaml' });
    assert.equal(h.chunks.length, 0); assert.equal(h.completed.length, 0); assert.match(h.posted.find(message => message.command === 'scenarioFileTransferFailed').error, /changed/i);
    h.controller.dispose();
});
