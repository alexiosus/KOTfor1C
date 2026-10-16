import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import type * as vscode from 'vscode';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
const moduleUnderTest = { exports: {} as typeof import('../src/yamlValidator') };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/yamlValidator.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
    module: moduleUnderTest, exports: moduleUnderTest.exports, require: () => ({}), console
});

function document(source: string, fileName = '/repo/compiler.yaml', languageId = 'feature'): vscode.TextDocument {
    return { fileName, languageId, getText: () => source } as vscode.TextDocument;
}

test('process validators distinguish process descriptors and process test settings from scenarios', () => {
    const validator = moduleUnderTest.exports;
    const process = document('ТипФайла: "Процесс"\nДанныеПроцесса:\n  Имя: "Продажи"\n');
    const settings = document('ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n  UIDПроцесса: process\n');

    assert.equal(validator.isProcessYamlFile(process), true);
    assert.equal(validator.isProcessTestSettingsYamlFile(settings), true);
    assert.equal(validator.isProcessYamlFile(settings), false);
    assert.equal(validator.isProcessTestSettingsYamlFile(process), false);
    assert.equal(validator.isScenarioYamlFile(process), false);
    assert.equal(validator.isTestSettingsYamlFile(settings), false);
});

test('compiler YAML classification accepts the four compiler types and rejects unrelated documents', () => {
    const validator = moduleUnderTest.exports;
    for (const type of ['Сценарий', 'Процесс', 'НастройкаТеста', 'НастройкаПроцесса']) {
        assert.equal(validator.isCompilerYamlFile(document(`ТипФайла: '${type}' # compiler\n`)), true, type);
    }
    assert.equal(validator.isCompilerYamlFile(document('типфайла: процесс\n')), true);
    assert.equal(validator.isCompilerYamlFile(document('\uFEFFТипФайла: Процесс\r\n')), true);
    assert.equal(validator.isCompilerYamlFile(document('ТипФайла: Процесс\n', '/repo/process.yml', 'yaml')), true);
    assert.equal(validator.isCompilerYamlFile(document('setting: value\n')), false);
    assert.equal(validator.isCompilerYamlFile(document('ТипФайла: Процесс\n', '/repo/process.feature')), false);
});

test('process YAML classification ignores commented, nested and prefixed type values', () => {
    const validator = moduleUnderTest.exports;
    for (const source of [
        '# ТипФайла: Процесс\n',
        'Описание: |\n  ТипФайла: Процесс\n',
        'Данные:\n  ТипФайла: Процесс\n',
        'ТипФайла: ПроцессШаблон\n',
        'ТипФайла: "Процесс" suffix\n',
        'ТипФайла: НастройкаПроцессаШаблон\n'
    ]) {
        const doc = document(source);
        assert.equal(validator.isProcessYamlFile(doc), false, source);
        assert.equal(validator.isProcessTestSettingsYamlFile(doc), false, source);
        assert.equal(validator.isCompilerYamlFile(doc), false, source);
    }
});
