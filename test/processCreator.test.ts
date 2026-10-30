import { v3FixtureSync } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { parseDocument } from 'yaml';
import { v4 } from 'uuid';
import * as compilerProcesses from '../src/compilerProcesses';
import * as etalonBases from '../src/etalonBases';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import { parseScenarioDescriptor } from '../src/scenarioDescriptor';
import { resolveMainScenarioGroupSeed } from '../src/scenarioCreationSeed';
import type { TestInfo } from '../src/types';
import { TestNumberingStore, validateNewTestCode } from '../src/testNumberingStore';
import { ProjectPropertyCatalogStore } from '../src/projectPropertyCatalogStore';
import { resolveProjectLibraryRoot } from '../src/projectLibraryMetadata';
import * as propertyModel from '../src/scenarioPropertiesModel';
import { ScenarioYamlDocument } from '../src/scenarioYamlDocument';

function uri(fsPath: string) { return { scheme: 'file', fsPath, toString: () => `file://${fsPath}` }; }

async function harness(t: test.TestContext) {
    const root = v3FixtureSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kot-process-creator-')));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const scenarioUri = uri(path.join(root, 'order.yaml'));
    fs.writeFileSync(scenarioUri.fsPath, [
        'ДанныеСценария:', '    Имя: "Order"', '    UID: "scenario-order"', '    Код: "101"',
        'ПараметрыСценария:', '    - ПараметрыСценария1:', '        Имя: "Amount"', '        Значение: "10"',
        '        ТипПараметра: "Число"', '        ИсходящийПараметр: "Нет"'
    ].join('\n'));
    const definitions = [{ name: 'Order', uid: 'scenario-order', scenarioCode: '101', yamlFileUri: scenarioUri, relativePath: '' }] as TestInfo[];
    const errors: string[] = [];
    const opened: string[] = [];
    const inputs: Array<string | undefined> = ['Sales', '001'];
    const prompts: string[] = [];
    const modelPath = path.join(root, 'model.yaml');
    fs.writeFileSync(modelPath, etalonBases.stringifyEtalonBasesYaml([{
        name: 'Synthetic QA', databaseId: 'synthetic-db', dtFilePath: '',
        userProfiles: [{ profileName: 'Tester', login: 'test-user', password: '' }, { profileName: 'Administrator', login: 'admin', password: '' }]
    }]));
    const actions: string[] = [];
    const projectRegistrations: Array<{ uri: string; source: string; metadata?: unknown }> = [];
    const availableSteps: string[][] = [];
    let selectedStepUids: string[] | undefined;
    let cancelScenarios = false;
    let cancelBase = false;
    let cancelProfile = false;
    let changeDuringPick: (() => void) | undefined;
    let seriesPrefix: string | undefined;
    const state = new Map<string, unknown>();
    const documents = new Map<string, { uri: ReturnType<typeof uri>; version: number; text: string; getText(): string; positionAt(offset: number): { offset: number }; save(): Promise<boolean> }>();
    const openDocument = async (target: ReturnType<typeof uri>) => {
        opened.push(target.fsPath);
        let document = documents.get(target.fsPath);
        if (!document) {
            document = {
                uri: target, version: 1, text: await fs.promises.readFile(target.fsPath, 'utf8'),
                getText() { return this.text; }, positionAt(offset: number) { return { offset }; },
                async save() { await fs.promises.writeFile(this.uri.fsPath, this.text); return true; }
            };
            documents.set(target.fsPath, document);
        }
        return document;
    };
    class WorkspaceEdit {
        edits: Array<{ uri: ReturnType<typeof uri>; text: string }> = [];
        replace(target: ReturnType<typeof uri>, _range: unknown, text: string) { this.edits.push({ uri: target, text }); }
    }
    const moduleObject = { exports: {} as Record<string, unknown> };
    const sourcePath = path.join(process.cwd(), 'src/processCreator.ts');
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : 'export {};', {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const runtime: Record<string, unknown> = {
        module: moduleObject, exports: moduleObject.exports, console, Buffer,
        require: (specifier: string) => {
            switch (specifier) {
                case 'uuid': return { v4 };
                case 'vscode': return {
                    Uri: { file: uri, joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
                    WorkspaceEdit, Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
                    workspace: {
                        workspaceFolders: [{ uri: uri(root) }],
                        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
                        openTextDocument: openDocument,
                        applyEdit: async (edit: WorkspaceEdit) => {
                            for (const replacement of edit.edits) {
                                const document = documents.get(replacement.uri.fsPath)!;
                                document.text = replacement.text;
                                document.version += 1;
                            }
                            return true;
                        }
                    },
                    window: {
                        showInputBox: async (options: { prompt?: string; value?: string }) => { prompts.push(options.prompt ?? ''); const input = inputs.shift(); return input === '$default' ? options.value : input; },
                        showOpenDialog: async () => [uri(root)],
                        showTextDocument: async () => {},
                        showInformationMessage: async () => {},
                        showErrorMessage: async (message: string) => { errors.push(message); },
                        showQuickPick: async (items: Array<{ mode?: string; value?: string; series?: { prefix: string }; action?: string; scenario?: TestInfo; target?: TestInfo; index?: number; base?: etalonBases.EtalonBaseDefinition; profile?: etalonBases.EtalonBaseUserProfile }>, options: { canPickMany?: boolean; title?: string }) => {
                            if (options.title === 'Process header fields') { return items.find(item => item.mode === 'defaults'); }
                            if (options.title === 'Test numbering' || options.title === 'Author and numbering series') { return items.find(item => seriesPrefix ? item.series?.prefix === seriesPrefix : item.action === 'manual'); }
                            if (items.some(item => item.value !== undefined || item.action === 'none')) { return items.find(item => item.value !== undefined) ?? items.find(item => item.action === 'none'); }
                            if (changeDuringPick) { const mutation = changeDuringPick; changeDuringPick = undefined; mutation(); }
                            if (options.canPickMany) {
                                availableSteps.push(items.map(item => (item.target || item.scenario)?.uid || ''));
                                return cancelScenarios ? undefined : items.filter(item => {
                                    const info = item.target || item.scenario;
                                    return info && (!selectedStepUids || selectedStepUids.includes(info.uid || ''));
                                });
                            }
                            if (options.title === 'Reference infobase') { return cancelBase ? undefined : items.find(item => item.base?.databaseId === 'synthetic-db'); }
                            if (options.title === 'Test user profile') { return cancelProfile ? undefined : items.find(item => item.profile?.profileName === 'Tester'); }
                            const action = actions.shift() ?? 'done';
                            return action.startsWith('step:') ? items.find(item => item.index === Number(action.slice(5))) : items.find(item => item.action === action);
                        }
                    },
                    commands: { executeCommand: async () => {} }
                };
                case './scenarioCreator': {
                    const shared = { exports: {} };
                    const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/scenarioCreator.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
                    vm.runInNewContext(code, { ...runtime, module: shared, exports: shared.exports });
                    return shared.exports;
                }
                case './yamlParametersManager': return { YamlParametersManager: { getInstance: () => ({ loadParameters: async () => [{ key: 'ModelDBSettings', value: modelPath }] }) } };
                case './etalonBases': return etalonBases;
                case './compilerProcesses': return compilerProcesses;
                case './scenarioDescriptor': return { parseScenarioDescriptor };
                case './scenarioCreationSeed': return { resolveMainScenarioGroupSeed };
                case './projectLibraryIntegration': return {
                    projectLibraryEnvironment: () => ({ workspaceRoots: [root], scanRoots: [root] }),
                    registerCreatedProjectScenario: async (target: ReturnType<typeof uri>, source: string, metadata?: unknown) => {
                        assert.equal(await fs.promises.readFile(target.fsPath, 'utf8'), source);
                        projectRegistrations.push({ uri: target.toString(), source, metadata });
                    }
                };
                case './projectLibraryMetadata': return { loadProjectLibraryGroups: async () => [], resolveProjectLibraryRoot };
                case './testNumberingStore': return { TestNumberingStore, validateNewTestCode };
                case './projectPropertyCatalogStore': return { ProjectPropertyCatalogStore };
                case './scenarioPropertiesModel': return propertyModel;
                case './scenarioYamlDocument': return { ScenarioYamlDocument };
                case './testNumbering':
                case './scenarioCreationProperties': {
                    const loaded = { exports: {} };
                    const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), `src/${specifier.slice(2)}.ts`), 'utf8'), {
                        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
                    }).outputText;
                    vm.runInNewContext(code, { ...runtime, module: loaded, exports: loaded.exports }); return loaded.exports;
                }
                case './scenarioScanRoot': return { resolveScenarioScanRootFsPath: () => root };
                case './workspaceScanner': return {
                    scanWorkspaceForScenarioCatalog: async () => buildScenarioCatalog(definitions),
                    readTextFileFast: async (target: ReturnType<typeof uri>) => fs.promises.readFile(target.fsPath, 'utf8')
                };
                case './localization': return { getTranslator: async () => (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_match, index) => args[Number(index)] ?? '') };
                default: return specifier.startsWith('./') ? {} : require(specifier);
            }
        }
    };
    vm.runInNewContext(compiled, runtime);
    return { root, errors, opened, inputs, prompts, modelPath, actions, projectRegistrations, availableSteps, documents, definitions, openDocument,
        useSeries(prefix: string) { seriesPrefix = prefix; },
        selectSteps(uids: string[]) { selectedStepUids = uids; },
        cancelScenarios() { cancelScenarios = true; }, cancelBase() { cancelBase = true; }, cancelProfile() { cancelProfile = true; }, mutateDuringPick(mutation: () => void) { changeDuringPick = mutation; },
        context: { extensionUri: uri('/extension'), workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } }, api: moduleObject.exports as {
            handleCreateProcess(context: unknown, seed?: unknown): Promise<ReturnType<typeof uri> | undefined>;
            handleEditProcessSteps(context: unknown, target: unknown): Promise<void>;
            handleAddProcessSteps(context: unknown, target: unknown): Promise<boolean>;
        } };
}

