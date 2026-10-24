import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as fields from '../src/yamlHeaderFields';

function harness() {
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const uri = (name: string) => ({ toString: () => `file:///repo/${name}` });
    const editor = (name: string, type: string) => {
        const document = { uri: uri(name), fileName: `/repo/${name}`, languageId: 'yaml', version: 1,
            text: `ТипФайла: "${type}"\nДанныеТеста:\n    ПрофильПользователя: "Old"\n`, getText() { return this.text; },
            lineAt(index: number) { return { text: this.text.split('\n')[index], range: { line: index } }; } };
        return { document, async edit(callback: (builder: any) => void) {
            const lines = document.text.split('\n');
            callback({ replace: (range: { line: number }, value: string) => { lines[range.line] = value; } });
            document.text = lines.join('\n'); document.version++; return true;
        } };
    };
    const main = editor('test.yaml', 'НастройкаТеста'); const processEditor = editor('process-test.yaml', 'НастройкаПроцесса');
    const host = { window: { activeTextEditor: main, showTextDocument: async () => processEditor }, workspace: { openTextDocument: async () => processEditor.document } };
    const validator = { exports: {} as any };
    vm.runInNewContext(compile(fs.readFileSync(path.join(globalThis.process.cwd(), 'src/yamlValidator.ts'), 'utf8')), { module: validator, exports: validator.exports, require: () => host });
    const source = ts.createSourceFile('scenarioCreator.ts', fs.readFileSync(path.join(globalThis.process.cwd(), 'src/scenarioCreator.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
    const names = ['getActiveTestSettingsEditor', 'applyTestSettingsFieldUpdates'];
    const helpers = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || '')).map(node => node.getText(source)).join('\n');
    const api = vm.runInNewContext(compile(`${helpers}\n({ getActiveTestSettingsEditor, applyTestSettingsFieldUpdates });`), {
        vscode: host, ...validator.exports, ...fields, getTranslator: async () => (message: string) => message
    });
    return { api, main, process: processEditor, context: {} };
}

test('scenario-only settings commands reject process settings while shared pickers accept the exact requested URI', async () => {
    const h = harness();
    const receiver = await h.api.getActiveTestSettingsEditor(h.context, h.process.document.uri, true);
    await h.api.applyTestSettingsFieldUpdates(receiver.editor, receiver.fieldLines,
        { userProfileLine: { fieldName: 'ПрофильПользователя', value: 'Tester' } }, receiver);
    assert.ok(h.process.document.text.includes('ПрофильПользователя: "Tester"'));
    assert.ok(h.main.document.text.includes('ПрофильПользователя: "Old"'));
    await assert.rejects(h.api.getActiveTestSettingsEditor(h.context, h.process.document.uri), /run settings/u);
});

test('settings picker snapshot rejects a changed document before updating its field lines', async () => {
    const h = harness();
    const receiver = await h.api.getActiveTestSettingsEditor(h.context, h.process.document.uri, true);
    h.process.document.text = '# author change\n' + h.process.document.text; h.process.document.version++;
    const before = h.process.document.text;
    assert.equal(await h.api.applyTestSettingsFieldUpdates(receiver.editor, receiver.fieldLines,
        { userProfileLine: { fieldName: 'ПрофильПользователя', value: 'Tester' } }, receiver), false);
    assert.equal(h.process.document.text, before);
});
