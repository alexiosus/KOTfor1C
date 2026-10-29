import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import * as creator from '../src/userStepCreator';
import * as builder from '../src/userStepLibraryBuilder';
import * as dump from '../src/userStepLibraryDump';
import * as state from '../src/userStepLibraryState';
import { ProjectDefinitionIndexService } from '../src/projectDefinitionIndexService';

async function harness(t: { after(fn: () => Promise<void>): void }) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kot-epf-command-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const template = path.join(root, 'vanessa', 'lib', 'TemplateEpfUF');
    for (const relative of ['Обработка.xml', 'Обработка/Forms/Форма.xml', 'Обработка/Forms/Форма/Ext/Form.xml', 'Обработка/Forms/Форма/Ext/Form/Module.bsl']) {
        const file = path.join(template, relative);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, relative.endsWith('.bsl') ? '' : relative === 'Обработка.xml' ? '<ExternalDataProcessor/>' : '<Form/>');
    }
    const library = path.join(root, 'libraries');
    await fs.promises.mkdir(library);
    const source = path.join(library, 'Steps.bsl');
    const original = '&НаКлиенте\nПерем Контекст Экспорт;\n&НаКлиенте\nПерем КонтекстСохраняемый Экспорт;\n&НаКлиенте\nФункция ПолучитьСписокТестов(КонтекстФреймворкаBDD) Экспорт\n    ВсеТесты = Новый Массив;\n    КонтекстФреймворкаBDD.ДобавитьШагВМассивТестов(ВсеТесты, "Шаг()", "Шаг", "И готовый шаг", "", "");\n    Возврат ВсеТесты;\nКонецФункции\n&НаКлиенте\nПроцедура Шаг() Экспорт\n    Сообщить("готово");\nКонецПроцедуры\n';
    await fs.promises.writeFile(source, original);
    const uri = (file: string) => ({ fsPath: file, scheme: 'file', toString: () => pathToFileURL(file).href });
    const definition: any = { id: 'step', kind: 'userStep', template: 'And ready', libraryRootUri: uri(library).toString(),
        definitionLocation: { uri: uri(source).toString() }, userStepLibrary: { status: 'sourceOnly', sourceDirectory: library } };
    const calls: string[][] = [];
    const revealed: string[] = [];
    const warnings: string[] = [];
    let refreshes = 0;
    let input: string | undefined;
    let pick: ((choices: any[]) => any) | undefined;
    const host = {
        Uri: { file: uri, parse: (value: string) => uri(fileURLToPath(value)) }, ProgressLocation: { Notification: 1 },
        workspace: { textDocuments: [], openTextDocument: async (value: any) => ({ fileName: value.fsPath, getText: () => fs.readFileSync(value.fsPath, 'utf8') }) },
        window: {
            showInputBox: async (options: any) => input ?? options.value, showQuickPick: async (choices: any[]) => pick ? pick(choices) : choices[0],
            showTextDocument: async () => undefined, showInformationMessage: () => undefined,
            showWarningMessage: (message: string) => warnings.push(message), showErrorMessage: (message: string) => { throw new Error(message); },
            createOutputChannel: () => ({ show() {}, appendLine() {}, dispose() {} }),
            withProgress: async (_options: unknown, run: any) => run({}, { isCancellationRequested: false })
        },
        commands: { executeCommand: async (command: string) => { revealed.push(command); } }
    };
    const modules: Record<string, unknown> = {
        vscode: host, './userStepCreator': creator, './userStepLibraryBuilder': builder,
        './userStepLibraryDump': dump, './userStepLibraryState': state,
        './oneCPlatform.js': { resolveOneCDesignerExePath: () => 'designer.exe', resolveOneCPlatformForLaunch: async () => ({ clientExePath: 'client.exe' }) },
        './startupInfobase.js': { ensureSharedStartupInfobaseReady: async () => ({ infobaseDirectory: root, authentication: null }) },
        './directProcessLaunch': {
            buildDirectSpawnCommand: (_executable: string, args: string[]) => ({ args }),
            runDirectProcess: async ({ args }: { args: string[] }) => {
                calls.push(args);
                const buildAt = args.indexOf('/LoadExternalDataProcessorOrReportFromFiles');
                if (buildAt >= 0) { await fs.promises.writeFile(args[buildAt + 2], 'compiled EPF'); }
                else {
                    const directory = args[args.indexOf('/DumpExternalDataProcessorOrReportToFiles') + 1];
                    await fs.promises.writeFile(path.join(directory, 'Обработка.xml'), '<ExternalDataProcessor/>');
                    await fs.promises.writeFile(path.join(directory, 'Module.bsl'), original);
                }
                return { exitCode: 0, stdout: '', stderr: '' };
            }
        }
    };
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const module = { exports: {} as Record<string, any> };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/userStepCommands.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, process, require: (id: string) => modules[id] ?? (id.startsWith('node:') ? require(id) : {}) });
    const indexedDefinitions = new Map([['step', definition]]);
    const services = { context: { subscriptions: [] }, index: { ensureReady: async () => ({ byId: indexedDefinitions }) },
        loadLibraryRoots: async () => [{ path: library, uri: uri(library).toString(), templateRoot: template }],
        refreshLibraries: async () => { refreshes++; } };
    const seed = { definitionId: 'step', documentUri: uri(source).toString() };
    return { root, library, source, original, definition, calls, revealed, warnings, services, seed, indexedDefinitions, commands: module.exports,
        setPick(value: (choices: any[]) => any) { pick = value; },
        setInput(value: string) { input = value; }, get refreshes() { return refreshes; } };
}