test('process creation without a selected group uses virtual Ungrouped', async t => {
    const h = await harness(t);
    const created = await h.api.handleCreateProcess(h.context);
    assert.ok(created);
    assert.deepEqual(JSON.parse(JSON.stringify(h.projectRegistrations[0].metadata)), { groupName: '' });
});

test('process command creates an ordered compiler process and settings from selected workspace scenarios', async t => {
    const h = await harness(t);
    assert.equal(typeof h.api.handleCreateProcess, 'function');
    const created = await h.api.handleCreateProcess(h.context, { groupName: 'Smoke' });
    assert.equal(created?.fsPath, path.join(h.root, '001', 'process.yaml'));
    assert.equal(h.projectRegistrations.length, 1);
    assert.equal(h.projectRegistrations[0].uri, created!.toString());
    const process = parseDocument(fs.readFileSync(created!.fsPath, 'utf8')).toJS();
    const settings = parseDocument(fs.readFileSync(path.join(h.root, '001/test/001.yaml'), 'utf8')).toJS();
    assert.equal(Object.hasOwn(process, 'KOTМетаданные'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(h.projectRegistrations[0].metadata)), { groupName: 'Smoke' });
    assert.equal(process.ШагиПроцесса[0].ШагиПроцесса1.СценарийUID, 'scenario-order');
    // Missing overrides are completed from the referenced scenario by the compiler.
    assert.equal(process.ШагиПроцесса[0].ШагиПроцесса1.ПараметрыШага, null);
    assert.equal(parseDocument(fs.readFileSync(path.join(h.root, 'order.yaml'), 'utf8')).toJS().ПараметрыСценария[0].ПараметрыСценария1.ТипПараметра, 'Число');
    assert.equal(settings.ДанныеТеста.UIDПроцесса, process.ДанныеПроцесса.UID);
    assert.equal(settings.ДанныеТеста.ИдентификаторБазы, 'synthetic-db');
    assert.equal(settings.ДанныеТеста.ЭталоннаяБазаИмя, 'Synthetic QA');
    assert.equal(settings.ДанныеТеста.ПрофильПользователя, 'Tester');
    assert.equal(process.ДанныеПроцесса.ПрофильПользователя, 'Tester');
    assert.equal(process.ШагиПроцесса[0].ШагиПроцесса1.ИсполнительНаименование, 'Tester');
    assert.deepEqual(h.prompts, ['Enter process name', 'Enter process numeric code (digits only)']);
    assert.deepEqual(h.errors, []);
});

