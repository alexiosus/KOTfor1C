import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as yaml from 'yaml';
import type * as vscode from 'vscode';

const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');

function loadModule(name: string, dependencies: Record<string, unknown>): Record<string, any> {
    const module = { exports: {} as Record<string, any> };
    const source = fs.readFileSync(path.join(process.cwd(), 'src', `${name}.ts`), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, {
        module, exports: module.exports,
        require: (name: string) => dependencies[name] ?? {}, console
    });
    return module.exports;
}

const compilerFormat = loadModule('compilerFormatDiagnostics', { yaml });
const validator = loadModule('yamlValidator', { yaml, './compilerFormatDiagnostics': compilerFormat,
    vscode: { DiagnosticSeverity: { Warning: 1 }, l10n: { t: (message: string) => message } } });

test('YAML indentation diagnostics locate tab characters in map and sequence indentation', () => {
    const source = 'ТипФайла: "Процесс"\r\nДанныеПроцесса:\r\n\tИмя: "Name\tvalue"\r\nШагиПроцесса:\r\n  \t - ШагиПроцесса1:\r\n\t\tUID: "step"\r\n';
    const issues = validator.collectYamlIndentationTabs(source);
    assert.deepEqual(JSON.parse(JSON.stringify(issues)), [
        { line: 2, startCharacter: 0, endCharacter: 1, indentationLength: 1, replacement: '    ' },
        { line: 4, startCharacter: 2, endCharacter: 3, indentationLength: 4, replacement: '     ' },
        { line: 5, startCharacter: 0, endCharacter: 2, indentationLength: 2, replacement: '        ' }
    ]);
});

test('YAML indentation diagnostics preserve literal tabs after block scalar indentation', () => {
    const source = 'ТипФайла: "Сценарий"\nТекстСценария: |\n    #language: en\n    \tAnd step "value\tvalue"\n    \t\tAnd next\n';
    assert.equal(validator.collectYamlIndentationTabs(source).length, 0);
});

test('YAML indentation diagnostics detect a tab replacing required block scalar spaces', () => {
    for (const body of ['\tAnd step', '    And step\n\tAnd next']) {
        const issues = validator.collectYamlIndentationTabs(`ТекстСценария: |\n${body}\n`);
        assert.equal(issues.length, 1, body);
        assert.equal(issues[0].startCharacter, 0);
        assert.equal(issues[0].replacement, '    ');
    }
});

test('YAML indentation diagnostics ignore spaces, comments and valid flow or scalar tabs', () => {
    for (const source of [
        'ДанныеПроцесса:\n    Имя: "Name"\n',
        '\t# comment\n\t\nДанныеПроцесса:\n    Имя: "Name"\n',
        'Имя: "Name\tvalue"\n',
        'Items: [one,\n \t two]\n',
        'Value: "first\n \tsecond"\n'
    ]) {
        assert.equal(validator.collectYamlIndentationTabs(source).length, 0, source);
    }
});

class Position {
    constructor(public line: number, public character: number) {}
}

class Range {
    public start: Position;
    public end: Position;
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
        this.start = new Position(startLine, startCharacter);
        this.end = new Position(endLine, endCharacter);
    }
}

class Diagnostic {
    public source?: string;
    public code?: string;
    constructor(public range: Range, public message: string, public severity: number) {}
}

class WorkspaceEdit {
    public replacements: { range: Range; text: string }[] = [];
    replace(_uri: unknown, range: Range, text: string): void { this.replacements.push({ range, text }); }
}

class CodeAction {
    public edit?: WorkspaceEdit;
    public diagnostics?: Diagnostic[];
    public isPreferred?: boolean;
    constructor(public title: string, public kind: string) {}
}

function document(source: string, fileName = '/repo/compiler.yaml') {
    const lines = source.split(/\r?\n/u);
    return {
        fileName, languageId: fileName.endsWith('.feature') ? 'feature' : 'yaml', version: 1,
        uri: { scheme: 'file', fsPath: fileName, toString: () => `file://${fileName}` },
        lineCount: lines.length,
        getText: () => source,
        lineAt: (line: number) => ({ text: lines[line], range: new Range(line, 0, line, lines[line].length) })
    } as unknown as vscode.TextDocument;
}

function harness(ignoredCodes: string[] = []) {
    const api = {
        Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1 }, Position, Range,
        CodeAction, CodeActionKind: { QuickFix: 'quickfix' }, WorkspaceEdit,
        l10n: { t: (value: string) => value },
        workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'diagnostics.ignoredCodes' ? ignoredCodes : fallback }) }
    };
    const documentValidator = loadModule('yamlValidator', { yaml, vscode: api, './compilerFormatDiagnostics': compilerFormat });
    const exports = loadModule('scenarioDiagnostics', {
        vscode: api, './yamlValidator': documentValidator,
        './scenarioCompilerSyntax': { getCompilerScenarioBody: () => null },
        './scenarioValidationPolicy': { getScenarioValidationOptions: () => ({}), createDocumentValidationCancellation: () => () => false }
    });
    const provider = Object.create(exports.ScenarioDiagnosticsProvider.prototype);
    const published = new Map<string, Diagnostic[]>();
    provider.diagnostics = {
        set: (uri: vscode.Uri, values: Diagnostic[]) => published.set(uri.toString(), values),
        delete: (uri: vscode.Uri) => published.delete(uri.toString())
    };
    provider.rawDiagnosticsByUri = new Map();
    provider.phaseSwitcherProvider = { ensureFreshScenarioCatalog: () => { throw new Error('No catalog needed for YAML indentation'); } };
    provider.definitionResolver = { getView: () => { throw new Error('No definitions needed for YAML indentation'); } };
    return { provider, published };
}

