import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyScenarioCategoryToTemplate,
    buildScenarioCategoryAction,
    collectNestedScenarioCategories,
    SCENARIO_CATEGORY_COMMAND
} from '../src/scenarioCategory';

test('collects only nested categories case-insensitively and preserves authored spelling', () => {
    assert.deepEqual(collectNestedScenarioCategories([
        { kind: 'nestedScenario', category: ' Продажи.Заказы ' },
        { kind: 'nestedScenario', category: 'продажи.заказы' },
        { kind: 'nestedScenario', category: 'CRM' },
        { kind: 'exportScenario', category: 'Exports' },
        { kind: 'nestedScenario' }
    ]), ['CRM', 'Продажи.Заказы']);
});

test('builds Add or Change category action on nested scenario metadata', () => {
    const add = buildScenarioCategoryAction([
        'ДанныеСценария:',
        '    Имя: Nested',
        'KOTМетаданные:',
        '    Описание: test',
        ''
    ].join('\n'), 'file:///a.yaml', 4);
    const change = buildScenarioCategoryAction([
        'ДанныеСценария:',
        '    Имя: Nested',
        'KOTМетаданные:',
        '    Категория: Existing',
        ''
    ].join('\n'), 'file:///a.yaml', 5, message => `T:${message}`);

    assert.deepEqual(add && {
        title: add.title,
        command: add.command,
        line: add.range.start.line,
        uri: add.target.documentUri,
        version: add.target.documentVersion
    }, {
        title: '+ Category',
        command: SCENARIO_CATEGORY_COMMAND,
        line: 2,
        uri: 'file:///a.yaml',
        version: 4
    });
    assert.equal(change?.title, 'T:Change category');
});

test('does not offer nested category action for main or structurally unsafe scenarios', () => {
    const main = [
        'ДанныеСценария:',
        '    Имя: Main',
        'KOTМетаданные:',
        '    PhaseSwitcher:',
        '        Tab: Regression',
        ''
    ].join('\n');

    assert.equal(buildScenarioCategoryAction(main, 'file:///main.yaml', 1), null);
    assert.equal(buildScenarioCategoryAction(
        'ДанныеСценария:\n    Имя: Nested\nKOTМетаданные: []\n',
        'file:///nested.yaml',
        1
    ), null);
    assert.equal(buildScenarioCategoryAction(
        'ДанныеСценария:\n    Имя: Nested\n',
        'file:///nested.yaml',
        1
    ), null);
});

test('applies optional category to a nested scenario template exactly once', () => {
    const template = [
        '\uFEFFТипФайла: "Сценарий"',
        'ДанныеСценария:',
        '    Имя: Nested',
        'KOTМетаданные:',
        '    Описание: |',
        '        Text',
        ''
    ].join('\r\n');

    const rendered = applyScenarioCategoryToTemplate(template, 'Продажи.Заказы');
    const unchanged = applyScenarioCategoryToTemplate(template, undefined);

    assert.equal(rendered.changed, true);
    assert.match(rendered.content, /KOTМетаданные:\r\n(?:[\s\S]*?)    Категория: "Продажи\.Заказы"\r\n/);
    assert.equal(rendered.content.match(/Категория:/g)?.length, 1);
    assert.deepEqual(unchanged, { changed: false, content: template });
});
