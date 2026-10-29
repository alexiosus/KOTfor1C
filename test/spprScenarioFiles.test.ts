import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as format from '../src/spprScenarioFormat';

const metadata = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Native"\n    UID: "native-uid"\n';
const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` });
async function harness(t: test.TestContext) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-sppr-editor-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const documents: Array<{ uri: ReturnType<typeof uri>; isDirty: boolean; getText(): string }> = [];
    const errors: string[] = []; const opened: string[] = []; const commands: string[] = []; const refreshes: any[] = [];
    const host = {
        EventEmitter: class<T> {
            private readonly listeners = new Set<(value: T) => void>();
            readonly event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
            fire(value: T) { for (const listener of this.listeners) { listener(value); } }
        },
        Uri: { file: uri, parse: (value: string) => uri(value.replace(/^file:\/\//u, '')), joinPath: (base: ReturnType<typeof uri>, ...segments: string[]) => uri(path.join(base.fsPath, ...segments)) },
        workspace: { textDocuments: documents, fs: { readFile: (target: ReturnType<typeof uri>) => fsp.readFile(target.fsPath), stat: (target: ReturnType<typeof uri>) => fsp.stat(target.fsPath) },
            openTextDocument: async (target: ReturnType<typeof uri>) => ({ uri: target }) },
        window: { showErrorMessage: async (message: string) => { errors.push(message); }, showInformationMessage: async () => {},
            showTextDocument: async (document: { uri: ReturnType<typeof uri> }) => { opened.push(document.uri.fsPath); } },
        commands: { executeCommand: async (name: string, options: unknown) => { commands.push(name); if (name === 'kotTestToolkit.refreshPhaseSwitcher') { refreshes.push(options); } } }, l10n: { t: (text: string) => text }
    };
    const ts = require('typescript') as typeof import('typescript');
    const compiled = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/spprScenarioFiles.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, console,
        require: (name: string) => name === 'vscode' ? host : name === './spprScenarioFormat' ? format
            : name === './projectLibraryStore' ? { waitForProjectLibraryIdle: async () => {} } : require(name) });
    return { root, documents, errors, opened, commands, refreshes, host, api: module.exports as typeof import('../src/spprScenarioFiles') };
}

test('native source reader composes SPPR metadata with current script buffer, keeping script edits live', async t => {
    const h = await harness(t);
    await fsp.writeFile(path.join(h.root, 'meta.yaml'), metadata);
    await fsp.writeFile(path.join(h.root, 'scen.feature'), 'And saved\n');
    h.documents.push({ uri: uri(path.join(h.root, 'scen.feature')), isDirty: true, getText: () => 'And unsaved\n' });
    const source = await h.api.readScenarioSource(uri(path.join(h.root, 'meta.yaml')) as never);
    assert.equal(source, metadata + 'ТекстСценария: |\n    And unsaved\n');
    const target = await h.api.resolveScenarioSourceUris(uri(path.join(h.root, 'scen.feature')) as never);
    assert.equal(target?.metadataUri.fsPath, path.join(h.root, 'meta.yaml'));
    assert.equal(target?.scriptUri.fsPath, path.join(h.root, 'scen.feature'));
});

test('a standalone scen.feature without valid SPPR metadata stays a standalone feature', async t => {
    const h = await harness(t);
    const feature = uri(path.join(h.root, 'scen.feature'));
    await fsp.writeFile(feature.fsPath, '#language: en\nFeature: Standalone\n');
    assert.equal(await h.api.resolveScenarioSourceUris(feature as never), undefined);
    await fsp.writeFile(path.join(h.root, 'meta.yaml'), 'ТипФайла: "Процесс"\n');
    assert.equal(await h.api.resolveScenarioSourceUris(feature as never), undefined);
});

test('conversion refuses unsaved script edits and does not create or remove files', async t => {
    const h = await harness(t);
    await fsp.writeFile(path.join(h.root, 'meta.yaml'), metadata);
    await fsp.writeFile(path.join(h.root, 'scen.feature'), 'And saved\n');
    h.documents.push({ uri: uri(path.join(h.root, 'scen.feature')), isDirty: true, getText: () => 'And unsaved\n' });
    await h.api.handleConvertScenarioFormat(uri(path.join(h.root, 'meta.yaml')) as never, 'legacy');
    assert.equal(h.errors.length, 1);
    assert.equal(await fsp.readFile(path.join(h.root, 'scen.feature'), 'utf8'), 'And saved\n');
    await assert.rejects(fsp.stat(path.join(h.root, 'scen.yaml')));
    assert.deepEqual(h.opened, []);
});

test('source navigation opens the paired script at its first code line rather than a metadata header line', async t => {
    const h = await harness(t);
    await fsp.writeFile(path.join(h.root, 'meta.yaml'), metadata);
    await fsp.writeFile(path.join(h.root, 'scen.feature'), '# language: en\n\nAnd own step\n');
    const location = { uri: uri(path.join(h.root, 'meta.yaml')).toString(), range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } } };
    const result = await (h.api as any).resolveScenarioScriptLocation(location);
    assert.equal(result.uri, uri(path.join(h.root, 'scen.feature')).toString());
    assert.deepEqual(JSON.parse(JSON.stringify(result.range)), { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } });
});


test('conversion returns source URI moves and never waits for a nested Properties open', async t => {
    const h = await harness(t); const source = uri(path.join(h.root, 'scen.yaml'));
    await fsp.writeFile(source.fsPath, metadata + 'ТекстСценария: |\n    And step\n');
    const result = await h.api.handleConvertScenarioFormat(source as never, 'native');
    assert.equal(result?.sourceUri, uri(path.join(h.root, 'meta.yaml')).toString());
    assert.ok(result?.uriMoves.some(move => move.oldUri === source.toString()));
    assert.ok(!h.commands.includes('kotTestToolkit.openScenarioEditor'));
    assert.ok(h.commands.includes('kotTestToolkit.refreshPhaseSwitcher'));
    assert.deepEqual(Array.from(h.refreshes[0]?.changedSourceUris ?? []), ['scen.yaml', 'meta.yaml', 'scen.feature'].map(file => uri(path.join(h.root, file)).toString()));
});


test('conversion completes without waiting for the success notification to be dismissed', async t => {
    const h = await harness(t); const source = uri(path.join(h.root, 'scen.yaml'));
    await fsp.writeFile(source.fsPath, metadata + 'ТекстСценария: |\n    And step\n');
    h.host.window.showInformationMessage = () => new Promise(() => {});
    const result = await Promise.race([h.api.handleConvertScenarioFormat(source as never, 'native'), new Promise<undefined>(resolve => setTimeout(resolve, 150))]);
    assert.ok(result?.sourceUri, 'conversion must return its URI moves without waiting for a toast');
});