test('Build from a source-only Library row preserves the implementation and produces an available library', async t => {
    const h = await harness(t);
    assert.equal(await h.commands.buildUserStepLibraryCommand(h.seed, h.services), true);
    const module = path.join(h.library, 'step_definitions-src/Steps/Обработка/Forms/Форма/Ext/Form/Module.bsl');
    assert.equal(await fs.promises.readFile(module, 'utf8'), h.original);
    assert.equal(await fs.promises.readFile(h.source, 'utf8'), h.original);
    const imported = await state.inspectUserStepLibrary(h.source, h.library);
    assert.equal(imported.importedModulePath, module);
    assert.equal((await state.inspectUserStepLibrary(module, h.library)).status, 'ready');
    assert.equal(h.calls.length, 1);
    assert.equal(h.refreshes, 1);
});

test('wrapping a BSL indexes only the generated module, including after edits and a restart', async t => {
    const h = await harness(t);
    h.setInput('RenamedLibrary');
    await h.commands.buildUserStepLibraryCommand(h.seed, h.services);
    const module = path.join(h.library, 'step_definitions-src/RenamedLibrary/Обработка/Forms/Форма/Ext/Form/Module.bsl');
    const createIndex = () => {
        const service = new ProjectDefinitionIndexService({ parserVersion: 'test', resolveUserStepLibrary: state.inspectUserStepLibrary,
            fileSystem: {
                readDirectory: async directory => (await fs.promises.readdir(directory, { withFileTypes: true })).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' as const : 'file' as const })),
                stat: file => fs.promises.stat(file), readFile: file => fs.promises.readFile(file, 'utf8'), realpath: file => fs.promises.realpath(file)
            } });
        service.startProfile({ identity: 'imports', workspaceFolderPath: h.root, workspaceFolderUri: pathToFileURL(h.root).href,
            profileId: 'test', libraryRootPaths: [h.library], warnings: [] });
        t.after(async () => { service.dispose(); });
        return service;
    };
    const first = createIndex();
    let snapshot = await first.ensureReady();
    assert.equal(snapshot.definitions.length, 1);
    assert.equal(fileURLToPath(snapshot.definitions[0].definitionLocation!.uri), module);
    assert.equal(snapshot.definitions[0].userStepLibrary?.status, 'ready');
    first.dispose();
    await fs.promises.writeFile(module, h.original.replace('готово', 'изменено'));
    const restarted = createIndex();
    snapshot = await restarted.ensureReady();
    assert.equal(snapshot.definitions.length, 1, 'The preserved BSL must not reappear when its generated module changes');
    assert.equal(snapshot.definitions[0].userStepLibrary?.status, 'stale');
    await fs.promises.rm(path.join(h.library, 'step_definitions-src', 'RenamedLibrary'), { recursive: true });
    await restarted.refreshLibraries();
    snapshot = await restarted.ensureReady();
    assert.equal(snapshot.definitions.length, 1, 'Removing the generated project must restore its original BSL');
    assert.equal(fileURLToPath(snapshot.definitions[0].definitionLocation!.uri), h.source);
    assert.equal(snapshot.definitions[0].userStepLibrary?.status, 'sourceOnly');
    h.setInput('RecreatedLibrary');
    assert.equal(await h.commands.buildUserStepLibraryCommand(h.seed, h.services), true, 'An original whose former project was deleted can be wrapped again under a new name');
    await restarted.refreshLibraries();
    snapshot = await restarted.ensureReady();
    assert.equal(snapshot.definitions.length, 1);
    assert.equal(snapshot.definitions[0].userStepLibrary?.status, 'ready');
});

