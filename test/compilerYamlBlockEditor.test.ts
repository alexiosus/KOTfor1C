import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { parseDocument } from 'yaml';
import * as blocks from '../src/compilerYamlBlocks';
import * as processActions from '../src/processEditorActions';

function harness() {
    const source = 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n    UIDПроцесса: "parent"\nПараметрыТеста:\nТегиТеста:\n';
    const uri = { scheme: 'file', toString: () => 'file:///repo/process-test.yaml' };
    const document = { uri, version: 1, text: source, getText() { return this.text; }, positionAt(offset: number) { return { offset }; } };
    const failures: string[] = []; const opened: string[] = [];
    let input = 'Currency'; let mutation: (() => void) | undefined;
    class Edit { text = ''; replace(_uri: unknown, _range: unknown, text: string) { this.text = text; } }
    const host = {
        Uri: { parse: () => uri }, Range: class {}, WorkspaceEdit: Edit,
        CodeLens: class { constructor(readonly range: any, readonly command: any) {} },
        workspace: { openTextDocument: async () => document, applyEdit: async (edit: Edit) => { document.text = edit.text; document.version++; return true; } },
        window: { showInputBox: async () => { mutation?.(); return input; }, showTextDocument: async () => { opened.push(uri.toString()); }, showErrorMessage: async (value: string) => failures.push(value) }
    };
    const dependencies = { vscode: host, './compilerYamlBlocks': blocks, './processEditorActions': processActions, './localization': { getTranslator: async () => (value: string, ...args: string[]) => value.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] || '') } } as Record<string, any>;
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const load = (filename: string) => {
        const module = { exports: {} as any };
        const file = path.join(process.cwd(), 'src', filename);
        vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name], console });
        return module.exports;
    };
    return { api: load('compilerYamlBlockEditor.ts'), load, document, failures, opened, source, context: { extensionUri: uri },
        target: { documentUri: uri.toString(), documentVersion: 1, section: 'ПараметрыТеста' },
        mutate(callback: () => void) { mutation = callback; }, setInput(value: string) { input = value; } };
}

test('block button inserts a compiler parameter into the captured settings file', async () => {
    const h = harness();
    assert.equal(typeof h.api.addCompilerYamlBlockCommand, 'function');
    await h.api.addCompilerYamlBlockCommand(h.context, h.target);
    const parameter = parseDocument(h.document.text).toJS().ПараметрыТеста[0].ПараметрыТеста1;
    assert.equal(parameter.Имя, 'Currency');
    assert.equal(parameter.ТипПараметра, 'Строка');
    assert.equal(parameter.Значение, '');
    assert.deepEqual(h.opened, ['file:///repo/process-test.yaml']);
    assert.deepEqual(h.failures, []);
});

test('block button rejects stale targets and edits made while the name dialog is open', async () => {
    const h = harness(); h.document.version++;
    await h.api.addCompilerYamlBlockCommand(h.context, h.target);
    assert.equal(h.document.text, h.source);
    assert.equal(h.failures.length, 1);
    const next = harness();
    next.mutate(() => { next.document.text += '# author change\n'; next.document.version++; });
    await next.api.addCompilerYamlBlockCommand(next.context, next.target);
    assert.equal(next.document.text, next.source + '# author change\n');
    assert.equal(next.failures.length, 1);
});

test('block CodeLenses carry section and document version instead of using the active editor', async () => {
    const h = harness();
    const lenses = await new h.api.CompilerYamlBlockCodeLensProvider(h.context.extensionUri).provideCodeLenses(h.document, { isCancellationRequested: false });
    assert.deepEqual(Array.from(lenses, (lens: any) => [lens.command.title, lens.command.arguments[0].section]), [
        ['Add parameter block', 'ПараметрыТеста'], ['Add tag block', 'ТегиТеста']
    ]);
    assert.equal(lenses[0].command.arguments[0].documentUri, 'file:///repo/process-test.yaml');
    assert.equal(lenses[0].command.arguments[0].documentVersion, 1);
});

test('editor does not offer parameter blocks filled automatically from scenario text', async () => {
    const h = harness(); h.document.text = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "one"\nПараметрыСценария:\nТегиСценария:\n';
    const lenses = await new h.api.CompilerYamlBlockCodeLensProvider(h.context.extensionUri).provideCodeLenses(h.document, { isCancellationRequested: false });
    assert.deepEqual(Array.from(lenses, (lens: any) => lens.command.arguments[0].section), ['ТегиСценария']);
});

test('process step header offers both add and edit actions for its exact file', async () => {
    const h = harness();
    h.document.text = 'ДанныеПроцесса:\n    UID: "parent"\nШагиПроцесса:\n';
    const Provider = h.load('processEditorCodeLens.ts').ProcessEditorCodeLensProvider;
    const lenses = await new Provider(h.context.extensionUri).provideCodeLenses(h.document, { isCancellationRequested: false });
    assert.deepEqual(Array.from(lenses, (lens: any) => lens.command.command), ['kotTestToolkit.addProcessSteps', 'kotTestToolkit.editProcessSteps']);
    assert.equal(lenses[1].command.title, 'Edit process steps');
    assert.equal(lenses[1].command.arguments[0], h.document.uri);
});
