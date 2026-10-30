import * as projectFormatModule from '../src/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as role from '../src/scenarioTestRole';
import * as descriptor from '../src/scenarioDescriptor';
import * as model from '../src/scenarioPropertiesModel';
import * as bindings from '../src/scenarioPropertiesBindings';

function harness(t: test.TestContext, process = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-role-command-')); fs.mkdirSync(path.join(root, '.kot')); fs.writeFileSync(path.join(root,'.kot/project.yml'),'version: 3\n'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
    const metadata = path.join(root, process ? 'process.yaml' : 'meta.yaml'); const script = path.join(root, 'scen.feature');
    fs.writeFileSync(metadata, `ТипФайла: "${process ? 'Процесс' : 'Сценарий'}"\n${process ? 'ДанныеПроцесса' : 'ДанныеСценария'}:\n    UID: "own"\n    Имя: "Own"\n    Код: "001"\n`);
    if (!process) { fs.writeFileSync(script, 'And Delay 1\n'); }
    const setting = path.join(root, 'test.yaml');
    const settingsText = `ТипФайла: "${process ? 'НастройкаПроцесса' : 'НастройкаТеста'}"\nДанныеТеста:\n    ${process ? 'UIDПроцесса' : 'UIDСценария'}: "own"\n`;
    fs.writeFileSync(setting, settingsText);
    const dirty = new Set<string>(); const notifications: string[] = []; const commands: string[] = []; const refreshes: any[] = []; let cancelCreation = false;
    const document = (file: string) => ({ uri: uri(file), version: 1, isClosed: false,
        get isDirty() { return dirty.has(file); }, getText: () => fs.readFileSync(file, 'utf8'), save: async () => true });
    let reads=0;let onRead:((count:number)=>void)|undefined;let onCreate:(()=>void)|undefined;
    const host = { readDocument: async (value: string) => {
        onRead?.(++reads);
        const file = fileURLToPath(value); return { uri: value, version: 1, text: fs.readFileSync(file, 'utf8'), dirty: dirty.has(file),
            ...(!process && file === metadata ? { scriptUri: uri(script).toString(), scriptText: fs.readFileSync(script, 'utf8') } : {}) };
    }, listSettings: async () => fs.readdirSync(root).filter(file => file.endsWith('.yaml')).map(file => ({ uri: uri(path.join(root, file)).toString(), text: fs.readFileSync(path.join(root, file), 'utf8') })) };
    const vscode = { Uri: { file: uri, parse: (value: string) => uri(fileURLToPath(value)) },
        workspace: { get textDocuments() { return [metadata, script, setting].filter(file => fs.existsSync(file) || dirty.has(file)).map(document); }, openTextDocument: async (value: ReturnType<typeof uri>) => document(value.fsPath) },
        commands: { executeCommand: async (name: string, options: unknown) => { commands.push(name); if (name === 'kotTestToolkit.refreshPhaseSwitcher') { refreshes.push(options); } } },
        window: { showInformationMessage: async () => undefined, showErrorMessage: async (message: string) => { notifications.push(message); } } };
    const ts = require(path.join(processCwd(), 'node_modules/typescript')) as typeof import('typescript');
    const module = { exports: {} as Record<string, any> };
    const dependencies: Record<string, unknown> = {
        vscode, './projectFormat': projectFormatModule, './scenarioTestRole': role, './scenarioDescriptor': descriptor, './scenarioPropertiesModel': model, './scenarioPropertiesBindings': bindings,
        './spprScenarioFiles': { resolveScenarioSourceUris: async () => process ? undefined : ({ metadataUri: uri(metadata), scriptUri: uri(script), format: 'native' }) },
        './scenarioPropertiesPanel': { createScenarioPropertiesHost: () => host },
        './scenarioPropertiesActions': { createScenarioLaunchSettings: async (_context:unknown,_document:unknown,_source:unknown,_t:unknown,assertCurrent?:()=>void) => { if (cancelCreation) { return undefined; } onCreate?.();assertCurrent?.();fs.writeFileSync(setting, settingsText); return uri(setting); } },
        './projectLibraryIntegration': { projectLibraryEnvironment: () => ({ workspaceRoots: [root], scanRoots: [root] }) },
        './projectLibraryMetadata': { resolveProjectLibraryRoot: () => root },
        './localization': { getTranslator: async () => (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/gu, (_, index) => args[Number(index)] ?? '') }
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/scenarioTestRoleCommands.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: (name: string) => dependencies[name] ?? require(name) });
    return { root, metadata, script, setting, dirty, notifications, commands, refreshes, api: module.exports,
        cancelCreation: () => { cancelCreation = true; },
        onRead: (callback:(count:number)=>void) => {onRead=callback;},
        onCreate: (callback:()=>void) => {onCreate=callback;},
        convert: (main: boolean) => module.exports.handleConvertScenarioRole({ extensionUri: uri(root) }, uri(process ? metadata : script), main) };
}
function processCwd() { return process.cwd(); }