test('nested process creation omits launch settings and does not ask for a database', async t => {
    const h = await harness(t); h.cancelBase();
    const created = await h.api.handleCreateProcess(h.context, undefined, 'nested');
    assert.ok(created, h.errors.join('\n'));
    assert.equal(fs.existsSync(path.join(h.root, '001/test')), false);
    assert.equal(parseScenarioDescriptor(fs.readFileSync(created.fsPath, 'utf8')).kind, 'process');
    assert.equal(fs.existsSync(path.join(h.root, '001/files')), true);
});

test('cancelled scenario selection and an existing destination leave authored files intact', async t => {
    const cancelled = await harness(t);
    assert.equal(typeof cancelled.api.handleCreateProcess, 'function');
    cancelled.cancelScenarios();
    assert.equal(await cancelled.api.handleCreateProcess(cancelled.context), undefined);
    assert.equal(fs.existsSync(path.join(cancelled.root, '001')), false);
    const occupied = await harness(t);
    fs.mkdirSync(path.join(occupied.root, '001'));
    fs.writeFileSync(path.join(occupied.root, '001/process.yaml'), 'Authored process');
    assert.equal(await occupied.api.handleCreateProcess(occupied.context), undefined);
    assert.equal(fs.readFileSync(path.join(occupied.root, '001/process.yaml'), 'utf8'), 'Authored process');
    assert.equal(occupied.errors.length, 1);
});