test('YAML indentation diagnostics work for all compiler descriptors without scenario bodies or catalog reads', async () => {
    for (const type of ['Сценарий', 'Процесс', 'НастройкаТеста', 'НастройкаПроцесса']) {
        const { provider, published } = harness();
        const doc = document(`ТипФайла: "${type}"\nДанные:\n\tИмя: "Name"\n`);
        await provider.validateDocument(doc);
        const diagnostics = published.get(doc.uri.toString()) ?? [];
        assert.equal(diagnostics.length, 1, type);
        assert.equal(diagnostics[0].code, 'kotTestToolkit.yamlIndentationTab');
        assert.equal(diagnostics[0].severity, 0);
        assert.equal(diagnostics[0].range.start.line, 2);
        assert.equal(diagnostics[0].range.end.character, 1);
    }
});

test('YAML indentation quick fixes replace only structural indentation and keep scalar tabs and CRLF', async () => {
    const { provider, published } = harness();
    const source = 'ТипФайла: "Процесс"\r\nДанныеПроцесса:\r\n\tИмя: "Name\tvalue"\r\n\tUID: "process"\r\n';
    const doc = document(source);
    await provider.validateDocument(doc);
    const diagnostics = published.get(doc.uri.toString()) ?? [];
    const actions: CodeAction[] = await provider.provideCodeActions(doc, new Range(2, 0, 2, 1), { diagnostics: [diagnostics[0]] }, { isCancellationRequested: false });
    const single = actions.find(action => action.isPreferred);
    const all = actions.find(action => action.edit?.replacements.length === 2);
    assert.ok(single?.edit);
    assert.equal(single.edit.replacements.length, 1);
    assert.ok(all?.edit);
    let fixed = source;
    for (const edit of [...all.edit.replacements].reverse()) {
        const lines = fixed.split('\r\n');
        const line = edit.range.start.line;
        lines[line] = lines[line].slice(0, edit.range.start.character) + edit.text + lines[line].slice(edit.range.end.character);
        fixed = lines.join('\r\n');
    }
    assert.equal(fixed, 'ТипФайла: "Процесс"\r\nДанныеПроцесса:\r\n    Имя: "Name\tvalue"\r\n    UID: "process"\r\n');
    assert.equal(validator.collectYamlIndentationTabs(fixed).length, 0);
});

test('YAML indentation diagnostics respect ignored codes and clear after a structural tab is fixed', async () => {
    const ignored = harness(['kotTestToolkit.yamlIndentationTab']);
    const broken = document('ТипФайла: "Процесс"\nДанныеПроцесса:\n\tИмя: "Name"\n');
    await ignored.provider.validateDocument(broken);
    assert.equal(ignored.published.get(broken.uri.toString())?.length, 0);
    const { provider, published } = harness();
    await provider.validateDocument(broken);
    assert.equal(published.get(broken.uri.toString())?.length, 1);
    await provider.validateDocument(document('ТипФайла: "Процесс"\nДанныеПроцесса:\n    Имя: "Name"\n'));
    assert.equal(published.get(broken.uri.toString())?.length, 0);
});

test('YAML indentation diagnostics require an actual compiler type rather than a commented type', async () => {
    for (const source of [
        '# ТипФайла: Сценарий\nSettings:\n\tName: "value"\n',
        'ТипФайла: СценарийШаблон\nSettings:\n\tName: "value"\n',
        'Settings:\n\tName: "value"\n'
    ]) {
        const { provider, published } = harness();
        const doc = document(source);
        await provider.validateDocument(doc);
        assert.equal((published.get(doc.uri.toString()) ?? []).length, 0, source);
    }
});

test('compiler format warnings publish for all four descriptors before any body or catalog work', async () => {
    for (const type of ['Сценарий', 'Процесс', 'НастройкаТеста', 'НастройкаПроцесса']) {
        const { provider, published } = harness();
        const doc = document(`ТипФайла: "${type}"\nДанные:\n    Имя: Bare\n`);
        await provider.validateDocument(doc);
        const diagnostics = published.get(doc.uri.toString()) ?? [];
        assert.equal(diagnostics.length, 1, type);
        assert.equal(diagnostics[0].severity, 1);
        assert.equal(diagnostics[0].code, 'kotTestToolkit.compilerFormat');
        assert.equal(diagnostics[0].range.start.line, 2);
        assert.equal(diagnostics[0].range.start.character, 9);
    }
});

test('compiler format warnings respect ignored codes and clear when source is made compatible', async () => {
    const broken = document('ТипФайла: "Процесс"\nДанныеПроцесса:\n    Имя: Bare\n');
    const ignored = harness(['kotTestToolkit.compilerFormat']);
    await ignored.provider.validateDocument(broken);
    assert.equal(ignored.published.get(broken.uri.toString())?.length, 0);
    const { provider, published } = harness();
    await provider.validateDocument(broken);
    assert.equal(published.get(broken.uri.toString())?.length, 1);
    await provider.validateDocument(document('ТипФайла: "Процесс"\nДанныеПроцесса:\n    Имя: "Compatible"\n'));
    assert.equal(published.get(broken.uri.toString())?.length, 0);
});

test('compiler format warns for an open .yml settings file but leaves project sidecars untouched', async () => {
    const { provider, published } = harness();
    const doc = document('ТипФайла: "НастройкаТеста"\n', '/repo/test.yml');
    await provider.validateDocument(doc);
    const diagnostics = published.get(doc.uri.toString()) ?? [];
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, 1);
    assert.match(diagnostics[0].message, /\.yaml|\.yml/u);
    const sidecar = document('ТипФайла: "Процесс"\nИмя: Bare\n', '/repo/scen.yaml.kot.yml');
    await provider.validateDocument(sidecar);
    assert.equal(published.get(sidecar.uri.toString())?.length, 0);
});