test('role conversion refuses a branch format changed during source validation',async t=>{
    const h=harness(t);h.onRead(count=>{if(count===2){fs.unlinkSync(path.join(h.root,'.kot/project.yml'));}});
    assert.equal(await h.convert(false),undefined);
    assert.equal(fs.existsSync(h.setting),true);
    assert.match(h.notifications.join('\n'),/format|changed|KOT 3/iu);
});
test('role promotion refuses a branch changed while choosing new launch settings',async t=>{
    const h=harness(t);fs.unlinkSync(h.setting);h.onCreate(()=>fs.unlinkSync(path.join(h.root,'.kot/project.yml')));
    assert.equal(await h.convert(true),undefined);assert.equal(fs.existsSync(h.setting),false);
    assert.match(h.notifications.join('\n'),/format|changed|KOT 3/iu);
});

test('scenario and process role commands archive and restore settings while refreshing views', async t => {
    for (const process of [false, true]) {
        const h = harness(t, process); const before = fs.readFileSync(h.metadata, 'utf8');
        assert.ok(await h.convert(false), h.notifications.join('\n')); assert.equal(fs.existsSync(h.setting), false);
        assert.ok(h.refreshes[0]?.changedSourceUris.includes(pathToFileURL(h.metadata).href));
        assert.ok(await h.convert(true), h.notifications.join('\n')); assert.equal(fs.existsSync(h.setting), true);
        assert.ok(h.refreshes[1]?.changedSourceUris.includes(pathToFileURL(h.metadata).href));
        assert.equal(fs.readFileSync(h.metadata, 'utf8'), before); assert.equal(h.commands.length, 2);
    }
});

test('role commands reject unsaved native scripts and restore targets', async t => {
    const h = harness(t); h.dirty.add(h.script);
    assert.equal(await h.convert(false), undefined); assert.equal(fs.existsSync(h.setting), true);
    h.dirty.clear(); await h.convert(false); h.dirty.add(h.setting);
    assert.equal(await h.convert(true), undefined); assert.equal(fs.existsSync(h.setting), false);
});

test('promotion without an archive creates linked settings and refreshes Test Manager', async t => {
    const h = harness(t); fs.unlinkSync(h.setting);
    assert.ok(await h.convert(true), h.notifications.join('\n'));
    assert.equal(fs.existsSync(h.setting), true); assert.equal(h.commands.length, 1);
});

test('duplicate source UIDs prevent changing shared launch settings', async t => {
    const h = harness(t); fs.copyFileSync(h.metadata, path.join(h.root, 'duplicate.yaml'));
    assert.equal(await h.convert(false), undefined); assert.equal(fs.existsSync(h.setting), true);
    assert.match(h.notifications[0], /ambiguous/u);
});

test('cancelling promotion leaves a nested source unchanged and creates no settings', async t => {
    const h = harness(t); fs.unlinkSync(h.setting); h.cancelCreation(); const before = fs.readFileSync(h.metadata, 'utf8');
    assert.equal(await h.convert(true), undefined); assert.equal(fs.existsSync(h.setting), false);
    assert.equal(fs.readFileSync(h.metadata, 'utf8'), before); assert.deepEqual(h.commands, []);
});
