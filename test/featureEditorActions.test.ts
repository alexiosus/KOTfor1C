import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFeatureEditorActions, getFeatureEditorSteps, planFeatureEditorEdit } from '../src/featureEditorActions';
import { collectGherkinSyntaxErrors } from '../src/gherkinSyntaxValidator.js';

const source = (text: string, version = 3) => ({ text, version, uri: 'file:///tests/order.feature', language: 'en' as const });
const apply = (text: string, edit: { start: number; end: number; snippet: string }) =>
    text.slice(0, edit.start) + edit.snippet + text.slice(edit.end);

test('offers feature sections and scenario actions without duplicating existing sections', () => {
    const actions = buildFeatureEditorActions(source('Feature: Order\n\nScenario: Ready\n    Given ready\n'));
    assert.deepEqual(actions.filter(a => a.line === 0).map(a => a.kind), ['description', 'background', 'variables', 'tags', 'tree']);
    assert.deepEqual(actions.filter(a => a.line === 2).map(a => a.kind), ['tags', 'outline']);
    const existing = buildFeatureEditorActions(source('@tree\nFeature: Order\nAs a buyer\n\nVariables:\n    Amount = "1"\n\nBackground:\n    Given ready\nScenario Outline: Ready\n    Then value <amount>\nExamples:\n    | amount |\n    | 1 |\n'));
    assert.deepEqual(existing.filter(a => a.line === 1).map(a => a.kind), ['tags']);
    assert.ok(existing.some(a => a.kind === 'variable' && a.line === 4));
    assert.ok(existing.some(a => a.kind === 'examples' && a.line === 9));
});

test('inserts sections before scenario tags, preserving BOM, CRLF and a second scenario', () => {
    const text = '\uFEFF#language: ru\r\nФункционал: Заказ\r\n\r\n@Smoke\r\nСценарий: Первый\r\n\tДано готово\r\n\r\n@Other\r\nСценарий: Второй\r\n';
    const input = { ...source(text), language: 'ru' as const };
    const target = buildFeatureEditorActions(input).find(a => a.kind === 'variables')!.target;
    const edit = planFeatureEditorEdit(input, target);
    assert.ok(edit);
    assert.match(apply(text, edit), /Переменные:\r\n\t\$\{1:Имя\} = "\$\{2:Значение\}"\r\n\r\n@Smoke\r\nСценарий: Первый/u);
    assert.equal(apply(text, edit).slice(-35), text.slice(-35));
    assert.ok(apply(text, edit).startsWith('\uFEFF#language: ru\r\n'));
});

test('converts the selected scenario only and derives examples from its parameters', () => {
    const text = 'Feature: Order\nScenario: One\n    Then amount <amount> and <tax>\n\n@Other\nScenario: Two\n    Given untouched\n';
    const input = source(text);
    const action = buildFeatureEditorActions(input).find(a => a.kind === 'outline')!;
    const edit = planFeatureEditorEdit(input, action.target)!;
    const result = apply(text, edit);
    assert.match(result, /Scenario Outline: One\n    Then amount <amount> and <tax>/u);
    assert.match(result, /Examples:\n        \| amount \| tax \|\n        \| \$\{1:Value\} \| \$\{2:Value\} \|\n\n@Other\nScenario: Two/u);
    assert.match(result, /Given untouched\n$/u);
});

test('adds arbitrary punctuation tags to their own declaration without duplicates or injection', () => {
    const text = '@team.sales @issue=123\nFeature: Order\n\n@Smoke\nScenario: Ready\n    Given ready\n';
    const input = source(text);
    const targets = buildFeatureEditorActions(input).filter(a => a.kind === 'tags');
    const edit = planFeatureEditorEdit(input, targets[0].target, { tags: '@team.sales @issue=123 @priority:high' })!;
    assert.equal(apply(text, edit), '@team.sales @issue=123\n@priority:high\nFeature: Order\n\n@Smoke\nScenario: Ready\n    Given ready\n');
    assert.equal(planFeatureEditorEdit(input, targets[0].target, { tags: '@team.sales' }), undefined);
    assert.throws(() => planFeatureEditorEdit(input, targets[0].target, { tags: 'bad\n@injected' }), /tag/iu);
    assert.throws(() => planFeatureEditorEdit(input, { ...targets[1].target, version: 2 }, { tags: '@New' }), /changed/iu);
});

