import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import * as format from '../src/spprScenarioFormat';

const metadata = 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Example\n    UID: same-stable-uid\n';
const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).toString() });
const scenario = (directory: string, name = path.basename(directory)) => ({ name, relativePath: directory, yamlFileUri: uri(path.join(directory, 'scen.yaml')) });

async function fixture(t: test.TestContext) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-batch-format-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const documents: any[] = []; const opened: any[] = []; const commands: any[] = []; const messages: string[] = [];
    const host = {
        Uri: { file: uri }, ProgressLocation: { Notification: 1 }, ViewColumn: { Beside: 2 },
        workspace: { textDocuments: documents, asRelativePath: (source: any) => path.relative(root, source.fsPath),
            openTextDocument: async (value: any) => value },
        window: { activeTextEditor: undefined as any, showQuickPick: async (items: any[]) => items,
            showInformationMessage: async (message: string) => { messages.push(message); },
            showErrorMessage: async (message: string) => { messages.push(message); },
            withProgress: async (_options: any, work: any) => work({ report() {} }, { isCancellationRequested: false }),
            showTextDocument: async (document: any) => { opened.push(document); } },
        commands: { executeCommand: async (command: string, options: any) => { commands.push({ command, options }); } }
    };
    const ts = require('typescript') as typeof import('typescript');
    const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/spprScenarioBatchConversion.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, process, console,
        require: (name: string) => name === 'vscode' ? host : name === './spprScenarioFormat' ? format
            : name === './projectLibraryStore' ? { waitForProjectLibraryIdle: async () => undefined } : require(name) });
    const create = async (name: string, text = metadata + 'ТекстСценария: |\n    And step\n') => {
        const directory = path.join(root, name); await fsp.mkdir(directory); await fsp.writeFile(path.join(directory, 'scen.yaml'), text);
        return scenario(directory, name);
    };
    const translate = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/gu, (match, index) => args[Number(index)] ?? match);
    return { api: module.exports, root, create, host, documents, opened, commands, messages, translate };
}

test('batch candidates include main and nested legacy scenarios, deduplicate URIs and exclude other file kinds', async t => {
    const h = await fixture(t); const main = scenario('/project/main'); const nested = scenario('/project/nested');
    const candidates = h.api.legacyScenarioCandidates([main, { ...main }, nested, { ...scenario('/process'), kind: 'process' },
        { ...main, yamlFileUri: uri('/project/native/meta.yaml') }, { ...main, yamlFileUri: { ...uri('/remote/scen.yaml'), scheme: 'https' } }]);
    assert.deepEqual(Array.from(candidates, (item: any) => item.name), ['main', 'nested']);
});

test('batch conversion preserves metadata, settings, attachments and sidecars while continuing after conflicts', async t => {
    const h = await fixture(t); const good = await h.create('good'); const conflict = await h.create('conflict');
    const directory = path.dirname(good.yamlFileUri.fsPath);
    await fsp.writeFile(path.join(directory, 'scen.yaml.kot.yml'), 'description: Keep\n');
    await fsp.writeFile(path.join(directory, 'test.yaml'), 'settings');
    await fsp.mkdir(path.join(directory, 'files')); await fsp.writeFile(path.join(directory, 'files/data.csv'), 'data');
    await fsp.writeFile(path.join(path.dirname(conflict.yamlFileUri.fsPath), 'meta.yaml'), 'existing');
    const result = await h.api.convertLegacyScenarios([conflict, good], { documents: () => h.documents });
    assert.equal(result.converted.length, 1); assert.equal(result.failed.length, 1); assert.equal(result.remaining, 0);
    assert.match(result.failed[0].error, /already exists/);
    assert.equal(await fsp.readFile(path.join(directory, 'meta.yaml'), 'utf8'), metadata);
    assert.equal(await fsp.readFile(path.join(directory, 'scen.feature'), 'utf8'), 'And step\n');
    assert.equal(await fsp.readFile(path.join(directory, 'meta.yaml.kot.yml'), 'utf8'), 'description: Keep\n');
    assert.equal(await fsp.readFile(path.join(directory, 'test.yaml'), 'utf8'), 'settings');
    assert.equal(await fsp.readFile(path.join(directory, 'files/data.csv'), 'utf8'), 'data');
    assert.equal(await fsp.readFile(path.join(path.dirname(conflict.yamlFileUri.fsPath), 'meta.yaml'), 'utf8'), 'existing');
    await fsp.access(conflict.yamlFileUri.fsPath);
});