test('the general Build command offers a standalone BSL when no EPF source project exists', async t => {
    const h = await harness(t);
    assert.equal(await h.commands.buildUserStepLibraryCommand(undefined, h.services), true);
    const module = path.join(h.library, 'step_definitions-src/Steps/Обработка/Forms/Форма/Ext/Form/Module.bsl');
    assert.equal(await fs.promises.readFile(module, 'utf8'), h.original);
    assert.equal((await state.inspectUserStepLibrary(module, h.library)).status, 'ready');
    assert.deepEqual(h.warnings, []);
});

test('the general Build picker offers standalone BSL alongside existing source projects', async t => {
    const h = await harness(t);
    await h.commands.buildUserStepLibraryCommand(h.seed, h.services);
    const additionalSource = path.join(h.library, 'Additional.bsl');
    await fs.promises.writeFile(additionalSource, h.original);
    h.indexedDefinitions.set('additional', { ...h.definition, id: 'additional',
        definitionLocation: { uri: pathToFileURL(additionalSource).href } });
    h.setPick(choices => choices.find(choice => choice.label.includes('Additional.bsl')));
    assert.equal(await h.commands.buildUserStepLibraryCommand(undefined, h.services), true);
    const module = path.join(h.library, 'step_definitions-src/Additional/Обработка/Forms/Форма/Ext/Form/Module.bsl');
    assert.equal((await state.inspectUserStepLibrary(module, h.library)).status, 'ready');
});

test('cancelling standalone BSL selection does not create a source project or run Designer', async t => {
    const h = await harness(t);
    h.setPick(() => undefined);
    assert.equal(await h.commands.buildUserStepLibraryCommand(undefined, h.services), false);
    assert.equal(fs.existsSync(path.join(h.library, 'step_definitions-src')), false);
    assert.equal(h.calls.length, 0);
});

test('Dump from a Library row refuses existing sources and then accepts a new directory', async t => {
    const h = await harness(t);
    await h.commands.buildUserStepLibraryCommand(h.seed, h.services);
    const module = path.join(h.library, 'step_definitions-src/Steps/Обработка/Forms/Форма/Ext/Form/Module.bsl');
    h.definition.userStepLibrary = await state.inspectUserStepLibrary(module, h.library);
    assert.equal(await h.commands.dumpUserStepLibraryCommand(h.seed, h.services), false);
    assert.equal(h.calls.length, 1, 'Existing sources must be refused before Designer runs');
    h.setInput('ImportedSteps');
    assert.equal(await h.commands.dumpUserStepLibraryCommand(h.seed, h.services), true);
    assert.equal((await state.inspectUserStepLibrary(path.join(h.library, 'step_definitions-src/ImportedSteps/Module.bsl'), h.library)).status, 'ready');
    assert.deepEqual(h.revealed, ['revealInExplorer']);
    assert.equal(await h.commands.buildUserStepLibraryCommand(undefined, h.services), true);
    assert.equal(fs.existsSync(path.join(h.library, 'step_definitions/ImportedSteps.epf')), false, 'Toolbar builds must preserve the imported EPF association');
});