test('step annotations keep group indentation and never attach to a table or docstring', () => {
    const text = 'Feature: Order\nScenario: Ready\n    * Group\n        Given ready\n        """\n        Scenario: fake\n        """\n        | x |\n';
    const input = source(text);
    const target = { uri: input.uri, version: input.version, line: 1, kind: 'stepTag' as const };
    const edit = planFeatureEditorEdit(input, target, { stepLine: 3, stepTag: 'screenshot' })!;
    assert.match(apply(text, edit), /\* Group\n        @screenshot\n        Given ready/u);
    assert.equal(buildFeatureEditorActions(input).filter(a => a.kind === 'outline').length, 1);
    for (const stepLine of [4, 5, 7]) {
        assert.throws(() => planFeatureEditorEdit(input, target, { stepLine, stepTag: 'recordvideo' }), /step/iu);
    }
});

test('adds all Vanessa variable forms within Variables, before Background', () => {
    const text = 'Feature: Order\nVariables:\n    Existing = "x"\n\nBackground:\n    Given ready\nScenario: One\n';
    const input = source(text);
    const target = buildFeatureEditorActions(input).find(a => a.kind === 'variable')!.target;
    const expected = {
        simple: ' = "', computed: ' = "{', server: ' = "{!', multiline: '    """', table: "| 'Имя' | 'Представление' | 'Тип' |", import: 'Import "'
    };
    for (const [variableKind, fragment] of Object.entries(expected)) {
        const edit = planFeatureEditorEdit(input, target, { variableKind: variableKind as keyof typeof expected })!;
        assert.ok(edit.snippet.includes(fragment), variableKind);
        const result = apply(text, edit);
        assert.ok(result.indexOf(fragment) < result.indexOf('Background:'));
    }
});

test('validates Vanessa Variables and step annotations without hiding ordinary Gherkin errors', () => {
    const text = '#language: ru\nФункционал: Заказ\nПеременные:\n    Импорт "vars.feature"\n    Текст =\n    """\n    Сценарий: текст переменной\n    """\n    | \'Имя\' | \'Представление\' | \'Тип\' |\n    | \'A\' | \'B\' | \'C\' |\nСценарий: Первый\n    @screenshot\n    Дано готово\n    @recordvideo\n    И готово\n    @StopRecordVideo\n    И готово\n';
    assert.deepEqual(collectGherkinSyntaxErrors(text), []);
    assert.ok(collectGherkinSyntaxErrors('Feature: Order\nScenario: Ready\n    Given ready\n    | x | y |\n    | 1 |\n').length > 0);
});

test('recognizes starred steps and derives outline columns inside multiline arguments', () => {
    const text = 'Feature: Order\nScenario: One\n    * Group\n        * Given payload\n        """\n        <value>\n        """\n';
    const input = source(text);
    assert.deepEqual(getFeatureEditorSteps(input, 1), [{ line: 3, text: '* Given payload' }]);
    const target = buildFeatureEditorActions(input).find(a => a.kind === 'outline')!.target;
    assert.match(planFeatureEditorEdit(input, target)!.snippet, /\| value \|/u);
});

test('comments about tags do not suppress real tag actions', () => {
    const text = '@Smoke\n# @tree and @team.sales are documented here\nFeature: Order\nScenario: One\n';
    const input = source(text);
    assert.ok(buildFeatureEditorActions(input).some(a => a.kind === 'tree'));
    const target = buildFeatureEditorActions(input).find(a => a.kind === 'tags')!.target;
    const edit = planFeatureEditorEdit(input, target, { tags: '@team.sales' })!;
    assert.match(apply(text, edit), /\n@team.sales\nFeature: Order/u);
});

test('new sections retain a two-space indentation style', () => {
    const input = source('Feature: Order\nVariables:\n  Payload =\n  """\n\ttab in payload\n  """\nScenario: One\n  Given ready\n');
    const target = buildFeatureEditorActions(input).find(a => a.kind === 'background')!.target;
    assert.match(planFeatureEditorEdit(input, target)!.snippet, /Background:\n  Given/u);
});

test('validates an English Functionality declaration on the BOM line', () => {
    assert.deepEqual(collectGherkinSyntaxErrors('\uFEFFFunctionality: Order\nScenario: Ready\n    Given ready\n'), []);
});