test('step editor appends a selected scenario and rejects a document changed during interaction', async t => {
    const h = await harness(t);
    assert.equal(typeof h.api.handleEditProcessSteps, 'function');
    const processUri = uri(path.join(h.root, 'existing.yaml'));
    fs.writeFileSync(processUri.fsPath, 'ДанныеПроцесса:\n    Имя: "Existing"\n    UID: "process-existing"\n    Код: "002"\nШагиПроцесса:\n');
    h.actions.push('add', 'done');
    await h.api.handleEditProcessSteps(h.context, processUri);
    const document = await h.openDocument(processUri);
    assert.equal(parseDocument(document.text).toJS().ШагиПроцесса[0].ШагиПроцесса1.СценарийUID, 'scenario-order');
    const before = document.text;
    h.actions.push('add', 'done');
    h.mutateDuringPick(() => { document.text = before + '\n# Author change\n'; document.version += 1; });
    await h.api.handleEditProcessSteps(h.context, processUri);
    assert.equal(document.text, before + '\n# Author change\n');
    assert.equal(h.errors.length, 1);
});

test('creation rejects a process settings code already used by a hierarchical process', async t => {
    const h = await harness(t);
    h.definitions.push({
        name: 'Existing process', kind: 'process', uid: 'process-old', scenarioCode: '001', processCode: 'Sales.001',
        yamlFileUri: uri(path.join(h.root, 'existing-process.yaml')) as TestInfo['yamlFileUri'], relativePath: 'old'
    });
    assert.equal(await h.api.handleCreateProcess(h.context), undefined);
    assert.equal(fs.existsSync(path.join(h.root, '001')), false);
    assert.equal(h.errors.length, 1);
});


test('cancelling base or user-profile selection leaves the process uncreated', async t => {
    for (const cancel of ['cancelBase', 'cancelProfile'] as const) {
        const h = await harness(t);
        h[cancel]();
        assert.equal(await h.api.handleCreateProcess(h.context), undefined);
        assert.equal(fs.existsSync(path.join(h.root, '001')), false);
        assert.deepEqual(h.errors, []);
        assert.deepEqual(h.prompts, ['Enter process name', 'Enter process numeric code (digits only)']);
    }
});

test('empty etalon catalog keeps the shared wizard explicit manual-entry fallback', async t => {
    const h = await harness(t);
    fs.writeFileSync(h.modelPath, 'ЭталонныеБД: []');
    h.inputs.push('Manual base', 'manual-db', 'Manual profile');
    h.actions.push('manual');
    assert.ok(await h.api.handleCreateProcess(h.context));
    const settings = parseDocument(fs.readFileSync(path.join(h.root, '001/test/001.yaml'), 'utf8')).toJS();
    assert.equal(settings.ДанныеТеста.ЭталоннаяБазаИмя, 'Manual base');
    assert.equal(settings.ДанныеТеста.ИдентификаторБазы, 'manual-db');
    assert.equal(settings.ДанныеТеста.ПрофильПользователя, 'Manual profile');
});


function nestedProcess(h: Awaited<ReturnType<typeof harness>>, uid = 'shipping', children: string[] = []): TestInfo {
    const target = uri(path.join(h.root, `${uid}.yaml`));
    const source = `ДанныеПроцесса:
    Имя: "${uid}"
    UID: "${uid}"
    Код: "002"
    ПолныйКод: "002"
ШагиПроцесса:
`;
    fs.writeFileSync(target.fsPath, source);
    const info: TestInfo = { kind: 'process', name: uid, uid, processCode: '002', scenarioCode: '002', yamlFileUri: target as TestInfo['yamlFileUri'], relativePath: '',
        processSteps: children.map(processUid => ({ type: 'process', processUid })) };
    h.definitions.push(info);
    return info;
}

