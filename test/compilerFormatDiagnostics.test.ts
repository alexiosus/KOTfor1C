import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCompilerFormatIssues } from '../src/compilerFormatDiagnostics';

const scenario = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Order"\n';
function issues(source: string, fileName = '/repo/scen.yaml') {
    return collectCompilerFormatIssues(source, fileName);
}

test('compiler format diagnostics warn about scalars the compiler would strip rather than decode', () => {
    const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Order\n    Код: 42\n    Enabled: true\n    Empty: null\n    Missing:\n';
    assert.deepEqual(issues(source).map(issue => [issue.kind, issue.line, issue.startCharacter, issue.endCharacter]), [
        ['scalar', 0, 10, 18], ['scalar', 2, 9, 14], ['scalar', 3, 9, 11],
        ['scalar', 4, 13, 17], ['scalar', 5, 11, 15]
    ]);
});

test('compiler format diagnostics accept exported quoted scalars, empty sections and literal payload', () => {
    const source = '\uFEFF' + scenario.replace(/\n/gu, '\r\n')
        + 'ПараметрыСценария:\r\n    - ПараметрыСценария1:\r\n        Значение: \'EUR\\;GBP\'\r\n        ТипПараметра: "Строка"\r\nТекстСценария: |\r\n    # language: en\r\n    And I run\r\n      # preserved compiler body comment\r\n    """\r\n    Code: true # payload\r\n    """\r\n';
    assert.deepEqual(issues(source), []);
});

test('compiler format diagnostics warn about YAML block modifiers unsupported by the exact literal marker', () => {
    for (const marker of ['|-', '|+', '|2', '>', '>-']) {
        const found = issues(scenario + `ТекстСценария: ${marker}\n    # body\n    And I run\n`);
        assert.deepEqual(found.map(issue => [issue.kind, issue.line]), [['blockScalar', 3]], marker);
    }
});

test('compiler format diagnostics warn about structural two-space indentation without flagging body indentation', () => {
    const source = 'ТипФайла: "Процесс"\nДанныеПроцесса:\n  Имя: "Flow"\nШагиПроцесса:\n  - ШагиПроцесса1:\n    UID: "step"\n';
    assert.deepEqual(issues(source).map(issue => [issue.kind, issue.line, issue.endCharacter]), [
        ['indentation', 2, 2], ['indentation', 4, 2]
    ]);
});

test('compiler format diagnostics warn about comments retained by the legacy reader while preserving source', () => {
    const source = scenario + '# structural comment\nПараметрыСценария: # section\n    - ПараметрыСценария1:\n        Имя: "A # literal" # inline\n        Значение: "https://example.test/#fragment"\n        ТипПараметра: "Строка"\nТекстСценария: | # modifier comment\n    # body: kept\n    And I run\n';
    assert.deepEqual(issues(source).map(issue => [issue.kind, issue.line]), [
        ['comment', 3], ['comment', 4], ['comment', 6], ['comment', 9]
    ]);
    assert.ok(source.includes('# body: kept'));
});

test('compiler format diagnostics warn about .yml descriptors and settings ignored by the compiler scan', () => {
    for (const kind of ['Сценарий', 'Процесс', 'НастройкаТеста', 'НастройкаПроцесса']) {
        assert.deepEqual(issues(`ТипФайла: "${kind}"\n`, '/repo/source.YML').map(issue => issue.kind), ['extension'], kind);
    }
});

test('compiler format diagnostics leave sidecars, native features, bases and false type markers alone', () => {
    for (const [source, file] of [
        [scenario, '/repo/scen.yaml.kot.yml'], [scenario, '/repo/feature.feature'],
        ['ЭталонныеБД:\n  Имя: Demo\n', '/repo/bases.yaml'],
        ['# ТипФайла: Сценарий\nSetting: true\n', '/repo/settings.yaml'],
        ['Description: |\n    ТипФайла: Сценарий\n', '/repo/settings.yaml'],
        ['ТипФайла: СценарийШаблон\nSetting: true\n', '/repo/settings.yaml']
    ]) { assert.deepEqual(issues(source, file), [], file); }
});

test('compiler format diagnostics warn about flow and multiline quoted values outside compiler payload', () => {
    const source = scenario + 'ТегиСценария: []\nCustom: { Value: "A" }\nDescription: "first\n  next"\n';
    assert.deepEqual(issues(source).map(issue => [issue.kind, issue.line]), [['scalar', 3], ['scalar', 4], ['scalar', 5]]);
});

test('compiler format diagnostics defer invalid YAML indentation tabs to existing YAML diagnostics', () => {
    assert.deepEqual(issues('ТипФайла: "Процесс"\nДанныеПроцесса:\n\tИмя: "Flow"\n'), []);
});
