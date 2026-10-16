import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import { parseDocument } from 'yaml';
import * as compilerProcesses from '../src/compilerProcesses';
import * as selection from '../src/compilerProcessSelection';
import * as yaml from '../src/scenarioYamlDocument';
import * as descriptors from '../src/scenarioDescriptor';
import * as prepared from '../src/preparedFileWrites';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import { nativeScenarioIdentityFiles } from './helpers/nativeScenarioIdentityFiles';
import * as snapshots from '../src/scenarioNativeDocumentSnapshot';
import * as bindings from '../src/scenarioPropertiesBindings';
import * as metadata from '../src/projectLibraryMetadata';
import * as store from '../src/projectLibraryStore';
import * as propertiesModel from '../src/scenarioPropertiesModel';
import * as propertiesSession from '../src/scenarioPropertiesSession';
import * as propertiesAttachments from '../src/scenarioPropertiesAttachments';

async function harness(t: test.TestContext, options: { dedicated?: boolean; bom?: boolean; separateRoots?: boolean; settingsExtension?: 'yml' } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-process-editor-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });
    const scenarioRoot = options.separateRoots ? path.join(root, 'yaml') : root;
    const processRoot = options.separateRoots ? path.join(root, 'processes') : root;
    await fs.mkdir(processRoot, { recursive: true });
    const sourceDirectory = options.separateRoots ? scenarioRoot : options.dedicated ? path.join(root, '001') : root;
    await fs.mkdir(path.join(sourceDirectory, 'test'), { recursive: true });
    const target = uri(path.join(sourceDirectory, 'process.yaml'));
    const settings = uri(options.dedicated || options.separateRoots ? path.join(sourceDirectory, 'test', `001.${options.settingsExtension || 'yaml'}`) : path.join(root, `variant.${options.settingsExtension || 'yaml'}`));
    const parent = uri(path.join(processRoot, 'parent.yaml'));
    await fs.writeFile(target.fsPath, (options.bom ? '\uFEFF' : '') + 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "child"\n    Имя: "Child"\n    Код: "001"\n    ПолныйКод: "Sales.001"\nШагиПроцесса:\n');
    await fs.writeFile(settings.fsPath, 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n    UIDПроцесса: "child"\n    ПроцессНаименование: "Child"\n    Код: "001"\n    Имя: "Child"\n');
    await fs.writeFile(parent.fsPath, 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "parent"\n    Имя: "Parent"\n    Код: "003"\nШагиПроцесса:\n    - ШагиПроцесса1:\n        UID: "calling"\n        ТипШага: "1"\n        ВложенныйПроцессUID: "child"\n        ВложенныйПроцессНаименование: "Child"\n        Наименование: "Child"\n');
    const documents = new Map<string, any>();
    const textDocuments: any[] = [];
    const opened: string[] = []; const errors: string[] = [];
    let input: string | undefined = 'Renamed'; let mutate: (() => void) | undefined;
    const open = async (resource: ReturnType<typeof uri>) => {
        if (!documents.has(resource.fsPath)) {
            const document = { uri: resource, isDirty: false, version: 1, text: (await fs.readFile(resource.fsPath, 'utf8')).replace(/^\uFEFF/u, ''),
                getText() { return this.text; }, positionAt(offset: number) { return { offset }; },
                async save() { await fs.writeFile(resource.fsPath, this.text); return true; } };
            documents.set(resource.fsPath, document);
            textDocuments.push(document);
        }
        return documents.get(resource.fsPath);
    };
    const active = await open(target);
    const scan = async () => buildScenarioCatalog(await Promise.all([target, parent].map(async resource => {
        const result = descriptors.parseTestInfoFromScenarioSource(await fs.readFile(resource.fsPath, 'utf8'), resource as any, resource.fsPath)!;
        return result;
    })));
    class Edit {
        replacements: any[] = []; moves: any[] = [];
        replace(resource: any, range: any, text: string) { this.replacements.push({ resource, range, text }); }
        renameFile(oldUri: any, newUri: any) { this.moves.push({ oldUri, newUri }); }
    }
    const host = {
        Uri: { file: uri, parse: (value: string) => uri(value.replace(/^file:\/\//u, '')) }, Range: class { constructor(readonly start: { offset: number }, readonly end: { offset: number }) {} }, WorkspaceEdit: Edit,
        window: { activeTextEditor: { document: active }, showTextDocument: async (document: any) => { opened.push(document.uri.fsPath); },
            showInputBox: async () => { mutate?.(); mutate = undefined; return input; },
            showQuickPick: async (items: any[]) => { mutate?.(); mutate = undefined; return items[0]; },
            showErrorMessage: async (message: string) => errors.push(message), showWarningMessage: async (message: string) => errors.push(message), showInformationMessage: async () => {} },
        workspace: { workspaceFolders: [{ uri: uri(root) }], getWorkspaceFolder: () => ({ uri: uri(root) }), textDocuments, openTextDocument: open,
            fs: { writeFile: async (resource: ReturnType<typeof uri>, bytes: Uint8Array) => {
                await fs.writeFile(resource.fsPath, bytes);
                for (const document of textDocuments.filter(doc => doc.uri.toString() === resource.toString())) {
                    document.text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/u, ''); document.version++;
                }
            } },
            applyEdit: async (edit: Edit) => { for (const replacement of [...edit.replacements].sort((left, right) => right.range.start.offset - left.range.start.offset)) {
                const document = await open(replacement.resource);
                document.text = document.text.slice(0, replacement.range.start.offset) + replacement.text + document.text.slice(replacement.range.end.offset);
                document.version++;
            }
                for (const move of edit.moves) {
                    await fs.rename(move.oldUri.fsPath, move.newUri.fsPath);
                    for (const document of textDocuments) {
                        const relative = path.relative(move.oldUri.fsPath, document.uri.fsPath);
                        if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { document.uri = uri(path.join(move.newUri.fsPath, relative)); }
                    }
                }
                return true; } },
        commands: { executeCommand: async () => {} }
    };
    const environment = { workspaceRoots: [root], scanRoots: [scenarioRoot, processRoot] };
    const dependencies: Record<string, unknown> = {
        vscode: host, './compilerProcesses': compilerProcesses, './compilerProcessSelection': selection,
        './scenarioYamlDocument': yaml, './scenarioDescriptor': descriptors, './preparedFileWrites': prepared,
        './scenarioIdentityFiles': nativeScenarioIdentityFiles(host), './scenarioNativeDocumentSnapshot': snapshots,
        './workspaceScanner': { scanWorkspaceForScenarioCatalog: scan }, './scenarioScanRoot': { resolveProcessScanRootFsPath: () => processRoot },
        './projectLibraryIntegration': { projectLibraryEnvironment: () => environment },
        './localization': { getTranslator: async () => (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '') }
    };
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const nativeProperties = { exports: {} as any };
    const propertiesDependencies: Record<string, unknown> = { ...dependencies,
        './scenarioPropertiesBindings': bindings, './scenarioPropertiesModel': propertiesModel, './scenarioPropertiesSession': propertiesSession,
        './scenarioPropertiesAttachments': propertiesAttachments,
        './projectLibraryMetadata': metadata, './projectLibraryStore': store, './yamlValidator': {},
        '../media/scenarioPropertiesProtocol.js': require(path.join(process.cwd(), 'media/scenarioPropertiesProtocol.js')) };
    vm.runInNewContext(ts.transpileModule(await fs.readFile(path.join(process.cwd(), 'src/scenarioPropertiesPanel.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module: nativeProperties, exports: nativeProperties.exports, Buffer, console, setTimeout, clearTimeout,
        require: (name: string) => propertiesDependencies[name] ?? require(name) });
    dependencies['./scenarioPropertiesPanel'] = nativeProperties.exports;
    dependencies['./scenarioPropertiesBindings'] = bindings;
    const module = { exports: {} as any };
    const source = await fs.readFile(path.join(process.cwd(), 'src/processEditorCommands.ts'), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, Buffer, console, require: (name: string) => dependencies[name] ?? require(name) });
    return { api: module.exports, target, parent, settings, active, opened, errors, host, open, root, scenarioRoot, processRoot, environment, uri, context: { extensionUri: uri('/extension') },
        setInput(value: string | undefined) { input = value; }, mutateDuringPick(callback: () => void) { mutate = callback; } };
}

test('process header opens settings by UID and renames linked records without changing the process code', async t => {
    const h = await harness(t);
    assert.equal(typeof h.api.openProcessTestSettingsFromEditor, 'function');
    await h.api.openProcessTestSettingsFromEditor(h.context, h.target);
    assert.deepEqual(h.opened, [h.settings.fsPath]);
    await h.api.changeProcessIdentityFromEditor(h.context, 'name', h.target);
    const own = parseDocument(await fs.readFile(h.target.fsPath, 'utf8')).toJS();
    assert.equal(own.ДанныеПроцесса.Имя, 'Renamed');
    assert.equal(own.ДанныеПроцесса.Код, '001');
    assert.equal(own.ДанныеПроцесса.UID, 'child');
    assert.equal(parseDocument(await fs.readFile(h.parent.fsPath, 'utf8')).toJS().ШагиПроцесса[0].ШагиПроцесса1.ВложенныйПроцессНаименование, 'Renamed');
    assert.equal(parseDocument(await fs.readFile(h.settings.fsPath, 'utf8')).toJS().ДанныеТеста.ПроцессНаименование, 'Renamed');
    assert.deepEqual(h.errors, []);
});

test('process code action updates default settings code and keeps the name independent', async t => {
    const h = await harness(t); h.setInput('002');
    await h.api.changeProcessIdentityFromEditor(h.context, 'code', h.target);
    const own = parseDocument(await fs.readFile(h.target.fsPath, 'utf8')).toJS();
    assert.equal(own.ДанныеПроцесса.Имя, 'Child');
    assert.equal(own.ДанныеПроцесса.ПолныйКод, 'Sales.002');
    assert.equal(parseDocument(await fs.readFile(h.settings.fsPath, 'utf8')).toJS().ДанныеТеста.Код, '002');
    assert.deepEqual(h.errors, []);
});

test('direct process code changes report the source URI after native path operations', async t => {
    const h = await harness(t);
    const result = await h.api.changeProcessIdentityFromEditor(h.context, 'code', h.target, '002');
    assert.equal(result.sourceUri, h.target.toString());
    assert.equal(JSON.stringify(result.uriMoves), '[]');
});

test('a BOM process code edit moves its dedicated folder and default settings while preserving custom variants and sidecars', async t => {
    const h = await harness(t, { dedicated: true, bom: true });
    const custom = path.join(h.root, '001', 'test', 'Custom.yaml');
    const text = (await fs.readFile(h.settings.fsPath, 'utf8')).replace('Код: "001"', 'Код: "Custom"').replace('Имя: "Child"', 'Имя: "Custom"');
    await fs.writeFile(custom, text);
    await fs.writeFile(h.target.fsPath + '.kot.yml', 'process sidecar');
    await fs.writeFile(h.settings.fsPath + '.kot.yml', 'settings sidecar');
    const result = await h.api.changeProcessIdentityFromEditor(h.context, 'code', h.target, '002');
    const destination = path.join(h.root, '002');
    const own = await fs.readFile(path.join(destination, 'process.yaml'), 'utf8');
    assert.ok(own.startsWith('\uFEFF')); assert.match(own, /Код: "002"/u); assert.match(own, /Имя: "Child"/u);
    assert.ok(await fs.stat(path.join(destination, 'test', '002.yaml')));
    assert.ok(await fs.stat(path.join(destination, 'test', '002.yaml.kot.yml')));
    assert.equal(await fs.readFile(path.join(destination, 'test', 'Custom.yaml'), 'utf8'), text);
    assert.equal(await fs.readFile(path.join(destination, 'process.yaml.kot.yml'), 'utf8'), 'process sidecar');
    assert.equal(result.sourceUri, h.active.uri.toString());
    assert.equal(result.sourceUri, h.uri(path.join(destination, 'process.yaml')).toString());
    assert.equal(result.uriMoves.length, 3);
    assert.deepEqual(h.errors, []);
});

test('process code edits preserve a configured scenario root distinct from the process root', async t => {
    const h = await harness(t, { separateRoots: true });
    const result = await h.api.changeProcessIdentityFromEditor(h.context, 'code', h.target, '002');
    assert.equal(result.sourceUri, h.target.toString());
    assert.ok(await fs.stat(h.scenarioRoot));
    assert.match(await fs.readFile(h.target.fsPath, 'utf8'), /Код: "002"/u);
    assert.ok(await fs.stat(path.join(h.scenarioRoot, 'test', '002.yaml')));
    await assert.rejects(fs.stat(path.join(h.root, '002')), { code: 'ENOENT' });
});

test('process identity edits update and move UID-linked yml settings and their sidecar', async t => {
    const h = await harness(t, { dedicated: true, settingsExtension: 'yml' });
    await fs.writeFile(h.settings.fsPath + '.kot.yml', 'authored settings sidecar');
    await h.api.changeProcessIdentityFromEditor(h.context, 'name', h.target, 'Renamed');
    assert.match(await fs.readFile(h.settings.fsPath, 'utf8'), /ПроцессНаименование: "Renamed"/u);
    await h.api.changeProcessIdentityFromEditor(h.context, 'code', h.target, '002');
    const destination = path.join(h.root, '002', 'test', '002.yml');
    assert.match(await fs.readFile(destination, 'utf8'), /Код: "002"/u);
    assert.equal(await fs.readFile(destination + '.kot.yml', 'utf8'), 'authored settings sidecar');
});

test('direct process name changes finish with the native BOM-stripped source ready for the next field edit', async t => {
    const h = await harness(t, { bom: true });
    await h.api.changeProcessIdentityFromEditor(h.context, 'name', h.target, 'Renamed');
    assert.match(h.active.getText(), /Имя: "Renamed"/u);
    assert.ok((await fs.readFile(h.target.fsPath, 'utf8')).startsWith('\uFEFF'));
});

test('process identity actions reject document changes while the prompt is open', async t => {
    const h = await harness(t); const before = await fs.readFile(h.target.fsPath, 'utf8');
    h.mutateDuringPick(() => { h.active.text += '# Author change\n'; h.active.version++; });
    await h.api.changeProcessIdentityFromEditor(h.context, 'name', h.target);
    assert.equal(await fs.readFile(h.target.fsPath, 'utf8'), before);
    assert.equal(h.errors.length, 1);
});

test('process settings relinking preserves their variant identity and parameters', async t => {
    const h = await harness(t);
    const document = await h.open(h.settings);
    document.text += 'ПараметрыТеста:\n    - ПараметрыТеста1:\n        Имя: "Currency"\n        Значение: "EUR"\n';
    await document.save();
    h.host.window.showQuickPick = async items => items.find(item => item.info?.uid === 'parent');
    await h.api.changeProcessTestSettingsFromEditor(h.context, h.settings);
    const data = parseDocument(await fs.readFile(h.settings.fsPath, 'utf8')).toJS();
    assert.equal(data.ДанныеТеста.UIDПроцесса, 'parent');
    assert.equal(data.ДанныеТеста.ПроцессНаименование, 'Parent');
    assert.equal(data.ДанныеТеста.Код, '001');
    assert.equal(data.ДанныеТеста.Имя, 'Child');
    assert.equal(data.ПараметрыТеста[0].ПараметрыТеста1.Значение, 'EUR');
    assert.deepEqual(h.errors, []);
});

test('process rename refuses to overwrite dirty linked settings', async t => {
    const h = await harness(t);
    const document = await h.open(h.settings); document.isDirty = true; document.text += '# unsaved variant\n';
    await h.api.changeProcessIdentityFromEditor(h.context, 'name', h.target);
    assert.equal(parseDocument(await fs.readFile(h.target.fsPath, 'utf8')).toJS().ДанныеПроцесса.Имя, 'Child');
    assert.ok(document.text.includes('# unsaved variant'));
    assert.equal(h.errors.length, 1);
});

test('dirty yml variants block process code changes before source files or paths change', async t => {
    const h = await harness(t, { dedicated: true, settingsExtension: 'yml' });
    const before = await fs.readFile(h.target.fsPath, 'utf8');
    const document = await h.open(h.settings); document.isDirty = true; document.text += '# unsaved variant\n';
    await assert.rejects(h.api.changeProcessIdentityFromEditor(h.context, 'code', h.target, '002'), /Save modified/iu);
    assert.equal(await fs.readFile(h.target.fsPath, 'utf8'), before);
    assert.ok(await fs.stat(h.settings.fsPath));
    assert.ok(document.getText().includes('# unsaved variant'));
    await assert.rejects(fs.stat(path.join(h.root, '002')), { code: 'ENOENT' });
});

test('process identity discovery excludes settings owned by another workspace or reached through links', async t => {
    const h = await harness(t);
    const otherRoot = path.join(h.root, 'other-project');
    h.environment.workspaceRoots.push(otherRoot);
    await fs.mkdir(otherRoot);
    const foreign = path.join(otherRoot, '001.yml');
    const before = await fs.readFile(h.settings.fsPath, 'utf8');
    await fs.writeFile(foreign, before);
    await fs.symlink(otherRoot, path.join(h.root, 'linked-project'), 'dir');
    await h.api.changeProcessIdentityFromEditor(h.context, 'name', h.target, 'Renamed');
    assert.match(await fs.readFile(h.settings.fsPath, 'utf8'), /ПроцессНаименование: "Renamed"/u);
    assert.equal(await fs.readFile(foreign, 'utf8'), before);
});

test('process rename rejects a target URI outside the catalog with a copied process UID', async t => {
    const h = await harness(t);
    const copy = { ...h.target, fsPath: path.join(path.dirname(h.target.fsPath), 'copy.yaml'), toString() { return `file://${this.fsPath}`; } };
    const source = await fs.readFile(h.target.fsPath, 'utf8'); await fs.writeFile(copy.fsPath, source);
    await h.api.changeProcessIdentityFromEditor(h.context, 'name', copy);
    assert.equal(await fs.readFile(h.target.fsPath, 'utf8'), source);
    assert.equal(await fs.readFile(copy.fsPath, 'utf8'), source);
    assert.equal(h.errors.length, 1);
});

test('process settings relinking rejects an ambiguous UID selected from the catalog', async t => {
    const h = await harness(t);
    const parent = (await fs.readFile(h.parent.fsPath, 'utf8')).replace('UID: "parent"', 'UID: "child"');
    await fs.writeFile(h.parent.fsPath, parent);
    const before = await fs.readFile(h.settings.fsPath, 'utf8');
    await h.api.changeProcessTestSettingsFromEditor(h.context, h.settings);
    assert.equal(await fs.readFile(h.settings.fsPath, 'utf8'), before);
    assert.equal(h.errors.length, 1);
});