test('batch conversion skips dirty sidecars and rolls back if a document becomes dirty before commit', async t => {
    const h = await fixture(t); const dirty = await h.create('dirty'); const changed = await h.create('changed');
    const dirtySidecar = { uri: uri(dirty.yamlFileUri.fsPath + '.kot.yml'), isDirty: true };
    assert.equal((await h.api.convertLegacyScenarios([dirty], { documents: () => [dirtySidecar] })).failed.length, 1);
    let reads = 0;
    const result = await h.api.convertLegacyScenarios([changed], { documents: () => [{ uri: changed.yamlFileUri, isDirty: ++reads > 1 }] });
    assert.equal(result.failed.length, 1);
    for (const item of [dirty, changed]) {
        await fsp.access(item.yamlFileUri.fsPath);
        await assert.rejects(fsp.access(path.join(path.dirname(item.yamlFileUri.fsPath), 'meta.yaml')));
        await assert.rejects(fsp.access(path.join(path.dirname(item.yamlFileUri.fsPath), 'scen.feature')));
    }
});

test('cancellation finishes the current conversion and leaves the remaining scenarios untouched', async t => {
    const h = await fixture(t); const sources = [await h.create('first'), await h.create('second'), await h.create('third')];
    let cancelled = false;
    const result = await h.api.convertLegacyScenarios(sources, { cancelled: () => cancelled, progress: () => { cancelled = true; } });
    assert.equal(result.converted.length, 1); assert.equal(result.failed.length, 0); assert.equal(result.remaining, 2); assert.equal(result.cancelled, true);
    await fsp.access(sources[1].yamlFileUri.fsPath); await fsp.access(sources[2].yamlFileUri.fsPath);
});

test('batch command refreshes all changed source paths once and opens one summary instead of every scenario', async t => {
    const h = await fixture(t); const sources = [await h.create('one'), await h.create('two')];
    await h.api.handleBatchScenarioFormatConversion(async () => sources, h.translate);
    assert.equal(h.commands.length, 1); assert.equal(h.commands[0].command, 'kotTestToolkit.refreshPhaseSwitcher');
    assert.equal(h.commands[0].options.changedSourceUris.length, 6);
    assert.equal(h.opened.length, 1); assert.equal(h.opened[0].language, 'markdown');
    assert.match(h.opened[0].content, /one/); assert.match(h.opened[0].content, /two/);
});

test('batch command replaces the active YAML editor with its script without opening other converted scripts', async t => {
    const h = await fixture(t); const active = await h.create('active'); const other = await h.create('other');
    h.host.window.activeTextEditor = { document: { uri: active.yamlFileUri } };
    await h.api.handleBatchScenarioFormatConversion(async () => [active, other], h.translate);
    assert.equal(h.opened.length, 2);
    assert.equal(h.opened[0].fsPath, path.join(path.dirname(active.yamlFileUri.fsPath), 'scen.feature'));
    assert.equal(h.opened[1].language, 'markdown');
});

test('batch command rejects concurrent invocations and releases its guard after cancelling selection', async t => {
    const h = await fixture(t); const source = await h.create('scenario');
    let release!: (value: any) => void;
    h.host.window.showQuickPick = () => new Promise(resolve => { release = resolve; });
    const pending = h.api.handleBatchScenarioFormatConversion(async () => [source], h.translate);
    await new Promise(resolve => setImmediate(resolve));
    await h.api.handleBatchScenarioFormatConversion(async () => [source], h.translate);
    assert.equal(h.messages.length, 1); assert.match(h.messages[0], /already running/);
    release(undefined); await pending;
    assert.equal(h.commands.length, 0); await fsp.access(source.yamlFileUri.fsPath);
    h.host.window.showQuickPick = async items => items;
    const result = await h.api.handleBatchScenarioFormatConversion(async () => [source], h.translate);
    assert.equal(result.converted.length, 1); assert.equal(h.commands.length, 1);
});
