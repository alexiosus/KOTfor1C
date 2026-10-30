import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as compiler from '../src/scenarioCompilerSyntax';
import * as blocks from '../src/blockKeywordParser';

function load() {
    const vscode = {
        SemanticTokensLegend: class { constructor(readonly tokenTypes: string[]) {} },
        SemanticTokensBuilder: class { data: any[] = [];
            constructor(private readonly legend: { tokenTypes: string[] }) {}
            push(line: number, char: number, length: number, type: number) { this.data.push({ line, char, length, type: this.legend.tokenTypes[type] }); }
            build() { return { data: this.data }; } },
        SemanticTokens: class { constructor(readonly data: unknown) {} },
        EventEmitter: class { event = () => {}; fire() {} dispose() {} },
        Position: class { constructor(readonly line: number, readonly character: number) {} },
        Range: class { constructor(readonly start: any, readonly end: any) {} },
        workspace: { getConfiguration: () => ({ get: () => true }) }
    };
    const module = { exports: {} as any }; const ts = require('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/scenarioSyntaxHighlightProvider.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, Uint32Array, require: (name: string) => name === 'vscode' ? vscode
        : name.endsWith('yamlValidator') ? { isScenarioYamlFile: () => true } : name.endsWith('blockKeywordParser') ? blocks : compiler });
    return module.exports;
}

function document(fileName: string, text: string) {
    const lines = text.split('\n');
    return { fileName, languageId: fileName.endsWith('.yaml') ? 'yaml' : 'feature', uri: {}, lineCount: lines.length,
        getText: () => text, lineAt: (line: number) => ({ text: lines[line] }) };
}
function tokens(doc: ReturnType<typeof document>) {
    const result = new (load().ScenarioSyntaxHighlightProvider)().provideDocumentSemanticTokens(doc).data as { line: number; char: number; length: number; type: string }[];
    const lines = doc.getText().split('\n');
    return result.map(token => ({ ...token, text: lines[token.line].slice(token.char, token.char + token.length) }));
}

test('ordinary feature, native feature and YAML use identical table tokens without overlap', () => {
    const table = '| "Value" | [Customer] | $Local$ | $$Global$$ |';
    const fixtures = [document('/test.feature', '# language: en\nFeature: Own\nScenario: Own\n  And step\n  ' + table),
        document('/scen.feature', '# language: en\nAnd step\n' + table),
        document('/scen.yaml', 'ТипФайла: "Сценарий"\nТекстСценария: |\n    And step\n    ' + table)];
    const expected = tokens(fixtures[0]).filter(token => token.line === 4).map(({ type, text }) => ({ type, text }));
    assert.ok(expected.some(token => token.type === 'gherkinTable'));
    for (const doc of fixtures) {
        const line = doc.getText().split('\n').findIndex(text => text.includes(table));
        const row = tokens(doc).filter(token => token.line === line);
        assert.deepEqual(row.map(({ type, text }) => ({ type, text })), expected);
        for (let index = 1; index < row.length; index++) { assert.ok(row[index - 1].char + row[index - 1].length <= row[index].char); }
        assert.deepEqual(row.filter(token => token.type === 'gherkinVariable').map(token => token.text), ['$Local$', '$$Global$$']);
        assert.deepEqual(row.filter(token => token.type === 'gherkinBracketParameter').map(token => token.text), ['[Customer]']);
    }
});

test('runtime variables are visible inside strings and docstrings, while comments and YAML metadata keep their own tokens', () => {
    const script = 'And I save "$Local$ and $$Global$$"\nAnd step\n  """\n  $Payload$\n  """\n# $Comment$\nAnd escaped "\\$Literal$"\n';
    for (const doc of [document('/ordinary.feature', '# language: en\nFeature: Own\nScenario: Own\n' + script),
        document('/scen.yaml', 'ТипФайла: "Сценарий"\nОписание: "$Metadata$"\nТекстСценария: |\n' + script.replace(/^/gmu, '    '))]) {
        assert.deepEqual(tokens(doc).filter(token => token.type === 'gherkinVariable').map(token => token.text), ['$Local$', '$$Global$$', '$Payload$']);
    }
});


test('variable decoration ranges follow semantic tokens in feature and YAML without touching metadata or comments', () => {
    const script = 'And I use "$Local$" and $$Global$$\n  | "$Cell$" | [Customer] |\nAnd payload\n  """\n  $Payload$\n  """\n# $Comment$\nAnd escaped "\\$Literal$"';
    const api = load();
    for (const doc of [document('/own.feature', script),
        document('/scen.yaml', 'Описание: "$Metadata$"\nТекстСценария: |\n' + script.replace(/^/gmu, '    '))]) {
        const lines = doc.getText().split('\n');
        const actual = api.collectScenarioRuntimeVariableRanges(doc).map((range: any) => lines[range.start.line].slice(range.start.character, range.end.character));
        assert.deepEqual([...actual], ['$Local$', '$$Global$$', '$Cell$', '$Payload$']);
    }
});