test('creation can mix scenarios with nested processes without changing the referenced process', async t => {
    const h = await harness(t);
    const child = nestedProcess(h);
    const before = fs.readFileSync(child.yamlFileUri.fsPath, 'utf8');
    const created = await h.api.handleCreateProcess(h.context);
    assert.ok(created);
    const data = parseDocument(fs.readFileSync(created.fsPath, 'utf8')).toJS();
    assert.equal(data.ШагиПроцесса.length, 2);
    const nested = data.ШагиПроцесса[1].ШагиПроцесса2;
    assert.equal(nested.ТипШага, '1');
    assert.equal(nested.ВложенныйПроцессUID, 'shipping');
    assert.equal(nested.ВложенныйПроцессНаименование, 'shipping');
    assert.equal('СценарийUID' in nested, false);
    assert.equal(fs.readFileSync(child.yamlFileUri.fsPath, 'utf8'), before);
});

test('direct add-steps action inserts nested processes and excludes self and indirect cycles', async t => {
    const h = await harness(t);
    const parent = nestedProcess(h, 'parent');
    nestedProcess(h, 'ancestor', ['parent']);
    nestedProcess(h, 'cyclic', ['cyclic']);
    nestedProcess(h, 'allowed');
    h.selectSteps(['allowed']);
    assert.equal(typeof h.api.handleAddProcessSteps, 'function');
    assert.equal(await h.api.handleAddProcessSteps(h.context, parent.yamlFileUri), true);
    assert.deepEqual([...h.availableSteps[0]].sort(), ['allowed', 'scenario-order']);
    const data = parseDocument(fs.readFileSync(parent.yamlFileUri.fsPath, 'utf8')).toJS();
    assert.equal(data.ШагиПроцесса[0].ШагиПроцесса1.ВложенныйПроцессUID, 'allowed');
    assert.deepEqual(h.errors, []);
});

test('step editor adds nested process records through the same step selection', async t => {
    const h = await harness(t);
    const parent = nestedProcess(h, 'parent'); nestedProcess(h, 'child');
    h.selectSteps(['child']); h.actions.push('add', 'done');
    await h.api.handleEditProcessSteps(h.context, parent.yamlFileUri);
    const data = parseDocument(fs.readFileSync(parent.yamlFileUri.fsPath, 'utf8')).toJS();
    assert.equal(data.ШагиПроцесса?.[0]?.ШагиПроцесса1?.ТипШага, '1');
    assert.equal(data.ШагиПроцесса[0].ШагиПроцесса1.ВложенныйПроцессUID, 'child');
});


test('a process changed to a cycle while the picker is open cannot be inserted', async t => {
    const h = await harness(t);
    const parent = nestedProcess(h, 'parent'); const child = nestedProcess(h, 'child');
    h.selectSteps(['child']);
    const before = fs.readFileSync(parent.yamlFileUri.fsPath, 'utf8');
    h.mutateDuringPick(() => { child.processSteps = [{ type: 'process', processUid: 'parent' }]; });
    assert.equal(await h.api.handleAddProcessSteps(h.context, parent.yamlFileUri), false);
    assert.equal(fs.readFileSync(parent.yamlFileUri.fsPath, 'utf8'), before);
    assert.equal(h.errors.length, 1);
});

test('cancelling Add process steps reports no mutation to its caller', async t => {
    const h = await harness(t); const parent = nestedProcess(h, 'parent');
    const before = fs.readFileSync(parent.yamlFileUri.fsPath, 'utf8');
    h.cancelScenarios();
    assert.equal(await h.api.handleAddProcessSteps(h.context, parent.yamlFileUri), false);
    assert.equal(fs.readFileSync(parent.yamlFileUri.fsPath, 'utf8'), before);
    assert.deepEqual(h.errors, []);
});

test('process creation uses the next author code and editable shared header fields', async t => {
    const h = await harness(t);
    await new TestNumberingStore(h.root).addSeries('000012', 'Tester A', ['000012009']); h.useSeries('000012');
    h.inputs[1] = '$default';
    const created = await h.api.handleCreateProcess(h.context);
    assert.ok(created); assert.deepEqual(h.errors, []);
    assert.equal(created.fsPath, path.join(h.root, '000012010/process.yaml'));
    const source = parseDocument(fs.readFileSync(created.fsPath, 'utf8')).toJS();
    assert.equal(source.ДанныеПроцесса.Код, '000012010');
    assert.equal(source.ДанныеПроцесса.Ответственный, 'Tester A');
    assert.equal(source.ДанныеПроцесса.Проект, 'Drive');
    assert.equal((await new TestNumberingStore(h.root).read()).series[0].lastNumber, 10);
});
